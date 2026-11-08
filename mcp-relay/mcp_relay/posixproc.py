"""macOS / POSIX process plumbing -- the same primitives as winproc.py, so the rest of the
relay (identity pairs, descendants, terminate_tree, the ledger sweeper) runs unchanged.

winproc.py imports this module at its end when not on Windows and lets these names
replace its own primitives (docs/설계-macOS.md D-M22).

* spawn_in_job(): the real server gets its own process group (Popen process_group=0).
  The "job" is that group: terminate()/close() send SIGKILL to the group. There is no
  kill-on-close for a shim that dies by SIGKILL; then the real server sees its stdin
  close (stdio servers exit on EOF) and the shared relay's ledger sweep ends what is
  left within 30 s -- the same safety net Windows keeps as its second line.
* process identity = (pid, start time). The start time comes from one `ps` call
  (`lstart`, UTC, one-second steps). A PID reused later has a different start time.
  A zombie (exited, not yet reaped) counts as gone.
* Never selects processes by name.
"""
from __future__ import annotations

import calendar
import os
import signal
import subprocess
import time

IS_WINDOWS = False
_PS = "/bin/ps"
_ENV = {**os.environ, "LC_ALL": "C", "TZ": "UTC"}


def _ps(args: list[str]) -> str:
    try:
        r = subprocess.run([_PS, *args], capture_output=True, text=True, env=_ENV, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout if r.returncode == 0 else ""


def _lstart(text: str) -> int | None:
    """'Mon Nov  9 01:05:33 2026' (UTC) -> epoch seconds."""
    try:
        return calendar.timegm(time.strptime(" ".join(text.split()), "%a %b %d %H:%M:%S %Y"))
    except ValueError:
        return None


class Job:
    """The real server's process group. Closing it ends every member still in the group."""

    def __init__(self, pgid: int | None = None) -> None:
        self.handle = pgid

    def assign(self, process_handle: int) -> bool:  # Windows only -- the group is set at spawn
        return self.handle is not None

    def terminate(self) -> None:
        if self.handle:
            try:
                os.killpg(self.handle, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    def close(self) -> None:
        self.terminate()
        self.handle = None


def spawn_in_job(argv, *, env=None, cwd=None, stdin=None, stdout=None, stderr=None):
    """Start argv in a new process group. Returns (popen, job, in_job) like winproc."""
    proc = subprocess.Popen(argv, env=env, cwd=cwd, stdin=stdin, stdout=stdout, stderr=stderr,
                            process_group=0)
    return proc, Job(proc.pid), True


def creation_time(pid: int) -> int | None:
    """Start time (epoch seconds) of a live, non-zombie process, or None."""
    if not pid:
        return None
    out = _ps(["-o", "stat=,lstart=", "-p", str(int(pid))]).strip()
    if not out:
        return None
    stat, _, rest = out.partition(" ")
    if stat.startswith("Z"):
        return None
    return _lstart(rest)


def snapshot() -> list[tuple[int, int, str]]:
    """[(pid, parent_pid, exe_name)] for every process."""
    rows = []
    for line in _ps(["-axww", "-o", "pid=,ppid=,comm="]).splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            rows.append((int(parts[0]), int(parts[1]), os.path.basename(parts[2].strip())))
    return rows


def terminate_pid(pid: int, created: int | None = None) -> bool:
    if not pid:
        return False
    if created is not None and creation_time(pid) != int(created):
        return False
    try:
        os.kill(int(pid), signal.SIGKILL)
        return True
    except (ProcessLookupError, PermissionError):
        return False
