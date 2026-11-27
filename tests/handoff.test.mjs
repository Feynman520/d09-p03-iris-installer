import { test, after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  resolveGuide, firstRequestText, writeFirstRequest, firstRequestPath,
  faceLauncherContent, writeFaceLauncher,
  writeFirstSessionSpec, defaultSpecFor, launchFace, waitFaceReady,
  finish, faceDirFor, relaunchFace, nodeExeFor,
  writeDoctorShortcut, doctorStartFile, doctorShortcutName, doctorShortcutArguments,
} from '../installer/lib/handoff.mjs';
import { newReceipt, writeReceipt, readReceipt } from '../installer/lib/receipt.mjs';
import { startServer } from '../installer/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-handoff-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// A manifest shaped like the real payload one: guides fan out into
// `guides:<basename>` keys (build/collect.mjs), and the package-wide
// guideVersion -- not a per-part version -- is the guides' identity.
const GUIDE_CLAUDE = '비서 에이전트 세팅가이드(Claude 실행판)_v9_2026-09-07_최신.md';
const GUIDE_CODEX = '비서 에이전트 세팅가이드(Codex 실행판)_v9_2026-09-07_최신.md';
const MANIFEST = {
  schema: 1,
  package: { name: 'IRIS', version: '1.0.0', guideVersion: '9', license: 'MIT' },
  parts: {
    node: { version: '24.17.0', sha256: 'x' },
    [`guides:${GUIDE_CLAUDE}`]: { sha256: 'a' },
    [`guides:${GUIDE_CODEX}`]: { sha256: 'b' },
  },
};

