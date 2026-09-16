import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collect, treeHash, listFiles } from '../build/collect.mjs';
import { extractZip, zipDir } from '../lib/zip.mjs';
import { sha256File } from '../lib/manifest.mjs';
import { OFFLINE_ENV } from '../lib/net.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-collect-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
function dirs(tag) {
  seq += 1;
  return { cacheDir: path.join(tmp, `cache-${tag}-${seq}`), stageDir: path.join(tmp, `stage-${tag}-${seq}`) };
}

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

// A stand-in for lib/run.mjs that records every child process collect() would
// have spawned and fakes the three it actually cares about (git, npm, pip).
// Everything the build can reach the network with goes through `run` or
// `download`, so `calls` + `downloads` together are the complete network
// ledger a test can assert "zero" against.
function fakeRunner({ repoFiles = {}, npmFiles = {}, wheels = [], npmCiFails = false } = {}) {
  const calls = [];
  const run = async (exe, args = [], opts = {}) => {
    calls.push({ exe, args, opts });
    const argv = args.join(' ');
    if (args.includes('ci')) {
      return npmCiFails
        ? { code: 1, out: '', err: 'npm ERR! request to https://registry.npmjs.org/ws failed' }
        : { code: 0, out: '', err: '' };
    }
    if (exe === 'git') {
      if (args.includes('clone')) {
        const dest = args[args.length - 1];
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        fs.writeFileSync(path.join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        return { code: 0, out: '', err: '' };
      }
      if (args.includes('cat-file')) return { code: 0, out: '', err: '' };
      if (args.includes('checkout')) {
        const i = args.indexOf('-C');
        writeTree(args[i + 1], repoFiles);
        return { code: 0, out: '', err: '' };
      }
      return { code: 0, out: '', err: '' };
    }
    if (argv.includes('install') && argv.includes('--prefix')) {
      const prefix = args[args.indexOf('--prefix') + 1];
      writeTree(prefix, npmFiles);
      return { code: 0, out: '', err: '' };
    }
    if (argv.includes('-c') && argv.includes('sys.version_info')) return { code: 0, out: '3.12', err: '' };
    if (argv.includes('pip') && argv.includes('download')) {
      const d = args[args.indexOf('-d') + 1];
      fs.mkdirSync(d, { recursive: true });
      for (const w of wheels) fs.writeFileSync(path.join(d, w), `fake wheel ${w}`);
      return { code: 0, out: '', err: '' };
    }
    return { code: 0, out: '', err: '' };
  };
  const downloads = [];
  const download = async (url, dest) => {
    downloads.push(url);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `fake ${url}`);
  };
  const netCalls = () => calls.filter((c) => {
    const argv = c.args.join(' ');
    return (c.exe === 'git' && (c.args.includes('clone') || c.args.includes('fetch') || c.args.includes('checkout')))
      || (argv.includes('install') && argv.includes('--prefix'))
      || (argv.includes('pip') && argv.includes('download'));
  });
  return { run, download, calls, downloads, netCalls };
}

function withOffline(fn) {
  const before = process.env[OFFLINE_ENV];
  process.env[OFFLINE_ENV] = '1';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (before === undefined) delete process.env[OFFLINE_ENV];
      else process.env[OFFLINE_ENV] = before;
    });
}

// --------------------------------------------------------------------------
// dir / file kinds
// --------------------------------------------------------------------------

test('dir kind zips with excludes; url without sha256 throws', async () => {
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'state'), { recursive: true });
  // Nested folders: a plain exclude name matches the first segment only, a
  // `dir/sub` entry matches that relative path (Face daemon/__pycache__).
  fs.mkdirSync(path.join(src, 'daemon', '__pycache__'), { recursive: true });
  fs.mkdirSync(path.join(src, 'app', 'state'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.js'), '1');
  fs.writeFileSync(path.join(src, 'state/x'), '2');
  fs.writeFileSync(path.join(src, 'daemon/keep.mjs'), '3');
  fs.writeFileSync(path.join(src, 'daemon/__pycache__/m.pyc'), '4');
  fs.writeFileSync(path.join(src, 'app/state/keep.txt'), '5');
  const lock = { package: { version: '0' }, parts: { face: { kind: 'dir', source: src, exclude: ['state', 'daemon/__pycache__'], file: 'face/iris-face.zip' } } };
  const d = dirs('dir');
  const r = await collect({ lock, ...d, log: () => {} });
  await extractZip(path.join(r.payloadDir, 'face/iris-face.zip'), path.join(tmp, 'x'));
  assert.ok(fs.existsSync(path.join(tmp, 'x/a.js')));
  assert.ok(!fs.existsSync(path.join(tmp, 'x/state')));
  assert.ok(fs.existsSync(path.join(tmp, 'x/daemon/keep.mjs')));
  assert.ok(!fs.existsSync(path.join(tmp, 'x/daemon/__pycache__')), 'nested path exclude must apply');
  assert.ok(fs.existsSync(path.join(tmp, 'x/app/state/keep.txt')), 'a plain name must not exclude a nested folder of the same name');
  await assert.rejects(
    collect({
      lock: { package: {}, parts: { node: { kind: 'url', url: 'https://x', sha256: '', file: 'node/n.zip' } } },
      cacheDir: tmp,
      stageDir: tmp,
      log: () => {},
    }),
    /sha256 missing for node/,
  );
});

