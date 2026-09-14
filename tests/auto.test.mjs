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

// The updater hands the installer the soul to update by setting
// IRIS_INSTALLER_SOUL_NAME (= the last folder name of plan.root) alongside
// IRIS_INSTALLER_AUTO. Without this the installer would fall back to its
// built-in default and update a different soul than the one the plan named --
// which on this development PC means the real one instead of a rehearsal.
test('auto: the soul to update comes from IRIS_INSTALLER_SOUL_NAME, not from a hardcoded root', async () => {
  const zipRoot = makeZipRoot('zip-auto-env');
  const before = process.env.IRIS_INSTALLER_SOUL_NAME;
  const seen = [];
  process.env.IRIS_INSTALLER_SOUL_NAME = 'ALPHA-FROM-ENV';
  let server;
  try {
    server = await startServer({
      port: 0,
      zipRoot,
      nodeDir: path.join(tmp, 'node'),
      stateFile: path.join(tmp, 'state-env.json'),
      auto: true,
      // no soulName override: the env var is the only thing naming the soul
      readReceiptFn: (root) => { seen.push(root); return priorReceipt(); },
    });
    const st = await (await fetch(`${server.url}/api/state`)).json();
    assert.equal(st.auto.eligible, true);
    assert.equal(st.auto.name, 'ALPHA-FROM-ENV');
    assert.equal(st.auto.root, 'C:\\ALPHA-FROM-ENV');
  } finally {
    if (before === undefined) delete process.env.IRIS_INSTALLER_SOUL_NAME;
    else process.env.IRIS_INSTALLER_SOUL_NAME = before;
    if (server) await server.close();
  }
  assert.deepEqual(seen, ['C:\\ALPHA-FROM-ENV'], 'eligibility was checked against the soul the env var names');
});

// ---------------------------------------------------------------------------
// Stale state (review round 2, critical 1). state.json is persistent
// (%LOCALAPPDATA%\IRIS-Installer\state.json), so an automatic update opens on
// whatever the last run left behind. The screen's enterAutoMode() returns early
// on `step:'done'`+autoResult.ok and on installError -- and by then the daemon
// is already shut down, so "the screen showed an old result" means "the person
// has no IRIS window". The server clears the run-specific fields before the
// screen ever reads them.
// ---------------------------------------------------------------------------

function writeStaleState(file, extra) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    step: 'done',
    zipRoot: 'C:\\somewhere-old',
    nodeDir: 'C:\\somewhere-old\\node',
    soul: { name: SOUL, root: `C:\\${SOUL}`, existing: 'soul' },
    install: { parts: { face: 'error', node: 'done' } },
    packageVersion: '1.3.0', // 1.4.4+: a saved state is resumed only by the package version that wrote it (makeZipRoot default)
    ...extra,
  }, null, 2), 'utf8');
}

test('auto: a previous update left step=done + autoResult -- the update still starts', async () => {
  const zipRoot = makeZipRoot('zip-stale-done');
  const stateFile = path.join(tmp, 'state-stale-done.json');
  writeStaleState(stateFile, {
    autoResult: { ok: true, from: '1.1.0', to: '1.2.0', relaunched: true, pid: 42 },
  });

  const installCalls = [];
  const { url, close } = await startServer({
    port: 0,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile,
    soulName: SOUL,
    auto: true,
    readReceiptFn: () => priorReceipt(),
    installFn: async (opts) => { installCalls.push(opts); return { steps: { copy: 'done' } }; },
    relaunchFaceFn: () => ({ ok: true, how: 'wscript', pid: 778 }),
    finishFn: () => ({ ok: true }),
    onQuit: () => {},
  });

  try {
    // What the screen reads before it decides anything: nothing that would
    // make enterAutoMode() render the old success instead of calling
    // startAuto().
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.equal(st.auto.eligible, true);
    assert.notEqual(st.step, 'done', 'a fresh update must not open on the previous run\'s "done"');
    assert.equal(st.step, 'precheck');
    assert.equal(st.autoResult, null, 'the previous run\'s result must not be replayed');
    assert.equal(st.installError, null);
    assert.equal(st.install, null, 'the previous run\'s part badges must not be rendered');
    // and this run's zipRoot won, not the old one recorded in the file
    assert.equal(st.zipRoot, zipRoot);

    // the run the screen would now start really does start
    const started = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 202);
    const end = await waitForStep(url, 'done');
    assert.equal(end.autoResult.ok, true);
    assert.equal(end.autoResult.to, '1.3.0', 'the new result replaced the stale one');
    assert.equal(installCalls.length, 1);
  } finally {
    await close();
  }

  // the cleared state is persisted, not only held in memory -- a browser that
  // refreshes before POST /api/auto reads the file, not the old object
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(onDisk.autoResult.to, '1.3.0');
});

