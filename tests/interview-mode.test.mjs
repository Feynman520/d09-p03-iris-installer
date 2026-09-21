// 2.0.35 — 설치기는 폴더 구조를 묻지 않고(IRIS 폴더만), 첫 세션이 인터뷰로 R/D/P 를 만든다. 심은 중계기를 스스로 띄운다.
// (2026-09-21 사용자 결정. "잘 되는 패키지를 고장 내면 안 된다" — 업데이트 PC 의 옛 경로는 그대로 두고 입력만 바꾼다.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDecisions } from '../installer/lib/structure-rules.mjs';
import * as structure from '../installer/setup/structure.mjs';
import { firstMessageText, rootHasRoles } from '../installer/setup/handoff.mjs';
import { writeShims, agentShim, relayEnsureMjs, shimsDir } from '../installer/lib/shims.mjs';
import { setRunKey, removeRunKey, RUN_KEY } from '../installer/lib/userpath.mjs';

const mk = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `iris-interview-${n}-`));

test('buildDecisions({interview:true}): 만들 폴더 0개, R 까지 전부 미룸, 영어 이름 미정 0', () => {
  const d = buildDecisions({ interview: true, now: new Date('2026-09-21T00:00:00Z') });
  assert.equal(d.interview, true);
  assert.equal(d.later, false);
  assert.deepEqual(d.nodes, []);
  assert.deepEqual(d.deferred, ['R', 'D', 'P', 'S', 'T', 'tags']);
  assert.deepEqual(d.nameEnMissing, []);
  // 옛 경로는 그대로다
  const old = buildDecisions({ later: true });
  assert.equal(old.interview, undefined);
  assert.ok(old.nodes.length >= 1);
});

