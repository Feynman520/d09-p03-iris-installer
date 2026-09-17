#!/usr/bin/env node
// IRIS installer local server (v2). Launched by installer/bootstrap.ps1 as:
//   node server.mjs --zip-root "<zipRoot>" --port 3460 --node-dir "<nodeDir>"
//                   [--resume] [--auto] [--no-user-env]
// node:http only, no dependencies, ESM. 127.0.0.1 only.
//
// State machine (docs/설치기-API-v2.md -- the contract this file and
// installer/ui/index.html both implement, neither one alone):
//   precheck -> locate -> choice -> structure -> summary -> setup -> online -> done
// plus two flag-only steps: `auto` (the updater's part swap) and
// `reinstall-required` (an --auto run over a 1.x receipt).
//
// Division of labour: this server asks the questions, keeps the answers and
// mirrors progress. It does NOT install anything itself -- the offline work is
// `installer/setup/engine.mjs` (T13~T18) and the online work is
// `installer/lib/online.mjs` (T19), both reached through the thin adapters in
// lib/adapters/ so a missing module answers `E-NOT-IMPLEMENTED` instead of
// stopping the server from booting.
//
// Korean here is only what the screen shows verbatim (`message` fields);
// everything else -- logs, codes, comments -- stays ASCII. The product name of
// the relay is never written in a user-facing message (설계-v2 7절).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  initialState, loadState, saveState, normalizeState, isSamePackage,
  initialSetup, markSetupStage, setupPercent,
} from './lib/state.mjs';
import { precheck as defaultPrecheck } from './lib/precheck.mjs';
import { validateSoulName } from './lib/soulname.mjs';
import {
  validateNodes, buildDecisions, writeDecisions, readDecisions, decisionsPath,
} from './lib/structure-rules.mjs';
import {
  readReceipt, writeReceipt, newReceiptV2, ensureV2Fields, setPrecheck,
  isLegacyReceipt, setupAllDone, onlineDone, markStep as markReceiptStep,
  backupLegacyReceipt, SETUP_STAGE_IDS,
} from './lib/receipt.mjs';
import { createSetupRunner } from './lib/adapters/setup-runner.mjs';
import { createOnlineRunner } from './lib/adapters/online-runner.mjs';
// Update mode only (POST /api/auto). The v1 `install()` is deliberately NOT
// imported any more: an update runs the SAME v2 engine the wizard runs, with
// the stages an update can change reset to `pending` first (lib/update-plan).
import { planUpdateReset, applyUpdateReset } from './lib/update-plan.mjs';
import { relaunchFace as defaultRelaunchFace, finish as defaultFinish } from './lib/handoff.mjs';
import { run as defaultRun } from '../lib/run.mjs';

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
// a client-side ECONNRESET instead of the coded 413.
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
// local-origin guard
// ---------------------------------------------------------------------------
// The installer server binds 127.0.0.1 only, but "local" is not "safe": any
// page the person happens to have open in the same browser can POST to
// http://127.0.0.1:3460/api/... (drive-by CSRF). Two cheap checks close it:
//   1. Origin: a present Origin that is not this very server is rejected. An
//      absent Origin is allowed on purpose -- same-origin GETs, EventSource,
//      bootstrap.ps1's health probe and verify/static.mjs's smoke check all
//      send none.
//   2. Content-Type: application/json cannot be produced by a plain <form>
//      post, so requiring it on every /api POST forces any cross-site attempt
//      into a preflight, which check 1 then refuses.
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

// ---------------------------------------------------------------------------
// static files -- an allow-list of exactly three, nothing else
// ---------------------------------------------------------------------------
// v2 replaces the old "serve anything under ui/" handler with a fixed table.
// The wizard is one page plus one module plus one data file, so a table is
// both simpler and strictly safer: no path can be built that reaches
// bootstrap.ps1 or the payload, whatever a URL encodes.
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/structure.mjs', { file: 'structure.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/presets.json', { file: 'presets.json', type: 'application/json; charset=utf-8' }],
]);

function serveStatic(uiDir, pathname, res) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) {
    sendJson(res, 404, { ok: false, reason: 'not_found' });
    return;
  }
  fs.readFile(path.join(uiDir, entry.file), (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, reason: 'not_found' });
      return;
    }
    writeHeaders(res, 200, { 'Content-Type': entry.type, 'Content-Length': data.length });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// zip-side readers
