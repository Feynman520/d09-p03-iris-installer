// tests/uninstall.test.mjs -- the IRIS uninstaller (installer/uninstall.ps1 + IRIS-삭제.cmd),
// run for real against throwaway installs under %TEMP% (2.0.39, docs/설계-삭제기.md).
//
// Nothing here may touch this PC's own settings. Every run passes:
//   -ScanRoots  a temp parent  (never every fixed drive -- a real rehearsal install such as
//               C:\IRIS-upg would otherwise be found and, without -Root, removed)
//   -EnvSubKey / -RunSubKey  HKCU\Software\IRIS-uninstall-test-<pid>-<time>\... instead of
//               HKCU\Environment and ...\CurrentVersion\Run
//   -DesktopDir / -WorkDir / -LogFile / -Json  temp paths
// Processes the tests start are tracked by PID and only those are ever killed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PS1 = path.join(REPO, 'installer', 'uninstall.ps1');
const CMD = path.join(REPO, 'installer', 'IRIS-삭제.cmd');
const skip = process.platform !== 'win32' ? 'Windows only' : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-uninst-'));
const SUB = `Software\\IRIS-uninstall-test-${process.pid}-${Date.now()}`;
const started = new Set();

// HKCU helper: set values with an exact kind, dump them back raw, drop the test key. It
// refuses any key outside Software\IRIS-uninstall-test-*.
const REG_PS1 = path.join(tmp, 'reg.ps1');
fs.writeFileSync(REG_PS1, [
  'param([string]$Op, [string]$Sub, [string]$File)',
  "$ErrorActionPreference = 'Stop'",
  "if ($Sub -notlike 'Software\\IRIS-uninstall-test-*') { throw ('refusing key ' + $Sub) }",
  '$hk = [Microsoft.Win32.Registry]::CurrentUser',
  "if ($Op -eq 'set') {",
  '  $spec = [IO.File]::ReadAllText($File, [Text.Encoding]::UTF8) | ConvertFrom-Json',
  '  $k = $hk.CreateSubKey($Sub)',
  '  foreach ($v in @($spec)) { if ($v) { $k.SetValue($v.name, [string]$v.value, [Microsoft.Win32.RegistryValueKind]$v.kind) } }',
  '  $k.Close()',
  "} elseif ($Op -eq 'dump') {",
  '  $out = @{}',
  '  $k = $hk.OpenSubKey($Sub, $false)',
  "  if ($k) { foreach ($n in $k.GetValueNames()) { $out[$n] = @{ value = [string]$k.GetValue($n, $null, 'DoNotExpandEnvironmentNames'); kind = [string]$k.GetValueKind($n) } }; $k.Close() }",
  '  [IO.File]::WriteAllText($File, (ConvertTo-Json $out -Depth 4), (New-Object Text.UTF8Encoding($false)))',
  "} elseif ($Op -eq 'drop') {",
  '  $hk.DeleteSubKeyTree($Sub, $false)',
  "} elseif ($Op -eq 'lnk') {",
  '  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($File)',
  '  $s.TargetPath = [IO.File]::ReadAllText($File + \'.target\', [Text.Encoding]::UTF8)',
  '  if ([IO.File]::Exists($File + \'.args\')) { $s.Arguments = [IO.File]::ReadAllText($File + \'.args\', [Text.Encoding]::UTF8) }',
  '  $s.Save()',
  '}',
  '',
].join('\r\n'));

function ps(args) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REG_PS1, ...args], { windowsHide: true });
}

function regSet(sub, values) {
  const f = path.join(tmp, `spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(values));
  ps(['set', sub, f]);
}

function regDump(sub) {
  const f = path.join(tmp, `dump-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  ps(['dump', sub, f]);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function makeLnk(lnkPath, target, args = null) {
  fs.mkdirSync(path.dirname(lnkPath), { recursive: true });
  fs.writeFileSync(`${lnkPath}.target`, target);
  if (args !== null) fs.writeFileSync(`${lnkPath}.args`, args);
  ps(['lnk', `${SUB}\\lnk`, lnkPath]);
  fs.rmSync(`${lnkPath}.target`);
  fs.rmSync(`${lnkPath}.args`, { force: true });
}

after(() => {
  for (const pid of started) { try { process.kill(pid); } catch { /* already gone */ } }
  try { ps(['drop', SUB, '']); } catch { /* nothing to drop */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root, rel, text) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

// One throwaway scene per test: its own parent folder (scan root), registry keys, desktop and
// installer work folder.
let sceneNo = 0;
function scene(name) {
  sceneNo++;
  const base = path.join(tmp, `s${sceneNo}-${name}`);
  const sc = {
    base,
    parent: path.join(base, 'drive'),
    desk: path.join(base, 'desk'),
    work: path.join(base, 'IRIS-Installer'),
    outside: path.join(base, 'outside'),
    json: path.join(base, 'result.json'),
    log: path.join(base, 'run.log'),
    envSub: `${SUB}\\${sceneNo}\\Environment`,
    runSub: `${SUB}\\${sceneNo}\\Run`,
  };
  for (const d of [sc.parent, sc.desk, sc.work, sc.outside]) fs.mkdirSync(d, { recursive: true });
  write(sc.work, 'state.json', '{}');
  write(sc.outside, 'sentinel.txt', 'must survive');
  regSet(sc.envSub, []);
  regSet(sc.runSub, []);
  return sc;
}

// A small but complete install: system items the package lays down, user work (with Korean
// names), an empty _trash (system) and a non-empty _backup (user's).
function makeInstall(sc, name = 'IRIS', { version = '2.0.38', previous = {}, receiptText } = {}) {
  const root = path.join(sc.parent, name);
  write(root, '_agent/setup/package-receipt.json', receiptText ?? JSON.stringify({
    schema: 2, package: { version }, soul: { root }, env: { previous },
  }));
  write(root, '_agent/claude/settings.json', '{}');
  write(root, '_agent/shims/relay-autostart.vbs', "' relay");
  write(root, '_agent/setup/installer/installer/uninstall.ps1', '# installed copy');
  write(root, '_ontology/graph.json', '{}');
  write(root, 'AGENTS.md', '# my rules');
  write(root, 'soul-state.json', '{}');
  write(root, 'IRIS Face.cmd', '@echo off');
  fs.mkdirSync(path.join(root, '_trash'));
  write(root, '_backup/old.zip', 'x');
  write(root, '내 작업/메모.txt', '안녕');
  write(root, 'R01-교사(Teacher)/AGENTS.md', '# r01');
  write(root, 'notes.txt', 'n');
  return root;
}

// The uninstaller allows one run per PC at a time (the named mutex Local\IRIS-uninstaller).
// Another checkout of this repository running the same tests on the same PC holds that mutex
// for a second or two at a time, and a run that meets it answers "already-running" without
// touching anything (2026-11-28: two worktrees tested side by side and failed each other).
// So a run that only met a busy mutex is simply tried again. `waitForMutex: false` is for the
// one test that holds the mutex on purpose.
function runUninstall(sc, extra, opts = {}) {
  const { waitForMutex = true, ...rest } = opts;
  for (let attempt = 0; ; attempt += 1) {
    const r = runUninstallOnce(sc, extra, rest);
    const busy = r.code === 4 && r.json?.status === 'error' && r.json?.reason === 'already-running';
    if (!busy || !waitForMutex || attempt >= 60) return r;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 + Math.floor(Math.random() * 1000));
  }
}

function runUninstallOnce(sc, extra, { via = 'ps1', cmd = CMD } = {}) {
  fs.rmSync(sc.json, { force: true });
  const common = ['-NoUi', '-ScanRoots', sc.parent, '-EnvSubKey', sc.envSub, '-RunSubKey', sc.runSub,
    '-DesktopDir', sc.desk, '-WorkDir', sc.work, '-Json', sc.json, '-LogFile', sc.log, ...extra];
  let r;
  if (via === 'cmd') {
    const q = (a) => (/[\s"]/.test(a) || a === '' ? `"${a}"` : a);
    const line = [`"${cmd}"`, ...common.map(q)].join(' ');
    r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, encoding: 'utf8', timeout: 180000 });
  } else {
    r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...common],
      { encoding: 'utf8', timeout: 180000, windowsHide: true });
  }
  const json = fs.existsSync(sc.json) ? JSON.parse(fs.readFileSync(sc.json, 'utf8').replace(/^\uFEFF/, '')) : null;
  return { code: r.status, json, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, log: fs.existsSync(sc.log) ? fs.readFileSync(sc.log, 'utf8') : '' };
}

const arr = (v) => (v == null ? [] : [].concat(v));
const why = (r) => `exit ${r.code}\n${JSON.stringify(r.json, null, 1)}\n${r.log}\n${r.out}`;

function listTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name), r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

