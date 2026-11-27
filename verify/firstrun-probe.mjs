// verify/firstrun-probe.mjs -- 오프라인 첫 실행 재현 (2026-11-27, 잠금 판 올림 W9)
//
// 배경: 2026-11-09 학교 컴퓨터실에서 새 PC 의 클로드가 시작 안내창(크롬 안내 · 전체화면 권유 · 자동 모드 권유)에
// 걸려 대화창이 비고 권한이 auto 로 바뀌었다(검증기록 5-71). 그 뒤 "잠금 판을 올릴 때는 설치기 씨앗을 넣은
// 오프라인 첫 실행 재현을 거친다"가 규칙이 됐지만(AGENTS.md 「비서 자동 업데이트」, 검증기록 5-74) 재현은 그때그때
// 손으로 했다. 이 스크립트가 그 손 절차를 그대로 밟는다:
//
//   ① 가짜 영혼   임시 폴더에 영혼 루트를 만들고, 설치기가 쓰는 설정을 **설치기 함수로** 넣는다
//                 (setup/adapters.mjs run() = settings.json · 훅 · .claude.json 씨앗 · config.toml · hooks.json).
//   ② 죽은 주소   127.0.0.1 의 임의 포트에 "무엇이 와도 503" 서버를 띄우고, API 주소와 프록시를 전부 그리로 돌린다.
//                 살아 있는 중계기(3456)와 바깥 서버에는 한 번도 닿지 않는다. 요청문을 보내지 않는다(모델 호출 0).
//   ③ 첫 화면     잠금 판의 실제 CLI 를 IRIS 창과 같은 인수 · 같은 크기의 가상 터미널로 띄워 첫 화면이 가라앉을 때까지 본다.
//   ④ 판정        묻는 창 없이 입력 칸까지 갔는가 · 권한 표시가 bypass 인가 · 시작 안내창이 없는가 · 대화 번호가
//                 그대로인가(다른 번호의 기록이 생기지 않았는가) · 시작 훅이 오류 없이 불렸는가. 코덱스는 설치 PC 꼴
//                 설정(model_provider · multi_agent · 신뢰 표)으로 물음 없이 입력 칸이 보이는가 + 경고 줄 수집
//                 (접힌 경고는 판정이 끝난 뒤 보기 키 F2 로 펼쳐 기록에 남긴다 — 요청문이 아니다).
//
// 이 검사가 못 보는 것(실제 PC 시험의 몫): 서버 깃발 · 로그인 계정에 달린 안내창 / 요청 뒤의 일(첫 답 · 기록 파일 ·
// 옛 대화 재개 · 작업 도중 물음) / 코덱스의 ChatGPT 로그인으로 시작하는 길(writeFakeCodexAuth 의 설명) / 코덱스
// 업데이트 물음(네트워크가 있어야 뜬다) / 실제 MCP 서버가 뜨는 동안의 화면(가짜 영혼에는 MCP 실행 파일이 없다).
//
// 화면 판정식은 IRIS 창 `daemon/sessions.mjs` 의 것을 쓴다 — 옆 폴더의 창 소스가 있으면 거기서 읽고(달라졌으면 알린다),
// 없으면 이 파일의 사본(BUILTIN_SCREEN_RE)을 쓴다. 가상 터미널(node-pty · @xterm/headless)도 창의 것을 빌린다.
//
// 안전 규칙:
//   · 쓰는 곳은 작업 폴더(기본 _build/firstrun-probe/, --work 로 바꿈) 하나. CLAUDE_CONFIG_DIR · CODEX_HOME · HOME ·
//     USERPROFILE · APPDATA · LOCALAPPDATA · TEMP 를 전부 그 안으로 준다. 자식 환경은 허용 목록으로 새로 짠다
//     (이 PC 의 열쇠 · 주소 · 세션 표식이 새지 않는다).
//   · 에이전트 심(shims\claude.cmd · codex.cmd)은 쓰지 않는다 — 심은 살아 있는 중계기 주소를 박아 넣는다.
//     같은 까닭으로 config.toml 의 중계기 주소만 죽은 주소로 바꾼다(그 밖의 글자는 설치기가 쓴 그대로).
//   · 로그인하지 않는다. 열쇠는 형식만 갖춘 가짜다. 프로세스는 이 스크립트가 띄운 PID 만 PID 로 끝낸다.
//   · 돌릴 수 없는 한 곳 = 레지스트리: 클로드가 `--chrome` 으로 건드릴 수 있는 HKCU 브라우저 연동 등록은 떠 두었다가
//     달라진 자리만 되돌린다(아래 「브라우저 연동 등록 지키기」).
//   · 종료 코드: 0 = 본 것 전부 통과 · 1 = 실패 · 2 = 준비물(창의 가상 터미널 · CLI)이 없어 못 본 에이전트가 있음.
//
// Usage:
//   node verify/firstrun-probe.mjs [--agent claude|codex|both] [--face <IRIS 창 소스 폴더>]
//        [--claude-exe <claude.exe>] [--codex-cmd <codex.cmd>] [--work <dir>] [--log-dir <dir>] [--label <이름>]
//        [--control no-nudges|no-permissions] [--codex-auth apikey|chatgpt] [--keep]
//   인수 없이 = 잠금표의 두 CLI. 클로드는 설치기 함수로 내려받고(인터넷 필요), 코덱스는 빌드 캐시
//   (_build/cache/npm/codex — 판이 잠금표와 같을 때)를 쓴다. 준비물이 없어 못 본 에이전트가 있으면 종료 코드 2.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as adapters from '../installer/setup/adapters.mjs';
import { CLAUDE_START_NUDGES, CLAUDE_MAX_PERMISSIONS, claudeConfigJsonPath, claudeSettingsPath, codexConfigTomlPath } from '../installer/lib/firstrun.mjs';
import { CODEX_RELAY_BASE_URL, CODEX_PROVIDER_ID } from '../installer/lib/shims.mjs';
import { installClaude, readLock } from '../installer/lib/online.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 화면 판정 — IRIS 창 daemon/sessions.mjs idleCheck 와 같은 식
// ---------------------------------------------------------------------------

export const SCREEN_RE_NAMES = Object.freeze(['WORKING_RE', 'SPINNER_RE', 'ATTENTION_RE', 'CODEX_UPDATE_PROMPT_RE', 'PROMPT_RE']);

