import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createDarwinUserEnv, renderPathBlock, upsertBlock, removeBlock, renderLaunchAgent, BLOCK_BEGIN, BLOCK_END,
} from '../installer/lib/userenv-darwin.mjs';

// macOS 사용자 환경(docs/설계-macOS.md D-M08·D-M09). 홈 폴더는 늘 임시 폴더 — 진짜 ~/.zprofile 은 건드리지 않는다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-userenv-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const mkHome = (name) => { const h = path.join(tmp, name); fs.mkdirSync(h, { recursive: true }); return h; };
const SHIMS = '/Users/a b/IRIS/_agent/shared/shims';

test('덩어리 글자: 표지 두 줄 사이, 공백 경로는 따옴표, PATH 가 이미 있으면 다시 넣지 않는다', () => {
  const b = renderPathBlock(SHIMS);
  assert.ok(b.startsWith(`${BLOCK_BEGIN}\n`) && b.endsWith(BLOCK_END));
  assert.ok(b.includes(`case ":$PATH:" in *":${SHIMS}:"*) ;; *) export PATH="${SHIMS}:$PATH" ;; esac`));
  assert.ok([...b].every((c) => c.charCodeAt(0) < 0x80), 'ASCII');
  assert.match(renderPathBlock('/x/$HOME/"q"'), /\/x\/\\\$HOME\/\\"q\\"/, '$·" 는 막는다');
});

test('upsert/remove: 덩어리 밖은 한 글자도 바꾸지 않고, 두 번 넣어도 하나', () => {
  const user = '# my stuff\nexport FOO=1\n';
  const b = renderPathBlock(SHIMS);
  const once = upsertBlock(user, b);
  assert.equal(once.changed, true);
  assert.ok(once.text.startsWith(user));
  const twice = upsertBlock(once.text, b);
  assert.equal(twice.changed, false);
  const moved = upsertBlock(once.text, renderPathBlock('/other/shims'));
  assert.equal(moved.changed, true);
  assert.equal(moved.text.split(BLOCK_BEGIN).length, 2, '바뀐 경로는 제자리 교체');
  assert.equal(removeBlock(once.text).text, user, '지우면 원래 글 그대로');
  assert.equal(removeBlock(user).changed, false);
  assert.equal(upsertBlock('', b).text, `${b}\n`);
});

test('addUserPath: .zprofile 은 만들고, .bash_profile 은 있을 때만, 권한은 그대로', async () => {
  const home = mkHome('add');
  const env = createDarwinUserEnv({ homedir: home });
  const r1 = await env.addUserPath(SHIMS);
  assert.equal(r1.changed, true);
  assert.deepEqual(r1.files, [path.join(home, '.zprofile')]);
  assert.ok(fs.readFileSync(path.join(home, '.zprofile'), 'utf8').includes(SHIMS));
  assert.ok(!fs.existsSync(path.join(home, '.bash_profile')), 'bash 프로필을 새로 만들지 않는다');

  fs.writeFileSync(path.join(home, '.bash_profile'), 'export X=1\n', { mode: 0o600 });
  const r2 = await env.addUserPath(SHIMS);
  assert.equal(r2.changed, true, 'bash 프로필에만 새로 넣었다');
  assert.equal(fs.statSync(path.join(home, '.bash_profile')).mode & 0o777, 0o600);
  assert.equal((await env.addUserPath(SHIMS)).changed, false, '세 번째는 변경 0');
});

test('addUserPath: 심볼릭 링크 프로필은 링크를 그대로 두고 대상에 쓴다', { skip: process.platform === 'win32' && '링크 권한' }, async () => {
  const home = mkHome('link');
  const real = path.join(home, 'dotfiles-zprofile');
  fs.writeFileSync(real, 'export A=1\n');
  fs.symlinkSync(real, path.join(home, '.zprofile'));
  await createDarwinUserEnv({ homedir: home }).addUserPath(SHIMS);
  assert.ok(fs.lstatSync(path.join(home, '.zprofile')).isSymbolicLink());
  assert.ok(fs.readFileSync(real, 'utf8').includes(BLOCK_BEGIN));
});

test('removeUserPath: 덩어리만 빼고 사용자 줄은 남긴다', async () => {
  const home = mkHome('remove');
  fs.writeFileSync(path.join(home, '.zprofile'), 'export KEEP=1\n');
  const env = createDarwinUserEnv({ homedir: home });
  await env.addUserPath(SHIMS);
  const r = await env.removeUserPath();
  assert.equal(r.changed, true);
  assert.equal(fs.readFileSync(path.join(home, '.zprofile'), 'utf8'), 'export KEEP=1\n');
});

test('zsh 가 실제로 그 덩어리를 읽으면 심 폴더가 PATH 맨 앞에 한 번만 온다', { skip: (process.platform !== 'darwin' || !fs.existsSync('/bin/zsh')) && 'macOS zsh 전용' }, async () => {
  const home = mkHome('zsh');
  await createDarwinUserEnv({ homedir: home }).addUserPath(SHIMS);
  const r = spawnSync('/bin/zsh', ['-c', 'source "$HOME/.zprofile"; source "$HOME/.zprofile"; print -r -- "$PATH"'], {
    env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${SHIMS}:/usr/bin:/bin`);
});

test('전역 변수는 걸지 않는다(D-M08) — 영수증 previous 가 비게 null', async () => {
  const env = createDarwinUserEnv({ homedir: mkHome('vars') });
  assert.deepEqual(await env.setUserEnv('CLAUDE_CONFIG_DIR', '/x'), { changed: false, previous: null, scope: 'shims' });
});

test('setRunKey: LaunchAgent plist 를 쓰고, 같으면 다시 쓰지 않고, removeRunKey 로 지운다', async () => {
  const home = mkHome('agent');
  const env = createDarwinUserEnv({ homedir: home });
  const args = ['/Users/a b/IRIS/_agent/shared/tools/node/bin/node', '/Users/a b/IRIS/_agent/shared/shims/relay-ensure.mjs'];
  const r1 = await env.setRunKey('IRIS relay', args);
  assert.equal(r1.changed, true);
  const plist = fs.readFileSync(env.agentPlist, 'utf8');
  assert.equal(env.agentPlist, path.join(home, 'Library', 'LaunchAgents', 'com.iris-workspace.relay.plist'));
  for (const a of args) assert.ok(plist.includes(`<string>${a}</string>`));
  assert.ok(plist.includes('<key>AbandonProcessGroup</key><true/>'), '떼어 낸 중계기를 launchd 가 정리하지 않게');
  assert.equal((await env.setRunKey('IRIS relay', args)).changed, false);
  if (process.platform === 'darwin') {
    const lint = spawnSync('/usr/bin/plutil', ['-lint', env.agentPlist], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
  assert.deepEqual(await env.removeRunKey(), { removed: true });
  assert.ok(!fs.existsSync(env.agentPlist));
});

test('plist 글자는 & < > 를 막는다', () => {
  assert.ok(renderLaunchAgent(['/a&b/<c>']).includes('<string>/a&amp;b/&lt;c&gt;</string>'));
});
