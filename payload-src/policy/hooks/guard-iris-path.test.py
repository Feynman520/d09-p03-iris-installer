# -*- coding: utf-8 -*-
"""guard-iris-path.py 시험. 실행: python guard-iris-path.test.py

어느 영혼에서도 돌도록 실제 폴더 목록에서 「실존하는 최상위 폴더」 하나를 골라 쓴다.
가드와 같은 규칙으로 IRIS 루트를 정한다(IRIS_ROOT 환경변수 → 시스템 드라이브).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PY = sys.executable
SCRIPT = str(Path(__file__).resolve().with_name("guard-iris-path.py"))
IRIS_ROOT = os.environ.get("IRIS_ROOT") or os.path.join(
    os.environ.get("SystemDrive", "C:") + os.sep, "IRIS"
)

EXEMPT = {"_trash", "_agent"}
tops = [
    d for d in sorted(os.listdir(IRIS_ROOT))
    if os.path.isdir(os.path.join(IRIS_ROOT, d)) and d.lower() not in EXEMPT and not d.startswith(".")
] if os.path.isdir(IRIS_ROOT) else []
if not tops:
    print(f"SKIP: {IRIS_ROOT} 아래에 검사에 쓸 실존 최상위 폴더가 없습니다.")
    sys.exit(0)
TOP = os.path.join(IRIS_ROOT, tops[0])
MISSING_TOP = os.path.join(IRIS_ROOT, "R77-없음(None)")
GHOST = os.path.join(IRIS_ROOT, "R07-開発者(Developer)", "D06-オープンソース(Open Source)")
print(f"IRIS_ROOT={IRIS_ROOT}  실존 최상위={tops[0]}")

cases = [
    # (name, expect_deny, tool, input)
    ("차단: 유령 일본어 Write", True, "Write", {"file_path": os.path.join(GHOST, "verify-fix.mjs"), "content": "x"}),
    ("차단: 유령 일본어 Bash cd", True, "Bash",
     {"command": 'cd "' + GHOST.replace("\\", "/") + '" && node -e "1"'}),
    ("차단: 유령 일본어 PowerShell cd", True, "PowerShell", {"command": 'cd "' + GHOST + '" ; node x.mjs'}),
    ("정상: 실존 최상위 아래 새 파일 Write", False, "Write", {"file_path": os.path.join(TOP, "새파일.md"), "content": "x"}),
    ("정상: 실존 최상위 아래 Edit", False, "Edit", {"file_path": os.path.join(TOP, "AGENTS.md"), "old_string": "a", "new_string": "b"}),
    ("정상: 실존 최상위 아래 새 서랍(코드 없는 폴더)", False, "Write", {"file_path": os.path.join(TOP, "검토(Review)", "새파일.html"), "content": "x"}),
    ("차단: 미실존 최상위 아래 Write", True, "Write", {"file_path": os.path.join(MISSING_TOP, "D01-x", "x.md"), "content": "x"}),
    ("차단: 실존 최상위 아래 미실존 P 코드 폴더 암묵 생성", True, "Write",
     {"file_path": os.path.join(TOP, "P99-없는 프로젝트(Nope)", "AGENTS.md"), "content": "x"}),
    ("차단: 그룹 접두 D 암묵 생성", True, "Write",
     {"file_path": os.path.join(TOP, "〖교양〗D99-없음(None)", "AGENTS.md"), "content": "x"}),
    ("정상: IRIS 루트 직접 파일", False, "Write", {"file_path": os.path.join(IRIS_ROOT, "새문서.md"), "content": "x"}),
    ("정상: IRIS 밖 경로", False, "Write", {"file_path": os.path.join(os.environ.get("TEMP", "."), "開発者.txt"), "content": "x"}),
    ("정상: _trash 안 일본어(격리물)", False, "Bash",
     {"command": 'rm -rf "' + os.path.join(IRIS_ROOT, "_trash", "R07-開発者(Developer)").replace("\\", "/") + '"'}),
    ("정상: _agent 안 경로", False, "Bash",
     {"command": 'grep -rl "開発者" "' + os.path.join(IRIS_ROOT, "_agent").replace("\\", "/") + '"'}),
    ("차단: Bash mkdir 일본어", True, "Bash",
     {"command": 'mkdir -p "' + os.path.join(IRIS_ROOT, "R07-開発者(Developer)", "D01").replace("\\", "/") + '"'}),
    ("차단: Bash mkdir 미실존 최상위 아래", True, "Bash",
     {"command": 'mkdir -p "' + os.path.join(MISSING_TOP, "D01-x") + '"'}),
    ("정상: 생성 동사 없는 조회(미실존 최상위)", False, "Bash", {"command": 'ls "' + os.path.join(MISSING_TOP, "D01-x") + '"'}),
    ("정상: 리다이렉션이지만 실존 경로", False, "Bash", {"command": 'echo hi > "' + os.path.join(TOP, "out.txt") + '"'}),
    ("정상: 새 최상위 mkdir 단독(명시적 생성)", False, "Bash", {"command": 'mkdir "' + os.path.join(IRIS_ROOT, "_newutil") + '"'}),
    ("정상: IRIS 언급 없는 명령", False, "Bash", {"command": "git status"}),
    ("정상: 깨진 JSON", False, None, None),
    ("차단: 이중 백슬래시 경로(명령 문자열 형태)", True, "PowerShell",
     {"command": 'New-Item -ItemType Directory "' + GHOST.replace("\\", "\\\\") + '"'}),
    ("정상: NotebookEdit 실존 경로", False, "NotebookEdit", {"notebook_path": os.path.join(TOP, "a.ipynb")}),
]

fails = 0
for name, expect_deny, tool, inp in cases:
    if tool is None:
        payload = b"{not json"
    else:
        payload = json.dumps({"tool_name": tool, "tool_input": inp}, ensure_ascii=False).encode("utf-8")
    r = subprocess.run([PY, SCRIPT], input=payload, capture_output=True, timeout=20)
    out = r.stdout.decode("utf-8", errors="replace").strip()
    denied = '"deny"' in out
    ok = (denied == expect_deny) and r.returncode == 0
    if not ok:
        fails += 1
    print(("PASS" if ok else "FAIL"), "|", "deny" if denied else "allow", "|", name)
    if not ok:
        print("   rc=", r.returncode, "out=", out[:300], "err=", r.stderr.decode("utf-8", "replace")[:300])
print("----", "FAILS:", fails, "/", len(cases))
sys.exit(1 if fails else 0)
