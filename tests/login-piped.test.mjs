// 2.0.33 — 로그인은 무조건 자동 복귀(설계 조각 ②, 2026-09-21 사용자 결정).
// 검은 콘솔 창 대신 CLI 로그인을 창 없이(표준입출력 파이프) 띄우고, 출력에서 로그인 주소를 읽어
// 화면에 **자동 복귀 주소만** 보여 준다. 수동 코드 주소(platform.claude.com/oauth/code/callback)는
// 어떤 경우에도 화면에 내지 않는다 — 그 수동 입력칸은 글자를 되비추지 않아 사람이 쓸 수 없다(9/20 실측).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startPipedLogin, pipedLoginInfo, resetPipedLogin,
  parseLoginUrl, autoLoginUrl, parseNetstatListeners, resolveClaudeExe,
} from '../installer/lib/login.mjs';

const MANUAL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code'
  + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile'
  + '&code_challenge=Bp0eCm-uVrjdIx3KDiBRLg3aCHE2P4BhhWVBqp_8lwc&code_challenge_method=S256&state=Imd641cyRy3SAOETrcrZQWTJUimJZVlVR3iEqb4fIdg';

function tmpRoot(name) {
  const dir = path.join(os.tmpdir(), `iris-piped-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeChild(pid = 5150) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {}, write() {} };
  child.unref = () => {};
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('parseLoginUrl: claude 는 authorize 주소를, codex 는 localhost 주소를 찾는다 (없으면 null)', () => {
  const claudeOut = `Opening browser to sign in…\nIf the browser didn't open, visit: ${MANUAL}\nPaste code here if prompted > `;
  assert.equal(parseLoginUrl('claude', claudeOut), MANUAL);
  const codexOut = 'Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL:\n\nhttp://localhost:1455/auth/callback?x=1&state=abc\n';
  assert.equal(parseLoginUrl('chatgpt', codexOut), 'http://localhost:1455/auth/callback?x=1&state=abc');
  assert.equal(parseLoginUrl('claude', 'nothing here'), null);
  // 코덱스 출력에 다른 https 주소가 섞여 있어도 localhost 만 고른다
  assert.equal(parseLoginUrl('chatgpt', 'see https://chatgpt.com/help first\nhttp://localhost:1455/auth/x'), 'http://localhost:1455/auth/x');
});

test('autoLoginUrl: redirect_uri 만 localhost:포트/callback 으로 바꾸고 나머지(state·code_challenge)는 그대로', () => {
  const auto = autoLoginUrl(MANUAL, 65416);
  const u = new URL(auto);
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:65416/callback');
  assert.equal(u.searchParams.get('state'), 'Imd641cyRy3SAOETrcrZQWTJUimJZVlVR3iEqb4fIdg');
  assert.equal(u.searchParams.get('code_challenge'), 'Bp0eCm-uVrjdIx3KDiBRLg3aCHE2P4BhhWVBqp_8lwc');
  assert.equal(u.searchParams.get('code'), 'true');
  assert.doesNotMatch(auto, /platform\.claude\.com/);
  assert.equal(autoLoginUrl('not a url', 1), null);
  assert.equal(autoLoginUrl(MANUAL, 0), null);
});

test('parseNetstatListeners: netstat -ano 출력에서 그 PID 의 LISTENING 포트만 (루프백 우선)', () => {
  const out = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
    '  TCP    127.0.0.1:3456         0.0.0.0:0              LISTENING       999',
    '  TCP    127.0.0.1:65416        0.0.0.0:0              LISTENING       34552',
    '  TCP    0.0.0.0:49000          0.0.0.0:0              LISTENING       34552',
    '  TCP    127.0.0.1:65417        127.0.0.1:443          ESTABLISHED     34552',
    '  TCP    [::1]:65418            [::]:0                 LISTENING       34552',
  ].join('\r\n');
  assert.deepEqual(parseNetstatListeners(out, 34552), [65416, 65418, 49000]);
  assert.deepEqual(parseNetstatListeners(out, 1), []);
});

