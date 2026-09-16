// T18 ⑦ 인수 문서 · 설치보고 · 진단 파일
//
// 세 파일은 읽는 사람이 다르다. 시험도 그 기준으로 나눈다:
//   handoff.json  — Face 가 기계로 읽는다 → 스키마·상대경로·상태 판정이 전부
//   설치보고.md   — 사람이 읽는다 → 5순서와 진행 막대가 있는가
//   diagnostics   — 남에게 건넨다 → 사용자 이름이 한 글자도 없는가
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeHandoff, buildHandoff, readHandoff, refreshHandoffAfterOnline,
  copyInstallerProgram, firstMessageText, handoffState, setupSummary,
  RESUME_INSTALLER_PATH,
} from '../installer/setup/handoff.mjs';
import {
  writeReport, buildReport, writeDiagnostics, buildDiagnostics, maskText, progressBar,
} from '../installer/setup/report.mjs';
import { SETUP_STAGE_IDS } from '../installer/lib/receipt.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 't18h-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// 가짜 사용자 프로필 경로. 조각으로 잇는 이유: 정화 규칙(사용자 프로필 경로
// 금지)이 이 시험 파일 자체를 잡지 않게 하면서, 가림이 실제로 도는지는 봐야 한다.
const FAKE_USER_DIR = ['C:', 'Users', '홍길동'].join('\\');

let seq = 0;
function newRoot(label) {
  const root = path.join(tmp, `${label}-${seq += 1}`);
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  return root;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2), 'utf8');
  return file;
}

// 아홉 단계가 끝난 영수증(로그인은 아직).
function doneReceipt({ logins = {}, relay = null, structure = null } = {}) {
  const setup = {};
  for (const id of SETUP_STAGE_IDS) {
    setup[id] = { status: 'done', startedAt: '2026-09-15T00:00:00.000Z', finishedAt: '2026-09-15T00:01:00.000Z', recorded: {}, pending: [] };
  }
  setup.structure.recorded = structure ?? {
    created: ['R01-교사(Teacher)', 'R01-교사(Teacher)\\D01-수업(Teaching)'],
    skipped: [],
    conflicts: [],
    nameEnMissing: ['R02-연구'],
    deferred: ['S', 'T', 'tags'],
  };
  return {
    schema: 2,
    package: { name: 'IRIS', version: '2.0.0' },
    setup,
    login: logins,
    online: relay ? { relay } : {},
  };
}

