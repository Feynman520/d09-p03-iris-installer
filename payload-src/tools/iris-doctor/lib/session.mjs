// IRIS Doctor — 터미널 대화 흐름(start). 창 · 데몬 · 중계기 없이 이 터미널 하나로 돈다.
// 제1원칙(먹통일 때도 돈다)에 맞춘 약속:
//   · 차림표가 먼저 뜬다. 검진은 뒤에서 돌고, 검진이 멎거나 실패해도 차림표는 그대로 쓸 수 있다.
//   · 연결이 없어도 · 카드가 깨졌어도 · 다른 연결 작업이 잠금을 쥐고 있어도 · 권한을 못 걸었어도 검진과 안내는 된다.
//   · 어떤 일이 실패해도 차림표로 돌아온다(이 프로세스를 끝내는 함수를 여기서 부르지 않는다).
//   · 화면에 열쇠 값 · 이메일 원문 · 프로그램이 낸 글의 원문을 싣지 않는다(명령 쪽이 이미 걸러 준 글만 보인다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runInChild } from './deadline.mjs';
import { renderText, localStamp } from './report.mjs';
import { makeContext } from './context.mjs';
import { runCommand, autoPrepare } from './commands.mjs';
import { linkStatus } from './link.mjs';
import { makeGuard, checkShipped } from './integrity.mjs';
import { treat as defaultTreat } from './treat/flow.mjs';
import { VERSION } from './diagnose.mjs';
import { note, saveCheckup } from './journal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIAG_MS = 90_000;
const NAME = { claude: '클로드', codex: '코덱스' };
const STATE_KO = { none: '연결 안 됨', card: '연결됨(실제 연결 미확인)', ready: '준비됨', expired: '열쇠 만료', unreadable: '연결 파일을 읽지 못함' };
const usable = (st) => st === 'card' || st === 'ready';
const LINE = '────────────────────────────────────────────────────────';

/** 연결된 서비스를 쓸 차례대로. 둘이면 최근에 실제 연결에 성공한 쪽 먼저(같으면 클로드). */
export function pickServices(status) {
  const list = ['claude', 'codex'].filter((k) => usable(status?.[k]?.state));
  const t = (k) => { const n = Date.parse(status[k].lastOkAt || ''); return Number.isFinite(n) ? n : 0; };
  return list.sort((a, b) => t(b) - t(a));
}

// 서비스를 바꿔도 낫지 않는 실패(둘이 함께 쓰는 것이 깨짐 · 다른 연결 작업이 진행 중) — 이런 때는 다른 서비스로 넘어가지 않는다
const SHARED_PROBLEMS = new Set(['workdir-missing', 'forbidden-variable', 'path-has-shims']);
export const sharedFailure = (r) => r?.why === 'busy' || (r?.why === 'blocked' && (r.problems || []).some((p) => SHARED_PROBLEMS.has(p)));

/**
 * 연결 확인: 차례대로, 서비스마다 한 번만. 실패하면 다른 서비스로 한 번 넘어가며 그 사실을 알린다.
 * → { ok, used, tried: [{ kind, ok, text }], switched, shared }
 */
export async function checkConnection({ order, command, now = Date.now() }) {
  const tried = [];
  for (const kind of order.slice(0, 2)) {
    let r;
    try { r = await command('probe', kind, { now }); } catch { r = { text: `${NAME[kind]} 연결 확인을 끝내지 못했습니다.\n`, code: 2, why: 'failed' }; }
    tried.push({ kind, ok: r.code === 0, text: r.text });
    if (r.code === 0) return { ok: true, used: kind, tried, switched: tried.length > 1, shared: false };
    if (sharedFailure(r)) return { ok: false, used: null, tried, switched: false, shared: true };
  }
  return { ok: false, used: null, tried, switched: tried.length > 1, shared: false };
}