function freshRoot(label) {
  const root = path.join(tmp, label);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// writeFirstRequest -- docs/설계.md 4-2
// ---------------------------------------------------------------------------

test('resolveGuide picks the edition\'s guide out of the manifest (never a hard-coded filename)', () => {
  const claude = resolveGuide(MANIFEST, 'claude');
  assert.equal(claude.basename, GUIDE_CLAUDE);
  assert.equal(claude.version, '9');

  // The choice step's vocabulary is claude|chatgpt; the guide edition file is
  // named "Codex 실행판".
  assert.equal(resolveGuide(MANIFEST, 'chatgpt').basename, GUIDE_CODEX);
  assert.equal(resolveGuide(MANIFEST, 'codex').basename, GUIDE_CODEX);

  assert.equal(resolveGuide({ parts: {} }, 'claude'), null);
});

// Fix round 1, finding 4: handing a Codex-led soul the Claude guide would point
// the agent at instructions for a CLI it does not have. Missing edition = stop.
test('resolveGuide does NOT fall back to the other edition; writeFirstRequest fails with guide-missing:<edition>', () => {
  const claudeOnly = {
    package: { guideVersion: '9' },
    parts: { [`guides:${GUIDE_CLAUDE}`]: { sha256: 'a' } },
  };
  assert.equal(resolveGuide(claudeOnly, 'chatgpt'), null);
  assert.equal(resolveGuide(claudeOnly, 'claude').basename, GUIDE_CLAUDE);

  const root = freshRoot('guide-missing');
  assert.throws(
    () => writeFirstRequest(root, { edition: 'chatgpt', manifest: claudeOnly }),
    (err) => err.code === 'guide-missing:chatgpt',
  );
  // ...and nothing was written on the failing path.
  assert.equal(fs.existsSync(firstRequestPath(root)), false);
});

test('writeFirstRequest: three sentences, real absolute paths, manifest-resolved guide filename + guideVersion', () => {
  const root = freshRoot('first-request');
  const result = writeFirstRequest(root, { edition: 'claude', manifest: MANIFEST });

  assert.equal(result.path, path.join(root, '_agent', 'setup', 'first-request.txt'));
  assert.equal(result.path, firstRequestPath(root));
  const text = fs.readFileSync(result.path, 'utf8');

  // ① 계약서(세팅가이드) 위치 -- the real root, the manifest's real filename,
  // and the manifest's guideVersion inside that filename. Never "_v10.md".
  const guidePath = path.join(root, '_setup-guides', GUIDE_CLAUDE);
  assert.ok(text.includes(guidePath), `guide path missing: ${text}`);
  assert.ok(GUIDE_CLAUDE.includes(`_v${MANIFEST.package.guideVersion}_`));
  assert.ok(!/_v10\.md/.test(text));

  // ② 인수인계 노트(영수증) 위치
  assert.ok(text.includes(path.join(root, '_agent', 'setup', 'package-receipt.json')));

  // ③ 일반 문장으로 물어보라 (Face 노란 카드 방지)
  assert.ok(text.includes('일반 문장'));

  // Exactly three sentences.
  const sentences = text.trim().split(/(?<=\.)\s+/).filter(Boolean);
  assert.equal(sentences.length, 3, `expected 3 sentences, got ${sentences.length}: ${text}`);

  // Absolute paths only -- no relative "_setup-guides\..." form.
  assert.ok(!/(^|\s)_setup-guides/.test(text));

  // Codex edition writes the Codex guide.
  const root2 = freshRoot('first-request-codex');
  const r2 = writeFirstRequest(root2, { edition: 'chatgpt', manifest: MANIFEST });
  assert.ok(fs.readFileSync(r2.path, 'utf8').includes(GUIDE_CODEX));
});

test('writeFirstRequest throws a coded error when the manifest carries no guide', () => {
  const root = freshRoot('first-request-noguide');
  assert.throws(
    () => writeFirstRequest(root, { edition: 'claude', manifest: { parts: {} } }),
    (err) => err.code === 'no-guide-in-manifest',
  );
});

test('firstRequestText is a single line (the prompt is typed into a terminal)', () => {
  const text = firstRequestText({ root: 'C:\\NOVA', guideBasename: GUIDE_CLAUDE });
  assert.equal(text.split('\n').length, 1);
});

// ---------------------------------------------------------------------------
// writeFaceLauncher
// ---------------------------------------------------------------------------

test('faceLauncherContent: ASCII-only, CRLF, chcp 65001, %~dp0-relative, no absolute soul path', () => {
  const content = faceLauncherContent();

  assert.ok(/^[\x20-\x7e\r\n\t]*$/.test(content), 'launcher content must be ASCII-only');
  // Every LF is part of a CRLF pair and there is no bare CR.
  assert.equal(content.replace(/\r\n/g, ''), content.replace(/[\r\n]/g, ''));
  assert.ok(content.startsWith('@echo off\r\n'));
  assert.ok(content.includes('chcp 65001 >nul'));
  assert.ok(content.includes('setlocal'));
  // Face v2.49+: no console window. The bundled node is handed to
  // launch-hidden.vbs through IRIS_FACE_NODE (a fresh PC has no `node` on
  // PATH), and --console / a missing .vbs fall back to the visible window.
  assert.ok(content.includes('set "IRIS_FACE_NODE=%~dp0_agent\\shared\\tools\\node\\node.exe"'));
  assert.ok(content.includes('wscript.exe //nologo "%~dp0_agent\\shared\\tools\\face\\launch-hidden.vbs" %*'));
  assert.ok(content.includes('if "%~1"=="--console" goto console'));
  assert.ok(content.includes('if not exist "%~dp0_agent\\shared\\tools\\face\\launch-hidden.vbs" goto console'));
  assert.ok(content.includes('"%IRIS_FACE_NODE%" "%~dp0_agent\\shared\\tools\\face\\launch.mjs" %*'));
  assert.ok(!content.includes('node.exe" "%~dp0'), 'the default path must not spawn node directly (console window)');
  assert.ok(content.includes('%*'), 'must forward its own arguments');

  // No hard-coded soul path and no IRIS_FACE_HWP_PY line (this PC's
  // IRIS-Face.cmd has both; the installed launcher must have neither).
  assert.ok(!/[A-Za-z]:\\/.test(content), 'no absolute path may appear');
  assert.ok(!content.includes('IRIS_FACE_HWP_PY'));
});

test('writeFaceLauncher writes "<name> Face.cmd" at the soul root and a desktop .lnk via WScript.Shell', async () => {
  const root = freshRoot('launcher');
  const desktopDir = path.join(tmp, 'fake-desktop');
  fs.mkdirSync(desktopDir, { recursive: true });

  const calls = [];
  const runPs = async (script) => { calls.push(script); return { code: 0, out: '', err: '' }; };

  const res = await writeFaceLauncher(root, 'NOVA', { desktopDir, runPs });

  assert.equal(res.cmdPath, path.join(root, 'NOVA Face.cmd'));
  assert.equal(fs.readFileSync(res.cmdPath, 'utf8'), faceLauncherContent());
  // Desktop shortcut is just "<name>.lnk" -- "IRIS" on a real install.
  assert.equal(res.lnkPath, path.join(desktopDir, 'NOVA.lnk'));
  assert.ok(!calls[0].includes('Face.lnk'), 'the shortcut name must not carry the internal "Face" word');
  assert.equal(res.shortcut.ok, true);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('WScript.Shell'));
  assert.ok(calls[0].includes('CreateShortcut'));
  assert.ok(calls[0].includes(res.cmdPath));
  assert.ok(calls[0].includes(desktopDir), 'the shortcut must land in the injected desktop dir');
});

test('writeFaceLauncher: a failing shortcut is reported, not fatal (the .cmd still exists)', async () => {
  const root = freshRoot('launcher-fail');
  const desktopDir = path.join(tmp, 'fake-desktop-2');
  fs.mkdirSync(desktopDir, { recursive: true });
  const runPs = async () => ({ code: 1, out: '', err: 'access denied' });

  const res = await writeFaceLauncher(root, 'NOVA', { desktopDir, runPs });
  assert.ok(fs.existsSync(res.cmdPath));
  assert.equal(res.shortcut.ok, false);
  assert.ok(String(res.shortcut.detail).includes('access denied'));
});

// ---------------------------------------------------------------------------
// writeDoctorShortcut -- 2.0.66: the door to IRIS Doctor that works when IRIS itself does not
// ---------------------------------------------------------------------------

// A soul root that has the Doctor part placed (only the start file matters here).
function rootWithDoctor(label, { icon = false } = {}) {
  const root = freshRoot(label);
  const start = doctorStartFile(root);
  fs.mkdirSync(path.dirname(start), { recursive: true });
  fs.writeFileSync(start, '@echo off\r\n');
  if (icon) {
    const ico = path.join(faceDirFor(root), 'app', 'iris.ico');
    fs.mkdirSync(path.dirname(ico), { recursive: true });
    fs.writeFileSync(ico, 'ico');
  }
  return root;
}

