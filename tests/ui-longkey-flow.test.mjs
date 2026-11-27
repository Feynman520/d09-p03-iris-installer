// 2.0.66 — 「1년 열쇠 받기(권장)」 카드가 화면 흐름 안에서 실제로 도는가.
// index.html 의 스크립트 전체를 **가짜 DOM · 가짜 서버(fetch)** 위에서 한 번 돌린다(브라우저 · 진짜 서버 · 네트워크 없음).
// 낱개 함수 시험(tests/ui-longkey.test.mjs)이 못 보는 것을 본다: 초기화 순서 · 카드 자리 · 누르기 · ⑦ → ⑧ 넘어가기.
// 가장 중요한 약속: **카드가 어떤 상태든(승인 대기 포함) 화면은 계정 연결을 부르고 완료 화면으로 넘어간다.**
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'installer', 'ui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ui-flow-'));
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// ---- 가짜 DOM: 화면 스크립트는 요소를 id 로만 찾는다. innerHTML 로 새로 생긴 id 도 요소로 친다.
const els = new Map();
function makeEl(id) {
  const listeners = {};
  return {
    id, hidden: false, disabled: false, textContent: '', className: '', value: '', checked: false, dataset: {}, style: {}, _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); for (const x of this._html.matchAll(/id="([^"]+)"/g)) els.set(x[1], makeEl(x[1])); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    press(act) { for (const fn of listeners.click || []) fn({ target: { closest: () => ({ disabled: false, getAttribute: () => act }) } }); },
    getAttribute() { return null; }, setAttribute() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    appendChild() {}, focus() {}, scrollIntoView() {}, closest() { return null; },
  };
}
for (const x of html.matchAll(/id="([^"]+)"/g)) els.set(x[1], makeEl(x[1]));
globalThis.document = { getElementById: (id) => els.get(id) || null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => makeEl('x') };
globalThis.window = { scrollTo() {}, addEventListener() {}, location: { reload() {} } };
globalThis.EventSource = class { close() {} };

// ---- 가짜 서버: 클로드 로그인이 막 끝난 ⑦ 에서 시작한다. 계정 연결은 holdRelay 를 풀 때까지 "하는 중"이다.
const calls = [];
let longKey = { offered: true, state: 'idle', skipped: false, url: null, message: null };
let relay = { state: 'pending' };
let holdRelay = true;
const online = () => ({
  ok: true, step: relay.state === 'done' ? 'done' : 'online', stage: 'login', net: { ok: true, blocked: [] }, claude: { state: 'done', source: 'claude.ai' },
  logins: { claude: { state: 'done', cli: 'done', relay: 'done' }, chatgpt: { state: 'not-needed' } }, relay, now: Date.now(), longKey,
});
globalThis.fetch = async (p, opts = {}) => {
  const method = opts.method || 'GET';
  calls.push(`${method} ${p}`);
  let body = {};
  if (p === '/api/state') body = { ok: true, step: 'online', choice: { subscriptions: ['claude'], leadAgent: 'claude' }, decisions: null, setup: null, online: online(), soul: { root: 'X', mode: 'iris' } };
  else if (p === '/api/online/status') body = online();
  else if (p === '/api/online/longkey' && method === 'GET') body = { ok: true, longKey };
  else if (p === '/api/online/longkey') { longKey = { ...longKey, skipped: false, state: 'approve', url: 'https://claude.ai/oauth/authorize?state=s', message: '브라우저에 뜬 화면에서 「승인(Authorize)」을 한 번 눌러 주세요.' }; body = { ok: true, longKey }; }
  else if (p === '/api/online/longkey/skip') { longKey = { ...longKey, skipped: true }; body = { ok: true, longKey }; }
  else if (p === '/api/online/relay') { relay = holdRelay ? { state: 'running' } : { state: 'done', accounts: 1 }; body = { ok: true }; }
  else if (p === '/api/report') body = { ok: true, handoff: { subscriptions: ['claude'], leadAgent: 'claude', claudeLongKey: { state: 'not-received' } }, pendingCapabilities: [] };
  else body = { ok: true };
  return { status: 200, json: async () => body };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, what, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return; await sleep(40); } assert.fail(`기다리다 끝남: ${what}`); };
