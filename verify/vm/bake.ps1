# verify/vm/bake.ps1 -- runs INSIDE the VM guest, ONCE, during the unattended
# install's first logon (VBOXPOST.CMD), while the first-logon context still has
# a FULL (unfiltered) administrator token.
#
# UTF-8 **with BOM** on purpose: it carries the Korean account name
# "테스트 사용자". Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI and would
# mangle it (IRIS rule R-004). create.mjs base64-encodes this whole file (BOM
# included) into the generated post-install .cmd template, so the .cmd itself
# stays pure ASCII and nothing Korean ever crosses a cmd command line.
#
# ---------------------------------------------------------------------------
# WHY THIS FILE EXISTS (measured 2026-09-15, Task 23d; re-measured 2026-09-16)
# ---------------------------------------------------------------------------
# A VBoxManage guest-control session is NOT elevated, even for an administrator
# account: UAC hands it the filtered token, a headless VM has nobody to click
# 「예」, the built-in Administrator is disabled on the evaluation image, and
# `schtasks /ru SYSTEM` is itself refused for the same reason. So every scenario
# that starts with a privileged preparation (S03/S04 accounts, S05 SAC policy,
# S07 hosts file, S09 legacy install) was unreachable.
#
# The fix: do the privileged work at BAKE time -- here -- and leave behind a
# standing SYSTEM channel the (unelevated) guest-control sessions can post to.
#
# ---------------------------------------------------------------------------
# WHAT IT LEAVES BEHIND
# ---------------------------------------------------------------------------
#   C:\iris-vm\agent.ps1   a SYSTEM loop, registered as scheduled task
#                          "IRIS-VM-Agent" (AtStartup + 1-minute watchdog
#                          repetition). It watches C:\iris-vm\queue and runs
#                          whatever .job file appears there AS SYSTEM.
#   C:\iris-vm\queue\      world-writable drop box (Users: Modify) -- this is
#                          the elevation channel. verify/vm/guest-elevate.ps1
#                          drops a .job, waits for the matching .done.
#   C:\iris-vm\baked.json  what this script actually did, for the rig to read.
#   accounts               iristest + 테스트 사용자 (standard, NOT admins) and
#                          irisadmin (hidden admin, for the UAC experiment).
#   UAC                    ConsentPromptBehaviorAdmin = 0, EnableLUA left at 1.
#
# SAC (Smart App Control) is deliberately NOT touched: S05 turns it on through
# the same SYSTEM channel so the scenario proves it turned it on itself.
#
# !! This machine is a disposable test rig. The queue is a deliberate local
# !! privilege-escalation path. Never bake this into anything a person uses.

param(
  # base64 of the UTF-8 password. Never the plaintext -- the generated .cmd
  # would otherwise carry it through cmd quoting rules and into the log.
  [string]$PasswordB64 = '',
  [string]$Root = '',
  [string]$ShareDir = ''
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

if (-not $Root) { $Root = Join-Path $env:SystemDrive 'iris-vm' }
if (-not $ShareDir) { $ShareDir = Join-Path $env:SystemDrive 'Users\Public\iris-verify' }

$log = Join-Path $Root 'bake.log'
$steps = @()
function Step([string]$name, [scriptblock]$body) {
  try {
    $r = & $body
    $script:steps += [PSCustomObject]@{ step = $name; ok = $true; detail = ("$r" -replace '\s+', ' ').Trim() }
    Write-Output "[bake] OK   $name"
  } catch {
    $script:steps += [PSCustomObject]@{ step = $name; ok = $false; detail = $_.Exception.Message }
    Write-Output "[bake] FAIL $name -- $($_.Exception.Message)"
  }
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'queue') | Out-Null

$password = ''
if ($PasswordB64) {
  $password = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PasswordB64))
}

# --- 계정 ---------------------------------------------------------------------
# 표준 사용자 둘. **관리자 그룹에 넣지 않는다** -- S03/S04 의 전제가 "관리자가
# 아닌 사람"이라, 관리자로 만들면 그 시나리오는 아무것도 잡지 못한다.
$standard = @('iristest', [string]([char]0xD14C + [char]0xC2A4 + [char]0xD2B8 + ' ' + [char]0xC0AC + [char]0xC6A9 + [char]0xC790))
# 위 [char] 조합은 '테스트 사용자' 와 같아야 한다. 아래 한 줄이 그것을 확인한다
# (BOM 이 없어 ANSI 로 읽혔다면 여기서 바로 드러난다).
$koreanLiteralOk = ($standard[1] -eq '테스트 사용자')

