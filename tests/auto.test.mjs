import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../installer/server.mjs';

// Automatic update mode (P02 docs\설계-업데이트-2026-09-14.md 5-2): the same
// install() that the wizard drives, with the questions answered from the
// receipt instead of by a person, the login step skipped and the window
// reopened with the plain launcher.
//
// Nothing here touches a real soul: the soul root is a made-up name (so it is
// never this PC's C:\IRIS), and install / relaunch / finish / readReceipt are
// all injected, so the run writes nothing under C:\.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-auto-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const SOUL = 'ALPHA-AUTO-TEST';

function makeZipRoot(name, version = '1.3.0') {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'payload'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'payload', 'manifest.json'),
    JSON.stringify({ schema: 1, built: '2026-09-14T00:00:00.000Z', package: { name: 'IRIS', version }, parts: {} }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'lock.json'),
    JSON.stringify({ schema: 1, package: { version }, parts: { face: { kind: 'dir', file: 'face/iris-face.zip' } } }),
    'utf8',
  );
  return dir;
}

function priorReceipt() {
  return {
    schema: 1,
    package: { name: 'IRIS', version: '1.2.0', guideVersion: '10', license: 'MIT' },
    soul: { root: `C:\\${SOUL}`, name: SOUL, createdBy: 'package-installer' },
    choice: { subscriptions: ['claude', 'chatgpt'], leadAgent: 'claude', guideEdition: 'claude' },
    installed: { face: { version: '2.57.1', verified: true } },
    steps: { copy: 'done', login: 'done', handoff: 'done' },
  };
}

async function waitForStep(url, want, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const s = await (await fetch(`${url}/api/state`)).json();
    if (s.step === want) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  const s = await (await fetch(`${url}/api/state`)).json();
  assert.fail(`step never became ${want} (it is ${s.step}, installError=${s.installError})`);
}

// The event buffer is replayed to any client that connects, so reading it
// after the run is over sees everything that was emitted.
async function readBufferedEvents(url) {
  const ctrl = new AbortController();
  const stream = await fetch(`${url}/api/install/events`, { signal: ctrl.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames = [];
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), 300)),
    ]);
    if (done) break;
    if (value) buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i).replace(/^data: /, '');
      buf = buf.slice(i + 2);
      if (raw.trim()) frames.push(JSON.parse(raw));
    }
    if (frames.some((f) => f.done)) break;
  }
  ctrl.abort();
  return frames;
}

test('auto: an existing install is updated with no clicks -- receipt answers ⓑⓒ, login is skipped, the window is reopened', async () => {
  const zipRoot = makeZipRoot('zip-auto');
  const installCalls = [];
  const relaunchCalls = [];
  const finishCalls = [];
  const loginCalls = [];

  const { url, close } = await startServer({
    port: 0,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile: path.join(tmp, 'state-auto.json'),
    soulName: SOUL,
    auto: true,
    readReceiptFn: () => priorReceipt(),
    installFn: async (opts) => {
      installCalls.push(opts);
      opts.onProgress({ part: 'face', pct: 40, status: 'running' });
      opts.onProgress({ part: 'face', pct: 60, status: 'done' });
      opts.onProgress({ part: 'node', pct: 70, skipped: true });
      // install()'s own terminal event -- runAuto must NOT let this through
      // as the run's completion.
      opts.onProgress({ pct: 100, done: true });
      return { steps: { copy: 'done' } };
    },
    relaunchFaceFn: (opts) => { relaunchCalls.push(opts); return { ok: true, how: 'wscript', pid: 777 }; },
    finishFn: (opts) => { finishCalls.push(opts); return { ok: true }; },
    startCliLoginFn: (opts) => { loginCalls.push(opts); return { pid: 1 }; },
    onQuit: () => {},
  });

  try {
    // the server knows it is an update before anything is asked of it
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.auto, true);
    const before = await (await fetch(`${url}/api/state`)).json();
    assert.equal(before.auto.eligible, true);
    assert.equal(before.auto.from, '1.2.0');
    assert.equal(before.auto.to, '1.3.0');
    assert.equal(before.auto.root, `C:\\${SOUL}`);

    const started = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { ok: true, from: '1.2.0', to: '1.3.0' });

    const end = await waitForStep(url, 'done');
    assert.equal(end.autoResult.ok, true);
    assert.equal(end.autoResult.from, '1.2.0');
    assert.equal(end.autoResult.to, '1.3.0');
    assert.equal(end.autoResult.relaunched, true);

    // ⓑ/ⓒ came from the receipt, not from a person
    assert.equal(installCalls.length, 1);
    assert.equal(installCalls[0].root, `C:\\${SOUL}`);
    assert.equal(installCalls[0].existing, 'soul');
    assert.deepEqual(installCalls[0].choice, priorReceipt().choice);
    assert.equal(installCalls[0].manifest.package.version, '1.3.0');
    assert.ok(installCalls[0].lock.parts.face, 'the zip lock.json is what install() is handed');

    // ⓔ never ran, ⓕ was a plain relaunch (no first-session handoff)
    assert.equal(loginCalls.length, 0);
    assert.equal(relaunchCalls.length, 1);
    assert.equal(relaunchCalls[0].root, `C:\\${SOUL}`);
    assert.equal(finishCalls.length, 1);
    assert.equal(finishCalls[0].root, `C:\\${SOUL}`);

    // the stream the screen reads: precheck, the parts, the skipped login,
    // the relaunch, and exactly one terminal frame -- at the end.
    const frames = await readBufferedEvents(url);
    const terminal = frames.filter((f) => f.done);
    assert.equal(terminal.length, 1, `exactly one terminal frame, got ${JSON.stringify(frames)}`);
    assert.equal(terminal[0].error, null);
    assert.equal(terminal[0].pct, 100);
    assert.equal(frames.at(-1).done, true);
    const byPart = Object.fromEntries(frames.filter((f) => f.part).map((f) => [f.part, f]));
    assert.equal(byPart.precheck.status, 'done');
    assert.equal(byPart.face.status, 'done');
    assert.equal(byPart.login.skipped, true);
    assert.equal(byPart.relaunch.status, 'done');
  } finally {
    await close();
  }
});