const count = (c) => calls.filter((x) => x === c).length;

test('화면 흐름: ⑦ 의 클로드 상자 아래 카드 → 나중에 · 받기 → 승인 대기여도 ⑧ 로 넘어감 → ⑧ 의 같은 카드와 완료 보고 한 줄', async () => {
  assert.ok(script, 'index.html 의 스크립트를 찾는다');
  fs.copyFileSync(path.join(UI, 'structure.mjs'), path.join(dir, 'structure.mjs'));
  fs.writeFileSync(path.join(dir, 'ui.mjs'), script);
  await import(pathToFileURL(path.join(dir, 'ui.mjs')).href);

  // ⑦: 클로드 로그인 상자 안에 카드가 그려진다(코덱스 상자에는 자리 자체가 없다).
  await until(() => /class="longkey"/.test(els.get('longkey-claude')?.innerHTML ?? ''), '⑦ 의 카드');
  const box = els.get('longkey-claude');
  assert.match(box.innerHTML, /<h4>1년 열쇠 받기\(권장\)<\/h4>/);
  assert.match(box.innerHTML, /data-lk="get">받기<\/button><button class="ghost" data-lk="later">나중에<\/button>/);
  assert.equal(els.has('longkey-chatgpt'), false);
  assert.equal(els.get('card-online').hidden, false, '아직 ⑦ 이다(계정 연결을 하는 중)');
  assert.ok(count('POST /api/online/relay') >= 1, '카드가 떠 있어도 로그인이 끝났으니 계정 연결을 스스로 부른다');

  // 「나중에」 → 접힌 한 줄. 건너뛰기 길만 부른다.
  box.press('later');
  await until(() => /나중에 받기로 했습니다/.test(box.innerHTML), '접힌 한 줄');
  assert.equal(count('POST /api/online/longkey/skip'), 1);
  assert.equal(count('POST /api/online/longkey'), 0);

  // 「지금 받기」 → 승인 대기(링크). 단추는 사라진다.
  box.press('get');
  await until(() => /<a class="open-link"/.test(box.innerHTML), '승인 대기');
  assert.equal(count('POST /api/online/longkey'), 1);
  assert.doesNotMatch(box.innerHTML, /<button/);

  // 승인을 기다리는 중에 계정 연결이 끝난다 → 화면은 ⑧ 로 넘어간다(카드를 기다리지 않는다).
  holdRelay = false;
  relay = { state: 'done', accounts: 1 };
  await until(() => els.get('card-done').hidden === false, '⑧ 완료 화면');
  assert.equal(els.get('card-online').hidden, true);

  // ⑧: 같은 카드가 여기에도 있고, 완료 보고에 한 줄이 있다.
  const doneBox = els.get('longkey-done');
  await until(() => /<a class="open-link"/.test(doneBox.innerHTML), '⑧ 의 카드(승인 대기)');
  const line = els.get('report-longkey');
  await until(() => /승인을 기다리는 중/.test(line?.textContent ?? ''), '완료 보고의 한 줄');

  // 승인이 끝나면 ⑧ 의 카드와 한 줄이 저절로 바뀌고, 되묻기가 멈춘다.
  longKey = { offered: true, state: 'done', skipped: false, url: null, expiresAt: new Date(2027, 10, 27, 12).getTime(), message: '1년 열쇠를 받았습니다(만료 2027-11-27). 열쇠가 폐기되면 다시 연결하면 됩니다.' };
  await until(() => /1년 열쇠를 받았습니다/.test(doneBox.innerHTML), '받음');
  assert.equal(line.textContent, '1년 열쇠 · 만료 2027-11-27');
  assert.doesNotMatch(doneBox.innerHTML, /<button|<a /, '끝난 카드에는 누를 것이 없다');
  await sleep(300);
  const asked = count('GET /api/online/longkey');
  await sleep(2300);
  assert.equal(count('GET /api/online/longkey'), asked, '끝난 뒤에는 서버에 더 묻지 않는다');
  assert.equal(els.get('card-done').hidden, false, '완료 화면 그대로');
});