function New-StandardUser([string]$name) {
  $u = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $u) {
    $sec = ConvertTo-SecureString $password -AsPlainText -Force
    New-LocalUser -Name $name -Password $sec -AccountNeverExpires -PasswordNeverExpires -FullName $name | Out-Null
  }
  Add-LocalGroupMember -Group 'Users' -Member $name -ErrorAction SilentlyContinue
  $admins = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue |
    ForEach-Object { ($_.Name -split '\\')[-1] })
  if ($admins -contains $name) { throw "$name ended up in Administrators" }
  return "created=$($null -eq $u)"
}

foreach ($n in $standard) {
  $nn = $n
  Step "user:$nn" { New-StandardUser $nn }
}

# 숨은 관리자. 로그온 화면에 보이지 않게 해서 시나리오(특히 S03/S04 의 "표준
# 사용자로 로그인한 PC")의 겉모습을 바꾸지 않는다.
Step 'user:irisadmin' {
  $u = Get-LocalUser -Name 'irisadmin' -ErrorAction SilentlyContinue
  if ($null -eq $u) {
    $sec = ConvertTo-SecureString $password -AsPlainText -Force
    New-LocalUser -Name 'irisadmin' -Password $sec -AccountNeverExpires -PasswordNeverExpires -FullName 'IRIS Rig Admin' | Out-Null
  }
  Add-LocalGroupMember -Group 'Administrators' -Member 'irisadmin' -ErrorAction SilentlyContinue
  $k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
  New-Item -Path $k -Force | Out-Null
  New-ItemProperty -Path $k -Name 'irisadmin' -Value 0 -PropertyType DWord -Force | Out-Null
  return "created=$($null -eq $u)"
}

# --- UAC 실험용 값 -------------------------------------------------------------
# ConsentPromptBehaviorAdmin = 0 은 "관리자에게 동의 창을 띄우지 않는다"는 뜻이다.
# 이것만으로 **걸러진 토큰이 통째로 올라가지는 않는다** -- 올릴 때 창이 안 뜰 뿐이다.
# LocalAccountTokenFilterPolicy = 1 은 로컬 관리자 계정의 토큰 걸러내기를 끈다.
# 둘 중 무엇이 손님 제어 세션을 실제로 상승시키는지는 굽고 나서 재는 것이 정본이다
# (task-23e-report.md 3절). EnableLUA 는 1 그대로 둔다 -- 0 으로 내리면 그 PC 는
# 더 이상 보통 Windows 가 아니고, 설치기가 겪는 환경이 실제와 달라진다.
Step 'uac' {
  $k = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  New-ItemProperty -Path $k -Name 'ConsentPromptBehaviorAdmin' -Value 0 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $k -Name 'LocalAccountTokenFilterPolicy' -Value 1 -PropertyType DWord -Force | Out-Null
  $p = Get-ItemProperty -Path $k
  return "EnableLUA=$($p.EnableLUA) ConsentPromptBehaviorAdmin=$($p.ConsentPromptBehaviorAdmin) LocalAccountTokenFilterPolicy=$($p.LocalAccountTokenFilterPolicy)"
}

# --- 공용 작업 폴더 -------------------------------------------------------------
Step 'share' {
  New-Item -ItemType Directory -Force -Path $ShareDir | Out-Null
  & icacls $ShareDir /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
  return $ShareDir
}

