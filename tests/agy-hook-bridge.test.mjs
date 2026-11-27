// 2.0.67 — Antigravity 훅 다리(agy-hook-bridge.py): 설치기는 **놓기만** 한다. 그리고 `hooks` 부품을 건드리지 않는다.
//
// 지키는 것:
//   · 다리는 **따로 된 작은 부품**(`agy-hook-bridge` — 그림 도구와 같은 두 파일 묶음)이다. `hooks` 부품에 넣지 않는다:
//     `hooks` 는 섞여 사는 폴더에 압축을 통째로 푸는 부품이라, 파일 하나를 더해 지문이 바뀌면 업데이트 때 전체가 다시 풀려
//     그 사람이 고쳐 둔 가드 파일(guard-iris-path.py 등)을 사본 없이 덮는다(2026-11-28 코드 검토 "막아야 함").
//   · `hooks` 부품은 이 판에서 한 바이트도 달라지지 않았다(파일 목록 · 파일마다의 지문 · 잠금표 줄).
//   · 옛 설치에 그 사람이 고친 가드가 있어도 새 판의 풀기는 그 파일을 그대로 두고 다리만 새로 놓는다. 한 번 더 돌려도 변경 0.
//   · 같은 이름의 파일이 이미 있으면(그 사람이 놓아 둔 다리) 옆에 `.prev` 로 남기고 바꾼다. 실패하면 시작 전으로 되돌린다.
//   · **어디에도 등록하지 않는다** — 클로드 `settings.json` · 코덱스 `hooks.json` 은 다리가 없을 때와 바이트까지 같다.
//   · 사본의 자체 시험(파이썬이 있을 때): 가드 둘을 진짜로 불러 막을 것을 막고 통과시킬 것을 통과시킨다.
//
// 진짜 설치 폴더 · 진짜 사용자 폴더에 쓰지 않는다. 가드와 다리는 임시 폴더의 사본이다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as adapters from '../installer/setup/adapters.mjs';
import * as unpack from '../installer/setup/unpack.mjs';
import { planUpdateReset, RELAY_PARTS, VENV_PARTS } from '../installer/lib/update-plan.mjs';
import { isStageError } from '../installer/lib/errors.mjs';
import { collect, listFiles } from '../build/collect.mjs';
import { extractZip, zipDir } from '../lib/zip.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_SRC = path.join(REPO, 'payload-src', 'policy', 'hooks');
const BRIDGE_SRC = path.join(REPO, 'payload-src', 'tools', 'agy-hook-bridge');
const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
const PART = 'agy-hook-bridge';
const BRIDGE = 'agy-hook-bridge.py';
const BRIDGE_TEST = 'agy-hook-bridge.test.py';
const RELEASE_GATE = process.env.IRIS_RELEASE_GATE === '1';

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-agy-bridge-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
const under = (root, rel) => path.join(root, String(rel).split('/').join(path.sep));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const scriptsDir = (root) => path.join(root, '_agent', 'claude', 'scripts');
/** 폴더 지문: 경로 → 크기 · 수정 시각 · 내용 지문(두 번 돌려 "변경 0"을 볼 때 쓴다). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const st = fs.statSync(p);
      out[path.relative(dir, p)] = `${st.size}:${st.mtimeMs}:${sha(fs.readFileSync(p))}`;
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// 부품의 모양 — 따로 된 두 파일 묶음
// ---------------------------------------------------------------------------
test('잠금표 · 배치표: 다리는 따로 된 두 파일 묶음(dir + include / merge + files)이고 가드 옆에 놓인다', () => {
  const p = LOCK.parts[PART];
  assert.ok(p, '잠금표에 부품이 있다');
  assert.deepEqual({ kind: p.kind, source: p.source, include: p.include, file: p.file, dest: p.dest, license: p.license },
    { kind: 'dir', source: 'payload-src/tools/agy-hook-bridge', include: [BRIDGE, BRIDGE_TEST], file: 'tools/agy-hook-bridge.zip', dest: '_agent/claude/scripts', license: 'MIT' });
  assert.equal(p.dest, LOCK.parts.hooks.dest, '다리는 자기 자리에서 가드와 영혼 루트를 찾으므로 가드와 같은 폴더여야 한다');
  assert.equal(p.redistribute, undefined, '꾸러미에 싣는 부품이다(내려받기 아님)');
  assert.deepEqual(unpack.V2_LAYOUT[PART], { kind: 'archive', strip: 0, mode: 'merge', files: [BRIDGE, BRIDGE_TEST] });
  // `hooks` 의 배치는 그대로다: files 가 없는 통째 풀기. 그래서 이 부품에는 아무것도 더하면 안 된다.
  assert.deepEqual(unpack.V2_LAYOUT.hooks, { kind: 'archive', strip: 0, mode: 'merge' });
  const order = unpack.UNPACK_ORDER;
  assert.equal(order.indexOf(PART), order.indexOf('hooks') + 1, '풀기 차례는 hooks 바로 뒤');
  assert.equal(order.filter((x) => x === PART).length, 1);

  for (const name of [BRIDGE, BRIDGE_TEST]) {
    const buf = fs.readFileSync(path.join(BRIDGE_SRC, name));
    assert.ok(buf.length > 1000, name);
    assert.equal(buf.includes(0x0d), false, `${name}: CR 이 없다(LF 만)`);
    assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name}: 머리표(BOM) 없음`);
    assert.equal(buf.some((b) => b < 0x20 && b !== 0x0a), false, `${name}: 제어 문자 없음`);
    assert.equal(buf[buf.length - 1], 0x0a, `${name}: 끝 줄바꿈`);
  }
  assert.deepEqual(fs.readdirSync(BRIDGE_SRC).filter((n) => n !== '__pycache__').sort(), [BRIDGE, BRIDGE_TEST], '원본 폴더에는 그 두 파일뿐');
  const src = fs.readFileSync(path.join(BRIDGE_SRC, BRIDGE), 'utf8');
  // 다리가 기대는 것: 같은 폴더의 가드 둘 · 자기 자리에서 세 칸 위가 영혼 루트 · 고장 나면 막는다.
  assert.match(src, /GUARD_PATH = os\.path\.join\(HERE, "guard-iris-path\.py"\)/);
  assert.match(src, /GUARD_KILL = os\.path\.join\(HERE, "block-blanket-kill\.ps1"\)/);
  assert.match(src, /IRIS = os\.path\.abspath\(os\.path\.join\(HERE, "\.\.", "\.\.", "\.\."\)\)/);
  assert.match(src, /res = \{"decision": "deny", "reason": BLOCK \+ type\(e\)\.__name__\}/);
  // 다리는 네트워크 · 사용자 폴더 · 설정 파일을 모른다(판정만 한다).
  assert.doesNotMatch(src, /\.gemini|expanduser|urllib|http\.client|socket|requests|hooks\.json|settings\.json/);
});

// ---------------------------------------------------------------------------
// ⓐ hooks 부품은 이 판에서 한 바이트도 달라지지 않았다
// ---------------------------------------------------------------------------
// 2.0.66(가른 곳)의 hooks 원본 폴더 — 파일 이름과 내용 지문. 이 표가 달라지면 hooks 묶음의 지문이 달라진다.
const HOOKS_AS_OF_2_0_66 = {
  'bg-leftover-guard.py': '10c9f3129b2e729f2cbf15b99c84320ef04ca2e77c329d252315c10f6ad402ee',
  'bg-leftover-guard.test.py': '4c59ffb44fbacd89a26b675afd48591f25f30802fe8bda6c6e9d1cca85d2f5e6',
  'block-blanket-kill.ps1': '814bcb76671d4be69e5fb827f0e961f8daf7ca64ccb7cdda4f3dffd3d032922f',
  'block-blanket-kill.test.py': '06660dfdd6bb1516b3ce0cd4d6780a9aed48f4661aa04ae53eed6a0271215454',
  'guard-iris-path.py': '87005154e834cbae1dbd41a417283261cb768aeed30ce6aac63fde1c20787c76',
  'guard-iris-path.test.py': 'b36398ea48d0c782b49cbb672910ee6b8aacdc9e33ef783eea5be09f7275fc76',
};
const WHY_PINNED = 'hooks 부품의 파일이 하나라도 더해지거나 바뀌면 그 묶음의 지문이 바뀌고, 업데이트 때 압축 전체가 섞여 사는 폴더에 다시 풀려 '
  + '그 사람이 고쳐 둔 가드 파일을 사본 없이 덮는다. 새 파일은 이 부품에 넣지 말고 따로 된 파일 묶음 부품으로 싣는다. '
  + '가드 자체를 고쳐야 하는 판은 그 덮어쓰기를 알고 정한 뒤에 이 표를 고친다.';

test('hooks 부품은 2.0.66 과 같다 — 잠금표 줄 · 원본 폴더의 파일 목록 · 파일마다의 지문 · 빌드가 묶는 것', async () => {
  const h = LOCK.parts.hooks;
  assert.deepEqual({ kind: h.kind, source: h.source, exclude: h.exclude, include: h.include, asciiRequired: h.asciiRequired, file: h.file, dest: h.dest },
    { kind: 'dir', source: 'payload-src/policy/hooks', exclude: ['__pycache__'], include: undefined, asciiRequired: true, file: 'tools/hooks.zip', dest: '_agent/claude/scripts' }, WHY_PINNED);
  assert.doesNotMatch(String(h.note), /agy|Antigravity/i, '잠금표의 hooks 줄에 다리 이야기가 없다');
  const names = fs.readdirSync(HOOKS_SRC).filter((n) => n !== '__pycache__').sort();
  assert.deepEqual(names, Object.keys(HOOKS_AS_OF_2_0_66).sort(), WHY_PINNED);
  for (const [name, want] of Object.entries(HOOKS_AS_OF_2_0_66)) assert.equal(sha(fs.readFileSync(path.join(HOOKS_SRC, name))), want, `${name}: ${WHY_PINNED}`);

  // 빌드의 수집(build/collect.mjs)이 실제로 묶는 것: hooks = 그 여섯 파일 그대로, 다리 부품 = 그 두 파일 그대로.
  const stage = (tag) => ({ cacheDir: path.join(tmp, `cache-${tag}`), stageDir: path.join(tmp, `stage-${tag}`) });
  const built = await collect({ lock: { package: { version: '0' }, parts: { hooks: LOCK.parts.hooks, [PART]: LOCK.parts[PART] } }, ...stage('both'), log: () => {} });
  const hooksOut = path.join(tmp, 'hooks-out');
  await extractZip(path.join(built.payloadDir, 'tools', 'hooks.zip'), hooksOut);
  assert.deepEqual(listFiles(hooksOut).map((f) => f.split(path.sep).join('/')).sort(), Object.keys(HOOKS_AS_OF_2_0_66).sort(), 'hooks 묶음 안의 파일 목록');
  for (const [name, want] of Object.entries(HOOKS_AS_OF_2_0_66)) assert.equal(sha(fs.readFileSync(path.join(hooksOut, name))), want, `hooks 묶음 안의 ${name}`);
  const bridgeOut = path.join(tmp, 'bridge-out');
  await extractZip(path.join(built.payloadDir, 'tools', 'agy-hook-bridge.zip'), bridgeOut);
  assert.deepEqual(listFiles(bridgeOut).map((f) => f.split(path.sep).join('/')).sort(), [BRIDGE, BRIDGE_TEST]);
  for (const name of [BRIDGE, BRIDGE_TEST]) assert.ok(fs.readFileSync(path.join(bridgeOut, name)).equals(fs.readFileSync(path.join(BRIDGE_SRC, name))), `${name} 은 바이트 그대로 묶인다`);
  // 다리 부품이 잠금표에 있든 없든 hooks 묶음은 같은 바이트다(두 부품은 서로를 모른다).
  const alone = await collect({ lock: { package: { version: '0' }, parts: { hooks: LOCK.parts.hooks } }, ...stage('alone'), log: () => {} });
  assert.equal(sha(fs.readFileSync(path.join(alone.payloadDir, 'tools', 'hooks.zip'))), sha(fs.readFileSync(path.join(built.payloadDir, 'tools', 'hooks.zip'))), 'hooks 묶음의 지문');
});

// ---------------------------------------------------------------------------
// 풀기 — 옛 설치 위에 얹는다
// ---------------------------------------------------------------------------
/** 진짜 원본 폴더로 꾸러미를 만든다(hooks 묶음 · 다리 묶음). bridgeFiles 로 다리 묶음의 내용을 바꿀 수 있다(실패 시험용). */
async function makePayload(label, { bridgeFiles = null } = {}) {
  const payloadDir = path.join(tmp, label, 'payload');
  fs.mkdirSync(path.join(payloadDir, 'tools'), { recursive: true });
  // 묶는 함수는 폴더의 시각을 고정값으로 바꾼다 — 저장소의 원본 폴더가 아니라 임시 사본을 묶는다.
  const copyOf = (from, name) => {
    const to = path.join(tmp, label, name);
    for (const f of fs.readdirSync(from)) if (f !== '__pycache__') put(path.join(to, f), fs.readFileSync(path.join(from, f)));
    return to;
  };
  await zipDir(copyOf(HOOKS_SRC, 'hooks-src'), path.join(payloadDir, 'tools', 'hooks.zip'));
  let src;
  if (bridgeFiles) {
    src = path.join(tmp, label, 'bridge-src');
    for (const [name, body] of Object.entries(bridgeFiles)) put(path.join(src, name), body);
  } else src = copyOf(BRIDGE_SRC, 'bridge-src');
  await zipDir(src, path.join(payloadDir, 'tools', 'agy-hook-bridge.zip'));
  return payloadDir;
}
/** 풀기 단계의 ctx. parts = { 부품: 지문 } — 지문이 같으면 "같은 부품"이다. 검증기는 진짜 것을 쓴다. */
function unpackCtx(root, payloadDir, parts) {
  const lockParts = Object.fromEntries(Object.keys(parts).map((id) => [id, { ...LOCK.parts[id] }]));
  const lock = { schema: 2, package: { version: '2.0.67' }, parts: lockParts };
  const manifest = { schema: 2, package: { version: '2.0.67' }, parts: Object.fromEntries(Object.entries(parts).map(([id, sha256]) => [id, { file: lockParts[id].file, version: null, sha256, dest: lockParts[id].dest }])) };
  // 검증기 표는 만들 때 런타임 부품(node · python · git)의 자리도 읽으므로 진짜 잠금표로 만든다 — 놓는 것은 위 부품뿐이다.
  const real = unpack.v2Verifiers({ root, fs, lock: LOCK, manifest: null });
  return {
    root, payloadDir, lock, manifest, offline: true, fs,
    choice: { subscriptions: ['claude'], leadAgent: 'claude' },
    log: () => {}, progress: () => {},
    run: async () => ({ code: 0, out: 'stub', err: '' }),
    processes: { list: async () => [], files: async () => [] },
    env: { ...process.env, IRIS_INSTALLER_NO_USER_ENV: '1' },
    verifiers: Object.fromEntries(Object.keys(parts).map((id) => [id, real[id]])),
  };
}
const HOOKS_SHA = 'sha-of-hooks-as-shipped-in-2.0.66';

