import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, detectSoulMode, resumeVerdict, resumeSetupError } from '../installer/server.mjs';
import { saveState, initialState } from '../installer/lib/state.mjs';
import { SETUP_STAGE_IDS } from '../installer/lib/receipt.mjs';

// v2 상태기계의 "어디서 다시 열리는가": 같은 판/다른 판 재실행, `--resume`,
// `--auto` + 1.x 영수증, 그리고 영혼 폴더 4가지 상태(soul.mode).
//
// 이 파일은 진짜 C:\ 아래를 읽지도 쓰지도 않는다 — 모든 서버는 `soulRoot`
// 시험 이음매로 임시 폴더를 영혼 루트 삼고, 영수증은 주입한다.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-server-state-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const nodeDir = path.dirname(process.execPath);

function fakeZip(name, version, guideVersion = '2') {
  const zr = path.join(tmp, name);
  fs.mkdirSync(path.join(zr, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(zr, 'payload', 'manifest.json'),
    JSON.stringify({ schema: 1, package: { name: 'IRIS', version, guideVersion }, parts: {} }), 'utf8');
  fs.writeFileSync(path.join(zr, 'lock.json'),
    JSON.stringify({ schema: 1, package: { version }, parts: { face: { kind: 'dir', file: 'face/iris-face.zip' } } }), 'utf8');
  return zr;
}

function v2Receipt({ setup = {}, online = {}, choice = { subscriptions: ['claude'], leadAgent: 'claude' } } = {}) {
  return {
    schema: 2,
    package: { name: 'IRIS', version: '2.0.0' },
    soul: { root: '<soul>', name: 'IRIS', createdBy: 'iris-installer' },
    choice,
    precheck: { recorded: {}, at: '2026-09-15T00:00:00.000Z' },
    decisionsPath: '<soul>\\_agent\\setup\\decisions.json',
    setup,
    online,
    installed: {},
    login: {},
    steps: {},
  };
}

const allStagesDone = Object.fromEntries(SETUP_STAGE_IDS.map((id) => [id, { status: 'done' }]));

// ---------------------------------------------------------------------------
// soul.mode -- 4경우
// ---------------------------------------------------------------------------
test('soul.mode: empty · iris · iris-legacy · foreign', () => {
  const mk = (name, build) => {
    const root = path.join(tmp, 'mode', name);
    fs.mkdirSync(root, { recursive: true });
    build(root);
    return root;
  };

  // ⓐ empty -- 없는 폴더도, 빈 폴더도 'empty'
  assert.equal(detectSoulMode(path.join(tmp, 'mode', 'nope-never-created')), 'empty');
  assert.equal(detectSoulMode(mk('empty', () => {})), 'empty');

  // ⓑ iris -- v2 영수증
  const irisRoot = mk('iris', (root) => {
    fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
    fs.writeFileSync(path.join(root, '_agent', 'setup', 'package-receipt.json'), JSON.stringify(v2Receipt()), 'utf8');
  });
  assert.equal(detectSoulMode(irisRoot), 'iris');

  // ⓒ iris-legacy -- 1.x 영수증
  const legacyRoot = mk('legacy', (root) => {
    fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
    fs.writeFileSync(path.join(root, '_agent', 'setup', 'package-receipt.json'),
      JSON.stringify({ schema: 1, package: { version: '1.4.5' } }), 'utf8');
  });
  assert.equal(detectSoulMode(legacyRoot), 'iris-legacy');

  // ⓒ' iris-legacy -- 영수증 없이 soul-state.json 만 (설치기 이전의 영혼)
  const soulStateRoot = mk('soulstate', (root) => {
    fs.writeFileSync(path.join(root, 'soul-state.json'), '{}', 'utf8');
  });
  assert.equal(detectSoulMode(soulStateRoot), 'iris-legacy');

  // ⓓ foreign -- IRIS 표시가 없는데 비어 있지 않다
  const foreignRoot = mk('foreign', (root) => {
    fs.writeFileSync(path.join(root, '세금계산서.xlsx'), 'x', 'utf8');
  });
  assert.equal(detectSoulMode(foreignRoot), 'foreign');

  // ⓐ' 우리가 만든 것뿐이면 여전히 'empty' -- 위치를 확인한 순간부터 설치기는
  // <root>\_agent\setup\installer.log 에 로그를 남기므로, 거기서 멈춘 뒤 다시
  // 열었을 때 자기 로그를 "남의 자료"로 읽고 스스로를 막으면 안 된다.
  const ownLogOnly = mk('own-log', (root) => {
    fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
    fs.writeFileSync(path.join(root, '_agent', 'setup', 'installer.log'), 'x', 'utf8');
  });
  assert.equal(detectSoulMode(ownLogOnly), 'empty');

  // 우리 것 + 남의 것이 섞여 있으면 남의 것이 이긴다
  const mixed = mk('mixed', (root) => {
    fs.mkdirSync(path.join(root, '_agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '세금계산서.xlsx'), 'x', 'utf8');
  });
  assert.equal(detectSoulMode(mixed), 'foreign');
});

test('locate 를 두 번 눌러도 자기 로그 때문에 막히지 않는다 (재실행 가능)', async () => {
  const soulRoot = path.join(tmp, 'soul-relocate');
  const zr = fakeZip('zip-relocate', '2.0.0');
  const opts = {
    port: 0, zipRoot: zr, nodeDir, soulRoot, workDir: path.join(tmp, 'logs-relocate'),
    precheckFn: async () => ({ blockers: [], warnings: [], info: {}, recorded: {} }),
  };
  const s1 = await startServer({ ...opts, stateFile: path.join(tmp, 'state-relocate-1.json') });
  const first = await (await fetch(`${s1.url}/api/locate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(first.ok, true);
  assert.equal(first.mode, 'empty');
  await s1.close();
  assert.ok(fs.existsSync(path.join(soulRoot, '_agent', 'setup', 'installer.log')), '위치 확인 뒤 로그가 영혼 안에도 남는다');

  const s2 = await startServer({ ...opts, stateFile: path.join(tmp, 'state-relocate-2.json') });
  const second = await (await fetch(`${s2.url}/api/locate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(second.ok, true, '두 번째 실행이 제 로그에 막히면 안 된다');
  assert.equal(second.mode, 'empty');
  await s2.close();
});

// ---------------------------------------------------------------------------
// 재실행 판정 (순수 함수)
// ---------------------------------------------------------------------------
test('resumeVerdict: 3경우 (setup 완료+online 미완 → online / 전부 done → done / decisions.json 만 → summary)', () => {
  const root = path.join(tmp, 'verdict');
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });

  // ⓐ setup 전부 done, online 미완
  assert.deepEqual(
    resumeVerdict(root, { readReceiptFn: () => v2Receipt({ setup: allStagesDone }) }),
    { step: 'online', reason: 'setup-done' },
  );

  // ⓑ 전부 done
  assert.deepEqual(
    resumeVerdict(root, { readReceiptFn: () => v2Receipt({ setup: allStagesDone, online: { completed: true } }) }),
    { step: 'done', reason: 'all-done' },
  );

  // ⓒ 영수증 없이 decisions.json 만
  fs.writeFileSync(path.join(root, '_agent', 'setup', 'decisions.json'),
    JSON.stringify({ schema: 1, later: false, nodes: [] }), 'utf8');
  assert.deepEqual(
    resumeVerdict(root, { readReceiptFn: () => null }),
    { step: 'summary', reason: 'decisions-only' },
  );

  // 중간에 멈춘 setup 은 setup 부터
  assert.deepEqual(
    resumeVerdict(root, { readReceiptFn: () => v2Receipt({ setup: { unpack: { status: 'done' }, env: { status: 'failed', code: 'E-ENV' } } }) }),
    { step: 'setup', reason: 'setup-partial' },
  );

  // 1.x 영수증은 v2 재개 대상이 아니다 (decisions.json 이 있으므로 summary 로 떨어진다)
  assert.deepEqual(
    resumeVerdict(root, { readReceiptFn: () => ({ schema: 1 }) }),
    { step: 'summary', reason: 'decisions-only' },
  );

  // 아무것도 없으면 판정 없음
  assert.equal(resumeVerdict(path.join(tmp, 'verdict-empty'), { readReceiptFn: () => null }), null);
});

// 2026-09-17 실제 사용자: 2.0.0 이 venv 에서 멈춘 PC 에 2.0.1 → 'setup' 으로 재개했지만 새 상태에
// error 가 없어 화면이 단추 없이 「진행중」으로 섰다. 영수증의 실패 단계를 error 로 옮겨 적는다.
test('resumeSetupError: 영수증의 실패 단계를 새 상태의 error 로 옮긴다 (없으면 null, 1.x 는 null)', () => {
  const r = resumeSetupError(v2Receipt({ setup: { unpack: { status: 'done' }, env: { status: 'done' }, venv: { status: 'failed', code: 'E-VENV', message: '문서 자동화 venv …' } } }));
  assert.deepEqual(r.stage, 'venv');
  assert.equal(r.error.id, 'venv');
  assert.equal(r.error.code, 'E-VENV');
  assert.equal(resumeSetupError(v2Receipt({ setup: { unpack: { status: 'done' } } })), null);
  assert.equal(resumeSetupError({ schema: 1 }), null);
  assert.equal(resumeSetupError(null), null);
});

// ---------------------------------------------------------------------------
// 재실행: 같은 판은 이어감, 다른 판은 precheck 부터
// ---------------------------------------------------------------------------
test('saved progress: 다른 판이면 버리고 precheck 부터, 같은 판이면 그 자리에서 이어간다', async () => {
  const stateFile = path.join(tmp, 'state-pkg.json');
  const zrNew = fakeZip('zip-new', '2.0.0');
  // 영혼 루트는 임시 폴더 — C:\ 아래에는 아무것도 만들지 않는다.
  const soulRoot = path.join(tmp, 'soul-pkg');
  const workDir = path.join(tmp, 'logs-pkg');

  // 옛 판의 저장 상태 위에 새 판 zip → 처음부터
  saveState(stateFile, { ...initialState({ zipRoot: 'C:\\old', nodeDir }), step: 'summary', packageVersion: '1.4.5' });
  const s1 = await startServer({ port: 0, zipRoot: zrNew, nodeDir, stateFile, soulRoot, workDir });
  const h1 = await (await fetch(`${s1.url}/api/health`)).json();
  assert.equal(h1.version, '2.0.0');
  assert.equal(h1.step, 'precheck', '다른 판은 옛 진행을 이어받지 않는다');
  const saved1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved1.packageVersion, '2.0.0');
  await s1.close();

  // 같은 판 (새로고침 / 같은 zip 재실행) → 그 자리에서 이어간다
  saveState(stateFile, { ...initialState({ zipRoot: zrNew, nodeDir, packageVersion: '2.0.0' }), step: 'structure' });
  const s2 = await startServer({ port: 0, zipRoot: zrNew, nodeDir, stateFile, soulRoot, workDir });
  assert.equal((await (await fetch(`${s2.url}/api/health`)).json()).step, 'structure');
  await s2.close();

  // packageVersion 이 아예 없는 옛 상태 파일(1.4.3 이하)도 남의 것으로 본다
  saveState(stateFile, { step: 'summary', zipRoot: zrNew, nodeDir });
  const s3 = await startServer({ port: 0, zipRoot: zrNew, nodeDir, stateFile, soulRoot, workDir });
  assert.equal((await (await fetch(`${s3.url}/api/health`)).json()).step, 'precheck');
  await s3.close();
});

// ---------------------------------------------------------------------------
// --resume (Face 「설치 이어하기」)
// ---------------------------------------------------------------------------
test('--resume: 영수증 판정을 강제 적용한다 (online · done · summary)', async () => {
  const zr = fakeZip('zip-resume', '2.0.0');
  const soulRoot = path.join(tmp, 'soul-resume');
  const workDir = path.join(tmp, 'logs-resume');

  const cases = [
    { want: 'online', receipt: () => v2Receipt({ setup: allStagesDone }) },
    { want: 'done', receipt: () => v2Receipt({ setup: allStagesDone, online: { completed: true } }) },
  ];
  for (const c of cases) {
    const stateFile = path.join(tmp, `state-resume-${c.want}.json`);
    // 저장된 상태는 한참 앞(structure)에 있지만 --resume 이 영수증을 이긴다
    saveState(stateFile, { ...initialState({ zipRoot: zr, nodeDir, packageVersion: '2.0.0' }), step: 'structure' });
    const s = await startServer({
      port: 0, zipRoot: zr, nodeDir, stateFile, soulRoot, workDir, resume: true, readReceiptFn: c.receipt,
    });
    const st = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(st.step, c.want, `--resume 은 ${c.want} 로 열려야 한다`);
    assert.equal(st.resume.forced, true);
    await s.close();
  }

  // ⓒ 영수증 없이 decisions.json 만 → summary (그 답안을 그대로 다시 읽는다)
  const decisionsRoot = path.join(tmp, 'soul-resume-decisions');
  const decisions = { schema: 1, later: false, nodes: [], deferred: ['S', 'T', 'tags'], nameEnMissing: [] };
  fs.mkdirSync(path.join(decisionsRoot, '_agent', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(decisionsRoot, '_agent', 'setup', 'decisions.json'), JSON.stringify(decisions), 'utf8');
  const sumState = path.join(tmp, 'state-resume-summary.json');
  saveState(sumState, { ...initialState({ zipRoot: zr, nodeDir, packageVersion: '2.0.0' }), step: 'structure' });
  const sum = await startServer({
    port: 0, zipRoot: zr, nodeDir, stateFile: sumState, soulRoot: decisionsRoot, workDir, resume: true, readReceiptFn: () => null,
  });
  const sumSt = await (await fetch(`${sum.url}/api/state`)).json();
  assert.equal(sumSt.step, 'summary');
  assert.equal(sumSt.resume.reason, 'decisions-only');
  assert.deepEqual(sumSt.decisions, decisions, '적어 둔 답안을 그대로 다시 읽는다');
  await sum.close();

  // 이어갈 것이 없으면 --resume 은 저장된 자리를 그대로 둔다
  const noneState = path.join(tmp, 'state-resume-none.json');
  saveState(noneState, { ...initialState({ zipRoot: zr, nodeDir, packageVersion: '2.0.0' }), step: 'structure' });
  const none = await startServer({
    port: 0, zipRoot: zr, nodeDir, stateFile: noneState, soulRoot: path.join(tmp, 'soul-resume-none'), workDir, resume: true, readReceiptFn: () => null,
  });
  const noneSt = await (await fetch(`${none.url}/api/state`)).json();
  assert.equal(noneSt.step, 'structure');
  assert.equal(noneSt.resume.reason, 'nothing-to-resume');
  await none.close();
});

// ---------------------------------------------------------------------------
// --auto (업데이터)
// ---------------------------------------------------------------------------
test('--auto + 1.x 영수증 → reinstall-required, 아무것도 바꾸지 않는다', async () => {
  const zr = fakeZip('zip-auto-legacy', '2.0.0');
  const stateFile = path.join(tmp, 'state-auto-legacy.json');
  const s = await startServer({
    port: 0,
    zipRoot: zr,
    nodeDir,
    stateFile,
    soulRoot: path.join(tmp, 'soul-legacy'),
    workDir: path.join(tmp, 'logs-legacy'),
    auto: true,
    readReceiptFn: () => ({ schema: 1, package: { version: '1.4.5' } }),
    relaunchFaceFn: () => { throw new Error('relaunch must not run'); },
  });
  try {
    const st = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(st.step, 'reinstall-required');
    assert.equal(st.auto.requested, true);
    assert.equal(st.auto.eligible, false);
    assert.equal(st.auto.reason, 'legacy_receipt');
    assert.equal(st.auto.schema, 1);

    // 1.x 위에서는 부품 교체 자체를 시작하지 않는다 — 러너가 도는지는 서버가
    // POST 를 거부하는 것으로 확인한다(Task 24b #5: 더 이상 받지 않는
    // `installFn` 주입·그 호출 횟수 검사는 죽은 시험이라 걷어냈다).
    const refused = await fetch(`${s.url}/api/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, reason: 'legacy_receipt' });
  } finally {
    await s.close();
  }
});

test('--auto + v2 영수증 → auto 카드(기존 부품 교체 흐름) 유지', async () => {
  const zr = fakeZip('zip-auto-v2', '2.0.1');
  const stateFile = path.join(tmp, 'state-auto-v2.json');
  const s = await startServer({
    port: 0,
    zipRoot: zr,
    nodeDir,
    stateFile,
    soulRoot: path.join(tmp, 'soul-auto'),
    workDir: path.join(tmp, 'logs-auto'),
    auto: true,
    readReceiptFn: () => v2Receipt(),
  });
  try {
    const st = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(st.auto.eligible, true);
    assert.equal(st.auto.from, '2.0.0');
    assert.equal(st.auto.to, '2.0.1');
    assert.equal(st.step, 'precheck', 'auto 는 POST /api/auto 가 step 을 auto 로 옮긴다');
    assert.equal((await (await fetch(`${s.url}/api/health`)).json()).auto, true);
  } finally {
    await s.close();
  }
});
