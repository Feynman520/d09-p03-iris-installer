import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../installer/server.mjs';
import { planUpdateReset, applyUpdateReset, ALWAYS_RESET } from '../installer/lib/update-plan.mjs';

// 자동 업데이트 모드(`IRIS-설치.cmd --auto`).
//
// 2.0 부터 업데이트는 **세팅 엔진을 한 번 더 도는 것**이다(설계-v2 11절). 옛 v1
// `install()` 은 33개 부품 중 12개만 알고 파이썬을 strip:0 으로 풀어 놓았기 때문에
// 이 경로에서 완전히 빠졌다 — 아래 시험이 그것을 못 박는다.
//
// 진짜 영혼은 하나도 건드리지 않는다: 영혼 이름은 지어낸 것이고(이 PC 의 C:\IRIS 가
// 아니다), 영수증 읽기·쓰기·세팅 엔진·창 다시 열기·마무리가 전부 주입이라 C:\ 아래에
// 아무것도 쓰지 않는다. 대신 **잠금표만은 진짜**를 먹인다 — 업데이트가 33개 부품을
// 다 보는지가 이 시험의 핵심이기 때문이다.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_LOCK = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'lock.json'), 'utf8'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-auto-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const SOUL = 'ALPHA-AUTO-TEST';

// 진짜 빌드의 manifest 처럼 **부품마다 지문이 있는** 목록. 잠금표에 sha256 이
// 없는 부품(`kind: dir` 은 빌드가 zip 을 만들며 지문을 낸다)도 여기서는 지문을
// 갖는다 — 그래야 "판이 같다/다르다"를 부품 단위로 가릴 수 있다.
const MANIFEST_PARTS = Object.fromEntries(Object.entries(REAL_LOCK.parts).map(([id, p]) => [id, {
  version: p.version ?? null,
  sha256: p.sha256 ?? `${id}-sha256-v1`,
  dest: p.dest ?? null,
  file: p.file ?? null,
}]));

// 꾸러미 한 벌: payload\manifest.json + 진짜 lock.json(판만 이번 것으로).
function makeZipRoot(name, version = '2.0.0') {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'payload'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'payload', 'manifest.json'),
    JSON.stringify({
      schema: 2,
      built: '2026-09-15T00:00:00.000Z',
      package: { name: 'IRIS', version },
      parts: MANIFEST_PARTS,
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'lock.json'),
    JSON.stringify({ ...REAL_LOCK, package: { ...(REAL_LOCK.package ?? {}), version } }),
    'utf8',
  );
  return dir;
}

// 지금 깔려 있는 것 = 이번 잠금표와 **같은 판**(달라진 부품 0개)이라고 적은 영수증.
function unpackRecordedFromLock(overrides = {}) {
  const parts = {};
  for (const [id, p] of Object.entries(REAL_LOCK.parts)) {
    const tail = p.dest ? String(p.dest).split('/').filter(Boolean).pop() : null;
    parts[id] = {
      identity: { version: p.version ?? null, sha256: MANIFEST_PARTS[id].sha256, tail: tail ?? null },
      dest: p.dest ?? null,
      verified: true,
    };
  }
  for (const [id, identity] of Object.entries(overrides)) {
    parts[id] = { ...(parts[id] ?? {}), identity };
  }
  return { total: Object.keys(parts).length, parts };
}

const FAKE_MANIFEST = { schema: 2, package: { name: 'IRIS', version: '2.0.0' }, parts: MANIFEST_PARTS };

const STAGE_IDS = ['unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks'];

// 아홉 단계가 전부 done 인 v2 영수증(= 정상적으로 끝난 2.x 설치).
function priorReceipt({ version = '1.9.0', partOverrides = {} } = {}) {
  const setup = {};
  for (const id of STAGE_IDS) {
    setup[id] = { status: 'done', startedAt: '2026-09-14T00:00:00.000Z', finishedAt: '2026-09-14T00:01:00.000Z' };
  }
  setup.unpack.recorded = unpackRecordedFromLock(partOverrides);
  return {
    schema: 2,
    package: { name: 'IRIS', version, guideVersion: '14', license: 'MIT' },
    soul: { root: `C:\\${SOUL}`, name: SOUL, createdBy: 'iris-installer' },
    choice: { subscriptions: ['claude', 'chatgpt'], leadAgent: 'claude' },
    installed: {},
    setup,
    online: { completed: true },
    steps: { precheck: 'done', locate: 'done', choice: 'done', structure: 'done', summary: 'done', setup: 'done', online: 'done' },
  };
}

