// IRIS Doctor — 계정 연결(Doctor 전용 출입 카드). 설계 D2 고친 안:
//   · 서비스(클로드 · 코덱스)별로 **고정된 연결 하나**. 중계기처럼 계정을 돌리지 않는다. 언제든 바꿀 수 있다.
//   · 클로드 = Doctor 용 1년 열쇠(갱신 열쇠가 없는 고정 열쇠). IRIS 1년 열쇠가 있으면 그 사본으로 손 없이 준비.
//   · 코덱스 = Doctor 전용 로그인(전용 폴더 — 중계기 · 평소 프로그램과 열쇠를 나누지 않는다).
//   · **바꿀 때는 새 연결이 실제 연결에 성공한 뒤에만 옛 연결과 바꿔 낀다.** 새 것은 먼저 "후보"로 따로 두고(stage),
//     확인(probe)에 성공하면 바꿔 끼며(commit), 실패하면 후보만 버린다(discard) — 옛 연결은 그대로 남는다.
//     처음 연결(옛 연결이 없음)과 같은 열쇠를 다시 연결하는 것은 잃을 것이 없으므로 곧바로 카드가 된다.
//   · 준비 상태는 셋을 구별한다: 카드 있음 / 로그인 됨 / 마지막으로 실제 연결에 성공한 때.
// 열쇠 값은 카드 파일 안에만 있다 — 이 파일의 함수들은 값을 돌려주지 않고(실행 쪽 내부용 readCard 제외) 로그에 싣지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { doctorPaths, ensureHome, writeAtomic, readJsonFile, isProtected, recoverCodexSwap, listCodexNext, inDoctorHome, CODEX_NEXT_RE } from './home.mjs';
import { maskName } from './report.mjs';
import { acquireFileLock, fileLockLive, TREAT_LOCK_ABANDON_MS } from './lock.mjs';

