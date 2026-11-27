// 2.0.65 — 그림 도구 부품(gen-image.py + 판정 도우미 codex-ready.py)의 동작 시험.
//
// 옮긴 기능: 참조 그림 뒤 `--` 구분 · 로컬 로그인 요금제 확인 · 결과 줄의 billing= · 크레딧 판정(도우미에 묻는다).
// 더한 안전장치: 도우미가 없거나 고장 난 것을 "쓸 수 있는 코덱스 계정 없음"과 가른다 — 그 전에는 도우미 실패가
// 조용히 돈이 드는 API 길로 넘어갔다.
//
// 지키는 것: 이 시험은 네트워크에 닿지 않는다. 중계기 포트를 두드리지 않고(도우미를 가짜로 바꾸거나 상태 파일을 준다),
// API 열쇠를 주지 않으며(모델 목록 조회 없음), 진짜 코덱스를 띄우지 않는다(가짜 프로세스). 설정 폴더는 임시 폴더다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'payload-src', 'tools');
const PROBE = path.join(REPO, 'tests', 'fixtures', 'gen_image_probe.py');
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-genimage-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// 이 PC 의 파이썬(설치 PC 에서는 동봉 파이썬이 돌린다). 없으면 시험을 건너뛴다 — 조용히 통과시키지 않는다.
let PY = null;
for (const [cmd, pre] of [['python', []], ['py', ['-3']]]) {
  try { execFileSync(cmd, [...pre, '-c', 'pass'], { stdio: 'ignore' }); PY = [cmd, pre]; break; } catch { /* 다음 */ }
}
const skip = PY ? false : '이 PC 에 파이썬이 없다';

// 가짜 도우미: readiness() 가 정해 둔 답을 돌려준다(중계기를 읽지 않는다).
const stubHelper = (result) => `import json\ndef readiness(status=None, cli_check=True):\n    return json.loads(${JSON.stringify(JSON.stringify(result))})\n`;
const READY = { kind: 'ready', ok: true, accounts: ['codex-1'], reason: 'ok', credit: null, raw: [] };
const CREDIT = { kind: 'credit', ok: true, accounts: ['codex-2'], reason: 'plan spent; paid credits', credit: { account: 'codex-2', balance: 1200, unlimited: false }, raw: [] };
const NONE = { kind: 'none', ok: false, accounts: [], reason: 'no codex account in teamclaude', credit: null, raw: [] };

// 임시 도구 폴더 하나. helper: 'real' | 'missing' | 글(그 내용으로 codex-ready.py 를 쓴다)
function makeTools(label, { helper = 'real', auth = null } = {}) {
  const base = path.join(tmp, label);
  const tools = path.join(base, 'tools');
  const cfg = path.join(base, 'claude');
  const codexHome = path.join(base, 'codex');
  for (const d of [tools, cfg, codexHome, path.join(base, 'temp')]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'gen-image.py'), path.join(tools, 'gen-image.py'));
  if (helper === 'real') fs.copyFileSync(path.join(SRC, 'codex-ready.py'), path.join(tools, 'codex-ready.py'));
  else if (helper !== 'missing') fs.writeFileSync(path.join(tools, 'codex-ready.py'), helper);
  if (auth !== null) fs.writeFileSync(path.join(codexHome, 'auth.json'), auth);
  const env = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'OPENAI_API_KEY']) delete env[k];
  Object.assign(env, {
    PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
    IRIS_ROOT: base, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codexHome,
    TEMP: path.join(base, 'temp'), TMP: path.join(base, 'temp'),
    OPENAI_API_KEY: '', // 빈 값 → 열쇠 없음(임시 설정 폴더에도 .env 가 없다) → 모델 목록 조회 · API 호출이 일어날 수 없다
  });
  return { base, tools, env, script: path.join(tools, 'gen-image.py') };
}

