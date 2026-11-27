// verify/upgrade.mjs -- 업그레이드 게이트 (2.0.31, 2026-09-20)
//
// 배경: 2.0.29 「업데이트」가 teamclaude 폴더를 새로 놓으면서 그 안의 낱개 파일 부품
// (teamclaude-manage.ps1)을 건너뛰어 중계기가 켜지지 않았다. 새 판을 처음부터 설치하는
// 시험(verify/e2e.mjs)은 통과했다 -- 깨진 것은 "옛 판 위에 새 판을 얹는" 길이었고, 그 길을
// 자동으로 밟는 시험이 없었다. 이 스크립트는 그 길을 매 판 밟는다:
//
//   ① 옛 판 설치   직전 판 zip(기본 = _build/out-<판>/ 가운데 새 판보다 낮은 최고 판)의
//                 installer/server.mjs 를 실제 자식 프로세스로 띄워 연습용 루트(C:\IRIS-upg)에
//                 오프라인 설치(precheck→…→setup 9단계). verify/e2e.mjs 와 같은 방식.
//   ② 새 판 업데이트 새 판 zip 의 server.mjs 를 `--auto` 로 같은 루트에 띄운다 -- 실제 업데이트기
//                 (IRIS-설치.cmd --auto)가 밟는 길 그대로. 자가 시작 → 부품 교체 → 영수증 판 갱신 → 종료.
//   ③ 판정        ⓐ autoResult.ok  ⓑ 영수증 package.version = 새 판, 9단계 전부 done, 오류 없음
//                 ⓒ 새 판 잠금표의 **모든 부품이 제자리에 있다**(낱개 파일 = 그 파일, 폴더 = 비어 있지 않음,
//                    slot 이 좁혀진 부품은 그 slot) -- 2.0.29 사고를 잡는 검사
//                 ⓓ 옛↔새 잠금표에서 지문·판이 바뀐 부품은 업데이트 시작 시각 뒤에 다시 놓였다
//                 ⓔ 실행 파일 문법: teamclaude-manage.ps1 (PowerShell 파서), 창·대시보드·중계기의 진입 .mjs/.js (node --check)
//                 ⓕ 인수 문서 state 가 업데이트 전과 같다(setup-incomplete 로 굴러떨어지지 않음)
//                 ⓖ 사용자 자료(연습용으로 심은 파일)가 그대로다
//                 ⓚ 업데이트 전 코덱스 대화(연결 이름 openai)가 업데이트 뒤 IRIS 창의 재개 호환으로 지금 연결 이름에 맞춰진다(2.0.54)
//                 ⓛ 업데이트 전에 깔려 있던 선택 모듈(메신저 등)이 새 판 잠금표에 없어도 한 바이트도 달라지지 않는다 — 판·공식 표시·
//                    로그인 state(2.0.64, 메신저를 설치 패키지에서 뺀 판부터. 옛 판이 메신저를 동봉한 2.0.63 이하에서 올 때 실제로 잰다)
//                 ⓜ IRIS Doctor(새 판이 2.0.66 이상이면 잠금표에 그 부품이 **반드시** 있어야 한다 — 없으면 실패): 부품이 제자리에 있고 지문 목록과 한 바이트도 다르지 않다 ·
//                    옛 판에 없던 부품이면 `.prev` 가 없다 · 동봉 node 로 통신 없이 뜬다(자체 확인 · 판 출력 — 모델 호출 0) ·
//                    연습 실행이므로 바로가기는 "만들지 않았음"으로 기록돼 있다 · 설치기가 Doctor 의 집을 만들지 않았다
//
// 안전 규칙(verify/e2e.mjs 와 같다): 저장소 밖에 쓰는 곳은 C:\IRIS-upg 하나뿐이며 finally 에서 지운다.
// 진짜 C:\IRIS·바탕화면·HKCU\Environment·사용자 프로필은 건드리지 않는다(IRIS_INSTALLER_NO_USER_ENV=1 +
// %LOCALAPPDATA% 우회). 프로세스는 이 스크립트가 spawn 한 PID 만 PID 로 끝낸다(이름 기반 종료 없음).
// 3460 이 이미 쓰이고 있으면 비우지 않고 중단한다. 3456/3457/3458 은 절대 손대지 않는다 -- 그래서
// 업데이트 뒤 IRIS 창 되살리기는 IRIS_INSTALLER_NO_FACE_RELAUNCH=1 로 끄고, 오프라인 설치라 온라인
// 묶음(계정 연결)이 없으므로 중계기 재측정도 돌지 않는다. 모델 호출 0.
//
// Usage:
//   node verify/upgrade.mjs                       last-build zip 을 새 판으로, 직전 판은 자동
//   node verify/upgrade.mjs --from <옛 zip> --zip <새 zip>
//   node verify/upgrade.mjs --expect-fail         (회귀 증명용) 판정이 실패해야 종료 코드 0
//   node verify/upgrade.mjs --keep                연습용 루트와 _build/upgrade 를 남긴다
//   node verify/upgrade.mjs --via-applier         ② 를 **적용기 길**로 밟는다(2.0.67) — 아래
//
// --via-applier (2.0.67): IRIS 안 「업데이트」가 실제로 밟는 길.
//   ② 를 "새 zip 의 server.mjs 를 --auto 로 직접 띄우기" 대신 이렇게 한다:
//     ⓐ 새 zip 을 창이 받아 두는 자리(<연습 루트>\_agent\shared\downloads\update-<시각>\package)에 풀고
//     ⓑ 창이 쓰는 꼴 그대로의 계획(plan.json — 설치 패키지 한 부품)을 그 옆에 쓰고
//     ⓒ **① 이 깐 옛 판의 적용기**(<연습 루트>\_agent\shared\tools\updater\apply.mjs)를 옛 판의 동봉 node 로 띄운다(창이 띄우는 꼴:
//        `apply.mjs --plan <계획>` · 작업 폴더 = 적용기 폴더)
//     ⓓ 적용기가 새 zip 의 `IRIS-설치.cmd --auto` 를 띄우고 → bootstrap.ps1 이 지문을 확인하고 node 를 풀어 → 설치기 서버가 스스로 시작한다
//   그 뒤의 판정(③ⓑ ~ ③ⓜ)은 직접 길과 **같은 코드**이고, 적용기 길에서만 보는 판정(ⓝ)이 더해진다(verify/upgrade-applier.mjs):
//   적용기의 끝 · 결과 파일(update-result.json) · 적용기 기록(update.log) · 계획이 그대로인지 · 「내 것 유지」가 잠겨 있는지.
//   **적용기와 설치기는 고치지 않는다 — 지금 동작을 굳히는 검사다.** 그래서 ⓝ 가운데 「지금 동작」이라고 적힌 것은 고치고 싶은
//   동작도 있는 그대로 적은 것이다(적용기는 설치기를 띄운 직후 ok:true 를 쓰고, 설치기는 그 파일을 다시 쓰지 않는다).
//   안전: 계획의 데몬 번호 · 포트는 이미 끝난 것 · 닫힌 것을 넣고 relaunch 는 false 다(넘기기가 실패해도 연습 루트의 IRIS 창을
//   띄우지 않게). 시작 파일은 브라우저를 열므로, **받아 둔 사본**의 bootstrap.ps1 에서 그 한 줄만 끈다(zip · 원본 무변경).
//   적용기가 띄운 프로세스들은 이 스크립트의 직계 자식이 아니다 — 끝낼 때는 스스로 끝나기를 기다리고, 남았으면
//   "연습용 상태 폴더의 node 로 뜬 그 번호"임을 실행 파일 경로로 확인한 것만 번호로 끝낸다(이름 기반 종료 없음).
//   상태 폴더(%LOCALAPPDATA% 대역): 이 길에서는 저장소 경로가 ASCII 가 아니면 <시스템 임시 폴더>\iris-upgrade-gate-state 를 쓴다 —
//   진짜 시작 파일이 거기에 tar.exe 로 node 를 푸는데 tar.exe 는 ANSI 코드 페이지 밖 글자가 든 경로에 들어가지 못한다. 직접 길은 그대로다.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { extractZip } from '../lib/zip.mjs';
import { driveInstall, getJson } from './offline.mjs';
import { doctorBundleProblems, doctorPartRequired, DOCTOR_PART_ID, DOCTOR_FIRST_PACKAGE_VERSION } from './doctor-bundle.mjs';
import {
  PACKAGE_DIR, NO_BROWSER_ENV, stagingDir, buildPlan, writePlan, applierCommand, shimBootstrapNoBrowser, startedCmdPid, applierStateDir,
  judgeHandoff, describeHandoffMoment, judgeApplierLog, judgeAfterInstaller, judgeKeepFilesLocked,
} from './upgrade-applier.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAST_BUILD_JSON = path.join(ROOT_DIR, '_build', 'out', 'last-build.json');
const SCRATCH_DIR = path.join(ROOT_DIR, '_build', 'upgrade');
const ZIP_PREV = path.join(SCRATCH_DIR, 'zip-prev');
const ZIP_NEXT = path.join(SCRATCH_DIR, 'zip-next');
const RESULT_FILE = path.join(SCRATCH_DIR, 'result.json');
const PORT = 3460;
const SOUL_NAME = 'IRIS-upg';
const SOUL_ROOT = `C:\\${SOUL_NAME}`;
const STAGES = ['unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks'];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const KEEP = flag('--keep');
const EXPECT_FAIL = flag('--expect-fail');
const VIA_APPLIER = flag('--via-applier');
// %LOCALAPPDATA% 를 대신하는 상태 폴더. 직접 길 = 지금까지처럼 _build\upgrade\state. 적용기 길 = 그 경로가 ASCII 가 아니면
// 시스템 임시 폴더 아래(진짜 시작 파일의 tar.exe 가 그런 경로에 node 를 풀지 못한다 — upgrade-applier.mjs applierStateDir).
const STATE_PICK = VIA_APPLIER ? applierStateDir(SCRATCH_DIR, os.tmpdir()) : { dir: path.join(SCRATCH_DIR, 'state'), moved: false };
const STATE_DIR = STATE_PICK.dir; // stands in for %LOCALAPPDATA%

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  return !!cond;
}
function log(msg) { console.log(`[upgrade ${new Date().toISOString().slice(11, 19)}] ${msg}`); }

