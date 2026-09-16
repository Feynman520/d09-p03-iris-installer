# -*- coding: utf-8 -*-
r"""PreToolUse guard: IRIS 경로 실존 가드 (전역 규칙).

배경: 에이전트가 한글 경로를 일본어/한자로 잘못 타이핑하면 쓰기 도구가 없는 중간 폴더를
조용히 만들어 유령 R/D/P 트리가 생긴다. 글로 된 규칙만으로는 막히지 않으므로
도구 실행 직전에 기계적으로 막는다.

검사 대상: Write · Edit · MultiEdit · NotebookEdit · Bash · PowerShell
차단 조건(IRIS 루트 아래 경로에 한해):
  A. 경로 어느 조각에든 한자·가나(일본어/중국어 문자)가 들어 있으면 차단.
     IRIS 폴더명은 한글·영어·숫자만 쓴다.
  B. IRIS 바로 아래 최상위 폴더가 실존하지 않는데 그 밑에 무언가를 쓰려 하면 차단.
     (Write/Edit류는 항상, Bash/PowerShell은 mkdir·cp·mv·리다이렉션 등 생성 동사가 있을 때만)
  C. Write/Edit류가 존재하지 않는 R/D/P/S/T 코드 폴더를 암묵적으로 만들려 하면 차단.
     새 위계 폴더는 mkdir로 명시적으로 만든 뒤에 써야 한다.
면제: `_trash`, `_agent` 아래 경로(격리물·세션 기록에는 유령 이름이 남아 있을 수 있음).

출력: 차단 시 hookSpecificOutput.permissionDecision=deny JSON 한 줄. 그 외 아무것도 출력하지 않는다.
오류가 나면 조용히 통과시킨다(가드가 정상 작업을 막아서는 안 된다).
"""
import json
import os
import re
import sys

# IRIS 루트. 설치 위치는 <시스템 드라이브>\IRIS로 고정이며, 시험용으로만 IRIS_ROOT로 덮어쓴다.
IRIS_ROOT = os.environ.get("IRIS_ROOT") or os.path.join(
    os.environ.get("SystemDrive", "C:") + os.sep, "IRIS"
)
EXEMPT_TOP = {"_trash", "_agent"}
CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿豈-﫿]")
CODE_DIR = re.compile(r"^(〖[^〗]*〗)?[RDPST]\d")
PATH_IN_TEXT = re.compile(
    r"(?:[A-Za-z]:[\\/]{1,4}IRIS|/[A-Za-z]/IRIS)[\\/]{1,4}([^\"'\r\n;|&<>]*)"
)
CREATE_VERBS = re.compile(
    r"(?i)(\bmkdir\b|\bmd\b|New-Item|\bni\b|\bmv\b|\bcp\b|Move-Item|Copy-Item|Rename-Item|"
    r"\brobocopy\b|\bxcopy\b|Out-File|Set-Content|Add-Content|\btee\b|>|\btouch\b|\brsync\b|\bmove\b|\bcopy\b|\bren\b)"
)
EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "PowerShell"}


def norm_rel(raw: str):
    r"""`<드라이브>:\IRIS\a\b` 또는 `/c/IRIS/a/b` → ['a', 'b'] (IRIS 상대 조각). IRIS 밖이면 None."""
    s = raw.replace("/", "\\")
    s = re.sub(r"\\{2,}", "\\\\", s)
    m = re.match(r"(?i)^(?:[A-Za-z]:\\IRIS|\\[A-Za-z]\\IRIS)(?:\\(.*))?$", s)
    if not m:
        return None
    rest = m.group(1) or ""
    return [seg.strip() for seg in rest.split("\\") if seg.strip()]


def deny(reason: str):
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    # 윈도 콘솔(cp949)에서 한글이 깨지지 않도록: UTF-8로 재설정하고 JSON은 ASCII 이스케이프로 내보낸다.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.stdout.write(json.dumps(out, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def check(tool: str, segs, is_edit: bool, has_create_verb: bool, shown: str):
    if not segs:
        return None
    if segs[0].lower() in EXEMPT_TOP:
        return None
    # A. 한자·가나
    for seg in segs:
        if CJK.search(seg):
            return (
                "BLOCKED - IRIS 경로 실존 가드: 경로에 한자·가나(일본어/중국어 문자)가 들어 있습니다: "
                f"'{shown}'. IRIS 폴더명은 한글·영어만 씁니다. 이 경로는 실존하는 한글 경로를 잘못 번역해 "
                "지어낸 것일 가능성이 매우 높습니다. 실제 디렉터리 목록(ls)에서 정확한 이름을 복사해 다시 시도하세요. "
                "(BLOCKED: kanji/kana in an IRIS path - the folder name was almost certainly hallucinated. "
                "Copy the exact existing Korean folder name from a directory listing.)"
            )
    dir_segs = segs[:-1] if is_edit else segs
    if len(segs) < 2:
        return None
    top = segs[0]
    top_exists = os.path.isdir(os.path.join(IRIS_ROOT, top))
    # B. 최상위 폴더 미실존
    if not top_exists and (is_edit or has_create_verb):
        return (
            f"BLOCKED - IRIS 경로 실존 가드: {os.path.join(IRIS_ROOT, top)} 은(는) 존재하지 않는 최상위 폴더인데 그 밑에 쓰려 합니다: "
            f"'{shown}'. 폴더명을 기억으로 타이핑하지 말고 `ls {IRIS_ROOT}`로 실제 이름을 복사해 다시 시도하세요. "
            "정말 새 최상위 폴더가 필요하면 먼저 mkdir로 그 폴더 하나만 명시적으로 만든 뒤 쓰세요. "
            f"(BLOCKED: writing under a non-existent top-level IRIS folder. Copy the exact existing name from `ls {IRIS_ROOT}`.)"
        )
    # C. Write/Edit가 없는 R/D/P/S/T 코드 폴더를 암묵 생성
    if is_edit and top_exists:
        cur = IRIS_ROOT
        for seg in dir_segs:
            cur = os.path.join(cur, seg)
            if not os.path.isdir(cur):
                if CODE_DIR.match(seg):
                    return (
                        f"BLOCKED - IRIS 경로 실존 가드: 존재하지 않는 위계 폴더 '{seg}'를 Write/Edit가 암묵적으로 만들려 합니다: "
                        f"'{shown}'. 가장 가까운 실존 조상은 '{os.path.dirname(cur)}' 입니다. 이름 오타면 실제 목록에서 복사하고, "
                        "정말 새 R/D/P/S/T 폴더가 필요하면 먼저 mkdir로 명시적으로 만든 뒤(AGENTS.md 동반) 쓰세요. "
                        "(BLOCKED: Write would implicitly create a non-existent R/D/P/S/T folder. mkdir it explicitly first.)"
                    )
                break
    return None


def main():
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        j = json.loads(raw)
    except Exception:
        return
    tool = j.get("tool_name") or ""
    inp = j.get("tool_input") or {}
    if tool in EDIT_TOOLS:
        p = inp.get("file_path") or inp.get("notebook_path") or ""
        segs = norm_rel(p)
        if segs is None:
            return
        r = check(tool, segs, True, False, p)
        if r:
            deny(r)
        return
    if tool in SHELL_TOOLS:
        cmd = inp.get("command") or ""
        if "IRIS" not in cmd.upper():
            return
        has_verb = bool(CREATE_VERBS.search(cmd))
        for m in PATH_IN_TEXT.finditer(cmd):
            whole = m.group(0)
            segs = norm_rel(whole)
            if not segs:
                continue
            r = check(tool, segs, False, has_verb, whole.strip())
            if r:
                deny(r)
                return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
