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
import { SETUP_STAGE_IDS, receiptPath } from '../lib/receipt.mjs';
import { writeHandoff, copyInstallerProgram } from './handoff.mjs';
import { writeReport, writeDiagnostics, reportPath, diagnosticsPath } from './report.mjs';

const path = nodePath;

export const id = 'checks';

export const MCP_TIMEOUT_MS = 10000;
export const EXE_TIMEOUT_MS = 30000;

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
    const res = await runExe(ctx, exe, ['--version']);
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
    const res = await mcpInitialize(spec, { spawn, env: ctx.env, timeoutMs, run: ctx.run });
    let status = res.ok ? 'pass' : 'fail';
    let why = res.ok ? '응답함' : (res.detail ?? res.reason);
    if (!res.ok && bare in DOCUMENT_MCP_APPS) {
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
      const res = await runExe(ctx, 'powershell', ['-NoProfile', '-Command', psSyntaxCommand(file)], { timeoutMs: 20000 });
      results.push({ name, ok: res.code === 0, why: res.code === 0 ? '문법 정상' : `문법 오류(${String(res.out || res.err).slice(0, 120)})` });
    } else {
      const res = await runExe(ctx, python, ['-m', 'py_compile', file], { timeoutMs: 20000 });
      results.push({ name, ok: res.code === 0, why: res.code === 0 ? '문법 정상' : `문법 오류(${String(res.err || res.out).slice(0, 120)})` });
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
  const res = await runExe(ctx, 'powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { timeoutMs: 15000 });
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
  const fromPackage = (abs) => zipRoots.some((z) => abs.toLowerCase().startsWith(z));
  for (const stageId of SETUP_STAGE_IDS) {
    for (const p of recordedPaths(ctx.receipt?.setup?.[stageId]?.recorded)) {
      const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
      if (abs.toLowerCase().startsWith(rootLower) || fromPackage(abs)) continue;
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
