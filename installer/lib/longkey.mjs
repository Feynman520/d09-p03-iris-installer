// 2.0.66 — 설치 화면의 「1년 열쇠 받기(권장)」 카드 뒤편.
//
// 받는 것은 **IRIS 창 세션용 1년 열쇠 하나**다(`<영혼>\_agent\claude\secrets\iris-cli-token.json`) — IRIS 창의
// 설정 → 계정 · 보안 → 「1년 열쇠 받기」가 받는 것과 같은 열쇠, 같은 도구, 같은 길이다. **중계기 설정(계정 줄)은 쓰지 않는다**
// (2026-11-28 코드 검토: 도구가 중계기 설정을 고쳐 쓰는 동안 중계기가 다른 계정의 갱신 열쇠를 저장하면 그 저장이 덮일 수 있다.
//  중계기 쪽 창구 없이는 막을 수 없어 이번 판에서는 그 자리를 건드리지 않는다).
//
// 클로드 로그인이 **완전히 끝난 뒤** 사람이 카드의 「받기」를 눌렀을 때만 움직인다. 누르지 않으면 이 모듈은 파일을 하나도
// 쓰지 않고, 프로그램도 띄우지 않는다.
//
// 하는 일은 하나다: 동봉 node 로 설치본의 `iris-auth\longkey.mjs` 를 **창 없이** 띄우고(IRIS 창 `daemon\auth.mjs` 가 띄우는
// 꼴 그대로 — 계정 인자 없음), 표준 출력에서 승인 주소 한 줄과 마지막 `RESULT {…}` 한 줄만 읽는다. 열쇠는 그 도구가 받아 직접
// 쓴다 — 이 모듈은 열쇠를 받지도 읽지도 않는다.
//
// 지키는 것:
//   · 계정 이름을 도구에 넘기지 않는다(`--hint` · `--account` 없음) → 승인 주소에 계정 귀띔 칸이 없다. 그래도 승인 주소 ·
//     도구의 출력 글 · `RESULT` 의 계정 칸은 기록 · 영수증 · 상태 파일에 넣지 않는다(주소는 화면의 링크로만 간다).
//   · 화면 글은 까닭 낱말(reason)에서 여기서 만든다 — 도구의 글을 그대로 내지 않는다.
//   · 끝내는 것은 **자기가 띄운 PID 하나**뿐이다(이름으로 끄지 않는다). 한도 시간이 지나면 그 PID 를 끝내고 실패로 돌린다.
//   · 프로그램은 **딸린 프로세스로**(detached 아님) 띄운다. 윈도우에서 Node 는 그런 자식을 "부모가 사라지면 함께 끝나는"
//     작업 묶음에 넣으므로, 설치기 서버가 강제로 죽어도 자식이 남지 않는다(시험 = tests/online-longkey.test.mjs 맨 끝).
//   · 실패 확정은 프로그램의 출력이 **다 닫힌 뒤**(close)에 한다 — 끝났다는 신호(exit)가 마지막 출력보다 먼저 올 수 있다.
//   · 두 번 눌러도 프로그램은 하나만 돈다. 실패한 뒤 다시 누르면 새로 한 번 띄운다.
//   · 이 카드의 결과는 설치 완료 판정(setupAllDone · onlineDone · resumeVerdict)에 쓰이지 않는다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 도구가 브라우저 승인을 기다리는 시간(초)과, 그보다 조금 긴 이쪽의 한도. 이 한도는 두 경우의 상한이다:
// 도구가 스스로 끝나지 못했을 때, 그리고 끝났다는 신호(exit)는 왔는데 출력이 닫혔다는 신호(close)가 끝내 오지 않을 때.
// (exit 뒤에 따로 짧은 여유를 두고 실패를 확정하지 않는다 — 그 뒤에 늦게 온 RESULT 를 버리게 된다.)
export const LONGKEY_APPROVE_SEC = 300;
export const LONGKEY_HARD_LIMIT_MS = (LONGKEY_APPROVE_SEC + 45) * 1000;
// RESULT 를 낸 뒤에도 프로그램이 남아 있으면 이만큼 기다렸다가 그 PID 를 끝낸다.
export const LONGKEY_LINGER_MS = 8000;

