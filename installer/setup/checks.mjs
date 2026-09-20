// ⑤-9 마무리 검사 (설계-v2 6-3 검사 9항목) + 인수 문서·설치보고·진단 파일
//
// 이 단계가 "설치가 끝났다"는 말의 근거다. 앞의 여덟 단계는 각자 자기 일을
// 했다고 말하지만, 실제로 **에이전트가 켜지는가**는 여기서만 확인된다.
// 그래서 검사는 전부 "진짜로 해 본다"를 원칙으로 한다:
//   · 실행 파일은 실제로 `--version` 을 부른다(파일 존재 확인이 아니라)
//   · MCP 서버는 실제로 띄워 `initialize` 를 주고받는다(설정 파일 읽기가 아니라)
//   · 훅 스크립트는 실제 파서로 문법을 본다(확장자 확인이 아니라)
//
// 세 가지 결과만 쓴다:
//   pass    — 지금 쓸 수 있다
//   pending — 설치는 맞는데 **이 PC 에 없는 프로그램** 때문에 쉬고 있다
//             (한컴·오피스·엣지). 사람 잘못도 설치 잘못도 아니다.
//   fail    — 고쳐야 한다. 하나라도 있으면 이 단계는 실패다.
//
// 실패해도 **먼저 파일 셋을 쓰고 나서** 멈춘다(인수 문서·설치보고·진단).
// 무엇이 왜 실패했는지 사람이 볼 수 없는 채로 멈추는 것이 가장 나쁜 실패다.
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { StageError } from '../lib/errors.mjs';
import { readUserEnv } from '../lib/userpath.mjs';
import { CODEX_PROXY_LINES } from '../lib/shims.mjs';
import { portableTeamclaudeConfigDir } from '../lib/login.mjs';
import { writeCaBundle, CA_FILE, BUNDLE_FILE } from '../lib/cabundle.mjs';
import { mitmProbe, MITM_TEST_HOST } from '../lib/mitmprobe.mjs';
import { SETUP_STAGE_IDS, receiptPath } from '../lib/receipt.mjs';
import { writeHandoff, copyInstallerProgram } from './handoff.mjs';
import { writeReport, writeDiagnostics, reportPath, diagnosticsPath } from './report.mjs';

const path = nodePath;

export const id = 'checks';

// 2026-09-16 VM S01 실측(4 GB/2 vCPU 손님, 세팅 직후 Defender 가 새 파일을 훑는 중):
// MCP initialize 10초 → playwright·pdf-automation 이 "10초 안에 답하지 않았습니다" 로 fail,
// exe 30초 → codex 첫 실행이 종료 코드 null(시간 초과)로 fail, 훅 문법 검사 20초 → 파워셸
// 기동조차 못 끝내 "문법 오류()" 로 fail. 셋 다 프로그램 잘못이 아니라 느린 PC 의 첫 실행이다.
// 검사는 "말이 통하는가"를 묻는 것이지 "빠른가"를 묻는 것이 아니므로 한도를 넉넉히 잡고,
// 시간 초과일 때만 한 번 더 시도한다(두 번째는 캐시가 따뜻해 빠르다).
export const MCP_TIMEOUT_MS = 60000;
export const EXE_TIMEOUT_MS = 120000;
export const SYNTAX_TIMEOUT_MS = 90000;

// 클로드 `.claude.json` 에 우리가 명시로 적는 MCP 서버 수(T16 확정).
// self-improve 는 플러그인이 자기 `.mcp.json` 으로 띄우므로 여기 세지 않고,
// `claude mcp list` 에 함께 보이는 내장 `vercel` 줄도 우리 것이 아니다.
export const EXPECTED_CLAUDE_MCP_COUNT = 6;

// 문서 MCP → 그 MCP 가 기다리는 프로그램. 없으면 fail 이 아니라 pending 이다.
export const DOCUMENT_MCP_APPS = Object.freeze({
  'hwp-automation': 'hancom',
  'excel-automation': 'office',
  'ppt-automation': 'office',
  'word-automation': 'office',
  'pdf-automation': null, // PDF 는 순수 파이썬 — 기다릴 프로그램이 없다
});

export const OFFICE_KEYS = Object.freeze([
  'HKLM\\SOFTWARE\\Microsoft\\Office',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Office',
]);
export const HANCOM_KEYS = Object.freeze([
  'HKCR\\HWPFrame.HwpObject',
  'HKLM\\SOFTWARE\\HNC',
  'HKLM\\SOFTWARE\\WOW6432Node\\HNC',
]);

// 바탕화면에 남아도 되는 **단 하나**. 설계-v2 D2-07: "바깥에는 바탕화면
// 「IRIS」 바로가기 하나". 바로가기 파일 이름은 영혼 이름을 그대로 쓴다 --
// installer/lib/handoff.mjs writeFaceLauncher 가 `${name}.lnk`(name =
// ctx.name ?? receipt.soul.name ?? path.basename(root))로 만들기 때문에,
// 이 개발 PC 연습 소울(IRIS_INSTALLER_SOUL_NAME=IRIS-offline 등)에서는
// 바로가기 이름이 "IRIS.lnk"가 아니다. 그래서 허용 목록을 고정 문자열이
// 아니라 root 이름에서 매번 도출한다(기본값 "IRIS.lnk"도 함께 허용해
// 실제 설치본과의 회귀를 막는다). T09b.
export function allowedDesktopFiles(root) {
  const names = [`${path.basename(root)}.lnk`, 'IRIS.lnk', 'desktop.ini'];
  return Object.freeze([...new Set(names)]);
}

// 훅으로 등록되는 스크립트 세 개(설계-v2 6-3 검사 4 "훅 스크립트 3개").
export const HOOK_FILES = Object.freeze([
  { rel: ['_agent', 'claude', 'scripts', 'block-blanket-kill.ps1'], kind: 'ps1' },
  { rel: ['_agent', 'claude', 'scripts', 'guard-iris-path.py'], kind: 'py' },
  { rel: ['_ontology', 'check_fresh.py'], kind: 'py' },
]);

// ---------------------------------------------------------------------------
// 작은 도구들
// ---------------------------------------------------------------------------

const item = (checkId, num, label, status, detail, extra = {}) => ({
  id: checkId, num, label, status, detail: String(detail ?? ''), ...extra,
});

function fsOf(ctx) { return ctx?.fs ?? nodeFs; }
function logOf(ctx) { return typeof ctx?.log === 'function' ? ctx.log : () => {}; }

function exists(fs, p) {
  try { return Boolean(p) && fs.existsSync(p); } catch { return false; }
}

