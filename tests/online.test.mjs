// Task 19 — installer/lib/online.mjs (조각 ⑥ 온라인 묶음).
//
// Nothing here touches the network, the real relay on 3456, or a real
// subscription: fetch, the process runner, npm, the shim writer and every
// login.mjs/proxy.mjs helper are injected. The only real I/O is a throwaway
// temp folder per test, so the download path's .part -> sha256 -> rename
// sequence is exercised against a real filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkNet, installClaude, installDocumentSkills, installPlaywrightBrowser, PLAYWRIGHT_BROWSER_PART, installIeumOffice, IEUMOFFICE_PART, startLogin, loginStatus, startRelay,
  claudeForwarderText, downloadToFile, githubArchiveUrl, archiveTopFolder, unsafeArchiveEntry,
  HOSTS, CODES, RESUME_SENTENCE,
} from '../installer/lib/online.mjs';
import { writeReceipt, newReceiptV2, readReceipt } from '../installer/lib/receipt.mjs';

const VERSION = '2.1.272';
const PAYLOAD = Buffer.from('fake claude.exe payload — 220MB in real life');
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

const LOCK = {
  parts: {
    claude: {
      kind: 'claude-release',
      version: VERSION,
      url: `https://downloads.claude.ai/claude-code-releases/${VERSION}/win32-x64/claude.exe`,
      manifestUrl: `https://downloads.claude.ai/claude-code-releases/${VERSION}/manifest.json`,
      sha256: PAYLOAD_SHA,
      bytes: PAYLOAD.length,
      binName: 'claude.exe',
      fallback: { kind: 'npm-prefix', npm: '@anthropic-ai/claude-code', version: VERSION, integrity: 'sha512-TEST==' },
    },
  },
};

