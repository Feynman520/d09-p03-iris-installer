// T18 ⑤ 엔진 — 순서·영수증·재개·고장 주입·대기 모으기
//
// 진짜 단계 모듈은 쓰지 않는다. 엔진이 지켜야 할 약속은 "무엇을 만드는가"가
// 아니라 "어떤 순서로 부르고, 무엇을 기록하고, 다시 돌리면 어떻게 이어지는가"
// 라서, 가짜 단계(modules 주입)로 보는 편이 더 정확하고 빠르다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runSetup, STAGES, stageModule, stageCode, buildEnv, envFromRecorded,
} from '../installer/setup/engine.mjs';
import { readReceipt, writeReceipt, newReceiptV2 } from '../installer/lib/receipt.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 't18e-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
function newRoot(label) {
  const root = path.join(tmp, `${label}-${seq += 1}`);
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  writeReceipt(root, newReceiptV2({ root, name: path.basename(root), manifest: { package: { version: '2.0.0' } }, createdBy: 'test' }));
  return root;
}

function ctxFor(root, extra = {}) {
  return {
    root,
    payloadDir: path.join(root, '_payload'),
    manifest: { package: { name: 'IRIS', version: '2.0.0' } },
    lock: { parts: {} },
    decisions: { nodes: [], later: true },
    choice: { subscriptions: ['claude'], leadAgent: 'claude' },
    precheck: { recorded: { edge: { present: true } } },
    run: async () => ({ code: 0, out: '', err: '' }),
    fs,
    env: { PATH: 'C:\\windows' },
    offline: true,
    ...extra,
  };
}

// 가짜 단계 지도. `calls` 에 부른 순서가 쌓인다.
function fakeModules(calls, { pending = {}, impl = {} } = {}) {
  const map = {};
  for (const id of STAGES) {
    map[id] = {
      run: async (ctx) => {
        calls.push(id);
        if (impl[id]) return impl[id](ctx);
        return { recorded: { ran: id }, pending: pending[id] ?? [] };
      },
    };
  }
  return map;
}

// ---------------------------------------------------------------------------

test('아홉 단계를 계약 순서대로 부르고 ok 로 끝난다', async () => {
  const root = newRoot('order');
  const calls = [];
  const res = await runSetup(ctxFor(root), { modules: fakeModules(calls) });

  assert.equal(res.ok, true);
  assert.equal(res.failed, null);
  assert.deepEqual(calls, [...STAGES]);
  assert.deepEqual(calls.slice(0, 3), ['unpack', 'env', 'skeleton']);
  assert.equal(calls[calls.length - 1], 'checks');
});

