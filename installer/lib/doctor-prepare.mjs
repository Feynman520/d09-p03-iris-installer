// 손 안 가는 IRIS Doctor 계정 준비(2.0.66) — 설치기가 설치본의 Doctor 에게 `link auto` 를 **한 번** 부른다.
//
// ── 무엇을 부르나 ─────────────────────────────────────────────────────────
// `<동봉 node> <설치 폴더>\_agent\shared\tools\iris-doctor\iris-doctor.mjs link auto`
//   · Doctor 의 "손 없이 되는 준비"다: 클로드는 Doctor 카드가 아예 없고 IRIS 1년 열쇠가 있을 때만 그 사본으로 카드를 만들고,
//     코덱스는 전용 폴더의 설정과 카드 틀이 없을 때만 마련한다. **통신 0 · 실제 확인 호출 0 · 브라우저 0.**
//     만들 것이 없으면 Doctor 는 아무것도 쓰지 않는다(그 약속은 Doctor 원본의 시험이 묶는다).
//   · `probe` · `login` 은 중계기를 거치지 않는 실제 호출이고, `link claude` 는 다른 열쇠를 만나면 실제 확인 호출을 한다
//     — 설치기는 그것들을 **부르지 않는다**. 부르는 것은 아래 DOCTOR_PREPARE_ARGS 하나뿐이다.
//   · 전달 심(shims)을 거치지 않는다(심은 중계기 주소를 넣고 중계기를 켠다). 동봉 node 와 실행 입구를 직접 부른다.
//
// ── 언제 부르지 않나 ──────────────────────────────────────────────────────
//   · Doctor 부품이 없다(실행 입구 없음) · 동봉 node 가 없다
//   · 연습 실행(`IRIS_INSTALLER_NO_USER_ENV=1` / --no-user-env) — 연습 루트에 Doctor 의 집을 만들지 않는다
//     (e2e "두 번 실행 변경 0" · 업그레이드 게이트에 닿지 않는다)
//   · 오프라인 손잡이(`IRIS_INSTALLER_OFFLINE=1`)
//
// ── 설치의 성공 · 실패와 섞지 않는다 ───────────────────────────────────────
// 결과는 **돌려주기만 한다**. 부른 쪽(server.mjs)은 기록 한 줄만 남기고, 설치 완료 판정(영수증의 단계 · resumeVerdict ·
// setupAllDone · onlineDone)과 인수 문서에는 싣지 않는다. Doctor 의 계정 상태는 IRIS 창이 Doctor 에게 직접 묻는다.
// 이 모듈은 **설치 폴더에 아무것도 쓰지 않는다** — `<설치 폴더>\_agent\doctor`(Doctor 의 집)에 쓰는 것은 Doctor 뿐이다.
//
// 실패 · 시간 초과에도 던지지 않는다. 제한 시간이 지나면 우리가 띄운 그 프로세스(와 그 자식)만 번호로 끝낸다.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isOffline } from '../../lib/net.mjs';
import { nodeExeFor, doctorDirFor } from './handoff.mjs';

export const DOCTOR_ENTRY = 'iris-doctor.mjs';
export const DOCTOR_PREPARE_ARGS = Object.freeze(['link', 'auto']);
export const DOCTOR_PREPARE_TIMEOUT_MS = 20_000;
const MAX_OUT = 64 * 1024;

export function doctorEntryFor(root) { return path.join(doctorDirFor(root), DOCTOR_ENTRY); }

// Doctor 에게 넘기는 환경: 윈도우 기본 변수만(허용 목록) + 이 설치 폴더를 가리키는 두 값.
// 열쇠 · 중계기 주소 · 코드 주입 변수(NODE_OPTIONS) · 평소 환경의 설정 폴더는 넘기지 않는다 — 이 PC 의 평소 환경이
// 다른 설치 폴더를 가리키고 있어도(개발 PC · 설치본이 둘인 PC) Doctor 는 **이 설치 폴더의** 1년 열쇠만 본다.
const BASE_KEYS = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];
export function doctorPrepareEnv(root, baseEnv = process.env) {
  const lower = new Map(Object.entries(baseEnv ?? {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k.toLowerCase(), v]));
  const env = {};
  for (const k of BASE_KEYS) { const v = lower.get(k.toLowerCase()); if (v) env[k] = v; }
  const sys = env.SystemRoot || 'C:\\Windows';
  env.PATH = [path.join(sys, 'System32'), sys, path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
  env.IRIS_ROOT = root;
  env.CLAUDE_CONFIG_DIR = path.join(root, '_agent', 'claude');
  return env;
}

// Doctor 의 답에서 받는 낱말(이 밖의 글은 싣지 않는다 — 계정 이름 · 경로가 기록으로 새지 않게).
const WORDS = new Set(['linked', 'prepared', 'no-root', 'no-iris-key', 'has-card', 'ready', 'busy', 'stuck', 'failed', 'not-subscription-key', 'expiry-unknown', 'expired']);
const NOT_CALLED = new Set(['no-root', 'rehearsal', 'offline', 'no-doctor', 'no-node']);
const word = (v) => (typeof v === 'string' && WORDS.has(v) ? v : 'unknown');
function parseAnswer(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let j; try { j = JSON.parse(t); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    const claude = j.claude && typeof j.claude === 'object' ? { linked: j.claude.linked === true, why: word(j.claude.why) } : null;
    const codex = j.codex && typeof j.codex === 'object' ? { prepared: j.codex.prepared === true, why: word(j.codex.why) } : null;
    if (claude || codex) return { claude, codex };
  }
  return null;
}

// 우리가 띄운 그 번호와 그 자식만 끝낸다(이름으로 끝내지 않는다).
function defaultKillTree(pid, env = process.env) {
  if (!Number.isInteger(pid) || pid <= 4) return;
  const taskkill = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  try { spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, stdio: 'ignore' }); } catch { /* 아래 kill 이 남는다 */ }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/**
 * prepareDoctorAccounts({ root, noUserEnv, env, timeoutMs, spawnFn, killTree, fs, onSpawn })
 *   → { called:false, why: 'no-root' | 'rehearsal' | 'offline' | 'no-doctor' | 'no-node' }
 *   | { called:true, ok, exit, timedOut, alive, ms, claude: { linked, why } | null, codex: { prepared, why } | null }
 * 절대 던지지 않는다. 설치 폴더에 아무것도 쓰지 않는다.
 */
