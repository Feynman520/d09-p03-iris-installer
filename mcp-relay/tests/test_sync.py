"""Config discovery, surgical edits, the sync rules, restore and the orphan sweep."""
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import helpers  # noqa: F401 (sys.path)
from mcp_relay import configs, daemon, store, sync, winproc

PY = sys.executable

CODEX_TOML = (
    'model = "x"\r\n\r\n'
    '[mcp_servers.pdf]\r\ncommand = "C:\\\\py\\\\python.exe"\r\nargs = ["C:\\\\srv\\\\pdf.py"]\r\nstartup_timeout_sec = 30\r\n'
    'default_tools_approval_mode = "prompt"\r\n\r\n'
    '[mcp_servers.pdf.env]\r\nPYTHONUTF8 = "1"\r\n\r\n'
    '[mcp_servers.off]\r\ncommand = "x.exe"\r\nargs = []\r\nenabled = false\r\n\r\n'
    '[mcp_servers.remote]\r\nurl = "https://example.invalid/mcp"\r\n\r\n'
    '[projects.\'c:\\\\iris\']\r\ntrust_level = "trusted"\r\n'
)


class Soul:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="relay-s-")
        self.root = Path(self.tmp.name)
        self.claude = self.root / "_agent" / "claude"
        self.codex = self.root / "_agent" / "codex"
        self.claude.mkdir(parents=True)
        self.codex.mkdir(parents=True)
        self.state = store.State(self.root / "_agent" / "shared" / "mcp-relay")
        (self.claude / ".claude.json").write_text(json.dumps({
            "numStartups": 3,
            "mcpServers": {
                "hwp": {"type": "stdio", "command": "C:\\venv\\python.exe", "args": ["C:\\srv\\hwp.py"], "env": {"API_KEY": "s3cret-value"}},
                "self-improve": {"type": "stdio", "command": "node", "args": ["si.js"]},
                "canva": {"type": "http", "url": "https://mcp.canva.com/mcp"},
            },
            "projects": {"C:/W/A": {"mcpServers": {"hwp": {"command": "a.exe", "args": []}}},
                         "C:/W/B": {"mcpServers": {"hwp": {"command": "b.exe", "args": []}}}},
        }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        (self.codex / "config.toml").write_bytes(CODEX_TOML.encode())
        role = self.root / "R01-교사(Teacher)"
        role.mkdir()
        (role / ".mcp.json").write_text(json.dumps({"mcpServers": {"phys": {"command": "uvx", "args": ["phys"]}}}, indent=2), encoding="utf-8")
        repo = self.root / "R07" / "P01"
        (repo / ".git").mkdir(parents=True)
        (repo / ".mcp.json").write_text(json.dumps({"mcpServers": {"supa": {"command": "cmd", "args": ["/c", "npx", "x"]}}}), encoding="utf-8")

    def sources(self):
        return configs.discover(self.root, self.claude, self.codex)

    def close(self):
        self.tmp.cleanup()


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.s = Soul()

    def tearDown(self):
        self.s.close()

    def plan_by_id(self):
        return {(a.get("entry").id if a.get("entry") else a["reg"]["id"]): a for a in sync.plan(self.s.state, self.s.sources())}

    def test_plan_decisions(self):
        p = self.plan_by_id()
        self.assertEqual(p["claude.global.hwp"]["do"], "convert")
        self.assertEqual(p["claude.global.self-improve"]["do"], "skip")   # exclude list
        self.assertEqual(p["claude.global.canva"]["do"], "skip")          # remote
        self.assertEqual(p["codex.global.pdf"]["do"], "convert")
        self.assertEqual(p["codex.global.off"]["do"], "skip")             # disabled stays disabled
        self.assertEqual(p["codex.global.remote"]["do"], "skip")
        local = [k for k in p if k.startswith("claude.l")]
        self.assertEqual(len(local), 2)                                   # two projects, two ids (12-2)
        supa = [a for a in p.values() if a.get("entry") and a["entry"].name == "supa"][0]
        self.assertEqual(supa["why"], "git 저장소 안의 설정(직접 유지)")
        phys = [a for a in p.values() if a.get("entry") and a["entry"].name == "phys"][0]
        self.assertEqual(phys["do"], "convert")

    def test_apply_edits_only_command_and_args_then_restore(self):
        before_json = (self.s.claude / ".claude.json").read_text(encoding="utf-8")
        before_toml = (self.s.codex / "config.toml").read_bytes()
        res = sync.apply(self.s.state, sync.plan(self.s.state, self.s.sources()), python=PY)
        self.assertFalse(res["failed"], res["failed"])
        self.assertTrue(all(r.get("verified") for r in res["converted"]))
        data = json.loads((self.s.claude / ".claude.json").read_text(encoding="utf-8"))
        hwp = data["mcpServers"]["hwp"]
        self.assertEqual(sync.shim_id(hwp), "claude.global.hwp")
        self.assertEqual(hwp["env"], {"API_KEY": "s3cret-value"})  # env untouched, stays in the client file
        self.assertEqual(data["numStartups"], 3)
        self.assertEqual(data["mcpServers"]["canva"], {"type": "http", "url": "https://mcp.canva.com/mcp"})
        reg = self.s.state.get_entry("claude.global.hwp")
        self.assertNotIn("s3cret-value", json.dumps(reg))          # no env values in the registry
        toml = (self.s.codex / "config.toml").read_bytes()
        self.assertIn(b"\r\n", toml)
        self.assertNotIn(b"\n", toml.replace(b"\r\n", b""))         # line endings kept as CRLF
        self.assertIn(b'default_tools_approval_mode = "prompt"', toml)
        self.assertIn(b'PYTHONUTF8 = "1"', toml)
        self.assertIn(b"enabled = false", toml)
        self.assertTrue(list(self.s.state.backups_dir.iterdir()))
        # restore everything -> byte-identical files
        out = sync.restore_all(self.s.state, self.s.sources())
        self.assertTrue(all(r["ok"] for r in out))
        self.assertEqual((self.s.codex / "config.toml").read_bytes(), before_toml)
        self.assertEqual((self.s.claude / ".claude.json").read_text(encoding="utf-8"), before_json)
        # released entries are not converted again
        p = self.plan_by_id()
        self.assertEqual(p["claude.global.hwp"]["why"], "직접 연결로 되돌린 항목")

    def test_revert_vs_user_change_rule(self):
        sync.apply(self.s.state, sync.plan(self.s.state, self.s.sources()), python=PY)
        path = self.s.claude / ".claude.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["mcpServers"]["hwp"].update(command="C:\\venv\\python.exe", args=["C:\\srv\\hwp.py"])  # stale copy written back
        data["projects"]["C:/W/A"]["mcpServers"]["hwp"].update(command="other.exe", args=["--mine"])  # user's own change
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        p = self.plan_by_id()
        self.assertEqual(p["claude.global.hwp"]["do"], "convert")
        local_a = [a for k, a in p.items() if k.startswith("claude.l") and a["entry"].project_key == "C:/W/A"][0]
        self.assertEqual(local_a["do"], "release")

    def test_entry_removed_from_config_leaves_a_tombstone(self):
        sync.apply(self.s.state, sync.plan(self.s.state, self.s.sources()), python=PY)
        phys_id = [r["id"] for r in self.s.state.entries() if r["name"] == "phys"][0]
        self.s.state.put_catalog(phys_id, {"tools": []})
        role = self.s.root / "R01-교사(Teacher)" / ".mcp.json"
        role.write_text('{"mcpServers": {}}', encoding="utf-8")
        p = sync.plan(self.s.state, self.s.sources())
        rm = [a for a in p if a["do"] == "remove"]
        self.assertEqual(len(rm), 1)
        sync.apply(self.s.state, p, python=PY)
        reg = self.s.state.get_entry(phys_id)
        self.assertEqual(reg["status"], "removed")                    # kept as a tombstone, not deleted
        self.assertEqual(reg["original"], {"command": "uvx", "args": ["phys"]})
        self.assertFalse(self.s.state.catalog_path(phys_id).exists())  # menu dropped
        again = [a for a in sync.plan(self.s.state, self.s.sources()) if a["do"] == "remove"]
        self.assertEqual(again, [])                                   # a tombstone is not removed twice

    # --- 2026-11-01 incident: an unreadable .claude.json was read as "every entry gone" ---
    def test_unreadable_config_holds_removals(self):
        sync.apply(self.s.state, sync.plan(self.s.state, self.s.sources()), python=PY)
        path = self.s.claude / ".claude.json"
        good = path.read_text(encoding="utf-8")
        path.write_text(good[: len(good) // 2], encoding="utf-8")    # half-written by a running Claude
        p = sync.plan(self.s.state, self.s.sources())
        self.assertEqual([a for a in p if a["do"] == "remove"], [])
        held = [a for a in p if a["do"] == "hold"]
        self.assertTrue(held and all(a["reg"]["agent"] == "claude" for a in held))
        sync.apply(self.s.state, p, python=PY)
        self.assertEqual(self.s.state.get_entry("claude.global.hwp")["status"], "relayed")

    def test_unreadable_codex_toml_holds_removals(self):
        sync.apply(self.s.state, sync.plan(self.s.state, self.s.sources()), python=PY)
        (self.s.codex / "config.toml").write_bytes(b"[mcp_servers.pdf\r\ncommand = ")
        p = sync.plan(self.s.state, self.s.sources())
        self.assertNotIn("codex.global.pdf", [a["reg"]["id"] for a in p if a["do"] == "remove"])

    def test_confirm_removals_drops_a_transient_disappearance(self):
        sync.apply(self.s.state, sync.plan(self.s.state, self.s.sources()), python=PY)
        role = self.s.root / "R01-교사(Teacher)" / ".mcp.json"
        good = role.read_text(encoding="utf-8")
        role.write_text('{"mcpServers": {}}', encoding="utf-8")
        p = sync.plan(self.s.state, self.s.sources())
        self.assertEqual(len([a for a in p if a["do"] == "remove"]), 1)

        def rediscover_after_fix():
            role.write_text(good, encoding="utf-8")                   # the writer finished
            return self.s.sources()
        kept = sync.confirm_removals(self.s.state, p, rediscover_after_fix, wait=0)
        self.assertEqual([a for a in kept if a["do"] == "remove"], [])
        role.write_text('{"mcpServers": {}}', encoding="utf-8")
        p = sync.plan(self.s.state, self.s.sources())
        kept = sync.confirm_removals(self.s.state, p, self.s.sources, wait=0)
        self.assertEqual(len([a for a in kept if a["do"] == "remove"]), 1)  # really gone: still removed

    def test_shim_with_tombstone_is_revived(self):
        sync.apply(self.s.state, sync.plan(self.s.state, self.s.sources()), python=PY)
        reg = self.s.state.get_entry("claude.global.hwp")
        self.s.state.put_entry(dict(reg, status="removed"))
        p = self.plan_by_id()
        self.assertEqual(p["claude.global.hwp"]["do"], "revive")
        res = sync.apply(self.s.state, list(p.values()), python=PY)
        self.assertEqual(len(res["revived"]), 1)
        back = self.s.state.get_entry("claude.global.hwp")
        self.assertEqual(back["status"], "relayed")
        self.assertEqual(back["real"], {"command": "C:\\venv\\python.exe", "args": ["C:\\srv\\hwp.py"]})

    def test_shim_without_registry_is_recovered_from_backup(self):
        sync.apply(self.s.state, sync.plan(self.s.state, self.s.sources()), python=PY)
        for eid in ("claude.global.hwp", "codex.global.pdf"):
            self.s.state.registry_path(eid).unlink()                 # what the old auto-sync did
        p = self.plan_by_id()
        self.assertEqual(p["claude.global.hwp"]["do"], "recover")
        self.assertEqual(p["codex.global.pdf"]["do"], "recover")
        res = sync.apply(self.s.state, list(p.values()), python=PY)
        self.assertEqual(len(res["recovered"]), 2)
        hwp = self.s.state.get_entry("claude.global.hwp")
        self.assertEqual(hwp["status"], "relayed")
        self.assertEqual(hwp["real"], {"command": "C:\\venv\\python.exe", "args": ["C:\\srv\\hwp.py"]})
        self.assertTrue(hwp["expandVars"])
        self.assertTrue(hwp.get("recoveredFrom"))
        pdf = self.s.state.get_entry("codex.global.pdf")
        self.assertEqual(pdf["real"], {"command": "C:\\py\\python.exe", "args": ["C:\\srv\\pdf.py"]})
        self.assertEqual(pdf.get("startTimeoutSec"), 30)
        self.assertEqual(self.plan_by_id()["claude.global.hwp"]["do"], "ok")

    def test_shim_without_registry_or_backup_stays_a_problem(self):
        import shutil
        sync.apply(self.s.state, sync.plan(self.s.state, self.s.sources()), python=PY)
        self.s.state.registry_path("claude.global.hwp").unlink()
        shutil.rmtree(self.s.state.backups_dir)
        p = self.plan_by_id()
        self.assertEqual(p["claude.global.hwp"]["do"], "problem")

    def test_backup_rotation_keeps_the_first_apply_snapshot(self):
        bdir = self.s.state.backups_dir
        first = bdir / "20200101-000000-before-first-apply"
        first.mkdir(parents=True)
        (first / "index.json").write_text("[]", encoding="utf-8")
        loose = bdir / "20200101-000001-registry-before-restore"     # hand-made copy, no index.json
        loose.mkdir()
        src = self.s.claude / ".claude.json"
        for i in range(sync.KEEP_BACKUP_RUNS + 2):
            sync._backup(self.s.state, [src], f"2021010{i}-000000")
        runs = sorted(x.name for x in bdir.iterdir())
        self.assertIn(first.name, runs)
        self.assertIn(loose.name, runs)
        self.assertEqual(len([r for r in runs if r.startswith("2021")]), sync.KEEP_BACKUP_RUNS)

    def test_drop_ledger_tolerates_os_errors(self):
        self.s.state.ledger_dir.mkdir(parents=True, exist_ok=True)
        self.s.state.ledger_path(4242).mkdir()                       # unlink() on a folder raises OSError
        self.s.state.drop_ledger(4242)


class ScopeGuardTests(unittest.TestCase):
    """2026-10-28 incident: a temp-state daemon followed the live CLAUDE_CONFIG_DIR."""

    def test_homes_ignore_env_outside_the_root(self):
        import os
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            os.makedirs(os.path.join(b, "elsewhere"))
            old = dict(os.environ)
            try:
                os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(b, "elsewhere")
                os.environ["CODEX_HOME"] = os.path.join(b, "elsewhere")
                self.assertEqual(daemon.homes(Path(a)), (None, None))
                os.makedirs(os.path.join(a, "_agent", "claude"))
                self.assertEqual(daemon.homes(Path(a))[0], Path(a) / "_agent" / "claude")
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_discover_drops_homes_outside_the_root(self):
        s = Soul()
        try:
            with tempfile.TemporaryDirectory() as other:
                srcs = configs.discover(Path(other), s.claude, s.codex)
                self.assertEqual([x for x in srcs if x.kind in ("claude-user", "codex")], [])
        finally:
            s.close()


class SurveyBackoffTests(unittest.TestCase):
    def test_failed_survey_is_not_retried_by_the_daemon_for_a_while(self):
        from mcp_relay import survey
        with tempfile.TemporaryDirectory() as d:
            st = store.State(Path(d))
            reg = {"id": "x.global.bad", "real": {"command": r"C:\nope\missing.exe", "args": []}, "status": "relayed"}
            st.put_entry(reg)
            r = survey.survey_one(st, reg, [], Path(d))
            self.assertFalse(r["ok"])
            self.assertTrue(survey.recently_failed(st, "x.global.bad"))
            self.assertEqual(survey.needs_survey(st, reg), "missing")  # status still honest


@unittest.skipUnless(sys.platform == "win32", "Windows processes")
class SweepTests(unittest.TestCase):
    def test_sweep_ends_orphans_only_with_matching_identity(self):
        with tempfile.TemporaryDirectory(prefix="relay-w-") as d:
            st = store.State(Path(d))
            orphan = subprocess.Popen([PY, "-c", "import time; time.sleep(60)"])
            other = subprocess.Popen([PY, "-c", "import time; time.sleep(60)"])
            try:
                ct = winproc.creation_time(orphan.pid)
                st.put_ledger(999991, {"id": "x", "shimPid": 999991, "shimCreated": 1, "serverPid": orphan.pid, "serverCreated": ct})
                st.put_ledger(999992, {"id": "y", "shimPid": 999992, "shimCreated": 1, "serverPid": other.pid, "serverCreated": 12345})
                ended = daemon.sweep(st)
                time.sleep(0.5)
                self.assertEqual(len(ended), 1)
                self.assertIsNotNone(orphan.poll())          # orphan with matching identity: ended
                self.assertIsNone(other.poll())              # wrong creation time = not ours: untouched
                self.assertEqual(st.ledger(), [])
            finally:
                for p in (orphan, other):
                    if p.poll() is None:
                        p.kill()


if __name__ == "__main__":
    unittest.main()