function junction(link, target) {
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { windowsHide: true, stdio: 'ignore' });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Starts a PowerShell that prints "held" once ready; resolves with the child.
function startHolder(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    started.add(child.pid);
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`holder never got ready: ${buf}`)), 30000);
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('held')) { clearTimeout(timer); resolve(child); }
    });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`holder exited ${c}: ${buf}`)); });
  });
}

async function stopHolder(child) {
  child.removeAllListeners('exit');
  const gone = new Promise((r) => child.once('exit', r));
  try { process.kill(child.pid); } catch { /* already gone */ }
  await gone;
  started.delete(child.pid);
}

const KO = JSON.parse(fs.readFileSync(path.join(REPO, 'installer', 'uninstall-ko.json'), 'utf8').replace(/^\uFEFF/, ''));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The settings an installed IRIS leaves in HKCU (plus a few of the user's own that must stay).
function irisSettings(sc, root) {
  regSet(sc.envSub, [
    { name: 'CLAUDE_CONFIG_DIR', value: `${root}\\_agent\\claude`, kind: 'ExpandString' },
    { name: 'CODEX_HOME', value: `${root}\\_agent\\codex`, kind: 'String' },
    { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:3456', kind: 'String' },
    { name: 'TEAMCLAUDE_CONFIG', value: 'D:\\elsewhere\\tc.json', kind: 'String' },   // changed by the user since
    { name: 'MY_VAR', value: `${root}\\notes.txt`, kind: 'String' },                  // not an IRIS name
    { name: 'Path', value: `%SystemRoot%\\system32;${root}\\_agent\\shims;C:\\Tools`, kind: 'ExpandString' },
  ]);
  regSet(sc.runSub, [
    { name: 'IRIS relay', value: `wscript.exe "${root}\\_agent\\shims\\relay-autostart.vbs"`, kind: 'String' },
    { name: 'MyTool', value: `"${root}\\R01-교사(Teacher)\\tool.exe"`, kind: 'String' },  // the user's own
    { name: 'OneDrive', value: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background', kind: 'String' },
  ]);
  makeLnk(path.join(sc.desk, 'IRIS.lnk'), `${root}\\IRIS Face.cmd`);
  makeLnk(path.join(sc.desk, 'mine.lnk'), path.join(sc.outside, 'sentinel.txt'));
}

test('keep mode: work moves to the archive, IRIS and its settings go, the rest stays', { skip }, () => {
  const sc = scene('keep');
  const root = makeInstall(sc, 'IRIS', { previous: { CLAUDE_CONFIG_DIR: '%USERPROFILE%\\.claude-old' } });
  irisSettings(sc, root);
  junction(path.join(root, '_agent', 'claude', 'plugins-link'), sc.outside);   // inside a system folder

  const r = runUninstall(sc, ['-Root', root]);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'done', why(r));
  assert.equal(r.json.mode, 'keep');
  assert.equal(r.json.version, '2.0.38');
  assert.equal(fs.existsSync(root), false, 'the IRIS folder is gone');

  const arch = path.join(sc.parent, `IRIS-${KO.archiveWord}-${today()}`);
  assert.equal(r.json.archive, arch);
  assert.deepEqual(listTree(arch), [
    'AGENTS.md', 'R01-교사(Teacher)', 'R01-교사(Teacher)/AGENTS.md', '_backup', '_backup/old.zip',
    'notes.txt', '내 작업', '내 작업/메모.txt',
  ].sort());
  assert.equal(fs.readFileSync(path.join(arch, '내 작업', '메모.txt'), 'utf8'), '안녕');
  assert.equal(fs.readFileSync(path.join(arch, 'AGENTS.md'), 'utf8'), '# my rules', 'a copy of the root rules');
  assert.deepEqual(arr(r.json.moveFailed), []);
  assert.deepEqual(arr(r.json.remaining), []);

  // the junction inside _agent was unlinked, not followed
  assert.equal(fs.readFileSync(path.join(sc.outside, 'sentinel.txt'), 'utf8'), 'must survive');

  const env = regDump(sc.envSub);
  assert.deepEqual(env.CLAUDE_CONFIG_DIR, { value: '%USERPROFILE%\\.claude-old', kind: 'ExpandString' }, 'restored, still unexpanded');
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.deepEqual(env.TEAMCLAUDE_CONFIG, { value: 'D:\\elsewhere\\tc.json', kind: 'String' });
  assert.ok(env.MY_VAR, 'a variable IRIS does not own stays');
  assert.deepEqual(env.Path, { value: '%SystemRoot%\\system32;C:\\Tools', kind: 'ExpandString' });
  assert.deepEqual(arr(r.json.env).sort(),
    ['ANTHROPIC_BASE_URL:delete', 'CLAUDE_CONFIG_DIR:restore', 'CODEX_HOME:delete']);

  const run = regDump(sc.runSub);
  assert.deepEqual(Object.keys(run).sort(), ['MyTool', 'OneDrive']);
  assert.deepEqual(arr(r.json.run), ['IRIS relay']);

  assert.deepEqual(fs.readdirSync(sc.desk), ['mine.lnk']);
  assert.equal(fs.existsSync(sc.work), false, 'the installer work folder goes with the last IRIS');
  assert.equal(r.json.workDir, sc.work);
});

test('all mode needs -Yes; with it everything goes, links inside are not followed', { skip }, async () => {
  const sc = scene('all');
  const root = makeInstall(sc);
  irisSettings(sc, root);
  junction(path.join(root, 'my-link'), sc.outside);   // a user item that is a link
  const before = listTree(sc.parent);

  const refused = runUninstall(sc, ['-Root', root, '-Mode', 'all']);
  assert.equal(refused.code, 2, why(refused));
  assert.equal(refused.json.status, 'confirm-required');
  assert.deepEqual(listTree(sc.parent), before, 'nothing changed');
  assert.ok(regDump(sc.envSub).CODEX_HOME, 'settings untouched');

  // a script host whose command line names the root is stopped (by PID)
  const holder = await startHolder(`$x = '${root}\\_agent\\claude'; 'held'; Start-Sleep 600`);
  const exited = new Promise((res) => holder.once('exit', res));
  const r = runUninstall(sc, ['-Root', root, '-Mode', 'all', '-Yes']);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'done');
  assert.equal(r.json.archive, null);
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(fs.readdirSync(sc.parent), [], 'no archive in all mode');
  assert.equal(fs.readFileSync(path.join(sc.outside, 'sentinel.txt'), 'utf8'), 'must survive');
  assert.ok(arr(r.json.killed).some((k) => k.includes(`(pid ${holder.pid})`)), why(r));
  await exited;
  started.delete(holder.pid);
  assert.equal(alive(holder.pid), false);
});

test('dry run reports the plan and changes nothing', { skip }, () => {
  const sc = scene('dry');
  const root = makeInstall(sc);
  irisSettings(sc, root);
  const tree = listTree(sc.base);
  const env = regDump(sc.envSub);
  const run = regDump(sc.runSub);

  const r = runUninstall(sc, ['-Root', root, '-DryRun']);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'dry-run');
  assert.equal(r.json.dryRun, true);
  assert.deepEqual(arr(r.json.moved).sort(), ['R01-교사(Teacher)', '_backup', 'notes.txt', '내 작업'].sort());
  assert.ok(arr(r.json.removed).includes('_ontology'));
  assert.ok(arr(r.json.removed).includes('_trash'), 'an empty _trash is the package\'s');
  assert.deepEqual(arr(r.json.lnks), [path.join(sc.desk, 'IRIS.lnk')]);
  assert.deepEqual(listTree(sc.base).filter((n) => !/^(result\.json|run\.log)$/.test(n)), tree.filter((n) => !/^(result\.json|run\.log)$/.test(n)));
  assert.deepEqual(regDump(sc.envSub), env);
  assert.deepEqual(regDump(sc.runSub), run);
});

