// Two-stage subscription login (task-13-brief.md):
//   Stage 1 (startCliLogin / cliLoginStatus) -- the CLI's OWN OAuth, run in a
//     new console window WITHOUT the TeamClaude proxy in front of it, so the
//     subscription itself gets authorized (a proxied process can't run
//     `/login` at all -- confirmed 2026-09-11, "isn't available in this
//     environment"). Completion is detected by FILE EXISTENCE ONLY -- this
//     module never reads or parses credential files.
//   Stage 2 (relayImport / relayStatus) -- hand that login to TeamClaude so
//     it joins the pool. `import --from` is a real, shipped TeamClaude CLI
//     command for Claude (confirmed by reading node_modules/@karpeleslab/
//     teamclaude/src/index.js -- importCommand()); Codex has no such CLI
//     flag, so its account is registered by writing a config `importFrom`
//     entry (confirmed via src/config.js + src/resolve-accounts.js) and then
//     asking the running server to re-sync via POST /teamclaude/reload
//     (src/server.js -- exempt from the API-key gate for loopback callers).
// No secrets are ever read, logged, or written by this module: `import`
// reads the credential file itself (out of process), and the codex path only
// ever writes a filesystem *path* into TeamClaude's config, never a token.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../lib/run.mjs';
import { readReceipt } from './receipt.mjs';

const COMSPEC = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
const DEFAULT_PORT = 3456;

function toolsDir(root) {
  return path.join(root, '_agent', 'shared', 'tools');
}

function credentialPath(provider, root) {
  return provider === 'claude'
    ? path.join(root, '_agent', 'claude', '.credentials.json')
    : path.join(root, '_agent', 'codex', 'auth.json');
}

function teamclaudeEntryPath(root) {
  return path.join(
    toolsDir(root), 'teamclaude',
    'node_modules', '@karpeleslab', 'teamclaude', 'src', 'index.js',
  );
}

// TeamClaude accounts written by its own `import`/`login` command for Claude
// carry no `provider` field at all (src/index.js's importCommand()/
// upsertOAuthAccount() never set one); src/provider.js's providerOf()
// defaults a missing field to 'anthropic'. Codex accounts always carry an
// explicit `provider: 'codex'` (src/index.js loginCodexCommand()/the
// importFrom entry this module writes). This maps our installer-level
// provider id ('claude'|'chatgpt') to that on-disk convention.
function accountMatchesProvider(account, provider) {
  const tcProvider = account?.provider ?? 'anthropic';
  return provider === 'claude' ? tcProvider === 'anthropic' : tcProvider === 'codex';
}

// ---------------------------------------------------------------------------
// Stage 1: the CLI's own login, run outside the TeamClaude proxy.
// ---------------------------------------------------------------------------

/**
 * Open a new, visible console window running `claude login` (Claude) or
 * `codex login` (ChatGPT/Codex) -- never through ANTHROPIC_BASE_URL, so the
 * CLI performs its own real OAuth against the real provider.
 *
 * `dryRun: true` builds the exact command line and env but never spawns
 * anything and opens no window -- used by tests and by the rehearsal on a
 * machine where a real login must not be started.
 */
