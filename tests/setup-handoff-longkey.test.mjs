// 2.0.66 — 인수 문서의 클로드 1년 열쇠 한 줄(`claudeLongKey`).
// 설치 화면의 「1년 열쇠 받기(권장)」 카드 결과를 영수증에서 읽어 적는다. 안내용일 뿐 **상태 판정에는 쓰지 않는다** —
// 받지 않았어도 설치는 ready 다. 이름 · 열쇠는 없다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildHandoff, writeHandoff, readHandoff, refreshHandoffAfterOnline, refreshHandoffLongKey,
  claudeLongKeyBlock, handoffPath, LONGKEY_HOW_TO,
} from '../installer/setup/handoff.mjs';
import { SETUP_STAGE_IDS } from '../installer/lib/receipt.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'handoff-longkey-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
function newRoot(label) {
  const root = path.join(tmp, `${label}-${seq += 1}`);
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  return root;
}
// 아홉 단계와 클로드 로그인이 끝난 영수증. claude = 영수증 online.logins.claude 에 더할 칸(1년 열쇠 카드의 결과).
function receiptWith(claude = {}) {
  const setup = {};
  for (const id of SETUP_STAGE_IDS) setup[id] = { status: 'done', recorded: {}, pending: [] };
  return {
    schema: 2, package: { name: 'IRIS', version: '2.0.0' }, setup,
    login: { claude: { state: 'done' } },
    online: { relay: { state: 'done', accounts: 1 }, logins: { claude: { state: 'done', cli: 'done', relay: 'done', ...claude } } },
  };
}
const ctxFor = (root, receipt, subscriptions = ['claude']) => ({
  root, fs, log: () => {}, manifest: { package: { name: 'IRIS', version: '2.0.0' } },
  choice: { subscriptions, leadAgent: subscriptions.includes('claude') ? 'claude' : 'chatgpt' }, receipt,
});
const EXPIRES = Date.UTC(2027, 10, 27, 3, 4, 5);

test('한 줄의 네 값: 받음(만료일) · 일부 · 안 받음(어디서 받는지) · 클로드를 고르지 않음', () => {
  assert.deepEqual(claudeLongKeyBlock(receiptWith({ longKey: true, longKeyExpiresAt: EXPIRES, longKeySlots: { relay: 'ok', iris: 'ok' } }), ['claude']),
    { state: 'received', expiresAt: '2027-11-27T03:04:05.000Z', howTo: null });
  assert.deepEqual(claudeLongKeyBlock(receiptWith({ longKey: false, longKeyExpiresAt: EXPIRES, longKeySlots: { relay: 'ok', iris: 'failed' } }), ['claude']),
    { state: 'partial', expiresAt: '2027-11-27T03:04:05.000Z', howTo: LONGKEY_HOW_TO });
  assert.deepEqual(claudeLongKeyBlock(receiptWith(), ['claude']), { state: 'not-received', expiresAt: null, howTo: LONGKEY_HOW_TO });
  assert.deepEqual(claudeLongKeyBlock(receiptWith({ longKey: false, longKeyExpiresAt: null, longKeySlots: null }), ['claude']), { state: 'not-received', expiresAt: null, howTo: LONGKEY_HOW_TO });
  assert.deepEqual(claudeLongKeyBlock(receiptWith({ longKey: true, longKeyExpiresAt: EXPIRES }), ['chatgpt']), { state: 'not-needed', expiresAt: null, howTo: null });
  assert.deepEqual(claudeLongKeyBlock(null, ['claude']), { state: 'not-received', expiresAt: null, howTo: LONGKEY_HOW_TO }, '영수증이 없어도 던지지 않는다');
  assert.equal(LONGKEY_HOW_TO, '설정 → 계정 · 보안 → 1년 열쇠 받기');
});

test('인수 문서에 그 한 줄이 실린다 — 받지 않았어도 설치 상태는 ready 다(판정에 쓰지 않는다)', () => {
  const none = buildHandoff(ctxFor(newRoot('build-none'), receiptWith()), { assumeDone: ['checks'] });
  assert.equal(none.state, 'ready');
  assert.deepEqual(none.claudeLongKey, { state: 'not-received', expiresAt: null, howTo: LONGKEY_HOW_TO });

  const got = buildHandoff(ctxFor(newRoot('build-got'), receiptWith({ longKey: true, longKeyExpiresAt: EXPIRES })), { assumeDone: ['checks'] });
  assert.equal(got.state, 'ready');
  assert.equal(got.claudeLongKey.state, 'received');
  // 그 한 줄만 다르다 — 나머지 칸은 받았든 안 받았든 같다.
  const strip = ({ claudeLongKey, writtenAt, setupCompletedAt, ...rest }) => rest;
  assert.deepEqual(strip(got), strip(none));

  const codex = buildHandoff(ctxFor(newRoot('build-codex'), receiptWith(), ['chatgpt']), { assumeDone: ['checks'] });
  assert.equal(codex.claudeLongKey.state, 'not-needed');
});

