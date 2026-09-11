import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  install, checkRootPath, PART_ORDER, defaultVerifiers, installLogPath, toolsDir,
} from '../installer/lib/install.mjs';
import { writeShims } from '../installer/lib/shims.mjs';
import { writeMinimalSoulState } from '../installer/lib/soulstate.mjs';
import { readReceipt } from '../installer/lib/receipt.mjs';
import {
  portableTeamclaudeConfigDir, portableTeamclaudeConfigPath, resolveTeamclaudeConfigPath,
} from '../installer/lib/login.mjs';
import { run } from '../lib/run.mjs';

const TAR = 'C:\\Windows\\System32\\tar.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-install-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// --------------------------------------------------------------------------
// fake payload -- a zipRoot/payload that has the same *shape* as the real one
// (manifest.json + per-part archives) but weighs a few hundred bytes, so the
// unit tests never touch the 250 MB build output.
// --------------------------------------------------------------------------
async function makeFakePayload(dir, { nodeBody = 'hello-node' } = {}) {
  const payload = path.join(dir, 'payload');
  fs.mkdirSync(path.join(payload, 'node'), { recursive: true });
  fs.mkdirSync(path.join(payload, 'guides'), { recursive: true });

  // node part: one top-level folder, extracted with --strip-components 1
  const src = path.join(dir, '_src', 'node-vX-win-x64');
  fs.rmSync(path.join(dir, '_src'), { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'hello.txt'), nodeBody, 'utf8');
  const zip = path.join(payload, 'node', 'fake-node.zip');
  fs.rmSync(zip, { force: true });
  const r = await run(TAR, ['-a', '-cf', zip, '-C', path.join(dir, '_src'), 'node-vX-win-x64']);
  assert.equal(r.code, 0, `tar failed: ${r.err}`);

  const guideA = 'guide-claude_v9.md';
  const guideB = 'guide-codex_v9.md';
  fs.writeFileSync(path.join(payload, 'guides', guideA), 'claude edition', 'utf8');
  fs.writeFileSync(path.join(payload, 'guides', guideB), 'codex edition', 'utf8');

  const manifest = {
    schema: 1,
    built: '2026-09-11T00:00:00.000Z',
    package: { name: 'IRIS', version: '1.0.0', guideVersion: '9', license: 'MIT' },
    parts: {
      node: { file: 'node/fake-node.zip', version: '24.17.0', sha256: 'aaa', bytes: 1 },
      [`guides:${guideA}`]: { file: `guides/${guideA}`, version: '9', sha256: 'bbb', bytes: 1 },
      [`guides:${guideB}`]: { file: `guides/${guideB}`, version: '9', sha256: 'ccc', bytes: 1 },
    },
  };
  fs.writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const lock = {
    schema: 1,
    package: { version: '1.0.0', guideVersion: '9' },
    parts: {
      node: { kind: 'url', version: '24.17.0', file: 'node/fake-node.zip' },
      guides: { kind: 'glob', file: 'guides/' },
    },
  };
  return { zipRoot: dir, manifest, lock };
}

// Injected so the fake parts (a text file, not node.exe) still "verify", and
// so no registry/PATH/network work happens in a unit test.
function fakeDeps(events) {
  return {
    verifiers: Object.fromEntries(PART_ORDER.map((n) => [n, async () => ({ ok: true, detail: 'stub' })])),
    userpath: {
      addUserPath: async (dir) => ({ changed: true, before: '', after: dir }),
      setUserEnv: async () => ({ changed: true, previous: null }),
    },
    fsutil: {
      isReparsePoint: async () => false,
      volumeFileSystem: async () => 'NTFS',
    },
    onProgress: (e) => events.push(e),
  };
}

const CHOICE = { subscriptions: ['claude'], leadAgent: 'claude', guideEdition: 'claude' };

