// 2.0.66 — 설치 화면의 「1년 열쇠 받기(권장)」 카드(installer/ui/index.html).
// index.html 의 순수 함수만 떼어 node:vm 에서 돌린다(브라우저 · 서버 없음 — tests/ui-relay-progress.test.mjs 와 같은 방식).
// 지키는 것: 카드는 클로드 로그인이 끝난 뒤에만 보인다(서버가 offered 로 알린다) · 코덱스만이면 없다 ·
// 글은 장담하지 않는다 · 다음 화면으로 넘어가는 판정은 이 카드를 보지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'installer', 'ui');
const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const grab = (re) => { const m = HTML.match(re); assert.ok(m, `index.html 에 ${re} 없음`); return m[0]; };
const code = [
  grab(/const esc = \(s\) => [^\n]+/),
  grab(/const LONGKEY_TITLE = '[^']*';/),
  grab(/const LONGKEY_BODY = '[^']*';/),
  grab(/const LONGKEY_SKIP_NOTE = '[^']*';/),
  grab(/const LONGKEY_LATER_TEXT = '[^']*';/),
  grab(/const LONGKEY_WAIT_NOTE = '[^']*';/),
  grab(/const LONGKEY_HOW = '[^']*';/),
  grab(/function longKeyShown\(lk\) \{[^\n]*\}/),
  grab(/function longKeyBusy\(lk\) \{[^\n]*\}/),
  grab(/function longKeyDay\(v\) \{[\s\S]*?\n\}/),
  grab(/function longKeyCardHtml\(lk\) \{[\s\S]*?\n\}/),
  grab(/function longKeyReportLine\(lk, hk, subs\) \{[\s\S]*?\n\}/),
  'Object.assign(this, { longKeyShown, longKeyBusy, longKeyDay, longKeyCardHtml, longKeyReportLine, LONGKEY_TITLE, LONGKEY_BODY, LONGKEY_SKIP_NOTE, LONGKEY_LATER_TEXT, LONGKEY_WAIT_NOTE });',
].join('\n');
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);

const APPROVE_URL = 'https://claude.ai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Fcallback&state=s&login_hint=x';
const idle = { offered: true, state: 'idle', skipped: false, url: null, message: null };
const buttons = (html) => [...html.matchAll(/<button class="(\w+)" data-lk="(\w+)">([^<]*)<\/button>/g)].map((m) => `${m[2]}:${m[3]}`);

test('카드는 서버가 낼 수 있다고 한 때에만 보인다 — 클로드 로그인 전 · 코덱스만 고른 설치 · 상태가 없을 때는 빈 글', () => {
  assert.equal(ctx.longKeyCardHtml(null), '');
  assert.equal(ctx.longKeyCardHtml(undefined), '');
  assert.equal(ctx.longKeyCardHtml({ offered: false, state: 'idle' }), '', '로그인 전 · 코덱스만');
  assert.equal(ctx.longKeyCardHtml({ state: 'idle' }), '', 'offered 가 없으면(옛 서버) 내지 않는다');
  assert.equal(ctx.longKeyCardHtml({ offered: 'yes', state: 'idle' }), '', 'true 일 때만');
  assert.notEqual(ctx.longKeyCardHtml(idle), '');
});

test('처음 모습: 제목 "1년 열쇠 받기(권장)" · 정해진 글 · 「받기」와 「나중에」', () => {
  const html = ctx.longKeyCardHtml(idle);
  assert.equal(ctx.LONGKEY_TITLE, '1년 열쇠 받기(권장)');
  assert.equal(ctx.LONGKEY_BODY, '유효 기간이 긴 열쇠를 받아 IRIS 창의 대화가 다시 로그인을 요구하는 일을 줄입니다. 브라우저 승인을 한 번 더 합니다. 나중에 IRIS 창의 설정 → 계정 · 보안에서도 받을 수 있습니다.');
  assert.ok(html.includes(`<h4>${ctx.LONGKEY_TITLE}</h4>`));
  assert.ok(html.includes(ctx.LONGKEY_BODY));
  assert.match(html, /받지 않아도 설치는 그대로 끝납니다/);
  assert.deepEqual(buttons(html), ['get:받기', 'later:나중에']);
});

const EVERY_CARD = [idle, { ...idle, skipped: true }, { offered: true, state: 'starting' }, { offered: true, state: 'approve', url: APPROVE_URL }, { offered: true, state: 'done' }, { offered: true, state: 'failed' }];

