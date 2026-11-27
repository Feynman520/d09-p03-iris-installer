// 훅 등록의 "우리 훅 알아보기" 시험(2.0.65).
//
// 고친 것: 훅 인식이 `ps1 · py · cjs · js` 만 알아봐서 `.mjs` 스크립트를 부르는 훅은 업데이트 때마다
// 되풀이해 더해질 수 있었다. 그리고 파일 이름의 부분 글자로 "우리 훅"을 가려, 그 사람이 따로 건
// 같은 이름의 훅(`status.mjs` 처럼 흔한 이름)을 우리 것으로 잘못 볼 수 있었다.
//
// 지키는 것:
//   · 2.0.64 까지의 훅 넷(일괄 종료 막기 · 경로 보호 · 신선도 점검 · 남은 배경 작업)은 **지금까지와 똑같이** 다룬다
//     — 파일 이름으로 알아보고, 그 사람이 자기 사본으로 돌려 둔 것도 "이미 있음"으로 존중한다.
//   · 그 뒤에 더하는 훅은 IRIS 가 놓은 경로일 때만 우리 것이다.
//   · 같은 설정에 몇 번을 되풀이 적용해도 훅은 한 번씩만 들어간다. 그 사람 훅은 한 글자도 바뀌지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as adapters from '../installer/setup/adapters.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_SRC = path.join(REPO, 'payload-src', 'tools', 'iris-auth');
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-hooks-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const ROOT = 'C:\\Soul';
const TOOLS = path.win32.join(ROOT, '_agent', 'shared', 'tools');
const SCRIPTS = path.win32.join(ROOT, '_agent', 'claude', 'scripts');
const NODE = path.win32.join(TOOLS, 'node', 'node.exe');
const OURS = path.win32.join(TOOLS, 'some-part', 'status.mjs');

const clone = (v) => JSON.parse(JSON.stringify(v));
const apply = (data, groups, root = ROOT) => { const added = []; adapters.mergeHooks(data, groups, added, 'hooks.', root); return added; };
const commands = (data, event) => (data.hooks?.[event] ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command));

// 새 꼴의 훅 하나(.mjs 스크립트, 파워셸, 시간 제한 10초).
function mjsGroups(script = OURS, { timeout = 10 } = {}) {
  return {
    SessionStart: [{
      matcher: 'startup|resume|clear|compact',
      hooks: [{ type: 'command', command: `& "${NODE}" "${script}" --hook; exit $LASTEXITCODE`, shell: 'powershell', timeout }],
    }],
  };
}

test('.mjs 훅: 같은 설정에 세 번 적용해도 한 번만 들어간다', () => {
  const data = {};
  const first = apply(data, mjsGroups());
  assert.deepEqual(first, ['hooks.SessionStart[startup|resume|clear|compact]']);
  const after1 = clone(data);
  assert.deepEqual(apply(data, mjsGroups()), [], '두 번째 적용은 아무것도 더하지 않는다');
  assert.deepEqual(apply(data, mjsGroups()), [], '세 번째 적용도 마찬가지');
  assert.deepEqual(data, after1, '세 번째 뒤의 설정이 첫 번째 뒤와 글자 하나 다르지 않다');
  assert.equal(data.hooks.SessionStart.length, 1);
});

test('.mjs 훅: 그 사람이 따로 건 같은 이름의 훅은 우리 것이 아니다 — 그대로 두고 우리 것을 한 번만 더한다', () => {
  const mine = [
    { matcher: 'startup', hooks: [{ type: 'command', command: 'node "D:\\my tools\\status.mjs" --hook', timeout: 99 }] },
    { hooks: [{ type: 'command', command: 'node status.mjs' }] },
    // 설치 폴더 안이라도 다른 부품 폴더의 같은 이름은 다른 파일이다.
    { hooks: [{ type: 'command', command: `node "${path.win32.join(TOOLS, 'other-part', 'status.mjs')}"` }] },
    // 이름에 같은 글자가 들어 있을 뿐인 것.
    { hooks: [{ type: 'command', command: `node "${path.win32.join(TOOLS, 'some-part', 'my-status.mjs')}"` }] },
  ];
  const data = { hooks: { SessionStart: clone(mine) } };
  for (let i = 0; i < 3; i += 1) apply(data, mjsGroups());
  assert.equal(data.hooks.SessionStart.length, mine.length + 1, '우리 훅이 딱 한 번 더해졌다');
  assert.deepEqual(data.hooks.SessionStart.slice(0, mine.length), mine, '그 사람 훅은 순서 · 명령 · 시간 제한까지 그대로');
  assert.equal(data.hooks.SessionStart[mine.length].hooks[0].command, mjsGroups().SessionStart[0].hooks[0].command);
});

test('.mjs 훅: 옛 판이 놓은 우리 훅은 새 꼴로 갈아 끼운다(명령 · 껍데기 · 시간 제한) — 늘어나지 않는다', () => {
  const oldCommand = `"${NODE}" "${path.win32.join(TOOLS, 'some-part', '1.0', 'status.mjs')}" --hook`; // 판 폴더가 달랐고 껍데기도 없던 옛 꼴
  const data = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: oldCommand, timeout: 60, statusMessage: '그대로 둘 글' }] }] } };
  const wanted = mjsGroups(path.win32.join(TOOLS, 'some-part', '1.1', 'status.mjs'), { timeout: 10 });
  const added = apply(data, wanted);
  assert.deepEqual(added, ['hooks.SessionStart[startup|resume|clear|compact](updated)']);
  assert.equal(data.hooks.SessionStart.length, 1);
  const h = data.hooks.SessionStart[0].hooks[0];
  assert.equal(h.command, wanted.SessionStart[0].hooks[0].command);
  assert.equal(h.shell, 'powershell');
  assert.equal(h.timeout, 10, '시간 제한도 새 값으로');
  assert.equal(h.statusMessage, '그대로 둘 글', '우리가 정하지 않은 칸은 건드리지 않는다');
  assert.equal(data.hooks.SessionStart[0].matcher, 'startup', '항목의 다른 칸도 그대로');
  assert.deepEqual(apply(data, wanted), [], '다시 적용하면 변경 0');
});

