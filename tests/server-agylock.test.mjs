// 2.0.67 — 설치 화면의 Antigravity 잠긴 줄, 서버 쪽.
//
// 지키는 것:
//   · `GET /api/state` 에 `locks: { antigravity: 'locked' | 'open' }` 이 실린다(그 설치 폴더의 열쇠만 본다 · 서버가 뜰 때 한 번).
//   · `POST /api/choice` · `POST /api/online/choice` 가 받은 antigravity 값은 **잠금과 상관없이** 버린다 — 거절이 아니라 무시다
//     (클로드 · 챗지피티 선택은 그대로 처리). 이번 판에는 받기 장치가 없으므로 열쇠가 열린 PC 에서도 같다.
//   · `subscriptions` 에 셋째 값이 들어가지 않는다 — 주도 에이전트 · 로그인 상자 · "전부 로그인돼야 다음"이 그대로다.
//   · 클로드만 / 코덱스만 / 둘 다 흐름의 상태 · 영수증 · 인수 문서가, antigravity 값을 끼워 보낸 흐름과 **글자까지 같다**.
//   · 잠금 값은 상태 파일 · 영수증 · 인수 문서에 적히지 않는다(응답에만 실린다). 설치기는 열쇠 파일을 쓰지 않는다.
//
// 실제 계정 · 실제 로그인 0 — 온라인 일꾼은 전부 가짜이고, 서버는 임시 영혼 폴더(soulRoot)만 쓴다.
// 열쇠 파일은 이 시험이 그 임시 폴더에 쓴다(저장소 · 시험 자료에는 없다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../installer/server.mjs';
import { SETUP_STAGE_IDS, readReceipt, writeReceipt, ensureV2Fields } from '../installer/lib/receipt.mjs';
import { writeHandoff } from '../installer/setup/handoff.mjs';
import { AGY_KEY_FILE } from '../installer/lib/agylock.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-server-agylock-'));
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
const OPEN_KEY = JSON.stringify({ about: 'test only', antigravity: 'open' });