test('옛 설치에 그 사람이 고친 가드가 있다 → 새 판의 풀기는 그 파일을 그대로 두고 다리만 새로 놓는다 · 한 번 더 돌려도 변경 0', async () => {
  const payloadDir = await makePayload('upgrade');
  const root = path.join(tmp, 'upgrade', 'soul-IRIS');
  const dest = scriptsDir(root);

  // ① 옛 판(2.0.66): hooks 부품만 있다. 진짜 풀기로 놓는다 → 영수증 쪽 기록(부품 지문)이 남는다.
  const first = await unpack.run(unpackCtx(root, payloadDir, { hooks: HOOKS_SHA }));
  assert.deepEqual(first.recorded.placed, ['hooks']);
  assert.equal(fs.existsSync(path.join(dest, BRIDGE)), false, '옛 판에는 다리가 없다');

  // ② 그 사람이 가드를 고쳐 쓰고, 같은 폴더에 자기 훅도 두고, 설정 파일도 있다.
  const mine = `${fs.readFileSync(path.join(dest, 'guard-iris-path.py'), 'utf8')}\n# 내가 고친 줄: 우리 학교 폴더 규칙\n`;
  fs.writeFileSync(path.join(dest, 'guard-iris-path.py'), mine);
  const minePs = `${fs.readFileSync(path.join(dest, 'block-blanket-kill.ps1'), 'utf8')}\r\n# my own line\r\n`;
  fs.writeFileSync(path.join(dest, 'block-blanket-kill.ps1'), minePs);
  put(path.join(dest, 'my-own-hook.py'), '# 내 훅\n');
  put(path.join(root, '_agent', 'claude', 'settings.json'), '{"mine":true}\n');
  const before = snapshot(root);

  // ③ 새 판(2.0.67): hooks 는 같은 지문 · 다리 부품이 새로 생겼다.
  const second = await unpack.run(unpackCtx(root, payloadDir, { hooks: HOOKS_SHA, [PART]: 'sha-bridge-1' }));
  assert.deepEqual(second.recorded.placed, [PART], '놓은 것은 다리뿐');
  assert.deepEqual(second.recorded.skipped, ['hooks'], 'hooks 는 같은 부품이라 건드리지 않는다');
  assert.equal(fs.readFileSync(path.join(dest, 'guard-iris-path.py'), 'utf8'), mine, '그 사람이 고친 가드는 바이트 그대로');
  assert.equal(fs.readFileSync(path.join(dest, 'block-blanket-kill.ps1'), 'utf8'), minePs);
  assert.equal(fs.readFileSync(path.join(dest, 'my-own-hook.py'), 'utf8'), '# 내 훅\n');
  for (const name of [BRIDGE, BRIDGE_TEST]) assert.ok(fs.readFileSync(path.join(dest, name)).equals(fs.readFileSync(path.join(BRIDGE_SRC, name))), `${name} 이 새로 놓였다`);
  const after1 = snapshot(root);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after1)])].filter((k) => before[k] !== after1[k]).sort();
  assert.deepEqual(changed, [
    path.join('_agent', 'claude', 'scripts', BRIDGE), path.join('_agent', 'claude', 'scripts', BRIDGE_TEST), path.join('_agent', 'setup', 'unpack-state.json'),
  ].sort(), '달라진 것은 새 두 파일과 풀기 기록뿐(.prev 없음 · 설정 파일 무접촉 · 임시 자리 남지 않음)');
  assert.deepEqual(second.recorded.moved, [], '옆으로 옮기거나 사본을 남긴 것이 없다');
  assert.equal(fs.existsSync(`${dest}.prev`), false, '섞여 사는 폴더는 옆으로 옮기지 않는다');

  // ④ 한 번 더(같은 판 재실행 · 이어하기): 변경 0.
  const third = await unpack.run(unpackCtx(root, payloadDir, { hooks: HOOKS_SHA, [PART]: 'sha-bridge-1' }));
  assert.deepEqual(third.recorded.placed, []);
  assert.deepEqual(third.recorded.skipped, ['hooks', PART]);
  assert.deepEqual(snapshot(root), after1, '두 번째 적용은 아무것도 바꾸지 않는다');

  // ⑤ 그 뒤에 그 사람이 다리를 고쳐 써도 같은 판에서는 덮지 않는다.
  fs.writeFileSync(path.join(dest, BRIDGE), '# 내가 고친 다리\ndef to_claude(j):\n    return None, []\n');
  await unpack.run(unpackCtx(root, payloadDir, { hooks: HOOKS_SHA, [PART]: 'sha-bridge-1' }));
  assert.match(fs.readFileSync(path.join(dest, BRIDGE), 'utf8'), /^# 내가 고친 다리/);
});

