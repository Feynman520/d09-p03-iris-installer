// 2.0.66 — 설치 화면의 「1년 열쇠 받기(권장)」 카드 뒤편(installer/lib/longkey.mjs, online.mjs 가 다시 내보낸다).
// 받는 것은 IRIS 창 세션용 1년 열쇠 하나다 — 도구의 기존 길(계정 인자 없음)을 그대로 띄운다. 중계기 설정은 쓰지 않는다.
//
// 실제 계정 · 실제 로그인 · 네트워크 0. 띄우는 프로그램은 가짜다:
//   · 대부분은 가짜 자식(EventEmitter)을 끼워 표준 출력 줄을 손으로 흘려보낸다.
//   · 끝의 세 시험만 진짜 node 로 **가짜 도구 파일**(임시 폴더에 쓴 몇 줄짜리 스크립트)을 띄워 파이프 · "자기 PID 만 끝내기" ·
//     "서버가 죽으면 자식도 끝난다"를 본다.
// 진짜 중계기 설정 · 진짜 로그인 파일은 읽지도 쓰지도 않는다(전부 임시 영혼 폴더).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  startLongKey, longKeyStatus, stopLongKey, longKeyAvailability,
} from '../installer/lib/online.mjs';
import {
  parseLongKeyResult, longKeyMessage, longKeyToolPath, resetLongKey,
  LONGKEY_APPROVE_SEC, LONGKEY_HARD_LIMIT_MS,
} from '../installer/lib/longkey.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-online-longkey-'));
after(() => { resetLongKey(); fs.rmSync(tmp, { recursive: true, force: true }); });

