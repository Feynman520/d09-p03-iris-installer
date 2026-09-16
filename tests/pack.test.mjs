import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pack, renderNotices, buildPackManifest } from '../build/pack.mjs';
import { sha256File, verifyManifest } from '../lib/manifest.mjs';
import { extractZip } from '../lib/zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-pack-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('pack: zip exists at IRIS-Setup_v<version>_<date>.zip, .sha256 matches, listing has IRIS-설치.cmd + payload/manifest.json', async () => {
  // Fake stage: one installer file (+ its own ui/.gitkeep, mirroring the
  // real placeholder's shape) and one payload part alongside a manifest --
  // deliberately NOT the real project installer/ dir, so this test stays
  // stable across Task 9+'s real installer UI work.
  //
  // Both the root .cmd and the nested bootstrap.ps1 are deliberately written
  // with bare LF here (not CRLF) so the CRLF-forcing assertions below only
  // pass if pack() actually normalizes line endings rather than merely
  // copying bytes through -- a source file that already happened to be CRLF
  // would pass even with the old, pre-fix copyFileSync/copyTree-only code.
  const installerDir = path.join(tmp, 'fake-installer');
  fs.mkdirSync(path.join(installerDir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(installerDir, 'IRIS-설치.cmd'), '@echo off\necho hi\npause\n');
  fs.writeFileSync(path.join(installerDir, 'bootstrap.ps1'), "Write-Host 'hi'\nexit 0\n");
  fs.writeFileSync(path.join(installerDir, 'ui', '.gitkeep'), '');

  const stageDir = path.join(tmp, 'stage');
  fs.mkdirSync(path.join(stageDir, 'payload', 'node'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'payload', 'node', 'part.txt'), 'fake node part');
  fs.writeFileSync(path.join(stageDir, 'payload', 'manifest.json'), JSON.stringify({ schema: 1, parts: {} }));

  const outDir = path.join(tmp, 'out');
  const manifest = { package: { version: '0' } };

  const { zipPath, sha256Path } = await pack({ stageDir, outDir, manifest, version: '9.9.9', installerDir });

  assert.ok(fs.existsSync(zipPath), 'zip was not created');
  assert.equal(path.dirname(zipPath), outDir);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(path.basename(zipPath), `IRIS-Setup_v9.9.9_${today}.zip`);

  assert.ok(fs.existsSync(sha256Path));
  const expectedHex = await sha256File(zipPath);
  assert.equal(fs.readFileSync(sha256Path, 'utf8').trim(), `${expectedHex}  ${path.basename(zipPath)}`);

  // Extract and check on disk rather than parsing `tar -tf` text output:
  // bsdtar re-encodes non-ASCII entry names (IRIS-설치.cmd) to the console
  // codepage when listing to a piped stdout, which mangles them under
  // Node's default utf8 Buffer->string decoding (observed 2026-09-11).
  // Extracting sidesteps the encoding entirely.
  const extractDir = path.join(tmp, 'extracted');
  await extractZip(zipPath, extractDir);
  assert.ok(fs.existsSync(path.join(extractDir, 'IRIS-설치.cmd')), 'zip missing IRIS-설치.cmd at root');
  assert.ok(fs.existsSync(path.join(extractDir, 'payload', 'manifest.json')), 'zip missing payload/manifest.json');
  assert.ok(fs.existsSync(path.join(extractDir, 'installer', 'IRIS-설치.cmd')), 'zip missing installer/IRIS-설치.cmd');
  assert.ok(fs.existsSync(path.join(extractDir, 'installer', 'ui', '.gitkeep')), 'zip missing installer/ui/.gitkeep');
  assert.ok(fs.existsSync(path.join(extractDir, 'payload', 'node', 'part.txt')), 'zip missing payload/node/part.txt');

  // Fix round 1 finding #1: pack() must force CRLF on .cmd/.ps1 regardless
  // of the source's line endings (sources above are deliberately bare LF).
  function assertCRLFOnly(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    assert.ok(/\r\n/.test(text), `${filePath}: expected at least one CRLF line ending`);
    const bareLf = text.replace(/\r\n/g, '').match(/\n/g);
    assert.deepEqual(bareLf, null, `${filePath}: found bare LF line ending(s) not paired with CR`);
  }
  assertCRLFOnly(path.join(extractDir, 'IRIS-설치.cmd'));
  assertCRLFOnly(path.join(extractDir, 'installer', 'IRIS-설치.cmd'));
  assertCRLFOnly(path.join(extractDir, 'installer', 'bootstrap.ps1'));
});