test('같은 이름의 파일이 이미 있다 → 옆에 .prev 로 남기고 바꾼다(.prev 가 있으면 .prev-2) · 내용이 같으면 손대지 않는다', async () => {
  const payloadDir = await makePayload('prev');
  const root = path.join(tmp, 'prev', 'soul-IRIS');
  const dest = scriptsDir(root);
  // 그 사람이 손으로 놓아 둔 다리(다른 내용)와, 전에 남은 .prev, 그리고 이미 같은 내용인 시험 파일.
  put(path.join(dest, BRIDGE), '# 그 사람이 놓아 둔 다리\n');
  put(path.join(dest, `${BRIDGE}.prev`), '# 더 옛것\n');
  fs.copyFileSync(path.join(BRIDGE_SRC, BRIDGE_TEST), path.join(dest, BRIDGE_TEST));
  const testStat = fs.statSync(path.join(dest, BRIDGE_TEST)).mtimeMs;

  const r = await unpack.run(unpackCtx(root, payloadDir, { [PART]: 'sha-bridge-1' }));
  assert.deepEqual(r.recorded.placed, [PART]);
  assert.ok(fs.readFileSync(path.join(dest, BRIDGE)).equals(fs.readFileSync(path.join(BRIDGE_SRC, BRIDGE))), '새 다리로 바뀌었다');
  assert.equal(fs.readFileSync(path.join(dest, `${BRIDGE}.prev-2`), 'utf8'), '# 그 사람이 놓아 둔 다리\n', '옛 내용은 옆에 남는다');
  assert.equal(fs.readFileSync(path.join(dest, `${BRIDGE}.prev`), 'utf8'), '# 더 옛것\n', '전에 남은 사본을 덮지 않는다');
  assert.deepEqual(r.recorded.moved, [{ part: PART, previous: path.join('_agent', 'claude', 'scripts', `${BRIDGE}.prev-2`) }]);
  assert.equal(fs.statSync(path.join(dest, BRIDGE_TEST)).mtimeMs, testStat, '내용이 같은 파일은 다시 쓰지도 않는다');
  assert.deepEqual(fs.readdirSync(dest).sort(), [BRIDGE, `${BRIDGE}.prev`, `${BRIDGE}.prev-2`, BRIDGE_TEST].sort());
});