// ---------------------------------------------------------------------------
// zips
// ---------------------------------------------------------------------------
function versionOfZip(zip) {
  const m = /IRIS-Setup_v(\d+\.\d+\.\d+)_/.exec(path.basename(zip));
  return m ? m[1] : null;
}
function cmpVer(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
function findNextZip() {
  const explicit = opt('--zip');
  if (explicit) return path.resolve(explicit);
  const lb = JSON.parse(fs.readFileSync(LAST_BUILD_JSON, 'utf8'));
  return lb.zip;
}
function findPrevZip(nextVersion) {
  const explicit = opt('--from');
  if (explicit) return path.resolve(explicit);
  const buildDir = path.join(ROOT_DIR, '_build');
  const candidates = [];
  for (const d of fs.readdirSync(buildDir)) {
    const m = /^out-(\d+\.\d+\.\d+)$/.exec(d);
    if (!m || cmpVer(m[1], nextVersion) >= 0) continue;
    const dir = path.join(buildDir, d);
    const zip = fs.readdirSync(dir).find((f) => /^IRIS-Setup_v.*\.zip$/.test(f));
    if (zip) candidates.push({ version: m[1], zip: path.join(dir, zip) });
  }
  candidates.sort((a, b) => cmpVer(b.version, a.version));
  if (!candidates.length) throw new Error(`no previous release zip under _build/out-<version>/ below ${nextVersion}`);
  return candidates[0].zip;
}

// ---------------------------------------------------------------------------
// process helpers (copied in spirit from verify/e2e.mjs)
// ---------------------------------------------------------------------------
function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '127.0.0.1');
  });
}

function serverEnv(extra = {}) {
  const env = {
    ...process.env,
    IRIS_INSTALLER_SOUL_NAME: SOUL_NAME,
    IRIS_INSTALLER_NO_USER_ENV: '1',
    IRIS_INSTALLER_OFFLINE: '1',
    IRIS_INSTALLER_NO_FACE_RELAUNCH: '1',
    LOCALAPPDATA: STATE_DIR,
    ...extra,
  };
  delete env.IRIS_INSTALLER_FAIL_AT;
  delete env.IRIS_INSTALLER_AUTO;
  delete env.IRIS_INSTALLER_RESUME;
  return env;
}

async function startInstaller(zipDir, { auto = false, freshState = true } = {}) {
  if (freshState) fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const serverPath = path.join(zipDir, 'installer', 'server.mjs');
  if (!fs.existsSync(serverPath)) throw new Error(`extracted zip has no installer/server.mjs at ${serverPath}`);
  const argv = [serverPath, '--zip-root', zipDir, '--port', String(PORT), '--node-dir', path.dirname(process.execPath), '--no-user-env'];
  if (auto) argv.push('--auto');
  const child = spawn(process.execPath, argv, { cwd: zipDir, env: serverEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const url = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 45000;
  for (;;) {
    if (exited) throw new Error(`installer server exited before answering (code ${exited.code}):\n${out.join('')}`);
    try { const h = await (await fetch(`${url}/api/health`)).json(); if (h?.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`installer server did not answer /api/health within 45s:\n${out.join('')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    url,
    pid: child.pid,
    exited: () => exited,
    output: () => out.join(''),
    async stop() {
      if (exited) return;
      try { child.kill(); } catch { /* already gone */ }
      const until = Date.now() + 8000;
      while (!exited && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      if (!exited && child.pid) {
        await new Promise((resolve) => {
          const t = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          t.on('exit', () => resolve()); t.on('error', () => resolve());
        });
      }
      for (let i = 0; i < 40 && await portInUse(PORT); i++) await new Promise((r) => setTimeout(r, 100));
    },
  };
}

/**
 * 2.0.30 이하 zip 은 IRIS_INSTALLER_NO_FACE_RELAUNCH 를 모른다 -- 업데이트 뒤 연습용 루트의 IRIS 창을 진짜로
 * 띄운다(이 PC 의 3458 데몬에 두 번째 창이 붙는다). 회귀 증명(--from <옛 판>)에서만, **풀어 놓은 사본**의
 * lib/handoff.mjs 에 같은 손잡이를 덧대어 막는다. zip 자체는 건드리지 않는다.
 */
function neutralizeRelaunchIfLegacy(zipDir) {
  const server = path.join(zipDir, 'installer', 'server.mjs');
  if (fs.readFileSync(server, 'utf8').includes('IRIS_INSTALLER_NO_FACE_RELAUNCH')) return false;
  const f = path.join(zipDir, 'installer', 'lib', 'handoff.mjs');
  const src = fs.readFileSync(f, 'utf8');
  const anchor = 'export function relaunchFace({';
  if (!src.includes(anchor)) throw new Error(`legacy zip: cannot find relaunchFace in ${f}`);
  const patched = src.replace(anchor,
    "export function relaunchFace(o) { if (process.env.IRIS_INSTALLER_NO_FACE_RELAUNCH === '1') return { ok: false, reason: 'IRIS_INSTALLER_NO_FACE_RELAUNCH=1 (verify/upgrade legacy shim)' }; return relaunchFaceLegacy(o); }\nfunction relaunchFaceLegacy({");
  fs.writeFileSync(f, patched, 'utf8');
  return true;
}

async function removeDirHard(dir, { attempts = 12, waitMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* retry */ }
    if (!fs.existsSync(dir)) return true;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return !fs.existsSync(dir);
}

// ---------------------------------------------------------------------------
// soul-root inspection
// ---------------------------------------------------------------------------
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const receiptFile = () => path.join(SOUL_ROOT, '_agent', 'setup', 'package-receipt.json');
const handoffFile = () => path.join(SOUL_ROOT, '_agent', 'setup', 'handoff.json');
const MARKER = path.join(SOUL_ROOT, 'R01-연습(Practice)', '내-자료-업그레이드-표식.txt');

// ③ⓚ 옛 코덱스 대화(2.0.54) -------------------------------------------------------------------
const CODEX_HOME_UPG = path.join(SOUL_ROOT, '_agent', 'codex');
const OLD_THREAD_ID = '01a00000-2049-7000-8000-0000000c0de0';
function plantOldCodexThread() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const day = path.join(CODEX_HOME_UPG, 'sessions', '2026', '11', '02');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-11-02T10-00-00-${OLD_THREAD_ID}.jsonl`);
  const meta = { timestamp: '2026-11-02T01:00:00.000Z', type: 'session_meta', payload: { id: OLD_THREAD_ID, cwd: SOUL_ROOT, originator: 'codex_cli_rs', cli_version: '0.163.0', source: 'cli', model_provider: 'openai' } };
  const rest = '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"업그레이드 전 대화"}]}}\n';
  fs.writeFileSync(rollout, `${JSON.stringify(meta)}\n${rest}`, 'utf8');
  const db = new DatabaseSync(path.join(CODEX_HOME_UPG, 'state_5.sqlite'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT \'cli\', model_provider TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT \'\', title TEXT NOT NULL DEFAULT \'\')');
    db.prepare('INSERT OR REPLACE INTO threads (id, rollout_path, model_provider, cwd) VALUES (?, ?, ?, ?)').run(OLD_THREAD_ID, rollout, 'openai', SOUL_ROOT);
  } finally { db.close(); }
  return { rollout, rest };
}
function findFile(dir, name, depth = 0) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name && path.basename(path.dirname(p)) === 'daemon') return p;
    if (e.isDirectory() && depth < 4 && e.name !== 'node_modules' && !e.name.endsWith('.prev')) { const r = findFile(p, name, depth + 1); if (r) return r; }
  }
  return null;
}
async function judgeOldCodexThread(planted) {
  const mod = findFile(path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'face'), 'codexcompat.mjs');
  check('③ⓚ 새 판의 IRIS 창에 옛 코덱스 대화 재개 호환 모듈이 있다', !!mod, mod ?? '(없음 — IRIS 창 2.98 미만)');
  if (!mod) return;
  const cc = await import(pathToFileURL(mod).href);
  const cur = cc.currentProvider(CODEX_HOME_UPG);
  check('③ⓚ 업데이트 뒤 코덱스 연결 = 이 PC 중계기', cc.isLocalRelay(cur.baseUrl), `${cur.id} ${cur.baseUrl}`);
  const r = cc.alignThreadProvider({ codexHome: CODEX_HOME_UPG, threadId: OLD_THREAD_ID });
  const th = cc.threadProvider(CODEX_HOME_UPG, OLD_THREAD_ID);
  check('③ⓚ 업데이트 전 대화(openai)가 재개 직전 지금 연결 이름으로 맞춰진다', (r.action === 'aligned' || r.action === 'none') && th.provider === cur.id && th.fileProvider === cur.id, `${r.action} ${r.from ?? ''}→${r.to ?? ''} db=${th.provider} file=${th.fileProvider}`);
  const after = fs.readFileSync(planted.rollout, 'utf8');
  check('③ⓚ 대화 내용(둘째 줄부터)은 그대로, 원본 백업이 있다', after.slice(after.indexOf('\n') + 1) === planted.rest && (r.action === 'none' || (r.backup && fs.existsSync(r.backup))), r.backup ?? '');
}

