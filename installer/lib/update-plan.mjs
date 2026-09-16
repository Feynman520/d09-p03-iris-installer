// 업데이트 모드(`IRIS-설치.cmd --auto`)가 "어느 세팅 단계를 다시 돌릴 것인가"를
// 정하는 곳. 순수 함수 두 개뿐이라 서버 없이도 시험할 수 있다.
//
// ── 왜 이 파일이 필요한가 ─────────────────────────────────────────────────
// 2.0 의 업데이트는 **세팅 엔진을 한 번 더 도는 것**이다(설계-v2 11절 "업데이터
// (2.x 안)"). 엔진은 영수증이 `done` 이라 말하는 단계를 건너뛰므로, 그냥 부르면
// 아홉 단계가 전부 건너뛰어져 아무것도 바뀌지 않는다. 그래서 새 판이 실제로
// 바꿀 수 있는 단계만 골라 `pending` 으로 되돌린 뒤 엔진을 부른다.
//
// ── 무엇을 되돌리나 ───────────────────────────────────────────────────────
//   항상: `unpack`(부품 교체) · `env`(심·PATH — 판 폴더 이름이 바뀐다) ·
//         `adapters`(설정 안의 우리 항목이 새 경로를 가리켜야 한다)
//   조건부: `venv`  — python·uv·바퀴집·pyyaml 중 하나라도 판이 바뀌었을 때
//           `relay` — 실행기·바로가기가 가리키는 부품(node·face·dash·중계기 등)의
//                     판이 바뀌었을 때
//   그대로 둠: `skeleton`·`structure`·`ontology`·`checks`
//       — 이 넷은 "그 사람의 영혼"을 만드는 단계다. 폴더·지침·목록 카드는 이미
//         그 사람 것이고, 다시 돌아도 덮지 않게 되어 있지만 돌 이유도 없다.
//
// 되돌린다고 **지우지 않는다**: 옛 기록은 그 자리에 남겨 두고 `status` 만
// `pending` 으로 바꾸며, 무엇 때문에 되돌렸는지를 `resetBy`·`resetAt` 에 적는다.
// `unpack` 은 부품 동일성(identity)으로 안 바뀐 부품을 스스로 건너뛰고, 바뀐
// 부품만 `.prev` 로 옮겨 놓는다 — 그래서 되돌려도 하는 일은 "바뀐 것만".

// 언제나 다시 도는 단계.
export const ALWAYS_RESET = Object.freeze(['unpack', 'env', 'adapters']);

// 이 부품들의 판이 바뀌면 파이썬 환경을 다시 만든다.
export const VENV_PARTS = Object.freeze(['python', 'uv', 'document-mcp-wheelhouse', 'pyyaml']);

// 이 부품들의 판이 바뀌면 실행기·바로가기(⑤-7)를 다시 쓴다 — 전부 `.cmd` 안에
// 판 폴더 이름이 그대로 박히는 부품들이다.
export const RELAY_PARTS = Object.freeze(['node', 'face', 'dash', 'teamclaude', 'manage', 'updater', 'messenger']);

// 업데이트가 건드리지 않는 단계(사람의 영혼 쪽).
export const KEEP_DONE = Object.freeze(['skeleton', 'structure', 'ontology', 'checks']);

function lockField(lock, manifest, partId, field) {
  const fromManifest = manifest?.parts?.[partId]?.[field];
  if (fromManifest !== undefined && fromManifest !== null) return fromManifest;
  const fromLock = lock?.parts?.[partId]?.[field];
  return fromLock === undefined ? null : fromLock;
}

/**
 * 잠금표·꾸러미 목록이 말하는 "이번 판의 그 부품". `setup/unpack.mjs`
 * `partIdentity()` 와 같은 모양이다(판·지문·dest 마지막 칸).
 */
export function partIdentity(lock, manifest, partId) {
  const version = lockField(lock, manifest, partId, 'version');
  const sha256 = manifest?.parts?.[partId]?.sha256 ?? lock?.parts?.[partId]?.sha256 ?? null;
  const dest = lockField(lock, manifest, partId, 'dest');
  const commit = lock?.parts?.[partId]?.commit ?? null;
  const tail = dest ? String(dest).split('/').filter(Boolean).pop() : null;
  return { version: version ?? null, sha256, tail: tail ?? null, commit };
}

/**
 * 영수증이 기억하는 "지금 깔려 있는 그 부품".
 * ① `installed.<부품>`(판·지문) → ② ⑤-1 풀기가 적어 둔 identity 순으로 본다.
 */