test('cacheDir inside stageDir throws before stageDir is wiped', async () => {
  const stageDir = path.join(tmp, 'guard-stage');
  const cacheDir = path.join(stageDir, 'cache'); // strictly inside stageDir
  const canary = path.join(stageDir, 'canary.txt');
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(canary, 'still here');
  await assert.rejects(
    collect({ lock: { package: {}, parts: {} }, cacheDir, stageDir, log: () => {} }),
    /cacheDir must not be inside stageDir/,
  );
  assert.ok(fs.existsSync(canary), 'stageDir must not have been wiped before the guard fires');
});

// The `updater` part's source is `./updater` -- a folder inside this repo,
// not a sibling project. Before 2026-09-14 a relative `source` only worked
// because every build happened to start in the repo root; partSource() now
// resolves against the project root, so this collects the same from anywhere.
test('dir part with a repo-relative source collects from the project root, whatever the cwd is', async () => {
  const lock = {
    package: { version: '0' },
    parts: { updater: { kind: 'dir', source: './updater', file: 'updater/iris-updater.zip' } },
  };
  const d = dirs('rel');
  const cwdBefore = process.cwd();
  process.chdir(os.tmpdir());
  let r;
  try {
    r = await collect({ lock, ...d, log: () => {} });
  } finally {
    process.chdir(cwdBefore);
  }
  await extractZip(path.join(r.payloadDir, 'updater/iris-updater.zip'), path.join(tmp, 'x3'));
  const text = fs.readFileSync(path.join(tmp, 'x3', 'apply.mjs'), 'utf8');
  assert.match(text, /export async function applyPlan/);
});

// schema 2's `ontology` part names eight files out of a working folder that
// is otherwise full of generated graph output.
test('dir part with include copies only the named paths and never __pycache__', async () => {
  const src = path.join(tmp, 'onto-src');
  writeTree(src, {
    'build_graph.py': 'a',
    'query.py': 'b',
    'graph.json': 'GENERATED',
    'registry.yml': 'SECRET',
    'sub/keep.js': 'c',
    'sub/__pycache__/x.pyc': 'junk',
  });
  const lock = {
    package: { version: '0' },
    parts: { ontology: { kind: 'dir', source: src, include: ['build_graph.py', 'query.py', 'sub'], file: 'setup/ontology.zip' } },
  };
  const d = dirs('include');
  const r = await collect({ lock, ...d, log: () => {} });
  const out = path.join(tmp, 'x-include');
  await extractZip(path.join(r.payloadDir, 'setup/ontology.zip'), out);
  assert.deepEqual(listFiles(out).sort(), ['build_graph.py', 'query.py', 'sub/keep.js']);
});

// (h) asciiRequired
test('asciiRequired rejects a .ps1 that is not pure ASCII', async () => {
  const src = path.join(tmp, 'hooks-bad');
  writeTree(src, { 'guard.ps1': 'Write-Host "막기"\n', 'ok.py': '# fine' });
  const lock = {
    package: { version: '0' },
    parts: { hooks: { kind: 'dir', source: src, asciiRequired: true, file: 'tools/hooks.zip' } },
  };
  const d = dirs('ascii');
  await assert.rejects(collect({ lock, ...d, log: () => {} }), /asciiRequired: hooks\/guard\.ps1/);

  const good = path.join(tmp, 'hooks-good');
  writeTree(good, { 'guard.ps1': 'Write-Host "blocked"\n' });
  const d2 = dirs('ascii-ok');
  const r = await collect({
    lock: { package: { version: '0' }, parts: { hooks: { kind: 'dir', source: good, asciiRequired: true, file: 'tools/hooks.zip' } } },
    ...d2,
    log: () => {},
  });
  assert.ok(fs.existsSync(path.join(r.payloadDir, 'tools/hooks.zip')));
});

