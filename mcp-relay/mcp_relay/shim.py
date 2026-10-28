"""The per-session, per-server stdio shim ("안내원").

A client (Claude Code / Codex) starts one shim per configured MCP server instead of the
server itself. Until real work arrives the shim answers from the catalog; on the first
real request it starts the real server inside a kill-on-close Job Object, replays the
client's own initialize, then passes every line through byte for byte until the client
closes stdin. Design: P03 docs/설계-MCP중계기.md (sections 1, 3, 4, 12).
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import threading
import time
import uuid

from . import VERSION, launch, store, winproc

KNOWN_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
LATEST = KNOWN_VERSIONS[-1]
LIST_KINDS = {
    "tools/list": "tools",
    "prompts/list": "prompts",
    "resources/list": "resources",
    "resources/templates/list": "resourceTemplates",
}
CAP_FOR_KIND = {"tools": "tools", "prompts": "prompts", "resources": "resources", "resourceTemplates": "resources"}
CHANGED_NOTE = {"tools": "notifications/tools/list_changed", "prompts": "notifications/prompts/list_changed",
                "resources": "notifications/resources/list_changed"}
RETRY_AFTER_SEC = 5.0
STAGE_KO = {"spawn": "프로그램 실행", "initialize": "초기화 응답", "running": "작업 중"}


def idkey(value) -> str:
    return json.dumps(value, sort_keys=True)


def negotiate(requested, server) -> str:
    if requested in KNOWN_VERSIONS and server in KNOWN_VERSIONS:
        return min(requested, server)
    if server:
        return server
    return requested if requested in KNOWN_VERSIONS else LATEST


class Shim:
    def __init__(self, st: store.State, entry: dict, *, inp=None, out=None, err=None) -> None:
        self.st = st
        self.entry = entry
        self.id = entry["id"]
        self.name = entry.get("name") or self.id
        self.inp = inp or sys.stdin.buffer
        self.out = out or sys.stdout.buffer
        self.err = err or sys.stderr.buffer
        settings = st.settings()
        self.start_timeout = float(entry.get("startTimeoutSec") or settings.get("startTimeoutSec") or 120)
        self.catalog = st.get_catalog(self.id)
        self.fp = store.fingerprint(entry["real"].get("command", ""), entry["real"].get("args", []))
        if self.catalog and self.catalog.get("fingerprint") != self.fp:
            st.log("catalog-stale", id=self.id)  # still served; refreshed after a live start (12-1)

        self.lock = threading.RLock()
        self.out_lock = threading.Lock()
        self.phase = "cold"            # cold | starting | ready | failed | crashed
        self.queue: list[tuple[bytes, object]] = []
        self.pending: dict[str, str] = {}      # client request id -> method, forwarded to server
        self.internal: dict[str, object] = {}  # our own request id -> callback
        self.answered: set[str] = set()        # list kinds answered from the catalog
        self.client_init: dict | None = None
        self.init_result: dict | None = None
        self.eager_init_id = None
        self.negotiated = None
        self.log_level = None
        self.fail_at = 0.0
        self.fail_info = ("", "")
        self.crash_notice = False
        self.closing = False
        self.proc = None
        self.job = None
        self.started_at = 0.0
        self.stderr_tail: list[str] = []
        self._seq = 0
        self._prefix = f"iris-relay-{uuid.uuid4().hex[:8]}-"
        self.me = winproc.self_identity()

    # ------------------------------------------------------------------ io --
    def write_client(self, raw: bytes) -> None:
        with self.out_lock:
            try:
                self.out.write(raw + b"\n")
                self.out.flush()
            except (OSError, ValueError):
                pass

    def send_client(self, obj) -> None:
        self.write_client(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    def reply(self, req_id, result) -> None:
        self.send_client({"jsonrpc": "2.0", "id": req_id, "result": result})

    def reply_error(self, req_id, code: int, message: str, data=None) -> None:
        err = {"code": code, "message": message}
        if data is not None:
            err["data"] = data
        self.send_client({"jsonrpc": "2.0", "id": req_id, "error": err})

    def relay_error(self, req_id, stage: str, detail: str, *, executed) -> None:
        if stage == "running":
            msg = (f"[IRIS MCP 중계기] '{self.name}' MCP가 작업 도중 종료되었습니다({detail}). "
                   "이 요청의 결과는 알 수 없으며 자동으로 다시 실행하지 않았습니다. "
                   "서버 상태(열린 문서 등)는 초기화되었습니다. 결과를 확인한 뒤 필요하면 다시 요청하세요 — 다음 요청 때 새로 시작합니다.")
        elif stage == "reset":
            msg = (f"[IRIS MCP 중계기] '{self.name}' MCP가 앞서 종료되어 상태(열린 문서 등)가 초기화되었습니다. "
                   "이 요청은 실행되지 않았습니다. 같은 요청을 다시 보내면 새로 시작합니다.")
        else:
            msg = (f"[IRIS MCP 중계기] '{self.name}' MCP를 시작하지 못했습니다(단계: {STAGE_KO.get(stage, stage)}). "
                   f"원인: {detail}. 이 요청은 실행되지 않았습니다. 잠시 뒤 다시 요청하면 다시 시작해 봅니다. "
                   f"계속 실패하면 'relay.py status'로 원인을 확인하거나 'relay.py restore --id {self.id}'로 직접 연결로 되돌리세요.")
        data = {"relay": True, "server": self.name, "id": self.id, "stage": stage,
                "recoverable": True, "executed": executed}
        self.reply_error(req_id, -32001 if stage in ("spawn", "initialize") else -32002, msg, data)

    def write_server(self, raw: bytes) -> bool:
        proc = self.proc
        if not proc or not proc.stdin:
            return False
        try:
            proc.stdin.write(raw + b"\n")
            proc.stdin.flush()
            return True
        except (OSError, ValueError):
            return False

    def send_internal(self, method: str, params, callback) -> None:
        self._seq += 1
        rid = f"{self._prefix}{self._seq}"
        self.internal[idkey(rid)] = callback
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        self.write_server(json.dumps(msg, ensure_ascii=False).encode("utf-8"))

    # --------------------------------------------------------- client side --
    def run(self) -> int:
        self.st.log("shim-start", id=self.id, version=VERSION, catalog=bool(self.catalog))
        while True:
            raw = self.inp.readline()
            if not raw:
                break
            raw = raw.rstrip(b"\r\n")
            if not raw.strip():
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                with self.lock:
                    if self.phase == "ready":
                        self.write_server(raw)
                continue
            try:
                self.on_client(raw, msg)
            except Exception as exc:  # never let one odd message kill the session's server
                self.st.log("shim-error", id=self.id, where="client", error=type(exc).__name__)
        self.shutdown()
        return 0

    def on_client(self, raw: bytes, msg) -> None:
        with self.lock:
            if isinstance(msg, list):  # JSON-RPC batch (2025-03-26 clients)
                if self.phase == "ready":
                    self.write_server(raw)
                else:
                    self.queue.append((raw, msg))
                    self.ensure_started()
                return
            if not isinstance(msg, dict):
                return
            method = msg.get("method")
            has_id = "id" in msg
            if method is None:  # a client reply to a server request
                if self.phase == "ready":
                    self.write_server(raw)
                return
            if self.phase == "ready":
                if method == "initialize" and has_id and self.init_result:
                    self.reply(msg["id"], self.init_result)
                    return
                if has_id:
                    self.pending[idkey(msg["id"])] = method
                if not self.write_server(raw) and has_id:
                    self.pending.pop(idkey(msg["id"]), None)
                    self.relay_error(msg["id"], "running", "서버 입력이 닫힘", executed=False)
                return
            # ---- not running (yet) ----
            if method == "initialize" and has_id:
                self.on_initialize(msg)
                return
            if method == "notifications/initialized":
                return
            if method == "ping" and has_id:
                self.reply(msg["id"], {})
                return
            if method == "server/discover" and has_id:
                self.reply_error(msg["id"], -32601, "Method not found")
                return
            if method in LIST_KINDS and has_id and self.catalog:
                self.answer_list(msg)
                return
            if method == "logging/setLevel" and has_id:
                self.log_level = (msg.get("params") or {}).get("level")
                self.reply(msg["id"], {})
                return
            if method == "notifications/cancelled":
                target = idkey((msg.get("params") or {}).get("requestId"))
                self.queue = [(r, m) for (r, m) in self.queue
                              if not (isinstance(m, dict) and idkey(m.get("id")) == target)]
                return
            if not has_id:
                return  # other notifications before start: the server asks for what it needs
            if self.phase == "failed" and time.monotonic() - self.fail_at < RETRY_AFTER_SEC:
                stage, detail = self.fail_info
                self.relay_error(msg["id"], stage, detail, executed=False)
                return
            if self.phase == "crashed" and self.crash_notice:
                self.crash_notice = False
                self.phase = "cold"
                self.relay_error(msg["id"], "reset", "", executed=False)
                return
            self.queue.append((raw, msg))
            self.ensure_started()

    def on_initialize(self, msg: dict) -> None:
        self.client_init = copy.deepcopy(msg.get("params") or {})
        requested = self.client_init.get("protocolVersion")
        if self.catalog:
            init = copy.deepcopy(self.catalog["initialize"])
            self.negotiated = negotiate(requested, init.get("protocolVersion"))
            init["protocolVersion"] = self.negotiated
            caps = init.setdefault("capabilities", {})
            for key in ("tools", "prompts", "resources"):
                if isinstance(caps.get(key), dict):
                    caps[key]["listChanged"] = True
            self.reply(msg["id"], init)
        else:
            # No catalog yet: this one session starts the server now, answers with the
            # real result and writes the catalog (self-heal, design 2 / 12-1).
            self.negotiated = requested if requested in KNOWN_VERSIONS else LATEST
            self.eager_init_id = msg["id"]
            self.st.log("eager-start", id=self.id, reason="no-catalog")
            self.ensure_started()

    def answer_list(self, msg: dict) -> None:
        kind = LIST_KINDS[msg["method"]]
        params = msg.get("params") or {}
        items = [] if params.get("cursor") else copy.deepcopy(self.catalog.get(kind) or [])
        self.answered.add(kind)
        self.reply(msg["id"], {kind: items})

    # --------------------------------------------------------- lifecycle ----
    def ensure_started(self) -> None:
        if self.phase in ("cold", "failed", "crashed") and not self.closing:
            self.phase = "starting"
            threading.Thread(target=self._start, name="relay-start", daemon=True).start()

    def _start(self) -> None:
        env = os.environ.copy()
        cwd = os.getcwd()
        try:
            argv = launch.build(self.entry["real"], env, cwd, expand_vars=bool(self.entry.get("expandVars")))
            proc, job, in_job = winproc.spawn_in_job(argv, env=env, cwd=cwd, stdin=subprocess.PIPE,
                                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except launch.LaunchError as exc:
            self._fail(exc.stage, str(exc))
            return
        except OSError as exc:
            self._fail("spawn", f"프로그램을 실행하지 못했습니다({exc.strerror or exc})")
            return
        self.started_at = time.monotonic()
        with self.lock:
            self.proc, self.job = proc, job
        created = winproc.creation_time(proc.pid)
        parent_pid, parent_name = winproc.parent_of(self.me[0])
        self.st.put_ledger(self.me[0], {
            "id": self.id, "name": self.name, "agent": self.entry.get("agent"),
            "sessionId": os.environ.get("CLAUDE_CODE_SESSION_ID"),
            "shimPid": self.me[0], "shimCreated": self.me[1],
            "serverPid": proc.pid, "serverCreated": created, "inJob": in_job,
            "client": {"pid": parent_pid, "name": parent_name}, "startedAt": store.now_iso(),
        })
        self.st.log("server-spawn", id=self.id, what=launch.describe(self.entry["real"]), inJob=in_job,
                    session=os.environ.get("CLAUDE_CODE_SESSION_ID"))
        threading.Thread(target=self._read_stdout, args=(proc,), name="relay-out", daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(proc,), name="relay-err", daemon=True).start()
        params = copy.deepcopy(self.client_init) if self.client_init else {
            "capabilities": {}, "clientInfo": {"name": "iris-mcp-relay", "version": VERSION}}
        params["protocolVersion"] = self.negotiated or LATEST
        with self.lock:
            self.send_internal("initialize", params, self._on_init_result)
        timer = threading.Timer(self.start_timeout, self._start_timeout, args=(proc,))
        timer.daemon = True
        timer.start()

    def _start_timeout(self, proc) -> None:
        with self.lock:
            if self.phase == "starting" and self.proc is proc:
                self._fail("initialize", f"{int(self.start_timeout)}초 안에 초기화 응답이 없었습니다")

    def _on_init_result(self, msg: dict) -> None:
        with self.lock:
            if self.phase != "starting":
                return
            if "error" in msg:
                detail = str((msg.get("error") or {}).get("message", "초기화 오류"))[:200]
                self._fail("initialize", f"서버가 초기화를 거절했습니다: {detail}")
                return
            self.init_result = msg.get("result") or {}
            got = self.init_result.get("protocolVersion")
            if got and got != self.negotiated:
                self.st.log("version-differs", id=self.id, told=self.negotiated, server=got)
            self.write_server(b'{"jsonrpc":"2.0","method":"notifications/initialized"}')
            if self.log_level:
                self.send_internal("logging/setLevel", {"level": self.log_level}, lambda _m: None)
            self.phase = "ready"
            ms = int((time.monotonic() - self.started_at) * 1000)
            self.st.log("server-ready", id=self.id, ms=ms, eager=self.eager_init_id is not None)
            if self.eager_init_id is not None:
                self.reply(self.eager_init_id, self.init_result)
                self.eager_init_id = None
            queued, self.queue = self.queue, []
            for raw, m in queued:
                if isinstance(m, dict) and "id" in m and m.get("method"):
                    self.pending[idkey(m["id"])] = m["method"]
                self.write_server(raw)
            self._refresh_catalog()

    def _refresh_catalog(self) -> None:
        caps = self.init_result.get("capabilities") or {}
        kinds = [k for k in ("tools", "prompts", "resources", "resourceTemplates") if isinstance(caps.get(CAP_FOR_KIND[k]), dict)]
        fresh = {"fingerprint": self.fp, "initialize": self.init_result, "source": "live"}
        remaining = set(kinds)

        def done(kind):
            remaining.discard(kind)
            if not remaining:
                self._save_catalog(fresh, kinds)

        method_for = {v: k for k, v in LIST_KINDS.items()}

        def fetch(kind, cursor=None, acc=None):
            acc = acc if acc is not None else []

            def cb(m):
                res = m.get("result") or {}
                acc.extend(res.get(kind) or [])
                nxt = res.get("nextCursor")
                if nxt and "error" not in m:
                    with self.lock:
                        fetch(kind, nxt, acc)
                else:
                    fresh[kind] = acc
                    done(kind)
            self.send_internal(method_for[kind], {"cursor": cursor} if cursor else None, cb)

        if not kinds:
            self._save_catalog(fresh, kinds)
        for k in kinds:
            fetch(k)

    def _save_catalog(self, fresh: dict, kinds: list[str]) -> None:
        old = self.catalog or {}
        # The version a live start negotiates depends on the client (Codex asks for an
        # older one than Claude). The catalog keeps the highest version the server spoke,
        # so one client's session never lowers what the next client is told.
        fresh["initialize"] = dict(fresh["initialize"])
        old_v = (old.get("initialize") or {}).get("protocolVersion")
        new_v = fresh["initialize"].get("protocolVersion")
        if old_v in KNOWN_VERSIONS and new_v in KNOWN_VERSIONS:
            fresh["initialize"]["protocolVersion"] = max(old_v, new_v)

        def same_init(a, b):
            a = {k: v for k, v in (a or {}).items() if k != "protocolVersion"}
            b = {k: v for k, v in (b or {}).items() if k != "protocolVersion"}
            return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
        changed = [k for k in kinds if json.dumps(old.get(k), sort_keys=True) != json.dumps(fresh.get(k), sort_keys=True)]
        if changed or not same_init(old.get("initialize"), fresh["initialize"]) or old.get("fingerprint") != self.fp:
            try:
                self.st.put_catalog(self.id, fresh)
            except OSError:
                pass
            self.st.log("catalog-refresh", id=self.id, changed=changed)
        for k in changed:
            note = CHANGED_NOTE.get("resources" if k == "resourceTemplates" else k)
            if note and (k in self.answered or ("resources" in self.answered and k == "resourceTemplates")):
                self.send_client({"jsonrpc": "2.0", "method": note})
        self.catalog = fresh

    # ---------------------------------------------------------- server side --
    def _read_stdout(self, proc) -> None:
        stream = proc.stdout
        while True:
            try:
                raw = stream.readline()
            except (OSError, ValueError):
                raw = b""
            if not raw:
                break
            raw = raw.rstrip(b"\r\n")
            if not raw.strip():
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                self.write_client(raw)
                continue
            try:
                self.on_server(raw, msg)
            except Exception as exc:
                self.st.log("shim-error", id=self.id, where="server", error=type(exc).__name__)
        self._on_server_exit(proc)

    def on_server(self, raw: bytes, msg) -> None:
        if isinstance(msg, dict) and "id" in msg and "method" not in msg:
            key = idkey(msg["id"])
            with self.lock:
                cb = self.internal.pop(key, None)
                if cb is None:
                    self.pending.pop(key, None)
            if cb is not None:
                cb(msg)
                return
        self.write_client(raw)

    def _read_stderr(self, proc) -> None:
        stream = proc.stderr
        while True:
            try:
                raw = stream.readline()
            except (OSError, ValueError):
                break
            if not raw:
                break
            try:
                self.err.write(raw)
                self.err.flush()
            except (OSError, ValueError):
                pass
            self.stderr_tail.append(raw.decode("utf-8", "replace").rstrip())
            del self.stderr_tail[:-30]

    def _on_server_exit(self, proc) -> None:
        try:
            code = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            code = None
        with self.lock:
            if self.proc is not proc:
                return
            self.st.drop_ledger(self.me[0])
            if self.job:
                self.job.close()
            self.proc, self.job = None, None
            if self.closing:
                return
            if self.phase == "starting":
                self._fail("initialize", f"서버가 시작 도중 종료되었습니다(종료 코드 {code})", proc_gone=True)
                return
            if self.phase == "ready":
                self.phase = "crashed"
                waiting = list(self.pending.items())
                self.pending.clear()
                self.internal.clear()
                for key, _method in waiting:
                    self.relay_error(json.loads(key), "running", f"종료 코드 {code}", executed="unknown")
                self.crash_notice = not waiting
                self.st.log("server-exit", id=self.id, code=code, inflight=len(waiting),
                            stderr=self._tail_for_log())

    def _tail_for_log(self) -> list[str]:
        redact = store.redactor()
        return [redact(line)[:300] for line in self.stderr_tail[-30:]]

    def _fail(self, stage: str, detail: str, *, proc_gone: bool = False) -> None:
        with self.lock:
            self.phase = "failed"
            self.fail_at = time.monotonic()
            self.fail_info = (stage, detail)
            queued, self.queue = self.queue, []
            for _raw, m in queued:
                if isinstance(m, dict) and "id" in m:
                    self.relay_error(m["id"], stage, detail, executed=False)
                elif isinstance(m, list):
                    for one in m:
                        if isinstance(one, dict) and "id" in one and one.get("method"):
                            self.relay_error(one["id"], stage, detail, executed=False)
            if self.eager_init_id is not None:
                self.relay_error(self.eager_init_id, stage, detail, executed=False)
                self.eager_init_id = None
            self.internal.clear()
            proc, job = self.proc, self.job
            if not proc_gone:
                self.proc, self.job = None, None
            self.st.log("server-fail", id=self.id, stage=stage, detail=store.redactor()(detail)[:300],
                        stderr=self._tail_for_log())
        if proc is not None and not proc_gone:
            try:
                if job:
                    job.terminate()
                    job.close()
                else:
                    proc.kill()
            except OSError:
                pass
            self.st.drop_ledger(self.me[0])

    def shutdown(self) -> None:
        with self.lock:
            self.closing = True
            proc, job = self.proc, self.job
        if proc is not None:
            try:
                proc.stdin.close()  # the polite stdio shutdown: EOF first
            except OSError:
                pass
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
            if job:
                job.terminate()
                job.close()
            self.st.drop_ledger(self.me[0])
        self.st.log("shim-exit", id=self.id, started=proc is not None)


def main(entry_id: str, state_dir=None) -> int:
    st = store.State(state_dir)
    entry = st.get_entry(entry_id)
    if not entry or not isinstance(entry.get("real"), dict):
        # Without a registry entry there is nothing to run. Answer like a server that
        # refuses to start so the client shows a clear reason instead of hanging.
        return _missing_entry(st, entry_id)
    return Shim(st, entry).run()


def _missing_entry(st: store.State, entry_id: str) -> int:
    st.log("registry-missing", id=entry_id)
    msg = (f"[IRIS MCP 중계기] 등록부에 '{entry_id}' 항목이 없어 MCP를 시작할 수 없습니다. "
           "'relay.py status'로 상태를 확인하고, 직접 연결로 되돌리려면 설정 복구본을 쓰세요.")
    inp, out = sys.stdin.buffer, sys.stdout.buffer
    while True:
        raw = inp.readline()
        if not raw:
            return 1
        try:
            m = json.loads(raw)
        except ValueError:
            continue
        if isinstance(m, dict) and "id" in m and m.get("method"):
            out.write(json.dumps({"jsonrpc": "2.0", "id": m["id"], "error": {
                "code": -32001, "message": msg, "data": {"relay": True, "stage": "registry", "executed": False}}},
                ensure_ascii=False).encode("utf-8") + b"\n")
            out.flush()