const DAY = 86400_000;
const num = (v) => { const n = typeof v === 'string' ? Date.parse(v) : Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
/** 그 폴더에 구독 로그인(열쇠 파일)이 있는가 — API 키 로그인은 치지 않는다. 모양만 본다(실제로 통하는지는 확인 호출이 본다). */
export const codexLoggedIn = (home) => { const a = readJsonFile(path.join(home, 'auth.json')); return !!(a && !a.OPENAI_API_KEY && a.tokens && (a.tokens.refresh_token || a.tokens.access_token)); };

const CODEX_CONFIG = [
  '# IRIS Doctor 전용 코덱스 설정 — 중계기를 거치지 않는 기본 연결 · 구독 로그인만 · 열쇠는 이 폴더의 파일에.',
  '# 평소 코덱스 설정(중계기 연결 · 훅 · 도구 연결)은 여기로 가져오지 않는다. 이 세 줄 말고는 적지 않는다(실행 전 자기 점검이 본다).',
  'model_provider = "openai"',
  'forced_login_method = "chatgpt"',
  'cli_auth_credentials_store = "file"',
  '',
].join('\n');

/** 카드를 읽는다(열쇠 값 포함 — 실행 쪽만 쓴다). 없거나 깨졌으면 null. staged=true 면 바꾸는 중인 후보. */
export function readCard(root, kind, { staged = false } = {}) {
  const p = doctorPaths(root);
  const file = kind === 'claude' ? (staged ? p.claudeNext : p.claudeCard) : p.codexCard;
  const c = readJsonFile(file);
  return c && c.kind === kind ? c : null;
}

/**
 * 클로드 연결 올리기 — IRIS 1년 열쇠(<클로드 설정 폴더>\secrets\iris-cli-token.json)의 사본.
 * → { ok:true, staged, daysLeft, account } | { ok:false, why }   (열쇠 값은 돌려주지 않는다)
 *   staged=false = 곧바로 카드가 됨(처음 연결이거나 같은 열쇠) / staged=true = 후보로 둠(확인에 성공해야 바꿔 낀다)
 */
const irisKeyFile = (claudeDir) => path.join(claudeDir, 'secrets', 'iris-cli-token.json');
/** IRIS 1년 열쇠를 읽어 쓸 수 있는 모양인지 본다(읽기만 — 아무것도 만들지 않는다). → { ok:true, src, exp } | { ok:false, why } */
function readIrisKey(claudeDir, now) {
  const src = readJsonFile(irisKeyFile(claudeDir));
  if (!src || typeof src.token !== 'string' || !src.token) return { ok: false, why: 'no-iris-key' };
  if (!/^sk-ant-oat/i.test(src.token)) return { ok: false, why: 'not-subscription-key' };
  const exp = num(src.expiresAt);
  if (!exp) return { ok: false, why: 'expiry-unknown' };
  if (exp <= now) return { ok: false, why: 'expired' };
  return { ok: true, src, exp };
}

export function stageClaudeFromIris({ root, claudeDir, now = Date.now() }) {
  const key = readIrisKey(claudeDir, now);
  if (!key.ok) return key;
  const { src, exp } = key;
  const p = ensureHome(root);
  const old = readCard(root, 'claude');
  const same = !!old && old.token === src.token;
  const card = {
    v: 1, kind: 'claude', source: 'iris-longkey', token: src.token, expiresAt: exp,
    account: src.email ? maskName(src.email) : null, // 화면에 보일 가린 이름만 둔다(이메일 원문은 두지 않는다)
    linkedAt: same ? old.linkedAt ?? new Date(now).toISOString() : new Date(now).toISOString(),
    // 같은 열쇠면 지난 기록(마지막 성공 · 실패 시각, 과금 물음의 답)을 잇는다 — "성공한 적이 있다"는 시각 기록이지 지금의 보증이 아니다
    lastOkAt: same ? old.lastOkAt ?? null : null,
    lastFailAt: same ? old.lastFailAt ?? null : null,
    extraUsage: same ? old.extraUsage ?? 'unknown' : 'unknown', // 한도를 넘긴 뒤의 실제 과금: 'off' | 'on' | 'unknown'
    billingAckAt: same ? old.billingAckAt ?? null : null,        // 켜짐 · 모름일 때 사용자가 연결하며 승인한 때
  };
  const days = Math.floor((exp - now) / DAY);
  if (!old || same) { writeAtomic(p.claudeCard, JSON.stringify(card, null, 2)); return { ok: true, staged: false, daysLeft: days, account: card.account }; }
  writeAtomic(p.claudeNext, JSON.stringify(card, null, 2)); // 옛 연결이 있다 — 후보로만 둔다
  return { ok: true, staged: true, daysLeft: days, account: card.account };
}

/** 열쇠의 지문(값을 드러내지 않고 "같은 열쇠인가"만 견준다). */
export const keyPrint = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 24);

/**
 * 연결을 바꾸는 일은 한 번에 하나만(두 실행이 같은 후보를 덮어써서, 확인하지 않은 열쇠가 확정되는 일을 막는다).
 * → fn({ recovered }) 의 결과 | { busy: true }
 *   버려진 잠금 = 주인 프로세스가 없거나, 60분(LOCK_ABANDON_MS)을 넘긴 것. 살아 있는 주인의 잠금은 그 전에는 빼앗지 않는다.
 *   잠금을 쥔 뒤 끊긴 코덱스 바꿔 끼기를 먼저 정리하고(recovered 로 알림) fn 을 부른다. 끝나면 내 잠금일 때만 푼다.
 */
// 한 실행이 잠금을 쥐고 있을 수 있는 가장 긴 시간은 정해져 있다(로그인 화면 15분 + 확인 2분 — 실행 쪽이 그 시간에 끊는다).
// 그 네 배가 지난 잠금만 "시간으로" 버려진 것으로 본다(주인의 프로세스 번호가 다른 프로그램에 다시 쓰여 영영 안 풀리는 일을 막는 마지막 장치).
export const LOCK_ABANDON_MS = 60 * 60_000;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

