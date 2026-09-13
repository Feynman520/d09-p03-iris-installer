import { test, after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
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

  // The soul folder is fixed (2026-09-13): the request body's name is
  // ignored. This server was started without a soulName override, so the
  // default applies -- and that default must be the product name, IRIS.
  // The route is exercised (not just the default read back) with a body
  // that would have been rejected under the old free-form rules: 'CON' is a
  // reserved device name, yet the answer is about C:\IRIS, not about CON.
  // detectExisting() is read-only, so probing the real C:\IRIS on the
  // developer PC changes nothing; the answer's `existing` just depends on
  // the machine, so only the fixed name/path are asserted.
  const ignoredBody = await fetch(`${url}/api/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CON' }),
  });
  assert.equal(ignoredBody.status, 200);
  const ignoredJson = await ignoredBody.json();
  assert.equal(ignoredJson.name, 'IRIS');
  if (ignoredJson.ok) assert.equal(ignoredJson.path, 'C:\\IRIS');
  else assert.equal(ignoredJson.reason, 'conflict', 'the only possible refusal for the fixed name is a foreign C:\\IRIS');

  const quit = await fetch(`${url}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
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

test('POST /api/name: the fixed soulName is validated (a bad override is refused, no soul saved); ok:true advances to choice with the fixed name, body ignored', async () => {
  // A bad override (developer-PC rehearsal switch IRIS_INSTALLER_SOUL_NAME /
  // startServer({soulName})) must be refused by the same name rules -- the
  // installer never proceeds with a root it could not create.
  const stateFile7 = path.join(tmp, 'state7.json');
  const bad = await startServer({ port: 0, zipRoot, nodeDir, stateFile: stateFile7, soulName: 'CON' });
  try {
    const badName = await fetch(`${bad.url}/api/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NOVA7' }),
    });
    assert.deepEqual(await badName.json(), { ok: false, reason: 'reserved', name: 'CON' });
    const afterBad = await (await fetch(`${bad.url}/api/state`)).json();
    assert.equal(afterBad.step, 'precheck');
    assert.equal(afterBad.soul, undefined);
  } finally {
    await bad.close();
  }

  const stateFile8 = path.join(tmp, 'state8.json');
  const good = await startServer({ port: 0, zipRoot, nodeDir, stateFile: stateFile8, soulName: 'NOVA7' });
  try {
    // Body name is ignored: whatever the page sends, the soul is NOVA7.
    const goodName = await fetch(`${good.url}/api/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SOMETHING-ELSE' }),
    });
    assert.deepEqual(await goodName.json(), { ok: true, name: 'NOVA7', path: 'C:\\NOVA7', existing: 'none' });
    const afterGood = await (await fetch(`${good.url}/api/state`)).json();
    assert.equal(afterGood.step, 'choice');
    assert.deepEqual(afterGood.soul, { name: 'NOVA7', root: 'C:\\NOVA7', existing: 'none' });
  } finally {
    await good.close();
  }
});

// Task 14 replaced the last 501 stub (/api/handoff) with the real handoff.
// What stays true: a route that needs a soul root refuses before one exists,
// and nothing answers 501 any more. (The handoff's own happy/sad paths live
// in tests/handoff.test.mjs.)
test('no route answers 501 any more; /api/handoff needs a soul root first', async () => {
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: path.join(tmp, 'state2.json') });
  try {
    const handoff = await fetch(`${url}/api/handoff`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(handoff.status, 409);
    assert.deepEqual(await handoff.json(), { ok: false, reason: 'no_soul' });
  } finally {
    await close();
  }
});

