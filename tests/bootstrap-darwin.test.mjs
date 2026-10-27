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
