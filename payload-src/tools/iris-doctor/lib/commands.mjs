// IRIS Doctor — 연결(link) · 코덱스 로그인(login) · 연결 확인(probe) 명령. 검진(diagnose)과 달리 Doctor 자기 자리에 쓴다(카드 · 설정 폴더).
// 화면에 내는 글에는 열쇠 값 · 이메일 원문 · 프로그램이 낸 글의 원문을 싣지 않는다.
// 연결을 바꾸는 흐름은 하나다: 새 연결을 "후보"로 받는다 → 그 후보로 실제 연결을 확인한다 → 성공한 그 후보만 바꿔 낀다(실패하면 옛 연결 그대로).
import { makeContext } from './context.mjs';
import { doctorPaths } from './home.mjs';
import { stageClaudeFromIris, commitClaude, discardClaude, prepareCodexHome, stageCodexHome, commitCodex, discardCodex, codexLoggedIn, linkStatus, linkSummary, readCard, recordProbe, withLinkLock, keyPrint, autoLinkClaude, autoPrepareCodex } from './link.mjs';
import { runAgent, PROBLEM_KO } from './launch.mjs';
import { localStamp } from './report.mjs';
import { note } from './journal.mjs';

const PROBE_WORD = 'IRIS-DOCTOR-OK';
const PROBE_PROMPT = `다른 말 없이 ${PROBE_WORD} 라고만 답해.`;
const NAME = { claude: '클로드', codex: '코덱스' };
const WHY_KO = { 'no-iris-key': 'IRIS 의 클로드 1년 열쇠가 없습니다 — 설정 → 계정 · 보안에서 「1년 열쇠 받기」를 먼저 해 주세요.', 'not-subscription-key': '그 열쇠가 구독 열쇠 모양이 아닙니다.', 'expiry-unknown': '그 열쇠의 만료 시각을 읽지 못했습니다.', expired: 'IRIS 의 1년 열쇠가 만료됐습니다 — 새로 받아야 합니다.' };
const STATE_KO = { none: '연결 안 됨', card: '카드만 있음(실제 연결 미확인)', ready: '준비됨(실제 연결 확인)', expired: '열쇠 만료', unreadable: '연결 파일을 읽지 못함(깨졌거나 권한 문제 — 다시 연결하면 됩니다)' };
const BUSY = '다른 연결 작업이 진행 중입니다 — 그 일이 끝난 뒤 다시 해 주세요.\n';
const STUCK = '지난번에 코덱스 연결을 바꿔 끼다 끊긴 것을 아직 정리하지 못했습니다(폴더를 다른 프로그램이 쥐고 있을 수 있음) — 코덱스 프로그램을 닫고 다시 해 주세요. 코덱스 폴더는 건드리지 않았습니다.\n';

function statusText(root, now) {
  const s = linkStatus({ root, now });
  const lines = ['IRIS Doctor 연결 상태'];
  const c = s.claude;
  const linked = (st) => st === 'card' || st === 'ready' || st === 'expired';
  lines.push(`  클로드: ${STATE_KO[c.state]}${c.account ? ` · 계정 ${c.account}` : linked(c.state) ? ' · 계정 미확인' : ''}${c.daysLeft != null ? ` · 열쇠 만료까지 ${c.daysLeft}일` : ''}${c.lastOkAt ? ` · 마지막 연결 성공 ${localStamp(c.lastOkAt)}` : ''}${linked(c.state) ? ` · 추가 사용 ${c.extraUsage === 'off' ? '꺼짐' : c.extraUsage === 'on' ? '켜짐' : '모름'}` : ''}${c.staged ? ' · 바꾸는 중인 새 연결 있음' : ''}`);
  const x = s.codex;
  lines.push(`  코덱스: ${STATE_KO[x.state]}${x.state === 'none' && x.prepared ? '(전용 폴더는 마련됨 — 로그인 필요)' : ''}${x.lastOkAt ? ` · 마지막 연결 성공 ${localStamp(x.lastOkAt)}` : ''}${x.staged ? ' · 바꾸는 중인 새 연결 있음' : ''}`);
  if (!s.protected && (c.state !== 'none' || x.state !== 'none' || x.prepared)) lines.push('  주의: 열쇠가 든 Doctor 폴더에 "이 사용자만" 권한을 걸지 못했습니다(이 PC 의 다른 사용자가 읽을 수 있을 수 있음).');
  return lines.join('\n') + '\n';
}