test('doctor shortcut: the name follows the soul name ("IRIS Doctor" on a real install) and the start file sits beside the bundled node', () => {
  assert.equal(doctorShortcutName('IRIS'), 'IRIS Doctor.lnk');
  assert.equal(doctorShortcutName('NOVA'), 'NOVA Doctor.lnk');
  const root = path.join(tmp, 'x', 'IRIS');
  assert.equal(doctorStartFile(root), path.join(root, '_agent', 'shared', 'tools', 'iris-doctor', 'IRIS Doctor.cmd'));
  assert.equal(path.dirname(path.dirname(doctorStartFile(root))), path.dirname(path.dirname(nodeExeFor(root))), 'Doctor starts ..\\node\\node.exe');
  // the argument shape the Doctor start file is tested with: /d (no cmd AutoRun) /c and the path in doubled quotes
  assert.equal(doctorShortcutArguments('D:\\a b\\IRIS Doctor.cmd'), '/d /c ""D:\\a b\\IRIS Doctor.cmd""');
});

test('writeDoctorShortcut: desktop + Start menu shortcuts that open cmd.exe /d /c ""<start file>"" from outside the install folder', async () => {
  const root = rootWithDoctor('doctor-lnk (한글 & 공백)', { icon: true });
  const desktopDir = path.join(tmp, 'doctor-desktop');
  const startMenuDir = path.join(tmp, 'doctor-programs');
  const calls = [];
  const runPs = async (script) => { calls.push(script); return { code: 0, out: `OK|desktop|${path.join(desktopDir, 'NOVA Doctor.lnk')}\r\nOK|startmenu|${path.join(startMenuDir, 'NOVA Doctor.lnk')}\r\n`, err: '' }; };

  const res = await writeDoctorShortcut(root, 'NOVA', { desktopDir, startMenuDir, runPs });
  assert.equal(res.present, true);
  assert.equal(res.startFile, doctorStartFile(root));
  assert.deepEqual(res.shortcuts, [
    { where: 'desktop', ok: true, status: 'created', path: path.join(desktopDir, 'NOVA Doctor.lnk'), detail: null },
    { where: 'startmenu', ok: true, status: 'created', path: path.join(startMenuDir, 'NOVA Doctor.lnk'), detail: null },
  ]);
  assert.equal(res.ok, true);

  assert.equal(calls.length, 1, 'one PowerShell run makes both');
  const ps = calls[0];
  assert.ok(ps.includes('WScript.Shell') && ps.includes('CreateShortcut'));
  // target = the real cmd.exe under %SystemRoot%\System32 (asked from Windows, not typed as a drive path)
  assert.match(ps, /\$cmd = Join-Path \$env:SystemRoot 'System32\\cmd\.exe'/);
  assert.match(ps, /\$sc\.TargetPath = \$cmd/);
  assert.ok(!ps.includes(`$sc.TargetPath = '${res.startFile}'`), 'the shortcut must not point at the .cmd itself');
  // arguments = exactly the shape the Doctor start file expects
  assert.ok(ps.includes(`$wantArgs = '${doctorShortcutArguments(res.startFile)}'`), ps);
  assert.match(ps, /\$sc\.Arguments = \$wantArgs/);
  // an existing shortcut of that name is looked at first and never saved over (2026-11-28 code review)
  assert.ok(ps.indexOf('if (Test-Path -LiteralPath $lnk)') > 0 && ps.indexOf('if (Test-Path -LiteralPath $lnk)') < ps.indexOf('$sc.Save()'));
  assert.equal((ps.match(/\$sc\.Save\(\)/g) ?? []).length, 2, 'one Save per place, only in the "nothing there yet" branch');
  // working folder = the user profile, never the install folder (an open Doctor must not pin the root as its current directory)
  assert.match(ps, /\$sc\.WorkingDirectory = \[Environment\]::GetFolderPath\('UserProfile'\)/);
  assert.ok(!ps.includes(`WorkingDirectory = '${root}`), 'the working folder must be outside the install folder');
  assert.match(ps, /\$sc\.WindowStyle = 1\b/, 'a normal window: the user reads this terminal');
  assert.match(ps, /\$sc\.Description = 'IRIS Doctor'/);
  assert.ok(ps.includes(path.join(faceDirFor(root), 'app', 'iris.ico')), 'the IRIS icon when the window part ships one');
  assert.ok(ps.includes(`'${desktopDir}'`) && ps.includes(`'${startMenuDir}'`), 'both injected folders are used');
  assert.ok(ps.includes("'NOVA Doctor.lnk'"));
  // each place is tried on its own: one failing must not stop the other
  assert.equal((ps.match(/try \{/g) ?? []).length >= 2, true);
});

test('writeDoctorShortcut: without injected folders it asks Windows where the desktop and the Start menu Programs folder are', async () => {
  const root = rootWithDoctor('doctor-lnk-ask');
  const calls = [];
  const runPs = async (script) => { calls.push(script); return { code: 0, out: 'OK|desktop|X:\\d\\IRIS Doctor.lnk\nOK|startmenu|X:\\p\\IRIS Doctor.lnk\n', err: '' }; };
  const res = await writeDoctorShortcut(root, 'IRIS', { runPs });
  assert.match(calls[0], /\[Environment\]::GetFolderPath\('Desktop'\)/);
  assert.match(calls[0], /\[Environment\]::GetFolderPath\('Programs'\)/);
  assert.ok(!/IconLocation/.test(calls[0]), 'no icon line when the window part has no icon file');
  assert.deepEqual(res.shortcuts.map((s) => [s.where, s.ok, s.path]), [['desktop', true, 'X:\\d\\IRIS Doctor.lnk'], ['startmenu', true, 'X:\\p\\IRIS Doctor.lnk']]);
});

test('writeDoctorShortcut: no Doctor start file -> nothing is made (and PowerShell is not even started)', async () => {
  const root = freshRoot('doctor-absent');
  let ran = 0;
  const res = await writeDoctorShortcut(root, 'IRIS', { desktopDir: path.join(tmp, 'd0'), startMenuDir: path.join(tmp, 'p0'), runPs: async () => { ran += 1; return { code: 0, out: '', err: '' }; } });
  assert.equal(res.present, false); assert.equal(res.ok, false); assert.deepEqual(res.shortcuts, []);
  assert.equal(ran, 0);
});

test('writeDoctorShortcut: a failure is reported per place and never thrown (one may succeed while the other fails)', async () => {
  const root = rootWithDoctor('doctor-lnk-fail');
  const d = path.join(tmp, 'd1'); const p = path.join(tmp, 'p1');
  // one place fails
  let res = await writeDoctorShortcut(root, 'IRIS', { desktopDir: d, startMenuDir: p, runPs: async () => ({ code: 0, out: `OK|desktop|${path.join(d, 'IRIS Doctor.lnk')}\nFAIL|startmenu|access denied\n`, err: '' }) });
  assert.equal(res.ok, false);
  assert.deepEqual(res.shortcuts.map((s) => [s.where, s.ok]), [['desktop', true], ['startmenu', false]]);
  assert.match(res.shortcuts[1].detail, /access denied/);
  // PowerShell itself fails / throws / says nothing
  res = await writeDoctorShortcut(root, 'IRIS', { desktopDir: d, startMenuDir: p, runPs: async () => ({ code: 1, out: '', err: 'blocked by policy' }) });
  assert.deepEqual(res.shortcuts.map((s) => s.ok), [false, false]); assert.match(res.shortcuts[0].detail, /blocked by policy/);
  res = await writeDoctorShortcut(root, 'IRIS', { desktopDir: d, startMenuDir: p, runPs: async () => { throw new Error('spawn failed'); } });
  assert.deepEqual(res.shortcuts.map((s) => s.ok), [false, false]); assert.match(res.shortcuts[0].detail, /spawn failed/);
  res = await writeDoctorShortcut(root, 'IRIS', { desktopDir: d, startMenuDir: p, runPs: async () => ({ code: 0, out: '', err: '' }) });
  assert.deepEqual(res.shortcuts.map((s) => s.ok), [false, false]);
});

test('writeDoctorShortcut: a real run makes two shortcuts whose target and arguments read back exactly (temp folders only)', async () => {
  const root = rootWithDoctor('doctor real (공백 & 한글)');
  const desktopDir = path.join(tmp, 'real-desktop'); const startMenuDir = path.join(tmp, 'real-programs');
  fs.mkdirSync(desktopDir, { recursive: true }); fs.mkdirSync(startMenuDir, { recursive: true });
  const res = await writeDoctorShortcut(root, 'NOVA', { desktopDir, startMenuDir });
  assert.equal(res.ok, true, JSON.stringify(res.shortcuts));
  const sys = process.env.SystemRoot || 'C:\\Windows';
  for (const s of res.shortcuts) {
    assert.ok(fs.existsSync(s.path), s.path);
    assert.equal(path.basename(s.path), 'NOVA Doctor.lnk');
    assert.ok([desktopDir, startMenuDir].includes(path.dirname(s.path)));
    // read the shortcut back with the same COM object Windows uses
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:IRIS_T_LNK); [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output ($s.TargetPath + "`n" + $s.Arguments + "`n" + $s.WorkingDirectory + "`n" + $s.WindowStyle)'], { encoding: 'utf8', env: { ...process.env, IRIS_T_LNK: s.path }, windowsHide: true, timeout: 30_000 });
    const [target, args, cwd, style] = String(r.stdout).split(/\r?\n/);
    assert.equal(target.toLowerCase(), path.join(sys, 'System32', 'cmd.exe').toLowerCase());
    assert.equal(args, doctorShortcutArguments(doctorStartFile(root)));
    assert.ok(cwd && !cwd.toLowerCase().startsWith(root.toLowerCase()), `working folder must be outside the root: ${cwd}`);
    assert.equal(style, '1');
  }
});

// 2026-11-28 code review (must fix): making the shortcut used to open whatever "IRIS Doctor.lnk"
// was already there, rewrite its properties and save -- a user's own shortcut of that name, or one
// that opens another install's Doctor, was silently repointed. The three tests below are permanent.
// They use real PowerShell and real .lnk files, in temp folders only.
const SYS_CMD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
async function psRun(command, env = {}) {
  const { spawnSync } = await import('node:child_process');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 });
}
// a .lnk made the way a person (or another installer) would: target + arguments of their choosing
async function makeLnk(lnk, target, args = '') {
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  const r = await psRun('$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:IRIS_T_LNK); $s.TargetPath = $env:IRIS_T_TARGET; $s.Arguments = $env:IRIS_T_ARGS; $s.Save()', { IRIS_T_LNK: lnk, IRIS_T_TARGET: target, IRIS_T_ARGS: args });
  assert.equal(r.status, 0, r.stderr);
  // an old file: a rewrite would show in its time stamp
  const old = new Date(Date.now() - 3 * 86400_000);
  fs.utimesSync(lnk, old, old);
  return { bytes: fs.readFileSync(lnk), mtimeMs: fs.statSync(lnk).mtimeMs };
}
async function readLnk(lnk) {
  const r = await psRun('$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:IRIS_T_LNK); [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output ($s.TargetPath + "`n" + $s.Arguments)', { IRIS_T_LNK: lnk });
  const [target, args] = String(r.stdout).split(/\r?\n/);
  return { target, args };
}
const sameFile = (lnk, was) => fs.readFileSync(lnk).equals(was.bytes) && fs.statSync(lnk).mtimeMs === was.mtimeMs;

