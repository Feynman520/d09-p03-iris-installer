r"""bg-leftover-guard.py — Stop 훅: 답을 끝내려는데 이번 차례에 띄운 배경 명령이 아직 돌고 있으면 한 번 멈춰 세운다.

배경(2026-10-07 사용자 신고): 파일 검색 명령이 120초를 넘겨 배경으로 넘어갔는데, 에이전트가 다른 길로 답을 찾고
그 명령을 끄지 않은 채 답을 끝냈다. 터미널은 "셸 1개 실행 중", IRIS-Face는 v2.80 규칙대로 파란 핀(배경 작업 중)을
계속 돌려 "끝났는데 왜 작업 중이냐"는 혼란이 생겼다. Face 표시는 사실이었고, 고칠 곳은 끄지 않은 습관이다.

판정(클로드코드 2.1.27x 기록 실측 문구, IRIS-Face daemon/transcript.mjs backgroundPending 과 같은 짝짓기):
  시작 = 도구 결과 "Command running in background with ID: X" · "moved to the background (ID: X)"
  끝   = 같은 X 의 <task-notification> 에 <status> 가 있음(사용자 글·작업 도중 흡수된 queue-operation/attachment 어디든) · TaskStop/KillShell(task_id/shell_id = X)
  목록 = 훅 입력 background_tasks 가 실측 모양이면 그것이 진실(목록에 없거나 끝난 상태 = 끝, 2026-10-11 유령 사건) · 모르는 모양이면 기록 판정만
  범위 = 이번 차례(마지막 사람 요청·작업 알림 이후)에 시작한 것만 — 지난 차례에 이미 한 번 확인받은 것은 다시 묻지 않는다.
  제외 = 알람용 `sleep N` 명령(장기 작업 정기 보고용 알람은 일부러 걸어 둔 것) · 감시(Monitor, 스스로 만료됨) · 보조 기록(isSidechain)
         · 이번 차례 에이전트 글에 그 작업 id 가 이미 나옴(일부러 기다린다고 밝힘 — 실사용 첫날 이유를 적었는데도 한 번 더 막던 왕복 제거).
막기 = stdout 에 {"decision":"block","reason":...}. 같은 Stop 에서 이미 한 번 막았으면(stop_hook_active) 통과 — 무한 반복 없음.
에이전트는 TaskStop 으로 끄거나, 일부러 기다리는 것이면 답에 무엇을 왜 기다리는지 한 줄 적고 다시 마치면 된다.
어떤 오류가 나도 막지 않는다(훅 고장으로 세션이 멈추면 안 된다). 프로세스를 직접 죽이지 않는다 — 판단과 종료는 에이전트 몫.
시험: python bg-leftover-guard.test.py
"""
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime

# 문구는 도구 결과의 맨 앞에만 온다 — 문서·코드를 출력한 결과 속 예시 문장("…with ID: X")은 배경 작업이 아니다(2026-10-07 유령 X 사건).
START_RES = (re.compile(r"^\s*Command running in background with ID: ([\w-]+)"),
             re.compile(r"^\s*Command did not complete within [^\n]*? moved to the background \(ID: ([\w-]+)\)"))
NOTE_RE = re.compile(r"<task-notification>(.*?)</task-notification>", re.S)
TASK_ID_RE = re.compile(r"<task-id>([\w-]+)</task-id>")
SLEEP_RE = re.compile(r"^\s*sleep\s+\d+(\.\d+)?[smh]?\s*((;|&&)\s*echo\b[^;&|]*)?\s*$")  # 순수 알람만(뒤에 echo 하나까지)


def block_text(c):
    """content(문자열 또는 블록 목록)에서 글만 모은다."""
    if isinstance(c, str):
        return c
    out = []
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    out.append(b.get("text") or "")
                elif b.get("type") == "tool_result":
                    out.append(block_text(b.get("content")))
    return "\n".join(out)


