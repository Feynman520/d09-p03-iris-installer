import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyManifest } from '../lib/manifest.mjs';
import { extractZip } from '../lib/zip.mjs';
import { sanitize } from '../build/sanitize.mjs';
import { loadRules } from '../build/rules.mjs';

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

    // ② sanitize the extracted payload once more (independent of build.mjs's
    // own pre-pack sanitize pass) -- this is what actually shipped.
    const rules = loadRules({ baseFile: path.join(ROOT_DIR, 'build', 'sanitize-rules.json'), localFile: path.join(ROOT_DIR, 'build', 'sanitize-local.json') });
    const sanitizeResult = await sanitize(payloadDir, rules);
    record('② sanitize (payload in zip)', sanitizeResult.ok, sanitizeResult.ok ? '0 hits' : JSON.stringify(sanitizeResult.hits));

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
    const uiIndexPath = path.join(ROOT_DIR, 'installer', 'ui', 'index.html');
    if (!fs.existsSync(uiIndexPath)) {
      console.log('④ skipped (installer UI not built yet)');
    } else {
      const faceSource = path.resolve(ROOT_DIR, lock.parts.face.source);
      const faceCss = fs.readFileSync(path.join(faceSource, 'app', 'style.css'), 'utf8');
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

    // ⑥ placeholder -- the shim-template cross-check (P02 wake() vs P03
    // shims.mjs) only becomes checkable once Task 17 writes both templates.
    console.log('⑥ skipped (shim template check arrives with Task 17)');

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
