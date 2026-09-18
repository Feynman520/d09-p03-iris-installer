// T18 ⑤-9 검사 — 9항목 + 인계 2항목, 그리고 "실패해도 먼저 파일을 쓴다"
//
// 각 검사는 따로 부를 수 있게 export 되어 있다. 여기서는 그 하나하나에
// 통과·대기·실패 세 상황을 만들어 준다(실행 파일·MCP 서버는 가짜로).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  run as runChecksStage, runChecks, checkExe, checkMcp, checkPlugins, checkHooks,
  checkConfig, checkDesktop, checkOntology, checkReceiptIdempotent, checkEdge,
  checkSkeleton, checkStructure, checkRelayRoute, checkRelayCodex, tomlSanity, mcpInitialize, collectMcpServers,
  scanCardIds, recordedPaths, resolveExe, installStartedAt, batchWrap,
} from '../installer/setup/checks.mjs';
import { writeReceipt, newReceiptV2 } from '../installer/lib/receipt.mjs';
import { CODEX_PROXY_LINES } from '../installer/lib/shims.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 't18c-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
function newRoot(label) {
  const root = path.join(tmp, `${label}-${seq += 1}`);
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  return root;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2), 'utf8');
  return file;
}

function ctxFor(root, extra = {}) {
  return {
    root,
    fs,
    env: { PATH: 'C:\\windows' },
    log: () => {},
    precheck: { recorded: { edge: { present: true }, office: true, hancom: true } },
    receipt: { schema: 2, setup: {}, online: {} },
    choice: { subscriptions: ['claude'], leadAgent: 'claude' },
    manifest: { package: { name: 'IRIS', version: '2.0.0' } },
    run: async () => ({ code: 0, out: 'v1.0.0', err: '' }),
    // 검사 12 는 중계기(127.0.0.1:3456)에 실제 요청을 보내므로 시험에서는 항상 막아 둔다
    // (이 개발 PC 의 진짜 중계기·계정에 닿으면 안 된다).
    fetch: async () => { throw new Error('offline (test)'); },
    readUserEnv: async () => ({ exists: false, type: null, value: null }),
    ...extra,
  };
}

// 검사 12 의 배선 4곳 중 파일 셋(심·소환하기·영수증 env)을 통과 상태로 놓는다.
function wireRelay(root, receipt) {
  const line = 'set "ANTHROPIC_BASE_URL=http://127.0.0.1:3456"';
  write(path.join(root, '_agent', 'shared', 'shims', 'claude.cmd'), `@echo off\r\n${line}\r\n`);
  write(path.join(root, '소환하기.cmd'), `@echo off\r\n${line}\r\n`);
  if (receipt) receipt.env = { ...(receipt.env ?? {}), ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456', applied: false };
}

// 중계기 흉내: /teamclaude/status 는 계정 목록, /v1/messages 는 지정한 응답.
function fakeRelay({ accounts = [], probe = { status: 200, body: { id: 'msg_1' } } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).endsWith('/teamclaude/status')) {
      return { ok: true, status: 200, json: async () => ({ accounts }), text: async () => '' };
    }
    const body = JSON.stringify(probe.body ?? {});
    return { ok: probe.status >= 200 && probe.status < 300, status: probe.status, json: async () => JSON.parse(body), text: async () => body };
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// 1. 실행 파일
// ---------------------------------------------------------------------------

test('검사1: 네 실행 파일이 모두 버전을 말하면 통과', async () => {
  const root = newRoot('exe-ok');
  const asked = [];
  const c = await checkExe(ctxFor(root, {
    run: async (exe, args) => { asked.push([path.basename(exe), args[args.length - 1]]); return { code: 0, out: 'v24.17.0', err: '' }; },
  }));
  assert.equal(c.status, 'pass');
  assert.equal(asked.length, 4);
  assert.deepEqual(asked.map((a) => a[0]), ['node', 'python', 'git', 'codex']);
  assert.ok(asked.every((a) => a[1] === '--version'));
});

test('검사1: 하나라도 실행되지 않으면 실패(막음)', async () => {
  const root = newRoot('exe-bad');
  const c = await checkExe(ctxFor(root, {
    run: async (exe) => (/codex/.test(exe) ? { code: 9009, out: '', err: 'not found' } : { code: 0, out: 'ok', err: '' }),
  }));
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /codex 실행 실패/);
});

test('검사1: 심이 있으면 심을 부른다(사용자가 실제로 쓰는 입구)', () => {
  const root = newRoot('exe-shim');
  write(path.join(root, '_agent', 'shared', 'shims', 'python.cmd'), '@echo off');
  const r = resolveExe(ctxFor(root), 'python');
  assert.equal(r.via, 'shim');
  assert.ok(r.path.endsWith('shims\\python.cmd'));
});

// ---------------------------------------------------------------------------
// 2. MCP initialize
// ---------------------------------------------------------------------------

// 가짜 stdio 서버. `reply` 로 세 가지 성격을 만든다:
//   'result' 정상 응답 · 'error' 거절 · 'silent' 무응답(시간 초과) · 'close' 즉사
function fakeSpawn({ reply = 'result', killed = [] } = {}) {
  return (command, args) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => killed.push(command);
    child.stdin = {
      write: (line) => {
        const req = JSON.parse(line);
        setImmediate(() => {
          if (reply === 'result') {
            child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: path.basename(command) } } })}\n`);
          } else if (reply === 'error') {
            child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { message: '거절' } })}\n`);
          } else if (reply === 'close') {
            child.stderr.emit('data', 'ModuleNotFoundError');
            child.emit('close', 1);
          }
        });
      },
    };
    return child;
  };
}

function withServers(root, servers) {
  write(path.join(root, '_agent', 'claude', '.claude.json'), { mcpServers: servers });
  return root;
}

test('검사2: 등록된 서버가 전부 initialize 에 답하면 통과하고, 띄운 자식은 종료한다', async () => {
  const root = withServers(newRoot('mcp-ok'), {
    playwright: { command: 'C:\\t\\playwright.cmd', args: [] },
    'pdf-automation': { command: 'C:\\t\\python.exe', args: ['server.py'] },
  });
  const killed = [];
  const c = await checkMcp(ctxFor(root), { spawn: fakeSpawn({ killed }) });
  assert.equal(c.status, 'pass');
  assert.equal(c.results.length, 2);
  assert.equal(killed.length, 2, '띄운 것은 전부 내가 정리한다');
  assert.match(c.detail, /실제 화면 열기는 하지 않습니다/);
});

