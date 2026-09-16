# verify/vm/guest-prove-elevation.ps1 -- runs INSIDE the VM guest.
# UTF-8 with BOM (one Korean comment line; IRIS rule R-004). Everything it
# writes into the guest is ASCII.
#
# Proves (or disproves) that the elevation channel baked by verify/vm/bake.ps1
# really hands out a full token, by doing three things a filtered token CANNOT:
#
#   1. append a comment line to %WINDIR%\System32\drivers\etc\hosts
#   2. create a local user (irisproof)
#   3. write an HKLM value
#
# and then, with -Check, saying whether those three are there. Restore the
# `clean` snapshot between -Do and -Check to prove snapshot isolation: the same
# -Check must then report all three GONE.
#
#   -Do      do the three privileged things (run this THROUGH guest-elevate.ps1)
#   -Check   report whether they are there (needs no privilege -- run it plain)
#   -Who     just report the identity and token level of whoever is running
#   -Out     also write every marker line to this file (for guest-elevate.ps1)
#
# Markers: PROOF-WHO <name> ELEVATED=<True|False> · PROOF-HOSTS-OK|FAILED
#          PROOF-USER-OK|FAILED · PROOF-HKLM-OK|FAILED
#          CHECK-HOSTS-PRESENT|GONE · CHECK-USER-PRESENT|GONE · CHECK-HKLM-PRESENT|GONE

param(
  [switch]$Do,
  [switch]$Check,
  [switch]$Who,
  [string]$Out = ''
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$script:lines = @()
function Emit([string]$m) { $script:lines += $m; Write-Output $m }

$hosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$marker = '# IRIS-RIG-ELEVATION-PROOF'
$userName = 'irisproof'
$regKey = 'HKLM:\SOFTWARE\IRIS-RIG-PROOF'
$regName = 'ElevationProof'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
Emit ('PROOF-WHO ' + $id.Name + ' ELEVATED=' + $elevated)

if ($Do) {
  try {
    Add-Content -Path $hosts -Value ($marker + ' ' + (Get-Date -Format o)) -Encoding ASCII -ErrorAction Stop
    Emit 'PROOF-HOSTS-OK'
  } catch { Emit 'PROOF-HOSTS-FAILED'; Emit ('PROOF-HOSTS-ERROR ' + $_.Exception.Message) }

  try {
    if (-not (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue)) {
      # 증명용 계정이다 -- 비밀번호는 아무도 쓰지 않고, 스냅샷을 되돌리면 사라진다.
      $sec = ConvertTo-SecureString ([Guid]::NewGuid().ToString() + 'Aa1!') -AsPlainText -Force
      New-LocalUser -Name $userName -Password $sec -AccountNeverExpires -PasswordNeverExpires -ErrorAction Stop | Out-Null
    }
    Emit 'PROOF-USER-OK'
  } catch { Emit 'PROOF-USER-FAILED'; Emit ('PROOF-USER-ERROR ' + $_.Exception.Message) }

  try {
    New-Item -Path $regKey -Force -ErrorAction Stop | Out-Null
    New-ItemProperty -Path $regKey -Name $regName -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
    Emit 'PROOF-HKLM-OK'
  } catch { Emit 'PROOF-HKLM-FAILED'; Emit ('PROOF-HKLM-ERROR ' + $_.Exception.Message) }
}

if ($Check) {
  $h = $false
  try { $h = (Get-Content -LiteralPath $hosts -Raw -ErrorAction Stop) -match [regex]::Escape($marker) } catch { }
  Emit ('CHECK-HOSTS-' + $(if ($h) { 'PRESENT' } else { 'GONE' }))
  $u = [bool](Get-LocalUser -Name $userName -ErrorAction SilentlyContinue)
  Emit ('CHECK-USER-' + $(if ($u) { 'PRESENT' } else { 'GONE' }))
  $r = $false
  try { $r = $null -ne (Get-ItemProperty -Path $regKey -Name $regName -ErrorAction Stop) } catch { }
  Emit ('CHECK-HKLM-' + $(if ($r) { 'PRESENT' } else { 'GONE' }))
}

if ($Who -and -not ($Do -or $Check)) { } # identity line was already printed

if ($Out) { Set-Content -LiteralPath $Out -Value $script:lines -Encoding ASCII }