test('install: unpacks parts, writes shims/soul-state/receipt, then skips on re-run, then .prev on version change', async () => {
  const work = path.join(tmp, 'case1');
  const { zipRoot, manifest, lock } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');

  // ---- run 1 -------------------------------------------------------------
  const events1 = [];
  const receipt1 = await install({
    root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'none', ...fakeDeps(events1),
  });

  // (1) the node part landed under _agent\shared\tools\node with strip 1
  const nodeDir = path.join(root, '_agent', 'shared', 'tools', 'node');
  assert.equal(fs.readFileSync(path.join(nodeDir, 'hello.txt'), 'utf8'), 'hello-node');

  // guides land in <root>\_setup-guides (docs/설계.md 2-2 + 4-1 ③)
  const guides = fs.readdirSync(path.join(root, '_setup-guides'));
  assert.equal(guides.length, 2);

  // (4) minimal soul-state
  const soul = JSON.parse(fs.readFileSync(path.join(root, 'soul-state.json'), 'utf8'));
  assert.equal(soul.packageInstall, true);
  assert.equal(soul.schemaVersion, 7);
  assert.equal(soul.soulName, 'NOVA');
  assert.equal(soul.structureDecision.status, 'wizard-paused');
  assert.equal(soul.iconDecision.status, 'wizard-paused');
  assert.equal(soul.sourceGuide.edition, 'claude');
  assert.match(soul.soulId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // (5) receipt
  assert.equal(receipt1.steps.copy, 'done');
  assert.equal(readReceipt(root).steps.copy, 'done');
  assert.equal(receipt1.installed.node.verified, true);
  assert.equal(receipt1.installed.node.version, '24.17.0');
  assert.equal(receipt1.installed.node.path, '_agent\\shared\\tools\\node');
  assert.equal(receipt1.env.pathShim, path.join(root, '_agent', 'shared', 'shims'));
  // Fix round 1, finding 3: a normal install says the env values really were
  // written, and carries no skippedReason.
  assert.equal(receipt1.env.applied, true);
  assert.equal(receipt1.env.skippedReason, undefined);

  // shims: only the chosen agent's .cmd, plus node.cmd
  const shimDir = path.join(root, '_agent', 'shared', 'shims');
  const shims = fs.readdirSync(shimDir).sort();
  assert.deepEqual(shims, ['claude.cmd', 'node.cmd']);
  const claudeShim = fs.readFileSync(path.join(shimDir, 'claude.cmd'), 'utf8');
  assert.ok(claudeShim.includes('ANTHROPIC_BASE_URL=http://127.0.0.1:3456'));
  assert.ok(claudeShim.includes('CLAUDE_CONFIG_DIR=%~dp0..\\..\\claude'));
  assert.ok(claudeShim.includes('%~dp0..\\tools\\claude\\claude.cmd'));
  assert.ok(/\r\n/.test(claudeShim), 'shims must be CRLF');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(claudeShim), 'shims must be ASCII-only');

  // progress events carry the SSE shape
  const nodeEvents = events1.filter((e) => e.part === 'node');
  assert.ok(nodeEvents.length >= 1);
  for (const e of events1) {
    assert.ok(Object.prototype.hasOwnProperty.call(e, 'done'));
    if (e.part !== undefined) assert.equal(typeof e.part, 'string');
    if (e.pct !== undefined) assert.equal(typeof e.pct, 'number');
  }
  assert.equal(events1.at(-1).done, true);
  assert.equal(events1.at(-1).error ?? null, null);

  // ---- run 2: identical version -> skipped ------------------------------
  const events2 = [];
  await install({
    root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'soul', ...fakeDeps(events2),
  });
  const skipped = events2.find((e) => e.part === 'node' && e.skipped);
  assert.ok(skipped, `expected a skipped node event, got ${JSON.stringify(events2)}`);
  assert.equal(skipped.pct, 100);
  assert.ok(!fs.existsSync(path.join(root, '_agent', 'shared', 'tools', 'node.prev')));

  // ---- run 3: receipt version changed -> old dir preserved as node.prev --
  const stale = readReceipt(root);
  stale.installed.node.version = '0.0.1-old';
  fs.writeFileSync(path.join(root, '_agent', 'setup', 'package-receipt.json'), JSON.stringify(stale, null, 2), 'utf8');
  await makeFakePayload(work, { nodeBody: 'hello-node-v2' });

  const events3 = [];
  await install({
    root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'soul', ...fakeDeps(events3),
  });
  assert.equal(fs.readFileSync(path.join(root, '_agent', 'shared', 'tools', 'node.prev', 'hello.txt'), 'utf8'), 'hello-node');
  assert.equal(fs.readFileSync(path.join(nodeDir, 'hello.txt'), 'utf8'), 'hello-node-v2');
});

