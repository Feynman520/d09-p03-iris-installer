// node --test tests/also-iris.test.mjs — 승인 한 번으로 받은 1년 열쇠를 두 자리(중계기 계정 줄 + IRIS 창 세션용 파일)에 넣는 규칙.
// 실제 로그인 · 실제 열쇠 받기 · 네트워크 0: 열쇠 교환은 가짜 함수, 브라우저는 열지 않고, 승인은 이 시험이 자기 PC 의
// 127.0.0.1 받는 창구를 직접 두드려 흉내 낸다. 파일은 임시 폴더에만 쓴다(자리를 인자로 넘겨 진짜 설정을 찾지 않게 한다).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, relayConfigForBoth } from '../longkey.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-longkey-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const NAME = 'a@localhost';
const OTHER = 'b@localhost';
const YEAR = 31536000;
const KEY = 'NEW-LONG-KEY-VALUE';

function target() {
  return { name: NAME, type: 'oauth', source: 'import', accessToken: 'OLD-A', refreshToken: 'OLD-R', expiresAt: 5, refreshTokenExpiresAt: 6 };
}
function makeHome(label, { accounts } = {}) {
  const dir = path.join(tmp, label);
  const configFile = path.join(dir, 'tc', 'teamclaude.json');
  const longKeyFile = path.join(dir, 'claude', 'secrets', 'iris-cli-token.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const cfg = {
    proxy: { port: 1, apiKey: 'tc-K' }, upstream: 'https://example.invalid', switchThreshold: 1, blockedModels: [],
    accounts: accounts ?? [
      { name: 'codex-1', type: 'oauth', provider: 'codex', importFrom: 'X', displayName: 'c' },
      target(),
      { name: OTHER, type: 'oauth', accessToken: 'B-A', refreshToken: 'B-R', expiresAt: 7 },
    ],
  };
  fs.writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}\n`);
  return { dir, configFile, longKeyFile, raw: fs.readFileSync(configFile, 'utf8') };
}

// 계정 한 줄이 파일 안에서 차지하는 글(2칸 들여쓰기 파일의 accounts 배열 안 = 4칸).
const blockOf = (acct) => JSON.stringify(acct, null, 2).split('\n').map((l) => `    ${l}`).join('\n');

/** 도구를 한 번 돌린다. 승인 주소가 찍히면 그 받는 창구(127.0.0.1)를 두드려 승인을 흉내 낸다. */
async function drive(h, { extra = [], token, approve = true, deps = {}, base = ['--account', NAME, '--also-iris'], paths } = {}) {
  let out = '';
  let url = null;
  const reloads = [];
  const result = await run(['node', 'longkey.mjs', ...base, '--no-open', '--timeout', approve ? '20' : '1', ...extra], {
    write: (s) => {
      out += s;
      const m = /https:\/\/claude\.ai\/oauth\/authorize\?\S+/.exec(out);
      if (!m || url) return;
      url = m[0];
      if (!approve) return;
      const u = new URL(url);
      const port = new URL(u.searchParams.get('redirect_uri')).port;
      setImmediate(() => { fetch(`http://127.0.0.1:${port}/callback?code=C&state=${encodeURIComponent(u.searchParams.get('state'))}`).then((r) => r.text()).catch(() => {}); });
    },
    openFn: () => { throw new Error('--no-open 인데 브라우저를 열려고 했다'); },
    exchangeFn: async () => token ?? { access_token: KEY, expires_in: YEAR, scope: 'user:inference user:profile', account: { email_address: NAME } },
    reloadFn: async (port) => { reloads.push(port); return true; },
    paths: paths ?? { configFile: h.configFile, longKeyFile: h.longKeyFile },
    ...deps,
  });
  const resultLine = out.split('\n').filter((l) => l.startsWith('RESULT ')).pop() ?? null;
  return { result, out, url, reloads, resultLine, printed: resultLine ? JSON.parse(resultLine.slice(7)) : null };
}
const leftovers = (h) => fs.readdirSync(path.dirname(h.configFile)).filter((f) => f !== 'teamclaude.json');

