// T15 ⑤-5 파이썬 환경 시험
//
// 단위 시험은 가짜 ctx.run/fs 로 명령 순서·인자·환경변수·격리 감사·멱등
// (kept) 경로를 확인한다. 통합 시험 하나는 실제로 빌드된 payload
// (`_build\stage\payload`)의 python·uv·wheelhouse·pdf-automation 부품을 스크래치
// tmp 영혼에 풀어 실제 오프라인 venv 를 만들고, pdf-automation MCP 서버와
// 표준입출력 JSON-RPC 를 주고받는다. 빌드 산출물이 없으면 t.skip 으로
// 깨끗이 건너뛴다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as venv from '../installer/setup/venv.mjs';
import { run as realRun } from '../lib/run.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_PAYLOAD = path.join(REPO, '_build', 'stage', 'payload');
const TAR = 'C:\\Windows\\System32\\tar.exe';

// 접두사를 짧게(윈도우 MAX_PATH 여유 확보 -- t17 통합 시험과 같은 이유).
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 't15-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const OK = { code: 0, out: '', err: '' };

function okList(count) {
  const arr = Array.from({ length: count }, (_, i) => ({ name: `pkg${i}`, version: '1.0' }));
  return { code: 0, out: `${JSON.stringify(arr)}\n`, err: 'Using Python 3.12.14 environment at: X\n' };
}

function okImportCheck({ leaks = [] } = {}) {
  const imports = Object.fromEntries(venv.KEY_MODULES.map((m) => [m, { ok: true, file: `X\\${m}\\__init__.py` }]));
  return { code: 0, out: `${JSON.stringify({ imports, leaks })}\n`, err: '' };
}

function failImportCheck(mod) {
  const imports = Object.fromEntries(venv.KEY_MODULES.map((m) => [m, m === mod ? { ok: false, error: 'no module' } : { ok: true, file: 'X' }]));
  return { code: 0, out: `${JSON.stringify({ imports, leaks: [] })}\n`, err: '' };
}

function okYaml(ok, { leaks = [], file = 'X\\yaml\\__init__.py' } = {}) {
  return { code: 0, out: `${JSON.stringify(ok ? { ok: true, file, leaks } : { ok: false, error: 'no module' })}\n`, err: '' };
}

// ---------------------------------------------------------------------------
// 가짜 ctx: 실제 파일 존재 여부는 checkFn(locateParts)이 진짜로 검사하므로,
// 잠금표가 가리키는 자리에 자그마한 더미 파일을 실제로 만들어 둔다.
// ---------------------------------------------------------------------------
function fakeCtx(label, { wheelCount = 3, skip = [] } = {}) {
  const root = path.join(tmp, label);
  fs.mkdirSync(root, { recursive: true });
  const payloadDir = path.join(root, '_payload');
  fs.mkdirSync(payloadDir, { recursive: true });

  const lock = {
    parts: {
      python: { dest: '_agent/shared/tools/python' },
      uv: { dest: '_agent/shared/tools/uv/0.12.14' },
      pyyaml: { file: 'runtime/pyyaml-fake.whl' },
      'document-mcp-wheelhouse': {
        dest: '_agent/shared/tools/python-wheelhouse/document-mcp',
        expectedCount: wheelCount,
      },
    },
  };

  const pythonDest = path.join(root, '_agent', 'shared', 'tools', 'python');
  const uvDest = path.join(root, '_agent', 'shared', 'tools', 'uv', '0.12.14');
  const wheelhouseDest = path.join(root, '_agent', 'shared', 'tools', 'python-wheelhouse', 'document-mcp');
  const pyyamlWheel = path.join(payloadDir, 'runtime', 'pyyaml-fake.whl');

  const paths = {
    pythonExe: path.join(pythonDest, 'python.exe'),
    uvExe: path.join(uvDest, 'uv.exe'),
    wheelhouseDest,
    pyyamlWheel,
    venvDir: path.join(root, '_agent', 'runtime', 'venvs', 'document-mcp'),
    venvPython: path.join(root, '_agent', 'runtime', 'venvs', 'document-mcp', 'Scripts', 'python.exe'),
  };

  if (!skip.includes('python')) {
    fs.mkdirSync(pythonDest, { recursive: true });
    fs.writeFileSync(paths.pythonExe, 'fake python.exe');
  }
  if (!skip.includes('uv')) {
    fs.mkdirSync(uvDest, { recursive: true });
    fs.writeFileSync(paths.uvExe, 'fake uv.exe');
  }
  if (!skip.includes('wheelhouse')) {
    fs.mkdirSync(wheelhouseDest, { recursive: true });
    for (let i = 0; i < wheelCount; i += 1) {
      fs.writeFileSync(path.join(wheelhouseDest, `pkg${i}-1.0-py3-none-any.whl`), `wheel ${i}`);
    }
  }
  if (!skip.includes('pyyaml')) {
    fs.mkdirSync(path.dirname(paths.pyyamlWheel), { recursive: true });
    fs.writeFileSync(paths.pyyamlWheel, 'fake pyyaml wheel');
  }

  return {
    root, payloadDir, lock, paths, fs, log: () => {}, env: { FAKE_ENV: '1' },
  };
}