test('단계마다 영수증에 running → done 을 적는다', async () => {
  const root = newRoot('receipt');
  const seen = [];
  const res = await runSetup(ctxFor(root), {
    modules: fakeModules([], {
      impl: {
        skeleton: () => {
          // skeleton 이 도는 **동안** 디스크의 영수증은 running 이어야 한다.
          seen.push(readReceipt(root).setup.skeleton.status);
          return { recorded: { ran: 'skeleton' }, pending: [] };
        },
      },
    }),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, ['running']);

  const receipt = readReceipt(root);
  for (const id of STAGES) {
    assert.equal(receipt.setup[id].status, 'done', `${id} 이 done 이어야 한다`);
    assert.ok(receipt.setup[id].startedAt, `${id} startedAt`);
    assert.ok(receipt.setup[id].finishedAt, `${id} finishedAt`);
    assert.deepEqual(receipt.setup[id].recorded, { ran: id });
  }
});

test('이미 done 인 단계는 건너뛰고 skipped-done 으로 알린다', async () => {
  const root = newRoot('skip');
  const calls = [];
  const events = [];
  const receipt = readReceipt(root);
  for (const id of ['unpack', 'env', 'skeleton']) {
    receipt.setup[id] = { status: 'done', startedAt: 'x', finishedAt: 'y', recorded: { ran: id }, pending: [] };
  }
  writeReceipt(root, receipt);

  const res = await runSetup(ctxFor(root), {
    modules: fakeModules(calls),
    onStage: (e) => events.push(e),
  });

  assert.equal(res.ok, true);
  assert.deepEqual(calls, STAGES.slice(3), '앞 세 단계는 다시 부르지 않는다');
  const skipped = events.filter((e) => e.status === 'skipped-done').map((e) => e.id);
  assert.deepEqual(skipped, ['unpack', 'env', 'skeleton']);
});

test('진행 방송: percent 는 끝난 단계 수의 내림이고 하위 진행도 실어 나른다', async () => {
  const root = newRoot('progress');
  const events = [];
  await runSetup(ctxFor(root), {
    modules: fakeModules([], {
      impl: {
        unpack: (ctx) => {
          ctx.progress({ part: 'node', done: 1, total: 4 });
          return { recorded: {}, pending: [] };
        },
      },
    }),
    onStage: (e) => events.push(e),
  });

  const sub = events.find((e) => e.sub);
  assert.deepEqual(sub.sub, { part: 'node', done: 1, total: 4 });
  assert.equal(sub.id, 'unpack');

  const dones = events.filter((e) => e.status === 'done');
  assert.equal(dones[0].percent, 11, '1/9 = 11%(내림)');
  assert.equal(dones[dones.length - 1].percent, 100);
});

test('고장 주입: 아홉 단계 각각에서 멈추고, 다시 돌리면 나머지를 끝낸다', async () => {
  for (const target of STAGES) {
    const root = newRoot(`fault-${target}`);
    const first = [];
    process.env.IRIS_INSTALLER_FAIL_AT = target;
    let res;
    try {
      res = await runSetup(ctxFor(root), { modules: fakeModules(first) });
    } finally {
      delete process.env.IRIS_INSTALLER_FAIL_AT;
    }

    assert.equal(res.ok, false, `${target}: 멈춰야 한다`);
    assert.equal(res.failed.id, target);
    assert.equal(res.failed.code, stageCode(target));
    assert.ok(/고장 주입/.test(res.failed.message), `${target}: 사람이 읽을 이유가 있어야 한다`);
    // 주입된 단계는 run 을 부르기 **전에** 멈춘다.
    assert.equal(first.includes(target), false, `${target}: run 이 불려선 안 된다`);
    assert.deepEqual(first, STAGES.slice(0, STAGES.indexOf(target)));

    const mid = readReceipt(root);
    assert.equal(mid.setup[target].status, 'failed');
    assert.equal(mid.setup[target].code, stageCode(target));

    // 재개 — 같은 루트에서 다시. 끝난 단계는 건너뛰고 멈춘 곳부터.
    const second = [];
    const again = await runSetup(ctxFor(root), { modules: fakeModules(second) });
    assert.equal(again.ok, true, `${target}: 재개는 성공해야 한다`);
    assert.deepEqual(second, STAGES.slice(STAGES.indexOf(target)), `${target}: 멈춘 곳부터만 다시 돈다`);

    const end = readReceipt(root);
    for (const id of STAGES) assert.equal(end.setup[id].status, 'done', `${target} 재개 뒤 ${id}`);
  }
});

test('대기 기능은 모든 단계에서 모으고, 건너뛴 단계 것도 놓치지 않는다', async () => {
  const root = newRoot('pending');
  const receipt = readReceipt(root);
  receipt.setup.unpack = {
    status: 'done',
    recorded: {},
    pending: [{ capability: '문서 자동화(한글)', reason: '한컴오피스 없음' }],
  };
  writeReceipt(root, receipt);

  const res = await runSetup(ctxFor(root), {
    modules: fakeModules([], {
      pending: {
        adapters: [
          { capability: '문서 자동화(엑셀)', reason: '오피스 없음' },
          { capability: '문서 자동화(한글)', reason: '한컴오피스 없음' }, // 같은 것은 한 번만
        ],
      },
    }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.pending.length, 2);
  assert.deepEqual(res.pending.map((p) => p.capability).sort(), ['문서 자동화(엑셀)', '문서 자동화(한글)']);
});

test('모듈 파일이 없으면 그 단계만 E-<단계> + "부품 모듈이 없습니다" 로 실패한다', async () => {
  const root = newRoot('missing');
  const calls = [];
  const modules = fakeModules(calls);
  delete modules.venv; // venv.mjs 가 아직 없는 상황

  const res = await runSetup(ctxFor(root), {
    modules,
    importer: async (file) => { throw new Error(`Cannot find module ${file}`); },
  });

  assert.equal(res.ok, false);
  assert.equal(res.failed.id, 'venv');
  assert.equal(res.failed.code, 'E-VENV');
  assert.match(res.failed.message, /부품 모듈이 없습니다/);
  assert.deepEqual(calls, ['unpack', 'env', 'skeleton', 'structure']);
  assert.equal(readReceipt(root).setup.venv.code, 'E-VENV');
});

test('StageError 가 아닌 예외는 E-<단계> 로 감싸고, E-OUTSIDE-ROOT 는 그대로 둔다', async () => {
  const root = newRoot('wrap');
  const plain = await runSetup(ctxFor(root), {
    modules: fakeModules([], { impl: { adapters: () => { throw new TypeError('x is not a function'); } } }),
  });
  assert.equal(plain.failed.code, 'E-ADAPTERS');
  assert.match(plain.failed.message, /예상치 못한 오류/);
  // 2026-09-17 실제 사용자 실측: 원문이 영수증에만 남아 되짚지 못했다 — failed 에도 실린다.
  assert.match(String(plain.failed.detail), /x is not a function/, '원문(스택)이 failed.detail 에 실린다');
  const receiptAfter = JSON.parse(fs.readFileSync(path.join(root, '_agent', 'setup', 'package-receipt.json'), 'utf8'));
  assert.match(String(receiptAfter.setup.adapters.detail), /x is not a function/, '영수증에도 원문이 남는다');

  const root2 = newRoot('outside');
  const { StageError } = await import('../installer/lib/errors.mjs');
  const outside = await runSetup(ctxFor(root2), {
    modules: fakeModules([], {
      impl: { skeleton: () => { throw new StageError('E-OUTSIDE-ROOT', 'IRIS 폴더 밖에 파일을 쓰려고 해서 멈췄습니다.', {}); } },
    }),
  });
  assert.equal(outside.failed.code, 'E-OUTSIDE-ROOT', '공용 코드는 다시 감싸지 않는다');
});

test('영수증은 두 번 읽고 써도 같다(엔진을 두 번 돌려도 변경 0)', async () => {
  const root = newRoot('idem');
  await runSetup(ctxFor(root), { modules: fakeModules([]) });
  const first = fs.readFileSync(path.join(root, '_agent', 'setup', 'package-receipt.json'), 'utf8');

  const calls = [];
  const again = await runSetup(ctxFor(root), { modules: fakeModules(calls) });
  const second = fs.readFileSync(path.join(root, '_agent', 'setup', 'package-receipt.json'), 'utf8');

  assert.equal(again.ok, true);
  assert.deepEqual(calls, [], '두 번째 실행은 아무 단계도 다시 하지 않는다');
  assert.equal(second, first, '영수증 바이트가 같아야 한다');

  const parsed = JSON.parse(first);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(parsed)), null, 2), JSON.stringify(parsed, null, 2));
});

