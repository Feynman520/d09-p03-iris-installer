// 조각 ⑥ — 온라인 묶음 (docs/설계-v2.md 7절, docs/설치기-API-v2.md `POST /api/online/*`).
//
// Everything this module does needs the internet, and nothing it does may ever
// cost a subscription token: the ONLY process it ever runs against a model
// vendor is `claude.exe --version`. No request is ever made to
// api.anthropic.com, and ANTHROPIC_BASE_URL is never changed or unset by this
// module (the one designed exception -- a login console started WITHOUT the
// proxy variable -- lives in lib/login.mjs's startCliLogin and is reused here
// as-is, not re-implemented).
//
// Five entry points, matching lib/adapters/online-runner.mjs's header:
//   checkNet({ subscriptions })   -> { ok, blocked:[host…], checked:[host…] }
//   installClaude({ root, … })    -> { ok, state, source, code }
//   startLogin({ provider, … })   -> { ok, state, reused }
//   loginStatus({ provider, … })  -> { state, cli, relay, reason }
//   startRelay({ root, … })       -> { ok, state, accounts }
//
// Source order for Claude Code (controller ruling after the Task 4 experiment,
// .superpowers/sdd/구현계획-v2/task-4-report.md §2 — this REVERSES the order the
// task brief was written with):
//   출처 1 = downloads.claude.ai  -- a single self-contained claude.exe with an
//            official manifest.json checksum. It runs from wherever it is put,
//            so the soul folder gets it directly and the machine's own
//            %USERPROFILE%\.local\bin / PATH are never touched.
//   출처 2 = npm prefix (lock.parts.claude.fallback) -- the v1 mechanism,
//            reused verbatim from lib/install.mjs so there is one npm path.
//
// User-facing strings: Korean, one sentence, and never the relay's product
// name -- the person reads "계정 연결"/"중계기" (설계-v2 7절).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { run } from '../../lib/run.mjs';
import { extractZip, listArchive } from '../../lib/zip.mjs';
import { isOffline, assertOnline } from '../../lib/net.mjs';
import { assertInside } from './paths.mjs';
import { defaultNpmInstall } from './install.mjs';
import {
  startCliLogin, cliLoginStatus, relayImport, relayStatus,
  countProviderAccounts, resolveTeamclaudeConfigPath, ensureRelayConfigDefaults,
} from './login.mjs';
import { ensureProxy } from './proxy.mjs';
import { readReceipt, writeReceipt, setInstalled } from './receipt.mjs';
import { writeShims } from './shims.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const RELAY_PORT = 3456;
export const NET_TIMEOUT_MS = 5000;
// 설계-v2 7절 진단 ⓐ: 「다시 열기」는 2분 — the same 2 minutes is how long a
// login may sit with no credential file before it is called a closed window.
export const LOGIN_WINDOW_MS = 120000;
// How long the relay hand-over may stay unfinished after the automatic
// `teamclaude login` retry before it is reported as a hard failure.
export const RELAY_GRACE_MS = 180000;

// Probed hosts. `downloads.claude.ai` and `registry.npmjs.org` are the two
// SOURCES for the same download (either one alone is enough); `claude.ai` and
// `chatgpt.com` are the login pages, which have no alternative.
export const HOSTS = {
  claudeDownloads: 'https://downloads.claude.ai/',
  claudeLogin: 'https://claude.ai/',
  chatgpt: 'https://chatgpt.com/',
  npmRegistry: 'https://registry.npmjs.org/',
};

export const CODES = {
  net: 'E-ONLINE-NET',
  claude: 'E-ONLINE-CLAUDE',
  documentSkills: 'E-ONLINE-DOCSKILLS',
  relay: 'E-ONLINE-RELAY',
};

// The sentence 설계-v2 7절 requires on the offline stop. The server (with
// T18's setup/handoff.mjs) is what writes handoff.json `state:'login-pending'`;
// this module only hands back the blocked list and this sentence.
export const RESUME_SENTENCE = '인터넷이 되는 곳에서 설치기를 다시 열면 여기서부터 이어집니다.';

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

export function toolsDir(root) {
  return path.join(root, '_agent', 'shared', 'tools');
}

export function claudeDir(root) {
  return path.join(toolsDir(root), 'claude');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return String(url); }
}

function relToRoot(root, abs) {
  return path.relative(root, abs).split(path.sep).join('\\');
}

