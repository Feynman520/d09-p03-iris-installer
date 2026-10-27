#!/usr/bin/env node
// IRIS agent updater -- keeps Claude Code and Codex current on an installed PC.
//
//   node agents.mjs --kick     (from the IRIS launcher: returns at once, starts --run detached when due)
//   node agents.mjs --run      (one check + update, holds the lock)
//   node agents.mjs --status   (prints the state file)
//
// Installed by the package as <root>\_agent\shared\tools\updater\agents.mjs next
// to apply.mjs and run with the bundled Node. Pure ESM, zero dependencies.
// Design = docs\설계-비서자동업데이트.md (2026-10-16 user decision: both agents
// update themselves on installed PCs; until 2.0.44 they stayed at the version
// the zip or the first install brought, forever).
//
// What it touches, and nothing else:
//   <tools>\claude\<version>\claude.exe        new Claude Code builds (official sha256)
//   <tools>\claude\claude.cmd                  the forwarder the PATH shim calls
//   <tools>\codex-versions\<version>\          npm prefixes of new Codex builds (npm integrity)
//   <tools>\codex\codex.cmd                    becomes a forwarder into codex-versions
//   <root>\_agent\setup\agent-update.{json,log,lock}, agent-update-tmp\
// The PATH shims (byte-pinned against P02 daemon/wake.mjs) are not touched.
//
// macOS (docs/설계-macOS.md M5) -- same rules, its own layout:
//   <tools>/claude/<version>/claude              darwin-arm64 build (official sha256)
//   <tools>/claude/claude                        sh forwarder (exec), the shim calls it
//   <tools>/codex-versions/<version>/            npm prefixes (no -g, like the install)
//   <tools>/codex/node_modules/@openai/codex/bin/codex.js
//                                                the exact file the sh shim runs with the
//                                                bundled node; becomes a forwarder that
//                                                imports the same file from codex-versions
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases';
export const CLAUDE_CHANNEL = 'stable';
export const CODEX_LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest';
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const CODEX_MIN_AGE_MS = 72 * 60 * 60 * 1000;
export const LOCK_STALE_MS = 30 * 60 * 1000;
export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
export const KEEP_VERSIONS = 2;

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

