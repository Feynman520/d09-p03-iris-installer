import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

test('teamclaude-manage.ps1 copy stays ASCII-only', () => {
  const text = fs.readFileSync(path.resolve('patches/teamclaude/teamclaude-manage.ps1'), 'utf8');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) throw new Error(`non-ASCII char 0x${code.toString(16)} at offset ${i}`);
  }
});
