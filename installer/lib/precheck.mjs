import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../lib/run.mjs';
import { isOffline } from '../../lib/net.mjs';

// docs/설계-v2.md 4-2 "검사표" is the source of truth for what each check
// means and whether it blocks. Summary:
//   BLOCKS:   os, arch, ntfs (a value was actually READ and it's bad),
//             disk (3GB, same condition), powershell (same condition),
//             ports (only a 'foreign' port blocks -- an IRIS-owned port
//             does not).
//   WARNS:    net (unreachable), browser (no default-browser association),
//             ntfs-unknown/disk-unknown/powershell-unknown (Task 26 -- the
//             probe never got a real answer at all; "we don't know" must
//             never be treated the same as "we checked and it's bad" -- see
//             the pushWarning calls below for the reasoning).
//   INFO ONLY (never blocks, never warns): existing, edge (presence -- its
//             ABSENCE also produces a warning, see below), sac.
// `recorded` carries every check's raw result verbatim (no user paths/names)
// for the package receipt; `info` is the curated subset the UI shows as
// plain information rather than a warning or a blocker.
const MIN_BUILD = 17763; // Windows 10 version 1809
const MIN_DISK_GB = 3; // v2: raised from 2GB (docs/설계-v2.md 4-2)
const NET_TARGETS = { claude: 'https://claude.ai/', chatgpt: 'https://chatgpt.com/' };
const BROWSER_ASSOC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
const EDGE_APP_PATHS_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe';
const SAC_POLICY_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy';
const SAC_POLICY_VALUE = 'VerifiedAndReputablePolicyState';

function checkOs() {
  try {
    const detail = os.release(); // e.g. '10.0.26200' on Windows
    const build = Number(detail.split('.')[2]);
    if (!Number.isFinite(build)) return { ok: false, build: null, detail };
    return { ok: build >= MIN_BUILD, build, detail };
  } catch (err) {
    return { ok: false, build: null, detail: String(err?.message ?? err) };
  }
}

function checkArch() {
  try {
    const value = os.arch();
    return { ok: value === 'x64', value };
  } catch (err) {
    return { ok: false, value: null, detail: String(err?.message ?? err) };
  }
}

