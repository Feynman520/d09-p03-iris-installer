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

// ---------------------------------------------------------------------------
// T08: HWPX templates, narrow exemptions, ID placeholders, lock redactions
// ---------------------------------------------------------------------------

const BASE_RULES = JSON.parse(fs.readFileSync(path.join(HERE, '../build/sanitize-rules.json'), 'utf8'));

test('every exemption in the tracked rule file states a reason', () => {
  const missing = [];
  for (const rule of BASE_RULES.forbiddenRegex) {
    for (const s of rule.skipUnder ?? []) {
      if (typeof s === 'string' || !s.why) missing.push(`skipUnder ${JSON.stringify(s)} of /${rule.pattern}/`);
    }
  }
  for (const a of BASE_RULES.allowFiles ?? []) {
    if (typeof a === 'string' || !a.why) missing.push(`allowFiles ${JSON.stringify(a)}`);
  }
  assert.deepEqual(missing, [], 'an exemption with no `why` is an exemption nobody can review');
});

// The shipped HWPX form templates are zips of XML. A name typed into a
// document's header or properties lives in that XML, so the scan has to open
// them like any other archive -- before T08 a .hwpx was sniffed as binary
// (its first bytes are the zip header) and skipped entirely.
test('.hwpx is opened like a zip and its inner XML is scanned', async () => {
  const root = mkroot('hwpx-case');
  const innerSrc = path.join(tmp, 'hwpx-inner');
  writeFile(innerSrc, 'Contents/section0.xml', `<?xml version="1.0"?>\n<hp:p>${TEST_STRING_MARKER}</hp:p>\n`);
  writeFile(innerSrc, 'mimetype', 'application/hwp+zip');
  fs.mkdirSync(root, { recursive: true });
  // Build it as .zip and rename: `tar -a` picks the archive format from the
  // extension and does not know `.hwpx`. A real HWPX is a plain zip, so the
  // bytes are the same thing -- only the name differs, which is exactly what
  // the scanner has to cope with.
  const zipTmp = path.join(tmp, 'hwpx-build.zip');
  await zipDir(innerSrc, zipTmp);
  fs.renameSync(zipTmp, path.join(root, 'IRIS-기본양식.hwpx'));

  const r = await sanitize(root, RULES_TM);
  assert.equal(r.hits.length, 1, JSON.stringify(r.hits));
  assert.equal(r.hits[0].file, 'IRIS-기본양식.hwpx!/Contents/section0.xml');
  assert.equal(r.hits[0].rule, `string:${TEST_STRING_MARKER}`);
});

// skipUnder now takes a FULL-PATH glob when the pattern contains a '/', so an
// exemption can be pinned to one part instead of to every file with that
// name. These are the third-party tool parts whose upstream text carries the
// authors' own addresses (T08 ruling 2).
test('the email exemption applies only under the named third-party parts -- and only to the email rule', async () => {
  const root = mkroot('narrow-exemption');
  writeFile(root, 'tools/superpowers.zip!.md', ''); // decoy: a plain file, not the part
  writeFile(root, 'x.js', '');

  // inside the exempted part: an upstream author address is fine...
  const exempted = mkroot('narrow-exempted');
  writeFile(exempted, 'tools/superpowers.zip!/docs/plan.md', 'contact: upstream.author@example.com\n');
  writeFile(exempted, 'tools/frontend-design.zip!/README.md', 'by someone@example.com\n');
  assert.deepEqual((await sanitize(exempted, RULES)).hits, []);

  // ...but the same address one folder over is not
  const notExempted = mkroot('narrow-not-exempted');
  writeFile(notExempted, 'tools/hwp-automation.zip!/docs/plan.md', 'contact: upstream.author@example.com\n');
  writeFile(notExempted, 'setup/ontology.zip!/notes.md', 'contact: upstream.author@example.com\n');
  const r2 = await sanitize(notExempted, RULES);
  assert.deepEqual(r2.hits.map((h) => h.file).sort(), ['setup/ontology.zip!/notes.md', 'tools/hwp-automation.zip!/docs/plan.md']);

  // ...and the exemption is for the EMAIL rule only: a personal-string hit
  // inside the very same exempted part still fails the build.
  const stillCaught = mkroot('narrow-still-caught');
  writeFile(stillCaught, 'tools/superpowers.zip!/docs/plan.md', `path: ${TEST_STRING_MARKER}\nmail: upstream.author@example.com\n`);
  const r3 = await sanitize(stillCaught, RULES_TM);
  assert.deepEqual(r3.hits, [{ file: 'tools/superpowers.zip!/docs/plan.md', rule: `string:${TEST_STRING_MARKER}`, line: 1 }]);
});