test('검사2: 서버 하나가 답하지 않으면 실패', async () => {
  const root = withServers(newRoot('mcp-bad'), { playwright: { command: 'C:\\t\\playwright.cmd' } });
  const c = await checkMcp(ctxFor(root), { spawn: fakeSpawn({ reply: 'silent' }), timeoutMs: 40 });
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /playwright/);
});

// 2026-09-17 VM S01 6차 실측: 한컴 없는 손님에서 hwp 서버가 initialize 에 **답했는데도** 사람에게는
// "한컴을 깔면 쓴다"가 맞는 말이다. 답을 했든 못 했든 프로그램이 없으면 pending.
test('검사2: 문서 MCP 가 initialize 에 답해도 그 프로그램이 없으면 pass 가 아니라 pending', async () => {
  const root = withServers(newRoot('mcp-doc-answers'), {
    'hwp-automation': { command: 'C:\\t\\python.exe', args: ['server.py'] },
    'pdf-automation': { command: 'C:\\t\\python.exe', args: ['server.py'] },
  });
  const ctx = ctxFor(root, { precheck: { recorded: { edge: { present: true }, office: false, hancom: false } } });
  const c = await checkMcp(ctx, { spawn: fakeSpawn({}) });
  assert.equal(c.status, 'pending');
  const hwp = c.results.find((r) => r.name.endsWith('hwp-automation'));
  assert.equal(hwp.status, 'pending');
  const pdf = c.results.find((r) => r.name.endsWith('pdf-automation'));
  assert.equal(pdf.status, 'pass', 'pdf 는 프로그램이 필요 없으니 답하면 pass');
});

test('검사2: 문서 MCP 는 오피스·한컴이 없으면 실패가 아니라 대기', async () => {
  const root = withServers(newRoot('mcp-doc'), {
    'hwp-automation': { command: 'C:\\t\\python.exe', args: ['server.py'] },
    'excel-automation': { command: 'C:\\t\\python.exe', args: ['server.py'] },
  });
  const ctx = ctxFor(root, { precheck: { recorded: { edge: { present: true }, office: false, hancom: false } } });
  const c = await checkMcp(ctx, { spawn: fakeSpawn({ reply: 'close' }) });
  assert.equal(c.status, 'pending');
  assert.equal(c.results.filter((r) => r.status === 'pending').length, 2);
  assert.match(c.detail, /한컴오피스\(한글\)가 없어 대기/);
});

test('검사2: 클로드 명시 등록이 6개가 아니면 그 사실을 적어 둔다', async () => {
  const root = withServers(newRoot('mcp-count'), { playwright: { command: 'x.cmd' } });
  const c = await checkMcp(ctxFor(root), { spawn: fakeSpawn() });
  assert.match(c.detail, /클로드 명시 등록 1개 — 기대값 6개/);
});

test('검사2: 플러그인이 스스로 띄우는 MCP 도 목록에 들어온다', () => {
  const root = newRoot('mcp-plugin');
  const pdir = path.join(root, '_agent', 'claude', 'plugins', 'cache', 'iris-local', 'self-improve', '0.2.0');
  write(path.join(pdir, '.mcp.json'), { mcpServers: { 'self-improve': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server/index.js'] } } });
  write(path.join(root, '_agent', 'claude', 'plugins', 'installed_plugins.json'), {
    version: 2, plugins: { 'self-improve@iris-local': [{ installPath: pdir, version: '0.2.0' }] },
  });
  const found = collectMcpServers(ctxFor(root));
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'plugin:self-improve:self-improve');
  // ${CLAUDE_PLUGIN_ROOT} 는 글자 그대로 펴진다(클로드가 하는 것과 같게).
  assert.equal(found[0].args[0], `${pdir}/server/index.js`);
});

test('mcpInitialize: 실행 명령이 없으면 띄우지 않는다', async () => {
  const r = await mcpInitialize({ name: 'x' }, { spawn: () => { throw new Error('띄우면 안 된다'); } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-command');
});

// ---------------------------------------------------------------------------
// 3. 플러그인
// ---------------------------------------------------------------------------

test('검사3: 표지 파일 또는 스킬 파일이 있으면 통과, 폴더가 없으면 실패', () => {
  const root = newRoot('plugins');
  const good = path.join(root, 'cache', 'superpowers');
  write(path.join(good, '.claude-plugin', 'plugin.json'), { name: 'superpowers' });
  const skillOnly = path.join(root, 'cache', 'skills-only');
  write(path.join(skillOnly, 'brainstorming', 'SKILL.md'), '# skill');
  write(path.join(root, '_agent', 'claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'superpowers@iris-local': [{ installPath: good }],
      'skills-only@iris-local': [{ installPath: skillOnly }],
    },
  });
  assert.equal(checkPlugins(ctxFor(root)).status, 'pass');

  write(path.join(root, '_agent', 'claude', 'plugins', 'installed_plugins.json'), {
    version: 2, plugins: { 'gone@iris-local': [{ installPath: path.join(root, 'cache', 'gone') }] },
  });
  const bad = checkPlugins(ctxFor(root));
  assert.equal(bad.status, 'fail');
  assert.match(bad.detail, /설치 폴더가 없습니다/);
});

// ---------------------------------------------------------------------------
// 4. 훅 문법
// ---------------------------------------------------------------------------

test('검사4: 훅 스크립트 3개를 각각 파워셸 파서·py_compile 로 본다', async () => {
  const root = newRoot('hooks');
  write(path.join(root, '_agent', 'claude', 'scripts', 'block-blanket-kill.ps1'), '# ps');
  write(path.join(root, '_agent', 'claude', 'scripts', 'guard-iris-path.py'), '# py');
  write(path.join(root, '_ontology', 'check_fresh.py'), '# py');
  const calls = [];
  const c = await checkHooks(ctxFor(root, {
    run: async (exe, args) => { calls.push({ exe: path.basename(exe), args }); return { code: 0, out: '', err: '' }; },
  }));
  assert.equal(c.status, 'pass');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].exe, 'powershell');
  assert.match(calls[0].args[2], /Parser\]::ParseFile/);
  assert.deepEqual(calls[1].args.slice(-3, -1), ['-m', 'py_compile']);
});

