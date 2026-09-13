#!/usr/bin/env node
// IRIS updater -- applies an already-downloaded, already-verified update.
//
//   node apply.mjs --plan <plan.json>
//
// Installed by the package as <root>\_agent\shared\tools\updater\apply.mjs and
// run with the bundled Node (<root>\_agent\shared\tools\node\node.exe). Pure
// ESM, zero dependencies, no network: everything it needs was fetched, hashed
// and signature-checked by the Face daemon before the plan was written
// (P02 docs\설계-업데이트-2026-09-14.md sections 3 and 4).
//
// Why a separate program at all: the daemon cannot replace its own folder
// while it is running out of it. So the daemon writes plan.json, starts this
// process detached, and shuts itself down; this process waits for the daemon
// to be gone, swaps the folders, fixes the receipt and starts the window
// again.
//
// Invariants (repo-wide): nothing the user might still want is ever deleted --
// a replaced folder is moved to <slot>.prev (.prev-2, .prev-3, ... if taken),
// exactly as installer/lib/install.mjs does. The one exception is clearing
// this run's own half-written output during a rollback, which is what gives
// the backup its real name back.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

export function toolsDir(root) { return path.join(root, '_agent', 'shared', 'tools'); }
export function setupDir(root) { return path.join(root, '_agent', 'setup'); }
export function updateLogPath(root) { return path.join(setupDir(root), 'update.log'); }
export function updateResultPath(root) { return path.join(setupDir(root), 'update-result.json'); }
export function receiptPath(root) { return path.join(setupDir(root), 'package-receipt.json'); }
export function faceDirFor(root) { return path.join(toolsDir(root), 'face'); }

function relToRoot(root, abs) {
  return path.relative(root, abs).split(path.sep).join('\\');
}

// ---------------------------------------------------------------------------
// never delete: move aside instead
// ---------------------------------------------------------------------------

// Deliberately a COPY of installer/lib/install.mjs's preserveAside(), not an
// import: the updater is installed on its own at <tools>\updater\ and must
// keep working when the installer's lib/ is nowhere near it. tests/updater.
// test.mjs pins the two implementations to the same behaviour instead.
export function preserveAside(slot) {
  if (!fs.existsSync(slot)) return null;
  let candidate = `${slot}.prev`;
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = `${slot}.prev-${n}`;
    n += 1;
  }
  fs.renameSync(slot, candidate);
  return candidate;
}

