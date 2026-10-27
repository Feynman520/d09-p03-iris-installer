// IRIS 설치기 겉옷의 두 번째 절반 — macOS (docs/설계-macOS.md D-M04).
//
// bootstrap.sh 가 node 하나만 믿을 수 있게 만들고 여기로 넘긴다. 여기서 하는 일은
// Windows bootstrap.ps1 의 뒷부분과 같다:
//   ① 부품 전부 SHA-256 확인(exit 11)
//   ② 앞서 띄운 설치기 서버가 있으면 같은 판은 다시 쓰고, 다른 판·--auto 는 끄게 한다
//   ③ server.pid 가 남아 있으면 그 PID 가 **정말 우리 서버일 때만** 멈춘다(이름·포트로 찾지 않는다)
//   ④ 서버를 창 없이(터미널을 닫아도 살게) 띄우고 /api/health 를 기다린다(exit 13)
//   ⑤ 브라우저를 연다 — 실패해도 주소를 알려 주고 성공으로 끝낸다
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nodeBinIn } from './lib/platform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseBootstrapArgs(argv) {
  const a = { port: 3460, auto: false, resume: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--zip-root') a.zipRoot = argv[++i];
    else if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--node-dir') a.nodeDir = argv[++i];
    else if (k === '--work-dir') a.workDir = argv[++i];
    else if (k === '--auto') a.auto = true;
    else if (k === '--resume') a.resume = true;
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The zip ships only lib/{run,zip,net}.mjs (build/pack.mjs LIB_FILES), so the
// check lib/manifest.mjs does at build time is repeated here in a few lines --
// the same rule bootstrap.ps1 applies: every part file must match its sha256.
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

export async function verifyPayload(payloadDir, manifest) {
  const mismatches = [];
  for (const p of Object.values(manifest.parts ?? {})) {
    const abs = path.join(payloadDir, p.file);
    const actual = fs.existsSync(abs) ? await sha256File(abs) : null;
    if (actual !== p.sha256) mismatches.push({ file: p.file, expected: p.sha256, actual });
  }
  return { ok: mismatches.length === 0, mismatches };
}

async function health(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

function packageVersion(zipRoot) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(zipRoot, 'lock.json'), 'utf8')).package.version);
  } catch {
    return null;
  }
}

/**
 * server.pid 의 PID 가 우리가 띄운 설치기 서버인가.
 * PID 는 재사용되므로 "파일에 적혀 있다"는 증거가 못 된다. 그 프로세스의 명령줄이
 * **이 작업 폴더의 node** 로 **설치기 server.mjs** 를 돌리고 있을 때만 참이다.
 * 명령줄을 못 읽으면(권한·이미 끝남) 모르는 것이고, 모르면 우리 것이 아니다.
 */
export function isOurServer(pid, { nodeBin, readArgs = defaultReadArgs } = {}) {
  let args;
  try { args = readArgs(pid); } catch { return false; }
  if (!args) return false;
  return args.startsWith(`${nodeBin} `) && /[\\/]installer[\\/]server\.mjs(\s|$)/.test(args);
}

function defaultReadArgs(pid) {
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
}

function openBrowser(url, log) {
  // 시험 손잡이: 겉옷 전 구간 시험이 사람의 화면에 브라우저를 띄우지 않게.
  if (process.env.IRIS_INSTALLER_NO_BROWSER === '1') {
    log(`IRIS_INSTALLER_NO_BROWSER=1 — not opening ${url}`);
    return false;
  }
  try {
    execFileSync('/usr/bin/open', [url], { stdio: 'ignore' });
    return true;
  } catch (e) {
    log(`브라우저를 자동으로 열지 못했습니다(${e?.message ?? e}).`);
    console.log('');
    console.log(`  >>> 브라우저에서 이 주소를 열어 주세요: ${url}`);
    console.log('');
    return false;
  }
}

