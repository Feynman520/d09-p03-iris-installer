// IRIS Doctor — 기록 장부(2026-11-26 사용자 지정: "IRIS Doctor 기록은 전부 로컬에 항상 잘 기록").
// Doctor 가 한 일을 모두 이 PC 의 Doctor 집에만 남긴다 — 바깥으로 보내지 않고, 스스로 지우지 않는다.
//   <Doctor 집>\records\journal.jsonl           한 일 한 줄씩(검진 · 창 열고 닫기 · 계정 연결 · 연결 확인 · 치료 시작과 끝)
//   <Doctor 집>\records\checkups\<시각-번호>.json  검진표 전체(검진할 때마다 한 장)
//   <Doctor 집>\records\<날짜시각-번호>\           치료 한 번의 진료 기록 · 사본(lib\treat\record.mjs)
// 지킬 것: 적는 칸은 정해 둔 것만(열쇠 · 계정 이름 · 명령 글 · 오류 원문을 싣지 않는다 — 검진표는 이미 가려져 나온다) · 적지 못해도 부른 일을 멈추지 않는다(false 를 돌려줄 뿐) ·
//         장부 줄은 덧붙이기만 한다(고치거나 지우지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { doctorPaths } from './home.mjs';

export const KINDS = ['checkup', 'checkup-failed', 'open', 'close', 'link', 'probe', 'treat-start', 'treat-end'];
const FROM = ['window', 'terminal', 'treat', 'cli'];
const WORD = /^[a-z0-9][a-z0-9:._-]{0,59}$/i;
const word = (v) => (typeof v === 'string' && WORD.test(v) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 && v < 100000 ? v : null);

export const journalFile = (root) => path.join(doctorPaths(root).records, 'journal.jsonl');
const checkupDir = (root) => path.join(doctorPaths(root).records, 'checkups');
const stampId = (now) => `${new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')}-${crypto.randomBytes(3).toString('hex')}`;

/** 장부에 한 줄. 허용한 칸만 옮겨 적는다. → 적었으면 true */
export function note({ root, kind, now = Date.now(), ...f }) {
  if (!root || !KINDS.includes(kind)) return false;
  const line = { at: new Date(now).toISOString(), kind };
  for (const k of ['from', 'service', 'what', 'outcome', 'why', 'case', 'checkup']) { const v = word(f[k]); if (v) line[k] = v; }
  if (line.from && !FROM.includes(line.from)) delete line.from;
  if (typeof f.ok === 'boolean') line.ok = f.ok;
  for (const k of ['okCount', 'warn', 'bad', 'unknown', 'skipped']) { const v = count(f[k]); if (v !== null) line[k] = v; }
  if (Array.isArray(f.badIds)) line.badIds = f.badIds.map(word).filter(Boolean).slice(0, 20);
  try { const file = journalFile(root); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify(line)}\n`); return true; } catch { return false; }
}

/** 검진표 한 장을 남기고 장부에 한 줄 적는다. → { ok, id } (검진표를 남기지 못해도 장부 한 줄은 적어 본다) */
export function saveCheckup({ root, report, from = 'cli', now = Date.now() }) {
  if (!root || !report || !Array.isArray(report.findings)) return { ok: false, id: null };
  const id = stampId(now); let saved = false;
  try { const dir = checkupDir(root); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(report, null, 2), { flag: 'wx' }); saved = true; } catch {}
  const n = (st) => report.findings.filter((x) => x.state === st).length;
  const noted = note({ root, kind: 'checkup', now, from, ...(saved ? { checkup: id } : {}), okCount: n('ok'), warn: n('warn'), bad: n('bad'), unknown: n('unknown'), skipped: n('skipped'), badIds: report.findings.filter((x) => x.state === 'bad').map((x) => x.id) });
  return { ok: saved && noted, id: saved ? id : null };
}

/** 장부의 마지막 줄들(새것이 앞). 깨진 줄은 건너뛴다. */
export const listJournal = (o = {}) => readJournal(o).items;

/** 장부를 읽는다 — "아직 기록이 없음"(파일 없음)과 "읽지 못함"(권한 · 손상)을 가린다. → { ok, items } */
export function readJournal({ root, limit = 30 } = {}) {
  let text = '';
  try { text = fs.readFileSync(journalFile(root), 'utf8'); } catch (e) { return { ok: e?.code === 'ENOENT', items: [] }; }
  return { ok: true, items: parseJournal(text, limit) };
}
function parseJournal(text, limit) {
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < Math.max(1, Math.min(500, limit)); i--) {
    if (!lines[i]) continue;
    try { const j = JSON.parse(lines[i]); if (j && KINDS.includes(j.kind) && typeof j.at === 'string') out.push(j); } catch {}
  }
  return out;
}

/** 남긴 검진표 한 장을 읽는다(이름은 정해 둔 모양만). */
export function loadCheckup({ root, id }) {
  if (!/^\d{8}-\d{6}-[0-9a-f]{6}$/.test(String(id))) return null;
  try { const j = JSON.parse(fs.readFileSync(path.join(checkupDir(root), `${id}.json`), 'utf8')); return j && Array.isArray(j.findings) ? j : null; } catch { return null; }
}
