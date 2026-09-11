import { test, after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  resolveGuide, firstRequestText, writeFirstRequest, firstRequestPath,
  faceLauncherContent, writeFaceLauncher,
  writeFirstSessionSpec, defaultSpecFor, launchFace, waitFaceReady,
  finish, faceDirFor,
} from '../installer/lib/handoff.mjs';
import { newReceipt, writeReceipt, readReceipt } from '../installer/lib/receipt.mjs';
import { startServer } from '../installer/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-handoff-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// A manifest shaped like the real payload one: guides fan out into
// `guides:<basename>` keys (build/collect.mjs), and the package-wide
// guideVersion -- not a per-part version -- is the guides' identity.
const GUIDE_CLAUDE = '비서 에이전트 세팅가이드(Claude 실행판)_v9_2026-09-07_최신.md';
const GUIDE_CODEX = '비서 에이전트 세팅가이드(Codex 실행판)_v9_2026-09-07_최신.md';
const MANIFEST = {
  schema: 1,
  package: { name: 'IRIS', version: '1.0.0', guideVersion: '9', license: 'MIT' },
  parts: {
    node: { version: '24.17.0', sha256: 'x' },
    [`guides:${GUIDE_CLAUDE}`]: { sha256: 'a' },
    [`guides:${GUIDE_CODEX}`]: { sha256: 'b' },
  },
};

