// T13 ⑤-1 풀기 · ⑤-2 심·환경변수 시험
//
// 가짜 payload: 진짜와 **모양만** 같고 무게는 몇 KB 다(진짜 payload 는 369MB).
// 부품 종류마다 한 개씩 — 겉껍질 있는 압축(node) · 판 폴더 압축(uv) ·
// 낱개 파일(manage·gen-image) · payload 폴더 통째(바퀴집) · 섞여 사는 폴더
// (ontology·hooks) · Face 모듈(messenger).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/run.mjs';
import * as unpack from '../installer/setup/unpack.mjs';
import * as relay from '../installer/setup/relay.mjs';
import { isStageError } from '../installer/lib/errors.mjs';
import { portableTeamclaudeConfigPath, resolveTeamclaudeConfigPath } from '../installer/lib/login.mjs';
import { readReceipt } from '../installer/lib/receipt.mjs';

const TAR = 'C:\\Windows\\System32\\tar.exe';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-t13-unpack-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// 가짜 payload
// ---------------------------------------------------------------------------

async function zipFrom(srcDir, zipPath, entries) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.rmSync(zipPath, { force: true });
  const names = entries ?? fs.readdirSync(srcDir).sort();
  const r = await run(TAR, ['-a', '-cf', zipPath, '-C', srcDir, '--', ...names]);
  assert.equal(r.code, 0, `tar failed: ${r.err}`);
}

function put(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

// nodeBody 를 바꾸면 "판이 올라갔다" 는 상황을 흉내 낼 수 있다.
async function makePayload(label, { nodeVersion = '24.21.0', withMessenger = false } = {}) {
  const base = path.join(tmp, label);
  const payload = path.join(base, 'payload');
  const src = path.join(base, '_src');
  fs.rmSync(src, { recursive: true, force: true });

  // node: 겉껍질 한 겹(strip 1)
  put(path.join(src, `node-v${nodeVersion}-win-x64`, 'node.exe'), `fake node ${nodeVersion}`);
  put(path.join(src, `node-v${nodeVersion}-win-x64`, 'LICENSE'), 'MIT');
  await zipFrom(src, path.join(payload, 'runtime', `node-v${nodeVersion}.zip`), [`node-v${nodeVersion}-win-x64`]);

  // uv: 바퀴 모양(scripts 를 위로 끌어올리는지 본다)
  const uvSrc = path.join(base, '_uv');
  fs.rmSync(uvSrc, { recursive: true, force: true });
  put(path.join(uvSrc, 'uv', '__init__.py'), '# uv');
  put(path.join(uvSrc, 'uv-0.12.14.data', 'scripts', 'uv.exe'), 'fake uv.exe');
  await zipFrom(uvSrc, path.join(payload, 'runtime', 'uv-0.12.14.whl'), ['uv', 'uv-0.12.14.data']);

  // ontology: 섞여 사는 폴더(_ontology)
  const ontSrc = path.join(base, '_ont');
  fs.rmSync(ontSrc, { recursive: true, force: true });
  for (const f of ['build_graph.py', 'validate.py', 'query.py', 'render_view.py', 'check_fresh.py']) {
    put(path.join(ontSrc, f), `# ${f}\n`);
  }
  await zipFrom(ontSrc, path.join(payload, 'setup', 'ontology.zip'));

  // hooks: 섞여 사는 폴더(_agent\claude\scripts)
  const hookSrc = path.join(base, '_hooks');
  fs.rmSync(hookSrc, { recursive: true, force: true });
  put(path.join(hookSrc, 'block-blanket-kill.ps1'), '# ps1\n');
  put(path.join(hookSrc, 'guard-iris-path.py'), '# py\n');
  await zipFrom(hookSrc, path.join(payload, 'tools', 'hooks.zip'));

  // 낱개 파일 둘
  put(path.join(payload, 'relay', 'teamclaude-manage.ps1'), '# manage\n');
  put(path.join(payload, 'tools', 'gen-image.py'), '# gen-image\n');

  // 바퀴집(폴더 통째)
  for (const w of ['aaa-1.0-py3-none-any.whl', 'bbb-2.0-py3-none-any.whl']) {
    put(path.join(payload, 'tools', 'wheelhouse', w), `wheel ${w}`);
  }

  if (withMessenger) {
    const faceSrc = path.join(base, '_face');
    fs.rmSync(faceSrc, { recursive: true, force: true });
    put(path.join(faceSrc, 'package.json'), JSON.stringify({ name: 'iris-face', version: '2.66.0' }));
    put(path.join(faceSrc, 'state', 'keep.txt'), 'user session card');
    await zipFrom(faceSrc, path.join(payload, 'face', 'iris-face.zip'));
  }

  const lock = {
    schema: 2,
    package: { version: '2.0.0' },
    parts: {
      node: { kind: 'url', version: nodeVersion, file: `runtime/node-v${nodeVersion}.zip`, dest: '_agent/shared/tools/node' },
      uv: { kind: 'url', version: '0.12.14', file: 'runtime/uv-0.12.14.whl', dest: '_agent/shared/tools/uv/0.12.14' },
      manage: { kind: 'file', file: 'relay/teamclaude-manage.ps1', dest: '_agent/shared/tools/teamclaude' },
      'gen-image': { kind: 'file', file: 'tools/gen-image.py', dest: '_agent/claude/tools' },
      'document-mcp-wheelhouse': { kind: 'wheelhouse', file: 'tools/wheelhouse/', dest: '_agent/shared/tools/python-wheelhouse/document-mcp', expectedCount: 2 },
      hooks: { kind: 'dir', file: 'tools/hooks.zip', dest: '_agent/claude/scripts' },
      ontology: { kind: 'dir', file: 'setup/ontology.zip', dest: '_ontology' },
      // 뼈대(⑤-3)가 놓는 두 부품 — unpack 은 손대지 않아야 한다.
      'ontology-spec': { kind: 'file', file: 'setup/IRIS-온톨로지.md', dest: '/' },
      'folder-icon': { kind: 'file', file: 'policy/_cosmos.ico', dest: '/' },
      // 허가서상 동봉 못 하는 부품 — 건너뛰어야 한다.
      claude: { kind: 'claude-release', version: '2.1.272', redistribute: 'download', file: 'agents/claude-code-2.1.272.zip', dest: '_agent/shared/tools/claude' },
    },
  };
  const manifest = {
    schema: 2,
    package: { version: '2.0.0' },
    parts: Object.fromEntries(Object.entries(lock.parts)
      .filter(([k, v]) => v.redistribute !== 'download' && k !== 'ontology-spec' && k !== 'folder-icon')
      .map(([k, v]) => [k, { file: v.file, version: v.version ?? null, sha256: `sha-${k}-${v.version ?? '0'}`, dest: v.dest }])),
  };
  return { payloadDir: payload, lock, manifest };
}

function makeCtx(label, opts = {}) {
  const { payloadDir, lock, manifest } = opts.built ?? {};
  const root = opts.root ?? path.join(tmp, label, 'soul-IRIS');
  const logs = [];
  const progressCalls = [];
  const runCalls = [];
  return {
    root,
    payloadDir,
    lock,
    manifest,
    choice: { subscriptions: ['claude'], leadAgent: 'claude' },
    offline: true,
    log: (line) => logs.push(line),
    progress: (p) => progressCalls.push(p),
    run: async (exe, args) => { runCalls.push([exe, ...(args ?? [])]); return { code: 0, out: 'stub', err: '' }; },
    fs,
    env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '1' },
    logs,
    progressCalls,
    runCalls,
  };
}

