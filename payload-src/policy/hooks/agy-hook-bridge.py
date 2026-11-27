"""agy-hook-bridge — Antigravity(agy) 의 PreToolUse 훅을 IRIS 안전 가드 둘에 잇는 다리.

왜: 클로드 · 코덱스는 guard-iris-path.py(경로 가드)와 block-blanket-kill.ps1(일괄 종료 가드)을 훅으로 쓴다.
    Antigravity 는 입력 · 출력 모양이 달라 그대로 못 붙인다 → 이 다리가 모양만 바꿔 가드를 **무수정으로** 부른다.
등록: 설치기는 이 파일을 가드 둘 옆에 **놓기만** 한다 — 클로드 · 코덱스의 훅 설정에도, Antigravity 의 훅 설정에도 넣지 않는다.
      Antigravity 의 훅 설정에 이 다리를 `iris-safety` 항목으로 두는 것은 IRIS 창이고, 그 기능이 열린 PC 에서 세션을 열 때만 한다.

입력(stdin, agy): {"toolCall":{"name":"run_command","args":{"CommandLine":"…","Cwd":"…"}}, "workspacePaths":[…], …}
바꿈: run_command → 클로드 PowerShell 도구(command · cwd) / write_to_file → Write / replace_file_content · multi_replace_file_content → Edit
출력(stdout, agy): 가드가 막으면 {"decision":"deny","reason":"…"}, 아니면 {"decision":"allow"}.
고장 나면 **막는다**: Antigravity 세션은 권한을 묻지 않고 돌 수 있으므로, 다리가 조용히 통과시키면 방어가 사라진다.
   막는 경우 = 입력 해석 실패 · 인수 이름을 모름(대상 경로 · 명령을 못 찾음) · 가드 파일 없음 · 가드 실행 실패(시간 초과 포함).
   클로드 · 코덱스의 원래 가드는 그대로다(실패 시 통과) — 다리만 엄격하다.
   모르는 도구 이름 = 통과(가드 대상이 아님). 모르는 인수 이름은 _agent/claude/state/agy-hook-bridge.log 에 이름만 한 줄 남긴다(내용 · 경로는 적지 않음).
자리: 가드 둘과 같은 폴더(<IRIS 루트>/_agent/claude/scripts)에 있어야 한다 — 이 파일의 자리에서 가드와 기록 파일을 찾는다.
시험 = 같은 이름 .test.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
IRIS = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
GUARD_PATH = os.path.join(HERE, "guard-iris-path.py")
GUARD_KILL = os.path.join(HERE, "block-blanket-kill.ps1")
LOG = os.path.join(IRIS, "_agent", "claude", "state", "agy-hook-bridge.log")

# 도구 이름은 공식 문서(write_to_file · replace_file_content)와 실제 판(write_file · edit_file)이 다를 수 있다
# (문서의 이름에만 훅을 걸었더니 훅이 불리지 않아 루트에 낱개 파일이 새로 생긴 일이 있었다). 그래서 훅은 모든 도구에 걸고(matcher ".*"),
# 여기서 이름으로 가른다: 명령 = run_command, 파일 쓰기 = 이름에 write · edit · replace · create · delete · move 가 든 도구(이름이 또 바뀌어도 잡게).
SHELL = {"run_command"}
WRITE = {"write_to_file", "write_file", "create_file"}
EDIT = {"replace_file_content", "multi_replace_file_content", "edit_file"}
FILE_WORDS = ("write", "edit", "replace", "create", "delete", "move", "rename", "patch")
READ_ONLY = {"read_file", "view_file", "list_dir", "find_by_name", "grep_search", "search_web", "read_url_content", "manage_task", "schedule",
             "list_permissions", "ask_permission", "invoke_subagent", "define_subagent", "manage_subagents", "send_message", "ask_question",
             "generate_image", "run_workflow", "swarm", "query", "domain"}


def kind_of(name):
    if name in SHELL:
        return "shell"
    if name in WRITE:
        return "write"
    if name in EDIT:
        return "edit"
    if name in READ_ONLY:
        return None
    low = name.lower()
    if any(w in low for w in FILE_WORDS):
        return "edit"
    return None
PATH_KEYS = ("TargetFile", "targetFile", "target_file", "AbsolutePath", "absolutePath", "FilePath", "filePath", "file_path", "Path", "path")


def note(msg):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8", newline="\n") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def unwrap(v):
    """도구 인수 값이 JSON 글자로 한 겹 더 싸여 오는 경우("\\"echo hi\\"")를 벗긴다."""
    if isinstance(v, str) and v[:1] == '"':
        try:
            w = json.loads(v)
            if isinstance(w, str):
                return w
        except Exception:
            pass
    return v


def to_claude(j):
    """agy 입력 → (클로드 훅 입력 dict, 부를 가드 목록). 가드 대상이 아니면 (None, []), 대상인데 못 읽으면 ("bad", 이유)."""
    call = j.get("toolCall")
    if not isinstance(call, dict) or not isinstance(call.get("name"), str) or not call.get("name"):
        # 도구 이름을 못 읽으면 입력 모양이 바뀐 것이므로 막는다
        return "bad", "도구 이름을 읽지 못함(입력 모양이 바뀌었을 수 있음)"
    name = call["name"]
    args = call.get("args")
    kind = kind_of(name)
    if kind is None:
        return None, []
    if not isinstance(args, dict):
        return "bad", name + ": 인수 모양을 읽지 못함"
    args = {k: unwrap(v) for k, v in args.items()}
    ws = j.get("workspacePaths") or []
    cwd = args.get("Cwd") or args.get("cwd") or (ws[0] if ws and isinstance(ws[0], str) else "")
    if kind == "shell":
        cmd = args.get("CommandLine") or args.get("commandLine") or args.get("command") or ""
        if not isinstance(cmd, str) or not cmd:
            note("run_command: no command key: " + ",".join(sorted(args.keys())))
            return "bad", "run_command: 명령 글을 찾지 못함"
        return {"tool_name": "PowerShell", "tool_input": {"command": cmd}, "cwd": cwd}, [GUARD_PATH, GUARD_KILL]
    if kind in ("write", "edit"):
        p = next((args[k] for k in PATH_KEYS if isinstance(args.get(k), str) and args.get(k)), "")
        if not p:
            note(name + ": no path key: " + ",".join(sorted(args.keys())))
            return "bad", name + ": 대상 파일 경로를 찾지 못함"
        return {"tool_name": "Write" if kind == "write" else "Edit", "tool_input": {"file_path": p}, "cwd": cwd}, [GUARD_PATH]
    return None, []


class GuardError(Exception):
    pass


def run_guard(script, payload):
    """가드 하나를 부르고, 막았으면 이유 글자를, 아니면 None 을 돌려준다. 가드를 돌리지 못하면 GuardError."""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if script.endswith(".ps1"):
        argv = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
    else:
        argv = [sys.executable, script]
    try:
        # 가드 둘을 차례로 돌려도 훅 제한(30초) 안에 deny 를 낼 수 있게 하나당 12초
        r = subprocess.run(argv, input=data, capture_output=True, timeout=12, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception as e:
        raise GuardError(os.path.basename(script) + " 실행 실패: " + type(e).__name__)
    if r.returncode != 0:
        raise GuardError(os.path.basename(script) + " 종료 코드 " + str(r.returncode))
    out = (r.stdout or b"").decode("utf-8", errors="replace").strip()
    if not out:
        return None  # 가드의 '허용' = 아무것도 출력하지 않음(원래 계약)
    for line in out.splitlines()[::-1]:
        try:
            o = json.loads(line)
        except Exception:
            continue
        h = (o.get("hookSpecificOutput") or {}) if isinstance(o, dict) else {}
        if h.get("permissionDecision") == "deny":
            return h.get("permissionDecisionReason") or "IRIS 안전 가드가 막았습니다."
        if isinstance(o, dict):
            return None  # 읽을 수 있는 다른 JSON = 막지 않음
    raise GuardError(os.path.basename(script) + " 출력을 읽지 못함")


BLOCK = "IRIS 안전 다리(agy-hook-bridge)가 이 도구 호출을 확인하지 못해 막았습니다 — "


def main():
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        j = json.loads(raw)
        if not isinstance(j, dict):
            raise ValueError("not object")
    except Exception:
        return {"decision": "deny", "reason": BLOCK + "입력을 읽지 못함"}
    payload, guards = to_claude(j)
    if payload == "bad":
        return {"decision": "deny", "reason": BLOCK + guards}
    for g in guards:
        if not os.path.exists(g):
            return {"decision": "deny", "reason": BLOCK + os.path.basename(g) + " 없음"}
        try:
            reason = run_guard(g, payload)
        except GuardError as e:
            return {"decision": "deny", "reason": BLOCK + str(e)}
        if reason:
            return {"decision": "deny", "reason": reason}
    return {"decision": "allow"}


if __name__ == "__main__":
    try:
        res = main()
    except Exception as e:
        res = {"decision": "deny", "reason": BLOCK + type(e).__name__}
    sys.stdout.write(json.dumps(res, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    sys.exit(0)
