// IRIS Doctor — 잠금 파일 하나로 "한 번에 하나만". 연결 잠금(lib\link.mjs)과 치료 잠금(lib\treat)이 같은 방식을 쓴다.
//   · 잠금 파일은 내용까지 쓴 임시 파일을 "이름 하나 더 붙이기"로 올린다 — 이미 있으면 실패하고, 빈 잠금 파일이 보이는 틈이 없다.
//   · 살아 있는 주인의 잠금은 빼앗지 않는다. 버려진 잠금 = 주인 프로세스가 없거나, abandonMs 를 넘기도록 소식(at)이 없는 것.
//     (오래 쥐는 일은 touch() 로 소식을 새로 적는다.) 못 읽는 잠금은 1분 넘게 그대로일 때만 버려진 것으로 본다.
//   · 버려진 잠금은 지우지 않고 옮긴 뒤 "내가 본 그 잠금"이 맞는지 확인한다(그 사이 다른 실행이 새로 잡은 잠금을 지우지 않게).
//   · 풀 때는 내 잠금일 때만 지운다.
import fs from 'node:fs';
import crypto from 'node:crypto';

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// 치료 잠금(<Doctor 집>\treat.lock): 소식(5분마다 새로 적음)이 20분 넘게 없으면 버려진 것. 치료 흐름(lib\treat\flow.mjs)이 쥐고,
// 손 없는 계정 준비(lib\link.mjs)가 "지금 치료 중인가"를 읽기만 한다 — 그래서 값은 두 쪽이 함께 보는 여기에 둔다.
export const TREAT_LOCK_ABANDON_MS = 20 * 60_000;

/**
 * 그 잠금이 **지금 살아 있는가** — 읽기만 한다(잡지 않고 · 옮기지 않고 · 만들지 않는다).
 * 판정은 acquireFileLock 이 "빼앗지 않는다"고 보는 것과 같다: 지금 잡으려 하면 거절당할 잠금 = 살아 있는 잠금.
 * 파일이 없으면 거짓.
 */
export function fileLockLive(file, { now = Date.now(), isAlive = pidAlive, abandonMs } = {}) {
  if (!fs.existsSync(file)) return false;
  const cur = readJson(file);
  if (cur && Number.isInteger(cur.pid) && typeof cur.id === 'string') return isAlive(cur.pid) && (now - Number(cur.at) < abandonMs);
  let age = Infinity; try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { return false; } // 그 사이 사라졌다
  return !(age > 60_000);
}

/** → { ok:true, id, release(), touch(now) } | { ok:false, holder: { pid, at } | null } */
export function acquireFileLock(file, { now = Date.now(), pid = process.pid, isAlive = pidAlive, abandonMs, extra = {} } = {}) {
  const id = `${pid}-${now}-${crypto.randomBytes(6).toString('hex')}`;
  const body = (at) => JSON.stringify({ id, pid, at, ...extra });
  const take = () => {
    const tmp = `${file}.${id}.tmp`;
    try { fs.writeFileSync(tmp, body(now)); fs.linkSync(tmp, file); return true; } catch (e) { if (e?.code === 'EEXIST') return false; throw e; } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
  };
  if (!take()) {
    const cur = readJson(file);
    const wellFormed = !!cur && Number.isInteger(cur.pid) && typeof cur.id === 'string';
    let abandoned;
    if (wellFormed) abandoned = !isAlive(cur.pid) || !(now - Number(cur.at) < abandonMs);
    else { let age = Infinity; try { age = Date.now() - fs.statSync(file).mtimeMs; } catch {} abandoned = age > 60_000; }
    const busy = { ok: false, holder: wellFormed ? { pid: cur.pid, at: cur.at } : null };
    if (!abandoned) return busy;
    const tomb = `${file}.stale-${id}`;
    try { fs.renameSync(file, tomb); } catch { return busy; }
    const moved = readJson(tomb);
    const same = wellFormed ? moved?.id === cur.id : !(moved && typeof moved.id === 'string');
    if (!same) { try { fs.linkSync(tomb, file); } catch {} try { fs.rmSync(tomb, { force: true }); } catch {} return busy; }
    try { fs.rmSync(tomb, { force: true }); } catch {}
    if (!take()) return busy;
  }
  const mine = () => readJson(file)?.id === id;
  return {
    ok: true, id,
    release() { if (mine()) { try { fs.rmSync(file, { force: true }); } catch {} } },
    /** 아직 쥐고 있다는 소식을 새로 적는다(내 잠금일 때만). → 아직 내 잠금인가 */
    touch(at = Date.now()) { if (!mine()) return false; const tmp = `${file}.${id}.touch`; try { fs.writeFileSync(tmp, body(at)); fs.renameSync(tmp, file); return true; } catch { try { fs.rmSync(tmp, { force: true }); } catch {} return mine(); } },
  };
}