test('배치 파일(.cmd 심)은 cmd.exe 를 거쳐 띄운다(윈도 Node 의 spawn EINVAL 회피)', async () => {
  const root = newRoot('batch');
  write(path.join(root, '_agent', 'shared', 'shims', 'python.cmd'), '@echo off');
  const calls = [];
  await checkExe(ctxFor(root, {
    run: async (exe, args) => { calls.push({ exe, args }); return { code: 0, out: 'ok', err: '' }; },
  }));
  const py = calls.find((c) => c.args.some((a) => String(a).endsWith('python.cmd')));
  assert.equal(path.basename(py.exe), 'cmd.exe');
  assert.deepEqual(py.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(py.args[py.args.length - 1], '--version');
  assert.deepEqual(batchWrap('C:\\t\\git.exe', ['--version']), { exe: 'C:\\t\\git.exe', args: ['--version'] });
});

test('검사4: 문법이 깨졌거나 파일이 없으면 실패', async () => {
  const root = newRoot('hooks-bad');
  write(path.join(root, '_agent', 'claude', 'scripts', 'block-blanket-kill.ps1'), '# ps');
  const c = await checkHooks(ctxFor(root, { run: async () => ({ code: 1, out: 'Missing }', err: '' }) }));
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /guard-iris-path\.py\(파일이 없습니다\)/);
});

// ---------------------------------------------------------------------------
// 5. 설정 파일
// ---------------------------------------------------------------------------

test('tomlSanity: 표 머리가 깨졌거나 같은 표가 두 번이면 잡는다', () => {
  assert.equal(tomlSanity('[mcp_servers.hwp]\ncommand = "x"\n').ok, true);
  assert.equal(tomlSanity('[mcp_servers.hwp\ncommand = "x"\n').ok, false);
  const dup = tomlSanity('[mcp_servers.x]\na = 1\n[mcp_servers.x]\nb = 2\n');
  assert.equal(dup.ok, false);
  assert.match(dup.problems[0], /두 번 있습니다/);
  // 배열 표는 여러 번 나와도 정상이고, 여러 줄 문자열 안의 대괄호는 무시한다.
  assert.equal(tomlSanity('[[hooks]]\na=1\n[[hooks]]\nb=2\n').ok, true);
  assert.equal(tomlSanity('text = """\n[not a table\n"""\n').ok, true);
});

test('검사5: 설정 3종이 파싱되면 통과, 깨지면 실패', () => {
  const root = newRoot('config');
  write(path.join(root, '_agent', 'claude', 'settings.json'), { permissions: {} });
  write(path.join(root, '_agent', 'claude', '.claude.json'), { mcpServers: {} });
  write(path.join(root, '_agent', 'codex', 'config.toml'), '[mcp_servers.pdf]\ncommand = "python"\n');
  assert.equal(checkConfig(ctxFor(root)).status, 'pass');

  write(path.join(root, '_agent', 'claude', 'settings.json'), '{ broken');
  const bad = checkConfig(ctxFor(root));
  assert.equal(bad.status, 'fail');
  assert.match(bad.detail, /settings\.json/);
});

// ---------------------------------------------------------------------------
// 6. 바탕화면·루트 밖
// ---------------------------------------------------------------------------

test('검사6: 바탕화면에서 허용된 바로가기 하나는 세지 않는다', async () => {
  const root = newRoot('desktop-ok');
  const desktop = path.join(tmp, `desk-${seq}`);
  fs.mkdirSync(desktop, { recursive: true });
  write(path.join(desktop, 'IRIS.lnk'), 'shortcut');
  write(path.join(desktop, '내 문서.txt'), 'old');
  fs.utimesSync(path.join(desktop, '내 문서.txt'), new Date('2020-01-01'), new Date('2020-01-01'));

  const ctx = ctxFor(root, {
    desktopDir: desktop,
    receipt: { schema: 2, setup: { unpack: { startedAt: new Date(Date.now() - 60000).toISOString() } } },
  });
  const c = await checkDesktop(ctx);
  assert.equal(c.status, 'pass');
  assert.equal(c.strays.length, 0);
});

test('검사6: 설치 뒤 생긴 다른 파일은 실패로 잡는다', async () => {
  const root = newRoot('desktop-bad');
  const desktop = path.join(tmp, `desk-bad-${seq}`);
  fs.mkdirSync(desktop, { recursive: true });
  write(path.join(desktop, 'IRIS.lnk'), 'shortcut');
  write(path.join(desktop, '설치기가 흘린 파일.txt'), 'oops');

  const ctx = ctxFor(root, {
    desktopDir: desktop,
    receipt: { schema: 2, setup: { unpack: { startedAt: new Date(Date.now() - 60000).toISOString() } } },
  });
  const c = await checkDesktop(ctx);
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.strays.map((s) => s.name), ['설치기가 흘린 파일.txt']);
});

test('검사6: 동기화 클라이언트 임시 파일(.tmp.driveupload 등)은 새 항목으로 세지 않는다', async () => {
  // 2026-09-18 실사용: 바탕화면이 Google Drive 동기화 폴더인 PC 에서 IRIS.lnk 를 올리는 동안
  // `.tmp.driveupload` 가 생겨 검사 6 이 실패 → 설치가 "setup-incomplete" 로 멈췄다.
  const root = newRoot('desktop-sync');
  const desktop = path.join(tmp, `desk-sync-${seq}`);
  fs.mkdirSync(desktop, { recursive: true });
  write(path.join(desktop, 'IRIS.lnk'), 'shortcut');
  write(path.join(desktop, '.tmp.driveupload'), '');
  write(path.join(desktop, '~$보고서.docx'), 'lock');
  write(path.join(desktop, 'Thumbs.db'), 'cache');
  write(path.join(desktop, '설치기가 흘린 파일.txt'), 'oops');

  const ctx = ctxFor(root, {
    desktopDir: desktop,
    receipt: { schema: 2, setup: { unpack: { startedAt: new Date(Date.now() - 60000).toISOString() } } },
  });
  const c = await checkDesktop(ctx);
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.strays.map((s) => s.name), ['설치기가 흘린 파일.txt'], '동기화 임시 파일 셋은 빠지고 진짜 흘린 파일만 남는다');
});

