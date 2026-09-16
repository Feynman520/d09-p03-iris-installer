// 세팅 엔진 어댑터 — 서버와 `installer/setup/engine.mjs`(T18) 사이의 얇은 막.
//
// 왜 막이 필요한가: 엔진은 아직 없다(T13~T18이 만드는 중). 서버가 엔진을
// 정적으로 import 하면 엔진 파일이 없는 동안 서버 자체가 뜨지 못한다. 그래서
// 엔진은 **동적으로** 부르고, 없으면 사용자에게 보일 한 문장과 함께
// `{ ok:false, code:'E-NOT-IMPLEMENTED' }`를 돌려준다. 시험에서는 `importer`에
// 가짜를 넣어 엔진 없이도 전 단계를 돌린다. 엔진이 실제로 채워지면 이 파일은
// 고칠 것이 없다.
//
// 계약 = docs/세팅엔진-계약-v2.md:
//   runSetup(ctx, { failAt, onStage }) -> { ok, failed?: {id, code, message}, pending: [] }

export const NOT_IMPLEMENTED = 'E-NOT-IMPLEMENTED';

function notImplemented(detail) {
  return {
    ok: false,
    code: NOT_IMPLEMENTED,
    message: '세팅 엔진이 아직 이 패키지에 들어 있지 않습니다.',
    failed: { id: null, code: NOT_IMPLEMENTED, message: '세팅 엔진이 아직 이 패키지에 들어 있지 않습니다.' },
    pending: [],
    detail: detail == null ? null : String(detail),
  };
}

export function createSetupRunner({ importer = () => import('../../setup/engine.mjs') } = {}) {
  return {
    async runSetup(ctx, options = {}) {
      let mod;
      try {
        mod = await importer();
      } catch (err) {
        return notImplemented(err?.message ?? err);
      }
      if (!mod || typeof mod.runSetup !== 'function') {
        return notImplemented('setup/engine.mjs exports no runSetup()');
      }
      const result = await mod.runSetup(ctx, options);
      // 엔진이 무엇을 돌려주든 서버가 읽는 세 칸은 늘 있게 한다.
      // 원본을 **먼저** 펼치고 정규화한 세 칸을 뒤에 덮는다 — 순서가 반대면
      // 엔진이 `ok`·`failed`·`pending` 을 빠뜨렸거나 이상한 모양으로 돌려줬을 때
      // 그 값이 정규화를 이겨 버려, 정규화를 하는 뜻이 사라진다.
      return {
        ...(result ?? {}),
        ok: result?.ok === true,
        failed: result?.failed ?? null,
        pending: Array.isArray(result?.pending) ? result.pending : [],
      };
    },
  };
}
