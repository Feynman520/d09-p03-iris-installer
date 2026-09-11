import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateSoulName, detectExisting, KOREAN_ALLOWED } from '../installer/lib/soulname.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-soulname-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('soul name rules', () => {
  assert.equal(validateSoulName('NOVA').ok, true);
  assert.equal(validateSoulName('NOVA').path, 'C:\\NOVA');
  for (const [n, why] of [['', 'empty'], ['a<b', 'chars'], ['NOVA.', 'trailing'], ['CON', 'reserved'], ['Windows', 'system'], ['Program Files', 'system']]) {
    assert.equal(validateSoulName(n).reason, why, n);
  }
  assert.equal(validateSoulName('비서').ok, KOREAN_ALLOWED);
});

// Reserved MS-DOS device names stay reserved even with an extension --
// Windows treats CON.txt the same as CON.
test('reserved device name with an extension is still reserved', () => {
  assert.equal(validateSoulName('CON.txt').reason, 'reserved');
  assert.equal(validateSoulName('com1.log').reason, 'reserved');
});

// Order of checks matters: a name that is both a forbidden-char violation
// and would otherwise be a system name must report 'chars', not 'system'.
test('check order: empty -> chars -> trailing -> reserved -> system -> korean', () => {
  assert.equal(validateSoulName('').reason, 'empty');
  assert.equal(validateSoulName('a<b').reason, 'chars');
  assert.equal(validateSoulName('NOVA.').reason, 'trailing');
  assert.equal(validateSoulName('PRN').reason, 'reserved');
  assert.equal(validateSoulName('ProgramData').reason, 'system');
});

test('detectExisting', () => {
  const a = path.join(tmp, 'A');
  assert.equal(detectExisting(a), 'none');
  fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, 'x.txt'), '1');
  assert.equal(detectExisting(a), 'conflict');
  fs.writeFileSync(path.join(a, 'soul-state.json'), '{}');
  assert.equal(detectExisting(a), 'soul');
});

test('detectExisting: existing empty folder is none, not conflict', () => {
  const b = path.join(tmp, 'B');
  fs.mkdirSync(b);
  assert.equal(detectExisting(b), 'none');
});