// lock.json travels in the zip next to installer/ and also lives at the repo
// root — same resolution order server.mjs uses.
export function readLock({ zipRoot, readFileSync = fs.readFileSync } = {}) {
  const candidates = [
    zipRoot ? path.join(zipRoot, 'lock.json') : null,
    path.resolve(HERE, '..', '..', 'lock.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* try next */ }
  }
  return null;
}

// Which subscriptions this install is for. The server passes them explicitly
// on checkNet but not on installClaude, so the receipt is the fallback and
// "claude" is the last resort (the server only calls installClaude when claude
// was chosen, so defaulting to "chosen" never skips a wanted install).
function resolveSubscriptions(subscriptions, root, readReceiptFn) {
  if (Array.isArray(subscriptions)) return subscriptions;
  try {
    const subs = readReceiptFn?.(root)?.choice?.subscriptions;
    if (Array.isArray(subs)) return subs;
  } catch { /* no receipt yet */ }
  return ['claude'];
}

function activeAgentsOf(subscriptions) {
  const agents = [];
  if (subscriptions.includes('claude')) agents.push('claude');
  if (subscriptions.includes('chatgpt')) agents.push('codex');
  return agents;
}

// Read-modify-write on the receipt. Every call re-reads, because the engine and
// the server write the same file and this module is called from poll routes.
// NOTHING secret is ever put in here: booleans, counts, paths, versions only.
function patchReceipt(root, mutate, { readReceiptFn = readReceipt, writeReceiptFn = writeReceipt } = {}) {
  try {
    const receipt = readReceiptFn(root);
    if (!receipt) return null;
    mutate(receipt);
    writeReceiptFn(root, receipt);
    return receipt;
  } catch {
    // A receipt that cannot be written must never take the online step down:
    // the screen state is authoritative for the run in progress.
    return null;
  }
}

function loginRecord(root, provider, readReceiptFn = readReceipt) {
  try { return readReceiptFn(root)?.login?.[provider] ?? null; } catch { return null; }
}

function setLoginRecord(root, provider, patch, deps) {
  return patchReceipt(root, (receipt) => {
    receipt.login = receipt.login ?? {};
    receipt.login[provider] = { ...(receipt.login[provider] ?? {}), ...patch, at: new Date().toISOString() };
  }, deps);
}

// ---------------------------------------------------------------------------
// ⑥-1 인터넷 확인
// ---------------------------------------------------------------------------

/**
 * Is one host answering at all? Any HTTP status (403, 404, 405…) counts as
 * reachable — only a network error or a timeout is "blocked", which is exactly
 * the distinction a school/office firewall creates. HEAD first (cheap), GET
 * once as a retry because some of these hosts refuse HEAD outright.
 */
export async function probeHost(url, { fetchFn = fetch, timeoutMs = NET_TIMEOUT_MS, env = process.env } = {}) {
  assertOnline(`probeHost ${url}`, env);
  const attempt = async (method) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { method, redirect: 'follow', signal: ac.signal });
      try { await res?.body?.cancel?.(); } catch { /* nothing to drain */ }
      return { reachable: true, status: res?.status ?? null, method };
    } catch (err) {
      return { reachable: false, status: null, method, error: String(err?.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
  };
  const head = await attempt('HEAD');
  if (head.reachable) return head;
  const get = await attempt('GET');
  return get.reachable ? get : head;
}

/**
 * ⑥-1. Probe only the hosts the chosen subscriptions actually need.
 *
 * `ok` is false only when a REQUIRED host is blocked:
 *   - claude 선택  -> claude.ai (login, no alternative) is required, and at
 *                    least ONE of downloads.claude.ai / registry.npmjs.org
 *                    must answer (they are two sources for the same file).
 *   - chatgpt 선택 -> chatgpt.com is required.
 * npm blocked on its own is therefore ok:true with a note — 출처 1 covers it.
 *
 * @returns {Promise<{ok:boolean, blocked:string[], checked:string[], results:object[], notes:string[], code?:string, message?:string}>}
 */
export async function checkNet({
  subscriptions, root, lock, zipRoot,
  probe = probeHost, fetchFn = fetch, timeoutMs = NET_TIMEOUT_MS,
  readReceiptFn = readReceipt, log = () => {}, env = process.env,
} = {}) {
  // Offline proof (verify/offline.mjs): this entry point has its own
  // {ok,blocked,checked,results,notes,message} contract (lib/adapters/
  // online-runner.mjs's call() does not catch a throw from the module
  // function itself, only from the dynamic import), so -- same shape as
  // lib/precheck.mjs's checkNet -- it reports a graceful "checked nothing"
  // result instead of throwing.
  if (isOffline(env)) {
    return {
      ok: false, blocked: [], checked: [], results: [], notes: ['skipped-offline'],
      code: CODES.net, message: `오프라인 모드라 인터넷 확인을 건너뛰었습니다. ${RESUME_SENTENCE}`,
    };
  }

  const subs = resolveSubscriptions(subscriptions, root, readReceiptFn);
  const wantClaude = subs.includes('claude');
  const wantChatgpt = subs.includes('chatgpt');

  const targets = [];
  if (wantClaude) {
    targets.push({ url: HOSTS.claudeDownloads, role: 'claude-source' });
    targets.push({ url: HOSTS.npmRegistry, role: 'claude-source' });
    targets.push({ url: HOSTS.claudeLogin, role: 'required' });
  }
  if (wantChatgpt) targets.push({ url: HOSTS.chatgpt, role: 'required' });

  const results = [];
  for (const t of targets) {
    const r = await probe(t.url, { fetchFn, timeoutMs });
    results.push({ host: hostOf(t.url), url: t.url, role: t.role, reachable: r.reachable === true, status: r.status ?? null });
    log(`net ${hostOf(t.url)} ${r.reachable ? `ok(${r.status ?? '-'})` : 'blocked'}`);
  }

  const checked = results.map((r) => r.host);
  const blocked = results.filter((r) => !r.reachable).map((r) => r.host);
  const reachable = (host) => results.some((r) => r.host === host && r.reachable);

  const notes = [];
  let ok = true;

  for (const r of results) {
    if (r.role === 'required' && !r.reachable) ok = false;
  }
  if (wantClaude) {
    const sourcesUp = reachable(hostOf(HOSTS.claudeDownloads)) || reachable(hostOf(HOSTS.npmRegistry));
    if (!sourcesUp) ok = false;
    else if (!reachable(hostOf(HOSTS.npmRegistry))) notes.push('npm 저장소가 막혀 있지만 Claude Code는 공식 내려받기 주소로 받을 수 있습니다.');
    else if (!reachable(hostOf(HOSTS.claudeDownloads))) notes.push('공식 내려받기 주소가 막혀 있지만 Claude Code는 npm 저장소로 받을 수 있습니다.');
  }

  if (ok) return { ok: true, blocked, checked, results, notes, message: null };

  return {
    ok: false,
    blocked,
    checked,
    results,
    notes,
    code: CODES.net,
    message: `${blocked.join(', ')} 주소에 연결하지 못했습니다. ${RESUME_SENTENCE}`,
  };
}

// ---------------------------------------------------------------------------
// ⑥-2 Claude Code 내려받기
// ---------------------------------------------------------------------------

// The thin forwarder that makes <tools>\claude\claude.cmd point at the
// versioned exe, so the PATH shim written by lib/shims.mjs (which calls
// `%~dp0..\tools\claude\claude.cmd`) works for source 1 exactly as it does for
// the npm layout of source 2. ASCII + CRLF, same two hard constraints as
// shims.mjs (a .cmd is read in the console's OEM codepage).
export function claudeForwarderText(version, binName = 'claude.exe') {
  return [
    '@echo off',
    'setlocal',
    `"%~dp0${version}\\${binName}" %*`,
    'exit /b %errorlevel%',
  ].join('\r\n') + '\r\n';
}

async function sha256File(file, { createReadStream = fs.createReadStream } = {}) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = createReadStream(file);
    s.on('data', (d) => hash.update(d));
    s.on('end', resolve);
    s.on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * Stream a URL to `dest`, hashing as it goes, reporting {done,total} bytes.
 * Returns the sha256 of what actually landed on disk.
 */
export async function downloadToFile(url, dest, {
  fetchFn = fetch, onProgress = () => {}, expectedBytes = null, timeoutMs = 600000,
  createWriteStream = fs.createWriteStream, env = process.env,
} = {}) {
  assertOnline(`downloadToFile ${url}`, env);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { redirect: 'follow', signal: ac.signal });
    if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'} ${url}`);
    const header = Number(res.headers?.get?.('content-length'));
    const total = Number.isFinite(header) && header > 0 ? header : (expectedBytes ?? null);

    const hash = crypto.createHash('sha256');
    let done = 0;
    const out = createWriteStream(dest);
    const body = typeof res.body?.[Symbol.asyncIterator] === 'function'
      ? res.body
      : Readable.fromWeb(res.body);

    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      done += buf.length;
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      try { onProgress({ done, total }); } catch { /* listener errors never break a download */ }
    }
    await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
    return { sha256: hash.digest('hex'), bytes: done, total };
  } finally {
    clearTimeout(timer);
  }
}

