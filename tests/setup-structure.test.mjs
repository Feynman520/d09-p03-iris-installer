import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as structure from '../installer/setup/structure.mjs';
import { assertInside, assertNoReparse, realRootPath } from '../installer/lib/paths.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_SRC = path.join(REPO, 'payload-src', 'policy');

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-t14-struct-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function makeCtx(label, decisions) {
  const payloadDir = path.join(tmp, label, 'payload');
  fs.mkdirSync(path.join(payloadDir, 'policy'), { recursive: true });
  for (const f of ['mini-AGENTS.md', 'CLAUDE.md']) {
    fs.copyFileSync(path.join(POLICY_SRC, f), path.join(payloadDir, 'policy', f));
  }
  const root = path.join(tmp, label, 'soul-IRIS');
  fs.mkdirSync(root, { recursive: true });
  const logs = [];
  return {
    root, payloadDir, decisions, fs, logs,
    manifest: { schema: 1, package: { version: '2.0.0' }, parts: {} },
    choice: { subscriptions: ['claude'], leadAgent: 'claude' },
    offline: true,
    log: (l) => logs.push(l),
    progress: () => {},
    run: async () => ({ code: 0, out: '', err: '' }),
  };
}

function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const here = rel ? path.join(dir, rel) : dir;
    for (const e of fs.readdirSync(here, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { out[`${childRel}\\`] = 'dir'; walk(childRel); continue; }
      const st = fs.statSync(path.join(dir, childRel));
      out[childRel] = `${st.size}:${st.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, childRel))).digest('hex')}`;
    }
  };
  walk('');
  return out;
}

// ① 프리셋: R → D → P 3단 (서버가 code·folderName 을 이미 매긴 모양)
const PRESET = {
  schema: 1,
  createdAt: '2026-09-15T00:00:00.000Z',
  later: false,
  nodes: [
    // 일부러 자식을 먼저 적어 둔다 -- 모듈이 부모→자식으로 정렬하는지 본다.
    { id: 'p1', parentId: 'd1', level: 'P', nameKo: '2학기 물리', nameEn: 'Physics 2', order: 1, code: 'P01', folderName: 'P01-2학기 물리(Physics 2)' },
    { id: 'd1', parentId: 'r1', level: 'D', nameKo: '수업', nameEn: 'Teaching', order: 1, code: 'D01', folderName: 'D01-수업(Teaching)' },
    { id: 'r1', parentId: null, level: 'R', nameKo: '교사', nameEn: 'Teacher', order: 1, code: 'R01', folderName: 'R01-교사(Teacher)' },
    { id: 'd2', parentId: 'r1', level: 'D', nameKo: '담임', nameEn: 'Homeroom', order: 2, code: 'D02', folderName: 'D02-담임(Homeroom)' },
  ],
  deferred: ['S', 'T', 'tags'],
  nameEnMissing: [],
};

// ② 직접 입력: 영어 이름 없음
const NO_EN = {
  schema: 1,
  later: false,
  nodes: [
    { id: 'r1', parentId: null, level: 'R', nameKo: '연구자', nameEn: null, order: 1, code: 'R01', folderName: 'R01-연구자' },
    { id: 'd1', parentId: 'r1', level: 'D', nameKo: '논문', nameEn: null, order: 1, code: 'D01', folderName: 'D01-논문' },
  ],
  deferred: ['S', 'T', 'tags'],
  nameEnMissing: ['R01-연구자', 'D01-논문'],
};

// ③ 나중에 정하기
const LATER = {
  schema: 1,
  later: true,
  nodes: [{ id: 'r1', parentId: null, level: 'R', nameKo: '나', nameEn: 'Me', order: 1, code: 'R01', folderName: 'R01-나(Me)' }],
  deferred: ['R', 'D', 'P', 'S', 'T', 'tags'],
  nameEnMissing: [],
};

// ---------------------------------------------------------------------------