test('auto: requested on a PC with no receipt falls back to the ordinary wizard', async () => {
  const zipRoot = makeZipRoot('zip-auto-fresh');
  const { url, close } = await startServer({
    port: 0,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile: path.join(tmp, 'state-fresh.json'),
    soulName: SOUL,
    auto: true,
    readReceiptFn: () => null, // no install here yet
    installFn: async () => { throw new Error('install must not run'); },
    relaunchFaceFn: () => { throw new Error('relaunch must not run'); },
  });
  try {
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.equal(st.auto.requested, true);
    assert.equal(st.auto.eligible, false);
    assert.equal(st.auto.reason, 'no_receipt');

    const refused = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, reason: 'no_receipt' });

    // and the normal six-step flow is still there
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.auto, false);
    const name = await fetch(`${url}/api/name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(name.status, 200);
    assert.equal((await name.json()).name, SOUL);
  } finally {
    await close();
  }
});

test('auto: without the flag nothing is automatic, even over an existing install', async () => {
  const zipRoot = makeZipRoot('zip-auto-off');
  const { url, close } = await startServer({
    port: 0,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile: path.join(tmp, 'state-off.json'),
    soulName: SOUL,
    auto: false,
    readReceiptFn: () => priorReceipt(),
  });
  try {
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.deepEqual(st.auto, { requested: false, eligible: false, reason: 'not_requested' });
    const refused = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, reason: 'not_requested' });
  } finally {
    await close();
  }
});

test('auto: a failing install stops the run, records the reason, and never reopens the window', async () => {
  const zipRoot = makeZipRoot('zip-auto-fail');
  const relaunchCalls = [];
  const { url, close } = await startServer({
    port: 0,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile: path.join(tmp, 'state-fail.json'),
    soulName: SOUL,
    auto: true,
    readReceiptFn: () => priorReceipt(),
    installFn: async ({ onProgress }) => {
      onProgress({ part: 'face', pct: 40, status: 'running' });
      throw Object.assign(new Error('payload-missing (face)'), { code: 'payload-missing' });
    },
    relaunchFaceFn: (opts) => { relaunchCalls.push(opts); return { ok: true }; },
    finishFn: () => { throw new Error('finish must not run after a failure'); },
    onQuit: () => {},
  });
  try {
    const started = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 202);

    let st;
    for (let i = 0; i < 200; i++) {
      st = await (await fetch(`${url}/api/state`)).json();
      if (st.autoResult) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(st.autoResult.ok, false);
    assert.equal(st.autoResult.reason, 'payload-missing');
    assert.equal(st.installError, 'payload-missing');
    assert.equal(st.step, 'auto', 'a failed run must not claim to be done');
    assert.equal(relaunchCalls.length, 0);

    const frames = await readBufferedEvents(url);
    const terminal = frames.filter((f) => f.done);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].error, 'payload-missing');
  } finally {
    await close();
  }
});
