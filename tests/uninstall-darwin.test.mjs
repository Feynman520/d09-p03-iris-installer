import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { uniqueName, classify, unsafeReason } from '../installer/uninstall.mjs';

// macOS 삭제기(installer/uninstall.mjs, 규칙 = docs/설계-삭제기.md). 진짜 홈·launchd 는 건드리지 않는다:
// 가짜 홈(--home) 안에 IRIS 폴더·.zprofile·LaunchAgent·앱 바로가기·작업 폴더를 만들고 --no-launchctl 로 돌린다.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT_DIR, 'installer', 'uninstall.mjs');
const mac = process.platform === 'darwin';
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

function fakeHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iris-uninst-')));
  const soul = path.join(home, 'IRIS');
  const w = (rel, text = 'x', mode) => { const p = path.join(soul, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, mode ? { mode } : undefined); return p; };
  w('_agent/setup/package-receipt.json', JSON.stringify({ schema: 2, packageVersion: '2.0.50' }));
  w('_agent/shared/shims/claude', '#!/bin/sh\n', 0o755);
  w('_agent/claude/.claude.json', '{}');
  w('_ontology/graph.json', '{}');
  w('AGENTS.md', '# rules\n'); w('CLAUDE.md', '@AGENTS.md\n'); w('soul-state.json', '{}');
  w('IRIS Face.command', '#!/bin/sh\n', 0o755); w('소환하기.command', '#!/bin/sh\n', 0o755); w('Icon\r', '');
  w('R01-교사(Teacher)/D01-수업/계획.md', '내 자료');
  w('notes.txt', 'mine');
  w('_backup/old.txt', 'kept');
  fs.mkdirSync(path.join(soul, '_trash'));
  const shims = path.join(soul, '_agent', 'shared', 'shims');
  fs.writeFileSync(path.join(home, '.zprofile'), `export EDITOR=vim\n\n# >>> IRIS >>>\n# Managed by the IRIS installer\ncase ":$PATH:" in *":${shims}:"*) ;; *) export PATH="${shims}:$PATH" ;; esac\n# <<< IRIS <<<\n`);
  const la = path.join(home, 'Library', 'LaunchAgents'); fs.mkdirSync(la, { recursive: true });
  fs.writeFileSync(path.join(la, 'com.iris-workspace.relay.plist'), `<plist><dict><key>ProgramArguments</key><array><string>${soul}/_agent/shared/tools/node/bin/node</string><string>${soul}/_agent/shared/shims/relay-ensure.mjs</string></array></dict></plist>\n`);
  const app = path.join(home, 'Applications', 'IRIS.app', 'Contents'); fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.iris-workspace.launcher</string></dict></plist>\n');
  fs.writeFileSync(path.join(app, 'MacOS', 'IRIS'), `#!/bin/sh\nexec '${soul}/IRIS Face.command' "$@"\n`, { mode: 0o755 });
  const work = path.join(home, 'Library', 'Application Support', 'IRIS-Installer'); fs.mkdirSync(work, { recursive: true }); fs.writeFileSync(path.join(work, 'bootstrap.log'), 'log');
  return { home, soul, work, app: path.dirname(app) };
}
function run(home, args = [], env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, '--no-ui', '--home', home, '--no-launchctl', ...args], { encoding: 'utf8', env: { ...process.env, IRIS_INSTALLER_WORK_DIR: '', ...env } });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  return { code: r.status, result: line ? JSON.parse(line.slice(7)) : null, out: r.stdout + r.stderr };
}
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return null; } };

test('이름 겹침: 폴더는 이름 뒤에, 파일은 확장자 앞에, 점 이름은 끝에', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-uniq-'));
  for (const n of ['notes.txt', 'D02.01-작은 일', '.gitignore', '.agents']) fs.mkdirSync(path.join(d, n));
  assert.equal(uniqueName(d, 'notes.txt', false), 'notes (2).txt');
  assert.equal(uniqueName(d, 'D02.01-작은 일', true), 'D02.01-작은 일 (2)');
  assert.equal(uniqueName(d, '.gitignore', false), '.gitignore (2)');
  assert.equal(uniqueName(d, '.agents', true), '.agents (2)');
  assert.equal(uniqueName(d, 'new.md', false), 'new.md');
});