test('다리 묶음이 깨졌다(파일 하나가 없다) → 멈추고, 그 사람의 파일은 시작 전 그대로 · 사본도 남기지 않는다', async () => {
  const payloadDir = await makePayload('broken', { bridgeFiles: { [BRIDGE]: 'def to_claude(j):\n    pass\n' } }); // 시험 파일이 빠진 묶음
  const root = path.join(tmp, 'broken', 'soul-IRIS');
  const dest = scriptsDir(root);
  put(path.join(dest, BRIDGE), '# 그 사람이 놓아 둔 다리\n');
  put(path.join(dest, 'guard-iris-path.py'), '# 내 가드\n');
  const before = snapshot(dest);
  await assert.rejects(unpack.run(unpackCtx(root, payloadDir, { [PART]: 'sha-bridge-bad' })), (err) => isStageError(err) && err.code === 'E-UNPACK');
  assert.deepEqual(snapshot(dest), before, '폴더는 시작 전과 같다');
});

test('부품 검증기: 다리 부품은 두 파일이 다 있고 그 파일이어야 통과 — hooks 검증기는 다리를 요구하지 않는다', async () => {
  const root = path.join(tmp, 'verify', 'soul-IRIS');
  const dest = scriptsDir(root);
  const V = unpack.v2Verifiers({ root, fs, lock: LOCK, manifest: null });
  for (const f of ['block-blanket-kill.ps1', 'guard-iris-path.py', 'bg-leftover-guard.py']) put(path.join(dest, f), '# x\n');
  assert.equal((await V.hooks()).ok, true, 'hooks 는 지금까지의 세 파일만 본다(다리가 없어도 통과 — 옛 판에서 올라오는 PC 가 여기서 막히지 않는다)');
  const none = await V[PART]();
  assert.equal(none.ok, false);
  assert.match(none.detail, /agy-hook-bridge\.py 없음/);
  put(path.join(dest, BRIDGE), '');
  put(path.join(dest, BRIDGE_TEST), '# 다른 파일\n');
  const wrong = await V[PART]();
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /agy-hook-bridge\.py 없음, agy-hook-bridge\.test\.py 내용이 다름/);
  for (const name of [BRIDGE, BRIDGE_TEST]) fs.copyFileSync(path.join(BRIDGE_SRC, name), path.join(dest, name));
  assert.equal((await V[PART]()).ok, true);
});

