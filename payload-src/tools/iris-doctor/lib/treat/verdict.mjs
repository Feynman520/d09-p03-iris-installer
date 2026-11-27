// IRIS Doctor — "나아졌는가"를 가리는 판정기. 에이전트의 "다 됐다"는 말은 근거가 아니다: 치료 전 검진표와 치료 뒤 검진표를 항목 이름으로 견준다.
//
// 낱말을 구별한다:
//   나아짐(improved) = 고치려던 항목이 검진에서 정상이 됐고 새로 고장 난 것이 없다. **"해결"이 아니다.**
//   해결(resolved)   = 나아짐 + 처방의 자기 확인(실제 동작을 다시 해 봄) 통과 + (할 수 있으면) 다시 켠 뒤에도 성공. 이 파일이 아니라 부른 쪽이 그 확인까지 한 뒤에 붙인다.
//   보류(pending)    = 가릴 수 없다(고장 → 모름, 통신 항목이 흔들림, 검진 방식이 다름 …). 해결도 나빠짐도 아니다.
//   나빠짐(worse)    = 치료 전에는 고장이 아니던 항목이 고장이 됐다(흔들리는 항목은 빼고).
//   변화 없음(unchanged)
import { STATES } from '../report.mjs';

// 그때그때 달라질 수 있는 항목(바깥 통신 · 여유 메모리와 디스크) — 이것만으로 "나빠짐"이라 하지 않는다
const FLAKY_GROUPS = new Set(['network', 'resources']);
const rank = { ok: 0, skipped: 0, warn: 1, unknown: 1, bad: 2 };
const byId = (report) => new Map((report?.findings || []).map((f) => [f.id, f]));

/**
 * → { verdict, goals: [{ id, before, after, result }], worse: [id…], recheck: [id…], comparable }
 *   goals = 고치려던 항목 이름들(없으면 치료 전에 고장이던 항목 전부).
 */
export function judge({ before, after, goals = null }) {
  const b = byId(before), a = byId(after);
  // 검진 방식이 다르면(통신 포함 ↔ 통신 없이) 통신 묶음은 견주지 않는다
  const sameMode = (before?.mode || null) === (after?.mode || null);
  const targetIds = (goals && goals.length ? goals : [...b.values()].filter((f) => f.state === 'bad').map((f) => f.id));
  const outGoals = []; const recheck = [];
  for (const id of targetIds) {
    const fb = b.get(id), fa = a.get(id);
    const sb = STATES.includes(fb?.state) ? fb.state : 'unknown';
    // 치료 뒤 검진표에 그 항목이 아예 없으면: 고장일 때만 나오는 항목이면 사라진 것 = 정상, 아니면 모름. 부른 쪽이 가르지 못하므로 보류로 둔다.
    const sa = fa ? (STATES.includes(fa.state) ? fa.state : 'unknown') : 'absent';
    let result;
    if (sa === 'ok') result = 'fixed';
    else if (sa === 'absent' || sa === 'unknown' || sa === 'skipped') { result = 'pending'; recheck.push(id); }
    else if (rank[sa] < rank[sb]) result = 'better';
    else if (rank[sa] === rank[sb]) result = 'same';
    // 목표 항목이 더 나빠 보여도: 흔들리는 묶음이거나 원래 모름이던 것이면 치료 탓이라 단정하지 않는다(다시 볼 것)
    else if (FLAKY_GROUPS.has(fa.group) || (!sameMode && fa.group === 'network') || sb === 'unknown') { result = 'pending'; recheck.push(id); }
    else result = 'worse';
    outGoals.push({ id, before: sb, after: sa, result });
  }
  const worse = [];
  for (const [id, fa] of a) {
    if (fa.state !== 'bad') continue;
    const fb = b.get(id);
    if (fb?.state === 'bad') continue;                       // 원래 고장이던 것
    if (FLAKY_GROUPS.has(fa.group) || (!sameMode && fa.group === 'network')) { recheck.push(id); continue; }
    if (fb && fb.state === 'unknown') { recheck.push(id); continue; } // 모름 → 고장: 원래 고장이었을 수 있다 — 치료 탓이라 단정하지 않는다
    worse.push(id);
  }
  for (const g of outGoals) if (g.result === 'worse') worse.push(g.id);
  let verdict;
  if (worse.length) verdict = 'worse';
  else if (!outGoals.length) verdict = 'unchanged';
  else if (outGoals.every((g) => g.result === 'fixed')) verdict = 'improved';
  else if (outGoals.some((g) => g.result === 'pending') && !outGoals.some((g) => g.result === 'same')) verdict = 'pending';
  else if (outGoals.some((g) => g.result === 'fixed' || g.result === 'better')) verdict = 'partly';
  else if (outGoals.every((g) => g.result === 'pending')) verdict = 'pending';
  else verdict = 'unchanged';
  return { verdict, goals: outGoals, worse: [...new Set(worse)], recheck: [...new Set(recheck)], comparable: sameMode };
}

export const VERDICT_KO = { improved: '나아짐', partly: '일부 나아짐', unchanged: '변화 없음', worse: '나빠짐', pending: '가리지 못함(보류)' };
