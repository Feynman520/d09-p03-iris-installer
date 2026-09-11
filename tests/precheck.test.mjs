import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheck } from '../installer/lib/precheck.mjs';

// Network may be off in CI/offline dev boxes -- this only asserts the shape
// and the fields that are environment-independent on this platform (x64,
// free disk space is never negative), never the net/browser booleans
// themselves.
test('precheck shape (network may be off)', async () => {
  const p = await precheck({ timeoutMs: 1500 });
  assert.equal(typeof p.os.ok, 'boolean');
  assert.equal(p.arch.value, 'x64');
  assert.ok(p.disk.freeGB >= 0);
  assert.equal(typeof p.net.claude, 'boolean');
  assert.equal(typeof p.net.chatgpt, 'boolean');
  assert.equal(typeof p.net.ok, 'boolean');
  assert.equal(typeof p.browser.ok, 'boolean');
  assert.equal(typeof p.allOk, 'boolean');
  assert.equal(typeof p.canProceedOffline, 'boolean');
  // canProceedOffline must not depend on net -- flipping net.ok alone must
  // never change it.
  assert.equal(p.canProceedOffline, p.os.ok && p.arch.ok && p.disk.ok && p.browser.ok);
});

test('precheck never throws even with a near-zero timeout', async () => {
  const p = await precheck({ timeoutMs: 1 });
  assert.equal(typeof p.allOk, 'boolean');
});
