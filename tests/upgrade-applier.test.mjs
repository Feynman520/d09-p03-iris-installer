// 2.0.67 — 업그레이드 게이트의 적용기 길(verify/upgrade.mjs --via-applier)의 조각과 판정.
//
// 게이트 자체(옛 판 설치 → 적용기 → 새 설치기)는 내기 전 검사에서 돈다. 여기서는 그 조각이 맞는지 본다:
//   · 게이트가 만드는 계획이 창(IRIS-Face)이 쓰는 꼴 그대로인가 — 그리고 **지금 적용기가 그 계획을 받는가**
//     (저장소의 적용기를 진짜로 띄운다. 넘겨받는 "설치기"는 표식만 남기는 한 줄짜리 가짜 시작 파일이다 — 설치 · 창 · 네트워크 없음)
//   · 판정 함수가 지금 동작을 통과시키고, 어긋난 것을 잡는가
//   · 받아 둔 사본의 시작 스크립트에서 브라우저 열기만 끄는 덧댐이 그 한 줄만 바꾸는가
// 쓰는 곳은 임시 폴더뿐이다. 띄우는 프로세스는 이 시험이 띄운 적용기와, 그 적용기가 띄운 한 줄짜리 가짜 시작 파일뿐이다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAN_SCHEMA, PLAN_FILE, PACKAGE_DIR, NO_BROWSER_ENV, windowStamp, stagingDir, buildPlan, writePlan, applierCommand,
  shimBootstrapNoBrowser, lastJsonLine, startedCmdPid,
  judgeHandoff, describeHandoffMoment, judgeApplierLog, judgeAfterInstaller, judgeKeepFilesLocked,
} from '../verify/upgrade-applier.mjs';
import { applyPlan, PLAN_SCHEMA as APPLIER_PLAN_SCHEMA, insideDownloads, updateResultPath, updateLogPath } from '../updater/apply.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_GATE = process.env.IRIS_RELEASE_GATE === '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-upg-applier-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allOk = (rows) => rows.every((r) => r.ok);
const failed = (rows) => rows.filter((r) => !r.ok).map((r) => r.name);

function closedPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const finishedPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;

/** 연습 영혼: v2 영수증 + 창이 받아 둔 것 같은 설치 패키지 폴더(가짜 시작 파일 하나). */
function makeSoul(label, { version = '2.0.99', receiptSchema = 2, receiptVersion = '2.0.66', cmdBody } = {}) {
  const root = path.join(tmp, label, 'IRIS-upgtest');
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(root, '_agent', 'setup', 'package-receipt.json'), JSON.stringify({ schema: receiptSchema, package: { version: receiptVersion } }), 'utf8');
  const dir = stagingDir(root, new Date(2026, 10, 27, 23, 5, 9).getTime());
  const packageDir = path.join(dir, PACKAGE_DIR);
  fs.mkdirSync(packageDir, { recursive: true });
  // 가짜 시작 파일: 받은 인자와 환경 변수 둘을 표식 파일에 적고 끝난다(설치하지 않는다).
  // cmdBody: null = 시작 파일을 만들지 않는다.
  const body = cmdBody === undefined ? '@echo off\r\n> "%~dp0started.txt" echo %1 auto=%IRIS_INSTALLER_AUTO% soul=%IRIS_INSTALLER_SOUL_NAME%\r\n' : cmdBody;
  if (body !== null) fs.writeFileSync(path.join(packageDir, 'IRIS-설치.cmd'), body, 'utf8');
  return { root, dir, packageDir, version };
}