test('두 자리 쓰기: 승인 한 번으로 받은 열쇠가 중계기 계정 줄과 IRIS 창 세션용 파일에 함께 들어간다', async () => {
  const h = makeHome('both');
  const r = await drive(h);
  assert.deepEqual({ ok: r.result.ok, target: r.result.target, relay: r.result.relay, iris: r.result.iris }, { ok: true, target: 'both', relay: 'ok', iris: 'ok' });
  assert.deepEqual(r.printed, r.result, '마지막 RESULT 줄 = 돌려준 값');
  assert.equal(r.result.expiresIn, YEAR);
  assert.ok(r.result.expiresAt > Date.now() + 300 * 86400000);

  const cfg = JSON.parse(fs.readFileSync(h.configFile, 'utf8'));
  const a = cfg.accounts.find((x) => x.name === NAME);
  assert.equal(a.accessToken, KEY);
  assert.equal('refreshToken' in a, false, '갱신 열쇠는 지운다');
  assert.equal(a.irisLongKey, true);
  assert.equal(a.refreshTokenExpiresAt, a.expiresAt);

  const iris = JSON.parse(fs.readFileSync(h.longKeyFile, 'utf8'));
  assert.equal(iris.token, KEY);
  assert.equal(iris.expiresAt, a.expiresAt, '두 자리의 만료일이 같다(같은 열쇠)');

  assert.deepEqual(r.reloads, [1], '설정 파일에 적힌 포트의 중계기에 다시 읽기를 한 번 부탁한다');
  assert.equal(r.result.reloaded, true);
});

test('두 자리 쓰기: 중계기 설정의 다른 줄 · 다른 칸은 바이트 그대로다(끝 줄바꿈 포함) · 바꾸기 전 사본이 남는다', async () => {
  const h = makeHome('bytes');
  await drive(h);
  const after = fs.readFileSync(h.configFile, 'utf8');
  const block = blockOf(target());
  const at = h.raw.indexOf(block);
  assert.ok(at > 0, '시험 준비: 대상 줄의 글을 원래 파일에서 찾는다');
  const head = h.raw.slice(0, at);
  const tail = h.raw.slice(at + block.length);
  assert.ok(after.startsWith(head), '대상 줄 앞(다른 칸 · 앞 계정)은 한 바이트도 다르지 않다');
  assert.ok(after.endsWith(tail), '대상 줄 뒤(뒤 계정 · 끝 줄바꿈)는 한 바이트도 다르지 않다');
  assert.ok(tail.endsWith(']\n}\n'), '시험 준비: 원래 파일은 줄바꿈으로 끝난다');
  const mid = after.slice(head.length, after.length - tail.length);
  assert.ok(mid.includes(KEY) && !mid.includes('OLD-R'));

  const backups = leftovers(h).filter((f) => /^teamclaude-before-longkey-.+\.json$/.test(f));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(h.configFile), backups[0]), 'utf8'), h.raw, '사본 = 바꾸기 전 설정 그대로');
  assert.deepEqual(leftovers(h).filter((f) => !backups.includes(f)), [], '임시 파일이 남지 않는다');
});

test('출력 · RESULT 에 열쇠 값과 계정 이름이 없다(승인 주소의 계정 귀띔 칸 말고는)', async () => {
  const h = makeHome('quiet');
  const r = await drive(h);
  assert.ok(!r.out.includes(KEY), '열쇠 값을 찍지 않는다');
  assert.ok(!r.resultLine.includes('@'), 'RESULT 줄에 계정 이름이 없다');
  assert.ok(!('email' in r.result) && !('account' in r.result));
  assert.ok(!r.out.replace(r.url, '').includes(NAME), '사람이 읽는 줄에도 계정 이름을 찍지 않는다');
  const u = new URL(r.url);
  assert.equal(u.searchParams.get('login_hint'), NAME, '승인 주소는 그 계정을 귀띔한다');
  assert.equal(u.searchParams.get('scope'), 'user:inference user:profile', '중계기의 사용량 조회에 필요한 권한까지');
  for (const k of ['access_token', 'refresh_token', 'token']) assert.equal(u.searchParams.get(k), null, `승인 주소에 ${k} 없음`);
});

test('300일보다 짧게 발급되면 어느 자리에도 쓰지 않는다', async () => {
  const h = makeHome('short');
  const r = await drive(h, { token: { access_token: KEY, expires_in: 100 * 86400, account: { email_address: NAME } } });
  assert.deepEqual({ ok: r.result.ok, relay: r.result.relay, iris: r.result.iris, reason: r.result.reason }, { ok: false, relay: 'skipped', iris: 'skipped', reason: 'short-lived' });
  assert.equal(fs.readFileSync(h.configFile, 'utf8'), h.raw, '중계기 설정은 한 바이트도 바뀌지 않는다');
  assert.equal(fs.existsSync(h.longKeyFile), false, 'IRIS 창 세션용 파일을 만들지 않는다');
  assert.deepEqual(leftovers(h), [], '사본 · 임시 파일도 만들지 않는다');
  assert.deepEqual(r.reloads, []);
});

