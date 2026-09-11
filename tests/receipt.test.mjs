import { test, after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { newReceipt, markStep, setInstalled, writeReceipt, readReceipt, receiptPath } from '../installer/lib/receipt.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-receipt-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('receipt round-trip and atomic write', () => {
  const root = path.join(tmp, 'NOVA');
  const r = newReceipt({ root, name: 'NOVA', manifest: { package: { version: '1.0.0', guideVersion: '10', built: 'x' } }, createdBy: 'package-installer' });
  assert.equal(r.schema, 1); assert.equal(r.steps.precheck, 'pending'); assert.equal(r.soul.name, 'NOVA');
  markStep(r, 'precheck', 'done'); setInstalled(r, 'node', { version: '24.17.0', path: '_agent\\shared\\tools\\node', verified: true });
  writeReceipt(root, r); const back = readReceipt(root);
  assert.equal(back.steps.precheck, 'done'); assert.equal(back.installed.node.version, '24.17.0'); assert.ok(!fs.existsSync(receiptPath(root) + '.tmp'));
  assert.equal(readReceipt(path.join(tmp, 'nope')), null);
});
