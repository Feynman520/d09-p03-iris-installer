import { run } from '../../lib/run.mjs';

// Per-user (HKCU\Environment) PATH and variable edits -- no admin rights, no
// machine-wide state.
//
// Why reg.exe and not `setx`: setx silently truncates any value longer than
// 1024 characters, and a developer PC's user Path is routinely longer than
// that. Truncating it would destroy entries the user needs and cannot be
// undone from here. reg.exe writes the value verbatim, whatever its length.
//
// Why the type matters, in both directions: a Path that contains
// %USERPROFILE% style references only expands when its type is
// REG_EXPAND_SZ, so writing such a value back as REG_SZ would turn every one
// of them into a literal, permanently broken path. But the converse is a
// mutation too -- promoting a user's REG_SZ value to REG_EXPAND_SZ makes any
// literal '%' in it start expanding, and changes a registry value the
// installer was only asked to prepend one entry to. (Measured 2026-09-11 on
// the development machine: the user Path there is REG_SZ, so "always write
// REG_EXPAND_SZ" would have silently changed its type.) So: an existing
// value keeps whatever type it already has, and only a value being created
// from nothing is written as REG_EXPAND_SZ.
//
// Every function takes its registry primitives as injectable deps so tests
// never touch the real registry of the machine running them.

const KEY = 'HKCU\\Environment';
// Used only when the value does not exist yet (a fresh machine): an existing
// value keeps its own type -- see the note above.
const NEW_VALUE_TYPE = 'REG_EXPAND_SZ';
const REG = 'reg.exe';
const PS = 'powershell.exe';

// A new process only picks up HKCU\Environment on creation, and Explorer
// (the parent of everything the user launches from the Start menu) caches it
// until it is told otherwise. WM_SETTINGCHANGE (0x1A) with "Environment" is
// that notification; HWND_BROADCAST is 0xffff. SendMessageTimeout with
// SMTO_ABORTIFHUNG (2) is used rather than SendMessage so one hung top-level
// window cannot stall the installer.
const BROADCAST_PS = [
  '$sig = \'[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);\';',
  '$t = Add-Type -MemberDefinition $sig -Name IrisEnv -Namespace Win32 -PassThru;',
  '$r = [UIntPtr]::Zero;',
  '[void]$t::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r)',
].join(' ');

export const defaultRegDeps = {
  regQuery: (name) => run(REG, ['query', KEY, '/v', name], { timeoutMs: 20000 }),
  regAdd: (name, type, value) => run(REG, ['add', KEY, '/v', name, '/t', type, '/d', value, '/f'], { timeoutMs: 20000 }),
  regDelete: (name) => run(REG, ['delete', KEY, '/v', name, '/f'], { timeoutMs: 20000 }),
  notify: () => run(PS, ['-NoProfile', '-NonInteractive', '-Command', BROADCAST_PS], { timeoutMs: 30000 }),
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// reg.exe prints:
//   HKEY_CURRENT_USER\Environment
//       Path    REG_EXPAND_SZ    C:\a;C:\b with space
// The value is everything after the type column, spaces included, so the
// capture is deliberately greedy to the end of the line.
export async function readUserEnv(name, deps = defaultRegDeps) {
  const { code, out } = await deps.regQuery(name);
  if (code !== 0) return { exists: false, type: null, value: null };
  const re = new RegExp(`^\\s*${escapeRegExp(name)}\\s+(REG_[A-Z_]+)\\s+(.*)$`, 'mi');
  const m = re.exec(out ?? '');
  if (!m) return { exists: false, type: null, value: null };
  return { exists: true, type: m[1], value: m[2].replace(/\r$/, '') };
}

// Windows path comparison: case-insensitive, and a trailing backslash is not
// a different directory.
function samePathSegment(a, b) {
  const norm = (s) => s.trim().replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function splitPath(value) {
  return (value ?? '').split(';').filter((s) => s.trim().length > 0);
}

export async function addUserPath(dir, deps = defaultRegDeps) {
  const current = await readUserEnv('Path', deps);
  const before = current.value ?? '';
  const parts = splitPath(before);
  if (parts.some((p) => samePathSegment(p, dir))) {
    return { changed: false, before, after: before };
  }
  const after = parts.length > 0 ? `${dir};${parts.join(';')}` : dir;
  const r = await deps.regAdd('Path', current.type ?? NEW_VALUE_TYPE, after);
  if (r.code !== 0) throw new Error(`reg add Path failed: ${r.err || r.out}`);
  await deps.notify();
  return { changed: true, before, after };
}

// The undo half of addUserPath: removes exactly the entries equal to `dir`
// and leaves everything else, in order, untouched. Used by the rehearsal
// cleanup and by any future uninstall path.
export async function removeUserPath(dir, deps = defaultRegDeps) {
  const current = await readUserEnv('Path', deps);
  const before = current.value ?? '';
  if (!current.exists) return { changed: false, before, after: before };
  const parts = splitPath(before);
  const kept = parts.filter((p) => !samePathSegment(p, dir));
  if (kept.length === parts.length) return { changed: false, before, after: before };
  const after = kept.join(';');
  const r = await deps.regAdd('Path', current.type ?? NEW_VALUE_TYPE, after);
  if (r.code !== 0) throw new Error(`reg add Path failed: ${r.err || r.out}`);
  await deps.notify();
  return { changed: true, before, after };
}

// `previous` is what the receipt records so a later uninstall knows what to
// put back: a string when the variable already pointed somewhere else, null
// when it did not exist at all (in which case the undo is a delete, not a
// restore -- see removeUserEnv).
export async function setUserEnv(name, value, deps = defaultRegDeps) {
  const current = await readUserEnv(name, deps);
  if (current.exists && current.value === value) {
    return { changed: false, previous: current.value };
  }
  const r = await deps.regAdd(name, current.type ?? NEW_VALUE_TYPE, value);
  if (r.code !== 0) throw new Error(`reg add ${name} failed: ${r.err || r.out}`);
  await deps.notify();
  return { changed: true, previous: current.exists ? current.value : null };
}

export async function removeUserEnv(name, deps = defaultRegDeps) {
  const current = await readUserEnv(name, deps);
  if (!current.exists) return { changed: false, previous: null };
  const r = await deps.regDelete(name);
  if (r.code !== 0) throw new Error(`reg delete ${name} failed: ${r.err || r.out}`);
  await deps.notify();
  return { changed: true, previous: current.value };
}
