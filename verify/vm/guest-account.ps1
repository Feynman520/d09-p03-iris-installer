# verify/vm/guest-account.ps1 -- runs INSIDE the VM guest, as the ADMIN account.
#
# Saved as UTF-8 **with BOM** on purpose: it carries a Korean fixture name
# ("테스트 사용자"), and Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# which would mangle it (IRIS rule R-004). The Korean name is never passed as an
# argument -- VBoxManage does not preserve argument grouping (see lib.mjs), so a
# name with a space would arrive as two tokens. It lives here instead.
#
# What it does: make sure the standard (NON-admin) test account for S03/S04 and
# the shared work folder exist, then print one JSON line as evidence.
#
#   -Fixture s03  -> "iristest"        (ASCII name, standard user)
#   -Fixture s04  -> "테스트 사용자"    (Korean name WITH a space, standard user)
#
# 2026-09-16(Task 23e): 계정은 이제 **무인 설치 때 미리 구워진다**(verify/vm/bake.ps1).
# 그래서 보통은 이 파일이 "이미 있다"를 확인만 하고 끝난다 -- 만들어야 하는 경우
# (굽지 않은 옛 이미지)에는 관리자 권한이 필요하므로 run.mjs 가 이 파일을
# guest-elevate.ps1 을 거쳐 SYSTEM 으로 돌린다. 둘 다 같은 코드로 지나간다.
#
# `-Out` 는 SYSTEM 으로 돌 때를 위한 것이다: 그때 표준출력은 아무도 못 보므로
# 같은 JSON 을 그 파일에도 적고, guest-elevate.ps1 이 그것을 되읽어 돌려준다.
#
# 그룹은 **이름이 아니라 SID 로** 다룬다 -- 'Users'/'Administrators' 는 Windows
# 판·언어에 따라 현지화될 수 있고, 이름으로 물어 조용히 빗나가면 "표준 사용자"
# 라는 전제가 검사되지 않은 채 통과한다.

param(
  [Parameter(Mandatory = $true)][ValidateSet('s03', 's04')][string]$Fixture,
  [Parameter(Mandatory = $true)][string]$Password,
  # 저장소 정화 규칙(verify/static.mjs ⑦)이 '드라이브 문자 + Users' 모양을 개발 PC
  # 절대경로로 보고 막는다. 손님 안 경로지만 규칙은 둘을 구별할 수 없으므로 이어 붙인다.
  [string]$ShareDir = '',
  [string]$Out = '',
  # 2026-09-17 실측(S03 E-ENV·S04 reg add 거부): guestcontrol `--profile` 은 **표준 사용자의
  # 하이브를 얹지 않는다** — HKU 에 그 SID 가 없고 HKCU 는 읽기 전용 .DEFAULT 로 떨어져
  # 설치기의 `reg add HKCU\Environment` 가 "액세스가 거부되었습니다"로 죽는다(관리자 tester 는
  # 대화형 로그온이라 얹혀 있어 통과). SYSTEM 으로 도는 이 스크립트가 그 계정의 NTUSER.DAT 를
  # `reg load HKU\<SID>` 로 얹으면 이후 그 계정의 프로세스는 제 하이브를 본다(재부팅까지 유지).
  # 프로필 폴더는 그 계정으로 한 번 로그온(guest-user-prep.ps1)한 뒤에야 생기므로 run.mjs 는
  # 이 스위치를 **그 뒤에** 부른다.
  [switch]$LoadHive,
  # 2026-09-17 두 번째 실측: `reg load` 로 얹은 하이브는 guestcontrol 이 만든 그 계정 프로세스의 HKCU 에
  # 붙지 않았다(여전히 거부). 관리자 tester 가 되는 까닭은 **대화형 자동 로그온 세션**이 있어서다.
  # 그래서 같은 방법을 쓴다: 자동 로그온을 표준 계정으로 바꾸고 재부팅하면 그 계정이 진짜 로그온해
  # 하이브·바탕화면·세션이 실제 사용자와 같아진다(설치기가 브라우저도 실제로 연다). VM 전용 비밀번호가
  # 손님 레지스트리에 남지만 이 VM 은 매 실행 스냅샷으로 되돌아간다.
  [switch]$AutoLogon
)

if (-not $ShareDir) { $ShareDir = Join-Path $env:SystemDrive 'Users\Public\iris-verify' }
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$name = if ($Fixture -eq 's03') { 'iristest' } else { '테스트 사용자' }