// 이 세션이 떴다는 표시(창 안에서 띄운 쪽 · 시작 파일이 "Doctor 가 실제로 떴는가"를 이것으로 확인한다). 임시 폴더의 정해진 이름만 쓴다.
const sessionFile = (pid = process.pid) => path.join(os.tmpdir(), `iris-doctor-session-${pid}.json`);
function markReady(env = process.env) {
  try { fs.writeFileSync(sessionFile(), JSON.stringify({ pid: process.pid, ppid: process.ppid, startedAt: new Date().toISOString(), version: VERSION })); } catch {}
  // 시작 파일(IRIS Doctor.cmd)이 정해 준 표시 파일 — 임시 폴더 바로 아래의 정해진 이름일 때만 만든다(환경 변수가 가리킨다고 아무 데나 쓰지 않는다)
  const f = env.IRIS_DOCTOR_READY;
  try { if (typeof f === 'string' && /^iris-doctor-ready-\d+\.flag$/.test(path.basename(f)) && path.resolve(path.dirname(f)).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase()) fs.writeFileSync(f, String(process.pid)); } catch {}
  // 하루 넘은 옛 표시(비정상 종료로 남은 것)는 치운다
  try { for (const n of fs.readdirSync(os.tmpdir())) if (/^iris-doctor-(session-\d+\.json|ready-\d+\.flag)$/.test(n)) { const p = path.join(os.tmpdir(), n); if (Date.now() - fs.statSync(p).mtimeMs > 86400_000) fs.rmSync(p, { force: true }); } } catch {}
}
const clearReady = () => { try { fs.rmSync(sessionFile(), { force: true }); } catch {} };

const defaultDiagnose = (ctx, { onChild } = {}) => runInChild(path.join(HERE, 'worker.mjs'), { offline: false, root: ctx?.root || null, only: null }, DIAG_MS, { onChild });
// 에이전트 프로그램 업데이트가 진행 중인가(설치본의 업데이트기가 두는 잠금 파일) — 그동안에는 바뀐 파일을 옛 것으로 되돌리지 않는다
const updateInProgress = (ctx) => { try { return !!ctx?.root && fs.existsSync(path.join(ctx.root, '_agent', 'setup', 'agent-update.lock')); } catch { return false; } };
// 손 없는 계정 준비: 클로드 카드가 아예 없고 IRIS 1년 열쇠가 있으면 그 사본으로 카드를 만든다(통신 0 · 실제 확인 호출 0 — lib/link.mjs autoLinkClaude).
// 이미 카드가 있거나 열쇠가 없으면 아무것도 쓰지 않는다. 실제로 만든 때만 장부 한 줄.
const defaultAutoLink = (ctx, { now }) => autoPrepare({ root: ctx?.root, ctx, now, which: 'claude', from: 'terminal' });

/**
 * 대화 흐름 한 번. → 종료 코드(0 = 사용자가 닫음)
 * 입력 · 출력 · 검진 · 명령 · 치료는 바꿔 낄 수 있다(시험, 그리고 걸음 ④의 치료).
 */
