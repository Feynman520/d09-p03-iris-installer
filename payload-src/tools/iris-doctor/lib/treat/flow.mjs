// IRIS Doctor — 치료 흐름(걸음 ④a: 에이전트 없이 도는 부분 — 기계 처방). 차림표의 [1] 치료 시작이 부른다.
//
//   검진표 확보 → 끊겼던 치료 알림 → 돌릴 수 있는 처방 고르기(처방마다 원인을 다시 확인)
//   → **동의 화면 한 장**("치료를 시작할까요?" — Doctor 가 더하는 물음은 이것 하나) → 치료 잠금 + 진료 기록
//   → 처방 하나씩: 하려는 일을 적음 → 복원점 → 변경 → 다시 검진 → 판정(나빠졌으면 그 처방의 변경을 되돌림) → 자기 확인
//   → 결과 한 장(해결 / 나아짐 / 미해결 · 한 일 · 되돌리는 법 · 사람 손이 필요한 일)
//
// 낱말: "해결" = 검진에서 나아짐 + 처방의 자기 확인(실제로 되는지 다시 해 봄) 통과. 그 밖은 "나아짐" · "미해결"로 적는다(에이전트나 처방의 "됐다"는 말은 근거가 아니다).
// 지킬 것: 기록을 못 남기면 변경을 시작하지 않는다 · 복원점을 못 뜨면 그 처방을 하지 않는다 · 업데이트가 도는 동안에는 시작하지 않고, 치료하는 동안에는 업데이트가 시작하지 못하게 잠금을 함께 쥔다.
import fs from 'node:fs';
import path from 'node:path';
import { doctorPaths, ensureHome, readJsonFile } from '../home.mjs';
import { acquireFileLock, TREAT_LOCK_ABANDON_MS } from '../lock.mjs';
import { openCase, listUnfinished, loadCase } from './record.mjs';
import { restoreAll, restorePoint, createPoint, sealPoint } from './restore.mjs';
import { prepareRun, agentDiagnose, agentTreat, baselineTargets } from './agent.mjs';
import { judge, VERDICT_KO } from './verdict.mjs';
import { planPrescriptions } from './prescriptions.mjs';
import { note } from '../journal.mjs';

const LINE = '────────────────────────────────────────────────────────';
export { TREAT_LOCK_ABANDON_MS };                 // 치료 잠금의 버려짐 기준(값은 lib\lock.mjs — 손 없는 계정 준비도 같은 값을 본다)
const UPDATE_LOCK_STALE_MS = 30 * 60_000;         // 업데이트기의 잠금 규칙과 같다(updater\agents.mjs LOCK_STALE_MS)
export const METHOD_LIMIT_MS = 10 * 60_000;        // 처방 하나(방법 하나)에 주는 시간 — 치료 전체의 포기 한도가 아니다

const updateLockFile = (root) => path.join(root, '_agent', 'setup', 'agent-update.lock');
/**
 * 업데이트와 서로 겹치지 않게: 업데이트기의 잠금 파일을 **업데이트기가 쓰는 모양 그대로** 쥔다(업데이트기는 이 파일이 있으면 30분 동안 시작하지 않는다).
 * → { ok:true, release(), touch() } | { ok:false }(업데이트가 진행 중) | { ok:true, none:true }(설치본이 아니라 잠글 것이 없음)
 */
export function holdUpdateLock(root, { now = Date.now(), pid = process.pid } = {}) {
  const file = updateLockFile(root);
  if (!fs.existsSync(path.dirname(file))) return { ok: true, none: true, release() {}, touch() { return true; }, mine: () => true };
  const body = (at) => JSON.stringify({ pid, at: new Date(at).toISOString(), by: 'iris-doctor' });
  const mine = () => { const j = readJsonFile(file); return !!j && j.by === 'iris-doctor' && j.pid === pid; };
  const take = () => { try { fs.writeFileSync(file, body(now), { flag: 'wx' }); return true; } catch { return false; } };
  if (!take()) {
    // 이미 있다. **30분이 지났다고 확인된 것만** 버려진 것으로 본다 — 못 읽는 잠금(방금 만들어 아직 내용을 쓰는 중일 수 있다)은 파일의 고친 시각으로 가리고, 그것도 30분이 안 됐으면 물러난다.
    let raw = null; try { raw = fs.readFileSync(file, 'utf8'); } catch {}
    let at = NaN; try { at = Date.parse(JSON.parse(raw).at); } catch {}
    if (!Number.isFinite(at)) { try { at = fs.statSync(file).mtimeMs; } catch { at = NaN; } }
    if (!Number.isFinite(at) || now - at < UPDATE_LOCK_STALE_MS) return { ok: false };
    // 버려진 잠금 넘겨받기: **잠금 자리를 비우지 않는다**(옮기거나 지웠다가 다시 만들면 그 틈에 다른 업데이트가 들어온다).
    // 내 내용을 임시 파일에 써 두고 → 지금 내용이 "방금 읽은 그 낡은 내용" 그대로인지 다시 본 뒤 → 한 번에 바꿔 낀다 → 다시 읽어 내 것인지 확인한다.
    const tmp = `${file}.doctor-${pid}-${now}.tmp`;
    try {
      fs.writeFileSync(tmp, body(now));
      let again = null; try { again = fs.readFileSync(file, 'utf8'); } catch {}
      if (again !== raw) return { ok: false }; // 그 사이 누가 새로 적었다 — 살아 있는 잠금이다
      fs.renameSync(tmp, file);
    } catch { return { ok: false }; } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
    if (!mine()) return { ok: false }; // 같은 순간 다른 쪽이 덮었으면 물러난다
  }
  return {
    ok: true,
    release() { if (mine()) { try { fs.rmSync(file, { force: true }); } catch {} } },
    /** 소식을 새로 적는다(내 잠금일 때만). → 아직 내 잠금인가(아니면 부른 쪽은 더 바꾸지 않는다) */
    touch(at = Date.now()) { if (!mine()) return false; try { fs.writeFileSync(file, body(at)); } catch {} return mine(); },
    mine,
  };
}