test('env 단계가 준 자식 환경을 뒤 단계가 물려받는다', async () => {
  const root = newRoot('env');
  let sawFoo = null;
  await runSetup(ctxFor(root), {
    modules: fakeModules([], {
      impl: {
        env: () => ({ recorded: { env: { PATH: 'C:\\shims;C:\\windows', FOO: 'bar' } }, pending: [] }),
        adapters: (ctx) => { sawFoo = ctx.env.FOO; return { recorded: {}, pending: [] }; },
      },
    }),
  });
  assert.equal(sawFoo, 'bar');
});

test('재개: env 가 이미 끝나 있어도 그때 기록한 자식 환경을 뒤 단계가 물려받는다', async () => {
  // C4 — 「다시 시도」·업데이트처럼 env 를 건너뛰는 실행에서, 건너뛰었다는
  // 이유로 CLAUDE_CONFIG_DIR·심 PATH 가 통째로 사라지면 뒤 단계(venv·adapters·
  // ontology)가 PATH 의 아무 파이썬을 보게 된다.
  const root = newRoot('env-resume');
  const first = await runSetup(ctxFor(root), {
    modules: fakeModules([], {
      impl: {
        env: () => ({ recorded: { env: { PATH: 'C:\shims;C:\windows', CLAUDE_CONFIG_DIR: 'C:\SOUL\_agent\claude' } }, pending: [] }),
        venv: () => { throw new Error('첫 실행은 venv 에서 멈춘다'); },
      },
    }),
  });
  assert.equal(first.ok, false);
  assert.equal(first.failed.id, 'venv');

  const seen = {};
  const skipped = [];
  const second = await runSetup(ctxFor(root), {
    modules: fakeModules([], {
      impl: {
        venv: (ctx) => { seen.venv = { ...ctx.env }; return { recorded: {}, pending: [] }; },
        adapters: (ctx) => { seen.adapters = { ...ctx.env }; return { recorded: {}, pending: [] }; },
      },
    }),
    onStage: (e) => { if (e.status === 'skipped-done') skipped.push(e.id); },
  });

  assert.equal(second.ok, true);
  assert.ok(skipped.includes('env'), 'env 는 이미 끝나 있어 건너뛴다');
  assert.equal(seen.venv.CLAUDE_CONFIG_DIR, 'C:\SOUL\_agent\claude');
  assert.equal(seen.venv.PATH, 'C:\shims;C:\windows');
  assert.equal(seen.adapters.CLAUDE_CONFIG_DIR, 'C:\SOUL\_agent\claude');
});

