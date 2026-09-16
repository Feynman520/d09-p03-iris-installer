// 작업 폴더 구성 화면(④)의 순수 함수 시험 — 화면(DOM) 없이 규칙만 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  LEVELS,
  NAME_MAX,
  PLACEHOLDER_NAMES,
  validateNodes,
  assignCodes,
  folderName,
  renderTree,
  applyPreset,
  laterNodes,
  isPlaceholderName,
  hasControlChar,
} from '../installer/ui/structure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESETS = JSON.parse(readFileSync(join(HERE, '..', 'installer', 'ui', 'presets.json'), 'utf8'));

const node = (over) => ({ id: 'x', parentId: null, level: 'R', nameKo: '교사', nameEn: 'Teacher', order: 1, ...over });

/** 검사 결과에 그 오류 코드가 들어 있는가. */
const hasCode = (res, code) => res.errors.some((e) => e.code === code);

const GOOD = [
  node({ id: 'r1', parentId: null, level: 'R', nameKo: '교사', nameEn: 'Teacher', order: 1 }),
  node({ id: 'd1', parentId: 'r1', level: 'D', nameKo: '수업', nameEn: 'Teaching', order: 1 }),
  node({ id: 'p1', parentId: 'd1', level: 'P', nameKo: '이번 학기', nameEn: 'This Semester', order: 1 }),
];

// ---------------------------------------------------------------- validateNodes

test('validateNodes: 올바른 나무는 통과한다', () => {
  const res = validateNodes(GOOD, { later: false });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(res.errors, []);
});

test('validateNodes: R이 하나도 없으면 막는다', () => {
  const res = validateNodes([node({ id: 'd1', parentId: null, level: 'D', nameKo: '수업' })]);
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'no-root'));
});

test('validateNodes: later면 빈 목록도 통과하고, 항목을 함께 보내면 막는다', () => {
  assert.equal(validateNodes([], { later: true }).ok, true);
  const res = validateNodes(GOOD, { later: true });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'later-with-nodes'));
});

test('validateNodes: later가 아니면 빈 목록은 막는다', () => {
  assert.equal(validateNodes([]).ok, false);
  assert.equal(validateNodes([], {}).ok, false);
});

test('validateNodes: 윈도 금지 문자를 잡는다', () => {
  for (const bad of ['수업/준비', '수업:하나', '수업<둘>', '수업"셋"', '수업|넷', '수업?다섯', '수업*여섯', '수업\\일곱']) {
    const res = validateNodes([node({ nameKo: bad })]);
    assert.ok(hasCode(res, 'bad-char'), bad);
  }
});

test('validateNodes: 점·빈칸으로 끝나는 이름을 잡는다', () => {
  assert.ok(hasCode(validateNodes([node({ nameKo: '수업.' })]), 'bad-tail'));
  assert.ok(hasCode(validateNodes([node({ nameKo: '수업 ' })]), 'bad-tail'));
});

test('validateNodes: 빈 한글 이름을 잡는다', () => {
  const res = validateNodes([node({ nameKo: '   ' })]);
  assert.ok(hasCode(res, 'empty-name'));
});

test('validateNodes: 자리표시자 이름 6종을 모두 잡는다(대소문자 무관)', () => {
  for (const name of PLACEHOLDER_NAMES.concat(['TEST', 'Temp', 'MISC'])) {
    const res = validateNodes([node({ nameKo: name })]);
    assert.ok(hasCode(res, 'placeholder'), name);
  }
  assert.equal(isPlaceholderName(' 기타 '), true);
  assert.equal(isPlaceholderName('기타 자료 모음'), false);
});

test('validateNodes: 같은 부모 아래 같은 이름을 잡고, 다른 부모면 허락한다', () => {
  const dup = [
    node({ id: 'r1', level: 'R', nameKo: '교사', parentId: null }),
    node({ id: 'd1', level: 'D', nameKo: '수업', parentId: 'r1' }),
    node({ id: 'd2', level: 'D', nameKo: '수업', parentId: 'r1' }),
  ];
  assert.ok(hasCode(validateNodes(dup), 'duplicate'));

  const ok = [
    node({ id: 'r1', level: 'R', nameKo: '교사', parentId: null }),
    node({ id: 'r2', level: 'R', nameKo: '연구자', parentId: null, nameEn: 'Researcher' }),
    node({ id: 'd1', level: 'D', nameKo: '수업', parentId: 'r1' }),
    node({ id: 'd2', level: 'D', nameKo: '수업', parentId: 'r2' }),
  ];
  assert.equal(validateNodes(ok).ok, true, JSON.stringify(validateNodes(ok).errors));
});