const stateKo = (s) => ({ ok: '정상', warn: '주의', bad: '고장', unknown: '모름', skipped: '건너뜀', absent: '항목 없음' }[s] || s);

/**
 * 치료 한 번. 대화 흐름(lib\session.mjs)이 넘겨주는 것: ctx · say · ask · rediagnose(다시 검진해 검진표를 돌려줌) · diag(지금 검진 상태).
 * → { outcome: 'resolved' | 'improved' | 'unresolved' | 'declined' | 'nothing' | 'busy' | 'no-report' | 'failed', caseId? }
 */
export async function treat({ ctx, say, ask, diag, rediagnose, now = () => Date.now(), list = undefined, deps = {}, status = null, pickServices = null, afterAgent = () => {}, guardTripped = () => false }) {
  const A = { prepareRun, agentDiagnose, agentTreat, baselineTargets, ...(deps.agent || {}) }; // 에이전트 쪽(시험에서 바꿔 낀다)
  if (!ctx?.root) { say('IRIS 폴더를 찾지 못해 치료를 시작할 수 없습니다(검진표에 까닭이 나옵니다).'); return { outcome: 'failed' }; }
  // ── 1. 검진표
  let before = diag?.report || null;
  if (!before || diag?.state !== 'done') { say('검진을 먼저 끝냅니다 …'); before = await rediagnose(); }
  if (!before) { say('검진을 끝내지 못해 치료를 시작하지 않습니다 — [3]으로 검진을 다시 해 본 뒤 [1]을 눌러 주세요.'); return { outcome: 'no-report' }; }

  // ── 2. 끊겼던 치료(이 실행의 동의와 따로다 — 여기서는 알리기만 하고, 그때의 변경을 스스로 되돌리지 않는다)
  let unfinished = []; try { unfinished = listUnfinished({ root: ctx.root }); } catch {}
  if (unfinished.length) {
    say(`[알림] 지난 치료 ${unfinished.length}건이 도중에 끊겼습니다(기록 ${unfinished[0].id}). 그때 바꾼 것은 그대로 두었고, 이번 검진은 지금 상태를 본 것입니다.`);
    // 한 번 알렸으면 "끊김 · 알림"으로 적어 둔다(같은 알림을 되풀이하지 않게). 지금 다른 치료가 돌고 있는 기록일 수 있으므로 치료 잠금이 비어 있을 때만 적는다.
    if (!fs.existsSync(path.join(doctorPaths(ctx.root).home, 'treat.lock'))) for (const u of unfinished) { try { loadCase({ root: ctx.root, id: u.id })?.set('interrupted', { noticed: true }, now()); } catch {} }
  }

  // ── 3. 계획
  const plan = await planPrescriptions({ report: before, ctx, ...(list ? { list } : {}), deps });

  // ── 3b. 에이전트의 원인 찾기(읽기만 — 아무것도 바꾸지 않는다). 기계 처방이 맡지 않는 고장이 남아 있을 때, 또는 검진에는 안 잡히는 문제를 사용자가 적었을 때.
  const services = pickServices && status ? pickServices(status) : [];
  const covered = new Set(plan.ready.flatMap((p) => p.rx.goals));
  const leftBad = (before.findings || []).filter((f) => f.state === 'bad' && !covered.has(f.id));
  let symptom = null, agentPlan = null, agentKind = null, run = null; const agentNotes = [];
  let wantAgent = leftBad.length > 0;
  if (!wantAgent && !plan.ready.length && services.length) {
    say('검진에서는 고장이 보이지 않습니다.');
    const sx = await ask(' 어떤 문제가 있는지 한 줄로 적어 주세요(그냥 Enter = 그만두기): ');
    if (sx) { symptom = sx; wantAgent = true; }
  }
  if (wantAgent && !services.length) agentNotes.push('연결된 계정이 없어 에이전트가 원인을 찾아 고치는 치료는 하지 않습니다(차림표 [4]에서 연결할 수 있습니다).');
  else if (wantAgent && guardTripped()) agentNotes.push('보호 장치가 걸려 있어 이 실행에서는 에이전트 치료를 하지 않습니다.');
  else if (wantAgent) {
    try { run = await A.prepareRun({ ctx, id: String(now()), mode: 'diagnose', deps }); } catch { run = { ok: false, why: 'run-dir' }; }
    if (!run.ok) { agentNotes.push(run.why === 'guard-path-unsafe' ? '가드를 걸 수 없는 경로라 에이전트 치료를 하지 않습니다.' : '에이전트를 띄울 자리를 마련하지 못해 에이전트 치료를 하지 않습니다.'); run = null; }
    else for (const kind of services.slice(0, 2)) {
      say(`${NAME[kind]} 에이전트가 원인을 찾는 중입니다(아무것도 바꾸지 않습니다 · 길면 10분) …`);
      let d; try { d = await A.agentDiagnose({ kind, ctx, run, report: before, mechanical: plan.ready.map((p) => p.rx.title), symptom }); } catch { d = { ok: false, why: 'failed' }; }
      try { afterAgent(); } catch {}
      if (d.ok) { agentPlan = d.plan; agentKind = kind; break; }
      agentNotes.push(`${NAME[kind]} 에이전트가 원인을 정리하지 못했습니다 — ${AGENT_WHY[d.why] || '까닭을 알 수 없음'}.`);
      if (d.why === 'timeout' && d.alive) break; // 아직 살아 있는 것이 있으면 다른 서비스로 겹쳐 띄우지 않는다
    }
    if (agentPlan?.nothing) { agentNotes.push(`에이전트가 살펴본 결과 고칠 것을 찾지 못했습니다${agentPlan.cause.text ? ` — ${agentPlan.cause.text}` : ''}.`); agentPlan = null; }
    if (agentPlan && guardTripped()) { agentNotes.push('보호 장치가 걸려 에이전트 치료를 하지 않습니다.'); agentPlan = null; }
  }
  if (!plan.ready.length && !agentPlan) {
    say('지금 기계 처방으로 고칠 수 있는 항목이 없습니다.');
    for (const s of plan.skipped.filter((x) => (before.findings || []).some((f) => x.rx.goals.includes(f.id) && (f.state === 'bad' || f.state === 'warn')))) say(`  · ${s.rx.title}: 하지 않음 — ${s.why}.`);
    for (const n of agentNotes) say(`  · ${n}`);
    for (const h of plan.human) say(`  · 사람 손이 필요한 일 — ${h.title}: ${h.guide}`);
    try { run?.cleanup(); } catch {}
    return { outcome: 'nothing' };
  }

  // ── 4. 동의 화면 한 장
  const CERT_KO = { confirmed: '확인함', likely: '추정', unknown: '모름' };
  say(''); say(LINE); say(' 치료 계획'); say(LINE);
  plan.ready.forEach((p, i) => { say(` ${i + 1}. ${p.rx.title}`); say(`    원인(확인함): ${p.cause}`); say(`    하는 일: ${p.rx.changes}`); say(`    영향: ${p.rx.impact}`); });
  if (agentPlan) {
    say(` ${plan.ready.length + 1}. ${NAME[agentKind]} 에이전트가 직접 고칩니다`);
    say(`    원인(${CERT_KO[agentPlan.cause.certainty]}): ${agentPlan.cause.text || '(적지 않음)'}`);
    agentPlan.steps.forEach((s, i) => say(`    할 일 ${i + 1}: ${s}`));
    if (agentPlan.alternatives.length) say(`    안 되면 이어서 해 볼 방법: ${agentPlan.alternatives.join(' / ')}`);
    say(`    영향: ${agentPlan.impact.text || '(적지 않음)'}${agentPlan.impact.endsSessions ? ' — 열려 있는 대화가 끊길 수 있습니다' : ''}`);
    say(`    한도: 방법 하나에 길면 20분, 통하지 않으면 다른 방법으로 ${MAX_AGENT_RUNS}번까지 이어 갑니다.`);
    if (!run.bundle) say('    알림: 이 PC 에서는 Doctor 가 끝날 때 에이전트가 띄운 프로그램을 한꺼번에 끝내 주는 장치를 쓸 수 없어, 대신 뒤에 남는 실행을 막고 시간 제한으로 끊습니다.');
  } else for (const n of agentNotes) say(` · ${n}`);
  const humanAll = [...plan.human.map((h) => h.title), ...(agentPlan?.human || [])];
  if (humanAll.length) { say(''); say(' 사람 손이 필요한 일(치료가 끝난 뒤 차례로 안내합니다):'); for (const h of humanAll) say(`  · ${h}`); }
  say(''); say(` 지키는 것: 바꾸기 전을 떠 둡니다(${path.join(doctorPaths(ctx.root).records)} 아래). 변경 하나를 할 때마다 다시 검진하고, 나빠지면 그 변경을 되돌립니다.`);
  if (agentPlan) say(' 에이전트는 열쇠 파일 · 사용자의 작업 자료 · 윈도우 보안 설정을 건드리지 않게 가드를 걸고 돕니다(알려진 방식의 명령을 막는 장치이며, 뒤를 사본과 다시 검진이 받칩니다).');
  say(' 이 범위에서 더 묻지 않고 끝까지 진행합니다.');
  const a = await ask(' 치료를 시작할까요? (y = 시작 / 그 밖 = 그만두기): ');
  if (!a || !/^(y|yes|ㅛ|예|네)$/i.test(a)) { say('치료를 시작하지 않았습니다. 아무것도 바꾸지 않았습니다.'); try { run?.cleanup(); } catch {} return { outcome: 'declined' }; }

  // ── 5. 잠금(치료는 한 번에 하나 · 업데이트와 겹치지 않게)
  let leaveRun = false; // 에이전트가 띄운 프로그램이 아직 살아 있으면 실행 폴더(가드 · 거절 기록)를 지우지 않는다
  const drop = () => { if (leaveRun) return; try { run?.cleanup(); } catch {} };
  let home; try { home = ensureHome(ctx.root); } catch { say('Doctor 의 자리를 마련하지 못해 치료를 시작하지 않습니다.'); drop(); return { outcome: 'failed' }; }
  const lock = acquireFileLock(path.join(home.home, 'treat.lock'), { now: now(), abandonMs: TREAT_LOCK_ABANDON_MS });
  if (!lock.ok) { say('다른 치료가 진행 중입니다 — 그 치료가 끝난 뒤 다시 해 주세요.'); drop(); return { outcome: 'busy' }; }
  const upd = holdUpdateLock(ctx.root, { now: now() });
  if (!upd.ok) { lock.release(); say('에이전트 프로그램 업데이트가 진행 중입니다 — 업데이트가 끝난 뒤 다시 해 주세요(아무것도 바꾸지 않았습니다).'); drop(); return { outcome: 'busy' }; }
  const beat = setInterval(() => { lock.touch(); upd.touch(); }, 5 * 60_000); beat.unref?.();
  const tctx = { ...ctx, treatHoldsUpdateLock: !upd.none };

  let kase = null;
  try {
    // ── 6. 진료 기록(못 열면 시작하지 않는다)
    try {
      kase = openCase({ root: ctx.root, now: now(), summary: { plan: [...plan.ready.map((p) => p.rx.id), ...(agentPlan ? [`agent:${agentKind}`] : [])] } });
      kase.saveJson('before.json', before);
      kase.saveJson('plan.json', { ready: plan.ready.map((p) => ({ id: p.rx.id, title: p.rx.title, cause: p.cause, changes: p.rx.changes })), skipped: plan.skipped.map((s) => ({ id: s.rx.id, why: s.why })), human: plan.human.map((h) => h.id), ...(agentPlan ? { agent: { kind: agentKind, plan: agentPlan, bundle: !!run?.bundle } } : {}) });
      kase.set('consented', {}, now()); kase.set('treating', {}, now());
      note({ root: ctx.root, kind: 'treat-start', from: 'treat', case: kase.id, now: now() });
    } catch { say('진료 기록을 남길 수 없어(디스크 공간이나 권한 문제) 치료를 시작하지 않습니다. 아무것도 바꾸지 않았습니다.'); return { outcome: 'failed' }; }


    // ── 7. 처방 하나씩
    const results = []; let current = before;
    // 마지막 변경 뒤의 검진이 실패했으면 current 는 낡은 표다(stale) — 낡은 표로는 "해결됐다"고 하지도, 새 변경을 시작하지도 않는다
    let stale = false; const diagNow = async () => { const r = await rediagnose(); stale = !r; return r; };
    // 안전 때문에 멈춘 까닭(잠금 잃음 · 지킴이 · 복원 충돌 · 기록 실패 · 검진 실패) — 치료 전체가 함께 쓴다. 한번 서면 그 뒤에는 어떤 변경도(기계 처방 · 에이전트 · 후속 패스) 새로 시작하지 않는다.
    let halt = null;
    // 진료 기록 한 줄: 남기지 못하면 선다(기록 없이 변경을 쌓지 않는다 — 코덱스 검토 지적: 예외를 삼키고 다음 방법으로 넘어가던 자리들)
    const logStep = (entry) => { try { kase.step(entry, now()); return true; } catch { halt = halt || '진료 기록을 남기지 못해'; return false; } };
    // 변경 하나를 시작하기 직전마다 부른다(코덱스 검토 지적: 묶음에 들어갈 때만 보면 묶음 안의 두 번째 변경이 새 나간다). 표가 낡았으면 한 번 다시 검진해 보고, 그래도 안 되면 선다.
    const mayChange = async () => {
      if (halt) return false;
      if (guardTripped()) { halt = '보호 장치가 걸려'; return false; }
      if (stale) { const re = await diagNow(); if (re) current = re; }
      if (stale) { halt = '다시 검진하지 못해(검진표가 낡아)'; return false; }
      return true;
    };
    let seq = 0; // 검진표 파일 번호(기계 처방을 두 번에 걸쳐 돌려도 겹치지 않게)
    const runMachine = async (ready) => { for (const [i, p] of ready.entries()) {
      const rx = p.rx;
      say(''); say(`[${i + 1}/${ready.length}] ${rx.title} …`);
      // 잠금 둘이 아직 내 것일 때만 다음 변경을 시작한다(업데이트기가 낡은 잠금으로 보고 가져갔으면 겹치지 않게 멈춘다)
      if (!lock.touch(now()) || !upd.mine()) { halt = halt || '치료 잠금을 더 쥐고 있지 못해'; say('  치료 잠금을 더 쥐고 있지 못해 여기서 멈춥니다(남은 처방은 시작하지 않았습니다).'); break; }
      if (!(await mayChange())) { say(`  ${halt} 여기서 멈춥니다(남은 처방은 시작하지 않았습니다).`); break; }
      // 앞의 처방이 상태를 바꿨을 수 있다 — 시작 조건을 지금 다시 본다
      let again; try { again = await rx.applies({ report: current, ctx: tctx, ...deps }); } catch { again = { ok: false, why: '시작 조건을 확인하지 못했습니다' }; }
      if (!again.ok) { say(`  하지 않음 — ${again.why}.`); kase.step({ kind: 'skipped', rx: rx.id, why: again.why }, now()); results.push({ rx, outcome: 'skipped', note: again.why }); continue; }
      try { kase.step({ kind: 'intent', rx: rx.id, what: rx.changes }, now()); } catch { halt = halt || '진료 기록을 남기지 못해'; say('  진료 기록을 남기지 못해 여기서 멈춥니다(이 처방은 시작하지 않았습니다).'); results.push({ rx, outcome: 'not-started', note: '기록 실패' }); break; }
      const pointsBefore = countPoints(kase.dir);
      let run;
      try { run = await withLimit(rx.run({ ctx: tctx, kase, now: now(), deps }), deps.methodLimitMs ?? METHOD_LIMIT_MS); } catch (e) { run = { ok: false, changed: null, note: e?.message === 'no-space' ? '바꾸기 전을 떠 둘 공간이 모자라 하지 않았습니다.' : '처방을 끝까지 돌리지 못했습니다.' }; }
      if (run === TIMEOUT) run = { ok: false, changed: null, note: '정한 시간 안에 끝나지 않았습니다.' };
      let logged = true;
      try { kase.step({ kind: run.ok ? 'done' : 'failed', rx: rx.id, changed: run.changed ?? null, partial: !!run.partial }, now()); } catch { logged = false; }
      say(`  ${run.note}`);
      if (run.partial) say('  이 처방이 일부만 바뀐 채 멈췄습니다 — 바꾼 것은 진료 기록의 복원점에 남아 있습니다.');
      // 다시 검진 → 판정
      const after = await diagNow();
      let verdict = null;
      if (after) { try { kase.saveJson(`after-${++seq}.json`, after); } catch {} verdict = judge({ before: current, after, goals: rx.goals }); }
      if (verdict?.verdict === 'worse') {
        // 이 처방이 만든 복원점만 거꾸로 되돌린다(앞의 처방이 한 일은 두고)
        const back = restoreSince(kase.dir, pointsBefore);
        const nothing = back.ok && !back.points.length; // 이 처방은 파일을 바꾸지 않았다(프로그램을 켠 것 등) — "되돌렸다"고 하지 않는다
        say(`  다시 검진하니 나빠진 항목이 있습니다(${verdict.worse.length}개)${nothing ? '. 이 처방은 파일을 바꾸지 않아 되돌릴 것이 없습니다(켠 프로그램은 그대로 둡니다).' : ' — 이 처방의 변경을 되돌립니다.'}`);
        try { kase.step({ kind: nothing ? 'worse-nothing-to-restore' : 'restored', rx: rx.id, ok: back.ok, worse: verdict.worse }, now()); } catch { logged = false; }
        if (!nothing) say(back.ok ? '  되돌렸습니다.' : '  일부는 되돌리지 못했습니다(그 뒤 다른 것이 바꾼 파일은 덮지 않고 따로 두었습니다).');
        results.push({ rx, outcome: nothing ? 'unresolved' : back.ok ? 'rolled-back' : 'conflict', note: nothing ? `${run.note} 그런데 다른 항목이 고장으로 나왔습니다.` : run.note });
        if (!nothing && !back.ok) halt = halt || '되돌리다 충돌이 나'; // 되돌리지 못한 것이 있는 채로 다음 변경을 쌓지 않는다
        if (!logged) { halt = halt || '진료 기록을 남기지 못해'; say('  진료 기록을 더 남기지 못해 여기서 멈춥니다(남은 처방은 시작하지 않았습니다).'); break; }
        const re = await diagNow(); if (re) current = re;
        continue;
      }
      if (after) current = after;
      // 자기 확인: 실제로 되는지 다시 해 본다(검진이 정상이라는 것만으로 "해결"이라 하지 않는다)
      let check = { ok: false, note: '확인하지 못했습니다.' };
      if (run.ok) { try { const v = await withLimit(rx.verify({ ctx: tctx, deps }), deps.verifyLimitMs ?? 150_000); check = v === TIMEOUT ? { ok: false, note: '확인이 정한 시간 안에 끝나지 않았습니다.' } : v; } catch {} }
      // 해결 = 검진에서 나아짐 + 자기 확인 통과. 자기 확인은 됐는데 검진이 "여전히 고장(변화 없음)"이면 서로 어긋나므로 미해결로 둔다.
      // 검진을 다시 못 했거나 가리지 못한 것(보류 · 일부)은 "나아짐"까지만.
      const v = verdict?.verdict ?? null;
      const outcome = !run.ok || !check.ok || v === 'unchanged' ? 'unresolved' : v === 'improved' ? 'resolved' : 'improved';
      say(`  확인: ${check.note}${verdict ? ` · 검진: ${VERDICT_KO[verdict.verdict] || verdict.verdict}` : ' · 검진: 다시 하지 못함'}`);
      try { kase.step({ kind: 'verdict', rx: rx.id, outcome, verdict: v, check: !!check.ok }, now()); } catch { logged = false; }
      results.push({ rx, outcome, note: check.note, verdict });
      if (!logged) { halt = halt || '진료 기록을 남기지 못해'; say('  진료 기록을 더 남기지 못해 여기서 멈춥니다(남은 처방은 시작하지 않았습니다).'); break; }
    } };
    await runMachine(plan.ready);

    const stopped = results.length < plan.ready.length || !!halt; // 마지막 처방까지 돌았어도 안전 때문에 선 것(halt)이면 멈춘 것이다 — 에이전트 치료로 넘어가지 않는다 · 도중에 멈춰 시작하지 못한 처방이 있다 — 한 것만 보고 "해결"이라 하지 않는다

    // ── 7b. 에이전트 치료: 방법 하나씩. 실행 → 지킴이 확인 → 다시 검진 → 판정(나빠졌으면 기준 사본으로 되돌림) → 통하지 않았으면 다른 방법으로.
    //    한도(MAX_AGENT_RUNS)는 같은 일을 끝없이 되풀이하지 않게 하는 장치다 — 닿으면 미해결과 한 일을 남기고, 다시 [1]을 누르면 새로 이어서 할 수 있다.
    if (agentPlan && !stopped) {
      const goals = leftBad.map((f) => f.id); // 비어 있으면(사용자가 적은 증상만 있음) 검진으로는 나아졌는지 가릴 수 없다
      const base = current; const history = []; const order = [agentKind, ...services.filter((k) => k !== agentKind)].slice(0, 2);
      const title = () => `${NAME[order[svc]]} 에이전트 치료`;
      let svc = 0, tries = 0, lastDid = null, outcome = 'unresolved', note = '';
      const seenAtStart = (() => { try { return run.calls(); } catch { return null; } })(); // 원인 찾기까지 가드가 본 호출 수 — 치료 중 호출 수를 따로 남기려고
      // 방법 하나마다 복원점 하나: 그 방법을 시작하기 **직전**의 설정을 뜨고(앞의 기계 처방 · 앞의 방법이 남긴 것까지 든 상태), 끝난 뒤 한 번 봉인한다.
      // 나빠지면 그 방법의 복원점만 되돌린다 — 기계 처방이 고친 것이나 그 사이 다른 프로그램이 바꾼 것을 옛 상태로 덮지 않는다.
      let point = null;
      const restoreThis = () => { const back = restorePoint(point.dir); logStep({ kind: 'restored', agent: order[svc], ok: back.ok }); say(back.ok ? '  이 방법이 바꾼 설정 파일을 되돌렸습니다.' : '  설정 파일 일부는 되돌리지 못했습니다(그 뒤 다른 것이 바꾼 파일은 덮지 않고 따로 두었습니다).'); return back.ok; };
      while (tries < MAX_AGENT_RUNS) {
        if (!lock.touch(now()) || !upd.mine()) { note = '치료 잠금을 더 쥐고 있지 못해 멈췄습니다.'; halt = halt || note; break; }
        if (guardTripped()) { note = '보호 장치가 걸려 멈췄습니다.'; halt = halt || note; break; }
        if (!(await mayChange())) { note = `${halt} 멈췄습니다(새 변경을 시작하지 않았습니다).`; break; }
        // 복원점을 못 뜨면 그 방법을 시작하지 않는다. 사본을 뜰 수 없는 파일은 가드가 고치지 못하게 막는다.
        try {
          const t0 = A.baselineTargets(ctx);
          if (t0.unprotected.length) { run.protect?.(t0.unprotected); if (!tries) say(`[알림] 설정 파일 ${t0.unprotected.length}개는 읽을 수 없어 사본을 뜨지 못했습니다 — 에이전트가 그 파일은 고치지 못하게 막았습니다.`); }
          point = createPoint({ caseDir: kase.dir, name: `agent-${tries + 1}`, targets: t0.targets, now: now() });
          kase.step({ kind: 'intent', agent: order[svc], attempt: tries + 1, files: t0.targets.length, unprotected: t0.unprotected.length }, now());
        } catch { note = tries ? '바꾸기 전을 떠 두지 못해 여기서 멈췄습니다.' : '바꾸기 전을 떠 두지 못해(공간이나 권한 문제) 에이전트 치료를 시작하지 않았습니다.'; halt = halt || note; break; }
        tries++;
        // 판정은 둘을 함께 본다: (가) 처음 상태(base)에 견줘 고치려던 것이 나아졌는가 (나) **이 방법 직전(prev)**에 견줘 새로 고장 난 것이 있는가.
        //   처음 상태만 보면, 앞 방법이 고친 것을 이번 방법이 다시 망가뜨려도 "원래 고장이던 것"이라 나빠짐으로 잡히지 않는다.
        const prev = current;
        const assess = (rep) => { const v = judge({ before: base, after: rep, goals }); const worse = [...new Set([...v.worse, ...judge({ before: prev, after: rep }).worse])]; return worse.length ? { ...v, verdict: 'worse', worse } : v; };
        say(''); say(`[에이전트 ${tries}/${MAX_AGENT_RUNS}] ${NAME[order[svc]]} 에이전트가 고치는 중입니다(길면 20분) …`);
        let t; try { t = await A.agentTreat({ kind: order[svc], ctx: tctx, run, report: current, plan: agentPlan, history, attempt: tries }); } catch { t = { ok: false, why: 'failed' }; }
        try { afterAgent(); } catch {}
        if (!t.ok && t.why === 'timeout' && t.alive) {
          // 에이전트가 띄운 것이 아직 살아 있다: 상태가 아직 바뀌는 중일 수 있으므로 봉인도 · 되돌리기도 하지 않고, 실행 폴더(가드 · 거절 기록)도 남긴다.
          leaveRun = true;
          logStep({ kind: 'failed', agent: order[svc], attempt: tries, why: 'timeout-alive' });
          say('  에이전트 실행이 정한 시간 안에 끝나지 않았고, 띄운 프로그램이 아직 남아 있습니다.');
          note = '에이전트가 띄운 프로그램이 아직 끝나지 않아 여기서 멈췄습니다(되돌리기도 하지 않았습니다).'; break;
        }
        try { sealPoint(point, { now: now() }); } catch {} // 이 방법이 남긴 상태를 한 번 적는다(되돌릴 때 "이 방법이 남긴 것"인지 가리는 근거)
        // 나빠졌을 때: 이 방법의 변경을 되돌리고 그 뒤의 상태를 다시 검진한다. → 계속할 수 있으면 true
        const undo = async (why, did) => { if (!restoreThis()) { outcome = 'conflict'; halt = halt || '되돌리다 충돌이 나'; return false; } history.push({ attempt: tries, by: order[svc], did, result: why }); const re = await diagNow(); if (re) current = re; return true; };
        if (!t.ok) {
          logStep({ kind: 'failed', agent: order[svc], attempt: tries, why: t.why });
          say(`  에이전트 실행을 끝내지 못했습니다 — ${AGENT_WHY[t.why] || '까닭을 알 수 없음'}.`);
          // 끊긴 실행이 무엇을 바꿨는지 다시 검진으로 본다. 나빠졌으면 되돌린다.
          const re = await diagNow();
          const v = re ? assess(re) : null;
          if (v?.verdict === 'worse') { say(`  끊긴 뒤 다시 검진하니 나빠진 항목이 있습니다(${v.worse.length}개).`); if (!(await undo(`실행이 끝나지 않았고 나빠져서 되돌림(${AGENT_WHY[t.why] || '모름'})`, []))) break; }
          else { if (re) current = re; history.push({ attempt: tries, by: order[svc], did: [], result: `실행이 끝나지 않음(${AGENT_WHY[t.why] || '모름'})` }); }
          if (halt) { note = `${halt} 멈췄습니다(새 변경을 시작하지 않았습니다).`; break; } // 이미 섰으면 다른 계정으로 넘어간다고 말하지 않는다(결과 표의 계정 이름도 실제로 돈 계정 그대로)
          if (svc + 1 < order.length) { svc++; say(`[알림] ${NAME[order[svc]]} 계정으로 넘어가 이어서 합니다.`); continue; }
          note = '에이전트를 더 부를 수 없습니다.'; break;
        }
        for (const d of t.result.did.slice(0, 8)) say(`  · 한 일: ${d}`);
        const after = await diagNow();
        const v = after ? assess(after) : null;
        if (after) { try { kase.saveJson(`after-agent-${tries}.json`, after); } catch {} }
        try { kase.step({ kind: 'verdict', agent: order[svc], attempt: tries, verdict: v?.verdict ?? null, did: t.result.did.length }, now()); } catch { note = '진료 기록을 남기지 못해 멈췄습니다.'; halt = halt || note; break; }
        if (v?.verdict === 'worse') {
          say(`  다시 검진하니 나빠진 항목이 있습니다(${v.worse.length}개) — 이 방법의 변경을 되돌립니다.`);
          if (!(await undo('나빠져서 되돌림', t.result.did))) break;
        } else {
          if (after) current = after;
          say(`  검진: ${v ? VERDICT_KO[v.verdict] || v.verdict : '다시 하지 못함'}`);
          if (!goals.length) { outcome = 'unverified'; note = t.result.note || '검진에는 잡히지 않는 문제라 검진으로 가릴 수 없습니다 — 직접 확인해 주세요.'; break; }
          let settled = false;
          if (v?.verdict === 'improved') {
            // 한 번 더 검진해 그대로인지 본다(잠깐 나아 보인 것을 "해결"이라 하지 않게). 두 번째 검진에서 나빠졌으면 — 늦게 드러난 고장 — 똑같이 되돌린다.
            const again = await diagNow(); const v2 = again ? assess(again) : null;
            if (v2?.verdict === 'worse') {
              say(`  한 번 더 검진하니 나빠진 항목이 있습니다(${v2.worse.length}개) — 이 방법의 변경을 되돌립니다.`);
              if (!(await undo('처음에는 나아 보였지만 다시 검진하니 나빠져서 되돌림', t.result.did))) break;
              settled = true;
            } else {
              if (again) current = again;
              outcome = v2?.verdict === 'improved' ? 'resolved' : 'improved'; note = v2?.verdict === 'improved' ? '검진을 두 번 해 모두 정상입니다.' : '한 번은 정상이었지만 다시 확인하지 못했습니다.'; break;
            }
          }
          if (!settled) {
            if (v?.verdict === 'partly') outcome = 'improved';
            history.push({ attempt: tries, by: order[svc], did: t.result.did, result: v ? VERDICT_KO[v.verdict] || v.verdict : '검진을 다시 하지 못함' });
          }
        }
        const didKey = JSON.stringify(t.result.did);
        if (!t.result.more) { note = '에이전트가 더 해 볼 다른 방법이 없다고 했습니다.'; break; }
        if (t.result.did.length && didKey === lastDid) { note = '같은 방법을 되풀이해 멈췄습니다.'; break; }
        lastDid = didKey;
      }
      if (!note && tries >= MAX_AGENT_RUNS) note = `방법 ${MAX_AGENT_RUNS}가지를 해 보았지만 고치지 못했습니다 — 다시 [1]을 누르면 이어서 할 수 있습니다.`;
      const denied = (() => { try { return run.denied(); } catch { return {}; } })();
      const dn = Object.values(denied).reduce((a, b) => a + b, 0);
      const seen = (() => { try { return run.calls(); } catch { return null; } })(); // 가드가 본 도구 호출 수(원인 찾기 + 치료) — 0 이면 가드가 불리지 않은 것이라 기록으로 남긴다
      logStep({ kind: 'guard', calls: seen ?? null, duringTreat: seen != null && seenAtStart != null ? seen - seenAtStart : null, denied });
      if (dn) say(`  가드가 거절한 명령: ${dn}건(에이전트는 다른 방법을 썼습니다).`);
      results.push({ rx: { id: `agent:${order[svc]}`, title: title() }, outcome, note });
      for (const h of agentPlan.human) say(` 사람 손이 필요한 일 — ${h}`);
      // 에이전트가 고친 뒤에야 할 수 있게 된 기계 처방이 있으면 이어서 한다(에이전트는 계속 켜져 있어야 하는 프로그램 — 중계기 등 — 을 직접 켜지 않는다: 에이전트가 띄운 것은 치료가 끝날 때 함께 끝난다)
      // 시작 조건(코덱스 검토 지적): 안전 때문에 멈췄거나(halted) · 되돌리다 충돌했거나 · 띄운 것이 남아 있거나 · 지킴이가 걸렸거나 · 마지막 검진이 실패해 표가 낡았으면 하지 않는다.
      //   나빠진 방법을 온전히 되돌리고 새 검진까지 성공한 경우에는 한다. 고를 때는 "앞에서 해결됐던 처방인가"가 아니라 **지금 검진표에서 필요한가**(applies)만 본다.
      //   여기서 서면 그 까닭을 halt 에 남긴다 — 끝의 전체 판정이 "남은 일이 있을 수 있다"를 알도록(코덱스 검토 지적: 후속 패스가 서도 전체가 「해결」로 나오던 길).
      if (!halt && outcome !== 'conflict' && !leaveRun && !(lock.touch(now()) && upd.mine())) halt = '치료 잠금을 더 쥐고 있지 못해';
      if (!halt && outcome !== 'conflict' && !leaveRun && (await mayChange())) {
        let again = null; try { again = await planPrescriptions({ report: current, ctx: tctx, ...(list ? { list } : {}), deps }); } catch {}
        const post = again?.ready || [];
        if (post.length) { say(''); say(' 에이전트 치료 뒤에 기계 처방으로 할 수 있는 일이 있어 이어서 합니다.'); await runMachine(post); }
      }
    }

    // ── 8. 결과 한 장
    // 같은 처방을 두 번 돌렸으면(에이전트 치료 뒤 후속 패스) 전체 판정은 **마지막 결과**로 한다 — 앞의 실패가 뒤의 해결을 가리지 않게. 화면의 목록은 한 순서대로 다 보인다.
    const last = [...new Map(results.map((r) => [r.rx.id, r])).values()];
    const any = (o) => last.some((r) => r.outcome === o);
    const tried = last.filter((r) => r.outcome !== 'skipped');
    // 안전 때문에 선 것(halt)이 있으면 — 처음 기계 처방에서든 · 에이전트 치료에서든 · 후속 패스에서든 — 시작하지 못한 변경이 있을 수 있으므로 「해결」이라 하지 않는다
    const overall = !stopped && !halt && tried.length && tried.every((r) => r.outcome === 'resolved') ? 'resolved' : any('resolved') || any('improved') || any('unverified') ? 'improved' : 'unresolved';
    const state = any('conflict') ? 'conflict' : overall === 'resolved' ? 'resolved' : overall === 'improved' ? 'improved' : any('rolled-back') ? 'rolled-back' : 'unresolved';
    try { kase.set(state, { results: results.map((r) => ({ id: r.rx.id, outcome: r.outcome })) }, now()); } catch {}
    const OUT_KO = { resolved: '해결', improved: '나아짐(검진으로 다 가리지 못함)', unverified: '했지만 검진으로 가릴 수 없음(직접 확인 필요)', unresolved: '미해결', 'rolled-back': '되돌림', conflict: '되돌리다 충돌', skipped: '하지 않음', 'not-started': '시작하지 않음' };
    say(''); say(LINE); say(` 치료 결과: ${OUT_KO[overall]}`); say(LINE);
    for (const r of results) say(`  · ${r.rx.title}: ${OUT_KO[r.outcome]}${r.note ? ` — ${r.note}` : ''}`);
    if (stopped) for (const p of plan.ready.slice(results.length)) say(`  · ${p.rx.title}: 시작하지 않음(도중에 멈춤)`);
    if (halt) say(` [알림] ${halt} 도중에 멈췄습니다 — 시작하지 못한 일이 있을 수 있어 「해결」로 보지 않습니다. 다시 [1]을 누르면 이어서 할 수 있습니다.`);
    const still = (current.findings || []).filter((f) => f.state === 'bad');
    if (still.length) { say(' 아직 고장으로 남은 항목:'); for (const f of still.slice(0, 8)) say(`  · ${f.title} — ${f.summary}`); }
    // 치료 중에 이미 고쳐진 일은 다시 시키지 않는다(2026-11-26 시험장: 에이전트가 프로그램을 다시 깔아 해결했는데도 "설치 프로그램을 다시 실행해 주세요"가 나왔다)
    //   "해결"은 그 안내를 낳은 항목이 **마지막 변경 뒤의 검진에서 정상으로 확인된** 때만 말한다. 항목이 모름이 됐거나 · 표에서 빠졌거나 · 표가 낡았으면 "확인하지 못했다"고 하고 안내는 그대로 준다.
    const stateOf = (id) => (current.findings || []).find((f) => f.id === id)?.state;
    for (const h of plan.human) {
      const needs = (current.findings || []).some((f) => f.fix === h.id && (f.state === 'bad' || f.state === 'warn')) || (h.ids || []).some((id) => ['bad', 'warn'].includes(stateOf(id)));
      const cleared = !needs && !stale && (h.ids || []).length > 0 && h.ids.every((id) => stateOf(id) === 'ok');
      say(needs ? ` 사람 손이 필요한 일 — ${h.title}: ${h.guide}` : cleared ? ` ${h.title}: 치료 중에 해결되어 따로 하실 일이 없습니다.` : ` ${h.title}: 해결됐는지 확인하지 못했습니다 — 아직 안 되면: ${h.guide}`);
    }
    say(` 진료 기록: ${kase.dir}`);
    note({ root: ctx.root, kind: 'treat-end', from: 'treat', case: kase.id, outcome: overall, now: now() });
    return { outcome: overall, caseId: kase.id };
  } catch {
    try { kase?.set('interrupted', {}, now()); } catch {}
    if (kase) note({ root: ctx.root, kind: 'treat-end', from: 'treat', case: kase.id, outcome: 'interrupted', now: now() });
    say('치료가 도중에 멈췄습니다 — 한 일은 진료 기록에 남아 있습니다.');
    return { outcome: 'failed', caseId: kase?.id };
  } finally {
    clearInterval(beat); upd.release(); lock.release(); drop();
  }
}