// 모든 검증기를 통과시키는 가짜(가짜 payload 의 node.exe 는 진짜 실행 파일이 아니다).
function passAll(lock) {
  return Object.fromEntries(Object.keys(lock.parts).map((p) => [p, async () => ({ ok: true, detail: 'stub' })]));
}

// 폴더 지문: 경로 + 크기 + mtime + 내용 해시.
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const here = rel ? path.join(dir, rel) : dir;
    for (const e of fs.readdirSync(here, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { out[`${childRel}\\`] = 'dir'; walk(childRel); continue; }
      const st = fs.statSync(path.join(dir, childRel));
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, childRel))).digest('hex');
      out[childRel] = `${st.size}:${st.mtimeMs}:${hash}`;
    }
  };
  walk('');
  return out;
}

// ---------------------------------------------------------------------------
// ⑤-1 풀기
// ---------------------------------------------------------------------------

test('unpack: 부품 종류마다 잠금표 dest 로 간다(겉껍질·판폴더·낱개파일·폴더통째·섞임)', async () => {
  const built = await makePayload('place');
  const ctx = makeCtx('place', { built });
  ctx.verifiers = passAll(built.lock);

  const { recorded, pending } = await unpack.run(ctx);
  const at = (...s) => path.join(ctx.root, ...s);

  assert.deepEqual(pending, []);

  // ① 겉껍질 한 겹 벗기기(strip 1)
  assert.equal(fs.readFileSync(at('_agent', 'shared', 'tools', 'node', 'node.exe'), 'utf8'), 'fake node 24.21.0');
  assert.ok(!fs.existsSync(at('_agent', 'shared', 'tools', 'node', 'node-v24.21.0-win-x64')), '겉껍질 폴더가 남으면 안 된다');

  // ② 판이 폴더 이름에 들어가는 부품 + 바퀴 scripts 끌어올리기
  assert.ok(fs.existsSync(at('_agent', 'shared', 'tools', 'uv', '0.12.14', 'uv-0.12.14.data', 'scripts', 'uv.exe')));
  assert.equal(fs.readFileSync(at('_agent', 'shared', 'tools', 'uv', '0.12.14', 'uv.exe'), 'utf8'), 'fake uv.exe');

  // ③ 낱개 파일은 dest **폴더** 안에 원래 이름으로
  assert.ok(fs.existsSync(at('_agent', 'shared', 'tools', 'teamclaude', 'teamclaude-manage.ps1')));
  assert.ok(fs.existsSync(at('_agent', 'claude', 'tools', 'gen-image.py')));

  // ④ payload 폴더 통째(바퀴집)
  const wheels = fs.readdirSync(at('_agent', 'shared', 'tools', 'python-wheelhouse', 'document-mcp'));
  assert.deepEqual(wheels.sort(), ['aaa-1.0-py3-none-any.whl', 'bbb-2.0-py3-none-any.whl']);

  // ⑤ 섞여 사는 폴더 두 개
  assert.ok(fs.existsSync(at('_ontology', 'build_graph.py')));
  assert.ok(fs.existsSync(at('_agent', 'claude', 'scripts', 'guard-iris-path.py')));

  // ⑥ 뼈대 몫·내려받기 몫은 건드리지 않는다
  assert.ok(!fs.existsSync(at('IRIS-온톨로지.md')));
  assert.ok(!fs.existsSync(at('_cosmos.ico')));
  assert.ok(!fs.existsSync(at('_agent', 'shared', 'tools', 'claude')));
  assert.deepEqual(recorded.skeletonOwned.sort(), ['folder-icon', 'ontology-spec']);
  assert.deepEqual(recorded.downloadLater, ['claude']);
  assert.ok(!recorded.placed.includes('claude'));
  assert.equal(recorded.placed.length, 7);

  // ⑦ 부품마다 진행을 알린다
  const labels = ctx.progressCalls.map((p) => p.label);
  assert.ok(labels.includes('node') && labels.includes('ontology'));
  assert.ok(ctx.progressCalls.every((p) => p.total === 7));
  assert.equal(ctx.progressCalls.at(-1).done, 7);
});

