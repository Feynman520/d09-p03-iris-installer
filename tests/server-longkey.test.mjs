// 2.0.66 — 「1년 열쇠 받기(권장)」 카드의 서버 길(`GET|POST /api/online/longkey` · `POST /api/online/longkey/skip`).
//
// 지키는 것(코덱스 검토 반영): 카드는 클로드 로그인이 **끝난 뒤에만** 나오고, 건너뛰어도 · 실패해도 · 두 번 눌러도 ·
// 설치 창을 닫아도 **기존 로그인과 설치 완료 상태는 그대로**다. 카드를 누르지 않으면 영수증 · 인수 문서 · 영혼 폴더의
// 어떤 파일도 바뀌지 않는다. 기록에는 계정 이름도 승인 주소도 남지 않는다.
//
// 실제 계정 · 실제 로그인 0 — 온라인 일꾼은 전부 가짜이고, 서버는 임시 영혼 폴더(soulRoot)만 쓴다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../installer/server.mjs';
import { SETUP_STAGE_IDS, readReceipt, setupAllDone, onlineDone } from '../installer/lib/receipt.mjs';
import { longKeyMessage } from '../installer/lib/longkey.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-server-longkey-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const zipRoot = path.join(tmp, 'zip-root');
fs.mkdirSync(path.join(zipRoot, 'payload'), { recursive: true });
fs.writeFileSync(path.join(zipRoot, 'payload', 'manifest.json'), JSON.stringify({ schema: 1, package: { name: 'IRIS', version: '2.0.0' }, parts: {} }), 'utf8');
fs.writeFileSync(path.join(zipRoot, 'lock.json'), JSON.stringify({ schema: 1, package: { version: '2.0.0' }, parts: {} }), 'utf8');
const JSON_HDR = { 'Content-Type': 'application/json' };
const post = (url, p, body) => fetch(`${url}${p}`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify(body ?? {}) });
const postJson = async (url, p, body) => (await post(url, p, body)).json();
const getJson = async (url, p) => (await fetch(`${url}${p}`)).json();
const OK_PRECHECK = { blockers: [], warnings: [], info: {}, recorded: { os: { ok: true, build: 26200 } } };
const TREE = [{ id: 'r1', parentId: null, level: 'R', nameKo: '교사', nameEn: 'Teacher', order: 1 }];

// 승인 주소에는 계정 귀띔 칸이 있다 — 기록 · 상태 파일 · 영수증에 흘러가면 안 되는 글자.
const HINT = 'owner%40example.com';
const APPROVE_URL = `https://claude.ai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Fcallback&state=STATE-VALUE&login_hint=${HINT}`;
const YEAR_MS = 365 * 86400000;

/** 가짜 1년 열쇠 일꾼: 서버가 부르는 네 함수만 흉내 낸다(프로그램 · 파일 · 네트워크 없음). */
function fakeLongKey({ available = true, reason = 'no-tool' } = {}) {
  const calls = { start: 0, stop: 0, avail: 0 };
  let job = null;
  let onFinish = null;
  const running = () => job && (job.state === 'starting' || job.state === 'approve');
  return {
    calls,
    /** 가짜 프로그램이 결과를 냈다. 서버의 기록(영수증 한 줄)이 끝날 때까지 기다린다. */
    async finish(result) {
      job = { ...job, ...result, url: null, message: longKeyMessage(result) };
      await onFinish?.({ state: result.state, expiresAt: result.expiresAt ?? null, reason: result.reason ?? null });
    },
    fns: {
      longKeyAvailability: async () => { calls.avail += 1; return available ? { available: true, reason: null } : { available: false, reason }; },
      startLongKey: async (args) => {
        if (running()) return { ok: true, state: job.state, already: true };
        calls.start += 1;
        onFinish = args.onFinish;
        args.log?.('longkey claude account #1 started pid=4242');
        job = { state: 'approve', url: APPROVE_URL, startedAt: 111, expiresAt: null, reason: null, message: longKeyMessage({ state: 'approve' }) };
        return { ok: true, state: 'starting', already: false };
      },
      longKeyStatus: async () => job ?? { state: 'idle', url: null },
      stopLongKey: async () => { calls.stop += 1; if (running()) job = { ...job, state: 'failed', reason: 'stopped', url: null }; return { stopped: true }; },
    },
  };
}