test('structure ①프리셋: R/D/P 3단 폴더 + 미니 지침을 부모→자식 순서로 만든다', async () => {
  const ctx = makeCtx('preset', PRESET);
  const { recorded, pending } = await structure.run(ctx);
  const at = (...s) => path.join(ctx.root, ...s);

  assert.deepEqual(pending, []);
  assert.deepEqual(recorded.created.sort(), [
    'R01-교사(Teacher)',
    'R01-교사(Teacher)\\D01-수업(Teaching)',
    'R01-교사(Teacher)\\D01-수업(Teaching)\\P01-2학기 물리(Physics 2)',
    'R01-교사(Teacher)\\D02-담임(Homeroom)',
  ].sort());
  assert.deepEqual(recorded.skipped, []);
  assert.deepEqual(recorded.conflicts, []);
  assert.deepEqual(recorded.nameEnMissing, []);
  assert.deepEqual(recorded.deferred, ['S', 'T', 'tags']);
  assert.equal(recorded.guides.created, 8); // 폴더 4개 × (AGENTS.md + CLAUDE.md)

  const rAgents = fs.readFileSync(at('R01-교사(Teacher)', 'AGENTS.md'), 'utf8');
  assert.ok(rAgents.startsWith('# R01-교사(Teacher)'));
  assert.ok(rAgents.includes('역할: 교사 — 이 역할로 하는 모든 일의 규칙과 정체성'));
  assert.ok(rAgents.includes('재서술 금지'), '상위 규칙 재서술 금지 주석이 남아야 한다');
  assert.ok(!rAgents.includes('{{'));
  assert.ok(fs.readFileSync(at('R01-교사(Teacher)', 'D01-수업(Teaching)', 'AGENTS.md'), 'utf8').includes('분야: 수업 — 계속 관리하는 분야'));
  assert.ok(fs.readFileSync(at('R01-교사(Teacher)', 'D01-수업(Teaching)', 'P01-2학기 물리(Physics 2)', 'AGENTS.md'), 'utf8')
    .includes('프로젝트: 2학기 물리 — 끝이 있는 구체적인 일'));
  assert.equal(fs.readFileSync(at('R01-교사(Teacher)', 'CLAUDE.md'), 'utf8').trim(), '@AGENTS.md');

  // 온톨로지 카드(머리말)는 T17 몫 -- 여기서는 붙이지 않는다.
  assert.ok(!rAgents.startsWith('---'), 'AGENTS.md 에 머리말 카드가 붙으면 안 된다');
});

test('structure ②직접 입력(영어 없음): 한글만으로 폴더를 만들고 nameEnMissing 을 넘긴다', async () => {
  const ctx = makeCtx('no-en', NO_EN);
  const { recorded } = await structure.run(ctx);
  assert.deepEqual(recorded.created, ['R01-연구자', 'R01-연구자\\D01-논문']);
  assert.deepEqual(recorded.nameEnMissing, ['R01-연구자', 'D01-논문']);
  assert.ok(fs.existsSync(path.join(ctx.root, 'R01-연구자', 'D01-논문', 'AGENTS.md')));
});

test('structure ③나중에 정하기: R01-나(Me) 하나 + deferred 를 그대로 넘긴다', async () => {
  const ctx = makeCtx('later', LATER);
  const { recorded } = await structure.run(ctx);
  assert.deepEqual(recorded.created, ['R01-나(Me)']);
  assert.equal(recorded.later, true);
  assert.deepEqual(recorded.deferred, ['R', 'D', 'P', 'S', 'T', 'tags']);
  assert.ok(fs.readFileSync(path.join(ctx.root, 'R01-나(Me)', 'AGENTS.md'), 'utf8').includes('역할: 나'));
});

test('structure: nodes 가 비어도 later 면 기본 R01-나(Me), later 가 아니면 E-STRUCTURE', async () => {
  const ok = makeCtx('empty-later', { schema: 1, later: true, nodes: [] });
  const r = await structure.run(ok);
  assert.deepEqual(r.recorded.created, ['R01-나(Me)']);

  const bad = makeCtx('empty-not-later', { schema: 1, later: false, nodes: [] });
  await assert.rejects(() => structure.run(bad), (e) => e.name === 'StageError' && e.code === 'E-STRUCTURE');
});