// 영수증을 파일 대신 메모리에 두는 가짜 디스크(읽기는 늘 사본을 준다).
function receiptStore(initial) {
  const state = { receipt: JSON.parse(JSON.stringify(initial)), writes: [] };
  return {
    state,
    readReceiptFn: () => JSON.parse(JSON.stringify(state.receipt)),
    writeReceiptFn: (root, r) => {
      state.receipt = JSON.parse(JSON.stringify(r));
      state.writes.push(JSON.parse(JSON.stringify(r)));
    },
  };
}

// 세팅 엔진 자리에 끼우는 가짜. 받은 ctx 를 그대로 보관하고, 아홉 단계를
// 방송만 한 뒤 성공을 돌려준다(진짜 단계 모듈은 하나도 돌지 않는다).
function fakeSetupRunner({ ok = true, failed = null, onCtx = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    runner: {
      runSetup: async (ctx, options = {}) => {
        calls.push(ctx);
        onCtx(ctx);
        for (const [i, id] of STAGE_IDS.entries()) {
          options.onStage?.({ id, status: 'running', percent: Math.floor((i / STAGE_IDS.length) * 100) });
          if (!ok && failed?.id === id) {
            options.onStage?.({ id, status: 'failed', code: failed.code, message: failed.message, percent: 0 });
            return { ok: false, failed, pending: [] };
          }
          options.onStage?.({ id, status: 'done', percent: Math.floor(((i + 1) / STAGE_IDS.length) * 100) });
        }
        return { ok: true, failed: null, pending: [] };
      },
    },
  };
}

// 준비 확인은 주입한다: 자동 갱신 경로는 blockers 가 0 일 때만 진행하는데,
// 진짜 precheck 은 이 PC 에서 실제로 3456~3460 포트를 두드려 보므로 (다른
// 시험이 함께 도는 동안 느려지면 'foreign' 으로 읽혀) 결과가 기계 상태에
// 좌우된다. 이 파일이 보려는 것은 갱신 흐름이지 이 PC 의 포트 상태가 아니다.
const OK_PRECHECK = { blockers: [], warnings: [], info: {}, recorded: {} };

async function waitForStep(url, want, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const s = await (await fetch(`${url}/api/state`)).json();
    if (s.step === want) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  const s = await (await fetch(`${url}/api/state`)).json();
  assert.fail(`step never became ${want} (it is ${s.step}, installError=${s.installError})`);
}

// The event buffer is replayed to any client that connects, so reading it
// after the run is over sees everything that was emitted.
async function readBufferedEvents(url) {
  const ctrl = new AbortController();
  const stream = await fetch(`${url}/api/install/events`, { signal: ctrl.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames = [];
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), 300)),
    ]);
    if (done) break;
    if (value) buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i).replace(/^data: /, '');
      buf = buf.slice(i + 2);
      if (raw.trim()) frames.push(JSON.parse(raw));
    }
    if (frames.some((f) => f.done)) break;
  }
  ctrl.abort();
  return frames;
}

// ===========================================================================
// 되돌릴 단계 고르기 (순수 함수)
// ===========================================================================

test('plan: 바뀐 부품이 없으면 unpack·env·adapters 셋만 되돌리고 나머지는 done 으로 둔다', () => {
  const receipt = priorReceipt();
  const plan = planUpdateReset({ receipt, lock: REAL_LOCK, manifest: FAKE_MANIFEST });
  assert.deepEqual(plan.reset, [...ALWAYS_RESET]);
  assert.deepEqual(plan.changed, [], '같은 잠금표를 다시 먹였으니 달라진 부품은 없다');
  assert.ok(plan.keptDone.includes('venv'));
  assert.ok(plan.keptDone.includes('relay'));
  assert.ok(plan.keptDone.includes('skeleton') && plan.keptDone.includes('ontology'));
});