// ---------------------------------------------------------------------------
// 계획 — 창이 쓰는 꼴 그대로
// ---------------------------------------------------------------------------
test('계획의 모양: 창이 쓰는 칸 · 차례 그대로 — 판은 1, 설치 패키지 한 부품, 게이트에서는 relaunch:false', async () => {
  assert.equal(PLAN_SCHEMA, 1);
  assert.equal(PLAN_SCHEMA, APPLIER_PLAN_SCHEMA, '적용기가 받는 판과 같다(다르면 옛 적용기는 아무것도 하지 않고 멈춘다)');
  const s = makeSoul('shape');
  const plan = buildPlan({ root: s.root, packageDir: s.packageDir, version: s.version, daemonPort: 3458, daemonPid: 4242, createdAt: '2026-11-27T14:05:09.000Z' });
  assert.deepEqual(Object.keys(plan), ['schema', 'root', 'daemonPort', 'daemonPid', 'createdAt', 'items', 'relaunch']);
  assert.deepEqual(plan, {
    schema: 1, root: s.root, daemonPort: 3458, daemonPid: 4242, createdAt: '2026-11-27T14:05:09.000Z',
    items: [{ kind: 'package', dir: s.packageDir, version: s.version }], relaunch: false,
  });
  assert.deepEqual(Object.keys(plan.items[0]), ['kind', 'dir', 'version']);
  assert.equal(buildPlan({ root: s.root, packageDir: s.packageDir, version: s.version, relaunch: true }).relaunch, true);
  assert.throws(() => buildPlan({ root: s.root, packageDir: s.packageDir }), /required/);

  // 자리: 적용기는 <루트>\_agent\shared\downloads 아래의 폴더만 받는다. 이름은 창의 update-YYYYMMDD-HHMMSS.
  assert.equal(windowStamp(new Date(2026, 0, 2, 3, 4, 5).getTime()), '20260102-030405');
  assert.equal(path.basename(s.dir), 'update-20261127-230509');
  assert.equal(path.relative(s.root, s.dir), path.join('_agent', 'shared', 'downloads', 'update-20261127-230509'));
  assert.equal(insideDownloads(s.root, s.packageDir), true, '지금 적용기가 이 자리를 받는다');
  assert.equal(PACKAGE_DIR, 'package');

  // 쓰기: 창과 같은 글(두 칸 들여쓰기 · 임시 파일을 남기지 않는다).
  const file = writePlan(s.dir, plan);
  assert.equal(file, path.join(s.dir, PLAN_FILE));
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(plan, null, 2));
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  // 띄우는 꼴: 동봉 node · apply.mjs --plan <계획> · 작업 폴더 = 적용기 폴더(넘기는 인자는 계획 하나뿐).
  const cmd = applierCommand(s.root, file);
  assert.equal(cmd.exe, path.join(s.root, '_agent', 'shared', 'tools', 'node', 'node.exe'));
  assert.deepEqual(cmd.args, [path.join(s.root, '_agent', 'shared', 'tools', 'updater', 'apply.mjs'), '--plan', file]);
  assert.equal(cmd.cwd, path.join(s.root, '_agent', 'shared', 'tools', 'updater'));
});

