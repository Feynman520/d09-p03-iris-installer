# run-chain.ps1 -- run several VM scenarios one after another (detached), each
# with its own log under _build\cache\vm\run-<S>-chain.log. Continues past a
# failed verdict (the matrix row records it); stops only if run.mjs itself
# throws (exit code >= 2) three times in a row.
param(
  [string[]]$Scenarios = @('S06','S07','S03','S04','S05','S11','S09'),
  [string]$Zip = '_build\out\IRIS-Setup_v2.0.1_2026-09-16.zip',
  [string]$LegacyZip = '_build\cache\vm\IRIS-Setup_v1.4.5_2026-09-14.zip'
)
. (Join-Path $env:CLAUDE_CONFIG_DIR 'secrets\load-keys.ps1') 3>$null
$proj = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # verify/vm -> repo root
Set-Location $proj
$node = (Get-Command node).Source
$summary = Join-Path $proj "_build\cache\vm\chain-summary.log"
Add-Content $summary "=== chain start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') scenarios=$($Scenarios -join ',') zip=$Zip"
foreach ($s in $Scenarios) {
  $log = Join-Path $proj "_build\cache\vm\run-$s-chain.log"
  $err = Join-Path $proj "_build\cache\vm\run-$s-chain.err.log"
  $args = @('verify/vm/run.mjs', '--scenario', $s, '--zip', $Zip)
  if ($s -eq 'S09') { $args += @('--legacy-zip', $LegacyZip) }
  Add-Content $summary "[$(Get-Date -Format HH:mm:ss)] $s start"
  $p = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $proj -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err
  $p.WaitForExit()
  $verdict = (Select-String -Path $log -Pattern "시나리오 $s" | Select-Object -Last 1).Line
  Add-Content $summary "[$(Get-Date -Format HH:mm:ss)] $s exit=$($p.ExitCode) :: $verdict"
  # scrub the guest password if VBoxManage echoed it into the error log
  foreach ($f in @($log, $err)) {
    if (Test-Path $f) {
      $t = [IO.File]::ReadAllText($f)
      if ($env:IRIS_VM_PASSWORD -and $t.Contains($env:IRIS_VM_PASSWORD)) {
        [IO.File]::WriteAllText($f, $t.Replace($env:IRIS_VM_PASSWORD, '<redacted>'), (New-Object System.Text.UTF8Encoding $false))
      }
    }
  }
  # make sure the VM is off before the next one (run.mjs does it, but a thrown error may skip it)
  & "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" controlvm IRIS-Win11-v2 poweroff 2>$null | Out-Null
  Start-Sleep 8
}
Add-Content $summary "=== chain end $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
