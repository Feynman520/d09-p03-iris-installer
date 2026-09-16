import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/run.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_MJS = path.join(ROOT_DIR, 'build', 'build.mjs');

// Two independent builds, same lock/cache (npm/download cache is shared and
// read-only under --skip-download), separate --out/--stage so neither run
// disturbs the other's files while both are in flight.
async function runBuild(label) {
  const out = path.join(ROOT_DIR, '_build', `out-${label}`);
  const stage = path.join(ROOT_DIR, '_build', `stage-${label}`);
  const cache = path.join(ROOT_DIR, '_build', 'cache');
  console.log(`build ${label}: start (out=${out})`);
  const r = await run(
    process.execPath,
    [BUILD_MJS, '--out', out, '--stage', stage, '--cache', cache, '--skip-download'],
    { cwd: ROOT_DIR, timeoutMs: 15 * 60 * 1000 },
  );
  if (r.code !== 0) {
    console.error(r.out);
    console.error(r.err);
    throw new Error(`build ${label} failed with exit code ${r.code}`);
  }
  console.log(`build ${label}: done`);
  const manifestPath = path.join(stage, 'payload', 'manifest.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function compareManifests(a, b) {
  const mismatches = [];
  // 내용 지문 (Task 24a): the whole point of contentFingerprint is that two
  // builds of unchanged sources produce the SAME value even though their zip
  // sha256 differs (payload\manifest.json's `built`). If the two builds here
  // disagree the fingerprint is not build-stable, and the release gate that
  // rests on it would reject rows for no reason -- so this is a hard failure,
  // not a note. A missing value is equally a failure: an old build/pack.mjs.
  if (!a.contentFingerprint || !b.contentFingerprint) {
    mismatches.push(`contentFingerprint: missing (a=${a.contentFingerprint ?? '(none)'} b=${b.contentFingerprint ?? '(none)'})`);
  } else if (a.contentFingerprint !== b.contentFingerprint) {
    mismatches.push(`contentFingerprint differs (a=${a.contentFingerprint} b=${b.contentFingerprint}) -- 내용 지문이 빌드마다 바뀐다`);
  }
  const keysA = new Set(Object.keys(a.parts));
  const keysB = new Set(Object.keys(b.parts));
  const allKeys = new Set([...keysA, ...keysB]);
  for (const key of allKeys) {
    if (!keysA.has(key)) { mismatches.push(`${key}: present in build b only`); continue; }
    if (!keysB.has(key)) { mismatches.push(`${key}: present in build a only`); continue; }
    const pa = a.parts[key];
    const pb = b.parts[key];
    if (pa.sha256 !== pb.sha256) {
      mismatches.push(`${key}: sha256 differs (a=${pa.sha256} b=${pb.sha256})`);
    }
  }
  return mismatches;
}

// The four dirs runBuild() above creates (out-a/out-b/stage-a/stage-b) are
// scratch space for this comparison run only -- unlike _build/out (the
// build.mjs default), nothing else reads them afterward, and left behind
// they just accumulate (two full builds' worth of staged npm installs,
// downloaded runtimes, etc. -- hundreds of MB) across repeated
// `node verify/reproduce.mjs` runs. Clean them up unconditionally, success
// or failure (including a thrown build error), so re-running never has to
// account for a partial previous run's leftovers.
function cleanup() {
  for (const label of ['out-a', 'out-b', 'stage-a', 'stage-b']) {
    fs.rmSync(path.join(ROOT_DIR, '_build', label), { recursive: true, force: true });
  }
}

async function main() {
  try {
    const manifestA = await runBuild('a');
    const manifestB = await runBuild('b');

    console.log('');
    console.log(`build a: built=${manifestA.built} package.version=${manifestA.package.version} 내용지문=${manifestA.contentFingerprint}`);
    console.log(`build b: built=${manifestB.built} package.version=${manifestB.package.version} 내용지문=${manifestB.contentFingerprint}`);

    const mismatches = compareManifests(manifestA, manifestB);
    if (mismatches.length > 0) {
      console.log('\nreproduce verify: FAILED');
      for (const m of mismatches) console.log(`  ${m}`);
      // process.exitCode (not process.exit()) -- process.exit() terminates
      // immediately and would skip the finally block's cleanup() below.
      process.exitCode = 1;
      return;
    }

    console.log(`\nall ${Object.keys(manifestA.parts).length} part sha256 values match (built timestamp differs, as expected)`);
    console.log(`내용 지문도 같다: ${manifestA.contentFingerprint}`);
    console.log('reproduce verify: OK');
  } finally {
    cleanup();
  }
}

main();