test('창(IRIS-Face) 소스의 계획 · 띄우는 꼴과 글자 대조 (창 소스가 있을 때 — 릴리스 관문에서는 건너뜀이 실패)', (t) => {
  let lockSource = null;
  try { lockSource = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8')).parts?.face?.source ?? null; } catch { /* 후보에서 뺀다 */ }
  const candidates = [process.env.IRIS_FACE_SOURCE, lockSource ? path.resolve(REPO, lockSource) : null].filter(Boolean);
  const dir = candidates.find((d) => fs.existsSync(path.join(d, 'daemon', 'update.mjs')));
  if (!dir) {
    const reason = `창 소스의 daemon/update.mjs 를 찾지 못함(본 자리 ${candidates.length}곳 — IRIS_FACE_SOURCE 또는 잠금표의 face.source)`;
    if (RELEASE_GATE) assert.fail(`IRIS_RELEASE_GATE=1: 이 대조는 릴리스에서 건너뛸 수 없다 — ${reason}`);
    t.skip(reason);
    return;
  }
  const src = fs.readFileSync(path.join(dir, 'daemon', 'update.mjs'), 'utf8');
  // 창이 쓰는 계획(칸 · 차례) · 설치 패키지 부품 줄 · 받아 두는 자리 · 시각 형식 · 적용기를 띄우는 꼴.
  assert.ok(src.includes('const plan = { schema: 1, root: this.root, daemonPort: this.daemonPort, daemonPid: process.pid, createdAt: at, items, relaunch: true };'), '창의 계획 줄이 바뀌었다 — buildPlan 을 함께 고친다');
  assert.ok(src.includes("return { item: { kind: 'package', dir: out, version: info.version }, version: info.version };"), '창의 설치 패키지 부품 줄이 바뀌었다');
  assert.ok(src.includes("const out = path.join(dir, 'package');"), '창이 설치 패키지를 푸는 폴더 이름이 바뀌었다');
  assert.ok(src.includes("const file = path.join(dir, 'plan.json');"), '계획 파일 이름이 바뀌었다');
  assert.ok(src.includes("path.join(this.root, '_agent', 'shared', 'downloads')"), '받아 두는 자리가 바뀌었다');
  assert.ok(src.includes('`update-${stamp(this.now())}`'), '받아 두는 폴더 이름이 바뀌었다');
  assert.ok(src.includes("return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;"), '시각 형식이 바뀌었다 — windowStamp 를 함께 고친다');
  assert.ok(src.includes("[apply, '--plan', plan.file]") && src.includes('cwd: path.dirname(apply)'), '적용기를 띄우는 꼴이 바뀌었다 — applierCommand 를 함께 고친다');
  assert.ok(src.includes("path.join(this.root, '_agent', 'shared', 'tools', 'updater', 'apply.mjs')") && src.includes("path.join(this.root, '_agent', 'shared', 'tools', 'node', 'node.exe')"));
  assert.ok(src.includes("writeJsonAtomic = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8'); fs.renameSync(tmp, file); };"), '계획을 쓰는 방식이 바뀌었다 — writePlan 을 함께 고친다');
});

// ---------------------------------------------------------------------------
// 지금 적용기가 그 계획을 받는다 — 저장소의 적용기를 진짜로 띄운다
// ---------------------------------------------------------------------------
test('지금 적용기를 창처럼 띄운다: 계획을 받아 시작 파일을 --auto 로 띄우고 곧바로 "넘김 성공"을 적는다 — 판정이 그대로 통과', async () => {
  const s = makeSoul('cli', { receiptVersion: '2.0.66' });
  const plan = buildPlan({ root: s.root, packageDir: s.packageDir, version: s.version, daemonPort: await closedPort(), daemonPid: finishedPid(), createdAt: new Date().toISOString() });
  const planFile = writePlan(s.dir, plan);
  const planAtStart = fs.readFileSync(planFile, 'utf8');

  // 창이 띄우는 꼴(인자 · 작업 폴더). 동봉 node 자리에는 이 시험의 node 를, 적용기 자리에는 저장소의 적용기를 쓴다.
  const apply = path.join(REPO, 'updater', 'apply.mjs');
  const env = { ...process.env };
  for (const k of ['IRIS_INSTALLER_AUTO', 'IRIS_INSTALLER_SOUL_NAME', 'IRIS_INSTALLER_RESUME']) delete env[k];
  const child = spawn(process.execPath, [apply, '--plan', planFile], { cwd: path.dirname(apply), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = []; const err = [];
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => err.push(String(d)));
  const exit = await new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal })); });
  const resultAtExit = fs.readFileSync(updateResultPath(s.root), 'utf8');
  const result = JSON.parse(resultAtExit);
  const logText = fs.readFileSync(updateLogPath(s.root), 'utf8');

  // ⓝ-1 넘김 · ⓝ-3 기록
  const handoff = judgeHandoff({ exit, stdout: out.join(''), result, version: s.version });
  assert.deepEqual(failed(handoff), [], `${err.join('')}\n${logText}`);
  assert.equal(handoff.length, 5);
  assert.deepEqual(result, { ok: true, items: [{ kind: 'package', version: s.version, ok: true }], at: result.at, handedOffToInstaller: true, relaunched: false }, '지금 적용기가 쓰는 결과의 모양');
  assert.deepEqual(failed(judgeApplierLog({ logText, version: s.version, soulName: path.basename(s.root) })), []);
  assert.ok(Number.isInteger(startedCmdPid(logText)) && startedCmdPid(logText) > 0);

  // 적용기가 띄운 가짜 시작 파일이 실제로 돌았다: --auto 인자 · 자동 모드 · 이 영혼의 이름.
  const marker = path.join(s.packageDir, 'started.txt');
  for (let i = 0; i < 100 && !fs.existsSync(marker); i += 1) await sleep(100);
  assert.ok(fs.existsSync(marker), '시작 파일이 돌지 않았다');
  for (let i = 0; i < 20 && fs.readFileSync(marker, 'utf8').trim() === ''; i += 1) await sleep(50);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), `--auto auto=1 soul=${path.basename(s.root)}`);

  // ⓝ-2 그때 영수증은 옛 판 그대로다(적용기는 영수증을 고치지 않는다 — ok 는 "넘겼다"일 뿐).
  const receipt = JSON.parse(fs.readFileSync(path.join(s.root, '_agent', 'setup', 'package-receipt.json'), 'utf8'));
  assert.deepEqual(receipt, { schema: 2, package: { version: '2.0.66' } });
  assert.match(describeHandoffMoment({ receiptVersionAtExit: receipt.package.version, prevVersion: '2.0.66', nextVersion: s.version }), /아직 옛 판\(2\.0\.66\)/);

  // ⓝ-4 "설치기가 끝난 뒤"(여기서는 가짜라 아무도 결과를 다시 쓰지 않는다 = 지금 설치기와 같다)
  const afterRows = judgeAfterInstaller({
    resultAtExit, resultAtEnd: fs.readFileSync(updateResultPath(s.root), 'utf8'), installerDoneMs: Date.now() + 1,
    planAtStart, planAtEnd: fs.readFileSync(planFile, 'utf8'), packageDirExists: fs.existsSync(s.packageDir),
  });
  assert.deepEqual(failed(afterRows), []);
  // 적용기는 잠금 파일도 능력 표도 만들지 않는다(지금 동작).
  assert.equal(fs.existsSync(path.join(s.root, '_agent', 'setup', 'agent-update.lock')), false);
  assert.deepEqual(fs.readdirSync(path.join(s.root, '_agent', 'setup')).sort(), ['package-receipt.json', 'update-result.json', 'update.log']);
});