// 도구가 찍는 승인 주소(계정 인자를 넘기지 않으므로 계정 귀띔 칸이 없다).
const APPROVE_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Fcallback&scope=user%3Ainference&code_challenge=c&code_challenge_method=S256&state=STATE-VALUE';
const OWNER = 'owner@localhost';   // 도구의 RESULT 에 실려 오는 계정 이름 — 밖으로 나가면 안 되는 글자
const YEAR_MS = 365 * 86400000;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
/** 임시 영혼: 도구 파일(빈 자리표) · 동봉 node 자리 · 중계기 설정(이 모듈이 건드리면 안 되는 파일). */
function makeSoul(label, { tool = '// placeholder\n', node = true } = {}) {
  const root = path.join(tmp, `${label}-${++seq}`);
  const nodeDir = path.join(root, '_agent', 'shared', 'tools', 'node');
  const configPath = path.join(root, '_agent', 'shared', 'portable-state', 'teamclaude', 'teamclaude.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.join(root, '_agent', 'claude'), { recursive: true });
  fs.mkdirSync(nodeDir, { recursive: true });
  if (node) fs.writeFileSync(path.join(nodeDir, 'node.exe'), 'not a real node');
  if (tool != null) { fs.mkdirSync(path.dirname(longKeyToolPath(root)), { recursive: true }); fs.writeFileSync(longKeyToolPath(root), tool); }
  fs.writeFileSync(configPath, `${JSON.stringify({ proxy: { port: 3456, apiKey: 'tc-K' }, accounts: [
    { name: 'codex-1', type: 'oauth', provider: 'codex', importFrom: 'x' },
    { name: OWNER, type: 'oauth', source: 'import', accessToken: 'A', refreshToken: 'R', expiresAt: 1 },
    { name: 'second@localhost', type: 'oauth', accessToken: 'A2', refreshToken: 'R2', expiresAt: 2 },
  ] }, null, 2)}\n`);
  return { root, nodeDir, configPath };
}

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/** 가짜 자식으로 한 번 띄운다. */
function launch(soul, over = {}) {
  const spawns = []; const kills = []; const logs = []; const finishes = [];
  const child = over.child ?? fakeChild();
  const r = startLongKey({
    root: soul.root, nodeDir: soul.nodeDir,
    spawnFn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return child; },
    killFn: (pid) => { kills.push(pid); },
    log: (l) => logs.push(l), onFinish: (x) => finishes.push(x),
    env: { PATH: 'p', IRIS_LONGKEY_FILE: 'should-be-removed', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456', TEAMCLAUDE_CONFIG: 'left-as-is' },
    ...over,
  });
  return { r, child, spawns, kills, logs, finishes };
}

/** 폴더 전체의 지문(상대 경로 → sha256). "아무 파일도 쓰지 않았다"를 바이트로 본다. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(dir);
  return out;
}
const okResult = (expiresAt) => `RESULT {"ok":true,"email":"${OWNER}","expiresAt":${expiresAt},"expiresIn":31536000,"scope":"user:inference"}\n`;

// ---------------------------------------------------------------------------
// 카드를 낼 수 있는가(읽기만)
// ---------------------------------------------------------------------------
test('카드를 낼 수 있는가: 도구와 동봉 node 가 있으면 된다 — 클로드 계정 줄이 여럿이어도 가리지 않는다(계정을 고르지 않는다)', () => {
  const ok = makeSoul('avail-ok');
  assert.deepEqual(longKeyAvailability({ root: ok.root, nodeDir: ok.nodeDir }), { available: true, reason: null });
  const noTool = makeSoul('avail-notool', { tool: null });
  assert.deepEqual(longKeyAvailability({ root: noTool.root, nodeDir: noTool.nodeDir }), { available: false, reason: 'no-tool' });
  const noNode = makeSoul('avail-nonode', { node: false });
  assert.deepEqual(longKeyAvailability({ root: noNode.root, nodeDir: noNode.nodeDir }), { available: false, reason: 'no-node' });
  assert.deepEqual(longKeyAvailability({}), { available: false, reason: 'no-root' });
});

test('카드를 누르지 않으면 아무 파일도 쓰지 않고 프로그램도 띄우지 않는다(조회는 파일이 있는지만 본다)', () => {
  const s = makeSoul('readonly');
  const before = snapshot(s.root);
  for (let i = 0; i < 5; i++) {
    longKeyAvailability({ root: s.root, nodeDir: s.nodeDir });
    assert.equal(longKeyStatus({ root: s.root }).state, 'idle');
  }
  assert.deepEqual(stopLongKey({ root: s.root }), { stopped: false }, '띄운 적이 없으면 끝낼 것도 없다');
  assert.deepEqual(snapshot(s.root), before);
});

test('이 모듈은 중계기 설정을 읽지도 쓰지도 않는다 — 소스에 그 파일 이름 · 다시 읽기 부탁 · 두 자리 쓰기 인자가 없다', () => {
  const src = fs.readFileSync(path.join(REPO, 'installer', 'lib', 'longkey.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
  for (const bad of ['teamclaude', 'TEAMCLAUDE_CONFIG', '/reload', '--also-iris', '--account', '--hint', 'readFileSync', 'writeFileSync', 'fetch(']) {
    assert.ok(!code.includes(bad), `lib/longkey.mjs 의 코드에 ${bad} 가 있으면 안 된다`);
  }
});

// ---------------------------------------------------------------------------
// 「받기」 — 띄우는 꼴 · 상태 흐름
// ---------------------------------------------------------------------------
test('받기: 동봉 node 로 설치본의 도구를 창 없이 띄운다 — IRIS 창이 띄우는 꼴(계정 인자 없음)에 기다림 한도만', () => {
  const s = makeSoul('spawn');
  const { r, spawns } = launch(s);
  assert.deepEqual(r, { ok: true, state: 'starting', already: false });
  assert.equal(spawns.length, 1);
  const { cmd, args, opts } = spawns[0];
  assert.equal(cmd, path.join(s.nodeDir, 'node.exe'));
  assert.deepEqual(args, [longKeyToolPath(s.root), '--timeout', String(LONGKEY_APPROVE_SEC)]);
  for (const no of ['--account', '--also-iris', '--hint', '--private', '--no-open', '--scope']) assert.ok(!args.includes(no), `${no} 를 넘기지 않는다`);
  assert.ok(!args.join(' ').includes('@'), '계정 이름을 인자로 넘기지 않는다');
  assert.equal(opts.windowsHide, true, '검은 창을 띄우지 않는다');
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(opts.detached, undefined, '설치기에 딸린 프로그램으로 띄운다(설치기가 죽으면 함께 끝난다)');
  assert.equal(opts.env.CLAUDE_CONFIG_DIR, path.join(s.root, '_agent', 'claude'), '열쇠는 이 영혼의 자리에 쓰인다');
  assert.equal('IRIS_LONGKEY_FILE' in opts.env, false, '다른 자리를 가리키는 변수는 넘기지 않는다');
  assert.equal(opts.env.NODE_USE_SYSTEM_CA, '1', '윈도우 인증서도 믿는다(2.0.62)');
  assert.equal(opts.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456', '중계기 주소 변수는 건드리지 않는다');
  assert.equal(opts.env.TEAMCLAUDE_CONFIG, 'left-as-is', '중계기 설정 자리를 정해 주지도 바꾸지도 않는다(그 길을 쓰지 않는다)');
  assert.ok(LONGKEY_HARD_LIMIT_MS > LONGKEY_APPROVE_SEC * 1000, '이쪽 한도는 도구의 기다림보다 길다(도구가 먼저 스스로 끝난다)');
  stopLongKey({ root: s.root });
});

test('받기: 사용자가 정한 NODE_USE_SYSTEM_CA 는 덮지 않는다', () => {
  const s = makeSoul('ca');
  const { spawns } = launch(s, { env: { NODE_USE_SYSTEM_CA: '0' } });
  assert.equal(spawns[0].opts.env.NODE_USE_SYSTEM_CA, '0');
  stopLongKey({ root: s.root });
});

test('정적 검사 ㉒ 가 보는 줄이 소스에 그대로 있다(이 줄이 바뀌면 verify/static.mjs 의 ㉒ 도 함께 바꾼다)', () => {
  const line = "if (childEnv.NODE_USE_SYSTEM_CA == null || childEnv.NODE_USE_SYSTEM_CA === '') childEnv.NODE_USE_SYSTEM_CA = '1';";
  assert.ok(fs.readFileSync(path.join(REPO, 'installer', 'lib', 'longkey.mjs'), 'utf8').includes(line));
  assert.ok(fs.readFileSync(path.join(REPO, 'verify', 'static.mjs'), 'utf8').includes(line), '정적 검사도 같은 줄을 찾는다');
});

test('상태 흐름: 띄움 → 승인 대기(주소) → 끝남. 끝나면 주소를 더 내지 않고, 끝남 알림은 한 번', async () => {
  const s = makeSoul('flow');
  const before = fs.readFileSync(s.configPath);
  const { child, finishes, kills } = launch(s, { lingerMs: 20 });
  assert.equal(longKeyStatus({ root: s.root }).state, 'starting');
  assert.equal(longKeyStatus({ root: s.root }).url, null);

  child.stdout.emit('data', '브라우저에서 IRIS 1년 열쇠 발급을 승인해 주세요.\n브라우저가 안 열리면 이 주소를 여세요:\n');
  child.stdout.emit('data', `${APPROVE_URL}\n`);
  const waiting = longKeyStatus({ root: s.root });
  assert.equal(waiting.state, 'approve');
  assert.equal(waiting.url, APPROVE_URL);
  assert.match(waiting.message, /승인/);
  const u = new URL(waiting.url);
  assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+\/callback$/, '승인 뒤 이 PC 로 돌아온다');
  for (const k of ['access_token', 'refresh_token', 'token', 'code_verifier', 'login_hint']) assert.equal(u.searchParams.get(k), null, `승인 주소에 ${k} 없음`);

  const expiresAt = Date.now() + YEAR_MS;
  // RESULT 줄이 두 조각으로 나뉘어 와도 한 줄로 읽는다.
  const line = okResult(expiresAt);
  child.stdout.emit('data', `발급 완료: ${OWNER} · 만료 …\n${line.slice(0, 30)}`);
  assert.equal(longKeyStatus({ root: s.root }).state, 'approve', '줄이 끝나기 전에는 판정하지 않는다');
  child.stdout.emit('data', line.slice(30));
  const done = longKeyStatus({ root: s.root });
  assert.equal(done.state, 'done');
  assert.equal(done.expiresAt, expiresAt);
  assert.equal(done.url, null, '끝난 뒤에는 승인 주소를 내지 않는다');
  assert.match(done.message, /1년 열쇠를 받았습니다\(만료 \d{4}-\d{2}-\d{2}\)/);
  assert.ok(!JSON.stringify(done).includes(OWNER), '도구가 알려 준 계정 이름은 상태에 싣지 않는다');
  assert.deepEqual(finishes, [{ state: 'done', expiresAt, reason: null }]);

  // 결과를 낸 프로그램이 스스로 끝나면 끝내지 않는다.
  child.emit('exit', 0); child.emit('close', 0);
  await tick(60);
  assert.deepEqual(kills, [], '스스로 끝난 프로그램은 건드리지 않는다');
  assert.equal(finishes.length, 1, '끝남 알림은 한 번');
  assert.ok(fs.readFileSync(s.configPath).equals(before), '중계기 설정은 한 바이트도 바뀌지 않는다');
});

test('끝났다는 신호(exit)가 마지막 출력보다 먼저 와도 결과를 놓치지 않는다 — 실패 확정은 출력이 닫힌 뒤(close)', async () => {
  // exit → RESULT → close: 성공으로 읽는다.
  const a = makeSoul('exit-first');
  const one = launch(a, { exitGraceMs: 5000 });
  const expiresAt = Date.now() + YEAR_MS;
  one.child.emit('exit', 0);
  assert.equal(longKeyStatus({ root: a.root }).state, 'starting', 'exit 만으로는 실패로 치지 않는다');
  assert.deepEqual(one.finishes, []);
  one.child.stdout.emit('data', okResult(expiresAt));
  assert.equal(longKeyStatus({ root: a.root }).state, 'done');
  one.child.emit('close', 0);
  await tick(30);
  assert.deepEqual(one.finishes, [{ state: 'done', expiresAt, reason: null }], '뒤늦은 close 가 결과를 뒤집지 않는다');
  assert.deepEqual(one.kills, [], '이미 끝난 프로그램을 끝내려 하지 않는다');

  // exit → close(결과 줄 없음): 그때 실패.
  const b = makeSoul('exit-close');
  const two = launch(b, { exitGraceMs: 5000 });
  two.child.emit('exit', 1);
  assert.deepEqual(two.finishes, []);
  two.child.emit('close', 1);
  assert.deepEqual(two.finishes, [{ state: 'failed', expiresAt: null, reason: 'exited' }]);

  // exit 뒤 close 가 끝내 오지 않으면 여유 시간이 지난 뒤 실패로 돌린다(영영 "띄우는 중"으로 남지 않는다).
  const c = makeSoul('exit-only');
  const three = launch(c, { exitGraceMs: 30 });
  three.child.emit('exit', 1);
  await tick(90);
  assert.deepEqual(three.finishes, [{ state: 'failed', expiresAt: null, reason: 'exited' }]);
});

test('끝난 뒤에도 프로그램이 남아 있으면 자기가 띄운 그 PID 만 끝낸다', async () => {
  const s = makeSoul('linger');
  const { child, kills } = launch(s, { child: fakeChild(7001), lingerMs: 20 });
  child.stdout.emit('data', okResult(Date.now() + YEAR_MS));
  await tick(80);
  assert.deepEqual(kills, [7001]);
});

test('두 번 눌러도 프로그램은 하나만 돈다 — 실패한 뒤 다시 누르면 새로 한 번', () => {
  const s = makeSoul('twice');
  const spawns = [];
  const children = [fakeChild(1), fakeChild(2)];
  const go = () => startLongKey({ root: s.root, nodeDir: s.nodeDir, spawnFn: (...a) => { spawns.push(a); return children[spawns.length - 1]; }, killFn: () => {} });
  assert.equal(go().already, false);
  assert.deepEqual(go(), { ok: true, state: 'starting', already: true });
  children[0].stdout.emit('data', `${APPROVE_URL}\n`);
  assert.deepEqual(go(), { ok: true, state: 'approve', already: true });
  assert.equal(spawns.length, 1, '돌고 있는 동안에는 더 띄우지 않는다');

  children[0].stdout.emit('data', '발급 실패: 시간 초과(승인 없음)\nRESULT {"ok":false,"error":"시간 초과(승인 없음)"}\n');
  assert.equal(longKeyStatus({ root: s.root }).state, 'failed');
  assert.equal(go().already, false);
  assert.equal(spawns.length, 2, '끝난 뒤에는 다시 띄울 수 있다');
  assert.equal(longKeyStatus({ root: s.root }).state, 'starting', '새 일의 상태로 바뀐다');
  stopLongKey({ root: s.root });
});

test('실패: 도구의 글에서 까닭 한 낱말만 고르고 글 자체는 밖으로 내지 않는다 — 화면 글은 "지금 로그인은 그대로"', () => {
  const cases = [
    ['시간 초과(승인 없음)', 'timeout', /시간이 지났습니다/],
    ['승인 거절(access_denied)', 'denied', /취소/],
    ['state 불일치 또는 코드 없음', 'denied', /취소/],
    ['수명이 30일로 짧게 발급됨(권한 user:inference) — 저장하지 않음', 'short-lived', /유효 기간이 짧은/],
    ['열쇠 교환 실패(HTTP 400): {"error":"SECRET-TEXT"}', 'exchange-failed', /받아 오지 못했습니다/],
    ['응답에 열쇠가 없음', 'exchange-failed', /받아 오지 못했습니다/],
    [`뜻밖의 오류 SECRET-TEXT ${OWNER}`, 'failed', /끝내지 못했습니다/],
  ];
  for (const [error, reason, re] of cases) {
    const s = makeSoul(`fail-${reason}`);
    const { child, finishes } = launch(s);
    child.stdout.emit('data', `발급 실패: ${error}\nRESULT ${JSON.stringify({ ok: false, error })}\n`);
    const st = longKeyStatus({ root: s.root });
    assert.equal(st.state, 'failed');
    assert.equal(st.reason, reason, error);
    assert.match(st.message, re);
    assert.match(st.message, /지금 로그인은 그대로/);
    assert.ok(!JSON.stringify(st).includes('SECRET-TEXT') && !JSON.stringify(st).includes(OWNER), '도구의 글 · 계정 이름은 상태에 싣지 않는다');
    assert.deepEqual(finishes, [{ state: 'failed', expiresAt: null, reason }]);
  }
  assert.equal(parseLongKeyResult('RESULT {not json}\n').state, 'failed', '읽을 수 없는 결과 줄은 실패로');
  assert.equal(parseLongKeyResult('아직 결과 줄 없음\n'), null);
  assert.deepEqual(parseLongKeyResult('RESULT {"ok":true,"expiresAt":"soon"}\n'), { state: 'done', expiresAt: null, reason: null }, '만료 시각을 못 읽어도 받은 것은 받은 것');
  assert.equal(Object.keys(parseLongKeyResult(okResult(5))).sort().join(), 'expiresAt,reason,state', '계정 칸 · 권한 칸은 받지 않는다');
});

test('화면 글: 받는 것은 IRIS 창의 열쇠라고만 말한다 — 중계기(계정 연결) 계정이 바뀐다는 말 · 장담하는 말이 없다', () => {
  const all = [
    longKeyMessage({ state: 'starting' }), longKeyMessage({ state: 'approve' }),
    longKeyMessage({ state: 'done', expiresAt: Date.now() + YEAR_MS }), longKeyMessage({ state: 'done' }),
    ...['timeout', 'denied', 'short-lived', 'exchange-failed', 'exited', 'stopped', 'no-tool', 'whatever'].map((reason) => longKeyMessage({ state: 'failed', reason })),
  ];
  for (const m of all) {
    assert.equal(typeof m, 'string');
    assert.doesNotMatch(m, /중계기|계정 연결|TeamClaude|1년 동안|나오지 않습니다|절대|영구/, m);
  }
  assert.match(longKeyMessage({ state: 'done' }), /IRIS 창의 새 대화부터/);
  assert.equal(longKeyMessage({ state: 'idle' }), null);
});

test('결과 없이 프로그램이 끝나면 실패 — 띄우지 못해도 실패(던지지 않는다)', () => {
  const a = makeSoul('exited');
  const one = launch(a);
  one.child.emit('exit', 1); one.child.emit('close', 1);
  assert.deepEqual({ state: longKeyStatus({ root: a.root }).state, reason: longKeyStatus({ root: a.root }).reason }, { state: 'failed', reason: 'exited' });
  assert.equal(one.finishes.length, 1);

  const b = makeSoul('spawn-throws');
  const r = startLongKey({ root: b.root, nodeDir: b.nodeDir, spawnFn: () => { throw new Error('EPERM'); } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'spawn-failed');
  assert.match(r.message, /지금 로그인은 그대로/);

  const c = makeSoul('no-tool', { tool: null });
  const spawned = [];
  const r2 = startLongKey({ root: c.root, nodeDir: c.nodeDir, spawnFn: () => { spawned.push(1); return fakeChild(); } });
  assert.deepEqual({ ok: r2.ok, reason: r2.reason }, { ok: false, reason: 'no-tool' });
  assert.equal(spawned.length, 0, '도구가 없으면 띄우지 않는다');
});

test('한도 시간: 넘기면 자기가 띄운 PID 만 끝내고 실패(시간 초과)로 돌린다', async () => {
  const s = makeSoul('limit');
  const { kills, finishes } = launch(s, { child: fakeChild(8080), hardLimitMs: 30 });
  await tick(90);
  assert.deepEqual(kills, [8080]);
  const st = longKeyStatus({ root: s.root });
  assert.deepEqual({ state: st.state, reason: st.reason }, { state: 'failed', reason: 'timeout' });
  assert.equal(finishes.length, 1);
});

test('설치 창이 닫힐 때: 자기가 띄운 PID 만 끝내고, 끝남 알림을 부르지 않는다(아무것도 적지 않는다)', () => {
  const s = makeSoul('stop');
  const { kills, finishes, child } = launch(s, { child: fakeChild(9090) });
  child.stdout.emit('data', `${APPROVE_URL}\n`);
  assert.deepEqual(stopLongKey({ root: s.root }), { stopped: true, pid: 9090 });
  assert.deepEqual(kills, [9090]);
  assert.deepEqual(finishes, [], '닫으며 끝낸 것은 결과로 적지 않는다');
  const st = longKeyStatus({ root: s.root });
  assert.deepEqual({ state: st.state, reason: st.reason, url: st.url }, { state: 'failed', reason: 'stopped', url: null });
  child.emit('exit', 1); child.emit('close', 1);
  assert.deepEqual(stopLongKey({ root: s.root }), { stopped: false, pid: null }, '이미 끝난 프로그램은 다시 끝내지 않는다');
  assert.deepEqual(kills, [9090]);
  assert.deepEqual(finishes, []);
});

test('기록에는 승인 주소 · 계정 이름 · 열쇠 · 도구의 글이 남지 않는다 — 주소가 준비됐다는 사실과 결과만', () => {
  const s = makeSoul('logs');
  const { child, logs } = launch(s);
  // 도구가 계정 귀띔 칸이 든 주소를 찍는 판이어도(지금은 넘기지 않지만) 기록에는 주소 자체가 가지 않는다.
  const hinted = `${APPROVE_URL}&login_hint=owner%40localhost`;
  child.stdout.emit('data', `${hinted}\n`);
  assert.equal(longKeyStatus({ root: s.root }).url, hinted, '주소는 상태(화면의 링크)로만 간다');
  child.stderr.emit('data', `warning mentioning ${OWNER}\n`);
  child.stdout.emit('data', `발급 완료: ${OWNER}\n${okResult(Date.now() + YEAR_MS)}`);
  child.emit('exit', 0); child.emit('close', 0);
  const all = logs.join('\n');
  assert.match(all, /longkey started pid=4242/);
  assert.match(all, /longkey approval address ready/);
  assert.match(all, /longkey done/);
  for (const bad of [OWNER, 'localhost', 'owner%40', 'oauth/authorize', 'login_hint', 'STATE-VALUE', 'claude.ai', 'user:inference']) assert.ok(!all.includes(bad), `기록에 ${bad} 가 있으면 안 된다:\n${all}`);
});

// ---------------------------------------------------------------------------
// 진짜 node + 가짜 도구 파일(파이프 · 자기 PID 끝내기 · 서버가 죽을 때)
// ---------------------------------------------------------------------------
const REAL_NODE_DIR = path.dirname(process.execPath);
const waitFor = async (pred, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await tick(40); }
  assert.fail(`기다리다 끝남: ${what}`);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('진짜 프로그램으로: 가짜 도구가 찍은 승인 주소와 RESULT 를 파이프로 읽는다 · 인자와 환경이 도구에 그대로 닿는다', async () => {
  const fake = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const seen = { args: process.argv.slice(2), tc: process.env.TEAMCLAUDE_CONFIG ?? null, dir: process.env.CLAUDE_CONFIG_DIR, lk: process.env.IRIS_LONGKEY_FILE ?? null };",
    "fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'seen.json'), JSON.stringify(seen));",
    `process.stdout.write('주소:\\n${APPROVE_URL}\\n');`,
    "setTimeout(() => { process.stdout.write('RESULT ' + JSON.stringify({ ok: true, email: null, expiresAt: Date.now() + 31536000000, expiresIn: 31536000, scope: 'user:inference' }) + '\\n'); }, 150);",
  ].join('\n');
  const s = makeSoul('real-ok', { tool: fake });
  const before = fs.readFileSync(s.configPath);
  const finishes = [];
  const env = { ...process.env };
  delete env.TEAMCLAUDE_CONFIG;
  const r = startLongKey({ root: s.root, nodeDir: REAL_NODE_DIR, env, onFinish: (x) => finishes.push(x) });
  assert.equal(r.ok, true);
  await waitFor(() => longKeyStatus({ root: s.root }).state === 'done', '가짜 도구의 RESULT');
  assert.equal(finishes.length, 1);
  const seen = JSON.parse(fs.readFileSync(path.join(path.dirname(longKeyToolPath(s.root)), 'seen.json'), 'utf8'));
  assert.deepEqual(seen.args, ['--timeout', String(LONGKEY_APPROVE_SEC)]);
  assert.equal(seen.dir, path.join(s.root, '_agent', 'claude'));
  assert.equal(seen.lk, null);
  assert.equal(seen.tc, null, '중계기 설정 자리를 도구에 정해 주지 않는다');
  assert.ok(fs.readFileSync(s.configPath).equals(before), '중계기 설정은 한 바이트도 바뀌지 않는다');
});

test('진짜 프로그램으로: 승인을 기다리는 프로그램을 닫을 때 자기 PID 만 끝낸다(남지 않는다)', async () => {
  const fake = [
    `process.stdout.write('${APPROVE_URL}\\n');`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const s = makeSoul('real-stop', { tool: fake });
  let exited = false;
  const logs = [];
  startLongKey({ root: s.root, nodeDir: REAL_NODE_DIR, log: (l) => { logs.push(l); if (/process exited/.test(l)) exited = true; } });
  await waitFor(() => longKeyStatus({ root: s.root }).state === 'approve', '승인 주소');
  const pid = Number(/started pid=(\d+)/.exec(logs.join('\n'))[1]);
  assert.ok(pid > 0 && pid !== process.pid);
  const stopped = stopLongKey({ root: s.root });
  assert.deepEqual(stopped, { stopped: true, pid });
  await waitFor(() => exited, '띄운 프로그램이 끝남');
  assert.equal(alive(pid), false, '그 PID 는 더 살아 있지 않다');
});

test('진짜 프로그램으로: 설치기 프로세스가 강제로 죽어도(닫는 길을 못 밟음) 띄워 둔 프로그램이 남지 않는다', async () => {
  // 설치기 노릇을 하는 프로세스 하나를 따로 띄워 그 안에서 startLongKey 를 부르고, 그 프로세스를 자식을 지목하지 않고(/T 없이)
  // 강제로 끝낸다. 딸린 프로세스로 띄웠으므로 윈도우가 자식을 함께 끝내야 한다. 전부 이 시험이 띄운 프로세스다.
  const fake = [`process.stdout.write('${APPROVE_URL}\\n');`, 'setInterval(() => {}, 1000);'].join('\n');
  const s = makeSoul('real-orphan', { tool: fake });
  const host = path.join(s.root, 'host.mjs');
  fs.writeFileSync(host, [
    `import { startLongKey } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'installer', 'lib', 'longkey.mjs')).href)};`,
    `startLongKey({ root: ${JSON.stringify(s.root)}, nodeDir: ${JSON.stringify(REAL_NODE_DIR)}, log: (l) => { const m = /started pid=(\\d+)/.exec(l); if (m) console.log('CHILD ' + m[1]); } });`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const parent = spawn(process.execPath, [host], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let childPid = null;
  parent.stdout.on('data', (d) => { const m = /CHILD (\d+)/.exec(String(d)); if (m) childPid = Number(m[1]); });
  try {
    await waitFor(() => childPid != null, '설치기 노릇의 프로세스가 도구를 띄움');
    await waitFor(() => alive(childPid), '도구가 돌고 있음', 5000);
    execFileSync('taskkill', ['/PID', String(parent.pid), '/F'], { stdio: 'ignore' });
    await waitFor(() => !alive(childPid), '설치기가 죽은 뒤 도구도 끝남', 10000);
    assert.equal(alive(parent.pid), false);
  } finally {
    // 뜻밖에 남았으면 이 시험이 띄운 두 PID 만 끝낸다.
    for (const pid of [parent.pid, childPid]) { if (pid && alive(pid)) { try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch { /* 이미 끝남 */ } } }
  }
});
