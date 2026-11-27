// IRIS Doctor — 자기 파일 지킴이. Doctor 가 띄운 에이전트가 (실수로) Doctor 의 프로그램 파일을 고치면 알아채고 되돌린다.
//
// 무엇을 보장하고 무엇을 보장하지 않는가(정직하게):
//   · 에이전트는 Doctor 와 같은 윈도우 사용자로 돈다 — 디스크 위의 파일은 원리상 무엇이든 고칠 수 있다.
//   · 그래서 Doctor 는 시작할 때 자기 프로그램 파일을 **이 프로세스의 메모리**에 읽어 둔다. 메모리는 "고칠 수 없는 자리"가 아니라
//     **평소의 파일 고치기로는 닿지 않는 자리**다(다른 프로세스의 메모리를 일부러 고치는 것까지 막지는 못한다).
//   · 메모리의 사본은 **이 실행 동안 일어난 변경만** 되돌린다. 시작할 때 이미 깨져 있던 것은 되돌리지 못한다(그것은 배포본으로 복구한다).
//   · Doctor 가 끝난 뒤의 변경은 여기서 못 본다 — 다음 시작 때 배포본의 지문 목록과 견주는 일(설치본)과, Doctor 없이 읽는 복구 안내가 그 몫이다.
//   · 목표는 "헛디뎌서 보호 장치를 망가뜨리지 않게"이지, 악의를 가진 공격자를 막는 것이 아니다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// 지키는 것: 실행 입구 · 시작 파일 · 안내 글 · 프로그램 폴더. 지키지 않는 것: 시험 · 이 PC 만의 자리 표 · 저장소 기록.
const TOP_FILES = ['iris-doctor.mjs', 'IRIS Doctor.cmd'];
const DIRS = ['lib', 'guide'];
const MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024;

function listFiles(dir) {
  const out = [];
  for (const f of TOP_FILES) { try { if (fs.statSync(path.join(dir, f)).isFile()) out.push(f); } catch {} }
  const walk = (rel) => {
    let names; try { names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const n of names) { const r = path.join(rel, n.name); if (n.isDirectory()) walk(r); else if (n.isFile()) out.push(r); }
  };
  for (const d of DIRS) walk(d);
  return out.sort();
}

/** 배포에 싣는 파일 목록(= 지킴이가 지키는 파일과 같다). 묶음 만들기(tools\pack.mjs)가 쓴다. */
export const shipFiles = (dir) => listFiles(dir);

/**
 * 배포본의 지문 목록(manifest.json — 묶음을 만들 때 함께 넣는다)과 지금의 프로그램 파일을 견준다. Doctor 가 시작할 때 한 번 본다:
 * 메모리의 사본은 "이 실행 동안의 변경"만 되돌리므로, **시작하기 전에 이미 바뀐 것**은 이것으로 알아챈다(되돌리지는 못한다 — 복구는 설치 프로그램으로).
 * → { known:false }(목록이 없음 — 개발 폴더) | { known:true, ok, changed: […], missing: […], added: […], version }
 */