test('structure: 같은 이름 폴더는 건너뛰고(내용 보존) 지침만 없으면 채운다', async () => {
  const ctx = makeCtx('same-name', PRESET);
  const existing = path.join(ctx.root, 'R01-교사(Teacher)');
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, '내자료.md'), '건드리지 말 것\n', 'utf8');
  fs.writeFileSync(path.join(existing, 'AGENTS.md'), '# 내가 쓴 역할 지침\n', 'utf8');

  const { recorded } = await structure.run(ctx);

  assert.deepEqual(recorded.skipped, ['R01-교사(Teacher)']);
  assert.equal(fs.readFileSync(path.join(existing, '내자료.md'), 'utf8'), '건드리지 말 것\n');
  assert.equal(fs.readFileSync(path.join(existing, 'AGENTS.md'), 'utf8'), '# 내가 쓴 역할 지침\n');
  // 하위는 정상적으로 그 폴더 안에 만들어진다
  assert.ok(fs.existsSync(path.join(existing, 'D01-수업(Teaching)', 'AGENTS.md')));
  assert.equal(recorded.created.length, 3);
});

test('structure: 이름이 다른 같은 코드 폴더가 있으면 만들지 않고 conflicts 에 (자료 보호)', async () => {
  const ctx = makeCtx('code-clash', PRESET);
  fs.mkdirSync(path.join(ctx.root, 'R01-작가(Writer)', '내 원고'), { recursive: true });

  const { recorded } = await structure.run(ctx);

  assert.deepEqual(recorded.created, []);
  assert.ok(!fs.existsSync(path.join(ctx.root, 'R01-교사(Teacher)')), '충돌 시 새 폴더를 만들면 안 된다');
  assert.ok(fs.existsSync(path.join(ctx.root, 'R01-작가(Writer)', '내 원고')), '기존 폴더는 그대로여야 한다');
  assert.ok(!fs.existsSync(path.join(ctx.root, 'R01-작가(Writer)', 'AGENTS.md')), '남의 폴더에 지침을 넣지 않는다');

  const root0 = recorded.conflicts.find((c) => c.reason === 'code-taken');
  assert.deepEqual(root0, {
    code: 'R01', wanted: 'R01-교사(Teacher)', existing: 'R01-작가(Writer)', parent: '.', reason: 'code-taken',
  });
  // 자식 3개는 부모가 막혀 함께 보류된다
  assert.equal(recorded.conflicts.filter((c) => c.reason === 'parent-conflict').length, 3);
});

test('structure: 두 번 실행해도 변경 0', async () => {
  const ctx = makeCtx('twice', PRESET);
  await structure.run(ctx);
  const before = snapshot(ctx.root);
  const second = await structure.run(ctx);
  assert.deepEqual(snapshot(ctx.root), before);
  assert.deepEqual(second.recorded.created, []);
  assert.equal(second.recorded.skipped.length, 4);
  assert.equal(second.recorded.guides.created, 0);
  assert.equal(second.recorded.guides.kept, 8);
});

test('structure: 부모가 없거나 고리를 이루면 E-STRUCTURE', async () => {
  const orphan = makeCtx('orphan', {
    schema: 1, later: false,
    nodes: [{ id: 'd1', parentId: 'nope', level: 'D', nameKo: '수업', order: 1, code: 'D01', folderName: 'D01-수업' }],
  });
  await assert.rejects(() => structure.run(orphan), (e) => e.code === 'E-STRUCTURE');

  const loop = makeCtx('loop', {
    schema: 1, later: false,
    nodes: [
      { id: 'a', parentId: 'b', level: 'D', nameKo: '가', order: 1, code: 'D01', folderName: 'D01-가' },
      { id: 'b', parentId: 'a', level: 'D', nameKo: '나', order: 2, code: 'D02', folderName: 'D02-나' },
    ],
  });
  await assert.rejects(() => structure.run(loop), (e) => e.code === 'E-STRUCTURE');
});

// ---------------------------------------------------------------------------
// 정션(junction) — 글자로는 루트 안, 실제로는 영혼 밖
// ---------------------------------------------------------------------------

// 폴더 정션은 관리자 권한 없이 mklink /J 로 만들 수 있다. 못 만드는 환경
// (비-윈도, 정책 차단)에서는 시험을 건너뛴다.
function makeJunction(linkPath, targetPath) {
  if (process.platform !== 'win32') return false;
  fs.mkdirSync(targetPath, { recursive: true });
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], { stdio: 'ignore' });
    return fs.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