test('writeDoctorShortcut: a user\'s own shortcut of the same name is left exactly as it is (bytes and time) and reported, not overwritten', async () => {
  const root = rootWithDoctor('doctor keep-user (공백)');
  const desktopDir = path.join(tmp, 'own-desktop'); const startMenuDir = path.join(tmp, 'own-programs');
  const other = path.join(tmp, 'own-target', 'my tool.cmd');
  fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, '@echo off\r\n');
  // the desktop one opens the user's own tool through cmd.exe; the Start menu one opens a file directly
  const d = await makeLnk(path.join(desktopDir, 'NOVA Doctor.lnk'), SYS_CMD, `/d /c ""${other}""`);
  const p = await makeLnk(path.join(startMenuDir, 'NOVA Doctor.lnk'), other);

  const res = await writeDoctorShortcut(root, 'NOVA', { desktopDir, startMenuDir });
  assert.equal(res.ok, false);
  assert.deepEqual(res.shortcuts.map((s) => [s.where, s.ok, s.status, s.path]), [['desktop', false, 'foreign', null], ['startmenu', false, 'foreign', null]]);
  assert.ok(sameFile(path.join(desktopDir, 'NOVA Doctor.lnk'), d), 'the desktop shortcut was not touched');
  assert.ok(sameFile(path.join(startMenuDir, 'NOVA Doctor.lnk'), p), 'the Start menu shortcut was not touched');
  assert.equal((await readLnk(path.join(desktopDir, 'NOVA Doctor.lnk'))).args, `/d /c ""${other}""`, 'it still opens the user\'s tool');
  for (const s of res.shortcuts) assert.ok(!/[\\/]/.test(s.detail), 'the reason carries no path');
  assert.deepEqual(fs.readdirSync(desktopDir), ['NOVA Doctor.lnk']);
});