export async function bootstrap({ zipRoot, port = 3460, nodeDir, workDir, auto = false, resume = false }) {
  fs.mkdirSync(workDir, { recursive: true });
  const logFile = path.join(workDir, 'bootstrap.log');
  const log = (m) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`, 'utf8'); } catch { /* 기록 실패는 무시 */ }
    console.log(m);
  };
  const url = `http://127.0.0.1:${port}/`;
  const nodeBin = nodeBinIn(nodeDir);

  // ① 무결성 -----------------------------------------------------------------
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(zipRoot, 'payload', 'manifest.json'), 'utf8'));
  } catch {
    log('부품 목록(manifest.json)을 읽지 못했습니다. zip 을 다시 받아 주세요.');
    return 11;
  }
  console.log('파일을 확인하는 중입니다(1~2분 걸릴 수 있습니다)…');
  const verdict = await verifyPayload(path.join(zipRoot, 'payload'), manifest);
  if (!verdict.ok) {
    log(`Integrity check failed: ${verdict.mismatches[0]?.file}. zip 을 다시 받아 주세요.`);
    return 11;
  }
  log('Integrity check passed.');

  // ② 이미 떠 있는 서버 -------------------------------------------------------
  const pidFile = path.join(workDir, 'server.pid');
  const running = await health(port);
  if (running?.name === 'iris-installer') {
    const ours = packageVersion(zipRoot);
    const theirs = running.version != null ? String(running.version) : null;
    const replace = auto || (ours && theirs && ours !== theirs);
    if (!replace) {
      log(`Setup server already running (version ${theirs}). Reusing it.`);
      openBrowser(url, log);
      return 0;
    }
    log(`Setup server already running is version '${theirs}' but this package is '${ours}' (auto=${auto}). Asking it to quit.`);
    try {
      await fetch(`http://127.0.0.1:${port}/api/quit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000),
      });
    } catch { /* 이미 끝났을 수도 있다 */ }
    for (let i = 0; i < 40 && await health(port, 1000); i++) await sleep(250);
  }

  // ③ 남은 server.pid ---------------------------------------------------------
  if (fs.existsSync(pidFile)) {
    const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* 없는 PID */ }
      if (alive && isOurServer(pid, { nodeBin })) {
        log(`Stopping stale server process (pid ${pid}).`);
        try { process.kill(pid, 'SIGTERM'); } catch { /* 이미 끝남 */ }
      } else if (alive) {
        log(`server.pid names pid ${pid}, but that process is not our installer server. Leaving it alone.`);
      }
    }
    try { fs.rmSync(pidFile, { force: true }); } catch { /* 다음 실행이 다시 본다 */ }
  }

  // ④ 서버 --------------------------------------------------------------------
  const out = fs.openSync(path.join(workDir, 'server.out.log'), 'a');
  const err = fs.openSync(path.join(workDir, 'server.err.log'), 'a');
  const args = [path.join(HERE, 'server.mjs'), '--zip-root', zipRoot, '--port', String(port), '--node-dir', nodeDir];
  if (auto) args.push('--auto');
  if (resume) args.push('--resume');
  // detached = 새 세션. 사용자가 터미널 창을 닫아도(SIGHUP) 서버는 산다.
  const child = spawn(nodeBin, args, { detached: true, stdio: ['ignore', out, err], cwd: zipRoot });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  log(`Server process started (pid ${child.pid}).`);

  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    await sleep(500);
    ok = (await health(port))?.name === 'iris-installer';
  }
  if (!ok) {
    log(`Setup server did not respond. 기록: ${logFile}`);
    return 13;
  }

  // ⑤ 브라우저 ---------------------------------------------------------------
  log('Server is ready. Open the browser window to continue.');
  openBrowser(url, log);
  console.log('설치 화면이 브라우저에 열렸습니다. 이 터미널 창은 닫아도 됩니다.');
  return 0;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const a = parseBootstrapArgs(process.argv.slice(2));
  bootstrap(a).then((code) => process.exit(code), (e) => {
    console.error(`설치기를 시작하지 못했습니다: ${e?.stack ?? e}`);
    process.exit(13);
  });
}