// --------------------------------------------------------------------------
// (a) kind: git
// --------------------------------------------------------------------------

const GIT_COMMIT = 'b36e0829c6d0140e93cfef2ca599b1b07d4a7797';

test('git kind clones once, checks out the commit, honours subdir/include, and records a tree hash', async () => {
  const repoFiles = {
    'LICENSE': 'MIT for the whole repo\n',
    'README.md': 'root readme',
    'plugins/frontend-design/SKILL.md': 'skill body',
    'plugins/frontend-design/LICENSE': 'Apache-2.0 for the plugin\n',
    'plugins/other/ignored.md': 'not ours',
    'skills/xlsx/SKILL.md': 'x',
    'skills/docx/SKILL.md': 'd',
  };
  const f = fakeRunner({ repoFiles });
  const lock = {
    package: { version: '0' },
    parts: {
      fd: {
        kind: 'git', repo: 'https://example.invalid/plugins.git', commit: GIT_COMMIT,
        subdir: 'plugins/frontend-design', file: 'tools/frontend-design.zip', dest: 'x', license: 'Apache-2.0',
      },
      ds: {
        kind: 'git', repo: 'https://example.invalid/plugins.git', commit: GIT_COMMIT,
        include: ['skills/xlsx', 'skills/docx'], file: 'tools/document-skills.zip', dest: 'y', license: 'MIT',
      },
    },
  };
  const d = dirs('git');
  const r = await collect({ lock, ...d, log: () => {}, run: f.run, download: f.download });

  // subdir part: only the subfolder's contents, no .git, no sibling plugin
  const out = path.join(tmp, 'x-git-sub');
  await extractZip(path.join(r.payloadDir, 'tools/frontend-design.zip'), out);
  assert.deepEqual(listFiles(out).sort(), ['LICENSE', 'SKILL.md']);

  // include part: exactly the two named folders
  const out2 = path.join(tmp, 'x-git-inc');
  await extractZip(path.join(r.payloadDir, 'tools/document-skills.zip'), out2);
  assert.deepEqual(listFiles(out2).sort(), ['skills/docx/SKILL.md', 'skills/xlsx/SKILL.md']);

  // one clone for both parts (the clone is shared per repo URL)
  assert.equal(f.calls.filter((c) => c.args.includes('clone')).length, 1);
  assert.equal(f.calls.filter((c) => c.args.includes('--filter=blob:none')).length >= 1, true);
  assert.ok(f.calls.some((c) => c.args.includes('advice.detachedHead=false') && c.args.includes(GIT_COMMIT)));

  // tree hash is content-addressed and matches an independent recomputation
  assert.match(r.partsMeta.fd.treeHash, /^[0-9a-f]{64}$/);
  assert.equal(r.partsMeta.fd.treeHash, await treeHash(out));
  assert.notEqual(r.partsMeta.fd.treeHash, r.partsMeta.ds.treeHash);
  assert.equal(r.partsMeta.fd.commit, GIT_COMMIT);

  // (g) licences: repo root LICENSE + the subdir's own, both under policy/licenses
  const licenses = fs.readdirSync(path.join(r.payloadDir, 'policy', 'licenses')).sort();
  assert.ok(licenses.includes('fd-LICENSE'), licenses.join(','));
  assert.ok(licenses.includes('fd-frontend-design-LICENSE'), licenses.join(','));
  assert.equal(
    fs.readFileSync(path.join(r.payloadDir, 'policy/licenses/fd-frontend-design-LICENSE'), 'utf8'),
    'Apache-2.0 for the plugin\n',
  );
  assert.deepEqual(r.partsMeta.fd.licenseFiles.slice().sort(), ['fd-LICENSE', 'fd-frontend-design-LICENSE']);
});

test('git kind enforces expectedSkillCount', async () => {
  const f = fakeRunner({ repoFiles: { 'skills/a/SKILL.md': '1', 'skills/b/SKILL.md': '2' } });
  const lock = {
    package: { version: '0' },
    parts: { sp: { kind: 'git', repo: 'https://example.invalid/sp.git', commit: GIT_COMMIT, expectedSkillCount: 14, file: 'tools/sp.zip' } },
  };
  const d = dirs('skills');
  await assert.rejects(
    collect({ lock, ...d, log: () => {}, run: f.run, download: f.download }),
    /expectedSkillCount 14 but found 2/,
  );
});

// --------------------------------------------------------------------------
// (b) kind: npm-prefix
// --------------------------------------------------------------------------