test('the C:\\IRIS exemption covers exactly the ontology validator, not its neighbours', async () => {
  const root = mkroot('ontology-exemption');
  writeFile(root, 'setup/ontology.zip!/validate.py', 'for pfx in ("C:\\\\IRIS\\\\", "C:/IRIS/"):\n');
  writeFile(root, 'setup/ontology.zip!/query.py', 'p = "C:\\\\IRIS\\\\x"\n');
  const r = await sanitize(root, RULES);
  assert.deepEqual(r.hits.map((h) => h.file), ['setup/ontology.zip!/query.py']);
});

// The registration-number rule reserves one documentation shape --
// "iris:" + seven zeros + a digit -- and flags every other 8-character id.
test('iris: ids -- the 0000000N documentation placeholder passes, anything else does not', async () => {
  const root = mkroot('iris-ids');
  writeFile(root, 'ok.md', '예 `iris:00000001`, `iris:00000002/S03`.\n');
  writeFile(root, 'bad.md', '예 `iris:k7f3q2mz`.\n');
  const r = await sanitize(root, RULES);
  assert.deepEqual(r.hits, [{ file: 'bad.md', rule: `regex:${RULES.forbiddenRegex[0].pattern}`, line: 1 }]);
});

// T08 ruling 5: the ontology spec is collected from this PC's live file, which
// carries real example ids, an account handle and a rooted path. lock.json
// declares the redactions; this checks they (a) still anchor to exactly one
// place each in the real source -- a silent no-match is the failure mode that
// would ship the original text again -- and (b) leave a file the gate passes.
function applyLockRedactions(text, entries) {
  let out = text;
  for (const entry of entries) {
    const expected = entry.count ?? 1;
    const re = new RegExp(entry.findRegex, 'g');
    const found = out.match(re);
    assert.equal(found ? found.length : 0, expected, `redact anchor matched the wrong number of times: ${entry.findRegex}`);
    out = out.replace(re, entry.replace);
  }
  return out;
}

test('lock redactions clear the ontology spec and the ontology query tool', async (t) => {
  const lock = JSON.parse(fs.readFileSync(path.join(HERE, '../lock.json'), 'utf8'));
  const specSrc = path.resolve(HERE, '..', lock.parts['ontology-spec'].source);
  const ontologySrc = path.resolve(HERE, '..', lock.parts.ontology.source);
  const querySrc = path.join(ontologySrc, 'query.py');
  if (!fs.existsSync(specSrc) || !fs.existsSync(querySrc)) {
    t.skip(`sources not on this machine (${specSrc})`);
    return;
  }

  const root = mkroot('lock-redact');
  fs.mkdirSync(path.join(root, 'setup'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'setup', path.basename(lock.parts['ontology-spec'].file)),
    applyLockRedactions(fs.readFileSync(specSrc, 'utf8'), lock.parts['ontology-spec'].redact),
    'utf8',
  );
  const queryEntry = lock.parts.ontology.redact.find((e) => e.file === 'query.py');
  fs.writeFileSync(
    path.join(root, 'setup', 'query.py'),
    applyLockRedactions(fs.readFileSync(querySrc, 'utf8'), [queryEntry]),
    'utf8',
  );

  const r = await sanitize(root, RULES);
  assert.deepEqual(r.hits, [], 'the redacted ontology files still trip the gate');
});
