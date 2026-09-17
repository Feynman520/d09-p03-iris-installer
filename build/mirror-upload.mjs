// 릴리스 zip 을 Cloudflare R2 미러(버킷 iris-downloads, 공개 주소 pub-….r2.dev)에 올린다.
//
// 왜 있나(2026-09-17, 실제 사용자 4회 실측): 학교·회사 망이 GitHub 릴리스 **첨부 서버**
// (release-assets.githubusercontent.com)만 끊는다 — github.com 은 열리고 첨부만 ERR_TIMED_OUT.
// 홈페이지(P05 site.js `CONFIG.mirror.assets`)는 미러에 있는 판이면 내려받기 단추를 미러로
// 돌리므로, **새 판은 반드시 여기까지 올린 뒤** 홈페이지 값을 갱신한다(AGENTS.md 새 판 순서).
//
// wrangler 는 300 MiB 까지만 올린다("Wrangler only supports uploading files up to 300 MiB").
// 그래서 S3 호환 API 의 멀티파트로 올린다. 자격증명은 Cloudflare API 토큰에서 **유도**한다:
//   access key = 토큰 id(/user/tokens/verify), secret = sha256(토큰) hex, 계정 id = /accounts.
// 토큰은 `$env:CLAUDE_CONFIG_DIR\secrets\.env` 의 CLOUDFLARE_API_TOKEN 뿐이며 어디에도 찍지 않는다.
//
//   node build/mirror-upload.mjs --out _build/out-208        (zip + .sha256 둘 다)
//   node build/mirror-upload.mjs --file <경로> [--key <이름>] [--content-type <형식>]
//   --check <이름>   공개 주소가 200 을 돌려주는지만 본다(업로드 없음)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export const BUCKET = 'iris-downloads';
export const PUBLIC_BASE = 'https://pub-6bb549660d7d4bd79ed07a7b6523f5c5.r2.dev';

function parseArgs(argv) {
  const o = { files: [], contentType: null, key: null, out: null, check: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--file') o.files.push(argv[++i]);
    else if (a === '--key') o.key = argv[++i];
    else if (a === '--content-type') o.contentType = argv[++i];
    else if (a === '--check') o.check = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function readToken() {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (!cfg) throw new Error('CLAUDE_CONFIG_DIR is not set');
  const envFile = path.join(cfg, 'secrets', '.env');
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  throw new Error('CLOUDFLARE_API_TOKEN not found in secrets/.env');
}

async function cfJson(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok || !j?.success) throw new Error(`Cloudflare API ${url} -> ${r.status}`);
  return j.result;
}

export async function deriveCredentials({ token = readToken() } = {}) {
  const verify = await cfJson('https://api.cloudflare.com/client/v4/user/tokens/verify', token);
  const accounts = await cfJson('https://api.cloudflare.com/client/v4/accounts', token);
  if (!verify?.id || !accounts?.[0]?.id) throw new Error('could not resolve token id / account id');
  return {
    accountId: accounts[0].id,
    accessKeyId: verify.id,
    secretAccessKey: crypto.createHash('sha256').update(token).digest('hex'),
  };
}

export function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.zip') return 'application/zip';
  if (ext === '.sha256' || ext === '.txt' || ext === '.md') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export async function uploadFile({ file, key = path.basename(file), contentType = contentTypeFor(file), log = console.log }) {
  const creds = await deriveCredentials();
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
  const size = fs.statSync(file).size;
  const started = Date.now();
  const up = new Upload({
    client,
    params: { Bucket: BUCKET, Key: key, Body: fs.createReadStream(file), ContentType: contentType },
    partSize: 64 * 1024 * 1024,
    queueSize: 4,
    leavePartsOnError: false,
  });
  let last = 0;
  up.on('httpUploadProgress', (p) => {
    const loaded = p.loaded ?? 0;
    if (loaded - last >= 64 * 1024 * 1024) { last = loaded; log(`  ${(loaded / 1048576).toFixed(0)} / ${(size / 1048576).toFixed(0)} MiB`); }
  });
  await up.done();
  log(`mirror: ${key} (${size.toLocaleString('en-US')} bytes) in ${Math.round((Date.now() - started) / 1000)}s`);
  return { key, size, url: `${PUBLIC_BASE}/${key}` };
}

export async function checkPublic(key) {
  const r = await fetch(`${PUBLIC_BASE}/${key}`, { method: 'HEAD' });
  return { ok: r.status === 200, status: r.status, length: Number(r.headers.get('content-length') ?? 0) };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.check) {
    const c = await checkPublic(o.check);
    console.log(`mirror check ${o.check}: ${c.ok ? 'OK' : 'FAIL'} (HTTP ${c.status}, ${c.length.toLocaleString('en-US')} bytes)`);
    process.exit(c.ok ? 0 : 1);
  }
  const files = [...o.files];
  if (o.out) {
    // zip · .sha256 · .sha256.sig(Face 업데이트기가 요구하는 공식 서명) 셋 다 — 서명이 빠지면 업데이트가 거절된다(2026-09-18 실측).
    for (const f of fs.readdirSync(o.out)) if (/\.zip(\.sha256(\.sig)?)?$/.test(f)) files.push(path.join(o.out, f));
  }
  if (files.length === 0) throw new Error('nothing to upload (--out <dir> or --file <path>)');
  const results = [];
  for (const f of files) {
    const r = await uploadFile({ file: f, key: files.length === 1 && o.key ? o.key : path.basename(f), contentType: o.contentType ?? contentTypeFor(f) });
    const c = await checkPublic(r.key);
    if (!c.ok || c.length !== r.size) throw new Error(`public check failed for ${r.key}: HTTP ${c.status}, ${c.length} bytes (expected ${r.size})`);
    results.push(r);
  }
  console.log('mirror: OK');
  console.log(`homepage: add to CONFIG.mirror.assets -> ${results.filter((r) => r.key.endsWith('.zip')).map((r) => `'${r.key}'`).join(', ')}`);
}

// 직접 실행일 때만 main() — Windows 경로는 fileURLToPath 로 비교한다(URL pathname 비교는 드라이브 문자에서 어긋난다, 2026-09-17 실측).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`mirror-upload: ${err?.message ?? err}`); process.exit(1); });
}