test('넘기지 못한 경우를 판정이 잡는다: 시작 파일 없음 · 1.x 영수증 · 모르는 판 · 데몬이 안 끝남', async () => {
  const noop = () => ({ pid: 4321, unref() {} });
  // 시작 파일 없음
  const a = makeSoul('nocmd', { cmdBody: null });
  const ra = await applyPlan({ plan: buildPlan({ root: a.root, packageDir: a.packageDir, version: a.version, daemonPort: 0, daemonPid: 0, createdAt: 'x' }), spawnFn: noop });
  assert.equal(ra.ok, false);
  const rowsA = judgeHandoff({ exit: { code: 1, signal: null }, stdout: JSON.stringify(ra), result: ra, version: a.version });
  assert.ok(failed(rowsA).some((n) => n.includes('종료 코드 0')) && failed(rowsA).some((n) => n.includes('넘김 성공')), failed(rowsA).join(' | '));
  assert.match(rowsA[0].detail, /reason=/, '실패 사유가 판정 글에 보인다');
  // 1.x 영수증 → 설치기를 부르지 않는다(reinstall-required)
  const b = makeSoul('legacy', { receiptSchema: 1 });
  const rb = await applyPlan({ plan: buildPlan({ root: b.root, packageDir: b.packageDir, version: b.version, daemonPort: 0, daemonPid: 0, createdAt: 'x' }), spawnFn: () => { throw new Error('must not spawn'); } });
  assert.equal(rb.items[0].reason, 'reinstall-required');
  assert.equal(allOk(judgeHandoff({ exit: { code: 1, signal: null }, stdout: JSON.stringify(rb), result: rb, version: b.version })), false);
  // 모르는 판의 계획 → 아무것도 하지 않는다
  const c = makeSoul('schema');
  const rc = await applyPlan({ plan: { ...buildPlan({ root: c.root, packageDir: c.packageDir, version: c.version, daemonPort: 0, daemonPid: 0, createdAt: 'x' }), schema: 2 }, spawnFn: () => { throw new Error('must not spawn'); } });
  assert.equal(rc.reason, 'unsupported-schema');
  assert.equal(allOk(judgeHandoff({ exit: { code: 1, signal: null }, stdout: JSON.stringify(rc), result: rc, version: c.version })), false);
  // 데몬이 안 끝남 → 아무것도 하지 않는다
  const d = makeSoul('daemon');
  const rd = await applyPlan({
    plan: buildPlan({ root: d.root, packageDir: d.packageDir, version: d.version, daemonPort: 1, daemonPid: 1, createdAt: 'x' }),
    spawnFn: () => { throw new Error('must not spawn'); },
    waitFn: async () => ({ ok: false, reason: 'daemon-still-running', waitedMs: 5, pidAlive: true, portOpen: false }),
  });
  assert.equal(rd.reason, 'daemon-still-running');
  const logD = fs.readFileSync(updateLogPath(d.root), 'utf8');
  assert.ok(failed(judgeApplierLog({ logText: logD, version: d.version, soulName: path.basename(d.root) })).length >= 3);
  // 결과 파일이 아예 없음 · 출력이 없음
  const none = judgeHandoff({ exit: { code: 2, signal: null }, stdout: '', result: null, version: '2.0.99' });
  assert.equal(none.filter((r) => !r.ok).length, 5);
});

