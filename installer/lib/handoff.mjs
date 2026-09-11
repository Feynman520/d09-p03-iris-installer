import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { run } from '../../lib/run.mjs';
import { toolsDir } from './install.mjs';
import { writeReceipt, markStep } from './receipt.mjs';

// Step ⓕ of the wizard: hand the finished soul over to IRIS-Face and get out
// of the way. Nothing here is interactive -- the person has already logged in
// (Task 13); this module writes the two files Face needs, starts it, waits
// for one live session, stamps the receipt and quits.
//
// Layout (fixed by docs/설계.md 4-1/4-2 + installer/lib/install.mjs LAYOUT):
//   <root>\_agent\setup\first-request.txt    첫 요청문 (3문장)
//   <root>\_agent\setup\first-session.json   launch.mjs --first-session spec
//   <root>\_agent\shared\tools\face\         IRIS-Face
//   <root>\_agent\shared\tools\node\node.exe 동봉 node
//   <root>\_setup-guides\<가이드 파일명>      세팅가이드 두 판
//   <root>\<영혼이름> Face.cmd                소환기 (+ 바탕화면 .lnk)

export const FACE_PORT = 3458;

export function setupDir(root) { return path.join(root, '_agent', 'setup'); }
export function firstRequestPath(root) { return path.join(setupDir(root), 'first-request.txt'); }
export function firstSessionSpecPath(root) { return path.join(setupDir(root), 'first-session.json'); }
export function faceDirFor(root) { return path.join(toolsDir(root), 'face'); }
export function nodeExeFor(root) { return path.join(toolsDir(root), 'node', 'node.exe'); }
export function faceLogPath(root) { return path.join(setupDir(root), 'face-launch.log'); }

// ---------------------------------------------------------------------------
// ① 첫 요청문 -- docs/설계.md 4-2
// ---------------------------------------------------------------------------

// The guide's real file name comes from the manifest that shipped in this
// zip (`guides:<basename>` keys, build/collect.mjs) -- never a literal
// "_v10.md" in the source, which would silently point the agent at a file
// that does not exist the moment the guide version moves.
// Strict on purpose (fix round 1 finding 4): if the *chosen* edition's guide is
// not in the manifest, this fails instead of handing the person the other
// edition. A Codex-led soul pointed at the Claude guide would be told to
// follow instructions written for a CLI it does not have -- a wrong contract is
// worse than a loud stop.
export function resolveGuide(manifest, edition = 'claude') {
  const wanted = (edition === 'chatgpt' || edition === 'codex') ? 'Codex' : 'Claude';
  const basenames = Object.keys(manifest?.parts ?? {})
    .filter((k) => k.startsWith('guides:'))
    .map((k) => k.slice('guides:'.length));
  if (basenames.length === 0) return null;
  const basename = basenames.find((b) => b.includes(`(${wanted} 실행판)`));
  if (!basename) return null;
  return {
    basename,
    edition: wanted,
    version: manifest?.package?.guideVersion ?? null,
  };
}

// 'claude' | 'chatgpt' | 'codex' -> the guide edition word used in the filename.
export function guideEditionWord(edition = 'claude') {
  return (edition === 'chatgpt' || edition === 'codex') ? 'Codex' : 'Claude';
}

// Three sentences, one line (the prompt is typed into a terminal), absolute
// paths only: ① 계약서(세팅가이드) 위치 ② 인수인계 노트(영수증) 위치
// ③ Face 노란 카드(AskUserQuestion) 방지.
export function firstRequestText({ root, guideBasename }) {
  const guide = path.join(root, '_setup-guides', guideBasename);
  const receipt = path.join(root, '_agent', 'setup', 'package-receipt.json');
  return `${guide}대로 세팅해 줘. 설치 패키지가 먼저 깔아 둔 것은 ${receipt}에 있어. 나한테 물을 것은 일반 문장으로 물어봐.`;
}

