// IRIS Doctor — 단계별 복원점. 치료의 변경 하나하나 앞에 "바꾸기 전"을 떠 두고, 되돌릴 때는 **그 치료가 남긴 것일 때만** 되돌린다.
//
// 차례(변경 하나마다):  createPoint(바꾸기 전을 뜨고 읽어 확인) → 변경 → sealPoint(바꾼 뒤의 지문을 적음)
// 되돌리기:  restorePoint — 대상마다
//   · 지금 내용 = 바꾼 뒤의 지문          → 바꾸기 전으로 되돌린다
//   · 지금 내용 = 바꾸기 전               → 할 일 없음
//   · 그 밖(그 뒤 누가 또 바꿈 · 바꾼 뒤 지문을 적기 전에 끊김) → **덮지 않는다.** 바꾸기 전 사본을 conflicts\ 에 따로 두고 '충돌'로 남긴다
//
// 대상의 종류:
//   file    작은 파일 통째(5MB 까지). **열쇠가 들었거나 설정과 열쇠가 섞인 파일은 받지 않는다**(되돌리면 그 사이 갱신된 열쇠를 옛 것으로 덮는다)
//   fields  JSON 파일의 맨 위 칸 몇 개만 — 그 칸의 값만 뜨고 그 칸만 되돌린다(나머지 칸 — 열쇠 · 계정 정보 — 은 지금 것 그대로). 섞인 파일은 이것으로만
//   move    폴더 · 파일 이름 바꾸기(프로그램 폴더를 비켜 두고 다른 것을 넣는 일) — 되돌리기 = 이름을 도로 바꾼다
// 여러 복원점은 만든 차례의 거꾸로 되돌린다(restoreAll).
// 한계: 지문을 확인한 순간과 덮어쓰는 순간 사이에 다른 프로그램이 그 파일을 바꾸면 그 변경은 덮인다(그 틈은 아주 짧지만 0 은 아니다 —
//       그래서 치료는 치료 잠금 안에서, 업데이트가 돌지 않을 때만 한다).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomic, readJsonFile } from '../home.mjs';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MAX_FILE = 5 * 1024 * 1024;
// 통째로 뜨지 않는 파일 이름(열쇠 · 열쇠가 섞인 설정) — fields 로만 다룬다
const SECRETISH = new Set(['.credentials.json', 'auth.json', 'iris-cli-token.json', 'teamclaude.json', '.claude.json', 'claude.json', 'codex.json']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fileState = (file) => { try { const b = fs.readFileSync(file); return { existed: true, sha: sha(b), size: b.length }; } catch (e) { if (e?.code === 'ENOENT') return { existed: false, sha: null, size: 0 }; throw e; } };
const fieldState = (file, fields) => {
  const j = fs.existsSync(file) ? readJsonFile(file) : {};
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null; // 못 읽거나 모양이 다르면 손대지 않는다
  return Object.fromEntries(fields.map((k) => [k, Object.prototype.hasOwnProperty.call(j, k) ? { present: true, value: j[k] } : { present: false }]));
};
/**
 * 옮긴 것(폴더 · 파일)의 지문 — 되돌릴 때 "그때 옮긴 바로 그것"인지 가린다(있는지 없는지만 보면, 그 뒤 업데이트가 같은 자리에 새로 놓은 폴더를 옛 것으로 잘못 알고 옮긴다).
 * 폴더: 바로 아래 항목의 이름 · 종류 · 크기 · 고친 시각 + package.json 의 내용. 파일: 내용. 못 읽으면 null.
 */
export function thingPrint(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return `f:${sha(fs.readFileSync(p))}`;
    const rows = fs.readdirSync(p, { withFileTypes: true }).map((d) => { let s = null; try { s = fs.statSync(path.join(p, d.name)); } catch {} return `${d.name}|${d.isDirectory() ? 'd' : 'f'}|${s && !d.isDirectory() ? s.size : 0}|${s ? Math.round(s.mtimeMs) : 0}`; }).sort();
    let pkg = ''; try { pkg = sha(fs.readFileSync(path.join(p, 'package.json'))); } catch {}
    return `d:${sha(Buffer.from(rows.join('\n') + '\n' + pkg, 'utf8'))}`;
  } catch { return null; }
}
const freeBytes = (dir) => { try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; } };