test('plan: 파이썬 판이 달라지면 venv 도 다시 돈다', () => {
  const receipt = priorReceipt({
    partOverrides: { python: { version: '3.12.10', sha256: `${'0'.repeat(63)}9`, tail: 'python' } },
  });
  const plan = planUpdateReset({ receipt, lock: REAL_LOCK, manifest: FAKE_MANIFEST });
  assert.ok(plan.reset.includes('venv'), `venv 가 되돌려져야 한다: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.changed, ['python']);
  assert.match(plan.reasons.venv, /python/);
  assert.ok(!plan.reset.includes('skeleton'), '사람의 영혼 쪽 단계는 그대로');
});

test('plan: 창 실행기가 가리키는 부품(face)이 바뀌면 relay 도 다시 돈다', () => {
  const receipt = priorReceipt({
    partOverrides: { face: { version: null, sha256: 'face-sha256-v0', tail: 'face' } },
  });
  const plan = planUpdateReset({ receipt, lock: REAL_LOCK, manifest: FAKE_MANIFEST });
  assert.ok(plan.reset.includes('relay'));
  assert.ok(!plan.reset.includes('venv'));
});

test('plan: 영수증에 기록이 아예 없는 부품은 "모름 = 바뀜"으로 본다(건너뛰지 않는다)', () => {
  const receipt = priorReceipt();
  delete receipt.setup.unpack.recorded.parts.uv;
  const plan = planUpdateReset({ receipt, lock: REAL_LOCK, manifest: FAKE_MANIFEST });
  assert.deepEqual(plan.changed, ['uv']);
  assert.ok(plan.reset.includes('venv'));
});

test('plan (Task 24b #3): document-mcp-wheelhouse 는 manifest 에 지문이 없어도 잠금표 sha256 변화를 놓치지 않는다', () => {
  // 진짜 manifest 는 이 부품(폴더)에 sha256 을 못 낸다 — lock.json 의 sha256
  // (requirements.lock 지문)만이 정체성이다.
  const manifest = JSON.parse(JSON.stringify(FAKE_MANIFEST));
  delete manifest.parts['document-mcp-wheelhouse'].sha256;

  const oldSha = REAL_LOCK.parts['document-mcp-wheelhouse'].sha256;
  const receipt = priorReceipt({
    partOverrides: { 'document-mcp-wheelhouse': { version: null, sha256: oldSha, tail: 'document-mcp' } },
  });

  // 새 잠금표: requirements.lock 지문만 바뀌었다(바퀴 내용이 실제로 달라졌다).
  const lock = JSON.parse(JSON.stringify(REAL_LOCK));
  lock.parts['document-mcp-wheelhouse'].sha256 = `${'f'.repeat(63)}9`;

  const plan = planUpdateReset({ receipt, lock, manifest });
  assert.ok(plan.changed.includes('document-mcp-wheelhouse'), 'lock.json 의 sha256 변화가 changed 로 잡혀야 한다');
  assert.ok(plan.reset.includes('venv'), 'venv 도 다시 만들어야 한다');
  assert.match(plan.reasons.venv, /document-mcp-wheelhouse/);
});

test('applyUpdateReset: 옛 기록을 지우지 않고 status 만 pending 으로 되돌린다', () => {
  const receipt = priorReceipt();
  const plan = planUpdateReset({ receipt, lock: REAL_LOCK, manifest: FAKE_MANIFEST });
  applyUpdateReset(receipt, plan);
  assert.equal(receipt.setup.unpack.status, 'pending');
  assert.equal(receipt.setup.adapters.status, 'pending');
  assert.equal(receipt.setup.unpack.resetBy, 'auto-update');
  assert.ok(receipt.setup.unpack.recorded.parts.node, '옛 풀기 기록은 그대로 남아 있다');
  assert.equal(receipt.setup.checks.status, 'done');
});

// ===========================================================================
// 서버 경로
// ===========================================================================

test('auto: 업데이트는 v2 세팅 엔진을 돌린다 — 진짜 잠금표 33개 부품, v1 install() 은 부르지 않는다', async () => {
  const zipRoot = makeZipRoot('zip-auto');
  const store = receiptStore(priorReceipt({ version: '1.9.0' }));
  const relaunchCalls = [];
  const finishCalls = [];
  const engine = fakeSetupRunner();

  const { url, close } = await startServer({
    port: 0,
    precheckFn: async () => OK_PRECHECK,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile: path.join(tmp, 'state-auto.json'),
    soulName: SOUL,
    auto: true,
    readReceiptFn: store.readReceiptFn,
    writeReceiptFn: store.writeReceiptFn,
    setupRunner: engine.runner,
    relaunchFaceFn: (opts) => { relaunchCalls.push(opts); return { ok: true, how: 'wscript', pid: 777 }; },
    finishFn: (opts) => { finishCalls.push(opts); return { ok: true }; },
    onQuit: () => {},
  });

  try {
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.auto, true);
    const before = await (await fetch(`${url}/api/state`)).json();
    assert.equal(before.auto.eligible, true);
    assert.equal(before.auto.from, '1.9.0');
    assert.equal(before.auto.to, '2.0.0');

    const started = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 202);

    const end = await waitForStep(url, 'done');
    assert.equal(end.autoResult.ok, true);
    assert.equal(end.autoResult.from, '1.9.0');
    assert.equal(end.autoResult.to, '2.0.0');
    assert.equal(end.autoResult.relaunched, true);

    // ① 엔진이 한 번, 마법사와 같은 ctx 로 불렸다
    assert.equal(engine.calls.length, 1, '세팅 엔진이 정확히 한 번 돈다');
    const ctx = engine.calls[0];
    assert.equal(ctx.root, `C:\\${SOUL}`);
    assert.equal(ctx.offline, true);
    assert.equal(Object.keys(ctx.lock.parts).length, Object.keys(REAL_LOCK.parts).length);
    assert.ok(Object.keys(ctx.lock.parts).length >= 33, '진짜 잠금표(부품 33개)가 그대로 들어간다');
    assert.equal(ctx.lock.parts.python.version, REAL_LOCK.parts.python.version);
    assert.deepEqual(ctx.choice, priorReceipt().choice, 'ⓑⓒ 는 영수증이 답한다');
    assert.equal(ctx.payloadDir, path.join(zipRoot, 'payload'));

    // ② 되돌린 단계 = unpack·env·adapters, 나머지는 done 인 채
    const setup = ctx.receipt.setup;
    for (const id of ALWAYS_RESET) assert.equal(setup[id].status, 'pending', `${id} 는 다시 돌아야 한다`);
    for (const id of ['skeleton', 'structure', 'venv', 'relay', 'ontology', 'checks']) {
      assert.equal(setup[id].status, 'done', `${id} 는 그대로 두어야 한다(바뀐 부품 없음)`);
    }

    // ③ 영수증의 판이 새 것으로 바뀌고 무엇을 되돌렸는지 남는다
    assert.equal(store.state.receipt.package.version, '2.0.0');
    assert.equal(store.state.receipt.update.from, '1.9.0');
    assert.deepEqual(store.state.receipt.update.reset, [...ALWAYS_RESET]);

    // ④ 로그인은 건너뛰고 창은 다시 열린다
    assert.equal(relaunchCalls.length, 1);
    assert.equal(finishCalls.length, 1);

    // ⑤ 화면이 읽는 흐름: 단계 이름이 그대로 part 로 나가고 끝 프레임은 하나
    const frames = await readBufferedEvents(url);
    const terminal = frames.filter((f) => f.done);
    assert.equal(terminal.length, 1, `exactly one terminal frame, got ${JSON.stringify(frames)}`);
    assert.equal(terminal[0].error, null);
    assert.equal(terminal[0].pct, 100);
    const byPart = Object.fromEntries(frames.filter((f) => f.part).map((f) => [f.part, f]));
    assert.equal(byPart.precheck.status, 'done');
    assert.equal(byPart.unpack.status, 'done');
    assert.equal(byPart.checks.status, 'done');
    assert.equal(byPart.login.skipped, true);
    assert.equal(byPart.relaunch.status, 'done');
  } finally {
    await close();
  }
});

test('auto: 서버는 v1 install() 을 더 이상 들이지 않는다(코드에 그 길이 없다)', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'installer', 'server.mjs'), 'utf8');
  assert.ok(!/from '\.\/lib\/install\.mjs'/.test(source), 'server.mjs 가 lib/install.mjs 를 import 하면 안 된다');
  assert.ok(!/installFn/.test(source), 'v1 install 주입 자리(installFn)가 남아 있으면 안 된다');
  assert.ok(/planUpdateReset/.test(source), '업데이트는 lib/update-plan.mjs 로 단계를 고른다');
});

test('auto: 파이썬 판이 바뀐 꾸러미면 venv 도 되돌린 채로 엔진이 돈다', async () => {
  const zipRoot = makeZipRoot('zip-auto-venv');
  const store = receiptStore(priorReceipt({
    partOverrides: {
      python: { version: '3.12.10', sha256: `${'0'.repeat(63)}1`, tail: 'python' },
      uv: { version: '0.0.1', sha256: `${'0'.repeat(63)}2`, tail: 'uv' },
    },
  }));
  const engine = fakeSetupRunner();

  const { url, close } = await startServer({
    port: 0,
    precheckFn: async () => OK_PRECHECK,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile: path.join(tmp, 'state-auto-venv.json'),
    soulName: SOUL,
    auto: true,
    readReceiptFn: store.readReceiptFn,
    writeReceiptFn: store.writeReceiptFn,
    setupRunner: engine.runner,
    relaunchFaceFn: () => ({ ok: true, pid: 5 }),
    finishFn: () => ({ ok: true }),
    onQuit: () => {},
  });
  try {
    await fetch(`${url}/api/auto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await waitForStep(url, 'done');
    const setup = engine.calls[0].receipt.setup;
    assert.equal(setup.venv.status, 'pending', '파이썬·uv 판이 바뀌었으면 파이썬 환경을 다시 만든다');
    assert.equal(setup.unpack.status, 'pending');
    assert.equal(setup.skeleton.status, 'done');
    assert.deepEqual(store.state.receipt.update.changedParts, ['python', 'uv']);
  } finally {
    await close();
  }
});

