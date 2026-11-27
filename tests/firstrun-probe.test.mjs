// verify/firstrun-probe.mjs 의 판정 논리 — 실제 CLI 없이(가짜 CLI · 가짜 화면) 돈다.
// 실제 CLI 를 띄우는 재현은 배포 검사(`node verify/firstrun-probe.mjs`)의 몫이고, 여기서는 그 검사가
// "깨끗한 화면은 통과시키고, 11/9 의 고장 화면은 잡는다"는 것과 격리 · 종료 코드 규칙을 묶는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_SCREEN_RE, SCREEN_RE_NAMES, parseScreenRegexes, loadFaceScreenRegexes, classifyScreen, findDialogs,
  judgeClaude, judgeCodex, startDeadServer, isolatedEnv, leakedKeys, seedSoul, writeFakeCodexAuth, FAKE_LOGIN_EMAIL,
  pipeDriver, watchFirstScreen, probeClaude, probeCodex, endOwnPid, parseArgs, exitCodeOf, EXIT,
  snapshotNativeHosts, restoreNativeHosts, NATIVE_HOST_PARENTS, NATIVE_HOST_NAME, claudeProjectSlug, resolveFaceDir, loadPtyDriver,
} from '../verify/firstrun-probe.mjs';
import { CLAUDE_START_NUDGES, claudeConfigJsonPath, claudeSettingsPath, codexConfigTomlPath } from '../installer/lib/firstrun.mjs';
import { CODEX_RELAY_BASE_URL, CODEX_PROVIDER_ID } from '../installer/lib/shims.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(REPO, 'tests', 'fixtures', 'firstrun-fake-cli.mjs');
const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-frp-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const FAST = { quietMs: 400, minMs: 600, maxMs: 15000, tickMs: 100 };
const fakeLaunch = (scene, ...extra) => ({ file: process.execPath, args: [FAKE, scene, ...extra] });