function makeFakeRun(paths, over = {}) {
  const calls = [];
  const queues = {};
  const next = (key, fallback) => {
    if (!(key in queues)) queues[key] = Array.isArray(over[key]) ? [...over[key]] : null;
    const q = queues[key];
    if (q) return q.length > 1 ? q.shift() : q[0];
    return over[key] ?? fallback;
  };
  const run = async (exe, args, opts) => {
    calls.push({ exe, args: args.slice(), opts: { ...opts, env: { ...opts.env } } });
    if (exe === paths.uvExe && args[0] === 'venv') {
      // 실제 `uv venv`가 파이썬을 그 자리에 놓는 것을 흉내낸다 -- 이후 존재
      // 확인(probeInstalledCount)이 실제 fs 를 보므로 반드시 필요하다.
      fs.mkdirSync(path.dirname(paths.venvPython), { recursive: true });
      fs.writeFileSync(paths.venvPython, 'fake venv python.exe');
      return next('venv', OK);
    }
    if (exe === paths.uvExe && args[0] === 'pip' && args[1] === 'list') return next('list', okList(0));
    if (exe === paths.uvExe && args[0] === 'pip' && args[1] === 'install') {
      if (args.includes(paths.venvPython)) return next('install', OK);
      if (args.includes(paths.pythonExe)) return next('yamlInstall', OK);
      return OK;
    }
    if (exe === paths.venvPython && args[0] === '-c') return next('venvCheck', okImportCheck());
    if (exe === paths.pythonExe && args[0] === '-c') return next('yamlProbe', okYaml(true));
    return OK;
  };
  return { run, calls };
}

function withRun(ctx, over) {
  const { run, calls } = makeFakeRun(ctx.paths, over);
  return { ctx: { ...ctx, run }, calls };
}

// ---------------------------------------------------------------------------
// 1) 필수 부품 누락 -> StageError(E-VENV)
// ---------------------------------------------------------------------------

test('venv: python.exe 가 없으면 E-VENV', async () => {
  const base = fakeCtx('miss-python', { skip: ['python'] });
  const { ctx } = withRun(base, {});
  await assert.rejects(() => venv.run(ctx), (e) => e.name === 'StageError' && e.code === 'E-VENV');
});

test('venv: uv.exe 가 없으면 E-VENV', async () => {
  const base = fakeCtx('miss-uv', { skip: ['uv'] });
  const { ctx } = withRun(base, {});
  await assert.rejects(() => venv.run(ctx), (e) => e.name === 'StageError' && e.code === 'E-VENV');
});

test('venv: wheelhouse 폴더가 없으면 E-VENV', async () => {
  const base = fakeCtx('miss-wh', { skip: ['wheelhouse'] });
  const { ctx } = withRun(base, {});
  await assert.rejects(() => venv.run(ctx), (e) => e.name === 'StageError' && e.code === 'E-VENV');
});

test('venv: wheelhouse 가 비어 있으면 E-VENV', async () => {
  const base = fakeCtx('empty-wh', { wheelCount: 0 });
  const { ctx } = withRun(base, {});
  await assert.rejects(() => venv.run(ctx), (e) => e.name === 'StageError' && e.code === 'E-VENV');
});

test('venv: PyYAML 바퀴가 없으면 E-VENV', async () => {
  const base = fakeCtx('miss-pyyaml', { skip: ['pyyaml'] });
  const { ctx } = withRun(base, {});
  await assert.rejects(() => venv.run(ctx), (e) => e.name === 'StageError' && e.code === 'E-VENV');
});

