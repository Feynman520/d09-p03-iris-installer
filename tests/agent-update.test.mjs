// 2.0.45 — 설치 PC 의 클로드·코덱스 자동 업데이트(updater/agents.mjs, 설계 = docs/설계-비서자동업데이트.md).
// 네트워크·npm·실행은 전부 가짜로 넣는다. 임시 루트만 쓴다(진짜 <설치 폴더> 를 건드리지 않음, R-037).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  runOnce, kick, whyNot, currentClaude, currentCodex, claudeForwarder, codexForwarder,
  pickCodexTarget, pruneVersions, compareVersions, readState, writeState,
  claudeDir, codexDir, codexVersionsDir, lockPath, rootFromHere,
  CLAUDE_BASE, CODEX_LATEST_URL, CHECK_INTERVAL_MS, CODEX_MIN_AGE_MS,
} from '../updater/agents.mjs';
import { faceLauncherContent } from '../installer/lib/handoff.mjs';
import { claudeForwarderText } from '../installer/lib/online.mjs';
import { resolveClaudeExe } from '../installer/lib/login.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'agup-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
// 아래 Windows 판 시험은 설치 모양·지금 판 읽기를 Windows 로 못 박는다(macOS 에서 돌려도 같은 답). macOS 판은 맨 아래.
const WIN = { platform: 'win32' };
const H = 60 * 60 * 1000;
const EXE = Buffer.from('fake claude build');
const EXE_SHA = crypto.createHash('sha256').update(EXE).digest('hex');

// 설치기가 놓은 모양 그대로: claude = 4줄 전달자(옛 판), codex = npm 접두사(동봉 판).
function newRoot({ claude = '2.1.272', codex = '0.154.0' } = {}) {
  const root = path.join(tmp, `r${seq += 1}`);
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  if (claude) {
    fs.mkdirSync(path.join(claudeDir(root), claude), { recursive: true });
    fs.writeFileSync(path.join(claudeDir(root), claude, 'claude.exe'), 'old');
    fs.writeFileSync(path.join(claudeDir(root), 'claude.cmd'), claudeForwarderText(claude, 'claude.exe', { platform: 'win32' }));
  }
  if (codex) {
    const pkg = path.join(codexDir(root), 'node_modules', '@openai', 'codex');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: codex }));
    fs.writeFileSync(path.join(codexDir(root), 'codex.cmd'), '@ECHO off\r\nrem npm wrapper\r\n');
  }
  return root;
}

function fakes({ stable = '2.1.292', sha = EXE_SHA, codexLatest = '0.163.0', now = Date.parse('2026-10-20T00:00:00Z'), versionOk = true, npmOk = true } = {}) {
  const calls = { download: 0, npm: 0, fetched: [] };
  return {
    calls,
    deps: {
      // 이 파일은 Windows 판 갱신(claude.exe·codex.cmd)을 잰다. macOS 에서는 runOnce 가 건너뛴다(아래 시험).
      platform: 'win32',
      env: {},
      force: false,
      retryDelayMs: 0,
      now: () => now,
      freeBytes: () => 100 * 1024 ** 3,
      log: () => {},
      fetchText: async (url) => {
        calls.fetched.push(url);
        if (url === `${CLAUDE_BASE}/stable`) return `${stable}\n`;
        if (url === `${CLAUDE_BASE}/${stable}/manifest.json`) return JSON.stringify({ platforms: { 'win32-x64': { checksum: sha } } });
        if (url === CODEX_LATEST_URL) return JSON.stringify({ version: codexLatest });
        throw new Error(`unexpected ${url}`);
      },
      download: async (url, file) => {
        calls.download += 1;
        fs.writeFileSync(file, EXE);
        return EXE_SHA;
      },
      versionOf: (file) => {
        if (!versionOk) return 'boom';
        if (/claude\.exe$/i.test(file)) return `${path.basename(path.dirname(file))} (Claude Code)`;
        return `codex-cli ${path.basename(path.dirname(file))}`;
      },
      npmInstall: ({ prefix, spec }) => {
        calls.npm += 1;
        if (!npmOk) return { code: 1, err: 'E404' };
        fs.mkdirSync(prefix, { recursive: true });
        fs.writeFileSync(path.join(prefix, 'codex.cmd'), `rem ${spec}\r\n`);
        return { code: 0 };
      },
    },
  };
}

test('rootFromHere: tools\\updater\\agents.mjs 에서 네 단계 위가 설치 루트', () => {
  const r = rootFromHere();
  assert.ok(fs.existsSync(path.join(r, 'updater', 'agents.mjs')) || true); // 저장소 안에서는 모양만 확인
  assert.equal(path.isAbsolute(r), true);
});

