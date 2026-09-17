# installer/lib/file-holders.ps1 -- ASCII only (Windows PowerShell 5.1 reads a BOM-less
# .ps1 as ANSI; nothing here needs Korean).
#
# "Which processes hold files under this folder?" answered by the Windows Restart
# Manager (rstrtmgr.dll, built into Windows Vista+; no SysInternals needed). The
# installer asks this when moving an old part folder aside fails with EBUSY/EPERM
# (measured 2026-09-17 on a real PC: _agent\shared\tools\teamclaude-dash stayed
# busy even after a reboot, and Win32_Process could not say by whom).
#
# Output: one JSON array on stdout: [{ "pid": 1234, "app": "Windows Explorer",
# "exe": "C:\\Windows\\explorer.exe", "name": "explorer.exe" }, ...]
# Any failure (ConstrainedLanguage, old OS, too many files) prints [] and exits 0 --
# this is a helper for a better sentence, never a reason to stop the installer.
#
# Restart Manager works on FILES: a process that only holds the directory itself
# (an Explorer window showing the folder) is not listed. The caller says so.

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$MaxFiles = 3000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Out-Empty { Write-Output '[]'; exit 0 }

try {
  if (-not (Test-Path -LiteralPath $Path)) { Out-Empty }
  $files = @()
  if ((Get-Item -LiteralPath $Path).PSIsContainer) {
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
      Select-Object -First $MaxFiles | ForEach-Object { $_.FullName })
  } else {
    $files = @((Get-Item -LiteralPath $Path).FullName)
  }
  if ($files.Count -eq 0) { Out-Empty }

  $src = @'
using System;
using System.Runtime.InteropServices;
public static class IrisRm {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
}
'@
  if (-not ('IrisRm' -as [type])) { Add-Type -TypeDefinition $src -ErrorAction Stop }

  $handle = [uint32]0
  $key = [guid]::NewGuid().ToString('N')
  if ([IrisRm]::RmStartSession([ref]$handle, 0, $key) -ne 0) { Out-Empty }
  try {
    $rc = [IrisRm]::RmRegisterResources($handle, [uint32]$files.Count, [string[]]$files, 0, $null, 0, $null)
    if ($rc -ne 0) { Out-Empty }
    $needed = [uint32]0; $count = [uint32]0; $reasons = [uint32]0
    $rc = [IrisRm]::RmGetList($handle, [ref]$needed, [ref]$count, $null, [ref]$reasons)
    if ($rc -ne 0 -and $rc -ne 234) { Out-Empty }   # 234 = ERROR_MORE_DATA
    if ($needed -eq 0) { Out-Empty }
    $infos = New-Object 'IrisRm+RM_PROCESS_INFO[]' $needed
    $count = $needed
    $rc = [IrisRm]::RmGetList($handle, [ref]$needed, [ref]$count, $infos, [ref]$reasons)
    if ($rc -ne 0) { Out-Empty }
    $out = @()
    for ($i = 0; $i -lt $count; $i++) {
      $pid_ = $infos[$i].Process.dwProcessId
      $exe = $null; $name = $null
      try { $p = Get-Process -Id $pid_ -ErrorAction Stop; $exe = $p.Path; $name = $p.ProcessName + '.exe' } catch { }
      $out += [PSCustomObject]@{ pid = $pid_; app = $infos[$i].strAppName; exe = $exe; name = $name }
    }
    if ($out.Count -eq 0) { Out-Empty }
    Write-Output (ConvertTo-Json -InputObject @($out) -Compress)
  } finally {
    [void][IrisRm]::RmEndSession($handle)
  }
} catch {
  Out-Empty
}