test('install: soul-state is never overwritten when one already exists', async () => {
  const work = path.join(tmp, 'case2');
  const { zipRoot, manifest, lock } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'soul-state.json'), JSON.stringify({ mine: true }), 'utf8');

  await install({
    root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'soul', ...fakeDeps([]),
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'soul-state.json'), 'utf8')), { mine: true });
});

test('install: a failed verifyPart stops the run and records verified:false', async () => {
  const work = path.join(tmp, 'case3');
  const { zipRoot, manifest, lock } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  const events = [];
  const deps = fakeDeps(events);
  deps.verifiers.node = async () => ({ ok: false, detail: 'version-mismatch' });

  await assert.rejects(() => install({
    root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'none', ...deps,
  }), /verify-failed/);

  const receipt = readReceipt(root);
  assert.equal(receipt.installed.node.verified, false);
  assert.equal(receipt.steps.copy, 'error');
  // nothing after node ran
  assert.ok(!fs.existsSync(path.join(root, '_setup-guides')));
  assert.equal(events.at(-1).error, 'verify-failed');
  assert.equal(events.at(-1).done, true);
});

test('install: the claude download branch reports npm-unreachable and stops', async () => {
  const work = path.join(tmp, 'case4');
  const { zipRoot, manifest } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  const lock = {
    schema: 1,
    package: { version: '1.0.0', guideVersion: '9' },
    parts: {
      claude: { kind: 'npm-prefix', npm: '@anthropic-ai/claude-code', version: '2.1.267', redistribute: 'download' },
    },
  };
  const events = [];
  const deps = fakeDeps(events);
  deps.npmInstall = async () => ({ code: 1, out: '', err: 'getaddrinfo ENOTFOUND registry.npmjs.org' });

  await assert.rejects(() => install({
    root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'none', ...deps,
  }), /npm-unreachable/);
  const ev = events.find((e) => e.part === 'claude' && e.error);
  assert.equal(ev.error, 'npm-unreachable');
});

test('checkRootPath: file / reparse point / non-NTFS volume are each refused', async () => {
  const work = path.join(tmp, 'case5');
  fs.mkdirSync(work, { recursive: true });
  const asFile = path.join(work, 'AS-FILE');
  fs.writeFileSync(asFile, 'x', 'utf8');
  const ok = { isReparsePoint: async () => false, volumeFileSystem: async () => 'NTFS' };

  assert.deepEqual(await checkRootPath(asFile, ok), { ok: false, reason: 'root-is-file' });
  assert.deepEqual(
    await checkRootPath(work, { ...ok, isReparsePoint: async () => true }),
    { ok: false, reason: 'root-reparse' },
  );
  assert.deepEqual(
    await checkRootPath(work, { ...ok, volumeFileSystem: async () => 'exFAT' }),
    { ok: false, reason: 'not-ntfs' },
  );
  assert.deepEqual(await checkRootPath(path.join(work, 'does-not-exist-yet'), ok), { ok: true });
});