test('시간 제한만 달라도 우리 훅이면 고친다 — 그 사람 사본이면 그대로 둔다', () => {
  const groups = adapters.claudeHookGroups(ROOT);
  const data = {};
  apply(data, adapters.claudeHookGroups(ROOT)); // 넣은 항목은 그 객체 그대로 들어가므로, 적용할 때마다 새 묶음을 만든다(실제 흐름과 같다)
  const guard = data.hooks.PreToolUse.find((e) => JSON.stringify(e).includes('guard-iris-path.py'));
  const wantedTimeout = guard.hooks[0].timeout;
  guard.hooks[0].timeout = wantedTimeout + 50;
  const added = apply(data, adapters.claudeHookGroups(ROOT));
  assert.equal(added.length, 1);
  assert.match(added[0], /\(updated\)$/);
  assert.equal(guard.hooks[0].timeout, wantedTimeout);

  const theirs = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python "D:\\mine\\guard-iris-path.py"', timeout: 123 }] }] } };
  apply(theirs, { PreToolUse: [groups.PreToolUse[1]] });
  assert.equal(theirs.hooks.PreToolUse.length, 1);
  assert.equal(theirs.hooks.PreToolUse[0].hooks[0].timeout, 123, '그 사람 사본의 시간 제한은 건드리지 않는다');
  assert.equal(theirs.hooks.PreToolUse[0].hooks[0].command, 'python "D:\\mine\\guard-iris-path.py"');
});

test('옛 훅 넷: 지금까지처럼 파일 이름으로 알아본다 — 어떤 꼴로 이미 있어도 하나 더 만들지 않는다', () => {
  const claude = adapters.claudeHookGroups(ROOT);
  const cases = [
    ['PreToolUse', claude.PreToolUse[0], 'block-blanket-kill.ps1'],
    ['PreToolUse', claude.PreToolUse[1], 'guard-iris-path.py'],
    ['SessionStart', claude.SessionStart[0], 'check_fresh.py'],
    ['Stop', claude.Stop[0], 'bg-leftover-guard.py'],
  ];
  assert.deepEqual([...adapters.NAME_MATCHED_HOOKS].sort(), cases.map((c) => c[2]).sort(), '이름으로 알아보는 것은 이 넷뿐');
  for (const [event, entry, name] of cases) {
    const already = [
      `"${path.win32.join(TOOLS, 'python', 'python.exe')}" "${path.win32.join(SCRIPTS, name)}"`, // 옛 판 꼴(껍데기 없음)
      `python "D:\\mine\\${name}" --flag`,                                                        // 그 사람 사본
      `python D:/mine/${name.toUpperCase()}`,                                                      // 대소문자 · 슬래시가 달라도
      `powershell -File "D:\\x\\${name}"; exit $LASTEXITCODE`,                                    // 뒤에 ; 가 붙어도
    ];
    for (const command of already) {
      const data = { hooks: { [event]: [{ hooks: [{ type: 'command', command }] }] } };
      apply(data, { [event]: [entry] });
      assert.equal(data.hooks[event].length, 1, `${name}: "${command}" 이(가) 있으면 하나 더 만들지 않는다`);
    }
    const data = { hooks: { [event]: [{ hooks: [{ type: 'command', command: 'echo other.py' }] }] } };
    apply(data, { [event]: [entry] });
    assert.equal(data.hooks[event].length, 2, `${name}: 상관없는 훅 옆에는 더한다`);
  }
});

test('옛 훅 넷: 클로드 · 코덱스 설정에 세 번 적용해도 개수가 그대로다', () => {
  for (const groups of [adapters.claudeHookGroups(ROOT), adapters.codexHookConfig(ROOT).hooks]) {
    const data = {};
    apply(data, groups);
    const once = clone(data);
    apply(data, groups);
    apply(data, groups);
    assert.deepEqual(data, once);
    for (const [event, entries] of Object.entries(groups)) assert.equal(data.hooks[event].length, entries.length, event);
  }
});

test('옛 훅 넷: 옛 판 꼴(껍데기 없음)의 우리 훅은 새 명령 · 껍데기로 갈고, 그 사람 사본은 그대로', () => {
  const groups = adapters.claudeHookGroups(ROOT);
  const oldOurs = `"${path.win32.join(TOOLS, 'python', 'python.exe')}" "${path.win32.join(SCRIPTS, 'bg-leftover-guard.py')}"`;
  const data = { hooks: { Stop: [{ hooks: [{ type: 'command', command: oldOurs }] }] } };
  apply(data, { Stop: groups.Stop });
  assert.equal(data.hooks.Stop.length, 1);
  assert.equal(data.hooks.Stop[0].hooks[0].command, groups.Stop[0].hooks[0].command);
  assert.equal(data.hooks.Stop[0].hooks[0].shell, 'powershell');

  const theirs = '"C:\\mine\\python.exe" "C:\\mine\\check_fresh.py" --hook session';
  const d2 = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: theirs }] }] } };
  assert.deepEqual(apply(d2, { SessionStart: [groups.SessionStart[0]] }), []);
  assert.deepEqual(commands(d2, 'SessionStart'), [theirs]);
});