export function startCliLogin({
  provider, root, nodeDir, teamclaudeConfigPath, spawnFn = spawn, dryRun = false,
} = {}) {
  const tools = toolsDir(root);
  const cmdPath = provider === 'claude'
    ? path.join(tools, 'claude', 'claude.cmd')
    : path.join(tools, 'codex', 'codex.cmd');

  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;
  env.PATH = `${nodeDir};${env.PATH ?? ''}`;
  // I2: every console this module opens carries the soul's own TeamClaude
  // config path. This one runs the CLI's own OAuth (not TeamClaude), but the
  // window stays open afterwards and the installer's process does not have
  // the freshly-written user variable yet -- so anything the person runs in
  // it must not fall back to %USERPROFILE%\.config either.
  env.TEAMCLAUDE_CONFIG = teamclaudeConfigPath ?? resolveTeamclaudeConfigPath({ root });
  if (provider === 'claude') {
    env.CLAUDE_CONFIG_DIR = path.join(root, '_agent', 'claude');
  } else {
    env.CODEX_HOME = path.join(root, '_agent', 'codex');
  }

  const title = provider === 'claude' ? 'IRIS Claude login' : 'IRIS Codex login';
  // Fix round 1 finding 4: this line used to be the brief-mandated Korean
  // guidance text, on the reasoning that a spawned console is a user-facing
  // screen rather than a server log message. Review overruled that: it is
  // Korean text inside a `cmd /k` line, and on a plain cp949 console (the
  // Windows default code page, not UTF-8) that can render as garbled mojibake
  // instead of readable Korean. Kept ASCII-only here; the real Korean
  // guidance belongs on the installer's own HTML screen (Task 14), which is
  // UTF-8 end to end and does not have this risk.
  const echoText = 'Log in in the browser. This window closes by itself when the login is done.';
  // The CLI's real login subcommand (2026-09-13 pre-release review, step ⓔ):
  //   claude  -> `claude auth login --claudeai`  (Claude Code 2.1.x has no
  //              top-level `login`; `claude login` prints the general help
  //              and never authenticates -- caught by `claude --help`)
  //   codex   -> `codex login`                    (unchanged)
  const loginArgs = provider === 'claude' ? 'auth login --claudeai' : 'login';
  // `cmd /c ... || pause`: the window closes by itself on success (a beginner
  // is not left with a stray console to close), and stays open with "Press
  // any key" only when the login command failed, so the error is readable.
  // The whole thing is one quoted command string per cmd.exe's `start` rule
  // (a quoted title makes `start` treat the NEXT quoted token as the window
  // title, so the command itself needs its own quoting layer).
  const inner = `"echo ${echoText} && "${cmdPath}" ${loginArgs} || pause"`;
  const line = `start "${title}" cmd /c ${inner}`;
  const args = ['/d', '/s', '/c', line];

  if (dryRun) {
    return { started: false, dryRun: true, cmdPath, args, line, env };
  }

  const child = spawnFn(COMSPEC, args, {
    windowsHide: false,
    windowsVerbatimArguments: true,
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref?.();
  return { started: true, pid: child.pid };
}

// ---------------------------------------------------------------------------
// Stage 1' (2.0.33, 2026-09-21 사용자 결정 "로그인은 무조건 자동 복귀"): 검은 콘솔 창 대신
// CLI 로그인을 창 없이(표준입출력 파이프) 띄운다. 이유(9/20 실측):
//   - `claude auth login` 은 주소를 둘 만든다 — ⓐ 자동용(redirect_uri=localhost:<포트>/callback,
//     브라우저가 로그인 뒤 스스로 돌아옴) ⓑ 수동용(platform.claude.com/oauth/code/callback, 사람이
//     코드를 복사해 붙여넣어야 함). 브라우저에는 ⓐ 를 열고, 콘솔에는 ⓑ 만 찍는다.
//   - ⓑ 의 코드 입력칸은 readline({input}) 에 output 이 없어 되비춤이 없고, Bun 이 콘솔을 원시 모드로
//     바꿔 콘솔도 안 그린다 → 붙여넣어도 아무것도 안 보여 사람이 쓸 수 없다(설치 현장 실증).
//   - ⓐ 와 ⓑ 는 redirect_uri 한 칸만 다르고, ⓐ 의 포트는 그 순간 claude.exe 가 127.0.0.1 에 연
//     수신 포트다(netstat -ano 로 PID 기준 조회 가능, 이 PC 실측 65416). 그래서 ⓑ 에서 ⓐ 를 복원해
//     화면에는 ⓐ 만 보여 준다. 콘솔이 없으니 사람은 ⓑ 를 볼 기회조차 없다.
//   - codex login 은 원래 자동 복귀(localhost:1455)이고 그 주소를 출력에 찍으므로 같은 틀로 통일.
// 비밀은 여전히 다루지 않는다 — 읽는 것은 로그인 주소(공개 매개변수)와 종료 코드뿐이다.
// ---------------------------------------------------------------------------
const piped = new Map(); // provider -> { pid, url, manualSeen, exited, code, startedAt, child }

const CLAUDE_AUTHORIZE_RE = /https:\/\/[A-Za-z0-9.-]*claude\.com\/[^\s"'<>]*\/oauth\/authorize\?[^\s"'<>]+/;
const LOCALHOST_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/[^\s"'<>]*/;

/** 출력 글에서 로그인 주소를 찾는다. claude = authorize 주소(수동용 ⓑ 그대로), codex = localhost 주소. 없으면 null. */
export function parseLoginUrl(provider, text) {
  const s = String(text ?? '');
  const m = s.match(provider === 'claude' ? CLAUDE_AUTHORIZE_RE : LOCALHOST_URL_RE);
  return m ? m[0] : null;
}

/** ⓑ 수동 주소의 redirect_uri 만 `http://localhost:<port>/callback` 으로 바꾼 ⓐ 자동 주소. 잘못된 입력이면 null. */
export function autoLoginUrl(manualUrl, port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return null;
  let u;
  try { u = new URL(String(manualUrl)); } catch { return null; }
  if (!u.searchParams.has('redirect_uri')) return null;
  u.searchParams.set('redirect_uri', `http://localhost:${p}/callback`);
  return u.toString();
}

/** `netstat -ano -p tcp` 출력에서 pid 의 LISTENING 포트. 루프백(127.0.0.1·[::1]) 먼저, 그 다음 나머지. */
export function parseNetstatListeners(output, pid) {
  const want = String(pid);
  const loop = []; const rest = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!m || m[2] !== want) continue;
    const local = m[1];
    const pm = local.match(/:(\d+)$/); if (!pm) continue;
    const port = Number(pm[1]);
    if (/^(127\.0\.0\.1|\[::1\]|localhost):/i.test(local)) loop.push(port); else rest.push(port);
  }
  return [...loop, ...rest];
}

async function defaultListeningPorts(pid, { runFn = run } = {}) {
  const r = await runFn('netstat', ['-ano', '-p', 'tcp'], {});
  return parseNetstatListeners(r?.stdout ?? '', pid);
}

/** claude.cmd 전달자(`"%~dp0<판>\claude.exe" %*`)가 가리키는 실제 exe. 전달자·exe 가 없으면 null. */
export function resolveClaudeExe(root, { fs: fsImpl = fs } = {}) {
  const dir = path.join(toolsDir(root), 'claude');
  let text;
  try { text = fsImpl.readFileSync(path.join(dir, 'claude.cmd'), 'utf8'); } catch { return null; }
  const m = text.match(/"%~dp0([^"]+)"/);
  if (!m) return null;
  const exe = path.join(dir, m[1]);
  return fsImpl.existsSync(exe) ? exe : null;
}

/** 지금 이 설치기 프로세스가 띄운 파이프 로그인의 요약. 시작한 적 없으면 null. 비밀 없음(주소·PID·종료 코드뿐). */
export function pipedLoginInfo(provider) {
  const p = piped.get(provider);
  return p ? { pid: p.pid, url: p.url, manualSeen: p.manualSeen, exited: p.exited, code: p.code, startedAt: p.startedAt } : null;
}
export function resetPipedLogin(provider) { piped.delete(provider); }

/**
 * CLI 로그인을 창 없이 띄우고 출력에서 자동 복귀 주소를 모은다(위 머리말). 표준입력은 열어 두되 아무것도 쓰지 않는다.
 * 돌려주는 값은 startCliLogin 과 같은 모양(+mode:'piped')이라 startLogin 이 그대로 받는다.
 */
export function startPipedLogin({
  provider, root, nodeDir, teamclaudeConfigPath,
  spawnFn = spawn, portsFn = defaultListeningPorts, portPollMs = 300, portTries = 20,
  dryRun = false, log = () => {}, now = () => Date.now(),
} = {}) {
  const tools = toolsDir(root);
  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;
  env.PATH = `${nodeDir};${env.PATH ?? ''}`;
  env.TEAMCLAUDE_CONFIG = teamclaudeConfigPath ?? resolveTeamclaudeConfigPath({ root });
  if (provider === 'claude') env.CLAUDE_CONFIG_DIR = path.join(root, '_agent', 'claude');
  else env.CODEX_HOME = path.join(root, '_agent', 'codex');

  let cmd; let args; let verbatim = false;
  const exe = provider === 'claude' ? resolveClaudeExe(root) : null;
  if (exe) {
    cmd = exe; args = ['auth', 'login', '--claudeai'];
  } else {
    // .cmd 는 셸 없이 파이프로 못 띄운다 → cmd.exe /d /s /c "<경로>" <인수>
    const cmdPath = provider === 'claude' ? path.join(tools, 'claude', 'claude.cmd') : path.join(tools, 'codex', 'codex.cmd');
    const loginArgs = provider === 'claude' ? 'auth login --claudeai' : 'login';
    cmd = COMSPEC; args = ['/d', '/s', '/c', `""${cmdPath}" ${loginArgs}"`]; verbatim = true;
  }
  const opts = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env, ...(verbatim ? { windowsVerbatimArguments: true } : {}) };
  if (dryRun) return { started: false, dryRun: true, mode: 'piped', cmd, args, env };

  const child = spawnFn(cmd, args, opts);
  const info = { pid: child?.pid ?? null, url: null, manualSeen: false, exited: false, code: null, startedAt: now(), child, buf: '' };
  piped.set(provider, info);
  const onExit = (code) => { info.exited = true; info.code = code; log(`login ${provider} piped process exited code=${code}`); };
  child?.on?.('exit', onExit);
  child?.on?.('error', (e) => { info.exited = true; info.code = -1; log(`login ${provider} piped spawn error: ${e?.message ?? e}`); });

  let resolving = false;
  const onData = (chunk) => {
    if (info.url || resolving) return;
    info.buf = (info.buf + String(chunk)).slice(-16384);
    const found = parseLoginUrl(provider, info.buf);
    if (!found) return;
    if (provider !== 'claude') { info.url = found; log(`login ${provider} url ready (${new URL(found).host})`); return; }
    info.manualSeen = true; resolving = true;
    (async () => {
      for (let i = 0; i < portTries && !info.exited && piped.get(provider) === info; i++) {
        let ports = [];
        try { ports = await portsFn(info.pid); } catch { ports = []; }
        const auto = ports.length ? autoLoginUrl(found, ports[0]) : null;
        if (auto) { info.url = auto; log(`login claude automatic url ready (port ${ports[0]})`); return; }
        await new Promise((r) => setTimeout(r, portPollMs));
      }
      log('login claude: listener port not found -- screen shows no link (browser tab opened by the CLI still works)');
    })();
  };
  child?.stdout?.on?.('data', onData);
  child?.stderr?.on?.('data', onData);
  child?.unref?.();
  return { started: true, pid: info.pid, mode: 'piped' };
}