// <root>\_agent\shared\tools\updater\agents.mjs -> <root>
export function rootFromHere() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}
export function toolsDir(root) { return path.join(root, '_agent', 'shared', 'tools'); }
export function setupDir(root) { return path.join(root, '_agent', 'setup'); }
export function statePath(root) { return path.join(setupDir(root), 'agent-update.json'); }
export function logPath(root) { return path.join(setupDir(root), 'agent-update.log'); }
export function lockPath(root) { return path.join(setupDir(root), 'agent-update.lock'); }
export function tmpDir(root) { return path.join(setupDir(root), 'agent-update-tmp'); }
export function claudeDir(root) { return path.join(toolsDir(root), 'claude'); }
export function codexDir(root) { return path.join(toolsDir(root), 'codex'); }
export function codexVersionsDir(root) { return path.join(toolsDir(root), 'codex-versions'); }
const isWin = (platform) => (platform ?? process.platform) === 'win32';
export function nodeExe(root, { platform } = {}) {
  return isWin(platform) ? path.join(toolsDir(root), 'node', 'node.exe') : path.join(toolsDir(root), 'node', 'bin', 'node');
}
function npmCli(root, platform) {
  return isWin(platform) ? path.join(toolsDir(root), 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(toolsDir(root), 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}
/** The Claude forwarder the PATH shim calls: claude.cmd (Windows) / claude (macOS, sh). */
export function claudeForwarderFile(root, { platform } = {}) { return path.join(claudeDir(root), isWin(platform) ? 'claude.cmd' : 'claude'); }
/** Claude Code release manifest key for this machine. */
export function claudePlatformKey(platform, arch = process.arch) { return isWin(platform) ? 'win32-x64' : `darwin-${arch === 'x64' ? 'x64' : 'arm64'}`; }
/** macOS: the entry file of an npm prefix of @openai/codex (the sh shim runs <tools>/codex/<this> with node). */
export const CODEX_ENTRY = ['node_modules', '@openai', 'codex', 'bin', 'codex.js'];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Plain x.y.z only. Anything with a pre-release tail is not a release we take. */
export function isRelease(v) { return typeof v === 'string' && VERSION_RE.test(v); }

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

const crlf = (lines) => `${lines.join('\r\n')}\r\n`;

// One parsed line that runs the exe and leaves the batch at once (`&exit/b` keeps
// the exe's exit code). cmd.exe reads a .cmd again by byte offset after a child
// exits, so a forwarder rewritten under a running session must leave nothing for
// it to read next. The 40 trailing spaces are for the one rewrite that cannot
// avoid it -- the installer's old four-line forwarder replaced while a session
// runs: its saved offset then lands in the spaces (an empty command) as long as
// the version string grew by at most 5 characters. Measured 2026-10-16 with a
// live cmd.exe: 1.0.0->10.20.300, 2.1.272->2.1.292, 2.1.99->2.1.100, shorter,
// old and new forms -- exit code kept, no stray output.
export const FORWARDER_PAD = ' '.repeat(40);
export function claudeForwarder(version, { platform = process.platform } = {}) {
  // macOS: installer/lib/online.mjs claudeForwarderText 의 sh 판과 글자까지 같다(`exec` 라 다시 읽히지 않는다).
  if (platform !== 'win32') return ['#!/bin/sh', `exec "$(dirname -- "$0")/${version}/claude" "$@"`, ''].join('\n');
  return crlf(['@echo off', `"%~dp0${version}\\claude.exe" %*&exit/b${FORWARDER_PAD}`]);
}

// 2026-10-27(M5): macOS 판 갱신을 옮겼다 — darwin 판 내려받기·sh 전달자·codex.js 전달자.
// (docs/설계-macOS.md M5). 그때까지 macOS 에서는 아무것도 바꾸지 않고 끝난다 — 이 파일의
// Windows 갱신 경로(claude.exe·codex.cmd)를 macOS 설치에 돌리면 안 되기 때문이다.
export function supportedPlatform(platform = process.platform) { return platform === 'win32' || platform === 'darwin'; }

// Calling a .cmd without `call` hands control over for good -- this file is
// never read again, whatever happens to it afterwards.
export function codexForwarder(version) {
  return crlf(['@echo off', `"%~dp0..\\codex-versions\\${version}\\codex.cmd" %*`]);
}

// macOS: written over <tools>/codex/node_modules/@openai/codex/bin/codex.js. It imports the
// same file of the new prefix, which then finds its own native binary next to itself and
// reads process.argv as usual. `esm` follows the old package's "type" (module since 0.1xx).
export function codexForwarderJs(version, { esm = true } = {}) {
  const rel = `../../../../../codex-versions/${version}/node_modules/@openai/codex/bin/codex.js`;
  const head = `// IRIS agent updater: runs Codex ${version} from codex-versions (the PATH shim calls this exact file).`;
  return esm
    ? [head, `await import(new URL(${JSON.stringify(rel)}, import.meta.url).href);`, ''].join('\n')
    : [head, `import(require('node:url').pathToFileURL(require('node:path').join(__dirname, ${JSON.stringify(rel)})).href);`, ''].join('\n');
}

export function readState(root) {
  try { return JSON.parse(fs.readFileSync(statePath(root), 'utf8')); } catch { return {}; }
}

export function writeState(root, state) {
  fs.mkdirSync(setupDir(root), { recursive: true });
  const file = statePath(root);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

function makeLogger(root) {
  return (msg) => {
    try {
      fs.mkdirSync(setupDir(root), { recursive: true });
      fs.appendFileSync(logPath(root), `${new Date().toISOString()} ${msg}\n`, 'utf8');
    } catch { /* a log that cannot be written must not stop an update */ }
  };
}

// `mode` is set on the temp file before the rename, so a sh forwarder is never seen non-executable.
function writeAtomic(file, text, mode) {
  fs.writeFileSync(`${file}.new`, text, 'utf8');
  if (mode) fs.chmodSync(`${file}.new`, mode);
  fs.renameSync(`${file}.new`, file);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// what is installed now
// ---------------------------------------------------------------------------

export function currentClaude(root, { platform } = {}) {
  let text;
  try { text = fs.readFileSync(claudeForwarderFile(root, { platform }), 'utf8'); } catch { return { present: false, version: null }; }
  const m = isWin(platform) ? text.match(/"%~dp0([^"\\]+)\\claude\.exe"/) : text.match(/\/([^/"]+)\/claude" "\$@"/);
  return { present: true, version: m && isRelease(m[1]) ? m[1] : null, forwarder: Boolean(m) };
}

export function currentCodex(root, { platform } = {}) {
  const cmd = isWin(platform) ? path.join(codexDir(root), 'codex.cmd') : path.join(codexDir(root), ...CODEX_ENTRY);
  let text;
  try { text = fs.readFileSync(cmd, 'utf8'); } catch { return { present: false, version: null }; }
  const m = isWin(platform) ? text.match(/codex-versions\\([^\\"]+)\\codex\.cmd/) : text.match(/\/codex-versions\/([^/"']+)\/node_modules\//);
  if (m) return { present: true, version: isRelease(m[1]) ? m[1] : null, forwarder: true };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(codexDir(root), 'node_modules', '@openai', 'codex', 'package.json'), 'utf8'));
    return { present: true, version: isRelease(pkg.version) ? pkg.version : null, forwarder: false };
  } catch {
    return { present: true, version: null, forwarder: false };
  }
}

// ---------------------------------------------------------------------------
// default side-effect providers (all injectable for tests)
// ---------------------------------------------------------------------------

async function defaultFetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function defaultDownload(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const hash = crypto.createHash('sha256');
  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => hash.update(chunk));
  await pipeline(src, fs.createWriteStream(file));
  return hash.digest('hex');
}

