"""Test probe for the shipped gen-image.py + codex-ready.py pair (tests/gen-image.test.mjs).

Loads gen-image.py as a module and exercises one piece without any network or real codex:
  pair <status.json>   real helper judges a status fixture (its relay read is replaced) -> what gen-image sees
  cmd  <ref>...        gen_codex with a fake process -> the exact argument list it would have started

usage: python gen_image_probe.py <tools-dir> pair|cmd [args...]
"""
import sys, json, pathlib, importlib.util

tools = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
rest = sys.argv[3:]
sys.argv = ["gen-image.py"]

spec = importlib.util.spec_from_file_location("gen_image", tools / "gen-image.py")
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

if mode == "pair":
    status = json.loads(pathlib.Path(rest[0]).read_text(encoding="utf-8"))
    real = g.load_codex_ready()
    real.fetch_status = lambda timeout=5: status   # never touch the relay port from a test
    g.load_codex_ready = lambda: real
    print(json.dumps(g.codex_accounts()))
elif mode == "cmd":
    seen = {}

    class FakePopen:
        def __init__(self, cmd, **kw):
            seen["cmd"] = [str(c) for c in cmd]
            self.returncode = 1

        def communicate(self, timeout=None):
            return b"", b"fake codex"

        def kill(self):
            pass

    g.shutil.which = lambda name: "codex-fake"
    g.subprocess.Popen = FakePopen
    ok, res = g.gen_codex("PROMPT-TEXT", "1024x1024", "high", rest, tools / "out.png", False)
    print(json.dumps({"ok": ok, "res": res, "cmd": seen.get("cmd")}))
else:
    sys.exit(2)