test('writeDoctorShortcut: a shortcut that opens ANOTHER install\'s Doctor is left as it is; the place that had none still gets ours', async () => {
  const root = rootWithDoctor('doctor mine');
  const otherRoot = rootWithDoctor('doctor mine-old');          // a sibling install whose path starts with ours
  const desktopDir = path.join(tmp, 'two-desktop'); const startMenuDir = path.join(tmp, 'two-programs');
  const theirs = await makeLnk(path.join(desktopDir, 'NOVA Doctor.lnk'), SYS_CMD, doctorShortcutArguments(doctorStartFile(otherRoot)));

  const res = await writeDoctorShortcut(root, 'NOVA', { desktopDir, startMenuDir });
  assert.equal(res.ok, false);
  assert.deepEqual(res.shortcuts.map((s) => [s.where, s.status]), [['desktop', 'foreign'], ['startmenu', 'created']]);
  assert.ok(sameFile(path.join(desktopDir, 'NOVA Doctor.lnk'), theirs), 'the other install\'s shortcut was not touched');
  assert.equal((await readLnk(path.join(desktopDir, 'NOVA Doctor.lnk'))).args, doctorShortcutArguments(doctorStartFile(otherRoot)));
  assert.equal((await readLnk(path.join(startMenuDir, 'NOVA Doctor.lnk'))).args, doctorShortcutArguments(doctorStartFile(root)), 'ours was made where there was none');
  // look-alikes are foreign too: the right file inside a longer command, /k, a target that is not cmd.exe
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  for (const [target, args] of [[SYS_CMD, `/d /c ""${doctorStartFile(root)}"" & echo x`], [SYS_CMD, `/k ""${doctorStartFile(root)}""`], [ps, doctorShortcutArguments(doctorStartFile(root))], [SYS_CMD, '']]) {
    const dir = fs.mkdtempSync(path.join(tmp, 'look-'));
    const was = await makeLnk(path.join(dir, 'NOVA Doctor.lnk'), target, args);
    const r = await writeDoctorShortcut(root, 'NOVA', { desktopDir: dir, startMenuDir: path.join(dir, 'programs') });
    assert.equal(r.shortcuts[0].status, 'foreign', `${path.basename(target)} ${args}`);
    assert.ok(sameFile(path.join(dir, 'NOVA Doctor.lnk'), was), `${path.basename(target)} ${args}`);
  }
});

