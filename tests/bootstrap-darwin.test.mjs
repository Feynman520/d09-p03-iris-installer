import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBootstrapArgs, isOurServer } from '../installer/bootstrap.mjs';

// macOS 겉옷(docs/설계-macOS.md D-M04): IRIS-설치.command → bootstrap.sh → bootstrap.mjs.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMAND_PATH = path.join(ROOT_DIR, 'installer', 'IRIS-설치.command');
const SH_PATH = path.join(ROOT_DIR, 'installer', 'bootstrap.sh');

test('겉옷 sh 두 파일은 ASCII·LF 이고 #!/bin/sh 로 시작한다(파일 이름의 한글은 괜찮다)', () => {
  for (const file of [COMMAND_PATH, SH_PATH]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(text.match(/[^\x00-\x7F]/g), null, `${path.basename(file)} 에 ASCII 아닌 글자`);
    assert.ok(!text.includes('\r'), `${path.basename(file)} 에 CR — sh 는 CRLF 를 못 읽는다`);
    assert.ok(text.startsWith('#!/bin/sh\n'), path.basename(file));
  }
});

test('겉옷 sh 두 파일은 실행 권한이 있다(Finder 두 번 클릭·zip 속 모드 비트)', { skip: process.platform === 'win32' && 'Windows 파일 시스템에는 실행 비트가 없다' }, () => {
  for (const file of [COMMAND_PATH, SH_PATH]) {
    assert.ok((fs.statSync(file).mode & 0o111) !== 0, `${path.basename(file)} 실행 권한 없음`);
  }
});

test('bootstrap.sh 는 Windows 와 같은 종료 코드(10·11·12)를 쓰고 node 만 넘긴다', () => {
  const sh = fs.readFileSync(SH_PATH, 'utf8');
  for (const code of ['exit 10', 'exit 11', 'exit 12']) assert.ok(sh.includes(code), code);
  assert.match(sh, /installer\/bootstrap\.mjs/);
  assert.match(sh, /xattr -dr com\.apple\.quarantine/, '풀어 놓은 node 의 격리 표식을 지운다(D-M05)');
});

test('bootstrap.mjs 인자', () => {
  assert.deepEqual(
    parseBootstrapArgs(['--zip-root', '/z', '--port', '3471', '--node-dir', '/w/node', '--work-dir', '/w', '--auto', '--resume']),
    { port: 3471, auto: true, resume: true, zipRoot: '/z', nodeDir: '/w/node', workDir: '/w' },
  );
  assert.deepEqual(parseBootstrapArgs([]), { port: 3460, auto: false, resume: false });
});

test('isOurServer: 이 작업 폴더의 node 로 설치기 server.mjs 를 돌릴 때만 참', () => {
  const nodeBin = '/Users/u/Library/Application Support/IRIS-Installer/node/bin/node';
  const ours = `${nodeBin} /Users/u/Downloads/IRIS-Setup/installer/server.mjs --zip-root /Users/u/Downloads/IRIS-Setup --port 3460`;
  assert.equal(isOurServer(1, { nodeBin, readArgs: () => ours }), true);
  // 같은 node 로 다른 스크립트(중계기·IRIS 창)
  assert.equal(isOurServer(1, { nodeBin, readArgs: () => `${nodeBin} /x/teamclaude/src/index.js` }), false);
  // 다른 node 로 server.mjs
  assert.equal(isOurServer(1, { nodeBin, readArgs: () => '/opt/homebrew/bin/node /x/installer/server.mjs' }), false);
  // 명령줄을 못 읽음 = 모름 = 우리 것 아님
  assert.equal(isOurServer(1, { nodeBin, readArgs: () => { throw new Error('ps failed'); } }), false);
  assert.equal(isOurServer(1, { nodeBin, readArgs: () => '' }), false);
});

test('bootstrap.mjs 는 zip 에 실리는 lib 세 파일 밖의 것을 import 하지 않는다', () => {
  const text = fs.readFileSync(path.join(ROOT_DIR, 'installer', 'bootstrap.mjs'), 'utf8');
  const libImports = [...text.matchAll(/from '\.\.\/lib\/([^']+)'/g)].map((m) => m[1]);
  for (const f of libImports) assert.ok(['run.mjs', 'zip.mjs', 'net.mjs'].includes(f), `zip 에 없는 lib/${f}`);
});

test('verifyPayload: 지문이 맞으면 통과, 하나라도 다르면 그 파일을 알린다', async () => {
  const { verifyPayload } = await import('../installer/bootstrap.mjs');
  const crypto = await import('node:crypto');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-verify-payload-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.bin'), 'hello');
    const good = crypto.createHash('sha256').update('hello').digest('hex');
    assert.equal((await verifyPayload(dir, { parts: { a: { file: 'a.bin', sha256: good } } })).ok, true);
    const bad = await verifyPayload(dir, { parts: { a: { file: 'a.bin', sha256: 'x' }, b: { file: 'missing.bin', sha256: 'y' } } });
    assert.deepEqual(bad.mismatches.map((m) => m.file), ['a.bin', 'missing.bin']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('IRIS-설치.command: installer/ 안의 사본을 눌러도 한 단계 위를 zip 루트로 쓴다(2026-10-28 실제 사용에서)', { skip: process.platform === 'win32' && 'sh' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const zip = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-cmd-root-'));
  fs.mkdirSync(path.join(zip, 'installer'));
  // bootstrap.sh 자리에 받은 --zip-root 를 적고 끝나는 가짜를 둔다
  const stub = '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--zip-root" ]; then echo "ZIPROOT=$2"; fi; shift; done\n';
  fs.writeFileSync(path.join(zip, 'installer', 'bootstrap.sh'), stub, { mode: 0o755 });
  for (const at of [zip, path.join(zip, 'installer')]) fs.copyFileSync(COMMAND_PATH, path.join(at, 'IRIS-설치.command'));
  const real = fs.realpathSync(zip);
  for (const cmd of [path.join(zip, 'IRIS-설치.command'), path.join(zip, 'installer', 'IRIS-설치.command')]) {
    const r = spawnSync('/bin/sh', [cmd], { encoding: 'utf8', input: '\n' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`ZIPROOT=${real}\n`), `${path.relative(zip, cmd)} → ${r.stdout}`);
  }
});