// Task 13 wiring: POST /api/login validates the provider, snapshots
// accountsBefore, ensures the proxy, and starts the CLI login -- all via
// injected fns so this test never spawns a process or touches a real
// TeamClaude config. GET /api/login/status then drives stage 1 (cli) ->
// stage 2 (relay) per provider and flips state.step to 'handoff' once every
// chosen subscription is fully done.
test('login: POST /api/login + GET /api/login/status advance cli -> relay -> handoff per provider', async () => {
  const stateFile8 = path.join(tmp, 'state8.json');
  const zr8 = path.join(tmp, 'zip-login');
  fs.mkdirSync(path.join(zr8, 'payload'), { recursive: true });
  fs.writeFileSync(
    path.join(zr8, 'payload', 'manifest.json'),
    JSON.stringify({ schema: 1, package: { name: 'IRIS', version: '1.0.0' }, parts: {} }),
    'utf8',
  );
  const cliStatusByProvider = { claude: 'pending', chatgpt: 'pending' };
  const relayStatusByProvider = { claude: 'pending', chatgpt: 'pending' };
  const ensureProxyCalls = [];
  const startCliLoginCalls = [];
  const relayImportCalls = [];

  // Login only ever runs after install finishes (state.step -> 'login') --
  // an injected no-op installFn advances that without writing anything.
  const installFn = async ({ onProgress }) => {
    onProgress({ part: 'node', pct: 100, status: 'done' });
    return { steps: { copy: 'done' } };
  };

  const { url, close } = await startServer({
    port: 0,
    zipRoot: zr8,
    nodeDir,
    stateFile: stateFile8,
    installFn,
    ensureProxyFn: async (opts) => { ensureProxyCalls.push(opts); return { alive: true, started: false }; },
    startCliLoginFn: (opts) => { startCliLoginCalls.push(opts); return { pid: 4242 }; },
    cliLoginStatusFn: ({ provider }) => cliStatusByProvider[provider],
    relayImportFn: async (opts) => { relayImportCalls.push(opts); return { ok: true, method: 'import' }; },
    relayStatusFn: async ({ provider }) => relayStatusByProvider[provider],
    countProviderAccountsFn: async () => 0,
    teamclaudeConfigPath: path.join(tmp, 'fake-teamclaude.json'),
    soulName: 'NOVA-LOGIN-TEST', // fixed-name override (the body below is ignored)
  });
  try {
    await fetch(`${url}/api/name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    await fetch(`${url}/api/choice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptions: ['claude', 'chatgpt'] }),
    });
    await fetch(`${url}/api/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    for (let i = 0; i < 50; i++) {
      const s = await (await fetch(`${url}/api/state`)).json();
      if (s.step === 'login') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const badProvider = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'bogus' }),
    });
    assert.deepEqual(await badProvider.json(), { ok: false, reason: 'bad_provider' });

    const loginClaude = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'claude' }),
    });
    assert.equal(loginClaude.status, 200);
    assert.deepEqual(await loginClaude.json(), { ok: true, alive: true, started: false, pid: 4242 });

    const loginChatgpt = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'chatgpt' }),
    });
    assert.equal(loginChatgpt.status, 200);

    assert.equal(ensureProxyCalls.length, 2);
    assert.equal(startCliLoginCalls.length, 2);
    assert.equal(startCliLoginCalls[0].provider, 'claude');
    assert.equal(startCliLoginCalls[1].provider, 'chatgpt');

    let statusBody = await (await fetch(`${url}/api/login/status`)).json();
    assert.equal(statusBody.step, 'login');
    assert.equal(statusBody.providers.claude.cli, 'pending');
    assert.equal(statusBody.providers.chatgpt.cli, 'pending');
    assert.equal(relayImportCalls.length, 0);

    // Flip claude's CLI login to done -> the next poll starts stage 2
    // (relayImport) for claude only.
    cliStatusByProvider.claude = 'done';
    statusBody = await (await fetch(`${url}/api/login/status`)).json();
    assert.equal(statusBody.providers.claude.cli, 'done');
    assert.equal(statusBody.providers.chatgpt.cli, 'pending');

    // The route fires relayImport without awaiting it -- poll until it lands.
    for (let i = 0; i < 50 && relayImportCalls.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(relayImportCalls.length, 1);
    assert.equal(relayImportCalls[0].provider, 'claude');

    statusBody = await (await fetch(`${url}/api/login/status`)).json();
    assert.equal(statusBody.providers.claude.relayMethod, 'import');
    assert.equal(statusBody.providers.claude.relay, 'pending');
    assert.equal(statusBody.step, 'login');

    // Finish both providers.
    cliStatusByProvider.chatgpt = 'done';
    relayStatusByProvider.claude = 'done';
    await fetch(`${url}/api/login/status`);
    for (let i = 0; i < 50 && relayImportCalls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    relayStatusByProvider.chatgpt = 'done';

    let finalBody;
    for (let i = 0; i < 50; i++) {
      finalBody = await (await fetch(`${url}/api/login/status`)).json();
      if (finalBody.step === 'handoff') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(finalBody.step, 'handoff');
    assert.equal(finalBody.providers.claude.relay, 'done');
    assert.equal(finalBody.providers.chatgpt.relay, 'done');

    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.step, 'handoff');
  } finally {
    await close();
  }
});

test('login: POST /api/login before a soul root is chosen -> 409', async () => {
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: path.join(tmp, 'state9.json') });
  try {
    const res = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'claude' }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, reason: 'no_soul' });
  } finally {
    await close();
  }
});

test('GET / serves the Task 14 wizard from installer/ui; no-store on every response', async () => {
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: path.join(tmp, 'state3.json') });
  try {
    const root = await fetch(`${url}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /text\/html/);
    assert.ok((await root.text()).includes('IRIS'));
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
  // A name no machine has at C:\ -- detectExisting() reads the real drive,
  // and the developer PC may well have a rehearsal C:\NOVA lying around.
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: path.join(tmp, 'state5.json'), soulName: 'NOVA7-BODY-TEST' });
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
    assert.deepEqual(await under.json(), { ok: true, name: 'NOVA7-BODY-TEST', path: 'C:\\NOVA7-BODY-TEST', existing: 'none' });
  } finally {
    await close();
  }
});

