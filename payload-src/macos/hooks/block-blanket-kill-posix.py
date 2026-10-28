# -*- coding: utf-8 -*-
# PreToolUse guard for macOS (Claude settings.json + Codex hooks.json, same file). IRIS global rule.
# The POSIX twin of block-blanket-kill.ps1 (macOS design doc in docs/, D-M18). Blocks two kinds of
# process kills that take down EVERY agent session on this machine at once:
#   A) name-based blanket kills: "pkill node" / "killall node" / "kill $(pgrep node)" also kill the
#      TeamClaude proxy -> every Claude session drops.
#   B) kills aimed at the IRIS infrastructure: owners of listening ports 3456 (TeamClaude proxy),
#      3457 (dashboard viewer), 3458 (IRIS window daemon, the pty parent of every session) and their
#      wrapper parents, the PID in the window's state/daemon.pid, port-derived kills
#      (lsof -ti :3458 | xargs kill), daemon.pid-derived kills, command-line-derived kills naming the
#      daemon/proxy scripts, and POST /api/shutdown on the daemon (= kill all sessions).
# Test: python3 block-blanket-kill-posix.test.py (next to this file). ASCII only on purpose.
import json
import os
import re
import subprocess
import sys

PORTS = (3456, 3457, 3458)

NAME_REASON = (
    "BLOCKED - IRIS global rule: name-based blanket process kill is forbidden (killing all 'node' also kills "
    "the TeamClaude proxy and drops EVERY Claude session on this machine). Kill only a process you started and "
    "whose PID you recorded: kill <PID>. If you lost the PID, identify exactly one process first (e.g. by port: "
    "lsof -nP -iTCP:<port> -sTCP:LISTEN) and kill that single PID."
)
INFRA_REASON = (
    "BLOCKED - IRIS global rule: this command targets IRIS infrastructure that every agent session depends on. "
    "The IRIS window daemon (port 3458) is the pty parent of ALL sessions - killing it closes every session and "
    "the window at once, including yours; the TeamClaude proxy (3456) carries every Claude API call. Never stop "
    "these PIDs, never derive their PID from the port / daemon.pid / command line to stop them, and never POST "
    "/api/shutdown. To apply new daemon code: save the files, tell the user that N sessions will be cut, and let "
    "the user restart the IRIS window with the power button (the daemon auto-resumes lost sessions on start)."
)

NAMES = r"(node|claude|codex|electron|Electron|IRIS)"
NAME_KILL = [
    re.compile(r"(?i)\b(pkill|killall)\b[^\n;|&]*\b" + NAMES + r"\b"),
    # kill $(pgrep node) / pgrep -f claude | xargs kill
    re.compile(r"(?i)\bpgrep\b[^\n;&]*\b" + NAMES + r"\b[^\n;&]*\|\s*xargs\s+(sudo\s+)?kill\b"),
    re.compile(r"(?i)\bkill\b[^\n;&]*\$\(\s*pgrep\b[^)]*\b" + NAMES + r"\b"),
    # Windows spellings still mean the same thing if someone types them here
    re.compile(r"(?i)taskkill[^\n]*?[/-]IM\s+[\"']?" + NAMES),
    re.compile(r"(?i)Stop-Process[^\n|]*-Name\s+[\"']?" + NAMES + r"\b"),
]
KILL_VERB = re.compile(
    r"(?i)(\bkill\b|\bpkill\b|\bkillall\b|xargs\s+(sudo\s+)?kill|process\.kill\s*\(|os\.kill\s*\(|"
    r"\.kill\s*\(|Stop-Process|taskkill|signal\.SIG(KILL|TERM))"
)
PORT_DERIVED = re.compile(r"(?i)(:345[678]\b|-i\s*(tcp)?:?345[678]\b|\b345[678]\b[^\n]*\b(lsof|netstat|fuser)\b|\b(lsof|netstat|fuser)\b[^\n]*\b345[678]\b)")
SCRIPT_DERIVED = re.compile(r"(?i)(daemon[\\/]+server\.mjs|iris-face|teamclaude|ensure-proxy|\bproxy\.(m?js)\b)")


def deny(reason):
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.exit(0)


def listener_pids():
    spec = ",".join(str(p) for p in PORTS)
    try:
        r = subprocess.run(["/usr/sbin/lsof", "-nP", "-iTCP:" + spec, "-sTCP:LISTEN", "-Fp"],
                           capture_output=True, text=True, timeout=5)
    except Exception:
        return set()
    return {int(l[1:]) for l in r.stdout.splitlines() if l.startswith("p") and l[1:].isdigit()}


def daemon_pid_files():
    files = []
    state = os.environ.get("IRIS_FACE_STATE")
    if state:
        files.append(os.path.join(state, "daemon.pid"))
    root = os.environ.get("IRIS_ROOT") or os.path.join(os.path.expanduser("~"), "IRIS")
    files.append(os.path.join(root, "_agent", "shared", "tools", "face", "state", "daemon.pid"))
    return files


def wrapper_parents(pids):
    # A shell/node that launched a protected process: killing it (or its group) takes the child too.
    out = set()
    for pid in pids:
        try:
            ppid = subprocess.run(["/bin/ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout.strip()
            if not ppid.isdigit() or int(ppid) <= 1:
                continue
            comm = subprocess.run(["/bin/ps", "-o", "comm=", "-p", ppid], capture_output=True, text=True, timeout=5).stdout.strip()
            if re.search(r"(^|/)(node|sh|bash|zsh|Electron|IRIS)$", comm):
                out.add(int(ppid))
        except Exception:
            continue
    return out


def protected_pids():
    pids = set(p for p in listener_pids() if p > 1)
    for f in daemon_pid_files():
        try:
            with open(f, encoding="utf-8") as fh:
                v = fh.readline().strip()
            if v.isdigit():
                pids.add(int(v))
        except OSError:
            pass
    return pids | wrapper_parents(pids)


def check(cmd, protected_fn=protected_pids):
    """Returns the deny reason for `cmd`, or None when it may run."""
    for rx in NAME_KILL:
        if rx.search(cmd):
            return NAME_REASON
    if re.search(r"(?i)/api/shutdown", cmd):
        return INFRA_REASON
    if not KILL_VERB.search(cmd):
        return None
    if PORT_DERIVED.search(cmd) or re.search(r"(?i)daemon\.pid", cmd) or SCRIPT_DERIVED.search(cmd):
        return INFRA_REASON
    # Resolve protected PIDs only when a kill verb is present, to keep the hook fast otherwise.
    protected = protected_fn()
    if protected:
        for n in sorted({int(m) for m in re.findall(r"(?<![\w.])\d{2,7}(?![\w.])", cmd)}):
            if n in protected:
                return INFRA_REASON + " (PID %d is protected: %s)" % (n, ", ".join(str(p) for p in sorted(protected)))
    return None


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return
    cmd = ((data or {}).get("tool_input") or {}).get("command")
    if not cmd:
        return
    reason = check(cmd)
    if reason:
        deny(reason)


if __name__ == "__main__":
    main()