test('검사6: 단계 기록에 루트 밖 경로가 있으면 실패', async () => {
  const root = newRoot('outside');
  const ctx = ctxFor(root, {
    desktopDir: null,
    receipt: {
      schema: 2,
      setup: {
        skeleton: { startedAt: new Date().toISOString(), recorded: { files: { created: ['_agent\\setup\\x.json'] } } },
        // 정화 규칙(사용자 프로필 경로 금지)에 이 시험 파일 자체가 걸리지 않도록
        // 가짜 경로는 조각으로 지어 쓴다.
        relay: { recorded: { files: { created: [['C:', 'Users', '다른사람', 'Desktop', 'IRIS.lnk'].join('\\')] } } },
      },
    },
  });
  const c = await checkDesktop(ctx);
  assert.equal(c.status, 'fail');
  assert.equal(c.outside.length, 1);
  assert.equal(c.outside[0].stage, 'relay');
});

// 2026-09-17 VM S06 실측: relay 가 기록한 이 사용자 바탕화면의 IRIS.lnk(허용 파일)가
// "IRIS 폴더 밖 쓰기 2건"으로 잡혀 검사 6이 실패했다. 이 사용자 바탕화면의 허용 파일은 정상.
test('검사6: 이 사용자 바탕화면의 허용 바로가기(IRIS.lnk)는 루트 밖 쓰기가 아니고, 두 번 기록돼도 한 건', async () => {
  const root = newRoot('own-desktop-lnk');
  const desktop = path.join(tmp, `desk-${seq}`);
  fs.mkdirSync(desktop, { recursive: true });
  const lnk = path.join(desktop, 'IRIS.lnk');
  const ctx = ctxFor(root, {
    desktopDir: desktop,
    receipt: {
      schema: 2,
      setup: {
        relay: { startedAt: new Date().toISOString(), recorded: { files: { created: [lnk, lnk] } } },
      },
    },
  });
  const c = await checkDesktop(ctx);
  assert.equal(c.status, 'pass', `허용 바로가기는 정상이어야 한다: ${c.detail}`);
  assert.equal(c.outside.length, 0);
});

test('검사6: 꾸러미(zip) 안 원본 경로는 "루트 밖 쓰기"로 세지 않는다', async () => {
  const root = newRoot('pkg-source');
  const zip = path.join(tmp, `zip-src-${seq}`);
  const wheel = path.join(zip, 'payload', 'runtime', 'PyYAML-6.0.3.whl');
  write(wheel, 'wheel');
  const ctx = ctxFor(root, {
    desktopDir: null,
    payloadDir: path.join(zip, 'payload'),
    receipt: {
      schema: 2,
      setup: { venv: { startedAt: new Date().toISOString(), recorded: { paths: { pyyamlWheel: wheel } } } },
    },
  });
  const c = await checkDesktop(ctx);
  assert.equal(c.status, 'pass', '읽어 온 곳은 쓴 곳이 아니다');
  assert.equal(c.outside.length, 0);
});

test('검사6: 영혼 이름이 IRIS 가 아니어도 그 이름의 바로가기는 통과한다(연습 소울)', async () => {
  // handoff.mjs writeFaceLauncher 는 바로가기를 "<name>.lnk"로 만들고, name 은
  // ctx.name ?? receipt.soul.name ?? path.basename(root) 순으로 정해진다. 이
  // 개발 PC 연습 소울(IRIS_INSTALLER_SOUL_NAME=IRIS-offline)에서는 root 의
  // 마지막 마디가 곧 그 이름이므로, root 를 "IRIS-offline"으로 두고 바탕화면에
  // 같은 이름의 .lnk 를 둔다.
  const root = path.join(tmp, 'IRIS-offline');
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  const desktop = path.join(tmp, `desk-offline-${seq += 1}`);
  fs.mkdirSync(desktop, { recursive: true });
  write(path.join(desktop, 'IRIS-offline.lnk'), 'shortcut');

  const ctx = ctxFor(root, {
    desktopDir: desktop,
    receipt: { schema: 2, setup: { unpack: { startedAt: new Date(Date.now() - 60000).toISOString() } } },
  });
  const c = await checkDesktop(ctx);
  assert.equal(c.status, 'pass');
  assert.equal(c.strays.length, 0);
});

test('검사6: 영혼 이름이 IRIS 가 아니어도 남의(외부) 새 파일은 여전히 실패로 잡는다', async () => {
  const root = path.join(tmp, 'IRIS-offline-2');
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  const desktop = path.join(tmp, `desk-offline-bad-${seq += 1}`);
  fs.mkdirSync(desktop, { recursive: true });
  write(path.join(desktop, 'IRIS-offline-2.lnk'), 'shortcut');
  write(path.join(desktop, '설치기가 흘린 파일.txt'), 'oops');

  const ctx = ctxFor(root, {
    desktopDir: desktop,
    receipt: { schema: 2, setup: { unpack: { startedAt: new Date(Date.now() - 60000).toISOString() } } },
  });
  const c = await checkDesktop(ctx);
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.strays.map((s) => s.name), ['설치기가 흘린 파일.txt']);
});

test('recordedPaths 는 원본(zip) 경로는 감사 대상에서 뺀다', () => {
  const found = recordedPaths({ files: { created: ['_agent\\a'] }, source: 'D:\\zip\\payload\\x', from: 'D:\\zip\\y' });
  assert.deepEqual(found, ['_agent\\a']);
});

test('installStartedAt: 가장 이른 단계 시작 시각을 쓴다', () => {
  const t1 = '2026-09-15T01:00:00.000Z';
  const t2 = '2026-09-15T02:00:00.000Z';
  assert.equal(installStartedAt({ setup: { env: { startedAt: t2 }, unpack: { startedAt: t1 } } }), Date.parse(t1));
});

// ---------------------------------------------------------------------------
// 7. 온톨로지
// ---------------------------------------------------------------------------