test('위험한 자리는 거부: 뿌리·홈·최상위·시스템 폴더·연결 폴더', { skip: !mac }, () => {
  const { home, soul } = fakeHome();
  assert.equal(unsafeReason(soul, { home }), null);
  for (const p of ['/', home, '/Users', '/Applications/IRIS', '/System/IRIS', path.join(home, 'Library')]) assert.ok(unsafeReason(p, { home }), p);
  const link = path.join(home, 'IRIS-link'); fs.symlinkSync(soul, link);
  assert.match(unsafeReason(link, { home }), /연결/);
  fs.writeFileSync(path.join(soul, 'IRIS-온톨로지.md'.normalize('NFD')), '# NFD name, as bsdtar leaves it');
  const c = classify(soul);
  assert.ok(c.system.some((n) => n.normalize('NFC') === 'IRIS-온톨로지.md'), 'NFD 한글 이름도 시스템 항목으로 알아본다');
  assert.deepEqual(c.user, ['R01-교사(Teacher)', '_backup', 'notes.txt']);
  assert.ok(c.system.includes('_trash') && c.system.includes('IRIS Face.command') && c.system.includes('소환하기.command') && c.system.includes('Icon\r'));
});

test('남기기: 내 작업은 보관 폴더로, IRIS 와 바깥 흔적은 전부 사라진다', { skip: !mac }, () => {
  const { home, soul, work, app } = fakeHome();
  const r = run(home, ['--mode', 'keep']);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.existsSync(soul), false, 'IRIS 폴더 없음');
  const archive = path.join(home, `IRIS-보관-${today}`);
  assert.deepEqual(ls(archive), ['AGENTS.md', 'R01-교사(Teacher)', '_backup', 'notes.txt']);
  assert.equal(fs.readFileSync(path.join(archive, 'R01-교사(Teacher)', 'D01-수업', '계획.md'), 'utf8'), '내 자료');
  assert.equal(fs.readFileSync(path.join(home, '.zprofile'), 'utf8'), 'export EDITOR=vim\n', '덩어리 밖은 그대로');
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.iris-workspace.relay.plist')), false);
  assert.equal(fs.existsSync(app), false, '앱 바로가기 없음');
  assert.equal(fs.existsSync(work), false, '작업 폴더 없음(다른 설치가 없으므로)');
  assert.equal(r.result.receiptKept, false);
});

test('전부 지우기: --yes 없으면 거부(아무것도 안 바뀜), 있으면 보관 폴더 없이 지운다', { skip: !mac }, () => {
  const { home, soul } = fakeHome();
  const before = ls(soul);
  const no = run(home, ['--mode', 'all']);
  assert.equal(no.code, 2); assert.deepEqual(ls(soul), before);
  const yes = run(home, ['--mode', 'all', '--yes']);
  assert.equal(yes.code, 0, yes.out);
  assert.equal(fs.existsSync(soul), false);
  assert.equal(ls(home).some((n) => n.startsWith('IRIS-보관')), false);
});

test('영수증이 없거나 깨졌거나 폴더가 연결이면 한 글자도 안 건드린다', { skip: !mac }, () => {
  const a = fakeHome(); fs.rmSync(path.join(a.soul, '_agent', 'setup', 'package-receipt.json'));
  const before = ls(a.soul);
  const r = run(a.home, ['--mode', 'all', '--yes']);
  assert.equal(r.code, 2); assert.equal(r.result.reason, 'no-receipt'); assert.deepEqual(ls(a.soul), before);
  assert.ok(fs.existsSync(path.join(a.home, '.zprofile')) && fs.readFileSync(path.join(a.home, '.zprofile'), 'utf8').includes('# >>> IRIS >>>'), '흔적도 그대로(폴더가 있으니 흔적만 남은 경우가 아니다)');

  const b = fakeHome(); fs.writeFileSync(path.join(b.soul, '_agent', 'setup', 'package-receipt.json'), '{ broken');
  assert.equal(run(b.home, ['--mode', 'keep']).code, 2); assert.ok(fs.existsSync(path.join(b.soul, 'notes.txt')));

  const c = fakeHome(); const real = path.join(c.home, 'real-IRIS'); fs.renameSync(c.soul, real); fs.symlinkSync(real, c.soul);
  const rc = run(c.home, ['--mode', 'all', '--yes']);
  assert.equal(rc.code, 2, rc.out); assert.match(rc.result.reason, /연결/);
  assert.ok(fs.existsSync(path.join(real, 'notes.txt')) && fs.existsSync(path.join(real, '_agent')));
});

