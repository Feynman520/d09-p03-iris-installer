// IRIS Doctor — 어디를 볼지(경로)와 무엇으로 볼지(읽기 도구)를 한 곳에서 정한다.
// 진단기는 **읽기만** 한다: 여기서 내주는 도구에는 쓰기가 없다. 시험은 이 도구들을 가짜로 바꿔 넣는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOCTOR_DIR = path.join(HERE, '..');
const MAX_JSON = 4 * 1024 * 1024;

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

/** JSON 파일을 읽는다(없음 · 깨짐 · 너무 큼 = null). { value, mtime } */
export function readJson(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_JSON) return null;
    return { value: JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))), mtime: st.mtime.toISOString(), size: st.size };
  } catch { return null; }
}

/** 파일의 꼬리만 읽는다 — 읽는 양부터 제한(로그 전체를 읽지 않는다). { text, size, mtime } | null */
export function readTail(file, maxBytes = 16 * 1024) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    return { text: buf.toString('utf8'), size: st.size, mtime: st.mtime.toISOString() };
  } catch { return null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
}

export function fileInfo(file) {
  try { const st = fs.statSync(file); return { exists: true, isDir: st.isDirectory(), size: st.size, mtime: st.mtime.toISOString() }; } catch { return { exists: false }; }
}

/** 영혼 폴더 루트: 진단기 자리(<root>\_agent\<…>\tools\iris-doctor)에서 위로 올라가며 `_agent` 를 가진 폴더를 찾는다. */
export function findRoot(from = DOCTOR_DIR) {
  let cur = path.resolve(from);
  for (let i = 0; i < 8; i++) {
    if (path.basename(cur).toLowerCase() === '_agent' && isDir(cur)) return path.dirname(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/** 바깥 주소에 GET 한 번(본문은 읽지 않는다). → { ok, status } | { ok:false, kind } — kind = dns | refused | timeout | cert | other */
export async function httpProbe(url, { timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
  try {
    const r = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    try { await r.body?.cancel(); } catch {}
    return { ok: true, status: r.status };
  } catch (e) {
    const code = String(e?.cause?.code || e?.code || e?.name || '');
    const kind = /ENOTFOUND|EAI_AGAIN/.test(code) ? 'dns'
      : /ECONNREFUSED/.test(code) ? 'refused'
        : /Timeout|ETIMEDOUT|ABORT/i.test(code) ? 'timeout'
          : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ERR_TLS/.test(code) ? 'cert'
            : 'other';
    return { ok: false, kind, code: code.slice(0, 60) };
  }
}

/** 이 PC 안의 주소에서 JSON 을 받는다(중계기 · 창의 상태 주소). → { ok, status, body } | { ok:false, kind } */
export async function localJson(url, { timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
  try {
    // 이 PC 안의 주소만 묻는다 · 다른 주소로 보내는 답(3xx)은 따라가지 않는다(통신 없이 도는 방식에서도 바깥으로 나가지 않게)
    const u = new URL(url);
    if (u.hostname !== '127.0.0.1') return { ok: false, kind: 'other' };
    const r = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (r.status >= 300 && r.status < 400) { try { await r.body?.cancel(); } catch {} return { ok: false, kind: 'redirect', status: r.status }; }
    const body = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    const code = String(e?.cause?.code || e?.code || e?.name || '');
    return { ok: false, kind: /ECONNREFUSED/.test(code) ? 'refused' : /Timeout|ABORT/i.test(code) ? 'timeout' : 'other' };
  }
}

/** 프로그램을 실행해 출력만 받는다(셸을 거치지 않는다 · 제한 시간 · 출력 길이 제한). → { code, out } | { error } */
export function runRead(exe, args, { timeoutMs = 8000, env = undefined, maxOut = 200_000 } = {}) {
  return new Promise((resolve) => {
    let out = '', done = false, child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { child?.kill(); } catch {} finish({ error: 'timeout' }); }, timeoutMs);
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env, shell: false });
      child.stdout.on('data', (d) => { if (out.length < maxOut) out += d.toString('utf8'); });
      child.on('error', (e) => finish({ error: e.code || 'spawn' }));
      child.on('exit', (code) => finish({ code, out }));
    } catch (e) { finish({ error: e.code || 'spawn' }); }
  });
}

