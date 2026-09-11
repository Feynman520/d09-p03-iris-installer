import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentShim } from '../installer/lib/shims.mjs';

// Mirrors verify/static.mjs check ⑥: P02 daemon/wake.mjs re-implements this
// file's agentShim() byte-for-byte (see that file's header comment for why
// it cannot just import shims.mjs -- P02/P03 are separate deployed units).
// Locate P02 the same way build/collect.mjs and verify/static.mjs's check ④
// do: lock.json's parts.face.source, resolved against the repo root.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('shim template parity: P02 wake.mjs agentShimText() matches P03 shims.mjs agentShim()', async (t) => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8'));
  const faceSource = path.resolve(ROOT_DIR, lock.parts.face.source);
  const wakePath = path.join(faceSource, 'daemon', 'wake.mjs');
  if (!fs.existsSync(wakePath)) {
    t.skip(`P02 not found next to this checkout: ${wakePath}`);
    return;
  }
  const { agentShimText } = await import(pathToFileURL(wakePath).href);
  for (const agent of ['claude', 'codex']) {
    assert.equal(agentShimText(agent), agentShim(agent), `agentShimText('${agent}') diverged from agentShim('${agent}')`);
  }
});
