# verify/vm/guest-run.ps1 -- runs INSIDE the VM guest. ASCII only on purpose:
# Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so any Korean letter in
# this file would arrive mangled (IRIS rule R-004). The one Korean name we need
# -- the entry point "IRIS-<setup>.cmd" -- is never typed here; it is found by
# listing the single *.cmd at the root of the extracted zip.
#
# What it does, in one guest-control session so nothing is orphaned:
#   1. cmd /c <the entry .cmd>      -> starts the installer server on 3460 and
#                                      opens a browser, then RETURNS immediately
#   2. wait for http://127.0.0.1:3460/api/health
#   3. run the bundled node.exe (which step 1 unpacked into
#      %LOCALAPPDATA%\IRIS-Installer\node) on guest-drive.mjs, which presses the
#      wizard buttons through the documented API and stops honestly before any
#      real subscription login.
#
# Exit code = guest-drive.mjs's exit code (0 = drove to the honest stop).

param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Driver,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Port = 3460,
  [int]$ServerWaitSeconds = 600,
  [string]$Subscriptions = 'claude',
  [switch]$SkipOnline,
  [switch]$Legacy
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say([string]$m) { Write-Host ("[guest-run] " + $m) }

if (-not (Test-Path -LiteralPath $Dir)) { throw "extracted zip folder not found: $Dir" }
if (-not (Test-Path -LiteralPath $Driver)) { throw "driver script not found: $Driver" }

# The installer's precheck spawns "powershell.exe" by bare NAME (see
# installer/lib/precheck.mjs checkDisk/checkNtfs/checkPowerShell), so it needs
# System32 on PATH. A VBoxManage guest-control session starts with a very thin
# environment, and even `--profile` did not put System32 back (measured
# 2026-09-15: all three of those checks came back as blockers on a clean
# Windows 11 with 44 GB free and PowerShell 5.1 present). We repair PATH here
# so the rig measures the installer, not the rig.
$sys32 = Join-Path $env:SystemRoot 'System32'
$wanted = @($sys32, $env:SystemRoot, (Join-Path $sys32 'WindowsPowerShell\v1.0'), (Join-Path $sys32 'Wbem'))
$have = ($env:PATH -split ';') | Where-Object { $_ }
foreach ($w in $wanted) { if ($have -notcontains $w) { $have += $w } }
$env:PATH = ($have -join ';')
Say ("PATH entries: " + $have.Count)

$entry = Get-ChildItem -LiteralPath $Dir -Filter '*.cmd' -File | Select-Object -First 1
if ($null -eq $entry) { throw "no *.cmd entry point at the root of $Dir" }
Say ("entry point: " + $entry.Name)

# The entry point starts the installer server DETACHED and returns in a few
# seconds. Its stdout/stderr must be redirected to files: the detached server
# inherits whatever handles it is given, and if those are VBoxManage's own
# --wait-stdout pipes, VBoxManage keeps waiting for a pipe that never closes --
# the whole scenario hangs with no output (measured 2026-09-15: nine minutes
# with the installer screen already sitting there).
$entryOut = Join-Path $env:TEMP 'iris-entry-out.log'
$entryErr = Join-Path $env:TEMP 'iris-entry-err.log'
$proc = Start-Process -FilePath $env:ComSpec `
  -ArgumentList @('/c', ('"' + $entry.FullName + '"')) `
  -WorkingDirectory $Dir -PassThru -Wait -WindowStyle Hidden `
  -RedirectStandardOutput $entryOut -RedirectStandardError $entryErr
Say ("entry exit code: " + $proc.ExitCode)

$base = "http://127.0.0.1:$Port"
$deadline = (Get-Date).AddSeconds($ServerWaitSeconds)
$up = $false
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri ($base + '/api/health') -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $up = $true; break }
  } catch { }
  Start-Sleep -Seconds 3
}
if (-not $up) { throw "installer server did not answer on $base within $ServerWaitSeconds s" }
Say "installer server is up"

$nodeExe = Join-Path $env:LOCALAPPDATA 'IRIS-Installer\node\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "bundled node.exe not found at $nodeExe" }

$driveArgs = @($Driver, '--url', $base, '--out', $Out, '--subscriptions', $Subscriptions)
if ($SkipOnline) { $driveArgs += '--skip-online' }
if ($Legacy) { $driveArgs += '--legacy' }
& $nodeExe $driveArgs
$code = $LASTEXITCODE
Say ("guest-drive exit code: " + $code)
exit $code