// ---------------------------------------------------------------------------
// 2) 정상 경로: 새로 만들기 -- 명령 순서·인자·환경변수
// ---------------------------------------------------------------------------

test('venv: venv 가 없으면 만들고, 설치·검증 명령을 정확한 인자로 실행한다', async () => {
  const base = fakeCtx('create', { wheelCount: 3 });
  const { ctx, calls } = withRun(base, {
    list: [okList(0), okList(3)], // 생성 직후엔 0개, 설치 뒤엔 3개
  });

  const { recorded, pending } = await venv.run(ctx);
  assert.deepEqual(pending, []);

  assert.equal(recorded.venv.created, true);
  assert.equal(recorded.venv.kept, false);
  assert.equal(recorded.counts.installed, 3);
  assert.equal(recorded.counts.wheelhouse, 3);
  assert.equal(recorded.keyModules.ok, true);
  assert.equal(recorded.pyyaml.installed, false, 'probe 가 이미 통과하면 설치하지 않는다');
  assert.equal(recorded.pyyaml.kept, true);

  const venvCall = calls.find((c) => c.exe === ctx.paths.uvExe && c.args[0] === 'venv');
  assert.deepEqual(venvCall.args, ['venv', '--python', ctx.paths.pythonExe, ctx.paths.venvDir]);

  const installCall = calls.find((c) => c.exe === ctx.paths.uvExe && c.args[0] === 'pip' && c.args[1] === 'install' && c.args.includes(ctx.paths.venvPython));
  assert.ok(installCall, '설치 명령이 실행되지 않았다');
  assert.ok(installCall.args.includes('--offline'));
  assert.ok(installCall.args.includes('--no-index'));
  assert.ok(installCall.args.includes('--find-links'));
  assert.ok(installCall.args.includes(ctx.paths.wheelhouseDest));
  for (let i = 0; i < 3; i += 1) {
    assert.ok(installCall.args.includes(path.join(ctx.paths.wheelhouseDest, `pkg${i}-1.0-py3-none-any.whl`)), `바퀴 ${i} 가 설치 인자에 없다`);
  }

  const listCalls = calls.filter((c) => c.exe === ctx.paths.uvExe && c.args[0] === 'pip' && c.args[1] === 'list');
  for (const c of listCalls) assert.ok(c.args.includes('--format') && c.args.includes('json'));

  // 모든 호출에 오프라인·UTF-8 환경이 실려야 한다.
  for (const c of calls) {
    assert.equal(c.opts.env.PYTHONUTF8, '1');
    assert.equal(c.opts.env.PYTHONIOENCODING, 'utf-8');
    assert.equal(c.opts.env.UV_OFFLINE, '1');
    assert.equal(c.opts.env.FAKE_ENV, '1', 'ctx.env 의 다른 값도 이어져야 한다');
  }
});

test('venv: wheelhouse 안에 requirements.lock 이 있으면 -r 로 설치한다', async () => {
  const base = fakeCtx('reqlock', { wheelCount: 2 });
  fs.writeFileSync(path.join(base.paths.wheelhouseDest, 'requirements.lock'), '# lock\n');
  const { ctx, calls } = withRun(base, { list: [okList(0), okList(2)] });
  const { recorded } = await venv.run(ctx);
  assert.equal(recorded.installSource, 'requirements.lock');
  const installCall = calls.find((c) => c.args[0] === 'pip' && c.args[1] === 'install' && c.args.includes(ctx.paths.venvPython));
  assert.ok(installCall.args.includes('-r'));
  assert.ok(installCall.args.includes(path.join(ctx.paths.wheelhouseDest, 'requirements.lock')));
});

// ---------------------------------------------------------------------------
// 3) 멱등: venv 가 이미 있고 개수가 충분하면 kept 로 건너뛴다
// ---------------------------------------------------------------------------

test('venv: venv 가 이미 있고 개수가 충분하면 다시 만들지도 설치하지도 않는다(kept)', async () => {
  const base = fakeCtx('kept', { wheelCount: 3 });
  fs.mkdirSync(path.dirname(base.paths.venvPython), { recursive: true });
  fs.writeFileSync(base.paths.venvPython, 'fake venv python.exe');
  const { ctx, calls } = withRun(base, { list: okList(5) }); // 5 >= 기대 3

  const { recorded } = await venv.run(ctx);
  assert.equal(recorded.venv.created, false);
  assert.equal(recorded.venv.kept, true);
  assert.equal(recorded.installSource, 'kept');

  const venvCreateCalls = calls.filter((c) => c.args[0] === 'venv');
  const installCalls = calls.filter((c) => c.args[0] === 'pip' && c.args[1] === 'install' && c.args.includes(ctx.paths.venvPython));
  assert.equal(venvCreateCalls.length, 0, 'venv 생성 명령을 다시 부르면 안 된다');
  assert.equal(installCalls.length, 0, '설치 명령을 다시 부르면 안 된다');
});

