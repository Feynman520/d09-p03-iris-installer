import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from './collect.mjs';
import { sanitize } from './sanitize.mjs';
import { loadRules } from './rules.mjs';
import { buildManifest } from '../lib/manifest.mjs';
import { pack } from './pack.mjs';

// Project root (one level up from build/), independent of process.cwd() --
// same convention as collect.mjs/pack.mjs's ROOT_DIR. All default
// directories (--out/--cache/--stage) and the build log resolve against
// this, not the caller's cwd, so `node build/build.mjs` behaves the same
// whether invoked from the repo root or elsewhere.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  out: '_build/out',
  cache: '_build/cache',
  stage: '_build/stage',
};

function parseArgs(argv) {
  const opts = {
    out: DEFAULTS.out, cache: DEFAULTS.cache, stage: DEFAULTS.stage, skipDownload: false,
    // I7: release builds must fail rather than silently scan with the
    // generic base rules only. Env form exists so a CI/release script can
    // enforce it without editing every call site.
    requireLocal: process.env.IRIS_BUILD_REQUIRE_LOCAL === '1',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--cache') opts.cache = argv[++i];
    else if (a === '--stage') opts.stage = argv[++i];
    else if (a === '--skip-download') opts.skipDownload = true;
    else if (a === '--require-local') opts.requireLocal = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return opts;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v.toFixed(2)} ${units[u]}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(ROOT_DIR, opts.out);
  const cacheDir = path.resolve(ROOT_DIR, opts.cache);
  const stageDir = path.resolve(ROOT_DIR, opts.stage);

  const logDir = path.join(ROOT_DIR, '_build');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'build.log');
  // fs.appendFileSync (not a buffered fs.createWriteStream) so that every
  // log() call is flushed to disk immediately -- a process.exit(2) (the
  // sanitize-failure path below) does not give a stream's internal buffer a
  // chance to drain, which previously risked losing exactly the hit-list
  // lines that matter most for diagnosing why a build was aborted.
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(msg);
    fs.appendFileSync(logPath, `${line}\n`);
  };

  log(`build start out=${outDir} cache=${cacheDir} stage=${stageDir} skipDownload=${opts.skipDownload} requireLocal=${opts.requireLocal}`);
  const startedAt = Date.now();

  try {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8'));

    log('collect: start');
    const { payloadDir, faceVersion, skipped } = await collect({
      lock,
      cacheDir,
      stageDir,
      log,
      skipDownload: opts.skipDownload,
    });
    log(`collect: done (skipped=${skipped.join(',') || 'none'})`);

    log('sanitize: start (payload dir only)');
    const rules = loadRules({
      baseFile: path.join(ROOT_DIR, 'build', 'sanitize-rules.json'),
      localFile: path.join(ROOT_DIR, 'build', 'sanitize-local.json'),
      requireLocal: opts.requireLocal,
      warn: log,
    });
    const sanitizeResult = await sanitize(payloadDir, rules);
    for (const w of sanitizeResult.warnings) log(`sanitize warning: ${w}`);
    if (!sanitizeResult.ok) {
      log(`sanitize: FAILED (${sanitizeResult.hits.length} hit(s))`);
      for (const h of sanitizeResult.hits) {
        const loc = h.line ? `:${h.line}` : '';
        log(`  hit: ${h.file}${loc} [${h.rule}]`);
      }
      log('build: aborted, no zip written (exit 2)');
      process.exit(2);
      return;
    }
    log(`sanitize: ok (0 hits, ${sanitizeResult.warnings.length} warning(s))`);

    // Parts with redistribute:'download' (currently just 'claude') are
    // deliberately not collected -- they are downloaded by the installer
    // itself at install time (Task 12), so buildManifest must not be asked
    // to hash a payload file that was never staged for them.
    const manifestLock = {
      ...lock,
      parts: Object.fromEntries(Object.entries(lock.parts).filter(([name]) => !skipped.includes(name))),
    };

    log('manifest: build');
    const manifest = await buildManifest({ payloadDir, lock: manifestLock, faceVersion });
    fs.writeFileSync(path.join(payloadDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    log(`manifest: ${Object.keys(manifest.parts).length} part(s)`);
    for (const [name, p] of Object.entries(manifest.parts)) {
      log(`  part ${name}: ${p.file} ${fmtBytes(p.bytes)} sha256=${p.sha256.slice(0, 12)}...`);
    }

    log('pack: start');
    const { zipPath, sha256Path } = await pack({ stageDir, outDir, manifest, version: manifest.package.version });
    const zipSize = fs.statSync(zipPath).size;
    const zipHash = fs.readFileSync(sha256Path, 'utf8').trim();
    const elapsedMs = Date.now() - startedAt;

    log(`pack: done zip=${zipPath} size=${fmtBytes(zipSize)} (${zipSize} bytes)`);
    log(`sha256: ${zipHash}`);

    // last-build.json lets verify/static.mjs check the zip that was *just*
    // built, rather than guessing via "newest file in outDir" (I4) -- e.g.
    // two builds racing, or a stale zip left over from a previous run.
    const lastBuildPath = path.join(outDir, 'last-build.json');
    fs.writeFileSync(lastBuildPath, JSON.stringify({ zip: zipPath, sha256: zipHash, built: manifest.built, stageDir }, null, 2));
    log(`last-build: ${lastBuildPath}`);

    log(`build: OK in ${(elapsedMs / 1000).toFixed(1)}s`);

    console.log('');
    console.log(`zip:      ${zipPath}`);
    console.log(`sha256:   ${zipHash}`);
    console.log(`size:     ${fmtBytes(zipSize)} (${zipSize} bytes)`);
    console.log(`elapsed:  ${(elapsedMs / 1000).toFixed(1)}s`);
  } catch (err) {
    log(`build: ERROR ${err.stack || err.message}`);
    process.exitCode = 1;
    throw err;
  }
}

main();