function freshRoot(label) {
  const root = path.join(tmp, label);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// writeFirstRequest -- docs/설계.md 4-2
// ---------------------------------------------------------------------------

test('resolveGuide picks the edition\'s guide out of the manifest (never a hard-coded filename)', () => {
  const claude = resolveGuide(MANIFEST, 'claude');
  assert.equal(claude.basename, GUIDE_CLAUDE);
  assert.equal(claude.version, '9');

  // The choice step's vocabulary is claude|chatgpt; the guide edition file is
  // named "Codex 실행판".
  assert.equal(resolveGuide(MANIFEST, 'chatgpt').basename, GUIDE_CODEX);
  assert.equal(resolveGuide(MANIFEST, 'codex').basename, GUIDE_CODEX);

  assert.equal(resolveGuide({ parts: {} }, 'claude'), null);
});

test('writeFirstRequest: three sentences, real absolute paths, manifest-resolved guide filename + guideVersion', () => {
  const root = freshRoot('first-request');
  const result = writeFirstRequest(root, { edition: 'claude', manifest: MANIFEST });

  assert.equal(result.path, path.join(root, '_agent', 'setup', 'first-request.txt'));
  assert.equal(result.path, firstRequestPath(root));
  const text = fs.readFileSync(result.path, 'utf8');

  // ① 계약서(세팅가이드) 위치 -- the real root, the manifest's real filename,
  // and the manifest's guideVersion inside that filename. Never "_v10.md".
  const guidePath = path.join(root, '_setup-guides', GUIDE_CLAUDE);
  assert.ok(text.includes(guidePath), `guide path missing: ${text}`);
  assert.ok(GUIDE_CLAUDE.includes(`_v${MANIFEST.package.guideVersion}_`));
  assert.ok(!/_v10\.md/.test(text));

  // ② 인수인계 노트(영수증) 위치
  assert.ok(text.includes(path.join(root, '_agent', 'setup', 'package-receipt.json')));

  // ③ 일반 문장으로 물어보라 (Face 노란 카드 방지)
  assert.ok(text.includes('일반 문장'));

  // Exactly three sentences.
  const sentences = text.trim().split(/(?<=\.)\s+/).filter(Boolean);
  assert.equal(sentences.length, 3, `expected 3 sentences, got ${sentences.length}: ${text}`);

  // Absolute paths only -- no relative "_setup-guides\..." form.
  assert.ok(!/(^|\s)_setup-guides/.test(text));

  // Codex edition writes the Codex guide.
  const root2 = freshRoot('first-request-codex');
  const r2 = writeFirstRequest(root2, { edition: 'chatgpt', manifest: MANIFEST });
  assert.ok(fs.readFileSync(r2.path, 'utf8').includes(GUIDE_CODEX));
});

test('writeFirstRequest throws a coded error when the manifest carries no guide', () => {
  const root = freshRoot('first-request-noguide');
  assert.throws(
    () => writeFirstRequest(root, { edition: 'claude', manifest: { parts: {} } }),
    (err) => err.code === 'no-guide-in-manifest',
  );
});

test('firstRequestText is a single line (the prompt is typed into a terminal)', () => {
  const text = firstRequestText({ root: 'C:\\NOVA', guideBasename: GUIDE_CLAUDE });
  assert.equal(text.split('\n').length, 1);
});

// ---------------------------------------------------------------------------
// writeFaceLauncher
// ---------------------------------------------------------------------------

test('faceLauncherContent: ASCII-only, CRLF, chcp 65001, %~dp0-relative, no absolute soul path', () => {
  const content = faceLauncherContent();

  assert.ok(/^[\x20-\x7e\r\n\t]*$/.test(content), 'launcher content must be ASCII-only');
  // Every LF is part of a CRLF pair and there is no bare CR.
  assert.equal(content.replace(/\r\n/g, ''), content.replace(/[\r\n]/g, ''));
  assert.ok(content.startsWith('@echo off\r\n'));
  assert.ok(content.includes('chcp 65001 >nul'));
  assert.ok(content.includes('setlocal'));
  assert.ok(content.includes('"%~dp0_agent\\shared\\tools\\node\\node.exe"'));
  assert.ok(content.includes('"%~dp0_agent\\shared\\tools\\face\\launch.mjs"'));
  assert.ok(content.includes('%*'), 'must forward its own arguments');

  // No hard-coded soul path and no IRIS_FACE_HWP_PY line (this PC's
  // IRIS-Face.cmd has both; the installed launcher must have neither).
  assert.ok(!/[A-Za-z]:\\/.test(content), 'no absolute path may appear');
  assert.ok(!content.includes('IRIS_FACE_HWP_PY'));
});

test('writeFaceLauncher writes "<name> Face.cmd" at the soul root and a desktop .lnk via WScript.Shell', async () => {
  const root = freshRoot('launcher');
  const desktopDir = path.join(tmp, 'fake-desktop');
  fs.mkdirSync(desktopDir, { recursive: true });

  const calls = [];
  const runPs = async (script) => { calls.push(script); return { code: 0, out: '', err: '' }; };

  const res = await writeFaceLauncher(root, 'NOVA', { desktopDir, runPs });

  assert.equal(res.cmdPath, path.join(root, 'NOVA Face.cmd'));
  assert.equal(fs.readFileSync(res.cmdPath, 'utf8'), faceLauncherContent());
  assert.equal(res.lnkPath, path.join(desktopDir, 'NOVA Face.lnk'));
  assert.equal(res.shortcut.ok, true);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('WScript.Shell'));
  assert.ok(calls[0].includes('CreateShortcut'));
  assert.ok(calls[0].includes(res.cmdPath));
  assert.ok(calls[0].includes(desktopDir), 'the shortcut must land in the injected desktop dir');
});

test('writeFaceLauncher: a failing shortcut is reported, not fatal (the .cmd still exists)', async () => {
  const root = freshRoot('launcher-fail');
  const desktopDir = path.join(tmp, 'fake-desktop-2');
  fs.mkdirSync(desktopDir, { recursive: true });
  const runPs = async () => ({ code: 1, out: '', err: 'access denied' });

  const res = await writeFaceLauncher(root, 'NOVA', { desktopDir, runPs });
  assert.ok(fs.existsSync(res.cmdPath));
  assert.equal(res.shortcut.ok, false);
  assert.ok(String(res.shortcut.detail).includes('access denied'));
});

// ---------------------------------------------------------------------------
// spec / launchFace / waitFaceReady / finish
// ---------------------------------------------------------------------------