// 2026-11-27 실제 재현에서 옮긴 화면(경로만 줄임).
const CLAUDE_IDLE = [' ▐▛███▛█   Claude Code v2.1.326', '▝▜██████▀  Opus 5.5 with high effort · Claude API', ' ▝▝   ▝▝   <soul>', '',
  '────────────', '❯', '────────────', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents      ● high · /effort'];
const CLAUDE_NUDGE = [' ▐▛███▛█   Claude Code v2.1.326', '────────────', '  Make auto mode your default permission mode?', '',
  '  Auto mode lets Claude handle permission prompts automatically. Claude checks each tool call for risky actions and', '',
  '  ❯ Yes, set auto mode as my default permission mode', '    No, keep bypass permissions'];
const CODEX_IDLE = ['  >_ OpenAI Codex (v0.172.0)', '     ~\\soul', '  permissions: YOLO mode', '› Ask Codex to do anything',
  '  GPT-6.1-Sol medium fast · ~\\soul', '  ← for agents · ? for shortcuts                ⚠ 12 warnings · f2 to view'];
const CODEX_UPDATE = ['  ✨ Update available! 0.165.0 -> 0.167.0', '› 1. Update now (runs `npm install -g @openai/codex`)', '  2. Skip', '  3. Skip until next version', '  enter continue · esc skip'];

// ---------------------------------------------------------------------------
// 화면 판정
// ---------------------------------------------------------------------------

test('classifyScreen: 클로드 · 코덱스의 빈 입력 칸 = idle', () => {
  const c = classifyScreen(CLAUDE_IDLE);
  assert.equal(c.status, 'idle'); assert.equal(c.promptNear, true); assert.equal(c.attention, false);
  const x = classifyScreen(CODEX_IDLE);
  assert.equal(x.status, 'idle'); assert.equal(x.attention, false); assert.equal(x.updatePrompt, false);
});

test('classifyScreen: 창의 식은 자동 모드 권유를 idle 로 읽는다 — 그래서 판정은 "빈 입력 칸"까지 본다', () => {
  // 11/9 사고의 뿌리: 창은 이 화면을 대기로 읽고 첫 요청문과 Enter 를 보냈다. 재현 판정은 status 만 믿지 않는다.
  const c = classifyScreen(CLAUDE_NUDGE);
  assert.equal(c.status, 'idle');
  assert.equal(c.promptNear, false);
  const checks = judgeClaude({ alive: true, exited: false, final: c, timelineText: CLAUDE_NUDGE.join('\n'), allLines: CLAUDE_NUDGE, foreignRecords: [] });
  assert.equal(checks.find((k) => k.name.startsWith('②')).ok, false);
  assert.equal(checks.find((k) => k.name.startsWith('③')).ok, false);
  assert.match(checks.find((k) => k.name.startsWith('③')).detail, /auto-mode-default/);
});

test('classifyScreen: 작업 표식 · 스피너 = busy, 코덱스 업데이트 물음 · 신뢰 물음 = attention', () => {
  assert.equal(classifyScreen(['• Starting MCP servers (2/7) (3s • esc to interrupt)', '› Ask Codex to do anything']).status, 'busy');
  assert.equal(classifyScreen(['✻ Cogitating…', '❯']).status, 'busy');
  const u = classifyScreen(CODEX_UPDATE);
  assert.equal(u.status, 'attention'); assert.equal(u.updatePrompt, true);
  assert.equal(classifyScreen([' Do you trust the files in this folder?', ' ❯ 1. Yes, proceed', '   2. No, exit', ' Enter to confirm · Esc to cancel']).status, 'attention');
  assert.equal(classifyScreen([]).status, 'busy', '빈 화면은 아직 뜨는 중');
});

test('findDialogs: 이름 붙인 시작 물음을 에이전트별로 찾고, 깨끗한 화면에서는 0', () => {
  assert.deepEqual(findDialogs(CLAUDE_IDLE.join('\n'), 'claude'), []);
  assert.deepEqual(findDialogs(CODEX_IDLE.join('\n'), 'codex'), []);
  assert.deepEqual(findDialogs(CLAUDE_NUDGE.join('\n'), 'claude'), ['auto-mode-default']);
  assert.deepEqual(findDialogs('Try the new fullscreen renderer?', 'claude'), ['fullscreen-renderer']);
  assert.deepEqual(findDialogs(CODEX_UPDATE.join('\n'), 'codex'), ['codex-update']);
  assert.deepEqual(findDialogs(CODEX_UPDATE.join('\n'), 'claude'), [], '다른 에이전트의 물음 이름은 붙이지 않는다');
  assert.deepEqual(findDialogs('Do you trust the files in this folder?', 'codex'), ['trust-folder']);
});

test('parseScreenRegexes: 창 소스의 식을 읽고, 사본과 다르면 drift · 못 읽으면 사본으로', () => {
  const same = SCREEN_RE_NAMES.map((n) => `const ${n} = ${String(BUILTIN_SCREEN_RE[n])};`).join('\n');
  const a = parseScreenRegexes(same);
  assert.deepEqual(a.missing, []); assert.deepEqual(a.drift, []);
  for (const n of SCREEN_RE_NAMES) assert.equal(String(a.re[n]), String(BUILTIN_SCREEN_RE[n]));
  // 줄 끝에 설명 글이 붙어도(창의 ATTENTION_RE 줄처럼) 식만 읽는다
  const withNote = same.replace(/^(const ATTENTION_RE = .*;)$/m, '$1 // v2.50: 답 검토 화면(❯ 1. Submit answers)도 노란불');
  assert.deepEqual(parseScreenRegexes(withNote).drift, []);
  const changed = same.replace(/^const WORKING_RE = .*$/m, 'const WORKING_RE = /(esc to interrupt|New Phrase)/i;');
  const b = parseScreenRegexes(changed);
  assert.deepEqual(b.drift, ['WORKING_RE']);
  assert.ok(b.re.WORKING_RE.test('New Phrase'), '창의 식을 쓴다');
  const c = parseScreenRegexes('// 아무 식도 없음');
  assert.deepEqual(c.missing, [...SCREEN_RE_NAMES]);
  assert.equal(String(c.re.PROMPT_RE), String(BUILTIN_SCREEN_RE.PROMPT_RE));
  assert.equal(loadFaceScreenRegexes(null).source, 'builtin');
  assert.equal(loadFaceScreenRegexes(path.join(tmp, 'no-such-face')).source, 'builtin');
});

test('사본 식 = 옆 폴더의 창 소스(있을 때만 본다) — 창이 식을 바꾸면 여기서 먼저 안다', (t) => {
  const face = resolveFaceDir({ lock: LOCK });
  if (!face) { t.skip('옆 폴더에 IRIS 창 소스가 없다'); return; }
  const got = loadFaceScreenRegexes(face);
  assert.equal(got.source, 'face');
  assert.deepEqual(got.missing, [], '창 소스에서 식을 전부 읽는다');
  assert.deepEqual(got.drift, [], `창의 식이 사본과 달라졌다 — verify/firstrun-probe.mjs BUILTIN_SCREEN_RE 를 맞춘다: ${got.drift.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 판정
// ---------------------------------------------------------------------------

const cleanClaude = (over = {}) => ({ alive: true, exited: false, pid: 1, final: classifyScreen(CLAUDE_IDLE), timelineText: CLAUDE_IDLE.join('\n'), allLines: CLAUDE_IDLE,
  foreignRecords: [], expectedRecord: false, hookCalls: 1, expectHookCall: true, expectDefaultMode: 'bypassPermissions', defaultModeAfter: 'bypassPermissions', ...over });
const failed = (checks) => checks.filter((c) => !c.ok).map((c) => c.name.slice(0, 1));

test('judgeClaude: 깨끗한 첫 화면은 전부 통과', () => {
  assert.deepEqual(failed(judgeClaude(cleanClaude())), []);
});

test('judgeClaude: 고장마다 그 줄만 실패', () => {
  const auto = CLAUDE_IDLE.map((l) => l.replace('bypass permissions on', 'auto mode on'));
  assert.deepEqual(failed(judgeClaude(cleanClaude({ final: classifyScreen(auto), timelineText: auto.join('\n'), allLines: auto }))), ['④'], '권한 표시가 auto');
  assert.deepEqual(failed(judgeClaude(cleanClaude({ foreignRecords: ['11111111-2222-3333-4444-555555555555.jsonl'] }))), ['⑤'], '다른 번호의 기록 = 새 번호로 재시작');
  assert.deepEqual(failed(judgeClaude(cleanClaude({ allLines: [...CLAUDE_IDLE, '  ⎿  SessionStart:startup hook error'] }))), ['⑥']);
  assert.deepEqual(failed(judgeClaude(cleanClaude({ allLines: [...CLAUDE_IDLE, 'requires bash but Git Bash was not found'] }))), ['⑥']);
  assert.deepEqual(failed(judgeClaude(cleanClaude({ hookCalls: 0 }))), ['⑦'], '훅이 불리지 않음');
  assert.deepEqual(failed(judgeClaude(cleanClaude({ timelineText: `${CLAUDE_IDLE.join('\n')}\nTranscript saving is off` }))), ['⑧']);
  assert.deepEqual(failed(judgeClaude(cleanClaude({ defaultModeAfter: 'auto' }))), ['⑨'], '설정의 기본 권한이 바뀜');
  assert.deepEqual(failed(judgeClaude(cleanClaude({ alive: false, exited: true, exitCode: 1 }))), ['①']);
  // 훅 대역이 없으면(다른 영혼을 볼 때) ⑦ 은 묻지 않는다
  assert.ok(!judgeClaude(cleanClaude({ expectHookCall: false, hookCalls: 0 })).some((c) => c.name.startsWith('⑦')));
});

test('judgeCodex: 경고 배지는 막지 않으면 통과 — 시작 경고와 MCP 부산물을 갈라 센다', () => {
  const view = ['  Warnings · 1 of 3 · Startup\n  `bypass_hook_trust` is ignored.', '  Warnings · 2 of 3 · Startup\n  `[features].multi_agent` is deprecated. It still controls\n  the V1 fallback.',
    '  Warnings · 3 of 3 · MCP · playwright\n  MCP client for `playwright` failed to start'];
  const ok = judgeCodex({ alive: true, exited: false, final: classifyScreen(CODEX_IDLE), timelineText: CODEX_IDLE.join('\n'), allLines: CODEX_IDLE, warningView: view, configDiff: { added: ['[tui]'], removed: [] }, configChanged: true });
  assert.deepEqual(failed(ok.checks), []);
  assert.equal(ok.warningBadge, 12);
  assert.equal(ok.warnings.length, 2);
  assert.match(ok.warnings[1], /multi_agent.*deprecated\. It still controls the V1 fallback\./);
  assert.equal(ok.mcpArtifacts, 1);

  const upd = judgeCodex({ alive: true, exited: false, final: classifyScreen(CODEX_UPDATE), timelineText: CODEX_UPDATE.join('\n'), allLines: CODEX_UPDATE });
  assert.deepEqual(failed(upd.checks), ['②', '③', '④'], '업데이트 물음이 입력 칸을 막는다');
  const gone = judgeCodex({ alive: true, exited: false, final: classifyScreen(CODEX_IDLE), timelineText: '', allLines: CODEX_IDLE, configDiff: { added: [], removed: ['multi_agent = true'] }, configChanged: true });
  assert.deepEqual(failed(gone.checks), ['⑤'], '설치기가 쓴 줄을 CLI 가 지웠다');
  const dead = judgeCodex({ alive: false, exited: true, exitCode: 1, final: classifyScreen(['Error: account/read failed']), timelineText: '', allLines: [] });
  assert.ok(failed(dead.checks).includes('①') && failed(dead.checks).includes('②'));
});

test('exitCodeOf: 실패 1 · 못 본 것이 있으면 2(조용한 통과 금지) · 전부 봤고 통과면 0', () => {
  assert.equal(exitCodeOf({ claude: { state: 'ok' }, codex: { state: 'ok' } }), EXIT.ok);
  assert.equal(exitCodeOf({ claude: { state: 'ok' }, codex: { state: 'skipped' } }), EXIT.skipped);
  assert.equal(exitCodeOf({ claude: { state: 'failed' }, codex: { state: 'skipped' } }), EXIT.failed);
  assert.equal(exitCodeOf({}), EXIT.skipped, '아무것도 못 봤으면 통과가 아니다');
  assert.notEqual(EXIT.skipped, 0); assert.notEqual(EXIT.skipped, EXIT.failed);
});

test('parseArgs: 기본값 · 모르는 인수 · 값 없는 인수', () => {
  assert.equal(parseArgs([]).agent, 'both');
  assert.equal(parseArgs(['--agent', 'codex', '--keep']).keep, true);
  assert.throws(() => parseArgs(['--agent', 'gemini']), /--agent/);
  assert.throws(() => parseArgs(['--bogus']), /모르는 인수/);
  assert.throws(() => parseArgs(['--work']), /값이 없습니다/);
  assert.throws(() => parseArgs(['--control', 'x']), /--control/);
  assert.throws(() => parseArgs(['--codex-auth', 'x']), /--codex-auth/);
});

// ---------------------------------------------------------------------------
// 격리 — 죽은 주소 · 자식 환경 · 가짜 영혼
// ---------------------------------------------------------------------------

test('startDeadServer: 무엇이 와도 503, 프록시 CONNECT 도 503, 받은 것은 메서드 · 호스트 · 경로만 적는다', async () => {
  const dead = await startDeadServer();
  try {
    assert.match(dead.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await fetch(`${dead.url}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: 'Bearer secret-value' }, body: '{"x":1}' });
    assert.equal(r.status, 503);
    const { default: net } = await import('node:net');
    const line = await new Promise((resolve, reject) => {
      const s = net.connect(dead.port, '127.0.0.1', () => s.write('CONNECT api.example.invalid:443 HTTP/1.1\r\nHost: api.example.invalid:443\r\n\r\n'));
      let buf = ''; s.on('data', (d) => { buf += d; }); s.on('close', () => resolve(buf.split('\r\n')[0])); s.on('error', reject);
    });
    assert.match(line, /^HTTP\/1\.1 503/);
    assert.equal(dead.hits.length, 2);
    assert.deepEqual({ method: dead.hits[0].method, path: dead.hits[0].path }, { method: 'POST', path: '/v1/messages' }, '물음표 뒤는 적지 않는다');
    assert.equal(dead.hits[1].method, 'CONNECT'); assert.equal(dead.hits[1].host, 'api.example.invalid:443');
    assert.ok(!JSON.stringify(dead.hits).includes('secret-value'), '머리글 · 본문은 적지 않는다');
  } finally { await dead.close(); }
});