// Task 12: the installer verifies the relay by checking every file
// patches/teamclaude/rules.json names, so that one file has to be inside the
// zip. Fix round 1 finding 6: *only* that file -- patches/ also holds
// teamclaude-manage.ps1, which already ships as the payload's `manage` part.
test('pack: ships patches/teamclaude/rules.json into installer/, and nothing else from patches/', async () => {
  const installerDir = path.join(tmp, 'fake-installer-patches');
  fs.mkdirSync(installerDir, { recursive: true });
  fs.writeFileSync(path.join(installerDir, 'IRIS-설치.cmd'), '@echo off\r\n');

  const patchesSrc = path.join(tmp, 'fake-patches', 'teamclaude');
  fs.mkdirSync(patchesSrc, { recursive: true });
  const rulesFile = path.join(patchesSrc, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ files: [{ path: 'src/index.js', replace: [] }] }), 'utf8');
  fs.writeFileSync(path.join(patchesSrc, 'teamclaude-manage.ps1'), 'Write-Host manage\r\n', 'utf8');

  const stageDir = path.join(tmp, 'stage-patches');
  fs.mkdirSync(path.join(stageDir, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'payload', 'manifest.json'), '{}');

  const { zipPath } = await pack({
    stageDir, outDir: path.join(tmp, 'out-patches'), manifest: { package: { version: '0.0.2' } },
    installerDir, patchRulesFile: rulesFile,
  });

  const extractDir = path.join(tmp, 'extracted-patches');
  await extractZip(zipPath, extractDir);
  const packedRules = path.join(extractDir, 'installer', 'patches', 'teamclaude', 'rules.json');
  assert.ok(fs.existsSync(packedRules), 'zip missing installer/patches/teamclaude/rules.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(packedRules, 'utf8')), JSON.parse(fs.readFileSync(rulesFile, 'utf8')));
  assert.deepEqual(
    fs.readdirSync(path.join(extractDir, 'installer', 'patches', 'teamclaude')),
    ['rules.json'],
    'the whole patches/ tree was copied instead of just rules.json',
  );

  // ...and packing without one still works (no patches dir at all).
  const { zipPath: bare } = await pack({
    stageDir, outDir: path.join(tmp, 'out-patches2'), manifest: { package: { version: '0.0.3' } },
    installerDir, patchRulesFile: path.join(tmp, 'nope', 'rules.json'),
  });
  const bareDir = path.join(tmp, 'extracted-bare');
  await extractZip(bare, bareDir);
  assert.ok(!fs.existsSync(path.join(bareDir, 'installer', 'patches')));
});

