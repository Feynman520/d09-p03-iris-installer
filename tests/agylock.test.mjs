// installer/lib/agylock.mjs — Antigravity 화면 잠금의 설치기 쪽 판정(2.0.67).
//
// 열쇠 파일은 시험이 그때그때 임시 폴더에 쓴다. 저장소 · 시험 자료에 실제 파일로 두지 않는다(맨 아래 시험이 본다).
// 창(P01) · 대시보드의 판정 모듈은 **순수 함수만** 부른다 — 진짜 영혼의 열쇠를 읽는 함수(lockInfo 등)는 부르지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGY_LOCK_DEFAULT, AGY_KEY_FILE, AGY_LOCK_ID, keyOpens, agyLock, agyLocked } from '../installer/lib/agylock.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_GATE = process.env.IRIS_RELEASE_GATE === '1';
const BOM = String.fromCharCode(0xFEFF);
const OPEN = JSON.stringify({ antigravity: 'open' });

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `iris-agylock-${name}-`));
}
/** 임시 영혼 루트에 열쇠 파일을 쓴다(글 또는 바이트). */
function putKey(root, content) {
  const file = path.join(root, ...AGY_KEY_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// 입력표 — [이름, 열쇠 파일의 글(문자열이 아니면 "읽지 못함"), 여는가]
// 창 · 대시보드와 같은 답이 나와야 하는 표다. 줄을 더할 때는 여는 줄을 늘리지 않는지 먼저 본다(여는 글은 "객체 + 정확히 open" 뿐).
const TABLE = [
  ['읽지 못함(null)', null, false],
  ['읽지 못함(undefined)', undefined, false],
  ['문자열이 아님(객체)', { antigravity: 'open' }, false],
  ['문자열이 아님(true)', true, false],
  ['빈 글', '', false],
  ['공백만', '  \r\n', false],
  ['깨진 JSON(잘림)', '{ "antigravity": "open"', false],
  ['깨진 JSON(끝 쉼표)', '{ "antigravity": "open", }', false],
  ['깨진 JSON(뒤에 군글)', `${OPEN} x`, false],
  ['홑따옴표', "{ 'antigravity': 'open' }", false],
  ['JSON null', 'null', false],
  ['JSON true', 'true', false],
  ['JSON 숫자', '1', false],
  ['JSON 글자 open', '"open"', false],
  ['빈 배열', '[]', false],
  ['배열(낱말 둘)', '["antigravity","open"]', false],
  ['배열 안의 객체', `[${OPEN}]`, false],
  ['빈 객체', '{}', false],
  ['다른 칸만', '{"about":"x"}', false],
  ['칸 이름의 대소문자', '{"Antigravity":"open"}', false],
  ['값의 대소문자', '{"antigravity":"OPEN"}', false],
  ['값 앞 공백', '{"antigravity":" open"}', false],
  ['값 뒤 공백', '{"antigravity":"open "}', false],
  ['값 = locked', '{"antigravity":"locked"}', false],
  ['값 = true', '{"antigravity":true}', false],
  ['값 = 1', '{"antigravity":1}', false],
  ['값 = null', '{"antigravity":null}', false],
  ['값 = 객체', '{"antigravity":{"state":"open"}}', false],
  ['값 = 배열', '{"antigravity":["open"]}', false],
  ['안쪽 객체에만', '{"keys":{"antigravity":"open"}}', false],
  ['__proto__ 안에만', '{"__proto__":{"antigravity":"open"}}', false],
  ['같은 칸 둘(뒤가 locked)', '{"antigravity":"open","antigravity":"locked"}', false],
  ['머리표 둘', `${BOM}${BOM}${OPEN}`, false],
  ['머리표가 가운데', `{${BOM}"antigravity":"open"}`, false],
  ['정확히 open', OPEN, true],
  ['open + 줄바꿈 · 들여쓰기(CRLF)', '{\r\n  "antigravity": "open"\r\n}\r\n', true],
  ['open + 머리표 하나', `${BOM}${OPEN}`, true],
  ['open + 모르는 칸(about)', '{"about":"시험 PC","antigravity":"open"}', true],
  ['open + 모르는 칸(뒤)', '{"antigravity":"open","updateChannel":"latest","n":[1,2]}', true],
  ['같은 칸 둘(뒤가 open)', '{"antigravity":"locked","antigravity":"open"}', true],
];
const DEFAULTS = ['locked', 'open', 'OPEN', ' open', '', null, undefined, true];
const asReader = (text) => () => { if (typeof text === 'undefined') throw new Error('ENOENT'); return text; };

test('기본값은 locked 이고 열쇠 자리는 <루트>\\_agent\\setup\\iris-keys.json 의 antigravity 칸', () => {
  assert.equal(AGY_LOCK_DEFAULT, 'locked');
  assert.deepEqual(AGY_KEY_FILE, ['_agent', 'setup', 'iris-keys.json']);
  assert.equal(AGY_LOCK_ID, 'antigravity');
});

test('keyOpens: 객체이고 그 칸이 정확히 "open" 일 때만 연다(입력표)', () => {
  for (const [name, text, opens] of TABLE) assert.equal(keyOpens(text), opens, name);
});

test('agyLock: 입력표 전체 — 여는 줄만 open, 까닭 낱말은 정해진 여섯 가운데 하나', () => {
  const WHY = new Set(['default-open', 'no-root', 'no-key', 'bad-key', 'not-open', 'key']);
  for (const [name, text, opens] of TABLE) {
    const r = agyLock('X:\\practice', { readText: asReader(text) });
    assert.equal(r.state, opens ? 'open' : 'locked', name);
    assert.ok(WHY.has(r.why), `${name}: ${r.why}`);
    assert.equal(r.why === 'key', opens, name);
  }
  assert.equal(agyLock('X:\\practice', { readText: asReader(undefined) }).why, 'no-key');
  assert.equal(agyLock('X:\\practice', { readText: asReader(null) }).why, 'no-key');
  assert.equal(agyLock('X:\\practice', { readText: asReader('[]') }).why, 'bad-key');
  assert.equal(agyLock('X:\\practice', { readText: asReader('{ broken') }).why, 'bad-key');
  assert.equal(agyLock('X:\\practice', { readText: asReader('{}') }).why, 'not-open');
  assert.equal(agyLock('X:\\practice', { readText: asReader('{"antigravity":"OPEN"}') }).why, 'not-open');
});

test('agyLock: 기본값이 정확히 open 이면 열쇠를 읽지 않고 열림 — 그 밖의 기본값은 열쇠를 본다', () => {
  let reads = 0;
  const never = () => { reads += 1; throw new Error('must not be read'); };
  assert.deepEqual(agyLock('X:\\practice', { def: 'open', readText: never }), { state: 'open', why: 'default-open' });
  assert.deepEqual(agyLock(undefined, { def: 'open', readText: never }), { state: 'open', why: 'default-open' });
  assert.equal(reads, 0);
  for (const def of DEFAULTS.filter((d) => d !== 'open' && d !== undefined)) {
    assert.equal(agyLock('X:\\practice', { def, readText: asReader('{}') }).state, 'locked', `def=${String(def)}`);
    assert.equal(agyLock('X:\\practice', { def, readText: asReader(OPEN) }).state, 'open', `def=${String(def)} + 열쇠`);
  }
});

test('agyLock: 루트가 없으면 잠김 — 읽지도 않는다', () => {
  let reads = 0;
  const count = () => { reads += 1; return OPEN; };
  for (const root of [undefined, null, '', 0, 42, {}, []]) {
    assert.deepEqual(agyLock(root, { readText: count }), { state: 'locked', why: 'no-root' }, String(root));
  }
  assert.equal(reads, 0);
});

test('agyLock: 실제 파일 — 없음 · 폴더 · 빈 파일 · 머리표 · 연습 루트의 열쇠만 본다', () => {
  const a = tmpRoot('a');
  const b = tmpRoot('b');
  try {
    assert.deepEqual(agyLock(a), { state: 'locked', why: 'no-key' }, '파일 없음');
    assert.equal(agyLocked(a), true);
    fs.mkdirSync(path.join(a, ...AGY_KEY_FILE), { recursive: true });
    assert.deepEqual(agyLock(a), { state: 'locked', why: 'no-key' }, '그 자리가 폴더');
    fs.rmSync(path.join(a, ...AGY_KEY_FILE), { recursive: true, force: true });

    putKey(a, '');
    assert.deepEqual(agyLock(a), { state: 'locked', why: 'bad-key' }, '빈 파일');
    putKey(a, '{"about":"x"}');
    assert.deepEqual(agyLock(a), { state: 'locked', why: 'not-open' });

    putKey(a, OPEN);
    assert.deepEqual(agyLock(a), { state: 'open', why: 'key' });
    assert.equal(agyLocked(a), false);
    assert.deepEqual(agyLock(b), { state: 'locked', why: 'no-key' }, '다른 루트의 열쇠는 보지 않는다');

    // 메모장 · 옛 PowerShell 이 붙이는 UTF-8 머리표(EF BB BF) 하나는 벗긴다. 둘이면 깨진 글이다.
    putKey(a, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(OPEN, 'utf8')]));
    assert.deepEqual(agyLock(a), { state: 'open', why: 'key' }, '머리표 하나');
    putKey(a, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF]), Buffer.from(OPEN, 'utf8')]));
    assert.deepEqual(agyLock(a), { state: 'locked', why: 'bad-key' }, '머리표 둘');
    // UTF-16 으로 저장한 파일은 읽히지 않는 글이다(잠김).
    putKey(a, Buffer.from(`${BOM}${OPEN}`, 'utf16le'));
    assert.equal(agyLock(a).state, 'locked', 'UTF-16');

    // 읽을 때마다 다시 본다(이 모듈은 값을 기억하지 않는다 — 언제 한 번 읽을지는 부르는 쪽이 정한다).
    putKey(a, OPEN);
    assert.equal(agyLock(a).state, 'open');
    fs.rmSync(path.join(a, ...AGY_KEY_FILE));
    assert.equal(agyLock(a).state, 'locked');
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('agyLock: 환경 변수로 여는 길은 없다 — 모듈이 환경 변수를 읽지 않는다', () => {
  const root = tmpRoot('env');
  const elsewhere = tmpRoot('env-open');
  putKey(elsewhere, OPEN);
  fs.writeFileSync(path.join(elsewhere, 'iris-keys.json'), OPEN);
  const names = [
    'IRIS_AGY_LOCK', 'IRIS_AGY', 'AGY_LOCK', 'AGY_LOCK_DEFAULT', 'IRIS_ANTIGRAVITY', 'ANTIGRAVITY', 'IRIS_KEYS', 'IRIS_KEY_ANTIGRAVITY',
    'IRIS_INSTALLER_AGY', 'IRIS_INSTALLER_ANTIGRAVITY', 'IRIS_INSTALLER_AGY_LOCK',
  ];
  const paths = ['IRIS_FACE_STATE', 'IRIS_ROOT', 'IRIS_KEYS_FILE'];
  const saved = {};
  for (const n of [...names, ...paths]) saved[n] = process.env[n];
  try {
    for (const n of names) process.env[n] = 'open';
    for (const n of paths) process.env[n] = elsewhere;
    assert.deepEqual(agyLock(root), { state: 'locked', why: 'no-key' });
    assert.equal(agyLocked(root), true);
  } finally {
    for (const [n, v] of Object.entries(saved)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
  const src = fs.readFileSync(path.join(ROOT_DIR, 'installer', 'lib', 'agylock.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')).join('\n');
  assert.ok(!/process\s*\.\s*env|\benv\b/.test(code), 'agylock.mjs 의 코드에 환경 변수를 읽는 자리가 없다');
  assert.ok(!/writeFile|appendFile|mkdir|rmSync|unlink|rename/.test(code), 'agylock.mjs 는 아무것도 쓰지 않는다');
});

// --- 창(P01)의 판정 모듈과 같은 답 -------------------------------------------------------------
function faceSourceDir() {
  let lockSource = null;
  try { lockSource = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8')).parts?.face?.source ?? null; } catch { /* 없으면 후보에서 뺀다 */ }
  const candidates = [process.env.IRIS_FACE_SOURCE, lockSource ? path.resolve(ROOT_DIR, lockSource) : null].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'daemon', 'agents', 'antigravity.lock.mjs'))) return { dir, candidates };
  }
  return { dir: null, candidates };
}