let seq = 0;
/** key = 서버를 띄우기 **전에** 그 영혼 폴더에 놓을 열쇠 파일의 글(없으면 놓지 않는다). */
async function start({ key = null, runner = {} } = {}) {
  const id = `a${++seq}`;
  const soulRoot = path.join(tmp, 'souls', id);
  const workDir = path.join(tmp, 'logs', id);
  const stateFile = path.join(tmp, `state-${id}.json`);
  const keyFile = path.join(soulRoot, ...AGY_KEY_FILE);
  if (key != null) { fs.mkdirSync(path.dirname(keyFile), { recursive: true }); fs.writeFileSync(keyFile, key); }
  const calls = { startLogin: [], loginStatus: [], installClaude: 0, startRelay: 0, other: [] };
  const onlineRunner = {
    checkNet: async () => ({ ok: true, blocked: [] }),
    installClaude: async () => { calls.installClaude += 1; return { ok: true, source: 'claude.ai' }; },
    installDocumentSkills: async () => ({ ok: true, state: 'done', commit: 'deadbee' }),
    startLogin: async (o) => { calls.startLogin.push(o.provider); return { ok: true, state: 'waiting', cli: 'pending', relay: 'pending', mode: 'piped' }; },
    loginStatus: async (o) => { calls.loginStatus.push(o.provider); return { state: 'done', cli: 'done', relay: 'done', reason: null }; },
    startRelay: async () => { calls.startRelay += 1; return { ok: true, state: 'done', accounts: 1 }; },
    ...runner,
  };
  const server = await startServer({
    port: 0, zipRoot, nodeDir: path.dirname(process.execPath), stateFile, soulRoot, workDir,
    precheckFn: async () => OK_PRECHECK,
    // 가짜 세팅 엔진: 아홉 단계를 "끝남"으로 알리고, 진짜 ⑨ 검사처럼 **진짜 함수로** 인수 문서를 쓴다(고른 구독은 서버가 넘긴 ctx.choice).
    setupRunner: {
      async runSetup(ctx, { onStage }) {
        for (const s of SETUP_STAGE_IDS) onStage({ id: s, status: 'done' });
        // 진짜 엔진이 단계마다 영수증에 적는 "끝남"을 한꺼번에 적는다(인수 문서의 ready 판정이 이것을 본다).
        const receipt = ensureV2Fields(readReceipt(ctx.root) ?? ctx.receipt);
        for (const id of SETUP_STAGE_IDS) receipt.setup[id] = { ...(receipt.setup[id] ?? {}), status: 'done' };
        writeReceipt(ctx.root, receipt);
        writeHandoff({ ...ctx, receipt }, { now: new Date('2026-11-27T00:00:00.000Z') });
        return { ok: true, pending: [] };
      },
    },
    onlineRunner,
    relayRecheckFn: async () => ({ at: '2026-11-27T00:00:00.000Z', items: [] }),
    reportFetchFn: async () => ({ status: 200 }),
  });
  return { ...server, soulRoot, workDir, stateFile, keyFile, calls };
}
async function waitFor(url, p, pred, what) {
  for (let i = 0; i < 300; i++) { const b = await getJson(url, p); if (pred(b)) return b; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail(`never reached: ${what}`);
}
function allLogs(s) {
  let text = '';
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.log$/.test(e.name)) text += fs.readFileSync(p, 'utf8'); } };
  walk(s.workDir); walk(path.join(s.soulRoot, '_agent', 'setup'));
  return text;
}
const receiptFile = (root) => path.join(root, '_agent', 'setup', 'package-receipt.json');
const handoffFile = (root) => path.join(root, '_agent', 'setup', 'handoff.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---------------------------------------------------------------------------
// GET /api/state 의 locks
// ---------------------------------------------------------------------------
test('GET /api/state: 열쇠가 없는 설치 폴더 = locks.antigravity "locked" — 상태 파일에는 적히지 않는다', async () => {
  const s = await start();
  try {
    const st = await getJson(s.url, '/api/state');
    assert.deepEqual(st.locks, { antigravity: 'locked' });
    await post(s.url, '/api/precheck');
    await post(s.url, '/api/locate');
    await post(s.url, '/api/choice', { subscriptions: ['claude'] });
    assert.deepEqual((await getJson(s.url, '/api/state')).locks, { antigravity: 'locked' });
    const saved = readJson(s.stateFile);
    assert.equal(Object.hasOwn(saved, 'locks'), false, '잠금 값은 응답에만 실린다(상태 파일에 남으면 다음 실행이 옛 값을 믿게 된다)');
    assert.doesNotMatch(JSON.stringify(saved), /antigravity/i);
    assert.equal(fs.existsSync(s.keyFile), false, '설치기는 열쇠 파일을 만들지 않는다');
  } finally { await s.close(); }
});

test('GET /api/state: 그 설치 폴더에 열쇠가 있으면 "open" — 정확히 open 일 때만, 서버가 뜰 때 한 번 읽는다', async () => {
  const open = await start({ key: OPEN_KEY });
  try {
    assert.deepEqual((await getJson(open.url, '/api/state')).locks, { antigravity: 'open' });
    // 열쇠만 미리 놓인 새 PC: 그 폴더는 "빈 설치 자리"로 읽혀 설치가 그대로 진행된다.
    await post(open.url, '/api/precheck');
    const loc = await postJson(open.url, '/api/locate');
    assert.equal(loc.ok, true);
    assert.notEqual(loc.mode, 'foreign');
    // 도는 중에 열쇠를 지워도 이 실행의 값은 그대로다(반영 = 다시 켤 때).
    fs.rmSync(open.keyFile);
    assert.deepEqual((await getJson(open.url, '/api/state')).locks, { antigravity: 'open' });
  } finally { await open.close(); }

  for (const [name, key] of [['값의 대소문자', '{"antigravity":"OPEN"}'], ['깨진 글', '{ "antigravity": "open"'], ['배열', '[{"antigravity":"open"}]'], ['빈 파일', '']]) {
    const s = await start({ key });
    try { assert.deepEqual((await getJson(s.url, '/api/state')).locks, { antigravity: 'locked' }, name); } finally { await s.close(); }
  }

  // 뜬 뒤에 놓인 열쇠는 이 실행에서 열지 않는다.
  const late = await start();
  try {
    fs.mkdirSync(path.dirname(late.keyFile), { recursive: true });
    fs.writeFileSync(late.keyFile, OPEN_KEY);
    assert.deepEqual((await getJson(late.url, '/api/state')).locks, { antigravity: 'locked' });
  } finally { await late.close(); }
});

// ---------------------------------------------------------------------------
// 받은 antigravity 값은 버린다
// ---------------------------------------------------------------------------
for (const [label, key] of [['잠긴 PC', null], ['열쇠가 열린 PC', OPEN_KEY]]) {
  test(`POST /api/choice (${label}): antigravity 를 끼워 보내도 버린다 — 응답 · 선택 · 주도 에이전트는 그대로`, async () => {
    const s = await start({ key });
    try {
      await post(s.url, '/api/precheck');
      await post(s.url, '/api/locate');

      // Antigravity 만으로는 넘어갈 수 없다(「다음」 조건 = 클로드 · 챗지피티 가운데 하나 이상 — 지금까지의 거절 그대로).
      for (const body of [{ subscriptions: ['antigravity'] }, { subscriptions: [], antigravity: true }, { antigravity: true }, { subscriptions: ['antigravity'], antigravity: 'open' }]) {
        assert.deepEqual(await postJson(s.url, '/api/choice', body), { ok: false, reason: 'empty', message: '구독을 적어도 하나는 골라 주세요.' });
      }
      let st = await getJson(s.url, '/api/state');
      assert.equal(st.step, 'choice');
      assert.equal(st.choice ?? null, null);

      const r = await postJson(s.url, '/api/choice', { subscriptions: ['antigravity', 'chatgpt', 'claude', 'antigravity'], antigravity: true });
      assert.deepEqual(r, { ok: true, leadAgent: 'claude', structure: 'interview' }, '응답은 antigravity 를 보내지 않았을 때와 같다');
      st = await getJson(s.url, '/api/state');
      assert.deepEqual(st.choice, { subscriptions: ['chatgpt', 'claude'], leadAgent: 'claude' }, 'subscriptions 에 셋째 값이 없다 · 다른 칸도 없다');
      assert.equal(st.step, 'summary');
      assert.doesNotMatch(fs.readFileSync(s.stateFile, 'utf8'), /antigravity/i);
      assert.match(allLogs(s), /choice: antigravity dropped/, '버린 것을 기록에 한 줄 남긴다');
      if (key != null) assert.equal(fs.readFileSync(s.keyFile, 'utf8'), key, '열쇠 파일은 그대로다');
    } finally { await s.close(); }
  });

  test(`POST /api/online/choice (${label}): antigravity 를 끼워 보내도 버린다 — 로그인 상자는 클로드 · 챗지피티 둘뿐`, async () => {
    const s = await start({ key, runner: { loginStatus: async () => ({ state: 'waiting', cli: 'pending', relay: 'pending', reason: null }) } });
    try {
      await post(s.url, '/api/precheck');
      await post(s.url, '/api/locate');
      await post(s.url, '/api/choice', { subscriptions: ['claude', 'chatgpt'] });
      await post(s.url, '/api/online/start');
      await waitFor(s.url, '/api/online/status', (b) => b.stage === 'login', '로그인 국면');

      for (const body of [{ subscriptions: ['antigravity'] }, { subscriptions: [], antigravity: true }, { antigravity: true }]) {
        assert.deepEqual(await postJson(s.url, '/api/online/choice', body),
          { ok: false, reason: 'empty', message: '구독을 적어도 하나는 남겨 주세요. 비서는 유료 구독 하나가 있어야 일합니다.' });
      }
      let st = await getJson(s.url, '/api/online/status');
      assert.deepEqual(Object.keys(st.logins).sort(), ['chatgpt', 'claude']);
      assert.equal(st.logins.claude.state, 'waiting');
      assert.equal(st.logins.chatgpt.state, 'waiting');

      const r = await postJson(s.url, '/api/online/choice', { subscriptions: ['chatgpt', 'antigravity'], antigravity: true });
      assert.deepEqual(r, { ok: true, subscriptions: ['chatgpt'], leadAgent: 'chatgpt', restarted: false });
      st = await getJson(s.url, '/api/online/status');
      assert.deepEqual(Object.keys(st.logins).sort(), ['chatgpt', 'claude'], '셋째 로그인 상자가 생기지 않는다');
      assert.equal(st.logins.claude.state, 'not-needed');
      assert.equal(st.logins.chatgpt.state, 'waiting');
      assert.deepEqual((await getJson(s.url, '/api/state')).choice, { subscriptions: ['chatgpt'], leadAgent: 'chatgpt' });
      assert.match(allLogs(s), /online choice: antigravity dropped/);

      // 로그인 길은 지금까지처럼 모르는 구독을 거절한다(일꾼을 부르지 않는다).
      const before = s.calls.startLogin.length;
      for (const p of ['/api/online/login', '/api/online/login/retry']) {
        assert.deepEqual(await postJson(s.url, p, { provider: 'antigravity' }), { ok: false, reason: 'bad_provider', message: '알 수 없는 구독입니다.' });
      }
      assert.equal(s.calls.startLogin.length, before);
      assert.ok(!s.calls.loginStatus.includes('antigravity'), '상태 되묻기도 antigravity 를 묻지 않는다');
    } finally { await s.close(); }
  });
}

// ---------------------------------------------------------------------------
// 클로드만 / 코덱스만 / 둘 다 — 끝까지 간 흐름이 antigravity 를 끼워 보낸 흐름과 같다
// ---------------------------------------------------------------------------
/** 실행마다 달라지는 것(폴더 · 시각)을 같은 표식으로 바꾼다. */
function normalize(value, root) {
  const rootFwd = root.split(path.sep).join('/');
  const walk = (v) => {
    if (typeof v === 'string') {
      let s = v.split(root).join('<ROOT>').split(rootFwd).join('<ROOT>');
      s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<T>');
      return s;
    }
    if (typeof v === 'number') return v > 1e12 ? '<T>' : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}
/** 새 설치를 끝까지: 고르기 → 설치 → 로그인 → (로그인 단계에서 다시 고르기) → 계정 연결 → 완료. junk = antigravity 를 끼워 보낸다. */
async function fullRun(subs, { junk, key = null }) {
  const s = await start({ key });
  try {
    const withJunk = (body) => (junk ? { ...body, subscriptions: ['antigravity', ...body.subscriptions], antigravity: true } : body);
    await post(s.url, '/api/precheck');
    await post(s.url, '/api/locate');
    const choice = await postJson(s.url, '/api/choice', withJunk({ subscriptions: subs }));
    await post(s.url, '/api/structure', { nodes: TREE });
    await post(s.url, '/api/summary/confirm');
    await post(s.url, '/api/setup/start');
    await waitFor(s.url, '/api/setup/progress', (b) => b.percent === 100, '설치 100%');
    await post(s.url, '/api/online/start');
    await waitFor(s.url, '/api/online/status', (b) => b.stage === 'login' || b.stage === 'relay', '로그인 국면');
    for (const p of subs) await post(s.url, '/api/online/login', { provider: p });
    await waitFor(s.url, '/api/online/status', (b) => subs.every((p) => b.logins[p]?.state === 'done'), '로그인 끝');
    const again = await postJson(s.url, '/api/online/choice', withJunk({ subscriptions: subs }));
    const status = await getJson(s.url, '/api/online/status');
    const relay = await postJson(s.url, '/api/online/relay');
    const state = await waitFor(s.url, '/api/state', (b) => b.step === 'done', '완료');
    const report = await getJson(s.url, '/api/report');
    const n = (v) => normalize(v, s.soulRoot);
    const { now: _now, ...statusRest } = status;
    return {
      choice, again, relay,
      status: n(statusRest),
      state: n(state),
      saved: n(readJson(s.stateFile)),
      receipt: fs.existsSync(receiptFile(s.soulRoot)) ? n(readJson(receiptFile(s.soulRoot))) : null,
      handoff: fs.existsSync(handoffFile(s.soulRoot)) ? n(readJson(handoffFile(s.soulRoot))) : null,
      report: n(report),
      calls: s.calls,
      keyBytes: key != null ? fs.readFileSync(s.keyFile, 'utf8') : null,
      keyExists: fs.existsSync(s.keyFile),
    };
  } finally { await s.close(); }
}

for (const subs of [['claude'], ['chatgpt'], ['claude', 'chatgpt']]) {
  test(`끝까지 간 새 설치(${subs.join(' + ')}): antigravity 를 끼워 보낸 흐름과 상태 · 영수증 · 인수 문서 · 완료 보고가 같다`, async () => {
    const clean = await fullRun(subs, { junk: false });
    const junk = await fullRun(subs, { junk: true });
    const lead = subs.includes('claude') ? 'claude' : 'chatgpt';

    // 깨끗한 흐름 자체가 지금까지의 모양이다(고른 것 · 주도 에이전트 · 로그인 상자 · 일꾼을 부른 횟수).
    assert.deepEqual(clean.choice, { ok: true, leadAgent: lead, structure: 'interview' });
    assert.deepEqual(clean.again, { ok: true, subscriptions: subs, leadAgent: lead, restarted: false });
    assert.deepEqual(clean.state.choice, { subscriptions: subs, leadAgent: lead });
    assert.deepEqual(Object.keys(clean.state.online.logins).sort(), ['chatgpt', 'claude']);
    for (const p of ['claude', 'chatgpt']) assert.equal(clean.state.online.logins[p].state, subs.includes(p) ? 'done' : 'not-needed', p);
    assert.equal(clean.state.online.relay.state, 'done');
    assert.deepEqual(clean.calls.startLogin, subs);
    assert.equal(clean.calls.startRelay, 1);
    assert.equal(clean.calls.installClaude, 1);
    assert.ok(clean.receipt, '영수증이 있다');
    assert.ok(clean.handoff, '인수 문서가 있다');
    assert.deepEqual(clean.receipt.choice, { subscriptions: subs, leadAgent: lead });
    assert.deepEqual(clean.handoff.subscriptions, subs);
    assert.equal(clean.handoff.leadAgent, lead === 'chatgpt' ? 'codex' : lead, '인수 문서는 에이전트 이름으로 적는다(2.0.25 그대로)');
    assert.equal(clean.handoff.state, 'ready');
    assert.deepEqual(clean.handoff.login, { claude: subs.includes('claude') ? 'done' : 'not-needed', chatgpt: subs.includes('chatgpt') ? 'done' : 'not-needed' });
    assert.deepEqual(Object.keys(clean.handoff.login).sort(), ['chatgpt', 'claude'], '인수 문서의 로그인 칸은 둘뿐');

    // antigravity 를 끼워 보낸 흐름은 그것과 글자까지 같다.
    for (const part of ['choice', 'again', 'relay', 'status', 'state', 'saved', 'receipt', 'handoff', 'report']) {
      assert.deepEqual(junk[part], clean[part], `${part} 이 달라졌다`);
    }
    assert.deepEqual(junk.calls, clean.calls, '일꾼을 부른 차례 · 횟수도 같다');

    // 잠금 · antigravity 는 응답의 locks 칸 말고는 어디에도 없다.
    assert.deepEqual(junk.state.locks, { antigravity: 'locked' });
    const { locks: _locks, ...stateRest } = junk.state;
    for (const [name, v] of [['상태 응답(locks 제외)', stateRest], ['상태 파일', junk.saved], ['영수증', junk.receipt], ['인수 문서', junk.handoff], ['완료 보고', junk.report], ['온라인 상태', junk.status]]) {
      assert.doesNotMatch(JSON.stringify(v), /antigravity|locks/i, name);
    }
    assert.equal(junk.keyExists, false, '설치기는 열쇠 파일을 만들지 않는다');
  });
}

test('열쇠가 열린 PC 의 새 설치(둘 다): 응답의 locks 만 다르고 상태 · 영수증 · 인수 문서는 잠긴 PC 와 같다 — 열쇠 파일은 그대로', async () => {
  const subs = ['claude', 'chatgpt'];
  const locked = await fullRun(subs, { junk: true });
  const open = await fullRun(subs, { junk: true, key: OPEN_KEY });
  assert.deepEqual(open.state.locks, { antigravity: 'open' });
  assert.equal(open.keyBytes, OPEN_KEY, '설치기는 열쇠 파일을 고치지 않는다');
  const strip = (r) => { const { locks: _l, ...rest } = r.state; return rest; };
  assert.deepEqual(strip(open), strip(locked), '상태(locks 제외)');
  for (const part of ['choice', 'again', 'relay', 'status', 'saved', 'receipt', 'handoff', 'report']) assert.deepEqual(open[part], locked[part], part);
  assert.deepEqual(open.calls, locked.calls);
});

// ---------------------------------------------------------------------------
// 잠금을 보는 코드는 한 곳만 부른다
// ---------------------------------------------------------------------------
test('server.mjs: 열쇠 파일을 스스로 읽지 않는다 — 잠금 판정은 agylock.mjs 한 곳', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'installer', 'server.mjs'), 'utf8');
  assert.match(src, /import \{ agyLock \} from '\.\/lib\/agylock\.mjs'/);
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /iris-keys/, '열쇠 파일 이름을 들고 있지 않다(읽는 곳은 agylock.mjs 뿐)');
  assert.equal((code.match(/agyLock\(/g) || []).length, 1, '판정은 서버가 뜰 때 한 번');
});