// ---------------------------------------------------------------------------
// 판정 낱개
// ---------------------------------------------------------------------------
test('judgeHandoff: 판이 다르거나 · 부품이 둘이거나 · 출력과 파일이 다르면 실패', () => {
  const good = { ok: true, items: [{ kind: 'package', version: '2.0.67', ok: true }], at: '2026-11-27T14:00:00.000Z', handedOffToInstaller: true, relaunched: false };
  const base = { exit: { code: 0, signal: null }, stdout: `noise\n${JSON.stringify(good)}\n`, result: good, version: '2.0.67' };
  assert.deepEqual(failed(judgeHandoff(base)), []);
  assert.deepEqual(failed(judgeHandoff({ ...base, version: '2.0.68' })).length, 1);
  const two = { ...good, items: [...good.items, { kind: 'face', version: '2.107.0', ok: true, reason: 'skipped-included-in-package' }] };
  assert.ok(failed(judgeHandoff({ ...base, result: two, stdout: JSON.stringify(two) })).some((n) => n.includes('한 줄')));
  assert.ok(failed(judgeHandoff({ ...base, stdout: JSON.stringify({ ...good, at: 'other' }) })).some((n) => n.includes('같은 내용')));
  assert.ok(failed(judgeHandoff({ ...base, result: { ...good, relaunched: true }, stdout: JSON.stringify({ ...good, relaunched: true }) })).some((n) => n.includes('넘김 성공')));
  assert.ok(failed(judgeHandoff({ ...base, result: { ...good, at: 'not a time' }, stdout: JSON.stringify({ ...good, at: 'not a time' }) })).some((n) => n.includes('시각')));
  assert.ok(failed(judgeHandoff({ ...base, exit: { code: null, signal: 'timeout' } })).some((n) => n.includes('종료 코드 0')));
  assert.deepEqual(lastJsonLine('a\n{"x":1}\n{broken\n'), { x: 1 });
  assert.equal(lastJsonLine(''), null);
  assert.equal(lastJsonLine(null), null);
});

