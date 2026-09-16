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
  Set-ItemProperty -Path $shellKey -Name 'Desktop' -Value '%USERPROFILE%\OneDrive\바탕 화면' -Type ExpandString
  Set-ItemProperty -Path $shellKey2 -Name 'Desktop' -Value $redirected -Type String
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

[PSCustomObject]@{
  user      = $env:USERNAME
  profile   = $env:USERPROFILE
  desktop   = [Environment]::GetFolderPath('Desktop')
  redirected = $redirected
} | ConvertTo-Json -Compress