test('미리보기는 아무것도 바꾸지 않는다', { skip: !mac }, () => {
  const { home, soul } = fakeHome();
  const before = ls(soul); const zp = fs.readFileSync(path.join(home, '.zprofile'), 'utf8');
  const r = run(home, ['--mode', 'keep', '--dry-run']);
  assert.equal(r.code, 0); assert.equal(r.result.dryRun, true);
  assert.deepEqual(r.result.plan.user, ['R01-교사(Teacher)', '_backup', 'notes.txt']);
  assert.equal(r.result.plan.traces.profiles.length, 1); assert.ok(r.result.plan.traces.plist); assert.equal(r.result.plan.traces.apps.length, 1);
  assert.deepEqual(ls(soul), before); assert.equal(fs.readFileSync(path.join(home, '.zprofile'), 'utf8'), zp);
});

test('흔적만 남은 Mac: 없어진 폴더를 가리키는 덩어리·자동 시작·앱만 지우고, 다른 설치의 것은 둔다', { skip: !mac }, () => {
  const { home, soul } = fakeHome();
  fs.rmSync(soul, { recursive: true });
  const other = path.join(home, 'OTHER'); fs.mkdirSync(path.join(other, '_agent', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(home, '.bash_profile'), `# >>> IRIS >>>\nexport PATH="${other}/_agent/shared/shims:$PATH"\n# <<< IRIS <<<\n`);
  const r = run(home);
  assert.equal(r.code, 0, r.out); assert.equal(r.result.tracesOnly, true);
  assert.equal(fs.readFileSync(path.join(home, '.zprofile'), 'utf8'), 'export EDITOR=vim\n');
  assert.ok(fs.readFileSync(path.join(home, '.bash_profile'), 'utf8').includes(other), '있는 폴더를 가리키는 덩어리는 그대로');
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.iris-workspace.relay.plist')), false);
  assert.equal(fs.existsSync(path.join(home, 'Applications', 'IRIS.app')), false);
  assert.ok(fs.existsSync(path.join(home, 'Library', 'Application Support', 'IRIS-Installer')), '작업 폴더만은 흔적으로 치지 않는다');
  assert.equal(run(home).code, 2, '두 번째는 찾을 것이 없다');
});

test('IRIS 폴더 안 프로그램은 PID 로 끈다(실행 파일이 안에 있음 · 명령줄이 폴더를 가리키는 node)', { skip: !mac }, async () => {
  const { home, soul } = fakeHome();
  // ⓐ 실행 파일이 폴더 안(동봉 node 자리 — 옮겨 놓은 Apple 실행 파일은 macOS 가 죽이므로 이 node 로의 연결로 흉내)
  const nodeIn = path.join(soul, '_agent', 'shared', 'tools', 'node', 'bin', 'node'); fs.mkdirSync(path.dirname(nodeIn), { recursive: true }); fs.symlinkSync(process.execPath, nodeIn);
  const a = spawn(nodeIn, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); a.unref();
  // ⓑ 실행기(node)인데 명령줄이 폴더를 가리킴 · ⓒ 실행기(sh)로 도는 폴더 안 스크립트
  const b = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(soul, '_agent', 'x.mjs')], { stdio: 'ignore', detached: true }); b.unref();
  const loop = path.join(soul, '_agent', 'loop.sh'); fs.writeFileSync(loop, '#!/bin/sh\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  const c = spawn('/bin/sh', [loop], { stdio: 'ignore', detached: true }); c.unref();
  await new Promise((res) => setTimeout(res, 400));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    assert.ok(alive(a.pid) && alive(b.pid) && alive(c.pid), 'three test processes started');
    const r = run(home, ['--mode', 'keep']);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.result.stopped >= 3, `stopped=${r.result.stopped}`);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(alive(a.pid), false); assert.equal(alive(b.pid), false); assert.equal(alive(c.pid), false);
  } finally { for (const p of [a, b, c]) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} try { process.kill(p.pid, 'SIGKILL'); } catch {} } }
});