/** 연결된(또는 후보) 계정으로 짧은 요청을 한 번 보낸다. → { ok } | { blocked: [...] } | { ok:false, guess, alive } */
export async function probeOnce({ kind, root, ctx, card, codexHomeDir = null, now = Date.now(), run = runAgent, baseEnv = undefined }) {
  const paths = doctorPaths(root);
  const args = kind === 'claude' ? ['-p', PROBE_PROMPT, '--model', 'haiku'] : ['exec', '--skip-git-repo-check', '-s', 'read-only', '-C', paths.work, PROBE_PROMPT];
  const r = await run({ kind, root, toolsDir: ctx.layout === 'installed' ? ctx.toolsDir : null, args, card, capture: true, timeoutMs: 120_000, now, ...(codexHomeDir ? { codexHomeDir } : {}), ...(baseEnv ? { baseEnv } : {}) });
  if (r.blocked) return { blocked: r.blocked };
  if (!r.error && !r.timeout && r.code === 0 && String(r.out || '').includes(PROBE_WORD)) return { ok: true };
  // 실패의 원문은 싣지 않는다. 종류는 글자 무늬로 짐작한 것이라 "~로 보임"이라고만 적는다(확정이 아니다).
  const t = `${r.out || ''}\n${r.err || ''}`;
  const guess = r.timeout ? '시간 안에 답이 없음' : r.error ? '프로그램을 띄우지 못함'
    : /\b401\b|unauthorized|invalid[_ ](token|api[_ ]?key|grant)|token (has )?expired|authentication[_ ]error/i.test(t) ? '인증 거절로 보임(열쇠가 만료됐거나 거절됨)'
      : /\b429\b|rate.?limit|usage limit|quota/i.test(t) ? '한도에 걸린 것으로 보임'
        : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|certificate|network error/i.test(t) ? '통신 실패로 보임'
          : `까닭을 알 수 없음(종료 코드 ${Number.isInteger(r.code) ? r.code : '없음'})`;
  return { ok: false, guess, alive: !!r.alive };
}
const blockedText = (list) => `띄우기 전 자기 점검에서 멈췄습니다(통신은 하지 않았습니다):\n${list.map((b) => `  · ${PROBLEM_KO[b] || '알 수 없는 문제'}`).join('\n')}\n`;
const why = (p) => (p.blocked ? `띄우기 전 자기 점검에서 멈춤(${p.blocked.map((b) => PROBLEM_KO[b] || '알 수 없는 문제').join(' · ')})` : p.guess);

async function linkClaude({ root, ctx, now, run, baseEnv }) {
  const r = stageClaudeFromIris({ root, claudeDir: ctx.claudeDir, now });
  if (!r.ok) return { text: `클로드 연결을 만들지 못했습니다 — ${WHY_KO[r.why] || '알 수 없는 까닭'}\n(지금 있는 연결은 그대로입니다.)\n` + statusText(root, now), code: 1 };
  if (!r.staged) return { text: `클로드 연결을 만들었습니다(IRIS 1년 열쇠의 사본 · 계정 ${r.account || '미확인'} · 만료까지 ${r.daysLeft}일).\n` + statusText(root, now), code: 0 };
  // 지금 연결이 있는데 다른 열쇠로 바꾸는 것 — 새 열쇠로 실제 연결에 성공한 뒤에만, **확인한 바로 그 열쇠**를 바꿔 낀다
  const card = readCard(root, 'claude', { staged: true });
  const p = card ? await probeOnce({ kind: 'claude', root, ctx, card, now, run, baseEnv }) : { ok: false, guess: '후보 연결을 읽지 못함' };
  if (p.ok && commitClaude({ root, now, expect: keyPrint(card.token) })) return { text: `새 열쇠로 연결에 성공해 클로드 연결을 바꿨습니다(계정 ${r.account || '미확인'} · 만료까지 ${r.daysLeft}일).\n` + statusText(root, now), code: 0 };
  discardClaude({ root });
  return { text: `새 열쇠로는 연결하지 못해 **지금 있는 연결을 그대로 둡니다** — ${p.ok ? '확인하는 사이 후보가 바뀜' : why(p)}.\n` + statusText(root, now), code: 1 };
}

