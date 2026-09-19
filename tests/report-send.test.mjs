import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReportPayload, sendReport, saveReportCopy, encodeForm, newReportId, tailLines, clip, pickState,
  FORM_FIELDS, REPORT_FORM_URL, LIMITS,
} from '../installer/lib/report-send.mjs';

// 가짜 사용자 경로는 조립해서 만든다 — 정적 검사 ⑦⑧(개인정보 스캔)이 소스 속 "드라이브:\Users\<이름>" 리터럴을 잡기 때문(2026-09-19).
const FAKE_NAME = 'Hong Gildong';
const FAKE_HOME = ['C:', 'Users', FAKE_NAME].join('\\');
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-report-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function fakeState(root) {
  return {
    step: 'setup', packageVersion: '2.0.20',
    choice: { subscriptions: ['chatgpt'], leadAgent: 'codex' },
    soul: { root, name: 'IRIS' },
    precheck: { recorded: { blockers: [], warnings: [{ id: 'w1', message: `${FAKE_HOME}\\Desktop 은 OneDrive` }] } },
    setup: {
      stage: 'venv', percent: 44,
      error: { id: 'venv', code: 'E-VENV', message: '파이썬 꾸리기에서 멈췄습니다', detail: `EBUSY ${FAKE_HOME}\\IRIS\\_agent\\x.pyd` },
      stages: [{ id: 'unpack', status: 'done' }, { id: 'venv', status: 'failed', code: 'E-VENV' }],
      live: { text: 'x', at: 1 },
    },
    online: { stage: null, logins: { chatgpt: { state: 'waiting', reason: null } } },
    secretsShouldNotLeak: 'sk-ant-should-not-be-copied',
  };
}

test('report: 묶음은 사용자 이름을 가리고, 상태에서 고른 것만 담고, 진단·로그 꼬리를 싣는다', () => {
  const root = path.join(tmp, 'soul-a');
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(root, '_agent', 'setup', 'diagnostics.json'), JSON.stringify({ env: { home: FAKE_HOME }, stages: {} }), 'utf8');
  const logDir = path.join(tmp, 'logs-a');
  fs.mkdirSync(logDir, { recursive: true });
  const many = Array.from({ length: 500 }, (_, i) => `line ${i} ${FAKE_HOME}\\x`).join('\n');
  fs.writeFileSync(path.join(logDir, 'server.log'), many, 'utf8');
  fs.writeFileSync(path.join(logDir, 'bootstrap.log'), 'boot ok\n', 'utf8');

  const p = buildReportPayload({
    state: fakeState(root), root, fs,
    logs: { server: path.join(logDir, 'server.log'), soul: path.join(root, 'nope.log') },
    memo: `  설치 중 멈춤 ${FAKE_HOME}\\memo `, contact: 'me@\nexample',
    now: new Date(2026, 8, 19, 14, 5),
  });
  assert.match(p.id, /^R-20260919-1405-[0-9a-f]{4}$/);
  assert.equal(p.version, '2.0.20');
  assert.equal(p.where, 'step=setup / setup.stage=venv / online.stage=- / code=E-VENV');
  for (const field of ['summary', 'diagnostics', 'logs', 'memo']) {
    assert.ok(!p[field].includes(FAKE_NAME), `${field} 에 사용자 이름이 남음`);
  }
  assert.ok(p.summary.includes('<user>') && p.summary.includes('E-VENV') && p.summary.includes('"leadAgent": "codex"'));
  assert.ok(!p.summary.includes('sk-ant-should-not-be-copied'), '고르지 않은 상태 키는 담지 않는다');
  assert.ok(p.summary.includes('"os":') && p.summary.includes('"node":'), '환경 지문');
  const MASKED_JSON = ['C:', 'Users', '<user>'].join('\\\\'); // JSON 문자열 안의 표기(역슬래시 두 개)
  assert.ok(p.diagnostics.includes(`"home":"${MASKED_JSON}"`), p.diagnostics);
  assert.ok(p.logs.includes('line 499') && !p.logs.includes('line 100 '), `로그는 꼬리 ${LIMITS.tailLines}줄만`);
  assert.ok(p.logs.includes('bootstrap.log') && p.logs.includes('boot ok'));
  assert.ok(!p.logs.includes('영혼 사본'), '없는 로그 파일은 건너뛴다');
  assert.equal(p.memo, `설치 중 멈춤 ${['C:', 'Users', '<user>'].join('\\')}\\memo`);
  assert.equal(p.contact, 'me@ example');
});

test('report: 영혼이 없어도 묶음을 만든다(진단 없음 표시)', () => {
  const p = buildReportPayload({ state: { step: 'precheck', packageVersion: '2.0.20' }, root: null, fs, logs: {} });
  assert.ok(p.diagnostics.startsWith('(diagnostics.json 없음'));
  assert.equal(p.logs, '(로그 파일 없음)');
  assert.equal(p.where, 'step=precheck / setup.stage=- / online.stage=- / code=-');
});

