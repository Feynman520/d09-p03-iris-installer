// ⑤-7 중계기 준비 (설계-v2 6-2 · 8절, 계약 v2 7단계)
//
// 만드는 것은 **네 가지 파일**뿐이다. 프로그램은 하나도 띄우지 않는다.
//
//   ① `_agent\shared\portable-state\teamclaude\teamclaude.json`  중계기 설정 뼈대
//   ② `<root>\대시보드.cmd`        대시보드 바로가기(동봉 node → teamclaude-dash\launch.mjs)
//   ③ `<root>\<이름> Face.cmd` + 바탕화면 바로가기   IRIS 창(기존 handoff.mjs 재사용)
//   ④ `<root>\소환하기.cmd`        환경변수 넣고 claude/codex 를 여는 단순판
//
// ── 🔴 중계기를 시작하지 않는다 ────────────────────────────────────────────
// TeamClaude 중계기(127.0.0.1:3456)는 **온라인 묶음 ⑥-4** 가 로그인을 마친 뒤에
// 띄운다. 여기서 띄우면 ⓐ 계정이 하나도 없는 상태로 포트를 잡고 ⓑ 이 개발 PC 처럼
// 이미 3456 이 살아 있는 기계에서는 남의 중계기를 건드리게 된다. 그래서 이 단계는
// `lib\proxy.mjs` 의 `ensureProxy` 를 **부르지 않고**, 그 파일에서는 "관리 스크립트가
// 어디 있는지"(`manageScriptPath`)만 가져와 기록한다. Face 도 띄우지 않는다
// (`handoff.mjs` 의 `launchFace` 는 조각 ⑦ 몫).
//
// ── 영혼 밖 쓰기 ──────────────────────────────────────────────────────────
// 바탕화면 바로가기 하나가 이 설치기가 `C:\IRIS` 밖에 만드는 유일한 물건이다
// (계약 v2 "예외 허용"). 연습 실행(`IRIS_INSTALLER_NO_USER_ENV=1`)에서는 그것도
// 만들지 않고 기록만 남긴다.
//
// ── 덮어쓰지 않는다 ──────────────────────────────────────────────────────
// 이미 있는 `.cmd` 의 내용이 우리가 쓰려는 것과 **다르면** 덮지 않고 옆에
// `<이름>.new` 로 써 두고 기록한다. 그 사람이 손본 실행기를 설치기가 조용히
// 되돌리는 일은 없다.
import nodeFs from 'node:fs';
import path from 'node:path';
import { StageError } from '../lib/errors.mjs';
import { assertInside, ensureDir } from '../lib/paths.mjs';
import { manageScriptPath } from '../lib/proxy.mjs';
import { portableTeamclaudeConfigPath, defaultRelayConfig, ensureRelayConfigDefaults } from '../lib/login.mjs';
import { writeFaceLauncher, faceLauncherPath, faceLauncherContent } from '../lib/handoff.mjs';

export const id = 'relay';

export const RELAY_PORT = 3456;
export const RELAY_BASE_URL = 'http://127.0.0.1:3456';
export const SUMMON_NAME = '소환하기.cmd';
export const DASHBOARD_NAME = '대시보드.cmd';

// `_agent/shared/tools/...`(슬래시) → `<root>\_agent\shared\tools\...`
// (계약 v2: 단계 모듈끼리 import 하지 않는다 — unpack.mjs 에 같은 4줄이 있다.)
function underRoot(root, rel) {
  if (rel === undefined || rel === null) return null;
  const clean = String(rel).replace(/^[\\/]+/, '');
  if (!clean || clean === '.') return root;
  return path.join(root, clean.split('/').join(path.sep));
}

function lockField(ctx, partId, field) {
  const fromManifest = ctx?.manifest?.parts?.[partId]?.[field];
  if (fromManifest !== undefined && fromManifest !== null) return fromManifest;
  const fromLock = ctx?.lock?.parts?.[partId]?.[field];
  return fromLock === undefined ? null : fromLock;
}

// ---------------------------------------------------------------------------
// ④ 소환하기.cmd
// ---------------------------------------------------------------------------