// ---------------------------------------------------------------------------
// fix round 1 finding 1: a failed re-install must leave the soul exactly as it
// was. Before the fix the old copy was renamed to <slot>.prev *before* the
// attempt and never put back, so `claude` + a blocked npm registry left the
// soul with claude.prev and no claude at all -- the shim pointed at nothing
// and the user was worse off for having re-run the installer.
// ---------------------------------------------------------------------------
const CLAUDE_LOCK = {
  schema: 1,
  package: { version: '1.0.0', guideVersion: '9' },
  parts: { claude: { kind: 'npm-prefix', npm: '@anthropic-ai/claude-code', version: '2.1.267', redistribute: 'download' } },
};

test('install: a re-install whose npm step fails restores the previous copy and records it', async () => {
  const work = path.join(tmp, 'case6');
  const { zipRoot, manifest } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  const slot = path.join(toolsDir(root), 'claude');

  // --- first install succeeds --------------------------------------------
  const ok = fakeDeps([]);
  ok.npmInstall = async ({ prefix }) => {
    fs.writeFileSync(path.join(prefix, 'marker.txt'), 'v1', 'utf8');
    return { code: 0, out: '', err: '' };
  };
  await install({ root, name: 'NOVA', zipRoot, manifest, lock: CLAUDE_LOCK, choice: CHOICE, existing: 'none', ...ok });
  assert.equal(fs.readFileSync(path.join(slot, 'marker.txt'), 'utf8'), 'v1');

  // --- upgrade attempt with the registry unreachable ----------------------
  const newer = JSON.parse(JSON.stringify(CLAUDE_LOCK));
  newer.parts.claude.version = '2.2.0'; // different identity -> not skipped
  const events = [];
  const bad = fakeDeps(events);
  bad.npmInstall = async ({ prefix }) => {
    fs.writeFileSync(path.join(prefix, 'half.txt'), 'partial', 'utf8'); // half-written output
    return { code: 1, out: '', err: 'getaddrinfo ENOTFOUND registry.npmjs.org' };
  };
  await assert.rejects(() => install({
    root, name: 'NOVA', zipRoot, manifest, lock: newer, choice: CHOICE, existing: 'soul', ...bad,
  }), /npm-unreachable/);

  // the old, working copy is back under its real name...
  assert.equal(fs.readFileSync(path.join(slot, 'marker.txt'), 'utf8'), 'v1');
  // ...with no leftovers from the failed attempt on either side
  assert.ok(!fs.existsSync(path.join(slot, 'half.txt')), 'partial npm output survived');
  assert.ok(!fs.existsSync(`${slot}.prev`), 'backup was left orphaned as .prev');

  const receipt = readReceipt(root);
  assert.equal(receipt.installed.claude.verified, false);
  assert.equal(receipt.installed.claude.priorExisted, true);
  assert.equal(receipt.installed.claude.priorRestored, true);
  assert.equal(receipt.installed.claude.previous, null); // nothing left aside
  assert.equal(receipt.steps.copy, 'error');
  assert.equal(events.at(-1).error, 'npm-unreachable');
  assert.equal(events.at(-1).done, true);
});

test('install: a re-install whose extraction step fails restores the previous copy', async () => {
  const work = path.join(tmp, 'case7');
  const { zipRoot, manifest, lock } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  const slot = path.join(toolsDir(root), 'node');

  await install({ root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'none', ...fakeDeps([]) });
  assert.equal(fs.readFileSync(path.join(slot, 'hello.txt'), 'utf8'), 'hello-node');

  // Same part, new version, but the archive the manifest names is gone.
  const broken = JSON.parse(JSON.stringify(manifest));
  broken.parts.node.version = '99.0.0';
  broken.parts.node.file = 'node/not-there.zip';

  await assert.rejects(() => install({
    root, name: 'NOVA', zipRoot, manifest: broken, lock, choice: CHOICE, existing: 'soul', ...fakeDeps([]),
  }), /payload-missing/);

  assert.equal(fs.readFileSync(path.join(slot, 'hello.txt'), 'utf8'), 'hello-node');
  assert.ok(!fs.existsSync(`${slot}.prev`));
  const receipt = readReceipt(root);
  assert.equal(receipt.installed.node.priorRestored, true);
  assert.equal(receipt.installed.node.previous, null);
});

