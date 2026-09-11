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