export function writeFirstRequest(root, { edition = 'claude', manifest } = {}) {
  const guide = resolveGuide(manifest, edition);
  if (!guide) {
    const anyGuide = Object.keys(manifest?.parts ?? {}).some((k) => k.startsWith('guides:'));
    throw anyGuide
      ? Object.assign(
        new Error(`manifest has guides but none for the ${guideEditionWord(edition)} edition`),
        { code: `guide-missing:${edition}` },
      )
      : Object.assign(new Error('manifest carries no guides:<basename> part'), { code: 'no-guide-in-manifest' });
  }
  const text = firstRequestText({ root, guideBasename: guide.basename });
  const dest = firstRequestPath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${text}\n`, 'utf8');
  return { path: dest, text, guide };
}

// ---------------------------------------------------------------------------
// ② 소환기 <영혼이름> Face.cmd + 바탕화면 바로가기
// ---------------------------------------------------------------------------

// Same shape as this PC's IRIS-Face.cmd, with two deliberate differences:
// every path is %~dp0-relative (the file sits at the soul root, so the soul
// may be called anything and may even be moved), and there is no
// machine-specific environment line. ASCII + CRLF so cmd.exe reads it the
// same way under any code page -- which is also why the soul name never
// appears *inside* the file, only in its name.
export function faceLauncherContent() {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'rem IRIS-Face: Claude Code / Codex sessions in one window.',
    'rem Daemon 127.0.0.1:3458 + window. Usage: this file [--browser] [--no-open]',
    'setlocal',
    '"%~dp0_agent\\shared\\tools\\node\\node.exe" "%~dp0_agent\\shared\\tools\\face\\launch.mjs" %*',
    'endlocal',
    '',
  ].join('\r\n');
}

export function faceLauncherPath(root, name) { return path.join(root, `${name} Face.cmd`); }

// PowerShell is run from a temp .ps1 written as UTF-8 *with BOM* rather than
// through -Command: a Korean soul name in a -Command string arrives mangled
// under a non-UTF-8 console code page, and a BOM-less .ps1 is read as ANSI by
// Windows PowerShell 5.1 (the repo-wide R-004 rule).
export async function defaultRunPs(script) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iris-shortcut-')), 'shortcut.ps1');
  try {
    fs.writeFileSync(file, '\ufeff' + script, 'utf8'); // BOM: PS 5.1 reads a BOM-less .ps1 as ANSI
    return await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file,
    ], { timeoutMs: 30000 });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// `desktopDir` is injectable so a rehearsal writes into a temp folder instead
// of the real desktop. When it is null the script asks Windows itself
// ([Environment]::GetFolderPath) -- the desktop is often redirected (OneDrive)
// and guessing %USERPROFILE%\Desktop would silently create a dead shortcut.
export async function writeFaceLauncher(root, name, { desktopDir = null, runPs = defaultRunPs, skipShortcut = false } = {}) {
  const cmdPath = faceLauncherPath(root, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(cmdPath, faceLauncherContent(), 'utf8');

  if (skipShortcut) {
    return { cmdPath, lnkPath: null, shortcut: { ok: false, detail: 'skipped' } };
  }

  const lnkPath = desktopDir ? path.join(desktopDir, `${name} Face.lnk`) : null;
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    desktopDir ? `$desk = ${psQuote(desktopDir)}` : '$desk = [Environment]::GetFolderPath(\'Desktop\')',
    `$lnk = Join-Path $desk ${psQuote(`${name} Face.lnk`)}`,
    '$shell = New-Object -ComObject WScript.Shell',
    '$sc = $shell.CreateShortcut($lnk)',
    `$sc.TargetPath = ${psQuote(cmdPath)}`,
    `$sc.WorkingDirectory = ${psQuote(root)}`,
    '$sc.WindowStyle = 7',
    '$sc.Description = \'IRIS-Face\'',
    '$sc.Save()',
    'Write-Output $lnk',
  ].join('\n');

  let shortcut;
  try {
    const r = await runPs(script);
    shortcut = r.code === 0
      ? { ok: true, detail: (r.out ?? '').trim() || null }
      : { ok: false, detail: (r.err || r.out || `powershell exit ${r.code}`).trim() };
  } catch (err) {
    shortcut = { ok: false, detail: String(err?.message ?? err) };
  }
  const resolved = lnkPath ?? (shortcut.ok && shortcut.detail ? shortcut.detail : null);
  return { cmdPath, lnkPath: resolved, shortcut };
}

// ---------------------------------------------------------------------------
// ③ 첫 세션 spec + Face 실행
// ---------------------------------------------------------------------------

// Model/effort defaults mirror P02 daemon/agents.mjs AGENTS[...].default, with
// effort pinned to 'high' for the setting-up session (task-14-brief). Both are
// overridable so a rehearsal can pick a cheap model.
const AGENT_DEFAULTS = {
  claude: { agent: 'claude', model: 'opus', effort: 'high' },
  codex: { agent: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
};

export function defaultSpecFor(leadAgent = 'claude') {
  const key = (leadAgent === 'chatgpt' || leadAgent === 'codex') ? 'codex' : 'claude';
  return { ...AGENT_DEFAULTS[key] };
}

export function writeFirstSessionSpec(root, { leadAgent = 'claude', promptFile, model, effort } = {}) {
  const base = defaultSpecFor(leadAgent);
  const spec = {
    cwd: root,
    agent: base.agent,
    model: model ?? base.model,
    effort: effort ?? base.effort,
    promptFile: promptFile ?? firstRequestPath(root),
  };
  const dest = firstSessionSpecPath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  return { path: dest, spec };
}

// Detached on purpose: Face outlives the installer (which quits seconds
// later). stdout/stderr go to <root>\_agent\setup\face-launch.log so a failed
// handoff has something to read.
export function launchFace({
  root,
  nodeDir,
  nodeExe,
  spec,
  faceDir,
  port = FACE_PORT,
  extraArgs = [],
  env,
  spawnFn = spawn,
  logFile,
} = {}) {
  const exe = nodeExe ?? (nodeDir ? path.join(nodeDir, 'node.exe') : nodeExeFor(root));
  const dir = faceDir ?? faceDirFor(root);
  const specPath = spec ?? firstSessionSpecPath(root);
  const args = [
    path.join(dir, 'launch.mjs'),
    '--first-session', specPath,
    '--port', String(port),
    ...extraArgs,
  ];

  const log = logFile ?? faceLogPath(root);
  let stdio = 'ignore';
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fd = fs.openSync(log, 'a');
    stdio = ['ignore', fd, fd];
  } catch { /* no log file -- still launch */ }

  try {
    const child = spawnFn(exe, args, {
      cwd: dir,
      detached: true,
      stdio,
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.unref?.();
    return { pid: child.pid, command: `${exe} ${args.join(' ')}`, logFile: log };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

// Windows path comparison, identical to P02 launch.mjs's own normCwd (which is
// what decides there whether a session already exists for a folder): forward
// slashes are separators too, a trailing separator means nothing, and case
// does not matter.
export function normCwd(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// Ready = the daemon answers /api/health with 200 *and* /api/sessions lists at
// least one session whose cwd is this soul root.
//
// The health endpoint's `sessions` count alone is not enough (fix round 1
// finding 1): it is the daemon's GLOBAL count, and on a PC that was already
// running Face -- the normal case for a re-install, and for the default port
// 3458 generally -- somebody else's session satisfies `>= 1` while this soul
// got none. That would stamp steps.handoff=done over a handoff that never
// happened, and the person would be left with an installed soul and no
// setting-up session.
export async function waitFaceReady({
  root, port = FACE_PORT, timeoutMs = 60000, intervalMs = 500, fetchFn = fetch,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const wanted = root ? normCwd(root) : null;
  let tries = 0;
  let lastHealth = null;
  let lastSessions = null;
  let lastError = null;
  for (;;) {
    tries += 1;
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        lastHealth = await res.json();
        const sres = await fetchFn(`http://127.0.0.1:${port}/api/sessions`);
        if (sres.ok) {
          const list = await sres.json();
          lastSessions = Array.isArray(list) ? list : [];
          const mine = wanted === null
            ? lastSessions
            : lastSessions.filter((s) => normCwd(s?.cwd) === wanted);
          if (mine.length >= 1) {
            return { ok: true, health: lastHealth, session: mine[0], sessions: lastSessions.length, tries };
          }
        }
      }
    } catch (err) {
      lastError = String(err?.message ?? err);
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        health: lastHealth,
        tries,
        error: lastError,
        // What was actually seen, so a failure says "the daemon is up with N
        // sessions, none of them in this folder" rather than just "timed out".
        sessions: lastSessions === null ? null : lastSessions.length,
        foreignSessions: lastSessions === null ? null : lastSessions.map((s) => s?.cwd ?? null),
        wantedCwd: wanted,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// ④ 마무리
// ---------------------------------------------------------------------------

export function defaultWorkDir(env = process.env) {
  return env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'IRIS-Installer')
    : path.join(os.tmpdir(), 'IRIS-Installer');
}

