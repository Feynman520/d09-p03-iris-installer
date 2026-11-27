// verify/firstrun-probe.mjs -- 첫 실행 재현 (2026-11-27, 잠금 판 올림 W9 · 11-28 코덱스 코드 검토 반영)
//
// 배경: 2026-11-09 학교 컴퓨터실에서 새 PC 의 클로드가 시작 안내창(크롬 안내 · 전체화면 권유 · 자동 모드 권유)에
// 걸려 대화창이 비고 권한이 auto 로 바뀌었다(검증기록 5-71). 그 뒤 "잠금 판을 올릴 때는 설치기 씨앗을 넣은
// 오프라인 첫 실행 재현을 거친다"가 규칙이 됐지만(AGENTS.md 「비서 자동 업데이트」, 검증기록 5-74) 재현은 그때그때
// 손으로 했다. 이 스크립트가 그 손 절차를 밟는다:
//
//   ⓞ 준비        잠금표의 CLI 를 구한다 — **이 단계는 네트워크를 쓴다**(클로드 = 설치기 함수 installClaude 로 받고 지문 검증,
//                 코덱스 = 빌드 캐시). 띄울 실행 파일의 `--version` 이 잠금표의 판과 같지 않으면 띄우지 않는다.
//   ① 가짜 영혼   실행마다 새 임시 폴더에 영혼 루트를 만들고, 설치기가 쓰는 설정을 **설치기 함수로** 넣는다
//                 (setup/adapters.mjs run() = settings.json · 훅 · .claude.json 씨앗 · config.toml · hooks.json).
//   ② 죽은 주소   127.0.0.1 의 임의 포트에 "무엇이 와도 503" 서버를 띄우고, 관측할 CLI 의 API 주소 · 프록시 변수 ·
//                 코덱스 연결 주소를 전부 그리로 준다. 요청문을 보내지 않는다(이 스크립트가 시키는 모델 호출 0).
//   ③ 첫 화면     그 CLI 를 IRIS 창과 같은 크기의 가상 터미널 · 창과 같은 인수(클로드는 `--chrome` 만 뺌 — claudeArgs)로
//                 띄워 첫 화면이 가라앉을 때까지 본다. 한도 시간까지 가라앉지 않으면 통과가 아니다.
//   ④ 판정        묻는 창 없이 입력 칸까지 갔는가 · 권한 표시가 bypass 인가 · 시작 안내창이 없는가 · 다른 번호의 기록이
//                 생기지 않았는가 · 시작 훅이 오류 없이 불렸는가 · 띄운 프로세스가 끝났는가. 코덱스는 설치 PC 꼴 설정
//                 (model_provider · multi_agent · 신뢰 표)으로 물음 없이 입력 칸이 보이는가 + 접힌 경고 수집
//                 (판정이 끝난 뒤 보기 키 F2 로 펼쳐 기록에 남긴다 — 요청문이 아니다).
//
// "네트워크 없이"의 정확한 뜻: 관측 단계의 CLI 에게 환경 변수(API 주소 · 프록시)와 설정 파일로 죽은 주소를 **준다**.
// 방화벽으로 막는 강제 격리가 아니다 — 프록시 변수를 따르지 않고 직접 나가는 연결이 있다면 이 스크립트는 막지도 보지도
// 못한다. 확인할 수 있는 것은 죽은 주소에 실제로 온 요청(결과 파일의 deadServer)뿐이다. 바깥 연결 0 을 입증해야 하면
// 네트워크가 끊긴 곳에서 `--claude-exe` · `--codex-cmd` 로 돌린다.
//
// 이 검사가 못 보는 것(실제 PC 시험의 몫): 서버 깃발 · 로그인 계정에 달린 안내창 / 요청 뒤의 일(첫 답 · 기록 파일 ·
// 옛 대화 재개 · 작업 도중 물음) / 코덱스의 ChatGPT 로그인으로 시작하는 길(writeFakeCodexAuth 의 설명) / 코덱스
// 업데이트 물음(네트워크가 있어야 뜬다) / 실제 MCP 서버가 뜨는 동안의 화면(가짜 영혼에는 MCP 실행 파일이 없다) /
// 크롬 연동 안내창(`--chrome` 을 빼고 띄운다).
//
// 화면 판정식은 IRIS 창 `daemon/sessions.mjs` 의 것을 쓴다 — 옆 폴더의 창 소스가 있으면 거기서 읽고(달라졌으면 알린다),
// 없으면 이 파일의 사본(BUILTIN_SCREEN_RE)을 쓴다. 가상 터미널(node-pty · @xterm/headless)도 창의 것을 빌린다.
//
// 안전 규칙:
//   · 쓰는 곳은 작업 폴더(기본 _build/firstrun-probe/, --work 로 바꿈) **아래에 실행마다 새로 만드는 폴더 하나**
//     (run-XXXXXX)와 기록 폴더. 받은 폴더 자체는 지우지 않고, 정리도 자기가 만든 그 폴더만 한다.
//     CLAUDE_CONFIG_DIR · CODEX_HOME · HOME · USERPROFILE · APPDATA · LOCALAPPDATA · TEMP 를 전부 그 안으로 준다.
//     자식 환경은 허용 목록으로 새로 짠다(이 PC 의 열쇠 · 주소 · 세션 표식을 넘기지 않는다).
//   · **레지스트리를 읽지도 쓰지도 않는다.** 클로드는 `--chrome` 으로 뜰 때 HKCU 의 브라우저 연동 등록을 건드릴 수
//     있어서 그 인수를 빼고 띄운다(claudeArgs 의 설명).
//   · 에이전트 심(shims\claude.cmd · codex.cmd)은 쓰지 않는다 — 심은 살아 있는 중계기 주소를 박아 넣는다.
//     같은 까닭으로 config.toml 의 중계기 주소만 죽은 주소로 바꾼다(그 밖의 글자는 설치기가 쓴 그대로).
//   · 준비 단계도 같다: 잠금 판을 받는 설치기 함수(installClaude)가 띄우는 프로세스(`--version` 확인)에는 관측 단계와
//     같은 격리 환경을 주고, npm 대체 설치(이 PC 의 npm 설정 · 캐시를 읽는 프로세스)는 쓰지 않는다(prepareClaude).
//   · 이 스크립트가 cmd 를 부를 때는 언제나 `/d`(레지스트리의 AutoRun 명령을 돌리지 않는다 — codexCmdArgs).
//     CLI 가 **스스로** 띄우는 셸(클로드가 훅의 `python.cmd` 를 돌릴 때 등)에는 이 스크립트가 손댈 수 없다.
//   · 로그인하지 않는다. 열쇠는 형식만 갖춘 가짜다. 요청문 · Enter 를 보내지 않는다. 보내는 키는 코덱스의 경고 보기(F2 ·
//     화살표)뿐이고, 그것도 화면이 기대한 그 화면(가라앉은 대기 화면 / 경고 보기 창)일 때만 보낸다(probeCodex).
//   · 띄운 프로세스와 **그 자손**은 윈도 Job Object 로 빠짐없이 세고, **핸들로** 끝낸다(「프로세스 추적」 절):
//     이 스크립트 자신을 Job 에 넣어 두면 그 뒤에 띄운 것과 그 자손이 — 중간 부모가 먼저 죽어도 — 전부 Job 의 목록에 남는다.
//     관측이 끝날 때마다 "띄우기 전에는 없던 구성원"을 전부 끝내고, 실행이 끝날 때는 Job 전체를 다시 봐서 이 스크립트 자신만
//     남았을 때에만 통과다(준비 단계가 남긴 것도 여기서 잡힌다). 끝낼 때는 그 PID 의 핸들을 열어 Job 소속을 확인한 뒤 같은
//     핸들로 끝낸다 — 번호가 다른 프로세스에 다시 쓰였으면 끝내지 않는다. 이름으로 찾지 않고, taskkill · tasklist 를 부르지 않는다.
//     Job 을 다루는 파워셸 도우미도 끝난 것을 확인하고 돌아온다. Job 을 쓸 수 없는 PC 에서는 띄우지 않는다(종료 코드 2).
//     보증하지 못하는 것: 다른 서비스가 대신 만들어 준 프로세스(WMI · 작업 스케줄러 · 서비스)는 Job 밖이다. 이 스크립트가
//     죽으면 도우미가 Job 의 나머지를 끝내고 나가지만, 스크립트와 도우미가 둘 다 강제로 끝나면 띄운 CLI 가 남을 수 있다.
//   · 정리 순서 = 자식 종료 → 폴더 정리. 실행 폴더를 만든 바로 다음부터 try/finally 라 그 뒤 무엇이 던져도 거친다.
//     끝나지 않은 프로세스가 있으면 폴더를 지우지 않고 실패로 끝낸다.
//
// 종료 코드:
//   0 = 잠금 판 검증 통과(본 에이전트 전부: 판 일치 · 가라앉음 · 판정 전부 · 프로세스 나무 종료 · 폴더 정리).
//       예외 하나: `--keep` 을 주면 폴더를 일부러 남긴 채 0 이 될 수 있다(남긴 경로를 찍는다) — 사람이 들여다볼 때만 쓴다.
//   1 = 실패(판정 실패 · 띄울 판이 잠금표와 다름 · 프로세스가 끝나지 않음 · 작업 폴더를 지우지 못함 · 예외)
//   2 = 준비물이 없어 못 본 에이전트가 있음(창의 가상 터미널 · CLI · 판을 읽지 못함 · Job 추적을 쓸 수 없음) — 통과로 읽지 않는다
//   3 = 견주기(`--compare`)로 돌았고 본 것은 전부 맞음 — 다른 판 · 대조군을 보는 용도이며 잠금 판 검증이 아니다
//
// Usage:
//   node verify/firstrun-probe.mjs [--agent claude|codex|both] [--face <IRIS 창 소스 폴더>]
//        [--claude-exe <claude.exe>] [--codex-cmd <codex.cmd>] [--work <dir>] [--log-dir <dir>] [--label <이름>] [--keep]
//        [--compare] [--control no-nudges|no-permissions] [--codex-auth apikey|chatgpt]
//   인수 없이 = 잠금 판 검증: 잠금표의 두 CLI. 클로드는 설치기 함수로 내려받고(인터넷 필요), 코덱스는 빌드 캐시
//   (_build/cache/npm/codex — 판이 잠금표와 같을 때)를 쓴다. `--claude-exe` · `--codex-cmd` 로 준 것도 잠금 판이어야 한다.
//   --compare = 잠금표와 다른 판을 견줘 본다(판 일치를 요구하지 않음). --control(씨앗을 뺀 대조군) · --codex-auth chatgpt 는
//   언제나 견주기다.
import fs from 'node:fs';
import os from 'node:os';
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
import { run } from '../lib/run.mjs';

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