// 창 2.107.0 의 식을 옮긴 사본(창 소스를 못 읽을 때만 쓴다). 창이 식을 바꾸면 loadFaceScreenRegexes 가 drift 로 알린다.
export const BUILTIN_SCREEN_RE = Object.freeze({
  WORKING_RE: /(esc to interrupt|ctrl\+c to interrupt|Cogitating|Thinking…|Working \(|\(\d+s • esc|Starting MCP servers)/i,
  SPINNER_RE: /^\s*[✢✶✻✽✳·•*]\s*([A-Za-z가-힣][A-Za-z가-힣 ]{1,30}…)/,
  ATTENTION_RE: /(Do you trust|trust the contents|Press t to trust|enter to review hooks|Yes, continue|Yes, proceed|\(y\/n\)|\[Y\/n\]|Press enter|Esc to cancel|Enter to confirm|Enter to select|Do you want to proceed\?|Would you like to proceed\?|Ready to submit|Submit answers|1\. Yes|허용하시겠|계속하시겠|승인하시겠|승인할까요)/i,
  CODEX_UPDATE_PROMPT_RE: /Update available[\s\S]*2\. Skip/,
  PROMPT_RE: /(^|\n)\s*(❯|›|»|>)(\s|$)/,
});

/** 창 소스(daemon/sessions.mjs)의 글에서 `const 이름 = /…/깃발;` 줄을 읽는다. 못 읽은 이름은 사본을 쓴다. */
export function parseScreenRegexes(sourceText) {
  const re = {};
  const missing = [];
  for (const name of SCREEN_RE_NAMES) {
    const m = new RegExp(`^const ${name} = \\/(.+)\\/([a-z]*);`, 'm').exec(String(sourceText ?? ''));
    let made = null;
    if (m) { try { made = new RegExp(m[1], m[2]); } catch { made = null; } }
    if (made) re[name] = made; else { re[name] = BUILTIN_SCREEN_RE[name]; missing.push(name); }
  }
  const drift = SCREEN_RE_NAMES.filter((n) => !missing.includes(n) && String(re[n]) !== String(BUILTIN_SCREEN_RE[n]));
  return { re, missing, drift };
}

export function loadFaceScreenRegexes(faceDir) {
  if (!faceDir) return { source: 'builtin', re: { ...BUILTIN_SCREEN_RE }, missing: [], drift: [] };
  try {
    const text = fs.readFileSync(path.join(faceDir, 'daemon', 'sessions.mjs'), 'utf8');
    const got = parseScreenRegexes(text);
    return { source: got.missing.length === SCREEN_RE_NAMES.length ? 'builtin' : 'face', ...got };
  } catch {
    return { source: 'builtin', re: { ...BUILTIN_SCREEN_RE }, missing: [...SCREEN_RE_NAMES], drift: [] };
  }
}

/**
 * 화면(빈 줄을 뺀 줄 배열)을 창과 같은 식으로 읽는다.
 *   -> { status: 'busy'|'idle'|'attention', promptNear, spinner, attention, updatePrompt, tail }
 */
export function classifyScreen(lines, re = BUILTIN_SCREEN_RE) {
  const tailLines = (Array.isArray(lines) ? lines : String(lines ?? '').split('\n')).filter((l) => String(l).trim()).slice(-14);
  const tail = tailLines.join('\n');
  const spinner = tailLines.map((l) => l.match(re.SPINNER_RE)).find(Boolean) ?? null;
  const promptNear = tailLines.slice(-4).some((l) => /^\s*(❯|›|>)\s*$/.test(l));
  const working = re.WORKING_RE.test(tail);
  const attention = re.ATTENTION_RE.test(tail);
  const updatePrompt = re.CODEX_UPDATE_PROMPT_RE.test(tail);
  const status = (working || spinner) ? 'busy'
    : (promptNear ? 'idle'
      : ((attention || updatePrompt) ? 'attention'
        : (re.PROMPT_RE.test(tail) ? 'idle' : 'busy')));
  return { status, promptNear, spinner: spinner ? spinner[1].trim() : null, working, attention, updatePrompt, tail };
}

// 이름 붙인 시작 물음 · 안내창. 판정의 뼈대는 "입력 칸까지 갔는가"(모르는 창도 거기서 걸린다)이고, 이 표는 무엇이 떴는지 이름을 붙인다.
// 문구 출처: 검증기록 5-71(학교 PC 화면 원문) · 창 sessions.mjs · 이 스크립트의 대조군(--control) 실측.
export const START_DIALOGS = Object.freeze([
  { id: 'trust-folder', agent: '*', re: /Do you trust the files in this folder|trust the contents of this directory|Press t to trust/i },
  { id: 'claude-onboarding', agent: 'claude', re: /Choose the text style|Select login method|Let's get started/i },
  { id: 'claude-in-chrome', agent: 'claude', re: /Claude in Chrome (is now|extension|lets|works)|Use Claude in Chrome\?|Chrome extension[^\n]{0,80}(install|connect)/i },
  { id: 'fullscreen-renderer', agent: 'claude', re: /fullscreen renderer\?|Try the new fullscreen/i },
  { id: 'auto-mode-default', agent: 'claude', re: /auto mode your default|Make auto mode/i },
  { id: 'code-mode-optin', agent: 'claude', re: /Try Code Mode|Enable Code Mode\?/i },
  { id: 'consent-notice', agent: 'claude', re: /Updates to (our )?(Consumer )?Terms|Help improve Claude|training (consent|preference)|Review (the )?(updated )?terms/i },
  { id: 'bypass-warning', agent: 'claude', re: /Bypass Permissions mode[\s\S]{0,400}(Yes, I accept|No, exit)/i },
  { id: 'api-key-question', agent: 'claude', re: /Detected a custom API key|Do you want to use this API key/i },
  { id: 'codex-sign-in', agent: 'codex', re: /Sign in with ChatGPT|Welcome to Codex[\s\S]{0,200}(Sign in|log in)/i },
  { id: 'codex-update', agent: 'codex', re: /Update available[\s\S]{0,300}Skip/ },
  { id: 'codex-hooks-review', agent: 'codex', re: /Hooks need review|enter to review hooks/i },
  { id: 'codex-sandbox-setup', agent: 'codex', re: /set up your sandbox|Administrator permissions/i },
  { id: 'codex-model-migration', agent: 'codex', re: /Try new model|Switch to|Use existing model/i },
]);

export function findDialogs(text, agent) {
  const s = String(text ?? '');
  return START_DIALOGS.filter((d) => (d.agent === '*' || d.agent === agent) && d.re.test(s)).map((d) => d.id);
}

const HOOK_ERROR_RE = /hook error|ParserError|Git Bash was not found|requires bash|hook (timed out|failed)/i;

export function judgeClaude(obs) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  const final = obs.final ?? classifyScreen([]);
  const all = obs.timelineText ?? '';
  const dialogs = findDialogs(all, 'claude');
  add('① 살아 있음', obs.alive && !obs.exited, `pid=${obs.pid ?? '-'} exited=${!!obs.exited}${obs.exited ? ` code=${obs.exitCode}` : ''}`);
  add('② 묻는 창 없이 입력 칸까지', final.status === 'idle' && final.promptNear && !final.attention, `status=${final.status} emptyPrompt=${final.promptNear} attention=${final.attention}`);
  add('③ 시작 안내창 없음', dialogs.length === 0, dialogs.length ? `떴음: ${dialogs.join(', ')}` : '0');
  const mode = /bypass permissions on/i.test(final.tail ?? '') ? 'bypass' : ((/(auto|plan|accept edits|manual)[ a-z]* (mode )?on/i.exec(final.tail ?? '') || [])[0] ?? 'none');
  add('④ 권한 표시 = bypass', mode === 'bypass', `표시=${mode}`);
  // 요청을 보내기 전에는 기록 파일이 아직 없다(2.1.311 · 2.1.326 실측) — 새 번호로 재시작했다면 다른 번호의 기록이 생긴다.
  add('⑤ 대화 번호 그대로(다른 번호의 기록 없음)', (obs.foreignRecords ?? []).length === 0,
    `expectedRecord=${obs.expectedRecord ? 'present' : 'absent(요청 전)'} foreign=${(obs.foreignRecords ?? []).length}`);
  const hookErrors = (obs.allLines ?? []).filter((l) => HOOK_ERROR_RE.test(l));
  add('⑥ 시작 훅 오류 줄 없음', hookErrors.length === 0, hookErrors.length ? hookErrors.slice(0, 3).join(' | ') : `0 (훅 호출 ${obs.hookCalls ?? 0}회)`);
  if (obs.expectHookCall) add('⑦ 시작 훅이 실제로 불림', (obs.hookCalls ?? 0) > 0, `훅 호출 ${obs.hookCalls ?? 0}회`);
  add('⑧ 기록 저장 꺼짐 표시 없음', !/Transcript saving is off/i.test(all), /Transcript saving is off/i.test(all) ? '세션 표식이 자식 환경에 샜다' : 'ok');
  if (obs.expectDefaultMode !== undefined) add('⑨ 설정의 기본 권한이 씨앗 그대로', obs.defaultModeAfter === obs.expectDefaultMode, `settings.json permissions.defaultMode=${obs.defaultModeAfter ?? '없음'}`);
  return out;
}

export function judgeCodex(obs) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  const final = obs.final ?? classifyScreen([]);
  const all = obs.timelineText ?? '';
  const dialogs = findDialogs(all, 'codex');
  add('① 살아 있음', obs.alive && !obs.exited, `pid=${obs.pid ?? '-'} exited=${!!obs.exited}${obs.exited ? ` code=${obs.exitCode}` : ''}`);
  add('② 묻는 창 없이 입력 칸까지', final.status === 'idle' && !final.attention && !final.updatePrompt && /(^|\n)\s*(›|»)(\s|$)/.test(final.tail ?? ''),
    `status=${final.status} attention=${final.attention} updatePrompt=${final.updatePrompt}`);
  add('③ 시작 물음 없음', dialogs.length === 0, dialogs.length ? `떴음: ${dialogs.join(', ')}` : '0');
  // 코덱스는 시작 경고를 상태줄 배지("⚠ N warnings · f2 to view")로 접어 둔다. 경고는 막지 않으면 통과다(②가 본다).
  // 무엇이 경고인지는 판정 뒤에 펼쳐 읽은 쪽(warningView)에서 가른다: Startup = 설정 · 인수 경고, MCP = 서버 기동 실패
  // (가짜 영혼에는 MCP 실행 파일이 없으니 재현의 부산물이다).
  const badge = Math.max(0, ...(obs.allLines ?? []).map((l) => Number((/⚠\s*(\d+) warnings?/.exec(l) || [])[1] ?? 0)));
  const pages = Array.isArray(obs.warningView) ? obs.warningView : [];
  const startup = pages.filter((p) => /Warnings · \d+ of \d+ · Startup/.test(p)).map((p) => p.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim());
  const mcp = pages.filter((p) => /Warnings · \d+ of \d+ · MCP/.test(p)).length;
  add('④ 경고가 입력 칸을 가리지 않음', final.status === 'idle', `상태줄 경고 ${badge}건${pages.length ? `(시작 ${startup.length} · MCP ${mcp} — MCP 는 가짜 영혼의 부산물)` : ''}`);
  // CLI 가 자기 표(신뢰 · 안내 "봤음" 등)를 덧붙이는 것은 괜찮다 — 설치기가 쓴 줄이 없어지면 실패.
  const removed = obs.configDiff?.removed ?? [];
  add('⑤ 설치기가 쓴 설정 줄을 CLI 가 지우지 않음', removed.length === 0,
    removed.length ? `없어진 줄: ${removed.slice(0, 3).join(' | ')}` : `ok${obs.configChanged ? ` (CLI 가 더한 줄 ${(obs.configDiff?.added ?? []).length})` : ''}`);
  return { checks: out, warnings: startup, mcpArtifacts: mcp, warningBadge: badge };
}

// ---------------------------------------------------------------------------
// 죽은 주소 · 자식 환경
// ---------------------------------------------------------------------------

/** 무엇이 와도 503. 프록시로 온 CONNECT 도 503. 받은 것(메서드 · 호스트 · 경로)만 적는다 — 머리글 · 본문은 적지 않는다. */
export async function startDeadServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let where = String(req.url ?? '').split('?')[0];
    hits.push({ at: Date.now(), method: req.method, host: req.headers.host ?? null, path: where.slice(0, 200) });
    req.resume();
    res.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
    res.end('{"error":{"type":"probe_offline","message":"firstrun-probe: no network in this run"}}');
  });
  // 상대가 먼저 끊으면 소켓이 'error' 를 낸다 — 받아 두지 않으면 이 스크립트가 죽는다(띄운 CLI 를 못 끝낸 채로).
  server.on('connection', (socket) => { socket.on('error', () => {}); });
  server.on('connect', (req, socket) => {
    socket.on('error', () => {});
    hits.push({ at: Date.now(), method: 'CONNECT', host: String(req.url ?? '').slice(0, 200), path: null });
    try { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); } catch { /* 이미 닫힘 */ }
  });
  server.on('upgrade', (req, socket) => { socket.on('error', () => {}); hits.push({ at: Date.now(), method: 'UPGRADE', host: req.headers.host ?? null, path: String(req.url ?? '').split('?')[0] }); try { socket.destroy(); } catch { /* */ } });
  server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* */ } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`, port, hits,
    close: () => new Promise((resolve) => { try { server.closeAllConnections?.(); } catch { /* */ } server.close(() => resolve()); }),
  };
}

// 자식에게 물려줄 이 PC 의 환경 — 윈도가 돌아가는 데 필요한 것만. 그 밖(열쇠 · 주소 · 세션 표식 · 프록시)은 넘기지 않는다.
export const ENV_PASS = Object.freeze(['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles',
  'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PUBLIC', 'ALLUSERSPROFILE', 'DriverData']);

/**
 * isolatedEnv -- 새 PC 꼴의 자식 환경. 설정 · 홈 · 임시 폴더는 전부 home(작업 폴더 안)으로, 나가는 길은 전부 죽은 주소로.
 * PATH = 영혼의 심 · node + 윈도 기본 폴더(= Git 을 깐 적 없는 PC).
 */
export function isolatedEnv({ root, home, deadUrl, base = process.env, extra = {} }) {
  const env = {};
  const lower = new Map(Object.keys(base).map((k) => [k.toLowerCase(), k]));
  for (const k of ENV_PASS) { const real = lower.get(k.toLowerCase()); if (real && base[real] !== undefined) env[k] = base[real]; }
  const sys = env.SystemRoot || 'C:\\Windows';
  const shared = path.join(root, '_agent', 'shared');
  env.PATH = [path.join(shared, 'shims'), path.join(shared, 'tools', 'node'), path.join(sys, 'System32'), sys,
    path.join(sys, 'System32', 'Wbem'), path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter);
  const dirs = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp') };
  for (const [k, v] of Object.entries(dirs)) { fs.mkdirSync(v, { recursive: true }); env[k] = v; }
  env.HOMEDRIVE = path.parse(home).root.replace(/\\$/, '');
  env.HOMEPATH = home.slice(env.HOMEDRIVE.length) || '\\';
  env.USERNAME = 'iris-probe';
  env.COMPUTERNAME = 'IRIS-PROBE';
  env.CLAUDE_CONFIG_DIR = path.join(root, '_agent', 'claude');
  env.CODEX_HOME = path.join(root, '_agent', 'codex');
  env.ANTHROPIC_BASE_URL = deadUrl;
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) env[k] = deadUrl;
  env.TERM = 'xterm-256color';
  return { ...env, ...extra };
}

/** 환경에 이 PC 의 값이 샜는지(시험 · 자체 점검용): 허용 목록 · 우리가 넣은 것 말고 다른 키가 있으면 그 이름들. */
export function leakedKeys(env, base = process.env) {
  const ours = new Set(['PATH', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'COMPUTERNAME',
    'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'TERM',
    ...ENV_PASS].map((k) => k.toLowerCase()));
  return Object.keys(env).filter((k) => !ours.has(k.toLowerCase()) && base[k] !== undefined && base[k] === env[k]);
}

// ---------------------------------------------------------------------------
// 가짜 영혼 — 설정은 설치기 함수가 쓴다
// ---------------------------------------------------------------------------

/**
 * seedSoul -- 임시 영혼 루트에 설치기의 ⑤-어댑터 단계를 그대로 돌린다(= 새 PC 가 첫 세션 전에 갖는 설정).
 * 부품(플러그인 · MCP 서버 · 파이썬)은 없다 — 그래서 MCP 서버는 뜨지 못하고(부산물), 훅이 부르는 실행 파일은 대역을 둔다:
 *   · shims\python.cmd   불린 인수를 _probe\hook-calls.log 에 한 줄 적고 0 으로 끝나는 대역(훅의 파워셸 꼴이 도는지 본다)
 *   · tools\node\node.exe 이 스크립트를 돌리는 node 의 사본(로그인 열쇠 알림 훅 · 코덱스 실행 꾸러미가 쓴다)
 *   · tools\iris-auth\    payload-src 의 실제 도구(읽기만 하는 --hook)
 * control: 'no-nudges' = 시작 안내창 "봤음" 키를 뺀다 · 'no-permissions' = 권한 씨앗을 뺀다(판정기가 잡는지 보는 대조군).
 */
export async function seedSoul({ root, lock, deadUrl, control = null, nodeStandIn = true, log = () => {} }) {
  fs.mkdirSync(root, { recursive: true });
  const payloadDir = path.join(path.dirname(root), `${path.basename(root)}-payload`);
  const hooksSrc = path.join(REPO, 'payload-src', 'policy', 'hooks');
  fs.mkdirSync(path.join(payloadDir, 'policy', 'hooks'), { recursive: true });
  for (const f of fs.readdirSync(hooksSrc)) fs.copyFileSync(path.join(hooksSrc, f), path.join(payloadDir, 'policy', 'hooks', f));

  const shared = path.join(root, '_agent', 'shared');
  const probeDir = path.join(root, '_probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const hookLog = path.join(probeDir, 'hook-calls.log');
  fs.mkdirSync(path.join(shared, 'shims'), { recursive: true });
  fs.writeFileSync(adapters.pythonShimPath(root), ['@echo off', `>>"${hookLog}" echo %*`, 'exit /b 0', ''].join('\r\n'), 'ascii');
  const nodeDst = adapters.nodeExePath(root);
  fs.mkdirSync(path.dirname(nodeDst), { recursive: true });
  if (nodeStandIn) { try { fs.linkSync(process.execPath, nodeDst); } catch { fs.copyFileSync(process.execPath, nodeDst); } }
  const authSrc = path.join(REPO, 'payload-src', 'tools', 'iris-auth');
  const authDst = adapters.authToolDir(root);
  fs.mkdirSync(authDst, { recursive: true });
  for (const f of fs.readdirSync(authSrc)) { if (f.endsWith('.mjs')) fs.copyFileSync(path.join(authSrc, f), path.join(authDst, f)); }

  const logs = [];
  const ctx = {
    root, payloadDir, lock,
    manifest: { schema: 1, package: { version: lock?.package?.version ?? '0.0.0' }, parts: {} },
    choice: { subscriptions: ['claude', 'codex'], leadAgent: 'claude' },
    precheck: { edge: { present: true } },
    offline: true,
    log: (line) => { logs.push(line); log(line); },
    progress: () => {},
    // 바깥 프로그램을 띄우지 않는다(레지스트리 조회 · 스킬 생성기 · 중계기 조사 전부 "없음"으로 답한다).
    run: async () => ({ code: 1, out: '', err: 'firstrun-probe: not run' }),
    fs,
    env: { PATH: '' },
  };
  const result = await adapters.run(ctx);

  const changed = [];
  // 살아 있는 중계기에 닿지 않게: config.toml 의 중계기 주소만 죽은 주소로(설치기 상수로 찾아 바꾼다).
  const toml = codexConfigTomlPath(root);
  const before = fs.readFileSync(toml, 'utf8');
  const relayOrigin = new URL(CODEX_RELAY_BASE_URL).origin;
  if (!before.includes(relayOrigin)) throw new Error(`config.toml 에 중계기 주소(${CODEX_PROVIDER_ID})가 없다 — 설치기가 쓰는 꼴이 바뀌었다`);
  fs.writeFileSync(toml, before.split(relayOrigin).join(deadUrl), 'utf8');
  changed.push('codex config.toml: relay origin -> dead address');

  if (control === 'no-nudges') {
    const file = claudeConfigJsonPath(root);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of Object.keys(CLAUDE_START_NUDGES)) delete data[k];
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    changed.push('control no-nudges: removed start-nudge keys');
  }
  if (control === 'no-permissions') {
    const file = claudeSettingsPath(root);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete data.permissions; delete data.skipDangerousModePermissionPrompt;
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    changed.push('control no-permissions: removed permission seed');
  }
  return { root, payloadDir, hookLog, recorded: result.recorded, pending: result.pending, changed, logs };
}

/**
 * 형식만 갖춘 가짜 코덱스 로그인. 실제 PC 는 설치기의 로그인 단계가 ChatGPT 로그인 꼴의 이 파일을 만든다.
 * 여기서는 **열쇠 꼴**로 쓴다: ChatGPT 로그인 꼴은 시작할 때 chatgpt.com 에 계정을 묻고(account/read · workspace routing
 * discovery), 네트워크가 없으면 화면을 그리기 전에 끝난다(0.167.0 · 0.172.0 실측 2026-11-27) — 오프라인으로는 재현할 수 없다.
 * 그래서 이 재현이 보는 것은 "설정 · 화면" 까지이고, ChatGPT 로그인으로 시작하는 길은 실제 PC 시험의 몫이다.
 */
// 주소 꼴 글자를 소스에 그대로 적지 않는다(저장소 정화 검사가 주소 꼴을 전부 막는다) — 실재하지 않는 .invalid 주소.
export const FAKE_LOGIN_EMAIL = ['probe', 'example.invalid'].join('@');
export function writeFakeCodexAuth(codexHome, style = 'apikey') {
  let auth = { OPENAI_API_KEY: 'sk-firstrun-probe-not-a-real-key', tokens: null, last_refresh: null };
  if (style === 'chatgpt') { // 대조용: 실제 PC 와 같은 꼴(서명 없는 토큰) — 오프라인에서는 시작하다 끝나는 것이 보인다
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const claims = { iss: 'https://auth.openai.com', aud: ['firstrun-probe'], exp: Math.floor(Date.now() / 1000) + 7 * 86400, email: FAKE_LOGIN_EMAIL,
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'probe-account', chatgpt_user_id: 'probe-user', user_id: 'probe-user' } };
    const jwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.${Buffer.from('probe').toString('base64url')}`;
    auth = { OPENAI_API_KEY: null, tokens: { id_token: jwt, access_token: jwt, refresh_token: 'probe-refresh', account_id: 'probe-account' }, last_refresh: new Date().toISOString() };
  }
  fs.mkdirSync(codexHome, { recursive: true });
  const file = path.join(codexHome, 'auth.json');
  fs.writeFileSync(file, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// 터미널 — 창의 node-pty · @xterm/headless 를 빌린다(없으면 파이프 대역 = 단위 시험용)
// ---------------------------------------------------------------------------

export function resolveFaceDir({ arg = null, env = process.env, lock = null } = {}) {
  const candidates = [arg, env.IRIS_FACE_SOURCE, lock?.parts?.face?.source ? path.resolve(REPO, lock.parts.face.source) : null].filter(Boolean);
  for (const c of candidates) { if (fs.existsSync(path.join(c, 'package.json'))) return c; }
  return null;
}

export function loadPtyDriver(faceDir) {
  if (!faceDir) return { ok: false, reason: 'IRIS 창 소스 폴더를 찾지 못함(--face 또는 IRIS_FACE_SOURCE)' };
  try {
    const req = createRequire(path.join(faceDir, 'package.json'));
    const pty = req('node-pty');
    const { Terminal } = req('@xterm/headless');
    return { ok: true, kind: 'pty', open: (o) => openPty({ pty, Terminal, ...o }) };
  } catch (e) {
    return { ok: false, reason: `창의 가상 터미널 모듈을 불러오지 못함(${String(e?.message || e).split('\n')[0]}) — 창 폴더에서 npm ci` };
  }
}

function openPty({ pty, Terminal, file, args, cwd, env, cols, rows }) {
  const screen = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env, useConpty: true });
  const st = { pid: proc.pid, raw: '', lastOutputAt: Date.now(), exited: false, exitCode: null };
  proc.onData((d) => { st.raw += d; st.lastOutputAt = Date.now(); screen.write(d); });
  proc.onExit(({ exitCode }) => { st.exited = true; st.exitCode = exitCode; });
  return {
    state: st,
    lines: async () => {
      await new Promise((r) => screen.write('', r));
      const buf = screen.buffer.active; const out = [];
      for (let y = 0; y < screen.rows; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '');
      return out;
    },
    write: (d) => { try { proc.write(d); } catch { /* 이미 끝남 */ } },
    // 이미 끝난 프로세스에 kill() 을 부르면 node-pty 의 도우미가 "AttachConsole failed" 를 찍는다 — 살아 있을 때만.
    dispose: () => { if (!st.exited && pidAlive(st.pid)) { try { proc.kill(); } catch { /* 이미 끝남 */ } } try { screen.dispose(); } catch { /* */ } },
  };
}

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');