/**
 * Has the CLI's own login finished? Detected by FILE EXISTENCE ONLY -- this
 * never opens/parses the credential file, per the brief's binding rule.
 *
 * @returns {'pending'|'done'}
 */
export function cliLoginStatus({ provider, root, existsSync = fs.existsSync } = {}) {
  return existsSync(credentialPath(provider, root)) ? 'done' : 'pending';
}

// ---------------------------------------------------------------------------
// Stage 2: hand the login to TeamClaude.
// ---------------------------------------------------------------------------

// docs/설계.md 2-2 + 10 #4: the soul-local ("portable") TeamClaude config.
// install() creates this folder and points the user's TEAMCLAUDE_CONFIG at
// the file, so the relay's account list travels with the soul folder instead
// of living in %USERPROFILE%\.config.
export function portableTeamclaudeConfigDir(root) {
  return path.join(root, '_agent', 'shared', 'portable-state', 'teamclaude');
}

export function portableTeamclaudeConfigPath(root) {
  return path.join(portableTeamclaudeConfigDir(root), 'teamclaude.json');
}

// Resolution order (2026-09-12 final review I2):
//   1. the receipt of the soul being installed -- install() records the path
//      it actually set the user variable to, and that is authoritative even
//      though the *installer's own process* never sees the new user env var
//      (a process only picks up HKCU\Environment at creation time);
//   2. $env:TEAMCLAUDE_CONFIG, for a shell that already has it;
//   3. the OS default, matching both TeamClaude's own getConfigPath() and
//      patches/teamclaude/teamclaude-manage.ps1.
// Step 1 is what keeps a real ⓔ click on a machine that is already an IRIS
// soul out of the developer's live %USERPROFILE%\.config\teamclaude.json.
export function resolveTeamclaudeConfigPath({
  root, env = process.env, homedir = os.homedir, readReceiptFn = readReceipt,
} = {}) {
  if (root) {
    try {
      const recorded = readReceiptFn(root)?.env?.teamclaudeConfig;
      if (typeof recorded === 'string' && recorded.length > 0) return recorded;
    } catch { /* unreadable receipt -> fall through to the env/OS default */ }
  }
  if (env.TEAMCLAUDE_CONFIG) return env.TEAMCLAUDE_CONFIG;
  return path.join(homedir(), '.config', 'teamclaude.json');
}

