"""Read and surgically edit the clients' own MCP settings. Never rewrite a whole file
from a model of it: JSON files are re-read and only one entry's command/args change;
TOML gets a two-line text edit inside one [mcp_servers.<name>] block.

Sources (each yields Source objects with entries):
  claude user scope   <CLAUDE_CONFIG_DIR>\\.claude.json  mcpServers               scope "global"
  claude local scope  <CLAUDE_CONFIG_DIR>\\.claude.json  projects[<dir>].mcpServers  scope "l<sha8>"
  claude project      <dir>\\.mcp.json                   mcpServers               scope "p<sha8>"
  codex global        <CODEX_HOME>\\config.toml          [mcp_servers.*]          scope "global"
  codex project       <dir>\\.codex\\config.toml          [mcp_servers.*]          scope "p<sha8>"
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

try:
    import tomllib
except ImportError:  # pragma: no cover - python < 3.11
    tomllib = None

from . import store

SKIP_DIRS = {"node_modules", ".git", "_trash", "_archive", "__pycache__", ".venv", "venv", "_build", "dist", ".next"}
MAX_DEPTH = 7


@dataclass
class Entry:
    agent: str            # claude | codex
    scope: str            # global | l<sha8> | p<sha8>
    name: str
    spec: dict            # the client's entry as read (command/args/env/...)
    source: "Source"
    project_key: str | None = None

    @property
    def id(self) -> str:
        return store.make_id(self.agent, self.scope, self.name)

    @property
    def is_remote(self) -> bool:
        t = str(self.spec.get("type") or "").lower()
        return bool(self.spec.get("url")) or t in ("http", "sse", "streamable-http", "ws")

    @property
    def disabled(self) -> bool:
        return self.spec.get("enabled") is False or self.spec.get("disabled") is True


@dataclass
class Source:
    agent: str
    kind: str             # claude-user | claude-project | codex
    path: Path
    entries: list = field(default_factory=list)
    in_git_repo: bool = False
    newline: str = "\n"


def _project_scope(path: Path) -> str:
    return "p" + store.sha8(str(path).lower())


def _git_root(start: Path, soul_root: Path) -> Path | None:
    """Nearest folder with .git above start, ignoring the soul root's own marker repo."""
    cur = start
    soul = soul_root.resolve()
    while True:
        if (cur / ".git").exists() and cur.resolve() != soul:
            return cur
        if cur.resolve() == soul or cur.parent == cur:
            return None
        cur = cur.parent


def _walk(root: Path):
    root = Path(root)
    base_depth = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root):
        p = Path(dirpath)
        depth = len(p.parts) - base_depth
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not (depth == 0 and d == "_agent")
                       and not d.startswith("_trash") and depth < MAX_DEPTH]
        yield p, dirnames, filenames


# ---------------------------------------------------------------- reading --
def read_claude_user(claude_home: Path) -> Source | None:
    path = Path(claude_home) / ".claude.json"
    data = store.read_json(path)
    if not isinstance(data, dict):
        return None
    src = Source("claude", "claude-user", path)
    for name, spec in (data.get("mcpServers") or {}).items():
        if isinstance(spec, dict):
            src.entries.append(Entry("claude", "global", name, spec, src))
    for proj, pdata in (data.get("projects") or {}).items():
        if isinstance(pdata, dict):
            for name, spec in (pdata.get("mcpServers") or {}).items():
                if isinstance(spec, dict):
                    scope = "l" + store.sha8(str(path).lower() + "|" + proj.lower())
                    src.entries.append(Entry("claude", scope, name, spec, src, project_key=proj))
    return src


def read_mcp_json(path: Path, soul_root: Path) -> Source | None:
    data = store.read_json(path)
    if not isinstance(data, dict):
        return None
    src = Source("claude", "claude-project", Path(path))
    src.in_git_repo = _git_root(Path(path).parent, soul_root) is not None
    for name, spec in (data.get("mcpServers") or {}).items():
        if isinstance(spec, dict):
            src.entries.append(Entry("claude", _project_scope(Path(path)), name, spec, src))
    return src