//   refuseIf = 잠금을 쥔 **바로 뒤, 아무것도 하기 전에** 한 번 더 묻는 것. 참이면 정리도 fn 도 하지 않고 { busy: true } 로 물러난다
//   (손 없는 준비가 "치료 중이면 물러난다"를 잠금 안에서 다시 볼 때 쓴다 — 잠금을 기다리는 사이 치료가 시작됐을 수 있다).
export async function withLinkLock(root, fn, { now = Date.now(), pid = process.pid, isAlive = pidAlive, refuseIf = null } = {}) {
  const p = ensureHome(root);
  // 잠금의 방식(올리기 · 버려진 잠금 가리기 · 내 잠금만 풀기)은 lib/lock.mjs — 치료 잠금과 같은 것을 쓴다
  const lock = acquireFileLock(p.linkLock, { now, pid, isAlive, abandonMs: LOCK_ABANDON_MS });
  if (!lock.ok) return { busy: true };
  try {
    if (refuseIf && refuseIf()) return { busy: true };
    // 끊긴 코덱스 바꿔 끼기의 정리는 잠금을 쥔 뒤에만 한다(다른 실행이 지금 바꿔 끼는 중일 수 있다)
    const recovered = recoverCodexSwap(root);
    ensureHome(root); // 정리가 끝났으면 코덱스 폴더가 없을 때 마련한다
    return await fn({ recovered });
  } finally {
    lock.release(); // 내 잠금일 때만 푼다(버려진 것으로 보여 다른 실행이 가져갔다면 그쪽 잠금을 지우지 않는다)
  }
}

/**
 * 후보를 정식 카드로 바꿔 낀다(확인에 성공한 뒤에만 부른다).
 * expect = 확인에 쓴 그 열쇠의 지문 — 후보 파일이 그 사이 다른 열쇠로 바뀌었으면 바꿔 끼지 않는다.
 */
export function commitClaude({ root, now = Date.now(), expect }) {
  const p = doctorPaths(root);
  const next = readCard(root, 'claude', { staged: true });
  if (!next || !expect || keyPrint(next.token) !== expect) return false;
  next.lastOkAt = new Date(now).toISOString(); next.lastFailAt = null;
  writeAtomic(p.claudeCard, JSON.stringify(next, null, 2));
  try { fs.rmSync(p.claudeNext, { force: true }); } catch {}
  return true;
}
export function discardClaude({ root }) { try { fs.rmSync(doctorPaths(root).claudeNext, { force: true }); } catch {} }

/** 코덱스 전용 폴더를 마련한다(로그인은 사용자가 브라우저에서 — 여기서는 설정 파일과 카드 틀만). 있는 폴더 · 설정은 건드리지 않는다. */
const codexCardFrame = (now) => JSON.stringify({ v: 1, kind: 'codex', source: 'own-login', linkedAt: null, lastOkAt: null, lastFailAt: null, credit: 'unknown', billingAckAt: null, preparedAt: new Date(now).toISOString() }, null, 2);
// 이 함수는 **사용자가 직접 연결할 때**(link codex · login codex)의 것이다: 읽히지 않는 카드는 "없음"으로 보고 새 틀로 바꾼다
// (깨진 연결은 다시 연결하면 고쳐진다는 약속). 손 없는 준비(autoPrepareCodex)는 이 함수를 쓰지 않는다 — 있는 카드 파일을 덮지 않아야 한다.
export function prepareCodexHome({ root, now = Date.now() }) {
  const p = ensureHome(root);
  const cfg = path.join(p.codexHome, 'config.toml');
  if (!fs.existsSync(cfg)) writeAtomic(cfg, CODEX_CONFIG);
  if (!readCard(root, 'codex')) writeAtomic(p.codexCard, codexCardFrame(now));
  return p;
}

