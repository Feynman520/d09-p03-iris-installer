// mirror-upload.mjs — 두 갈래 배포(2026-11-09, docs\설계-배포채널-2026-11-09.md)의 안전 기본값.
// latest.json 은 안정판 전용이라 최신판(기본)에서는 건드리지 않고, 읽기 실패 때 빈 표로 덮지 않는다. 네트워크 접촉 0(가짜 fetch).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, readLatest } from '../build/mirror-upload.mjs';

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

test('parseArgs: 기본은 최신판(latest.json 안 건드림), --stable 을 줘야 갱신', () => {
  assert.equal(parseArgs(['--out', 'x']).stable, false);
  assert.equal(parseArgs(['--out', 'x', '--stable']).stable, true);
  assert.throws(() => parseArgs(['--latest-json']), /unknown argument/);
});

test('readLatest: 404 = 아직 없는 표 → 빈 객체', async () => {
  assert.deepEqual(await readLatest({ fetchImpl: async () => res(404, {}) }), {});
});

test('readLatest: 다른 실패는 멈춤(빈 표로 덮어 다른 부품 항목을 지우지 않는다)', async () => {
  await assert.rejects(readLatest({ fetchImpl: async () => res(503, {}) }), /HTTP 503/);
  await assert.rejects(readLatest({ fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
  await assert.rejects(readLatest({ fetchImpl: async () => res(200, []) }), /not an object/);
});

test('readLatest: 정상 표는 그대로', async () => {
  const t = { package: { version: '2.0.55' }, face: { version: '2.99.0' } };
  assert.deepEqual(await readLatest({ fetchImpl: async () => res(200, t) }), t);
});
