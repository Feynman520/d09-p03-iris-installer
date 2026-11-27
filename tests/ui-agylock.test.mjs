// 2.0.67 — 설치 화면의 Antigravity 잠긴 줄(③ 구독 고르기 · ⑦ 계정 연결).
//
// 지키는 것:
//   · 셋째 줄 `Antigravity` + 꼬리표 「곧 열립니다」 — 체크 상자는 꺼져 있고 눌리지 않는다.
//   · 이번 판에서는 **열쇠가 열린 PC 에서도 고를 수 없다**(받기 장치를 싣지 않았다). 달라지는 것은 설명 한 줄뿐이다.
//   · 「다음」 · 「바꾼 대로 적용」은 지금까지처럼 클로드 · 챗지피티만 읽는다 — 그 체크 상자가 억지로 켜져도 서버에 보내지 않는다.
//   · 구독 고르기 화면의 기존 요소(안내 글 · 두 줄 · 단추)는 글자까지 그대로다.
//   · 요약 · 완료 화면에는 Antigravity 를 적지 않는다.
// 아래 흐름 시험은 index.html 의 스크립트 전체를 **가짜 DOM · 가짜 서버(fetch)** 위에서 돌린다(브라우저 · 진짜 서버 · 네트워크 없음).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_FETCH = globalThis.fetch; // 흐름 시험이 가짜로 바꾸기 전의 것
const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'installer', 'ui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ui-agylock-'));
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const TAG = '곧 열립니다';
const NOTE_LOCKED = '준비 중입니다. 곧 열립니다.';
const NOTE_KEY = '이 PC 는 시험 열쇠가 있지만, 설치 프로그램에서 받는 기능은 아직 준비 중입니다.';
const card = (id) => new RegExp(`<section class="card" id="card-${id}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
/** 스크립트에서 그 함수 하나의 글(다음 최상위 선언 앞까지) */
const fnBody = (head) => { const i = script.indexOf(head); assert.ok(i >= 0, `${head} 를 찾는다`); const rest = script.slice(i + head.length); const j = rest.search(/\n(async function |function |const |let |\$\()/); return rest.slice(0, j < 0 ? undefined : j); };

// ---------------------------------------------------------------------------
// 글자 수준
// ---------------------------------------------------------------------------
test('③ 구독 고르기: 셋째 줄 Antigravity + 「곧 열립니다」 — 체크 상자는 처음부터 꺼져 있다', () => {
  const c = card('choice');
  const row = /<label class="pick locked" id="pick-antigravity"[^>]*>[\s\S]*?<\/label>/.exec(c)?.[0];
  assert.ok(row, '잠긴 줄이 ③ 카드 안에 있다');
  assert.match(row, /<input type="checkbox" id="sub-antigravity" value="antigravity" disabled>/, '꺼진 체크 상자(checked 없음)');
  assert.doesNotMatch(row, /checked/);
  assert.match(row, /<b>Antigravity<\/b>/);
  assert.ok(row.includes(`<span class="soon">${TAG}</span>`), '꼬리표');
  assert.ok(row.includes(`<span class="sub" id="sub-antigravity-note">${NOTE_LOCKED}</span>`), '설명 한 줄');
  assert.match(row, /aria-disabled="true"/);
  // 셋째 줄이다: 클로드 → 챗지피티 → Antigravity 차례.
  const order = ['id="sub-claude"', 'id="sub-chatgpt"', 'id="sub-antigravity"'].map((s) => c.indexOf(s));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], '차례');
  // 받는 법 · 설치 명령 같은 글이 없다(이 판은 받지 않는다).
  assert.doesNotMatch(row, /내려받|설치 명령|agy|로그인|계정/);
});

test('⑦ 계정 연결: 「이번 설치에서 쓸 구독」에 꺼진 셋째 칸 Antigravity + 「곧 열립니다」', () => {
  const c = card('online');
  const row = /<label class="lc-locked" id="lc-antigravity"[^>]*>[\s\S]*?<\/label>/.exec(c)?.[0];
  assert.ok(row, '잠긴 칸이 ⑦ 카드의 구독 다시 고르기 줄 안에 있다');
  assert.match(row, /<input type="checkbox" id="chk-antigravity" disabled>/);
  assert.doesNotMatch(row, /checked/);
  assert.ok(row.includes(' Antigravity '));
  assert.ok(row.includes(`<span class="soon">${TAG}</span>`));
  assert.ok(row.includes(`title="${NOTE_LOCKED}"`), '설명은 그 칸의 풍선말로');
  assert.match(row, /aria-disabled="true"/);
  const order = ['id="chk-claude"', 'id="chk-chatgpt"', 'id="chk-antigravity"', 'id="btn-choice-apply"'].map((s) => c.indexOf(s));
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || order[i - 1] < n)), '차례: 클로드 · 챗지피티 · Antigravity · 적용 단추');
});

test('구독 고르기 화면의 기존 요소는 글자까지 그대로다(안내 글 · 클로드 줄 · 챗지피티 줄 · 단추)', () => {
  const c = card('choice');
  for (const line of [
    '<div class="card-head"><span class="mark">③</span><h2>구독 고르기</h2><span class="badge" id="badge-choice">대기</span></div>',
    '<p class="hint">가지고 계신 <b>유료 구독</b>을 모두 고르세요. 무료 계정으로는 비서가 일할 수 없습니다. 둘 다 고르면 Claude 쪽이 앞장서고, 그 뒤로는 둘 다 씁니다.</p>',
    '<label class="pick"><input type="checkbox" id="sub-claude" value="claude"><span><b>Claude 구독</b> — claude.ai 유료 요금제(예: Pro, Max)<span class="sub">비서가 Claude로 일합니다(도구 이름: Claude Code). 둘 다 있으면 이쪽이 앞장섭니다.</span></span></label>',
    '<label class="pick"><input type="checkbox" id="sub-chatgpt" value="chatgpt"><span><b>ChatGPT 구독</b> — chatgpt.com 유료 요금제(예: Plus, Pro)<span class="sub">비서가 ChatGPT로 일합니다(도구 이름: Codex).</span></span></label>',
    '<div id="choice-note"></div>',
    '<button class="ghost" id="btn-back-choice">이전</button>',
    '<button class="go" id="btn-choice">다음</button>',
  ]) assert.ok(c.includes(line), `바뀌었다: ${line.slice(0, 60)}…`);
  const o = card('online');
  for (const line of [
    '<span class="lc-label">이번 설치에서 쓸 구독</span>',
    '<label><input type="checkbox" id="chk-claude"> Claude</label>',
    '<label><input type="checkbox" id="chk-chatgpt"> ChatGPT</label>',
    '<button class="ghost" id="btn-choice-apply">바꾼 대로 적용</button>',
    '<span class="lc-note" id="choice-note">한쪽 로그인이 잘 안 되면 체크를 풀고 적용하세요. 나중에 IRIS 안에서 다시 더할 수 있습니다.</span>',
  ]) assert.ok(o.includes(line), `바뀌었다: ${line.slice(0, 60)}…`);
});

test('「다음」 · 「바꾼 대로 적용」 · 복원은 클로드 · 챗지피티만 읽는다 — 고른 값에 antigravity 가 들어갈 길이 없다', () => {
  // ③ 「다음」: 이 판에서 한 글자도 바뀌지 않았다.
  assert.ok(script.includes([
    "$('btn-choice').onclick = async () => {",
    '  const subs = [];',
    "  if ($('sub-claude').checked) subs.push('claude');",
    "  if ($('sub-chatgpt').checked) subs.push('chatgpt');",
    '  if (subs.length === 0) {',
  ].join('\n')), '「다음」의 앞머리');
  assert.ok(script.includes("  const { body } = await api('/api/choice', { subscriptions: subs });"));
  // ⑦ 「바꾼 대로 적용」
  assert.ok(script.includes("  const subs = ['claude', 'chatgpt'].filter((p) => $('chk-' + p) && $('chk-' + p).checked);"));
  assert.ok(script.includes("    const { body } = await api('/api/online/choice', { subscriptions: subs });"));
  // 서버에 보내는 글 어디에도 antigravity 가 없다.
  for (const m of script.matchAll(/api\('[^']+',\s*\{[^}]*\}/g)) assert.doesNotMatch(m[0], /antigravity/i, m[0]);
  // 이름표 둘은 그대로(요약 · 완료 보고 · 로그인 상자가 쓰는 표 — 셋째 줄이 없다).
  assert.ok(script.includes("const SUB_LABEL = { claude: 'Claude 구독(Claude Code)', chatgpt: 'ChatGPT 구독(Codex)' };"));
  assert.ok(script.includes("const PROVIDER_LABEL = { claude: 'Claude 계정 로그인', chatgpt: 'ChatGPT 계정 로그인' };"));
});

test('요약 · 완료 화면 · 로그인 상자에는 Antigravity 를 적지 않는다 — 그 낱말은 잠긴 줄 둘과 그 그리기 함수에만 있다', () => {
  for (const head of ['function renderSummary(dec) {', 'async function loadReport() {', 'function renderLoginBoxes(on) {', 'function renderOnlineRows(on) {']) {
    assert.doesNotMatch(fnBody(head), /antigravity/i, head);
  }
  for (const id of ['summary', 'done', 'setup', 'update', 'auto', 'locate', 'precheck', 'report', 'reinstall', 'structure']) {
    assert.doesNotMatch(card(id), /antigravity/i, `card-${id}`);
  }
  // 화면에 보이는 글자(HTML 쪽)는 잠긴 줄 둘뿐이다.
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  assert.equal((markup.match(/Antigravity/g) || []).length, 2, '③ 한 번 · ⑦ 한 번');
  // 설치기 화면은 그 프로그램 · 설정 폴더 · 열쇠 파일의 이름을 모른다.
  assert.doesNotMatch(html, /agy\.exe|\.gemini|iris-keys|AGY_CLI/);
});

test('잠긴 줄을 그리는 함수: 설명만 잠금에 따라 바뀌고, 체크 상자는 어느 쪽이든 꺼져 있다', () => {
  assert.ok(script.includes(`const AGY_NOTE_LOCKED = '${NOTE_LOCKED}';`));
  assert.ok(script.includes(`const AGY_NOTE_KEY = '${NOTE_KEY}';`));
  const body = fnBody('function renderAgyRow(locks) {');
  assert.match(body, /locks\.antigravity === 'open'/, '정확히 open 일 때만 열쇠 PC 의 설명');
  assert.match(body, /c\.checked = false; c\.disabled = true;/, '두 체크 상자를 늘 끄고 잠근다');
  assert.doesNotMatch(body, /disabled = false|checked = true|removeAttribute/, '여는 길이 없다');
  // 복원이 서버의 locks 로 그린다(다른 화면으로 빠지는 길보다 먼저).
  const restore = fnBody('async function restore() {');
  assert.ok(restore.indexOf('renderAgyRow(st.locks)') > 0 && restore.indexOf('renderAgyRow(st.locks)') < restore.indexOf("st.step === 'reinstall-required'"));
});

// ---------------------------------------------------------------------------
// 화면 흐름(가짜 DOM · 가짜 서버)
// ---------------------------------------------------------------------------
let els = new Map();
function makeEl(id, attrs = '') {
  const listeners = {};
  return {
    id, hidden: /\bhidden\b/.test(attrs), disabled: /\bdisabled\b/.test(attrs), textContent: '', className: '', value: '', checked: false, dataset: {}, style: {}, title: '', _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); for (const x of this._html.matchAll(/<[^>]*\bid="([^"]+)"([^>]*)>/g)) els.set(x[1], makeEl(x[1], x[2])); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getAttribute() { return null; }, setAttribute(k, v) { this[k] = v; }, querySelectorAll() { return []; }, querySelector() { return null; },
    appendChild() {}, focus() {}, scrollIntoView() {}, closest() { return null; },
  };
}
function freshDom() {
  els = new Map();
  for (const x of html.matchAll(/<[^>]*\bid="([^"]+)"([^>]*)>/g)) if (!els.has(x[1])) els.set(x[1], makeEl(x[1], x[2]));
}
globalThis.document = { getElementById: (id) => els.get(id) || null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => makeEl('x') };
globalThis.window = { scrollTo() {}, addEventListener() {}, location: { reload() {} } };
globalThis.EventSource = class { close() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, what, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return; await sleep(30); } assert.fail(`기다리다 끝남: ${what}`); };
let n = 0;
async function loadUi() {
  fs.copyFileSync(path.join(UI, 'structure.mjs'), path.join(dir, 'structure.mjs'));
  const file = path.join(dir, `ui-${++n}.mjs`);
  fs.writeFileSync(file, script);
  await import(pathToFileURL(file).href);
}

test('화면 흐름 ③ (잠긴 PC): 잠긴 줄은 꺼져 있고, 억지로 켜도 「다음」은 클로드 · 챗지피티만 본다', async () => {
  freshDom();
  const posts = [];
  globalThis.fetch = async (p, opts = {}) => {
    const method = opts.method || 'GET';
    let body = { ok: true };
    if (p === '/api/state') body = { ok: true, version: '2.0.67', step: 'choice', choice: null, decisions: null, setup: null, online: null, soul: { root: 'X', mode: 'empty' }, locks: { antigravity: 'locked' } };
    else if (p === '/api/presets') body = { presets: [] };
    else if (method === 'POST') { posts.push({ p, body: opts.body }); if (p === '/api/choice') body = { ok: true, leadAgent: 'claude', structure: 'interview' }; }
    return { status: 200, json: async () => body };
  };
  // 화면 글이 손대어져 상자가 켜진 채 시작해도, 스크립트가 끄고 잠근다.
  for (const id of ['sub-antigravity', 'chk-antigravity']) { els.get(id).disabled = false; els.get(id).checked = true; }
  await loadUi();
  await until(() => els.get('card-choice').hidden === false, '③ 화면');

  const agy = els.get('sub-antigravity');
  assert.equal(agy.disabled, true, '꺼진 상자');
  assert.equal(agy.checked, false);
  assert.equal(els.get('sub-antigravity-note').textContent, NOTE_LOCKED);
  assert.equal(els.get('chk-antigravity').disabled, true);
  assert.equal(els.get('lc-antigravity').title, NOTE_LOCKED);

  // 아무것도 고르지 않음 → 지금까지의 안내, 서버에 보내지 않는다.
  await els.get('btn-choice').onclick();
  assert.equal(posts.length, 0);
  assert.match(els.get('choice-note').innerHTML, /적어도 하나는 골라야 합니다/);

  // 잠긴 상자가 억지로 켜져도(개발자 도구 등) Antigravity 만으로는 넘어갈 수 없다.
  agy.checked = true;
  await els.get('btn-choice').onclick();
  assert.equal(posts.length, 0, 'Antigravity 만으로는 「다음」이 서버에 가지 않는다');
  assert.equal(els.get('card-choice').hidden, false);

  // 클로드를 고르면 클로드만 간다.
  els.get('sub-claude').checked = true;
  await els.get('btn-choice').onclick();
  assert.deepEqual(posts, [{ p: '/api/choice', body: JSON.stringify({ subscriptions: ['claude'] }) }]);
  await until(() => els.get('card-summary').hidden === false, '⑤ 요약');
  assert.doesNotMatch(els.get('summary-rows')?.innerHTML ?? '', /antigravity/i, '요약에 Antigravity 가 없다');
});

test('화면 흐름 ⑦ (열쇠가 열린 PC): 설명만 바뀌고 여전히 꺼져 있다 — 「바꾼 대로 적용」도 클로드 · 챗지피티만 보낸다', async () => {
  freshDom();
  const posts = [];
  let relay = { state: 'pending' };
  let logins = { claude: { state: 'waiting', cli: 'pending', relay: 'pending' }, chatgpt: { state: 'waiting', cli: 'pending', relay: 'pending' } };
  const online = () => ({ ok: true, step: relay.state === 'done' ? 'done' : 'online', stage: 'login', net: { ok: true, blocked: [] }, claude: { state: 'done', source: 'claude.ai' }, logins, relay, now: Date.now() });
  globalThis.fetch = async (p, opts = {}) => {
    const method = opts.method || 'GET';
    let body = { ok: true };
    if (p === '/api/state') body = { ok: true, version: '2.0.67', step: 'online', choice: { subscriptions: ['claude', 'chatgpt'], leadAgent: 'claude' }, decisions: null, setup: null, online: online(), soul: { root: 'X', mode: 'iris' }, locks: { antigravity: 'open' } };
    else if (p === '/api/presets') body = { presets: [] };
    else if (p === '/api/online/status') body = online();
    else if (p === '/api/report') body = { ok: true, handoff: { subscriptions: ['claude'], leadAgent: 'claude' }, pendingCapabilities: [] };
    else if (method === 'POST') {
      posts.push({ p, body: opts.body });
      if (p === '/api/online/choice') { logins = { claude: { state: 'done', cli: 'done', relay: 'done' }, chatgpt: { state: 'not-needed' } }; body = { ok: true, subscriptions: ['claude'], leadAgent: 'claude', restarted: false }; }
      if (p === '/api/online/relay') { relay = { state: 'done', accounts: 1 }; }
    }
    return { status: 200, json: async () => body };
  };
  await loadUi();
  await until(() => els.get('card-online').hidden === false && els.get('login-choice').hidden === false, '⑦ 화면의 구독 다시 고르기 줄');

  // 열쇠 PC: 설명이 바뀐다. 꼬리표 · 꺼짐은 같다.
  assert.equal(els.get('sub-antigravity-note').textContent, NOTE_KEY);
  assert.equal(els.get('lc-antigravity').title, NOTE_KEY);
  for (const id of ['sub-antigravity', 'chk-antigravity']) { assert.equal(els.get(id).disabled, true, id); assert.equal(els.get(id).checked, false, id); }
  assert.equal(els.get('chk-claude').checked, true);
  assert.equal(els.get('chk-chatgpt').checked, true);
  assert.equal(els.has('lb-antigravity'), false, '셋째 로그인 상자는 없다');
  assert.ok(els.has('lb-claude') && els.has('lb-chatgpt'));

  // 억지로 켜고 챗지피티를 뺀 뒤 적용 → 서버에는 클로드만 간다.
  els.get('chk-antigravity').checked = true;
  els.get('chk-chatgpt').checked = false;
  await els.get('btn-choice-apply').onclick();
  assert.deepEqual(posts.filter((x) => x.p === '/api/online/choice'), [{ p: '/api/online/choice', body: JSON.stringify({ subscriptions: ['claude'] }) }]);
  assert.match(els.get('online-note').innerHTML, /Claude 로그인만 끝나면 넘어갑니다/);

  // 남은 구독(클로드)이 끝났으니 계정 연결 → 완료 화면. 넘어가는 판정은 Antigravity 를 모른다.
  await until(() => els.get('card-done').hidden === false, '⑧ 완료 화면');
  assert.ok(posts.some((x) => x.p === '/api/online/relay'));
  assert.doesNotMatch(els.get('report-body')?.innerHTML ?? '', /antigravity/i);
  for (const [id, el] of els) if (/^(report|done|summary)/.test(id)) assert.doesNotMatch(`${el.innerHTML} ${el.textContent}`, /antigravity/i, id);
});

// ---------------------------------------------------------------------------
// 가짜 서버(화면만 따로 볼 때)
// ---------------------------------------------------------------------------
const mocks = [];
after(() => { for (const c of mocks) { try { c.kill(); } catch { /* 이미 끝남 */ } } });
/** 가짜 서버를 빈 포트에 띄운다(자기가 띄운 프로세스 — 끝나면 그 프로세스만 끝낸다). */
async function startMock(args) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(UI, 'mock-server.mjs'), '--port', String(port), '--speed', '50', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  mocks.push(child);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('가짜 서버가 뜨지 않음')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes(`:${port}/`)) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`가짜 서버가 끝남(${c})`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  const post = async (p, body) => (await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
  const get = async (p) => (await fetch(url + p)).json();
  return { post, get, stop: () => { child.kill(); } };
}

test('가짜 서버: 상태에 locks 칸(기본 locked · --agy-key 면 open) — 받은 antigravity 는 진짜 서버처럼 버린다', async () => {
  const realFetch = globalThis.fetch;
  // 위 흐름 시험이 바꿔 둔 fetch 를 node 의 것으로 되돌린다(이 시험은 진짜 로컬 연결을 쓴다).
  globalThis.fetch = NODE_FETCH;
  try {
    for (const [args, want] of [[[], 'locked'], [['--agy-key'], 'open']]) {
      const m = await startMock(args);
      try {
        assert.deepEqual((await m.get('/api/state')).locks, { antigravity: want });
        assert.equal((await m.post('/api/choice', { subscriptions: ['antigravity'], antigravity: true })).ok, false, 'Antigravity 만으로는 넘어가지 않는다');
        const r = await m.post('/api/choice', { subscriptions: ['antigravity', 'chatgpt'], antigravity: true });
        assert.equal(r.ok, true);
        assert.equal(r.leadAgent, 'chatgpt');
        const st = await m.get('/api/state');
        assert.deepEqual(st.choice, { subscriptions: ['chatgpt'], leadAgent: 'chatgpt' });
        assert.deepEqual(st.locks, { antigravity: want });
        await m.post('/api/online/start');
        const logins = (await m.get('/api/online/status')).logins;
        assert.deepEqual(Object.keys(logins).sort(), ['chatgpt', 'claude'], '로그인 칸은 둘뿐 — 셋째가 없다');
        assert.equal(logins.claude.state, 'not-needed');
        assert.equal(logins.chatgpt.state, 'waiting');
      } finally { m.stop(); }
    }
  } finally { globalThis.fetch = realFetch; }
});
