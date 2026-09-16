# PreToolUse guard (Claude settings.json + Codex hooks.json, same file). IRIS global rule.
# Blocks two kinds of process kills that take down EVERY agent session on this machine at once:
#   A) name-based blanket kills: "kill all node" also kills the TeamClaude proxy -> every Claude session drops.
#   B) PID-targeted kills of the IRIS infrastructure: the IRIS-Face daemon (port 3458) is the ConPTY parent
#      of every Face session, so "Stop-Process -Id <daemon pid>" (allowed by the letter of the old rule) closed all sessions +
#      the window, including the session that issued it. Protected = owners of listening ports 3456 (TeamClaude proxy),
#      3457 (dashboard viewer), 3458 (Face daemon) and their wrapper parents, the PID in the Face state\daemon.pid file,
#      port-derived kills (Get-NetTCPConnection -LocalPort 345x ... Stop-Process), daemon.pid-derived kills, CommandLine-
#      derived kills naming the daemon/proxy scripts, and POST /api/shutdown on the Face daemon (= kill all sessions).
# Test: python block-blanket-kill.test.py (next to this file)   (ASCII only on purpose: runs under PS 5.1 without BOM)
$raw = [Console]::In.ReadToEnd()
try { $j = $raw | ConvertFrom-Json } catch { exit 0 }
$cmd = $j.tool_input.command
if (-not $cmd) { exit 0 }

function Deny($reason) {
  $out = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $reason } } | ConvertTo-Json -Depth 5 -Compress
  [Console]::Out.WriteLine($out)
  exit 0
}

# ---- A) name-based blanket kill ----
$names = '(node|powershell|pwsh|cmd|claude|conhost|WindowsTerminal|wt|electron)'
$hit = $false
if ($cmd -match "(?i)taskkill[^\r\n]*?[/-]IM\s+[`"']?$names(\.exe)?") { $hit = $true }
elseif ($cmd -match "(?i)Stop-Process[^\r\n|]*-Name\s+[`"']?$names\b") { $hit = $true }
elseif (($cmd -match "(?i)Get-Process\s+(-Name\s+)?[`"']?$names\b") -and ($cmd -match '(?i)Stop-Process')) { $hit = $true }
elseif ($cmd -match "(?i)\b(pkill|killall)\b[^\r\n]*\b(node|claude|powershell|electron)\b") { $hit = $true }
if ($hit) {
  Deny "BLOCKED - IRIS global rule: name-based blanket process kill is forbidden (killing all 'node' also kills the TeamClaude proxy and drops EVERY Claude session on this machine). Kill only a process you started and whose PID you recorded: Stop-Process -Id <PID>. If you lost the PID, identify exactly one process first (e.g. by port: Get-NetTCPConnection -LocalPort <port> | Select-Object OwningProcess) and kill that single PID."
}

# ---- B) kills aimed at the IRIS infrastructure (proxy 3456 / dashboard 3457 / IRIS-Face daemon 3458) ----
$killVerb = '(?i)(Stop-Process|taskkill|\bkill\s+(-\w+\s+)*\d|\bkill\s+-\d+|process\.kill\s*\(|TerminateProcess|Win32_Process[^\r\n]*Terminate|\.Kill\s*\(|Invoke-CimMethod[^\r\n]*Terminate)'
$hasKill = $cmd -match $killVerb
$infraReason = "BLOCKED - IRIS global rule: this command targets IRIS infrastructure that every agent session depends on. The IRIS-Face daemon (port 3458) is the ConPTY parent of ALL Face sessions - killing it closes every session and the window at once, including yours; the TeamClaude proxy (3456) carries every Claude API call. Never stop these PIDs, never derive their PID from the port / daemon.pid / command line to stop them, and never POST /api/shutdown. To apply new daemon code: save the files, tell the user that N sessions will be cut, and let the user restart IRIS-Face with the power button (the daemon auto-resumes lost sessions on start)."

if ($cmd -match '(?i)/api/shutdown') { Deny $infraReason }
if ($hasKill) {
  if ($cmd -match '(?i)(-LocalPort\s+[`"'']?345[678]\b|:345[678]\b|\b345[678]\b[^\r\n]*OwningProcess|OwningProcess[^\r\n]*\b345[678]\b|netstat[^\r\n]*345[678])') { Deny $infraReason }
  if ($cmd -match '(?i)daemon\.pid') { Deny $infraReason }
  if ($cmd -match '(?i)(daemon[\\/]+server\.mjs|iris-face|teamclaude|ensure-proxy|\bproxy\.(m?js)\b)') { Deny $infraReason }

  # resolve protected PIDs now (only when a kill verb is present, to keep the hook fast otherwise)
  $protected = New-Object System.Collections.Generic.HashSet[int]
  try {
    $owners = Get-NetTCPConnection -LocalPort 3456, 3457, 3458 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($o in $owners) { if ($o -gt 4) { [void]$protected.Add([int]$o) } }
  } catch {}
  try {
    $stateDir = if ($env:IRIS_FACE_STATE) { $env:IRIS_FACE_STATE } else { $null }
    $pidFiles = @()
    if ($stateDir) { $pidFiles += (Join-Path $stateDir 'daemon.pid') }
    $soulRoot = if ($env:IRIS_ROOT) { $env:IRIS_ROOT } else { (Join-Path ($env:SystemDrive + '\') 'IRIS') }
    $pidFiles += (Join-Path $soulRoot '_agent\shared\tools\face\state\daemon.pid')
    foreach ($f in $pidFiles) { if ($f -and (Test-Path $f)) { $v = (Get-Content $f -ErrorAction SilentlyContinue | Select-Object -First 1); if ($v -match '^\d+$') { [void]$protected.Add([int]$v) } } }
  } catch {}
  # wrapper parents (cmd/node/powershell/conhost that launched a protected process): killing them with /T takes the child down too
  if ($protected.Count -gt 0) {
    try {
      $filter = ($protected | ForEach-Object { "ProcessId = $_" }) -join ' OR '
      $parents = Get-CimInstance Win32_Process -Filter $filter -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ParentProcessId -Unique | Where-Object { $_ -gt 4 }
      if ($parents) {
        $pf = ($parents | ForEach-Object { "ProcessId = $_" }) -join ' OR '
        foreach ($pr in (Get-CimInstance Win32_Process -Filter $pf -Property ProcessId, Name -ErrorAction SilentlyContinue)) {
          if ($pr.Name -match '^(cmd|node|powershell|pwsh|conhost|WindowsTerminal|wt)\.exe$') { [void]$protected.Add([int]$pr.ProcessId) }
        }
      }
    } catch {}
  }
  if ($protected.Count -gt 0) {
    $nums = [regex]::Matches($cmd, '(?<![\w.])\d{2,7}(?![\w.])') | ForEach-Object { [int]$_.Value } | Select-Object -Unique
    foreach ($n in $nums) { if ($protected.Contains($n)) { Deny ($infraReason + " (PID $n is protected: " + (($protected | Sort-Object) -join ', ') + ")") } }
  }
}
exit 0
