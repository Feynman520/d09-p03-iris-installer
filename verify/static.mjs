import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyManifest } from '../lib/manifest.mjs';
import { extractZip } from '../lib/zip.mjs';
import { sanitize } from '../build/sanitize.mjs';
import { loadRules } from '../build/rules.mjs';
import { agentShim } from '../installer/lib/shims.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { out: '_build/out', stage: '_build/stage' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--stage') opts.stage = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return opts;
}

function findNewestZip(outDir) {
  const entries = fs.readdirSync(outDir).filter((f) => f.endsWith('.zip'));
  if (entries.length === 0) throw new Error(`no .zip found under ${outDir}`);
  let newest = null;
  let newestMtime = -Infinity;
  for (const f of entries) {
    const p = path.join(outDir, f);
    const mtime = fs.statSync(p).mtimeMs;
    if (mtime > newestMtime) { newestMtime = mtime; newest = p; }
  }
  return newest;
}

// Extract the ":root { ... }" custom-property block from a CSS source,
// matching braces so a block containing nested braces (none expected here,
// but this stays correct if one is ever added) is still captured whole.
// Returns null if no ":root" selector is found.
function extractRootBlock(css) {
  const idx = css.indexOf(':root');
  if (idx === -1) return null;
  const braceStart = css.indexOf('{', idx);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(idx, i + 1);
    }
  }
  return null;
}

// (I5) Where a `dir`-kind part's source lives. lock.json is the default, but
// lock.parts.dash.source is an absolute path to this development PC's own
// dashboard folder, so any other machine (a fresh clone, a second checkout)
// needs a way to say where its copy is without editing a tracked file. The
// env var wins when set; it is the same name build/collect.mjs honours.
export function sourceEnvVar(name) {
  return `IRIS_${name.toUpperCase()}_SOURCE`;
}

export function partSource(lock, name) {
  const override = process.env[sourceEnvVar(name)];
  const value = override || lock?.parts?.[name]?.source;
  return value ? path.resolve(ROOT_DIR, value) : '';
}

// ⑨ (2026-09-12 final review C1/C2) Smoke-start the server that actually
// shipped, out of the extracted zip, and prove it answers /api/health with
// the iris-installer contract. This is the check that would have caught the
// missing lib/ + lock.json: every earlier rehearsal ran server.mjs from the
// repo checkout, where `../../lib/run.mjs` and `../lock.json` resolve by
// accident.
//
// Rules this deliberately obeys:
//   - port 0 -> the OS picks a free port (never 3456/3458/3459/3460/3466);
//     the child prints the real one, which is what we then talk to;
//   - LOCALAPPDATA is redirected into a scratch dir, so the child's
//     state.json / bootstrap work dir never touch this PC's real
//     %LOCALAPPDATA%\IRIS-Installer;
//   - only the child THIS function spawned is ever waited on or signalled.
function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

