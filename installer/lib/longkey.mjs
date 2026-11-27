// 2.0.66 — 설치 화면의 「1년 열쇠 받기(권장)」 카드 뒤편.
//
// 클로드 로그인이 **완전히 끝난 뒤**(중계기에 계정이 들어간 뒤) 사람이 카드의 「받기」를 눌렀을 때만 움직인다.
// 누르지 않으면 이 모듈은 파일을 하나도 쓰지 않고, 프로그램도 띄우지 않는다.
//
// 하는 일은 하나다: 동봉 node 로 설치본의 `iris-auth\longkey.mjs --account <방금 들어간 계정> --also-iris` 를
// **창 없이** 띄우고, 표준 출력에서 승인 주소 한 줄과 마지막 `RESULT {…}` 한 줄만 읽는다. 열쇠는 그 도구가
// 받아 두 자리(중계기 계정 줄 + 창 세션용 파일)에 직접 쓴다 — 이 모듈은 열쇠를 받지도 읽지도 않는다.
//
// 지키는 것:
//   · 계정 이름(이메일)은 자식 프로세스의 인자로만 넘긴다. 기록에는 "claude account #1" 꼴로만 남긴다.
//     승인 주소에는 계정 귀띔 칸이 있어 기록 · 영수증 · 상태 파일에 넣지 않는다(화면의 링크로만 간다).
//   · 도구의 출력 글은 밖으로 내지 않는다. 화면 글은 까닭 낱말(reason)에서 여기서 만든다.
//   · 끝내는 것은 **자기가 띄운 PID 하나**뿐이다(이름으로 끄지 않는다). 한도 시간이 지나면 그 PID 를 끝내고 실패로 돌린다.
//   · 두 번 눌러도 프로그램은 하나만 돈다. 실패한 뒤 다시 누르면 새로 한 번 띄운다.
//   · 이 카드의 결과는 설치 완료 판정(setupAllDone · onlineDone · resumeVerdict)에 쓰이지 않는다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveTeamclaudeConfigPath } from './login.mjs';

// 도구가 브라우저 승인을 기다리는 시간(초)과, 그보다 조금 긴 이쪽의 한도(도구가 스스로 끝나지 못했을 때만 쓰인다).
export const LONGKEY_APPROVE_SEC = 300;
export const LONGKEY_HARD_LIMIT_MS = (LONGKEY_APPROVE_SEC + 45) * 1000;
// RESULT 를 낸 뒤에도 프로그램이 남아 있으면 이만큼 기다렸다가 그 PID 를 끝낸다.
export const LONGKEY_LINGER_MS = 8000;