test('로그인 뒤 갱신(refreshHandoffAfterOnline)도 그 한 줄을 영수증대로 적는다', () => {
  const root = newRoot('after-online');
  writeHandoff(ctxFor(root, { ...receiptWith(), login: {}, online: {} }), { assumeDone: ['checks'] });
  assert.equal(readHandoff(root, { fs }).claudeLongKey.state, 'not-received');
  const r = refreshHandoffAfterOnline(ctxFor(root, receiptWith({ longKey: true, longKeyExpiresAt: EXPIRES })));
  assert.equal(r.handoff.state, 'ready');
  assert.deepEqual(r.handoff.claudeLongKey, { state: 'received', expiresAt: '2027-11-27T03:04:05.000Z', howTo: null });
});

test('카드 결과가 났을 때(refreshHandoffLongKey): 그 한 칸만 갈아 끼운다 — 다른 칸은 읽은 그대로', () => {
  const root = newRoot('one-key');
  writeHandoff(ctxFor(root, receiptWith()), { assumeDone: ['checks'] });
  // Face 가 이미 고쳐 둔 칸 + 설치기가 모르는 칸이 있다.
  const mid = readHandoff(root, { fs });
  mid.messenger.prompted = true;
  mid.somethingFaceAdded = { keep: 'me' };
  fs.writeFileSync(handoffPath(root), `${JSON.stringify(mid, null, 2)}\n`);

  const r = refreshHandoffLongKey({ root, fs, receipt: receiptWith({ longKey: true, longKeyExpiresAt: EXPIRES, longKeySlots: { relay: 'ok', iris: 'ok' } }) });
  assert.equal(r.written, true);
  const after2 = readHandoff(root, { fs });
  assert.deepEqual(after2.claudeLongKey, { state: 'received', expiresAt: '2027-11-27T03:04:05.000Z', howTo: null });
  const { claudeLongKey: a, ...restAfter } = after2;
  const { claudeLongKey: b, ...restBefore } = mid;
  assert.deepEqual(restAfter, restBefore, '쓴 시각 · 상태 · 메신저 안내 · 모르는 칸까지 그대로');
  assert.deepEqual(Object.keys(after2), Object.keys(mid), '칸의 순서도 그대로');
});

test('refreshHandoffLongKey: 내용이 같으면 쓰지 않는다 · 인수 문서가 없으면 만들지 않는다', () => {
  const root = newRoot('unchanged');
  const receipt = receiptWith({ longKey: true, longKeyExpiresAt: EXPIRES });
  writeHandoff(ctxFor(root, receipt), { assumeDone: ['checks'] });
  const bytes = fs.readFileSync(handoffPath(root));
  const mtime = fs.statSync(handoffPath(root)).mtimeMs;
  const r = refreshHandoffLongKey({ root, fs, receipt });
  assert.deepEqual({ written: r.written, reason: r.reason }, { written: false, reason: 'unchanged' });
  assert.ok(fs.readFileSync(handoffPath(root)).equals(bytes));
  assert.equal(fs.statSync(handoffPath(root)).mtimeMs, mtime);

  const empty = newRoot('none');
  const n = refreshHandoffLongKey({ root: empty, fs, receipt });
  assert.deepEqual({ written: n.written, reason: n.reason }, { written: false, reason: 'no-handoff' });
  assert.equal(fs.existsSync(handoffPath(empty)), false);
});

test('옛 판이 쓴 인수 문서(그 칸이 없음)에도 한 칸을 더할 수 있다', () => {
  const root = newRoot('old');
  fs.writeFileSync(handoffPath(root), `${JSON.stringify({ schema: 1, state: 'ready', subscriptions: ['claude'], messenger: { installed: true, prompted: true } }, null, 2)}\n`);
  const r = refreshHandoffLongKey({ root, fs, receipt: receiptWith({ longKey: false, longKeySlots: { relay: 'failed', iris: 'ok' }, longKeyExpiresAt: EXPIRES }) });
  assert.equal(r.written, true);
  assert.deepEqual(readHandoff(root, { fs }), {
    schema: 1, state: 'ready', subscriptions: ['claude'], messenger: { installed: true, prompted: true },
    claudeLongKey: { state: 'partial', expiresAt: '2027-11-27T03:04:05.000Z', howTo: LONGKEY_HOW_TO },
  });
});