test('넘긴 직후의 영수증 판은 판정이 아니라 기록이다 — 설치기가 빨라 이미 새 판이어도 실패가 아니다(시점 경쟁)', () => {
  const args = { prevVersion: '2.0.66', nextVersion: '2.0.67' };
  assert.equal(typeof describeHandoffMoment({ ...args, receiptVersionAtExit: '2.0.66' }), 'string', '돌려주는 것은 글 한 줄이다(판정 줄이 아니다)');
  assert.match(describeHandoffMoment({ ...args, receiptVersionAtExit: '2.0.66' }), /아직 옛 판\(2\.0\.66\).*넘겼다/);
  assert.match(describeHandoffMoment({ ...args, receiptVersionAtExit: '2.0.67' }), /이미 새 판\(2\.0\.67\).*정상일 수 있다/);
  assert.match(describeHandoffMoment({ ...args, receiptVersionAtExit: null }), /읽지 못함/);
  // 게이트는 이 글을 기록에만 남긴다 — check() 로 판정하지 않는다.
  const src = fs.readFileSync(path.join(REPO, 'verify', 'upgrade.mjs'), 'utf8');
  assert.ok(src.includes('log(describeHandoffMoment({ receiptVersionAtExit, prevVersion, nextVersion }));'));
  assert.doesNotMatch(src, /check\([^)]*describeHandoffMoment|judgeHandoffIsNotCompletion/);
  // 필수 판정의 이름 어디에도 "적용기가 끝난 그때 영수증이 옛 판"이 없다.
  const good = { ok: true, items: [{ kind: 'package', version: '2.0.67', ok: true }], at: '2026-11-27T14:00:00.000Z', handedOffToInstaller: true, relaunched: false };
  const names = [
    ...judgeHandoff({ exit: { code: 0, signal: null }, stdout: JSON.stringify(good), result: good, version: '2.0.67' }),
    ...judgeAfterInstaller({ resultAtExit: JSON.stringify(good), resultAtEnd: JSON.stringify(good), installerDoneMs: Date.parse('2026-11-27T14:05:00.000Z'), planAtStart: '{}', planAtEnd: '{}', packageDirExists: true }),
  ].map((r) => r.name).join('\n');
  assert.doesNotMatch(names, /영수증/);
});

test('judgeApplierLog: 줄이 빠지거나 · 다른 이름을 넘겼거나 · 차례가 뒤집히면 실패', () => {
  const good = [
    '2026-11-27T14:00:00.000Z apply start root=X:\\practice\\IRIS-upg schema=1 items=package@2.0.67',
    '2026-11-27T14:00:00.100Z daemon gone after 3ms',
    '2026-11-27T14:00:00.200Z package: started X:\\practice\\IRIS-upg\\_agent\\shared\\downloads\\update-20261127-230000\\package\\IRIS-설치.cmd (pid 777) with IRIS_INSTALLER_AUTO=1 soul=IRIS-upg',
    '2026-11-27T14:00:00.300Z apply done ok=true ',
  ].join('\r\n');
  const args = { version: '2.0.67', soulName: 'IRIS-upg' };
  assert.deepEqual(failed(judgeApplierLog({ ...args, logText: good })), []);
  assert.equal(startedCmdPid(good), 777);
  assert.equal(startedCmdPid('nothing'), null);
  assert.equal(failed(judgeApplierLog({ ...args, soulName: 'IRIS', logText: good })).length, 1, '다른 영혼 이름');
  assert.equal(failed(judgeApplierLog({ ...args, version: '2.0.6', logText: good })).length, 1, '판의 앞머리만 같은 것은 같은 판이 아니다');
  assert.ok(failed(judgeApplierLog({ ...args, logText: good.replace('schema=1', 'schema=2') })).length >= 1);
  assert.ok(failed(judgeApplierLog({ ...args, logText: good.replace('apply done ok=true', 'apply done ok=false reason=x') })).some((n) => n.includes('ok=true')));
  const swapped = good.split('\r\n'); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.ok(failed(judgeApplierLog({ ...args, logText: swapped.join('\r\n') })).some((n) => n.includes('데몬')), '데몬 확인이 띄우기보다 뒤');
  assert.equal(failed(judgeApplierLog({ ...args, logText: '' })).length, 4);
});

