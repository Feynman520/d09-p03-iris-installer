import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  writeShims, shimsDir, posixAgentShim, posixRelayEnsureMjs, relayEnsureMjs,
} from '../installer/lib/shims.mjs';

// macOS 심(docs/설계-macOS.md D-M07). 글자 검사는 어느 PC 에서나, 실제 실행은 sh 가 있는 PC 에서.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-shims-darwin-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const POSIX = { platform: 'darwin' };
const noSh = process.platform === 'win32' && 'sh 로 심을 실제로 돌리는 시험은 Windows 에서 건너뛴다';

test('macOS 심 묶음: 이름·ASCII·LF·#!/bin/sh·실행 권한', () => {
  const root = path.join(tmp, 'names');
  const r = writeShims(root, ['claude', 'codex'], POSIX);
  const dir = shimsDir(root);
  assert.deepEqual(fs.readdirSync(dir).sort(),
    ['claude', 'codex', 'git', 'node', 'python', 'python3', 'relay-ensure', 'relay-ensure.mjs']);
  assert.equal(r.written.length, 8);
  for (const f of fs.readdirSync(dir)) {
    const buf = fs.readFileSync(path.join(dir, f));
    assert.ok(buf.every((b) => b < 0x80), `${f} 는 ASCII`);
    assert.ok(!buf.includes(0x0d), `${f} 에 CR 이 없다`);
    if (f.endsWith('.mjs')) continue;
    assert.ok(buf.toString('ascii').startsWith('#!/bin/sh\n'), f);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o755, `${f} 0755`);
  }
  // 구독을 안 고른 쪽은 심이 없다(Windows 와 같은 규칙)
  const only = path.join(tmp, 'only-codex');
  writeShims(only, ['codex'], POSIX);
  assert.ok(!fs.existsSync(path.join(shimsDir(only), 'claude')));
});

test('macOS 심: 두 번째 실행은 아무것도 바꾸지 않는다(내용·권한 모두)', () => {
  const root = path.join(tmp, 'rerun');
  writeShims(root, ['claude', 'codex'], POSIX);
  assert.deepEqual(writeShims(root, ['claude', 'codex'], POSIX).changed, []);
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(shimsDir(root), 'codex'), 0o644);
    assert.deepEqual(writeShims(root, ['claude', 'codex'], POSIX).changed, [path.join(shimsDir(root), 'codex')], '권한이 풀리면 되돌린다');
  }
});

test('에이전트 심 글자: 중계기 주소·설정 폴더·중계기 확인이 CLI 호출보다 앞', () => {
  const claude = posixAgentShim('claude');
  assert.match(claude, /export ANTHROPIC_BASE_URL="http:\/\/127\.0\.0\.1:3456"/);
  assert.match(claude, /export CLAUDE_CONFIG_DIR="\$A\/claude"/);
  assert.ok(claude.indexOf('relay-ensure') < claude.indexOf('tools/claude/claude'));
  const codex = posixAgentShim('codex');
  assert.match(codex, /export CODEX_HOME="\$A\/codex"/);
  assert.match(codex, /exec "\$A\/shared\/tools\/node\/bin\/node" "\$A\/shared\/tools\/codex\/node_modules\/@openai\/codex\/bin\/codex\.js" "\$@"/);
  assert.equal(/HTTPS_PROXY|SSL_CERT_FILE/.test(codex), false, '2.0.49 와 같이 코덱스 심에 가로채기 줄이 없다');
});

test('relay-ensure.mjs: macOS 판은 동봉 node 와 teamclaude-manage.mjs 를 쓰고, 나머지 약속은 Windows 판과 같다', () => {
  const mac = posixRelayEnsureMjs();
  assert.match(mac, /'tools', 'node', 'bin', 'node'/);
  assert.match(mac, /teamclaude-manage\.mjs/);
  assert.match(mac, /'teamclaude', 'node_modules', '@karpeleslab'/);
  assert.ok(!/powershell/i.test(mac));
  for (const same of ['IRIS_RELAY_PORT', 'IRIS_RELAY_WAIT_MS', 'IRIS_RELAY_MANAGE', 'TEAMCLAUDE_CONFIG', 'process.exit(0);']) {
    assert.ok(mac.includes(same) && relayEnsureMjs().includes(same), same);
  }
});