test('validateNodes: 부모 없는 자식을 잡는다', () => {
  const orphan = [
    node({ id: 'r1', level: 'R', nameKo: '교사' }),
    node({ id: 'd1', level: 'D', nameKo: '수업', parentId: null }),
  ];
  assert.ok(hasCode(validateNodes(orphan), 'orphan'));

  const missing = [
    node({ id: 'r1', level: 'R', nameKo: '교사' }),
    node({ id: 'd1', level: 'D', nameKo: '수업', parentId: '없는아이디' }),
  ];
  assert.ok(hasCode(validateNodes(missing), 'orphan'));
});

test('validateNodes: 단계가 어긋난 자리를 잡는다', () => {
  const wrong = [
    node({ id: 'r1', level: 'R', nameKo: '교사' }),
    node({ id: 'p1', level: 'P', nameKo: '첫 일', parentId: 'r1' }),
  ];
  assert.ok(hasCode(validateNodes(wrong), 'bad-parent-level'));

  const rootWithParent = [
    node({ id: 'r1', level: 'R', nameKo: '교사' }),
    node({ id: 'r2', level: 'R', nameKo: '연구자', parentId: 'r1' }),
  ];
  assert.ok(hasCode(validateNodes(rootWithParent), 'bad-parent-level'));
});

test('validateNodes: 영어 이름은 비워도 되고, 한글·특수문자는 막는다', () => {
  assert.equal(validateNodes([node({ nameEn: '' })]).ok, true);
  assert.equal(validateNodes([node({ nameEn: null })]).ok, true);
  assert.equal(validateNodes([node({ nameEn: 'Teacher Work-Room 2' })]).ok, true);
  assert.ok(hasCode(validateNodes([node({ nameEn: '교사' })]), 'bad-name-en'));
  assert.ok(hasCode(validateNodes([node({ nameEn: 'Teacher!' })]), 'bad-name-en'));
});

// 소스에 진짜 제어 문자를 적지 않는다(파일이 바이너리로 취급되는 사고를 막기 위해).
const ctrl = (code) => String.fromCharCode(code);

test('hasControlChar: U+0000~U+001F·U+007F만 잡는다', () => {
  for (const code of [0, 1, 9, 10, 13, 27, 31, 127]) {
    assert.equal(hasControlChar('수업' + ctrl(code)), true, 'code ' + code);
  }
  assert.equal(hasControlChar('수업 준비'), false);
  assert.equal(hasControlChar('Teaching-2'), false);
  assert.equal(hasControlChar(''), false);
  assert.equal(hasControlChar(null), false);
});

test('validateNodes: 한글 이름의 제어 문자를 잡는다', () => {
  for (const code of [0, 9, 27, 127]) {
    const res = validateNodes([node({ nameKo: '수업' + ctrl(code) })]);
    assert.ok(hasCode(res, 'control-char'), 'code ' + code);
  }
});

test('validateNodes: 영어 이름의 제어 문자를 잡고, 그때 bad-name-en을 겹쳐 내지 않는다', () => {
  const res = validateNodes([node({ nameEn: 'Teach' + ctrl(1) + 'ing' })]);
  assert.ok(hasCode(res, 'control-char'));
  assert.equal(hasCode(res, 'bad-name-en'), false, '까닭 하나만 말해야 사용자가 헷갈리지 않는다');
});

test('validateNodes: 이름 길이 상한 40글자', () => {
  assert.equal(NAME_MAX, 40);
  const ok40 = '가'.repeat(40);
  const over = '가'.repeat(41);
  assert.equal(validateNodes([node({ nameKo: ok40 })]).ok, true, '40글자는 통과');
  const res = validateNodes([node({ nameKo: over })]);
  assert.ok(hasCode(res, 'too-long'));
  assert.ok(res.errors.find((e) => e.code === 'too-long').message.includes('41글자'), '지금 몇 글자인지 알려 준다');

  const enOk = 'a'.repeat(40);
  assert.equal(validateNodes([node({ nameEn: enOk })]).ok, true);
  assert.ok(hasCode(validateNodes([node({ nameEn: 'a'.repeat(41) })]), 'too-long'));
});

test('validateNodes: 길이는 앞뒤 빈칸을 뺀 글자 수로 센다', () => {
  assert.equal(validateNodes([node({ nameKo: '  ' + '가'.repeat(40) })]).ok, true);
});