// 신선도 훅의 빈틈(2.0.65 에서 고침): 이 훅은 스크립트가 `_ontology`, 파이썬이 `shims` 에 있어 명령에 설치기 소유 폴더가 없다.
// 그래서 2.0.54 이전 판의 옛 꼴이 업데이트 때 갈리지 않았다. 전체 흐름의 재현 시험은 tests/setup-adapters.test.mjs 에 있다.
// 갈아 끼울 때는 명령 한 줄을 통째로 바꾼다. 그래서 "우리 줄"은 과거 설치기가 실제로 써 넣은 명령 **전체**와 글자가 같을 때뿐이다 —
// 그 사람이 뒤에 자기 명령을 붙였거나 인자 · 파이썬을 바꿨다면, 그것을 지우지 않도록 그대로 둔다(2026-11-27 코드 검토 "막아야 함").
const FRESH = path.win32.join(ROOT, '_ontology', 'check_fresh.py');
const SHIM = path.win32.join(ROOT, '_agent', 'shared', 'shims', 'python.cmd');
const V54 = `"${SHIM}" "${FRESH}" --hook session`;                         // 2.0.0 ~ 2.0.54 가 쓴 글자
const V55 = `& "${SHIM}" "${FRESH}" --hook session; exit $LASTEXITCODE`;   // 2.0.55 ~ 2.0.64 가 쓴 글자
// 클로드 설정에 쓰는 것과 같은 판정: 신선도 훅 = 과거 설치기가 쓴 두 꼴, 알림 훅 = 이 판을 만드는 동안 거쳐 온 꼴.
const NOTICE_SCRIPT = path.win32.join(TOOLS, 'iris-auth', 'status.mjs');
const claudeKnown = (w) => {
  const c = String(w?.command ?? '');
  if (c.includes(FRESH)) return adapters.historicalFreshnessCommands(ROOT);
  if (c.includes(NOTICE_SCRIPT)) return adapters.historicalAuthNoticeCommands(NODE, NOTICE_SCRIPT);
  return null;
};
// 이미 있는 명령 하나에 우리 훅 하나를 적용해 본다 → { 바뀌었나, 남은 명령들 }.
function applyOver(event, existingCommand, wantedEntry, opts) {
  const data = { hooks: { [event]: [{ matcher: 'startup', hooks: [{ type: 'command', command: existingCommand, timeout: 99 }] }] } };
  const added = [];
  adapters.mergeHooks(data, { [event]: [wantedEntry] }, added, 'hooks.', ROOT, opts);
  return { added, commands: commands(data, event), entry: data.hooks[event][0] };
}

test('matchesKnownCommand: 명령 전체가 알려진 꼴과 같을 때만 — 대소문자와 앞뒤 빈칸만 무시한다', () => {
  const forms = adapters.historicalFreshnessCommands(ROOT);
  assert.deepEqual(forms, [V54, V55], '이력에서 확인한 두 꼴(다른 꼴은 설치기가 쓴 적이 없다)');
  const yes = (c) => assert.equal(adapters.matchesKnownCommand(c, forms), true, c);
  const no = (c) => assert.equal(adapters.matchesKnownCommand(c, forms), false, c);
  yes(V54);
  yes(V55);
  yes(V54.toUpperCase());   // 경로의 대소문자만 다른 것
  yes(`  ${V54}  `);        // 앞뒤 빈칸
  no(`${V54}; echo mine`);  // 뒤에 자기 명령을 붙임
  no(`${V54} && my-tool.exe`);
  no(`${V55}; echo mine`);
  no(`echo before; ${V54}`);
  no(`${V54} --verbose`);
  no(`"${SHIM}" "${FRESH}" --hook other`);
  no(`"${SHIM}" "${FRESH}"`);
  no(`python "${FRESH}" --hook session`);
  no(`"${SHIM}" "${FRESH.split('\\').join('/')}" --hook session`); // 설치기는 이렇게 쓴 적이 없다
  no(`"${SHIM}" "D:\\OtherSoul\\_ontology\\check_fresh.py" --hook session`);
  no('');
  assert.equal(adapters.matchesKnownCommand(V54, []), false);
  assert.equal(adapters.matchesKnownCommand(V54, null), false);
});