test('auto: requested on a PC with no receipt falls back to the ordinary wizard', async () => {
  const zipRoot = makeZipRoot('zip-auto-fresh');
  const engine = fakeSetupRunner();
  const { url, close } = await startServer({
    port: 0,
    precheckFn: async () => OK_PRECHECK,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile: path.join(tmp, 'state-fresh.json'),
    soulName: SOUL,
    auto: true,
    readReceiptFn: () => null, // no install here yet
    setupRunner: engine.runner,
    relaunchFaceFn: () => { throw new Error('relaunch must not run'); },
  });
  try {
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.equal(st.auto.requested, true);
    assert.equal(st.auto.eligible, false);
    assert.equal(st.auto.reason, 'no_receipt');

    const refused = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, reason: 'no_receipt' });
    assert.equal(engine.calls.length, 0, '세팅 엔진은 돌지 않았다');

    // and the normal wizard is still there (v2: the location step replaced
    // the old "name the folder" step -- the folder is fixed)
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.auto, false);
    const locate = await fetch(`${url}/api/locate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(locate.status, 200);
    assert.equal((await locate.json()).root, `C:\\${SOUL}`);
  } finally {
    await close();
  }
});

test('auto: without the flag nothing is automatic, even over an existing install', async () => {
  const zipRoot = makeZipRoot('zip-auto-off');
  const { url, close } = await startServer({
    port: 0,
    precheckFn: async () => OK_PRECHECK,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile: path.join(tmp, 'state-off.json'),
    soulName: SOUL,
    auto: false,
    readReceiptFn: () => priorReceipt(),
  });
  try {
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.deepEqual(st.auto, { requested: false, eligible: false, reason: 'not_requested' });
    const refused = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, reason: 'not_requested' });
  } finally {
    await close();
  }
});

// The updater hands the installer the soul to update by setting
// IRIS_INSTALLER_SOUL_NAME (= the last folder name of plan.root) alongside
// IRIS_INSTALLER_AUTO. Without this the installer would fall back to its
// built-in default and update a different soul than the one the plan named --
// which on this development PC means the real one instead of a rehearsal.
test('auto: the soul to update comes from IRIS_INSTALLER_SOUL_NAME, not from a hardcoded root', async () => {
  const zipRoot = makeZipRoot('zip-auto-env');
  const before = process.env.IRIS_INSTALLER_SOUL_NAME;
  const seen = [];
  process.env.IRIS_INSTALLER_SOUL_NAME = 'ALPHA-FROM-ENV';
  let server;
  try {
    server = await startServer({
      port: 0,
      precheckFn: async () => OK_PRECHECK,
      zipRoot,
      nodeDir: path.join(tmp, 'node'),
      stateFile: path.join(tmp, 'state-env.json'),
      auto: true,
      // no soulName override: the env var is the only thing naming the soul
      readReceiptFn: (root) => { seen.push(root); return priorReceipt(); },
    });
    const st = await (await fetch(`${server.url}/api/state`)).json();
    assert.equal(st.auto.eligible, true);
    assert.equal(st.auto.name, 'ALPHA-FROM-ENV');
    assert.equal(st.auto.root, 'C:\\ALPHA-FROM-ENV');
  } finally {
    if (before === undefined) delete process.env.IRIS_INSTALLER_SOUL_NAME;
    else process.env.IRIS_INSTALLER_SOUL_NAME = before;
    if (server) await server.close();
  }
  // Which root was probed is the point; how many times is not (the startup
  // also asks detectSoulMode about the same folder).
  assert.deepEqual([...new Set(seen)], ['C:\\ALPHA-FROM-ENV'], 'eligibility was checked against the soul the env var names');
});

// ---------------------------------------------------------------------------
// Stale state (review round 2, critical 1). state.json is persistent
// (%LOCALAPPDATA%\IRIS-Installer\state.json), so an automatic update opens on
// whatever the last run left behind. The screen's enterAutoMode() returns early
// on `step:'done'`+autoResult.ok and on installError -- and by then the daemon
// is already shut down, so "the screen showed an old result" means "the person
// has no IRIS window". The server clears the run-specific fields before the
// screen ever reads them.
// ---------------------------------------------------------------------------

function writeStaleState(file, extra) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    step: 'done',
    zipRoot: 'C:\\somewhere-old',
    nodeDir: 'C:\\somewhere-old\\node',
    soul: { name: SOUL, root: `C:\\${SOUL}`, existing: 'soul' },
    install: { parts: { face: 'error', node: 'done' } },
    packageVersion: '2.0.0', // 1.4.4+: a saved state is resumed only by the package version that wrote it (makeZipRoot default)
    ...extra,
  }, null, 2), 'utf8');
}

test('auto: a previous update left step=done + autoResult -- the update still starts', async () => {
  const zipRoot = makeZipRoot('zip-stale-done');
  const stateFile = path.join(tmp, 'state-stale-done.json');
  writeStaleState(stateFile, {
    autoResult: { ok: true, from: '1.1.0', to: '1.2.0', relaunched: true, pid: 42 },
  });

  const store = receiptStore(priorReceipt());
  const engine = fakeSetupRunner();
  const { url, close } = await startServer({
    port: 0,
    precheckFn: async () => OK_PRECHECK,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile,
    soulName: SOUL,
    auto: true,
    readReceiptFn: store.readReceiptFn,
    writeReceiptFn: store.writeReceiptFn,
    setupRunner: engine.runner,
    relaunchFaceFn: () => ({ ok: true, how: 'wscript', pid: 778 }),
    finishFn: () => ({ ok: true }),
    onQuit: () => {},
  });

  try {
    // What the screen reads before it decides anything: nothing that would
    // make enterAutoMode() render the old success instead of calling
    // startAuto().
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.equal(st.auto.eligible, true);
    assert.notEqual(st.step, 'done', 'a fresh update must not open on the previous run\'s "done"');
    assert.equal(st.step, 'precheck');
    assert.equal(st.autoResult, null, 'the previous run\'s result must not be replayed');
    assert.equal(st.installError, null);
    assert.equal(st.install, null, 'the previous run\'s part badges must not be rendered');
    // and this run's zipRoot won, not the old one recorded in the file
    assert.equal(st.zipRoot, zipRoot);

    // the run the screen would now start really does start
    const started = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 202);
    const end = await waitForStep(url, 'done');
    assert.equal(end.autoResult.ok, true);
    assert.equal(end.autoResult.to, '2.0.0', 'the new result replaced the stale one');
    assert.equal(engine.calls.length, 1);
  } finally {
    await close();
  }

  // the cleared state is persisted, not only held in memory -- a browser that
  // refreshes before POST /api/auto reads the file, not the old object
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(onDisk.autoResult.to, '2.0.0');
});

test('auto: a first install that failed long ago left installError -- the update still starts', async () => {
  const zipRoot = makeZipRoot('zip-stale-error');
  const stateFile = path.join(tmp, 'state-stale-error.json');
  writeStaleState(stateFile, { step: 'install', installError: 'payload-missing' });

  const store = receiptStore(priorReceipt());
  const engine = fakeSetupRunner();
  const { url, close } = await startServer({
    port: 0,
    precheckFn: async () => OK_PRECHECK,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile,
    soulName: SOUL,
    auto: true,
    readReceiptFn: store.readReceiptFn,
    writeReceiptFn: store.writeReceiptFn,
    setupRunner: engine.runner,
    relaunchFaceFn: () => ({ ok: true, how: 'wscript', pid: 779 }),
    finishFn: () => ({ ok: true }),
    onQuit: () => {},
  });

  try {
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.equal(st.auto.eligible, true);
    assert.equal(st.installError, null, 'an old failure must not be shown as this update\'s failure');
    assert.equal(st.step, 'precheck');
    assert.equal(st.autoResult, null);

    const started = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 202);
    const end = await waitForStep(url, 'done');
    assert.equal(end.autoResult.ok, true);
    assert.equal(engine.calls.length, 1);
  } finally {
    await close();
  }
});

// The ordinary (non-automatic) wizard still resumes where it left off: the
// clearing above is guarded by auto.eligible, because there a leftover step is
// exactly what a refresh is supposed to restore.
test('auto: without the flag a leftover step/installError is still restored (the wizard resumes)', async () => {
  const zipRoot = makeZipRoot('zip-stale-wizard');
  const stateFile = path.join(tmp, 'state-stale-wizard.json');
  writeStaleState(stateFile, { step: 'install', installError: 'payload-missing' });

  const { url, close } = await startServer({
    port: 0,
    precheckFn: async () => OK_PRECHECK,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile,
    soulName: SOUL,
    auto: false,
    readReceiptFn: () => priorReceipt(),
  });
  try {
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.equal(st.auto.eligible, false);
    assert.equal(st.step, 'install');
    assert.equal(st.installError, 'payload-missing');
    assert.deepEqual(st.install.parts, { face: 'error', node: 'done' });
  } finally {
    await close();
  }
});

test('auto: 엔진이 멈추면 그 단계 이름으로 멈춤을 적고, 창은 그래도 다시 연다', async () => {
  const zipRoot = makeZipRoot('zip-auto-fail');
  const store = receiptStore(priorReceipt());
  const relaunchCalls = [];
  const engine = fakeSetupRunner({
    ok: false,
    failed: { id: 'unpack', code: 'E-UNPACK', message: '부품 "face" 을(를) 푸는 중 문제가 생겼습니다.' },
  });
  const { url, close } = await startServer({
    port: 0,
    precheckFn: async () => OK_PRECHECK,
    zipRoot,
    nodeDir: path.join(tmp, 'node'),
    stateFile: path.join(tmp, 'state-fail.json'),
    soulName: SOUL,
    auto: true,
    readReceiptFn: store.readReceiptFn,
    writeReceiptFn: store.writeReceiptFn,
    setupRunner: engine.runner,
    relaunchFaceFn: (opts) => { relaunchCalls.push(opts); return { ok: true }; },
    finishFn: () => { throw new Error('finish must not run after a failure'); },
    onQuit: () => {},
  });
  try {
    const started = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 202);

    let st;
    for (let i = 0; i < 200; i++) {
      st = await (await fetch(`${url}/api/state`)).json();
      if (st.autoResult) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(st.autoResult.ok, false);
    assert.equal(st.autoResult.where, 'unpack');
    assert.equal(st.autoResult.reason, 'E-UNPACK');
    assert.equal(st.installError, 'E-UNPACK');
    assert.equal(st.step, 'auto', 'a failed run must not claim to be done');
    assert.equal(store.state.receipt.package.version, '1.9.0', '멈춘 업데이트는 판을 새 것으로 적지 않는다');

    // 설계 4-5 (review round 2, important 3): the updater already shut the
    // daemon down, so a failure with no relaunch leaves the person with no
    // window at all. The unpack stage rolled the failed part back to .prev, so
    // the window that reopens is the one that worked before the update.
    assert.equal(relaunchCalls.length, 1, 'a failed update still reopens the window');
    assert.equal(relaunchCalls[0].root, `C:\\${SOUL}`);
    assert.equal(st.autoResult.relaunched, true);

    const frames = await readBufferedEvents(url);
    const terminal = frames.filter((f) => f.done);
    assert.equal(terminal.length, 1, 'still exactly one terminal frame');
    assert.equal(terminal[0].error, 'E-UNPACK');
    const relaunchFrame = frames.filter((f) => f.part === 'relaunch');
    assert.equal(relaunchFrame.length, 1);
    assert.equal(relaunchFrame[0].status, 'done');
  } finally {
    await close();
  }
});
