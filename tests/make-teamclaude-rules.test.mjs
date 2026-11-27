import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyPatches } from '../build/patch-teamclaude.mjs';
import { splitLines, diffLines, deriveReplaceRules, extendRules } from '../build/make-teamclaude-rules.mjs';

const NL = String.fromCharCode(10);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-mkrules-test-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const lines = (...xs) => xs.join(NL) + NL;

// The patcher's own contract, restated: every find exactly `count` times, in order.
function applyLikeThePatcher(text, rules) {
  let out = text;
  rules.forEach((r, i) => {
    const n = out.split(r.find).length - 1;
    assert.equal(n, r.count ?? 1, `rule #${i} must anchor exactly once (found ${n})`);
    out = out.split(r.find).join(r.with);
  });
  return out;
}

test('splitLines keeps every terminator so any slice joins back to the original bytes', () => {
  for (const text of ['', 'a', `a${NL}`, `a${NL}b`, `a\r${NL}b\r${NL}`, `${NL}${NL}x`]) {
    assert.equal(splitLines(text).join(''), text);
  }
  assert.deepEqual(splitLines(`a${NL}b`), [`a${NL}`, 'b']);
});

test('diffLines reports changed blocks as line ranges (insert, delete, change, both ends)', () => {
  const a = ['1', '2', '3', '4', '5'];
  assert.deepEqual(diffLines(a, a), []);
  assert.deepEqual(diffLines(a, ['1', '2', 'x', '3', '4', '5']), [{ aStart: 2, aEnd: 2, bStart: 2, bEnd: 3 }]);
  assert.deepEqual(diffLines(a, ['1', '2', '4', '5']), [{ aStart: 2, aEnd: 3, bStart: 2, bEnd: 2 }]);
  assert.deepEqual(diffLines(a, ['0', '1', '2', '3', '4', '5', '6']), [
    { aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 },
    { aStart: 5, aEnd: 5, bStart: 6, bEnd: 7 },
  ]);
  assert.deepEqual(diffLines([], ['x']), [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }]);
  assert.deepEqual(diffLines(['x'], []), [{ aStart: 0, aEnd: 1, bStart: 0, bEnd: 0 }]);
});

test('deriveReplaceRules: an inserted block is anchored on neighbour lines that occur exactly once', () => {
  // "}" and "  return 1;" both repeat, so the rule has to grow until it is unique.
  const base = lines('function a() {', '  return 1;', '}', 'function b() {', '  return 1;', '}');
  const target = lines('function a() {', '  return 1;', '}', 'function b() {', '  log();', '  return 1;', '}');
  const rules = deriveReplaceRules(base, target);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].count, 1);
  assert.ok(rules[0].find.length > 0);
  assert.equal(applyLikeThePatcher(base, rules), target);
});

test('deriveReplaceRules: far-apart changes become separate rules, close ones merge into one', () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const far = [...body]; far[3] = 'changed 3'; far[30] = 'changed 30';
  const farRules = deriveReplaceRules(lines(...body), lines(...far));
  assert.equal(farRules.length, 2);
  assert.equal(applyLikeThePatcher(lines(...body), farRules), lines(...far));

  const near = [...body]; near[10] = 'changed 10'; near[12] = 'changed 12';
  const nearRules = deriveReplaceRules(lines(...body), lines(...near));
  assert.equal(nearRules.length, 1);
  assert.equal(applyLikeThePatcher(lines(...body), nearRules), lines(...near));
});

test('deriveReplaceRules: a later rule still anchors once after an earlier rule added look-alike text', () => {
  // The first change inserts a copy of the very lines the second change sits next to.
  const base = lines('head', 'keep A', 'mid 1', 'mid 2', 'mid 3', 'mid 4', 'mid 5', 'keep A', 'old tail');
  const target = lines('head', 'keep A', 'old tail', 'keep A', 'mid 1', 'mid 2', 'mid 3', 'mid 4', 'mid 5', 'keep A', 'new tail');
  const rules = deriveReplaceRules(base, target);
  assert.equal(applyLikeThePatcher(base, rules), target);
});

test('deriveReplaceRules: backslash escapes, CRLF and a missing final newline survive untouched', () => {
  const base = `const re = /\\r?\\n/;\r${NL}const p = 'C:\\\\tmp\\\\a';\r${NL}tail`;
  const target = `const re = /\\r?\\n/g;\r${NL}const p = 'C:\\\\tmp\\\\a';\r${NL}const q = "\\u00e9\\t";\r${NL}tail2`;
  const rules = deriveReplaceRules(base, target);
  assert.equal(applyLikeThePatcher(base, rules), target);
  // and through JSON, the way rules.json carries them
  assert.equal(applyLikeThePatcher(base, JSON.parse(JSON.stringify(rules))), target);
  assert.deepEqual(deriveReplaceRules(base, base), []);
});

