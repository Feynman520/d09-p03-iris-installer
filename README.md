# IRIS 설치 패키지 (IRIS Installer)

아무것도 설치되지 않은 윈도우 PC에 **zip 하나(두 번 클릭)** 로 IRIS 체계 전체를 끝까지 설치하는 설치기와, 그 zip을 재현 가능하게 만드는 빌드·검증 도구입니다. 사람이 직접 하는 일은 **구독 계정 로그인 하나**뿐입니다.

> **IRIS** = 시스템 전체 이름. 설치되는 것 = 동봉 런타임(Node·Python·Git) · 에이전트 CLI(Claude Code·Codex) · 계정 중계기 · IRIS 창(IRIS-Face) · 세팅가이드. 전부 `C:\IRIS` 한 폴더 안에 들어가고, 바깥에는 바탕화면 「IRIS」 바로가기 하나만 생깁니다.

## 사용자가 하는 일

```text
① zip 풀기  →  ② IRIS-설치.cmd 두 번 클릭  →  ③ 브라우저에 설치 화면
      ↓
ⓐ 준비 확인 (자동)  →  ⓑ 설치 위치 확인 (자동, C:\IRIS)  →  ⓒ 구독 고르기  →  ⓓ 설치 (약 1 GB, 수 분)
      ↓
ⓔ 계정 로그인 (브라우저에서 한 번)  →  ⓕ IRIS 창이 열리고 비서가 세팅을 이어받음
```

요구 사항: 윈도우 10(1809) 이상 64비트, C 드라이브 여유 2 GB 이상, 인터넷(Claude Code 내려받기·로그인), Claude(claude.ai) 또는 ChatGPT(chatgpt.com) **유료 구독**.

## 저장소 구조

| 폴더 | 정체 |
|---|---|
| `installer/` | zip에 들어가는 설치기 — `IRIS-설치.cmd`·`bootstrap.ps1`(겉옷, ASCII 전용) · `server.mjs`+`lib/`(속옷, 127.0.0.1:3460) · `ui/index.html`(단일 파일 화면) |
| `build/` | 공장 — `lock.json`대로 부품 수집 → TeamClaude 로컬 패치 → 개인정보 정화 → 매니페스트(SHA-256) → 포장 |
| `verify/` | 검사소 — `static.mjs`(정적 ①~⑨) · `reproduce.mjs`(두 번 빌드해 부품 해시 일치) · `e2e-checklist.md`(새 PC 실행 검사 대장) |
| `updater/` | 적용기 — `apply.mjs` 한 파일(의존성 0). 설치되면 `_agent\shared\tools\updater\` |
| `patches/` | TeamClaude 로컬 패치 규칙(앵커→치환)과 관리 스크립트 |
| `lock.json` | 부품 잠금표 — 버전·URL·SHA-256(`latest` 금지) |
| `docs/` | 설계(`설계.md`), 검증기록, 화면 캡처 |
| `_build/` | 자동 출력(캐시·스테이지·zip). git 제외 |

## 빌드와 검증 (개발 PC)

```powershell
npm test                                  # node:test 단위 시험 (외부 의존 0)
node build/build.mjs                      # 부품 내려받기 + 형제 프로젝트 수집 + 포장 → _build/out/IRIS-Setup_v<판>_<날짜>.zip
node verify/static.mjs                    # 정적 검사 ①~⑨ (매니페스트·정화·node-pty·패킹된 서버 기동 등)
node verify/reproduce.mjs                 # 재현성 검사 (두 번 빌드, 11개 부품 sha256 일치)
```

- 형제 프로젝트(IRIS-Face 등)의 위치는 `lock.json`의 `source`가 가리키며, 다른 PC에서는 `IRIS_FACE_SOURCE`·`IRIS_DASH_SOURCE`·`IRIS_GUIDES_SOURCE` 환경변수로 바꿉니다.
- Claude Code는 약관상 동봉하지 않고 설치 때 npm에서 잠근 버전을 내려받습니다(`lock.json parts.claude.redistribute: "download"`).
- 개발 PC에서 설치기를 연습할 때는 `IRIS_INSTALLER_SOUL_NAME=<임시이름>`과 `IRIS_INSTALLER_NO_USER_ENV=1`을 주고 띄워, 진짜 `C:\IRIS`와 사용자 환경변수를 건드리지 않게 합니다. 끝나면 임시 폴더를 지웁니다.

## 업데이트 (v1.3.0부터)

새 판이 나오면 **IRIS 창의 설정 → 업데이트**에서 단추 하나로 끝납니다. 사람이 zip을 다시 받아 두 번 클릭할 일은 없습니다.

```text
IRIS 창이 새 판을 확인(하루 1회) → 사용자가 「업데이트」 → 내려받기·서명 검증 → 창이 꺼지며 적용기 실행
      ↓
적용기(_agent\shared\tools\updater\apply.mjs)
  · 창이 완전히 꺼질 때까지 기다림(PID + 포트, 최대 90초 — 안 꺼지면 아무것도 바꾸지 않음)
  · IRIS 창 부품만 바꾸는 경우: 옛 폴더를 .prev 로 밀어내고 새 폴더를 앉힌 뒤 state·modules·node_modules 를 넘김
  · 구조판(설치 패키지)까지 바뀐 경우: IRIS-설치.cmd --auto 를 띄우고 물러남
      ↓
자동 모드 설치기 — 준비 확인 → 영수증과 비교해 바뀐 부품만 교체 → 로그인 생략 → 영수증 갱신 → IRIS 창 다시 열기
```

- 자동 모드는 **이미 영수증이 있는 PC에서만** 발동합니다. 새 PC에서 `--auto`를 줘도 평소의 여섯 단계 화면으로 갑니다.
- 사용자 자료(R/D/P·기억·설정·시크릿)는 업데이트가 건드리지 않습니다. 바뀐 부품의 옛 판은 `.prev`로 남습니다.
- 계약 정본(Face·설치기·적용기·릴리스 도구·홈페이지 공통)은 IRIS-Face(P02) 저장소의 `docs\설계-업데이트-2026-09-14.md`이고, P03이 맡는 몫은 `docs\설계.md` 12절입니다.

## 원칙

- zip을 손으로 고치지 않습니다. 원본 수정 → 재빌드 → 검사소 통과 → 새 판.
- 설치기는 사용자 자료를 절대 지우거나 덮어쓰지 않습니다. 이미 있는 것은 `.prev`로 옆에 남깁니다.
- 영수증(`_agent\setup\package-receipt.json`)·로그에 토큰·비밀을 쓰지 않습니다. zip 어디에도 개인 식별자가 없도록 정화 규칙이 빌드와 저장소 이력을 검사합니다.

## 허가서

이 저장소는 MIT입니다(`LICENSE`). 동봉 부품의 허가서 사본은 zip 안 `payload/licenses/NOTICES.md`에 함께 들어갑니다.