// 2026-09-12 final review C1/C2: the shipped zip must carry the shared
// helpers installer/lib/*.mjs import as `../../lib/<file>.mjs` AND the
// lock.json that server.mjs's readLock() reads. Without either, every user
// PC failed -- ERR_MODULE_NOT_FOUND at startup (bootstrap exit 13), or 500
// payload_unreadable on POST /api/install.
test('pack: ships lib/{run,zip,net}.mjs and lock.json at the zip root', async () => {
  const installerDir = path.join(tmp, 'fake-installer-lib');
  fs.mkdirSync(installerDir, { recursive: true });
  fs.writeFileSync(path.join(installerDir, 'IRIS-설치.cmd'), '@echo off\r\n');

  const libDir = path.join(tmp, 'fake-lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'run.mjs'), 'export const run = () => {};\n', 'utf8');
  fs.writeFileSync(path.join(libDir, 'zip.mjs'), 'export const zipDir = () => {};\n', 'utf8');
  // net.mjs: the network-0 choke point installer/lib/{install,online,precheck}.mjs
  // import as assertOnline/isOffline (Task 9) -- must travel too.
  fs.writeFileSync(path.join(libDir, 'net.mjs'), 'export const isOffline = () => false;\nexport const assertOnline = () => {};\n', 'utf8');
  fs.writeFileSync(path.join(libDir, 'glob.mjs'), 'export const globMatch = () => {};\n', 'utf8');

  const lockFile = path.join(tmp, 'fake-lock.json');
  const lock = {
    package: { version: '0.0.9' },
    parts: {
      node: { version: '24.17.0', license: 'MIT', url: 'https://example.invalid/node.zip', file: 'node/n.zip' },
      codex: { version: '0.154.0', license: 'Apache-2.0', npm: '@openai/codex', file: 'agents/c.zip' },
      claude: { version: '2.1.267', license: 'Proprietary', npm: '@anthropic-ai/claude-code', redistribute: 'download', file: 'agents/cc.zip' },
    },
  };
  fs.writeFileSync(lockFile, JSON.stringify(lock), 'utf8');

  const stageDir = path.join(tmp, 'stage-lib');
  fs.mkdirSync(path.join(stageDir, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'payload', 'manifest.json'), '{}');

  const { zipPath } = await pack({
    stageDir, outDir: path.join(tmp, 'out-lib'), manifest: { package: { version: '0.0.9' } },
    installerDir, libDir, lockFile, patchRulesFile: null,
  });
  const extractDir = path.join(tmp, 'extracted-lib');
  await extractZip(zipPath, extractDir);

  assert.ok(fs.existsSync(path.join(extractDir, 'lib', 'run.mjs')), 'zip missing lib/run.mjs');
  assert.ok(fs.existsSync(path.join(extractDir, 'lib', 'zip.mjs')), 'zip missing lib/zip.mjs');
  assert.ok(fs.existsSync(path.join(extractDir, 'lib', 'net.mjs')), 'zip missing lib/net.mjs');
  // Deliberately minimal: only what installer/ actually imports travels.
  assert.deepEqual(fs.readdirSync(path.join(extractDir, 'lib')).sort(), ['net.mjs', 'run.mjs', 'zip.mjs']);

  assert.ok(fs.existsSync(path.join(extractDir, 'lock.json')), 'zip missing lock.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(extractDir, 'lock.json'), 'utf8')), lock);

  // installer/lib/*.mjs resolve `../../lib/run.mjs` to exactly this file.
  const resolved = path.resolve(path.join(extractDir, 'installer', 'lib'), '..', '..', 'lib', 'run.mjs');
  assert.equal(resolved, path.join(extractDir, 'lib', 'run.mjs'));

  // I4: per-part notices generated from the lock. T08 moved them next to the
  // harvested licence texts (payload\policy\licenses\, 설계 3-1).
  const notices = fs.readFileSync(path.join(extractDir, 'payload', 'policy', 'licenses', 'NOTICES.md'), 'utf8');
  assert.match(notices, /\| node \| 24\.17\.0 \| MIT \| https:\/\/example\.invalid\/node\.zip \|/);
  assert.match(notices, /\| codex \| 0\.154\.0 \| Apache-2\.0 \| https:\/\/www\.npmjs\.com\/package\/@openai\/codex \|/);
  assert.match(notices, /claude: NOT bundled/);
});

test('pack: fails loudly when a required lib file or lock.json is missing', async () => {
  const installerDir = path.join(tmp, 'fake-installer-lib2');
  fs.mkdirSync(installerDir, { recursive: true });
  fs.writeFileSync(path.join(installerDir, 'IRIS-설치.cmd'), '@echo off\r\n');
  const stageDir = path.join(tmp, 'stage-lib2');
  fs.mkdirSync(path.join(stageDir, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'payload', 'manifest.json'), '{}');

  const emptyLib = path.join(tmp, 'empty-lib');
  fs.mkdirSync(emptyLib, { recursive: true });
  await assert.rejects(
    pack({
      stageDir, outDir: path.join(tmp, 'out-lib2'), manifest: { package: { version: '0.0.9' } },
      installerDir, libDir: emptyLib,
    }),
    /required lib file not found/,
  );

  await assert.rejects(
    pack({
      stageDir, outDir: path.join(tmp, 'out-lib3'), manifest: { package: { version: '0.0.9' } },
      installerDir, lockFile: path.join(tmp, 'no-such-lock.json'),
    }),
    /lock\.json not found/,
  );
});

test('renderNotices: one row per lock part, generated (not hand-written)', () => {
  const lock = {
    package: { version: '1.0.0', guideVersion: '10' },
    parts: {
      git: { version: '2.54.0.windows.1', license: 'GPL-2.0-only', url: 'https://example.invalid/mingit.zip' },
      face: { license: 'MIT' },
      guides: { license: 'MIT' },
      manage: { license: 'MIT' },
      nolicense: {},
    },
  };
  const md = renderNotices(lock, { parts: { face: { version: '2.46.0' } } });
  assert.match(md, /Do not edit by hand/);
  assert.match(md, /\| git \| 2\.54\.0\.windows\.1 \| GPL-2\.0-only \|/);
  // face has no lock version -- the manifest is the only place it exists.
  assert.match(md, /\| face \| 2\.46\.0 \| MIT \|/);
  // guides is versioned package-wide...
  assert.match(md, /\| guides \| 10 \| MIT \|/);
  // ...and a part with no version anywhere says so, instead of borrowing
  // the guide version (which is what the first cut of this wrongly did).
  assert.match(md, /\| manage \| - \| MIT \| IRIS/);
  assert.match(md, /\| nolicense \| - \| \(미기재/);
});

test('pack: falls back to manifest.package.version when version is omitted', async () => {
  const installerDir = path.join(tmp, 'fake-installer-2');
  fs.mkdirSync(installerDir, { recursive: true });
  fs.writeFileSync(path.join(installerDir, 'IRIS-설치.cmd'), '@echo off\r\n');

  const stageDir = path.join(tmp, 'stage2');
  fs.mkdirSync(path.join(stageDir, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'payload', 'manifest.json'), '{}');

  const outDir = path.join(tmp, 'out2');
  const manifest = { package: { version: '1.2.3' } };
  const { zipPath } = await pack({ stageDir, outDir, manifest, installerDir });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(path.basename(zipPath), `IRIS-Setup_v1.2.3_${today}.zip`);
});

test('pack: throws when installerDir has no IRIS-설치.cmd', async () => {
  const installerDir = path.join(tmp, 'fake-installer-missing-cmd');
  fs.mkdirSync(installerDir, { recursive: true });

  const stageDir = path.join(tmp, 'stage3');
  fs.mkdirSync(path.join(stageDir, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'payload', 'manifest.json'), '{}');

  await assert.rejects(
    pack({ stageDir, outDir: path.join(tmp, 'out3'), manifest: { package: { version: '0.0.1' } }, installerDir }),
    /IRIS-설치\.cmd not found/,
  );
});

// 2026-09-14 field report: a user's second PC could not open the shipped
// v1.3.1 zip with Windows Explorer ("The Compressed (zipped) Folder is
// invalid"). Root cause: zipDir packed with `tar -C dir .`, which names every
// entry `./…` plus a bare `./` entry -- Explorer's zipfldr then sees an empty
// archive. Two guards: (1) no entry name may start with `./` (any OS, via
// `tar -tf`, whose ASCII prefix survives the console re-encoding noted above);
// (2) on Windows, Explorer's own engine (Shell.Application) must list the
// root items -- that is the exact call "Extract All" makes.
test('pack: zip entries have no ./ prefix and Windows Explorer can list the archive', async () => {
  const installerDir = path.join(tmp, 'fake-installer-explorer');
  fs.mkdirSync(installerDir, { recursive: true });
  fs.writeFileSync(path.join(installerDir, 'IRIS-설치.cmd'), '@echo off\r\n');

  const stageDir = path.join(tmp, 'stage-explorer');
  fs.mkdirSync(path.join(stageDir, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'payload', 'manifest.json'), '{}');

  const { zipPath } = await pack({
    stageDir, outDir: path.join(tmp, 'out-explorer'), manifest: { package: { version: '0.0.4' } }, installerDir,
  });

  const { execFileSync } = await import('node:child_process');
  const listing = execFileSync('C:\\Windows\\System32\\tar.exe', ['-tf', zipPath], { encoding: 'latin1' })
    .split(/\r?\n/).filter(Boolean);
  assert.ok(listing.length >= 4, `unexpectedly short listing: ${listing.join(', ')}`);
  const dotted = listing.filter((n) => n === './' || n.startsWith('./') || n.startsWith('/'));
  assert.deepEqual(dotted, [], 'zip entries must not carry a ./ (or /) prefix -- Windows Explorer treats such a zip as empty');

  if (process.platform !== 'win32') return;
  // Zip path travels via env var, not argv (see lib/zip.mjs getShortPath for why).
  const ps = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $s = New-Object -ComObject Shell.Application; $ns = $s.NameSpace($env:IRIS_TEST_ZIP); if ($null -eq $ns) { 'NULL' } else { ($ns.Items() | ForEach-Object { $_.Name }) -join '|' }";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', env: { ...process.env, IRIS_TEST_ZIP: zipPath },
  }).trim();
  assert.notEqual(out, 'NULL', 'Explorer could not open the zip at all');
  const names = out ? out.split('|') : [];
  assert.ok(names.length >= 4, `Explorer sees ${names.length} root item(s) (${out || 'none'}) -- "Extract All" would fail`);
  assert.ok(names.some((n) => /^IRIS-설치/.test(n)), `Explorer listing lacks IRIS-설치.cmd: ${out}`);
});

// ---------------------------------------------------------------------------
// T08: the v2 zip tree (설계 3-1)
// ---------------------------------------------------------------------------

// A fake installer dir shaped like the real one in the ways this test is
// about: a dev-only mock backend, a unit test file, and one real asset.
function fakeInstaller(dir) {
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'IRIS-설치.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(dir, 'server.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '<!doctype html>\n');
  fs.writeFileSync(path.join(dir, 'ui', 'mock-server.mjs'), 'export const mock = 1;\n');
  fs.writeFileSync(path.join(dir, 'lib', 'paths.mjs'), 'export const p = 1;\n');
  fs.writeFileSync(path.join(dir, 'lib', 'paths.test.mjs'), 'export const t = 1;\n');
  return dir;
}

