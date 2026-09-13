import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyPlan, applyFaceItem, waitForDaemonStop, preserveAside as updaterPreserveAside,
  updateResultPath, updateLogPath, receiptPath, toolsDir,
} from '../updater/apply.mjs';
import { preserveAside as installerPreserveAside } from '../installer/lib/install.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-updater-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// --------------------------------------------------------------------------
// fixture: a fake soul root -- never a real drive letter, never this PC's
// C:\IRIS (repo-wide constraint: test fixtures use a made-up soul like ALPHA).
// --------------------------------------------------------------------------
function makeSoul(name, { faceVersion = '2.57.1', lock = '{"lockfileVersion":3,"old":true}' } = {}) {
  const root = path.join(tmp, name, 'ALPHA');
  const tools = path.join(root, '_agent', 'shared', 'tools');
  const face = path.join(tools, 'face');
  fs.mkdirSync(path.join(face, 'state'), { recursive: true });
  fs.mkdirSync(path.join(face, 'modules', 'messenger'), { recursive: true });
  fs.mkdirSync(path.join(face, 'node_modules', 'node-pty'), { recursive: true });
  fs.mkdirSync(path.join(face, 'daemon'), { recursive: true });
  fs.mkdirSync(path.join(tools, 'node'), { recursive: true });

  fs.writeFileSync(path.join(face, 'package.json'), JSON.stringify({ name: 'iris-face', version: faceVersion }), 'utf8');
  fs.writeFileSync(path.join(face, 'package-lock.json'), lock, 'utf8');
  fs.writeFileSync(path.join(face, 'daemon', 'server.mjs'), 'old daemon', 'utf8');
  fs.writeFileSync(path.join(face, 'state', 'sessions.json'), '{"mine":true}', 'utf8');
  fs.writeFileSync(path.join(face, 'modules', 'messenger', 'module.json'), '{"name":"messenger"}', 'utf8');
  fs.writeFileSync(path.join(face, 'node_modules', 'node-pty', 'pty.node'), 'old binary', 'utf8');

  const receipt = {
    schema: 1,
    package: { name: 'IRIS', version: '1.2.0', guideVersion: '10', license: 'MIT' },
    soul: { root, name: 'ALPHA', createdBy: 'package-installer' },
    installed: { face: { version: faceVersion, path: '_agent\\shared\\tools\\face', sha256: 'old', verified: true } },
    steps: { copy: 'done', login: 'done', handoff: 'done' },
  };
  fs.mkdirSync(path.dirname(receiptPath(root)), { recursive: true });
  fs.writeFileSync(receiptPath(root), JSON.stringify(receipt, null, 2), 'utf8');
  return { root, tools, face };
}

// The downloaded + verified new Face, already unpacked by the daemon into
// <downloads>\update-<stamp>\face (P02 설계 3절 5).
function makeNewFace(root, { version = '2.58.0', lock = '{"lockfileVersion":3,"old":true}' } = {}) {
  const dir = path.join(root, '_agent', 'shared', 'downloads', 'update-20260914-000000', 'face');
  fs.mkdirSync(path.join(dir, 'daemon'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'iris-face', version }), 'utf8');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), lock, 'utf8');
  fs.writeFileSync(path.join(dir, 'daemon', 'server.mjs'), 'new daemon', 'utf8');
  return dir;
}

// No pid, no port, no waiting: every test but the timeout one wants the swap,
// not a 90-second nap.
const NO_WAIT = { pid: null, port: null };

function fakeSpawn(calls) {
  return (exe, args, opts) => {
    calls.push({ exe, args, opts });
    return { pid: 4242, unref() {} };
  };
}

// --------------------------------------------------------------------------

