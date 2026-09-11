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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../lib/run.mjs';

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
export function startCliLogin({ provider, root, nodeDir, spawnFn = spawn, dryRun = false } = {}) {
  const tools = toolsDir(root);
  const cmdPath = provider === 'claude'
    ? path.join(tools, 'claude', 'claude.cmd')
    : path.join(tools, 'codex', 'codex.cmd');

  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;
  env.PATH = `${nodeDir};${env.PATH ?? ''}`;
  if (provider === 'claude') {
    env.CLAUDE_CONFIG_DIR = path.join(root, '_agent', 'claude');
  } else {
    env.CODEX_HOME = path.join(root, '_agent', 'codex');
  }

  const title = provider === 'claude' ? 'IRIS Claude login' : 'IRIS Codex login';
  // Brief-mandated one-line guidance inside the spawned console (this is a
  // user-facing screen the person watches during the login, not a server
  // log message, so the Korean text constraint on server.mjs's own output
  // does not apply here).
  const echoText = '브라우저에서 로그인 후 이 창을 닫아 주세요.';
  // `cmd /k` keeps the window open after login finishes so the user can see
  // the result; the whole thing is one quoted command string per cmd.exe's
  // `start` rule (a quoted title makes `start` treat the NEXT quoted token
  // as the window title, so the command itself needs its own quoting layer).
  const inner = `"echo ${echoText} && "${cmdPath}" login"`;
  const line = `start "${title}" cmd /k ${inner}`;
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

// Mirrors patches/teamclaude/teamclaude-manage.ps1's own resolution: prefer
// $env:TEAMCLAUDE_CONFIG (the portable-soul path a future install step may
// set it to) and only fall back to the OS default when that isn't set.
export function resolveTeamclaudeConfigPath({ env = process.env, homedir = os.homedir } = {}) {
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
function writeCodexImportEntry({ root, teamclaudeConfigPath, name = 'codex' }) {
  let config;
  try {
    config = readJsonFile(teamclaudeConfigPath);
  } catch {
    config = { accounts: [] };
  }
  config.accounts = Array.isArray(config.accounts) ? config.accounts : [];
  const importFrom = credentialPath('chatgpt', root);
  const idx = config.accounts.findIndex((a) => a.provider === 'codex' && a.importFrom === importFrom);
  const entry = { name, type: 'oauth', provider: 'codex', importFrom };
  if (idx >= 0) {
    config.accounts[idx] = { ...config.accounts[idx], ...entry };
  } else {
    config.accounts.push(entry);
  }
  writeJsonFileAtomic(teamclaudeConfigPath, config);
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
  const configPath = teamclaudeConfigPath ?? resolveTeamclaudeConfigPath();
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
  try {
    writeCodexImportEntry({ root, teamclaudeConfigPath: configPath });
    await doReload(port);
    return { ok: true, method: 'import' };
  } catch {
    return startDetachedLogin('chatgpt');
  }
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
export async function relayStatus({ teamclaudeConfigPath, provider, accountsBefore = 0 } = {}) {
  const configPath = teamclaudeConfigPath ?? resolveTeamclaudeConfigPath();
  const count = await countProviderAccounts({ teamclaudeConfigPath: configPath, provider });
  return count > accountsBefore ? 'done' : 'pending';
}
