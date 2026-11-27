import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { applyPatches } from '../build/patch-teamclaude.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-patch-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('applyPatches replaces exactly once and fails on missing anchor', async () => {
  const dir = path.join(tmp, 'p'); fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/a.js'), 'if (k.startsWith("anthropic-ratelimit-")) {');
  await applyPatches(dir, { files: [{ path: 'src/a.js', replace: [{ find: 'k.startsWith("anthropic-ratelimit-")', with: 'k.startsWith("anthropic-ratelimit-") || k.startsWith("x-codex-")', count: 1 }] }] }, () => {});
  assert.match(fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8'), /x-codex-/);
  await assert.rejects(applyPatches(dir, { files: [{ path: 'src/a.js', replace: [{ find: 'NOPE', with: 'x', count: 1 }] }] }, () => {}), /anchor mismatch src\/a.js #0/);
});

test('applyPatches creates a wholly new file that has no pristine counterpart', async () => {
  const dir = path.join(tmp, 'q'); fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  await applyPatches(dir, { files: [{ path: 'src/new.js', create: 'export const x = 1;\n' }] }, () => {});
  assert.equal(fs.readFileSync(path.join(dir, 'src/new.js'), 'utf8'), 'export const x = 1;\n');
});

test('applyPatches multi-count anchor replaces every occurrence', async () => {
  const dir = path.join(tmp, 'r'); fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/b.js'), 'a(); const reqId = ++counter; b(); const reqId = ++counter; c();');
  await applyPatches(dir, { files: [{ path: 'src/b.js', replace: [{ find: 'const reqId = ++counter;', with: 'const reqId = ++activityRequestCounter;', count: 2 }] }] }, () => {});
  const text = fs.readFileSync(path.join(dir, 'src/b.js'), 'utf8');
  assert.equal((text.match(/activityRequestCounter/g) || []).length, 2);
});

test('applyPatches rejects create when the target already exists (create is only for files absent from pristine)', async () => {
  const dir = path.join(tmp, 's'); fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/existing.js'), 'already here\n');
  await assert.rejects(
    applyPatches(dir, { files: [{ path: 'src/existing.js', create: 'new content\n' }] }, () => {}),
    /create target exists src\/existing\.js/,
  );
  // rejection must not have touched the existing file's content
  assert.equal(fs.readFileSync(path.join(dir, 'src/existing.js'), 'utf8'), 'already here\n');
});

test('applyPatches is two-phase: a later file failing its anchor check leaves an earlier file untouched on disk', async () => {
  const dir = path.join(tmp, 't'); fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/first.js'), 'const x = 1;');
  fs.writeFileSync(path.join(dir, 'src/second.js'), 'const y = 2;');
  await assert.rejects(
    applyPatches(dir, {
      files: [
        { path: 'src/first.js', replace: [{ find: 'const x = 1;', with: 'const x = 99;', count: 1 }] },
        { path: 'src/second.js', replace: [{ find: 'NOPE', with: 'z', count: 1 }] },
      ],
    }, () => {}),
    /anchor mismatch src\/second.js #0/,
  );
  // Phase 1 (compute-only) must have failed on second.js BEFORE phase 2 wrote
  // anything -- so first.js, which comes earlier in the list and whose own
  // anchor check passed, must still be unpatched on disk.
  assert.equal(fs.readFileSync(path.join(dir, 'src/first.js'), 'utf8'), 'const x = 1;');
  assert.equal(fs.readFileSync(path.join(dir, 'src/second.js'), 'utf8'), 'const y = 2;');
});

test('the real teamclaude rules.json is well-formed and self-consistent', async () => {
  const rulesPath = path.resolve('patches/teamclaude/rules.json');
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  assert.ok(Array.isArray(rules.files) && rules.files.length > 0);
  for (const f of rules.files) {
    assert.match(f.path, /^node_modules\/@karpeleslab\/teamclaude\//);
    if (f.create !== undefined) {
      assert.equal(typeof f.create, 'string');
    } else {
      assert.ok(Array.isArray(f.replace) && f.replace.length > 0);
      for (const r of f.replace) {
        assert.equal(typeof r.find, 'string');
        assert.equal(typeof r.with, 'string');
        assert.ok(r.find.length > 0);
      }
    }
  }
});

test('applyPatches on a fresh pristine install reproduces the live TeamClaude install byte-for-byte', { timeout: 180_000 }, async (t) => {
  // Acceptance test for the "derived from the live install" scope correction.
  // The live, running install (%APPDATA%\npm\node_modules\@karpeleslab\teamclaude)
  // is READ-ONLY here -- we only ever copy FROM it, into an ephemeral scratch
  // snapshot, and diff against the copy. We never point assertions at the live
  // path itself, and this test never writes into %APPDATA%.
  const liveSrc = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@karpeleslab', 'teamclaude');
  if (!process.env.APPDATA || !fs.existsSync(liveSrc)) {
    t.skip(`live TeamClaude install not found at ${liveSrc} -- this rehearsal only runs on a machine with the live install present (e.g. not on CI or a different dev machine)`);
    return;
  }

  const rulesPath = path.resolve('patches/teamclaude/rules.json');
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const PKG_PREFIX = 'node_modules/@karpeleslab/teamclaude/';
  const PRISTINE_VERSION = '1.1.16';

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-t6-live-'));
  after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

  // 1. Snapshot the live install into scratch (read from live, write only to
  //    scratch). Skip dependency node_modules -- not source, not part of any
  //    rule, and large.
  const liveSnapshot = path.join(scratch, 'live');
  fs.cpSync(liveSrc, liveSnapshot, {
    recursive: true,
    // liveSrc itself sits under npm's own node_modules, so this must check
    // only the part of the path BELOW liveSrc for a nested node_modules
    // (a dependency's own node_modules), not the ancestor path above it.
    filter: (src) => {
      if (src === liveSrc) return true;
      const rel = path.relative(liveSrc, src);
      return !rel.split(path.sep).includes('node_modules');
    },
  });

  // 2. Fresh pristine install of the exact published version this patch set
  //    was derived from, isolated to a throwaway prefix.
  const installRoot = path.join(scratch, 'install');
  fs.mkdirSync(installRoot, { recursive: true });
  // shell:true is required on Windows to resolve npm's .cmd shim; all args here
  // are fixed constants (no untrusted input), so shell interpolation is safe.
  execFileSync('npm', ['install', '-g', '--prefix', installRoot, `@karpeleslab/teamclaude@${PRISTINE_VERSION}`], {
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  // 3. Apply the real rule set to the fresh pristine install.
  await applyPatches(installRoot, rules, () => {});

  // 4. Every file the rules touch must now be byte-identical to the live
  //    snapshot.
  //
  //    One narrow, named exception (2.0.65): the relay's OWN test files that
  //    the rules carry in a newer form than the live install holds. When the
  //    2026-11-25/26 fixes were put into the live install only src/ was
  //    copied; the relay working copy's tests of those fixes were not. The
  //    package ships the tests that belong to the code it ships. Only files
  //    at the package root named *.test.js / *.test.mjs may be listed -- the
  //    running relay never loads those, so "byte-identical to what runs here"
  //    still holds for every file that runs. Each entry says HOW it is ahead,
  //    and the test fails once that stops being true, so an entry cannot
  //    outlive its reason: when the live install catches up, delete the line.
  const TESTS_AHEAD_OF_LIVE = new Map([
    // tests of the soft login-failure round; the live install has no copy
    ['auth-soft.test.mjs', 'absent'],
    // one assertion made independent of log order in the same round
    ['reject-log.test.mjs', 'differs'],
  ]);
  const mismatches = [];
  const staleExceptions = [];
  for (const f of rules.files) {
    assert.ok(f.path.startsWith(PKG_PREFIX), `unexpected rule path shape: ${f.path}`);
    const rel = f.path.slice(PKG_PREFIX.length);
    const patchedPath = path.join(installRoot, f.path);
    const livePath = path.join(liveSnapshot, rel);
    const patched = fs.readFileSync(patchedPath);
    const ahead = TESTS_AHEAD_OF_LIVE.get(rel);
    if (ahead) {
      assert.match(rel, /^[^/]+\.test\.m?js$/, `only a package-root test file may be ahead of the live install: ${rel}`);
      const liveHas = fs.existsSync(livePath);
      const stillAhead = ahead === 'absent' ? !liveHas : liveHas && !patched.equals(fs.readFileSync(livePath));
      if (!stillAhead) staleExceptions.push(`${rel} (listed as "${ahead}")`);
      continue;
    }
    const live = fs.readFileSync(livePath);
    if (!patched.equals(live)) mismatches.push(rel);
  }
  assert.deepEqual(mismatches, [], `files not byte-identical to the live install after patching: ${mismatches.join(', ')}`);
  assert.deepEqual(staleExceptions, [], `TESTS_AHEAD_OF_LIVE no longer describes the live install -- remove or correct: ${staleExceptions.join(', ')}`);
  for (const rel of TESTS_AHEAD_OF_LIVE.keys()) {
    assert.ok(rules.files.some((f) => f.path === PKG_PREFIX + rel), `TESTS_AHEAD_OF_LIVE names a file no rule carries: ${rel}`);
  }

  // 5. (2.0.65) And the other way round: the WHOLE package folder must match,
  //    not only the files a rule names. Step 4 alone cannot see a file that
  //    exists only in the live install -- a source file copied in by hand with
  //    no rule for it -- and the shipped relay would simply lack it. (A rule
  //    set that brought the eleven changed files of the 2026-11 rounds up to
  //    date but forgot the new src/google-auth.js and src/wake-guard.js would
  //    have passed step 4 and shipped a relay that cannot start.)
  const listPackage = (root) => {
    const out = [];
    const rec = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) rec(path.join(dir, e.name), r);
        else out.push(r);
      }
    };
    rec(root, '');
    return out.sort();
  };
  const madeRoot = path.join(installRoot, ...PKG_PREFIX.split('/').filter(Boolean));
  // (the test files step 4 excused are left out on both sides)
  const madeFiles = listPackage(madeRoot).filter((rel) => !TESTS_AHEAD_OF_LIVE.has(rel));
  const liveFiles = listPackage(liveSnapshot).filter((rel) => !TESTS_AHEAD_OF_LIVE.has(rel));
  assert.deepEqual(liveFiles.filter((rel) => !madeFiles.includes(rel)), [], 'files only the live install has (no rule ships them)');
  assert.deepEqual(madeFiles.filter((rel) => !liveFiles.includes(rel)), [], 'files the rules produce that the live install does not have');
  const treeMismatches = liveFiles.filter((rel) => !fs.readFileSync(path.join(madeRoot, rel)).equals(fs.readFileSync(path.join(liveSnapshot, rel))));
  assert.deepEqual(treeMismatches, [], `package files not byte-identical to the live install: ${treeMismatches.join(', ')}`);

  // 6. What the installer on a user's PC accepts as "this relay is patched"
  //    (installer/lib/install.mjs verifyTeamclaudePatches, restated here
  //    because rules are appended round after round): a `create` file equals
  //    its rule text; a `replace` file still shows the IRIS marker when any of
  //    its rules carries one, otherwise the text its FIRST rule put in. A
  //    later rule that rewrote that first text would make a correctly built
  //    relay fail the check on every new install.
  const noEvidence = [];
  for (const f of rules.files) {
    const text = fs.readFileSync(path.join(installRoot, f.path), 'utf8');
    if (f.create !== undefined) {
      if (text !== f.create) noEvidence.push(f.path);
    } else if (f.replace.some((r) => r.with.includes('IRIS'))) {
      if (!text.includes('IRIS')) noEvidence.push(f.path);
    } else if (!text.includes(f.replace[0].with)) {
      noEvidence.push(f.path);
    }
  }
  assert.deepEqual(noEvidence, [], `the installer's patch check would reject: ${noEvidence.join(', ')}`);

  // 7. The relay's own tests travel in the rules (the package-root
  //    *.test.js / *.test.mjs files). Run them here, on exactly the bytes a
  //    build would ship -- the byte comparison above says "same as the live
  //    install", this says "and that code passes its own tests".
  //
  //    They only use loopback servers on free ports, temp folders and fake
  //    tokens. The environment below makes that true even by accident: no
  //    Windows balloon, no wake guard (the one part that would look at the
  //    login servers after a sleep), and the two default file locations --
  //    the relay config and the Google stop file -- pointed into scratch so
  //    nothing can land next to this PC's real relay config. The live relay
  //    on its own port is never contacted.
  await t.test("the relay's own tests pass on the patched pristine install", () => {
    const relayScratch = path.join(scratch, 'relay-tests');
    fs.mkdirSync(relayScratch, { recursive: true });
    const env = {
      ...process.env,
      TEAMCLAUDE_NOTIFY: '0',
      TEAMCLAUDE_WAKE_GUARD: '0',
      TEAMCLAUDE_CONFIG: path.join(relayScratch, 'teamclaude.json'),
      IRIS_GATE_GOOGLE_HALT_FILE: path.join(relayScratch, 'google-halt.json'),
    };
    // Set by the test runner we are inside; a nested runner that inherits it
    // reports to its parent instead of deciding its own exit code.
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-timeout=120000'], {
      cwd: madeRoot, env, encoding: 'utf8', timeout: 150_000, windowsHide: true,
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const count = (label) => Number((out.match(new RegExp(`^ℹ ${label} (\\d+)$`, 'm')) ?? [])[1] ?? NaN);
    assert.equal(run.status, 0, `relay tests failed (exit ${run.status}${run.error ? `, ${run.error.message}` : ''}):\n${out.slice(-3000)}`);
    assert.equal(count('fail'), 0, out.slice(-3000));
    // every test file the rules carry was actually picked up and run
    const carried = rules.files.map((f) => f.path.slice(PKG_PREFIX.length)).filter((rel) => /^[^/]+\.test\.m?js$/.test(rel));
    assert.ok(carried.length >= 9, `expected the relay test files in the rules, found ${carried.length}`);
    assert.ok(count('pass') >= carried.length, `only ${count('pass')} relay test(s) ran for ${carried.length} test file(s)`);
    t.diagnostic(`relay tests: ${count('pass')} passed across ${carried.length} file(s)`);
  });
});

test('teamclaude-manage.ps1 copy stays ASCII-only', () => {
  const text = fs.readFileSync(path.resolve('patches/teamclaude/teamclaude-manage.ps1'), 'utf8');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) throw new Error(`non-ASCII char 0x${code.toString(16)} at offset ${i}`);
  }
});

test('teamclaude-manage.ps1 accepts an -EntryPath override parameter', () => {
  const text = fs.readFileSync(path.resolve('patches/teamclaude/teamclaude-manage.ps1'), 'utf8');
  assert.match(text, /\[string\]\$EntryPath/);
  // The override must actually be used, not just declared and ignored --
  // the hardcoded %APPDATA%\npm\... default should remain only as a
  // fallback inside an `if ($EntryPath) { ... } else { ... }`.
  assert.match(text, /\$entryPath = if \(\$EntryPath\) \{ \$EntryPath \} else \{/);
});
