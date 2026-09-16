# verify/vm/guest-hosts.ps1 -- runs INSIDE the VM guest. ASCII only.
#
# S07: block the npm registry (and only that) by pointing its names at 127.0.0.1
# in the hosts file, so the installer has to fall back to the other source for
# Claude Code. Everything else stays reachable -- that is the whole point of the
# scenario (a workplace that blocks npm but not the internet).
#
# Two things measured on 2026-09-15 shaped this file:
#
#  1. VBoxManage does NOT preserve argument grouping (lib.mjs guestRunPsFile),
#     so a `-Command "<script with spaces>"` arrives at the guest in pieces and
#     dies with a parser error. Hence a .ps1 file, run with -File.
#  2. A guestcontrol session for an administrator is NOT elevated (UAC gives it
#     the filtered token), so writing the hosts file fails with
#     UnauthorizedAccessError. There is no UAC prompt anyone can click in a
#     headless VM, so the edit is handed to a one-shot scheduled task running as
#     SYSTEM -- the standard way to get an elevated action without a prompt.
#     This is rig scaffolding only: the installer itself never needs elevation.

param(
  [switch]$Elevated,      # set when this file is re-entered as SYSTEM
  [string]$Out = ''
)

if (-not $Out) { $Out = Join-Path $env:SystemDrive 'Users\Public\iris-hosts-result.txt' }
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$names = @('registry.npmjs.org', 'npmjs.org', 'www.npmjs.com', 'registry.yarnpkg.com')

function Invoke-Block {
  $out = @()
  $hosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  try {
    $lines = @('') + ($names | ForEach-Object { "127.0.0.1 $_" })
    Add-Content -Path $hosts -Value $lines -Encoding ASCII -ErrorAction Stop
    & ipconfig /flushdns | Out-Null
  } catch {
    $out += 'NPM-BLOCK-FAILED'
    $out += ('NPM-BLOCK-ERROR ' + $_.Exception.Message)
    return $out
  }
  $text = Get-Content -Path $hosts -Raw
  $blocked = @($names | Where-Object { $text -match [regex]::Escape("127.0.0.1 $_") })
  if ($blocked.Count -eq $names.Count) { $out += 'NPM-BLOCKED' } else { $out += 'NPM-BLOCK-FAILED' }
  $out += ('NPM-BLOCKED-COUNT ' + $blocked.Count + '/' + $names.Count)
  # 정말로 막혔는지 확인한다 -- 막혔다고 적어 놓고 안 막힌 채 시험하면 뜻이 없다.
  try {
    $r = Invoke-WebRequest -Uri 'https://registry.npmjs.org/' -UseBasicParsing -TimeoutSec 8
    $out += ('NPM-REACHABLE-STILL ' + $r.StatusCode)
  } catch {
    $out += 'NPM-UNREACHABLE-CONFIRMED'
  }
  return $out
}

if ($Elevated) {
  Set-Content -LiteralPath $Out -Value (Invoke-Block) -Encoding ASCII
  exit 0
}

# --- not elevated: hand the edit to a one-shot SYSTEM task -------------------
$self = $MyInvocation.MyCommand.Path
$task = 'IRIS-VM-HostsBlock'
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
$cmd = '"' + (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') + '"' `
  + ' -NoProfile -ExecutionPolicy Bypass -File "' + $self + '" -Elevated -Out "' + $Out + '"'
& schtasks /create /tn $task /tr $cmd /sc once /st 00:00 /ru SYSTEM /rl HIGHEST /f | Out-Null
& schtasks /run /tn $task | Out-Null

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $Out)) { Start-Sleep -Seconds 2 }
& schtasks /delete /tn $task /f | Out-Null

if (Test-Path -LiteralPath $Out) {
  Get-Content -LiteralPath $Out | ForEach-Object { Write-Output $_ }
} else {
  Write-Output 'NPM-BLOCK-FAILED'
  Write-Output 'NPM-BLOCK-ERROR elevated task produced no result within 120 s'
  exit 1
}
