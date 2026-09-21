// 2.0.34 — 모듈 부품(messenger)은 slot 처럼 옆으로 옮기지 않는다(2026-09-21 사용자 실측: 업데이트 뒤 메신저 모듈 2개·제거 불가·헤더 느낌표).
//   ≤2.0.33: 풀기 단계가 `face\modules\messenger` 를 `.prev` 로 옮긴 뒤 installZip 이 새로 놓음 → Face 가 `.prev` 를 두 번째 모듈(맞지 않음)로
//   읽고, 이름 규칙 밖이라 제거 창구가 거부, 새 사본은 state(로그인) 없이 시작.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { salvageModulePrev } from '../installer/setup/unpack.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mk = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `iris-unpack-module-${name}-`)); return d; };
const touch = (f, body = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

test('salvageModulePrev: .prev 의 state 를 현재 사본에 물려주고 .prev 폴더들은 modules-prev 로 옮긴다(무삭제)', () => {
  const face = mk('salvage');
  const mods = path.join(face, 'modules');
  touch(path.join(mods, 'messenger', 'module.json'), '{"name":"messenger"}');            // 새 사본(state 없음 — 로그인 날아간 상태)
  touch(path.join(mods, 'messenger.prev', 'module.json'), '{"name":"messenger"}');
  touch(path.join(mods, 'messenger.prev', 'state', 'login.json'), '{"me":"old"}');        // 옛 사본의 로그인
  touch(path.join(mods, 'messenger.prev-2', 'module.json'), '{"name":"messenger"}');
  touch(path.join(mods, 'other', 'module.json'), '{"name":"other"}');
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(mods, 'messenger.prev'), now, now);           // 가장 최근 .prev
  fs.utimesSync(path.join(mods, 'messenger.prev-2'), now - 1000, now - 1000);
  const r = salvageModulePrev(fs, mods, 'messenger');
  assert.equal(r.stateRestored, true);
  assert.deepEqual([...r.moved].sort(), ['messenger.prev', 'messenger.prev-2']);
  assert.equal(fs.readFileSync(path.join(mods, 'messenger', 'state', 'login.json'), 'utf8'), '{"me":"old"}', '로그인 state 가 현재 사본으로');
  assert.deepEqual(fs.readdirSync(mods).sort(), ['messenger', 'other'], 'modules 안에는 규칙 안 폴더만 남는다');
  assert.ok(fs.existsSync(path.join(face, 'modules-prev', 'messenger.prev', 'module.json')), '.prev 는 지우지 않고 modules-prev 로');
  assert.ok(fs.existsSync(path.join(face, 'modules-prev', 'messenger.prev-2', 'module.json')));
  fs.rmSync(face, { recursive: true, force: true });
});

test('salvageModulePrev: 현재 사본에 state 가 이미 있으면(다시 로그인함) 덮어쓰지 않는다', () => {
  const face = mk('keep');
  const mods = path.join(face, 'modules');
  touch(path.join(mods, 'messenger', 'state', 'login.json'), '{"me":"new"}');
  touch(path.join(mods, 'messenger.prev', 'state', 'login.json'), '{"me":"old"}');
  const r = salvageModulePrev(fs, mods, 'messenger');
  assert.equal(r.stateRestored, false);
  assert.equal(fs.readFileSync(path.join(mods, 'messenger', 'state', 'login.json'), 'utf8'), '{"me":"new"}');
  assert.ok(fs.existsSync(path.join(face, 'modules-prev', 'messenger.prev', 'state', 'login.json')), '옛 state 는 modules-prev 안에 그대로');
  assert.deepEqual(fs.readdirSync(mods), ['messenger']);
  fs.rmSync(face, { recursive: true, force: true });
});

test('salvageModulePrev: .prev 가 없으면 아무것도 하지 않는다 / modules 폴더가 없어도 던지지 않는다 / 이름이 다른 모듈의 .prev 는 건드리지 않는다', () => {
  const face = mk('none');
  const mods = path.join(face, 'modules');
  touch(path.join(mods, 'messenger', 'module.json'));
  touch(path.join(mods, 'other.prev', 'module.json'));
  const r = salvageModulePrev(fs, mods, 'messenger');
  assert.deepEqual(r, { moved: [], stateRestored: false });
  assert.deepEqual(fs.readdirSync(mods).sort(), ['messenger', 'other.prev']);
  assert.deepEqual(salvageModulePrev(fs, path.join(face, 'nope'), 'messenger'), { moved: [], stateRestored: false });
  fs.rmSync(face, { recursive: true, force: true });
});

test('unpack/install: 모듈 부품은 옆으로 옮기지 않고(setAside 없음), 실패 때 restorePart 로 옛 모듈을 지우지 않는다 (원문 회귀 검사)', () => {
  const unpackSrc = fs.readFileSync(path.join(REPO, 'installer', 'setup', 'unpack.mjs'), 'utf8');
  assert.match(unpackSrc, /if \(layout\.kind === 'module'\) moved = null;\s*\n\s*else if \(layout\.mode !== 'merge'\) moved = await setAside\(slot\);/, '모듈은 setAside 앞에서 갈라진다');
  assert.match(unpackSrc, /layout\.kind === 'module'\) \? \{ restored: false \} : restorePart\(slot, moved\)/, '모듈 실패 때 restorePart 를 부르지 않는다');
  assert.match(unpackSrc, /salvageModulePrev\(fs, modulesDir, layout\.moduleName\)/, '옛 .prev 를 거둔 뒤 installZip');
  const installSrc = fs.readFileSync(path.join(REPO, 'installer', 'lib', 'install.mjs'), 'utf8');
  assert.match(installSrc, /const moved = layout\.kind === 'module' \? null : preserveAside\(slot\);/);
  assert.match(installSrc, /layout\.kind === 'module' \? \{ clearedPartial: false, restored: false \} : restorePart\(slot, moved\)/);
  const gate = fs.readFileSync(path.join(REPO, 'verify', 'upgrade.mjs'), 'utf8');
  assert.match(gate, /③ⓗ face\\\\modules 에 이름 규칙 밖 폴더/, '업그레이드 게이트가 modules\\ 의 .prev 잔재를 잡는다');
});
