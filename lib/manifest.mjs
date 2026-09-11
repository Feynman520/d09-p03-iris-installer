import { createHash } from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
export function sha256File(file) {
  return new Promise((res, rej) => { const h = createHash('sha256'); fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
}
export async function buildManifest({ payloadDir, lock, faceVersion }) {
  const parts = {};
  for (const [name, p] of Object.entries(lock.parts)) {
    const isGlob = p.file.endsWith('/');
    const files = isGlob ? fs.readdirSync(path.join(payloadDir, p.file)).map(f => p.file + f) : [p.file];
    for (const rel of files) {
      const abs = path.join(payloadDir, rel);
      // guides has no per-part `version` field (lock-only version bump, I5):
      // fall back to lock.package.guideVersion, the single source of truth.
      const version = name === 'face' ? faceVersion : name === 'guides' ? (p.version ?? lock.package.guideVersion ?? null) : (p.version ?? null);
      parts[isGlob ? `${name}:${path.basename(rel)}` : name] = { file: rel, version, sha256: await sha256File(abs), bytes: fs.statSync(abs).size };
    }
  }
  return { schema: 1, built: new Date().toISOString(), package: { name: 'IRIS', version: lock.package.version, guideVersion: lock.package.guideVersion, license: 'MIT' }, parts };
}
export async function verifyManifest(payloadDir, manifest) {
  const mismatches = [];
  for (const p of Object.values(manifest.parts)) {
    const abs = path.join(payloadDir, p.file);
    const actual = fs.existsSync(abs) ? await sha256File(abs) : null;
    if (actual !== p.sha256) mismatches.push({ file: p.file, expected: p.sha256, actual });
  }
  return { ok: mismatches.length === 0, mismatches };
}