// 2.0.60 (IRIS window 2.103): the window keeps Start menu "IRIS.lnk" (taskbar icon) and older
// windows left Electron's icon-less "Electron.lnk"; both point at electron.exe inside the root.
test('Start menu shortcuts into the root go too; other Start menu shortcuts stay', { skip }, () => {
  const sc = scene('startmenu');
  const root = makeInstall(sc);
  const menu = path.join(sc.base, 'menu');
  fs.mkdirSync(menu, { recursive: true });
  const electron = `${root}\\_agent\\shared\\tools\\face\\node_modules\\electron\\dist\\electron.exe`;
  write(path.dirname(electron), 'electron.exe', 'x');
  makeLnk(path.join(menu, 'IRIS.lnk'), electron);
  makeLnk(path.join(menu, 'Electron.lnk'), electron);
  makeLnk(path.join(menu, 'Other.lnk'), path.join(sc.outside, 'sentinel.txt'));

  const dry = runUninstall(sc, ['-Root', root, '-DryRun', '-StartMenuDir', menu]);
  assert.equal(dry.code, 0, why(dry));
  assert.deepEqual(arr(dry.json.lnks).sort(), [path.join(menu, 'Electron.lnk'), path.join(menu, 'IRIS.lnk')].sort());
  assert.deepEqual(fs.readdirSync(menu).sort(), ['Electron.lnk', 'IRIS.lnk', 'Other.lnk']);

  const r = runUninstall(sc, ['-Root', root, '-StartMenuDir', menu]);
  assert.equal(r.code, 0, why(r));
  assert.deepEqual(fs.readdirSync(menu), ['Other.lnk']);
});

test('refuses without a receipt, with a broken receipt, on protected places and on a linked root', { skip }, () => {
  const sc = scene('refuse');
  const plain = path.join(sc.parent, 'NotIris');
  write(plain, 'AGENTS.md', 'x');
  write(plain, 'work/a.txt', 'a');
  const broken = makeInstall(sc, 'IRIS', { receiptText: 'not json {' });
  const real = makeInstall({ parent: sc.outside }, 'real-iris');
  const linked = path.join(sc.parent, 'IRIS-link');
  junction(linked, real);
  const tree = listTree(sc.base);

  const cases = [
    [plain, 'noReceipt'],
    [broken, 'noReceipt'],
    [linked, 'reparse'],
    ['C:\\', 'danger'],
    [os.homedir(), 'danger'],
    [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'IRIS-uninstall-test-none'), 'danger'],
    [path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp', 'IRIS'), 'danger'],
  ];
  for (const [root, reason] of cases) {
    const r = runUninstall(sc, ['-Root', root]);
    assert.equal(r.code, 2, `${root}\n${why(r)}`);
    assert.equal(r.json.status, 'refused', root);
    assert.equal(r.json.reason, reason, root);
  }
  // without -Root: a broken receipt is reported, not guessed at
  const r = runUninstall(sc, []);
  assert.equal(r.json.status, 'refused', why(r));
  assert.equal(r.json.reason, 'noReceipt');
  assert.equal(r.json.root, broken);

  const strip = (t) => t.filter((n) => !/^(result\.json|run\.log)$/.test(n));
  assert.deepEqual(strip(listTree(sc.base)), strip(tree), 'not one file changed');
});

test('nothing installed: notfound, exit 2', { skip }, () => {
  const sc = scene('none');
  let r = runUninstall(sc, []);
  assert.equal(r.code, 2, why(r));
  assert.equal(r.json.status, 'notfound');
  r = runUninstall(sc, ['-Root', path.join(sc.parent, 'IRIS')]);
  assert.equal(r.json.status, 'notfound', why(r));
  assert.ok(fs.existsSync(sc.work), 'the work folder is not touched when there is nothing to remove');
});

test('a folder deleted by hand: only the settings that still point at it are cleaned', { skip }, () => {
  const sc = scene('traces');
  const gone = path.join(sc.parent, 'IRIS');   // never created
  regSet(sc.envSub, [
    { name: 'CLAUDE_CONFIG_DIR', value: `${gone}\\_agent\\claude`, kind: 'String' },
    { name: 'ANTHROPIC_BASE_URL', value: 'http://localhost:3456/', kind: 'String' },
    { name: 'Path', value: `C:\\Tools;${gone}\\_agent\\shims`, kind: 'String' },
  ]);
  regSet(sc.runSub, [{ name: 'IRIS relay', value: `wscript.exe "${gone}\\_agent\\shims\\relay-autostart.vbs"`, kind: 'String' }]);
  makeLnk(path.join(sc.desk, 'IRIS.lnk'), `${gone}\\IRIS Face.cmd`);

  const r = runUninstall(sc, []);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'traces-done');
  assert.equal(r.json.kind, 'traces');
  assert.deepEqual(regDump(sc.envSub), { Path: { value: 'C:\\Tools', kind: 'String' } });
  assert.deepEqual(regDump(sc.runSub), {});
  assert.deepEqual(fs.readdirSync(sc.desk), []);
  assert.equal(fs.existsSync(sc.work), false);
  assert.equal(fs.existsSync(gone), false, 'nothing was created');
});

