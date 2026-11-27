// verify/firstrun-probe.mjs 의 판정 논리 — 실제 CLI 없이(가짜 CLI · 가짜 화면) 돈다.
// 실제 CLI 를 띄우는 재현은 배포 검사(`node verify/firstrun-probe.mjs`)의 몫이고, 여기서는 그 검사가
// "깨끗한 화면은 통과시키고, 11/9 의 고장 화면은 잡는다"는 것과 격리 · 종료 코드 규칙을 묶는다.
//
// 이 파일이 묶는 범위(둘을 섞어 읽지 않는다):
//   · 판정 논리 = 화면 · 관측값이 이러하면 통과 / 실패가 이렇게 난다(가짜 화면 · 장면을 고르는 가짜 CLI).
//     실패 길도 여기서 묶는다: 판 불일치 · 판을 못 읽음 · 가라앉지 않음 · 자식이 끝나지 않음 · 보다가 던짐 · 폴더 정리.
//   · 씨앗 = seedSoul 이 설치기 함수로 쓴 파일에 그 키가 있다 / 대조군은 그 키만 뺀다(파일 내용까지).
//   · 묶지 **않는** 것 = "씨앗을 빼면 실제 CLI 의 화면이 바뀐다". 가짜 CLI 는 설정을 읽지 않는다 — 그 인과는
//     실제 CLI 로 손으로 돌린 대조 재현(`--control`)의 기록이 근거다(자동 시험이 아니다, 검증기록 5-82).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_SCREEN_RE, SCREEN_RE_NAMES, parseScreenRegexes, loadFaceScreenRegexes, classifyScreen, findDialogs,
  judgeClaude, judgeCodex, startDeadServer, isolatedEnv, leakedKeys, seedSoul, writeFakeCodexAuth, FAKE_LOGIN_EMAIL,
  pipeDriver, watchFirstScreen, probeClaude, probeCodex, parseArgs, exitCodeOf, EXIT,
  claudeArgs, parseCliVersion, checkLockVersion, decideLaunch, makeRunDir, removeRunDir, defaultWorkBase, claudeProjectSlug, resolveFaceDir, loadPtyDriver,
  getJobTracker, closeJobTracker, startJobTracker, finalJobSweep, codexCmdArgs, prepareClaude,
} from '../verify/firstrun-probe.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CLAUDE_START_NUDGES, claudeConfigJsonPath, claudeSettingsPath, codexConfigTomlPath } from '../installer/lib/firstrun.mjs';
import { CODEX_RELAY_BASE_URL, CODEX_PROVIDER_ID } from '../installer/lib/shims.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(REPO, 'tests', 'fixtures', 'firstrun-fake-cli.mjs');
const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-frp-'));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// 이 시험 프로세스의 Job 추적기 — 도우미의 임시 · 홈 폴더도 시험 폴더 안에 둔다(처음 부를 때의 자리가 쓰인다).
await getJobTracker({ home: path.join(tmp, 'job-helper-home') });
// 이 시험이 "자리 없이" 띄운 도우미가 스스로 만든 폴더(시스템 임시 폴더 안) — 끝날 때 이 경로들만 확인한다
// (임시 폴더 전체를 훑지 않는다: 같은 때 도는 다른 실행의 폴더는 이 시험의 것이 아니다).
const ownHelperHomes = [];
after(async () => {
  // Job 을 다루던 도우미도 이 시험이 띄운 프로세스다 — 닫고, 끝난 것을 확인한다.
  const jobs = await getJobTracker().catch(() => null);
  const helper = jobs?.pid ?? null;
  const last = jobs?.ok ? await finalJobSweep(jobs) : null;
  await closeJobTracker();
  assert.ok(!helper || !pidAlive(helper), 'Job 도우미가 남지 않는다');
  assert.ok(!last || last.ok, `시험이 끝날 때 Job 에 이 프로세스만 남는다: ${JSON.stringify(last?.left)}`);
  assert.deepEqual(ownHelperHomes.filter((d) => fs.existsSync(d)), [], '이 시험이 띄운 도우미가 시험 폴더 밖에 만든 폴더를 남기지 않는다');
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
// 화면 판정을 보는 시험은 Job 추적기를 대역으로 바꿔 끼운다 — 그때 "끝났다"는 띄운 PID 가 죽었는가로만 정해진다.
// 자손까지 보는 확인은 REAL_TREE(진짜 Job 추적기)를 쓰는 시험들이 따로 묶는다.
const NO_TREE = { tracker: { kind: 'none', list: async () => [] } };
const FAST = { quietMs: 400, minMs: 600, maxMs: 15000, tickMs: 100, ...NO_TREE };
const REAL_TREE = { quietMs: 400, minMs: 600, maxMs: 15000, tickMs: 100 };
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

const cleanClaude = (over = {}) => ({ settled: true, ms: 10000, alive: true, exited: false, pid: 1, final: classifyScreen(CLAUDE_IDLE), timelineText: CLAUDE_IDLE.join('\n'), allLines: CLAUDE_IDLE,
  foreignRecords: [], expectedRecord: false, hookCalls: 1, expectHookCall: true, expectDefaultMode: 'bypassPermissions', defaultModeAfter: 'bypassPermissions',
  stopped: 'ended', childGone: true, ...over });
const cleanCodex = (over = {}) => ({ settled: true, ms: 10000, alive: true, exited: false, pid: 1, final: classifyScreen(CODEX_IDLE), timelineText: CODEX_IDLE.join('\n'), allLines: CODEX_IDLE,
  configDiff: { added: [], removed: [] }, configChanged: false, stopped: 'ended', childGone: true, ...over });
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
  // 화면은 깨끗한데 관측이 끝나지 않았다(한도 시간에 닿음) — 통과가 아니다
  assert.deepEqual(failed(judgeClaude(cleanClaude({ settled: false, ms: 90000 }))), ['⓪']);
  assert.deepEqual(failed(judgeClaude(cleanClaude({ settled: undefined }))), ['⓪'], '가라앉았다는 값이 없으면 통과가 아니다');
  // 화면은 깨끗한데 띄운 프로세스를 끝내지 못했다 — 통과가 아니다
  assert.deepEqual(failed(judgeClaude(cleanClaude({ stopped: 'failed', childGone: false }))), ['⑩']);
  // 훅 대역이 없으면(다른 영혼을 볼 때) ⑦ 은 묻지 않는다
  assert.ok(!judgeClaude(cleanClaude({ expectHookCall: false, hookCalls: 0 })).some((c) => c.name.startsWith('⑦')));
});

test('judgeCodex: 경고 배지는 막지 않으면 통과 — 시작 경고와 MCP 부산물을 갈라 센다', () => {
  const view = ['  Warnings · 1 of 3 · Startup\n  `bypass_hook_trust` is ignored.', '  Warnings · 2 of 3 · Startup\n  `[features].multi_agent` is deprecated. It still controls\n  the V1 fallback.',
    '  Warnings · 3 of 3 · MCP · playwright\n  MCP client for `playwright` failed to start'];
  const ok = judgeCodex(cleanCodex({ warningView: view, configDiff: { added: ['[tui]'], removed: [] }, configChanged: true }));
  assert.deepEqual(failed(ok.checks), []);
  assert.equal(ok.warningBadge, 12);
  assert.equal(ok.warnings.length, 2);
  assert.match(ok.warnings[1], /multi_agent.*deprecated\. It still controls the V1 fallback\./);
  assert.equal(ok.mcpArtifacts, 1);

  const upd = judgeCodex(cleanCodex({ final: classifyScreen(CODEX_UPDATE), timelineText: CODEX_UPDATE.join('\n'), allLines: CODEX_UPDATE }));
  assert.deepEqual(failed(upd.checks), ['②', '③', '④'], '업데이트 물음이 입력 칸을 막는다');
  const gone = judgeCodex(cleanCodex({ timelineText: '', configDiff: { added: [], removed: ['multi_agent = true'] }, configChanged: true }));
  assert.deepEqual(failed(gone.checks), ['⑤'], '설치기가 쓴 줄을 CLI 가 지웠다');
  const dead = judgeCodex(cleanCodex({ alive: false, exited: true, exitCode: 1, final: classifyScreen(['Error: account/read failed']), timelineText: '', allLines: [] }));
  assert.ok(failed(dead.checks).includes('①') && failed(dead.checks).includes('②'));
  assert.deepEqual(failed(judgeCodex(cleanCodex({ settled: false })).checks), ['⓪'], '가라앉지 않은 관측은 통과가 아니다');
  assert.deepEqual(failed(judgeCodex(cleanCodex({ stopped: 'failed', childGone: false })).checks), ['⑥'], '띄운 프로세스를 끝내지 못했다');
});

