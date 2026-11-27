# IRIS Doctor start helper (ASCII only). Called by "IRIS Doctor.cmd". Windows PowerShell 5.1.
#   find      : print node.exe candidates found on PATH, one per line (absolute folders only,
#               no shim folders, no folders that hold relay wrapper files). At most 4.
#   selftest  : run  "<IRIS_DOCTOR_NODE>" "<IRIS_DOCTOR_DIR>iris-doctor.mjs" selftest  with a time limit.
#               exit 0 = this node starts Doctor
#               exit 8 = this helper saw that it does not        (the start file tries the next node)
#               exit 9 = it hung and was stopped by its PID       (the start file tries the next node)
#               exit 7 = this helper could not check              (the start file starts Doctor anyway)
#               Exit code 1 is never used here on purpose: PowerShell itself returns 1 when it refuses
#               to run this file (execution policy), and that must not look like "this node is bad".
# Paths come from environment variables, never from a command string.
# Only cmdlets and simple operators are used so that it also works in restricted language mode;
# if anything here fails, the exit code is 7 and the start file carries on.
param([string]$Mode = 'selftest')
$ErrorActionPreference = 'Stop'
$p = $null
$out = $null
$code = 7
try {
  if ($Mode -eq 'find') {
    $seen = @{}
    foreach ($raw in ($env:Path -split ';')) {
      $d = $raw.Trim().Trim('"')
      if (-not $d) { continue }
      if (-not (($d -match '^[A-Za-z]:[\\/]') -or ($d -match '^\\\\'))) { continue }
      if ($d -match '(?i)[\\/]shims([\\/]|$)') { continue }
      $n = Join-Path -Path $d -ChildPath 'node.exe'
      if (-not (Test-Path -LiteralPath $n -PathType Leaf)) { continue }
      $skip = $false
      foreach ($w in @('claude.cmd', 'codex.cmd', 'node.cmd')) {
        $wp = Join-Path -Path $d -ChildPath $w
        if (Test-Path -LiteralPath $wp -PathType Leaf) {
          $t = Get-Content -LiteralPath $wp -Raw -ErrorAction SilentlyContinue
          if ($t -match 'ANTHROPIC_BASE_URL|relay-ensure|model_provider') { $skip = $true }
        }
      }
      if ($skip) { continue }
      $k = $n.ToLower()
      if ($seen.ContainsKey($k)) { continue }
      $seen[$k] = 1
      Write-Output $n
      if ($seen.Count -ge 4) { break }
    }
    $code = 0
  } else {
    $node = $env:IRIS_DOCTOR_NODE
    $dir = $env:IRIS_DOCTOR_DIR
    if ($node -and $dir) {
      $ms = 15000
      if ($env:IRIS_DOCTOR_CHECK_MS -match '^\d{3,6}$') { $ms = [int]$env:IRIS_DOCTOR_CHECK_MS }
      $script = Join-Path -Path $dir -ChildPath 'iris-doctor.mjs'
      $out = Join-Path -Path $env:TEMP -ChildPath ('iris-doctor-check-' + $PID + '.txt')
      $p = Start-Process -FilePath $node -ArgumentList @(('"' + $script + '"'), 'selftest') -PassThru -WindowStyle Hidden -RedirectStandardOutput $out
      $null = $p.Handle
      if (-not $p.WaitForExit($ms)) {
        $code = 9
      } else {
        $rc = $p.ExitCode
        $p = $null
        $txt = ''
        if (Test-Path -LiteralPath $out) { $txt = Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue }
        if (($rc -eq 0) -and ($txt -match 'IRIS-DOCTOR-SELFTEST-OK')) { $code = 0 } else { $code = 8 }
      }
    }
  }
} catch {
  $code = 7
} finally {
  # Whatever happened, do not leave the check process (only the one this helper started, by its PID) or the temp file behind.
  if ($p) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
  if ($out) { try { Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue } catch { } }
}
exit $code
