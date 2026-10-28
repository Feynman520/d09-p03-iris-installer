// MCP 중계기 편입(설계-MCP중계기.md 9절): 설치기가 쓰는 안내원 항목·등록부가
// 파이썬 중계기(mcp-relay/)가 읽는 모양과 같은지, 실행기 kick 줄, 파이썬 단위 시험.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relaySpecs, writeRelayRegistry, relayStateDir, relayRegistryId, updateOwnedMcpTable, mcpTomlBlock } from '../installer/setup/adapters.mjs';
import { faceLauncherContent, MCP_RELAY_KICK } from '../installer/lib/handoff.mjs';
import { RELAY_PARTS } from '../installer/lib/update-plan.mjs';
import { UNPACK_ORDER, V2_LAYOUT } from '../installer/setup/unpack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
const PY = process.env.IRIS_TEST_PYTHON || 'python';
const hasPython = spawnSync(PY, ['--version'], { encoding: 'utf8' }).status === 0;

function fakeSoul() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-soul-'));
  const relayDir = path.join(root, '_agent', 'shared', 'tools', 'mcp-relay');
  const pyDir = path.join(root, '_agent', 'shared', 'tools', 'python');
  fs.mkdirSync(relayDir, { recursive: true });
  fs.mkdirSync(pyDir, { recursive: true });
  fs.writeFileSync(path.join(relayDir, 'relay.py'), '# stub\n');
  fs.writeFileSync(path.join(pyDir, 'python.exe'), '');
  return { root, ctx: { root, lock: LOCK } };
}

