// 2.0.33 — 로그인 단계에서 구독을 다시 고른다(설계 조각 ①, 2026-09-21 사용자 결정).
// 친구 PC 실측: 클로드 로그인이 막히자 완료도 못 하고 뒤로도 못 갔다. `POST /api/online/choice` 로 빼거나 더한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../installer/server.mjs';
import { SETUP_STAGE_IDS } from '../installer/lib/receipt.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-server-choice-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const zipRoot = path.join(tmp, 'zip-root');
fs.mkdirSync(path.join(zipRoot, 'payload'), { recursive: true });
fs.writeFileSync(path.join(zipRoot, 'payload', 'manifest.json'), JSON.stringify({ schema: 1, package: { name: 'IRIS', version: '2.0.0' }, parts: {} }), 'utf8');
fs.writeFileSync(path.join(zipRoot, 'lock.json'), JSON.stringify({ schema: 1, package: { version: '2.0.0' }, parts: {} }), 'utf8');
const JSON_HDR = { 'Content-Type': 'application/json' };
const post = (url, p, body) => fetch(`${url}${p}`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify(body ?? {}) });
const getJson = async (url, p) => (await fetch(`${url}${p}`)).json();
const OK_PRECHECK = { blockers: [], warnings: [], info: {}, recorded: { os: { ok: true, build: 26200 } } };

let seq = 0;
async function start(over = {}) {
  const id = `c${++seq}`;
  const calls = { startLogin: [], installClaude: 0 };
  const onlineRunner = {
    checkNet: async () => ({ ok: true, blocked: [] }),
    installClaude: async () => { calls.installClaude++; return { ok: true, source: 'claude.ai' }; },
    installDocumentSkills: async () => ({ ok: true, state: 'done', commit: 'deadbee' }),
    startLogin: async (o) => { calls.startLogin.push(o.provider); return { ok: true, state: 'waiting', cli: 'pending', relay: 'pending', mode: 'piped' }; },
    loginStatus: async () => ({ state: 'waiting', cli: 'pending', relay: 'pending', reason: null, url: 'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A65416%2Fcallback' }),
    startRelay: async () => ({ ok: true, state: 'done', accounts: 1 }),
    ...over,
  };
  const server = await startServer({
    port: 0, zipRoot, nodeDir: path.dirname(process.execPath),
    stateFile: path.join(tmp, `state-${id}.json`), soulRoot: path.join(tmp, 'souls', id), workDir: path.join(tmp, 'logs', id),
    precheckFn: async () => OK_PRECHECK,
    setupRunner: { async runSetup(ctx, { onStage }) { for (const s of SETUP_STAGE_IDS) onStage({ id: s, status: 'done' }); return { ok: true, pending: [] }; } },
    onlineRunner,
    relayRecheckFn: async () => ({ at: '2026-09-21T00:00:00.000Z', items: [] }),
    reportFetchFn: async () => ({ status: 200 }),
  });
  return { ...server, calls };
}

async function toOnline(url, subs) {
  await post(url, '/api/precheck');
  await post(url, '/api/locate');
  await post(url, '/api/choice', { subscriptions: subs });
}

