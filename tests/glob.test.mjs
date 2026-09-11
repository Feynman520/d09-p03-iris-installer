import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globMatch } from '../lib/glob.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLOB_SRC = path.join(HERE, '../lib/glob.mjs');

test('lib/glob.mjs contains no non-printable bytes (must stay a text file for git diff/blame)', () => {
  const buf = fs.readFileSync(GLOB_SRC);
  const allowed = new Set([0x09, 0x0a, 0x0d]); // \t \n \r
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte < 0x20 && !allowed.has(byte)) {
      assert.fail(`non-printable byte 0x${byte.toString(16)} at offset ${i}`);
    }
  }
});

test('a literal ? in a glob matches only a literal ?, not "any one character"', () => {
  assert.equal(globMatch('**/file?.txt', 'a/file?.txt'), true);
  assert.equal(globMatch('**/file?.txt', 'a/filex.txt'), false);
});

test('rules-file glob patterns still match the same paths they matched before this rewrite', () => {
  const cases = [
    ['**/.env', '.env', true],
    ['**/.env', 'secrets/.env', true],
    ['**/secrets/**', 'secrets/x.env', true],
    ['**/*.token', 'foo.token', true],
    ['**/*.token', 'a/b/foo.token', true],
    ['**/credentials*', 'credentials-backup', true],
    ['**/.git/**', '.git/config', true],
    ['**/.git/**', 'sub/.git/objects/x', true],
    ['**/LICENSE*', 'lic/LICENSE', true],
    ['**/node_modules/**/*.md', 'node_modules/foo/README.md', true],
    ['**/node_modules/**/*.md', 'node_modules/README.md', true],
    ['**/node_modules/**/*.md', 'src/a.js', false],
    ['**/secrets/**', 'pack.zip!/secrets/x.env', true],
  ];
  for (const [glob, p, expected] of cases) {
    assert.equal(globMatch(glob, p), expected, `${glob} vs ${p}`);
  }
});