// Runs a program and returns its first line of output. Through cmd.exe for a .cmd,
// through `node` (the bundled one, passed in) for a .js entry (macOS codex).
function defaultVersionOf(file, { env, node } = {}) {
  const isCmd = /\.cmd$/i.test(file);
  if (/\.m?js$/i.test(file)) {
    const r = spawnSync(node || process.execPath, [file, '--version'], { encoding: 'utf8', timeout: 60000, env: env ?? process.env });
    return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  }
  const r = spawnSync(isCmd ? 'cmd.exe' : file, isCmd ? ['/d', '/s', '/c', `"${file}" --version`] : ['--version'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, windowsVerbatimArguments: isCmd, env: env ?? process.env,
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

function defaultNpmInstall({ root, prefix, spec, cacheDir, platform }) {
  const node = nodeExe(root, { platform });
  const env = { ...process.env, npm_config_cache: cacheDir };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env.PATH = `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
  // macOS: no -g — a global install under --prefix lands in <prefix>/lib/node_modules; the install used --prefix alone.
  const args = isWin(platform) ? ['install', '-g', '--prefix', prefix, spec] : ['install', '--prefix', prefix, spec];
  const r = spawnSync(node, [npmCli(root, platform), ...args, '--no-fund', '--no-audit'], {
    encoding: 'utf8', timeout: 20 * 60 * 1000, windowsHide: true, env,
  });
  return { code: r.status, err: String(r.stderr ?? '').slice(-400) };
}

function defaultFreeBytes(dir) {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
}

function codexEnv(root, platform) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env.PATH = `${path.dirname(nodeExe(root, { platform }))}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
  return env;
}

const DEFAULTS = {
  fetchText: defaultFetchText,
  download: defaultDownload,
  versionOf: defaultVersionOf,
  npmInstall: defaultNpmInstall,
  freeBytes: defaultFreeBytes,
  now: () => Date.now(),
  retryDelayMs: 5000,
};

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

export async function updateClaude(root, deps, log) {
  const platform = deps.platform ?? process.platform;
  const key = claudePlatformKey(platform, deps.arch);
  const binName = isWin(platform) ? 'claude.exe' : 'claude';
  const cur = currentClaude(root, { platform });
  if (!cur.present) return { status: 'absent' };
  const target = (await deps.fetchText(`${CLAUDE_BASE}/${CLAUDE_CHANNEL}`)).trim();
  if (!isRelease(target)) return { status: 'error', detail: 'channel answered no version' };
  if (cur.version && compareVersions(target, cur.version) <= 0) return { status: 'current', version: cur.version };

  const manifest = JSON.parse(await deps.fetchText(`${CLAUDE_BASE}/${target}/manifest.json`));
  const want = String(manifest?.platforms?.[key]?.checksum ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return { status: 'error', detail: `manifest has no ${key} checksum` };

  const dir = path.join(claudeDir(root), target);
  const exe = path.join(dir, binName);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(exe) || sha256File(exe) !== want) {
    const part = `${exe}.part`;
    log(`claude: downloading ${target}`);
    const got = await deps.download(`${CLAUDE_BASE}/${target}/${key}/${binName}`, part);
    if (got !== want) {
      fs.rmSync(part, { force: true });
      return { status: 'error', detail: `checksum mismatch for ${target}` };
    }
    fs.renameSync(part, exe);
  }
  if (!isWin(platform)) fs.chmodSync(exe, 0o755);
  // A freshly written 230 MB exe can be held by Defender for a few seconds (2026-09-16 VM S01).
  let out = '';
  for (let i = 0; i < 3; i += 1) {
    out = deps.versionOf(exe);
    if (out.includes(target)) break;
    await sleep(deps.retryDelayMs);
  }
  if (!out.includes(target)) return { status: 'error', detail: `new build did not answer --version (${target})` };
  writeAtomic(claudeForwarderFile(root, { platform }), claudeForwarder(target, { platform: isWin(platform) ? 'win32' : platform }), isWin(platform) ? undefined : 0o755);
  log(`claude: ${cur.version ?? '?'} -> ${target}`);
  return { status: 'updated', from: cur.version, version: target };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

// Newest version this PC first saw at least CODEX_MIN_AGE_MS ago. The npm
// document that carries publish times is ~18 MB, so the age is counted from
// this PC's own first sighting instead -- later than the real release, never earlier.
export function pickCodexTarget(seen, now) {
  const ripe = Object.entries(seen ?? {})
    .filter(([v, at]) => isRelease(v) && now - Date.parse(at) >= CODEX_MIN_AGE_MS)
    .map(([v]) => v)
    .sort(compareVersions);
  return ripe.length ? ripe[ripe.length - 1] : null;
}

export async function updateCodex(root, deps, log, state) {
  const platform = deps.platform ?? process.platform;
  const cur = currentCodex(root, { platform });
  if (!cur.present) return { status: 'absent' };
  const latest = JSON.parse(await deps.fetchText(CODEX_LATEST_URL))?.version;
  if (!isRelease(latest)) return { status: 'error', detail: 'registry answered no version' };

  const now = deps.now();
  const seen = { ...(state.codexSeen ?? {}) };
  if (!seen[latest]) seen[latest] = new Date(now).toISOString();
  // keep only versions newer than what runs now, newest 10
  const keep = Object.keys(seen).filter((v) => isRelease(v) && (!cur.version || compareVersions(v, cur.version) > 0))
    .sort(compareVersions).slice(-10);
  state.codexSeen = Object.fromEntries(keep.map((v) => [v, seen[v]]));

  const target = pickCodexTarget(state.codexSeen, now);
  if (!target) {
    return cur.version && compareVersions(latest, cur.version) <= 0
      ? { status: 'current', version: cur.version }
      : { status: 'waiting', version: cur.version, next: latest };
  }

  const prefix = path.join(codexVersionsDir(root), target);
  const prefixCmd = isWin(platform) ? path.join(prefix, 'codex.cmd') : path.join(prefix, ...CODEX_ENTRY);
  if (!fs.existsSync(prefixCmd)) {
    log(`codex: installing ${target}`);
    const cache = path.join(tmpDir(root), 'npm-cache');
    fs.mkdirSync(cache, { recursive: true });
    const r = deps.npmInstall({ root, prefix, spec: `@openai/codex@${target}`, cacheDir: cache, platform });
    fs.rmSync(cache, { recursive: true, force: true });
    if (r.code !== 0 || !fs.existsSync(prefixCmd)) {
      fs.rmSync(prefix, { recursive: true, force: true });
      return { status: 'error', detail: `npm install ${target} failed (${r.code})` };
    }
  }
  const out = deps.versionOf(prefixCmd, { env: codexEnv(root, platform), node: nodeExe(root, { platform }) });
  if (!out.includes(target)) return { status: 'error', detail: `new build did not answer --version (${target})` };
  if (isWin(platform)) writeAtomic(path.join(codexDir(root), 'codex.cmd'), codexForwarder(target));
  else {
    let esm = true;
    try { esm = JSON.parse(fs.readFileSync(path.join(codexDir(root), 'node_modules', '@openai', 'codex', 'package.json'), 'utf8')).type === 'module'; } catch { /* keep ESM */ }
    writeAtomic(path.join(codexDir(root), ...CODEX_ENTRY), codexForwarderJs(target, { esm }));
  }
  for (const v of Object.keys(state.codexSeen)) if (compareVersions(v, target) <= 0) delete state.codexSeen[v];
  log(`codex: ${cur.version ?? '?'} -> ${target}`);
  return { status: 'updated', from: cur.version, version: target };
}

// ---------------------------------------------------------------------------
// tidy: keep the version in use plus the newest KEEP_VERSIONS-1 others
// ---------------------------------------------------------------------------

export function pruneVersions(dir, inUse, log) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && isRelease(e.name)).map((e) => e.name); } catch { return []; }
  const others = names.filter((n) => n !== inUse).sort(compareVersions).reverse();
  const drop = others.slice(Math.max(0, KEEP_VERSIONS - 1));
  const removed = [];
  for (const n of drop) {
    try { fs.rmSync(path.join(dir, n), { recursive: true }); removed.push(n); } catch { log(`prune: ${n} in use, later`); }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------

export function acquireLock(root, now) {
  fs.mkdirSync(setupDir(root), { recursive: true });
  const file = lockPath(root);
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }), { flag: 'wx' });
    return true;
  } catch {
    let at = 0;
    try { at = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).at); } catch { /* unreadable = stale */ }
    if (Number.isFinite(at) && now - at < LOCK_STALE_MS) return false;
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
    return true;
  }
}

