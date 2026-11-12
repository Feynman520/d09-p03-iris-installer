// 윈도우가 믿는 인증서를 Node 도 믿게 한다 — 2.0.62(2026-11-12 다른 지역 학교 선생님 PC 신고).
//
// 학교·회사 보안장비 가운데는 claude.ai 같은 주소의 HTTPS 를 중간에서 열어 검사하면서 인증서를
// 자기 기관 인증서로 바꿔 끼우는 것이 있다(그날 실측: 교육청 보안 인증서가 claude.ai 4곳에 끼워짐).
// 그 기관 인증서는 윈도우 인증서 목록에 미리 들어가 있어 브라우저·클로드코드(claude.exe 는 기본값이
// 「내장 + 윈도우」)·코덱스(윈도우 목록을 읽음)는 통과하지만, Node 는 기본으로 **자기 내장 목록만**
// 보므로 설치기의 접속 확인·내려받기와 중계기(TeamClaude)가 "인증서를 믿을 수 없음"으로 실패했다.
//
// 처방 = 내장 목록은 그대로 두고 윈도우 목록을 **더한다**(브라우저와 같은 신뢰 범위, 빼는 것 없음).
//   ① 이 프로세스: tls.setDefaultCACertificates(내장 + 윈도우)  — fetch 도 이 기본값을 쓴다(실측).
//   ② 자식 프로세스: NODE_USE_SYSTEM_CA=1 (비어 있을 때만 채움 — 사용자가 정한 값은 덮지 않는다).
//      옛 Node 는 모르는 변수를 무시하므로 판이 낮아도 시작이 막히지 않는다. 명령줄 플래그
//      `--use-system-ca` 와 NODE_OPTIONS 는 쓰지 않는다 — 옛 Node 는 플래그에서 시작을 거부하고,
//      claude.exe 는 NODE_OPTIONS 의 그 플래그를 「윈도우 목록만」으로 읽어 내장 목록을 뺀다.
//
// 실패해도 절대 던지지 않는다(설치를 막지 않음) — 결과만 돌려준다.
import nodeTls from 'node:tls';

export const SYSTEM_CA_ENV = 'NODE_USE_SYSTEM_CA';

/**
 * trustSystemRoots({ tls, env }) -> { ok, applied, bundled, system, added, envSet, reason? }
 *   tls / env 는 시험에서 바꿔 끼운다.
 */
export function trustSystemRoots({ tls = nodeTls, env = process.env } = {}) {
  const out = { ok: false, applied: false, bundled: 0, system: 0, added: 0, envSet: false };
  try {
    if (env && (env[SYSTEM_CA_ENV] == null || env[SYSTEM_CA_ENV] === '')) {
      env[SYSTEM_CA_ENV] = '1';
      out.envSet = true;
    }
  } catch { /* env 가 읽기 전용이어도 진행 */ }
  if (typeof tls?.getCACertificates !== 'function' || typeof tls?.setDefaultCACertificates !== 'function') {
    return { ...out, reason: 'node-too-old' };
  }
  try {
    const current = Array.from(tls.getCACertificates('default') ?? [], String);
    const system = Array.from(tls.getCACertificates('system') ?? [], String);
    out.bundled = current.length;
    out.system = system.length;
    const seen = new Set(current.map((c) => c.trim()));
    const extra = system.filter((c) => { const k = c.trim(); if (seen.has(k)) return false; seen.add(k); return true; });
    out.added = extra.length;
    if (extra.length > 0) {
      tls.setDefaultCACertificates([...current, ...extra]);
      out.applied = true;
    }
    out.ok = true;
    return out;
  } catch (err) {
    return { ...out, reason: String(err?.message ?? err) };
  }
}

// Node 가 인증서를 믿지 못해 연결을 끊을 때 내는 오류 부호(보안장비가 인증서를 바꿔 끼운 경우가 대표).
export const TLS_TRUST_CODES = Object.freeze([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** fetch 오류(또는 그 cause)가 「인증서를 믿을 수 없음」인가 → 그 부호, 아니면 null. */
export function tlsTrustCode(err) {
  for (let e = err, i = 0; e && i < 4; e = e.cause, i++) {
    const code = e?.code;
    if (typeof code === 'string' && TLS_TRUST_CODES.includes(code)) return code;
  }
  return null;
}