export async function runSession({ ctx = null, input = process.stdin, output = process.stdout, now = () => Date.now(), diagnoseFn = defaultDiagnose, command = null, treat = null, guard = null, env = process.env, shippedCheck = null, autoLink = defaultAutoLink } = {}) {
  const say = (t = '') => { try { output.write(`${t}\n`); } catch {} };
  try { ctx = ctx || makeContext({}); } catch { ctx = { root: null }; }
  const cmd = command || ((c, s, o = {}) => runCommand(c, s, { ...o, ctx }));
  try { guard = guard || makeGuard({ dir: path.dirname(HERE), updating: () => updateInProgress(ctx) }); } catch { guard = { check: () => ({ ok: true }), tripped: false, files: 0 }; }
  const kids = new Set(); // 뒤에서 도는 검진 자식들 — 이 흐름이 끝날 때 함께 끝낸다(제한 시간 장치는 이 프로세스가 살아 있을 때만 돈다)
  const onChild = (c) => { kids.add(c); c.on?.('close', () => kids.delete(c)); };
  markReady(env);
  note({ root: ctx?.root, kind: 'open', from: 'terminal', now: now() });

  const rl = readline.createInterface({ input, output, terminal: !!output.isTTY });
  let closed = false; const waiting = [];
  rl.on('close', () => { closed = true; for (const w of waiting.splice(0)) w(null); });
  const ask = (q) => new Promise((res) => { if (closed) return res(null); waiting.push(res); rl.question(q, (a) => { const i = waiting.indexOf(res); if (i >= 0) waiting.splice(i, 1); res(String(a).trim()); }); });

  // ── 검진: 뒤에서 돈다. 끝나면 한 줄 알린다. 멎거나 실패해도 차림표는 그대로.
  const diag = { state: 'idle', report: null, at: null, run: 0 };
  const summary = () => {
    if (diag.state === 'running') return '검진: 진행 중 …(끝나면 알려 드립니다 — 기다리지 않고 아래 번호를 눌러도 됩니다)';
    if (diag.state === 'failed') return '검진: 끝내지 못했습니다([3]으로 다시 해 볼 수 있습니다)';
    if (!diag.report) return '검진: 아직 하지 않음';
    const c = diag.report.summary;
    return `검진(${localStamp(diag.at)}): 정상 ${c.ok} · 주의 ${c.warn} · 고장 ${c.bad} · 모름 ${c.unknown}`;
  };
  const startDiagnosis = () => {
    if (diag.state === 'running') return;
    const mine = ++diag.run; diag.state = 'running';
    Promise.resolve().then(() => diagnoseFn(ctx, { onChild })).then((r) => {
      if (mine !== diag.run) return;
      if (r?.ok && r.value && Array.isArray(r.value.findings)) { diag.state = 'done'; diag.report = r.value; diag.at = new Date(now()).toISOString(); saveCheckup({ root: ctx?.root, report: r.value, from: 'terminal', now: now() }); }
      else { diag.state = 'failed'; note({ root: ctx?.root, kind: 'checkup-failed', from: 'terminal', now: now() }); }
    }, () => { if (mine === diag.run) { diag.state = 'failed'; note({ root: ctx?.root, kind: 'checkup-failed', from: 'terminal', now: now() }); } }).then(() => { if (mine === diag.run && !closed) { say(''); say(`[알림] ${summary()}`); try { rl.prompt(true); } catch {} } });
  };

  const status = () => { try { return ctx.root ? linkStatus({ root: ctx.root, now: now() }) : null; } catch { return null; } };
  const statusLine = (s) => (s ? `연결: 클로드 ${STATE_KO[s.claude.state] || '모름'} · 코덱스 ${STATE_KO[s.codex.state] || '모름'}` : '연결: 상태를 읽지 못했습니다(검진은 됩니다)');

  // 에이전트를 띄운 일이 끝날 때마다 Doctor 자기 파일을 다시 본다(바뀌었으면 되돌리고 알린다)
  const afterAgent = () => {
    let g; try { g = guard.check(); } catch { return; }
    if (g.ok) return;
    if (g.updated) return say('[보호] Doctor 프로그램이 업데이트로 바뀌었습니다 — 이 창을 닫고 다시 열어 주세요(이 실행에서는 치료를 시작하지 않습니다. 검진과 안내는 됩니다).');
    const n = (g.restored?.length || 0) + (g.aside?.length || 0);
    if (n) say(`[보호] Doctor 의 프로그램 파일 ${n}개가 바뀐 것을 알아채고 처음 상태로 되돌렸습니다.`);
    if (g.failed?.length || g.nodeChanged) say('[보호] 되돌리지 못한 것이 있습니다 — 이 실행에서는 치료를 시작하지 않습니다(검진과 안내는 됩니다). Doctor 를 닫고 다시 열어 주세요. 그래도 같으면 iris-workspace.com 의 「설치」에서 설치 프로그램을 받아 실행해 주세요(새 판이면 업데이트하면서 Doctor 도 다시 놓입니다).');
  };
  const safely = async (fn) => { try { await fn(); } catch { say('그 일을 끝내지 못했습니다 — 차림표로 돌아갑니다.'); } };

  // 치료 쪽이 "지금 다시 검진해 그 검진표를 달라"고 할 때(기다린다). 뒤에서 돌던 검진은 버리고 새로 돈다. → 검진표 | null
  const rediagnose = async () => {
    const mine = ++diag.run; diag.state = 'running';
    let r = null; try { r = await diagnoseFn(ctx, { onChild }); } catch {}
    const ok = !!(r?.ok && r.value && Array.isArray(r.value.findings));
    if (mine === diag.run) { if (ok) { diag.state = 'done'; diag.report = r.value; diag.at = new Date(now()).toISOString(); } else diag.state = 'failed'; }
    // 치료 도중의 다시 검진도 빠짐없이 남긴다(사용자 지정: 기록은 전부)
    if (ok) saveCheckup({ root: ctx?.root, report: r.value, from: 'treat', now: now() }); else note({ root: ctx?.root, kind: 'checkup-failed', from: 'treat', now: now() });
    return ok ? r.value : null;
  };
  const doTreat = async () => {
    if (guard.tripped) return say('보호 장치가 Doctor 의 파일을 되돌리지 못해, 이 실행에서는 치료를 시작하지 않습니다. Doctor 를 닫고 다시 열어 주세요.');
    await (treat || defaultTreat)({ ctx, diag, say, ask, rediagnose, status: status(), command: cmd, afterAgent, pickServices, now, guardTripped: () => !!guard.tripped });
  };
  const showReport = () => { if (diag.report) say(renderText(diag.report)); else say(summary()); };
  const linkMenu = async () => {
    say(''); say(' [1] 클로드 연결 · 바꾸기 — IRIS 의 클로드 1년 열쇠를 Doctor 용으로 한 벌 더 둡니다(새 열쇠면 실제 확인 뒤에만 바꿉니다)');
    say(' [2] 코덱스 로그인 · 바꾸기 — 브라우저가 열립니다. 15분 안에 승인해 주세요(끝나면 짧은 요청 1회로 확인합니다)');
    say(' [0] 뒤로');
    const a = await ask(' 번호를 누르고 Enter: ');
    if (a === '1') { const r = await cmd('link', 'claude', { now: now() }); say(r.text.trimEnd()); afterAgent(); }
    else if (a === '2') { try { rl.pause(); } catch {} let r; try { r = await cmd('login', 'codex', { now: now() }); } finally { try { rl.resume(); } catch {} } say(r.text.trimEnd()); afterAgent(); }
  };
  const doProbe = async () => {
    const s = status(); const order = s ? pickServices(s) : [];
    if (!order.length) return say('연결된 계정이 없습니다 — [4]에서 먼저 연결해 주세요(검진은 연결 없이도 됩니다).');
    say(`${NAME[order[0]]} 계정으로 짧은 요청을 보냅니다 …`);
    const r = await checkConnection({ order, command: cmd, now: now() });
    for (const [i, t] of r.tried.entries()) { if (i > 0) say(`[알림] ${NAME[r.tried[i - 1].kind]} 쪽이 되지 않아 ${NAME[t.kind]} 계정으로 넘어갔습니다.`); say(t.text.trimEnd()); }
    if (r.shared) say('[알림] 두 서비스가 함께 쓰는 것에 문제가 있어 다른 서비스로 넘어가지 않았습니다.');
    afterAgent();
  };

  say(LINE); say(` IRIS Doctor  (판 ${VERSION})`); say(' 아이리스가 이상할 때 점검하고 고치는 도구입니다. 이 창은 IRIS 창을 닫아도 남아 있습니다.'); say(LINE);
  // 설치본: 시작하기 전에 이미 바뀐 프로그램 파일이 있는지 배포본의 지문 목록과 견준다(바뀌었으면 검진 · 안내는 하되 치료는 시작하지 않는다)
  try {
    const shipped = (shippedCheck || checkShipped)(path.dirname(HERE));
    if (shipped.known && !shipped.ok) {
      guard.tripped = true;
      const what = shipped.broken ? 'Doctor 프로그램 파일의 지문 목록을 읽지 못했습니다' : `Doctor 의 프로그램 파일이 배포본과 다릅니다(바뀜 ${shipped.changed.length} · 없어짐 ${shipped.missing.length} · 낯선 파일 ${shipped.added.length})`;
      // 업데이트가 도는 중이면 잠깐 어긋나 보일 수 있다 — 다시 설치하라고 하기 전에 그것부터 안내한다
      const tip = updateInProgress(ctx) ? '지금 업데이트가 진행 중입니다 — 업데이트가 끝난 뒤 이 창을 닫고 다시 열어 주세요.' : '업데이트 직후라면 이 창을 닫고 다시 열어 보고, 그래도 같으면 iris-workspace.com 의 「설치」에서 설치 프로그램을 받아 실행해 주세요(새 판이면 IRIS 를 업데이트하면서 Doctor 도 다시 놓입니다).';
      say(` [보호] ${what} — 이 실행에서는 치료를 시작하지 않습니다. ${tip}`);
    }
  } catch {}
  startDiagnosis();
  // 손 없는 계정 준비 — 첫 차림표가 뜬 **뒤에** 한 번만. 실패하든 멎든 차림표를 막지 않는다(기다리지 않는다 · 결과가 있으면 한 줄 알린다).
  let autoTried = false;
  const startAutoLink = () => {
    if (autoTried) return; autoTried = true;
    Promise.resolve().then(() => autoLink(ctx, { now: now() })).then((r) => {
      if (r?.claude?.linked === true && !closed) { say(''); say('[알림] IRIS 의 클로드 1년 열쇠가 있어 Doctor 용 연결을 손 없이 만들었습니다(사본 · 통신 없음). 실제로 되는지는 [5] 연결 확인에서 볼 수 있습니다.'); try { rl.prompt(true); } catch {} }
    }, () => {});
  };
  let first = true;
  while (!closed) {
    const s = status();
    say(''); say(` ${summary()}`); say(` ${statusLine(s)}`);
    if (!ctx.root) say(' IRIS 폴더를 찾지 못했습니다 — 검진표에 까닭이 나옵니다.');
    if (first && s && !pickServices(s).length) say(' 연결된 계정이 없습니다 — [4]에서 연결해 두면 Doctor 가 원인 찾기와 치료까지 할 수 있습니다(연결 없이도 검진은 됩니다).');
    first = false;
    say(''); say(' [1] 치료 시작'); say(' [2] 검진표 보기'); say(' [3] 검진 다시'); say(' [4] 계정 연결 · 바꾸기');
    say(' [5] 연결 확인 — 연결된 서비스에 짧은 요청을 보냅니다(서비스마다 1회, 많아야 2회)'); say(' [0] 닫기');
    const asking = ask(' 번호를 누르고 Enter: ');
    startAutoLink(); // 물음까지 화면에 나간 뒤에 시작한다(첫 차림표에서 한 번)
    const a = await asking;
    if (a === null || a === '0') break;
    if (a === '1') await safely(doTreat);
    else if (a === '2') await safely(async () => showReport());
    else if (a === '3') { startDiagnosis(); say('검진을 다시 시작했습니다.'); }
    else if (a === '4') await safely(linkMenu);
    else if (a === '5') await safely(doProbe);
    else if (a !== '') say('0 ~ 5 가운데 하나를 눌러 주세요.');
  }
  diag.run++; // 뒤에서 돌던 검진의 알림을 받지 않는다
  for (const c of kids) { try { c.kill(); } catch {} } // 우리가 띄운 검진 자식만(그 손잡이로) 끝낸다
  try { rl.close(); } catch {}
  clearReady();
  note({ root: ctx?.root, kind: 'close', from: 'terminal', now: now() });
  return 0;
}