/**
 * 코덱스 로그인(브라우저에서 사용자가 직접 승인한다) → 실제 연결 확인 → 성공하면 연결.
 * 이미 연결이 있으면 새 로그인은 후보 폴더에 받고, 확인에 성공한 뒤에만 폴더째 바꿔 낀다(실패하면 옛 연결 그대로).
 */
async function loginCodex({ root, ctx, now, run, baseEnv }) {
  const toolsDir = ctx.layout === 'installed' ? ctx.toolsDir : null;
  const p0 = prepareCodexHome({ root, now });
  const staged = codexLoggedIn(p0.codexHome); // 지금 연결이 있으면 후보로 받는다
  const next = staged ? stageCodexHome({ root, now }) : null; // 후보 폴더는 이 실행만의 것(앞선 실행이 쓰던 폴더를 다시 쓰지 않는다)
  const target = next || p0.codexHome;
  const dir = next ? { codexHomeDir: next } : {};
  // 로그인은 이 터미널에 그대로 잇는다(브라우저가 열리고 사용자가 승인한다). 최대 15분 — 넘으면 끊는다.
  const lr = await run({ kind: 'codex', root, toolsDir, args: ['login'], capture: false, timeoutMs: 15 * 60_000, now, ...dir, purpose: 'login', ...(baseEnv ? { baseEnv } : {}) });
  if (lr.blocked) { if (next) discardCodex({ root, next }); return { text: blockedText(lr.blocked), code: 1 }; }
  if (lr.timeout || !codexLoggedIn(target)) {
    if (next && !lr.alive) discardCodex({ root, next });
    return { text: `코덱스 로그인이 끝나지 않았습니다(${lr.timeout ? '15분 안에 끝나지 않음' : '구독 로그인 열쇠가 생기지 않음'})${staged ? ' — 지금 있는 연결은 그대로입니다' : ''}.\n` + statusText(root, now), code: 1 };
  }
  const p = await probeOnce({ kind: 'codex', root, ctx, card: null, ...dir, now, run, baseEnv });
  if (!staged) {
    // 처음 연결: 로그인은 남기고, 확인 결과만 카드에 적는다
    if (p.blocked) return { text: blockedText(p.blocked) + statusText(root, now), code: 1 };
    recordProbe({ root, kind: 'codex', ok: !!p.ok, now });
    return { text: p.ok ? '코덱스 로그인과 직통 연결 확인에 성공했습니다.\n' + statusText(root, now) : `코덱스 로그인은 됐지만 직통 연결 확인은 실패했습니다 — ${p.guess}.\n` + statusText(root, now), code: p.ok ? 0 : 1 };
  }
  let swapped = false, swapError = false;
  if (p.ok) { try { swapped = commitCodex({ root, next, now, verified: true }); } catch { swapError = true; } }
  if (swapped) return { text: '새 로그인으로 연결에 성공해 코덱스 연결을 바꿨습니다.\n' + statusText(root, now), code: 0 };
  // 바꿔 끼다 막힘: 되돌렸거나, 못 되돌렸으면 쪽지가 남아 다음 실행이 마저 정리한다 — 후보는 건드리지 않는다(쪽지가 가리킨다)
  if (swapError) return { text: '새 로그인의 확인은 성공했지만 연결을 바꿔 끼는 도중 막혔습니다 — 다음에 Doctor 연결 명령을 실행할 때 마저 정리합니다.\n' + statusText(root, now), code: 1 };
  // 확인 실패: 이 실행의 후보만 버린다. 확인하던 프로그램이 아직 살아 있으면 그 폴더를 건드리지 않고 남긴다(다시 쓰지 않으며, 다음에 바꿀 때 치운다).
  if (!p.alive) discardCodex({ root, next });
  return { text: `새 로그인으로는 연결하지 못해 **지금 있는 연결을 그대로 둡니다** — ${p.ok ? '바꿔 끼지 못함' : why(p)}.\n` + statusText(root, now), code: 1 };
}

