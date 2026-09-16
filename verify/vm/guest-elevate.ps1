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
# So there are two channels, and this file picks whichever the VM has:
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