const AUTHORIZE_RE = /https:\/\/claude\.ai\/oauth\/authorize\?[^\s"'<>]+/;
const RESULT_RE = /(?:^|\n)RESULT (\{[^\n]*\})\r?\n/;

export function longKeyToolPath(root) {
  return path.join(root, '_agent', 'shared', 'tools', 'iris-auth', 'longkey.mjs');
}

function ymd(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const KEEP = '지금 로그인은 그대로 쓸 수 있습니다.';
const LATER = '나중에 IRIS 창의 설정 → 계정 · 보안에서도 받을 수 있습니다.';

/** 화면에 보일 한 문장(카드 상태 → 글). 계정 이름 · 열쇠 · 도구의 원문은 들어가지 않는다. 장담하지 않는다. */
export function longKeyMessage({ state, reason = null, expiresAt = null } = {}) {
  if (state === 'starting') return '브라우저에 승인 화면을 띄우는 중입니다.';
  if (state === 'approve') return '브라우저에 뜬 화면에서 「승인(Authorize)」을 한 번 눌러 주세요. 누르면 이 칸이 저절로 바뀝니다.';
  if (state === 'done') { const day = ymd(expiresAt); return `1년 열쇠를 받았습니다${day ? `(만료 ${day})` : ''}. IRIS 창의 새 대화부터 이 열쇠를 씁니다.`; }
  if (state === 'failed') {
    if (reason === 'timeout') return `승인을 기다리다 시간이 지났습니다. ${KEEP} 「다시 받기」를 누르면 처음부터 다시 합니다.`;
    if (reason === 'denied') return `브라우저에서 승인이 취소됐습니다. ${KEEP} 「다시 받기」를 누르면 처음부터 다시 합니다.`;
    if (reason === 'short-lived') return `유효 기간이 짧은 열쇠가 나와 넣지 않았습니다. ${KEEP}`;
    if (reason === 'exchange-failed') return `열쇠를 받아 오지 못했습니다(인터넷 또는 Claude 쪽 응답). ${KEEP} 「다시 받기」를 눌러 보세요.`;
    return `1년 열쇠 받기를 끝내지 못했습니다. ${KEEP} ${LATER}`;
  }
  return null;
}

function nodeExeOf(root, nodeDir) {
  return path.join(nodeDir ?? path.join(root, '_agent', 'shared', 'tools', 'node'), 'node.exe');
}

/** 카드를 낼 수 있는가(파일이 있는지만 본다). → { available, reason } — reason: no-root · no-tool · no-node */
export function longKeyAvailability({ root, nodeDir, existsFn = fs.existsSync } = {}) {
  try {
    if (!root) return { available: false, reason: 'no-root' };
    if (!existsFn(longKeyToolPath(root))) return { available: false, reason: 'no-tool' };
    if (!existsFn(nodeExeOf(root, nodeDir))) return { available: false, reason: 'no-node' };
    return { available: true, reason: null };
  } catch {
    return { available: false, reason: 'unreadable' };
  }
}

/** 이 설치기가 띄운 그 프로그램 하나(PID 지정)와 그 자식만 끝낸다 — 이름으로 끄지 않는다. */
function defaultKillTree(pid) {
  if (!pid) return;
  try {
    const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => {}); k.unref();
  } catch { /* 이미 끝났으면 그만 */ }
}

// 도구(2.0.65 에 실린 판 그대로)의 실패 글 → 까닭 한 낱말. 글 자체는 밖으로 내지 않는다.
function reasonOf(error) {
  const s = String(error ?? '');
  if (/시간 초과/.test(s)) return 'timeout';
  if (/승인 거절|state 불일치|코드 없음/.test(s)) return 'denied';
  if (/짧게 발급/.test(s)) return 'short-lived';
  if (/열쇠 교환 실패|응답에 열쇠가 없음/.test(s)) return 'exchange-failed';
  return 'failed';
}

/**
 * 도구의 RESULT 한 줄 → 이 모듈이 다루는 결과. 받는 것은 됐는가(ok) · 만료 시각뿐이다
 * (계정 칸 · 권한 칸 · 실패 글은 버린다 — 실패 글에서는 까닭 한 낱말만 고른다).
 * IRIS 세션용 길의 약속: 성공 = {"ok":true,"expiresAt":<ms>,…} · 실패 = {"ok":false,"error":"…"}.
 */
export function parseLongKeyResult(text) {
  const m = RESULT_RE.exec(String(text ?? ''));
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[1]); } catch { return { state: 'failed', expiresAt: null, reason: 'bad-result' }; }
  if (j?.ok === true) {
    const ms = Number(j.expiresAt);
    return { state: 'done', expiresAt: Number.isFinite(ms) && ms > 0 ? ms : null, reason: null };
  }
  return { state: 'failed', expiresAt: null, reason: reasonOf(j?.error) };
}

