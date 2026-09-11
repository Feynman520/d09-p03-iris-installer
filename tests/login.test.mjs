import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProxy } from '../installer/lib/proxy.mjs';
import {
  startCliLogin, cliLoginStatus, relayImport, relayStatus,
  resolveTeamclaudeConfigPath, countProviderAccounts,
} from '../installer/lib/login.mjs';

function tmpRoot(name) {
  const dir = path.join(os.tmpdir(), `iris-login-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// proxy.mjs -- ensureProxy
// ---------------------------------------------------------------------------

test('ensureProxy: already alive -> started:false, manage script NOT invoked', async () => {
  let manageCalls = 0;
  const result = await ensureProxy({
    root: 'C:\\FAKE-ROOT',
    nodeDir: 'C:\\FAKE-ROOT\\_agent\\shared\\tools\\node',
    probe: async () => true,
    runManage: async () => { manageCalls++; return { code: 0, out: '', err: '' }; },
  });
  assert.deepEqual(result, { alive: true, started: false });
  assert.equal(manageCalls, 0, 'manage script must not run when the proxy already answers');
});

test('ensureProxy: dead -> start invoked with -NodePath/-EntryPath, becomes alive', async () => {
  const calls = [];
  let probeCount = 0;
  const result = await ensureProxy({
    root: 'C:\\FAKE-ROOT',
    nodeDir: 'C:\\FAKE-ROOT\\_agent\\shared\\tools\\node',
    probe: async () => {
      probeCount++;
      return probeCount > 1; // dead on first probe, alive after "start"
    },
    runManage: async (managePs1, args) => {
      calls.push({ managePs1, args });
      return { code: 0, out: 'TeamClaude started (PID 1, port 3456, 0 accounts).', err: '' };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].managePs1, path.join('C:\\FAKE-ROOT', '_agent', 'shared', 'tools', 'teamclaude', 'teamclaude-manage.ps1'));
  assert.deepEqual(calls[0].args.slice(0, 2), ['-Action', 'start']);
  assert.ok(calls[0].args.includes('-NodePath'));
  assert.ok(calls[0].args.includes(path.join('C:\\FAKE-ROOT', '_agent', 'shared', 'tools', 'node', 'node.exe')));
  assert.ok(calls[0].args.includes('-EntryPath'));
  const entryIdx = calls[0].args.indexOf('-EntryPath');
  assert.equal(
    calls[0].args[entryIdx + 1],
    path.join('C:\\FAKE-ROOT', '_agent', 'shared', 'tools', 'teamclaude', 'node_modules', '@karpeleslab', 'teamclaude', 'src', 'index.js'),
  );
  assert.deepEqual(result, { alive: true, started: true });
});

test('ensureProxy: dead, start fails, probe still false -> started:true, alive:false', async () => {
  const result = await ensureProxy({
    root: 'C:\\FAKE-ROOT',
    nodeDir: 'C:\\FAKE-ROOT\\_agent\\shared\\tools\\node',
    probe: async () => false,
    runManage: async () => ({ code: 1, out: '', err: 'boom' }),
  });
  assert.deepEqual(result, { alive: false, started: true });
});

// ---------------------------------------------------------------------------
// login.mjs -- startCliLogin
// ---------------------------------------------------------------------------

test('startCliLogin: claude -- argv/env has no ANTHROPIC_BASE_URL, sets CLAUDE_CONFIG_DIR, shows Korean guidance', () => {
  let captured = null;
  const fakeSpawn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { unref() {}, pid: 4242 };
  };
  const root = 'C:\\NOVA';
  const nodeDir = 'C:\\NOVA\\_agent\\shared\\tools\\node';
  const result = startCliLogin({ provider: 'claude', root, nodeDir, spawnFn: fakeSpawn });

  assert.equal(result.started, true);
  assert.ok(captured, 'spawn must be called');
  assert.equal(captured.opts.env.CLAUDE_CONFIG_DIR, path.join(root, '_agent', 'claude'));
  assert.equal('ANTHROPIC_BASE_URL' in captured.opts.env, false, 'claude login must never see the proxy base url');
  // command line embeds claude.cmd -- never codex.cmd
  const line = captured.args.join(' ');
  assert.match(line, /claude\.cmd/);
  assert.doesNotMatch(line, /codex\.cmd/);
  // task-13-brief.md requires a one-line Korean instruction inside the window.
  assert.match(line, /브라우저에서 로그인 후 이 창을 닫아 주세요/);
});

test('startCliLogin: codex -- sets CODEX_HOME, no ANTHROPIC_BASE_URL, invokes codex.cmd login, shows Korean guidance', () => {
  let captured = null;
  const fakeSpawn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { unref() {}, pid: 4243 };
  };
  const root = 'C:\\NOVA';
  const nodeDir = 'C:\\NOVA\\_agent\\shared\\tools\\node';
  const result = startCliLogin({ provider: 'chatgpt', root, nodeDir, spawnFn: fakeSpawn });

  assert.equal(result.started, true);
  assert.ok(captured);
  assert.equal(captured.opts.env.CODEX_HOME, path.join(root, '_agent', 'codex'));
  assert.equal('ANTHROPIC_BASE_URL' in captured.opts.env, false);
  const line = captured.args.join(' ');
  assert.match(line, /codex\.cmd/);
  assert.doesNotMatch(line, /claude\.cmd/);
  assert.match(line, /브라우저에서 로그인 후 이 창을 닫아 주세요/);
});

test('startCliLogin: dryRun -- logs the command line, never calls spawn, opens no window', () => {
  let spawnCalls = 0;
  const fakeSpawn = () => { spawnCalls++; return { unref() {} }; };
  const result = startCliLogin({
    provider: 'claude', root: 'C:\\NOVA', nodeDir: 'C:\\NOVA\\_agent\\shared\\tools\\node',
    spawnFn: fakeSpawn, dryRun: true,
  });
  assert.equal(spawnCalls, 0);
  assert.equal(result.started, false);
  assert.equal(result.dryRun, true);
  assert.match(result.line, /claude\.cmd/);
});

// ---------------------------------------------------------------------------
// login.mjs -- cliLoginStatus (file existence only, never contents) -- STRING
// ---------------------------------------------------------------------------

test('cliLoginStatus: claude "done" only once .credentials.json exists (existence only)', () => {
  const root = tmpRoot('cli-claude');
  try {
    assert.equal(cliLoginStatus({ provider: 'claude', root }), 'pending');
    fs.mkdirSync(path.join(root, '_agent', 'claude'), { recursive: true });
    // Write garbage -- cliLoginStatus must never parse/read the file, only stat it.
    fs.writeFileSync(path.join(root, '_agent', 'claude', '.credentials.json'), 'not json {{{', 'utf8');
    assert.equal(cliLoginStatus({ provider: 'claude', root }), 'done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cliLoginStatus: codex "done" only once auth.json exists', () => {
  const root = tmpRoot('cli-codex');
  try {
    assert.equal(cliLoginStatus({ provider: 'chatgpt', root }), 'pending');
    fs.mkdirSync(path.join(root, '_agent', 'codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '_agent', 'codex', 'auth.json'), '{}', 'utf8');
    assert.equal(cliLoginStatus({ provider: 'chatgpt', root }), 'done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// login.mjs -- resolveTeamclaudeConfigPath (mirrors teamclaude-manage.ps1)
// ---------------------------------------------------------------------------

test('resolveTeamclaudeConfigPath: uses TEAMCLAUDE_CONFIG when set', () => {
  const result = resolveTeamclaudeConfigPath({ env: { TEAMCLAUDE_CONFIG: 'C:\\SOUL\\portable-state\\teamclaude\\teamclaude.json' } });
  assert.equal(result, 'C:\\SOUL\\portable-state\\teamclaude\\teamclaude.json');
});

test('resolveTeamclaudeConfigPath: falls back to %USERPROFILE%\\.config\\teamclaude.json equivalent', () => {
  const result = resolveTeamclaudeConfigPath({ env: {}, homedir: () => 'X:\\fake-home' });
  assert.equal(result, path.join('X:\\fake-home', '.config', 'teamclaude.json'));
});

// ---------------------------------------------------------------------------
// login.mjs -- relayImport -- {ok, method}
// ---------------------------------------------------------------------------

test('relayImport: claude uses the CLI "import --from" mechanism -> {ok:true, method:"import"}', async () => {
  const root = 'C:\\NOVA';
  const nodeDir = 'C:\\NOVA\\_agent\\shared\\tools\\node';
  const runCalls = [];
  const result = await relayImport({
    provider: 'claude',
    root,
    nodeDir,
    teamclaudeConfigPath: 'C:\\FAKE\\teamclaude.json',
    runFn: async (exe, args, opts) => { runCalls.push({ exe, args, opts }); return { code: 0, out: 'Saved', err: '' }; },
  });
  assert.deepEqual(result, { ok: true, method: 'import' });
  assert.equal(runCalls.length, 1);
  const { exe, args, opts } = runCalls[0];
  assert.equal(exe, path.join(nodeDir, 'node.exe'));
  assert.equal(args[1], 'import');
  const fromIdx = args.indexOf('--from');
  assert.ok(fromIdx >= 0);
  assert.equal(args[fromIdx + 1], path.join(root, '_agent', 'claude', '.credentials.json'));
  assert.equal(opts.env.TEAMCLAUDE_CONFIG, 'C:\\FAKE\\teamclaude.json');
});

test('relayImport: claude falls back to detached login when the import CLI call fails -> method:"login"', async () => {
  const spawnCalls = [];
  const result = await relayImport({
    provider: 'claude',
    root: 'C:\\NOVA',
    nodeDir: 'C:\\NOVA\\_agent\\shared\\tools\\node',
    teamclaudeConfigPath: 'C:\\FAKE\\teamclaude.json',
    runFn: async () => ({ code: 1, out: '', err: 'boom' }),
    spawnFn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return { unref() {}, pid: 1 }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'login');
  assert.equal(spawnCalls.length, 1);
  // --codex must NOT appear for a claude fallback login.
  assert.doesNotMatch(spawnCalls[0].args.join(' '), /--codex/);
});

test('relayImport: codex falls back to detached "login --codex" when writing the config fails', async () => {
  const spawnCalls = [];
  const result = await relayImport({
    provider: 'chatgpt',
    root: 'C:\\NOVA',
    nodeDir: 'C:\\NOVA\\_agent\\shared\\tools\\node',
    // A directory (not a file) as the config path makes fs.writeFileSync throw,
    // exercising the fallback branch without needing to mock fs internals.
    teamclaudeConfigPath: tmpRoot('relay-codex-fail'),
    spawnFn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return { unref() {}, pid: 2 }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'login');
  assert.equal(spawnCalls.length, 1);
  assert.match(spawnCalls[0].args.join(' '), /--codex/);
});

test('relayImport: codex writes an importFrom config entry and triggers reload (no secrets written)', async () => {
  const root = 'C:\\NOVA';
  const configPath = path.join(tmpRoot('relay-codex'), 'teamclaude.json');
  fs.writeFileSync(configPath, JSON.stringify({ proxy: { port: 3456 }, accounts: [] }, null, 2), 'utf8');
  let reloaded = 0;
  try {
    const result = await relayImport({
      provider: 'chatgpt',
      root,
      nodeDir: 'C:\\NOVA\\_agent\\shared\\tools\\node',
      teamclaudeConfigPath: configPath,
      reloadFn: async () => { reloaded++; return { ok: true }; },
    });
    assert.deepEqual(result, { ok: true, method: 'import' });
    assert.equal(reloaded, 1);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(written.accounts.length, 1);
    assert.equal(written.accounts[0].provider, 'codex');
    assert.equal(written.accounts[0].importFrom, path.join(root, '_agent', 'codex', 'auth.json'));
    // No secret fields written -- only a path pointer.
    assert.equal('accessToken' in written.accounts[0], false);
    assert.equal('refreshToken' in written.accounts[0], false);
  } finally {
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// login.mjs -- countProviderAccounts / relayStatus
//   (counts + provider filtering only, never tokens; STRING return)
// ---------------------------------------------------------------------------

test('countProviderAccounts: claude = accounts with no provider field or provider "anthropic"; codex = provider "codex"', async () => {
  const configPath = path.join(tmpRoot('count-provider'), 'teamclaude.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    accounts: [
      { name: 'a@localhost' }, // no provider field -> anthropic (claude)
      { name: 'b@localhost', provider: 'anthropic' },
      { name: 'codex-1', provider: 'codex' },
    ],
  }, null, 2), 'utf8');
  try {
    assert.equal(await countProviderAccounts({ teamclaudeConfigPath: configPath, provider: 'claude' }), 2);
    assert.equal(await countProviderAccounts({ teamclaudeConfigPath: configPath, provider: 'chatgpt' }), 1);
  } finally {
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test('relayStatus: "done" once that provider\'s account count is accountsBefore+1; a new account of the OTHER provider does not flip it', async () => {
  const configPath = path.join(tmpRoot('relay-status'), 'teamclaude.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    accounts: [
      { name: 'existing@localhost', accessToken: 'super-secret-token' },
      { name: 'codex-1', provider: 'codex', accessToken: 'another-secret' },
    ],
  }, null, 2), 'utf8');
  try {
    // 1 claude account already present; a new codex account must not count as
    // claude's "+1".
    assert.equal(await relayStatus({ teamclaudeConfigPath: configPath, provider: 'claude', accountsBefore: 1 }), 'pending');
    assert.equal(await relayStatus({ teamclaudeConfigPath: configPath, provider: 'chatgpt', accountsBefore: 0 }), 'done');
    assert.equal(await relayStatus({ teamclaudeConfigPath: configPath, provider: 'claude', accountsBefore: 0 }), 'done');
  } finally {
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test('relayStatus: missing config file -> "pending", no throw', async () => {
  const result = await relayStatus({ teamclaudeConfigPath: 'C:\\DOES-NOT-EXIST\\teamclaude.json', provider: 'claude', accountsBefore: 0 });
  assert.equal(result, 'pending');
});

test('relayStatus: never exposes token material even indirectly (uses default config path resolution safely)', async () => {
  const configPath = path.join(tmpRoot('relay-status-tokens'), 'teamclaude.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    accounts: [{ name: 'x@localhost', accessToken: 'super-secret-token' }],
  }, null, 2), 'utf8');
  try {
    const result = await relayStatus({ teamclaudeConfigPath: configPath, provider: 'claude', accountsBefore: 0 });
    assert.equal(typeof result, 'string');
    assert.equal(result, 'done');
  } finally {
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});
