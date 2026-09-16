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
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { accounts: [] });
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
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), mine);
  assert.equal(recorded.config.status, 'kept');
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

test('relay: 루트가 없으면 E-RELAY StageError', async () => {
  await assert.rejects(() => relay.run({ fs }), (err) => {
    assert.ok(isStageError(err));
    assert.equal(err.code, 'E-RELAY');
    return true;
  });
});
