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

function makeLnk(lnkPath, target) {
  fs.writeFileSync(`${lnkPath}.target`, target);
  ps(['lnk', `${SUB}\\lnk`, lnkPath]);
  fs.rmSync(`${lnkPath}.target`);
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

function runUninstall(sc, extra, { via = 'ps1', cmd = CMD } = {}) {
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
    r = runUninstall(sc, ['-Root', root]);
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
