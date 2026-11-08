// 2.0.53 — 로그인 열쇠 감시 도구(iris-auth)를 설치 PC 에 싣는다(2026-11-02 사용자 신고:
// 설치 PC 의 IRIS 창 계정·보안에 「로그인 열쇠」 절이 통째로 없었다 — 도구가 개발 PC 에만 있었음).
// IRIS 창은 `_agent\shared\tools\iris-auth\status.mjs` 가 있어야 그 절을 켠다(Face daemon/paths.mjs authDir()).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNPACK_ORDER, V2_LAYOUT } from '../installer/setup/unpack.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
const SRC = path.join(REPO, 'payload-src', 'tools', 'iris-auth');

test('잠금표: iris-auth 는 저장소 안 사본을 IRIS 창이 찾는 자리에 놓는다', () => {
  const p = LOCK.parts['iris-auth'];
  assert.ok(p, 'lock.json parts.iris-auth 없음');
  assert.equal(p.kind, 'dir');
  assert.equal(p.source, 'payload-src/tools/iris-auth');
  assert.equal(p.dest, '_agent/shared/tools/iris-auth');
  assert.equal(p.license, 'MIT');
});

test('풀기 순서·배치표에 들어 있다(조용히 빠지지 않게)', () => {
  assert.ok(UNPACK_ORDER.includes('iris-auth'));
  assert.equal(V2_LAYOUT['iris-auth'].mode, 'slot');
});

test('사본에 IRIS 창이 부르는 세 파일과 진입점이 있다', () => {
  for (const f of ['status.mjs', 'longkey.mjs', 'lib.mjs', 'AGENTS.md']) assert.ok(fs.existsSync(path.join(SRC, f)), `${f} 없음`);
  const status = fs.readFileSync(path.join(SRC, 'status.mjs'), 'utf8');
  assert.match(status, /--json/);
  assert.match(fs.readFileSync(path.join(SRC, 'longkey.mjs'), 'utf8'), /RESULT /);
});
// 개인 문자열 0건은 tests/repo-clean.test.mjs(추적 파일 전체 정화 검사)가 이 사본까지 함께 본다.
