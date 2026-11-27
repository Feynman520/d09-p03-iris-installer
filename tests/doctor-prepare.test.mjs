// 2.0.66 — 손 안 가는 Doctor 계정 준비 호출(installer/lib/doctor-prepare.mjs).
//
// 설치기는 온라인 묶음 끝과 업데이트 끝에서 설치본의 Doctor 에게 `link auto` 를 **한 번** 부른다:
// 통신 0 · 브라우저 0 · 만들 것이 없으면 Doctor 가 아무것도 쓰지 않는 명령이다(그 약속은 Doctor 원본의 시험이 묶는다).
// 이 파일은 설치기 쪽 약속만 본다 — 언제 부르고 언제 안 부르는가 · 무엇으로 부르는가 · 실패 · 시간 초과를 어떻게 넘기는가.
//
// **진짜 Doctor 를 실행하지 않는다.** 임시 설치 폴더에 가짜 Doctor(아래 FAKE_DOCTOR)를 놓고 부른다.
// 가짜 Doctor 는 임시 폴더 밖에 쓰지 않고, 통신하지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  prepareDoctorAccounts, doctorPrepareLine, doctorPrepareEnv, doctorEntryFor,
  DOCTOR_PREPARE_ARGS, DOCTOR_PREPARE_TIMEOUT_MS,
} from '../installer/lib/doctor-prepare.mjs';
import { nodeExeFor } from '../installer/lib/handoff.mjs';
import { OFFLINE_ENV } from '../lib/net.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-doctor-prep-'));
const spawned = new Set();
after(() => {
  for (const pid of spawned) { try { process.kill(pid); } catch { /* 이미 끝남 */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 가짜 Doctor: 받은 인자 · 환경 · 작업 폴더를 **설치 폴더 밖**의 기록 파일에 적고, fake.json 이 시키는 대로 군다.
//   ok      link auto 의 약속을 흉내 낸다 — 처음에는 Doctor 집에 파일 둘을 만들고, 다음부터는 아무것도 쓰지 않는다
//   fail    답 없이 3 으로 끝난다          garbage  JSON 이 아닌 글(계정 이름이 섞인)을 낸다
//   leak    약속에 없는 칸(계정 이름 · 경로)을 섞어 답한다     hang  끝나지 않고 0.2초마다 표시 파일을 고쳐 쓴다
const FAKE_DOCTOR = `// 가짜 Doctor(시험용) — 진짜가 아니다
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'fake.json'), 'utf8'));
const root = path.resolve(here, '..', '..', '..', '..');
fs.appendFileSync(cfg.log, JSON.stringify({ argv: process.argv.slice(2), exe: process.execPath, cwd: process.cwd(), env: process.env, pid: process.pid }) + '\\n');
const home = path.join(root, '_agent', 'doctor');
if (cfg.mode === 'ok') {
  const card = path.join(home, 'cards', 'claude.json');
  const conf = path.join(home, 'codex-home', 'config.toml');
  const out = { v: 1, claude: { linked: false, why: 'has-card' }, codex: { prepared: false, why: 'ready' } };
  if (!fs.existsSync(card)) { fs.mkdirSync(path.dirname(card), { recursive: true }); fs.writeFileSync(card, '{"kind":"claude"}'); out.claude = { linked: true, why: 'linked' }; }
  if (!fs.existsSync(conf)) { fs.mkdirSync(path.dirname(conf), { recursive: true }); fs.writeFileSync(conf, 'model_provider = "openai"\\n'); out.codex = { prepared: true, why: 'prepared' }; }
  process.stdout.write(JSON.stringify(out) + '\\n');
  process.exit(0);
} else if (cfg.mode === 'fail') {
  process.exit(3);
} else if (cfg.mode === 'garbage') {
  process.stdout.write('IRIS Doctor ' + cfg.account + ' \\u2014 ' + cfg.secretPath + '\\n');
  process.exit(0);
} else if (cfg.mode === 'leak') {
  process.stdout.write(JSON.stringify({ v: 1, account: cfg.account, home: cfg.secretPath, claude: { linked: true, why: cfg.account, account: cfg.account }, codex: { prepared: 'yes', why: 'ready', path: cfg.secretPath } }) + '\\n');
  process.exit(0);
} else if (cfg.mode === 'hang') {
  let n = 0;
  setInterval(() => { n += 1; fs.writeFileSync(cfg.beat, String(n)); }, 200);
}
`;

const ACCOUNT = ['teacher.kim', 'example-school.kr'].join('@');   // 조각으로 짓는다(정화 규칙이 이메일 모양을 막는다)
const SECRET_PATH = ['D:', 'private', 'keys', 'card.json'].join('\\');

let seq = 0;
// 임시 설치 폴더: 동봉 node 자리에 진짜 node(이 시험을 돌리는 것)의 하드 링크 + Doctor 자리에 가짜 Doctor.
function makeSoul(label, { mode = 'ok', doctor = true, node = true } = {}) {
  seq += 1;
  const base = path.join(tmp, `${seq}-${label}`);
  const root = path.join(base, 'IRIS 연습 (공백 & 한글)');
  const log = path.join(base, 'calls.jsonl');
  const beat = path.join(base, 'beat.txt');
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  if (node) {
    const exe = nodeExeFor(root);
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }
  }
  if (doctor) {
    const entry = doctorEntryFor(root);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, FAKE_DOCTOR);
    fs.writeFileSync(path.join(path.dirname(entry), 'fake.json'), JSON.stringify({ mode, log, beat, account: ACCOUNT, secretPath: SECRET_PATH }));
  }
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { base, root, log, beat, calls };
}
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { out[`${r}\\`] = 'dir'; walk(r); continue; }
      const f = path.join(dir, r);
      // 동봉 node(큰 실행 파일)는 내용 지문 대신 크기 · 시각만 본다
      const st = fs.statSync(f);
      out[r] = `${st.size}:${st.mtimeMs}:${st.size > 5_000_000 ? '-' : crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`;
    }
  };
  walk('');
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// 이 PC 의 평소 환경처럼 더러운 환경: 과금 열쇠 · 중계기 주소 · 코드 주입 · 남의 설정 폴더
const dirtyEnv = (extra = {}) => ({
  ...process.env,
  ANTHROPIC_API_KEY: 'sk-ant-api-must-not-travel', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456', OPENAI_API_KEY: 'sk-must-not-travel',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-must-not-travel', CLAUDE_CONFIG_DIR: 'X:\\somewhere\\else', CODEX_HOME: 'X:\\somewhere\\codex',
  NODE_OPTIONS: '--require ./no-such-evil.js', TEAMCLAUDE_CONFIG: 'X:\\tc.json', IRIS_ROOT: 'X:\\another-root', IRIS_DOCTOR_DIR: 'X:\\another-doctor',
  ...extra,
});
// 이 시험을 돌리는 셸의 연습 · 오프라인 손잡이를 뺀 환경(그 위에 extra 를 얹는다)
const clean = (extra = {}) => { const e = { ...process.env }; delete e.IRIS_INSTALLER_NO_USER_ENV; delete e[OFFLINE_ENV]; return { ...e, ...extra }; };

