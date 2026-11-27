// tests/firstrun-probe.test.mjs 가 쓰는 가짜 CLI. 실제 클로드 · 코덱스의 첫 화면 글(2026-11-27 재현에서 옮긴 줄)을
// 장면별로 찍고 살아 있는다(끝내는 것은 시험 쪽 — 자기가 띄운 PID 로).
// 이 가짜는 **고른 장면을 찍을 뿐 설정(씨앗)을 읽지 않는다** — 묶는 것은 "이런 화면이면 판정이 이렇게 난다"까지다.
// "씨앗을 빼면 실제 CLI 의 화면이 이렇게 바뀐다"는 실제 CLI 로 손으로 돌린 대조 재현의 몫이다(검증기록 5-82).
//   node firstrun-fake-cli.mjs <scene> [--dump <file>] [--ping]
//     --dump  받은 환경 변수 이름과 인수를 파일에 적는다(격리 확인용 — 값은 주소 · 폴더만)
//     --ping  ANTHROPIC_BASE_URL 로 요청 하나를 보내고 받은 상태 코드를 화면에 적는다(죽은 주소 확인용)
import fs from 'node:fs';
import http from 'node:http';

const [scene = 'claude-clean', ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i === -1 ? null : (rest[i + 1] ?? true); };
const CLEAR = '\x1b[2J\x1b[H';
const RULE = '─'.repeat(60);

const CLAUDE_HEAD = [' ▐▛███▛█   Claude Code v0.0.0-fake', '▝▜██████▀  Opus 5.5 with high effort · Claude API', ' ▝▝   ▝▝   <fake soul>', ''];
const CODEX_HEAD = ['', '  >_ OpenAI Codex (v0.0.0-fake)', '     <fake soul>', '  permissions: YOLO mode', ''];

const SCENES = {
  'claude-clean': [...CLAUDE_HEAD, RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents              ● high · /effort'],
  'claude-auto-mode': [...CLAUDE_HEAD, RULE, '❯', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents              ● high · /effort'],
  'claude-auto-nudge': [...CLAUDE_HEAD, RULE, '  Make auto mode your default permission mode?', '',
    '  Auto mode lets Claude handle permission prompts automatically.', '',
    '  ❯ Yes, set auto mode as my default permission mode', '    No, keep bypass permissions'],
  'claude-trust': [RULE, ' Do you trust the files in this folder?', '', ' ❯ 1. Yes, proceed', '   2. No, exit', '', ' Enter to confirm · Esc to cancel'],
  'claude-hook-error': [...CLAUDE_HEAD, '  ⎿  SessionStart:startup hook error', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'],
  'codex-clean': [...CODEX_HEAD, '› Ask Codex to do anything', '', '  GPT-6.1-Sol medium fast · <fake soul>', '  ← for agents · ? for shortcuts                    ⚠ 4 warnings · f2 to view'],
  'codex-update': ['  ✨ Update available! 0.0.1 -> 0.0.2', '', '› 1. Update now (runs `npm install -g @openai/codex`)', '  2. Skip', '  3. Skip until next version', '', '  enter continue · esc skip'],
  'codex-busy': [...CODEX_HEAD, '• Starting MCP servers (2/7): playwright, self-improve (3s • esc to interrupt)', '', '› Ask Codex to do anything'],
  'exit-early': ['Error: account/read failed: workspace routing discovery failed (code -32603)'],
  'claude-chatty': [...CLAUDE_HEAD, '  loading plugins… 0', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'],
};

const dump = flag('--dump');
if (typeof dump === 'string') {
  const keep = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP'];
  fs.writeFileSync(dump, JSON.stringify({ argv: process.argv.slice(2), names: Object.keys(process.env).sort(), values: Object.fromEntries(keep.map((k) => [k, process.env[k] ?? null])) }), 'utf8');
}

const lines = SCENES[scene];
if (!lines) { process.stderr.write(`unknown scene ${scene}\n`); process.exit(64); }
process.stdout.write(`${CLEAR}${lines.join('\r\n')}\r\n`);

if (flag('--ping')) {
  const url = new URL('/v1/ping', process.env.ANTHROPIC_BASE_URL);
  http.get(url, (res) => { res.resume(); process.stdout.write(`ping ${res.statusCode}\r\n`); }).on('error', (e) => process.stdout.write(`ping error ${e.code}\r\n`));
}

if (scene === 'exit-early') setTimeout(() => process.exit(1), 100);
else if (scene === 'claude-chatty') {
  // 입력 칸은 계속 보이는데 출력이 멈추지 않는다(위쪽 한 줄이 계속 바뀐다) — "가라앉지 않는 첫 화면".
  let n = 0;
  setInterval(() => { n += 1; process.stdout.write(`${CLEAR}${[...CLAUDE_HEAD, `  loading plugins… ${n}`, RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\r\n')}\r\n`); }, 120);
} else {
  // 보기 키(F2)를 받으면 경고 쪽 하나를 보여 준다(코덱스 0.172.0 의 꼴).
  process.stdin.on('data', (d) => {
    if (String(d).includes('\x1bOQ')) process.stdout.write(`${CLEAR}  Warnings · 1 of 1 · Startup\r\n  \`[features].multi_agent\` is deprecated.\r\n  k keep & next · esc dismiss & close\r\n`);
  });
  setInterval(() => {}, 1000);
}