const AUTHORIZE_RE = /https:\/\/claude\.ai\/oauth\/authorize\?[^\s"'<>]+/;
const RESULT_RE = /(?:^|\n)RESULT (\{[^\n]*\})\r?\n/;
const SLOT = new Set(['ok', 'skipped', 'failed']);
const REASONS = new Set([
  'timeout', 'denied', 'exchange-failed', 'short-lived', 'account-mismatch', 'usage',
  'relay-config-missing', 'relay-account-missing', 'relay-changed', 'relay-write-failed', 'iris-write-failed',
]);

export function longKeyToolPath(root) {
  return path.join(root, '_agent', 'shared', 'tools', 'iris-auth', 'longkey.mjs');
}
export function irisKeyFilePath(root) {
  return path.join(root, '_agent', 'claude', 'secrets', 'iris-cli-token.json');
}

function ymd(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const KEEP = '지금 로그인은 그대로 쓸 수 있습니다.';
const LATER = '나중에 IRIS 설정 → 계정 · 보안 → 1년 열쇠 받기에서 받을 수 있습니다.';

/** 화면에 보일 한 문장(카드 상태 → 글). 계정 이름 · 열쇠 · 도구의 원문은 들어가지 않는다. 장담하지 않는다. */
export function longKeyMessage({ state, reason = null, slots = null, expiresAt = null } = {}) {
  if (state === 'starting') return '브라우저에 승인 화면을 띄우는 중입니다.';
  if (state === 'approve') return '브라우저에 뜬 화면에서 「승인(Authorize)」을 한 번 눌러 주세요. 누르면 이 칸이 저절로 바뀝니다.';
  if (state === 'done') { const day = ymd(expiresAt); return `1년 열쇠를 받았습니다${day ? `(만료 ${day})` : ''}. 열쇠가 폐기되면 다시 연결하면 됩니다.`; }
  if (state === 'partial') {
    return slots?.relay === 'ok'
      ? `열쇠는 받아 계정 연결에 넣었지만, IRIS 창용 자리에는 넣지 못했습니다. ${KEEP} ${LATER}`
      : `열쇠는 받아 IRIS 창용 자리에 넣었지만, 계정 연결에는 넣지 못했습니다. ${KEEP} ${LATER}`;
  }
  if (state === 'failed') {
    if (reason === 'timeout') return `승인을 기다리다 시간이 지났습니다. ${KEEP} 「다시 받기」를 누르면 처음부터 다시 합니다.`;
    if (reason === 'denied') return `브라우저에서 승인이 취소됐습니다. ${KEEP} 「다시 받기」를 누르면 처음부터 다시 합니다.`;
    if (reason === 'account-mismatch') return `승인한 계정이 방금 로그인한 계정과 달라 넣지 않았습니다. ${KEEP} 같은 계정으로 「다시 받기」를 눌러 주세요.`;
    if (reason === 'short-lived') return `유효 기간이 짧은 열쇠가 나와 넣지 않았습니다. ${KEEP}`;
    if (reason === 'exchange-failed') return `열쇠를 받아 오지 못했습니다(인터넷 또는 Claude 쪽 응답). ${KEEP} 「다시 받기」를 눌러 보세요.`;
    if (reason === 'already') return '이 계정은 이미 1년 열쇠를 쓰고 있습니다. 더 할 일이 없습니다.';
    return `1년 열쇠 받기를 끝내지 못했습니다. ${KEEP} ${LATER}`;
  }
  return null;
}

/**
 * 방금 로그인해 중계기에 들어간 클로드 계정 줄을 고른다. 읽는 것은 이름 · 공급자 · 종류 · 1년 열쇠 표시뿐이다
 * (열쇠 값은 보지 않는다 · 아무것도 쓰지 않는다).
 *   클로드 계정 줄이 하나       → 그 줄
 *   여럿                        → 클로드 프로그램 설정(`_agent\claude\.claude.json`)의 로그인 계정 이름과 같은 줄.
 *                                 그런 줄이 없으면 고르지 않는다(카드를 내지 않는다 — 엉뚱한 계정을 바꾸지 않게).
 * @returns {{ok:boolean, name?:string, ordinal?:number, already?:boolean, reason?:string}}
 */
export function pickClaudeAccount({ root, teamclaudeConfigPath, fs: fsImpl = fs } = {}) {
  let cfg;
  try { cfg = JSON.parse(fsImpl.readFileSync(teamclaudeConfigPath, 'utf8')); } catch { return { ok: false, reason: 'no-config' }; }
  const all = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
  const claude = all.filter((a) => a && typeof a.name === 'string' && a.name && (a.provider ?? 'anthropic') === 'anthropic' && (a.type ?? 'oauth') === 'oauth');
  if (claude.length === 0) return { ok: false, reason: 'no-account' };
  let pick = claude.length === 1 ? claude[0] : null;
  if (!pick) {
    let who = null;
    try { who = JSON.parse(fsImpl.readFileSync(path.join(root, '_agent', 'claude', '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress ?? null; } catch { who = null; }
    if (typeof who === 'string' && who) pick = claude.find((a) => a.name.toLowerCase() === who.toLowerCase()) ?? null;
    if (!pick) return { ok: false, reason: 'ambiguous' };
  }
  let irisFile = false;
  try { irisFile = fsImpl.existsSync(irisKeyFilePath(root)); } catch { irisFile = false; }
  return { ok: true, name: pick.name, ordinal: claude.indexOf(pick) + 1, already: pick.irisLongKey === true && irisFile };
}

function nodeExeOf(root, nodeDir) {
  return path.join(nodeDir ?? path.join(root, '_agent', 'shared', 'tools', 'node'), 'node.exe');
}

/** 카드를 낼 수 있는가(읽기만). → { available, reason } — reason: no-tool · no-node · no-config · no-account · ambiguous · already */
export function longKeyAvailability({
  root, nodeDir, teamclaudeConfigPath,
  resolveConfigPathFn = resolveTeamclaudeConfigPath, existsFn = fs.existsSync, fs: fsImpl = fs,
} = {}) {
  try {
    if (!root) return { available: false, reason: 'no-root' };
    if (!existsFn(longKeyToolPath(root))) return { available: false, reason: 'no-tool' };
    if (!existsFn(nodeExeOf(root, nodeDir))) return { available: false, reason: 'no-node' };
    const pick = pickClaudeAccount({ root, teamclaudeConfigPath: teamclaudeConfigPath ?? resolveConfigPathFn({ root }), fs: fsImpl });
    if (!pick.ok) return { available: false, reason: pick.reason };
    if (pick.already) return { available: false, reason: 'already' };
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

/** 도구의 RESULT 한 줄 → 이 모듈이 다루는 결과. 아는 값만 받는다(도구의 글 · 모르는 칸은 버린다). */
export function parseLongKeyResult(text) {
  const m = RESULT_RE.exec(String(text ?? ''));
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[1]); } catch { return { state: 'failed', slots: { relay: 'skipped', iris: 'skipped' }, expiresAt: null, reason: 'bad-result' }; }
  const slots = { relay: SLOT.has(j?.relay) ? j.relay : 'skipped', iris: SLOT.has(j?.iris) ? j.iris : 'skipped' };
  const both = slots.relay === 'ok' && slots.iris === 'ok';
  const one = slots.relay === 'ok' || slots.iris === 'ok';
  const state = j?.ok === true && both ? 'done' : (one ? 'partial' : 'failed');
  const expiresAt = one && Number.isFinite(Number(j?.expiresAt)) && Number(j.expiresAt) > 0 ? Number(j.expiresAt) : null;
  const reason = state === 'done' ? null : (REASONS.has(j?.reason) ? j.reason : 'failed');
  return { state, slots, expiresAt, reason };
}

const jobs = new Map(); // 영혼 루트(소문자) → 일 하나
const jobKey = (root) => String(root ?? '').toLowerCase();
/** 시험용: 기억을 비운다(프로그램을 끝내지는 않는다). */
export function resetLongKey() { for (const j of jobs.values()) { clearTimeout(j.timer); clearTimeout(j.linger); } jobs.clear(); }

function publicResult(job) {
  return { state: job.state, slots: job.slots, expiresAt: job.expiresAt, reason: job.reason };
}

/**
 * 「받기」. 프로그램을 창 없이 띄우고 곧바로 돌아온다(승인은 사람이 브라우저에서 한다 — 결과는 longKeyStatus 로).
 * onFinish(결과) = 끝났을 때 한 번(성공 · 일부 · 실패). 서버가 영수증에 한 줄 적는 데 쓴다. 서버를 닫으며 끝낸 때는 부르지 않는다.
 * @returns {{ok:boolean, state:string, already?:boolean, reason?:string, message?:string}}
 */
export function startLongKey({
  root, nodeDir, teamclaudeConfigPath,
  spawnFn = spawn, killFn = defaultKillTree, existsFn = fs.existsSync, fs: fsImpl = fs,
  resolveConfigPathFn = resolveTeamclaudeConfigPath,
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
  if (!root) return refuse('no-root');
  const tool = longKeyToolPath(root);
  const nodeExe = nodeExeOf(root, nodeDir);
  if (!existsFn(tool)) return refuse('no-tool');
  if (!existsFn(nodeExe)) return refuse('no-node');
  const configPath = teamclaudeConfigPath ?? resolveConfigPathFn({ root });
  const pick = pickClaudeAccount({ root, teamclaudeConfigPath: configPath, fs: fsImpl });
  if (!pick.ok) return refuse(pick.reason);
  if (pick.already) return refuse('already');

  // 도구가 볼 자리를 이 영혼의 것으로 못 박는다(설치기 프로세스에는 방금 쓴 사용자 환경 변수가 아직 없다).
  const childEnv = { ...env, TEAMCLAUDE_CONFIG: configPath, CLAUDE_CONFIG_DIR: path.join(root, '_agent', 'claude') };
  delete childEnv.IRIS_LONGKEY_FILE;
  // IRIS 가 띄우는 Node 는 윈도우 인증서도 믿는다(2.0.62 — 비어 있을 때만 채운다).
  if (childEnv.NODE_USE_SYSTEM_CA == null || childEnv.NODE_USE_SYSTEM_CA === '') childEnv.NODE_USE_SYSTEM_CA = '1';

  const job = {
    key, pid: null, ordinal: pick.ordinal, startedAt: now(), finishedAt: null,
    state: 'starting', url: null, slots: null, expiresAt: null, reason: null,
    finished: false, exited: false, buf: '', timer: null, linger: null,
  };
  const settle = (outcome, { silent = false } = {}) => {
    if (job.finished) return;
    job.finished = true;
    job.finishedAt = now();
    clearTimeout(job.timer);
    Object.assign(job, { state: outcome.state, slots: outcome.slots ?? { relay: 'skipped', iris: 'skipped' }, expiresAt: outcome.expiresAt ?? null, reason: outcome.reason ?? null });
    job.buf = '';
    log(`longkey claude account #${job.ordinal} ${job.state} relay=${job.slots.relay} iris=${job.slots.iris}${job.reason ? ` reason=${job.reason}` : ''}`);
    if (!silent && typeof onFinish === 'function') { try { onFinish(publicResult(job)); } catch { /* 영수증 한 줄이 실패해도 카드 결과는 그대로 */ } }
  };
  const killOwn = () => { if (job.pid && !job.exited) { try { killFn(job.pid); } catch { /* 이미 끝남 */ } } };
  job.settle = settle;
  job.killOwn = killOwn;

  let child;
  try {
    child = spawnFn(nodeExe, [tool, '--account', pick.name, '--also-iris', '--timeout', String(approveSec)], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
    });
  } catch (err) {
    log(`longkey spawn failed: ${String(err?.code ?? 'error')}`);
    return refuse('spawn-failed');
  }
  job.pid = child?.pid ?? null;
  jobs.set(key, job);
  log(`longkey claude account #${job.ordinal} started pid=${job.pid ?? '?'}`);

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
  child?.on?.('exit', (code) => {
    job.exited = true;
    clearTimeout(job.linger);
    if (!job.finished) settle({ state: 'failed', reason: 'exited' });
    log(`longkey process exited code=${code ?? '?'}`);
  });
  child?.on?.('error', (e) => {
    job.exited = true;
    if (!job.finished) settle({ state: 'failed', reason: 'spawn-failed' });
    log(`longkey process error: ${String(e?.code ?? 'error')}`);
  });
  job.timer = setTimeout(() => {
    if (job.finished) return;
    log(`longkey limit reached -- stopping own process pid=${job.pid ?? '?'}`);
    killOwn();
    settle({ state: 'failed', reason: 'timeout' });
  }, hardLimitMs);
  job.timer.unref?.();
  return { ok: true, state: 'starting', already: false };
}

/** 지금 상태(읽기만). 시작한 적 없으면 state:'idle'. url 에는 계정 귀띔 칸이 있다 — 화면의 링크로만 쓰고 기록하지 않는다. */
export function longKeyStatus({ root } = {}) {
  const job = jobs.get(jobKey(root));
  if (!job) return { state: 'idle', url: null, startedAt: null, finishedAt: null, slots: null, expiresAt: null, reason: null, message: null };
  return {
    state: job.state,
    url: job.finished ? null : job.url,
    startedAt: job.startedAt, finishedAt: job.finishedAt,
    slots: job.slots, expiresAt: job.expiresAt, reason: job.reason,
    message: longKeyMessage(job),
  };
}

/**
 * 설치 창이 닫힐 때(서버 종료) 부른다. 자기가 띄운 PID 만 끝내고, 아무것도 적지 않는다(onFinish 를 부르지 않는다).
 * 승인 전에 끝내면 어느 자리도 바뀌지 않았다. 이미 쓴 자리가 있으면 그 자리의 열쇠는 그대로 유효하다.
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
