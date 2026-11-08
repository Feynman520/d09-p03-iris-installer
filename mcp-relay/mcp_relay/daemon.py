"""The shared relay ("공용 중계기"). Not on the tool-call path: shims work without it.

Jobs: sync at start and every 10 minutes (if settings.autoSync), survey missing/stale
catalogs one by one, sweep the ledger every 30 s (orphaned real servers whose shim is
gone -- verified by PID + creation time, never by name), status on 127.0.0.1:3461.
Started by the IRIS launcher, so it belongs to no session's process tree.
"""
from __future__ import annotations

import json
import os
import secrets
import socket
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import VERSION, configs, status, store, survey, sync, winproc

DEFAULT_PORT = 3461
SWEEP_SEC = 30
SYNC_SEC = 600


def _inside(child: Path, parent: Path) -> bool:
    try:
        Path(child).resolve().relative_to(Path(parent).resolve())
        return True
    except ValueError:
        return False


def homes(root: Path) -> tuple[Path | None, Path | None]:
    """Client settings that belong to THIS soul root. An env var pointing elsewhere is
    ignored: a relay must never edit another installation's settings (2026-10-28 test
    incident -- a temp-state daemon followed the live CLAUDE_CONFIG_DIR and converted
    the real settings; restored byte-for-byte, rule added)."""
    out = []
    for env_name, sub in (("CLAUDE_CONFIG_DIR", "claude"), ("CODEX_HOME", "codex")):
        own = Path(root) / "_agent" / sub
        env = os.environ.get(env_name)
        if own.is_dir():
            out.append(own)
        elif env and _inside(Path(env), root) and Path(env).is_dir():
            out.append(Path(env))
        else:
            out.append(None)
    return out[0], out[1]


def sweep(st: store.State) -> list[dict]:
    ended = []
    for path, rec in st.ledger():
        if winproc.is_same_alive(int(rec.get("shimPid") or 0), rec.get("shimCreated")):
            continue
        spid, screated = int(rec.get("serverPid") or 0), rec.get("serverCreated")
        killed = []
        if spid and screated and winproc.is_same_alive(spid, screated):
            killed = winproc.terminate_tree(spid, int(screated))
            st.log("sweep-orphan", id=rec.get("id"), serverPid=spid, ended=len(killed))
            ended.append({"id": rec.get("id"), "ended": killed})
        try:
            path.unlink()
        except OSError:
            pass
    return ended


def run_sync(st: store.State, root: Path) -> dict | None:
    claude, codex = homes(root)
    sources = configs.discover(root, claude, codex)
    actions = sync.plan(st, sources)
    if not any(a["do"] in ("convert", "restore", "release", "remove") for a in actions):
        return None
    result = sync.apply(st, actions)
    st.log("auto-sync", converted=len(result["converted"]), restored=len(result["restored"]),
           released=len(result["released"]), removed=len(result["removed"]), failed=len(result["failed"]))
    return result


def run_surveys(st: store.State, root: Path, stop: threading.Event) -> None:
    claude, codex = homes(root)
    sources = configs.discover(root, claude, codex)
    for reg in st.entries():
        if stop.is_set():
            return
        if reg.get("status") != "relayed" or not survey.needs_survey(st, reg) or survey.recently_failed(st, reg["id"]):
            continue
        survey.survey_one(st, reg, sources, root)


class ExclusiveServer(ThreadingHTTPServer):
    """http.server sets SO_REUSEADDR, which on Windows lets a second process bind the
    same port (measured: a second daemon started). One daemon per port, enforced."""
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Daemon:
    def __init__(self, st: store.State, port: int = DEFAULT_PORT) -> None:
        self.st = st
        self.port = port
        self.root = store.root_from_state(st.dir)
        self.stop = threading.Event()
        self.token = secrets.token_hex(16)
        self.started = store.now_iso()

    def worker(self) -> None:
        self.st.prune_logs()
        last_sync = 0.0
        while not self.stop.is_set():
            try:
                sweep(self.st)
                if time.monotonic() - last_sync >= SYNC_SEC or last_sync == 0.0:
                    last_sync = time.monotonic()
                    if self.st.settings().get("autoSync"):
                        run_sync(self.st, self.root)
                    run_surveys(self.st, self.root, self.stop)
            except Exception as exc:  # the daemon must outlive one bad pass
                self.st.log("daemon-error", error=type(exc).__name__, detail=str(exc)[:200])
            self.stop.wait(SWEEP_SEC)

    def serve(self) -> int:
        d = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_a):  # quiet
                pass

            def _host_ok(self) -> bool:
                host = (self.headers.get("Host") or "").lower()
                return host in (f"127.0.0.1:{d.port}", f"localhost:{d.port}")

            def _send(self, code: int, obj) -> None:
                body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if not self._host_ok():
                    return self._send(403, {"ok": False})
                if self.path == "/health":
                    return self._send(200, {"ok": True, "app": "iris-mcp-relay", "version": VERSION, "pid": os.getpid()})
                if self.path == "/status":
                    return self._send(200, status.collect(d.st))
                return self._send(404, {"ok": False})

            def do_POST(self):
                if not self._host_ok() or self.headers.get("X-IRIS-Relay-Token") != d.token:
                    return self._send(403, {"ok": False})
                if self.path == "/shutdown":
                    self._send(200, {"ok": True})
                    d.stop.set()
                    threading.Thread(target=server.shutdown, daemon=True).start()
                    return None
                return self._send(404, {"ok": False})

        try:
            server = ExclusiveServer(("127.0.0.1", self.port), Handler)
        except OSError:
            if health(self.port):
                return 0  # already running: nothing to do
            self.st.log("daemon-port-busy", port=self.port)
            return 2
        me = winproc.self_identity()
        store.atomic_write_json(self.st.dir / "daemon.json", {
            "pid": me[0], "created": me[1], "port": self.port, "token": self.token,
            "version": VERSION, "startedAt": self.started})
        self.st.log("daemon-start", version=VERSION, port=self.port)
        threading.Thread(target=self.worker, name="relay-worker", daemon=True).start()
        try:
            server.serve_forever(poll_interval=0.5)
        finally:
            self.stop.set()
            server.server_close()
            info = store.read_json(self.st.dir / "daemon.json", {}) or {}
            if info.get("pid") == me[0]:
                try:
                    (self.st.dir / "daemon.json").unlink()
                except OSError:
                    pass
            self.st.log("daemon-stop")
        return 0


def health(port: int = DEFAULT_PORT, timeout: float = 1.5) -> dict | None:
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/health")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
            return data if data.get("app") == "iris-mcp-relay" else None
    except (OSError, ValueError):
        return None


def stop_daemon(st: store.State) -> bool:
    info = store.read_json(st.dir / "daemon.json", {}) or {}
    if not info.get("pid") or not winproc.is_same_alive(int(info["pid"]), info.get("created")):
        return False
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{info.get('port', DEFAULT_PORT)}/shutdown", data=b"",
                                     method="POST", headers={"X-IRIS-Relay-Token": str(info.get("token"))})
        urllib.request.urlopen(req, timeout=3).read()
    except OSError:
        return False
    for _ in range(30):
        if not winproc.is_same_alive(int(info["pid"]), info.get("created")):
            return True
        time.sleep(0.2)
    return False


def port_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False
