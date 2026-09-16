# payload-src/policy — 새 영혼에 놓이는 지침·정책 원본

빌드가 이 폴더를 `payload/policy`로 복사하고, 설치 엔진 ⑤-3·⑤-4가 아래처럼 배치한다. 여기가 단일 원본이므로 배치된 사본을 고치지 말고 이 파일들을 고친다.

- `root-AGENTS.md` → 영혼 루트의 `AGENTS.md`. 비서가 모든 작업 폴더에서 함께 읽는 전역 규칙집(정본 = `docs\설계-v2.md` 9절).
- `mini-AGENTS.md`(위계 폴더)·`mini-AGENTS-util.md`(`_`유틸 폴더) → 각 R/D/P/S/T·유틸 폴더의 `AGENTS.md`. `{{folderName}}`·`{{identity}}`를 채워 쓴다.
- `CLAUDE.md` → 루트와 모든 폴더에 그대로 복사하는 `@AGENTS.md` 한 줄 껍데기(클로드코드가 이걸 통해 같은 지침을 읽는다).
- `policy-summary.md` → `_agent\setup\`. 설치기가 지키는 약속(무삭제·질문 경계·바탕화면 금지·대기의 뜻·재실행 안전·로그 위치)을 사람이 읽는 글.
- `install-notice.txt`(UTF-8 BOM) → zip 루트의 「설치가 안 되면.txt」이자 홈페이지 `install.html#sac` 문구의 단일 원본.
- `ontology-registry-template.yml` → `_ontology\registry.yml`. 항목 0개인 빈 등록부(구조와 주의만).
- `hooks\` → `_agent\claude\scripts\`. 전역 PreToolUse 훅 2종(일괄 킬 차단·경로 실존 가드)과 각각의 `.test.py`.
- `licenses\` → zip의 `payload\policy\licenses\`. 부품별 허가서 사본이 모이는 자리 — 대부분 부품 수집(T07)이 자동으로 채우고, 원문 파일이 없는 부품(예: 비상업 조건이 README에만 적힌 `ui-ux-pro-max`)만 사람이 여기에 직접 넣는다. 규칙과 현재 수동 항목은 `licenses\README.md`.
