import { test, after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { startServer } from '../installer/server.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-server-'));
const zipRoot = path.join(tmp, 'zip-root');
const nodeDir = path.join(tmp, 'node-dir');
fs.mkdirSync(zipRoot, { recursive: true });
fs.mkdirSync(nodeDir, { recursive: true });
const stateFile = path.join(tmp, 'state.json');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('health 200 with name:iris-installer; POST /api/name reserved stub; POST /api/quit closes the server', async () => {
  let closedByQuit = false;
  const { url, close } = await startServer({
    port: 0,
    zipRoot,
    nodeDir,
    stateFile,
    // Injected quit hook so this test process survives POST /api/quit
    // instead of the real CLI path's process.exit(0).
    onQuit: () => { closedByQuit = true; close(); },
  });

  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.name, 'iris-installer');
  assert.equal(healthBody.step, 'precheck');
  assert.equal(typeof healthBody.version, 'string');

  const reserved = await fetch(`${url}/api/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Windows' }),
  });
  assert.equal(reserved.status, 200);
  assert.deepEqual(await reserved.json(), { ok: false, reason: 'reserved' });

  const okName = await fetch(`${url}/api/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'NOVA' }),
  });
  assert.equal(okName.status, 200);
  assert.deepEqual(await okName.json(), { ok: true, path: 'C:\\NOVA', existing: 'none' });

  const quit = await fetch(`${url}/api/quit`, { method: 'POST' });
  assert.equal(quit.status, 200);
  assert.deepEqual(await quit.json(), { ok: true });

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(closedByQuit, true, 'onQuit hook was not invoked');
  await assert.rejects(fetch(`${url}/api/health`), 'server should have stopped listening after quit');
});

test('unimplemented routes for later tasks answer 501 with a task number', async () => {
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: path.join(tmp, 'state2.json') });
  try {
    const precheck = await fetch(`${url}/api/precheck`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(precheck.status, 501);
    assert.deepEqual(await precheck.json(), { ok: false, reason: 'not_implemented', task: 11 });

    const login = await fetch(`${url}/api/login`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await login.json(), { ok: false, reason: 'not_implemented', task: 13 });

    const loginStatus = await fetch(`${url}/api/login/status`);
    assert.deepEqual(await loginStatus.json(), { ok: false, reason: 'not_implemented', task: 13 });

    const handoff = await fetch(`${url}/api/handoff`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await handoff.json(), { ok: false, reason: 'not_implemented', task: 14 });
  } finally {
    await close();
  }
});

test('GET / 404s until Task 14 adds ui/index.html; no-store on every response', async () => {
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: path.join(tmp, 'state3.json') });
  try {
    const root = await fetch(`${url}/`);
    assert.equal(root.status, 404);
    assert.equal(root.headers.get('cache-control'), 'no-store');

    const health = await fetch(`${url}/api/health`);
    assert.equal(health.headers.get('cache-control'), 'no-store');
  } finally {
    await close();
  }
});