test('pack: zip tree is 설계 3-1 -- 설치가 안 되면.txt at the root (BOM kept), policy templates without the folder README, presets.json + fixtures under setup\\, no mock-server / *.test.*', async () => {
  const installerDir = fakeInstaller(path.join(tmp, 'fake-installer-tree'));

  const stageDir = path.join(tmp, 'stage-tree');
  const payload = path.join(stageDir, 'payload');
  // The nine payload folders collect() produces (설계 3-1) -- one token file
  // each is enough for a tree-shape assertion.
  for (const d of ['runtime', 'agents', 'relay', 'face', 'dash', 'tools', 'setup', 'policy/licenses', 'updater']) {
    fs.mkdirSync(path.join(payload, ...d.split('/')), { recursive: true });
  }
  fs.writeFileSync(path.join(payload, 'runtime', 'node.zip'), 'x');
  fs.writeFileSync(path.join(payload, 'policy', 'licenses', 'node-LICENSE'), 'MIT\n');
  fs.writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify({ schema: 1, parts: {} }));

  const { zipPath } = await pack({
    stageDir, outDir: path.join(tmp, 'out-tree'), manifest: { package: { version: '2.0.0' } }, installerDir,
  });
  const extractDir = path.join(tmp, 'extracted-tree');
  await extractZip(zipPath, extractDir);
  const at = (...p) => path.join(extractDir, ...p);

  // --- zip root
  assert.ok(fs.existsSync(at('IRIS-설치.cmd')), 'zip root missing IRIS-설치.cmd');
  assert.ok(fs.existsSync(at('설치가 안 되면.txt')), 'zip root missing 설치가 안 되면.txt');
  assert.ok(fs.existsSync(at('installer')) && fs.existsSync(at('payload')));
  // Byte-identical to payload-src\policy\install-notice.txt -- including the
  // UTF-8 BOM, without which Notepad shows mojibake for the Korean.
  const noticeSrc = fs.readFileSync(path.join(REPO, 'payload-src', 'policy', 'install-notice.txt'));
  const noticePacked = fs.readFileSync(at('설치가 안 되면.txt'));
  assert.deepEqual([...noticePacked.slice(0, 3)], [0xef, 0xbb, 0xbf], '설치가 안 되면.txt lost its UTF-8 BOM');
  assert.ok(noticeSrc.equals(noticePacked), '설치가 안 되면.txt is not a byte copy of policy/install-notice.txt');

  // --- installer\ : dev-only files must not travel
  assert.ok(fs.existsSync(at('installer', 'server.mjs')));
  assert.ok(fs.existsSync(at('installer', 'ui', 'index.html')));
  assert.ok(!fs.existsSync(at('installer', 'ui', 'mock-server.mjs')), 'installer/ui/mock-server.mjs must be excluded');
  assert.ok(!fs.existsSync(at('installer', 'lib', 'paths.test.mjs')), '*.test.* under installer/ must be excluded');
  assert.ok(fs.existsSync(at('installer', 'lib', 'paths.mjs')), 'a normal installer lib file must still travel');

  // --- payload\policy\ : every template except the folder's own README
  for (const f of ['root-AGENTS.md', 'mini-AGENTS.md', 'mini-AGENTS-util.md', 'policy-summary.md', 'CLAUDE.md', 'ontology-registry-template.yml', 'install-notice.txt']) {
    assert.ok(fs.existsSync(at('payload', 'policy', f)), `payload/policy/${f} missing`);
  }
  assert.ok(!fs.existsSync(at('payload', 'policy', 'README.md')), 'payload-src/policy/README.md is a note to us; it must not ship');
  assert.ok(fs.existsSync(at('payload', 'policy', 'licenses', 'README.md')), 'policy/licenses/README.md explains the folder to the user and must ship');
  assert.ok(fs.existsSync(at('payload', 'policy', 'licenses', 'NOTICES.md')));
  assert.ok(fs.existsSync(at('payload', 'policy', 'licenses', 'node-LICENSE')), 'harvested licences must survive the policy copy');

  // --- payload\setup\ : presets + fixtures placeholder
  const presets = JSON.parse(fs.readFileSync(at('payload', 'setup', 'presets.json'), 'utf8'));
  assert.deepEqual(
    presets,
    JSON.parse(fs.readFileSync(path.join(REPO, 'installer', 'ui', 'presets.json'), 'utf8')),
    'payload/setup/presets.json must be the same content the UI reads',
  );
  assert.ok(fs.existsSync(at('payload', 'setup', 'fixtures', 'README.md')), 'setup/fixtures placeholder missing');

  // --- the nine folders of 설계 3-1 all present
  const payloadDirs = fs.readdirSync(at('payload'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(payloadDirs, ['agents', 'dash', 'face', 'policy', 'relay', 'runtime', 'setup', 'tools', 'updater']);
});

test('pack: manifest.json is schema 2 -- every payload file fingerprinted, part meta from collect, folder parts fanned out, download parts kept out of parts{}', async () => {
  const installerDir = fakeInstaller(path.join(tmp, 'fake-installer-manifest'));

  const stageDir = path.join(tmp, 'stage-manifest');
  const payload = path.join(stageDir, 'payload');
  fs.mkdirSync(path.join(payload, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(payload, 'tools', 'wheelhouse'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'runtime', 'node.zip'), 'node bytes');
  fs.writeFileSync(path.join(payload, 'tools', 'wheelhouse', 'a-1-py3-none-any.whl'), 'wheel a');
  fs.writeFileSync(path.join(payload, 'tools', 'wheelhouse', 'b-1-py3-none-any.whl'), 'wheel b');
  fs.writeFileSync(path.join(payload, 'manifest.json'), '{}');

  // exactly the shape build/collect.mjs writes to _build\stage\parts-meta.json
  fs.writeFileSync(path.join(stageDir, 'parts-meta.json'), JSON.stringify({
    node: {
      kind: 'url', version: '24.21.0', dest: '_agent/shared/tools/node', file: 'runtime/node.zip',
      license: 'MIT', licenseNotice: null, redistribute: 'bundle', licenseFiles: ['node-LICENSE'],
      sha256: 'deadbeef', url: 'https://example.invalid/node.zip',
    },
    'document-mcp-wheelhouse': {
      kind: 'wheelhouse', version: null, dest: '_agent/shared/tools/python-wheelhouse/document-mcp',
      file: 'tools/wheelhouse/', license: 'various', redistribute: 'bundle', licenseFiles: [],
      requirementsLock: 'payload-src/manifests/python-locks/document-mcp/requirements.lock', wheelCount: 2,
    },
    claude: {
      kind: 'claude-release', version: '2.1.272', dest: '_agent/shared/tools/claude',
      file: 'agents/claude-code-2.1.272.zip', license: 'Proprietary', redistribute: 'download', licenseFiles: [],
      download: { url: 'https://example.invalid/claude.exe', manifestUrl: 'https://example.invalid/m.json', sha256: 'abc', fallback: { npm: '@anthropic-ai/claude-code' } },
    },
  }, null, 2));

  const { zipPath } = await pack({
    stageDir, outDir: path.join(tmp, 'out-manifest'), manifest: { package: { version: '2.0.0' }, built: '2026-09-15T00:00:00.000Z' }, installerDir,
  });
  const extractDir = path.join(tmp, 'extracted-manifest');
  await extractZip(zipPath, extractDir);
  const payloadDir = path.join(extractDir, 'payload');
  const m = JSON.parse(fs.readFileSync(path.join(payloadDir, 'manifest.json'), 'utf8'));

  assert.equal(m.schema, 2);
  assert.equal(m.package.version, '2.0.0');
  assert.equal(m.package.name, 'IRIS');

  // part meta survives collect -> manifest untouched
  assert.equal(m.parts.node.kind, 'url');
  assert.equal(m.parts.node.dest, '_agent/shared/tools/node');
  assert.equal(m.parts.node.license, 'MIT');
  assert.deepEqual(m.parts.node.licenseFiles, ['node-LICENSE']);
  assert.equal(m.parts.node.bytes, 'node bytes'.length);
  assert.match(m.parts.node.sha256, /^[0-9a-f]{64}$/, 'the manifest sha256 must be the FILE hash, not the lock value');

  // a folder part fans out into "<name>:<basename>" keys (v1 behaviour kept:
  // lib/manifest.mjs verifyManifest and verify/static.mjs ③ rely on it)
  const wheelKeys = Object.keys(m.parts).filter((k) => k.startsWith('document-mcp-wheelhouse:')).sort();
  assert.deepEqual(wheelKeys, ['document-mcp-wheelhouse:a-1-py3-none-any.whl', 'document-mcp-wheelhouse:b-1-py3-none-any.whl']);
  assert.equal(m.parts['document-mcp-wheelhouse:a-1-py3-none-any.whl'].file, 'tools/wheelhouse/a-1-py3-none-any.whl');

  // download parts have no file in payload\: they belong in downloads{}, or
  // verifyManifest would report each of them as a missing file.
  assert.ok(!('claude' in m.parts), 'a redistribute:download part must not be in parts{}');
  assert.equal(m.downloads.claude.download.url, 'https://example.invalid/claude.exe');
  assert.equal(m.downloads.claude.redistribute, 'download');

  // every payload file (including the ones no part owns) is fingerprinted
  for (const rel of ['policy/root-AGENTS.md', 'policy/licenses/NOTICES.md', 'setup/presets.json', 'setup/fixtures/README.md', 'runtime/node.zip']) {
    assert.ok(m.files[rel], `manifest.files is missing ${rel}`);
    assert.match(m.files[rel].sha256, /^[0-9a-f]{64}$/);
    assert.equal(m.files[rel].sha256, await sha256File(path.join(payloadDir, rel)));
  }
  assert.ok(!('manifest.json' in m.files), 'manifest.json cannot fingerprint itself');

  // and the hashes are true of the zip that was actually written
  const mv = await verifyManifest(payloadDir, m);
  assert.equal(mv.ok, true, JSON.stringify(mv.mismatches));

  // the stage copy is the same bytes as the shipped one (verify/reproduce.mjs
  // compares stage manifests)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(payload, 'manifest.json'), 'utf8')),
    m,
    'stage payload/manifest.json must equal the packed one',
  );
});

test('buildPackManifest: a part that names a file which was never staged fails loudly', async () => {
  const payloadDir = path.join(tmp, 'manifest-missing', 'payload');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'there.txt'), 'x');
  await assert.rejects(
    buildPackManifest({ payloadDir, lock: { package: { version: '1' } }, partsMeta: { ghost: { kind: 'url', file: 'runtime/ghost.zip' } } }),
    /part ghost declares runtime\/ghost\.zip but it is not in payload/,
  );
  await assert.rejects(
    buildPackManifest({ payloadDir, lock: { package: { version: '1' } }, partsMeta: { ghosts: { kind: 'wheelhouse', file: 'tools/nothing/' } } }),
    /part ghosts declares tools\/nothing\/ but no file was staged there/,
  );
});