test('report: 상한을 넘으면 자른다(진단·요약은 머리, 로그는 꼬리)', () => {
  assert.equal(clip('abcdef', 10), 'abcdef');
  assert.ok(clip('x'.repeat(100), 10).endsWith('x'.repeat(10)) && clip('x'.repeat(100), 10).startsWith('…[앞 90자 잘림]'));
  assert.ok(clip('y'.repeat(100), 10, { head: true }).startsWith('y'.repeat(10)) && clip('y'.repeat(100), 10, { head: true }).endsWith('[90자 잘림]'));
  assert.equal(tailLines('a\nb\nc\nd', 2), 'c\nd');
  const big = { step: 'setup', setup: { error: { detail: 'z'.repeat(LIMITS.summary * 2) } } };
  assert.ok(buildReportPayload({ state: big, root: null, fs, logs: {} }).summary.length <= LIMITS.summary + 40);
});

test('report: 폼 인코딩은 항목 번호 8개 전부에 값을 싣고, 전송은 fetch 한 번(POST·urlencoded)', async () => {
  const payload = { id: 'R-1', version: '2', where: 'w', summary: 's', diagnostics: 'd', logs: 'l', memo: 'm', contact: 'c' };
  const body = encodeForm(payload);
  const parsed = new URLSearchParams(body);
  for (const [key, entry] of Object.entries(FORM_FIELDS)) assert.equal(parsed.get(entry), payload[key], entry);
  assert.equal([...parsed.keys()].length, 8);

  const calls = [];
  const r = await sendReport(payload, { fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: 200 }; } });
  assert.equal(r.ok, true); assert.equal(r.status, 200); assert.equal(r.trimmed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REPORT_FORM_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  assert.equal(calls[0].init.body, body);

  const bad = await sendReport(payload, { fetchImpl: async () => ({ status: 400 }) });
  assert.equal(bad.ok, false); assert.equal(bad.status, 400);
  const threw = await sendReport(payload, { fetchImpl: async () => { throw new Error('ENOTFOUND docs.google.com'); } });
  assert.equal(threw.ok, false); assert.match(threw.error, /ENOTFOUND/);
  const none = await sendReport(payload, { fetchImpl: null });
  assert.equal(none.ok, false);
});

test('report: 사본은 영혼 안 _agent\\setup 에, 영혼이 없으면 대체 폴더에 남긴다', () => {
  const root = path.join(tmp, 'soul-b');
  const payload = { id: 'R-copy', version: '2', where: 'w', summary: 's', diagnostics: 'd', logs: 'l', memo: '', contact: '' };
  const a = saveReportCopy({ root, payload, fs, sent: { ok: true, status: 200 } });
  assert.equal(a.path, path.join(root, '_agent', 'setup', '신고-R-copy.json'));
  const saved = JSON.parse(fs.readFileSync(a.path, 'utf8'));
  assert.equal(saved.sent.ok, true); assert.equal(saved.id, 'R-copy');
  const b = saveReportCopy({ root: null, fallbackDir: path.join(tmp, 'fallback'), payload, fs });
  assert.equal(b.path, path.join(tmp, 'fallback', '신고-R-copy.json'));
  assert.equal(saveReportCopy({ root: null, fallbackDir: null, payload, fs }), null);
});

test('report: 접수번호는 시각+난수, pickState 는 정해진 키만', () => {
  assert.equal(newReportId(new Date(2026, 0, 2, 3, 4), 'abcd'), 'R-20260102-0304-abcd');
  const k = Object.keys(pickState({ step: 'x', foo: 1 })).sort();
  assert.deepEqual(k, ['auto', 'autoResult', 'choice', 'installError', 'online', 'packageVersion', 'precheck', 'setup', 'soul', 'step']);
});

test('report: 폼 본문이 구글 한도(약 32 KB)를 넘으면 로그→진단→요약 순으로 줄여 28 KB 아래로 맞춘다(한글은 인코딩 바이트 기준)', async () => {
  const { fitForm, FORM_MAX_BYTES } = await import('../installer/lib/report-send.mjs');
  const ko = '설치 로그 한 줄 '.repeat(6000); // 한글은 인코딩하면 글자당 9바이트
  const big = { id: 'R-x', version: '2', where: 'w', summary: ko, diagnostics: ko, logs: ko, memo: '메모', contact: '' };
  assert.ok(encodeForm(big).length > FORM_MAX_BYTES * 5);
  const fit = fitForm(big);
  assert.ok(fit.trimmed);
  assert.ok(fit.bytes <= FORM_MAX_BYTES, `still ${fit.bytes} bytes`);
  assert.ok(fit.payload.logs.startsWith('…[크기 제한'), '로그는 꼬리를 남긴다');
  assert.ok(fit.payload.summary.endsWith('자 더 잘림]'), '요약은 머리를 남긴다');
  assert.equal(fit.payload.memo, '메모', '작은 칸은 손대지 않는다');
  const small = fitForm({ id: 'R-y', version: '2', where: 'w', summary: 's', diagnostics: 'd', logs: 'l', memo: '', contact: '' });
  assert.equal(small.trimmed, false);
  // 실제 전송 경로도 줄인 본문을 보낸다
  let sentBytes = 0;
  const r = await sendReport(big, { fetchImpl: async (url, init) => { sentBytes = init.body.length; return { status: 200 }; } });
  assert.equal(r.ok, true); assert.ok(sentBytes <= FORM_MAX_BYTES); assert.equal(r.trimmed, true);
});
