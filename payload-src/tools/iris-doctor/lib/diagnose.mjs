// IRIS Doctor — 검진을 돌려 검진표 한 장을 만든다. 읽기만 한다(아무 파일도 쓰지 않는다 · 결과는 돌려주기만 한다).
import { FORMAT, finding, worstOf, countStates, GROUPS } from './report.mjs';
import { makeContext } from './context.mjs';
import { checkRelay } from './checks/relay.mjs';
import { checkKeys, checkWindow, checkPrograms, checkWiring, checkResume, checkResources, checkUpdate, checkDoctor } from './checks/system.mjs';
import { checkNetwork } from './checks/network.mjs';

// 판 번호 — **실리는 파일(실행 입구 · 시작 파일 · lib\ · guide\)이 하나라도 바뀌면 반드시 올린다.**
// 지킴이(lib/integrity.mjs)는 "디스크의 판 번호가 달라졌으면 업데이트"로 보고 되돌리지 않는다 — 판이 같은 채 파일만 바뀌면, 떠 있던 Doctor 가 새 파일을 옛 사본으로 되돌릴 수 있다.
export const VERSION = '0.2.0';

// [묶음, 검사 함수, 제한 시간(ms)] — 한 검사가 멎어도 나머지 검진표는 나와야 한다.
const CHECKS = [
  ['relay', checkRelay, 25_000],
  ['keys', checkKeys, 8_000],
  ['window', checkWindow, 25_000],
  ['programs', checkPrograms, 8_000],
  ['wiring', checkWiring, 20_000],
  ['resume', checkResume, 25_000],
  ['network', checkNetwork, 15_000],
  ['resources', checkResources, 25_000],
  ['update', checkUpdate, 8_000],
  ['doctor', checkDoctor, 5_000],
];
const groupName = (g) => (GROUPS.find(([id]) => id === g) || [g, g])[1];

async function runOne(ctx, group, fn, timeoutMs) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  try {
    const r = await Promise.race([Promise.resolve().then(() => fn(ctx)), late]);
    if (r === 'timeout') return [finding(`${group}.timeout`, group, `${groupName(group)} 검진`, 'unknown', `${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 건너뛰었습니다.`, { skipped: '시간 초과' })];
    return Array.isArray(r) ? r : [];
  } catch (e) {
    // 검사 코드의 오류는 '정상'으로 새지 않게 '모름'으로 — 오류 글은 종류 이름만
    return [finding(`${group}.error`, group, `${groupName(group)} 검진`, 'unknown', '검사 도중 오류가 나서 건너뛰었습니다.', { skipped: String(e?.name || 'Error').slice(0, 40) })];
  } finally { clearTimeout(timer); }
}

/**
 * @param {object} opts makeContext 에 넘기는 값(offline · root · 시험용 가짜 도구들) + only: 돌릴 묶음 이름 배열(없으면 전부)
 * @returns 검진표 { tool, format, startedAt, finishedAt, mode, layout, root, findings[], summary, worst }
 */
export async function diagnose(opts = {}) {
  let ctx;
  try { ctx = opts.ctx ?? makeContext(opts); } catch {
    // 자리를 정하다 터져도(깨진 설정 등) 죽지 않는다 — 그 사실 하나를 적은 검진표를 낸다. 오류 글은 싣지 않는다.
    const now = new Date().toISOString();
    const findings = [{ ...finding('doctor.self', 'doctor', '진단기 준비', 'unknown', '진단기가 볼 자리를 정하지 못해 검진을 하지 못했습니다(설정 파일이 깨졌을 수 있습니다).', { skipped: '자리 정하기 실패' }), checkedAt: now }];
    return { tool: { name: 'iris-doctor', version: VERSION }, format: FORMAT, startedAt: now, finishedAt: now, mode: opts.offline ? 'offline' : 'online', layout: 'unknown', root: null, findings, summary: countStates(findings), worst: 'unknown' };
  }
  const startedAt = new Date(ctx.now()).toISOString();
  const picked = CHECKS.filter(([g]) => !opts.only || opts.only.includes(g));
  const lists = await Promise.all(picked.map(([g, fn, ms]) => runOne(ctx, g, fn, ms)));
  const now = new Date(ctx.now()).toISOString();
  const findings = lists.flat().map((f) => ({ ...f, checkedAt: now }));
  return {
    tool: { name: 'iris-doctor', version: VERSION }, format: FORMAT,
    startedAt, finishedAt: now,
    mode: ctx.offline ? 'offline' : 'online', layout: ctx.layout, root: ctx.root,
    findings, summary: countStates(findings), worst: worstOf(findings.filter((f) => f.state !== 'skipped')),
  };
}
