import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
RELAY = HERE.parent / "relay.py"
FAKE = HERE / "fake_server.py"
sys.path.insert(0, str(HERE.parent))

from mcp_relay import store  # noqa: E402


class Sandbox:
    """A throw-away state dir with one registry entry pointing at the fake server."""

    def __init__(self, *, command=None, args=None, catalog=True, env_extra=None):
        self.tmp = tempfile.TemporaryDirectory(prefix="relay-t-")
        self.dir = Path(self.tmp.name)
        self.state = store.State(self.dir / "state")
        self.fake_log = self.dir / "fake"
        self.env = dict(os.environ, FAKE_LOG=str(self.fake_log), **(env_extra or {}))
        self.entry = {
            "id": "test.global.fake", "agent": "claude", "scope": "global", "name": "fake",
            "real": {"command": command or sys.executable, "args": args if args is not None else [str(FAKE)]},
            "original": {"command": sys.executable, "args": [str(FAKE)]}, "status": "relayed", "owner": "test",
            "startTimeoutSec": 20,
        }
        self.state.put_entry(self.entry)
        if catalog:
            self.write_catalog()

    def write_catalog(self, env=None):
        """Real survey of the fake server (its start is counted, so tests reset after)."""
        from mcp_relay import survey
        cat = survey.run_survey(self.entry, env=dict(env or self.env, FAKE_LOG=str(self.dir / "survey-log")),
                                cwd=str(self.dir), timeout=20)
        cat["fingerprint"] = store.fingerprint(self.entry["real"]["command"], self.entry["real"]["args"])
        self.state.put_catalog(self.entry["id"], cat)

    def starts(self) -> list[int]:
        p = self.fake_log / "starts.txt"
        return [int(x) for x in p.read_text().split()] if p.exists() else []

    def close(self):
        self.tmp.cleanup()


class Client:
    """Plays the AI client against a shim over pipes."""

    def __init__(self, sb: Sandbox, entry_id="test.global.fake"):
        self.p = subprocess.Popen([sys.executable, "-I", str(RELAY), "--state", str(sb.state.dir), "shim", "--id", entry_id],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  env=sb.env, cwd=str(sb.dir))
        self.q: "queue.Queue[dict]" = queue.Queue()
        self.raw: list[bytes] = []
        self.seq = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in iter(self.p.stdout.readline, b""):
            self.raw.append(line)
            try:
                self.q.put(json.loads(line))
            except ValueError:
                pass

    def send(self, obj):
        self.p.stdin.write(json.dumps(obj).encode() + b"\n")
        self.p.stdin.flush()

    def request(self, method, params=None, *, rid=None):
        self.seq += 1
        rid = rid if rid is not None else self.seq
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)
        return rid

    def wait(self, pred, timeout=20):
        end = time.monotonic() + timeout
        held = []
        try:
            while time.monotonic() < end:
                try:
                    m = self.q.get(timeout=0.1)
                except queue.Empty:
                    continue
                if pred(m):
                    return m
                held.append(m)
            raise AssertionError("timed out waiting for a message")
        finally:
            for m in held:
                self.q.put(m)

    def result(self, rid, timeout=20):
        return self.wait(lambda m: m.get("id") == rid and "method" not in m, timeout)

    def call(self, rid_method="tools/call", **params):
        rid = self.request("tools/call", params)
        return self.result(rid)

    def init(self, version="2025-11-25"):
        rid = self.request("initialize", {"protocolVersion": version, "capabilities": {"elicitation": {}},
                                          "clientInfo": {"name": "test-client", "version": "0"}})
        r = self.result(rid)
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return r

    def close(self, timeout=10):
        try:
            self.p.stdin.close()
        except OSError:
            pass
        try:
            self.p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.p.kill()
