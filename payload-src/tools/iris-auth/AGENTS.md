# iris-auth — 로그인 열쇠 만료 감시·1년 열쇠 발급 도구

중계기 계정 열쇠와 IRIS 클로드코드 자체 열쇠의 **만료일만** 모아 보고(`status.mjs`), 만료 전에 알리고, IRIS용 1년 열쇠(`claude setup-token`과 같은 요청: 권한 `user:inference`, `expires_in` 31536000)를 발급한다(`longkey.mjs`). IRIS 창(설정 → 계정·보안 → 로그인 열쇠)이 이 폴더를 찾아 30분마다 부르고, 갱신 단추도 이 도구를 실행한다.

- 열쇠 값은 화면·로그·상태 파일에 절대 쓰지 않는다. 상태 파일 `~\.config\iris-auth-status.json` 에는 이름·만료 시각·단계만 담는다.
- 1년 열쇠 파일 = `<CLAUDE_CONFIG_DIR>\secrets\iris-cli-token.json`. IRIS 창이 세션을 띄울 때 `CLAUDE_CODE_OAUTH_TOKEN` 으로 넣는다.
- 판정 규칙은 `lib.mjs` 한 곳(순수 함수, 시험 = `node --test tests/lib.test.mjs tests/longkey.test.mjs`).
- 설치 패키지가 넣은 부품이다 — 고치려면 설치 패키지 원본을 고쳐 새 판으로 낸다(이 폴더를 손으로 고치면 다음 업데이트가 덮는다).

<!-- 상위 AGENTS.md 규칙 재서술 금지 -->