export function priorIdentity(receipt, partId) {
  const installed = receipt?.installed?.[partId];
  if (installed && (installed.version || installed.sha256 || installed.commit)) {
    return {
      version: installed.version ?? null,
      sha256: installed.sha256 ?? null,
      tail: null,
      commit: installed.commit ?? null,
    };
  }
  const fromUnpack = receipt?.setup?.unpack?.recorded?.parts?.[partId]?.identity;
  if (fromUnpack && typeof fromUnpack === 'object') {
    return {
      version: fromUnpack.version ?? null,
      sha256: fromUnpack.sha256 ?? null,
      tail: fromUnpack.tail ?? null,
      commit: fromUnpack.commit ?? null,
    };
  }
  return null;
}

// 지문 > 판 > 커밋 > dest 마지막 칸 순으로 비교한다(unpack.sameIdentity 와 같은 규칙).
// 비교할 값이 한 쌍도 없으면 "모른다" = 바뀐 것으로 친다 — 모르는 채 건너뛰는
// 것보다 한 번 더 도는 편이 안전하다(모든 단계가 멱등이다).
export function partChanged(receipt, lock, manifest, partId) {
  if (!lock?.parts?.[partId] && !manifest?.parts?.[partId]) return false; // 이번 판에 없는 부품
  const now = partIdentity(lock, manifest, partId);
  const before = priorIdentity(receipt, partId);
  if (!before) return true;
  if (before.sha256 && now.sha256) return before.sha256 !== now.sha256;
  if (before.version && now.version) return before.version !== now.version;
  if (before.commit && now.commit) return before.commit !== now.commit;
  if (before.tail && now.tail) return before.tail !== now.tail;
  // 견줄 짝이 한 쌍도 없다. 두 기록이 **글자 그대로 같으면** 바뀐 것이 없다고
  // 본다(잠금표에 판·지문이 없는 부품 — `dest: "/"` 낱개 파일 등). 한쪽에만
  // 값이 있으면 모르는 것이므로 바뀐 것으로 친다.
  return JSON.stringify(before) !== JSON.stringify(now);
}

/**
 * planUpdateReset({ receipt, lock, manifest })
 *   → { reset: [단계…], keptDone: [단계…], changed: [부품…], reasons: { 단계: 이유 } }
 *
 * 영수증을 **고치지 않는다**(판단만 한다). 고치는 것은 applyUpdateReset.
 */
export function planUpdateReset({ receipt, lock, manifest = null } = {}) {
  const reset = [];
  const reasons = {};
  const changed = [];

  const partIds = new Set([
    ...Object.keys(lock?.parts ?? {}),
    ...Object.keys(manifest?.parts ?? {}),
  ]);
  for (const partId of partIds) {
    if (partChanged(receipt, lock, manifest, partId)) changed.push(partId);
  }
  changed.sort();

  for (const id of ALWAYS_RESET) {
    reset.push(id);
    reasons[id] = 'always';
  }
  const venvChanged = VENV_PARTS.filter((p) => changed.includes(p));
  if (venvChanged.length > 0) {
    reset.push('venv');
    reasons.venv = `parts:${venvChanged.join(',')}`;
  }
  const relayChanged = RELAY_PARTS.filter((p) => changed.includes(p));
  if (relayChanged.length > 0) {
    reset.push('relay');
    reasons.relay = `parts:${relayChanged.join(',')}`;
  }
  // 되돌리지 않은 단계 중 지금 `done` 인 것들(= 그대로 건너뛸 것들).
  const keptDone = [...KEEP_DONE, 'venv', 'relay']
    .filter((id) => !reset.includes(id) && receipt?.setup?.[id]?.status === 'done')
    .sort();

  return { reset, keptDone, changed, reasons };
}

/**
 * applyUpdateReset(receipt, plan, { now }) — plan.reset 의 단계를 `pending` 으로.
 * 옛 기록(recorded·pending)은 지우지 않고 그대로 두고, 왜 되돌렸는지만 덧붙인다.
 */
export function applyUpdateReset(receipt, plan, { now = new Date() } = {}) {
  receipt.setup = receipt.setup ?? {};
  for (const id of plan?.reset ?? []) {
    const prior = receipt.setup[id] ?? {};
    receipt.setup[id] = {
      ...prior,
      status: 'pending',
      code: null,
      message: null,
      resetBy: 'auto-update',
      resetReason: plan?.reasons?.[id] ?? 'always',
      resetAt: now.toISOString(),
    };
  }
  return receipt;
}

export default { planUpdateReset, applyUpdateReset, partChanged, partIdentity, priorIdentity };