test('resolveClaudeExe: claude.cmd 전달자가 가리키는 claude.exe 를 찾고, 못 찾으면 null', () => {
  const root = tmpRoot('exe');
  const dir = path.join(root, '_agent', 'shared', 'tools', 'claude');
  fs.mkdirSync(path.join(dir, '2.1.278'), { recursive: true });
  fs.writeFileSync(path.join(dir, '2.1.278', 'claude.exe'), 'MZ');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\nsetlocal\r\n"%~dp02.1.278\\claude.exe" %*\r\nexit /b %errorlevel%\r\n');
  assert.equal(resolveClaudeExe(root), path.join(dir, '2.1.278', 'claude.exe'));
  fs.rmSync(path.join(dir, '2.1.278', 'claude.exe'));
  assert.equal(resolveClaudeExe(root), null, 'the exe the forwarder names must actually exist');
  fs.rmSync(root, { recursive: true, force: true });
});

test('startPipedLogin(claude): 창 없이 exe 직접 실행, 프록시 주소 없음, 수동 주소 → 포트 조회 → 자동 주소만 기록', async () => {
  resetPipedLogin('claude');
  const root = tmpRoot('claude');
  const dir = path.join(root, '_agent', 'shared', 'tools', 'claude');
  fs.mkdirSync(path.join(dir, '2.1.278'), { recursive: true });
  fs.writeFileSync(path.join(dir, '2.1.278', 'claude.exe'), 'MZ');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '"%~dp02.1.278\\claude.exe" %*\r\n');
  const had = 'ANTHROPIC_BASE_URL' in process.env; const prev = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456';
  let captured = null; const child = fakeChild(777); const portCalls = [];
  try {
    const r = startPipedLogin({
      provider: 'claude', root, nodeDir: 'C:\\X\\node', teamclaudeConfigPath: 'C:\\X\\tc.json',
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return child; },
      portsFn: async (pid) => { portCalls.push(pid); return portCalls.length < 2 ? [] : [65416]; },
      portPollMs: 1,
    });
    assert.equal(r.started, true); assert.equal(r.pid, 777); assert.equal(r.mode, 'piped');
    assert.equal(captured.cmd, path.join(dir, '2.1.278', 'claude.exe'));
    assert.deepEqual(captured.args, ['auth', 'login', '--claudeai']);
    assert.equal(captured.opts.windowsHide, true);
    assert.deepEqual(captured.opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal('ANTHROPIC_BASE_URL' in captured.opts.env, false);
    assert.equal(captured.opts.env.CLAUDE_CONFIG_DIR, path.join(root, '_agent', 'claude'));
    assert.equal(captured.opts.env.TEAMCLAUDE_CONFIG, 'C:\\X\\tc.json');
    assert.equal(pipedLoginInfo('claude').url, null, 'no url before the CLI printed one');
    child.stdout.emit('data', Buffer.from('Opening browser to sign in…\nIf the browser didn\'t open, visit: '));
    child.stdout.emit('data', Buffer.from(`${MANUAL}\nPaste code here if prompted > `));
    await tick(30);
    const info = pipedLoginInfo('claude');
    assert.ok(info.url, 'automatic url must be recorded');
    assert.equal(new URL(info.url).searchParams.get('redirect_uri'), 'http://localhost:65416/callback');
    assert.doesNotMatch(info.url, /platform\.claude\.com/, 'the manual-code url must never be exposed');
    assert.equal(info.exited, false);
    assert.ok(portCalls.every((p) => p === 777));
    child.emit('exit', 0, null);
    assert.equal(pipedLoginInfo('claude').exited, true);
    assert.equal(pipedLoginInfo('claude').code, 0);
  } finally {
    if (had) process.env.ANTHROPIC_BASE_URL = prev; else delete process.env.ANTHROPIC_BASE_URL;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startPipedLogin(claude): 포트를 끝내 못 읽으면 url 은 null 로 남기고 수동 주소는 내지 않는다', async () => {
  resetPipedLogin('claude');
  const root = tmpRoot('noport');
  const child = fakeChild(11);
  startPipedLogin({
    provider: 'claude', root, nodeDir: 'C:\\X\\node', teamclaudeConfigPath: 'C:\\X\\tc.json',
    spawnFn: () => child, portsFn: async () => [], portPollMs: 1, portTries: 3,
  });
  child.stdout.emit('data', Buffer.from(`visit: ${MANUAL}\n`));
  await tick(40);
  const info = pipedLoginInfo('claude');
  assert.equal(info.url, null);
  assert.equal(info.manualSeen, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('startPipedLogin(claude): claude.exe 를 못 찾으면 cmd.exe 로 claude.cmd 를 파이프 실행한다', () => {
  resetPipedLogin('claude');
  const root = tmpRoot('nocmd');
  let captured = null;
  startPipedLogin({ provider: 'claude', root, nodeDir: 'C:\\X\\node', teamclaudeConfigPath: 'C:\\X\\tc.json', spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(1); }, portsFn: async () => [] });
  assert.match(captured.cmd, /cmd\.exe$/i);
  assert.match(captured.args.join(' '), /claude\.cmd" auth login --claudeai/);
  assert.equal(captured.opts.windowsHide, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('startPipedLogin(codex): codex.cmd login 을 창 없이, CODEX_HOME, localhost 주소를 그대로 기록', async () => {
  resetPipedLogin('chatgpt');
  const root = tmpRoot('codex');
  let captured = null; const child = fakeChild(22);
  const r = startPipedLogin({ provider: 'chatgpt', root, nodeDir: 'C:\\X\\node', teamclaudeConfigPath: 'C:\\X\\tc.json', spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return child; }, portsFn: async () => { throw new Error('must not be called for codex'); } });
  assert.equal(r.mode, 'piped');
  assert.match(captured.args.join(' '), /codex\.cmd" login/);
  assert.equal(captured.opts.env.CODEX_HOME, path.join(root, '_agent', 'codex'));
  assert.equal(captured.opts.windowsHide, true);
  child.stderr.emit('data', Buffer.from('If your browser did not open, navigate to this URL:\n\nhttp://localhost:1455/auth/callback?state=zz\n'));
  await tick(5);
  assert.equal(pipedLoginInfo('chatgpt').url, 'http://localhost:1455/auth/callback?state=zz');
  fs.rmSync(root, { recursive: true, force: true });
});

test('startPipedLogin: dryRun 은 명령줄·환경만 돌려주고 아무것도 띄우지 않는다', () => {
  const root = tmpRoot('dry');
  let spawned = 0;
  const r = startPipedLogin({ provider: 'chatgpt', root, nodeDir: 'C:\\X\\node', teamclaudeConfigPath: 'C:\\X\\tc.json', spawnFn: () => { spawned++; }, dryRun: true });
  assert.equal(r.dryRun, true); assert.equal(r.started, false); assert.equal(spawned, 0);
  assert.ok(Array.isArray(r.args));
  fs.rmSync(root, { recursive: true, force: true });
});

test('pipedLoginInfo: 시작한 적 없으면 null, 다시 시작하면 이전 기록을 덮는다', async () => {
  resetPipedLogin('claude');
  assert.equal(pipedLoginInfo('claude'), null);
  const root = tmpRoot('again');
  const a = fakeChild(1); const b = fakeChild(2);
  const kids = [a, b];
  const opts = { provider: 'claude', root, nodeDir: 'C:\\X\\node', teamclaudeConfigPath: 'C:\\X\\tc.json', spawnFn: () => kids.shift(), portsFn: async () => [1] };
  startPipedLogin(opts); a.emit('exit', 1, null);
  assert.equal(pipedLoginInfo('claude').exited, true);
  startPipedLogin(opts);
  assert.equal(pipedLoginInfo('claude').pid, 2);
  assert.equal(pipedLoginInfo('claude').exited, false);
  fs.rmSync(root, { recursive: true, force: true });
});
