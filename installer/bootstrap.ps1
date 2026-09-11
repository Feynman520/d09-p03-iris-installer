# IRIS installer bootstrap. ASCII only (see AGENTS.md). Windows PowerShell 5.1
# compatible syntax only (Invoke-WebRequest -UseBasicParsing, Get-FileHash).
#
# Exit codes: 0 ok, 10 bad location (still zipped / missing payload),
# 11 integrity check failed, 12 could not unpack Node, 13 server did not
# answer in time.
param(
  [Parameter(Mandatory)][string]$ZipRoot,
  [int]$Port = 3460
)
$ErrorActionPreference = 'Stop'

# Normalize away a trailing slash so downstream Join-Path calls do not end up
# with doubled separators; the installer .cmd launcher already strips
# %~dp0's trailing backslash, but bootstrap.ps1 can also be run directly for
# testing.
if ($ZipRoot.Length -gt 3 -and ($ZipRoot.EndsWith('\') -or $ZipRoot.EndsWith('/'))) {
  $ZipRoot = $ZipRoot.Substring(0, $ZipRoot.Length - 1)
}

$work = Join-Path $env:LOCALAPPDATA 'IRIS-Installer'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$log = Join-Path $work 'bootstrap.log'

# Rotate before writing anything this run: a log that has grown past 512KB
# (many prior runs, or a chatty failure loop) is moved to bootstrap.log.1
# (overwriting any older rotation), so the active log never grows without
# bound while still keeping one previous run's tail around for inspection.
if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 524288)) {
  $rotated = Join-Path $work 'bootstrap.log.1'
  Remove-Item -LiteralPath $rotated -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $log -Destination $rotated -Force
}
"---- run $(Get-Date -Format s) ----" | Add-Content -LiteralPath $log

function Log($m) {
  "$(Get-Date -Format s) $m" | Add-Content -LiteralPath $log
  Write-Host $m
}

Log "Starting. ZipRoot=$ZipRoot Port=$Port"

# --- Stage: location (exit 10) -------------------------------------------
# Two symptoms of "the user did not extract the zip first": Windows Explorer
# opened the installer .cmd file straight out of the zip into a throwaway
# temp folder (path under %TEMP%), or the payload folder that ships beside
# the zip root is simply missing (someone copied only the .cmd file out).
$manifestPath = Join-Path $ZipRoot 'payload\manifest.json'
if ($ZipRoot -like "$env:TEMP*" -or -not (Test-Path -LiteralPath $manifestPath)) {
  Log 'Please extract the zip file first, then run the installer from the extracted folder.'
  exit 10
}
Log 'Location check passed.'

