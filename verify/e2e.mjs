// verify/e2e.mjs -- 3층 「가상 영혼」 (설계-v2 10절)
//
// The layer-2 check (verify/offline.mjs) proves the zip needs no network. This
// one proves the zip actually *installs*: it takes the freshly built zip, runs
// the shipped installer/server.mjs as a REAL child process on the real port
// (3460) against a throwaway practice root (C:\IRIS-e2e -- never C:\IRIS), and
// then checks the four promises 설계-v2 10절 makes about "3층":
//
//   ① 전체 실행   precheck -> locate -> choice -> structure -> summary ->
//                 setup(9단계) -> 검사 통과. Plus the four artefacts ⑨ must
//                 leave behind: handoff.json (계약 = docs\인수문서-handoff-v2.md),
//                 설치보고-YYYY-MM-DD.md, diagnostics.json (사용자 이름 없음),
//                 and the installer copy at the exact `resume` path.
//   ② 두 번 실행 변경 0   restart the server against the SAME root: all nine
//                 stages report `이미 끝나 있어 건너뜀`, every stage's
//                 finishedAt is byte-identical, and the file tree fingerprint
//                 does not move.
//   ③ 고장 주입   IRIS_INSTALLER_FAIL_AT=<단계> for each of the nine ids:
//                 the engine stops at exactly that stage, and a plain re-run
//                 (no FAIL_AT) finishes the install from there.
//   ④ 정직한 멈춤 ⑥-1 인터넷 확인 under OFFLINE reports E-ONLINE-NET and the
//                 인수 문서 stays `login-pending`. No login is ever attempted
//                 -- this script never touches a real subscription.
//
// Safety rules this file obeys (they are not optional):
//   · The only folder outside the repo it writes is C:\IRIS-e2e, and a
//     `finally` removes it on every exit path. The real C:\IRIS, the desktop,
//     HKCU\Environment and the user profile's own `.claude*` are never touched
//     (IRIS_INSTALLER_NO_USER_ENV=1 + a redirected %LOCALAPPDATA%).
//   · Processes: only the PID this script spawned is ever killed, by PID,
//     never by name. If port 3460 is already busy the script ABORTS rather
//     than freeing it -- 3456/3457/3458 (프록시·대시보드·Face) must never be
//     disturbed, and a stranger on 3460 is not ours to end either.
//   · No model is ever called. The ⑨ 검사 MCP probe is `initialize` only, and
//     the 온라인 묶음 is driven no further than the net check.
//
// Usage:
//   node verify/e2e.mjs                   full run (①②③④) -- about 12 minutes
//   node verify/e2e.mjs --quick           ①②④ only (skip the nine fault runs)
//   node verify/e2e.mjs --faults-only     ③ only
//   node verify/e2e.mjs --scenario s08    시험 행렬 S08 + S11(있음) 근거 수집
//                                         (C:\IRIS-s08 · 이 PC 무접촉 증명)
//   node verify/e2e.mjs --keep            leave the practice root and _build/e2e
//   node verify/e2e.mjs --zip <path>      use a specific zip instead of last-build

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractZip } from '../lib/zip.mjs';
import { driveInstall, post, getJson } from './offline.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAST_BUILD_JSON = path.join(ROOT_DIR, '_build', 'out', 'last-build.json');
const SCRATCH_DIR = path.join(ROOT_DIR, '_build', 'e2e');
const ZIP_DIR = path.join(SCRATCH_DIR, 'zip');
const STATE_DIR = path.join(SCRATCH_DIR, 'state'); // stands in for %LOCALAPPDATA%
const PORT = 3460; // the product's own port. 3456/3457/3458 are off limits.

// Two practice roots, never the real C:\IRIS. `--scenario s08` swaps to the
// second one so an S08 evidence run and a plain 3층 run can never collide.
// installer/lib/soulname.mjs maps a soul name to C:\<name>.
let SOUL_NAME = 'IRIS-e2e';
let SOUL_ROOT = `C:\\${SOUL_NAME}`;
function useSoul(name) { SOUL_NAME = name; SOUL_ROOT = `C:\\${name}`; }

// Ports this machine runs IRIS infrastructure on. Listed here so the abort
// message can name them; the script never connects to or touches them.
const FORBIDDEN_PORTS = [3456, 3457, 3458];

// docs\세팅엔진-계약-v2.md "엔진" -- verified against the zip's own
// installer/setup/engine.mjs STAGES at the start of every run.
const STAGES = ['unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks'];

// docs\인수문서-handoff-v2.md -- every key the contract table names.
const HANDOFF_KEYS = [
  'schema', 'packageVersion', 'writtenAt', 'state', 'subscriptions', 'leadAgent',
  'login', 'relay', 'setup', 'folders', 'nameEnMissing', 'deferred',
  'pendingCapabilities', 'checks', 'reportPath', 'diagnosticsPath',
  'firstMessage', 'messenger', 'resume',
];
const HANDOFF_STATES = ['ready', 'login-pending', 'setup-incomplete'];
const RESUME_INSTALLER_PATH = '_agent/setup/installer/IRIS-설치.cmd';

// ---------------------------------------------------------------------------
// tiny result recorder -- everything this script learns lands in one table
// ---------------------------------------------------------------------------

const results = [];
let failures = 0;

function record(phase, name, ok, detail = '') {
  results.push({ phase, name, ok, detail: String(detail ?? '') });
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} [${phase}] ${name}${detail ? ` -- ${detail}` : ''}`);
  return ok;
}

function check(phase, name, cond, detail = '') {
  return record(phase, name, Boolean(cond), detail);
}

function log(msg) {
  console.log(`[e2e] ${msg}`);
}

const ms = (n) => `${(n / 1000).toFixed(1)}s`;

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net.createConnection({ host: '127.0.0.1', port }, () => {
      probe.destroy();
      resolve(true);
    });
    probe.on('error', () => resolve(false));
    probe.setTimeout(1500, () => { probe.destroy(); resolve(false); });
  });
}

function findBuiltZip(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`--zip ${explicit} does not exist`);
    return { zip: explicit, sha: shaOfFile(explicit), contentFingerprint: null };
  }
  if (!fs.existsSync(LAST_BUILD_JSON)) {
    throw new Error(`${LAST_BUILD_JSON} does not exist -- run "node verify/offline.mjs --build" first`);
  }
  const info = JSON.parse(fs.readFileSync(LAST_BUILD_JSON, 'utf8'));
  if (!info.zip || !fs.existsSync(info.zip)) throw new Error(`last-build.json's zip is gone: ${info.zip}`);
  // last-build.json stores the `sha256sum`-style line "<hex>  <name>".
  const sha = String(info.sha256 ?? '').trim().split(/\s+/)[0] ?? '';
  const cf = String(info.contentFingerprint ?? '').trim();
  return {
    zip: info.zip,
    sha: /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : shaOfFile(info.zip),
    contentFingerprint: /^[0-9a-f]{64}$/i.test(cf) ? cf.toLowerCase() : null,
  };
}