/**
 * 복원점을 만든다(변경 **전에**). 뜨지 못하면 던진다 — 부른 쪽은 그 변경을 하지 않는다.
 * → { dir, name, targets }   (dir = <진료 기록>\points\<번호>-<이름>)
 */
export function createPoint({ caseDir, name, targets, now = Date.now(), free = freeBytes }) {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error('bad-point-name');
  const base = path.join(caseDir, 'points');
  fs.mkdirSync(base, { recursive: true });
  const n = fs.readdirSync(base).filter((x) => /^\d{3}-/.test(x)).length + 1;
  const dir = path.join(base, `${String(n).padStart(3, '0')}-${name}`);
  fs.mkdirSync(dir);
  const out = []; let need = 0;
  for (const t of targets) {
    if (t.kind === 'file') {
      if (!path.isAbsolute(t.path)) throw new Error('relative-path');
      if (SECRETISH.has(path.basename(t.path).toLowerCase())) throw new Error('secret-file-needs-fields');
      const st = fileState(t.path);
      if (st.size > MAX_FILE) throw new Error('file-too-large'); // 큰 파일을 "빼고" 시작하지 않는다 — 그 변경 자체를 하지 않는다
      need += st.size;
      out.push({ kind: 'file', path: t.path, before: st, copy: st.existed ? `f${out.length}.bin` : null });
    } else if (t.kind === 'fields') {
      if (!path.isAbsolute(t.path) || !Array.isArray(t.fields) || !t.fields.length) throw new Error('bad-fields-target');
      const before = fieldState(t.path, t.fields);
      if (!before) throw new Error('fields-unreadable');
      out.push({ kind: 'fields', path: t.path, fields: [...t.fields], before });
    } else if (t.kind === 'move') {
      if (!path.isAbsolute(t.from) || !path.isAbsolute(t.to)) throw new Error('relative-path');
      out.push({ kind: 'move', from: t.from, to: t.to, before: { fromExisted: fs.existsSync(t.from), toExisted: fs.existsSync(t.to) } });
    } else throw new Error('unknown-target-kind');
  }
  const room = free(dir);
  if (room !== null && room < need * 2 + 20 * 1024 * 1024) throw new Error('no-space'); // 여유가 모자라면 뜨지 않는다(뜨다 만 사본으로 시작하지 않게)
  for (const t of out) {
    if (t.kind !== 'file' || !t.copy) continue;
    const data = fs.readFileSync(t.path);
    if (sha(data) !== t.before.sha) throw new Error('changed-while-copying');
    fs.writeFileSync(path.join(dir, t.copy), data);
    if (sha(fs.readFileSync(path.join(dir, t.copy))) !== t.before.sha) throw new Error('copy-verify-failed'); // 뜬 것을 다시 읽어 확인
  }
  writeAtomic(path.join(dir, 'point.json'), JSON.stringify({ v: 1, name, createdAt: new Date(now).toISOString(), sealed: false, targets: out }, null, 2));
  return { dir, name, targets: out };
}

/** 변경이 끝난 뒤: 바꾼 뒤의 상태를 적는다. 못 적으면 던진다(부른 쪽은 다음 변경으로 넘어가지 않는다). */
export function sealPoint(point, { now = Date.now() } = {}) {
  const file = path.join(point.dir, 'point.json');
  const j = readJsonFile(file);
  if (!j) throw new Error('point-unreadable');
  for (const t of j.targets) {
    if (t.kind === 'file') t.after = fileState(t.path);
    else if (t.kind === 'fields') { const a = fieldState(t.path, t.fields); if (!a) throw new Error('fields-unreadable'); t.after = a; }
    else if (t.kind === 'move') t.after = { fromExists: fs.existsSync(t.from), toExists: fs.existsSync(t.to), print: thingPrint(t.to) };
  }
  j.sealed = true; j.sealedAt = new Date(now).toISOString();
  writeAtomic(file, JSON.stringify(j, null, 2));
  return j;
}