test('deriveReplaceRules: randomised edits always reproduce the target', () => {
  let seed = 20261127;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 60; round++) {
    const a = Array.from({ length: 30 + rnd(60) }, () => `v${rnd(12)}`); // few distinct lines: lots of repeats
    const b = [...a];
    for (let e = 0; e < 1 + rnd(8); e++) {
      const at = rnd(b.length + 1);
      const kind = rnd(3);
      if (kind === 0) b.splice(at, 0, `n${rnd(5)}`);
      else if (kind === 1 && b.length > 1) b.splice(Math.min(at, b.length - 1), 1);
      else if (b.length) b[Math.min(at, b.length - 1)] = `c${rnd(5)}`;
    }
    const base = lines(...a);
    const target = rnd(4) === 0 ? b.join(NL) : lines(...b);
    assert.equal(applyLikeThePatcher(base, deriveReplaceRules(base, target)), target, `round ${round}`);
  }
});

test('extendRules appends on top of existing rules and the real patcher then reproduces the target tree', async () => {
  const PKG = ['node_modules', '@karpeleslab', 'teamclaude'];
  const mk = (name) => { const d = path.join(tmp, name, ...PKG); fs.mkdirSync(path.join(d, 'src'), { recursive: true }); return d; };
  const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

  const pristine = mk('pristine');
  put(pristine, 'package.json', lines('{ "name": "x" }'));
  put(pristine, 'src/has-rules.js', lines('alpha();', 'beta();', 'gamma();', 'delta();', 'omega();'));
  put(pristine, 'src/no-rules.js', lines('one();', 'two();', 'three();'));
  put(pristine, 'src/untouched.js', lines('same();'));

  const P = 'node_modules/@karpeleslab/teamclaude/';
  const current = {
    files: [
      { path: `${P}src/has-rules.js`, replace: [{ find: 'beta();', with: 'beta(); // patched', count: 1 }] },
      { path: `${P}src/made.js`, create: lines('export const v = 1;') },
    ],
  };
  const before = JSON.stringify(current);

  // pristine + current rules
  fs.cpSync(path.join(tmp, 'pristine'), path.join(tmp, 'patched'), { recursive: true });
  await applyPatches(path.join(tmp, 'patched'), current, () => {});

  const target = mk('target');
  put(target, 'package.json', lines('{ "name": "x" }'));
  put(target, 'src/has-rules.js', lines('alpha();', 'beta(); // patched', 'gamma();', 'delta(); // second round', 'omega();'));
  put(target, 'src/no-rules.js', lines('one();', 'two(2);', 'three();'));
  put(target, 'src/untouched.js', lines('same();'));
  put(target, 'src/made.js', lines('export const v = 2;'));
  put(target, 'src/brand-new.js', lines('export const fresh = true;'));
  put(target, 'brand-new.test.mjs', lines('// test'));

  const { rules: next, summary, notInTarget } = extendRules(current, {
    pristineDir: pristine,
    patchedDir: path.join(tmp, 'patched', ...PKG),
    targetDir: target,
  });
  assert.equal(JSON.stringify(current), before, 'the rules object passed in is not modified');
  assert.deepEqual(notInTarget, []);
  assert.deepEqual(summary.map((s) => `${s.file}: ${s.action}`).sort(), [
    'brand-new.test.mjs: new create entry',
    'src/brand-new.js: new create entry',
    'src/has-rules.js: replace rules appended',
    'src/made.js: create text renewed',
    'src/no-rules.js: new replace entry',
  ]);
  // existing rules are kept in place and in order; new ones come after
  assert.deepEqual(next.files[0].replace[0], current.files[0].replace[0]);
  assert.equal(next.files[0].replace.length, 2);
  assert.deepEqual(next.files.slice(0, 2).map((f) => f.path), current.files.map((f) => f.path));

  fs.cpSync(path.join(tmp, 'pristine'), path.join(tmp, 'proof'), { recursive: true });
  await applyPatches(path.join(tmp, 'proof'), next, () => {});
  for (const rel of ['package.json', 'src/has-rules.js', 'src/no-rules.js', 'src/untouched.js', 'src/made.js', 'src/brand-new.js', 'brand-new.test.mjs']) {
    assert.ok(fs.readFileSync(path.join(tmp, 'proof', ...PKG, rel)).equals(fs.readFileSync(path.join(target, rel))), rel);
  }

  // a second run has nothing left to add
  const again = extendRules(next, { pristineDir: pristine, patchedDir: path.join(tmp, 'proof', ...PKG), targetDir: target });
  assert.deepEqual(again.summary, []);
  assert.equal(JSON.stringify(again.rules), JSON.stringify(next));
});
