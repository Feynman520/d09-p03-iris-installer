import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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
  const mismatches = [];
  for (const f of rules.files) {
    assert.ok(f.path.startsWith(PKG_PREFIX), `unexpected rule path shape: ${f.path}`);
    const rel = f.path.slice(PKG_PREFIX.length);
    const patchedPath = path.join(installRoot, f.path);
    const livePath = path.join(liveSnapshot, rel);
    const patched = fs.readFileSync(patchedPath);
    const live = fs.readFileSync(livePath);
    if (!patched.equals(live)) mismatches.push(rel);
  }
  assert.deepEqual(mismatches, [], `files not byte-identical to the live install after patching: ${mismatches.join(', ')}`);
});

test('teamclaude-manage.ps1 copy stays ASCII-only', () => {
  const text = fs.readFileSync(path.resolve('patches/teamclaude/teamclaude-manage.ps1'), 'utf8');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) throw new Error(`non-ASCII char 0x${code.toString(16)} at offset ${i}`);
  }
});