async function smokePackedServer(zipRootDir, scratchDir) {
  const serverPath = path.join(zipRootDir, 'installer', 'server.mjs');
  if (!fs.existsSync(serverPath)) return { ok: false, detail: `zip has no installer/server.mjs (${serverPath})` };

  const appData = path.join(scratchDir, 'localappdata');
  fs.mkdirSync(appData, { recursive: true });

  const child = spawn(process.execPath, [serverPath, '--zip-root', zipRootDir, '--port', '0'], {
    cwd: zipRootDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOCALAPPDATA: appData },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  const fail = async (detail) => {
    try { child.kill(); } catch { /* already gone */ }
    await waitForExit(child, 3000);
    return { ok: false, detail: `${detail}${err.trim() ? ` | stderr: ${err.trim().slice(0, 800)}` : ''}` };
  };

  // Wait for the "listening on 127.0.0.1:<port>" line (or an early death).
  const deadline = Date.now() + 30000;
  let port = null;
  while (Date.now() < deadline) {
    const m = /listening on 127\.0\.0\.1:(\d+)/.exec(out);
    if (m) { port = Number(m[1]); break; }
    if (child.exitCode !== null) {
      return { ok: false, detail: `server exited early with code ${child.exitCode} | stderr: ${err.trim().slice(0, 800)}` };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!port) return fail('server never printed its listening port within 30s');

  // Poll /api/health until it answers the iris-installer contract.
  let health = null;
  const healthDeadline = Date.now() + 20000;
  while (Date.now() < healthDeadline && health === null) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) health = await res.json();
    } catch { /* not up yet */ }
    if (health === null) await new Promise((r) => setTimeout(r, 200));
  }
  if (health === null) return fail(`/api/health never answered on 127.0.0.1:${port}`);
  if (health.name !== 'iris-installer') return fail(`/api/health answered without name:"iris-installer" (${JSON.stringify(health)})`);

  // Shut it down the way the UI does, then wait for OUR child to exit.
  try {
    await fetch(`http://127.0.0.1:${port}/api/quit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch { /* the server may close the socket as it exits */ }
  const exited = await waitForExit(child, 15000);
  if (!exited) return fail('server did not exit after POST /api/quit');

  return {
    ok: true,
    detail: `packed server started on 127.0.0.1:${port}, /api/health name=iris-installer version=${health.version}, quit cleanly`,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(ROOT_DIR, opts.out);
  // --stage is accepted but no longer used directly: check (5) now verifies
  // node-pty inside the shipped zip's inner face/iris-face.zip (I4), not the
  // stage dir. Kept as a no-op flag so any existing `--stage` callers don't
  // break on "unknown arg".
  void opts.stage;

  const results = [];
  let failed = false;
  const record = (label, ok, detail) => {
    results.push({ label, ok, detail });
    if (ok === false) failed = true;
  };

  // (I4) Verify the zip that build.mjs *just* built, not just whatever
  // happens to be newest in outDir (a stale leftover from a previous run, or
  // a race with a concurrent build, could otherwise fool findNewestZip).
  const lastBuildPath = path.join(outDir, 'last-build.json');
  let zipPath;
  if (fs.existsSync(lastBuildPath)) {
    const lastBuild = JSON.parse(fs.readFileSync(lastBuildPath, 'utf8'));
    zipPath = lastBuild.zip;
    if (!fs.existsSync(zipPath)) {
      console.log(`warn: last-build.json points at a missing zip (${zipPath}); falling back to newest zip in ${outDir}`);
      zipPath = findNewestZip(outDir);
    }
  } else {
    console.log(`warn: no last-build.json in ${outDir}; falling back to newest zip (verifying it may not be the zip you just built)`);
    zipPath = findNewestZip(outDir);
  }
  console.log(`checking: ${zipPath}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-verify-static-'));
  try {
    await extractZip(zipPath, tmpDir);
    const payloadDir = path.join(tmpDir, 'payload');
    const manifestPath = path.join(payloadDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // ① manifest hashes match the files actually inside the zip.
    const mv = await verifyManifest(payloadDir, manifest);
    record('① manifest verify', mv.ok, mv.ok ? `${Object.keys(manifest.parts).length} part(s) match` : JSON.stringify(mv.mismatches));

    // ② sanitize the WHOLE extracted zip (I1) -- not just payload/. The
    // build's own pre-pack pass only ever sees the staged payload, so
    // installer code, ui/index.html, bootstrap.ps1, the packed
    // patches/rules.json, lib/ and lock.json used to ship without any
    // personal-string gate at all. This is what actually shipped, all of it.
    const rules = loadRules({ baseFile: path.join(ROOT_DIR, 'build', 'sanitize-rules.json'), localFile: path.join(ROOT_DIR, 'build', 'sanitize-local.json') });
    const sanitizeResult = await sanitize(tmpDir, rules);
    record('② sanitize (whole zip root)', sanitizeResult.ok, sanitizeResult.ok ? '0 hits' : JSON.stringify(sanitizeResult.hits));

    // ③ every lock part except redistribute:'download' ones is present in
    // the manifest. Glob parts (e.g. guides) fan out into "name:basename"
    // manifest keys, so it's enough that at least one such key exists -- and
    // (I6) if the part declares a minCount, at least that many keys exist.
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8'));
    const manifestKeys = Object.keys(manifest.parts);
    const missing = [];
    for (const [name, p] of Object.entries(lock.parts)) {
      if (p.redistribute === 'download') continue;
      if (p.kind === 'glob') {
        const matchCount = manifestKeys.filter((k) => k.startsWith(`${name}:`)).length;
        const minCount = typeof p.minCount === 'number' ? p.minCount : 1;
        if (matchCount < minCount) missing.push(`${name} (${matchCount} < minCount ${minCount})`);
      } else if (!manifestKeys.includes(name)) {
        missing.push(name);
      }
    }
    record('③ lock parts present in manifest', missing.length === 0, missing.length === 0 ? 'all present' : `missing: ${missing.join(', ')}`);

    // ④ Face app/style.css :root{...} block must be byte-identical to the
    // same block in installer/ui/index.html -- but the installer UI doesn't
    // exist until Task 14, so this check is a no-op (not a failure) until
    // then.
    //
    // (I5) A missing sibling source must be REPORTED, never thrown: an
    // unhandled throw here aborted the whole run and silently skipped checks
    // ⑤-⑨. Both sibling-reading checks (④ and ⑥) resolve their source the
    // same way -- lock value, overridable by env (see partSource below).
    const uiIndexPath = path.join(ROOT_DIR, 'installer', 'ui', 'index.html');
    const faceSource = partSource(lock, 'face');
    const faceCssPath = path.join(faceSource, 'app', 'style.css');
    if (!fs.existsSync(uiIndexPath)) {
      console.log('④ skipped (installer UI not built yet)');
    } else if (!fs.existsSync(faceCssPath)) {
      record(
        '④ style.css :root == installer/ui/index.html :root', false,
        `P02 source not found: ${faceCssPath} does not exist `
        + `(lock.parts.face.source=${lock.parts.face.source}; override with ${sourceEnvVar('face')})`,
      );
    } else {
      const faceCss = fs.readFileSync(faceCssPath, 'utf8');
      const uiHtml = fs.readFileSync(uiIndexPath, 'utf8');
      const faceRoot = extractRootBlock(faceCss);
      const uiRoot = extractRootBlock(uiHtml);
      const ok = faceRoot !== null && faceRoot === uiRoot;
      record('④ style.css :root == installer/ui/index.html :root', ok, ok ? 'identical' : 'blocks differ or missing');
    }

    // ⑤ node-pty's native binding must exist inside the zip that was
    // actually built (I4) -- extract just the inner face/iris-face.zip
    // (nested inside the outer installer zip already extracted to tmpDir)
    // to a fresh temp dir and check there, rather than trusting the stage
    // dir (which reflects whatever the *last* collect() run happened to
    // leave behind, not necessarily what got packed into this zip).
    const faceZipPath = path.join(payloadDir, 'face', 'iris-face.zip');
    let ptyOk = false;
    let ptyDetail = `face zip not found: ${faceZipPath}`;
    if (fs.existsSync(faceZipPath)) {
      const faceTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-verify-face-'));
      try {
        await extractZip(faceZipPath, faceTmpDir);
        const facePtyDir = path.join(faceTmpDir, 'node_modules', 'node-pty');
        const prebuiltPath = path.join(facePtyDir, 'prebuilds', 'win32-x64', 'pty.node');
        const builtPath = path.join(facePtyDir, 'build', 'Release', 'pty.node');
        ptyOk = fs.existsSync(prebuiltPath) || fs.existsSync(builtPath);
        ptyDetail = fs.existsSync(prebuiltPath)
          ? prebuiltPath
          : fs.existsSync(builtPath)
            ? builtPath
            : `neither ${prebuiltPath} nor ${builtPath} exists (inside ${faceZipPath})`;
      } finally {
        fs.rmSync(faceTmpDir, { recursive: true, force: true });
      }
    }
    record('⑤ node-pty native binary in shipped zip', ptyOk, ptyDetail);

    // ⑥ shim template parity -- P02 daemon/wake.mjs re-implements P03
    // installer/lib/shims.mjs's agentShim() byte-for-byte (it cannot import
    // it: P02/P03 are separate deployed units -- see wake.mjs's header
    // comment). Resolve P02's location the same way check ④ and collect.mjs
    // do: lock.parts.face.source, resolved against ROOT_DIR.
    {
      const wakePath = path.join(faceSource, 'daemon', 'wake.mjs');
      if (!fs.existsSync(wakePath)) {
        record(
          '⑥ shim template parity (P02 wake() vs P03 shims.mjs)', false,
          `P02 not found: ${wakePath} does not exist (override with ${sourceEnvVar('face')})`,
        );
      } else {
        const { agentShimText } = await import(pathToFileURL(wakePath).href);
        const mismatches = [];
        for (const agent of ['claude', 'codex']) {
          const a = agentShim(agent);
          const b = agentShimText(agent);
          if (a !== b) mismatches.push(agent);
        }
        record(
          '⑥ shim template parity (P02 wake() vs P03 shims.mjs)',
          mismatches.length === 0,
          mismatches.length === 0 ? 'claude + codex identical' : `differ for: ${mismatches.join(', ')}`,
        );
      }
    }

    // ⑦ (C2) the gate must also scan the repo's own tracked files -- not
    // just build output -- so personal strings committed into a tracked
    // file (docs, lock.json, patches, etc.) are caught even though they
    // never flow through collect()/payloadDir. Scans exactly `git
    // ls-files` (the repo's tracked set), matching tests/repo-clean.test.mjs.
    // `-z` (NUL-separated, encoding 'buffer' + manual utf8 decode) is required
    // -- git's default `ls-files` output quote-escapes non-ASCII filenames
    // (e.g. every Korean docs/*.md path becomes a literal
    // "docs/\352\262\200..." string), which would silently make this scan
    // skip every Korean-named tracked file (2026-09-11 Fix round 1 fix).
    const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT_DIR, encoding: 'buffer' })
      .toString('utf8')
      .split('\0')
      .map((s) => s.trim())
      .filter(Boolean);
    const repoScan = await sanitize(ROOT_DIR, rules, { files: trackedFiles });
    record('⑦ repo self-scan (git ls-files)', repoScan.ok, repoScan.ok ? `0 hits across ${trackedFiles.length} tracked file(s)` : JSON.stringify(repoScan.hits));

    // ⑧ (C1, 2026-09-11 Fix round 2) git history scan -- check ⑦ only ever
    // scanned the current checkout, so a personal string that was scrubbed
    // from HEAD but still survives in an *ancestor* commit's blob content
    // would ship in git history to a public GitHub push (Task 20) without
    // tripping any check. Walk every commit reachable from any ref and
    // require 0 hits in each one's full tree, mirroring
    // tests/history-clean.test.mjs (same materialize-via-extractZip +
    // sanitize approach; see that file's header comment for why raw `tar`
    // is not used directly).
    const historyShas = execFileSync('git', ['rev-list', '--all'], { cwd: ROOT_DIR, encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const badHistoryCommits = [];
    for (const sha of historyShas) {
      const histTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-verify-history-'));
      try {
        const histZipPath = path.join(histTmpDir, 'commit.zip');
        execFileSync('git', ['archive', '--format=zip', '-o', histZipPath, sha], { cwd: ROOT_DIR });
        const histTreeDir = path.join(histTmpDir, 'tree');
        await extractZip(histZipPath, histTreeDir);
        if (fs.readdirSync(histTreeDir).length === 0) {
          badHistoryCommits.push({ sha, error: 'extraction produced 0 files -- materialization failed' });
          continue;
        }
        const histResult = await sanitize(histTreeDir, rules);
        if (!histResult.ok) badHistoryCommits.push({ sha, hits: histResult.hits });
      } finally {
        fs.rmSync(histTmpDir, { recursive: true, force: true });
      }
    }
    record('⑧ git history scan (all refs, all commits)', badHistoryCommits.length === 0, badHistoryCommits.length === 0 ? `0 hits across ${historyShas.length} commit(s)` : JSON.stringify(badHistoryCommits));

    // ⑨ (C1/C2) the packed installer actually runs. Also proves lib/ and
    // lock.json are inside the zip: without them this server dies on import
    // (ERR_MODULE_NOT_FOUND) or answers 500 payload_unreadable later.
    const packedLibOk = fs.existsSync(path.join(tmpDir, 'lib', 'run.mjs')) && fs.existsSync(path.join(tmpDir, 'lib', 'zip.mjs'));
    const packedLockOk = fs.existsSync(path.join(tmpDir, 'lock.json'));
    const smokeScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-verify-smoke-'));
    let smoke;
    try {
      smoke = await smokePackedServer(tmpDir, smokeScratch);
    } finally {
      fs.rmSync(smokeScratch, { recursive: true, force: true });
    }
    record(
      '⑨ packed server smoke (/api/health from the extracted zip)',
      smoke.ok && packedLibOk && packedLockOk,
      `${smoke.detail}; zip lib/={run,zip}.mjs ${packedLibOk ? 'present' : 'MISSING'}, zip lock.json ${packedLockOk ? 'present' : 'MISSING'}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('');
  for (const r of results) {
    console.log(`${r.label}: ${r.ok ? 'OK' : 'FAIL'} - ${r.detail}`);
  }

  if (failed) {
    console.log('\nstatic verify: FAILED');
    process.exit(1);
  }
  console.log('\nstatic verify: OK');
}

main();
