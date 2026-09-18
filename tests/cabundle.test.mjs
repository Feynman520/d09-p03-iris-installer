// installer/lib/cabundle.mjs — 코덱스용 CA 번들(공인 루트 + TeamClaude CA), 설계 A' 조각 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {
  buildCaBundle, bundleCovers, writeCaBundle, isPemCertificate, CA_FILE, BUNDLE_FILE, BUNDLE_HEADER,
} from '../installer/lib/cabundle.mjs';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBteamclaudeCA000000000000000000000000000000000000000000000000\n-----END CERTIFICATE-----\n';
const CA2 = '-----BEGIN CERTIFICATE-----\nMIIBteamclaudeCA111111111111111111111111111111111111111111111111\n-----END CERTIFICATE-----\n';
const ROOTS = ['-----BEGIN CERTIFICATE-----\nMIIBroot1\n-----END CERTIFICATE-----', '-----BEGIN CERTIFICATE-----\nMIIBroot2\n-----END CERTIFICATE-----\n'];

function tmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `iris-cabundle-${label}-`));
  return d;
}

test('buildCaBundle: 머리말 + 루트 전부 + CA 가 마지막, PEM 이 아니면 거절', () => {
  const b = buildCaBundle(CA, ROOTS);
  assert.ok(b.startsWith(BUNDLE_HEADER));
  assert.equal((b.match(/-----BEGIN CERTIFICATE-----/g) || []).length, 3);
  assert.ok(b.trimEnd().endsWith(CA.trim()), 'CA 는 마지막');
  assert.ok(bundleCovers(b, CA));
  assert.ok(!bundleCovers(b, CA2));
  assert.throws(() => buildCaBundle('not a cert', ROOTS), /not a PEM certificate/);
  assert.ok(isPemCertificate(CA));
  assert.ok(!isPemCertificate('-----BEGIN CERTIFICATE-----\n'));
});

test('buildCaBundle: 기본 루트 목록은 Node 내장 루트(SSL_CERT_FILE 이 시스템 목록을 대체하므로 전부 들어가야 한다)', () => {
  const b = buildCaBundle(CA);
  assert.equal((b.match(/-----BEGIN CERTIFICATE-----/g) || []).length, tls.rootCertificates.length + 1);
});

test('writeCaBundle: CA 가 없으면 no-ca, 있으면 만들고, 같은 CA 면 멱등, CA 가 바뀌면 갱신', () => {
  const dir = tmp('write');
  assert.deepEqual(writeCaBundle(dir, { roots: ROOTS }).ok, false);
  assert.equal(writeCaBundle(dir, { roots: ROOTS }).reason, 'no-ca');

  fs.writeFileSync(path.join(dir, CA_FILE), CA);
  const first = writeCaBundle(dir, { roots: ROOTS });
  assert.equal(first.ok, true); assert.equal(first.changed, true); assert.equal(first.roots, 2);
  const text = fs.readFileSync(path.join(dir, BUNDLE_FILE), 'utf8');
  assert.ok(bundleCovers(text, CA));

  const second = writeCaBundle(dir, { roots: ROOTS });
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(path.join(dir, BUNDLE_FILE), 'utf8'), text, '건드리지 않는다');

  fs.writeFileSync(path.join(dir, CA_FILE), CA2);   // 중계기가 CA 를 다시 만든 경우
  const third = writeCaBundle(dir, { roots: ROOTS });
  assert.equal(third.changed, true);
  const t3 = fs.readFileSync(path.join(dir, BUNDLE_FILE), 'utf8');
  assert.ok(bundleCovers(t3, CA2) && !bundleCovers(t3, CA));
  fs.rmSync(dir, { recursive: true, force: true });
});
