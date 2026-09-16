// 온라인 묶음 어댑터 — 서버와 `installer/lib/online.mjs`(T19) 사이의 얇은 막.
// 설계 의도는 setup-runner.mjs 머리말과 같다(아직 없는 모듈을 동적으로 부르고,
// 없으면 `E-NOT-IMPLEMENTED`; 시험에서는 가짜 주입).
//
// 서버가 쓰는 표면(설계-v2 7절 / docs/설치기-API-v2.md `POST /api/online/*`):
//   checkNet({ subscriptions })            -> { ok, blocked: [host…] }
//   installClaude({ root, ... })           -> { ok, state, source, code }
//   installDocumentSkills({ root, ... })   -> { ok, state, commit, code }
//   startLogin({ provider, root, ... })    -> { ok, state, reason }
//   loginStatus({ provider, root, ... })   -> { state, cli, relay, reason }
//   startRelay({ root, ... })              -> { ok, state, accounts }

export const NOT_IMPLEMENTED = 'E-NOT-IMPLEMENTED';

// 화면에 그대로 나갈 한 문장. "중계기"라고만 쓴다 — 사용자에게 보이는 글에
// 중계기의 제품 이름을 쓰지 않는다(설계-v2 7절).
const MESSAGE = '온라인 묶음이 아직 이 패키지에 들어 있지 않습니다.';

function notImplemented(detail) {
  return { ok: false, code: NOT_IMPLEMENTED, message: MESSAGE, detail: detail == null ? null : String(detail) };
}

async function call(importer, name, args) {
  let mod;
  try {
    mod = await importer();
  } catch (err) {
    return notImplemented(err?.message ?? err);
  }
  if (!mod || typeof mod[name] !== 'function') {
    return notImplemented(`lib/online.mjs exports no ${name}()`);
  }
  return mod[name](args);
}

export function createOnlineRunner({ importer = () => import('../online.mjs') } = {}) {
  return {
    checkNet: (args) => call(importer, 'checkNet', args),
    installClaude: (args) => call(importer, 'installClaude', args),
    installDocumentSkills: (args) => call(importer, 'installDocumentSkills', args),
    startLogin: (args) => call(importer, 'startLogin', args),
    loginStatus: (args) => call(importer, 'loginStatus', args),
    startRelay: (args) => call(importer, 'startRelay', args),
  };
}
