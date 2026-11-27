// 2.0.67 — 훅 다리 사본(agy-hook-bridge.py): 설치기는 **놓기만** 한다.
//
// 지키는 것:
//   · 사본과 그 시험 파일이 `hooks` 부품의 원본 폴더에 있고(LF · 머리표 없음), 놓이는 자리는 가드 둘과 같은 `_agent\claude\scripts`.
//   · **어디에도 등록하지 않는다** — 클로드 `settings.json` · 코덱스 `hooks.json` 은 다리가 없는 꾸러미로 만든 것과 바이트까지 같고,
//     `NAME_MATCHED_HOOKS` · 등록하는 훅 목록에 다리 이름이 없다. 설치기는 Antigravity 의 설정 폴더를 모른다.
//   · 부품 검증기(V.hooks)는 다리가 없으면 "없음"으로 답한다. 풀기 단계는 섞여 사는 폴더에 다리를 놓고 그 사람 파일은 그대로 둔다.
//   · 사본의 자체 시험(파이썬이 있을 때): 임시 영혼 폴더에서 가드 둘을 진짜로 불러 막을 것을 막고 통과시킬 것을 통과시킨다.
//
// 진짜 설치 폴더 · 진짜 사용자 폴더에는 닿지 않는다: 가드와 다리는 `IRIS_ROOT`(시험이 준 임시 폴더)만 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as adapters from '../installer/setup/adapters.mjs';
import * as unpack from '../installer/setup/unpack.mjs';
import { run } from '../lib/run.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_SRC = path.join(REPO, 'payload-src', 'policy', 'hooks');
const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
const BRIDGE = 'agy-hook-bridge.py';
const BRIDGE_TEST = 'agy-hook-bridge.test.py';
const RELEASE_GATE = process.env.IRIS_RELEASE_GATE === '1';
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-agy-bridge-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
const under = (root, rel) => path.join(root, String(rel).split('/').join(path.sep));

