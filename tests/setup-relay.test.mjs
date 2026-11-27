// T13 ⑤-7 중계기 준비 시험
//
// 이 단계가 지켜야 할 것 네 가지를 못 박는다:
//   ① 중계기(3456)를 **띄우지 않는다** — 자식 프로세스를 하나도 만들지 않는다
//   ② `.cmd` 네 개는 ASCII·CRLF·`%~dp0` 상대
//   ③ 이미 있는 `소환하기.cmd` 를 내용이 다르면 덮지 않고 `.new` 로 옆에 둔다
//   ④ 두 번 실행해도 변경 0
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as relay from '../installer/setup/relay.mjs';
import { isStageError } from '../installer/lib/errors.mjs';
import { portableTeamclaudeConfigPath } from '../installer/lib/login.mjs';


const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-t13-relay-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const LOCK = {
  schema: 2,
  package: { version: '2.0.0' },
  parts: {
    dash: { kind: 'dir', file: 'dash/teamclaude-dash.zip', dest: '_agent/shared/tools/teamclaude-dash' },
    teamclaude: { kind: 'npm-prefix', version: '1.1.16', file: 'relay/teamclaude-1.1.16+iris.zip', dest: '_agent/shared/tools/teamclaude' },
  },
};

// ⑤-1 풀기가 끝난 뒤의 모습을 최소한으로 흉내 낸다.
function makeSoul(label, { withDash = true, withManage = true, withFaceIcon = false } = {}) {
  const root = path.join(tmp, label, 'IRIS');
  const put = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  fs.mkdirSync(root, { recursive: true });
  if (withDash) put('_agent/shared/tools/teamclaude-dash/launch.mjs', '// launch\n');
  if (withManage) put('_agent/shared/tools/teamclaude/teamclaude-manage.ps1', '# manage\n');
  if (withFaceIcon) put('_agent/shared/tools/face/app/iris.ico', 'ico');
  return root;
}

function makeCtx(root, overrides = {}) {
  const logs = [];
  const psCalls = [];
  return {
    root,
    lock: LOCK,
    payloadDir: path.join(tmp, 'payload'),
    choice: { subscriptions: ['claude'], leadAgent: 'claude' },
    offline: true,
    fs,
    log: (l) => logs.push(l),
    progress: () => {},
    env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '1' },
    runPs: async (script) => { psCalls.push(script); return { code: 0, out: 'ok', err: '' }; },
    logs,
    psCalls,
    ...overrides,
  };
}

function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const here = rel ? path.join(dir, rel) : dir;
    for (const e of fs.readdirSync(here, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { out[`${childRel}\\`] = 'dir'; walk(childRel); continue; }
      const st = fs.statSync(path.join(dir, childRel));
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, childRel))).digest('hex');
      out[childRel] = `${st.size}:${st.mtimeMs}:${hash}`;
    }
  };
  walk('');
  return out;
}

function assertAsciiCrlfRelative(file) {
  const buf = fs.readFileSync(file);
  assert.ok(buf.every((b) => b < 0x80), `${path.basename(file)} 에 ASCII 아닌 바이트가 있다`);
  const text = buf.toString('ascii');
  assert.ok(text.includes('\r\n'), `${path.basename(file)} 는 CRLF 여야 한다`);
  assert.ok(!/(^|[^\r])\n/.test(text), `${path.basename(file)} 에 홀로 있는 LF 가 있다`);
  assert.ok(text.includes('%~dp0'), `${path.basename(file)} 는 %~dp0 상대경로여야 한다`);
  assert.ok(!/[A-Za-z]:\\/.test(text), `${path.basename(file)} 에 절대경로가 박혀 있다`);
}

// ---------------------------------------------------------------------------

