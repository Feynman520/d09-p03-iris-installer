// IRIS Doctor — 직통 실행: 중계기를 거치지 않고 에이전트(클로드 · 코덱스)를 띄우는 길.
// 지킬 것(설계 D2):
//   · 전달 심(shims)이 아니라 **실제 프로그램**을 부른다(심은 중계기 주소를 넣고 중계기를 켠다).
//   · 환경은 물려받지 않고 **허용 목록**으로 새로 만든다(API 키 · 중계기 주소 · 코드 주입 변수가 섞이지 않게).
//   · 설정 폴더와 작업 폴더는 **Doctor 전용**(평소 설정 · 훅 · 도구 연결을 물려받지 않는다).
//   · 띄우기 전에 통신 없이 **자기 점검**을 하고, 하나라도 어긋나면 띄우지 않는다.
//   · 열쇠 값은 환경 변수 하나로만 넘긴다 — 인자 · 로그 · 화면에 싣지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { spawn, spawnSync } from 'node:child_process';
import { doctorPaths, readJsonFile, inDoctorHome, CODEX_NEXT_RE } from './home.mjs';

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isShimPath = (p) => /[\\/]shims([\\/]|$)/i.test(String(p));

// 그대로 물려줘도 되는 윈도우 기본 변수(프로그램이 돌려면 있어야 하는 것들)
const BASE_KEYS = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'LANG', 'TERM', 'COLORTERM', 'WT_SESSION'];
// 망 설정: 학교 · 회사 망에서 없으면 연결이 안 되는 것들 — 허용된 모양일 때만 넘긴다
const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'];
// Doctor 가 스스로 넣는 변수(이 이름들만 금지 무늬의 예외)
const OWN_KEYS = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME', 'DISABLE_AUTOUPDATER', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']);
// 있으면 안 되는 변수의 무늬(종량 과금 열쇠 · 다른 연결 주소 · 코드 주입 · IRIS 의 평소 길)
const FORBIDDEN = /^(ANTHROPIC_|OPENAI_|AZURE_|AWS_|GOOGLE_|GEMINI_|VERTEX|CLAUDE_|CODEX_|NODE_OPTIONS$|NODE_PATH$|TEAMCLAUDE_|IRIS_|ELECTRON_RUN_AS_NODE$)/i;