test('another IRIS on the PC keeps the relay, its own settings and the installer work folder', { skip }, () => {
  const sc = scene('two');
  const a = makeInstall(sc, 'IRIS');
  const b = makeInstall(sc, 'IRIS-B');   // "IRIS" must never match "IRIS-B"
  regSet(sc.envSub, [
    { name: 'CLAUDE_CONFIG_DIR', value: `${b}\\_agent\\claude`, kind: 'String' },
    { name: 'CODEX_HOME', value: `${a}\\_agent\\codex`, kind: 'String' },
    { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:3456', kind: 'String' },
    { name: 'Path', value: `${a}\\_agent\\shims;${b}\\_agent\\shims`, kind: 'String' },
  ]);
  const bTree = listTree(b);

  const r = runUninstall(sc, ['-Root', a]);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'done');
  assert.equal(fs.existsSync(a), false);
  assert.deepEqual(listTree(b), bTree, 'the other install is untouched');
  assert.deepEqual(regDump(sc.envSub), {
    CLAUDE_CONFIG_DIR: { value: `${b}\\_agent\\claude`, kind: 'String' },
    ANTHROPIC_BASE_URL: { value: 'http://127.0.0.1:3456', kind: 'String' },
    Path: { value: `${b}\\_agent\\shims`, kind: 'String' },
  });
  assert.ok(fs.existsSync(sc.work), 'the work folder stays while an IRIS remains');
  assert.equal(r.json.workDir, null);
});

