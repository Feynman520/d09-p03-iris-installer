import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../installer/server.mjs';
import { saveState } from '../installer/lib/state.mjs';

// 2026-09-14 (second PC): the installer mirrors its wizard step to a state
// file so a browser refresh resumes in place. Re-running a NEWER zip on that
// PC resumed at the old run's 'handoff' step, so the copy step never ran and
// the handoff named a guide that was never copied. A saved state now belongs
// to the package version that wrote it; a different version starts over.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-server-state-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function fakeZip(name, version, guideVersion = '13') {
  const zr = path.join(tmp, name);
  fs.mkdirSync(path.join(zr, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(zr, 'payload', 'manifest.json'),
    JSON.stringify({ schema: 1, package: { name: 'IRIS', version, guideVersion }, parts: {} }), 'utf8');
  return zr;
}
const nodeDir = path.dirname(process.execPath);

test('saved progress from a different package version is discarded; the same version resumes', async () => {
  const stateFile = path.join(tmp, 'state-a.json');
  saveState(stateFile, { step: 'handoff', zipRoot: 'C:\\old', nodeDir, packageVersion: '1.4.0', soul: { name: 'IRIS', root: 'C:\\IRIS', existing: 'soul' } });

  // newer zip over the saved 'handoff' state -> starts from precheck, soul forgotten
  const zrNew = fakeZip('zip-new', '1.4.4');
  const s1 = await startServer({ port: 0, zipRoot: zrNew, nodeDir, stateFile });
  const h1 = await (await fetch(`${s1.url}/api/health`)).json();
  assert.equal(h1.version, '1.4.4');
  assert.equal(h1.step, 'precheck', 'a different package version must not resume the old run');
  const saved1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved1.packageVersion, '1.4.4', 'the state now records the package that wrote it');
  assert.equal(saved1.soul, undefined);
  await s1.close();

  // same version again (browser refresh / re-run of the same zip) -> resumes where it was
  saveState(stateFile, { step: 'login', zipRoot: zrNew, nodeDir, packageVersion: '1.4.4' });
  const s2 = await startServer({ port: 0, zipRoot: zrNew, nodeDir, stateFile });
  const h2 = await (await fetch(`${s2.url}/api/health`)).json();
  assert.equal(h2.step, 'login', 'the same package version resumes in place');
  await s2.close();

  // a legacy state with no packageVersion at all (written by 1.4.3 and earlier) is treated as foreign
  saveState(stateFile, { step: 'done', zipRoot: zrNew, nodeDir });
  const s3 = await startServer({ port: 0, zipRoot: zrNew, nodeDir, stateFile });
  const h3 = await (await fetch(`${s3.url}/api/health`)).json();
  assert.equal(h3.step, 'precheck');
  await s3.close();
});

test('handoff refuses when the receipt on disk carries a different guide version than this zip', async () => {
  const zr = fakeZip('zip-guide', '1.4.4', '13');
  const root = path.join(tmp, 'IRIS-guide');
  fs.mkdirSync(root, { recursive: true });
  const stateFile = path.join(tmp, 'state-b.json');
  saveState(stateFile, {
    step: 'handoff', zipRoot: zr, nodeDir, packageVersion: '1.4.4',
    soul: { name: 'IRIS', root, existing: 'soul' }, choice: { subscriptions: ['claude'], leadAgent: 'claude', guideEdition: 'claude' },
  });
  let wrote = 0;
  const s = await startServer({
    port: 0, zipRoot: zr, nodeDir, stateFile,
    readReceiptFn: () => ({ package: { version: '1.4.0', guideVersion: '10' }, steps: { copy: 'done' } }),
    writeFirstRequestFn: () => { wrote += 1; throw new Error('must not be reached'); },
  });
  const r = await fetch(`${s.url}/api/handoff`, { method: 'POST', headers: { 'content-type': 'application/json', origin: s.url }, body: '{}' });
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.where, 'guide-version');
  assert.equal(body.reason, 'guide_version_mismatch');
  assert.match(body.detail, /v10/);
  assert.match(body.detail, /v13/);
  assert.equal(wrote, 0, 'no first request may be written for a guide that is not on disk');
  await s.close();
});

test('login: a provider already registered on this PC is reused -- no CLI login, no waiting for the count to grow', async () => {
  const zr = fakeZip('zip-login-reuse', '1.4.4');
  const root = path.join(tmp, 'IRIS-login');
  fs.mkdirSync(root, { recursive: true });
  const stateFile = path.join(tmp, 'state-c.json');
  saveState(stateFile, {
    step: 'login', zipRoot: zr, nodeDir, packageVersion: '1.4.4',
    soul: { name: 'IRIS', root, existing: 'soul' }, choice: { subscriptions: ['claude'], leadAgent: 'claude', guideEdition: 'claude' },
  });
  let cliStarted = 0;
  const s = await startServer({
    port: 0, zipRoot: zr, nodeDir, stateFile,
    readReceiptFn: () => ({ package: { version: '1.4.0', guideVersion: '13' }, login: { claude: { cli: true, relay: true, relayMethod: 'import' } } }),
    ensureProxyFn: async () => ({ alive: true, started: false }),
    countProviderAccountsFn: async () => 1,                 // the account is already in the relay
    cliLoginStatusFn: () => 'done',                          // the credential file exists
    startCliLoginFn: () => { cliStarted += 1; return { pid: 1 }; },
    relayImportFn: async () => { throw new Error('must not import again'); },
    relayStatusFn: async () => 'pending',                    // would never become done: count cannot grow
    teamclaudeConfigPath: path.join(tmp, 'fake-teamclaude.json'),
  });
  const hdr = { 'content-type': 'application/json', origin: s.url };
  const start = await (await fetch(`${s.url}/api/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ provider: 'claude' }) })).json();
  assert.equal(start.ok, true);
  assert.equal(start.reused, true);
  assert.equal(cliStarted, 0, 'the CLI login must not be started for a registered account');
  const status = await (await fetch(`${s.url}/api/login/status`)).json();
  assert.equal(status.step, 'handoff', 'a reused login completes the step immediately');
  await s.close();
});