def read_codex(path: Path, scope: str, soul_root: Path) -> Source | None:
    if tomllib is None or not Path(path).is_file():
        return None
    raw = Path(path).read_bytes()
    try:
        data = tomllib.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError):
        return None
    src = Source("codex", "codex", Path(path))
    src.newline = "\r\n" if b"\r\n" in raw else "\n"
    if scope != "global":
        src.in_git_repo = _git_root(Path(path).parent.parent, soul_root) is not None
    for name, spec in (data.get("mcp_servers") or {}).items():
        if isinstance(spec, dict):
            src.entries.append(Entry("codex", scope, name, spec, src))
    return src


def discover(soul_root: Path, claude_home: Path | None, codex_home: Path | None) -> list[Source]:
    out: list[Source] = []
    soul = Path(soul_root).resolve()

    def inside(p) -> bool:
        try:
            Path(p).resolve().relative_to(soul)
            return True
        except ValueError:
            return False
    # Only this soul's own settings are ever read for editing (2026-10-28 incident).
    claude_home = claude_home if claude_home and inside(claude_home) else None
    codex_home = codex_home if codex_home and inside(codex_home) else None
    if claude_home:
        s = read_claude_user(claude_home)
        if s:
            out.append(s)
    if codex_home:
        s = read_codex(Path(codex_home) / "config.toml", "global", soul_root)
        if s:
            out.append(s)
    for p, _dirs, files in _walk(soul_root):
        if ".mcp.json" in files:
            s = read_mcp_json(p / ".mcp.json", soul_root)
            if s:
                out.append(s)
        cfg = p / ".codex" / "config.toml"
        if cfg.is_file() and (codex_home is None or cfg.resolve() != (Path(codex_home) / "config.toml").resolve()):
            s = read_codex(cfg, _project_scope(cfg), soul_root)
            if s:
                out.append(s)
    return out


def find_entry(sources: list[Source], entry_id: str) -> Entry | None:
    for s in sources:
        for e in s.entries:
            if e.id == entry_id:
                return e
    return None


# ---------------------------------------------------------------- editing --
class EditError(Exception):
    pass


def set_command(entry: Entry, command: str, args: list[str], *, expect: dict | None = None) -> None:
    """Replace command/args of one entry in its file. `expect` = the command/args we
    believe are there now; a mismatch (someone changed it meanwhile) aborts the edit."""
    src = entry.source
    if src.kind in ("claude-user", "claude-project"):
        _set_json(entry, command, args, expect)
    else:
        _set_toml(entry, command, args, expect)


def _json_target(data: dict, entry: Entry) -> dict:
    if entry.project_key is not None:
        return data["projects"][entry.project_key]["mcpServers"][entry.name]
    return data["mcpServers"][entry.name]


def _set_json(entry: Entry, command: str, args: list[str], expect: dict | None) -> None:
    path = entry.source.path
    for attempt in range(5):
        raw = path.read_bytes()
        text = raw.decode("utf-8-sig")
        try:
            data = json.loads(text)
            target = _json_target(data, entry)
        except (ValueError, KeyError, TypeError) as exc:
            raise EditError(f"항목을 찾을 수 없습니다: {exc}") from None
        if expect is not None and (target.get("command") != expect.get("command")
                                   or list(target.get("args") or []) != list(expect.get("args") or [])):
            raise EditError("그 사이 항목이 바뀌었습니다")
        target["command"] = command
        target["args"] = list(args)
        indent = 2
        m = re.search(r"\n([ \t]+)\"", text)
        if m:
            indent = m.group(1) if "\t" in m.group(1) else len(m.group(1))
        out = json.dumps(data, ensure_ascii=False, indent=indent)
        if text.endswith("\n"):
            out += "\n"
        if "\r\n" in text:
            out = out.replace("\n", "\r\n")
        bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
        tmp = path.with_name(f".{path.name}.relay-{os.getpid()}.tmp")
        tmp.write_bytes(bom + out.encode("utf-8"))
        # A running Claude rewrites .claude.json; only replace if nobody wrote meanwhile.
        if path.read_bytes() != raw:
            tmp.unlink(missing_ok=True)
            time.sleep(0.2)
            continue
        store.replace_with_retry(tmp, path)
        return
    raise EditError("파일이 계속 다시 쓰이고 있어 고치지 못했습니다")


