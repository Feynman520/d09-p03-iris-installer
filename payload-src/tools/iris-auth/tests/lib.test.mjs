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

// 2026-11-10 재현: 1년 열쇠로 갱신한 뒤에도 중계기 메모리가 옛 만료일을 붙들어 상태 파일이 'expiring'·옛 만료일로 남았다
// (중계기가 다시 켜질 때까지 노란 점·대시보드 띠가 안 사라짐). 상태 파일이 설정 파일보다 옛것이면 그 판정을 믿지 않는다.
test('갱신 뒤 낡은 중계기 상태(expiring·옛 만료일)는 무시', () => {
  const h = (o) => ({ accounts: [{ name: 'a@x', provider: 'anthropic', ...o }] });
  const renewed = { name: 'a@x', hasRefresh: true, longKey: true, longKeyAt: NOW - 3600e3, refreshTokenExpiresAt: NOW + 365 * DAY, expiresAt: NOW + 365 * DAY };
  // ① 갱신 시각이 상태 판정 시각보다 늦음 + 만료일이 다름 → 정상
  let r = collect({ now: NOW, tcAccounts: [renewed], health: h({ state: 'expiring', since: new Date(NOW - 10 * 3600e3).toISOString(), refreshTokenExpiresAt: new Date(NOW + 2 * DAY).toISOString() }) });
  assert.equal(r.items[0].level, 'ok'); assert.deepEqual(r.due, []);
  // ② 만료일만 달라도(갱신 시각 기록 없음) 낡은 것으로 본다
  r = collect({ now: NOW, tcAccounts: [{ ...renewed, longKeyAt: null }], health: h({ state: 'expiring', since: new Date(NOW).toISOString(), refreshTokenExpiresAt: new Date(NOW + 2 * DAY).toISOString() }) });
  assert.equal(r.items[0].level, 'ok');
  // ③ 1년 열쇠 갱신 뒤의 낡은 '재로그인 필요'도 무시(메모리에 옛 갱신 열쇠가 남아 죽은 열쇠로 보임)
  r = collect({ now: NOW, tcAccounts: [renewed], health: h({ state: 'needs-login', since: new Date(NOW - 5 * 3600e3).toISOString() }) });
  assert.equal(r.items[0].level, 'ok');
  // ④ 상태 판정이 갱신보다 나중이고 만료일도 같으면 그대로 믿는다(진짜 곧 만료·진짜 끊김)
  r = collect({ now: NOW, tcAccounts: [renewed], health: h({ state: 'needs-login', since: new Date(NOW - 60e3).toISOString(), refreshTokenExpiresAt: new Date(NOW + 365 * DAY).toISOString() }) });
  assert.equal(r.items[0].level, 'expired');
  const plain = { name: 'a@x', hasRefresh: true, refreshTokenExpiresAt: NOW + 5 * DAY, expiresAt: NOW + 3600e3 };
  r = collect({ now: NOW, tcAccounts: [plain], health: h({ state: 'expiring', since: new Date(NOW).toISOString(), refreshTokenExpiresAt: new Date(NOW + 5 * DAY).toISOString() }) });
  assert.equal(r.items[0].level, 'soon');
  // ⑥ 코덱스 검토 4번: 갱신 뒤에 새 열쇠가 진짜로 거절되면(판정 시각 since 는 갱신 전 그대로) 숨기지 않는다
  r = collect({ now: NOW, tcAccounts: [renewed], health: h({ state: 'needs-login', since: new Date(NOW - 5 * 3600e3).toISOString(), lastFail: { at: new Date(NOW - 60e3).toISOString(), kind: 'invalid' } }) });
  assert.equal(r.items[0].level, 'expired');
  // 일시적 네트워크 실패는 근거가 아니다(옛 판정은 여전히 낡은 것)
  r = collect({ now: NOW, tcAccounts: [renewed], health: h({ state: 'expiring', since: new Date(NOW - 5 * 3600e3).toISOString(), refreshTokenExpiresAt: new Date(NOW + 2 * DAY).toISOString(), lastFail: { at: new Date(NOW - 60e3).toISOString(), kind: 'network' } }) });
  assert.equal(r.items[0].level, 'ok');
  // 갱신 시각 근거 없이 만료일만 다른 '재로그인 필요'는 바로잡지 않는다
  r = collect({ now: NOW, tcAccounts: [{ ...renewed, longKeyAt: null }], health: h({ state: 'needs-login', since: new Date(NOW).toISOString(), refreshTokenExpiresAt: new Date(NOW + 2 * DAY).toISOString() }) });
  assert.equal(r.items[0].level, 'expired');
  // ⑤ 정제 함수가 갱신 시각을 넘긴다
  const s = sanitizeTeamclaude({ accounts: [{ name: 'a@x', type: 'oauth', irisLongKey: true, irisLongKeyAt: '2026-11-09T23:30:17.485Z', accessToken: 'SECRET' }] });
  assert.equal(s[0].longKeyAt, Date.parse('2026-11-09T23:30:17.485Z'));
  assert.ok(!JSON.stringify(s).includes('SECRET'));
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
