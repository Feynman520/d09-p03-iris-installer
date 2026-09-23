// verify/login-probe.mjs -- 실제 PC 로그인 시험 (2.0.36, 2026-09-23)
//
// 배경: 2.0.35 를 다른 선생님 PC 에 깔 때 Claude Code 내려받기가 실패했는데 로그인 단추가 켜져 있어,
// 없는 CLI 로 로그인을 띄우고 곧장 꺼졌다 -- 사람에게는 "로그인 브라우저가 전혀 안 뜬다"로만 보였다.
// 단위 시험은 가짜 spawn 으로 돌아 "진짜로 받고 진짜로 띄우는" 길을 밟지 않았다. 이 스크립트가 매 판 밟는다:
//
//   ① 받기       임시 영혼 폴더에 lock.json 의 Claude Code 를 실제로 받는다(installClaude, 출처 1 → 2 폴백).
//   ② 로그인 띄움  startPipedLogin(창 없음) → 출력에서 로그인 주소 → netstat 으로 자동 복귀 포트 복원.
//                 판정 = redirect_uri 가 http://localhost:<포트>/callback 인가(코드 붙여넣기 주소가 아닌가).
//                 OAuth 는 끝내지 않는다(계정 0 추가) -- 주소가 잡히면 자기가 띄운 PID 하나만 끝낸다.
//   ③ CLI 없음    빈 영혼 폴더(영수증만 있음)에서 startPipedLogin 이 cli-missing 으로 던지고, startLogin 이
//                 failed/cli-missing + 안내를 기록하고, loginStatus 가 그 기록을 그대로 돌려주는가.
//
// 안전 규칙: 쓰는 곳은 _build/login-probe/ 하나뿐이며 끝나면 지운다. CLAUDE_CONFIG_DIR 은 임시 폴더를
// 가리키므로(startPipedLogin) 이 PC 의 클로드 설정·계정·중계기(3456)는 건드리지 않는다. 프로세스는 이
// 스크립트가 띄운 로그인 PID 만 PID 로 끝낸다(이름 기반 종료 없음). 모델 호출 0.
//
// Usage: node verify/login-probe.mjs        인터넷이 필요하다(약 230 MB, 이 PC 실측 16초)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { installClaude, readLock, startLogin, loginStatus } from '../installer/lib/online.mjs';
import { startPipedLogin, pipedLoginInfo } from '../installer/lib/login.mjs';
import { writeReceipt, newReceiptV2 } from '../installer/lib/receipt.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(REPO, '_build', 'login-probe');
const nodeDir = path.dirname(process.execPath);
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const results = [];
const judge = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} -- ${detail}`); };

function freshRoot(name) {
  const root = path.join(WORK, name);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  const tc = path.join(root, 'teamclaude-probe.json');
  fs.writeFileSync(tc, JSON.stringify({ accounts: [] }));
  return { root, tc };
}

async function probeDownloadAndLogin() {
  const { root, tc } = freshRoot('online');
  const lock = readLock({ zipRoot: REPO });
  const want = lock?.parts?.claude ?? {};
  log(`lock claude version=${want.version} bytes=${want.bytes}`);
  let last = -1;
  const got = await installClaude({
    root, nodeDir, lock, subscriptions: ['claude'], log,
    onProgress: (p) => {
      if (!p.total) return;
      const pct = Math.floor((p.done / p.total) * 4) * 25;
      if (pct !== last) { last = pct; log(`download ${p.source} ${pct}%`); }
    },
  });
  judge('① Claude Code 받기', !!got.ok, `state=${got.state} source=${got.source ?? '-'} version=${got.version ?? '-'} code=${got.code ?? '-'}`);
  if (!got.ok) return;

  let pid = null;
  try {
    startPipedLogin({ provider: 'claude', root, nodeDir, teamclaudeConfigPath: tc, log });
    pid = pipedLoginInfo('claude')?.pid ?? null;
    let info = null;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      info = pipedLoginInfo('claude');
      if (info?.url || info?.exited) break;
    }
    const redirect = info?.url ? new URL(info.url).searchParams.get('redirect_uri') : null;
    judge('② 자동 복귀 로그인 주소', !!redirect && /^http:\/\/localhost:\d+\/callback$/.test(redirect),
      `pid=${pid} exited=${info?.exited} redirect_uri=${redirect ?? '-'}`);
  } catch (e) {
    judge('② 자동 복귀 로그인 주소', false, `startPipedLogin threw code=${e?.code} ${e?.message}`);
  } finally {
    if (pid) {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); log(`ended own login pid=${pid}`); }
      catch { log(`own login pid=${pid} already gone`); }
    }
  }
}

async function probeCliMissing() {
  const { root, tc } = freshRoot('no-cli');
  // 영수증이 있어야 startLogin 이 실패를 기록한다(실제 설치에서는 앞 단계가 이미 만들어 둔다).
  writeReceipt(root, newReceiptV2({ root, name: 'login-probe', manifest: {}, createdBy: 'verify/login-probe' }));
  let code = null;
  try { startPipedLogin({ provider: 'claude', root, nodeDir, teamclaudeConfigPath: tc }); } catch (e) { code = e?.code ?? null; }
  judge('③ⓐ CLI 없으면 띄우지 않음', code === 'cli-missing', `code=${code}`);
  const s = await startLogin({ provider: 'claude', root, nodeDir, teamclaudeConfigPath: tc });
  judge('③ⓑ startLogin 안내', s?.state === 'failed' && s?.reason === 'cli-missing' && !!s?.message, `state=${s?.state} reason=${s?.reason}`);
  const st = await loginStatus({ provider: 'claude', root, teamclaudeConfigPath: tc });
  judge('③ⓒ loginStatus 가 기록 유지', st?.state === 'failed' && st?.reason === 'cli-missing', `state=${st?.state} reason=${st?.reason}`);
}

try {
  await probeDownloadAndLogin();
  await probeCliMissing();
} finally {
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { log(`could not remove ${WORK}: ${e?.message}`); }
}
const bad = results.filter((r) => !r.ok).length;
console.log(bad === 0 ? `login-probe OK (${results.length}/${results.length})` : `login-probe FAIL (${results.length - bad}/${results.length})`);
setTimeout(() => process.exit(bad === 0 ? 0 : 1), 200);
