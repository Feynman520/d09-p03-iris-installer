// IRIS Doctor — 윈도우가 믿는 인증서를 Doctor 가 띄우는 Node 도 믿게 한다.
//
// 학교 · 회사 망의 보안장비 가운데는 HTTPS 를 중간에서 열어 보면서 인증서를 자기 기관 것으로 바꿔 끼우는 것이 있다.
// 그 기관 인증서는 윈도우 인증서 목록에 들어 있어 브라우저 · 클로드 · 코덱스 프로그램은 통과하지만, Node 는 기본으로 자기 내장 목록만 본다.
// 그대로 두면 그런 망에서 검진의 「인터넷」 묶음이 늘 '인증서를 믿을 수 없음'이 된다(IRIS 는 멀쩡한데 검진표만 주의).
//
// 처방 = 내장 목록은 그대로 두고 윈도우 목록을 **더한다**(브라우저와 같은 신뢰 범위 · 빼는 것 없음). 설치 패키지의 설치기 · 중계기와 같은 방식이다.
//   ① 이 프로세스: tls.setDefaultCACertificates(내장 + 윈도우) — fetch 도 이 기본값을 쓴다.
//   ② 자식 프로세스(검진 일꾼 · 에이전트 직통 실행): NODE_USE_SYSTEM_CA=1 — **비어 있을 때만** 채운다(사용자가 정한 값은 덮지 않는다).
//      옛 Node 는 모르는 변수를 무시하므로 판이 낮아도 시작이 막히지 않는다.
//   명령줄 플래그 `--use-system-ca` 와 NODE_OPTIONS 는 쓰지 않는다 — 옛 Node 는 그 플래그에서 시작을 거부하고,
//   클로드 프로그램은 NODE_OPTIONS 의 그 플래그를 「윈도우 목록만」으로 읽어 내장 목록을 뺀다.
//
// 실패해도 절대 던지지 않는다(먹통일 때도 Doctor 는 떠야 한다) — 결과만 돌려준다. 통신 0 · 파일 쓰기 0.
import nodeTls from 'node:tls';

export const SYSTEM_CA_ENV = 'NODE_USE_SYSTEM_CA';
// Doctor 가 스스로 채웠다는 표시 — 검진의 "시스템 인증서를 쓰도록 설정돼 있음"(이 PC 의 환경을 알리는 글)이 Doctor 자신이 채운 값을 사용자 설정으로 읽지 않게.
// 시작 파일(IRIS Doctor.cmd)도 같은 이름으로 표시한다.
export const FILLED_ENV = 'IRIS_DOCTOR_CA_FILLED';

/**
 * trustSystemRoots({ tls, env }) → { ok, applied, bundled, system, added, envSet, reason? }
 *   tls · env 는 시험에서 바꿔 끼운다. 옛 Node(목록을 읽고 쓰는 함수가 없음)면 조용히 건너뛴다(reason: 'node-too-old').
 */
export function trustSystemRoots({ tls = nodeTls, env = process.env } = {}) {
  const out = { ok: false, applied: false, bundled: 0, system: 0, added: 0, envSet: false };
  try {
    if (env && (env[SYSTEM_CA_ENV] == null || env[SYSTEM_CA_ENV] === '')) {
      env[SYSTEM_CA_ENV] = '1';
      env[FILLED_ENV] = '1';
      out.envSet = true;
    }
  } catch { /* 환경이 읽기 전용이어도 넘어간다 */ }
  try {
    if (typeof tls?.getCACertificates !== 'function' || typeof tls?.setDefaultCACertificates !== 'function') return { ...out, reason: 'node-too-old' };
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
  } catch {
    return { ...out, reason: 'failed' }; // 오류의 원문은 싣지 않는다
  }
}
