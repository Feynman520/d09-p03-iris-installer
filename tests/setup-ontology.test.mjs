import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ontology from '../installer/setup/ontology.mjs';
import * as skeleton from '../installer/setup/skeleton.mjs';
import * as structure from '../installer/setup/structure.mjs';
import { run as realRun } from '../lib/run.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_SRC = path.join(REPO, 'payload-src', 'policy');
const REAL_IRIS = 'C:\\IRIS';
const REAL_ONT = path.join(REAL_IRIS, '_ontology');
const SPEC_NAME = 'IRIS-온톨로지.md';
const REAL_SPEC = path.join(REAL_IRIS, SPEC_NAME);

// 접두사도 짧게(윈도우 MAX_PATH 여유 확보 -- 아래 통합 시험 주석 참고).
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 't17-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// 단위 시험용 가짜 ctx.run — 스크립트 이름+인자로 미리 정해 둔 응답을 돌려준다.
// ---------------------------------------------------------------------------

function fakeCtx(label, { responses = {}, env } = {}) {
  const root = path.join(tmp, label);
  fs.mkdirSync(root, { recursive: true });
  const calls = [];
  const run = async (exe, args, opts) => {
    calls.push({ exe, args: args.slice(), opts: { ...opts } });
    const script = path.basename(String(args[0] ?? ''));
    const key = [script, ...args.slice(1)].join(' ');
    const r = responses[key];
    if (typeof r === 'function') return r({ exe, args, opts });
    return r ?? { code: 0, out: '', err: '' };
  };
  const logs = [];
  return {
    root, calls, logs,
    log: (line) => logs.push(line),
    run,
    fs,
    env: env ?? { FAKE_ENV: '1' },
  };
}

const R_INIT = 'build_graph.py --init --write';
const R_COMPILE = 'build_graph.py --compile';
const R_VALIDATE = 'validate.py';
const R_RENDER = 'render_view.py';
const R_FRESH = 'check_fresh.py';

const OK = { code: 0, out: '', err: '' };