// T08 ruling 4: the shipped gen-image.py is a generalized copy in this repo
// (payload-src\tools\), not this PC's live tool, which hardcodes the agent
// config folder. lock.json must point at the copy, the copy must carry no
// rooted install path, and it must still be valid Python.
test('gen-image: the shipped copy derives its paths from the environment and compiles', () => {
  const copyPath = path.join(REPO, 'payload-src', 'tools', 'gen-image.py');
  assert.ok(fs.existsSync(copyPath), 'payload-src/tools/gen-image.py is missing');

  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));
  assert.equal(lock.parts['gen-image'].source, 'payload-src/tools/gen-image.py');

  const text = fs.readFileSync(copyPath, 'utf8');
  // No rooted path literal anywhere: that is exactly what the sanitize rule
  // C:[\\/]+IRIS[\\/] looks for, and this copy exists to have none.
  assert.equal(/C:[\\/]+IRIS[\\/]/.test(text), false, 'the shipped copy still carries a rooted install path');
  assert.match(text, /os\.environ\.get\("CLAUDE_CONFIG_DIR"\)/);
  assert.match(text, /os\.environ\.get\("IRIS_ROOT"/);
  assert.match(text, /os\.environ\.get\("CODEX_HOME"\)/);
  // behaviour otherwise identical: the tool's own entry points are intact
  assert.match(text, /def main\(/);
  assert.match(text, /gpt-image/);

  let python = null;
  for (const [cmd, args] of [['python', ['-c', 'pass']], ['py', ['-3', '-c', 'pass']]]) {
    try { execFileSync(cmd, args, { stdio: 'ignore' }); python = [cmd, args.slice(0, -2)]; break; } catch { /* try next */ }
  }
  if (!python) return; // no interpreter on this machine: the text checks above still ran
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-pycompile-'));
  try {
    execFileSync(python[0], [...python[1], '-m', 'py_compile', copyPath], {
      stdio: 'pipe', env: { ...process.env, PYTHONPYCACHEPREFIX: scratch, PYTHONUTF8: '1' },
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 24a: 내용 지문 (contentFingerprint)
// ---------------------------------------------------------------------------
//
// Why this exists: the zip's own sha256 changes on EVERY build, because
// payload\manifest.json carries a `built` timestamp. The release gate
// (iris-release.mjs) builds and then demands that docs\시험행렬.md's rows
// already carry the fingerprint of that just-made build -- unsatisfiable with
// a zip sha, hence the deadlock this fingerprint fixes. So the two properties
// below are the contract, not incidental behaviour:
//   (1) nothing changed  -> SAME contentFingerprint, DIFFERENT zip sha
//   (2) anything shipped changed -> DIFFERENT contentFingerprint
// (2) is deliberately wider than manifest.files (payload\ only): a change to
// installer\ must invalidate the rows too, which is the whole point of
// "re-run the scenarios after a code change".

function fingerprintCase(name) {
  const installerDir = fakeInstaller(path.join(tmp, `fp-installer-${name}`));
  const stageDir = path.join(tmp, `fp-stage-${name}`);
  const payload = path.join(stageDir, 'payload');
  fs.mkdirSync(path.join(payload, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'runtime', 'node.zip'), 'node bytes');
  fs.writeFileSync(path.join(payload, 'manifest.json'), '{}');
  return { installerDir, stageDir, payload };
}

function packFp(c, label, built) {
  return pack({
    stageDir: c.stageDir,
    outDir: path.join(tmp, `fp-out-${label}`),
    manifest: { package: { version: '2.0.0' }, built },
    installerDir: c.installerDir,
  });
}

test('pack: contentFingerprint is 64 hex, travels in manifest+return, and is STABLE across rebuilds whose only difference is `built` (the zip sha is not)', async () => {
  const c = fingerprintCase('stable');

  const a = await packFp(c, 'stable-a', '2026-09-15T00:00:00.000Z');
  const b = await packFp(c, 'stable-b', '2026-09-15T09:30:00.000Z');

  assert.match(a.contentFingerprint, /^[0-9a-f]{64}$/, 'contentFingerprint must be 64 lowercase hex');
  assert.equal(a.manifest.contentFingerprint, a.contentFingerprint, 'the manifest must carry the same value pack() returned');
  assert.equal(a.manifest.schema, 2, 'schema stays 2 -- contentFingerprint is one more field, not a new schema');

  assert.equal(b.contentFingerprint, a.contentFingerprint,
    '내용 지문 must not change when only the built timestamp differs (otherwise the release gate deadlocks again)');
  assert.notEqual(a.manifest.built, b.manifest.built, 'this test is meaningless unless the two builds really differ in `built`');
  assert.notEqual(await sha256File(a.zipPath), await sha256File(b.zipPath),
    'the zip sha256 SHOULD differ between the two builds -- that is the whole reason contentFingerprint exists');

  // and it is inside the shipped zip, not just in the return value
  const extractDir = path.join(tmp, 'fp-extracted');
  await extractZip(a.zipPath, extractDir);
  const shipped = JSON.parse(fs.readFileSync(path.join(extractDir, 'payload', 'manifest.json'), 'utf8'));
  assert.equal(shipped.contentFingerprint, a.contentFingerprint);
  // the stage copy stays byte-identical to the shipped one (reproduce.mjs reads
  // the stage) -- for the build that ran LAST, which is b.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.payload, 'manifest.json'), 'utf8')), b.manifest);
});

test('pack: contentFingerprint CHANGES when a shipped payload file changes', async () => {
  const c = fingerprintCase('payload-change');
  const before = await packFp(c, 'payload-change-a', '2026-09-15T00:00:00.000Z');

  fs.writeFileSync(path.join(c.payload, 'runtime', 'node.zip'), 'node bytes -- different');
  const after = await packFp(c, 'payload-change-b', '2026-09-15T00:00:00.000Z'); // same `built` on purpose

  assert.notEqual(after.contentFingerprint, before.contentFingerprint,
    'a changed payload file must invalidate the 시험행렬 rows');
});

test('pack: contentFingerprint CHANGES when an installer\\ file changes (manifest.files alone would miss this)', async () => {
  const c = fingerprintCase('installer-change');
  const before = await packFp(c, 'installer-change-a', '2026-09-15T00:00:00.000Z');

  // installer\server.mjs is shipped code, but it is NOT in manifest.files
  // (which walks payload\ only) -- the fingerprint covers the whole zip root
  // precisely so that a code change like this one forces a re-run.
  fs.writeFileSync(path.join(c.installerDir, 'server.mjs'), 'export const x = 2;\n');
  const after = await packFp(c, 'installer-change-b', '2026-09-15T00:00:00.000Z');

  assert.notEqual(after.contentFingerprint, before.contentFingerprint,
    'a changed installer file must invalidate the 시험행렬 rows');
});
