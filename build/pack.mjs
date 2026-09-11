import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../lib/manifest.mjs';
import { zipDir } from '../lib/zip.mjs';

// Project root (one level up from build/), independent of process.cwd() --
// same convention as build/collect.mjs's ROOT_DIR. installer/ is a static
// source folder that lives in the repo, not something collect() stages, so
// pack() needs its own fixed anchor to find it when a caller doesn't pass
// installerDir explicitly.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INSTALLER_DIR = path.join(ROOT_DIR, 'installer');
const CMD_NAME = 'IRIS-설치.cmd';

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

// pack({stageDir, outDir, manifest, version, installerDir}) -> {zipPath, sha256Path}
//
// Builds the zip-root layout (IRIS-설치.cmd at the root, installer/ copied
// wholesale, payload/ copied from stageDir/payload -- which the caller must
// already have populated, manifest.json included) and zips it with zipDir
// (tar -a). Also writes a `<zip>.sha256` sidecar containing
// "<hex>  <zipname>" (the same two-column format `sha256sum` produces, so
// `sha256sum -c` on the sidecar just works).
//
// `installerDir` defaults to this repo's own `installer/` folder so
// build.mjs can call pack() without knowing that detail; tests pass a fully
// self-contained fake installerDir so they don't depend on installer/'s
// real (evolving, Task 9+) contents.
export async function pack({ stageDir, outDir, manifest, version = manifest?.package?.version, installerDir = DEFAULT_INSTALLER_DIR }) {
  if (!version) throw new Error('pack: version (or manifest.package.version) is required');

  const root = path.join(stageDir, 'zip-root');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const cmdSrc = path.join(installerDir, CMD_NAME);
  if (!fs.existsSync(cmdSrc)) throw new Error(`pack: ${CMD_NAME} not found under installerDir ${installerDir}`);
  fs.copyFileSync(cmdSrc, path.join(root, CMD_NAME));

  copyTree(installerDir, path.join(root, 'installer'));

  const payloadSrc = path.join(stageDir, 'payload');
  if (!fs.existsSync(payloadSrc)) throw new Error(`pack: payload dir not found at ${payloadSrc}`);
  copyTree(payloadSrc, path.join(root, 'payload'));

  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  const zipName = `IRIS-설치_v${version}_${dateStr}.zip`;
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, zipName);
  fs.rmSync(zipPath, { force: true });
  await zipDir(root, zipPath);

  const hex = await sha256File(zipPath);
  const sha256Path = `${zipPath}.sha256`;
  fs.writeFileSync(sha256Path, `${hex}  ${path.basename(zipPath)}\n`);

  return { zipPath, sha256Path };
}