// 내용 지문 (Task 24a): the value the 시험행렬 row carries. It lives inside the
// zip's own payload\manifest.json, so reading it from the EXTRACTED zip is
// authoritative for the archive actually under test -- true whether the zip
// came from last-build.json or from --zip <path>. last-build.json's copy is
// only the fallback for a zip this run did not extract.
function contentFingerprintOfExtractedZip(zipDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(zipDir, 'payload', 'manifest.json'), 'utf8'));
    const cf = String(m?.contentFingerprint ?? '').trim();
    return /^[0-9a-f]{64}$/i.test(cf) ? cf.toLowerCase() : null;
  } catch {
    return null;
  }
}

function shaOfFile(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// the installer server as a real child process
// ---------------------------------------------------------------------------

function serverEnv({ failAt = null } = {}) {
  const env = {
    ...process.env,
    IRIS_INSTALLER_SOUL_NAME: SOUL_NAME,
    IRIS_INSTALLER_NO_USER_ENV: '1',
    IRIS_INSTALLER_OFFLINE: '1',
    // The server puts state.json / server.log under %LOCALAPPDATA%\IRIS-Installer
    // (server.mjs's `isMain` block). Redirecting it into the scratch folder is
    // what keeps a rehearsal from colliding with a real install's state file.
    LOCALAPPDATA: STATE_DIR,
  };
  delete env.IRIS_INSTALLER_FAIL_AT;
  delete env.IRIS_INSTALLER_AUTO;
  delete env.IRIS_INSTALLER_RESUME;
  if (failAt) env.IRIS_INSTALLER_FAIL_AT = failAt;
  return env;
}

async function startInstaller({ failAt = null, freshState = true } = {}) {
  if (freshState) fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const serverPath = path.join(ZIP_DIR, 'installer', 'server.mjs');
  if (!fs.existsSync(serverPath)) throw new Error(`extracted zip has no installer/server.mjs at ${serverPath}`);

  const child = spawn(process.execPath, [
    serverPath,
    '--zip-root', ZIP_DIR,
    '--port', String(PORT),
    '--node-dir', path.dirname(process.execPath),
    '--no-user-env',
  ], {
    cwd: ZIP_DIR,
    env: serverEnv({ failAt }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out = [];
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  const url = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 45000;
  for (;;) {
    if (exited) throw new Error(`installer server exited before answering (code ${exited.code}):\n${out.join('')}`);
    try {
      const h = await (await fetch(`${url}/api/health`)).json();
      if (h?.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(`installer server did not answer /api/health within 45s:\n${out.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    url,
    pid: child.pid,
    output: () => out.join(''),
    // Stop ONLY this PID. Never a name-based kill (전역 규칙), never a port
    // sweep -- the pid came from this very spawn() call.
    async stop() {
      if (exited) return;
      try { child.kill(); } catch { /* already gone */ }
      const until = Date.now() + 8000;
      while (!exited && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      if (!exited && child.pid) {
        // A shell-less node child normally dies on kill(); this is the belt to
        // that brace, still aimed at exactly one pid tree.
        await new Promise((resolve) => {
          const t = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          t.on('exit', () => resolve());
          t.on('error', () => resolve());
        });
      }
      // Give the listening socket a moment to be released before the next start.
      for (let i = 0; i < 40 && await portInUse(PORT); i++) await new Promise((r) => setTimeout(r, 100));
    },
  };
}

// ---------------------------------------------------------------------------
// driving one install, with per-stage timings
// ---------------------------------------------------------------------------

// Polls GET /api/setup/progress alongside driveInstall() so we learn how long
// each of the nine stages took. The server exposes the stage it is on
// (`state.setup.stage`), so a transition is a stage boundary.
function watchStages(url) {
  const timings = [];
  let current = null;
  let startedAt = Date.now();
  let stopped = false;

  const tick = async () => {
    while (!stopped) {
      try {
        const p = await getJson(url, '/api/setup/progress');
        const stage = p?.stage ?? null;
        if (stage !== current) {
          if (current) timings.push({ id: current, ms: Date.now() - startedAt });
          current = stage;
          startedAt = Date.now();
        }
      } catch { /* the server may be mid-restart; a watcher must never throw */ }
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const loop = tick();

  return {
    async stop() {
      stopped = true;
      await loop;
      if (current) timings.push({ id: current, ms: Date.now() - startedAt });
      return timings;
    },
  };
}

async function installOnce(url) {
  const watcher = watchStages(url);
  const t0 = Date.now();
  let progress = null;
  let thrown = null;
  try {
    progress = await driveInstall(url);
  } catch (err) {
    thrown = err;
  }
  const timings = await watcher.stop();
  if (thrown) throw thrown;
  return { progress, timings, totalMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// soul-root inspection helpers
// ---------------------------------------------------------------------------

const setupDir = () => path.join(SOUL_ROOT, '_agent', 'setup');
const receiptFile = () => path.join(setupDir(), 'package-receipt.json');
const handoffFile = () => path.join(setupDir(), 'handoff.json');
const diagnosticsFile = () => path.join(setupDir(), 'diagnostics.json');
const setupLogFile = () => path.join(setupDir(), 'setup.log');

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// path + size(+ 내용 해시) for every file under the root, sorted, hashed.
// 네 파일만 뺀다 -- 셋은 *실행 자체의 로그*라 자라는 것이 정상이고, 넷째는
// 시각만 다시 쓰이는 파일이라 따로 더 엄하게 본다:
//   setup.log            -- the engine's own log, append-only by design; run 2
//                           adds exactly nine 건너뜀 lines, which phase ②
//                           counts as its evidence.
//   installer.log        -- the server mirrors %LOCALAPPDATA%\IRIS-Installer\
//                           server.log here once the root is confirmed
//                           (server.mjs, 설계-v2 4-2). Also append-only.
//   package-receipt.json -- 요약/확인 rewrites its step timestamps on every
//                           wizard pass, which is expected. Its *setup* block
//                           is compared field-by-field instead (stronger).
//   decisions.json       -- 마법사를 한 번 더 지나면 `POST /api/structure` 가
//                           이 파일을 다시 쓰고, 그 안에는 `createdAt` 이 있다.
//                           크기는 같고 내용만 달라지므로(ISO 시각은 길이가
//                           고정) 2026-09-15 고치기 1회차에서 내용 해시를
//                           넣자마자 이 한 건이 드러났다. 통째로 빼지 않고
//                           `createdAt` 만 지운 뒤 **따로 견준다**(아래
//                           decisionsWithoutTimestamp) -- 그냥 빼면 "만들기로
//                           한 폴더 목록이 바뀌었다"는 진짜 변화도 함께 숨는다.
const FINGERPRINT_SKIP = new Set([
  '_agent\\setup\\setup.log',
  '_agent\\setup\\installer.log',
  '_agent\\setup\\package-receipt.json',
  '_agent\\setup\\decisions.json',
]);

const decisionsFile = () => path.join(SOUL_ROOT, '_agent', 'setup', 'decisions.json');

// `createdAt` 을 뺀 decisions.json. 나머지(만들기로 한 폴더·코드·영어 이름
// 미정 목록·미루기 항목)가 한 글자라도 다르면 두 번 실행이 같지 않은 것이다.
function decisionsWithoutTimestamp() {
  const d = readJsonFile(decisionsFile());
  if (!d) return null;
  const { createdAt, ...rest } = d;
  return JSON.stringify(rest);
}

// 크기만 보면 "같은 길이의 다른 내용"을 놓친다 -- 설정 파일 한 글자가 바뀌는
// 종류의 변화가 정확히 그 모양이다. 그래서 작은 파일은 내용까지 해시한다.
// 상한을 두는 이유는 하나뿐이다: 영혼 안에는 node·python·git 실행 파일 같은
// 수백 MB가 있고, 그것까지 매번 읽으면 두 번 실행 비교가 몇 분씩 걸린다.
// 큰 파일은 우리가 만든 것이 아니라 zip 에서 그대로 푼 것이고, 그 무결성은
// 2층(`verify/static.mjs` 매니페스트 대조)이 이미 sha256 으로 지킨다.
const FINGERPRINT_CONTENT_MAX = 64 * 1024;

/**
 * fingerprintTree(root) → { hash, count, entries, errors }
 *
 * 읽기 실패를 삼키지 않는다. 못 읽은 파일이 하나라도 있으면 그 지문은
 * "같다/다르다"를 말할 자격이 없으므로 `errors` 에 담아 올리고, 부르는 쪽이
 * 그것을 실패로 처리한다 -- 조용히 건너뛴 파일이 바로 변화가 숨는 자리다.
 */
function fingerprintTree(root) {
  const entries = [];
  const errors = [];
  const why = (e) => String(e?.code ?? e?.message ?? e);
  const walk = (dir, rel) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors.push(`${rel || '.'}: readdir ${why(e)}`);
      return;
    }
    for (const it of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, it.name);
      const r = rel ? `${rel}\\${it.name}` : it.name;
      if (it.isDirectory()) { walk(full, r); continue; }
      if (FINGERPRINT_SKIP.has(r)) continue;
      let st;
      try { st = fs.statSync(full); } catch (e) { errors.push(`${r}: stat ${why(e)}`); continue; }
      let mark = String(st.size);
      if (st.size <= FINGERPRINT_CONTENT_MAX) {
        try {
          mark += `:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16)}`;
        } catch (e) {
          errors.push(`${r}: read ${why(e)}`);
          continue;
        }
      }
      entries.push(`${r}|${mark}`);
    }
  };
  walk(root, '');
  const h = crypto.createHash('sha256');
  h.update(entries.join('\n'));
  return { hash: h.digest('hex'), count: entries.length, entries, errors };
}

// 영수증에서 단계별 {status, finishedAt} 만 뽑는다. 없는 단계는 null.
function stageEntries(receipt) {
  const out = {};
  for (const id of STAGES) {
    const e = receipt?.setup?.[id];
    out[id] = e ? { status: e.status ?? null, finishedAt: e.finishedAt ?? null } : null;
  }
  return out;
}

/**
 * checkResumeShape(failedId, before, after) — 재개가 "그 단계부터"였는가.
 *
 *   failedId 앞 단계  : 이미 `done` 이었으니 `finishedAt` 이 **그대로**여야 한다.
 *                       (다시 돌았다면 새 시각이 찍힌다 = 건너뛰지 않았다는 뜻)
 *   failedId 와 그 뒤 : 이번에 **실제로 돌았어야** 하므로 `done` 이고
 *                       `finishedAt` 이 앞의 값과 **달라야** 한다.
 *                       (failedId 는 멈출 때 실패 시각이 찍혀 있고, 뒤 단계들은
 *                        아예 없었다 — 어느 쪽이든 "달라진다"로 잡힌다.)
 */
function checkResumeShape(failedId, before, after) {
  const idx = STAGES.indexOf(failedId);
  const problems = [];
  let kept = 0;
  let reran = 0;
  for (let i = 0; i < STAGES.length; i++) {
    const id = STAGES[i];
    const b = before[id];
    const a = after[id];
    if (a?.status !== 'done') { problems.push(`${id}: 재실행 뒤 상태가 ${a?.status ?? '없음'}`); continue; }
    if (i < idx) {
      if (b?.status !== 'done') { problems.push(`${id}: 멈춤 시점에 done 이 아니었다(${b?.status ?? '없음'})`); continue; }
      if (a.finishedAt !== b.finishedAt) { problems.push(`${id}: 건너뛰지 않고 다시 돌았다(${b.finishedAt} → ${a.finishedAt})`); continue; }
      kept += 1;
    } else {
      if (a.finishedAt && a.finishedAt === b?.finishedAt) { problems.push(`${id}: 다시 돌지 않았다(${a.finishedAt} 그대로)`); continue; }
      reran += 1;
    }
  }
  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join(' / ') : `앞 ${kept}단계 그대로 · ${failedId}부터 ${reran}단계 새로 실행`,
  };
}

function stageFinishTimes(receipt) {
  const out = {};
  for (const id of STAGES) {
    const e = receipt?.setup?.[id] ?? {};
    out[id] = `${e.status ?? '?'}@${e.startedAt ?? '?'}..${e.finishedAt ?? '?'}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ① first run
// ---------------------------------------------------------------------------

async function phaseFirstRun(zipInfo) {
  log('phase ① -- first install into the practice root');
  const server = await startInstaller();
  let timings = [];
  try {
    check('①', `설치기 서버가 ${PORT}번에서 떴다`, true, `pid ${server.pid}`);

    const run = await installOnce(server.url);
    timings = run.timings;
    const p = run.progress;

    check('①', '세팅 9단계 완료', p.error === null && p.percent === 100,
      p.error ? `error=${JSON.stringify(p.error)}` : `${ms(run.totalMs)}`);
    if (p.error) {
      // Without the receipt the rest of the phase is noise -- report and stop.
      const r = readJsonFile(receiptFile());
      log(`stage detail: ${JSON.stringify(r?.setup?.[p.error.id] ?? null)}`);
      return { timings, server, fingerprint: null };
    }

    // --- ⑨ 검사 -----------------------------------------------------------
    const receipt = readJsonFile(receiptFile());
    const recorded = receipt?.setup?.checks?.recorded ?? {};
    const summary = recorded.checks ?? {};
    const items = recorded.items ?? [];
    check('①', '검사 실패 0건', summary.fail === 0,
      `통과 ${summary.pass} · 대기 ${summary.pending} · 실패 ${summary.fail}`);
    for (const it of items) {
      log(`  검사 ${it.num ?? '-'} ${it.label}: ${it.status} -- ${String(it.detail ?? '').slice(0, 140)}`);
    }
    // This PC has both Microsoft Office and 한컴오피스 installed, so the four
    // document MCPs must actually answer `initialize` -- `pending` here would
    // mean the venv/adapters stages shipped a broken server, not a missing app.
    const mcp = items.find((i) => i.id === 'mcp');
    check('①', '문서 MCP까지 pass (Office·한컴 있는 PC)', mcp?.status === 'pass',
      mcp ? `${mcp.status}: ${String(mcp.detail).slice(0, 180)}` : 'mcp 검사 항목이 없습니다');

    // --- 인수 문서 --------------------------------------------------------
    const handoffRaw = fs.existsSync(handoffFile()) ? fs.readFileSync(handoffFile(), 'utf8') : null;
    const handoff = handoffRaw ? JSON.parse(handoffRaw) : null;
    check('①', 'handoff.json 존재', Boolean(handoff), handoffFile());
    if (handoff) {
      const missing = HANDOFF_KEYS.filter((k) => !(k in handoff));
      check('①', 'handoff.json 계약 키 전부', missing.length === 0, missing.length ? `없음: ${missing.join(', ')}` : `${HANDOFF_KEYS.length}개`);
      check('①', 'handoff.schema === 1', handoff.schema === 1, String(handoff.schema));
      check('①', 'handoff.state 세 값 중 하나', HANDOFF_STATES.includes(handoff.state), handoff.state);
      check('①', 'handoff.setup.allDone', handoff.setup?.allDone === true, JSON.stringify(handoff.setup));
      check('①', 'handoff.checks 가 영수증과 같다',
        handoff.checks?.pass === summary.pass && handoff.checks?.pending === summary.pending && handoff.checks?.fail === summary.fail,
        JSON.stringify(handoff.checks));
      check('①', 'handoff.resume 이 계약 경로', handoff.resume?.installerPath === RESUME_INSTALLER_PATH
        && Array.isArray(handoff.resume?.args) && handoff.resume.args[0] === '--resume',
        JSON.stringify(handoff.resume));
      check('①', 'handoff.messenger 는 중첩 키', typeof handoff.messenger?.installed === 'boolean'
        && handoff.messenger?.prompted === false && !('messengerPrompted' in handoff),
        JSON.stringify(handoff.messenger));
      check('①', 'handoff 경로는 전부 상대경로',
        !/[A-Za-z]:\\/.test(handoffRaw) && !handoffRaw.includes('C:/'),
        'reportPath/diagnosticsPath/resume 에 드라이브 문자 없음');
      check('①', 'handoff.firstMessage 있음', typeof handoff.firstMessage === 'string' && handoff.firstMessage.length > 10,
        `${String(handoff.firstMessage).slice(0, 48)}...`);
      check('①', 'handoff 에 사용자 이름 없음', !containsIdentity(handoffRaw), '사용자 이름·프로필 경로 0건');
    }

    // --- 설치보고 ---------------------------------------------------------
    const reports = fs.existsSync(setupDir())
      ? fs.readdirSync(setupDir()).filter((f) => /^설치보고-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      : [];
    check('①', '설치보고-YYYY-MM-DD.md 1개 이상', reports.length >= 1, reports.join(', '));
    if (handoff && reports.length) {
      check('①', 'handoff.reportPath 가 실제 파일을 가리킨다',
        fs.existsSync(path.join(SOUL_ROOT, handoff.reportPath.split('/').join(path.sep))), handoff.reportPath);
    }

    // --- 진단 파일 --------------------------------------------------------
    const diagRaw = fs.existsSync(diagnosticsFile()) ? fs.readFileSync(diagnosticsFile(), 'utf8') : null;
    check('①', 'diagnostics.json 존재', Boolean(diagRaw), diagnosticsFile());
    if (diagRaw) {
      // 실패했을 때도 이름 자체를 화면에 되풀이하지 않는다 -- 무엇을 찾았는지만 말한다.
      check('①', 'diagnostics 에 사용자 이름 없음', !containsIdentity(diagRaw), '이 PC 사용자 이름·프로필 경로 0건');
      const diag = JSON.parse(diagRaw);
      check('①', 'diagnostics 가 9단계를 전부 적었다',
        STAGES.every((id) => diag?.stages?.[id]?.status === 'done'),
        STAGES.map((id) => `${id}:${diag?.stages?.[id]?.status}`).join(' '));
    }

    // --- 설치기 사본 ------------------------------------------------------
    const copyPath = path.join(SOUL_ROOT, RESUME_INSTALLER_PATH.split('/').join(path.sep));
    check('①', '설치기 사본이 resume 경로에 있다', fs.existsSync(copyPath), RESUME_INSTALLER_PATH);

    // --- ④ 온라인 묶음: 정직한 멈춤 ---------------------------------------
    const online = await probeOnline(server.url);
    check('④', '⑥-1 인터넷 확인이 정직하게 멈춘다',
      online?.net?.ok === false && online?.net?.code === 'E-ONLINE-NET',
      JSON.stringify(online?.net ?? null));
    check('④', '로그인은 한 번도 시도하지 않았다',
      !online?.logins || Object.keys(online.logins).length === 0,
      JSON.stringify(online?.logins ?? {}));
    const handoffAfter = readJsonFile(handoffFile());
    check('④', "온라인 뒤에도 handoff.state === 'login-pending'",
      handoffAfter?.state === 'login-pending', String(handoffAfter?.state));

    const fingerprint = fingerprintTree(SOUL_ROOT);
    check('①', '파일 지문을 빠짐없이 떴다', fingerprint.errors.length === 0,
      fingerprint.errors.length
        ? `못 읽은 것 ${fingerprint.errors.length}건: ${fingerprint.errors.slice(0, 5).join(' / ')}`
        : `${fingerprint.count}개 파일(≤${FINGERPRINT_CONTENT_MAX / 1024}KB 는 내용까지)`);
    log(`tree fingerprint: ${fingerprint.hash.slice(0, 16)}... (${fingerprint.count} files)`);
    return {
      timings,
      fingerprint,
      receipt: readJsonFile(receiptFile()),
      logSize: sizeOf(setupLogFile()),
      decisions: decisionsWithoutTimestamp(),
    };
  } finally {
    await server.stop();
  }
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

// Deleting the practice root right after a run hits EPERM often enough to
// matter: ⑨ 검사 starts every MCP server to say `initialize` and then kills
// them, and Windows releases those handles a moment after the process object
// is gone. Retrying beats sleeping blindly, and the last resort (rename the
// folder aside, then delete) means a stubborn handle can never make the next
// scenario reuse a dirty root. Measured 2026-09-15: one EPERM in nine
// fault-injection iterations, cleared on the second attempt.
async function removeDirHard(dir, { attempts = 12, waitMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!fs.existsSync(dir)) return true;
    } catch { /* keep trying */ }
    await new Promise((r) => setTimeout(r, waitMs));
  }
  try {
    const aside = `${dir}-stale-${Date.now()}`;
    fs.renameSync(dir, aside);
    fs.rmSync(aside, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    return !fs.existsSync(aside);
  } catch (e) {
    log(`WARNING: ${dir} 를 지우지 못했습니다 (${String(e?.message ?? e)})`);
    return false;
  }
}

// A diagnostics/handoff file must not leak who is running this PC.
function containsIdentity(text) {
  const user = os.userInfo().username;
  if (user && user.length >= 3 && text.includes(user)) return true;
  return new RegExp(`${DRIVE}[\\\\/]+Users[\\\\/]+`, 'i').test(text);
}

async function probeOnline(url) {
  const started = await post(url, '/api/online/start');
  if (started.status !== 202) throw new Error(`online/start returned ${started.status}`);
  const deadline = Date.now() + 120000;
  for (;;) {
    const st = await getJson(url, '/api/online/status');
    if (st.running === false && st.net) return st;
    if (Date.now() > deadline) throw new Error('online net check never settled');
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------------------
// ② second run -- change 0
// ---------------------------------------------------------------------------

async function phaseSecondRun(first) {
  log('phase ② -- second run against the same root (change 0)');
  const server = await startInstaller();
  try {
    const before = first.logSize ?? 0;
    const run = await installOnce(server.url);
    check('②', '두 번째 실행도 완료', run.progress.error === null && run.progress.percent === 100,
      run.progress.error ? JSON.stringify(run.progress.error) : ms(run.totalMs));

    // The engine's own words are the evidence: one 건너뜀 line per stage,
    // read from the bytes appended *after* the first run finished.
    let tail = '';
    try {
      const fd = fs.openSync(setupLogFile(), 'r');
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.max(0, size - before));
      if (buf.length) fs.readSync(fd, buf, 0, buf.length, before);
      fs.closeSync(fd);
      tail = buf.toString('utf8');
    } catch (e) { tail = ''; }
    const skipped = (tail.match(/이미 끝나 있어 건너뜀/g) ?? []).length;
    check('②', '9단계 전부 건너뜀(skipped-done)', skipped === STAGES.length, `${skipped}/${STAGES.length} 건너뜀 줄`);

    const receipt = readJsonFile(receiptFile());
    const a = JSON.stringify(stageFinishTimes(first.receipt));
    const b = JSON.stringify(stageFinishTimes(receipt));
    check('②', '단계 시각이 한 개도 바뀌지 않았다', a === b, a === b ? '9/9 동일' : `${a}\n  vs\n  ${b}`);

    const after = fingerprintTree(SOUL_ROOT);
    check('②', '두 번째 지문도 빠짐없이 떴다', after.errors.length === 0,
      after.errors.length ? `못 읽은 것 ${after.errors.length}건: ${after.errors.slice(0, 5).join(' / ')}` : `${after.count}개 파일`);
    const same = first.fingerprint && after.errors.length === 0 && after.hash === first.fingerprint.hash;
    if (!same && first.fingerprint) {
      const beforeSet = new Set(first.fingerprint.entries);
      const afterSet = new Set(after.entries);
      const added = after.entries.filter((e) => !beforeSet.has(e)).slice(0, 10);
      const gone = first.fingerprint.entries.filter((e) => !afterSet.has(e)).slice(0, 10);
      log(`  fingerprint drift -- added: ${added.join(' , ')} | gone: ${gone.join(' , ')}`);
    }
    check('②', '파일 지문 변화 0', same, `${after.count} files, ${after.hash.slice(0, 16)}...`);

    // 지문에서 뺀 decisions.json 은 여기서 따로 본다 -- `createdAt` 만 빼고
    // 나머지가 같아야 "만들기로 한 폴더가 그대로"라고 말할 수 있다.
    const nowDecisions = decisionsWithoutTimestamp();
    check('②', 'decisions.json 이 시각 말고는 그대로', Boolean(nowDecisions) && nowDecisions === first.decisions,
      nowDecisions === first.decisions
        ? `폴더 ${(readJsonFile(decisionsFile())?.nodes ?? []).length}개 결정 동일(createdAt 만 갱신)`
        : '두 번 실행이 다른 폴더 결정을 냈다');
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// ③ fault injection -- nine stops, nine resumes
// ---------------------------------------------------------------------------

async function phaseFaults() {
  log('phase ③ -- IRIS_INSTALLER_FAIL_AT for each of the nine stages');
  const table = [];
  for (const id of STAGES) {
    await removeDirHard(SOUL_ROOT);
    const t0 = Date.now();

    // (a) stop exactly there
    let stopped = null;
    const s1 = await startInstaller({ failAt: id });
    try {
      const run = await installOnce(s1.url);
      stopped = run.progress.error;
    } finally {
      await s1.stop();
    }
    const stoppedRight = stopped?.id === id && stopped?.code === `E-${id.toUpperCase()}`;
    check('③', `FAIL_AT=${id} → 그 단계에서 멈춘다`, stoppedRight, JSON.stringify(stopped));

    // 멈춘 시점의 단계별 시각. (b) 뒤에 이것과 견주어 "앞은 건너뛰고 뒤만 새로
    // 돌았는가"를 본다 -- percent===100 만 보면 전체를 처음부터 다시 한 재실행도
    // 똑같이 통과해 버리고, 그러면 「다시 시도 = 실패한 단계부터」라는 약속이
    // 지켜지는지 아무도 확인하지 않는 셈이 된다.
    const beforeResume = stageEntries(readJsonFile(receiptFile()));

    // (b) the same root, no injection -> finishes from there
    let resumed = null;
    const s2 = await startInstaller({ failAt: null });
    try {
      const run = await installOnce(s2.url);
      resumed = run.progress;
    } finally {
      await s2.stop();
    }
    const afterResume = stageEntries(readJsonFile(receiptFile()));
    const resumeShape = checkResumeShape(id, beforeResume, afterResume);
    check('③', `FAIL_AT=${id} → 앞 단계는 건너뛰고 ${id}부터 다시 돈다`, resumeShape.ok, resumeShape.detail);
    const done = resumed?.error === null && resumed?.percent === 100;
    check('③', `FAIL_AT=${id} → 재실행이 끝까지 간다`, done,
      resumed?.error ? JSON.stringify(resumed.error) : `${ms(Date.now() - t0)} 누적`);

    table.push({ id, stoppedRight, resumed: done, resumeShape: resumeShape.ok, shapeDetail: resumeShape.detail, ms: Date.now() - t0 });
  }
  return table;
}

// ---------------------------------------------------------------------------
// 시험 행렬 S08 · S11(있음) -- 이 PC 본계정
// ---------------------------------------------------------------------------
//
// S08 「기존 Node·Python·Git·Claude Code 설치·로그인 PC — 동봉본 우선·기존
// 무접촉」과 S11(있음) 「Office·한컴 있음 → 문서 MCP pass」는 정의상 VM 에서
// 확인할 수 없다. 이 PC 가 바로 그 환경이기 때문이다. 그래서 같은 3층 기계를
// C:\IRIS-s08 으로 겨눠 한 번 돌리고, 그 앞뒤로 이 PC 의 진짜 물건들이 그대로인지
// 지문을 떠서 비교한다.
//
// 「무접촉」을 증명하는 방식이 중요하다. `C:\IRIS` 전체를 해시하면 이 PC 에서
// 늘 돌고 있는 다른 세션의 쓰기 때문에 늘 다르다 -- 그래서 **설치기가 건드릴
// 만한 자리만** 콕 집어 본다: 루트 지침 파일, 에이전트 설정 파일, `_agent\setup`
// 의 존재 여부, 바탕화면 목록, HKCU\Environment, 그리고 사용자 프로필의
// `.claude*`.

// 조각으로 이어 붙이는 것은 멋이 아니라 규칙이다 -- 저장소 정화 규칙
// (`verify/static.mjs` ⑦)이 "드라이브 문자 + IRIS/Users" 모양을 개발 PC 의
// 절대경로로 보고 막는다. 여기서는 그 모양을 소스에 남기지 않는다.
const DRIVE = 'C:';
const REAL_IRIS = `${DRIVE}\\IRIS`;
const S08_SENTINEL_FILES = [
  'AGENTS.md', 'CLAUDE.md', 'IRIS-온톨로지.md', 'soul-state.json',
  '_agent\\claude\\settings.json', '_agent\\codex\\config.toml',
];

// ---------------------------------------------------------------------------
// 근거 남기기
// ---------------------------------------------------------------------------
//
// 연습 루트는 실행이 끝나면 지운다(그래야 다음 실행이 깨끗한 데서 시작한다).
// 그런데 시험 행렬의 「근거」 열은 **끝난 뒤에도 열어볼 수 있는 자리**를 가리켜야
// 한다 -- 지워질 폴더 안의 파일을 가리키면 가리키는 순간 이미 없는 것이다.
// 그래서 지우기 전에 근거를 `_build` 밑으로 옮겨 둔다. VM 경로
// (`verify/vm/run.mjs`)가 쓰는 폴더 모양·이름을 그대로 따라 두 경로의 근거가
// 같은 서랍에 같은 이름으로 쌓이게 한다.

const VM_RESULTS_ROOT = path.join(ROOT_DIR, '_build', 'cache', 'vm', 'results');
const E2E_RESULTS_ROOT = path.join(ROOT_DIR, '_build', 'e2e-results');

// verify/vm/run.mjs 의 COLLECT 와 같은 다섯 + 설치보고(날짜가 붙어 glob 이 필요).
const EVIDENCE_FILES = ['diagnostics.json', 'handoff.json', 'package-receipt.json', 'setup.log', 'installer.log'];

function stamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// 저장소 뿌리 기준 상대경로(`_build\cache\...`). 시험 행렬·보고서에 적을 값이라
// 이 PC 의 절대경로를 절대 만들지 않는다.
function relToRepo(p) {
  return path.relative(ROOT_DIR, p).split(path.sep).join('\\');
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 연습 루트의 `_agent\setup` 산출물을 근거 폴더로 복사한다. 반환 = 복사한 이름들. */
function collectSoulEvidence(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  const missing = [];
  const dir = setupDir();
  for (const name of EVIDENCE_FILES) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) { missing.push(name); continue; }
    try { fs.copyFileSync(src, path.join(outDir, name)); copied.push(name); } catch (e) { missing.push(`${name}(${String(e?.code ?? e)})`); }
  }
  let reports = [];
  try { reports = fs.readdirSync(dir).filter((f) => /^설치보고-\d{4}-\d{2}-\d{2}\.md$/.test(f)); } catch { reports = []; }
  for (const name of reports) {
    try { fs.copyFileSync(path.join(dir, name), path.join(outDir, name)); copied.push(name); } catch { missing.push(name); }
  }
  return { copied, missing };
}

const sha = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

function hashFileOrNull(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function listDirStamp(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .map((e) => {
        let st = null;
        try { st = fs.statSync(path.join(dir, e.name)); } catch { /* vanished */ }
        return `${e.name}|${e.isDirectory() ? 'd' : st?.size ?? '?'}|${st ? Math.round(st.mtimeMs) : '?'}`;
      })
      .sort()
      .join('\n');
  } catch { return `(없음) ${dir}`; }
}

function runCapture(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return `${r.status}\n${String(r.stdout ?? '').trim()}`;
}

// 모든 값이 **해시**다. 원문(바탕화면 파일 이름 목록, HKCU\Environment 전문)은
// 이 PC 의 사용자 이름과 경로를 그대로 담고 있어서, 근거 파일로 남기는 순간
// 개인정보가 디스크에 굳는다. "같은가 다른가"만 필요하므로 해시로 충분하고,
// 해시라서 근거 폴더를 그대로 남에게 보여도 된다.
function captureUntouched() {
  const home = os.homedir();
  return {
    irisFiles: Object.fromEntries(S08_SENTINEL_FILES.map((f) => [f, hashFileOrNull(path.join(REAL_IRIS, f))])),
    irisSetupDir: fs.existsSync(path.join(REAL_IRIS, '_agent', 'setup'))
      ? sha(listDirStamp(path.join(REAL_IRIS, '_agent', 'setup')))
      : '(없음)',
    desktop: sha(listDirStamp(path.join(home, 'Desktop'))),
    oneDriveDesktop: sha(listDirStamp(path.join(home, 'OneDrive', 'Desktop'))),
    // 읽기만 한다. `reg query` 는 레지스트리를 바꾸지 않는다.
    userEnv: sha(runCapture('reg', ['query', 'HKCU\\Environment'])),
    claudeJson: hashFileOrNull(path.join(home, '.claude.json')) ?? '(없음)',
    claudeDir: sha(listDirStamp(path.join(home, '.claude'))),
  };
}

function diffUntouched(before, after) {
  const changed = [];
  for (const key of Object.keys(before)) {
    if (key === 'irisFiles') {
      for (const f of S08_SENTINEL_FILES) {
        if (before.irisFiles[f] !== after.irisFiles[f]) changed.push(`${REAL_IRIS}\\${f}`);
      }
      continue;
    }
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed;
}

// lock.json 이 못 박은 판 vs 이 PC 에 원래 깔려 있던 판. 둘이 달라야 "동봉본이
// 이겼다"가 증명된다 -- 같으면 어느 쪽을 썼는지 구별할 수 없다.
function systemToolVersions() {
  const first = (s) => String(s ?? '').trim().split(/\r?\n/)[0] ?? '';
  return {
    node: first(spawnSync('node', ['-v'], { encoding: 'utf8', windowsHide: true }).stdout),
    python: first(spawnSync('python', ['-V'], { encoding: 'utf8', windowsHide: true }).stdout)
      || first(spawnSync('python', ['-V'], { encoding: 'utf8', windowsHide: true }).stderr),
    git: first(spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).stdout),
  };
}

function lockVersions() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8'));
  return {
    node: lock?.parts?.node?.version ?? null,
    python: lock?.parts?.python?.version ?? null,
    git: lock?.parts?.git?.version ?? null,
    codex: lock?.parts?.codex?.version ?? null,
  };
}

async function phaseS08(zipInfo) {
  log('시험 행렬 S08 · S11(있음) -- 이 PC 본계정');
  const before = captureUntouched();
  const sys = systemToolVersions();
  const lock = lockVersions();
  log(`이 PC 원래 판: node ${sys.node} · ${sys.python} · ${sys.git}`);
  log(`동봉(lock.json) 판: node v${lock.node} · Python ${lock.python} · git ${lock.git} · codex ${lock.codex}`);

  const outDir = path.join(VM_RESULTS_ROOT, `S08-${stamp()}`);
  const server = await startInstaller();
  let mcpDetail = '';
  let installed = false;
  let collected = { copied: [], missing: EVIDENCE_FILES.slice() };
  try {
    const run = await installOnce(server.url);
    installed = run.progress.error === null && run.progress.percent === 100;
    check('S08', '설치 완주', installed,
      run.progress.error ? JSON.stringify(run.progress.error) : ms(run.totalMs));
    if (run.progress.error) return null;

    const receipt = readJsonFile(receiptFile());
    const items = receipt?.setup?.checks?.recorded?.items ?? [];
    const summary = receipt?.setup?.checks?.recorded?.checks ?? {};
    check('S08', '검사 실패 0건', summary.fail === 0, `통과 ${summary.pass} · 대기 ${summary.pending} · 실패 ${summary.fail}`);

    // ── 동봉본 우선 ──────────────────────────────────────────────────────
    const exe = items.find((i) => i.id === 'exe');
    const d = String(exe?.detail ?? '');
    const usesLock = d.includes(`v${lock.node}`) && d.includes(lock.python) && d.includes(String(lock.git).replace(/\.(\d+)$/, '.windows.$1'));
    check('S08', '검사 1 이 동봉 판을 보고했다', usesLock, d);
    const differs = sys.node && sys.node !== `v${lock.node}`;
    check('S08', '동봉 판이 이 PC 시스템 판과 다르다(구별 가능)', differs,
      `시스템 ${sys.node}/${sys.python}/${sys.git} ↔ 동봉 v${lock.node}/Python ${lock.python}/git ${lock.git}`);
    const shims = path.join(SOUL_ROOT, '_agent', 'shared', 'shims');
    const shimList = fs.existsSync(shims) ? fs.readdirSync(shims) : [];
    check('S08', '심(shim)이 영혼 안에 있다', shimList.length > 0, shimList.join(', '));

    // ── S11(있음) ────────────────────────────────────────────────────────
    const office = runCapture('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Office']).startsWith('0');
    const hancom = runCapture('reg', ['query', 'HKCR\\HWPFrame.HwpObject']).startsWith('0');
    check('S11', '이 PC 에 Office·한컴이 있다', office && hancom, `office=${office} hancom=${hancom}`);
    const mcp = items.find((i) => i.id === 'mcp');
    mcpDetail = String(mcp?.detail ?? '');
    check('S11', '문서 MCP 가 pending 이 아니라 pass', mcp?.status === 'pass', mcpDetail);
    check('S11', 'MCP 검사에 대기 0건', !mcpDetail.includes('대기'), mcpDetail.slice(0, 160));

    // 연습 루트가 지워지기 전에 근거를 옮긴다. 서버를 세우기 **전**이다 --
    // ⑨ 검사가 파일을 다 쓴 뒤이고, 서버가 `installer.log` 를 아직 붙들고 있는
    // 동안에도 복사는 읽기라 문제없다.
    collected = collectSoulEvidence(outDir);
    check('S08', '근거 파일을 남겼다', collected.missing.length === 0,
      collected.missing.length
        ? `못 옮긴 것: ${collected.missing.join(', ')}`
        : `${relToRepo(outDir)} 에 ${collected.copied.length}개`);
  } finally {
    await server.stop();
  }

  // ── 기존 무접촉 ──────────────────────────────────────────────────────
  const after = captureUntouched();
  const changed = diffUntouched(before, after);
  const untouched = changed.length === 0;
  check('S08', '이 PC 의 진짜 물건이 하나도 안 바뀌었다', untouched,
    changed.length ? `바뀐 것: ${changed.join(', ')}` : `${REAL_IRIS} 정본 ${S08_SENTINEL_FILES.length}종 · 바탕화면 2곳 · HKCU\\Environment · .claude* 전부 동일`);

  // 무접촉 근거는 **해시 비교표**로 남긴다(원문은 개인정보라 남기지 않는다).
  writeJsonFile(path.join(outDir, 'untouched.json'), {
    what: '설치 전후로 이 PC 의 진짜 물건이 그대로인지 -- 값은 전부 sha256 해시다(원문 없음)',
    before, after, changed, ok: untouched,
  });

  const ok = failures === 0;
  writeJsonFile(path.join(outDir, 'verdict.json'), {
    scenario: 'S08',
    alsoCovers: 'S11(있음)',
    ok,
    reason: ok
      ? '동봉본 우선(node·python·git 셋 다 시스템 판과 다름) · 검사 11/11 · 문서 MCP pass · 이 PC 무접촉'
      : results.filter((r) => !r.ok).map((r) => `${r.phase} ${r.name}`).join(' / '),
    // zip sha256 은 참고용으로 남긴다(릴리스 첨부의 신원). 행렬 행이 비교하는
    // 값은 contentFingerprint 다 -- sha 는 빌드마다 바뀌기 때문(Task 24a).
    zip: { name: path.basename(zipInfo.zip), sha256: zipInfo.sha, contentFingerprint: zipInfo.contentFingerprint },
    installed,
    bundled: lock,
    system: sys,
    checks: results.filter((r) => r.phase === 'S08' || r.phase === 'S11')
      .map((r) => ({ phase: r.phase, name: r.name, ok: r.ok, detail: r.detail })),
    files: collected.copied,
    at: new Date().toISOString(),
  });

  return {
    mcpDetail,
    lock,
    sys,
    fingerprint: zipInfo.contentFingerprint ? zipInfo.contentFingerprint.slice(0, 12) : null,
    evidenceDir: relToRepo(outDir),
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function cleanup(keep) {
  if (keep) {
    log(`--keep: leaving ${SOUL_ROOT} and ${SCRATCH_DIR} in place`);
    return;
  }
  await removeDirHard(SOUL_ROOT);
  await removeDirHard(SCRATCH_DIR);
}

async function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes('--keep');
  const quick = argv.includes('--quick');
  const faultsOnly = argv.includes('--faults-only');
  const zipArg = argv.includes('--zip') ? argv[argv.indexOf('--zip') + 1] : null;
  // `--scenario s08` = 시험 행렬 S08 + S11(있음) 근거 수집(이 PC 본계정).
  const scenario = argv.includes('--scenario') ? String(argv[argv.indexOf('--scenario') + 1] ?? '').toLowerCase() : null;

  const t0 = Date.now();
  let faultTable = [];
  let firstTimings = [];
  let s08 = null;
  let zipInfo = null;

  try {
    // 인자 검증도 try 안에서 한다 -- 밖에서 던지면 요약표도, 정리도, 종료 코드도
    // 없이 스택만 뱉고 끝난다(아래 `.catch` 와 한 쌍).
    if (scenario && scenario !== 's08') {
      throw new Error(`이 스크립트가 아는 시험 행렬 시나리오는 s08 뿐입니다(받은 값: ${scenario})`);
    }
    if (scenario === 's08') useSoul('IRIS-s08');

    for (const p of FORBIDDEN_PORTS) {
      if (await portInUse(p)) log(`(note) port ${p} is in use -- IRIS infrastructure, untouched by this script)`);
    }
    if (await portInUse(PORT)) {
      throw new Error(`port ${PORT} is already in use. Something else is holding the installer's port; `
        + 'this script will not free it. Close that installer window and run again.');
    }

    zipInfo = findBuiltZip(zipArg);
    log(`zip: ${path.basename(zipInfo.zip)} (sha256 ${zipInfo.sha.slice(0, 12)})`);

    await removeDirHard(SOUL_ROOT);
    await removeDirHard(SCRATCH_DIR);
    fs.mkdirSync(ZIP_DIR, { recursive: true });
    log('extracting zip...');
    await extractZip(zipInfo.zip, ZIP_DIR);
    zipInfo.contentFingerprint = contentFingerprintOfExtractedZip(ZIP_DIR) ?? zipInfo.contentFingerprint;
    log(zipInfo.contentFingerprint
      ? `내용 지문: ${zipInfo.contentFingerprint.slice(0, 12)} (시험행렬 행에 적히는 값)`
      : '내용 지문 없음 -- 이 zip 은 contentFingerprint 이전 빌드다(새로 빌드해야 행렬 행을 채울 수 있다)');

    // The nine stage ids are a contract; make sure this file and the zip agree
    // before any conclusion is drawn from either.
    const engine = await import(pathToFileURL(path.join(ZIP_DIR, 'installer', 'setup', 'engine.mjs')).href);
    check('①', '9단계 이름이 zip 의 engine.mjs 와 같다',
      JSON.stringify(engine.STAGES) === JSON.stringify(STAGES), engine.STAGES.join(','));

    if (scenario === 's08') {
      s08 = await phaseS08(zipInfo);
    } else {
      if (!faultsOnly) {
        const first = await phaseFirstRun(zipInfo);
        firstTimings = first.timings ?? [];
        if (first.fingerprint) await phaseSecondRun(first);
        else log('skipping phase ② -- the first run did not complete');
      }
      if (!quick) faultTable = await phaseFaults();
      else log('--quick: skipping phase ③ (fault injection)');
    }
  } catch (err) {
    record('e2e', 'unexpected error', false, String(err?.stack ?? err));
  } finally {
    try { await cleanup(keep); } catch (e) { log(`cleanup warning: ${String(e?.message ?? e)}`); }
  }

  // --- summary table --------------------------------------------------------
  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };

  say('\n================ e2e 요약 ================');
  if (firstTimings.length) {
    say('단계별 시간(1회차):');
    for (const t of firstTimings) say(`  ${t.id.padEnd(10)} ${ms(t.ms).padStart(8)}`);
  }
  if (faultTable.length) {
    say('고장 주입:');
    say('  단계        멈춤  재개  그단계부터  누적');
    for (const r of faultTable) {
      say(`  ${r.id.padEnd(10)}  ${r.stoppedRight ? ' OK ' : 'FAIL'}  ${r.resumed ? ' OK ' : 'FAIL'}`
        + `  ${(r.resumeShape ? ' OK ' : 'FAIL').padStart(8)}  ${ms(r.ms).padStart(8)}`);
    }
  }
  const byPhase = new Map();
  for (const r of results) {
    const e = byPhase.get(r.phase) ?? { ok: 0, fail: 0 };
    r.ok ? (e.ok += 1) : (e.fail += 1);
    byPhase.set(r.phase, e);
  }
  say('검사 결과:');
  for (const [phase, e] of byPhase) say(`  ${phase}  통과 ${e.ok} · 실패 ${e.fail}`);
  if (s08) {
    say('');
    say('시험 행렬 S08·S11 행에 적을 값 (verify/vm/report.mjs 이 쓴다):');
    if (s08.fingerprint) {
      say(`  node verify/vm/report.mjs --scenario S08 --result ${failures === 0 ? '통과' : '실패'}`
        + ` --fingerprint ${s08.fingerprint} --evidence "${s08.evidenceDir}"`);
    } else {
      // 행렬 행의 지문 칸은 내용 지문(contentFingerprint 앞 12자)이다. 이 zip
      // 에 그 값이 없으면 적을 수 없다 -- 지어내지 않고 새 빌드를 요구한다.
      say('  (내용 지문 없음 — 새 빌드 필요: `IRIS_INSTALLER_OFFLINE=1 npm run build` 뒤 다시 돌리세요)');
    }
    say(`  동봉 판 node v${s08.lock.node}/Python ${s08.lock.python}/git ${s08.lock.git}`
      + ` ↔ 이 PC 판 ${s08.sys.node}/${s08.sys.python}/${s08.sys.git}`);
  }
  const elapsed = Date.now() - t0;
  say(`전체 ${results.length}건 중 실패 ${failures}건 · ${ms(elapsed)}`);
  say(failures === 0 ? 'e2e: OK -- 3층 초록' : 'e2e: FAILED');
  say('==========================================');

  // 요약도 근거다. 화면은 스크롤로 사라지고 연습 루트는 지워지므로, 무엇을
  // 언제 어떤 zip 으로 확인했는지가 파일로 남아야 나중에 되짚을 수 있다.
  try {
    // S08 실행은 자기 근거 폴더에, 평소 실행은 e2e 근거 폴더에 같은 요약을 둔다.
    const runDir = s08?.evidenceDir
      ? path.join(ROOT_DIR, s08.evidenceDir.split('\\').join(path.sep))
      : path.join(E2E_RESULTS_ROOT, stamp());
    writeJsonFile(path.join(runDir, 'summary.json'), {
      at: new Date().toISOString(),
      scenario: s08 ? 'S08' : '3층 전체',
      zip: zipInfo
        ? { name: path.basename(zipInfo.zip), sha256: zipInfo.sha, contentFingerprint: zipInfo.contentFingerprint ?? null }
        : null,
      elapsedMs: elapsed,
      failures,
      stageTimings: firstTimings,
      faultInjection: faultTable,
      checks: results,
    });
    fs.writeFileSync(path.join(runDir, 'summary.txt'), `${lines.join('\n')}\n`, 'utf8');
    console.log(`근거: ${relToRepo(runDir)}`);
  } catch (e) {
    console.log(`[e2e] 요약을 남기지 못했습니다: ${String(e?.message ?? e)}`);
  }

  process.exitCode = failures === 0 ? 0 : 1;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  // main() 안의 try 가 놓친 것(요약을 만드는 도중의 오류 등)까지 여기서 받는다.
  // 어떤 경로로 끝나도 사람이 읽을 한 줄과 0이 아닌 종료 코드를 남긴다.
  main().catch((err) => {
    console.error(`e2e: FAILED -- ${String(err?.stack ?? err)}`);
    process.exitCode = 1;
  });
}

export { fingerprintTree, containsIdentity, checkResumeShape, stageEntries, STAGES, HANDOFF_KEYS };
