import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostTarget, soulRootFor, installerWorkDir, toolLayout, nodeBinIn, venvPython, shimFileName, pathDelimiter,
} from '../installer/lib/platform.mjs';

// 이 파일의 시험은 어느 PC 에서나 돈다 — platform 을 인자로 넘기므로
// Windows 판 결과를 Mac 에서, Mac 판 결과를 Windows 에서 잰다.

test('대상 이름: Windows x64 / Mac 은 늘 arm64', () => {
  assert.equal(hostTarget({ platform: 'win32', arch: 'x64' }), 'win32-x64');
  assert.equal(hostTarget({ platform: 'darwin', arch: 'arm64' }), 'darwin-arm64');
  assert.equal(hostTarget({ platform: 'darwin', arch: 'x64' }), 'darwin-arm64', 'Rosetta 아래 node 도 Apple Silicon');
});

test('영혼 폴더: Windows = C:\\<이름>, Mac = ~/<이름>', () => {
  assert.equal(soulRootFor('IRIS', { platform: 'win32' }), 'C:\\IRIS');
  assert.equal(soulRootFor('IRIS', { platform: 'darwin', homedir: '/Users/a b' }), '/Users/a b/IRIS');
});

test('설치기 작업 폴더: Windows 는 예전과 같고 Mac 은 Application Support', () => {
  assert.equal(installerWorkDir({ platform: 'win32', env: { LOCALAPPDATA: 'D:\\Profile\\AppData\\Local' } }),
    'D:\\Profile\\AppData\\Local\\IRIS-Installer');
  assert.equal(installerWorkDir({ platform: 'win32', env: {}, tmpdir: 'C:\\Temp' }), 'C:\\Temp\\IRIS-Installer');
  assert.equal(installerWorkDir({ platform: 'darwin', homedir: '/Users/u' }),
    '/Users/u/Library/Application Support/IRIS-Installer');
});

test('부품 실행 파일 자리: 설계-macOS 2절 표와 같다', () => {
  const w = toolLayout('C:\\SOUL\\_agent\\shared\\tools', { platform: 'win32' });
  assert.equal(w.node, 'C:\\SOUL\\_agent\\shared\\tools\\node\\node.exe');
  assert.equal(w.python, 'C:\\SOUL\\_agent\\shared\\tools\\python\\python.exe');
  assert.equal(w.git, 'C:\\SOUL\\_agent\\shared\\tools\\git\\cmd\\git.exe');
  assert.equal(w.codex, 'C:\\SOUL\\_agent\\shared\\tools\\codex\\codex.cmd');
  assert.deepEqual(w.binDirs, [
    'C:\\SOUL\\_agent\\shared\\tools\\node',
    'C:\\SOUL\\_agent\\shared\\tools\\git\\cmd',
    'C:\\SOUL\\_agent\\shared\\tools\\python',
  ]);

  const m = toolLayout('/Users/u/IRIS/_agent/shared/tools', { platform: 'darwin' });
  assert.equal(m.node, '/Users/u/IRIS/_agent/shared/tools/node/bin/node');
  assert.equal(m.python, '/Users/u/IRIS/_agent/shared/tools/python/bin/python3');
  assert.equal(m.git, '/Users/u/IRIS/_agent/shared/tools/git/bin/git');
  assert.equal(m.codex, '/Users/u/IRIS/_agent/shared/tools/codex/node_modules/@openai/codex/bin/codex.js');
  assert.equal(m.claude, '/Users/u/IRIS/_agent/shared/tools/claude/claude');
  assert.deepEqual(m.binDirs, [
    '/Users/u/IRIS/_agent/shared/tools/node/bin',
    '/Users/u/IRIS/_agent/shared/tools/python/bin',
  ], 'git/bin 은 넣지 않는다 — git 은 늘 심을 거친다');
});

test('node·venv·심 이름·PATH 구분자', () => {
  assert.equal(nodeBinIn('C:\\w\\node', { platform: 'win32' }), 'C:\\w\\node\\node.exe');
  assert.equal(nodeBinIn('/w/node', { platform: 'darwin' }), '/w/node/bin/node');
  assert.equal(venvPython('C:\\v', { platform: 'win32' }), 'C:\\v\\Scripts\\python.exe');
  assert.equal(venvPython('/v', { platform: 'darwin' }), '/v/bin/python');
  assert.equal(shimFileName('claude', { platform: 'win32' }), 'claude.cmd');
  assert.equal(shimFileName('claude', { platform: 'darwin' }), 'claude');
  assert.equal(pathDelimiter('win32'), ';');
  assert.equal(pathDelimiter('darwin'), ':');
});
