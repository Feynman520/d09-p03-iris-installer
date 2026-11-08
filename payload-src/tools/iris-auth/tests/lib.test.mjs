// node --test tests/lib.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { levelOf, daysLeft, collect, summaryLine, shouldNotify, DAY, NOTIFY_EVERY_MS } from '../lib.mjs';
import { sanitizeTeamclaude, sanitizeCli, sanitizeLongKey } from '../status.mjs';

const NOW = Date.UTC(2026, 9, 15, 5, 0, 0);

test('levelOf 경계', () => {
  assert.equal(levelOf(NOW - 1, NOW), 'expired');
  assert.equal(levelOf(NOW + 3 * DAY, NOW), 'soon');
  assert.equal(levelOf(NOW + 3 * DAY + 1, NOW), 'ok');
  assert.equal(levelOf(null, NOW), 'unknown');
  assert.equal(daysLeft(NOW + 2.9 * DAY, NOW), 2);
  assert.equal(daysLeft(NOW - DAY, NOW), 0);
});

test('중계기 계정: 30일 열쇠는 refreshTokenExpiresAt, 1년 열쇠는 expiresAt', () => {
  const r = collect({ now: NOW, tcAccounts: [
    { name: 'a@x', hasRefresh: true, refreshTokenExpiresAt: NOW + 2 * DAY, expiresAt: NOW + 3600e3 },
    { name: 'b@x', hasRefresh: false, longKey: true, expiresAt: NOW + 300 * DAY },
  ] });
  assert.equal(r.items[0].level, 'soon');
  assert.equal(r.items[0].renew, 'teamclaude-longkey'); // 30일 열쇠도 갱신 = 1년 열쇠 발급
  assert.equal(r.items[0].longKey, false);
  assert.equal(r.items[1].level, 'ok');
  assert.equal(r.items[1].renew, 'teamclaude-longkey');
  assert.deepEqual(r.due, ['tc:anthropic:a@x']);
});

test('중계기 상태 파일의 재로그인 필요가 만료일보다 우선', () => {
  const r = collect({ now: NOW, tcAccounts: [{ name: 'a@x', hasRefresh: true, refreshTokenExpiresAt: NOW + 20 * DAY }],
    health: { accounts: [{ name: 'a@x', provider: 'anthropic', state: 'needs-login' }] } });
  assert.equal(r.items[0].level, 'expired');
  assert.equal(r.worst, 'expired');
});

test('IRIS: 열쇠가 비면 만료, 1년 열쇠가 살아 있으면 터미널 열쇠는 알림 제외', () => {
  const empty = collect({ now: NOW, cli: { hasRefresh: false, refreshTokenExpiresAt: NOW - DAY } });
  assert.equal(empty.items[0].level, 'expired');
  assert.equal(empty.worst, 'expired');
  const withLong = collect({ now: NOW, cli: { hasRefresh: false }, longKey: { expiresAt: NOW + 200 * DAY } });
  assert.equal(withLong.items.find(i => i.id === 'iris:login').optional, true);
  assert.equal(withLong.worst, 'ok');
  assert.equal(summaryLine(withLong), null);
});

test('요약 문장과 알림 간격', () => {
  const r = collect({ now: NOW, cli: { hasRefresh: true, refreshTokenExpiresAt: NOW + DAY } });
  assert.match(summaryLine(r), /곧 만료 1개: IRIS 로그인\(D-1\)/);
  const first = shouldNotify(r, null, NOW);
  assert.equal(first.notify, true);
  assert.equal(shouldNotify(r, { key: first.key, at: NOW }, NOW + 1000).notify, false);
  assert.equal(shouldNotify(r, { key: first.key, at: NOW }, NOW + NOTIFY_EVERY_MS).notify, true);
});

test('정제 함수는 열쇠 값을 넘기지 않는다', () => {
  const secret = 'sk-ant-SECRET';
  const all = JSON.stringify([
    sanitizeTeamclaude({ accounts: [{ name: 'a', type: 'oauth', accessToken: secret, refreshToken: secret, expiresAt: 1 }] }),
    sanitizeCli({ claudeAiOauth: { accessToken: secret, refreshToken: secret, refreshTokenExpiresAt: '2' } }, null),
    sanitizeLongKey({ token: secret, expiresAt: 3, email: 'e' }),
  ]);
  assert.equal(all.includes(secret), false);
});
