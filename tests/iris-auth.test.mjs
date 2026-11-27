// 2.0.53 — 로그인 열쇠 감시 도구(iris-auth)를 설치 PC 에 싣는다(2026-11-02 사용자 신고:
// 설치 PC 의 IRIS 창 계정·보안에 「로그인 열쇠」 절이 통째로 없었다 — 도구가 개발 PC 에만 있었음).
// IRIS 창은 `_agent\shared\tools\iris-auth\status.mjs` 가 있어야 그 절을 켠다(Face daemon/paths.mjs authDir()).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UNPACK_ORDER, V2_LAYOUT } from '../installer/setup/unpack.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
const SRC = path.join(REPO, 'payload-src', 'tools', 'iris-auth');

test('잠금표: iris-auth 는 저장소 안 사본을 IRIS 창이 찾는 자리에 놓는다', () => {
  const p = LOCK.parts['iris-auth'];
  assert.ok(p, 'lock.json parts.iris-auth 없음');
  assert.equal(p.kind, 'dir');
  assert.equal(p.source, 'payload-src/tools/iris-auth');
  assert.equal(p.dest, '_agent/shared/tools/iris-auth');
  assert.equal(p.license, 'MIT');
});

test('풀기 순서·배치표에 들어 있다(조용히 빠지지 않게)', () => {
  assert.ok(UNPACK_ORDER.includes('iris-auth'));
  assert.equal(V2_LAYOUT['iris-auth'].mode, 'slot');
});

test('사본에 IRIS 창이 부르는 세 파일과 진입점이 있다', () => {
  for (const f of ['status.mjs', 'longkey.mjs', 'lib.mjs', 'AGENTS.md']) assert.ok(fs.existsSync(path.join(SRC, f)), `${f} 없음`);
  const status = fs.readFileSync(path.join(SRC, 'status.mjs'), 'utf8');
  assert.match(status, /--json/);
  assert.match(fs.readFileSync(path.join(SRC, 'longkey.mjs'), 'utf8'), /RESULT /);
});
// 개인 문자열 0건은 tests/repo-clean.test.mjs(추적 파일 전체 정화 검사)가 이 사본까지 함께 본다.

// ---------------------------------------------------------------------------
// 2.0.65 — 사본의 동작을 잰다(그 전에는 파일이 있는지만 봤다): 중계기 판정 칸(health) ·
// 공급자 빼기(--skip-provider) · 알림 기록 보존 · 겹쳐 돌아도 안전한 상태 파일 쓰기.
// 사본을 **임시 홈**에서만 돌린다 — 이 PC 의 진짜 상태 파일 · 로그인 파일 · 중계기 설정을 읽거나 쓰지 않는다.
// ---------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-auth-copy-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const DAY = 86400000;

