import { test, after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import http from 'node:http';
import { startServer } from '../installer/server.mjs';

// Sends a raw HTTP request with `rawPath` used verbatim as the request-target
// (no client-side URL normalization) so tests can exercise exactly what
// server.mjs's `new URL(req.url, ...)` + serveStatic see on the wire --
// fetch()/the WHATWG URL constructor would otherwise collapse literal ".."
// and backslash segments before the request ever left the client.
function rawRequest(port, rawPath, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-server-'));
const zipRoot = path.join(tmp, 'zip-root');
const nodeDir = path.join(tmp, 'node-dir');
fs.mkdirSync(zipRoot, { recursive: true });
fs.mkdirSync(nodeDir, { recursive: true });
const stateFile = path.join(tmp, 'state.json');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('health 200 with name:iris-installer; POST /api/name validation; POST /api/quit closes the server', async () => {
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

  // 'Windows' collides with the real top-level system folder -> soulname's
  // 'system' reason (the old Task 10 stub's narrower 'reserved' vocabulary
  // is gone -- soulname.mjs is now the single source of truth).
  const systemName = await fetch(`${url}/api/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Windows' }),
  });
  assert.equal(systemName.status, 200);
  assert.deepEqual(await systemName.json(), { ok: false, reason: 'system' });

  // 'CON' is a reserved MS-DOS device name -- distinct reason from 'system'.
  const deviceName = await fetch(`${url}/api/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CON' }),
  });
  assert.equal(deviceName.status, 200);
  assert.deepEqual(await deviceName.json(), { ok: false, reason: 'reserved' });

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

test('POST /api/precheck runs the real precheck and advances state.step to name', async () => {
  const stateFile6 = path.join(tmp, 'state6.json');
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: stateFile6 });
  try {
    const res = await fetch(`${url}/api/precheck`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.os.ok, 'boolean');
    assert.equal(body.arch.value, 'x64');
    assert.equal(typeof body.allOk, 'boolean');
    assert.equal(typeof body.canProceedOffline, 'boolean');

    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.step, 'name');
    assert.deepEqual(state.precheck, body);
  } finally {
    await close();
  }
});

test('POST /api/name: a rejected name leaves state.step on precheck (no soul saved); state.step only advances to choice on ok:true', async () => {
  const stateFile7 = path.join(tmp, 'state7.json');
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: stateFile7 });
  try {
    const badName = await fetch(`${url}/api/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    assert.deepEqual(await badName.json(), { ok: false, reason: 'empty' });
    const afterBad = await (await fetch(`${url}/api/state`)).json();
    assert.equal(afterBad.step, 'precheck');
    assert.equal(afterBad.soul, undefined);

    const goodName = await fetch(`${url}/api/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NOVA7' }),
    });
    assert.deepEqual(await goodName.json(), { ok: true, path: 'C:\\NOVA7', existing: 'none' });
    const afterGood = await (await fetch(`${url}/api/state`)).json();
    assert.equal(afterGood.step, 'choice');
    assert.deepEqual(afterGood.soul, { name: 'NOVA7', root: 'C:\\NOVA7', existing: 'none' });
  } finally {
    await close();
  }
});

test('unimplemented routes for later tasks answer 501 with a task number', async () => {
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: path.join(tmp, 'state2.json') });
  try {
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

// fix round 1, finding 3(a): the static handler must not let any of these
// escape installer/ui/ to serve a real file one level up (installer/
// bootstrap.ps1). "../" and a raw, unescaped "\" both get neutralized
// earlier by the WHATWG URL parser itself (it collapses dot-segments and,
// for a special scheme like http, treats "\" as a path separator too), so
// they are expected to 404 harmlessly; "%2e%2e/" and the encoded backslash
// "%5c" survive URL parsing untouched and must be caught by serveStatic's
// own prefix check (403). Either safe outcome is acceptable here -- what
// must never happen is 200 with bootstrap.ps1's actual content.
test('static handler blocks path traversal: ../, %2e%2e/, %5c, and raw backslash all miss bootstrap.ps1', async () => {
  const { port, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: path.join(tmp, 'state4.json') });
  try {
    const payloads = [
      '/../bootstrap.ps1',
      '/%2e%2e/bootstrap.ps1',
      '/..%5cbootstrap.ps1',
      '/..\\bootstrap.ps1',
    ];
    for (const rawPath of payloads) {
      const { status, body } = await rawRequest(port, rawPath);
      assert.ok(status === 403 || status === 404, `expected 403 or 404 for ${JSON.stringify(rawPath)}, got ${status}`);
      assert.ok(!body.includes('Mandatory'), `response for ${JSON.stringify(rawPath)} leaked bootstrap.ps1 content: ${body}`);
    }
  } finally {
    await close();
  }
});

// fix round 1, finding 3(b): a body just over BODY_LIMIT (1 MiB, matching
// installer/server.mjs) must get the coded 413 JSON response -- not a
// connection reset (that was finding 1) -- and the server must keep serving
// other requests afterward; a body just under the limit must go through
// normally.
test('body-size boundary: over BODY_LIMIT -> 413 JSON and server keeps serving; under BODY_LIMIT -> accepted', async () => {
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: path.join(tmp, 'state5.json') });
  try {
    const BODY_LIMIT = 1024 * 1024; // must track installer/server.mjs's BODY_LIMIT

    const over = await fetch(`${url}/api/precheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'a'.repeat(BODY_LIMIT + 1024),
    });
    assert.equal(over.status, 413);
    assert.deepEqual(await over.json(), { ok: false, reason: 'bad_request' });

    // The server (and this connection's listener) must still be alive.
    const health = await fetch(`${url}/api/health`);
    assert.equal(health.status, 200);

    const under = await fetch(`${url}/api/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NOVA', pad: 'a'.repeat(BODY_LIMIT - 1000) }),
    });
    assert.equal(under.status, 200);
    assert.deepEqual(await under.json(), { ok: true, path: 'C:\\NOVA', existing: 'none' });
  } finally {
    await close();
  }
});
