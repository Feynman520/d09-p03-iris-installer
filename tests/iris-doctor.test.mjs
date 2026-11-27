// 2.0.66 — IRIS Doctor 를 부품으로 싣는다(설계 W5 1부: 사본 · 잠금표 · 풀기 · 부품 검증).
//
// Doctor 는 "IRIS 가 먹통일 때 부르는" 프로그램이라 스스로 자기 파일을 지문 목록(manifest.json)과 견준다 —
// 한 바이트라도 다르면 그 실행에서는 치료를 시작하지 않는다. 그래서 이 부품은 **바이트가 곧 정체성**이다:
//   원본 묶음 → 이 저장소의 사본(payload-src\tools\iris-doctor) → 빌드(복사 · 압축) → 설치(풀기)
// 의 어느 걸음에서도 바이트가 달라지면 안 된다. 이 파일은 그 사슬을 걸음마다 못 박는다.
//
// 이 시험은 Doctor 를 **실행하지 않는다**(파일과 글자만 본다). Doctor 의 동작 시험은 원본 저장소에 있다
// — 시험 · 도구 · 지침은 이 저장소에 들이지 않는다(정화 규칙에 걸리는 예시 경로가 많고, 시험장 도구는 실제 에이전트를 부른다).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/run.mjs';
import { extractZip } from '../lib/zip.mjs';
import * as unpack from '../installer/setup/unpack.mjs';
import { collect } from '../build/collect.mjs';
import { sanitize } from '../build/sanitize.mjs';
import { loadRules } from '../build/rules.mjs';
import { isStageError } from '../installer/lib/errors.mjs';
import { planUpdateReset, RELAY_PARTS, KEEP_DONE } from '../installer/lib/update-plan.mjs';
import { doctorStartFile, DOCTOR_START_FILE } from '../installer/lib/handoff.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
const COPY_REL = 'payload-src/tools/iris-doctor';
const COPY = path.join(REPO, ...COPY_REL.split('/'));
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-doctor-part-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const RELEASE_GATE = process.env.IRIS_RELEASE_GATE === '1';
function skipOrFail(t, reason) {
  if (RELEASE_GATE) assert.fail(`IRIS_RELEASE_GATE=1: this check may not be skipped at release -- ${reason}`);
  t.skip(reason);
}

/** 폴더 안 모든 파일의 상대 경로('/' 구분). */
function listAll(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else out.push(r);
    }
  };
  walk('');
  return out.sort();
}
const readManifest = (dir = COPY) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
/** 폴더 지문: 경로 + 크기 + 고친 시각 + 내용 지문(읽기만 했는지 보려고 시각까지 본다). */
function snapshot(dir) {
  const out = {};
  for (const rel of listAll(dir)) { const f = path.join(dir, ...rel.split('/')); const st = fs.statSync(f); out[rel] = `${st.size}:${st.mtimeMs}:${sha(fs.readFileSync(f))}`; }
  return out;
}

// ---------------------------------------------------------------------------
// T1 — 자리 약속
// ---------------------------------------------------------------------------

test('T1 잠금표: Doctor 는 저장소 안 묶음 사본을 그대로(고르기 · 빼기 · 글 바꾸기 없이) Doctor 와 IRIS 창이 찾는 자리에 놓는다', () => {
  const p = LOCK.parts['iris-doctor'];
  assert.ok(p, 'lock.json parts.iris-doctor 없음');
  assert.equal(p.kind, 'dir');
  assert.equal(p.source, COPY_REL);
  assert.equal(p.file, 'tools/iris-doctor.zip');
  assert.equal(p.dest, '_agent/shared/tools/iris-doctor', 'IRIS 창(daemon\\paths.mjs)과 Doctor(lib\\context.mjs)가 찾는 자리');
  assert.equal(p.license, 'MIT');
  assert.equal(p.asciiRequired, true, '부품 안 .ps1 의 ASCII 를 빌드가 본다');
  // 빌드가 바이트를 바꿀 수 있는 칸은 하나도 쓰지 않는다(지문 목록이 사본의 바이트를 들고 있다)
  for (const k of ['include', 'exclude', 'redact', 'npmCi']) assert.equal(p[k], undefined, `${k} 를 쓰면 사본과 실리는 것이 달라진다`);
  assert.equal(p.redistribute, undefined, '동봉 부품이다(설치 중 내려받기가 아니다)');
});

test('T1 풀기 순서 · 배치표: node 뒤 · 창과 중계기 뒤에, 그 폴더 전체가 이 부품(slot) · 지문이 맞을 때만 "이미 놓였다"', () => {
  const at = (id) => unpack.UNPACK_ORDER.indexOf(id);
  assert.ok(at('iris-doctor') >= 0, '순서표에 없음(조용히 맨 뒤로 밀리지 않게 적어 둔다)');
  for (const before of ['node', 'teamclaude', 'manage', 'dash', 'face', 'updater', 'iris-auth']) assert.ok(at(before) < at('iris-doctor'), `${before} 가 먼저`);
  assert.equal(at('iris-doctor'), at('iris-auth') + 1, '로그인 열쇠 도구 바로 다음');
  const layout = unpack.V2_LAYOUT['iris-doctor'];
  assert.deepEqual({ kind: layout.kind, strip: layout.strip, mode: layout.mode, intact: layout.intact }, { kind: 'archive', strip: 0, mode: 'slot', intact: 'manifest' });
  // `intact` 는 이 부품 하나에만 건다(다른 부품의 건너뛰기 판정은 2.0.65 그대로)
  assert.deepEqual(Object.entries(unpack.V2_LAYOUT).filter(([, l]) => l.intact).map(([id]) => id), ['iris-doctor']);
});