test('relay: 설정 뼈대·대시보드·Face 실행기·소환하기를 만든다', async () => {
  const root = makeSoul('all');
  const ctx = makeCtx(root);
  const { recorded, pending } = await relay.run(ctx);

  // ① 중계기 설정 뼈대 -- 계정 0, 토큰 0
  const cfg = portableTeamclaudeConfigPath(root);
  assert.ok(fs.existsSync(cfg));
  // 2026-09-17(2.0.8): 관리 스크립트가 `proxy.port -eq 3456` 을 검사하므로 기본 틀을 통째로 쓴다. 계정·토큰은 0.
  const written = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(written.accounts, []);
  assert.equal(written.proxy.port, 3456);
  assert.match(written.proxy.apiKey, /^tc-/);
  assert.equal(written.upstream, 'https://api.anthropic.com');
  assert.equal(recorded.config.status, 'created');

  // ② 대시보드 바로가기
  const dash = path.join(root, '대시보드.cmd');
  assert.ok(fs.existsSync(dash));
  assertAsciiCrlfRelative(dash);
  assert.match(fs.readFileSync(dash, 'ascii'), /teamclaude-dash\\launch\.mjs/);
  assert.match(fs.readFileSync(dash, 'ascii'), /tools\\node\\node\.exe/);

  // ③ IRIS Face.cmd (바탕화면 바로가기는 연습이라 건너뜀)
  const face = path.join(root, 'IRIS Face.cmd');
  assert.ok(fs.existsSync(face));
  assertAsciiCrlfRelative(face);
  assert.equal(recorded.desktopShortcut.status, 'skipped');
  assert.equal(ctx.psCalls.length, 0, '연습 실행에서는 바탕화면 바로가기 PowerShell 을 부르지 않는다');

  // ④ 소환하기.cmd
  const summon = path.join(root, '소환하기.cmd');
  assert.ok(fs.existsSync(summon));
  assertAsciiCrlfRelative(summon);
  const text = fs.readFileSync(summon, 'ascii');
  assert.match(text, /set "CLAUDE_CONFIG_DIR=%~dp0_agent\\claude"/);
  assert.match(text, /set "CODEX_HOME=%~dp0_agent\\codex"/);
  assert.match(text, /set "ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:3456"/);
  assert.match(text, /shims;/);
  assert.match(text, /codex\.cmd/);
  assert.match(text, /claude\.cmd/);
  assert.ok(text.split('\r\n').length <= 22, `단순판 20줄쯤이어야 한다(실제 ${text.split('\r\n').length}줄)`);

  // 중계기는 시작하지 않는다
  assert.equal(recorded.relayStarted, false);
  assert.equal(recorded.port, 3456);
  assert.equal(recorded.manageScript.present, true);
  assert.deepEqual(pending, []);
});

test('relay: 중계기도 Face 도 띄우지 않는다(실행 헬퍼 호출 0 + 소스에 기동 경로 없음)', async () => {
  const root = makeSoul('nospawn');
  const spawned = [];
  const ctx = makeCtx(root);
  // ctx.run/ctx.runPs 를 주더라도 연습 실행에서는 한 번도 부르지 않아야 한다.
  ctx.run = async (exe) => { spawned.push(exe); return { code: 0, out: '', err: '' }; };
  ctx.runPs = async () => { spawned.push('powershell'); return { code: 0, out: '', err: '' }; };
  await relay.run(ctx);
  assert.deepEqual(spawned, [], `프로세스를 하나도 만들면 안 된다(실제: ${spawned.join(', ')})`);

  // 소스 검사: 빌트인 모듈은 ESM 이름공간을 가로챌 수 없으므로(읽기 전용),
  // "부르지 않는다"를 코드에 기동 경로 자체가 없다는 것으로 못 박는다.
  const src = fs.readFileSync(path.join(REPO, 'installer', 'setup', 'relay.mjs'), 'utf8');
  // 호출 모양으로만 본다 -- 머리말 주석에는 "ensureProxy 를 부르지 않는다"라고
  // 적혀 있어야 하므로 이름만으로 찾으면 그 설명이 걸린다.
  for (const forbidden of ['ensureProxy(', 'launchFace(', 'defaultRunManage(', 'spawn(', 'node:child_process']) {
    assert.ok(!src.includes(forbidden), `relay.mjs 가 ${forbidden} 를 쓰면 안 된다`);
  }
  // import 로도 끌어오지 않는다
  assert.ok(!/import\s*\{[^}]*\bensureProxy\b/.test(src), 'relay.mjs 가 ensureProxy 를 import 하면 안 된다');
});