test('writeDoctorShortcut: when our shortcut is already there nothing is written -- a repeated run leaves bytes and time stamps unchanged', async () => {
  const root = rootWithDoctor('doctor again (한글 & 공백)', { icon: true });
  const desktopDir = path.join(tmp, 'again-desktop'); const startMenuDir = path.join(tmp, 'again-programs');
  const first = await writeDoctorShortcut(root, 'NOVA', { desktopDir, startMenuDir });
  assert.deepEqual(first.shortcuts.map((s) => s.status), ['created', 'created']);
  const files = [path.join(desktopDir, 'NOVA Doctor.lnk'), path.join(startMenuDir, 'NOVA Doctor.lnk')];
  // make them old so that even a byte-identical re-save would show
  const old = new Date(Date.now() - 2 * 86400_000);
  const was = files.map((f) => { fs.utimesSync(f, old, old); return { bytes: fs.readFileSync(f), mtimeMs: fs.statSync(f).mtimeMs }; });
  for (let i = 0; i < 2; i++) {
    const again = await writeDoctorShortcut(root, 'NOVA', { desktopDir, startMenuDir });
    assert.equal(again.ok, true);
    assert.deepEqual(again.shortcuts.map((s) => [s.where, s.status, s.path]), [['desktop', 'kept', files[0]], ['startmenu', 'kept', files[1]]]);
    files.forEach((f, n) => assert.ok(sameFile(f, was[n]), `${f}: rewritten on run ${i + 2}`));
  }
  // ours in another letter case (the user renamed nothing, Windows just reports paths differently) is still ours
  const upper = path.join(tmp, 'again-upper');
  await makeLnk(path.join(upper, 'NOVA Doctor.lnk'), SYS_CMD.toUpperCase(), doctorShortcutArguments(doctorStartFile(root).toUpperCase()));
  const r = await writeDoctorShortcut(root, 'NOVA', { desktopDir: upper, startMenuDir });
  assert.equal(r.shortcuts[0].status, 'kept');
});