test('업데이트 계획: 다리 부품이 새로 생겨도 풀기 · 환경 · 어댑터만 다시 돈다 — 실행기 · 파이썬 환경 단계를 돌릴 까닭이 없다', () => {
  assert.equal(RELAY_PARTS.includes(PART), false, '실행기 · 바로가기가 이 부품을 가리키지 않는다');
  assert.equal(VENV_PARTS.includes(PART), false);
  // 2.0.66 을 깐 PC 의 영수증: hooks 는 같은 지문으로 기록돼 있고 다리 부품은 없다.
  const receipt = { setup: { unpack: { recorded: { parts: { hooks: { identity: { version: null, sha256: HOOKS_SHA, tail: 'scripts', commit: null } } } } }, relay: { status: 'done' }, venv: { status: 'done' } } };
  const lock = { parts: { hooks: LOCK.parts.hooks, [PART]: LOCK.parts[PART] } };
  const manifest = { parts: { hooks: { sha256: HOOKS_SHA, dest: LOCK.parts.hooks.dest }, [PART]: { sha256: 'sha-bridge-1', dest: LOCK.parts[PART].dest } } };
  const plan = planUpdateReset({ receipt, lock, manifest });
  assert.deepEqual(plan.changed, [PART], '바뀐 부품은 다리뿐(hooks 는 같은 지문)');
  assert.deepEqual(plan.reset, ['unpack', 'env', 'adapters']);
  assert.ok(plan.keptDone.includes('relay') && plan.keptDone.includes('venv'));
});