test('부르는 명령 = 동봉 node 로 설치본의 Doctor 실행 입구를 직접, `link auto` 하나 — 전달 심도 probe · login 도 아니다', () => {
  assert.deepEqual([...DOCTOR_PREPARE_ARGS], ['link', 'auto']);
  assert.equal(DOCTOR_PREPARE_TIMEOUT_MS, 20_000);
  const root = path.join(tmp, 'x', 'IRIS');
  assert.equal(doctorEntryFor(root), path.join(root, '_agent', 'shared', 'tools', 'iris-doctor', 'iris-doctor.mjs'));
  assert.equal(nodeExeFor(root), path.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe'));
  assert.ok(!/shims/i.test(doctorEntryFor(root)) && !/shims/i.test(nodeExeFor(root)));
});

test('부르지 않는 조건: 설치 폴더 모름 · Doctor 부품 없음 · 동봉 node 없음 · 연습 실행 · 오프라인 손잡이 — 프로그램을 띄우지 않는다', async () => {
  let spawns = 0;
  const spawnFn = () => { spawns += 1; throw new Error('must not spawn'); };
  const full = makeSoul('full');
  const cases = [
    ['no-root', { root: null }],
    ['no-doctor', { root: makeSoul('no-doctor', { doctor: false }).root }],
    ['no-node', { root: makeSoul('no-node', { node: false }).root }],
    ['rehearsal', { root: full.root, noUserEnv: true }],
    ['rehearsal', { root: full.root, env: clean({ IRIS_INSTALLER_NO_USER_ENV: '1' }) }],
    ['offline', { root: full.root, env: clean({ [OFFLINE_ENV]: '1' }) }],
  ];
  for (const [why, opts] of cases) {
    const before = opts.root ? snapshot(opts.root) : null;
    const r = await prepareDoctorAccounts({ env: clean(), ...opts, spawnFn });
    assert.deepEqual(r, { called: false, why }, why);
    if (before) assert.deepEqual(snapshot(opts.root), before, `${why}: 아무것도 쓰지 않는다`);
  }
  assert.equal(spawns, 0);
  assert.deepEqual(full.calls(), [], '가짜 Doctor 가 한 번도 불리지 않았다');
  assert.match(doctorPrepareLine({ called: false, why: 'rehearsal' }), /^not called \(rehearsal\)$/);
});

test('부르면: 동봉 node · 실행 입구 · `link auto` · 설치 폴더 밖 작업 폴더 · 허용 목록 환경(열쇠 · 중계기 주소 · 코드 주입 · 남의 설정 폴더는 넘어가지 않는다)', async () => {
  const s = makeSoul('call');
  const r = await prepareDoctorAccounts({ root: s.root, env: clean(dirtyEnv()) });
  assert.deepEqual({ called: r.called, ok: r.ok, exit: r.exit, timedOut: r.timedOut }, { called: true, ok: true, exit: 0, timedOut: false });
  assert.deepEqual(r.claude, { linked: true, why: 'linked' });
  assert.deepEqual(r.codex, { prepared: true, why: 'prepared' });
  const calls = s.calls();
  assert.equal(calls.length, 1, '한 번만 부른다');
  const c = calls[0];
  assert.deepEqual(c.argv, ['link', 'auto']);
  assert.equal(path.resolve(c.exe).toLowerCase(), nodeExeFor(s.root).toLowerCase(), '동봉 node 로');
  assert.ok(!path.resolve(c.cwd).toLowerCase().startsWith(s.root.toLowerCase()), `작업 폴더는 설치 폴더 밖: ${c.cwd}`);
  const keys = Object.keys(c.env).map((k) => k.toUpperCase());
  for (const bad of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME', 'NODE_OPTIONS', 'TEAMCLAUDE_CONFIG', 'IRIS_DOCTOR_DIR']) assert.ok(!keys.includes(bad), `${bad} 가 넘어갔다`);
  assert.equal(c.env.IRIS_ROOT, s.root, 'Doctor 가 볼 설치 폴더는 이 설치 폴더(평소 환경의 값이 아니라)');
  assert.equal(c.env.CLAUDE_CONFIG_DIR, path.join(s.root, '_agent', 'claude'), '1년 열쇠를 읽을 자리도 이 설치 폴더의 것');
  assert.ok(c.env.SystemRoot || c.env.SYSTEMROOT, '윈도우 기본 변수는 넘긴다');
  assert.ok(!String(c.env.PATH ?? c.env.Path ?? '').toLowerCase().includes('shims'), 'PATH 에 전달 심 폴더가 없다');
  // 허용 목록 함수도 같은 답
  const env = doctorPrepareEnv(s.root, dirtyEnv());
  assert.ok(!Object.keys(env).some((k) => /^(ANTHROPIC_|OPENAI_|CODEX_|TEAMCLAUDE_|NODE_OPTIONS$)/i.test(k)));
  assert.deepEqual(Object.keys(env).filter((k) => /^(IRIS_|CLAUDE_)/i.test(k)).sort(), ['CLAUDE_CONFIG_DIR', 'IRIS_ROOT']);
});

test('같은 상태에서 두 번 불러도 설치 폴더의 파일이 하나도 바뀌지 않는다(설치기는 설치 폴더에 쓰지 않는다 — 쓰는 것은 Doctor 뿐)', async () => {
  const s = makeSoul('twice');
  const first = await prepareDoctorAccounts({ root: s.root, env: clean() });
  assert.equal(first.ok, true);
  const after1 = snapshot(s.root);
  for (let i = 0; i < 2; i++) {
    const again = await prepareDoctorAccounts({ root: s.root, env: clean() });
    assert.deepEqual([again.ok, again.claude, again.codex], [true, { linked: false, why: 'has-card' }, { prepared: false, why: 'ready' }]);
  }
  assert.deepEqual(snapshot(s.root), after1, '두 번째 · 세 번째 호출 뒤에도 그대로');
  assert.equal(s.calls().length, 3);
  // 설치기 자신은 처음에도 Doctor 의 집 밖에는 아무것도 만들지 않았다
  const made = Object.keys(after1).filter((k) => !k.startsWith(path.join('_agent', 'shared')) && !k.startsWith(path.join('_agent', 'doctor')) && k !== '_agent\\' && k !== path.join('_agent', 'setup') + '\\');
  assert.deepEqual(made, [], `Doctor 의 집 밖에 생긴 것: ${made.join(', ')}`);
});

test('실패해도 던지지 않고 결과만 돌려준다 · 기록 한 줄에 계정 이름 · 경로가 실리지 않는다(정해 둔 낱말만)', async () => {
  // 답 없이 실패
  let s = makeSoul('fail', { mode: 'fail' });
  let r = await prepareDoctorAccounts({ root: s.root, env: clean() });
  assert.deepEqual({ called: r.called, ok: r.ok, exit: r.exit, timedOut: r.timedOut, claude: r.claude, codex: r.codex }, { called: true, ok: false, exit: 3, timedOut: false, claude: null, codex: null });
  assert.match(doctorPrepareLine(r), /^failed exit=3/);
  // JSON 이 아닌 글
  s = makeSoul('garbage', { mode: 'garbage' });
  r = await prepareDoctorAccounts({ root: s.root, env: clean() });
  assert.equal(r.ok, false); assert.equal(r.claude, null);
  // 약속에 없는 칸 · 낱말이 아닌 값이 섞인 답: 정해 둔 칸과 낱말만 남긴다
  s = makeSoul('leak', { mode: 'leak' });
  r = await prepareDoctorAccounts({ root: s.root, env: clean() });
  assert.deepEqual(r.claude, { linked: true, why: 'unknown' }, '모르는 낱말은 그대로 싣지 않는다');
  assert.deepEqual(r.codex, { prepared: false, why: 'ready' }, '참 · 거짓이 아닌 값은 거짓으로');
  for (const res of [r, await prepareDoctorAccounts({ root: makeSoul('garbage2', { mode: 'garbage' }).root, env: clean() })]) {
    const text = JSON.stringify(res) + doctorPrepareLine(res);
    for (const bad of [ACCOUNT, 'teacher.kim', 'example-school', SECRET_PATH, 'private']) assert.ok(!text.includes(bad), `기록에 ${bad} 가 실렸다: ${text}`);
    assert.ok(!/[\\/@]/.test(doctorPrepareLine(res)), `기록 한 줄에 경로 · 주소 모양이 없다: ${doctorPrepareLine(res)}`);
  }
  // 띄우는 것 자체가 터져도
  r = await prepareDoctorAccounts({ root: makeSoul('spawn-throws').root, env: clean(), spawnFn: () => { throw new Error(`boom ${SECRET_PATH}`); } });
  assert.deepEqual({ called: r.called, ok: r.ok }, { called: true, ok: false });
  assert.ok(!JSON.stringify(r).includes('private'));
  assert.match(doctorPrepareLine({ called: true, ok: true, exit: 0, timedOut: false, ms: 12, claude: { linked: true, why: 'linked' }, codex: { prepared: false, why: 'ready' } }), /^ok claude=linked codex=ready \(12ms\)$/);
});

test('제한 시간: 끝나지 않는 Doctor 는 그 번호로 끝내고 돌아온다 — 끝낸 뒤에는 더 쓰지 않는다', async () => {
  const s = makeSoul('hang', { mode: 'hang' });
  const t0 = Date.now();
  const r = await prepareDoctorAccounts({ root: s.root, env: clean(), timeoutMs: 1500, onSpawn: (pid) => spawned.add(pid) });
  const took = Date.now() - t0;
  assert.deepEqual({ called: r.called, ok: r.ok, timedOut: r.timedOut }, { called: true, ok: false, timedOut: true });
  assert.ok(took >= 1400 && took < 15_000, `제한 시간 뒤 곧 돌아온다(${took}ms)`);
  assert.match(doctorPrepareLine(r), /^timed out/);
  const pid = s.calls()[0].pid;
  assert.equal(alive(pid), false, '우리가 띄운 그 프로세스는 끝났다');
  assert.equal(r.alive, false);
  const beat = fs.existsSync(s.beat) ? fs.readFileSync(s.beat, 'utf8') : null;
  await new Promise((res) => setTimeout(res, 700));
  assert.equal(fs.existsSync(s.beat) ? fs.readFileSync(s.beat, 'utf8') : null, beat, '끝낸 뒤에는 표시 파일이 더 바뀌지 않는다');
});