test('structure 단계: interview 결정이면 아무 폴더도 만들지 않고 정상 완료(recorded.interview)', async () => {
  const root = mk('structure');
  const before = fs.readdirSync(root);
  const { recorded } = await structure.run({ root, decisions: buildDecisions({ interview: true }), log: () => {} });
  assert.equal(recorded.interview, true);
  assert.deepEqual(recorded.created, []);
  assert.deepEqual(recorded.conflicts, []);
  assert.deepEqual(fs.readdirSync(root), before, '루트에 새 폴더가 생기면 안 된다');
  // 옛 경로(빈 목록 + later 아님)는 여전히 E-STRUCTURE 로 막는다 — 실수로 폴더 0개 설치가 되지 않게
  await assert.rejects(structure.run({ root, decisions: { nodes: [], later: false }, log: () => {} }), /E-STRUCTURE|만들 폴더 목록/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('firstMessageText: 인터뷰면 대본을 읽고 바로 시작하라는 문장, 아니면 기존 문장 그대로', () => {
  const a = firstMessageText({ interview: true });
  assert.match(a, /interview\.md/);
  assert.match(a, /역할/);
  assert.match(a, /선택형 질문 도구는 쓰지/);
  assert.doesNotMatch(a, /무엇부터 할지/);
  const b = firstMessageText({ nameEnMissing: ['R01-x'] });
  assert.match(b, /무엇부터 할지/);
  assert.doesNotMatch(b, /interview\.md/);
});

test('rootHasRoles: 루트 바로 아래 R##- 폴더가 있을 때만 true', () => {
  const root = mk('roles');
  assert.equal(rootHasRoles(root), false);
  fs.mkdirSync(path.join(root, '_agent'));
  assert.equal(rootHasRoles(root), false);
  fs.mkdirSync(path.join(root, 'R01-교사(Teacher)'));
  assert.equal(rootHasRoles(root), true);
  assert.equal(rootHasRoles(path.join(root, 'nope')), false, '없는 폴더는 false(던지지 않음)');
  fs.rmSync(root, { recursive: true, force: true });
});

test('shims: 에이전트 심은 중계기 확인 줄을 갖고, relay-ensure 3종이 ASCII 로 함께 놓인다', () => {
  const root = mk('shims');
  const r = writeShims(root, ['claude', 'codex']);
  const dir = shimsDir(root);
  for (const f of ['relay-ensure.cmd', 'relay-ensure.mjs', 'relay-autostart.vbs', 'claude.cmd', 'codex.cmd']) {
    const buf = fs.readFileSync(path.join(dir, f));
    assert.ok(buf.every((b) => b < 0x80), `${f} 는 ASCII 여야 한다`);
    assert.ok(r.written.includes(path.join(dir, f)), `${f} 가 written 에 있다`);
  }
  const claude = fs.readFileSync(path.join(dir, 'claude.cmd'), 'ascii');
  assert.ok(claude.includes('if exist "%~dp0relay-ensure.cmd" call "%~dp0relay-ensure.cmd"'), '심이 중계기 확인을 먼저 한다');
  assert.ok(claude.indexOf('relay-ensure.cmd') < claude.indexOf('claude\\claude.cmd'), '중계기 확인이 CLI 호출보다 앞');
  assert.equal(agentShim('codex').includes('HTTPS_PROXY=http://127.0.0.1:3456'), true, '코덱스 프록시 줄은 그대로');
  // 두 번째 실행은 아무것도 바꾸지 않는다
  assert.deepEqual(writeShims(root, ['claude', 'codex']).changed, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('relay-ensure.mjs: 포트가 살아 있으면 곧장 0, 죽어 있고 관리 스크립트가 없으면 한 줄 알리고 0(막지 않음)', async () => {
  const root = mk('ensure');
  writeShims(root, ['claude']);
  const script = path.join(shimsDir(root), 'relay-ensure.mjs');
  assert.equal(fs.readFileSync(script, 'utf8'), relayEnsureMjs());
  // 살아 있는 포트
  const srv = net.createServer(() => {}); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const t0 = Date.now();
  const up = spawnSync(process.execPath, [script], { env: { ...process.env, IRIS_RELAY_PORT: String(port) }, encoding: 'utf8', timeout: 20000 });
  srv.close();
  assert.equal(up.status, 0, up.stderr);
  assert.ok(Date.now() - t0 < 5000, '살아 있으면 기다리지 않는다');
  assert.equal(up.stderr.trim(), '');
  // 죽은 포트 + 관리 스크립트 없음(연습 루트)
  const dead = net.createServer(() => {}); await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port; await new Promise((r) => dead.close(r));
  const down = spawnSync(process.execPath, [script], { env: { ...process.env, IRIS_RELAY_PORT: String(deadPort), IRIS_RELAY_WAIT_MS: '300' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(down.status, 0, '실패해도 종료 코드 0(에이전트 실행을 막지 않는다)');
  assert.match(down.stderr, /relay helper missing/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('userpath.setRunKey: 같은 값이면 변경 없음, 다르면 reg add(가짜 deps, 진짜 레지스트리 무접촉)', async () => {
  const calls = [];
  const deps = {
    runQuery: async (name) => ({ code: 0, out: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    ${name}    REG_SZ    wscript.exe //nologo "C:\\X\\relay-autostart.vbs"\r\n`, err: '' }),
    runAdd: async (name, value) => { calls.push([name, value]); return { code: 0, out: '', err: '' }; },
    runDelete: async () => ({ code: 0, out: '', err: '' }),
  };
  const same = await setRunKey('IRIS relay', 'wscript.exe //nologo "C:\\X\\relay-autostart.vbs"', deps);
  assert.deepEqual(same, { changed: false, previous: 'wscript.exe //nologo "C:\\X\\relay-autostart.vbs"' });
  assert.deepEqual(calls, []);
  const diff = await setRunKey('IRIS relay', 'wscript.exe //nologo "D:\\Y\\relay-autostart.vbs"', deps);
  assert.equal(diff.changed, true);
  assert.deepEqual(calls, [['IRIS relay', 'wscript.exe //nologo "D:\\Y\\relay-autostart.vbs"']]);
  const missing = await setRunKey('IRIS relay', 'x', { ...deps, runQuery: async () => ({ code: 1, out: '', err: 'not found' }) });
  assert.deepEqual(missing, { changed: true, previous: null });
  assert.deepEqual(await removeRunKey('IRIS relay', deps), { removed: true });
  assert.match(RUN_KEY, /CurrentVersion\\Run$/);
});