test('exitCodeOf: 실패 1 · 못 본 것이 있으면 2(조용한 통과 금지) · 전부 봤고 통과면 0', () => {
  assert.equal(exitCodeOf({ claude: { state: 'ok' }, codex: { state: 'ok' } }), EXIT.ok);
  assert.equal(exitCodeOf({ claude: { state: 'ok' }, codex: { state: 'skipped' } }), EXIT.skipped);
  assert.equal(exitCodeOf({ claude: { state: 'failed' }, codex: { state: 'skipped' } }), EXIT.failed);
  assert.equal(exitCodeOf({}), EXIT.skipped, '아무것도 못 봤으면 통과가 아니다');
  assert.notEqual(EXIT.skipped, 0); assert.notEqual(EXIT.skipped, EXIT.failed);
});

test('exitCodeOf: 견주기는 전부 맞아도 0 이 아니다(3) · 폴더 정리 실패는 통과를 실패로 바꾼다', () => {
  const allOk = { claude: { state: 'ok' }, codex: { state: 'ok' } };
  assert.equal(exitCodeOf(allOk, { compare: true }), EXIT.compare);
  assert.ok(![0, EXIT.failed, EXIT.skipped].includes(EXIT.compare), '견주기의 코드는 통과 · 실패 · 못 봄과 겹치지 않는다');
  assert.equal(exitCodeOf({ claude: { state: 'failed' } }, { compare: true }), EXIT.failed, '견주기에서도 실패는 실패');
  assert.equal(exitCodeOf({ claude: { state: 'skipped' } }, { compare: true }), EXIT.skipped);
  assert.equal(exitCodeOf(allOk, { cleanupFailed: true }), EXIT.failed);
  assert.equal(exitCodeOf(allOk, { compare: true, cleanupFailed: true }), EXIT.failed);
  // 끝나지 않은 자식 · 보다가 던진 것은 결과 묶음에 실패로 들어온다
  assert.equal(exitCodeOf({ ...allOk, children: { state: 'failed' } }), EXIT.failed);
  assert.equal(exitCodeOf({ ...allOk, error: { state: 'failed' } }), EXIT.failed);
});

test('판 일치: 잠금표와 같을 때만 띄운다 — 다르면 실패, 못 읽으면 못 봄(통과가 될 수 없다)', () => {
  assert.equal(parseCliVersion('2.1.326 (Claude Code)'), '2.1.326');
  assert.equal(parseCliVersion('codex-cli 0.172.0'), '0.172.0');
  assert.equal(parseCliVersion('codex-cli 0.174.0-alpha.8'), '0.174.0-alpha.8');
  assert.equal(parseCliVersion(null), null);
  assert.equal(parseCliVersion('no digits here'), null);

  const same = checkLockVersion('2.1.326 (Claude Code)', '2.1.326');
  assert.deepEqual(same, { state: 'match', actual: '2.1.326', expected: '2.1.326' });
  assert.deepEqual(decideLaunch(same), { launch: true });

  const old = checkLockVersion('2.1.311 (Claude Code)', '2.1.326');
  assert.equal(old.state, 'mismatch');
  const d1 = decideLaunch(old);
  assert.equal(d1.launch, false); assert.equal(d1.state, 'failed');
  assert.match(d1.detail, /2\.1\.311.*2\.1\.326.*--compare/);
  assert.deepEqual(decideLaunch(old, { compare: true }), { launch: true }, '견주기에서는 다른 판도 띄운다(결과는 잠금 판 검증이 아니다)');
  assert.equal(checkLockVersion('0.172.0-alpha.1', '0.172.0').state, 'mismatch', '앞선 시험판은 같은 판이 아니다');

  const unread = checkLockVersion(null, '2.1.326');
  assert.equal(unread.state, 'unreadable');
  const d2 = decideLaunch(unread);
  assert.equal(d2.launch, false); assert.equal(d2.state, 'skipped');
  const noLock = decideLaunch(checkLockVersion('2.1.326', null));
  assert.equal(noLock.launch, false); assert.equal(noLock.state, 'skipped');
  // 띄우지 않은 결과는 종료 코드로 간다
  assert.equal(exitCodeOf({ claude: { state: d1.state } }), EXIT.failed);
  assert.equal(exitCodeOf({ claude: { state: d2.state } }), EXIT.skipped);
});

