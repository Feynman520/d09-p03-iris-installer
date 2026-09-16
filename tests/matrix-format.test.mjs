// `docs\시험행렬.md` 의 **표 형식**을 못 박는다.
//
// 이 표는 사람만 읽는 문서가 아니다. 저장소 밖 릴리스 도구(`iris-release
// installer`)가 이 표를 **기계로 파싱해** 배포를 막거나 통과시킨다(설계-v2 10절).
// 그래서 문서의 머리말 주석이 적어 둔 정규식이 곧 계약이고, 표를 손보다가 그
// 계약을 깨면 릴리스 게이트가 "행이 없다"며 조용히 거부하거나 — 더 나쁘게 —
// 낡은 결과를 통과로 읽는다.
//
// 여기서 보는 것은 **형식뿐**이다. 어느 행이 `통과`인지는 시험을 돌린 결과라
// 이 시험의 관심사가 아니다(그 행들은 Task 23c 가 채운다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX = path.join(REPO, 'docs', '시험행렬.md');

const HEADER = '| # | 환경 | 잡는 것 | 어디서 | 결과 | zip 지문 | 날짜 | 근거(로그 경로) |';
// 머리말 주석이 적어 둔 그 정규식(글자 그대로). 아래 시험이 문서에서 다시
// 뽑아 이 값과 같은지도 확인한다 — 문서와 시험이 서로를 감시한다.
const ROW_RE = /^\|\s*(S\d{2})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/;
const RESULTS = new Set(['미착수', '통과', '실패']);
const GATE_ROWS = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11'];

function matrixLines() {
  return fs.readFileSync(MATRIX, 'utf8').split(/\r?\n/);
}

// 릴리스 도구가 하는 것과 같은 방식으로 행을 모은다:
// 헤더 줄 → 구분선 → 그 다음부터 표가 끝날 때까지.
function parseRows() {
  const lines = matrixLines();
  const at = lines.findIndex((l) => l.trim() === HEADER);
  assert.notEqual(at, -1, `헤더 줄이 그대로 있어야 한다:\n${HEADER}`);
  assert.match(lines[at + 1], /^\|[-|]+\|$/, '헤더 다음 줄은 구분선이어야 한다');
  const rows = [];
  for (let i = at + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    rows.push({ line, m: ROW_RE.exec(line) });
  }
  return rows;
}

test('시험행렬: 머리말 주석이 적어 둔 정규식이 실제 표와 같다(문서가 스스로를 속이지 않는다)', () => {
  const text = fs.readFileSync(MATRIX, 'utf8');
  const quoted = /`(\^\\\|[^`]*\$)`/.exec(text.replace(/\n\s*/g, ' '));
  assert.ok(quoted, '머리말 주석에 파싱 정규식이 그대로 적혀 있어야 한다');
  assert.equal(quoted[1], ROW_RE.source, '문서의 정규식과 이 시험의 정규식이 달라졌다');
  assert.ok(text.includes('그룹 1=번호(S01 등), 그룹 5=결과, 그룹 6=zip 지문, 그룹 7=날짜, 그룹 8=근거(로그 경로).'),
    '그룹 번호 설명(파서가 의지하는 계약)이 그대로 있어야 한다');
});

test('시험행렬: 12개 행이 S01~S12 순서로 모두 파싱된다', () => {
  const rows = parseRows();
  assert.equal(rows.length, 12, `표는 S01~S12 열두 행이다(지금 ${rows.length}행)`);
  for (const [i, row] of rows.entries()) {
    assert.ok(row.m, `정규식이 이 행을 읽지 못한다(파서도 못 읽는다):\n${row.line}`);
    assert.equal(row.m[1], `S${String(i + 1).padStart(2, '0')}`, '번호가 순서대로여야 한다');
  }
});

test('시험행렬: 릴리스 게이트가 보는 S01~S11 이 다 있고, 결과 칸은 세 낱말뿐이다', () => {
  const rows = parseRows();
  const byId = new Map(rows.map((r) => [r.m[1], r.m]));
  for (const id of GATE_ROWS) assert.ok(byId.has(id), `게이트 대상 ${id} 행이 없다`);
  for (const [id, m] of byId) {
    const result = m[5].trim();
    assert.ok(RESULTS.has(result), `${id} 의 결과 칸이 "미착수|통과|실패" 가 아니다: "${result}"`);
    const fingerprint = m[6].trim();
    if (result === '통과') {
      assert.match(fingerprint, /^[0-9a-f]{12}$/, `${id} 은 통과인데 zip 지문 12자가 없다`);
      assert.ok(m[7].trim(), `${id} 은 통과인데 날짜가 비어 있다`);
      assert.ok(m[8].trim(), `${id} 은 통과인데 근거가 비어 있다`);
    } else if (fingerprint) {
      assert.match(fingerprint, /^[0-9a-f]{12}$/, `${id} 의 zip 지문이 12자 소문자 hex 가 아니다`);
    }
  }
});

test('시험행렬: 셀 안에 파이프가 없다(한 칸이 두 칸으로 갈라지지 않는다)', () => {
  for (const row of parseRows()) {
    const cells = row.line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    assert.equal(cells.length, 8, `한 행은 여덟 칸이다:\n${row.line}`);
  }
});
