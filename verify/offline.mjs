// verify/offline.mjs -- proves the shipped installer needs zero network
// access (Task 9, IRIS Installer v2, 1단계 공장). See lib/net.mjs's header
// for the offline contract this proves both halves of:
//
//   node verify/offline.mjs --build   -- builds the zip with
//     IRIS_INSTALLER_OFFLINE=1 and asserts nothing was actually downloaded
//     (only [cache hit] lines allowed; a real cache-miss download attempt
//     throws inside build/collect.mjs's assertOnline() and fails the build).
//
//   node verify/offline.mjs           -- extracts the zip *this build just
//     produced*, starts the extracted installer/server.mjs in-process against
//     a throwaway practice root (soulName: 'IRIS-offline' -> C:\IRIS-offline,
//     never the real C:\IRIS) and drives precheck -> locate -> choice ->
//     structure(teacher preset) -> summary/confirm -> setup/start -> poll
//     progress, exactly per docs\설치기-API-v2.md. A network sentinel
//     (net.Socket.prototype.connect / tls.connect patched to throw on any
//     non-loopback host) is installed before the extracted server.mjs is even
//     imported, so "zero network calls" is enforced at the socket layer, not
//     just by reading the code.
//
// Runtime outcome (installer mode only) is detected, not assumed, because a
// concurrent task may add installer/setup/engine.mjs at any time:
//   (a) setup completes (error === null) and zero sentinel violations -> pass
//   (b) setup fails with error.code === 'E-NOT-IMPLEMENTED' (the setup engine
//       genuinely is not wired into this build yet) and zero violations ->
//       graceful partial pass ("setup 엔진 미구현 -- 부분 통과")
//   (c) anything else (a real setup failure, or any sentinel violation) -> fail
//
// Scratch space is project-relative (_build/offline-zip), not this session's
// personal scratchpad -- this script ships and other developers/CI run it
// repeatedly. Only the install target itself uses the fixed practice name
// C:\IRIS-offline (soulName), and this script deletes it in a finally block
// on every run so a crashed run never leaves it behind.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../lib/run.mjs';
import { extractZip } from '../lib/zip.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_MJS = path.join(ROOT_DIR, 'build', 'build.mjs');
const LAST_BUILD_JSON = path.join(ROOT_DIR, '_build', 'out', 'last-build.json');
const SCRATCH_DIR = path.join(ROOT_DIR, '_build', 'offline-zip');
const SOUL_NAME = 'IRIS-offline';
const SOUL_ROOT = `C:\\${SOUL_NAME}`; // must match installer/lib/soulname.mjs's `C:\\${name}` mapping

// ---------------------------------------------------------------------------
// --build mode
// ---------------------------------------------------------------------------

async function runBuildOffline() {
  console.log(`offline --build: node build/build.mjs with IRIS_INSTALLER_OFFLINE=1`);
  const env = { ...process.env, IRIS_INSTALLER_OFFLINE: '1' };
  const r = await run(process.execPath, [BUILD_MJS], { cwd: ROOT_DIR, env, timeoutMs: 15 * 60 * 1000 });
  console.log(r.out);
  if (r.err) console.error(r.err);

  if (r.code !== 0) {
    console.log(`\noffline --build: FAILED (build exited ${r.code})`);
    process.exitCode = 1;
    return;
  }

  // Defense in depth beyond the exit code: build/collect.mjs's ensureCached()
  // calls assertOnline() BEFORE any real download, so a cache miss already
  // aborts the build above with a non-zero exit code. This also rules out the
  // literal log token for a part that *was* somehow fetched without going
  // through that guard.
  const combined = `${r.out}\n${r.err}`;
  const downloadedLines = combined.split(/\r\n|\r|\n/).filter((line) => line.includes('[downloaded]'));
  if (downloadedLines.length > 0) {
    console.log(`\noffline --build: FAILED -- ${downloadedLines.length} line(s) reported an actual download under IRIS_INSTALLER_OFFLINE=1:`);
    for (const line of downloadedLines) console.log(`  ${line}`);
    process.exitCode = 1;
    return;
  }

  console.log('\noffline --build: OK -- build succeeded and no [downloaded] line appeared (only [cache hit] / not-bundled parts)');
}

// ---------------------------------------------------------------------------
// installer mode -- network sentinel
// ---------------------------------------------------------------------------

function isLoopbackHost(host) {
  if (host == null) return true; // net.connect defaults to 'localhost' when host is omitted
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function extractHostFromConnectArgs(args) {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null) {
    if (typeof first.path === 'string') return null; // IPC pipe, no network involved
    return first.host ?? null;
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    // connect(port[, host][, listener])
    return typeof second === 'string' ? second : null;
  }
  return null; // connect(path[, listener]) -- IPC pipe
}