test('relay: 이미 있는 소환하기.cmd 가 다르면 덮지 않고 .new 로 둔다', async () => {
  const root = makeSoul('nooverwrite');
  const summon = path.join(root, '소환하기.cmd');
  fs.writeFileSync(summon, '@echo off\r\nrem my own launcher\r\n', 'ascii');

  const ctx = makeCtx(root);
  const { recorded } = await relay.run(ctx);

  assert.equal(fs.readFileSync(summon, 'ascii'), '@echo off\r\nrem my own launcher\r\n', '그 사람 파일은 그대로여야 한다');
  assert.ok(fs.existsSync(`${summon}.new`));
  assert.equal(fs.readFileSync(`${summon}.new`, 'ascii'), relay.summonContent());
  assert.equal(recorded.summon.status, 'side-by-side');
  assert.ok(recorded.files.sideBySide.some((s) => s.kept === '소환하기.cmd'));
});

test('relay: 이미 있는 설정 파일의 계정을 건드리지 않는다', async () => {
  const root = makeSoul('keepcfg');
  const cfg = portableTeamclaudeConfigPath(root);
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  const mine = { accounts: [{ name: 'codex', type: 'oauth', provider: 'codex' }] };
  fs.writeFileSync(cfg, JSON.stringify(mine, null, 2), 'utf8');

  const { recorded } = await relay.run(makeCtx(root));
  // 2026-09-17(2.0.8): 계정은 한 글자도 안 바뀌고, 빠진 기본 칸(proxy.port 등)만 채워진다.
  const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(after.accounts, mine.accounts);
  assert.equal(after.proxy.port, 3456);
  assert.equal(recorded.config.status, 'patched');
  assert.ok(recorded.config.patched.includes('proxy'));

  // 이미 온전한 파일은 'kept' 그대로.
  const { recorded: again } = await relay.run(makeCtx(root));
  assert.equal(again.config.status, 'kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), after);
});

test('relay: 영수증 env.teamclaudeConfig 가 가리키는 자리에 만든다', async () => {
  const root = makeSoul('fromreceipt');
  const ctx = makeCtx(root);
  // ⑤-2(env)가 적어 둔 값 — 기본값과 같은 경로지만, 갈라질 수 없다는 것을
  // 코드로 보장하기 위해 relay 는 영수증을 1순위로 읽는다.
  ctx.receipt = { schema: 2, setup: {}, online: {}, env: { teamclaudeConfig: portableTeamclaudeConfigPath(root) } };
  const { recorded } = await relay.run(ctx);

  assert.equal(recorded.config.path, path.relative(root, portableTeamclaudeConfigPath(root)));
  assert.ok(fs.existsSync(portableTeamclaudeConfigPath(root)));

  // 영혼 밖을 가리키는 값은 따르지 않는다(E-OUTSIDE-ROOT)
  const root2 = makeSoul('outside');
  const ctx2 = makeCtx(root2);
  ctx2.receipt = { schema: 2, setup: {}, online: {}, env: { teamclaudeConfig: path.join(tmp, 'elsewhere', 'teamclaude.json') } };
  await assert.rejects(() => relay.run(ctx2), (err) => {
    assert.equal(err.code, 'E-OUTSIDE-ROOT');
    return true;
  });
  assert.ok(!fs.existsSync(path.join(tmp, 'elsewhere', 'teamclaude.json')));
});

test('relay: 두 번째 실행은 아무것도 바꾸지 않는다', async () => {
  const root = makeSoul('idem');
  await relay.run(makeCtx(root));
  const before = snapshot(root);
  const { recorded } = await relay.run(makeCtx(root));
  assert.deepEqual(snapshot(root), before, '두 번째 실행에서 파일이 하나도 바뀌면 안 된다');
  assert.equal(recorded.files.created.length, 0);
  assert.ok(recorded.files.kept.length >= 4);
});

test('relay: 대시보드 부품이 없으면 바로가기를 건너뛰고 pending 에 남긴다', async () => {
  const root = makeSoul('nodash', { withDash: false, withManage: false });
  const { recorded, pending } = await relay.run(makeCtx(root));
  assert.ok(!fs.existsSync(path.join(root, '대시보드.cmd')));
  assert.equal(recorded.dashboard.status, 'skipped');
  assert.equal(recorded.manageScript.present, false);
  assert.deepEqual(pending.map((p) => p.capability).sort(), ['사용량 대시보드', '사용량 중계기(여러 구독 묶어 쓰기)']);
  // 나머지는 그대로 만들어진다
  assert.ok(fs.existsSync(path.join(root, '소환하기.cmd')));
});

test('relay: 연습이 아니면 바탕화면 바로가기를 만든다(주입된 PowerShell 로)', async () => {
  const root = makeSoul('desktop', { withFaceIcon: true });
  const desk = path.join(tmp, 'desktop', 'Desktop');
  fs.mkdirSync(desk, { recursive: true });
  const ctx = makeCtx(root, { env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '' }, desktopDir: desk });
  const { recorded } = await relay.run(ctx);

  assert.equal(ctx.psCalls.length, 1);
  assert.match(ctx.psCalls[0], /CreateShortcut/);
  assert.match(ctx.psCalls[0], /IRIS\.lnk/);
  assert.match(ctx.psCalls[0], /IconLocation/, 'Face 아이콘이 있으면 쓴다');
  assert.equal(recorded.desktopShortcut.status, 'created');
});