test('paths: 영혼 안의 정션을 지나는 쓰기는 E-OUTSIDE-ROOT 로 막는다', { skip: process.platform !== 'win32' ? '윈도 전용' : false }, (t) => {
  const base = path.join(tmp, 'junction-guard');
  const root = path.join(base, 'soul-IRIS');
  const outside = path.join(base, 'outside-target');
  fs.mkdirSync(root, { recursive: true });
  const link = path.join(root, 'R01-교사(Teacher)');
  // 조용히 통과하지 않게: 정션을 못 만들면 '건너뜀'으로 보이게 한다.
  if (!makeJunction(link, outside)) { t.skip('이 환경에서 mklink /J 가 막혀 있다'); return; }

  // 글자로만 보면 루트 안이다 -- 그래서 렉시컬 검사만으로는 못 막았다.
  assert.ok(path.resolve(path.join(link, 'AGENTS.md')).startsWith(path.resolve(root)));

  for (const bad of [link, path.join(link, 'AGENTS.md'), path.join(link, 'D01-수업', 'x.md')]) {
    assert.throws(
      () => assertInside(root, bad),
      (e) => e.name === 'StageError' && e.code === 'E-OUTSIDE-ROOT' && e.message.includes('정션'),
      `정션을 지나는 경로를 막지 못함: ${bad}`,
    );
  }
  // 정션과 무관한 형제 경로는 그대로 통과
  assert.equal(assertInside(root, path.join(root, 'R02-작가', 'a.md')), path.join(root, 'R02-작가', 'a.md'));
  // followLinks:false 로 끄면 예전(글자만) 동작
  assert.doesNotThrow(() => assertInside(root, path.join(link, 'AGENTS.md'), { followLinks: false }));
  // 루트 자체가 정션이어도 realRootPath 를 기준 삼아 안쪽 쓰기는 허용
  assert.equal(realRootPath(outside), fs.realpathSync.native(outside));
  assert.doesNotThrow(() => assertNoReparse(outside, path.join(outside, 'a', 'b.md')));
});

test('structure: 폴더가 정션이면 뚫고 쓰지 않고 conflicts 에 (대상 폴더에 0바이트)', { skip: process.platform !== 'win32' ? '윈도 전용' : false }, async (t) => {
  const ctx = makeCtx('junction-structure', PRESET);
  const outside = path.join(tmp, 'junction-structure', 'outside-target');
  const link = path.join(ctx.root, 'R01-교사(Teacher)');
  if (!makeJunction(link, outside)) { t.skip('이 환경에서 mklink /J 가 막혀 있다'); return; }

  const { recorded } = await structure.run(ctx);

  const hit = recorded.conflicts.find((c) => c.reason === 'reparse-point');
  assert.ok(hit, `정션을 conflicts 에 남기지 않았다: ${JSON.stringify(recorded.conflicts)}`);
  assert.equal(hit.wanted, 'R01-교사(Teacher)');
  assert.equal(hit.parent, '.');
  assert.deepEqual(recorded.created, [], '정션이 막았으므로 아무 폴더도 만들지 않는다');
  // 자식 3개는 부모가 막혀 함께 보류
  assert.equal(recorded.conflicts.filter((c) => c.reason === 'parent-conflict').length, 3);
  assert.equal(recorded.guides.created, 0);
  // 핵심: 정션 너머(진짜 영혼 밖)에 아무것도 떨어지지 않았다
  assert.deepEqual(fs.readdirSync(outside), [], '정션 대상 폴더에 파일이 쓰였다');
});

test('structure: identityLine·codeOf 단위 확인', () => {
  assert.equal(structure.codeOf('R01-교사(Teacher)'), 'R01');
  assert.equal(structure.codeOf('D02.01-작은 분야'), 'D02.01');
  assert.equal(structure.codeOf('내 자료'), null);
  assert.equal(structure.identityLine({ level: 'P', nameKo: '표지' }), '프로젝트: 표지 — 끝이 있는 구체적인 일');
});
