import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { run } from '../lib/run.mjs';
import { extractZip, zipDir } from '../lib/zip.mjs';
import { sha256File } from '../lib/manifest.mjs';
import { applyPatches } from './patch-teamclaude.mjs';

// Project root (one level up from this file, build/), independent of the
// caller's process.cwd() -- lock.json's `patches` paths (e.g.
// 'patches/teamclaude/rules.json') are always relative to here, not to
// wherever `node build/collect.mjs` (or a test importing collect()) happens
// to be run from.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
  fs.renameSync(part, dest);
}

async function ensureCached(name, p, cacheDir, log) {
  if (!p.sha256) throw new Error(`sha256 missing for ${name}`);
  const cached = path.join(cacheDir, path.basename(p.file));
  if (!fs.existsSync(cached) || (await sha256File(cached)) !== p.sha256) {
    log(`download ${name}`);
    await download(p.url, cached);
  }
  if ((await sha256File(cached)) !== p.sha256) throw new Error(`sha256 mismatch for ${name}`);
  return cached;
}

function npmCliPath(nodeDir) {
  return path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

// Resolve which Node executable / npm-cli.js to use for every `npm install`/`npm ci`
// this collect() run performs. The bundled runtime (lock.parts.node) always wins so
// npm never runs under whatever Node happens to be on the build PC's PATH; an
// explicit `nodeDir` overrides that; a bare fallback to this PC's own Node only
// exists so unit tests with fake locks (no node part, no npmCi/npm-prefix use) work.
async function resolveNode({ lock, cacheDir, stageDir, nodeDir, log }) {
  if (nodeDir) return { nodeExe: path.join(nodeDir, 'node.exe'), npmCli: npmCliPath(nodeDir), nodeDir };
  const p = lock.parts?.node;
  if (p && p.kind === 'url') {
    const cached = await ensureCached('node', p, cacheDir, log);
    const runtimeDir = path.join(stageDir, 'node-runtime');
    await extractZip(cached, runtimeDir, { strip: 1 });
    return { nodeExe: path.join(runtimeDir, 'node.exe'), npmCli: npmCliPath(runtimeDir), nodeDir: runtimeDir };
  }
  const fallbackDir = path.dirname(process.execPath);
  return {
    nodeExe: process.execPath,
    npmCli: path.join(fallbackDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    nodeDir: null,
  };
}

function copyTree(src, dest, exclude = []) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      if (rel === '') return true;
      const first = rel.split(path.sep)[0];
      return !exclude.includes(first);
    },
  });
}

function globMatch(name, pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`).test(name);
}

export async function collect({ lock, cacheDir, stageDir, nodeDir, log }) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  const payloadDir = path.join(stageDir, 'payload');
  fs.mkdirSync(payloadDir, { recursive: true });

  const { nodeExe, npmCli, nodeDir: resolvedNodeDir } = await resolveNode({ lock, cacheDir, stageDir, nodeDir, log });
  const npmEnv = { ...process.env, npm_config_cache: path.join(cacheDir, 'npm-cache') };

  const skipped = [];
  let faceVersion = null;

  for (const [name, p] of Object.entries(lock.parts)) {
    const isGlob = p.kind === 'glob';
    const dest = path.join(payloadDir, p.file);
    if (!isGlob) fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (p.kind === 'url') {
      const cached = await ensureCached(name, p, cacheDir, log);
      fs.copyFileSync(cached, dest);
    } else if (p.kind === 'npm-prefix') {
      if (p.redistribute === 'download') { skipped.push(name); continue; }
      const prefix = path.join(stageDir, 'npm', name);
      fs.mkdirSync(prefix, { recursive: true });
      const r = await run(
        nodeExe,
        [npmCli, 'install', '-g', '--prefix', prefix, `${p.npm}@${p.version}`, '--no-fund', '--no-audit'],
        { env: npmEnv },
      );
      if (r.code !== 0) throw new Error(`npm install ${name}: ${r.err}`);
      if (p.patches) await applyPatches(prefix, JSON.parse(fs.readFileSync(path.resolve(ROOT_DIR, p.patches), 'utf8')), log);
      await zipDir(prefix, dest);
    } else if (p.kind === 'dir') {
      const work = path.join(stageDir, 'dir', name);
      copyTree(p.source, work, p.exclude ?? []);
      if (p.npmCi) {
        const r = await run(nodeExe, [npmCli, 'ci', '--no-fund', '--no-audit'], { cwd: work, env: npmEnv });
        if (r.code !== 0) throw new Error(`npm ci ${name}: ${r.err}`);
      }
      if (name === 'face') {
        const pkgPath = path.join(work, 'package.json');
        if (fs.existsSync(pkgPath)) faceVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
      }
      await zipDir(work, dest);
    } else if (p.kind === 'file') {
      fs.copyFileSync(p.source, dest);
    } else if (isGlob) {
      fs.mkdirSync(dest, { recursive: true });
      const files = fs.readdirSync(p.source).filter((f) => globMatch(f, p.pattern));
      for (const f of files) fs.copyFileSync(path.join(p.source, f), path.join(dest, f));
    } else {
      throw new Error(`unknown part kind for ${name}: ${p.kind}`);
    }
  }

  return { payloadDir, faceVersion, skipped, nodeDir: resolvedNodeDir };
}