export function checkShipped(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return { known: false }; // 목록이 없음 = 개발 폴더
  // 목록이 있는데 읽지 못하거나 모양이 틀리면: "개발 폴더"로 조용히 넘기지 않는다 — 대조하지 못했다는 것 자체가 알릴 일이다
  const broken = { known: true, ok: false, broken: true, changed: [], missing: [], added: [], version: null };
  let m; try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return broken; }
  if (!m || !Array.isArray(m.files) || !m.files.length || !m.files.every((f) => f && typeof f.path === 'string' && typeof f.sha256 === 'string')) return broken;
  const want = new Map(m.files.map((f) => [String(f.path).replace(/\//g, path.sep), String(f.sha256)]));
  const changed = [], missing = [], added = [];
  const now = new Set(listFiles(dir));
  for (const [rel, hash] of want) { if (!now.has(rel)) { missing.push(rel); continue; } try { if (sha(fs.readFileSync(path.join(dir, rel))) !== hash) changed.push(rel); } catch { changed.push(rel); } }
  for (const rel of now) if (!want.has(rel)) added.push(rel);
  return { known: true, ok: !changed.length && !missing.length && !added.length, changed, missing, added, version: m.version ?? null };
}

/** 지금의 프로그램 파일을 메모리에 읽어 둔다. → { dir, files: Map(상대 경로 → { hash, data }), bytes, skipped: [너무 큰 파일…] } */
export function snapshot(dir) {
  const files = new Map(); const skipped = []; let bytes = 0;
  for (const rel of listFiles(dir)) {
    try {
      const data = fs.readFileSync(path.join(dir, rel));
      if (data.length > MAX_FILE || bytes + data.length > MAX_TOTAL) { skipped.push(rel); continue; }
      files.set(rel, { hash: sha(data), data }); bytes += data.length;
    } catch { skipped.push(rel); }
  }
  return { dir, files, bytes, skipped };
}

/** 지금의 파일을 사본과 견준다. → { ok, changed: [바뀜…], missing: [없어짐…], added: [새로 생김…] } */
export function verify(snap) {
  const changed = [], missing = [], added = [];
  const now = new Set(listFiles(snap.dir));
  for (const [rel, f] of snap.files) {
    if (!now.has(rel)) { missing.push(rel); continue; }
    try { if (sha(fs.readFileSync(path.join(snap.dir, rel))) !== f.hash) changed.push(rel); } catch { changed.push(rel); }
  }
  for (const rel of now) if (!snap.files.has(rel) && !snap.skipped.includes(rel)) added.push(rel);
  return { ok: !changed.length && !missing.length && !added.length, changed, missing, added };
}

/**
 * 바뀐 것 · 없어진 것을 메모리의 사본으로 되돌린다. 새로 생긴 파일은 지우지 않고 옆으로 비켜 둔다(이름 끝에 .doctor-aside — 프로그램이 읽지 않는다).
 * → { ok, restored: […], aside: […], failed: […] }   ok=false 면 되돌리지 못한 것이 있다 — 부른 쪽은 치료를 멈추고 검진 · 안내만 남긴다.
 */
export function restore(snap, diff) {
  const restored = [], aside = [], failed = [];
  for (const rel of [...diff.changed, ...diff.missing]) {
    const f = snap.files.get(rel); const file = path.join(snap.dir, rel);
    const tmp = `${file}.${process.pid}.restore`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, f.data); fs.renameSync(tmp, file);
      if (sha(fs.readFileSync(file)) !== f.hash) throw new Error('mismatch');
      restored.push(rel);
    } catch { try { fs.rmSync(tmp, { force: true }); } catch {} failed.push(rel); }
  }
  for (const rel of diff.added) {
    const file = path.join(snap.dir, rel);
    try { fs.renameSync(file, `${file}.doctor-aside`); aside.push(rel); } catch { failed.push(rel); }
  }
  return { ok: !failed.length, restored, aside, failed };
}

/**
 * node 실행 파일의 지문(바뀌었는지만 본다 — 되돌리지는 못한다. 복구는 배포본으로). 못 읽으면 null.
 * 크기와 고친 시각만 본다 — 수십 MB 를 통째로 읽으면 차림표가 뜨기 전에 시간이 걸린다(저장 장치가 느린 PC).
 */
export function fileFingerprint(file) {
  try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return null; }
}

// Doctor 프로그램의 판 번호(프로그램 글에서 읽는다) — 실행 중에 판이 바뀌었으면 누가 헛디딘 것이 아니라 업데이트다
const versionOf = (buf) => { const m = /VERSION\s*=\s*['"]([^'"]+)['"]/.exec(String(buf || '')); return m ? m[1] : null; };
const VERSION_FILE = path.join('lib', 'diagnose.mjs');

/**
 * 지킴이 하나. check() 를 에이전트 실행이 끝날 때마다 부른다.
 * → { ok:true } | { ok:false, restored, aside, failed, nodeChanged } | { ok:false, updated:true }
 *   failed 가 있거나 nodeChanged · updated 면 치료를 멈춘다(tripped).
 *   updated = 업데이트가 진행 중이거나(updating() 이 참) 디스크의 판 번호가 달라짐 → **되돌리지 않는다**(새 판을 옛 판으로 덮거나 두 판이 섞이지 않게).
 */
export function makeGuard({ dir, nodePath = process.execPath, updating = () => false } = {}) {
  const snap = snapshot(dir);
  const nodePrint = fileFingerprint(nodePath);
  const myVersion = versionOf(snap.files.get(VERSION_FILE)?.data);
  const versionChanged = () => { try { const v = versionOf(fs.readFileSync(path.join(dir, VERSION_FILE))); return !!v && !!myVersion && v !== myVersion; } catch { return false; } };
  const guard = {
    files: snap.files.size, bytes: snap.bytes, skipped: snap.skipped, tripped: false,
    check() {
      const diff = verify(snap);
      const nodeChanged = nodePrint !== null && fileFingerprint(nodePath) !== nodePrint;
      if (diff.ok && !nodeChanged) return { ok: true };
      let upd = false; try { upd = !!updating(); } catch {}
      if (upd || versionChanged()) { guard.tripped = true; return { ok: false, updated: true, restored: [], aside: [], failed: [], nodeChanged }; }
      const r = diff.ok ? { ok: true, restored: [], aside: [], failed: [] } : restore(snap, diff);
      if (!r.ok || nodeChanged) guard.tripped = true;
      return { ok: false, restored: r.restored, aside: r.aside, failed: r.failed, nodeChanged };
    },
  };
  return guard;
}