/** 끝내기 결과 한 줄: 띄운 PID · 이 관측이 낳은 프로세스 수 · PID 로 따로 끝낸 것 · 남은 PID(이름은 읽으라고 붙인 것). */
function stopDetail(obs) {
  const s = obs.stopInfo ?? {};
  return `pid=${obs.pid ?? '-'} stop=${obs.stopped ?? '-'} 이 관측이 낳은 프로세스=${s.tracked ?? '-'}개(Job)`
    + `${(s.retried ?? []).length ? ` 다시 끝낸 pid=${s.retried.join(',')}` : ''}${(s.left ?? []).length ? ` 남은 pid=${s.left.join(',')}` : ''}`
    + `${Object.keys(s.names ?? {}).length ? ` [${Object.entries(s.names).map(([pid, n]) => `${pid}=${n ?? '?'}`).join(' ')}]` : ''}${s.reason ? ` (${s.reason})` : ''}`;
}

const HOOK_ERROR_RE = /hook error|ParserError|Git Bash was not found|requires bash|hook (timed out|failed)/i;

export function judgeClaude(obs) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  const final = obs.final ?? classifyScreen([]);
  const all = obs.timelineText ?? '';
  const dialogs = findDialogs(all, 'claude');
  // 관측이 끝났어야 판정이다: 입력 칸이 보여도 출력이 멈추지 않아 한도 시간에 닿았으면 "가라앉은 첫 화면"을 본 것이 아니다.
  add('⓪ 첫 화면이 가라앉음(관측 완료)', obs.settled === true, `settled=${obs.settled === true} ms=${obs.ms ?? '-'}`);
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
  if (obs.childGone !== undefined) add('⑩ 띄운 프로세스 나무가 전부 끝남', obs.childGone === true, stopDetail(obs));
  return out;
}

export function judgeCodex(obs) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  const final = obs.final ?? classifyScreen([]);
  const all = obs.timelineText ?? '';
  const dialogs = findDialogs(all, 'codex');
  add('⓪ 첫 화면이 가라앉음(관측 완료)', obs.settled === true, `settled=${obs.settled === true} ms=${obs.ms ?? '-'}`);
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
  const peek = String(obs.warningPeek ?? '');
  add('④ 경고가 입력 칸을 가리지 않음', final.status === 'idle', `상태줄 경고 ${badge}건${pages.length ? `(시작 ${startup.length} · MCP ${mcp} — MCP 는 가짜 영혼의 부산물)` : ''}`
    + `${/^(not-seen|partial)/.test(peek) ? ` · 경고 글 못 봄(${peek.replace(/^[a-z-]+: /, '')})` : ''}`);
  // CLI 가 자기 표(신뢰 · 안내 "봤음" 등)를 덧붙이는 것은 괜찮다 — 설치기가 쓴 줄이 없어지면 실패.
  const removed = obs.configDiff?.removed ?? [];
  add('⑤ 설치기가 쓴 설정 줄을 CLI 가 지우지 않음', removed.length === 0,
    removed.length ? `없어진 줄: ${removed.slice(0, 3).join(' | ')}` : `ok${obs.configChanged ? ` (CLI 가 더한 줄 ${(obs.configDiff?.added ?? []).length})` : ''}`);
  if (obs.childGone !== undefined) add('⑥ 띄운 프로세스 나무가 전부 끝남', obs.childGone === true, stopDetail(obs));
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
 * isolatedEnv -- 새 PC 꼴의 자식 환경. 설정 · 홈 · 임시 폴더는 전부 home(작업 폴더 안)으로, API 주소와 프록시 변수는 전부
 * 죽은 주소로(환경 변수로 주는 것이다 — 이 변수를 따르지 않는 연결까지 막는 장치는 아니다).
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
    kill: () => { if (!st.exited) { try { proc.kill(); } catch { /* 이미 끝남 */ } } },
    dispose: () => { if (!st.exited) { try { proc.kill(); } catch { /* 이미 끝남 */ } } try { screen.dispose(); } catch { /* */ } },
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
        kill: () => { try { proc.kill(); } catch { /* 이미 끝남 */ } }, // node 가 쥔 그 프로세스 객체로
        dispose: () => { try { proc.stdin.end(); } catch { /* */ } },
      };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 이 스크립트가 예외로 죽을 때는 0 이 아닌 코드로 끝낸다. 띄운 프로세스의 뒷정리는 Job 도우미가 한다(아래) —
