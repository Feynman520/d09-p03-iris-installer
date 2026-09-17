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
  checkNet, installClaude, installDocumentSkills, startLogin, loginStatus, startRelay,
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

test('checkNet: claude only -> probes the three claude hosts, not chatgpt.com', async () => {
  const seen = [];
  const r = await checkNet({
    root: 'C:\\FAKE', subscriptions: ['claude'], lock: LOCK,
    probe: async (url) => { seen.push(url); return { reachable: true, status: 200 }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(new Set(r.checked), new Set(['downloads.claude.ai', 'registry.npmjs.org', 'claude.ai']));
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
    probe: async (url) => ({ reachable: url === HOSTS.claudeLogin, status: 200 }),
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

test('installClaude: claude not chosen -> skipped, receipt says why', async () => {
  const root = tmpRoot('skip');
  const r = await installClaude({
    root, lock: LOCK, subscriptions: ['chatgpt'],
    fetchFn: async () => { throw new Error('must not fetch'); },
  });
  assert.deepEqual({ ok: r.ok, state: r.state }, { ok: true, state: 'skipped' });
  assert.deepEqual(readReceipt(root).installed.claude, { state: 'not-installed', reason: 'subscription-not-selected' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('installClaude: the locked version is already there -> source:"existing", no download', async () => {
  const root = tmpRoot('existing');
  const exe = toolsPath(root, 'claude', VERSION, 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'already here');
  const r = await installClaude({
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
  const r = await installClaude({
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
  assert.equal(cmd, claudeForwarderText(VERSION));
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
  await installClaude({
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
  const r = await installClaude({
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
  const r = await installClaude({
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
  const r = await installClaude({
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

  messages.push((await installClaude({
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