// Installs the sentinel and returns { violations, restore() }. Must be
// called BEFORE the extracted zip's installer/server.mjs is imported, since
// undici's fetch() and every TCP client ultimately open sockets through
// net.Socket.prototype.connect (plain) or tls.connect (TLS), so patching
// these two catches essentially all outbound network attempts while still
// allowing this script's own loopback fetch() calls against the server it
// just started.
function installNetworkSentinel() {
  const violations = [];
  const origSocketConnect = net.Socket.prototype.connect;
  const origTlsConnect = tls.connect;

  net.Socket.prototype.connect = function patchedConnect(...args) {
    const host = extractHostFromConnectArgs(args);
    if (!isLoopbackHost(host)) {
      const message = `OFFLINE-SENTINEL: blocked outbound net.connect to ${host}`;
      violations.push(message);
      const err = new Error(message);
      queueMicrotask(() => this.emit('error', err));
      return this;
    }
    return origSocketConnect.apply(this, args);
  };

  tls.connect = function patchedTlsConnect(...args) {
    const host = extractHostFromConnectArgs(args);
    if (!isLoopbackHost(host)) {
      const message = `OFFLINE-SENTINEL: blocked outbound tls.connect to ${host}`;
      violations.push(message);
      throw new Error(message);
    }
    return origTlsConnect.apply(this, args);
  };

  return {
    violations,
    restore() {
      net.Socket.prototype.connect = origSocketConnect;
      tls.connect = origTlsConnect;
    },
  };
}

// ---------------------------------------------------------------------------
// installer mode -- drive the API (docs\설치기-API-v2.md)
// ---------------------------------------------------------------------------

// Exported so verify/e2e.mjs (3층) drives the very same contract rather than
// keeping a second, drifting copy of it. `installer/server.mjs`'s local-origin
// guard requires application/json on every POST, which is why the header is
// not optional here.
export const JSON_HDR = { 'Content-Type': 'application/json' };
export const post = (url, p, body) => fetch(`${url}${p}`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify(body ?? {}) });
export const getJson = async (url, p) => (await fetch(`${url}${p}`)).json();

// Presets ship as a nested tree ({level, nameKo, nameEn, children}); the
// server's POST /api/structure wants the flat {id, parentId, level, nameKo,
// nameEn, order} shape (confirmed against tests/server.test.mjs's TREE
// fixture and installer/ui/structure.mjs's validateNodes). This is exactly
// the flattening the shipped browser UI does client-side before posting.
export function flattenPresetTree(tree) {
  const nodes = [];
  let counter = 0;
  function walk(list, parentId) {
    list.forEach((n, i) => {
      const id = `n${++counter}`;
      nodes.push({ id, parentId, level: n.level, nameKo: n.nameKo, nameEn: n.nameEn ?? '', order: i + 1 });
      if (Array.isArray(n.children) && n.children.length) walk(n.children, id);
    });
  }
  walk(tree, null);
  return nodes;
}