test('writeFirstSessionSpec: Face-shaped spec (cwd/agent/model/effort/promptFile), chatgpt -> codex', () => {
  const root = freshRoot('spec');
  const promptFile = path.join(root, '_agent', 'setup', 'first-request.txt');

  const claude = writeFirstSessionSpec(root, { leadAgent: 'claude', promptFile });
  assert.equal(claude.path, path.join(root, '_agent', 'setup', 'first-session.json'));
  const spec = JSON.parse(fs.readFileSync(claude.path, 'utf8'));
  assert.deepEqual(spec, { cwd: root, agent: 'claude', model: 'opus', effort: 'high', promptFile });

  const codex = writeFirstSessionSpec(root, { leadAgent: 'chatgpt', promptFile });
  assert.equal(JSON.parse(fs.readFileSync(codex.path, 'utf8')).agent, 'codex');
  assert.equal(defaultSpecFor('chatgpt').model, 'gpt-5.6-terra');

  // Overrides (used by the rehearsal to pick a cheap model).
  const cheap = writeFirstSessionSpec(root, { leadAgent: 'claude', promptFile, model: 'haiku', effort: 'low' });
  const cheapSpec = JSON.parse(fs.readFileSync(cheap.path, 'utf8'));
  assert.equal(cheapSpec.model, 'haiku');
  assert.equal(cheapSpec.effort, 'low');
});

test('launchFace spawns the bundled node on <tools>\\face\\launch.mjs --first-session, detached', () => {
  const root = freshRoot('launch');
  fs.mkdirSync(path.join(root, '_agent', 'setup'), { recursive: true });
  const specPath = path.join(root, '_agent', 'setup', 'first-session.json');

  const seen = [];
  const spawnFn = (exe, args, opts) => {
    seen.push({ exe, args, opts });
    return { pid: 4242, unref() {} };
  };

  const res = launchFace({ root, spec: specPath, spawnFn, port: 3458 });
  assert.equal(res.pid, 4242);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].exe, path.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe'));
  assert.deepEqual(seen[0].args, [
    path.join(faceDirFor(root), 'launch.mjs'),
    '--first-session', specPath,
    '--port', '3458',
  ]);
  assert.equal(seen[0].opts.detached, true);

  // faceDir/extraArgs/nodeExe are injectable (the rehearsal points at the P02
  // source tree on a spare port with --no-open).
  const seen2 = [];
  launchFace({
    root,
    spec: specPath,
    faceDir: 'X:\\face-src',
    nodeExe: 'X:\\node\\node.exe',
    port: 3466,
    extraArgs: ['--no-open'],
    env: { IRIS_FACE_PORT: '3466' },
    spawnFn: (exe, args, opts) => { seen2.push({ exe, args, opts }); return { pid: 7, unref() {} }; },
  });
  assert.equal(seen2[0].exe, 'X:\\node\\node.exe');
  assert.equal(seen2[0].args[0], path.join('X:\\face-src', 'launch.mjs'));
  assert.ok(seen2[0].args.includes('--no-open'));
  assert.equal(seen2[0].opts.env.IRIS_FACE_PORT, '3466');
});

test('waitFaceReady requires 200 AND sessions >= 1, and times out with ok:false', async () => {
  let call = 0;
  const fetchFn = async () => {
    call += 1;
    if (call === 1) throw new Error('ECONNREFUSED');
    if (call === 2) return { ok: true, json: async () => ({ ok: true, sessions: 0, version: '2.45.0' }) };
    return { ok: true, json: async () => ({ ok: true, sessions: 1, version: '2.45.0' }) };
  };
  const ready = await waitFaceReady({ port: 3466, timeoutMs: 5000, intervalMs: 1, fetchFn });
  assert.equal(ready.ok, true);
  assert.equal(ready.health.sessions, 1);
  assert.equal(call, 3);

  const never = await waitFaceReady({
    port: 3466, timeoutMs: 30, intervalMs: 1,
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(never.ok, false);
  assert.ok(never.tries >= 1);
});

test('finish: steps.handoff=done, node cache removed, quit called', () => {
  const root = freshRoot('finish');
  const receipt = newReceipt({ root, name: 'NOVA', manifest: MANIFEST, createdBy: 'package-installer' });
  writeReceipt(root, receipt);

  const workDir = path.join(tmp, 'work-finish');
  fs.mkdirSync(path.join(workDir, 'node'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'node', 'node.exe'), 'not really', 'utf8');

  let quit = 0;
  const steps = [];
  const res = finish({
    root, receipt, workDir,
    quit: () => { quit += 1; },
    setStep: (s) => steps.push(s),
    deferRemove: false,
  });

  assert.equal(res.ok, true);
  assert.equal(res.cacheRemoved, true);
  assert.equal(fs.existsSync(path.join(workDir, 'node')), false);
  assert.equal(readReceipt(root).steps.handoff, 'done');
  assert.deepEqual(steps, ['done']);
  assert.equal(quit, 1);
});

// ---------------------------------------------------------------------------
// installer/ui/index.html
// ---------------------------------------------------------------------------

// Check ④ of verify/static.mjs compares the `:root { ... }` custom-property
// block of Face's app/style.css with the one in installer/ui/index.html. Do
// the same here so the repo's own test suite catches a drift without needing
// a built zip. P02 is a sibling checkout, so skip loudly when it is absent.
function faceStyleCss() {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
  const css = path.resolve(REPO, lock.parts.face.source, 'app', 'style.css');
  return fs.existsSync(css) ? css : null;
}

function extractRootBlock(css) {
  const idx = css.indexOf(':root');
  if (idx === -1) return null;
  const braceStart = css.indexOf('{', idx);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(idx, i + 1); }
  }
  return null;
}