test('글은 장담하지 않는다 — "1년 동안 … 나오지 않습니다" 같은 말이 화면 글 어디에도 없다', () => {
  const all = [ctx.LONGKEY_TITLE, ctx.LONGKEY_BODY, ctx.LONGKEY_SKIP_NOTE, ctx.LONGKEY_LATER_TEXT, ctx.LONGKEY_WAIT_NOTE, ...EVERY_CARD.map((x) => ctx.longKeyCardHtml(x))].join('\n');
  for (const promise of [/1년 동안/, /나오지 않습니다/, /다시 로그인하지 않/, /로그인이 필요 없/, /절대/, /영구/]) assert.doesNotMatch(all, promise);
  assert.match(all, /줄입니다/, '"줄인다"고만 말한다');
});

test('글의 범위: 받는 것은 IRIS 창의 대화가 쓰는 열쇠라고만 말한다 — 계정 연결(중계기)의 계정이 바뀐다는 말이 없다', () => {
  const all = [ctx.LONGKEY_TITLE, ctx.LONGKEY_BODY, ctx.LONGKEY_SKIP_NOTE, ctx.LONGKEY_LATER_TEXT, ctx.LONGKEY_WAIT_NOTE, ...EVERY_CARD.map((x) => ctx.longKeyCardHtml(x)),
    ctx.longKeyReportLine({ offered: true, state: 'done', expiresAt: 1 }, null, ['claude']), ctx.longKeyReportLine(null, null, ['claude'])].join('\n');
  assert.doesNotMatch(all, /중계기|계정 연결|TeamClaude|두 자리|한 자리/);
  assert.match(ctx.LONGKEY_BODY, /IRIS 창의 대화가 다시 로그인을 요구하는 일을 줄입니다/);
  assert.match(ctx.LONGKEY_BODY, /IRIS 창의 설정 → 계정 · 보안에서도 받을 수 있습니다/);
});

test('「나중에」를 누른 뒤: 접힌 한 줄 + 「지금 받기」 — 어디서 받는지 알려 준다', () => {
  const html = ctx.longKeyCardHtml({ ...idle, skipped: true });
  assert.match(html, /나중에 받기로 했습니다/);
  assert.match(html, /IRIS 창의 설정 → 계정 · 보안에서 받을 수 있습니다/);
  assert.deepEqual(buttons(html), ['get:지금 받기']);
});

test('승인 대기: 서버가 준 글 + 「브라우저가 열리지 않았으면 여기」 링크. 단추는 없다(두 번 띄우지 않게)', () => {
  const html = ctx.longKeyCardHtml({ offered: true, state: 'approve', url: APPROVE_URL, message: '브라우저에 뜬 화면에서 「승인(Authorize)」을 한 번 눌러 주세요.' });
  assert.match(html, /승인\(Authorize\)/);
  assert.ok(html.includes(`href="${APPROVE_URL.replace(/&/g, '&amp;')}"`), '주소는 글자로만(esc) 넣는다');
  assert.match(html, /target="_blank" rel="noopener"/);
  assert.match(html, /하지 않아도 지금 로그인과 설치는 그대로/);
  assert.deepEqual(buttons(html), []);
  // 띄우는 중(주소가 아직 없음)에는 링크가 없다.
  assert.doesNotMatch(ctx.longKeyCardHtml({ offered: true, state: 'starting', url: null }), /<a /);
});

test('링크는 Claude 승인 주소일 때만 건다 — 다른 주소 · 스크립트 주소는 걸지 않는다', () => {
  for (const bad of ['javascript:alert(1)', 'https://example.invalid/oauth/authorize?x=1', 'http://claude.ai/oauth/authorize?x=1', 'https://claude.ai.evil.invalid/oauth/authorize?x=1', 42, null]) {
    assert.doesNotMatch(ctx.longKeyCardHtml({ offered: true, state: 'approve', url: bad }), /<a /, String(bad));
  }
  const html = ctx.longKeyCardHtml({ offered: true, state: 'approve', url: 'https://claude.ai/oauth/authorize?a="><script>x</script>' });
  assert.doesNotMatch(html, /<script>/, '주소 속 꺾쇠 · 따옴표는 글자로 바뀐다');
});

test('끝남: 받음 = ✓ 와 서버의 글(단추 없음) · 실패 = 글 + 「다시 받기」', () => {
  const done = ctx.longKeyCardHtml({ offered: true, state: 'done', message: '1년 열쇠를 받았습니다(만료 2027-11-27). IRIS 창의 새 대화부터 이 열쇠를 씁니다.' });
  assert.match(done, /class="ok">✓/);
  assert.match(done, /만료 2027-11-27/);
  assert.deepEqual(buttons(done), []);
  assert.match(ctx.longKeyCardHtml({ offered: true, state: 'done' }), /IRIS 창의 새 대화부터/, '서버 글이 없어도 범위를 말한다');

  const failed = ctx.longKeyCardHtml({ offered: true, state: 'failed', reason: 'timeout', message: '승인을 기다리다 시간이 지났습니다. 지금 로그인은 그대로 쓸 수 있습니다.' });
  assert.match(failed, /class="bad">✗/);
  assert.match(failed, /지금 로그인은 그대로/);
  assert.deepEqual(buttons(failed), ['get:다시 받기']);
  assert.match(ctx.longKeyCardHtml({ offered: true, state: 'failed' }), /지금 로그인은 그대로/, '서버 글이 없어도 "그대로"라고 말한다');

  assert.doesNotMatch(ctx.longKeyCardHtml({ offered: true, state: 'failed', message: '<img src=x onerror=1>' }), /<img/, '서버 글도 글자로만 넣는다');
});

