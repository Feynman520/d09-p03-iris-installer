// 검진 묶음: 중계기(IRIS Gate). 읽기만 — 상태 주소 한 번 + 중계기가 남긴 기록 파일들.
import path from 'node:path';
import { finding, maskName } from '../report.mjs';
import { sharedPs } from '../context.mjs';

const G = 'relay';
const HOUR = 3600_000;

// 계정 하나가 "지금 실제로 쓸 수 있는가": 순환에 들어 있고(active) 로그인 판정이 정상(또는 곧 만료)일 때만.
const usable = (a) => a && a.status === 'active' && ['ok', 'expiring', undefined].includes(a.auth?.state);
const PROVIDER_KO = { anthropic: '클로드', codex: '코덱스', google: '구글', other: '그 밖의' };
// 공급자 이름은 정해진 셋만 그대로 쓴다(항목 이름 · 제목에 바깥 글이 섞이지 않게) — 나머지는 '그 밖의'
const providerOf = (a) => { const p = a.provider || (a.type === 'codex' ? 'codex' : 'anthropic'); return ['anthropic', 'codex', 'google'].includes(p) ? p : 'other'; };
const AUTH_KO = { 'needs-login': '재로그인 필요', checking: '확인 중', expiring: '곧 만료', ok: '정상' };
const STATUS_KO = { active: '순환 중', error: '오류', disabled: '꺼짐', exhausted: '한도 소진', paused: '멈춤' };

const exeName = (v) => (/^[\w.-]{1,40}$/.test(String(v || '')) ? String(v) : '이름 모름'); // 실행 파일 이름은 정해진 글자만

/**
 * 포트 주인 판정(중계기 · 창이 함께 쓴다). 조회 실패 · 권한 없음 · 주인이 여럿이면 단정하지 않는다.
 * own = 파워셸 조회의 그 포트 줄 { error | listening, owners, pid, exe, canRead, isRelay, isFace, … }
 */
export function ownerFinding(id, group, title, ps, own, { port, up, offText, okText, is }) {
  const src = { source: '윈도우 프로세스 표' };
  if (ps?.error || !own) return finding(id, group, title, 'unknown', '포트 주인을 확인하지 못했습니다.', { ...src, skipped: ps?.error ? '파워셸 조회 실패' : '조회 결과에 그 포트가 없음' });
  if (own.error) return finding(id, group, title, 'unknown', '포트를 듣는 프로그램을 조회하지 못했습니다.', { ...src, skipped: '포트 조회 실패(권한 또는 조회 기능 없음)' });
  if (!own.listening) return finding(id, group, title, up ? 'unknown' : 'skipped', '그 포트를 듣는 프로그램이 없습니다.', { ...src, skipped: up ? '상태 주소는 답했는데 프로세스 표에는 없음' : offText });
  if (Number(own.owners) > 1) return finding(id, group, title, 'warn', `그 포트를 듣는 프로세스가 ${Number(own.owners)}개라 주인을 단정하지 못합니다.`, src);
  if (!own.canRead) return finding(id, group, title, 'unknown', `포트를 쓰는 프로세스(PID ${Number(own.pid)})의 실행 정보를 읽을 권한이 없습니다.`, src);
  if (/^node(\.exe)?$/i.test(String(own.exe || '')) && is(own)) return finding(id, group, title, 'ok', `${okText}(PID ${Number(own.pid)}).`, src);
  return finding(id, group, title, 'bad', `포트 ${port} 을 다른 프로그램(${exeName(own.exe)}, PID ${Number(own.pid)})이 쓰고 있습니다.`, src);
}

/** 중계기 기록 파일의 꼬리에서 줄 단위 JSON 을 뽑는다(깨진 첫 줄은 버린다). */
function tailEvents(ctx, suffix, maxBytes) {
  const t = ctx.readTail(ctx.relaySibling(suffix), maxBytes);
  if (!t) return null;
  const events = [];
  for (const line of t.text.split('\n')) { const s = line.trim(); if (s.startsWith('{')) { try { events.push(JSON.parse(s)); } catch {} } }
  return { events, mtime: t.mtime };
}

