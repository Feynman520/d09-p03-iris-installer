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
  pipeDriver, watchFirstScreen, probeClaude, probeCodex, endOwnPid, parseArgs, exitCodeOf, EXIT,
  claudeArgs, parseCliVersion, checkLockVersion, decideLaunch, makeRunDir, removeRunDir, claudeProjectSlug, resolveFaceDir, loadPtyDriver,
  parseProcessTable, ProcessTree, listProcesses, endOnePid, codexCmdArgs, prepareClaude,
} from '../verify/firstrun-probe.mjs';
import { spawnSync } from 'node:child_process';
import { CLAUDE_START_NUDGES, claudeConfigJsonPath, claudeSettingsPath, codexConfigTomlPath } from '../installer/lib/firstrun.mjs';
import { CODEX_RELAY_BASE_URL, CODEX_PROVIDER_ID } from '../installer/lib/shims.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(REPO, 'tests', 'fixtures', 'firstrun-fake-cli.mjs');
const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-frp-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// 화면 판정을 보는 시험은 프로세스 표를 빈 표로 바꿔 끼운다(진짜 표는 한 번에 2초쯤 걸린다) — 그때 "끝났다"는 띄운 PID 가
// 죽었는가로만 정해진다. 자손까지 보는 나무 확인은 REAL_TREE 를 쓰는 시험들이 진짜 표로 따로 묶는다.
const NO_TREE = { list: () => [], listAsync: async () => [] };
const FAST = { quietMs: 400, minMs: 600, maxMs: 15000, tickMs: 100, ...NO_TREE };
const REAL_TREE = { quietMs: 400, minMs: 600, maxMs: 15000, tickMs: 100, treeEveryMs: 300 };
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
  const obs = await watchFirstScreen({ driver: pipeDriver(), ...fakeLaunch('codex-busy'), cwd: tmp, env: process.env, quietMs: 300, minMs: 300, maxMs: 1500, tickMs: 100, ...NO_TREE });
  try {
    assert.equal(obs.settled, false);
    assert.equal(obs.final.status, 'busy');
  } finally { await obs.stop(); }
  assert.equal(pidAlive(obs.pid), false);
  assert.equal(endOwnPid(obs.pid), 'already-gone');
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
    // 끝내기가 실패한 것처럼: 나무를 끝내는 것도, 남은 PID 를 다시 끝내는 것도 아무것도 하지 않는다(프로세스 표는 진짜)
    const obs = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-clean'), watch: { ...REAL_TREE, kill: () => 'ended', killOne: () => 'ended', stopWaitMs: 600 } });
    try {
      assert.equal(obs.stopped, 'failed', 'kill 이 "끝냈다"고 해도 실제로 살아 있으면 failed');
      assert.equal(obs.childGone, false);
      assert.deepEqual(failed(obs.checks), ['⑩']);
      assert.equal(pidAlive(obs.pid), true);
      assert.ok(obs.stopInfo.left.includes(obs.pid), `남은 PID 를 찍는다: ${obs.stopInfo.left}`); // 콘솔 도우미 같은 자식이 함께 잡힐 수 있다
      assert.match(obs.checks.find((c) => c.name.startsWith('⑩')).detail, new RegExp(`남은 pid=${obs.pid}`));
    } finally {
      endOwnPid(obs.pid);
      for (let i = 0; i < 25 && pidAlive(obs.pid); i++) await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(pidAlive(obs.pid), false);
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
// 프로세스 나무 — 자손까지 끝났는지
// ---------------------------------------------------------------------------

test('parseProcessTable / ProcessTree: 자손을 모으고, 부모가 먼저 죽어도 놓치지 않고, 다시 쓰인 PID 의 남의 자식은 줍지 않는다', () => {
  const t = parseProcessTable('100 1 5000\r\n  200 100 5100\r\n\r\nheader junk\r\n300 200 5200\r\n900 1 4000\r\n');
  assert.deepEqual(t.map((p) => [p.pid, p.ppid]), [[100, 1], [200, 100], [300, 200], [900, 1]]);
  const P = (pid, ppid, born) => ({ pid, ppid, born: String(born).padStart(20, '0') });
  const pids = (list) => list.map((p) => p.pid).sort((a, b) => a - b);

  // 손자까지, 남의 프로세스는 빼고
  const tree = new ProcessTree(100);
  tree.absorb([P(100, 1, 5000), P(200, 100, 5100), P(300, 200, 5200), P(900, 1, 4000), P(901, 900, 4100)]);
  assert.deepEqual(pids([...tree.tracked.values()]), [100, 200, 300]);

  // 부모(200)가 먼저 죽었다: 표에 200 은 없지만 손자 300 은 아직 있고, 뒤늦게 300 이 낳은 400 도 잡는다
  const later = [P(300, 200, 5200), P(400, 300, 5300), P(900, 1, 4000)];
  tree.absorb(later);
  assert.deepEqual(pids(tree.alive(later)), [300, 400], '띄운 PID 는 죽었어도 자손이 남았다');

  // 전부 끝났다
  assert.deepEqual(tree.alive([P(900, 1, 4000)]), []);

  // 죽은 200 의 PID 를 남의 프로세스가 다시 쓴다: 그것(과 그 자식)은 우리 것이 아니다
  const reused = [P(200, 1, 9000), P(500, 200, 9100)];
  tree.absorb(reused);
  assert.ok(!tree.tracked.has(500), '다시 쓰인 PID 의 자식을 줍지 않는다');
  assert.deepEqual(tree.alive(reused), [], '같은 PID 라도 만든 시각이 다르면 살아 있는 우리 프로세스로 치지 않는다');

  // 다시 쓰이기 전에 태어난 진짜 자식은 잡는다(부모 PID 자리에 다른 프로세스가 들어온 뒤에 표를 떴어도)
  const t2 = new ProcessTree(10).absorb([P(10, 1, 100), P(20, 10, 110)]);
  t2.absorb([P(20, 1, 900), P(30, 20, 120), P(40, 20, 950)]);
  assert.ok(t2.tracked.has(30) && !t2.tracked.has(40));

  // 띄운 PID 가 한 번도 표에 안 잡혔으면(곧바로 끝남) 아무것도 모으지 않는다
  assert.equal(new ProcessTree(77).absorb([P(1, 0, 1), P(2, 1, 2)]).size, 0);
  assert.equal(new ProcessTree(77).absorb(null).size, 0);
});

test('listProcesses: 진짜 표에 이 시험 프로세스가 있고 부모 PID 가 맞다', () => {
  const table = listProcesses();
  assert.ok(Array.isArray(table) && table.length > 5, '프로세스 표를 읽는다');
  const me = table.find((p) => p.pid === process.pid);
  assert.ok(me, '자기 자신이 표에 있다');
  assert.equal(me.ppid, process.ppid);
});

test('codexCmdArgs: cmd 는 언제나 /d 로(레지스트리의 AutoRun 명령을 돌리지 않는다)', () => {
  assert.deepEqual(codexCmdArgs('X:\\codex.cmd', ['--version']), ['/d', '/c', 'X:\\codex.cmd', '--version']);
  assert.equal(codexCmdArgs('x')[0], '/d');
  const src = fs.readFileSync(path.join(REPO, 'verify', 'firstrun-probe.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const bare = code.split('\n').filter((l) => /\[\s*'\/c'/.test(l));
  assert.deepEqual(bare, [], `/d 없이 /c 로 시작하는 cmd 인수를 만들지 않는다: ${bare.join(' | ')}`);
});

test('가짜 CLI + 진짜 프로세스 표: 부모만 끝나고 자손이 남으면 그 PID 만 다시 끝내고, 다 끝난 뒤에만 "끝났다"', { timeout: 120_000 }, async () => {
  await withSoul('e2e-tree', async ({ root, env }) => {
    const pidFile = path.join(tmp, 'e2e-tree', 'child.pid');
    const rootOnly = (pid) => { try { process.kill(pid); return 'ended'; } catch { return 'already-gone'; } }; // 나무를 따라가지 않는 끝내기
    const killed = [];
    const obs = await probeClaude({ root, exe: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('claude-clean', '--spawn-child', pidFile),
      watch: { ...REAL_TREE, kill: rootOnly, killOne: (pid) => { killed.push(pid); return endOnePid(pid); } } });
    const child = Number(fs.readFileSync(pidFile, 'utf8'));
    try {
      assert.ok(child > 0 && child !== obs.pid);
      assert.equal(pidAlive(obs.pid), false, '부모는 끝났다');
      assert.ok(obs.stopInfo.retried.includes(child), `남은 자손을 찾았다: ${obs.stopInfo.retried}`);
      assert.deepEqual(killed, obs.stopInfo.retried, '장부에 있던 그 PID 들만 다시 끝냈다');
      assert.ok(!killed.includes(process.pid) && !killed.includes(process.ppid), '시험 프로세스 쪽은 건드리지 않았다');
      assert.equal(obs.stopped, 'ended-after-retry');
      assert.equal(obs.childGone, true);
      assert.deepEqual(obs.stopInfo.left, []);
      assert.deepEqual(failed(obs.checks), []);
      assert.match(obs.checks.find((c) => c.name.startsWith('⑩')).detail, new RegExp(`따로 끝낸 자손 pid=${child}`));
      assert.equal(pidAlive(child), false, '자손도 끝났다');
    } finally { endOnePid(child); endOwnPid(obs.pid); }
  });
});

test('가짜 CLI + 진짜 프로세스 표: 다시 끝내도 자손이 남으면 실패이고 남은 PID 를 찍는다(부모가 죽었어도)', { timeout: 120_000 }, async () => {
  await withSoul('e2e-tree-left', async ({ root, env }) => {
    const pidFile = path.join(tmp, 'e2e-tree-left', 'child.pid');
    const rootOnly = (pid) => { try { process.kill(pid); return 'ended'; } catch { return 'already-gone'; } };
    const obs = await probeCodex({ root, cmdFile: 'unused', env, driver: pipeDriver(), launch: fakeLaunch('codex-clean', '--spawn-child', pidFile), peekWarnings: false,
      watch: { ...REAL_TREE, kill: rootOnly, killOne: () => 'ended', stopWaitMs: 1500 } });
    const child = Number(fs.readFileSync(pidFile, 'utf8'));
    try {
      assert.equal(pidAlive(obs.pid), false, '띄운 PID 는 끝났다 — 그것만 보면 "끝났다"로 읽힌다');
      assert.equal(pidAlive(child), true);
      assert.equal(obs.stopped, 'failed');
      assert.equal(obs.childGone, false);
      assert.ok(obs.stopInfo.left.includes(child), `남은 자손을 찍는다: ${obs.stopInfo.left}`);
      assert.ok(!obs.stopInfo.left.includes(obs.pid), '띄운 PID 는 남은 목록에 없다');
      assert.deepEqual(failed(obs.checks), ['⑥']);
      assert.match(obs.checks.find((c) => c.name.startsWith('⑥')).detail, new RegExp(`남은 pid=${child}`));
      assert.equal(exitCodeOf({ codex: { state: 'failed' } }), EXIT.failed);
    } finally {
      endOnePid(child);
      for (let i = 0; i < 25 && pidAlive(child); i++) await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(pidAlive(child), false);
  });
});

test('프로세스 표를 읽지 못하면 "끝났다"고 하지 않는다', { timeout: 60_000 }, async () => {
  const obs = await watchFirstScreen({ driver: pipeDriver(), ...fakeLaunch('claude-clean'), cwd: tmp, env: process.env, quietMs: 300, minMs: 300, maxMs: 5000, tickMs: 100, list: () => null, listAsync: async () => null });
  const s = await obs.stop();
  assert.equal(s.how, 'failed');
  assert.match(s.reason, /프로세스 표를 읽지 못해/);
  assert.equal(pidAlive(obs.pid), false, '끝내기 자체는 했다');
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
    for (const r of [ok, other, breaks, chatty, upd]) assert.equal(pidAlive(r.obs.pid), false);
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
