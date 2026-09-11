param([ValidateSet('status','start','restart','stop')][string]$Action = 'status', [string]$NodePath)
$ErrorActionPreference = 'Stop'
$configPath = if ($env:TEAMCLAUDE_CONFIG) { $env:TEAMCLAUDE_CONFIG } else { Join-Path $env:USERPROFILE '.config\teamclaude.json' }
$runtimePath = Join-Path $env:USERPROFILE '.config\teamclaude.server.json'
$entryPath = Join-Path $env:APPDATA 'npm\node_modules\@karpeleslab\teamclaude\src\index.js'
$nodePath = if ($NodePath) { $NodePath } else { (Get-Command node.exe).Source }
$config = Get-Content -LiteralPath $configPath -Encoding UTF8 -Raw | ConvertFrom-Json
$port = [int]$config.proxy.port
if ($port -ne 3456) { throw 'This helper manages only the TeamClaude proxy on port 3456.' }

function Get-OwnedListener {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { return $null }
    $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) { throw 'More than one listener owner; refusing to stop anything.' }
    $ownerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])"
    if (-not $ownerProcess -or $ownerProcess.ExecutablePath -ne $nodePath -or -not $ownerProcess.CommandLine -or
        $ownerProcess.CommandLine.Replace('/','\').IndexOf($entryPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Port 3456 is not owned by the expected TeamClaude program; refusing to stop it.'
    }
    return $ownerProcess
}

$owned = Get-OwnedListener
if ($Action -eq 'status') {
    if (-not $owned) { Write-Output 'TeamClaude is stopped.'; exit 0 }
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$port/teamclaude/status" -TimeoutSec 10
    [pscustomobject]@{Pid=$owned.ProcessId;Port=$port;AccountCount=@($state.accounts).Count;Accounts=@($state.accounts | Select-Object name,status)} | ConvertTo-Json -Depth 4
    exit 0
}
if ($Action -eq 'start' -and $owned) {
    Write-Output "TeamClaude is already running (PID $($owned.ProcessId), port $port)."
    exit 0
}
if ($owned -and $Action -in @('stop','restart')) {
    # Restart is an explicit request to stop this exact, verified listener.
    Stop-Process -Id $owned.ProcessId -ErrorAction Stop
    Wait-Process -Id $owned.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
}
if ($Action -eq 'stop') {
    @{pid=$null;port=$port;stoppedAt=[DateTime]::UtcNow.ToString('o');managedBy='teamclaude-manage.ps1'} |
        ConvertTo-Json | Set-Content -LiteralPath $runtimePath -Encoding UTF8
    Write-Output 'TeamClaude stopped.'
    exit 0
}
if (Get-OwnedListener) { throw 'The old listener is still running.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logBase = Join-Path $env:USERPROFILE ".config\teamclaude-runtime-$stamp"
$priorConfig = $env:TEAMCLAUDE_CONFIG
try {
    $env:TEAMCLAUDE_CONFIG = $configPath
    $started = Start-Process -FilePath $nodePath -ArgumentList @("`"$entryPath`"",'server','--headless') -WindowStyle Hidden -WorkingDirectory (Split-Path $configPath) -RedirectStandardOutput "$logBase.stdout.log" -RedirectStandardError "$logBase.stderr.log" -PassThru
} finally {
    $env:TEAMCLAUDE_CONFIG = $priorConfig
}
@{pid=$started.Id;port=$port;startedAt=[DateTime]::UtcNow.ToString('o');managedBy='teamclaude-manage.ps1';stdout="$logBase.stdout.log";stderr="$logBase.stderr.log"} |
    ConvertTo-Json | Set-Content -LiteralPath $runtimePath -Encoding UTF8
for ($attempt=0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $state = Invoke-RestMethod -Uri "http://127.0.0.1:$port/teamclaude/status" -TimeoutSec 2
        $readyOwner = Get-OwnedListener
        if (-not $readyOwner -or $readyOwner.ProcessId -ne $started.Id) { throw 'Readiness response did not come from the process just started.' }
        Write-Output "TeamClaude started (PID $($started.Id), port $port, $(@($state.accounts).Count) accounts)."
        exit 0
    } catch {
        if (-not (Get-Process -Id $started.Id -ErrorAction SilentlyContinue)) { break }
    }
}
throw "TeamClaude did not become ready. Check $logBase.stderr.log"