let seq = 0;
async function start({ longKey = fakeLongKey(), runner = {}, withLongKey = true } = {}) {
  const id = `k${++seq}`;
  const soulRoot = path.join(tmp, 'souls', id);
  const workDir = path.join(tmp, 'logs', id);
  const stateFile = path.join(tmp, `state-${id}.json`);
  const onlineRunner = {
    checkNet: async () => ({ ok: true, blocked: [] }),
    installClaude: async () => ({ ok: true, source: 'claude.ai' }),
    installDocumentSkills: async () => ({ ok: true, state: 'done', commit: 'deadbee' }),
    startLogin: async () => ({ ok: true, state: 'waiting', cli: 'pending', relay: 'pending', mode: 'piped' }),
    loginStatus: async () => ({ state: 'done', cli: 'done', relay: 'done', reason: null }),
    startRelay: async () => ({ ok: true, state: 'done', accounts: 1 }),
    ...(withLongKey ? longKey.fns : {}),
    ...runner,
  };
  const server = await startServer({
    port: 0, zipRoot, nodeDir: path.dirname(process.execPath), stateFile, soulRoot, workDir,
    precheckFn: async () => OK_PRECHECK,
    setupRunner: { async runSetup(ctx, { onStage }) { for (const s of SETUP_STAGE_IDS) onStage({ id: s, status: 'done' }); return { ok: true, pending: [] }; } },
    onlineRunner,
    relayRecheckFn: async () => ({ at: '2026-11-27T00:00:00.000Z', items: [] }),
    reportFetchFn: async () => ({ status: 200 }),
  });
  return { ...server, soulRoot, workDir, stateFile, longKey };
}

async function waitFor(url, p, pred, what) {
  for (let i = 0; i < 300; i++) { const b = await getJson(url, p); if (pred(b)) return b; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail(`never reached: ${what}`);
}

/** 설치 6단계를 끝내고 로그인 국면까지 간다(로그인 단추는 아직 누르지 않았다). */
async function toLoginPhase(s, subs = ['claude']) {
  await post(s.url, '/api/precheck');
  await post(s.url, '/api/locate');
  await post(s.url, '/api/choice', { subscriptions: subs });
  await post(s.url, '/api/structure', { nodes: TREE });
  await post(s.url, '/api/summary/confirm');
  await post(s.url, '/api/setup/start');
  await waitFor(s.url, '/api/setup/progress', (b) => b.percent === 100, '설치 100%');
  await post(s.url, '/api/online/start');
  await waitFor(s.url, '/api/online/status', (b) => b.stage === 'login' || b.stage === 'relay', '로그인 국면');
}
async function loginAll(s, subs = ['claude']) {
  for (const p of subs) await post(s.url, '/api/online/login', { provider: p });
  await waitFor(s.url, '/api/online/status', (b) => subs.every((p) => b.logins[p]?.state === 'done'), '로그인 끝');
}

/** 영혼 폴더 전체의 지문(설치 기록 파일은 뺀다 — 다른 길이 한 줄씩 덧붙인다). */
function soulSnapshot(root) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name !== 'installer.log') out[path.relative(root, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(root);
  return out;
}
function allLogs(s) {
  let text = '';
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.log$/.test(e.name)) text += fs.readFileSync(p, 'utf8'); } };
  walk(s.workDir); walk(path.join(s.soulRoot, '_agent', 'setup'));
  return text;
}
const receiptFile = (root) => path.join(root, '_agent', 'setup', 'package-receipt.json');
const handoffFile = (root) => path.join(root, '_agent', 'setup', 'handoff.json');

