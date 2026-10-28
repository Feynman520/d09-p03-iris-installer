"""Keep client settings and the registry in step (design 2, 5 and 12-6/7/8).

plan()    reads every source and decides, per entry: convert / release / remove / skip.
apply()   backs up the files it will touch, then edits one entry at a time.
restore() puts the original command/args back (direct connection) and marks released.

One rule decides what a non-shim command under a registered name means (12-6):
  equal to the registry's original  -> a running Claude wrote back its stale copy -> convert again
  anything else                     -> the user changed it on purpose             -> released
"""
from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

from . import configs, store

RELAY_PY = Path(__file__).resolve().parents[1] / "relay.py"
KEEP_BACKUP_RUNS = 5


def python_for_shims(settings: dict) -> str:
    if settings.get("python"):
        return str(settings["python"])
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and (exe.parent / "python.exe").exists():
        exe = exe.parent / "python.exe"
    return str(exe)


def shim_args(entry_id: str, st: store.State, relay_py: Path = RELAY_PY) -> list[str]:
    args = ["-I", str(relay_py), "shim", "--id", entry_id]
    # <root>\_agent\shared\tools\mcp-relay\relay.py -> default state <root>\_agent\shared\mcp-relay
    default = (Path(relay_py).resolve().parents[2] / "mcp-relay").resolve()
    if Path(st.dir).resolve() != default:
        args += ["--state", str(Path(st.dir).resolve())]
    return args


def shim_id(spec: dict) -> str | None:
    args = [str(a) for a in (spec.get("args") or [])]
    if "shim" in args and "--id" in args and any(a.lower().endswith("relay.py") for a in args):
        i = args.index("--id")
        if i + 1 < len(args):
            return args[i + 1]
    return None


def _same_cmd(spec: dict, other: dict | None) -> bool:
    return bool(other) and spec.get("command") == other.get("command") and \
        [str(a) for a in (spec.get("args") or [])] == [str(a) for a in (other.get("args") or [])]


def plan(st: store.State, sources: list) -> list[dict]:
    settings = st.settings()
    exclude = set(settings.get("exclude") or [])
    actions: list[dict] = []
    seen_ids: set[str] = set()
    for src in sources:
        for e in src.entries:
            sid = shim_id(e.spec)
            if sid:
                seen_ids.add(sid)
                reg = st.get_entry(sid)
                if e.name in exclude and reg:
                    actions.append({"do": "restore", "entry": e, "reg": reg, "why": "제외 목록"})
                elif not reg:
                    actions.append({"do": "problem", "entry": e, "why": "안내원 항목인데 등록부가 없음"})
                else:
                    actions.append({"do": "ok", "entry": e, "why": "중계 중"})
                continue
            seen_ids.add(e.id)
            if e.is_remote:
                actions.append({"do": "skip", "entry": e, "why": "원격 연결(직접 유지)"})
                continue
            if e.disabled:
                actions.append({"do": "skip", "entry": e, "why": "꺼진 항목"})
                continue
            if e.name in exclude:
                actions.append({"do": "skip", "entry": e, "why": "제외 목록(직접 유지)"})
                continue
            if not e.spec.get("command"):
                actions.append({"do": "skip", "entry": e, "why": "실행 명령 없음"})
                continue
            if src.in_git_repo:
                actions.append({"do": "skip", "entry": e, "why": "git 저장소 안의 설정(직접 유지)"})
                continue
            reg = st.get_entry(e.id)
            if reg and reg.get("status") == "released":
                actions.append({"do": "skip", "entry": e, "why": "직접 연결로 되돌린 항목"})
                continue
            if reg and reg.get("status") == "relayed" and not _same_cmd(e.spec, reg.get("original")):
                actions.append({"do": "release", "entry": e, "reg": reg, "why": "사용자가 명령을 바꿈"})
                continue
            why = "되돌려진 전환 다시 적용" if reg else "새 로컬 MCP"
            actions.append({"do": "convert", "entry": e, "why": why})
    for reg in st.entries():
        if reg["id"] not in seen_ids and reg.get("status") != "removed":
            actions.append({"do": "remove", "reg": reg, "why": "설정에서 사라짐"})
    return actions


def _backup(st: store.State, paths: list[Path], stamp: str) -> Path | None:
    if not paths:
        return None
    d = st.backups_dir / stamp
    d.mkdir(parents=True, exist_ok=True)
    index = []
    for i, p in enumerate(sorted(set(paths))):
        dst = d / f"{i:02d}-{p.name}"
        shutil.copy2(p, dst)
        index.append({"file": dst.name, "original": str(p)})
    store.atomic_write_json(d / "index.json", index)
    runs = sorted([x for x in st.backups_dir.iterdir() if x.is_dir()], key=lambda x: x.name)
    for old in runs[:-KEEP_BACKUP_RUNS]:
        shutil.rmtree(old, ignore_errors=True)
    return d


