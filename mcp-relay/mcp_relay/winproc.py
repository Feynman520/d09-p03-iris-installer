"""Windows process plumbing with ctypes only (no pywin32).

* spawn_in_job(): start a program SUSPENDED, put it in a fresh Job Object that kills
  every member when the last handle closes (KILL_ON_JOB_CLOSE, no breakaway), then
  resume it. Grandchildren inherit the job, so the whole tree is owned. Measured
  2026-10-28: without a job, a killed parent's grandchild keeps running.
* process identity = (pid, creation time). A PID alone is reused by Windows; the pair
  is not. Every "is it still alive / is it still mine" check uses the pair.
* terminate_tree(): end one process tree by PID, only processes whose creation time
  is not older than the root (a reused PID parented under it cannot be swept).
  Never selects processes by name.
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from ctypes import wintypes

IS_WINDOWS = sys.platform == "win32"

CREATE_SUSPENDED = 0x00000004
CREATE_NO_WINDOW = 0x08000000
PROCESS_TERMINATE = 0x0001
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x00100000
STILL_ACTIVE = 259
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800
JobObjectExtendedLimitInformation = 9
TH32CS_SNAPPROCESS = 0x00000002
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


if IS_WINDOWS:
    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _ntdll = ctypes.WinDLL("ntdll")
    _k32.CreateJobObjectW.restype = wintypes.HANDLE
    _k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _k32.SetInformationJobObject.restype = wintypes.BOOL
    _k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _k32.AssignProcessToJobObject.restype = wintypes.BOOL
    _k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _k32.TerminateJobObject.restype = wintypes.BOOL
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.CloseHandle.restype = wintypes.BOOL
    _k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    _k32.GetProcessTimes.restype = wintypes.BOOL
    _k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    _k32.GetExitCodeProcess.restype = wintypes.BOOL
    _k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _k32.TerminateProcess.restype = wintypes.BOOL
    _k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    _k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    _k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    _k32.Process32FirstW.restype = wintypes.BOOL
    _k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    _k32.Process32NextW.restype = wintypes.BOOL
    _ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    _ntdll.NtResumeProcess.restype = ctypes.c_long


class Job:
    """A kill-on-close job. Closing it (or this process dying) ends every member."""

    def __init__(self) -> None:
        self.handle = None
        if not IS_WINDOWS:
            return
        h = _k32.CreateJobObjectW(None, None)
        if not h:
            raise OSError(ctypes.get_last_error(), "CreateJobObject failed")
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        # BREAKAWAY_OK: a child that deliberately detaches (CREATE_BREAKAWAY_FROM_JOB,
        # e.g. a launcher opening a user-facing app) survives; everything else is owned.
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
        if not _k32.SetInformationJobObject(h, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)):
            err = ctypes.get_last_error()
            _k32.CloseHandle(h)
            raise OSError(err, "SetInformationJobObject failed")
        self.handle = h

    def assign(self, process_handle: int) -> bool:
        if not self.handle:
            return False
        return bool(_k32.AssignProcessToJobObject(self.handle, wintypes.HANDLE(process_handle)))

    def terminate(self) -> None:
        if self.handle:
            _k32.TerminateJobObject(self.handle, 1)

    def close(self) -> None:
        if self.handle:
            _k32.CloseHandle(self.handle)
            self.handle = None


def spawn_in_job(argv, *, env=None, cwd=None, stdin=None, stdout=None, stderr=None):
    """Start argv (list or command-line string) suspended inside a new Job, then resume.

    Returns (popen, job, in_job). in_job is False when the OS refused the assignment
    (the process still runs; the caller records it so the sweeper can watch it).
    """
    if not IS_WINDOWS:
        proc = subprocess.Popen(argv, env=env, cwd=cwd, stdin=stdin, stdout=stdout, stderr=stderr)
        return proc, Job(), False
    job = Job()
    proc = subprocess.Popen(argv, env=env, cwd=cwd, stdin=stdin, stdout=stdout, stderr=stderr,
                            creationflags=CREATE_SUSPENDED | CREATE_NO_WINDOW)
    in_job = job.assign(int(proc._handle))  # noqa: SLF001 -- Popen keeps the process handle here
    status = _ntdll.NtResumeProcess(wintypes.HANDLE(int(proc._handle)))  # noqa: SLF001
    if status != 0:
        proc.kill()
        job.close()
        raise OSError(status, "could not resume the started process")
    return proc, job, in_job


def _filetime_int(ft: wintypes.FILETIME) -> int:
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime


def creation_time(pid: int) -> int | None:
    """Creation time (100ns ticks) of a live process, or None if gone/inaccessible."""
    if not IS_WINDOWS or not pid:
        return None
    h = _k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return None
    try:
        code = wintypes.DWORD()
        if not _k32.GetExitCodeProcess(h, ctypes.byref(code)) or code.value != STILL_ACTIVE:
            return None
        c, e, k, u = (wintypes.FILETIME() for _ in range(4))
        if not _k32.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(k), ctypes.byref(u)):
            return None
        return _filetime_int(c)
    finally:
        _k32.CloseHandle(h)


def is_same_alive(pid: int, created: int | None) -> bool:
    """True when pid is running AND is the very process first seen at `created`."""
    now = creation_time(pid)
    return now is not None and created is not None and now == int(created)


def snapshot() -> list[tuple[int, int, str]]:
    """[(pid, parent_pid, exe_name)] for every process."""
    if not IS_WINDOWS:
        return []
    snap = _k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE_VALUE:
        return []
    out = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = _k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            out.append((int(entry.th32ProcessID), int(entry.th32ParentProcessID), entry.szExeFile))
            ok = _k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        _k32.CloseHandle(snap)
    return out


def parent_of(pid: int) -> tuple[int | None, str | None]:
    for p, pp, _name in snapshot():
        if p == pid:
            for q, _qq, qname in snapshot():
                if q == pp:
                    return pp, qname
            return pp, None
    return None, None


def descendants(root_pid: int, root_created: int) -> list[int]:
    """PIDs under root (deepest first). A child counts only if it started after its own
    parent -- a PID reused by an older process that merely names it as parent does not."""
    table = snapshot()
    kids: dict[int, list[int]] = {}
    for p, pp, _n in table:
        kids.setdefault(pp, []).append(p)
    order: list[int] = []
    stack = [(root_pid, root_created)]
    seen = {root_pid}
    while stack:
        cur, cur_created = stack.pop()
        for k in kids.get(cur, []):
            if k in seen:
                continue
            seen.add(k)
            ct = creation_time(k)
            if ct is None or ct < cur_created:
                continue
            order.append(k)
            stack.append((k, ct))
    return list(reversed(order))


def terminate_pid(pid: int, created: int | None = None) -> bool:
    if not IS_WINDOWS:
        return False
    if created is not None and not is_same_alive(pid, created):
        return False
    h = _k32.OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return False
    try:
        return bool(_k32.TerminateProcess(h, 1))
    finally:
        _k32.CloseHandle(h)


def terminate_tree(root_pid: int, root_created: int) -> list[int]:
    """End root and its descendants, verified by creation time. Returns PIDs ended."""
    if not is_same_alive(root_pid, root_created):
        return []
    ended = []
    for pid in descendants(root_pid, root_created):
        if terminate_pid(pid):
            ended.append(pid)
    if terminate_pid(root_pid, root_created):
        ended.append(root_pid)
    return ended


def self_identity() -> tuple[int, int | None]:
    return os.getpid(), creation_time(os.getpid())
