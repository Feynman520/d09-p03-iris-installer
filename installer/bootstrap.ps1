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

# --- Stage: portable Node (exit 12) ----------------------------------------
# Unpacked once into %LOCALAPPDATA%\IRIS-Installer\node and reused on every
# later run (re-running the installer, or the server relaunching it, must
# not re-extract Node every time).
$nodeZip = Join-Path $ZipRoot ('payload\' + $mf.parts.node.file)
$nodeDir = Join-Path $work 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'
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
"$($proc.Id)" | Set-Content -LiteralPath (Join-Path $work 'server.pid')
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
