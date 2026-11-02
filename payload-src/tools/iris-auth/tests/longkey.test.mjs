// node --test tests/longkey.test.mjs — 발급 결과를 중계기 계정에 넣는 규칙(네트워크·실제 파일 없음)
import test from 'node:test';
import assert from 'node:assert/strict';
import { patchAccount, toRecord, buildAuthorizeUrl } from '../longkey.mjs';

const rec = toRecord({ access_token: 'NEW', expires_in: 31536000, account: { email_address: 'a@localhost' } }, 1000);

test('승인 주소 = 대답 생성 권한만', () => {
  const u = new URL(buildAuthorizeUrl({ port: 1, challenge: 'c', state: 's' }));
  assert.equal(u.searchParams.get('scope'), 'user:inference');
  assert.equal(u.searchParams.get('login_hint'), null);
});

test('같은 계정이면 열쇠 교체·갱신 열쇠 삭제·만료일 기록', () => {
  const cfg = { accounts: [{ name: 'a@localhost', type: 'oauth', accessToken: 'OLD', refreshToken: 'R', expiresAt: 5, refreshTokenExpiresAt: 6 }] };
  const a = patchAccount(cfg, 'a@localhost', rec);
  assert.equal(a.accessToken, 'NEW');
  assert.equal('refreshToken' in a, false);
  assert.equal(a.expiresAt, 1000 + 31536000e3);
  assert.equal(a.refreshTokenExpiresAt, a.expiresAt);
  assert.equal(a.irisLongKey, true);
});

test('승인 계정이 다르면 아무것도 바꾸지 않음', () => {
  const cfg = { accounts: [{ name: 'b@localhost', type: 'oauth', accessToken: 'OLD', refreshToken: 'R' }] };
  assert.throws(() => patchAccount(cfg, 'b@localhost', rec), /다름/);
  assert.equal(cfg.accounts[0].accessToken, 'OLD');
  assert.equal(cfg.accounts[0].refreshToken, 'R');
});

test('없는 계정·코덱스 계정은 거절', () => {
  assert.throws(() => patchAccount({ accounts: [] }, 'a@localhost', rec), /없음/);
  assert.throws(() => patchAccount({ accounts: [{ name: 'a@localhost', provider: 'codex' }] }, 'a@localhost', rec), /없음/);
});
