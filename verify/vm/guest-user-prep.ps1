# verify/vm/guest-user-prep.ps1 -- runs INSIDE the VM guest, AS THE TEST ACCOUNT.
#
# UTF-8 with BOM (Korean literals -- IRIS rule R-004). Two jobs, both of which
# only the account itself can do:
#
#   1. 프로필 만들기 -- guestcontrol 이 `--profile` 로 처음 로그온할 때 프로필이
#      생긴다. 이 스크립트가 도는 것 자체가 그 증거다.
#   2. -Redirect (S04): 바탕화면을 OneDrive 아래 한글 폴더로 옮긴다. HKCU 는 지금
#      로그온한 사람의 것이라, 그 계정으로 돌아야만 올바른 곳에 쓰인다.
#      (진짜 OneDrive 를 깔지 않는다 -- 잡으려는 것은 「바탕화면이 %USERPROFILE%\Desktop
#       이 아닌 한글 경로로 옮겨져 있을 때 설치기가 그 자리를 찾는가」뿐이다.)
#
#   -Check: 설치 뒤 그 바탕화면에 바로가기가 놓였는지 본다(표시 한 줄을 찍는다).

param(
  [switch]$Redirect,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$redirected = Join-Path $env:USERPROFILE 'OneDrive\바탕 화면'
$shellKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
$shellKey2 = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders'

if ($Redirect) {
  New-Item -ItemType Directory -Force -Path $redirected | Out-Null
  # PowerShell 레지스트리 공급자(Set-ItemProperty)는 guestcontrol 의 비대화형
  # --profile 토큰에서 "Requested registry access is not allowed"(SecurityException)
  # 으로 죽는다(2026-09-17 S04 실측: HKCU\...\User Shell Folders 쓰기 거부).
  # reg.exe 는 Win32 레지스트리 API 를 곧장 불러 같은 사용자 하이브에 문제없이 쓴다.
  $userShellKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
  $shellFolders = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders'
  & reg.exe add $userShellKey /v Desktop /t REG_EXPAND_SZ /d '%USERPROFILE%\OneDrive\바탕 화면' /f | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "reg add (User Shell Folders Desktop) failed with exit $LASTEXITCODE" }
  & reg.exe add $shellFolders /v Desktop /t REG_SZ /d $redirected /f | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "reg add (Shell Folders Desktop) failed with exit $LASTEXITCODE" }
}

if ($Check) {
  # 옮겨진 바탕화면에 .lnk 가 있는가 / 옛 바탕화면에 잘못 놓이지는 않았는가.
  $old = Join-Path $env:USERPROFILE 'Desktop'
  $hereLnk = @(Get-ChildItem -LiteralPath $redirected -Filter '*.lnk' -ErrorAction SilentlyContinue)
  $oldLnk = @(Get-ChildItem -LiteralPath $old -Filter '*.lnk' -ErrorAction SilentlyContinue)
  if ($hereLnk.Count -gt 0) { Write-Output 'REDIRECTED-SHORTCUT-PRESENT' } else { Write-Output 'REDIRECTED-SHORTCUT-MISSING' }
  if ($oldLnk.Count -gt 0) { Write-Output 'OLD-DESKTOP-SHORTCUT-PRESENT' } else { Write-Output 'OLD-DESKTOP-CLEAN' }
  foreach ($l in $hereLnk) { Write-Output ("LNK " + $l.Name) }
}

# HKCU 탐침(2026-09-17 S03 실측: 설치기의 `reg add HKCU\Environment` 가 이 계정에서 "액세스가
# 거부되었습니다"). 이 스크립트는 설치기와 **같은 토큰**(guestcontrol --profile)으로 돌므로,
# 여기서 같은 쓰기가 되는지·HKCU 가 정말 이 사용자의 하이브인지 찍어 두면 시험대 문제인지
# 제품 문제인지 갈린다. run.mjs 가 'HKCU-PROBE' 줄을 그대로 로그에 옮긴다.
try {
  $sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
  $hiveLoaded = (& reg.exe query "HKU\$sid" 2>$null | Measure-Object).Count -gt 0
  & reg.exe add 'HKCU\Environment' /v IRIS_HKCU_PROBE /t REG_SZ /d probe /f 2>&1 | Out-Null
  $addExit = $LASTEXITCODE
  & reg.exe delete 'HKCU\Environment' /v IRIS_HKCU_PROBE /f 2>&1 | Out-Null
  $envKeyOwnerOk = $true
  try { $null = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); } catch { $envKeyOwnerOk = $false }
  Write-Output ("HKCU-PROBE sid={0} hiveLoaded={1} regAddEnvExit={2} netOpenWritable={3} user={4}" -f $sid, $hiveLoaded, $addExit, $envKeyOwnerOk, $env:USERNAME)
} catch {
  Write-Output ("HKCU-PROBE failed: " + $_.Exception.Message)
}

[PSCustomObject]@{
  user      = $env:USERNAME
  profile   = $env:USERPROFILE
  desktop   = [Environment]::GetFolderPath('Desktop')
  redirected = $redirected
} | ConvertTo-Json -Compress