// ---------------------------------------------------------------------------
// 2.0.66 — 「IRIS Doctor」 바로가기(바탕화면 + 시작 메뉴). Doctor 는 띄우지 않는다.
// ---------------------------------------------------------------------------

const DOCTOR_LOCK = { ...LOCK, parts: { ...LOCK.parts, 'iris-doctor': { kind: 'dir', file: 'tools/iris-doctor.zip', dest: '_agent/shared/tools/iris-doctor' } } };
function putDoctor(root) {
  const start = path.join(root, '_agent', 'shared', 'tools', 'iris-doctor', 'IRIS Doctor.cmd');
  fs.mkdirSync(path.dirname(start), { recursive: true });
  fs.writeFileSync(start, '@echo off\r\n');
  return start;
}
// 진짜 PowerShell 대신: 「IRIS」 바로가기 호출에는 그냥 ok, Doctor 호출에는 만든 두 경로를 답한다.
function doctorPs(calls, { desk, programs, name = 'IRIS', fail = [], words = {} }) {
  return async (script) => {
    calls.push(script);
    if (!script.includes('Doctor.lnk')) return { code: 0, out: 'ok', err: '' };
    const line = (where, dir) => (fail.includes(where) ? `FAIL|${where}|access denied` : `${words[where] ?? 'OK'}|${where}|${path.join(dir, `${name} Doctor.lnk`)}`);
    return { code: 0, out: `${line('desktop', desk)}\r\n${line('startmenu', programs)}\r\n`, err: '' };
  };
}

test('relay (2.0.66): Doctor 부품이 놓여 있으면 바탕화면과 시작 메뉴에 「IRIS Doctor」 바로가기를 만들고, 만든 두 경로만 기록한다', async () => {
  const root = makeSoul('doctor-lnk');
  const start = putDoctor(root);
  const desk = path.join(tmp, 'doctor-lnk', 'Desktop'); const programs = path.join(tmp, 'doctor-lnk', 'Programs');
  const calls = [];
  const ctx = makeCtx(root, { lock: DOCTOR_LOCK, env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '' }, desktopDir: desk, startMenuDir: programs, runPs: doctorPs(calls, { desk, programs }) });
  const { recorded, pending } = await relay.run(ctx);

  const doctorCalls = calls.filter((s) => s.includes('Doctor.lnk'));
  assert.equal(doctorCalls.length, 1, 'PowerShell 한 번으로 둘 다');
  assert.ok(doctorCalls[0].includes(`/d /c ""${start}""`), '인자 = /d /c ""<시작 파일>""');
  assert.match(doctorCalls[0], /\$sc\.TargetPath = \$cmd/);
  assert.ok(doctorCalls[0].includes(`'${desk}'`) && doctorCalls[0].includes(`'${programs}'`), '주입한 두 폴더에만');
  assert.deepEqual(recorded.doctorShortcut, {
    status: 'created',
    desktop: { ok: true, path: path.join(desk, 'IRIS Doctor.lnk') },
    startMenu: { ok: true, path: path.join(programs, 'IRIS Doctor.lnk') },
  });
  assert.ok(!pending.some((p) => /Doctor/.test(p.capability)));
  // 설치 폴더 안에는 Doctor 용 실행기를 따로 만들지 않는다(시작 파일은 부품 안에 있다)
  assert.deepEqual(fs.readdirSync(root).filter((n) => /doctor/i.test(n)), []);
  // 「IRIS」 바로가기도 지금까지처럼
  assert.equal(recorded.desktopShortcut.status, 'created');
});