test('창(IRIS-Face)의 판정 모듈과 같은 입력표 → 같은 답 (창 소스가 있을 때 — 릴리스 관문에서는 건너뜀이 실패)', async (t) => {
  const { dir, candidates } = faceSourceDir();
  if (!dir) {
    const reason = `창 소스의 daemon/agents/antigravity.lock.mjs 를 찾지 못함(본 자리 ${candidates.length}곳 — IRIS_FACE_SOURCE 또는 잠금표의 face.source)`;
    if (RELEASE_GATE) assert.fail(`IRIS_RELEASE_GATE=1: 이 대조는 릴리스에서 건너뛸 수 없다 — ${reason}`);
    t.skip(reason);
    return;
  }
  const face = await import(pathToFileURL(path.join(dir, 'daemon', 'agents', 'antigravity.lock.mjs')).href);
  const adapter = await import(pathToFileURL(path.join(dir, 'daemon', 'agents', 'antigravity.mjs')).href);
  assert.equal(adapter.lockDefault, AGY_LOCK_DEFAULT, '기본값이 창과 같다');
  assert.equal(face.KEY_FILE_NAME, AGY_KEY_FILE.at(-1), '열쇠 파일 이름이 창과 같다');
  assert.equal(face.LOCK_ID, AGY_LOCK_ID, '칸 이름이 창과 같다');
  let compared = 0;
  for (const [name, text, opens] of TABLE) {
    assert.equal(face.keyOpens(text), opens, `창 keyOpens: ${name}`);
    assert.equal(keyOpens(text), face.keyOpens(text), `keyOpens 가 창과 다르다: ${name}`);
    for (const def of DEFAULTS) {
      // 창은 열쇠를 읽지 못하면 null 을 넘긴다(lockInfo). 설치기는 읽기 실패 = 잠김 — 같은 답이어야 한다.
      const theirs = face.judgeLock(def === undefined ? adapter.lockDefault : def, typeof text === 'string' ? text : null).state;
      const ours = agyLock('X:\\practice', { ...(def === undefined ? {} : { def }), readText: asReader(text) }).state;
      assert.equal(ours, theirs, `판정이 창과 다르다: ${name} / 기본값 ${String(def)}`);
      compared += 1;
    }
  }
  assert.equal(compared, TABLE.length * DEFAULTS.length);
});

