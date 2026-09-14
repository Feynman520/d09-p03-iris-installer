import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pack, renderNotices } from '../build/pack.mjs';
import { sha256File } from '../lib/manifest.mjs';
import { extractZip } from '../lib/zip.mjs';

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
test('pack: ships lib/{run,zip}.mjs and lock.json at the zip root', async () => {
  const installerDir = path.join(tmp, 'fake-installer-lib');
  fs.mkdirSync(installerDir, { recursive: true });
  fs.writeFileSync(path.join(installerDir, 'IRIS-설치.cmd'), '@echo off\r\n');

  const libDir = path.join(tmp, 'fake-lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'run.mjs'), 'export const run = () => {};\n', 'utf8');
  fs.writeFileSync(path.join(libDir, 'zip.mjs'), 'export const zipDir = () => {};\n', 'utf8');
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
  // Deliberately minimal: only what installer/ actually imports travels.
  assert.deepEqual(fs.readdirSync(path.join(extractDir, 'lib')).sort(), ['run.mjs', 'zip.mjs']);

  assert.ok(fs.existsSync(path.join(extractDir, 'lock.json')), 'zip missing lock.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(extractDir, 'lock.json'), 'utf8')), lock);

  // installer/lib/*.mjs resolve `../../lib/run.mjs` to exactly this file.
  const resolved = path.resolve(path.join(extractDir, 'installer', 'lib'), '..', '..', 'lib', 'run.mjs');
  assert.equal(resolved, path.join(extractDir, 'lib', 'run.mjs'));

  // I4: per-part notices generated from the lock.
  const notices = fs.readFileSync(path.join(extractDir, 'payload', 'licenses', 'NOTICES.md'), 'utf8');
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
