import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sanitize } from '../build/sanitize.mjs';
import { zipDir } from '../lib/zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(fs.readFileSync(path.join(HERE, '../build/sanitize-rules.json'), 'utf8'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-sanitize-test-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function mkroot(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(root, relPath, content) {
  const p = path.join(root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test('brief case: ok.js clean, bad.js with personal string, secrets/x.env, lic/LICENSE with email exempted', async () => {
  const root = mkroot('brief');
  writeFile(root, 'ok.js', "console.log('hello');\n");
  writeFile(root, 'bad.js', "const who = 'test-user';\n");
  writeFile(root, 'secrets/x.env', 'TOKEN=xyz\n');
  writeFile(root, 'lic/LICENSE', 'MIT License. Contact: someone@example.com\n');

  const r = await sanitize(root, RULES);
  assert.equal(r.ok, false);
  const files = r.hits.map((h) => h.file).sort();
  assert.deepEqual(files, ['bad.js', 'secrets/x.env']);
});

test('(a) email in node_modules/*/package.json is skipped by skipUnder', async () => {
  const root = mkroot('nm-skip');
  writeFile(root, 'node_modules/foo/package.json', '{"author":"Someone <someone@example.com>"}\n');

  const r = await sanitize(root, RULES);
  assert.equal(r.ok, true);
  assert.deepEqual(r.hits, []);
});

test('(b) same email outside node_modules produces exactly one hit with a line number', async () => {
  const root = mkroot('email-hit');
  writeFile(root, 'src/a.js', "// contact\nconst email = 'someone@example.com';\n");

  const r = await sanitize(root, RULES);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].file, 'src/a.js');
  assert.equal(r.hits[0].rule, `regex:${RULES.forbiddenRegex[1].pattern}`);
  assert.equal(r.hits[0].line, 2);
});

test('(c) a hardcoded C:\\IRIS path inside a zip is found with a !/-joined file path', async () => {
  const root = mkroot('zip-case');
  const innerSrc = path.join(tmp, 'zip-case-inner');
  writeFile(innerSrc, 'inner/bad.js', "const p = 'C:\\IRIS\\x';\n");
  fs.mkdirSync(root, { recursive: true });
  await zipDir(innerSrc, path.join(root, 'pack.zip'));

  const r = await sanitize(root, RULES);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].file, 'pack.zip!/inner/bad.js');
  assert.equal(r.hits[0].rule, `regex:${RULES.forbiddenRegex[2]}`);
});

test('(f) a JS source literal with two literal backslashes ("C:\\\\IRIS\\\\x") is caught (2026-09-11 regex fix)', async () => {
  // The file on disk must contain TWO literal backslash characters between
  // "C:" and "IRIS" -- i.e. the raw text of a JS string literal such as
  // 'C:\\IRIS\\x' as it appears verbatim in real source code. Writing that
  // here needs 4 backslash chars in this .mjs source (each \\ -> one
  // on-disk backslash), so the file ends up with 2.
  const root = mkroot('double-backslash-js');
  writeFile(root, 'bad.js', "const p = 'C:\\\\IRIS\\\\x';\n");

  const r = await sanitize(root, RULES);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].file, 'bad.js');
  assert.equal(r.hits[0].rule, `regex:${RULES.forbiddenRegex[2]}`);
});

test('(d) a binary file whose bytes happen to contain a forbidden string produces no hits', async () => {
  const root = mkroot('binary-case');
  const buf = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('test-user'), Buffer.from([0, 3])]);
  writeFile(root, 'blob.bin', buf);

  const r = await sanitize(root, RULES);
  assert.equal(r.ok, true);
  assert.deepEqual(r.hits, []);
});

test('allowFiles never exempts a file from forbiddenNames (only from string/regex checks)', async () => {
  const root = mkroot('allow-vs-name');
  // secrets/LICENSE matches both forbiddenNames ("**/secrets/**") and
  // allowFiles ("**/LICENSE*"). allowFiles must not suppress the name hit.
  writeFile(root, 'secrets/LICENSE', 'MIT License\n');

  const r = await sanitize(root, RULES);
  assert.deepEqual(r.hits, [{ file: 'secrets/LICENSE', rule: 'name:**/secrets/**' }]);
});

test('(e) maxBytes overage produces a warning, not a hit, and ok stays true', async () => {
  const root = mkroot('maxbytes-case');
  writeFile(root, 'big.txt', 'x'.repeat(20));

  const r = await sanitize(root, { ...RULES, maxBytes: 10 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.hits, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /big\.txt/);
});