function baseResponses(overrides = {}) {
  return {
    [R_INIT]: { code: 0, out: '머리말 씀 3 · 롤백 사본 격리 0 · 리포트 x · 로그 y\n그래프 컴파일 → _ontology/graph.json', err: '' },
    [R_COMPILE]: { code: 0, out: 'graph.json: 노드 12 · 간선 9', err: '' },
    [R_VALIDATE]: {
      code: 0,
      out: [
        '리포트 → _cleanup/리포트/2026-09-15-검증-전체.md',
        '검사     층   대상   통과   실패 판독불능  상태',
        '전제형식 1     5     5     0       0  완료',
        '전제정합 2     5     5     0       0  완료',
        '#1      1     3     3     0       0  완료',
      ].join('\n'),
      err: '',
    },
    [R_RENDER]: { code: 0, out: 'View generated: IRIS-온톨로지-뷰.html (3 view items)', err: '' },
    [R_FRESH]: { code: 0, out: '신선함', err: '' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) 명령 순서·인자·환경
// ---------------------------------------------------------------------------

test('ontology: 다섯 명령을 정확한 순서·경로·인자로 실행한다(구 build_map.py 없음)', async () => {
  const ctx = fakeCtx('seq', { responses: baseResponses() });
  const { recorded, pending } = await ontology.run(ctx);

  assert.deepEqual(pending, []);
  assert.equal(ctx.calls.length, 5, '명령이 정확히 5개여야 한다(구 build_map.py 단계 없음)');

  const ontDir = path.join(ctx.root, '_ontology');
  const expected = [
    [path.join(ontDir, 'build_graph.py'), '--init', '--write'],
    [path.join(ontDir, 'build_graph.py'), '--compile'],
    [path.join(ontDir, 'validate.py')],
    [path.join(ontDir, 'render_view.py')],
    [path.join(ontDir, 'check_fresh.py')],
  ];
  for (let i = 0; i < expected.length; i += 1) {
    assert.deepEqual(ctx.calls[i].args, expected[i], `${i}번째 명령 인자가 다르다`);
    assert.equal(ctx.calls[i].exe, 'python');
    assert.equal(ctx.calls[i].opts.cwd, ctx.root);
  }
  assert.ok(
    !ctx.calls.some((c) => c.args.some((a) => String(a).includes('build_map'))),
    '퇴역한 build_map.py 를 호출하면 안 된다',
  );

  assert.equal(recorded.commands.length, 5);
  assert.equal(recorded.counts.cardsWritten, 3);
  assert.equal(recorded.counts.graphNodes, 12);
  assert.equal(recorded.counts.graphEdges, 9);
  assert.equal(recorded.viewPath, path.join(ctx.root, 'IRIS-온톨로지-뷰.html'));
  assert.equal(recorded.commands.at(-1).classification, '통과');
});

test('ontology: 환경변수에 PYTHONUTF8·PYTHONIOENCODING·PYTHONPATH 를 주입한다', async () => {
  const ctx = fakeCtx('env-fresh', { responses: baseResponses() });
  await ontology.run(ctx);
  const ontDir = path.join(ctx.root, '_ontology');
  for (const call of ctx.calls) {
    assert.equal(call.opts.env.PYTHONUTF8, '1');
    assert.equal(call.opts.env.PYTHONIOENCODING, 'utf-8');
    assert.equal(call.opts.env.PYTHONPATH, ontDir, '기존 PYTHONPATH 가 없을 때는 온톨로지 폴더 그대로');
    assert.equal(call.opts.env.FAKE_ENV, '1', 'ctx.env 의 다른 값도 그대로 이어져야 한다');
  }
});

test('ontology: 기존 PYTHONPATH 가 있으면 온톨로지 폴더를 앞자리에 붙인다', async () => {
  const ctx = fakeCtx('env-existing', {
    responses: baseResponses(),
    env: { PYTHONPATH: 'C:\\기존경로' },
  });
  await ontology.run(ctx);
  const ontDir = path.join(ctx.root, '_ontology');
  const want = `${ontDir}${path.delimiter}C:\\기존경로`;
  for (const call of ctx.calls) {
    assert.equal(call.opts.env.PYTHONPATH, want);
  }
});

// ---------------------------------------------------------------------------
// 2) validate.py 분류 — 종료코드가 아니라 표를 읽는다. 3층 실패는 경고.
// ---------------------------------------------------------------------------

test('classifyValidate: 모두 통과 표는 통과로 분류한다', () => {
  const out = [
    '리포트 → x.md',
    '검사     층   대상   통과   실패 판독불능  상태',
    '전제형식 1     5     5     0       0  완료',
    '전제정합 2     5     5     0       0  완료',
    '#1      1     3     3     0       0  완료',
    '#13     3     2     2     0       0  완료',
  ].join('\n');
  const c = ontology.classifyValidate({ code: 0, out, err: '' });
  assert.equal(c.overall, '통과');
  assert.equal(c.failCount, 0);
  assert.equal(c.warnCount, 0);
  assert.equal(c.reportPath, 'x.md');
  assert.equal(c.rows.length, 4);
});

test('classifyValidate: 3층(규칙) 실패는 실패가 아니라 경고 — 사람 결정 대기, StageError 아님', () => {
  const out = [
    '리포트 → x.md',
    '검사     층   대상   통과   실패 판독불능  상태',
    '전제형식 1     5     5     0       0  완료',
    '전제정합 2     5     5     0       0  완료',
    '#13     3     2     1     1       0  완료',
  ].join('\n');
  const c = ontology.classifyValidate({ code: 0, out, err: '' });
  assert.equal(c.overall, '경고', '3층 실패는 전체를 경고로만 올려야 한다');
  assert.equal(c.warnCount, 1);
  assert.equal(c.failCount, 0, '3층 실패를 실패 건수에 넣으면 안 된다');
});

test('classifyValidate: 1·2층 실패는 진짜 실패로 분류한다', () => {
  const out = [
    '리포트 → x.md',
    '검사     층   대상   통과   실패 판독불능  상태',
    '전제형식 1     5     4     1       0  완료',
    '전제정합 2     5     5     0       0  완료',
  ].join('\n');
  const c = ontology.classifyValidate({ code: 0, out, err: '' });
  assert.equal(c.overall, '실패');
  assert.equal(c.failCount, 1);
  assert.equal(c.warnCount, 0);
});

test('classifyValidate: 대상 0(대기)인 검사는 실패·경고에 넣지 않는다', () => {
  const out = [
    '리포트 → x.md',
    '검사     층   대상   통과   실패 판독불능  상태',
    '전제형식 1     0     0     0       0  대기(대상 없음)',
    '#2      1     0     0     0       0  대기(대상 없음)',
  ].join('\n');
  const c = ontology.classifyValidate({ code: 0, out, err: '' });
  assert.equal(c.noTargetCount, 2);
  assert.equal(c.failCount, 0);
  assert.equal(c.warnCount, 0);
});

test('classifyValidate: 표가 아예 없으면 미검사로 분류한다', () => {
  const c = ontology.classifyValidate({ code: 0, out: '아무것도 없음', err: '' });
  assert.equal(c.overall, '미검사');
  assert.equal(c.rows.length, 0);
});

test('ontology: validate.py 의 3층 경고는 단계를 멈추지 않는다(StageError 아님)', async () => {
  const ctx = fakeCtx('validate-warn', {
    responses: baseResponses({
      [R_VALIDATE]: {
        code: 0,
        out: [
          '리포트 → x.md',
          '검사     층   대상   통과   실패 판독불능  상태',
          '#13     3     2     1     1       0  완료',
        ].join('\n'),
        err: '',
      },
    }),
  });
  const { recorded } = await ontology.run(ctx);
  assert.equal(recorded.validate.overall, '경고');
  assert.equal(recorded.commands.at(-1).classification, '통과', 'check_fresh 는 별개로 통과해야 한다');
});

// ---------------------------------------------------------------------------
// 3) check_fresh 만 유일한 관문 — 실패하면 StageError(E-ONTOLOGY)
// ---------------------------------------------------------------------------

test('ontology: check_fresh 실패는 StageError(E-ONTOLOGY) 로 막는다(다른 네 명령은 이미 실행됨)', async () => {
  const ctx = fakeCtx('fresh-fail', {
    responses: baseResponses({
      [R_FRESH]: { code: 3, out: '그래프가 낡았습니다', err: '' },
    }),
  });
  await assert.rejects(
    () => ontology.run(ctx),
    (e) => {
      assert.equal(e.name, 'StageError');
      assert.equal(e.code, 'E-ONTOLOGY');
      assert.equal(e.detail.code, 3);
      assert.equal(e.detail.commands.length, 5, '실패해도 다섯 명령 전부 기록에 남아야 한다');
      return true;
    },
  );
  assert.equal(ctx.calls.length, 5, 'check_fresh 까지는 실행돼야 한다');
});

test('ontology: validate·render 가 실패해도(0 아닌 종료) 단계를 멈추지 않고 기록만 한다', async () => {
  const ctx = fakeCtx('non-gate-fail', {
    responses: baseResponses({
      [R_VALIDATE]: { code: 1, out: '검사기 자체가 죽었다', err: 'traceback' },
      [R_RENDER]: { code: 1, out: '', err: '뷰 렌더 실패' },
    }),
  });
  const { recorded } = await ontology.run(ctx);
  assert.equal(ctx.calls.length, 5, 'check_fresh 까지 계속 실행돼야 한다');
  assert.equal(recorded.validate.overall, '실패');
  const renderEntry = recorded.commands.find((c) => c.script === 'render_view.py');
  assert.equal(renderEntry.classification, '실패');
  assert.equal(recorded.commands.at(-1).classification, '통과');
});

test('ontology: ctx.run 이 없으면 E-ONTOLOGY, root 가 없으면 E-ONTOLOGY', async () => {
  await assert.rejects(() => ontology.run({ root: path.join(tmp, 'no-run') }), (e) => e.code === 'E-ONTOLOGY');
  await assert.rejects(() => ontology.run({ run: async () => OK }), (e) => e.code === 'E-ONTOLOGY');
});

// ---------------------------------------------------------------------------
// 4) 카드 보존(S09) — id 가 실행 전후 같은지 대조한다
// ---------------------------------------------------------------------------

function writeCard(root, relDir, id) {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AGENTS.md'),
    `---\nid: ${id}\ntype: role\n---\n# ${relDir}\n`,
    'utf8',
  );
}

test('findCardPaths/readCardId: R→D→P 3단만 훑고, 머리말 없으면 null', () => {
  const root = path.join(tmp, 'cardpaths');
  writeCard(root, 'R01-교사(Teacher)', 'iris:r01');
  writeCard(root, path.join('R01-교사(Teacher)', 'D01-수업(Teaching)'), 'iris:d01');
  fs.mkdirSync(path.join(root, 'node_modules', 'R99-가짜(Fake)'), { recursive: true });
  fs.mkdirSync(path.join(root, '보통폴더'), { recursive: true });

  const paths = ontology.findCardPaths(fs, root);
  assert.ok(paths.some((p) => p.endsWith(path.join('R01-교사(Teacher)', 'AGENTS.md'))));
  assert.ok(paths.some((p) => p.endsWith(path.join('D01-수업(Teaching)', 'AGENTS.md'))));
  assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules 는 훑지 않는다');
  assert.ok(!paths.some((p) => p.includes('보통폴더')), 'R/D/P 이름이 아니면 훑지 않는다');

  assert.equal(ontology.readCardId(fs, path.join(root, 'R01-교사(Teacher)', 'AGENTS.md')), 'iris:r01');
  assert.equal(ontology.readCardId(fs, path.join(root, '없는', 'AGENTS.md')), null);
});

test('ontology: 실행 전후 카드 id 가 같으면 preservedIds 에 보존으로, 바뀌면 mismatch 로 남긴다', async () => {
  const ctx = fakeCtx('preserve', { responses: baseResponses() });
  writeCard(ctx.root, 'R01-교사(Teacher)', 'iris:aaa11111');
  writeCard(ctx.root, path.join('R01-교사(Teacher)', 'D01-수업(Teaching)'), 'iris:bbb22222');

  // 카드가 하나 더 있고, init 단계가 "실수로" 그 id 를 바꿔 버리는 상황을 흉내낸다
  // (검사 로직 자체가 mismatch 를 실제로 잡아내는지 확인하기 위함).
  const responses = baseResponses({
    [R_INIT]: async () => {
      const p = path.join(ctx.root, 'R01-교사(Teacher)', 'D01-수업(Teaching)', 'AGENTS.md');
      fs.writeFileSync(p, '---\nid: iris:changed99\ntype: domain\n---\n# 바뀜\n', 'utf8');
      return baseResponses()[R_INIT];
    },
  });
  ctx.run = async (exe, args, opts) => {
    ctx.calls.push({ exe, args: args.slice(), opts: { ...opts } });
    const script = path.basename(String(args[0] ?? ''));
    const key = [script, ...args.slice(1)].join(' ');
    const r = responses[key];
    return typeof r === 'function' ? r({ exe, args, opts }) : (r ?? OK);
  };

  const { recorded } = await ontology.run(ctx);
  assert.equal(recorded.preservedIds.checked, 2);
  assert.equal(recorded.preservedIds.preserved, 1);
  assert.equal(recorded.preservedIds.mismatches.length, 1);
  assert.equal(recorded.preservedIds.mismatches[0].before, 'iris:bbb22222');
  assert.equal(recorded.preservedIds.mismatches[0].after, 'iris:changed99');
  assert.ok(recorded.preservedIds.mismatches[0].path.includes('D01-수업(Teaching)'));
});

// ---------------------------------------------------------------------------
// 5) resolvePython
// ---------------------------------------------------------------------------

test('resolvePython: IRIS_PYTHON 지정 > 동봉 shim > PATH 의 python', () => {
  const root = path.join(tmp, 'resolve-py');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(ontology.resolvePython({ root, env: { IRIS_PYTHON: 'X:\\my\\python.exe' } }), 'X:\\my\\python.exe');
  assert.equal(ontology.resolvePython({ root, env: {}, fs }), 'python', '동봉 shim 이 없으면 PATH');

  const shimDir = path.join(root, '_agent', 'shared', 'shims');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'python.cmd'), '@echo off\n', 'utf8');
  assert.equal(ontology.resolvePython({ root, env: {}, fs }), path.join(root, '_agent', 'shared', 'shims', 'python.cmd'));
});