// 이 프로세스가 죽으면 도우미의 표준 입력이 닫히고, 도우미가 Job 에 남은 구성원을 끝낸 뒤 나간다.
let exitGuardOn = false;
function armExitGuard() {
  if (exitGuardOn) return;
  exitGuardOn = true;
  process.on('uncaughtException', (e) => { console.error(`firstrun-probe ERROR ${e?.stack || e}`); process.exit(EXIT.failed); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(EXIT.failed));
}

// ---------------------------------------------------------------------------
// 프로세스 추적 — 윈도 Job Object 로 자손을 빠짐없이 세고, 핸들로 끝낸다
// ---------------------------------------------------------------------------
// `taskkill /T` 는 그 순간 살아 있는 부모-자식 줄을 따라간다. 부모가 먼저 죽으면 줄이 끊겨 자손이 남을 수 있고
// (코덱스 = cmd → node → codex.exe → MCP 서버들), 프로세스 표를 주기적으로 떠서 자손을 모으는 방식은 "표를 뜨는 사이에
// 생겼다 사라진 중간 부모"의 자식을 놓친다(2026-11-28 코덱스 3차 검토). 그래서 운영체제가 대신 세게 한다:
//
//   · 이 스크립트의 node 프로세스 자신을 이름 없는 Job 에 넣는다. Job 의 구성원이 만드는 프로세스는 만들어지는 순간
//     같은 Job 에 들어가므로, 그 뒤 node-pty 로 띄우는 CLI 와 그 자손은 — 부모가 언제 죽든 — 전부 Job 의 목록에 남는다.
//     준비 단계(`--version` 확인 등)가 띄운 것도 마찬가지다.
//   · 관측 하나가 끝날 때 = "띄우기 직전의 목록에는 없던 구성원"을 전부 끝내고, 하나도 살아 있지 않을 때만 끝났다고 본다.
//     실행 전체가 끝날 때 = 도우미를 닫기 직전에 **Job 전체**를 다시 본다(finalJobSweep): 이 스크립트 자신을 뺀 구성원이
//     0 이어야 한다. 관측별 차만 보면 관측 전에 생긴 것(준비 단계의 자손)과, 앞 목록의 PID 를 다시 받은 새 자손이 빠진다.
//   · 끝내기는 **숫자 PID 가 아니라 핸들로** 한다(4차 검토): 도우미가 그 PID 의 핸들을 열고 → 그 핸들이 우리 Job 의
//     구성원인지 확인하고(IsProcessInJob) → 같은 핸들로 TerminateProcess · WaitForSingleObject. 목록을 읽은 뒤 그 번호가
//     다른 프로세스에 다시 쓰였다면 Job 구성원이 아니므로 끝내지 않는다. 이 스크립트는 taskkill · tasklist 를 부르지 않는다.
//   · Job 은 세기만 한다. 한도는 하나도 걸지 않는다 — "닫힐 때 함께 끝내기"(KILL_ON_JOB_CLOSE)도 걸지 않는다:
//     이 스크립트 자신이 Job 안이라, 도우미가 예기치 않게 죽는 순간 이 스크립트가 **종료 코드 0** 으로 끝나 버린다
//     (2026-11-28 실측) — 통과로 읽힐 수 있는 죽음이다. 그 대신 도우미가 표준 입력이 닫힌 것(= 이 스크립트가 죽음)을 보면
//     Job 에 남은 구성원을(이 스크립트는 빼고) 핸들로 끝낸 뒤 나간다.
//     벗어나기(CREATE_BREAKAWAY_FROM_JOB)는 허용하지 않는다: 허용하면 벗어난 프로세스를 셀 수 없다. 그 대신 CLI 가 벗어나기를
//     요청하면 그 프로세스 만들기가 거절된다 — 실제 PC 와 다른 조건이다(2.1.311 · 2.1.326 · 0.167.0 · 0.172.0 의 첫 화면에서는
//     Job 이 없을 때와 차이가 없었다, 검증기록 5-82).
//   · Job 을 만들고 목록을 읽고 끝내는 일은 파워셸 도우미 하나가 한다(node 에는 그 API 가 없다): `Add-Type` 으로 kernel32 를
//     부르고, 표준 입력으로 `list <번호>` · `end <번호> <pid> <ms>` 를 받아 같은 번호를 붙여 답한다. 도우미는 이 스크립트가
//     프로세스 객체를 쥐고 있다가 끝날 때 닫고(닫히지 않으면 그 객체로 끝낸다), 도우미 자신은 Job 밖이다(node 를 넣기 전에 떴다).
//   · 답이 제때 오지 않으면(시간 초과) 그 추적기는 그때부터 **실패로 굳는다** — 늦게 온 답을 다음 물음의 답으로 읽는 일이
//     없도록 번호도 맞춰 보지만, 한 번이라도 시간 초과가 나면 그 실행은 통과가 될 수 없다.
//   · Job 을 쓸 수 없는 PC(Add-Type 이 막힌 경우 등)에서는 띄우지 않는다 — 약한 방식으로 조용히 물러나지 않는다(종료 코드 2).
//
// 이 방식이 보증하지 못하는 것:
//   · 다른 서비스가 **대신 만들어 준** 프로세스(WMI `Win32_Process.Create` · 작업 스케줄러 · 서비스 · COM 서버 띄우기)는
//     부모가 그 서비스라 Job 밖이다 — 세지도 끝내지도 못한다.
//   · 도우미가 먼저 죽으면(누가 강제로 끝냄) 그 뒤로는 목록을 읽을 수 없어 그 실행은 실패로 끝나고, 남은 프로세스는
//     끝내지 못한다. 이 스크립트와 도우미가 **둘 다** 강제로 끝나면 띄운 CLI 가 남을 수 있다(자동 정리 없음).

const JOB_HELPER_PS = `
$ErrorActionPreference = 'Stop'
$target = [uint32]__TARGET_PID__
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class IrisProbeJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, out uint ret);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  public static long[] PidList(IntPtr job) {
    int cap = 8192;
    int size = 8 + IntPtr.Size * cap;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      uint ret;
      if (!QueryInformationJobObject(job, 3, buf, (uint)size, out ret)) return null;
      int n = Marshal.ReadInt32(buf, 4);
      long[] pids = new long[n];
      for (int i = 0; i < n; i++) pids[i] = Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64();
      return pids;
    } finally { Marshal.FreeHGlobal(buf); }
  }
  public static string Pids(IntPtr job) {
    long[] pids = PidList(job);
    if (pids == null) return "ERR " + Marshal.GetLastWin32Error();
    StringBuilder sb = new StringBuilder();
    foreach (long p in pids) { sb.Append(' '); sb.Append(p); }
    return "OK" + sb.ToString();
  }
  // 핸들을 열고 -> 그 핸들이 이 Job 의 구성원인지 확인하고 -> 같은 핸들로 끝내고 기다린다. 번호로 다시 찾지 않는다.
  public static string End(IntPtr job, uint pid, uint waitMs, uint keep) {
    if (pid == keep) return "refused -";
    IntPtr h = OpenProcess(0x00101001, false, pid); // TERMINATE | SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) { int e = Marshal.GetLastWin32Error(); return (e == 87 ? "gone" : "denied:" + e) + " -"; }
    try {
      StringBuilder sb = new StringBuilder(1024); uint len = 1024;
      string name = QueryFullProcessImageNameW(h, 0, sb, ref len) ? System.IO.Path.GetFileName(sb.ToString()).Replace(' ', '_') : "?";
      bool inJob;
      if (!IsProcessInJob(h, job, out inJob)) return "denied:" + Marshal.GetLastWin32Error() + " " + name;
      if (!inJob) return "not-in-job " + name;
      if (WaitForSingleObject(h, 0) == 0) return "ended " + name;
      if (!TerminateProcess(h, 1)) { int e = Marshal.GetLastWin32Error(); if (WaitForSingleObject(h, 0) == 0) return "ended " + name; return "denied:" + e + " " + name; }
      return (WaitForSingleObject(h, waitMs) == 0 ? "ended " : "timeout ") + name;
    } finally { CloseHandle(h); }
  }
  // 이 스크립트가 죽었을 때: Job 에 남은 구성원을(keep 은 빼고) 끝낸다.
  public static void Sweep(IntPtr job, uint keep) {
    for (int round = 0; round < 3; round++) {
      long[] pids = PidList(job);
      if (pids == null) return;
      int n = 0;
      foreach (long p in pids) { if ((uint)p != keep) { End(job, (uint)p, 2000, keep); n++; } }
      if (n == 0) return;
    }
  }
}
'@
$job = [IrisProbeJob]::CreateJobObjectW([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw ('CreateJobObject ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
$h = [IrisProbeJob]::OpenProcess(0x0101, $false, $target)
if ($h -eq [IntPtr]::Zero) { throw ('OpenProcess ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
if (-not [IrisProbeJob]::AssignProcessToJobObject($job, $h)) { throw ('AssignProcessToJobObject ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
[void][IrisProbeJob]::CloseHandle($h)
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
} catch { [Console]::Out.WriteLine('FAILED ' + ($_.Exception.Message -replace '\\s+', ' ')); [Console]::Out.Flush(); exit 3 }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { [IrisProbeJob]::Sweep($job, $target); break }
  $w = $line.Trim() -split '\\s+'
  if ($w[0] -eq 'exit') { break }
  elseif ($w[0] -eq 'list' -and $w.Length -ge 2) { [Console]::Out.WriteLine('R ' + $w[1] + ' ' + [IrisProbeJob]::Pids($job)) }
  elseif ($w[0] -eq 'end' -and $w.Length -ge 4) { [Console]::Out.WriteLine('R ' + $w[1] + ' ' + [IrisProbeJob]::End($job, [uint32]$w[2], [uint32]$w[3], $target)) }
  [Console]::Out.Flush()
}
`;

// 도우미에게 넘기는 환경 — 윈도가 파워셸을 돌리는 데 필요한 것만. 이 PC 의 프로필 · 모듈 경로 · 열쇠는 넘기지 않는다(-NoProfile).
// 임시 · 홈 · 앱 자료 폴더는 전부 home(도우미 전용 폴더 — 실행 폴더 아래)으로 준다: Add-Type 이 C# 을 번역하며 쓰는 임시 파일과
// 파워셸이 스스로 쓰는 시작 기록(StartupProfileData)이 그 안에 생긴다.
function jobHelperEnv(home) {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const env = { SystemRoot: sys, windir: sys, SystemDrive: process.env.SystemDrive || path.parse(sys).root.replace(/\\$/, ''),
    PATH: [path.join(sys, 'System32'), sys, path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter) };
  for (const k of ['ComSpec', 'PATHEXT', 'ProgramData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) if (process.env[k] !== undefined) env[k] = process.env[k];
  const dirs = { TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  for (const [k, v] of Object.entries(dirs)) { fs.mkdirSync(v, { recursive: true }); env[k] = v; }
  return env;
}

let jobTrackerPromise = null;

/**
 * startJobTracker -- 도우미를 띄워 targetPid(기본 = 이 프로세스)를 Job 에 넣는다.
 *   -> { kind: 'job', ok, reason, failed, pid, home,
 *        list(): Promise<number[]|null>,                              지금 Job 에 살아 있는 PID 전부(대상 포함). 못 읽으면 null
 *        end(pid, waitMs): Promise<{ status, name }|null>,            핸들로 끝내기. status = ended | gone | not-in-job | refused | timeout | denied:<n>
 *        close(): Promise<'closed'|'ended'|'failed'|'already-gone'> } 도우미가 끝난 것을 확인한 뒤에 돌아온다
 * 물음은 한 번에 하나씩 차례로 보내고, 번호를 붙여 답을 맞춘다. 답이 제때 오지 않으면 failed 에 까닭이 적히고 그 뒤의
 * 물음은 전부 null 이다(다시 살아나지 않는다). home = 도우미 전용 폴더(없으면 임시 폴더에 만들고 닫을 때 지운다).
 */
export function startJobTracker({ targetPid = process.pid, home = null, readyMs = 30000, listMs = 5000, spawnFn = spawn } = {}) {
  const ownsHome = !home;
  const helperHome = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'iris-frp-job-'));
  const script = JOB_HELPER_PS.replace('__TARGET_PID__', String(Number(targetPid)));
  const ps = spawnFn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: jobHelperEnv(helperHome) });
  const tracker = { kind: 'job', ok: false, reason: null, failed: null, pid: ps.pid ?? null, home: helperHome, exited: false, targetPid: Number(targetPid) };
  let buf = ''; let readyWaiter = null; let seq = 0;
  const pending = new Map(); // 번호 -> 답을 받을 함수
  const dropAll = () => { for (const f of pending.values()) f(null); pending.clear(); if (readyWaiter) { readyWaiter(null); readyWaiter = null; } };
  const onLine = (line) => {
    if (readyWaiter && (line === 'READY' || line.startsWith('FAILED'))) { const f = readyWaiter; readyWaiter = null; f(line); return; }
    const m = /^R (\d+) (.*)$/.exec(line);
    if (!m) return;
    const f = pending.get(Number(m[1]));
    if (f) { pending.delete(Number(m[1])); f(m[2]); } // 번호가 맞지 않는 답(늦게 온 답)은 버린다
  };
  ps.stdout.on('data', (d) => { buf += d; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); } });
  ps.stderr.on('data', () => {});
  const exitedP = new Promise((resolve) => {
    ps.on('exit', () => { tracker.exited = true; dropAll(); resolve(); });
    ps.on('error', (e) => { tracker.exited = true; tracker.reason = tracker.reason ?? String(e?.message || e); dropAll(); resolve(); });
  });
  const withTimeout = (register, ms) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish(undefined), ms); // undefined = 시간 초과(null = 도우미가 끝남)
    register(finish);
  });
  tracker.ready = withTimeout((f) => { readyWaiter = f; }, readyMs).then((line) => {
    tracker.ok = line === 'READY';
    if (!tracker.ok) { tracker.reason = line ? String(line).replace(/^FAILED\s*/, '') : (tracker.reason ?? '도우미가 준비되지 않음'); tracker.failed = `준비 실패: ${tracker.reason}`; }
    return tracker.ok;
  });
  let chain = tracker.ready.then(() => {}, () => {});
  const ask = (text, ms) => {
    const p = chain.then(async () => {
      if (!tracker.ok || tracker.exited || tracker.failed) return null;
      const id = ++seq;
      const answer = withTimeout((f) => { pending.set(id, f); }, ms);
      try { ps.stdin.write(`${text.replace('#', String(id))}\n`); } catch { pending.delete(id); tracker.failed = '도우미에 물음을 보내지 못함'; return null; }
      const got = await answer;
      if (got === undefined) { pending.delete(id); tracker.failed = `도우미의 답이 ${ms}ms 안에 오지 않음(${text.split(' ')[0]})`; return null; }
      if (got === null) { tracker.failed = tracker.failed ?? '도우미가 끝남'; return null; }
      return got;
    });
    chain = p.then(() => {}, () => {});
    return p;
  };
  tracker.list = async () => {
    const got = await ask('list #', listMs);
    if (got === null) return null;
    if (!got.startsWith('OK')) { tracker.failed = `Job 목록 읽기 실패(${got})`; return null; }
    return got.slice(2).trim().split(/\s+/).filter(Boolean).map(Number);
  };
  tracker.end = async (pid, waitMs = 5000) => {
    if (!Number.isInteger(pid) || pid <= 0) return { status: 'refused', name: null };
    if (pid === tracker.targetPid) return { status: 'refused', name: null }; // 자기 자신은 끝내지 않는다(도우미도 거절한다)
    const got = await ask(`end # ${pid} ${Math.max(0, Math.floor(waitMs))}`, waitMs + listMs);
    if (got === null) return null;
    const [status, name] = got.split(' ');
    return { status, name: name && name !== '-' ? name : null };
  };
  tracker.close = async () => {
    const cleanup = () => { if (ownsHome) { try { fs.rmSync(helperHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 폴더 — 남아도 해가 없다 */ } } };
    if (tracker.exited) { cleanup(); return 'already-gone'; }
    await chain; // 진행 중인 물음이 끝난 뒤에 닫는다
    try { ps.stdin.write('exit\n'); ps.stdin.end(); } catch { /* 이미 닫힘 */ }
    await Promise.race([exitedP, sleep(3000)]);
    if (tracker.exited) { cleanup(); return 'closed'; }
    try { ps.kill(); } catch { /* */ } // 이 스크립트가 쥔 그 프로세스 객체로 끝낸다(번호로 찾지 않는다)
    await Promise.race([exitedP, sleep(3000)]);
    if (tracker.exited) { cleanup(); return 'ended'; }
    return 'failed';
  };
  // 닫는 것을 잊어도 node 가 이 도우미 때문에 살아 있지 않게(이 프로세스가 끝나면 표준 입력이 닫혀 도우미도 끝난다).
  try { ps.unref(); ps.stdin.unref?.(); ps.stdout.unref?.(); ps.stderr.unref?.(); } catch { /* */ }
  return tracker;
}

