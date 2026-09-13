import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sanitize } from '../build/sanitize.mjs';
import { loadRules, splitRepoStackPointers, REPO_ROOT_STACK_POINTERS } from '../build/rules.mjs';

// C2: the sanitize gate previously only ever scanned build *output*
// (payloadDir) -- it never scanned the repo's own tracked files, so a
// personal string committed directly into a tracked file (docs, lock.json,
// a patches/ script, etc.) would ship in the repo and in git history without
// ever tripping a single check. This test closes that hole: it scans every
// file `git ls-files` reports (the exact tracked set -- not node_modules,
// not _build/, not anything gitignored) with the same merged rules
// build.mjs/static.mjs use, and requires zero hits.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('repo-clean: sanitize finds 0 hits across every git-tracked file', async () => {
  // `-z` (NUL-separated, encoding 'buffer' + manual utf8 decode) is required
  // -- git's default `ls-files` output quote-escapes non-ASCII filenames
  // (e.g. every Korean docs/*.md path becomes a literal "docs/\352\262\200..."
  // string), which would silently make this scan skip every Korean-named
  // tracked file -- exactly the files that historically held personal
  // strings (2026-09-11 Fix round 1 fix).
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT_DIR, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(trackedFiles.length > 0, 'git ls-files returned no tracked files -- test would be vacuous');
  assert.ok(
    trackedFiles.some((f) => /[^\x00-\x7F]/.test(f)),
    'no non-ASCII (e.g. Korean) tracked filename found -- the -z/quotepath fix regressed or the fixture set changed',
  );

  const rules = loadRules({
    baseFile: path.join(ROOT_DIR, 'build', 'sanitize-rules.json'),
    localFile: path.join(ROOT_DIR, 'build', 'sanitize-local.json'),
  });

  // The repo's own root .stack/.supa deploy-stack pointers are the single
  // allowed exception (build/rules.mjs splitRepoStackPointers) -- this is the
  // repository, not the shipped zip. verify/static.mjs ⑦ does exactly this.
  const result = await sanitize(ROOT_DIR, rules, { files: trackedFiles });
  const { allowed, rest } = splitRepoStackPointers(result.hits);
  assert.deepEqual(rest, [], `sanitize found hit(s) in tracked files: ${JSON.stringify(rest, null, 2)}`);
  for (const hit of allowed) {
    assert.ok(REPO_ROOT_STACK_POINTERS.includes(hit.file), `unexpected allowed exception: ${hit.file}`);
  }
});

// The exception is deliberately narrow. If it ever widens -- a `.stack` under
// a subfolder, or a *content* hit inside the root one -- this repo must fail
// the gate again.
test('repo-clean: the .stack exception covers only the repo root, and only the name rule', () => {
  const hits = [
    { file: '.stack', rule: 'name:**/.stack' },
    { file: '.supa', rule: 'name:**/.supa' },
    { file: 'installer/.stack', rule: 'name:**/.stack' },
    { file: 'payload/face/iris-face.zip!/.stack', rule: 'name:**/.stack' },
    { file: '.stack', rule: 'regex:C:[\\\\/]+Users[\\\\/]+[^\\\\/]+', line: 1 },
  ];
  const { allowed, rest } = splitRepoStackPointers(hits);
  assert.deepEqual(allowed.map((h) => h.file), ['.stack', '.supa']);
  assert.deepEqual(rest.map((h) => h.file), [
    'installer/.stack',
    'payload/face/iris-face.zip!/.stack',
    '.stack', // a content hit in the root pointer is NOT excused
  ]);
});