export async function checkRelay(ctx) {
  const out = [];
  const url = `http://127.0.0.1:${ctx.relayPort}/teamclaude/status`;
  const st = await ctx.localJson(url);
  const up = st.ok && st.body && Array.isArray(st.body.accounts);

  // 1) 켜져 있는가
  if (up) out.push(finding('relay.listening', G, '중계기가 켜져 있는가', 'ok', `켜져 있습니다(포트 ${ctx.relayPort}).`, { source: '중계기 상태 주소' }));
  else if (st.ok || st.status) out.push(finding('relay.listening', G, '중계기가 켜져 있는가', 'bad', `포트 ${ctx.relayPort} 이 답하지만 중계기의 답 모양이 아닙니다(HTTP ${st.status ?? '?'}).`, { source: '중계기 상태 주소' }));
  else out.push(finding('relay.listening', G, '중계기가 켜져 있는가', 'bad', st.kind === 'timeout' ? `포트 ${ctx.relayPort} 이 3초 안에 답하지 않습니다(멈춘 것으로 보임).` : `꺼져 있습니다(포트 ${ctx.relayPort} 에 아무도 없음).`, { source: '중계기 상태 주소', fix: st.kind === 'refused' ? 'relay-start' : undefined }));

  // 2) 그 포트의 주인이 우리 프로그램인가(포트 번호 · node 이름만으로 단정하지 않는다)
  const ps = await sharedPs(ctx);
  const own = ps?.owners?.find((o) => Number(o.port) === ctx.relayPort);
  out.push(ownerFinding('relay.owner', G, '포트 주인이 중계기인가', ps, own, { port: ctx.relayPort, up, offText: '중계기가 꺼져 있음', okText: '중계기 프로그램입니다', is: (o) => o.isRelay && !o.isDash }));

  // 3) 계정: 실제로 쓸 수 있는 계정이 있는가 — 켜져 있으면 지금 상태, 꺼져 있으면 마지막 기록(자료 시각을 붙인다)
  if (up) {
    const by = {};
    for (const a of st.body.accounts) { const p = providerOf(a); (by[p] ||= { total: 0, usable: 0, bad: [] }); by[p].total++; if (usable(a)) by[p].usable++; else by[p].bad.push(`${maskName(a.name)}: ${a.status !== 'active' && !['needs-login', 'checking'].includes(a.auth?.state) ? `순환에서 빠짐(${STATUS_KO[a.status] || '모름'})` : (AUTH_KO[a.auth?.state] || '모름')}`); }
    const total = st.body.accounts.length;
    if (!total) out.push(finding('relay.accounts', G, '쓸 수 있는 계정', 'bad', '중계기에 등록된 계정이 없습니다.', { source: '중계기 상태 주소' }));
    for (const [p, v] of Object.entries(by)) {
      const name = PROVIDER_KO[p] || p;
      const state = v.usable === 0 ? 'bad' : v.usable < v.total ? 'warn' : 'ok';
      out.push(finding(`relay.accounts.${p}`, G, `쓸 수 있는 ${name} 계정`, state, `${v.total}개 가운데 ${v.usable}개를 쓸 수 있습니다.`, { detail: v.bad.slice(0, 8), source: '중계기 상태 주소' }));
    }
    const credit = st.body.creditMode && typeof st.body.creditMode === 'object' && [...new Set(Object.entries(st.body.creditMode).filter(([, v]) => v).map(([k]) => PROVIDER_KO[k] || PROVIDER_KO.other))];
    if (credit?.length) out.push(finding('relay.credit', G, '크레딧으로 쓰는 중인가', 'warn', `${credit.join(' · ')} 가 요금제 몫이 아니라 충전 크레딧으로 돌고 있습니다.`, { source: '중계기 상태 주소' }));
  } else {
    const h = ctx.readJson(ctx.relaySibling('auth-health.json'));
    const s = h?.value?.summary;
    if (!s) out.push(finding('relay.accounts', G, '쓸 수 있는 계정', 'unknown', '중계기가 꺼져 있고 마지막 계정 기록도 읽지 못했습니다.', { source: '중계기 건강 기록' }));
    else {
      const need = Number(s.needsLogin || 0);
      out.push(finding('relay.accounts', G, '쓸 수 있는 계정(마지막 기록)', need ? 'warn' : 'unknown', `마지막 기록: 정상 ${s.ok ?? 0} · 확인 중 ${s.checking ?? 0} · 재로그인 필요 ${need} · 곧 만료 ${s.expiring ?? 0} — 중계기가 꺼져 있어 지금 상태는 모릅니다.`, { dataAt: h.value.updatedAt || h.mtime, source: '중계기 건강 기록' }));
    }
  }

  // 4) 켜기를 막은 검사가 있는가(시작 가드)
  const g = ctx.readJson(ctx.relaySibling('guard-status.json'));
  if (!g) out.push(finding('relay.guard', G, '켜기를 막은 검사', 'skipped', '시작 검사 기록이 없습니다.', { skipped: '이 PC 에는 시작 검사가 없거나 아직 돈 적이 없음', source: '시작 검사 기록' }));
  else if (g.value.blocksStart) out.push(finding('relay.guard', G, '켜기를 막은 검사', 'bad', `시작 검사가 중계기 켜기를 막았습니다(실패 ${(g.value.proxy?.failed || []).length}건).`, { detail: [...new Set((g.value.proxy?.failed || []).map((f) => String(f?.file || '')).filter((n) => /^[\w.-]{1,60}$/.test(n)))].slice(0, 5).map((n) => `실패한 검사 파일: ${n}`), dataAt: g.value.checkedAt || g.mtime, source: '시작 검사 기록' }));
  else if ((g.value.display?.failed || []).length) out.push(finding('relay.guard', G, '켜기를 막은 검사', 'warn', `화면 검사 ${(g.value.display.failed).length}건이 실패했습니다(켜지는 데는 지장 없음).`, { dataAt: g.value.checkedAt || g.mtime, source: '시작 검사 기록' }));
  else out.push(finding('relay.guard', G, '켜기를 막은 검사', 'ok', '마지막 시작 검사는 모두 통과했습니다.', { dataAt: g.value.checkedAt || g.mtime, source: '시작 검사 기록' }));

  // 5) 마지막 시작 기록의 오류(원문은 싣지 않고 종류만)
  const sv = ctx.readJson(ctx.relaySibling('server.json'));
  const errLog = sv?.value?.stderr && path.isAbsolute(String(sv.value.stderr)) ? ctx.readTail(String(sv.value.stderr), 8 * 1024) : null;
  if (!sv) out.push(finding('relay.startlog', G, '마지막 시작 기록', 'skipped', '시작 기록이 없습니다.', { skipped: '관리 스크립트로 켠 적이 없음', source: '중계기 시작 기록' }));
  else if (!errLog) out.push(finding('relay.startlog', G, '마지막 시작 기록', 'unknown', '오류 기록 파일을 읽지 못했습니다(없거나 자리를 알 수 없음).', { dataAt: sv.value.startedAt || sv.mtime, source: '중계기 시작 기록' })); // 못 읽은 것을 "오류 없음"으로 적지 않는다
  else {
    const t = errLog.text;
    const kinds = [];
    if (/EADDRINUSE/.test(t)) kinds.push('포트가 이미 쓰이고 있음');
    if (/EACCES|EPERM/.test(t)) kinds.push('권한 거부');
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(t)) kinds.push('프로그램 파일 누락');
    if (/SyntaxError/.test(t)) kinds.push('프로그램 파일 손상(문법 오류)');
    if (/ENOENT/.test(t)) kinds.push('필요한 파일 없음');
    if (/certificate|CERT_/i.test(t)) kinds.push('인증서 오류');
    const lines = t.split('\n').filter((l) => l.trim()).length;
    const serious = kinds.some((k) => /누락|손상|이미 쓰이고/.test(k));
    // 알려진 고장 종류가 없고 중계기가 켜져 있으면 '정상' — 오류 기록에는 평소의 알림 줄도 섞인다(줄 수만으로 고장이라 하지 않는다)
    const state = !lines ? 'ok' : serious ? (up ? 'warn' : 'bad') : kinds.length ? 'warn' : up ? 'ok' : 'warn';
    out.push(finding('relay.startlog', G, '마지막 시작 기록', state, !lines ? '오류 기록이 비어 있습니다.' : `오류 기록 ${lines}줄${kinds.length ? ` — ${kinds.join(' · ')}` : ' — 알려진 고장 종류는 없음'}.`, { dataAt: errLog.mtime, source: '중계기 오류 기록의 꼬리' }));
  }

  // 6) 로그인 갱신 실패와 거절의 최근 흐름(한 시간)
  const now = ctx.now();
  const recent = (ev) => ev.filter((e) => { const t = Date.parse(e.t); return Number.isFinite(t) && now - t < HOUR; });
  const ae = tailEvents(ctx, 'auth-events.jsonl', 48 * 1024);
  if (ae) {
    const fails = recent(ae.events).filter((e) => e.type === 'refresh-failed');
    const kinds = {};
    const KIND_KO = { network: '통신 끊김', rejected: '거절', expired: '만료', unconfirmed: '확인 필요', 'unexpected-reply': '뜻밖의 답' };
    for (const f of fails) { const k = KIND_KO[f.kind] || '그 밖'; kinds[k] = (kinds[k] || 0) + 1; } // 기록에 적힌 종류 글을 그대로 싣지 않는다(아는 종류만)
    out.push(finding('relay.refresh', G, '로그인 갱신(최근 1시간)', fails.length ? 'warn' : 'ok', !fails.length ? '갱신 실패가 없습니다.' : `갱신 실패 ${fails.length}건 — ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(' · ')}.`, { dataAt: ae.mtime, source: '중계기 로그인 사건 기록의 꼬리' }));
  }
  const re = tailEvents(ctx, 'reject-events.jsonl', 96 * 1024);
  if (re) {
    const n429 = recent(re.events).filter((e) => String(e.type) === '429').length;
    out.push(finding('relay.rejects', G, '요청 거절(최근 1시간)', n429 >= 30 ? 'warn' : 'ok', n429 ? `한도 거절(429) ${n429}건${n429 >= 30 ? ' — 많습니다' : ''}.` : '한도 거절이 없습니다.', { dataAt: re.mtime, source: '중계기 거절 기록의 꼬리' }));
  }
  return out;
}