// ---------------------------------------------------------------------------
// 6) 통합 시험 — 실제 python + PyYAML 로 진짜 온톨로지 도구를 돌린다.
//    이 PC에 python/PyYAML 이 없으면 깨끗이 건너뛴다. 절대 C:\IRIS 자체를
//    건드리지 않는다 — 전부 스크래치 tmp 아래 가짜 영혼에서만 실행한다.
// ---------------------------------------------------------------------------

function pythonAndYamlAvailable() {
  try {
    const r = spawnSync('python', ['-c', 'import yaml; import sys; sys.stdout.write(yaml.__version__)'], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

test('통합: 프리셋 구조(R01-교사/D01-수업)에서 실제 그래프·뷰를 만들고 check_fresh 를 통과한다', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(REAL_ONT) || !fs.existsSync(REAL_SPEC)) {
    t.skip('이 PC에 C:\\IRIS\\_ontology 원본이 없다');
    return;
  }
  if (!pythonAndYamlAvailable()) {
    t.skip('이 PC에 python 또는 PyYAML 이 없다');
    return;
  }

  // 경로 길이 주의: 윈도우 MAX_PATH(260자) 제한 때문에 여기서 붙이는 폴더
  // 이름은 최대한 짧게 잡는다. build_graph.py --init --write 가 기존
  // 백업파일을 _trash\{날짜}\agents-backup\{노드경로}\ 로 옮기는데, 지정된
  // 스크래치 경로(t17)가 이미 길어서 그 아래에 'integration'·'soul-IRIS' 같은
  // 긴 이름을 더 붙이면 R01-교사(Teacher)\D01-수업(Teaching) 2단 깊이에서
  // 264자로 한도를 넘겨 os.rename/shutil.move 가 모두
  // FileNotFoundError(WinError 3)로 실패하는 것을 실측으로 확인했다(2026-09-15).
  const dir = path.join(tmp, 'i');
  const payloadDir = path.join(dir, 'p');
  const root = path.join(dir, 's');

  // 정책 파일(진짜 payload-src\policy 그대로).
  fs.mkdirSync(path.join(payloadDir, 'policy'), { recursive: true });
  for (const f of ['root-AGENTS.md', 'CLAUDE.md', 'mini-AGENTS.md', 'mini-AGENTS-util.md', 'ontology-registry-template.yml']) {
    fs.copyFileSync(path.join(POLICY_SRC, f), path.join(payloadDir, 'policy', f));
  }
  fs.writeFileSync(path.join(payloadDir, 'policy', '_cosmos.ico'), Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]));

  // 진짜 온톨로지 도구 파일들을 그대로 복사한다 -- 패치하지 않는다.
  // build_graph.py 는 자기 위치에서 뿌리를 유도한다(`_ontology/build_graph.py`
  // → 부모의 부모, 환경변수 IRIS_ROOT 가 있으면 그 값). 그래서 연습용 뿌리에
  // 복사돼도 그 뿌리만 건드린다(Task 18b Fix 1, 2026-09-15). 예전에는 이 줄이
  // `Path(r"C:\IRIS")` 고정값이라 시험이 복사본을 패치해야 했고, 패치를 빠뜨리면
  // 시험이 이 PC 의 진짜 그래프를 다시 컴파일해 버렸다.
  const ontDstDir = path.join(payloadDir, 'setup', 'ontology');
  fs.mkdirSync(ontDstDir, { recursive: true });
  for (const f of ['build_graph.py', 'validate.py', 'render_view.py', 'check_fresh.py', 'view_data.py', 'view_app.js', 'view_template.html']) {
    fs.copyFileSync(path.join(REAL_ONT, f), path.join(ontDstDir, f));
  }
  const bgSrc = fs.readFileSync(path.join(REAL_ONT, 'build_graph.py'), 'utf8');
  assert.ok(!/ROOT = Path\(r"C:\\IRIS"\)/.test(bgSrc), 'build_graph.py 의 ROOT 가 다시 절대경로로 고정됐다(연습용 뿌리를 못 쓴다)');

  // 온톨로지 명세서(진짜) -- build_graph.py 가 런타임에 5-1 정규식 블록을 여기서 읽는다.
  fs.copyFileSync(REAL_SPEC, path.join(payloadDir, 'setup', SPEC_NAME));

  const manifest = {
    schema: 1,
    package: { version: '2.0.0' },
    parts: {
      pyyaml: { file: 'runtime/PyYAML-6.0.3-cp312-cp312-win_amd64.whl', version: '6.0.3' },
      ontology: { file: 'setup/ontology.zip' },
      'ontology-spec': { file: `setup/${SPEC_NAME}` },
      'folder-icon': { file: 'policy/_cosmos.ico' },
    },
  };

  const decisions = {
    nodes: [
      {
        id: 'r1', parentId: null, level: 'R', nameKo: '교사', nameEn: 'Teacher',
        order: 1, code: 'R01', folderName: 'R01-교사(Teacher)',
      },
      {
        id: 'd1', parentId: 'r1', level: 'D', nameKo: '수업', nameEn: 'Teaching',
        order: 1, code: 'D01', folderName: 'D01-수업(Teaching)',
      },
    ],
  };

  const logs = [];
  const ctx = {
    root,
    payloadDir,
    manifest,
    decisions,
    choice: { subscriptions: ['claude'], leadAgent: 'claude' },
    offline: true,
    log: (line) => logs.push(line),
    progress: () => {},
    run: realRun,
    fs,
    env: process.env,
  };

  // 준비: 뼈대(_ontology 채우기) + 작업 폴더(R01/D01) -- 이 단계들은 이 과제의
  // 몫이 아니라 이미 구현된 skeleton/structure 를 그대로 재사용한다.
  await skeleton.run(ctx);
  await structure.run(ctx);

  const rAgents = path.join(root, 'R01-교사(Teacher)', 'AGENTS.md');
  const dAgents = path.join(root, 'R01-교사(Teacher)', 'D01-수업(Teaching)', 'AGENTS.md');
  assert.ok(fs.existsSync(dAgents), '준비 단계(구조)가 D 폴더를 만들지 못했다');
  assert.ok(!fs.readFileSync(rAgents, 'utf8').startsWith('---'), '실행 전에는 아직 카드(머리말)가 없어야 한다');

  // 실제 시험 대상: ontology 단계.
  const result1 = await ontology.run(ctx);

  assert.ok(fs.existsSync(path.join(root, '_ontology', 'graph.json')), 'graph.json 이 만들어지지 않았다');
  assert.ok(fs.existsSync(path.join(root, 'IRIS-온톨로지-뷰.html')), '뷰 HTML 이 만들어지지 않았다');
  assert.equal(result1.recorded.commands.length, 5);
  assert.equal(result1.recorded.commands.at(-1).script, 'check_fresh.py');
  assert.equal(
    result1.recorded.commands.at(-1).classification, '통과',
    `check_fresh 가 통과하지 않았다: ${JSON.stringify(result1.recorded.commands.at(-1))}`,
  );
  assert.ok((result1.recorded.counts.cardsWritten ?? 0) > 0, '머리말 카드가 하나도 쓰이지 않았다');
  assert.ok((result1.recorded.counts.graphNodes ?? 0) > 0, '그래프 노드가 0 이다');

  assert.ok(fs.readFileSync(rAgents, 'utf8').startsWith('---'), 'R 카드에 머리말이 붙지 않았다');
  const rId1 = ontology.readCardId(fs, rAgents);
  const dId1 = ontology.readCardId(fs, dAgents);
  assert.ok(rId1, 'R 카드 id 를 읽지 못했다');
  assert.ok(dId1, 'D 카드 id 를 읽지 못했다');

  // 두 번째 실행 -- 아무것도 안 바뀌어야 한다(S09: 기존 카드 id 보존).
  const result2 = await ontology.run(ctx);
  assert.equal(
    result2.recorded.commands.at(-1).classification, '통과',
    `두 번째 실행에서도 check_fresh 가 통과해야 한다: ${JSON.stringify(result2.recorded.commands.at(-1))}`,
  );
  assert.equal(ontology.readCardId(fs, rAgents), rId1, '두 번째 실행이 R 카드 id 를 바꿨다');
  assert.equal(ontology.readCardId(fs, dAgents), dId1, '두 번째 실행이 D 카드 id 를 바꿨다');
  assert.equal(result2.recorded.preservedIds.checked, result2.recorded.preservedIds.preserved);
  assert.ok(result2.recorded.preservedIds.checked >= 2);
  assert.deepEqual(result2.recorded.preservedIds.mismatches, []);
});