function card(root, folder, cardId) {
  write(path.join(root, folder, 'AGENTS.md'), `---\n{id: '${cardId}', type: role, code: R01}\n---\n\n# ${folder}\n`);
}

test('검사7: 신선도 통과 + 카드 ID 중복 0 이면 통과', () => {
  const root = newRoot('ont-ok');
  card(root, 'R01-교사(Teacher)', 'iris:AAAA1111');
  card(root, 'R02-연구자(Researcher)', 'iris:BBBB2222');
  const ctx = ctxFor(root, {
    receipt: { schema: 2, setup: { ontology: { recorded: { commands: [{ script: 'check_fresh.py', code: 0 }] } } } },
  });
  const c = checkOntology(ctx);
  assert.equal(c.status, 'pass');
  assert.equal(c.cards, 2);
});

test('검사7: 카드 ID 가 겹치거나 신선도가 실패면 막는다', () => {
  const root = newRoot('ont-bad');
  card(root, 'R01-교사(Teacher)', 'iris:SAME');
  card(root, 'R02-연구자(Researcher)', 'iris:SAME');
  const dup = checkOntology(ctxFor(root, {
    receipt: { schema: 2, setup: { ontology: { recorded: { commands: [{ script: 'check_fresh.py', code: 0 }] } } } },
  }));
  assert.equal(dup.status, 'fail');
  assert.match(dup.detail, /카드 ID 중복 1건/);

  const stale = checkOntology(ctxFor(newRoot('ont-stale'), {
    receipt: { schema: 2, setup: { ontology: { recorded: { commands: [{ script: 'check_fresh.py', code: 2 }] } } } },
  }));
  assert.equal(stale.status, 'fail');
  assert.match(stale.detail, /신선도 확인 실패/);
});

test('scanCardIds 는 _agent·_ontology 같은 도구 폴더는 훑지 않는다', () => {
  const root = newRoot('ont-scan');
  card(root, 'R01-교사(Teacher)', 'iris:AAAA');
  card(root, '_agent', 'iris:AAAA');
  const ids = scanCardIds(fs, root);
  assert.equal(ids.size, 1);
});

// ---------------------------------------------------------------------------
// 8·9. 영수증 멱등 · 엣지
// ---------------------------------------------------------------------------

test('검사8: 영수증을 읽고 다시 써도 같으면 통과하고 임시 파일을 남기지 않는다', () => {
  const root = newRoot('receipt');
  writeReceipt(root, newReceiptV2({ root, name: 'IRIS', manifest: { package: { version: '2.0.0' } }, createdBy: 't' }));
  const c = checkReceiptIdempotent(ctxFor(root));
  assert.equal(c.status, 'pass');
  assert.equal(fs.existsSync(path.join(root, '_agent', 'setup', 'receipt-idempotence.check')), false);
});

test('검사8: 영수증이 없으면 실패', () => {
  assert.equal(checkReceiptIdempotent(ctxFor(newRoot('no-receipt'))).status, 'fail');
});

test('검사9: 엣지가 없으면 실패가 아니라 대기(기록만)', () => {
  const yes = checkEdge(ctxFor(newRoot('edge-y')));
  assert.equal(yes.status, 'pass');
  const no = checkEdge(ctxFor(newRoot('edge-n'), { precheck: { recorded: { edge: { present: false } } } }));
  assert.equal(no.status, 'pending');
  assert.equal(no.pendingCapability.capability, '브라우저 조작(Playwright)');
});

// ---------------------------------------------------------------------------
// 10·11. 앞 단계 인계
// ---------------------------------------------------------------------------

test('검사10·11: 정션으로 막힌 자리는 실패, 꾸러미에 없던 것·번호 충돌은 대기', () => {
  const blocked = checkSkeleton(ctxFor(newRoot('sk1'), {
    receipt: { schema: 2, setup: { skeleton: { recorded: { blocked: [{ what: '_ontology' }], missing: [] } } } },
  }));
  assert.equal(blocked.status, 'fail');

  const missing = checkSkeleton(ctxFor(newRoot('sk2'), {
    receipt: { schema: 2, setup: { skeleton: { recorded: { blocked: [], missing: [{ what: '온톨로지 명세서' }] } } } },
  }));
  assert.equal(missing.status, 'pending');

  const reparse = checkStructure(ctxFor(newRoot('st1'), {
    receipt: { schema: 2, setup: { structure: { recorded: { conflicts: [{ wanted: 'R01-교사(Teacher)', reason: 'reparse-point' }] } } } },
  }));
  assert.equal(reparse.status, 'fail');

  const taken = checkStructure(ctxFor(newRoot('st2'), {
    receipt: { schema: 2, setup: { structure: { recorded: { conflicts: [{ wanted: 'R01-교사(Teacher)', existing: 'R01-나(Me)', reason: 'code-taken' }] } } } },
  }));
  assert.equal(taken.status, 'pending');
});

// ---------------------------------------------------------------------------
// 단계 전체
// ---------------------------------------------------------------------------

function fullyPassingRoot(label) {
  const root = newRoot(label);
  write(path.join(root, '_agent', 'shared', 'shims', 'python.cmd'), '@echo off');
  write(path.join(root, '_agent', 'claude', 'settings.json'), { permissions: {} });
  write(path.join(root, '_agent', 'claude', '.claude.json'), { mcpServers: { playwright: { command: 'x.cmd' } } });
  write(path.join(root, '_agent', 'codex', 'config.toml'), '[mcp_servers.pdf]\ncommand = "python"\n');
  write(path.join(root, '_agent', 'claude', 'scripts', 'block-blanket-kill.ps1'), '# ps');
  write(path.join(root, '_agent', 'claude', 'scripts', 'guard-iris-path.py'), '# py');
  write(path.join(root, '_ontology', 'check_fresh.py'), '# py');
  write(path.join(root, '_agent', 'claude', 'plugins', 'installed_plugins.json'), {
    version: 2, plugins: { 'superpowers@iris-local': [{ installPath: path.join(root, 'cache', 'sp') }] },
  });
  write(path.join(root, 'cache', 'sp', '.claude-plugin', 'plugin.json'), { name: 'superpowers' });
  writeReceipt(root, newReceiptV2({ root, name: 'IRIS', manifest: { package: { version: '2.0.0' } }, createdBy: 't' }));
  wireRelay(root, null);
  return root;
}