// ---------------------------------------------------------------------------
function readPayloadManifest(zipRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(zipRoot, 'payload', 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readPackageVersion(zipRoot) {
  return readPayloadManifest(zipRoot)?.package?.version ?? 'unknown';
}

// lock.json is a build-time artifact that also travels in the zip next to
// installer/. Fall back to the repo copy when running from a git checkout.
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

// ---------------------------------------------------------------------------
// soul detection
// ---------------------------------------------------------------------------
// docs/설치기-API-v2.md `soul.mode`:
//   empty        없거나 빈 폴더                  -> 그냥 설치
//   iris         v2 영수증이 있는 IRIS           -> 이어하기/고치기
//   iris-legacy  1.x 영수증 또는 soul-state.json -> 자료 보존 이어 설치 (S09)
//   foreign      IRIS 표시가 없는데 비어 있지 않음 -> 막음
// Read-only: this never creates the folder, so probing the developer PC's real
// C:\IRIS changes nothing.
//
// Top-level names only IRIS (or this installer) ever creates. They matter for
// the "foreign" verdict: as soon as the location is confirmed the installer
// starts logging to <root>\_agent\setup\installer.log, so a run that stops
// right after that leaves a folder whose ONLY content is our own bookkeeping --
// and the next run must not then refuse its own log as someone else's files.
// Judging "foreign" on names that are not ours, rather than on "not empty",
// is what makes a second run of an interrupted install possible.
const IRIS_OWNED_ENTRIES = new Set([
  '_agent', '_ontology', '_trash', '_cleanup', '_document-templates', '_backup',
  'soul-state.json', 'AGENTS.md', 'CLAUDE.md', '_cosmos.ico', 'desktop.ini',
]);

export function detectSoulMode(root, { fsFn = fs, readReceiptFn = readReceipt } = {}) {
  let entries;
  try {
    entries = fsFn.readdirSync(root);
  } catch {
    return 'empty'; // does not exist (or is not a readable directory)
  }
  if (entries.length === 0) return 'empty';
  const receipt = readReceiptFn(root);
  if (receipt) return isLegacyReceipt(receipt) ? 'iris-legacy' : 'iris';
  if (entries.includes('soul-state.json')) return 'iris-legacy';
  if (entries.every((e) => IRIS_OWNED_ENTRIES.has(e))) return 'empty';
  return 'foreign';
}

const SOUL_MESSAGE = {
  empty: '설치할 자리가 비어 있습니다. 이대로 진행합니다.',
  iris: '이미 IRIS가 설치된 폴더입니다. 기존 자료는 그대로 두고 이어서 진행합니다.',
  'iris-legacy': '예전 판 IRIS 폴더입니다. 안에 있는 자료는 건드리지 않고 새 부품과 지침만 놓습니다.',
  foreign: '이 폴더에 IRIS가 아닌 자료가 있습니다. 그 자료를 다른 곳으로 옮긴 뒤 「다시 확인」을 눌러 주세요.',
};

// ---------------------------------------------------------------------------
// re-run verdict (docs/설치기-API-v2.md "재실행·모드")
// ---------------------------------------------------------------------------
// 영수증이 있으면: setup 전부 done + online 미완 -> online / 전부 done -> done
// / 중간까지 갔으면 -> setup. 영수증이 없고 decisions.json 만 있으면 -> summary.
// `--resume` (Face 「설치 이어하기」) forces this verdict over any saved state.
export function resumeVerdict(root, { readReceiptFn = readReceipt, fsFn = fs } = {}) {
  if (!root) return null;
  const receipt = readReceiptFn(root);
  if (receipt && !isLegacyReceipt(receipt)) {
    if (setupAllDone(receipt)) {
      return onlineDone(receipt)
        ? { step: 'done', reason: 'all-done' }
        : { step: 'online', reason: 'setup-done' };
    }
    const started = SETUP_STAGE_IDS.some((id) => {
      const s = receipt.setup?.[id]?.status;
      return s && s !== 'pending';
    });
    if (started) return { step: 'setup', reason: 'setup-partial' };
  }
  if (readDecisions(root, { fs: fsFn })) return { step: 'summary', reason: 'decisions-only' };
  return null;
}

// 2026-09-17 실제 사용자 실측: 2.0.0 이 venv 에서 멈춘 PC 에 2.0.1 을 돌리자 재실행 판정이
// 'setup' 으로 곧장 갔는데, 새 판의 상태는 비어 있어(error 없음·running 아님) 화면이
// 「진행중」 배지만 단 채 아무 단추도 없이 서 버렸다. 영수증이 기억하는 **실패한 단계**를
// 새 상태의 error 로 옮겨 적으면 화면이 "…에서 멈췄습니다 / 다시 시도"를 보여 준다.
export function resumeSetupError(receipt) {
  if (!receipt || isLegacyReceipt(receipt)) return null;
  for (const id of SETUP_STAGE_IDS) {
    const s = receipt.setup?.[id];
    if (s && s.status === 'failed') {
      return {
        stage: id,
        error: { id, code: s.code ?? 'E-RESUME', message: s.message ?? s.detail ?? '이전 실행이 이 단계에서 멈췄습니다. 「다시 시도」를 누르면 여기서부터 이어서 합니다.' },
      };
    }
  }
  return null;
}

// --no-user-env / IRIS_INSTALLER_NO_USER_ENV=1: a userpath implementation that
// records what the install *would* have written to HKCU\Environment and writes
// nothing. Exists for rehearsals on a machine that is already a working IRIS
// soul -- a live install there would repoint CLAUDE_CONFIG_DIR / CODEX_HOME /
// ANTHROPIC_BASE_URL and the user Path at the rehearsal folder.
export function recordingUserpath(record = []) {
  return {
    record,
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
        // Write the JSON response (with Connection: close so the socket is not
        // reused for a request we never fully read) and only destroy the
        // request stream once that response has actually been flushed.
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

export function startServer({
  port = 3460,
  zipRoot,
  nodeDir,
  stateFile,
  onQuit,
  // v2 seams (all injectable so tests never write under C:\ or spawn anything)
  precheckFn = defaultPrecheck,
  setupRunner = createSetupRunner(),
  onlineRunner = createOnlineRunner(),
  readReceiptFn = readReceipt,
  writeReceiptFn = writeReceipt,
  runFn = defaultRun,
  openFaceFn,
  // update-mode (POST /api/auto) seams. The install itself is `setupRunner`
  // (the same v2 engine as the wizard) -- there is no v1 install seam any more.
  relaunchFaceFn = defaultRelaunchFace,
  finishFn = defaultFinish,
  faceDir,
  faceNodeExe,
  workDir,
  noUserEnv = false,
  // 2026-09-13 user decision: the soul folder is ALWAYS C:\IRIS -- the product
  // name, the Face header, the desktop shortcut and the folder are one word,
  // and a beginner is never asked to invent a folder name. The env override
  // exists only so the developer PC (whose real C:\IRIS must not be touched)
  // can rehearse the installer against a throwaway root.
  soulName = process.env.IRIS_INSTALLER_SOUL_NAME || 'IRIS',
  // Test-only seam: an absolute root that replaces C:\<soulName> entirely, so
  // a unit test can drive the whole machine (decisions.json, the receipt, the
  // logs) against a throwaway folder without ever creating anything under C:\.
  // Never set by bootstrap.ps1 or the .cmd -- the product folder is fixed.
  soulRoot: soulRootOverride = null,
  // Automatic update mode: IRIS-설치.cmd --auto, which is how the updater
  // starts this installer for a structural update.
  auto = process.env.IRIS_INSTALLER_AUTO === '1',
  // Face 「설치 이어하기」: IRIS-설치.cmd --resume. Forces the receipt verdict.
  resume = process.env.IRIS_INSTALLER_RESUME === '1',
} = {}) {
  const uiDir = path.join(HERE, 'ui');
  const version = readPackageVersion(zipRoot);
  const userEnvSkipped = noUserEnv || process.env.IRIS_INSTALLER_NO_USER_ENV === '1';
  const userEnvRecord = [];
  const logDir = workDir ?? (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'IRIS-Installer')
    : path.join(os.tmpdir(), 'IRIS-Installer'));
  const serverLog = path.join(logDir, 'server.log');

  if (userEnvSkipped) {
    console.log('================================================================');
    console.log('[iris-installer] --no-user-env ACTIVE: HKCU\\Environment will NOT');
    console.log('[iris-installer] be touched (no PATH, no CLAUDE_CONFIG_DIR, no');
    console.log('[iris-installer] CODEX_HOME, no ANTHROPIC_BASE_URL). Rehearsal only --');
    console.log('[iris-installer] the resulting soul is NOT a usable install.');
    console.log('================================================================');
  }

  // --- logging ------------------------------------------------------------
  // Always %LOCALAPPDATA%\IRIS-Installer\server.log; once the soul root is
  // CONFIRMED, a copy also goes to <root>\_agent\setup\installer.log so the log
  // travels with the install (설계-v2 4-2).
  //
  // "Confirmed" is load-bearing, not pedantry: writing the log the moment the
  // root is merely *known* creates <root>\_agent\setup\installer.log before the
  // person has been asked anything -- and then the very next question, "is this
  // folder free?", answers "no, someone else's files are in it", because the
  // only thing in it is our own log. Nothing goes under the soul root until
  // POST /api/locate has said the folder is ours to use (or a receipt already
  // proved it is).
  // Set ONLY by: a successful POST /api/locate (mode !== 'foreign'), a receipt
  // that already proves the folder is ours (the re-run verdict), or the start
  // of an update run. Cleared again by a locate that says 'foreign'.
  let soulConfirmed = false;

  // Every route that WRITES under the soul root goes through this first. Two
  // things it stops, both of which put files in a folder nobody agreed to:
  //   - jumping straight to /api/structure or /api/setup/start (a stale page,
  //     a bookmark, a script) before the location was ever confirmed;
  //   - doing so after /api/locate refused the folder as someone else's.
  // Reading routes (/api/state, /api/setup/progress) are deliberately not
  // guarded -- a screen must always be able to ask where it is.
  function requireLocated(res) {
    if (!state.soul?.root) {
      sendJson(res, 409, { ok: false, reason: 'no_soul', message: '설치 위치 확인을 먼저 해 주세요.' });
      return false;
    }
    if (!soulConfirmed) {
      sendJson(res, 409, { ok: false, reason: 'no_locate', message: '설치 위치 확인을 먼저 해 주세요.' });
      return false;
    }
    return true;
  }

  function soulLogPath() {
    const root = state?.soul?.root;
    return soulConfirmed && root ? path.join(root, '_agent', 'setup', 'installer.log') : null;
  }

  function log(line) {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    for (const file of [serverLog, soulLogPath()]) {
      if (!file) continue;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, stamped, 'utf8');
      } catch { /* logging must never break a step */ }
    }
  }

  // --- state --------------------------------------------------------------
  const restored = loadState(stateFile);
  const samePackage = isSamePackage(restored, version);
  if (restored && !samePackage) {
    console.log(`[iris-installer] saved progress is from package ${restored.packageVersion ?? '?'}; this zip is ${version} -- starting over`);
  }
  let state = samePackage
    ? normalizeState(restored, { zipRoot, nodeDir, packageVersion: version })
    : initialState({ zipRoot, nodeDir, packageVersion: version });
  // Always this run's value: the screen shows a notice when the install did not
  // really write HKCU\Environment, and a restored state must not claim
  // otherwise in either direction.
  state.userEnvSkipped = userEnvSkipped;

  const save = () => saveState(stateFile, state);

  // --- soul root ----------------------------------------------------------
  const soulValidation = soulRootOverride
    ? { ok: true, path: soulRootOverride }
    : validateSoulName(soulName);
  const soulRoot = soulValidation.ok ? soulValidation.path : null;

  function refreshSoul() {
    if (!soulRoot) {
      state.soul = { name: soulName, root: null, mode: null, reason: soulValidation.reason };
      return state.soul;
    }
    state.soul = {
      name: soulName,
      root: soulRoot,
      mode: detectSoulMode(soulRoot, { readReceiptFn }),
    };
    return state.soul;
  }
  refreshSoul();

  // --- automatic update mode ----------------------------------------------
  // Only ever taken over an install that already has a v2 receipt. A 1.x
  // receipt is refused outright (D2-24): 2.0 lays out a different soul, so an
  // in-place part swap would leave a half-2.0 install nobody can reason about.
  function autoEligibility() {
    if (!auto) return { requested: false, eligible: false, reason: 'not_requested' };
    if (!soulValidation.ok) return { requested: true, eligible: false, reason: `name_${soulValidation.reason}` };
    const prior = readReceiptFn(soulRoot);
    if (!prior) return { requested: true, eligible: false, reason: 'no_receipt', root: soulRoot };
    if (isLegacyReceipt(prior)) {
      return {
        requested: true,
        eligible: false,
        reason: 'legacy_receipt',
        root: soulRoot,
        schema: prior.schema ?? 1,
        from: prior.package?.version ?? null,
        to: version,
      };
    }
    return {
      requested: true,
      eligible: true,
      name: soulName,
      root: soulRoot,
      from: prior.package?.version ?? null,
      to: version,
      choice: prior.choice ?? null,
    };
  }
  state.auto = autoEligibility();

  // A previous run's leftovers must never decide this one. state.json lives in
  // %LOCALAPPDATA%\IRIS-Installer and survives forever, so an automatic update
  // could open on a `step:'done'` left by the *last* update. The verdict is
  // made here, on the server, before the screen reads the state.
  if (state.auto.eligible) {
    // NOT soulConfirmed yet: merely *being* an update candidate must not put a
    // file in the soul folder. POST /api/auto confirms it when the run starts.
    state.step = 'precheck';
    state.autoResult = null;
    state.installError = null;
    state.install = null;
  } else if (state.auto.reason === 'legacy_receipt') {
    // --auto over a 1.x install: change nothing at all, just say so.
    state.step = 'reinstall-required';
    state.autoResult = null;
    log(`auto refused: receipt schema ${state.auto.schema} < 2 at ${soulRoot}`);
  } else {
    // --- re-run verdict --------------------------------------------------
    // Applied on a fresh start always, and over a restored state only when
    // --resume says so (that is what Face's 「설치 이어하기」 passes).
    const verdict = resumeVerdict(soulRoot, { readReceiptFn });
    if (verdict && (resume || !samePackage || state.step === 'precheck')) {
      // A receipt or a decisions.json under this root is proof the folder is
      // already ours, so the soul-side log may start immediately.
      soulConfirmed = true;
      state.step = verdict.step;
      state.resume = { ...verdict, forced: resume };
      if (verdict.step === 'summary' || verdict.step === 'setup') {
        state.decisions = state.decisions ?? readDecisions(soulRoot);
      }
      const prior = readReceiptFn(soulRoot);
      if (prior && !isLegacyReceipt(prior)) {
        state.choice = state.choice ?? prior.choice ?? null;
        state.decisions = state.decisions ?? readDecisions(soulRoot);
        if (verdict.step === 'setup' && !state.setup?.error) {
          const seeded = resumeSetupError(prior);
          if (seeded) {
            state.setup.stage = seeded.stage;
            state.setup.error = seeded.error;
            log(`resume: prior run (package ${prior.package?.version ?? '?'}) stopped at ${seeded.stage} (${seeded.error.code}) -- shown as retryable`);
          }
        }
      }
      log(`resume verdict: step=${verdict.step} (${verdict.reason}) forced=${resume}`);
    } else if (resume) {
      state.resume = { step: null, reason: 'nothing-to-resume', forced: true };
    }
  }
  save();
  log(`start version=${version} step=${state.step} soul=${state.soul?.mode ?? 'unknown'} auto=${state.auto.eligible} resume=${resume}`);

  // =========================================================================
  // routes
  // =========================================================================
  const routes = new Map();

  routes.set('GET /api/health', async (req, res) => {
    sendJson(res, 200, {
      ok: true,
      name: 'iris-installer',
      version,
      step: state.step,
      auto: state.auto?.eligible === true,
    });
  });

  routes.set('GET /api/state', async (req, res) => {
    sendJson(res, 200, { ok: true, name: 'iris-installer', version, ...state });
  });

  // --- ① 준비 확인 ---------------------------------------------------------
  routes.set('POST /api/precheck', withBody(async (body, req, res) => {
    const result = await precheckFn();
    state.precheck = result;
    const canProceed = (result?.blockers ?? []).length === 0;
    if (canProceed && state.step === 'precheck') state.step = 'locate';
    save();
    log(`precheck blockers=${(result?.blockers ?? []).length} warnings=${(result?.warnings ?? []).length}`);
    sendJson(res, 200, { ok: true, result, canProceed });
  }));

  // --- ② 설치 위치 ---------------------------------------------------------
  routes.set('POST /api/locate', withBody(async (body, req, res) => {
    if (!soulValidation.ok) {
      sendJson(res, 200, {
        ok: false,
        root: null,
        mode: null,
        reason: soulValidation.reason,
        message: '설치 폴더 이름을 쓸 수 없습니다. 설치기를 다시 받아 실행해 주세요.',
      });
      return;
    }
    const soul = refreshSoul();
    const ok = soul.mode !== 'foreign';
    // A refusal also REVOKES an earlier confirmation: the person may have
    // pointed the installer at a folder, been refused, and must not then be
    // able to write into it by skipping ahead.
    soulConfirmed = ok;
    if (ok && (state.step === 'precheck' || state.step === 'locate')) state.step = 'choice';
    save();
    log(`locate root=${soul.root} mode=${soul.mode}`);
    sendJson(res, 200, { ok, root: soul.root, mode: soul.mode, message: SOUL_MESSAGE[soul.mode] });
  }));

  // --- ③ 구독 -------------------------------------------------------------
  // 설계-v2 5절 ④-2: 둘 다 고르면 Claude 가 주도한다. 옛 guideEdition 은 폐지.
  routes.set('POST /api/choice', withBody(async (body, req, res) => {
    const subs = Array.isArray(body?.subscriptions)
      ? [...new Set(body.subscriptions.filter((s) => s === 'claude' || s === 'chatgpt'))]
      : [];
    if (subs.length === 0) {
      sendJson(res, 200, { ok: false, reason: 'empty', message: '구독을 적어도 하나는 골라 주세요.' });
      return;
    }
    const leadAgent = subs.includes('claude') ? 'claude' : 'chatgpt';
    state.choice = { subscriptions: subs, leadAgent };
    if (state.step === 'choice') state.step = 'structure';
    save();
    sendJson(res, 200, { ok: true, leadAgent });
  }));

  // --- ④ 작업 폴더 구성 -----------------------------------------------------
  routes.set('POST /api/structure', withBody(async (body, req, res) => {
    if (!requireLocated(res)) return;
    const root = state.soul.root;
    const later = body?.later === true;
    const nodes = Array.isArray(body?.nodes) ? body.nodes : [];
    const verdict = validateNodes(nodes, { later });
    if (!verdict.ok) {
      sendJson(res, 200, { ok: false, errors: verdict.errors });
      return;
    }
    const decisions = buildDecisions({ nodes, later });
    let saved;
    try {
      saved = writeDecisions(root, decisions);
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        code: 'E-DECISIONS-WRITE',
        message: '적어 주신 폴더 구성을 저장하지 못했습니다. 로그 경로를 복사해 알려 주세요.',
        detail: String(err?.message ?? err),
      });
      return;
    }
    state.decisions = decisions;
    state.decisionsPath = saved;
    if (state.step === 'structure') state.step = 'summary';
    save();
    log(`structure nodes=${decisions.nodes.length} later=${decisions.later} -> ${saved}`);
    sendJson(res, 200, { ok: true, decisions });
  }));

  routes.set('GET /api/presets', async (req, res) => {
    fs.readFile(path.join(uiDir, 'presets.json'), (err, data) => {
      if (err) {
        sendJson(res, 200, { schema: 1, presets: [] });
        return;
      }
      writeHeaders(res, 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length,
      });
      res.end(data);
    });
  });

  // --- ⑤ 요약 확인 ---------------------------------------------------------
  // The one click that turns answers into an install. This is also where the
  // v2 receipt is created (or refreshed), so the engine and every later step
  // read the answers from one place on disk rather than from this process.
  routes.set('POST /api/summary/confirm', withBody(async (body, req, res) => {
    if (!requireLocated(res)) return;
    const root = state.soul.root;
    if (!state.choice) {
      sendJson(res, 409, { ok: false, reason: 'no_choice', message: '구독 선택을 먼저 해 주세요.' });
      return;
    }
    const decisions = state.decisions ?? readDecisions(root);
    if (!decisions) {
      sendJson(res, 409, { ok: false, reason: 'no_decisions', message: '작업 폴더 구성을 먼저 마쳐 주세요.' });
      return;
    }
    state.decisions = decisions;
    try {
      const manifest = readPayloadManifest(state.zipRoot);
      const prior = readReceiptFn(root);
      // S09 (1.x 위에 2.0 을 새로 놓는 길): 옛 영수증은 그 PC 에 1.x 가 무엇을
      // 깔아 두었는지 아는 유일한 기록이다. v2 영수증으로 덮어쓰기 전에 반드시
      // 옆에 사본을 남긴다 -- 설치기의 제1원칙은 "사용자 자료를 지우지 않는다"
      // 이고, 남이 만든 기록도 사용자 자료다. 사본이 이미 있으면 건드리지
      // 않는다(두 번째 실행이 첫 번째의 원본을 덮어쓰면 뜻이 없다).
      if (prior && isLegacyReceipt(prior)) {
        const backup = backupLegacyReceipt(root, prior);
        log(`legacy receipt (schema ${prior.schema ?? 1}) ${backup.written ? 'backed up to' : 'already backed up at'} ${backup.path}`);
      }
      const receipt = prior && !isLegacyReceipt(prior)
        ? ensureV2Fields(prior)
        : newReceiptV2({ root, name: state.soul.name, manifest, createdBy: 'iris-installer' });
      setPrecheck(receipt, state.precheck?.recorded ?? null);
      receipt.choice = state.choice;
      receipt.decisionsPath = decisionsPath(root);
      markReceiptStep(receipt, 'precheck', 'done');
      markReceiptStep(receipt, 'locate', 'done');
      markReceiptStep(receipt, 'choice', 'done');
      markReceiptStep(receipt, 'structure', 'done');
      markReceiptStep(receipt, 'summary', 'done');
      writeReceiptFn(root, receipt);
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        code: 'E-RECEIPT-WRITE',
        message: '설치 기록을 만들지 못했습니다. 로그 경로를 복사해 알려 주세요.',
        detail: String(err?.message ?? err),
      });
      return;
    }
    state.step = 'setup';
    state.setup = initialSetup();
    save();
    log('summary confirmed -> setup');
    sendJson(res, 200, { ok: true });
  }));

  // --- ⑥ 세팅 엔진 ---------------------------------------------------------
  let setupRunning = false;

  function buildSetupContext(root) {
    const toolsDir = path.join(root, '_agent', 'shared', 'tools');
    const pathParts = [
      state.nodeDir,
      path.join(toolsDir, 'node'),
      path.join(toolsDir, 'python'),
      path.join(toolsDir, 'git', 'cmd'),
    ].filter(Boolean);
    return {
      root,
      payloadDir: path.join(state.zipRoot ?? '', 'payload'),
      manifest: readPayloadManifest(state.zipRoot),
      lock: readLock(state.zipRoot),
      receipt: readReceiptFn(root),
      decisions: state.decisions ?? readDecisions(root),
      choice: state.choice,
      precheck: state.precheck?.recorded ?? null,
      log,
      progress: (sub) => {
        const id = state.setup.stage;
        if (!id) return;
        markSetupStage(state.setup, { id, sub });
        save();
      },
      run: runFn,
      fs,
      env: { ...process.env, PATH: `${pathParts.join(';')};${process.env.PATH ?? ''}` },
      offline: true,
      toolsDir,
      ...(userEnvSkipped ? { userpath: recordingUserpath(userEnvRecord) } : {}),
    };
  }

  async function runSetupNow() {
    const root = state.soul?.root;
    setupRunning = true;
    state.step = 'setup';
    state.setup.error = null;
    save();
    try {
      const result = await setupRunner.runSetup(buildSetupContext(root), {
        onStage: (event) => {
          if (!event || !event.id) return;
          markSetupStage(state.setup, event);
          save();
        },
      });
      if (result?.ok) {
        for (const entry of state.setup.stages) {
          if (entry.status === 'pending' || entry.status === 'running') entry.status = 'done';
        }
        state.setup.percent = 100;
        state.setup.error = null;
        state.setup.pending = result.pending ?? [];
        state.step = 'online';
        log('setup done -> online');
      } else {
        const failed = result?.failed ?? { id: state.setup.stage, code: result?.code ?? 'E-SETUP', message: result?.message ?? null };
        // markSetupStage first, THEN the summary error -- marking a stage
        // 'failed' rewrites setup.error from the stage's own detail, which
        // would otherwise clobber the (better) message the engine returned.
        if (failed.id) {
          markSetupStage(state.setup, {
            id: failed.id, status: 'failed', code: failed.code ?? 'E-SETUP', detail: failed.message ?? null,
          });
        }
        state.setup.error = {
          id: failed.id ?? state.setup.stage,
          code: failed.code ?? 'E-SETUP',
          message: failed.message ?? '설치 도중 멈췄습니다.',
        };
        state.setup.percent = setupPercent(state.setup);
        log(`setup failed at ${state.setup.error.id} (${state.setup.error.code})`);
      }
    } catch (err) {
      state.setup.error = {
        id: state.setup.stage,
        code: err?.code ?? 'E-SETUP',
        message: '설치 도중 멈췄습니다. 「다시 시도」를 눌러 주세요.',
        detail: String(err?.message ?? err),
      };
      log(`setup threw: ${String(err?.stack ?? err)}`);
    } finally {
      setupRunning = false;
      save();
    }
  }

  function startSetup(res) {
    if (!requireLocated(res)) return;
    if (setupRunning) {
      sendJson(res, 202, { ok: true, running: true });
      return;
    }
    sendJson(res, 202, { ok: true, running: true });
    // Deliberately not awaited: the response is out and the screen now polls
    // GET /api/setup/progress.
    runSetupNow();
  }

  routes.set('POST /api/setup/start', withBody(async (body, req, res) => { startSetup(res); }));

  // 「다시 시도」 = 실패한 단계부터. The engine skips every stage the receipt
  // already marks `done`, so restarting it IS "resume from the failed stage".
  routes.set('POST /api/setup/retry', withBody(async (body, req, res) => { startSetup(res); }));

  routes.set('GET /api/setup/progress', async (req, res) => {
    sendJson(res, 200, { ok: true, ...state.setup, running: setupRunning });
  });

  // --- ⑦ 온라인 묶음 -------------------------------------------------------
  let onlineRunning = false;

  async function runOnlineStart() {
    const root = state.soul?.root;
    const subs = state.choice?.subscriptions ?? [];
    onlineRunning = true;
    try {
      state.online.stage = 'net';
      save();
      const net = await onlineRunner.checkNet({ root, subscriptions: subs });
      state.online.net = { ok: net?.ok === true, blocked: net?.blocked ?? [], code: net?.code ?? null };
      save();
      if (!net?.ok) {
        state.online.stage = 'net';
        log(`online net blocked: ${(net?.blocked ?? []).join(',') || net?.code || 'unknown'}`);
        return;
      }
      if (subs.includes('claude')) {
        state.online.stage = 'claude';
        state.online.claude = { state: 'downloading', source: null, code: null };
        save();
        // `log` 를 넘긴다 — 2026-09-16 VM S01 에서 출처 1·2 가 왜 실패했는지 어디에도
        // 남지 않아(기본 log 는 빈 함수) 원인을 되짚을 수 없었다.
        const got = await onlineRunner.installClaude({ root, nodeDir: state.nodeDir, log });
        if (!got?.ok) log(`online claude failed: ${JSON.stringify(got?.detail ?? got?.message ?? null)}`);
        state.online.claude = {
          state: got?.ok ? 'done' : 'failed',
          source: got?.source ?? null,
          code: got?.code ?? null,
        };
        save();

        // document-skills: 허가서상 꾸러미에 못 싣는 클로드 플러그인이라
        // 여기서 받아 등록한다(설계-v2 13절). 받지 못해도 설치를 멈추지
        // 않는다 — `pending` 으로 남고 완료 보고의 "남은 일"에 실린다.
        state.online.stage = 'document-skills';
        state.online.documentSkills = { state: 'downloading', code: null };
        save();
        const skills = typeof onlineRunner.installDocumentSkills === 'function'
          ? await onlineRunner.installDocumentSkills({
            root, zipRoot: state.zipRoot, lock: readLock(state.zipRoot), subscriptions: subs,
          })
          : { ok: false, state: 'pending', code: 'E-NOT-IMPLEMENTED' };
        state.online.documentSkills = {
          state: skills?.ok ? 'done' : (skills?.state === 'skipped' ? 'skipped' : 'pending'),
          code: skills?.code ?? null,
        };
        log(`online document-skills ${state.online.documentSkills.state}${skills?.code ? ` (${skills.code})` : ''}`);
      } else {
        state.online.claude = { state: 'skipped', source: null, code: null };
        state.online.documentSkills = { state: 'skipped', code: null };
      }
      state.online.stage = 'login';
      for (const provider of subs) {
        state.online.logins[provider] = state.online.logins[provider]
          ?? { state: 'waiting', cli: 'pending', relay: 'pending', reason: null };
      }
    } catch (err) {
      state.online.error = { code: 'E-ONLINE', detail: String(err?.message ?? err) };
      log(`online start threw: ${String(err?.stack ?? err)}`);
    } finally {
      onlineRunning = false;
      save();
    }
  }

  routes.set('POST /api/online/start', withBody(async (body, req, res) => {
    // ⑦ 도 ⑥ 과 똑같이 영혼 폴더에 쓴다(claude.exe·설정·영수증). 위치 확인을
    // 건너뛴 채(또는 'foreign' 판정을 받고도) 여기로 바로 들어오는 길을 막는다.
    if (!requireLocated(res)) return;
    if (onlineRunning) {
      sendJson(res, 202, { ok: true, running: true });
      return;
    }
    sendJson(res, 202, { ok: true, running: true });
    runOnlineStart();
  }));

  routes.set('GET /api/online/status', async (req, res) => {
    const root = state.soul?.root;
    const subs = state.choice?.subscriptions ?? [];
    // Refresh whichever provider is mid-login; everything else is already
    // settled in state.online.
    for (const provider of subs) {
      const entry = state.online.logins[provider];
      if (!entry || entry.state === 'done' || entry.state === 'not-needed') continue;
      try {
        const st = await onlineRunner.loginStatus({ provider, root, nodeDir: state.nodeDir });
        if (st && st.code !== 'E-NOT-IMPLEMENTED') {
          state.online.logins[provider] = {
            state: st.state ?? entry.state,
            cli: st.cli ?? entry.cli,
            relay: st.relay ?? entry.relay,
            reason: st.reason ?? null,
          };
        }
      } catch { /* a polling route must never throw */ }
    }
    const allLoggedIn = subs.length > 0 && subs.every((p) => state.online.logins[p]?.state === 'done');
    if (allLoggedIn && state.online.stage === 'login') state.online.stage = 'relay';
    save();
    sendJson(res, 200, { ok: true, step: state.step, ...state.online, running: onlineRunning });
  });

  async function doLogin(body, res, { retry }) {
    const provider = body?.provider;
    if (provider !== 'claude' && provider !== 'chatgpt') {
      sendJson(res, 200, { ok: false, reason: 'bad_provider', message: '알 수 없는 구독입니다.' });
      return;
    }
    if (!requireLocated(res)) return;
    const started = await onlineRunner.startLogin({
      provider, root: state.soul.root, nodeDir: state.nodeDir, retry: !!retry,
    });
    state.online.logins[provider] = {
      state: started?.ok ? (started.state ?? 'waiting') : 'failed',
      cli: started?.cli ?? 'pending',
      relay: started?.relay ?? 'pending',
      reason: started?.reason ?? null,
    };
    state.online.stage = 'login';
    save();
    log(`online login provider=${provider} retry=${!!retry} ok=${started?.ok === true}`);
    sendJson(res, 200, {
      ok: started?.ok === true,
      provider,
      ...(started?.code ? { code: started.code } : {}),
      ...(started?.message ? { message: started.message } : {}),
    });
  }

  routes.set('POST /api/online/login', withBody(async (body, req, res) => doLogin(body, res, { retry: false })));
  routes.set('POST /api/online/login/retry', withBody(async (body, req, res) => doLogin(body, res, { retry: true })));

  routes.set('POST /api/online/relay', withBody(async (body, req, res) => {
    if (!requireLocated(res)) return;
    const root = state.soul.root;
    const relay = await onlineRunner.startRelay({ root, nodeDir: state.nodeDir });
    state.online.relay = {
      state: relay?.ok ? (relay.state ?? 'done') : 'failed',
      accounts: relay?.accounts ?? 0,
      code: relay?.code ?? null,
    };
    state.online.stage = 'relay';
    if (relay?.ok) {
      state.online.completed = true;
      state.step = 'done';
      try {
        const receipt = readReceiptFn(root);
        if (receipt && !isLegacyReceipt(receipt)) {
          ensureV2Fields(receipt);
          receipt.online = { ...state.online };
          markReceiptStep(receipt, 'online', 'done');
          writeReceiptFn(root, receipt);
        }
      } catch { /* the receipt is the engine's; a failure here is not fatal */ }
      // 인수 문서(handoff.json)는 ⑨ 검사가 로그인 전에 써 둔 것이라 아직
      // `login-pending` 이다. 로그인·중계기가 끝난 지금이 `ready` 로 바뀌는
      // 유일한 순간이다(계약 = docs/인수문서-handoff-v2.md). 엔진처럼 동적으로
      // 부른다 — 이 모듈이 없어도 서버는 떠야 한다.
      try {
        const { refreshHandoffAfterOnline } = await import('./setup/handoff.mjs');
        const r = refreshHandoffAfterOnline({
          root, receipt: readReceiptFn(root), choice: state.choice, fs, log,
        });
        log(`handoff refresh: ${r?.written ? r.handoff?.state : `skipped(${r?.reason ?? 'unknown'})`}`);
      } catch (err) {
        log(`handoff refresh failed: ${String(err?.message ?? err)}`);
      }
      log('online relay ok -> done');
    }
    save();
    sendJson(res, 200, {
      ok: relay?.ok === true,
      ...(relay?.code ? { code: relay.code } : {}),
      ...(relay?.message ? { message: relay.message } : {}),
      accounts: state.online.relay.accounts,
    });
  }));

  // --- ⑧ 완료 보고 ---------------------------------------------------------
  routes.set('GET /api/report', async (req, res) => {
    const root = state.soul?.root;
    if (!root) {
      sendJson(res, 409, { ok: false, reason: 'no_soul' });
      return;
    }
    const setupDir = path.join(root, '_agent', 'setup');
    let handoff = null;
    try {
      handoff = JSON.parse(fs.readFileSync(path.join(setupDir, 'handoff.json'), 'utf8'));
    } catch { /* not written yet */ }
    let markdown = null;
    let markdownPath = null;
    try {
      const reports = fs.readdirSync(setupDir)
        .filter((f) => f.startsWith('설치보고-') && f.endsWith('.md'))
        .sort();
      if (reports.length > 0) {
        markdownPath = path.join(setupDir, reports[reports.length - 1]);
        markdown = fs.readFileSync(markdownPath, 'utf8');
      }
    } catch { /* not written yet */ }
    const pendingCapabilities = handoff?.pendingCapabilities ?? state.setup?.pending ?? [];
    state.report = { markdownPath, handoffPath: handoff ? path.join(setupDir, 'handoff.json') : null, pendingCapabilities };
    save();
    sendJson(res, 200, { ok: true, markdown, handoff, pendingCapabilities });
  });

  routes.set('POST /api/open-face', withBody(async (body, req, res) => {
    // Face 를 여는 것도 그 폴더를 "우리 것"으로 다루는 일이다(실행기·바로가기).
    if (!requireLocated(res)) return;
    const root = state.soul.root;
    try {
      const opener = openFaceFn ?? ((opts) => relaunchFaceFn(opts));
      const result = await opener({
        root,
        ...(faceDir ? { faceDir } : {}),
        ...(faceNodeExe ? { nodeExe: faceNodeExe } : {}),
      });
      log(`open-face ok=${result?.ok === true}`);
      sendJson(res, 200, { ok: result?.ok === true, ...(result?.pid ? { pid: result.pid } : {}) });
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        code: 'E-OPEN-FACE',
        message: 'IRIS 창을 열지 못했습니다. 바탕화면의 「IRIS」 바로가기를 눌러 주세요.',
        detail: String(err?.message ?? err),
      });
    }
  }));

  // --- 로그 경로 복사 -------------------------------------------------------
  routes.set('POST /api/log/path', withBody(async (body, req, res) => {
    sendJson(res, 200, { ok: true, path: serverLog, soulPath: soulLogPath() });
  }));

  // =========================================================================
  // update mode (POST /api/auto) -- the updater's no-click run over a v2
  // install. Since 2.0 it runs the SAME setup engine as the wizard (the v1
  // `install()` only knew 12 of the 33 parts and had the python layout wrong);
  // what an update adds is only "which stages may re-run" (lib/update-plan.mjs)
  // and this SSE stream, which no other path uses.
  // =========================================================================
  const installEvents = [];
  const sseClients = new Set();
  let autoRunning = false;

  function pushEvent(event) {
    installEvents.push(event);
    if (event.part) {
      state.install = state.install ?? { parts: {} };
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

  routes.set('GET /api/install/events', async (req, res) => {
    writeHeaders(res, 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    for (const e of installEvents) res.write(`data: ${JSON.stringify(e)}\n\n`);
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
  });

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
    let relaunched = null;

    // 설계 4-5: 실패 항목이 있어도 창은 다시 연다 -- the updater shut the daemon
    // down before handing over, and the unpack stage rolls a failed part back
    // to its .prev copy, so what reopens is the version that worked a minute ago.
    const failAuto = (where, reason, detail = null) => {
      if (relaunched === null) relaunched = relaunchFace();
      state.step = 'auto';
      state.installError = reason;
      state.autoResult = { ok: false, where, reason, detail, relaunched: relaunched?.ok ?? false };
      save();
      pushEvent({ part: 'relaunch', pct: null, skipped: false, status: relaunched?.ok ? 'done' : 'error', error: null, done: false });
      pushEvent({ part: where, pct: null, skipped: false, status: 'error', error: reason, detail, done: true });
    };

    try {
      forward({ part: 'precheck', pct: 0, status: 'running' });
      const pre = await precheckFn();
      state.precheck = pre;
      save();
      if ((pre?.blockers ?? []).length > 0) { failAuto('precheck', 'precheck_failed'); return; }
      forward({ part: 'precheck', pct: 5, status: 'done' });

      state.soul = { name: info.name, root, mode: 'iris' };
      state.choice = info.choice ?? { subscriptions: ['claude'], leadAgent: 'claude' };
      state.decisions = state.decisions ?? readDecisions(root);
      save();

      // --- 업데이트 = 세팅 엔진 한 번 더 --------------------------------
      // 판단(어느 단계를 다시 도나)은 lib/update-plan.mjs, 실행은 ⑤ 엔진이다.
      // 여기서 하는 일은 셋뿐: 영수증의 해당 단계를 `pending` 으로 되돌리고,
      // 마법사와 **똑같은** ctx 로 엔진을 부르고, 단계 진행을 이 화면의 SSE
      // 틀(part/pct/status)로 옮겨 방송하는 것.
      const priorReceipt = ensureV2Fields(readReceiptFn(root) ?? {});
      const plan = planUpdateReset({ receipt: priorReceipt, lock, manifest });
      applyUpdateReset(priorReceipt, plan);
      try {
        writeReceiptFn(root, priorReceipt);
      } catch (err) {
        failAuto('receipt', 'receipt_write_failed', String(err?.message ?? err));
        return;
      }
      log(`auto reset stages=${plan.reset.join(',')} kept=${plan.keptDone.join(',') || '-'} changedParts=${plan.changed.length}`);

      state.setup = initialSetup();
      save();
      const result = await setupRunner.runSetup(buildSetupContext(root), {
        onStage: (event) => {
          if (!event || !event.id) return;
          markSetupStage(state.setup, event);
          save();
          forward({
            part: event.id,
            pct: typeof event.percent === 'number' ? Math.min(95, event.percent) : null,
            status: event.status === 'skipped-done' ? 'skipped' : event.status,
            ...(event.status === 'skipped-done' ? { skipped: true } : {}),
          });
        },
      });
      if (!result?.ok) {
        const failed = result?.failed ?? { id: 'setup', code: result?.code ?? 'E-SETUP', message: result?.message ?? null };
        state.setup.error = {
          id: failed.id ?? 'setup',
          code: failed.code ?? 'E-SETUP',
          message: failed.message ?? '업데이트 도중 멈췄습니다.',
        };
        save();
        failAuto(failed.id ?? 'setup', failed.code ?? 'E-SETUP', failed.message ?? null);
        return;
      }
      for (const entry of state.setup.stages) {
        if (entry.status === 'pending' || entry.status === 'running') entry.status = 'done';
      }
      state.setup.percent = 100;
      state.setup.pending = result.pending ?? [];

      // 새 판을 실제로 놓았으니 영수증의 판 표시도 새 것으로. 엔진이 방금
      // 영수증을 여러 번 고쳐 썼으므로 디스크에서 다시 읽어서 고친다.
      try {
        const after = ensureV2Fields(readReceiptFn(root) ?? priorReceipt);
        const pkg = manifest?.package ?? {};
        after.package = {
          ...(after.package ?? {}),
          name: pkg.name ?? after.package?.name ?? 'IRIS',
          version: pkg.version ?? after.package?.version ?? null,
          built: pkg.built ?? manifest?.built ?? after.package?.built ?? null,
          guideVersion: pkg.guideVersion ?? after.package?.guideVersion ?? null,
          license: pkg.license ?? after.package?.license ?? 'MIT',
        };
        after.update = {
          from: info.from ?? null,
          to: info.to ?? (pkg.version ?? null),
          at: new Date().toISOString(),
          reset: plan.reset,
          changedParts: plan.changed,
        };
        markReceiptStep(after, 'setup', 'done');
        writeReceiptFn(root, after);
      } catch (err) {
        // 판 표시를 못 고쳐도 설치 자체는 끝났다 — 기록만 남기고 계속한다.
        log(`auto receipt version refresh failed: ${String(err?.message ?? err)}`);
      }

      forward({ part: 'login', pct: 96, status: 'skipped', skipped: true });

      const relaunch = relaunchFace();
      relaunched = relaunch;
      forward({ part: 'relaunch', pct: 99, status: relaunch?.ok ? 'done' : 'error' });

      finishFn({
        root,
        receipt: readReceiptFn(root),
        ...(workDir ? { workDir } : {}),
        setStep: (s) => { state.step = s; save(); },
        quit: () => {
          setTimeout(() => { if (onQuit) onQuit(); else process.exit(0); }, 1500);
        },
      });

      state.autoResult = {
        ok: true, from: info.from, to: info.to, relaunched: relaunch?.ok ?? false, pid: relaunch?.pid ?? null,
      };
      state.step = 'done';
      save();
      pushEvent({ part: null, pct: 100, skipped: false, status: 'done', error: null, done: true });
    } catch (err) {
      failAuto('setup', err?.code ?? 'install_failed', String(err?.message ?? err));
    } finally {
      autoRunning = false;
      save();
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
    soulConfirmed = true; // a v2 receipt is proof the folder is ours
    installEvents.length = 0;
    state.step = 'auto';
    state.install = { parts: {} };
    state.installError = null;
    state.autoResult = null;
    state.userEnvSkipped = userEnvSkipped;
    save();
    sendJson(res, 202, { ok: true, from: info.from, to: info.to });

    runAuto(info, manifest, lock);
  }));

  routes.set('POST /api/quit', async (req, res) => {
    sendJson(res, 200, { ok: true });
    setTimeout(() => {
      if (onQuit) onQuit();
      else process.exit(0);
    }, 200);
  });

  // Routes that v1 had and v2 does not. 410 rather than 404 so an old cached
  // page (or a stale bookmark) gets a verdict instead of looking like a broken
  // server.
  for (const gone of ['POST /api/name', 'POST /api/install', 'POST /api/login', 'POST /api/handoff']) {
    routes.set(gone, async (req, res) => {
      sendJson(res, 410, { ok: false, reason: 'gone', step: state.step });
    });
  }
  routes.set('GET /api/login/status', async (req, res) => {
    sendJson(res, 410, { ok: false, reason: 'gone', step: state.step });
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
    // Resume mode (also IRIS_INSTALLER_RESUME=1) -- Face's 「설치 이어하기」.
    else if (a === '--resume') args.resume = true;
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

export { parseArgs };