test('신선도 훅: 옛 꼴 그대로면 갈아 끼우고, 그 사람이 손댄 줄은 한 글자도 바꾸지 않는다 — 중복도 더하지 않는다', () => {
  const wanted = () => adapters.claudeHookGroups(ROOT).SessionStart[0];
  const opts = { knownCommands: claudeKnown };

  // 옛 꼴 그대로(2.0.54 이전) → 지금 꼴로.
  const fixed = applyOver('SessionStart', V54, wanted(), opts);
  assert.deepEqual(fixed.added, ['hooks.SessionStart[startup|resume|clear|compact](updated)']);
  assert.deepEqual(fixed.commands, [V55], '지금 꼴 = 2.0.55 부터의 꼴');
  assert.equal(fixed.entry.hooks[0].shell, 'powershell');
  assert.equal(fixed.entry.hooks[0].timeout, 30, '시간 제한도 우리 값으로');
  // 지금 꼴 그대로 → 명령은 그대로(달랐던 시간 제한만 우리 값으로), 다시 적용하면 변경 0.
  const same = applyOver('SessionStart', V55, wanted(), opts);
  assert.deepEqual(same.commands, [V55]);

  // 그 사람이 손댄 줄 — 전부 그대로, 개수도 그대로(우리 신선도 훅을 옆에 더하지 않는다).
  const node = path.win32.join(TOOLS, 'node', 'node.exe');
  const touched = [
    `${V54}; echo mine`,
    `${V55}; echo mine`,
    `${V54} --quiet`,
    `python "${FRESH}" --hook session`,
    // 재검토에서 짚은 우회: 뒤에 붙인 그 사람 명령이 **설치 폴더의 프로그램**(동봉 node)을 쓴다.
    // 명령에 설치기 소유 폴더가 들어 있다는 것만으로 "우리 줄"이 되면 붙인 명령까지 지워진다.
    `${V54}; & "${node}" my.js`,
    `${V55}; & "${node}" "D:\\mine\\after.js"`,
    `& "${node}" my.js; ${V54}`,
    `"${path.win32.join(TOOLS, 'python', 'python.exe')}" "${FRESH}" --hook session; & "${node}" my.js`,
  ];
  for (const command of touched) {
    const r = applyOver('SessionStart', command, wanted(), opts);
    assert.deepEqual(r.added, [], `건드리면 안 된다: ${command}`);
    assert.deepEqual(r.commands, [command], `한 글자도 바꾸지 않고, 하나 더 더하지도 않는다: ${command}`);
    assert.equal(r.entry.hooks[0].timeout, 99, '시간 제한도 그대로');
    assert.equal(r.entry.hooks[0].shell, undefined);
  }
});

test('신선도 훅: 꼴 목록을 주지 않은 쪽(코덱스 훅 파일)에서도 소유 폴더 판정으로 넘어가지 않는다 — 지금 꼴과 같을 때 말고는 그대로', () => {
  const wanted = () => adapters.codexHookConfig(ROOT).hooks.SessionStart[0];
  const codexForm = `& "${SHIM}" "${FRESH}" --hook session`; // 코덱스 쪽은 2.0.0 부터 이 글자 하나다
  assert.equal(wanted().hooks[0].command, codexForm);
  const node = path.win32.join(TOOLS, 'node', 'node.exe');
  for (const command of [V54, `${codexForm}; & "${node}" my.js`, `${codexForm}; echo mine`]) {
    const r = applyOver('SessionStart', command, wanted());
    assert.deepEqual(r.added, [], command);
    assert.deepEqual(r.commands, [command], command);
    assert.equal(r.entry.hooks[0].timeout, 99);
  }
});

test('알림 훅도 전체 일치로만 갈아 끼운다 — 거쳐 온 꼴은 지금 꼴로, 그 사람이 손댄 줄은 그대로(중복 없음)', () => {
  const wanted = () => adapters.claudeHookGroups(ROOT).SessionStart[1];
  const opts = { knownCommands: claudeKnown };
  const now = wanted().hooks[0].command;
  const older = adapters.historicalAuthNoticeCommands(NODE, NOTICE_SCRIPT);
  assert.equal(older.length, 3);
  assert.ok(!older.includes(now), '옛 꼴 목록에 지금 꼴이 섞여 있지 않다');
  for (const command of older) {
    const r = applyOver('SessionStart', command, wanted(), opts);
    assert.deepEqual(r.commands, [now], `옛 꼴은 지금 꼴로: ${command.slice(0, 80)}…`);
    assert.equal(r.entry.hooks[0].timeout, adapters.AUTH_NOTICE_TIMEOUT_SEC, '바깥 시간 제한도 새 값으로');
    assert.equal(r.entry.hooks[0].shell, 'powershell');
  }
  // 지금 꼴인데 시간 제한만 옛 값 → 시간 제한만 고친다.
  const stale = applyOver('SessionStart', now, wanted(), opts);
  assert.deepEqual(stale.commands, [now]);
  assert.equal(stale.entry.hooks[0].timeout, adapters.AUTH_NOTICE_TIMEOUT_SEC);
  // 그 사람이 손댄 줄: 우리 스크립트를 부르지만 꼴이 다르다 → 그대로, 그리고 우리 것을 하나 더 더하지 않는다.
  for (const command of [
    `${older[0]}; echo mine`,
    `${now}; & "${NODE}" my.js`,
    `& "${NODE}" "${NOTICE_SCRIPT}" --hook`,
    `node "${NOTICE_SCRIPT}" --json`,
  ]) {
    const r = applyOver('SessionStart', command, wanted(), opts);
    assert.deepEqual(r.added, [], command);
    assert.deepEqual(r.commands, [command], command);
    assert.equal(r.entry.hooks[0].timeout, 99);
  }
});

test('isSameOwnedScript: 같은 부품의 같은 파일만 같다', () => {
  const same = (a, b, root = ROOT) => adapters.isSameOwnedScript(root, a, b);
  assert.equal(same(OURS, OURS), true);
  assert.equal(same(OURS.toUpperCase().split('\\').join('/'), OURS), true, '대소문자 · 슬래시 방향은 보지 않는다');
  assert.equal(same(path.win32.join(TOOLS, 'some-part', 'v2', 'status.mjs'), OURS), true, '같은 부품 안에서 판 폴더만 다른 것');
  assert.equal(same(path.win32.join(TOOLS, 'other-part', 'status.mjs'), OURS), false, '다른 부품의 같은 이름');
  assert.equal(same(path.win32.join(TOOLS, 'some-part', 'xstatus.mjs'), OURS), false, '이름이 다르다');
  assert.equal(same('D:\\mine\\status.mjs', OURS), false, '설치 폴더 밖');
  assert.equal(same(path.win32.join(ROOT, 'my', 'status.mjs'), OURS), false, '설치 폴더 안이라도 설치기 소유 폴더 밖');
  assert.equal(same('status.mjs', OURS), false);
  assert.equal(same('', OURS), false);
  assert.equal(same(OURS, OURS, null), true, '뿌리를 몰라도 글자가 같으면 같다');
  assert.equal(same(path.win32.join(TOOLS, 'some-part', 'v2', 'status.mjs'), OURS, null), false, '뿌리를 모르면 글자가 같을 때만');
});