function stageCtx(root, extra = {}) {
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '_agent', 'setup', 'package-receipt.json'), 'utf8'));
  for (const id of ['unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology']) {
    receipt.setup[id] = { status: 'done', startedAt: new Date(Date.now() - 60000).toISOString(), recorded: {}, pending: [] };
  }
  receipt.setup.ontology.recorded = { commands: [{ script: 'check_fresh.py', code: 0 }] };
  receipt.setup.checks = { status: 'running' };
  wireRelay(root, receipt);
  return ctxFor(root, { receipt, desktopDir: null, ...extra });
}

test('단계 전체: 전부 통과하면 인수 문서·설치보고·진단을 쓰고 대기 목록을 돌려준다', async () => {
  const root = fullyPassingRoot('stage-ok');
  const out = await runChecksStage(stageCtx(root), { spawn: fakeSpawn() });

  assert.equal(out.recorded.checks.fail, 0);
  assert.ok(fs.existsSync(path.join(root, '_agent', 'setup', 'handoff.json')));
  assert.ok(fs.existsSync(path.join(root, '_agent', 'setup', 'diagnostics.json')));
  const report = fs.readdirSync(path.join(root, '_agent', 'setup')).find((f) => f.startsWith('설치보고-'));
  assert.ok(report, '설치보고 md 가 있어야 한다');
  assert.equal(out.recorded.state, 'login-pending', '로그인 전이니 아직 ready 가 아니다');

  // 보고서를 쓰는 순간 이 단계는 아직 running 이지만, 표에는 결말이 찍혀야 한다.
  const md = fs.readFileSync(path.join(root, '_agent', 'setup', report), 'utf8');
  assert.match(md, /마무리 검사\s+완료/);
  assert.match(md, /\[█{20}\] 100%/);
});

test('단계 전체: 검사가 실패해도 **먼저** 파일 셋을 쓰고 나서 E-CHECKS 로 멈춘다', async () => {
  const root = fullyPassingRoot('stage-fail');
  // 훅 파일 하나를 지워 검사 4를 실패시킨다.
  fs.rmSync(path.join(root, '_ontology', 'check_fresh.py'), { force: true });

  const ctx = stageCtx(root);
  await assert.rejects(
    () => runChecksStage(ctx, { spawn: fakeSpawn() }),
    (e) => {
      assert.equal(e.code, 'E-CHECKS');
      assert.match(e.message, /검사 \d+개가 실패했습니다/);
      assert.ok(Array.isArray(e.detail.fail) && e.detail.fail.length > 0);
      return true;
    },
  );

  // 멈추기 **전에** 쓴 파일들이 그대로 있어야 한다.
  const handoff = JSON.parse(fs.readFileSync(path.join(root, '_agent', 'setup', 'handoff.json'), 'utf8'));
  assert.ok(handoff.checks.fail > 0);
  assert.ok(fs.existsSync(path.join(root, '_agent', 'setup', 'diagnostics.json')));
  const md = fs.readdirSync(path.join(root, '_agent', 'setup')).find((f) => f.startsWith('설치보고-'));
  assert.ok(md);
});

test('단계 전체: 검사가 실패하면 인수 문서가 그것을 실패로 적는다(allDone 이 아니다)', async () => {
  // C5 — 검사가 깨졌는데도 `setup.allDone:true` 로 적히면 Face 는 "설치 완료"로
  // 읽고 첫 인사를 해 버린다. 실패한 설치는 인수 문서에서도 실패여야 한다.
  const root = fullyPassingRoot('stage-fail-handoff');
  fs.rmSync(path.join(root, '_ontology', 'check_fresh.py'), { force: true });

  await assert.rejects(() => runChecksStage(stageCtx(root), { spawn: fakeSpawn() }), (e) => e.code === 'E-CHECKS');

  const handoff = JSON.parse(fs.readFileSync(path.join(root, '_agent', 'setup', 'handoff.json'), 'utf8'));
  assert.equal(handoff.setup.allDone, false, '검사가 실패했는데 다 끝났다고 적으면 안 된다');
  assert.ok(handoff.setup.failed, '무엇이 실패했는지 적혀 있어야 한다');
  assert.equal(handoff.setup.failed.id, 'checks');
  assert.equal(handoff.setup.failed.code, 'E-CHECKS');
  assert.equal(handoff.state, 'setup-incomplete', 'Face 는 안내 카드 + 「설치 이어하기」로 가야 한다');
  assert.equal(handoff.setupCompletedAt, null);
});

test('runChecks: only 로 고른 검사만 돌린다(열세 항목이 다 있다)', async () => {
  const root = fullyPassingRoot('only');
  const all = await runChecks(stageCtx(root), { spawn: fakeSpawn() });
  assert.equal(all.items.length, 13);
  assert.deepEqual(all.items.map((c) => c.id), [
    'exe', 'mcp', 'plugins', 'hooks', 'config', 'desktop', 'ontology', 'receipt', 'edge', 'skeleton', 'structure', 'relay', 'relayCodex',
  ]);
  const one = await runChecks(stageCtx(root), { only: ['edge'] });
  assert.equal(one.items.length, 1);
});

test('검사 하나가 터져도 그 검사만 실패로 적고 나머지는 계속한다', async () => {
  const root = fullyPassingRoot('boom');
  const ctx = stageCtx(root, {
    run: async () => { throw new Error('시험용 폭발'); },
  });
  const res = await runChecks(ctx, { spawn: fakeSpawn() });
  assert.equal(res.items.length, 13);
  assert.ok(res.items.some((c) => c.status === 'pass'), '나머지는 계속 돈다');
});

// ---------------------------------------------------------------------------
// 12. 중계기 경유 (2026-09-18 네 번째 실제 PC: 코덱스 계정만 있는 중계기 + 클로드 세션 직행)
// ---------------------------------------------------------------------------

function relayRoot(label) {
  const root = newRoot(label);
  const receipt = { schema: 2, setup: {}, online: {} };
  wireRelay(root, receipt);
  return { root, receipt };
}

