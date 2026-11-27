// IRIS Doctor — 창 안에서 Doctor 를 "바깥 터미널"로 띄우는 길(걸음 ⑦의 창 안 입구가 부른다).
// Doctor 는 창 · 데몬 · 세션의 자식이면 안 된다(「전부 종료」가 세션이 띄운 프로세스를 번호로 끝낸다). 그래서 탐색기에게 대신 열어 달라고 한다:
//   explorer.exe "<…>\IRIS Doctor.cmd"   — 인자 하나. 명령 글을 이어 붙여 만들지 않는다.
// 탐색기가 열어 준다고 해서 "떴다"는 증거는 아니다(연결 프로그램이 바뀌었거나 실행 제한에 걸리면 조용히 안 뜬다).
// 그래서 **Doctor 가 스스로 남기는 표시**(임시 폴더의 iris-doctor-session-<번호>.json)를 기다려 확인하고, 안 뜨면 부른 쪽이 "바탕화면의 IRIS Doctor 를 열어 주세요"를 안내한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const START_FILE = 'IRIS Doctor.cmd';

/** 지금 떠 있는 Doctor 세션의 표시들. since(밀리초) 뒤에 뜬 것만. → [{ pid, ppid, startedAt }] */
export function listSessions({ since = 0, tmp = os.tmpdir() } = {}) {
  const out = [];
  let names; try { names = fs.readdirSync(tmp); } catch { return out; }
  for (const n of names) {
    if (!/^iris-doctor-session-\d+\.json$/.test(n)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(tmp, n), 'utf8'));
      const t = Date.parse(j.startedAt);
      if (Number.isInteger(j.pid) && Number.isFinite(t) && t >= since) out.push({ pid: j.pid, ppid: Number.isInteger(j.ppid) ? j.ppid : null, startedAt: j.startedAt });
    } catch {}
  }
  return out;
}

/**
 * Doctor 를 바깥 터미널로 띄우고, 실제로 떴는지 기다려 확인한다.
 * → { ok:true, pid, ppid } | { ok:false, why: 'start-file-missing' | 'spawn' | 'no-response' }
 */
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

export async function openDoctorWindow({ doctorDir, timeoutMs = 20_000, spawnFn = spawn, tmp = os.tmpdir(), mono = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isAlive = pidAlive, systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  const file = path.join(doctorDir, START_FILE);
  try { if (!fs.statSync(file).isFile()) return { ok: false, why: 'start-file-missing' }; } catch { return { ok: false, why: 'start-file-missing' }; }
  // 띄우기 전에 이미 있던 표시(먼저 떠 있는 Doctor · 비정상 종료로 남은 것)는 "이번에 뜬 것"으로 치지 않는다 — 시각이 아니라 번호로 가른다(시계가 바뀌어도 속지 않게)
  const before = new Set(listSessions({ tmp }).map((s) => s.pid));
  try {
    const child = spawnFn(path.join(systemRoot, 'explorer.exe'), [file], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    child.on?.('error', () => {});
    child.unref?.();
  } catch { return { ok: false, why: 'spawn' }; }
  const until = mono() + timeoutMs; // 기다림은 벽시계가 아니라 흐른 시간으로 잰다
  while (mono() < until) {
    // 새로 생긴 표시 + 그 프로세스가 지금 살아 있음(표시에 적힌 시각은 보지 않는다 — 기다리는 사이 벽시계가 바뀌어도 놓치지 않게)
    const hit = listSessions({ tmp }).find((s) => !before.has(s.pid) && isAlive(s.pid));
    if (hit) return { ok: true, pid: hit.pid, ppid: hit.ppid };
    await sleep(300);
  }
  return { ok: false, why: 'no-response' };
}

/**
 * `iris-doctor open` 의 답(JSON 한 줄이 된다) — 번호 · 경로를 싣지 않는다. → { ok, why?, others }
 * 이미 떠 있는 Doctor 가 있어도 막지 않는다: 표시 파일만으로는 "같은 설치본의 멀쩡한 창"임을 보장할 수 없고(낡은 표시 · 번호 재사용 · 멎은 창),
 * 거짓 "이미 열림"은 먹통일 때 Doctor 를 못 여는 고장이 된다. 치료가 겹치는 것은 치료 잠금이 막는다.
 * others = 띄우기 전에 살아 있던 Doctor 창의 수(화면이 "이미 열려 있던 창이 있습니다"를 알리는 데만 쓴다).
 */
export async function openCommand(o = {}) {
  const isAlive = o.isAlive || pidAlive;
  let others = 0; try { others = listSessions({ tmp: o.tmp }).filter((s) => isAlive(s.pid)).length; } catch {}
  let r; try { r = await openDoctorWindow(o); } catch { r = { ok: false, why: 'failed' }; }
  return r.ok ? { ok: true, others } : { ok: false, why: ['start-file-missing', 'spawn', 'no-response'].includes(r.why) ? r.why : 'failed', others };
}