test('완료 보고의 한 줄: 받았으면 "IRIS 창용 1년 열쇠 · 만료일", 아니면 어디서 받는지 — 클로드를 고르지 않았으면 줄이 없다', () => {
  const exp = new Date(2027, 10, 27, 12).getTime();
  const NOT_YET = 'IRIS 창용 1년 열쇠: 아직 받지 않았습니다 — IRIS 창의 설정 → 계정 · 보안 → 1년 열쇠 받기.';
  assert.equal(ctx.longKeyReportLine({ offered: true, state: 'done', expiresAt: exp }, null, ['claude']), 'IRIS 창용 1년 열쇠 · 만료 2027-11-27');
  assert.equal(ctx.longKeyReportLine(null, { state: 'received', expiresAt: new Date(exp).toISOString() }, ['claude', 'chatgpt']), 'IRIS 창용 1년 열쇠 · 만료 2027-11-27', '설치기를 다시 열었을 때는 인수 문서의 값으로');
  assert.equal(ctx.longKeyReportLine(idle, { state: 'not-received' }, ['claude']), NOT_YET);
  assert.equal(ctx.longKeyReportLine(null, null, ['claude']), NOT_YET);
  assert.equal(ctx.longKeyReportLine({ offered: true, state: 'failed', reason: 'timeout' }, null, ['claude']), NOT_YET);
  assert.match(ctx.longKeyReportLine({ offered: true, state: 'approve' }, null, ['claude']), /승인을 기다리는 중/);
  assert.equal(ctx.longKeyReportLine({ offered: true, state: 'done', expiresAt: exp }, null, ['chatgpt']), '');
  assert.equal(ctx.longKeyReportLine(null, null, undefined), '');
  assert.equal(ctx.longKeyDay('not a date'), '');
});

test('자리: 카드는 클로드 로그인 상자 안(코덱스 상자에는 없다)과 완료 화면에 있다 · 1초 확인이 카드를 그린다', () => {
  assert.match(HTML, /\(p === 'claude' \? '<div id="longkey-claude"><\/div>' : ''\)/, '클로드 상자에만');
  assert.equal((HTML.match(/id="longkey-claude"/g) || []).length, 1);
  const done = HTML.slice(HTML.indexOf('id="card-done"'), HTML.indexOf('id="card-report"'));
  assert.match(done, /<div id="longkey-done"><\/div>/, '완료 화면에도 같은 카드');
  assert.match(HTML, /if \(on\.longKey\) renderLongKey\(on\.longKey\);/);
  assert.match(HTML, /'<p id="report-longkey"><\/p>'/);
  // 같은 글이면 다시 그리지 않는다(1초마다 갈아 끼우면 누르는 순간의 단추가 사라진다).
  assert.match(HTML, /if \(el\._lkHtml !== html\) \{ el\.innerHTML = html; el\._lkHtml = html; \}/);
});

test('다음 화면으로 넘어가는 판정은 이 카드를 보지 않는다(건너뛰어도 · 실패해도 설치는 그대로 끝난다)', () => {
  const tick = grab(/async function onlineTick\(\) \{[\s\S]*?\n\}/);
  const verdict = tick.slice(tick.indexOf('const logins = on.logins'));
  assert.ok(verdict.includes("api('/api/online/relay', {})") && verdict.includes("show('done')"), '시험 준비: 넘어가기 판정을 잘라 냈다');
  assert.doesNotMatch(verdict, /longKey|longkey/, '로그인이 다 끝났는가 · 계정 연결이 끝났는가만 본다');
  // 카드 쪽 코드는 화면을 넘기지도, 로그인 · 계정 연결 길을 부르지도 않는다.
  const card = HTML.slice(HTML.indexOf('const LONGKEY_TITLE'), HTML.indexOf('function renderLoginBoxes'));
  assert.doesNotMatch(card, /show\(|\/api\/online\/(login|relay|start|choice)/);
  assert.deepEqual([...new Set([...card.matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1]))].sort(), ['/api/online/longkey', '/api/online/longkey/skip']);
});

