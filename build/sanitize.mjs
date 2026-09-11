import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractZip } from '../lib/zip.mjs';
import { globMatch } from '../lib/glob.mjs';

const SNIFF_BYTES = 8 * 1024; // first 8KB decides text vs binary
const MAX_TEXT_CHECK_BYTES = 20 * 1024 * 1024; // files bigger than this skip content checks

function compileRegexRules(list) {
  return (list ?? []).map((entry) => {
    const isObj = typeof entry === 'object' && entry !== null;
    const pattern = isObj ? entry.pattern : entry;
    const skipUnder = isObj ? (entry.skipUnder ?? []) : [];
    return { regex: new RegExp(pattern), pattern, skipUnder };
  });
}

function underSkippedSegment(logicalPath, skipUnder) {
  const segs = logicalPath.split('/');
  return skipUnder.some((s) => segs.includes(s.replace(/\/$/, '')));
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

  if (/\.zip$/i.test(absPath)) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-sanitize-'));
    try {
      await extractZip(absPath, tmpDir);
      await walk(tmpDir, `${logicalPath}!`, ctx);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
  }

  const stat = fs.statSync(absPath);

  if (typeof rules.maxBytes === 'number' && stat.size > rules.maxBytes) {
    warnings.push(`${logicalPath}: ${stat.size} bytes exceeds maxBytes ${rules.maxBytes}`);
  }

  if (stat.size > MAX_TEXT_CHECK_BYTES) {
    warnings.push(`${logicalPath}: ${stat.size} bytes exceeds ${MAX_TEXT_CHECK_BYTES}, content check skipped`);
    return;
  }

  if (isBinarySniff(absPath, stat.size)) return; // binary: names already checked above, skip content checks

  const exempt = (rules.allowFiles ?? []).some((g) => globMatch(g, logicalPath));
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

export async function sanitize(rootDir, rules) {
  const hits = [];
  const warnings = [];
  const compiledRegex = compileRegexRules(rules.forbiddenRegex);
  const ctx = { rules, compiledRegex, hits, warnings };
  await walk(rootDir, '', ctx);
  return { ok: hits.length === 0, hits, warnings };
}