function ctxFor(root, extra = {}) {
  return {
    root,
    fs,
    log: () => {},
    manifest: { package: { name: 'IRIS', version: '2.0.0' } },
    choice: { subscriptions: ['claude', 'chatgpt'], leadAgent: 'claude' },
    precheck: { recorded: { edge: { present: true }, os: { build: 26200 } } },
    receipt: doneReceipt(),
    offline: true,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// handoff.json 스키마
// ---------------------------------------------------------------------------

const REQUIRED_KEYS = [
  'schema', 'packageVersion', 'writtenAt', 'state', 'subscriptions', 'leadAgent',
  'login', 'relay', 'setup', 'folders', 'nameEnMissing', 'deferred',
  'pendingCapabilities', 'checks', 'reportPath', 'diagnosticsPath',
  'firstMessage', 'messenger', 'resume', 'setupCompletedAt',
];

test('계약이 요구하는 칸이 전부 있고, 경로는 모두 루트 상대경로다', () => {
  const root = newRoot('schema');
  const { handoff, path: file } = writeHandoff(ctxFor(root), {
    checks: { pass: 9, pending: 1, fail: 0 },
    pending: [{ capability: '문서 자동화(한글)', reason: '한컴오피스가 설치되어 있지 않습니다', howToEnable: '한컴오피스를 설치하면 자동으로 켜집니다' }],
    reportPath: path.join(root, '_agent', 'setup', '설치보고-2026-09-15.md'),
    diagnosticsPath: path.join(root, '_agent', 'setup', 'diagnostics.json'),
    assumeDone: ['checks'],
  });

  for (const key of REQUIRED_KEYS) assert.ok(key in handoff, `${key} 칸이 있어야 한다`);
  assert.equal(handoff.schema, 1);
  assert.equal(handoff.packageVersion, '2.0.0');
  assert.equal(handoff.reportPath, '_agent/setup/설치보고-2026-09-15.md');
  assert.equal(handoff.diagnosticsPath, '_agent/setup/diagnostics.json');
  assert.deepEqual(handoff.folders, ['R01-교사(Teacher)', 'R01-교사(Teacher)/D01-수업(Teaching)']);
  assert.deepEqual(handoff.deferred, ['S', 'T', 'tags']);
  assert.deepEqual(handoff.checks, { pass: 9, pending: 1, fail: 0 });

  // 절대경로·드라이브 문자가 한 곳도 없어야 한다(휴대성).
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(/[A-Za-z]:\\\\/.test(text), false, '절대경로가 들어가면 안 된다');
  assert.equal(text.includes(os.userInfo().username), false, '사용자 이름이 들어가면 안 된다');
});

test('messenger 는 중첩 키가 정본이고 prompted 는 false 로 시작한다', () => {
  const root = newRoot('messenger');
  fs.mkdirSync(path.join(root, '_agent', 'shared', 'tools', 'face', 'modules', 'messenger'), { recursive: true });
  const { handoff } = writeHandoff(ctxFor(root), { assumeDone: ['checks'] });
  assert.deepEqual(handoff.messenger, { installed: true, prompted: false });
  assert.equal('messengerPrompted' in handoff, false, '평면 키는 쓰지 않는다');

  const none = buildHandoff(ctxFor(newRoot('messenger-none')), { assumeDone: ['checks'] });
  assert.deepEqual(none.messenger, { installed: false, prompted: false });
});

test('resume.installerPath 는 계약이 정한 글자 그대로다', () => {
  const root = newRoot('resume');
  const { handoff } = writeHandoff(ctxFor(root), { assumeDone: ['checks'] });
  assert.equal(handoff.resume.installerPath, '_agent/setup/installer/IRIS-설치.cmd');
  assert.equal(RESUME_INSTALLER_PATH, '_agent/setup/installer/IRIS-설치.cmd');
  assert.deepEqual(handoff.resume.args, ['--resume']);
});

// ---------------------------------------------------------------------------
// 상태 판정
// ---------------------------------------------------------------------------

test('상태: 단계가 덜 끝났으면 setup-incomplete', () => {
  const root = newRoot('state-incomplete');
  const receipt = doneReceipt();
  receipt.setup.ontology = { status: 'failed', code: 'E-ONTOLOGY', message: '그래프가 최신이 아닙니다' };
  const h = buildHandoff(ctxFor(root, { receipt }), { assumeDone: ['checks'] });
  assert.equal(h.state, 'setup-incomplete');
  assert.equal(h.setup.allDone, false);
  assert.deepEqual(h.setup.failed, { id: 'ontology', code: 'E-ONTOLOGY', message: '그래프가 최신이 아닙니다' });
  assert.equal(h.setupCompletedAt, null);
});

test('상태: 세팅은 끝났고 로그인이 남았으면 login-pending', () => {
  const root = newRoot('state-login');
  const h = buildHandoff(ctxFor(root), { assumeDone: ['checks'] });
  assert.equal(h.state, 'login-pending');
  assert.equal(h.setup.allDone, true);
  assert.deepEqual(h.login, { claude: 'waiting', chatgpt: 'waiting' });
});

test('상태: 고른 구독이 전부 로그인되면 ready, 안 고른 구독은 not-needed', () => {
  const root = newRoot('state-ready');
  const receipt = doneReceipt({ logins: { claude: { state: 'done' } } });
  const ctx = ctxFor(root, { receipt, choice: { subscriptions: ['claude'], leadAgent: 'claude' } });
  const h = buildHandoff(ctx, { assumeDone: ['checks'] });
  assert.equal(h.state, 'ready');
  assert.deepEqual(h.login, { claude: 'done', chatgpt: 'not-needed' });
  assert.ok(h.setupCompletedAt);
});

test('상태: CLI 로그인만 되고 중계기 등록 전이면 아직 waiting 이다', () => {
  const receipt = doneReceipt({ logins: { claude: { state: 'cli-done' } } });
  const h = buildHandoff(ctxFor(newRoot('state-cli'), { receipt, choice: { subscriptions: ['claude'], leadAgent: 'claude' } }), { assumeDone: ['checks'] });
  assert.equal(h.login.claude, 'waiting');
  assert.equal(h.state, 'login-pending');
});

test('handoffState·setupSummary 는 따로도 맞는 답을 낸다', () => {
  assert.equal(handoffState({ setup: { allDone: false }, login: {}, subscriptions: [] }), 'setup-incomplete');
  assert.equal(handoffState({ setup: { allDone: true }, login: { claude: 'waiting' }, subscriptions: ['claude'] }), 'login-pending');
  assert.equal(handoffState({ setup: { allDone: true }, login: { claude: 'done' }, subscriptions: ['claude'] }), 'ready');
  const s = setupSummary(doneReceipt(), {});
  assert.equal(s.allDone, true);
  assert.equal(s.doneCount, 9);
});

// ---------------------------------------------------------------------------
// 로그인 뒤 갱신
// ---------------------------------------------------------------------------

test('refreshHandoffAfterOnline: 로그인·중계기를 반영해 ready 로 바꾸고 Face 가 쓴 칸은 지키다', () => {
  const root = newRoot('refresh');
  const ctx = ctxFor(root, { choice: { subscriptions: ['claude'], leadAgent: 'claude' } });
  writeHandoff(ctx, { assumeDone: ['checks'] });

  // Face 가 메신저 안내를 한 번 보여 주고 prompted 를 true 로 고쳤다.
  const mid = readHandoff(root, { fs });
  mid.messenger.prompted = true;
  write(path.join(root, '_agent', 'setup', 'handoff.json'), mid);

  const after2 = refreshHandoffAfterOnline({
    ...ctx,
    receipt: doneReceipt({ logins: { claude: { state: 'done' } }, relay: { state: 'done', accounts: 1 } }),
  });

  assert.equal(after2.written, true);
  assert.equal(after2.handoff.state, 'ready');
  assert.deepEqual(after2.handoff.login, { claude: 'done', chatgpt: 'not-needed' });
  assert.deepEqual(after2.handoff.relay, { state: 'done', accounts: 1 });
  assert.equal(after2.handoff.messenger.prompted, true, 'Face 가 고친 칸은 그대로');
  assert.ok(after2.handoff.setupCompletedAt);
});

test('refreshHandoffAfterOnline: 인수 문서가 아직 없으면 새로 지어내지 않는다', () => {
  const root = newRoot('refresh-none');
  const r = refreshHandoffAfterOnline(ctxFor(root));
  assert.equal(r.written, false);
  assert.equal(r.reason, 'no-handoff');
  assert.equal(fs.existsSync(path.join(root, '_agent', 'setup', 'handoff.json')), false);
});

// ---------------------------------------------------------------------------
// 첫 인사 프롬프트
// ---------------------------------------------------------------------------

test('firstMessage: 영어 이름 미정 폴더 수를 담고, 선택형 질문 도구를 막는다', () => {
  const some = firstMessageText({ nameEnMissing: ['R02-연구', 'D03-기록'] });
  assert.match(some, /_agent\/setup\/handoff\.json/);
  assert.match(some, /3줄로 인사/);
  assert.match(some, /영어 이름이 비어 있는 폴더가 2개 있으니/);
  assert.match(some, /선택형 질문 도구는 쓰지 말고 번호 목록으로/);

  const none = firstMessageText({ nameEnMissing: [] });
  assert.match(none, /영어 이름이 비어 있는 폴더가 있으면/);
});

// ---------------------------------------------------------------------------
// 설치기 사본
// ---------------------------------------------------------------------------

function fakeZipRoot(label, { version = '2.0.0' } = {}) {
  const zip = path.join(tmp, `zip-${label}-${seq += 1}`);
  write(path.join(zip, 'IRIS-설치.cmd'), '@echo off\r\n');
  write(path.join(zip, 'installer', 'IRIS-설치.cmd'), '@echo off\r\n');
  write(path.join(zip, 'installer', 'bootstrap.ps1'), '# bootstrap');
  write(path.join(zip, 'installer', 'server.mjs'), `// server ${version}`);
  write(path.join(zip, 'installer', 'ui', 'index.html'), '<!doctype html>');
  // 사본에 들어가면 안 되는 세 모양:
  write(path.join(zip, 'installer', 'tests', 'mock.mjs'), '// ① tests\\ 폴더 안');
  write(path.join(zip, 'installer', 'ui', 'mock-server.mjs'), '// ② 마디 이름이 mock- 로 시작(마디 검사만으로는 안 걸린다)');
  write(path.join(zip, 'installer', 'lib', 'foo.test.mjs'), '// ③ tests\\ 밖에 홀로 있는 *.test.*');
  write(path.join(zip, 'installer', 'lib', 'foo.mjs'), '// 이건 들어가야 한다');
  write(path.join(zip, 'lib', 'run.mjs'), '// run');
  write(path.join(zip, 'lock.json'), { parts: {} });
  write(path.join(zip, 'payload', 'manifest.json'), { package: { version }, parts: { node: { file: 'node.zip', sha256: 'x' } } });
  return zip;
}

test('설치기 사본: 계약이 정한 자리에 진입점이 생기고, 부품과 시험 파일은 빠진다', () => {
  const root = newRoot('copy');
  const zip = fakeZipRoot('copy');
  const ctx = ctxFor(root, { payloadDir: path.join(zip, 'payload') });
  const r = copyInstallerProgram(ctx);

  assert.equal(r.ok, true);
  assert.equal(r.entry, RESUME_INSTALLER_PATH);
  const entry = path.join(root, '_agent', 'setup', 'installer', 'IRIS-설치.cmd');
  assert.ok(fs.existsSync(entry), '진입점이 정확한 자리에 있어야 한다');
  // `%~dp0\installer\bootstrap.ps1` 이 풀리도록 zip 루트와 같은 모양이어야 한다.
  assert.ok(fs.existsSync(path.join(root, '_agent', 'setup', 'installer', 'installer', 'bootstrap.ps1')));
  assert.ok(fs.existsSync(path.join(root, '_agent', 'setup', 'installer', 'lib', 'run.mjs')));
  assert.ok(fs.existsSync(path.join(root, '_agent', 'setup', 'installer', 'lock.json')));

  // 시험·가짜 파일 세 모양이 전부 빠져야 한다(마디 검사만으로는 뒤 둘이 새어 나갔다).
  const inCopy = (...segs) => fs.existsSync(path.join(root, '_agent', 'setup', 'installer', 'installer', ...segs));
  assert.equal(inCopy('tests'), false, 'tests\\ 폴더');
  assert.equal(inCopy('ui', 'mock-server.mjs'), false, 'mock- 로 시작하는 파일');
  assert.equal(inCopy('lib', 'foo.test.mjs'), false, 'tests\\ 밖의 *.test.*');
  assert.ok(inCopy('lib', 'foo.mjs'), '보통 파일은 그대로 들어간다');
  assert.ok(inCopy('ui', 'index.html'));

  // 부품 표는 있되 부품은 0개(부트스트랩의 "먼저 압축을 푸세요"를 통과시키는 최소치).
  const mf = JSON.parse(fs.readFileSync(path.join(root, '_agent', 'setup', 'installer', 'payload', 'manifest.json'), 'utf8'));
  assert.deepEqual(mf.parts, {});
  assert.equal(mf.resumeOnly, true);
});

test('설치기 사본: 두 번 불러도 덮어쓰지 않는다(무삭제)', () => {
  const root = newRoot('copy-twice');
  const zip = fakeZipRoot('twice');
  const ctx = ctxFor(root, { payloadDir: path.join(zip, 'payload') });
  const first = copyInstallerProgram(ctx);
  const second = copyInstallerProgram(ctx);
  assert.ok(first.copied > 0);
  assert.equal(second.copied, 0);
  assert.ok(second.kept > 0);
  assert.equal(second.ok, true);
});

test('설치기 사본: 판이 그대로면 갈아 끼우지 않는다', () => {
  const root = newRoot('copy-same');
  const zip = fakeZipRoot('same', { version: '2.0.0' });
  const ctx = ctxFor(root, { payloadDir: path.join(zip, 'payload') });

  const first = copyInstallerProgram(ctx);
  assert.equal(first.version, '2.0.0');
  assert.equal(first.previousVersion, null, '첫 설치라 적혀 있던 판이 없다');
  assert.equal(first.replaced, false);
  assert.equal(fs.readFileSync(path.join(root, '_agent', 'setup', 'installer', '.version'), 'utf8').trim(), '2.0.0');

  const second = copyInstallerProgram(ctx);
  assert.equal(second.replaced, false, '같은 판이면 그대로 둔다');
  assert.equal(second.previousVersion, '2.0.0');
  assert.equal(second.copied, 0);
  assert.equal(fs.existsSync(path.join(root, '_agent', 'setup', 'installer.prev')), false);
});

test('설치기 사본: 판이 다르면 새로 지어 바꿔 끼우고 직전 판은 한 세대 남긴다', () => {
  const root = newRoot('copy-newer');
  const old = fakeZipRoot('old', { version: '2.0.0' });
  copyInstallerProgram(ctxFor(root, { payloadDir: path.join(old, 'payload') }));

  const newer = fakeZipRoot('new', { version: '2.0.1' });
  const r = copyInstallerProgram(ctxFor(root, {
    payloadDir: path.join(newer, 'payload'),
    manifest: { package: { name: 'IRIS', version: '2.0.1' } },
  }));

  assert.equal(r.replaced, true);
  assert.equal(r.previousVersion, '2.0.0');
  assert.equal(r.version, '2.0.1');
  assert.equal(r.ok, true);

  const copyDir = path.join(root, '_agent', 'setup', 'installer');
  assert.equal(fs.readFileSync(path.join(copyDir, '.version'), 'utf8').trim(), '2.0.1');
  assert.match(fs.readFileSync(path.join(copyDir, 'installer', 'server.mjs'), 'utf8'), /2\.0\.1/, '새 판 내용으로 바뀌었다');
  assert.ok(fs.existsSync(path.join(copyDir, 'IRIS-설치.cmd')), '진입점은 그대로 그 자리에');
  assert.equal(fs.existsSync(`${copyDir}.new`), false, '갈아 끼운 뒤 임시 폴더는 남지 않는다');

  // 직전 판은 한 세대만 보관한다.
  const prev = `${copyDir}.prev`;
  assert.match(fs.readFileSync(path.join(prev, 'installer', 'server.mjs'), 'utf8'), /2\.0\.0/);
});

test('설치기 사본: 꾸러미 판을 모르면 멀쩡한 사본을 버리지 않는다', () => {
  const root = newRoot('copy-unknown');
  const zip = fakeZipRoot('unknown', { version: '2.0.0' });
  copyInstallerProgram(ctxFor(root, { payloadDir: path.join(zip, 'payload') }));

  // 꾸러미 표도, 영수증의 판도, 잠금표도 없는 상황(판을 알 길이 없다).
  const r = copyInstallerProgram({
    root, fs, log: () => {}, manifest: null, lock: null,
    receipt: { schema: 2, setup: {} },
    payloadDir: path.join(zip, 'payload'),
  });
  assert.equal(r.version, null);
  assert.equal(r.replaced, false);
  assert.equal(fs.readFileSync(path.join(root, '_agent', 'setup', 'installer', '.version'), 'utf8').trim(), '2.0.0');
});

test('설치기 사본: 원본이 없으면 조용히 못 했다고 알린다(설치를 멈추지 않는다)', () => {
  const root = newRoot('copy-none');
  const r = copyInstallerProgram(ctxFor(root, { payloadDir: path.join(tmp, 'nowhere', 'payload') }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['installer']);
});

// ---------------------------------------------------------------------------
// 설치보고 md
// ---------------------------------------------------------------------------

test('설치보고: 5순서와 20칸 진행 막대가 있다', () => {
  const root = newRoot('report');
  const { text, path: file } = writeReport(ctxFor(root), {
    checks: { pass: 10, pending: 1, fail: 0 },
    checkItems: [{ id: 'edge', num: 9, label: '엣지 브라우저', status: 'pending', detail: '엣지를 찾지 못했습니다' }],
    pending: [{ capability: '문서 자동화(한글)', reason: '한컴오피스가 없습니다', howToEnable: '한컴오피스를 설치하면 켜집니다' }],
    stages: Object.fromEntries(SETUP_STAGE_IDS.map((id) => [id, { status: 'done' }])),
    now: new Date('2026-09-15T12:00:00+09:00'),
  });

  assert.ok(file.endsWith('설치보고-2026-09-15.md'));
  assert.match(text, /## 1\. 하려던 일/);
  assert.match(text, /## 2\. 기존 자료의 안전/);
  assert.match(text, /## 3\. 결과/);
  assert.match(text, /## 4\. 남은 일의 뜻/);
  assert.match(text, /## 5\. 사용자가 할 일/);
  const bar = /\[([█░]{20})\]\s+(\d+)%/.exec(text);
  assert.ok(bar, '20칸 막대가 있어야 한다');
  assert.equal(bar[1].length, 20);
  assert.equal(bar[2], '100');
  assert.match(text, /문서 자동화\(한글\)/);
  assert.match(text, /구독 로그인이 남았습니다/);
});

test('설치보고: 멈춘 설치는 막대가 100% 가 아니고 다시 시도를 안내한다', () => {
  const root = newRoot('report-fail');
  const stages = {};
  for (const id of SETUP_STAGE_IDS.slice(0, 4)) stages[id] = { status: 'done' };
  for (const id of SETUP_STAGE_IDS.slice(5)) stages[id] = { status: 'pending' };
  stages.venv = { status: 'failed', code: 'E-VENV' };
  const text = buildReport(ctxFor(root), {
    checks: { pass: 0, pending: 0, fail: 0 },
    stages,
    failed: { id: 'venv', code: 'E-VENV', message: '파이썬 환경을 만들지 못했습니다' },
  });
  const bar = /\[([█░]{20})\]\s+(\d+)%/.exec(text);
  assert.equal(bar[2], '44', '4/9 = 44%(내림)');
  assert.match(text, /E-VENV/);
  assert.match(text, /「다시 시도」/);
});

test('progressBar: 퍼센트는 내림이고 칸은 언제나 20개', () => {
  assert.equal(progressBar(0, 9).line.includes('[░░░░░░░░░░░░░░░░░░░░]'), true);
  assert.equal(progressBar(8, 9).percent, 88);
  assert.equal(progressBar(9, 9).percent, 100);
  assert.equal(progressBar(19, 20).percent, 95);
});

// ---------------------------------------------------------------------------
// diagnostics.json — 가림
// ---------------------------------------------------------------------------

test('진단 파일: 사용자 이름과 영혼 이름이 한 글자도 남지 않는다', () => {
  const root = path.join(tmp, 'IRIS-연습');
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });

  const receipt = doneReceipt();
  receipt.setup.relay = {
    status: 'failed',
    code: 'E-RELAY',
    // 일부러 사용자 이름이 든 경로를 섞는다.
    message: `${FAKE_USER_DIR}\\AppData\\Roaming\\teamclaude.json 과 ${root}\\_agent\\x 를 읽지 못했습니다`,
    recorded: { files: [`${FAKE_USER_DIR}\\Desktop\\IRIS.lnk`, 'IRIS-연습\\_agent\\x'] },
  };

  const { diagnostics, path: file } = writeDiagnostics(ctxFor(root, { receipt }), {
    checks: { pass: 8, pending: 1, fail: 1 },
    checkItems: [{ id: 'exe', num: 1, label: '실행 파일', status: 'fail', detail: `${FAKE_USER_DIR}\\python.exe 없음` }],
    failed: { id: 'relay', code: 'E-RELAY', message: `${FAKE_USER_DIR} 에서 실패` },
  });

  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('홍길동'), false, '사용자 이름이 남으면 안 된다');
  assert.match(text, /<user>/);
  assert.equal(text.includes('IRIS-연습\\\\_agent'), false, '영혼 폴더 이름도 가린다');
  assert.match(text, /<root>/);
  assert.equal(diagnostics.schema, 1);
  assert.equal(diagnostics.stages.relay.status, 'failed');
  assert.equal(diagnostics.stages.relay.code, 'E-RELAY');
  assert.equal(diagnostics.checks.summary.fail, 1);
  assert.ok(diagnostics.environment.os);
});

test('maskText: 경로 조각일 때만 영혼 이름을 접고, 산문 속 같은 낱말은 둔다', () => {
  const realRoot = ['C:', 'IRIS'].join('\\');
  const masked = maskText(`${realRoot}\\_agent 를 만들었습니다. IRIS 창을 여세요.`, { root: realRoot });
  assert.match(masked, /<root>\\_agent/);
  assert.match(masked, /IRIS 창을 여세요/, '설명 문장은 읽을 수 있어야 한다');
});

test('진단 파일: 단계별 결과와 실패 코드가 아홉 칸 전부 있다', () => {
  const d = buildDiagnostics(ctxFor(newRoot('diag-stages')), { checks: { pass: 11, pending: 0, fail: 0 } });
  assert.deepEqual(Object.keys(d.stages), [...SETUP_STAGE_IDS]);
  assert.equal(d.failed, null);
  assert.equal(d.environment.offline, true);
});
