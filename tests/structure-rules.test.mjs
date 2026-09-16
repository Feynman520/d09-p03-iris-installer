import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as rules from '../installer/lib/structure-rules.mjs';
import * as ui from '../installer/ui/structure.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-structure-rules-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// 화면(미리 보기)과 서버(정본)가 **같은 규칙**이어야 한다 — 미리 보기에서
// 통과한 나무가 제출하자마자 거절당하면 왕초보는 무엇이 잘못됐는지 알 수 없다.
// lib/structure-rules.mjs 는 규칙을 다시 쓰지 않고 ui/structure.mjs 를 그대로
// 다시 내보내므로, "두 구현이 같은 입출력을 낸다"는 것은 **같은 함수인지**로
// 확인하는 것이 가장 강한 증거다.
test('server rules ARE the screen rules (같은 함수 객체, 갈라질 여지 없음)', () => {
  assert.equal(rules.validateNodes, ui.validateNodes);
  assert.equal(rules.assignCodes, ui.assignCodes);
  assert.equal(rules.folderName, ui.folderName);
  assert.equal(rules.laterNodes, ui.laterNodes);
});

function node(over = {}) {
  return { id: 'n1', parentId: null, level: 'R', nameKo: '교사', nameEn: 'Teacher', order: 1, ...over };
}

test('buildDecisions: 같은 부모 아래 order 순으로 01부터, 폴더 이름은 코드-한글(영어)', () => {
  const nodes = [
    node({ id: 'r1', nameKo: '교사', nameEn: 'Teacher', order: 2 }),
    node({ id: 'r2', nameKo: '연구자', nameEn: 'Researcher', order: 1 }),
    node({ id: 'd1', parentId: 'r1', level: 'D', nameKo: '수업', nameEn: 'Teaching', order: 1 }),
    node({ id: 'd2', parentId: 'r1', level: 'D', nameKo: '담임', nameEn: '', order: 2 }),
    node({ id: 'p1', parentId: 'd1', level: 'P', nameKo: '2학기 준비', nameEn: 'Fall Prep', order: 1 }),
  ];
  const d = rules.buildDecisions({ nodes, now: new Date('2026-09-15T00:00:00.000Z') });
  assert.equal(d.schema, 1);
  assert.equal(d.later, false);
  assert.equal(d.createdAt, '2026-09-15T00:00:00.000Z');
  const byId = Object.fromEntries(d.nodes.map((n) => [n.id, n]));
  assert.equal(byId.r2.code, 'R01', 'order 1 이 먼저');
  assert.equal(byId.r1.code, 'R02');
  assert.equal(byId.d1.folderName, 'D01-수업(Teaching)');
  assert.equal(byId.d2.folderName, 'D02-담임', '영어 칸을 비우면 괄호도 없다');
  assert.equal(byId.p1.folderName, 'P01-2학기 준비(Fall Prep)');
  assert.deepEqual(d.deferred, ['S', 'T', 'tags']);
  assert.deepEqual(d.nameEnMissing, ['D02-담임']);
});

test('buildDecisions(later): R01-나(Me) 하나만, D·P 까지 미룬다', () => {
  const d = rules.buildDecisions({ later: true });
  assert.equal(d.later, true);
  assert.equal(d.nodes.length, 1);
  assert.equal(d.nodes[0].folderName, 'R01-나(Me)');
  assert.deepEqual(d.deferred, ['D', 'P', 'S', 'T', 'tags']);
  assert.deepEqual(d.nameEnMissing, []);
});

test('writeDecisions: 원자 저장(.tmp 남지 않음) + 되읽기', () => {
  const root = path.join(tmp, 'soul');
  const d = rules.buildDecisions({ nodes: [node()] });
  const dest = rules.writeDecisions(root, d);
  assert.equal(dest, rules.decisionsPath(root));
  assert.ok(!fs.existsSync(`${dest}.tmp`));
  assert.deepEqual(rules.readDecisions(root), d);
  assert.equal(rules.readDecisions(path.join(tmp, 'nope')), null);
});