test('judgeAfterInstaller: 「지금 동작」을 굳힌다 — 결과 파일이 달라지거나 · 시각이 설치기 끝보다 늦거나 · 계획이 바뀌면 실패', () => {
  const result = JSON.stringify({ ok: true, items: [], at: '2026-11-27T14:00:00.000Z' }, null, 2);
  const base = { resultAtExit: result, resultAtEnd: result, installerDoneMs: Date.parse('2026-11-27T14:03:00.000Z'), planAtStart: '{"a":1}', planAtEnd: '{"a":1}', packageDirExists: true };
  assert.deepEqual(failed(judgeAfterInstaller(base)), []);
  assert.ok(failed(judgeAfterInstaller({ ...base, resultAtEnd: result.replace('true', 'false') })).some((n) => n.includes('다시 쓰지 않는다')));
  assert.match(judgeAfterInstaller({ ...base, resultAtEnd: `${result} ` }).find((r) => !r.ok).detail, /이 판정을 함께 바꾼다/);
  assert.ok(failed(judgeAfterInstaller({ ...base, installerDoneMs: Date.parse('2026-11-27T13:59:59.000Z') })).some((n) => n.includes('끝나기 전')));
  assert.ok(failed(judgeAfterInstaller({ ...base, installerDoneMs: NaN })).some((n) => n.includes('끝나기 전')), '설치기가 끝난 것을 보지 못했으면 실패');
  assert.ok(failed(judgeAfterInstaller({ ...base, planAtEnd: '{"a":2}' })).some((n) => n.includes('계획')));
  assert.ok(failed(judgeAfterInstaller({ ...base, packageDirExists: false })).some((n) => n.includes('남는다')));
  assert.equal(failed(judgeAfterInstaller({ ...base, resultAtExit: null, resultAtEnd: null })).length >= 2, true);
});

test('judgeKeepFilesLocked: 능력 표가 없거나 keepFiles 가 true 가 아니면 통과 — true 로 내면 실패', () => {
  assert.equal(allOk(judgeKeepFilesLocked({ capabilitiesText: null })), true);
  assert.equal(allOk(judgeKeepFilesLocked({ capabilitiesText: undefined })), true);
  for (const text of ['{}', '{"keepFiles":false}', '{"keepFiles":"true"}', '{"keepFiles":1}', '{"schema":1,"lock":true}', 'not json', '[]', 'null']) {
    assert.equal(allOk(judgeKeepFilesLocked({ capabilitiesText: text })), true, text);
  }
  const bad = judgeKeepFilesLocked({ capabilitiesText: '{"schema":1,"keepFiles":true}' });
  assert.equal(allOk(bad), false);
  assert.match(bad[0].detail, /keepFiles=true/);
  // 이 판은 능력 표를 싣지 않는다(창의 파일 선택은 잠긴 채다).
  assert.equal(fs.existsSync(path.join(REPO, 'updater', 'capabilities.json')), false);
});