const AUTO_WHY = new Set(['linked', 'prepared', 'no-root', 'no-iris-key', 'has-card', 'ready', 'busy', 'stuck', 'failed', 'not-subscription-key', 'expiry-unknown', 'expired']);
/**
 * 손 없이 되는 준비(`link auto` · `auto-claude` · `auto-codex`) — 통신 0 · 실제 확인 호출 0 · 브라우저 0.
 * 설치 프로그램이 설치 · 업데이트 끝에 부르는 길이다: **만들 것이 없으면 아무것도 쓰지 않는다**(장부 한 줄도 — 무언가를 실제로 만들었을 때만 남긴다).
 * (`link claude` · `link codex` 는 이 약속이 아니다: 부를 때마다 장부 한 줄을 남기고, `link claude` 는 다른 열쇠를 만나면 실제 확인 호출을 한다 — 설치 프로그램은 그 둘을 부르지 않는다.)
 * 답 = JSON 한 줄(계정 이름 · 열쇠 · 경로 없음): { v:1, claude:{ linked, why } | null, codex:{ prepared, why } | null }. 종료 코드는 늘 0(준비가 안 됐다고 부른 쪽을 실패시키지 않는다).
 */
export async function autoPrepare({ root, ctx, now = Date.now(), which = 'both', from = 'cli' }) {
  const out = { v: 1, claude: null, codex: null };
  const why = (w) => (AUTO_WHY.has(w) ? w : 'failed');
  if (which !== 'codex') {
    let r; try { r = await autoLinkClaude({ root, claudeDir: ctx?.claudeDir, now }); } catch { r = { linked: false, why: 'failed' }; }
    out.claude = { linked: r?.linked === true, why: why(r?.why) };
    // 장부에는 **실제로 만들었을 때만** 남긴다 — 만들지 않은 호출(열쇠 없음 · 이미 카드 있음 · 만료 · 실패)은 한 줄도 쓰지 않는다(되풀이 호출이 디스크를 바꾸지 않게)
    if (out.claude.linked) note({ root, kind: 'link', now, from, service: 'claude', what: 'auto-link', ok: true });
  }
  if (which !== 'claude') {
    let r; try { r = await autoPrepareCodex({ root, now }); } catch { r = { prepared: false, why: 'failed' }; }
    out.codex = { prepared: r?.prepared === true, why: why(r?.why) };
    if (out.codex.prepared) note({ root, kind: 'link', now, from, service: 'codex', what: 'auto-prepare', ok: true });
  }
  return out;
}