test('T1 자리 약속: 시작 파일은 옆 폴더의 동봉 node 를 쓰고(..\\node\\node.exe), Doctor 는 자기 자리에서 위로 올라가 설치 폴더를 찾는다', () => {
  assert.equal(LOCK.parts.node.dest, '_agent/shared/tools/node', 'node 부품이 Doctor 의 옆 폴더에 놓여야 한다');
  assert.equal(path.posix.dirname(LOCK.parts['iris-doctor'].dest), path.posix.dirname(LOCK.parts.node.dest));
  const cmd = fs.readFileSync(path.join(COPY, 'IRIS Doctor.cmd'), 'latin1');
  assert.match(cmd, /set "IRIS_DOCTOR_NODE=%IRIS_DOCTOR_DIR%\.\.\\node\\node\.exe"/);
  const ctx = fs.readFileSync(path.join(COPY, 'lib', 'context.mjs'), 'utf8');
  assert.match(ctx, /path\.join\(root, '_agent', 'shared', 'tools'\)/, '도구 폴더 자리');
  assert.match(ctx, /path\.join\(root, '_agent', 'setup', 'package-receipt\.json'\)/, '설치본 여부는 영수증으로');
  assert.match(ctx, /path\.join\(toolsDir, 'face'\)/, '창 부품 자리');
  assert.equal(LOCK.parts.face.dest, '_agent/shared/tools/face');
  // Doctor 의 집(열쇠 · 진료 기록)은 부품 폴더 밖이다 — 부품을 바꿔 놓아도(.prev) 딸려 가지 않는다
  assert.match(fs.readFileSync(path.join(COPY, 'lib', 'home.mjs'), 'utf8'), /path\.join\(root, '_agent', 'doctor'\)/);
});