test('unpack: 두 번째 실행은 아무것도 바꾸지 않는다', async () => {
  const built = await makePayload('idem');
  const ctx = makeCtx('idem', { built });
  ctx.verifiers = passAll(built.lock);

  await unpack.run(ctx);
  const before = snapshot(ctx.root);

  const ctx2 = makeCtx('idem', { built, root: ctx.root });
  ctx2.verifiers = passAll(built.lock);
  const { recorded } = await unpack.run(ctx2);

  assert.deepEqual(snapshot(ctx.root), before, '두 번째 실행에서 파일이 하나도 바뀌면 안 된다');
  assert.equal(recorded.placed.length, 0);
  assert.equal(recorded.skipped.length, 7);
});

test('unpack: 판이 바뀌면 옛 사본을 .prev 로 옮기고 지우지 않는다', async () => {
  const v1 = await makePayload('prev-v1', { nodeVersion: '24.21.0' });
  const ctx = makeCtx('prev', { built: v1 });
  ctx.verifiers = passAll(v1.lock);
  await unpack.run(ctx);

  const nodeDir = path.join(ctx.root, '_agent', 'shared', 'tools', 'node');
  fs.writeFileSync(path.join(nodeDir, 'user-note.txt'), '사용자가 넣어 둔 것', 'utf8');

  const v2 = await makePayload('prev-v2', { nodeVersion: '25.0.0' });
  const ctx2 = makeCtx('prev', { built: v2, root: ctx.root });
  ctx2.verifiers = passAll(v2.lock);
  const { recorded } = await unpack.run(ctx2);

  assert.equal(fs.readFileSync(path.join(nodeDir, 'node.exe'), 'utf8'), 'fake node 25.0.0');
  assert.equal(fs.readFileSync(`${nodeDir}.prev/user-note.txt`, 'utf8'), '사용자가 넣어 둔 것');
  assert.ok(recorded.moved.some((m) => m.part === 'node' && m.previous.endsWith('node.prev')));
});

