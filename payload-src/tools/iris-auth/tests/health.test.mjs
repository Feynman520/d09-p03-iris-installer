// 항목의 중계기 판정 칸(health, 2026-11-25) — 화면이 대시보드와 같은 낱말(정상 / 확인 중 / 재로그인 필요)을 쓰게 하는 칸.
//   지키는 것: checking(갱신이 한 번 실패해 다시 확인하는 중)은 급한 것으로 세지 않는다(level 그대로 · due 에 안 들어감) ·
//   needs-login 은 지금까지처럼 level = expired · 판정이 없으면 null(옛 중계기) · 구글 계정도 같은 규칙.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../lib.mjs';

const NOW = Date.UTC(2026, 10, 25, 10, 0, 0);
const DAY = 86400000;
const claude = { name: 'a@localhost', provider: 'anthropic', hasRefresh: true, refreshTokenExpiresAt: NOW + 20 * DAY, expiresAt: NOW + 3600e3, longKey: false };
const google = { name: 'google-1', provider: 'google', hasRefresh: true, refreshTokenExpiresAt: null, expiresAt: NOW + 3600e3, longKey: false };
const health = (...accounts) => ({ accounts });
const item = (r, id) => r.items.find((i) => i.id === id);

test('checking: health 만 싣고 level 은 그대로 — 급한 항목(due)에 들어가지 않는다', () => {
  const r = collect({ now: NOW, tcAccounts: [claude, google], health: health(
    { name: 'a@localhost', provider: 'anthropic', state: 'checking', since: new Date(NOW - 60e3).toISOString() },
    { name: 'google-1', provider: 'google', state: 'checking', since: new Date(NOW - 60e3).toISOString() }) });
  assert.equal(item(r, 'tc:anthropic:a@localhost').health, 'checking');
  assert.equal(item(r, 'tc:anthropic:a@localhost').level, 'ok');
  assert.equal(item(r, 'tc:google:google-1').health, 'checking');
  assert.equal(item(r, 'tc:google:google-1').level, 'ok');
  assert.deepEqual(r.due, []);
  assert.equal(r.worst, 'ok');
});

test('needs-login: health = needs-login · level = expired(지금까지와 같음) · 판정이 없으면 health = null', () => {
  const r = collect({ now: NOW, tcAccounts: [claude, google], health: health(
    { name: 'google-1', provider: 'google', state: 'needs-login', since: new Date(NOW - 60e3).toISOString() }) });
  assert.equal(item(r, 'tc:google:google-1').health, 'needs-login');
  assert.equal(item(r, 'tc:google:google-1').level, 'expired');
  assert.equal(item(r, 'tc:anthropic:a@localhost').health, null);
  assert.equal(item(r, 'tc:anthropic:a@localhost').level, 'ok');
  assert.ok(r.due.includes('tc:google:google-1'));
  const none = collect({ now: NOW, tcAccounts: [claude], health: null });
  assert.equal(item(none, 'tc:anthropic:a@localhost').health, null);
});
