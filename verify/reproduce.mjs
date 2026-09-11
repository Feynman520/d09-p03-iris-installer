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

async function main() {
  const manifestA = await runBuild('a');
  const manifestB = await runBuild('b');

  console.log('');
  console.log(`build a: built=${manifestA.built} package.version=${manifestA.package.version}`);
  console.log(`build b: built=${manifestB.built} package.version=${manifestB.package.version}`);

  const mismatches = compareManifests(manifestA, manifestB);
  if (mismatches.length > 0) {
    console.log('\nreproduce verify: FAILED');
    for (const m of mismatches) console.log(`  ${m}`);
    process.exit(1);
  }

  console.log(`\nall ${Object.keys(manifestA.parts).length} part sha256 values match (built timestamp differs, as expected)`);
  console.log('reproduce verify: OK');
}

main();
