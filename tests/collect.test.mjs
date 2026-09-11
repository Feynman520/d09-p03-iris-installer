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
  fs.writeFileSync(path.join(src, 'a.js'), '1');
  fs.writeFileSync(path.join(src, 'state/x'), '2');
  const lock = { package: { version: '0' }, parts: { face: { kind: 'dir', source: src, exclude: ['state'], file: 'face/iris-face.zip' } } };
  const r = await collect({ lock, cacheDir: path.join(tmp, 'c'), stageDir: path.join(tmp, 's'), log: () => {} });
  await extractZip(path.join(r.payloadDir, 'face/iris-face.zip'), path.join(tmp, 'x'));
  assert.ok(fs.existsSync(path.join(tmp, 'x/a.js')));
  assert.ok(!fs.existsSync(path.join(tmp, 'x/state')));
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