test('relay (2.0.66): 연습 실행(IRIS_INSTALLER_NO_USER_ENV=1)에서는 Doctor 바로가기를 만들지 않는다 — PowerShell 도 부르지 않고, 두 번 돌려도 변경 0', async () => {
  const root = makeSoul('doctor-practice');
  putDoctor(root);
  const ctx = makeCtx(root, { lock: DOCTOR_LOCK, desktopDir: path.join(tmp, 'never-d'), startMenuDir: path.join(tmp, 'never-p') });
  const first = await relay.run(ctx);
  assert.deepEqual(first.recorded.doctorShortcut, { status: 'skipped', reason: 'IRIS_INSTALLER_NO_USER_ENV=1' });
  assert.equal(ctx.psCalls.length, 0);
  assert.ok(!fs.existsSync(path.join(tmp, 'never-d')) && !fs.existsSync(path.join(tmp, 'never-p')));
  const before = snapshot(root);
  const again = makeCtx(root, { lock: DOCTOR_LOCK });
  await relay.run(again);
  assert.deepEqual(snapshot(root), before);
  assert.equal(again.psCalls.length, 0);
});

test('relay (2.0.66): Doctor 부품이 없으면 바로가기를 만들지 않는다 — 이번 판 잠금표에 있는 부품일 때만 「대기 기능」에 한 줄', async () => {
  const desk = path.join(tmp, 'doctor-absent', 'Desktop');
  // 잠금표에 있는데 없다 → 대기 기능 한 줄
  let root = makeSoul('doctor-absent-1');
  let ctx = makeCtx(root, { lock: DOCTOR_LOCK, env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '' }, desktopDir: desk });
  let r = await relay.run(ctx);
  assert.equal(r.recorded.doctorShortcut.status, 'absent');
  assert.equal(r.pending.filter((p) => /IRIS Doctor/.test(p.capability)).length, 1);
  assert.ok(!ctx.psCalls.some((s) => s.includes('Doctor.lnk')));
  // 잠금표에도 없다(옛 꾸러미) → 조용히 넘어간다
  root = makeSoul('doctor-absent-2');
  ctx = makeCtx(root, { env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '' }, desktopDir: desk });
  r = await relay.run(ctx);
  assert.equal(r.recorded.doctorShortcut.status, 'absent');
  assert.ok(!r.pending.some((p) => /Doctor/.test(p.capability)));
});

test('relay (2.0.66): Doctor 바로가기를 못 만들어도 설치는 계속된다 — 「대기 기능」에 한 줄, 실패한 까닭은 감사 대상이 아닌 칸에', async () => {
  const root = makeSoul('doctor-fail');
  putDoctor(root);
  const desk = path.join(tmp, 'doctor-fail', 'Desktop'); const programs = path.join(tmp, 'doctor-fail', 'Programs');
  // 한 곳만 실패
  let calls = [];
  let ctx = makeCtx(root, { lock: DOCTOR_LOCK, env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '' }, desktopDir: desk, startMenuDir: programs, runPs: doctorPs(calls, { desk, programs, fail: ['startmenu'] }) });
  let r = await relay.run(ctx);
  assert.equal(r.recorded.doctorShortcut.status, 'partial');
  assert.deepEqual(r.recorded.doctorShortcut.desktop, { ok: true, path: path.join(desk, 'IRIS Doctor.lnk') });
  assert.deepEqual(r.recorded.doctorShortcut.startMenu, { ok: false, path: null, cause: 'access denied' });
  assert.equal(r.pending.filter((p) => /IRIS Doctor/.test(p.capability)).length, 1);
  assert.ok(fs.existsSync(path.join(root, '소환하기.cmd')), '뒤의 일은 그대로 한다');
  // PowerShell 이 터져도
  ctx = makeCtx(root, { lock: DOCTOR_LOCK, env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '' }, desktopDir: desk, startMenuDir: programs, runPs: async (script) => { if (script.includes('Doctor.lnk')) throw new Error('spawn failed'); return { code: 0, out: 'ok', err: '' }; } });
  r = await relay.run(ctx);
  assert.equal(r.recorded.doctorShortcut.status, 'failed');
  assert.equal(r.recorded.doctorShortcut.desktop.path, null);
  assert.equal(r.pending.filter((p) => /IRIS Doctor/.test(p.capability)).length, 1);
});