test('승인한 계정이 대상과 다르면 어느 자리에도 쓰지 않는다(다른 계정의 열쇠를 나눠 넣지 않는다)', async () => {
  const h = makeHome('mismatch');
  const r = await drive(h, { token: { access_token: KEY, expires_in: YEAR, account: { email_address: 'c@localhost' } } });
  assert.deepEqual({ ok: r.result.ok, relay: r.result.relay, iris: r.result.iris, reason: r.result.reason }, { ok: false, relay: 'failed', iris: 'skipped', reason: 'account-mismatch' });
  assert.equal(fs.readFileSync(h.configFile, 'utf8'), h.raw);
  assert.equal(fs.existsSync(h.longKeyFile), false);
  assert.deepEqual(leftovers(h), []);
  assert.ok(!r.resultLine.includes('@'), '실패 글에도 계정 이름을 싣지 않는다');
});

test('한 자리 실패 ①: 중계기에 그 계정 줄이 없으면 그 자리만 실패 — IRIS 자리는 쓰고 RESULT 가 자리별로 말한다', async () => {
  const h = makeHome('no-line', { accounts: [{ name: OTHER, type: 'oauth', accessToken: 'B-A', refreshToken: 'B-R', expiresAt: 7 }] });
  const r = await drive(h);
  assert.deepEqual({ ok: r.result.ok, partial: r.result.partial, relay: r.result.relay, iris: r.result.iris, reason: r.result.reason },
    { ok: false, partial: true, relay: 'failed', iris: 'ok', reason: 'relay-account-missing' });
  assert.equal(fs.readFileSync(h.configFile, 'utf8'), h.raw, '중계기 설정은 그대로');
  assert.equal(JSON.parse(fs.readFileSync(h.longKeyFile, 'utf8')).token, KEY);
  assert.deepEqual(r.reloads, [], '중계기 설정을 바꾸지 않았으면 다시 읽기를 부탁하지 않는다');
  assert.deepEqual(leftovers(h), []);
});

test('한 자리 실패 ②: 중계기 설정 파일이 없으면 그 자리만 실패(다른 자리의 설정을 찾아 나서지 않는다)', async () => {
  const h = makeHome('no-config');
  const r = await drive(h, { paths: { configFile: path.join(h.dir, 'nowhere', 'teamclaude.json'), longKeyFile: h.longKeyFile } });
  assert.deepEqual({ ok: r.result.ok, relay: r.result.relay, iris: r.result.iris, reason: r.result.reason }, { ok: false, relay: 'failed', iris: 'ok', reason: 'relay-config-missing' });
  assert.equal(fs.readFileSync(h.configFile, 'utf8'), h.raw);
});

test('중계기 설정 자리: TEAMCLAUDE_CONFIG 가 정해져 있으면 그 파일만 본다(다른 자리를 찾는 함수를 부르지 않는다)', () => {
  const never = () => { throw new Error('다른 자리를 찾으면 안 된다'); };
  assert.equal(relayConfigForBoth({ TEAMCLAUDE_CONFIG: 'X:/soul/teamclaude.json' }, never), 'X:/soul/teamclaude.json');
  assert.equal(relayConfigForBoth({}, () => 'found-elsewhere'), 'found-elsewhere', '정해져 있지 않을 때만 예전처럼 찾는다');
  assert.equal(relayConfigForBoth({ TEAMCLAUDE_CONFIG: '' }, () => null), null);
});

test('한 자리 실패 ③: IRIS 자리를 쓰지 못하면 그 자리만 실패 — 이미 쓴 중계기 자리를 되돌리지 않는다', async () => {
  const h = makeHome('no-iris');
  fs.mkdirSync(path.dirname(path.dirname(h.longKeyFile)), { recursive: true });
  fs.writeFileSync(path.dirname(h.longKeyFile), 'not a folder'); // secrets 자리에 파일이 있어 그 밑에 쓸 수 없다
  const r = await drive(h);
  assert.deepEqual({ ok: r.result.ok, partial: r.result.partial, relay: r.result.relay, iris: r.result.iris, reason: r.result.reason },
    { ok: false, partial: true, relay: 'ok', iris: 'failed', reason: 'iris-write-failed' });
  const a = JSON.parse(fs.readFileSync(h.configFile, 'utf8')).accounts.find((x) => x.name === NAME);
  assert.equal(a.accessToken, KEY, '중계기 자리의 1년 열쇠는 그 자리에서 유효하다 — 그대로 둔다');
  assert.equal(fs.readFileSync(path.dirname(h.longKeyFile), 'utf8'), 'not a folder');
  assert.deepEqual(r.reloads, [1]);
});

