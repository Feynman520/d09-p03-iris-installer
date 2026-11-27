// installer/lib/online.mjs relayHealth -- "is the thing on the relay port our
// relay, and how many accounts did it load".
//
// Why this file exists (2026-11-27 code review, then reproduced here): the
// status body was collected with `if (body.length < 8192) body += d`, i.e. it
// stopped adding once about 8 KB had arrived. The status answer is about
// 2.3 KB plus about 1 KB per account, so from roughly five accounts on it no
// longer fits; when such an answer arrives in several pieces the tail is
// dropped, the JSON no longer parses, and a perfectly healthy relay is
// reported as "not our relay" -- 「계정 연결」 then fails on that PC.
//
// Every server here is a throwaway on a free loopback port. Nothing touches
// the real relay port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { relayHealth } from '../installer/lib/online.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A status body shaped like the relay's, padded per account to a real-life size.
function statusBody(accountCount, bytesPerAccount = 1050) {
  const accounts = Array.from({ length: accountCount }, (_, i) => ({
    name: `account-${i + 1}`, type: 'oauth', provider: i % 2 ? 'codex' : 'anthropic', status: 'active',
    auth: { state: 'ok', check: null }, pad: 'x'.repeat(Math.max(0, bytesPerAccount - 140)),
  }));
  return JSON.stringify({ accounts, activity: [], google: { supported: true, halt: null }, server: { version: '1.1.16' } });
}

// Serve `handler(req, res)` on a free loopback port for the duration of `fn`.
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await fn(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

// Write `body` in `pieceBytes` pieces with a pause between them, so the client
// really receives it as several chunks (one write on loopback can arrive whole).
function drip(res, body, { pieceBytes, pauseMs, headers = { 'content-type': 'application/json' }, status = 200 }) {
  res.writeHead(status, headers);
  const buf = Buffer.from(body, 'utf8');
  let at = 0;
  const next = () => {
    if (res.destroyed) return;
    if (at >= buf.length) { res.end(); return; }
    res.write(buf.subarray(at, at + pieceBytes));
    at += pieceBytes;
    setTimeout(next, pauseMs);
  };
  next();
}

test('reproduction: a 20 KB status answer arriving in several pieces is a healthy relay with all its accounts', async () => {
  const body = statusBody(20); // about 20 KB -- a relay with many accounts
  assert.ok(Buffer.byteLength(body) > 20_000 && Buffer.byteLength(body) < 23_000, `fixture size ${Buffer.byteLength(body)}`);
  await withServer((req, res) => {
    assert.equal(req.url, '/teamclaude/status');
    drip(res, body, { pieceBytes: 3000, pauseMs: 15 });
  }, async (port) => {
    const health = await relayHealth(port, { timeoutMs: 3000 });
    assert.deepEqual(health, { ok: true, status: 200, liveAccounts: 20 });
  });
});

test('the same answer split in the middle of a multi-byte character still parses', async () => {
  const base = JSON.parse(statusBody(9));
  base.accounts[0].displayName = '한글 이름 '.repeat(400); // 3-byte characters across piece borders
  const body = JSON.stringify(base);
  await withServer((req, res) => drip(res, body, { pieceBytes: 1000, pauseMs: 2 }), async (port) => {
    const health = await relayHealth(port, { timeoutMs: 3000 });
    assert.deepEqual(health, { ok: true, status: 200, liveAccounts: 9 });
  });
});

// ---- the verdicts that must NOT change --------------------------------------

test('unchanged: a small answer in one piece -> ok with the account count; "activity" alone is enough', async () => {
  await withServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(statusBody(2)); }, async (port) => {
    assert.deepEqual(await relayHealth(port), { ok: true, status: 200, liveAccounts: 2 });
  });
  await withServer((req, res) => { res.writeHead(200); res.end(JSON.stringify({ activity: [] })); }, async (port) => {
    assert.deepEqual(await relayHealth(port), { ok: true, status: 200, liveAccounts: null });
  });
});

test('unchanged: something else on the port (HTML, other JSON, a non-200 status) is not our relay', async () => {
  await withServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hello</html>'); }, async (port) => {
    assert.deepEqual(await relayHealth(port), { ok: false, status: 200 });
  });
  await withServer((req, res) => { res.writeHead(200); res.end(JSON.stringify({ name: 'some other tool' })); }, async (port) => {
    const h = await relayHealth(port);
    assert.equal(h.ok, false); assert.equal(h.status, 200);
  });
  await withServer((req, res) => { res.writeHead(503); res.end(statusBody(1)); }, async (port) => {
    const h = await relayHealth(port);
    assert.equal(h.ok, false); assert.equal(h.status, 503);
  });
});

test('unchanged: nothing listening -> { ok: false, status: null }', async () => {
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port;
  await new Promise((r) => s.close(r)); // a port that was free a moment ago
  assert.deepEqual(await relayHealth(port, { timeoutMs: 1000 }), { ok: false, status: null });
});

test('unchanged: a server that accepts and then says nothing -> timeout -> { ok: false, status: null }', async () => {
  await withServer(() => { /* never answers */ }, async (port) => {
    const t0 = Date.now();
    assert.deepEqual(await relayHealth(port, { timeoutMs: 300 }), { ok: false, status: null });
    assert.ok(Date.now() - t0 < 3000, 'the time limit did not hold');
  });
});

// ---- the limits that stay in place ------------------------------------------

test('limit: an answer past 1 MB is refused without being read to the end', async () => {
  let written = 0;
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const piece = Buffer.alloc(64 * 1024, 0x20); // endless whitespace: never valid, never ends
    const pump = () => {
      if (res.destroyed) return;
      written += piece.length;
      if (res.write(piece)) setImmediate(pump); else res.once('drain', pump);
    };
    res.on('error', () => {});
    pump();
  }, async (port) => {
    const t0 = Date.now();
    const h = await relayHealth(port, { timeoutMs: 3000 });
    assert.equal(h.ok, false);
    assert.equal(h.status, 200);
    assert.ok(Date.now() - t0 < 5000, 'an endless answer must be cut off, not waited for');
    await delay(50);
    assert.ok(written < 64 * 1024 * 1024, `the server was allowed to send ${written} bytes`);
  });
});

test('limit: an answer that drips slowly forever is cut off by the overall time limit', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const tick = setInterval(() => { if (res.destroyed) clearInterval(tick); else res.write(' '); }, 40); // each piece well inside the idle limit
    res.on('close', () => clearInterval(tick));
    res.on('error', () => {});
  }, async (port) => {
    const t0 = Date.now();
    const h = await relayHealth(port, { timeoutMs: 300, totalTimeoutMs: 700 });
    assert.equal(h.ok, false);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  });
});

test('limit: an answer cut off in the middle resolves (does not hang) as not ok', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
    res.write(statusBody(1).slice(0, 300));
    setTimeout(() => res.destroy(), 30);
  }, async (port) => {
    const h = await Promise.race([relayHealth(port, { timeoutMs: 2000 }), delay(4000).then(() => 'hung')]);
    assert.notEqual(h, 'hung', 'relayHealth never resolved');
    assert.equal(h.ok, false);
  });
});
