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

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractZip } from '../lib/zip.mjs';
import { driveInstall, getJson } from './offline.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAST_BUILD_JSON = path.join(ROOT_DIR, '_build', 'out', 'last-build.json');
const SCRATCH_DIR = path.join(ROOT_DIR, '_build', 'upgrade');
const ZIP_PREV = path.join(SCRATCH_DIR, 'zip-prev');
const ZIP_NEXT = path.join(SCRATCH_DIR, 'zip-next');
const STATE_DIR = path.join(SCRATCH_DIR, 'state'); // stands in for %LOCALAPPDATA%
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
    let where; let kind;
    if (lay.kind === 'file' || part.kind === 'file') { where = path.join(dest, path.basename(String(part.file))); kind = 'file'; }
    else if (lay.kind === 'module') { where = dest; kind = 'dir'; }
    else { where = lay.slot ? path.join(dest, lay.slot) : dest; kind = 'dir'; }
    const m = manifest.parts?.[id] ?? {};
    out.push({ id, kind, where, identity: { version: m.version ?? part.version ?? null, sha256: m.sha256 ?? part.sha256 ?? null } });
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

  if (fs.existsSync(SOUL_ROOT)) { log(`removing leftover ${SOUL_ROOT}`); if (!await removeDirHard(SOUL_ROOT)) throw new Error(`cannot remove ${SOUL_ROOT}`); }
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  let server = null;
  try {
    log('extracting both zips');
    await extractZip(prevZip, ZIP_PREV);
    await extractZip(nextZip, ZIP_NEXT);
    if (neutralizeRelaunchIfLegacy(ZIP_NEXT)) log(`next zip ${nextVersion} predates IRIS_INSTALLER_NO_FACE_RELAUNCH -- shimmed the extracted copy so no IRIS window opens`);

    // ① 옛 판 설치 -----------------------------------------------------------
    log(`① installing ${prevVersion} into ${SOUL_ROOT} (offline)`);
    server = await startInstaller(ZIP_PREV, { auto: false, freshState: true });
    const t1 = Date.now();
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

    // ② 새 판 --auto -----------------------------------------------------------
    log(`② updating to ${nextVersion} with --auto`);
    const tUpdate = Date.now();
    server = await startInstaller(ZIP_NEXT, { auto: true, freshState: false });
    let autoResult = null; let lastState = null;
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
    const serverOut = server.output();
    await server.stop(); server = null;
    log(`② finished in ${Math.round((Date.now() - tUpdate) / 1000)}s`);
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
      if (identityChanged(prevManifest, prevLock, p.id, p.identity) && newestMtime(p.where) < tUpdate - 1000) stale.push(p.id);
    }
    check(`③ⓒ 새 판 잠금표 부품 ${list.length}개 전부 제자리에 있다`, missing.length === 0, missing.length ? `빠짐: ${missing.join(', ')}` : '');
    const changedIds = list.filter((p) => identityChanged(prevManifest, prevLock, p.id, p.identity)).map((p) => p.id);
    check(`③ⓓ 바뀐 부품(${changedIds.length}개)이 업데이트 때 다시 놓였다`, stale.length === 0, stale.length ? `옛 시각 그대로: ${stale.join(', ')}` : changedIds.join(', ') || '(바뀐 부품 없음)');
    check('③ⓒ 잠금표 판 = 새 판', nextLock?.package?.version === nextVersion);

    // ③ⓔ 실행 파일 문법 -- 옛 판이 남긴 파일과 새 파일이 섞여도 "켜지는가"
    const manage = path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'teamclaude', 'teamclaude-manage.ps1');
    const ps = fs.existsSync(manage) ? psParses(manage) : { ok: false, detail: '파일 없음' };
    check('③ⓔ teamclaude-manage.ps1 이 있고 PowerShell 로 파싱된다', ps.ok, ps.detail);
    const entries = [
      ['face', path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'face', 'launch.mjs')],
      ['dash', path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'teamclaude-dash', 'server.mjs')],
      ['teamclaude', path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'teamclaude', 'node_modules', '@karpeleslab', 'teamclaude', 'src', 'index.js')],
      ['updater', path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'updater', 'apply.mjs')],
    ];
    for (const [name, file] of entries) {
      const r = fs.existsSync(file) ? nodeChecks(file) : { ok: false, detail: '파일 없음' };
      check(`③ⓔ ${name} 진입 파일 node --check`, r.ok, r.ok ? path.relative(SOUL_ROOT, file) : `${path.relative(SOUL_ROOT, file)}: ${r.detail}`);
    }
    const dashLib = path.join(SOUL_ROOT, '_agent', 'shared', 'tools', 'teamclaude-dash', 'lib.mjs');
    if (fs.existsSync(path.join(ZIP_NEXT, 'installer'))) {
      // 새 판 zip 의 dash 부품에 lib.mjs 가 들어 있으면 설치 뒤에도 있어야 한다(2.0.31 대시보드 묶음 검사).
      const hasLibInZip = fs.readFileSync(path.join(ZIP_NEXT, 'lock.json'), 'utf8').includes('"dash"');
      if (hasLibInZip && cmpVer(nextVersion, '2.0.31') >= 0) check('③ⓔ 대시보드 lib.mjs 가 놓였다', fs.existsSync(dashLib));
    }

    // ③ⓕ 인수 문서 ------------------------------------------------------------
    const handoffAfter = fs.existsSync(handoffFile()) ? readJson(handoffFile()) : null;
    // 업데이트는 인수 문서를 나쁘게 만들면 안 된다(같거나 더 좋아야 한다 -- ① 이 옛 판 검사 잡음으로 setup-incomplete 였다면
    // 새 판이 검사를 다시 돌려 login-pending 으로 고치는 것은 정상).
    const RANK = { ready: 3, 'login-pending': 2, 'setup-incomplete': 1, none: 0 };
    const rb = RANK[handoffBefore?.state] ?? 0; const ra = RANK[handoffAfter?.state] ?? 0;
    check('③ⓕ 인수 문서 state 가 나빠지지 않았다(setup-incomplete 아님)', ra >= rb && handoffAfter?.state !== 'setup-incomplete', `${handoffBefore?.state} -> ${handoffAfter?.state}`);
    check('③ⓕ 인수 문서 packageVersion = 새 판', handoffAfter?.packageVersion === nextVersion, `${handoffAfter?.packageVersion}`);

    // ③ⓖ 사용자 자료 ----------------------------------------------------------
    check('③ⓖ 사용자 자료 표식 파일이 그대로다', fs.existsSync(MARKER) && fs.readFileSync(MARKER, 'utf8') === markerBefore);

    // 결과 -----------------------------------------------------------------------
    const failed = results.filter((r) => !r.ok);
    const summary = { prevVersion, nextVersion, prevZip, nextZip, startedAt: new Date(t0).toISOString(), tookMs: Date.now() - t0, results, autoResult, expectFail: EXPECT_FAIL };
    fs.writeFileSync(RESULT_FILE, JSON.stringify(summary, null, 2), 'utf8');
    if (failed.length) fs.writeFileSync(path.join(SCRATCH_DIR, 'server-auto.log'), serverOut, 'utf8');
    console.log('');
    console.log(`upgrade verify ${prevVersion} -> ${nextVersion}: ${results.length - failed.length}/${results.length} pass, ${failed.length} fail (${Math.round((Date.now() - t0) / 1000)}s)`);
    if (EXPECT_FAIL) {
      console.log(failed.length ? 'expected failure observed -- the gate catches this pair (exit 0)' : 'NO failure observed but --expect-fail was given (exit 1)');
      process.exitCode = failed.length ? 0 : 1;
    } else {
      process.exitCode = failed.length ? 1 : 0;
    }
  } finally {
    if (server) { try { await server.stop(); } catch { /* ignore */ } }
    if (!KEEP) {
      if (fs.existsSync(SOUL_ROOT) && !await removeDirHard(SOUL_ROOT)) console.error(`warning: could not remove ${SOUL_ROOT}`);
      for (const d of [ZIP_PREV, ZIP_NEXT, STATE_DIR]) fs.rmSync(d, { recursive: true, force: true });
    } else {
      log(`--keep: ${SOUL_ROOT} and ${SCRATCH_DIR} left in place`);
    }
  }
}

main().catch((err) => {
  console.error(`upgrade verify: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