test('validateNodes: 같은 항목 번호(id)가 두 번 오면 잡는다', () => {
  const res = validateNodes([
    node({ id: 'r1', level: 'R', nameKo: '교사' }),
    node({ id: 'r1', level: 'R', nameKo: '연구자', nameEn: 'Researcher' }),
  ]);
  assert.ok(hasCode(res, 'duplicate-id'));
  assert.equal(res.errors.find((e) => e.code === 'duplicate-id').nodeId, 'r1');
});

test('validateNodes: 알 수 없는 단계를 잡는다', () => {
  assert.ok(hasCode(validateNodes([node({ level: 'S' })]), 'bad-level'));
  assert.deepEqual(LEVELS, ['R', 'D', 'P']);
});

test('validateNodes: 오류에는 어느 항목인지(nodeId)가 붙는다', () => {
  const res = validateNodes([node({ id: 'r1', nameKo: '기타' })]);
  const e = res.errors.find((x) => x.code === 'placeholder');
  assert.equal(e.nodeId, 'r1');
  assert.ok(e.message.length > 0);
});

// ---------------------------------------------------------------- assignCodes

test('assignCodes: 같은 부모 아래 order 순으로 01부터 매긴다', () => {
  const nodes = [
    node({ id: 'r2', level: 'R', nameKo: '연구자', nameEn: 'Researcher', order: 2 }),
    node({ id: 'r1', level: 'R', nameKo: '교사', order: 1 }),
    node({ id: 'd2', level: 'D', nameKo: '학급', parentId: 'r1', order: 2 }),
    node({ id: 'd1', level: 'D', nameKo: '수업', parentId: 'r1', order: 1 }),
  ];
  const out = assignCodes(nodes);
  const code = (id) => out.find((n) => n.id === id).code;
  assert.equal(code('r1'), 'R01');
  assert.equal(code('r2'), 'R02');
  assert.equal(code('d1'), 'D01');
  assert.equal(code('d2'), 'D02');
});

test('assignCodes: 부모가 다르면 번호가 다시 01부터 시작한다', () => {
  const nodes = [
    node({ id: 'r1', level: 'R', nameKo: '교사', order: 1 }),
    node({ id: 'r2', level: 'R', nameKo: '연구자', nameEn: 'Researcher', order: 2 }),
    node({ id: 'd1', level: 'D', nameKo: '수업', parentId: 'r1', order: 1 }),
    node({ id: 'd2', level: 'D', nameKo: '연구', parentId: 'r2', order: 1 }),
  ];
  const out = assignCodes(nodes);
  assert.equal(out.find((n) => n.id === 'd1').code, 'D01');
  assert.equal(out.find((n) => n.id === 'd2').code, 'D01');
});

test('assignCodes: 원본 배열을 건드리지 않는다', () => {
  const nodes = [node({ id: 'r1' })];
  assignCodes(nodes);
  assert.equal('code' in nodes[0], false);
});

// ---------------------------------------------------------------- folderName

test('folderName: 영어가 있으면 괄호로, 없으면 한글만', () => {
  assert.equal(folderName({ code: 'R01', nameKo: '교사', nameEn: 'Teacher' }), 'R01-교사(Teacher)');
  assert.equal(folderName({ code: 'R01', nameKo: '교사', nameEn: '' }), 'R01-교사');
  assert.equal(folderName({ code: 'R01', nameKo: '교사' }), 'R01-교사');
  assert.equal(folderName({ code: 'D01', nameKo: ' 수업 ', nameEn: ' Teaching ' }), 'D01-수업(Teaching)');
  assert.equal(folderName(null), '');
});

test('folderName: 괄호 앞에 빈칸이 없다', () => {
  assert.equal(/ \(/.test(folderName({ code: 'R01', nameKo: '교사', nameEn: 'Teacher' })), false);
});

// ---------------------------------------------------------------- renderTree

test('renderTree: 두 칸씩 들여쓴 줄을 돌려준다', () => {
  const lines = renderTree(GOOD);
  assert.deepEqual(lines, [
    'R01-교사(Teacher)',
    '  D01-수업(Teaching)',
    '    P01-이번 학기(This Semester)',
  ]);
});

test('renderTree: 모든 항목이 딱 한 번씩 나온다(부모 잃은 항목 포함)', () => {
  const nodes = GOOD.concat([node({ id: 'd9', level: 'D', nameKo: '떠돌이', parentId: '없음', order: 9 })]);
  const lines = renderTree(nodes);
  assert.equal(lines.length, nodes.length);
  assert.ok(lines.some((l) => l.includes('떠돌이')));
});

test('renderTree: 빈 목록은 빈 배열', () => {
  assert.deepEqual(renderTree([]), []);
});

// ---------------------------------------------------------------- laterNodes

test('laterNodes: R01-나(Me) 하나만 만든다', () => {
  const lines = renderTree(laterNodes());
  assert.deepEqual(lines, ['R01-나(Me)']);
  assert.equal(validateNodes(laterNodes()).ok, true);
});

// ---------------------------------------------------------------- applyPreset

test('applyPreset: 나무를 평평한 항목 목록으로 편다', () => {
  const preset = PRESETS.presets.find((p) => p.id === 'teacher');
  const nodes = applyPreset(preset);
  assert.ok(nodes.length >= 4);
  const root = nodes.find((n) => n.level === 'R');
  assert.equal(root.parentId, null);
  assert.equal(root.nameKo, '교사');
  // 모든 자식은 목록 안의 부모를 가리킨다
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) if (n.parentId != null) assert.ok(ids.has(n.parentId), n.nameKo);
  // 같은 부모 아래 order는 1부터
  const kids = nodes.filter((n) => n.parentId === root.id);
  assert.deepEqual(kids.map((n) => n.order), kids.map((_, i) => i + 1));
});