export function lockBusy(root, now) {
  try {
    const at = Date.parse(JSON.parse(fs.readFileSync(lockPath(root), 'utf8')).at);
    return Number.isFinite(at) && now - at < LOCK_STALE_MS;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

/** Should a run start now? Returns the reason it should not, or null. */
export function whyNot(root, { env = process.env, now = Date.now() } = {}) {
  if (env.IRIS_AGENT_UPDATE === '0') return 'off';
  const state = readState(root);
  if (state.disabled === true) return 'disabled';
  const last = Date.parse(state.lastCheck ?? '');
  if (Number.isFinite(last) && now - last < CHECK_INTERVAL_MS) return 'recent';
  if (lockBusy(root, now)) return 'busy';
  return null;
}

export function kick(root, { env = process.env, now = Date.now(), spawnFn = spawn } = {}) {
  const reason = whyNot(root, { env, now });
  if (reason) return { started: false, reason };
  const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), '--run', '--root', root], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref?.();
  return { started: true };
}

export async function runOnce(root, overrides = {}) {
  if (!supportedPlatform(overrides.platform)) return { skipped: 'unsupported-os' };
  const deps = { ...DEFAULTS, ...overrides };
  const log = overrides.log ?? makeLogger(root);
  const now = deps.now();
  const reason = whyNot(root, { env: overrides.env ?? process.env, now });
  if (reason && reason !== 'recent') return { skipped: reason };
  if (reason === 'recent' && !overrides.force) return { skipped: reason };
  if (!acquireLock(root, now)) return { skipped: 'busy' };
  const state = readState(root);
  state.lastCheck = new Date(now).toISOString();
  writeState(root, state);
  const result = {};
  try {
    if (deps.freeBytes(toolsDir(root)) < MIN_FREE_BYTES) {
      log('skip: less than 2 GB free');
      result.skipped = 'disk';
    } else {
      fs.mkdirSync(tmpDir(root), { recursive: true });
      for (const [name, fn] of [['claude', updateClaude], ['codex', updateCodex]]) {
        try { result[name] = await fn(root, deps, log, state); } catch (err) {
          result[name] = { status: 'error', detail: String(err?.message ?? err).slice(0, 200) };
        }
        if (result[name].status === 'error') log(`${name}: ${result[name].detail}`);
      }
      const c = currentClaude(root, { platform: deps.platform });
      if (c.version) pruneVersions(claudeDir(root), c.version, log);
      const x = currentCodex(root, { platform: deps.platform });
      if (x.forwarder && x.version) pruneVersions(codexVersionsDir(root), x.version, log);
    }
  } finally {
    fs.rmSync(tmpDir(root), { recursive: true, force: true });
    state.lastResult = { at: new Date(now).toISOString(), ...result };
    writeState(root, state);
    fs.rmSync(lockPath(root), { force: true });
  }
  return result;
}

async function main(argv) {
  const at = argv.indexOf('--root');
  const root = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : rootFromHere();
  if (argv.includes('--kick')) {
    if (!supportedPlatform()) return 0;
    try { kick(root); } catch { /* never block the launcher */ }
    return 0;
  }
  if (argv.includes('--run')) {
    await runOnce(root, { force: argv.includes('--force') });
    return 0;
  }
  if (argv.includes('--status')) {
    process.stdout.write(`${JSON.stringify({ claude: currentClaude(root), codex: currentCodex(root), state: readState(root) }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write('usage: node agents.mjs --kick | --run [--force] | --status [--root <dir>]\n');
  return 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