test('install: a FIRST install that fails records priorExisted:false (nothing to restore)', async () => {
  const work = path.join(tmp, 'case8');
  const { zipRoot, manifest } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  const bad = fakeDeps([]);
  bad.npmInstall = async () => ({ code: 1, out: '', err: 'offline' });

  await assert.rejects(() => install({
    root, name: 'NOVA', zipRoot, manifest, lock: CLAUDE_LOCK, choice: CHOICE, existing: 'none', ...bad,
  }), /npm-unreachable/);

  const receipt = readReceipt(root);
  assert.equal(receipt.installed.claude.priorExisted, false);
  assert.equal(receipt.installed.claude.priorRestored, false);
  assert.equal(receipt.installed.claude.previous, null);
});

// fix round 1 finding 3
test('install: writes package-install.log -- one line per event, no free-form detail', async () => {
  const work = path.join(tmp, 'case9');
  const { zipRoot, manifest, lock } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  const deps = fakeDeps([]);
  const SECRET_LOOKING_DETAIL = 'verifier-detail-that-must-not-be-logged';
  deps.verifiers = Object.fromEntries(PART_ORDER.map((n) => [n, async () => ({ ok: true, detail: SECRET_LOOKING_DETAIL })]));

  await install({ root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'none', ...deps });

  const log = fs.readFileSync(installLogPath(root), 'utf8');
  assert.match(log, /install start root=/);
  assert.match(log, /part=node status=running/);
  assert.match(log, /part=node status=done pct=\d+/);
  assert.match(log, /part=guides status=done/);
  assert.match(log, /install done steps\.copy=done/);
  assert.ok(!log.includes(SECRET_LOOKING_DETAIL), 'free-form verifier detail leaked into the log');
  // every line starts with an ISO timestamp
  for (const line of log.split(/\r?\n/).filter(Boolean)) {
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /, `bad log line: ${line}`);
  }

  // a failure is logged with its code, and the rollback outcome is logged too
  const bad = fakeDeps([]);
  bad.npmInstall = async () => ({ code: 1, out: '', err: 'offline' });
  await assert.rejects(() => install({
    root, name: 'NOVA', zipRoot, manifest, lock: CLAUDE_LOCK, choice: CHOICE, existing: 'soul', ...bad,
  }), /npm-unreachable/);
  const log2 = fs.readFileSync(installLogPath(root), 'utf8');
  assert.match(log2, /part=claude error=npm-unreachable done=true/);
  assert.match(log2, /part=claude rollback priorExisted=false/);
  assert.ok(log2.startsWith(log), 'log was rewritten instead of appended to');
});

// fix round 1 finding 7
test('install: a re-install refreshes receipt.package but keeps per-part history', async () => {
  const work = path.join(tmp, 'case10');
  const { zipRoot, manifest, lock } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  await install({ root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'none', ...fakeDeps([]) });

  // Pretend the receipt was written by an older package.
  const stale = readReceipt(root);
  stale.package.version = '0.0.1';
  stale.package.guideVersion = '3';
  stale.package.built = 'long-ago';
  fs.writeFileSync(path.join(root, '_agent', 'setup', 'package-receipt.json'), JSON.stringify(stale, null, 2), 'utf8');

  await install({ root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'soul', ...fakeDeps([]) });
  const fresh = readReceipt(root);
  assert.equal(fresh.package.version, '1.0.0');
  assert.equal(fresh.package.guideVersion, '9');
  assert.equal(fresh.package.built, manifest.built);
  assert.equal(fresh.installed.node.version, '24.17.0'); // per-part history kept
});

