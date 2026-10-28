# -*- coding: utf-8 -*-
"""block-blanket-kill-posix.py test. Run: python3 block-blanket-kill-posix.test.py

The script is found next to this file. PID cases use an injected protected-PID set, so the
test never depends on what is running on this machine; one end-to-end case pipes a hook
payload through the real script.
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "block-blanket-kill-posix.py"
spec = importlib.util.spec_from_file_location("bbk", SCRIPT)
bbk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bbk)

PROTECTED = {4242, 5151}
cases = [
    # (name, expect_deny, command)
    ("A pkill node", True, "pkill node"),
    ("A killall -9 node", True, "killall -9 node"),
    ("A pkill -f claude", True, "pkill -f claude"),
    ("A kill $(pgrep node)", True, "kill $(pgrep node)"),
    ("A pgrep | xargs kill", True, "pgrep -f codex | xargs kill -9"),
    ("A taskkill spelling", True, "taskkill /IM node.exe /F"),
    ("B lsof port | xargs kill", True, "lsof -ti :3458 | xargs kill"),
    ("B kill $(lsof -t -i:3456)", True, "kill $(lsof -t -i:3456)"),
    ("B daemon.pid", True, "kill $(cat ~/IRIS/_agent/shared/tools/face/state/daemon.pid)"),
    ("B script name", True, "pkill -f daemon/server.mjs"),
    ("B api shutdown", True, "curl -X POST http://127.0.0.1:3458/api/shutdown"),
    ("B protected pid", True, "kill -9 4242"),
    ("B protected pid in node", True, "node -e 'process.kill(5151)'"),
    ("ok own pid", False, "kill 7777"),
    ("ok listing", False, "lsof -nP -iTCP:3458 -sTCP:LISTEN"),
    ("ok ps", False, "ps aux | grep node"),
    ("ok unrelated", False, "git status && npm test"),
    ("ok killall Finder", False, "killall Finder"),
]

failed = 0
for name, expect, cmd in cases:
    got = bbk.check(cmd, protected_fn=lambda: PROTECTED) is not None
    status = "ok" if got == expect else "FAIL"
    if got != expect:
        failed += 1
    print(f"{status:4} {name}: deny={got} (expected {expect})")

payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "pkill node"}})
r = subprocess.run([sys.executable, str(SCRIPT)], input=payload, capture_output=True, text=True)
decision = json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"] if r.stdout.strip() else None
if decision != "deny":
    failed += 1
print(f"{'ok' if decision == 'deny' else 'FAIL':4} end-to-end stdin payload -> {decision}")
r = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps({"tool_input": {"command": "ls"}}), capture_output=True, text=True)
if r.stdout.strip() or r.returncode != 0:
    failed += 1
print(f"{'ok' if not r.stdout.strip() else 'FAIL':4} end-to-end allowed command -> no output")

print("ALL PASS" if failed == 0 else f"{failed} FAILED")
sys.exit(1 if failed else 0)