# --- Stage: integrity (exit 11) -------------------------------------------
# Every payload part is hashed at build time into payload/manifest.json; a
# mismatch here means a corrupted or tampered download.
# manifest.json is UTF-8 with no BOM (some payload file names are Korean).
# Get-Content with no -Encoding defaults to the system ANSI code page for a
# BOM-less file on Windows PowerShell 5.1, which mangles those names before
# ConvertFrom-Json ever sees them and causes false integrity failures below
# -- -Encoding UTF8 forces correct decoding regardless of the console code
# page.
$mf = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($part in $mf.parts.PSObject.Properties) {
  $f = Join-Path $ZipRoot ('payload\' + $part.Value.file)
  $hashOk = $false
  if (Test-Path -LiteralPath $f) {
    $actual = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
    $hashOk = ($actual -eq $part.Value.sha256)
  }
  if (-not $hashOk) {
    Log "Integrity check failed: $($part.Value.file). Download the zip again."
    exit 11
  }
}
Log 'Integrity check passed.'

# --- Stage: stale server check ---------------------------------------------
# Re-running the installer (or double-clicking it a second time) must be
# idempotent. Two cases matter here:
#   1. A server from an earlier run is still alive and answering -- do not
#      start a second one (it would fail to bind the port anyway, and
#      server.pid would get overwritten with a dead PID). Reuse it.
#   2. server.pid names a process that used to be our server but stopped
#      answering (crashed, hung) -- stop exactly that recorded PID (never a
#      name or port scan) and clear the stale pid file before starting
#      fresh.
# The health probe alone is not enough to prove the thing on the port is
# *our* server (some other program could be bound to 3460) -- Task 10's
# server.mjs contract includes a "name":"iris-installer" field in the
# /api/health JSON body for exactly this reason.
# Bundled Node paths are resolved here (before the stale-server stage) because
# the stale-pid identity check below compares a recorded pid's image path
# against this exact node.exe. The Node *unpack* stage still happens later.
$nodeDir = Join-Path $work 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'

$pidFile = Join-Path $work 'server.pid'
$alreadyRunning = $false
try {
  $probe = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
  if ($probe.StatusCode -eq 200) {
    $probeBody = $null
    try { $probeBody = $probe.Content | ConvertFrom-Json } catch {}
    if ($probeBody -and $probeBody.name -eq 'iris-installer') {
      $alreadyRunning = $true
    }
  }
} catch {}

if ($alreadyRunning) {
  $existingPid = $null
  if (Test-Path -LiteralPath $pidFile) {
    try { $existingPid = (Get-Content -LiteralPath $pidFile -Raw -Encoding UTF8).Trim() } catch {}
  }
  Log "Setup server already running (pid $existingPid). Reusing it."
  Start-Process "http://127.0.0.1:$Port/"
  exit 0
}

if (Test-Path -LiteralPath $pidFile) {
  $stalePid = $null
  try { $stalePid = [int]((Get-Content -LiteralPath $pidFile -Raw -Encoding UTF8).Trim()) } catch {}
  if ($stalePid) {
    $staleProc = Get-Process -Id $stalePid -ErrorAction SilentlyContinue
    if ($staleProc) {
      # A pid is only ours to stop if it still looks like the server we
      # started: pids are recycled, and server.pid can outlive its process by
      # days, so "the file says 3456" is not evidence. Two gates:
      #   - the image must be node (never a shell, an editor, an agent);
      #   - when the image path is readable, it must be the bundled
      #     node.exe under %LOCALAPPDATA%\IRIS-Installer\node -- some other
      #     node process (a dev server, a relay, an agent session) is never
      #     touched. Path can throw/return nothing for a process this user
      #     may not query; in that case the name check alone decides.
      $stalePath = $null
      try { $stalePath = $staleProc.Path } catch { $stalePath = $null }
      $isOurs = ($staleProc.ProcessName -eq 'node')
      if ($isOurs -and $stalePath) {
        $isOurs = ($stalePath -eq $nodeExe)
      }
      if ($isOurs) {
        Log "Stopping stale server process (pid $stalePid)."
        Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
      } else {
        Log "server.pid names pid $stalePid, but that process is not our bundled Node server. Leaving it alone."
      }
    } else {
      Log "server.pid names pid $stalePid, which is not running. Nothing to stop."
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
} else {
  Log 'No previous server.pid found.'
}

# --- Stage: portable Node (exit 12) ----------------------------------------
# Unpacked once into %LOCALAPPDATA%\IRIS-Installer\node and reused on every
# later run (re-running the installer, or the server relaunching it, must
# not re-extract Node every time).
$nodeZip = Join-Path $ZipRoot ('payload\' + $mf.parts.node.file)
if (Test-Path -LiteralPath $nodeExe) {
  Log 'Node already present, reusing.'
} else {
  Remove-Item -LiteralPath $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
  # node-v24.17.0-win-x64.zip contains one top-level folder; strip it so
  # node.exe lands directly under $nodeDir.
  & "$env:SystemRoot\System32\tar.exe" -xf "$nodeZip" -C "$nodeDir" --strip-components 1
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nodeExe)) {
    Log 'Could not unpack Node.'
    exit 12
  }
  Log 'Node unpacked.'
}

# --- Stage: server + browser (exit 13) -------------------------------------
$server = Join-Path $ZipRoot 'installer\server.mjs'
$serverOut = Join-Path $work 'server.out.log'
$serverErr = Join-Path $work 'server.err.log'
$proc = Start-Process -FilePath $nodeExe `
  -ArgumentList @("`"$server`"", '--zip-root', "`"$ZipRoot`"", '--port', $Port, '--node-dir', "`"$nodeDir`"") `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr
"$($proc.Id)" | Set-Content -LiteralPath $pidFile
Log "Server process started (pid $($proc.Id))."

$ok = $false
for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
    $ok = ($r.StatusCode -eq 200)
  } catch {}
}
if (-not $ok) {
  Log 'Setup server did not respond.'
  exit 13
}

Log 'Server is ready. Open the browser window to continue.'
Start-Process "http://127.0.0.1:$Port/"
Log "Opened browser (server pid $($proc.Id))."
exit 0
