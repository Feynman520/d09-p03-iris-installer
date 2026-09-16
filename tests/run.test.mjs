import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, batchLine, quoteArg, isBatch } from '../lib/run.mjs';

const WIN = process.platform === 'win32';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-run-'));

/** 인자를 그대로 되돌려 주는 배치 픽스처. 지연 확장이라 값 안의 `&`·`^` 가 배치 안에서 재해석되지 않는다. */
function echoFixture(name) {
  const p = path.join(scratch, name);
  fs.writeFileSync(p, [
    '@echo off',
    'setlocal enabledelayedexpansion',
    ':loop',
    'if "%~1"=="" goto end',
    'set "A=%~1"',
    'echo([!A!]',
    'shift',
    'goto loop',
    ':end',
    '',
  ].join('\r\n'), 'ascii');
  return p;
}

function fixture(name, body) {
  const p = path.join(scratch, name);
  fs.writeFileSync(p, body, 'ascii');
  return p;
}

const echoed = (r) => r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^\[|\]$/g, ''));

test('isBatch recognises .cmd/.bat regardless of case, and nothing else', () => {
  assert.equal(isBatch('C:\\x\\claude.cmd'), true);
  assert.equal(isBatch('C:\\x\\claude.CMD'), true);
  assert.equal(isBatch('C:\\x\\go.Bat'), true);
  assert.equal(isBatch('C:\\x\\node.exe'), false);
  assert.equal(isBatch('python'), false);
  assert.equal(isBatch('C:\\cmd.bat.exe'), false);
});

test('batchLine wraps the whole line once more so cmd /s strips only the outer pair', () => {
  const line = batchLine('C:\\Program Files\\t\\a.cmd', ['plain', 'two words']);
  assert.equal(line, '""C:\\Program Files\\t\\a.cmd" "plain" "two words""');
  const stripped = line.slice(1, -1);                     // cmd /s 가 벗기는 바깥 한 쌍
  assert.equal(stripped, '"C:\\Program Files\\t\\a.cmd" "plain" "two words"');
  assert.equal((stripped.match(/"/g) ?? []).length % 2, 0, '따옴표 상태가 균형이어야 한다');
  assert.equal(batchLine('a.cmd', []), '""a.cmd""');
});

test('quoteArg wraps the value untouched — batch %~1 strips only the outer pair', () => {
  assert.equal(quoteArg('two words'), '"two words"');
  assert.equal(quoteArg('say "hi"'), '"say "hi""');
  assert.equal(quoteArg('C:\\trailing\\'), '"C:\\trailing\\"');
  assert.equal(quoteArg(''), '""');
});

test('quoteArg refuses an odd number of quotes (cmd quote state would leak into redirection)', () => {
  assert.throws(() => quoteArg('odd"'), /홀수/);
  assert.throws(() => batchLine('a.cmd', ['ok', 'odd"']), /홀수/);
});

test('run() rejects such an argument without throwing or spawning anything', async () => {
  const r = await run('a.cmd', ['odd"'], { timeoutMs: 5000 });
  assert.equal(r.code, -1);
  assert.match(r.err, /홀수/);
  assert.equal(r.out, '');
});

test('run() executes a .cmd and passes arguments with spaces and quotes through', { skip: !WIN }, async () => {
  const exe = echoFixture('echo args.cmd');
  const args = ['plain', 'two words', 'say "hi"', 'a&b', 'a^b', 'C:\\path with space\\x', '--flag=v with space'];
  const r = await run(exe, args, { timeoutMs: 30000 });
  assert.equal(r.code, 0, `stderr=${r.err}`);
  assert.deepEqual(echoed(r), args);
});

test('run() reports a .cmd exit code and stderr unchanged', { skip: !WIN }, async () => {
  const exe = fixture('fail.cmd', '@echo off\r\necho boom 1>&2\r\nexit /b 7\r\n');
  const r = await run(exe, [], { timeoutMs: 30000 });
  assert.equal(r.code, 7);
  assert.equal(r.err, 'boom');
  assert.equal(r.out, '');
});

test('run() honours cwd and env for a .cmd', { skip: !WIN }, async () => {
  const exe = fixture('where.cmd', '@echo off\r\ncd\r\necho %IRIS_T18B%\r\n');
  const sub = path.join(scratch, 'sub dir');
  fs.mkdirSync(sub, { recursive: true });
  const r = await run(exe, [], { cwd: sub, env: { ...process.env, IRIS_T18B: 'ok' }, timeoutMs: 30000 });
  assert.equal(r.code, 0, `stderr=${r.err}`);
  assert.match(r.out, /sub dir/);
  assert.match(r.out, /\bok\b/);
});

test('run() feeds stdin to a .cmd when asked', { skip: !WIN }, async () => {
  const exe = fixture('read.cmd', '@echo off\r\nset /p L=\r\necho got:%L%\r\n');
  const r = await run(exe, [], { stdin: 'ignore', timeoutMs: 30000 });
  assert.equal(r.code, 0, `stderr=${r.err}`);   // stdin 옵션이 그대로 전달돼 멈추지 않는다
});

test('run() still spawns a non-batch executable directly (path unchanged)', async () => {
  const r = await run(process.execPath, ['-e', 'process.stdout.write("direct:" + process.argv[1])', 'two words'], { timeoutMs: 30000 });
  assert.equal(r.code, 0, `stderr=${r.err}`);
  assert.equal(r.out, 'direct:two words');
});

test('run() timeout kills only the process it spawned (parent survives)', async () => {
  const before = process.pid;
  const started = Date.now();
  const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 700 });
  assert.ok(Date.now() - started < 20000, 'timeout must fire');
  assert.notEqual(r.code, 0);
  assert.equal(process.pid, before);
});

test('run() timeout kills a hung .cmd (the cmd.exe it spawned, by PID)', { skip: !WIN }, async () => {
  const exe = fixture('hang.cmd', '@echo off\r\n:loop\r\ngoto loop\r\n');   // cmd.exe 자기 안에서 도는 고리 — 손자 프로세스 없음
  const started = Date.now();
  const r = await run(exe, [], { timeoutMs: 800 });
  assert.ok(Date.now() - started < 20000, `timeout must fire (${Date.now() - started}ms)`);
  assert.notEqual(r.code, 0);
});

test.after(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* 스크래치 정리 실패는 무시 */ } });