function dirNonEmpty(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0; } catch { return false; }
}
function newestMtime(p, depth = 2) {
  let best = 0;
  const walk = (d, lvl) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      try { best = Math.max(best, fs.statSync(f).mtimeMs); } catch { /* ignore */ }
      if (e.isDirectory() && lvl < depth) walk(f, lvl + 1);
    }
  };
  try { const st = fs.statSync(p); best = st.mtimeMs; if (st.isDirectory()) walk(p, 0); } catch { /* missing */ }
  return best;
}

/** zip 의 지문표(payload/manifest.json) — 부품마다 sha256·version. unpack 의 건너뛰기 판정이 보는 바로 그 값. */
function readManifest(zipDir) {
  const f = path.join(zipDir, 'payload', 'manifest.json');
  return fs.existsSync(f) ? readJson(f) : { parts: {} };
}

/** 새 판의 배치표(V2_LAYOUT)와 잠금표·지문표로 "이 부품이 있으면 어디에 무엇이 있어야 하는가"를 만든다. */
async function expectedPresence(zipDir) {
  const lock = readJson(path.join(zipDir, 'lock.json'));
  const manifest = readManifest(zipDir);
  const unpack = await import(pathToFileURL(path.join(zipDir, 'installer', 'setup', 'unpack.mjs')).href);
  const layout = unpack.V2_LAYOUT ?? {};
  const skeleton = unpack.SKELETON_OWNED ?? new Set();
  const out = [];
  for (const [id, part] of Object.entries(lock.parts ?? {})) {
    if (!part.dest || skeleton.has(id)) continue;
    if (part.redistribute === 'download') continue; // claude·document-skills: 온라인 단계 몫
    const lay = layout[id] ?? {};
    const dest = path.join(SOUL_ROOT, ...String(part.dest).split('/').filter(Boolean));
    let where; let kind; let source = null;
    if (lay.kind === 'file' || part.kind === 'file') {
      where = path.join(dest, path.basename(String(part.file))); kind = 'file';
      source = path.join(zipDir, 'payload', ...String(part.file).split('/').filter(Boolean));
    }
    else if (lay.kind === 'module') { where = dest; kind = 'dir'; }
    else { where = lay.slot ? path.join(dest, lay.slot) : dest; kind = 'dir'; }
    const m = manifest.parts?.[id] ?? {};
    out.push({ id, kind, where, source, identity: { version: m.version ?? part.version ?? null, sha256: m.sha256 ?? part.sha256 ?? null } });
  }
  return { lock, manifest, list: out };
}

function identityChanged(prevManifest, prevLock, id, identity) {
  const p = prevManifest?.parts?.[id] ?? prevLock?.parts?.[id];
  if (!p) return true; // new part
  if (p.sha256 && identity.sha256) return p.sha256 !== identity.sha256;
  if (p.version && identity.version) return p.version !== identity.version;
  return false;
}

// ③ⓛ 선택 모듈 지문(2.0.64) -------------------------------------------------------------------
// face\modules\<이름>\ 아래 모든 파일의 상대경로 → sha256. 이름 규칙 밖 폴더(.prev 등)는 ③ⓗ 몫이라 세지 않는다.
const MODULES_DIR = path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'face', 'modules');
const GATE_MODULE = 'gate-optional'; // 옛 판이 모듈을 깔지 않았을 때 심는 시험 모듈 이름(모듈 이름 규칙 안)
function snapshotModules() {
  const out = {};
  if (!fs.existsSync(MODULES_DIR)) return out;
  for (const name of fs.readdirSync(MODULES_DIR)) {
    const dir = path.join(MODULES_DIR, name);
    let isDir = false; try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
    if (!isDir || !/^[a-z][a-z0-9-]{1,31}$/.test(name)) continue;
    const files = {};
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(child);
        else files[child] = createHash('sha256').update(fs.readFileSync(path.join(dir, child))).digest('hex');
      }
    };
    walk('');
    out[name] = files;
  }
  return out;
}

function psParses(file) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e)|Out-Null; if($e.Count){$e|%{$_.Message};exit 1}else{exit 0}`],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { ok: r.status === 0, detail: (r.stdout || r.stderr || '').trim().slice(0, 200) };
}
function nodeChecks(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { ok: r.status === 0, detail: (r.stderr || '').trim().slice(0, 200) };
}

// ---------------------------------------------------------------------------
// ② 적용기 길(--via-applier, 2.0.67) — 조각 · 판정은 verify/upgrade-applier.mjs
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INSTALLER_WORK = path.join(STATE_DIR, 'IRIS-Installer'); // bootstrap.ps1 의 %LOCALAPPDATA%\IRIS-Installer (연습용 상태 폴더 아래)
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** 지금 닫혀 있는 포트 번호 하나(잠깐 열었다 닫는다). 계획의 daemonPort 로 쓴다. */
function closedPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
/** 이미 끝난 프로세스의 번호 하나(이 스크립트가 띄워 끝까지 기다린 node). 계획의 daemonPid 로 쓴다. */
function finishedPid() {
  return spawnSync(process.execPath, ['-e', ''], { windowsHide: true, timeout: 30000 }).pid ?? null;
}
/** 그 번호의 실행 파일 경로 · 명령줄(없거나 못 읽으면 null). 읽기만 한다. */
function procInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    // 큰따옴표를 쓰지 않는다(파워셸의 -Command 인자 안에서 벗겨질 수 있다).
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue; if ($p) { [Console]::Out.Write((@{ path = $p.ExecutablePath; cmd = $p.CommandLine } | ConvertTo-Json -Compress)) }`],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  try { return r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null; } catch { return null; }
}
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function killTree(pid) {
  return new Promise((resolve) => {
    const t = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    t.on('exit', () => resolve()); t.on('error', () => resolve());
  });
}

/**
 * 적용기가 띄운 설치기 서버가 아직 떠 있으면 끝낸다. 이 스크립트의 직계 자식이 아니므로 "우리 것"임을 먼저 증명한다:
 * bootstrap.ps1 이 연습용 상태 폴더에 적은 server.pid 의 번호이고, 그 실행 파일이 **연습용 상태 폴더 안에 푼 node.exe** 일 때만.
 * 증명되면 스스로 끝내라고 부탁하고(POST /api/quit), 그래도 남으면 그 번호만 끝낸다. 증명되지 않으면 아무것도 끝내지 않고 알린다.
 */