// ---------------------------------------------------------------------------
// 언제 나오는가
// ---------------------------------------------------------------------------
test('카드는 클로드 로그인이 끝난 뒤에만 나온다 — 그 전에는 받기도 거절한다', async () => {
  // 로그인 단계: 브라우저 로그인만 끝나고 계정 옮겨 담기는 아직(cli-done) → 다 끝남(done) 순으로 바뀌는 가짜.
  let phase = 'waiting';
  const s = await start({ runner: { loginStatus: async () => (phase === 'done'
    ? { state: 'done', cli: 'done', relay: 'done', reason: null }
    : { state: phase, cli: phase === 'cli-done' ? 'done' : 'pending', relay: 'pending', reason: null }) } });
  try {
    await toLoginPhase(s);
    for (phase of ['waiting', 'cli-done']) {
      const before = await getJson(s.url, '/api/online/status');
      assert.equal(before.logins.claude.state, phase);
      assert.equal(before.longKey.offered, false, `로그인 ${phase} 에서는 카드가 없다(중계기에 계정이 들어간 뒤에만)`);
      assert.equal(before.longKey.state, 'idle');
      const refused = await postJson(s.url, '/api/online/longkey');
      assert.deepEqual({ ok: refused.ok, reason: refused.reason }, { ok: false, reason: 'claude-login-first' });
    }
    assert.equal(s.longKey.calls.start, 0, '프로그램을 띄우지 않는다');
    assert.equal(s.longKey.calls.avail, 0, '계정 줄을 들여다보지도 않는다');

    phase = 'done';
    await loginAll(s);
    const after = await getJson(s.url, '/api/online/status');
    assert.equal(after.longKey.offered, true);
    assert.equal(after.longKey.state, 'idle');
    assert.equal(after.longKey.skipped, false);
    assert.deepEqual((await getJson(s.url, '/api/online/longkey')).longKey, after.longKey, '따로 조회해도 같은 모양');
  } finally { await s.close(); }
});

test('코덱스만 고른 설치에는 카드가 없다(로그인이 끝나도) · 받기를 눌러도 띄우지 않는다', async () => {
  const s = await start();
  try {
    await toLoginPhase(s, ['chatgpt']);
    await loginAll(s, ['chatgpt']);
    const st = await getJson(s.url, '/api/online/status');
    assert.equal(st.longKey.offered, false);
    assert.equal((await postJson(s.url, '/api/online/longkey')).reason, 'claude-login-first');
    assert.equal(s.longKey.calls.start, 0);
    assert.equal(s.longKey.calls.avail, 0, '클로드를 고르지 않았으면 계정 줄을 들여다보지도 않는다');
  } finally { await s.close(); }
});

test('둘 다 고른 설치: 클로드 로그인만 끝나도 카드가 나온다(코덱스 로그인을 기다리지 않는다)', async () => {
  const s = await start({ runner: { loginStatus: async ({ provider }) => (provider === 'claude' ? { state: 'done', cli: 'done', relay: 'done', reason: null } : { state: 'waiting', cli: 'pending', relay: 'pending', reason: null }) } });
  try {
    await toLoginPhase(s, ['claude', 'chatgpt']);
    await post(s.url, '/api/online/login', { provider: 'claude' });
    const st = await waitFor(s.url, '/api/online/status', (b) => b.logins.claude?.state === 'done', '클로드 로그인 끝');
    assert.equal(st.logins.chatgpt.state, 'waiting');
    assert.equal(st.longKey.offered, true);
  } finally { await s.close(); }
});

test('낼 수 없는 PC(도구가 없음)에서는 카드가 없고 까닭만 싣는다', async () => {
  const s = await start({ longKey: fakeLongKey({ available: false, reason: 'no-tool' }) });
  try {
    await toLoginPhase(s); await loginAll(s);
    const st = await getJson(s.url, '/api/online/status');
    assert.deepEqual({ offered: st.longKey.offered, reason: st.longKey.reason }, { offered: false, reason: 'no-tool' });
  } finally { await s.close(); }
});

