"""End-to-end shim behaviour against a real (fake) stdio MCP server, Windows only."""
import json
import sys
import time
import unittest

from helpers import Client, Sandbox  # noqa: E402
from mcp_relay import winproc  # noqa: E402


def alive(pid):
    return winproc.creation_time(pid) is not None


@unittest.skipUnless(sys.platform == "win32", "Windows job objects")
class ShimTests(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.clients = []

    def tearDown(self):
        for c in self.clients:
            c.close()
        time.sleep(0.3)
        self.sb.close()

    def client(self):
        c = Client(self.sb)
        self.clients.append(c)
        return c

    def test_lists_do_not_start_the_server(self):
        c = self.client()
        r = c.init()
        self.assertEqual(r["result"]["serverInfo"]["name"], "fake")
        self.assertEqual(r["result"]["protocolVersion"], "2025-06-18")  # min(client, server)
        self.assertTrue(r["result"]["capabilities"]["tools"]["listChanged"])
        tools = c.result(c.request("tools/list"))["result"]["tools"]
        self.assertIn("echo", [t["name"] for t in tools])
        self.assertEqual([t for t in tools if t["name"] == "echo"][0]["annotations"], {"readOnlyHint": True})
        self.assertEqual(c.result(c.request("ping"))["result"], {})
        disc = c.result(c.request("server/discover", {}))
        self.assertEqual(disc["error"]["code"], -32601)
        time.sleep(1.0)
        self.assertEqual(self.sb.starts(), [])

    def test_first_call_starts_once_and_reuses(self):
        c = self.client()
        c.init()
        a = c.request("tools/call", {"name": "counter", "arguments": {}})
        b = c.request("tools/call", {"name": "counter", "arguments": {}})  # concurrent with the start
        ra, rb = c.result(a), c.result(b)
        self.assertEqual(sorted([ra["result"]["content"][0]["text"], rb["result"]["content"][0]["text"]]), ["1", "2"])
        r3 = c.result(c.request("tools/call", {"name": "counter", "arguments": {}}))
        self.assertEqual(r3["result"]["content"][0]["text"], "3")  # same server, state kept
        self.assertEqual(len(self.sb.starts()), 1)

    def test_two_sessions_are_separate(self):
        a, b = self.client(), self.client()
        a.init(), b.init()
        self.assertEqual(a.result(a.request("tools/call", {"name": "counter", "arguments": {}}))["result"]["content"][0]["text"], "1")
        self.assertEqual(len(self.sb.starts()), 1)
        self.assertEqual(b.result(b.request("tools/call", {"name": "counter", "arguments": {}}))["result"]["content"][0]["text"], "1")
        pids = self.sb.starts()
        self.assertEqual(len(pids), 2)
        a.close()
        time.sleep(1.0)
        self.assertFalse(alive(pids[0]))
        self.assertTrue(alive(pids[1]))
        self.assertEqual(b.result(b.request("tools/call", {"name": "counter", "arguments": {}}))["result"]["content"][0]["text"], "2")

    def test_image_and_progress_pass_through(self):
        c = self.client()
        c.init()
        img = c.result(c.request("tools/call", {"name": "image", "arguments": {}}))
        self.assertEqual(img["result"]["content"][0]["type"], "image")
        import base64
        self.assertEqual(base64.b64decode(img["result"]["content"][0]["data"]), bytes(range(256)) * 64)
        rid = c.request("tools/call", {"name": "slow", "arguments": {"sec": 0.6}, "_meta": {"progressToken": "tok"}})
        prog = c.wait(lambda m: m.get("method") == "notifications/progress")
        self.assertEqual(prog["params"]["progressToken"], "tok")
        self.assertEqual(c.result(rid)["result"]["content"][0]["text"], "slept")

    def test_elicitation_round_trip(self):
        c = self.client()
        c.init()
        rid = c.request("tools/call", {"name": "ask", "arguments": {}})
        q = c.wait(lambda m: m.get("method") == "elicitation/create")
        c.send({"jsonrpc": "2.0", "id": q["id"], "result": {"action": "accept", "content": {"n": "iris"}}})
        self.assertEqual(c.result(rid)["result"]["content"][0]["text"], "hello iris")

    def test_crash_mid_call_is_not_retried(self):
        c = self.client()
        c.init()
        c.result(c.request("tools/call", {"name": "counter", "arguments": {}}))
        r = c.result(c.request("tools/call", {"name": "crash", "arguments": {}}))
        self.assertEqual(r["error"]["data"]["stage"], "running")
        self.assertEqual(r["error"]["data"]["executed"], "unknown")
        self.assertIn("자동으로 다시 실행하지 않았습니다", r["error"]["message"])
        self.assertEqual(len(self.sb.starts()), 1)  # nothing re-sent, nothing restarted yet
        r2 = c.result(c.request("tools/call", {"name": "counter", "arguments": {}}))
        self.assertEqual(r2["result"]["content"][0]["text"], "1")  # fresh server, state reset
        self.assertEqual(len(self.sb.starts()), 2)

    def test_hard_kill_of_shim_ends_whole_tree(self):
        c = self.client()
        c.init()
        child = int(c.result(c.request("tools/call", {"name": "child", "arguments": {}}))["result"]["content"][0]["text"])
        server = self.sb.starts()[0]
        self.assertTrue(alive(child) and alive(server))
        winproc.terminate_pid(c.p.pid)  # what a crashed / force-killed client does to us
        time.sleep(1.5)
        self.assertFalse(alive(server))
        self.assertFalse(alive(child))

    def test_stdin_close_ends_server_and_ledger(self):
        c = self.client()
        c.init()
        c.result(c.request("tools/call", {"name": "echo", "arguments": {"text": "x"}}))
        self.assertEqual(len(self.sb.state.ledger()), 1)
        server = self.sb.starts()[0]
        c.close()
        time.sleep(0.5)
        self.assertFalse(alive(server))
        self.assertEqual(self.sb.state.ledger(), [])


@unittest.skipUnless(sys.platform == "win32", "Windows job objects")
class ShimEdgeTests(unittest.TestCase):
    def test_spawn_failure_is_reported_not_executed(self):
        sb = Sandbox(command=r"C:\nope\missing-server.exe", args=[], catalog=False)
        try:
            sb.state.put_catalog("test.global.fake", {"initialize": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                                                                     "serverInfo": {"name": "x"}}, "tools": []})
            c = Client(sb)
            c.init()
            r = c.result(c.request("tools/call", {"name": "echo", "arguments": {}}))
            self.assertEqual(r["error"]["data"]["stage"], "spawn")
            self.assertIs(r["error"]["data"]["executed"], False)
            self.assertIn("missing-server.exe", r["error"]["message"])
            c.close()
        finally:
            sb.close()

    def test_no_catalog_starts_eagerly_and_writes_catalog(self):
        sb = Sandbox(catalog=False)
        try:
            c = Client(sb)
            r = c.init()
            self.assertEqual(r["result"]["serverInfo"]["name"], "fake")
            self.assertEqual(len(sb.starts()), 1)
            tools = c.result(c.request("tools/list"))["result"]["tools"]
            self.assertTrue(tools)
            time.sleep(0.5)
            self.assertIsNotNone(sb.state.get_catalog("test.global.fake"))
            c.close()
        finally:
            sb.close()

    def test_drift_sends_list_changed_after_start(self):
        sb = Sandbox()  # catalog without "extra"
        try:
            sb.env["FAKE_TOOLS"] = "extra"
            c = Client(sb)
            c.init()
            c.result(c.request("tools/list"))
            c.result(c.request("tools/call", {"name": "echo", "arguments": {"text": "x"}}))
            c.wait(lambda m: m.get("method") == "notifications/tools/list_changed")
            cat = sb.state.get_catalog("test.global.fake")
            self.assertIn("extra", [t["name"] for t in cat["tools"]])
            c.close()
        finally:
            sb.close()


if __name__ == "__main__":
    unittest.main()
