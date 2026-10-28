"""Turn a registry launch spec into what CreateProcess needs, the way the client would.

* Claude config values may hold ${VAR} / ${VAR:-default}; Claude expands them before it
  spawns, so a relayed Claude entry is expanded here with the same rule (the shim's env
  is the env Claude gave it). Codex does not expand, so neither do we for Codex.
* A bare command ("node", "npx", "uvx") is looked up on the PATH of that env, with
  PATHEXT, like the clients do.
* `.cmd`/`.bat` and `cmd /c ...` are built as one command line, with the same rules the
  IRIS Codex launcher (agent_parity_mcp.py) has used on this machine for months.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

REFERENCE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


class LaunchError(Exception):
    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage


def expand(value: str, env: dict) -> str:
    def repl(m):
        name, default = m.group(1), m.group(2)
        got = env.get(name)
        if (got is None or got == "") and default is not None:
            return default
        if got is None:
            raise LaunchError("spawn", f"설정에 적힌 환경변수 {name} 가 없습니다")
        return got
    return REFERENCE.sub(repl, value)


def resolve_executable(command: str, env: dict, cwd: str | None) -> str:
    if not command:
        raise LaunchError("spawn", "실행 명령이 비어 있습니다")
    p = Path(command)
    if p.is_absolute() or any(sep in command for sep in ("\\", "/")):
        base = p if p.is_absolute() else Path(cwd or os.getcwd()) / p
        if base.exists():
            return str(base)
        for ext in (env.get("PATHEXT") or os.environ.get("PATHEXT", ".EXE;.CMD;.BAT")).split(";"):
            cand = Path(str(base) + ext.lower())
            if ext and cand.exists():
                return str(cand)
        raise LaunchError("spawn", f"실행 파일을 찾을 수 없습니다: {p.name}")
    found = shutil.which(command, path=env.get("PATH") or env.get("Path") or os.environ.get("PATH"))
    if not found:
        raise LaunchError("spawn", f"실행 파일을 PATH에서 찾을 수 없습니다: {command}")
    return found


def _cmd_line(executable: str, args: list[str]) -> str:
    """cmd.exe /c ... as one command line (cmd parses /c as shell syntax)."""
    argv = [executable, *args]
    positions = [i for i, v in enumerate(argv) if v.lower() == "/c"]
    if len(positions) != 1 or positions[0] == len(argv) - 1:
        return subprocess.list2cmdline(argv)
    split = positions[0] + 1
    tail = argv[split:]
    if len(tail) == 1:
        script = tail[0]
        if Path(os.path.expandvars(script)).is_file():
            script = '"' + script + '"'
    else:
        script = subprocess.list2cmdline(tail)
    return subprocess.list2cmdline(argv[:split]) + ' "' + script + '"'


def build(spec: dict, env: dict, cwd: str | None, *, expand_vars: bool):
    """-> argv list or command-line string for subprocess.Popen."""
    command = spec.get("command") or ""
    args = [str(a) for a in (spec.get("args") or [])]
    if expand_vars:
        command = expand(command, env)
        args = [expand(a, env) for a in args]
    exe = resolve_executable(command, env, cwd)
    name = Path(exe).name.lower()
    if name in ("cmd.exe", "cmd"):
        return _cmd_line(exe, args)
    if name.endswith((".cmd", ".bat")):
        comspec = env.get("ComSpec") or env.get("COMSPEC") or os.environ.get("ComSpec", "cmd.exe")
        return subprocess.list2cmdline([comspec, "/d", "/s", "/c"]) + ' "' + subprocess.list2cmdline([exe, *args]) + '"'
    return [exe, *args]


def describe(spec: dict) -> str:
    """Safe one-liner for logs: program file name and argument count only."""
    cmd = str(spec.get("command") or "")
    return f"{Path(cmd).name or cmd} (+{len(spec.get('args') or [])} args)"