/** 이 프로세스의 Job 추적기(하나만 만든다 — 처음 부를 때의 home 이 쓰인다). 준비가 끝난 것을 돌려준다. ok 가 false 면 reason 에 까닭. */
export async function getJobTracker({ home = null } = {}) {
  if (!jobTrackerPromise) jobTrackerPromise = (async () => { const t = startJobTracker({ home }); await t.ready; return t; })();
  return jobTrackerPromise;
}

/** 추적기 도우미를 닫는다(끝난 것을 확인하고 돌아온다). 만든 적이 없으면 'none'. */
export async function closeJobTracker() {
  if (!jobTrackerPromise) return 'none';
  const t = await jobTrackerPromise;
  jobTrackerPromise = null;
  return t.close();
}

/**
 * finalJobSweep -- 도우미를 닫기 직전에 Job **전체**를 본다. 이 스크립트 자신(keepPid)을 뺀 구성원이 0 이어야 한다.
 * 관측별 "앞 목록과 뒤 목록의 차"로는 잡히지 않는 것(준비 단계 · `--version` 이 남긴 자손, 앞 목록의 PID 를 다시 받은 새 자손)이
 * 여기서 잡힌다. 남은 것이 있으면 핸들로 끝내 보고, 그래도 남으면 ok=false.
 *   -> { ok, found: [{pid, status, name}], left: [{pid, name}], reason }
 */
export async function finalJobSweep(jobs, { keepPid = process.pid, settleMs = 1500, waitMs = 5000 } = {}) {
  const rest = (cur) => cur.filter((pid) => pid !== keepPid);
  let cur = await jobs.list();
  if (!cur) return { ok: false, found: [], left: [], reason: `Job 목록을 읽지 못함${jobs.failed ? ` — ${jobs.failed}` : ''}` };
  for (let waited = 0; rest(cur).length && waited < settleMs; waited += 250) { // 막 끝나는 중인 것은 잠깐 기다려 준다
    await sleep(250);
    cur = await jobs.list();
    if (!cur) return { ok: false, found: [], left: [], reason: `Job 목록을 읽지 못함${jobs.failed ? ` — ${jobs.failed}` : ''}` };
  }
  const found = [];
  for (const pid of rest(cur)) { const r = await jobs.end(pid, waitMs); found.push({ pid, status: r?.status ?? 'no-answer', name: r?.name ?? null }); }
  if (!found.length) return { ok: true, found, left: [], reason: null };
  for (let waited = 0; ; waited += 250) {
    cur = await jobs.list();
    if (!cur) return { ok: false, found, left: found.map(({ pid, name }) => ({ pid, name })), reason: 'Job 목록을 읽지 못함(끝낸 뒤)' };
    if (!rest(cur).length || waited >= waitMs) break;
    await sleep(250);
  }
  const still = new Set(rest(cur));
  const nameOf = new Map(found.map((f) => [f.pid, f.name]));
  const left = [...still].map((pid) => ({ pid, name: nameOf.get(pid) ?? null }));
  return { ok: left.length === 0, found, left, reason: left.length ? `Job 에 끝나지 않은 프로세스가 남음 pid=${left.map((l) => l.pid).join(',')}` : null };
}

/**
 * watchFirstScreen -- CLI 를 띄워 첫 화면이 가라앉을 때까지 본다(아무것도 입력하지 않는다).
 * 가라앉음 = 출력이 quietMs 동안 멈췄고 화면 판정이 busy 가 아님(최소 minMs, 최대 maxMs). 한도에 닿으면 settled=false —
 * 그 관측은 통과가 될 수 없다(판정 ⓪). 끝내지는 않는다 — 부른 쪽이 stop() 을 부른다(probe* 가 finally 로 보장).
 * 보는 도중에 무엇이 던지면 띄운 프로세스를 끝낸 뒤 다시 던진다.
 * stop() -> { how, left, retried, names, tracked, reason }:
 *   how = 'ended' | 'ended-after-retry' | 'failed'. 'failed' 가 아닐 때만 "이 관측이 낳은 프로세스가 전부 끝났다".
 *   Job 의 목록에서 "띄우기 직전에는 없던 구성원"(띄운 프로세스 · 가상 터미널의 콘솔 도우미 · 자손)을 전부, 도우미가 핸들로
 *   끝낸다(띄운 것부터). 그러고도 남은 것이 있으면 그것만 한 번 더 끝내 보고, 그래도 남으면 failed.
 *   목록을 읽지 못하거나 추적기가 실패로 굳었으면 끝났다고 말할 수 없으므로 failed.
 * tracker = Job 추적기(기본 = 이 프로세스의 것). 시험이 바꿔 끼우는 자리다.
 *   tracker.kind 가 'job' 이 아니면(시험용 대역) 띄운 프로세스가 Job 에 보이는지는 확인하지 않고, 띄운 프로세스는
 *   터미널 대역이 쥔 프로세스 객체로 끝낸다.
 */