test('ui/index.html: no "TeamClaude", no external CDN/font, 20-cell progress bar, 6 step cards', () => {
  const html = fs.readFileSync(path.join(REPO, 'installer', 'ui', 'index.html'), 'utf8');

  assert.ok(!html.includes('TeamClaude'), 'the screen never says the tool name "TeamClaude"');
  assert.ok(html.includes('Claude 계정 로그인'));
  assert.ok(html.includes('ChatGPT 계정 로그인'));

  // Single file: no external resources at all (offline install).
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(html), 'no external CDN/font references');
  assert.ok(!/@import/.test(html));

  // 20-cell progress bar, the global rule's characters.
  assert.ok(html.includes('█') && html.includes('░'));
  assert.ok(/BAR_CELLS\s*=\s*20/.test(html), 'progress bar must be 20 cells');
  assert.ok(html.includes('Math.floor'), 'percent is floored, never rounded up');

  // ⓐ~ⓕ step cards.
  for (const mark of ['ⓐ', 'ⓑ', 'ⓒ', 'ⓓ', 'ⓔ', 'ⓕ']) {
    assert.ok(html.includes(mark), `step card ${mark} missing`);
  }

  // Restores from GET /api/state on refresh, and gates on the precheck
  // result (allOk / canProceedOffline) rather than on state.step.
  assert.ok(html.includes('/api/state'));
  assert.ok(html.includes('canProceedOffline'));
  assert.ok(html.includes('allOk'));
  assert.ok(html.includes('reopenAvailable'), 'the login card offers 다시 열기');
});

test('ui/index.html :root block is byte-identical to IRIS-Face app/style.css (static check ④)', (t) => {
  const css = faceStyleCss();
  if (!css) { t.skip('IRIS-Face (P02) sibling checkout not present -- cannot compare the :root block'); return; }
  const faceRoot = extractRootBlock(fs.readFileSync(css, 'utf8'));
  const uiRoot = extractRootBlock(fs.readFileSync(path.join(REPO, 'installer', 'ui', 'index.html'), 'utf8'));
  assert.ok(faceRoot, 'no :root block found in Face style.css');
  assert.equal(uiRoot, faceRoot);
});

// ---------------------------------------------------------------------------
// server wiring
// ---------------------------------------------------------------------------

function handoffServerFixture(label, overrides = {}) {
  const base = path.join(tmp, label);
  const soulRoot = path.join(base, 'soul');
  const zipRoot = path.join(base, 'zip-root');
  fs.mkdirSync(path.join(zipRoot, 'payload'), { recursive: true });
  fs.mkdirSync(soulRoot, { recursive: true });
  fs.writeFileSync(path.join(zipRoot, 'payload', 'manifest.json'), JSON.stringify(MANIFEST), 'utf8');

  const receipt = newReceipt({ root: soulRoot, name: 'NOVA', manifest: MANIFEST, createdBy: 'package-installer' });
  writeReceipt(soulRoot, receipt);

  const stateFile = path.join(base, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    step: 'handoff',
    zipRoot,
    nodeDir: path.join(base, 'node'),
    soul: { name: 'NOVA', root: soulRoot, existing: 'none' },
    choice: { subscriptions: ['claude'], leadAgent: 'claude', guideEdition: 'claude' },
  }), 'utf8');

  return { soulRoot, zipRoot, stateFile, base, overrides };
}

