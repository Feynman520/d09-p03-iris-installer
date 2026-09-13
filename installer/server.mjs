#!/usr/bin/env node
// IRIS installer local server. Launched by installer/bootstrap.ps1 as:
//   node server.mjs --zip-root "<zipRoot>" --port 3460 --node-dir "<nodeDir>"
// node:http only, no dependencies, ESM. 127.0.0.1 only. English/code
// messages only -- Korean UI text lives in installer/ui/index.html, not
// here (repo-wide constraint: server messages are for logs/JSON, not
// screens).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initialState, loadState, saveState } from './lib/state.mjs';
import { precheck } from './lib/precheck.mjs';
import { validateSoulName, detectExisting } from './lib/soulname.mjs';
import { install as defaultInstall } from './lib/install.mjs';
import { ensureProxy as defaultEnsureProxy } from './lib/proxy.mjs';
import {
  startCliLogin as defaultStartCliLogin,
  cliLoginStatus as defaultCliLoginStatus,
  relayImport as defaultRelayImport,
  relayStatus as defaultRelayStatus,
  resolveTeamclaudeConfigPath,
  countProviderAccounts as defaultCountProviderAccounts,
} from './lib/login.mjs';
import {
  readReceipt, writeReceipt, setLogin as setReceiptLogin, markStep as markReceiptStep,
} from './lib/receipt.mjs';
import {
  writeFirstRequest as defaultWriteFirstRequest,
  writeFaceLauncher as defaultWriteFaceLauncher,
  writeFirstSessionSpec as defaultWriteFirstSessionSpec,
  launchFace as defaultLaunchFace,
  relaunchFace as defaultRelaunchFace,
  waitFaceReady as defaultWaitFaceReady,
  finish as defaultFinish,
} from './lib/handoff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// small http helpers
// ---------------------------------------------------------------------------
function writeHeaders(res, status, extra = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...extra });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  writeHeaders(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

// Rejects with statusCode 413 once `limit` is exceeded, but does NOT destroy
// the request/socket itself -- that is the caller's job, and only *after*
// the 413 JSON response has been written and flushed (see withBody). Doing
// it here raced the response write against the socket teardown and produced
// a client-side ECONNRESET instead of the coded 413 (fix round 1 finding 1).
// Memory still stays bounded: once overLimit flips, further chunks are
// dropped on the floor (never pushed to `chunks`) instead of being buffered.
function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overLimit = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (overLimit) return; // already rejected; drop without buffering
      size += chunk.length;
      if (size > limit) {
        overLimit = true;
        chunks.length = 0; // release what we had buffered so far
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overLimit) return; // already settled above
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid json'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// local-origin guard (2026-09-12 final review I3)
// ---------------------------------------------------------------------------
// The installer server binds 127.0.0.1 only, but "local" is not "safe": any
// page the person happens to have open in the same browser can POST to
// http://127.0.0.1:3460/api/... (drive-by CSRF), and that means naming a
// soul folder, starting the install, or quitting the installer from a
// foreign site. Two cheap, complementary checks close it:
//
//   1. Origin: browsers send it on every cross-origin request (and on all
//      POSTs). A present Origin that is not this very server is rejected.
//      An absent Origin is allowed on purpose -- same-origin GETs,
//      EventSource, bootstrap.ps1's Invoke-WebRequest health probe and
//      verify/static.mjs's smoke check all send none.
//   2. Content-Type: application/json cannot be produced by a plain
//      <form> post (the CORS "simple request" content types are
//      form-urlencoded / multipart / text-plain), so requiring it on every
//      /api POST forces any cross-site attempt into a preflight, which
//      check 1 then refuses.
export function allowedOrigins(port) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

export function checkApiRequest(req, port) {
  const origin = req.headers?.origin;
  if (origin && !allowedOrigins(port).includes(origin)) {
    return { ok: false, status: 403, reason: 'bad_origin' };
  }
  if (req.method === 'POST') {
    const ct = req.headers?.['content-type'] ?? '';
    if (!ct.toLowerCase().startsWith('application/json')) {
      return { ok: false, status: 415, reason: 'unsupported_media_type' };
    }
  }
  return { ok: true };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Static files come only from installer/ui/ -- GET / -> ui/index.html
// (which does not exist yet as of Task 10; Task 14 adds it, so this
// currently 404s, by design). path.normalize + a startsWith prefix check
// keeps `..`/absolute-path segments in the URL from escaping uiDir.
function serveStatic(uiDir, pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.slice(1));
  } catch {
    sendJson(res, 400, { ok: false, reason: 'bad_request' });
    return;
  }
  const resolved = path.normalize(path.join(uiDir, rel));
  const uiDirNormalized = path.normalize(uiDir);
  if (resolved !== uiDirNormalized && !resolved.startsWith(uiDirNormalized + path.sep)) {
    sendJson(res, 403, { ok: false, reason: 'forbidden' });
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, reason: 'not_found' });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    writeHeaders(res, 200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function readPackageVersion(zipRoot) {
  try {
    const manifestPath = path.join(zipRoot, 'payload', 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return mf?.package?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// --no-user-env / IRIS_INSTALLER_NO_USER_ENV=1: a userpath implementation
// that records what install() *would* have written to HKCU\Environment and
// writes nothing. The receipt still gets the same env values (that is what
// the setting-up agent reads), only the registry is left alone. Exists for
// rehearsals on a machine that is already a working IRIS soul -- a live
// install there would repoint CLAUDE_CONFIG_DIR / CODEX_HOME /
// ANTHROPIC_BASE_URL and the user Path at the rehearsal folder.
export function recordingUserpath(record = []) {
  return {
    record,
    // install() reads these two to stamp receipt.env.applied=false +
    // skippedReason, so a rehearsal receipt can never be mistaken for a real
    // install's (fix round 1 finding 3).
    recording: true,
    skippedReason: 'no-user-env',
    addUserPath: async (dir) => {
      record.push({ op: 'addUserPath', dir });
      return { changed: false, before: '', after: '', recorded: true };
    },
    removeUserPath: async (dir) => {
      record.push({ op: 'removeUserPath', dir });
      return { changed: false, before: '', after: '', recorded: true };
    },
    setUserEnv: async (name, value) => {
      record.push({ op: 'setUserEnv', name, value });
      return { changed: false, previous: null, recorded: true };
    },
    removeUserEnv: async (name) => {
      record.push({ op: 'removeUserEnv', name });
      return { changed: false, previous: null, recorded: true };
    },
    readUserEnv: async () => ({ exists: false, type: null, value: null }),
  };
}

function withBody(handler) {
  return async (req, res, url) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const status = err.statusCode ?? 400;
      if (status === 413) {
        // The client may still be streaming the rest of an oversized body.
        // Write the JSON response (with Connection: close so the socket is
        // not reused for a request we never fully read) and only destroy
        // the request stream once that response has actually been flushed,
        // so the client sees the coded 413 instead of a connection reset.
        sendJson(res, 413, { ok: false, reason: 'bad_request' }, { Connection: 'close' });
        res.on('finish', () => { req.destroy(); });
      } else {
        sendJson(res, status, { ok: false, reason: 'bad_request' });
      }
      return;
    }
    await handler(body, req, res, url);
  };
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function readPayloadManifest(zipRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(zipRoot, 'payload', 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

// lock.json is a build-time artifact that also travels in the zip next to
// installer/ (it is what says which parts exist, their kinds and the
// download-only ones). Fall back to the repo copy when running from a git
// checkout (dev / rehearsal).
function readLock(zipRoot) {
  const candidates = [
    zipRoot ? path.join(zipRoot, 'lock.json') : null,
    path.resolve(HERE, '..', 'lock.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* try next */ }
  }
  return null;
}

export function startServer({
  port = 3460,
  zipRoot,
  nodeDir,
  stateFile,
  onQuit,
  installFn = defaultInstall,
  ensureProxyFn = defaultEnsureProxy,
  startCliLoginFn = defaultStartCliLogin,
  cliLoginStatusFn = defaultCliLoginStatus,
  relayImportFn = defaultRelayImport,
  relayStatusFn = defaultRelayStatus,
  countProviderAccountsFn = defaultCountProviderAccounts,
  teamclaudeConfigPath,
  writeFirstRequestFn = defaultWriteFirstRequest,
  writeFaceLauncherFn = defaultWriteFaceLauncher,
  writeFirstSessionSpecFn = defaultWriteFirstSessionSpec,
  launchFaceFn = defaultLaunchFace,
  relaunchFaceFn = defaultRelaunchFace,
  waitFaceReadyFn = defaultWaitFaceReady,
  finishFn = defaultFinish,
  readReceiptFn = readReceipt,
  facePort,
  faceDir,
  faceNodeExe,
  faceExtraArgs,
  faceEnv,
  faceSpecOverrides,
  desktopDir,
  workDir,
  noUserEnv = false,
  // 2026-09-13 user decision: the soul folder is ALWAYS C:\IRIS -- the product
  // name, the Face header, the desktop shortcut and the folder are one word,
  // and a beginner is never asked to invent a folder name. The env override
  // exists only so the developer PC (whose real C:\IRIS must not be touched)
  // can rehearse the installer against a throwaway root.
  soulName = process.env.IRIS_INSTALLER_SOUL_NAME || 'IRIS',
  // Automatic update mode (2026-09-14): IRIS-설치.cmd --auto, which is how
  // _agent\shared\tools\updater\apply.mjs starts this installer for a
  // structural update (P02 docs\설계-업데이트-2026-09-14.md 4-2 / 5-2). The
  // env var is what actually travels, because the updater spawns the .cmd
  // with it set; the flag exists so the .cmd can be run by hand the same way.
  auto = process.env.IRIS_INSTALLER_AUTO === '1',
} = {}) {
  const uiDir = path.join(HERE, 'ui');
  const version = readPackageVersion(zipRoot);
  const userEnvSkipped = noUserEnv || process.env.IRIS_INSTALLER_NO_USER_ENV === '1';
  const userEnvRecord = [];
  if (userEnvSkipped) {
    console.log('================================================================');
    console.log('[iris-installer] --no-user-env ACTIVE: HKCU\\Environment will NOT');
    console.log('[iris-installer] be touched (no PATH, no CLAUDE_CONFIG_DIR, no');
    console.log('[iris-installer] CODEX_HOME, no ANTHROPIC_BASE_URL). Rehearsal only --');
    console.log('[iris-installer] the resulting soul is NOT a usable install.');
    console.log('================================================================');
  }

  // Restore prior progress (refresh / re-run) but always take this run's
  // zipRoot/nodeDir -- the invocation just told us where those actually are
  // right now.
  let state = loadState(stateFile);
  if (!state) {
    state = initialState({ zipRoot, nodeDir });
  } else {
    state.zipRoot = zipRoot;
    state.nodeDir = nodeDir;
  }
  // Always this run's value: the screen shows a notice when the install did not
  // really write HKCU\Environment, and a restored state must not claim
  // otherwise in either direction.
  state.userEnvSkipped = userEnvSkipped;

  // --- automatic update mode ------------------------------------------------
  // Only ever taken over an install that already has a receipt. Anything else
  // -- the flag on a fresh PC, a soul name that does not validate -- falls
  // through to the normal six-step wizard, so the automatic flag can never
  // turn a first install into a silent one.
  function autoEligibility() {
    if (!auto) return { requested: false, eligible: false, reason: 'not_requested' };
    const validation = validateSoulName(soulName);
    if (!validation.ok) return { requested: true, eligible: false, reason: `name_${validation.reason}` };
    const prior = readReceiptFn(validation.path);
    if (!prior) return { requested: true, eligible: false, reason: 'no_receipt', root: validation.path };
    return {
      requested: true,
      eligible: true,
      name: soulName,
      root: validation.path,
      from: prior.package?.version ?? null,
      to: version,
      choice: prior.choice ?? null,
    };
  }
  state.auto = autoEligibility();
  // A previous run's leftovers must never decide this one. state.json lives in
  // %LOCALAPPDATA%\IRIS-Installer and survives forever, so an automatic update
  // could open on a `step:'done'` + `autoResult.ok` left by the *last* update
  // (the screen would replay that old success) or on an `installError` left by
  // a first install that failed months ago (the screen would show that error
  // and offer 「다시 시도」). In both cases enterAutoMode() returns before it
  // ever calls startAuto(), and the daemon has already been shut down by the
  // updater -- so the person is left with no IRIS window and no update. The
  // verdict has to be made here, on the server, before the screen reads the
  // state: this run is an update, therefore the run-specific fields start
  // empty. (`step` goes back to the initial 'precheck'; POST /api/auto sets it
  // to 'auto', which is how a *mid-run* browser refresh still reconnects to the
  // live stream -- startServer() runs once per process, not per request.)
  if (state.auto.eligible) {
    state.step = 'precheck';
    state.autoResult = null;
    state.installError = null;
    state.install = null;
  }
  saveState(stateFile, state);

  const routes = new Map();

  routes.set('GET /api/health', async (req, res) => {
    sendJson(res, 200, {
      ok: true, name: 'iris-installer', version, step: state.step, auto: state.auto?.eligible === true,
    });
  });

  routes.set('GET /api/state', async (req, res) => {
    sendJson(res, 200, state);
  });

  routes.set('POST /api/precheck', withBody(async (body, req, res) => {
    const result = await precheck();
    state.precheck = result;
    state.step = 'name';
    saveState(stateFile, state);
    sendJson(res, 200, result);
  }));

  // The body's `name` is deliberately ignored: the folder is fixed (see
  // `soulName` above). The name rules still run so a bad override on the
  // developer PC is refused instead of producing a broken root.
  routes.set('POST /api/name', withBody(async (body, req, res) => {
    const name = soulName;
    const validation = validateSoulName(name);
    if (!validation.ok) {
      sendJson(res, 200, { ok: false, reason: validation.reason, name });
      return;
    }
    const existing = detectExisting(validation.path);
    if (existing === 'conflict') {
      sendJson(res, 200, { ok: false, reason: 'conflict', name, path: validation.path });
      return;
    }
    state.soul = { name, root: validation.path, existing };
    state.step = 'choice';
    saveState(stateFile, state);
    sendJson(res, 200, { ok: true, name, path: validation.path, existing });
  }));

  // Decision rule = docs/설계.md D7/§3-3 ⓒ: choosing both subscriptions has
  // Claude Code lead the initial setup.
  routes.set('POST /api/choice', withBody(async (body, req, res) => {
    const subs = Array.isArray(body?.subscriptions)
      ? [...new Set(body.subscriptions.filter((s) => s === 'claude' || s === 'chatgpt'))]
      : [];
    if (subs.length === 0) {
      sendJson(res, 200, { ok: false, reason: 'empty' });
      return;
    }
    const leadAgent = subs.includes('claude') ? 'claude' : 'chatgpt';
    const guideEdition = leadAgent;
    state.choice = { subscriptions: subs, leadAgent, guideEdition };
    saveState(stateFile, state);
    sendJson(res, 200, { ok: true, leadAgent, guideEdition });
  }));

  // --- install (copy) step ------------------------------------------------
  // The copy runs in the background while the screen watches
  // GET /api/install/events. Events are also buffered, so a browser that
  // refreshes mid-install (or connects after POST) replays everything it
  // missed instead of showing an empty progress bar. The receipt under the
  // soul root -- not this buffer -- stays the source of truth.
  const installEvents = [];
  const sseClients = new Set();
  let installRunning = false;

  function pushEvent(event) {
    installEvents.push(event);
    if (event.part) {
      state.install = state.install ?? { parts: {} };
      // `status` is authoritative when the event carries one. The old
      // pct === 100 heuristic was wrong for every part but the last: install()
      // reports a part's completion at floor((i+1)/total*100) -- 9, 18, ... 90
      // -- so ten of eleven parts stayed 'running' forever in the state a
      // refreshed screen reads back (fix round 1 finding 2). pct is now only
      // the fallback for an event that has no status at all.
      state.install.parts[event.part] = event.error ? 'error'
        : event.skipped ? 'skipped'
          : event.status ? event.status
            : event.pct === 100 ? 'done' : 'running';
    }
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  }

  routes.set('POST /api/install', withBody(async (body, req, res) => {
    if (!state.soul?.root) {
      sendJson(res, 409, { ok: false, reason: 'no_soul' });
      return;
    }
    if (installRunning) {
      sendJson(res, 202, { ok: true, running: true });
      return;
    }
    const manifest = readPayloadManifest(state.zipRoot);
    const lock = readLock(state.zipRoot);
    if (!manifest || !lock) {
      sendJson(res, 500, { ok: false, reason: 'payload_unreadable' });
      return;
    }

    installRunning = true;
    installEvents.length = 0;
    state.step = 'install';
    state.install = { parts: {} };
    state.userEnvSkipped = userEnvSkipped;
    saveState(stateFile, state);
    sendJson(res, 202, { ok: true });

    // Deliberately not awaited: the HTTP response is already out and the
    // caller now follows /api/install/events.
    installFn({
      root: state.soul.root,
      name: state.soul.name,
      existing: state.soul.existing,
      zipRoot: state.zipRoot,
      manifest,
      lock,
      choice: state.choice ?? { subscriptions: [], leadAgent: 'claude', guideEdition: 'claude' },
      ...(userEnvSkipped ? { userpath: recordingUserpath(userEnvRecord) } : {}),
      onProgress: (e) => pushEvent({ part: null, pct: null, done: false, error: null, ...e }),
    }).then(() => {
      state.step = 'login';
      saveState(stateFile, state);
    }).catch((err) => {
      // install() already emitted the coded error event; state.install.parts
      // keeps the failing part marked 'error' for a screen refresh.
      state.step = 'install';
      state.installError = err?.code ?? String(err?.message ?? err);
      saveState(stateFile, state);
    }).finally(() => {
      installRunning = false;
      saveState(stateFile, state);
    });
  }));

  routes.set('GET /api/install/events', async (req, res) => {
    writeHeaders(res, 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    for (const e of installEvents) res.write(`data: ${JSON.stringify(e)}\n\n`);
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
  });

  // --- automatic update run (ⓐ → ⓓ → ⓕ, no clicks) -------------------------
  // The whole six-step wizard collapses into one server-side run: the parts
  // whose version or hash changed are replaced (install()'s own receipt-based
  // skip check is what decides that -- the same code the interactive
  // "기존 영혼" path uses), the login step is skipped because the accounts are
  // already registered, and the window is reopened with the plain launcher
  // instead of a first-session handoff. Progress rides the same SSE stream the
  // wizard's copy step uses, so the screen only has to render it.
  let autoRunning = false;

  async function runAuto(info, manifest, lock) {
    const root = info.root;
    const forward = (e) => pushEvent({ part: null, pct: null, error: null, ...e, done: false });
    const relaunchFace = () => {
      try {
        return relaunchFaceFn({
          root,
          ...(faceDir ? { faceDir } : {}),
          ...(faceNodeExe ? { nodeExe: faceNodeExe } : {}),
        });
      } catch (err) {
        return { ok: false, reason: String(err?.message ?? err) };
      }
    };
    // Set the moment the happy path reopens the window, so a failure *after*
    // that (finishFn throwing, say) does not open a second one.
    let relaunched = null;

    // 설계 4-5: 실패 항목이 있어도 창은 다시 연다 -- the updater shut the daemon
    // down before handing over, and install() rolls a failed part back to its
    // .prev copy, so what reopens is the version that was working a minute ago.
    // Without this the person is left staring at a browser tab with no IRIS
    // window at all, which is a worse outcome than the failed update itself.
    const failAuto = (where, reason, detail = null) => {
      if (relaunched === null) relaunched = relaunchFace();
      state.step = 'auto';
      state.installError = reason;
      state.autoResult = { ok: false, where, reason, detail, relaunched: relaunched?.ok ?? false };
      saveState(stateFile, state);
      pushEvent({ part: 'relaunch', pct: null, skipped: false, status: relaunched?.ok ? 'done' : 'error', error: null, done: false });
      pushEvent({ part: where, pct: null, skipped: false, status: 'error', error: reason, detail, done: true });
    };

    try {
      // ⓐ 준비 확인 -- read-only, and a machine that cannot even go offline-far
      // must not start swapping folders.
      forward({ part: 'precheck', pct: 0, status: 'running' });
      const pre = await precheck();
      state.precheck = pre;
      saveState(stateFile, state);
      if (!pre.allOk && !pre.canProceedOffline) { failAuto('precheck', 'precheck_failed'); return; }
      forward({ part: 'precheck', pct: 5, status: 'done' });

      // ⓑ 자리 + ⓒ 구독 -- both already answered, by the receipt.
      state.soul = { name: info.name, root, existing: 'soul' };
      state.choice = info.choice ?? { subscriptions: ['claude'], leadAgent: 'claude', guideEdition: 'claude' };
      saveState(stateFile, state);

      // ⓓ 바뀐 부품만 교체 (.prev 보존, 사용자 자료 무접촉)
      await installFn({
        root,
        name: info.name,
        existing: 'soul',
        zipRoot: state.zipRoot,
        manifest,
        lock,
        choice: state.choice,
        ...(userEnvSkipped ? { userpath: recordingUserpath(userEnvRecord) } : {}),
        // install()'s own terminal event says "the copy step finished", which
        // in this run is only the middle of the job -- so `done` is stripped
        // and the one true terminal frame is emitted at the end of runAuto().
        onProgress: forward,
      });

      // ⓔ 로그인 -- 이미 등록된 계정이라 건너뛴다.
      forward({ part: 'login', pct: 96, status: 'skipped', skipped: true });

      // ⓕ IRIS 창 다시 열기. install() already refreshed the receipt.
      const relaunch = relaunchFace();
      relaunched = relaunch;
      forward({ part: 'relaunch', pct: 99, status: relaunch?.ok ? 'done' : 'error' });

      finishFn({
        root,
        receipt: readReceiptFn(root),
        ...(workDir ? { workDir } : {}),
        setStep: (s) => { state.step = s; saveState(stateFile, state); },
        quit: () => {
          setTimeout(() => { if (onQuit) onQuit(); else process.exit(0); }, 1500);
        },
      });

      state.autoResult = {
        ok: true, from: info.from, to: info.to, relaunched: relaunch?.ok ?? false, pid: relaunch?.pid ?? null,
      };
      state.step = 'done';
      saveState(stateFile, state);
      pushEvent({ part: null, pct: 100, skipped: false, status: 'done', error: null, done: true });
    } catch (err) {
      failAuto('install', err?.code ?? 'install_failed', String(err?.message ?? err));
    } finally {
      autoRunning = false;
      installRunning = false;
      saveState(stateFile, state);
    }
  }

  routes.set('POST /api/auto', withBody(async (body, req, res) => {
    const info = state.auto?.eligible ? state.auto : autoEligibility();
    if (!info.eligible) {
      sendJson(res, 409, { ok: false, reason: info.reason ?? 'not_eligible' });
      return;
    }
    if (autoRunning) {
      sendJson(res, 202, { ok: true, running: true });
      return;
    }
    const manifest = readPayloadManifest(state.zipRoot);
    const lock = readLock(state.zipRoot);
    if (!manifest || !lock) {
      sendJson(res, 500, { ok: false, reason: 'payload_unreadable' });
      return;
    }

    autoRunning = true;
    installRunning = true;
    installEvents.length = 0;
    state.step = 'auto';
    state.install = { parts: {} };
    state.installError = null;
    state.autoResult = null;
    state.userEnvSkipped = userEnvSkipped;
    saveState(stateFile, state);
    sendJson(res, 202, { ok: true, from: info.from, to: info.to });

    // Deliberately not awaited, exactly like POST /api/install: the response
    // is already out and the screen now follows /api/install/events.
    runAuto(info, manifest, lock);
  }));

  // --- login step ----------------------------------------------------------
  // Two-stage flow (task-13-brief.md): ① startCliLogin opens the CLI's own
  // OAuth in a proxy-free console; ② once that credential file exists,
  // relayImport hands it to TeamClaude and relayStatus polls the config
  // file's per-provider account count. GET /api/login/status is what the
  // screen polls every 2s -- it also advances stage ①→② and, once every
  // chosen subscription is fully done, flips the receipt/state to handoff.
  const relayImportInFlight = new Set();

  // I2: pass the soul root so the receipt (written by install()) is the first
  // place the path comes from -- this process cannot see the user env var
  // install() just wrote, and must not fall back to %USERPROFILE%\.config on
  // a machine that is already an IRIS soul.
  function getTeamclaudeConfigPath() {
    return teamclaudeConfigPath ?? resolveTeamclaudeConfigPath({ root: state.soul?.root });
  }

  routes.set('POST /api/login', withBody(async (body, req, res) => {
    const provider = body?.provider;
    if (provider !== 'claude' && provider !== 'chatgpt') {
      sendJson(res, 200, { ok: false, reason: 'bad_provider' });
      return;
    }
    if (!state.soul?.root) {
      sendJson(res, 409, { ok: false, reason: 'no_soul' });
      return;
    }
    const root = state.soul.root;
    const configPath = getTeamclaudeConfigPath();
    const [proxyResult, accountsBefore] = await Promise.all([
      ensureProxyFn({ root, nodeDir: state.nodeDir, teamclaudeConfigPath: configPath }),
      countProviderAccountsFn({ teamclaudeConfigPath: configPath, provider }).catch(() => 0),
    ]);
    const { pid } = startCliLoginFn({
      root, nodeDir: state.nodeDir, provider, teamclaudeConfigPath: configPath,
    });

    state.login = state.login ?? {};
    state.login[provider] = {
      startedAt: new Date().toISOString(),
      accountsBefore,
      cli: 'pending',
      relay: 'pending',
      relayMethod: null,
      relayError: null,
      pid,
    };

    // Record which TeamClaude config path is in play (brief: receipt
    // env.teamclaudeConfig). Only meaningful once the receipt exists
    // (created by install's copy step, which always runs before login).
    const receipt = readReceipt(root);
    if (receipt) {
      receipt.env = receipt.env ?? {};
      receipt.env.teamclaudeConfig = configPath;
      writeReceipt(root, receipt);
    }

    saveState(stateFile, state);
    sendJson(res, 200, { ok: true, alive: proxyResult.alive, started: proxyResult.started, pid });
  }));

  routes.set('GET /api/login/status', async (req, res) => {
    const root = state.soul?.root;
    const subs = state.choice?.subscriptions ?? [];
    if (!root || !state.login || subs.length === 0) {
      sendJson(res, 200, { ok: true, step: state.step, providers: {} });
      return;
    }
    const configPath = getTeamclaudeConfigPath();

    for (const provider of subs) {
      const entry = state.login[provider];
      if (!entry) continue;

      if (entry.cli !== 'done') {
        entry.cli = cliLoginStatusFn({ provider, root });
      }

      // Stage ①→② handoff: kick off relayImport exactly once per provider,
      // and never run two at the same time for the same provider (this
      // route is polled every 2s and relayImport can be slow -- a real
      // spawn/CLI call).
      if (entry.cli === 'done' && entry.relayMethod == null && !relayImportInFlight.has(provider)) {
        relayImportInFlight.add(provider);
        relayImportFn({ provider, root, nodeDir: state.nodeDir, teamclaudeConfigPath: configPath })
          .then((r) => {
            if (r.ok) {
              entry.relayMethod = r.method;
              entry.relayError = null;
            } else {
              // Fix round 1 finding 1: login.mjs now reports (instead of
              // hiding behind a silent config replacement) when TeamClaude's
              // config file could not be safely read. Surface it here so a
              // screen (Task 14) can show the person something other than an
              // endless spinner; relayMethod stays null so the next poll
              // retries (the read failure may be transient -- e.g. the live
              // server mid-write).
              entry.relayError = { reason: r.reason, detail: r.detail };
            }
            saveState(stateFile, state);
          })
          .catch((err) => {
            entry.relayError = { reason: 'relay_import_failed', detail: String(err?.message ?? err) };
            saveState(stateFile, state);
          })
          .finally(() => { relayImportInFlight.delete(provider); });
      }

      if (entry.relayMethod != null && entry.relay !== 'done') {
        entry.relay = await relayStatusFn({
          teamclaudeConfigPath: configPath, provider, accountsBefore: entry.accountsBefore,
        });
      }
    }
    saveState(stateFile, state);

    const allDone = subs.every((p) => state.login[p]?.cli === 'done' && state.login[p]?.relay === 'done');
    if (allDone && state.step !== 'handoff') {
      const receipt = readReceipt(root);
      if (receipt) {
        for (const provider of subs) {
          setReceiptLogin(receipt, provider, { cli: true, relay: true, relayMethod: state.login[provider].relayMethod });
        }
        markReceiptStep(receipt, 'login', 'done');
        writeReceipt(root, receipt);
      }
      state.step = 'handoff';
      saveState(stateFile, state);
    }

    const now = Date.now();
    // 2 minutes (was 60 -- 2026-09-13 review): a beginner who closed the black
    // window by mistake, or whose browser never opened, must not sit for an
    // hour before the screen offers "다시 열기". A real browser login takes
    // well under two minutes; a second window is harmless if the first is
    // still open (same credential file, first one to finish wins).
    const REOPEN_AFTER_MS = 2 * 60 * 1000;
    const providers = {};
    for (const provider of subs) {
      const entry = state.login[provider];
      if (!entry) continue;
      const elapsedMs = now - Date.parse(entry.startedAt);
      providers[provider] = {
        cli: entry.cli,
        relay: entry.relay,
        relayMethod: entry.relayMethod,
        relayError: entry.relayError ?? null,
        reopenAvailable: entry.cli !== 'done' && elapsedMs > REOPEN_AFTER_MS,
      };
    }
    sendJson(res, 200, { ok: true, step: state.step, providers });
  });

  // --- handoff step (ⓕ) -----------------------------------------------------
  // 설계 4-2/4-3: write the first request + the Face session spec, drop the
  // `<이름> Face.cmd` launcher (+ desktop shortcut), start Face, and only
  // call it done once the daemon answers /api/health with one live session.
  // Each stage reports its own `where` so the screen can say which one broke.
  let handoffRunning = false;

  function handoffLog(root, line) {
    const file = path.join(root, '_agent', 'setup', 'package-install.log');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${new Date().toISOString()} handoff ${line}\n`, 'utf8');
    } catch { /* logging must never break the handoff */ }
    return file;
  }

  routes.set('POST /api/handoff', withBody(async (body, req, res) => {
    const root = state.soul?.root;
    if (!root) {
      sendJson(res, 409, { ok: false, reason: 'no_soul' });
      return;
    }
    if (handoffRunning) {
      sendJson(res, 202, { ok: true, running: true });
      return;
    }
    handoffRunning = true;
    const logFile = path.join(root, '_agent', 'setup', 'package-install.log');
    const fail = (where, err, extra = {}) => {
      const detail = String(err?.message ?? err);
      const reason = err?.code ?? null;
      handoffLog(root, `${where} failed${reason ? ` (${reason})` : ''}: ${detail}`);
      sendJson(res, 200, { ok: false, where, reason, detail, log: logFile, ...extra });
    };

    try {
      const manifest = readPayloadManifest(state.zipRoot);
      const edition = state.choice?.guideEdition ?? 'claude';
      const leadAgent = state.choice?.leadAgent ?? 'claude';

      // ① 첫 요청문 + ② 첫 세션 spec
      let first;
      let spec;
      try {
        first = writeFirstRequestFn(root, { edition, manifest });
        spec = writeFirstSessionSpecFn(root, {
          leadAgent, promptFile: first.path, ...(faceSpecOverrides ?? {}),
        });
        handoffLog(root, `first-request guide=${first.guide?.basename} agent=${spec.spec.agent} model=${spec.spec.model}`);
      } catch (err) { fail('first-request', err); return; }

      // ③ 소환기 + 바탕화면 바로가기 (바로가기 실패는 치명적이지 않다)
      let launcher;
      try {
        launcher = await writeFaceLauncherFn(root, state.soul.name, { desktopDir });
        handoffLog(root, `launcher ${launcher.cmdPath} shortcut=${launcher.shortcut?.ok === true}`);
      } catch (err) { fail('launcher', err); return; }

      // ④ Face 실행
      let launched;
      try {
        launched = launchFaceFn({
          root,
          nodeDir: state.nodeDir,
          nodeExe: faceNodeExe,
          faceDir,
          spec: spec.path,
          ...(facePort ? { port: facePort } : {}),
          ...(faceExtraArgs ? { extraArgs: faceExtraArgs } : {}),
          ...(faceEnv ? { env: faceEnv } : {}),
        });
        handoffLog(root, `launch pid=${launched.pid}`);
      } catch (err) { fail('launch', err); return; }

      // ⑤ 준비 확인: /api/health 200 + *이 영혼 폴더*의 세션 1개 이상.
      // root를 넘기는 것이 핵심 — 이미 Face를 쓰던 PC에서는 남의 세션이 전역
      // 개수를 채워 버린다(fix round 1 finding 1).
      const ready = await waitFaceReadyFn({ root, port: facePort ?? 3458 });
      if (!ready.ok) {
        handoffLog(root, `ready failed after ${ready.tries} tries sessions=${ready.sessions ?? '?'} wanted=${ready.wantedCwd ?? root}`);
        sendJson(res, 200, {
          ok: false, where: 'ready', reason: 'no_session_in_soul', pid: launched.pid, tries: ready.tries,
          detail: ready.error ?? (ready.sessions
            ? `face daemon is up with ${ready.sessions} session(s), none of them in ${root}`
            : 'face daemon did not report a session in this soul folder'),
          sessions: ready.sessions ?? null,
          log: logFile, faceLog: launched.logFile ?? null,
        });
        return;
      }

      // ⑥ 마무리: 영수증 · state · 캐시 · 자기 서버 종료
      let finished;
      try {
        const receipt = readReceipt(root);
        finished = finishFn({
          root,
          receipt,
          ...(workDir ? { workDir } : {}),
          setStep: (s) => { state.step = s; saveState(stateFile, state); },
          quit: () => {
            setTimeout(() => { if (onQuit) onQuit(); else process.exit(0); }, 1500);
          },
        });
      } catch (err) { fail('finish', err); return; }

      handoffLog(root, `done session=${ready.session?.id ?? '?'} cwd=${ready.session?.cwd ?? '?'} sessions=${ready.health?.sessions} faceVersion=${ready.health?.version ?? 'unknown'}`);
      sendJson(res, 200, {
        ok: true,
        pid: launched.pid,
        sessionId: ready.session?.id ?? null,
        sessionCwd: ready.session?.cwd ?? null,
        sessions: ready.health?.sessions ?? null,
        faceVersion: ready.health?.version ?? null,
        launcher: launcher.cmdPath,
        shortcut: launcher.lnkPath,
        firstRequest: first.path,
        cacheRemoved: finished?.cacheRemoved ?? false,
        log: logFile,
      });
    } finally {
      handoffRunning = false;
    }
  }));

  routes.set('POST /api/quit', async (req, res) => {
    sendJson(res, 200, { ok: true });
    setTimeout(() => {
      if (onQuit) onQuit();
      else process.exit(0);
    }, 200);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      // Guard every /api/* request (routed or not) before anything reads a
      // body or touches state -- an unknown /api path must not be a hole.
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const guard = checkApiRequest(req, server.address()?.port ?? port);
        if (!guard.ok) {
          sendJson(res, guard.status, { ok: false, reason: guard.reason });
          return;
        }
      }
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (handler) {
        await handler(req, res, url);
        return;
      }
      if (req.method === 'GET') {
        serveStatic(uiDir, url.pathname, res);
        return;
      }
      sendJson(res, 404, { ok: false, reason: 'not_found' });
    } catch (err) {
      try {
        sendJson(res, 500, { ok: false, reason: 'internal_error', message: String(err?.message ?? err) });
      } catch {
        // response already sent/closed; nothing more to do
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((res) => {
          // An open SSE response keeps the socket alive forever, so
          // server.close() would never call back. End them first.
          for (const client of sseClients) { try { client.end(); } catch { /* already gone */ } }
          sseClients.clear();
          server.close(() => res());
        }),
      });
    });
  });
}

function parseArgs(argv) {
  const args = { port: 3460 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip-root') args.zipRoot = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--node-dir') args.nodeDir = argv[++i];
    // Rehearsal switch (also IRIS_INSTALLER_NO_USER_ENV=1): run the real
    // install but record the HKCU\Environment writes instead of making them.
    else if (a === '--no-user-env') args.noUserEnv = true;
    // Automatic update mode (also IRIS_INSTALLER_AUTO=1) -- bootstrap.ps1
    // passes this through from IRIS-설치.cmd --auto.
    else if (a === '--auto') args.auto = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const work = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'IRIS-Installer')
    : path.join(os.tmpdir(), 'IRIS-Installer');
  const stateFile = path.join(work, 'state.json');
  startServer({ ...args, stateFile })
    .then(({ port }) => {
      console.log(`iris-installer server listening on 127.0.0.1:${port}`);
    })
    .catch((err) => {
      console.error(`iris-installer server failed to start: ${err?.stack ?? err}`);
      process.exit(1);
    });
}
