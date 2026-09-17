# verify/vm/lane.ps1 -- run scenarios one after another on ONE VM ("lane"), so
# several lanes (base VM + linked clones) can run in parallel on one host.
#
#   pwsh -File verify/vm/lane.ps1 -Vm IRIS-Win11-v2-A -Scenarios S07,S04 -Tag b7
#
# Each scenario runs with --no-report (three lanes writing docs/시험행렬.md at
# once would race); the row is stamped here afterwards via report.mjs with the
# build fingerprint from _build/out/last-build.json and the results folder as
# evidence. Summary lines go to _build/cache/vm/lanes.log (all lanes append).
param(
  [Parameter(Mandatory = $true)][string]$Vm,
  [Parameter(Mandatory = $true)][string[]]$Scenarios,
  [string]$Tag = 'b7',
  [string]$Zip = '_build\out\IRIS-Setup_v2.0.1_2026-09-16.zip',
  [string]$LegacyZip = '_build\cache\vm\IRIS-Setup_v1.4.5_2026-09-14.zip'
)
. (Join-Path $env:CLAUDE_CONFIG_DIR 'secrets\load-keys.ps1') 3>$null
$proj = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $proj
$node = (Get-Command node).Source
$vb = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
$lanes = Join-Path $proj "_build\cache\vm\lanes.log"
function Say($m) { Add-Content $lanes "[$(Get-Date -Format 'MM-dd HH:mm:ss')] [$Vm] $m" }
function Scrub($f) {
  if (Test-Path $f) { $t = [IO.File]::ReadAllText($f); if ($env:IRIS_VM_PASSWORD -and $t.Contains($env:IRIS_VM_PASSWORD)) { [IO.File]::WriteAllText($f, $t.Replace($env:IRIS_VM_PASSWORD, '<redacted>'), (New-Object System.Text.UTF8Encoding $false)) } }
}
# `-File` invocation hands "S07,S04" over as ONE string -- split it ourselves.
$Scenarios = @($Scenarios | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$fp = ((Get-Content (Join-Path $proj "_build\out\last-build.json") -Raw | ConvertFrom-Json).contentFingerprint).Substring(0, 12)
Say "lane start scenarios=$($Scenarios -join ',') fingerprint=$fp"
foreach ($s in $Scenarios) {
  $log = Join-Path $proj "_build\cache\vm\run-$s-$Tag-$Vm.log"
  $err = Join-Path $proj "_build\cache\vm\run-$s-$Tag-$Vm.err.log"
  $args = @('verify/vm/run.mjs', '--scenario', $s, '--zip', $Zip, '--vm', $Vm, '--no-report')
  if ($s -eq 'S09') { $args += @('--legacy-zip', $LegacyZip) }
  Say "$s start"
  $p = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $proj -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err
  $null = $p.Handle
  $p.WaitForExit()
  Scrub $log; Scrub $err
  $verdictLine = (Select-String -Path $log -Pattern "시나리오 $s" | Select-Object -Last 1).Line
  $outDir = (Select-String -Path $log -Pattern 'results\\(S\d\d-[0-9T-]+)' | Select-Object -First 1)
  $evidenceDir = if ($outDir) { $outDir.Matches[0].Groups[1].Value } else { '' }
  $result = if ($verdictLine -match '통과') { '통과' } elseif ($verdictLine) { '실패' } else { '' }
  Say "$s exit=$($p.ExitCode) :: $verdictLine"
  if ($result) {
    $ev = "VM $Vm · _build\cache\vm\results\$evidenceDir"
    & $node verify/vm/report.mjs --scenario $s --result $result --fingerprint $fp --evidence $ev *>> $lanes
    Say "$s stamped $result $fp"
  } else {
    Say "$s NOT stamped (no verdict line -- run.mjs threw; see $err)"
  }
  & $vb controlvm $Vm poweroff 2>$null | Out-Null
  Start-Sleep 8
}
Say "lane end"