function readJson(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function relOf(root, p) {
  if (!p) return '';
  const rel = path.isAbsolute(p) ? path.relative(root, p) : String(p);
  return rel.split(/[\\/]+/).filter(Boolean).join('\\');
}

/**
 * batchWrap — `.cmd`·`.bat` 은 `cmd.exe /d /s /c` 를 거쳐 띄운다.
 *
 * 왜: 윈도의 Node 는 보안 수정(CVE-2024-27980) 이후 배치 파일을 셸 없이
 * 띄우지 못하고 `spawn EINVAL` 로 즉사한다. 우리 심(shim)은 전부 `.cmd` 라,
 * 이 한 겹이 없으면 "심은 잘 만들어졌는데 검사만 실패"하는 거짓 실패가 난다
 * (2026-09-15 T18 통합 실기에서 실측).
 */
export function batchWrap(exe, args = []) {
  if (!/\.(cmd|bat)$/i.test(String(exe))) return { exe, args };
  return { exe: 'cmd.exe', args: ['/d', '/s', '/c', exe, ...args] };
}

async function runExe(ctx, exe, args, opts = {}) {
  if (typeof ctx.run !== 'function') return { code: -1, out: '', err: '실행 헬퍼가 없습니다' };
  const cmd = batchWrap(exe, args);
  try {
    return await ctx.run(cmd.exe, cmd.args, { env: ctx.env, timeoutMs: EXE_TIMEOUT_MS, ...opts });
  } catch (e) {
    return { code: -1, out: '', err: String(e?.message ?? e) };
  }
}

const shimPath = (root, name) => path.join(root, '_agent', 'shared', 'shims', name);
const toolsOf = (ctx) => ctx.toolsDir ?? path.join(ctx.root, '_agent', 'shared', 'tools');

// ---------------------------------------------------------------------------
// 검사 1 — 실행 파일 네 개
// ---------------------------------------------------------------------------

// 심(shim)이 있으면 심을 부른다. 심이야말로 **사용자가 실제로 쓰게 될 입구**라,
// 심을 건너뛰고 exe 를 직접 부르면 "설치는 됐는데 명령어가 안 먹는" 상태를
// 통과시켜 버린다. 심이 없는 경우(그 구독을 안 고름)만 동봉 exe 로 내려간다.
export function resolveExe(ctx, name) {
  const fs = fsOf(ctx);
  const root = ctx.root;
  const tools = toolsOf(ctx);
  const shim = shimPath(root, `${name}.cmd`);
  if (exists(fs, shim)) return { path: shim, via: 'shim' };
  const fallbacks = {
    node: [path.join(tools, 'node', 'node.exe')],
    python: [path.join(tools, 'python', 'python.exe')],
    git: [path.join(tools, 'git', 'cmd', 'git.exe'), path.join(tools, 'git', 'bin', 'git.exe')],
    codex: [path.join(tools, 'codex', 'codex.cmd'), path.join(tools, 'codex', 'codex.exe')],
  }[name] ?? [];
  for (const f of fallbacks) {
    if (exists(fs, f)) return { path: f, via: 'tools' };
  }
  return { path: name, via: 'path' };
}

export async function checkExe(ctx) {
  const names = ['node', 'python', 'git', 'codex'];
  const results = [];
  for (const name of names) {
    const { path: exe, via } = resolveExe(ctx, name);
    let res = await runExe(ctx, exe, ['--version']);
    if (res.timedOut === true || res.code === null) {
      // 시간 초과(느린 PC 의 첫 실행) — 한 번 더. 두 번째도 넘기면 정말 못 도는 것이다.
      res = await runExe(ctx, exe, ['--version']);
    }
    const out = `${res.out ?? ''}${res.err ?? ''}`.trim().split(/\r?\n/)[0] ?? '';
    results.push({ name, via, ok: res.code === 0 && out.length > 0, version: out.slice(0, 80), code: res.code });
  }
  const bad = results.filter((r) => !r.ok);
  const detail = results.map((r) => `${r.name} ${r.ok ? r.version : `실행 실패(종료 코드 ${r.code})`}`).join(' · ');
  return item('exe', 1, '실행 파일 4종 버전 확인', bad.length ? 'fail' : 'pass', detail, { results });
}

// ---------------------------------------------------------------------------
// 검사 2 — MCP 서버마다 initialize
// ---------------------------------------------------------------------------

/**
 * 등록된 MCP 서버 목록을 **설정 파일에서** 읽는다. 무엇을 등록했는지는 ⑤-6
 * 연결부 단계가 정하므로, 여기서 같은 목록을 다시 적어 두면 두 벌이 어긋난다.
 *   ① `_agent\claude\.claude.json` 의 mcpServers (6종)
 *   ② 플러그인 self-improve 의 `.mcp.json`(설치된 플러그인 폴더 안)
 */
export function collectMcpServers(ctx) {
  const fs = fsOf(ctx);
  const root = ctx.root;
  const out = [];

  const claudeJson = readJson(fs, path.join(root, '_agent', 'claude', '.claude.json'));
  const servers = claudeJson?.mcpServers ?? {};
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || typeof spec !== 'object') continue;
    out.push({
      name,
      command: spec.command,
      args: Array.isArray(spec.args) ? spec.args : [],
      env: spec.env ?? {},
      source: 'claude',
    });
  }

  // 플러그인이 스스로 띄우는 MCP — 설치된 플러그인 폴더의 `.mcp.json`.
  const installed = readJson(fs, path.join(root, '_agent', 'claude', 'plugins', 'installed_plugins.json'));
  for (const [key, entries] of Object.entries(installed?.plugins ?? {})) {
    const first = Array.isArray(entries) ? entries[0] : null;
    const dir = first?.installPath;
    if (!dir) continue;
    const mcp = readJson(fs, path.join(dir, '.mcp.json'));
    for (const [name, spec] of Object.entries(mcp?.mcpServers ?? {})) {
      if (!spec || typeof spec !== 'object') continue;
      const expand = (s) => String(s).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, dir);
      out.push({
        name: `plugin:${key.split('@')[0]}:${name}`,
        command: expand(spec.command),
        args: (Array.isArray(spec.args) ? spec.args : []).map(expand),
        env: spec.env ?? {},
        source: 'plugin',
      });
    }
  }
  return out;
}

/**
 * mcpInitialize — 서버를 실제로 띄워 JSON-RPC `initialize` 를 한 번 주고받는다.
 *
 * 왜 initialize 만인가: 도구를 한 번 실제로 부르면(예: 플레이라이트로 화면을
 * 연다) 몇 십 초가 걸리고 브라우저까지 뜬다. `initialize` 는 "이 서버가 뜨고
 * 말이 통하는가"라는 질문에 정확히 답하면서 1초 안에 끝난다. 그 이상은 검사의
 * 일이 아니라 사용의 일이다.
 *
 * 띄운 자식은 **내가 띄운 PID 만** 정확히 종료한다(전역 규칙: 이름 기반 일괄
 * 종료 금지).
 */
export function mcpInitialize(spec, { spawn = nodeSpawn, env = process.env, timeoutMs = MCP_TIMEOUT_MS, run = null } = {}) {
  return new Promise((resolve) => {
    if (!spec.command) { resolve({ ok: false, reason: 'no-command', detail: '실행 명령이 설정에 없습니다' }); return; }
    const isBatch = /\.(cmd|bat)$/i.test(String(spec.command));
    let child;
    try {
      child = spawn(spec.command, spec.args ?? [], {
        env: { ...env, ...(spec.env ?? {}) },
        windowsHide: true,
        shell: isBatch, // 윈도 Node 는 .cmd 를 셸 없이 띄우지 않는다
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, reason: 'spawn-failed', detail: String(e?.message ?? e) });
      return;
    }

    let settled = false;
    let buf = '';
    let stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const pid = child?.pid;
      try { child.kill(); } catch { /* 이미 죽었다 */ }
      // 셸을 거쳐 띄운 손자 프로세스는 부모만 죽여서는 남을 수 있다.
      // 내가 띄운 그 PID 의 트리만 정확히 정리한다.
      if (isBatch && pid && typeof run === 'function') {
        // 결과를 기다리지 않는다(정리일 뿐이다). 대신 거절이 새어 나가지 않게 삼킨다.
        try { Promise.resolve(run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 5000 })).catch(() => {}); } catch { /* best effort */ }
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', detail: `${Math.round(timeoutMs / 1000)}초 안에 답하지 않았습니다` }), timeoutMs);

    child.on('error', (e) => finish({ ok: false, reason: 'spawn-failed', detail: String(e?.message ?? e) }));
    child.on('close', (code) => finish({ ok: false, reason: 'closed', detail: `서버가 답 없이 끝났습니다(종료 코드 ${code})${stderr ? ` — ${stderr.slice(0, 160)}` : ''}` }));
    child.stderr?.on?.('data', (d) => { stderr += String(d); });
    child.stdout?.on?.('data', (d) => {
      buf += String(d);
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // 서버가 찍는 로그 줄은 건너뛴다
        if (msg?.id !== 1) continue;
        if (msg.error) { finish({ ok: false, reason: 'error', detail: String(msg.error?.message ?? 'initialize 거절') }); return; }
        if (msg.result) {
          finish({ ok: true, server: msg.result?.serverInfo?.name ?? null, protocol: msg.result?.protocolVersion ?? null });
          return;
        }
      }
    });

    const req = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'iris-installer-check', version: '2.0.0' },
      },
    };
    try {
      child.stdin.write(`${JSON.stringify(req)}\n`);
    } catch (e) {
      finish({ ok: false, reason: 'write-failed', detail: String(e?.message ?? e) });
    }
  });
}

// 레지스트리 한 줄 조회 — 오피스·한컴이 이 PC 에 있는가.
export async function detectApps(ctx) {
  const pre = ctx?.precheck?.recorded ?? ctx?.precheck ?? {};
  const out = {
    office: typeof pre.office === 'boolean' ? pre.office : (pre.office?.present ?? null),
    hancom: typeof pre.hancom === 'boolean' ? pre.hancom : (pre.hancom?.present ?? null),
  };
  const probe = async (keys) => {
    for (const key of keys) {
      const res = await runExe(ctx, 'reg', ['query', key], { timeoutMs: 8000 });
      if (res?.code === 0) return true;
    }
    return false;
  };
  if (out.office === null) out.office = await probe(OFFICE_KEYS);
  if (out.hancom === null) out.hancom = await probe(HANCOM_KEYS);
  return out;
}