test('unpack: 옛 사본을 .prev 로 옮기지 못하면(다른 프로그램이 붙잡음) 까닭이 문장에 담긴 E-UNPACK 이다', async () => {
  // 2026-09-17 실제 사용자 실측(2.0.2): 이 예외가 try 밖이라 "예상치 못한 오류"로만 보였다.
  const v1 = await makePayload('aside-v1', { nodeVersion: '24.21.0' });
  const ctx = makeCtx('aside', { built: v1 });
  ctx.verifiers = passAll(v1.lock);
  await unpack.run(ctx);

  const v2 = await makePayload('aside-v2', { nodeVersion: '25.0.0' });
  const ctx2 = makeCtx('aside', { built: v2, root: ctx.root });
  ctx2.verifiers = passAll(v2.lock);
  ctx2.preserveAside = () => { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; };
  // 2026-09-17: 누가 붙잡았는지 — 우리 프로그램(list)은 없고 탐색기(files, Restart Manager)가 열어 둔 경우.
  ctx2.processes = {
    list: async () => [],
    files: async () => [{ pid: 9001, name: 'explorer.exe', app: 'Windows Explorer', exe: 'C:\\Windows\\explorer.exe', what: null }],
  };
  await assert.rejects(unpack.run(ctx2), (err) => {
    assert.ok(isStageError(err));
    assert.equal(err.code, 'E-UNPACK');
    assert.match(err.message, /옆으로 옮기지 못했습니다\(EPERM\)/);
    assert.match(err.message, /다른 프로그램 explorer\.exe\(PID 9001, Windows Explorer\) 이\(가\) 그 폴더의 파일을 열어 놓았습니다/);
    assert.equal(err.detail.part, 'node');
    assert.equal(err.detail.code, 'EPERM');
    assert.deepEqual(err.detail.holders, [], '남의 것은 닫아 줄 목록에 넣지 않는다');
    assert.equal(err.detail.blockers.length, 1);
    return true;
  });
  // 아무것도 지우지 않았다: 옛 node 는 제자리.
  assert.equal(fs.readFileSync(path.join(ctx.root, '_agent', 'shared', 'tools', 'node', 'node.exe'), 'utf8'), 'fake node 24.21.0');
});

test('unpack: 바꿀 부품이 있는데 설치 폴더의 우리 프로그램이 돌고 있으면 아무것도 옮기기 전에 목록과 함께 멈춘다', async () => {
  // 2026-09-17 실제 사용자 실측(2.0.4): 한도 화면 서버가 teamclaude-dash 를 붙잡아 9번째 부품에서 EBUSY.
  const v1 = await makePayload('busy-v1', { nodeVersion: '24.21.0' });
  const ctx = makeCtx('busy', { built: v1 });
  ctx.verifiers = passAll(v1.lock);
  await unpack.run(ctx);
  const before = snapshot(ctx.root);

  const v2 = await makePayload('busy-v2', { nodeVersion: '25.0.0' });
  const ctx2 = makeCtx('busy', { built: v2, root: ctx.root });
  ctx2.verifiers = passAll(v2.lock);
  const holders = [{ pid: 4321, name: 'node.exe', exe: null, what: 'teamclaude-dash\\server.mjs' }];
  ctx2.processes = { list: async () => holders };
  await assert.rejects(unpack.run(ctx2), (err) => {
    assert.ok(isStageError(err));
    assert.equal(err.code, 'E-UNPACK');
    assert.match(err.message, /IRIS 프로그램 1개가 아직 실행 중/);
    assert.match(err.message, /node\.exe\(PID 4321, teamclaude-dash\\server\.mjs\)/);
    assert.deepEqual(err.detail.holders, holders);
    assert.ok(err.detail.willPlace.includes('node'));
    return true;
  });
  assert.deepEqual(snapshot(ctx.root), before, '아무것도 옮기지 않았다(.prev 도 없다)');

  // 같은 판을 다시 돌리면(바꿀 부품 없음) 프로그램이 돌고 있어도 막지 않는다.
  const ctx3 = makeCtx('busy', { built: v1, root: ctx.root });
  ctx3.verifiers = passAll(v1.lock);
  ctx3.processes = { list: async () => holders };
  const { recorded } = await unpack.run(ctx3);
  assert.equal(recorded.placed.length, 0);
});

test('unpack: 섞여 사는 폴더(_ontology)는 통째로 옮기지 않고 그 사람 파일을 남긴다', async () => {
  const v1 = await makePayload('merge-v1');
  const ctx = makeCtx('merge', { built: v1 });
  ctx.verifiers = passAll(v1.lock);
  await unpack.run(ctx);

  const mine = path.join(ctx.root, '_ontology', '내-메모.md');
  fs.writeFileSync(mine, '# 내 메모\n', 'utf8');

  // 같은 부품을 새 지문으로 다시 놓게 만든다(manifest sha 를 바꿔서).
  const v2 = await makePayload('merge-v2');
  v2.manifest.parts.ontology.sha256 = 'sha-ontology-new';
  const ctx2 = makeCtx('merge', { built: v2, root: ctx.root });
  ctx2.verifiers = passAll(v2.lock);
  await unpack.run(ctx2);

  assert.ok(fs.existsSync(mine), '섞여 사는 폴더의 사용자 파일이 사라지면 안 된다');
  assert.ok(!fs.existsSync(path.join(ctx.root, '_ontology.prev')), '섞여 사는 폴더는 .prev 로 옮기지 않는다');
  assert.ok(fs.existsSync(path.join(ctx.root, '_ontology', 'build_graph.py')));
});