test('venv: kept 경로(개수 충분)라도 핵심 모듈 임포트 검증은 건너뛰지 않는다 -- 실패하면 E-VENV', async () => {
  const base = fakeCtx('kept-import-fail', { wheelCount: 3 });
  fs.mkdirSync(path.dirname(base.paths.venvPython), { recursive: true });
  fs.writeFileSync(base.paths.venvPython, 'fake venv python.exe');
  const { ctx, calls } = withRun(base, {
    list: okList(5), // 5 >= 기대 3 -> kept
    venvCheck: failImportCheck('pypdf'),
  });

  await assert.rejects(() => venv.run(ctx), (e) => e.name === 'StageError' && e.code === 'E-VENV');

  const installCalls = calls.filter((c) => c.args[0] === 'pip' && c.args[1] === 'install' && c.args.includes(ctx.paths.venvPython));
  assert.equal(installCalls.length, 0, 'kept 경로라 설치 명령은 여전히 부르면 안 된다');
});

test('venv: venv 는 있지만 개수가 모자라면 다시 설치한다', async () => {
  const base = fakeCtx('short', { wheelCount: 3 });
  fs.mkdirSync(path.dirname(base.paths.venvPython), { recursive: true });
  fs.writeFileSync(base.paths.venvPython, 'fake venv python.exe');
  const { ctx, calls } = withRun(base, { list: [okList(1), okList(3)] }); // 처음엔 모자람, 설치 후 충분

  const { recorded } = await venv.run(ctx);
  assert.equal(recorded.venv.kept, false);
  const installCalls = calls.filter((c) => c.args[0] === 'pip' && c.args[1] === 'install' && c.args.includes(ctx.paths.venvPython));
  assert.equal(installCalls.length, 1, '모자라면 설치를 시도해야 한다');
});

test('venv: 설치 후에도 개수가 모자라면 E-VENV', async () => {
  const base = fakeCtx('still-short', { wheelCount: 3 });
  const { ctx } = withRun(base, { list: [okList(0), okList(1)] });
  await assert.rejects(() => venv.run(ctx), (e) => e.code === 'E-VENV');
});

// ---------------------------------------------------------------------------
// 4) 5개 핵심 모듈 임포트 검증
// ---------------------------------------------------------------------------

test('venv: 핵심 모듈 임포트가 하나라도 실패하면 E-VENV', async () => {
  const base = fakeCtx('import-fail', { wheelCount: 3 });
  const { ctx } = withRun(base, { list: [okList(0), okList(3)], venvCheck: failImportCheck('mcp') });
  await assert.rejects(() => venv.run(ctx), (e) => e.code === 'E-VENV');
});

// 2026-09-16 VM S01 실측(2.0.0): 한컴 없는 PC 에서 `import pyhwpx` 가 COM 형식
// 라이브러리 미등록(com_error -2147319779)으로 실패해 세팅 전체가 E-VENV 로 멈췄다.
// 한컴 없음은 checks 단계의 pending 이지 설치 실패가 아니므로 pyhwpx 는 SOFT 다.
test('appControlBlocked: 스마트 앱 컨트롤이 .pyd 를 막은 흔적(한국어·영어)만 참', () => {
  assert.equal(venv.appControlBlocked({ failed: [['mcp', { ok: false, error: 'DLL load failed while importing unicodedata: 애플리케이션 제어 정책에서 이 파일을 차단했습니다.' }]] }), true);
  assert.equal(venv.appControlBlocked({ failed: [['mcp', { ok: false, error: 'DLL load failed while importing _decimal: Your organization used Windows Defender Application Control policy to block this file.' }]] }), true);
  assert.equal(venv.appControlBlocked({ failed: [['pypdf', { ok: false, error: "No module named 'pypdf'" }]] }), false);
  assert.equal(venv.appControlBlocked(null), false);
});