async function waitOnline(url, pred) {
  for (let i = 0; i < 200; i++) { const b = await getJson(url, '/api/online/status'); if (pred(b)) return b; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail('online status never matched');
}

test('online/choice: 로그인 단계에서 클로드를 빼면 그 상자는 not-needed, 앞장은 코덱스, 코덱스만 끝나면 넘어간다', async () => {
  const s = await start();
  try {
    await toOnline(s.url, ['claude', 'chatgpt']);
    await post(s.url, '/api/online/start');
    await waitOnline(s.url, (b) => b.stage === 'login');
    const r = await (await post(s.url, '/api/online/choice', { subscriptions: ['chatgpt'] })).json();
    assert.equal(r.ok, true);
    assert.deepEqual(r.subscriptions, ['chatgpt']);
    assert.equal(r.leadAgent, 'chatgpt');
    const st = await getJson(s.url, '/api/online/status');
    assert.equal(st.logins.claude.state, 'not-needed');
    assert.equal(st.logins.chatgpt.state, 'waiting');
  } finally { s.close(); }
});

test('online/choice: 빈 목록은 거절(비서가 일할 수 없음), 상태는 그대로', async () => {
  const s = await start();
  try {
    await toOnline(s.url, ['claude']);
    await post(s.url, '/api/online/start');
    await waitOnline(s.url, (b) => b.stage === 'login');
    const r = await (await post(s.url, '/api/online/choice', { subscriptions: [] })).json();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
    const st = await getJson(s.url, '/api/online/status');
    assert.equal(st.logins.claude.state, 'waiting');
  } finally { s.close(); }
});

test('online/choice: 코덱스만 골라도 클로드는 이미 받아 두었으므로, 클로드를 더하면 상자만 생긴다(2.0.38)', async () => {
  const s = await start();
  try {
    await toOnline(s.url, ['chatgpt']);
    await post(s.url, '/api/online/start');
    await waitOnline(s.url, (b) => b.stage === 'login');
    assert.equal(s.calls.installClaude, 1, '구독과 상관없이 Claude Code 를 받는다');
    const before = await getJson(s.url, '/api/online/status');
    assert.equal(before.claude.state, 'done');
    assert.equal(before.claude.optional, true);
    const r = await (await post(s.url, '/api/online/choice', { subscriptions: ['chatgpt', 'claude'] })).json();
    assert.equal(r.ok, true);
    assert.equal(r.leadAgent, 'claude');
    assert.equal(r.restarted, false, '이미 받았으니 다시 돌지 않는다');
    const st = await waitOnline(s.url, (b) => b.stage === 'login' && b.claude?.state === 'done');
    assert.equal(s.calls.installClaude, 1);
    assert.equal(st.claude.optional, false);
    assert.equal(st.logins.claude.state, 'waiting');
    assert.equal(st.logins.chatgpt.state, 'waiting');
  } finally { s.close(); }
});

test('online/status: 파이프 로그인이 알아낸 자동 복귀 주소(url)와 mode 가 상자에 실린다', async () => {
  const s = await start();
  try {
    await toOnline(s.url, ['claude']);
    await post(s.url, '/api/online/start');
    await waitOnline(s.url, (b) => b.stage === 'login');
    const login = await (await post(s.url, '/api/online/login', { provider: 'claude' })).json();
    assert.equal(login.ok, true);
    const st = await getJson(s.url, '/api/online/status');
    assert.equal(st.logins.claude.mode, 'piped');
    assert.match(st.logins.claude.url, /localhost%3A65416/);
    assert.doesNotMatch(st.logins.claude.url, /platform\.claude\.com/);
  } finally { s.close(); }
});

test('online/choice: 이미 끝난 로그인은 다시 골라도 done 그대로(로그인을 다시 시키지 않는다)', async () => {
  // 클로드만 곧바로 done, 코덱스는 계속 waiting 인 가짜 — "끝난 것은 그대로, 안 끝난 것은 다시 waiting" 을 가른다
  const s = await start({ loginStatus: async ({ provider }) => (provider === 'claude'
    ? { state: 'done', cli: 'done', relay: 'done', reason: null }
    : { state: 'waiting', cli: 'pending', relay: 'pending', reason: null }) });
  try {
    await toOnline(s.url, ['claude', 'chatgpt']);
    await post(s.url, '/api/online/start');
    await waitOnline(s.url, (b) => b.logins?.claude?.state === 'done');
    await post(s.url, '/api/online/choice', { subscriptions: ['claude'] });
    const a = await getJson(s.url, '/api/online/status');
    assert.equal(a.logins.chatgpt.state, 'not-needed');
    await post(s.url, '/api/online/choice', { subscriptions: ['claude', 'chatgpt'] });
    const b = await getJson(s.url, '/api/online/status');
    assert.equal(b.logins.claude.state, 'done');
    assert.equal(b.logins.chatgpt.state, 'waiting');
  } finally { s.close(); }
});

// 2.0.36 (2026-09-23 다른 선생님 PC 실사고): 내려받기가 끝나기 전·실패한 뒤 로그인을 눌렀더니 아무 창도 안 떴다.
test('online/login: Claude Code 를 받는 중에는 로그인을 띄우지 않고 claude-downloading 으로 돌려준다', async () => {
  let finish;
  const gate = new Promise((r) => { finish = r; });
  const s = await start({ installClaude: async () => { await gate; return { ok: false, code: 'E-DL', message: '내려받지 못했습니다' }; } });
  try {
    await toOnline(s.url, ['claude']);
    await post(s.url, '/api/online/start');
    await waitOnline(s.url, (b) => b.claude?.state === 'downloading');
    const early = await (await post(s.url, '/api/online/login', { provider: 'claude' })).json();
    assert.equal(early.ok, false);
    assert.equal(early.reason, 'claude-downloading');
    assert.deepEqual(s.calls.startLogin, []);
    finish();
    const st = await waitOnline(s.url, (b) => b.claude?.state === 'failed');
    assert.equal(st.claude.message, '내려받지 못했습니다');
  } finally { s.close(); }
});

test('online/login: 로그인 시작 시각(startedAt)이 상자에 실리고 상태 확인 뒤에도 남는다', async () => {
  const s = await start();
  try {
    await toOnline(s.url, ['claude']);
    await post(s.url, '/api/online/start');
    await waitOnline(s.url, (b) => b.stage === 'login');
    const t0 = Date.now();
    await post(s.url, '/api/online/login', { provider: 'claude' });
    const st = await getJson(s.url, '/api/online/status');
    assert.ok(Number(st.logins.claude.startedAt) >= t0);
    assert.ok(Number(st.now) >= Number(st.logins.claude.startedAt));
  } finally { s.close(); }
});