test('writeDoctorShortcut: KEPT and FOREIGN answers are told apart (fake PowerShell)', async () => {
  const root = rootWithDoctor('doctor words');
  const res = await writeDoctorShortcut(root, 'IRIS', { desktopDir: 'X:\\d', startMenuDir: 'X:\\p', runPs: async () => ({ code: 0, out: 'KEPT|desktop|X:\\d\\IRIS Doctor.lnk\nFOREIGN|startmenu|X:\\p\\IRIS Doctor.lnk\n', err: '' }) });
  assert.deepEqual(res.shortcuts.map((s) => [s.where, s.ok, s.status, s.path]), [['desktop', true, 'kept', 'X:\\d\\IRIS Doctor.lnk'], ['startmenu', false, 'foreign', null]]);
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------------------
// spec / launchFace / waitFaceReady / finish
// ---------------------------------------------------------------------------

test('writeFirstSessionSpec: Face-shaped spec (cwd/agent/model/effort/promptFile), chatgpt -> codex', () => {
  const root = freshRoot('spec');
  const promptFile = path.join(root, '_agent', 'setup', 'first-request.txt');

  const claude = writeFirstSessionSpec(root, { leadAgent: 'claude', promptFile });
  assert.equal(claude.path, path.join(root, '_agent', 'setup', 'first-session.json'));
  const spec = JSON.parse(fs.readFileSync(claude.path, 'utf8'));
  // 2026-09-14: the setting-up session states maximum permissions explicitly.
  assert.deepEqual(spec, { cwd: root, agent: 'claude', model: 'opus', effort: 'high', permission: 'bypassPermissions', promptFile });

  const codex = writeFirstSessionSpec(root, { leadAgent: 'chatgpt', promptFile });
  const codexSpec = JSON.parse(fs.readFileSync(codex.path, 'utf8'));
  assert.equal(codexSpec.agent, 'codex');
  assert.equal(codexSpec.approval, 'never');
  assert.equal(codexSpec.sandbox, 'danger-full-access');
  assert.equal(codexSpec.permission, undefined, 'Claude-only field stays off a Codex spec');
  assert.equal(defaultSpecFor('chatgpt').model, 'gpt-6-sol');

  // Overrides (used by the rehearsal to pick a cheap model).
  const cheap = writeFirstSessionSpec(root, { leadAgent: 'claude', promptFile, model: 'haiku', effort: 'low' });
  const cheapSpec = JSON.parse(fs.readFileSync(cheap.path, 'utf8'));
  assert.equal(cheapSpec.model, 'haiku');
  assert.equal(cheapSpec.effort, 'low');
});

test('launchFace spawns the bundled node on <tools>\\face\\launch.mjs --first-session, detached', () => {
  const root = freshRoot('launch');
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  const specPath = path.join(root, '_agent', 'setup', 'first-session.json');

  const seen = [];
  const spawnFn = (exe, args, opts) => {
    seen.push({ exe, args, opts });
    return { pid: 4242, unref() {} };
  };

  const res = launchFace({ root, spec: specPath, spawnFn, port: 3458 });
  assert.equal(res.pid, 4242);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].exe, path.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe'));
  assert.deepEqual(seen[0].args, [
    path.join(faceDirFor(root), 'launch.mjs'),
    '--first-session', specPath,
    '--port', '3458',
  ]);
  assert.equal(seen[0].opts.detached, true);

  // faceDir/extraArgs/nodeExe are injectable (the rehearsal points at the P01
  // source tree on a spare port with --no-open).
  const seen2 = [];
  launchFace({
    root,
    spec: specPath,
    faceDir: 'X:\\face-src',
    nodeExe: 'X:\\node\\node.exe',
    port: 3466,
    extraArgs: ['--no-open'],
    env: { IRIS_FACE_PORT: '3466' },
    spawnFn: (exe, args, opts) => { seen2.push({ exe, args, opts }); return { pid: 7, unref() {} }; },
  });
  assert.equal(seen2[0].exe, 'X:\\node\\node.exe');
  assert.equal(seen2[0].args[0], path.join('X:\\face-src', 'launch.mjs'));
  assert.ok(seen2[0].args.includes('--no-open'));
  assert.equal(seen2[0].opts.env.IRIS_FACE_PORT, '3466');
});

// 2026-09-23, three fresh PCs: 「IRIS 열기」 -> "IRIS-Face could not start
// node.exe" with `"node" "...\launch.mjs"`. The installer server runs on the
// bundled node by absolute path and its PATH is the one from the moment of the
// double-click (no node on a fresh PC; the User PATH written mid-install never
// reaches a running process). launch-hidden.vbs falls back to bare "node"
// unless IRIS_FACE_NODE is set -- which the desktop .cmd does and the wscript
// branch here did not.
test('relaunchFace (wscript): hands the bundled node to launch-hidden.vbs via IRIS_FACE_NODE even when PATH has no node', () => {
  const root = path.join(tmp, 'relaunch-soul');
  const faceDir = path.join(root, '_agent', 'shared', 'tools', 'face');
  fs.mkdirSync(faceDir, { recursive: true });
  fs.writeFileSync(path.join(faceDir, 'launch-hidden.vbs'), "' stub\r\n");
  const stale = { PATH: 'C:\\Windows\\System32;C:\\Windows', SystemRoot: 'C:\\Windows' };

  const seen = [];
  const spawnFn = (exe, args, opts) => { seen.push({ exe, args, opts }); return { pid: 11, unref() {} }; };
  const r = relaunchFace({ root, spawnFn, env: stale });
  assert.equal(r.ok, true);
  assert.equal(r.how, 'wscript');
  assert.equal(seen[0].exe, 'wscript.exe');
  assert.equal(seen[0].opts.env.IRIS_FACE_NODE, nodeExeFor(root), 'default = the soul\'s bundled node');

  // An injected node (server --node-dir / rehearsal) wins over the default.
  seen.length = 0;
  relaunchFace({ root, spawnFn, env: stale, nodeExe: 'X:\\node\\node.exe' });
  assert.equal(seen[0].opts.env.IRIS_FACE_NODE, 'X:\\node\\node.exe');
});

// Fix round 1, finding 1: /api/health's `sessions` is the daemon's GLOBAL
// count. On a PC that already runs Face, a stranger's session satisfies
// ">= 1" while this soul got none -- so readiness is decided by /api/sessions
// and a cwd match against the soul root.
function faceFetch({ health, sessions }) {
  return async (url) => {
    if (url.endsWith('/api/health')) {
      const h = typeof health === 'function' ? health() : health;
      if (h === null) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => h };
    }
    const s = typeof sessions === 'function' ? sessions() : sessions;
    return { ok: true, json: async () => s };
  };
}

test('waitFaceReady: 200 + a session whose cwd IS the soul root -> ready', async () => {
  let call = 0;
  const fetchFn = faceFetch({
    health: () => (++call === 1 ? null : { ok: true, sessions: 2, version: '2.45.0' }),
    // First look: only a foreign session. Then ours appears -- note the
    // forward slashes, trailing slash and different case: normCwd must see
    // through all three, exactly like P01 launch.mjs does.
    sessions: (() => { let n = 0; return () => (++n <= 1 ? [{ id: 's1', cwd: 'C:\\OTHER-SOUL' }] : [{ id: 's1', cwd: 'C:\\OTHER-SOUL' }, { id: 's2', cwd: 'c:/Nova/' }]); })(),
  });
  const ready = await waitFaceReady({ root: 'C:\\NOVA', port: 3466, timeoutMs: 5000, intervalMs: 1, fetchFn });
  assert.equal(ready.ok, true);
  assert.equal(ready.session.id, 's2');
  assert.equal(ready.health.version, '2.45.0');
});

