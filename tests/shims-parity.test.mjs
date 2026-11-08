import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentShim, posixAgentShim } from '../installer/lib/shims.mjs';

// Mirrors verify/static.mjs check ⑥: P02 daemon/wake.mjs re-implements this
// file's agentShim() byte-for-byte (see that file's header comment for why
// it cannot just import shims.mjs -- P02/P03 are separate deployed units).
// Locate P02 the same way build/collect.mjs and verify/static.mjs's check ④
// do: lock.json's parts.face.source, resolved against the repo root.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// IRIS_FACE_SOURCE wins over lock.json, exactly as in static.mjs partSource() / collect.mjs.
function faceWakePath() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8'));
  return path.join(path.resolve(ROOT_DIR, process.env.IRIS_FACE_SOURCE || lock.parts.face.source), 'daemon', 'wake.mjs');
}

test('shim template parity: P02 wake.mjs agentShimText() matches P03 shims.mjs agentShim()', async (t) => {
  const wakePath = faceWakePath();
  if (!fs.existsSync(wakePath)) {
    t.skip(`P02 not found next to this checkout: ${wakePath}`);
    return;
  }
  const { agentShimText } = await import(pathToFileURL(wakePath).href);
  for (const agent of ['claude', 'codex']) {
    assert.equal(agentShimText(agent), agentShim(agent), `agentShimText('${agent}') diverged from agentShim('${agent}')`);
  }
});

test('shim template parity (macOS): P02 wake.mjs posixAgentShimText() matches P03 posixAgentShim()', async (t) => {
  const wakePath = faceWakePath();
  if (!fs.existsSync(wakePath)) { t.skip(`P02 not found next to this checkout: ${wakePath}`); return; }
  const { posixAgentShimText } = await import(pathToFileURL(wakePath).href);
  if (!posixAgentShimText) { t.skip('this P02 has no macOS shim copy yet'); return; }
  for (const agent of ['claude', 'codex']) {
    assert.equal(posixAgentShimText(agent), posixAgentShim(agent), `posixAgentShimText('${agent}') diverged from posixAgentShim('${agent}')`);
  }
});