/** → { text, code } */
/** 명령 하나를 돌리고, 계정 연결 · 연결 확인이면 장부에 한 줄 남긴다(성공 · 실패만 — 계정 이름 · 결과 글은 싣지 않는다). */
export async function runCommand(cmd, sub, o = {}) {
  const now = o.now ?? Date.now(); const ctx = o.ctx || makeContext({});
  const record = ctx.root && (cmd === 'probe' || cmd === 'login' || (cmd === 'link' && (sub === 'claude' || sub === 'codex')));
  const write = (ok, why) => { if (record) note({ root: ctx.root, kind: cmd === 'probe' ? 'probe' : 'link', now, service: sub, what: cmd, ok, ...(typeof why === 'string' ? { why } : {}) }); };
  let r;
  try { r = await runCommand0(cmd, sub, { ...o, now, ctx }); } catch (e) { write(false, 'error'); throw e; } // 도중에 터져도 "실패"는 남긴다
  write(r?.code === 0, r?.why);
  return r;
}
async function runCommand0(cmd, sub, { now = Date.now(), ctx = makeContext({}), run = runAgent, baseEnv = undefined } = {}) {
  const root = ctx.root;
  if (!root) return { text: 'IRIS 폴더를 찾지 못했습니다.\n', code: 2 };
  // 연결을 읽고 쓰는 명령은 모두 같은 잠금 안에서 한다(끊긴 코덱스 바꿔 끼기의 정리도 그 안에서 먼저 한다).
  // codex=true 인 명령은 그 정리가 막혔으면(쪽지가 남음) 코덱스 폴더를 건드리지 않고 물러난다.
  const locked = async (fn, { codex = false } = {}) => {
    const r = await withLinkLock(root, ({ recovered }) => (codex && recovered === 'failed' ? { text: STUCK, code: 1 } : fn()), { now });
    return r?.busy ? { text: BUSY, code: 1 } : r;
  };
  if (cmd === 'link') {
    if (sub === 'status' || !sub) return { text: statusText(root, now), code: 0 };
    if (sub === 'summary') {
      // 창 안 입구가 읽는 요약(JSON 한 줄 · 계정 이름 · 열쇠 없음). 다른 연결 명령과 같은 잠금 안에서 읽고, 잠금이 바쁘면 기다리지 않고 "바쁨"으로 답한다(창 열기를 막지 않게).
      const r = await withLinkLock(root, () => linkSummary({ root, now }), { now });
      return { text: `${JSON.stringify(r?.busy ? { v: 1, busy: true } : r)}\n`, code: 0 };
    }
    if (sub === 'auto' || sub === 'auto-claude' || sub === 'auto-codex') {
      // 손 없이 되는 준비만(통신 0) — 잠금은 실제로 만들 것이 있을 때만 안에서 쥔다(할 일이 없으면 읽기만 하고 끝난다)
      const r = await autoPrepare({ root, ctx, now, which: sub === 'auto' ? 'both' : sub.slice(5) });
      return { text: `${JSON.stringify(r)}\n`, code: 0 };
    }
    if (sub === 'claude') return locked(() => linkClaude({ root, ctx, now, run, baseEnv }));
    if (sub === 'codex') {
      return locked(() => {
        const p = prepareCodexHome({ root, now });
        return { text: `코덱스 전용 폴더를 마련했습니다(${p.codexHome}).\n로그인은 브라우저에서 직접 승인해야 합니다 — 이 터미널에서: node iris-doctor.mjs login codex\n` + statusText(root, now), code: 0 };
      }, { codex: true });
    }
    return { text: '사용법: iris-doctor link [status | claude | codex]\n', code: 2 };
  }
  if (cmd === 'login') {
    if (sub !== 'codex') return { text: '사용법: iris-doctor login codex   (클로드는 link claude — IRIS 1년 열쇠의 사본을 씁니다)\n', code: 2 };
    return locked(() => loginCodex({ root, ctx, now, run, baseEnv }), { codex: true });
  }
  if (cmd === 'probe') {
    if (sub !== 'claude' && sub !== 'codex') return { text: '사용법: iris-doctor probe [claude | codex]\n', code: 2 };
    // 확인 결과를 카드에 적으므로 같은 잠금 안에서 한다(계정을 바꾸는 실행과 겹쳐, 옛 계정의 확인 결과가 새 계정의 카드에 적히지 않게)
    // why = 부른 쪽(대화 흐름)이 "다른 서비스로 넘어가도 되는 실패인가"를 가리는 표시: ok | no-card | blocked(+problems) | failed | busy | stuck
    const r = await locked(async () => {
      const card = readCard(root, sub);
      if (!card) return { text: `${NAME[sub]} 연결이 없습니다 — 먼저 link ${sub} 를 해 주세요.\n`, code: 1, why: 'no-card' };
      const p = await probeOnce({ kind: sub, root, ctx, card, now, run, baseEnv });
      if (p.blocked) return { text: blockedText(p.blocked), code: 1, why: 'blocked', problems: p.blocked };
      recordProbe({ root, kind: sub, ok: !!p.ok, now });
      if (p.ok) return { text: `${NAME[sub]} 직통 연결 확인: 성공(중계기를 거치지 않고 답을 받았습니다).\n` + statusText(root, now), code: 0, why: 'ok' };
      return { text: `${NAME[sub]} 직통 연결 확인: 실패 — ${p.guess}.\n` + statusText(root, now), code: 1, why: 'failed' };
    }, { codex: sub === 'codex' });
    return r.why ? r : { ...r, why: r.text === BUSY ? 'busy' : 'stuck' };
  }
  return { text: '', code: 2 };
}
