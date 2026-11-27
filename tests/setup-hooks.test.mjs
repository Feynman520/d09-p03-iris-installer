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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as adapters from '../installer/setup/adapters.mjs';

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