test('unpack: 검증 실패는 E-UNPACK StageError 이고 옛 사본은 .prev 에 남는다', async () => {
  const built = await makePayload('verifyfail');
  const ctx = makeCtx('verifyfail', { built });
  ctx.verifiers = {
    ...passAll(built.lock),
    node: async () => ({ ok: false, detail: 'v0.0.0 이 나왔다' }),
  };

  await assert.rejects(() => unpack.run(ctx), (err) => {
    assert.ok(isStageError(err), 'StageError 여야 한다');
    assert.equal(err.code, 'E-UNPACK');
    assert.equal(err.detail.part, 'node');
    assert.match(err.message, /확인에 실패/);
    return true;
  });
  // 놓긴 놓았다 — 사람이 두 벌을 보고 정할 수 있게 지우지 않는다.
  assert.ok(fs.existsSync(path.join(ctx.root, '_agent', 'shared', 'tools', 'node', 'node.exe')));
});

test('unpack: 꾸러미에 부품이 없으면 E-UNPACK 으로 멈춘다', async () => {
  const built = await makePayload('missing');
  fs.rmSync(path.join(built.payloadDir, 'runtime', 'node-v24.21.0.zip'));
  const ctx = makeCtx('missing', { built });
  ctx.verifiers = passAll(built.lock);

  await assert.rejects(() => unpack.run(ctx), (err) => {
    assert.equal(err.code, 'E-UNPACK');
    assert.equal(err.detail.part, 'node');
    return true;
  });
});

