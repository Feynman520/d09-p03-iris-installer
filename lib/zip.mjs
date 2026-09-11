import fs from 'node:fs';
import path from 'node:path';
import { run } from './run.mjs';

const TAR = 'C:\\Windows\\System32\\tar.exe';

export async function extractZip(zip, dest, { strip = 0 } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const args = ['-xf', zip, '-C', dest];
  if (strip) args.push('--strip-components', String(strip));
  const r = await run(TAR, args);
  if (r.code !== 0) throw new Error(`extract failed ${zip}: ${r.err}`);
}

export async function zipDir(dir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const r = await run(TAR, ['-a', '-cf', zipPath, '-C', dir, '.']);
  if (r.code !== 0) throw new Error(`zip failed ${dir}: ${r.err}`);
}