test('claudeArgs: 창의 인수에서 --chrome 만 뺀다 · 이 스크립트는 레지스트리 도구를 부르지 않는다', () => {
  const args = claudeArgs({ fastSettings: 'F', sessionId: 'S' });
  assert.deepEqual(args, ['--model', 'claude-opus-5-5', '--effort', 'high', '--settings', 'F', '--session-id', 'S']);
  assert.ok(!args.includes('--chrome'), '브라우저 연동 인수를 넘기지 않는다(HKCU 등록에 닿을 길을 두지 않는다)');
  assert.ok(!args.some((a) => /permission/.test(a)), '권한 인수도 넘기지 않는다 — 씨앗이 혼자 버티는지 본다');
  const src = fs.readFileSync(path.join(REPO, 'verify', 'firstrun-probe.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/['"`]reg(\.exe)?['"`]/.test(code), 'reg 를 실행하지 않는다');
  assert.ok(!/HKCU|HKEY_|NativeMessagingHosts/.test(code), '레지스트리 경로를 코드에 두지 않는다(설명 글에만)');
  assert.ok(!/['"`]--chrome['"`]/.test(code), '--chrome 을 인수로 만들지 않는다');
});

test('makeRunDir / removeRunDir: 받은 폴더는 지우지 않고, 실행마다 새 폴더를 만들어 그 폴더만 지운다', () => {
  const base = path.join(tmp, 'workbase');
  fs.mkdirSync(path.join(base, 'someone-elses'), { recursive: true });
  fs.writeFileSync(path.join(base, 'keep-me.txt'), 'data');
  fs.writeFileSync(path.join(base, 'someone-elses', 'x.txt'), 'data');
  const a = makeRunDir(base); const b = makeRunDir(base);
  assert.notEqual(a, b, '동시에 도는 실행끼리 폴더가 겹치지 않는다');
  for (const d of [a, b]) { assert.equal(path.dirname(d), base); assert.match(path.basename(d), /^run-[A-Za-z0-9]{6}$/); }
  fs.writeFileSync(path.join(a, 'f.txt'), '1');
  assert.deepEqual(removeRunDir(a), { removed: true });
  assert.ok(!fs.existsSync(a));
  assert.ok(fs.existsSync(b), '다른 실행의 폴더는 그대로');
  assert.equal(fs.readFileSync(path.join(base, 'keep-me.txt'), 'utf8'), 'data', '받은 폴더에 있던 자료는 그대로');
  assert.ok(fs.existsSync(path.join(base, 'someone-elses', 'x.txt')));
  // 자기가 만든 모양이 아닌 경로는 지우지 않는다
  assert.equal(removeRunDir(base).removed, false);
  assert.equal(removeRunDir(path.join(base, 'someone-elses')).removed, false);
  assert.equal(removeRunDir(null).removed, false);
  assert.ok(fs.existsSync(base) && fs.existsSync(path.join(base, 'someone-elses')));
  assert.deepEqual(removeRunDir(b), { removed: true });
  // 없는 폴더 아래에도 만든다(받은 경로는 만들기만 한다)
  const fresh = makeRunDir(path.join(tmp, 'not-yet', 'deep'));
  assert.ok(fs.existsSync(fresh));
});

// 2.0.66 내기 전 검사에서 실측: 진짜 저장소 폴더(이름에 한글과 반전각 괄호가 있다)에서 인수 없이 돌리면 추적 도우미의
// 컴파일러가 실행 폴더 아래의 임시 폴더에 쓰지 못해 두 에이전트 모두 "못 봄"(종료 코드 2)으로 끝났다 — 만드는 동안에는
// ASCII 경로의 작업 사본에서만 돌려 드러나지 않았다. 기본 작업 폴더가 그런 경로를 피하는지 묶는다.
test('defaultWorkBase: 저장소 경로가 ASCII 면 _build 안, ASCII 가 아닌 글자가 있으면 임시 폴더 아래(추적 도우미의 컴파일러가 쓰지 못하는 경로를 피한다)', () => {
  const tmpDir = 'T:\\scratch\\tmp';
  assert.deepEqual(defaultWorkBase('C:\\work\\p02', tmpDir), { base: path.join('C:\\work\\p02', '_build', 'firstrun-probe'), moved: false });
  for (const repo of ['C:\\work\\P02-설치 패키지(Installer)', 'C:\\work\\P02 〖Local App〗', 'C:\\work\\café']) {
    const r = defaultWorkBase(repo, tmpDir);
    assert.deepEqual(r, { base: path.join(tmpDir, 'iris-firstrun-probe'), moved: true }, repo);
  }
  // 이 저장소가 지금 놓인 자리에서 고른 기본값: 저장소 경로가 ASCII 가 아니면 저장소 밖(임시 폴더)이고, 고른 경로에는
  // 저장소 경로의 ASCII 아닌 글자가 따라 들어가지 않는다(임시 폴더 자체가 ASCII 가 아닌 PC 는 그 폴더를 그대로 쓴다).
  const here = defaultWorkBase();
  const nonAscii = (s) => [...s].some((ch) => ch.codePointAt(0) > 127);
  assert.equal(here.moved, nonAscii(path.join(REPO, '_build', 'firstrun-probe')));
  if (here.moved) {
    assert.equal(here.base, path.join(os.tmpdir(), 'iris-firstrun-probe'));
    assert.ok(!here.base.startsWith(REPO), '작업 폴더가 저장소 밖이다');
  } else assert.equal(here.base, path.join(REPO, '_build', 'firstrun-probe'));
});

test('parseArgs: 기본값 · 모르는 인수 · 값 없는 인수', () => {
  assert.equal(parseArgs([]).agent, 'both');
  assert.equal(parseArgs([]).compare, false, '인수 없이 = 잠금 판 검증');
  assert.equal(parseArgs(['--compare']).compare, true);
  assert.equal(parseArgs(['--control', 'no-nudges']).compare, true, '대조군은 언제나 견주기(잠금 판 검증 통과로 끝날 수 없다)');
  assert.equal(parseArgs(['--codex-auth', 'chatgpt']).compare, true);
  assert.equal(parseArgs(['--codex-auth', 'apikey']).compare, false);
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
    // 끝났는지는 각 관측이 끝낸 직후에 확인한 값으로 본다(나중에 PID 로 다시 보면 윈도가 그 번호를 다른 프로세스에 다시 썼을 수 있다)
    for (const o of [a, b, c]) assert.equal(o.childGone, true);
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
    for (const o of [ok, upd, gone]) assert.equal(o.childGone, true);
  });
});

test('watchFirstScreen: 계속 바쁜 화면은 가라앉지 않고 한도에서 멈춘다(통과로 읽지 않는다)', { timeout: 60_000 }, async () => {
  const obs = await watchFirstScreen({ driver: pipeDriver(), ...fakeLaunch('codex-busy'), cwd: tmp, env: process.env, quietMs: 300, minMs: 300, maxMs: 1500, tickMs: 100, ...NO_TREE });
  try {
    assert.equal(obs.settled, false);
    assert.equal(obs.final.status, 'busy');
  } finally { assert.equal((await obs.stop()).how, 'ended'); }
  assert.equal(pidAlive(obs.pid), false);
});

// ---------------------------------------------------------------------------
// 통과가 되어서는 안 되는 길: 가라앉지 않음 · 자식이 끝나지 않음 · 보다가 던짐 · 판이 다름
// ---------------------------------------------------------------------------

test('가짜 클로드: 입력 칸은 보이지만 출력이 멈추지 않으면(한도 시간에 닿음) 통과가 아니다', { timeout: 60_000 }, async () => {
  await withSoul('e2e-chatty', async ({ root, env }) => {
    const obs = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-chatty'), watch: { quietMs: 400, minMs: 600, maxMs: 2500, tickMs: 100, ...NO_TREE } });
    assert.equal(obs.settled, false, '한도까지 가라앉지 않았다');
    assert.equal(obs.final.status, 'idle', '화면만 보면 대기다 — 그래서 가라앉음을 따로 요구한다');
    assert.equal(obs.final.promptNear, true);
    assert.deepEqual(failed(obs.checks), ['⓪']);
    assert.equal(pidAlive(obs.pid), false);
  });
});

test('가짜 클로드: 띄운 프로세스를 끝내지 못하면 화면이 깨끗해도 실패(⑩)이고, 그 PID 는 살아 있는 것으로 보고된다', { timeout: 60_000 }, async () => {
  await withSoul('e2e-nokill', async ({ root, env }) => {
    // 끝내기가 실패한 것처럼: 목록은 진짜 Job 에서 읽지만, 끝내 달라는 물음에는 "끝냈다"고만 답하고 아무것도 하지 않는다
    const real = await getJobTracker();
    const noEnd = { kind: 'job', get failed() { return real.failed; }, list: () => real.list(), end: async () => ({ status: 'ended', name: 'pretend.exe' }) };
    const obs = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-clean'), watch: { ...REAL_TREE, tracker: noEnd, stopWaitMs: 600 } });
    try {
      assert.equal(obs.stopped, 'failed', '도우미가 "끝냈다"고 답해도 실제로 Job 에 남아 있으면 failed');
      assert.equal(obs.childGone, false);
      assert.deepEqual(failed(obs.checks), ['⑩']);
      assert.equal(pidAlive(obs.pid), true);
      assert.ok(obs.stopInfo.left.includes(obs.pid), `남은 PID 를 찍는다: ${obs.stopInfo.left}`); // 콘솔 도우미 같은 자식이 함께 잡힐 수 있다
      assert.match(obs.checks.find((c) => c.name.startsWith('⑩')).detail, new RegExp(`남은 pid=[0-9,]*${obs.pid}`));
    } finally {
      for (const pid of obs.stopInfo.left) await real.end(pid); // 진짜 도우미로 뒷정리(Job 소속을 확인하고 끝낸다)
    }
    assert.ok(!(await real.list()).includes(obs.pid), '뒷정리 뒤에는 Job 에 없다');
  });
});