test('unpack: MotW(Zone.Identifier) 를 놓은 파일마다 지운다', async () => {
  const built = await makePayload('motw');
  const ctx = makeCtx('motw', { built });
  ctx.verifiers = passAll(built.lock);
  const { recorded } = await unpack.run(ctx);
  // stripMotw 는 파일마다 1 을 세므로, 놓인 파일 수만큼 호출된 것이 증거다.
  assert.ok(recorded.motw >= 10, `MotW 제거 대상 파일이 세어져야 한다(실제 ${recorded.motw})`);

  // 진짜로 지우는지: 대체 데이터 스트림을 하나 만들어 두고 다시 놓게 한다.
  const marked = path.join(ctx.root, '_agent', 'shared', 'tools', 'node', 'node.exe');
  try {
    fs.writeFileSync(`${marked}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  } catch {
    return; // NTFS 가 아닌 곳에서는 이 확인을 건너뛴다
  }
  assert.ok(fs.existsSync(`${marked}:Zone.Identifier`));
  const { stripMotw } = await import('../installer/lib/install.mjs');
  stripMotw(path.dirname(marked));
  assert.ok(!fs.existsSync(`${marked}:Zone.Identifier`), 'Zone.Identifier 스트림이 지워져야 한다');
});

test('unpack: 잠금표에 dest 가 없는 부품은 조용히 넘어가지 않는다', async () => {
  const built = await makePayload('nodest');
  delete built.lock.parts.node.dest;
  delete built.manifest.parts.node.dest;
  const ctx = makeCtx('nodest', { built });
  ctx.verifiers = passAll(built.lock);
  await assert.rejects(() => unpack.run(ctx), (err) => {
    assert.equal(err.code, 'E-UNPACK');
    assert.match(err.message, /어디로 가야 하는지/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// ⑤-2 심·환경변수
// ---------------------------------------------------------------------------

test('env: 심 내용은 ASCII·CRLF 이고 전부 %~dp0 상대다', async () => {
  const built = await makePayload('env');
  const ctx = makeCtx('env', { built });
  ctx.verifiers = passAll(built.lock);
  await unpack.run(ctx);

  const { recorded, pending } = await unpack.runEnv(ctx);
  const shims = path.join(ctx.root, '_agent', 'shared', 'shims');

  // node·git·python·py 는 늘, codex 는 늘, claude 는 아직(⑥-2 뒤)
  const names = fs.readdirSync(shims).sort();
  // 2.0.35: 중계기 자가 기동 3종(relay-ensure.cmd/.mjs·relay-autostart.vbs)이 함께 놓인다
  assert.deepEqual(names, ['codex.cmd', 'git.cmd', 'node.cmd', 'py.cmd', 'python.cmd', 'relay-autostart.vbs', 'relay-ensure.cmd', 'relay-ensure.mjs', 'uv.cmd']);
  assert.ok(pending.some((p) => /Claude Code/.test(p.capability)), 'claude 심은 온라인 단계로 미뤄진다');
  assert.equal(recorded.claudeShim.written, false);

  for (const f of names) {
    const buf = fs.readFileSync(path.join(shims, f));
    assert.ok(buf.every((b) => b < 0x80), `${f} 에 ASCII 아닌 바이트가 있다`);
    const text = buf.toString('ascii');
    assert.ok(!/[A-Za-z]:\\/.test(text), `${f} 에 절대경로가 박혀 있다`);
    if (!f.endsWith('.cmd')) continue; // .mjs 는 LF·import.meta.url 상대, .vbs 는 ScriptFullName 상대 — cmd 규칙(CRLF·%~dp0)은 .cmd 만
    assert.ok(text.includes('\r\n'), `${f} 는 CRLF 여야 한다`);
    assert.ok(!/\n(?<!\r\n)/.test(text.replace(/\r\n/g, '')), `${f} 에 홀로 있는 LF 가 있다`);
    assert.ok(text.includes('%~dp0'), `${f} 는 %~dp0 상대경로여야 한다`);
  }

  // uv 심은 잠금표 dest 의 판 폴더를 가리킨다
  assert.match(fs.readFileSync(path.join(shims, 'uv.cmd'), 'ascii'), /uv\\0\.12\.14\\uv\.exe/);

  // 환경변수 네 개 + 연습이라 레지스트리는 건드리지 않았다
  assert.equal(recorded.vars.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
  assert.equal(recorded.vars.CLAUDE_CONFIG_DIR, path.join(ctx.root, '_agent', 'claude'));
  assert.equal(recorded.vars.CODEX_HOME, path.join(ctx.root, '_agent', 'codex'));
  assert.equal(recorded.vars.TEAMCLAUDE_CONFIG, portableTeamclaudeConfigPath(ctx.root));
  assert.equal(recorded.userEnv.applied, false);
  assert.equal(recorded.userEnv.skippedReason, 'IRIS_INSTALLER_NO_USER_ENV=1');
  // 뒤 단계(⑥-3 로그인·⑥-4 중계기)가 쓰는 값이라 recorded.env 에도 있어야 한다
  assert.equal(recorded.env.TEAMCLAUDE_CONFIG, portableTeamclaudeConfigPath(ctx.root));

  // 뒤 단계용 PATH 앞자리
  const first = recorded.env.PATH.split(';').slice(0, 4);
  assert.deepEqual(first, [
    path.join(ctx.root, '_agent', 'shared', 'shims'),
    path.join(ctx.root, '_agent', 'shared', 'tools', 'node'),
    path.join(ctx.root, '_agent', 'shared', 'tools', 'git', 'cmd'),
    path.join(ctx.root, '_agent', 'shared', 'tools', 'python'),
  ]);
  assert.equal(ctx.env.PATH, recorded.env.PATH, 'ctx.env 도 같은 값으로 갱신된다');
});

test('env: claude.exe 가 놓인 뒤에는 claude 심을 쓴다', async () => {
  const built = await makePayload('env-claude');
  const ctx = makeCtx('env-claude', { built });
  ctx.verifiers = passAll(built.lock);
  await unpack.run(ctx);
  // ⑥-2 가 한 일을 흉내 낸다
  put(path.join(ctx.root, '_agent', 'shared', 'tools', 'claude', '2.1.272', 'claude.exe'), 'fake claude');

  const { recorded, pending } = await unpack.runEnv(ctx);
  assert.ok(fs.existsSync(path.join(ctx.root, '_agent', 'shared', 'shims', 'claude.cmd')));
  assert.equal(recorded.claudeShim.written, true);
  assert.deepEqual(pending, []);
});

test('env: 두 번째 실행은 심 파일을 바꾸지 않는다', async () => {
  const built = await makePayload('env-idem');
  const ctx = makeCtx('env-idem', { built });
  ctx.verifiers = passAll(built.lock);
  await unpack.run(ctx);
  await unpack.runEnv(ctx);

  const shims = path.join(ctx.root, '_agent', 'shared', 'shims');
  const before = snapshot(shims);
  await unpack.runEnv(ctx);
  // 바이트가 이미 맞는 심은 다시 쓰지 않는다 -- mtime 까지 그대로여야 한다
  // (계약 v2 검사 8 "재실행 시 변경 0").
  assert.deepEqual(snapshot(shims), before);
});

test('env: 영수증 env 에 teamclaudeConfig 를 남기고, relay 가 만드는 파일과 같은 자리다', async () => {
  const built = await makePayload('receipt-env');
  const ctx = makeCtx('receipt-env', { built });
  ctx.verifiers = passAll(built.lock);
  // 엔진(T18)이 넘겨주는 v2 영수증을 흉내 낸다.
  ctx.receipt = { schema: 2, soul: { root: ctx.root, name: 'IRIS' }, setup: {}, online: {} };
  await unpack.run(ctx);
  const { recorded } = await unpack.runEnv(ctx);

  const want = portableTeamclaudeConfigPath(ctx.root);

  // ① ctx.receipt (엔진이 단계 끝에 통째로 저장하는 객체)
  assert.equal(ctx.receipt.env.teamclaudeConfig, want);
  assert.equal(ctx.receipt.env.TEAMCLAUDE_CONFIG, want);
  assert.equal(ctx.receipt.env.CLAUDE_CONFIG_DIR, path.join(ctx.root, '_agent', 'claude'));
  assert.equal(ctx.receipt.env.CODEX_HOME, path.join(ctx.root, '_agent', 'codex'));
  assert.equal(ctx.receipt.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
  assert.equal(ctx.receipt.env.shims, path.join(ctx.root, '_agent', 'shared', 'shims'));
  assert.equal(ctx.receipt.env.applied, false, '연습 실행이라 레지스트리에 걸지 않았다고 남아야 한다');
  assert.equal(ctx.receipt.env.skippedReason, 'IRIS_INSTALLER_NO_USER_ENV=1');
  assert.equal(recorded.receiptEnv.teamclaudeConfig, want);

  // ② 디스크의 영수증 -- 엔진 없이 이 단계만 불러도 읽힌다
  assert.equal(readReceipt(ctx.root)?.env?.teamclaudeConfig, want);

  // ③ login.mjs 의 실제 해석기가 그 값을 1순위로 집는다
  assert.equal(resolveTeamclaudeConfigPath({ root: ctx.root, env: {}, readReceiptFn: readReceipt }), want);

  // ④ ⑤-7 relay 가 **바로 그 파일**을 만든다
  await relay.run(ctx);
  assert.ok(fs.existsSync(want), 'relay 가 영수증이 가리키는 자리에 설정을 만들어야 한다');
  // 2026-09-17(2.0.8): 기본 틀(proxy.port 3456 포함)로 만든다 — 계정은 0.
  const cfgWritten = JSON.parse(fs.readFileSync(want, 'utf8'));
  assert.deepEqual(cfgWritten.accounts, []);
  assert.equal(cfgWritten.proxy.port, 3456);
});

test('env: 영수증이 없어도(엔진 없이 단독 호출) 멈추지 않는다', async () => {
  const built = await makePayload('receipt-none');
  const ctx = makeCtx('receipt-none', { built });
  ctx.verifiers = passAll(built.lock);
  await unpack.run(ctx);
  const { recorded } = await unpack.runEnv(ctx); // ctx.receipt 없음
  assert.equal(recorded.receiptEnv.teamclaudeConfig, portableTeamclaudeConfigPath(ctx.root));
});

test('env: IRIS_INSTALLER_NO_USER_ENV 가 없으면 주입된 userpath 로만 쓴다', async () => {
  const built = await makePayload('env-reg');
  const ctx = makeCtx('env-reg', { built });
  ctx.verifiers = passAll(built.lock);
  ctx.env = { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '' };
  await unpack.run(ctx);

  const calls = [];
  ctx.userpath = {
    recording: true,
    skippedReason: 'test',
    addUserPath: async (d) => { calls.push(['path', d]); return { changed: true }; },
    setUserEnv: async (k, v) => { calls.push([k, v]); return { previous: null }; },
  };
  const { recorded } = await unpack.runEnv(ctx);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['path', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_BASE_URL', 'TEAMCLAUDE_CONFIG'],
  );
  assert.equal(calls[0][1], path.join(ctx.root, '_agent', 'shared', 'shims'));
  assert.equal(calls.at(-1)[1], portableTeamclaudeConfigPath(ctx.root));
  assert.equal(recorded.userEnv.applied, false, 'recording 주입이면 applied=false 로 남는다');
});

test('unpack (Task 24b #3): document-mcp-wheelhouse 는 manifest 에 지문이 없어도(폴더라 하나로 못 묶는다) 잠금표 sha256 변화로 다시 놓인다', async () => {
  // 진짜 lock.json 처럼: 이 부품은 manifest 에 sha256 이 없고(파일이 아니라
  // 폴더라 빌드가 지문 하나를 못 낸다), lock.json 의 sha256(requirements.lock
  // 지문)만이 정체성이다.
  const v1 = await makePayload('wheel-sha-v1');
  delete v1.manifest.parts['document-mcp-wheelhouse'].sha256;
  v1.lock.parts['document-mcp-wheelhouse'].sha256 = `${'a'.repeat(63)}1`;
  const ctx = makeCtx('wheel-sha', { built: v1 });
  ctx.verifiers = passAll(v1.lock);
  await unpack.run(ctx);

  const wheelDir = path.join(ctx.root, '_agent', 'shared', 'tools', 'python-wheelhouse', 'document-mcp');
  assert.deepEqual(fs.readdirSync(wheelDir).sort(), ['aaa-1.0-py3-none-any.whl', 'bbb-2.0-py3-none-any.whl']);

  // 새 판: requirements.lock 지문만 바뀌었다(바퀴 내용이 실제로 달라졌다는 뜻) —
  // 판·dest 꼬리는 그대로라 지문 하나만이 "바뀌었다"를 알 수 있는 유일한 근거다.
  const v2 = await makePayload('wheel-sha-v2');
  delete v2.manifest.parts['document-mcp-wheelhouse'].sha256;
  v2.lock.parts['document-mcp-wheelhouse'].sha256 = `${'b'.repeat(63)}2`;
  fs.rmSync(path.join(v2.payloadDir, 'tools', 'wheelhouse', 'bbb-2.0-py3-none-any.whl'));
  put(path.join(v2.payloadDir, 'tools', 'wheelhouse', 'ccc-3.0-py3-none-any.whl'), 'wheel ccc-3.0-py3-none-any.whl');

  const ctx2 = makeCtx('wheel-sha', { built: v2, root: ctx.root });
  ctx2.verifiers = passAll(v2.lock);
  const { recorded } = await unpack.run(ctx2);

  assert.ok(
    !recorded.skipped.includes('document-mcp-wheelhouse'),
    '잠금표 지문이 바뀌었는데 건너뛰면 안 된다(수정 전에는 manifest 에 지문이 없어 늘 "모름=다시" 였다가 아니라, sha256:null 대 null 로 "같다" 판정이 났다)',
  );
  assert.ok(recorded.placed.includes('document-mcp-wheelhouse'));
  assert.deepEqual(fs.readdirSync(wheelDir).sort(), ['aaa-1.0-py3-none-any.whl', 'ccc-3.0-py3-none-any.whl']);
});

test('unpack (Task 24b #3): 지문·판·꼬리가 전부 이전과 같으면(진짜 안 바뀐 경우) 그대로 건너뛴다', async () => {
  const v1 = await makePayload('wheel-sha-same');
  delete v1.manifest.parts['document-mcp-wheelhouse'].sha256;
  v1.lock.parts['document-mcp-wheelhouse'].sha256 = `${'c'.repeat(63)}3`;
  const ctx = makeCtx('wheel-sha-same', { built: v1 });
  ctx.verifiers = passAll(v1.lock);
  await unpack.run(ctx);

  const ctx2 = makeCtx('wheel-sha-same', { built: v1, root: ctx.root });
  ctx2.verifiers = passAll(v1.lock);
  const { recorded } = await unpack.run(ctx2);
  assert.ok(recorded.skipped.includes('document-mcp-wheelhouse'), '아무것도 안 바뀌었으면 건너뛰어야 한다(멱등)');
});

// ---------------------------------------------------------------------------
// 배치표 자체 검사 — 잠금표와 어긋나지 않는지
// ---------------------------------------------------------------------------

test('unpack: 진짜 lock.json 의 부품이 전부 배치표에 있다(뼈대·내려받기 몫 제외)', async () => {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
  const ctx = { lock, root: 'X:\\soul', payloadDir: 'X:\\payload' };
  const parts = unpack.partsToUnpack(ctx);

  const download = Object.keys(lock.parts).filter((p) => lock.parts[p].redistribute === 'download');
  const expected = Object.keys(lock.parts)
    .filter((p) => !unpack.SKELETON_OWNED.has(p) && !download.includes(p));
  assert.deepEqual(parts.slice().sort(), expected.slice().sort(), '잠금표 부품이 하나도 빠지면 안 된다');

  for (const p of parts) {
    assert.ok(unpack.V2_LAYOUT[p], `배치표에 ${p} 가 없다`);
    assert.ok(lock.parts[p].dest, `${p} 에 dest 가 없다`);
  }
  // 뼈대 몫 두 개는 잠금표에서 루트(`/`) 파일이어야 한다(경계의 근거).
  for (const p of unpack.SKELETON_OWNED) {
    assert.equal(lock.parts[p].dest, '/', `${p} 는 영혼 루트에 놓이는 부품이라 뼈대 몫이다`);
    assert.equal(lock.parts[p].kind, 'file');
  }
});

test('unpack (2.0.30): a file part living inside another part\'s folder (manage in teamclaude/) is re-placed when that folder was replaced', async () => {
  // 2026-09-20 home desktop: 2.0.29 was the first update that changed the teamclaude part; the folder was set aside and
  // re-extracted, but `manage` (teamclaude-manage.ps1, unchanged) was skipped because "the folder exists" -- the relay
  // could not be started afterwards ("cannot connect to the proxy"). Simulate the folder replacement: the file is gone,
  // the folder is there, the part identity is unchanged.
  const v1 = await makePayload('manage-refill-v1');
  const ctx = makeCtx('manage-refill', { built: v1 });
  ctx.verifiers = passAll(v1.lock);
  await unpack.run(ctx);
  const managePs1 = path.join(ctx.root, '_agent', 'shared', 'tools', 'teamclaude', 'teamclaude-manage.ps1');
  assert.ok(fs.existsSync(managePs1), 'fresh install places the manage script');
  fs.rmSync(managePs1);

  const ctx2 = makeCtx('manage-refill', { built: v1, root: ctx.root });
  ctx2.verifiers = passAll(v1.lock);
  const { recorded } = await unpack.run(ctx2);
  assert.ok(!recorded.skipped.includes('manage'), 'manage must not be skipped when its file is missing (folder only)');
  assert.ok(recorded.placed.includes('manage'));
  assert.ok(fs.existsSync(managePs1), 'the relay start script is back');
});
