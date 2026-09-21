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
// 코덱스는 base-URL 방식이 없다 — TeamClaude 는 코덱스를 **전달 프록시(MITM) 방식**으로만
// 중계한다(chatgpt.com 행 CONNECT 를 가로채 계정 토큰을 끼움). 그래서 코덱스 심에서만
// HTTPS_PROXY 를 중계기로 두고, 중계기의 CA 를 담은 번들을 SSL_CERT_FILE 로 넘긴다
// (Rust CLI 는 NODE_EXTRA_CA_CERTS 를 모른다). 번들 = 공인 루트 전부 + TeamClaude CA:
// SSL_CERT_FILE 은 rustls 에서 시스템 신뢰 목록을 **대체**하므로 CA 하나만 주면
// 가로채지 않고 통과시키는 호스트(auth.openai.com 등)의 진짜 인증서가 실패한다.
// 세션의 다른 도구(git·npm·curl)는 프록시를 모른 채 그대로 둔다(설계 A', 2026-09-18).
export const CODEX_PROXY_LINES = Object.freeze([
  'set "HTTPS_PROXY=http://127.0.0.1:3456"',
  'set "NO_PROXY=localhost,127.0.0.1,::1"',
  'set "SSL_CERT_FILE=%~dp0..\\portable-state\\teamclaude\\codex-ca-bundle.pem"',
]);

export function agentShim(agent) {
  const { envName, envDir, tool } = AGENT_SHIMS[agent];
  return crlf([
    '@echo off',
    'setlocal',
    'set "ANTHROPIC_BASE_URL=http://127.0.0.1:3456"',
    ...(agent === 'codex' ? CODEX_PROXY_LINES : []),
    `set "${envName}=%~dp0..\\..\\${envDir}"`,
    'set "PATH=%~dp0..\\tools\\node;%PATH%"',
    'if exist "%~dp0relay-ensure.cmd" call "%~dp0relay-ensure.cmd"',
    `call "%~dp0..\\tools\\${tool}\\${tool}.cmd" %*`,
    'exit /b %errorlevel%',
  ]);
}

// 2.0.35(2026-09-21 사용자 실측 "IRIS 밖 폴더 터미널에서 claude/codex 가 안 됨"): 원인은 폴더가 아니라 중계기(3456)가
// IRIS 창을 열기 전엔 떠 있지 않은 것. 심이 실행될 때 3456 이 응답하지 않으면 관리 스크립트로 중계기를 띄우고
// 최대 8초 기다린다(이미 떠 있으면 0.4초 확인만). 실패해도 막지 않는다 — 한 줄 알리고 그대로 진행.
// 로그온 자동 시작(HKCU\…\Run → relay-autostart.vbs → relay-ensure.cmd, 창 없음)도 같은 파일을 쓴다. 전부 ASCII.
export function relayEnsureCmd() {
  return crlf([
    '@echo off',
    'rem IRIS: make sure the TeamClaude relay (127.0.0.1:3456) is up before an agent starts. Quiet when it already is.',
    'setlocal',
    'if exist "%~dp0..\\tools\\node\\node.exe" "%~dp0..\\tools\\node\\node.exe" "%~dp0relay-ensure.mjs"',
    'exit /b 0',
  ]);
}
export function relayEnsureMjs() {
  return [
    '// IRIS relay-ensure: if nothing answers on 127.0.0.1:3456, start the TeamClaude relay through its manage script and wait (max 8 s). Always exits 0.',
    "import net from 'node:net';",
    "import path from 'node:path';",
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { fileURLToPath } from 'node:url';",
    'const here = path.dirname(fileURLToPath(import.meta.url));   // <root>/_agent/shared/shims',
    'const shared = path.dirname(here);                            // <root>/_agent/shared',
    'const port = Number(process.env.IRIS_RELAY_PORT || 3456);',
    'const waitMs = Number(process.env.IRIS_RELAY_WAIT_MS || 8000);',
    "const probe = () => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }); const done = (v) => { try { s.destroy(); } catch {} res(v); }; s.setTimeout(400, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false)); });",
    'if (await probe()) process.exit(0);',
    "const manage = process.env.IRIS_RELAY_MANAGE || path.join(shared, 'tools', 'teamclaude', 'teamclaude-manage.ps1');",
    "const node = path.join(shared, 'tools', 'node', 'node.exe');",
    "const entry = path.join(shared, 'tools', 'teamclaude', 'node_modules', '@karpeleslab', 'teamclaude', 'src', 'index.js');",
    "if (!fs.existsSync(manage)) { process.stderr.write('[IRIS] relay helper missing - open the IRIS window once to start the relay\\n'); process.exit(0); }",
    'const env = { ...process.env };',
    "if (!env.TEAMCLAUDE_CONFIG) env.TEAMCLAUDE_CONFIG = path.join(shared, 'portable-state', 'teamclaude', 'teamclaude.json');",
    "try { const c = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', manage, 'start', '-NodePath', node, '-EntryPath', entry], { env, windowsHide: true, stdio: 'ignore', detached: true }); c.unref(); } catch { process.exit(0); }",
    'const t0 = Date.now();',
    'while (Date.now() - t0 < waitMs) { await new Promise((r) => setTimeout(r, 250)); if (await probe()) process.exit(0); }',
    "process.stderr.write('[IRIS] relay did not answer on 127.0.0.1:' + port + ' in time - open the IRIS window once, then retry\\n');",
    'process.exit(0);',
    '',
  ].join('\n');
}
export function relayAutostartVbs() {
  return crlf([
    "' IRIS: start the TeamClaude relay at logon without a console window (HKCU Run key points here).",
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'sh.Run """" & dir & "\\relay-ensure.cmd""", 0, False',
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
    ['relay-ensure.cmd', relayEnsureCmd()], ['relay-ensure.mjs', relayEnsureMjs()], ['relay-autostart.vbs', relayAutostartVbs()],
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