// 파일 **이름**은 한글이지만 **내용은 순수 ASCII·CRLF** 다. .cmd 는 cmd.exe 가
// 콘솔 OEM 코드페이지(이 나라에서는 949)로 읽기 때문에 한글 한 글자가 실행을
// 통째로 깨뜨릴 수 있다(`lib\shims.mjs` 머리말과 같은 제약).
//
// 경로 계산(`%~dp0` = 영혼 루트 + `\`):
//   %~dp0_agent\shared\shims        심 폴더(claude.cmd·codex.cmd·node.cmd…)
//   %~dp0_agent\claude / _agent\codex  두 에이전트의 설정 폴더
//
// 첫 인수가 `codex` 면 코덱스를, 아니면 클로드를 연다. `%args:*codex=%` 는 첫
// 토큰만 떼어 내는 cmd 관용구다(`shims.mjs` 의 py 심과 같은 방식) — 인수가
// `codex` 하나뿐이면 빈 문자열이 되어 그대로 맞는다.
export function summonContent() {
  return [
    '@echo off',
    'rem IRIS: open Claude Code (default) or Codex with this folder\'s settings.',
    'rem Usage: this file [codex] [extra args...]',
    'setlocal',
    'set "IRIS_ROOT=%~dp0."',
    'set "CLAUDE_CONFIG_DIR=%~dp0_agent\\claude"',
    'set "CODEX_HOME=%~dp0_agent\\codex"',
    `set "ANTHROPIC_BASE_URL=${RELAY_BASE_URL}"`,
    'set "PATH=%~dp0_agent\\shared\\shims;%~dp0_agent\\shared\\tools\\node;%~dp0_agent\\shared\\tools\\git\\cmd;%PATH%"',
    'set "args=%*"',
    'if /i "%~1"=="codex" (',
    '  call set "args=%%args:*%1=%%"',
    '  call "%~dp0_agent\\shared\\shims\\codex.cmd" %args%',
    ') else (',
    '  call "%~dp0_agent\\shared\\shims\\claude.cmd" %args%',
    ')',
    'exit /b %errorlevel%',
  ].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// ② 대시보드.cmd
// ---------------------------------------------------------------------------

// 대시보드는 동봉 node 로 `teamclaude-dash\launch.mjs` 를 돌린다. 그 스크립트가
// 중계기 생존 확인 → 뷰어(3457) 기동 → 브라우저 열기까지 스스로 한다. 설치기는
// **부르지 않는다** — 바로가기 파일만 만들어 둔다.
export function dashboardContent(relFromRoot) {
  const rel = String(relFromRoot).split('/').join('\\');
  return [
    '@echo off',
    'rem IRIS: open the usage dashboard (starts the relay and the viewer if needed).',
    'setlocal',
    `"%~dp0_agent\\shared\\tools\\node\\node.exe" "%~dp0${rel}\\launch.mjs" %*`,
    'exit /b %errorlevel%',
  ].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// ① 중계기 설정 뼈대
// ---------------------------------------------------------------------------

// TeamClaude 자신의 `loadConfig()` 가 읽는 모양 그대로의 **빈** 설정이다
// (`accounts` 배열 — `lib\login.mjs` 의 writeCodexImportEntry 가 여기에 항목을
// 더한다). 계정·토큰은 한 글자도 쓰지 않는다: 로그인은 ⑥-3 이 하고, 그 결과는
// 에이전트 CLI 가 자기 자격증명 파일에 쓴다.
export function emptyRelayConfig() {
  // 2026-09-17(2.0.8): `{ accounts: [] }` 만 쓰면 관리 스크립트가 `proxy.port` 검사에서 거절한다
  // (실제 사용자 실측 "This helper manages only the TeamClaude proxy on port 3456"). 중계기의
  // 기본 틀(proxy.port 3456 등)을 그대로 쓴다 — 계정·토큰은 여전히 0.
  return defaultRelayConfig();
}

// ---------------------------------------------------------------------------

export async function run(ctx) {
  const fs = ctx?.fs ?? nodeFs;
  const root = ctx?.root;
  if (!root) throw new StageError('E-RELAY', '설치 폴더 경로가 없어 중계기 준비를 할 수 없습니다.', { ctx: 'root' });
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};
  const rel = (p) => path.relative(root, p).split(path.sep).join('\\') || '.';
  const linkCache = new Map();
  const at = (...segs) => assertInside(root, path.join(root, ...segs), { fs, cache: linkCache });

  const recorded = {
    relayStarted: false,           // 이 단계는 중계기를 절대 띄우지 않는다
    port: RELAY_PORT,
    config: null,
    manageScript: null,
    files: { created: [], kept: [], sideBySide: [] },
    faceLauncher: null,
    desktopShortcut: null,
  };
  const pending = [];

  ensureDir(root, { fs });

  // 이미 있고 내용이 같으면 그대로 둔다(두 번 실행 변경 0). 다르면 덮지 않고
  // `<이름>.new` 를 옆에 쓴다.
  const putCmd = (name, text) => {
    const dst = at(name);
    if (fs.existsSync(dst)) {
      let current = '';
      try { current = fs.readFileSync(dst, 'ascii'); } catch { /* 읽을 수 없으면 다른 것으로 본다 */ }
      if (current === text) { recorded.files.kept.push(rel(dst)); return { status: 'kept', path: dst }; }
      const alt = `${dst}.new`;
      let altCurrent = '';
      try { altCurrent = fs.existsSync(alt) ? fs.readFileSync(alt, 'ascii') : ''; } catch { /* 무시 */ }
      if (altCurrent !== text) fs.writeFileSync(alt, text, 'ascii');
      recorded.files.sideBySide.push({ kept: rel(dst), written: rel(alt) });
      log(`[relay] ${name} 이(가) 이미 있고 내용이 달라 ${path.basename(alt)} 로 따로 두었습니다`);
      return { status: 'side-by-side', path: alt };
    }
    fs.writeFileSync(dst, text, 'ascii');
    recorded.files.created.push(rel(dst));
    return { status: 'created', path: dst };
  };

  // ── ① 중계기 설정 뼈대 ────────────────────────────────────────────────
  // 자리는 ⑤-2(env)가 영수증 `env.teamclaudeConfig` 와 사용자 환경변수
  // `TEAMCLAUDE_CONFIG` 에 적어 둔 바로 그 경로여야 한다 — 두 곳이 갈라지면
  // 로그인(⑥-3)이 만든 계정이 중계기가 읽는 파일과 다른 파일에 쌓인다. 기본값은
  // 같은 함수(`portableTeamclaudeConfigPath`)지만, 영수증에 값이 있으면 **그것을
  // 정본으로 삼는다**(단, 영혼 밖을 가리키면 쓰지 않는다 — assertInside 가 막는다).
  const recordedCfg = ctx?.receipt?.env?.teamclaudeConfig;
  const cfgFile = assertInside(
    root,
    typeof recordedCfg === 'string' && recordedCfg.length > 0 ? recordedCfg : portableTeamclaudeConfigPath(root),
    { fs, cache: linkCache },
  );
  const cfgDir = assertInside(root, path.dirname(cfgFile), { fs, cache: linkCache });
  ensureDir(cfgDir, { fs });
  if (fs.existsSync(cfgFile)) {
    // 옛 설치가 남긴 파일은 그대로 두되, 빠진 기본 칸(proxy.port 등)만 채운다(계정·토큰 무접촉).
    const { patched } = ensureRelayConfigDefaults(cfgFile, { fs });
    recorded.config = { path: rel(cfgFile), status: patched.length ? 'patched' : 'kept', ...(patched.length ? { patched } : {}) };
    recorded.files.kept.push(rel(cfgFile));
    if (patched.length) log(`[relay] 중계기 설정에 빠진 칸을 채움: ${patched.join(', ')}`);
  } else {
    const tmp = `${cfgFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(emptyRelayConfig(), null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, cfgFile);
    recorded.config = { path: rel(cfgFile), status: 'created' };
    recorded.files.created.push(rel(cfgFile));
  }

  // 관리 스크립트 위치만 기록한다(⑥-4 가 이것으로 중계기를 띄운다).
  const manage = manageScriptPath(root);
  recorded.manageScript = { path: rel(manage), present: fs.existsSync(manage) };
  if (!recorded.manageScript.present) {
    pending.push({ capability: '사용량 중계기(여러 구독 묶어 쓰기)', reason: '중계기 관리 스크립트가 아직 없습니다' });
  }

  // ── ② 대시보드 바로가기 ──────────────────────────────────────────────
  const dashDestRel = lockField(ctx, 'dash', 'dest') ?? '_agent/shared/tools/teamclaude-dash';
  const dashDir = underRoot(root, dashDestRel);
  const dashLaunch = path.join(dashDir, 'launch.mjs');
  if (fs.existsSync(dashLaunch)) {
    putCmd(DASHBOARD_NAME, dashboardContent(dashDestRel));
  } else {
    recorded.dashboard = { status: 'skipped', reason: `${rel(dashLaunch)} 없음` };
    pending.push({ capability: '사용량 대시보드', reason: '대시보드 부품이 설치되지 않았습니다' });
    log(`[relay] 대시보드 부품이 없어 ${DASHBOARD_NAME} 를 건너뜀`);
  }

  // ── ③ IRIS Face.cmd + 바탕화면 바로가기 ───────────────────────────────
  // 영혼 이름 = 폴더 이름(설계 11절: 설치 폴더는 `C:\IRIS` 고정, 연습 루트는
  // 그 이름이 곧 영혼 이름이다).
  const name = ctx.name ?? ctx?.receipt?.soul?.name ?? path.basename(root);
  const noUserEnv = (ctx.env?.IRIS_INSTALLER_NO_USER_ENV ?? process.env.IRIS_INSTALLER_NO_USER_ENV) === '1';
  const facePath = faceLauncherPath(root, name);
  assertInside(root, facePath, { fs, cache: linkCache });
  const faceText = faceLauncherContent();
  let faceCurrent = null;
  try { faceCurrent = fs.existsSync(facePath) ? fs.readFileSync(facePath, 'utf8') : null; } catch { /* 다시 쓴다 */ }

  if (faceCurrent === faceText && noUserEnv) {
    // 이미 같은 내용이고 바탕화면도 건너뛰는 연습 실행 → 아무것도 하지 않는다.
    recorded.faceLauncher = { path: rel(facePath), status: 'kept' };
    recorded.files.kept.push(rel(facePath));
    recorded.desktopShortcut = { status: 'skipped', reason: 'IRIS_INSTALLER_NO_USER_ENV=1' };
  } else {
    let r;
    try {
      r = await writeFaceLauncher(root, name, {
        skipShortcut: noUserEnv,
        ...(ctx.desktopDir ? { desktopDir: ctx.desktopDir } : {}),
        ...(typeof ctx.runPs === 'function' ? { runPs: ctx.runPs } : {}),
      });
    } catch (err) {
      throw new StageError('E-RELAY', 'IRIS 실행기를 만들지 못했습니다.', { error: String(err?.message ?? err) });
    }
    const status = faceCurrent === null ? 'created' : (faceCurrent === faceText ? 'kept' : 'updated');
    recorded.faceLauncher = { path: rel(r.cmdPath), status };
    (status === 'created' ? recorded.files.created : recorded.files.kept).push(rel(r.cmdPath));
    recorded.desktopShortcut = noUserEnv
      ? { status: 'skipped', reason: 'IRIS_INSTALLER_NO_USER_ENV=1' }
      : { status: r.shortcut?.ok ? 'created' : 'failed', path: r.lnkPath ?? null, detail: r.shortcut?.detail ?? null };
    if (!noUserEnv && !r.shortcut?.ok) {
      pending.push({ capability: '바탕화면 IRIS 바로가기', reason: '바로가기를 만들지 못했습니다(영혼 폴더의 실행기는 그대로 씁니다)' });
    }
  }

  // ── ④ 소환하기.cmd ───────────────────────────────────────────────────
  const summon = putCmd(SUMMON_NAME, summonContent());
  recorded.summon = { path: rel(summon.path), status: summon.status };

  log(`[relay] 설정 뼈대·바로가기 준비 완료(새로 ${recorded.files.created.length}개, 그대로 ${recorded.files.kept.length}개)`
    + ' — 중계기는 시작하지 않음');
  return { recorded, pending };
}
