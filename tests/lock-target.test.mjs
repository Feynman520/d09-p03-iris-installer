import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOverlay, loadLockForTarget, KNOWN_TARGETS } from '../build/lock-target.mjs';

// 대상별 잠금표(docs/설계-macOS.md D-M12).
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Windows 대상은 lock.json 그 자체다(바이트까지) — Windows zip 의 lock.json 이 바뀌지 않는다', () => {
  const { lock, text, target } = loadLockForTarget('win32-x64');
  assert.equal(target, 'win32-x64');
  assert.equal(text, fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8'));
  assert.equal(lock.target, undefined);
});

test('덮어쓰기 규칙: 칸은 얕게 덮고, null 부품은 빼고, null 칸은 지우고, 새 부품은 더한다', () => {
  const base = { package: { version: '1' }, parts: {
    a: { kind: 'url', url: 'A', sha256: '1', fallback: { url: 'old' }, note: 'keep' },
    b: { kind: 'url', url: 'B' },
  } };
  const out = applyOverlay(base, { target: 'darwin-arm64', parts: {
    a: { url: 'A2', fallback: { url: 'new' }, note: null, $comment: 'ignored' },
    b: null,
    c: { kind: 'file', source: 'x' },
  } });
  assert.deepEqual(out.parts.a, { kind: 'url', url: 'A2', sha256: '1', fallback: { url: 'new' } });
  assert.equal('b' in out.parts, false);
  assert.deepEqual(out.parts.c, { kind: 'file', source: 'x' });
  assert.equal(out.target, 'darwin-arm64');
  assert.equal(base.parts.a.url, 'A', '원본 객체는 그대로');
  assert.throws(() => applyOverlay(base, { target: 'beos-x86', parts: {} }), /unknown target/);
});

test('macOS 잠금표: 모든 부품이 잠겨 있고, Windows 전용 부품은 없고, 판 원칙(latest 금지)을 지킨다', () => {
  const { lock, text } = loadLockForTarget('darwin-arm64');
  assert.ok(KNOWN_TARGETS.includes(lock.target));
  for (const gone of ['hwp-automation', 'excel-automation', 'ppt-automation', 'word-automation']) {
    assert.equal(lock.parts[gone], undefined, `${gone} 는 COM 이 필요해 싣지 않는다`);
  }
  for (const [name, p] of Object.entries(lock.parts)) {
    if (p.kind === 'url' || p.kind === 'claude-release') {
      assert.match(String(p.sha256), /^[0-9a-f]{64}$/, `${name} sha256`);
      assert.ok(!/(win32|win64|win-x64|win_amd64|windows|\.exe$|\.msi$)/i.test(String(p.url)), `${name} 에 Windows 파일이 남아 있다: ${p.url}`);
    }
    if (p.kind === 'wheelhouse') assert.match(String(p.sha256), /^[0-9a-f]{64}$/, `${name} requirements.lock 지문`);
  }
  assert.ok(!/"(latest|main|HEAD)"/.test(text), '움직이는 참조 금지');
  assert.equal(lock.parts.manage.source, 'patches/teamclaude/teamclaude-manage.mjs');
  assert.ok(fs.existsSync(path.join(ROOT_DIR, lock.parts.manage.source)));
  assert.ok(fs.existsSync(path.join(ROOT_DIR, lock.parts['hooks-posix'].source)));
  assert.ok(fs.existsSync(path.join(ROOT_DIR, lock.parts.dash.patches)));
  assert.equal(lock.parts.claude.binName, 'claude');
  assert.equal(lock.parts.pyyaml.dest, '_agent/shared/tools/python/lib/python3.12/site-packages');
});

test('macOS 바퀴집: requirements 두 파일의 지문이 잠금표와 맞는다', async () => {
  const { lock } = loadLockForTarget('darwin-arm64');
  const { sha256File } = await import('../lib/manifest.mjs');
  const wh = lock.parts['document-mcp-wheelhouse'];
  assert.equal(await sha256File(path.join(ROOT_DIR, wh.requirementsLock)), wh.sha256);
  assert.equal(await sha256File(path.join(ROOT_DIR, wh.requirementsIn)), wh.requirementsInSha256);
});
