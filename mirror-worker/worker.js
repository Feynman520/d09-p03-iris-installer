// IRIS 내려받기 창구 — R2 버킷 iris-downloads 를 r2.dev 대신 https://iris-workspace-dl.pages.dev 로 내준다(2026-11-09).
// Cloudflare Pages 프로젝트 `iris-workspace-dl` 의 _worker.js(고급 모드)로 올라가며, 버킷은 이름 B 로 묶인다.
//
// 왜 있나(학교 유선망 실측 2026-11-06·11-09, 556MB 설치 zip):
//   r2.dev 공개 주소            초당 60~80KB, 미국 LA 경유  → 2시간 넘음 (Cloudflare 가 "개발용"으로 속도를 묶은 주소)
//   Worker(*.workers.dev)       초당 0.16~4.6MB, 미국 LA 경유 → 들쭉날쭉
//   이 창구(*.pages.dev)        초당 30~43MB, 서울(ICN)      → 약 15초
//   GitHub 릴리스 첨부          학교 유선에서 연결 자체가 막힘
// 그래서 홈페이지 내려받기 단추와 IRIS 창 업데이트기의 미러 1순위를 이 창구로 둔다. r2.dev 는 이미 설치된 IRIS 창이
// 허용 주소로 쓰고 있으므로 끄지 않는다(latest.json 의 url 칸도 r2.dev 그대로 — 옛 창이 거절하지 않게).
//
// 읽기 전용(GET·HEAD)이고, 버킷에 실제로 있는 파일 이름 모양만 내준다. 이어받기(Range)·조건부 요청(If-None-Match)을 지원한다.
// 배포 = `node build/mirror-worker-deploy.mjs` (P03 저장소 루트에서). 시험 = tests/mirror-worker.test.mjs.

/** 내줄 수 있는 이름: 설치 패키지 zip, 부품(iris-face·iris-messenger …) zip, 각각의 .sha256·.sha256.sig, latest.json. */
export const ALLOWED_KEY = /^(?:(?:IRIS-Setup_[A-Za-z0-9._-]+|iris-[a-z0-9-]+-v\d+\.\d+\.\d+[A-Za-z0-9._-]*)\.zip(?:\.sha256(?:\.sig)?)?|latest\.json)$/;

export function keyFromUrl(url) {
  let key;
  try { key = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, '')); } catch { return null; }
  return ALLOWED_KEY.test(key) ? key : null;
}

function baseHeaders(key, obj) {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('x-content-type-options', 'nosniff');
  if (key === 'latest.json') {
    // 최신 판 표는 판을 낼 때마다 바뀐다 — 오래 붙잡지 않는다.
    headers.set('cache-control', 'no-cache');
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  } else {
    headers.set('cache-control', 'public, max-age=3600');
    if (key.endsWith('.zip')) headers.set('content-disposition', `attachment; filename="${key}"`);
  }
  return headers;
}

export async function handle(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const key = keyFromUrl(request.url);
  if (!key) return new Response('not found', { status: 404 });

  if (request.method === 'HEAD') {
    const h = await env.B.head(key);
    if (!h) return new Response(null, { status: 404 });
    const headers = baseHeaders(key, h);
    headers.set('content-length', String(h.size));
    return new Response(null, { status: 200, headers });
  }

  const hasRange = request.headers.has('range');
  const obj = await env.B.get(key, { range: request.headers, onlyIf: request.headers });
  if (obj === null) return new Response('not found', { status: 404 });
  const headers = baseHeaders(key, obj);
  // 조건부 요청이 맞아 몸통이 없으면(If-None-Match 일치) 304.
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });

  let status = 200;
  if (hasRange && obj.range) {
    let start, end;
    if (obj.range.suffix !== undefined) { start = Math.max(0, obj.size - obj.range.suffix); end = obj.size - 1; }
    else { start = obj.range.offset ?? 0; end = obj.range.length !== undefined ? start + obj.range.length - 1 : obj.size - 1; }
    status = 206;
    headers.set('content-range', `bytes ${start}-${end}/${obj.size}`);
    headers.set('content-length', String(end - start + 1));
  } else {
    headers.set('content-length', String(obj.size));
  }
  return new Response(obj.body, { status, headers });
}

export default { fetch: (request, env) => handle(request, env) };