test('a locked file: partial (exit 1), nothing of the user deleted, a rerun finishes', { skip }, async () => {
  const sc = scene('locked');
  const root = makeInstall(sc);
  // the holder's command line does not name the root, so step 1 leaves it running
  const holder = await startHolder(
    "$a = [IO.File]::Open($env:HOLD1, 'Open', 'Read', 'None'); $b = [IO.File]::Open($env:HOLD2, 'Open', 'Read', 'None'); 'held'; Start-Sleep 600",
    { HOLD1: path.join(root, 'notes.txt'), HOLD2: path.join(root, '_agent', 'claude', 'settings.json') });
  let r;
  try {
    r = runUninstall(sc, ['-Root', root]);
  } finally {
    await stopHolder(holder);
  }
  assert.equal(r.code, 1, why(r));
  assert.equal(r.json.status, 'partial');
  assert.deepEqual(arr(r.json.moveFailed), ['notes.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'n', 'a user file that could not move stays in place');
  assert.deepEqual(arr(r.json.remaining).sort(), ['_agent\\claude', 'notes.txt']);
  assert.ok(fs.existsSync(path.join(root, '_agent', 'setup', 'package-receipt.json')), 'the receipt stays for the rerun');
  assert.ok(arr(r.json.holders).some((h) => h.includes(`(pid ${holder.pid})`)), `holders named\n${why(r)}`);
  const arch = r.json.archive;
  assert.ok(fs.existsSync(path.join(arch, '내 작업', '메모.txt')));

  const r2 = runUninstall(sc, ['-Root', root]);
  assert.equal(r2.code, 0, why(r2));
  assert.equal(r2.json.status, 'done');
  assert.equal(fs.existsSync(root), false);
  assert.equal(r2.json.archive, arch, 'the rerun uses the same archive folder');
  assert.equal(fs.readFileSync(path.join(arch, 'notes.txt'), 'utf8'), 'n');
  assert.deepEqual(fs.readdirSync(sc.parent), [path.basename(arch)]);
});

// 2026-11-09 (school PC: "deleting with the Codex app open leaves files"): before deleting, programs
// outside IRIS that hold the agents' home files (_agent\codex, _agent\claude) are named up front.
// Headless never waits for a person, so it only records them (preHolders); the UI shows a
// "close these first" screen. A clean folder records none.
test('outside holders of the agent folders are named before deleting (preHolders)', { skip }, async () => {
  const sc = scene('preholders');
  const root = makeInstall(sc);
  write(root, '_agent/codex/state_5.sqlite', 'db');
  const holder = await startHolder(
    "$a = [IO.File]::Open($env:HOLD1, 'Open', 'Read', 'None'); 'held'; Start-Sleep 600",
    { HOLD1: path.join(root, '_agent', 'codex', 'state_5.sqlite') });
  let r;
  try {
    r = runUninstall(sc, ['-Root', root]);
  } finally {
    await stopHolder(holder);
  }
  assert.ok(arr(r.json.preHolders).some((h) => h.includes(`(pid ${holder.pid})`)), `named before deleting\n${why(r)}`);
  assert.equal(r.json.status, 'partial', 'the held file stays (the holder was not stopped by the uninstaller)');
  const r2 = runUninstall(sc, ['-Root', root]);
  assert.equal(r2.code, 0, why(r2));
  assert.deepEqual(arr(r2.json.preHolders), [], 'nothing holds the files any more');
  assert.equal(r2.json.status, 'done');
});

// A second uninstall on the same day (a reinstall, then another uninstall) moves into the archive
// the first one left. A folder keeps its whole name (".agents (2)", "D02.01-... (2)" -- the 2.0.39
// rehearsal on C:\IRIS-upg got " (2).agents"), a file keeps its extension, and root rules that
// changed since are kept beside the first copy; the same rules are not copied twice.
test('an archive already there: new names stay whole, changed root rules are kept too', { skip }, () => {
  const sc = scene('archive-again');
  const root = makeInstall(sc);
  write(root, '.agents/skills/a.md', 'new');
  write(root, 'D02.01-작은 일(Small)/a.txt', 'new');
  write(root, 'AGENTS.md', '# my rules, edited');
  const arch = path.join(sc.parent, `IRIS-${KO.archiveWord}-${today()}`);
  write(arch, '.agents/skills/a.md', 'old');
  write(arch, 'D02.01-작은 일(Small)/a.txt', 'old');
  write(arch, 'notes.txt', 'old');
  write(arch, 'AGENTS.md', '# my rules');

  const r = runUninstall(sc, ['-Root', root]);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.archive, arch, 'the archive already there is reused');
  assert.deepEqual(fs.readdirSync(arch).sort(), [
    '.agents', '.agents (2)', 'AGENTS (2).md', 'AGENTS.md', 'D02.01-작은 일(Small)', 'D02.01-작은 일(Small) (2)',
    'R01-교사(Teacher)', '_backup', 'notes (2).txt', 'notes.txt', '내 작업',
  ].sort(), why(r));
  assert.equal(fs.readFileSync(path.join(arch, '.agents (2)', 'skills', 'a.md'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(arch, 'D02.01-작은 일(Small) (2)', 'a.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(arch, 'notes (2).txt'), 'utf8'), 'n');
  assert.equal(fs.readFileSync(path.join(arch, 'AGENTS.md'), 'utf8'), '# my rules', 'the first copy stays');
  assert.equal(fs.readFileSync(path.join(arch, 'AGENTS (2).md'), 'utf8'), '# my rules, edited');

  const sc2 = scene('archive-same-rules');
  const root2 = makeInstall(sc2);
  const arch2 = path.join(sc2.parent, `IRIS-${KO.archiveWord}-${today()}`);
  write(arch2, 'AGENTS.md', '# my rules');
  const r2 = runUninstall(sc2, ['-Root', root2]);
  assert.equal(r2.code, 0, why(r2));
  assert.equal(fs.readdirSync(arch2).filter((n) => /^AGENTS/.test(n)).join('|'), 'AGENTS.md', 'the same rules are not copied twice');
});

test('a second uninstaller while one runs: error already-running, exit 4', { skip }, async () => {
  const sc = scene('mutex');
  const root = makeInstall(sc);
  const holder = await startHolder("$m = New-Object Threading.Mutex($false, 'Local\\IRIS-uninstaller'); [void]$m.WaitOne(); 'held'; Start-Sleep 600");
  let r;
  try {
    r = runUninstall(sc, ['-Root', root], { waitForMutex: false });
  } finally {
    await stopHolder(holder);
  }
  assert.equal(r.code, 4, why(r));
  assert.equal(r.json.status, 'error');
  assert.equal(r.json.reason, 'already-running');
  assert.ok(fs.existsSync(path.join(root, 'notes.txt')), 'nothing changed');
});

test('-Scan lists what it sees and changes nothing', { skip }, () => {
  const sc = scene('scan');
  const good = makeInstall(sc, 'IRIS');
  const bad = makeInstall(sc, 'IRIS-bad', { receiptText: '{' });
  const tree = listTree(sc.parent);
  const r = runUninstall(sc, ['-Scan']);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'install');
  assert.equal(r.json.root, good);
  const byRoot = Object.fromEntries(arr(r.json.installs).map((i) => [i.root, i]));
  assert.equal(byRoot[good].version, '2.0.38');
  assert.equal(byRoot[bad].bad, true);
  assert.deepEqual(arr(r.json.plan.user).sort(), ['R01-교사(Teacher)', '_backup', 'notes.txt', '내 작업'].sort());
  assert.ok(arr(r.json.plan.system).includes('_agent'));
  assert.deepEqual(listTree(sc.parent), tree);
});

test('IRIS-삭제.cmd from an extracted zip passes arguments through and returns the exit code', { skip }, () => {
  const sc = scene('cmd');
  const zip = path.join(sc.base, 'zip');
  fs.mkdirSync(path.join(zip, 'installer', 'lib'), { recursive: true });
  fs.copyFileSync(CMD, path.join(zip, 'IRIS-삭제.cmd'));
  for (const f of ['uninstall.ps1', 'uninstall-ko.json', 'lib/file-holders.ps1']) {
    fs.copyFileSync(path.join(REPO, 'installer', ...f.split('/')), path.join(zip, 'installer', ...f.split('/')));
  }
  const root = makeInstall(sc);
  irisSettings(sc, root);
  const viaZip = (extra) => runUninstall(sc, extra, { via: 'cmd', cmd: path.join(zip, 'IRIS-삭제.cmd') });

  const refused = viaZip(['-Root', path.join(process.env.SystemRoot || 'C:\\Windows', 'IRIS'), '-Mode', 'all']);
  assert.equal(refused.code, 2, why(refused));
  assert.equal(refused.json.status, 'refused');
  assert.ok(fs.existsSync(root));

  const r = viaZip(['-Root', root]);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'done');
  assert.equal(fs.existsSync(root), false);
  assert.ok(fs.existsSync(path.join(zip, 'installer', 'uninstall.ps1')), 'the zip folder is not touched');
});

// The installed copy lives inside the folder it deletes. cmd re-opens a batch file after each
// block, so without leaving the batch first it printed "path not found" and handed back 1 on a
// clean uninstall (found in the 2.0.39 rehearsal on C:\IRIS-upg).
test('IRIS-삭제.cmd installed inside the root it deletes still returns 0 and prints no error', { skip }, () => {
  const sc = scene('cmd-installed');
  const root = makeInstall(sc);
  const copy = path.join(root, '_agent', 'setup', 'installer', 'installer');
  fs.mkdirSync(path.join(copy, 'lib'), { recursive: true });
  fs.copyFileSync(CMD, path.join(copy, 'IRIS-삭제.cmd'));
  for (const f of ['uninstall.ps1', 'uninstall-ko.json', 'lib/file-holders.ps1']) {
    fs.copyFileSync(path.join(REPO, 'installer', ...f.split('/')), path.join(copy, ...f.split('/')));
  }
  irisSettings(sc, root);
  const tempCopies = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('IRIS-uninstall-')).sort();
  const before = tempCopies();

  const r = runUninstall(sc, ['-Root', root], { via: 'cmd', cmd: path.join(copy, 'IRIS-삭제.cmd') });
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'done');
  assert.equal(fs.existsSync(root), false);
  const stray = r.out.split(/\r?\n/).filter((l) => l.trim() && !/^(IRIS uninstaller - |This black window )/.test(l));
  assert.deepEqual(stray, [], why(r));
  assert.deepEqual(tempCopies(), before, 'the %TEMP% copy is removed');
});

// ---------------------------------------------------------------------------
// 2.0.66 -- IRIS Doctor. What it leaves on a PC:
//   <root>\_agent\shared\tools\iris-doctor\   the program (a part)
//   <root>\_agent\doctor\records\             journal, check-up sheets, treatment records + backups
//   <root>\_agent\doctor\{cards,claude-home,codex-home,work,...}   login keys and scratch
//   "IRIS Doctor.lnk" on the desktop and in the Start menu (target cmd.exe, the start file in the arguments)
//   %LOCALAPPDATA%\IRIS Doctor\               run folders of agent treatment (outside the root)
// Keep mode keeps the RECORDS (moved into the archive) and nothing else: the keys must not stay on disk.
// Every run below redirects the Start menu and the outside folder too (-StartMenuDir / -DoctorWorkDir).
// Nothing here starts Doctor.
// ---------------------------------------------------------------------------

const SYS_CMD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const doctorStart = (root) => `${root}\\_agent\\shared\\tools\\iris-doctor\\IRIS Doctor.cmd`;
const doctorArgs = (root) => `/d /c ""${doctorStart(root)}""`;

// The Doctor part, its home (keys + records) and both shortcuts, as an install leaves them.
function addDoctor(sc, root, { name = 'IRIS', records = true } = {}) {
  write(root, '_agent/shared/tools/iris-doctor/IRIS Doctor.cmd', '@echo off\r\n');
  write(root, '_agent/shared/tools/iris-doctor/iris-doctor.mjs', '// doctor\n');
  write(root, '_agent/doctor/cards/claude.json', '{"token":"KEY-MUST-NOT-STAY"}');
  write(root, '_agent/doctor/codex-home/auth.json', '{"tokens":{"refresh_token":"KEY-MUST-NOT-STAY"}}');
  write(root, '_agent/doctor/claude-home/.claude.json', '{}');
  write(root, '_agent/doctor/work/scratch.txt', 'w');
  write(root, '_agent/doctor/.protected', 'v3');
  if (records) {
    write(root, '_agent/doctor/records/journal.jsonl', '{"kind":"open"}\n');
    write(root, '_agent/doctor/records/checkups/20261127-010203-abcdef.json', '{"findings":[]}');
    write(root, '_agent/doctor/records/20261127-010203-1/backup/설정.json', '{"사본":true}');
  }
  sc.menu = sc.menu ?? path.join(sc.base, 'menu');
  sc.doctorWork = sc.doctorWork ?? path.join(sc.base, 'IRIS Doctor');
  fs.mkdirSync(sc.menu, { recursive: true });
  write(sc.doctorWork, 'work/run-1/note.txt', 'run');
  makeLnk(path.join(sc.desk, `${name} Doctor.lnk`), SYS_CMD, doctorArgs(root));
  makeLnk(path.join(sc.menu, `${name} Doctor.lnk`), SYS_CMD, doctorArgs(root));
}
const doctorOpts = (sc) => ['-StartMenuDir', sc.menu, '-DoctorWorkDir', sc.doctorWork];
// every file under a folder that still carries a key (none may)
const keysLeft = (dir) => listTree(dir).filter((rel) => { const p = path.join(dir, ...rel.split('/')); return fs.statSync(p).isFile() && fs.readFileSync(p, 'utf8').includes('KEY-MUST-NOT-STAY'); });

test('doctor, keep mode: the records move into the archive; keys, the program, both shortcuts and the outside folder go', { skip }, () => {
  const sc = scene('doctor-keep');
  const root = makeInstall(sc);
  irisSettings(sc, root);
  addDoctor(sc, root);
  makeLnk(path.join(sc.menu, 'Other.lnk'), path.join(sc.outside, 'sentinel.txt'));

  const dry = runUninstall(sc, ['-Root', root, '-DryRun', ...doctorOpts(sc)]);
  assert.equal(dry.code, 0, why(dry));
  const arch = path.join(sc.parent, `IRIS-${KO.archiveWord}-${today()}`);
  assert.equal(dry.json.doctorRecords, path.join(arch, KO.doctorRecordsDir), 'the dry run says where the records would go');
  assert.equal(dry.json.doctorWork, sc.doctorWork);
  assert.ok(arr(dry.json.lnks).includes(path.join(sc.desk, 'IRIS Doctor.lnk')) && arr(dry.json.lnks).includes(path.join(sc.menu, 'IRIS Doctor.lnk')));
  assert.ok(fs.existsSync(path.join(root, '_agent', 'doctor', 'records', 'journal.jsonl')), 'a dry run changes nothing');

  const r = runUninstall(sc, ['-Root', root, ...doctorOpts(sc)]);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'done', why(r));
  assert.equal(fs.existsSync(root), false, 'the IRIS folder is gone');
  assert.equal(r.json.archive, arch);
  const kept = path.join(arch, KO.doctorRecordsDir);
  assert.equal(r.json.doctorRecords, kept);
  assert.deepEqual(listTree(kept), [
    '20261127-010203-1', '20261127-010203-1/backup', '20261127-010203-1/backup/설정.json',
    'checkups', 'checkups/20261127-010203-abcdef.json', 'journal.jsonl',
  ].sort());
  assert.equal(fs.readFileSync(path.join(kept, 'journal.jsonl'), 'utf8'), '{"kind":"open"}\n');
  // the user's own work is there as before, and no key travelled into the archive
  assert.ok(fs.existsSync(path.join(arch, '내 작업', '메모.txt')));
  assert.deepEqual(keysLeft(arch), [], 'no login key may be kept');
  assert.deepEqual(fs.readdirSync(arch).filter((n) => /^(cards|claude-home|codex-home|work|doctor)$/i.test(n)), []);
  // shortcuts: both Doctor ones and IRIS.lnk gone, the unrelated ones stay
  assert.deepEqual(fs.readdirSync(sc.desk).sort(), ['mine.lnk']);
  assert.deepEqual(fs.readdirSync(sc.menu).sort(), ['Other.lnk']);
  // the outside run folder goes (no other IRIS remains), and so does the installer work folder as before
  assert.equal(fs.existsSync(sc.doctorWork), false);
  assert.equal(r.json.doctorWork, sc.doctorWork);
  assert.equal(fs.existsSync(sc.work), false);
  assert.equal(fs.readFileSync(path.join(sc.outside, 'sentinel.txt'), 'utf8'), 'must survive');
});

