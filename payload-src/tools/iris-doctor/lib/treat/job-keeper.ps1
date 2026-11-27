# IRIS Doctor treatment bundle keeper (ASCII only, CRLF). Windows PowerShell 5.1.
# Purpose: everything the treatment agent starts must end when Doctor ends.
#   1. create a Job object with KILL_ON_JOB_CLOSE and put THIS process into it
#      (children started afterwards are in the Job from their first instruction - no gap)
#   2. write the flag file (tells Doctor that the Job is in place)
#   3. start the agent with the same standard handles, wait for it
#   4. if the Doctor process (IRIS_DOCTOR_JOB_PARENT) disappears, exit -> the Job closes -> the agent and
#      everything it started are ended by Windows
# Exit codes: the agent's exit code / 97 = could not create the Job (the agent was NOT started) /
#             98 = Doctor disappeared / 96 = could not start the agent.
# Inputs come from environment variables (never from a command string):
#   IRIS_DOCTOR_JOB_EXE  IRIS_DOCTOR_JOB_ARGS (UTF-8 JSON array file)  IRIS_DOCTOR_JOB_CWD
#   IRIS_DOCTOR_JOB_FLAG  IRIS_DOCTOR_JOB_PARENT
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
public static class IrisDoctorJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  public static bool Enter() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return false;
    EXT e = new EXT();
    e.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    int len = Marshal.SizeOf(typeof(EXT));
    IntPtr p = Marshal.AllocHGlobal(len);
    try { Marshal.StructureToPtr(e, p, false); if (!SetInformationJobObject(job, 9, p, (uint)len)) return false; } finally { Marshal.FreeHGlobal(p); }
    return AssignProcessToJobObject(job, GetCurrentProcess()); // the handle is kept open on purpose: it closes when this process ends
  }
}
'@
try {
  Add-Type -TypeDefinition $src
  if (-not [IrisDoctorJob]::Enter()) { exit 97 }
} catch { exit 97 }

function QuoteArg([string]$a) {
  if (($a.Length -gt 0) -and ($a -notmatch '[\s"]')) { return $a }
  $s = $a -replace '(\\*)"', '$1$1\"'
  $s = $s -replace '(\\+)$', '$1$1'
  return '"' + $s + '"'
}

$p = $null
try {
  # ConvertFrom-Json hands a JSON array over as ONE object; keep it in a variable and loop over that
  # (wrapping the pipeline in @() would give a one-element list holding the whole array).
  $parsed = Get-Content -LiteralPath $env:IRIS_DOCTOR_JOB_ARGS -Raw -Encoding UTF8 | ConvertFrom-Json
  $quoted = @()
  foreach ($a in $parsed) { $quoted += (QuoteArg ([string]$a)) }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:IRIS_DOCTOR_JOB_EXE
  $psi.Arguments = ($quoted -join ' ')
  $psi.UseShellExecute = $false
  if ($env:IRIS_DOCTOR_JOB_CWD) { $psi.WorkingDirectory = $env:IRIS_DOCTOR_JOB_CWD }
  foreach ($k in @('IRIS_DOCTOR_JOB_EXE', 'IRIS_DOCTOR_JOB_ARGS', 'IRIS_DOCTOR_JOB_CWD', 'IRIS_DOCTOR_JOB_FLAG', 'IRIS_DOCTOR_JOB_PARENT')) { $psi.EnvironmentVariables.Remove($k) }
  $parent = [int]$env:IRIS_DOCTOR_JOB_PARENT
  Set-Content -LiteralPath $env:IRIS_DOCTOR_JOB_FLAG -Value 'job' -Encoding ASCII
  $p = [System.Diagnostics.Process]::Start($psi)
} catch { exit 96 }

while (-not $p.WaitForExit(1000)) {
  if ($parent -gt 0) {
    if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit 98 }
  }
}
exit $p.ExitCode