// ---------------------------------------------------------------------------
// ⓓ 놓기만 한다 — 어디에도 등록하지 않는다
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
/** 풀기가 끝난 영혼(가드는 제자리에 있다). withBridge = 다리 부품도 놓였는가. */
function makeAdaptersCtx(label, { withBridge }) {
  // 두 실행의 루트 경로 길이가 같아야 설정 파일의 바이트를 그대로 견줄 수 있다 → 같은 이름 · 같은 길이의 다른 부모.
  const root = path.join(tmp, label, 'soul-IRIS');
  fs.mkdirSync(root, { recursive: true });
  makeTools(root);
  for (const f of fs.readdirSync(HOOKS_SRC)) if (f !== '__pycache__') put(path.join(scriptsDir(root), f), fs.readFileSync(path.join(HOOKS_SRC, f)));
  if (withBridge) for (const f of [BRIDGE, BRIDGE_TEST]) put(path.join(scriptsDir(root), f), fs.readFileSync(path.join(BRIDGE_SRC, f)));
  const payloadDir = path.join(tmp, label, 'payload');
  for (const f of fs.readdirSync(HOOKS_SRC)) if (f !== '__pycache__') put(path.join(payloadDir, 'policy', 'hooks', f), fs.readFileSync(path.join(HOOKS_SRC, f)));
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
const claudeSettings = (root) => path.join(root, '_agent', 'claude', 'settings.json');
function allFiles(root) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  walk(root);
  return out;
}