/**
 * 손 없이 되는 준비(통신 0 · 실제 확인 호출 0) — Doctor 가 시작할 때와, 설치 프로그램이 설치 · 업데이트 끝에 부른다(`link auto`).
 * 약속: **이미 되어 있으면 아무것도 쓰지 않는다**(파일 · 장부 · 잠금 · Doctor 집 만들기 모두 0 — 되풀이해 불러도 디스크가 그대로다).
 *   클로드 = 카드가 **아예 없고** IRIS 1년 열쇠가 쓸 수 있는 모양일 때만 그 사본으로 카드를 만든다(처음 연결은 잃을 것이 없어 확인 없이 카드가 된다).
 *            카드 파일이 이미 있으면(읽지 못하는 것 · 다른 열쇠의 것 포함) · 바꾸는 중인 후보가 있으면 손대지 않는다 —
 *            다른 열쇠로 바꾸는 일은 실제 확인이 있어야 하므로 사용자가 Doctor 창에서 한다(`link claude`).
 *   코덱스 = 전용 폴더의 설정과 카드 틀이 없을 때만 마련한다(로그인은 하지 않는다 — 브라우저 승인은 사용자가).
 *   **치료 중이면 물러난다**: 치료 잠금(<Doctor 집>\treat.lock)이 살아 있으면 만들 것이 있어도 아무것도 만들지 않고 'busy' 로 답한다
 *            (치료 중인 실행이 카드 · 전용 폴더를 쓰고 있다 — 그 밑에서 파일을 새로 놓지 않는다). 잠금 파일도 Doctor 집도 만들지 않는다.
 *            연결 잠금을 쥔 바로 뒤에 한 번 더 본다(기다리는 사이 치료가 시작된 경우). 치료는 연결 잠금을 쥐지 않으므로
 *            그 확인과 파일 놓기 사이의 아주 짧은 틈까지 없애지는 못한다 — 줄일 뿐이다.
 * → { linked, why } / { prepared, why }   why: 'no-root' | 'no-iris-key' | 'has-card' | 'ready' | 'busy' | 'stuck' | 'failed' | (열쇠 모양의 까닭)
 */
/** 지금 이 설치 폴더에서 치료가 진행 중인가(읽기만 — Doctor 집을 만들지 않는다). */
export const treatingNow = (root, now = Date.now()) => fileLockLive(path.join(doctorPaths(root).home, 'treat.lock'), { now, abandonMs: TREAT_LOCK_ABANDON_MS });

