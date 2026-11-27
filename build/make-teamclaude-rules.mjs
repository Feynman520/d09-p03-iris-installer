// Extends patches/teamclaude/rules.json so that
//   pristine @karpeleslab/teamclaude@<version>  +  rules  ==  <target relay folder>
//
// usage (from the repository root):
//   node build/make-teamclaude-rules.mjs --target <relay package folder> [--write]
//        [--pristine <npm prefix that already holds the pristine install>]
//        [--rules patches/teamclaude/rules.json] [--version 1.1.16]
//
// Without --write it only prints what would change (preview). <target> is a
// folder shaped like the installed package (package.json, src/, *.test.mjs),
// e.g. the relay working copy or a patched install. It is only ever READ.
//
// What it does, in the order build/patch-teamclaude.mjs applies rules:
//   1. takes a pristine install (npm install -g --prefix <temp>, or --pristine),
//      applies the CURRENT rules to a copy of it;
//   2. compares that tree with <target>, file by file;
//   3. for every file that differs it appends rules on top of the existing
//      ones -- nothing already in rules.json is rewritten:
//        - a file with a `replace` entry   -> more `replace` rules at the end
//        - a pristine file with no entry   -> a new `replace` entry
//        - a file with a `create` entry    -> its `create` text is renewed
//        - a file absent from pristine     -> a new `create` entry
//   4. applies the NEW rules to a second pristine copy and refuses to write
//      unless every file equals <target> byte for byte.
//
// The `replace` rules are derived from a line diff, never typed by hand: each
// changed block becomes one { find, with, count: 1 } whose `find` is the old
// block plus just enough unchanged neighbour lines to occur exactly once in
// the text the rule will see (the same "exactly `count` times" contract the
// patcher enforces). Blocks a few lines apart are merged into one rule.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyPatches } from './patch-teamclaude.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const PKG_PREFIX = 'node_modules/@karpeleslab/teamclaude/';
const NL = String.fromCharCode(10);

// Unchanged lines between two changed blocks at or below this count put both
// blocks into one rule (one rule per place the code was touched, not per line).
const MERGE_GAP_LINES = 3;

// "a<NL>b<NL>c" -> ["a<NL>", "b<NL>", "c"]: every line keeps its own
// terminator, so joining any slice gives back the exact original bytes
// (a missing final newline, or CRLF, needs no special case).
export function splitLines(text) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(NL, from);
    if (at === -1) break;
    out.push(text.slice(from, at + 1));
    from = at + 1;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

// Same counting the patcher uses (non-overlapping occurrences).
function countOf(text, find) {
  if (find.length === 0) return 0;
  return text.split(find).length - 1;
}

// Myers O(ND) line diff. Returns the changed blocks as half-open line ranges
// { aStart, aEnd, bStart, bEnd }, in order.
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  if (n === 0 && m === 0) return [];

  const max = n + m;
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(off - d - 1 < 0 ? 0 : off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }

  // Walk the saved rows back from the end to recover which lines matched.
  const matchedA = new Uint8Array(n);
  const matchedB = new Uint8Array(m);
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const row = trace[d];
    const base = off - d - 1 < 0 ? 0 : off - d - 1; // index in `v` of row[0]
    const at = (k) => row[off + k - base];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; matchedA[x] = 1; matchedB[y] = 1; }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; matchedA[x] = 1; matchedB[y] = 1; }

  const hunks = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && matchedA[i] && matchedB[j]) { i++; j++; continue; }
    const aStart = i;
    const bStart = j;
    while (i < n && !matchedA[i]) i++;
    while (j < m && !matchedB[j]) j++;
    hunks.push({ aStart: aStart + pre, aEnd: i + pre, bStart: bStart + pre, bEnd: j + pre });
  }
  return hunks;
}

function mergeNear(hunks, gap) {
  const out = [];
  for (const h of hunks) {
    const last = out[out.length - 1];
    if (last && h.aStart - last.aEnd <= gap) { last.aEnd = h.aEnd; last.bEnd = h.bEnd; }
    else out.push({ ...h });
  }
  return out;
}