test('빈칸이 든 설치 경로: 따옴표 안을 한 덩이로 읽어 되풀이 적용에도 한 번만', () => {
  const root = 'C:\\My Soul';
  const script = path.win32.join(root, '_agent', 'shared', 'tools', 'some-part', 'status.mjs');
  const groups = { SessionStart: [{ hooks: [{ type: 'command', command: `& "${path.win32.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe')}" "${script}" --hook; exit $LASTEXITCODE`, shell: 'powershell', timeout: 10 }] }] };
  const data = {};
  apply(data, groups, root);
  apply(data, groups, root);
  apply(data, groups, root);
  assert.equal(data.hooks.SessionStart.length, 1);
});

// ---------------------------------------------------------------------------
// 2.0.65 — 로그인 열쇠 알림 훅(클로드 SessionStart): 부품 iris-auth 의 `status.mjs --hook`
// ---------------------------------------------------------------------------

test('알림 훅: 클로드 SessionStart 에 따로 둔 항목 하나 — 파워셸 꼴 · 바깥 20초 · 코덱스에는 없다', () => {
  const groups = adapters.claudeHookGroups(ROOT);
  assert.equal(groups.SessionStart.length, 2);
  const h = groups.SessionStart[1].hooks[0];
  assert.equal(groups.SessionStart[1].hooks.length, 1);
  assert.equal(h.type, 'command');
  assert.equal(h.shell, 'powershell');
  assert.equal(h.timeout, 20);
  assert.equal(h.timeout, adapters.AUTH_NOTICE_TIMEOUT_SEC);
  // 알리기만 하는 훅: 파워셸이 뜨는 데 이미 10초를 넘겼으면 node 를 띄우지 않고, 띄웠으면 5초만 기다리고, 오류 글은 버리고,
  // 못 띄워도 조용히, 늘 0 으로 끝난다.
  // 실리는 글자 전체를 여기 적어 둔다(꼴이 바뀌면 이 시험이 먼저 알린다 — 실제로 도는지는 아래 시험들이 파워셸로 잰다).
  const body = (wait, outWait) => [
    '$p = New-Object System.Diagnostics.Process',
    `$p.StartInfo.FileName = '${NODE}'`,
    `$p.StartInfo.Arguments = '"${path.win32.join(TOOLS, 'iris-auth', 'status.mjs')}" --hook'`,
    '$p.StartInfo.UseShellExecute = $false',
    '$p.StartInfo.CreateNoWindow = $true',
    '$p.StartInfo.RedirectStandardOutput = $true',
    '$p.StartInfo.RedirectStandardError = $true',
    '$p.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8',
    '[void]$p.Start()',
    '$o = $p.StandardOutput.ReadToEndAsync()',
    '$e = $p.StandardError.ReadToEndAsync()',
    `if ($p.WaitForExit(${wait})) { if ($o.Wait(${outWait}) -and $o.Result) { $b = [Text.Encoding]::UTF8.GetBytes($o.Result); $s = [Console]::OpenStandardOutput(); $s.Write($b, 0, $b.Length); $s.Flush() } } else { try { $p.Kill() } catch { } }`,
  ].join('; ');
  const CA = "if (-not $env:NODE_USE_SYSTEM_CA) { $env:NODE_USE_SYSTEM_CA = '1' }";
  assert.equal(h.command, [
    CA,
    "try { $ErrorActionPreference = 'Stop'",
    '$t0 = [Diagnostics.Process]::GetCurrentProcess().StartTime',
    `if (([DateTime]::Now - $t0).TotalMilliseconds -lt 10000) { ${body(5000, 1000)} }`,
    '} catch { }; exit 0',
  ].join('; '));
  assert.ok(!/^"/.test(h.command), '파워셸에서 "a" "b" 꼴은 문법 오류');
  // 거쳐 온 꼴 목록의 셋째(안쪽 6초 · 시작 한도 없음)는 그때 실제로 만들어 내던 글자와 같아야 한다 — 다르면 그 꼴을 못 알아본다.
  assert.equal(adapters.historicalAuthNoticeCommands(NODE, path.win32.join(TOOLS, 'iris-auth', 'status.mjs'))[2],
    [CA, "try { $ErrorActionPreference = 'Stop'", body(6000, 2000), '} catch { }; exit 0'].join('; '));
  // 시간 셋: 바깥 20초 · 시작 한도 10초(바깥의 절반) · 안쪽 기다림 5초. 가장 늦은 경우(시작 한도 + 안쪽 + 출력 받기 1초)도
  // 바깥보다 적어도 3초 먼저 끝나야 한다 — 바깥이 먼저 끊으면 `exit 0` 에 닿지 못한다.
  assert.equal(adapters.AUTH_NOTICE_TIMEOUT_SEC, 20);
  assert.equal(adapters.AUTH_NOTICE_INNER_TIMEOUT_MS, 5000);
  assert.equal(adapters.AUTH_NOTICE_STARTUP_LIMIT_MS, adapters.AUTH_NOTICE_TIMEOUT_SEC * 1000 / 2);
  assert.ok(adapters.AUTH_NOTICE_STARTUP_LIMIT_MS + adapters.AUTH_NOTICE_INNER_TIMEOUT_MS + 1000 <= adapters.AUTH_NOTICE_TIMEOUT_SEC * 1000 - 3000);
  // 작은따옴표가 든 경로는 파워셸 글 안에서 '' 로 적는다.
  assert.ok(adapters.authNoticeHookCommand("C:\\it's\\node.exe", "C:\\it's\\status.mjs").includes(`$p.StartInfo.FileName = 'C:\\it''s\\node.exe'; $p.StartInfo.Arguments = '"C:\\it''s\\status.mjs" --hook';`));
  // 막는 훅 넷은 그대로 스크립트의 종료 코드를 넘긴다 — 차단(2)이 살아야 한다.
  for (const e of [...groups.PreToolUse, groups.SessionStart[0], ...groups.Stop]) {
    assert.ok(e.hooks[0].command.endsWith('; exit $LASTEXITCODE'), e.hooks[0].command);
    assert.ok(!e.hooks[0].command.includes('RedirectStandardError') && !e.hooks[0].command.includes('try {'), '막는 훅의 오류 글은 숨기지 않는다');
  }
  // 잠금표가 부품 자리를 바꾸면 그 자리를 따른다.
  const moved = adapters.claudeHookGroups(ROOT, { authDir: path.win32.join(TOOLS, 'iris-auth', '2.0') });
  assert.ok(moved.SessionStart[1].hooks[0].command.includes(path.win32.join(TOOLS, 'iris-auth', '2.0', 'status.mjs')));
  // 코덱스 훅 구성에는 넣지 않는다.
  const codex = adapters.codexHookConfig(ROOT).hooks;
  assert.equal(codex.SessionStart.length, 1);
  assert.ok(!JSON.stringify(codex).includes('status.mjs'));
  // Node 를 띄우지 않는 옛 훅들에는 인증서 줄을 붙이지 않는다(그 훅들의 명령은 지금까지와 글자가 같다).
  for (const e of [...groups.PreToolUse, groups.SessionStart[0], ...groups.Stop]) {
    assert.ok(!e.hooks[0].command.includes('NODE_USE_SYSTEM_CA'));
  }
});

// 훅 명령을 클로드코드가 하듯 파워셸로 실제로 돌린다. 사본을 임시 폴더에 놓고 **임시 홈**에서만 돈다
// (이 PC 의 진짜 상태 파일 · 로그인 파일은 읽지도 쓰지도 않는다). node 는 이 시험을 돌리는 node 다.
function makeAuthRoot(label, { drop = [] } = {}) {
  const base = path.join(tmp, label);
  const tool = path.join(base, 'tool');
  const home = path.join(base, 'home');
  fs.mkdirSync(tool, { recursive: true });
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'claude', 'secrets'), { recursive: true });
  for (const f of ['status.mjs', 'lib.mjs', 'longkey.mjs']) {
    if (!drop.includes(f)) fs.copyFileSync(path.join(AUTH_SRC, f), path.join(tool, f));
  }
  const env = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_USE_SYSTEM_CA', 'TEAMCLAUDE_CONFIG']) delete env[k];
  Object.assign(env, {
    USERPROFILE: home, HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    IRIS_LONGKEY_FILE: path.join(home, 'claude', 'secrets', 'iris-cli-token.json'),
    IRIS_AUTH_NOTIFY: '0',
  });
  return { tool, home, env, script: path.join(tool, 'status.mjs') };
}

