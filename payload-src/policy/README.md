# payload-src/policy — 새 영혼에 놓이는 지침·정책 원본

빌드가 이 폴더를 `payload/policy`로 복사하고, 설치 엔진 ⑤-3·⑤-4가 아래처럼 배치한다. 여기가 단일 원본이므로 배치된 사본을 고치지 말고 이 파일들을 고친다.

- `root-AGENTS.md` → 영혼 루트의 `AGENTS.md`. 비서가 모든 작업 폴더에서 함께 읽는 전역 규칙집(정본 = `docs\설계-v2.md` 9절).
- `mini-AGENTS.md`(위계 폴더)·`mini-AGENTS-util.md`(`_`유틸 폴더) → 각 R/D/P/S/T·유틸 폴더의 `AGENTS.md`. `{{folderName}}`·`{{identity}}`를 채워 쓴다.
- `CLAUDE.md` → 루트와 모든 폴더에 그대로 복사하는 `@AGENTS.md` 한 줄 껍데기(클로드코드가 이걸 통해 같은 지침을 읽는다).
- `policy-summary.md` → `_agent\setup\`. 설치기가 지키는 약속(무삭제·질문 경계·바탕화면 금지·대기의 뜻·재실행 안전·로그 위치)을 사람이 읽는 글.
- `install-notice.txt`(UTF-8 BOM) → zip 루트의 「설치가 안 되면.txt」이자 홈페이지 `install.html#sac` 문구의 단일 원본.
- `ontology-registry-template.yml` → `_ontology\registry.yml`. 항목 0개인 빈 등록부(구조와 주의만).
- `hooks\` → `_agent\claude\scripts\`. 전역 PreToolUse 훅 2종(일괄 킬 차단·경로 실존 가드 — 경로 가드는 루트 낱개 파일 차단 포함)과 클로드 Stop 훅 1종(안 끈 배경 명령 가드, 2.0.42), 각각의 `.test.py`. 2.0.67 부터 Antigravity 훅 다리 `agy-hook-bridge.py` 와 그 `.test.py` 도 함께 놓인다 — **놓기만 하고 어디에도 등록하지 않는다**(아래 절).
- `licenses\` → zip의 `payload\policy\licenses\`. 부품별 허가서 사본이 모이는 자리 — 대부분 부품 수집(T07)이 자동으로 채우고, 원문 파일이 없는 부품(예: 비상업 조건이 README에만 적힌 `ui-ux-pro-max`)만 사람이 여기에 직접 넣는다. 규칙과 현재 수동 항목은 `licenses\README.md`.

## 훅 다리 사본(`hooks\agy-hook-bridge.py`)이 개발 PC 원본과 일부러 다른 점 (2.0.67)

원본 = `<IRIS 루트>\_agent\claude\scripts\agy-hook-bridge.py` 와 `agy-hook-bridge.test.py`. 규칙은 `payload-src\tools\COPY-NOTES.md` 와 같다: 원본이 바뀌어도 **원본으로 덮지 않고** 기능 변경만 옮기며, 차이를 새로 만들면 이 표에 한 줄을 더한다. 이 글(README)은 꾸러미에 실리지 않는다.

| 자리 | 사본 | 원본 | 왜 |
|---|---|---|---|
| `agy-hook-bridge.py` 의 코드 | 원본과 같다(주석 · 설명글을 뺀 구문이 같다) | — | 다리는 자기 자리에서 가드 둘과 영혼 루트를 찾으므로 고칠 경로가 없다. |
| `agy-hook-bridge.py` 머리말 · 주석 | 일반 문장 + "설치기는 놓기만 한다 · 등록은 IRIS 창이 그 기능이 열린 PC 에서만" | 만든 날 · 검토 경위 · 실측한 판 번호 · 개발 PC 의 등록 자리 | 공개 저장소이고, 설치 PC 에서 읽는 사람이 다르다. |
| `agy-hook-bridge.test.py` 의 경로 | 가드 시험과 같은 방식: `IRIS_ROOT` 환경변수 → 시스템 드라이브에서 루트를 정하고 실존 최상위 폴더 하나를 골라 쓴다 · 없으면 건너뜀 · IRIS 밖 경로는 임시 폴더 · 사용자 폴더는 `~` | 개발 PC 의 폴더 이름 · 사용자 폴더가 글자로 적혀 있다 | 정화 규칙이 박힌 경로를 막는다. 어느 영혼에서도 돌아야 한다. |

놓는 방식: 부품 `hooks` 의 다른 파일과 같다(섞여 사는 폴더 `_agent\claude\scripts` 에 푼다 — `installer\setup\unpack.mjs` · 없을 때만 채우기 `adapters.mjs HOOK_EXTRAS`). **클로드 `settings.json` · 코덱스 `hooks.json` 에 넣지 않고, `HOOK_SCRIPTS` · `NAME_MATCHED_HOOKS` 에도 넣지 않는다.** 설치기는 Antigravity 의 설정 폴더(사용자 폴더 쪽)를 읽지도 쓰지도 않는다. 시험 = `tests\agy-hook-bridge.test.mjs`.