// The `replace` rules that turn baseText into targetText when applied in
// array order. Throws if they would not (never returns an unverified list).
export function deriveReplaceRules(baseText, targetText, { mergeGap = MERGE_GAP_LINES } = {}) {
  if (baseText === targetText) return [];
  const a = splitLines(baseText);
  const b = splitLines(targetText);
  const hunks = mergeNear(diffLines(a, b), mergeGap);
  const rules = [];
  for (const h of hunks) {
    // What the rule will see: everything before this block already rewritten
    // (target lines), this block and everything after it still old.
    const cur = [...b.slice(0, h.bStart), ...a.slice(h.aStart)];
    const curText = cur.join('');
    const oldLen = h.aEnd - h.aStart;
    let before = 0;
    let after = 0;
    let find = cur.slice(h.bStart, h.bStart + oldLen).join('');
    let offset = cur.slice(0, h.bStart).join('').length;
    let turn = 0;
    // "Exactly once" here is stricter than the patcher's count: the one
    // occurrence must be THIS block, and no second one may exist even
    // overlapping it (the patcher counts non-overlapping pieces, so a
    // look-alike that overlaps would pass its count and patch the wrong place).
    const onlyHere = () => find.length > 0 && curText.indexOf(find) === offset && curText.indexOf(find, offset + 1) === -1;
    while (!onlyHere()) {
      const canBefore = h.bStart - before > 0;
      const canAfter = h.bStart + oldLen + after < cur.length;
      if (!canBefore && !canAfter) throw new Error('could not anchor a changed block (whole file is not unique?)');
      if ((turn % 2 === 0 && canBefore) || !canAfter) { before++; offset -= cur[h.bStart - before].length; } else after++;
      turn++;
      find = cur.slice(h.bStart - before, h.bStart + oldLen + after).join('');
    }
    const withText = [
      ...cur.slice(h.bStart - before, h.bStart),
      ...b.slice(h.bStart, h.bEnd),
      ...cur.slice(h.bStart + oldLen, h.bStart + oldLen + after),
    ].join('');
    rules.push({ find, with: withText, count: 1 });
  }
  let text = baseText;
  for (const r of rules) {
    if (countOf(text, r.find) !== 1) throw new Error('derived rule does not anchor exactly once');
    text = text.split(r.find).join(r.with);
  }
  if (text !== targetText) throw new Error('derived rules do not reproduce the target text');
  return rules;
}

function listFiles(root) {
  const out = [];
  const rec = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  rec(root, '');
  return out.sort();
}

function readText(file) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error(`not valid UTF-8 text, cannot be carried by a rule: ${file}`);
  return text;
}

// Pure planning step: `patchedDir` is pristine + current rules, `pristineDir`
// is pristine alone, `targetDir` is what the result must equal. All three are
// package folders. Returns the new rules object and a per-file summary.
export function extendRules(rules, { pristineDir, patchedDir, targetDir }) {
  const next = JSON.parse(JSON.stringify(rules));
  const byPath = new Map(next.files.map((f) => [f.path, f]));
  const summary = [];
  const targetFiles = listFiles(targetDir);
  for (const rel of targetFiles) {
    const rulePath = PKG_PREFIX + rel;
    const want = readText(path.join(targetDir, rel));
    const patchedFile = path.join(patchedDir, rel);
    const have = fs.existsSync(patchedFile) ? readText(patchedFile) : null;
    if (have === want) continue;
    const entry = byPath.get(rulePath);
    const inPristine = fs.existsSync(path.join(pristineDir, rel));
    if (entry && entry.create !== undefined) {
      entry.create = want;
      summary.push({ file: rel, action: 'create text renewed', rules: 0 });
    } else if (!inPristine) {
      const created = { path: rulePath, create: want };
      next.files.push(created);
      byPath.set(rulePath, created);
      summary.push({ file: rel, action: 'new create entry', rules: 0 });
    } else {
      const derived = deriveReplaceRules(have, want);
      if (entry) {
        entry.replace.push(...derived);
        summary.push({ file: rel, action: 'replace rules appended', rules: derived.length });
      } else {
        const fresh = { path: rulePath, replace: derived };
        next.files.push(fresh);
        byPath.set(rulePath, fresh);
        summary.push({ file: rel, action: 'new replace entry', rules: derived.length });
      }
    }
  }
  const targetSet = new Set(targetFiles);
  const notInTarget = listFiles(patchedDir).filter((rel) => !targetSet.has(rel));
  return { rules: next, summary, notInTarget };
}