export async function checkMcp(ctx, { spawn = ctx?.spawn ?? nodeSpawn, timeoutMs = MCP_TIMEOUT_MS } = {}) {
  const servers = collectMcpServers(ctx);
  if (!servers.length) {
    return item('mcp', 2, 'MCP 서버 initialize 응답', 'fail', '등록된 MCP 서버를 하나도 찾지 못했습니다(설정 파일이 비었습니다).', { servers: [] });
  }
  const apps = await detectApps(ctx);
  const results = [];
  for (const spec of servers) {
    const bare = spec.name.replace(/^plugin:[^:]+:/, '');
    let res = await mcpInitialize(spec, { spawn, env: ctx.env, timeoutMs, run: ctx.run });
    if (!res.ok && res.reason === 'timeout') {
      // 느린 PC 의 첫 기동(파이썬 venv·node 첫 로드, Defender 검사)은 두 번째가 훨씬 빠르다.
      res = await mcpInitialize(spec, { spawn, env: ctx.env, timeoutMs, run: ctx.run });
    }
    let status = res.ok ? 'pass' : 'fail';
    let why = res.ok ? '응답함' : (res.detail ?? res.reason);
    // 2026-09-17 VM S01 6차 실측: 한도를 60초로 늘리자 한컴·오피스가 **없는** 손님에서도
    // hwp/ppt/word 서버가 initialize 에 답해 `pass` 가 됐다. 서버가 뜨는 것과 그 프로그램이
    // 있는 것은 다른 일이다 — 이 PC 에 그 프로그램이 없으면 답을 했든 못 했든 `pending`
    // (사람에게 "한컴을 깔면 바로 쓴다"를 알리는 것이 이 항목의 뜻, 머리말 참조).
    if (bare in DOCUMENT_MCP_APPS) {
      const app = DOCUMENT_MCP_APPS[bare];
      if (app && apps[app] === false) {
        status = 'pending';
        why = app === 'hancom' ? '한컴오피스(한글)가 없어 대기' : '마이크로소프트 오피스가 없어 대기';
      }
    }
    results.push({ name: spec.name, status, detail: why });
  }
  const fail = results.filter((r) => r.status === 'fail');
  const pendingList = results.filter((r) => r.status === 'pending');
  const claudeCount = servers.filter((s) => s.source === 'claude').length;
  const countNote = claudeCount === EXPECTED_CLAUDE_MCP_COUNT
    ? ''
    : ` (클로드 명시 등록 ${claudeCount}개 — 기대값 ${EXPECTED_CLAUDE_MCP_COUNT}개)`;
  const detail = `${results.length}개 중 통과 ${results.length - fail.length - pendingList.length}개`
    + `${pendingList.length ? ` · 대기 ${pendingList.length}개(${pendingList.map((r) => `${r.name}: ${r.detail}`).join(' / ')})` : ''}`
    + `${fail.length ? ` · 실패 ${fail.length}개(${fail.map((r) => `${r.name}: ${r.detail}`).join(' / ')})` : ''}`
    + countNote
    + ' · 브라우저 조작(playwright)은 뜨는지만 확인하고 실제 화면 열기는 하지 않습니다.';
  const status = fail.length ? 'fail' : (pendingList.length ? 'pending' : 'pass');
  return item('mcp', 2, 'MCP 서버 initialize 응답', status, detail, { results });
}

// ---------------------------------------------------------------------------
// 검사 3 — 플러그인 경로 해석·스킬 로드
// ---------------------------------------------------------------------------

export function checkPlugins(ctx) {
  const fs = fsOf(ctx);
  const root = ctx.root;
  const file = path.join(root, '_agent', 'claude', 'plugins', 'installed_plugins.json');
  const data = readJson(fs, file);
  if (!data) {
    return item('plugins', 3, '플러그인 경로 해석·스킬 로드', 'fail', '설치된 플러그인 목록(installed_plugins.json)을 읽지 못했습니다.');
  }
  const results = [];
  for (const [key, entries] of Object.entries(data.plugins ?? {})) {
    const first = Array.isArray(entries) ? entries[0] : null;
    const dir = first?.installPath;
    if (!dir || !exists(fs, dir)) {
      results.push({ name: key, ok: false, why: '설치 폴더가 없습니다' });
      continue;
    }
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
    if (exists(fs, manifest)) {
      results.push({ name: key, ok: Boolean(readJson(fs, manifest)), why: readJson(fs, manifest) ? '표지 파일 정상' : '표지 파일을 읽지 못했습니다' });
      continue;
    }
    // 표지 파일이 없는 스킬 묶음은 SKILL 파일이 하나라도 있으면 로드된다.
    const skills = hasSkillFiles(fs, dir);
    results.push({ name: key, ok: skills, why: skills ? '스킬 파일 확인' : '표지 파일도 스킬 파일도 없습니다' });
  }
  if (!results.length) {
    return item('plugins', 3, '플러그인 경로 해석·스킬 로드', 'fail', '등록된 플러그인이 하나도 없습니다.');
  }
  const bad = results.filter((r) => !r.ok);
  const detail = bad.length
    ? `${bad.length}개 문제: ${bad.map((r) => `${r.name}(${r.why})`).join(', ')}`
    : `${results.length}개 전부 정상(${results.map((r) => r.name.split('@')[0]).join(', ')})`;
  return item('plugins', 3, '플러그인 경로 해석·스킬 로드', bad.length ? 'fail' : 'pass', detail, { results });
}

