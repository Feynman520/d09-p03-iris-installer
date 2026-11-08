"""IRIS MCP relay -- entry point.

  python -I relay.py shim --id <id> [--state DIR]      per-session stdio shim (clients start this)
  python -I relay.py daemon [--port 3461] | --stop     shared relay (IRIS launcher starts this)
  python -I relay.py status [--json]                   what is relayed / running / failing
  python -I relay.py sync [--apply]                    convert new local MCPs (preview by default)
  python -I relay.py survey [--id ID | --missing]      (re)build catalogs by starting servers once
  python -I relay.py restore (--all | --id ID)         back to direct connections
  python -I relay.py relay --id ID                     relay an entry that was restored before
Common: --state DIR (default <root>\\_agent\\shared\\mcp-relay), --root DIR, --claude-home, --codex-home
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:  # -I drops the script folder from sys.path
    sys.path.insert(0, str(HERE))

from mcp_relay import VERSION, configs, store  # noqa: E402


def _out(text: str) -> None:
    sys.stdout.buffer.write((text + "\n").encode("utf-8"))
    sys.stdout.flush()


def _context(a):
    st = store.State(a.state)
    root = Path(a.root) if a.root else store.root_from_state(st.dir)
    from mcp_relay import daemon as d
    claude, codex = d.homes(root)
    if a.claude_home:
        claude = Path(a.claude_home)
    if a.codex_home:
        codex = Path(a.codex_home)
    return st, root, claude, codex


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="relay.py", description="IRIS MCP relay")
    p.add_argument("--state")
    p.add_argument("--root")
    p.add_argument("--claude-home")
    p.add_argument("--codex-home")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("shim")
    s.add_argument("--id", required=True)
    s.add_argument("--state", dest="state_sub")
    s = sub.add_parser("daemon")
    s.add_argument("--port", type=int, default=3461)
    s.add_argument("--stop", action="store_true")
    s = sub.add_parser("status")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("sync")
    s.add_argument("--apply", action="store_true")
    s.add_argument("--no-survey", action="store_true")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("survey")
    s.add_argument("--id")
    s.add_argument("--missing", action="store_true")
    s.add_argument("--timeout", type=float, default=120.0)
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("restore")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--id")
    s = sub.add_parser("relay")
    s.add_argument("--id", required=True)
    sub.add_parser("version")
    a = p.parse_args(argv)
    if getattr(a, "state_sub", None):
        a.state = a.state_sub

    if a.cmd == "shim":
        from mcp_relay import shim
        return shim.main(a.id, a.state)
    if a.cmd == "version":
        _out(VERSION)
        return 0

    st, root, claude, codex = _context(a)
    if a.cmd == "daemon":
        from mcp_relay import daemon as d
        if a.stop:
            ok = d.stop_daemon(st)
            _out("공용 중계기를 껐습니다" if ok else "켜져 있는 공용 중계기가 없습니다")
            return 0
        st.dir.mkdir(parents=True, exist_ok=True)
        st.ensure_settings()
        return d.Daemon(st, a.port).serve()
    if a.cmd == "status":
        from mcp_relay import status
        data = status.collect(st)
        _out(json.dumps(data, ensure_ascii=False, indent=2) if a.json else status.render(data))
        return 0
    if a.cmd == "sync":
        from mcp_relay import survey, sync
        sources = configs.discover(root, claude, codex)
        actions = sync.plan(st, sources)
        rows = [{"do": x["do"], "id": (x.get("entry").id if x.get("entry") else x["reg"]["id"]),
                 "file": str(x["entry"].source.path) if x.get("entry") else None, "why": x["why"]} for x in actions]
        if not a.apply:
            _out(json.dumps(rows, ensure_ascii=False, indent=2) if a.json else
                 "\n".join(f"[{r['do']}] {r['id']} — {r['why']}" for r in rows) + "\n(미리보기입니다. 바꾸려면 --apply)")
            return 0
        result = sync.apply(st, actions)
        if not a.no_survey:
            sources = configs.discover(root, claude, codex)
            result["surveyed"] = [survey.survey_one(st, reg, sources, root)
                                  for reg in st.entries() if reg.get("status") == "relayed" and survey.needs_survey(st, reg)]
        _out(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result["failed"] else 0
    if a.cmd == "survey":
        from mcp_relay import survey
        sources = configs.discover(root, claude, codex)
        regs = [r for r in st.entries() if r.get("status") == "relayed"]
        if a.id:
            regs = [r for r in regs if r["id"] == a.id]
        elif a.missing:
            regs = [r for r in regs if survey.needs_survey(st, r)]
        res = [survey.survey_one(st, r, sources, root, timeout=a.timeout) for r in regs]
        _out(json.dumps(res, ensure_ascii=False, indent=2))
        return 0 if all(r["ok"] for r in res) else 1
    if a.cmd == "restore":
        from mcp_relay import sync
        sources = configs.discover(root, claude, codex)
        res = sync.restore_all(st, sources, only_id=None if a.all else a.id)
        _out(json.dumps(res, ensure_ascii=False, indent=2))
        return 0 if all(r["ok"] for r in res) else 1
    if a.cmd == "relay":
        from mcp_relay import sync
        reg = st.get_entry(a.id)
        if not reg:
            _out(f"등록부에 {a.id} 가 없습니다")
            return 1
        st.put_entry(dict(reg, status="relayed"))
        sources = configs.discover(root, claude, codex)
        e = configs.find_entry(sources, a.id)
        if e is None:
            _out("설정에서 그 항목을 찾지 못했습니다")
            return 1
        r = sync.convert(st, e, sync.python_for_shims(st.settings()))
        _out(json.dumps(r, ensure_ascii=False))
        return 0 if r["ok"] else 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