// The unpacked node under %LOCALAPPDATA%\IRIS-Installer\node is ~100 MB of
// cache that has no reason to survive a finished install. It cannot normally
// be deleted from inside itself (the running server *is* that node.exe, and
// Windows locks a running image), so a best-effort rmSync is followed by a
// detached retry that runs after this process is gone. `deferRemove:false`
// turns that retry off (tests, rehearsal).
export function finish({
  root, receipt, workDir = defaultWorkDir(), quit = null, setStep = null,
  spawnFn = spawn, deferRemove = true,
} = {}) {
  let receiptWritten = false;
  if (receipt) {
    markStep(receipt, 'handoff', 'done');
    writeReceipt(root, receipt);
    receiptWritten = true;
  }
  setStep?.('done');

  const nodeCache = path.join(workDir, 'node');
  let cacheRemoved = false;
  let cacheError = null;
  let deferred = false;
  try {
    if (fs.existsSync(nodeCache)) {
      fs.rmSync(nodeCache, { recursive: true, force: true });
    }
    cacheRemoved = !fs.existsSync(nodeCache);
  } catch (err) {
    cacheError = String(err?.message ?? err);
  }
  if (!cacheRemoved && fs.existsSync(nodeCache) && deferRemove) {
    try {
      const child = spawnFn('cmd.exe', ['/c', 'ping', '-n', '6', '127.0.0.1', '>nul', '&', 'rmdir', '/s', '/q', nodeCache], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref?.();
      deferred = true;
    } catch (err) {
      cacheError = cacheError ?? String(err?.message ?? err);
    }
  }

  quit?.();
  return { ok: true, receiptWritten, cacheRemoved, cacheError, deferred, nodeCache };
}