// Any HTTP response (even 4xx/5xx) means the host is reachable -- only a
// network error or the timeout firing counts as unreachable.
async function probeReachable(url, timeoutMs, fetchFn) {
  try {
    await fetchFn(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

// info-only check (never blocks -- see the check table above), but it still
// must not touch the network under IRIS_INSTALLER_OFFLINE=1: verify/offline.mjs
// (Task 9) proves the whole `setup` run makes zero network calls, so this
// short-circuits to a `skipped-offline` result instead of calling fetchFn.
export async function checkNet(timeoutMs, { fetchFn = fetch, env = process.env } = {}) {
  if (isOffline(env)) {
    return { claude: false, chatgpt: false, ok: false, detail: 'skipped-offline' };
  }
  try {
    const [claude, chatgpt] = await Promise.all([
      probeReachable(NET_TARGETS.claude, timeoutMs, fetchFn),
      probeReachable(NET_TARGETS.chatgpt, timeoutMs, fetchFn),
    ]);
    return { claude, chatgpt, ok: claude && chatgpt };
  } catch (e) {
    return { claude: false, chatgpt: false, ok: false, detail: String(e?.message ?? e) };
  }
}

// Missing/unreadable default-browser association is warning-level, not a
// hard blocker -- Start-Process URL usually still works without it.
export async function checkBrowser(timeoutMs, { runFn = run } = {}) {
  try {
    const { code, out } = await runFn('reg.exe', ['query', BROWSER_ASSOC_KEY, '/v', 'ProgId'], { timeoutMs });
    const match = /ProgId\s+REG_SZ\s+(\S+)/.exec(out);
    if (code !== 0 || !match) return { ok: false, progId: null };
    return { ok: true, progId: match[1] };
  } catch (e) {
    return { ok: false, progId: null, detail: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// v2 additions (task-10-brief.md)
// ---------------------------------------------------------------------------

// Real-PC measurement (2026-09-15): `fsutil fsinfo volumeinfo C:` returns
// "Error 5: Access is denied" for a NON-elevated caller on this machine --
// fsutil's volumeinfo subcommand requires admin rights here, and the
// installer must never require elevation.
//
// Task 26 (VM matrix, 2026-09-16): the probe used to be `Get-Volume`, which
// loads the Storage module. Three fresh Win11 VMs all stopped at precheck
// with exactly one blocker (`ntfs-unknown`) because that module's first
// load is slow/WMI-heavy on a never-used image -- slow enough to miss even
// the doubled retry timeout from Task 25. `Get-CimInstance Win32_LogicalDisk`
// answers the same two questions (file system + free space) from the same
// underlying WMI data, without touching the Storage module, and without
// elevation.
function localAppDataDir(envFn = process.env) {
  return envFn.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

// Writability probe -- deliberately under %LOCALAPPDATA%\IRIS-Installer\,
// never directly under C:\ (the soul name/root is not decided yet at
// precheck time), but on the same NTFS volume so the result still answers
// "can this account write to C:'s filesystem".
// NEVER store e.message here -- Node fs errors embed the full failing path
// (e.g. "EPERM: mkdir '<user profile>\AppData\Local\IRIS-Installer'"), and
// that path contains the signed-in Windows account name. Only the error
// *code* (EPERM/EACCES/ENOENT/...) is path-free and safe to persist into
// recorded/the receipt.
function probeWritable(fsFn, envFn) {
  const dir = path.join(localAppDataDir(envFn), 'IRIS-Installer');
  const probePath = path.join(dir, `.precheck-write-${process.pid}-${Date.now()}.tmp`);
  try {
    fsFn.mkdirSync(dir, { recursive: true });
    fsFn.writeFileSync(probePath, 'ok');
    fsFn.unlinkSync(probePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e?.code || 'write-failed' };
  }
}

// ---------------------------------------------------------------------------
// Task 25 -- one merged PowerShell probe instead of three.
//
// checkDisk/checkNtfs/checkPowerShell each used to spawn their OWN
// powershell.exe inside the same Promise.all as everything else in
// precheck(). On a slow/fresh PC (2 vCPU VM, real measurement 2026-09-15) a
// cold PowerShell 5.1 start alone can take several seconds; three of them
// racing under a 4s-per-check timeout reliably lost, and each loss used to
// be reported as a *definite wrong answer* -- "C 드라이브 여유 공간이 3GB
// 미만" when the real free space was 44GB, "PowerShell 5.1 이상이 필요합니다"
// when 5.1 was already present. That is worse than not knowing: it blocks
// installation for a reason that never happened.
//
// The fix: one powershell.exe prints all values as one JSON object.
// `run()`'s own `timedOut` flag (lib/run.mjs) is the only source of truth for
// "this didn't finish in time" -- a killed process's exit code is not a
// reliable signal by itself. On a timeout the probe is retried exactly once
// at 2x the timeout (a cold start is a one-time cost; the retry is fast) --
// see runPsBundle(). Only if the retry also fails does each affected check
// report `unknown: true` instead of guessing a value.
//
// Task 26: `diskFreeBytes` and `volumeFileSystem` now come from ONE
// `Get-CimInstance Win32_LogicalDisk` call instead of separate `Get-PSDrive`
// and `Get-Volume` calls -- `Win32_LogicalDisk` carries both `FreeSpace` and
// `FileSystem` already, and unlike `Get-Volume` it never touches the Storage
// module (see the comment above `localAppDataDir` for why that mattered on
// a fresh VM image). The field names in the JSON are unchanged so
// checkDisk()/checkNtfs() below did not need to change at all. `if (-not
// $d) { throw ... }` guards the (practically impossible, but not
// PowerShell-impossible) case of no `C:` device -- WMI returning nothing is
// not an exception on its own, and a silent `$null.FreeSpace` would read as
// "0 bytes free" (a fabricated bad value) instead of "unknown".
const PS_BUNDLE_SCRIPT = [
  '$r = [ordered]@{}',
  'try { $r.psVersion = $PSVersionTable.PSVersion.ToString() } catch { $r.psVersion = $null }',
  'try { $r.languageMode = $ExecutionContext.SessionState.LanguageMode.ToString() } catch { $r.languageMode = $null }',
  'try { $d = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID=\'C:\'"; if (-not $d) { throw "no-c-drive" }; $r.diskFreeBytes = [int64]$d.FreeSpace; $r.volumeFileSystem = [string]$d.FileSystem } catch { $r.diskFreeBytes = $null; $r.volumeFileSystem = $null }',
  '$r | ConvertTo-Json -Compress',
].join('; ');

// Bundle result shapes returned by runPsBundle()/runPsBundleOnce():
//   { data: { diskFreeBytes, psVersion, languageMode, volumeFileSystem } }
//   { timedOut: true, detail }     -- run() itself marked this a kill, not a real exit
//   { probeFailed: true, detail }  -- spawn threw, non-zero exit, or unparsable output
async function runPsBundleOnce(timeoutMs, runFn) {
  let raw;
  try {
    raw = await runFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_BUNDLE_SCRIPT],
      { timeoutMs },
    );
  } catch (e) {
    // code only, never e.message -- see probeWritable's comment above; the
    // same rule applies to every probe that can end up in `recorded`.
    return { probeFailed: true, detail: e?.code || 'spawn-failed' };
  }
  if (raw?.timedOut) return { timedOut: true, detail: 'timed-out' };
  if (!raw || raw.code !== 0) {
    return { probeFailed: true, detail: raw?.err || raw?.out || `powershell exit ${raw?.code}` };
  }
  try {
    return { data: JSON.parse(raw.out) };
  } catch {
    return { probeFailed: true, detail: 'parse-failed' };
  }
}

// One spawn on the happy path. Only a genuine timeout earns a retry (at 2x
// the timeout) -- a spawn failure or bad output will not fix itself by
// trying again immediately, so those are reported as `probeFailed` right away.
export async function runPsBundle(timeoutMs, { runFn = run } = {}) {
  const first = await runPsBundleOnce(timeoutMs, runFn);
  if (!first.timedOut) return first;
  return runPsBundleOnce(timeoutMs * 2, runFn);
}

export function checkDisk(bundle) {
  if (bundle.timedOut || bundle.probeFailed) {
    return { ok: false, freeGB: 0, unknown: true, timedOut: !!bundle.timedOut, detail: bundle.detail };
  }
  const raw = bundle.data?.diskFreeBytes;
  const bytes = Number(raw);
  // `raw == null` catches the PS_BUNDLE_SCRIPT inner try/catch having set
  // diskFreeBytes to $null -- Number(null) is 0, which IS finite, so the
  // Number.isFinite check alone would misread "we never got a value" as a
  // genuine "0 bytes free" (a real, if extreme, bad-value case). Both must
  // be unknown, never a fabricated "3GB 미만".
  if (raw == null || !Number.isFinite(bytes)) {
    return { ok: false, freeGB: 0, unknown: true, detail: 'no-value' };
  }
  const freeGB = bytes / 1024 ** 3;
  return { ok: freeGB >= MIN_DISK_GB, freeGB };
}

export function checkNtfs(bundle, { fsFn = fs, envFn = process.env } = {}) {
  const writable = probeWritable(fsFn, envFn);
  if (bundle.timedOut || bundle.probeFailed) {
    return {
      ok: false,
      fsName: null,
      writable: writable.ok,
      unknown: true,
      timedOut: !!bundle.timedOut,
      detail: writable.detail ?? bundle.detail,
    };
  }
  const fsName = typeof bundle.data?.volumeFileSystem === 'string' ? bundle.data.volumeFileSystem.trim() : '';
  if (!fsName) {
    // The bundle round-trip itself succeeded, but the PS script's own inner
    // try/catch caught an error just for the Get-Volume call (see
    // PS_BUNDLE_SCRIPT) -- we still don't have a real value, so this is
    // "unknown", not "not NTFS".
    return { ok: false, fsName: null, writable: writable.ok, unknown: true, detail: writable.detail ?? 'no-value' };
  }
  const isNtfs = /^ntfs$/i.test(fsName);
  return { ok: isNtfs && writable.ok, fsName, writable: writable.ok, detail: writable.detail };
}

// PowerShell version + language mode, read from the merged bundle.
// A ConstrainedLanguage mode (company policy / device-guard style lockdown)
// gets its own message per task-10-brief.md; a probe that never completed
// gets the new "unknown" message instead of guessing a version shortfall.
export function checkPowerShell(bundle) {
  if (bundle.timedOut || bundle.probeFailed) {
    return { ok: false, version: null, languageMode: null, unknown: true, timedOut: !!bundle.timedOut, detail: bundle.detail };
  }
  const versionStr = typeof bundle.data?.psVersion === 'string' ? bundle.data.psVersion : null;
  const languageMode = typeof bundle.data?.languageMode === 'string' ? bundle.data.languageMode : null;
  const m = /^(\d+)\.(\d+)/.exec(versionStr || '');
  if (!m) {
    return { ok: false, version: versionStr, languageMode, unknown: true, detail: 'bad-version-string' };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const versionOk = major > 5 || (major === 5 && minor >= 1);
  const languageOk = languageMode === 'FullLanguage';
  return { ok: versionOk && languageOk, version: versionStr, languageMode };
}

// Ports 3456 (TeamClaude proxy) / 3457 (dashboard) / 3458 (Face daemon) /
// 3460 (this installer). Each entry's `path`+`match` was picked from a
// real-PC probe (2026-09-15, read-only `curl`) of what that service
// actually answers -- not a guess:
//   3456 GET /teamclaude/status -> JSON with an "activity" key (loopback
//        callers skip TeamClaude's API-key gate -- see its src/server.js).
//        (GET /health is NOT a local route on this proxy -- an unknown path
//        falls through to being relayed straight to the real
//        api.anthropic.com upstream and comes back as *its* 404 page, which
//        would misclassify a legitimate TeamClaude as "foreign".)
//   3457 GET /            -> HTML whose <title> contains "TeamClaude 대시보드".
//   3458 GET /api/health  -> JSON with about.name === 'IRIS' (Face daemon).
//   3460 GET /api/health  -> JSON with name === 'iris-installer' (this app).
// The response body is inspected only for these markers and is never stored
// in `recorded`/`info` -- 3456's /teamclaude/status body can contain a
// signed-in account's email, which must not be written to the receipt.
const PORT_PROBES = [
  {
    port: 3456,
    path: '/teamclaude/status',
    match: (body) => {
      try {
        const j = JSON.parse(body);
        return j !== null && typeof j === 'object' && ('activity' in j || 'accounts' in j);
      } catch {
        return false;
      }
    },
  },
  {
    port: 3457,
    path: '/',
    match: (body) => typeof body === 'string' && body.includes('TeamClaude'),
  },
  {
    port: 3458,
    path: '/api/health',
    match: (body) => {
      try {
        const j = JSON.parse(body);
        return j?.about?.name === 'IRIS' || j?.rootName === 'IRIS';
      } catch {
        return false;
      }
    },
  },
  {
    port: 3460,
    path: '/api/health',
    match: (body) => {
      try {
        const j = JSON.parse(body);
        return j?.name === 'iris-installer';
      } catch {
        return false;
      }
    },
  },
];

function defaultProbeOpen(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

async function probeOnePort(spec, timeoutMs, probeOpenFn, fetchFn) {
  let open;
  try {
    open = await probeOpenFn(spec.port, timeoutMs);
  } catch (e) {
    // A throwing TCP probe for this one port must not take the other three
    // ports down with it (Promise.all would otherwise reject as a whole).
    return { port: spec.port, state: 'unknown', detail: e?.code || 'probe-open-failed' };
  }
  if (!open) return { port: spec.port, state: 'free' };
  try {
    const res = await fetchFn(`http://127.0.0.1:${spec.port}${spec.path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    if (spec.match(body)) return { port: spec.port, state: 'iris' };
    return { port: spec.port, state: 'foreign', detail: `unrecognized response (status ${res.status})` };
  } catch (e) {
    // TCP-open but not answering HTTP the way any IRIS service does --
    // treated conservatively as someone else's program.
    return { port: spec.port, state: 'foreign', detail: String(e?.message ?? e) };
  }
}

export async function checkPorts(timeoutMs, { probeOpenFn = defaultProbeOpen, fetchFn = fetch } = {}) {
  try {
    const ports = await Promise.all(PORT_PROBES.map((spec) => probeOnePort(spec, timeoutMs, probeOpenFn, fetchFn)));
    const foreign = ports.filter((p) => p.state === 'foreign');
    return { ok: foreign.length === 0, ports, foreign };
  } catch (e) {
    return { ok: false, ports: [], foreign: [], detail: String(e?.message ?? e) };
  }
}

function edgeCandidatePaths(envFn) {
  const pf86 = envFn['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = envFn.ProgramFiles || 'C:\\Program Files';
  return [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
}

// Never a blocker -- absence just means browser-automation features stay
// `pending` until Edge is installed (docs/설계-v2.md 4-2).
export async function checkEdge(timeoutMs, { existsFn = fs.existsSync, runFn = run, envFn = process.env } = {}) {
  try {
    for (const candidate of edgeCandidatePaths(envFn)) {
      if (existsFn(candidate)) return { ok: true, present: true, path: candidate, source: 'file' };
    }
    const { code, out } = await runFn('reg.exe', ['query', EDGE_APP_PATHS_KEY], { timeoutMs });
    if (code === 0) {
      const match = /REG_SZ\s+(.+\.exe)\s*$/im.exec(out);
      return { ok: true, present: true, path: match ? match[1].trim() : null, source: 'registry' };
    }
    return { ok: true, present: false, path: null };
  } catch (e) {
    return { ok: false, present: false, path: null, detail: String(e?.message ?? e) };
  }
}

// Smart App Control state -- recorded only, never blocks and never warns on
// its own (task-10-brief.md). Missing key/value (no `reg query` match) means
// SAC has never been configured on this machine, which reg.exe reports as a
// non-zero exit -- that is recorded as state 0 (off), not an error.
export async function checkSac(timeoutMs, { runFn = run } = {}) {
  try {
    const { code, out } = await runFn('reg.exe', ['query', SAC_POLICY_KEY, '/v', SAC_POLICY_VALUE], { timeoutMs });
    if (code !== 0) return { ok: true, state: 0, detail: 'key-not-found' };
    const match = new RegExp(`${SAC_POLICY_VALUE}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)`).exec(out);
    return { ok: true, state: match ? parseInt(match[1], 16) : 0 };
  } catch (e) {
    return { ok: true, state: 0, detail: String(e?.message ?? e) };
  }
}

// The soul root is always C:\IRIS except on the developer PC rehearsing the
// installer (IRIS_INSTALLER_SOUL_NAME) -- same override server.mjs itself
// uses (docs/설계-v2.md 11절 / server.mjs soulName default).
function resolveSoulRoot(envFn) {
  const name = envFn.IRIS_INSTALLER_SOUL_NAME || 'IRIS';
  return `C:\\${name}`;
}

// Never a blocker -- an existing package-receipt.json means "offer
// resume/reinstall", not "stop" (task-10-brief.md / 검사표 "기존 설치" row).
export function checkExisting({ fsFn = fs, envFn = process.env } = {}) {
  const receiptPath = path.join(resolveSoulRoot(envFn), '_agent', 'setup', 'package-receipt.json');
  try {
    const raw = fsFn.readFileSync(receiptPath, 'utf8');
    const json = JSON.parse(raw);
    return { ok: true, exists: true, schema: json?.schema ?? null, packageVersion: json?.package?.version ?? null };
  } catch {
    return { ok: true, exists: false, schema: null, packageVersion: null };
  }
}

function pushBlocker(blockers, id, message) {
  blockers.push({ id, message });
}

function pushWarning(warnings, id, message) {
  warnings.push({ id, message });
}

// precheck({timeoutMs=15000}) -> see docs/설계-v2.md 4-2 for the full check
// table and docs/task-11-brief.md for how the wizard screen consumes this.
// Never throws -- every probe above is individually wrapped so one failing
// check (e.g. no network, or a `reg.exe` that errors out) still yields a
// complete, well-shaped result.
//
// Task 25: disk/ntfs/powershell no longer spawn three separate
// powershell.exe processes inside this function's Promise.all -- they are
// now pure formatters over ONE merged probe (runPsBundle(), which itself
// retries once at 2x timeoutMs on a timeout; see the comment above
// PS_BUNDLE_SCRIPT). The default timeoutMs was raised from 4000 to 15000 for
// the same reason: a cold PowerShell 5.1 start on a fresh/slow PC can take
// several seconds on its own. The remaining checks (net/browser/ports/edge/
// sac) are cheap and stay in a Promise.all, run AFTER the merged probe.
//
// Result shape:
//   { blockers: [{id, message}], warnings: [{id, message}], info: {...},
//     recorded: {...}, os, arch, disk, net, browser, allOk, canProceedOffline }
// The last four (plus os/arch/disk/net/browser) are the PRE-v2 compatibility
// fields server.mjs already reads; they are computed with the exact same
// formula as before this task so nothing that reads them today breaks. The
// server is rewired onto the new blockers/warnings/info/recorded shape in
// Task 11 -- this task only adds the new shape alongside the old one.
export async function precheck({ timeoutMs = 15000, deps = {} } = {}) {
  const osResult = checkOs();
  const arch = checkArch();
  const bundle = await runPsBundle(timeoutMs, deps);
  const disk = checkDisk(bundle);
  const ntfs = checkNtfs(bundle, deps);
  const powershell = checkPowerShell(bundle);
  const [net_, browser, ports, edge, sac] = await Promise.all([
    checkNet(timeoutMs, deps),
    checkBrowser(timeoutMs, deps),
    checkPorts(timeoutMs, deps),
    checkEdge(timeoutMs, deps),
    checkSac(timeoutMs, deps),
  ]);
  const existing = checkExisting(deps);

  // --- pre-v2 compatibility fields (unchanged formula) ------------------
  const allOk = osResult.ok && arch.ok && disk.ok && net_.ok && browser.ok;
  const canProceedOffline = osResult.ok && arch.ok && disk.ok && browser.ok;

  // --- v2 blockers/warnings/info -----------------------------------------
  const blockers = [];
  const warnings = [];

  if (!osResult.ok) {
    pushBlocker(blockers, 'os', 'Windows 10(2018년 10월 업데이트, 빌드 17763) 이상 또는 Windows 11이 필요합니다. 이 PC는 지원 범위 밖입니다.');
  }
  if (!arch.ok) {
    pushBlocker(blockers, 'arch', '지원하지 않는 CPU입니다. 64비트(x64) PC에서만 설치할 수 있습니다.');
  }
  // Task 25 established the wording rule: a probe that never got a real
  // answer (timeout, spawn failure, or the merged PS script's own inner
  // try/catch coming back empty) must never be reported with the
  // definite-failure wording -- that wording is reserved for a probe that
  // actually READ a bad value.
  //
  // Task 26 (VM matrix, 2026-09-16): Task 25 gave "unknown" its own honest
  // wording but still routed it into `blockers`, so it kept blocking
  // installation exactly like a real failure did -- three fresh Win11 VMs
  // all stopped dead at precheck on `ntfs-unknown` alone, even though NTFS
  // was in fact present. "We couldn't check" is not "it's broken": moved to
  // `warnings` (proceed allowed) instead. Rationale for why proceeding is
  // safe: PowerShell 5.1 provably exists (bootstrap.ps1, which is pure
  // PowerShell, is what got this far); the writability probe (probeWritable,
  // above) already guards the actual write path independently of this
  // probe; and a genuinely non-NTFS or too-full C: drive still surfaces
  // later, when unpacking the payload fails with a clear error code --
  // silence here is not the last line of defense. A probe that DID read a
  // real value, even a bad one, is unaffected and still blocks exactly as
  // before.
  if (ntfs.unknown) {
    pushWarning(warnings, 'ntfs-unknown', '파일 시스템을 확인하지 못했습니다. 설치는 계속할 수 있지만 문제가 생기면 「다시 확인」을 눌러 주세요.');
  } else if (!ntfs.ok) {
    const msg = !/^ntfs$/i.test(ntfs.fsName || '')
      ? 'C 드라이브가 NTFS 형식이 아닙니다. IRIS는 NTFS 드라이브에만 설치할 수 있습니다.'
      : 'C 드라이브에 쓰기 권한이 없습니다. 쓰기 가능한 계정으로 다시 시도하세요.';
    pushBlocker(blockers, 'ntfs', msg);
  }
  if (disk.unknown) {
    pushWarning(warnings, 'disk-unknown', 'C 드라이브 여유 공간을 확인하지 못했습니다. 설치는 계속할 수 있지만 문제가 생기면 「다시 확인」을 눌러 주세요.');
  } else if (!disk.ok) {
    pushBlocker(blockers, 'disk', `C 드라이브 여유 공간이 ${MIN_DISK_GB}GB 미만입니다. 공간을 확보한 뒤 다시 시도하세요.`);
  }
  if (powershell.unknown) {
    pushWarning(warnings, 'powershell-unknown', 'PowerShell 상태를 확인하지 못했습니다. 설치는 계속할 수 있지만 문제가 생기면 「다시 확인」을 눌러 주세요.');
  } else if (!powershell.ok) {
    const msg = powershell.languageMode && powershell.languageMode !== 'FullLanguage'
      ? '회사 정책이 PowerShell 스크립트를 제한하고 있습니다.'
      : 'PowerShell 5.1 이상이 필요합니다.';
    pushBlocker(blockers, 'powershell', msg);
  }
  for (const foreignPort of ports.foreign ?? []) {
    pushBlocker(blockers, `port-${foreignPort.port}`, `포트 ${foreignPort.port}번을 다른 프로그램이 사용하고 있어 설치를 진행할 수 없습니다. 그 프로그램을 종료하거나 재부팅한 뒤 다시 시도하세요.`);
  }

  if (!net_.ok) {
    pushWarning(warnings, 'net', '인터넷 연결을 확인하지 못했습니다. 인터넷은 로그인 단계에서 필요합니다.');
  }
  if (!browser.ok) {
    pushWarning(warnings, 'browser', '기본 브라우저 설정을 확인하지 못했습니다. 없으면 Edge로 엽니다.');
  }
  if (!edge.present) {
    pushWarning(warnings, 'edge', 'Edge 브라우저를 찾지 못했습니다. 브라우저 조작 기능은 설치 후 대기 상태로 남습니다.');
  }

  const info = {
    net: net_,
    browser,
    edge,
    sac,
    existing,
    ports: ports.ports,
  };

  const recorded = {
    os: osResult, arch, disk, net: net_, browser,
    ntfs, powershell, ports: ports.ports, edge, sac, existing,
  };

  return {
    blockers, warnings, info, recorded,
    // compatibility fields (see comment above precheck()):
    os: osResult, arch, disk, net: net_, browser, allOk, canProceedOffline,
  };
}
