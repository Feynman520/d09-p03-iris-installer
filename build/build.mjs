import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from './collect.mjs';
import { sanitize } from './sanitize.mjs';
import { loadRules } from './rules.mjs';
// NOTE (T08 fix round 1): lib/manifest.mjs's buildManifest() is no longer
// imported here -- build/pack.mjs writes payload\manifest.json (schema 2) as
// the single pass over the finished payload. buildManifest() itself is kept
// in lib/manifest.mjs: it is the v1 shape that tests/manifest.test.mjs pins
// (`schema === 1`), and verifyManifest()/sha256File() from that module are
// still used by verify/static.mjs, the installer and the updater.
import { pack } from './pack.mjs';
import { isOffline } from '../lib/net.mjs';

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
    out: DEFAULTS.out, cache: DEFAULTS.cache, stage: DEFAULTS.stage, skipDownload: false, noCache: false,
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
    // Force every part to be re-collected even when its cache slot is valid
    // (T07): proves the slot can be rebuilt, and is the escape hatch when an
    // upstream re-tag leaves a slot that validates but is wrong.
    else if (a === '--no-cache') opts.noCache = true;
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

  log(`build start out=${outDir} cache=${cacheDir} stage=${stageDir} skipDownload=${opts.skipDownload} noCache=${opts.noCache} offline=${isOffline()} requireLocal=${opts.requireLocal}`);
  const startedAt = Date.now();

  try {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'lock.json'), 'utf8'));

    log('collect: start');
    const { payloadDir, faceVersion, skipped, partsMeta } = await collect({
      lock,
      cacheDir,
      stageDir,
      log,
      skipDownload: opts.skipDownload,
      noCache: opts.noCache,
    });
    const licenseCount = new Set(Object.values(partsMeta).flatMap((m) => m.licenseFiles ?? [])).size;
    log(`collect: done (skipped=${skipped.join(',') || 'none'}, licenses=${licenseCount})`);

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

    // manifest.json is built ONCE, by pack(), and only after the whole
    // payload is assembled (T08 fix round 1). This used to run v1
    // buildManifest() here first -- hashing all ~365MB -- and then pack()
    // overwrote payload\manifest.json with the schema 2 one, so the first
    // pass was pure dead work (measured 1.48s on this PC: the payload is a
    // few big archives and sha256File streams them fast, so the cost was
    // smaller than it looks -- but it was 365MB read for nothing, and a
    // manifest that no longer reached the zip). pack() needs the full payload
    // anyway: the policy templates, presets.json and NOTICES.md it adds are
    // part of `files{}`, and this function could not have hashed them.
    //
    // collect()'s per-part record reaches pack() through
    // _build\stage\parts-meta.json (see collect.mjs), which is also where the
    // download-only parts (`skipped`) get their metadata from -- so the old
    // "filter skipped parts out of the lock" step is gone too: pack() puts
    // them in manifest.downloads{}, not manifest.parts{}.
    //
    // `faceVersion` is likewise already inside partsMeta.face.version, which
    // is where pack()'s notice table reads it from.
    void faceVersion;

    log('pack: start');
    const { zipPath, sha256Path, manifest, contentFingerprint } = await pack({
      stageDir, outDir, version: lock.package.version, log,
    });
    log(`manifest: schema ${manifest.schema}, ${Object.keys(manifest.parts).length} part(s), ${Object.keys(manifest.files).length} payload file(s)`);
    for (const [name, p] of Object.entries(manifest.parts)) {
      log(`  part ${name}: ${p.file} ${fmtBytes(p.bytes)} sha256=${p.sha256.slice(0, 12)}...`);
    }
    for (const [name, d] of Object.entries(manifest.downloads ?? {})) {
      log(`  part ${name}: ${d.file} [download at install] sha256=${String(d.download?.sha256 ?? '-').slice(0, 12)}...`);
    }
    const zipSize = fs.statSync(zipPath).size;
    const zipHash = fs.readFileSync(sha256Path, 'utf8').trim();
    const elapsedMs = Date.now() - startedAt;

    log(`pack: done zip=${zipPath} size=${fmtBytes(zipSize)} (${zipSize} bytes)`);
    log(`sha256: ${zipHash}`);
    // 내용 지문 -- the build-stable one. The zip sha above changes on every
    // build (payload\manifest.json carries `built`), so it cannot be what the
    // 시험행렬 rows and the release gate compare against (Task 24a).
    log(`내용 지문 (contentFingerprint): ${contentFingerprint}`);

    // last-build.json lets verify/static.mjs check the zip that was *just*
    // built, rather than guessing via "newest file in outDir" (I4) -- e.g.
    // two builds racing, or a stale zip left over from a previous run.
    // `contentFingerprint` is what iris-release.mjs's gate and verify/e2e.mjs
    // read; `sha256` stays for the zip's own identity (releases, sidecar).
    const lastBuildPath = path.join(outDir, 'last-build.json');
    fs.writeFileSync(lastBuildPath, JSON.stringify({
      zip: zipPath, sha256: zipHash, contentFingerprint, built: manifest.built, stageDir,
    }, null, 2));
    log(`last-build: ${lastBuildPath}`);

    log(`build: OK in ${(elapsedMs / 1000).toFixed(1)}s`);

    console.log('');
    console.log(`zip:      ${zipPath}`);
    console.log(`sha256:   ${zipHash}`);
    console.log(`내용 지문: ${contentFingerprint}`);
    console.log(`size:     ${fmtBytes(zipSize)} (${zipSize} bytes)`);
    console.log(`elapsed:  ${(elapsedMs / 1000).toFixed(1)}s`);
  } catch (err) {
    log(`build: ERROR ${err.stack || err.message}`);
    process.exitCode = 1;
    throw err;
  }
}

main();