function hasSkillFiles(fs, dir, depth = 0) {
  if (depth > 3) return false;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && /^SKILL\.md$/i.test(e.name)) return true;
    if (e.isDirectory() && hasSkillFiles(fs, path.join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 검사 4 — 훅 스크립트 3개 문법
// ---------------------------------------------------------------------------

// 파워셸 문법 검사. 스크립트를 **실행하지 않고** 파서에만 통과시킨다
// (`Parser::ParseFile`) — 가드 훅을 검사한다고 실제로 가드가 돌면 안 된다.
export function psSyntaxCommand(file) {
  return '$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('
    + `'${String(file).replace(/'/g, "''")}'`
    + ', [ref]$null, [ref]$e); if ($e -and $e.Count -gt 0) { $e[0].Message; exit 1 }';
}

export async function checkHooks(ctx) {
  const fs = fsOf(ctx);
  const root = ctx.root;
  const python = resolveExe(ctx, 'python').path;
  const results = [];
  for (const spec of HOOK_FILES) {
    const file = path.join(root, ...spec.rel);
    const name = spec.rel[spec.rel.length - 1];
    if (!exists(fs, file)) {
      results.push({ name, ok: false, why: '파일이 없습니다' });
      continue;
    }
    if (spec.kind === 'ps1') {
      const res = await runExe(ctx, 'powershell', ['-NoProfile', '-Command', psSyntaxCommand(file)], { timeoutMs: SYNTAX_TIMEOUT_MS });
      results.push({ name, ok: res.code === 0, why: res.code === 0 ? '문법 정상' : (res.code === null ? `검사 시간 초과(${SYNTAX_TIMEOUT_MS / 1000}초, 파워셸이 답하지 않음)` : `문법 오류(${String(res.out || res.err).slice(0, 120)})`) });
    } else {
      const res = await runExe(ctx, python, ['-m', 'py_compile', file], { timeoutMs: SYNTAX_TIMEOUT_MS });
      results.push({ name, ok: res.code === 0, why: res.code === 0 ? '문법 정상' : (res.code === null ? `검사 시간 초과(${SYNTAX_TIMEOUT_MS / 1000}초)` : `문법 오류(${String(res.err || res.out).slice(0, 120)})`) });
    }
  }
  const bad = results.filter((r) => !r.ok);
  const detail = bad.length
    ? `${bad.length}개 문제: ${bad.map((r) => `${r.name}(${r.why})`).join(', ')}`
    : `${results.length}개 전부 문법 정상`;
  return item('hooks', 4, '훅 스크립트 문법 검사', bad.length ? 'fail' : 'pass', detail, { results });
}

// ---------------------------------------------------------------------------
// 검사 5 — 설정 파일 JSON·TOML 파싱
// ---------------------------------------------------------------------------

/**
 * tomlSanity — 작은 TOML 성한지 보기.
 *
 * 온전한 TOML 파서를 넣지 않는 이유: 우리가 쓰는 config.toml 은 `[표]` 와
 * `키 = 값` 뿐이라, 실제로 깨지는 방식도 두 가지뿐이다.
 *   ① 표 머리가 닫히지 않았다(`[mcp_servers.hwp`)
 *   ② 같은 표를 두 번 적었다(`[mcp_servers.x]` 두 줄) — 병합이 잘못되면 이렇게 된다
 * 이 둘만 잡으면 "코덱스가 설정을 읽다 죽는" 경우는 사실상 다 걸린다.
 */
export function tomlSanity(text) {
  const problems = [];
  const seen = new Map();
  const lines = String(text).split(/\r?\n/);
  let inMultiline = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const quotes = (line.match(/"""/g) ?? []).length;
    if (quotes % 2 === 1) inMultiline = !inMultiline;
    if (inMultiline) return;
    if (!line.startsWith('[')) return;
    if (!/^\[\[?[^\][]+\]\]?$/.test(line)) {
      problems.push(`${i + 1}줄: 표 머리가 온전하지 않습니다 (${line.slice(0, 40)})`);
      return;
    }
    if (line.startsWith('[[')) return; // 배열 표는 중복이 정상이다
    const name = line.replace(/^\[|\]$/g, '').trim();
    if (seen.has(name)) problems.push(`[${name}] 표가 ${seen.get(name)}줄과 ${i + 1}줄에 두 번 있습니다`);
    else seen.set(name, i + 1);
  });
  return { ok: problems.length === 0, problems, tables: [...seen.keys()] };
}

export function checkConfig(ctx) {
  const fs = fsOf(ctx);
  const root = ctx.root;
  const results = [];
  for (const rel of [['_agent', 'claude', 'settings.json'], ['_agent', 'claude', '.claude.json']]) {
    const file = path.join(root, ...rel);
    const name = rel[rel.length - 1];
    if (!exists(fs, file)) { results.push({ name, ok: false, why: '파일이 없습니다' }); continue; }
    const data = readJson(fs, file);
    results.push({ name, ok: Boolean(data) && typeof data === 'object', why: data ? 'JSON 정상' : 'JSON 을 읽지 못했습니다' });
  }
  const toml = path.join(root, '_agent', 'codex', 'config.toml');
  if (!exists(fs, toml)) {
    results.push({ name: 'config.toml', ok: false, why: '파일이 없습니다' });
  } else {
    let text = '';
    try { text = fs.readFileSync(toml, 'utf8'); } catch (e) { text = ''; }
    const s = tomlSanity(text);
    results.push({ name: 'config.toml', ok: s.ok, why: s.ok ? `TOML 정상(표 ${s.tables.length}개)` : s.problems.join(' / ') });
  }
  const bad = results.filter((r) => !r.ok);
  const detail = bad.length
    ? bad.map((r) => `${r.name}: ${r.why}`).join(' / ')
    : results.map((r) => `${r.name} ${r.why}`).join(' · ');
  return item('config', 5, '설정 파일 JSON·TOML 파싱', bad.length ? 'fail' : 'pass', detail, { results });
}

// ---------------------------------------------------------------------------
// 검사 6 — 바탕화면 쓰기 0건 · 루트 밖 쓰기 없음
// ---------------------------------------------------------------------------

export async function resolveDesktopDir(ctx, { desktopDir = null } = {}) {
  if (desktopDir) return desktopDir;
  if (ctx.desktopDir) return ctx.desktopDir;
  // 15초는 느린 PC 의 파워셸 기동에 모자랐다(2026-09-16 VM S01: "바탕화면 경로를 찾지 못해 목록 검사만 함").
  const res = await runExe(ctx, 'powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { timeoutMs: SYNTAX_TIMEOUT_MS });
  const line = String(res.out ?? '').trim().split(/\r?\n/)[0] ?? '';
  return line || null;
}

// 설치가 시작된 시각. 이 시각보다 **새로운** 바탕화면 파일만 우리가 만들었을
// 수 있는 것이다(그 전 파일은 원래 그 사람 것).
export function installStartedAt(receipt) {
  const candidates = [receipt?.createdAt, receipt?.precheck?.at];
  for (const id2 of SETUP_STAGE_IDS) {
    const t = receipt?.setup?.[id2]?.startedAt;
    if (t) candidates.push(t);
  }
  const times = candidates
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((n) => Number.isFinite(n));
  if (!times.length) return Date.now() - 6 * 60 * 60 * 1000; // 모르면 최근 6시간만 본다
  return Math.min(...times);
}

// 동기화 클라이언트가 바탕화면에 잠깐 만드는 임시 파일 — 우리가 만든 것이 아니다.
// 2026-09-18 실사용: 바탕화면이 Google Drive 로 동기화되는 PC 에서 우리가 놓은
// IRIS.lnk 를 Drive 가 올리는 동안 `.tmp.driveupload` 가 생겨 검사 6 이 실패했다.
// Drive(.tmp.driveupload/.tmp.drivedownload) · OneDrive/Office 잠금(~$…, *.tmp, *.partial)
// · LibreOffice(.~lock.*) · 탐색기 캐시(Thumbs.db) · macOS 동기화 잔재(.DS_Store).
export const SYNC_SCRATCH_RE = /^(\.tmp\.drive(upload|download)|~\$.*|.*\.tmp|.*\.partial|\.~lock\..*|thumbs\.db|\.ds_store)$/i;

// 윈도가 스스로 바탕화면에 놓는 바로가기 — 우리가 만든 것이 아니다.
// 2026-09-18 VM S02(Windows 10 22H2) 실측: 설치 도중 엣지 업데이트기가 `Microsoft Edge.lnk` 를
// 바탕화면에 만들어 검사 6 이 "허용되지 않은 새 항목 1개" 로 실패했다(IRIS 는 엣지를 열지 않는다,
// 검사 9 는 있는지만 본다). 목록은 실측된 것만 넣는다 — 넓히면 진짜 이탈을 가린다.
export const OS_DESKTOP_ITEMS_RE = /^(Microsoft Edge)\.lnk$/i;

export async function checkDesktop(ctx, opts = {}) {
  const fs = fsOf(ctx);
  const root = ctx.root;
  const since = installStartedAt(ctx.receipt);
  const dir = await resolveDesktopDir(ctx, opts);
  const allowed = allowedDesktopFiles(root);
  const strays = [];
  if (dir && exists(fs, dir)) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries) {
      if (allowed.some((a) => a.toLowerCase() === e.name.toLowerCase())) continue;
      if (SYNC_SCRATCH_RE.test(e.name)) continue;
      if (OS_DESKTOP_ITEMS_RE.test(e.name)) continue;
      const full = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      // 1초 여유: 파일 시각의 해상도와 시계 오차 때문에 설치 직전 파일이
      // 설치 뒤로 보이는 일이 있다.
      if (st.mtimeMs > since + 1000) strays.push({ name: e.name, at: new Date(st.mtimeMs).toISOString() });
    }
  }

  // 루트 밖 쓰기 감사 — 각 단계가 남긴 파일 목록이 전부 루트 안인가.
  //
  // 꾸러미(zip) 안 경로는 뺀다. 단계들은 "어디에서 가져왔는가"도 기록에 남기는데
  // (예: venv 가 쓴 바퀴 파일의 원본), 그것은 **읽은 곳**이지 쓴 곳이 아니다.
  // 이 구분을 안 하면 정상 설치가 늘 "루트 밖 쓰기"로 잡힌다(2026-09-15 실측).
  const outside = [];
  const rootLower = path.resolve(root).toLowerCase();
  const zipRoots = [ctx.zipRoot, ctx.payloadDir, ctx.payloadDir ? path.dirname(ctx.payloadDir) : null]
    .filter(Boolean)
    .map((p) => path.resolve(p).toLowerCase());
  // 2026-09-20(2.0.31, verify/upgrade.mjs 실측): 「업데이트」는 옛 설치의 단계 기록을 그대로 물려받는데, venv 가
  // 적어 둔 바퀴 원본(`pyyamlWheel`)은 **옛 zip 이 있던 자리**(보통 Downloads)라 이번 zipRoot 밖이다 → 검사를
  // 다시 돌리는 업데이트에서 "IRIS 폴더 밖 쓰기"로 오판. 잠금표 부품의 파일 이름(어느 판 zip 에서 왔든 같은
  // 이름)과 일치하면 읽은 곳으로 본다.
  const partFiles = new Set(Object.values(ctx.lock?.parts ?? {})
    .map((p) => (typeof p?.file === 'string' ? path.basename(p.file).toLowerCase() : null)).filter(Boolean));
  const fromPackage = (abs) => zipRoots.some((z) => abs.toLowerCase().startsWith(z))
    || (partFiles.size > 0 && partFiles.has(path.basename(abs).toLowerCase()));
  // 2026-09-17 VM S06 실측: relay 단계가 기록한 바탕화면 바로가기(`..\Users\<계정>\Desktop\IRIS.lnk`)가
  // "IRIS 폴더 밖 쓰기 2건"으로 잡혀 검사 6이 실패했다. 바탕화면의 IRIS 바로가기는 이 검사가
  // 위에서 이미 **허용한** 바로 그 파일이다 — 단, **이 사용자의** 바탕화면(찾아낸 바탕화면 폴더,
  // 또는 이 사용자 프로필 아래)에 놓인 것만이다. 다른 사용자 프로필에 쓴 것은 여전히 잘못이다.
  // 같은 경로가 두 번 기록돼도 한 건이다.
  const homeLower = (() => {
    const h = ctx.env?.USERPROFILE ?? process.env.USERPROFILE ?? '';
    return h ? path.resolve(h).toLowerCase() : null;
  })();
  const dirLower = dir ? path.resolve(dir).toLowerCase() : null;
  const isAllowedShortcut = (abs) => {
    const lower = abs.toLowerCase();
    if (!allowed.some((a) => a.toLowerCase() === path.basename(abs).toLowerCase())) return false;
    if (dirLower && lower.startsWith(dirLower)) return true;
    return Boolean(homeLower && lower.startsWith(homeLower) && /[\\/]desktop[\\/]/i.test(abs));
  };
  const seenOutside = new Set();
  for (const stageId of SETUP_STAGE_IDS) {
    for (const p of recordedPaths(ctx.receipt?.setup?.[stageId]?.recorded)) {
      const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
      if (abs.toLowerCase().startsWith(rootLower) || fromPackage(abs) || isAllowedShortcut(abs)) continue;
      const key = `${stageId}:${abs.toLowerCase()}`;
      if (seenOutside.has(key)) continue;
      seenOutside.add(key);
      outside.push({ stage: stageId, path: relOf(root, p) });
    }
  }

  const problems = [];
  if (strays.length) problems.push(`바탕화면에 허용되지 않은 새 항목 ${strays.length}개(${strays.map((s) => s.name).join(', ')})`);
  if (outside.length) problems.push(`IRIS 폴더 밖 쓰기 ${outside.length}건(${outside.slice(0, 3).map((o) => `${o.stage}:${o.path}`).join(', ')})`);
  const detail = problems.length
    ? problems.join(' / ')
    : `바탕화면 새 항목 0건(허용: ${allowed[0]}) · 단계가 남긴 경로 전부 IRIS 폴더 안${dir ? '' : ' (바탕화면 경로를 찾지 못해 목록 검사만 함)'}`;
  return item('desktop', 6, '바탕화면 쓰기 0건·폴더 밖 쓰기 없음', problems.length ? 'fail' : 'pass', detail, { strays, outside, desktop: Boolean(dir) });
}

// recorded 안에 흩어져 있는 "경로처럼 보이는 문자열"을 모은다. 단계마다 모양이
// 달라도(files.created·dirs.created·created·skipped…) 같은 잣대로 감사하려면
// 한 번은 훑어야 한다. 깊이를 4로 막아 큰 기록에서도 금방 끝난다.
export function recordedPaths(recorded, depth = 0, out = []) {
  if (depth > 4 || recorded == null) return out;
  if (typeof recorded === 'string') {
    if (/[\\/]/.test(recorded) && !/^https?:/i.test(recorded)) out.push(recorded);
    return out;
  }
  if (Array.isArray(recorded)) {
    for (const v of recorded) recordedPaths(v, depth + 1, out);
    return out;
  }
  if (typeof recorded === 'object') {
    for (const [k, v] of Object.entries(recorded)) {
      if (k === 'source' || k === 'from' || k === 'cause') continue; // 원본(zip 안) 경로는 감사 대상이 아니다
      recordedPaths(v, depth + 1, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 검사 7 — 그래프 신선도 · 카드 ID 중복 0
// ---------------------------------------------------------------------------

const CARD_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const CARD_ID_RE = /\bid:\s*['"]?([^'",}\s]+)['"]?/;
const CARD_SKIP_DIRS = new Set(['_agent', '_ontology', '_trash', '_cleanup', '_backup', '_document-templates', 'node_modules', '.git']);

export function scanCardIds(fs, root) {
  const ids = new Map();
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || CARD_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const sub = path.join(dir, e.name);
      const card = path.join(sub, 'AGENTS.md');
      if (exists(fs, card)) {
        let text = '';
        try { text = fs.readFileSync(card, 'utf8'); } catch { text = ''; }
        const m = CARD_FRONTMATTER_RE.exec(text);
        const idm = m ? CARD_ID_RE.exec(m[1]) : null;
        if (idm) {
          const list = ids.get(idm[1]) ?? [];
          list.push(relOf(root, card));
          ids.set(idm[1], list);
        }
      }
      walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  return ids;
}

export function checkOntology(ctx) {
  const fs = fsOf(ctx);
  const root = ctx.root;
  const recorded = ctx.receipt?.setup?.ontology?.recorded ?? {};
  const fresh = (recorded.commands ?? []).find((c) => String(c.script ?? '').includes('check_fresh'));
  const freshOk = fresh ? fresh.code === 0 : null;

  const ids = scanCardIds(fs, root);
  const dupes = [...ids.entries()].filter(([, files]) => files.length > 1);

  const problems = [];
  if (freshOk === false) problems.push(`그래프 신선도 확인 실패(종료 코드 ${fresh.code})`);
  if (freshOk === null) problems.push('그래프 신선도 확인 기록이 없습니다');
  if (dupes.length) problems.push(`카드 ID 중복 ${dupes.length}건(${dupes.slice(0, 3).map(([k, v]) => `${k}: ${v.join(' · ')}`).join(', ')})`);

  const detail = problems.length
    ? problems.join(' / ')
    : `그래프 신선도 통과 · 카드 ${ids.size}장 ID 중복 0건`;
  return item('ontology', 7, '그래프 신선도·카드 ID 중복', problems.length ? 'fail' : 'pass', detail, { cards: ids.size, dupes: dupes.length });
}

// ---------------------------------------------------------------------------
// 검사 8 — 영수증 두 번 읽고 써도 같다
// ---------------------------------------------------------------------------

export function checkReceiptIdempotent(ctx) {
  const fs = fsOf(ctx);
  const root = ctx.root;
  const file = receiptPath(root);
  if (!exists(fs, file)) {
    return item('receipt', 8, '영수증 읽기·쓰기 멱등', 'fail', '영수증 파일을 찾지 못했습니다.');
  }
  const probe = path.join(root, '_agent', 'setup', 'receipt-idempotence.check');
  try {
    const first = JSON.parse(fs.readFileSync(file, 'utf8'));
    const text = `${JSON.stringify(first, null, 2)}`;
    fs.writeFileSync(probe, text, 'utf8');
    const second = JSON.parse(fs.readFileSync(probe, 'utf8'));
    const same = JSON.stringify(second) === JSON.stringify(first);
    return item('receipt', 8, '영수증 읽기·쓰기 멱등', same ? 'pass' : 'fail',
      same ? '읽고 다시 써도 같은 내용입니다' : '읽고 다시 쓰면 내용이 달라집니다');
  } catch (e) {
    return item('receipt', 8, '영수증 읽기·쓰기 멱등', 'fail', `영수증을 읽고 쓰는 중 오류: ${String(e?.message ?? e)}`);
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// 검사 9 — 엣지 존재
// ---------------------------------------------------------------------------

export function checkEdge(ctx) {
  const pre = ctx?.precheck?.recorded ?? ctx?.precheck ?? {};
  const present = pre?.edge?.present;
  if (present === true) {
    return item('edge', 9, '엣지 브라우저(브라우저 조작)', 'pass', '엣지가 있어 브라우저 조작을 바로 쓸 수 있습니다.');
  }
  return item('edge', 9, '엣지 브라우저(브라우저 조작)', 'pending',
    present === false
      ? '엣지를 찾지 못했습니다 — 브라우저 조작 기능은 엣지를 설치하면 켜집니다.'
      : '엣지 유무를 확인하지 못했습니다 — 브라우저 조작 기능은 대기로 둡니다.',
    { pendingCapability: { capability: '브라우저 조작(Playwright)', reason: '엣지 브라우저를 찾지 못함', howToEnable: '엣지를 설치하면 자동으로 켜집니다' } });
}

// ---------------------------------------------------------------------------
// 검사 10·11 — 앞 단계가 남긴 "못 한 것" (인계 사항)
// ---------------------------------------------------------------------------

export function checkSkeleton(ctx) {
  const recorded = ctx.receipt?.setup?.skeleton?.recorded ?? {};
  const blocked = recorded.blocked ?? [];
  const missing = recorded.missing ?? [];
  if (blocked.length) {
    return item('skeleton', 10, '영혼 뼈대 빠짐 없음', 'fail',
      `정션(다른 곳을 가리키는 연결) 때문에 만들지 못한 자리 ${blocked.length}곳: ${blocked.slice(0, 3).map((b) => b.what).join(', ')}`,
      { blocked, missing });
  }
  if (missing.length) {
    return item('skeleton', 10, '영혼 뼈대 빠짐 없음', 'pending',
      `꾸러미에 없어 만들지 못한 것 ${missing.length}개: ${missing.slice(0, 3).map((m) => m.what).join(', ')}`,
      { blocked, missing, pendingCapability: { capability: '뼈대 파일 일부', reason: `꾸러미에 없던 파일 ${missing.length}개`, howToEnable: '다음 판으로 다시 설치하면 함께 들어옵니다' } });
  }
  return item('skeleton', 10, '영혼 뼈대 빠짐 없음', 'pass', '뼈대 파일·폴더를 전부 만들었습니다.');
}

export function checkStructure(ctx) {
  const conflicts = ctx.receipt?.setup?.structure?.recorded?.conflicts ?? [];
  const reparse = conflicts.filter((c) => c.reason === 'reparse-point');
  const others = conflicts.filter((c) => c.reason !== 'reparse-point');
  if (reparse.length) {
    return item('structure', 11, '작업 폴더 충돌 없음', 'fail',
      `정션 때문에 만들지 못한 작업 폴더 ${reparse.length}개: ${reparse.map((c) => c.wanted).join(', ')}`,
      { conflicts });
  }
  if (others.length) {
    return item('structure', 11, '작업 폴더 충돌 없음', 'pending',
      `이미 같은 번호를 쓰는 폴더가 있어 만들지 않은 것 ${others.length}개: ${others.map((c) => `${c.wanted}(${c.existing ?? c.reason})`).join(', ')}`,
      { conflicts, pendingCapability: { capability: '작업 폴더 일부', reason: `번호가 겹쳐 만들지 않은 폴더 ${others.length}개`, howToEnable: 'IRIS 창에서 이름을 정한 뒤 다시 만들 수 있습니다' } });
  }
  return item('structure', 11, '작업 폴더 충돌 없음', 'pass', '요청한 작업 폴더를 전부 만들었거나 이미 있었습니다.');
}

// ---------------------------------------------------------------------------
// 12. 중계기 경유 — 클로드 세션이 정말 TeamClaude(3456)를 거치는가
// ---------------------------------------------------------------------------
//
// 2026-09-18 네 번째 실제 PC: 설치는 11/11 통과, 대시보드에 계정도 보이는데 세션을
// 써도 활동이 0 — 중계기에는 ChatGPT/코덱스 계정만 있었고 클로드 세션은 자기
// 로그인 계정으로 직행했다. 검사 1~11 은 "부품이 있는가"만 보고 **길이 이어졌는가**는
// 아무도 보지 않았다. 이 검사는 네 곳의 배선과 실제 요청 한 건으로 그 길을 잰다.
//
//   ⓐ 배선 4곳: 영수증 env · 사용자 환경변수(HKCU) · claude.cmd 심 · 소환하기.cmd 가
//      전부 RELAY_BASE_URL 을 가리킨다(하나라도 다르면 그 길로 연 세션은 직행한다).
//   ⓑ 중계기 응답 + 공급자별 계정 수(/teamclaude/status 의 provider).
//   ⓒ 클로드 계정 0 이면: 중계기는 클로드 요청을 합성 429 로 막는다(직행시키지 않는다).
//      그러니 "클로드 세션이 되는데 대시보드에 안 뜬다"는 ⓐ 가 새는 것이다.
//   ⓓ 살아 있는 요청 1건: 중계기로 max_tokens 1 짜리 메시지를 보내 200 이 오면
//      "심 → 중계기 → 계정 → 업스트림" 이 실제로 이어진 것(대시보드 활동에도 찍힌다).
//      토큰 자리에는 가짜 값을 둔다 — 중계기가 계정 토큰을 넣지 않으면 401 이 돌아와
//      그 자체가 증거가 된다. 클로드 계정이 없으면 ⓓ 는 건너뛴다.
export const RELAY_ROUTE_URL = 'http://127.0.0.1:3456';
export const RELAY_PROBE_MODEL = 'claude-haiku-4-5-20251001';

function accountsByProvider(status) {
  const out = { anthropic: 0, codex: 0, other: 0 };
  for (const a of Array.isArray(status?.accounts) ? status.accounts : []) {
    const p = String(a?.provider ?? '').toLowerCase();
    if (p === 'anthropic' || p === 'claude') out.anthropic += 1;
    else if (p === 'codex' || p === 'openai') out.codex += 1;
    else out.other += 1;
  }
  return out;
}

export async function checkRelayRoute(ctx, {
  // IRIS_INSTALLER_OFFLINE=1(연습·검사 실행)에서는 127.0.0.1:3456 도 두드리지 않는다 — 이 개발 PC 처럼 진짜
  // 중계기가 살아 있으면 연습용 루트의 검사가 남의 중계기를 재고 CA 를 만들라 해서 '실패'로 굴렀다(2.0.31,
  // verify/upgrade.mjs 도입 때 실측). 진짜 설치에서는 그대로(중계기가 없으면 pending, ⑦ 뒤 재측정).
  fetchImpl = process.env.IRIS_INSTALLER_OFFLINE === '1' ? null : (ctx?.fetch ?? globalThis.fetch),
  readUserEnvFn = ctx?.readUserEnv ?? readUserEnv,
  baseUrl = RELAY_ROUTE_URL,
  timeoutMs = 4000,
  probeTimeoutMs = 25000,
} = {}) {
  const fs = fsOf(ctx);
  const root = ctx.root;
  const problems = [];
  const notes = [];
  const wiring = {};

  // ⓐ 배선
  const receiptUrl = ctx.receipt?.env?.ANTHROPIC_BASE_URL ?? null;
  wiring.receipt = receiptUrl;
  if (receiptUrl !== baseUrl) problems.push(`영수증 env.ANTHROPIC_BASE_URL=${receiptUrl ?? '없음'}`);

  const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  const setLine = `ANTHROPIC_BASE_URL=${baseUrl}`;
  const shim = readText(shimPath(root, 'claude.cmd'));
  // 신규 설치의 ⑥ 시점에는 claude.cmd 심이 **아직 없는 게 정상**이다: claude CLI 는 ⑦(온라인)에서
  // 내려받고, env 단계는 그때까지 심을 미루며 receipt 에 claudeShim.written=false 로 적는다
  // (2026-09-18 다섯 번째 실제 PC: 2.0.17 신규 설치가 이 검사의 「심이 없음」으로 ⑥ 에서 막힘 —
  // 2.0.16 부터 모든 신규 설치가 그랬고, 업데이트 설치만 옛 심이 있어 지나갔다). 미룬 심은 대기.
  const claudeShimDeferred = [ctx.receipt?.setup?.env?.recorded, ctx.receipt?.setup?.unpack?.recorded]
    .some((r) => r?.claudeShim?.written === false);
  const claudeCliPresent = (() => { try { return fs.existsSync(path.join(root, '_agent', 'shared', 'tools', 'claude', 'claude.cmd')); } catch { return false; } })();
  if (shim == null) {
    if (claudeShimDeferred || !claudeCliPresent) {
      wiring.shim = 'deferred';
      notes.push('claude.cmd 심은 ⑦ 계정 연결에서 claude 를 내려받은 뒤 만들어집니다 — 그때 다시 잽니다');
    } else {
      wiring.shim = null;
      problems.push('claude.cmd 심이 없음');
    }
  } else {
    wiring.shim = shim.includes(setLine);
    if (!shim.includes(setLine)) problems.push('claude.cmd 심에 중계기 주소가 없음');
  }

  const summon = readText(path.join(root, '소환하기.cmd'));
  wiring.summon = summon == null ? null : summon.includes(setLine);
  if (summon == null) problems.push('소환하기.cmd 가 없음');
  else if (!summon.includes(setLine)) problems.push('소환하기.cmd 에 중계기 주소가 없음');

  if (ctx.receipt?.env?.applied === false) {
    wiring.userEnv = 'skipped';
    notes.push('사용자 환경변수는 연습(no-user-env)이라 기록만');
  } else {
    let hk = null;
    try {
      const r = await readUserEnvFn('ANTHROPIC_BASE_URL');   // userpath.readUserEnv → { exists, type, value }
      hk = r && typeof r === 'object' ? (r.exists ? r.value : null) : (typeof r === 'string' ? r : null);
    } catch { hk = null; }
    wiring.userEnv = hk;
    if (hk !== baseUrl) problems.push(`사용자 환경변수 ANTHROPIC_BASE_URL=${hk ?? '없음'}`);
  }

  // ⓑ 중계기 + 계정
  let relay = { up: false, status: null, accounts: null };
  if (typeof fetchImpl === 'function') {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetchImpl(`${baseUrl}/teamclaude/status`, { signal: ac.signal });
      clearTimeout(t);
      const j = r.ok ? await r.json().catch(() => null) : null;
      relay = { up: r.ok && j && typeof j === 'object', status: r.status, accounts: j ? accountsByProvider(j) : null };
    } catch {
      relay = { up: false, status: null, accounts: null };
    }
  }

  const wantsClaude = Array.isArray(ctx.choice?.subscriptions) ? ctx.choice.subscriptions.includes('claude') : true;
  let probe = null;
  if (!relay.up) {
    notes.push('중계기가 응답하지 않음(⑦ 계정 연결 뒤 시작됨) — 살아 있는 요청은 다음에');
  } else if (relay.accounts.anthropic === 0) {
    const s = `중계기에 클로드 계정 0개(코덱스 ${relay.accounts.codex}개) — 클로드 세션은 중계기가 429 로 막으므로 대시보드에 클로드 활동이 없는 게 정상입니다. 클로드 계정을 쓰려면 IRIS 창 ⑦ 계정 연결에서 claude.ai 로그인을 추가하세요`;
    if (wantsClaude) problems.push(s); else notes.push(s);
  } else {
    // ⓓ 살아 있는 요청
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), probeTimeoutMs);
      const r = await fetchImpl(`${baseUrl}/v1/messages`, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          authorization: 'Bearer iris-route-check',
        },
        body: JSON.stringify({ model: RELAY_PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      clearTimeout(t);
      const text = await r.text().catch(() => '');
      let msg = '';
      try { msg = JSON.parse(text)?.error?.message ?? ''; } catch { msg = text.slice(0, 160); }
      probe = { status: r.status, ok: r.ok, message: String(msg).slice(0, 200) };
    } catch (e) {
      probe = { status: null, ok: false, message: String(e?.message ?? e).slice(0, 200) };
    }
    if (!probe.ok) {
      const why = probe.status === 401 ? '중계기가 계정 토큰을 넣지 않고 그대로 넘겼습니다(401)'
        : probe.status === 429 ? `중계기가 요청을 막았습니다(429: ${probe.message})`
        : probe.status ? `업스트림 응답 ${probe.status}: ${probe.message}`
        : `요청이 끝나지 않았습니다: ${probe.message}`;
      problems.push(`살아 있는 요청 실패 — ${why}`);
    }
  }

  // 코덱스만 고른 설치는 클로드 계정 0 이 정상이다 — 배선이 맞고 중계기가 살아 있으면
  // 통과(설계 A' 2026-09-18). 클로드도 고른 설치에서 계정 0 은 위에서 이미 problems.
  const status = problems.length ? 'fail' : (relay.up ? 'pass' : 'pending');
  const detailParts = [];
  detailParts.push(problems.length ? `배선·경유 문제 ${problems.length}건: ${problems.join(' / ')}` : '배선 4곳 모두 중계기(3456)를 가리킴');
  if (relay.up) detailParts.push(`중계기 응답 OK(클로드 ${relay.accounts.anthropic}·코덱스 ${relay.accounts.codex})`);
  if (probe?.ok) detailParts.push(`살아 있는 요청 1건 통과(${RELAY_PROBE_MODEL}, ${probe.status}) — 대시보드 활동에 찍힘`);
  if (notes.length) detailParts.push(notes.join(' · '));
  return item('relay', 12, '중계기 경유(클로드 세션 → TeamClaude)', status, detailParts.join(' · '), { wiring, relay, probe });
}

// ---------------------------------------------------------------------------
// 13. 중계기 경유(코덱스) — 코덱스 세션이 TeamClaude 의 MITM 프록시를 거치는가
// ---------------------------------------------------------------------------
//
// 설계 A'(2026-09-18, 사용자 확정). TeamClaude 는 코덱스를 base-URL 로 받지 못하고
// 전달 프록시(MITM) 방식으로만 중계한다: 코덱스 심이 HTTPS_PROXY 를 중계기로 두고,
// 중계기의 CA 를 담은 번들을 SSL_CERT_FILE 로 넘긴다. 이 검사는 그 길을 잰다.
//
//   ⓐ 배선: codex.cmd 심에 CODEX_PROXY_LINES 세 줄이 그대로 있는가.
//   ⓑ 중계기 응답 + 코덱스 계정 수(/teamclaude/status).
//   ⓒ 가로채기 실측: 내장 시험 호스트(www.example.org)로 CONNECT → TLS → 200 +
//      `mitm-proxy-ok`. CA 가 아직 없으면 첫 CONNECT 가 만들게 하고(지연 생성) 그 CA 로
//      다시 검증한다. 계정·토큰 없이도 "프록시 + CA" 가 이어졌는지 증명한다.
//   ⓓ CA 번들(공인 루트 + TeamClaude CA)을 만들거나 갱신한다 — 코덱스 심이 가리키는 파일.
//   코덱스 계정 0 이면: 코덱스를 골랐으면 실패(⑦ 에서 ChatGPT 로그인), 아니면 기록만.
//   코덱스를 고르지 않은 설치는 심이 없으니 "해당 없음" 으로 통과.
export const RELAY_MITM_TEST_HOST = MITM_TEST_HOST;

export async function checkRelayCodex(ctx, {
  // 검사 12 와 같은 이유(IRIS_INSTALLER_OFFLINE=1 이면 살아 있는 중계기를 두드리지 않는다, 2.0.31).
  fetchImpl = process.env.IRIS_INSTALLER_OFFLINE === '1' ? null : (ctx?.fetch ?? globalThis.fetch),
  mitmProbeImpl = ctx?.mitmProbe ?? mitmProbe,
  writeBundleImpl = ctx?.writeCaBundle ?? writeCaBundle,
  baseUrl = RELAY_ROUTE_URL,
  timeoutMs = 4000,
} = {}) {
  const fs = fsOf(ctx);
  const root = ctx.root;
  const problems = [];
  const notes = [];
  // 구독 선택값은 UI·server 가 'chatgpt' 로 넘긴다(install.mjs activeAgents 도 'chatgpt'); 'codex' 도 받아 둔다.
  const wantsCodex = Array.isArray(ctx.choice?.subscriptions)
    ? ctx.choice.subscriptions.some((s) => s === 'codex' || s === 'chatgpt') : false;
  const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

  if (!wantsCodex) {
    return item('relayCodex', 13, '중계기 경유(코덱스 세션 → TeamClaude)', 'pass',
      '코덱스를 선택하지 않은 설치라 해당 없음(코덱스 심을 만들지 않음). 나중에 IRIS 창 ⑦ 에서 ChatGPT 를 추가하면 그때 다시 잽니다.',
      { wiring: { shim: null }, relay: null, mitm: null, bundle: null, skipped: 'no-codex' });
  }

  // ⓐ 배선
  const wiring = {};
  const shim = readText(shimPath(root, 'codex.cmd'));
  if (shim == null) { wiring.shim = null; problems.push('codex.cmd 심이 없음'); }
  else {
    const missing = CODEX_PROXY_LINES.filter((l) => !shim.includes(l));
    wiring.shim = missing.length === 0;
    if (missing.length) problems.push(`codex.cmd 심에 프록시 설정 ${missing.length}줄이 없음(${missing.map((l) => l.split('=')[0].replace(/^set "/, '')).join(', ')}) — 그 심으로 연 코덱스는 직행한다`);
  }

  // ⓑ 중계기 + 계정
  let relay = { up: false, status: null, accounts: null };
  if (typeof fetchImpl === 'function') {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetchImpl(`${baseUrl}/teamclaude/status`, { signal: ac.signal });
      clearTimeout(t);
      const j = r.ok ? await r.json().catch(() => null) : null;
      relay = { up: r.ok && j && typeof j === 'object', status: r.status, accounts: j ? accountsByProvider(j) : null };
    } catch {
      relay = { up: false, status: null, accounts: null };
    }
  }

  // ⓒ 가로채기 실측 + ⓓ 번들
  let mitm = null;
  let bundle = null;
  const dir = portableTeamclaudeConfigDir(root);
  const caPath = path.join(dir, CA_FILE);
  if (!relay.up) {
    notes.push('중계기가 응답하지 않음(⑦ 계정 연결 뒤 시작됨) — 가로채기 실측은 다음에');
  } else {
    let ca = readText(caPath);
    if (ca == null) {
      // 지연 생성: 첫 CONNECT 가 CA 를 만든다(검증 없이 한 번 맺는다).
      const mint = await mitmProbeImpl({ ca: null });
      ca = readText(caPath);
      if (ca == null) problems.push(`중계기가 CA 를 만들지 않음(${mint?.error ?? `HTTP ${mint?.status}`}) — MITM 이 꺼진 중계기(--no-mitm)이거나 설정 폴더에 쓸 수 없음`);
    }
    if (ca != null) {
      mitm = await mitmProbeImpl({ ca });
      const okBody = /mitm-proxy-ok/.test(String(mitm?.body ?? ''));
      if (!(mitm?.ok && mitm?.verified && okBody)) {
        problems.push(`가로채기 실측 실패(${RELAY_MITM_TEST_HOST}): ${mitm?.error ?? (mitm?.ok ? (mitm?.verified ? '응답 본문이 다름' : 'CA 검증 실패') : `HTTP ${mitm?.status}`)}`);
      }
      try {
        bundle = writeBundleImpl(dir, { fs });
        if (!bundle?.ok) problems.push(`CA 번들(${BUNDLE_FILE})을 만들지 못함: ${bundle?.reason ?? '?'}`);
      } catch (e) {
        bundle = { ok: false, reason: String(e?.message ?? e) };
        problems.push(`CA 번들(${BUNDLE_FILE})을 만들지 못함: ${bundle.reason}`);
      }
    }
    if (relay.accounts.codex === 0) {
      problems.push(`중계기에 코덱스 계정 0개(클로드 ${relay.accounts.anthropic}개) — 코덱스 세션은 중계기가 429 로 막습니다. IRIS 창 ⑦ 계정 연결에서 ChatGPT 로그인을 추가하세요`);
    }
  }

  const status = problems.length ? 'fail' : (relay.up ? 'pass' : 'pending');
  const detailParts = [];
  detailParts.push(problems.length ? `배선·경유 문제 ${problems.length}건: ${problems.join(' / ')}` : '코덱스 심이 중계기 프록시(3456) + CA 번들을 가리킴');
  if (relay.up) detailParts.push(`중계기 응답 OK(코덱스 ${relay.accounts.codex}·클로드 ${relay.accounts.anthropic})`);
  if (mitm?.ok && mitm?.verified) detailParts.push(`가로채기 실측 통과(${RELAY_MITM_TEST_HOST} → 중계기 리프, CA 검증됨)`);
  if (bundle?.ok) detailParts.push(bundle.changed ? `CA 번들 ${bundle.changed ? '갱신' : '유지'}(공인 루트 ${bundle.roots ?? '?'}개 + 중계기 CA)` : 'CA 번들 최신');
  if (notes.length) detailParts.push(notes.join(' · '));
  return item('relayCodex', 13, '중계기 경유(코덱스 세션 → TeamClaude)', status, detailParts.join(' · '), { wiring, relay, mitm, bundle });
}

// ---------------------------------------------------------------------------
// 전체 검사
// ---------------------------------------------------------------------------

export const CHECKS = Object.freeze([
  { id: 'exe', fn: checkExe },
  { id: 'mcp', fn: checkMcp },
  { id: 'plugins', fn: checkPlugins },
  { id: 'hooks', fn: checkHooks },
  { id: 'config', fn: checkConfig },
  { id: 'desktop', fn: checkDesktop },
  { id: 'ontology', fn: checkOntology },
  { id: 'receipt', fn: checkReceiptIdempotent },
  { id: 'edge', fn: checkEdge },
  { id: 'skeleton', fn: checkSkeleton },
  { id: 'structure', fn: checkStructure },
  { id: 'relay', fn: checkRelayRoute },
  { id: 'relayCodex', fn: checkRelayCodex },
]);

export async function runChecks(ctx, { only = null, ...opts } = {}) {
  const log = logOf(ctx);
  const items = [];
  for (const spec of CHECKS) {
    if (only && !only.includes(spec.id)) continue;
    let result;
    try {
      result = await spec.fn(ctx, opts);
    } catch (e) {
      // 검사 자체가 깨져도 설치 전체를 죽이지 않는다 — 그 검사만 실패로 적는다.
      result = item(spec.id, null, spec.id, 'fail', `검사 도중 오류: ${String(e?.message ?? e)}`);
    }
    items.push(result);
    log(`[checks] ${result.num ?? ''} ${result.label}: ${result.status} — ${result.detail}`);
  }
  return {
    items,
    pass: items.filter((c) => c.status === 'pass'),
    pending: items.filter((c) => c.status === 'pending'),
    fail: items.filter((c) => c.status === 'fail'),
  };
}

// 앞 단계들이 영수증에 남긴 대기 기능 + 이번 검사가 새로 찾은 것.
export function collectPending(ctx, checkItems = []) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p || !p.capability) return;
    const key = `${p.capability}::${p.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ capability: p.capability, reason: p.reason ?? '', ...(p.howToEnable ? { howToEnable: p.howToEnable } : {}) });
  };
  for (const stageId of SETUP_STAGE_IDS) {
    for (const p of ctx.receipt?.setup?.[stageId]?.pending ?? []) add(p);
  }
  for (const c of checkItems) {
    if (c.status === 'pending' && c.pendingCapability) add(c.pendingCapability);
  }
  return out;
}

/**
 * run(ctx) — 계약의 ⑨ 단계.
 *
 * 순서가 곧 약속이다: **검사 → 설치기 사본 → 보고·진단 → 인수 문서 → (실패면) 멈춤.**
 * 멈추기 전에 파일을 다 써 두어야, 실패한 사람도 "무엇이 왜 안 됐는지"를
 * 화면과 파일로 볼 수 있다.
 */
export async function run(ctx, opts = {}) {
  const log = logOf(ctx);
  const result = await runChecks(ctx, opts);
  const summary = { pass: result.pass.length, pending: result.pending.length, fail: result.fail.length };
  const pending = collectPending(ctx, result.items);

  const installerCopy = safely(log, '설치기 사본', () => copyInstallerProgram(ctx));

  const now = opts.now ?? new Date();
  // 보고서는 이 단계가 **끝나기 전에** 쓰인다. 그대로 두면 영수증에는 아직
  // `running` 이라 표에 "마무리 검사 — 대기"로 찍힌다. 결과는 이미 손에 있으니
  // 이 단계의 결말을 미리 채워 넣는다(실패면 실패로).
  const stages = {
    ...(opts.stages ?? {}),
    checks: { status: result.fail.length ? 'failed' : 'done', code: result.fail.length ? 'E-CHECKS' : null },
  };
  const common = {
    checks: summary,
    checkItems: result.items,
    pending,
    stages,
    failed: opts.failed ?? (result.fail.length ? { id: 'checks', code: 'E-CHECKS', message: `검사 ${result.fail.length}개가 실패했습니다` } : null),
    now,
  };

  const report = safely(log, '설치보고', () => writeReport(ctx, common));
  const diagnostics = safely(log, '진단 파일', () => writeDiagnostics(ctx, common));

  const handoff = safely(log, '인수 문서', () => writeHandoff(ctx, {
    checks: summary,
    pending,
    reportPath: report?.path ?? reportPath(ctx.root, now),
    diagnosticsPath: diagnostics?.path ?? diagnosticsPath(ctx.root),
    // 검사가 하나라도 실패했으면 이 단계는 곧 `failed` 로 끝난다(아래 throw).
    // 그런데도 `checks` 를 "끝난 셈 치라"고 넘기면 인수 문서가 `setup.allDone:true`
    // 로 적혀 Face 가 "설치 완료"로 읽는다 — 실패를 성공으로 바꿔 적는 셈이다.
    // 그래서 **통과했을 때만** 미리 끝난 것으로 친다.
    assumeDone: result.fail.length ? [] : ['checks'],
    failed: common.failed,
    now,
  }));

  const recorded = {
    checks: summary,
    items: result.items.map((c) => ({ id: c.id, num: c.num, label: c.label, status: c.status, detail: c.detail })),
    handoffPath: handoff ? relOf(ctx.root, handoff.path) : null,
    reportPath: report ? relOf(ctx.root, report.path) : null,
    diagnosticsPath: diagnostics ? relOf(ctx.root, diagnostics.path) : null,
    installerCopy: installerCopy ?? null,
    state: handoff?.handoff?.state ?? null,
  };

  log(`[checks] 요약 — 통과 ${summary.pass}·대기 ${summary.pending}·실패 ${summary.fail}, 인수 문서 ${recorded.handoffPath ?? '못 씀'}`);

  if (result.fail.length) {
    throw new StageError(
      'E-CHECKS',
      `검사 ${result.fail.length}개가 실패했습니다`,
      { fail: result.fail.map((c) => ({ id: c.id, label: c.label, detail: c.detail })), recorded },
    );
  }
  return { recorded, pending };
}

// 파일 쓰기 하나가 실패해도 나머지 둘은 남긴다 — 세 파일은 서로를 대신하지 않는다.
function safely(log, what, fn) {
  try {
    return fn();
  } catch (e) {
    log(`[checks] ${what}을(를) 쓰지 못했습니다: ${String(e?.message ?? e)}`);
    return null;
  }
}

export default { id, run, runChecks, CHECKS };