// 2026-11-28 코드 검토(막아야 함): 같은 이름의 바로가기가 이미 있으면 덮지 않는다.
test('relay (2.0.66): 같은 이름의 다른 바로가기가 이미 있으면 그대로 두고 「대기 기능」에 알린다 — 그 경로를 우리 것으로 기록하지 않는다', async () => {
  const root = makeSoul('doctor-foreign');
  putDoctor(root);
  const desk = path.join(tmp, 'doctor-foreign', 'Desktop'); const programs = path.join(tmp, 'doctor-foreign', 'Programs');
  const ctx = makeCtx(root, { lock: DOCTOR_LOCK, env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '' }, desktopDir: desk, startMenuDir: programs, runPs: doctorPs([], { desk, programs, words: { desktop: 'FOREIGN' } }) });
  const { recorded, pending } = await relay.run(ctx);
  assert.equal(recorded.doctorShortcut.status, 'partial');
  assert.equal(recorded.doctorShortcut.desktop.ok, false);
  assert.equal(recorded.doctorShortcut.desktop.foreign, true);
  assert.equal(recorded.doctorShortcut.desktop.path, null, '남의 바로가기의 경로를 우리 기록에 싣지 않는다');
  assert.ok(!/[\\/]/.test(recorded.doctorShortcut.desktop.cause), '까닭 글에 경로가 없다');
  assert.deepEqual(recorded.doctorShortcut.startMenu, { ok: true, path: path.join(programs, 'IRIS Doctor.lnk') });
  const line = pending.filter((p) => /IRIS Doctor/.test(p.capability));
  assert.equal(line.length, 1);
  assert.match(line[0].reason, /같은 이름의 다른 바로가기가 이미 있어 그대로 두었습니다/);
  assert.ok(fs.existsSync(path.join(root, '소환하기.cmd')), '설치는 계속된다');
});

test('relay (2.0.66): 이미 이 설치의 바로가기가 있으면 "그대로 둠"으로 기록하고 알릴 것이 없다(되풀이 실행)', async () => {
  const root = makeSoul('doctor-kept');
  putDoctor(root);
  const desk = path.join(tmp, 'doctor-kept', 'Desktop'); const programs = path.join(tmp, 'doctor-kept', 'Programs');
  const ctx = makeCtx(root, { lock: DOCTOR_LOCK, env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '' }, desktopDir: desk, startMenuDir: programs, runPs: doctorPs([], { desk, programs, words: { desktop: 'KEPT', startmenu: 'KEPT' } }) });
  const { recorded, pending } = await relay.run(ctx);
  assert.deepEqual(recorded.doctorShortcut, {
    status: 'kept',
    desktop: { ok: true, path: path.join(desk, 'IRIS Doctor.lnk'), kept: true },
    startMenu: { ok: true, path: path.join(programs, 'IRIS Doctor.lnk'), kept: true },
  });
  assert.ok(!pending.some((p) => /Doctor/.test(p.capability)));
});

test('relay: 루트가 없으면 E-RELAY StageError', async () => {
  await assert.rejects(() => relay.run({ fs }), (err) => {
    assert.ok(isStageError(err));
    assert.equal(err.code, 'E-RELAY');
    return true;
  });
});