test('venv: 앱 제어 정책 차단이면 E-VENV 문구가 SAC 끄는 길을 안내한다', async () => {
  const base = fakeCtx('import-sac', { wheelCount: 3 });
  const blocked = { code: 0, out: `${JSON.stringify({ imports: Object.fromEntries(venv.KEY_MODULES.map((m) => [m, { ok: false, error: 'DLL load failed while importing unicodedata: 애플리케이션 제어 정책에서 이 파일을 차단했습니다.' }])), leaks: [] })}\n`, err: '' };
  const { ctx } = withRun(base, { list: [okList(0), okList(3)], venvCheck: blocked });
  await assert.rejects(() => venv.run(ctx), (e) => e.code === 'E-VENV' && /스마트 앱 컨트롤/.test(e.message));
});

test('venv: pyhwpx(SOFT) 임포트 실패는 E-VENV 가 아니라 기록으로 남고 세팅은 계속된다', async () => {
  assert.deepEqual(venv.SOFT_MODULES, ['pyhwpx']);
  const base = fakeCtx('import-soft', { wheelCount: 3 });
  const logs = [];
  base.log = (m) => logs.push(m);
  const { ctx } = withRun(base, { list: [okList(0), okList(3)], venvCheck: failImportCheck('pyhwpx') });
  const { recorded } = await venv.run(ctx);
  assert.equal(recorded.keyModules.ok, true);
  assert.equal(recorded.keyModules.soft.pyhwpx.ok, false);
  assert.ok(logs.some((l) => l.includes('pyhwpx') && l.includes('pending')), 'pyhwpx 를 건너뛴 사실을 로그에 남긴다');
});

// ---------------------------------------------------------------------------
// 5) 격리 감사(leak) -- venv 쪽
// ---------------------------------------------------------------------------

test('venv: sys.modules 감사에서 root 밖 모듈이 잡히면 E-VENV', async () => {
  const base = fakeCtx('leak', { wheelCount: 3 });
  const leaks = [{ module: 'somepkg', file: 'C:\\Python312\\Lib\\site-packages\\somepkg\\__init__.py' }];
  const { ctx } = withRun(base, { list: [okList(0), okList(3)], venvCheck: okImportCheck({ leaks }) });
  await assert.rejects(() => venv.run(ctx), (e) => e.code === 'E-VENV' && Array.isArray(e.detail?.leaks) && e.detail.leaks.length === 1);
});

test('venv: 런타임 PyYAML 이 root 밖을 가리키면 E-VENV', async () => {
  const base = fakeCtx('yaml-leak', { wheelCount: 3 });
  const { ctx } = withRun(base, {
    list: [okList(0), okList(3)],
    yamlProbe: okYaml(true, {
      leaks: [{ module: 'yaml', file: 'C:\\Python312\\Lib\\site-packages\\yaml\\__init__.py' }],
      file: 'C:\\Python312\\Lib\\site-packages\\yaml\\__init__.py',
    }),
  });
  await assert.rejects(() => venv.run(ctx), (e) => e.code === 'E-VENV');
});

// ---------------------------------------------------------------------------
// 6) isLeakAuditExempt -- __main__/__mp_main__/win32com.gen_py.* 만 예외
// ---------------------------------------------------------------------------

test('isLeakAuditExempt: __main__·__mp_main__·win32com.gen_py.* 만 예외로 뺀다', () => {
  assert.equal(venv.isLeakAuditExempt('__main__'), true);
  assert.equal(venv.isLeakAuditExempt('__mp_main__'), true);
  assert.equal(venv.isLeakAuditExempt('win32com.gen_py'), true);
  assert.equal(venv.isLeakAuditExempt('win32com.gen_py.3.12'), true);
  assert.equal(venv.isLeakAuditExempt('win32com'), false, 'win32com 본체는 예외가 아니다(실제 site-packages 안에 있어야 정상)');
  assert.equal(venv.isLeakAuditExempt('some_leaked_pkg'), false);
});

test('buildImportCheckScript: 파이썬 소스 자체가 __main__·win32com.gen_py 를 건너뛰는 조건을 담고 있다', () => {
  const script = venv.buildImportCheckScript('C:\\soul', venv.KEY_MODULES);
  assert.ok(script.includes('__main__'));
  assert.ok(script.includes('__mp_main__'));
  assert.ok(script.includes('win32com.gen_py'));
  for (const m of venv.KEY_MODULES) assert.ok(script.includes(m), `${m} 임포트가 스크립트에 없다`);
});