test('doctor, keep mode with no user work at all: the archive is made for the records alone; with no records there is no archive', { skip }, () => {
  const sc = scene('doctor-only');
  const root = makeInstall(sc);
  for (const n of ['내 작업', 'R01-교사(Teacher)', '_backup', 'notes.txt']) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  addDoctor(sc, root);
  const r = runUninstall(sc, ['-Root', root, ...doctorOpts(sc)]);
  assert.equal(r.code, 0, why(r));
  const arch = path.join(sc.parent, `IRIS-${KO.archiveWord}-${today()}`);
  assert.equal(r.json.archive, arch, why(r));
  assert.deepEqual(fs.readdirSync(arch), [KO.doctorRecordsDir], 'only the records folder');
  assert.deepEqual(arr(r.json.moved), []);
  assert.deepEqual(fs.readdirSync(sc.parent), [path.basename(arch)]);

  const sc2 = scene('doctor-norecords');
  const root2 = makeInstall(sc2);
  for (const n of ['내 작업', 'R01-교사(Teacher)', '_backup', 'notes.txt']) fs.rmSync(path.join(root2, n), { recursive: true, force: true });
  addDoctor(sc2, root2, { records: false });
  fs.mkdirSync(path.join(root2, '_agent', 'doctor', 'records'), { recursive: true });   // an empty records folder is nothing to keep
  const r2 = runUninstall(sc2, ['-Root', root2, ...doctorOpts(sc2)]);
  assert.equal(r2.code, 0, why(r2));
  assert.equal(r2.json.archive, null);
  assert.equal(r2.json.doctorRecords, null);
  assert.deepEqual(fs.readdirSync(sc2.parent), [], 'nothing is left beside the removed root');
});

test('doctor, all mode: records and keys go with everything else, nothing is archived', { skip }, () => {
  const sc = scene('doctor-all');
  const root = makeInstall(sc);
  addDoctor(sc, root);
  const r = runUninstall(sc, ['-Root', root, '-Mode', 'all', '-Yes', ...doctorOpts(sc)]);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'done');
  assert.equal(fs.existsSync(root), false);
  assert.equal(r.json.archive, null);
  assert.equal(r.json.doctorRecords, null);
  assert.deepEqual(fs.readdirSync(sc.parent), [], 'no archive folder in all mode');
  assert.deepEqual(fs.readdirSync(sc.desk), []);
  assert.deepEqual(fs.readdirSync(sc.menu), []);
  assert.equal(fs.existsSync(sc.doctorWork), false);
});

test('doctor, another IRIS remains: its Doctor shortcuts and the shared outside folder stay', { skip }, () => {
  const sc = scene('doctor-two');
  const a = makeInstall(sc, 'IRIS');
  const b = makeInstall(sc, 'IRIS-B');
  addDoctor(sc, a, { name: 'IRIS' });
  addDoctor(sc, b, { name: 'IRIS-B' });
  const bTree = listTree(b);

  const r = runUninstall(sc, ['-Root', a, ...doctorOpts(sc)]);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'done');
  assert.equal(fs.existsSync(a), false);
  assert.deepEqual(listTree(b), bTree, 'the other install, its Doctor and its records are untouched');
  assert.deepEqual(fs.readdirSync(sc.desk).sort(), ['IRIS-B Doctor.lnk'], 'only the shortcut of the removed install went');
  assert.deepEqual(fs.readdirSync(sc.menu).sort(), ['IRIS-B Doctor.lnk']);
  assert.ok(fs.existsSync(path.join(sc.doctorWork, 'work', 'run-1', 'note.txt')), 'the outside folder stays while an IRIS remains');
  assert.equal(r.json.doctorWork, null);
  assert.ok(fs.existsSync(sc.work), 'and the installer work folder stays, as before');

  // the last one takes the outside folder with it
  const r2 = runUninstall(sc, ['-Root', b, ...doctorOpts(sc)]);
  assert.equal(r2.code, 0, why(r2));
  assert.equal(fs.existsSync(sc.doctorWork), false);
  assert.deepEqual(fs.readdirSync(sc.desk), []);
});