// ---------------------------------------------------------------------------
// 가짜 서버(화면만 따로 볼 때) — 카드의 세 모습을 볼 수 있는 인자
// ---------------------------------------------------------------------------
const mocks = [];
after(() => { for (const c of mocks) { try { c.kill(); } catch { /* 이미 끝남 */ } } });

/** 가짜 서버를 빈 포트에 띄운다(자기가 띄운 프로세스 — 끝나면 그 프로세스만 끝낸다). */
async function startMock(args) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  // --speed 150: 승인 대기 구간이 0.45초 — 되묻는 이 시험이 그 모습을 놓치지 않을 만큼.
  const child = spawn(process.execPath, [path.join(UI, 'mock-server.mjs'), '--port', String(port), '--speed', '150', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  mocks.push(child);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('가짜 서버가 뜨지 않음')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes(`:${port}/`)) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`가짜 서버가 끝남(${c})`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  const post = async (p, body) => (await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
  const get = async (p) => (await fetch(url + p)).json();
  const until = async (p, pred, what) => { for (let i = 0; i < 300; i++) { const b = await get(p); if (pred(b)) return b; await new Promise((r) => setTimeout(r, 15)); } assert.fail(`가짜 서버: ${what}`); };
  return { post, get, until, stop: () => { child.kill(); } };
}
async function mockLogin(m, subs) {
  await m.post('/api/choice', { subscriptions: subs });
  await m.post('/api/online/start');
  for (const p of subs) await m.post('/api/online/login', { provider: p });
  await m.until('/api/online/status', (b) => subs.every((p) => b.logins[p].state === 'done'), '로그인 끝');
}

test('가짜 서버: 카드는 클로드 로그인이 끝난 뒤에만 · --longkey ok|fail|wait 로 세 모습을 본다', async () => {
  for (const [mode, end] of [['ok', 'done'], ['fail', 'failed'], ['wait', 'approve']]) {
    const m = await startMock(['--longkey', mode]);
    try {
      await m.post('/api/choice', { subscriptions: ['claude'] });
      await m.post('/api/online/start');
      assert.equal((await m.get('/api/online/status')).longKey.offered, false, `${mode}: 로그인 전에는 없다`);
      assert.equal((await m.post('/api/online/longkey')).ok, false);
      await mockLogin(m, ['claude']);
      const st = await m.get('/api/online/status');
      assert.equal(st.longKey.offered, true);
      assert.notEqual(ctx.longKeyCardHtml(st.longKey), '', '화면 함수가 그 상태로 카드를 그린다');

      assert.equal((await m.post('/api/online/longkey')).ok, true);
      assert.equal((await m.post('/api/online/longkey')).already, true, '두 번 눌러도 하나만');
      const waiting = await m.until('/api/online/longkey', (b) => b.longKey.state === 'approve', '승인 대기');
      assert.match(ctx.longKeyCardHtml(waiting.longKey), /<a class="open-link"/, '가짜 승인 주소도 진짜와 같은 모양이라 링크가 걸린다');
      const last = await m.until('/api/online/longkey', (b) => b.longKey.state === end, `${mode} → ${end}`);
      assert.ok(last.longKey.message, '서버와 같은 글이 온다');
      if (mode === 'wait') { await new Promise((r) => setTimeout(r, 900)); assert.equal((await m.get('/api/online/longkey')).longKey.state, 'approve', '승인 대기에서 멈춰 있다'); }
      // 카드가 어떻게 끝나든 설치는 끝까지 간다.
      assert.equal((await m.post('/api/online/relay')).ok, true);
      await m.until('/api/state', (b) => b.step === 'done', '완료 화면');
    } finally { m.stop(); }
  }
});

test('가짜 서버: 코덱스만 고르면 카드가 없다 · --longkey none 이면 클로드여도 없다 · 「나중에」는 접어 둘 뿐', async () => {
  const codex = await startMock([]);
  try {
    await mockLogin(codex, ['chatgpt']);
    const st = await codex.get('/api/online/status');
    assert.equal(st.longKey.offered, false);
    assert.equal(ctx.longKeyCardHtml(st.longKey), '');
  } finally { codex.stop(); }

  const none = await startMock(['--longkey', 'none']);
  try {
    await mockLogin(none, ['claude']);
    assert.equal((await none.get('/api/online/status')).longKey.offered, false);
  } finally { none.stop(); }

  const later = await startMock([]);
  try {
    await mockLogin(later, ['claude']);
    const r = await later.post('/api/online/longkey/skip');
    assert.deepEqual({ ok: r.ok, skipped: r.longKey.skipped, offered: r.longKey.offered, state: r.longKey.state }, { ok: true, skipped: true, offered: true, state: 'idle' });
    assert.match(ctx.longKeyCardHtml(r.longKey), /나중에 받기로 했습니다/);
  } finally { later.stop(); }
});
