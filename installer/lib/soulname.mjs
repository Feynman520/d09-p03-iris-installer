import fs from 'node:fs';

// Guide 2-1 name rules + Task 2 measurement (docs/실측-2026-09-11.md #2):
// node-pty (health check, session spawn, daemon.log) all worked without
// issue under a Korean soul root (C:\비서시험) -- see that doc's
// `soulName.koreanAllowed = true` line. So a Korean soul name is allowed;
// this constant is the single place that decision lives.
export const KOREAN_ALLOWED = true;

// Windows forbids these characters (plus control chars) in a path segment
// outright, regardless of KOREAN_ALLOWED.
const FORBIDDEN_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
// A trailing dot or space is silently stripped by the Windows shell/NTFS
// APIs and produces a different actual path than what the user typed.
const TRAILING_DOT_OR_SPACE = /[. ]$/;

// Reserved MS-DOS device names -- reserved with or without an extension
// (CON, CON.txt, COM1.log, ...).
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

// Well-known top-level Windows folders -- picking one of these as the soul
// name would collide with the real system folder at C:\<name>.
const SYSTEM_FOLDER_NAMES = new Set([
  'windows', 'users', 'program files', 'program files (x86)', 'programdata',
  'perflogs', 'recovery', '$recycle.bin', 'system volume information',
]);

// Used only when KOREAN_ALLOWED is false -- brief's verbatim ASCII rule.
const ASCII_SAFE_NAME = /^[A-Za-z0-9_-]+$/;

function isReservedDeviceName(name) {
  const dot = name.indexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  return RESERVED_DEVICE_NAMES.has(base.toLowerCase());
}

// validateSoulName(name) -> {ok, path?, reason?}
// reason taxonomy (checked in this exact order): empty -> chars -> trailing
// -> reserved (Windows device name) -> system (well-known folder) -> korean
// (KOREAN_ALLOWED=false and name has non-ASCII/symbol characters).
export function validateSoulName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (FORBIDDEN_CHARS.test(name)) {
    return { ok: false, reason: 'chars' };
  }
  if (TRAILING_DOT_OR_SPACE.test(name)) {
    return { ok: false, reason: 'trailing' };
  }
  if (isReservedDeviceName(name)) {
    return { ok: false, reason: 'reserved' };
  }
  if (SYSTEM_FOLDER_NAMES.has(name.toLowerCase())) {
    return { ok: false, reason: 'system' };
  }
  if (!KOREAN_ALLOWED && !ASCII_SAFE_NAME.test(name)) {
    return { ok: false, reason: 'korean' };
  }
  return { ok: true, path: `C:\\${name}` };
}

// detectExisting(rootPath) -> 'none' | 'soul' | 'conflict'
// Read-only probe -- never creates rootPath. NTFS/reparse-point checks are
// done again right before the actual copy in Task 12's install().
export function detectExisting(rootPath) {
  let entries;
  try {
    entries = fs.readdirSync(rootPath);
  } catch {
    return 'none'; // does not exist (or is not a readable directory)
  }
  if (entries.includes('soul-state.json')) return 'soul';
  if (entries.length > 0) return 'conflict';
  return 'none';
}