// ---------------------------------------------------------------------------
// 7) PyYAML: probe 가 실패할 때만 설치한다(unpack.mjs 가 이미 놓아 뒀으면
//    안전망일 뿐 아무 일도 하지 않는다).
// ---------------------------------------------------------------------------

test('venv: 런타임에 PyYAML 이 없으면 uv 로 설치하고 재확인한다', async () => {
  const base = fakeCtx('pyyaml-install', { wheelCount: 2 });
  const { ctx, calls } = withRun(base, {
    list: [okList(0), okList(2)],
    yamlProbe: [okYaml(false), okYaml(true)],
  });
  const { recorded } = await venv.run(ctx);
  assert.equal(recorded.pyyaml.installed, true);
  assert.equal(recorded.pyyaml.kept, false);
  const yamlInstallCall = calls.find((c) => c.args[0] === 'pip' && c.args[1] === 'install' && c.args.includes(ctx.paths.pythonExe));
  assert.ok(yamlInstallCall, 'PyYAML 설치 명령이 실행되지 않았다');
  assert.ok(yamlInstallCall.args.includes(ctx.paths.pyyamlWheel));
  assert.ok(yamlInstallCall.args.includes('--offline'));
  assert.ok(yamlInstallCall.args.includes('--no-index'));
});

test('venv: PyYAML 설치 후에도 임포트가 안 되면 E-VENV', async () => {
  const base = fakeCtx('pyyaml-fail', { wheelCount: 2 });
  const { ctx } = withRun(base, {
    list: [okList(0), okList(2)],
    yamlProbe: [okYaml(false), okYaml(false)],
  });
  await assert.rejects(() => venv.run(ctx), (e) => e.code === 'E-VENV');
});

// ---------------------------------------------------------------------------
// 8) locateParts -- venv 자리는 adapters.mjs 의 venvPythonPath 와 글자 그대로
//    같아야 한다(이 파일 머리말에 적은 lock.json 불일치 발견 사항).
// ---------------------------------------------------------------------------

test('locateParts: venv 자리는 adapters.mjs 의 venvPythonPath 관례(_agent/runtime/venvs/document-mcp)를 쓴다', () => {
  const base = fakeCtx('locate');
  const parts = venv.locateParts(base);
  assert.equal(parts.venvDir, path.join(base.root, '_agent', 'runtime', 'venvs', 'document-mcp'));
  assert.equal(parts.venvPython, path.join(base.root, '_agent', 'runtime', 'venvs', 'document-mcp', 'Scripts', 'python.exe'));
  assert.notEqual(
    parts.venvDir,
    path.join(base.root, '_agent', 'shared', 'tools', 'python-envs', 'document-mcp'),
    'lock.json 의 document-mcp-wheelhouse.venv 필드(stale)를 쓰면 안 된다',
  );
});

// ---------------------------------------------------------------------------
// 9) 통합 시험 -- 실제 빌드 payload 로 진짜 오프라인 venv + MCP 서버를 돌린다.
// ---------------------------------------------------------------------------

function extractTarOrZip(archive, destDir, { strip = 0 } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const args = ['-xf', archive, '-C', destDir];
  if (strip > 0) args.push(`--strip-components=${strip}`);
  const r = spawnSync(TAR, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `tar 추출 실패(${archive}): ${r.stderr}`);
}