test('1년 열쇠 일꾼이 없는 설치기(옛 일꾼)에서도 상태 조회는 그대로 답한다 · 받기는 "없음"으로 거절', async () => {
  const s = await start({ withLongKey: false });
  try {
    await toLoginPhase(s); await loginAll(s);
    const st = await getJson(s.url, '/api/online/status');
    assert.equal(st.longKey.offered, false);
    const r = await postJson(s.url, '/api/online/longkey');
    assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'E-NOT-IMPLEMENTED' });
    assert.equal((await postJson(s.url, '/api/online/relay')).ok, true, '설치는 그대로 끝난다');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// 누르지 않음 · 건너뜀 = 변경 0
// ---------------------------------------------------------------------------
test('카드를 누르지 않으면 · 「나중에」를 누르면: 영수증 · 인수 문서 · 영혼 폴더의 모든 파일이 카드 전과 같다', async () => {
  const s = await start();
  try {
    await toLoginPhase(s); await loginAll(s);
    fs.writeFileSync(handoffFile(s.soulRoot), `${JSON.stringify({ schema: 1, state: 'login-pending', subscriptions: ['claude'], messenger: { installed: false, prompted: false } }, null, 2)}\n`);
    const before = soulSnapshot(s.soulRoot);
    const receiptBefore = fs.readFileSync(receiptFile(s.soulRoot));
    const logBefore = allLogs(s);

    for (let i = 0; i < 4; i++) { await getJson(s.url, '/api/online/status'); await getJson(s.url, '/api/online/longkey'); }
    const skipped = await postJson(s.url, '/api/online/longkey/skip');
    assert.equal(skipped.ok, true);
    assert.equal(skipped.longKey.skipped, true);
    assert.equal(skipped.longKey.offered, true, '건너뛴 것은 접어 둘 뿐 — 다시 누를 수 있다');
    assert.equal((await getJson(s.url, '/api/online/status')).longKey.skipped, true);

    assert.deepEqual(soulSnapshot(s.soulRoot), before, '영혼 폴더의 어떤 파일도 바뀌지 않았다');
    assert.ok(fs.readFileSync(receiptFile(s.soulRoot)).equals(receiptBefore), '영수증은 한 바이트도 다르지 않다');
    assert.equal(allLogs(s), logBefore, '조회 · 건너뜀은 기록도 남기지 않는다');
    assert.equal(s.longKey.calls.start, 0);
    assert.ok(!('longKey' in JSON.parse(fs.readFileSync(s.stateFile, 'utf8')).online), '카드 상태는 설치기 상태 파일에 들어가지 않는다');

    // 건너뛴 채로 설치는 지금까지와 똑같이 끝난다 — 영수증에 1년 열쇠 칸이 생기지 않는다.
    assert.equal((await postJson(s.url, '/api/online/relay')).ok, true);
    assert.equal((await getJson(s.url, '/api/state')).step, 'done');
    const receipt = readReceipt(s.soulRoot);
    assert.equal(onlineDone(receipt), true);
    assert.deepEqual(Object.keys(receipt.online.logins.claude).filter((k) => /longKey/i.test(k)), []);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// 받기 → 승인 대기 → 끝남
// ---------------------------------------------------------------------------
test('받기: 승인 대기(주소) → 성공. 영수증에 세 칸만 더해지고 기존 로그인 · 완료 상태는 그대로다', async () => {
  const s = await start();
  try {
    await toLoginPhase(s); await loginAll(s);
    assert.equal((await postJson(s.url, '/api/online/relay')).ok, true);   // 설치 완료 화면까지 간 뒤에 누른다
    fs.writeFileSync(handoffFile(s.soulRoot), `${JSON.stringify({ schema: 1, state: 'ready', writtenAt: 'W', subscriptions: ['claude'], login: { claude: 'done', chatgpt: 'not-needed' }, messenger: { installed: false, prompted: true } }, null, 2)}\n`);
    const receiptBefore = readReceipt(s.soulRoot);
    const loginBefore = JSON.stringify(receiptBefore.online.logins.claude);

    const started = await postJson(s.url, '/api/online/longkey');
    assert.equal(started.ok, true);
    assert.equal(started.longKey.state, 'approve');
    assert.equal(started.longKey.url, APPROVE_URL, '승인 주소는 화면의 링크로 간다');
    assert.match(started.longKey.message, /승인/);
    assert.equal((await getJson(s.url, '/api/online/longkey')).longKey.state, 'approve');
    assert.deepEqual(readReceipt(s.soulRoot), receiptBefore, '승인을 기다리는 동안에는 영수증이 그대로다');

    const expiresAt = Date.now() + YEAR_MS;
    await s.longKey.finish({ state: 'done', expiresAt });
    const done = (await getJson(s.url, '/api/online/longkey')).longKey;
    assert.deepEqual(Object.keys(done).sort(), ['expiresAt', 'message', 'offered', 'reason', 'skipped', 'startedAt', 'state', 'url'], '상태의 칸(자리별 결과 같은 것은 없다)');
    assert.deepEqual({ offered: done.offered, state: done.state, url: done.url, expiresAt: done.expiresAt }, { offered: true, state: 'done', url: null, expiresAt });
    assert.match(done.message, /1년 열쇠를 받았습니다/);

    const receipt = readReceipt(s.soulRoot);
    const c = receipt.online.logins.claude;
    assert.equal(c.longKey, true);
    assert.equal(c.longKeyExpiresAt, expiresAt);
    assert.match(c.longKeyAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(c).filter((k) => /longKey/.test(k)).sort(), ['longKey', 'longKeyAt', 'longKeyExpiresAt'], '더해지는 칸은 셋뿐');
    const { longKey, longKeyExpiresAt, longKeyAt, ...rest } = c;
    assert.equal(JSON.stringify(rest), loginBefore, '로그인 칸(state · cli · relay …)은 카드 전과 글자가 같다');
    // 완료 판정 둘은 카드 전과 같은 답을 낸다(이 시험의 가짜 설치 엔진은 단계 기록을 쓰지 않아 setupAllDone 은 앞뒤 모두 false).
    assert.equal(setupAllDone(receipt), setupAllDone(receiptBefore));
    assert.equal(onlineDone(receipt), true);
    assert.deepEqual({ ...receipt, online: { ...receipt.online, logins: { ...receipt.online.logins, claude: rest } } }, receiptBefore, '영수증의 나머지는 전부 그대로');
    assert.equal((await getJson(s.url, '/api/state')).step, 'done');

    // 인수 문서: 1년 열쇠 한 칸만 갈아 끼운다 — 다른 칸(상태 · 쓴 시각 · 메신저 안내)은 그대로.
    const handoff = JSON.parse(fs.readFileSync(handoffFile(s.soulRoot), 'utf8'));
    assert.deepEqual(handoff.claudeLongKey, { state: 'received', expiresAt: new Date(expiresAt).toISOString(), howTo: null });
    assert.deepEqual({ state: handoff.state, writtenAt: handoff.writtenAt, messenger: handoff.messenger, login: handoff.login }, { state: 'ready', writtenAt: 'W', messenger: { installed: false, prompted: true }, login: { claude: 'done', chatgpt: 'not-needed' } });

    // 기록 · 상태 파일 · 영수증에 계정 이름도 승인 주소도 없다.
    const logs = allLogs(s);
    assert.match(logs, /longkey claude account #1 started/);
    for (const [name, text] of [['기록', logs], ['상태 파일', fs.readFileSync(s.stateFile, 'utf8')], ['영수증', fs.readFileSync(receiptFile(s.soulRoot), 'utf8')], ['인수 문서', fs.readFileSync(handoffFile(s.soulRoot), 'utf8')]]) {
      // (계정 이름은 조각으로 이어 만든다 — 정화 규칙이 이메일 꼴 글자를 예시라도 막는다.)
      for (const bad of [HINT, ['owner', 'example.com'].join('@'), 'oauth/authorize', 'STATE-VALUE', 'login_hint']) assert.ok(!text.includes(bad), `${name}에 ${bad} 가 있으면 안 된다`);
    }
  } finally { await s.close(); }
});

test('로그인 화면에서 먼저 받은 1년 열쇠는 그 뒤 설치 완료(중계기 시작)가 영수증을 다시 쓸 때에도 남는다', async () => {
  const s = await start();
  try {
    await toLoginPhase(s); await loginAll(s);
    assert.equal((await postJson(s.url, '/api/online/longkey')).ok, true);
    const expiresAt = Date.now() + YEAR_MS;
    await s.longKey.finish({ state: 'done', expiresAt });
    assert.equal(readReceipt(s.soulRoot).online.logins.claude.longKey, true, '완료 전이어도 영수증에 한 줄 적는다');
    assert.equal(onlineDone(readReceipt(s.soulRoot)), false, '그렇다고 온라인 단계가 끝난 것으로 치지 않는다');
    assert.equal((await getJson(s.url, '/api/state')).step, 'online');

    assert.equal((await postJson(s.url, '/api/online/relay')).ok, true);
    const c = readReceipt(s.soulRoot).online.logins.claude;
    assert.deepEqual({ state: c.state, longKey: c.longKey, longKeyExpiresAt: c.longKeyExpiresAt }, { state: 'done', longKey: true, longKeyExpiresAt: expiresAt });
    assert.equal((await getJson(s.url, '/api/state')).step, 'done');
  } finally { await s.close(); }
});

test('두 번 눌러도 프로그램은 하나만 뜬다', async () => {
  const s = await start();
  try {
    await toLoginPhase(s); await loginAll(s);
    const [a, b] = await Promise.all([postJson(s.url, '/api/online/longkey'), postJson(s.url, '/api/online/longkey')]);
    const c = await postJson(s.url, '/api/online/longkey');
    assert.ok(a.ok && b.ok && c.ok);
    assert.equal(c.already, true);
    assert.equal(s.longKey.calls.start, 1);
    assert.equal(c.longKey.state, 'approve');
  } finally { await s.close(); }
});

test('실패(시간 초과 · 취소): 기존 로그인과 완료 상태는 그대로 — 영수증에는 "받지 않음" 한 줄 · 다시 누르면 새로 한 번', async () => {
  const s = await start();
  try {
    await toLoginPhase(s); await loginAll(s);
    assert.equal((await postJson(s.url, '/api/online/relay')).ok, true);
    const before = readReceipt(s.soulRoot);
    await postJson(s.url, '/api/online/longkey');
    await s.longKey.finish({ state: 'failed', reason: 'timeout' });

    const view = (await getJson(s.url, '/api/online/longkey')).longKey;
    assert.deepEqual({ offered: view.offered, state: view.state, reason: view.reason }, { offered: true, state: 'failed', reason: 'timeout' });
    assert.match(view.message, /지금 로그인은 그대로/);
    const receipt = readReceipt(s.soulRoot);
    const { longKey, longKeyExpiresAt, longKeyAt, ...rest } = receipt.online.logins.claude;
    assert.deepEqual({ longKey, longKeyExpiresAt }, { longKey: false, longKeyExpiresAt: null });
    assert.deepEqual(rest, before.online.logins.claude, '로그인 칸은 그대로');
    assert.equal(rest.state, 'done');
    assert.equal(onlineDone(receipt), true);
    assert.equal(setupAllDone(receipt), setupAllDone(before), '완료 판정은 카드 전과 같은 답');
    assert.equal((await getJson(s.url, '/api/state')).step, 'done');
    assert.equal((await getJson(s.url, '/api/online/status')).logins.claude.state, 'done');

    const again = await postJson(s.url, '/api/online/longkey');
    assert.equal(again.ok, true);
    assert.equal(again.already, undefined);
    assert.equal(s.longKey.calls.start, 2);
  } finally { await s.close(); }
});

test('한 번 받은 뒤의 실패는 "받음" 줄을 고치지 않는다(앞서 받은 열쇠는 그대로 유효하다) · 실패 뒤의 성공은 "받음"으로 바꾼다', async () => {
  const s = await start();
  try {
    await toLoginPhase(s); await loginAll(s);
    await postJson(s.url, '/api/online/relay');
    fs.writeFileSync(handoffFile(s.soulRoot), `${JSON.stringify({ schema: 1, state: 'ready', subscriptions: ['claude'] }, null, 2)}\n`);
    // 실패 → "받지 않음"
    await postJson(s.url, '/api/online/longkey');
    await s.longKey.finish({ state: 'failed', reason: 'denied' });
    assert.equal(readReceipt(s.soulRoot).online.logins.claude.longKey, false);
    assert.equal(JSON.parse(fs.readFileSync(handoffFile(s.soulRoot), 'utf8')).claudeLongKey.state, 'not-received');
    // 다시 받기 → 성공 → "받음"
    const expiresAt = Date.now() + YEAR_MS;
    await postJson(s.url, '/api/online/longkey');
    await s.longKey.finish({ state: 'done', expiresAt });
    let c = readReceipt(s.soulRoot).online.logins.claude;
    assert.deepEqual({ longKey: c.longKey, longKeyExpiresAt: c.longKeyExpiresAt }, { longKey: true, longKeyExpiresAt: expiresAt });
    assert.equal(JSON.parse(fs.readFileSync(handoffFile(s.soulRoot), 'utf8')).claudeLongKey.state, 'received');
    // 그 뒤의 실패(한 번 더 눌렀다가 취소) → 줄은 그대로
    const before = fs.readFileSync(receiptFile(s.soulRoot));
    await postJson(s.url, '/api/online/longkey');
    await s.longKey.finish({ state: 'failed', reason: 'timeout' });
    assert.ok(fs.readFileSync(receiptFile(s.soulRoot)).equals(before), '영수증은 한 바이트도 다르지 않다');
    c = readReceipt(s.soulRoot).online.logins.claude;
    assert.deepEqual({ longKey: c.longKey, longKeyExpiresAt: c.longKeyExpiresAt }, { longKey: true, longKeyExpiresAt: expiresAt });
    assert.equal(JSON.parse(fs.readFileSync(handoffFile(s.soulRoot), 'utf8')).claudeLongKey.state, 'received');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// 설치 창 닫힘
// ---------------------------------------------------------------------------
test('승인을 기다리는 중에 설치 창이 닫히면: 띄운 프로그램만 끝내고, 영수증 · 로그인 · 완료 상태는 그대로다', async () => {
  const s = await start();
  let closed = false;
  try {
    await toLoginPhase(s); await loginAll(s);
    assert.equal((await postJson(s.url, '/api/online/relay')).ok, true);
    const before = fs.readFileSync(receiptFile(s.soulRoot));
    await postJson(s.url, '/api/online/longkey');
    await s.close(); closed = true;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.longKey.calls.stop, 1, '자기가 띄운 것을 한 번 끝낸다');
    assert.ok(fs.readFileSync(receiptFile(s.soulRoot)).equals(before), '영수증은 한 바이트도 다르지 않다(1년 열쇠 칸이 생기지 않는다)');
    const receipt = readReceipt(s.soulRoot);
    assert.equal(receipt.online.logins.claude.state, 'done');
    assert.equal(onlineDone(receipt), true);
  } finally { if (!closed) await s.close(); }
});

test('한 번도 띄운 적이 없으면 설치 창이 닫힐 때 아무것도 끝내지 않는다', async () => {
  const s = await start();
  await toLoginPhase(s); await loginAll(s);
  await getJson(s.url, '/api/online/longkey');
  await postJson(s.url, '/api/online/longkey/skip');
  await s.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.longKey.calls.stop, 0);
});

test('POST /api/quit 으로 닫을 때도 띄운 프로그램을 먼저 끝낸다', async () => {
  let quit = false;
  const lk = fakeLongKey();
  const id = `q${++seq}`;
  const server = await startServer({
    port: 0, zipRoot, nodeDir: path.dirname(process.execPath),
    stateFile: path.join(tmp, `state-${id}.json`), soulRoot: path.join(tmp, 'souls', id), workDir: path.join(tmp, 'logs', id),
    precheckFn: async () => OK_PRECHECK,
    setupRunner: { async runSetup(ctx, { onStage }) { for (const st of SETUP_STAGE_IDS) onStage({ id: st, status: 'done' }); return { ok: true, pending: [] }; } },
    onlineRunner: {
      checkNet: async () => ({ ok: true, blocked: [] }), installClaude: async () => ({ ok: true, source: 'claude.ai' }),
      installDocumentSkills: async () => ({ ok: true, state: 'done' }), startLogin: async () => ({ ok: true, state: 'waiting' }),
      loginStatus: async () => ({ state: 'done', cli: 'done', relay: 'done', reason: null }), startRelay: async () => ({ ok: true, state: 'done', accounts: 1 }),
      ...lk.fns,
    },
    relayRecheckFn: async () => ({ at: 't', items: [] }), reportFetchFn: async () => ({ status: 200 }),
    onQuit: () => { quit = true; },
  });
  try {
    const s = { ...server };
    await toLoginPhase(s); await loginAll(s);
    await postJson(s.url, '/api/online/longkey');
    await post(s.url, '/api/quit');
    for (let i = 0; i < 100 && !quit; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(quit, true);
    assert.equal(lk.calls.stop, 1, '닫기 전에 한 번');
  } finally { await server.close(); }
});