test('isolatedEnv: 설정 · 홈 · 임시 폴더는 전부 작업 폴더 안, 나가는 길은 전부 죽은 주소, 이 PC 의 값은 새지 않는다', () => {
  const root = path.join(tmp, 'env', 'soul'); const home = path.join(tmp, 'env', 'home');
  const base = { ...process.env, ANTHROPIC_API_KEY: 'sk-real', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456', OPENAI_API_KEY: 'sk-real2', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'real', TEAMCLAUDE_CONFIG: 'x', HTTPS_PROXY: 'http://corp-proxy:8080', NODE_EXTRA_CA_CERTS: 'x', GH_TOKEN: 'x' };
  const env = isolatedEnv({ root, home, deadUrl: 'http://127.0.0.1:1', base });
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'TEAMCLAUDE_CONFIG', 'NODE_EXTRA_CA_CERTS', 'GH_TOKEN']) assert.equal(env[k], undefined, k);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1');
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy']) assert.equal(env[k], 'http://127.0.0.1:1', k);
  for (const k of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) assert.ok(env[k].startsWith(home), `${k} 는 임시 홈 안`);
  assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(root) && env.CODEX_HOME.startsWith(root));
  const entries = env.PATH.split(path.delimiter);
  assert.ok(entries[0].endsWith(path.join('_agent', 'shared', 'shims')));
  assert.ok(entries.every((p) => p.startsWith(root) || p.toLowerCase().startsWith(String(env.SystemRoot).toLowerCase())), `영혼의 심 · node 와 윈도 기본 폴더뿐(= Git 을 깐 적 없는 PC): ${env.PATH}`);
  assert.deepEqual(leakedKeys(env, base), []);
  assert.ok(!Object.values(env).some((v) => String(v).includes('127.0.0.1:3456')), '살아 있는 중계기 주소가 어디에도 없다');
});