test('waitFaceReady: a daemon full of FOREIGN sessions is not ready (the old sessions>=1 bug)', async () => {
  const ready = await waitFaceReady({
    root: 'C:\\NOVA', port: 3458, timeoutMs: 40, intervalMs: 1,
    fetchFn: faceFetch({
      health: { ok: true, sessions: 3, version: '2.45.0' },
      sessions: [{ id: 's1', cwd: 'C:\\ALPHA' }, { id: 's2', cwd: 'C:\\OTHER' }, { id: 's3', cwd: 'D:\\WORK' }],
    }),
  });
  assert.equal(ready.ok, false, 'a foreign session must never count as this soul being handed over');
  assert.equal(ready.sessions, 3);
  assert.equal(ready.wantedCwd, 'c:\\nova');
  assert.deepEqual(ready.foreignSessions, ['C:\\ALPHA', 'C:\\OTHER', 'D:\\WORK']);
});

test('waitFaceReady: a live daemon with zero sessions, and an unreachable one, both time out', async () => {
  const empty = await waitFaceReady({
    root: 'C:\\NOVA', port: 3466, timeoutMs: 30, intervalMs: 1,
    fetchFn: faceFetch({ health: { ok: true, sessions: 0 }, sessions: [] }),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.sessions, 0);

  const never = await waitFaceReady({
    root: 'C:\\NOVA', port: 3466, timeoutMs: 30, intervalMs: 1,
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(never.ok, false);
  assert.ok(never.tries >= 1);
  assert.equal(never.sessions, null);
});

test('finish: steps.handoff=done, node cache removed, quit called', () => {
  const root = freshRoot('finish');
  const receipt = newReceipt({ root, name: 'NOVA', manifest: MANIFEST, createdBy: 'package-installer' });
  writeReceipt(root, receipt);

  const workDir = path.join(tmp, 'work-finish');
  fs.mkdirSync(path.join(workDir, 'node'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'node', 'node.exe'), 'not really', 'utf8');

  let quit = 0;
  const steps = [];
  const res = finish({
    root, receipt, workDir,
    quit: () => { quit += 1; },
    setStep: (s) => steps.push(s),
    deferRemove: false,
  });

  assert.equal(res.ok, true);
  assert.equal(res.cacheRemoved, true);
  assert.equal(fs.existsSync(path.join(workDir, 'node')), false);
  assert.equal(readReceipt(root).steps.handoff, 'done');
  assert.deepEqual(steps, ['done']);
  assert.equal(quit, 1);
});

// ---------------------------------------------------------------------------
// installer/ui/index.html
// ---------------------------------------------------------------------------

// Check ④ of verify/static.mjs compares the `:root { ... }` custom-property
// block of Face's app/style.css with the one in installer/ui/index.html. Do
// the same here so the repo's own test suite catches a drift without needing
// a built zip. P01 is a sibling checkout, so skip loudly when it is absent.
function faceStyleCss() {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
  const css = path.resolve(REPO, lock.parts.face.source, 'app', 'style.css');
  return fs.existsSync(css) ? css : null;
}

function extractRootBlock(raw) {
  // Line endings are a checkout artefact (P01 is checked out with
  // core.autocrlf=true, so its working copy is CRLF while the index is LF);
  // the comparison is about the tokens, so normalise before comparing.
  const css = raw.replace(/\r\n/g, '\n');
  const idx = css.indexOf(':root');
  if (idx === -1) return null;
  const braceStart = css.indexOf('{', idx);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(idx, i + 1); }
  }
  return null;
}

// v1 화면(ⓐ~ⓕ 6카드) 시험 2벌은 v2 화면(①~⑧ 8카드)으로 바뀌면서 **tests/ui-v2.test.mjs 로 옮겼다**
// (Task 12). 옛 시험이 보던 값(canProceedOffline·allOk·installError·userEnvSkipped·reopenAvailable)은
// v2 계약에 더 이상 없다. 아래 :root 대조 시험만 판과 무관하므로 여기 남긴다.

test('ui/index.html :root block is byte-identical to IRIS-Face app/style.css (static check ④)', (t) => {
  const css = faceStyleCss();
  if (!css) { t.skip('IRIS-Face (P01) sibling checkout not present -- cannot compare the :root block'); return; }
  const faceRoot = extractRootBlock(fs.readFileSync(css, 'utf8'));
  const uiRoot = extractRootBlock(fs.readFileSync(path.join(REPO, 'installer', 'ui', 'index.html'), 'utf8'));
  assert.ok(faceRoot, 'no :root block found in Face style.css');
  assert.equal(uiRoot, faceRoot);
});

// ---------------------------------------------------------------------------
// server wiring -- 제거됨 (v2, Task 11)
// ---------------------------------------------------------------------------
// v1 의 `POST /api/handoff` 라우트는 v2 에 없다: 인계 문서·완료 보고는 세팅
// 엔진의 마지막 단계(`setup/checks.mjs`·`setup/handoff.mjs`, T18)가 쓰고,
// 서버는 `GET /api/report` 로 그 결과를 읽어 줄 뿐이다(docs/설치기-API-v2.md).
// 그래서 그 라우트를 겨눴던 시험 넷은 여기서 지웠다 — 이 파일에 남은 것은
// `installer/lib/handoff.mjs` 자체의 시험이고, 그 모듈은 T17(relay 단계)이
// 계속 쓴다. v2 서버의 라우트 시험은 `tests/server.test.mjs` 에 있다.