// ---------------------------------------------------------------------------
// 원본 폴더의 두 파일
// ---------------------------------------------------------------------------
test('사본과 시험 파일이 hooks 부품의 원본 폴더에 있다 — LF · 머리표 없음 · 가드 둘 옆', () => {
  assert.equal(LOCK.parts.hooks.source, 'payload-src/policy/hooks');
  assert.equal(LOCK.parts.hooks.dest, '_agent/claude/scripts', '다리는 자기 자리에서 가드와 영혼 루트를 찾으므로 이 자리여야 한다');
  for (const name of [BRIDGE, BRIDGE_TEST, 'guard-iris-path.py', 'block-blanket-kill.ps1']) {
    assert.ok(fs.existsSync(path.join(HOOKS_SRC, name)), `${name} 없음`);
  }
  for (const name of [BRIDGE, BRIDGE_TEST]) {
    const buf = fs.readFileSync(path.join(HOOKS_SRC, name));
    assert.ok(buf.length > 1000, name);
    assert.equal(buf.includes(0x0d), false, `${name}: CR 이 없다(LF 만)`);
    assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name}: 머리표(BOM) 없음`);
    assert.equal(buf.some((b) => b < 0x20 && b !== 0x0a), false, `${name}: 제어 문자 없음`);
    assert.equal(buf[buf.length - 1], 0x0a, `${name}: 끝 줄바꿈`);
  }
  const src = fs.readFileSync(path.join(HOOKS_SRC, BRIDGE), 'utf8');
  // 다리가 기대는 것: 같은 폴더의 가드 둘 · 자기 자리에서 세 칸 위가 영혼 루트 · 고장 나면 막는다.
  assert.match(src, /GUARD_PATH = os\.path\.join\(HERE, "guard-iris-path\.py"\)/);
  assert.match(src, /GUARD_KILL = os\.path\.join\(HERE, "block-blanket-kill\.ps1"\)/);
  assert.match(src, /IRIS = os\.path\.abspath\(os\.path\.join\(HERE, "\.\.", "\.\.", "\.\."\)\)/);
  assert.match(src, /res = \{"decision": "deny", "reason": BLOCK \+ type\(e\)\.__name__\}/);
  // 다리는 네트워크 · 사용자 폴더 · 설정 파일을 모른다(판정만 한다).
  assert.doesNotMatch(src, /\.gemini|expanduser|urllib|http\.client|socket|requests|hooks\.json|settings\.json/);
});

// ---------------------------------------------------------------------------
// 놓기만 한다 — 어댑터 단계
// ---------------------------------------------------------------------------
function makeTools(root) {
  const sp = under(root, LOCK.parts.superpowers.dest);
  put(path.join(sp, '.claude-plugin', 'plugin.json'), '{"name":"superpowers","version":"6.3.0"}\n');
  put(path.join(sp, 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\n---\n# x\n');
  const si = under(root, LOCK.parts['self-improve'].dest);
  put(path.join(si, '.claude-plugin', 'plugin.json'), '{"name":"self-improve","version":"0.2.0"}\n');
  put(path.join(si, 'server', 'index.js'), '// server\n');
  put(path.join(under(root, LOCK.parts['frontend-design'].dest), '.claude-plugin', 'plugin.json'), '{"name":"frontend-design"}\n');
  put(path.join(under(root, LOCK.parts['insane-search'].dest), '.claude-plugin', 'plugin.json'), '{"name":"insane-search"}\n');
  put(path.join(under(root, LOCK.parts['playwright-mcp'].dest), ...LOCK.parts['playwright-mcp'].entry.split('/')), '// cli\n');
  for (const id of ['hwp-automation', 'excel-automation', 'ppt-automation', 'word-automation', 'pdf-automation']) {
    put(path.join(under(root, LOCK.parts[id].dest), 'server.py'), '# server\n');
  }
}
/** withBridge:false = 다리가 없던 판의 꾸러미(같은 폴더에서 다리 두 파일만 뺀 것). */
function makeCtx(label, { withBridge = true } = {}) {
  // 두 실행의 루트 경로 길이가 같아야 설정 파일의 바이트를 그대로 견줄 수 있다 → 같은 이름 · 다른 부모.
  const root = path.join(tmp, label, 'soul-IRIS');
  fs.mkdirSync(root, { recursive: true });
  makeTools(root);
  const payloadDir = path.join(tmp, label, 'payload');
  fs.mkdirSync(path.join(payloadDir, 'policy', 'hooks'), { recursive: true });
  for (const f of fs.readdirSync(HOOKS_SRC)) {
    if (!withBridge && f.startsWith('agy-hook-bridge')) continue;
    fs.copyFileSync(path.join(HOOKS_SRC, f), path.join(payloadDir, 'policy', 'hooks', f));
  }
  const logs = [];
  return {
    root, payloadDir, lock: LOCK,
    manifest: { schema: 1, package: { version: '2.0.0' }, parts: {} },
    choice: { subscriptions: ['claude', 'chatgpt'], leadAgent: 'claude' },
    precheck: { edge: { present: true } },
    offline: true,
    log: (line) => logs.push(line),
    progress: () => {},
    run: async (exe) => (exe === 'reg' ? { code: 1, out: '', err: '' } : { code: 0, out: 'ok', err: '' }),
    fs, env: { PATH: 'X' }, logs,
  };
}
const scriptsDir = (root) => path.join(root, '_agent', 'claude', 'scripts');
const claudeSettings = (root) => path.join(root, '_agent', 'claude', 'settings.json');
function findFiles(root, name) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === name) out.push(p); } };
  walk(root);
  return out;
}
function allFiles(root) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  walk(root);
  return out;
}

test('어댑터 단계: 다리와 시험 파일을 가드 옆에 놓는다 — 훅 설정에는 넣지 않는다(다리가 없는 꾸러미와 바이트까지 같다)', async () => {
  const withB = makeCtx('with', { withBridge: true });
  const without = makeCtx('none', { withBridge: false });
  await adapters.run(withB);
  await adapters.run(without);

  // ① 놓였다 — 꾸러미의 것과 바이트까지 같다.
  for (const name of [BRIDGE, BRIDGE_TEST]) {
    const placed = path.join(scriptsDir(withB.root), name);
    assert.ok(fs.existsSync(placed), `${name} 이 놓이지 않았다`);
    assert.deepEqual(fs.readFileSync(placed), fs.readFileSync(path.join(HOOKS_SRC, name)), name);
    assert.equal(fs.existsSync(path.join(scriptsDir(without.root), name)), false, '없는 꾸러미에서는 만들지 않는다');
  }
  assert.ok(without.logs.some((l) => l.includes(BRIDGE) && l.includes('없어')), '꾸러미에 없으면 기록 한 줄로 알린다(설치는 계속)');

  // ② 두 설정 파일은 다리가 없는 꾸러미로 만든 것과 **바이트까지** 같다(루트 경로만 다르다 — 같은 길이의 다른 폴더).
  const norm = (ctx, file) => fs.readFileSync(file, 'utf8').split(JSON.stringify(ctx.root).slice(1, -1)).join('<ROOT>').split(ctx.root).join('<ROOT>');
  const settingsA = norm(withB, claudeSettings(withB.root));
  const settingsB = norm(without, claudeSettings(without.root));
  assert.equal(settingsA, settingsB, '클로드 settings.json 이 달라졌다');
  const codexA = findFiles(path.join(withB.root, '_agent'), 'hooks.json');
  const codexB = findFiles(path.join(without.root, '_agent'), 'hooks.json');
  assert.ok(codexA.length >= 1, '코덱스 hooks.json 이 있다');
  assert.deepEqual(codexA.map((f) => path.relative(withB.root, f)), codexB.map((f) => path.relative(without.root, f)));
  for (let i = 0; i < codexA.length; i += 1) assert.equal(norm(withB, codexA[i]), norm(without, codexB[i]), `코덱스 ${path.relative(withB.root, codexA[i])} 이 달라졌다`);

  // ③ 등록된 훅의 수는 지금까지와 같다(클로드: 막는 훅 둘 · 세션 시작 둘 · 끝날 때 하나).
  const hooks = JSON.parse(fs.readFileSync(claudeSettings(withB.root), 'utf8')).hooks;
  assert.deepEqual({ pre: hooks.PreToolUse.length, start: hooks.SessionStart.length, stop: hooks.Stop.length }, { pre: 2, start: 2, stop: 1 });

  // ④ 다리 이름은 그 두 파일 말고는 영혼 폴더 어디에도 없다(설정 · 등록부 · 기록 파일 전부).
  for (const file of allFiles(withB.root)) {
    if (path.dirname(file) === scriptsDir(withB.root) && path.basename(file).startsWith('agy-hook-bridge')) continue;
    assert.equal(fs.readFileSync(file).includes('agy-hook-bridge'), false, `${path.relative(withB.root, file)} 에 다리 이름이 있다`);
  }
  // ⑤ 설치기는 Antigravity 의 설정 폴더를 만들지 않는다(영혼 폴더 안에도).
  assert.equal(allFiles(withB.root).some((f) => /[\\/]\.gemini[\\/]/.test(f)), false);

  // ⑥ 두 번 돌려도 같다(이미 있으면 건너뛴다 — 그 사람이 고친 사본을 덮지 않는다).
  const mine = path.join(scriptsDir(withB.root), BRIDGE);
  fs.writeFileSync(mine, '# 내가 고친 사본\n');
  await adapters.run(withB);
  assert.equal(fs.readFileSync(mine, 'utf8'), '# 내가 고친 사본\n');
  assert.equal(norm(withB, claudeSettings(withB.root)), settingsA, '되풀이 실행에도 설정은 그대로');
});

test('목록: 다리는 "놓기만 하는 파일" 쪽에 있고, 훅으로 등록하는 목록 · 이름으로 알아보는 목록에는 없다', () => {
  assert.deepEqual(adapters.HOOK_SCRIPTS, ['block-blanket-kill.ps1', 'guard-iris-path.py', 'bg-leftover-guard.py'], '등록하는 훅 스크립트는 그대로 셋');
  assert.ok(adapters.HOOK_EXTRAS.includes(BRIDGE) && adapters.HOOK_EXTRAS.includes(BRIDGE_TEST));
  assert.deepEqual(adapters.HOOK_EXTRAS.slice(0, 3), ['block-blanket-kill.test.py', 'guard-iris-path.test.py', 'bg-leftover-guard.test.py'], '있던 셋은 그대로');
  const src = fs.readFileSync(path.join(REPO, 'installer', 'setup', 'adapters.mjs'), 'utf8');
  const named = /NAME_MATCHED_HOOKS\s*=\s*[^;]*;/.exec(src)?.[0] ?? '';
  assert.ok(named.length > 0, 'NAME_MATCHED_HOOKS 를 찾는다');
  assert.doesNotMatch(named, /agy/);
  // 다리 이름은 그 목록 한 곳에만 나온다(훅 명령을 만드는 코드에 없다).
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal((code.match(/agy-hook-bridge/g) || []).length, 2, '목록의 두 이름뿐');
  // 설치기 전체에서 Antigravity 의 설정 폴더 이름은 0건이다.
  for (const rel of ['installer/setup/adapters.mjs', 'installer/setup/unpack.mjs', 'installer/server.mjs', 'installer/lib/agylock.mjs', 'installer/lib/online.mjs', 'installer/uninstall.ps1', 'updater/agents.mjs', 'updater/apply.mjs']) {
    assert.equal(fs.readFileSync(path.join(REPO, rel), 'utf8').includes('.gemini'), false, rel);
  }
});

// ---------------------------------------------------------------------------
// 부품 검증기 · 풀기
// ---------------------------------------------------------------------------
test('부품 검증기(V.hooks): 다리가 없으면 "없음" — 있어야 통과', async () => {
  const root = path.join(tmp, 'verify', 'soul-IRIS');
  const dest = under(root, LOCK.parts.hooks.dest);
  for (const f of ['block-blanket-kill.ps1', 'guard-iris-path.py', 'bg-leftover-guard.py']) put(path.join(dest, f), '# x\n');
  // 검증기 표는 만들 때 런타임 부품(node · python · git)의 자리도 읽으므로 진짜 잠금표를 준다(그 부품들을 놓지는 않는다).
  const V = unpack.v2Verifiers({ root, fs, lock: LOCK, manifest: null });
  const before = await V.hooks();
  assert.equal(before.ok, false);
  assert.match(before.detail, /없음: agy-hook-bridge\.py/);
  put(path.join(dest, BRIDGE), '# x\n');
  const after_ = await V.hooks();
  assert.equal(after_.ok, true);
  assert.match(after_.detail, /agy-hook-bridge\.py/);
});

test('풀기 단계: 옛 판이 깔린 섞여 사는 폴더에 다리를 놓는다 — 그 사람 파일은 그대로, 진짜 검증기 통과', async () => {
  const base = path.join(tmp, 'unpack');
  const payloadDir = path.join(base, 'payload');
  const zip = path.join(payloadDir, 'tools', 'hooks.zip');
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  const names = fs.readdirSync(HOOKS_SRC).filter((n) => n !== '__pycache__').sort();
  const z = await run(TAR, ['-a', '-cf', zip, '-C', HOOKS_SRC, '--', ...names]);
  assert.equal(z.code, 0, `tar failed: ${z.err}`);

  const root = path.join(base, 'soul-IRIS');
  const dest = under(root, LOCK.parts.hooks.dest);
  // 옛 판(다리 없음)이 놓은 것 + 그 사람이 같은 폴더에 둔 파일.
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['block-blanket-kill.ps1', 'guard-iris-path.py', 'bg-leftover-guard.py']) fs.copyFileSync(path.join(HOOKS_SRC, f), path.join(dest, f));
  put(path.join(dest, 'my-own-hook.py'), '# 내 훅\n');
  put(path.join(root, '_agent', 'claude', 'settings.json'), '{"mine":true}\n');

  const lock = { schema: 2, package: { version: '2.0.67' }, parts: { hooks: { ...LOCK.parts.hooks, kind: 'dir' } } };
  const manifest = { schema: 2, package: { version: '2.0.67' }, parts: { hooks: { file: lock.parts.hooks.file, version: null, sha256: 'sha-hooks-new', dest: lock.parts.hooks.dest } } };
  const ctx = {
    root, payloadDir, lock, manifest, offline: true, fs,
    choice: { subscriptions: ['claude'], leadAgent: 'claude' },
    log: () => {}, progress: () => {},
    run: async () => ({ code: 0, out: 'stub', err: '' }),
    processes: { list: async () => [], files: async () => [] },
    env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '1' },
  };
  // 진짜 검증기 표에서 hooks 것만 꺼내 준다(표는 런타임 부품의 자리도 읽으므로 진짜 잠금표로 만든다 — 놓는 것은 hooks 하나뿐).
  ctx.verifiers = { hooks: unpack.v2Verifiers({ root, fs, lock: LOCK, manifest: null }).hooks };
  const { recorded } = await unpack.run(ctx);
  assert.deepEqual(recorded.placed, ['hooks']);
  for (const name of [BRIDGE, BRIDGE_TEST]) assert.deepEqual(fs.readFileSync(path.join(dest, name)), fs.readFileSync(path.join(HOOKS_SRC, name)), name);
  assert.equal(fs.readFileSync(path.join(dest, 'my-own-hook.py'), 'utf8'), '# 내 훅\n', '그 사람 파일은 그대로');
  assert.equal(fs.readFileSync(path.join(root, '_agent', 'claude', 'settings.json'), 'utf8'), '{"mine":true}\n', '풀기는 설정 파일에 손대지 않는다');
  assert.equal(fs.existsSync(`${dest}.prev`), false, '섞여 사는 폴더는 옆으로 옮기지 않는다');
});

// ---------------------------------------------------------------------------
// 사본의 자체 시험(파이썬이 있을 때)
// ---------------------------------------------------------------------------
let PY = null;
for (const [cmd, pre] of [['python', []], ['py', ['-3']]]) {
  const r = spawnSync(cmd, [...pre, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0 && String(r.stdout).trim() === '3') { PY = [cmd, ...pre]; break; }
}
/** 임시 영혼 폴더: 최상위 폴더 하나 + 가드 둘과 다리를 제자리에. */
function makeSoul(label, { drop = [] } = {}) {
  const root = path.join(tmp, label, 'soul-IRIS');
  fs.mkdirSync(path.join(root, 'R01-시험(Test)'), { recursive: true });
  put(path.join(root, 'AGENTS.md'), '# test\n');
  const scripts = scriptsDir(root);
  fs.mkdirSync(scripts, { recursive: true });
  for (const f of [BRIDGE, BRIDGE_TEST, 'guard-iris-path.py', 'block-blanket-kill.ps1']) {
    if (!drop.includes(f)) fs.copyFileSync(path.join(HOOKS_SRC, f), path.join(scripts, f));
  }
  return { root, scripts };
}
const pyEnv = (root) => ({ ...process.env, IRIS_ROOT: root, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' });
function askBridge(soul, input) {
  const r = spawnSync(PY[0], [...PY.slice(1), path.join(soul.scripts, BRIDGE)], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: pyEnv(soul.root), windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, `다리는 늘 종료 코드 0 이다: ${r.stderr}`);
  return JSON.parse(String(r.stdout).trim().split('\n').pop());
}
function skipNoPython(t) {
  const reason = '이 PC 에 파이썬이 없어 사본의 자체 시험을 돌리지 못함';
  if (RELEASE_GATE) assert.fail(`IRIS_RELEASE_GATE=1: 이 시험은 릴리스에서 건너뛸 수 없다 — ${reason}`);
  t.skip(reason);
}

// 경로 가드는 글자가 `<드라이브>:\IRIS\…` 꼴인 경로만 IRIS 경로로 본다(설치 폴더 이름이 고정이다). 있는지 없는지는 IRIS_ROOT 에서 본다.
// 그래서 사본의 .test.py(설치된 PC 용)는 진짜 설치 자리가 있는 PC 에서만 전부 돌고, 그 밖의 PC 에서는 스스로 건너뛴다.
const REAL_ROOT = path.join((process.env.SystemDrive || 'C:') + path.sep, 'IRIS');

test('사본의 자체 시험(.test.py): 가드 둘을 진짜로 불러 23항목 전부 통과 — 설치 자리가 있는 PC 에서', (t) => {
  if (!PY) { skipNoPython(t); return; }
  const soul = makeSoul('selftest');
  // 다리 · 가드는 임시 폴더의 사본이다(기록 파일도 그 안). 가드가 진짜 설치 자리에서 하는 일은 "그 폴더가 있는가" 읽기뿐이다.
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
  delete env.IRIS_ROOT;
  const ghost = path.join(REAL_ROOT, 'R07-開発者');
  const probeFile = path.join(REAL_ROOT, 'agy-hook-probe.txt');
  const before = [fs.existsSync(ghost), fs.existsSync(probeFile)];
  const r = spawnSync(PY[0], [...PY.slice(1), path.join(soul.scripts, BRIDGE_TEST)], { encoding: 'utf8', env, cwd: soul.scripts, windowsHide: true, timeout: 240000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.deepEqual([fs.existsSync(ghost), fs.existsSync(probeFile)], before, '시험은 판정만 한다 — 아무것도 만들지 않았다');
  if (/^SKIP/m.test(out)) {
    const reason = '이 PC 에는 설치 자리(<시스템 드라이브>의 IRIS 폴더)에 최상위 폴더가 없어 사본의 자체 시험이 스스로 건너뜀';
    if (RELEASE_GATE) assert.fail(`IRIS_RELEASE_GATE=1: 이 시험은 릴리스에서 건너뛸 수 없다 — ${reason}`);
    t.skip(reason);
    return;
  }
  assert.match(out, /23\/23 PASS/, out);
  assert.doesNotMatch(out, /^FAIL /m, out);
});

test('다리(어느 PC 에서나): 한자 경로 · 루트 낱개 파일 · 일괄 종료 = 막음, 평범한 일 = 통과, 가드가 없거나 입력을 못 읽으면 막음', (t) => {
  if (!PY) { skipNoPython(t); return; }
  const soul = makeSoul('direct');
  // 경로의 글자 꼴만 설치 자리처럼 만든다(없는 드라이브 글자). 있는지 없는지는 가드가 IRIS_ROOT(임시 영혼)에서 본다.
  const shape = (...rest) => ['Q:', 'IRIS', ...rest].join('\\');
  const top = shape('R01-시험(Test)');
  const call = (name, args) => ({ toolCall: { name, args }, workspacePaths: [top] });
  // 창이 세션 전에 하는 것과 같은 가짜 호출: 루트에 낱개 파일을 쓰려 한다 → 막아야 한다.
  const probe = askBridge(soul, call('write_file', { Path: JSON.stringify(shape('agy-hook-probe.txt').split('\\').join('/')), Content: '"x"' }));
  assert.equal(probe.decision, 'deny');
  assert.match(probe.reason, /agy-hook-probe\.txt/);
  assert.equal(fs.existsSync(path.join(soul.root, 'agy-hook-probe.txt')), false);
  assert.equal(askBridge(soul, call('write_to_file', { TargetFile: shape('R07-開発者', 'x.md') })).decision, 'deny', '한자가 든 경로');
  assert.equal(askBridge(soul, call('edit_file', { Path: JSON.stringify(shape('R07-開発者', 'a.md')) })).decision, 'deny', '실제 판의 도구 이름 · 한 겹 싼 값');
  assert.equal(askBridge(soul, call('write_to_file', { TargetFile: shape('R99-없음(None)', 'D01-x', 'a.md') })).decision, 'deny', '없는 최상위 폴더 아래');
  assert.equal(askBridge(soul, call('run_command', { CommandLine: `mkdir ${shape('R07-開発者')}`, Cwd: shape() })).decision, 'deny', '명령 속 한자 경로');
  assert.equal(askBridge(soul, call('write_to_file', { TargetFile: shape('R01-시험(Test)', 'note.md') })).decision, 'allow', '있는 최상위 폴더 아래 새 파일');
  assert.equal(askBridge(soul, call('write_file', { Path: JSON.stringify(path.join(os.tmpdir(), 'agy-bridge-outside', 'ok.txt')) })).decision, 'allow', 'IRIS 밖');
  assert.equal(askBridge(soul, call('run_command', { CommandLine: 'git status', Cwd: top })).decision, 'allow');
  assert.equal(askBridge(soul, call('run_command', { CommandLine: 'taskkill /IM node.exe /F', Cwd: top })).decision, 'deny', '일괄 종료 가드도 다리를 거쳐 막는다');
  assert.equal(askBridge(soul, call('run_command', { CommandLine: JSON.stringify('Get-Process node | Stop-Process'), Cwd: top })).decision, 'deny', '한 겹 싼 명령');
  assert.equal(askBridge(soul, call('read_file', { Path: shape('AGENTS.md') })).decision, 'allow');
  assert.equal(askBridge(soul, call('delete_path', { Target: shape('x') })).decision, 'deny', '쓰기 도구인데 경로를 못 찾음');
  assert.equal(askBridge(soul, { toolCall: { args: { CommandLine: 'echo' } } }).decision, 'deny', '도구 이름 없음');
  assert.equal(askBridge(soul, '{not json').decision, 'deny');
  assert.equal(askBridge(soul, '').decision, 'deny');
  assert.deepEqual(fs.readdirSync(soul.root).sort(), ['AGENTS.md', 'R01-시험(Test)', '_agent'], '판정만 한다 — 영혼 폴더에 아무것도 만들지 않았다');

  // 가드 파일이 없으면 통과시키지 않는다.
  const noGuard = makeSoul('noguard', { drop: ['guard-iris-path.py'] });
  const r = askBridge(noGuard, { toolCall: { name: 'write_to_file', args: { TargetFile: shape('R01-시험(Test)', 'a.md') } } });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /guard-iris-path\.py 없음/);
  const noKill = makeSoul('nokill', { drop: ['block-blanket-kill.ps1'] });
  const k = askBridge(noKill, { toolCall: { name: 'run_command', args: { CommandLine: 'git status', Cwd: top } } });
  assert.equal(k.decision, 'deny');
  assert.match(k.reason, /block-blanket-kill\.ps1 없음/);

  // 모르는 인수 이름은 이름만 기록한다 — 자리는 그 영혼 폴더 안.
  const weird = askBridge(soul, call('write_to_file', { Weird: 'SECRET-CONTENT' }));
  assert.equal(weird.decision, 'deny');
  const log = fs.readFileSync(path.join(soul.root, '_agent', 'claude', 'state', 'agy-hook-bridge.log'), 'utf8');
  assert.match(log, /write_to_file: no path key: Weird/);
  assert.doesNotMatch(log, /SECRET-CONTENT/);
});
