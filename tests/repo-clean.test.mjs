import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sanitize } from '../build/sanitize.mjs';
import { loadRules } from '../build/rules.mjs';

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

  const result = await sanitize(ROOT_DIR, rules, { files: trackedFiles });
  assert.deepEqual(result.hits, [], `sanitize found hit(s) in tracked files: ${JSON.stringify(result.hits, null, 2)}`);
});
