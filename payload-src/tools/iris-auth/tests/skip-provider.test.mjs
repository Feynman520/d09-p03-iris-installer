// --skip-provider: 아직 열지 않은 공급자의 계정을 알림 · 상태 파일 · 출력 전에 뺀다(2026-11-27).
import test from 'node:test';
import assert from 'node:assert/strict';
import { skipProvidersOf, withoutProviders, memoField, memosOf } from '../status.mjs';
import { collect, shouldNotify } from '../lib.mjs';

const NOW = Date.parse('2026-11-27T00:00:00Z');
const acct = (name, provider, extra = {}) => ({ name, provider, hasRefresh: true, longKey: false, refreshTokenExpiresAt: null, expiresAt: null, longKeyAt: null, ...extra });

test('인자 읽기: 없으면 빈 목록, 쉼표로 여럿, 소문자로, 이상한 값은 버림', () => {
  assert.deepEqual(skipProvidersOf(['--json', '--notify']), []);
  assert.deepEqual(skipProvidersOf(['--json', '--skip-provider=google']), ['google']);
  assert.deepEqual(skipProvidersOf(['--skip-provider=Google, codex', '--skip-provider=google']), ['google', 'codex']);
  assert.deepEqual(skipProvidersOf(['--skip-provider=', '--skip-provider=a b', '--skip-provider']), []);
  assert.deepEqual(skipProvidersOf(undefined), []);
});

test('빼기: 목록이 비면 받은 그대로(같은 객체), 그 공급자만 빠진다, 공급자 칸이 없으면 anthropic 으로 본다', () => {
  const list = [acct('a', 'anthropic'), acct('c', 'codex'), acct('g', 'google'), { name: 'old' }];
  assert.equal(withoutProviders(list, []), list);
  assert.equal(withoutProviders(list, undefined), list);
  assert.deepEqual(withoutProviders(list, ['google']).map(a => a.name), ['a', 'c', 'old']);
  assert.deepEqual(withoutProviders(list, ['anthropic']).map(a => a.name), ['c', 'g']);
});

test('알림 기록 칸: 인자가 없으면 예전 칸(notify), 뺀 조합마다 따로 — 서로의 기록을 지우지 않는다', () => {
  assert.equal(memoField([]), 'notify');
  assert.equal(memoField(undefined), 'notify');
  assert.equal(memoField(['google']), 'notify_skip_google');
  assert.equal(memoField(['google', 'codex']), memoField(['codex', 'google']), '순서가 달라도 같은 칸');
  const prev = { updatedAt: 'x', items: [1], worst: 'ok', notify: { key: 'k1', at: 1 }, notify_skip_google: { key: 'k2', at: 2 }, other: 9 };
  const m = memosOf(prev);
  assert.deepEqual(m, { notify: { key: 'k1', at: 1 }, notify_skip_google: { key: 'k2', at: 2 } }, '알림 기록 칸만 고른다');
  m[memoField(['google'])] = null; // 구글을 빼고 본 호출이 "알릴 것 없음"
  assert.deepEqual(m.notify, { key: 'k1', at: 1 }, '빼지 않고 보는 호출의 기록은 그대로다');
  assert.deepEqual(memosOf(null), { notify: null });
  assert.deepEqual(memosOf({ items: [] }), { notify: null }, '옛 파일(칸 없음)은 예전처럼 null');
});

test('뺀 뒤의 판정: 구글 계정이 「재로그인 필요」여도 알릴 것이 없다 — 클로드 · 코덱스 판정은 빼기 전과 같다', () => {
  const tc = [acct('a', 'anthropic', { expiresAt: NOW + 200 * 86400_000, longKey: true, hasRefresh: false }), acct('c', 'codex'), acct('g', 'google')];
  const health = { accounts: [{ name: 'g', provider: 'google', state: 'needs-login' }] };
  const all = collect({ tcAccounts: tc, health, cli: null, longKey: null, now: NOW });
  const cut = collect({ tcAccounts: withoutProviders(tc, ['google']), health, cli: null, longKey: null, now: NOW });
  assert.ok(all.items.some(i => i.provider === 'google'), '빼기 전에는 구글 항목이 있다');
  assert.ok(!cut.items.some(i => i.provider === 'google'), '뺀 뒤에는 구글 항목이 없다');
  assert.ok(!cut.due.some(id => id.includes(':google:')), '급한 항목에도 없다');
  const same = (r) => JSON.stringify(r.items.filter(i => i.provider !== 'google'));
  assert.equal(same(cut), same(all), '클로드 · 코덱스 항목은 글자 하나 다르지 않다');
  if (!cut.due.length) assert.equal(shouldNotify(cut, null, NOW).notify, false, '구글만 문제였다면 알리지 않는다');
});
