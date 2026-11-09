// mirror-worker/worker.js 를 Cloudflare Pages 프로젝트 `iris-workspace-dl`(https://iris-workspace-dl.pages.dev)에 올린다.
//
// 왜 Pages 인가(2026-11-09 학교 유선 실측): 같은 R2 버킷을 *.workers.dev 로 내주면 미국 LA 경유(초당 약 2MB)였지만
// *.pages.dev 는 서울(ICN) 경유로 초당 30~43MB 가 나왔다. 또 workers.dev 주소에는 계정 이름이 붙어 공개 저장소의
// 개인 문자열 검사(verify/static.mjs ⑦⑫)에 걸린다 — pages.dev 주소는 프로젝트 이름만 쓴다.
//
// wrangler 는 쓰지 않는다(이 PC 에서 libuv 단언으로 죽는다 — mirror-upload.mjs 머리말). REST API 로 직접 올린다:
// 프로젝트가 없으면 만들고(R2 바인딩 B = iris-downloads), 정적 파일 없이 `_worker.js` 하나만 담은 배포를 만든다.
// 토큰 = `$env:CLAUDE_CONFIG_DIR\secrets\.env` 의 CLOUDFLARE_API_TOKEN(어디에도 찍지 않음). 계정 id 는 토큰으로 조회한다.
//
//   node build/mirror-worker-deploy.mjs           배포 + 공개 주소 확인(HEAD latest.json 200)
//   node build/mirror-worker-deploy.mjs --check   배포 없이 공개 주소만 확인
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT = 'iris-workspace-dl';
export const FAST_BASE = `https://${PROJECT}.pages.dev`;
const BUCKET = 'iris-downloads';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = path.join(HERE, '..', 'mirror-worker', 'worker.js');

function readToken() {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (!cfg) throw new Error('CLAUDE_CONFIG_DIR is not set');
  for (const line of fs.readFileSync(path.join(cfg, 'secrets', '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  throw new Error('CLOUDFLARE_API_TOKEN not found in secrets/.env');
}

async function cf(token, method, url, body) {
  const init = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(`https://api.cloudflare.com/client/v4${url}`, init);
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, ok: r.ok && j?.success !== false, j };
}

export async function checkFast({ tries = 1, waitMs = 8000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${FAST_BASE}/latest.json`, { method: 'HEAD' }).catch(() => null);
    if (r?.status === 200) return { ok: true, status: 200 };
    if (i < tries - 1) await new Promise((res) => setTimeout(res, waitMs));
    else return { ok: false, status: r?.status ?? 0 };
  }
  return { ok: false, status: 0 };
}

async function deploy() {
  const token = readToken();
  const acc = await cf(token, 'GET', '/accounts');
  const accountId = acc.j?.result?.[0]?.id;
  if (!accountId) throw new Error(`could not resolve account id (HTTP ${acc.status})`);
  const cfg = { compatibility_date: '2026-10-01', r2_buckets: { B: { name: BUCKET } } };
  let p = await cf(token, 'GET', `/accounts/${accountId}/pages/projects/${PROJECT}`);
  if (p.status === 404) {
    p = await cf(token, 'POST', `/accounts/${accountId}/pages/projects`, { name: PROJECT, production_branch: 'main', deployment_configs: { production: cfg, preview: cfg } });
    if (!p.ok) throw new Error(`project create failed: HTTP ${p.status} ${JSON.stringify(p.j?.errors ?? [])}`);
    console.log(`pages: created project ${PROJECT}`);
  } else if (!p.ok) throw new Error(`project lookup failed: HTTP ${p.status}`);
  if (p.j?.result?.subdomain !== `${PROJECT}.pages.dev`) throw new Error(`unexpected subdomain ${p.j?.result?.subdomain}`);
  const fd = new FormData();
  fd.append('manifest', '{}');
  fd.append('branch', 'main');
  fd.append('_worker.js', new Blob([fs.readFileSync(WORKER_SRC, 'utf8')], { type: 'application/javascript+module' }), '_worker.js');
  const d = await cf(token, 'POST', `/accounts/${accountId}/pages/projects/${PROJECT}/deployments`, fd);
  if (!d.ok) throw new Error(`deploy failed: HTTP ${d.status} ${JSON.stringify(d.j?.errors ?? [])}`);
  console.log(`pages: deployed ${d.j?.result?.id ?? '?'} -> ${FAST_BASE}`);
}

async function main() {
  if (!process.argv.includes('--check')) await deploy();
  const c = await checkFast({ tries: 8 });
  console.log(`pages check ${FAST_BASE}/latest.json: ${c.ok ? 'OK' : 'FAIL'} (HTTP ${c.status})`);
  process.exit(c.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`mirror-worker-deploy: ${err?.message ?? err}`); process.exit(1); });
}
