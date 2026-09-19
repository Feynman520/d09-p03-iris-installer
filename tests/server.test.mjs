import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startServer } from '../installer/server.mjs';
import { SETUP_STAGE_IDS, readReceipt, writeReceipt } from '../installer/lib/receipt.mjs';
import { readDecisions } from '../installer/lib/structure-rules.mjs';
import { createSetupRunner } from '../installer/lib/adapters/setup-runner.mjs';

// v2 서버 계약 시험 (정본 = docs/설치기-API-v2.md).
//
// 진짜 C:\ 아래는 읽지도 쓰지도 않는다 — 모든 서버는 `soulRoot` 시험 이음매로
// 임시 폴더를 영혼 루트 삼고, 세팅 엔진·온라인 묶음은 가짜를 주입한다.

// Sends a raw HTTP request with `rawPath` used verbatim as the request-target
// so the test exercises exactly what server.mjs's URL parsing sees on the wire
// (fetch()/WHATWG URL would collapse ".." and "\" before it ever left).
function rawRequest(port, rawPath, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-server-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const zipRoot = path.join(tmp, 'zip-root');
fs.mkdirSync(path.join(zipRoot, 'payload'), { recursive: true });
fs.writeFileSync(path.join(zipRoot, 'payload', 'manifest.json'),
  JSON.stringify({ schema: 1, package: { name: 'IRIS', version: '2.0.0' }, parts: {} }), 'utf8');
fs.writeFileSync(path.join(zipRoot, 'lock.json'),
  JSON.stringify({ schema: 1, package: { version: '2.0.0' }, parts: {} }), 'utf8');
const nodeDir = path.dirname(process.execPath);

const OK_PRECHECK = { blockers: [], warnings: [], info: {}, recorded: { os: { ok: true, build: 26200 } } };
const BLOCKED_PRECHECK = {
  blockers: [{ id: 'disk', message: 'C 드라이브 여유 공간이 3GB 미만입니다.' }],
  warnings: [], info: {}, recorded: {},
};

const JSON_HDR = { 'Content-Type': 'application/json' };
const post = (url, p, body) => fetch(`${url}${p}`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify(body ?? {}) });
const getJson = async (url, p) => (await fetch(`${url}${p}`)).json();

const okEngine = (extra = {}) => ({
  async runSetup(ctx, { onStage }) {
    for (const id of SETUP_STAGE_IDS) onStage({ id, status: 'done' });
    return { ok: true, pending: [], ...extra };
  },
});

const okOnline = () => ({
  checkNet: async () => ({ ok: true, blocked: [] }),
  installClaude: async () => ({ ok: true, source: 'claude.ai' }),
  installDocumentSkills: async () => ({ ok: true, state: 'done', commit: 'deadbee' }),
  startLogin: async () => ({ ok: true, state: 'waiting', cli: 'pending', relay: 'pending' }),
  loginStatus: async () => ({ state: 'done', cli: 'done', relay: 'done', reason: null }),
  startRelay: async () => ({ ok: true, state: 'done', accounts: 1 }),
});

let seq = 0;
async function start(opts = {}) {
  const id = `s${++seq}`;
  const soulRoot = path.join(tmp, 'souls', id);
  const server = await startServer({
    port: 0,
    zipRoot,
    nodeDir,
    stateFile: path.join(tmp, `state-${id}.json`),
    soulRoot,
    workDir: path.join(tmp, 'logs', id),
    precheckFn: async () => OK_PRECHECK,
    setupRunner: okEngine(),
    onlineRunner: okOnline(),
    // 실제 중계기·구글 폼에 닿지 않게(2026-09-19 신설 두 이음새)
    relayRecheckFn: async () => ({ at: '2026-09-19T00:00:00.000Z', items: [] }),
    reportFetchFn: async () => ({ status: 200 }),
    ...opts,
  });
  return { ...server, soulRoot };
}

// 질문 세 개를 통과시켜 ④(작업 폴더 구성) 앞까지 온다.
async function answerQuestions(url, subscriptions = ['claude']) {
  await post(url, '/api/precheck');
  await post(url, '/api/locate');
  await post(url, '/api/choice', { subscriptions });
}

const TREE = [
  { id: 'r1', parentId: null, level: 'R', nameKo: '교사', nameEn: 'Teacher', order: 1 },
  { id: 'd1', parentId: 'r1', level: 'D', nameKo: '수업', nameEn: 'Teaching', order: 1 },
  { id: 'd2', parentId: 'r1', level: 'D', nameKo: '담임', nameEn: '', order: 2 },
  { id: 'p1', parentId: 'd1', level: 'P', nameKo: '이번 학기 준비', nameEn: 'Semester Prep', order: 1 },
];

async function waitForProgress(url, pred, what) {
  for (let i = 0; i < 300; i++) {
    const body = await getJson(url, '/api/setup/progress');
    if (pred(body)) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`setup never reached: ${what}`);
}

async function waitForOnline(url, pred, what) {
  for (let i = 0; i < 300; i++) {
    const body = await getJson(url, '/api/online/status');
    if (pred(body)) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`online never reached: ${what}`);
}