test('보다가 던져도 띄운 프로세스부터 끝낸다(관측 예외 길의 finally)', { timeout: 60_000 }, async () => {
  const base = pipeDriver();
  let pid = null;
  const flaky = { ...base, open: (o) => { const t = base.open(o); pid = t.state.pid; let n = 0; const lines = t.lines; t.lines = async () => { n += 1; if (n >= 3) throw new Error('boom while reading the screen'); return lines(); }; return t; } };
  await assert.rejects(() => watchFirstScreen({ driver: flaky, ...fakeLaunch('claude-clean'), cwd: tmp, env: process.env, ...FAST }), /boom while reading/);
  assert.ok(pid, '프로세스가 떴었다');
  for (let i = 0; i < 25 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(pidAlive(pid), false, '던진 뒤에 프로세스가 남지 않는다');

  // probe* 를 거쳐도 같다: 관측 뒤 단계에서 던지면(설정 파일을 읽다가 등) finally 가 끝낸다
  await withSoul('e2e-throw', async ({ root, env }) => {
    let pid2 = null;
    const spy = { ...base, open: (o) => { const t = base.open(o); pid2 = t.state.pid; return t; } };
    // CLAUDE_CONFIG_DIR 이 없는 환경 = 기록 폴더 경로를 만들다 던진다(띄우기 전) → 프로세스가 뜨지 않아야 한다
    await assert.rejects(() => probeClaude({ root, exe: 'unused', env: { ...env, CLAUDE_CONFIG_DIR: undefined }, driver: spy, launch: fakeLaunch('claude-clean'), watch: FAST }));
    assert.equal(pid2, null, '띄우기 전에 던지면 아무것도 뜨지 않는다');
  });
});

test('스크립트 실행: 잠금표와 다른 판의 실행 파일을 주면 띄우지 않고 0 이 아닌 코드로 끝나며, --work 폴더의 자료는 그대로다', { timeout: 120_000 }, () => {
  const base = path.join(tmp, 'cli-work');
  const logs = path.join(tmp, 'cli-logs');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'precious.txt'), 'do not delete');
  // "다른 판의 실행 파일" = node 자신(--version 이 v<판> 을 낸다 — 잠금표의 클로드 판과 다르다). 실제 CLI 는 쓰지 않는다.
  const r = spawnSync(process.execPath, [path.join(REPO, 'verify', 'firstrun-probe.mjs'), '--agent', 'claude', '--claude-exe', process.execPath, '--work', base, '--log-dir', logs, '--label', 't-mismatch'],
    { encoding: 'utf8', timeout: 100_000, windowsHide: true });
  const outText = `${r.stdout}\n${r.stderr}`;
  assert.match(outText, /mode: 잠금 판 검증/);
  assert.ok(!/잠금 판 검증 통과/.test(outText), outText);
  const faceHere = /screen rules: face/.test(outText);
  if (faceHere) {
    // 창의 가상 터미널을 빌릴 수 있는 자리: 판 확인까지 가서 불일치로 실패(1)
    assert.equal(r.status, EXIT.failed, outText);
    assert.match(outText, /FAIL claude ⓥ 띄울 판 = 잠금 판/);
    assert.ok(!/OK {3}claude ①/.test(outText), '띄우지 않았다');
  } else {
    // 빌릴 수 없는 자리(옆 폴더에 창이 없다): 못 봄(2) — 어느 쪽이든 통과(0)도 견주기(3)도 아니다
    assert.equal(r.status, EXIT.skipped, outText);
    assert.match(outText, /SKIP claude/);
  }
  assert.equal(fs.readFileSync(path.join(base, 'precious.txt'), 'utf8'), 'do not delete', '--work 로 준 폴더의 자료를 지우지 않는다');
  assert.deepEqual(fs.readdirSync(base).filter((f) => f.startsWith('run-')), [], '자기가 만든 실행 폴더는 정리했다');
  const j = JSON.parse(fs.readFileSync(path.join(logs, 't-mismatch.json'), 'utf8'));
  assert.equal(j.mode, 'lock'); assert.equal(j.exitCode, r.status); assert.equal(j.cleanup.state, 'removed');
});

// ---------------------------------------------------------------------------
// 프로세스 추적(Job Object) — 자손까지 끝났는지, 끝내기는 핸들로
// ---------------------------------------------------------------------------

