# -*- coding: utf-8 -*-
"""agy-hook-bridge 시험 — 실제 가드 둘을 그대로 부른다(파일 · 프로세스는 건드리지 않는다: 가드는 판정만 한다).
실행: python agy-hook-bridge.test.py   (모두 통과하면 'N/N PASS')

어느 영혼에서도 돌도록 가드와 같은 규칙으로 IRIS 루트를 정하고(IRIS_ROOT 환경변수 → 시스템 드라이브),
실제 폴더 목록에서 「실존하는 최상위 폴더」 하나를 골라 쓴다. 그런 폴더가 없으면 건너뛴다.
"""
import json
import os
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "agy-hook-bridge.py")
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
GHOST = os.path.join(IRIS_ROOT, "R07-開発者")           # 한자가 든 유령 폴더(만들지 않는다)
HOME = os.path.expanduser("~")
OUTSIDE = os.path.join(tempfile.gettempdir(), "agy-hook-bridge-test", "ok.txt")   # IRIS 밖(만들지 않는다)
PROBE = os.path.join(IRIS_ROOT, "agy-hook-probe.txt")  # IRIS 루트의 새 낱개 파일(만들지 않는다)
print(f"IRIS_ROOT={IRIS_ROOT}  실존 최상위={tops[0]}")


def fwd(p):
    return p.replace("\\", "/")


def wrapped(s):
    """실제 판은 인수 값을 JSON 글자로 한 겹 싸서 보낸다."""
    return json.dumps(s, ensure_ascii=False)


def ask(obj, raw=None):
    data = raw if raw is not None else json.dumps(obj, ensure_ascii=False).encode("utf-8")
    r = subprocess.run([sys.executable, BRIDGE], input=data, capture_output=True, timeout=120)
    return json.loads(r.stdout.decode("utf-8").strip().splitlines()[-1])


def call(name, args, ws=(TOP,)):
    return {"toolCall": {"name": name, "args": args}, "workspacePaths": list(ws), "conversationId": "t"}


CASES = [
    ("한자 폴더 쓰기 = 막음", call("write_to_file", {"TargetFile": os.path.join(GHOST, "x.md"), "CodeContent": "x"}), "deny"),
    ("정상 폴더 쓰기 = 통과", call("write_to_file", {"TargetFile": os.path.join(TOP, "AGENTS.md")}), "allow"),
    ("한자 폴더 편집 = 막음", call("replace_file_content", {"TargetFile": os.path.join(GHOST, "y.md")}), "deny"),
    ("node 일괄 종료 = 막음", call("run_command", {"CommandLine": "taskkill /IM node.exe /F", "Cwd": HOME}), "deny"),
    ("Get-Process node | Stop-Process = 막음", call("run_command", {"CommandLine": "Get-Process node | Stop-Process", "Cwd": HOME}), "deny"),
    ("한자 폴더 mkdir = 막음", call("run_command", {"CommandLine": "mkdir " + GHOST, "Cwd": IRIS_ROOT}), "deny"),
    ("평범한 명령 = 통과", call("run_command", {"CommandLine": "git status", "Cwd": TOP}), "allow"),
    ("모르는 도구 = 통과", call("view_file", {"AbsolutePath": os.path.join(IRIS_ROOT, "AGENTS.md")}), "allow"),
    # 실제 판의 이름(문서와 다름) · 인수 값은 JSON 글자로 한 겹 싸여 온다
    ("실제 이름 write_file · 루트 낱개 파일 = 막음", call("write_file", {"Path": wrapped(fwd(PROBE)), "Content": wrapped("x")}), "deny"),
    ("실제 이름 write_file · IRIS 밖 = 통과", call("write_file", {"Path": wrapped(fwd(OUTSIDE)), "Content": wrapped("ok")}), "allow"),
    ("실제 이름 edit_file · 한자 폴더 = 막음", call("edit_file", {"Path": wrapped(os.path.join(GHOST, "a.md"))}), "deny"),
    ("실제 이름 read_file = 통과", call("read_file", {"Path": wrapped(fwd(os.path.join(IRIS_ROOT, "AGENTS.md")))}), "allow"),
    ("이름이 또 바뀐 쓰기 도구(write 가 든 이름) · 한자 폴더 = 막음", call("fs_write_v2", {"Path": os.path.join(GHOST, "b.md")}), "deny"),
    ("이름이 바뀐 쓰기 도구 · 경로를 못 찾음 = 막음", call("delete_path", {"Target": os.path.join(IRIS_ROOT, "x")}), "deny"),
    ("도구 이름 없음 = 막음", {"toolCall": {"args": {"CommandLine": "echo"}}}, "deny"),
    ("toolCall 없음 = 막음", {"workspacePaths": [IRIS_ROOT]}, "deny"),
    ("인수 이름 모름 = 막음(조용히 통과시키지 않음)", call("write_to_file", {"Weird": os.path.join(GHOST, "x")}), "deny"),
    ("명령 글 없음 = 막음", call("run_command", {"Cwd": IRIS_ROOT}), "deny"),
    ("인수 모양이 이상함 = 막음", call("run_command", ["x"]), "deny"),
    ("JSON 으로 한 겹 싼 명령도 가드가 봄", call("run_command", {"CommandLine": wrapped("taskkill /IM node.exe /F"), "Cwd": HOME}), "deny"),
    ("JSON 으로 한 겹 싼 평범한 명령 = 통과", call("run_command", {"CommandLine": wrapped("echo hi"), "Cwd": HOME}), "allow"),
]


def main():
    ok = 0
    for title, obj, want in CASES:
        got = ask(obj).get("decision")
        print(("PASS " if got == want else "FAIL ") + f"{title} (원함 {want}, 받음 {got})")
        ok += got == want
    for title, raw in [("깨진 입력 = 막음", b"{not json"), ("빈 입력 = 막음", b"")]:
        got = ask(None, raw).get("decision")
        print(("PASS " if got == "deny" else "FAIL ") + title)
        ok += got == "deny"
    total = len(CASES) + 2
    print(f"{ok}/{total} PASS")
    sys.exit(0 if ok == total else 1)


if __name__ == "__main__":
    main()