test('검사12: 배선 4곳 + 클로드 계정 + 살아 있는 요청 200 이면 통과(요청은 중계기로만 간다)', async () => {
  const { root, receipt } = relayRoot('relay-ok');
  const relay = fakeRelay({ accounts: [{ name: 'a', provider: 'anthropic' }, { name: 'c', provider: 'codex' }] });
  const c = await checkRelayRoute(ctxFor(root, { receipt, fetch: relay.fetchImpl }));
  assert.equal(c.status, 'pass', c.detail);
  assert.equal(c.relay.accounts.anthropic, 1);
  assert.equal(c.probe.status, 200);
  assert.ok(relay.calls.every((k) => k.url.startsWith('http://127.0.0.1:3456/')), '요청은 전부 중계기 주소로만');
  assert.match(c.detail, /살아 있는 요청 1건 통과/);
});

test('검사12: 중계기에 클로드 계정이 0개면 — 클로드 구독을 골랐으면 실패, 코덱스만 골랐으면 통과(배선은 맞고 요청은 보내지 않는다)', async () => {
  const { root, receipt } = relayRoot('relay-codex-only');
  const relay = fakeRelay({ accounts: [{ name: 'c', provider: 'codex' }] });
  const asClaude = await checkRelayRoute(ctxFor(root, { receipt, fetch: relay.fetchImpl, choice: { subscriptions: ['claude'] } }));
  assert.equal(asClaude.status, 'fail');
  assert.match(asClaude.detail, /클로드 계정 0개\(코덱스 1개\)/);
  assert.match(asClaude.detail, /claude\.ai 로그인을 추가/);
  assert.ok(!relay.calls.some((k) => k.url.endsWith('/v1/messages')), '계정이 없으면 살아 있는 요청을 보내지 않는다');

  const asCodex = await checkRelayRoute(ctxFor(root, { receipt, fetch: relay.fetchImpl, choice: { subscriptions: ['codex'] } }));
  assert.equal(asCodex.status, 'pass', asCodex.detail);   // 설계 A': 코덱스만 고른 설치는 클로드 계정 0 이 정상
  assert.match(asCodex.detail, /클로드 계정 0개/);
});

// ---------------------------------------------------------------------------
// 13. 중계기 경유(코덱스) — 설계 A' (2026-09-18): 코덱스 심의 프록시 3줄 + 가로채기 실측 + CA 번들
// ---------------------------------------------------------------------------

const FAKE_CA = '-----BEGIN CERTIFICATE-----\nMIIBfakeTeamClaudeCA0000000000000000000000000000000000000000000000\n-----END CERTIFICATE-----\n';

function codexRoot(label, { shimLines = CODEX_PROXY_LINES } = {}) {
  const root = newRoot(label);
  const receipt = { schema: 2, setup: {}, online: {} };
  wireRelay(root, receipt);
  write(path.join(root, '_agent', 'shared', 'shims', 'codex.cmd'), `@echo off\r\n${shimLines.join('\r\n')}\r\n`);
  return { root, receipt, dir: path.join(root, '_agent', 'shared', 'portable-state', 'teamclaude') };
}

// 중계기 MITM 흉내: ca 없이 부르면 "첫 CONNECT" 가 CA 파일을 만들고, ca 를 주면 검증된 200 + mitm-proxy-ok.
function fakeMitm(dir, { verified = true, body = '{"teamclaude":"mitm-proxy-ok"}', mint = true } = {}) {
  const calls = [];
  const impl = async ({ ca }) => {
    calls.push({ withCa: ca != null });
    if (ca == null) {
      if (mint) write(path.join(dir, 'teamclaude-ca.pem'), FAKE_CA);
      return { ok: true, status: 200, body, verified: false, issuer: 'TeamClaude MITM CA', error: null };
    }
    return { ok: true, status: 200, body, verified, issuer: 'TeamClaude MITM CA', error: verified ? null : 'tls: self signed' };
  };
  return { impl, calls };
}

test('검사13: 코덱스 심 3줄 + 코덱스 계정 + 가로채기 실측(CA 지연 생성 → 검증) 통과, CA 번들이 생긴다', async () => {
  const { root, receipt, dir } = codexRoot('codex-ok');
  const relay = fakeRelay({ accounts: [{ name: 'c', provider: 'codex' }] });
  const mitm = fakeMitm(dir);
  const c = await checkRelayCodex(ctxFor(root, { receipt, fetch: relay.fetchImpl, mitmProbe: mitm.impl, choice: { subscriptions: ['codex'] } }));
  assert.equal(c.status, 'pass', c.detail);
  assert.deepEqual(mitm.calls, [{ withCa: false }, { withCa: true }], '첫 CONNECT 로 CA 를 만들고, 그 CA 로 다시 검증한다');
  assert.equal(c.wiring.shim, true);
  assert.equal(c.relay.accounts.codex, 1);
  assert.ok(c.bundle.ok && c.bundle.changed, JSON.stringify(c.bundle));
  const bundle = fs.readFileSync(path.join(dir, 'codex-ca-bundle.pem'), 'utf8');
  assert.ok(bundle.includes(FAKE_CA.trim()), '번들에 중계기 CA 가 들어 있다');
  assert.ok((bundle.match(/-----BEGIN CERTIFICATE-----/g) || []).length > 50, '번들에 공인 루트가 함께 들어 있다');
  assert.match(c.detail, /가로채기 실측 통과/);

  // 두 번째 실행: CA 는 이미 있으니 mint 없이 검증 1번, 번들은 그대로.
  const again = fakeMitm(dir);
  const c2 = await checkRelayCodex(ctxFor(root, { receipt, fetch: relay.fetchImpl, mitmProbe: again.impl, choice: { subscriptions: ['codex'] } }));
  assert.equal(c2.status, 'pass', c2.detail);
  assert.deepEqual(again.calls, [{ withCa: true }]);
  assert.equal(c2.bundle.changed, false);
});

