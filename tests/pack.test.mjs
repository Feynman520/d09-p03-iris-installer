import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pack } from '../build/pack.mjs';
import { sha256File } from '../lib/manifest.mjs';
import { extractZip } from '../lib/zip.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-pack-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('pack: zip exists at IRIS-설치_v<version>_<date>.zip, .sha256 matches, listing has IRIS-설치.cmd + payload/manifest.json', async () => {
  // Fake stage: one installer file (+ its own ui/.gitkeep, mirroring the
  // real placeholder's shape) and one payload part alongside a manifest --
  // deliberately NOT the real project installer/ dir, so this test stays
  // stable across Task 9+'s real installer UI work.
  const installerDir = path.join(tmp, 'fake-installer');
  fs.mkdirSync(path.join(installerDir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(installerDir, 'IRIS-설치.cmd'), '@echo off\r\necho hi\r\npause\r\n');
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
  assert.equal(path.basename(zipPath), `IRIS-설치_v9.9.9_${today}.zip`);

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
  assert.equal(path.basename(zipPath), `IRIS-설치_v1.2.3_${today}.zip`);
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