// A rename that survives the source and destination being on different
// volumes (a download folder redirected elsewhere): copy + remove.
function moveDir(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// atomic json (same rule as installer/lib/receipt.mjs writeReceipt)
// ---------------------------------------------------------------------------

export function writeJsonAtomic(dest, value) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

export function makeLogger(root) {
  const file = updateLogPath(root);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* logged nowhere, then */ }
  return (text) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${text}\r\n`, 'utf8');
    } catch { /* a log that cannot be written must never fail the update */ }
  };
}

// ---------------------------------------------------------------------------
// waiting for the daemon to be gone
// ---------------------------------------------------------------------------

export const DAEMON_WAIT_MS = 90000;
export const DAEMON_POLL_MS = 500;

// Two independent signals, because either one alone lies:
//   - the pid can be recycled, or belong to a process this user may not
//     signal (EPERM -> still there, as far as we are concerned);
//   - the port can be held by something else entirely, and a daemon that
//     crashed without closing its socket is rare but real.
// Only when BOTH say "gone" does the swap start.
export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function isPortOpen(port, { host = '127.0.0.1', timeoutMs = 1000 } = {}) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForDaemonStop({
  pid,
  port,
  timeoutMs = DAEMON_WAIT_MS,
  pollMs = DAEMON_POLL_MS,
  pidAliveFn = isPidAlive,
  portOpenFn = isPortOpen,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  for (;;) {
    const pidAlive = pid ? await pidAliveFn(pid) : false;
    const portOpen = port ? await portOpenFn(port) : false;
    if (!pidAlive && !portOpen) {
      return { ok: true, waitedMs: now() - startedAt };
    }
    if (now() - startedAt >= timeoutMs) {
      return {
        ok: false,
        reason: 'daemon-still-running',
        waitedMs: now() - startedAt,
        pidAlive,
        portOpen,
      };
    }
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// npm ci (only when package-lock.json changed)
// ---------------------------------------------------------------------------

const COMSPEC = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

// Same shape as installer/lib/install.mjs's runWrapper(): Node 24 refuses to
// spawn a .cmd without a shell, and `shell: true` would re-quote the
// arguments, so the npm wrapper goes through cmd.exe with a hand-built
// verbatim command line. The bundled node folder goes to the FRONT of PATH so
// npm.cmd finds the runtime it belongs to.
export function defaultNpmInstall({ npmCmd, cwd, nodeDir }) {
  const line = `""${npmCmd}" ci --omit=dev"`;
  const env = { ...process.env };
  if (nodeDir) env.PATH = `${nodeDir};${env.PATH ?? ''}`;
  return new Promise((resolve) => {
    const child = spawn(COMSPEC, ['/d', '/s', '/c', line], {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 600000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: e.message }); });
  });
}

// ---------------------------------------------------------------------------
// the face item
// ---------------------------------------------------------------------------

function readTextOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// Carried over from the previous install because they are the user's, not the
// package's: `state` is the daemon's runtime state (session cards, settings,
// voice hints) and `modules` holds installed extension modules.
const CARRY_OVER = ['state', 'modules'];

export async function applyFaceItem({
  root,
  dir,
  version,
  npmInstall = defaultNpmInstall,
  log = () => {},
}) {
  const tools = toolsDir(root);
  const slot = faceDirFor(root);
  if (!fs.existsSync(dir)) return { ok: false, reason: 'source-missing' };

  fs.mkdirSync(tools, { recursive: true });
  const newLock = readTextOrNull(path.join(dir, 'package-lock.json'));
  const moved = preserveAside(slot);
  log(`face: previous=${moved ? relToRoot(root, moved) : 'none'}`);

  const rollback = () => {
    try {
      if (fs.existsSync(slot)) {
        fs.rmSync(slot, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      }
    } catch {
      return false; // slot still occupied -> never clobber it with the backup
    }
    if (moved && fs.existsSync(moved) && !fs.existsSync(slot)) {
      try { fs.renameSync(moved, slot); return true; } catch { return false; }
    }
    return moved === null;
  };

  {
    // --- ① the new folder takes the slot --------------------------------
    try {
      moveDir(dir, slot);
    } catch (err) {
      const restored = rollback();
      return { ok: false, reason: 'move-failed', detail: String(err?.message ?? err), restored };
    }

    // --- ② node_modules: reuse the old one, or run npm ci ---------------
    // Deliberately BEFORE carrying `state`/`modules` over: everything up to
    // here is undoable by deleting the new folder, and once the user's own
    // folders have been moved into it, deleting it would destroy them.
    const prevModules = moved ? path.join(moved, 'node_modules') : null;
    const oldLock = moved ? readTextOrNull(path.join(moved, 'package-lock.json')) : null;
    let npm = null;
    if (prevModules && fs.existsSync(prevModules) && oldLock !== null && oldLock === newLock) {
      try {
        moveDir(prevModules, path.join(slot, 'node_modules'));
        log('face: node_modules reused (package-lock.json unchanged)');
      } catch (err) {
        const restored = rollback();
        return { ok: false, reason: 'node-modules-move-failed', detail: String(err?.message ?? err), restored };
      }
    } else {
      const nodeDir = path.join(tools, 'node');
      const npmCmd = path.join(nodeDir, 'npm.cmd');
      log('face: package-lock.json changed (or no previous node_modules) -> npm ci --omit=dev');
      npm = await npmInstall({ npmCmd, cwd: slot, nodeDir });
      if (!npm || npm.code !== 0) {
        const detail = String(npm?.err || npm?.out || `npm exit ${npm?.code}`).slice(0, 300);
        log(`face: npm ci FAILED ${detail}`);
        const restored = rollback();
        return { ok: false, reason: 'npm-ci-failed', detail, restored };
      }
      log('face: npm ci ok');
    }

    // --- ③ the user's own folders travel with the new copy ---------------
    // Failure here is reported, never rolled back: nothing has been deleted,
    // the folders are still in <slot>.prev, and undoing the swap at this
    // point would mean deleting a folder that now holds user data.
    const carried = [];
    const carryFailed = [];
    for (const name of CARRY_OVER) {
      const from = moved ? path.join(moved, name) : null;
      if (!from || !fs.existsSync(from)) continue;
      const to = path.join(slot, name);
      try {
        if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
        moveDir(from, to);
        carried.push(name);
      } catch (err) {
        carryFailed.push(`${name}: ${String(err?.message ?? err)}`);
      }
    }
    log(`face: carried=${carried.join(',') || 'none'}${carryFailed.length ? ` failed=${carryFailed.join(' | ')}` : ''}`);

    // --- ④ receipt ------------------------------------------------------
    const receiptFile = receiptPath(root);
    const receipt = readJson(receiptFile);
    let reason = carryFailed.length ? `carry-over-failed: ${carryFailed.join(' | ')}` : undefined;
    if (!receipt) {
      // An install from before the receipt existed. Do not invent one -- the
      // receipt is the installer's artefact and a made-up one would claim
      // parts nobody checked. Say so and carry on; the swap already happened.
      reason = reason ? `${reason}; receipt-missing` : 'receipt-missing';
      log('face: no receipt to update (older install)');
    } else {
      receipt.installed = receipt.installed ?? {};
      receipt.installed.face = {
        ...(receipt.installed.face ?? {}),
        version: version ?? null,
        path: relToRoot(root, slot),
        // The zip's hash and signature were checked by the daemon before this
        // plan was written; the per-part sha256 in the receipt is the
        // installer's payload hash, which no longer describes what is on disk.
        sha256: null,
        verified: true,
        detail: 'replaced by updater',
        previous: moved ? relToRoot(root, moved) : null,
        at: new Date().toISOString(),
        updatedBy: 'updater',
      };
      writeJsonAtomic(receiptFile, receipt);
      log(`face: receipt installed.face.version=${version ?? 'null'}`);
    }

    return {
      ok: true,
      reason,
      previous: moved ? relToRoot(root, moved) : null,
      carried,
      npmRan: npm !== null,
    };
  }
}

// ---------------------------------------------------------------------------
// the package item -- hand the whole job to the installer's automatic mode
// ---------------------------------------------------------------------------

export function applyPackageItem({ root, dir, spawnFn = spawn, log = () => {} }) {
  const cmd = path.join(dir, 'IRIS-설치.cmd');
  if (!fs.existsSync(cmd)) return { ok: false, reason: 'installer-cmd-missing', detail: cmd };
  try {
    const child = spawnFn(COMSPEC, ['/d', '/s', '/c', `""${cmd}" --auto"`], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env, IRIS_INSTALLER_AUTO: '1', IRIS_UPDATE_ROOT: root },
    });
    child.unref?.();
    log(`package: started ${cmd} (pid ${child.pid}) with IRIS_INSTALLER_AUTO=1`);
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, reason: 'installer-spawn-failed', detail: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// relaunch
// ---------------------------------------------------------------------------

export function relaunchFace({ root, spawnFn = spawn, log = () => {} }) {
  const faceDir = faceDirFor(root);
  const vbs = path.join(faceDir, 'launch-hidden.vbs');
  try {
    if (fs.existsSync(vbs)) {
      const child = spawnFn('wscript.exe', ['//nologo', vbs], {
        cwd: faceDir, detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref?.();
      log(`relaunch: wscript ${vbs} (pid ${child.pid})`);
      return { ok: true, how: 'wscript', pid: child.pid };
    }
    // A Face too old to ship the hidden launcher: the visible window is
    // still better than leaving the person with no window at all.
    const nodeExe = path.join(toolsDir(root), 'node', 'node.exe');
    const child = spawnFn(nodeExe, [path.join(faceDir, 'launch.mjs')], {
      cwd: faceDir, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref?.();
    log(`relaunch: node launch.mjs (pid ${child.pid}) -- no launch-hidden.vbs`);
    return { ok: true, how: 'node', pid: child.pid };
  } catch (err) {
    log(`relaunch FAILED ${String(err?.message ?? err)}`);
    return { ok: false, reason: 'relaunch-failed', detail: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * applyPlan({plan, ...deps}) -> Promise<result>
 *
 * result = { ok, items:[{kind, version, ok, reason?}], at, ... } and is also
 * written to <root>\_agent\setup\update-result.json, which is what Face reads
 * on its next start to show "업데이트 완료".
 */
export async function applyPlan({
  plan,
  npmInstall = defaultNpmInstall,
  spawnFn = spawn,
  waitFn = waitForDaemonStop,
  waitOptions = {},
  logger,
} = {}) {
  const root = plan?.root;
  if (!root) throw new Error('apply: plan.root is required');
  const log = logger ?? makeLogger(root);
  const at = () => new Date().toISOString();

  const planItems = Array.isArray(plan.items) ? plan.items : [];
  log(`apply start root=${root} items=${planItems.map((i) => `${i.kind}@${i.version ?? '?'}`).join(',') || 'none'}`);

  const finish = (result) => {
    try { writeJsonAtomic(updateResultPath(root), result); } catch (err) {
      log(`result file could not be written: ${String(err?.message ?? err)}`);
    }
    log(`apply done ok=${result.ok} ${result.reason ? `reason=${result.reason}` : ''}`);
    return result;
  };

  // --- ① wait for the daemon to be gone ---------------------------------
  const waited = await waitFn({
    pid: plan.daemonPid,
    port: plan.daemonPort,
    ...waitOptions,
  });
  if (!waited.ok) {
    log(`daemon still running after ${waited.waitedMs}ms (pid=${waited.pidAlive} port=${waited.portOpen}) -- nothing changed`);
    return finish({
      ok: false,
      reason: waited.reason ?? 'daemon-still-running',
      items: planItems.map((i) => ({ kind: i.kind, version: i.version ?? null, ok: false, reason: 'not-attempted' })),
      at: at(),
    });
  }
  log(`daemon gone after ${waited.waitedMs}ms`);

  // --- ② a package item swallows the whole job ---------------------------
  // The structural package already contains the newest Face, so a plan that
  // carries one hands everything to the installer's automatic mode and stops
  // here: the installer replaces the changed parts, fixes the receipt and
  // starts the window itself (P02 설계 4-2).
  const pkg = planItems.find((i) => i.kind === 'package');
  if (pkg) {
    const r = applyPackageItem({ root, dir: pkg.dir, spawnFn, log });
    const items = planItems.map((i) => (i === pkg
      ? { kind: 'package', version: pkg.version ?? null, ok: r.ok, reason: r.reason }
      : { kind: i.kind, version: i.version ?? null, ok: true, reason: 'skipped-included-in-package' }));
    return finish({ ok: r.ok, items, at: at(), handedOffToInstaller: r.ok, relaunched: false });
  }

  // --- ③ per-item -------------------------------------------------------
  const items = [];
  for (const item of planItems) {
    if (item.kind === 'face') {
      const r = await applyFaceItem({ root, dir: item.dir, version: item.version, npmInstall, log });
      items.push({ kind: 'face', version: item.version ?? null, ok: r.ok, reason: r.reason });
    } else {
      log(`item ${item.kind}: unknown kind, skipped`);
      items.push({ kind: item.kind, version: item.version ?? null, ok: false, reason: 'unknown-kind' });
    }
  }

  const ok = items.length > 0 && items.every((i) => i.ok);

  // --- ④ the window comes back either way -------------------------------
  // Even a failed item ends with the previous copy restored, so the person
  // must not be left staring at a desktop with no IRIS window.
  let relaunch = null;
  if (plan.relaunch) relaunch = relaunchFace({ root, spawnFn, log });

  return finish({ ok, items, at: at(), relaunched: relaunch?.ok ?? false });
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') args.plan = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!args.plan) throw new Error('usage: node apply.mjs --plan <plan.json>');
  return args;
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const plan = readJson(path.resolve(args.plan));
  if (!plan) {
    console.error(`apply: plan not readable: ${args.plan}`);
    process.exit(2);
  }
  applyPlan({ plan })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(`apply: ${err?.stack ?? err}`);
      process.exit(2);
    });
}