// 포트 주인과 메모리(커밋) 여유를 한 번에 묻는다 — 파워셸을 한 번만 띄운다(느리므로).
// 명령줄 원문은 받지 않는다: "이 글자가 들어 있는가"의 참 · 거짓만 받는다.
const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$ports = @(__PORTS__)
$owners = @()
foreach ($p in $ports) {
  # "듣는 프로그램이 없음"과 "조회 자체가 실패"를 가른다(실패를 꺼짐으로 읽지 않게)
  $c = @(); $failed = $false
  try { $c = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop) }
  catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { $failed = $true } }
  if ($failed) { $owners += [pscustomobject]@{port=$p;error=$true}; continue }
  if (-not $c.Count) { $owners += [pscustomobject]@{port=$p;listening=$false}; continue }
  $pids = @($c | Select-Object -ExpandProperty OwningProcess -Unique)
  $pr = Get-CimInstance Win32_Process -Filter "ProcessId = $($pids[0])"
  $cmd = [string]$pr.CommandLine
  $exe = [string]$pr.ExecutablePath
  $owners += [pscustomobject]@{
    port=$p; listening=$true; owners=$pids.Count; pid=$pids[0]
    exe=[System.IO.Path]::GetFileName($exe)
    canRead=([bool]$cmd -and [bool]$exe)
    isRelay=($cmd -match 'teamclaude[\\\\/]src[\\\\/]index\\.js')
    isFace=($cmd -match 'daemon[\\\\/]server\\.mjs')
    isInstaller=($cmd -match 'installer[\\\\/]')
    isDash=($cmd -match 'teamclaude-dash')
  }
}
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  owners=$owners
  commitFreeKb=[int64]$os.FreeVirtualMemory
  commitTotalKb=[int64]$os.TotalVirtualMemorySize
  ramFreeKb=[int64]$os.FreePhysicalMemory
} | ConvertTo-Json -Depth 4 -Compress
`;

/** → { owners:[…], commitFreeKb, … } | { error } */
export async function psProbe(ports, { timeoutMs = 15000 } = {}) {
  const script = PS_SCRIPT.replace('__PORTS__', ports.map((p) => Number(p)).filter(Number.isInteger).join(','));
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const exe = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = await runRead(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], { timeoutMs });
  if (r.error) return { error: r.error };
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
    j.owners = [].concat(j.owners || []);
    return j;
  } catch { return { error: 'parse' }; }
}

/** 사용자 환경 변수(HKCU\\Environment)에 그 이름이 있는지와 값(주소류만 쓰려고) — reg 조회, 읽기만. */
export async function userEnvValue(name) {
  if (!/^[A-Z][A-Z0-9_]{0,60}$/.test(String(name))) return null; // 이름을 정규식에 넣으므로 정해진 모양만
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const r = await runRead(path.join(sysRoot, 'System32', 'reg.exe'), ['query', 'HKCU\\Environment', '/v', name], { timeoutMs: 5000 });
  if (r.error || r.code !== 0) return null;
  const m = r.out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`, 'i'));
  return m ? m[1].trim() : null;
}

/**
 * 진단에 쓰는 자리와 도구 묶음. opts 로 무엇이든 바꿔 넣을 수 있다(시험).
 * layout = 'installed'(설치 패키지 영수증이 있음) | 'dev'(없음 — 개발 PC)
 */
