// Antigravity 화면 잠금 — 설치기 쪽 판정은 이 파일 한 곳(2.0.67).
//
// 뜻       일반 PC 의 설치 화면에서 Antigravity 는 "보이지만 고를 수 없고 「곧 열립니다」". 클로드 · 챗지피티 흐름은 이 파일을 모른다.
// 잠금 값  'locked' | 'open'. 기본값은 아래 AGY_LOCK_DEFAULT 한 줄이다.
// 열쇠     <영혼 루트>\_agent\setup\iris-keys.json 의 "antigravity": "open" — **정확히 그 글자일 때만** 연다.
//          파일 없음 · 읽기 실패 · 깨진 JSON · 객체가 아님(배열 포함) · 그 키가 없음 · 다른 값 = 잠김.
//          맨 앞의 파일 머리표(BOM) 하나는 벗기고 읽는다. 모르는 키가 함께 있어도 판정은 같다.
//          비밀이 아니라 스위치다(보안 장치가 아니다).
// 규칙의 짝  IRIS 창 `daemon/agents/antigravity.lock.mjs`(keyOpens · judgeLock) · 대시보드 `lib.mjs`(AGY_LOCK_DEFAULT · agyLock).
//          세 곳의 규칙은 글자 그대로 같아야 한다 — `tests/agylock.test.mjs` 가 같은 입력표를 창의 판정 모듈에 넣어 같은 답인지 본다.
// 영혼 루트  찾지 않는다. 설치기가 정한 폴더를 그대로 받는다(연습 이름을 주면 그 폴더의 열쇠만 본다 — 시험이 진짜 열쇠에 휘둘리지 않는다).
// 없는 것   환경 변수로 여는 길(만들지 않는다) · 열쇠를 쓰는 코드(설치기는 이 파일을 만들지도 고치지도 지우지도 않는다).
//
// 2.0.67 에서 이 판정이 바꾸는 것은 설치 화면의 설명 한 줄뿐이다: 받기 장치를 싣지 않은 판이라 열쇠가 열린 PC 에서도 그 줄은 고를 수 없다
// (installer/server.mjs · installer/ui/index.html). 잠금을 보는 코드는 모두 이 모듈만 부른다 — 다른 자리에서 열쇠를 따로 읽지 않는다.
import fs from 'node:fs';
import path from 'node:path';

/** 기본값. 이 한 줄을 'open' 으로 바꾸면 열쇠 파일이 없는 PC 에서도 열린다(창 · 대시보드의 같은 줄과 함께 바꾼다). */
export const AGY_LOCK_DEFAULT = 'locked';
/** 열쇠 파일의 자리(영혼 루트 기준) */
export const AGY_KEY_FILE = ['_agent', 'setup', 'iris-keys.json'];
/** 열쇠 파일 안의 칸 이름 */
export const AGY_LOCK_ID = 'antigravity';

/** 열쇠 파일의 글이 여는 글인가(순수 함수). 객체이고 그 칸이 정확히 "open" 일 때만 true — 그 밖은 전부 false. */
export function keyOpens(text) {
  if (typeof text !== 'string') return false;
  let j;
  try { j = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); } catch { return false; }
  return !!j && typeof j === 'object' && !Array.isArray(j) && Object.hasOwn(j, AGY_LOCK_ID) && j[AGY_LOCK_ID] === 'open';
}

/**
 * 잠금 판정. root = 설치기가 정한 영혼 루트.
 * 기본값이 정확히 'open' 이면 열쇠를 읽지 않고 열림. 아니면 열쇠가 열 때만 열림.
 * def · readText 는 시험용 주입구다(설치기 코드는 root 만 넘긴다). 환경 변수는 보지 않는다.
 *
 * @returns {{ state: 'locked'|'open', why: 'default-open'|'no-root'|'no-key'|'bad-key'|'not-open'|'key' }}
 *   why 는 기록 · 시험용이다(대시보드 agyLock 과 같은 낱말).
 */
export function agyLock(root, { def = AGY_LOCK_DEFAULT, readText = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  if (def === 'open') return { state: 'open', why: 'default-open' };
  if (typeof root !== 'string' || !root) return { state: 'locked', why: 'no-root' };
  let text;
  try { text = readText(path.join(root, ...AGY_KEY_FILE)); } catch { return { state: 'locked', why: 'no-key' }; }
  if (typeof text !== 'string') return { state: 'locked', why: 'no-key' };
  if (keyOpens(text)) return { state: 'open', why: 'key' };
  // 잠김의 까닭만 가른다(판정은 위에서 끝났다): 읽히는 객체인데 여는 값이 아님 = not-open, 그 밖 = bad-key.
  let j;
  try { j = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); } catch { return { state: 'locked', why: 'bad-key' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { state: 'locked', why: 'bad-key' };
  return { state: 'locked', why: 'not-open' };
}

/** 잠겨 있는가(설치기 코드가 쓰는 한 줄) */
export const agyLocked = (root) => agyLock(root).state !== 'open';