test('POST /api/handoff: first request -> launcher -> launch -> ready -> finish, state.step = done', async () => {
  const fx = handoffServerFixture('server-ok');
  const order = [];
  const { url, close } = await startServer({
    port: 0,
    zipRoot: fx.zipRoot,
    nodeDir: path.join(fx.base, 'node'),
    stateFile: fx.stateFile,
    writeFaceLauncherFn: async (root, name, opts) => {
      order.push('launcher');
      return { cmdPath: path.join(root, `${name} Face.cmd`), lnkPath: null, shortcut: { ok: false, detail: 'skipped in test' } };
    },
    launchFaceFn: (args) => { order.push('launch'); return { pid: 999, command: 'node launch.mjs' }; },
    waitFaceReadyFn: async () => { order.push('ready'); return { ok: true, health: { sessions: 1, version: '2.45.0', pid: 1234 }, tries: 1 }; },
    finishFn: (args) => { order.push('finish'); args.setStep?.('done'); return { ok: true, cacheRemoved: true }; },
  });
  try {
    const res = await fetch(`${url}/api/handoff`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.pid, 999);
    assert.equal(body.sessions, 1);

    // The first-request file is written for real (not injected) -- it is the
    // one artefact the agent actually reads.
    const fr = fs.readFileSync(firstRequestPath(fx.soulRoot), 'utf8');
    assert.ok(fr.includes(GUIDE_CLAUDE));
    assert.ok(fs.existsSync(path.join(fx.soulRoot, '_agent', 'setup', 'first-session.json')));

    assert.deepEqual(order, ['launcher', 'launch', 'ready', 'finish']);

    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.step, 'done');
  } finally {
    await close();
  }
});

test('POST /api/handoff: launch failure -> {ok:false, where:"launch", log}; ready failure -> where:"ready"', async () => {
  const fx = handoffServerFixture('server-fail');
  const { url, close } = await startServer({
    port: 0,
    zipRoot: fx.zipRoot,
    nodeDir: path.join(fx.base, 'node'),
    stateFile: fx.stateFile,
    writeFaceLauncherFn: async (root, name) => ({ cmdPath: path.join(root, `${name} Face.cmd`), lnkPath: null, shortcut: { ok: true } }),
    launchFaceFn: () => { throw new Error('node.exe not found'); },
    waitFaceReadyFn: async () => ({ ok: true, health: { sessions: 1 } }),
    finishFn: () => ({ ok: true }),
  });
  try {
    const body = await (await fetch(`${url}/api/handoff`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).json();
    assert.equal(body.ok, false);
    assert.equal(body.where, 'launch');
    assert.ok(typeof body.log === 'string' && body.log.length > 0);
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.notEqual(state.step, 'done');
  } finally {
    await close();
  }

  const fx2 = handoffServerFixture('server-fail-ready');
  const s2 = await startServer({
    port: 0,
    zipRoot: fx2.zipRoot,
    nodeDir: path.join(fx2.base, 'node'),
    stateFile: fx2.stateFile,
    writeFaceLauncherFn: async (root, name) => ({ cmdPath: path.join(root, `${name} Face.cmd`), lnkPath: null, shortcut: { ok: true } }),
    launchFaceFn: () => ({ pid: 11, command: 'node launch.mjs' }),
    waitFaceReadyFn: async () => ({ ok: false, health: null, tries: 120 }),
    finishFn: () => { throw new Error('finish must not run when the daemon never became ready'); },
  });
  try {
    const body = await (await fetch(`${s2.url}/api/handoff`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).json();
    assert.equal(body.ok, false);
    assert.equal(body.where, 'ready');
    assert.equal(body.pid, 11);
  } finally {
    await s2.close();
  }
});

test('POST /api/handoff without a soul root -> 409', async () => {
  const base = path.join(tmp, 'server-nosoul');
  fs.mkdirSync(base, { recursive: true });
  const { url, close } = await startServer({
    port: 0, zipRoot: path.join(base, 'zip'), nodeDir: path.join(base, 'node'),
    stateFile: path.join(base, 'state.json'),
  });
  try {
    const res = await fetch(`${url}/api/handoff`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, reason: 'no_soul' });
  } finally {
    await close();
  }
});
