// The release door for the two relay gates in tests/patch.test.mjs.
//
// Finding (code review, 2026-11-27): on a PC without the live relay install,
// the byte comparison AND the relay's own tests were skipped together, and
// `npm test` still exited 0 -- at the release door that reads as "passed".
//
// What this file pins, by running tests/patch.test.mjs as a child with the
// machine made to look different (never by touching the machine):
//   - "no live install"  = APPDATA pointed at an empty temp folder;
//   - "no npm registry"  = npm told to work offline from an empty cache.
//
//   1. no live install            -> the comparison is skipped, but the
//                                    relay's own tests STILL RUN and pass;
//   2. same, IRIS_RELEASE_GATE=1  -> the skipped comparison is a failure;
//   3. no live install, no registry                 -> both skipped, exit 0;
//   4. same, IRIS_RELEASE_GATE=1                    -> both fail, exit != 0.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-patch-gate-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const COMPARE = 'reproduces the live TeamClaude install byte-for-byte';
const OWN = "the relay's own tests pass on pristine + rules";

function runPatchTests({ gate, registry, only }) {
  const emptyAppData = path.join(tmp, `appdata-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(emptyAppData, { recursive: true });
  const env = { ...process.env, APPDATA: emptyAppData };
  delete env.NODE_TEST_CONTEXT; // the child decides its own exit code
  delete env.IRIS_RELEASE_GATE;
  if (gate) env.IRIS_RELEASE_GATE = '1';
  if (!registry) {
    const emptyCache = path.join(tmp, `npm-cache-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(emptyCache, { recursive: true });
    env.npm_config_offline = 'true';
    env.npm_config_cache = emptyCache;
  }
  const pattern = (only ?? [COMPARE, OWN]).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', `--test-name-pattern=${pattern}`, 'tests/patch.test.mjs'], {
    cwd: ROOT_DIR, env, encoding: 'utf8', timeout: 280_000, windowsHide: true,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // '✔' passed · '✖' failed · '﹣' skipped -- the first line that names the test
  const verdictOf = (name) => {
    const line = out.split('\n').find((l) => /^[✔✖﹣]/.test(l) && l.includes(name));
    return line ? { '✔': 'pass', '✖': 'fail', '﹣': 'skip' }[line[0]] : 'absent';
  };
  return { status: r.status, out, compare: verdictOf(COMPARE), own: verdictOf(OWN) };
}

test('no live install: the byte comparison is skipped, the relay still runs its own tests', { timeout: 300_000 }, (t) => {
  const r = runPatchTests({ gate: false, registry: true });
  assert.equal(r.compare, 'skip', r.out.slice(-2000));
  if (r.own === 'skip' && /could not be fetched from the npm registry/.test(r.out)) {
    // This machine really has no registry right now; scenario 3 below covers that case.
    t.diagnostic('npm registry unreachable from this machine -- the "still runs" half could not be shown here');
    assert.equal(r.status, 0);
    return;
  }
  assert.equal(r.own, 'pass', `the relay's own tests must not depend on the live install:\n${r.out.slice(-3000)}`);
  assert.match(r.out, /relay tests: \d+ passed across \d+ file\(s\)/);
  assert.equal(r.status, 0, r.out.slice(-2000));
});

test('no live install + IRIS_RELEASE_GATE=1: the skipped comparison is a failure', { timeout: 120_000 }, () => {
  const r = runPatchTests({ gate: true, registry: true, only: [COMPARE] });
  assert.equal(r.compare, 'fail', r.out.slice(-2000));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /IRIS_RELEASE_GATE=1: this check may not be skipped at release/);
  assert.match(r.out, /live TeamClaude install not found/);
});

test('no live install and no registry: both are skipped and an ordinary run still exits 0', { timeout: 120_000 }, () => {
  const r = runPatchTests({ gate: false, registry: false });
  assert.equal(r.compare, 'skip', r.out.slice(-2000));
  assert.equal(r.own, 'skip', r.out.slice(-2000));
  assert.match(r.out, /could not be fetched from the npm registry/);
  assert.equal(r.status, 0, r.out.slice(-2000));
});

test('no live install and no registry + IRIS_RELEASE_GATE=1: both fail and the run exits non-zero', { timeout: 120_000 }, () => {
  const r = runPatchTests({ gate: true, registry: false });
  assert.equal(r.compare, 'fail', r.out.slice(-2000));
  assert.equal(r.own, 'fail', r.out.slice(-2000));
  assert.notEqual(r.status, 0);
  assert.equal((r.out.match(/IRIS_RELEASE_GATE=1: this check may not be skipped at release/g) ?? []).length >= 2, true, r.out.slice(-3000));
});
