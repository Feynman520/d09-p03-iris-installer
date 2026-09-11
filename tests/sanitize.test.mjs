import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sanitize } from '../build/sanitize.mjs';
import { zipDir } from '../lib/zip.mjs';
import { loadRules } from '../build/rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// loadRules() (not a raw JSON.parse of sanitize-rules.json) so this test
// exercises the same merged rules (base + gitignored sanitize-local.json)
// that build.mjs/static.mjs actually use -- this developer's actual personal
// strings (account handle, school domain, etc.) now live only in the local
// file (C1/C2: the tracked sanitize-rules.json no longer embeds any real
// personal string).
const RULES = loadRules({ baseFile: path.join(HERE, '../build/sanitize-rules.json'), localFile: path.join(HERE, '../build/sanitize-local.json') });

// Fix round 1 (C2/repo-clean): tests/sanitize.test.mjs is itself a git-tracked
// file, so tests/repo-clean.test.mjs scans it with the same real merged
// rules above -- a literal occurrence of this developer's actual personal
// string (e.g. the real account handle) inside a JS string fixture here
// would trip that scan. The forbiddenStrings-detection tests below use this
// synthetic marker instead, added to a local copy of the rules, so the
// mechanism is still exercised without embedding real personal data in a
// tracked file.
const TEST_STRING_MARKER = 'ZZZ-TEST-PERSONAL-STRING-MARKER-ZZZ';
const RULES_TM = { ...RULES, forbiddenStrings: [...(RULES.forbiddenStrings ?? []), TEST_STRING_MARKER] };

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
  writeFile(root, 'bad.js', `const who = '${TEST_STRING_MARKER}';\n`);
  writeFile(root, 'secrets/x.env', 'TOKEN=xyz\n');
  writeFile(root, 'lic/LICENSE', 'MIT License. Contact: someone@example.com\n');

  const r = await sanitize(root, RULES_TM);
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
  assert.equal(r.hits[0].rule, `regex:${RULES.forbiddenRegex[2].pattern}`);
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
  assert.equal(r.hits[0].rule, `regex:${RULES.forbiddenRegex[2].pattern}`);
});

test('(d) a binary file whose bytes happen to contain a forbidden string produces no hits', async () => {
  const root = mkroot('binary-case');
  const buf = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(TEST_STRING_MARKER), Buffer.from([0, 3])]);
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

// ---------------------------------------------------------------------------
// I7 (2026-09-12 final review): a missing local rule file must be loud.
// ---------------------------------------------------------------------------
// build/sanitize-local.json is gitignored and holds the only personal-string
// rules there are. Without it the gate still printed "sanitize: ok (0 hits)"
// while checking nothing personal at all -- indistinguishable, in the log,
// from a real pass. Now: a warning always, and a hard failure for release
// builds (build/build.mjs --require-local / IRIS_BUILD_REQUIRE_LOCAL=1).
test('loadRules: warns loudly when the local rule file is missing', () => {
  const warnings = [];
  const rules = loadRules({
    baseFile: path.join(HERE, '../build/sanitize-rules.json'),
    localFile: path.join(HERE, 'no-such-sanitize-local.json'),
    warn: (m) => warnings.push(m),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WARNING/);
  assert.match(warnings[0], /base rules ONLY/);
  assert.match(warnings[0], /--require-local/);
  assert.ok(Array.isArray(rules.forbiddenRegex), 'base rules should still be returned');
});

test('loadRules: --require-local turns a missing local rule file into a build failure', () => {
  assert.throws(
    () => loadRules({
      baseFile: path.join(HERE, '../build/sanitize-rules.json'),
      localFile: path.join(HERE, 'no-such-sanitize-local.json'),
      requireLocal: true,
      warn: () => {},
    }),
    /local rule file is required but missing/,
  );
});

test('loadRules: no warning when the local rule file is present', () => {
  const warnings = [];
  loadRules({
    baseFile: path.join(HERE, '../build/sanitize-rules.json'),
    localFile: path.join(HERE, '../build/sanitize-local.example.json'),
    requireLocal: true,
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(warnings, []);
});

// build.mjs must actually expose the switch (and the env form) -- the doc in
// docs/검증기록.md tells the release procedure to use it.
test('build.mjs accepts --require-local and honours IRIS_BUILD_REQUIRE_LOCAL=1', () => {
  const buildText = fs.readFileSync(path.join(HERE, '../build/build.mjs'), 'utf8');
  assert.match(buildText, /'--require-local'/);
  assert.match(buildText, /IRIS_BUILD_REQUIRE_LOCAL/);
  assert.match(buildText, /requireLocal: opts\.requireLocal/);
});
