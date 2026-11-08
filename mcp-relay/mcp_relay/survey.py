"""One-off catalog survey: start a real server once, record what it offers, stop it.

Runs at conversion / install / when the daemon finds a missing or stale catalog --
never at session start. The server gets the env its client would give it, read from
the client's own entry in memory only (design 12-4); nothing of it is written down.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path

from . import VERSION, configs, launch, store, winproc
from .shim import LATEST, LIST_KINDS, CAP_FOR_KIND


class SurveyError(Exception):
    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage


def client_env(entry: configs.Entry | None, *, expand_vars: bool) -> dict:
    env = os.environ.copy()
    if entry is None:
        return env
    spec = entry.spec
    for k, v in (spec.get("env") or {}).items():
        if isinstance(v, str):
            env[k] = launch.expand(v, env) if expand_vars else v
    # codex env_vars: names copied from the parent environment (already in env)
    return env


def client_cwd(entry: configs.Entry | None, soul_root: Path) -> str:
    if entry is not None:
        if entry.spec.get("cwd"):
            return str(entry.spec["cwd"])
        if entry.project_key:
            return entry.project_key
        if entry.source.kind == "claude-project":
            return str(entry.source.path.parent)
        if entry.source.kind == "codex" and entry.scope != "global":
            return str(entry.source.path.parent.parent)
    return str(soul_root)


def run_survey(reg: dict, *, env: dict, cwd: str, timeout: float = 120.0) -> dict:
    argv = launch.build(reg["real"], env, cwd, expand_vars=bool(reg.get("expandVars")))
    proc, job, _in_job = winproc.spawn_in_job(argv, env=env, cwd=cwd, stdin=subprocess.PIPE,
                                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    replies: "queue.Queue[dict]" = queue.Queue()

    def reader():
        for raw in iter(proc.stdout.readline, b""):
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            if isinstance(m, dict) and "id" in m and "method" not in m:
                replies.put(m)
            elif isinstance(m, dict) and m.get("method") and "id" in m:
                # a server request during survey (roots/list, elicitation): answer politely
                answer = {"jsonrpc": "2.0", "id": m["id"]}
                if m["method"] == "roots/list":
                    answer["result"] = {"roots": []}
                elif m["method"] == "ping":
                    answer["result"] = {}
                else:
                    answer["error"] = {"code": -32601, "message": "not available during catalog survey"}
                send(answer)
        replies.put({"__eof__": True})

    lock = threading.Lock()

    def send(obj):
        with lock:
            try:
                proc.stdin.write(json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n")
                proc.stdin.flush()
            except OSError:
                pass

    threading.Thread(target=reader, daemon=True).start()
    deadline = time.monotonic() + timeout
    seq = [0]

    def call(method, params=None):
        seq[0] += 1
        rid = f"survey-{seq[0]}"
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        send(msg)
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise SurveyError("initialize" if method == "initialize" else "list", f"{int(timeout)}초 안에 응답이 없었습니다")
            try:
                m = replies.get(timeout=left)
            except queue.Empty:
                continue
            if m.get("__eof__"):
                raise SurveyError("initialize" if method == "initialize" else "list", f"서버가 종료되었습니다(종료 코드 {proc.poll()})")
            if m.get("id") == rid:
                return m

    try:
        init = call("initialize", {"protocolVersion": LATEST, "capabilities": {"roots": {"listChanged": True}},
                                   "clientInfo": {"name": "iris-mcp-relay-survey", "version": VERSION}})
        if "error" in init:
            raise SurveyError("initialize", str(init["error"].get("message", "초기화 오류"))[:200])
        result = init.get("result") or {}
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        catalog = {"initialize": result, "source": "survey"}
        caps = result.get("capabilities") or {}
        for method, kind in LIST_KINDS.items():
            if not isinstance(caps.get(CAP_FOR_KIND[kind]), dict):
                continue
            items, cursor = [], None
            for _page in range(50):
                m = call(method, {"cursor": cursor} if cursor else None)
                if "error" in m:
                    break
                res = m.get("result") or {}
                items.extend(res.get(kind) or [])
                cursor = res.get("nextCursor")
                if not cursor:
                    break
            catalog[kind] = items
        return catalog
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        job.terminate()
        job.close()


def survey_one(st: store.State, reg: dict, sources: list, soul_root: Path, *, timeout: float = 120.0) -> dict:
    """Survey one registry entry and store its catalog. Returns a status dict."""
    entry_id = reg["id"]
    st.locks_dir.mkdir(parents=True, exist_ok=True)
    lock_path = st.locks_dir / ("survey-" + store.file_for_id(entry_id))
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            if time.time() - lock_path.stat().st_mtime < 600:
                return {"id": entry_id, "ok": False, "stage": "lock", "detail": "다른 조사가 진행 중"}
            lock_path.unlink()
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except OSError:
            return {"id": entry_id, "ok": False, "stage": "lock", "detail": "잠금 파일"}
    os.close(fd)
    t0 = time.monotonic()
    try:
        entry = configs.find_entry(sources, entry_id)
        env = client_env(entry, expand_vars=bool(reg.get("expandVars")))
        cwd = client_cwd(entry, soul_root)
        if not os.path.isdir(cwd):
            cwd = str(soul_root)
        cat = run_survey(reg, env=env, cwd=cwd, timeout=timeout)
        cat["fingerprint"] = store.fingerprint(reg["real"].get("command", ""), reg["real"].get("args", []))
        st.put_catalog(entry_id, cat)
        try:
            _fail_marker(st, entry_id).unlink()
        except OSError:
            pass
        ms = int((time.monotonic() - t0) * 1000)
        st.log("survey-ok", id=entry_id, ms=ms, tools=len(cat.get("tools") or []))
        return {"id": entry_id, "ok": True, "ms": ms, "tools": len(cat.get("tools") or [])}
    except (SurveyError, launch.LaunchError) as exc:
        st.log("survey-fail", id=entry_id, stage=exc.stage, detail=store.redactor()(str(exc))[:300])
        _mark_failed(st, entry_id)
        return {"id": entry_id, "ok": False, "stage": exc.stage, "detail": str(exc)}
    except OSError as exc:
        st.log("survey-fail", id=entry_id, stage="spawn", detail=str(exc.strerror or exc)[:200])
        _mark_failed(st, entry_id)
        return {"id": entry_id, "ok": False, "stage": "spawn", "detail": str(exc.strerror or exc)}
    finally:
        try:
            lock_path.unlink()
        except OSError:
            pass


FAIL_BACKOFF_SEC = 6 * 3600


def _fail_marker(st: store.State, entry_id: str) -> Path:
    return st.catalog_dir / (store.file_for_id(entry_id)[:-5] + ".survey-failed")


def _mark_failed(st: store.State, entry_id: str) -> None:
    try:
        st.catalog_dir.mkdir(parents=True, exist_ok=True)
        _fail_marker(st, entry_id).write_text(store.now_iso(), encoding="utf-8")
    except OSError:
        pass


def recently_failed(st: store.State, entry_id: str) -> bool:
    """A server that cannot be surveyed outside its own session (it needs env only that
    session injects) is not retried by the daemon every pass -- once per 6 hours."""
    try:
        return time.time() - _fail_marker(st, entry_id).stat().st_mtime < FAIL_BACKOFF_SEC
    except OSError:
        return False


def needs_survey(st: store.State, reg: dict) -> str | None:
    cat = st.get_catalog(reg["id"])
    if cat is None:
        return "missing"
    if cat.get("fingerprint") != store.fingerprint(reg["real"].get("command", ""), reg["real"].get("args", [])):
        return "stale"
    return None