test('npm-prefix passes the lock part env to the npm child process and records the package-lock fingerprint', async () => {
  const f = fakeRunner({
    npmFiles: {
      'node_modules/@playwright/mcp/package.json': '{"name":"@playwright/mcp"}',
      'node_modules/@playwright/mcp/LICENSE': 'Apache-2.0 text\n',
      'package-lock.json': '{"lockfileVersion":3}',
    },
  });
  const lock = {
    package: { version: '0' },
    parts: {
      'playwright-mcp': {
        kind: 'npm-prefix', npm: '@playwright/mcp', version: '0.0.81',
        integrity: 'sha512-c4eVex1nS53IzLHlwAm0J9ZISDTvA7RndFX8oVcQOrmvIrKSkByazpq79lZHWJuWTB7Gpk0sLBQoRepyIgmneA==',
        env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
        file: 'tools/playwright-mcp.zip', dest: 'z', license: 'Apache-2.0',
      },
    },
  };
  const d = dirs('npm');
  const r = await collect({ lock, ...d, log: () => {}, run: f.run, download: f.download });

  const install = f.calls.find((c) => c.args.join(' ').includes('--prefix'));
  assert.equal(install.opts.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1', 'lock `env` must reach the npm child');
  assert.ok(install.opts.env.npm_config_cache.includes('npm-cache'));

  assert.ok(fs.existsSync(path.join(r.payloadDir, 'tools/playwright-mcp.zip')));
  assert.match(r.partsMeta['playwright-mcp'].packageLockSha256, /^[0-9a-f]{64}$/);
  assert.equal(r.partsMeta['playwright-mcp'].integrity, lock.parts['playwright-mcp'].integrity);
  // (g) the package root's own LICENSE travels to policy/licenses
  assert.deepEqual(r.partsMeta['playwright-mcp'].licenseFiles, ['playwright-mcp-LICENSE']);
  assert.ok(fs.existsSync(path.join(r.payloadDir, 'policy/licenses/playwright-mcp-LICENSE')));
});

// --------------------------------------------------------------------------
// (c) kind: wheelhouse
// --------------------------------------------------------------------------

function wheelhouseLock(tmpDir, expectedCount, sha) {
  return {
    package: { version: '0' },
    parts: {
      wh: {
        kind: 'wheelhouse',
        requirementsLock: path.relative(process.cwd(), path.join(tmpDir, 'requirements.lock')).split(path.sep).join('/'),
        sha256: sha,
        pythonTag: 'cp312',
        platform: 'win_amd64',
        expectedCount,
        file: 'tools/wheelhouse/',
        dest: 'w',
        license: 'various',
      },
    },
  };
}

test('wheelhouse: lock-file digest is checked first, wheels are counted and hashed, a count mismatch throws', async () => {
  const whDir = path.join(tmp, 'wh-src');
  fs.mkdirSync(whDir, { recursive: true });
  const lockFile = path.join(whDir, 'requirements.lock');
  fs.writeFileSync(lockFile, 'six==1.17.0 \\\n    --hash=sha256:deadbeef\n');
  const sha = await sha256File(lockFile);

  // wrong digest in lock.json -> refuse before any network work
  const bad = wheelhouseLock(whDir, 2, 'f'.repeat(64));
  bad.parts.wh.requirementsLock = lockFile;
  const f0 = fakeRunner({ wheels: ['six-1.17.0-py2.py3-none-any.whl'] });
  await assert.rejects(
    collect({ lock: bad, ...dirs('wh-sha'), log: () => {}, run: f0.run, download: f0.download }),
    /requirements\.lock sha256 .* != lock\.json/,
  );
  assert.equal(f0.netCalls().length, 0, 'a digest mismatch must not reach pip');

  // right digest, but pip produced fewer wheels than the lock expects
  const short = wheelhouseLock(whDir, 3, sha);
  short.parts.wh.requirementsLock = lockFile;
  const f1 = fakeRunner({ wheels: ['a-1-py3-none-any.whl', 'b-1-py3-none-any.whl'] });
  await assert.rejects(
    collect({ lock: short, ...dirs('wh-count'), log: () => {}, run: f1.run, download: f1.download }),
    /expectedCount 3 but downloaded 2 wheel\(s\)/,
  );

  // matching count: wheels land in payload/tools/wheelhouse/ with digests
  const ok = wheelhouseLock(whDir, 2, sha);
  ok.parts.wh.requirementsLock = lockFile;
  const f2 = fakeRunner({ wheels: ['a-1-py3-none-any.whl', 'b-1-py3-none-any.whl'] });
  const d = dirs('wh-ok');
  const r = await collect({ lock: ok, ...d, log: () => {}, run: f2.run, download: f2.download });
  assert.deepEqual(fs.readdirSync(path.join(r.payloadDir, 'tools/wheelhouse')).sort(), ['a-1-py3-none-any.whl', 'b-1-py3-none-any.whl']);
  assert.equal(r.partsMeta.wh.wheelCount, 2);
  assert.match(r.partsMeta.wh.wheels['a-1-py3-none-any.whl'], /^[0-9a-f]{64}$/);
  const pip = f2.calls.find((c) => c.args.join(' ').includes('pip download'));
  assert.ok(pip.args.includes('--require-hashes') && pip.args.includes('--only-binary=:all:'));
  assert.ok(pip.args.includes('win_amd64') && pip.args.includes('cp312'));
});

// --------------------------------------------------------------------------
// (d) redistribute: "download"
// --------------------------------------------------------------------------

test('redistribute:"download" parts are never collected -- metadata only, zero network', async () => {
  const f = fakeRunner();
  const lock = {
    package: { version: '0' },
    parts: {
      claude: {
        kind: 'claude-release', version: '2.1.272',
        url: 'https://downloads.claude.ai/x/claude.exe',
        manifestUrl: 'https://downloads.claude.ai/x/manifest.json',
        sha256: 'c'.repeat(64),
        fallback: { kind: 'npm-prefix', npm: '@anthropic-ai/claude-code', version: '2.1.272', integrity: 'sha512-zz' },
        binName: 'claude.exe',
        file: 'agents/claude-code-2.1.272.zip', dest: '_agent/shared/tools/claude',
        redistribute: 'download', license: 'Proprietary',
      },
      'document-skills': {
        kind: 'git', repo: 'https://github.com/anthropics/skills.git', commit: GIT_COMMIT,
        include: ['skills/xlsx'], file: 'tools/document-skills.zip', dest: 'q',
        redistribute: 'download', license: 'Proprietary', licenseNotice: 'no redistribution',
      },
    },
  };
  const d = dirs('dl');
  const r = await collect({ lock, ...d, log: () => {}, run: f.run, download: f.download });

  assert.deepEqual(r.skipped.sort(), ['claude', 'document-skills']);
  assert.equal(f.calls.length, 0, 'no child process at all for download parts');
  assert.equal(f.downloads.length, 0, 'no bytes fetched for download parts');
  assert.ok(!fs.existsSync(path.join(r.payloadDir, 'agents')), 'nothing staged for claude');
  assert.ok(!fs.existsSync(path.join(r.payloadDir, 'tools/document-skills.zip')));

  assert.equal(r.partsMeta.claude.redistribute, 'download');
  assert.equal(r.partsMeta.claude.download.url, lock.parts.claude.url);
  assert.equal(r.partsMeta.claude.download.manifestUrl, lock.parts.claude.manifestUrl);
  assert.equal(r.partsMeta.claude.download.sha256, lock.parts.claude.sha256);
  assert.deepEqual(r.partsMeta.claude.download.fallback, lock.parts.claude.fallback);
  assert.equal(r.partsMeta['document-skills'].download.commit, GIT_COMMIT);
  // (g) no licence harvesting for a part we are not allowed to copy at all
  assert.deepEqual(r.partsMeta.claude.licenseFiles, []);
  assert.deepEqual(r.partsMeta['document-skills'].licenseFiles, []);
  assert.deepEqual(fs.readdirSync(path.join(r.payloadDir, 'policy', 'licenses')), []);
});

// --------------------------------------------------------------------------
// (e)(f) cache reuse and the offline flag
// --------------------------------------------------------------------------

test('a second collect() with the same cache makes zero network calls; --no-cache forces a re-collect', async () => {
  const repoFiles = { 'LICENSE': 'MIT\n', 'skills/a/SKILL.md': 'a' };
  const lock = {
    package: { version: '0' },
    parts: {
      sp: { kind: 'git', repo: 'https://example.invalid/sp.git', commit: GIT_COMMIT, file: 'tools/sp.zip', dest: 's', license: 'MIT' },
      cx: {
        kind: 'npm-prefix', npm: 'codex', version: '0.154.0', integrity: 'sha512-abc',
        file: 'tools/cx.zip', dest: 'c', license: 'Apache-2.0',
      },
      nd: { kind: 'url', url: 'https://example.invalid/n.zip', sha256: null, file: 'runtime/n.zip', dest: 'n', license: 'MIT' },
      wh: {
        kind: 'wheelhouse', requirementsLock: null, sha256: null,
        pythonTag: 'cp312', platform: 'win_amd64', expectedCount: 2,
        file: 'tools/wheelhouse/', dest: 'w', license: 'various',
      },
    },
  };
  const cacheDir = path.join(tmp, 'cache-shared');
  const npmFiles = { 'node_modules/codex/package.json': '{}', 'node_modules/codex/LICENSE': 'Apache\n' };
  const wheels = ['a-1-py3-none-any.whl', 'b-1-py3-none-any.whl'];

  // first run populates the cache (url part's sha256 is computed from what the
  // fake download writes, so the digest check passes on both runs)
  const probe = path.join(tmp, 'probe.zip');
  fs.writeFileSync(probe, 'fake https://example.invalid/n.zip');
  lock.parts.nd.sha256 = await sha256File(probe);

  const whDir = path.join(tmp, 'wh-shared');
  fs.mkdirSync(whDir, { recursive: true });
  const whLock = path.join(whDir, 'requirements.lock');
  fs.writeFileSync(whLock, 'six==1.17.0\n');
  lock.parts.wh.requirementsLock = whLock;
  lock.parts.wh.sha256 = await sha256File(whLock);

  const pipCalls = (f) => f.calls.filter((c) => c.args.join(' ').includes('pip download')).length;

  const f1 = fakeRunner({ repoFiles, npmFiles, wheels });
  const r1 = await collect({ lock, cacheDir, stageDir: path.join(tmp, 'stage-c1'), log: () => {}, run: f1.run, download: f1.download });
  assert.ok(f1.netCalls().length >= 2, 'first run must actually fetch');
  assert.equal(f1.downloads.length, 1);
  assert.equal(pipCalls(f1), 1, 'first run must run pip download');

  const f2 = fakeRunner({ repoFiles, npmFiles, wheels });
  const r2 = await collect({ lock, cacheDir, stageDir: path.join(tmp, 'stage-c2'), log: () => {}, run: f2.run, download: f2.download });
  assert.equal(f2.netCalls().length, 0, 'second run must be served entirely from _build/cache');
  assert.equal(f2.downloads.length, 0, 'second run must not re-download the url part');
  assert.equal(pipCalls(f2), 0, 'second run must not re-run pip download');
  assert.equal(r2.partsMeta.sp.treeHash, r1.partsMeta.sp.treeHash);
  assert.deepEqual(r2.partsMeta.wh.wheels, r1.partsMeta.wh.wheels, 'wheel digests come back from the slot');
  assert.deepEqual(fs.readdirSync(path.join(r2.payloadDir, 'tools/wheelhouse')).sort(), wheels, 'wheels are republished from the cache slot');
  assert.ok(fs.existsSync(path.join(r2.payloadDir, 'tools/sp.zip')));
  assert.deepEqual(r2.partsMeta.sp.licenseFiles, ['sp-LICENSE'], 'licences are republished from the cache slot');

  // (e2) the same second run under IRIS_INSTALLER_OFFLINE=1 still succeeds
  await withOffline(async () => {
    const f3 = fakeRunner({ repoFiles, npmFiles, wheels });
    await collect({ lock, cacheDir, stageDir: path.join(tmp, 'stage-c3'), log: () => {}, run: f3.run, download: f3.download });
    assert.equal(f3.netCalls().length, 0);
    assert.equal(f3.downloads.length, 0);
  });

  // --no-cache ignores every valid slot and collects again -- git, npm,
  // wheelhouse AND url (the flag has to mean the same thing for every kind).
  const f4 = fakeRunner({ repoFiles, npmFiles, wheels });
  const r4 = await collect({ lock, cacheDir, stageDir: path.join(tmp, 'stage-c4'), log: () => {}, run: f4.run, download: f4.download, noCache: true });
  assert.equal(f4.calls.filter((c) => c.args.includes('clone') || c.args.includes('checkout')).length >= 1, true, '--no-cache must re-collect the git part');
  assert.equal(f4.calls.filter((c) => c.args.join(' ').includes('--prefix')).length, 1, '--no-cache must re-install the npm part');
  assert.equal(pipCalls(f4), 1, '--no-cache must re-run pip download');
  assert.deepEqual(f4.downloads, ['https://example.invalid/n.zip'], '--no-cache must re-download the url part');
  assert.equal(r4.partsMeta.wh.wheelCount, 2);
  assert.equal(r4.partsMeta.sp.treeHash, r1.partsMeta.sp.treeHash, 're-collected content is identical, so the tree hash is too');

  // meta.json is written .tmp-then-rename, so a finished collect() leaves no
  // half-written flag behind for the next run to trip over.
  const strays = listFiles(cacheDir).filter((rel) => rel.endsWith('.meta.json.tmp'));
  assert.deepEqual(strays, [], 'no temporary meta files may survive a collect()');
  for (const kind of ['git', 'npm', 'wh']) {
    assert.ok(fs.existsSync(path.join(cacheDir, kind)), `${kind} slots exist`);
  }
});

// The `face` part is the one kind with no lock value to key a cache slot on,
// so its offline path is "try npm's own cache, then give up" rather than
// "refuse before starting". Both branches have to behave (T07 review round 1,
// finding 1): a cache that CAN satisfy the lockfile must still build offline,
// and one that cannot must fail with the same `offline:` contract as the rest.
test('npmCi dir part: --offline succeeds from npm cache, and a failed offline run raises the offline contract', async () => {
  const src = path.join(tmp, 'face-src');
  writeTree(src, { 'package.json': '{"name":"iris-face","version":"2.65.0"}', 'launch.mjs': 'x' });
  const lock = {
    package: { version: '0' },
    parts: { face: { kind: 'dir', source: src, npmCi: true, file: 'face/iris-face.zip', dest: 'f', license: 'MIT' } },
  };

  // (a) offline + npm's cache satisfies the lockfile -> builds, with --offline
  await withOffline(async () => {
    const f = fakeRunner();
    const r = await collect({ lock, ...dirs('ci-ok'), log: () => {}, run: f.run, download: f.download });
    const ci = f.calls.find((c) => c.args.includes('ci'));
    assert.ok(ci.args.includes('--offline'), 'offline mode must ask npm for its cache-only path');
    assert.equal(r.faceVersion, '2.65.0');
    assert.ok(fs.existsSync(path.join(r.payloadDir, 'face/iris-face.zip')));
  });

  // (b) offline + npm's cache cannot satisfy it -> the centralized guard speaks
  await withOffline(async () => {
    const f = fakeRunner({ npmCiFails: true });
    await assert.rejects(
      collect({ lock, ...dirs('ci-offline'), log: () => {}, run: f.run, download: f.download }),
      (err) => {
        assert.match(err.message, /^offline: npm ci face \(npm cache cannot satisfy package-lock\.json\)$/);
        return true;
      },
    );
  });

  // (c) online + npm ci fails -> npm's own message, NOT the offline contract
  const f = fakeRunner({ npmCiFails: true });
  await assert.rejects(
    collect({ lock, ...dirs('ci-online'), log: () => {}, run: f.run, download: f.download }),
    (err) => {
      assert.match(err.message, /^npm ci face: npm ERR! request to/);
      assert.doesNotMatch(err.message, /offline:/);
      return true;
    },
  );
  assert.ok(!f.calls.find((c) => c.args.includes('ci')).args.includes('--offline'));
});

test('IRIS_INSTALLER_OFFLINE=1 turns every cache miss into offline: <what>', async () => {
  const f = fakeRunner({ repoFiles: { 'a.md': 'x' }, npmFiles: { 'node_modules/p/package.json': '{}' }, wheels: ['a-1-py3-none-any.whl'] });
  const whDir = path.join(tmp, 'wh-off');
  fs.mkdirSync(whDir, { recursive: true });
  const lf = path.join(whDir, 'requirements.lock');
  fs.writeFileSync(lf, 'six==1.17.0\n');
  const sha = await sha256File(lf);

  const cases = [
    ['git', { g: { kind: 'git', repo: 'https://example.invalid/g.git', commit: GIT_COMMIT, file: 't/g.zip' } }, /^offline: git clone https:\/\/example\.invalid\/g\.git \(g\)$/],
    ['npm', { n: { kind: 'npm-prefix', npm: 'p', version: '1.0.0', integrity: 'sha512-q', file: 't/n.zip' } }, /^offline: npm install p@1\.0\.0 \(n\)$/],
    ['url', { u: { kind: 'url', url: 'https://example.invalid/u.zip', sha256: 'a'.repeat(64), file: 'r/u.zip' } }, /^offline: download u \(https:\/\/example\.invalid\/u\.zip\)$/],
    ['wheelhouse', { w: { kind: 'wheelhouse', requirementsLock: lf, sha256: sha, pythonTag: 'cp312', platform: 'win_amd64', expectedCount: 1, file: 't/wh/' } }, /^offline: pip download w/],
  ];

  await withOffline(async () => {
    for (const [tag, parts, re] of cases) {
      await assert.rejects(
        collect({ lock: { package: { version: '0' }, parts }, ...dirs(`off-${tag}`), log: () => {}, run: f.run, download: f.download }),
        (err) => { assert.match(err.message, re); return true; },
        `offline must block the ${tag} part`,
      );
    }
    assert.equal(f.netCalls().length, 0, 'offline must throw before spawning anything that reaches the network');
    assert.equal(f.downloads.length, 0);
  });
});

// --------------------------------------------------------------------------
// (g) licence harvesting out of a real archive (url kind)
// --------------------------------------------------------------------------

test('url kind lifts LICENSE/NOTICE out of the archive without unpacking it', async () => {
  // A real zip shaped like the runtime archives: one wrapper folder, licence
  // files at depth 2, plus a deep file that must NOT be mistaken for one.
  const src = path.join(tmp, 'archive-src', 'node-v0-win-x64');
  writeTree(src, {
    'LICENSE': 'node licence\n',
    'NOTICE.txt': 'notice\n',
    'bin/node.exe': 'binary',
    'deep/nested/LICENSE': 'must not be picked (depth 3)\n',
    // A *folder* whose name also matches LICENSE* -- numpy's wheel ships
    // exactly this shape (`numpy-2.5.2.dist-info/licenses/`) and it crashed
    // the first real build with EPERM before copyIfFile() was added.
    'LICENSES/third-party.txt': 'bundled deps\n',
  });
  const archive = path.join(tmp, 'archive-src.zip');
  await zipDir(path.join(tmp, 'archive-src'), archive);
  const sha = await sha256File(archive);

  const lock = {
    package: { version: '0' },
    parts: { node: { kind: 'url', version: '0', url: 'https://example.invalid/node.zip', sha256: sha, file: 'runtime/node.zip', dest: 'n', license: 'MIT' } },
  };
  const d = dirs('lic-url');
  const r = await collect({
    lock,
    ...d,
    log: () => {},
    download: async (_url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(archive, dest); },
  });
  assert.deepEqual(r.partsMeta.node.licenseFiles.slice().sort(), ['node-LICENSE', 'node-NOTICE.txt']);
  assert.ok(!fs.existsSync(path.join(r.payloadDir, 'policy/licenses/node-LICENSES')), 'a LICENSE*-named folder must be skipped, not copied');
  assert.equal(fs.readFileSync(path.join(r.payloadDir, 'policy/licenses/node-LICENSE'), 'utf8'), 'node licence\n');
  assert.ok(!fs.existsSync(path.join(r.payloadDir, 'policy/licenses/.extract-node')), 'scratch folder must be cleaned up');
});

// uv and pyyaml are `url` parts that happen to be single wheels, whose licence
// sits three segments deep under <pkg>.dist-info/licenses/ -- too deep for the
// top-level archive scan, so .whl goes through the wheel harvester instead.
test('url kind that is a wheel picks the licence out of .dist-info', async () => {
  const src = path.join(tmp, 'wheel-src');
  writeTree(src, {
    'uv/__init__.py': 'x',
    'uv-0.12.14.dist-info/METADATA': 'meta',
    'uv-0.12.14.dist-info/licenses/LICENSE-MIT': 'MIT text\n',
    'uv-0.12.14.dist-info/licenses/LICENSE-APACHE': 'Apache text\n',
  });
  // Built as .zip and renamed: `tar -a -cf` picks the format from the
  // extension and does not know `.whl`. Reading (tar -tf/-xf, which is all
  // collect() does) sniffs the content instead, so the rename is harmless --
  // and a real wheel arrives over the network already named .whl.
  const built = path.join(tmp, 'uv-wheel.zip');
  await zipDir(src, built);
  const archive = path.join(tmp, 'uv-0.12.14-py3-none-win_amd64.whl');
  fs.copyFileSync(built, archive);
  const sha = await sha256File(archive);
  const lock = {
    package: { version: '0' },
    parts: { uv: { kind: 'url', version: '0.12.14', url: 'https://example.invalid/uv.whl', sha256: sha, file: 'runtime/uv-0.12.14-py3-none-win_amd64.whl', dest: 'u', license: 'Apache-2.0 OR MIT' } },
  };
  const d = dirs('lic-whl');
  const r = await collect({
    lock,
    ...d,
    log: () => {},
    download: async (_url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(archive, dest); },
  });
  assert.deepEqual(r.partsMeta.uv.licenseFiles.slice().sort(), ['uv-uv-0.12.14-LICENSE-APACHE', 'uv-uv-0.12.14-LICENSE-MIT']);
});