function tmpRoot(name) {
  const dir = path.join(os.tmpdir(), `iris-online-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  writeReceipt(dir, newReceiptV2({ root: dir, name: 'TESTSOUL', manifest: null, createdBy: 'test' }));
  return dir;
}

function toolsPath(root, ...rest) {
  return path.join(root, '_agent', 'shared', 'tools', ...rest);
}

// --- fake fetch pieces ------------------------------------------------------
const reachable = (status = 200) => ({ ok: true, status, headers: { get: () => null }, body: null });
const blockedErr = () => { throw new Error('getaddrinfo ENOTFOUND'); };

function manifestResponse(checksum) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ platforms: { 'win32-x64': { checksum, size: PAYLOAD.length } } }),
  };
}

function fileResponse(bytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    body: (async function* () { yield bytes; })(),
  };
}

// ===========================================================================
// ⑥-1 checkNet
// ===========================================================================

test('checkNet: claude only -> probes the five claude hosts (2.0.36: + claude.com, platform.claude.com), not chatgpt.com', async () => {
  const seen = [];
  const r = await checkNet({
    root: 'C:\\FAKE', subscriptions: ['claude'], lock: LOCK,
    probe: async (url) => { seen.push(url); return { reachable: true, status: 200 }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(new Set(r.checked), new Set(['downloads.claude.ai', 'registry.npmjs.org', 'claude.ai', 'claude.com', 'platform.claude.com']));
  assert.ok(!seen.includes(HOSTS.chatgpt), 'chatgpt.com must not be probed when it was not chosen');
});

test('checkNet: npm blocked alone -> ok:true with a note (출처 1 still works)', async () => {
  const r = await checkNet({
    root: 'C:\\FAKE', subscriptions: ['claude'], lock: LOCK,
    probe: async (url) => ({ reachable: url !== HOSTS.npmRegistry, status: 200 }),
  });
  assert.equal(r.ok, true, 'a blocked npm registry alone must not stop the install');
  assert.deepEqual(r.blocked, ['registry.npmjs.org']);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /공식 내려받기 주소로 받을 수 있습니다/);
});

test('checkNet: both claude sources blocked -> ok:false + resume sentence', async () => {
  const r = await checkNet({
    root: 'C:\\FAKE', subscriptions: ['claude'], lock: LOCK,
    probe: async (url) => ({ reachable: [HOSTS.claudeLogin, HOSTS.claudeAuthorize, HOSTS.claudePlatform].includes(url), status: 200 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.net);
  assert.deepEqual(new Set(r.blocked), new Set(['downloads.claude.ai', 'registry.npmjs.org']));
  assert.ok(r.message.includes(RESUME_SENTENCE), 'the offline stop must carry the resume sentence');
});

test('checkNet: claude.ai (login page) blocked -> ok:false even though a source is up', async () => {
  const r = await checkNet({
    root: 'C:\\FAKE', subscriptions: ['claude'], lock: LOCK,
    probe: async (url) => ({ reachable: url !== HOSTS.claudeLogin, status: 200 }),
  });
  assert.equal(r.ok, false, 'the login page has no alternative, so it is required');
  assert.deepEqual(r.blocked, ['claude.ai']);
});

test('checkNet: 2.0.36 — claude.com / platform.claude.com (실제 로그인·토큰 교환 주소) 이 막히면 ok:false', async () => {
  for (const host of [HOSTS.claudeAuthorize, HOSTS.claudePlatform]) {
    const r = await checkNet({
      root: 'C:\\FAKE', subscriptions: ['claude'], lock: LOCK,
      probe: async (url) => ({ reachable: url !== host, status: 200 }),
    });
    assert.equal(r.ok, false, `${host} has no alternative for the login`);
    assert.deepEqual(r.blocked, [new URL(host).host]);
  }
});

test('checkNet: chatgpt only -> only chatgpt.com decides', async () => {
  const up = await checkNet({ root: 'C:\\FAKE', subscriptions: ['chatgpt'], lock: LOCK, probe: async () => ({ reachable: true, status: 200 }) });
  assert.deepEqual(up.checked, ['chatgpt.com']);
  assert.equal(up.ok, true);

  const down = await checkNet({ root: 'C:\\FAKE', subscriptions: ['chatgpt'], lock: LOCK, probe: async () => ({ reachable: false }) });
  assert.equal(down.ok, false);
  assert.deepEqual(down.blocked, ['chatgpt.com']);
});

test('checkNet: a 403 answer is reachable, a thrown request is blocked', async () => {
  const fetchFn = async (url) => (url === HOSTS.claudeLogin ? reachable(403) : blockedErr());
  const r = await checkNet({ root: 'C:\\FAKE', subscriptions: ['claude'], lock: LOCK, fetchFn });
  assert.equal(r.results.find((x) => x.host === 'claude.ai').reachable, true, '403 = the host answered');
  assert.equal(r.results.find((x) => x.host === 'downloads.claude.ai').reachable, false);
});

// ===========================================================================
// ⑥-2 installClaude
// ===========================================================================

test('installClaude: claude not chosen -> still installed, both shims (2.0.38 두 비서 항상 설치)', async () => {
  const root = tmpRoot('skip');
  const shimCalls = [];
  const r = await installClaude({ platform: 'win32', 
    root, lock: LOCK, subscriptions: ['chatgpt'],
    fetchFn: async (url) => (String(url).endsWith('manifest.json') ? manifestResponse(PAYLOAD_SHA) : fileResponse(PAYLOAD)),
    runFn: async () => ({ code: 0, out: `${VERSION} (Claude Code)`, err: '' }),
    writeShimsFn: (rt, agents) => { shimCalls.push(agents); return { written: ['claude.cmd'] }; },
  });
  assert.deepEqual({ ok: r.ok, state: r.state }, { ok: true, state: 'done' });
  assert.deepEqual(shimCalls, [['claude', 'codex']]);
  assert.equal(readReceipt(root).installed.claude.verified, true);
  assert.notEqual(readReceipt(root).installed.claude.reason, 'subscription-not-selected');
  fs.rmSync(root, { recursive: true, force: true });
});

test('installClaude: the locked version is already there -> source:"existing", no download', async () => {
  const root = tmpRoot('existing');
  const exe = toolsPath(root, 'claude', VERSION, 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'already here');
  const r = await installClaude({ platform: 'win32', 
    root, lock: LOCK, subscriptions: ['claude'],
    runFn: async () => ({ code: 0, out: `${VERSION} (Claude Code)`, err: '' }),
    fetchFn: async () => { throw new Error('must not fetch'); },
    writeShimsFn: () => ({ written: [] }),
  });
  assert.deepEqual({ ok: r.ok, state: r.state, source: r.source }, { ok: true, state: 'done', source: 'existing' });
  assert.equal(readReceipt(root).installed.claude.source, 'existing');
  fs.rmSync(root, { recursive: true, force: true });
});

test('installClaude: 출처 1 success -> manifest match, sha256 match, rename, shim, receipt', async () => {
  const root = tmpRoot('src1');
  const shimCalls = [];
  const r = await installClaude({ platform: 'win32', 
    root, lock: LOCK, subscriptions: ['claude', 'chatgpt'],
    fetchFn: async (url) => (String(url).endsWith('manifest.json') ? manifestResponse(PAYLOAD_SHA) : fileResponse(PAYLOAD)),
    runFn: async () => ({ code: 0, out: `${VERSION} (Claude Code)`, err: '' }),
    npmInstall: async () => { throw new Error('출처 2 must not run when 출처 1 works'); },
    writeShimsFn: (rt, agents) => { shimCalls.push(agents); return { written: ['claude.cmd'] }; },
  });
  assert.deepEqual({ ok: r.ok, state: r.state, source: r.source }, { ok: true, state: 'done', source: 'claude.ai' });

  const exe = toolsPath(root, 'claude', VERSION, 'claude.exe');
  assert.ok(fs.existsSync(exe), 'the verified binary is renamed into place');
  assert.ok(!fs.existsSync(`${exe}.part`), 'no .part is left behind');
  assert.equal(fs.readFileSync(exe).toString(), PAYLOAD.toString());

  const cmd = fs.readFileSync(toolsPath(root, 'claude', 'claude.cmd'), 'utf8');
  assert.equal(cmd, claudeForwarderText(VERSION, 'claude.exe', { platform: 'win32' }));
  assert.ok(cmd.includes('\r\n'), 'a .cmd must be CRLF');
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x00-\x7F]*$/.test(cmd), 'a .cmd must be pure ASCII');
  assert.deepEqual(shimCalls, [['claude', 'codex']]);

  const rec = readReceipt(root).installed.claude;
  assert.deepEqual(
    { version: rec.version, source: rec.source, sha256: rec.sha256, verified: rec.verified },
    { version: VERSION, source: 'claude.ai', sha256: PAYLOAD_SHA, verified: true },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('installClaude: progress is reported for the download', async () => {
  const root = tmpRoot('progress');
  const seen = [];
  await installClaude({ platform: 'win32', 
    root, lock: LOCK, subscriptions: ['claude'],
    fetchFn: async (url) => (String(url).endsWith('manifest.json') ? manifestResponse(PAYLOAD_SHA) : fileResponse(PAYLOAD)),
    runFn: async () => ({ code: 0, out: VERSION, err: '' }),
    writeShimsFn: () => ({ written: [] }),
    onProgress: (p) => seen.push(p),
  });
  const dl = seen.filter((p) => p.phase === 'download');
  assert.ok(dl.length > 0, 'the 220MB download reports {done,total}');
  assert.equal(dl.at(-1).done, PAYLOAD.length);
  assert.equal(dl.at(-1).total, PAYLOAD.length);
  fs.rmSync(root, { recursive: true, force: true });
});

test('installClaude: manifest disagrees with the lock -> 출처 1 abandoned, 출처 2 used', async () => {
  const root = tmpRoot('mismatch');
  const logged = [];
  let downloaded = false;
  const r = await installClaude({ platform: 'win32', 
    root, lock: LOCK, subscriptions: ['claude'],
    log: (l) => logged.push(l),
    fetchFn: async (url) => {
      if (String(url).endsWith('manifest.json')) return manifestResponse('f'.repeat(64));
      downloaded = true;
      return fileResponse(PAYLOAD);
    },
    npmInstall: async ({ prefix }) => {
      fs.mkdirSync(prefix, { recursive: true });
      fs.writeFileSync(path.join(prefix, 'claude.cmd'), 'npm shim');
      return { code: 0, out: 'added 2 packages', err: '' };
    },
    runFn: async () => ({ code: 0, out: `${VERSION} (Claude Code)`, err: '' }),
    writeShimsFn: () => ({ written: [] }),
  });
  assert.deepEqual({ ok: r.ok, source: r.source }, { ok: true, source: 'npm' });
  assert.equal(downloaded, false, 'a mismatching manifest must stop before the 220MB download');
  const line = logged.find((l) => l.includes('manifest mismatch'));
  assert.ok(line, 'the mismatch is logged');
  assert.ok(line.includes('f'.repeat(64)) && line.includes(PAYLOAD_SHA), 'both values are logged');
  assert.equal(readReceipt(root).installed.claude.integrity, 'sha512-TEST==');
  fs.rmSync(root, { recursive: true, force: true });
});

test('installClaude: checksum mismatch -> .part deleted, claude.exe never created, falls back', async () => {
  const root = tmpRoot('badsha');
  const r = await installClaude({ platform: 'win32', 
    root, lock: LOCK, subscriptions: ['claude'],
    fetchFn: async (url) => (String(url).endsWith('manifest.json')
      ? manifestResponse(PAYLOAD_SHA)
      : fileResponse(Buffer.from('tampered bytes'))),
    npmInstall: async ({ prefix }) => {
      fs.mkdirSync(prefix, { recursive: true });
      fs.writeFileSync(path.join(prefix, 'claude.cmd'), 'npm shim');
      return { code: 0, out: '', err: '' };
    },
    runFn: async () => ({ code: 0, out: `${VERSION} (Claude Code)`, err: '' }),
    writeShimsFn: () => ({ written: [] }),
  });
  const exe = toolsPath(root, 'claude', VERSION, 'claude.exe');
  assert.ok(!fs.existsSync(exe), 'a binary whose fingerprint is wrong is never renamed into place');
  assert.ok(!fs.existsSync(`${exe}.part`), 'the .part is deleted');
  assert.equal(r.source, 'npm');
  fs.rmSync(root, { recursive: true, force: true });
});

test('installClaude: both sources fail -> E-ONLINE-CLAUDE with both reasons', async () => {
  const root = tmpRoot('bothfail');
  const r = await installClaude({ platform: 'win32', 
    root, lock: LOCK, subscriptions: ['claude'],
    fetchFn: async () => { throw new Error('ENOTFOUND downloads.claude.ai'); },
    npmInstall: async () => ({ code: 1, out: '', err: 'ECONNREFUSED registry.npmjs.org' }),
    runFn: async () => ({ code: 1, out: '', err: '' }),
    writeShimsFn: () => ({ written: [] }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'failed');
  assert.equal(r.code, CODES.claude);
  assert.deepEqual(r.detail.map((d) => d.source), ['claude.ai', 'npm']);
  assert.equal(readReceipt(root).installed.claude.state, 'failed');
  assert.equal(r.message.split('.').length <= 2, true, 'one Korean sentence');
  fs.rmSync(root, { recursive: true, force: true });
});

test('downloadToFile: hashes what actually landed on disk', async () => {
  const dir = tmpRoot('dl');
  const dest = path.join(dir, 'x.bin');
  const got = await downloadToFile('https://example.invalid/x', dest, { fetchFn: async () => fileResponse(PAYLOAD) });
  assert.equal(got.sha256, PAYLOAD_SHA);
  assert.equal(got.bytes, PAYLOAD.length);
  assert.equal(fs.readFileSync(dest).toString(), PAYLOAD.toString());
  fs.rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// ⑥-2b installDocumentSkills
// ===========================================================================
//
// 허가서상 꾸러미에 못 싣는 유일한 클로드 플러그인. 깃허브가 커밋 하나를 통째로
// 내주는 zip 을 받아 `include` 폴더만 꺼내 놓고, ⑤-6 의 등록 함수를 한 번 더
// 부른다. 여기서는 받는 것·꺼내는 것·등록을 부르는 것·실패가 `pending` 으로
// 남는 것을 본다(인터넷도 tar 도 쓰지 않는다 — 전부 주입).

const DOC_COMMIT = '34040c9c568585f6929bedeaad110ad08f079624';
const DOC_LOCK = {
  parts: {
    'document-skills': {
      kind: 'git',
      repo: 'https://github.com/anthropics/skills.git',
      commit: DOC_COMMIT,
      include: ['skills/xlsx', 'skills/pdf'],
      dest: `_agent/shared/tools/claude/document-skills/${DOC_COMMIT.slice(0, 7)}`,
      redistribute: 'download',
    },
  },
};

// tar 자리에 끼우는 가짜: 받은 zip 파일 옆에 "푼 것처럼" 폴더를 만든다.
function fakeArchive({ top = `skills-${DOC_COMMIT}`, tree = ['skills/xlsx/SKILL.md', 'skills/pdf/SKILL.md'] } = {}) {
  return {
    listArchiveFn: async () => tree.map((t) => `${top}/${t}`),
    extractZipFn: async (zip, dest, { strip = 0 } = {}) => {
      assert.equal(strip, 1, '깃허브 zip 은 최상위 폴더 한 겹을 벗긴다');
      for (const rel of tree) {
        const p = path.join(dest, ...rel.split('/'));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, `# ${rel}\n`, 'utf8');
      }
    },
  };
}

