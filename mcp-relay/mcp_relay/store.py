"""State on disk: registry (what to run), catalog (what the AI sees), ledger (who runs
what right now), settings, backups and the log. All writes are temp-file + replace.

Layout (state dir = <root>\\_agent\\shared\\mcp-relay unless overridden):
  registry\\<id>.json   launch spec + original entry text for restore. Never env values.
  catalog\\<id>.json    initialize result + tools/prompts/resources captured from the server.
  ledger\\<shim pid>.json   one live real server and its owner shim.
  settings.json        {"autoSync": true, "exclude": ["self-improve"], "python": null}
  backups\\<stamp>\\     copies of config files before an edit (last 5 per file kept)
  logs\\relay-YYYYMMDD.log
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import time
from pathlib import Path

from . import VERSION

DEFAULT_SETTINGS = {"autoSync": True, "exclude": ["self-improve"], "python": None, "startTimeoutSec": 120}
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,120}$")


def default_state_dir() -> Path:
    env = os.environ.get("IRIS_MCP_RELAY_STATE")
    if env:
        return Path(env)
    # <root>\_agent\shared\tools\mcp-relay\mcp_relay\store.py -> <root>\_agent\shared\mcp-relay
    here = Path(__file__).resolve()
    return here.parents[3] / "mcp-relay"


def root_from_state(state: Path) -> Path:
    # <root>\_agent\shared\mcp-relay -> <root>
    return Path(state).resolve().parents[2]


def now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def sha8(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


def file_for_id(entry_id: str) -> str:
    if SAFE_ID.match(entry_id):
        return entry_id + ".json"
    clean = re.sub(r"[^A-Za-z0-9._-]", "_", entry_id)[:80]
    return f"{clean}-{sha8(entry_id)}.json"


def make_id(agent: str, scope: str, name: str) -> str:
    return f"{agent}.{scope}.{name}"


def fingerprint(command: str, args: list) -> str:
    """Identity of the real server for catalog freshness. Working folder and env are
    deliberately left out (design 12-1): a server sees a different cwd per project."""
    blob = json.dumps([command, list(args or [])], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def atomic_write_json(path: Path, data, *, retries: int = 20) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    replace_with_retry(tmp, path, retries=retries)


def replace_with_retry(src: Path, dst: Path, *, retries: int = 20, delay: float = 0.1) -> None:
    for attempt in range(retries):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == retries - 1:
                try:
                    os.remove(src)
                except OSError:
                    pass
                raise
            time.sleep(delay)


def read_json(path: Path, default=None):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


class State:
    def __init__(self, state_dir: Path | str | None = None) -> None:
        self.dir = Path(state_dir) if state_dir else default_state_dir()

    # -- folders -----------------------------------------------------------
    @property
    def registry_dir(self) -> Path: return self.dir / "registry"
    @property
    def catalog_dir(self) -> Path: return self.dir / "catalog"
    @property
    def ledger_dir(self) -> Path: return self.dir / "ledger"
    @property
    def logs_dir(self) -> Path: return self.dir / "logs"
    @property
    def backups_dir(self) -> Path: return self.dir / "backups"
    @property
    def locks_dir(self) -> Path: return self.dir / "locks"

    # -- settings ------------------------------------------------------------
    def settings(self) -> dict:
        data = read_json(self.dir / "settings.json", {}) or {}
        out = dict(DEFAULT_SETTINGS)
        out.update({k: v for k, v in data.items() if k in DEFAULT_SETTINGS})
        return out

    def ensure_settings(self) -> None:
        p = self.dir / "settings.json"
        if not p.exists():
            atomic_write_json(p, DEFAULT_SETTINGS)

    # -- registry ------------------------------------------------------------
    def registry_path(self, entry_id: str) -> Path:
        return self.registry_dir / file_for_id(entry_id)

    def get_entry(self, entry_id: str) -> dict | None:
        return read_json(self.registry_path(entry_id))

    def put_entry(self, entry: dict) -> None:
        entry = dict(entry)
        entry.setdefault("schema", 1)
        entry["updatedAt"] = now_iso()
        atomic_write_json(self.registry_path(entry["id"]), entry)

    def remove_entry(self, entry_id: str) -> None:
        for p in (self.registry_path(entry_id), self.catalog_path(entry_id)):
            try:
                p.unlink()
            except FileNotFoundError:
                pass

    def entries(self) -> list[dict]:
        out = []
        if self.registry_dir.is_dir():
            for p in sorted(self.registry_dir.glob("*.json")):
                e = read_json(p)
                if isinstance(e, dict) and e.get("id"):
                    out.append(e)
        return out

    # -- catalog -------------------------------------------------------------
    def catalog_path(self, entry_id: str) -> Path:
        return self.catalog_dir / file_for_id(entry_id)

    def get_catalog(self, entry_id: str) -> dict | None:
        cat = read_json(self.catalog_path(entry_id))
        if not isinstance(cat, dict) or not isinstance(cat.get("initialize"), dict):
            return None
        return cat

    def put_catalog(self, entry_id: str, catalog: dict) -> None:
        catalog = dict(catalog)
        catalog["id"] = entry_id
        catalog["capturedAt"] = now_iso()
        catalog["relayVersion"] = VERSION
        atomic_write_json(self.catalog_path(entry_id), catalog)

    # -- ledger --------------------------------------------------------------
    def ledger_path(self, shim_pid: int) -> Path:
        return self.ledger_dir / f"{int(shim_pid)}.json"

    def put_ledger(self, shim_pid: int, record: dict) -> None:
        atomic_write_json(self.ledger_path(shim_pid), record)

    def drop_ledger(self, shim_pid: int) -> None:
        try:
            self.ledger_path(shim_pid).unlink()
        except FileNotFoundError:
            pass

    def ledger(self) -> list[tuple[Path, dict]]:
        out = []
        if self.ledger_dir.is_dir():
            for p in sorted(self.ledger_dir.glob("*.json")):
                rec = read_json(p)
                if isinstance(rec, dict):
                    out.append((p, rec))
        return out

    # -- log -----------------------------------------------------------------
    def log(self, event: str, **fields) -> None:
        """One JSON line per event. Callers pass names, stages and counts -- never env
        values, argument values or message bodies."""
        try:
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            day = _dt.datetime.now().strftime("%Y%m%d")
            line = json.dumps({"t": now_iso(), "pid": os.getpid(), "ev": event, **fields}, ensure_ascii=False)
            append_line(self.logs_dir / f"relay-{day}.log", (line + "\n").encode("utf-8"))
        except OSError:
            pass

    def prune_logs(self, keep_days: int = 14) -> int:
        n = 0
        cutoff = time.time() - keep_days * 86400
        if self.logs_dir.is_dir():
            for p in self.logs_dir.glob("relay-*.log"):
                try:
                    if p.stat().st_mtime < cutoff:
                        p.unlink()
                        n += 1
                except OSError:
                    pass
        return n


def append_line(path: Path, data: bytes) -> None:
    """Append from many processes at once without losing lines. Python's "a" mode seeks
    then writes, so concurrent shims overwrote each other (measured 2026-10-28). A handle
    opened with FILE_APPEND_DATA only makes Windows place every write at the end."""
    if os.name != "nt":
        with open(path, "ab") as f:
            f.write(data)
        return
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    k32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_char_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    FILE_APPEND_DATA, SHARE_RW, OPEN_ALWAYS = 0x0004, 0x00000001 | 0x00000002, 4
    h = k32.CreateFileW(str(path), FILE_APPEND_DATA, SHARE_RW, None, OPEN_ALWAYS, 0x80, None)
    if not h or h == ctypes.c_void_p(-1).value:
        raise OSError(ctypes.get_last_error(), "log open failed")
    try:
        written = wintypes.DWORD()
        k32.WriteFile(h, data, len(data), ctypes.byref(written), None)
    finally:
        k32.CloseHandle(h)


SECRETISH = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)", re.I)
TOKENISH = re.compile(r"[A-Za-z0-9_\-+/=]{32,}")


def redactor(env: dict | None = None):
    """A function that hides env values whose name looks secret, and long token-like runs."""
    values = []
    for k, v in (env or os.environ).items():
        if v and len(v) >= 6 and SECRETISH.search(k):
            values.append(v)
    values.sort(key=len, reverse=True)

    def redact(text: str) -> str:
        for v in values:
            text = text.replace(v, "[가림]")
        return TOKENISH.sub("[가림]", text)
    return redact