function runHookCommand(command, env) {
  // 멈추지 않는지는 60초 한도로 본다(짧은 마감으로 재지 않는다 — PC 가 바쁠 때 코드 문제 없이 깨지지 않게).
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(r.error, undefined, `훅 명령이 끝나지 않았다: ${r.error?.message}`);
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

test('알림 훅: 알릴 것이 없으면 조용히 0 — 열쇠가 곧 끝나면 표준 출력 한 줄(표준 오류는 늘 비어 있다)', () => {
  const a = makeAuthRoot('run-quiet');
  const quiet = runHookCommand(adapters.authNoticeHookCommand(process.execPath, a.script), a.env);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.out, '');
  assert.equal(quiet.err, '');

  fs.writeFileSync(a.env.IRIS_LONGKEY_FILE, JSON.stringify({ token: 'T', expiresAt: Date.now() + 86400000 }));
  const due = runHookCommand(adapters.authNoticeHookCommand(process.execPath, a.script), a.env);
  assert.equal(due.code, 0);
  assert.equal(due.err, '');
  assert.match(due.out, /^\[IRIS 인증\] .*IRIS 1년 열쇠.*사용자에게 알릴 것\.\r?\n$/, '한글 알림 글이 글자 그대로 나온다(오류 글을 버리는 처리가 표준 출력을 건드리지 않는다)');
  assert.equal(due.out.trim().split(/\r?\n/).length, 1);
});