const jobs = new Map(); // 영혼 루트(소문자) → 일 하나
const jobKey = (root) => String(root ?? '').toLowerCase();
/** 시험용: 기억을 비운다(프로그램을 끝내지는 않는다). */
export function resetLongKey() { for (const j of jobs.values()) { clearTimeout(j.timer); clearTimeout(j.linger); } jobs.clear(); }

function publicResult(job) {
  return { state: job.state, expiresAt: job.expiresAt, reason: job.reason };
}

/**
 * 「받기」. 프로그램을 창 없이 띄우고 곧바로 돌아온다(승인은 사람이 브라우저에서 한다 — 결과는 longKeyStatus 로).
 * onFinish(결과) = 끝났을 때 한 번(성공 · 실패). 서버가 영수증에 한 줄 적는 데 쓴다. 서버를 닫으며 끝낸 때는 부르지 않는다.
 * @returns {{ok:boolean, state:string, already?:boolean, reason?:string, message?:string}}
 */
export function startLongKey({
  root, nodeDir,
  spawnFn = spawn, killFn = defaultKillTree, existsFn = fs.existsSync,
  approveSec = LONGKEY_APPROVE_SEC, hardLimitMs = LONGKEY_HARD_LIMIT_MS, lingerMs = LONGKEY_LINGER_MS,
  env = process.env, now = () => Date.now(), log = () => {}, onFinish = null,
} = {}) {
  const key = jobKey(root);
  const cur = jobs.get(key);
  // 두 번 눌러도 하나만: 돌고 있으면 그 일을 그대로 돌려준다.
  if (cur && !cur.finished) return { ok: true, state: cur.state, already: true };

  const refuse = (reason) => {
    log(`longkey not started: ${reason}`);
    return { ok: false, state: 'failed', reason, message: longKeyMessage({ state: 'failed', reason }) };
  };
  const avail = longKeyAvailability({ root, nodeDir, existsFn });
  if (!avail.available) return refuse(avail.reason);
  const tool = longKeyToolPath(root);
  const nodeExe = nodeExeOf(root, nodeDir);

  // 도구가 쓸 자리를 이 영혼의 것으로 못 박는다(설치기 프로세스에는 방금 쓴 사용자 환경 변수가 아직 없다).
  const childEnv = { ...env, CLAUDE_CONFIG_DIR: path.join(root, '_agent', 'claude') };
  delete childEnv.IRIS_LONGKEY_FILE;
  // IRIS 가 띄우는 Node 는 윈도우 인증서도 믿는다(2.0.62 — 비어 있을 때만 채운다).
  if (childEnv.NODE_USE_SYSTEM_CA == null || childEnv.NODE_USE_SYSTEM_CA === '') childEnv.NODE_USE_SYSTEM_CA = '1';

  const job = {
    key, pid: null, startedAt: now(), finishedAt: null,
    state: 'starting', url: null, expiresAt: null, reason: null,
    finished: false, exited: false, buf: '', timer: null, linger: null,
  };
  const settle = (outcome, { silent = false } = {}) => {
    if (job.finished) return;
    job.finished = true;
    job.finishedAt = now();
    clearTimeout(job.timer);
    Object.assign(job, { state: outcome.state, expiresAt: outcome.expiresAt ?? null, reason: outcome.reason ?? null });
    job.buf = '';
    log(`longkey ${job.state}${job.reason ? ` reason=${job.reason}` : ''}`);
    if (!silent && typeof onFinish === 'function') { try { onFinish(publicResult(job)); } catch { /* 영수증 한 줄이 실패해도 카드 결과는 그대로 */ } }
  };
  const killOwn = () => { if (job.pid && !job.exited) { try { killFn(job.pid); } catch { /* 이미 끝남 */ } } };
  job.settle = settle;
  job.killOwn = killOwn;

  let child;
  try {
    // 인자는 한도 시간 하나뿐이다 — IRIS 창이 이 도구를 띄우는 꼴(인자 없음)에 기다림 한도만 더했다.
    child = spawnFn(nodeExe, [tool, '--timeout', String(approveSec)], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
    });
  } catch (err) {
    log(`longkey spawn failed: ${String(err?.code ?? 'error')}`);
    return refuse('spawn-failed');
  }
  job.pid = child?.pid ?? null;
  jobs.set(key, job);
  log(`longkey started pid=${job.pid ?? '?'}`);

  const onData = (chunk) => {
    if (job.finished) return;
    job.buf = (job.buf + String(chunk)).slice(-32768);
    if (!job.url) {
      const m = AUTHORIZE_RE.exec(job.buf);
      if (m) { job.url = m[0]; job.state = 'approve'; log('longkey approval address ready'); }
    }
    const parsed = parseLongKeyResult(job.buf);
    if (!parsed) return;
    settle(parsed);
    // 결과를 낸 프로그램은 곧 스스로 끝난다. 남아 있으면 그 PID 만 끝낸다.
    job.linger = setTimeout(killOwn, lingerMs);
    job.linger.unref?.();
  };
  child?.stdout?.on?.('data', onData);
  child?.stderr?.on?.('data', () => { /* 읽고 버린다 — 파이프가 차서 멈추지 않게 */ });
  // exit = 프로그램이 끝났다는 사실만 적는다. 마지막 출력(RESULT)이 그 뒤에 — 얼마나 늦게든 — 올 수 있으므로
  // 여기서도, 여기서 건 타이머로도 실패를 확정하지 않는다. 결과 없는 실패는 아래 close 만 확정한다
  // (close 가 끝내 오지 않으면 맨 아래의 한도 시간이 상한이다).
  child?.on?.('exit', (code) => {
    job.exited = true;
    clearTimeout(job.linger);
    log(`longkey process exited code=${code ?? '?'}`);
  });
  // close = 출력까지 다 닫혔다. 여기까지 결과 줄이 없었으면 그때 실패다.
  child?.on?.('close', () => {
    job.exited = true;
    if (!job.finished) settle({ state: 'failed', reason: 'exited' });
  });
  child?.on?.('error', (e) => {
    job.exited = true;
    if (!job.finished) settle({ state: 'failed', reason: 'spawn-failed' });
    log(`longkey process error: ${String(e?.code ?? 'error')}`);
  });
  job.timer = setTimeout(() => {
    if (job.finished) return;
    // 프로그램이 아직 돌고 있으면 그 PID 만 끝내고 시간 초과로, 이미 끝났는데(exit) 출력이 닫히지 않은 채였으면 "결과 없이 끝남"으로.
    const gone = job.exited;
    log(gone ? 'longkey limit reached -- process had exited without a result' : `longkey limit reached -- stopping own process pid=${job.pid ?? '?'}`);
    killOwn();
    settle({ state: 'failed', reason: gone ? 'exited' : 'timeout' });
  }, hardLimitMs);
  job.timer.unref?.();
  return { ok: true, state: 'starting', already: false };
}