// ---------------------------------------------------------------------------
// ① health / quit
// ---------------------------------------------------------------------------
test('health 200 with name:iris-installer; POST /api/quit closes the server', async () => {
  let closedByQuit = false;
  let handle;
  handle = await start({ onQuit: () => { closedByQuit = true; handle.close(); } });

  const health = await getJson(handle.url, '/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.name, 'iris-installer');
  assert.equal(health.step, 'precheck');
  assert.equal(health.version, '2.0.0');
  assert.equal(health.auto, false);

  const quit = await post(handle.url, '/api/quit');
  assert.equal(quit.status, 200);
  assert.deepEqual(await quit.json(), { ok: true });

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(closedByQuit, true, 'onQuit hook was not invoked');
  await assert.rejects(fetch(`${handle.url}/api/health`), 'server should have stopped listening');
});

// ---------------------------------------------------------------------------
// ② 정상 전이 전체
// ---------------------------------------------------------------------------
test('happy path: precheck → locate → choice → structure → summary → setup → online → done', async () => {
  const engineCtx = [];
  const onlineCalls = [];
  const s = await start({
    setupRunner: {
      async runSetup(ctx, { onStage }) {
        engineCtx.push(ctx);
        onStage({ id: 'unpack', status: 'running' });
        onStage({ id: 'unpack', sub: { part: 'node', done: 3, total: 11 } });
        for (const id of SETUP_STAGE_IDS) onStage({ id, status: 'done' });
        return { ok: true, pending: [{ capability: '브라우저 조작', reason: 'Edge 없음' }] };
      },
    },
    onlineRunner: {
      checkNet: async (a) => { onlineCalls.push(['checkNet', a]); return { ok: true, blocked: [] }; },
      installClaude: async (a) => { onlineCalls.push(['installClaude', a]); return { ok: true, source: 'claude.ai' }; },
      installDocumentSkills: async (a) => { onlineCalls.push(['installDocumentSkills', a]); return { ok: true, state: 'done', commit: 'deadbee' }; },
      startLogin: async (a) => { onlineCalls.push(['startLogin', a]); return { ok: true, state: 'waiting' }; },
      loginStatus: async (a) => { onlineCalls.push(['loginStatus', a]); return { state: 'done', cli: 'done', relay: 'done' }; },
      startRelay: async (a) => { onlineCalls.push(['startRelay', a]); return { ok: true, state: 'done', accounts: 2 }; },
    },
  });
  const { url, soulRoot } = s;
  try {
    // ① 준비 확인
    const pre = await (await post(url, '/api/precheck')).json();
    assert.equal(pre.ok, true);
    assert.equal(pre.canProceed, true);
    assert.deepEqual(pre.result.blockers, []);
    assert.equal((await getJson(url, '/api/state')).step, 'locate');

    // ② 설치 위치
    const loc = await (await post(url, '/api/locate')).json();
    assert.equal(loc.ok, true);
    assert.equal(loc.mode, 'empty');
    assert.equal(loc.root, soulRoot);
    assert.ok(loc.message.length > 0);
    assert.equal((await getJson(url, '/api/state')).step, 'choice');

    // ③ 구독 -- 옛 guideEdition 은 폐지
    const choice = await (await post(url, '/api/choice', { subscriptions: ['claude', 'chatgpt'] })).json();
    assert.deepEqual(choice, { ok: true, leadAgent: 'claude' });
    const afterChoice = await getJson(url, '/api/state');
    assert.deepEqual(afterChoice.choice, { subscriptions: ['claude', 'chatgpt'], leadAgent: 'claude' });
    assert.ok(!('guideEdition' in afterChoice.choice), 'guideEdition 은 v2 에 없다');
    assert.equal(afterChoice.step, 'structure');

    // ④ 작업 폴더 구성 -- 서버가 번호를 매기고 decisions.json 을 원자 저장한다
    const st = await (await post(url, '/api/structure', { nodes: TREE, later: false })).json();
    assert.equal(st.ok, true);
    const byId = Object.fromEntries(st.decisions.nodes.map((n) => [n.id, n]));
    assert.equal(byId.r1.folderName, 'R01-교사(Teacher)');
    assert.equal(byId.d1.folderName, 'D01-수업(Teaching)');
    assert.equal(byId.d2.folderName, 'D02-담임', '영어 칸은 비워도 된다');
    assert.equal(byId.p1.folderName, 'P01-이번 학기 준비(Semester Prep)');
    assert.deepEqual(st.decisions.deferred, ['S', 'T', 'tags']);
    assert.deepEqual(st.decisions.nameEnMissing, ['D02-담임']);
    assert.deepEqual(readDecisions(soulRoot), st.decisions, 'decisions.json 이 영혼 폴더에 저장됐다');
    assert.equal((await getJson(url, '/api/state')).step, 'summary');

    // ⑤ 요약 확인 -- 영수증 schema 2 가 이때 만들어진다
    assert.deepEqual(await (await post(url, '/api/summary/confirm')).json(), { ok: true });
    const receipt = readReceipt(soulRoot);
    assert.equal(receipt.schema, 2);
    assert.deepEqual(receipt.precheck.recorded, OK_PRECHECK.recorded);
    assert.deepEqual(receipt.choice, { subscriptions: ['claude', 'chatgpt'], leadAgent: 'claude' });
    assert.equal(receipt.decisionsPath, path.join(soulRoot, '_agent', 'setup', 'decisions.json'));
    assert.deepEqual(receipt.setup, {});
    assert.deepEqual(receipt.online, {});
    assert.equal(receipt.steps.summary, 'done');
    assert.equal((await getJson(url, '/api/state')).step, 'setup');

    // ⑥ 세팅 엔진
    const started = await post(url, '/api/setup/start');
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { ok: true, running: true });
    const setupDone = await waitForProgress(url, (b) => b.percent === 100, '100%');
    assert.equal(setupDone.error, null);
    assert.deepEqual(setupDone.stages.map((x) => x.id), SETUP_STAGE_IDS);
    assert.ok(setupDone.stages.every((x) => x.status === 'done'));
    assert.deepEqual(setupDone.pending, [{ capability: '브라우저 조작', reason: 'Edge 없음' }]);
    assert.equal((await getJson(url, '/api/state')).step, 'online');

    // 엔진에 넘긴 ctx 가 계약대로다
    assert.equal(engineCtx.length, 1);
    assert.equal(engineCtx[0].root, soulRoot);
    assert.equal(engineCtx[0].offline, true);
    assert.equal(engineCtx[0].payloadDir, path.join(zipRoot, 'payload'));
    assert.equal(engineCtx[0].toolsDir, path.join(soulRoot, '_agent', 'shared', 'tools'));
    assert.deepEqual(engineCtx[0].decisions, st.decisions);
    assert.deepEqual(engineCtx[0].choice, { subscriptions: ['claude', 'chatgpt'], leadAgent: 'claude' });
    assert.deepEqual(engineCtx[0].precheck, OK_PRECHECK.recorded);
    assert.equal(typeof engineCtx[0].log, 'function');
    assert.equal(typeof engineCtx[0].run, 'function');

    // ⑦ 온라인
    await post(url, '/api/online/start');
    // 인터넷 확인 → Claude 내려받기 가 끝나면 로그인 국면으로 넘어간다. 폴링이
    // 곧바로 로그인까지 done 으로 만들 수 있으므로 두 국면을 함께 기다린다.
    await waitForOnline(url, (b) => b.stage === 'login' || b.stage === 'relay', 'the login phase');
    const afterNet = await getJson(url, '/api/online/status');
    assert.equal(afterNet.net.ok, true);
    assert.equal(afterNet.claude.state, 'done');
    assert.equal(afterNet.claude.source, 'claude.ai');

    for (const provider of ['claude', 'chatgpt']) {
      const login = await (await post(url, '/api/online/login', { provider })).json();
      assert.equal(login.ok, true, provider);
    }
    const logins = await getJson(url, '/api/online/status');
    assert.equal(logins.logins.claude.state, 'done');
    assert.equal(logins.logins.chatgpt.state, 'done');

    const relay = await (await post(url, '/api/online/relay')).json();
    assert.deepEqual(relay, { ok: true, accounts: 2 });

    // ⑧ 완료
    assert.equal((await getJson(url, '/api/state')).step, 'done');
    assert.equal(readReceipt(soulRoot).steps.online, 'done');
    assert.ok(onlineCalls.some(([n]) => n === 'startRelay'));

    // 완료 보고 -- 엔진이 아직 파일을 쓰지 않았으므로 내용은 null 이지만
    // 라우트는 대기 기능 목록을 돌려준다.
    const report = await getJson(url, '/api/report');
    assert.equal(report.ok, true);
    assert.equal(report.markdown, null);
    assert.equal(report.handoff, null);
    assert.deepEqual(report.pendingCapabilities, [{ capability: '브라우저 조작', reason: 'Edge 없음' }]);
  } finally {
    await s.close();
  }
});

