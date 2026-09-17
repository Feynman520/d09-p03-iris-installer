# verify/vm/guest-elevate.ps1 -- runs INSIDE the VM guest.
#
# Saved as UTF-8 **with BOM** (IRIS rule R-004): the comments below are the
# 정본 for why this file exists, and Windows PowerShell 5.1 reads a BOM-less
# .ps1 as ANSI, which would turn them into noise. Everything the script
# actually *sends* is ASCII.
#
# The one hard fact this file exists for (measured 2026-09-15, Task 23d, and
# re-confirmed 2026-09-16, Task 23e):
#   **A VBoxManage guest-control session for an administrator is NOT elevated.**
#   UAC hands it the filtered token, there is no prompt anyone can click in a
#   headless VM, the built-in Administrator account is disabled on the eval
#   image ("account is restricted and can't be used to logon"), and
#   `schtasks /ru SYSTEM` / `Register-ScheduledTask -RunLevel Highest` are both
#   refused for the same reason. Nothing a guest-control session can say makes
#   Windows hand it a full token -- the elevation has to already exist.
#
# So there are three channels, and this file picks whichever the VM has:
#
#   [runas]  (2026-09-17, first choice) The bake left ConsentPromptBehaviorAdmin=0,
#            so `Start-Process -Verb RunAs` from the guest-control session gets
#            a High-integrity token WITHOUT any prompt (measured). Output is
#            written by the elevated shell into a file and echoed back.
#
#   [baked]  (IRIS-Win11-v2 and later -- the only one that actually works)
#            The unattended install baked a SYSTEM agent into the image
#            (verify/vm/bake.ps1, scheduled task "IRIS-VM-Agent"). It polls
#            C:\iris-vm\queue once a second. We drop a .job file there and wait
#            for the matching .done. The agent already has the SYSTEM token, so
#            nobody has to be elevated at request time.
#
#   [task]   (IRIS-Win11, the pre-bake base -- kept so the old VM still runs)
#            Register a scheduled task for the CURRENT user with -RunLevel
#            Highest and start it. On paper the task gets the account's full
#            token; in practice registering it was refused on the eval image
#            more often than not. Left in as a fallback, not as a promise.
#
# This is rig scaffolding only. The installer never needs any of it.
#
#   -Script <path to .ps1>   what to run elevated
#   -Arguments <string>      arguments for it (optional, ONE token, NO spaces --
#                            VBoxManage does not preserve argument grouping, so
#                            anything with a space arrives here in pieces)
#   -ArgumentsB64 <base64>   the same thing when it DOES need spaces (or Korean,
#                            or a password): base64 of the UTF-8 argument line.
#                            Base64 is `A-Za-z0-9+/=` only, so it survives both
#                            VBoxManage's splitting and cmd's quoting rules.
#   -Out <path>              file the elevated run writes; its content is echoed
#
# First line of output is always `ELEVATE-CHANNEL baked|task` so a run log says
# which door was used. Exit code 0 = the elevated run produced the file.

param(
  [Parameter(Mandatory = $true)][string]$Script,
  [string]$Arguments = '',
  [string]$ArgumentsB64 = '',
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $Script + '"'
if ($ArgumentsB64) {
  $argLine = $argLine + ' ' + [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsB64))
} elseif ($Arguments) {
  $argLine = $argLine + ' ' + $Arguments
}

$queue = Join-Path $env:SystemDrive 'iris-vm\queue'

function Show-Result {
  param([string]$AgentOut)
  if ($AgentOut -and (Test-Path -LiteralPath $AgentOut)) {
    # 대리인이 걷은 표준출력은 진단용이다 -- 판정이 읽는 것은 $Out 쪽이다.
    Get-Content -LiteralPath $AgentOut -ErrorAction SilentlyContinue |
      ForEach-Object { Write-Output ('AGENT-STDOUT ' + $_) }
  }
  if (Test-Path -LiteralPath $Out) {
    Get-Content -LiteralPath $Out | ForEach-Object { Write-Output $_ }
    exit 0
  }
  Write-Output 'ELEVATED-RUN-NO-RESULT'
  exit 1
}