function recordClaude(root, info, deps) {
  patchReceipt(root, (receipt) => { setInstalled(receipt, 'claude', info); }, deps);
}

/**
 * ⑥-2. Put Claude Code in the soul, or say exactly why it could not be.
 *
 * States: `skipped` (no claude subscription) · `done` · `failed`.
 * Sources: `existing` (already the locked version) · `claude.ai` · `npm`.
 *
 * @returns {Promise<{ok:boolean, state:string, source?:string, version?:string, path?:string, code?:string, message?:string, detail?:any}>}
 */
export async function installClaude({
  root, nodeDir, lock, zipRoot, subscriptions,
  onProgress = () => {}, log = () => {},
  fetchFn = fetch, runFn = run,
  npmInstall = defaultNpmInstall,
  writeShimsFn = writeShims,
  readReceiptFn = readReceipt, writeReceiptFn = writeReceipt,
  fsImpl = fs,
  downloadFn = downloadToFile,
  hashFileFn = sha256File,
  env = process.env,
} = {}) {
  const deps = { readReceiptFn, writeReceiptFn };
  const subs = resolveSubscriptions(subscriptions, root, readReceiptFn);

  // --- not chosen: recorded as a deliberate non-install, never as a failure --
  if (!subs.includes('claude')) {
    recordClaude(root, { state: 'not-installed', reason: 'subscription-not-selected' }, deps);
    log('claude skipped (subscription not selected)');
    return { ok: true, state: 'skipped', source: null };
  }

  const theLock = lock ?? readLock({ zipRoot });
  const part = theLock?.parts?.claude;
  if (!part?.version || !part?.url || !part?.manifestUrl || !part?.sha256) {
    const message = 'Claude Code 내려받기 정보를 찾지 못했습니다.';
    recordClaude(root, { state: 'failed', reason: 'lock-missing', verified: false }, deps);
    return { ok: false, state: 'failed', code: CODES.claude, message, detail: 'lock.parts.claude incomplete' };
  }

  const version = part.version;
  const binName = part.binName ?? 'claude.exe';
  const dir = claudeDir(root);
  const versionDir = path.join(dir, version);
  const exePath = path.join(versionDir, binName);
  const partPath = `${exePath}.part`;
  const cmdPath = path.join(dir, 'claude.cmd');

  // `--version` only. This is the single process this module ever runs against
  // a model vendor's CLI, and it makes no model request.
  // Node refuses to spawn a .bat/.cmd directly since 18.20/20.12 (the
  // CVE-2024-27980 fix), so a .cmd is run through cmd.exe the way the rest of
  // the installer does it.
  const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  // 2026-09-16 VM S01 실측(2 vCPU, 깨끗한 Windows 11): 갓 내려받은 230MB claude.exe 의
  // **첫** 실행은 Defender 실시간 검사 때문에 몇 분이 걸릴 수 있다(같은 손님에서 두 번째
  // 실행은 35초). 첫 실행이 제한 시간에 걸리면 출처 1 전체가 "실패"로 적히고 npm 폴백까지
  // 같은 이유로 넘어져 E-ONLINE-CLAUDE 가 났다. 그래서 제한을 5분으로 늘리고, 시간 초과일
  // 때만 한 번 더 시도한다(두 번째는 검사가 끝난 뒤라 빠르다).
  // 같은 날 두 번째 실측(log 를 연결한 뒤): 실제 사유는 시간 초과가 아니라 **`spawn EBUSY`** —
  // 방금 받아 이름을 바꾼 230MB claude.exe 를 Defender 가 아직 훑고 있어 잠시 실행이 막힌다.
  // 그래서 EBUSY/EACCES/EPERM 이면 15초 쉬고 다시(최대 3분), 시간 초과면 한 번만 더 시도한다.
  const PROBE_TIMEOUT_MS = 300000;
  const PROBE_BUSY_WAIT_MS = 15000;
  const PROBE_MAX_ATTEMPTS = 12;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const probeVersion = async (exe, wanted = version) => {
    // 2026-09-17 VM S01 5차 실측: .cmd 를 여기서 한 번 더 cmd.exe 로 감싸면 Node 가 인자를
    // 다시 따옴표로 싸서 cmd 가 `'"C:\...\claude.cmd"'은(는) … 명령이 아닙니다` 로 거절한다
    // (npm 폴백이 설치까지 성공하고 확인에서 넘어졌다). `lib/run.mjs` 가 .cmd/.bat 을
    // 스스로 `cmd /d /s /c` + windowsVerbatimArguments 로 돌리므로 그대로 넘긴다.
    let last = null;
    let timeoutRetried = false;
    for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt += 1) {
      const r = await runFn(exe, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
      const out = `${r.out ?? ''}${r.err ?? ''}`;
      last = { ok: r.code === 0 && out.includes(wanted), out: out.slice(0, 200), code: r.code, attempts: attempt };
      if (last.ok || r.code === 0) break;
      const busy = /\b(EBUSY|EACCES|EPERM)\b/.test(out);
      const timedOut = r.timedOut === true || r.code === null;
      log(`claude --version probe attempt ${attempt} failed (code=${r.code}${timedOut ? ', timed out' : ''}): ${out.slice(0, 120).replace(/\s+/g, ' ')}`);
      if (busy) { await sleep(PROBE_BUSY_WAIT_MS); continue; }
      if (timedOut && !timeoutRetried) { timeoutRetried = true; continue; }
      break;
    }
    return last;
  };

  // --- already there and already the locked version -> nothing to download ---
  for (const candidate of [exePath, cmdPath]) {
    if (!fsImpl.existsSync(candidate)) continue;
    const probe = await probeVersion(candidate);
    if (probe.ok) {
      log(`claude already installed version=${version} via=${path.basename(candidate)}`);
      recordClaude(root, {
        state: 'installed', version, source: 'existing',
        path: relToRoot(root, candidate === exePath ? versionDir : dir),
        sha256: candidate === exePath ? part.sha256 : null,
        verified: true, active: true,
      }, deps);
      return { ok: true, state: 'done', source: 'existing', version, path: candidate };
    }
  }

  const failures = [];

  // ------------------------------------------------------------------ 출처 1
  // downloads.claude.ai: manifest checksum -> stream -> sha256 -> rename ->
  // --version -> shim. The .part name means a half-finished download can never
  // be mistaken for an installed binary, and a checksum mismatch deletes it
  // without ever creating claude.exe.
  try {
    onProgress({ phase: 'manifest', source: 'claude.ai', done: 0, total: part.bytes ?? null });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), NET_TIMEOUT_MS * 4);
    let manifest;
    try {
      assertOnline('claude manifest fetch', env);
      const res = await fetchFn(part.manifestUrl, { redirect: 'follow', signal: ac.signal });
      if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'} manifest.json`);
      manifest = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const officialSha = String(manifest?.platforms?.['win32-x64']?.checksum ?? '').toLowerCase();
    const lockedSha = String(part.sha256).toLowerCase();
    if (officialSha !== lockedSha) {
      // The official manifest and our lock disagree: the pinned version was
      // re-published, or something is in the way. Either way source 1 is not
      // trustworthy right now -- BOTH values go in the log so the mismatch can
      // be judged later, and 출처 2 (whose integrity comes from the lock too)
      // gets its turn.
      log(`claude source1 manifest mismatch official=${officialSha || 'none'} lock=${lockedSha}`);
      throw new Error(`manifest checksum mismatch (official=${officialSha || 'none'}, lock=${lockedSha})`);
    }

    fsImpl.mkdirSync(versionDir, { recursive: true });
    if (fsImpl.existsSync(partPath)) fsImpl.rmSync(partPath, { force: true });

    const started = Date.now();
    const got = await downloadFn(part.url, partPath, {
      fetchFn,
      expectedBytes: part.bytes ?? null,
      onProgress: (p) => { try { onProgress({ phase: 'download', source: 'claude.ai', ...p }); } catch { /* ignore */ } },
    });

    if (got.sha256.toLowerCase() !== lockedSha) {
      // Never rename a file whose fingerprint is wrong -- the .part goes away
      // and claude.exe is never created.
      try { fsImpl.rmSync(partPath, { force: true }); } catch { /* best effort */ }
      throw new Error(`sha256 mismatch (got=${got.sha256}, want=${lockedSha})`);
    }

    if (fsImpl.existsSync(exePath)) fsImpl.rmSync(exePath, { force: true });
    fsImpl.renameSync(partPath, exePath);

    const probe = await probeVersion(exePath);
    if (!probe.ok) throw new Error(`--version did not report ${version} (${probe.out})`);

    fsImpl.writeFileSync(cmdPath, claudeForwarderText(version, binName), 'ascii');
    const shims = writeShimsFn(root, activeAgentsOf(subs));

    const seconds = Math.round((Date.now() - started) / 100) / 10;
    log(`claude source=claude.ai version=${version} bytes=${got.bytes} seconds=${seconds}`);
    recordClaude(root, {
      state: 'installed', version, source: 'claude.ai',
      path: relToRoot(root, versionDir), sha256: lockedSha,
      bytes: got.bytes, verified: true, active: true,
    }, deps);
    return {
      ok: true, state: 'done', source: 'claude.ai', version,
      path: exePath, sha256: lockedSha, bytes: got.bytes, shims: shims?.written?.length ?? 0,
    };
  } catch (err) {
    const detail = String(err?.message ?? err);
    failures.push({ source: 'claude.ai', detail });
    log(`claude source1 failed: ${detail}`);
  }

  // ------------------------------------------------------------------ 출처 2
  // npm prefix, exactly the v1 mechanism (lib/install.mjs `npm-download`):
  // npm itself verifies the tarball against the registry's integrity, and the
  // integrity we pinned (lock.parts.claude.fallback.integrity) is recorded on
  // the receipt beside the version that actually landed.
  const fb = part.fallback ?? {};
  try {
    if (!fb.npm || !fb.version) throw new Error('lock.parts.claude.fallback incomplete');
    const soulNode = path.join(toolsDir(root), 'node');
    const nodeBase = fsImpl.existsSync(path.join(soulNode, 'node.exe')) ? soulNode : (nodeDir ?? soulNode);
    const nodeExe = path.join(nodeBase, 'node.exe');
    const npmCli = path.join(nodeBase, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const cacheDir = path.join(root, '_agent', 'runtime', 'host', 'npm-cache');
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.mkdirSync(cacheDir, { recursive: true });

    onProgress({ phase: 'npm', source: 'npm', done: 0, total: null });
    assertOnline(`claude npm fallback install ${fb.npm}@${fb.version}`, env);
    const r = await npmInstall({ nodeExe, npmCli, prefix: dir, cacheDir, spec: `${fb.npm}@${fb.version}` });
    if (r.code !== 0) throw new Error((r.err || r.out || 'npm failed').slice(0, 300));

    const probe = await probeVersion(cmdPath, fb.version);
    if (!probe.ok) throw new Error(`--version did not report ${fb.version} (${probe.out})`);

    const shims = writeShimsFn(root, activeAgentsOf(subs));
    log(`claude source=npm version=${fb.version}`);
    recordClaude(root, {
      state: 'installed', version: fb.version, source: 'npm',
      path: relToRoot(root, dir), sha256: null, integrity: fb.integrity ?? null,
      verified: true, active: true,
    }, deps);
    return { ok: true, state: 'done', source: 'npm', version: fb.version, path: cmdPath, shims: shims?.written?.length ?? 0 };
  } catch (err) {
    const detail = String(err?.message ?? err);
    failures.push({ source: 'npm', detail });
    log(`claude source2 failed: ${detail}`);
  }

  const message = 'Claude Code를 두 곳 모두에서 내려받지 못했습니다.';
  recordClaude(root, { state: 'failed', version, verified: false, reason: 'download-failed', sources: failures.map((f) => f.source) }, deps);
  return { ok: false, state: 'failed', source: null, code: CODES.claude, message, detail: failures };
}