// --- 대시보드의 판정 함수와 같은 답(있을 때만) ----------------------------------------------------
// 대시보드 원본이 아직 잠금을 모르는 판일 수 있어(잠금이 든 사본은 빌드 때 IRIS_DASH_SOURCE 로 가리킨다) 없으면 건너뛴다.
test('대시보드의 agyLock 과 같은 입력표 → 같은 답 · 같은 까닭 (대시보드 소스에 그 함수가 있을 때)', async (t) => {
  let lockSource = null;
  try { lockSource = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8')).parts?.dash?.source ?? null; } catch { /* 없으면 후보에서 뺀다 */ }
  const candidates = [process.env.IRIS_DASH_SOURCE, lockSource ? path.resolve(ROOT_DIR, lockSource) : null].filter(Boolean);
  let dash = null;
  for (const dir of candidates) {
    const file = path.join(dir, 'lib.mjs');
    if (!fs.existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.agyLock === 'function') { dash = mod; break; }
  }
  if (!dash) { t.skip(`잠금 판정(agyLock)이 든 대시보드 소스를 찾지 못함(본 자리 ${candidates.length}곳)`); return; }
  assert.equal(dash.AGY_LOCK_DEFAULT, AGY_LOCK_DEFAULT, '기본값이 대시보드와 같다');
  assert.deepEqual(dash.AGY_KEY_FILE, AGY_KEY_FILE, '열쇠 자리가 대시보드와 같다');
  for (const [name, text] of TABLE) {
    for (const def of DEFAULTS) {
      const opt = def === undefined ? {} : { def };
      const theirs = dash.agyLock({ root: 'X:\\practice', readText: asReader(text), ...opt });
      const ours = agyLock('X:\\practice', { readText: asReader(text), ...opt });
      assert.deepEqual(ours, theirs, `대시보드와 다르다: ${name} / 기본값 ${String(def)}`);
    }
  }
  for (const root of [null, '', 0]) {
    assert.deepEqual(agyLock(root, { readText: asReader(OPEN) }), dash.agyLock({ root, readText: asReader(OPEN) }), `루트 ${String(root)}`);
  }
});

// --- 열쇠 파일은 저장소에 없다 -------------------------------------------------------------------
test('저장소의 추적 파일에 iris-keys.json 이 없다(열쇠는 시험이 임시 폴더에만 쓴다)', (t) => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT_DIR, encoding: 'buffer' }).toString('utf8').split('\0').filter(Boolean);
  } catch {
    t.skip('git 저장소가 아니거나 git 을 쓸 수 없음');
    return;
  }
  assert.ok(tracked.length > 0);
  const hits = tracked.filter((f) => /(^|\/)iris-keys\.json$/i.test(f));
  assert.deepEqual(hits, [], '추적 파일에 열쇠 파일이 있다');
});