test('통합: 실제 payload 로 43개 바퀴 offline venv 를 만들고 pdf-automation MCP 를 stdio 로 확인한다', { timeout: 300000 }, async (t) => {
  if (!fs.existsSync(BUILD_PAYLOAD)) {
    t.skip('이 PC에 _build\\stage\\payload 빌드 산출물이 없다');
    return;
  }
  const lockPath = path.join(REPO, 'lock.json');
  if (!fs.existsSync(lockPath)) {
    t.skip('lock.json 이 없다');
    return;
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const pythonPart = lock.parts?.python;
  const uvPart = lock.parts?.uv;
  const wheelhousePart = lock.parts?.['document-mcp-wheelhouse'];
  const pdfPart = lock.parts?.['pdf-automation'];
  if (!pythonPart || !uvPart || !wheelhousePart || !pdfPart) {
    t.skip('lock.json 에 필요한 부품 항목이 없다');
    return;
  }

  const pythonArchive = path.join(BUILD_PAYLOAD, pythonPart.file);
  const uvArchive = path.join(BUILD_PAYLOAD, uvPart.file);
  const wheelhouseSrc = path.join(BUILD_PAYLOAD, wheelhousePart.file);
  const pdfArchive = path.join(BUILD_PAYLOAD, pdfPart.file);
  if (![pythonArchive, uvArchive, wheelhouseSrc, pdfArchive].every((p) => fs.existsSync(p))) {
    t.skip('빌드 payload 안에 python/uv/wheelhouse/pdf-automation 부품이 없다');
    return;
  }

  const dir = path.join(tmp, 'i');
  const root = path.join(dir, 's');
  fs.mkdirSync(root, { recursive: true });

  // tar.exe(bsdtar, C:\Windows\System32\tar.exe)는 소스 경로 인자를 콘솔
  // 코드페이지로 변환해 여는데, 이 저장소 경로에 든 한글·반전각 괄호
  // 〖 〗는 그 변환에서 깨진다(실측 예시 -- 실제 값은 이 저장소 루트 경로이며
  // 아래는 그 모양만 보여주는 자리표시자: "Error opening archive: Failed to
  // open 'X:\SOUL\R07-\xEF\xBF\xBD...'"). uv.exe·python.exe는 와이드
  // 문자 API 를 쓰는 정상적인 프로그램이라 이 문제가 없고(venv.mjs 자체는
  // tar 를 전혀 쓰지 않는다), 오직 "이 시험이 고정 fixture 를 만들려고
  // tar 로 원본 payload 를 푸는" 단계만 걸린다. 그래서 tar 에 넘길
  // 원본만 순수 아스키 스테이징 폴더로 먼저 복사한 뒤 그걸 푼다.
  const stageDir = path.join(dir, '_archives');
  fs.mkdirSync(stageDir, { recursive: true });
  function stageForTar(srcPath) {
    const dest = path.join(stageDir, path.basename(srcPath));
    fs.copyFileSync(srcPath, dest);
    return dest;
  }

  const t0 = Date.now();
  // python: install_only 묶음 -- strip 1(최상위 python/ 한 겹)이라 압축을
  // 풀면 <dest>\python.exe 가 바로 나온다.
  const pythonDest = path.join(root, '_agent', 'shared', 'tools', 'python');
  extractTarOrZip(stageForTar(pythonArchive), pythonDest, { strip: 1 });
  const tPython = Date.now();

  // uv: 바퀴(zip) 그대로 풀어 둔다 -- 일부러 hoist 하지 않고 venv.mjs 의
  // 재귀 탐색 대비책이 uv.exe 를 스스로 찾아내는지도 함께 확인한다.
  const uvDest = path.join(root, '_agent', 'shared', 'tools', 'uv', '0.12.14');
  extractTarOrZip(stageForTar(uvArchive), uvDest);
  const tUv = Date.now();

  // wheelhouse: .whl 43개를 평평하게 복사.
  const wheelhouseDest = path.join(root, '_agent', 'shared', 'tools', 'python-wheelhouse', 'document-mcp');
  fs.mkdirSync(wheelhouseDest, { recursive: true });
  for (const f of fs.readdirSync(wheelhouseSrc)) {
    if (f.toLowerCase().endsWith('.whl')) fs.copyFileSync(path.join(wheelhouseSrc, f), path.join(wheelhouseDest, f));
  }
  const wheelCount = fs.readdirSync(wheelhouseDest).filter((f) => f.toLowerCase().endsWith('.whl')).length;
  assert.equal(wheelCount, wheelhousePart.expectedCount);

  // pdf-automation: MCP 서버 zip.
  const pdfDest = path.join(root, '_agent', 'shared', 'tools', 'document-mcp', 'pdf', 'b8acf47');
  extractTarOrZip(stageForTar(pdfArchive), pdfDest);
  const tSetup = Date.now();

  // ctx: payloadDir 을 진짜 빌드 payload 로 두면 partPath(ctx,'pyyaml') 이
  // 실제 PyYAML 바퀴를 그대로 가리킨다. uv.exe/python.exe 는 와이드 문자
  // API 를 쓰는 정상적인 프로그램이라(위 tar 주석 참고) 이 경로를 그대로
  // 인자로 넘겨도 깨지지 않는다 -- 그래서 큰 파일을 또 복사할 필요가 없다.
  const ctx = {
    root,
    payloadDir: BUILD_PAYLOAD,
    lock,
    log: () => {},
    run: realRun,
    fs,
    env: process.env,
  };

  const result1 = await venv.run(ctx);
  const tVenv1 = Date.now();

  assert.equal(result1.recorded.venv.created, true);
  assert.equal(result1.recorded.counts.installed >= wheelhousePart.expectedCount, true);
  assert.equal(result1.recorded.keyModules.ok, true);
  assert.equal(result1.recorded.isolationCheck.venvLeaks.length, 0, `venv 격리 감사에서 예상 못한 누출: ${JSON.stringify(result1.recorded.isolationCheck.venvLeaks)}`);
  assert.equal(result1.recorded.isolationCheck.runtimeYaml.leaks.length, 0, `런타임 PyYAML 격리 감사에서 예상 못한 누출: ${JSON.stringify(result1.recorded.isolationCheck.runtimeYaml.leaks)}`);

  const venvPython = path.join(root, '_agent', 'runtime', 'venvs', 'document-mcp', 'Scripts', 'python.exe');
  assert.ok(fs.existsSync(venvPython), 'venv python.exe 가 만들어지지 않았다');

  // 두 번째 실행 -- kept 로 아무 것도 다시 하지 않아야 한다.
  const result2 = await venv.run(ctx);
  const tVenv2 = Date.now();
  assert.equal(result2.recorded.venv.kept, true);
  assert.equal(result2.recorded.installSource, 'kept');
  assert.equal(result2.recorded.pyyaml.kept, true);

  // 실제 pdf-automation MCP 서버와 표준입출력 JSON-RPC(개행-구분 JSON, 헤더 없음).
  const serverPy = path.join(pdfDest, pdfPart.entry ?? 'server.py');
  assert.ok(fs.existsSync(serverPy), 'pdf-automation server.py 가 없다');

  const clientScript = [
    'import sys, subprocess, json, os',
    'sys.stdout.reconfigure(encoding="utf-8", errors="replace")',
    'venv_python, server_py = sys.argv[1], sys.argv[2]',
    'env = dict(os.environ)',
    'env["PYTHONUTF8"] = "1"',
    'env["PYTHONIOENCODING"] = "utf-8"',
    'proc = subprocess.Popen([venv_python, server_py], stdin=subprocess.PIPE, stdout=subprocess.PIPE,',
    '                        stderr=subprocess.PIPE, cwd=os.path.dirname(server_py), env=env, text=True, encoding="utf-8")',
    'def send(msg):',
    '    proc.stdin.write(json.dumps(msg) + "\\n"); proc.stdin.flush()',
    'def recv():',
    '    line = proc.stdout.readline()',
    '    return json.loads(line) if line.strip() else None',
    'try:',
    '    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "t15-test", "version": "0.0.1"}}})',
    '    init_resp = recv()',
    '    send({"jsonrpc": "2.0", "method": "notifications/initialized"})',
    '    send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})',
    '    tools_resp = recv()',
    '    print(json.dumps({"init": init_resp, "tools": tools_resp}))',
    'finally:',
    '    proc.terminate()',
    '    try:',
    '        proc.wait(timeout=5)',
    '    except Exception:',
    '        proc.kill()',
  ].join('\n');
  const clientPath = path.join(dir, 'rpc_client.py');
  fs.writeFileSync(clientPath, clientScript, 'utf8');

  const rpc = spawnSync(venvPython, [clientPath, venvPython, serverPy], { encoding: 'utf8', timeout: 30000 });
  assert.equal(rpc.status, 0, `JSON-RPC 클라이언트 실행 실패: ${rpc.stderr}`);
  const parsed = JSON.parse(rpc.stdout.trim().split('\n').pop());
  assert.equal(parsed.init?.result?.serverInfo?.name, 'pdf-automation');
  assert.ok(Array.isArray(parsed.tools?.result?.tools) && parsed.tools.result.tools.length > 0, 'tools/list 가 빈 목록을 돌려줬다');

  const tRpc = Date.now();
  t.diagnostic(`추출: python ${tPython - t0}ms, uv ${tUv - tPython}ms, wheelhouse+pdf ${tSetup - tUv}ms / venv 1차 ${tVenv1 - tSetup}ms, 2차(kept) ${tVenv2 - tVenv1}ms / MCP 확인 ${tRpc - tVenv2}ms`);
});