def _toml_str(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def toml_block(text: str, name: str):
    names = [re.escape(name), re.escape(_toml_str(name)), re.escape("'" + name + "'")]
    head = re.compile(r"^[ \t]*\[mcp_servers\.(?:" + "|".join(names) + r")\][ \t]*\r?$", re.M)
    m = head.search(text)
    if not m:
        return None
    start = m.start()
    rest = re.compile(r"^[ \t]*\[\[?([^\]]+)\]\]?[ \t]*\r?$", re.M)
    end = len(text)
    for h in rest.finditer(text, m.end()):
        table = h.group(1).strip()
        stripped = table.replace('"', "").replace("'", "")
        if stripped.startswith(f"mcp_servers.{name}."):
            continue
        end = h.start()
        break
    return start, end


def _set_toml(entry: Entry, command: str, args: list[str], expect: dict | None) -> None:
    path = entry.source.path
    raw = path.read_bytes()
    text = raw.decode("utf-8-sig")
    span = toml_block(text, entry.name)
    if not span:
        raise EditError("[mcp_servers] 블록을 찾지 못했습니다")
    start, end = span
    body = text[start:end]
    cmd_re = re.compile(r"^([ \t]*)command[ \t]*=[^\r\n]*", re.M)
    args_re = re.compile(r"^([ \t]*)args[ \t]*=[ \t]*\[[^\r\n]*\][ \t]*(#[^\r\n]*)?(?=\r?$)", re.M)
    if not cmd_re.search(body):
        raise EditError("command 줄이 없습니다")
    if not args_re.search(body) and re.search(r"^[ \t]*args[ \t]*=", body, re.M):
        raise EditError("args 가 여러 줄이라 고치지 않습니다")
    if expect is not None:
        cur = entry.spec
        if cur.get("command") != expect.get("command") or list(cur.get("args") or []) != list(expect.get("args") or []):
            raise EditError("그 사이 항목이 바뀌었습니다")
    nl = "\r\n" if "\r\n" in body else "\n"
    new_cmd = f"command = {_toml_str(command)}"
    new_args = "args = [" + ", ".join(_toml_str(a) for a in args) + "]"
    body2 = cmd_re.sub(lambda m: m.group(1) + new_cmd, body, count=1)
    if args_re.search(body2):
        body2 = args_re.sub(lambda m: m.group(1) + new_args, body2, count=1)
    else:
        line_end = body2.find("\n", cmd_re.search(body2).end() - 1)
        cut = cmd_re.search(body2).end()
        body2 = body2[:cut] + nl + new_args + body2[cut:] if line_end == -1 else body2[:cut] + nl + new_args + body2[cut:]
    out = text[:start] + body2 + text[end:]
    # verify the result still parses and holds exactly what we meant
    data = tomllib.loads(out)
    got = (data.get("mcp_servers") or {}).get(entry.name) or {}
    if got.get("command") != command or list(got.get("args") or []) != list(args):
        raise EditError("고친 뒤 다시 읽은 값이 다릅니다")
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    tmp = path.with_name(f".{path.name}.relay-{os.getpid()}.tmp")
    tmp.write_bytes(bom + out.encode("utf-8"))
    if path.read_bytes() != raw:
        tmp.unlink(missing_ok=True)
        raise EditError("파일이 그 사이 바뀌었습니다")
    store.replace_with_retry(tmp, path)


def reread(entry: Entry) -> dict | None:
    """Fresh copy of the entry's spec from disk."""
    src = entry.source
    if src.kind == "claude-user":
        s = read_claude_user(src.path.parent)
    elif src.kind == "claude-project":
        s = read_mcp_json(src.path, src.path.parent)
    else:
        s = read_codex(src.path, entry.scope, src.path.parent)
    if not s:
        return None
    for e in s.entries:
        if e.name == entry.name and e.project_key == entry.project_key:
            return e.spec
    return None