// ---------------------------------------------------------------------------
// ⑥-2b document-skills 내려받기 (설계-v2 13절 "document-skills: 설치 시 내려받기")
// ---------------------------------------------------------------------------
//
// 이 부품 하나만 허가서가 재배포를 막아 zip 에 들어 있지 않다(`redistribute:
// download`). ⑤-6 어댑터 단계는 "폴더가 있으면 등록, 없으면 대기"만 하고, 실제로
// 가져오는 것은 여기다 — 그러고 나서 **같은 등록 함수**(`setup/adapters.mjs`
// `registerDocumentSkills`)를 한 번 더 부르면 플러그인이 켜진다(그 함수는 멱등).
//
// git 없이 받는다: 깃허브는 커밋 하나를 통째로 zip 으로 내주므로
// (`/archive/<commit>.zip`) 그것만 받아 잠금표가 정한 `include` 폴더만 꺼낸다.
// 받은 zip 의 최상위 폴더 이름에는 그 커밋이 들어 있어(`skills-<commit>`),
// 그것이 "우리가 고정한 그 커밋을 받았다"는 확인이 된다.
//
// 실패는 실패로 적는다: 무엇이 잘못됐든 이 부품은 `pending`(대기)으로 남고
// 설치 전체를 멈추지 않는다 — 문서 스킬이 없어도 IRIS 는 돈다.

