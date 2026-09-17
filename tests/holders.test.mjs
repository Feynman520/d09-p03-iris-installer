// lib/holders.mjs — 설치 폴더 `_agent\shared\tools\` 에서 도는 우리 프로그램 찾기·멈추기.
// 진짜 프로세스 목록은 보지 않는다(가짜 run 으로 PowerShell JSON 을 흉내 낸다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listHolders, stopHolders, holdersText, toolsDirOf } from '../installer/lib/holders.mjs';

const ROOT = 'C:\\IRIS-holders-test';
const TOOLS = toolsDirOf(ROOT);

function fakeRun(rows, calls = []) {
  return async (exe, args) => {
    calls.push([exe, ...args]);
    if (exe === 'powershell.exe') return { code: 0, out: JSON.stringify(rows), err: '' };
    if (exe === 'taskkill') return { code: 0, out: `성공: PID ${args[1]} 프로세스가 종료되었습니다.`, err: '' };
    return { code: 1, out: '', err: 'unexpected' };
  };
}

const ROWS = [
  { ProcessId: 4321, Name: 'node.exe', ExecutablePath: `${TOOLS}node\\node.exe`, CommandLine: `"${TOOLS}node\\node.exe" "${TOOLS}teamclaude-dash\\server.mjs"` },
  { ProcessId: 5555, Name: 'node.exe', ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\work\\my-own-server.js' },
  { ProcessId: 777, Name: 'python.exe', ExecutablePath: null, CommandLine: `${TOOLS}python\\python.exe ${TOOLS}document-mcp\\hwp\\825f8a1\\server.py` },
  { ProcessId: process.pid, Name: 'node.exe', ExecutablePath: `${TOOLS}node\\node.exe`, CommandLine: 'self' },
];

test('listHolders: 설치 폴더 tools 아래에서 도는 것만 고르고, 남의 node.exe 와 자기 자신은 뺀다', async () => {
  const found = await listHolders(ROOT, { run: fakeRun(ROWS) });
  assert.deepEqual(found.map((h) => h.pid), [4321, 777]);
  assert.equal(found[0].what, 'teamclaude-dash\\server.mjs', '명령줄에서 우리 폴더 뒤의 꼬리만 남긴다');
  assert.equal(found[1].what, 'document-mcp\\hwp\\825f8a1\\server.py', '마지막 것(돌리는 스크립트)이 "무엇인지"를 가장 잘 말한다');
  assert.match(holdersText(found), /node\.exe\(PID 4321, teamclaude-dash\\server\.mjs\)/);
});

test('listHolders: 목록을 못 얻으면(파워셸 실패·깨진 JSON) 빈 목록 — 설치를 막지 않는다', async () => {
  assert.deepEqual(await listHolders(ROOT, { run: async () => ({ code: 1, out: '', err: 'no' }) }), []);
  assert.deepEqual(await listHolders(ROOT, { run: async () => ({ code: 0, out: 'not json', err: '' }) }), []);
  assert.deepEqual(await listHolders(null, { run: fakeRun(ROWS) }), []);
});

test('listFileHolders: Restart Manager 스크립트의 JSON 을 읽고, splitHolders 가 우리 것/남의 것을 가른다', async () => {
  const { listFileHolders, splitHolders } = await import('../installer/lib/holders.mjs');
  const rows = [
    { pid: 9001, app: 'Windows Explorer', exe: 'C:\\Windows\\explorer.exe', name: 'explorer.exe' },
    { pid: 9002, app: 'Node.js', exe: `${TOOLS}node\\node.exe`, name: 'node.exe' },
    { pid: process.pid, app: 'self', exe: 'x', name: 'node.exe' },
  ];
  const calls = [];
  const run = async (exe, args) => { calls.push([exe, ...args]); return { code: 0, out: JSON.stringify(rows), err: '' }; };
  const found = await listFileHolders(`${TOOLS}teamclaude-dash`, { run, script: 'X:\\file-holders.ps1' });
  assert.deepEqual(found.map((h) => h.pid), [9001, 9002], '자기 자신은 뺀다');
  assert.ok(calls[0].includes('-File') && calls[0].includes('X:\\file-holders.ps1') && calls[0].includes('-Path'));
  const { ours, theirs } = splitHolders(ROOT, found);
  assert.deepEqual(ours.map((h) => h.pid), [9002], 'tools 아래 실행 파일만 우리 것');
  assert.deepEqual(theirs.map((h) => h.pid), [9001], '탐색기는 남의 것 — 닫지 않고 알려만 준다');
  assert.match(holdersText(theirs), /explorer\.exe\(PID 9001, Windows Explorer\)/);
  // 스크립트 실패·깨진 출력은 빈 목록.
  assert.deepEqual(await listFileHolders('X:\\dir', { run: async () => ({ code: 0, out: 'oops', err: '' }), script: 'X:\\s.ps1' }), []);
  assert.deepEqual(await listFileHolders('X:\\dir', { run: async () => ({ code: 1, out: '', err: 'no' }), script: 'X:\\s.ps1' }), []);
});

test('stopHolders: PID 하나씩 taskkill 하되, 지금도 tools 아래에서 도는 것만(다시 확인) 멈춘다', async () => {
  const calls = [];
  const run = fakeRun(ROWS, calls);
  const found = await listHolders(ROOT, { run });
  const results = await stopHolders(ROOT, [...found, { pid: 5555, name: 'node.exe' }], { run });
  const killed = calls.filter((c) => c[0] === 'taskkill').map((c) => c[2]);
  assert.deepEqual(killed, ['4321', '777'], '남의 5555 는 절대 죽이지 않는다');
  assert.ok(calls.filter((c) => c[0] === 'taskkill').every((c) => c.includes('/PID')), '이름이 아니라 PID 로만');
  assert.equal(results.find((r) => r.pid === 5555).stopped, false);
  assert.ok(results.filter((r) => r.stopped).length === 2);
});