/** 지금 상태(읽기만). 시작한 적 없으면 state:'idle'. url(승인 주소)은 화면의 링크로만 쓰고 기록하지 않는다. */
export function longKeyStatus({ root } = {}) {
  const job = jobs.get(jobKey(root));
  if (!job) return { state: 'idle', url: null, startedAt: null, finishedAt: null, expiresAt: null, reason: null, message: null };
  return {
    state: job.state,
    url: job.finished ? null : job.url,
    startedAt: job.startedAt, finishedAt: job.finishedAt,
    expiresAt: job.expiresAt, reason: job.reason,
    message: longKeyMessage(job),
  };
}

/**
 * 설치 창이 닫힐 때(서버 종료) 부른다. 자기가 띄운 PID 만 끝내고, 아무것도 적지 않는다(onFinish 를 부르지 않는다).
 * 승인 전에 끝내면 아무것도 바뀌지 않았다. (서버 프로세스가 이 함수를 부르지 못하고 죽어도, 딸린 프로세스로 띄웠으므로
 * 윈도우가 자식을 함께 끝낸다 — 머리말.)
 */
export function stopLongKey({ root } = {}) {
  const job = jobs.get(jobKey(root));
  if (!job) return { stopped: false };
  clearTimeout(job.linger);
  const running = !job.exited && job.pid != null;
  if (running) job.killOwn();
  if (!job.finished) job.settle({ state: 'failed', reason: 'stopped' }, { silent: true });
  return { stopped: running, pid: running ? job.pid : null };
}
