// 2.0.33 — startLogin/loginStatus 가 파이프 로그인(login.mjs startPipedLogin)을 쓰고, 화면에 줄 자동 복귀 주소와
// "로그인이 끝나기 전에 프로세스가 끝남" 실패를 돌려준다(설계 조각 ②③, 2026-09-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLogin, loginStatus } from '../installer/lib/online.mjs';
import { readReceipt, writeReceipt, newReceiptV2 } from '../installer/lib/receipt.mjs';

function tmpRoot(name) {
  const dir = path.join(os.tmpdir(), `iris-online-piped-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  writeReceipt(dir, newReceiptV2({ root: dir, name: 'TESTSOUL', manifest: null, createdBy: 'test' }));
  return dir;
}

function deps(root, over = {}) {
  return {
    provider: 'claude', root,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    cliLoginStatusFn: () => 'pending',
    relayStatusFn: async () => 'pending',
    relayImportFn: async () => ({ ok: true, method: 'import' }),
    probe: async () => ({ reachable: true, status: 200 }),
    ...over,
  };
}

test('startLogin: 기본 실행기는 파이프 로그인이고(창 없음) 기록에 mode=piped 가 남는다', async () => {
  const root = tmpRoot('mode');
  let got = null;
  const r = await startLogin({
    provider: 'claude', root,
    cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    startCliLoginFn: (o) => { got = o; return { started: true, pid: 9, mode: 'piped' }; },
    now: () => 5,
  });
  assert.equal(r.state, 'waiting');
  assert.equal(r.mode, 'piped');
  assert.equal(got.provider, 'claude');
  assert.equal(readReceipt(root).login.claude.mode, 'piped');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: 기다리는 동안 파이프 로그인이 알아낸 자동 주소를 url 로 돌려준다(수동 주소 아님)', async () => {
  const root = tmpRoot('url');
  await startLogin({ provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0, resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true, pid: 9, mode: 'piped' }), now: () => 1000 });
  const st = await loginStatus(deps(root, {
    now: () => 5000,
    pipedInfoFn: () => ({ pid: 9, url: 'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A65416%2Fcallback&state=s', manualSeen: true, exited: false, code: null }),
  }));
  assert.equal(st.state, 'waiting');
  assert.equal(st.url, 'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A65416%2Fcallback&state=s');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: 인증 파일 없이 프로세스가 끝났으면 2분을 기다리지 않고 login-exited 실패', async () => {
  const root = tmpRoot('exited');
  await startLogin({ provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0, resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true, pid: 9, mode: 'piped' }), now: () => 1000 });
  const st = await loginStatus(deps(root, {
    now: () => 3000,
    pipedInfoFn: () => ({ pid: 9, url: null, manualSeen: true, exited: true, code: 1, startedAt: 1000 }),
  }));
  assert.equal(st.state, 'failed');
  assert.equal(st.reason, 'login-exited');
  assert.match(st.message, /다시 로그인/);
  assert.equal(readReceipt(root).login.claude.reason, 'login-exited');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: 프로세스가 끝났어도 인증 파일이 있으면 정상 흐름(중계기 가져오기)으로 간다', async () => {
  const root = tmpRoot('exited-ok');
  await startLogin({ provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0, resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true, pid: 9, mode: 'piped' }), now: () => 1000 });
  const st = await loginStatus(deps(root, {
    now: () => 3000,
    cliLoginStatusFn: () => 'done',
    relayStatusFn: async () => 'done',
    pipedInfoFn: () => ({ pid: 9, url: null, manualSeen: false, exited: true, code: 0, startedAt: 1000 }),
  }));
  assert.equal(st.state, 'done');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: 이전 시작(다른 pid)의 종료 기록은 이번 로그인의 실패로 치지 않는다', async () => {
  const root = tmpRoot('stale');
  await startLogin({ provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0, resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true, pid: 10, mode: 'piped' }), now: () => 2000 });
  const st = await loginStatus(deps(root, {
    now: () => 3000,
    pipedInfoFn: () => ({ pid: 9, url: null, manualSeen: true, exited: true, code: 1, startedAt: 1000 }),
  }));
  assert.equal(st.state, 'waiting');
  fs.rmSync(root, { recursive: true, force: true });
});

test('no user-facing message shows a manual-code instruction or the relay product name', async () => {
  const root = tmpRoot('msg');
  await startLogin({ provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0, resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true, pid: 9, mode: 'piped' }), now: () => 1000 });
  const st = await loginStatus(deps(root, { now: () => 3000, pipedInfoFn: () => ({ pid: 9, url: null, manualSeen: true, exited: true, code: 1, startedAt: 1000 }) }));
  assert.doesNotMatch(String(st.message), /코드|paste|TeamClaude/i);
  fs.rmSync(root, { recursive: true, force: true });
});