test('doctor shortcuts: only cmd.exe + exactly this install\'s start file in the arguments is removed (never by name, never by a partial match)', { skip }, () => {
  const sc = scene('doctor-lnk');
  const root = makeInstall(sc, 'IRIS 연습 (한글 & 공백)');
  addDoctor(sc, root, { name: 'IRIS' });
  const twin = `${root}-old`;                         // a folder whose path starts with the root's
  const start = doctorStart(root);
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const stays = {
    // same name as ours, but it opens something else
    'IRIS Doctor (남의 것).lnk': [SYS_CMD, `/d /c ""${path.join(sc.outside, 'tool.cmd')}""`],
    // another install's Doctor (a sibling folder with a longer name)
    'twin.lnk': [SYS_CMD, `/d /c ""${doctorStart(twin)}""`],
    // the right file named somewhere inside a longer command: not the shape the installer writes
    'longer.lnk': [SYS_CMD, `/d /c ""${start}"" & echo done`],
    'k-switch.lnk': [SYS_CMD, `/k ""${start}""`],
    'substring.lnk': [SYS_CMD, `/d /c ""${sc.outside}\\run.cmd"" "${start}"`],
    'other-file.lnk': [SYS_CMD, `/d /c ""${root}\\_agent\\shared\\tools\\iris-doctor\\other.cmd""`],
    'no-args.lnk': [SYS_CMD, ''],
    // right arguments, but the target is not cmd.exe
    'not-cmd.lnk': [ps, doctorArgs(root)],
  };
  for (const [name, [target, args]] of Object.entries(stays)) makeLnk(path.join(sc.desk, name), target, args);
  // goes: the exact one in another letter case and with a different name (the name is not the test)
  makeLnk(path.join(sc.desk, 'renamed by the user.lnk'), SYS_CMD.toUpperCase(), doctorArgs(root).replace('iris-doctor', 'IRIS-DOCTOR'));

  const dry = runUninstall(sc, ['-Root', root, '-DryRun', ...doctorOpts(sc)]);
  assert.equal(dry.code, 0, why(dry));
  assert.deepEqual(arr(dry.json.lnks).map((l) => path.basename(l)).sort(), ['IRIS Doctor.lnk', 'IRIS Doctor.lnk', 'renamed by the user.lnk'].sort(), why(dry));

  const r = runUninstall(sc, ['-Root', root, ...doctorOpts(sc)]);
  assert.equal(r.code, 0, why(r));
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(fs.readdirSync(sc.desk).sort(), Object.keys(stays).sort(), 'every look-alike stays');
  assert.deepEqual(fs.readdirSync(sc.menu), []);
});

test('doctor is treating (a live treat.lock): refused -- nothing is deleted, moved or stopped; a stale lock does not block', { skip }, async () => {
  const sc = scene('doctor-busy');
  const root = makeInstall(sc);
  irisSettings(sc, root);
  addDoctor(sc, root);
  const lock = path.join(root, '_agent', 'doctor', 'treat.lock');
  const lockBody = (pid, at) => JSON.stringify({ id: `${pid}-${at}-abcdef012345`, pid, at });
  // "Doctor": a program running from the root (its command line names the root), which step 1 would stop
  const doctor = await startHolder("$null = $env:IRIS_T_ROOT; 'held'; Start-Sleep 600 # " + root.replace(/'/g, "''"));
  const before = { tree: listTree(root), desk: fs.readdirSync(sc.desk).sort(), menu: fs.readdirSync(sc.menu).sort(), env: regDump(sc.envSub), run: regDump(sc.runSub) };
  try {
    fs.writeFileSync(lock, lockBody(doctor.pid, Date.now()));
    before.tree = listTree(root);
    for (const extra of [[], ['-DryRun'], ['-Mode', 'all', '-Yes']]) {
      const r = runUninstall(sc, ['-Root', root, ...extra, ...doctorOpts(sc)]);
      assert.equal(r.code, 2, why(r));
      assert.equal(r.json.status, 'refused', why(r));
      assert.equal(r.json.reason, 'doctorTreating');
      assert.deepEqual(listTree(root), before.tree, 'not one file changed');
      assert.deepEqual(fs.readdirSync(sc.desk).sort(), before.desk);
      assert.deepEqual(fs.readdirSync(sc.menu).sort(), before.menu);
      assert.deepEqual(regDump(sc.envSub), before.env);
      assert.deepEqual(regDump(sc.runSub), before.run);
      assert.ok(fs.existsSync(sc.doctorWork) && fs.existsSync(sc.work));
      assert.equal(fs.readdirSync(sc.parent).length, 1, 'no archive folder was made');
      assert.equal(alive(doctor.pid), true, 'Doctor was not stopped');
    }
    // -Scan says so too
    const scan = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Scan', '-Root', root, '-ScanRoots', sc.parent,
      '-EnvSubKey', sc.envSub, '-RunSubKey', sc.runSub, '-DesktopDir', sc.desk, '-WorkDir', sc.work, '-LogFile', sc.log, ...doctorOpts(sc)], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(JSON.parse(scan.stdout).plan.doctorTreating, true, scan.stdout + scan.stderr);

    // an unreadable lock that was written just now is still someone's lock
    fs.writeFileSync(lock, '{ half written');
    let r = runUninstall(sc, ['-Root', root, '-DryRun', ...doctorOpts(sc)]);
    assert.equal(r.json.status, 'refused', why(r));

    // not live any more: the heartbeat is older than 20 minutes / an unreadable lock left for over a minute
    fs.writeFileSync(lock, lockBody(doctor.pid, Date.now() - 21 * 60_000));
    r = runUninstall(sc, ['-Root', root, '-DryRun', ...doctorOpts(sc)]);
    assert.equal(r.json.status, 'dry-run', why(r));
    // a heartbeat from the FUTURE (clock set back, damaged file) must not refuse forever while some
    // process has that PID (2026-11-28 code review): beyond the same 20 minutes it is stale ...
    for (const ahead of [21 * 60_000, 365 * 86400_000]) {
      fs.writeFileSync(lock, lockBody(doctor.pid, Date.now() + ahead));
      r = runUninstall(sc, ['-Root', root, '-DryRun', ...doctorOpts(sc)]);
      assert.equal(r.json.status, 'dry-run', `heartbeat ${ahead} ms ahead: ${why(r)}`);
    }
    // ... while a clock that stepped back a little still protects a running treatment
    fs.writeFileSync(lock, lockBody(doctor.pid, Date.now() + 2 * 60_000));
    r = runUninstall(sc, ['-Root', root, '-DryRun', ...doctorOpts(sc)]);
    assert.equal(r.json.status, 'refused', why(r));
    // and a heartbeat that is not a number at all is not live
    fs.writeFileSync(lock, JSON.stringify({ id: 'x', pid: doctor.pid, at: 'soon' }));
    r = runUninstall(sc, ['-Root', root, '-DryRun', ...doctorOpts(sc)]);
    assert.equal(r.json.status, 'dry-run', why(r));
    fs.writeFileSync(lock, '{ half written');
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lock, old, old);
    r = runUninstall(sc, ['-Root', root, '-DryRun', ...doctorOpts(sc)]);
    assert.equal(r.json.status, 'dry-run', why(r));
    // an unreadable lock whose WRITE TIME is in the future (clock set back, damaged time stamp) must not
    // count as "just written" for as long as it stays ahead of the clock (2026-11-28 second code review)
    for (const ahead of [5 * 60_000, 365 * 86400_000]) {
      const future = new Date(Date.now() + ahead);
      fs.utimesSync(lock, future, future);
      r = runUninstall(sc, ['-Root', root, '-DryRun', ...doctorOpts(sc)]);
      assert.equal(r.json.status, 'dry-run', `unreadable lock written ${ahead} ms ahead: ${why(r)}`);
    }
  } finally {
    await stopHolder(doctor);
  }
  // the owner is gone (a crashed treatment): the lock no longer blocks, and the uninstall runs to the end
  fs.writeFileSync(lock, lockBody(doctor.pid, Date.now()));
  const r = runUninstall(sc, ['-Root', root, ...doctorOpts(sc)]);
  assert.equal(r.code, 0, why(r));
  assert.equal(r.json.status, 'done');
  assert.equal(fs.existsSync(root), false);
});