async function stopStagedInstaller() {
  if (!await portInUse(PORT)) return { stopped: false, reason: 'not-running' };
  const pid = Number(String(readText(path.join(INSTALLER_WORK, 'server.pid')) ?? '').trim());
  const info = procInfo(pid);
  const ours = !!info && samePath(info.path, path.join(INSTALLER_WORK, 'node', 'node.exe'));
  if (!ours) {
    console.error(`warning: something answers on port ${PORT} but it is not provably the installer this run started (server.pid=${pid || '(none)'}) -- leaving it alone`);
    return { stopped: false, reason: 'not-proven-ours', pid: pid || null };
  }
  try { await fetch(`http://127.0.0.1:${PORT}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* 이미 끝나는 중 */ }
  for (let i = 0; i < 100 && await portInUse(PORT); i++) await sleep(100);
  if (await portInUse(PORT)) await killTree(pid);
  for (let i = 0; i < 40 && await portInUse(PORT); i++) await sleep(100);
  return { stopped: true, pid };
}
/** 적용기가 띄운 시작 파일(cmd.exe)이 남아 있으면 — 명령줄에 받아 둔 설치 패키지 폴더가 있을 때만 — 그 번호를 끝낸다. */
async function stopStagedCmd(pid, packageDir) {
  const info = procInfo(pid);
  if (!info) return false;
  if (!String(info.cmd ?? '').toLowerCase().includes(packageDir.toLowerCase())) return false;
  await killTree(pid);
  return true;
}

/**
 * ② 를 적용기 길로 밟는다. 돌려주는 값 = { autoResult, serverOut, tUpdate } — 뒤의 판정(③)이 직접 길과 같은 것을 받는다.
 * 적용기 길에서만 보는 판정(ⓝ)은 여기서 찍는다. `staged` 에 끝낼 때 볼 것(받아 둔 폴더 · 시작 파일 번호)을 적어 둔다.
 */
async function updateViaApplier({ nextZip, nextVersion, prevVersion, staged }) {
  const setupDir = path.join(SOUL_ROOT, '_agent', 'setup');
  const resultFile = path.join(setupDir, 'update-result.json');
  const updateLog = path.join(setupDir, 'update.log');
  const dir = stagingDir(SOUL_ROOT, Date.now());
  const packageDir = path.join(dir, PACKAGE_DIR);
  staged.packageDir = packageDir;

  const probe = applierCommand(SOUL_ROOT, path.join(dir, 'plan.json'));
  const haveApplier = fs.existsSync(probe.apply) && fs.existsSync(probe.exe);
  check(`② ${prevVersion} 이 깐 적용기와 동봉 node 가 있다`, haveApplier, haveApplier ? path.relative(SOUL_ROOT, probe.apply) : `없음: ${[probe.apply, probe.exe].filter((f) => !fs.existsSync(f)).map((f) => path.relative(SOUL_ROOT, f)).join(', ')}`);
  if (!haveApplier) return { autoResult: null, serverOut: '', tUpdate: Date.now() };

  // ⓐ 창이 받아 두는 자리에 새 zip 을 푼다(창은 서명 · 지문을 확인한 뒤에 푼다 — 그 확인은 창의 검사 몫이다).
  log(`② staging ${nextVersion} where the IRIS window keeps a download: ${path.relative(SOUL_ROOT, dir)}`);
  await extractZip(nextZip, packageDir);
  if (neutralizeRelaunchIfLegacy(packageDir)) log(`staged copy of ${nextVersion} predates IRIS_INSTALLER_NO_FACE_RELAUNCH -- shimmed so no IRIS window opens`);
  const bootstrap = path.join(packageDir, 'installer', 'bootstrap.ps1');
  const shim = shimBootstrapNoBrowser(fs.readFileSync(bootstrap, 'utf8'));
  if (shim.changed) fs.writeFileSync(bootstrap, shim.text, 'utf8');
  log(`staged copy: bootstrap.ps1 will not open a browser when ${NO_BROWSER_ENV}=1 (${shim.changed ? 'shimmed' : 'already present'})`);

  // ⓑ 계획 — 창이 쓰는 꼴 그대로. 데몬 번호 · 포트는 이미 끝난 것 · 닫힌 것, relaunch 는 false(upgrade-applier.mjs buildPlan).
  const plan = buildPlan({
    root: SOUL_ROOT, packageDir, version: nextVersion,
    daemonPort: await closedPort(), daemonPid: finishedPid(), createdAt: new Date().toISOString(), relaunch: false,
  });
  const planFile = writePlan(dir, plan);
  const planAtStart = readText(planFile);
  const logOffset = (readText(updateLog) ?? '').length;
  const resultBefore = readText(resultFile);
  check('② 적용 전에는 결과 파일이 없다(새로 깐 연습 루트)', resultBefore === null, resultBefore === null ? '' : '이미 있음');

  // ⓒ ① 이 깐 **옛 판의 적용기**를 창이 띄우는 꼴로 띄운다. 이 프로세스는 이 스크립트의 자식이다(끝까지 기다린다).
  log(`② starting the installed applier (${prevVersion}): node apply.mjs --plan ${path.relative(SOUL_ROOT, planFile)}`);
  const tUpdate = Date.now();
  const cmd = applierCommand(SOUL_ROOT, planFile);
  const child = spawn(cmd.exe, cmd.args, { cwd: cmd.cwd, env: serverEnv({ [NO_BROWSER_ENV]: '1' }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = []; const err = [];
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => err.push(String(d)));
  let exit = null;
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  child.on('error', (e) => { exit = { code: null, signal: null, error: String(e?.message ?? e) }; });
  // 적용기는 계획의 데몬이 사라진 것을 확인하고(이미 끝난 번호 · 닫힌 포트라 곧바로) 시작 파일을 띄운 뒤 끝난다.
  const applierDeadline = Date.now() + 3 * 60 * 1000;
  while (!exit && Date.now() < applierDeadline) await sleep(100);
  if (!exit) { try { child.kill(); } catch { /* already gone */ } exit = { code: null, signal: 'timeout' }; }
  const receiptVersionAtExit = (() => { try { return readJson(receiptFile())?.package?.version ?? null; } catch { return null; } })();
  const resultAtExit = readText(resultFile);
  let resultObj = null; try { resultObj = resultAtExit ? JSON.parse(resultAtExit) : null; } catch { resultObj = null; }
  const applierLog = (readText(updateLog) ?? '').slice(logOffset);
  staged.cmdPid = startedCmdPid(applierLog);
  for (const r of judgeHandoff({ exit, stdout: out.join(''), result: resultObj, version: nextVersion })) check(r.name, r.ok, r.detail);
  // 기록만(판정 아님): 넘긴 직후의 영수증 판은 시점에 따라 옛 판일 수도 새 판일 수도 있다 — 통과 · 실패는 최종 상태로 가른다.
  log(describeHandoffMoment({ receiptVersionAtExit, prevVersion, nextVersion }));
  for (const r of judgeApplierLog({ logText: applierLog, version: nextVersion, soulName: SOUL_NAME })) check(r.name, r.ok, r.detail);
  if (err.join('').trim()) log(`applier stderr: ${err.join('').trim().slice(0, 400)}`);

  // ⓓ 적용기가 띄운 설치기: 시작 파일 → bootstrap.ps1(지문 확인 · node 풀기) → 서버가 --auto 로 스스로 시작 → 끝나면 스스로 종료.
  let autoResult = null; let installerDoneMs = NaN; let seenUp = false;
  if (resultObj?.handedOffToInstaller === true) {
    const url = `http://127.0.0.1:${PORT}`;
    const upDeadline = Date.now() + 10 * 60 * 1000;   // 지문 확인(수백 MB)과 node 풀기가 먼저 돈다
    const deadline = Date.now() + 25 * 60 * 1000;
    for (;;) {
      let st = null;
      try { st = await getJson(url, '/api/state'); } catch { st = null; }
      if (st?.name === 'iris-installer') {
        seenUp = true;
        if (st.autoResult) { autoResult = st.autoResult; installerDoneMs = Date.now(); break; }
      } else if (seenUp) break; // 떴다가 사라졌다 = 끝나고 스스로 종료했다(마지막 말은 state.json)
      if (!seenUp && Date.now() > upDeadline) break;
      if (Date.now() > deadline) break;
      await sleep(300);
    }
    if (!autoResult) {
      try { autoResult = readJson(path.join(INSTALLER_WORK, 'state.json')).autoResult ?? null; } catch { autoResult = null; }
      if (autoResult) installerDoneMs = Date.now();
    }
    const until = Date.now() + 30000;
    while (await portInUse(PORT) && Date.now() < until) await sleep(200);
  }
  const bootstrapLog = readText(path.join(INSTALLER_WORK, 'bootstrap.log')) ?? '';
  const serverOut = [readText(path.join(INSTALLER_WORK, 'server.out.log')), readText(path.join(INSTALLER_WORK, 'server.err.log')), bootstrapLog].filter(Boolean).join('\n');
  check('ⓝ 시작 파일(IRIS-설치.cmd → bootstrap.ps1)이 새 판의 설치기 서버를 띄웠다', seenUp && /Server process started \(pid \d+\)/.test(bootstrapLog),
    (bootstrapLog.match(/(Server process started|Could not unpack Node|Setup server did not respond|Please extract)[^\r\n]*/g) ?? ['(bootstrap 기록 없음)']).slice(-1)[0].slice(0, 120));
  // bootstrap.ps1 은 브라우저 열기 함수를 부른 뒤 늘 "Opened browser …" 줄을 적는다 — 열지 않았다는 증거는 덧댄 줄이 남긴 기록이다.
  check('ⓝ 연습 실행이라 브라우저를 열지 않았다(받아 둔 사본에만 덧댄 손잡이)', /Browser not opened/.test(bootstrapLog),
    (bootstrapLog.match(/Browser not opened[^\r\n]*/) ?? ['"Browser not opened" 줄이 없다 — 브라우저가 열렸을 수 있다'])[0].slice(0, 100));
  log(`② finished in ${Math.round((Date.now() - tUpdate) / 1000)}s (via the applier)`);

  for (const r of judgeAfterInstaller({
    resultAtExit, resultAtEnd: readText(resultFile), installerDoneMs,
    planAtStart, planAtEnd: readText(planFile), packageDirExists: fs.existsSync(path.join(packageDir, 'lock.json')),
  })) check(r.name, r.ok, r.detail);
  for (const r of judgeKeepFilesLocked({ capabilitiesText: readText(path.join(cmd.cwd, 'capabilities.json')) })) check(r.name, r.ok, r.detail);
  return { autoResult, serverOut, tUpdate };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  if (await portInUse(PORT)) throw new Error(`port ${PORT} is busy -- not freeing it (never touch 3456/3457/3458 either). Aborting.`);
  const nextZip = findNextZip();
  const nextVersion = versionOfZip(nextZip);
  if (!nextVersion) throw new Error(`cannot read a version from ${nextZip}`);
  const prevZip = findPrevZip(nextVersion);
  const prevVersion = versionOfZip(prevZip);
  log(`prev ${prevVersion}  ${prevZip}`);
  log(`next ${nextVersion}  ${nextZip}`);
  if (cmpVer(prevVersion, nextVersion) >= 0) throw new Error('--from must be an older version than the new zip');
  if (STATE_PICK.moved) log(`state folder (stands in for %LOCALAPPDATA%): ${STATE_DIR} -- moved out of the repository because its path is not ASCII (applierStateDir)`);

  if (fs.existsSync(SOUL_ROOT)) { log(`removing leftover ${SOUL_ROOT}`); if (!await removeDirHard(SOUL_ROOT)) throw new Error(`cannot remove ${SOUL_ROOT}`); }
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  let server = null;
  const staged = { packageDir: null, cmdPid: null }; // --via-applier: 끝낼 때 볼 것(받아 둔 설치 패키지 폴더 · 적용기가 띄운 시작 파일의 번호)
  try {
    log('extracting both zips');
    await extractZip(prevZip, ZIP_PREV);
    await extractZip(nextZip, ZIP_NEXT);
    if (neutralizeRelaunchIfLegacy(ZIP_NEXT)) log(`next zip ${nextVersion} predates IRIS_INSTALLER_NO_FACE_RELAUNCH -- shimmed the extracted copy so no IRIS window opens`);

    // ① 옛 판 설치 -----------------------------------------------------------
    log(`① installing ${prevVersion} into ${SOUL_ROOT} (offline)`);
    server = await startInstaller(ZIP_PREV, { auto: false, freshState: true });
    const t1 = Date.now();
    // 2.0.35: ① 은 일부러 옛 프리셋 경로(R/D/P 를 만드는 설치)로 깐다 — 업데이트가 기존 폴더를 건드리지 않고
    // 인터뷰를 다시 시키지 않는지(③ⓘ) 재기 위해서다. 옛 판 서버는 interview 응답이 없으므로 이 스위치가 필수다.
    process.env.IRIS_E2E_PRESET = '1';
    const progress = await driveInstall(server.url);
    await server.stop(); server = null;
    log(`① done in ${Math.round((Date.now() - t1) / 1000)}s`);
    // 2.0.30 이하 zip 의 검사 12·13 은 IRIS_INSTALLER_OFFLINE 을 모르고 127.0.0.1:3456 을 두드린다 -- 이 PC 처럼 진짜
    // 중계기가 살아 있으면 ① 이 그 검사에서만 실패한다(옛 판 코드, 새 판과 무관). 그 경우만 ① 을 통과로 보고 적어 둔다.
    // 2.0.31 부터는 검사가 오프라인이면 두드리지 않으므로 이 너그러움은 저절로 쓰이지 않게 된다.
    let firstOk = progress?.percent === 100 && !progress?.error;
    let firstNote = progress?.error ? JSON.stringify(progress.error).slice(0, 300) : '';
    if (!firstOk && cmpVer(prevVersion, '2.0.31') < 0 && progress?.error?.id === 'checks') {
      let failedIds = [];
      try { failedIds = (JSON.parse(progress.error.detail)?.fail ?? []).map((f) => f.id); } catch { /* not json */ }
      if (failedIds.length && failedIds.every((id) => id === 'relay' || id === 'relayCodex')) {
        firstOk = true;
        firstNote = `옛 판 검사 ${failedIds.join('·')} 만 실패(살아 있는 3456 을 두드린 옛 코드) -- 통과로 봄`;
      }
    }
    check(`① ${prevVersion} 오프라인 설치 완료`, firstOk, firstNote);
    const receiptBefore = readJson(receiptFile());
    const handoffBefore = fs.existsSync(handoffFile()) ? readJson(handoffFile()) : null;
    check('① 영수증 판 = 옛 판', receiptBefore?.package?.version === prevVersion, `${receiptBefore?.package?.version}`);
    // 사용자 자료 표식(업데이트가 사용자 폴더를 건드리지 않는지)
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, `keep me ${prevVersion} -> ${nextVersion}\n`, 'utf8');
    const markerBefore = fs.readFileSync(MARKER, 'utf8');
    // ③ⓚ 기준점(2.0.54, 2026-11-04 다른 선생님 신고 "업데이트 뒤 옛 코덱스 대화 재개 실패"): 업데이트 **전** 대화를 심는다 —
    // 연결 이름 'openai'(설치 패키지 2.0.49 이전의 코덱스 기본)로 만든 대화 기록 + 목록 DB 한 줄. 모델 호출 0.
    const oldThread = plantOldCodexThread();
    // ③ⓛ 기준점(2.0.64, 2026-11-13 "메신저 = 선택, 설치 패키지에서 뺀다"): 옛 판이 깔아 둔(또는 사용자가 설정에서 깐) 선택 모듈은
    // 새 판이 잠금표에 싣지 않아도 그대로여야 한다 — 로그인·열쇠(state)를 흉내 낸 파일을 심고, 모듈 폴더 전체의 지문을 떠 둔다.
    // 빈손 통과를 막는 두 장치: ⓐ 옛 판 잠금표가 모듈을 동봉했다면 그 모듈이 실제로 깔려 있어야 하고(안 깔렸으면 지킬 것이 없어 ③ⓛ이
    // 헛돈다), ⓑ 옛 판이 모듈을 하나도 깔지 않았으면(2.0.64 이후끼리) "사용자가 설정에서 깐 모듈" 을 흉내 낸 시험 모듈을 하나 심는다.
    const prevLockParts = readJson(path.join(ZIP_PREV, 'lock.json'))?.parts ?? {};
    const prevBundledMods = Object.keys(prevLockParts).filter((id) => /(^|\/)face\/modules\//.test(String(prevLockParts[id]?.dest ?? ''))).map((id) => String(prevLockParts[id].dest).split('/').pop());
    const prevModsMissing = prevBundledMods.filter((n) => !fs.existsSync(path.join(MODULES_DIR, n, 'module.json')));
    check(`① 옛 판이 동봉한 모듈(${prevBundledMods.length}개)이 깔려 있다`, prevModsMissing.length === 0,
      prevModsMissing.length ? `없음: ${prevModsMissing.join(', ')}` : (prevBundledMods.join(', ') || '(옛 판도 모듈을 싣지 않음 — 시험 모듈을 심는다)'));
    if (Object.keys(snapshotModules()).length === 0) {
      const fake = path.join(MODULES_DIR, GATE_MODULE);
      fs.mkdirSync(fake, { recursive: true });
      fs.writeFileSync(path.join(fake, 'module.json'), JSON.stringify({ name: GATE_MODULE, version: '0.0.1', contract: 1, grade: 0, entry: 'index.mjs' }), 'utf8');
      fs.writeFileSync(path.join(fake, 'index.mjs'), '// upgrade gate stand-in for a module the user installed from Settings\n', 'utf8');
      fs.writeFileSync(path.join(fake, '.official'), '', 'utf8');
    }
    const modulesBefore = snapshotModules();
    for (const name of Object.keys(modulesBefore)) {
      const planted = path.join(MODULES_DIR, name, 'state', 'upgrade-gate-login.json');
      fs.mkdirSync(path.dirname(planted), { recursive: true });
      fs.writeFileSync(planted, JSON.stringify({ me: `${name}-before-${prevVersion}` }), 'utf8');
    }
    const modulesPlanted = snapshotModules();
    // ③ⓘ 기준점(2.0.35): 표식 폴더(R01-연습)를 만든 **뒤**의 역할 폴더 목록 — 업데이트가 여기에 무엇도 더하거나 빼면 안 된다.
    const rolesBefore = fs.readdirSync(SOUL_ROOT).filter((n) => /^R\d{2}-/.test(n)).sort();

    // ② 새 판 --auto -----------------------------------------------------------
    let autoResult = null; let serverOut = ''; let tUpdate = Date.now();
    if (VIA_APPLIER) {
      // 적용기 길(2.0.67): 창이 받아 둔 계획 → ① 이 깐 옛 판의 적용기 → 새 zip 의 시작 파일 → 설치기. 조각 = 위 updateViaApplier.
      log(`② updating to ${nextVersion} through the installed applier (--via-applier)`);
      ({ autoResult, serverOut, tUpdate } = await updateViaApplier({ nextZip, nextVersion, prevVersion, staged }));
    } else {
      log(`② updating to ${nextVersion} with --auto`);
      tUpdate = Date.now();
      server = await startInstaller(ZIP_NEXT, { auto: true, freshState: false });
      let lastState = null;
      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        if (server.exited()) break;
        try { lastState = await getJson(server.url, '/api/state'); if (lastState?.autoResult) { autoResult = lastState.autoResult; } } catch { /* mid-exit */ }
        if (autoResult) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      // 서버는 끝나면 스스로 종료한다(finish → quit). state.json 이 마지막 말.
      if (!autoResult) {
        const sf = path.join(STATE_DIR, 'IRIS-Installer', 'state.json');
        if (fs.existsSync(sf)) { try { autoResult = readJson(sf).autoResult ?? null; } catch { /* ignore */ } }
      }
      const until = Date.now() + 15000;
      while (!server.exited() && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      serverOut = server.output();
      await server.stop(); server = null;
      log(`② finished in ${Math.round((Date.now() - tUpdate) / 1000)}s`);
    }
    check('② --auto 결과 ok', autoResult?.ok === true, autoResult ? JSON.stringify(autoResult).slice(0, 300) : 'autoResult 없음(시간 초과?)');

    // ③ 판정 ---------------------------------------------------------------------
    const receiptAfter = readJson(receiptFile());
    check('③ⓑ 영수증 판 = 새 판', receiptAfter?.package?.version === nextVersion, `${receiptAfter?.package?.version}`);
    const stageStatus = STAGES.map((id) => [id, receiptAfter?.setup?.[id]?.status ?? null]);
    check('③ⓑ 영수증 9단계 전부 done', stageStatus.every(([, s]) => s === 'done'), stageStatus.filter(([, s]) => s !== 'done').map(([id, s]) => `${id}=${s}`).join(' '));
    check('③ⓑ 영수증 setup 오류 없음', !receiptAfter?.setup?.error, receiptAfter?.setup?.error ? JSON.stringify(receiptAfter.setup.error).slice(0, 200) : '');

    const { lock: nextLock, list } = await expectedPresence(ZIP_NEXT);
    const prevLock = readJson(path.join(ZIP_PREV, 'lock.json'));
    const prevManifest = readManifest(ZIP_PREV);
    const missing = [];
    const stale = [];
    for (const p of list) {
      const present = p.kind === 'file' ? fs.existsSync(p.where) : dirNonEmpty(p.where);
      if (!present) { missing.push(`${p.id} (${path.relative(SOUL_ROOT, p.where)})`); continue; }
      if (!identityChanged(prevManifest, prevLock, p.id, p.identity)) continue;
      // 2.0.62: a single-file part is judged by CONTENT, not time. The build pins every zip entry to
      // 2026-01-01 (reproducible zips) and Windows CopyFile keeps that time, so a correctly replaced
      // file still looked "old" -- first hit when teamclaude-manage.ps1 changed for the first time
      // since this gate existed. Bytes equal to the new zip's file = placed by this update (stricter).
      if (p.kind === 'file' && p.source) {
        let same = false;
        try { same = fs.readFileSync(p.where).equals(fs.readFileSync(p.source)); } catch { same = false; }
        if (!same) stale.push(`${p.id}(내용이 새 판 파일과 다름)`);
      } else if (newestMtime(p.where) < tUpdate - 1000) stale.push(p.id);
    }
    check(`③ⓒ 새 판 잠금표 부품 ${list.length}개 전부 제자리에 있다`, missing.length === 0, missing.length ? `빠짐: ${missing.join(', ')}` : '');
    const changedIds = list.filter((p) => identityChanged(prevManifest, prevLock, p.id, p.identity)).map((p) => p.id);
    check(`③ⓓ 바뀐 부품(${changedIds.length}개)이 업데이트 때 다시 놓였다`, stale.length === 0, stale.length ? `옛 시각 그대로: ${stale.join(', ')}` : changedIds.join(', ') || '(바뀐 부품 없음)');
    check('③ⓒ 잠금표 판 = 새 판', nextLock?.package?.version === nextVersion);
    // 2.0.34(2026-09-21 실측): 모듈 부품을 slot 처럼 옆으로 옮겨 `face\modules\messenger.prev` 가 남았고 Face 가 두 번째 모듈로 보였다.
    // modules\ 안에는 이름 규칙 안 폴더만 있어야 하고, 잠금표의 모듈 부품(messenger)은 정확히 하나여야 한다.
    const modsDir = path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'face', 'modules');
    const modEntries = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((n) => { try { return fs.statSync(path.join(modsDir, n)).isDirectory(); } catch { return false; } }) : [];
    const strayMods = modEntries.filter((n) => !/^[a-z][a-z0-9-]{1,31}$/.test(n));
    check('③ⓗ face\\modules 에 이름 규칙 밖 폴더(.prev 등)가 없다', strayMods.length === 0, strayMods.length ? `남은 것: ${strayMods.join(', ')}` : modEntries.join(', ') || '(비어 있음)');
    // ③ⓛ 선택 모듈 무회귀(2.0.64): 새 판 잠금표가 싣지 않는 모듈은 업데이트 전과 **한 바이트도** 다르지 않아야 한다(판·공식 표시·로그인 state).
    // 새 판이 그 모듈을 직접 싣는 경우(다시 동봉)는 판이 바뀔 수 있으므로 "있다 + 심은 state 가 그대로"만 본다.
    const modulesAfter = snapshotModules();
    const bundledMods = new Set(Object.keys(nextLock?.parts ?? {}).filter((id) => /(^|\/)face\/modules\//.test(String(nextLock.parts[id]?.dest ?? ''))).map((id) => String(nextLock.parts[id].dest).split('/').pop()));
    const modNames = Object.keys(modulesPlanted);
    const modProblems = [];
    for (const name of modNames) {
      const a = modulesAfter[name];
      if (!a) { modProblems.push(`${name}: 업데이트 뒤 사라짐`); continue; }
      const stateKey = Object.keys(modulesPlanted[name]).find((k) => k.endsWith('upgrade-gate-login.json'));
      if (a[stateKey] !== modulesPlanted[name][stateKey]) modProblems.push(`${name}: 심어 둔 state 가 달라짐`);
      if (bundledMods.has(name)) continue;
      const changed = [...new Set([...Object.keys(modulesPlanted[name]), ...Object.keys(a)])].filter((k) => modulesPlanted[name][k] !== a[k]);
      if (changed.length) modProblems.push(`${name}: 달라진 파일 ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` 외 ${changed.length - 5}` : ''}`);
    }
    const newcomers = Object.keys(modulesAfter).filter((n) => !modNames.includes(n) && !bundledMods.has(n));
    if (newcomers.length) modProblems.push(`업데이트가 잠금표에 없는 모듈을 새로 깔았다: ${newcomers.join(', ')}`);
    if (modNames.length === 0) modProblems.push('지켜볼 모듈이 하나도 없다(시험 모듈 심기가 실패했다) — 이 검사는 빈손으로 통과하지 않는다');
    check(`③ⓛ 업데이트 전에 깔려 있던 선택 모듈(${modNames.length}개)이 그대로다 — 새 판이 싣지 않아도 지우거나 바꾸지 않는다`,
      modProblems.length === 0,
      modProblems.length ? modProblems.join(' / ') : modNames.map((n) => `${n}(파일 ${Object.keys(modulesPlanted[n]).length}개${bundledMods.has(n) ? ', 새 판이 동봉' : ''}${n === GATE_MODULE ? ', 시험 모듈' : ''})`).join(', '));

    // ③ⓔ 실행 파일 문법 -- 옛 판이 남긴 파일과 새 파일이 섞여도 "켜지는가"
    const manage = path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'teamclaude', 'teamclaude-manage.ps1');
    const ps = fs.existsSync(manage) ? psParses(manage) : { ok: false, detail: '파일 없음' };
    check('③ⓔ teamclaude-manage.ps1 이 있고 PowerShell 로 파싱된다', ps.ok, ps.detail);
    const entries = [
      ['face', path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'face', 'launch.mjs')],
      ['dash', path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'teamclaude-dash', 'server.mjs')],
      ['teamclaude', path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'teamclaude', 'node_modules', '@karpeleslab', 'teamclaude', 'src', 'index.js')],
      ['updater', path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'updater', 'apply.mjs')],
      // IRIS Doctor(2.0.66): 실행 입구와 검진 일꾼(따로 뜨는 자식). 새 판 잠금표에 그 부품이 있을 때만(옛 판끼리의 쌍을 다시 잴 때는 없다).
      ...(nextLock?.parts?.['iris-doctor'] ? [
        ['iris-doctor', path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'iris-doctor', 'iris-doctor.mjs')],
        ['iris-doctor worker', path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'iris-doctor', 'lib', 'worker.mjs')],
      ] : []),
    ];
    for (const [name, file] of entries) {
      const r = fs.existsSync(file) ? nodeChecks(file) : { ok: false, detail: '파일 없음' };
      check(`③ⓔ ${name} 진입 파일 node --check`, r.ok, r.ok ? path.relative(SOUL_ROOT, file) : `${path.relative(SOUL_ROOT, file)}: ${r.detail}`);
    }
    // ③ⓔ MCP 중계기(2.0.52+): 부품이 놓였고 동봉 python 으로 판 번호를 말하며, 설치기 소유
    // MCP 항목이 안내원 항목으로 바뀌었다(설계-MCP중계기.md 9절).
    if (fs.readFileSync(path.join(ZIP_NEXT, 'lock.json'), 'utf8').includes('"mcp-relay"')) {
      const relayPy = path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'mcp-relay', 'relay.py');
      const py = path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'python', 'python.exe');
      const ver = fs.existsSync(relayPy) && fs.existsSync(py)
        ? spawnSync(py, ['-I', relayPy, 'version'], { encoding: 'utf8', timeout: 30000 }) : null;
      check('③ⓔ mcp-relay 진입 파일이 동봉 python 으로 실행된다', !!ver && ver.status === 0 && /^\d+\.\d+\.\d+/.test(String(ver.stdout).trim()),
        ver ? `relay ${String(ver.stdout).trim()}` : '파일 없음');
      let cj = null;
      try { cj = JSON.parse(fs.readFileSync(path.join(SOUL_ROOT, '_agent', 'claude', '.claude.json'), 'utf8')); } catch { /* 아래에서 실패 */ }
      const relayed = Object.entries(cj?.mcpServers ?? {}).filter(([, s]) => (s?.args ?? []).includes('shim')).map(([n]) => n);
      check('③ⓔ 문서 MCP·플레이라이트가 안내원 항목으로 바뀌었다(self-improve 는 플러그인 몫)',
        ['pdf-automation', 'hwp-automation', 'playwright'].every((n) => relayed.includes(n)), relayed.join(', ') || '(없음)');
      // 코덱스도 같은 업데이트에서(공용 중계기를 기다리지 않고) 바뀌어야 한다 — 2.0.52 후보 1차에서
      // 문서 MCP 블록만 그대로 남던 결함(명령이 venv 파이썬이라 설치기 소유로 못 봄)의 재발 방지.
      let toml = '';
      try { toml = fs.readFileSync(path.join(SOUL_ROOT, '_agent', 'codex', 'config.toml'), 'utf8'); } catch { /* 아래에서 실패 */ }
      const codexRelayed = ['pdf-automation', 'hwp-automation', 'playwright'].filter((n) =>
        new RegExp(`\\[mcp_servers\\.${n}\\][^\\[]*args = \\[[^\\]]*"shim", "--id", "codex\\.global\\.${n}"`).test(toml));
      check('③ⓔ 코덱스 config.toml 의 문서 MCP·플레이라이트도 안내원 항목이다', codexRelayed.length === 3, codexRelayed.join(', ') || '(없음)');
    }
    const dashLib = path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'teamclaude-dash', 'lib.mjs');
    if (fs.existsSync(path.join(ZIP_NEXT, 'installer'))) {
      // 새 판 zip 의 dash 부품에 lib.mjs 가 들어 있으면 설치 뒤에도 있어야 한다(2.0.31 대시보드 묶음 검사).
      const hasLibInZip = fs.readFileSync(path.join(ZIP_NEXT, 'lock.json'), 'utf8').includes('"dash"');
      if (hasLibInZip && cmpVer(nextVersion, '2.0.31') >= 0) check('③ⓔ 대시보드 lib.mjs 가 놓였다', fs.existsSync(dashLib));
    }

    // ③ⓜ IRIS Doctor(2.0.66) ----------------------------------------------------
    // 새 판이 이 부품이 처음 실린 판(doctor-bundle.mjs DOCTOR_FIRST_PACKAGE_VERSION) 이상이면 잠금표에 부품이 **반드시** 있어야 한다
    // — 없으면 실패다(전에는 "잠금표에 없으면 통째로 건너뜀"이라, 나중 판에서 그 줄이 빠져도 이 항목이 조용히 사라졌다).
    // 그보다 옛 판끼리의 쌍을 다시 잴 때만 건너뛴다. 판 = 새 판 잠금표의 package.version(없으면 zip 이름의 판).
    const doctorPackageVersion = nextLock?.package?.version ?? nextVersion;
    if (doctorPartRequired(doctorPackageVersion)) {
      check(`③ⓜ 새 판(${doctorPackageVersion})의 잠금표에 ${DOCTOR_PART_ID} 부품이 있다(${DOCTOR_FIRST_PACKAGE_VERSION} 부터 반드시)`, !!nextLock?.parts?.[DOCTOR_PART_ID],
        nextLock?.parts?.[DOCTOR_PART_ID] ? String(nextLock.parts[DOCTOR_PART_ID].dest) : '잠금표에 그 부품이 없다');
    }
    if (nextLock?.parts?.['iris-doctor']) {
      const doctorDir = path.join(SOUL_ROOT, ...String(nextLock.parts['iris-doctor'].dest).split('/'));
      const doctorEntry = path.join(doctorDir, 'iris-doctor.mjs');
      const bundledNode = path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'node', 'node.exe');
      // ① 제자리 + 지문: 풀기 단계가 놓은 폴더가 지문 목록과 한 바이트도 다르지 않다(목록 밖 파일 · 링크 · 시험 파일 0, 시작 파일 ASCII + CRLF).
      //    Doctor 는 시작할 때마다 같은 대조를 하고, 다르면 그 실행에서 치료를 시작하지 않는다 — 업데이트가 그런 Doctor 를 남기면 안 된다.
      const bundleProblems = doctorBundleProblems(doctorDir);
      check('③ⓜ IRIS Doctor 부품이 제자리에 있고 지문 목록과 같다', bundleProblems.length === 0, bundleProblems.length ? bundleProblems.slice(0, 5).join(' / ') : path.relative(SOUL_ROOT, doctorDir));
      for (const ps1 of ['lib\\start-check.ps1', 'lib\\treat\\job-keeper.ps1']) {
        const f = path.join(doctorDir, ps1);
        const r = fs.existsSync(f) ? psParses(f) : { ok: false, detail: '파일 없음' };
        check(`③ⓔ iris-doctor ${ps1} 이 PowerShell 로 파싱된다`, r.ok, r.detail);
      }
      // ② 옛 판에 없던 부품이면 옮겨 둘 옛 사본이 없다 — `.prev` 가 생겼다면 처음 놓는 부품을 두 번 놓았거나 남의 폴더를 옮긴 것이다.
      //    (옛 판에도 있었고 판이 바뀐 때에는 `.prev` 가 정상이므로 그때는 재지 않는다.)
      if (!prevLock?.parts?.['iris-doctor']) {
        const strayPrev = fs.readdirSync(path.dirname(doctorDir)).filter((n) => /^iris-doctor\.prev/i.test(n));
        check('③ⓜ 처음 놓인 Doctor 부품 옆에 .prev 가 없다', strayPrev.length === 0, strayPrev.join(', '));
      }
      // ③ 통신 없이 뜬다 — 동봉 node 로 **두 명령만** 부른다:
      //      selftest   시작 파일이 "이 node 로 Doctor 가 뜨는가"를 볼 때 부르는 것: node 판을 보고 프로그램 파일을 전부 불러와 본다(통신 0 · 쓰기 0)
      //      --version  판을 찍고 끝난다(통신 0 · 쓰기 0)
      //    다른 명령은 부르지 않는다. 까닭: probe · login · 치료 = 중계기를 거치지 않는 실제 호출(모델 · 로그인) /
      //    diagnose · checkup = 통신 없이 돌려도 이 PC 의 3456 · 3458 을 두드려 본다(게이트는 살아 있는 중계기 · 창에 닿지 않는다) /
      //    link summary · link auto = Doctor 의 집(_agent\doctor)을 만든다(게이트는 연습 루트에 그 집을 만들지 않는다 — 아래 ⑤).
      //    환경은 윈도우 기본 변수만 넘긴다(이 개발 PC 의 IRIS_ROOT · 설정 폴더 · 열쇠가 섞이지 않게).
      const sys = process.env.SystemRoot || 'C:\\Windows';
      const doctorEnv = { SystemRoot: sys, windir: sys, ComSpec: path.join(sys, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: `${path.join(sys, 'System32')};${sys}`, TEMP: os.tmpdir(), TMP: os.tmpdir(), USERPROFILE: STATE_DIR, LOCALAPPDATA: STATE_DIR, APPDATA: STATE_DIR };
      const runDoctor = (...a) => (fs.existsSync(doctorEntry) && fs.existsSync(bundledNode)
        ? spawnSync(bundledNode, [doctorEntry, ...a], { encoding: 'utf8', env: doctorEnv, cwd: os.tmpdir(), windowsHide: true, timeout: 60000 }) : null);
      const self = runDoctor('selftest');
      check('③ⓜ IRIS Doctor 가 동봉 node 로 뜬다(자체 확인 — 통신 0)', !!self && self.status === 0 && /IRIS-DOCTOR-SELFTEST-OK/.test(String(self.stdout)),
        self ? `exit ${self.status} ${String(self.stdout).trim().slice(0, 80)}` : '실행 입구나 동봉 node 가 없다');
      const ver = runDoctor('--version');
      let wantVersion = null;
      try { wantVersion = readJson(path.join(doctorDir, 'manifest.json')).version; } catch { /* ①에서 이미 실패 */ }
      check('③ⓜ IRIS Doctor 가 말하는 판 = 지문 목록의 판', !!ver && ver.status === 0 && String(ver.stdout).trim() === `iris-doctor ${wantVersion}`, ver ? String(ver.stdout).trim().slice(0, 60) : '(실행 못 함)');
      // ④ 바로가기: 게이트는 연습 실행(IRIS_INSTALLER_NO_USER_ENV=1)이라 바탕화면 · 시작 메뉴에 만들지 않는다 — 그 사실이 영수증에 적혀 있어야 한다.
      //    (실행기 단계가 이 부품 때문에 다시 돌았다는 뜻이기도 하다 — 실제 PC 에서는 이때 바로가기가 생긴다.)
      const doctorShortcut = receiptAfter?.setup?.relay?.recorded?.doctorShortcut ?? null;
      check('③ⓜ 연습 실행이라 「IRIS Doctor」 바로가기는 "만들지 않았음"으로 기록돼 있다', doctorShortcut?.status === 'skipped' && !doctorShortcut?.desktop && !doctorShortcut?.startMenu,
        doctorShortcut ? JSON.stringify(doctorShortcut).slice(0, 160) : '실행기 단계의 기록에 doctorShortcut 이 없다(실행기 단계가 다시 돌지 않았다)');
      // ⑤ 설치기는 Doctor 의 집에 쓰지 않는다 · 연습 실행에서는 손 없는 계정 준비(link auto)도 부르지 않는다.
      check('③ⓜ 업데이트가 Doctor 의 집(_agent\\doctor)을 만들지 않았다', !fs.existsSync(path.join(SOUL_ROOT, '_agent', 'doctor')));
      let serverLog = serverOut;
      try { serverLog += fs.readFileSync(path.join(STATE_DIR, 'IRIS-Installer', 'server.log'), 'utf8'); } catch { /* 콘솔 출력만으로 본다 */ }
      check('③ⓜ 연습 실행에서는 Doctor 계정 준비를 부르지 않았다고 기록했다', /doctor prepare \(update\): not called \((rehearsal|offline)\)/.test(serverLog),
        (serverLog.match(/doctor prepare[^\r\n]*/) ?? ['기록 줄이 없다'])[0].slice(0, 120));
    }

    // ③ⓕ 인수 문서 ------------------------------------------------------------
    const handoffAfter = fs.existsSync(handoffFile()) ? readJson(handoffFile()) : null;
    // 업데이트는 인수 문서를 나쁘게 만들면 안 된다(같거나 더 좋아야 한다 -- ① 이 옛 판 검사 잡음으로 setup-incomplete 였다면
    // 새 판이 검사를 다시 돌려 login-pending 으로 고치는 것은 정상).
    const RANK = { ready: 3, 'login-pending': 2, 'setup-incomplete': 1, none: 0 };
    const rb = RANK[handoffBefore?.state] ?? 0; const ra = RANK[handoffAfter?.state] ?? 0;
    check('③ⓕ 인수 문서 state 가 나빠지지 않았다(setup-incomplete 아님)', ra >= rb && handoffAfter?.state !== 'setup-incomplete', `${handoffBefore?.state} -> ${handoffAfter?.state}`);
    check('③ⓕ 인수 문서 packageVersion = 새 판', handoffAfter?.packageVersion === nextVersion, `${handoffAfter?.packageVersion}`);
    // 2.0.35: 업데이트는 기존 R/D/P 를 건드리지 않고, 첫 인사가 인터뷰로 바뀌지 않는다(인터뷰는 폴더가 하나도 없는 새 설치만).
    const rolesNow = fs.readdirSync(SOUL_ROOT).filter((n) => /^R\d{2}-/.test(n)).sort();
    check('③ⓘ 기존 역할 폴더(R##-) 그대로', rolesNow.length > 0 && rolesNow.join('|') === rolesBefore.join('|'), `${rolesBefore.length} -> ${rolesNow.length}`);
    check('③ⓘ 업데이트 PC 는 인터뷰를 다시 하지 않는다', handoffAfter?.structure?.mode !== 'interview' && !String(handoffAfter?.firstMessage || '').includes('interview.md'), `structure.mode=${handoffAfter?.structure?.mode ?? '(없음: 옛 인수 문서)'}`);
    // 2.0.39(2026-09-29 예행연습 발견): 업데이트는 `checks` 단계를 건너뛰므로 설치기 사본이 옛 판 그대로였다 —
    // 업데이트한 PC 의 사본에도 새 판(과 IRIS-삭제.cmd)이 있어야 한다.
    if (cmpVer(nextVersion, '2.0.39') >= 0) {
      const copyDir = path.join(SOUL_ROOT, '_agent', 'setup', 'installer');
      const copyVer = fs.existsSync(path.join(copyDir, '.version')) ? fs.readFileSync(path.join(copyDir, '.version'), 'utf8').trim() : '(없음)';
      check('③ⓙ 설치기 사본 판 = 새 판', copyVer === nextVersion, copyVer);
      check('③ⓙ 설치기 사본에 IRIS-삭제.cmd 가 있다', fs.existsSync(path.join(copyDir, 'installer', 'IRIS-삭제.cmd')));
    }

    // ③ⓖ 사용자 자료 ----------------------------------------------------------
    check('③ⓖ 사용자 자료 표식 파일이 그대로다', fs.existsSync(MARKER) && fs.readFileSync(MARKER, 'utf8') === markerBefore);

    // ③ⓚ 업데이트 전 대화가 업데이트 뒤에도 재개된다(2.0.54) ---------------------------------
    // 새 판이 깐 IRIS 창의 재개 호환 모듈을 그대로 불러, 심은 옛 대화를 재개 직전처럼 맞춘 뒤
    // "목록 DB·기록 파일의 연결 이름 = 지금 코덱스 설정의 연결 이름"(= 코덱스의 재개 검사 통과 조건, 2026-11-04 실측)인지 본다.
    await judgeOldCodexThread(oldThread);

    // 결과 -----------------------------------------------------------------------
    const failed = results.filter((r) => !r.ok);
    const summary = { prevVersion, nextVersion, prevZip, nextZip, startedAt: new Date(t0).toISOString(), tookMs: Date.now() - t0, results, autoResult, expectFail: EXPECT_FAIL, viaApplier: VIA_APPLIER };
    fs.writeFileSync(RESULT_FILE, JSON.stringify(summary, null, 2), 'utf8');
    if (failed.length) fs.writeFileSync(path.join(SCRATCH_DIR, 'server-auto.log'), serverOut, 'utf8');
    console.log('');
    console.log(`upgrade verify ${prevVersion} -> ${nextVersion}${VIA_APPLIER ? ' (via the applier)' : ''}: ${results.length - failed.length}/${results.length} pass, ${failed.length} fail (${Math.round((Date.now() - t0) / 1000)}s)`);
    if (EXPECT_FAIL) {
      console.log(failed.length ? 'expected failure observed -- the gate catches this pair (exit 0)' : 'NO failure observed but --expect-fail was given (exit 1)');
      process.exitCode = failed.length ? 0 : 1;
    } else {
      process.exitCode = failed.length ? 1 : 0;
    }
  } finally {
    if (server) { try { await server.stop(); } catch { /* ignore */ } }
    if (VIA_APPLIER) {
      // 적용기가 띄운 것들은 보통 스스로 끝나 있다. 남았으면 "우리 것"으로 증명된 번호만 끝낸다(연습 루트를 지우기 전에).
      try { await stopStagedInstaller(); } catch (e) { console.error(`warning: could not check the staged installer: ${e?.message ?? e}`); }
      if (staged.cmdPid && staged.packageDir) { try { await stopStagedCmd(staged.cmdPid, staged.packageDir); } catch { /* 이미 끝남 */ } }
    }
    if (!KEEP) {
      if (fs.existsSync(SOUL_ROOT) && !await removeDirHard(SOUL_ROOT)) console.error(`warning: could not remove ${SOUL_ROOT}`);
      for (const d of [ZIP_PREV, ZIP_NEXT, STATE_DIR]) fs.rmSync(d, { recursive: true, force: true });
    } else {
      log(`--keep: ${SOUL_ROOT} and ${SCRATCH_DIR} left in place${STATE_PICK.moved ? ` (state folder: ${STATE_DIR})` : ''}`);
    }
  }
}

main().catch((err) => {
  console.error(`upgrade verify: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
