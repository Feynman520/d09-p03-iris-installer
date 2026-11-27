// IRIS Doctor — 검진표의 모양과 글. 순수 함수만(파일 · 통신 접촉 없음).
//
// 검진 항목 하나(finding):
//   { id, group, title, state, summary, detail?, checkedAt, dataAt?, source?, skipped?, fix? }
//   state   = 'ok' 정상 | 'warn' 주의 | 'bad' 고장 | 'unknown' 모름 | 'skipped' 건너뜀
//   summary = 사람이 읽는 한 줄(열쇠 값 · 이메일 · 로그 원문을 싣지 않는다)
//   dataAt  = 그 판단의 근거 자료가 만들어진 때(낡은 기록과 지금 상태를 구별하려고)
//   source  = 어디를 보고 판단했는지(주소 · 파일 종류의 이름)
//   fix     = 알려진 기계 처방의 이름(있을 때만 — 걸음 ④에서 채운다)
import os from 'node:os';

export const FORMAT = 1;          // 검진표 형식 판(바뀌면 올린다 — 읽는 쪽이 대조)
export const STATES = ['ok', 'warn', 'bad', 'unknown', 'skipped'];
export const STATE_KO = { ok: '정상', warn: '주의', bad: '고장', unknown: '모름', skipped: '건너뜀' };
const RANK = { bad: 4, warn: 3, unknown: 2, skipped: 1, ok: 0 };

export const GROUPS = [
  ['relay', '중계기'],
  ['keys', '열쇠'],
  ['window', '창'],
  ['programs', '프로그램'],
  ['wiring', '연결 설정'],
  ['resume', '다시 열기 · 시작'],
  ['network', '망'],
  ['resources', '자원'],
  ['update', '업데이트 흔적'],
  ['doctor', 'Doctor 준비'],
];

/** 항목 하나를 만든다. state 가 목록 밖이면 'unknown' 으로 둔다(잘못 만든 검사가 '정상'으로 보이지 않게). */
export function finding(id, group, title, state, summary, extra = {}) {
  // 모든 글 칸을 한 번 거른다 — 검사 코드가 바깥 글을 실수로 실어도 항목 이름 · 제목 · 까닭 · 시각으로 새지 않게.
  const f = {
    id: String(id).toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 60) || 'unknown',
    group: GROUPS.some(([g]) => g === group) ? group : 'doctor',
    title: clean(title).slice(0, 80),
    state: STATES.includes(state) ? state : 'unknown',
    summary: clean(summary),
  };
  if (extra.detail !== undefined && extra.detail !== null) { const d = [].concat(extra.detail).map(clean).filter(Boolean).slice(0, 10); if (d.length) f.detail = d; }
  if (extra.dataAt !== undefined && extra.dataAt !== null) { const t = new Date(typeof extra.dataAt === 'number' ? extra.dataAt : String(extra.dataAt)); if (!Number.isNaN(t.getTime())) f.dataAt = t.toISOString(); } // 시각 모양이 아니면 싣지 않는다
  if (extra.source) f.source = clean(extra.source).slice(0, 60);
  if (extra.skipped) f.skipped = clean(extra.skipped).slice(0, 120);
  if (extra.fix && /^[a-z0-9-]{1,40}$/.test(String(extra.fix))) f.fix = String(extra.fix);
  return f;
}

/** 이름 가리기: 이메일은 앞 두 글자만, 그 밖의 이름은 그대로(codex-1 · google-2 같은 것). */
export function maskName(name) {
  const s = String(name ?? '');
  const at = s.indexOf('@');
  if (at > 0) return `${s.slice(0, Math.min(2, at))}…@…`;
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** 경로 가리기: 사용자 폴더는 ~ 로. */
export function maskPath(p, home = os.homedir()) {
  const s = String(p ?? '');
  if (home && s.toLowerCase().startsWith(home.toLowerCase())) return `~${s.slice(home.length)}`;
  return s;
}

// 글에 섞여 들어온 비밀 모양을 마지막에 한 번 더 지운다(검사 코드가 실수로 실어도 새지 않게 — 보조 방어).
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,                 // 클로드 열쇠 모양
  /\bsk-[A-Za-z0-9_-]{20,}/g,                  // API 키 모양
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,             // 이메일
  /\b(?:Bearer|token|secret|password)[=: ]+[A-Za-z0-9._~+/-]{12,}/gi,
  /[A-Za-z0-9_+/=-]{32,}/g,                      // 길게 이어진 글자 덩어리(임의 열쇠 모양)
];
// 주소는 앞부분(https://이름:포트)만 남긴다 — 길 · 쿼리에 열쇠가 섞일 수 있다. 일반 문장의 물음표는 건드리지 않는다.
const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const originOnly = (u) => { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return '(주소 가림)'; } };
export function clean(text) {
  let s = String(text ?? '');
  const kept = [];
  s = s.replace(URL_RE, (u) => { kept.push(originOnly(u)); return `\u0000${kept.length - 1}\u0000`; }); // 주소 앞부분은 아래 가림 규칙에서 빼 둔다(긴 서버 이름이 잘리지 않게)
  for (const re of SECRET_PATTERNS) s = s.replace(re, '(가림)');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)] ?? '');
  return s.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 300);
}

export function worstOf(findings) {
  let w = 'ok';
  for (const f of findings) if ((RANK[f.state] ?? 2) > RANK[w]) w = f.state;
  return w;
}

export function countStates(findings) {
  const c = { ok: 0, warn: 0, bad: 0, unknown: 0, skipped: 0 };
  for (const f of findings) c[f.state] = (c[f.state] || 0) + 1;
  return c;
}

/** 시각을 이 PC 의 시간대로(검진표 안의 자료는 UTC 글이나 숫자로 들어온다). 읽지 못하면 받은 글 그대로. */
export function localStamp(v) {
  const d = new Date(typeof v === 'number' ? v : String(v));
  if (Number.isNaN(d.getTime())) return String(v ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 사람이 읽는 검진표(터미널 글). 색은 쓰지 않는다(어느 콘솔에서나 같게). */
export function renderText(report) {
  const out = [];
  const c = report.summary;
  out.push(`IRIS Doctor 검진표 — ${localStamp(report.finishedAt)} (${report.mode === 'offline' ? '통신 없이' : '바깥 연결 확인 포함'} · ${report.layout === 'installed' ? '설치본' : '개발 PC'})`);
  out.push(`정상 ${c.ok} · 주의 ${c.warn} · 고장 ${c.bad} · 모름 ${c.unknown} · 건너뜀 ${c.skipped}`);
  for (const [gid, gname] of GROUPS) {
    const list = report.findings.filter((f) => f.group === gid);
    if (!list.length) continue;
    out.push('');
    out.push(`[${gname}]`);
    for (const f of list) {
      const when = f.dataAt ? ` (자료 ${localStamp(f.dataAt)})` : '';
      out.push(`  ${STATE_KO[f.state].padEnd(3, ' ')} | ${f.title} — ${f.summary}${when}`);
      for (const d of f.detail || []) out.push(`         · ${d}`);
      if (f.skipped) out.push(`         · 건너뛴 까닭: ${f.skipped}`);
      if (f.state !== 'ok' && f.source) out.push(`         · 본 곳: ${f.source}`); // 정상이 아닌 항목은 무엇을 보고 판단했는지도 보인다
    }
  }
  return out.join('\n') + '\n';
}