test('검사13: 코덱스를 고르지 않은 설치는 해당 없음으로 통과(아무 요청도 보내지 않는다)', async () => {
  const { root, receipt } = relayRoot('codex-skip');
  const relay = fakeRelay({ accounts: [{ name: 'a', provider: 'anthropic' }] });
  const c = await checkRelayCodex(ctxFor(root, { receipt, fetch: relay.fetchImpl, choice: { subscriptions: ['claude'] } }));
  assert.equal(c.status, 'pass');
  assert.equal(c.skipped, 'no-codex');
  assert.equal(relay.calls.length, 0);
});

test('검사13: 심에 프록시 줄이 빠졌거나 코덱스 계정이 0개면 실패, 가로채기 검증이 안 되면 실패, 중계기가 없으면 대기', async () => {
  const { root, receipt, dir } = codexRoot('codex-shim-bad', { shimLines: ['set "HTTPS_PROXY=http://127.0.0.1:3456"'] });
  const relay = fakeRelay({ accounts: [{ name: 'c', provider: 'codex' }] });
  const bad = await checkRelayCodex(ctxFor(root, { receipt, fetch: relay.fetchImpl, mitmProbe: fakeMitm(dir).impl, choice: { subscriptions: ['codex'] } }));
  assert.equal(bad.status, 'fail');
  assert.match(bad.detail, /프록시 설정 2줄이 없음\(NO_PROXY, SSL_CERT_FILE\)/);

  const ok = codexRoot('codex-no-acct');
  const none = fakeRelay({ accounts: [{ name: 'a', provider: 'anthropic' }] });
  const zero = await checkRelayCodex(ctxFor(ok.root, { receipt: ok.receipt, fetch: none.fetchImpl, mitmProbe: fakeMitm(ok.dir).impl, choice: { subscriptions: ['codex'] } }));
  assert.equal(zero.status, 'fail');
  assert.match(zero.detail, /코덱스 계정 0개\(클로드 1개\)/);
  assert.match(zero.detail, /ChatGPT 로그인을 추가/);

  const unv = codexRoot('codex-unverified');
  const un = await checkRelayCodex(ctxFor(unv.root, { receipt: unv.receipt, fetch: relay.fetchImpl, mitmProbe: fakeMitm(unv.dir, { verified: false }).impl, choice: { subscriptions: ['codex'] } }));
  assert.equal(un.status, 'fail');
  assert.match(un.detail, /가로채기 실측 실패/);

  const nomint = codexRoot('codex-nomint');
  const nm = await checkRelayCodex(ctxFor(nomint.root, { receipt: nomint.receipt, fetch: relay.fetchImpl, mitmProbe: fakeMitm(nomint.dir, { mint: false }).impl, choice: { subscriptions: ['codex'] } }));
  assert.equal(nm.status, 'fail');
  assert.match(nm.detail, /중계기가 CA 를 만들지 않음/);

  const down = codexRoot('codex-down');
  const d = await checkRelayCodex(ctxFor(down.root, { receipt: down.receipt, choice: { subscriptions: ['codex'] } }));
  assert.equal(d.status, 'pending');
  assert.match(d.detail, /중계기가 응답하지 않음/);
});

test('검사12: 심에 중계기 주소가 없으면 실패(그 길로 연 세션은 직행한다)', async () => {
  const { root, receipt } = relayRoot('relay-shim-bad');
  write(path.join(root, '_agent', 'shared', 'shims', 'claude.cmd'), '@echo off\r\nrem no base url\r\n');
  const relay = fakeRelay({ accounts: [{ name: 'a', provider: 'anthropic' }] });
  const c = await checkRelayRoute(ctxFor(root, { receipt, fetch: relay.fetchImpl }));
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /claude\.cmd 심에 중계기 주소가 없음/);
  assert.equal(c.wiring.shim, false);
});

test('검사12: 사용자 환경변수가 실제 적용된 설치에서 HKCU 값이 다르면 실패, 연습(applied:false)이면 기록만', async () => {
  const { root, receipt } = relayRoot('relay-hkcu');
  const relay = fakeRelay({ accounts: [{ name: 'a', provider: 'anthropic' }] });
  receipt.env.applied = true;
  const wrong = await checkRelayRoute(ctxFor(root, {
    receipt, fetch: relay.fetchImpl, readUserEnv: async () => ({ exists: true, type: 'REG_SZ', value: 'http://localhost:9999' }),
  }));
  assert.equal(wrong.status, 'fail');
  assert.match(wrong.detail, /사용자 환경변수 ANTHROPIC_BASE_URL=http:\/\/localhost:9999/);

  const right = await checkRelayRoute(ctxFor(root, {
    receipt, fetch: relay.fetchImpl, readUserEnv: async () => ({ exists: true, type: 'REG_SZ', value: 'http://127.0.0.1:3456' }),
  }));
  assert.equal(right.status, 'pass', right.detail);

  receipt.env.applied = false;
  const rehearsal = await checkRelayRoute(ctxFor(root, { receipt, fetch: relay.fetchImpl }));
  assert.equal(rehearsal.status, 'pass', rehearsal.detail);
  assert.equal(rehearsal.wiring.userEnv, 'skipped');
});

test('검사12: 중계기가 안 떠 있으면 대기(⑦ 뒤에 다시), 살아 있는 요청이 401/429 면 실패 문장에 까닭', async () => {
  const { root, receipt } = relayRoot('relay-down');
  const down = await checkRelayRoute(ctxFor(root, { receipt }));
  assert.equal(down.status, 'pending');
  assert.match(down.detail, /중계기가 응답하지 않음/);

  const r401 = fakeRelay({ accounts: [{ name: 'a', provider: 'anthropic' }], probe: { status: 401, body: { error: { message: 'invalid x-api-key' } } } });
  const c401 = await checkRelayRoute(ctxFor(root, { receipt, fetch: r401.fetchImpl }));
  assert.equal(c401.status, 'fail');
  assert.match(c401.detail, /계정 토큰을 넣지 않고 그대로 넘겼습니다\(401\)/);

  const r429 = fakeRelay({ accounts: [{ name: 'a', provider: 'anthropic' }], probe: { status: 429, body: { error: { message: 'no account can serve claude-haiku' } } } });
  const c429 = await checkRelayRoute(ctxFor(root, { receipt, fetch: r429.fetchImpl }));
  assert.equal(c429.status, 'fail');
  assert.match(c429.detail, /429: no account can serve/);
});
