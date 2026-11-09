import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_KEY, keyFromUrl, handle } from '../mirror-worker/worker.js';

const BASE = 'https://iris-workspace-dl.pages.dev';
const DATA = Buffer.from('0123456789abcdefghij');

// R2 버킷 흉내: head/get 이 R2 와 같은 모양(writeHttpMetadata·httpEtag·size·body·range)을 돌려준다.
function fakeBucket(files) {
  const meta = (key) => ({
    size: files[key].length,
    httpEtag: '"e1"',
    writeHttpMetadata: (h) => h.set('content-type', key.endsWith('.json') ? 'application/json' : 'application/zip'),
  });
  return {
    async head(key) { return files[key] ? meta(key) : null; },
    async get(key, { range, onlyIf } = {}) {
      if (!files[key]) return null;
      const m = meta(key);
      if (onlyIf?.get?.('if-none-match') === m.httpEtag) return m; // 몸통 없음 = 조건 불일치
      const rh = range?.get?.('range');
      if (rh) {
        const [, s, e] = /bytes=(\d*)-(\d*)/.exec(rh);
        if (s === '') { const suffix = Number(e); return { ...m, range: { suffix }, body: files[key].subarray(files[key].length - suffix) }; }
        const offset = Number(s), end = e === '' ? files[key].length - 1 : Number(e);
        return { ...m, range: { offset, length: end - offset + 1 }, body: files[key].subarray(offset, end + 1) };
      }
      return { ...m, body: files[key] };
    },
  };
}
const env = { B: fakeBucket({ 'IRIS-Setup_v2.0.54_2026-11-04.zip': DATA, 'latest.json': Buffer.from('{}'), 'iris-face-v2.98.0.zip.sha256.sig': Buffer.from('sig') }) };
const req = (p, init) => new Request(`${BASE}/${p}`, init);

test('only real mirror file names are allowed', () => {
  for (const ok of ['IRIS-Setup_v2.0.54_2026-11-04.zip', 'IRIS-Setup_v2.0.54_2026-11-04.zip.sha256', 'IRIS-Setup_v2.0.54_2026-11-04.zip.sha256.sig',
    'iris-face-v2.98.0.zip', 'iris-face-v2.98.0.zip.sha256', 'iris-messenger-v0.4.3.zip.sha256.sig', 'latest.json']) assert.ok(ALLOWED_KEY.test(ok), ok);
  for (const bad of ['', 'index.html', 'secret.txt', '../latest.json', 'a/latest.json', 'IRIS-Setup_v1.zip.exe', 'iris-face.zip', 'latest.json.bak', 'IRIS-Setup_ x.zip'])
    assert.equal(ALLOWED_KEY.test(bad), false, bad);
  assert.equal(keyFromUrl(`${BASE}/..%2Flatest.json`), null);
  assert.equal(keyFromUrl(`${BASE}/latest.json`), 'latest.json');
});

test('GET serves the whole zip as a download with length and etag', async () => {
  const r = await handle(req('IRIS-Setup_v2.0.54_2026-11-04.zip'), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), '20');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="IRIS-Setup_v2\.0\.54_2026-11-04\.zip"/);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), DATA.toString());
});

test('Range requests resume with 206 and a correct content-range', async () => {
  const r = await handle(req('IRIS-Setup_v2.0.54_2026-11-04.zip', { headers: { range: 'bytes=5-9' } }), env);
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 5-9/20');
  assert.equal(r.headers.get('content-length'), '5');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), '56789');
  const s = await handle(req('IRIS-Setup_v2.0.54_2026-11-04.zip', { headers: { range: 'bytes=-4' } }), env);
  assert.equal(s.headers.get('content-range'), 'bytes 16-19/20');
  const o = await handle(req('IRIS-Setup_v2.0.54_2026-11-04.zip', { headers: { range: 'bytes=15-' } }), env);
  assert.equal(o.headers.get('content-range'), 'bytes 15-19/20');
});

test('HEAD reports size without a body; latest.json is not cached or forced to download', async () => {
  const h = await handle(req('IRIS-Setup_v2.0.54_2026-11-04.zip', { method: 'HEAD' }), env);
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('content-length'), '20');
  const l = await handle(req('latest.json'), env);
  assert.equal(l.status, 200);
  assert.equal(l.headers.get('cache-control'), 'no-cache');
  assert.equal(l.headers.get('content-disposition'), null);
});

test('If-None-Match match gives 304; missing, disallowed and write requests are refused', async () => {
  assert.equal((await handle(req('latest.json', { headers: { 'if-none-match': '"e1"' } }), env)).status, 304);
  assert.equal((await handle(req('iris-face-v2.99.0.zip'), env)).status, 404);
  assert.equal((await handle(req('secret.txt'), env)).status, 404);
  assert.equal((await handle(req('latest.json', { method: 'PUT', body: 'x' }), env)).status, 405);
  assert.equal((await handle(req('latest.json', { method: 'DELETE' }), env)).status, 405);
  assert.equal((await handle(req('iris-face-v2.98.0.zip.sha256.sig'), env)).status, 200);
});