export async function prepareDoctorAccounts({
  root, noUserEnv = false, env = process.env, timeoutMs = DOCTOR_PREPARE_TIMEOUT_MS,
  spawnFn = spawn, killTree = defaultKillTree, fs = nodeFs, onSpawn = null,
} = {}) {
  try {
    if (!root || typeof root !== 'string') return { called: false, why: 'no-root' };
    if (noUserEnv || env?.IRIS_INSTALLER_NO_USER_ENV === '1') return { called: false, why: 'rehearsal' };
    if (isOffline(env ?? {})) return { called: false, why: 'offline' };
    const entry = doctorEntryFor(root);
    if (!fs.existsSync(entry)) return { called: false, why: 'no-doctor' };
    const node = nodeExeFor(root);
    if (!fs.existsSync(node)) return { called: false, why: 'no-node' };

    const started = Date.now();
    const base = { called: true, ok: false, exit: null, timedOut: false, alive: false, ms: 0, claude: null, codex: null };
    return await new Promise((resolve) => {
      let done = false; let child = null; let size = 0; let timedOut = false; let giveUp = null;
      const chunks = [];
      const finish = (extra) => {
        if (done) return; done = true;
        clearTimeout(timer); clearTimeout(giveUp);
        resolve({ ...base, ...extra, ms: Date.now() - started });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        const pid = child?.pid;
        try { killTree(pid, env ?? process.env); } catch { /* 넘어간다 */ }
        try { child?.kill(); } catch { /* 이미 끝남 */ }
        // 끝났다는 신호를 5초까지 기다린다. 그래도 없으면 아직 살아 있는지를 알리고 돌아간다(끝없이 기다리지 않는다).
        giveUp = setTimeout(() => finish({ timedOut: true, alive: Number.isInteger(pid) ? pidAlive(pid) : false }), 5000);
      }, Math.max(1, timeoutMs));
      try {
        child = spawnFn(node, [entry, ...DOCTOR_PREPARE_ARGS], {
          cwd: os.tmpdir(),                       // 설치 폴더 밖 — 설치 폴더를 현재 폴더로 쥐지 않는다
          env: doctorPrepareEnv(root, env ?? process.env),
          windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'],
        });
        try { if (Number.isInteger(child?.pid)) onSpawn?.(child.pid); } catch { /* 부른 쪽의 일 */ }
        child.stdout?.on('data', (d) => { if (size < MAX_OUT) { chunks.push(d); size += d.length; } });
        child.on('error', () => finish({ exit: null }));
        child.on('close', (code) => {
          if (timedOut) return finish({ timedOut: true, alive: false });
          const answer = code === 0 ? parseAnswer(Buffer.concat(chunks).toString('utf8')) : null;
          finish({ ok: code === 0 && answer !== null, exit: Number.isInteger(code) ? code : null, claude: answer?.claude ?? null, codex: answer?.codex ?? null });
        });
      } catch {
        finish({ exit: null });                    // 오류의 원문은 싣지 않는다(경로가 섞인다)
      }
    });
  } catch {
    return { called: true, ok: false, exit: null, timedOut: false, alive: false, ms: 0, claude: null, codex: null };
  }
}

/** 기록 한 줄(계정 이름 · 경로 · 주소가 들어가지 않는다 — 정해 둔 낱말과 숫자뿐). */
export function doctorPrepareLine(r) {
  if (!r || typeof r !== 'object') return 'no result';
  if (r.called !== true) return `not called (${NOT_CALLED.has(r.why) ? r.why : 'unknown'})`;
  const ms = Number.isFinite(r.ms) ? ` (${Math.round(r.ms)}ms)` : '';
  if (r.timedOut) return `timed out${r.alive ? ' (still running)' : ''}${ms}`;
  if (!r.ok) return `failed exit=${Number.isInteger(r.exit) ? r.exit : 'none'}${ms}`;
  const c = r.claude ? ` claude=${word(r.claude.why)}` : '';
  const x = r.codex ? ` codex=${word(r.codex.why)}` : '';
  return `ok${c}${x}${ms}`;
}
