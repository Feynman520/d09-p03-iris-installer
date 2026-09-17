import { test, after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sha256File, buildManifest, verifyManifest } from '../lib/manifest.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-mf-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// lib/manifest.mjs
// ---------------------------------------------------------------------------

test('sha256File matches known vector', async () => {
  const f = path.join(tmp, 'a.txt'); fs.writeFileSync(f, 'abc');
  assert.equal(await sha256File(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('build then verify ok; tamper → mismatch', async () => {
  const payload = path.join(tmp, 'payload'); fs.mkdirSync(path.join(payload, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'runtime/n.zip'), 'zip');
  const lock = { package: { version: '2.0.0' }, parts: { node: { version: '24.21.0', file: 'runtime/n.zip' } } };
  const m = await buildManifest({ payloadDir: payload, lock, faceVersion: '2.29.0' });
  assert.equal(m.schema, 1); assert.equal(m.parts.node.bytes, 3); assert.equal(m.package.name, 'IRIS');
  assert.equal(m.package.version, '2.0.0');
  assert.deepEqual(await verifyManifest(payload, m), { ok: true, mismatches: [] });
  fs.writeFileSync(path.join(payload, 'runtime/n.zip'), 'zip!');
  const r = await verifyManifest(payload, m); assert.equal(r.ok, false); assert.equal(r.mismatches[0].file, 'runtime/n.zip');
});

// A part whose `file` ends in `/` fans out into one manifest entry per file
// (v2: the wheelhouse -- 43 wheels under one part name). One file must be
// keyed exactly like many: `<part>:<basename>`, never bare `<part>`.
test('multi-file part with exactly one file is still keyed name:basename', async () => {
  const payload = path.join(tmp, 'payload-many-one'); fs.mkdirSync(path.join(payload, 'tools/wheelhouse'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'tools/wheelhouse/one-1.0-py3-none-any.whl'), 'wheel-one');
  const lock = { package: { version: '2.0.0' }, parts: { wheelhouse: { version: '1', file: 'tools/wheelhouse/' } } };
  const m = await buildManifest({ payloadDir: payload, lock, faceVersion: '2.29.0' });
  assert.deepEqual(Object.keys(m.parts), ['wheelhouse:one-1.0-py3-none-any.whl']);
  assert.deepEqual(await verifyManifest(payload, m), { ok: true, mismatches: [] });
});

test('multi-file part with two files is keyed name:basename per file', async () => {
  const payload = path.join(tmp, 'payload-many-two'); fs.mkdirSync(path.join(payload, 'tools/wheelhouse'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'tools/wheelhouse/one-1.0-py3-none-any.whl'), 'wheel-one');
  fs.writeFileSync(path.join(payload, 'tools/wheelhouse/two-2.0-py3-none-any.whl'), 'wheel-two');
  const lock = { package: { version: '2.0.0' }, parts: { wheelhouse: { version: '1', file: 'tools/wheelhouse/' } } };
  const m = await buildManifest({ payloadDir: payload, lock, faceVersion: '2.29.0' });
  assert.deepEqual(
    new Set(Object.keys(m.parts)),
    new Set(['wheelhouse:one-1.0-py3-none-any.whl', 'wheelhouse:two-2.0-py3-none-any.whl']),
  );
  assert.deepEqual(await verifyManifest(payload, m), { ok: true, mismatches: [] });
});

// ---------------------------------------------------------------------------
// lock.json -- schema 2 (docs/lock-schema.md is the prose version of this)
// ---------------------------------------------------------------------------

const lock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8'));
const parts = Object.entries(lock.parts);
const KINDS = new Set(['url', 'npm-prefix', 'claude-release', 'git', 'wheelhouse', 'dir', 'file']);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

test('lock v2: schema 2, package.version 2.x, no guideVersion, no guides part', () => {
  assert.equal(lock.schema, 2);
  // 2.0.1(2026-09-16, VM S01 결함 수정)부터는 정확한 값 대신 2.x 만 고정한다 -- 패치 판마다
  // 이 줄을 고치는 것은 시험이 아니라 잡음이었다.
  assert.match(lock.package.version, /^2\.\d+\.\d+$/);
  assert.ok(!('guideVersion' in lock.package), 'package.guideVersion is a v1 field -- the setup guides left the zip (D2-03)');
  assert.ok(!('guides' in lock.parts), 'the guides part is a v1 part -- removed in v2');
  assert.ok(parts.length >= 30, `expected the v1 13 parts plus the bundled tools, got ${parts.length}`);
});

test('lock v2: every part declares kind, license, dest and file', () => {
  for (const [name, p] of parts) {
    assert.ok(KINDS.has(p.kind), `${name}: unknown kind ${JSON.stringify(p.kind)}`);
    assert.equal(typeof p.license, 'string', `${name}: license missing`);
    assert.ok(p.license.length > 0, `${name}: license empty`);
    assert.equal(typeof p.dest, 'string', `${name}: dest missing`);
    assert.ok(p.dest.length > 0, `${name}: dest empty`);
    assert.ok(!p.dest.includes('\\'), `${name}: dest must use POSIX separators, got ${p.dest}`);
    assert.ok(p.dest === '/' || !p.dest.startsWith('/'), `${name}: dest is relative to the soul root ("/" means the root itself), got ${p.dest}`);
    assert.equal(typeof p.file, 'string', `${name}: file (payload path) missing`);
    assert.ok(!p.file.startsWith('/') && !p.file.includes('\\'), `${name}: file must be a POSIX payload-relative path, got ${p.file}`);
  }
});

test('lock v2: each kind carries the fields that pin it', () => {
  const need = (name, p, fields) => {
    for (const f of fields) assert.ok(p[f] !== undefined && p[f] !== '', `${name} (${p.kind}): ${f} missing`);
  };
  for (const [name, p] of parts) {
    if (p.kind === 'url') {
      need(name, p, ['version', 'url', 'sha256', 'sha256Source']);
      assert.match(p.sha256, HEX64, `${name}: sha256 must be 64 hex chars`);
      assert.ok(p.url.startsWith('https://'), `${name}: url must be https`);
    } else if (p.kind === 'npm-prefix') {
      need(name, p, ['npm', 'version', 'integrity']);
      assert.match(p.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${name}: integrity must be an npm sha512- value`);
    } else if (p.kind === 'claude-release') {
      need(name, p, ['version', 'url', 'manifestUrl', 'sha256', 'sha256Source', 'fallback']);
      assert.match(p.sha256, HEX64, `${name}: sha256 must be 64 hex chars`);
      assert.equal(p.redistribute, 'download', `${name}: Claude Code may not be bundled (license)`);
      need(`${name}.fallback`, p.fallback, ['npm', 'version', 'integrity']);
      assert.equal(p.fallback.version, p.version, `${name}: both sources must serve the same version`);
    } else if (p.kind === 'git') {
      need(name, p, ['repo', 'commit', 'pinnedAt']);
      assert.match(p.commit, HEX40, `${name}: commit must be a full 40-char sha`);
      assert.match(p.pinnedAt, /^\d{4}-\d{2}-\d{2}$/, `${name}: pinnedAt must be an ISO date`);
      assert.ok(p.repo.startsWith('https://') && p.repo.endsWith('.git'), `${name}: repo must be an https clone URL`);
      assert.ok(!(p.subdir && p.include), `${name}: use subdir or include, not both`);
    } else if (p.kind === 'wheelhouse') {
      need(name, p, ['requirementsLock', 'sha256', 'pythonTag', 'platform', 'expectedCount']);
      assert.match(p.sha256, HEX64, `${name}: sha256 must be 64 hex chars`);
      assert.equal(typeof p.expectedCount, 'number', `${name}: expectedCount must be a number`);
      assert.ok(p.file.endsWith('/'), `${name}: a wheelhouse is many files -- file must end in "/"`);
    } else if (p.kind === 'dir' || p.kind === 'file') {
      need(name, p, ['source']);
      assert.ok(!(p.include && p.exclude), `${name}: use include or exclude, not both`);
    }
  }
});

test('lock v2: no moving reference anywhere (latest / main / HEAD / *)', () => {
  const moving = new Set(['latest', 'main', 'master', 'head', '*', 'next', 'stable']);
  const hits = [];
  const walk = (node, trail) => {
    if (typeof node === 'string') {
      if (moving.has(node.trim().toLowerCase())) hits.push(`${trail} = ${node}`);
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${trail}[${i}]`)); return; }
    if (node && typeof node === 'object') { for (const [k, v] of Object.entries(node)) walk(v, `${trail}.${k}`); }
  };
  walk(lock.parts, 'parts');
  assert.deepEqual(hits, [], 'a part is pinned to a moving reference');
});

test('lock v2: no npm version range, every version is exact', () => {
  for (const [name, p] of parts) {
    for (const v of [p.version, p.fallback?.version]) {
      if (v === undefined) continue;
      assert.equal(typeof v, 'string', `${name}: version must be a string`);
      assert.ok(!/[\^~*x]|\s|latest/i.test(v), `${name}: version ${v} is not an exact pin`);
    }
  }
});

test('lock v2: every part is pinned by exactly the evidence its kind uses', () => {
  const pin = {
    url: (p) => p.sha256, 'claude-release': (p) => p.sha256, 'npm-prefix': (p) => p.integrity,
    git: (p) => p.commit, wheelhouse: (p) => p.sha256, dir: (p) => p.source, file: (p) => p.source,
  };
  for (const [name, p] of parts) {
    assert.ok(pin[p.kind](p), `${name}: unpinned -- every part needs a fingerprint, a commit or a local source`);
  }
});

test('lock v2: the wheelhouse requirements files exist and match their recorded digests', () => {
  const p = Object.values(lock.parts).find((x) => x.kind === 'wheelhouse');
  assert.ok(p, 'no wheelhouse part');
  const digest = (rel) => createHash('sha256').update(fs.readFileSync(path.join(ROOT_DIR, rel))).digest('hex');
  assert.equal(digest(p.requirementsLock), p.sha256, 'requirements.lock digest drifted from lock.json');
  if (p.requirementsIn) assert.equal(digest(p.requirementsIn), p.requirementsInSha256, 'requirements.in digest drifted from lock.json');
  const pkgs = fs.readFileSync(path.join(ROOT_DIR, p.requirementsLock), 'utf8').split('\n').filter((l) => /^[A-Za-z]/.test(l)).length;
  assert.equal(pkgs, p.expectedCount, `requirements.lock lists ${pkgs} packages, lock.json expects ${p.expectedCount}`);
});

test('lock v2: repo-relative dir/file sources exist in this checkout', () => {
  for (const [name, p] of parts) {
    if (p.kind !== 'dir' && p.kind !== 'file') continue;
    // Absolute sources point at this PC's live folders (dash, hooks, templates,
    // ontology) and at the sibling P02 checkout -- those are checked by
    // verify/static.mjs at build time, not here.
    if (path.isAbsolute(p.source) || p.source.startsWith('..')) continue;
    assert.ok(fs.existsSync(path.join(ROOT_DIR, p.source)), `${name}: source ${p.source} not found`);
  }
});

test('lock v2: the tools promised by 설계 3-2 are all in the lock', () => {
  const want = [
    'superpowers', 'self-improve', 'playwright-mcp', 'ui-ux-pro-max',
    'hwp-automation', 'excel-automation', 'ppt-automation', 'word-automation', 'pdf-automation',
    'document-mcp-wheelhouse', 'document-skills', 'frontend-design', 'insane-search',
    'hooks', 'hwpx-templates', 'gen-image', 'ontology', 'ontology-spec', 'folder-icon',
    'uv', 'age',
  ];
  const missing = want.filter((n) => !(n in lock.parts));
  assert.deepEqual(missing, [], 'bundled tool parts missing from lock.json');
});

test('lock v2: every part lands under the soul root in a known place', () => {
  const allowed = [/^_agent\/shared\/tools\//, /^_agent\/shared\/skills\//, /^_agent\/claude\//, /^_ontology$/, /^_document-templates$/, /^\/$/];
  for (const [name, p] of parts) {
    assert.ok(allowed.some((re) => re.test(p.dest)), `${name}: dest ${p.dest} is outside the places v2 installs into`);
  }
});