function py(t, args) {
  const r = spawnSync(PY[0], [...PY[1], ...args], { env: t.env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(r.error, undefined, r.error?.message);
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const gen = (t, args) => py(t, [t.script, ...args]);

// 가짜 로그인 파일: 요금제 칸만 뜻이 있고, 나머지는 "출력되면 안 되는 표식"이다.
function fakeAuth(plan) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const payload = { 'https://api.openai.com/auth': { chatgpt_plan_type: plan }, email: 'LEAK-MARKER-EMAIL', sub: 'LEAK-MARKER-SUB' };
  return JSON.stringify({ tokens: { id_token: `${b64({ alg: 'none' })}.${b64(payload)}.LEAK-MARKER-SIG`, access_token: 'LEAK-MARKER-ACCESS' } });
}

// ---------------------------------------------------------------------------
// 판정 도우미(codex-ready.py)
// ---------------------------------------------------------------------------

test('도우미: 상태 파일로 판정한다 — 요금제 남음 · 크레딧 · 없음(종료 코드까지)', { skip }, () => {
  const t = makeTools('helper');
  const run = (name, status, extra = []) => {
    const f = path.join(t.base, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify(status));
    return py(t, [path.join(t.tools, 'codex-ready.py'), '--status-file', f, '--no-cli-check', ...extra]);
  };
  const ready = run('ready', { accounts: [{ name: 'codex-1', provider: 'codex', status: 'active' }, { name: 'c@localhost', provider: 'anthropic' }] });
  assert.equal(ready.code, 0);
  assert.equal(ready.out.trim(), 'codex=ready accounts=codex-1');

  const credit = run('credit', {
    creditFallback: { codex: true },
    accounts: [{ name: 'codex-2', provider: 'codex', status: 'active', unavailable: 'quota', creditBlock: null, quota: { codexCredits: { balance: 1200 } } }],
  });
  assert.equal(credit.code, 0);
  assert.match(credit.out.trim(), /^codex=credit account=codex-2 balance=1200 accounts=codex-2 note=plan-spent-paying-with-credits$/);

  const off = run('credit-off', { creditFallback: { codex: false }, accounts: [{ name: 'codex-2', provider: 'codex', status: 'active', unavailable: 'quota', creditBlock: null }] });
  assert.equal(off.code, 1, '크레딧 대체가 꺼져 있으면 쓸 수 없다(돈을 짐작으로 쓰지 않는다)');
  assert.match(off.out, /codex=none reason=.*credit fallback off/);

  const oldRelay = run('old-relay', { creditFallback: { codex: true }, accounts: [{ name: 'codex-2', provider: 'codex', status: 'active', unavailable: 'quota' }] });
  assert.equal(oldRelay.code, 1, '중계기가 크레딧 칸을 주지 않으면(옛 판) 쓸 수 없다');

  const none = run('none', { accounts: [] }, ['--json']);
  assert.equal(none.code, 1);
  assert.equal(none.out.trim().split(/\r?\n/).at(-1), 'codex=none reason=no codex account in teamclaude');
});

// ---------------------------------------------------------------------------
// 그림 도구가 도우미의 답을 읽는 법
// ---------------------------------------------------------------------------

test('짝: 진짜 도우미의 판정을 그림 도구가 그대로 읽는다(요금제 = plan · 크레딧 = credit · 없음 = 폴백 사유)', { skip }, () => {
  const t = makeTools('pair');
  const ask = (name, status) => {
    const f = path.join(t.base, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify(status));
    const r = py(t, [PROBE, t.tools, 'pair', f]);
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out.trim().split(/\r?\n/).at(-1));
  };
  assert.deepEqual(ask('ready', { accounts: [{ name: 'codex-1', provider: 'codex' }] }), [true, ['codex-1'], 'ok', 'plan', null]);
  const credit = ask('credit', { creditFallback: { codex: true }, accounts: [{ name: 'codex-2', provider: 'codex', unavailable: 'quota', creditBlock: null, quota: { codexCredits: { balance: 50 } } }] });
  assert.deepEqual([credit[0], credit[1], credit[3], credit[4]], [true, ['codex-2'], 'credit', null]);
  assert.match(credit[2], /plan spent; paid credits \(codex-2 balance 50\)/);
  assert.deepEqual(ask('none', { accounts: [] }), [false, [], 'no codex account in teamclaude', null, null], '계정이 없는 것은 도우미 고장이 아니다(마지막 칸 null)');
});

test('--check: 도우미의 답에 따라 길과 과금 표시가 정해진다', { skip }, () => {
  const ready = gen(makeTools('check-ready', { helper: stubHelper(READY) }), ['--check']);
  assert.equal(ready.code, 0, ready.err);
  assert.match(ready.out, /teamclaude codex: available \(ok\) accounts=\['codex-1'\] billing=plan/);
  assert.match(ready.out, /route: provider=codex/);

  const credit = gen(makeTools('check-credit', { helper: stubHelper(CREDIT) }), ['--check']);
  assert.match(credit.out, /billing=credit/);
  assert.match(credit.out, /route: provider=codex/, '크레딧이 있으면 API 로 넘어가지 않는다');

  const none = gen(makeTools('check-none', { helper: stubHelper(NONE) }), ['--check']);
  assert.match(none.out, /teamclaude codex: unavailable \(no codex account in teamclaude\)/);
  assert.match(none.out, /route: provider=api \(codex unavailable: no codex account in teamclaude\)/, '계정이 정말 없을 때의 폴백은 예전과 같다');
  assert.ok(!none.out.includes('helper broken'));
});

// ---------------------------------------------------------------------------
// 도우미 고장 ≠ 계정 없음
// ---------------------------------------------------------------------------

const BROKEN = {
  '파일이 없다': 'missing',
  '문법이 깨졌다': 'def readiness(:\n',
  '불러오다 죽는다': 'raise RuntimeError("boom")\n',
  'readiness 가 없다': 'x = 1\n',
  '판정하다 죽는다': 'def readiness(status=None, cli_check=True):\n    raise ValueError("boom")\n',
  '답의 모양이 다르다': 'def readiness(status=None, cli_check=True):\n    return {"ok": True}\n',
};

test('도우미 고장: 길을 정하지 않았으면(auto) 유료 API 로 넘어가지 않고 까닭을 알리며 멈춘다', { skip }, () => {
  let n = 0;
  for (const [what, helper] of Object.entries(BROKEN)) {
    n += 1;
    const t = makeTools(`broken-${n}`, { helper });
    const promptFile = path.join(t.base, 'prompt.txt');
    const out = path.join(t.base, 'out.png');
    fs.writeFileSync(promptFile, 'a red apple');

    const made = gen(t, ['--prompt-file', promptFile, '--out', out]);
    assert.equal(made.code, 4, `${what}: 종료 코드 4 로 멈춘다 (out=${made.out} err=${made.err})`);
    assert.match(made.out, /codex helper broken: codex-ready\.py /, what);
    assert.match(made.out, /--provider codex .*--provider api/, `${what}: 길을 명시하는 법을 알린다`);
    assert.ok(!/api failed|provider=api|saved /.test(made.out), `${what}: API 길로 들어서지 않았다`);
    assert.ok(!fs.existsSync(out), `${what}: 아무것도 만들지 않았다`);

    const check = gen(t, ['--check']);
    assert.equal(check.code, 0, what);
    assert.match(check.out, /codex helper broken: /, what);
    assert.match(check.out, /route: provider=none \(stopped: codex helper broken\)/, what);
    assert.ok(!/route: provider=api/.test(check.out), `${what}: 판정만 볼 때도 API 길이라고 말하지 않는다`);
  }
});

test('도우미 고장: 길을 명시하면 그대로 따른다(--provider api · --exact-size = API, --provider codex = 코덱스)', { skip }, () => {
  const t = makeTools('broken-explicit', { helper: 'missing' });
  assert.match(gen(t, ['--check', '--provider', 'api']).out, /route: provider=api/);
  assert.match(gen(t, ['--check', '--exact-size']).out, /route: provider=api/);
  assert.match(gen(t, ['--check', '--provider', 'codex']).out, /route: provider=codex/);
  // 명시한 API 길은 실제로 API 로 간다 — 여기서는 열쇠가 없어 호출 전에 끝난다(네트워크 없음).
  const promptFile = path.join(t.base, 'prompt.txt');
  fs.writeFileSync(promptFile, 'a red apple');
  const api = gen(t, ['--prompt-file', promptFile, '--out', path.join(t.base, 'out.png'), '--provider', 'api']);
  assert.equal(api.code, 1);
  assert.match(api.out, /api failed: OPENAI_API_KEY not found/);
});

// ---------------------------------------------------------------------------
// 로컬 로그인 요금제 · 참조 그림
// ---------------------------------------------------------------------------

test('로컬 로그인: 요금제 이름만 내고, 로그인 파일의 값(토큰 · 계정)은 어디에도 내지 않는다', { skip }, () => {
  const line = (r) => r.out.split(/\r?\n/).find((l) => l.startsWith('local codex login:'));
  const none = gen(makeTools('plan-none', { helper: stubHelper(READY) }), ['--check']);
  assert.equal(line(none), 'local codex login: plan=none', '로그인 파일이 없으면 경고하지 않는다(중계기로만 쓰는 PC)');

  const free = gen(makeTools('plan-free', { helper: stubHelper(READY), auth: fakeAuth('free') }), ['--check']);
  assert.match(line(free), /^local codex login: plan=free !! /, '무료 요금제일 때만 귀띔');

  const pro = gen(makeTools('plan-pro', { helper: stubHelper(READY), auth: fakeAuth('pro') }), ['--check']);
  assert.equal(line(pro), 'local codex login: plan=pro');

  const junk = gen(makeTools('plan-junk', { helper: stubHelper(READY), auth: '{"tokens": 3' }), ['--check']);
  assert.equal(line(junk), 'local codex login: plan=unknown');
  const odd = gen(makeTools('plan-odd', { helper: stubHelper(READY), auth: fakeAuth('LEAK MARKER PLAN with spaces') }), ['--check']);
  assert.equal(line(odd), 'local codex login: plan=unknown', '요금제 칸이 짧은 영숫자가 아니면 그 값을 내보내지 않는다');

  for (const r of [free, pro, junk, odd]) assert.ok(!/LEAK/.test(r.out + r.err), '로그인 파일의 값이 출력에 섞이지 않는다');
});

test('참조 그림: -i 들 뒤에 -- 를 두고 요청문을 맨 끝에 — 요청문이 그림 경로로 삼켜지지 않는다', { skip }, () => {
  const t = makeTools('refs');
  const ask = (...refs) => {
    const r = py(t, [PROBE, t.tools, 'cmd', ...refs]);
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out.trim().split(/\r?\n/).at(-1)).cmd;
  };
  const two = ask('a.png', 'b.png');
  const sep = two.indexOf('--');
  assert.ok(sep > 0, '-- 가 있다');
  assert.deepEqual(two.slice(sep - 4, sep), ['-i', 'a.png', '-i', 'b.png']);
  assert.equal(two.length, sep + 2, '-- 뒤에는 요청문 하나뿐');
  assert.match(two[sep + 1], /<image_prompt>\nPROMPT-TEXT\n<\/image_prompt>/);

  const none = ask();
  assert.ok(!none.includes('--') && !none.includes('-i'), '참조 그림이 없으면 예전과 같은 명령');
  assert.match(none.at(-1), /PROMPT-TEXT/);
});