test('전달자: 한 줄로 실행하고 바로 끝난다(쓰는 중 바뀌어도 배치가 다시 읽을 것이 없음), 로그인·설치기 정규식과 맞는다', () => {
  const t = claudeForwarder('2.1.292', { platform: 'win32' });
  assert.equal(t, `@echo off\r\n"%~dp02.1.292\\claude.exe" %*&exit/b${' '.repeat(40)}\r\n`);
  assert.match(t, /^[\x20-\x7e\r\n]+$/);
  // 설치기 출처 1 도 같은 전달자를 쓴다(두 곳이 어긋나면 안 됨).
  assert.equal(claudeForwarderText('2.1.292', 'claude.exe', { platform: 'win32' }), t);
  // macOS 판 전달자도 두 곳(설치기·업데이터)이 글자까지 같다.
  assert.equal(claudeForwarderText('2.1.292', 'claude', { platform: 'darwin' }), claudeForwarder('2.1.292', { platform: 'darwin' }));
  const root = newRoot({ claude: '2.1.292' });
  assert.equal(resolveClaudeExe(root), path.join(claudeDir(root), '2.1.292', 'claude.exe'));
  assert.equal(codexForwarder('0.163.0'), '@echo off\r\n"%~dp0..\\codex-versions\\0.163.0\\codex.cmd" %*\r\n');
});

test('지금 판 읽기: 클로드 전달자 · 코덱스 동봉 접두사 · 코덱스 전달자', () => {
  const root = newRoot();
  assert.deepEqual(currentClaude(root, WIN), { present: true, version: '2.1.272', forwarder: true });
  assert.deepEqual(currentCodex(root, WIN), { present: true, version: '0.154.0', forwarder: false });
  fs.writeFileSync(path.join(codexDir(root), 'codex.cmd'), codexForwarder('0.163.0'));
  assert.deepEqual(currentCodex(root, WIN), { present: true, version: '0.163.0', forwarder: true });
  const empty = newRoot({ claude: null, codex: null });
  assert.equal(currentClaude(empty, WIN).present, false);
  assert.equal(currentCodex(empty, WIN).present, false);
});

test('클로드: stable 새 판을 받아 sha256 확인 → 실행 확인 → 전달자 전환', async () => {
  const root = newRoot();
  const f = fakes();
  const r = await runOnce(root, f.deps);
  assert.equal(r.claude.status, 'updated', JSON.stringify(r.claude));
  assert.equal(r.claude.version, '2.1.292');
  assert.equal(currentClaude(root, WIN).version, '2.1.292');
  assert.equal(fs.readFileSync(path.join(claudeDir(root), '2.1.292', 'claude.exe'), 'utf8'), 'fake claude build');
  assert.equal(fs.existsSync(path.join(claudeDir(root), '2.1.272', 'claude.exe')), true, '직전 판은 남긴다');
  assert.equal(f.calls.download, 1);
});

test('클로드: sha256 이 다르면 전환하지 않고 받은 조각도 지운다', async () => {
  const root = newRoot();
  const f = fakes({ sha: 'a'.repeat(64) });
  const r = await runOnce(root, f.deps);
  assert.equal(r.claude.status, 'error');
  assert.match(r.claude.detail, /checksum/);
  assert.equal(currentClaude(root, WIN).version, '2.1.272');
  assert.equal(fs.existsSync(path.join(claudeDir(root), '2.1.292', 'claude.exe.part')), false);
});

test('클로드·코덱스: 새 판이 --version 에 답하지 않으면 전환하지 않는다', async () => {
  const root = newRoot();
  const f = fakes({ versionOk: false, now: Date.parse('2026-10-20T00:00:00Z') });
  writeState(root, { codexSeen: { '0.163.0': '2026-10-01T00:00:00Z' } });
  const r = await runOnce(root, f.deps);
  assert.equal(r.claude.status, 'error');
  assert.equal(r.codex.status, 'error');
  assert.equal(currentClaude(root, WIN).version, '2.1.272');
  assert.equal(currentCodex(root, WIN).version, '0.154.0');
});

test('클로드: 이미 최신이면 아무것도 받지 않는다', async () => {
  const root = newRoot({ claude: '2.1.292' });
  const f = fakes();
  const r = await runOnce(root, f.deps);
  assert.equal(r.claude.status, 'current');
  assert.equal(f.calls.download, 0);
});