test('updater: face swap keeps state/modules, rotates .prev, reuses node_modules, updates receipt and writes the result file', async () => {
  const { root, face } = makeSoul('case-swap');
  const dir = makeNewFace(root);
  const npmCalls = [];

  const result = await applyPlan({
    plan: { schema: 1, root, ...NO_WAIT, items: [{ kind: 'face', dir, version: '2.58.0' }], relaunch: false },
    npmInstall: async (a) => { npmCalls.push(a); return { code: 0, out: '', err: '' }; },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.items, [{ kind: 'face', version: '2.58.0', ok: true, reason: undefined }]);

  // the new code is in place
  assert.equal(JSON.parse(fs.readFileSync(path.join(face, 'package.json'), 'utf8')).version, '2.58.0');
  assert.equal(fs.readFileSync(path.join(face, 'daemon', 'server.mjs'), 'utf8'), 'new daemon');

  // the user's own folders travelled with it
  assert.equal(fs.readFileSync(path.join(face, 'state', 'sessions.json'), 'utf8'), '{"mine":true}');
  assert.equal(fs.readFileSync(path.join(face, 'modules', 'messenger', 'module.json'), 'utf8'), '{"name":"messenger"}');

  // identical package-lock.json -> node_modules moved over, npm never run
  assert.equal(npmCalls.length, 0, 'npm must not run when package-lock.json is unchanged');
  assert.equal(fs.readFileSync(path.join(face, 'node_modules', 'node-pty', 'pty.node'), 'utf8'), 'old binary');

  // the old copy is still there, under .prev, and nothing was deleted
  const prev = `${face}.prev`;
  assert.ok(fs.existsSync(prev), '.prev must exist');
  assert.equal(JSON.parse(fs.readFileSync(path.join(prev, 'package.json'), 'utf8')).version, '2.57.1');
  assert.equal(fs.existsSync(path.join(prev, 'node_modules')), false, 'node_modules was moved, not copied');

  // the download folder is consumed, not left behind
  assert.equal(fs.existsSync(dir), false);

  // receipt
  const receipt = JSON.parse(fs.readFileSync(receiptPath(root), 'utf8'));
  assert.equal(receipt.installed.face.version, '2.58.0');
  assert.equal(receipt.installed.face.previous, '_agent\\shared\\tools\\face.prev');
  assert.equal(receipt.installed.face.updatedBy, 'updater');
  assert.equal(typeof receipt.installed.face.at, 'string');
  assert.equal(receipt.package.version, '1.2.0', 'the updater must not touch the package version');

  // result file + log
  const written = JSON.parse(fs.readFileSync(updateResultPath(root), 'utf8'));
  assert.equal(written.ok, true);
  assert.equal(written.items[0].kind, 'face');
  assert.equal(typeof written.at, 'string');
  assert.match(fs.readFileSync(updateLogPath(root), 'utf8'), /apply start/);
});

test('updater: .prev-2 on a second update (no earlier copy is ever clobbered)', async () => {
  const { root, face } = makeSoul('case-prev2');
  fs.mkdirSync(`${face}.prev`, { recursive: true });
  fs.writeFileSync(path.join(`${face}.prev`, 'marker.txt'), 'first backup', 'utf8');

  const dir = makeNewFace(root);
  const result = await applyPlan({
    plan: { schema: 1, root, ...NO_WAIT, items: [{ kind: 'face', dir, version: '2.58.0' }], relaunch: false },
    npmInstall: async () => ({ code: 0 }),
  });

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(`${face}.prev`, 'marker.txt'), 'utf8'), 'first backup');
  assert.equal(JSON.parse(fs.readFileSync(path.join(`${face}.prev-2`, 'package.json'), 'utf8')).version, '2.57.1');
});