// 알림 훅이 새 PC 의 세션 시작 화면에 오류 한 줄을 남기면 안 된다(2026-11-27 결정).
// 실패의 종류와 상관없이: 종료 코드 0 · 표준 오류 비어 있음 · 표준 출력 비어 있음.
test('알림 훅: 어떤 실패에도 종료 코드 0 · 오류 글 없음 · 출력 없음 — 멈추지 않고 끝난다', () => {
  const blocks = (r, what) => {
    assert.equal(r.code, 0, `${what}: 종료 코드는 늘 0 (받은 값 ${r.code})`);
    assert.equal(r.err, '', `${what}: 표준 오류에 아무것도 내지 않는다`);
    assert.equal(r.out, '', `${what}: 세션에 끼어드는 글(표준 출력)을 내지 않는다`);
  };

  // ① 스크립트 파일이 없다(부품이 아직 안 놓였거나 지워졌다).
  const gone = makeAuthRoot('fail-missing', { drop: ['status.mjs'] });
  blocks(runHookCommand(adapters.authNoticeHookCommand(process.execPath, gone.script), gone.env), '스크립트 없음');

  // ② 불러오기 실패(옆의 lib.mjs 가 없다 / 문법이 깨졌다).
  const noLib = makeAuthRoot('fail-import', { drop: ['lib.mjs'] });
  blocks(runHookCommand(adapters.authNoticeHookCommand(process.execPath, noLib.script), noLib.env), 'lib.mjs 없음');
  const badLib = makeAuthRoot('fail-syntax');
  fs.writeFileSync(path.join(badLib.tool, 'lib.mjs'), 'export function collect( {');
  blocks(runHookCommand(adapters.authNoticeHookCommand(process.execPath, badLib.script), badLib.env), 'lib.mjs 문법 오류');
  // 스크립트가 막는 종료 코드(2)나 다른 값으로 끝나도, 오류 글을 내도 훅은 0 이고 조용하다.
  const loud = makeAuthRoot('fail-loud');
  fs.writeFileSync(loud.script, "process.stderr.write('boom\\n'); process.exit(2);\n");
  blocks(runHookCommand(adapters.authNoticeHookCommand(process.execPath, loud.script), loud.env), '스크립트가 2 로 끝남');

  // ③ 읽기 오류: 읽는 파일이 전부 깨져 있고, 상태 파일을 쓸 폴더도 없다 → 그래도 정상 종료(0).
  const junk = makeAuthRoot('fail-read');
  fs.mkdirSync(path.join(junk.home, '.config', 'x'), { recursive: true });
  fs.writeFileSync(path.join(junk.home, '.config', 'teamclaude.json'), '{ not json');
  fs.writeFileSync(path.join(junk.home, '.config', 'teamclaude.auth-health.json'), '\u0000\u0001');
  fs.writeFileSync(path.join(junk.home, '.config', 'iris-auth-status.json'), '[[[');
  fs.writeFileSync(path.join(junk.home, 'claude', '.credentials.json'), 'null');
  fs.writeFileSync(junk.env.IRIS_LONGKEY_FILE, '{"token":');
  blocks(runHookCommand(adapters.authNoticeHookCommand(process.execPath, junk.script), junk.env), '읽는 파일이 깨짐');
  const noDir = makeAuthRoot('fail-nodir');
  fs.rmSync(path.join(noDir.home, '.config'), { recursive: true, force: true });
  blocks(runHookCommand(adapters.authNoticeHookCommand(process.execPath, noDir.script), noDir.env), '상태 파일을 쓸 폴더가 없음');

  // ④ node 자체가 없다(런타임 부품이 빠졌다).
  const noNode = makeAuthRoot('fail-nonode');
  blocks(runHookCommand(adapters.authNoticeHookCommand(path.join(noNode.tool, 'no-such-node.exe'), noNode.script), noNode.env), 'node 없음');
});

// 2026-11-27 코드 검토 "막아야 함": node 가 바깥(클로드코드)의 훅 제한을 넘기면 바깥이 먼저 끊어 `exit 0` 에 닿지 못한다.
// 그래서 훅 명령이 스스로 안쪽 제한(5초)에서 그 node 하나만 끝내고 0 으로 마친다 — 바깥 제한(20초)보다 넉넉히 먼저.
// 실제 파워셸(윈도우 파워셸 5.1) + 오래 자는 가짜 도구로 잰다.
test('알림 훅: 도구가 오래 걸리면 안쪽 제한에서 그 프로그램만 끝내고 종료 코드 0 · 오류 글 없음 · 출력 없음 — 남는 프로세스 없음', async () => {
  const ver = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true });
  assert.equal(String(ver.stdout).trim(), '5', '`powershell` 은 윈도우 파워셸 5.1 이다(훅이 도는 바로 그 껍데기)');
  const a = makeAuthRoot('slow');
  const pidFile = path.join(a.tool, 'slow.pid');
  // 30초 동안 끝나지 않는 가짜 도구: 자기 번호를 적고, 출력을 조금 낸 뒤, 잠든다.
  fs.writeFileSync(a.script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdout.write('[IRIS 인증] 받다 만 글');\nprocess.stderr.write('slow tool\\n');\nsetTimeout(() => {}, 30000);\n`);
  const t0 = Date.now();
  const r = runHookCommand(adapters.authNoticeHookCommand(process.execPath, a.script), a.env);
  const elapsed = Date.now() - t0;
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, '', '제한을 넘겨 끊은 도구의 받다 만 출력은 내보내지 않는다');
  assert.ok(elapsed >= adapters.AUTH_NOTICE_INNER_TIMEOUT_MS - 500, `안쪽 제한만큼은 기다렸다(${elapsed}ms)`);
  // 바깥 제한(20초)보다 넉넉히 먼저 끝나야 한다: 안쪽 5초 + 파워셸이 뜨는 시간. 12초 안이면 바깥까지 8초가 남는다.
  assert.ok(elapsed < 12000, `바깥 제한(${adapters.AUTH_NOTICE_TIMEOUT_SEC}초)보다 넉넉히 먼저 끝나야 한다(${elapsed}ms)`);
  assert.ok(elapsed < adapters.AUTH_NOTICE_TIMEOUT_SEC * 1000);
  // 남은 프로세스 없음: 그 도구(node)가 살아 있지 않다. 끝나는 데 잠깐 걸릴 수 있어 최대 10초 기다려 본다.
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0, '가짜 도구가 실제로 떴다');
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 100 && alive(); i += 1) await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(), false, `끊긴 도구(pid ${pid})가 남아 있으면 안 된다`);
});

// 파워셸이 뜨는 데 이미 오래 걸린 PC: 안쪽 기다림까지 더하면 바깥 제한에 닿을 수 있다. 시작 한도를 넘겼으면 도구를 띄우지 않는다.
test('알림 훅: 시작이 한도보다 늦었으면 도구를 띄우지 않고 바로 0 으로 끝난다(알림 하나 때문에 더 늦어지지 않게)', () => {
  const a = makeAuthRoot('late-start');
  const mark = path.join(a.tool, 'started.txt');
  fs.writeFileSync(a.script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(mark)}, 'x');\nprocess.stdout.write('[IRIS 인증] 떴다\\n');\n`);
  // 시작 한도 0 = 어떤 PC 든 "이미 늦었다"(파워셸이 뜬 뒤로 흐른 시간은 늘 0 보다 크다).
  const late = runHookCommand(adapters.authNoticeHookCommand(process.execPath, a.script, { startupLimitMs: 0 }), a.env);
  assert.deepEqual([late.code, late.out, late.err], [0, '', '']);
  assert.ok(!fs.existsSync(mark), '도구를 띄우지 않았다');
  // 같은 도구, 보통의 한도 → 뜨고 한 줄이 그대로 나온다.
  const ok = runHookCommand(adapters.authNoticeHookCommand(process.execPath, a.script), a.env);
  assert.deepEqual([ok.code, ok.out, ok.err], [0, '[IRIS 인증] 떴다\n', '']);
  assert.ok(fs.existsSync(mark));
});