function parseArgs(argv) {
  const out = { write: false, version: '1.1.16', rules: path.join(ROOT_DIR, 'patches', 'teamclaude', 'rules.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--pristine') out.pristine = argv[++i];
    else if (a === '--rules') out.rules = argv[++i];
    else if (a === '--version') out.version = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.target) throw new Error('--target <relay package folder> is required');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-mkrules-'));
  try {
    let pristinePrefix = args.pristine;
    if (!pristinePrefix) {
      pristinePrefix = path.join(scratch, 'pristine');
      fs.mkdirSync(pristinePrefix, { recursive: true });
      // Same isolated install the acceptance test does (fixed arguments only).
      execFileSync('npm', ['install', '-g', '--prefix', pristinePrefix, `@karpeleslab/teamclaude@${args.version}`, '--no-fund', '--no-audit'], {
        stdio: 'pipe',
        shell: process.platform === 'win32',
      });
    }
    const pkgOf = (prefix) => path.join(prefix, ...PKG_PREFIX.split('/').filter(Boolean));
    const rules = JSON.parse(fs.readFileSync(args.rules, 'utf8'));

    const patchedPrefix = path.join(scratch, 'patched');
    fs.cpSync(pristinePrefix, patchedPrefix, { recursive: true });
    await applyPatches(patchedPrefix, rules, () => {});

    const { rules: next, summary, notInTarget } = extendRules(rules, {
      pristineDir: pkgOf(pristinePrefix),
      patchedDir: pkgOf(patchedPrefix),
      targetDir: args.target,
    });

    // Proof before anything is written: pristine + NEW rules == target.
    const proofPrefix = path.join(scratch, 'proof');
    fs.cpSync(pristinePrefix, proofPrefix, { recursive: true });
    await applyPatches(proofPrefix, next, () => {});
    const stillDifferent = listFiles(args.target).filter((rel) => {
      const made = path.join(pkgOf(proofPrefix), rel);
      return !fs.existsSync(made) || !fs.readFileSync(made).equals(fs.readFileSync(path.join(args.target, rel)));
    });
    if (stillDifferent.length) throw new Error(`new rules do not reproduce the target: ${stillDifferent.join(', ')}`);

    for (const s of summary) console.log(`${s.action.padEnd(24)} ${s.file}${s.rules ? ` (+${s.rules})` : ''}`);
    if (!summary.length) console.log('nothing to add: pristine + rules already equals the target');
    if (notInTarget.length) console.log(`WARNING: the rules produce files the target does not have (left as they are): ${notInTarget.join(', ')}`);

    // Not a gate, only a prompt to look: rules.json is exempt from the e-mail
    // rule of the repository scan because it quotes upstream text.
    const added = JSON.stringify(next).length - JSON.stringify(rules).length;
    const mailish = new Set();
    for (const f of next.files) {
      const texts = f.create !== undefined ? [f.create] : f.replace.map((r) => r.with);
      for (const t of texts) for (const hit of t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? []) mailish.add(hit);
    }
    console.log(`e-mail-shaped strings in the rule texts (check they are examples only): ${[...mailish].sort().join(' ') || '-'}`);

    const outText = `${JSON.stringify(next, null, 2)}${NL}`;
    if (!summary.length) {
      // nothing to write; the line above already said so
    } else if (args.write) {
      fs.writeFileSync(args.rules, outText);
      console.log(`wrote ${args.rules} (${Buffer.byteLength(outText)} bytes, about +${added} characters of rule text)`);
    } else {
      console.log(`preview only (${Buffer.byteLength(outText)} bytes would be written; pass --write to save)`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`make-teamclaude-rules: ${e.message}`); process.exit(1); });
}