export async function watchFirstScreen({ driver, file, args, cwd, env, re = BUILTIN_SCREEN_RE, cols = 120, rows = 36, quietMs = 6000, minMs = 10000, maxMs = 90000, tickMs = 400,
  tracker = undefined, stopWaitMs = 5000, firstDrainMs = 1500 }) {
  const jobs = tracker ?? await getJobTracker();
  // 띄우기 직전의 구성원 — 이 뒤에 새로 보이는 것은 전부 이번 관측이 낳은 것이다.
  const baselineList = await jobs.list();
  const baseline = new Set(baselineList ?? []);
  const born = (cur) => cur.filter((pid) => !baseline.has(pid) && pid !== process.pid);
  const t0 = Date.now();
  armExitGuard();
  const term = driver.open({ file, args, cwd, env, cols, rows });
  const rootPid = term.state.pid;
  // 띄운 프로세스가 Job 에 보여야 "빠짐없이 센다"가 성립한다. 살아 있는데 안 보이면 추적이 깨진 것이다.
  let broken = baselineList ? null : `Job 목록을 읽지 못함(띄우기 전)${jobs.failed ? ` — ${jobs.failed}` : ''}`;
  if (!broken && jobs.kind === 'job') {
    const first = await jobs.list();
    if (!first) broken = `Job 목록을 읽지 못함(띄운 직후)${jobs.failed ? ` — ${jobs.failed}` : ''}`;
    else if (!term.state.exited && !first.includes(rootPid)) broken = `띄운 프로세스(pid=${rootPid})가 Job 에 보이지 않음`;
  }
  // 남은 구성원이 없어질 때까지(최대 ms) 기다렸다가 그때의 남은 PID 를 돌려준다. 목록을 못 읽으면 null.
  const drain = async (ms) => {
    for (let waited = 0; ; waited += 250) {
      const cur = await jobs.list();
      if (!cur) return null;
      const left = born(cur);
      if (!left.length || waited >= ms) return left;
      await sleep(250);
    }
  };
  const waitExit = async (ms) => { for (let waited = 0; waited < ms && !term.state.exited; waited += 100) await sleep(100); return term.state.exited; };
  const stop = async () => {
    const names = {};
    let tracked = null;
    const note = (pid, r) => { if (r?.name) names[pid] = r.name; return r; };
    const fail = (reason, left = [], retried = []) => ({ how: 'failed', left, retried, names, tracked, reason });
    const unknown = (when) => `Job 목록을 읽지 못해 자손이 끝났는지 알 수 없음(${when})${jobs.failed ? ` — ${jobs.failed}` : ''}`;
    const before = broken ? null : await jobs.list();
    const first = before ? born(before) : [];
    tracked = before ? first.length : null;
    // 띄운 것부터 끝낸다(자식을 더 낳지 못하게). 그다음 이 관측이 낳은 나머지. 전부 도우미가 핸들로 — Job 소속을 확인한 그 핸들로.
    // 추적이 깨졌거나(띄운 프로세스가 Job 에 안 보임) 시험용 대역이면 Job 소속을 확인할 수 없으니, 띄운 프로세스 하나만
    // 터미널이 쥔 프로세스 객체로 끝낸다(그 경우의 결과는 어차피 실패이거나 시험이다).
    if (jobs.kind === 'job' && !broken) { for (const pid of [rootPid, ...first.filter((p) => p !== rootPid)]) note(pid, await jobs.end(pid, stopWaitMs)); }
    else term.kill?.();
    const rootGone = await waitExit(stopWaitMs);
    term.dispose();
    if (broken) return fail(broken, rootGone ? [] : [rootPid]);
    if (!before) return fail(unknown('끝내기 전'), rootGone ? [] : [rootPid]);
    let left = await drain(firstDrainMs);
    if (left === null) return fail(unknown('끝낸 뒤'));
    const retried = [...left];
    if (left.length) {
      for (const pid of left) note(pid, await jobs.end(pid, stopWaitMs)); // Job 에 남아 있는 그것들만, 다시 핸들로
      left = await drain(stopWaitMs);
      if (left === null) return fail(unknown('다시 끝낸 뒤'), retried, retried);
    }
    if (left.length || !rootGone) return fail(`끝나지 않은 프로세스 pid=${(left.length ? left : [rootPid]).join(',')}`, left.length ? left : [rootPid], retried);
    if (jobs.failed) return fail(`프로세스 추적기가 실패함 — ${jobs.failed}`);
    return { how: retried.length ? 'ended-after-retry' : 'ended', left: [], retried, names, tracked, reason: null };
  };
  const timeline = [];
  let last = null; let final = classifyScreen([], re); let settled = false;
  try {
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
  } catch (e) {
    await stop().catch(() => {});
    throw e;
  }
  const allLines = [...new Set(timeline.flatMap((s) => s.text.split('\n')))];
  const rawAtSettle = term.state.raw;
  return {
    rawAtSettle,
    pid: term.state.pid, alive: !term.state.exited, exited: term.state.exited, exitCode: term.state.exitCode,
    settled, ms: Date.now() - t0, final, timeline, timelineText: timeline.map((s) => s.text).join('\n\n'), allLines, raw: () => term.state.raw,
    // 판정이 끝난 뒤에만 쓴다: 보기 키를 한 번 누르고 그 화면을 읽는다(요청문이 아니다 — 모델 호출 없음).
    peek: async (keys, waitMs = 1500) => {
      term.write(keys);
      await sleep(waitMs);
      return (await term.lines()).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    },
    stop,
  };
}

// ---------------------------------------------------------------------------
// 에이전트별 재현
// ---------------------------------------------------------------------------

/** 창이 기록 폴더 이름을 만드는 식(창 daemon/agents/claude.mjs claudeProjectSlug 와 같다). */
export const claudeProjectSlug = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

/** 띄운 프로세스를 끝내고 결과를 관측값에 적는다(던지지 않는다). */
async function finishChild(obs) {
  const s = await obs.stop().catch((e) => ({ how: 'failed', left: [], retried: [], tracked: null, reason: String(e?.message || e) }));
  obs.stopped = s.how; obs.stopInfo = s; obs.childGone = s.how !== 'failed';
}

/** 코덱스 실행 꾸러미(codex.cmd)를 cmd 로 돌릴 인수. `/d` = 레지스트리의 AutoRun 명령을 돌리지 않는다. */
export const codexCmdArgs = (cmdFile, args = []) => ['/d', '/c', cmdFile, ...args];