test('stageModule: 지도에 없으면 파일에서 찾고, export 가 없으면 부품 없음으로 실패', async () => {
  // 진짜 파일(skeleton.mjs)은 run 을 내보낸다.
  const fn = await stageModule('skeleton');
  assert.equal(typeof fn, 'function');

  await assert.rejects(
    () => stageModule('venv', { importer: async () => ({}) }),
    (e) => e.code === 'E-VENV' && /부품 모듈이 없습니다/.test(e.message),
  );
});

test('ctx 채우기: PATH 앞에 심·node·git·python 이 붙고 중복은 하나만 남는다', () => {
  const env = buildEnv('C:\\IRIS-t', { base: { PATH: 'C:\\windows;C:\\IRIS-t\\_agent\\shared\\shims' } });
  const parts = env.PATH.split(';');
  assert.equal(parts[0], 'C:\\IRIS-t\\_agent\\shared\\shims');
  assert.ok(parts[1].endsWith('tools\\node'));
  assert.ok(parts.some((p) => p.endsWith('tools\\git\\cmd')));
  assert.ok(parts.some((p) => p.endsWith('tools\\python')));
  assert.equal(parts.filter((p) => p.toLowerCase().endsWith('shims')).length, 1, '중복 없음');
});

test('envFromRecorded 는 env·childEnv·vars 세 이름을 알아본다', () => {
  assert.deepEqual(envFromRecorded({ env: { A: '1' } }), { A: '1' });
  assert.deepEqual(envFromRecorded({ childEnv: { B: '2' } }), { B: '2' });
  assert.deepEqual(envFromRecorded({ vars: { C: '3' } }), { C: '3' });
  assert.equal(envFromRecorded({ nothing: 1 }), null);
  assert.equal(envFromRecorded(null), null);
});

test('설치 폴더 경로가 없으면 단계 하나도 돌리지 않고 멈춘다', async () => {
  const res = await runSetup({}, { modules: fakeModules([]) });
  assert.equal(res.ok, false);
  assert.equal(res.failed.id, null);
  assert.match(res.failed.message, /설치 폴더 경로가 없어/);
});

test('setup.log 에 단계 진행이 남는다', async () => {
  const root = newRoot('log');
  await runSetup(ctxFor(root), { modules: fakeModules([]) });
  const log = fs.readFileSync(path.join(root, '_agent', 'setup', 'setup.log'), 'utf8');
  assert.match(log, /세팅 시작/);
  assert.match(log, /checks\(마무리 검사\) — 끝/);
});
