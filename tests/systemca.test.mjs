// 2.0.62 (2026-11-12 school network report): security gear re-signed claude.ai with an agency
// certificate that Windows trusts but Node's bundled list does not, so the installer said
// "blocked". These tests keep that from coming back:
//   - trustSystemRoots adds the Windows store on top of the bundled roots (removes nothing),
//     fills NODE_USE_SYSTEM_CA only when empty, never throws;
//   - fetch really follows the new default (local HTTPS server signed by a test CA that no
//     store trusts: fails before, passes after the CA is offered as a "system" root);
//   - probeHost/checkNet tell "certificate replaced" apart from "blocked";
//   - the relay manage script and bootstrap carry the env line; the updater has its own copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { trustSystemRoots, tlsTrustCode, SYSTEM_CA_ENV } from '../installer/lib/systemca.mjs';
import { trustSystemRoots as updaterTrust } from '../updater/agents.mjs';
import { probeHost, checkNet, RESUME_SENTENCE } from '../installer/lib/online.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'tls-intercept');
const TEST_CA = fs.readFileSync(path.join(FIX, 'ca.pem'), 'utf8');

function fakeTls({ bundled = ['B1', 'B2'], system = ['B2', 'S1', 'S2'] } = {}) {
  const calls = [];
  return {
    calls,
    getCACertificates: (kind) => (kind === 'system' ? system : bundled),
    setDefaultCACertificates: (list) => calls.push(list),
  };
}

test('trustSystemRoots adds Windows roots on top of the bundled list, deduplicated', () => {
  const t = fakeTls();
  const env = {};
  const r = trustSystemRoots({ tls: t, env });
  assert.equal(r.ok, true);
  assert.equal(r.applied, true);
  assert.equal(r.added, 2);
  assert.deepEqual(t.calls, [['B1', 'B2', 'S1', 'S2']]);
  assert.equal(env[SYSTEM_CA_ENV], '1');
  assert.equal(r.envSet, true);
});

test('trustSystemRoots never overrides a value the user already set, and never throws', () => {
  const env = { NODE_USE_SYSTEM_CA: '0' };
  const r = trustSystemRoots({ tls: fakeTls(), env });
  assert.equal(env.NODE_USE_SYSTEM_CA, '0');
  assert.equal(r.envSet, false);
  const old = trustSystemRoots({ tls: {}, env: {} });
  assert.equal(old.ok, false);
  assert.equal(old.reason, 'node-too-old');
  const broken = trustSystemRoots({ tls: { getCACertificates: () => { throw new Error('store read failed'); }, setDefaultCACertificates() {} }, env: {} });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /store read failed/);
});