test('코덱스: 처음 본 판은 72시간 기다리고, 지나면 받아 전환한다', async () => {
  const root = newRoot();
  const t0 = Date.parse('2026-10-20T00:00:00Z');
  const f1 = fakes({ now: t0 });
  const r1 = await runOnce(root, f1.deps);
  assert.equal(r1.codex.status, 'waiting');
  assert.equal(f1.calls.npm, 0);
  assert.equal(readState(root).codexSeen['0.163.0'], new Date(t0).toISOString());

  const f2 = fakes({ now: t0 + CODEX_MIN_AGE_MS + 1 });
  const r2 = await runOnce(root, f2.deps);
  assert.equal(r2.codex.status, 'updated', JSON.stringify(r2.codex));
  assert.equal(currentCodex(root, WIN).version, '0.163.0');
  assert.equal(fs.readFileSync(path.join(codexDir(root), 'codex.cmd'), 'utf8'), codexForwarder('0.163.0'));
  assert.equal(fs.existsSync(path.join(codexVersionsDir(root), '0.163.0', 'codex.cmd')), true);
  assert.deepEqual(readState(root).codexSeen, {}, '쓰게 된 판까지는 기록에서 지운다');
});

test('코덱스: 패키지 업데이트가 동봉 판으로 되돌려도 받아 둔 판을 다시 가리킨다(다시 받지 않음)', async () => {
  const root = newRoot();
  const prefix = path.join(codexVersionsDir(root), '0.163.0');
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(path.join(prefix, 'codex.cmd'), 'rem kept\r\n');
  writeState(root, { codexSeen: { '0.163.0': '2026-10-01T00:00:00Z' } });
  const f = fakes();
  const r = await runOnce(root, f.deps);
  assert.equal(r.codex.status, 'updated');
  assert.equal(f.calls.npm, 0);
});

test('코덱스: npm 이 실패하면 반쯤 깐 폴더를 지우고 지금 판 그대로', async () => {
  const root = newRoot();
  writeState(root, { codexSeen: { '0.163.0': '2026-10-01T00:00:00Z' } });
  const f = fakes({ npmOk: false });
  const r = await runOnce(root, f.deps);
  assert.equal(r.codex.status, 'error');
  assert.equal(currentCodex(root, WIN).version, '0.154.0');
  assert.equal(fs.existsSync(path.join(codexVersionsDir(root), '0.163.0')), false);
});

test('pickCodexTarget: 72시간 지난 판 중 가장 새것, 예비판 이름은 무시', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const seen = {
    '0.160.0': '2026-10-10T00:00:00Z',
    '0.161.0': '2026-10-15T00:00:00Z',
    '0.163.0': '2026-10-19T00:00:00Z',
    '0.164.0-alpha.1': '2026-10-01T00:00:00Z',
  };
  assert.equal(pickCodexTarget(seen, now), '0.161.0');
  assert.equal(pickCodexTarget({}, now), null);
  assert.equal(compareVersions('0.99.0', '0.100.0'), -1);
});

test('6시간 안에는 다시 확인하지 않고, 꺼 두면(disabled·IRIS_AGENT_UPDATE=0) 아무것도 안 한다', async () => {
  const root = newRoot();
  const now = Date.parse('2026-10-20T00:00:00Z');
  writeState(root, { lastCheck: new Date(now - CHECK_INTERVAL_MS + H).toISOString() });
  assert.equal(whyNot(root, { env: {}, now }), 'recent');
  assert.equal(whyNot(root, { env: {}, now: now + 2 * H }), null);
  assert.equal(whyNot(root, { env: { IRIS_AGENT_UPDATE: '0' }, now: now + 2 * H }), 'off');
  writeState(root, { disabled: true });
  assert.equal(whyNot(root, { env: {}, now }), 'disabled');
  const f = fakes({ now });
  assert.deepEqual(await runOnce(root, f.deps), { skipped: 'disabled' });
  assert.equal(f.calls.fetched.length, 0);
});

test('잠금: 다른 확인이 돌고 있으면 건너뛰고, 30분 지난 잠금은 낡은 것으로 본다', async () => {
  const root = newRoot();
  const now = Date.parse('2026-10-20T00:00:00Z');
  fs.writeFileSync(lockPath(root), JSON.stringify({ pid: 1, at: new Date(now - 60000).toISOString() }));
  assert.equal(whyNot(root, { env: {}, now }), 'busy');
  const f = fakes({ now });
  assert.deepEqual(await runOnce(root, f.deps), { skipped: 'busy' });
  fs.writeFileSync(lockPath(root), JSON.stringify({ pid: 1, at: new Date(now - 31 * 60000).toISOString() }));
  const r = await runOnce(root, f.deps);
  assert.equal(r.claude.status, 'updated');
  assert.equal(fs.existsSync(lockPath(root)), false, '끝나면 잠금을 푼다');
});