export function makeContext(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const doctorDir = opts.doctorDir ?? DOCTOR_DIR;
  const root = opts.root ?? env.IRIS_ROOT ?? findRoot(doctorDir);
  const local = opts.local ?? readJson(path.join(doctorDir, 'local.json'))?.value ?? {}; // 개발 PC 가 창 폴더 자리를 적어 두는 곳(선택)
  const receiptFile = root ? path.join(root, '_agent', 'setup', 'package-receipt.json') : null;
  const receiptRead = opts.receipt !== undefined ? { value: opts.receipt } : (receiptFile ? readJson(receiptFile) : null);
  const receipt = receiptRead?.value && typeof receiptRead.value === 'object' ? receiptRead.value : null;
  // 영수증 파일이 있는데 읽지 못하면 "개발 PC"가 아니라 "설치본 · 영수증 깨짐"이다(설치본의 손상을 숨기지 않는다)
  const receiptBroken = opts.receiptBroken ?? (!receipt && !!receiptFile && exists(receiptFile));
  const layout = receipt || receiptBroken ? 'installed' : 'dev';
  const toolsDir = root ? path.join(root, '_agent', 'shared', 'tools') : null;

  const str = (v) => (typeof v === 'string' && v.trim() ? v : null); // 설정 값이 글이 아니면(깨진 설정) 쓰지 않는다
  const pick = (...c) => c.find((p) => str(p) && exists(p)) || null;
  const portable = root ? path.join(root, '_agent', 'shared', 'portable-state', 'teamclaude', 'teamclaude.json') : null; // 설치본의 중계기 설정 자리(P02 shims)
  const relayConfig = str(opts.relayConfig) ?? str(receipt?.env?.teamclaudeConfig) ?? str(env.TEAMCLAUDE_CONFIG) ?? pick(portable) ?? path.join(home, '.config', 'teamclaude.json');
  const relayBase = relayConfig.replace(/\.json$/i, '');
  const relaySibling = (suffix) => `${relayBase}.${suffix}`; // teamclaude.auth-health.json …

  const faceDir = opts.faceDir ?? pick(local.faceDir, env.IRIS_FACE_DIR, toolsDir && path.join(toolsDir, 'face'), toolsDir && path.join(toolsDir, 'iris-face')); // 설치본의 창 자리 = tools\face(P02 updater faceDirFor)
  const doctorHome = opts.doctorHome ?? (root ? path.join(root, '_agent', 'doctor') : null); // Doctor 의 열쇠 · 진료 기록 자리(걸음 ②부터 씀 — 진단기는 읽기만)
  const claudeDir = opts.claudeDir ?? pick(env.CLAUDE_CONFIG_DIR, root && path.join(root, '_agent', 'claude'), path.join(home, '.claude'));
  const codexDir = opts.codexDir ?? pick(env.CODEX_HOME, root && path.join(root, '_agent', 'codex'), path.join(home, '.codex'));

  return {
    env, home, root, layout, receipt, receiptBroken, receiptFile, receiptAt: receiptRead?.mtime ?? null, local, doctorDir, toolsDir,
    relayConfig, relaySibling, relayPort: Number(opts.relayPort ?? local.relayPort ?? 3456), facePort: Number(opts.facePort ?? local.facePort ?? 3458),
    installerPort: 3460, dashPort: 3457,
    faceDir, claudeDir, codexDir, doctorHome,
    shimsDir: root ? path.join(root, '_agent', 'shared', 'shims') : null,
    setupDir: root ? path.join(root, '_agent', 'setup') : null,
    listDir: opts.listDir ?? ((p) => { try { return fs.readdirSync(p); } catch { return null; } }),
    readText: opts.readText ?? ((p, max = 512 * 1024) => { try { const st = fs.statSync(p); if (!st.isFile() || st.size > max) return null; return stripBom(fs.readFileSync(p, 'utf8')); } catch { return null; } }),
    offline: !!opts.offline,
    now: opts.now ?? (() => Date.now()),
    // 읽기 도구(시험에서 바꿔 넣는다)
    readJson: opts.readJson ?? readJson,
    readTail: opts.readTail ?? readTail,
    fileInfo: opts.fileInfo ?? fileInfo,
    exists: opts.exists ?? exists,
    httpProbe: opts.httpProbe ?? httpProbe,
    localJson: opts.localJson ?? localJson,
    runRead: opts.runRead ?? runRead,
    userEnvValue: opts.userEnvValue ?? userEnvValue,
    psProbe: opts.psProbe ?? psProbe,
    statfs: opts.statfs ?? ((p) => { try { return fs.statfsSync(p); } catch { return null; } }),
    freemem: opts.freemem ?? (() => os.freemem()),
    totalmem: opts.totalmem ?? (() => os.totalmem()),
    _ps: null, // 파워셸 조회는 검진 한 번에 한 번만(여러 검사가 나눠 쓴다)
  };
}

/** 여러 검사가 나눠 쓰는 포트 주인 · 커밋 조회(한 번만 돈다). */
export function sharedPs(ctx) {
  if (!ctx._ps) ctx._ps = Promise.resolve().then(() => ctx.psProbe([ctx.relayPort, ctx.facePort, ctx.installerPort, ctx.dashPort])).catch(() => ({ error: 'failed' }));
  return ctx._ps;
}