/** 파이프 대역: 화면 = 마지막 "전체 지우기" 뒤의 글(제어 문자 뺌). 커서 이동을 쓰지 않는 가짜 CLI 용. */
export function pipeDriver() {
  return {
    ok: true, kind: 'pipe',
    open: ({ file, args, cwd, env }) => {
      const proc = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const st = { pid: proc.pid, raw: '', lastOutputAt: Date.now(), exited: false, exitCode: null };
      const on = (d) => { st.raw += d.toString('utf8'); st.lastOutputAt = Date.now(); };
      proc.stdout.on('data', on); proc.stderr.on('data', on);
      proc.on('exit', (code) => { st.exited = true; st.exitCode = code; });
      proc.on('error', () => { st.exited = true; st.exitCode = -1; });
      return {
        state: st,
        lines: async () => stripAnsi(st.raw.slice(Math.max(0, st.raw.lastIndexOf('\x1b[2J')))).replace(/\r/g, '').split('\n'),
        write: (d) => { try { proc.stdin.write(d); } catch { /* 이미 끝남 */ } },
        dispose: () => { try { proc.stdin.end(); } catch { /* */ } },
      };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 이 스크립트가 어떤 까닭으로든 죽을 때 남기지 않을 것 둘: 띄운 CLI(자기 PID) · 떠 둔 브라우저 연동 등록.
const ownPids = new Set();
let pendingRegistry = null; // { snapshot, dir }
let exitGuardOn = false;
function armExitGuard() {
  if (exitGuardOn) return;
  exitGuardOn = true;
  process.on('exit', () => {
    for (const pid of ownPids) { try { endOwnPid(pid); } catch { /* */ } }
    if (pendingRegistry) { try { restoreNativeHosts(pendingRegistry.snapshot, pendingRegistry.dir); } catch { /* */ } }
  });
  process.on('uncaughtException', (e) => { console.error(`firstrun-probe ERROR ${e?.stack || e}`); process.exit(EXIT.failed); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(EXIT.failed));
}

/** 이 스크립트가 띄운 PID 하나(와 그 자식)만 끝낸다. 이름으로 찾지 않는다. */
export function endOwnPid(pid) {
  if (!pid || !pidAlive(pid)) return 'already-gone';
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); return 'ended'; } catch { return pidAlive(pid) ? 'failed' : 'already-gone'; }
}

/**
 * watchFirstScreen -- CLI 를 띄워 첫 화면이 가라앉을 때까지 본다(아무것도 입력하지 않는다).
 * 가라앉음 = 출력이 quietMs 동안 멈췄고 화면 판정이 busy 가 아님(최소 minMs, 최대 maxMs). 끝내지는 않는다 — 부른 쪽이 stop().
 */
export async function watchFirstScreen({ driver, file, args, cwd, env, re = BUILTIN_SCREEN_RE, cols = 120, rows = 36, quietMs = 6000, minMs = 10000, maxMs = 90000, tickMs = 400 }) {
  const t0 = Date.now();
  armExitGuard();
  const term = driver.open({ file, args, cwd, env, cols, rows });
  if (term.state.pid) ownPids.add(term.state.pid);
  const timeline = [];
  let last = null; let final = classifyScreen([], re); let settled = false;
  for (;;) {
    await sleep(tickMs);
    const lines = (await term.lines()).map((l) => l.replace(/\s+$/, ''));
    const text = lines.join('\n').replace(/\n+$/, '');
    final = classifyScreen(lines, re);
    if (text !== last) { timeline.push({ t: Date.now() - t0, status: final.status, text }); last = text; }
    const now = Date.now();
    if (term.state.exited) break;
    if (now - t0 >= minMs && now - term.state.lastOutputAt >= quietMs && final.status !== 'busy') { settled = true; break; }
    if (now - t0 >= maxMs) break;
  }
  const allLines = [...new Set(timeline.flatMap((s) => s.text.split('\n')))];
  const rawAtSettle = term.state.raw;
  return {
    rawAtSettle,
    pid: term.state.pid, alive: !term.state.exited && pidAlive(term.state.pid), exited: term.state.exited, exitCode: term.state.exitCode,
    settled, ms: Date.now() - t0, final, timeline, timelineText: timeline.map((s) => s.text).join('\n\n'), allLines, raw: () => term.state.raw,
    // 판정이 끝난 뒤에만 쓴다: 보기 키를 한 번 누르고 그 화면을 읽는다(요청문이 아니다 — 모델 호출 없음).
    peek: async (keys, waitMs = 1500) => {
      term.write(keys);
      await sleep(waitMs);
      return (await term.lines()).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    },
    stop: async () => {
      const how = endOwnPid(term.state.pid);
      for (let i = 0; i < 25 && pidAlive(term.state.pid); i++) await sleep(200);
      term.dispose();
      if (!pidAlive(term.state.pid)) ownPids.delete(term.state.pid);
      return how;
    },
  };
}

// ---------------------------------------------------------------------------
// 브라우저 연동 등록 지키기
// ---------------------------------------------------------------------------
// 클로드는 `--chrome`(창이 늘 넘기는 인수)으로 뜰 때 브라우저 연동 안내 파일을 %APPDATA% 에 쓰고 그 경로를
// HKCU\Software\<브라우저>\NativeMessagingHosts\<이름> 에 등록한다(2.1.326 실행 파일의 표에서 읽은 일곱 자리).
// 환경 변수는 임시 폴더로 돌릴 수 있지만 레지스트리는 돌릴 수 없다 — 그대로 두면 이 PC 의 진짜 등록이 곧 지워질
// 임시 경로를 가리키게 된다. 그래서 띄우기 전에 그 자리들을 파일로 떠 두고(reg export), 끝난 뒤 달라진 자리만
// 원래대로 돌린다(있던 값 = reg import, 없던 키 = 그 키 하나만 지움). 다른 이름의 키는 읽지도 쓰지도 않는다.
export const NATIVE_HOST_NAME = 'com.anthropic.claude_code_browser_extension';
export const NATIVE_HOST_PARENTS = Object.freeze([
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  'HKCU\\Software\\ArcBrowser\\Arc\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'HKCU\\Software\\Vivaldi\\NativeMessagingHosts',
  'HKCU\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts',
]);

const regRun = (args) => { try { execFileSync('reg', args, { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } };

/** 일곱 자리를 떠 둔다. -> [{ key, existed, file }] (file = 있던 값의 .reg 사본) */
export function snapshotNativeHosts(dir, { run = regRun } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  return NATIVE_HOST_PARENTS.map((parent, i) => {
    const key = `${parent}\\${NATIVE_HOST_NAME}`;
    const file = path.join(dir, `native-host-${i}.reg`);
    const existed = run(['export', key, file, '/y']) && fs.existsSync(file);
    return { key, existed, file: existed ? file : null };
  });
}

/** 달라진 자리만 원래대로. -> [{ key, action: 'unchanged'|'restored'|'removed'|'restore-failed' }] */
export function restoreNativeHosts(snapshot, dir, { run = regRun } = {}) {
  return snapshot.map((s, i) => {
    const now = path.join(dir, `native-host-${i}.after.reg`);
    try { fs.rmSync(now, { force: true }); } catch { /* */ }
    const exists = run(['export', s.key, now, '/y']) && fs.existsSync(now);
    if (!s.existed) return { key: s.key, action: exists ? (run(['delete', s.key, '/f']) ? 'removed' : 'restore-failed') : 'unchanged' };
    const same = exists && Buffer.compare(fs.readFileSync(now), fs.readFileSync(s.file)) === 0;
    if (same) return { key: s.key, action: 'unchanged' };
    return { key: s.key, action: run(['import', s.file]) ? 'restored' : 'restore-failed' };
  });
}

// ---------------------------------------------------------------------------
// 에이전트별 재현
// ---------------------------------------------------------------------------

/** 창이 기록 폴더 이름을 만드는 식(창 daemon/agents/claude.mjs claudeProjectSlug 와 같다). */
export const claudeProjectSlug = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

function countHookCalls(hookLog) {
  try { return fs.readFileSync(hookLog, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length; } catch { return 0; }
}

/** 클로드: 창과 같은 인수(--chrome --model --effort --settings <fast> --session-id). 권한 인수는 넘기지 않는다 — 설치기 씨앗이 혼자 버티는지 본다. */
export async function probeClaude({ root, exe, env, driver, re, model = 'claude-opus-5-5', effort = 'high', hookLog = null, launch = null, watch = {}, expectDefaultMode = undefined }) {
  const sessionId = crypto.randomUUID();
  const fast = path.join(root, '_probe', 'fast-mode.json');
  fs.mkdirSync(path.dirname(fast), { recursive: true });
  fs.writeFileSync(fast, `${JSON.stringify({ fastMode: true }, null, 2)}\n`, 'utf8');
  const args = ['--chrome', '--model', model, '--effort', effort, '--settings', fast, '--session-id', sessionId];
  const cmd = launch ?? { file: exe, args };
  const recordDir = path.join(env.CLAUDE_CONFIG_DIR, 'projects', claudeProjectSlug(root));
  const obs = await watchFirstScreen({ driver, file: cmd.file, args: cmd.args, cwd: root, env, re, ...watch });
  let records = [];
  try { records = fs.readdirSync(recordDir).filter((f) => f.endsWith('.jsonl')); } catch { records = []; }
  obs.sessionId = sessionId;
  obs.expectedRecord = records.includes(`${sessionId}.jsonl`);
  obs.foreignRecords = records.filter((f) => f !== `${sessionId}.jsonl`);
  obs.hookCalls = hookLog ? countHookCalls(hookLog) : 0;
  obs.expectHookCall = !!hookLog;
  // 11/9 에는 수락된 권유가 settings.json 의 기본 권한을 auto 로 바꿔 저장했다 — 첫 화면 뒤에도 씨앗 값 그대로인지 본다.
  try { obs.defaultModeAfter = JSON.parse(fs.readFileSync(claudeSettingsPath(root), 'utf8'))?.permissions?.defaultMode ?? null; } catch { obs.defaultModeAfter = undefined; }
  obs.cmdline = [path.basename(cmd.file), ...cmd.args.map((a) => (a === fast ? '<fast-mode.json>' : a))].join(' ');
  obs.expectDefaultMode = expectDefaultMode;
  obs.stopped = await obs.stop();
  obs.checks = judgeClaude(obs);
  return obs;
}

/** 코덱스: 창과 같은 인수(-m … -c model_reasoning_effort -c service_tier=fast --dangerously-bypass-hook-trust). */
export async function probeCodex({ root, cmdFile, env, driver, re, model = 'gpt-6.1-sol', effort = 'medium', launch = null, watch = {}, peekWarnings = true }) {
  const toml = codexConfigTomlPath(root);
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const before = read(toml);
  const args = ['-m', model, '-c', `model_reasoning_effort=${effort}`, '-c', 'service_tier=fast', '--dangerously-bypass-hook-trust'];
  const cmd = launch ?? { file: env.ComSpec || 'cmd.exe', args: ['/c', cmdFile, ...args] };
  const obs = await watchFirstScreen({ driver, file: cmd.file, args: cmd.args, cwd: root, env, re, ...watch });
  const after = read(toml);
  obs.configChanged = before !== null && after !== before;
  const lineSet = (t) => new Set(String(t ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const a = lineSet(before); const b = lineSet(after);
  obs.configDiff = { added: [...b].filter((l) => !a.has(l)).slice(0, 20), removed: [...a].filter((l) => !b.has(l)).slice(0, 20) };
  obs.cmdline = ['codex', ...args].join(' ');
  // 코덱스는 시작 경고를 상태줄에 "⚠ N warnings · f2 to view" 로 접어 둔다. 판정에 쓸 화면은 이미 잡았으니,
  // 살아 있으면 보기 키(F2)를 한 번 눌러 경고 글을 기록에 남긴다(무엇이 경고인지 사람이 읽게).
  obs.warningView = null;
  if (peekWarnings && obs.alive && /warnings? · f2 to view/i.test(obs.final.tail ?? '')) {
    try {
      const pages = [];
      let page = await obs.peek('\x1bOQ');
      const total = Math.min(Number((/Warnings · \d+ of (\d+)/.exec(page.join('\n')) || [])[1] ?? 1), 30);
      pages.push(page);
      for (let i = 1; i < total; i++) { page = await obs.peek('\x1b[C', 500); pages.push(page); }
      // 쪽마다 머리(판 · 폴더 · 권한 줄)와 꼬리(키 안내)는 같다 — 경고 글만 남긴다.
      obs.warningView = pages.map((p) => p.filter((l) => !/^\s*(>_ OpenAI Codex|~?\\|[A-Za-z]:\\|permissions:)/.test(l) && !/keep & next · esc dismiss/.test(l)).join('\n'));
    } catch { obs.warningView = null; }
  }
  obs.stopped = await obs.stop();
  const j = judgeCodex(obs);
  obs.checks = j.checks; obs.warnings = j.warnings; obs.mcpArtifacts = j.mcpArtifacts; obs.warningBadge = j.warningBadge;
  return obs;
}

/** `--version` 한 줄(네트워크 없음 · 격리 환경 · 스스로 끝난다). 못 읽으면 null. */
export function cliVersion(file, args, env) {
  try { return execFileSync(file, args, { env, encoding: 'utf8', timeout: 30000, windowsHide: true }).trim().split(/\r?\n/).pop(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

export const EXIT = Object.freeze({ ok: 0, failed: 1, skipped: 2 });

export function parseArgs(argv) {
  const o = { agent: 'both', face: null, claudeExe: null, codexCmd: null, work: null, logDir: null, label: null, control: null, codexAuth: 'apikey', keep: false };
  const take = { '--agent': 'agent', '--face': 'face', '--claude-exe': 'claudeExe', '--codex-cmd': 'codexCmd', '--work': 'work', '--log-dir': 'logDir', '--label': 'label', '--control': 'control', '--codex-auth': 'codexAuth' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') o.keep = true;
    else if (take[a]) { if (argv[i + 1] === undefined) throw new Error(`${a} 뒤에 값이 없습니다`); o[take[a]] = argv[++i]; }
    else throw new Error(`모르는 인수: ${a}`);
  }
  if (!['claude', 'codex', 'both'].includes(o.agent)) throw new Error(`--agent 는 claude | codex | both (${o.agent})`);
  if (o.control && !['no-nudges', 'no-permissions'].includes(o.control)) throw new Error(`--control 은 no-nudges | no-permissions (${o.control})`);
  if (!['apikey', 'chatgpt'].includes(o.codexAuth)) throw new Error(`--codex-auth 는 apikey | chatgpt (${o.codexAuth})`);
  return o;
}

/** 결과 묶음 -> 종료 코드. 실패가 하나라도 있으면 1, 실패는 없는데 못 본 에이전트가 있으면 2(조용한 통과 금지), 전부 봤고 전부 통과면 0. */
export function exitCodeOf(results) {
  const list = Object.values(results);
  if (list.some((r) => r.state === 'failed')) return EXIT.failed;
  if (list.length === 0 || list.some((r) => r.state === 'skipped')) return EXIT.skipped;
  return EXIT.ok;
}

function summarizeHits(hits) {
  const m = new Map();
  for (const h of hits) { const k = `${h.method} ${h.host ?? ''}${h.path ?? ''}`; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].map(([what, n]) => ({ what, n }));
}

function writeScreenLog(file, title, obs) {
  const parts = [`# ${title}`, `# cmd: ${obs.cmdline}`, `# settled=${obs.settled} ms=${obs.ms} final=${obs.final.status} screens=${obs.timeline.length}`, ''];
  for (const s of obs.timeline) parts.push(`===== t=${(s.t / 1000).toFixed(1)}s status=${s.status} =====`, s.text, '');
  fs.writeFileSync(file, parts.join('\n'), 'utf8');
}

async function main(argv) {
  const t0 = Date.now();
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  const opt = parseArgs(argv);
  const lock = readLock({ zipRoot: REPO });
  const work = path.resolve(opt.work ?? path.join(REPO, '_build', 'firstrun-probe'));
  const logDir = path.resolve(opt.logDir ?? path.join(REPO, '_build', 'firstrun-probe-logs'));
  const label = opt.label ?? 'lock';
  const want = opt.agent === 'both' ? ['claude', 'codex'] : [opt.agent];
  const results = {};
  const skip = (agent, reason) => { results[agent] = { state: 'skipped', reason }; console.log(`SKIP ${agent} -- ${reason}`); };

  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const faceDir = resolveFaceDir({ arg: opt.face, lock });
  const driver = loadPtyDriver(faceDir);
  const screenRe = loadFaceScreenRegexes(faceDir);
  log(`screen rules: ${screenRe.source}${screenRe.drift.length ? ` (창의 식이 사본과 다름: ${screenRe.drift.join(', ')})` : ''}${screenRe.missing.length && screenRe.source === 'face' ? ` (창에서 못 읽음: ${screenRe.missing.join(', ')})` : ''}`);

  const dead = await startDeadServer();
  const root = path.join(work, 'soul');
  const home = path.join(work, 'home');
  let seeded = null;
  let keepWork = opt.keep;
  const out = { at: new Date().toISOString(), label, lock: { claude: lock?.parts?.claude?.version ?? null, codex: lock?.parts?.codex?.version ?? null },
    control: opt.control, screenRules: { source: screenRe.source, drift: screenRe.drift, missing: screenRe.missing }, agents: {} };
  try {
    if (!driver.ok) { for (const a of want) skip(a, driver.reason); }
    else {
      seeded = await seedSoul({ root, lock, deadUrl: dead.url, control: opt.control });
      const env = isolatedEnv({ root, home, deadUrl: dead.url });
      log(`soul seeded (adapters.run): claude files ${seeded.recorded.claude.files.length}, codex files ${seeded.recorded.codex.files.length}; ${seeded.changed.join('; ')}`);

      if (want.includes('claude')) {
        let exe = opt.claudeExe ? path.resolve(opt.claudeExe) : null;
        if (!exe) {
          const dl = path.join(work, 'cli');
          fs.mkdirSync(path.join(dl, '_agent', 'setup'), { recursive: true });
          log(`downloading Claude Code ${lock?.parts?.claude?.version} (lock) ...`);
          const got = await installClaude({ root: dl, nodeDir: path.dirname(process.execPath), lock, subscriptions: ['claude'], log: () => {} }).catch((e) => ({ ok: false, message: e?.message }));
          if (got?.ok) exe = path.join(dl, '_agent', 'shared', 'tools', 'claude', String(got.version ?? lock.parts.claude.version), lock.parts.claude.binName ?? 'claude.exe');
          else skip('claude', `잠금 판 Claude Code 를 받지 못함(${got?.code ?? got?.state ?? '-'} ${got?.message ?? ''}) — 인터넷을 확인하거나 --claude-exe`);
        }
        if (exe && !fs.existsSync(exe)) { skip('claude', `실행 파일이 없음: ${path.basename(exe)}`); exe = null; }
        if (exe) {
          const version = cliVersion(exe, ['--version'], env);
          log(`claude ${version ?? '(판을 읽지 못함)'}`);
          // 열쇠는 형식만 갖춘 가짜 — 죽은 주소 밖으로 나가지 않는다(창은 1년 열쇠가 있으면 같은 변수로 넘긴다).
          const regDir = path.join(work, 'registry');
          const snap = snapshotNativeHosts(regDir);
          armExitGuard();
          pendingRegistry = { snapshot: snap, dir: regDir };
          let obs; let restored = [];
          try {
            obs = await probeClaude({ root, exe, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-firstrun-probe-not-a-real-key' }, driver, re: screenRe.re, hookLog: seeded.hookLog,
              expectDefaultMode: opt.control === 'no-permissions' ? undefined : CLAUDE_MAX_PERMISSIONS.permissions.defaultMode });
          } finally {
            restored = restoreNativeHosts(snap, regDir);
            pendingRegistry = null;
            const touched = restored.filter((r) => r.action !== 'unchanged');
            if (touched.length) log(`browser-link registration put back: ${touched.map((r) => `${r.key.split('\\')[2]}=${r.action}`).join(', ')}`);
            if (restored.some((r) => r.action === 'restore-failed')) {
              keepWork = true;
              console.log(`FAIL claude 브라우저 연동 등록을 원래대로 돌리지 못함 -- 작업 폴더를 남긴다. 손으로: reg import "<작업 폴더>\\registry\\native-host-N.reg"`);
            }
          }
          obs.checks.push({ name: '⑩ 브라우저 연동 등록(HKCU)을 원래대로', ok: !restored.some((r) => r.action === 'restore-failed'), detail: restored.filter((r) => r.action !== 'unchanged').map((r) => `${r.key.split('\\')[2]}:${r.action}`).join(', ') || '달라진 자리 없음' });
          const bad = obs.checks.filter((c) => !c.ok).length;
          for (const c of obs.checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} claude ${c.name} -- ${c.detail}`);
          writeScreenLog(path.join(logDir, `${label}-claude.screen.txt`), `claude ${version ?? ''} (${label})`, obs);
          fs.writeFileSync(path.join(logDir, `${label}-claude.raw.log`), obs.rawAtSettle, 'utf8');
          results.claude = { state: bad ? 'failed' : 'ok' };
          out.agents.claude = { version, state: results.claude.state, cmdline: obs.cmdline, settled: obs.settled, ms: obs.ms, final: { ...obs.final, tail: undefined }, finalTail: obs.final.tail,
            dialogs: findDialogs(obs.timelineText, 'claude'), expectedRecord: obs.expectedRecord, foreignRecords: obs.foreignRecords, hookCalls: obs.hookCalls, stopped: obs.stopped, checks: obs.checks };
        }
      }

      if (want.includes('codex')) {
        let cmdFile = opt.codexCmd ? path.resolve(opt.codexCmd) : null;
        if (!cmdFile) {
          const cache = path.join(REPO, '_build', 'cache', 'npm');
          let meta = null; try { meta = JSON.parse(fs.readFileSync(path.join(cache, 'codex.meta.json'), 'utf8')); } catch { meta = null; }
          if (meta?.version && meta.version === lock?.parts?.codex?.version) cmdFile = path.join(cache, 'codex', 'codex.cmd');
          else skip('codex', `빌드 캐시에 잠금 판 코덱스(${lock?.parts?.codex?.version})가 없음(있는 판: ${meta?.version ?? '없음'}) — build 를 한 번 돌리거나 --codex-cmd`);
        }
        if (cmdFile && !fs.existsSync(cmdFile)) { skip('codex', `실행 꾸러미가 없음: ${path.basename(cmdFile)}`); cmdFile = null; }
        if (cmdFile) {
          writeFakeCodexAuth(env.CODEX_HOME, opt.codexAuth);
          const version = cliVersion(env.ComSpec || 'cmd.exe', ['/c', cmdFile, '--version'], env);
          log(`codex ${version ?? '(판을 읽지 못함)'}`);
          const obs = await probeCodex({ root, cmdFile, env, driver, re: screenRe.re });
          const bad = obs.checks.filter((c) => !c.ok).length;
          for (const c of obs.checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} codex ${c.name} -- ${c.detail}`);
          writeScreenLog(path.join(logDir, `${label}-codex.screen.txt`), `codex ${version ?? ''} (${label})`, obs);
          if (obs.warningView) fs.writeFileSync(path.join(logDir, `${label}-codex.warnings.txt`), `${obs.warningView.join('\n\n')}\n`, 'utf8');
          fs.writeFileSync(path.join(logDir, `${label}-codex.raw.log`), obs.rawAtSettle, 'utf8');
          results.codex = { state: bad ? 'failed' : 'ok' };
          out.agents.codex = { version, state: results.codex.state, cmdline: obs.cmdline, settled: obs.settled, ms: obs.ms, final: { ...obs.final, tail: undefined }, finalTail: obs.final.tail,
            dialogs: findDialogs(obs.timelineText, 'codex'), warningBadge: obs.warningBadge, warnings: obs.warnings, mcpArtifacts: obs.mcpArtifacts, configChanged: obs.configChanged, configDiff: obs.configDiff, stopped: obs.stopped, checks: obs.checks };
        }
      }
    }
  } finally {
    await dead.close();
    out.deadServer = { requests: dead.hits.length, byTarget: summarizeHits(dead.hits) };
    out.results = results;
    out.exitCode = exitCodeOf(results);
    fs.writeFileSync(path.join(logDir, `${label}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    if (!keepWork) { await sleep(500); try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { log(`could not remove ${path.basename(work)}: ${e?.message}`); } }
  }
  log(`dead address received ${dead.hits.length} request(s); logs -> ${path.relative(REPO, logDir) || logDir}`);
  const code = out.exitCode;
  const n = Object.values(results);
  const word = code === EXIT.ok ? 'OK' : (code === EXIT.failed ? 'FAIL' : 'INCOMPLETE');
  console.log(`firstrun-probe ${word} (ok ${n.filter((r) => r.state === 'ok').length} · failed ${n.filter((r) => r.state === 'failed').length} · skipped ${n.filter((r) => r.state === 'skipped').length})`);
  return code;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => setTimeout(() => process.exit(code), 200), (e) => { console.error(`firstrun-probe ERROR ${e?.stack || e}`); setTimeout(() => process.exit(EXIT.failed), 200); });
}
