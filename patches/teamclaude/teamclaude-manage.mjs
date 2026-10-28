// TeamClaude relay manager for macOS -- the node twin of teamclaude-manage.ps1
// (macOS design doc in docs/, D-M14). Same actions, same output lines, same
// safety rule: it only ever stops the ONE process that provably owns port 3456
// AND runs this exact node with the TeamClaude entry file. Never a name, never
// a port sweep, never more than one PID.
//
// Usage (both spellings are accepted so callers written for the .ps1 keep working):
//   node teamclaude-manage.mjs <status|start|restart|stop> --node <node> --entry <index.js>
//   node teamclaude-manage.mjs -Action start -NodePath <node> -EntryPath <index.js>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function parseManageArgs(argv) {
  const a = { action: 'status', nodePath: null, entryPath: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '-Action' || k === '--action') a.action = argv[++i];
    else if (k === '-NodePath' || k === '--node') a.nodePath = argv[++i];
    else if (k === '-EntryPath' || k === '--entry') a.entryPath = argv[++i];
    else if (!k.startsWith('-')) a.action = k;
  }
  if (!['status', 'start', 'restart', 'stop'].includes(a.action)) throw new Error(`unknown action: ${a.action}`);
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `lsof -Fp` output -> distinct listener PIDs. */
export function parseLsofPids(text) {
  return [...new Set(String(text ?? '').split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))).filter((n) => n > 0))];
}

/** The listener is ours only if its command line is `<nodePath> <...entryPath...>`. */
export function isOwnedCommand(args, { nodePath, entryPath }) {
  if (!args || !nodePath || !entryPath) return false;
  return args.startsWith(`${nodePath} `) && args.includes(entryPath);
}

function defaultProbe(port) {
  let out = '';
  try {
    out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' });
  } catch (e) {
    // lsof exits 1 when nothing matches -- that is "no listener", not an error.
    if (e.status === 1 && !String(e.stderr ?? '').trim()) return [];
    throw e;
  }
  return parseLsofPids(out);
}

function defaultArgsOf(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function manage({
  action, nodePath = process.execPath, entryPath, env = process.env, home = os.homedir(),
  probe = defaultProbe, argsOf = defaultArgsOf, fetchFn = fetch, log = console.log,
}) {
  const configPath = env.TEAMCLAUDE_CONFIG || path.join(home, '.config', 'teamclaude.json');
  // The .ps1 keeps its runtime record and logs in ~/.config. Here they live next
  // to the config the relay runs with: for an IRIS install that is the soul's
  // own portable-state folder, so nothing lands in the person's home folder
  // (and a rehearsal stays inside its practice root).
  const stateDir = env.TEAMCLAUDE_CONFIG ? path.dirname(configPath) : path.join(home, '.config');
  const runtimePath = path.join(stateDir, 'teamclaude.server.json');
  fs.mkdirSync(stateDir, { recursive: true });
  if (!entryPath) throw new Error('The TeamClaude entry file is required (--entry).');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const port = Number(config?.proxy?.port);
  if (port !== 3456) throw new Error('This helper manages only the TeamClaude proxy on port 3456.');

  const ownedListener = () => {
    const pids = probe(port);
    if (pids.length === 0) return null;
    if (pids.length !== 1) throw new Error('More than one listener owner; refusing to stop anything.');
    if (!isOwnedCommand(argsOf(pids[0]), { nodePath, entryPath })) {
      throw new Error('Port 3456 is not owned by the expected TeamClaude program; refusing to stop it.');
    }
    return pids[0];
  };

  const owned = ownedListener();
  if (action === 'status') {
    if (!owned) { log('TeamClaude is stopped.'); return 0; }
    const res = await fetchFn(`http://127.0.0.1:${port}/teamclaude/status`, { signal: AbortSignal.timeout(10000) });
    const state = await res.json();
    const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
    log(JSON.stringify({ Pid: owned, Port: port, AccountCount: accounts.length, Accounts: accounts.map((x) => ({ name: x.name, status: x.status })) }, null, 2));
    return 0;
  }
  if (action === 'start' && owned) {
    log(`TeamClaude is already running (PID ${owned}, port ${port}).`);
    return 0;
  }
  if (owned && (action === 'stop' || action === 'restart')) {
    // Restart is an explicit request to stop this exact, verified listener.
    process.kill(owned, 'SIGTERM');
    for (let i = 0; i < 40 && alive(owned); i++) await sleep(250);
  }
  if (action === 'stop') {
    fs.writeFileSync(runtimePath, JSON.stringify({ pid: null, port, stoppedAt: new Date().toISOString(), managedBy: 'teamclaude-manage.mjs' }, null, 2));
    log('TeamClaude stopped.');
    return 0;
  }
  if (ownedListener()) throw new Error('The old listener is still running.');

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const logBase = path.join(stateDir, `teamclaude-runtime-${stamp}`);
  const out = fs.openSync(`${logBase}.stdout.log`, 'a');
  const err = fs.openSync(`${logBase}.stderr.log`, 'a');
  // detached = its own session: closing the terminal (or the shim that called
  // us exiting) must not take the relay down with it.
  const child = spawn(nodePath, [entryPath, 'server', '--headless'], {
    cwd: path.dirname(configPath), env: { ...env, TEAMCLAUDE_CONFIG: configPath }, detached: true, stdio: ['ignore', out, err],
  });
  child.unref();
  fs.writeFileSync(runtimePath, JSON.stringify({
    pid: child.pid, port, startedAt: new Date().toISOString(), managedBy: 'teamclaude-manage.mjs',
    stdout: `${logBase}.stdout.log`, stderr: `${logBase}.stderr.log`,
  }, null, 2));

  // Same budget as the .ps1 (~120 s): a cold first start can be slow.
  for (let attempt = 0; attempt < 480; attempt++) {
    await sleep(250);
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/teamclaude/status`, { signal: AbortSignal.timeout(2000) });
      const state = await res.json();
      if (ownedListener() !== child.pid) throw new Error('Readiness response did not come from the process just started.');
      log(`TeamClaude started (PID ${child.pid}, port ${port}, ${(state?.accounts ?? []).length} accounts).`);
      return 0;
    } catch {
      if (!alive(child.pid)) break;
    }
  }
  let tail = '';
  try { tail = fs.readFileSync(`${logBase}.stderr.log`, 'utf8').trim().split('\n').slice(-5).join(' | '); } catch { /* none */ }
  const note = alive(child.pid) ? 'process still running' : 'process exited';
  throw new Error(`TeamClaude did not become ready (${note}). Check ${logBase}.stderr.log${tail ? ` -- ${tail}` : ''}`);
}

// Main-module check on real paths: a symlinked launch path (macOS $TMPDIR is /var -> /private/var,
// /tmp -> /private/tmp) would otherwise never match import.meta.url and main() would silently not run.
function isEntryFile(argv1, metaUrl) {
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}
const isMain = process.argv[1] && isEntryFile(process.argv[1], import.meta.url);
if (isMain) {
  let args;
  try { args = parseManageArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  manage(args).then((code) => process.exit(code), (e) => { console.error(e?.message ?? String(e)); process.exit(1); });
}