test('쓰기 직전에 대상 줄이 바뀌어 있으면 포기한다 — 그사이 중계기가 저장한 것을 덮지 않는다', async () => {
  const h = makeHome('raced-target');
  let relayWrote = null;
  const r = await drive(h, { deps: { beforeCommit: () => {
    const cfg = JSON.parse(fs.readFileSync(h.configFile, 'utf8'));
    Object.assign(cfg.accounts.find((x) => x.name === NAME), { accessToken: 'RELAY-REFRESHED', refreshToken: 'RELAY-R2', expiresAt: 99 });
    relayWrote = `${JSON.stringify(cfg, null, 2)}\n`;
    fs.writeFileSync(h.configFile, relayWrote);
  } } });
  assert.deepEqual({ relay: r.result.relay, iris: r.result.iris, reason: r.result.reason }, { relay: 'failed', iris: 'ok', reason: 'relay-changed' });
  assert.equal(fs.readFileSync(h.configFile, 'utf8'), relayWrote, '중계기가 방금 쓴 글 그대로');
  assert.deepEqual(leftovers(h), [], '포기했으면 사본 · 임시 파일을 남기지 않는다');
  assert.deepEqual(r.reloads, []);
});

test('쓰기 직전에 다른 줄만 바뀌어 있으면 그 변경을 살린 채 대상 줄만 바꾼다', async () => {
  const h = makeHome('raced-other');
  const r = await drive(h, { deps: { beforeCommit: () => {
    const cfg = JSON.parse(fs.readFileSync(h.configFile, 'utf8'));
    Object.assign(cfg.accounts.find((x) => x.name === OTHER), { accessToken: 'B-REFRESHED', expiresAt: 77 });
    cfg.switchThreshold = 0.9;
    fs.writeFileSync(h.configFile, `${JSON.stringify(cfg, null, 2)}\n`);
  } } });
  assert.equal(r.result.relay, 'ok');
  const cfg = JSON.parse(fs.readFileSync(h.configFile, 'utf8'));
  assert.equal(cfg.accounts.find((x) => x.name === OTHER).accessToken, 'B-REFRESHED', '그사이 다른 계정에 생긴 변경이 살아 있다');
  assert.equal(cfg.switchThreshold, 0.9, '그사이 다른 칸에 생긴 변경이 살아 있다');
  assert.equal(cfg.accounts.find((x) => x.name === NAME).accessToken, KEY);
});

test('승인이 없으면(시간 초과) 어느 자리에도 쓰지 않고 RESULT 가 까닭을 말한다', async () => {
  const h = makeHome('timeout');
  const r = await drive(h, { approve: false });
  assert.deepEqual({ ok: r.result.ok, relay: r.result.relay, iris: r.result.iris, reason: r.result.reason }, { ok: false, relay: 'skipped', iris: 'skipped', reason: 'timeout' });
  assert.equal(fs.readFileSync(h.configFile, 'utf8'), h.raw);
  assert.equal(fs.existsSync(h.longKeyFile), false);
});

test('--also-iris 는 --account 와 함께만 쓴다(없으면 승인을 띄우기 전에 거절)', async () => {
  const h = makeHome('usage');
  const r = await drive(h, { base: ['--also-iris'], approve: false });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.reason, 'usage');
  assert.equal(r.url, null, '승인 주소를 만들지 않는다');
});

test('예전 두 길은 그대로다: --account 만 주면 중계기 자리만 · 아무것도 안 주면 IRIS 자리만', async () => {
  const one = makeHome('account-only');
  const a = await drive(one, { base: ['--account', NAME] });
  assert.deepEqual({ ok: a.result.ok, target: a.result.target }, { ok: true, target: 'teamclaude' });
  assert.equal(JSON.parse(fs.readFileSync(one.configFile, 'utf8')).accounts.find((x) => x.name === NAME).accessToken, KEY);
  assert.equal(fs.existsSync(one.longKeyFile), false, 'IRIS 자리는 건드리지 않는다');

  const two = makeHome('iris-only');
  const b = await drive(two, { base: [] });
  assert.equal(b.result.ok, true);
  assert.equal('target' in b.result, false, '예전 RESULT 모양 그대로');
  assert.equal(JSON.parse(fs.readFileSync(two.longKeyFile, 'utf8')).token, KEY);
  assert.equal(fs.readFileSync(two.configFile, 'utf8'), two.raw, '중계기 설정은 건드리지 않는다');
  assert.equal(new URL(b.url).searchParams.get('scope'), 'user:inference');
});
