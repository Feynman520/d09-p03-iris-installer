# -*- coding: utf-8 -*-
"""guard-iris-path.py 시험. 실행: python guard-iris-path.test.py

어느 영혼에서도 돌도록 실제 폴더 목록에서 「실존하는 최상위 폴더」 하나를 골라 쓴다.
가드와 같은 규칙으로 IRIS 루트를 정한다(IRIS_ROOT 환경변수 → 시스템 드라이브).
"""
import json
import os
import subprocess
import sys
import tempfile
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
    ("차단(D): IRIS 루트 새 낱개 파일 Write", True, "Write", {"file_path": os.path.join(IRIS_ROOT, "새문서-가드시험.md"), "content": "x"}),
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

# --- 규칙 D: IRIS 루트 낱개 파일 --- 다섯째 칸 = 훅이 받는 cwd(없으면 cwd 를 보내지 않는다)
SCR = os.path.join(tempfile.gettempdir(), "guard-iris-path-test")  # IRIS 밖 임시 폴더(만들지 않는다, 이름만 쓴다)
R = IRIS_ROOT
RU = IRIS_ROOT.replace("\\", "/")
TOPU = TOP.replace("\\", "/")
cases += [
    ("차단(D): cd 루트 후 curl -o(줄 이어쓰기)", True, "Bash",
     {"command": f'cd "{RU}" && BASE="https://example.com"\ncurl -fsS --get "${{BASE}}/v1/search" \\\n  --data-urlencode \'q=1\' -o result_tmp.json\nls -la result_tmp.json'}, SCR),
    ("차단(D): for 루프 curl -o 변수 파일명", True, "Bash",
     {"command": f'cd "{RU}" && for kw in a b; do\n  curl -fsS "$B/v1/x?q=${{kw}}" -o "kw_${{kw}}.json"\ndone'}, SCR),
    ("차단(D): cwd 루트에서 리다이렉션", True, "Bash", {"command": "echo hi > notes.txt"}, R),
    ("차단(D): cwd 루트에서 curl -O(원격 이름)", True, "Bash", {"command": "curl -fsSLO https://example.com/a.zip"}, R),
    ("차단(D): cp 목적지가 루트 폴더", True, "Bash", {"command": f"cp /tmp/a.json {RU}/"}, SCR),
    ("차단(D): PowerShell Invoke-WebRequest -OutFile (cwd 루트)", True, "PowerShell", {"command": "Invoke-WebRequest https://a.b/c -OutFile c.json"}, R),
    ("차단(D): PowerShell Set-Content 루트 절대경로", True, "PowerShell", {"command": f"Set-Content -Path {os.path.join(R, 'x-guard.txt')} -Value 1 -Encoding utf8"}, SCR),
    ("차단(D): heredoc 파이썬 open(w) (cd 루트)", True, "Bash",
     {"command": f"cd \"{RU}\" && PYTHONUTF8=1 python - <<'EOF'\nimport json\nif 3 > 2: pass\njson.dump({{}}, open('out.json','w'))\nEOF"}, SCR),
    ("차단(D): node -e writeFileSync (cwd 루트)", True, "Bash", {"command": "node -e \"require('fs').writeFileSync('x.json','1')\""}, R),
    ("정상(D): cwd 루트 → /dev/null·2>&1", False, "Bash", {"command": "python x.py > /dev/null 2>&1"}, R),
    ("정상(D): cwd 루트 → 하위 폴더로 저장", False, "Bash", {"command": "python _ontology/build_graph.py --compile > _ontology/log.txt"}, R),
    ("정상(D): heredoc 안 > 비교만", False, "Bash", {"command": f"cd \"{RU}\" && python - <<'EOF'\nprint(3 > 2)\nEOF"}, SCR),
    ("정상(D): 허용 이름 새 루트 문서 IRIS-*", False, "Write", {"file_path": os.path.join(R, "IRIS-새문서.md"), "content": "x"}, SCR),
    ("정상(D): cd 하위 폴더 후 상대 저장", False, "Bash", {"command": f'cd "{TOPU}" && echo x > a.txt'}, SCR),
    ("정상(D): cwd 스크래치 상대 저장(IRIS 언급 있음)", False, "Bash", {"command": f"grep -r x {RU}/_ontology > hits.txt"}, SCR),
    ("정상(D): PowerShell 2>$null (cwd 루트)", False, "PowerShell", {"command": "Get-ChildItem x 2>$null"}, R),
    ("정상(D): grep 패턴 속 open(w) — 인터프리터 아님", False, "Bash", {"command": "grep -n 'open(\"a\",\"w\")' x.py"}, R),
    ("정상(D): Out-File 하위 폴더 절대경로", False, "PowerShell", {"command": "$x | Out-File " + os.path.join(TOP, "a.txt") + " -Encoding utf8"}, SCR),
    ("정상(D): New-Item 디렉터리(루트 새 유틸 폴더)", False, "PowerShell", {"command": f"New-Item -ItemType Directory {os.path.join(R, '_newutil')}"}, SCR),
    ("정상(D): cwd 루트 → 스크래치 절대경로 저장", False, "Bash", {"command": "curl -fsS https://a.b -o " + SCR.replace("\\", "/") + "/a.json"}, R),
    ("정상(D): cwd 루트 → cd 스크래치 후 상대 저장", False, "Bash", {"command": 'cd "' + SCR + '" && echo x > a.txt'}, R),
]
# 이미 있는 루트 파일이 하나라도 있으면(설치본은 AGENTS.md 가 있다) 덮어쓰기·덧붙이기는 통과해야 한다.
existing = [f for f in sorted(os.listdir(R)) if os.path.isfile(os.path.join(R, f))]
if existing:
    cases += [
        ("정상(D): 기존 루트 파일에 덧붙이기", False, "Bash", {"command": f'echo x >> "{RU}/{existing[0]}"'}, SCR),
        ("정상(D): 기존 루트 파일 Write 덮어쓰기", False, "Write", {"file_path": os.path.join(R, existing[0]), "content": "x"}, SCR),
    ]

fails = 0
for case in cases:
    name, expect_deny, tool, inp = case[:4]
    if tool is None:
        payload = b"{not json"
    else:
        body = {"tool_name": tool, "tool_input": inp}
        if len(case) > 4:
            body["cwd"] = case[4]
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
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