test('지우지 못한 것이 있으면 영수증을 남기고(1), 다시 돌리면 같은 보관 폴더로 마저 끝낸다(0)', { skip: !mac }, () => {
  const { home, soul } = fakeHome();
  const stuck = path.join(soul, '_ontology', 'graph.json');
  spawnSync('/usr/bin/chflags', ['uchg', stuck]);
  try {
    const r1 = run(home, ['--mode', 'keep']);
    assert.equal(r1.code, 1, r1.out); assert.deepEqual(r1.result.left, ['_ontology']); assert.equal(r1.result.receiptKept, true);
    assert.ok(fs.existsSync(path.join(soul, '_agent', 'setup', 'package-receipt.json')));
    assert.equal(fs.existsSync(path.join(soul, '_agent', 'claude')), false, '영수증 말고는 _agent 도 지웠다');
  } finally { spawnSync('/usr/bin/chflags', ['nouchg', stuck]); }
  fs.writeFileSync(path.join(soul, 'notes.txt'), 'made after the first run');
  const r2 = run(home, ['--mode', 'keep']);
  assert.equal(r2.code, 0, r2.out); assert.equal(fs.existsSync(soul), false);
  const archive = path.join(home, `IRIS-보관-${today}`);
  assert.equal(r2.result.archive, archive, '같은 날 보관 폴더를 이어 쓴다');
  assert.deepEqual(ls(archive), ['AGENTS.md', 'R01-교사(Teacher)', '_backup', 'notes (2).txt', 'notes.txt']);
});

test('한 번에 하나만: 살아 있는 잠금이 있으면 4', { skip: !mac }, () => {
  const { home, soul } = fakeHome();
  fs.writeFileSync(path.join(home, '.iris-uninstaller.lock'), String(process.pid));
  const r = spawnSync(process.execPath, [SCRIPT, '--no-ui', '--home', home, '--no-launchctl', '--mode', 'keep'], { encoding: 'utf8' });
  assert.equal(r.status, 4); assert.ok(fs.existsSync(path.join(soul, 'notes.txt')));
  fs.writeFileSync(path.join(home, '.iris-uninstaller.lock'), '999999');
  assert.equal(run(home, ['--mode', 'keep']).code, 0, '주인이 죽은 잠금은 넘긴다');
});

test('IRIS-삭제.command: ASCII·실행 권한, 작업 폴더의 node 로 돌고 종료 코드를 그대로 넘긴다', { skip: !mac }, () => {
  const cmd = path.join(ROOT_DIR, 'installer', 'IRIS-삭제.command');
  const text = fs.readFileSync(cmd);
  assert.ok(![...text].some((b) => b > 0x7e || (b < 0x20 && b !== 0x0a)), 'ASCII·LF 만');
  assert.equal(fs.statSync(cmd).mode & 0o111, 0o111);
  const { home, soul } = fakeHome();
  const work = path.join(home, 'work'); fs.mkdirSync(path.join(work, 'node', 'bin'), { recursive: true }); fs.symlinkSync(process.execPath, path.join(work, 'node', 'bin', 'node'));
  const env = { ...process.env, HOME: home, IRIS_INSTALLER_WORK_DIR: work };
  const r2 = spawnSync('/bin/sh', [cmd, '--no-ui', '--home', home, '--no-launchctl', '--mode', 'all'], { encoding: 'utf8', env });
  assert.equal(r2.status, 2, r2.stdout + r2.stderr);
  const r0 = spawnSync('/bin/sh', [cmd, '--no-ui', '--home', home, '--no-launchctl', '--mode', 'keep'], { encoding: 'utf8', env });
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  assert.equal(fs.existsSync(soul), false);
  assert.equal(fs.existsSync(work), false, 'IRIS_INSTALLER_WORK_DIR 의 작업 폴더도(다른 설치 없음)');
});