export async function autoLinkClaude({ root, claudeDir, now = Date.now(), treating = treatingNow }) {
  if (!root || !claudeDir) return { linked: false, why: 'no-root' };
  const p = doctorPaths(root);
  const hasCard = () => fs.existsSync(p.claudeCard) || fs.existsSync(p.claudeNext);
  // 잠금을 쥐기 전에 읽기만으로 가린다 — 할 일이 없으면 Doctor 집도 잠금 파일도 만들지 않는다
  if (hasCard()) return { linked: false, why: 'has-card' };
  if (!fs.existsSync(irisKeyFile(claudeDir))) return { linked: false, why: 'no-iris-key' };
  const key = readIrisKey(claudeDir, now);
  if (!key.ok) return { linked: false, why: key.why };
  // 여기부터는 만들 것이 있다 — 치료 중이면 물러난다(연결 잠금을 쥐기 전에: 잠금 파일도 만들지 않는다)
  if (treating(root, now)) return { linked: false, why: 'busy' };
  const r = await withLinkLock(root, () => {
    if (hasCard()) return { linked: false, why: 'has-card' }; // 잠금을 기다리는 사이 다른 실행이 만들었으면 손대지 않는다
    const s = stageClaudeFromIris({ root, claudeDir, now });
    if (!s.ok) return { linked: false, why: s.why };
    if (s.staged) { discardClaude({ root }); return { linked: false, why: 'has-card' }; } // 여기 올 수 없는 길 — 그래도 확인 없는 후보를 남기지 않는다
    return { linked: true, why: 'linked', daysLeft: s.daysLeft };
  }, { now, refuseIf: () => treating(root, now) });
  return r?.busy ? { linked: false, why: 'busy' } : r;
}
export async function autoPrepareCodex({ root, now = Date.now(), treating = treatingNow }) {
  if (!root) return { prepared: false, why: 'no-root' };
  const p = doctorPaths(root);
  const ready = () => fs.existsSync(path.join(p.codexHome, 'config.toml')) && fs.existsSync(p.codexCard);
  if (ready()) return { prepared: false, why: 'ready' };
  if (fs.existsSync(p.codexSwap) || listCodexNext(root).length) return { prepared: false, why: 'stuck' }; // 바꿔 끼는 중이거나 끊긴 것이 있다 — 그 정리는 사용자가 연 Doctor 가 한다
  if (treating(root, now)) return { prepared: false, why: 'busy' }; // 만들 것이 있지만 치료 중이다 — 물러난다(잠금 파일도 만들지 않는다)
  const r = await withLinkLock(root, ({ recovered }) => {
    if (recovered === 'failed') return { prepared: false, why: 'stuck' };
    if (ready()) return { prepared: false, why: 'ready' };
    // **빠진 파일만** 만든다 — "있는가"만 보고 "읽히는가"는 보지 않는다. 카드 파일이 있으면 깨졌든 모양이 다르든 한 바이트도 바꾸지 않는다
    // (읽히지 않는 카드를 새 틀로 바꾸는 것은 사용자가 직접 다시 연결할 때의 일이다 — prepareCodexHome. 2026-11-28 코드 검토 지적).
    // 설정 파일도 같다: 있으면 내용이 우리 세 줄과 달라도 손대지 않는다(무엇이 들었는지는 실행 전 자기 점검이 본다).
    const cfg = path.join(p.codexHome, 'config.toml');
    let made = false;
    if (!fs.existsSync(cfg)) { writeAtomic(cfg, CODEX_CONFIG); made = true; }
    if (!fs.existsSync(p.codexCard)) { writeAtomic(p.codexCard, codexCardFrame(now)); made = true; }
    return made ? { prepared: true, why: 'prepared' } : { prepared: false, why: 'ready' };
  }, { now, refuseIf: () => treating(root, now) });
  return r?.busy ? { prepared: false, why: 'busy' } : r;
}

/**
 * 코덱스 계정 바꾸기 — 새 로그인을 받을 **후보 폴더**를 마련한다(지금 연결된 폴더는 그대로 둔다).
 * 사용자가 후보 폴더에서 로그인하고 확인에 성공하면 commitCodex 가 폴더째 바꿔 낀다.
 */
