// 2.0.54 (2026-11-04 교장선생님 PC 신고 "Claude 로그인 뒤 「옮겨 담는 중」에서 가만히 멈춤 — 멈춘 건지 진행 중인지 모름"):
//   ① 옮겨 담기는 1초 확인 안에서 끝까지 기다리지 않고 뒤에서 돈다 — 그동안 확인은 cli-done + 시작 시각을 돌려 화면이 "n초째"를 그린다
//   ② 그래도 한 번만 시도한다(확인이 여러 번 와도)
//   ③ 기다림 한도 60초, 시간 초과·프로필 확인 실패는 두 번째 브라우저(대화형 로그인)를 띄우지 않고 이유를 그대로 돌려준다
//   ④ 실패 이유(CLI 마지막 말)는 토큰을 가린 채 화면까지 간다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLogin, loginStatus, resetRelayJobs } from '../installer/lib/online.mjs';
import { relayImport, relayFailureLine, RELAY_IMPORT_TIMEOUT_MS } from '../installer/lib/login.mjs';
import { writeReceipt, newReceiptV2, readReceipt } from '../installer/lib/receipt.mjs';

function tmpRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `iris-relayprog-${name}-`));
  writeReceipt(root, newReceiptV2({ version: '2.0.54', root }));
  return root;
}
async function started(root) {
  resetRelayJobs();
  await startLogin({
    provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
}
const deps = (root, over = {}) => ({
  provider: 'claude', root,
  resolveConfigPathFn: () => path.join(root, 'tc.json'),
  cliLoginStatusFn: () => 'done',
  relayStatusFn: async () => 'pending',
  countFn: async () => 0,
  probe: async () => ({ reachable: true, status: 200 }),
  relayWaitMs: 20,
  ...over,
});

test('① 느린 옮겨 담기: 확인은 곧바로 cli-done + 시작 시각, 일이 끝나면 다음 확인에서 done', async () => {
  const root = tmpRoot('slow');
  await started(root);
  let imports = 0; let release;
  const gate = new Promise((r) => { release = r; });
  let clock = 5000;
  const d = deps(root, {
    now: () => clock,
    relayImportFn: async () => { imports++; await gate; return { ok: true, method: 'import' }; },
    countFn: async () => (imports ? 1 : 0),
  });
  const t0 = Date.now();
  const first = await loginStatus(d);
  assert.ok(Date.now() - t0 < 1000, '확인 한 번이 옮겨 담기를 끝까지 기다리지 않는다');
  assert.equal(first.state, 'cli-done');
  assert.equal(first.relayStartedAt, 5000, '화면이 경과 초를 그릴 시작 시각');
  assert.equal(first.relayPhase, 'importing');
  clock = 9000;
  const second = await loginStatus(d);
  assert.equal(second.state, 'cli-done');
  assert.equal(second.relayStartedAt, 5000, '시작 시각은 그대로(새로 시작하지 않음)');
  assert.equal(imports, 1, '② 확인이 여러 번 와도 옮겨 담기는 한 번');
  release();
  await new Promise((r) => setTimeout(r, 10));
  const third = await loginStatus(d);
  assert.equal(third.state, 'done');
  assert.equal(imports, 1);
  const rec = readReceipt(root).login.claude;
  assert.equal(rec.relayAttempts, 1);
  assert.equal(rec.relayMs, 4000, '걸린 시간이 영수증에 남는다');
  fs.rmSync(root, { recursive: true, force: true });
});

test('① 빠른 옮겨 담기(대부분)는 첫 확인에서 바로 done', async () => {
  const root = tmpRoot('fast');
  await started(root);
  const r = await loginStatus(deps(root, { now: () => 1000, relayImportFn: async () => ({ ok: true, method: 'import' }), countFn: async () => 1 }));
  assert.equal(r.state, 'done');
  fs.rmSync(root, { recursive: true, force: true });
});

test('③④ 시간 초과: failed + import-timeout + 이유, 다음 확인도 같은 까닭(덮지 않음)', async () => {
  const root = tmpRoot('timeout');
  await started(root);
  const d = deps(root, { now: () => 1000, relayImportFn: async () => ({ ok: false, method: 'import', reason: 'import-timeout', detail: '60초 안에 끝나지 않았습니다(계정 확인 질문에 답이 오지 않음)' }) });
  const first = await loginStatus(d);
  assert.deepEqual({ state: first.state, reason: first.reason }, { state: 'failed', reason: 'import-timeout' });
  assert.match(first.detail, /60초/);
  const second = await loginStatus(d);
  assert.deepEqual({ state: second.state, reason: second.reason }, { state: 'failed', reason: 'import-timeout' });
  assert.match(second.detail, /60초/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('다시 로그인하면 앞 시도의 이유·시작 시각을 지운다', async () => {
  const root = tmpRoot('reset');
  await started(root);
  await loginStatus(deps(root, { now: () => 1000, relayImportFn: async () => ({ ok: false, method: 'import', reason: 'import-profile', detail: 'x' }) }));
  await started(root);
  const rec = readReceipt(root).login.claude;
  assert.equal(rec.relayDetail, null);
  assert.equal(rec.relayStartedAt, null);
  assert.equal(rec.relayAttempts, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

const RI = { provider: 'claude', root: 'C:\\NOVA', nodeDir: 'C:\\NOVA\\_agent\\shared\\tools\\node', teamclaudeConfigPath: 'C:\\FAKE\\teamclaude.json' };

test('③ relayImport: import 에 60초 한도를 건다', async () => {
  let opts;
  await relayImport({ ...RI, runFn: async (e, a, o) => { opts = o; return { code: 0, out: '', err: '' }; } });
  assert.equal(opts.timeoutMs, RELAY_IMPORT_TIMEOUT_MS);
  assert.equal(RELAY_IMPORT_TIMEOUT_MS, 60000);
});

test('③ relayImport: 시간 초과 → 대화형 로그인을 띄우지 않고 import-timeout', async () => {
  const spawned = [];
  const r = await relayImport({ ...RI, runFn: async () => ({ code: null, out: '', err: '', timedOut: true }), spawnFn: (...a) => { spawned.push(a); return { unref() {} }; } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'import-timeout');
  assert.match(r.detail, /60초/);
  assert.equal(spawned.length, 0, '두 번째 브라우저를 띄우지 않는다');
});

test('③ relayImport: 프로필 확인 실패 → 대화형 로그인 없이 import-profile + CLI 의 말', async () => {
  const spawned = [];
  const r = await relayImport({ ...RI, runFn: async () => ({ code: 1, out: '', err: 'Could not identify OAuth account — HTTP 403: forbidden\nRetry with valid credentials, or pass --name to add the account without profile detection.' }), spawnFn: (...a) => { spawned.push(a); return { unref() {} }; } });
  assert.equal(r.reason, 'import-profile');
  assert.match(r.detail, /Could not identify OAuth account — HTTP 403/);
  assert.equal(spawned.length, 0);
});

test('relayImport: 그 밖의 실패는 예전처럼 대화형 로그인(method login) + 이유도 함께', async () => {
  const spawned = [];
  const r = await relayImport({ ...RI, runFn: async () => ({ code: 1, out: '', err: 'boom' }), spawnFn: (...a) => { spawned.push(a); return { unref() {} }; } });
  assert.equal(r.method, 'login');
  assert.equal(r.detail, 'boom');
  assert.equal(spawned.length, 1);
});

test('④ relayFailureLine: 토큰처럼 보이는 문자열을 가리고 240자로 자른다', () => {
  const t = relayFailureLine({ code: 1, err: 'error: bad token sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and ' + 'Z'.repeat(60) + ' ' + 'y'.repeat(300) });
  assert.doesNotMatch(t, /AAAAAAAAAAAA/);
  assert.doesNotMatch(t, /Z{48}/);
  assert.ok(t.length <= 240);
  assert.equal(relayFailureLine({ code: 7, out: '', err: '' }), '종료 코드 7');
});