/** 복원점 하나를 되돌린다. → { ok, results: [{ path, result: 'restored' | 'unchanged' | 'conflict' | 'failed' }] }  ok = 충돌 · 실패 없음 */
export function restorePoint(dir) {
  const j = readJsonFile(path.join(dir, 'point.json'));
  if (!j || !Array.isArray(j.targets)) return { ok: false, results: [{ path: dir, result: 'failed' }] };
  const results = [];
  const conflict = (t, note) => {
    // 덮지 않는다. 바꾸기 전 것을 따로 둔다(사람이나 다음 치료가 볼 수 있게).
    try {
      const cdir = path.join(dir, 'conflicts'); fs.mkdirSync(cdir, { recursive: true });
      if (t.kind === 'file' && t.copy) fs.copyFileSync(path.join(dir, t.copy), path.join(cdir, t.copy));
      else if (t.kind === 'fields') writeAtomic(path.join(cdir, `fields-${results.length}.json`), JSON.stringify({ path: t.path, before: t.before }, null, 2));
    } catch {}
    results.push({ path: t.path || t.to, result: 'conflict', note });
  };
  for (const t of [...j.targets].reverse()) {
    try {
      if (t.kind === 'file') {
        const cur = fileState(t.path);
        if (cur.existed === t.before.existed && cur.sha === t.before.sha) { results.push({ path: t.path, result: 'unchanged' }); continue; }
        if (!t.after || cur.existed !== t.after.existed || cur.sha !== t.after.sha) { conflict(t, t.after ? 'changed-since' : 'unsealed'); continue; }
        if (t.before.existed) { const data = fs.readFileSync(path.join(dir, t.copy)); if (sha(data) !== t.before.sha) throw new Error('copy-damaged'); writeAtomic(t.path, data); }
        else fs.rmSync(t.path, { force: true });
        results.push({ path: t.path, result: 'restored' });
      } else if (t.kind === 'fields') {
        const cur = fieldState(t.path, t.fields);
        if (!cur) { conflict(t, 'unreadable'); continue; }
        const j2 = fs.existsSync(t.path) ? readJsonFile(t.path) : {};
        if (!j2 || typeof j2 !== 'object' || Array.isArray(j2)) { conflict(t, 'unreadable'); continue; } // 방금 읽은 사이 바뀌었을 수 있다 — 다시 본다
        let changed = false, clash = false;
        for (const k of t.fields) {
          if (same(cur[k], t.before[k])) continue;
          if (!t.after || !same(cur[k], t.after[k])) { clash = true; continue; } // 그 칸을 그 뒤 누가 또 바꿨다 — 그 칸은 두고 나머지 칸만 되돌린다
          if (t.before[k].present) j2[k] = t.before[k].value; else delete j2[k];
          changed = true;
        }
        if (changed) writeAtomic(t.path, JSON.stringify(j2, null, 2) + '\n');
        if (clash) conflict(t, 'field-changed-since'); else results.push({ path: t.path, result: changed ? 'restored' : 'unchanged' });
      } else if (t.kind === 'move') {
        const fromNow = fs.existsSync(t.from), toNow = fs.existsSync(t.to);
        if (fromNow === t.before.fromExisted && toNow === t.before.toExisted) { results.push({ path: t.to, result: 'unchanged' }); continue; }
        if (!t.after || fromNow !== t.after.fromExists || toNow !== t.after.toExists || fromNow) { conflict(t, 'moved-since'); continue; }
        // 그 자리에 있는 것이 "그때 옮긴 바로 그것"일 때만 도로 옮긴다(그 뒤 업데이트가 새로 놓은 폴더를 옮기지 않는다)
        if (!t.after.print || thingPrint(t.to) !== t.after.print) { conflict(t, 'replaced-since'); continue; }
        fs.renameSync(t.to, t.from);
        results.push({ path: t.to, result: 'restored' });
      }
    } catch { results.push({ path: t.path || t.to, result: 'failed' }); }
  }
  return { ok: !results.some((r) => r.result === 'conflict' || r.result === 'failed'), results };
}

/** 진료 기록의 복원점을 만든 차례의 거꾸로 모두 되돌린다. → { ok, points: [{ name, ok, results }] } */
export function restoreAll(caseDir) {
  const base = path.join(caseDir, 'points');
  let names; try { names = fs.readdirSync(base).filter((x) => /^\d{3}-/.test(x)).sort().reverse(); } catch { return { ok: true, points: [] }; }
  const points = names.map((n) => ({ name: n, ...restorePoint(path.join(base, n)) }));
  return { ok: points.every((p) => p.ok), points };
}