def ts(rec):
    try:
        return datetime.fromisoformat(rec["timestamp"].replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def pending(lines, now=None, last_text="", any_turn=False):
    """이번 차례에 시작해서 아직 안 끝난 배경 명령 목록 [{id, desc, cmd, t}].
    last_text = 훅 입력의 마지막 답(last_assistant_message) — 기록 파일엔 마지막 답이 훅 뒤에 적혀
    "id 를 적었는데도 막던" 문제(2026-10-07 실측)를 메운다."""
    now = now or time.time()
    tool_in = {}       # tool_use id → (name, input)
    started = {}       # task id → {desc, cmd, t, turn}
    ended = set()
    turn = 0
    said = []          # 이번 차례 에이전트 글 — 작업 id 를 이미 밝혔으면(일부러 기다림) 다시 묻지 않는다
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("isSidechain"):
            continue
        # 작업 도중 도착한 끝 알림은 사용자 글이 아니라 queue-operation(enqueue)·attachment(queued_command) 로만 남는다
        # (2026-10-11 실사용: 작업 도중 끝난 코덱스 명령을 못 보고 유령으로 막음). IRIS-Face transcript.mjs 와 같은 재료.
        absorbed = ""
        if rec.get("type") == "queue-operation" and rec.get("operation") == "enqueue":
            absorbed = rec.get("content") if isinstance(rec.get("content"), str) else ""
        elif rec.get("type") == "attachment":
            p = (rec.get("attachment") or {}).get("prompt")
            absorbed = p if isinstance(p, str) else ""
        if absorbed:
            for note in NOTE_RE.findall(absorbed):
                m = TASK_ID_RE.search(note)
                if m and "<status>" in note:
                    ended.add(m.group(1))
            continue
        msg = rec.get("message") or {}
        content = msg.get("content")
        if rec.get("type") == "assistant" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "text":
                    said.append(b.get("text") or "")
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    inp = b.get("input") or {}
                    tool_in[b.get("id")] = (b.get("name"), inp)
                    if b.get("name") in ("TaskStop", "KillShell"):
                        tid = inp.get("task_id") or inp.get("shell_id")
                        if tid:
                            ended.add(tid)
            continue
        if rec.get("type") != "user":
            continue
        blocks = content if isinstance(content, list) else []
        results = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_result"]
        text = block_text(content)
        # 작업 알림: 상태가 있으면 끝(상태 없는 감시 이벤트는 끝이 아님)
        for note in NOTE_RE.findall(text):
            m = TASK_ID_RE.search(note)
            if m and "<status>" in note:
                ended.add(m.group(1))
        if not results:
            if not rec.get("isMeta"):
                turn += 1          # 사람 요청이나 작업 알림 = 새 차례
                said = []
            continue
        for b in results:
            body = block_text(b.get("content"))
            for rx in START_RES:
                m = rx.match(body)
                if m:
                    name, inp = tool_in.get(b.get("tool_use_id"), (None, {}))
                    started[m.group(1)] = {"desc": inp.get("description") or "", "cmd": inp.get("command") or "",
                                           "t": ts(rec) or now, "turn": turn}
                    break
    out = []
    spoken = "\n".join(said) + "\n" + (last_text or "")
    for tid, s in started.items():
        if tid in ended or (s["turn"] != turn and not any_turn) or tid in spoken:
            continue
        if SLEEP_RE.match(s["cmd"]):
            continue
        out.append({"id": tid, "desc": s["desc"], "cmd": s["cmd"], "t": s["t"]})
    return out


DONE_STATUSES = {"completed", "failed", "killed", "stopped", "cancelled", "canceled", "done", "error"}


def live_ids(bt):
    """클로드코드 background_tasks(2026-10-07·10-11 실측 [{id, type, status, description, …}]) → 아직 도는 id 집합.
    빈 목록 = 도는 것 없음(빈 집합). 모양을 모르면(목록 아님·id 없는 항목) None — 호출 쪽이 기록 판정으로 간다."""
    if not isinstance(bt, list):
        return None
    out = set()
    for x in bt:
        if not isinstance(x, dict) or not isinstance(x.get("id"), str):
            return None
        if str(x.get("status") or "").lower() in DONE_STATUSES:
            continue
        out.add(x["id"])
    return out


def reason(items, now=None):
    now = now or time.time()
    rows = []
    for it in items:
        mins = max(0, int((now - it["t"]) // 60))
        what = it["desc"] or (it["cmd"][:80] + ("…" if len(it["cmd"]) > 80 else ""))
        rows.append(f"  - {it['id']} · {what} · {mins}분째")
    return ("[bg-leftover-guard] 답을 끝내기 전에 확인: 이번 차례에 띄운 배경 명령 %d개가 아직 돌고 있습니다.\n%s\n"
            "더 필요 없으면 TaskStop(task_id)으로 끈 뒤 마치세요. 결과를 일부러 기다리는 중이면 끄지 말고, "
            "답 끝에 그 작업 id 와 기다리는 이유를 한 줄 적고 다시 마치면 됩니다(답에 id 를 적은 작업은 다시 묻지 않습니다). "
            "끄지 않으면 사용자 화면(터미널·IRIS-Face)에 '작업 중'이 계속 보입니다." % (len(items), "\n".join(rows)))


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace") or "{}")
        try:  # 입력 칸 이름만 남긴다(내용 없음) — 판마다 입력 모양이 다른지 확인용. 시험(session_id 없음)은 덮어쓰지 않는다
            if data.get("session_id"):
                with open(os.path.join(tempfile.gettempdir(), "bg-leftover-guard.last-input-keys.txt"), "w", encoding="utf-8") as kf:
                    kf.write(" ".join(sorted(data.keys())))
        except Exception:
            pass
        if data.get("stop_hook_active"):
            return
        path = data.get("transcript_path")
        if not path:
            return
        last = data.get("last_assistant_message") or ""
        if not isinstance(last, str):
            last = json.dumps(last, ensure_ascii=False)
        # 실제로 도는 목록(background_tasks)이 있으면 지난 차례에 띄운 것까지 본다 — 중간 보고 때 "기다린다"고 넘긴 작업을
        # 최종 보고 때까지 잊고 남기는 경우를 막는다(유령은 아래 교차 확인이 거른다). 목록이 없는 옛 판은 이번 차례만.
        with open(path, encoding="utf-8", errors="replace") as f:
            items = pending(f, last_text=last, any_turn="background_tasks" in data)
        # 클로드코드가 주는 "지금 실제로 도는 작업" 목록(background_tasks, 2026-10-07 입력에서 확인)과 교차 확인:
        # 거기 id 가 없으면 이미 끝난 것이다(기록만 보고 판정할 때의 유령을 막는다). 칸이 없는 옛 판이면 기록 판정만 쓴다.
        if "background_tasks" in data:
            bt = data.get("background_tasks")
            alive_ids = live_ids(bt)
            if alive_ids is not None:
                # 목록 모양이 실측대로([{id, type, status, …}])면 목록을 믿는다 — 목록에 없거나 끝난 상태면 끝난 것이다.
                # (예전엔 목록에 다른 작업만 있으면 "모양을 잘못 읽었나" 하고 기록 판정으로 되돌아가, 끝난 작업을 유령으로 막았다 — 2026-10-11)
                items = [it for it in items if it["id"] in alive_ids]
            else:
                # 모양을 모르는 목록이면 안전하게 이번 차례 기록 판정만(흡수된 끝 알림도 끝으로 센다)
                with open(path, encoding="utf-8", errors="replace") as f:
                    items = pending(f, last_text=last)
            alive = json.dumps(bt, ensure_ascii=False)
            try:
                with open(os.path.join(tempfile.gettempdir(), "bg-leftover-guard.last-background-tasks.json"), "w", encoding="utf-8") as bf:
                    bf.write(alive[:20000])
            except Exception:
                pass
        if items:
            print(json.dumps({"decision": "block", "reason": reason(items)}, ensure_ascii=False))
    except Exception:
        return  # 훅 고장이 세션을 막지 않게


if __name__ == "__main__":
    main()
