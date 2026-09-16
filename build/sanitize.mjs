import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractZip } from '../lib/zip.mjs';
import { globMatch } from '../lib/glob.mjs';

const SNIFF_BYTES = 8 * 1024; // first 8KB decides text vs binary
const MAX_TEXT_CHECK_BYTES = 20 * 1024 * 1024; // files bigger than this skip content checks

// Archives whose text contents must be scanned as if unpacked. `.hwpx` is a
// zip of XML (T08: the shipped HWPX templates are scanned for personal
// strings *inside* their XML, not just by file name -- a form's
// header/footer or document properties is exactly where a name would hide).
const ARCHIVE_RE = /\.(zip|hwpx)$/i;

// An exemption entry is either a bare glob string or {path|glob, why}. The
// object form exists so every exemption in sanitize-rules.json can say *why*
// it is safe (T08 rule: no silent exemptions). `why` is documentation only --
// nothing here reads it, but a reviewer does.
function exemptionGlob(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return entry.path ?? entry.glob ?? '';
  return '';
}

function compileRegexRules(list) {
  return (list ?? []).map((entry) => {
    const isObj = typeof entry === 'object' && entry !== null;
    const pattern = isObj ? entry.pattern : entry;
    const skipUnder = (isObj ? (entry.skipUnder ?? []) : []).map(exemptionGlob).filter(Boolean);
    return { regex: new RegExp(pattern), pattern, skipUnder };
  });
}

// skipUnder entries are glob patterns, not exact names, so e.g.
// "node-v*-win-x64.zip!" keeps matching after a vendored runtime's version
// bumps instead of needing an update here every time lock.json's node/git
// part versions change.
//
// Two shapes, decided by whether the pattern still contains a '/' after a
// trailing slash is trimmed:
//   "node_modules/" or "AGENTS.md"       -> SEGMENT glob: matches if ANY path
//                                           segment matches (a whole subtree).
//   "tools/superpowers*/**"              -> FULL-PATH glob: matches the whole
//                                           logical path. (2026-09-15, T08)
// The full-path form is what makes a narrow exemption expressible: "the email
// rule, and only the email rule, is off under this one third-party part" --
// rather than "off for every file called README.md anywhere".
function underSkippedSegment(logicalPath, skipUnder) {
  const segs = logicalPath.split('/');
  return skipUnder.some((s) => {
    const pattern = s.replace(/\/$/, '');
    if (pattern.includes('/')) return globMatch(pattern, logicalPath);
    return segs.some((seg) => globMatch(pattern, seg));
  });
}

function isBinarySniff(absPath, size) {
  if (size === 0) return false;
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

async function scanFile(absPath, logicalPath, ctx) {
  const { rules, compiledRegex, hits, warnings } = ctx;

  // Name-glob check applies unconditionally (allowFiles never exempts it).
  for (const glob of rules.forbiddenNames ?? []) {
    if (globMatch(glob, logicalPath)) hits.push({ file: logicalPath, rule: `name:${glob}` });
  }

  if (ARCHIVE_RE.test(absPath)) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-sanitize-'));
    try {
      await extractZip(absPath, tmpDir);
      await walk(tmpDir, `${logicalPath}!`, ctx);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
  }

  // fs.statSync follows symlinks. A dangling symlink (readdir's Dirent said
  // "regular file" for it -- true for a tar-extracted Unix symlink whose
  // target does not exist inside the extracted tree, e.g. an old commit's
  // .gitignore -> a path git never stored) throws ENOENT here even though the
  // directory entry itself is real. That must not crash a whole-tree scan
  // (e.g. tests/history-clean.test.mjs walking dozens of historical commits)
  // -- record it as a warning (a reviewer can see it named) and treat it as
  // unscannable rather than a leak, since there is no content to check.
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      warnings.push(`${logicalPath}: unreadable (${err.code}, likely a dangling symlink) -- content check skipped`);
      return;
    }
    throw err;
  }

  if (typeof rules.maxBytes === 'number' && stat.size > rules.maxBytes) {
    warnings.push(`${logicalPath}: ${stat.size} bytes exceeds maxBytes ${rules.maxBytes}`);
  }

  if (stat.size > MAX_TEXT_CHECK_BYTES) {
    warnings.push(`${logicalPath}: ${stat.size} bytes exceeds ${MAX_TEXT_CHECK_BYTES}, content check skipped`);
    return;
  }

  if (isBinarySniff(absPath, stat.size)) return; // binary: names already checked above, skip content checks

  const exempt = (rules.allowFiles ?? [])
    .map(exemptionGlob).filter(Boolean)
    .some((g) => globMatch(g, logicalPath));
  if (exempt) return;

  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split(/\r\n|\r|\n/);

  for (const str of rules.forbiddenStrings ?? []) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(str)) hits.push({ file: logicalPath, rule: `string:${str}`, line: i + 1 });
    }
  }

  for (const { regex, pattern, skipUnder } of compiledRegex) {
    if (underSkippedSegment(logicalPath, skipUnder)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) hits.push({ file: logicalPath, rule: `regex:${pattern}`, line: i + 1 });
    }
  }
}

async function walk(dir, logicalPrefix, ctx) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const logicalPath = logicalPrefix ? `${logicalPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(absPath, logicalPath, ctx);
    } else if (entry.isFile()) {
      await scanFile(absPath, logicalPath, ctx);
    }
  }
}

// `files`, when given, is a list of paths relative to rootDir (e.g. from
// `git ls-files`) to scan instead of walking the whole tree -- used by
// tests/repo-clean.test.mjs and verify/static.mjs's check (7) to scan
// exactly the repo's tracked files (the C2 "gate never scans the repo
// itself" fix) without also picking up _build/, node_modules/, etc.
export async function sanitize(rootDir, rules, { files } = {}) {
  const hits = [];
  const warnings = [];
  const compiledRegex = compileRegexRules(rules.forbiddenRegex);
  const ctx = { rules, compiledRegex, hits, warnings };
  if (files) {
    for (const rel of files) {
      const absPath = path.join(rootDir, rel);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) continue;
      const logicalPath = rel.split(path.sep).join('/');
      await scanFile(absPath, logicalPath, ctx);
    }
  } else {
    await walk(rootDir, '', ctx);
  }
  return { ok: hits.length === 0, hits, warnings };
}