const SPECS = (root) => [
  { name: 'playwright', command: path.join(root, '_agent', 'shared', 'tools', 'playwright-mcp', 'playwright-mcp.cmd'), args: [], env: { A: '1' } },
  { name: 'self-improve', command: path.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe'), args: ['si.js'], env: {} },
  { name: 'pdf-automation', command: 'C:\\venv\\python.exe', args: ['C:\\srv\\pdf.py'], env: { PYTHONUTF8: '1' } },
];

test('잠금표·풀기·업데이트 계획에 mcp-relay 부품이 있다', () => {
  const p = LOCK.parts['mcp-relay'];
  assert.equal(p.kind, 'dir');
  assert.equal(p.source, './mcp-relay');
  assert.equal(p.dest, '_agent/shared/tools/mcp-relay');
  assert.ok(p.exclude.includes('tests'));
  assert.ok(UNPACK_ORDER.includes('mcp-relay'));
  assert.equal(V2_LAYOUT['mcp-relay'].mode, 'slot');
  assert.ok(RELAY_PARTS.includes('mcp-relay'));
});

test('실행기가 IRIS 시작 때 공용 중계기를 띄운다(창 없는 pythonw, 세션 가계도 밖)', () => {
  const text = faceLauncherContent();
  assert.ok(text.includes(MCP_RELAY_KICK));
  assert.match(MCP_RELAY_KICK, /start "" ".*pythonw\.exe" -I ".*mcp-relay\\relay\.py" daemon$/);
  // 숨김 경로·콘솔 경로 모두보다 먼저
  assert.ok(text.indexOf(MCP_RELAY_KICK) < text.indexOf('wscript.exe'));
});

test('relaySpecs: 로컬 MCP 는 안내원 항목, self-improve 는 직접, 등록부는 원래 명령', () => {
  const { root, ctx } = fakeSoul();
  try {
    const r = relaySpecs(ctx, SPECS(root), 'claude', { fs });
    const by = Object.fromEntries(r.specs.map((s) => [s.name, s]));
    assert.equal(by['self-improve'].relayed, undefined);
    assert.equal(by['pdf-automation'].relayed, true);
    assert.equal(by['pdf-automation'].command, path.join(root, '_agent', 'shared', 'tools', 'python', 'python.exe'));
    assert.deepEqual(by['pdf-automation'].args.slice(-3), ['shim', '--id', 'claude.global.pdf-automation']);
    assert.deepEqual(by['pdf-automation'].env, { PYTHONUTF8: '1' }); // env 는 클라이언트 설정에 그대로
    const reg = r.registry.find((x) => x.data.id === 'claude.global.pdf-automation').data;
    assert.deepEqual(reg.real, { command: 'C:\\venv\\python.exe', args: ['C:\\srv\\pdf.py'] });
    assert.equal(reg.owner, 'installer');
    assert.equal(reg.status, 'relayed');
    assert.equal(JSON.stringify(reg).includes('PYTHONUTF8'), false); // 등록부에 env 없음
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('relaySpecs: 부품이 없으면 직접 항목으로 후퇴, released 는 직접 유지, 사용자 인자는 실제 명령으로', () => {
  const { root, ctx } = fakeSoul();
  try {
    fs.rmSync(path.join(root, '_agent', 'shared', 'tools', 'mcp-relay'), { recursive: true });
    const none = relaySpecs(ctx, SPECS(root), 'codex', { fs });
    assert.equal(none.specs.some((s) => s.relayed), false);
    assert.equal(none.registry.length, 0);
    fs.mkdirSync(path.join(root, '_agent', 'shared', 'tools', 'mcp-relay'), { recursive: true });
    fs.writeFileSync(path.join(root, '_agent', 'shared', 'tools', 'mcp-relay', 'relay.py'), '# stub\n');
    writeRelayRegistry(root, [{ file: path.join(relayStateDir(root), 'registry', 'codex.global.pdf-automation.json'),
      data: { id: 'codex.global.pdf-automation', status: 'released', real: {}, original: {} } }], { fs });
    const r = relaySpecs(ctx, SPECS(root), 'codex', { fs, existingArgsFor: () => null });
    assert.equal(r.specs.find((s) => s.name === 'pdf-automation').relayed, undefined);
    const r2 = relaySpecs(ctx, SPECS(root), 'claude', { fs, existingArgsFor: (n) => (n === 'playwright' ? ['--browser', 'msedge'] : null) });
    const pw = r2.registry.find((x) => x.data.name === 'playwright').data;
    assert.deepEqual(pw.real.args, ['--browser', 'msedge']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('설치기가 쓴 등록부·안내원 항목을 파이썬 중계기가 "중계 중"으로 읽는다', { skip: !hasPython }, () => {
  const { root, ctx } = fakeSoul();
  try {
    const realRelay = path.join(REPO, 'mcp-relay', 'relay.py');
    const r = relaySpecs(ctx, SPECS(root), 'claude', { fs });
    writeRelayRegistry(root, r.registry, { fs });
    const claudeDir = path.join(root, '_agent', 'claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const servers = Object.fromEntries(r.specs.map((s) => [s.name, { type: 'stdio', command: s.command, args: s.args, env: s.env }]));
    fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: servers }, null, 2));
    const out = spawnSync(PY, ['-I', realRelay, '--state', relayStateDir(root), '--root', root, 'sync', '--json'], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const rows = JSON.parse(out.stdout);
    const row = (id) => rows.find((x) => x.id === id);
    assert.equal(row(relayRegistryId('claude', 'pdf-automation')).do, 'ok');
    assert.equal(row(relayRegistryId('claude', 'playwright')).do, 'ok');
    assert.equal(row('claude.global.self-improve').do, 'skip');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('업데이트: 명령이 venv 파이썬이고 server.py 가 args 에 있는 코덱스 블록도 설치기 것으로 보고 안내원으로 바꾼다', () => {
  const root = 'C:\\SoulX';
  const toml = [
    '[mcp_servers.pdf-automation]',
    'command = "C:\\\\SoulX\\\\_agent\\\\runtime\\\\venvs\\\\document-mcp\\\\Scripts\\\\python.exe"',
    'args = ["C:\\\\SoulX\\\\_agent\\\\shared\\\\tools\\\\document-mcp\\\\pdf\\\\b8acf47\\\\server.py"]',
    'startup_timeout_sec = 30',
    '',
    '[mcp_servers.pdf-automation.env]',
    'PYTHONUTF8 = "1"',
    '',
  ].join('\n');
  const block = mcpTomlBlock({ name: 'pdf-automation', command: 'C:\\SoulX\\_agent\\shared\\tools\\python\\python.exe',
    args: ['-I', 'C:\\SoulX\\_agent\\shared\\tools\\mcp-relay\\relay.py', 'shim', '--id', 'codex.global.pdf-automation'], env: {} });
  const out = updateOwnedMcpTable(toml, 'pdf-automation', block, root);
  assert.ok(out, '설치기 블록인데 갱신되지 않았다');
  assert.match(out, /args = \[.*"shim", "--id", "codex\.global\.pdf-automation"\]/);
  assert.match(out, /PYTHONUTF8 = "1"/); // 사용자 env 하위 테이블 보존
  // 사용자가 자기 위치로 바꿔 둔 블록(명령·인자 모두 우리 폴더 밖)은 그대로 둔다
  const userOwn = toml.replace(/C:\\\\SoulX\\\\_agent\\\\(runtime|shared\\\\tools)/g, 'D:\\\\mine');
  assert.equal(updateOwnedMcpTable(userOwn, 'pdf-automation', block, root), null);
});

test('파이썬 중계기 단위 시험(mcp-relay/tests) 통과', { skip: !hasPython, timeout: 300000 }, () => {
  const out = spawnSync(PY, ['-W', 'ignore', '-m', 'unittest', 'discover', '-s', path.join(REPO, 'mcp-relay', 'tests'), '-t', path.join(REPO, 'mcp-relay', 'tests')],
    { encoding: 'utf8', cwd: path.join(REPO, 'mcp-relay', 'tests'), timeout: 290000 });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`.slice(-3000));
});