// ---------------------------------------------------------------------------
// 받아 둔 사본의 시작 스크립트 — 브라우저 열기만 끈다
// ---------------------------------------------------------------------------
test('shimBootstrapNoBrowser: 진짜 bootstrap.ps1 에서 그 한 줄만 바꾼다 — 줄끝 그대로 · 두 번 해도 같다 · 파워셸이 읽는다', () => {
  const file = path.join(REPO, 'installer', 'bootstrap.ps1');
  const src = fs.readFileSync(file, 'utf8');
  const { text, changed } = shimBootstrapNoBrowser(src);
  assert.equal(changed, true);
  const a = src.split('\n'); const b = text.split('\n');
  assert.equal(a.length, b.length, '줄 수가 같다');
  const diff = a.map((l, i) => i).filter((i) => a[i] !== b[i]);
  assert.equal(diff.length, 1, '한 줄만 다르다');
  assert.match(a[diff[0]], /^\s+Start-Process \$url\r?$/);
  assert.equal(b[diff[0]].trim(), `if ($env:${NO_BROWSER_ENV} -eq '1') { Log 'Browser not opened (${NO_BROWSER_ENV}=1, verify gate).' } else { Start-Process $url }`);
  assert.equal(a[diff[0]].endsWith('\r'), b[diff[0]].endsWith('\r'), '그 줄의 줄끝이 그대로다');
  assert.equal((src.match(/\r\n/g) || []).length, (text.match(/\r\n/g) || []).length);
  assert.ok(/^[\x00-\x7f]*$/.test(b[diff[0]]), '덧댄 줄은 ASCII 다(PowerShell 5.1 이 머리표 없이 읽는다)');
  // 서버를 띄우는 줄 · 지문 확인은 그대로다.
  for (const keep of ['$proc = Start-Process -FilePath $nodeExe', "if ($Auto) { $serverArgs += '--auto' }", 'Open-Browser "http://127.0.0.1:$Port/"']) assert.ok(text.includes(keep), keep);
  // 두 번 해도 같다.
  assert.deepEqual(shimBootstrapNoBrowser(text), { text, changed: false });
  // 자리를 못 찾거나 둘이면 던진다(브라우저를 여는 채로 진행하지 않는다).
  assert.throws(() => shimBootstrapNoBrowser('Write-Host hi\r\n'), /found 0/);
  assert.throws(() => shimBootstrapNoBrowser('  Start-Process $url\r\n  Start-Process $url\r\n'), /found 2/);
  // 파워셸이 덧댄 글을 그대로 읽는다(실행하지 않고 문법만).
  const shimmed = path.join(tmp, 'bootstrap-shimmed.ps1');
  fs.writeFileSync(shimmed, text, 'utf8');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${shimmed.replace(/'/g, "''")}',[ref]$t,[ref]$e)|Out-Null; if($e.Count){$e|%{$_.Message};exit 1}else{exit 0}`],
  { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, r.stdout || r.stderr);
});

// ---------------------------------------------------------------------------
// 게이트 스크립트에 길이 달려 있다(실행하지 않고 글과 문법만)
// ---------------------------------------------------------------------------
test('verify/upgrade.mjs: --via-applier 길이 달려 있고, 직접 길(--auto)은 그대로다 — 문법 통과', () => {
  const file = path.join(REPO, 'verify', 'upgrade.mjs');
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes("const VIA_APPLIER = flag('--via-applier');"));
  assert.ok(src.includes("from './upgrade-applier.mjs'"));
  assert.ok(src.includes('server = await startInstaller(ZIP_NEXT, { auto: true, freshState: false });'), '직접 길은 그대로 있다');
  assert.ok(/if \(VIA_APPLIER\) \{[\s\S]*?updateViaApplier\(\{ nextZip, nextVersion, prevVersion, staged \}\)/.test(src));
  const via = src.slice(src.indexOf('async function updateViaApplier'), src.indexOf('// main'));
  assert.ok(via.includes('relaunch: false'), '게이트의 계획은 연습 루트의 IRIS 창을 띄우지 않는다');
  assert.ok(via.includes('serverEnv({ [NO_BROWSER_ENV]: \'1\' })'), '연습 환경(사용자 환경 무접촉 · 오프라인 · 창 다시 열기 끔) + 브라우저 끔으로 띄운다');
  assert.ok(via.includes('applierCommand(SOUL_ROOT, planFile)'), '① 이 깐 적용기를 띄운다(저장소의 적용기가 아니라)');
  assert.ok(via.includes('shimBootstrapNoBrowser(') && via.includes("path.join(packageDir, 'installer', 'bootstrap.ps1')"), '덧대는 것은 받아 둔 사본뿐');
  // 끝낼 때: 이름으로 끝내지 않고, 증명된 번호만.
  const stop = src.slice(src.indexOf('async function stopStagedInstaller'), src.indexOf('async function updateViaApplier'));
  assert.ok(stop.includes("samePath(info.path, path.join(INSTALLER_WORK, 'node', 'node.exe'))"), '실행 파일 경로로 "우리 것"을 증명한다');
  assert.doesNotMatch(src, /taskkill['", ]+\/IM|Stop-Process -Name|Get-Process node/i, '이름 기반 종료가 없다');
  for (const f of [file, path.join(REPO, 'verify', 'upgrade-applier.mjs')]) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
  }
});