test('auto: a first install that failed long ago left installError -- the update still starts', async () => {
  const zipRoot = makeZipRoot('zip-stale-error');
  const stateFile = path.join(tmp, 'state-stale-error.json');
  writeStaleState(stateFile, { step: 'install', installError: 'payload-missing' });

  const installCalls = [];
  const { url, close } = await startServer({
    port: 0,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile,
    soulName: SOUL,
    auto: true,
    readReceiptFn: () => priorReceipt(),
    installFn: async (opts) => { installCalls.push(opts); return { steps: { copy: 'done' } }; },
    relaunchFaceFn: () => ({ ok: true, how: 'wscript', pid: 779 }),
    finishFn: () => ({ ok: true }),
    onQuit: () => {},
  });

  try {
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.equal(st.auto.eligible, true);
    assert.equal(st.installError, null, 'an old failure must not be shown as this update\'s failure');
    assert.equal(st.step, 'precheck');
    assert.equal(st.autoResult, null);

    const started = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 202);
    const end = await waitForStep(url, 'done');
    assert.equal(end.autoResult.ok, true);
    assert.equal(installCalls.length, 1);
  } finally {
    await close();
  }
});

// The ordinary (non-automatic) wizard still resumes where it left off: the
// clearing above is guarded by auto.eligible, because there a leftover step is
// exactly what a refresh is supposed to restore.
test('auto: without the flag a leftover step/installError is still restored (the wizard resumes)', async () => {
  const zipRoot = makeZipRoot('zip-stale-wizard');
  const stateFile = path.join(tmp, 'state-stale-wizard.json');
  writeStaleState(stateFile, { step: 'install', installError: 'payload-missing' });

  const { url, close } = await startServer({
    port: 0,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile,
    soulName: SOUL,
    auto: false,
    readReceiptFn: () => priorReceipt(),
  });
  try {
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.equal(st.auto.eligible, false);
    assert.equal(st.step, 'install');
    assert.equal(st.installError, 'payload-missing');
    assert.deepEqual(st.install.parts, { face: 'error', node: 'done' });
  } finally {
    await close();
  }
});

test('auto: a failing install stops the run, records the reason, and reopens the previous window', async () => {
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

    // 설계 4-5 (review round 2, important 3): the updater already shut the
    // daemon down, so a failure with no relaunch leaves the person with no
    // window at all. install() rolled the failed part back to .prev, so the
    // window that reopens is the one that worked before the update.
    assert.equal(relaunchCalls.length, 1, 'a failed update still reopens the window');
    assert.equal(relaunchCalls[0].root, `C:\\${SOUL}`);
    assert.equal(st.autoResult.relaunched, true);

    const frames = await readBufferedEvents(url);
    const terminal = frames.filter((f) => f.done);
    assert.equal(terminal.length, 1, 'still exactly one terminal frame');
    assert.equal(terminal[0].error, 'payload-missing');
    const relaunchFrame = frames.filter((f) => f.part === 'relaunch');
    assert.equal(relaunchFrame.length, 1);
    assert.equal(relaunchFrame[0].status, 'done');
  } finally {
    await close();
  }
});