/** 중간 부모가 손자를 따로 떼어 띄우고 곧 끝난다 -> 손자의 PID(부모를 잃은 채 남는다). 이 시험 프로세스의 자식으로 띄운다. */
async function spawnOrphan() {
  const mid = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});console.log(c.pid);c.unref();setTimeout(()=>process.exit(0),100)"],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const grand = Number(await new Promise((r) => mid.stdout.once('data', (d) => r(String(d).trim()))));
  await new Promise((r) => mid.once('exit', r));
  return { mid: mid.pid, grand };
}
const untilGone = async (jobs, pid) => { for (let i = 0; i < 25; i++) { if (!(await jobs.list()).includes(pid)) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

test('Job 추적기(진짜): 이 프로세스가 Job 에 있고, 중간 부모가 먼저 죽은 손자도 목록에 남는다', { timeout: 60_000 }, async () => {
  const jobs = await getJobTracker();
  assert.equal(jobs.ok, true, `Job 추적기를 쓸 수 있어야 한다: ${jobs.reason}`);
  assert.equal(jobs.kind, 'job');
  assert.ok(pidAlive(jobs.pid), '도우미의 PID 를 쥐고 있다');
  const base = await jobs.list();
  assert.ok(base.includes(process.pid), '자기 자신이 Job 에 있다');
  assert.ok(!base.includes(jobs.pid), '도우미는 Job 밖이다');
  // 프로세스 표를 주기적으로 뜨는 방식이 놓치던 꼴
  const { mid, grand } = await spawnOrphan();
  try {
    assert.equal(pidAlive(mid), false, '중간 부모는 끝났다');
    const now = await jobs.list();
    assert.ok(now.includes(grand), '부모를 잃은 손자가 Job 목록에 있다');
    assert.ok(!now.includes(mid));
    // 핸들로 끝낸다: Job 소속을 확인하고, 실행 파일 이름을 함께 돌려준다
    const r = await jobs.end(grand);
    assert.equal(r.status, 'ended');
    assert.match(r.name, /^node(\.exe)?$/i);
  } finally { try { process.kill(grand); } catch { /* 이미 끝남 */ } }
  assert.equal(await untilGone(jobs, grand), true, '끝나면 목록에서 빠진다');
  assert.equal((await jobs.end(grand)).status, 'gone', '이미 없는 PID');
  // 요청 여럿을 한꺼번에 보내도 차례로 답한다
  const many = await Promise.all([jobs.list(), jobs.list(), jobs.list()]);
  for (const m of many) assert.ok(Array.isArray(m) && m.includes(process.pid));
  assert.equal(jobs.failed, null);
});

test('Job 추적기(진짜): Job 소속이 아닌 PID 는 끝내지 않는다 · 자기 자신도 끝내지 않는다', { timeout: 60_000 }, async () => {
  const jobs = await getJobTracker();
  // 도우미는 Job 밖이다(이 프로세스를 Job 에 넣기 전에 떴다) — "그사이 다른 프로세스가 그 번호를 받은" 경우와 같은 처지
  const r = await jobs.end(jobs.pid);
  assert.equal(r.status, 'not-in-job');
  assert.match(String(r.name), /powershell/i, '무엇이었는지는 알려 준다');
  assert.ok(pidAlive(jobs.pid), 'Job 소속이 아니면 끝내지 않는다');
  assert.ok(Array.isArray(await jobs.list()), '도우미는 멀쩡하다');
  // 이 시험의 부모(시험 실행기)도 Job 밖이다
  assert.equal((await jobs.end(process.ppid)).status, 'not-in-job');
  assert.ok(pidAlive(process.ppid));
  // 자기 자신: 물음을 보내지도 않는다
  assert.deepEqual(await jobs.end(process.pid), { status: 'refused', name: null });
  assert.deepEqual(await jobs.end(0), { status: 'refused', name: null });
  assert.deepEqual(await jobs.end(-5), { status: 'refused', name: null });
});

test('startJobTracker: 닫으면 도우미가 끝난 것을 확인하고 돌아오고, 그 뒤의 물음은 null 이다', { timeout: 60_000 }, async () => {
  // 따로 하나를 띄워 본다(이 프로세스를 다시 넣지 않도록 다른 프로세스를 대상으로)
  const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const home = path.join(tmp, 'helper-home');
  const t = startJobTracker({ targetPid: victim.pid, home });
  try {
    assert.equal(await t.ready, true, t.reason);
    assert.deepEqual(await t.list(), [victim.pid]);
    assert.deepEqual(await t.end(victim.pid), { status: 'refused', name: null }, '대상 자신은 끝내지 않는다');
    assert.ok(fs.existsSync(path.join(home, 'tmp')), '도우미의 임시 폴더는 준 자리 안에 있다');
    const inFlight = t.list(); // 물음이 진행 중일 때 닫는다
    const how = await t.close();
    assert.ok(Array.isArray(await inFlight), '진행 중이던 물음은 끝까지 받는다');
    assert.equal(how, 'closed');
    assert.equal(pidAlive(t.pid), false, '돌아온 뒤에 도우미가 남아 있지 않다');
    assert.equal(await t.list(), null);
    assert.equal(await t.end(12345), null);
    assert.equal(await t.close(), 'already-gone');
    assert.ok(fs.existsSync(home), '준 폴더는 도우미가 지우지 않는다(실행 폴더와 함께 지워진다)');
    assert.equal(victim.exitCode, null, '"exit" 로 닫을 때는 Job 의 구성원을 건드리지 않는다');
  } finally { victim.kill(); }
});

test('startJobTracker: 이 스크립트가 죽은 것처럼 표준 입력이 그냥 닫히면 도우미가 Job 의 나머지 구성원을 끝내고 나간다', { timeout: 60_000 }, async () => {
  // 대상(= 죽은 척하는 "검사 스크립트")과, 대상이 낳은 자식(= 띄워 둔 CLI). 대상만 Job 에 넣으면 자식은 태어나며 들어간다.
  const target = spawn(process.execPath, ['-e', "process.stdin.once('data',()=>{const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});console.log(c.pid);c.unref();});setInterval(()=>{},1000)"],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let helper = null;
  try {
    let captured = null;
    const t = startJobTracker({ targetPid: target.pid, home: path.join(tmp, 'eof-helper-home'), spawnFn: (...a) => { captured = spawn(...a); return captured; } });
    helper = captured;
    assert.equal(await t.ready, true, t.reason);
    target.stdin.write('go\n');
    const child = Number(await new Promise((r) => target.stdout.once('data', (d) => r(String(d).trim()))));
    assert.ok((await t.list()).includes(child), '자식이 Job 에 있다');
    helper.stdin.end(); // "exit" 없이 닫는다 = 스크립트가 죽었다
    await new Promise((r) => helper.once('exit', r));
    for (let i = 0; i < 25 && pidAlive(child); i++) await new Promise((r) => setTimeout(r, 200));
    assert.equal(pidAlive(child), false, '남은 구성원(띄워 둔 CLI)을 끝냈다');
    assert.equal(target.exitCode, null, '대상 자신은 건드리지 않는다');
  } finally { target.kill(); try { helper?.kill(); } catch { /* */ } }
});

test('startJobTracker: 도우미가 준비되지 못하면(없는 PID) ok=false 와 까닭, 물음은 null', { timeout: 60_000 }, async () => {
  const t = startJobTracker({ targetPid: 4194300 }); // 있을 수 없는 PID
  ownHelperHomes.push(t.home); // 자리를 주지 않았으니 도우미가 시스템 임시 폴더에 스스로 만들었다
  assert.ok(path.dirname(t.home) === os.tmpdir() || t.home.startsWith(os.tmpdir()));
  assert.equal(await t.ready, false);
  assert.match(String(t.reason), /OpenProcess|준비되지/);
  assert.match(String(t.failed), /준비 실패/);
  assert.equal(await t.list(), null);
  await t.close();
  assert.equal(pidAlive(t.pid), false);
  assert.ok(!fs.existsSync(t.home), '스스로 만든 임시 폴더는 닫을 때 지운다');
});

// 가짜 도우미 프로세스: 표준 입출력이 달린 가짜 — 받은 물음을 적어 두고, 시험이 답을 흘려 넣는다.
function fakeHelper() {
  const ps = new EventEmitter();
  ps.pid = 424242; ps.asked = [];
  ps.stdout = new PassThrough(); ps.stderr = new PassThrough();
  ps.stdin = { write: (s) => { ps.asked.push(String(s).trim()); return true; }, end: () => { setTimeout(() => ps.emit('exit', 0), 10); }, unref() {} };
  ps.kill = () => { ps.emit('exit', 1); return true; };
  ps.unref = () => {};
  ps.say = (line) => ps.stdout.write(`${line}\n`);
  return ps;
}

test('추적기: 답이 제때 오지 않으면 실패로 굳는다 — 늦게 온 답을 다음 물음의 답으로 읽지 않는다', { timeout: 60_000 }, async () => {
  const ps = fakeHelper();
  const t = startJobTracker({ targetPid: 1, home: path.join(tmp, 'fake-helper-1'), listMs: 300, spawnFn: () => ps });
  ps.say('READY');
  assert.equal(await t.ready, true);
  // 정상: 번호가 맞는 답
  const p1 = t.list();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ps.asked, ['list 1']);
  ps.say('R 1 OK 1 77 88');
  assert.deepEqual(await p1, [1, 77, 88]);
  // 번호가 다른 답은 버린다(그 물음은 시간 초과가 된다)
  const p2 = t.list();
  await new Promise((r) => setTimeout(r, 20));
  ps.say('R 999 OK 1 2 3');
  assert.equal(await p2, null, '답이 오지 않았다(다른 번호의 답은 내 답이 아니다)');
  assert.match(t.failed, /답이 300ms 안에 오지 않음\(list\)/);
  // 늦게 도착한 2번의 답이 이제 와도, 다음 물음의 답으로 쓰이지 않는다 — 추적기는 굳었다
  ps.say('R 2 OK 1 55');
  const before = ps.asked.length;
  assert.equal(await t.list(), null);
  assert.equal(await t.end(55), null);
  assert.equal(ps.asked.length, before, '굳은 뒤에는 물음을 보내지도 않는다');
  assert.match(t.failed, /답이 300ms 안에 오지 않음/, '까닭은 처음 것 그대로');
  await t.close();
});

test('추적기가 실패로 굳으면 그 관측은 통과가 될 수 없다(끝내기는 했어도) · 종료 코드도 실패', { timeout: 60_000 }, async () => {
  const ps = fakeHelper();
  const t = startJobTracker({ targetPid: 1, home: path.join(tmp, 'fake-helper-2'), listMs: 200, spawnFn: () => ps });
  ps.say('READY'); await t.ready;
  // 띄우기 전 · 직후의 물음에는 답하고, 그 뒤로는 답하지 않는다
  let answered = 0;
  const pump = setInterval(() => { for (const q of ps.asked.splice(0)) { const [verb, id] = q.split(' '); if (verb === 'list' && answered < 2) { answered += 1; ps.say(`R ${id} OK 1`); } } }, 10);
  const real = pipeDriver();
  let proc = null;
  const driver = { ...real, open: (o) => { const term = real.open(o); proc = term; return term; } };
  try {
    const obs = await probeClaude({ root: path.join(tmp, 'sticky'), exe: 'unused', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, 'sticky', 'c') }, driver,
      launch: fakeLaunch('claude-clean'), watch: { quietMs: 300, minMs: 300, maxMs: 5000, tickMs: 100, tracker: { ...t, kind: 'none', list: t.list, end: t.end, get failed() { return t.failed; } }, stopWaitMs: 600 } });
    assert.equal(obs.stopped, 'failed');
    assert.equal(obs.childGone, false);
    assert.match(obs.stopInfo.reason, /Job 목록을 읽지 못해|추적기가 실패/);
    assert.ok(failed(obs.checks).includes('⑩'));
    assert.equal(proc.state.exited, true, '띄운 프로세스는 끝냈다 — 그래도 통과가 아니다');
    assert.equal(exitCodeOf({ claude: { state: 'ok' }, tracker: { state: 'failed' } }), EXIT.failed);
  } finally { clearInterval(pump); await t.close(); }
});

test('finalJobSweep(진짜 Job): 관측보다 먼저 생겨 관측별 확인에서 빠지는 자손(준비 단계가 남긴 것)을 마지막에 잡아 끝낸다', { timeout: 120_000 }, async () => {
  const jobs = await getJobTracker();
  assert.deepEqual((await finalJobSweep(jobs)).found, [], '처음에는 이 프로세스만 있다');
  // 준비 단계가 자손을 남겼다고 치자: 관측을 띄우기 전에 이미 Job 에 있다
  const { grand } = await spawnOrphan();
  try {
    await withSoul('e2e-prep-left', async ({ root, env }) => {
      const obs = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-clean'), watch: REAL_TREE });
      assert.deepEqual(failed(obs.checks), [], '관측별 확인은 통과한다 — 띄우기 전의 목록에 있던 것이라 차에서 빠진다');
      assert.ok(!Object.keys(obs.stopInfo.names).map(Number).includes(grand), '관측은 그것을 건드리지 않았다');
    });
    assert.equal(pidAlive(grand), true, '아직 살아 있다');
    const sweep = await finalJobSweep(jobs);
    const hit = sweep.found.find((f) => f.pid === grand);
    assert.ok(hit, `마지막 Job 전체 확인이 잡는다: ${JSON.stringify(sweep.found)}`);
    assert.equal(hit.status, 'ended');
    assert.match(hit.name, /^node(\.exe)?$/i);
    assert.equal(sweep.ok, true, '끝내고 나니 이 프로세스만 남았다');
    assert.deepEqual(sweep.left, []);
    assert.equal(await untilGone(jobs, grand), true);
  } finally { try { process.kill(grand); } catch { /* 이미 끝남 */ } }
  const again = await finalJobSweep(jobs);
  assert.equal(again.ok, true); assert.deepEqual(again.found, []);
});

