import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Task 9's two "outer shell" files must be readable and executable on a
// bare, freshly-imaged Windows PC with only its OEM code page installed --
// no UTF-8 console, no BOM assumptions. Non-ASCII bytes in either file
// (accidental curly quotes, an em dash, a stray Korean character pasted
// into a comment) risk mangled output or, worse, a broken script.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CMD_PATH = path.join(ROOT_DIR, 'installer', 'IRIS-설치.cmd');
const PS1_PATH = path.join(ROOT_DIR, 'installer', 'bootstrap.ps1');

const cmdText = fs.readFileSync(CMD_PATH, 'utf8');
const ps1Text = fs.readFileSync(PS1_PATH, 'utf8');

test('the .cmd launcher file content is ASCII only (the filename itself is Korean)', () => {
  const hits = cmdText.match(/[^\x00-\x7F]/g);
  assert.deepEqual(hits, null, `non-ASCII byte(s) found in the .cmd launcher: ${JSON.stringify(hits)}`);
});

test('bootstrap.ps1 is ASCII only', () => {
  const hits = ps1Text.match(/[^\x00-\x7F]/g);
  assert.deepEqual(hits, null, `non-ASCII byte(s) found in bootstrap.ps1: ${JSON.stringify(hits)}`);
});

// Working-tree fix (Task 9 review finding #1): both files must be CRLF on
// disk, not just CRLF-on-checkout via .gitattributes (which only re-hydrates
// on a fresh `git checkout`, not on a working tree that predates the
// attribute). A file with zero bare `\n` (every `\n` is part of a `\r\n`
// pair) and at least one `\r\n` is unambiguously CRLF-only.
function assertCRLFOnly(text, label) {
  assert.ok(/\r\n/.test(text), `${label}: expected at least one CRLF line ending`);
  const bareLf = text.replace(/\r\n/g, '').match(/\n/g);
  assert.deepEqual(bareLf, null, `${label}: found bare LF line ending(s) not paired with CR`);
}

test('the .cmd launcher is CRLF only in the working tree', () => {
  assertCRLFOnly(cmdText, 'IRIS-설치.cmd');
});

test('bootstrap.ps1 is CRLF only in the working tree', () => {
  assertCRLFOnly(ps1Text, 'bootstrap.ps1');
});

test('bootstrap.ps1 exits 10/11/12/13 for its four failure stages', () => {
  for (const code of [10, 11, 12, 13]) {
    assert.match(ps1Text, new RegExp(`exit ${code}\\b`), `bootstrap.ps1 missing "exit ${code}"`);
  }
});

test('bootstrap.ps1 also has the success exit 0', () => {
  assert.match(ps1Text, /exit 0\b/);
});

test('the .cmd launcher runs bootstrap.ps1 with -ExecutionPolicy Bypass', () => {
  assert.match(cmdText, /-ExecutionPolicy Bypass/);
  assert.match(cmdText, /installer\\bootstrap\.ps1/);
});

test('the .cmd launcher only pauses on failure, not on the happy path', () => {
  // The brief's design: pause() must appear inside the `if errorlevel 1`
  // block, not unconditionally after it -- a successful run should close
  // the window (or leave it to the browser flow) without blocking on a
  // keypress.
  // Non-greedy up to a line that is just a closing paren -- the block's
  // own body contains a literal ")" (in "(code %errorlevel%)"), so a naive
  // ([\s\S]*?)\) would close too early on that inner parenthesis.
  const errorBlockMatch = cmdText.match(/if errorlevel 1 \(([\s\S]*?)\n\)/);
  assert.ok(errorBlockMatch, 'the .cmd launcher is missing an "if errorlevel 1 ( ... )" block');
  assert.match(errorBlockMatch[1], /pause/);
  const beforeBlock = cmdText.slice(0, errorBlockMatch.index);
  assert.doesNotMatch(beforeBlock, /pause/, 'pause must not appear before the failure check');
});

// Fix round 1 finding #5 (regression): a literal, unescaped "(" or ")" inside
// the "if errorlevel 1 ( ... )" block body breaks cmd.exe's paren-counting
// block parser -- observed live as exit code 255 and a garbled
// "'.' was unexpected at this time." instead of the intended message+pause,
// on every failure path (exit 10/11/12/13 all route through this block).
// The failure message's "(code %errorlevel%)" must use caret-escaped
// "^(...^)" so cmd.exe treats them as literal text, not block delimiters.
test('the .cmd launcher escapes literal parens inside the errorlevel block', () => {
  const errorBlockMatch = cmdText.match(/if errorlevel 1 \(([\s\S]*?)\n\)/);
  assert.ok(errorBlockMatch, 'the .cmd launcher is missing an "if errorlevel 1 ( ... )" block');
  const body = errorBlockMatch[1];
  assert.match(body, /\^\(code %errorlevel%\^\)/, 'expected caret-escaped ^(code %errorlevel%^)');
  // No OTHER unescaped paren should sneak into the block body either: every
  // "(" or ")" in the body must be immediately preceded by a caret.
  const unescaped = body.match(/(?<!\^)[()]/g);
  assert.deepEqual(unescaped, null, `found unescaped paren(s) in the errorlevel block: ${JSON.stringify(unescaped)}`);
});

// Fix round 1 finding #2: a server from a previous run must not be started
// a second time (it would fail to bind the port while the health probe
// keeps answering against the old one, clobbering server.pid with a dead
// pid). bootstrap.ps1 must probe the health endpoint, verify it is *our*
// server via the "name":"iris-installer" field (Task 10's server.mjs
// contract), reuse it and exit 0 if so, and otherwise stop only the exact
// pid recorded in server.pid -- never by process name or a port scan.
test('bootstrap.ps1 checks for and reuses an already-running iris-installer server', () => {
  assert.match(ps1Text, /iris-installer/, 'missing the "name":"iris-installer" health-body contract check');
  assert.match(ps1Text, /already running/i);
});

test('bootstrap.ps1 stops a stale server by its recorded pid only, never by name or port', () => {
  assert.match(ps1Text, /Stop-Process\s+-Id\s+\$stalePid/, 'missing Stop-Process -Id on the recorded stale pid');
  assert.doesNotMatch(ps1Text, /Stop-Process[^\n]*-Name/i, 'must never stop a process by name');
  assert.doesNotMatch(ps1Text, /taskkill/i, 'must never shell out to taskkill');
  assert.doesNotMatch(ps1Text, /Get-NetTCPConnection|netstat/i, 'must never scan the port to find a process to kill');
});

// Fix round 1 finding #3: bootstrap.log must not grow forever.
test('bootstrap.ps1 writes a run separator and rotates the log past 512KB', () => {
  assert.match(ps1Text, /---- run /, 'missing a per-run separator line');
  assert.match(ps1Text, /524288/, 'missing the 512KB (524288 byte) rotation threshold');
  assert.match(ps1Text, /bootstrap\.log\.1/, 'missing the bootstrap.log.1 rotation target');
});
