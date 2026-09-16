import fs from 'node:fs';
import path from 'node:path';

// <root>\_agent\shared\shims\ is the single directory added to the user's
// PATH (docs/설계.md 2-2). Each .cmd is a thin forwarder that pins the
// bundled runtime and this soul's config directories, so `claude` / `codex`
// / `node` behave identically whether they are typed in a terminal, launched
// by Face, or spawned by the dashboard -- no matter what else is installed on
// the machine.
//
// Two hard constraints on the file contents:
//   - ASCII only. A .cmd is read by cmd.exe in the console's OEM codepage
//     (949 here), so any non-ASCII byte is a corruption risk.
//   - CRLF. cmd.exe mis-parses LF-only batch files in some builds
//     (the repo already enforces this for installer/*.cmd and *.ps1).
//
// Relative-path arithmetic, with %~dp0 = <root>\_agent\shared\shims\ :
//   %~dp0..\tools\...  -> <root>\_agent\shared\tools\...
//   %~dp0..\..\claude  -> <root>\_agent\claude      (CLAUDE_CONFIG_DIR)
//   %~dp0..\..\codex   -> <root>\_agent\codex       (CODEX_HOME)
//
// The agent shims call npm's own generated wrapper (claude.cmd / codex.cmd in
// the npm prefix) rather than `node <pkg>\cli.js` directly: the wrapper is
// what upstream supports, it already knows the package's real entry point
// (which moves between releases), and for codex it is what dispatches to the
// platform-native binary. It needs a `node` on PATH, hence the PATH line.

const AGENT_SHIMS = {
  claude: { envName: 'CLAUDE_CONFIG_DIR', envDir: 'claude', tool: 'claude' },
  codex: { envName: 'CODEX_HOME', envDir: 'codex', tool: 'codex' },
};

function crlf(lines) {
  return lines.join('\r\n') + '\r\n';
}

function nodeShim() {
  return crlf([
    '@echo off',
    'setlocal',
    '"%~dp0..\\tools\\node\\node.exe" %*',
    'exit /b %errorlevel%',
  ]);
}

// git / python / py shims (2026-09-14, field report from a second PC): the
// setup guide's v7 foundations checker finds `git`, `node`, `python` and `py`
// on PATH. That PC had a system Git 2.51 ahead of ours on PATH, the checker
// judged it "older than the pinned 2.54.0.windows.1" and tried a WinGet
// upgrade to that exact version, which the WinGet source no longer carried
// -- setup stopped. The bundled Git/Node/Python ARE the pinned versions, so
// putting them first on PATH (Face prepends <shims>, <tools>\node, <tools>\git\cmd,
// <tools>\python for every session and for the finalize pipeline) makes the
// checker pass without touching the system. These shims cover the shim dir
// itself, which is the one directory the installer adds to the user PATH.
// `py` mimics the Windows launcher just enough for `py -3.12 --version`:
// a leading -3* selector is dropped and the bundled 3.12 runs.
function gitShim() {
  return crlf([
    '@echo off',
    'setlocal',
    '"%~dp0..\\tools\\git\\cmd\\git.exe" %*',
    'exit /b %errorlevel%',
  ]);
}
function pythonShim() {
  return crlf([
    '@echo off',
    'setlocal',
    '"%~dp0..\\tools\\python\\python.exe" %*',
    'exit /b %errorlevel%',
  ]);
}
function pyShim() {
  return crlf([
    '@echo off',
    'setlocal',
    'set "first=%~1"',
    'set "args=%*"',
    'if "%first:~0,2%"=="-3" (',
    '  if "%args%"=="%first%" (set "args=") else (call set "args=%%args:*%first% =%%")',
    ')',
    '"%~dp0..\\tools\\python\\python.exe" %args%',
    'exit /b %errorlevel%',
  ]);
}

// Exported (not just used internally by writeShims below) so verify/static.mjs
// check ⑥ can byte-compare this template against its P02 daemon/wake.mjs
// sibling copy (agentShimText()) -- the two must never drift (see that file's
// header comment for the provenance/duplication rationale).
export function agentShim(agent) {
  const { envName, envDir, tool } = AGENT_SHIMS[agent];
  return crlf([
    '@echo off',
    'setlocal',
    'set "ANTHROPIC_BASE_URL=http://127.0.0.1:3456"',
    `set "${envName}=%~dp0..\\..\\${envDir}"`,
    'set "PATH=%~dp0..\\tools\\node;%PATH%"',
    `call "%~dp0..\\tools\\${tool}\\${tool}.cmd" %*`,
    'exit /b %errorlevel%',
  ]);
}

export function shimsDir(root) {
  return path.join(root, '_agent', 'shared', 'shims');
}

// A shim whose bytes are already exactly right is left alone -- not rewritten
// with the same content. The v2 setup engine's re-run check is "second run
// changes nothing" (docs\세팅엔진-계약-v2.md 검사 8), and a byte-identical
// rewrite still moves the file's mtime, which a fingerprint comparison reads
// as a change (measured 2026-09-15 on the T13 rehearsal root: 5 shims, same
// size, new mtime). `written` still lists every shim that exists afterwards
// -- callers use it as "the set of shims", not "what I just touched".
function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, 'ascii') === text) return false;
  } catch { /* missing or unreadable -> write it */ }
  fs.writeFileSync(file, text, 'ascii');
  return true;
}

// writeShims(root, activeAgents) -- activeAgents is the subset of
// ['claude','codex'] the user actually logged in with. A subscription that
// was not chosen still has its files on disk but gets no shim, so it stays
// asleep until the dashboard wakes it (설계.md 2-2, 5절 ③).
export function writeShims(root, activeAgents = []) {
  const dir = shimsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const changed = [];

  for (const [name, text] of [
    ['node.cmd', nodeShim()], ['git.cmd', gitShim()], ['python.cmd', pythonShim()], ['py.cmd', pyShim()],
  ]) {
    const file = path.join(dir, name);
    if (writeIfChanged(file, text)) changed.push(file);
    written.push(file);
  }

  for (const agent of ['claude', 'codex']) {
    if (!activeAgents.includes(agent)) continue;
    const file = path.join(dir, `${agent}.cmd`);
    if (writeIfChanged(file, agentShim(agent))) changed.push(file);
    written.push(file);
  }
  return { dir, written, changed };
}