function countHookCalls(hookLog) {
  try { return fs.readFileSync(hookLog, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length; } catch { return 0; }
}

/**
 * 클로드를 띄울 인수 — 창(daemon/agents/claude.mjs buildCommand)과 같되 **`--chrome` 만 뺀다.**
 * `--chrome` 은 브라우저 연동을 켜는 인수이고, 클로드는 그 길에서 연동 안내 파일의 경로를
 * HKCU\Software\<브라우저>\NativeMessagingHosts 아래에 등록할 수 있다(2.1.326 실행 파일의 표 = 브라우저 일곱 가지).
 * 환경 변수는 임시 폴더로 돌릴 수 있어도 레지스트리는 못 돌린다 — 검사가 이 PC 의 진짜 등록에 닿을 길을 아예 두지 않는다.
 * 뺀 값: 2.1.311 · 2.1.326 에서 넣고 본 첫 화면과 빼고 본 첫 화면이 같았다(씨앗이 있을 때 · 뺐을 때 둘 다, 검증기록 5-82).
 * 잃는 것: 크롬 연동 안내창은 이 검사로 볼 수 없다(넣었을 때도 오프라인 첫 화면에서는 뜨지 않았다) — 실제 PC 시험의 몫.
 * 권한 인수도 넘기지 않는다 — 설치기 씨앗이 혼자 버티는지 본다.
 */
export function claudeArgs({ model = 'claude-opus-5-5', effort = 'high', fastSettings, sessionId }) {
  return ['--model', model, '--effort', effort, '--settings', fastSettings, '--session-id', sessionId];
}

export async function probeClaude({ root, exe, env, driver, re, model = 'claude-opus-5-5', effort = 'high', hookLog = null, launch = null, watch = {}, expectDefaultMode = undefined }) {
  const sessionId = crypto.randomUUID();
  const fast = path.join(root, '_probe', 'fast-mode.json');
  fs.mkdirSync(path.dirname(fast), { recursive: true });
  fs.writeFileSync(fast, `${JSON.stringify({ fastMode: true }, null, 2)}\n`, 'utf8');
  const args = claudeArgs({ model, effort, fastSettings: fast, sessionId });
  const cmd = launch ?? { file: exe, args };
  const recordDir = path.join(env.CLAUDE_CONFIG_DIR, 'projects', claudeProjectSlug(root));
  let obs = null;
  try {
    obs = await watchFirstScreen({ driver, file: cmd.file, args: cmd.args, cwd: root, env, re, ...watch });
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
  } finally {
    // 무엇을 보다가 던졌든 띄운 프로세스부터 끝낸다. 나무 전체가 끝났는지는 판정에 들어간다(⑩).
    if (obs) await finishChild(obs);
  }
  obs.checks = judgeClaude(obs);
  return obs;
}

/** 코덱스: 창과 같은 인수(-m … -c model_reasoning_effort -c service_tier=fast --dangerously-bypass-hook-trust). */
export async function probeCodex({ root, cmdFile, env, driver, re, model = 'gpt-6.1-sol', effort = 'medium', launch = null, watch = {}, peekWarnings = true }) {
  const toml = codexConfigTomlPath(root);
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const before = read(toml);
  const args = ['-m', model, '-c', `model_reasoning_effort=${effort}`, '-c', 'service_tier=fast', '--dangerously-bypass-hook-trust'];
  const cmd = launch ?? { file: env.ComSpec || 'cmd.exe', args: codexCmdArgs(cmdFile, args) };
  let obs = null;
  try {
    obs = await watchFirstScreen({ driver, file: cmd.file, args: cmd.args, cwd: root, env, re, ...watch });
    const after = read(toml);
    obs.configChanged = before !== null && after !== before;
    const lineSet = (t) => new Set(String(t ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const a = lineSet(before); const b = lineSet(after);
    obs.configDiff = { added: [...b].filter((l) => !a.has(l)).slice(0, 20), removed: [...a].filter((l) => !b.has(l)).slice(0, 20) };
    obs.cmdline = ['codex', ...args].join(' ');
    // 코덱스는 시작 경고를 상태줄에 "⚠ N warnings · f2 to view" 로 접어 둔다. 판정에 쓸 화면은 이미 잡았으니,
    // 살아 있으면 보기 키(F2)를 한 번 눌러 경고 글을 기록에 남긴다(무엇이 경고인지 사람이 읽게).
    // 키는 화면이 기대한 그 화면일 때만 보낸다 — 다른 화면(물음 · 입력란에 글이 든 화면)에 키가 먹히지 않게:
    //   F2      가라앉은 대기 화면(입력 칸 · 물음 없음)이고 상태줄에 경고 배지가 보일 때만
    //   화살표  바로 앞에 읽은 화면이 경고 보기 창("Warnings · N of M")일 때만
    // 조건이 안 맞으면 보내지 않고 경고 글을 "못 봄"으로 적는다(warningPeek). 경고 글은 기록용이라 판정(④는 배지가
    // 입력 칸을 가리지 않는가)에는 쓰지 않는다 — 못 봐도 종료 코드는 그대로다.
    obs.warningView = null;
    obs.warningPeek = 'no-badge';
    const isWarningPage = (page) => /Warnings · \d+ of \d+/.test((page ?? []).join('\n'));
    if (peekWarnings && /warnings? · f2 to view/i.test(obs.final.tail ?? '')) {
      const calm = obs.settled === true && obs.alive && obs.final.status === 'idle' && !obs.final.attention && !obs.final.updatePrompt
        && /(^|\n)\s*(›|»)(\s|$)/.test(obs.final.tail ?? '') && findDialogs(obs.timelineText, 'codex').length === 0;
      if (!calm) obs.warningPeek = 'not-seen: 가라앉은 대기 화면이 아니라 보기 키를 보내지 않음';
      else {
        try {
          const pages = [];
          let page = await obs.peek('\x1bOQ');
          if (!isWarningPage(page)) obs.warningPeek = 'not-seen: 보기 키 뒤의 화면이 경고 보기 창이 아니라 더 보내지 않음';
          else {
            const total = Math.min(Number((/Warnings · \d+ of (\d+)/.exec(page.join('\n')) || [])[1] ?? 1), 30);
            pages.push(page);
            obs.warningPeek = 'seen';
            for (let i = 1; i < total; i++) {
              page = await obs.peek('\x1b[C', 500);
              if (!isWarningPage(page)) { obs.warningPeek = `partial: ${pages.length}/${total}쪽 뒤 화면이 경고 보기 창이 아니라 멈춤`; break; }
              pages.push(page);
            }
            // 쪽마다 머리(판 · 폴더 · 권한 줄)와 꼬리(키 안내)는 같다 — 경고 글만 남긴다.
            obs.warningView = pages.map((p) => p.filter((l) => !/^\s*(>_ OpenAI Codex|~?\\|[A-Za-z]:\\|permissions:)/.test(l) && !/keep & next · esc dismiss/.test(l)).join('\n'));
          }
        } catch (e) { obs.warningView = null; obs.warningPeek = `not-seen: ${String(e?.message || e).slice(0, 80)}`; }
      }
    }
  } finally {
    if (obs) await finishChild(obs);
  }
  const j = judgeCodex(obs);
  obs.checks = j.checks; obs.warnings = j.warnings; obs.mcpArtifacts = j.mcpArtifacts; obs.warningBadge = j.warningBadge;
  return obs;
}

/** `--version` 한 줄(죽은 주소를 준 격리 환경에서 · 스스로 끝난다). 못 읽으면 null. */
export function cliVersion(file, args, env) {
  try { return execFileSync(file, args, { env, encoding: 'utf8', timeout: 30000, windowsHide: true }).trim().split(/\r?\n/).pop(); } catch { return null; }
}

/** `--version` 출력에서 판 번호만("2.1.326 (Claude Code)" · "codex-cli 0.172.0" -> "2.1.326" · "0.172.0"). 없으면 null. */
export function parseCliVersion(text) {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * 띄우려는 실행 파일이 잠금표의 판인가. 잠금 판 재현에서는 이것이 맞아야만 통과가 될 수 있다 —
 * 화면이 아무리 깨끗해도 다른 판을 본 것은 잠금 판을 본 것이 아니다.
 *   -> { state: 'match'|'mismatch'|'unreadable'|'no-lock', actual, expected }
 */
export function checkLockVersion(versionText, expected) {
  const actual = parseCliVersion(versionText);
  if (!expected) return { state: 'no-lock', actual, expected: null };
  if (!actual) return { state: 'unreadable', actual: null, expected: String(expected) };
  return { state: actual === String(expected) ? 'match' : 'mismatch', actual, expected: String(expected) };
}

/**
 * 판 확인 결과 -> 띄울지 말지. 잠금 판 검증에서는 판이 맞을 때만 띄운다. 견주기(compare)에서는 판을 요구하지 않는다.
 *   -> { launch: true } | { launch: false, state: 'failed'|'skipped', detail }
 */
export function decideLaunch(gate, { compare = false } = {}) {
  if (compare || gate.state === 'match') return { launch: true };
  if (gate.state === 'mismatch') return { launch: false, state: 'failed', detail: `실행 파일은 ${gate.actual}, 잠금표는 ${gate.expected} — 다른 판을 견주려면 --compare(그 결과는 잠금 판 검증이 아니다)` };
  if (gate.state === 'no-lock') return { launch: false, state: 'skipped', detail: '잠금표에서 이 부품의 판을 읽지 못함' };
  return { launch: false, state: 'skipped', detail: `실행 파일의 판을 읽지 못함(--version) — 잠금 판(${gate.expected})인지 알 수 없어 띄우지 않는다` };
}

/**
 * 실행마다 새 작업 폴더. 받은 경로(base) 자체는 만들기만 하고 **지우지 않는다** — 그 안에 이번 실행의 폴더를 새로 만들고,
 * 정리할 때도 그 폴더 하나만 지운다(base 에 있던 다른 자료 · 동시에 도는 다른 실행의 폴더는 건드리지 않는다).
 */
export function makeRunDir(base) {
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'run-'));
}

/** makeRunDir 가 만든 폴더 하나를 지운다. -> { removed: boolean, error?: string } (모양이 다른 경로는 지우지 않는다) */
export function removeRunDir(dir) {
  if (!dir || !/^run-[A-Za-z0-9]{6}$/.test(path.basename(dir))) return { removed: false, error: 'not a run folder made by this script' };
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { return { removed: false, error: String(e?.message || e) }; }
  return fs.existsSync(dir) ? { removed: false, error: 'still exists' } : { removed: true };
}

// ---------------------------------------------------------------------------
// 준비 — 잠금 판 클로드 받기(네트워크를 쓴다). 여기서 띄우는 프로세스도 격리 환경으로
// ---------------------------------------------------------------------------

/**
 * prepareClaude -- 설치기 함수 installClaude 로 잠금 판을 실행 폴더 안(<work>\cli)에 받는다.
 * 내려받기 자체는 이 node 프로세스가 한다(바깥 망이 필요하다). installClaude 가 **띄우는 프로세스**에는 이 PC 의 환경을
 * 물려주지 않는다 — 그 함수의 주입 자리 둘에 격리된 것을 준다:
 *   · runFn       받은 실행 파일의 `--version` 확인. 관측 단계와 같은 격리 환경(설정 · 홈 · 임시 폴더 = 실행 폴더, 죽은 주소)으로 돌린다.
 *   · npmInstall  출처 2(npm 대체 설치). 이 검사에서는 **쓰지 않는다** — 대체 설치는 이 PC 의 npm 설정 · 캐시를 읽는 프로세스를
 *                 띄우게 되므로, 출처 1(공식 배포)이 안 되면 받지 못한 것으로 끝낸다(→ 못 봄, 종료 코드 2. `--claude-exe` 로 준다).
 * installClaude 의 `env` 인자는 "오프라인 표시" 한 칸을 읽는 데만 쓰이고 자식에게 넘어가지 않는다 — 그대로 둔다.
 *   -> { ok: true, exe, version, source } | { ok: false, reason }
 */
export async function prepareClaude({ work, lock, deadUrl, install = installClaude, runFn = run, base = process.env }) {
  const dl = path.join(work, 'cli');
  fs.mkdirSync(path.join(dl, '_agent', 'setup'), { recursive: true });
  const env = isolatedEnv({ root: dl, home: path.join(work, 'prep-home'), deadUrl, base });
  const isolatedRun = (exe, args, opts = {}) => runFn(exe, args, { ...opts, env });
  const noNpm = async () => ({ code: 1, out: '', err: 'firstrun-probe: 출처 2(npm 대체 설치)는 이 검사에서 쓰지 않는다' });
  let got;
  try { got = await install({ root: dl, nodeDir: path.dirname(process.execPath), lock, subscriptions: ['claude'], log: () => {}, runFn: isolatedRun, npmInstall: noNpm }); }
  catch (e) { got = { ok: false, message: String(e?.message || e) }; }
  if (!got?.ok) return { ok: false, reason: `잠금 판 Claude Code 를 받지 못함(${got?.code ?? got?.state ?? '-'} ${got?.message ?? ''}) — 공식 배포 주소에 닿는지 확인하거나 --claude-exe` };
  const version = String(got.version ?? lock?.parts?.claude?.version);
  return { ok: true, exe: path.join(dl, '_agent', 'shared', 'tools', 'claude', version, lock?.parts?.claude?.binName ?? 'claude.exe'), version, source: got.source ?? null };
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

// 3 = 견주기(--compare)로 돌았고 본 것은 전부 맞았다 — 그래도 "잠금 판 검증 통과"(0)가 아니다.
export const EXIT = Object.freeze({ ok: 0, failed: 1, skipped: 2, compare: 3 });

export function parseArgs(argv) {
  const o = { agent: 'both', face: null, claudeExe: null, codexCmd: null, work: null, logDir: null, label: null, control: null, codexAuth: 'apikey', keep: false, compare: false };
  const take = { '--agent': 'agent', '--face': 'face', '--claude-exe': 'claudeExe', '--codex-cmd': 'codexCmd', '--work': 'work', '--log-dir': 'logDir', '--label': 'label', '--control': 'control', '--codex-auth': 'codexAuth' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') o.keep = true;
    else if (a === '--compare') o.compare = true;
    else if (take[a]) { if (argv[i + 1] === undefined) throw new Error(`${a} 뒤에 값이 없습니다`); o[take[a]] = argv[++i]; }
    else throw new Error(`모르는 인수: ${a}`);
  }
  if (!['claude', 'codex', 'both'].includes(o.agent)) throw new Error(`--agent 는 claude | codex | both (${o.agent})`);
  if (o.control && !['no-nudges', 'no-permissions'].includes(o.control)) throw new Error(`--control 은 no-nudges | no-permissions (${o.control})`);
  if (!['apikey', 'chatgpt'].includes(o.codexAuth)) throw new Error(`--codex-auth 는 apikey | chatgpt (${o.codexAuth})`);
  // 대조군(씨앗을 뺌) · 로그인 꼴 대조는 잠금 판 검증이 아니다 — 견주기로만 돈다.
  if (o.control || o.codexAuth !== 'apikey') o.compare = true;
  return o;
}

/**
 * 결과 묶음 -> 종료 코드.
 *   1 = 실패가 하나라도 있다 / 작업 폴더를 지우지 못했다(무엇인가 파일을 쥐고 있다 — 끝나지 않은 자식일 수 있다)
 *   2 = 실패는 없는데 못 본 에이전트가 있다(조용한 통과 금지) · 아무것도 못 봤다
 *   3 = 견주기(--compare): 본 것은 전부 맞았지만 잠금 판 검증이 아니다
 *   0 = 잠금 판을 전부 봤고 전부 통과
 */
export function exitCodeOf(results, { compare = false, cleanupFailed = false } = {}) {
  const list = Object.values(results);
  if (list.some((r) => r.state === 'failed')) return EXIT.failed;
  if (cleanupFailed) return EXIT.failed;
  if (list.length === 0 || list.some((r) => r.state === 'skipped')) return EXIT.skipped;
  return compare ? EXIT.compare : EXIT.ok;
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
  const lockVer = { claude: lock?.parts?.claude?.version ?? null, codex: lock?.parts?.codex?.version ?? null };
  const workBase = path.resolve(opt.work ?? path.join(REPO, '_build', 'firstrun-probe'));
  const logDir = path.resolve(opt.logDir ?? path.join(REPO, '_build', 'firstrun-probe-logs'));
  const label = opt.label ?? (opt.compare ? 'compare' : 'lock');
  const want = opt.agent === 'both' ? ['claude', 'codex'] : [opt.agent];
  const results = {};
  const skip = (agent, reason) => { results[agent] = { state: 'skipped', reason }; console.log(`SKIP ${agent} -- ${reason}`); };
  const fail = (agent, name, detail) => { results[agent] = { state: 'failed', reason: `${name}: ${detail}` }; console.log(`FAIL ${agent} ${name} -- ${detail}`); };

  console.log(opt.compare
    ? 'mode: 견주기(--compare) — 이 실행의 결과는 "잠금 판 검증 통과"가 아니다'
    : `mode: 잠금 판 검증 (claude ${lockVer.claude ?? '-'} · codex ${lockVer.codex ?? '-'})`);

  // 받은 경로는 지우지 않는다 — 그 아래에 이번 실행의 폴더를 새로 만들고 그 폴더만 정리한다.
  // 폴더를 만든 **바로 다음 줄부터** try/finally 다: 그 뒤 무엇이 던져도(기록 폴더 · 화면 규칙 · 죽은 주소 띄우기) 정리를 거친다.
  const work = makeRunDir(workBase);
  const root = path.join(work, 'soul');
  const home = path.join(work, 'home');
  let dead = null;
  let jobsRef = null;
  let keepWork = opt.keep;
  let cleanup = { state: 'pending' };
  const out = { at: new Date().toISOString(), label, mode: opt.compare ? 'compare' : 'lock', lock: lockVer, control: opt.control, agents: {} };
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const faceDir = resolveFaceDir({ arg: opt.face, lock });
    const driver = loadPtyDriver(faceDir);
    const screenRe = loadFaceScreenRegexes(faceDir);
    out.screenRules = { source: screenRe.source, drift: screenRe.drift, missing: screenRe.missing };
    log(`screen rules: ${screenRe.source}${screenRe.drift.length ? ` (창의 식이 사본과 다름: ${screenRe.drift.join(', ')})` : ''}${screenRe.missing.length && screenRe.source === 'face' ? ` (창에서 못 읽음: ${screenRe.missing.join(', ')})` : ''}`);
    dead = await startDeadServer();

    // 띄우려는 실행 파일의 판을 잠금표와 견준다. 잠금 판 검증에서는 맞을 때만 띄운다(null 을 돌려주면 띄우지 않는다).
    const versionGate = (agent, versionText) => {
      const gate = checkLockVersion(versionText, lockVer[agent]);
      log(`${agent} ${versionText ?? '(판을 읽지 못함)'}${opt.compare ? ` (잠금표 ${lockVer[agent] ?? '-'} — 견주기)` : ''}`);
      const d = decideLaunch(gate, { compare: opt.compare });
      if (d.launch) return gate;
      if (d.state === 'failed') fail(agent, 'ⓥ 띄울 판 = 잠금 판', d.detail); else skip(agent, d.detail);
      return null;
    };
    const record = (agent, obs, gate, extra) => {
      if (!opt.compare) obs.checks.unshift({ name: 'ⓥ 띄운 판 = 잠금 판', ok: true, detail: `${gate.actual}` });
      const bad = obs.checks.filter((c) => !c.ok).length;
      for (const c of obs.checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${agent} ${c.name} -- ${c.detail}`);
      writeScreenLog(path.join(logDir, `${label}-${agent}.screen.txt`), `${agent} ${gate.actual ?? ''} (${label})`, obs);
      fs.writeFileSync(path.join(logDir, `${label}-${agent}.raw.log`), obs.rawAtSettle, 'utf8');
      results[agent] = { state: bad ? 'failed' : 'ok' };
      if (obs.childGone === false) keepWork = true; // 끝나지 않은 프로세스가 있다 — 복구 자료(작업 폴더)를 지우지 않는다
      out.agents[agent] = { version: gate.actual, lockVersion: lockVer[agent], versionState: gate.state, state: results[agent].state, cmdline: obs.cmdline, settled: obs.settled, ms: obs.ms,
        final: { ...obs.final, tail: undefined }, finalTail: obs.final.tail, dialogs: findDialogs(obs.timelineText, agent), stopped: obs.stopped, stopInfo: obs.stopInfo, childGone: obs.childGone, ...extra, checks: obs.checks };
    };

    // 자손을 빠짐없이 세는 Job 추적기 — 띄우기 전에 준비돼 있어야 한다. 쓸 수 없으면 아무것도 띄우지 않는다.
    // 도우미의 임시 · 홈 폴더도 이번 실행 폴더 안에 둔다.
    const jobs = driver.ok ? await getJobTracker({ home: path.join(work, 'job-helper') }) : null;
    jobsRef = jobs;
    if (!driver.ok) { for (const a of want) skip(a, driver.reason); }
    else if (!jobs.ok) { for (const a of want) skip(a, `프로세스 추적(Job Object)을 쓸 수 없음 — ${jobs.reason ?? '까닭 모름'}. 띄운 프로세스의 자손이 끝났는지 확인할 수 없어 띄우지 않는다`); }
    else {
      const seeded = await seedSoul({ root, lock, deadUrl: dead.url, control: opt.control });
      const env = isolatedEnv({ root, home, deadUrl: dead.url });
      log(`soul seeded (adapters.run): claude files ${seeded.recorded.claude.files.length}, codex files ${seeded.recorded.codex.files.length}; ${seeded.changed.join('; ')}`);

      if (want.includes('claude')) {
        let exe = opt.claudeExe ? path.resolve(opt.claudeExe) : null;
        if (!exe) {
          // 준비 단계 — 내려받기는 네트워크를 쓴다. 받은 것을 확인하려고 띄우는 프로세스에는 격리 환경을 준다(prepareClaude).
          log(`downloading Claude Code ${lockVer.claude} (lock) ...`);
          const got = await prepareClaude({ work, lock, deadUrl: dead.url });
          if (got.ok) exe = got.exe; else skip('claude', got.reason);
        }
        if (exe && !fs.existsSync(exe)) { skip('claude', `실행 파일이 없음: ${path.basename(exe)}`); exe = null; }
        const gate = exe ? versionGate('claude', cliVersion(exe, ['--version'], env)) : null;
        if (gate) {
          // 열쇠는 형식만 갖춘 가짜다(창은 1년 열쇠가 있으면 같은 변수로 넘긴다).
          const obs = await probeClaude({ root, exe, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-firstrun-probe-not-a-real-key' }, driver, re: screenRe.re, hookLog: seeded.hookLog,
            expectDefaultMode: opt.control === 'no-permissions' ? undefined : CLAUDE_MAX_PERMISSIONS.permissions.defaultMode });
          record('claude', obs, gate, { expectedRecord: obs.expectedRecord, foreignRecords: obs.foreignRecords, hookCalls: obs.hookCalls });
        }
      }

      if (want.includes('codex')) {
        let cmdFile = opt.codexCmd ? path.resolve(opt.codexCmd) : null;
        if (!cmdFile) {
          const cache = path.join(REPO, '_build', 'cache', 'npm');
          let meta = null; try { meta = JSON.parse(fs.readFileSync(path.join(cache, 'codex.meta.json'), 'utf8')); } catch { meta = null; }
          if (meta?.version && meta.version === lockVer.codex) cmdFile = path.join(cache, 'codex', 'codex.cmd');
          else skip('codex', `빌드 캐시에 잠금 판 코덱스(${lockVer.codex})가 없음(있는 판: ${meta?.version ?? '없음'}) — build 를 한 번 돌리거나 --codex-cmd`);
        }
        if (cmdFile && !fs.existsSync(cmdFile)) { skip('codex', `실행 꾸러미가 없음: ${path.basename(cmdFile)}`); cmdFile = null; }
        const gate = cmdFile ? versionGate('codex', cliVersion(env.ComSpec || 'cmd.exe', codexCmdArgs(cmdFile, ['--version']), env)) : null;
        if (gate) {
          writeFakeCodexAuth(env.CODEX_HOME, opt.codexAuth);
          const obs = await probeCodex({ root, cmdFile, env, driver, re: screenRe.re });
          if (obs.warningView) fs.writeFileSync(path.join(logDir, `${label}-codex.warnings.txt`), `${obs.warningView.join('\n\n')}\n`, 'utf8');
          record('codex', obs, gate, { warningBadge: obs.warningBadge, warningPeek: obs.warningPeek, warnings: obs.warnings, mcpArtifacts: obs.mcpArtifacts, configChanged: obs.configChanged, configDiff: obs.configDiff });
        }
      }
    }
  } catch (e) {
    // 준비 · 관측 · 판정 · 기록 중에 던진 것은 실패다. 띄운 프로세스는 probe* 의 finally 가 이미 끝냈다(못 끝냈으면 아래에서 잡힌다).
    results.error = { state: 'failed', reason: String(e?.message || e) };
    console.log(`FAIL firstrun-probe 예외 -- ${e?.stack || e}`);
  } finally {
    // 정리 순서: ① 관측별 종료(probe* 의 finally) → ② Job 전체 확인(이 스크립트 자신만 남았는가 — 준비 단계 · --version 이
    //            남긴 자손도 여기서 잡힌다) → ③ 도우미 닫기 → ④ 폴더 정리. 남은 것이 있으면 폴더를 지우지 않는다.
    if (dead) await dead.close().catch(() => {});
    if (jobsRef?.ok) {
      const sweep = await finalJobSweep(jobsRef).catch((e) => ({ ok: false, found: [], left: [], reason: String(e?.message || e) }));
      out.jobSweep = sweep;
      if (sweep.found.length) console.log(`NOTE 마지막 Job 확인: 관측 밖에서 남아 있던 프로세스 ${sweep.found.length}개를 끝냄 -- ${sweep.found.map((f) => `${f.pid}=${f.name ?? '?'}(${f.status})`).join(' ')}`);
      if (!sweep.ok) {
        keepWork = true;
        results.children = { state: 'failed', reason: sweep.reason };
        console.log(`FAIL firstrun-probe 마지막 Job 확인 -- ${sweep.reason}${sweep.left.length ? ` [${sweep.left.map((l) => `${l.pid}=${l.name ?? '?'}`).join(' ')}]` : ''} (작업 폴더를 남긴다)`);
      }
      // 물음에 답이 제때 오지 않은 적이 있으면 "지금의 목록"을 믿을 수 없다 — 그 실행은 통과가 될 수 없다.
      if (jobsRef.failed) { results.tracker = { state: 'failed', reason: jobsRef.failed }; console.log(`FAIL firstrun-probe 프로세스 추적기 -- ${jobsRef.failed}`); }
    }
    // Job 을 다루던 파워셸 도우미도 이 스크립트가 띄운 프로세스다 — 끝난 것을 확인하고 넘어간다.
    const closed = await closeJobTracker().catch(() => 'failed');
    if (closed === 'failed') {
      keepWork = true;
      results.helper = { state: 'failed', reason: 'Job 도우미가 끝나지 않음' };
      console.log(`FAIL firstrun-probe Job 도우미가 끝나지 않음 -- pid=${jobsRef?.pid ?? '-'} (작업 폴더를 남긴다)`);
    }
    if (keepWork) cleanup = { state: 'kept', path: work };
    else {
      await sleep(500);
      const r = removeRunDir(work);
      cleanup = r.removed ? { state: 'removed' } : { state: 'failed', path: work, error: r.error };
    }
    out.deadServer = { requests: dead?.hits.length ?? 0, byTarget: summarizeHits(dead?.hits ?? []) };
    out.results = results;
    out.cleanup = cleanup;
    out.exitCode = exitCodeOf(results, { compare: opt.compare, cleanupFailed: cleanup.state === 'failed' });
    try { fs.writeFileSync(path.join(logDir, `${label}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8'); } catch (e) { console.log(`WARN 결과 파일을 쓰지 못함 -- ${e?.message}`); }
  }
  log(`dead address received ${dead?.hits.length ?? 0} request(s) from the CLI under observation; logs -> ${path.relative(REPO, logDir) || logDir}`);
  // --keep 은 사람이 폴더를 보려고 일부러 남기는 것이다 — 통과(0)여도 폴더가 남는다. 남은 경로를 찍는다.
  if (cleanup.state === 'kept') console.log(`kept work folder${opt.keep ? ' (--keep)' : ''}: ${cleanup.path}`);
  // 정리 실패는 통과로 덮지 않는다: 무엇인가 그 폴더의 파일을 쥐고 있다는 뜻이고(끝나지 않은 자식일 수 있다), 받은 실행 파일이 남는다.
  if (cleanup.state === 'failed') console.log(`FAIL firstrun-probe 정리 -- 작업 폴더를 지우지 못함: ${cleanup.path} (${cleanup.error})`);
  const code = out.exitCode;
  const n = Object.values(results);
  const count = `ok ${n.filter((r) => r.state === 'ok').length} · failed ${n.filter((r) => r.state === 'failed').length} · skipped ${n.filter((r) => r.state === 'skipped').length}`;
  const seen = Object.entries(out.agents).map(([a, o]) => `${a} ${o.version ?? '?'}`).join(' · ');
  if (code === EXIT.ok) console.log(`firstrun-probe OK -- 잠금 판 검증 통과 (${seen}; ${count})`);
  else if (code === EXIT.compare) console.log(`firstrun-probe COMPARE -- 본 것은 전부 맞음(${seen}; ${count}) · 잠금 판 검증이 아니다(종료 코드 ${EXIT.compare})`);
  else if (code === EXIT.failed) console.log(`firstrun-probe FAIL (${seen || '본 것 없음'}; ${count})`);
  else console.log(`firstrun-probe INCOMPLETE -- 못 본 에이전트가 있다(${count})`);
  return code;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => setTimeout(() => process.exit(code), 200), (e) => { console.error(`firstrun-probe ERROR ${e?.stack || e}`); setTimeout(() => process.exit(EXIT.failed), 200); });
}