// fix round 1 finding 4
test('defaultVerifiers.face refuses to pass when the manifest carries no face version', async () => {
  const root = path.join(tmp, 'face-verify');
  const faceDir = path.join(toolsDir(root), 'face');
  fs.mkdirSync(faceDir, { recursive: true });
  fs.writeFileSync(path.join(faceDir, 'package.json'), JSON.stringify({ version: '2.43.0' }), 'utf8');

  const noVersion = await defaultVerifiers({ root, manifest: { parts: {} }, lock: { parts: {} } }).face();
  assert.equal(noVersion.ok, false);
  assert.match(noVersion.detail, /no face version/);

  const good = await defaultVerifiers({ root, manifest: { parts: { face: { version: '2.43.0' } } }, lock: { parts: {} } }).face();
  assert.equal(good.ok, true);

  const mismatch = await defaultVerifiers({ root, manifest: { parts: { face: { version: '9.9.9' } } }, lock: { parts: {} } }).face();
  assert.equal(mismatch.ok, false);
});

// fix round 1 finding 5
test('install: a throwing onProgress listener cannot take the install down', async () => {
  const work = path.join(tmp, 'case11');
  const { zipRoot, manifest, lock } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  const deps = fakeDeps([]);
  deps.onProgress = () => { throw new Error('screen blew up'); };
  const receipt = await install({ root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'none', ...deps });
  assert.equal(receipt.steps.copy, 'done');

  // ...including on the terminal (done:true) events, which used to be raw
  // onProgress calls outside any try/catch.
  const bad = fakeDeps([]);
  bad.onProgress = () => { throw new Error('screen blew up'); };
  bad.npmInstall = async () => ({ code: 1, out: '', err: 'offline' });
  await assert.rejects(() => install({
    root, name: 'NOVA', zipRoot, manifest, lock: CLAUDE_LOCK, choice: CHOICE, existing: 'soul', ...bad,
  }), /npm-unreachable/); // the install's own error, not the listener's
});

test('writeShims: no agent chosen -> node.cmd only; both -> three shims', () => {
  const root = path.join(tmp, 'shims-none');
  writeShims(root, []);
  assert.deepEqual(fs.readdirSync(path.join(root, '_agent', 'shared', 'shims')), ['node.cmd']);

  const root2 = path.join(tmp, 'shims-both');
  writeShims(root2, ['claude', 'codex']);
  assert.deepEqual(
    fs.readdirSync(path.join(root2, '_agent', 'shared', 'shims')).sort(),
    ['claude.cmd', 'codex.cmd', 'node.cmd'],
  );
  const codex = fs.readFileSync(path.join(root2, '_agent', 'shared', 'shims', 'codex.cmd'), 'utf8');
  assert.ok(codex.includes('CODEX_HOME=%~dp0..\\..\\codex'));
  assert.ok(codex.includes('%~dp0..\\tools\\codex\\codex.cmd'));
});

