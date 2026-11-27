// IRIS Doctor — 진료 기록. 치료 한 번 = 폴더 하나(<Doctor 집>\records\<날짜시각-번호>\).
//   case.json     지금 상태와 요약(한 번에 바꿔 쓴다)
//   steps.jsonl   한 일마다 한 줄(덧붙이기만 한다) — **바꾸기 전에 "하려는 일"을 먼저 적고**, 한 뒤에 결과를 적는다
//   before.json · after-N.json   검진표      plan.json   치료 계획      points\   단계별 복원점(lib\treat\restore.mjs)
// 규칙: 기록을 남기지 못하면(디스크가 찼거나 권한 문제) 그다음 변경을 시작하지 않는다 — 적는 함수는 실패하면 던진다.
// 기록에는 열쇠 값 · 이메일 원문 · 프로그램이 낸 글의 원문을 싣지 않는다(경로 · 이름 · 지문 · 상태만).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { doctorPaths, writeAtomic, readJsonFile } from '../home.mjs';

// 상태: 열림 → 동의함 → 치료 중 → (해결 | 나아짐 | 미해결 | 되돌림 | 끊김) · 되돌리는 중 / 일부만 되돌림 / 충돌
export const OPEN_STATES = ['open', 'consented', 'treating', 'restoring'];
export const END_STATES = ['resolved', 'improved', 'unresolved', 'rolled-back', 'partly-restored', 'conflict', 'interrupted', 'declined'];
const stamp = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

function handle(root, id) {
  const dir = path.join(doctorPaths(root).records, id);
  const caseFile = path.join(dir, 'case.json');
  const h = {
    id, dir,
    read: () => readJsonFile(caseFile),
    /** 상태를 바꾼다(요약 칸을 함께 적을 수 있다). */
    set(state, extra = {}, now = Date.now()) {
      const cur = readJsonFile(caseFile) || { v: 1, id };
      // 다시 "하는 중" 상태로 들어가면 알림 표시를 지운다(이번에 끊기면 다시 알려야 한다)
      const reopen = OPEN_STATES.includes(state) && extra.noticed === undefined ? { noticed: false } : {};
      writeAtomic(caseFile, JSON.stringify({ ...cur, ...extra, ...reopen, state, updatedAt: new Date(now).toISOString() }, null, 2));
    },
    /** 한 일 한 줄. kind = 'intent'(하려는 일) | 'done' | 'failed' | 'note' … 실패하면 던진다. */
    step(entry, now = Date.now()) {
      const line = JSON.stringify({ at: new Date(now).toISOString(), ...entry }) + '\n';
      const fd = fs.openSync(path.join(dir, 'steps.jsonl'), 'a');
      try { fs.writeSync(fd, line); try { fs.fsyncSync(fd); } catch {} } finally { fs.closeSync(fd); }
    },
    steps() { try { return fs.readFileSync(path.join(dir, 'steps.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } },
    saveJson(name, obj) { if (!/^[a-z0-9-]{1,40}\.json$/.test(name)) throw new Error('bad-name'); writeAtomic(path.join(dir, name), JSON.stringify(obj, null, 2)); },
    loadJson(name) { return /^[a-z0-9-]{1,40}\.json$/.test(name) ? readJsonFile(path.join(dir, name)) : null; },
  };
  return h;
}

/** 새 진료 기록을 연다. 폴더나 첫 기록을 만들지 못하면 던진다(= 치료를 시작하지 않는다). */
export function openCase({ root, now = Date.now(), summary = {} }) {
  const id = `${stamp(now)}-${crypto.randomBytes(3).toString('hex')}`;
  const h = handle(root, id);
  fs.mkdirSync(h.dir, { recursive: true });
  h.set('open', { v: 1, id, createdAt: new Date(now).toISOString(), ...summary }, now);
  h.step({ kind: 'note', what: 'case-opened' }, now);
  return h;
}

/** 있는 기록을 연다(이름이 정해진 모양일 때만). 없으면 null. */
export function loadCase({ root, id }) {
  if (!ID_RE.test(String(id))) return null;
  const h = handle(root, id);
  return h.read() ? h : null;
}

/** 진료 기록 목록(최근 것 먼저). → [{ id, state, createdAt, updatedAt }] */
export function listCases({ root }) {
  const base = doctorPaths(root).records;
  let names; try { names = fs.readdirSync(base); } catch { return []; }
  const out = [];
  for (const n of names.filter((x) => ID_RE.test(x)).sort().reverse()) {
    const c = readJsonFile(path.join(base, n, 'case.json'));
    if (c) out.push({ id: n, state: c.state || 'open', createdAt: c.createdAt || null, updatedAt: c.updatedAt || null, noticed: !!c.noticed });
    else out.push({ id: n, state: 'unreadable', createdAt: null, updatedAt: null });
  }
  return out;
}

/** 끝나지 않은 기록(치료 중에 끊긴 것) 가운데 아직 사용자에게 알리지 않은 것. 알린 뒤에는 noticed 를 적어 되풀이하지 않는다. */
export const listUnfinished = ({ root }) => listCases({ root }).filter((c) => ((OPEN_STATES.includes(c.state) && c.state !== 'open') || c.state === 'interrupted') && !c.noticed);
