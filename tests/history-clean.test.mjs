import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { extractZip } from '../lib/zip.mjs';
import { sanitize } from '../build/sanitize.mjs';
import { loadRules } from '../build/rules.mjs';

// C1 (2026-09-11 Fix round 2): personal strings previously survived in
// *ancestor* commits' blob content (docs/설계.md, docs/구현계획.md, older
// docs/검증기록.md and docs/실측-2026-09-11.md revisions, plus older
// build/sanitize-rules.json, patches/teamclaude/teamclaude-manage.ps1 and
// tests/sanitize.test.mjs blobs) even after the working tree and HEAD were
// clean -- check ⑦ / repo-clean.test.mjs only ever scanned the current
// checkout, so a scrubbed-looking HEAD could still ship a dirty history to
// a public GitHub push (Task 20). This test closes that hole: it walks
// every commit reachable from any ref (`git rev-list --all`), materializes
// each commit's full tree, and requires the same merged rules
// (build.mjs/static.mjs/repo-clean.test.mjs) to find 0 hits in every one.
//
// Tree materialization uses `git archive --format=zip` + this project's own
// `extractZip` (lib/zip.mjs) rather than shelling out to a bare `tar`
// -- extractZip already solves two Windows-specific traps that a naive
// `tar -xf` hits on this machine: (a) this repo's folder name contains
// `〖`/`〗`, which breaks cp949 ANSI argv passing to tar.exe unless the
// Windows 8.3 short path is used first, and (b) some `tar` binaries
// (e.g. MSYS/Git-Bash's, as opposed to the Windows-native
// C:\Windows\System32\tar.exe that extractZip invokes explicitly)
// misparse a bare drive-letter path like `C:\...` as a remote scp-style
// `host:path` spec and fail every extraction silently under a loose
// try/catch -- which is exactly the false-negative "0 hits" trap this
// project's own history-scrub verification hit and had to fix (see
// task-8-report.md Fix round 2).
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('history-clean: sanitize finds 0 hits in every commit reachable from any ref', async () => {
  const shas = execFileSync('git', ['rev-list', '--all'], { cwd: ROOT_DIR, encoding: 'utf8' })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(shas.length > 0, 'git rev-list --all returned no commits -- test would be vacuous');

  const rules = loadRules({
    baseFile: path.join(ROOT_DIR, 'build', 'sanitize-rules.json'),
    localFile: path.join(ROOT_DIR, 'build', 'sanitize-local.json'),
  });

  const badCommits = [];
  for (const sha of shas) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-history-clean-'));
    try {
      const zipPath = path.join(tmpDir, 'commit.zip');
      execFileSync('git', ['archive', '--format=zip', '-o', zipPath, sha], { cwd: ROOT_DIR });
      const treeDir = path.join(tmpDir, 'tree');
      await extractZip(zipPath, treeDir);
      const extracted = fs.readdirSync(treeDir);
      // A commit with a genuinely empty tree is not expected in this repo's
      // history -- if extraction silently produced nothing, that means the
      // materialization step failed (not that sanitize() legitimately saw
      // an empty tree), so this must fail loudly rather than pass vacuously.
      assert.ok(extracted.length > 0, `commit ${sha}: extraction produced 0 files -- materialization failed, cannot trust a scan of it`);

      const result = await sanitize(treeDir, rules);
      if (!result.ok) {
        badCommits.push({ sha, hits: result.hits });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  assert.deepEqual(badCommits, [], `sanitize found hit(s) in ${badCommits.length} historical commit(s): ${JSON.stringify(badCommits, null, 2)}`);
});
