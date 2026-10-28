"""What is relayed, what is running, what went wrong -- without secrets."""
from __future__ import annotations

import datetime as _dt
import json

from . import VERSION, store, survey, winproc


def collect(st: store.State) -> dict:
    entries = []
    for reg in st.entries():
        cat = st.get_catalog(reg["id"])
        entries.append({
            "id": reg["id"], "name": reg.get("name"), "agent": reg.get("agent"), "status": reg.get("status"),
            "owner": reg.get("owner"), "catalog": survey.needs_survey(st, reg) or "ok",
            "tools": len((cat or {}).get("tools") or []),
        })
    running = []
    for _p, rec in st.ledger():
        alive = winproc.is_same_alive(int(rec.get("shimPid") or 0), rec.get("shimCreated"))
        running.append({"id": rec.get("id"), "agent": rec.get("agent"), "session": rec.get("sessionId"),
                        "client": (rec.get("client") or {}).get("name"), "since": rec.get("startedAt"),
                        "serverPid": rec.get("serverPid"), "alive": alive})
    info = store.read_json(st.dir / "daemon.json", {}) or {}
    daemon = None
    if info.get("pid"):
        daemon = {"pid": info["pid"], "port": info.get("port"), "version": info.get("version"),
                  "alive": winproc.is_same_alive(int(info["pid"]), info.get("created"))}
    problems = []
    day = _dt.datetime.now().strftime("%Y%m%d")
    log = st.logs_dir / f"relay-{day}.log"
    if log.exists():
        for line in log.read_text(encoding="utf-8", errors="replace").splitlines()[-400:]:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("ev") in ("server-fail", "survey-fail", "server-exit", "registry-missing", "daemon-error"):
                problems.append({k: ev.get(k) for k in ("t", "ev", "id", "stage", "detail", "code")})
    return {"version": VERSION, "state": str(st.dir), "daemon": daemon, "entries": entries,
            "running": running, "problems": problems[-10:]}


def render(data: dict) -> str:
    lines = [f"IRIS MCP 중계기 {data['version']} — 상태 폴더 {data['state']}"]
    d = data.get("daemon")
    lines.append("공용 중계기: " + (f"실행 중 (PID {d['pid']}, 포트 {d['port']})" if d and d.get("alive") else "꺼져 있음"))
    lines.append("")
    lines.append("중계 대상:")
    cat_ko = {"ok": "메뉴판 최신", "stale": "메뉴판 낡음(쓸 때 갱신)", "missing": "메뉴판 없음(첫 세션이 바로 켬)"}
    st_ko = {"relayed": "중계", "released": "직접 연결로 되돌림", "removed": "삭제됨"}
    for e in data["entries"]:
        lines.append(f"  - {e['id']}: {st_ko.get(e['status'], e['status'])} · {cat_ko.get(e['catalog'], e['catalog'])} · 도구 {e['tools']}개")
    lines.append("")
    alive = [r for r in data["running"] if r["alive"]]
    lines.append(f"지금 켜진 실제 MCP: {len(alive)}개")
    for r in alive:
        lines.append(f"  - {r['id']} (클라이언트 {r['client']}, 세션 {r['session'] or '-'}, {r['since']})")
    if data["problems"]:
        lines.append("")
        lines.append("오늘 생긴 문제(최근 10건):")
        for p in data["problems"]:
            lines.append(f"  - {p['t']} {p['ev']} {p.get('id') or ''} {p.get('stage') or ''} {p.get('detail') or ''}".rstrip())
    return "\n".join(lines)
