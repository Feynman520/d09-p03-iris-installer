# orchestrate.ps1 -- after the running S01 (build 5) finishes: build 6, verify,
# run S01 on it, and if S01 passes run the remaining VM scenarios in a chain.
param([int]$WaitPid = 0, [string]$Tag = 'b6', [string[]]$Chain = @('S06','S07','S03','S04','S05','S11','S09'))
. (Join-Path $env:CLAUDE_CONFIG_DIR 'secrets\load-keys.ps1') 3>$null
$proj = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # verify/vm -> repo root
Set-Location $proj
$node = (Get-Command node).Source
$olog = Join-Path $proj "_build\cache\vm\orchestrate.log"
function Say($m) { Add-Content $olog "[$(Get-Date -Format 'MM-dd HH:mm:ss')] $m" }
function Scrub($f) {
  if (Test-Path $f) { $t = [IO.File]::ReadAllText($f); if ($env:IRIS_VM_PASSWORD -and $t.Contains($env:IRIS_VM_PASSWORD)) { [IO.File]::WriteAllText($f, $t.Replace($env:IRIS_VM_PASSWORD, '<redacted>'), (New-Object System.Text.UTF8Encoding $false)) } }
}
function RunScenario($s, $tag, $extra) {
  $log = Join-Path $proj "_build\cache\vm\run-$s-$tag.log"
  $err = Join-Path $proj "_build\cache\vm\run-$s-$tag.err.log"
  $args = @('verify/vm/run.mjs', '--scenario', $s, '--zip', '_build\out\IRIS-Setup_v2.0.1_2026-09-16.zip') + $extra
  Say "$s start ($tag)"
  $p = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $proj -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err
  $null = $p.Handle
  $p.WaitForExit()
  Scrub $log; Scrub $err
  $verdict = (Select-String -Path $log -Pattern "시나리오 $s" | Select-Object -Last 1).Line
  Say "$s exit=$($p.ExitCode) :: $verdict"
  & "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" controlvm IRIS-Win11-v2 poweroff 2>$null | Out-Null
  Start-Sleep 8
  return ($verdict -match '통과')
}

Say "=== orchestrate start (wait pid $WaitPid)"
if ($WaitPid -gt 0) {
  while (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) { Start-Sleep 15 }
  Say "pid $WaitPid exited"
  Start-Sleep 10
}
# build 6 + verify
$b = & $node build/build.mjs 2>&1; Say ("build exit=" + $LASTEXITCODE)
$fp = (Get-Content (Join-Path $proj "_build\out\last-build.json") -Raw | ConvertFrom-Json).contentFingerprint
Say "fingerprint $fp"
& $node verify/static.mjs *> (Join-Path $proj "_build\cache\vm\static-$Tag.log"); Say ("static exit=" + $LASTEXITCODE)
& $node verify/reproduce.mjs *> (Join-Path $proj "_build\cache\vm\reproduce-$Tag.log"); Say ("reproduce exit=" + $LASTEXITCODE)
if ($LASTEXITCODE -ne 0) { Say "reproduce failed -- stopping before VM runs"; exit 2 }

$ok = RunScenario 'S01' $Tag @()
if (-not $ok) { Say "S01 did not pass on build $Tag -- chain not started"; exit 3 }
foreach ($s in $Chain) {
  $extra = @()
  if ($s -eq 'S09') { $extra = @('--legacy-zip', '_build\cache\vm\IRIS-Setup_v1.4.5_2026-09-14.zip') }
  $null = RunScenario $s $Tag $extra
}
Say "=== orchestrate end"
