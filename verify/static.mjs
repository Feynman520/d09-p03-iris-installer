import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyManifest } from '../lib/manifest.mjs';
import { extractZip } from '../lib/zip.mjs';
import { sanitize } from '../build/sanitize.mjs';
import { loadRules, splitRepoStackPointers } from '../build/rules.mjs';
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
function extractRootBlock(raw) {
  // Line endings are a checkout artefact (P02 is checked out with
  // core.autocrlf=true, so its working copy is CRLF while the index is LF);
  // the comparison is about the tokens, so normalise before comparing.
  const css = raw.replace(/\r\n/g, '\n');
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
      // A part that stages a whole FOLDER (lock `file` ends with '/', e.g. the
      // wheelhouse; v1's `kind: glob` was the same idea) fans out into
      // "<name>:<basename>" manifest keys, so the test is "at least N of
      // them", not "a key called <name>". schema 2 states the expected number
      // as `expectedCount` (v1 called it `minCount`).
      const isMulti = p.kind === 'glob' || String(p.file ?? '').endsWith('/');
      if (isMulti) {
        const matchCount = manifestKeys.filter((k) => k.startsWith(`${name}:`)).length;
        const minCount = typeof p.expectedCount === 'number' ? p.expectedCount
          : typeof p.minCount === 'number' ? p.minCount : 1;
        if (matchCount < minCount) missing.push(`${name} (${matchCount} < expected ${minCount})`);
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
    //
    // The repo's own root .stack/.supa deploy-stack pointers are listed as
    // allowed exceptions rather than failures -- see build/rules.mjs
    // splitRepoStackPointers() for why, and note that check ② above (the
    // shipped zip) gets no such exception.
    const repoScan = await sanitize(ROOT_DIR, rules, { files: trackedFiles });
    const repoSplit = splitRepoStackPointers(repoScan.hits);
    const allowedNote = repoSplit.allowed.length
      ? `; allowed repo-root stack pointer(s): ${repoSplit.allowed.map((h) => h.file).join(', ')}`
      : '';
    record(
      '⑦ repo self-scan (git ls-files)',
      repoSplit.rest.length === 0,
      repoSplit.rest.length === 0
        ? `0 hits across ${trackedFiles.length} tracked file(s)${allowedNote}`
        : `${JSON.stringify(repoSplit.rest)}${allowedNote}`,
    );

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
        // Same repo-root .stack/.supa exception as ⑦: those commits are the
        // repository's own history, not a shipped artefact.
        const histResult = await sanitize(histTreeDir, rules);
        const histRest = splitRepoStackPointers(histResult.hits).rest;
        if (histRest.length > 0) badHistoryCommits.push({ sha, hits: histRest });
      } finally {
        fs.rmSync(histTmpDir, { recursive: true, force: true });
      }
    }
    record('⑧ git history scan (all refs, all commits)', badHistoryCommits.length === 0, badHistoryCommits.length === 0 ? `0 hits across ${historyShas.length} commit(s)` : JSON.stringify(badHistoryCommits));

    // ⑨ (C1/C2) the packed installer actually runs. Also proves lib/ and
    // lock.json are inside the zip: without them this server dies on import
    // (ERR_MODULE_NOT_FOUND) or answers 500 payload_unreadable later.
    // net.mjs (2026-09-15, Task 9): the network-0 choke point
    // installer/lib/{install,online,precheck}.mjs import as assertOnline/
    // isOffline -- build/pack.mjs's LIB_FILES omitted it once already
    // (masked by a stale zip until this check ran fresh), so it is checked
    // here explicitly alongside run.mjs/zip.mjs, not folded silently into
    // packedLibOk's message.
    const packedLibOk = fs.existsSync(path.join(tmpDir, 'lib', 'run.mjs')) && fs.existsSync(path.join(tmpDir, 'lib', 'zip.mjs'));
    const packedNetOk = fs.existsSync(path.join(tmpDir, 'lib', 'net.mjs'));
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
      smoke.ok && packedLibOk && packedNetOk && packedLockOk,
      `${smoke.detail}; zip lib/={run,zip,net}.mjs ${packedLibOk && packedNetOk ? 'present' : 'MISSING'}, zip lock.json ${packedLockOk ? 'present' : 'MISSING'}`,
    );

    // ⑩ (T09) payload tree shape -- exactly the 9 v2 top-level folders
    // (runtime/agents/relay/face/dash/tools/setup/policy/updater), and the
    // retired v1 `guides` folder must be absent. This is the shape
    // build/pack.mjs's addRepoPayloadSources()/collect() produce; the check
    // just asserts the shipped zip actually has it.
    const REQUIRED_PAYLOAD_FOLDERS = ['runtime', 'agents', 'relay', 'face', 'dash', 'tools', 'setup', 'policy', 'updater'];
    {
      const present = fs.readdirSync(payloadDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      const missingFolders = REQUIRED_PAYLOAD_FOLDERS.filter((f) => !present.includes(f));
      const hasGuides = present.includes('guides');
      const ok = missingFolders.length === 0 && !hasGuides;
      record(
        '⑩ payload tree = 9 folders, guides absent',
        ok,
        ok
          ? `present: ${REQUIRED_PAYLOAD_FOLDERS.join(', ')}`
          : `${missingFolders.length ? `missing: ${missingFolders.join(', ')}; ` : ''}${hasGuides ? 'guides/ still present (v1 leftover)' : ''}`,
      );
    }

    // ⑪ payload/policy/root-AGENTS.md must stay short enough that a fresh
    // C:\IRIS root actually reads it (design cap: 260 lines).
    {
      const rootAgentsPath = path.join(payloadDir, 'policy', 'root-AGENTS.md');
      if (!fs.existsSync(rootAgentsPath)) {
        record('⑪ payload/policy/root-AGENTS.md <= 260 lines', false, `not found: ${rootAgentsPath}`);
      } else {
        const lineCount = fs.readFileSync(rootAgentsPath, 'utf8').split(/\r\n|\r|\n/).length;
        const ok = lineCount <= 260;
        record('⑪ payload/policy/root-AGENTS.md <= 260 lines', ok, `${lineCount} line(s)`);
      }
    }

    // ⑫ personal-info count = 0 in the shipped payload -- a narrower re-read
    // of check ②'s own sanitizeResult (already computed above against the
    // whole zip, which is a superset of payload/) so this doesn't scan twice;
    // it exists as its own named check because the task calls it out
    // separately from "sanitize the whole zip".
    record(
      '⑫ personal-info count = 0 (payload)',
      sanitizeResult.ok,
      sanitizeResult.ok ? '0 hits' : `see ② for detail (${sanitizeResult.hits.length} hit(s))`,
    );

    // ⑬ hook .ps1 files are pure ASCII -- a BOM-less/non-ASCII PowerShell
    // script that ships as a hook can silently mis-decode on a stranger's PC
    // (R-004 is about BOM'd Korean .ps1; hooks avoid the whole class of bug by
    // being ASCII-only, so no BOM is needed and no codepage can mangle them).
    {
      const policyDir = path.join(payloadDir, 'policy');
      const ps1Files = [];
      const walkForPs1 = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walkForPs1(p);
          else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ps1')) ps1Files.push(p);
        }
      };
      walkForPs1(policyDir);
      const nonAscii = [];
      for (const p of ps1Files) {
        const buf = fs.readFileSync(p);
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] > 0x7f) { nonAscii.push(`${path.relative(payloadDir, p)} (byte 0x${buf[i].toString(16)} at offset ${i})`); break; }
        }
      }
      record(
        '⑬ hook .ps1 files are pure ASCII',
        ps1Files.length > 0 && nonAscii.length === 0,
        ps1Files.length === 0
          ? `no .ps1 files found under ${policyDir}`
          : nonAscii.length === 0
            ? `${ps1Files.length} .ps1 file(s), all ASCII`
            : `non-ASCII byte(s) in: ${nonAscii.join('; ')}`,
      );
    }

    // ⑭ payload/setup/presets.json matches schema -- exactly the 7 required
    // preset ids, in the shipped file (not just the repo source), since check
    // ⑩'s tree only proves the *folder* exists.
    {
      const REQUIRED_PRESET_IDS = ['teacher', 'researcher', 'business', 'developer', 'office-worker', 'student', 'writer'];
      const presetsPath = path.join(payloadDir, 'setup', 'presets.json');
      if (!fs.existsSync(presetsPath)) {
        record('⑭ payload/setup/presets.json schema (7 ids)', false, `not found: ${presetsPath}`);
      } else {
        let presetsJson;
        try {
          presetsJson = JSON.parse(fs.readFileSync(presetsPath, 'utf8'));
        } catch (err) {
          presetsJson = null;
          record('⑭ payload/setup/presets.json schema (7 ids)', false, `not valid JSON: ${err.message}`);
        }
        if (presetsJson) {
          const ids = Array.isArray(presetsJson.presets) ? presetsJson.presets.map((p) => p.id) : [];
          const missingIds = REQUIRED_PRESET_IDS.filter((id) => !ids.includes(id));
          const extraIds = ids.filter((id) => !REQUIRED_PRESET_IDS.includes(id));
          const ok = missingIds.length === 0 && extraIds.length === 0 && ids.length === REQUIRED_PRESET_IDS.length;
          record(
            '⑭ payload/setup/presets.json schema (7 ids)',
            ok,
            ok ? `ids: ${ids.join(', ')}` : `got: [${ids.join(', ')}], missing: [${missingIds.join(', ')}], extra: [${extraIds.join(', ')}]`,
          );
        }
      }
    }

    // ⑮ folder icon _cosmos.ico ships at payload/policy/_cosmos.ico.
    {
      const icoPath = path.join(payloadDir, 'policy', '_cosmos.ico');
      const ok = fs.existsSync(icoPath) && fs.statSync(icoPath).size > 0;
      record('⑮ _cosmos.ico present', ok, ok ? `${icoPath} (${fs.statSync(icoPath).size} bytes)` : `not found or empty: ${icoPath}`);
    }

    // ⑯ 설치가 안 되면.txt exists at the zip root with exactly one BOM (the
    // UTF-8 BOM at byte 0 -- build/pack.mjs copies it byte-exact from
    // payload-src/policy/install-notice.txt precisely to preserve this; a
    // second stray BOM anywhere else in the file would mean some tool
    // re-wrote/re-encoded it and corrupted the guarantee).
    {
      const NOTICE_NAME = '설치가 안 되면.txt';
      const noticePath = path.join(tmpDir, NOTICE_NAME);
      const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
      if (!fs.existsSync(noticePath)) {
        record('⑯ 설치가 안 되면.txt at zip root, exactly one BOM', false, `not found: ${noticePath}`);
      } else {
        const buf = fs.readFileSync(noticePath);
        let bomCount = 0;
        for (let i = 0; i + 3 <= buf.length; i++) {
          if (buf[i] === BOM[0] && buf[i + 1] === BOM[1] && buf[i + 2] === BOM[2]) bomCount++;
        }
        const startsWithBom = buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
        const ok = startsWithBom && bomCount === 1;
        record(
          '⑯ 설치가 안 되면.txt at zip root, exactly one BOM',
          ok,
          `${bomCount} BOM sequence(s) found, starts-with-BOM=${startsWithBom}`,
        );
      }
    }

    // ⑰ dev-only files must not ship: installer/ui/mock-server.mjs and any
    // *.test.* file must be absent from the extracted zip's installer/ tree
    // (build/pack.mjs's INSTALLER_EXCLUDE_RELS / TEST_FILE_RE are what make
    // this true -- this check proves it held for the zip actually built).
    {
      const installerDir = path.join(tmpDir, 'installer');
      const bad = [];
      const TEST_FILE_RE = /\.test\.[^.\\/]+$/i;
      const walkInstaller = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          const rel = path.relative(installerDir, p).split(path.sep).join('/');
          if (entry.isDirectory()) walkInstaller(p);
          else if (entry.isFile()) {
            if (rel === 'ui/mock-server.mjs' || TEST_FILE_RE.test(entry.name)) bad.push(rel);
          }
        }
      };
      if (fs.existsSync(installerDir)) walkInstaller(installerDir);
      record(
        '⑰ mock-server.mjs / *.test.* absent from shipped installer/',
        bad.length === 0,
        bad.length === 0 ? 'clean' : `found: ${bad.join(', ')}`,
      );
    }

    // ⑲ no zero-byte FILE anywhere in the zip (2026-09-18, home-desktop
    // update failure "inflate exceeded declared size: installer/ui/.gitkeep").
    // bsdtar deflates even an empty file (csize 2, usize 0) and the IRIS 창
    // updater (P02 daemon/zip.mjs) inflates with `maxOutputLength: usize`;
    // Node rejects maxOutputLength 0 with a RangeError, which the updater
    // reports as "exceeded declared size". One empty placeholder therefore
    // makes EVERY update of every installed PC fail. Until the P02 reader is
    // fixed (Math.max(1, usize)) the package must ship no empty file at all.
    {
      const empty = [];
      const walkAll = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walkAll(p);
          else if (entry.isFile() && fs.statSync(p).size === 0) empty.push(path.relative(tmpDir, p).split(path.sep).join('/'));
        }
      };
      walkAll(tmpDir);
      record(
        '⑲ no zero-byte file in the zip (IRIS 창 updater cannot inflate one)',
        empty.length === 0,
        empty.length === 0 ? 'clean' : `found: ${empty.join(', ')}`,
      );
    }

    // ⑱ manifest is schema:2 with every payload file fingerprinted (bytes +
    // sha256), per build/pack.mjs's buildPackManifest() -- manifest.json
    // itself is the one file exempt (it cannot fingerprint itself).
    {
      const allPayloadFiles = [];
      const walkPayload = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          const r = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walkPayload(p, r);
          else if (entry.isFile()) allPayloadFiles.push(r);
        }
      };
      walkPayload(payloadDir, '');
      const expectedFiles = allPayloadFiles.filter((f) => f !== 'manifest.json');
      const manifestFiles = manifest.files && typeof manifest.files === 'object' ? Object.keys(manifest.files) : [];
      const missingFromManifest = expectedFiles.filter((f) => !manifestFiles.includes(f));
      const malformed = expectedFiles.filter((f) => {
        const entry = manifest.files?.[f];
        return entry && (typeof entry.bytes !== 'number' || typeof entry.sha256 !== 'string' || entry.sha256.length !== 64);
      });
      const ok = manifest.schema === 2 && missingFromManifest.length === 0 && malformed.length === 0;
      record(
        '⑱ manifest schema:2, every payload file fingerprinted',
        ok,
        ok
          ? `schema:2, ${expectedFiles.length} file(s) fingerprinted`
          : `schema=${manifest.schema}, missing: [${missingFromManifest.join(', ')}], malformed: [${malformed.join(', ')}]`,
      );
    }
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
