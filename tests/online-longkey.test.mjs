// 2.0.66 — 설치 화면의 「1년 열쇠 받기(권장)」 카드 뒤편(installer/lib/longkey.mjs, online.mjs 가 다시 내보낸다).
//
// 실제 계정 · 실제 로그인 · 네트워크 0. 띄우는 프로그램은 가짜다:
//   · 대부분은 가짜 자식(EventEmitter)을 끼워 표준 출력 줄을 손으로 흘려보낸다.
//   · 두 시험만 진짜 node 로 **가짜 도구 파일**(임시 폴더에 쓴 몇 줄짜리 스크립트)을 띄워 파이프와 "자기 PID 만 끝내기"를 본다.
// 진짜 중계기 설정 · 진짜 로그인 파일은 읽지도 쓰지도 않는다(전부 임시 영혼 폴더).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startLongKey, longKeyStatus, stopLongKey, longKeyAvailability,
} from '../installer/lib/online.mjs';
import {
  pickClaudeAccount, parseLongKeyResult, longKeyMessage, longKeyToolPath, irisKeyFilePath, resetLongKey,
  longKeyToolReady, reloadRelay,
  LONGKEY_APPROVE_SEC, LONGKEY_HARD_LIMIT_MS,
} from '../installer/lib/longkey.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-online-longkey-'));
after(() => { resetLongKey(); fs.rmSync(tmp, { recursive: true, force: true }); });

