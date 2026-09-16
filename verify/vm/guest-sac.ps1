# verify/vm/guest-sac.ps1 -- runs INSIDE the VM guest. ASCII only (IRIS R-004):
# the Korean entry point name is never typed here, it is found by listing the
# single *.cmd at the root of the extracted zip (same rule as guest-run.ps1).
#
# S05 asks one question: when Smart App Control (SAC) is ON and the user
# double-clicks the entry .cmd they just downloaded (so it carries a
# Mark-of-the-Web), what happens -- and does the documented way round it work?
#
#   -Probe        print SAC-STATE=<n>   (1 = on, 2 = evaluation, 0 = off)
#   -Enable       flip evaluation (2) -> on (1); the caller must reboot after
#   -TestEntry    put a real MotW on the entry .cmd, try the double-click path
#                 (ShellExecute) and then the documented `cmd /c` path
#
# Markers printed for the rig to read (verify/vm/run.mjs collects them):
#   SAC-STATE-<n> · SAC-ENABLE-OK|SAC-ENABLE-FAILED
#   MOTW-SET|MOTW-SET-FAILED · MOTW-SHELLEXEC-BLOCKED|MOTW-SHELLEXEC-ALLOWED
#   CMD-PATH-OK|CMD-PATH-FAILED

param(
  [switch]$Probe,
  [switch]$Enable,
  [switch]$TestEntry,
  [string]$Dir,
  # When this runs as a scheduled task (the only way to get an elevated token
  # here -- see guest-elevate.ps1), stdout goes nowhere. So the markers are
  # written to this file as well and the caller echoes it back.
  [string]$Out
)

$script:lines = @()
function Emit([string]$m) { $script:lines += $m; Write-Output $m }

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
$val = 'VerifiedAndReputablePolicyState'

function Get-SacState {
  try { return [int](Get-ItemProperty -Path $key -Name $val -ErrorAction Stop).$val }
  catch { return -1 }
}

if ($Probe -or $Enable) {
  $state = Get-SacState
  Emit ("SAC-STATE-" + $state)
}

if ($Enable) {
  # 2 = evaluation mode (the eval image ships this). 1 = on.
  try {
    Set-ItemProperty -Path $key -Name $val -Value 1 -Type DWord -ErrorAction Stop
    $after = Get-SacState
    if ($after -eq 1) { Emit 'SAC-ENABLE-OK' } else { Emit 'SAC-ENABLE-FAILED' }
    Emit ("SAC-STATE-AFTER-" + $after)
  } catch {
    Emit 'SAC-ENABLE-FAILED'
    Emit ("SAC-ENABLE-ERROR " + $_.Exception.Message)
  }
}

if ($TestEntry) {
  if (-not (Test-Path -LiteralPath $Dir)) { Write-Output 'ENTRY-DIR-MISSING'; exit 2 }
  $entry = Get-ChildItem -LiteralPath $Dir -Filter '*.cmd' -File | Select-Object -First 1
  if ($null -eq $entry) { Write-Output 'ENTRY-MISSING'; exit 2 }

  # A real Mark-of-the-Web: the alternate data stream Explorer writes when a
  # file comes out of a downloaded zip. Without it SAC has nothing to judge.
  try {
    Set-Content -LiteralPath ($entry.FullName + ':Zone.Identifier') `
      -Value "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=https://github.com/" -Encoding ASCII -ErrorAction Stop
    $zone = Get-Content -LiteralPath ($entry.FullName + ':Zone.Identifier') -ErrorAction Stop
    if ($zone -match 'ZoneId=3') { Write-Output 'MOTW-SET' } else { Write-Output 'MOTW-SET-FAILED' }
  } catch {
    Write-Output 'MOTW-SET-FAILED'
  }

  # The double-click path: ShellExecute, exactly what Explorer does.
  # If SAC (or anything else) refuses, Start-Process throws instead of running.
  $started = $null
  try {
    $started = Start-Process -FilePath $entry.FullName -WorkingDirectory $Dir -PassThru -WindowStyle Hidden -ErrorAction Stop
    Write-Output 'MOTW-SHELLEXEC-ALLOWED'
  } catch {
    Write-Output 'MOTW-SHELLEXEC-BLOCKED'
    Write-Output ("MOTW-SHELLEXEC-ERROR " + $_.Exception.Message)
  }
  if ($null -ne $started) {
    # 우리가 띄운 것만 우리가 끝낸다(PID 로 정확히) -- 뒤이어 도는 진짜 설치가
    # 이미 떠 있는 서버와 부딪히지 않게.
    Start-Sleep -Seconds 5
    try { Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue } catch { }
    Write-Output ("MOTW-SHELLEXEC-PID " + $started.Id)
  }

  # 안내 파일(설치가 안 되면.txt)이 zip 뿌리에 있는가 -- 이름을 타이핑하지 않고
  # .txt 를 세어 본다(한글 이름을 이 ASCII 파일에 적지 않기 위해).
  $txt = @(Get-ChildItem -LiteralPath $Dir -Filter '*.txt' -File -ErrorAction SilentlyContinue)
  if ($txt.Count -gt 0) { Write-Output 'NOTICE-PRESENT' } else { Write-Output 'NOTICE-MISSING' }
  foreach ($t in $txt) { Write-Output ("NOTICE-FILE " + $t.Name) }

  Write-Output ("SAC-STATE-AT-TEST-" + (Get-SacState))
}

if ($Out) { Set-Content -LiteralPath $Out -Value $script:lines -Encoding ASCII }