test('「나중에 비서와 정하기」는 R01-나(Me) 하나만 만들고 D·P 까지 미룬다', async () => {
  const s = await start();
  try {
    await answerQuestions(s.url);
    const st = await (await post(s.url, '/api/structure', { nodes: [], later: true })).json();
    assert.equal(st.ok, true);
    assert.equal(st.decisions.nodes.length, 1);
    assert.equal(st.decisions.nodes[0].folderName, 'R01-나(Me)');
    assert.deepEqual(st.decisions.deferred, ['D', 'P', 'S', 'T', 'tags']);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ③ 검증 오류 6종
// ---------------------------------------------------------------------------
test('POST /api/structure: 검증 오류 6종 (R 없음·부모 없음·중복·금지 문자·자리표시자·잘못된 영어)', async () => {
  const s = await start();
  try {
    await answerQuestions(s.url);
    const codes = async (nodes) => {
      const r = await (await post(s.url, '/api/structure', { nodes })).json();
      assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(nodes)}`);
      for (const e of r.errors) {
        assert.ok(/[가-힣]/.test(e.message), `오류 문구는 한국어 한 문장이어야 한다: ${e.message}`);
      }
      return r.errors.map((e) => e.code);
    };
    const R = { id: 'r1', parentId: null, level: 'R', nameKo: '교사', nameEn: 'Teacher', order: 1 };

    assert.ok((await codes([{ id: 'd1', parentId: null, level: 'D', nameKo: '수업', nameEn: '', order: 1 }])).includes('no-root'));
    assert.ok((await codes([R, { id: 'd1', parentId: 'ghost', level: 'D', nameKo: '수업', nameEn: '', order: 1 }])).includes('orphan'));
    assert.ok((await codes([R, { ...R, id: 'r2', order: 2 }])).includes('duplicate'));
    assert.ok((await codes([{ ...R, nameKo: '교사/부장' }])).includes('bad-char'));
    assert.ok((await codes([{ ...R, nameKo: '기타' }])).includes('placeholder'));
    assert.ok((await codes([{ ...R, nameEn: '교사!!' }])).includes('bad-name-en'));

    // 거절된 제출은 아무것도 저장하지 않는다
    assert.equal(readDecisions(s.soulRoot), null);
    assert.equal((await getJson(s.url, '/api/state')).step, 'structure');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ④ 순서 가드
// ---------------------------------------------------------------------------
test('순서 가드: 구독·구성 없이 요약을 확정할 수 없다', async () => {
  const s = await start();
  try {
    await post(s.url, '/api/precheck');
    await post(s.url, '/api/locate');
    const noChoice = await post(s.url, '/api/summary/confirm');
    assert.equal(noChoice.status, 409);
    assert.equal((await noChoice.json()).reason, 'no_choice');

    await post(s.url, '/api/choice', { subscriptions: ['chatgpt'] });
    const noDecisions = await post(s.url, '/api/summary/confirm');
    assert.equal(noDecisions.status, 409);
    assert.equal((await noDecisions.json()).reason, 'no_decisions');

    // ChatGPT 만 고르면 주도 에이전트는 codex 쪽이다
    assert.deepEqual((await getJson(s.url, '/api/state')).choice, { subscriptions: ['chatgpt'], leadAgent: 'chatgpt' });
  } finally {
    await s.close();
  }
});

// 고치기 1회차 ①: 쓰는 라우트는 위치 확인을 건너뛸 수 없다.
test('순서 가드: locate 없이 structure·summary·setup 은 409 no_locate 이고 아무것도 쓰지 않는다', async () => {
  let engineRan = 0;
  const s = await start({ setupRunner: { runSetup: async () => { engineRan += 1; return { ok: true, pending: [] }; } } });
  try {
    await post(s.url, '/api/precheck'); // locate 는 일부러 건너뛴다

    for (const [p, body] of [
      ['/api/structure', { nodes: TREE }],
      ['/api/summary/confirm', {}],
      ['/api/setup/start', {}],
      ['/api/setup/retry', {}],
    ]) {
      const r = await post(s.url, p, body);
      assert.equal(r.status, 409, p);
      const j = await r.json();
      assert.equal(j.reason, 'no_locate', p);
      assert.match(j.message, /설치 위치 확인/);
    }
    assert.equal(readDecisions(s.soulRoot), null, 'decisions.json 이 만들어지면 안 된다');
    assert.equal(readReceipt(s.soulRoot), null, '영수증이 만들어지면 안 된다');
    assert.equal(engineRan, 0, '엔진이 돌면 안 된다');
    assert.equal(fs.existsSync(s.soulRoot), false, '영혼 폴더 자체가 생기면 안 된다');
  } finally {
    await s.close();
  }
});

// 고치기 1회차 ①: 한 번 거절당한 폴더는 계속 거절당한다(확인이 취소된다).
test('순서 가드: foreign 판정 뒤에는 setup/start·structure 가 409 no_locate', async () => {
  const soulRoot = path.join(tmp, 'foreign-guard');
  fs.mkdirSync(soulRoot, { recursive: true });
  fs.writeFileSync(path.join(soulRoot, '가족사진.jpg'), 'x', 'utf8');
  let engineRan = 0;
  const s = await start({
    soulRoot,
    setupRunner: { runSetup: async () => { engineRan += 1; return { ok: true, pending: [] }; } },
  });
  try {
    await post(s.url, '/api/precheck');
    const loc = await (await post(s.url, '/api/locate')).json();
    assert.equal(loc.ok, false);
    assert.equal(loc.mode, 'foreign');

    for (const p of ['/api/structure', '/api/setup/start']) {
      const r = await post(s.url, p, { nodes: TREE });
      assert.equal(r.status, 409, p);
      assert.equal((await r.json()).reason, 'no_locate', p);
    }
    assert.equal(engineRan, 0);
    assert.equal(readDecisions(soulRoot), null, '남의 폴더에 답안을 쓰면 안 된다');
    assert.deepEqual(fs.readdirSync(soulRoot), ['가족사진.jpg'], '남의 폴더는 그대로여야 한다');
  } finally {
    await s.close();
  }
});

// 최종 검토 C3: ⑦ 온라인 묶음과 「IRIS 열기」도 같은 가드 뒤에 있다.
// 둘 다 영혼 폴더에 쓴다(claude.exe·설정·영수증·실행기) — 위치 확인을 건너뛴
// 채로는 한 바이트도 쓰지 않는다.
test('순서 가드: foreign 판정 뒤에는 online/start·login·relay·open-face 가 409 no_locate', async () => {
  const soulRoot = path.join(tmp, 'foreign-guard-online');
  fs.mkdirSync(soulRoot, { recursive: true });
  fs.writeFileSync(path.join(soulRoot, '연말정산.pdf'), 'x', 'utf8');
  const touched = [];
  const s = await start({
    soulRoot,
    onlineRunner: {
      checkNet: async () => { touched.push('checkNet'); return { ok: true, blocked: [] }; },
      installClaude: async () => { touched.push('installClaude'); return { ok: true }; },
      installDocumentSkills: async () => { touched.push('installDocumentSkills'); return { ok: true, state: 'done' }; },
      startLogin: async () => { touched.push('startLogin'); return { ok: true, state: 'waiting' }; },
      loginStatus: async () => ({ state: 'waiting' }),
      startRelay: async () => { touched.push('startRelay'); return { ok: true, state: 'done', accounts: 1 }; },
    },
    openFaceFn: async () => { touched.push('openFace'); return { ok: true, pid: 1 }; },
  });
  try {
    await post(s.url, '/api/precheck');
    assert.equal((await (await post(s.url, '/api/locate')).json()).mode, 'foreign');

    const calls = [
      ['/api/online/start', {}],
      ['/api/online/login', { provider: 'claude' }],
      ['/api/online/login/retry', { provider: 'claude' }],
      ['/api/online/relay', {}],
      ['/api/open-face', {}],
    ];
    for (const [p, body] of calls) {
      const r = await post(s.url, p, body);
      assert.equal(r.status, 409, p);
      assert.equal((await r.json()).reason, 'no_locate', p);
    }
    assert.deepEqual(touched, [], '거절된 폴더에 대고 온라인 묶음이 한 번도 돌면 안 된다');
    assert.deepEqual(fs.readdirSync(soulRoot), ['연말정산.pdf'], '남의 폴더는 그대로여야 한다');
  } finally {
    await s.close();
  }
});

// 고치기 1회차 ③: 1.x 영수증은 덮어쓰기 전에 옆에 사본을 남긴다 (S09).
test('summary/confirm: 1.x 영수증은 package-receipt.v1.json 으로 보존한 뒤 v2 로 바꾼다', async () => {
  const soulRoot = path.join(tmp, 'legacy-soul');
  const legacy = {
    schema: 1,
    package: { name: 'IRIS', version: '1.4.5', guideVersion: '14' },
    soul: { name: 'IRIS', createdBy: 'package-installer' },
    installed: { face: { version: '2.65.0', verified: true } },
    login: { claude: { cli: true, relay: true } },
    steps: { copy: 'done', login: 'done', handoff: 'done' },
  };
  fs.mkdirSync(path.join(soulRoot, '_agent', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(soulRoot, '_agent', 'setup', 'package-receipt.json'), JSON.stringify(legacy), 'utf8');
  const backupPath = path.join(soulRoot, '_agent', 'setup', 'package-receipt.v1.json');

  const s = await start({ soulRoot });
  try {
    await post(s.url, '/api/precheck');
    const loc = await (await post(s.url, '/api/locate')).json();
    assert.equal(loc.mode, 'iris-legacy', '1.x 영수증이 있는 폴더는 이어 설치 대상');
    await post(s.url, '/api/choice', { subscriptions: ['claude'] });
    await post(s.url, '/api/structure', { nodes: TREE });
    assert.deepEqual(await (await post(s.url, '/api/summary/confirm')).json(), { ok: true });

    // 사본이 원본 그대로 남았다
    assert.ok(fs.existsSync(backupPath), '1.x 영수증 사본이 없다');
    assert.deepEqual(JSON.parse(fs.readFileSync(backupPath, 'utf8')), legacy);
    assert.ok(!fs.existsSync(`${backupPath}.tmp`), '원자 저장이라 .tmp 가 남으면 안 된다');
    // 자리의 영수증은 v2 로 바뀌었다
    assert.equal(readReceipt(soulRoot).schema, 2);
  } finally {
    await s.close();
  }

  // 두 번째 실행이 (이미 v2 가 된) 영수증으로 사본을 덮어쓰지 않는다
  const s2 = await start({ soulRoot });
  try {
    await post(s2.url, '/api/precheck');
    await post(s2.url, '/api/locate');
    await post(s2.url, '/api/choice', { subscriptions: ['claude'] });
    await post(s2.url, '/api/structure', { nodes: TREE });
    await post(s2.url, '/api/summary/confirm');
    assert.deepEqual(JSON.parse(fs.readFileSync(backupPath, 'utf8')), legacy, '사본은 첫 번째 것이 그대로여야 한다');
  } finally {
    await s2.close();
  }
});

test('precheck: 막는 항목이 하나라도 있으면 canProceed=false 이고 단계가 넘어가지 않는다', async () => {
  const s = await start({ precheckFn: async () => BLOCKED_PRECHECK });
  try {
    const body = await (await post(s.url, '/api/precheck')).json();
    assert.equal(body.ok, true);
    assert.equal(body.canProceed, false);
    assert.equal(body.result.blockers.length, 1);
    assert.equal((await getJson(s.url, '/api/state')).step, 'precheck');
  } finally {
    await s.close();
  }
});

test('locate: 남의 자료가 있으면 ok:false 로 막고 단계를 넘기지 않는다', async () => {
  const soulRoot = path.join(tmp, 'foreign-soul');
  fs.mkdirSync(soulRoot, { recursive: true });
  fs.writeFileSync(path.join(soulRoot, '세금계산서.xlsx'), 'x', 'utf8');
  const s = await start({ soulRoot });
  try {
    await post(s.url, '/api/precheck');
    const loc = await (await post(s.url, '/api/locate')).json();
    assert.equal(loc.ok, false);
    assert.equal(loc.mode, 'foreign');
    assert.match(loc.message, /IRIS가 아닌 자료/);
    assert.equal((await getJson(s.url, '/api/state')).step, 'locate');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑤ setup 진행 · 실패 · 재시도 · 미구현
// ---------------------------------------------------------------------------
async function atSetupStep(opts = {}) {
  const s = await start(opts);
  await answerQuestions(s.url);
  await post(s.url, '/api/structure', { nodes: TREE });
  await post(s.url, '/api/summary/confirm');
  return s;
}

test('setup: 하위 진행(부품별)이 폴링으로 보이고, 이미 돌고 있으면 202 {running:true}', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await atSetupStep({
    setupRunner: {
      async runSetup(ctx, { onStage }) {
        onStage({ id: 'unpack', status: 'running' });
        onStage({ id: 'unpack', sub: { part: 'node', done: 3, total: 11 } });
        await gate;
        for (const id of SETUP_STAGE_IDS) onStage({ id, status: 'done' });
        return { ok: true, pending: [] };
      },
    },
  });
  try {
    await post(s.url, '/api/setup/start');
    const mid = await waitForProgress(s.url, (b) => b.stages[0].sub, 'unpack sub progress');
    assert.equal(mid.stage, 'unpack');
    assert.deepEqual(mid.stages[0].sub, { part: 'node', done: 3, total: 11 });
    assert.equal(mid.percent, 0, '한 단계도 끝나지 않았으면 0%');
    assert.equal(mid.running, true);

    const again = await post(s.url, '/api/setup/start');
    assert.equal(again.status, 202);
    assert.deepEqual(await again.json(), { ok: true, running: true });

    release();
    const done = await waitForProgress(s.url, (b) => b.percent === 100, '100%');
    assert.equal(done.running, false);
  } finally {
    await s.close();
  }
});

test('setup: 실패는 그 단계에 코드로 남고 「다시 시도」가 다시 돌린다', async () => {
  let attempt = 0;
  const s = await atSetupStep({
    setupRunner: {
      async runSetup(ctx, { onStage }) {
        attempt += 1;
        if (attempt === 1) {
          onStage({ id: 'unpack', status: 'done' });
          onStage({ id: 'env', status: 'running' });
          return { ok: false, failed: { id: 'env', code: 'E-ENV', message: '환경변수를 쓰지 못했습니다.' }, pending: [] };
        }
        for (const id of SETUP_STAGE_IDS) onStage({ id, status: 'done' });
        return { ok: true, pending: [] };
      },
    },
  });
  try {
    await post(s.url, '/api/setup/start');
    const failed = await waitForProgress(s.url, (b) => b.error, 'a failure');
    assert.equal(failed.error.id, 'env');
    assert.equal(failed.error.code, 'E-ENV');
    assert.equal(failed.error.message, '환경변수를 쓰지 못했습니다.');
    assert.equal(failed.stages.find((x) => x.id === 'env').status, 'failed');
    assert.equal(failed.stages.find((x) => x.id === 'unpack').status, 'done', '만든 것은 지우지 않는다');
    assert.equal(failed.percent, Math.floor((1 / 9) * 100));
    assert.equal((await getJson(s.url, '/api/state')).step, 'setup', '실패해도 setup 카드에 머문다');

    const retry = await post(s.url, '/api/setup/retry');
    assert.equal(retry.status, 202);
    await waitForProgress(s.url, (b) => b.percent === 100, '100% after retry');
    assert.equal(attempt, 2);
    assert.equal((await getJson(s.url, '/api/state')).step, 'online');
  } finally {
    await s.close();
  }
});

test('setup: 실패 원문(detail)과 기록 파일 위치가 진행 상태에 실리고, 「처음부터 다시」는 영수증 9단계를 pending 으로 되돌린다', async () => {
  let attempt = 0;
  const s = await atSetupStep({
    setupRunner: {
      async runSetup(ctx, { onStage }) {
        attempt += 1;
        if (attempt === 1) {
          onStage({ id: 'unpack', status: 'running' });
          onStage({ id: 'unpack', status: 'failed', code: 'E-UNPACK', message: '옛 부품 폴더를 옆으로 옮기지 못했습니다.', detail: { slot: 'tools\\node', code: 'EPERM' } });
          return { ok: false, failed: { id: 'unpack', code: 'E-UNPACK', message: '옛 부품 폴더를 옆으로 옮기지 못했습니다.', detail: { slot: 'tools\\node', code: 'EPERM' } }, pending: [] };
        }
        for (const id of SETUP_STAGE_IDS) onStage({ id, status: 'done' });
        return { ok: true, pending: [] };
      },
    },
  });
  try {
    await post(s.url, '/api/setup/start');
    const failed = await waitForProgress(s.url, (b) => b.error, 'a failure');
    assert.equal(failed.error.message, '옛 부품 폴더를 옆으로 옮기지 못했습니다.');
    assert.match(String(failed.error.detail), /EPERM/, '원문이 진행 상태의 error.detail 에 실린다');
    assert.ok(failed.logs && failed.logs.server, '설치기 로그 경로가 진행 상태에 실린다');
    assert.equal(failed.stages.find((x) => x.id === 'unpack').detail, '옛 부품 폴더를 옆으로 옮기지 못했습니다.', '단계 줄에는 사람 문장');

    // 처음부터: 부품 대조표는 옆으로, 영수증 9단계는 pending(resetBy=fresh), 옛 기록은 삭제 안 함.
    const unpackState = path.join(s.soulRoot, '_agent', 'setup', 'unpack-state.json');
    fs.mkdirSync(path.dirname(unpackState), { recursive: true });
    fs.writeFileSync(unpackState, '{"parts":{"node":{"verified":true}}}', 'utf8');
    const fresh = await post(s.url, '/api/setup/fresh');
    assert.equal(fresh.status, 202);
    const done = await waitForProgress(s.url, (b) => b.percent === 100, '100% after fresh');
    assert.equal(done.error, null);
    assert.equal(attempt, 2);
    assert.ok(!fs.existsSync(unpackState), 'unpack-state.json 은 옆으로 옮겨진다');
    assert.ok(fs.readdirSync(path.dirname(unpackState)).some((f) => f.startsWith('unpack-state.json.prev-')), '지우지 않고 .prev-<시각> 으로 남긴다');
    const receipt = readReceipt(s.soulRoot);
    for (const id of SETUP_STAGE_IDS) assert.equal(receipt.setup[id].resetBy, 'fresh', `${id} 는 fresh 로 되돌려졌다`);
  } finally {
    await s.close();
  }
});

test('setup: 붙잡은 IRIS 프로그램 목록이 error.holders 로 실리고, 「닫고 다시 시도」는 그 PID 만 멈춘 뒤 이어간다', async () => {
  // 2026-09-17 실제 사용자 실측(2.0.4): 한도 화면 서버가 teamclaude-dash 를 붙잡아 EBUSY.
  const holders = [{ pid: 4321, name: 'node.exe', exe: null, what: 'teamclaude-dash\\server.mjs' }];
  let attempt = 0;
  const stopCalls = [];
  const s = await atSetupStep({
    holdersFn: {
      list: async () => (stopCalls.length ? [] : holders),
      stop: async (root, hs) => { stopCalls.push(hs.map((h) => h.pid)); return hs.map((h) => ({ pid: h.pid, stopped: true })); },
    },
    setupRunner: {
      async runSetup(ctx, { onStage }) {
        attempt += 1;
        if (attempt === 1) {
          onStage({ id: 'unpack', status: 'running' });
          const message = '설치 폴더의 IRIS 프로그램 1개가 아직 실행 중이라 부품을 바꿀 수 없습니다.';
          onStage({ id: 'unpack', status: 'failed', code: 'E-UNPACK', message, detail: { holders } });
          return { ok: false, failed: { id: 'unpack', code: 'E-UNPACK', message, detail: { holders } }, pending: [] };
        }
        for (const id of SETUP_STAGE_IDS) onStage({ id, status: 'done' });
        return { ok: true, pending: [] };
      },
    },
  });
  try {
    await post(s.url, '/api/setup/start');
    const failed = await waitForProgress(s.url, (b) => b.error, 'a failure');
    assert.deepEqual(failed.error.holders, holders, '붙잡은 프로그램 목록이 화면으로 간다');

    const closed = await post(s.url, '/api/setup/close-holders');
    assert.equal(closed.status, 202);
    const done = await waitForProgress(s.url, (b) => b.percent === 100, '100% after close-holders');
    assert.equal(done.error, null);
    assert.deepEqual(stopCalls, [[4321]], '찾은 PID 만 멈춘다');
    assert.equal(attempt, 2);
  } finally {
    await s.close();
  }
});

test('setup: 같은 판을 다시 띄워도(창을 닫았다 다시 열기) 「다시 시도」가 409 로 막히지 않는다', async () => {
  // 2026-09-17 실제 사용자 실측(2.0.4): "설치 위치 확인을 먼저 해 주세요" — 재시작 뒤 soulConfirmed 가 복원되지 않았다.
  let attempt = 0;
  const runner = {
    async runSetup(ctx, { onStage }) {
      attempt += 1;
      if (attempt === 1) {
        onStage({ id: 'unpack', status: 'failed', code: 'E-UNPACK', message: '멈춤' });
        return { ok: false, failed: { id: 'unpack', code: 'E-UNPACK', message: '멈춤' }, pending: [] };
      }
      for (const id of SETUP_STAGE_IDS) onStage({ id, status: 'done' });
      return { ok: true, pending: [] };
    },
  };
  const s1 = await atSetupStep({ setupRunner: runner });
  const { soulRoot } = s1;
  const stateFile = path.join(tmp, `state-restart-${Date.now()}.json`);
  // 같은 상태 파일로 다시 띄우기 위해 지금 상태를 그 파일에 옮겨 적는다.
  await post(s1.url, '/api/setup/start');
  await waitForProgress(s1.url, (b) => b.error, 'a failure');
  const st1 = await getJson(s1.url, '/api/state');
  await s1.close();
  fs.writeFileSync(stateFile, JSON.stringify({ ...st1, packageVersion: st1.packageVersion ?? st1.version }), 'utf8');

  const s2 = await start({ setupRunner: runner, soulRoot, stateFile });
  try {
    const st2 = await getJson(s2.url, '/api/state');
    assert.equal(st2.step, 'setup', '같은 판은 그 자리에서 이어간다');
    const retry = await post(s2.url, '/api/setup/retry');
    assert.equal(retry.status, 202, `재시작 뒤 다시 시도가 막히면 안 된다: ${retry.status}`);
    await waitForProgress(s2.url, (b) => b.percent === 100, '100% after restart+retry');
    assert.equal(attempt, 2);
  } finally {
    await s2.close();
  }
});

test('setup: 엔진 모듈이 아직 없으면 E-NOT-IMPLEMENTED (서버는 그래도 뜬다)', async () => {
  const s = await atSetupStep({
    setupRunner: createSetupRunner({ importer: () => import('../installer/setup/does-not-exist.mjs') }),
  });
  try {
    await post(s.url, '/api/setup/start');
    const body = await waitForProgress(s.url, (b) => b.error, 'not-implemented');
    assert.equal(body.error.code, 'E-NOT-IMPLEMENTED');
    assert.match(body.error.message, /세팅 엔진/);
    assert.equal((await getJson(s.url, '/api/state')).step, 'setup');
  } finally {
    await s.close();
  }
});

// 고치기 1회차 ②: 정규화가 엔진 출력을 이겨야 한다(반대가 아니라).
test('setup-runner 어댑터: 엔진이 빠뜨리거나 이상하게 돌려줘도 ok·failed·pending 은 늘 성한 모양', async () => {
  const runFake = (value) => createSetupRunner({ importer: async () => ({ runSetup: async () => value }) })
    .runSetup({}, {});

  // 세 칸을 아예 안 준 엔진
  assert.deepEqual(await runFake({ somethingElse: 1 }), { somethingElse: 1, ok: false, failed: null, pending: [] });
  // ok 를 문자열로 준 엔진 -- true 로 새어 나가면 서버가 실패를 성공으로 읽는다
  assert.equal((await runFake({ ok: 'yes' })).ok, false);
  // pending 이 배열이 아닌 엔진 -- 화면이 그대로 순회하다 깨진다
  assert.deepEqual((await runFake({ ok: true, pending: 'nope' })).pending, []);
  // 성한 출력은 그대로 통과
  const good = await runFake({ ok: true, pending: [{ capability: 'x', reason: 'y' }], extra: 7 });
  assert.deepEqual(good, { ok: true, failed: null, pending: [{ capability: 'x', reason: 'y' }], extra: 7 });
  // 아무것도 안 돌려준 엔진
  assert.deepEqual(await runFake(undefined), { ok: false, failed: null, pending: [] });
});

test('setup: 소울 없이 시작하면 409', async () => {
  const s = await start({ soulName: 'CON', soulRoot: null });
  try {
    const r = await post(s.url, '/api/setup/start');
    assert.equal(r.status, 409);
    assert.equal((await r.json()).reason, 'no_soul');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑥ online: 막힌 주소
// ---------------------------------------------------------------------------
test('online: 막힌 주소를 이름으로 알리고 그 자리에 멈춘다', async () => {
  const s = await start({
    onlineRunner: {
      ...okOnline(),
      checkNet: async () => ({ ok: false, blocked: ['claude.ai', 'registry.npmjs.org'] }),
      installClaude: async () => { throw new Error('내려받기를 시작하면 안 된다'); },
    },
  });
  try {
    await answerQuestions(s.url);
    await post(s.url, '/api/online/start');
    const st = await waitForOnline(s.url, (b) => b.net, 'a net verdict');
    assert.equal(st.net.ok, false);
    assert.deepEqual(st.net.blocked, ['claude.ai', 'registry.npmjs.org']);
    assert.equal(st.stage, 'net');
    assert.notEqual((await getJson(s.url, '/api/state')).step, 'done');
  } finally {
    await s.close();
  }
});

test('online: 알 수 없는 구독은 거절, 소울 없이 중계기 시작은 409', async () => {
  const s = await start();
  try {
    await answerQuestions(s.url);
    const bad = await (await post(s.url, '/api/online/login', { provider: 'bogus' })).json();
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'bad_provider');
  } finally {
    await s.close();
  }
  const noSoul = await start({ soulName: 'CON', soulRoot: null });
  try {
    assert.equal((await post(noSoul.url, '/api/online/relay')).status, 409);
  } finally {
    await noSoul.close();
  }
});

// ---------------------------------------------------------------------------
// ⑦ 옛 라우트 · 정적 파일 · 가드
// ---------------------------------------------------------------------------
test('v1 라우트(/api/name·/api/install·/api/login·/api/handoff)는 410 으로 사라졌다', async () => {
  const s = await start();
  try {
    for (const p of ['/api/name', '/api/install', '/api/login', '/api/handoff']) {
      const r = await post(s.url, p);
      assert.equal(r.status, 410, `${p} should be gone`);
      assert.equal((await r.json()).reason, 'gone');
    }
    assert.equal((await fetch(`${s.url}/api/login/status`)).status, 410);
  } finally {
    await s.close();
  }
});

test('정적 파일은 세 개뿐: /, /structure.mjs, /presets.json — 그 밖은 404', async () => {
  const s = await start();
  try {
    const root = await fetch(`${s.url}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(root.headers.get('cache-control'), 'no-store');
    assert.ok((await root.text()).includes('IRIS'));

    const mod = await fetch(`${s.url}/structure.mjs`);
    assert.equal(mod.status, 200);
    assert.match(mod.headers.get('content-type') ?? '', /javascript/);
    assert.ok((await mod.text()).includes('validateNodes'));

    const presets = await fetch(`${s.url}/presets.json`);
    assert.equal(presets.status, 200);
    const presetBody = await presets.json();
    assert.equal(presetBody.schema, 1);
    assert.ok(Array.isArray(presetBody.presets) && presetBody.presets.length > 0);

    // GET /api/presets 는 같은 파일을 준다
    assert.deepEqual(await getJson(s.url, '/api/presets'), presetBody);

    for (const miss of ['/style.css', '/nope.html', '/ui/index.html', '/bootstrap.ps1']) {
      const r = await fetch(`${s.url}${miss}`);
      assert.equal(r.status, 404, miss);
      assert.deepEqual(await r.json(), { ok: false, reason: 'not_found' });
    }
  } finally {
    await s.close();
  }
});

test('정적 처리기는 경로 탈출을 막는다: ../, %2e%2e/, %5c, raw backslash 어느 것도 bootstrap.ps1 을 내주지 않는다', async () => {
  const s = await start();
  try {
    for (const rawPath of ['/../bootstrap.ps1', '/%2e%2e/bootstrap.ps1', '/..%5cbootstrap.ps1', '/..\\bootstrap.ps1']) {
      const { status, body } = await rawRequest(s.port, rawPath);
      assert.ok(status === 403 || status === 404, `expected 403/404 for ${rawPath}, got ${status}`);
      assert.ok(!body.includes('Mandatory'), `${rawPath} leaked bootstrap.ps1`);
    }
  } finally {
    await s.close();
  }
});

test('/api guard: 남의 Origin 은 403, 제 것과 Origin 없음은 통과; JSON 아닌 POST 는 415', async () => {
  const s = await start();
  try {
    const evil = await fetch(`${s.url}/api/health`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
    assert.deepEqual(await evil.json(), { ok: false, reason: 'bad_origin' });

    const evilPost = await fetch(`${s.url}/api/locate`, {
      method: 'POST', headers: { Origin: 'http://evil.example', ...JSON_HDR }, body: '{}',
    });
    assert.equal(evilPost.status, 403);

    // 모르는 /api 경로도 가드를 지난다 (앞으로 생길 라우트에 구멍을 남기지 않는다)
    assert.equal((await fetch(`${s.url}/api/nope`, { headers: { Origin: 'http://evil.example' } })).status, 403);

    for (const origin of [`http://127.0.0.1:${s.port}`, `http://localhost:${s.port}`]) {
      assert.equal((await fetch(`${s.url}/api/health`, { headers: { Origin: origin } })).status, 200, origin);
    }
    assert.equal((await fetch(`${s.url}/api/health`)).status, 200, 'Origin 없음은 통과');

    const form = await fetch(`${s.url}/api/locate`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x=1',
    });
    assert.equal(form.status, 415);
    assert.deepEqual(await form.json(), { ok: false, reason: 'unsupported_media_type' });

    const charset = await fetch(`${s.url}/api/locate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{}',
    });
    assert.equal(charset.status, 200);
  } finally {
    await s.close();
  }
});

test('본문 크기 경계: BODY_LIMIT 초과는 413 JSON 이고 서버는 계속 응답한다', async () => {
  const s = await start();
  try {
    const BODY_LIMIT = 1024 * 1024; // installer/server.mjs 의 BODY_LIMIT 과 같아야 한다
    const over = await fetch(`${s.url}/api/precheck`, {
      method: 'POST', headers: JSON_HDR, body: 'a'.repeat(BODY_LIMIT + 1024),
    });
    assert.equal(over.status, 413);
    assert.deepEqual(await over.json(), { ok: false, reason: 'bad_request' });
    assert.equal((await fetch(`${s.url}/api/health`)).status, 200);

    const under = await fetch(`${s.url}/api/choice`, {
      method: 'POST', headers: JSON_HDR, body: JSON.stringify({ subscriptions: ['claude'], pad: 'a'.repeat(BODY_LIMIT - 1000) }),
    });
    assert.equal(under.status, 200);
    assert.deepEqual(await under.json(), { ok: true, leadAgent: 'claude' });
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑧ 로그 · state 모양 · 중계기 이름 금지
// ---------------------------------------------------------------------------
test('POST /api/log/path 는 로그 파일 경로를 준다 (영혼이 정해지면 그 안 사본도)', async () => {
  const s = await start();
  try {
    await answerQuestions(s.url);
    const body = await (await post(s.url, '/api/log/path')).json();
    assert.equal(body.ok, true);
    assert.ok(body.path.endsWith(path.join('server.log')));
    assert.ok(fs.existsSync(body.path), '서버는 시작하면서 이미 한 줄을 남긴다');
    assert.equal(body.soulPath, path.join(s.soulRoot, '_agent', 'setup', 'installer.log'));
    assert.ok(fs.existsSync(body.soulPath), '영혼이 정해진 뒤의 로그는 그 안에도 남는다');
  } finally {
    await s.close();
  }
});

test('GET /api/state 는 계약이 약속한 칸을 전부 들고 있다', async () => {
  const s = await start();
  try {
    const st = await getJson(s.url, '/api/state');
    for (const key of ['ok', 'name', 'version', 'step', 'packageVersion', 'precheck', 'soul', 'choice', 'decisions', 'setup', 'online', 'report']) {
      assert.ok(key in st, `state.${key} 가 없다`);
    }
    assert.equal(st.name, 'iris-installer');
    assert.equal(st.packageVersion, '2.0.0');
    assert.deepEqual(st.setup.stages.map((x) => x.id), SETUP_STAGE_IDS);
    assert.deepEqual(Object.keys(st.online).sort(), ['claude', 'documentSkills', 'logins', 'net', 'relay', 'stage']);
    assert.equal(st.soul.mode, 'empty');
    assert.equal(st.soul.root, s.soulRoot);
  } finally {
    await s.close();
  }
});

// 설계-v2 7절: 화면 문구에 중계기의 제품 이름을 쓰지 않는다. 서버가 message 로
// 내보내는 한국어 문장은 화면에 그대로 나가므로 여기서 지킨다.
test('online: 중계기 실패는 원인 문장·원문을 상태에 싣고, /api/online/relay 를 다시 부르면 이어간다', async () => {
  // 2026-09-17 실제 사용자 실측(2.0.5): 로그인은 done 인데 계정 연결 확인이 ✗ "아직 연결되지 않았습니다"뿐이라
  // 누를 단추도, 까닭도 없었다.
  let relayCalls = 0;
  const s = await atSetupStep({
    onlineRunner: {
      ...okOnline(),
      startRelay: async () => {
        relayCalls += 1;
        if (relayCalls === 1) {
          return { ok: false, state: 'failed', code: 'E-RELAY', message: '중계기를 시작하지 못했습니다 — 포트 3456 에서 중계기가 답하지 않습니다.', detail: { port: 3456, manageExit: 1 } };
        }
        return { ok: true, state: 'done', accounts: 1 };
      },
    },
  });
  try {
    await post(s.url, '/api/setup/start');
    await waitForProgress(s.url, (b) => b.percent === 100, '100%');
    await post(s.url, '/api/online/start');
    await waitForOnline(s.url, (b) => b.stage === 'login' || b.stage === 'relay', 'login phase');
    await post(s.url, '/api/online/login', { provider: 'claude' });
    await waitForOnline(s.url, (b) => b.logins.claude?.state === 'done', 'login done');

    const first = await (await post(s.url, '/api/online/relay')).json();
    assert.equal(first.ok, false);
    const st = await getJson(s.url, '/api/online/status');
    assert.equal(st.relay.state, 'failed');
    assert.match(st.relay.message, /포트 3456/, '원인 문장이 화면으로 간다');
    assert.match(String(st.relay.detail), /manageExit/, '원문도 간다');
    assert.ok(Number.isFinite(st.now) && Number.isFinite(st.stageAt), '경과 시간용 시각이 있다');
    assert.equal((await getJson(s.url, '/api/state')).step, 'online', '실패해도 online 카드에 머문다');

    const second = await (await post(s.url, '/api/online/relay')).json();
    assert.equal(second.ok, true);
    assert.equal((await getJson(s.url, '/api/online/status')).relay.state, 'done');
    assert.equal((await getJson(s.url, '/api/state')).step, 'done');
    assert.equal(relayCalls, 2);
  } finally {
    await s.close();
  }
});

test('사용자에게 나가는 message 어디에도 중계기 제품 이름이 없다', async () => {
  const s = await start({
    setupRunner: { runSetup: async () => ({ ok: false, failed: { id: 'relay', code: 'E-RELAY', message: '중계기 준비에 실패했습니다.' }, pending: [] }) },
    onlineRunner: {
      checkNet: async () => ({ ok: false, blocked: ['claude.ai'] }),
      installClaude: async () => ({ ok: false, code: 'E-CLAUDE' }),
      installDocumentSkills: async () => ({ ok: false, state: 'pending', code: 'E-ONLINE-DOCSKILLS' }),
      startLogin: async () => ({ ok: false, reason: 'page-blocked', message: '로그인 페이지가 열리지 않습니다.' }),
      loginStatus: async () => ({ state: 'failed', reason: 'page-blocked' }),
      startRelay: async () => ({ ok: false, code: 'E-RELAY', message: '중계기가 응답하지 않습니다.' }),
    },
  });
  const seen = [];
  try {
    const collect = async (p, body, method = 'POST') => {
      const r = method === 'POST' ? await post(s.url, p, body) : await fetch(`${s.url}${p}`);
      seen.push(JSON.stringify(await r.json().catch(() => ({}))));
    };
    await collect('/api/precheck');
    await collect('/api/locate');
    await collect('/api/choice', { subscriptions: [] });
    await collect('/api/choice', { subscriptions: ['claude'] });
    await collect('/api/structure', { nodes: [] });
    await collect('/api/structure', { nodes: TREE });
    await collect('/api/summary/confirm');
    await collect('/api/setup/start');
    await waitForProgress(s.url, (b) => b.error, 'the injected relay failure');
    await collect('/api/setup/progress', null, 'GET');
    await collect('/api/online/start');
    await collect('/api/online/login', { provider: 'claude' });
    await collect('/api/online/relay');
    await collect('/api/online/status', null, 'GET');
    await collect('/api/state', null, 'GET');

    const all = seen.join('\n');
    assert.ok(!/teamclaude/i.test(all), `응답에 중계기 제품 이름이 들어 있다:\n${all}`);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑩ 중계기 성공 → 인수 문서 갱신 (T18 `setup/handoff.mjs refreshHandoffAfterOnline`)
// ---------------------------------------------------------------------------
//
// ⑨ 검사는 로그인 **전에** handoff.json 을 쓰므로 그때는 `login-pending` 이다.
// 로그인·중계기가 끝나는 이 순간이 `ready` 로 바뀌는 유일한 자리다 —
// 서버가 그때 갱신을 부르지 않으면 Face 는 다 끝난 영혼을 열고도 첫 인사 대신
// 「설치 이어하기」 카드를 보여 준다.
test('중계기가 끝나면 handoff.json 이 ready 로 바뀐다 (Face 가 쓴 칸은 그대로)', async () => {
  const s = await start();
  const { url, soulRoot } = s;
  try {
    await answerQuestions(url, ['claude']);
    await post(url, '/api/structure', { nodes: TREE });
    await post(url, '/api/summary/confirm');
    await post(url, '/api/setup/start');
    await waitForProgress(url, (b) => b.percent === 100, 'setup 100%');

    // 진짜 엔진이 남겼을 두 가지를 손으로 놓는다: 아홉 단계 done 영수증과,
    // ⑨ 검사가 로그인 전에 써 둔 인수 문서.
    const receipt = readReceipt(soulRoot);
    for (const id of SETUP_STAGE_IDS) {
      receipt.setup[id] = { status: 'done', startedAt: '2026-09-15T00:00:00.000Z', finishedAt: '2026-09-15T00:01:00.000Z', recorded: {}, pending: [] };
    }
    writeReceipt(soulRoot, receipt);

    const handoffFile = path.join(soulRoot, '_agent', 'setup', 'handoff.json');
    fs.writeFileSync(handoffFile, JSON.stringify({
      schema: 1,
      packageVersion: '2.0.0',
      state: 'login-pending',
      subscriptions: ['claude'],
      leadAgent: 'claude',
      login: { claude: 'waiting', chatgpt: 'not-needed' },
      relay: { state: 'pending', accounts: 0 },
      setup: { allDone: true, failed: null },
      folders: [], nameEnMissing: [], deferred: [], pendingCapabilities: [],
      checks: { pass: 11, pending: 0, fail: 0 },
      reportPath: '_agent/setup/설치보고-2026-09-15.md',
      diagnosticsPath: '_agent/setup/diagnostics.json',
      firstMessage: '세팅이 끝났다. …',
      messenger: { installed: true, prompted: true },
      resume: { installerPath: '_agent/setup/installer/IRIS-설치.cmd', args: ['--resume'] },
      setupCompletedAt: null,
    }, null, 2), 'utf8');

    await post(url, '/api/online/start');
    await waitForOnline(url, (b) => b.stage === 'login' || b.stage === 'relay', 'the login phase');
    await post(url, '/api/online/login', { provider: 'claude' });
    await waitForOnline(url, (b) => b.logins.claude?.state === 'done', 'claude login done');

    const relay = await (await post(url, '/api/online/relay')).json();
    assert.equal(relay.ok, true);

    const handoff = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
    assert.equal(handoff.state, 'ready', '로그인·중계기가 끝났으니 첫 인사를 해도 된다');
    assert.equal(handoff.login.claude, 'done');
    assert.equal(handoff.login.chatgpt, 'not-needed', '고르지 않은 구독은 기다릴 것이 없다');
    assert.deepEqual(handoff.relay, { state: 'done', accounts: 1 });
    assert.equal(handoff.setup.allDone, true);
    assert.ok(handoff.setupCompletedAt, 'ready 가 된 시각이 찍힌다');
    assert.equal(handoff.messenger.prompted, true, 'Face 가 쓴 칸은 서버가 건드리지 않는다');
    assert.equal(handoff.reportPath, '_agent/setup/설치보고-2026-09-15.md', '나머지 칸은 그대로');
  } finally {
    await s.close();
  }
});

test('인수 문서가 아직 없으면 중계기 성공이 그것을 지어내지 않는다', async () => {
  const s = await start();
  const { url, soulRoot } = s;
  try {
    await answerQuestions(url, ['claude']);
    await post(url, '/api/structure', { nodes: TREE });
    await post(url, '/api/summary/confirm');
    await post(url, '/api/setup/start');
    await waitForProgress(url, (b) => b.percent === 100, 'setup 100%');

    await post(url, '/api/online/start');
    await waitForOnline(url, (b) => b.stage === 'login' || b.stage === 'relay', 'the login phase');
    const relay = await (await post(url, '/api/online/relay')).json();
    assert.equal(relay.ok, true, '중계기는 그대로 성공한다');
    assert.equal((await getJson(url, '/api/state')).step, 'done');
    assert.equal(fs.existsSync(path.join(soulRoot, '_agent', 'setup', 'handoff.json')), false,
      '검사 결과 없이 "다 됐다"고 적힌 문서를 만들어 내지 않는다');
  } finally {
    await s.close();
  }
});

test('report: POST /api/report/send 는 미리 보기(전송 0)와 전송(fetch 1회·사본 저장)을 가르고, 영혼이 없어도 된다', async () => {
  const calls = [];
  const s = await start({ reportFetchFn: async (url, init) => { calls.push({ url, init }); return { status: 200 }; } });
  try {
    // 영혼이 정해지기 전(precheck 단계)에도 신고할 수 있어야 한다 — 설치가 그 앞에서 막힐 수도 있으니까.
    const pv = await (await post(s.url, '/api/report/send', { preview: true, memo: 'm', contact: 'c' })).json();
    assert.equal(pv.ok, true); assert.equal(pv.preview, true);
    assert.match(pv.id, /^R-\d{8}-\d{4}-[0-9a-f]{4}$/);
    assert.equal(pv.payload.memo, 'm'); assert.equal(pv.payload.contact, 'c');
    assert.ok(pv.payload.summary.includes('"step": "precheck"'));
    assert.equal(calls.length, 0, '미리 보기는 보내지 않는다');

    const sent = await (await post(s.url, '/api/report/send', { memo: '멈춤', contact: '' })).json();
    assert.equal(sent.ok, true); assert.equal(sent.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'POST');
    const form = new URLSearchParams(calls[0].init.body);
    assert.equal(form.get('entry.1325620015'), sent.id, '접수번호 항목');
    assert.equal(form.get('entry.1736423815'), '멈춤', '메모 항목');
    assert.ok(sent.savedTo && fs.existsSync(sent.savedTo), `사본이 없음: ${sent.savedTo}`);
    assert.ok(!sent.savedTo.includes(s.soulRoot), '영혼이 없으면 설치기 로그 폴더에 남긴다');
  } finally {
    await s.close();
  }
});

test('report: 보내기 실패는 ok:false + 까닭 + 사본 경로', async () => {
  const s = await start({ reportFetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND docs.google.com'); } });
  try {
    const r = await (await post(s.url, '/api/report/send', {})).json();
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOTFOUND/);
    assert.ok(r.savedTo && fs.existsSync(r.savedTo));
  } finally {
    await s.close();
  }
});

test('online: 중계기가 뜨면 검사 12·13 을 다시 재어 online.recheck 에 싣고 영수증 검사 기록의 같은 id 를 갈아 끼운다', async () => {
  const items = [
    { id: 'relay', num: 12, label: '중계기 경유(클로드)', status: 'pass', detail: '통과' },
    { id: 'relayCodex', num: 13, label: '중계기 경유(코덱스 세션 → TeamClaude)', status: 'pass', detail: 'CA 번들 갱신' },
  ];
  let recheckRoot = null;
  const s = await atSetupStep({ relayRecheckFn: async (root) => { recheckRoot = root; return { at: 't', items }; } });
  try {
    await post(s.url, '/api/setup/start');
    await waitForProgress(s.url, (b) => b.percent === 100, '100%');
    // 엔진(가짜)이 남긴 검사 기록에 "대기" 항목을 심어 둔다 — 실제 신규 설치의 ⑥ 시점 모습.
    const before = readReceipt(s.soulRoot);
    before.setup.checks = { ...(before.setup.checks ?? {}), recorded: { checks: { pass: 1, pending: 1, fail: 0 }, items: [
      { id: 'exe', num: 1, label: '실행 파일', status: 'pass', detail: 'ok' },
      { id: 'relayCodex', num: 13, label: '중계기 경유(코덱스 세션 → TeamClaude)', status: 'pending', detail: '중계기가 응답하지 않음' },
    ] } };
    writeReceipt(s.soulRoot, before);
    await post(s.url, '/api/online/start');
    await waitForOnline(s.url, (b) => b.stage === 'login' || b.stage === 'relay', 'login phase');
    await post(s.url, '/api/online/login', { provider: 'claude' });
    await waitForOnline(s.url, (b) => b.logins.claude?.state === 'done', 'login done');
    const relay = await (await post(s.url, '/api/online/relay')).json();
    assert.equal(relay.ok, true);
    assert.equal(recheckRoot, s.soulRoot);
    const st = await getJson(s.url, '/api/online/status');
    assert.equal(st.recheck.items.length, 2);
    assert.equal(st.recheck.items[1].status, 'pass');
    const after = readReceipt(s.soulRoot);
    const rec = after.setup.checks.recorded;
    assert.equal(rec.items.find((c) => c.id === 'relayCodex').status, 'pass', '대기였던 검사 13 이 통과로 바뀐다');
    assert.equal(rec.items.find((c) => c.id === 'relay').num, 12, '없던 검사 12 는 덧붙인다');
    assert.equal(rec.items.find((c) => c.id === 'exe').status, 'pass', '다른 항목은 그대로');
    assert.deepEqual(rec.checks, { pass: 3, pending: 0, fail: 0 });
  } finally {
    await s.close();
  }
});

test('online: 다시 재기가 던져도 설치 완료는 막지 않는다(기록만)', async () => {
  const s = await atSetupStep({ relayRecheckFn: async () => { throw new Error('probe exploded'); } });
  try {
    await post(s.url, '/api/setup/start');
    await waitForProgress(s.url, (b) => b.percent === 100, '100%');
    await post(s.url, '/api/online/start');
    await waitForOnline(s.url, (b) => b.stage === 'login' || b.stage === 'relay', 'login phase');
    await post(s.url, '/api/online/login', { provider: 'claude' });
    await waitForOnline(s.url, (b) => b.logins.claude?.state === 'done', 'login done');
    assert.equal((await (await post(s.url, '/api/online/relay')).json()).ok, true);
    assert.equal((await getJson(s.url, '/api/state')).step, 'done');
    assert.match((await getJson(s.url, '/api/online/status')).recheck.error, /probe exploded/);
  } finally {
    await s.close();
  }
});

test('update-offer(2.0.22): finished older install -> step "update" with auto eligibility; same version -> "done"', async () => {
  const doneReceipt = (version) => {
    const setup = {};
    for (const id of SETUP_STAGE_IDS) setup[id] = { status: 'done' };
    return {
      schema: 2, package: { name: 'IRIS', version }, choice: { subscriptions: ['chatgpt'], leadAgent: 'codex' },
      setup, online: { completed: true },
      steps: { precheck: 'done', locate: 'done', choice: 'done', structure: 'done', summary: 'done', setup: 'done', online: 'done' },
    };
  };
  const older = await start({ readReceiptFn: () => doneReceipt('1.9.0') });
  try {
    const st = await getJson(older.url, '/api/state');
    assert.equal(st.step, 'update');
    assert.equal(st.auto.eligible, true);
    assert.equal(st.auto.viaWizard, true);
    assert.equal(st.auto.from, '1.9.0');
    assert.equal(st.auto.to, '2.0.0');
    const loc = await (await post(older.url, '/api/locate')).json();
    assert.equal(loc.ok, true);
    assert.deepEqual(loc.update, { from: '1.9.0', to: '2.0.0' });
    assert.equal((await getJson(older.url, '/api/state')).step, 'update');
  } finally {
    await older.close();
  }
  const same = await start({ readReceiptFn: () => doneReceipt('2.0.0') });
  try {
    assert.equal((await getJson(same.url, '/api/state')).step, 'done');
    const loc = await (await post(same.url, '/api/locate')).json();
    assert.equal(loc.update, undefined);
  } finally {
    await same.close();
  }
});