test('updater: a changed package-lock.json runs the bundled npm ci --omit=dev', async () => {
  const { root, face } = makeSoul('case-npm');
  const dir = makeNewFace(root, { lock: '{"lockfileVersion":3,"new":true}' });
  const npmCalls = [];

  const result = await applyPlan({
    plan: { schema: 1, root, ...NO_WAIT, items: [{ kind: 'face', dir, version: '2.58.0' }], relaunch: false },
    npmInstall: async (a) => {
      npmCalls.push(a);
      fs.mkdirSync(path.join(a.cwd, 'node_modules'), { recursive: true });
      return { code: 0 };
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(npmCalls.length, 1);
  assert.equal(npmCalls[0].npmCmd, path.join(toolsDir(root), 'node', 'npm.cmd'));
  assert.equal(npmCalls[0].cwd, face);
  assert.equal(npmCalls[0].nodeDir, path.join(toolsDir(root), 'node'));
  // the previous node_modules stays under .prev -- nothing is deleted
  assert.ok(fs.existsSync(path.join(`${face}.prev`, 'node_modules', 'node-pty', 'pty.node')));
});

test('updater: npm ci failure rolls back -- the previous face is restored and the result says why', async () => {
  const { root, face } = makeSoul('case-npm-fail');
  const dir = makeNewFace(root, { lock: '{"lockfileVersion":3,"new":true}' });

  const result = await applyPlan({
    plan: { schema: 1, root, ...NO_WAIT, items: [{ kind: 'face', dir, version: '2.58.0' }], relaunch: false },
    npmInstall: async () => ({ code: 1, err: 'ETARGET no matching version' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.items[0].reason, 'npm-ci-failed');

  // back to exactly what was there before
  assert.equal(JSON.parse(fs.readFileSync(path.join(face, 'package.json'), 'utf8')).version, '2.57.1');
  assert.equal(fs.readFileSync(path.join(face, 'daemon', 'server.mjs'), 'utf8'), 'old daemon');
  assert.equal(fs.readFileSync(path.join(face, 'state', 'sessions.json'), 'utf8'), '{"mine":true}');
  assert.ok(fs.existsSync(path.join(face, 'node_modules', 'node-pty', 'pty.node')));
  assert.equal(fs.existsSync(`${face}.prev`), false, 'the backup got its real name back');

  // the receipt still describes the old install
  assert.equal(JSON.parse(fs.readFileSync(receiptPath(root), 'utf8')).installed.face.version, '2.57.1');
  assert.equal(JSON.parse(fs.readFileSync(updateResultPath(root), 'utf8')).ok, false);
});

test('updater: an install with no receipt is still replaced, and the result says receipt-missing', async () => {
  const { root, face } = makeSoul('case-no-receipt');
  fs.rmSync(receiptPath(root), { force: true });
  const dir = makeNewFace(root);

  const result = await applyPlan({
    plan: { schema: 1, root, ...NO_WAIT, items: [{ kind: 'face', dir, version: '2.58.0' }], relaunch: false },
    npmInstall: async () => ({ code: 0 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.items[0].reason, 'receipt-missing');
  assert.equal(JSON.parse(fs.readFileSync(path.join(face, 'package.json'), 'utf8')).version, '2.58.0');
  assert.equal(fs.existsSync(receiptPath(root)), false, 'no receipt must be invented');
});

test('updater: a package item starts IRIS-설치.cmd with IRIS_INSTALLER_AUTO=1 and skips face', async () => {
  const { root, face } = makeSoul('case-package');
  const faceDir = makeNewFace(root);
  const pkgDir = path.join(root, '_agent', 'shared', 'downloads', 'update-20260914-000000', 'package');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'IRIS-설치.cmd'), '@echo off\r\n', 'utf8');

  const calls = [];
  const result = await applyPlan({
    plan: {
      schema: 1,
      root,
      ...NO_WAIT,
      items: [
        { kind: 'face', dir: faceDir, version: '2.58.0' },
        { kind: 'package', dir: pkgDir, version: '1.3.0' },
      ],
      relaunch: true,
    },
    spawnFn: fakeSpawn(calls),
    npmInstall: async () => { throw new Error('npm must not run for a package item'); },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.handedOffToInstaller, true);
  assert.equal(result.relaunched, false, 'the installer relaunches the window, not the updater');

  // exactly one spawn: the installer's .cmd, detached, with the auto flag
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(-1), /IRIS-설치\.cmd" --auto/);
  assert.equal(calls[0].opts.env.IRIS_INSTALLER_AUTO, '1');
  assert.equal(calls[0].opts.detached, true);

  // face was left completely alone (the package carries the new one)
  assert.equal(JSON.parse(fs.readFileSync(path.join(face, 'package.json'), 'utf8')).version, '2.57.1');
  assert.ok(fs.existsSync(faceDir), 'the face download is untouched');
  assert.equal(result.items.find((i) => i.kind === 'face').reason, 'skipped-included-in-package');
});

test('updater: relaunch uses wscript + launch-hidden.vbs when Face ships one', async () => {
  const { root, face } = makeSoul('case-relaunch');
  fs.writeFileSync(path.join(face, 'launch-hidden.vbs'), 'rem launcher', 'utf8');
  const dir = makeNewFace(root);
  fs.writeFileSync(path.join(dir, 'launch-hidden.vbs'), 'rem launcher', 'utf8');

  const calls = [];
  const result = await applyPlan({
    plan: { schema: 1, root, ...NO_WAIT, items: [{ kind: 'face', dir, version: '2.58.0' }], relaunch: true },
    npmInstall: async () => ({ code: 0 }),
    spawnFn: fakeSpawn(calls),
  });

  assert.equal(result.relaunched, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'wscript.exe');
  assert.deepEqual(calls[0].args, ['//nologo', path.join(face, 'launch-hidden.vbs')]);
  assert.equal(calls[0].opts.detached, true);
});

test('updater: the daemon never stopping leaves everything exactly as it was', async () => {
  const { root, face } = makeSoul('case-timeout');
  const dir = makeNewFace(root);
  const before = fs.readFileSync(path.join(face, 'package.json'), 'utf8');
  let slept = 0;

  const result = await applyPlan({
    plan: { schema: 1, root, daemonPid: 999999, daemonPort: 3458, items: [{ kind: 'face', dir, version: '2.58.0' }], relaunch: true },
    npmInstall: async () => { throw new Error('must not get this far'); },
    spawnFn: () => { throw new Error('must not relaunch'); },
    waitOptions: {
      timeoutMs: 40,
      pollMs: 10,
      pidAliveFn: () => true,
      portOpenFn: async () => true,
      sleep: async (ms) => { slept += ms; },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'daemon-still-running');
  assert.equal(result.items[0].reason, 'not-attempted');
  assert.ok(slept > 0, 'it really polled');
  assert.equal(fs.readFileSync(path.join(face, 'package.json'), 'utf8'), before);
  assert.equal(fs.existsSync(`${face}.prev`), false);
  assert.ok(fs.existsSync(dir), 'the download is left for a retry');
});

test('waitForDaemonStop: waits for BOTH the pid and the port to be gone', async () => {
  let ticks = 0;
  const r = await waitForDaemonStop({
    pid: 1234,
    port: 3458,
    timeoutMs: 10000,
    pollMs: 1,
    // pid dies first, the socket lingers two more polls
    pidAliveFn: () => ticks < 1,
    portOpenFn: async () => { ticks += 1; return ticks < 3; },
    sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.ok(ticks >= 3, 'it must not stop at the first "pid is gone"');
});

// updater/apply.mjs deliberately duplicates install.mjs's .prev rotation
// instead of importing it (the updater is installed on its own). This test is
// what keeps the copy honest: same inputs, same returned names, same folder.
test('preserveAside: the updater copy and installer/lib/install.mjs agree, rotation for rotation', () => {
  const base = path.join(tmp, 'parity');
  const results = {};
  for (const [label, fn] of [['updater', updaterPreserveAside], ['installer', installerPreserveAside]]) {
    const dir = path.join(base, label);
    const slot = path.join(dir, 'face');
    fs.mkdirSync(dir, { recursive: true });
    const moved = [fn(slot)]; // nothing there yet -> null
    for (let i = 0; i < 3; i++) {
      fs.mkdirSync(slot, { recursive: true });
      fs.writeFileSync(path.join(slot, 'n.txt'), String(i), 'utf8');
      const to = fn(slot);
      moved.push(to === null ? null : path.basename(to));
    }
    results[label] = { moved, listing: fs.readdirSync(dir).sort() };
  }
  assert.deepEqual(results.updater, results.installer);
  assert.deepEqual(results.updater.moved, [null, 'face.prev', 'face.prev-2', 'face.prev-3']);
  assert.deepEqual(results.updater.listing, ['face.prev', 'face.prev-2', 'face.prev-3']);
});