export const MAX_AGENT_RUNS = 4;
const NAME = { claude: '클로드', codex: '코덱스' };
const AGENT_WHY = { 'no-card': '연결된 계정이 없음', blocked: '띄우기 전 자기 점검에서 멈춤', timeout: '정한 시간 안에 끝나지 않음', failed: '에이전트 프로그램이 오류로 끝남(한도 · 인증 · 통신 문제일 수 있음)', unparsed: '답의 모양을 읽지 못함' };

const TIMEOUT = Symbol('timeout');
const withLimit = (p, ms) => { let t; return Promise.race([Promise.resolve(p), new Promise((r) => { t = setTimeout(() => r(TIMEOUT), ms); t.unref?.(); })]).finally(() => clearTimeout(t)); };
const pointNames = (caseDir) => { try { return fs.readdirSync(path.join(caseDir, 'points')).filter((x) => /^\d{3}-/.test(x)).sort(); } catch { return []; } };
const countPoints = (caseDir) => pointNames(caseDir).length;
/** n 번째 뒤에 만든 복원점만 거꾸로 되돌린다. */
function restoreSince(caseDir, n) {
  const names = pointNames(caseDir).slice(n).reverse();
  if (!names.length) return { ok: true, points: [] };
  const points = names.map((nm) => ({ name: nm, ...restorePoint(path.join(caseDir, 'points', nm)) }));
  return { ok: points.every((p) => p.ok), points };
}

/**
 * 진료 기록 하나의 변경을 모두 되돌린다(사람이 고를 때). 치료와 같은 잠금 둘을 쥐고 한다(치료 · 업데이트와 겹치지 않게).
 * → { ok, points } | { ok:false, why: 'no-case' | 'busy' }
 */
export function rollbackCase({ root, id, now = Date.now() }) {
  const kase = loadCase({ root, id });
  if (!kase) return { ok: false, why: 'no-case' };
  const lock = acquireFileLock(path.join(doctorPaths(root).home, 'treat.lock'), { now, abandonMs: TREAT_LOCK_ABANDON_MS });
  if (!lock.ok) return { ok: false, why: 'busy' };
  const upd = holdUpdateLock(root, { now });
  if (!upd.ok) { lock.release(); return { ok: false, why: 'busy' }; }
  try {
    try { kase.set('restoring', {}, now); } catch {}
    const r = restoreAll(kase.dir);
    try { kase.step({ kind: 'restored-all', ok: r.ok }, now); kase.set(r.ok ? 'rolled-back' : 'conflict', {}, now); } catch {}
    return { ok: r.ok, points: r.points };
  } finally { upd.release(); lock.release(); }
}