test('알림 훅: 경로에 빈칸 · 한글 · 작은따옴표가 있어도 인용이 깨지지 않는다(정상 · 스크립트 없음 · node 없음)', () => {
  const a = makeAuthRoot("한글 폴더 with space it's");
  fs.writeFileSync(a.env.IRIS_LONGKEY_FILE, JSON.stringify({ token: 'T', expiresAt: Date.now() + 86400000 }));
  const due = runHookCommand(adapters.authNoticeHookCommand(process.execPath, a.script), a.env);
  assert.equal(due.code, 0);
  assert.equal(due.err, '');
  assert.match(due.out, /^\[IRIS 인증\] .*IRIS 1년 열쇠.*사용자에게 알릴 것\.\r?\n$/);
  for (const [what, node, script] of [
    ['스크립트 없음', process.execPath, path.join(a.tool, '없는 파일.mjs')],
    ['node 없음', path.join(a.tool, '없는 node.exe'), a.script],
  ]) {
    const r = runHookCommand(adapters.authNoticeHookCommand(node, script), a.env);
    assert.deepEqual([r.code, r.out, r.err], [0, '', ''], what);
  }
});

test('알림 훅: 훅 방식(--hook)은 이 PC 의 파일만 읽는다 — 풍선 알림 · 네트워크 · 다른 프로그램 실행이 없어 시간 제한(10초) 안에 끝난다', () => {
  // 시간 초과 자체는 클로드코드가 끊는다(timeout 칸). 여기서는 오래 걸릴 일을 하지 않는다는 것을 원본 글자로 묶는다:
  // 풍선 알림(다른 프로그램을 띄움)은 --notify 를 줄 때만이고, 훅 명령은 --notify 를 주지 않는다.
  const src = fs.readFileSync(path.join(AUTH_SRC, 'status.mjs'), 'utf8');
  assert.match(src, /if \(argv\.includes\('--notify'\)\) \{[\s\S]*?windowsNotify\(/, '풍선 알림은 --notify 안에서만');
  assert.equal((src.match(/windowsNotify\(/g) ?? []).length, 2, 'windowsNotify 는 정의 한 번 + --notify 안의 호출 한 번뿐');
  assert.ok(!/\bfetch\(|node:https?|node:net\b/.test(src), '네트워크를 쓰지 않는다');
  assert.ok(!/\bfetch\(|node:https?|node:net\b|child_process/.test(fs.readFileSync(path.join(AUTH_SRC, 'lib.mjs'), 'utf8')));
  const cmd = adapters.claudeHookGroups(ROOT).SessionStart[1].hooks[0].command;
  assert.ok(cmd.includes('status.mjs" --hook\';') && !cmd.includes('--notify'));
});

test('알림 훅: NODE_USE_SYSTEM_CA 는 비어 있을 때만 1 로 채운다(사용자가 정한 값은 덮지 않는다)', () => {
  const a = makeAuthRoot('ca');
  const probe = path.join(a.tool, 'probe.mjs');
  fs.writeFileSync(probe, "process.stdout.write(`CA=${process.env.NODE_USE_SYSTEM_CA ?? ''}`);\n");
  const command = adapters.authNoticeHookCommand(process.execPath, probe);
  assert.equal(runHookCommand(command, a.env).out, 'CA=1', '없으면 채운다');
  assert.equal(runHookCommand(command, { ...a.env, NODE_USE_SYSTEM_CA: '' }).out, 'CA=1', '빈 값이어도 채운다');
  assert.equal(runHookCommand(command, { ...a.env, NODE_USE_SYSTEM_CA: '0' }).out, 'CA=0', '사용자가 정한 값은 그대로');
});