test('finalJobSweep: 끝내도 남으면 실패(PID 와 이름) · Job 소속이 아니라는 답이면 끝내지 못한 것 · 목록을 못 읽어도 실패', async () => {
  const mk = (over) => ({ kind: 'job', failed: null, list: async () => [10, 20, 30], end: async () => ({ status: 'ended', name: 'x.exe' }), ...over });
  // 끝냈다고 하지만 목록에 계속 남는다
  const a = await finalJobSweep(mk({}), { keepPid: 10, settleMs: 0, waitMs: 300 });
  assert.equal(a.ok, false);
  assert.deepEqual(a.left, [{ pid: 20, name: 'x.exe' }, { pid: 30, name: 'x.exe' }]);
  assert.match(a.reason, /pid=20,30/);
  // 가짜 도우미가 "Job 소속이 아니다"라고 답한다(그 번호가 다른 프로세스에 다시 쓰였다) -> 끝내지 않았고, 목록에 남아 있으면 실패
  const ended = [];
  const b = await finalJobSweep(mk({ end: async (pid) => { ended.push(pid); return { status: 'not-in-job', name: 'other.exe' }; } }), { keepPid: 10, settleMs: 0, waitMs: 300 });
  assert.deepEqual(b.found.map((f) => f.status), ['not-in-job', 'not-in-job']);
  assert.equal(b.ok, false);
  assert.deepEqual(ended, [20, 30], '자기 자신(10)은 묻지 않는다');
  // 끝내고 나면 비는 경우
  let alive = [10, 20];
  const c = await finalJobSweep(mk({ list: async () => [...alive], end: async (pid) => { alive = alive.filter((p) => p !== pid); return { status: 'ended', name: 'y.exe' }; } }), { keepPid: 10, settleMs: 0, waitMs: 300 });
  assert.equal(c.ok, true); assert.deepEqual(c.found, [{ pid: 20, status: 'ended', name: 'y.exe' }]);
  // 스스로 곧 끝나는 것은 기다려 준다(끝내 달라고 하지 않는다)
  let n = 0;
  const d = await finalJobSweep(mk({ list: async () => (n++ < 2 ? [10, 40] : [10]), end: async () => { throw new Error('부르면 안 된다'); } }), { keepPid: 10, settleMs: 2000, waitMs: 300 });
  assert.equal(d.ok, true); assert.deepEqual(d.found, []);
  // 목록을 못 읽는다
  const e = await finalJobSweep(mk({ failed: '답이 오지 않음', list: async () => null }), { keepPid: 10 });
  assert.equal(e.ok, false); assert.match(e.reason, /Job 목록을 읽지 못함 — 답이 오지 않음/);
  // 답이 없다(추적기가 굳음)
  const f = await finalJobSweep(mk({ end: async () => null }), { keepPid: 10, settleMs: 0, waitMs: 200 });
  assert.equal(f.ok, false); assert.deepEqual(f.found.map((x) => x.status), ['no-answer', 'no-answer']);
});