const ci = (env) => { const m = new Map(); for (const [k, v] of Object.entries(env || {})) if (typeof v === 'string') m.set(k.toLowerCase(), [k, v]); return m; }; // 윈도우 변수 이름은 대소문자를 가리지 않는다
// 프록시가 이 PC 자신을 가리키는가(중계기일 수 있다): 127.x · localhost · ::1 · 0.0.0.0 · 이 PC 의 이름. 못 읽으면 넘기지 않는다.
const proxyHost = (v) => new URL(/^[a-z]+:\/\//i.test(v) ? v : `http://${v}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
// 이 PC 의 망 주소들(랜 주소 포함) — 프록시가 그 주소를 가리켜도 "이 PC 자신"이다
const ownAddresses = (ifaces = os.networkInterfaces()) => { const s = new Set(); for (const list of Object.values(ifaces || {})) for (const a of list || []) if (a?.address) s.add(String(a.address).toLowerCase().replace(/%.*$/, '')); return s; };
// IPv6 로 감싼 IPv4(::ffff:127.0.0.1 · ::ffff:7f00:1)는 안의 IPv4 로 풀어서 본다
const unmap = (h) => {
  const m = String(h).match(/^::ffff:(.+)$/i);
  if (!m) return h;
  if (net.isIPv4(m[1])) return m[1];
  const hex = m[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return h;
  const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
};
const isLocalAddress = (h0, own = ownAddresses(), h = unmap(h0)) => h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || h === '0.0.0.0' || h === '::' || own.has(h);
const pointsLocal = (v, self = os.hostname(), own = ownAddresses()) => {
  try { const h = proxyHost(v); return isLocalAddress(h, own) || h === String(self || '').toLowerCase(); } catch { return true; }
};
/**
 * 프록시 이름을 실제 주소로 풀어 봐서 이 PC 자신이면 뺀다(다른 이름을 붙여 둔 경우 — hosts 파일의 별칭 등).
 * 이름을 못 풀면 남긴다(바깥 프록시일 수 있고, 못 푸는 주소로는 어차피 이 PC 의 중계기에 닿지 못한다).
 */
export async function dropLocalProxies(env, { lookup = dns.lookup, own = ownAddresses(), timeoutMs = 2000 } = {}) {
  for (const k of PROXY_KEYS) {
    if (k === 'NO_PROXY' || !env[k]) continue;
    let h; try { h = proxyHost(env[k]); } catch { delete env[k]; continue; }
    if (net.isIP(h)) continue; // 주소로 적힌 것은 buildEnv 가 이미 봤다
    const addrs = await Promise.race([lookup(h, { all: true }).then((l) => l.map((x) => String(x.address).toLowerCase()), () => []), new Promise((r) => setTimeout(() => r([]), timeoutMs))]);
    if (addrs.some((a) => isLocalAddress(a, own))) delete env[k];
  }
  return env;
}
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
// 폴더 안에 "중계기로 가는 전달 파일"이 있는가 — 이름이 shims 가 아니어도 걸러 낸다(claude · codex · node 의 .cmd 가 중계기 주소를 넣는 경우)
const hasRelayWrapper = (dir) => ['claude.cmd', 'codex.cmd', 'node.cmd'].some((n) => { try { const t = fs.readFileSync(path.join(dir, n), 'utf8'); return /ANTHROPIC_BASE_URL|relay-ensure|model_provider/i.test(t); } catch { return false; } });

/** PATH 에 넣어도 되는 폴더만 고른다: 절대 경로 · 실제로 있음 · 전달 심 폴더가 아님(진짜 자리로 풀어 봐도) · 중계기 전달 파일이 없음. */
export function safePathDirs(dirs) {
  const out = [];
  for (const d of dirs) {
    if (!d || !path.isAbsolute(d)) continue;      // 상대 경로는 작업 폴더에 따라 달라진다
    const real = realOf(d);                        // 정션 · 링크는 진짜 자리로
    if (!real) continue;
    if (isShimPath(d) || isShimPath(real)) continue;
    if (hasRelayWrapper(real)) continue;
    if (!out.some((x) => x.toLowerCase() === d.toLowerCase())) out.push(d);
  }
  return out;
}

/**
 * 에이전트가 아닌 IRIS 자체 절차(중계기 켜기 스크립트 등)를 띄울 때의 환경: 윈도우 기본 변수 + 시스템 폴더만 든 PATH.
 * 열쇠 · 연결 주소 · 코드 주입 변수는 넘기지 않는다. extra 로 그 절차가 받는 변수만 더한다.
 */
export function plainEnv(baseEnv = process.env, extra = {}) {
  const base = ci(baseEnv); const env = {};
  for (const k of BASE_KEYS) { const hit = base.get(k.toLowerCase()); if (hit) env[k] = hit[1]; }
  const sys = env.SystemRoot || 'C:\\Windows';
  env.PATH = [path.join(sys, 'System32'), sys, path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
  return { ...env, ...extra };
}

/** 깨끗한 환경을 새로 만든다. kind = 'claude' | 'codex'. token 은 클로드일 때만. */
export function buildEnv({ kind, baseEnv = process.env, paths, token = null, nodeDir = null, extraPath = [] }) {
  const base = ci(baseEnv);
  const env = {};
  for (const k of BASE_KEYS) { const hit = base.get(k.toLowerCase()); if (hit) env[k] = hit[1]; }
  // PATH: 평소 PATH 에서 전달 심 폴더만 뺀다(그 안의 claude · codex · node 가 중계기 길로 데려간다) + 실제 node 자리를 맨 앞에
  const rawPath = (base.get('path') || ['', ''])[1];
  env.PATH = safePathDirs([...(nodeDir ? [nodeDir] : []), ...extraPath, ...rawPath.split(';').map((d) => d.trim()).filter(Boolean)]).join(';');
  // 망: 시스템 인증서 사용 표시는 비어 있으면 채운다('1' — 학교 · 회사 망이 인증서를 바꿔 끼워도 에이전트가 띄우는 node 가 윈도우 목록을 믿게).
  //     사용자가 '1' 로 둔 것은 그대로, 다른 값을 정해 둔 것은 넘기지 않는다(그 값을 1 로 덮지 않는다 · 모르는 값을 실어 보내지도 않는다).
  //     인증서 파일은 실제로 있을 때만 · 프록시는 이 PC 안(중계기)을 가리키지 않을 때만
  const ca = (base.get('node_use_system_ca') || [])[1];
  if (ca === undefined || ca === '' || ca === '1') env.NODE_USE_SYSTEM_CA = '1';
  for (const k of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) { const v = (base.get(k.toLowerCase()) || [])[1]; if (v && isFile(v)) env[k] = v; }
  for (const k of PROXY_KEYS) { const v = (base.get(k.toLowerCase()) || [])[1]; if (v && (k === 'NO_PROXY' || !pointsLocal(v))) env[k] = v; }
  env.DISABLE_AUTOUPDATER = '1'; // 고치는 도중에 프로그램이 스스로 판을 바꾸지 않게
  if (kind === 'claude') { env.CLAUDE_CONFIG_DIR = paths.claudeHome; if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token; }
  else if (kind === 'codex') env.CODEX_HOME = paths.codexHome;
  return env;
}

/** .cmd 전달 파일이 가리키는 자리들("%~dp0…")을 읽는다. */
function cmdRefs(cmdFile) {
  let text; try { text = fs.readFileSync(cmdFile, 'utf8'); } catch { return []; }
  return [...text.matchAll(/"%~dp0\\?([^"%]+)"/g)].map((m) => path.join(path.dirname(cmdFile), m[1]));
}
function findOnPath(env, names) {
  const raw = (ci(env).get('path') || ['', ''])[1];
  for (const d of raw.split(';').map((x) => x.trim()).filter(Boolean)) {
    if (isShimPath(d)) continue;
    for (const n of names) { const p = path.join(d, n); if (isFile(p)) return p; }
  }
  return null;
}

/**
 * 실제 프로그램을 찾는다(전달 심은 쓰지 않는다). → { exe, preArgs, nodeDir } | { error }
 * 설치본 = <도구 폴더>\claude\claude.cmd 가 가리키는 exe / <도구 폴더>\codex\codex.cmd 가 가리키는 js 를 동봉 node 로.
 * 개발 PC = PATH(심 폴더 제외)의 claude.exe · codex.exe.
 */
export function resolveAgent(kind, { toolsDir = null, baseEnv = process.env } = {}) {
  const bundledNode = toolsDir && isFile(path.join(toolsDir, 'node', 'node.exe')) ? path.join(toolsDir, 'node', 'node.exe') : null;
  // 전달 파일이 가리키는 실행 대상은 **하나로 정해져야** 한다(여럿이면 어느 것이 도는지 단정하지 않는다) · 그 파일이 실제로 있어야 한다.
  // node 는 allowPathNode=true 일 때만 PATH 에서 찾는다 — 설치본에서는 동봉 node 가 없으면 PATH 의 것으로 때우지 않는다(설치 손상을 숨기지 않게).
  const fromCmd = (file, { allowPathNode }) => {
    const refs = [...new Set(cmdRefs(file).filter((r) => !/(^|[\\/])node\.exe$/i.test(r)).map((r) => path.normalize(r)))];
    if (refs.length !== 1) return { error: refs.length ? 'program-ambiguous' : 'program-missing' };
    const target = refs[0];
    if (!isFile(target)) return { error: 'program-missing' };
    if (/\.exe$/i.test(target)) return { exe: target, preArgs: [], nodeDir: bundledNode ? path.dirname(bundledNode) : null };
    if (!/\.(c|m)?js$/i.test(target)) return { error: 'program-ambiguous' };
    const node = bundledNode || (allowPathNode ? findOnPath(baseEnv, ['node.exe']) : null);
    if (!node) return { error: 'node-missing' };
    return { exe: node, preArgs: [target], nodeDir: path.dirname(node) };
  };
  if (toolsDir) {
    // 설치본: 설치 도구 폴더의 전달 파일만 본다(PATH 의 다른 프로그램으로 넘어가지 않는다)
    const cmd = path.join(toolsDir, kind, `${kind}.cmd`);
    if (!isFile(cmd)) return { error: 'program-not-found' };
    return fromCmd(cmd, { allowPathNode: false });
  }
  const hit = findOnPath(baseEnv, [`${kind}.exe`, `${kind}.cmd`]);
  if (!hit) return { error: 'program-not-found' };
  if (/\.exe$/i.test(hit)) return { exe: hit, preArgs: [], nodeDir: null };
  return fromCmd(hit, { allowPathNode: true });
}

/**
 * 띄우기 전 자기 점검(통신 0). → { ok, problems: [이름…] }
 * 하나라도 어긋나면 띄우지 않는다 — 문제는 정해 둔 이름으로만 돌려준다(값은 싣지 않는다).
 */
export function selfCheck({ kind, env, agent, paths, card = null, now = Date.now() }) {
  const problems = [];
  for (const k of Object.keys(env)) if (FORBIDDEN.test(k) && !OWN_KEYS.has(k)) problems.push('forbidden-variable');
  if (!agent || agent.error || !agent.exe) problems.push(['program-missing', 'program-ambiguous', 'node-missing'].includes(agent?.error) ? agent.error : 'program-not-found');
  else {
    for (const p of [agent.exe, ...(agent.preArgs || [])]) { if (isShimPath(p)) problems.push('program-is-shim'); if (!isFile(p)) problems.push('program-missing'); }
  }
  if (String(env.PATH || '').split(';').some(isShimPath)) problems.push('path-has-shims');
  if (!exists(paths.work)) problems.push('workdir-missing');
  if (kind === 'claude') {
    if (path.resolve(String(env.CLAUDE_CONFIG_DIR || '')) !== path.resolve(paths.claudeHome)) problems.push('config-not-doctor');
    const t = String(env.CLAUDE_CODE_OAUTH_TOKEN || '');
    if (!t) problems.push('key-missing');
    else if (/^sk-ant-api/i.test(t) || !/^sk-ant-oat/i.test(t)) problems.push('key-not-subscription'); // API 키(종량 과금) 모양이면 거절 — 모양 확인일 뿐 과금 상태의 증명은 아니다
    const exp = Number(card?.expiresAt);
    if (!Number.isFinite(exp) || exp <= 0) problems.push('key-expiry-unknown');
    else if (exp <= now + 5 * 60_000) problems.push('key-expired');
    // 전용 설정 폴더에 열쇠를 가져오는 명령 · 환경 칸이 끼어 있으면 안 된다. 설정 파일이 있는데 못 읽어도 멈춘다(무엇이 들었는지 모른다).
    const stFile = path.join(paths.claudeHome, 'settings.json');
    const st = readJsonFile(stFile);
    if (!st && exists(stFile)) problems.push('config-unreadable');
    if (st && (st.apiKeyHelper || st.awsAuthRefresh || st.awsCredentialExport || st.gcpAuthRefresh || (st.env && Object.keys(st.env).some((k) => FORBIDDEN.test(k))))) problems.push('config-has-billing');
    // 관리자 정책 폴더(이 PC 전체에 걸리는 설정)에 과금 길이 있으면 멈춘다 — Doctor 가 끌 수 없는 설정이다
    const managed = readJsonFile(path.join(env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json'));
    if (managed && (managed.apiKeyHelper || (managed.env && Object.keys(managed.env).some((k) => /^(ANTHROPIC_|CLAUDE_CODE_USE_)/i.test(k))))) problems.push('managed-has-billing');
  } else if (kind === 'codex') {
    if (path.resolve(String(env.CODEX_HOME || '')) !== path.resolve(paths.codexHome)) problems.push('config-not-doctor');
    const auth = readJsonFile(path.join(paths.codexHome, 'auth.json'));
    if (!auth) problems.push('key-missing');
    else if (auth.OPENAI_API_KEY) problems.push('key-not-subscription');
    else if (!auth.tokens || !(auth.tokens.refresh_token || auth.tokens.access_token)) problems.push('key-missing');
    // Doctor 전용 코덱스 설정은 우리가 쓴 세 줄뿐이어야 한다 — 다른 연결 주소 · 공급자 · 도구 연결 · 훅이 끼어 있으면 멈춘다. 못 읽어도 멈춘다.
    const cfg = codexConfigProblem(path.join(paths.codexHome, 'config.toml'));
    if (cfg) problems.push(cfg);
  } else problems.push('unknown-kind');
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

const CODEX_ALLOWED = new Map([['model_provider', '"openai"'], ['forced_login_method', '"chatgpt"'], ['cli_auth_credentials_store', '"file"']]);
/** Doctor 전용 config.toml 을 줄 단위로 본다: 주석 · 빈 줄 · 정해 둔 세 줄만 허용. → 문제 이름 | null */
export function codexConfigProblem(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 'config-unreadable'; }
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!m || CODEX_ALLOWED.get(m[1]) !== m[2]) return 'config-has-billing'; // 표([…]) · 다른 키 · 다른 값은 모두 여기서 걸린다
    if (seen.has(m[1])) return 'config-has-billing'; // 같은 키가 두 번이면 프로그램이 설정을 못 읽는다
    seen.add(m[1]);
  }
  return seen.size === CODEX_ALLOWED.size ? null : 'config-has-billing';
}

export const PROBLEM_KO = {
  'forbidden-variable': '환경에 있으면 안 되는 변수가 섞였습니다',
  'program-not-found': '실제 프로그램을 찾지 못했습니다',
  'program-missing': '실행 길이 가리키는 프로그램 파일이 없습니다',
  'program-is-shim': '전달 심(중계기로 가는 길)을 부르려 했습니다',
  'path-has-shims': '실행 경로에 전달 심 폴더가 남아 있습니다',
  'workdir-missing': 'Doctor 작업 폴더가 없습니다',
  'config-not-doctor': '설정 폴더가 Doctor 전용이 아닙니다',
  'key-missing': '연결된 열쇠가 없습니다',
  'key-not-subscription': '열쇠가 구독 열쇠 모양이 아닙니다(API 키일 수 있음)',
  'key-expiry-unknown': '열쇠의 만료 시각을 모릅니다',
  'key-expired': '열쇠가 만료됐습니다',
  'config-has-billing': 'Doctor 설정 폴더에 정해 둔 것 말고 다른 설정(과금 길 · 다른 연결 주소 등)이 끼어 있습니다',
  'config-unreadable': 'Doctor 설정 파일을 읽지 못했습니다(무엇이 들었는지 몰라 멈춥니다)',
  'managed-has-billing': '이 PC 의 관리자 정책 설정에 다른 과금 길이 있습니다(Doctor 가 끌 수 없는 설정)',
  'program-ambiguous': '실행 길이 가리키는 프로그램이 하나로 정해지지 않습니다',
  'node-missing': '설치본의 동봉 node 가 없습니다(다른 node 로 때우지 않습니다)',
  'unknown-kind': '모르는 에이전트 종류입니다',
  'isolation-unavailable': '클로드 프로그램이 평소 설정을 떼어 놓는 인자를 받는지 확인하지 못했습니다(프로그램이 답하지 않거나 너무 옛 판)',
};

// 클로드: 평소 설정 · 프로젝트 설정 · 도구 연결(MCP) · 훅 · 지침 파일을 물려받지 않게 하는 인자.
//   --setting-sources user   프로젝트 · 로컬 설정 파일을 읽지 않는다(Doctor 전용 설정 폴더의 것만)
//   --strict-mcp-config      작업 폴더 · 상위 폴더의 도구 연결 파일을 읽지 않는다
//   --safe-mode              지침 파일(CLAUDE.md) · 훅 · 플러그인 · 스킬까지 끈다 — 이 인자가 있는 판에서만(없는 판에 주면 실행이 거절된다)
const helpCache = new Map();
export function claudeIsolationArgs(exe, { helpText = null, run = spawnSync } = {}) {
  let help = helpText;
  if (help === null) {
    if (!helpCache.has(exe)) { try { const r = run(exe, ['--help'], { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', TEMP: os.tmpdir(), TMP: os.tmpdir() } }); helpCache.set(exe, String(r.stdout || '')); } catch { helpCache.set(exe, ''); } }
    help = helpCache.get(exe);
  }
  const has = (flag) => new RegExp(`(^|\\s)${flag}(\\s|$)`, 'm').test(help);
  // 앞의 둘은 꼭 있어야 한다 — 도움말을 못 받았거나 둘 중 하나라도 없으면 null(띄우지 않는다: 살펴보지 않은 프로젝트 설정 · 도구 연결이 끼어들 수 있다)
  if (!has('--setting-sources') || !has('--strict-mcp-config')) return null;
  return ['--setting-sources', 'user', '--strict-mcp-config', ...(has('--safe-mode') ? ['--safe-mode'] : [])];
}

// 코덱스는 설정을 인자로도 못 박는다(전용 폴더의 설정 파일이 바뀌어도 구독 로그인 · 기본 연결 · 파일 보관을 지키게)
export const CODEX_PINS = ['-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"'];

/**
 * 에이전트를 띄운다. 자기 점검에 걸리면 띄우지 않고 { blocked: [문제…] } 를 돌려준다.
 * capture=true 면 출력을 모아 돌려준다(짧은 확인 호출용), 아니면 이 터미널에 그대로 잇는다(대화용).
 */
export async function runAgent({ kind, root, toolsDir = null, args = [], baseEnv = process.env, card = null, capture = true, timeoutMs = 120_000, spawnFn = spawn, now = Date.now(), codexHomeDir = null, isolate = true, helpText = null, purpose = 'run', lookup = undefined, cwd = null }) {
  // isolate = true 평소 설정을 모두 뗀다(지침 · 훅 · 플러그인까지) / 'hooks' = 치료 실행용: Doctor 전용 설정 폴더의 훅(가드)은 돌게 둔다(--safe-mode 를 빼고 나머지 격리 인자는 그대로)
  // cwd = 작업 폴더를 바꾼다(치료 실행은 IRIS 폴더 밖에서 돈다 — 프로젝트 지침이 끼지 않게). 없으면 Doctor 의 작업 폴더.
  // codexHomeDir = 바꾸는 중인 코덱스 후보 폴더로 띄운다(Doctor 집 바로 아래의 후보 폴더만 받는다)
  // purpose = 'login' 이면 코덱스 로그인을 받으러 띄우는 것이라 "열쇠 없음"만은 막지 않는다(나머지 점검은 그대로)
  const paths = { ...doctorPaths(root) };
  if (codexHomeDir) {
    if (kind !== 'codex' || !inDoctorHome(root, codexHomeDir, CODEX_NEXT_RE)) return { blocked: ['config-not-doctor'] };
    paths.codexHome = path.resolve(codexHomeDir);
  }
  const agent = resolveAgent(kind, { toolsDir, baseEnv });
  const env = buildEnv({ kind, baseEnv, paths, token: kind === 'claude' ? card?.token ?? null : null, nodeDir: agent.nodeDir || null });
  await dropLocalProxies(env, lookup ? { lookup } : {}); // 다른 이름으로 이 PC 를 가리키는 프록시도 뺀다
  const check = selfCheck({ kind, env, agent, paths, card, now });
  const problems = purpose === 'login' && kind === 'codex' ? check.problems.filter((x) => x !== 'key-missing') : check.problems;
  if (problems.length) return { blocked: problems };
  if (kind === 'claude' && isolate) {
    // 클로드는 격리 인자를 앞에 붙인다. 그 판이 받는지 확인하지 못하면 띄우지 않는다.
    const iso = claudeIsolationArgs(agent.exe, { helpText });
    if (!iso) return { blocked: ['isolation-unavailable'] };
    args = [...(isolate === 'hooks' ? iso.filter((a) => a !== '--safe-mode') : iso), ...args];
  } else if (kind === 'codex') {
    // 코덱스는 어떤 명령으로 띄우든 세 설정을 인자로도 못 박는다(맨 앞 = 모든 하위 명령에 걸린다)
    args = [...CODEX_PINS, ...args];
  }
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child, timedOut = false, giveUp = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(giveUp); resolve(r); };
    const stillAlive = () => { try { process.kill(child.pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
    // 시간이 지나면 우리가 띄운 그 프로세스와 그 자식들만 끈다(번호로 — 이름으로 끄지 않는다). 끝난 것을 확인한 뒤 돌려준다(작업 폴더를 쥔 채 남지 않게).
    // 5초 안에 끝났다는 신호가 없으면 돌려주되, 아직 살아 있는지를 alive 로 알린다(살아 있으면 부른 쪽이 그 연결의 파일을 치우지 않는다).
    // 화면에 그대로 잇는 실행(로그인 등)에도 같은 시간 제한을 건다 — 끝없이 기다리며 연결 잠금을 쥐고 있지 않게.
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      try { if (child?.pid) spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' }); } catch {}
      try { child?.kill(); } catch {}
      giveUp = setTimeout(() => finish({ timeout: true, out, alive: child?.pid ? stillAlive() : false }), 5000);
    }, timeoutMs) : null;
    timer?.unref?.();
    try {
      child = spawnFn(agent.exe, [...agent.preArgs, ...args], { cwd: cwd && path.isAbsolute(cwd) && exists(cwd) ? cwd : paths.work, env, windowsHide: capture, shell: false, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
      if (capture) { child.stdout.on('data', (d) => { if (out.length < 2_000_000) out += d.toString('utf8'); }); child.stderr.on('data', (d) => { if (err.length < 200_000) err += d.toString('utf8'); }); }
      child.on('error', (e) => finish({ error: String(e?.code || 'spawn') }));
      child.on('close', (code) => finish(timedOut ? { timeout: true, out, alive: false } : { code, out, err }));
    } catch (e) { finish({ error: String(e?.code || 'spawn') }); }
  });
}