test('trustSystemRoots with nothing new leaves the default untouched', () => {
  const t = fakeTls({ bundled: ['A'], system: ['A'] });
  const r = trustSystemRoots({ tls: t, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.applied, false);
  assert.equal(t.calls.length, 0);
});

test('the updater copy follows the same rule', () => {
  const t = fakeTls();
  const env = {};
  assert.deepEqual(updaterTrust({ tls: t, env }), { ok: true, added: 2 });
  assert.deepEqual(t.calls, [['B1', 'B2', 'S1', 'S2']]);
  assert.equal(env.NODE_USE_SYSTEM_CA, '1');
  const env2 = { NODE_USE_SYSTEM_CA: '0' };
  updaterTrust({ tls: fakeTls(), env: env2 });
  assert.equal(env2.NODE_USE_SYSTEM_CA, '0');
  assert.deepEqual(updaterTrust({ tls: {}, env: {} }), { ok: false, added: 0 });
});

test('tlsTrustCode finds the certificate code on fetch errors (cause chain) and ignores others', () => {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
  assert.equal(tlsTrustCode(e), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  assert.equal(tlsTrustCode(Object.assign(new Error('x'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })), 'SELF_SIGNED_CERT_IN_CHAIN');
  const refused = new TypeError('fetch failed');
  refused.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.equal(tlsTrustCode(refused), null);
  assert.equal(tlsTrustCode(null), null);
});

test('real fetch: an intercepted host fails as "certificate replaced", then passes once Windows-style trust is added', async () => {
  const srv = https.createServer({
    key: fs.readFileSync(path.join(FIX, 'server.key')),
    cert: fs.readFileSync(path.join(FIX, 'server.pem')),
  }, (req, res) => { res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${srv.address().port}/`;
  try {
    const before = await probeHost(url, { env: {}, timeoutMs: 5000 });
    assert.equal(before.reachable, false);
    assert.ok(before.tlsCode, `expected a certificate code, got: ${before.error}`);
    // The test CA plays the agency certificate that only the Windows store holds.
    const asWindows = {
      getCACertificates: (kind) => (kind === 'system' ? [TEST_CA] : tls.getCACertificates(kind)),
      setDefaultCACertificates: (list) => tls.setDefaultCACertificates(list),
    };
    const r = trustSystemRoots({ tls: asWindows, env: {} });
    assert.equal(r.applied, true);
    const after = await probeHost(url, { env: {}, timeoutMs: 5000 });
    assert.equal(after.reachable, true, after.error);
    assert.equal(after.status, 200);
  } finally {
    srv.close();
  }
});

test('checkNet: intercepted hosts get their own sentence; plain blocks keep the old message', async () => {
  const probe = async (url) => (url.includes('claude.ai/') && !url.includes('downloads')
    ? { reachable: false, tlsCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }
    : { reachable: true, status: 200 });
  const net = await checkNet({ subscriptions: ['claude'], probe, env: {} });
  assert.equal(net.ok, false);
  assert.deepEqual(net.intercepted, ['claude.ai']);
  assert.match(net.message, /claude\.ai 주소는 중간에서 보안 인증서가 바뀌어/);
  assert.ok(net.message.endsWith(RESUME_SENTENCE));
  assert.equal(net.results.find((x) => x.host === 'claude.ai').tlsCode, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');

  const plainProbe = async (url) => (url.includes('chatgpt') ? { reachable: false } : { reachable: true, status: 200 });
  const plain = await checkNet({ subscriptions: ['chatgpt'], probe: plainProbe, env: {} });
  assert.equal(plain.ok, false);
  assert.deepEqual(plain.intercepted, []);
  assert.equal(plain.message, `chatgpt.com 주소에 연결하지 못했습니다. ${RESUME_SENTENCE}`);
});

test('relay manage script and bootstrap fill NODE_USE_SYSTEM_CA only when empty (and the relay restores it)', () => {
  const manage = fs.readFileSync(path.join(ROOT, 'patches', 'teamclaude', 'teamclaude-manage.ps1'), 'utf8');
  assert.match(manage, /if \(-not \$env:NODE_USE_SYSTEM_CA\) \{ \$env:NODE_USE_SYSTEM_CA = '1' \}/);
  assert.match(manage, /\$env:NODE_USE_SYSTEM_CA = \$priorSystemCa/);
  assert.ok(manage.indexOf("$env:NODE_USE_SYSTEM_CA = '1'") < manage.indexOf('Start-Process -FilePath $nodePath'));
  assert.ok(!/use-system-ca/.test(manage.replace(/^\s*#.*$/gm, '')), 'no --use-system-ca flag (older Node refuses to start)');
  const boot = fs.readFileSync(path.join(ROOT, 'installer', 'bootstrap.ps1'), 'utf8');
  assert.match(boot, /if \(-not \$env:NODE_USE_SYSTEM_CA\) \{ \$env:NODE_USE_SYSTEM_CA = '1' \}/);
  assert.ok(boot.indexOf("$env:NODE_USE_SYSTEM_CA = '1'") < boot.indexOf('$proc = Start-Process -FilePath $nodeExe'));
  for (const f of [manage, boot]) assert.equal(Buffer.from(f).findIndex((b) => b > 0x7f), -1, 'ps1 stays ASCII');
});
