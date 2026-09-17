import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProxy } from '../installer/lib/proxy.mjs';
import {
  startCliLogin, cliLoginStatus, relayImport, relayStatus,
  resolveTeamclaudeConfigPath, countProviderAccounts,
  portableTeamclaudeConfigDir, portableTeamclaudeConfigPath,
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

test('ensureRelayConfigDefaults: 빠진 칸만 채우고 있는 값은 그대로, 파일 없으면 아무것도 안 한다 (2.0.8)', async () => {
  const { ensureRelayConfigDefaults, defaultRelayConfig } = await import('../installer/lib/login.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-relaycfg-'));
  const cfg = path.join(dir, 'teamclaude.json');
  // 없는 파일: 무접촉
  assert.deepEqual(ensureRelayConfigDefaults(cfg), { patched: [] });
  assert.ok(!fs.existsSync(cfg));
  // 옛 틀: accounts 만
  fs.writeFileSync(cfg, JSON.stringify({ accounts: [{ id: 'x', provider: 'claude' }] }), 'utf8');
  const r1 = ensureRelayConfigDefaults(cfg);
  assert.ok(r1.patched.includes('proxy') && r1.patched.includes('upstream'));
  const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(after.proxy.port, 3456);
  assert.match(after.proxy.apiKey, /^tc-/);
  assert.deepEqual(after.accounts, [{ id: 'x', provider: 'claude' }]);
  // 두 번째는 아무것도 안 바꾼다
  assert.deepEqual(ensureRelayConfigDefaults(cfg), { patched: [] });
  // 사용자가 바꾼 포트·값은 존중(3456 아니어도 덮지 않는다 — 관리 스크립트가 거절할 뿐)
  fs.writeFileSync(cfg, JSON.stringify({ ...defaultRelayConfig(), proxy: { port: 4000, apiKey: 'tc-user' }, upstream: 'https://x' }), 'utf8');
  assert.deepEqual(ensureRelayConfigDefaults(cfg), { patched: [] });
  assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).proxy.port, 4000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureProxy: dead, start fails, probe still false -> started:true, alive:false', async () => {
  const result = await ensureProxy({
    root: 'C:\\FAKE-ROOT',
    nodeDir: 'C:\\FAKE-ROOT\\_agent\\shared\\tools\\node',
    probe: async () => false,
    runManage: async () => ({ code: 1, out: '', err: 'boom' }),
  });
  assert.equal(result.alive, false);
  assert.equal(result.started, true);
  // 2026-09-17(2.0.7): 못 띄운 까닭을 함께 돌려준다 — 화면 문장·로그가 쓴다.
  assert.equal(result.detail.manageExit, 1);
  assert.equal(result.detail.manageErr, 'boom');
  assert.equal(result.detail.manageScriptExists, false, '가짜 루트라 스크립트가 없다');
  assert.equal(result.detail.port, 3456);
});

// ---------------------------------------------------------------------------
// login.mjs -- startCliLogin
// ---------------------------------------------------------------------------

