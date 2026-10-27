// 공개 저장소에 없는 부품을 공식 릴리스 zip 에서 꺼내 빌드 원본으로 쓴다 (docs/설계-macOS.md 4절 M2).
//
// lock.json 의 dash·hwpx-templates·ontology·ontology-spec·folder-icon 은 원작자 PC 의 살아 있는
// 폴더를 원본으로 삼는다. 다른 PC(예: macOS 빌드 PC)에는 그 폴더가 없으므로, 이미 배포된 zip 에
// 들어 있는 같은 부품을 꺼내 `_build/seed/<부품>/` 에 놓고 `IRIS_<부품>_SOURCE` 로 가리킨다
// (build/collect.mjs partSource). 원본을 고치는 것이 아니라 "다른 PC 의 원본 자리"를 채우는 일이다.
//
// zip 전체(수백 MB)를 받지 않는다: HTTP Range 로 중앙 디렉터리와 필요한 항목만 읽는다.
// 각 항목은 같은 zip 안의 payload/manifest.json 에 적힌 SHA-256 과 맞아야 쓴다.
//
//   node build/seed-from-release.mjs [--url <release zip url>] [--out _build/seed]
//   → 마지막에 `export IRIS_..._SOURCE=...` 줄을 찍는다(셸에서 eval 하거나 그대로 붙여 넣는다).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractZip } from '../lib/zip.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// build/mirror-upload.mjs PUBLIC_BASE — 홈페이지의 1순위 내려받기 자리(GitHub 첨부 서버가 막힌 망 대비).
export const DEFAULT_URL = 'https://pub-6bb549660d7d4bd79ed07a7b6523f5c5.r2.dev/IRIS-Setup_v2.0.50_2026-10-27.zip';

// 부품 → zip 안 항목, 원본 모양(폴더면 압축을 풀어 둔다).
export const SEEDS = Object.freeze({
  dash: { member: 'payload/dash/teamclaude-dash.zip', unzip: true },
  'hwpx-templates': { member: 'payload/tools/hwpx-templates.zip', unzip: true },
  ontology: { member: 'payload/setup/ontology.zip', unzip: true },
  'ontology-spec': { member: 'payload/setup/IRIS-온톨로지.md', unzip: false },
  'folder-icon': { member: 'payload/policy/_cosmos.ico', unzip: false },
});

async function range(url, start, end) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' });
  if (r.status !== 206) throw new Error(`range request refused (${r.status}) for ${url}`);
  return { buf: Buffer.from(await r.arrayBuffer()), total: Number(String(r.headers.get('content-range') ?? '').split('/')[1]) };
}

/** 중앙 디렉터리 → { 이름: { method, csize, size, offset } } */
export function parseCentralDirectory(cd, count) {
  const out = {};
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28);
    const elen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    // zip64 extra: 0xFFFFFFFF 인 칸만 순서대로 들어 있다.
    let e = p + 46 + nlen;
    const eEnd = e + elen;
    while (e + 4 <= eEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); }
      }
      e += 4 + len;
    }
    out[name] = { method, csize, size, offset };
    p += 46 + nlen + elen + clen;
  }
  return out;
}

export async function readRemoteZipIndex(url) {
  const { total } = await range(url, 0, 0);
  const tailLen = Math.min(total, 128 * 1024);
  const { buf: tail } = await range(url, total - tailLen, total - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory)');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  const z64 = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
  if (z64 >= 0 && (cdOff === 0xffffffff || count === 0xffff || cdSize === 0xffffffff)) {
    const at = Number(tail.readBigUInt64LE(z64 + 8));
    const { buf: rec } = await range(url, at, at + 55);
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOff = Number(rec.readBigUInt64LE(48));
  }
  const { buf: cd } = await range(url, cdOff, cdOff + cdSize - 1);
  return parseCentralDirectory(cd, count);
}

export async function readRemoteMember(url, entry) {
  // 지역 머리(30바이트 + 이름 + 덧붙임) 뒤에 압축된 내용이 온다. 덧붙임 길이는 중앙 디렉터리와
  // 다를 수 있어 지역 머리를 먼저 읽는다.
  const { buf: head } = await range(url, entry.offset, entry.offset + 29);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header');
  const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const { buf: data } = entry.csize > 0 ? await range(url, start, start + entry.csize - 1) : { buf: Buffer.alloc(0) };
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip method ${entry.method}`);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export async function seedFromRelease({ url = DEFAULT_URL, outDir = path.join(ROOT_DIR, '_build', 'seed'), log = console.log } = {}) {
  log(`seed: reading ${url}`);
  const index = await readRemoteZipIndex(url);
  const manifestEntry = index['payload/manifest.json'];
  if (!manifestEntry) throw new Error('seed: payload/manifest.json not in the release zip');
  const manifest = JSON.parse((await readRemoteMember(url, manifestEntry)).toString('utf8'));
  const wanted = Object.fromEntries(Object.values(manifest.files ?? {}).length
    ? Object.entries(manifest.files).map(([rel, f]) => [`payload/${rel}`, f.sha256])
    : Object.values(manifest.parts).map((p) => [`payload/${p.file}`, p.sha256]));

  const env = {};
  for (const [part, spec] of Object.entries(SEEDS)) {
    const entry = index[spec.member];
    if (!entry) throw new Error(`seed: ${spec.member} not in the release zip`);
    const bytes = await readRemoteMember(url, entry);
    const expect = wanted[spec.member];
    if (!expect) throw new Error(`seed: ${spec.member} has no fingerprint in payload/manifest.json`);
    if (sha256(bytes) !== expect) throw new Error(`seed: sha256 mismatch for ${spec.member}`);
    const dest = path.join(outDir, part);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const file = path.join(dest, path.posix.basename(spec.member));
    fs.writeFileSync(file, bytes);
    if (spec.unzip) {
      const tree = path.join(dest, 'source');
      await extractZip(file, tree);
      env[part] = tree;
    } else {
      env[part] = file;
    }
    log(`seed: ${part} <- ${spec.member} (${bytes.length} bytes, sha256 ok)`);
  }
  return { env, packageVersion: manifest.package?.version ?? null };
}

export function envLines(env) {
  return Object.entries(env).map(([part, p]) => `export IRIS_${part.toUpperCase().replace(/-/g, '_')}_SOURCE='${p.replace(/'/g, "'\\''")}'`);
}

// Main-module check on real paths: a symlinked launch path (macOS $TMPDIR is /var -> /private/var,
// /tmp -> /private/tmp) would otherwise never match import.meta.url and main() would silently not run.
function isEntryFile(argv1, metaUrl) {
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}
const isMain = process.argv[1] && isEntryFile(process.argv[1], import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const outDir = opt('--out') ? path.resolve(ROOT_DIR, opt('--out')) : undefined;
  seedFromRelease({ url: opt('--url'), outDir, log: (m) => console.error(m) })
    .then(({ env, packageVersion }) => {
      console.error(`seed: done (release package ${packageVersion})`);
      for (const line of envLines(env)) console.log(line);
    })
    .catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
