import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { sha256File, buildManifest, verifyManifest } from '../lib/manifest.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-mf-'));
test('sha256File matches known vector', async () => {
  const f = path.join(tmp, 'a.txt'); fs.writeFileSync(f, 'abc');
  assert.equal(await sha256File(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('build then verify ok; tamper → mismatch', async () => {
  const payload = path.join(tmp, 'payload'); fs.mkdirSync(path.join(payload, 'node'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'node/n.zip'), 'zip');
  const lock = { package: { version: '1.0.0', guideVersion: '10' }, parts: { node: { version: '24.17.0', file: 'node/n.zip' } } };
  const m = await buildManifest({ payloadDir: payload, lock, faceVersion: '2.29.0' });
  assert.equal(m.schema, 1); assert.equal(m.parts.node.bytes, 3); assert.equal(m.package.name, 'IRIS');
  assert.deepEqual(await verifyManifest(payload, m), { ok: true, mismatches: [] });
  fs.writeFileSync(path.join(payload, 'node/n.zip'), 'zip!');
  const r = await verifyManifest(payload, m); assert.equal(r.ok, false); assert.equal(r.mismatches[0].file, 'node/n.zip');
});
