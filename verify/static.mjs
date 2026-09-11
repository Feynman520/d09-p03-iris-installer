import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyManifest } from '../lib/manifest.mjs';
import { extractZip } from '../lib/zip.mjs';
import { sanitize } from '../build/sanitize.mjs';

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
  const stageDir = path.resolve(ROOT_DIR, opts.stage);

  const results = [];
  let failed = false;
  const record = (label, ok, detail) => {
    results.push({ label, ok, detail });
    if (ok === false) failed = true;
  };

  const zipPath = findNewestZip(outDir);
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
    const rules = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'build', 'sanitize-rules.json'), 'utf8'));
    const sanitizeResult = await sanitize(payloadDir, rules);
    record('② sanitize (payload in zip)', sanitizeResult.ok, sanitizeResult.ok ? '0 hits' : JSON.stringify(sanitizeResult.hits));

    // ③ every lock part except redistribute:'download' ones is present in
    // the manifest. Glob parts (e.g. guides) fan out into "name:basename"
    // manifest keys, so it's enough that at least one such key exists.
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8'));
    const manifestKeys = Object.keys(manifest.parts);
    const missing = [];
    for (const [name, p] of Object.entries(lock.parts)) {
      if (p.redistribute === 'download') continue;
      const present = p.kind === 'glob'
        ? manifestKeys.some((k) => k.startsWith(`${name}:`))
        : manifestKeys.includes(name);
      if (!present) missing.push(name);
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

    // ⑤ node-pty's native binding must exist somewhere in the *staged*
    // face work folder (per the controller's build-vs-prebuilds ruling) --
    // checked against the stage dir directly, not by re-extracting the
    // face part's zip from inside the outer zip.
    const facePtyDir = path.join(stageDir, 'dir', 'face', 'node_modules', 'node-pty');
    const prebuiltPath = path.join(facePtyDir, 'prebuilds', 'win32-x64', 'pty.node');
    const builtPath = path.join(facePtyDir, 'build', 'Release', 'pty.node');
    const ptyOk = fs.existsSync(prebuiltPath) || fs.existsSync(builtPath);
    const ptyDetail = fs.existsSync(prebuiltPath)
      ? prebuiltPath
      : fs.existsSync(builtPath)
        ? builtPath
        : `neither ${prebuiltPath} nor ${builtPath} exists`;
    record('⑤ node-pty native binary staged', ptyOk, ptyDetail);

    // ⑥ placeholder -- the shim-template cross-check (P02 wake() vs P03
    // shims.mjs) only becomes checkable once Task 17 writes both templates.
    console.log('⑥ skipped (shim template check arrives with Task 17)');
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