// Task 12 wiring: POST /api/install answers 202 immediately and runs the copy
// in the background; GET /api/install/events streams one SSE frame per
// progress event with the {part, pct, done, error} shape the screen consumes,
// and replays what a late/refreshed client missed. installFn is injected so
// this test never writes anything under C:\.
test('install: 202 + SSE progress frames, replayed for a late subscriber, step -> login', async () => {
  const zr = path.join(tmp, 'zip-install');
  fs.mkdirSync(path.join(zr, 'payload'), { recursive: true });
  fs.writeFileSync(
    path.join(zr, 'payload', 'manifest.json'),
    JSON.stringify({ schema: 1, package: { name: 'IRIS', version: '1.0.0' }, parts: {} }),
    'utf8',
  );

  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  // Fix round 1 finding 2: these deliberately mirror the *real* shape
  // install.mjs emits -- a part's completion carries pct = floor((i+1)/total
  // *100), which is 9 for the first of eleven parts, NOT 100. The old
  // pct === 100 heuristic therefore left ten of eleven parts stuck on
  // 'running' in state.install.parts; only `status` gets it right.
  const installFn = async ({ root, onProgress }) => {
    seen.push(root);
    onProgress({ part: 'node', pct: 0, status: 'running' });
    onProgress({ part: 'node', pct: 9, status: 'done' });
    await gate;
    onProgress({ part: 'python', pct: 18, skipped: true });
    onProgress({ pct: 100, done: true });
    return { steps: { copy: 'done' } };
  };

  const { url, close } = await startServer({
    port: 0, zipRoot: zr, nodeDir, stateFile: path.join(tmp, 'state-install.json'), installFn,
    soulName: 'NOVA-SSE-TEST',
  });
  try {
    await fetch(`${url}/api/name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    await fetch(`${url}/api/choice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptions: ['claude'] }),
    });

    const started = await fetch(`${url}/api/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { ok: true });
    assert.deepEqual(seen, [String.raw`C:\NOVA-SSE-TEST`]);

    // Subscribe *after* the first two events -> they must be replayed.
    const ctrl = new AbortController();
    const stream = await fetch(`${url}/api/install/events`, { signal: ctrl.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const frames = [];
    const pump = (async () => {
      while (frames.length < 4) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, i).replace(/^data: /, '');
          buf = buf.slice(i + 2);
          if (raw.trim()) frames.push(JSON.parse(raw));
        }
        if (frames.length === 2) release();
      }
    })();
    await pump;

    assert.deepEqual(frames[0], { part: 'node', pct: 0, done: false, error: null, status: 'running' });
    assert.deepEqual(frames[1], { part: 'node', pct: 9, done: false, error: null, status: 'done' });
    assert.deepEqual(frames[2], { part: 'python', pct: 18, done: false, error: null, skipped: true });
    assert.equal(frames[3].done, true);
    assert.equal(frames[3].error, null);
    ctrl.abort();

    // Give the background promise chain a tick to flip the step.
    for (let i = 0; i < 50; i++) {
      const s = await (await fetch(`${url}/api/state`)).json();
      if (s.step === 'login') {
        // 'done' despite pct being 9, not 100 -- the whole point of the fix.
        assert.equal(s.install.parts.node, 'done');
        assert.equal(s.install.parts.python, 'skipped');
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail('state.step never became "login"');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// I3 (2026-09-12 final review): local-origin / CSRF guard.
// ---------------------------------------------------------------------------
// The server binds 127.0.0.1, but any page open in the same browser can still
// POST to it. Two gates: a foreign Origin is refused outright, and every /api
// POST must be application/json (which a plain cross-site <form> cannot send
// without a preflight the Origin gate then refuses).
test('/api guard: foreign Origin is 403 bad_origin, own origin and no Origin pass', async () => {
  const stateFileO = path.join(tmp, 'state-origin.json');
  const { url, port, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: stateFileO });
  try {
    const evil = await fetch(`${url}/api/health`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
    assert.deepEqual(await evil.json(), { ok: false, reason: 'bad_origin' });

    const evilPost = await fetch(`${url}/api/name`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NOVA' }),
    });
    assert.equal(evilPost.status, 403);
    assert.deepEqual(await evilPost.json(), { ok: false, reason: 'bad_origin' });

    // An unknown /api path is guarded too (no hole for future routes).
    const evilUnknown = await fetch(`${url}/api/nope`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(evilUnknown.status, 403);

    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      const ok = await fetch(`${url}/api/health`, { headers: { Origin: origin } });
      assert.equal(ok.status, 200, `origin ${origin} should be allowed`);
      assert.equal((await ok.json()).name, 'iris-installer');
    }

    // No Origin at all (bootstrap.ps1's probe, verify/static.mjs's ⑨ smoke,
    // same-origin GET/EventSource) stays allowed.
    const bare = await fetch(`${url}/api/health`);
    assert.equal(bare.status, 200);

    // Static files are not /api and keep working with any Origin.
    const staticRes = await fetch(`${url}/nope.html`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(staticRes.status, 404);
    assert.deepEqual(await staticRes.json(), { ok: false, reason: 'not_found' });
  } finally {
    await close();
  }
});

test('/api guard: a POST that is not application/json is 415', async () => {
  const stateFileC = path.join(tmp, 'state-ctype.json');
  // soulName '' -> the fixed-name route answers reason:'empty' without touching
  // any real folder, which is all this content-type test needs from it.
  const { url, close } = await startServer({ port: 0, zipRoot, nodeDir, stateFile: stateFileC, soulName: '' });
  try {
    const form = await fetch(`${url}/api/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=NOVA',
    });
    assert.equal(form.status, 415);
    assert.deepEqual(await form.json(), { ok: false, reason: 'unsupported_media_type' });

    const none = await fetch(`${url}/api/quit`, { method: 'POST' });
    assert.equal(none.status, 415);

    // charset suffix is fine -- the UI's fetch sends bare application/json,
    // but a proxy or a future client may append one.
    const withCharset = await fetch(`${url}/api/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ name: '' }),
    });
    assert.equal(withCharset.status, 200);
    assert.deepEqual(await withCharset.json(), { ok: false, reason: 'empty', name: '' });
  } finally {
    await close();
  }
});

// The screen must actually speak the protocol the guard now enforces.
test('installer UI sends Content-Type: application/json on every POST it makes', () => {
  const uiPath = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'installer', 'ui', 'index.html');
  const html = fs.readFileSync(uiPath, 'utf8');
  const posts = html.match(/method:\s*'POST'/g) ?? [];
  assert.ok(posts.length > 0, 'no POST found in the UI at all -- did the api() helper change?');
  const jsonHeaders = html.match(/'Content-Type':\s*'application\/json'/g) ?? [];
  assert.equal(
    jsonHeaders.length, posts.length,
    'every POST in installer/ui/index.html must carry a JSON Content-Type header',
  );
});