export function stageCodexHome({ root, now = Date.now() }) {
  const p = ensureHome(root);
  // 지난 후보(버려진 것)는 치운다 — 못 치우면 그대로 둔다.
  for (const d of listCodexNext(root)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  // 이름은 매번 새로(무작위 번호) — 치운 폴더의 이름도 다시 쓰지 않는다(그 폴더를 설정 폴더로 띄운 프로그램이 아직 살아 있으면 같은 이름에 다시 쓸 수 있다)
  let next;
  do { next = `${p.codexNextPrefix}${now}-${crypto.randomInt(1, 1_000_000_000)}`; } while (fs.existsSync(next));
  fs.mkdirSync(next, { recursive: true });
  writeAtomic(path.join(next, 'config.toml'), CODEX_CONFIG);
  return next;
}

/**
 * 후보 폴더를 정식 폴더로 바꿔 낀다(후보에 구독 로그인이 있을 때만).
 * verified = 그 후보로 실제 연결에 성공했는가 — true 일 때만 "성공한 때"를 적는다(로그인 파일의 모양만으로는 적지 않는다).
 * 차례: 쪽지 적기 → 옛 폴더 비켜 두기 → 새 폴더 넣기 → 카드 새로 쓰기 → 옛 폴더 지우기 → 쪽지 지우기.
 *   도중에 실패하면 그 자리에서 되돌리고, 프로세스가 끊기면 다음 실행의 recoverCodexSwap 이 쪽지를 보고 정리한다.
 *   옛 폴더는 카드를 새로 쓴 **뒤에** 지운다(카드 쓰기가 실패하면 옛 계정 그대로 되돌릴 수 있게).
 */
export function commitCodex({ root, next, now = Date.now(), verified = false, fsx = fs, write = writeAtomic }) {
  const p = doctorPaths(root);
  if (!inDoctorHome(root, next, CODEX_NEXT_RE) || !codexLoggedIn(next)) return false;
  const old = `${p.codexHome}.old-${now}`;
  const had = fsx.existsSync(p.codexHome);
  const stamp = new Date(now).toISOString();
  const id = `${now}-${process.pid}`;
  write(p.codexSwap, JSON.stringify({ id, old: had ? old : null, next, at: stamp }));
  // 되돌리기: stage 2 = 새 폴더까지 들어간 뒤 · 1 = 옛 폴더만 비켜 둔 뒤.
  // **되돌리기가 끝까지 됐을 때만 쪽지를 지운다** — 도중에 막히면 쪽지를 남겨, 다음 실행(잠금 안)의 복구가 지금 상태를 보고 마저 정리한다.
  const undo = (stage) => {
    let ok = true;
    if (stage >= 2) { try { fsx.renameSync(p.codexHome, next); } catch { ok = false; } }
    if (ok && had) { try { fsx.renameSync(old, p.codexHome); } catch { ok = false; } }
    if (ok) { try { fsx.rmSync(p.codexSwap, { force: true }); } catch {} }
  };
  if (had) { try { fsx.renameSync(p.codexHome, old); } catch (e) { try { fsx.rmSync(p.codexSwap, { force: true }); } catch {} throw e; } }
  try { fsx.renameSync(next, p.codexHome); } catch (e) { undo(1); throw e; }
  // 계정이 바뀌었으니 확인 기록 · 과금 물음의 답을 새로 시작한다(옛 계정의 성공 기록을 잇지 않는다)
  try { write(p.codexCard, JSON.stringify({ v: 1, kind: 'codex', source: 'own-login', linkedAt: stamp, lastOkAt: verified ? stamp : null, lastFailAt: null, credit: 'unknown', billingAckAt: null, preparedAt: stamp, swap: id }, null, 2)); } catch (e) { undo(2); throw e; }
  if (had) { try { fsx.rmSync(old, { recursive: true, force: true }); } catch {} }
  try { fsx.rmSync(p.codexSwap, { force: true }); } catch {}
  return true;
}
/** 후보 폴더를 버린다. next 를 주면 그것만, 안 주면 남아 있는 후보 전부(못 지우는 것은 둔다). */
export function discardCodex({ root, next = null }) {
  const list = next ? (inDoctorHome(root, next, CODEX_NEXT_RE) ? [next] : []) : listCodexNext(root);
  for (const d of list) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

/** 실제 연결 확인의 결과를 카드에 적는다(성공한 때 · 실패한 때). */
export function recordProbe({ root, kind, ok, now = Date.now() }) {
  const p = doctorPaths(root);
  const c = readCard(root, kind);
  if (!c) return false;
  if (ok) { c.lastOkAt = new Date(now).toISOString(); if (kind === 'codex' && !c.linkedAt) c.linkedAt = c.lastOkAt; } else c.lastFailAt = new Date(now).toISOString();
  writeAtomic(kind === 'claude' ? p.claudeCard : p.codexCard, JSON.stringify(c, null, 2));
  return true;
}

/**
 * 준비 상태(열쇠 값 없음). → { claude: {…}, codex: {…} }
 *   state = 'none' 카드 없음 | 'card' 카드만 있음(실제 연결을 아직 확인 못 함) | 'ready' 실제 연결에 성공한 적 있음 | 'expired' 열쇠 만료
 *   staged = 바꾸는 중인 후보가 있음
 */
/**
 * 창 안 입구(걸음 ⑦)에 보여 줄 요약 — 계정 이름(가린 것도) · 열쇠 · 지문 · 경로를 싣지 않는다. 시각 · 남은 날은 모양을 확인한 값만.
 * 상태: ready(마지막 연결 확인 성공) · failed(마지막 확인이 실패 — 성공 기록이 있어도 그 뒤에 실패했으면) · card(연결됨 · 확인 전) · expired · none · unreadable
 * → { v: 1, protected, claude: { state, okAt, failAt, daysLeft }, codex: { state, okAt, failAt } }
 */
export function linkSummary({ root, now = Date.now() }) {
  const s = linkStatus({ root, now });
  const iso = (v) => { const t = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]{8,12}Z$/.test(v) ? Date.parse(v) : NaN; return Number.isFinite(t) && t <= now + DAY ? new Date(t).toISOString() : null; };
  const one = (c) => {
    const okAt = iso(c?.lastOkAt), failAt = iso(c?.lastFailAt);
    let state = ['ready', 'card', 'expired', 'none', 'unreadable'].includes(c?.state) ? c.state : 'unreadable';
    if ((state === 'ready' || state === 'card') && failAt && (!okAt || failAt > okAt)) state = 'failed';
    if (state === 'ready' && !okAt) state = 'card';
    return { state, okAt, failAt };
  };
  const d = s.claude?.daysLeft;
  return { v: 1, protected: s.protected === true, claude: { ...one(s.claude), daysLeft: Number.isInteger(d) && d > -4000 && d < 4000 ? d : null }, codex: one(s.codex) };
}

export function linkStatus({ root, now = Date.now() }) {
  const p = doctorPaths(root);
  const out = { protected: isProtected(root) };
  const cl = readCard(root, 'claude');
  // 카드 파일은 있는데 읽지 못하거나 모양이 틀리면 "없음"이 아니라 "못 읽음"(권한 · 손상)
  if ((!cl || !cl.token) && fs.existsSync(p.claudeCard)) out.claude = { state: 'unreadable' };
  else if (!cl || !cl.token) out.claude = { state: 'none' };
  else {
    const exp = num(cl.expiresAt);
    out.claude = { state: exp && exp <= now ? 'expired' : cl.lastOkAt ? 'ready' : 'card', daysLeft: exp ? Math.floor((exp - now) / DAY) : null, account: cl.account ?? null, linkedAt: cl.linkedAt ?? null, lastOkAt: cl.lastOkAt ?? null, lastFailAt: cl.lastFailAt ?? null, extraUsage: cl.extraUsage ?? 'unknown' };
  }
  out.claude.staged = fs.existsSync(p.claudeNext);
  const cx = readCard(root, 'codex');
  const authFile = path.join(p.codexHome, 'auth.json');
  if ((!cx && fs.existsSync(p.codexCard)) || (fs.existsSync(authFile) && !readJsonFile(authFile))) out.codex = { state: 'unreadable', prepared: !!cx };
  else if (!cx || !codexLoggedIn(p.codexHome)) out.codex = { state: 'none', prepared: !!cx };
  else out.codex = { state: cx.lastOkAt ? 'ready' : 'card', linkedAt: cx.linkedAt ?? null, lastOkAt: cx.lastOkAt ?? null, lastFailAt: cx.lastFailAt ?? null, credit: cx.credit ?? 'unknown' };
  out.codex.staged = listCodexNext(root).length > 0;
  return out;
}