test('applyPreset: 프리셋 7종이 모두 검사를 통과한다', () => {
  for (const p of PRESETS.presets) {
    const res = validateNodes(applyPreset(p), { later: false });
    assert.equal(res.ok, true, p.id + ': ' + JSON.stringify(res.errors));
  }
});

test('applyPreset: 빈 것을 넣어도 죽지 않는다', () => {
  assert.deepEqual(applyPreset(null), []);
  assert.deepEqual(applyPreset({}), []);
  assert.deepEqual(applyPreset({ tree: [] }), []);
});

// ---------------------------------------------------------------- presets.json 스키마

test('presets.json: schema 1 · 7종 · 계약이 정한 id', () => {
  assert.equal(PRESETS.schema, 1);
  assert.equal(PRESETS.presets.length, 7);
  assert.deepEqual(
    PRESETS.presets.map((p) => p.id),
    ['teacher', 'researcher', 'business', 'developer', 'office-worker', 'student', 'writer'],
  );
  for (const p of PRESETS.presets) {
    assert.equal(typeof p.label, 'string');
    assert.ok(p.label.length > 0, p.id);
    assert.ok(Array.isArray(p.tree));
  }
});

test('presets.json: 각 프리셋은 R 1개 + D 2~3개 + D마다 P 1~2개', () => {
  for (const p of PRESETS.presets) {
    const nodes = applyPreset(p);
    const roots = nodes.filter((n) => n.level === 'R');
    assert.equal(roots.length, 1, p.id);
    const ds = nodes.filter((n) => n.level === 'D');
    assert.ok(ds.length >= 2 && ds.length <= 3, p.id + ' D=' + ds.length);
    for (const d of ds) {
      const ps = nodes.filter((n) => n.parentId === d.id);
      assert.ok(ps.length >= 1 && ps.length <= 2, p.id + '/' + d.nameKo + ' P=' + ps.length);
      for (const one of ps) assert.equal(one.level, 'P');
    }
  }
});

test('presets.json: 한글·영어가 모두 채워져 있고 금지 문자가 0건', () => {
  for (const p of PRESETS.presets) {
    for (const n of applyPreset(p)) {
      assert.ok(n.nameKo && n.nameKo.trim().length > 0, p.id);
      assert.ok(n.nameEn && n.nameEn.trim().length > 0, p.id + '/' + n.nameKo + ' 영어 이름 비어 있음');
      assert.match(n.nameEn, /^[A-Za-z0-9][A-Za-z0-9 -]*$/, p.id + '/' + n.nameEn);
      assert.equal(/[<>:"/\\|?*]/.test(n.nameKo), false, p.id + '/' + n.nameKo);
      assert.equal(/[. ]$/.test(n.nameKo), false, p.id + '/' + n.nameKo);
      assert.equal(isPlaceholderName(n.nameKo), false, p.id + '/' + n.nameKo);
    }
  }
});

test('presets.json: 개인 정보로 보이는 문자열이 없다', () => {
  const raw = readFileSync(join(HERE, '..', 'installer', 'ui', 'presets.json'), 'utf8');
  assert.equal(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(raw), false, '이메일 모양');
  assert.equal(/[A-Za-z]:\\\\/.test(raw), false, '윈도 절대경로 모양');
  assert.equal(/\d{3}-\d{3,4}-\d{4}/.test(raw), false, '전화번호 모양');
  for (const word of ['고등학교', '중학교', '초등학교', '주식회사', '선생님']) {
    assert.equal(raw.includes(word), false, word);
  }
});