test('codexCmdArgs: cmd 는 언제나 /d 로(레지스트리의 AutoRun 명령을 돌리지 않는다) · taskkill · tasklist 를 부르지 않는다', () => {
  assert.deepEqual(codexCmdArgs('X:\\codex.cmd', ['--version']), ['/d', '/c', 'X:\\codex.cmd', '--version']);
  assert.equal(codexCmdArgs('x')[0], '/d');
  const src = fs.readFileSync(path.join(REPO, 'verify', 'firstrun-probe.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const bare = code.split('\n').filter((l) => /\[\s*'\/c'/.test(l));
  assert.deepEqual(bare, [], `/d 없이 /c 로 시작하는 cmd 인수를 만들지 않는다: ${bare.join(' | ')}`);
  // 파워셸을 부르는 자리는 전부 -NoProfile
  const ps = code.split('\n').filter((l) => /['"`]powershell['"`]/.test(l));
  assert.ok(ps.length >= 1 && ps.every((l) => l.includes("'-NoProfile'")), `파워셸은 언제나 -NoProfile: ${ps.join(' | ')}`);
  // 번호로 프로세스를 끝내거나 찾는 도구를 부르지 않는다(끝내기는 도우미가 핸들로)
  assert.ok(!/['"`](taskkill|tasklist)(\.exe)?['"`]/.test(code), 'taskkill · tasklist 를 실행하지 않는다');
  assert.ok(!/process\.kill\(/.test(code), '번호로 process.kill 을 부르지 않는다');
});

test('가짜 CLI + 진짜 Job: 중간 부모가 먼저 죽은 손자까지, 이 관측이 낳은 것만 핸들로 끝낸다', { timeout: 120_000 }, async () => {
  await withSoul('e2e-tree', async ({ root, env }) => {
    const pidFile = path.join(tmp, 'e2e-tree', 'orphan.pid');
    const real = await getJobTracker();
    const before = new Set(await real.list());
    const asked = [];
    const spy = { kind: 'job', get failed() { return real.failed; }, list: () => real.list(), end: async (pid, ms) => { asked.push(pid); return real.end(pid, ms); } };
    const obs = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-clean', '--spawn-orphan', pidFile), watch: { ...REAL_TREE, tracker: spy } });
    const orphan = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(orphan > 0 && orphan !== obs.pid);
    assert.equal(asked[0], obs.pid, '띄운 것부터 끝낸다');
    assert.ok(asked.includes(orphan), `부모를 잃은 손자도 끝냈다: ${asked}`);
    assert.ok(asked.every((pid) => !before.has(pid) && pid !== process.pid && pid !== process.ppid), '띄우기 전부터 있던 것 · 시험 프로세스 쪽은 건드리지 않았다');
    assert.match(String(obs.stopInfo.names[orphan]), /^node(\.exe)?$/i);
    assert.notEqual(obs.stopped, 'failed');
    assert.equal(obs.childGone, true);
    assert.deepEqual(obs.stopInfo.left, []);
    assert.deepEqual(failed(obs.checks), []);
    assert.ok(obs.stopInfo.tracked >= 2, `Job 으로 센 수에 손자가 들어 있다(${obs.stopInfo.tracked})`);
    assert.equal(await untilGone(real, orphan), true, '손자도 끝났다');
    assert.equal(await untilGone(real, obs.pid), true);
  });
});

test('가짜 CLI + 진짜 Job: 끝내도 자손이 남으면 실패이고 남은 PID 와 이름을 찍는다(띄운 프로세스는 끝났어도)', { timeout: 120_000 }, async () => {
  await withSoul('e2e-tree-left', async ({ root, env }) => {
    const pidFile = path.join(tmp, 'e2e-tree-left', 'orphan.pid');
    const real = await getJobTracker();
    let orphan = null;
    // 손자만은 끝내지 못한다(권한이 없다는 답) — 나머지는 진짜로 끝낸다
    const stubborn = { kind: 'job', get failed() { return real.failed; }, list: () => real.list(),
      end: async (pid, ms) => { orphan = orphan ?? Number(fs.readFileSync(pidFile, 'utf8')); return pid === orphan ? { status: 'denied:5', name: 'node.exe' } : real.end(pid, ms); } };
    const obs = await probeCodex({ root, cmdFile: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('codex-clean', '--spawn-orphan', pidFile), peekWarnings: false,
      watch: { ...REAL_TREE, tracker: stubborn, stopWaitMs: 1500 } });
    try {
      assert.ok(orphan > 0);
      assert.equal(pidAlive(orphan), true);
      assert.equal(obs.stopped, 'failed');
      assert.equal(obs.childGone, false);
      assert.ok(obs.stopInfo.left.includes(orphan) && !obs.stopInfo.left.includes(obs.pid), `남은 것은 손자 — 띄운 프로세스는 끝났다: ${obs.stopInfo.left}`);
      assert.ok(obs.stopInfo.retried.includes(orphan), '남은 그것을 한 번 더 끝내 보았다');
      assert.deepEqual(failed(obs.checks), ['⑥']);
      assert.match(obs.checks.find((c) => c.name.startsWith('⑥')).detail, new RegExp(`남은 pid=[0-9,]*${orphan}.*${orphan}=node\\.exe`));
      assert.equal(exitCodeOf({ codex: { state: 'failed' } }), EXIT.failed);
    } finally { await real.end(orphan); }
    assert.equal(await untilGone(real, orphan), true);
  });
});

test('Job 목록을 읽지 못하면 "끝났다"고 하지 않는다 · 띄운 프로세스가 Job 에 안 보여도 마찬가지', { timeout: 60_000 }, async () => {
  const quick = { quietMs: 300, minMs: 300, maxMs: 5000, tickMs: 100 };
  const noop = async () => ({ status: 'ended', name: null });
  // 물음이 늘 실패하는 추적기
  const a = await watchFirstScreen({ driver: pipeDriver(), ...fakeLaunch('claude-clean'), cwd: tmp, env: process.env, ...quick, tracker: { kind: 'job', failed: '답이 오지 않음', list: async () => null, end: noop } });
  const sa = await a.stop();
  assert.equal(sa.how, 'failed'); assert.match(sa.reason, /Job 목록을 읽지 못함\(띄우기 전\) — 답이 오지 않음/);
  assert.equal(pidAlive(a.pid), false, '끝내기 자체는 했다(터미널이 쥔 프로세스 객체로)');
  // 물음은 되지만 띄운 프로세스가 한 번도 보이지 않는다(추적이 깨진 경우)
  const b = await watchFirstScreen({ driver: pipeDriver(), ...fakeLaunch('claude-clean'), cwd: tmp, env: process.env, ...quick, tracker: { kind: 'job', failed: null, list: async () => [process.pid], end: noop } });
  const sb = await b.stop();
  assert.equal(sb.how, 'failed'); assert.match(sb.reason, /Job 에 보이지 않음/);
  assert.equal(pidAlive(b.pid), false);
  // 끝낸 뒤부터 물음이 실패한다
  let calls = 0;
  const c = await watchFirstScreen({ driver: pipeDriver(), ...fakeLaunch('claude-clean'), cwd: tmp, env: process.env, ...quick, tracker: { kind: 'none', failed: null, list: async () => { calls += 1; return calls <= 2 ? [] : null; } } });
  const sc = await c.stop();
  assert.equal(sc.how, 'failed'); assert.match(sc.reason, /끝낸 뒤/);
  assert.equal(pidAlive(c.pid), false);
});

test('추적이 깨져 터미널 쪽 kill() 로 끝낸 실행은 언제나 실패다(종료 코드 1) · 멀쩡한 추적에서는 그 길을 타지 않는다', { timeout: 120_000 }, async () => {
  const base = pipeDriver();
  let kills = 0;
  const counting = { ...base, open: (o) => { const term = base.open(o); const kill = term.kill; term.kill = () => { kills += 1; return kill(); }; return term; } };
  const real = await getJobTracker();
  await withSoul('e2e-broken', async ({ root, env }) => {
    // ⓐ 진짜 Job 이지만 띄운 프로세스가 목록에 보이지 않는다(추적이 깨짐): 끝내 달라는 물음은 보내지 않고 터미널의 kill() 로 끝낸다
    const asked = [];
    const blind = { kind: 'job', failed: null, list: async () => [process.pid], end: async (pid) => { asked.push(pid); return { status: 'ended', name: null }; } };
    kills = 0;
    const a = await probeClaude({ root, exe: 'unused', env, driver: counting, launch: fakeLaunch('claude-clean'), watch: { quietMs: 400, minMs: 600, maxMs: 15000, tickMs: 100, tracker: blind } });
    assert.equal(kills, 1, '터미널 쪽 kill() 을 탔다');
    assert.deepEqual(asked, [], 'Job 소속을 확인할 수 없으니 핸들 길로는 아무것도 끝내지 않았다');
    assert.equal(a.stopped, 'failed');
    assert.equal(a.childGone, false);
    assert.match(a.stopInfo.reason, /Job 에 보이지 않음/);
    assert.deepEqual(failed(a.checks), ['⑩'], '화면은 깨끗해도 그 관측은 실패다');
    assert.equal(exitCodeOf({ claude: { state: a.checks.some((c) => !c.ok) ? 'failed' : 'ok' } }), EXIT.failed);
    // ⓑ 목록을 읽지 못한다(추적기가 굳음): 같은 길, 같은 결과 — 코덱스 쪽 판정으로
    kills = 0;
    const deaf = { kind: 'job', failed: '답이 오지 않음', list: async () => null, end: async () => null };
    const b = await probeCodex({ root, cmdFile: 'unused', env, driver: counting, launch: fakeLaunch('codex-clean'), peekWarnings: false, watch: { quietMs: 400, minMs: 600, maxMs: 15000, tickMs: 100, tracker: deaf } });
    assert.equal(kills, 1);
    assert.equal(b.stopped, 'failed');
    assert.deepEqual(failed(b.checks), ['⑥']);
    assert.equal(exitCodeOf({ codex: { state: 'failed' } }), EXIT.failed);
    // ⓒ 멀쩡한 진짜 추적: kill() 을 타지 않는다(전부 도우미가 핸들로 끝낸다)
    kills = 0;
    const c = await probeClaude({ root, exe: 'unused', env, driver: counting, launch: fakeLaunch('claude-clean'), watch: { ...REAL_TREE, tracker: real } });
    assert.equal(kills, 0, '추적이 멀쩡하면 터미널 쪽 kill() 을 부르지 않는다');
    assert.notEqual(c.stopped, 'failed');
    assert.deepEqual(failed(c.checks), []);
  });
});

test('물음이 늦게 끝나도 stop() 은 그 답을 받은 뒤에 돌아온다(반환 뒤에 진행 중인 물음이 남지 않는다)', { timeout: 60_000 }, async () => {
  let inFlight = 0; let maxInFlight = 0; let answered = 0;
  const slow = { kind: 'none', failed: null, list: async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 700)); inFlight -= 1; answered += 1; return []; } };
  const obs = await watchFirstScreen({ driver: pipeDriver(), ...fakeLaunch('claude-clean'), cwd: tmp, env: process.env, quietMs: 300, minMs: 300, maxMs: 5000, tickMs: 100, tracker: slow });
  const s = await obs.stop();
  assert.equal(inFlight, 0, 'stop() 이 돌아온 뒤에 진행 중인 물음이 없다');
  assert.ok(answered >= 3, `띄우기 전 · 끝내기 전 · 끝낸 뒤 물음을 전부 기다렸다(${answered})`);
  assert.equal(maxInFlight, 1, '물음을 겹쳐 보내지 않는다');
  assert.equal(s.how, 'ended');
  assert.equal(pidAlive(obs.pid), false);
});

// ---------------------------------------------------------------------------
// 키를 보내기 전의 조건 — 기대한 화면일 때만
// ---------------------------------------------------------------------------

const keysSeen = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).join(''); } catch { return ''; } };
const F2 = '\x1bOQ'; const RIGHT = '\x1b[C';

test('가짜 코덱스: 가라앉은 대기 화면 + 경고 배지일 때만 F2 를 보내고, 경고 보기 창일 때만 화살표를 보낸다', { timeout: 120_000 }, async () => {
  await withSoul('e2e-keys', async ({ root, env }) => {
    const dir = path.join(tmp, 'e2e-keys');
    const run = async (scene, watch = FAST) => {
      const logFile = path.join(dir, `${scene}.keys`);
      const obs = await probeCodex({ root, cmdFile: 'unused', env, driver: pipeDriver(), launch: fakeLaunch(scene, '--stdin-log', logFile), watch });
      return { obs, keys: keysSeen(logFile) };
    };
    // 기대한 흐름: F2 한 번(한 쪽짜리라 화살표 없음)
    const ok = await run('codex-clean');
    assert.equal(ok.keys, F2);
    assert.equal(ok.obs.warningPeek, 'seen');
    assert.equal(ok.obs.warnings.length, 1);

    // 화면이 바뀐 CLI: F2 뒤에 경고 보기 창이 아니라 고르는 물음이 뜬다 → 더 보내지 않고 "못 봄"
    const other = await run('codex-f2-other');
    assert.equal(other.keys, F2, '화살표 · Enter 를 보내지 않았다');
    assert.match(other.obs.warningPeek, /^not-seen: 보기 키 뒤의 화면이 경고 보기 창이 아니라/);
    assert.equal(other.obs.warningView, null);
    assert.match(other.obs.checks.find((c) => c.name.startsWith('④')).detail, /경고 글 못 봄/);
    assert.deepEqual(failed(other.obs.checks), [], '경고 글은 기록용이다 — 못 봐도 화면 판정은 그대로');

    // 세 쪽이라더니 둘째 쪽에서 다른 화면이 된다 → 화살표는 한 번만, 그 뒤로는 보내지 않는다
    const breaks = await run('codex-pager-breaks');
    assert.equal(breaks.keys, F2 + RIGHT);
    assert.match(breaks.obs.warningPeek, /^partial: 1\/3쪽/);
    assert.equal(breaks.obs.warningView.length, 1);

    // 배지는 보이지만 가라앉지 않았다 → 키를 하나도 보내지 않는다
    const chatty = await run('codex-chatty', { quietMs: 400, minMs: 600, maxMs: 2500, tickMs: 100, ...NO_TREE });
    assert.equal(chatty.obs.settled, false);
    assert.equal(chatty.keys, '', '가라앉지 않은 화면에는 키를 보내지 않는다');
    assert.match(chatty.obs.warningPeek, /^not-seen: 가라앉은 대기 화면이 아니라/);
    assert.deepEqual(failed(chatty.obs.checks), ['⓪']);

    // 물음이 떠 있는 화면(업데이트 물음) → 보내지 않는다
    const upd = await run('codex-update');
    assert.equal(upd.keys, '');
    for (const r of [ok, other, breaks, chatty, upd]) assert.equal(r.obs.childGone, true);
  });
});

// ---------------------------------------------------------------------------
// 준비 단계 — 설치기 함수가 띄우는 프로세스에도 격리 환경을
// ---------------------------------------------------------------------------

test('prepareClaude: installClaude 의 주입 자리에 격리된 실행 함수를 주고, npm 대체 설치는 쓰지 않는다', async () => {
  const work = path.join(tmp, 'prep');
  fs.mkdirSync(work, { recursive: true });
  const base = { ...process.env, CLAUDE_CONFIG_DIR: 'X:\\real\\claude', CODEX_HOME: 'X:\\real\\codex', ANTHROPIC_API_KEY: 'sk-real', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',
    CLAUDE_CODE_OAUTH_TOKEN: 'real', OPENAI_API_KEY: 'sk-real2', npm_config_userconfig: 'X:\\real\\.npmrc' };
  const seen = { runs: [], given: null };
  const fakeRun = async (exe, args, opts) => { seen.runs.push({ exe, args, opts }); return { code: 0, out: '9.9.9 (Claude Code)', err: '' }; };
  const fakeInstall = async (given) => {
    seen.given = given;
    await given.runFn('X:\\dl\\claude.exe', ['--version'], { timeoutMs: 1234 });
    const npm = await given.npmInstall({ nodeExe: 'n', npmCli: 'c', prefix: 'p', spec: 's', cacheDir: 'd' });
    assert.notEqual(npm.code, 0, 'npm 대체 설치는 실패로 답한다(프로세스를 띄우지 않는다)');
    return { ok: true, version: '9.9.9', source: 'claude.ai' };
  };
  const lock = { parts: { claude: { version: '9.9.9', binName: 'claude.exe' } } };
  const got = await prepareClaude({ work, lock, deadUrl: 'http://127.0.0.1:9', install: fakeInstall, runFn: fakeRun, base });
  assert.equal(got.ok, true);
  assert.ok(got.exe.startsWith(path.join(work, 'cli')) && got.exe.endsWith(path.join('9.9.9', 'claude.exe')));
  assert.ok(seen.given.root.startsWith(work), '받는 자리는 실행 폴더 안');
  assert.equal(seen.runs.length, 1, '띄운 것은 판 확인 하나뿐');
  const env = seen.runs[0].opts.env;
  assert.equal(seen.runs[0].opts.timeoutMs, 1234, '설치기가 준 다른 선택은 그대로');
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'npm_config_userconfig']) assert.equal(env[k], undefined, k);
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP']) assert.ok(String(env[k]).startsWith(work), `${k} 는 실행 폴더 안: ${env[k]}`);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
  assert.ok(!Object.values(env).some((v) => /X:\\real|127\.0\.0\.1:3456|sk-real/.test(String(v))), '이 PC 의 설정 폴더 · 중계기 주소 · 열쇠가 어디에도 없다');
  assert.deepEqual(leakedKeys(env, base), []);

  // 못 받으면 못 본 것이다(사유를 돌려준다, 던지지 않는다)
  const bad = await prepareClaude({ work, lock, deadUrl: 'http://127.0.0.1:9', install: async () => ({ ok: false, code: 'E-ONLINE-CLAUDE', message: 'no route' }), runFn: fakeRun, base });
  assert.equal(bad.ok, false); assert.match(bad.reason, /받지 못함.*--claude-exe/);
  const thrown = await prepareClaude({ work, lock, deadUrl: 'http://127.0.0.1:9', install: async () => { throw new Error('boom'); }, runFn: fakeRun, base });
  assert.equal(thrown.ok, false); assert.match(thrown.reason, /boom/);
});

