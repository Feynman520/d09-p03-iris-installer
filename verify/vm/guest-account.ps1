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
  [string]$Out = ''
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

$json = [PSCustomObject]@{
  account   = $name
  isAdmin   = $false
  inUsers   = $inUsers
  shareDir  = $ShareDir
  created   = ($null -eq $existing)
  baked     = ($null -ne $existing)
  ranAs     = [Security.Principal.WindowsIdentity]::GetCurrent().Name
} | ConvertTo-Json -Compress
Write-Output $json
if ($Out) { Set-Content -LiteralPath $Out -Value $json -Encoding UTF8 }