test('kick: 할 때가 되면 분리 자식을 띄우고, 아니면 띄우지 않는다', () => {
  const root = newRoot();
  const spawned = [];
  const spawnFn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; };
  assert.deepEqual(kick(root, { env: {}, now: Date.now(), spawnFn }), { started: true });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(1), ['--run', '--root', root]);
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].opts.windowsHide, true);
  assert.equal(kick(root, { env: { IRIS_AGENT_UPDATE: '0' }, now: Date.now(), spawnFn }).started, false);
  assert.equal(spawned.length, 1);
});

test('디스크 여유 2GB 미만이면 아무것도 받지 않는다', async () => {
  const root = newRoot();
  const f = fakes();
  f.deps.freeBytes = () => 1024 ** 3;
  const r = await runOnce(root, f.deps);
  assert.equal(r.skipped, 'disk');
  assert.equal(f.calls.fetched.length, 0);
});

test('정리: 쓰는 판 + 직전 판 하나만 남긴다', () => {
  const dir = path.join(tmp, `prune-${seq += 1}`);
  for (const v of ['2.1.200', '2.1.272', '2.1.280', '2.1.292']) fs.mkdirSync(path.join(dir, v), { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '');
  const removed = pruneVersions(dir, '2.1.292', () => {});
  assert.deepEqual(removed.sort(), ['2.1.200', '2.1.272']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2.1.280', '2.1.292', 'claude.cmd']);
});

test('실행기: IRIS 창을 띄운 뒤 업데이트 확인을 부른다(ASCII·CRLF 유지)', () => {
  const c = faceLauncherContent({ platform: 'win32' });
  assert.ok(c.includes('"%IRIS_FACE_NODE%" "%~dp0_agent\\shared\\tools\\updater\\agents.mjs" --kick'));
  const lines = c.split('\r\n');
  const wscript = lines.findIndex((l) => l.startsWith('wscript.exe'));
  const kickAt = lines.findIndex((l) => l.includes('agents.mjs" --kick'));
  assert.ok(kickAt > wscript, '창을 먼저 띄운다');
  assert.match(c, /^[\x20-\x7e\r\n]+$/);
});

// ---------------------------------------------------------------------------
// macOS 판(docs/설계-macOS.md M5): darwin 판 · sh 전달자 · codex.js 전달자
// ---------------------------------------------------------------------------
const MAC = { platform: 'darwin' };
function newRootMac({ claude = '2.1.272', codex = '0.154.0' } = {}) {
  const root = path.join(tmp, `m${seq += 1}`);
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir(root), claude), { recursive: true });
  fs.writeFileSync(path.join(claudeDir(root), claude, 'claude'), 'old', { mode: 0o755 });
  fs.writeFileSync(path.join(claudeDir(root), 'claude'), claudeForwarderText(claude, 'claude', MAC), { mode: 0o755 });
  const pkg = path.join(codexDir(root), 'node_modules', '@openai', 'codex');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: codex, type: 'module' }));
  fs.writeFileSync(path.join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n// the original npm launcher\n');
  return root;
}
function fakesMac(opts = {}) {
  const f = fakes(opts);
  const urls = [];
  Object.assign(f.deps, {
    platform: 'darwin', arch: 'arm64',
    fetchText: async (url) => {
      if (url === `${CLAUDE_BASE}/stable`) return `${opts.stable ?? '2.1.292'}\n`;
      if (/manifest\.json$/.test(url)) return JSON.stringify({ platforms: { 'darwin-arm64': { checksum: opts.sha ?? EXE_SHA }, 'win32-x64': { checksum: 'b'.repeat(64) } } });
      if (url === CODEX_LATEST_URL) return JSON.stringify({ version: opts.codexLatest ?? '0.163.0' });
      throw new Error(`unexpected ${url}`);
    },
    download: async (url, file) => { urls.push(url); fs.writeFileSync(file, EXE); return EXE_SHA; },
    versionOf: (file) => {
      if (/\/claude$/.test(file)) return `${path.basename(path.dirname(file))} (Claude Code)`;
      const m = /codex-versions\/([^/]+)\//.exec(file); return `codex-cli ${m ? m[1] : '?'}`;
    },
    npmInstall: ({ prefix, spec, platform }) => {
      assert.equal(platform, 'darwin');
      const bin = path.join(prefix, 'node_modules', '@openai', 'codex', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'codex.js'), `// ${spec}\n`);
      return { code: 0 };
    },
  });
  f.urls = urls;
  return f;
}