test('startCliLogin: claude -- argv/env has no ANTHROPIC_BASE_URL, sets CLAUDE_CONFIG_DIR, shows ASCII guidance', () => {
  // Fix round 1 finding 3: set a sentinel BEFORE calling startCliLogin so the
  // "absent from the built env" assertion actually proves startCliLogin
  // deletes it, rather than merely observing that the test runner's own
  // process never had it set in the first place.
  const hadSentinel = 'ANTHROPIC_BASE_URL' in process.env;
  const previousValue = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456';
  try {
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
    // 2026-09-13: Claude Code 2.1.x authenticates with `claude auth login`
    // (`claude login` does not exist -- it prints the general help). The
    // window must close by itself on success and stay open only on failure.
    assert.match(line, /claude\.cmd" auth login --claudeai/);
    assert.match(line, /cmd \/c /);
    assert.match(line, /\|\| pause/);
    // Fix round 1 finding 4: the in-window guidance must be plain ASCII --
    // Korean text inside a cmd line can render as mojibake on a cp949
    // console. Korean guidance belongs on the installer's own HTML screen
    // (Task 14) instead.
    assert.match(line, /Log in in the browser\. This window closes by itself when the login is done\./);
    assert.doesNotMatch(line, /[\u3130-\u318F\uAC00-\uD7A3]/, 'no Hangul characters in the spawned console line');
  } finally {
    if (hadSentinel) process.env.ANTHROPIC_BASE_URL = previousValue;
    else delete process.env.ANTHROPIC_BASE_URL;
  }
});

test('startCliLogin: codex -- sets CODEX_HOME, no ANTHROPIC_BASE_URL, invokes codex.cmd login, shows ASCII guidance', () => {
  const hadSentinel = 'ANTHROPIC_BASE_URL' in process.env;
  const previousValue = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456';
  try {
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
    // codex keeps its own `codex login`; the `auth` form is Claude-only.
    assert.match(line, /codex\.cmd" login/);
    assert.doesNotMatch(line, /auth login/);
    assert.match(line, /\|\| pause/);
    assert.match(line, /Log in in the browser\. This window closes by itself when the login is done\./);
    assert.doesNotMatch(line, /[\u3130-\u318F\uAC00-\uD7A3]/, 'no Hangul characters in the spawned console line');
  } finally {
    if (hadSentinel) process.env.ANTHROPIC_BASE_URL = previousValue;
    else delete process.env.ANTHROPIC_BASE_URL;
  }
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

test('relayImport: codex reports config-unreadable (and never falls back to login) when the config path is a directory', async () => {
  // Fix round 1 finding 1: a directory at the config path makes
  // fs.readFileSync throw EISDIR -- a non-ENOENT read failure. Per the
  // ruling, that must be REPORTED, never silently treated as "no config" and
  // never papered over by a detached browser login (which would leave the
  // real, unresolved problem -- a config path this module could not safely
  // read -- hidden from the person). This repurposes what used to be a
  // "write fails -> falls back to login" test: a directory path is
  // fundamentally a READ-time failure (fs.readFileSync throws before any
  // write is even attempted), so it now exercises the config-unreadable
  // propagation path instead. See the next test for a genuine write-time
  // failure, which still does fall back to login.
  const spawnCalls = [];
  const configDir = tmpRoot('relay-codex-read-fail');
  const result = await relayImport({
    provider: 'chatgpt',
    root: 'C:\\NOVA',
    nodeDir: 'C:\\NOVA\\_agent\\shared\\tools\\node',
    teamclaudeConfigPath: configDir,
    spawnFn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return { unref() {}, pid: 2 }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'config-unreadable');
  assert.ok(result.detail, 'a detail string must be present for the screen to show');
  assert.equal(spawnCalls.length, 0, 'a read failure must never trigger a detached login fallback');
});

test('relayImport: codex falls back to detached "login --codex" when the config read succeeds but the write itself fails', async () => {
  // Genuine write-time failure with a SUCCESSFUL read: the config file
  // itself is valid JSON, but the atomic write's `.tmp` path is occupied by
  // a directory, so fs.writeFileSync(tmp, ...) throws after the read already
  // succeeded. This is the scenario the ruling's finding 1 does NOT forbid a
  // login fallback for -- nothing about the real config was misread or
  // touched, so falling back to an interactive login (which does not write
  // to this config file itself) is still safe and expected here.
  const dir = tmpRoot('relay-codex-write-fail');
  const configPath = path.join(dir, 'teamclaude.json');
  fs.writeFileSync(configPath, JSON.stringify({ accounts: [] }, null, 2), 'utf8');
  fs.mkdirSync(`${configPath}.tmp`);
  const spawnCalls = [];
  try {
    const result = await relayImport({
      provider: 'chatgpt',
      root: 'C:\\NOVA',
      nodeDir: 'C:\\NOVA\\_agent\\shared\\tools\\node',
      teamclaudeConfigPath: configPath,
      spawnFn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return { unref() {}, pid: 2 }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.method, 'login');
    assert.equal(spawnCalls.length, 1);
    assert.match(spawnCalls[0].args.join(' '), /--codex/);
    // The original (unwritable) config bytes must be untouched.
    const stillThere = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(stillThere, { accounts: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('relayImport: codex reports config-unreadable and leaves the file byte-for-byte untouched when it contains invalid JSON', async () => {
  // Required by fix round 1 finding 1: an EXISTING config file with invalid
  // JSON must never be silently treated as "no config exists" (which would
  // let writeJsonFileAtomic REPLACE a real, populated config -- on the
  // developer's own PC that is the live TeamClaude account set). No write
  // may happen, the original bytes must be untouched, and the failure must
  // be reported back to the caller.
  const dir = tmpRoot('relay-codex-invalid-json');
  const configPath = path.join(dir, 'teamclaude.json');
  const originalBytes = '{ "accounts": [ this is not valid JSON ';
  fs.writeFileSync(configPath, originalBytes, 'utf8');
  const spawnCalls = [];
  try {
    const result = await relayImport({
      provider: 'chatgpt',
      root: 'C:\\NOVA',
      nodeDir: 'C:\\NOVA\\_agent\\shared\\tools\\node',
      teamclaudeConfigPath: configPath,
      spawnFn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return { unref() {}, pid: 2 }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'config-unreadable');
    assert.ok(result.detail, 'a detail string must be present for the screen to show');
    assert.equal(spawnCalls.length, 0, 'an unreadable config must never trigger a detached login fallback either');
    // The whole point of the fix: NOTHING was written. Bytes are identical.
    const bytesAfter = fs.readFileSync(configPath, 'utf8');
    assert.equal(bytesAfter, originalBytes);
    assert.equal(fs.existsSync(`${configPath}.tmp`), false, 'no temp file should have been left behind either');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// I2 (2026-09-12 final review): TEAMCLAUDE_CONFIG travels with the soul.
// ---------------------------------------------------------------------------
// The installer's own process never sees the user env var install() writes
// (HKCU\Environment is read at process creation), so every spawn has to carry
// the path explicitly, and the receipt -- not the environment -- is the
// authority for which config file this soul uses.

const FAKE_ROOT = 'C:\\NOVA';
const FAKE_NODE_DIR = 'C:\\NOVA\\_agent\\shared\\tools\\node';
const FAKE_PORTABLE_CONFIG = 'C:\\NOVA\\_agent\\shared\\portable-state\\teamclaude\\teamclaude.json';

test('resolveTeamclaudeConfigPath: the receipt of the soul wins over env and the OS default', () => {
  const result = resolveTeamclaudeConfigPath({
    root: FAKE_ROOT,
    env: { TEAMCLAUDE_CONFIG: 'C:\\SOMEWHERE-ELSE\\teamclaude.json' },
    homedir: () => 'X:\\fake-home',
    readReceiptFn: () => ({ env: { teamclaudeConfig: FAKE_PORTABLE_CONFIG } }),
  });
  assert.equal(result, FAKE_PORTABLE_CONFIG);
});

test('resolveTeamclaudeConfigPath: an unreadable/absent receipt falls through to env, then the OS default', () => {
  const throwing = () => { throw new Error('receipt unreadable'); };
  assert.equal(
    resolveTeamclaudeConfigPath({
      root: FAKE_ROOT,
      env: { TEAMCLAUDE_CONFIG: 'C:\\ENV\\teamclaude.json' },
      homedir: () => 'X:\\fake-home',
      readReceiptFn: throwing,
    }),
    'C:\\ENV\\teamclaude.json',
  );
  assert.equal(
    resolveTeamclaudeConfigPath({
      root: FAKE_ROOT, env: {}, homedir: () => 'X:\\fake-home', readReceiptFn: () => null,
    }),
    path.join('X:\\fake-home', '.config', 'teamclaude.json'),
  );
});

test('portableTeamclaudeConfigPath: the soul-local portable-state path', () => {
  assert.equal(
    portableTeamclaudeConfigPath(FAKE_ROOT),
    path.join(FAKE_ROOT, '_agent', 'shared', 'portable-state', 'teamclaude', 'teamclaude.json'),
  );
  assert.equal(portableTeamclaudeConfigDir(FAKE_ROOT), path.dirname(portableTeamclaudeConfigPath(FAKE_ROOT)));
});

test('startCliLogin: the spawned console carries TEAMCLAUDE_CONFIG (and still no ANTHROPIC_BASE_URL)', () => {
  const dry = startCliLogin({
    provider: 'claude',
    root: FAKE_ROOT,
    nodeDir: FAKE_NODE_DIR,
    teamclaudeConfigPath: FAKE_PORTABLE_CONFIG,
    dryRun: true,
  });
  assert.equal(dry.env.TEAMCLAUDE_CONFIG, FAKE_PORTABLE_CONFIG);
  assert.equal(dry.env.ANTHROPIC_BASE_URL, undefined);
});

test('relayImport: both the claude import and the detached login spawn carry TEAMCLAUDE_CONFIG', async () => {
  let importEnv = null;
  await relayImport({
    provider: 'claude',
    root: FAKE_ROOT,
    nodeDir: FAKE_NODE_DIR,
    teamclaudeConfigPath: FAKE_PORTABLE_CONFIG,
    runFn: async (_exe, _args, opts) => { importEnv = opts.env; return { code: 0, out: '', err: '' }; },
  });
  assert.equal(importEnv.TEAMCLAUDE_CONFIG, FAKE_PORTABLE_CONFIG);

  let spawnEnv = null;
  await relayImport({
    provider: 'claude',
    root: FAKE_ROOT,
    nodeDir: FAKE_NODE_DIR,
    teamclaudeConfigPath: FAKE_PORTABLE_CONFIG,
    runFn: async () => ({ code: 1, out: '', err: 'import failed' }), // force the fallback
    spawnFn: (_exe, _args, opts) => { spawnEnv = opts.env; return { unref() {}, pid: 1 }; },
  });
  assert.equal(spawnEnv.TEAMCLAUDE_CONFIG, FAKE_PORTABLE_CONFIG);
});

test('ensureProxy: the manage-script spawn carries TEAMCLAUDE_CONFIG', async () => {
  let manageOpts = null;
  let probeCount = 0;
  await ensureProxy({
    root: FAKE_ROOT,
    nodeDir: FAKE_NODE_DIR,
    teamclaudeConfigPath: FAKE_PORTABLE_CONFIG,
    probe: async () => { probeCount += 1; return probeCount > 1; },
    runManage: async (_ps1, _args, opts) => { manageOpts = opts; return { code: 0, out: '', err: '' }; },
  });
  assert.equal(manageOpts.env.TEAMCLAUDE_CONFIG, FAKE_PORTABLE_CONFIG);
});