export const DOCUMENT_SKILLS_PART = 'document-skills';

// `https://github.com/anthropics/skills.git` + 커밋 → 그 커밋의 zip 주소.
export function githubArchiveUrl(repo, commit) {
  const clean = String(repo ?? '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = /github\.com[/:]([^/]+)\/([^/]+)$/i.exec(clean);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/archive/${commit}.zip`;
}

// zip 안 최상위 폴더 이름(깃허브는 `<repo>-<commit>` 하나만 넣는다).
export function archiveTopFolder(entries = []) {
  const tops = new Set();
  for (const e of entries) {
    const first = String(e).replace(/^\.\//, '').split(/[\\/]/).filter(Boolean)[0];
    if (first) tops.add(first);
  }
  return tops.size === 1 ? [...tops][0] : null;
}

// zip-slip 방어(Task 24b #6): 항목 경로에 `..` 조각이 있거나, 절대경로거나,
// 윈도우 드라이브 문자·UNC 로 시작하면 그 항목은 절대 신뢰하지 않는다 —
// extractZipFn 을 부르기 전에 걸러내, `stage`(또는 그 밖) 바깥에 파일이
// 놓이는 것을 막는다. 이 저장소가 받는 zip 은 항상 "그 커밋의 GitHub
// 아카이브"뿐이지만, 서명이 없는 원격 파일이라 내용은 여전히 믿지 않는다.
export function unsafeArchiveEntry(entry) {
  const raw = String(entry ?? '');
  const p = raw.replace(/^\.\//, '');
  if (!p) return false;
  if (path.isAbsolute(p)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // C:\... 드라이브 문자
  if (p.startsWith('\\\\') || p.startsWith('//')) return true; // UNC/네트워크 경로
  const segs = p.split(/[\\/]/);
  return segs.some((s) => s === '..');
}

function copyTreeSync(fsImpl, from, to) {
  const stat = fsImpl.statSync(from);
  if (!stat.isDirectory()) {
    fsImpl.mkdirSync(path.dirname(to), { recursive: true });
    fsImpl.copyFileSync(from, to);
    return 1;
  }
  fsImpl.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of fsImpl.readdirSync(from)) {
    n += copyTreeSync(fsImpl, path.join(from, name), path.join(to, name));
  }
  return n;
}

function recordDocumentSkills(root, info, deps) {
  patchReceipt(root, (receipt) => { setInstalled(receipt, DOCUMENT_SKILLS_PART, info); }, deps);
}

/**
 * ⑥-2b. 문서 스킬 묶음을 영혼 안에 놓고 플러그인으로 등록한다.
 *
 * States: `skipped`(클로드 구독이 아님) · `done` · `pending`(정직한 실패).
 *
 * @returns {Promise<{ok:boolean, state:string, commit?:string, path?:string, registered?:string, code?:string, message?:string, detail?:any}>}
 */
export async function installDocumentSkills({
  root, lock, zipRoot, manifest = null, subscriptions,
  onProgress = () => {}, log = () => {},
  fetchFn = fetch, fsImpl = fs,
  downloadFn = downloadToFile,
  listArchiveFn = listArchive,
  extractZipFn = extractZip,
  registerFn = null,
  readReceiptFn = readReceipt, writeReceiptFn = writeReceipt,
  env = process.env,
} = {}) {
  const deps = { readReceiptFn, writeReceiptFn };
  const subs = resolveSubscriptions(subscriptions, root, readReceiptFn);
  const theLock = lock ?? readLock({ zipRoot });
  const part = theLock?.parts?.[DOCUMENT_SKILLS_PART];

  // 클로드 플러그인이다 — ChatGPT 만 고른 설치에는 놓지 않는다.
  if (!subs.includes('claude')) {
    recordDocumentSkills(root, { state: 'not-installed', reason: 'subscription-not-selected' }, deps);
    log('document-skills skipped (claude subscription not selected)');
    return { ok: true, state: 'skipped' };
  }

  const pendingOut = (reason, detail = null) => {
    const message = `문서 작성 스킬(엑셀·워드·PPT·PDF)을 내려받지 못했습니다(${reason}).`;
    recordDocumentSkills(root, { state: 'pending', reason, verified: false }, deps);
    log(`document-skills pending: ${reason}${detail ? ` — ${detail}` : ''}`);
    return { ok: false, state: 'pending', code: CODES.documentSkills, message, detail };
  };

  if (!part?.repo || !part?.commit || !part?.dest) return pendingOut('lock-missing', 'lock.parts.document-skills incomplete');

  const commit = String(part.commit);
  const include = Array.isArray(part.include) && part.include.length
    ? part.include
    : (part.subdir ? [String(part.subdir)] : null);
  if (!include) return pendingOut('lock-missing', 'lock.parts.document-skills has neither include nor subdir');

  let dest;
  try {
    dest = assertInside(root, path.join(root, String(part.dest).split('/').join(path.sep)), { fs: fsImpl });
  } catch (err) {
    return pendingOut('bad-dest', String(err?.message ?? err));
  }
  // Task 24b #4: dest 가 이미 있었는지(이전 실행이 놓아둔 것)를 미리 적어
  // 둔다 — 이번 실행이 실패하면 "이번 실행이 새로 만든" dest 만 치우고,
  // 이전에 이미 있던 dest(부분 성공 재시도 중일 수 있다)는 손대지 않는다.
  const destExistedBefore = fsImpl.existsSync(dest);

  const registerNow = async (source) => {
    try {
      const register = registerFn ?? (await import('../setup/adapters.mjs')).registerDocumentSkills;
      const r = await register({ root, lock: theLock, manifest, fs: fsImpl, log });
      log(`document-skills registered (${r?.status ?? 'unknown'}, source=${source})`);
      return r?.status ?? null;
    } catch (err) {
      log(`document-skills register failed: ${String(err?.message ?? err)}`);
      return null;
    }
  };

  // --- 이미 있다(같은 커밋 폴더) -> 등록만 -------------------------------
  const already = include.every((rel) => {
    try { return fsImpl.existsSync(path.join(dest, ...String(rel).split('/'))); } catch { return false; }
  });
  if (already) {
    const registered = await registerNow('existing');
    recordDocumentSkills(root, {
      state: 'installed', commit, source: 'existing', path: relToRoot(root, dest), verified: true,
    }, deps);
    return { ok: true, state: 'done', commit, path: dest, source: 'existing', registered };
  }

  if (isOffline(env)) return pendingOut('offline', RESUME_SENTENCE);

  const url = githubArchiveUrl(part.repo, commit);
  if (!url) return pendingOut('bad-repo', String(part.repo));

  const work = path.join(root, '_agent', 'setup', 'downloads');
  const zipPath = path.join(work, `document-skills-${commit.slice(0, 7)}.zip`);
  const stage = path.join(work, `document-skills-${commit.slice(0, 7)}`);
  try {
    fsImpl.mkdirSync(work, { recursive: true });
    if (fsImpl.existsSync(stage)) fsImpl.rmSync(stage, { recursive: true, force: true });

    onProgress({ phase: 'download', source: 'github', done: 0, total: null });
    await downloadFn(url, zipPath, {
      fetchFn,
      onProgress: (p) => { try { onProgress({ phase: 'download', source: 'github', ...p }); } catch { /* ignore */ } },
      env,
    });

    // 받은 것이 **그 커밋**인지: 깃허브가 넣는 최상위 폴더 이름이 증거다.
    const entries = await listArchiveFn(zipPath);

    // Task 24b #6 zip-slip 방어: 풀기 전에 항목 경로부터 검사한다 — `..`
    // 조각이나 절대/드라이브 경로가 하나라도 있으면 그 아카이브는 아예
    // 풀지 않는다(신뢰할 서명이 없는 원격 zip 이라 내용을 믿지 않는다).
    const unsafe = entries.filter((e) => unsafeArchiveEntry(e));
    if (unsafe.length) {
      throw new Error(`archive has unsafe entry path(s): ${unsafe.slice(0, 3).join(', ')}`);
    }

    const top = archiveTopFolder(entries);
    if (!top) throw new Error('archive has no single top-level folder');
    if (!top.includes(commit) && !top.includes(commit.slice(0, 7))) {
      throw new Error(`archive top folder ${top} does not carry commit ${commit.slice(0, 7)}`);
    }

    await extractZipFn(zipPath, stage, { strip: 1 });

    let files = 0;
    for (const rel of include) {
      const from = path.join(stage, ...String(rel).split('/'));
      if (!fsImpl.existsSync(from)) throw new Error(`include path not in archive: ${rel}`);
      const to = assertInside(root, path.join(dest, ...String(rel).split('/')), { fs: fsImpl });
      files += copyTreeSync(fsImpl, from, to);
    }

    try { fsImpl.rmSync(zipPath, { force: true }); } catch { /* 청소는 최선 노력 */ }
    try { fsImpl.rmSync(stage, { recursive: true, force: true }); } catch { /* 같음 */ }

    recordDocumentSkills(root, {
      state: 'installed', commit, source: 'github',
      path: relToRoot(root, dest), files, verified: true,
    }, deps);
    const registered = await registerNow('github');
    log(`document-skills commit=${commit.slice(0, 7)} files=${files} -> ${relToRoot(root, dest)}`);
    return { ok: true, state: 'done', commit, path: dest, source: 'github', files, registered };
  } catch (err) {
    try { fsImpl.rmSync(zipPath, { force: true }); } catch { /* 최선 노력 */ }
    try { fsImpl.rmSync(stage, { recursive: true, force: true }); } catch { /* 같음 */ }
    // Task 24b #4: include 여러 개 중 일부만 옮겨진 채 실패하면(예: 두 번째
    // include 경로가 아카이브에 없어 던짐) dest 에 반쪼가리 문서 스킬이
    // 남는다 — 이번 실행이 처음부터 만든 dest(destExistedBefore=false)라면
    // 통째로 치운다. 이전 실행이 이미 만들어 둔 dest 는 그대로 둔다(다음
    // 재시도가 이어받게).
    if (!destExistedBefore) {
      try { fsImpl.rmSync(dest, { recursive: true, force: true }); } catch { /* 최선 노력 */ }
    }
    return pendingOut('download-failed', String(err?.message ?? err));
  }
}

// ---------------------------------------------------------------------------
// ⑥-3 구독 로그인
// ---------------------------------------------------------------------------

function loginHostFor(provider) {
  return provider === 'claude' ? HOSTS.claudeLogin : HOSTS.chatgpt;
}

/**
 * ⑥-3 start. Opens the CLI's own login console (lib/login.mjs, unchanged), or
 * reports the login as already done.
 *
 * "reused" (the v1.4.4 rule): a credential file is already there AND the relay
 * already holds an account for that provider — re-running the browser login
 * would only make the person log in again for nothing.
 */
export async function startLogin({
  provider, root, nodeDir, teamclaudeConfigPath, retry = false,
  startCliLoginFn = startCliLogin,
  cliLoginStatusFn = cliLoginStatus,
  countAccountsFn = countProviderAccounts,
  resolveConfigPathFn = resolveTeamclaudeConfigPath,
  readReceiptFn = readReceipt, writeReceiptFn = writeReceipt,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const deps = { readReceiptFn, writeReceiptFn };
  const configPath = teamclaudeConfigPath ?? resolveConfigPathFn({ root });
  const accounts = await countAccountsFn({ teamclaudeConfigPath: configPath, provider });

  if (!retry && cliLoginStatusFn({ provider, root }) === 'done' && accounts > 0) {
    setLoginRecord(root, provider, { state: 'done', cli: true, relay: true, reused: true, reason: null }, deps);
    log(`login ${provider} reused (credential present, account already connected)`);
    return { ok: true, state: 'done', cli: 'done', relay: 'done', reused: true, accounts };
  }

  try {
    const started = startCliLoginFn({ provider, root, nodeDir, teamclaudeConfigPath: configPath });
    setLoginRecord(root, provider, {
      state: 'waiting', cli: false, relay: false, reused: false, reason: null,
      startedAt: now(), accountsBefore: accounts, relayAttempts: 0, relayMethod: null,
    }, deps);
    log(`login ${provider} console opened retry=${retry}`);
    return { ok: true, state: 'waiting', cli: 'pending', relay: 'pending', reused: false, pid: started?.pid ?? null };
  } catch (err) {
    const detail = String(err?.message ?? err);
    setLoginRecord(root, provider, { state: 'failed', cli: false, relay: false, reason: 'window-closed' }, deps);
    log(`login ${provider} could not open a console: ${detail}`);
    return {
      ok: false, state: 'failed', cli: 'pending', relay: 'pending', reason: 'window-closed',
      message: '로그인 창을 열지 못했습니다. 「다시 열기」를 눌러 주세요.', detail,
    };
  }
}

/**
 * ⑥-3 poll. Turns "what is on disk right now" into one of the API's four
 * states, and — when it is a failure — into one of 설계-v2 7절's three causes:
 *
 *   window-closed  창을 닫음        — 2분이 지나도록 인증 파일이 생기지 않음
 *   page-blocked   로그인 페이지 차단 — 그 순간 로그인 주소가 응답하지 않음
 *   import-failed  가져오기 실패     — 인증 파일은 생겼는데 계정 연결이 안 됨
 *                                     (이때 `teamclaude login`을 1회 자동 시도)
 *
 * @returns {Promise<{state:string, cli:string, relay:string, reason:string|null}>}
 */
export async function loginStatus({
  provider, root, nodeDir, teamclaudeConfigPath, port = RELAY_PORT,
  cliLoginStatusFn = cliLoginStatus,
  relayImportFn = relayImport,
  relayStatusFn = relayStatus,
  resolveConfigPathFn = resolveTeamclaudeConfigPath,
  probe = probeHost, fetchFn = fetch,
  readReceiptFn = readReceipt, writeReceiptFn = writeReceipt,
  now = () => Date.now(),
  windowMs = LOGIN_WINDOW_MS, relayGraceMs = RELAY_GRACE_MS,
  log = () => {},
} = {}) {
  const deps = { readReceiptFn, writeReceiptFn };
  const rec = loginRecord(root, provider, readReceiptFn) ?? {};
  const configPath = teamclaudeConfigPath ?? resolveConfigPathFn({ root });
  const cli = cliLoginStatusFn({ provider, root });

  // --- stage 1 not finished ------------------------------------------------
  if (cli !== 'done') {
    // No recorded start = this poll arrived before startLogin ever ran, which
    // is "waiting", not a failure. (`== null` deliberately: an injected clock
    // may legitimately hand out 0.)
    const startedAt = rec.startedAt == null ? null : Number(rec.startedAt);
    const elapsed = startedAt == null ? 0 : now() - startedAt;
    if (startedAt != null && elapsed >= windowMs) {
      // Which of the two is it? Re-probe the login page NOW: a firewall that
      // swallowed the login page is a completely different instruction to the
      // person than a window they closed themselves.
      const r = await probe(loginHostFor(provider), { fetchFn });
      const reason = r?.reachable ? 'window-closed' : 'page-blocked';
      const message = reason === 'page-blocked'
        ? '로그인 페이지에 연결하지 못했습니다. 다른 인터넷 망에서 다시 시도해 주세요.'
        : '로그인 창이 닫혔습니다. 「다시 열기」를 눌러 주세요.';
      setLoginRecord(root, provider, { state: 'failed', cli: false, relay: false, reason }, deps);
      log(`login ${provider} failed reason=${reason}`);
      return { state: 'failed', cli: 'pending', relay: 'pending', reason, message };
    }
    return { state: 'waiting', cli: 'pending', relay: 'pending', reason: null };
  }

  // --- stage 2: hand the finished login to the relay -----------------------
  const accountsBefore = Number(rec.accountsBefore ?? 0);
  if (await relayStatusFn({ teamclaudeConfigPath: configPath, root, provider, accountsBefore }) === 'done') {
    setLoginRecord(root, provider, { state: 'done', cli: true, relay: true, reason: null }, deps);
    return { state: 'done', cli: 'done', relay: 'done', reason: null };
  }

  const attempts = Number(rec.relayAttempts ?? 0);
  if (attempts === 0) {
    // ONE attempt, ever. relayImport() itself is the "automatically try
    // `teamclaude login` once" step: when `import --from` fails it starts the
    // relay's own interactive login instead and reports method:'login'.
    const imported = await relayImportFn({ provider, root, nodeDir, teamclaudeConfigPath: configPath, port });
    const method = imported?.method ?? null;
    setLoginRecord(root, provider, {
      cli: true, relayAttempts: 1, relayMethod: method, relayAttemptedAt: now(),
    }, deps);
    log(`login ${provider} relay attempt method=${method ?? 'none'} ok=${imported?.ok === true}`);

    if (imported?.ok !== true) {
      setLoginRecord(root, provider, { state: 'failed', relay: false, reason: 'import-failed' }, deps);
      return {
        state: 'failed', cli: 'done', relay: 'failed', reason: 'import-failed',
        message: '로그인은 됐지만 계정 연결에 실패했습니다. 「다시 시도」를 눌러 주세요.',
      };
    }
    if (await relayStatusFn({ teamclaudeConfigPath: configPath, root, provider, accountsBefore }) === 'done') {
      setLoginRecord(root, provider, { state: 'done', cli: true, relay: true, reason: null }, deps);
      return { state: 'done', cli: 'done', relay: 'done', reason: null };
    }
    // method 'login' = the automatic retry is running in its own window now.
    return {
      state: 'cli-done', cli: 'done', relay: 'pending',
      reason: method === 'login' ? 'import-failed' : null,
    };
  }

  // --- the one attempt already happened and the account still is not there --
  // "once" is enforced here: a poll route calls this every second or so, and a
  // second relayImport would open a second browser window.
  const since = Number(rec.relayAttemptedAt ?? 0);
  if (rec.state === 'failed' || (since > 0 && now() - since >= relayGraceMs)) {
    setLoginRecord(root, provider, { state: 'failed', relay: false, reason: 'import-failed' }, deps);
    return {
      state: 'failed', cli: 'done', relay: 'failed', reason: 'import-failed',
      message: '로그인은 됐지만 계정 연결에 실패했습니다. 「다시 시도」를 눌러 주세요.',
    };
  }
  return {
    state: 'cli-done', cli: 'done', relay: 'pending',
    reason: rec.relayMethod === 'login' ? 'import-failed' : null,
  };
}

// ---------------------------------------------------------------------------
// ⑥-4 중계기 시작·확인
// ---------------------------------------------------------------------------

// The relay's real local health route (T10 precheck, probed on a real PC):
// GET /teamclaude/status answers JSON with an "activity"/"accounts" key for a
// loopback caller. GET /health is NOT a local route — it would be relayed
// straight to the model vendor upstream, which is both a wrong answer and the
// one thing this module must never do.
export function relayHealth(port = RELAY_PORT, { timeoutMs = 3000, httpGet = http.get } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = httpGet({ host: '127.0.0.1', port, path: '/teamclaude/status', timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { if (body.length < 8192) body += d; });
        res.on('end', () => {
          // The body is inspected for these two keys and then thrown away — it
          // can name a signed-in account, which never reaches a log or receipt.
          try {
            const j = JSON.parse(body);
            finish({ ok: res.statusCode === 200 && j && typeof j === 'object' && ('activity' in j || 'accounts' in j), status: res.statusCode });
          } catch {
            finish({ ok: false, status: res.statusCode });
          }
        });
      });
      req.on('error', () => finish({ ok: false, status: null }));
      req.on('timeout', () => { req.destroy(); finish({ ok: false, status: null }); });
    } catch {
      finish({ ok: false, status: null });
    }
  });
}