test('어댑터 단계: 다리가 놓여 있어도 훅 설정은 다리가 없을 때와 바이트까지 같다 — 클로드 settings.json · 코덱스 hooks.json', async () => {
  const withB = makeAdaptersCtx('with', { withBridge: true });
  const without = makeAdaptersCtx('none', { withBridge: false });
  const bridgeBefore = [BRIDGE, BRIDGE_TEST].map((f) => sha(fs.readFileSync(path.join(scriptsDir(withB.root), f))));
  await adapters.run(withB);
  await adapters.run(without);

  const norm = (ctx, file) => fs.readFileSync(file, 'utf8').split(JSON.stringify(ctx.root).slice(1, -1)).join('<ROOT>').split(ctx.root).join('<ROOT>');
  const settingsA = norm(withB, claudeSettings(withB.root));
  assert.equal(settingsA, norm(without, claudeSettings(without.root)), '클로드 settings.json 이 달라졌다');
  const hooksJson = (root) => allFiles(path.join(root, '_agent')).filter((f) => path.basename(f) === 'hooks.json');
  const codexA = hooksJson(withB.root);
  const codexB = hooksJson(without.root);
  assert.ok(codexA.length >= 1, '코덱스 hooks.json 이 있다');
  assert.deepEqual(codexA.map((f) => path.relative(withB.root, f)), codexB.map((f) => path.relative(without.root, f)));
  for (let i = 0; i < codexA.length; i += 1) assert.equal(norm(withB, codexA[i]), norm(without, codexB[i]), `코덱스 ${path.relative(withB.root, codexA[i])} 이 달라졌다`);

  // 등록된 훅의 수는 지금까지와 같다(클로드: 막는 훅 둘 · 세션 시작 둘 · 끝날 때 하나).
  const hooks = JSON.parse(fs.readFileSync(claudeSettings(withB.root), 'utf8')).hooks;
  assert.deepEqual({ pre: hooks.PreToolUse.length, start: hooks.SessionStart.length, stop: hooks.Stop.length }, { pre: 2, start: 2, stop: 1 });

  // 다리 이름은 그 두 파일 말고는 영혼 폴더 어디에도 없다(설정 · 등록부 · 기록 파일 전부). 어댑터는 다리 파일을 건드리지도 않는다.
  for (const file of allFiles(withB.root)) {
    if (path.dirname(file) === scriptsDir(withB.root) && path.basename(file).startsWith('agy-hook-bridge')) continue;
    assert.equal(fs.readFileSync(file).includes('agy-hook-bridge'), false, `${path.relative(withB.root, file)} 에 다리 이름이 있다`);
  }
  assert.deepEqual([BRIDGE, BRIDGE_TEST].map((f) => sha(fs.readFileSync(path.join(scriptsDir(withB.root), f)))), bridgeBefore);
  assert.equal(without.logs.some((l) => l.includes('agy-hook-bridge')), false, '어댑터는 다리를 찾지도 않는다(없다고 알리지도 않는다)');
  // 설치기는 Antigravity 의 설정 폴더를 만들지 않는다(영혼 폴더 안에도).
  assert.equal(allFiles(withB.root).some((f) => /[\\/]\.gemini[\\/]/.test(f)), false);
});