# --- [runas] 프롬프트 없는 자기 승격 ------------------------------------------
# 2026-09-17 실측(VM S07·S03·S04·S05): 구운 SYSTEM 대리인 작업(IRIS-VM-Agent)은 굽던 순간
# 한 번 뜬 뒤 재부팅·스냅샷 복원 뒤에는 다시 서지 않았다(schtasks 폴백 등록분). 그런데 같은
# 굽기가 `ConsentPromptBehaviorAdmin=0` 을 남겨 두어, 손님 제어 세션(걸러진 토큰)에서도
# `Start-Process -Verb RunAs` 가 **묻지 않고** 높은 무결성 토큰을 준다(High Mandatory Level
# 실측). 그래서 이 문을 먼저 쓴다. RunAs 는 표준출력을 못 받으므로 승격된 파워셸이 스스로
# 파일로 적게 하고 되읽는다.
$cpba = $null
try { $cpba = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Stop).ConsentPromptBehaviorAdmin } catch { $cpba = $null }
if ($cpba -eq 0) {
  Write-Output 'ELEVATE-CHANNEL runas'
  $rid = 'runas-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + (Get-Random -Maximum 100000)
  $rOut = Join-Path $env:PUBLIC ($rid + '.out')
  $rCmd = "& '" + $ps + "' " + $argLine + " *> '" + $rOut + "'; exit `$LASTEXITCODE"
  $rExit = 99
  # 2026-09-17 S04 실측: 부팅 직후(자동 로그온 데스크톱이 아직 없을 때) RunAs 가
  # "이 작업에는 대화형 윈도우 스테이션이 필요합니다" 로 거절된다. 20초 간격으로 기다린다 —
  # 2026-09-17 14:31 실측: 연결 복제본의 첫 부팅(하드웨어 재인식)은 데스크톱이 2분 넘게 늦어 여섯 번으로
  # 모자랐다(S04 v3 실행 실패) → 열다섯 번(5분).
  $runasTries = 15
  for ($try = 1; $try -le $runasTries; $try++) {
    try {
      $rp = Start-Process -FilePath $ps -Verb RunAs -PassThru -WindowStyle Hidden `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $rCmd)
      $null = $rp.Handle
      if (-not $rp.WaitForExit($TimeoutSeconds * 1000)) { try { $rp.Kill() } catch {}; Write-Output ('ELEVATE-TIMEOUT after ' + $TimeoutSeconds + ' s (runas)') }
      else { $rExit = $rp.ExitCode; if ($null -eq $rExit) { $rExit = 0 } }
      break
    } catch {
      Write-Output ('RUNAS-FAILED (try ' + $try + ') ' + $_.Exception.Message)
      if ($try -lt $runasTries) { Start-Sleep -Seconds 20 }
    }
  }
  Write-Output ('ELEVATE-EXIT ' + $rExit)
  Show-Result -AgentOut $rOut
}

# --- [baked] 구운 SYSTEM 대리인에게 부탁한다 ---------------------------------
if (Test-Path -LiteralPath $queue) {
  Write-Output 'ELEVATE-CHANNEL baked'
  $id = 'job-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + (Get-Random -Maximum 100000)
  $jobTmp = Join-Path $queue ($id + '.tmp')
  $job = Join-Path $queue ($id + '.job')
  $done = Join-Path $queue ($id + '.done')
  $agentOut = Join-Path $queue ($id + '.out')
  # 반쯤 쓴 파일을 대리인이 집어 가지 않도록 **다른 이름으로 쓴 뒤 옮긴다**.
  Set-Content -LiteralPath $jobTmp -Value $argLine -Encoding UTF8
  Move-Item -LiteralPath $jobTmp -Destination $job -Force

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $done)) { Start-Sleep -Seconds 1 }
  if (Test-Path -LiteralPath $done) {
    Write-Output ('ELEVATE-EXIT ' + (Get-Content -LiteralPath $done -Raw).Trim())
  } else {
    Write-Output ('ELEVATE-TIMEOUT after ' + $TimeoutSeconds + ' s -- is task IRIS-VM-Agent running?')
  }
  Show-Result -AgentOut $agentOut
}

# --- [task] 구워지지 않은 옛 이미지용 --------------------------------------
Write-Output 'ELEVATE-CHANNEL task'
$taskName = 'IRIS-VM-Elevated'
$action = New-ScheduledTaskAction -Execute $ps -Argument $argLine
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(30))

Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
try {
  Start-ScheduledTask -TaskName $taskName
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $Out)) { Start-Sleep -Seconds 2 }
} finally {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}

Show-Result