def convert(st: store.State, e: configs.Entry, python: str, *, owner: str = "sync") -> dict:
    original = {"command": e.spec.get("command"), "args": list(e.spec.get("args") or [])}
    reg = {
        "id": e.id, "agent": e.agent, "scope": e.scope, "name": e.name,
        "configPath": str(e.source.path), "configKind": e.source.kind, "projectKey": e.project_key,
        "real": dict(original), "original": dict(original),
        "expandVars": e.agent == "claude", "status": "relayed", "owner": owner, "convertedAt": store.now_iso(),
    }
    if e.spec.get("startup_timeout_sec"):
        reg["startTimeoutSec"] = e.spec.get("startup_timeout_sec")
    st.put_entry(reg)
    try:
        configs.set_command(e, python, shim_args(e.id, st), expect=original)
    except (configs.EditError, OSError) as exc:
        st.remove_entry(e.id)
        return {"id": e.id, "ok": False, "detail": str(exc)}
    st.log("convert", id=e.id, file=e.source.path.name)
    return {"id": e.id, "ok": True}


def restore_entry(st: store.State, e: configs.Entry | None, reg: dict, *, why: str) -> dict:
    if e is not None and shim_id(e.spec) == reg["id"]:
        try:
            configs.set_command(e, reg["original"]["command"], reg["original"]["args"],
                                expect={"command": e.spec.get("command"), "args": e.spec.get("args")})
        except (configs.EditError, OSError) as exc:
            return {"id": reg["id"], "ok": False, "detail": str(exc)}
    reg = dict(reg, status="released", releasedAt=store.now_iso(), releasedWhy=why)
    st.put_entry(reg)
    st.log("restore", id=reg["id"], why=why)
    return {"id": reg["id"], "ok": True}


def apply(st: store.State, actions: list[dict], *, python: str | None = None) -> dict:
    python = python or python_for_shims(st.settings())
    st.ensure_settings()
    touched = [a["entry"].source.path for a in actions if a["do"] in ("convert", "restore")]
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = _backup(st, touched, stamp)
    result = {"converted": [], "restored": [], "released": [], "removed": [], "failed": [], "backup": str(backup) if backup else None}
    for a in actions:
        if a["do"] == "convert":
            r = convert(st, a["entry"], python)
            (result["converted"] if r["ok"] else result["failed"]).append(r)
        elif a["do"] == "restore":
            r = restore_entry(st, a["entry"], a["reg"], why=a["why"])
            (result["restored"] if r["ok"] else result["failed"]).append(r)
        elif a["do"] == "release":
            st.put_entry(dict(a["reg"], status="released", releasedAt=store.now_iso(), releasedWhy=a["why"]))
            result["released"].append({"id": a["reg"]["id"]})
        elif a["do"] == "remove":
            st.remove_entry(a["reg"]["id"])
            result["removed"].append({"id": a["reg"]["id"]})
    # A running Claude may write its stale copy of .claude.json back over our edit
    # (design 12-8). Check once; the daemon re-checks later with the same rule.
    if result["converted"]:
        time.sleep(3)
        for r in result["converted"]:
            reg = st.get_entry(r["id"])
            spec = configs.reread(_entry_stub(reg)) if reg else None
            r["verified"] = bool(spec) and shim_id(spec) == r["id"]
    return result


def _entry_stub(reg: dict) -> configs.Entry:
    src = configs.Source(reg["agent"], reg["configKind"], Path(reg["configPath"]))
    return configs.Entry(reg["agent"], reg["scope"], reg["name"], {}, src, project_key=reg.get("projectKey"))


def restore_all(st: store.State, sources: list, *, only_id: str | None = None) -> list[dict]:
    out = []
    regs = [r for r in st.entries() if r.get("status") == "relayed" and (only_id is None or r["id"] == only_id)]
    paths = []
    for reg in regs:
        paths.append(Path(reg["configPath"]))
    if paths:
        _backup(st, [p for p in paths if p.exists()], time.strftime("%Y%m%d-%H%M%S") + "-restore")
    for reg in regs:
        e = None
        for src in sources:
            for cand in src.entries:
                if shim_id(cand.spec) == reg["id"]:
                    e = cand
        out.append(restore_entry(st, e, reg, why="restore"))
    return out