/**
 * ⑥-4. Start the relay if it is not already answering, confirm it, and count
 * the connected accounts. Zero model calls: a liveness route and a count read
 * out of the relay's own config file — nothing that spends a token.
 */
export async function startRelay({
  root, nodeDir, teamclaudeConfigPath, port = RELAY_PORT,
  ensureProxyFn = ensureProxy,
  healthFn = relayHealth,
  countAccountsFn = countProviderAccounts,
  resolveConfigPathFn = resolveTeamclaudeConfigPath,
  ensureRelayConfigDefaultsFn = ensureRelayConfigDefaults,
  readReceiptFn = readReceipt, writeReceiptFn = writeReceipt,
  log = () => {},
} = {}) {
  const deps = { readReceiptFn, writeReceiptFn };
  const configPath = teamclaudeConfigPath ?? resolveConfigPathFn({ root });
  const nodeBase = nodeDir ?? path.join(toolsDir(root), 'node');

  // 2026-09-17(2.0.8): 2.0.4~2.0.7 이 쓴 설정 파일에는 `proxy.port` 가 없어 관리 스크립트가 거절했다.
  // 이미 그 판으로 깐 PC 는 ⑤-7 이 끝났다고 기록돼 다시 돌지 않으므로 **여기서도** 빠진 칸을 채운다.
  try {
    const { patched } = ensureRelayConfigDefaultsFn(configPath);
    if (patched.length) log(`relay config patched: ${patched.join(', ')}`);
  } catch (err) {
    log(`relay config patch skipped: ${String(err?.message ?? err)}`);
  }

  let proxy;
  try {
    proxy = await ensureProxyFn({ root, nodeDir: nodeBase, port, teamclaudeConfigPath: configPath });
  } catch (err) {
    proxy = { alive: false, started: false, detail: String(err?.message ?? err) };
  }

  const health = proxy?.alive ? await healthFn(port) : { ok: false, status: null };
  if (!proxy?.alive || !health?.ok) {
    const why = proxy?.detail ?? null;
    log(`relay failed alive=${proxy?.alive === true} health=${health?.ok === true}${why ? ` detail=${JSON.stringify(why)}` : ''}`);
    patchReceipt(root, (r) => {
      r.online = r.online ?? {};
      r.online.relay = { state: 'failed', accounts: 0, code: CODES.relay };
    }, deps);
    // 사람이 읽을 한 문장: 무엇이 없거나 무엇이 거절했는지(2026-09-17 실제 사용자 실측 — 이전엔 "아직
    // 연결되지 않았습니다"뿐이라 손쓸 방법이 없었다).
    let reason = '';
    if (why && why.manageScriptExists === false) reason = '중계기 시작 스크립트가 없습니다(부품 풀기가 끝나지 않았을 수 있습니다).';
    else if (why && why.nodeExeExists === false) reason = '동봉 node 실행 파일이 없습니다.';
    else if (why && why.entryExists === false) reason = '중계기 프로그램 파일이 없습니다.';
    else if (why && why.manageExit != null && why.manageExit !== 0) reason = `시작 스크립트가 오류로 끝났습니다(코드 ${why.manageExit}${why.manageErr ? `: ${why.manageErr}` : ''}).`;
    else if (proxy?.alive && !health?.ok) reason = `포트 ${port} 에서 답하는 프로그램이 IRIS 중계기가 아닙니다(다른 프로그램이 그 포트를 쓰고 있을 수 있습니다).`;
    else reason = `포트 ${port} 에서 중계기가 답하지 않습니다(시작은 했지만 아직 안 떴거나 곧 죽었습니다).`;
    return {
      ok: false, state: 'failed', accounts: 0, code: CODES.relay,
      message: `중계기를 시작하지 못했습니다 — ${reason} 「계정 연결 다시 시도」를 눌러 주세요.`,
      detail: { alive: proxy?.alive === true, started: proxy?.started === true, status: health?.status ?? null, ...(why ?? {}) },
    };
  }

  let accounts = 0;
  for (const provider of ['claude', 'chatgpt']) {
    accounts += await countAccountsFn({ teamclaudeConfigPath: configPath, provider });
  }
  log(`relay ok started=${proxy.started === true} accounts=${accounts}`);
  patchReceipt(root, (r) => {
    r.online = r.online ?? {};
    r.online.relay = { state: 'done', accounts, code: null };
  }, deps);
  return { ok: true, state: 'done', accounts, started: proxy.started === true };
}