// Fix round 1, finding 3: the installer's --no-user-env switch injects a
// recording userpath (server.mjs recordingUserpath). The receipt of such a run
// must be distinguishable from a real install's -- guide v10 tells the
// setting-up agent to *verify* these values, and with applied:false it knows
// there is nothing in the registry to verify yet.
test('install with a recording userpath (--no-user-env): receipt.env.applied=false + skippedReason, nothing written', async () => {
  const work = path.join(tmp, 'case-no-user-env');
  const { zipRoot, manifest, lock } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  const events = [];
  const deps = fakeDeps(events);
  const record = [];
  deps.userpath = {
    recording: true,
    skippedReason: 'no-user-env',
    addUserPath: async (dir) => { record.push({ op: 'addUserPath', dir }); return { changed: false, before: '', after: '', recorded: true }; },
    setUserEnv: async (name, value) => { record.push({ op: 'setUserEnv', name, value }); return { changed: false, previous: null, recorded: true }; },
  };

  const receipt = await install({
    root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'none', ...deps,
  });

  assert.equal(receipt.env.applied, false);
  assert.equal(receipt.env.skippedReason, 'no-user-env');
  assert.equal(receipt.env.pathAdded, false);
  // The values themselves are still recorded -- that is what the agent reads.
  assert.equal(receipt.env.CLAUDE_CONFIG_DIR, path.join(root, '_agent', 'claude'));
  assert.equal(receipt.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
  assert.equal(readReceipt(root).env.applied, false);
  // ...and every write that a real run would have made was seen, not made.
  // (I2, 2026-09-12) TEAMCLAUDE_CONFIG is now one of them -- recorded here,
  // written for real on a normal install, so the relay's account file lives
  // in the soul instead of %USERPROFILE%\.config.
  assert.deepEqual(record.map((r) => r.op + ':' + (r.name ?? 'Path')), [
    'addUserPath:Path', 'setUserEnv:CLAUDE_CONFIG_DIR', 'setUserEnv:CODEX_HOME',
    'setUserEnv:ANTHROPIC_BASE_URL', 'setUserEnv:TEAMCLAUDE_CONFIG',
  ]);
  const teamclaudeConfig = portableTeamclaudeConfigPath(root);
  assert.equal(record.find((r) => r.name === 'TEAMCLAUDE_CONFIG').value, teamclaudeConfig);
  assert.equal(receipt.env.TEAMCLAUDE_CONFIG, teamclaudeConfig);
  assert.equal(receipt.env.teamclaudeConfig, teamclaudeConfig);
  // The folder itself is created even on a rehearsal -- the login step's
  // first spawn points at it before anything writes the file.
  assert.ok(fs.existsSync(portableTeamclaudeConfigDir(root)), 'portable-state/teamclaude dir was not created');
  // ...and login.mjs reads the path back out of the receipt on this PC,
  // where %USERPROFILE%\.config\teamclaude.json is a real, live file.
  assert.equal(resolveTeamclaudeConfigPath({ root, env: {}, homedir: () => 'X:\\fake-home' }), teamclaudeConfig);
});

// I2: the same on a normal (non-rehearsal) install -- the previous value of
// an existing TEAMCLAUDE_CONFIG is kept in receipt.env.previous so a later
// uninstall can put it back.
test('install: TEAMCLAUDE_CONFIG is set and its previous value recorded', async () => {
  const work = path.join(tmp, 'case-teamclaude-config');
  const { zipRoot, manifest, lock } = await makeFakePayload(work);
  const root = path.join(work, 'NOVA');
  const events = [];
  const deps = fakeDeps(events);
  deps.userpath = {
    addUserPath: async (dir) => ({ changed: true, before: '', after: dir }),
    setUserEnv: async (name) => ({
      changed: true,
      previous: name === 'TEAMCLAUDE_CONFIG' ? 'X:\\fake-home\\.config\\teamclaude.json' : null,
    }),
  };

  const receipt = await install({
    root, name: 'NOVA', zipRoot, manifest, lock, choice: CHOICE, existing: 'none', ...deps,
  });

  assert.equal(receipt.env.applied, true);
  assert.equal(receipt.env.teamclaudeConfig, portableTeamclaudeConfigPath(root));
  assert.equal(receipt.env.previous.TEAMCLAUDE_CONFIG, 'X:\\fake-home\\.config\\teamclaude.json');
  assert.equal(readReceipt(root).env.teamclaudeConfig, portableTeamclaudeConfigPath(root));
});

test('writeMinimalSoulState returns written=false when a soul already lives there', () => {
  const root = path.join(tmp, 'soul-existing');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'soul-state.json'), '{"keep":1}', 'utf8');
  const r = writeMinimalSoulState(root, { edition: 'claude' });
  assert.equal(r.written, false);
  assert.equal(fs.readFileSync(path.join(root, 'soul-state.json'), 'utf8'), '{"keep":1}');
});