test('doctor records that cannot be moved are never deleted: records and _agent\\doctor stay (keys still go), a rerun finishes', { skip }, async () => {
  const sc = scene('doctor-locked');
  const root = makeInstall(sc);
  addDoctor(sc, root);
  const journal = path.join(root, '_agent', 'doctor', 'records', 'journal.jsonl');
  // the holder's command line does not name the root, so step 1 leaves it running
  const holder = await startHolder("$a = [IO.File]::Open($env:HOLD1, 'Open', 'Read', 'None'); 'held'; Start-Sleep 600", { HOLD1: journal });
  let r;
  try {
    r = runUninstall(sc, ['-Root', root, ...doctorOpts(sc)]);
  } finally {
    await stopHolder(holder);
  }
  assert.equal(r.code, 1, why(r));
  assert.equal(r.json.status, 'partial', why(r));
  assert.ok(arr(r.json.moveFailed).includes('_agent\\doctor\\records'), why(r));
  assert.equal(fs.readFileSync(journal, 'utf8'), '{"kind":"open"}\n', 'the records are still in place, whole');
  assert.ok(fs.existsSync(path.join(root, '_agent', 'doctor', 'records', 'checkups', '20261127-010203-abcdef.json')));
  assert.ok(fs.existsSync(path.join(root, '_agent', 'doctor', 'records', '20261127-010203-1', 'backup', '설정.json')));
  assert.deepEqual(fs.readdirSync(path.join(root, '_agent', 'doctor')), ['records'], 'everything else in the Doctor home (the keys) went');
  assert.deepEqual(keysLeft(root), [], 'no key is left under the root');
  assert.ok(arr(r.json.remaining).includes('_agent\\doctor'), why(r));
  assert.ok(fs.existsSync(path.join(root, '_agent', 'setup', 'package-receipt.json')), 'the receipt stays for the rerun');
  assert.equal(r.json.doctorRecords, null);
  assert.ok(fs.existsSync(sc.doctorWork), 'the outside folder is not removed while something is left');
  const arch = r.json.archive;
  assert.ok(fs.existsSync(path.join(arch, '내 작업', '메모.txt')), 'the user work that could move did move');
  assert.equal(fs.existsSync(path.join(arch, KO.doctorRecordsDir)), false);

  const r2 = runUninstall(sc, ['-Root', root, ...doctorOpts(sc)]);
  assert.equal(r2.code, 0, why(r2));
  assert.equal(r2.json.status, 'done');
  assert.equal(fs.existsSync(root), false);
  assert.equal(r2.json.archive, arch, 'the rerun uses the same archive folder');
  assert.equal(fs.readFileSync(path.join(arch, KO.doctorRecordsDir, 'journal.jsonl'), 'utf8'), '{"kind":"open"}\n');
  assert.equal(fs.existsSync(sc.doctorWork), false);
});

test('doctor: without -DoctorWorkDir a redirected run never looks at the real %LOCALAPPDATA%\\IRIS Doctor, and -Scan lists the Doctor plan', { skip }, () => {
  const sc = scene('doctor-scan');
  const root = makeInstall(sc);
  addDoctor(sc, root);
  // no -DoctorWorkDir and no -StartMenuDir: the common test arguments already redirect the desktop and the work folder
  const dry = runUninstall(sc, ['-Root', root, '-DryRun']);
  assert.equal(dry.code, 0, why(dry));
  assert.equal(dry.json.doctorWork, null, 'the real outside folder is out of reach of a redirected run');
  assert.deepEqual(arr(dry.json.lnks).map((l) => path.basename(l)).sort(), ['IRIS Doctor.lnk'], 'only the desktop one: the real Start menu is not looked at');

  const scan = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Scan', '-Root', root, '-ScanRoots', sc.parent,
    '-EnvSubKey', sc.envSub, '-RunSubKey', sc.runSub, '-DesktopDir', sc.desk, '-WorkDir', sc.work, '-LogFile', sc.log, ...doctorOpts(sc)], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(scan.status, 0, scan.stdout + scan.stderr);
  const plan = JSON.parse(scan.stdout).plan;
  assert.equal(plan.doctorRecords, path.join(root, '_agent', 'doctor', 'records'));
  assert.equal(plan.doctorWork, sc.doctorWork);
  assert.equal(plan.doctorTreating, false);
  assert.ok(fs.existsSync(path.join(root, '_agent', 'doctor', 'cards', 'claude.json')), '-Scan changes nothing');
});

test('uninstall strings: every key the script asks for is in uninstall-ko.json (a missing one would show the key name on screen)', () => {
  const code = fs.readFileSync(PS1, 'latin1').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  const keys = new Set([...code.matchAll(/[\s=(]T '([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  for (let n = 1; n <= 8; n++) keys.add(`step${n}`);
  const missing = [...keys].filter((k) => !(k in KO));
  assert.deepEqual(missing, []);
  for (const k of ['doctorRecordsDir', 'doctorBusyHeading', 'doctorBusyBody']) assert.ok(typeof KO[k] === 'string' && KO[k].length > 0, k);
  assert.ok(!/[\\/:*?"<>|]/.test(KO.doctorRecordsDir), 'the records folder name must be a plain folder name');
  // the script stays ASCII with CRLF line endings
  const buf = fs.readFileSync(PS1);
  assert.equal(buf.findIndex((b) => b > 0x7f), -1, 'uninstall.ps1 must stay ASCII');
  assert.ok(!/(^|[^\r])\n/.test(buf.toString('latin1')), 'uninstall.ps1 must keep CRLF');
});