$USERS_SID = 'S-1-5-32-545'
$ADMINS_SID = 'S-1-5-32-544'

$existing = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if ($null -eq $existing) {
  $sec = ConvertTo-SecureString $Password -AsPlainText -Force
  New-LocalUser -Name $name -Password $sec -AccountNeverExpires -PasswordNeverExpires -FullName $name | Out-Null
}
Add-LocalGroupMember -SID $USERS_SID -Member $name -ErrorAction SilentlyContinue

# 관리자 그룹에 **들어가면 안 된다** -- 표준 사용자라는 전제가 깨지면 이 시나리오는
# 아무것도 잡지 못한다. 들어가 있으면 여기서 멈춘다(조용히 통과시키지 않는다).
$admins = @(Get-LocalGroupMember -SID $ADMINS_SID -ErrorAction SilentlyContinue |
  ForEach-Object { ($_.Name -split '\\')[-1] })
if ($admins -contains $name) { throw "$name is in Administrators -- S03/S04 need a standard user" }
$inUsers = @(Get-LocalGroupMember -SID $USERS_SID -ErrorAction SilentlyContinue |
  ForEach-Object { ($_.Name -split '\\')[-1] }) -contains $name

New-Item -ItemType Directory -Force -Path $ShareDir | Out-Null
# Users(S-1-5-32-545) 에게 수정 권한 -- 표준 사용자가 zip 을 풀고 실행해야 한다.
& icacls $ShareDir /grant ('*' + $USERS_SID + ':(OI)(CI)M') | Out-Null

$hive = [PSCustomObject]@{ requested = [bool]$LoadHive; sid = $null; loaded = $null; path = $null; note = $null }
if ($LoadHive) {
  $sid = (New-Object System.Security.Principal.NTAccount($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  $hive.sid = $sid
  $profKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
  $profDir = (Get-ItemProperty -Path $profKey -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
  if (-not $profDir) { $profDir = Join-Path (Split-Path $env:PUBLIC -Parent) $name }
  $ntuser = Join-Path $profDir 'NTUSER.DAT'
  $hive.path = $ntuser
  # reg.exe 의 stderr("키를 찾을 수 없습니다")는 $ErrorActionPreference=Stop 아래에서
  # NativeCommandError 로 승격돼 스크립트를 죽인다(2026-09-17 실측) — 이 블록만 Continue.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $already = ((& reg.exe query "HKU\$sid" 2>&1) | Where-Object { "$_" -like 'HKEY_USERS*' } | Measure-Object).Count -gt 0
  if ($already) {
    $hive.loaded = $true; $hive.note = 'already loaded'
  } elseif (-not (Test-Path -LiteralPath $ntuser)) {
    $hive.loaded = $false; $hive.note = 'NTUSER.DAT missing (profile not created yet)'
  } else {
    $loadOut = (& reg.exe load "HKU\$sid" $ntuser 2>&1 | ForEach-Object { "$_" }) -join ' '
    $hive.loaded = ($LASTEXITCODE -eq 0)
    $hive.note = "reg load exit $LASTEXITCODE $loadOut".Trim()
  }
  $ErrorActionPreference = $prevEap
}

$autoLogonInfo = [PSCustomObject]@{ requested = [bool]$AutoLogon; set = $false; user = $null }
if ($AutoLogon) {
  $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value '1' -Type String
  Set-ItemProperty -Path $wl -Name DefaultUserName -Value $name -Type String
  Set-ItemProperty -Path $wl -Name DefaultDomainName -Value $env:COMPUTERNAME -Type String
  Set-ItemProperty -Path $wl -Name DefaultPassword -Value $Password -Type String
  Remove-ItemProperty -Path $wl -Name AutoLogonCount -ErrorAction SilentlyContinue
  $autoLogonInfo.set = $true
  $autoLogonInfo.user = $name
}

$json = [PSCustomObject]@{
  account   = $name
  isAdmin   = $false
  inUsers   = $inUsers
  shareDir  = $ShareDir
  created   = ($null -eq $existing)
  baked     = ($null -ne $existing)
  ranAs     = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  hive      = $hive
  autologon = $autoLogonInfo
} | ConvertTo-Json -Compress
Write-Output $json
if ($Out) { Set-Content -LiteralPath $Out -Value $json -Encoding UTF8 }
