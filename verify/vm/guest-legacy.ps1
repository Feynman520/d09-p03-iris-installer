# verify/vm/guest-legacy.ps1 -- runs INSIDE the VM guest (S09 준비·확인).
#
# UTF-8 with BOM: 감시 파일 이름이 한글이다(사용자가 실제로 넣어 두는 자료를 흉내낸다).
# 한글 이름을 cmd 인자로 넘기면 코드페이지에서 깨질 수 있어, 이름은 이 파일 안에만 둔다.
#
#   -Plant   1.4.5 설치가 끝난 뒤, 사용자가 자기 자료를 넣어 둔 상태를 만든다.
#   -Check   2.0.0 이 그 위에 설치된 뒤, 그 자료와 1.x 영수증 사본이 살아 있는지 본다.
#
# 표시(run.mjs 가 읽는다): SENTINEL-KEPT|SENTINEL-GONE · LEGACY-KEPT|LEGACY-GONE

param(
  [switch]$Plant,
  [switch]$Check,
  [string]$Root = ''
)

if (-not $Root) { $Root = Join-Path $env:SystemDrive 'IRIS' }
$ErrorActionPreference = 'Continue'

$sentinelKo = Join-Path $Root '사용자자료-감시.txt'
$sentinelDir = Join-Path $Root '내 자료(My Data)'
$sentinelInner = Join-Path $sentinelDir '메모.txt'
$legacyReceipt = Join-Path $Root '_agent\setup\package-receipt.v1.json'

if ($Plant) {
  if (-not (Test-Path -LiteralPath $Root)) { Write-Output 'ROOT-MISSING'; exit 2 }
  Set-Content -LiteralPath $sentinelKo -Value 'IRIS 2.0.0 이 이 줄을 지우면 안 됩니다.' -Encoding UTF8
  New-Item -ItemType Directory -Force -Path $sentinelDir | Out-Null
  Set-Content -LiteralPath $sentinelInner -Value '사용자가 직접 만든 폴더 안의 파일' -Encoding UTF8
  Write-Output 'SENTINEL-PLANTED'
  Write-Output ('ROOT-ITEMS ' + (@(Get-ChildItem -LiteralPath $Root -Force).Count))
}

if ($Check) {
  $a = Test-Path -LiteralPath $sentinelKo
  $b = Test-Path -LiteralPath $sentinelInner
  if ($a -and $b) { Write-Output 'SENTINEL-KEPT' } else { Write-Output 'SENTINEL-GONE' }
  Write-Output ("SENTINEL-DETAIL file=" + $a + " folder=" + $b)
  if (Test-Path -LiteralPath $legacyReceipt) { Write-Output 'LEGACY-KEPT' } else { Write-Output 'LEGACY-GONE' }
  if ($a) {
    $text = Get-Content -LiteralPath $sentinelKo -Raw -Encoding UTF8
    if ($text -match '지우면 안 됩니다') { Write-Output 'SENTINEL-CONTENT-OK' } else { Write-Output 'SENTINEL-CONTENT-CHANGED' }
  }
}