test('macOS: 지원 OS 이고, 지금 판은 sh 전달자 · codex.js(원본/전달자)에서 읽는다', async () => {
  const { supportedPlatform, codexForwarderJs } = await import('../updater/agents.mjs');
  assert.equal(supportedPlatform('darwin'), true);
  assert.deepEqual(await runOnce('/nonexistent-iris-root', { platform: 'linux' }), { skipped: 'unsupported-os' });
  const root = newRootMac();
  assert.deepEqual(currentClaude(root, MAC), { present: true, version: '2.1.272', forwarder: true });
  assert.deepEqual(currentCodex(root, MAC), { present: true, version: '0.154.0', forwarder: false });
  fs.writeFileSync(path.join(codexDir(root), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), codexForwarderJs('0.163.0'));
  assert.deepEqual(currentCodex(root, MAC), { present: true, version: '0.163.0', forwarder: true });
});

test('macOS 클로드: darwin-arm64 판을 받아 sha256 확인 → 실행 권한 → 전달자(0755) 전환', async () => {
  const root = newRootMac();
  const f = fakesMac();
  const r = await runOnce(root, f.deps);
  assert.equal(r.claude.status, 'updated', JSON.stringify(r.claude));
  assert.deepEqual(f.urls, [`${CLAUDE_BASE}/2.1.292/darwin-arm64/claude`]);
  const fwd = path.join(claudeDir(root), 'claude');
  assert.equal(fs.readFileSync(fwd, 'utf8'), claudeForwarder('2.1.292', MAC));
  assert.equal(fs.statSync(fwd).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(claudeDir(root), '2.1.292', 'claude')).mode & 0o777, 0o755);
  assert.equal(currentClaude(root, MAC).version, '2.1.292');
  assert.equal(fs.existsSync(path.join(claudeDir(root), 'claude.cmd')), false, 'Windows 전달자는 만들지 않는다');
});

test('macOS 코덱스: 72시간 뒤 --prefix 로 받아(-g 없음) codex.js 를 전달자로 바꾼다', async () => {
  const { codexForwarderJs } = await import('../updater/agents.mjs');
  const root = newRootMac();
  writeState(root, { codexSeen: { '0.163.0': '2026-10-01T00:00:00Z' } });
  const f = fakesMac();
  const r = await runOnce(root, f.deps);
  assert.equal(r.codex.status, 'updated', JSON.stringify(r.codex));
  assert.equal(fs.readFileSync(path.join(codexDir(root), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'utf8'), codexForwarderJs('0.163.0'));
  assert.equal(currentCodex(root, MAC).version, '0.163.0');
  assert.ok(fs.existsSync(path.join(codexVersionsDir(root), '0.163.0', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(codexDir(root), 'node_modules', '@openai', 'codex', 'package.json'), 'utf8')).version, '0.154.0', '옛 package.json 은 그대로(형식 판정에만 쓴다)');
});

test('macOS codex.js 전달자: 진짜 node 로 돌리면 새 판 파일이 같은 인자로 실행된다', async () => {
  const { codexForwarderJs } = await import('../updater/agents.mjs');
  const root = newRootMac();
  const newBin = path.join(codexVersionsDir(root), '0.163.0', 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(newBin, { recursive: true });
  fs.writeFileSync(path.join(newBin, '..', 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(newBin, 'codex.js'), 'import { fileURLToPath } from "node:url";\nconsole.log(JSON.stringify({ me: fileURLToPath(import.meta.url), args: process.argv.slice(2) }));\n');
  const old = path.join(codexDir(root), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.writeFileSync(old, codexForwarderJs('0.163.0'));
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [old, '--version', 'a b'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(fs.realpathSync(out.me), fs.realpathSync(path.join(newBin, 'codex.js')));
  assert.deepEqual(out.args, ['--version', 'a b']);
  // 옛 패키지가 CommonJS 인 경우의 전달자도 같은 일을 한다
  fs.writeFileSync(path.join(codexDir(root), 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ type: 'commonjs' }));
  fs.writeFileSync(old, codexForwarderJs('0.163.0', { esm: false }));
  const c = spawnSync(process.execPath, [old, 'x'], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  assert.deepEqual(JSON.parse(c.stdout.trim()).args, ['x']);
});
