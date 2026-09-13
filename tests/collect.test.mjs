import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collect } from '../build/collect.mjs';
import { extractZip } from '../lib/zip.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-collect-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

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
  const r = await collect({ lock, cacheDir: path.join(tmp, 'c'), stageDir: path.join(tmp, 's'), log: () => {} });
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

test('glob part with two files lands as payload/guides/<basename> for both', async () => {
  const srcDir = path.join(tmp, 'guides-src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, '가이드_v10_ko_최신.md'), 'ko');
  fs.writeFileSync(path.join(srcDir, '가이드_v10_en_최신.md'), 'en');
  fs.writeFileSync(path.join(srcDir, 'other.md'), 'skip');
  const lock = {
    package: { version: '0' },
    parts: { guides: { kind: 'glob', source: srcDir, pattern: '가이드_v10_*_최신.md', file: 'guides/' } },
  };
  const r = await collect({ lock, cacheDir: path.join(tmp, 'c2'), stageDir: path.join(tmp, 's2'), log: () => {} });
  assert.ok(fs.existsSync(path.join(r.payloadDir, 'guides/가이드_v10_ko_최신.md')));
  assert.ok(fs.existsSync(path.join(r.payloadDir, 'guides/가이드_v10_en_최신.md')));
  assert.ok(!fs.existsSync(path.join(r.payloadDir, 'guides/other.md')));
});