# --- SYSTEM 대리인(agent) --------------------------------------------------------
# 이것이 이 작업의 알맹이다. 손님 제어 세션은 상승할 수 없으므로, **이미 상승해
# 있는 무언가**가 계속 돌면서 부탁을 받아 주어야 한다.
#
# 규약(아주 단순하게):
#   요청  queue\<id>.job   한 줄 = powershell.exe 에 넘길 인자들
#   결과  queue\<id>.out   그 실행의 표준출력+표준오류
#         queue\<id>.done  한 줄 = 종료 코드 (이 파일이 생기면 끝난 것)
# 요청자는 <id>.job 을 **다른 이름으로 쓴 뒤 rename** 한다(반쯤 쓴 파일을 집어
# 가지 않게). 대리인은 .job 을 .running 으로 옮겨 잡고, 두 벌이 같은 일을
# 두 번 하지 않게 한다.
$agentPath = Join-Path $Root 'agent.ps1'
$agent = @'
# C:\iris-vm\agent.ps1 -- generated by verify/vm/bake.ps1. Runs as SYSTEM.
# Watches the queue for .job files and runs each one with a full SYSTEM token.
# This is test-rig scaffolding: a deliberate, documented elevation channel on a
# disposable VM. See verify/vm/README.md.
$ErrorActionPreference = 'Continue'
$root = Join-Path $env:SystemDrive 'iris-vm'
$queue = Join-Path $root 'queue'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
New-Item -ItemType Directory -Force -Path $queue | Out-Null
Add-Content -Path (Join-Path $root 'agent.log') -Value ("[" + (Get-Date -Format o) + "] agent up as " + [Security.Principal.WindowsIdentity]::GetCurrent().Name)
while ($true) {
  foreach ($job in @(Get-ChildItem -Path $queue -Filter *.job -ErrorAction SilentlyContinue | Sort-Object Name)) {
    $id = [IO.Path]::GetFileNameWithoutExtension($job.Name)
    $running = Join-Path $queue ($id + '.running')
    try { Move-Item -LiteralPath $job.FullName -Destination $running -Force -ErrorAction Stop } catch { continue }
    $out = Join-Path $queue ($id + '.out')
    $done = Join-Path $queue ($id + '.done')
    $code = 1
    try {
      $line = (Get-Content -LiteralPath $running -Encoding UTF8 -ErrorAction Stop | Where-Object { $_.Trim() } | Select-Object -First 1)
      Add-Content -Path (Join-Path $root 'agent.log') -Value ("[" + (Get-Date -Format o) + "] run " + $id)
      $p = Start-Process -FilePath $ps -ArgumentList $line -Wait -PassThru -NoNewWindow `
        -RedirectStandardOutput $out -RedirectStandardError ($out + '.err')
      $code = $p.ExitCode
    } catch {
      Set-Content -LiteralPath $out -Value ('AGENT-ERROR ' + $_.Exception.Message) -Encoding UTF8
      $code = 99
    }
    if (Test-Path -LiteralPath ($out + '.err')) {
      $e = Get-Content -LiteralPath ($out + '.err') -Raw -ErrorAction SilentlyContinue
      if ($e -and $e.Trim()) { Add-Content -Path $out -Value $e }
      Remove-Item -LiteralPath ($out + '.err') -Force -ErrorAction SilentlyContinue
    }
    Set-Content -LiteralPath $done -Value ([string]$code) -Encoding ASCII
  }
  Start-Sleep -Seconds 1
}
'@
Set-Content -LiteralPath $agentPath -Value $agent -Encoding ASCII

Step 'queue-acl' {
  $q = Join-Path $Root 'queue'
  # 큐만 열어 둔다. C:\iris-vm 자체는 기본 권한(관리자·SYSTEM 쓰기)으로 남겨
  # 표준 사용자가 agent.ps1 을 바꿔치기하지 못하게 한다.
  & icacls $q /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
  return "acl on $q"
}

Step 'agent-task' {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $agentPath + '"'
  $how = 'ps'
  try {
    $action = New-ScheduledTaskAction -Execute $ps -Argument $argLine
    $trigger = New-ScheduledTaskTrigger -AtStartup
    # 되풀이 = 파수꾼. 대리인이 어떤 이유로 죽어도 1분 안에 다시 선다.
    # (MultipleInstances=IgnoreNew 라 살아 있는 동안에는 두 벌이 되지 않는다.)
    $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
      -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
    Register-ScheduledTask -TaskName 'IRIS-VM-Agent' -Action $action -Trigger $trigger `
      -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  } catch {
    # 파수꾼 없이도 서야 한다 -- schtasks 로 1분마다 부른다(기본값이 IgnoreNew).
    $how = 'schtasks:' + $_.Exception.Message
    & schtasks /create /tn 'IRIS-VM-Agent' /tr ('"' + $ps + '" ' + $argLine) `
      /sc MINUTE /mo 1 /ru SYSTEM /rl HIGHEST /f | Out-Null
  }
  & schtasks /run /tn 'IRIS-VM-Agent' | Out-Null
  Start-Sleep -Seconds 5
  $st = (& schtasks /query /tn 'IRIS-VM-Agent' /fo LIST) -join ' '
  return "how=$how $st"
}

# --- 흔적 남기기 ----------------------------------------------------------------
$baked = [PSCustomObject]@{
  bakedAt        = (Get-Date).ToString('o')
  bakeVersion    = 1
  computer       = $env:COMPUTERNAME
  standardUsers  = $standard
  hiddenAdmin    = 'irisadmin'
  koreanLiteralOk = $koreanLiteralOk
  elevationQueue = (Join-Path $Root 'queue')
  agentTask      = 'IRIS-VM-Agent'
  shareDir       = $ShareDir
  sacTouched     = $false
  steps          = $steps
}
$baked | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Root 'baked.json') -Encoding UTF8
Write-Output '[bake] baked.json written'
