import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseManageArgs, parseLsofPids, isOwnedCommand, manage } from '../patches/teamclaude/teamclaude-manage.mjs';

// macOS 중계기 관리 스크립트(D-M14). PowerShell 판과 같은 약속: 증명된 PID 하나만 멈춘다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-manage-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function home(name, port = 3456) {
  const h = path.join(tmp, name);
  fs.mkdirSync(path.join(h, '.config'), { recursive: true });
  const cfg = path.join(h, 'teamclaude.json');
  fs.writeFileSync(cfg, JSON.stringify({ proxy: { port }, accounts: [] }));
  return { home: h, env: { TEAMCLAUDE_CONFIG: cfg } };
}
const NODE = '/x/IRIS/_agent/shared/tools/node/bin/node';
const ENTRY = '/x/IRIS/_agent/shared/tools/teamclaude/node_modules/@karpeleslab/teamclaude/src/index.js';

test('인자: 새 철자와 .ps1 철자를 둘 다 받는다', () => {
  assert.deepEqual(parseManageArgs(['start', '--node', NODE, '--entry', ENTRY]), { action: 'start', nodePath: NODE, entryPath: ENTRY });
  assert.deepEqual(parseManageArgs(['-Action', 'stop', '-NodePath', NODE, '-EntryPath', ENTRY]), { action: 'stop', nodePath: NODE, entryPath: ENTRY });
  assert.equal(parseManageArgs([]).action, 'status');
  assert.throws(() => parseManageArgs(['kill-all']), /unknown action/);
});

test('lsof 출력에서 PID 를 뽑고, 명령줄로 주인을 증명한다', () => {
  assert.deepEqual(parseLsofPids('p123\nf20\np123\np456\n'), [123, 456]);
  assert.deepEqual(parseLsofPids(''), []);
  assert.equal(isOwnedCommand(`${NODE} ${ENTRY} server --headless`, { nodePath: NODE, entryPath: ENTRY }), true);
  assert.equal(isOwnedCommand(`/opt/homebrew/bin/node ${ENTRY} server`, { nodePath: NODE, entryPath: ENTRY }), false, '다른 node');
  assert.equal(isOwnedCommand(`${NODE} /x/other.js`, { nodePath: NODE, entryPath: ENTRY }), false, '다른 스크립트');
  assert.equal(isOwnedCommand('', { nodePath: NODE, entryPath: ENTRY }), false);
});

test('status: 듣는 프로세스가 없으면 "stopped"', async () => {
  const h = home('status');
  const lines = [];
  const code = await manage({ action: 'status', nodePath: NODE, entryPath: ENTRY, ...h, probe: () => [], log: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.deepEqual(lines, ['TeamClaude is stopped.']);
});

test('3456 을 남의 프로그램이 잡고 있으면 아무것도 멈추지 않고 거절한다', async () => {
  const h = home('foreign');
  await assert.rejects(
    manage({ action: 'restart', nodePath: NODE, entryPath: ENTRY, ...h, probe: () => [999999], argsOf: () => '/usr/bin/python3 -m http.server 3456' }),
    /not owned by the expected TeamClaude program/,
  );
  await assert.rejects(
    manage({ action: 'stop', nodePath: NODE, entryPath: ENTRY, ...h, probe: () => [1, 2] }),
    /More than one listener owner/,
  );
});

test('3456 이 아닌 설정은 다루지 않는다', async () => {
  const h = home('otherport', 4000);
  await assert.rejects(manage({ action: 'status', nodePath: NODE, entryPath: ENTRY, ...h, probe: () => [] }), /only the TeamClaude proxy on port 3456/);
});

test('start: 이미 우리 중계기가 떠 있으면 그대로 둔다', async () => {
  const h = home('running');
  const lines = [];
  const code = await manage({
    action: 'start', nodePath: NODE, entryPath: ENTRY, ...h,
    probe: () => [4242], argsOf: () => `${NODE} ${ENTRY} server --headless`, log: (l) => lines.push(l),
  });
  assert.equal(code, 0);
  assert.match(lines[0], /already running \(PID 4242, port 3456\)/);
});

test('start: 진입 파일을 동봉 node 로 떼어 띄우고, 그 PID 가 응답할 때 끝난다', { skip: process.platform === 'win32' && 'POSIX 프로세스' }, async () => {
  const h = home('start');
  // 가짜 TeamClaude: 진입 파일이 "server" 를 받으면 임의 포트에서 /teamclaude/status 를 낸다.
  const entry = path.join(tmp, 'fake-teamclaude.mjs');
  const portFile = path.join(tmp, 'fake-port');
  fs.writeFileSync(entry, [
    "import http from 'node:http'; import fs from 'node:fs';",
    "const s = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ accounts: [{ name: 'a' }] })); });",
    `s.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(portFile)}, String(s.address().port)));`,
    'setTimeout(() => process.exit(0), 15000);',
  ].join('\n'));
  let childPid = null;
  const lines = [];
  const code = await manage({
    action: 'start', nodePath: process.execPath, entryPath: entry, ...h,
    // 처음엔 아무도 안 듣고, 띄운 뒤에는 그 자식이 듣는 것으로 보인다.
    probe: () => (childPid ? [childPid] : []),
    argsOf: (pid) => `${process.execPath} ${entry} server --headless`,
    fetchFn: async (url, opts) => {
      if (!fs.existsSync(portFile)) throw new Error('not yet');
      const runtime = JSON.parse(fs.readFileSync(path.join(h.home, 'teamclaude.server.json'), 'utf8'));
      childPid = runtime.pid;
      return fetch(url.replace(':3456/', `:${fs.readFileSync(portFile, 'utf8')}/`), opts);
    },
    log: (l) => lines.push(l),
  });
  assert.equal(code, 0);
  assert.match(lines.at(-1), /^TeamClaude started \(PID \d+, port 3456, 1 accounts\)\.$/);
  const runtime = JSON.parse(fs.readFileSync(path.join(h.home, 'teamclaude.server.json'), 'utf8'));
  assert.equal(runtime.managedBy, 'teamclaude-manage.mjs');
  assert.ok(!fs.existsSync(path.join(h.home, '.config', 'teamclaude.server.json')), '기록은 설정 파일 옆에 둔다(홈의 .config 아님)');
  try { process.kill(runtime.pid, 'SIGTERM'); } catch { /* 이미 끝남 */ }
});