async function reloadRunningServer(port, fetchFn) {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

// Write (or refresh) the codex account's `importFrom` pointer in TeamClaude's
// config. Never touches accessToken/refreshToken -- only a filesystem path,
// which TeamClaude's own resolve-accounts.js reads live on every reload.
//
// Fix round 1 finding 1: only a missing file (ENOENT) may default to a fresh
// minimal config -- mirrors TeamClaude's own loadConfig() (src/config.js),
// which returns null on ENOENT and re-throws every other error. A blanket
// catch-all here would treat invalid JSON / EACCES / a transient read while
// the live server is mid-write as "no config exists" and then
// writeJsonFileAtomic below would REPLACE the real, populated config -- on
// this PC that is the developer's live TeamClaude account set. So any other
// read failure is returned as a reported failure and NOTHING is written.
//
// Fix round 1 finding 2 (read-modify-write race, no code change beyond this
// comment): TeamClaude serializes its own config writes through its internal
// `configUpdateChain` (src/config.js), but this function's read here and its
// write below are two separate filesystem operations -- a live server write
// could land in between. The write stays atomic (write .tmp, then rename)
// and the window is kept minimal (read happens immediately before write,
// synchronously, with no I/O or await in between) to shrink, not eliminate,
// that race.
// 코덱스 계정의 사람 이름(2026-09-20, 2.0.30): 코덱스 CLI 의 auth.json 이 든 id_token(JWT) 의 `email` 클레임.
// TeamClaude 자체 로그인(login --codex)은 이 이메일로 계정 이름을 짓는데, 설치기의 importFrom 항목은 'codex' 로
// 고정돼 대시보드에 "CODEX" 로만 보였다(데스크탑 실측). 서명은 검증하지 않는다 — 이름표일 뿐이다.
export function decodeJwtClaims(token) {
  try {
    const part = String(token ?? '').split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const o = JSON.parse(json);
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}
export function codexIdentityFromAuth(root, { fs: fsImpl = fs } = {}) {
  try {
    const raw = JSON.parse(fsImpl.readFileSync(credentialPath('chatgpt', root), 'utf8'));
    const tokens = raw?.tokens ?? {};
    const claims = decodeJwtClaims(tokens.id_token) ?? {};
    const auth = claims['https://api.openai.com/auth'] ?? {};
    const email = typeof claims.email === 'string' && claims.email.includes('@') ? claims.email : null;
    return { email, accountId: auth.chatgpt_account_id ?? tokens.account_id ?? null, planType: auth.chatgpt_plan_type ?? null };
  } catch { return { email: null, accountId: null, planType: null }; }
}

/** 이미 있는 importFrom 항목에 displayName(이메일)만 채운다 — name 은 바꾸지 않는다(실행 중 중계기가 다른 계정으로 오인하지 않게;
 *  displayName 은 reload 때 그대로 반영된다). → { ok, changed, email } */
export function refreshCodexDisplayName({ root, teamclaudeConfigPath, fs: fsImpl = fs } = {}) {
  const { email } = codexIdentityFromAuth(root, { fs: fsImpl });
  if (!email) return { ok: true, changed: false, email: null };
  let config;
  try { config = JSON.parse(fsImpl.readFileSync(teamclaudeConfigPath, 'utf8')); } catch { return { ok: false, changed: false, email }; }
  const importFrom = credentialPath('chatgpt', root);
  let changed = false;
  for (const a of Array.isArray(config.accounts) ? config.accounts : []) {
    if (a.provider === 'codex' && a.importFrom === importFrom && a.displayName !== email) { a.displayName = email; changed = true; }
  }
  if (changed) {
    try { writeJsonFileAtomic(teamclaudeConfigPath, config); } catch { return { ok: false, changed: false, email }; }
  }
  return { ok: true, changed, email };
}

function writeCodexImportEntry({ root, teamclaudeConfigPath, name = null }) {
  let config;
  try {
    config = readJsonFile(teamclaudeConfigPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      config = { accounts: [] };
    } else {
      return { ok: false, reason: 'config-unreadable', detail: String(err?.message ?? err) };
    }
  }
  config.accounts = Array.isArray(config.accounts) ? config.accounts : [];
  const importFrom = credentialPath('chatgpt', root);
  const idx = config.accounts.findIndex((a) => a.provider === 'codex' && a.importFrom === importFrom);
  const identity = codexIdentityFromAuth(root);
  const entry = { name: name ?? identity.email ?? 'codex', type: 'oauth', provider: 'codex', importFrom, ...(identity.email ? { displayName: identity.email } : {}) };
  if (idx >= 0) {
    // 있는 항목은 이름을 지키고(실행 중 중계기의 계정 정체성) 표시 이름만 갱신한다.
    config.accounts[idx] = { ...config.accounts[idx], ...entry, name: config.accounts[idx].name };
  } else {
    config.accounts.push(entry);
  }
  try {
    writeJsonFileAtomic(teamclaudeConfigPath, config);
  } catch (err) {
    // A failure here is a DIFFERENT situation from an unreadable config
    // above: the file we read was fine, so nothing about the real config was
    // ever misjudged -- disk write itself just failed (permissions, disk
    // full, a race on the .tmp path). Unlike a read failure, no bytes have
    // been touched, so relayImport() below is free to fall back to a
    // detached interactive login for this reason.
    return { ok: false, reason: 'config-write-failed', detail: String(err?.message ?? err) };
  }
  return { ok: true };
}

/**
 * Register the just-completed CLI login with TeamClaude.
 *   - claude: real CLI import mechanism (`import --from <credentials path>`),
 *     which itself saves the config and notifies a running server. Falls
 *     back to a detached `login` browser flow if the import call fails.
 *   - chatgpt/codex: no CLI import flag exists, so an `importFrom` config
 *     entry is written directly and the running server is asked to reload.
 *     Falls back to a detached `login --codex` browser flow if that fails.
 *
 * @returns {Promise<{ok: boolean, method: 'import'|'login'}>}
 */
export async function relayImport({
  provider,
  root,
  nodeDir,
  teamclaudeConfigPath,
  port = DEFAULT_PORT,
  runFn = run,
  spawnFn = spawn,
  fetchFn = fetch,
  reloadFn,
} = {}) {
  const configPath = teamclaudeConfigPath ?? resolveTeamclaudeConfigPath({ root });
  const nodeExe = path.join(nodeDir, 'node.exe');
  const entryPath = teamclaudeEntryPath(root);
  const doReload = reloadFn ?? ((p) => reloadRunningServer(p, fetchFn));

  const startDetachedLogin = (loginProvider) => {
    const args = loginProvider === 'claude' ? ['login'] : ['login', '--codex'];
    const line = `"${nodeExe}" "${entryPath}" ${args.join(' ')}`;
    try {
      const child = spawnFn(COMSPEC, ['/d', '/s', '/c', line], {
        windowsHide: false,
        windowsVerbatimArguments: true,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
      });
      child.unref?.();
      return { ok: true, method: 'login' };
    } catch {
      return { ok: false, method: 'login' };
    }
  };

  if (provider === 'claude') {
    const credPath = credentialPath('claude', root);
    const result = await runFn(nodeExe, [entryPath, 'import', '--from', credPath], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    });
    if (result.code === 0) {
      return { ok: true, method: 'import' };
    }
    return startDetachedLogin('claude');
  }

  // chatgpt / codex
  const writeResult = writeCodexImportEntry({ root, teamclaudeConfigPath: configPath });
  if (!writeResult.ok) {
    if (writeResult.reason === 'config-unreadable') {
      // Fix round 1 finding 1: an unreadable/corrupt config is NOT a reason
      // to fall back to a detached browser login -- that would still leave
      // the real problem (a config file this module could not safely touch)
      // unresolved and hidden. Propagate the failure so the caller
      // (server.mjs route -> the screen, eventually) can report it instead.
      return writeResult;
    }
    // reason === 'config-write-failed': the config was read fine and never
    // modified on disk -- this is the same kind of recoverable failure as a
    // failed reload below, so fall back to a detached interactive login.
    return startDetachedLogin('chatgpt');
  }
  // 2026-09-18 실사용 진단 TC-02: reload 는 실패를 `{ok:false}` 로 돌려주는데 반환값을 보지 않고 성공으로
  // 적었다 — 실행 중계기가 새 계정을 못 읽었는데 화면은 "연결됨". 이제 결과를 보고, 실패면 대화형 로그인으로.
  try {
    const reloaded = await doReload(port);
    if (reloaded && reloaded.ok === false) return startDetachedLogin('chatgpt');
    return { ok: true, method: 'import' };
  } catch {
    return startDetachedLogin('chatgpt');
  }
}

// ---------------------------------------------------------------------------
// 중계기 설정 파일의 기본 틀 (2026-09-17 실제 사용자 실측, 2.0.7 → 2.0.8)
//
// 설치기는 지금까지 `{ accounts: [] }` 만 썼다. 그런데 관리 스크립트
// (patches/teamclaude/teamclaude-manage.ps1 9행)는 `config.proxy.port -eq 3456` 을
// 검사하고, 중계기 자신의 `loadConfig()` 는 빠진 칸을 기본값으로 채우지 **않는다**
// (`createDefaultConfig()` 는 새 파일을 만들 때만 쓰인다). 그래서 실제 PC 에서
// 「계정 연결」이 "This helper manages only the TeamClaude proxy on port 3456" 로
// 서 버렸다 — 가상 PC 시험은 로그인 앞에서 멈추므로 이 단계를 밟지 않아 못 잡았다.
// 아래 틀은 중계기 1.1.16 `createDefaultConfig()` 와 같은 칸이다(판 고정, lock.json).
// ---------------------------------------------------------------------------
export const RELAY_PORT_DEFAULT = 3456;

export function defaultRelayConfig({ randomBytes = crypto.randomBytes } = {}) {
  return {
    proxy: { port: RELAY_PORT_DEFAULT, apiKey: `tc-${randomBytes(24).toString('base64url')}` },
    upstream: 'https://api.anthropic.com',
    // 전환 임계점 = 100%(2.0.31, 2026-09-20 사용자 결정). 중계기 자체 기본값 0.98 은 98% 에서 다음 계정으로
    // 넘어가 마지막 2% 를 버린다. 옛 설치가 남긴 0.98 은 ensureRelayConfigDefaults 가 1 로 올린다.
    switchThreshold: 1,
    holdSeconds: 0,
    distributeSessions: false,
    sessionTitles: { enabled: false, width: 18 },
    eventLogging: 'hide',
    blockedModels: [],
    accounts: [],
  };
}

/**
 * 이미 있는 설정 파일에 빠진 칸(특히 `proxy.port`)만 채운다. 계정·토큰·사용자가 바꾼 값은
 * 한 글자도 건드리지 않는다. 파일이 없거나 읽을 수 없으면 아무것도 하지 않는다.
 * @returns {{ patched: string[] }} 채운 칸 이름(없으면 빈 배열)
 */
export function ensureRelayConfigDefaults(configPath, { fs: fsImpl = fs, randomBytes } = {}) {
  if (!configPath || !fsImpl.existsSync(configPath)) return { patched: [] };
  let config;
  try {
    config = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
  } catch {
    return { patched: [] };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { patched: [] };
  const defaults = defaultRelayConfig(randomBytes ? { randomBytes } : {});
  const patched = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (config[key] === undefined || config[key] === null) { config[key] = value; patched.push(key); }
  }
  if (typeof config.proxy !== 'object' || config.proxy === null) { config.proxy = defaults.proxy; if (!patched.includes('proxy')) patched.push('proxy'); }
  if (Number(config.proxy.port) !== RELAY_PORT_DEFAULT && (config.proxy.port === undefined || config.proxy.port === null)) {
    config.proxy.port = RELAY_PORT_DEFAULT; patched.push('proxy.port');
  }
  if (!config.proxy.apiKey) { config.proxy.apiKey = defaults.proxy.apiKey; patched.push('proxy.apiKey'); }
  if (!Array.isArray(config.accounts)) { config.accounts = []; if (!patched.includes('accounts')) patched.push('accounts'); }
  // 전환 임계점(2.0.31): 0.98 은 설치기 ≤2.0.30 과 중계기 자체가 쓰던 "손대지 않은 기본값"이라 1(100%) 로
  // 올린다. 다른 값은 사용자가 정한 것이므로 그대로 둔다. 계정·토큰은 여전히 무접촉.
  if (config.switchThreshold === 0.98) { config.switchThreshold = 1; patched.push('switchThreshold'); }
  if (patched.length === 0) return { patched };
  const tmp = `${configPath}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fsImpl.renameSync(tmp, configPath);
  return { patched };
}

/**
 * Current count of TeamClaude accounts belonging to `provider`. Reads ONLY
 * the array length and each entry's `provider` field -- never a token.
 */
export async function countProviderAccounts({ teamclaudeConfigPath, provider } = {}) {
  let config;
  try {
    config = readJsonFile(teamclaudeConfigPath);
  } catch {
    return 0;
  }
  const accounts = Array.isArray(config?.accounts) ? config.accounts : [];
  return accounts.filter((a) => accountMatchesProvider(a, provider)).length;
}

/**
 * Poll TeamClaude's config file for that provider's account count. `done`
 * once the count passes `accountsBefore` -- i.e. at least one new account of
 * this provider joined. Reads ONLY counts -- never tokens.
 *
 * @returns {Promise<'pending'|'done'>}
 */
export async function relayStatus({ teamclaudeConfigPath, root, provider, accountsBefore = 0 } = {}) {
  const configPath = teamclaudeConfigPath ?? resolveTeamclaudeConfigPath({ root });
  const count = await countProviderAccounts({ teamclaudeConfigPath: configPath, provider });
  return count > accountsBefore ? 'done' : 'pending';
}