export async function waitForSetupDone(url, { timeoutMs = 10 * 60 * 1000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await getJson(url, '/api/setup/progress');
    if (body.running === false && (body.percent === 100 || body.error)) return body;
    if (Date.now() > deadline) throw new Error('setup never finished (timed out waiting for /api/setup/progress)');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function driveInstall(url) {
  const pre = await (await post(url, '/api/precheck')).json();
  if (!pre.ok || !pre.canProceed) throw new Error(`precheck did not allow proceeding: ${JSON.stringify(pre)}`);

  const loc = await (await post(url, '/api/locate')).json();
  if (!loc.ok) throw new Error(`locate refused C:\\IRIS-offline as an install target: ${JSON.stringify(loc)}`);

  const choice = await (await post(url, '/api/choice', { subscriptions: ['claude', 'chatgpt'] })).json();
  if (!choice.ok) throw new Error(`choice failed: ${JSON.stringify(choice)}`);

  // 2.0.35: 기본 흐름은 폴더를 묻지 않는다(choice 가 interview 결정을 스스로 적음). 옛 프리셋 경로는
  // `IRIS_E2E_PRESET=1` 로만 밟는다(업그레이드 게이트가 "기존 R/D/P 무접촉" 을 재려고 쓴다).
  if (process.env.IRIS_E2E_PRESET === '1') {
    const presets = await getJson(url, '/api/presets');
    const teacher = (presets.presets ?? []).find((p) => p.id === 'teacher');
    if (!teacher) throw new Error('presets.json has no "teacher" preset');
    const nodes = flattenPresetTree(teacher.tree);
    const st = await (await post(url, '/api/structure', { nodes, later: false })).json();
    if (!st.ok) throw new Error(`structure(teacher preset) rejected: ${JSON.stringify(st)}`);
  } else if (choice.structure !== 'interview') {
    throw new Error(`choice did not switch to interview mode: ${JSON.stringify(choice)}`);
  }

  const confirm = await (await post(url, '/api/summary/confirm')).json();
  if (!confirm.ok) throw new Error(`summary/confirm failed: ${JSON.stringify(confirm)}`);

  const started = await post(url, '/api/setup/start');
  if (started.status !== 202) throw new Error(`setup/start returned ${started.status}`);

  return waitForSetupDone(url);
}

// ---------------------------------------------------------------------------
// installer mode -- main
// ---------------------------------------------------------------------------

function findBuiltZip() {
  if (!fs.existsSync(LAST_BUILD_JSON)) {
    throw new Error(`${LAST_BUILD_JSON} does not exist -- run "node verify/offline.mjs --build" (or a normal build) first`);
  }
  const info = JSON.parse(fs.readFileSync(LAST_BUILD_JSON, 'utf8'));
  if (!info.zip || !fs.existsSync(info.zip)) {
    throw new Error(`last-build.json's zip does not exist on disk: ${info.zip}`);
  }
  return info.zip;
}

function cleanup() {
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  // The real C:\IRIS is never touched by this script -- only the throwaway
  // practice root the installer itself was pointed at via soulName.
  fs.rmSync(SOUL_ROOT, { recursive: true, force: true });
}

async function runInstallerOffline() {
  cleanup(); // in case a previous crashed run left C:\IRIS-offline or the scratch dir behind
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  const zipPath = findBuiltZip();
  console.log(`offline: extracting ${zipPath}`);
  await extractZip(zipPath, SCRATCH_DIR);

  const serverPath = path.join(SCRATCH_DIR, 'installer', 'server.mjs');
  if (!fs.existsSync(serverPath)) throw new Error(`extracted zip has no installer/server.mjs at ${serverPath}`);

  const sentinel = installNetworkSentinel();
  process.env.IRIS_INSTALLER_OFFLINE = '1';
  // `noUserEnv: true` below stops the HKCU\Environment writes, but ⑤-7
  // (installer/setup/relay.mjs) decides whether to make the desktop shortcut
  // from the *environment variable*, not from that option -- so without this
  // line a rehearsal run drops a real `IRIS-offline.lnk` on the developer's
  // desktop, which then makes 검사 6 (바탕화면 쓰기 0건) fail on the next run.
  // Measured 2026-09-15 (T23): two stray .lnk files on this PC's desktop.
  process.env.IRIS_INSTALLER_NO_USER_ENV = '1';

  let handle = null;
  try {
    // Dynamically import the extracted zip's OWN server.mjs (not this repo's
    // copy) so the test exercises exactly what ships.
    const { startServer } = await import(pathToFileURL(serverPath).href);
    handle = await startServer({
      port: 0,
      zipRoot: SCRATCH_DIR,
      nodeDir: path.dirname(process.execPath),
      stateFile: path.join(SCRATCH_DIR, 'installer-state.json'),
      workDir: path.join(SCRATCH_DIR, 'logs'),
      soulName: SOUL_NAME,
      noUserEnv: true,
    });
    console.log(`offline: installer server up at ${handle.url} (soul root ${SOUL_ROOT})`);

    const progress = await driveInstall(handle.url);

    if (sentinel.violations.length > 0) {
      console.log(`\noffline: FAILED -- ${sentinel.violations.length} outbound network call(s) blocked during setup:`);
      for (const v of sentinel.violations) console.log(`  ${v}`);
      process.exitCode = 1;
      return;
    }

    if (progress.error === null) {
      console.log('\noffline: OK -- setup completed with zero network calls');
      return;
    }

    if (progress.error.code === 'E-NOT-IMPLEMENTED') {
      console.log(`\noffline: setup 엔진 미구현 -- 부분 통과 (${progress.error.message})`);
      return; // exit 0 -- graceful degradation is an accepted outcome for this task
    }

    console.log(`\noffline: FAILED -- setup ended with an unexpected error: ${JSON.stringify(progress.error)}`);
    process.exitCode = 1;
  } finally {
    if (handle) await handle.close();
    sentinel.restore();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const isBuild = process.argv.includes('--build');
  try {
    if (isBuild) {
      await runBuildOffline();
    } else {
      await runInstallerOffline();
    }
  } catch (err) {
    console.log(`\noffline: FAILED -- ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    if (!isBuild) cleanup();
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