// 임시 홈 하나: 중계기 설정(클로드 1 · 코덱스 1 · 구글 1) + 중계기 판정(구글 = 재로그인 필요).
function makeHome(label, { googleNeedsLogin = true } = {}) {
  const home = path.join(tmp, label);
  const tc = path.join(home, 'tc', 'teamclaude.json');
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.mkdirSync(path.dirname(tc), { recursive: true });
  fs.mkdirSync(path.join(home, 'claude', 'secrets'), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(tc, JSON.stringify({ accounts: [
    { name: 'a@localhost', type: 'oauth', provider: 'anthropic', refreshToken: 'R', refreshTokenExpiresAt: now + 20 * DAY, expiresAt: now + 3600e3 },
    { name: 'codex-1', type: 'oauth', provider: 'codex', refreshToken: 'R', expiresAt: now + 3600e3 },
    { name: 'google-1', type: 'oauth', provider: 'google', refreshToken: 'R', expiresAt: now + 3600e3 },
  ] }));
  fs.writeFileSync(path.join(path.dirname(tc), 'teamclaude.auth-health.json'), JSON.stringify({ accounts: [
    { name: 'a@localhost', provider: 'anthropic', state: 'checking', since: new Date(now - 60e3).toISOString() },
    ...(googleNeedsLogin ? [{ name: 'google-1', provider: 'google', state: 'needs-login', since: new Date(now - 60e3).toISOString() }] : []),
  ] }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, {
    USERPROFILE: home, HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    TEAMCLAUDE_CONFIG: tc,
    IRIS_LONGKEY_FILE: path.join(home, 'claude', 'secrets', 'iris-cli-token.json'),
    IRIS_AUTH_NOTIFY: '0', // 알림 풍선을 띄우지 않는다
  });
  return { home, env, statusFile: path.join(home, '.config', 'iris-auth-status.json') };
}

function runStatus(h, args) {
  const r = spawnSync(process.execPath, [path.join(SRC, 'status.mjs'), ...args], { env: h.env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const readStatus = (h) => JSON.parse(fs.readFileSync(h.statusFile, 'utf8'));

test('사본의 자체 시험(판정 · 1년 열쇠 · health · 공급자 빼기)이 통과한다', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // 시험 안에서 시험 실행기를 한 번 더 띄운다
  const files = fs.readdirSync(path.join(SRC, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
  // also-iris.test.mjs(2.0.66) = 두 자리 쓰기: 성공 · 300일 미만 · 한 자리 실패 · 쓰기 직전 대상 줄 바뀜 · 다른 줄 바이트 그대로.
  // 가짜 열쇠 교환 + 임시 폴더에서만 돈다(실제 로그인 · 네트워크 0).
  assert.deepEqual(files, ['also-iris.test.mjs', 'health.test.mjs', 'lib.test.mjs', 'longkey.test.mjs', 'skip-provider.test.mjs']);
  const r = spawnSync(process.execPath, ['--test', ...files.map((f) => path.join(SRC, 'tests', f))], { env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(r.status, 0, `사본 시험 실패:\n${(r.stdout ?? '').slice(-2000)}\n${(r.stderr ?? '').slice(-1000)}`);
});

test('health: 항목이 중계기 판정을 그대로 싣는다(checking 은 급한 것으로 세지 않는다 · 판정이 없으면 null)', () => {
  const h = makeHome('health');
  const r = runStatus(h, ['--json']);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  const item = (id) => out.items.find((i) => i.id === id);
  assert.equal(item('tc:anthropic:a@localhost').health, 'checking');
  assert.equal(item('tc:anthropic:a@localhost').level, 'ok');
  assert.equal(item('tc:google:google-1').health, 'needs-login');
  assert.equal(item('tc:google:google-1').level, 'expired');
  assert.equal(item('tc:codex:codex-1').health, null);
  assert.ok(!out.due.includes('tc:anthropic:a@localhost'));
  assert.ok(out.due.includes('tc:google:google-1'));
  assert.deepEqual(readStatus(h).items, out.items, '상태 파일에도 같은 항목이 들어간다');
  assert.ok(!/"R"|refreshToken/.test(fs.readFileSync(h.statusFile, 'utf8')), '열쇠 값은 상태 파일에 쓰지 않는다');
});

test('공급자 빼기: --skip-provider=google 이면 출력 · 상태 파일 · 급한 항목 어디에도 그 공급자가 없다', () => {
  const h = makeHome('skip');
  const all = JSON.parse(runStatus(h, ['--json']).out);
  const cut = JSON.parse(runStatus(h, ['--json', '--skip-provider=google']).out);
  assert.ok(all.items.some((i) => i.provider === 'google'));
  assert.ok(!cut.items.some((i) => i.provider === 'google'));
  assert.ok(!cut.due.some((id) => id.includes(':google:')));
  const rest = (o) => JSON.stringify(o.items.filter((i) => i.provider !== 'google'));
  assert.equal(rest(cut), rest(all), '다른 공급자의 항목은 빼기 전과 글자 하나 다르지 않다');
  assert.ok(!JSON.stringify(readStatus(h).items).includes('google'), '상태 파일에도 없다');
});

test('알림 기록 보존: 뺀 조합마다 칸이 따로다 — 한쪽 호출이 다른 쪽의 기록을 지우지 않는다', () => {
  const h = makeHome('memo');
  const memoAll = { key: 'k-all', at: 111 };
  const memoCut = { key: 'k-cut', at: 222 };
  fs.writeFileSync(h.statusFile, JSON.stringify({ items: [], notify: memoAll, notify_skip_google: memoCut }));

  // ① 알림 없이 보기만 하는 호출(빼든 안 빼든)은 두 칸을 그대로 둔다.
  runStatus(h, ['--json', '--skip-provider=google']);
  assert.deepEqual(readStatus(h).notify, memoAll);
  assert.deepEqual(readStatus(h).notify_skip_google, memoCut);
  runStatus(h, ['--json']);
  assert.deepEqual(readStatus(h).notify, memoAll);
  assert.deepEqual(readStatus(h).notify_skip_google, memoCut);

  // ② 구글을 빼고 본 호출이 "알릴 것 없음"이면 **자기 칸만** 지운다(예전에는 하나뿐인 칸을 지워, 빼지 않는 호출이 같은 알림을 다시 띄웠다).
  runStatus(h, ['--json', '--notify', '--skip-provider=google']);
  assert.equal(readStatus(h).notify_skip_google, null, '뺀 쪽 칸: 알릴 것이 없어 비워짐');
  assert.deepEqual(readStatus(h).notify, memoAll, '빼지 않는 쪽 칸은 그대로');

  // ③ 옛 상태 파일(칸 하나)도 그대로 읽힌다.
  fs.writeFileSync(h.statusFile, JSON.stringify({ items: [], notify: memoAll }));
  runStatus(h, ['--json']);
  assert.deepEqual(readStatus(h).notify, memoAll);
});

test('상태 파일 쓰기: 쓰는 호출 여럿이 겹쳐 돌아도(창이 여러 개 · 점검이 겹침) 파일이 깨지지 않고 임시 파일이 남지 않는다', async () => {
  const h = makeHome('overlap');
  const one = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(SRC, 'status.mjs'), '--json'], { env: h.env, stdio: 'ignore', windowsHide: true });
    c.on('exit', (code) => resolve(code));
    c.on('error', () => resolve(-1));
  });
  const codes = await Promise.all(Array.from({ length: 8 }, one));
  assert.deepEqual(codes, Array(8).fill(0));
  assert.ok(Array.isArray(readStatus(h).items), '상태 파일이 JSON 으로 읽힌다');
  const left = fs.readdirSync(path.dirname(h.statusFile)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(left, [], '임시 파일이 남지 않는다');
  assert.match(fs.readFileSync(path.join(SRC, 'status.mjs'), 'utf8'), /\$\{STATUS_FILE\}\.\$\{process\.pid\}\.tmp/, '임시 파일 이름에 프로세스 번호가 들어간다');
});

test('--hook: IRIS 열쇠에 알릴 것이 없으면 아무것도 내지 않는다 · 있으면 한 줄 — 중계기 계정 일은 여기서 알리지 않는다', () => {
  const quiet = makeHome('hook-quiet'); // 구글이 재로그인 필요여도 IRIS 열쇠 일이 아니다
  const q = runStatus(quiet, ['--hook']);
  assert.equal(q.code, 0, q.err);
  assert.equal(q.out, '');

  const due = makeHome('hook-due');
  fs.writeFileSync(due.env.IRIS_LONGKEY_FILE, JSON.stringify({ token: 'T', expiresAt: Date.now() + DAY, email: null }));
  const d = runStatus(due, ['--hook']);
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /^\[IRIS 인증\] .+\n$/);
  assert.equal(d.out.trim().split('\n').length, 1, '한 줄만');
  assert.ok(!d.out.includes('T"') && !/token/i.test(d.out), '열쇠 값은 내지 않는다');
});

// 2026-11-27 코드 검토: 훅과 창의 점검이 같은 옛 알림 기록을 읽은 뒤, 창이 새 기록을 저장하고 훅이 늦게 저장하면
// 새 기록이 옛 기록으로 되돌아가 다음 점검에서 같은 알림이 되풀이된다. 그래서 --hook 은 읽기만 한다.
test('--hook 은 상태 파일을 쓰지 않는다 — 없으면 만들지 않고, 있으면 한 글자도 바꾸지 않는다(알림 기록 포함)', () => {
  // ① 상태 파일이 아직 없다 → 훅이 돌아도 생기지 않는다.
  const fresh = makeHome('hook-nowrite-fresh');
  fs.writeFileSync(fresh.env.IRIS_LONGKEY_FILE, JSON.stringify({ token: 'T', expiresAt: Date.now() + DAY, email: null }));
  const a = runStatus(fresh, ['--hook']);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /^\[IRIS 인증\] /, '알림 한 줄은 그대로 낸다');
  assert.ok(!fs.existsSync(fresh.statusFile), '상태 파일을 만들지 않는다');
  assert.deepEqual(fs.readdirSync(path.dirname(fresh.statusFile)), [], '임시 파일도 만들지 않는다');

  // ② 창이 방금 새 알림 기록을 저장했다 → 뒤늦게 끝난 훅이 그것을 옛 값으로 되돌리지 않는다.
  const h = makeHome('hook-nowrite-existing');
  fs.writeFileSync(h.env.IRIS_LONGKEY_FILE, JSON.stringify({ token: 'T', expiresAt: Date.now() + DAY, email: null }));
  const written = `${JSON.stringify({ updatedAt: 'by-the-window', items: [], notify: { key: 'new-key', at: 999 }, notify_skip_google: { key: 'k2', at: 2 } }, null, 2)}`;
  fs.writeFileSync(h.statusFile, written);
  const before = fs.statSync(h.statusFile).mtimeMs;
  for (const args of [['--hook'], ['--hook', '--skip-provider=google'], ['--hook', '--notify']]) {
    const r = runStatus(h, args);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(h.statusFile, 'utf8'), written, `${args.join(' ')}: 상태 파일이 바뀌면 안 된다`);
  }
  assert.equal(fs.statSync(h.statusFile).mtimeMs, before, '다시 쓰지도 않았다(시각 그대로)');
  assert.deepEqual(fs.readdirSync(path.dirname(h.statusFile)).filter((f) => f.endsWith('.tmp')), []);

  // ③ 쓰는 쪽은 여전히 쓴다(창의 점검).
  assert.equal(runStatus(h, ['--json']).code, 0);
  assert.notEqual(fs.readFileSync(h.statusFile, 'utf8'), written);
  assert.deepEqual(readStatus(h).notify, { key: 'new-key', at: 999 }, '창의 점검은 자기 알림 기록을 이어 간다');
});

// ---------------------------------------------------------------------------
// 2.0.66 — 1년 열쇠 두 자리 쓰기(`longkey.mjs --account <name> --also-iris`): 설치 화면의 권장 카드가 부르는 꼴 그대로
// 프로그램으로 띄워 본다. 승인을 끝내지 않으므로(받는 창구를 두드리지 않는다) 열쇠 교환 요청은 한 번도 나가지 않는다.
// ---------------------------------------------------------------------------
function runLongKey(h, args) {
  const r = spawnSync(process.execPath, [path.join(SRC, 'longkey.mjs'), ...args], {
    env: { ...h.env, IRIS_AUTH_RELOAD: '0' }, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  const line = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('RESULT ')).pop() ?? null;
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', line, result: line ? JSON.parse(line.slice(7)) : null };
}

test('1년 열쇠 두 자리 쓰기: 승인이 없으면 어느 자리에도 쓰지 않고, RESULT 가 자리별 결과와 까닭을 싣는다(이름 · 열쇠 없음)', () => {
  const h = makeHome('longkey-timeout');
  const tc = h.env.TEAMCLAUDE_CONFIG;
  const before = fs.readFileSync(tc);
  const r = runLongKey(h, ['--account', 'a@localhost', '--also-iris', '--no-open', '--timeout', '1']);
  assert.equal(r.code, 1, r.err);
  assert.deepEqual(r.result, { ok: false, target: 'both', relay: 'skipped', iris: 'skipped', reason: 'timeout', error: '시간 초과(승인 없음)' });
  assert.ok(fs.readFileSync(tc).equals(before), '중계기 설정은 한 바이트도 바뀌지 않는다');
  assert.equal(fs.existsSync(h.env.IRIS_LONGKEY_FILE), false, 'IRIS 창 세션용 파일을 만들지 않는다');
  assert.deepEqual(fs.readdirSync(path.dirname(tc)).sort(), ['teamclaude.auth-health.json', 'teamclaude.json'], '사본 · 임시 파일도 없다');

  // 승인 주소: 받는 자리는 이 PC(localhost), 열쇠는 없다. 계정 이름은 주소의 귀띔 칸에만 있고 다른 줄에는 찍지 않는다.
  const url = /https:\/\/claude\.ai\/oauth\/authorize\?\S+/.exec(r.out)?.[0];
  assert.ok(url, '승인 주소를 표준 출력에 찍는다');
  const u = new URL(url);
  assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+\/callback$/);
  assert.equal(u.searchParams.get('scope'), 'user:inference user:profile');
  for (const k of ['access_token', 'refresh_token', 'token', 'code_verifier']) assert.equal(u.searchParams.get(k), null, `승인 주소에 ${k} 없음`);
  assert.ok(!r.out.replace(url, '').includes('a@localhost'), '사람이 읽는 줄 · RESULT 에 계정 이름을 찍지 않는다');
});

test('1년 열쇠 두 자리 쓰기: --account 없이 --also-iris 만 주면 승인을 띄우기 전에 거절한다', () => {
  const h = makeHome('longkey-usage');
  const r = runLongKey(h, ['--also-iris', '--no-open', '--timeout', '1']);
  assert.equal(r.code, 1);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.reason, 'usage');
  assert.ok(!/oauth\/authorize/.test(r.out), '승인 주소를 만들지 않는다');
});

test('1년 열쇠 도구의 머리말이 두 자리 쓰기의 순서와 실패 처리를 적어 둔다(되돌리지 않는다 · 반쪽은 미완)', () => {
  const src = fs.readFileSync(path.join(SRC, 'longkey.mjs'), 'utf8');
  assert.match(src, /--also-iris/);
  assert.match(src, /① 중계기 계정 줄 → ② IRIS 창 세션용 파일/);
  assert.match(src, /전체를 사본으로 되돌리지 않는다/);
  assert.match(src, /"반쪽"은 고장이 아니라 미완/);
});