// 가짜 부품 나무: node 는 지금 이 node, claude 는 받은 환경을 찍는 sh, codex 는 같은 일을 하는 JS
// (심이 동봉 node 로 codex.js 를 부르므로).
function fakeTools(root) {
  const tools = path.join(root, '_agent', 'shared', 'tools');
  fs.mkdirSync(path.join(tools, 'node', 'bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(tools, 'node', 'bin', 'node'));
  const sh = '#!/bin/sh\necho "ARGS=$*"\necho "BASE=$ANTHROPIC_BASE_URL"\necho "CFG=$CLAUDE_CONFIG_DIR$CODEX_HOME"\necho "NODE=$(command -v node)"\n';
  const js = [
    "const e = process.env;",
    "console.log('ARGS=' + process.argv.slice(2).join(' '));",
    "console.log('BASE=' + e.ANTHROPIC_BASE_URL);",
    "console.log('CFG=' + (e.CLAUDE_CONFIG_DIR || '') + (e.CODEX_HOME || ''));",
    "console.log('NODE=' + e.PATH.split(':')[0] + '/node');",
    '',
  ].join('\n');
  for (const [rel, text] of [[['codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'], js], [['claude', 'claude'], sh]]) {
    const f = path.join(tools, ...rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text, { mode: 0o755 });
  }
  return tools;
}

test('macOS 심 실제 실행: 공백 있는 경로에서도 설정 폴더·node 를 정리된 절대 경로로 넘기고 인자를 그대로 전한다', { skip: noSh }, async () => {
  const root = path.join(tmp, 'run root with space');
  const tools = fakeTools(root);
  writeShims(root, ['claude', 'codex'], POSIX);
  // 살아 있는 포트를 주어 relay-ensure 가 기다리지 않게 한다
  const srv = net.createServer(() => {}); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const env = { ...process.env, IRIS_RELAY_PORT: String(srv.address().port), CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' };
  try {
    const codex = spawnSync(path.join(shimsDir(root), 'codex'), ['exec', 'hello world'], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(codex.status, 0, codex.stderr);
    assert.match(codex.stdout, /^ARGS=exec hello world$/m);
    assert.match(codex.stdout, /^BASE=http:\/\/127\.0\.0\.1:3456$/m);
    assert.ok(codex.stdout.includes(`CFG=${path.join(root, '_agent', 'codex')}\n`), codex.stdout);
    assert.ok(codex.stdout.includes(`NODE=${path.join(tools, 'node', 'bin', 'node')}\n`), codex.stdout);
    const claude = spawnSync(path.join(shimsDir(root), 'claude'), ['--version'], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(claude.status, 0, claude.stderr);
    assert.ok(claude.stdout.includes(`CFG=${path.join(root, '_agent', 'claude')}\n`), claude.stdout);
    assert.ok(claude.stdout.includes(`NODE=${path.join(tools, 'node', 'bin', 'node')}\n`), claude.stdout);
  } finally {
    srv.close();
  }
});

test('macOS git 심: 동봉 dugite git 에 GIT_EXEC_PATH·템플릿·시스템 설정을 건다(사용자 값은 존중)', { skip: noSh }, () => {
  const root = path.join(tmp, 'git-shim');
  const tools = fakeTools(root);
  const git = path.join(tools, 'git', 'bin', 'git');
  fs.mkdirSync(path.dirname(git), { recursive: true });
  fs.writeFileSync(git, '#!/bin/sh\necho "EXEC=$GIT_EXEC_PATH"\necho "TPL=$GIT_TEMPLATE_DIR"\necho "SYS=$GIT_CONFIG_SYSTEM"\necho "ARGS=$*"\n', { mode: 0o755 });
  writeShims(root, [], POSIX);
  const env = { ...process.env };
  delete env.GIT_CONFIG_SYSTEM;
  const r = spawnSync(path.join(shimsDir(root), 'git'), ['status', '-s'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const g = path.join(tools, 'git');
  assert.ok(r.stdout.includes(`EXEC=${g}/libexec/git-core\n`), r.stdout);
  assert.ok(r.stdout.includes(`TPL=${g}/share/git-core/templates\n`), r.stdout);
  assert.ok(r.stdout.includes(`SYS=${g}/etc/gitconfig\n`), r.stdout);
  assert.match(r.stdout, /^ARGS=status -s$/m);
  const mine = spawnSync(path.join(shimsDir(root), 'git'), [], { env: { ...env, GIT_CONFIG_SYSTEM: '/etc/mine' }, encoding: 'utf8' });
  assert.match(mine.stdout, /^SYS=\/etc\/mine$/m, '사용자가 정한 시스템 설정은 그대로');
});

test('macOS node 심: 동봉 node 를 부른다', { skip: noSh }, () => {
  const root = path.join(tmp, 'node-shim');
  fakeTools(root);
  writeShims(root, [], POSIX);
  const r = spawnSync(path.join(shimsDir(root), 'node'), ['-e', 'console.log(process.version)'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), process.version);
});

test('macOS relay-ensure: 관리 스크립트가 없으면 한 줄 알리고 0(막지 않음)', { skip: noSh }, async () => {
  const root = path.join(tmp, 'ensure');
  fakeTools(root);
  writeShims(root, [], POSIX);
  const dead = net.createServer(() => {}); await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port; await new Promise((r) => dead.close(r));
  const r = spawnSync(path.join(shimsDir(root), 'relay-ensure'), [], { env: { ...process.env, IRIS_RELAY_PORT: String(port) }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /relay helper missing/);
});