test('installDocumentSkills: 커밋 zip 을 받아 include 폴더만 놓고 플러그인 등록까지 부른다', async () => {
  const root = tmpRoot('docskills');
  const registered = [];
  const asked = [];
  const r = await installDocumentSkills({
    root,
    lock: DOC_LOCK,
    subscriptions: ['claude'],
    downloadFn: async (url, dest) => {
      asked.push(url);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'PK-fake');
      return { sha256: 'x', bytes: 7 };
    },
    ...fakeArchive(),
    registerFn: (ctx) => { registered.push(ctx); return { name: 'document-skills', status: 'registered' }; },
  });

  assert.equal(r.ok, true);
  assert.equal(r.state, 'done');
  assert.equal(r.commit, DOC_COMMIT);
  assert.equal(r.registered, 'registered');
  assert.deepEqual(asked, [`https://github.com/anthropics/skills/archive/${DOC_COMMIT}.zip`]);

  const dest = path.join(root, ...DOC_LOCK.parts['document-skills'].dest.split('/'));
  assert.ok(fs.existsSync(path.join(dest, 'skills', 'xlsx', 'SKILL.md')), 'include 폴더가 dest 아래 그대로 놓인다');
  assert.ok(fs.existsSync(path.join(dest, 'skills', 'pdf', 'SKILL.md')));
  assert.equal(registered.length, 1);
  assert.equal(registered[0].root, root);

  const installed = readReceipt(root).installed['document-skills'];
  assert.equal(installed.state, 'installed');
  assert.equal(installed.commit, DOC_COMMIT);

  // 받은 zip·임시 폴더는 치운다
  assert.ok(!fs.existsSync(path.join(root, '_agent', 'setup', 'downloads', `document-skills-${DOC_COMMIT.slice(0, 7)}`)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('installDocumentSkills: 받은 zip 의 최상위 폴더에 그 커밋이 없으면 받지 않은 것으로 친다', async () => {
  const root = tmpRoot('docskills-wrong');
  const r = await installDocumentSkills({
    root,
    lock: DOC_LOCK,
    subscriptions: ['claude'],
    downloadFn: async (url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'PK'); return {}; },
    ...fakeArchive({ top: 'skills-0000000000000000000000000000000000000000' }),
    registerFn: () => { throw new Error('등록을 부르면 안 된다'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'pending');
  assert.equal(r.code, CODES.documentSkills);
  assert.match(r.message, /문서 작성 스킬/);
  assert.equal(readReceipt(root).installed['document-skills'].state, 'pending');
  const dest = path.join(root, ...DOC_LOCK.parts['document-skills'].dest.split('/'));
  assert.ok(!fs.existsSync(dest), '반쯤 받은 것을 남기지 않는다');
  fs.rmSync(root, { recursive: true, force: true });
});

test('installDocumentSkills: 내려받기가 실패하면 pending 으로 남고 설치를 멈추지 않는다', async () => {
  const root = tmpRoot('docskills-down');
  const r = await installDocumentSkills({
    root,
    lock: DOC_LOCK,
    subscriptions: ['claude'],
    downloadFn: async () => { throw new Error('HTTP 503 github'); },
    registerFn: () => { throw new Error('등록을 부르면 안 된다'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'pending');
  assert.match(String(r.detail), /503/);
  assert.ok(!/teamclaude/i.test(r.message));
  fs.rmSync(root, { recursive: true, force: true });
});

test('installDocumentSkills: 이미 같은 커밋 폴더가 있으면 받지 않고 등록만 다시 한다', async () => {
  const root = tmpRoot('docskills-kept');
  const dest = path.join(root, ...DOC_LOCK.parts['document-skills'].dest.split('/'));
  for (const rel of ['skills/xlsx', 'skills/pdf']) {
    fs.mkdirSync(path.join(dest, ...rel.split('/')), { recursive: true });
  }
  let downloads = 0;
  const r = await installDocumentSkills({
    root,
    lock: DOC_LOCK,
    subscriptions: ['claude'],
    downloadFn: async () => { downloads += 1; return {}; },
    registerFn: () => ({ name: 'document-skills', status: 'kept' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'existing');
  assert.equal(downloads, 0);
  assert.equal(r.registered, 'kept');
  fs.rmSync(root, { recursive: true, force: true });
});

test('installDocumentSkills: 클로드 구독이 아니면 아예 놓지 않는다(실패가 아니다)', async () => {
  const root = tmpRoot('docskills-skip');
  const r = await installDocumentSkills({
    root, lock: DOC_LOCK, subscriptions: ['chatgpt'],
    downloadFn: () => { throw new Error('내려받으면 안 된다'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'skipped');
  assert.equal(readReceipt(root).installed['document-skills'].reason, 'subscription-not-selected');
  fs.rmSync(root, { recursive: true, force: true });
});

test('installDocumentSkills: 오프라인 모드에서는 받지 않고 이어하기 문장을 남긴다', async () => {
  const root = tmpRoot('docskills-offline');
  const r = await installDocumentSkills({
    root, lock: DOC_LOCK, subscriptions: ['claude'],
    env: { IRIS_INSTALLER_OFFLINE: '1' },
    downloadFn: () => { throw new Error('오프라인에서는 받지 않는다'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'pending');
  assert.equal(r.detail, RESUME_SENTENCE);
  fs.rmSync(root, { recursive: true, force: true });
});

test('githubArchiveUrl / archiveTopFolder: 주소를 만들고 최상위 폴더를 읽는다', () => {
  assert.equal(
    githubArchiveUrl('https://github.com/anthropics/skills.git', 'abc123'),
    'https://github.com/anthropics/skills/archive/abc123.zip',
  );
  assert.equal(githubArchiveUrl('not-a-repo', 'abc123'), null);
  assert.equal(archiveTopFolder(['skills-abc/one.md', 'skills-abc/two/three.md']), 'skills-abc');
  assert.equal(archiveTopFolder(['a/one.md', 'b/two.md']), null);
});

// Task 24b #6 — zip-slip 방어: `..` 조각·절대경로·드라이브 문자·UNC 는
// 전부 불안전, 평범한 상대경로만 안전.
test('unsafeArchiveEntry: ".." · 절대경로 · 드라이브 문자 · UNC 는 불안전, 평범한 상대경로는 안전', () => {
  assert.equal(unsafeArchiveEntry('skills-abc/skills/xlsx/SKILL.md'), false);
  assert.equal(unsafeArchiveEntry('./skills-abc/one.md'), false);
  assert.equal(unsafeArchiveEntry('skills-abc/../../../evil.txt'), true);
  assert.equal(unsafeArchiveEntry('../evil.txt'), true);
  assert.equal(unsafeArchiveEntry('/etc/passwd'), true);
  assert.equal(unsafeArchiveEntry('C:\\Windows\\System32\\evil.dll'), true);
  assert.equal(unsafeArchiveEntry('\\\\server\\share\\evil.txt'), true);
  assert.equal(unsafeArchiveEntry('//server/share/evil.txt'), true);
});

test('installDocumentSkills (Task 24b #6): 항목 경로에 ".." 조각이 있으면 풀기 전에 거부한다(zip-slip 방어)', async () => {
  const root = tmpRoot('zipslip');
  let extracted = false;
  const r = await installDocumentSkills({
    root,
    lock: DOC_LOCK,
    subscriptions: ['claude'],
    downloadFn: async (url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'PK-fake'); return {}; },
    listArchiveFn: async () => [
      `skills-${DOC_COMMIT}/skills/xlsx/SKILL.md`,
      `skills-${DOC_COMMIT}/../../../evil.txt`,
    ],
    extractZipFn: async () => { extracted = true; },
    registerFn: () => { throw new Error('등록을 부르면 안 된다'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'pending');
  assert.match(String(r.detail), /unsafe entry/);
  assert.equal(extracted, false, '불안전한 항목이 있으면 extractZipFn 자체를 부르지 않는다');
  fs.rmSync(root, { recursive: true, force: true });
});

// Task 24b #4 — include 여러 개 중 일부만 옮겨진 뒤 실패하면 반쪼가리를
// dest 에 남기지 않는다(단, dest 가 이번 실행 전부터 있었다면 그대로 둔다).
test('installDocumentSkills (Task 24b #4): 복사 중간에 실패하면(두 번째 include 없음) 이번에 새로 만든 dest 를 통째로 치운다', async () => {
  const root = tmpRoot('partial-new');
  const r = await installDocumentSkills({
    root,
    lock: DOC_LOCK,
    subscriptions: ['claude'],
    downloadFn: async (url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'PK-fake'); return {}; },
    // tree 에 skills/pdf 가 없다 -> include 두 번째 경로에서 던진다(첫 번째는 이미 복사된 뒤).
    ...fakeArchive({ tree: ['skills/xlsx/SKILL.md'] }),
    registerFn: () => { throw new Error('등록을 부르면 안 된다'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'pending');
  assert.match(String(r.detail), /include path not in archive/);

  const dest = path.join(root, ...DOC_LOCK.parts['document-skills'].dest.split('/'));
  assert.ok(!fs.existsSync(dest), '이번 실행이 새로 만든 dest 는 반쪼가리(skills/xlsx 만 있는 채)로 남지 않는다');
  fs.rmSync(root, { recursive: true, force: true });
});

test('installDocumentSkills (Task 24b #4): dest 가 이전부터 있었다면 이번 실행이 실패해도 그 내용을 지우지 않는다', async () => {
  const root = tmpRoot('partial-existing');
  const dest = path.join(root, ...DOC_LOCK.parts['document-skills'].dest.split('/'));
  // "already" 검사(include 전부 존재)는 통과하지 못하도록 무관한 표식 파일만 미리 둔다 —
  // 그래야 다시 내려받기 시도로 들어가고, 그 시도가 실패했을 때의 동작을 본다.
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'previous-run-marker.txt'), '이전 실행이 남긴 것');

  const r = await installDocumentSkills({
    root,
    lock: DOC_LOCK,
    subscriptions: ['claude'],
    downloadFn: async (url, dest2) => { fs.mkdirSync(path.dirname(dest2), { recursive: true }); fs.writeFileSync(dest2, 'PK-fake'); return {}; },
    ...fakeArchive({ tree: ['skills/xlsx/SKILL.md'] }),
    registerFn: () => { throw new Error('등록을 부르면 안 된다'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'pending');
  assert.ok(fs.existsSync(path.join(dest, 'previous-run-marker.txt')), '이번 실행 전부터 있던 dest 는 실패해도 지우면 안 된다');
  fs.rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// ⑥-3 startLogin / loginStatus
// ===========================================================================

test('startLogin: credential present AND an account already connected -> reused, no window', async () => {
  const root = tmpRoot('reuse');
  let opened = 0;
  const r = await startLogin({
    provider: 'claude', root,
    cliLoginStatusFn: () => 'done',
    countAccountsFn: async () => 1,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    startCliLoginFn: () => { opened++; return { started: true, pid: 1 }; },
  });
  assert.deepEqual({ ok: r.ok, state: r.state, reused: r.reused }, { ok: true, state: 'done', reused: true });
  assert.equal(opened, 0, 'the person must not be asked to log in again');
  assert.equal(readReceipt(root).login.claude.reused, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('startLogin: credential present but NO account yet -> the window still opens', async () => {
  const root = tmpRoot('noaccount');
  let opened = 0;
  const r = await startLogin({
    provider: 'claude', root,
    cliLoginStatusFn: () => 'done',
    countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    startCliLoginFn: () => { opened++; return { started: true, pid: 7 }; },
    now: () => 1000,
  });
  assert.deepEqual({ ok: r.ok, state: r.state, reused: r.reused }, { ok: true, state: 'waiting', reused: false });
  assert.equal(opened, 1);
  assert.equal(readReceipt(root).login.claude.startedAt, 1000);
  fs.rmSync(root, { recursive: true, force: true });
});

test('startLogin: retry ignores the reuse rule and reopens the window', async () => {
  const root = tmpRoot('retry');
  let opened = 0;
  const r = await startLogin({
    provider: 'claude', root, retry: true,
    cliLoginStatusFn: () => 'done',
    countAccountsFn: async () => 3,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    startCliLoginFn: () => { opened++; return { started: true, pid: 2 }; },
  });
  assert.equal(r.state, 'waiting');
  assert.equal(opened, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

function loginDeps(root, over = {}) {
  return {
    provider: 'claude', root,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    cliLoginStatusFn: () => 'pending',
    relayStatusFn: async () => 'pending',
    relayImportFn: async () => ({ ok: true, method: 'import' }),
    countFn: async () => 0,
    probe: async () => ({ reachable: true, status: 200 }),
    ...over,
  };
}

test('loginStatus: before the 2 minutes are up -> still waiting', async () => {
  const root = tmpRoot('waiting');
  await startLogin({
    provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
  const r = await loginStatus(loginDeps(root, { now: () => 60000 }));
  assert.deepEqual({ state: r.state, reason: r.reason }, { state: 'waiting', reason: null });
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: reason ⓐ window-closed -- 2 minutes, no credential, login page fine', async () => {
  const root = tmpRoot('closed');
  await startLogin({
    provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
  const r = await loginStatus(loginDeps(root, { now: () => 130000, probe: async () => ({ reachable: true, status: 200 }) }));
  assert.deepEqual({ state: r.state, reason: r.reason }, { state: 'failed', reason: 'window-closed' });
  assert.equal(readReceipt(root).login.claude.reason, 'window-closed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: reason ⓑ page-blocked -- the login host stopped answering', async () => {
  const root = tmpRoot('blocked');
  await startLogin({
    provider: 'chatgpt', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
  const probed = [];
  const r = await loginStatus(loginDeps(root, {
    provider: 'chatgpt', now: () => 130000,
    probe: async (url) => { probed.push(url); return { reachable: false }; },
  }));
  assert.deepEqual({ state: r.state, reason: r.reason }, { state: 'failed', reason: 'page-blocked' });
  assert.deepEqual(probed, [HOSTS.chatgpt], 'the provider’s own login host is re-probed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: reason ⓒ import-failed -- credential exists, relay import refuses', async () => {
  const root = tmpRoot('importfail');
  await startLogin({
    provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
  let imports = 0;
  const deps = loginDeps(root, {
    cliLoginStatusFn: () => 'done',
    relayImportFn: async () => { imports++; return { ok: false, reason: 'config-unreadable' }; },
    now: () => 1000,
  });
  const first = await loginStatus(deps);
  assert.deepEqual({ state: first.state, reason: first.reason }, { state: 'failed', reason: 'import-failed' });

  // A poll route calls this repeatedly: the import must be attempted ONCE.
  const second = await loginStatus(deps);
  assert.deepEqual({ state: second.state, reason: second.reason }, { state: 'failed', reason: 'import-failed' });
  assert.equal(imports, 1, 'the relay hand-over is attempted once, not once per poll');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: import failed -> the automatic `login` retry runs once and is reported', async () => {
  const root = tmpRoot('autoretry');
  await startLogin({
    provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
  let imports = 0;
  // method:'login' = relayImport's own fallback -- `import --from` failed, so
  // it started the relay's interactive login instead.
  const deps = loginDeps(root, {
    cliLoginStatusFn: () => 'done',
    relayImportFn: async () => { imports++; return { ok: true, method: 'login' }; },
    now: () => 1000,
  });
  const first = await loginStatus(deps);
  assert.deepEqual({ state: first.state, reason: first.reason }, { state: 'cli-done', reason: 'import-failed' });

  const second = await loginStatus(deps);
  assert.equal(imports, 1, 'the automatic retry happens once');
  assert.equal(second.state, 'cli-done');

  // Once the retry's account lands, the next poll is simply done.
  const third = await loginStatus(loginDeps(root, {
    cliLoginStatusFn: () => 'done', relayStatusFn: async () => 'done', now: () => 2000,
  }));
  assert.deepEqual({ state: third.state, relay: third.relay }, { state: 'done', relay: 'done' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: import succeeds and the account appears -> done', async () => {
  const root = tmpRoot('logindone');
  await startLogin({
    provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
  let calls = 0;
  const r = await loginStatus(loginDeps(root, {
    cliLoginStatusFn: () => 'done',
    relayStatusFn: async () => (++calls > 1 ? 'done' : 'pending'),
    now: () => 1000,
  }));
  assert.deepEqual({ state: r.state, cli: r.cli, relay: r.relay, reason: r.reason }, { state: 'done', cli: 'done', relay: 'done', reason: null });
  assert.equal(readReceipt(root).login.claude.state, 'done');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: 같은 계정 다시 로그인 -- 가져오기 성공인데 개수가 그대로면 계정이 있는 것으로 done (2.0.38)', async () => {
  // 2026-09-23 다른 PC 실측: 중계기가 같은 신원의 칸을 고쳐 쓸 뿐이라 개수가 안 늘어 "옮겨 담는 중"에서 멈췄다.
  const root = tmpRoot('dedup');
  await startLogin({
    provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 1,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
  const r = await loginStatus(loginDeps(root, {
    cliLoginStatusFn: () => 'done', countFn: async () => 1, now: () => 1000,
  }));
  assert.deepEqual({ state: r.state, relay: r.relay }, { state: 'done', relay: 'done' });
  assert.equal(readReceipt(root).login.claude.state, 'done');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: 가져오기 성공 뒤 계정이 늦게 보여도 다음 확인에서 done, 없으면 기다림 (2.0.38)', async () => {
  const root = tmpRoot('dedup-late');
  await startLogin({
    provider: 'chatgpt', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
  let n = 0;
  const deps = loginDeps(root, { provider: 'chatgpt', cliLoginStatusFn: () => 'done', countFn: async () => n, now: () => 1000 });
  const first = await loginStatus(deps);
  assert.equal(first.state, 'cli-done', '계정이 하나도 없으면 아직 끝난 것이 아니다');
  n = 1;
  const second = await loginStatus(deps);
  assert.deepEqual({ state: second.state, relay: second.relay }, { state: 'done', relay: 'done' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('loginStatus: 자동 재시도(method login) 창은 계정 수가 늘어야만 done -- 이미 있던 계정만으로는 끝내지 않는다', async () => {
  const root = tmpRoot('login-fallback');
  await startLogin({
    provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 1,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
  const deps = loginDeps(root, {
    cliLoginStatusFn: () => 'done', countFn: async () => 1,
    relayImportFn: async () => ({ ok: true, method: 'login' }), now: () => 1000,
  });
  assert.equal((await loginStatus(deps)).state, 'cli-done');
  assert.equal((await loginStatus(deps)).state, 'cli-done');
  fs.rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// ⑥-4 startRelay
// ===========================================================================

test('startRelay: alive + healthy -> done with the account count, zero model calls', async () => {
  const root = tmpRoot('relayok');
  const counted = [];
  const r = await startRelay({
    root,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    ensureProxyFn: async () => ({ alive: true, started: false }),
    healthFn: async () => ({ ok: true, status: 200 }),
    countAccountsFn: async ({ provider }) => { counted.push(provider); return provider === 'claude' ? 2 : 1; },
  });
  assert.deepEqual({ ok: r.ok, state: r.state, accounts: r.accounts }, { ok: true, state: 'done', accounts: 3 });
  assert.deepEqual(counted, ['claude', 'chatgpt']);
  assert.equal(readReceipt(root).online.relay.state, 'done');
  fs.rmSync(root, { recursive: true, force: true });
});

test('startRelay: 옛 설정(proxy.port 없음)은 계정을 건드리지 않고 빠진 칸만 채운 뒤 띄운다 (2.0.8)', async () => {
  // 2026-09-17 실제 사용자 실측: "This helper manages only the TeamClaude proxy on port 3456".
  const root = tmpRoot('relaypatch');
  const cfg = path.join(root, 'tc.json');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ accounts: [{ id: 'a1', provider: 'chatgpt', name: 'kept' }] }), 'utf8');
  const seen = [];
  const r = await startRelay({
    root,
    resolveConfigPathFn: () => cfg,
    ensureProxyFn: async (a) => { seen.push(JSON.parse(fs.readFileSync(a.teamclaudeConfigPath, 'utf8'))); return { alive: true, started: true }; },
    healthFn: async () => ({ ok: true, status: 200 }),
    countAccountsFn: async ({ provider }) => (provider === 'chatgpt' ? 1 : 0),
  });
  assert.equal(r.ok, true);
  const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(after.proxy.port, 3456, '중계기를 띄우기 전에 proxy.port 가 채워져 있다');
  assert.equal(seen[0].proxy.port, 3456, 'ensureProxy 가 읽는 시점에 이미 채워져 있다');
  assert.deepEqual(after.accounts, [{ id: 'a1', provider: 'chatgpt', name: 'kept' }], '계정은 한 글자도 안 바뀐다');
  fs.rmSync(root, { recursive: true, force: true });
});

test('startRelay: 실행 중계기의 계정 수가 설정 파일과 다르면 실패 — 다른 TeamClaude 가 3456 을 쓰는 PC (TC-02, 2.0.13)', async () => {
  // 2026-09-18 실사용 진단: 전역 1.2.1(계정 5개)이 3456 을 쓰는데 IRIS 파일(1개) 수로 "연결됨"이라 기록됐다.
  const root = tmpRoot('relaymismatch');
  const r = await startRelay({
    root,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    ensureProxyFn: async () => ({ alive: true, started: false }),
    healthFn: async () => ({ ok: true, status: 200, liveAccounts: 5 }),
    countAccountsFn: async ({ provider }) => (provider === 'chatgpt' ? 1 : 0),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.relay);
  assert.match(r.message, /우리 설정 파일을 읽고 있지 않습니다\(중계기 계정 5개, 설정 파일 1개\)/);
  assert.equal(readReceipt(root).online.relay.state, 'failed');

  // 실행 중계기가 목록을 안 주면(옛 실행본) 파일 수로 판정한다(이전 동작 유지).
  const r2 = await startRelay({
    root,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    ensureProxyFn: async () => ({ alive: true, started: false }),
    healthFn: async () => ({ ok: true, status: 200, liveAccounts: null }),
    countAccountsFn: async ({ provider }) => (provider === 'chatgpt' ? 1 : 0),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.accounts, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('startRelay: will not start -> E-ONLINE-RELAY', async () => {
  const root = tmpRoot('relayfail');
  const r = await startRelay({
    root,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    ensureProxyFn: async () => ({ alive: false, started: true }),
    healthFn: async () => ({ ok: false, status: null }),
    countAccountsFn: async () => 0,
  });
  assert.deepEqual({ ok: r.ok, state: r.state, code: r.code, accounts: r.accounts }, { ok: false, state: 'failed', code: CODES.relay, accounts: 0 });
  assert.equal(readReceipt(root).online.relay.state, 'failed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('startRelay: answers on the port but is not the relay -> failed', async () => {
  const root = tmpRoot('relayforeign');
  const r = await startRelay({
    root,
    resolveConfigPathFn: () => path.join(root, 'tc.json'),
    ensureProxyFn: async () => ({ alive: true, started: false }),
    healthFn: async () => ({ ok: false, status: 404 }),
    countAccountsFn: async () => 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.relay);
  fs.rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// 화면 문구 규칙
// ===========================================================================

test('no user-facing message names the relay product', async () => {
  const root = tmpRoot('wording');
  const messages = [];

  messages.push((await checkNet({
    root, subscriptions: ['claude', 'chatgpt'], lock: LOCK, probe: async () => ({ reachable: false }),
  })).message);

  messages.push((await installClaude({ platform: 'win32', 
    root, lock: LOCK, subscriptions: ['claude'],
    fetchFn: async () => { throw new Error('down'); },
    npmInstall: async () => ({ code: 1, out: '', err: 'down' }),
    runFn: async () => ({ code: 1, out: '', err: '' }),
    writeShimsFn: () => ({ written: [] }),
  })).message);

  await startLogin({
    provider: 'claude', root, cliLoginStatusFn: () => 'pending', countAccountsFn: async () => 0,
    resolveConfigPathFn: () => path.join(root, 'tc.json'), startCliLoginFn: () => ({ started: true }), now: () => 0,
  });
  messages.push((await loginStatus(loginDeps(root, { now: () => 130000, probe: async () => ({ reachable: false }) }))).message);
  messages.push((await loginStatus(loginDeps(root, {
    cliLoginStatusFn: () => 'done', relayImportFn: async () => ({ ok: false }), now: () => 1000,
  }))).message);
  messages.push((await startRelay({
    root, resolveConfigPathFn: () => path.join(root, 'tc.json'),
    ensureProxyFn: async () => ({ alive: false }), healthFn: async () => ({ ok: false }), countAccountsFn: async () => 0,
  })).message);

  for (const m of messages) {
    assert.equal(typeof m, 'string');
    assert.ok(!/teamclaude/i.test(m), `a screen sentence must not name the relay product: ${m}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// ⑥-2c installPlaywrightBrowser (macOS, D-M17 개정 2026-10-28)
// ===========================================================================
//
// Chrome·Edge 가 없는 Mac 에서만 Playwright 의 Chrome for Testing 을 잠금표대로 받는다.
// 받는 것·지문 대조·최상위 폴더 확인·Playwright 가 찾는 자리(chromium-<rev>/…, INSTALLATION_COMPLETE)·
// 실패하면 아무것도 남기지 않고 pending 인 것을 본다(인터넷도 tar 도 쓰지 않는다 — 전부 주입).

const CFT_ZIP = Buffer.from('PK fake chrome-mac-arm64.zip');
const CFT_LOCK = {
  parts: {
    'playwright-chromium': {
      kind: 'url', version: '154.0.8037.0', revision: '1244',
      url: 'https://cdn.playwright.dev/builds/cft/154.0.8037.0/mac-arm64/chrome-mac-arm64.zip',
      sha256: crypto.createHash('sha256').update(CFT_ZIP).digest('hex'), bytes: CFT_ZIP.length,
      top: 'chrome-mac-arm64',
      executable: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      dest: '_agent/shared/tools/playwright-browsers/chromium-1244', redistribute: 'download',
    },
  },
};
const CFT_EXE = CFT_LOCK.parts['playwright-chromium'].executable;
const noBrowser = () => ({ present: false, channel: null, path: null });
function cftFakes({ bytes = CFT_ZIP, top = 'chrome-mac-arm64', withExe = true } = {}) {
  const asked = [];
  return {
    asked,
    downloadFn: async (url, dest) => {
      asked.push(url);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    },
    listArchiveFn: async () => [`${top}/`, `${top}/ABOUT`, `${top}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`],
    extractZipFn: async (zip, dest, opts = {}) => {
      assert.ok(!opts.strip, '최상위 폴더(chrome-mac-arm64)를 벗기지 않는다 — Playwright 가 그 이름으로 찾는다');
      const f = withExe ? path.join(dest, ...CFT_EXE.split('/')) : path.join(dest, top, 'ABOUT');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '#!/bin/sh\n');
    },
  };
}
const cftDest = (root) => path.join(root, ...CFT_LOCK.parts['playwright-chromium'].dest.split('/'));

test('installPlaywrightBrowser: Chrome·Edge 가 없는 Mac 은 Chrome for Testing 을 받아 Playwright 가 찾는 자리에 놓는다', async () => {
  const root = tmpRoot('cft');
  const f = cftFakes();
  const r = await installPlaywrightBrowser({ root, lock: CFT_LOCK, platform: 'darwin', browserCheckFn: noBrowser, env: {}, ...f });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'done');
  assert.deepEqual(f.asked, [CFT_LOCK.parts['playwright-chromium'].url]);
  const dest = cftDest(root);
  assert.ok(fs.existsSync(path.join(dest, ...CFT_EXE.split('/'))), '실행 파일이 chromium-1244/chrome-mac-arm64/… 에');
  assert.ok(fs.existsSync(path.join(dest, 'INSTALLATION_COMPLETE')), 'Playwright 설치 완료 표식');
  assert.ok(!fs.existsSync(`${dest}.partial`), '임시 폴더가 남지 않는다');
  assert.deepEqual(fs.readdirSync(path.join(root, '_agent', 'setup', 'downloads')), [], '받은 zip 은 지운다');
  const rec = readReceipt(root).installed[PLAYWRIGHT_BROWSER_PART];
  assert.equal(rec.state, 'installed');
  assert.equal(rec.revision, '1244');
  assert.equal(rec.path.replace(/\\/g, '/'), '_agent/shared/tools/playwright-browsers/chromium-1244', '영수증 경로(영수증은 \\ 로 적는 관례)');
  // 두 번째 실행 = 이미 있음(다시 받지 않는다)
  const again = await installPlaywrightBrowser({ root, lock: CFT_LOCK, platform: 'darwin', browserCheckFn: noBrowser, env: {}, ...cftFakes() });
  assert.equal(again.source, 'existing');
  fs.rmSync(root, { recursive: true, force: true });
});

test('installPlaywrightBrowser: 시스템에 Chrome·Edge 가 있으면·Windows 면·잠금표에 없으면 받지 않는다', async () => {
  const root = tmpRoot('cft-skip');
  const f = cftFakes();
  const sys = await installPlaywrightBrowser({ root, lock: CFT_LOCK, platform: 'darwin', browserCheckFn: () => ({ present: true, channel: 'chrome', path: '/Applications/Google Chrome.app' }), env: {}, ...f });
  assert.deepEqual([sys.state, sys.reason, sys.channel], ['skipped', 'system-browser', 'chrome']);
  assert.equal(readReceipt(root).installed[PLAYWRIGHT_BROWSER_PART].reason, 'system-browser');
  const win = await installPlaywrightBrowser({ root, lock: CFT_LOCK, platform: 'win32', browserCheckFn: noBrowser, env: {}, ...f });
  assert.deepEqual([win.state, win.reason], ['skipped', 'windows']);
  const none = await installPlaywrightBrowser({ root, lock: { parts: {} }, platform: 'darwin', browserCheckFn: noBrowser, env: {}, ...f });
  assert.deepEqual([none.state, none.reason], ['skipped', 'not-in-lock']);
  assert.equal(f.asked.length, 0, '어느 경우에도 내려받지 않는다');
  assert.ok(!fs.existsSync(cftDest(root)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('installPlaywrightBrowser: 지문이 다르거나·최상위 폴더가 다르거나·실행 파일이 없으면 pending 이고 아무것도 남기지 않는다', async () => {
  for (const [name, opts] of [['sha', { bytes: Buffer.from('tampered') }], ['top', { top: 'chrome-mac-x64' }], ['exe', { withExe: false }]]) {
    const root = tmpRoot(`cft-${name}`);
    const r = await installPlaywrightBrowser({ root, lock: CFT_LOCK, platform: 'darwin', browserCheckFn: noBrowser, env: {}, ...cftFakes(opts) });
    assert.equal(r.ok, false, name);
    assert.equal(r.state, 'pending', name);
    assert.equal(r.code, CODES.browser, name);
    assert.match(r.message, /Chrome 을 설치하면/, name);
    assert.ok(!fs.existsSync(cftDest(root)) && !fs.existsSync(`${cftDest(root)}.partial`), `${name}: 반쯤 놓인 브라우저가 없다`);
    assert.deepEqual(fs.readdirSync(path.join(root, '_agent', 'setup', 'downloads')), [], `${name}: 받은 zip 도 지운다`);
    assert.equal(readReceipt(root).installed[PLAYWRIGHT_BROWSER_PART].state, 'pending', name);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installPlaywrightBrowser: 오프라인이면 받지 않고 pending', async () => {
  const root = tmpRoot('cft-offline');
  const f = cftFakes();
  const r = await installPlaywrightBrowser({ root, lock: CFT_LOCK, platform: 'darwin', browserCheckFn: noBrowser, env: { IRIS_INSTALLER_OFFLINE: '1' }, ...f });
  assert.equal(r.state, 'pending');
  assert.equal(f.asked.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ⑥-2d installIeumOffice (macOS, D-M21 2026-10-28)
// ---------------------------------------------------------------------------
// 문서 보조 엔진 이음오피스를 공식 GitHub 릴리스(잠금표 주소·지문 고정)에서 받아 tools/ieumoffice 에 둔다.
// 브라우저와 같은 내려받기 순서를 쓰고, 다 풀린 표식에 지문을 적어 잠금표의 판이 바뀌면 다시 받는다.

const IO_ZIP = Buffer.from('PK fake IeumOffice-arm64-mac.zip');
const IO_EXE = 'IeumOffice.app/Contents/Resources/cli/ieumoffice';
const ioLock = (bytes = IO_ZIP) => ({
  parts: {
    ieumoffice: {
      kind: 'url', version: '0.12.7',
      url: 'https://github.com/pblsketch/openoffice/releases/download/v0.12.7/IeumOffice-0.12.7-arm64-mac.zip',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      top: 'IeumOffice.app', executable: IO_EXE, dest: '_agent/shared/tools/ieumoffice', redistribute: 'download',
    },
  },
});
function ioFakes({ bytes = IO_ZIP, top = 'IeumOffice.app', withExe = true } = {}) {
  const asked = [];
  return {
    asked,
    downloadFn: async (url, dest) => {
      asked.push(url);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    },
    listArchiveFn: async () => [`${top}/`, `${top}/Contents/Info.plist`, `${top}/Contents/Resources/cli/ieumoffice`],
    extractZipFn: async (zip, dest) => {
      const f = withExe ? path.join(dest, ...IO_EXE.split('/')) : path.join(dest, top, 'Contents', 'Info.plist');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '#!/bin/sh\n');
    },
  };
}
const ioDest = (root) => path.join(root, '_agent', 'shared', 'tools', 'ieumoffice');

test('installIeumOffice: 공식 릴리스를 받아 tools/ieumoffice 에 두고, 같은 판이면 다시 받지 않는다', async () => {
  const root = tmpRoot('io');
  const lock = ioLock();
  const f = ioFakes();
  const r = await installIeumOffice({ root, lock, platform: 'darwin', env: {}, ...f });
  assert.deepEqual([r.ok, r.state, r.source], [true, 'done', 'github-release']);
  assert.deepEqual(f.asked, [lock.parts.ieumoffice.url]);
  assert.ok(fs.existsSync(path.join(ioDest(root), ...IO_EXE.split('/'))), '앱 안 명령어가 심이 찾는 자리에');
  assert.equal(fs.readFileSync(path.join(ioDest(root), 'INSTALLATION_COMPLETE'), 'utf8').trim(), lock.parts.ieumoffice.sha256, '완료 표식 = 받은 판의 지문');
  assert.ok(!fs.existsSync(`${ioDest(root)}.partial`));
  assert.deepEqual(fs.readdirSync(path.join(root, '_agent', 'setup', 'downloads')), [], '받은 zip 은 지운다');
  const rec = readReceipt(root).installed[IEUMOFFICE_PART];
  assert.deepEqual([rec.state, rec.version, rec.source], ['installed', '0.12.7', 'github-release']);
  const again = await installIeumOffice({ root, lock, platform: 'darwin', env: {}, ...ioFakes() });
  assert.equal(again.source, 'existing');
  // 잠금표의 판(지문)이 바뀌면 다시 받는다
  const next = Buffer.from('PK fake IeumOffice-0.12.8');
  const f2 = ioFakes({ bytes: next });
  const upgraded = await installIeumOffice({ root, lock: ioLock(next), platform: 'darwin', env: {}, ...f2 });
  assert.deepEqual([upgraded.state, upgraded.source, f2.asked.length], ['done', 'github-release', 1]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('installIeumOffice: Windows·잠금표에 없음은 건너뛰고, 실패·오프라인은 pending 이며 아무것도 남기지 않는다', async () => {
  const root = tmpRoot('io-skip');
  const f = ioFakes();
  assert.deepEqual(Object.values(await installIeumOffice({ root, lock: ioLock(), platform: 'win32', env: {}, ...f })).slice(1, 3), ['skipped', 'windows']);
  assert.equal((await installIeumOffice({ root, lock: { parts: {} }, platform: 'darwin', env: {}, ...f })).reason, 'not-in-lock');
  const off = await installIeumOffice({ root, lock: ioLock(), platform: 'darwin', env: { IRIS_INSTALLER_OFFLINE: '1' }, ...f });
  assert.deepEqual([off.state, off.code], ['pending', CODES.ieumoffice]);
  assert.equal(f.asked.length, 0, '여기까지는 내려받지 않는다');
  fs.rmSync(root, { recursive: true, force: true });
  for (const [name, opts] of [['sha', { bytes: Buffer.from('tampered') }], ['top', { top: 'Other.app' }], ['exe', { withExe: false }]]) {
    const r2 = tmpRoot(`io-${name}`);
    const r = await installIeumOffice({ root: r2, lock: ioLock(), platform: 'darwin', env: {}, ...ioFakes(opts) });
    assert.deepEqual([r.ok, r.state, r.code], [false, 'pending', CODES.ieumoffice], name);
    assert.match(r.message, /파이썬 라이브러리와 문서 MCP/, name);
    assert.ok(!fs.existsSync(ioDest(r2)) && !fs.existsSync(`${ioDest(r2)}.partial`), `${name}: 반쯤 놓인 앱이 없다`);
    assert.equal(readReceipt(r2).installed[IEUMOFFICE_PART].state, 'pending', name);
    fs.rmSync(r2, { recursive: true, force: true });
  }
});