const OWNER = 'owner@localhost';   // 계정 이름 = 이메일 꼴(중계기가 그렇게 짓는다). 기록에 나오면 안 되는 글자다.
const URL_HINT = 'owner%40localhost';
const APPROVE_URL = `https://claude.ai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Fcallback&scope=user%3Ainference+user%3Aprofile&code_challenge=c&code_challenge_method=S256&state=s&login_hint=${URL_HINT}`;
const YEAR_MS = 365 * 86400000;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
/** 임시 영혼: 도구 파일(빈 자리표) · 동봉 node 자리 · 중계기 설정(클로드 1 + 코덱스 1). */
function makeSoul(label, { accounts, tool = '// placeholder that knows --also-iris\n', node = true } = {}) {
  const root = path.join(tmp, `${label}-${++seq}`);
  const nodeDir = path.join(root, '_agent', 'shared', 'tools', 'node');
  const configPath = path.join(root, '_agent', 'shared', 'portable-state', 'teamclaude', 'teamclaude.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.join(root, '_agent', 'claude'), { recursive: true });
  fs.mkdirSync(nodeDir, { recursive: true });
  if (node) fs.writeFileSync(path.join(nodeDir, 'node.exe'), 'not a real node');
  if (tool != null) { fs.mkdirSync(path.dirname(longKeyToolPath(root)), { recursive: true }); fs.writeFileSync(longKeyToolPath(root), tool); }
  fs.writeFileSync(configPath, `${JSON.stringify({ proxy: { port: 3456, apiKey: 'tc-K' }, accounts: accounts ?? [
    { name: 'codex-1', type: 'oauth', provider: 'codex', importFrom: 'x' },
    { name: OWNER, type: 'oauth', source: 'import', accessToken: 'A', refreshToken: 'R', expiresAt: 1 },
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
    root: soul.root, nodeDir: soul.nodeDir, teamclaudeConfigPath: soul.configPath,
    spawnFn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return child; },
    killFn: (pid) => { kills.push(pid); },
    log: (l) => logs.push(l), onFinish: (x) => finishes.push(x),
    env: { PATH: 'p', IRIS_LONGKEY_FILE: 'should-be-removed', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456' },
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

// ---------------------------------------------------------------------------
// 계정 고르기 · 카드를 낼 수 있는가(읽기만)
// ---------------------------------------------------------------------------
test('계정 고르기: 클로드 계정 줄이 하나면 그 줄(공급자 칸이 없는 줄 = 클로드) — 코덱스 줄은 세지 않는다', () => {
  const s = makeSoul('pick-one');
  assert.deepEqual(pickClaudeAccount({ root: s.root, teamclaudeConfigPath: s.configPath }), { ok: true, name: OWNER, ordinal: 1, already: false });
});

test('계정 고르기: 클로드 줄이 없으면(코덱스만) 고르지 않는다 · 설정이 없거나 깨졌으면 고르지 않는다', () => {
  const s = makeSoul('pick-none', { accounts: [{ name: 'codex-1', type: 'oauth', provider: 'codex', importFrom: 'x' }] });
  assert.deepEqual(pickClaudeAccount({ root: s.root, teamclaudeConfigPath: s.configPath }), { ok: false, reason: 'no-account' });
  assert.deepEqual(pickClaudeAccount({ root: s.root, teamclaudeConfigPath: path.join(s.root, 'nope.json') }), { ok: false, reason: 'no-config' });
  fs.writeFileSync(s.configPath, '{ broken');
  assert.deepEqual(pickClaudeAccount({ root: s.root, teamclaudeConfigPath: s.configPath }), { ok: false, reason: 'no-config' });
});

test('계정 고르기: 클로드 줄이 여럿이면 방금 로그인한 계정과 이름이 같은 줄만 — 알 수 없으면 고르지 않는다(엉뚱한 계정을 바꾸지 않는다)', () => {
  const two = [
    { name: 'first@localhost', type: 'oauth', accessToken: 'A1', refreshToken: 'R1' },
    { name: OWNER, type: 'oauth', accessToken: 'A2', refreshToken: 'R2' },
  ];
  const s = makeSoul('pick-many', { accounts: two });
  assert.deepEqual(pickClaudeAccount({ root: s.root, teamclaudeConfigPath: s.configPath }), { ok: false, reason: 'ambiguous' });
  fs.writeFileSync(path.join(s.root, '_agent', 'claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'OWNER@localhost' } }));
  assert.deepEqual(pickClaudeAccount({ root: s.root, teamclaudeConfigPath: s.configPath }), { ok: true, name: OWNER, ordinal: 2, already: false });
  fs.writeFileSync(path.join(s.root, '_agent', 'claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'stranger@localhost' } }));
  assert.deepEqual(pickClaudeAccount({ root: s.root, teamclaudeConfigPath: s.configPath }), { ok: false, reason: 'ambiguous' });
});

test('카드를 낼 수 있는가: 도구 · 동봉 node · 클로드 계정 줄이 다 있어야 한다 — 이미 두 자리 다 1년 열쇠면 내지 않는다', () => {
  const ok = makeSoul('avail-ok');
  assert.deepEqual(longKeyAvailability({ root: ok.root, nodeDir: ok.nodeDir, teamclaudeConfigPath: ok.configPath }), { available: true, reason: null });
  const noTool = makeSoul('avail-notool', { tool: null });
  assert.deepEqual(longKeyAvailability({ root: noTool.root, nodeDir: noTool.nodeDir, teamclaudeConfigPath: noTool.configPath }), { available: false, reason: 'no-tool' });
  const noNode = makeSoul('avail-nonode', { node: false });
  assert.deepEqual(longKeyAvailability({ root: noNode.root, nodeDir: noNode.nodeDir, teamclaudeConfigPath: noNode.configPath }), { available: false, reason: 'no-node' });
  const codexOnly = makeSoul('avail-codex', { accounts: [{ name: 'codex-1', type: 'oauth', provider: 'codex', importFrom: 'x' }] });
  assert.deepEqual(longKeyAvailability({ root: codexOnly.root, nodeDir: codexOnly.nodeDir, teamclaudeConfigPath: codexOnly.configPath }), { available: false, reason: 'no-account' });

  const have = makeSoul('avail-already', { accounts: [{ name: OWNER, type: 'oauth', accessToken: 'L', irisLongKey: true, expiresAt: Date.now() + YEAR_MS }] });
  assert.equal(longKeyAvailability({ root: have.root, nodeDir: have.nodeDir, teamclaudeConfigPath: have.configPath }).available, true, '중계기 줄만 1년 열쇠면 아직 낼 수 있다(창 세션용 자리가 비었다)');
  fs.mkdirSync(path.dirname(irisKeyFilePath(have.root)), { recursive: true });
  fs.writeFileSync(irisKeyFilePath(have.root), '{}');
  assert.deepEqual(longKeyAvailability({ root: have.root, nodeDir: have.nodeDir, teamclaudeConfigPath: have.configPath }), { available: false, reason: 'already' });
});

test('카드를 누르지 않으면 아무 파일도 쓰지 않고 프로그램도 띄우지 않는다(조회는 읽기만)', () => {
  const s = makeSoul('readonly');
  const before = snapshot(s.root);
  for (let i = 0; i < 5; i++) {
    longKeyAvailability({ root: s.root, nodeDir: s.nodeDir, teamclaudeConfigPath: s.configPath });
    assert.equal(longKeyStatus({ root: s.root }).state, 'idle');
    pickClaudeAccount({ root: s.root, teamclaudeConfigPath: s.configPath });
  }
  assert.deepEqual(stopLongKey({ root: s.root }), { stopped: false }, '띄운 적이 없으면 끝낼 것도 없다');
  assert.deepEqual(snapshot(s.root), before);
});

// ---------------------------------------------------------------------------
// 「받기」 — 띄우는 꼴 · 상태 흐름
// ---------------------------------------------------------------------------
test('받기: 동봉 node 로 설치본의 도구를 창 없이 띄운다 — 인자 · 환경 · 한도', () => {
  const s = makeSoul('spawn');
  const { r, spawns } = launch(s);
  assert.deepEqual(r, { ok: true, state: 'starting', already: false });
  assert.equal(spawns.length, 1);
  const { cmd, args, opts } = spawns[0];
  assert.equal(cmd, path.join(s.nodeDir, 'node.exe'));
  assert.deepEqual(args, [longKeyToolPath(s.root), '--account', OWNER, '--also-iris', '--timeout', String(LONGKEY_APPROVE_SEC)]);
  assert.ok(!args.includes('--no-open'), '브라우저는 도구가 연다(화면의 링크는 열리지 않았을 때용)');
  assert.equal(opts.windowsHide, true, '검은 창을 띄우지 않는다');
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(opts.detached, undefined, '설치기에 딸린 프로그램으로 띄운다');
  assert.equal(opts.env.TEAMCLAUDE_CONFIG, s.configPath, '이 영혼의 중계기 설정만 본다');
  assert.equal(opts.env.CLAUDE_CONFIG_DIR, path.join(s.root, '_agent', 'claude'));
  assert.equal('IRIS_LONGKEY_FILE' in opts.env, false, '다른 자리를 가리키는 변수는 넘기지 않는다');
  assert.equal(opts.env.NODE_USE_SYSTEM_CA, '1', '윈도우 인증서도 믿는다(2.0.62)');
  assert.equal(opts.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456', '중계기 주소 변수는 건드리지 않는다');
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
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const line = "if (childEnv.NODE_USE_SYSTEM_CA == null || childEnv.NODE_USE_SYSTEM_CA === '') childEnv.NODE_USE_SYSTEM_CA = '1';";
  assert.ok(fs.readFileSync(path.join(here, '..', 'installer', 'lib', 'longkey.mjs'), 'utf8').includes(line));
  assert.ok(fs.readFileSync(path.join(here, '..', 'verify', 'static.mjs'), 'utf8').includes(line), '정적 검사도 같은 줄을 찾는다');
});

test('상태 흐름: 띄움 → 승인 대기(주소) → 끝남. 끝나면 주소를 더 내지 않고, 끝남 알림은 한 번', async () => {
  const s = makeSoul('flow');
  const { child, finishes, kills } = launch(s, { lingerMs: 20 });
  assert.equal(longKeyStatus({ root: s.root }).state, 'starting');
  assert.equal(longKeyStatus({ root: s.root }).url, null);

  child.stdout.emit('data', '브라우저에서 1년 열쇠 발급을 승인해 주세요.\n브라우저가 안 열리면 이 주소를 여세요:\n');
  child.stdout.emit('data', `${APPROVE_URL}\n`);
  const waiting = longKeyStatus({ root: s.root });
  assert.equal(waiting.state, 'approve');
  assert.equal(waiting.url, APPROVE_URL);
  assert.match(waiting.message, /승인/);
  const u = new URL(waiting.url);
  assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+\/callback$/, '승인 뒤 이 PC 로 돌아온다');
  for (const k of ['access_token', 'refresh_token', 'token', 'code_verifier']) assert.equal(u.searchParams.get(k), null, `승인 주소에 ${k} 없음`);

  const expiresAt = Date.now() + YEAR_MS;
  // RESULT 줄이 두 조각으로 나뉘어 와도 한 줄로 읽는다.
  child.stdout.emit('data', `1년 열쇠 · 중계기 계정 줄 넣음 · IRIS 창 세션 넣음\nRESULT {"ok":true,"target":"both","relay":"ok","iris":"ok","expiresAt":${expiresAt},`);
  assert.equal(longKeyStatus({ root: s.root }).state, 'approve', '줄이 끝나기 전에는 판정하지 않는다');
  child.stdout.emit('data', '"expiresIn":31536000,"reloaded":false}\n');
  const done = longKeyStatus({ root: s.root });
  assert.equal(done.state, 'done');
  assert.deepEqual(done.slots, { relay: 'ok', iris: 'ok' });
  assert.equal(done.expiresAt, expiresAt);
  assert.equal(done.url, null, '끝난 뒤에는 승인 주소를 내지 않는다');
  assert.match(done.message, /1년 열쇠를 받았습니다\(만료 \d{4}-\d{2}-\d{2}\)/);
  assert.deepEqual(finishes, [{ state: 'done', slots: { relay: 'ok', iris: 'ok' }, expiresAt, reason: null }]);

  // 결과를 낸 프로그램이 스스로 끝나면 끝내지 않는다.
  child.emit('exit', 0);
  await tick(60);
  assert.deepEqual(kills, [], '스스로 끝난 프로그램은 건드리지 않는다');
  assert.equal(finishes.length, 1, '끝남 알림은 한 번');
});

test('끝난 뒤에도 프로그램이 남아 있으면 자기가 띄운 그 PID 만 끝낸다', async () => {
  const s = makeSoul('linger');
  const { child, kills } = launch(s, { child: fakeChild(7001), lingerMs: 20 });
  child.stdout.emit('data', `RESULT {"ok":true,"relay":"ok","iris":"ok","expiresAt":${Date.now() + YEAR_MS}}\n`);
  await tick(80);
  assert.deepEqual(kills, [7001]);
});

test('두 번 눌러도 프로그램은 하나만 돈다 — 실패한 뒤 다시 누르면 새로 한 번', () => {
  const s = makeSoul('twice');
  const spawns = [];
  const children = [fakeChild(1), fakeChild(2)];
  const go = () => startLongKey({ root: s.root, nodeDir: s.nodeDir, teamclaudeConfigPath: s.configPath, spawnFn: (...a) => { spawns.push(a); return children[spawns.length - 1]; }, killFn: () => {} });
  assert.equal(go().already, false);
  assert.deepEqual(go(), { ok: true, state: 'starting', already: true });
  children[0].stdout.emit('data', `${APPROVE_URL}\n`);
  assert.deepEqual(go(), { ok: true, state: 'approve', already: true });
  assert.equal(spawns.length, 1, '돌고 있는 동안에는 더 띄우지 않는다');

  children[0].stdout.emit('data', 'RESULT {"ok":false,"target":"both","relay":"skipped","iris":"skipped","reason":"timeout","error":"x"}\n');
  assert.equal(longKeyStatus({ root: s.root }).state, 'failed');
  assert.equal(go().already, false);
  assert.equal(spawns.length, 2, '끝난 뒤에는 다시 띄울 수 있다');
  assert.equal(longKeyStatus({ root: s.root }).state, 'starting', '새 일의 상태로 바뀐다');
  stopLongKey({ root: s.root });
});

test('실패: 도구가 말한 까닭만 받고(아는 낱말) 도구의 글은 밖으로 내지 않는다 — 글은 "지금 로그인은 그대로"', () => {
  for (const [reason, re] of [['timeout', /시간이 지났습니다/], ['denied', /취소/], ['account-mismatch', /계정이 방금 로그인한 계정과 달라/], ['short-lived', /유효 기간이 짧은/], ['exchange-failed', /받아 오지 못했습니다/]]) {
    const s = makeSoul(`fail-${reason}`);
    const { child, finishes } = launch(s);
    child.stdout.emit('data', `발급 실패: (계정) 어쩌고\nRESULT {"ok":false,"target":"both","relay":"skipped","iris":"skipped","reason":"${reason}","error":"SECRET-TEXT ${OWNER}"}\n`);
    const st = longKeyStatus({ root: s.root });
    assert.equal(st.state, 'failed');
    assert.equal(st.reason, reason);
    assert.match(st.message, re);
    assert.match(st.message, /지금 로그인은 그대로/);
    assert.ok(!JSON.stringify(st).includes('SECRET-TEXT') && !JSON.stringify(st).includes(OWNER), '도구의 글 · 계정 이름은 상태에 싣지 않는다');
    assert.deepEqual(finishes, [{ state: 'failed', slots: { relay: 'skipped', iris: 'skipped' }, expiresAt: null, reason }]);
  }
  assert.equal(parseLongKeyResult('RESULT {"ok":false,"reason":"<script>"}\n').reason, 'failed', '모르는 까닭은 한 낱말로 뭉갠다');
  assert.equal(parseLongKeyResult('RESULT {not json}\n').state, 'failed', '읽을 수 없는 결과 줄은 실패로');
  assert.equal(parseLongKeyResult('아직 결과 줄 없음\n'), null);
});

test('한 자리만 써진 결과는 "일부"다 — 고장이 아니라 미완이라고 말하고 어느 자리인지 싣는다', () => {
  const s = makeSoul('partial');
  const expiresAt = Date.now() + YEAR_MS;
  const { child, finishes } = launch(s);
  child.stdout.emit('data', `RESULT {"ok":false,"target":"both","relay":"ok","iris":"failed","partial":true,"expiresAt":${expiresAt},"reason":"iris-write-failed"}\n`);
  const st = longKeyStatus({ root: s.root });
  assert.equal(st.state, 'partial');
  assert.deepEqual(st.slots, { relay: 'ok', iris: 'failed' });
  assert.equal(st.expiresAt, expiresAt);
  assert.match(st.message, /계정 연결에 넣었지만, IRIS 창용 자리에는 넣지 못했습니다/);
  assert.match(st.message, /지금 로그인은 그대로/);
  assert.equal(finishes[0].state, 'partial');

  assert.match(longKeyMessage({ state: 'partial', slots: { relay: 'failed', iris: 'ok' } }), /IRIS 창용 자리에 넣었지만, 계정 연결에는 넣지 못했습니다/);
  // ok:true 라고 해도 두 자리가 다 ok 가 아니면 "받음"으로 치지 않는다.
  assert.equal(parseLongKeyResult('RESULT {"ok":true,"relay":"ok","iris":"skipped"}\n').state, 'partial');
});

test('결과 없이 프로그램이 끝나면 실패 — 띄우지 못해도 실패(던지지 않는다)', () => {
  const a = makeSoul('exited');
  const one = launch(a);
  one.child.emit('exit', 1);
  assert.deepEqual({ state: longKeyStatus({ root: a.root }).state, reason: longKeyStatus({ root: a.root }).reason }, { state: 'failed', reason: 'exited' });
  assert.equal(one.finishes.length, 1);

  const b = makeSoul('spawn-throws');
  const r = startLongKey({ root: b.root, nodeDir: b.nodeDir, teamclaudeConfigPath: b.configPath, spawnFn: () => { throw new Error('EPERM'); } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'spawn-failed');
  assert.match(r.message, /지금 로그인은 그대로/);

  const c = makeSoul('no-tool', { tool: null });
  const spawned = [];
  const r2 = startLongKey({ root: c.root, nodeDir: c.nodeDir, teamclaudeConfigPath: c.configPath, spawnFn: () => { spawned.push(1); return fakeChild(); } });
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
  child.emit('exit', 1);
  assert.deepEqual(stopLongKey({ root: s.root }), { stopped: false, pid: null }, '이미 끝난 프로그램은 다시 끝내지 않는다');
  assert.deepEqual(kills, [9090]);
});

test('기록에는 "claude account #N" 꼴만 남는다 — 계정 이름 · 승인 주소 · 열쇠 · 도구의 글 없음', () => {
  const s = makeSoul('logs', { accounts: [
    { name: 'first@localhost', type: 'oauth', accessToken: 'A1' },
    { name: OWNER, type: 'oauth', accessToken: 'A2', refreshToken: 'R2' },
  ] });
  fs.writeFileSync(path.join(s.root, '_agent', 'claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: OWNER } }));
  const { child, logs } = launch(s);
  child.stdout.emit('data', `${APPROVE_URL}\n`);
  child.stderr.emit('data', `warning mentioning ${OWNER}\n`);
  child.stdout.emit('data', `RESULT {"ok":false,"relay":"failed","iris":"ok","partial":true,"expiresAt":${Date.now() + YEAR_MS},"reason":"relay-changed","error":"${OWNER}"}\n`);
  child.emit('exit', 2);
  const all = logs.join('\n');
  assert.match(all, /longkey claude account #2 started pid=4242/);
  assert.match(all, /longkey claude account #2 partial relay=failed iris=ok reason=relay-changed/);
  for (const bad of [OWNER, 'localhost', URL_HINT, 'oauth/authorize', 'login_hint', 'A2', 'R2']) assert.ok(!all.includes(bad), `기록에 ${bad} 가 있으면 안 된다:\n${all}`);
});

test('옛 도구(두 자리 쓰기를 모르는 판)가 깔려 있으면 카드를 내지 않고, 눌러도 띄우지 않는다', () => {
  // 옛 도구는 --also-iris 를 흘려듣고 중계기 자리만 바꾼다 — 그런 반쪽 쓰기가 "실패"로 읽히지 않게 띄우기 전에 가린다.
  const s = makeSoul('old-tool', { tool: "// longkey.mjs 2.0.65\nconst account = arg('--account');\n" });
  assert.equal(longKeyToolReady(s.root), false);
  assert.deepEqual(longKeyAvailability({ root: s.root, nodeDir: s.nodeDir, teamclaudeConfigPath: s.configPath }), { available: false, reason: 'no-tool' });
  const { r, spawns } = launch(s);
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'no-tool' });
  assert.equal(spawns.length, 0);
  assert.equal(longKeyToolReady(makeSoul('new-tool').root), true);
  assert.equal(longKeyToolReady(makeSoul('none-tool', { tool: null }).root), false);
  // 이 저장소가 싣는 도구는 아는 판이다.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.ok(fs.readFileSync(path.join(here, '..', 'payload-src', 'tools', 'iris-auth', 'longkey.mjs'), 'utf8').includes('--also-iris'));
});

test('다시 읽기 한 번 더: 도구가 중계기 계정 줄을 썼는데 다시 읽기 부탁이 닿지 않았을 때만, 조금 뒤 한 번 부탁한다', async () => {
  const year = Date.now() + YEAR_MS;
  const cases = [
    ['계정 줄을 썼고 부탁이 안 닿음', `{"ok":true,"relay":"ok","iris":"ok","expiresAt":${year},"reloaded":false}`, 1],
    ['한 자리만(계정 줄) 썼고 부탁이 안 닿음', `{"ok":false,"partial":true,"relay":"ok","iris":"failed","expiresAt":${year},"reloaded":false,"reason":"iris-write-failed"}`, 1],
    ['도구의 부탁이 이미 닿음', `{"ok":true,"relay":"ok","iris":"ok","expiresAt":${year},"reloaded":true}`, 0],
    ['계정 줄을 쓰지 못함', `{"ok":false,"partial":true,"relay":"failed","iris":"ok","expiresAt":${year},"reloaded":false,"reason":"relay-changed"}`, 0],
    ['아무것도 못 씀', '{"ok":false,"relay":"skipped","iris":"skipped","reason":"timeout"}', 0],
  ];
  for (const [what, json, want] of cases) {
    const s = makeSoul('reload');
    let asked = 0;
    const { child, logs } = launch(s, { reloadFn: async () => { asked += 1; return true; }, reloadRetryMs: 20 });
    child.stdout.emit('data', `RESULT ${json}\n`);
    child.emit('exit', 0);
    assert.equal(asked, 0, `${what}: 곧바로 부탁하지 않는다`);
    await tick(80);
    assert.equal(asked, want, what);
    assert.equal(logs.filter((l) => /reload retry ok=true/.test(l)).length, want);
  }
  // 넘겨받지 않았으면(기본) 아무 데도 부탁하지 않는다 — 시험 · 다른 쓰임이 살아 있는 중계기를 두드리지 않는다.
  const quiet = makeSoul('reload-none');
  const q = launch(quiet, { reloadRetryMs: 10 });
  q.child.stdout.emit('data', `RESULT {"ok":true,"relay":"ok","iris":"ok","expiresAt":${year},"reloaded":false}\n`);
  q.child.emit('exit', 0);
  await tick(50);
  assert.ok(!q.logs.some((l) => /reload retry/.test(l)));
  // 부탁이 실패해도(중계기가 꺼져 있음) 카드 결과는 그대로다.
  const down = makeSoul('reload-down');
  const d = launch(down, { reloadFn: async () => { throw new Error('ECONNREFUSED'); }, reloadRetryMs: 10 });
  d.child.stdout.emit('data', `RESULT {"ok":true,"relay":"ok","iris":"ok","expiresAt":${year},"reloaded":false}\n`);
  await tick(50);
  assert.equal(longKeyStatus({ root: down.root }).state, 'done');
  assert.ok(d.logs.some((l) => /reload retry ok=false/.test(l)));
});

test('다시 읽기 부탁의 모양: 이 PC 의 중계기에 본문 없는 POST 한 번 — 꺼져 있으면 false(던지지 않는다)', async () => {
  const seen = [];
  assert.equal(await reloadRelay(3456, { fetchFn: async (url, opts) => { seen.push([url, opts]); return { ok: true }; } }), true);
  assert.deepEqual(seen, [['http://127.0.0.1:3456/teamclaude/reload', { method: 'POST' }]]);
  assert.equal(await reloadRelay(3456, { fetchFn: async () => ({ ok: false }) }), false);
  assert.equal(await reloadRelay(3456, { fetchFn: async () => { throw new Error('ECONNREFUSED'); } }), false);
});

// ---------------------------------------------------------------------------
// 진짜 node + 가짜 도구 파일(파이프 · 자기 PID 끝내기)
// ---------------------------------------------------------------------------
const REAL_NODE_DIR = path.dirname(process.execPath);
const waitFor = async (pred, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await tick(40); }
  assert.fail(`기다리다 끝남: ${what}`);
};

test('진짜 프로그램으로: 가짜 도구가 찍은 승인 주소와 RESULT 를 파이프로 읽는다 · 인자와 환경이 도구에 그대로 닿는다', async () => {
  const fake = [
    '// fake tool: understands --also-iris',
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const seen = { args: process.argv.slice(2), tc: process.env.TEAMCLAUDE_CONFIG, dir: process.env.CLAUDE_CONFIG_DIR, lk: process.env.IRIS_LONGKEY_FILE ?? null };",
    "fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'seen.json'), JSON.stringify(seen));",
    `process.stdout.write('주소:\\n${APPROVE_URL}\\n');`,
    "setTimeout(() => { process.stdout.write('RESULT ' + JSON.stringify({ ok: true, target: 'both', relay: 'ok', iris: 'ok', expiresAt: Date.now() + 31536000000, expiresIn: 31536000, reloaded: false }) + '\\n'); }, 150);",
  ].join('\n');
  const s = makeSoul('real-ok', { tool: fake });
  const before = fs.readFileSync(s.configPath);
  const finishes = [];
  const r = startLongKey({ root: s.root, nodeDir: REAL_NODE_DIR, teamclaudeConfigPath: s.configPath, onFinish: (x) => finishes.push(x) });
  assert.equal(r.ok, true);
  await waitFor(() => longKeyStatus({ root: s.root }).state === 'done', '가짜 도구의 RESULT');
  assert.equal(finishes.length, 1);
  const seen = JSON.parse(fs.readFileSync(path.join(path.dirname(longKeyToolPath(s.root)), 'seen.json'), 'utf8'));
  assert.deepEqual(seen.args, ['--account', OWNER, '--also-iris', '--timeout', String(LONGKEY_APPROVE_SEC)]);
  assert.equal(seen.tc, s.configPath);
  assert.equal(seen.dir, path.join(s.root, '_agent', 'claude'));
  assert.ok(fs.readFileSync(s.configPath).equals(before), '설치기 쪽은 중계기 설정을 쓰지 않는다(쓰는 것은 도구뿐)');
});

test('진짜 프로그램으로: 승인을 기다리는 프로그램을 닫을 때 자기 PID 만 끝낸다(남지 않는다)', async () => {
  const fake = [
    '// fake tool: understands --also-iris',
    `process.stdout.write('${APPROVE_URL}\\n');`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const s = makeSoul('real-stop', { tool: fake });
  let exited = false;
  const logs = [];
  startLongKey({ root: s.root, nodeDir: REAL_NODE_DIR, teamclaudeConfigPath: s.configPath, log: (l) => { logs.push(l); if (/process exited/.test(l)) exited = true; } });
  await waitFor(() => longKeyStatus({ root: s.root }).state === 'approve', '승인 주소');
  const pid = Number(/started pid=(\d+)/.exec(logs.join('\n'))[1]);
  assert.ok(pid > 0 && pid !== process.pid);
  const stopped = stopLongKey({ root: s.root });
  assert.deepEqual(stopped, { stopped: true, pid });
  await waitFor(() => exited, '띄운 프로그램이 끝남');
  assert.throws(() => process.kill(pid, 0), '그 PID 는 더 살아 있지 않다');
});
