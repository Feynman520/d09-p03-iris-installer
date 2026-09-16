# -*- coding: utf-8 -*-
"""block-blanket-kill.ps1 시험. 실행: python block-blanket-kill.test.py

스크립트 경로는 이 파일 옆에서 찾는다(어느 PC의 어느 폴더에 놓여도 동작).
포트 3456·3458이 비어 있으면 PID 기반 사례는 건너뛴다.
"""
import json
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
SCRIPT = str(Path(__file__).resolve().with_name("block-blanket-kill.ps1"))
PS = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT]


def owner(port):
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"(Get-NetTCPConnection -LocalPort {port} -State Listen -EA SilentlyContinue | Select -First 1).OwningProcess"],
        capture_output=True, text=True)
    s = r.stdout.strip()
    return int(s) if s.isdigit() else None


daemon = owner(3458)
proxy = owner(3456)
dash = owner(3457)
print(f"protected now: daemon(3458)={daemon} proxy(3456)={proxy} dash(3457)={dash}")
live = bool(daemon and proxy)
if not live:
    print("SKIP: daemon or proxy not running - PID cases cannot be exercised")
FREE = 999111  # not a real pid
D = daemon or FREE
P = proxy or FREE

cases = [
    # (name, expect_deny, tool, command, needs_live)
    # A) 이름 기반 일괄 종료
    ("A 차단: taskkill /IM node.exe", True, "Bash", "taskkill /IM node.exe /F", False),
    ("A 차단: Stop-Process -Name node", True, "PowerShell", "Stop-Process -Name node -Force", False),
    ("A 차단: Get-Process node | Stop-Process", True, "PowerShell", "Get-Process node | Stop-Process -Force", False),
    ("A 차단: pkill node", True, "Bash", "pkill -f node", False),
    ("A 차단: taskkill /IM electron.exe", True, "Bash", "taskkill /F /IM electron.exe", False),
    # B) 기반 시설 PID 종료
    ("B 차단: Stop-Process -Id <데몬 PID>", True, "PowerShell", f"Stop-Process -Id {D} -Force; Start-Sleep 1; node daemon/server.mjs", False),
    ("B 차단: taskkill /PID <데몬 PID> /T /F", True, "Bash", f"taskkill /PID {D} /T /F", True),
    ("B 차단: kill <중계기 PID>", True, "Bash", f"kill -9 {P}", True),
    ("B 차단: Stop-Process -Id <중계기 PID>", True, "PowerShell", f"Stop-Process -Id {P}", True),
    ("B 차단: 포트로 PID 구해 죽이기(3458)", True, "PowerShell",
     "Get-NetTCPConnection -LocalPort 3458 -State Listen | Select -Expand OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }", False),
    ("B 차단: 포트로 PID 구해 죽이기(3456, netstat)", True, "Bash",
     "netstat -ano | grep :3456 | awk '{print $5}' | xargs taskkill /F /PID", False),
    ("B 차단: daemon.pid 파일로 죽이기", True, "PowerShell", "Stop-Process -Id (Get-Content state\\daemon.pid) -Force", False),
    ("B 차단: CommandLine으로 데몬 찾아 죽이기", True, "PowerShell",
     "Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'daemon\\\\server.mjs' } | % { Stop-Process -Id $_.ProcessId }", False),
    ("B 차단: CommandLine으로 중계기 찾아 죽이기", True, "PowerShell",
     "Get-CimInstance Win32_Process | Where-Object CommandLine -like '*teamclaude*' | ForEach-Object { taskkill /PID $_.ProcessId /F }", False),
    ("B 차단: POST /api/shutdown (전 세션 종료)", True, "Bash", "curl -s -X POST http://127.0.0.1:3458/api/shutdown", False),
    ("B 차단: node fetch /api/shutdown", True, "Bash", "node -e \"fetch('http://127.0.0.1:3458/api/shutdown',{method:'POST'})\"", False),
    ("B 차단: process.kill(데몬 PID)", True, "Bash", f"node -e \"process.kill({D})\"", True),
    # 통과해야 하는 것
    ("정상: 내가 띄운 PID 종료(보호 아님)", False, "PowerShell", f"Stop-Process -Id {FREE} -Force", False),
    ("정상: taskkill /PID 보호 아닌 PID", False, "Bash", f"taskkill /PID {FREE} /T /F", False),
    ("정상: 3458 헬스 조회(킬 없음)", False, "Bash", "curl -s http://127.0.0.1:3458/api/health", False),
    ("정상: 포트 소유자 조회만", False, "PowerShell", "Get-NetTCPConnection -LocalPort 3458 -State Listen | Select OwningProcess", False),
    ("정상: daemon.pid 읽기만", False, "PowerShell", "Get-Content state\\daemon.pid", False),
    ("정상: 데몬 PID를 숫자로 언급만(킬 없음)", False, "Bash", f"echo daemon pid is {D}", False),
    ("정상: git status", False, "Bash", "git status", False),
    ("정상: 세션 1개 닫기 API(DELETE, PID 기준)", False, "Bash", "curl -s -X DELETE http://127.0.0.1:3458/api/sessions/s3", False),
    ("정상: 깨진 JSON", False, None, None, False),
]
fails = 0
skipped = 0
for name, expect_deny, tool, command, needs_live in cases:
    if needs_live and not live:
        skipped += 1
        print("SKIP |", name)
        continue
    if tool is None:
        payload = b"{not json"
    else:
        payload = json.dumps({"tool_name": tool, "tool_input": {"command": command}}, ensure_ascii=False).encode("utf-8")
    r = subprocess.run(PS, input=payload, capture_output=True, timeout=60)
    out = r.stdout.decode("utf-8", errors="replace").strip()
    denied = '"permissionDecision":"deny"' in out.replace(" ", "")
    ok = denied == expect_deny
    fails += (not ok)
    print(("PASS" if ok else "FAIL"), "|", name, "|", "deny" if denied else "allow")
    if not ok:
        print("   cmd:", command)
        print("   out:", out[:300])
        print("   err:", r.stderr.decode("utf-8", "replace")[:300])
print(f"\n{len(cases) - fails - skipped}/{len(cases) - skipped} passed ({skipped} skipped)")
sys.exit(1 if fails else 0)