test('어댑터 코드는 다리를 모른다 — 놓을 파일 목록 · 등록하는 훅 목록 · 이름으로 알아보는 목록이 2.0.66 그대로', () => {
  assert.deepEqual(adapters.HOOK_SCRIPTS, ['block-blanket-kill.ps1', 'guard-iris-path.py', 'bg-leftover-guard.py']);
  assert.deepEqual(adapters.HOOK_EXTRAS, ['block-blanket-kill.test.py', 'guard-iris-path.test.py', 'bg-leftover-guard.test.py']);
  const src = fs.readFileSync(path.join(REPO, 'installer', 'setup', 'adapters.mjs'), 'utf8');
  assert.equal(src.includes('agy-hook-bridge'), false, 'adapters.mjs 에 다리 이름이 없다(주석 포함)');
  assert.doesNotMatch(/NAME_MATCHED_HOOKS\s*=\s*[^;]*;/.exec(src)?.[0] ?? 'agy', /agy/);
  // 설치기 전체에서 Antigravity 의 설정 폴더 이름은 0건이다.
  for (const rel of ['installer/setup/adapters.mjs', 'installer/setup/unpack.mjs', 'installer/server.mjs', 'installer/lib/agylock.mjs', 'installer/lib/online.mjs', 'installer/uninstall.ps1', 'updater/agents.mjs', 'updater/apply.mjs']) {
    assert.equal(fs.readFileSync(path.join(REPO, rel), 'utf8').includes('.gemini'), false, rel);
  }
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
  for (const [dir, names] of [[BRIDGE_SRC, [BRIDGE, BRIDGE_TEST]], [HOOKS_SRC, ['guard-iris-path.py', 'block-blanket-kill.ps1']]]) {
    for (const f of names) if (!drop.includes(f)) fs.copyFileSync(path.join(dir, f), path.join(scripts, f));
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