test('seedSoul: 설정은 설치기 함수가 쓴 그대로 — 씨앗 · 훅 · 코덱스 연결, 중계기 주소만 죽은 주소로', async () => {
  const root = path.join(tmp, 'seed', 'soul');
  const s = await seedSoul({ root, lock: LOCK, deadUrl: 'http://127.0.0.1:9' });
  const cj = JSON.parse(fs.readFileSync(claudeConfigJsonPath(root), 'utf8'));
  assert.equal(cj.hasCompletedOnboarding, true);
  for (const [k, v] of Object.entries(CLAUDE_START_NUDGES)) assert.equal(cj[k], v, k);
  const settings = JSON.parse(fs.readFileSync(claudeSettingsPath(root), 'utf8'));
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
  assert.equal(settings.env.DISABLE_AUTOUPDATER, '1');
  assert.ok(settings.hooks.SessionStart.length >= 1, '시작 훅이 등록돼 있다');
  const toml = fs.readFileSync(codexConfigTomlPath(root), 'utf8');
  assert.match(toml, new RegExp(`^model_provider = "${CODEX_PROVIDER_ID}"$`, 'm'));
  assert.match(toml, /^multi_agent = true$/m);
  assert.match(toml, /^approval_policy = "never"$/m);
  assert.ok(toml.includes('base_url = "http://127.0.0.1:9/backend-api/codex"'), '연결 주소는 죽은 주소');
  assert.ok(!toml.includes(new URL(CODEX_RELAY_BASE_URL).origin), '살아 있는 중계기 주소가 남아 있지 않다');
  assert.ok(fs.existsSync(path.join(root, '_agent', 'codex', 'hooks.json')));
  // 훅 대역: 불리면 한 줄 적고 0 으로 끝난다
  assert.ok(fs.existsSync(path.join(root, '_agent', 'shared', 'shims', 'python.cmd')));
  assert.ok(fs.existsSync(path.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe')));
  assert.ok(s.changed.some((c) => /dead address/.test(c)));
  // 살아 있는 에이전트 심은 만들지 않는다(심은 중계기 주소를 박아 넣는다)
  assert.ok(!fs.existsSync(path.join(root, '_agent', 'shared', 'shims', 'claude.cmd')) && !fs.existsSync(path.join(root, '_agent', 'shared', 'shims', 'codex.cmd')));
});

test('seedSoul 대조군: no-nudges 는 안내창 "봤음" 키만, no-permissions 는 권한 씨앗만 뺀다', async () => {
  const a = path.join(tmp, 'ctl-a', 'soul');
  await seedSoul({ root: a, lock: LOCK, deadUrl: 'http://127.0.0.1:9', control: 'no-nudges', nodeStandIn: false });
  const cj = JSON.parse(fs.readFileSync(claudeConfigJsonPath(a), 'utf8'));
  for (const k of Object.keys(CLAUDE_START_NUDGES)) assert.equal(cj[k], undefined, k);
  assert.equal(cj.hasCompletedOnboarding, true);
  assert.equal(JSON.parse(fs.readFileSync(claudeSettingsPath(a), 'utf8')).permissions.defaultMode, 'bypassPermissions');
  const b = path.join(tmp, 'ctl-b', 'soul');
  await seedSoul({ root: b, lock: LOCK, deadUrl: 'http://127.0.0.1:9', control: 'no-permissions', nodeStandIn: false });
  assert.equal(JSON.parse(fs.readFileSync(claudeSettingsPath(b), 'utf8')).permissions, undefined);
  assert.equal(JSON.parse(fs.readFileSync(claudeConfigJsonPath(b), 'utf8')).hasSeenAutoDefaultNudge, true);
});

test('writeFakeCodexAuth: 형식만 갖춘 가짜 — 기본은 열쇠 꼴, 대조용은 로그인 꼴', () => {
  const home = path.join(tmp, 'auth');
  const a = JSON.parse(fs.readFileSync(writeFakeCodexAuth(home), 'utf8'));
  assert.match(a.OPENAI_API_KEY, /not-a-real-key/); assert.equal(a.tokens, null);
  const b = JSON.parse(fs.readFileSync(writeFakeCodexAuth(home, 'chatgpt'), 'utf8'));
  assert.equal(b.OPENAI_API_KEY, null);
  const claims = JSON.parse(Buffer.from(b.tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims.email, FAKE_LOGIN_EMAIL);
  assert.match(claims.email, /\.invalid$/, '실재하지 않는 주소');
});

// ---------------------------------------------------------------------------
// 가짜 CLI 로 끝에서 끝까지(파이프 대역)
// ---------------------------------------------------------------------------

async function withSoul(label, fn) {
  const dead = await startDeadServer();
  const root = path.join(tmp, label, 'soul'); const home = path.join(tmp, label, 'home');
  try {
    const seeded = await seedSoul({ root, lock: LOCK, deadUrl: dead.url, nodeStandIn: false });
    const env = isolatedEnv({ root, home, deadUrl: dead.url });
    return await fn({ root, env, dead, seeded });
  } finally { await dead.close(); }
}

test('가짜 클로드: 깨끗한 화면 = 통과, 자기 PID 만 끝내고, 자식은 격리 환경 · 죽은 주소만 본다', { timeout: 60_000 }, async () => {
  await withSoul('e2e-clean', async ({ root, env, dead }) => {
    const dump = path.join(tmp, 'e2e-clean', 'dump.json');
    const obs = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-clean', '--dump', dump, '--ping'), watch: FAST, expectDefaultMode: 'bypassPermissions' });
    assert.deepEqual(failed(obs.checks), [], JSON.stringify(obs.checks.filter((c) => !c.ok)));
    assert.equal(obs.settled, true);
    assert.ok(obs.stopped === 'ended' || obs.stopped === 'already-gone');
    assert.equal(pidAlive(obs.pid), false, '띄운 프로세스가 남지 않는다');
    const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
    assert.equal(seen.values.ANTHROPIC_BASE_URL, dead.url);
    assert.equal(seen.values.HTTPS_PROXY, dead.url);
    assert.ok(seen.values.CLAUDE_CONFIG_DIR.startsWith(root));
    assert.ok(seen.values.USERPROFILE.startsWith(path.join(tmp, 'e2e-clean')));
    assert.ok(!seen.names.some((n) => /^CLAUDE_CODE_|^CLAUDECODE$|API_KEY$/.test(n)), `세션 표식 · 열쇠가 샜다: ${seen.names.join(',')}`);
    assert.ok(obs.timelineText.includes('ping 503'), '자식의 요청은 죽은 주소가 503 으로 받는다');
    assert.ok(dead.hits.some((h) => h.path === '/v1/ping'));
  });
});

test('가짜 클로드: 권한이 auto 로 뜨거나 자동 모드 권유가 뜨면 실패', { timeout: 60_000 }, async () => {
  await withSoul('e2e-bad', async ({ root, env }) => {
    const a = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-auto-mode'), watch: FAST });
    assert.deepEqual(failed(a.checks), ['④']);
    const b = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-auto-nudge'), watch: FAST });
    assert.deepEqual(failed(b.checks), ['②', '③', '④']);
    const c = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-hook-error'), watch: FAST });
    assert.deepEqual(failed(c.checks), ['⑥']);
    for (const o of [a, b, c]) assert.equal(pidAlive(o.pid), false);
  });
});

test('가짜 클로드: 다른 번호의 기록이 생기면(새 번호로 재시작) 실패', { timeout: 60_000 }, async () => {
  await withSoul('e2e-relaunch', async ({ root, env }) => {
    const dir = path.join(env.CLAUDE_CONFIG_DIR, 'projects', claudeProjectSlug(root));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '11111111-2222-3333-4444-555555555555.jsonl'), '{}\n');
    const obs = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-clean'), watch: FAST });
    assert.deepEqual(failed(obs.checks), ['⑤']);
  });
});

test('가짜 코덱스: 깨끗한 화면 = 통과 + 접힌 경고를 펼쳐 읽는다, 업데이트 물음 · 곧 끝남 = 실패', { timeout: 60_000 }, async () => {
  await withSoul('e2e-codex', async ({ root, env }) => {
    const ok = await probeCodex({ root, cmdFile: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('codex-clean'), watch: FAST });
    assert.deepEqual(failed(ok.checks), [], JSON.stringify(ok.checks.filter((c) => !c.ok)));
    assert.equal(ok.warningBadge, 4);
    assert.equal(ok.warnings.length, 1);
    assert.match(ok.warnings[0], /multi_agent.*deprecated/);
    const upd = await probeCodex({ root, cmdFile: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('codex-update'), watch: FAST });
    assert.ok(failed(upd.checks).includes('②') && failed(upd.checks).includes('③'));
    const gone = await probeCodex({ root, cmdFile: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('exit-early'), watch: FAST });
    assert.ok(failed(gone.checks).includes('①'));
    assert.equal(gone.exited, true);
    for (const o of [ok, upd]) assert.equal(pidAlive(o.pid), false);
  });
});

test('watchFirstScreen: 계속 바쁜 화면은 가라앉지 않고 한도에서 멈춘다(통과로 읽지 않는다)', { timeout: 60_000 }, async () => {
  const obs = await watchFirstScreen({ driver: pipeDriver(), ...fakeLaunch('codex-busy'), cwd: tmp, env: process.env, quietMs: 300, minMs: 300, maxMs: 1500, tickMs: 100 });
  try {
    assert.equal(obs.settled, false);
    assert.equal(obs.final.status, 'busy');
  } finally { await obs.stop(); }
  assert.equal(pidAlive(obs.pid), false);
  assert.equal(endOwnPid(obs.pid), 'already-gone');
});

// ---------------------------------------------------------------------------
// 브라우저 연동 등록 지키기(레지스트리는 가짜 실행기로)
// ---------------------------------------------------------------------------

test('snapshot/restoreNativeHosts: 달라진 자리만 원래대로 — 있던 값은 다시 넣고, 없던 키는 그 키만 지운다', () => {
  const dir = path.join(tmp, 'reg');
  const store = new Map([[`${NATIVE_HOST_PARENTS[0]}\\${NATIVE_HOST_NAME}`, 'real-path'], [`${NATIVE_HOST_PARENTS[4]}\\${NATIVE_HOST_NAME}`, 'real-path-edge']]);
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    const [verb, key, file] = args;
    if (verb === 'export') { if (!store.has(key)) return false; fs.writeFileSync(file, `[${key}]\n@="${store.get(key)}"\n`); return true; }
    if (verb === 'delete') { store.delete(key); return true; }
    if (verb === 'import') { const t = fs.readFileSync(key, 'utf8'); const m = /^\[(.+)\]\n@="(.*)"/.exec(t); store.set(m[1], m[2]); return true; }
    return false;
  };
  const snap = snapshotNativeHosts(dir, { run });
  assert.equal(snap.length, NATIVE_HOST_PARENTS.length);
  assert.deepEqual(snap.map((s) => s.existed), [true, false, false, false, true, false, false]);
  assert.ok(snap.every((s) => s.key.endsWith(`\\${NATIVE_HOST_NAME}`)), '이 이름의 키만 다룬다');
  // CLI 가 한 일: 크롬 자리를 임시 경로로 바꾸고, 없던 브레이브 자리를 새로 만들었다. 엣지는 그대로.
  store.set(snap[0].key, 'temp-path'); store.set(snap[1].key, 'temp-path');
  const back = restoreNativeHosts(snap, dir, { run });
  assert.deepEqual(back.map((b) => b.action), ['restored', 'removed', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
  assert.equal(store.get(snap[0].key), 'real-path');
  assert.equal(store.has(snap[1].key), false);
  assert.equal(store.get(snap[4].key), 'real-path-edge');
  assert.ok(!calls.some((c) => /^delete /.test(c) && !c.includes(NATIVE_HOST_NAME)), '다른 키는 지우지 않는다');
  // 아무것도 안 달라졌으면 쓰기(import · delete) 0
  calls.length = 0;
  assert.ok(restoreNativeHosts(snap, dir, { run }).every((b) => b.action === 'unchanged'));
  assert.ok(!calls.some((c) => /^(import|delete) /.test(c)));
});

test('가상 터미널을 못 빌리면 건너뜀 사유를 돌려준다(던지지 않는다)', () => {
  const none = loadPtyDriver(null);
  assert.equal(none.ok, false); assert.match(none.reason, /IRIS 창 소스/);
  const empty = path.join(tmp, 'empty-face'); fs.mkdirSync(empty, { recursive: true }); fs.writeFileSync(path.join(empty, 'package.json'), '{}');
  const bad = loadPtyDriver(empty);
  assert.equal(bad.ok, false); assert.match(bad.reason, /불러오지 못함/);
  assert.equal(resolveFaceDir({ arg: path.join(tmp, 'nope'), env: {}, lock: null }), null);
});
