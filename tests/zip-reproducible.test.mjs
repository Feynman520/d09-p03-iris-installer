import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipDir, extractZip } from '../lib/zip.mjs';

// verify/reproduce.mjs on macOS (docs/설계-macOS.md M5): the same tree zipped twice must give the same
// bytes. Two leaks were found there: the local-header ctime (kernel status-change time, not settable on
// macOS) and symlink mtimes (utimes follows the link). Electron.app in the face zip has both.
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('zipDir: same tree twice -> identical bytes, symlinks and exec bits survive', { skip: process.platform === 'win32' && 'Windows pins these through creation-time normalisation' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-zip-repro-'));
  const src = path.join(base, 'src');
  fs.mkdirSync(path.join(src, 'App.app', 'Versions', 'A'), { recursive: true });
  fs.writeFileSync(path.join(src, 'App.app', 'Versions', 'A', 'bin'), 'binary', { mode: 0o755 });
  fs.symlinkSync('A', path.join(src, 'App.app', 'Versions', 'Current'));
  fs.symlinkSync('Versions/Current/bin', path.join(src, 'App.app', 'bin'));
  fs.writeFileSync(path.join(src, '한글.txt'), '내용');
  await zipDir(src, path.join(base, 'one.zip'));
  await new Promise((r) => setTimeout(r, 1100)); // let every ctime move on
  fs.writeFileSync(path.join(src, '한글.txt'), '내용'); // same content, new status-change time
  await zipDir(src, path.join(base, 'two.zip'));
  assert.equal(sha(path.join(base, 'one.zip')), sha(path.join(base, 'two.zip')));
  const out = path.join(base, 'out');
  await extractZip(path.join(base, 'two.zip'), out);
  assert.equal(fs.readlinkSync(path.join(out, 'App.app', 'Versions', 'Current')), 'A');
  assert.equal(fs.readFileSync(path.join(out, 'App.app', 'bin'), 'utf8'), 'binary', 'link resolves after extraction');
  assert.equal(fs.statSync(path.join(out, 'App.app', 'Versions', 'A', 'bin')).mode & 0o111, 0o111);
});
