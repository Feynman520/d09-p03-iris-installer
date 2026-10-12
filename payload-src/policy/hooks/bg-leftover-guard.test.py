"""bg-leftover-guard.py 판정 시험 — 가짜 기록만 쓴다(실제 세션·프로세스 접촉 0).

  python bg-leftover-guard.test.py
  python bg-leftover-guard.test.py <실제 기록.jsonl>   # 읽기 전용으로 그 기록의 판정만 보여 준다
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.dont_write_bytecode = True  # 시험이 훅 폴더에 __pycache__ 를 남기지 않게(설치 꾸러미 원본 폴더이기도 하다)
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("blg", os.path.join(HERE, "bg-leftover-guard.py"))
G = importlib.util.module_from_spec(spec)
spec.loader.exec_module(G)

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    fails += not ok
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  got={got} want={want}"))


T = "2026-10-07T07:00:00.000Z"


def user(text, meta=False):
    r = {"type": "user", "timestamp": T, "message": {"role": "user", "content": text}}
    if meta:
        r["isMeta"] = True
    return r


def call(i, name, inp):
    return {"type": "assistant", "timestamp": T, "message": {"role": "assistant", "content": [{"type": "tool_use", "id": i, "name": name, "input": inp}]}}


def res(i, text, side=False):
    r = {"type": "user", "timestamp": T, "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": i, "content": text}]}}
    if side:
        r["isSidechain"] = True
    return r


def say(text):
    return {"type": "assistant", "timestamp": T, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


AUTO = "Command did not complete within its 120s timeout and was moved to the background (ID: b1). Output is being written to: x"
EXPL = "Command running in background with ID: b2. Output is being written to: y"


def note(tid, status="completed"):
    st = f"<status>{status}</status>\n" if status else ""
    return f"<task-notification>\n<task-id>{tid}</task-id>\n<tool-use-id>toolu_z</tool-use-id>\n{st}<summary>Background command done</summary>\n</task-notification>"


def ids(recs):
    return sorted(x["id"] for x in G.pending([json.dumps(r) for r in recs]))


# 1) 오늘 사건: 자동 배경으로 넘어간 검색을 끄지 않고 답을 끝냄 → 막음
base = [user("첨부 찾아줘"), call("u1", "Bash", {"command": "find / -name x", "description": "파일 찾기"}), res("u1", AUTO), say("찾았습니다")]
check("자동 배경 남음 → 막음", ids(base), ["b1"])
# 2) TaskStop 으로 끔 → 통과
check("TaskStop 뒤 → 통과", ids(base + [call("u2", "TaskStop", {"task_id": "b1"}), res("u2", "stopped")]), [])
check("KillShell(shell_id) 뒤 → 통과", ids(base + [call("u2", "KillShell", {"shell_id": "b1"}), res("u2", "ok")]), [])
# 3) 끝 알림(상태 있음)이 옴 → 통과 / 상태 없는 알림은 끝이 아님
check("완료 알림 뒤 → 통과", ids(base + [user(note("b1"))]), [])
check("작업 도중 흡수된 완료 알림(도구 결과 속) → 통과",
      ids(base + [call("u3", "Read", {}), {"type": "user", "timestamp": T, "message": {"role": "user", "content": [
          {"type": "tool_result", "tool_use_id": "u3", "content": "x"}, {"type": "text", "text": note("b1")}]}}]), [])
# 4) 지난 차례에 시작한 것은 다시 묻지 않음
check("다음 사람 요청 뒤 → 이번 차례 아님", ids(base + [user("고마워"), say("네")]), [])
# 5) 알람 sleep 은 제외, 일부러 띄운 배경 빌드는 막음
check("알람 sleep 제외", ids([user("긴 작업"), call("a1", "Bash", {"command": "sleep 540", "run_in_background": True}), res("a1", EXPL.replace("b2", "al"))]), [])
check("알람 sleep; echo 제외", ids([user("x"), call("a1", "Bash", {"command": "sleep 540; echo 10min"}), res("a1", EXPL)]), [])
check("sleep 뒤에 다른 명령이 붙으면 막음", ids([user("x"), call("a1", "Bash", {"command": "sleep 5 && npm run build"}), res("a1", EXPL)]), ["b2"])
check("명시 배경 빌드 → 막음", ids([user("빌드"), call("c1", "Bash", {"command": "npm run build", "run_in_background": True}), res("c1", EXPL)]), ["b2"])
# 5-2) 답에 작업 id 를 밝혔으면(일부러 기다림) 묻지 않음 · id 없는 설명만으로는 여전히 막음
check("답에 id 를 적음 → 통과", ids(base + [say("릴리스(b1)를 기다리는 중입니다")]), [])
check("id 없이 기다린다고만 함 → 막음", ids(base + [say("기다리는 중입니다")]), ["b1"])
check("지난 차례의 언급은 이번 차례에 안 침", ids([say("b2 얘기"), user("빌드"), call("c1", "Bash", {"command": "npm run build"}), res("c1", EXPL)]), ["b2"])
# 5-3) 결과 중간의 예시 문장(문서 출력)은 배경 작업 아님
check("문서 속 예시 문장 → 무시", ids([user("x"), call("d1", "Bash", {"command": "sed -n 1,9p doc.md"}),
      res("d1", "설명: `Command running in background with ID: X` · `moved to the background (ID: X)`")]), [])
# 5-4) 2026-10-11 실사용 사례: 끝 알림이 사용자 글이 아니라 queue-operation·attachment(queued_command)로 흡수됨 → 끝으로 센다
chem = [user("이어서 집필하자"), call("u9", "Bash", {"command": "python codex-slot-wait.py --apply", "description": "Run codex chapter-wide critique with slot wait"}),
        res("u9", EXPL.replace("b2", "bq2r9bcp9"))]
q_enq = {"type": "queue-operation", "operation": "enqueue", "timestamp": T, "content": note("bq2r9bcp9", "failed")}
q_rm = {"type": "queue-operation", "operation": "remove", "timestamp": T, "content": note("bq2r9bcp9", "failed")}
att = {"type": "attachment", "timestamp": T, "attachment": {"type": "queued_command", "prompt": note("bq2r9bcp9", "failed")}}
check("흡수된 끝 알림(queue-operation enqueue) → 통과", ids(chem + [q_enq, say("보고")]), [])
check("흡수된 끝 알림(attachment queued_command) → 통과", ids(chem + [att, say("보고")]), [])
check("화학 사건 모양 그대로(enqueue·remove·attachment) → 통과", ids(chem + [q_enq, q_rm, att, say("긴 보고")]), [])
check("흡수된 알림이라도 상태 없으면 끝 아님", ids(chem + [{"type": "queue-operation", "operation": "enqueue", "timestamp": T, "content": note("bq2r9bcp9", None)}]), ["bq2r9bcp9"])
# 6) isMeta 사용자 글(시스템 주입)은 차례를 나누지 않음
check("isMeta 는 새 차례 아님", ids(base + [user("reminder", meta=True)]), ["b1"])
# 7) 보조 기록(isSidechain)은 무시
check("보조 기록 무시", ids([user("x"), call("s1", "Bash", {}), res("s1", EXPL, side=True)]), [])
# 8) 이유 글: 설명·경과 분 포함, 설명 없으면 명령 앞부분
items = G.pending([json.dumps(r) for r in base])
r = G.reason(items, now=items[0]["t"] + 12 * 60)
check("이유 글에 설명·12분째", ("파일 찾기" in r and "12분째" in r and "TaskStop" in r), True)
r2 = G.reason([{"id": "q", "desc": "", "cmd": "python long_job.py --all", "t": 0}], now=60)
check("설명 없으면 명령 앞부분", "python long_job.py" in r2, True)


# 9) 훅 전체 실행(표준 입력 → 표준 출력)
def run_hook(payload):
    p = subprocess.run([sys.executable, os.path.join(HERE, "bg-leftover-guard.py")], input=json.dumps(payload).encode("utf-8"),
                       capture_output=True, timeout=30)
    return p.returncode, p.stdout.decode("utf-8", errors="replace").strip()


with tempfile.TemporaryDirectory() as d:
    f = os.path.join(d, "t.jsonl")
    with open(f, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(json.dumps(r, ensure_ascii=False) for r in base) + "\n")
    code, out = run_hook({"transcript_path": f, "stop_hook_active": False})
    check("훅: 막기 JSON", (code == 0 and json.loads(out).get("decision") == "block"), True)
    code, out = run_hook({"transcript_path": f, "stop_hook_active": False, "last_assistant_message": "b1 릴리스를 기다립니다"})
    check("훅: 마지막 답(입력)에 id → 통과(기록 파일엔 아직 없음)", (code, out), (0, ""))
    code, out = run_hook({"transcript_path": f, "stop_hook_active": False, "background_tasks": []})
    check("훅: 클로드코드 목록이 비었으면(실제로 안 돎) 통과", (code, out), (0, ""))
    code, out = run_hook({"transcript_path": f, "stop_hook_active": False, "background_tasks": [{"id": "b1", "status": "running"}]})
    check("훅: 클로드코드 목록에 id 가 있으면 막음", json.loads(out or "{}").get("decision"), "block")
    # 지난 차례에 "기다린다"고 넘긴 작업이 최종 보고 차례에도 실제로 돌고 있으면 다시 짚는다
    g = os.path.join(d, "t2.jsonl")
    with open(g, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(json.dumps(r, ensure_ascii=False) for r in base + [say("b1 기다립니다"), user("다 됐어?"), say("다 끝났습니다")]) + "\n")
    code, out = run_hook({"transcript_path": g, "stop_hook_active": False, "background_tasks": [{"id": "b1"}]})
    check("훅: 지난 차례 작업이 최종 보고 때도 돌면 막음", json.loads(out or "{}").get("decision"), "block")
    code, out = run_hook({"transcript_path": g, "stop_hook_active": False, "background_tasks": []})
    check("훅: 그 작업이 실제로 끝났으면 통과", (code, out), (0, ""))
    code, out = run_hook({"transcript_path": g, "stop_hook_active": False})
    check("훅: 목록 없는 옛 판은 이번 차례만(통과)", (code, out), (0, ""))
    code, out = run_hook({"transcript_path": f, "stop_hook_active": False, "background_tasks": [{"taskId": "다른모양"}]})
    check("훅: 목록 모양을 못 읽으면 이번 차례 기록 판정으로(막음)", json.loads(out or "{}").get("decision"), "block")
    # 화학 사건 ②: 목록(올바른 모양)에 다른 작업(보조)만 있고 우리 id 는 없음 → 목록을 믿고 통과(예전엔 기록 판정으로 되돌아가 유령으로 막음)
    h = os.path.join(d, "chem.jsonl")
    with open(h, "w", encoding="utf-8", newline="\n") as fh:  # 끝 알림이 없는 기록(알림 흡수 고침과 무관하게 목록만으로 판정되는지)
        fh.write("\n".join(json.dumps(r, ensure_ascii=False) for r in chem + [say("긴 보고")]) + "\n")
    sub_only = [{"id": "a59c1f0e2b7d4c3a1", "type": "subagent", "status": "running", "description": "Chapter 5 chapter-wide critique", "agent_type": "general-purpose"}]
    code, out = run_hook({"transcript_path": h, "stop_hook_active": False, "background_tasks": sub_only})
    check("훅: 목록에 다른 작업만 있고 우리 id 없음 → 통과(목록을 믿음)", (code, out), (0, ""))
    code, out = run_hook({"transcript_path": h, "stop_hook_active": False, "background_tasks": sub_only + [{"id": "bq2r9bcp9", "type": "shell", "status": "running"}]})
    check("훅: 목록에 우리 id 도 있으면 막음", json.loads(out or "{}").get("decision"), "block")
    code, out = run_hook({"transcript_path": h, "stop_hook_active": False, "background_tasks": [{"id": "bq2r9bcp9", "type": "shell", "status": "completed"}]})
    check("훅: 목록에 있어도 상태가 끝(completed)이면 통과", (code, out), (0, ""))
    code, out = run_hook({"transcript_path": f, "stop_hook_active": True})
    check("훅: 이미 한 번 막았으면 통과", (code, out), (0, ""))
    code, out = run_hook({"transcript_path": os.path.join(d, "없음.jsonl")})
    check("훅: 기록 없음 → 조용히 통과", (code, out), (0, ""))
    p = subprocess.run([sys.executable, os.path.join(HERE, "bg-leftover-guard.py")], input=b"not json", capture_output=True, timeout=30)
    check("훅: 깨진 입력 → 통과", (p.returncode, p.stdout.strip()), (0, b""))

if len(sys.argv) > 1:
    with open(sys.argv[1], encoding="utf-8", errors="replace") as fh:
        print("실제 기록 판정(읽기 전용):", G.pending(fh))

print("FAIL %d" % fails if fails else "ALL PASS")
sys.exit(1 if fails else 0)