test('스크립트 실행: 실행 폴더를 만든 뒤 무엇이 던져도 그 폴더를 정리한다(기록 폴더를 만들 수 없는 경우)', { timeout: 120_000 }, () => {
  const base = path.join(tmp, 'early-work');
  fs.mkdirSync(base, { recursive: true });
  // 기록 폴더 자리에 파일이 있다 → mkdir 가 던진다(실행 폴더를 만든 직후, 죽은 주소를 띄우기 전)
  const blocker = path.join(tmp, 'early-logs-is-a-file');
  fs.writeFileSync(blocker, 'x');
  const r = spawnSync(process.execPath, [path.join(REPO, 'verify', 'firstrun-probe.mjs'), '--agent', 'claude', '--claude-exe', process.execPath, '--work', base, '--log-dir', blocker],
    { encoding: 'utf8', timeout: 100_000, windowsHide: true });
  const outText = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, EXIT.failed, outText);
  assert.match(outText, /FAIL firstrun-probe 예외/);
  assert.deepEqual(fs.readdirSync(base).filter((f) => f.startsWith('run-')), [], '일찍 던져도 자기가 만든 실행 폴더는 정리했다');
  assert.ok(!/잠금 판 검증 통과/.test(outText));
});

test('가상 터미널을 못 빌리면 건너뜀 사유를 돌려준다(던지지 않는다)', () => {
  const none = loadPtyDriver(null);
  assert.equal(none.ok, false); assert.match(none.reason, /IRIS 창 소스/);
  const empty = path.join(tmp, 'empty-face'); fs.mkdirSync(empty, { recursive: true }); fs.writeFileSync(path.join(empty, 'package.json'), '{}');
  const bad = loadPtyDriver(empty);
  assert.equal(bad.ok, false); assert.match(bad.reason, /불러오지 못함/);
  assert.equal(resolveFaceDir({ arg: path.join(tmp, 'nope'), env: {}, lock: null }), null);
});