test('T1 자리 약속(개발 PC 에서만): IRIS 창이 Doctor 를 찾는 자리가 잠금표의 자리와 같다', (t) => {
  const siblings = (() => { try { return fs.readdirSync(path.dirname(REPO)); } catch { return []; } })();
  const faceDir = siblings.find((n) => /^P01-/.test(n) && fs.existsSync(path.join(path.dirname(REPO), n, 'daemon', 'paths.mjs')));
  if (!faceDir) return t.skip('IRIS 창 저장소가 옆에 없다(다른 PC · 작업 사본)');
  const text = fs.readFileSync(path.join(path.dirname(REPO), faceDir, 'daemon', 'paths.mjs'), 'utf8');
  // 창은 「공유 도구 폴더 + iris-doctor」 를 본다 — 그 둘을 이으면 잠금표의 자리가 된다
  const tools = /toolsDir\s*=\s*\(\)\s*=>\s*path\.join\(soulRoot\(\),\s*((?:'[^']+',?\s*)+)\)/.exec(text);
  assert.ok(tools, '창 daemon\\paths.mjs 의 도구 폴더 정의를 찾지 못했다');
  const toolsRel = [...tools[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).join('/');
  assert.match(text, /path\.join\(toolsDir\(\),\s*'iris-doctor'\)/, '창이 공유 도구 폴더에서 Doctor 를 찾는 줄을 찾지 못했다');
  assert.equal(`${toolsRel}/iris-doctor`, LOCK.parts['iris-doctor'].dest, '창이 찾는 자리 = 잠금표의 자리');
  assert.match(text, /'IRIS Doctor\.cmd'/); assert.match(text, /'iris-doctor\.mjs'/);
  for (const f of ['IRIS Doctor.cmd', 'iris-doctor.mjs']) assert.ok(fs.existsSync(path.join(COPY, f)), `창이 보는 표지 파일 ${f}`);
});

// ---------------------------------------------------------------------------
// T2 — 사본의 지문(사슬 ⓑ) · 싣지 않을 것
// ---------------------------------------------------------------------------

test('T2 사본: 지문 목록(manifest.json)이 사본의 파일과 전부 맞는다 — 바뀜 0 · 빠짐 0 · 목록에 없는 파일 0', () => {
  const m = readManifest();
  assert.equal(m.name, 'iris-doctor');
  assert.match(String(m.version), /^\d+\.\d+\.\d+$/);
  const listed = m.files.map((f) => f.path).sort();
  assert.equal(new Set(listed).size, listed.length, '같은 파일이 두 번 적힘');
  assert.deepEqual(listAll(COPY).filter((f) => f !== 'manifest.json'), listed, '사본의 파일 = 목록의 파일');
  for (const f of m.files) {
    const buf = fs.readFileSync(path.join(COPY, ...f.path.split('/')));
    assert.equal(sha(buf), f.sha256, `${f.path}: 지문이 다르다(줄끝이 바뀌었거나 손으로 고쳤다 — 사본은 원본에서 다시 묶어 통째로 바꾼다)`);
    assert.equal(buf.length, f.size, `${f.path}: 크기`);
  }
  // 설치기의 판정기도 같은 답을 낸다
  const r = unpack.doctorBundleCheck(fs, COPY);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.version, m.version);
});

test('T2 사본: 판 번호가 프로그램 글과 같다 · 꼭 있어야 할 파일이 있다 · 시험 · 도구 · 이 PC 만의 표 · 지침 · 빈 파일은 없다', () => {
  const m = readManifest();
  const version = /VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(COPY, 'lib', 'diagnose.mjs'), 'utf8'))?.[1];
  assert.equal(m.version, version, '지문 목록의 판 = lib\\diagnose.mjs 의 판');
  const files = listAll(COPY);
  for (const need of [...unpack.DOCTOR_REQUIRED, 'manifest.json', 'lib/worker.mjs', 'lib/plain.mjs', 'lib/trust.mjs', 'lib/integrity.mjs', 'lib/treat/flow.mjs', 'lib/treat/guard-hook.mjs', 'lib/treat/job-keeper.ps1', 'guide/stopped.ko.txt']) assert.ok(files.includes(need), `${need} 없음`);
  assert.deepEqual(fs.readdirSync(COPY).sort(), ['IRIS Doctor.cmd', 'guide', 'iris-doctor.mjs', 'lib', 'manifest.json'], '맨 위에는 이 다섯뿐');
  const stray = files.filter((f) => /^(tests|tools)\//.test(f) || /(^|\/)(local\.json|AGENTS\.md|CLAUDE\.md|\.gitignore|\.gitattributes)$/.test(f) || /\.(tmp|bak|orig|log|restore|doctor-aside|prev)$/i.test(f));
  assert.deepEqual(stray, [], '싣지 않을 것이 사본에 들어 있다');
  for (const f of files) assert.ok(fs.statSync(path.join(COPY, ...f.split('/'))).size > 0, `${f}: 0바이트(정적 검사 ⑲)`);
});

test('T2 사본: 시작 파일과 PowerShell 도우미는 ASCII · CRLF, 한국어 안내는 BOM 없는 UTF-8 · LF, 프로그램 글은 LF', () => {
  for (const rel of listAll(COPY)) {
    const buf = fs.readFileSync(path.join(COPY, ...rel.split('/')));
    const lf = buf.filter((b) => b === 0x0a).length;
    const crlf = buf.toString('latin1').split('\r\n').length - 1;
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${rel}: BOM`);
    if (/\.(cmd|ps1)$/i.test(rel)) {
      assert.equal(buf.findIndex((b) => b > 0x7f), -1, `${rel}: ASCII 가 아닌 바이트`);
      assert.ok(lf > 0 && crlf === lf, `${rel}: 모든 줄끝이 CRLF 여야 한다(LF ${lf} · CRLF ${crlf})`);
    } else {
      assert.equal(buf.filter((b) => b === 0x0d).length, 0, `${rel}: CR 이 섞였다`);
    }
  }
});

test('T2 사본: 윈도우 인증서를 믿는 처리가 실려 있다 — 시작 파일은 비어 있을 때만 변수를 채우고, 실행 입구와 검진 일꾼이 윈도우 목록을 더한다(플래그 · NODE_OPTIONS 로 하지 않는다)', () => {
  const cmd = fs.readFileSync(path.join(COPY, 'IRIS Doctor.cmd'), 'latin1');
  assert.match(cmd, /^if not defined NODE_USE_SYSTEM_CA set "NODE_USE_SYSTEM_CA=1"\r$/m);
  assert.match(cmd, /^set "NODE_OPTIONS="\r$/m);
  const trust = fs.readFileSync(path.join(COPY, 'lib', 'trust.mjs'), 'utf8');
  assert.match(trust, /tls\.setDefaultCACertificates\(\[\.\.\.current, \.\.\.extra\]\)/, '내장 목록은 그대로 두고 더한다');
  assert.match(trust, /getCACertificates\('system'\)/);
  for (const rel of ['iris-doctor.mjs', 'lib/worker.mjs']) assert.match(fs.readFileSync(path.join(COPY, ...rel.split('/')), 'utf8'), /trust\.mjs'\)\)\.trustSystemRoots\(\)/, rel);
  for (const rel of listAll(COPY).filter((f) => /\.(mjs|cmd|ps1)$/i.test(f))) {
    const code = fs.readFileSync(path.join(COPY, ...rel.split('/')), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|rem\b|#)/i.test(l)).join('\n');
    assert.ok(!code.includes('--use-system-ca'), `${rel}: --use-system-ca 플래그를 쓴다`);
  }
});

// ---------------------------------------------------------------------------
// 사슬 ⓐ — 저장소가 바이트를 바꾸지 않는다(줄끝 변환 끔)
// ---------------------------------------------------------------------------

const git = (args, opts = {}) => spawnSync('git', args, { cwd: REPO, encoding: opts.encoding ?? 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

test('사슬 ⓐ .gitattributes: 사본 폴더의 모든 파일에 줄끝 변환이 꺼져 있다(-text) — .cmd · .ps1 의 CRLF 규칙보다 뒤에 적혀 이긴다', (t) => {
  const attrs = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const mine = attrs.indexOf(`${COPY_REL}/** -text`);
  assert.ok(mine >= 0, `.gitattributes 에 "${COPY_REL}/** -text" 줄이 없다`);
  for (const earlier of ['*.cmd text eol=crlf', '*.ps1 text eol=crlf', '* text=auto eol=lf']) assert.ok(attrs.indexOf(earlier) >= 0 && attrs.indexOf(earlier) < mine, `"${earlier}" 보다 뒤에 있어야 이긴다`);
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return skipOrFail(t, 'git 저장소가 아니다');
  const files = listAll(COPY).map((f) => `${COPY_REL}/${f}`);
  const r = git(['check-attr', 'text', 'eol', '--', ...files]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const textOf = new Map(lines.filter((l) => /: text: /.test(l)).map((l) => { const m = /^(.*): text: (.*)$/.exec(l); return [m[1].replace(/^"|"$/g, ''), m[2]]; }));
  assert.equal(textOf.size, files.length, r.stdout.slice(0, 400));
  for (const f of files) assert.equal(textOf.get(f), 'unset', `${f}: text 속성이 꺼져 있지 않다(${textOf.get(f)})`);
});

test('사슬 ⓐ 새로 꺼낸 사본: 전역 core.autocrlf=true 인 PC 에서 꺼내도 바이트가 지문 목록과 같다(저장소에 든 것 = 사본 = 목록)', (t) => {
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return skipOrFail(t, 'git 저장소가 아니다');
  const tracked = git(['ls-files', '-z', '--', COPY_REL]).stdout.split('\0').filter(Boolean).sort();
  const want = listAll(COPY).map((f) => `${COPY_REL}/${f}`);
  assert.deepEqual(tracked, want, '사본의 파일이 전부(그리고 그것만) 저장소에 들어 있어야 한다');
  const m = new Map(readManifest().files.map((f) => [f.path, f.sha256]));
  for (const rel of tracked) {
    // 꺼낼 때의 변환(줄끝 · 필터)을 그대로 거친 바이트 — autocrlf 를 켠 PC 를 흉내 낸다
    const out = spawnSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', 'cat-file', '--filters', `:${rel}`], { cwd: REPO, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(out.status, 0, `${rel}: ${String(out.stderr)}`);
    const inner = rel.slice(COPY_REL.length + 1);
    const disk = fs.readFileSync(path.join(REPO, ...rel.split('/')));
    assert.ok(out.stdout.equals(disk), `${rel}: 저장소에서 꺼낸 바이트가 사본과 다르다`);
    if (inner !== 'manifest.json') assert.equal(sha(out.stdout), m.get(inner), `${rel}: 꺼낸 바이트의 지문이 목록과 다르다`);
  }
});

// ---------------------------------------------------------------------------
// 사슬 ⓒ — 빌드의 정화와 수집이 바이트를 바꾸지 않는다
// ---------------------------------------------------------------------------

test('사슬 ⓒ 정화: 사본에서 걸리는 것이 0건이고(걸리면 빌드가 멈춘다), 정화는 읽기만 한다 — 어떤 파일도 바꾸지 않는다', async () => {
  const before = snapshot(COPY);
  const rules = loadRules({ warn: () => {} });
  const r = await sanitize(REPO, rules, { files: listAll(COPY).map((f) => path.join(...COPY_REL.split('/'), ...f.split('/'))) });
  assert.deepEqual(r.hits.map((h) => `${h.file}:${h.line ?? ''} [${String(h.rule).split(':')[0]}]`), [], '사본에 정화 규칙에 걸리는 글이 있다 — 원본을 고치고 다시 묶는다(이 저장소 이력에 들어가면 정적 검사 ⑧이 계속 실패한다)');
  assert.deepEqual(snapshot(COPY), before, '정화가 파일을 건드렸다');
  // 정화 코드는 찾은 것을 돌려줄 뿐 고쳐 쓰지 않는다(글을 바꾸는 유일한 길은 잠금표의 redact 칸 — 이 부품은 쓰지 않는다, T1)
  const src = fs.readFileSync(path.join(REPO, 'build', 'sanitize.mjs'), 'utf8');
  assert.doesNotMatch(src, /writeFile|appendFile|copyFile|renameSync|createWriteStream/, 'build\\sanitize.mjs 가 파일을 쓰기 시작했다 — Doctor 사본의 지문 사슬을 다시 따져야 한다');
});

test('사슬 ⓒ 수집: 진짜 잠금표 줄로 묶은 압축을 풀면 사본과 바이트가 같고, 지문 목록 대조가 그대로 맞는다(빌드가 목록을 다시 만들지 않는다)', async () => {
  const stage = path.join(tmp, 'collect');
  const r = await collect({ lock: { package: { version: '0' }, parts: { 'iris-doctor': LOCK.parts['iris-doctor'] } }, cacheDir: path.join(stage, 'cache'), stageDir: path.join(stage, 'stage'), log: () => {} });
  const zip = path.join(r.payloadDir, 'tools', 'iris-doctor.zip');
  assert.ok(fs.existsSync(zip), '압축이 만들어지지 않았다');
  const out = path.join(stage, 'out');
  await extractZip(zip, out);
  assert.deepEqual(listAll(out), listAll(COPY), '압축 안 파일 = 사본의 파일(겉껍질 폴더 없이)');
  for (const f of listAll(COPY)) assert.ok(fs.readFileSync(path.join(out, ...f.split('/'))).equals(fs.readFileSync(path.join(COPY, ...f.split('/')))), `${f}: 압축을 거치며 바이트가 달라졌다`);
  assert.equal(unpack.doctorBundleCheck(fs, out).ok, true);
});

// ---------------------------------------------------------------------------
// T3 — 원본과 바이트 대조(개발 PC 에 원본이 있을 때만 · 내는 문 앞에서는 건너뜀 = 실패)
// ---------------------------------------------------------------------------

function findOriginal() {
  const env = process.env;
  const cands = [
    env.IRIS_DOCTOR_SOURCE,
    env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'tools', 'iris-doctor') : null,
    env.IRIS_ROOT ? path.join(env.IRIS_ROOT, '_agent', 'claude', 'tools', 'iris-doctor') : null,
  ].filter(Boolean);
  return cands.find((d) => fs.existsSync(path.join(d, 'tools', 'pack.mjs')) && fs.existsSync(path.join(d, 'lib', 'integrity.mjs'))) ?? null;
}

test('T3 원본과 대조: 개발 PC 의 Doctor 원본을 지금 묶으면 이 사본과 파일 목록 · 바이트 · 지문 목록까지 같다(사본이 원본보다 뒤처지지 않았다)', (t) => {
  const original = findOriginal();
  if (!original) return skipOrFail(t, 'Doctor 원본 저장소를 찾지 못했다(IRIS_DOCTOR_SOURCE · CLAUDE_CONFIG_DIR · IRIS_ROOT 로 찾는다 — 다른 PC 에서는 건너뛴다)');
  const out = path.join(tmp, 'packed');
  fs.mkdirSync(out, { recursive: true });
  // 원본의 묶는 도구를 그대로 부른다(원본은 읽기만 하고, 빈 임시 폴더에만 쓴다). Doctor 자체는 실행하지 않는다.
  const r = spawnSync(process.execPath, [path.join(original, 'tools', 'pack.mjs'), out], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(r.status, 0, `원본을 묶지 못했다: ${r.stdout}${r.stderr}`);
  const packed = path.join(out, 'iris-doctor');
  const hint = '사본이 원본과 다르다 — 원본에서 시험 · 판 올림 · 커밋 뒤 `node tools/pack.mjs <빈 폴더>` 로 묶어 사본 폴더를 통째로 바꾼다(payload-src\\tools\\COPY-NOTES.md)';
  assert.deepEqual(listAll(COPY), listAll(packed), `파일 목록: ${hint}`);
  const diff = listAll(packed).filter((f) => !fs.readFileSync(path.join(packed, ...f.split('/'))).equals(fs.readFileSync(path.join(COPY, ...f.split('/')))));
  assert.deepEqual(diff, [], `바이트: ${hint}`);
});

// ---------------------------------------------------------------------------
// T4 — 부품 검증기 · 깨졌으면 다시 놓는다(6-1) · 멀쩡하면 읽기만 한다
// ---------------------------------------------------------------------------

async function zipCopy(label, mutate = null) {
  const base = path.join(tmp, label);
  const src = path.join(base, '_src');
  fs.cpSync(COPY, src, { recursive: true });
  if (mutate) mutate(src);
  const payload = path.join(base, 'payload');
  const zip = path.join(payload, 'tools', 'iris-doctor.zip');
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  const r = await run(TAR, ['-a', '-cf', zip, '-C', src, '--', ...fs.readdirSync(src).sort()]);
  assert.equal(r.code, 0, `tar failed: ${r.err}`);
  const lock = { schema: 2, package: { version: '2.0.66' }, parts: { 'iris-doctor': { kind: 'dir', file: 'tools/iris-doctor.zip', dest: '_agent/shared/tools/iris-doctor' } } };
  const manifest = { schema: 2, package: { version: '2.0.66' }, parts: { 'iris-doctor': { file: 'tools/iris-doctor.zip', version: null, sha256: `zip-${label}`, dest: lock.parts['iris-doctor'].dest } } };
  return { payloadDir: payload, lock, manifest };
}
// 진짜 검증기 표에서 Doctor 것만 꺼낸다. 표는 만들 때 런타임 부품(node · python · git)의 자리도 읽으므로 진짜 잠금표의 자리를 준다
// (그 부품들을 놓지는 않는다 — 이 시험의 꾸러미에는 Doctor 하나뿐이다).
function realDoctorVerifier(root, dest = '_agent/shared/tools/iris-doctor') {
  const parts = { ...LOCK.parts, 'iris-doctor': { ...LOCK.parts['iris-doctor'], dest } };
  return unpack.v2Verifiers({ root, fs, lock: { ...LOCK, parts } })['iris-doctor'];
}
function makeCtx(label, built, { holders = [] } = {}) {
  const logs = [];
  const root = path.join(tmp, label, 'soul');
  return {
    root, payloadDir: built.payloadDir, lock: built.lock, manifest: built.manifest,
    verifiers: { 'iris-doctor': realDoctorVerifier(root) },
    offline: true, fs, logs, log: (l) => logs.push(l), progress: () => {},
    run: async () => ({ code: 0, out: 'stub', err: '' }),
    env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '1' },
    processes: { list: async () => holders, files: async () => [] },
  };
}
const destOf = (ctx) => path.join(ctx.root, '_agent', 'shared', 'tools', 'iris-doctor');

test('T4 부품 검증기: 꼭 있어야 할 파일 · 지문 목록의 모든 파일 · 목록에 없는 파일 0 을 본다(하나라도 어긋나면 실패, 까닭을 말한다)', async () => {
  const root = path.join(tmp, 'verifier-root');
  fs.mkdirSync(path.join(root, 'x'), { recursive: true });
  const placed = path.join(root, 'x', 'iris-doctor');
  const verify = realDoctorVerifier(root, 'x/iris-doctor');
  assert.equal(typeof verify, 'function', '검증기 표에 iris-doctor 가 없다(기본 검증은 압축 안 파일 수만 센다)');
  assert.equal((await verify()).ok, false, '아무것도 없으면 실패');
  const fresh = () => { fs.rmSync(placed, { recursive: true, force: true }); fs.cpSync(COPY, placed, { recursive: true }); };
  fresh();
  const good = await verify();
  assert.equal(good.ok, true, good.detail); assert.match(good.detail, /지문 일치/);
  // 꼭 있어야 할 파일이 빠짐
  for (const need of unpack.DOCTOR_REQUIRED) {
    fresh(); fs.rmSync(path.join(placed, ...need.split('/')));
    const r = await verify();
    assert.equal(r.ok, false, need); assert.ok(r.detail.includes(need), `${need}: ${r.detail}`);
  }
  // 목록에는 있는데 꼭 있어야 할 파일은 아닌 것이 빠짐
  fresh(); fs.rmSync(path.join(placed, 'lib', 'report.mjs'));
  let r = await verify(); assert.equal(r.ok, false); assert.match(r.detail, /없어짐 1/); assert.ok(r.detail.includes('lib/report.mjs'));
  // 한 바이트가 다름 · 줄끝만 바뀜
  fresh(); fs.appendFileSync(path.join(placed, 'lib', 'report.mjs'), '\n');
  r = await verify(); assert.equal(r.ok, false); assert.match(r.detail, /바뀜 1/);
  fresh(); { const f = path.join(placed, 'IRIS Doctor.cmd'); fs.writeFileSync(f, fs.readFileSync(f, 'latin1').replace(/\r\n/g, '\n'), 'latin1'); }
  r = await verify(); assert.equal(r.ok, false, '줄끝만 바뀌어도 다르다'); assert.ok(r.detail.includes('IRIS Doctor.cmd'));
  // 목록에 없는 파일(맨 위 · 안쪽)
  fresh(); fs.writeFileSync(path.join(placed, 'lib', 'extra.mjs'), '// x\n');
  r = await verify(); assert.equal(r.ok, false); assert.match(r.detail, /낯선 파일 1/);
  fresh(); fs.writeFileSync(path.join(placed, 'note.txt'), 'x');
  assert.equal((await verify()).ok, false);
  // 지문 목록이 없거나 · 깨졌거나 · 비었거나 · 꼭 있어야 할 파일을 목록에서 뺐거나 · 밖을 가리키면
  fresh(); fs.rmSync(path.join(placed, 'manifest.json'));
  assert.equal((await verify()).ok, false);
  fresh(); fs.writeFileSync(path.join(placed, 'manifest.json'), '{ broken');
  assert.equal((await verify()).ok, false);
  fresh(); fs.writeFileSync(path.join(placed, 'manifest.json'), JSON.stringify({ name: 'iris-doctor', version: '9.9.9', files: [] }));
  assert.equal((await verify()).ok, false);
  fresh(); { const m = readManifest(placed); m.files = m.files.filter((f) => f.path !== 'lib/session.mjs'); fs.writeFileSync(path.join(placed, 'manifest.json'), JSON.stringify(m)); }
  assert.equal((await verify()).ok, false, '목록에서 뺀다고 통과하지 않는다');
  fresh(); { const m = readManifest(placed); m.files.push({ path: '../outside.txt', sha256: 'a'.repeat(64), size: 1 }); fs.writeFileSync(path.join(placed, 'manifest.json'), JSON.stringify(m)); }
  assert.equal((await verify()).ok, false, '폴더 밖을 가리키는 목록');
});

test('T4 풀기: 묶음이 제자리에 바이트 그대로 놓이고 검증을 통과한다 · 다시 돌리면 읽기만 한다(파일 · 시각 · 상태 기록 모두 그대로 — "두 번 실행 변경 0")', async () => {
  const built = await zipCopy('place');
  const ctx = makeCtx('place', built);
  const first = await unpack.run(ctx);
  assert.deepEqual(first.recorded.placed, ['iris-doctor']);
  assert.match(first.recorded.parts['iris-doctor'].detail, /지문 일치/);
  const dest = destOf(ctx);
  assert.deepEqual(listAll(dest), listAll(COPY));
  for (const f of listAll(COPY)) assert.ok(fs.readFileSync(path.join(dest, ...f.split('/'))).equals(fs.readFileSync(path.join(COPY, ...f.split('/')))), `${f}: 놓인 바이트가 사본과 다르다`);
  assert.ok(!fs.existsSync(`${dest}.prev`), '처음 놓을 때는 옮길 옛 사본이 없다');
  // 다시: 같은 판 · 멀쩡한 폴더 → 건너뛴다. 설치 폴더 전체가 그대로여야 한다.
  const before = snapshot(ctx.root);
  for (let i = 0; i < 2; i++) {
    const again = await unpack.run(ctx);
    assert.deepEqual(again.recorded.skipped, ['iris-doctor']); assert.deepEqual(again.recorded.placed, []);
  }
  assert.deepEqual(snapshot(ctx.root), before, '지문 대조는 읽기만 한다');
  // 멀쩡하면 Doctor 터미널이 열려 있어도(설치 폴더에서 도는 프로그램) 막지 않는다 — 바꿀 부품이 없다
  const open = makeCtx('place', built, { holders: [{ pid: 4242, name: 'node.exe' }] });
  assert.deepEqual((await unpack.run(open)).recorded.skipped, ['iris-doctor']);
});

test('T4 풀기(6-1): 같은 판이어도 Doctor 폴더의 파일이 깨졌으면 "폴더가 있으니 건너뜀"으로 넘어가지 않고 다시 놓는다 — 깨진 사본은 지우지 않고 .prev 로 남긴다', async () => {
  const built = await zipCopy('repair');
  const ctx = makeCtx('repair', built);
  await unpack.run(ctx);
  const dest = destOf(ctx);
  const cases = [
    ['파일 하나가 바뀜', () => fs.appendFileSync(path.join(dest, 'lib', 'session.mjs'), '\n// broken\n')],
    ['파일 하나가 없어짐', () => fs.rmSync(path.join(dest, 'lib', 'treat', 'flow.mjs'))],
    ['낯선 파일이 생김', () => fs.writeFileSync(path.join(dest, 'lib', 'stray.mjs.doctor-aside'), '// x')],
    ['지문 목록이 깨짐', () => fs.writeFileSync(path.join(dest, 'manifest.json'), '{ broken')],
  ];
  let n = 0;
  for (const [label, breakIt] of cases) {
    breakIt();
    assert.equal(unpack.doctorBundleCheck(fs, dest).ok, false, label);
    const r = await unpack.run(ctx);
    assert.deepEqual(r.recorded.placed, ['iris-doctor'], `${label}: 다시 놓아야 한다`);
    assert.equal(unpack.doctorBundleCheck(fs, dest).ok, true, `${label}: 다시 놓은 뒤에는 온전하다`);
    n += 1;
    const prev = n === 1 ? `${dest}.prev` : `${dest}.prev-${n}`;
    assert.ok(fs.existsSync(prev), `${label}: 깨진 사본을 ${path.basename(prev)} 로 남긴다(지우지 않는다)`);
    assert.equal(r.recorded.moved.length, 1);
  }
  // Doctor 의 집(열쇠 · 진료 기록)은 부품 폴더 밖이라 다시 놓아도 그대로다
  const home = path.join(ctx.root, '_agent', 'doctor', 'records');
  fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'journal.jsonl'), '{"kind":"open"}\n');
  fs.rmSync(path.join(dest, 'lib', 'plain.mjs'));
  await unpack.run(ctx);
  assert.equal(fs.readFileSync(path.join(home, 'journal.jsonl'), 'utf8'), '{"kind":"open"}\n');
});

test('T4 풀기(6-1): 깨진 Doctor 를 다시 놓아야 하는데 설치 폴더에서 도는 프로그램이 있으면, 아무것도 옮기기 전에 멈춘다(2.0.4 부터의 규칙 그대로)', async () => {
  const built = await zipCopy('held');
  const ctx = makeCtx('held', built);
  await unpack.run(ctx);
  const dest = destOf(ctx);
  fs.appendFileSync(path.join(dest, 'iris-doctor.mjs'), '\n// broken\n');
  const before = snapshot(ctx.root);
  const held = makeCtx('held', built, { holders: [{ pid: 4242, name: 'node.exe' }] });
  await assert.rejects(unpack.run(held), (err) => isStageError(err) && err.code === 'E-UNPACK' && /실행 중/.test(err.message));
  assert.deepEqual(snapshot(ctx.root), before, '멈출 때는 아무것도 바꾸지 않는다');
});

test('T4 풀기: 압축 안의 묶음이 지문 목록과 다르면(빌드가 바이트를 바꿨다) 놓은 뒤 확인에서 멈춘다', async () => {
  const built = await zipCopy('bad-zip', (src) => fs.appendFileSync(path.join(src, 'lib', 'link.mjs'), '\n// changed after packing\n'));
  const ctx = makeCtx('bad-zip', built);
  await assert.rejects(unpack.run(ctx), (err) => isStageError(err) && err.code === 'E-UNPACK' && /확인에 실패/.test(err.message));
  const state = JSON.parse(fs.readFileSync(unpack.statePath(ctx.root), 'utf8'));
  assert.equal(state.parts['iris-doctor'].verified, false);
  assert.match(state.parts['iris-doctor'].detail, /바뀜 1/);
});

// ---------------------------------------------------------------------------
// T5 · T6 — 바깥 입구가 가리키는 자리 · 이미 설치된 PC 가 업데이트로 바로가기를 받는다
// (바로가기의 모양 = tests/handoff.test.mjs · 실행기 단계 = tests/setup-relay.test.mjs · 설치 검사 6 = tests/setup-checks.test.mjs)
// ---------------------------------------------------------------------------

test('T5 바로가기가 여는 시작 파일 = 풀기 단계가 놓는 자리의 그 파일(사본에 실제로 있다)', () => {
  const root = path.join(tmp, 'where', 'IRIS');
  const placed = path.join(root, ...LOCK.parts['iris-doctor'].dest.split('/'));
  assert.equal(doctorStartFile(root), path.join(placed, DOCTOR_START_FILE));
  assert.ok(fs.existsSync(path.join(COPY, DOCTOR_START_FILE)), '사본에 그 이름의 시작 파일이 있다');
  assert.ok(unpack.DOCTOR_REQUIRED.includes(DOCTOR_START_FILE), '부품 검증기가 꼭 있어야 할 파일로 본다');
});

// 영수증: 2.0.65 까지의 설치(Doctor 부품 기록 없음) — 다른 부품은 이번 판과 같다.
function receiptWithout(partIds, manifest) {
  const parts = {};
  for (const [id, p] of Object.entries(LOCK.parts)) {
    if (partIds.includes(id)) continue;
    parts[id] = { identity: { version: manifest.parts[id]?.version ?? p.version ?? null, sha256: manifest.parts[id]?.sha256 ?? p.sha256 ?? null, tail: String(p.dest).split('/').filter(Boolean).pop() ?? null, commit: p.commit ?? null }, verified: true };
  }
  const done = { status: 'done' };
  return { schema: 2, setup: { unpack: { ...done, recorded: { parts } }, env: done, skeleton: done, structure: done, venv: done, adapters: done, relay: done, ontology: done, checks: done } };
}
const MANIFEST_NOW = { schema: 2, parts: Object.fromEntries(Object.entries(LOCK.parts).map(([id, p]) => [id, { file: p.file, version: p.version ?? null, sha256: p.sha256 ?? `sha-${id}`, dest: p.dest }])) };

test('T6 업데이트 계획: Doctor 가 없던 설치(2.0.65 까지)에 새 판을 얹으면 그 부품이 "바뀜"이고 실행기 단계가 되돌려진다 → 바로가기가 생긴다', () => {
  assert.ok(RELAY_PARTS.includes('iris-doctor'), 'RELAY_PARTS 에 iris-doctor 가 없으면 이미 설치된 PC 에는 바로가기가 생기지 않는다');
  const plan = planUpdateReset({ receipt: receiptWithout(['iris-doctor'], MANIFEST_NOW), lock: LOCK, manifest: MANIFEST_NOW });
  assert.deepEqual(plan.changed, ['iris-doctor']);
  assert.ok(plan.reset.includes('relay'), JSON.stringify(plan));
  assert.match(plan.reasons.relay, /iris-doctor/);
  assert.ok(plan.reset.includes('unpack'), '부품을 놓는 단계는 늘 다시 돈다');
  // 사람 쪽 단계와 파이썬 환경은 그대로(Doctor 는 파이썬을 쓰지 않는다)
  for (const keep of [...KEEP_DONE, 'venv']) assert.ok(!plan.reset.includes(keep), `${keep} 는 되돌리지 않는다`);
});

test('T6 업데이트 계획: Doctor 가 이미 같은 판으로 놓여 있으면 실행기 단계를 되돌리지 않는다 · Doctor 의 판이 바뀌면 되돌린다', () => {
  const same = planUpdateReset({ receipt: receiptWithout([], MANIFEST_NOW), lock: LOCK, manifest: MANIFEST_NOW });
  assert.deepEqual(same.changed, []);
  assert.ok(!same.reset.includes('relay'));
  const receipt = receiptWithout([], MANIFEST_NOW);
  receipt.setup.unpack.recorded.parts['iris-doctor'].identity.sha256 = 'sha-older-doctor';
  const bumped = planUpdateReset({ receipt, lock: LOCK, manifest: MANIFEST_NOW });
  assert.deepEqual(bumped.changed, ['iris-doctor']);
  assert.ok(bumped.reset.includes('relay'));
});
