---
id: iris:cxxgg3ov
type: project
code: P03
status_scheme: task5
lifecycle: active
tags:
- {kind: 소프트웨어/산출물 종류, value: Local App}
drawers: [docs]
aliases: ['P03-IRIS 설치 패키지(IRIS Installer) 〖Local App〗', 'R07-개발자(Developer)\D06-오픈소스(Open Source)\P03-IRIS 설치 패키지(IRIS Installer) 〖Local App〗']
relations:
  canonical: ['iris:wkknzac5/AGENTS.md']
created: '2026-09-10'
---
# P03-아이리스 설치 패키지(IRIS Installer) 〖Local App〗

아무것도 설치되지 않은 윈도우 PC에 **zip 하나(두 번 클릭)**로 IRIS 체계 전체(동봉 런타임·에이전트·TeamClaude·IRIS-Face·세팅가이드)를 끝까지 설치하는 설치기와, 그 zip을 이 PC에서 재현 가능하게 만드는 빌드·검증 도구. 사용자가 손으로 내려받거나 명령을 치는 단계는 0이 목표이며, 사람만 할 수 있는 순간은 구독 로그인 하나만 남긴다.

- 정본: 설계 = `docs\설계.md`(2026-09-10 사용자 확정 6조각), 검증 결과 = `docs\검증기록.md`. 구현 계획·진행은 `docs\구현계획.md`.
- 구조: `installer\`(zip에 들어가는 설치기: bootstrap.ps1·server.mjs·ui) · `build\`(공장: collect·sanitize·manifest·pack) · `verify\`(검사소) · `patches\`(TeamClaude 로컬 패치 규칙) · `lock.json`(부품 잠금표) · `_build\`(자동 출력, AGENTS.md 면제).
- 원칙: zip을 손으로 고치지 않는다(원본 수정 → 재빌드 → 검사소 통과 → 새 버전). 부품은 전부 버전·SHA-256으로 잠근다(`latest` 금지). 설치기는 사용자 자료를 절대 지우거나 덮어쓰지 않으며, 부품은 `_agent\shared\tools` 안에서만 산다.
- 관계: IRIS-Face(P02)·TeamClaude 대시보드·세팅가이드(`_setup-guides`)를 **소비**한다 — 그 원본을 여기서 고치지 않는다. 설치기 포트는 3460(3458=Face, 3459=Face 시험 데몬).
- **공개 저장소**(2026-09-13 밤, Task 20): `https://github.com/Feynman520/d09-p03-iris-installer` public·MIT·`.stack=A`·remote `git@gh-A:`·기본 브랜치 main(dev/v1 병합)·태그 `iris-installer--vX.Y.Z`. 설치 zip은 저장소가 아니라 **GitHub Release 첨부**(`…/releases/latest`)로만 배포한다. **⚠ Release 첨부 이름의 한글은 GitHub가 지우므로 첨부는 영문 이름(`IRIS-Setup_v<판>_<날짜>.zip`+`.sha256`)으로 올린다**(v1.2.0 실측). 새 판 순서(정본 도구 = `<IRIS 루트>\_agent\claude\tools\iris-release.mjs installer` — 판 올림·검사·**서명**·태그·릴리스·미러·홈페이지를 한 번에; 행렬 S01~S11 전부 통과가 문 앞 조건). 행렬이 아직 안 찬 상태에서 **수동으로** 낼 때는 같은 산출물을 빠짐없이 만든다: 재빌드 → `verify/static.mjs`·`reproduce.mjs` → **`verify/upgrade.mjs`(업그레이드 게이트, 2.0.31 — 직전 판을 `C:\IRIS-upg` 에 설치한 뒤 새 판 `--auto` 로 얹어 부품 전부 제자리·실행 파일 문법·인수 문서를 판정. 2.0.29 "프록시 연결 불가" 재발 방지. 통과 못 하면 내지 않는다)** → **`verify/login-probe.mjs`(실제 로그인 시험, 2.0.36 — 임시 폴더에 Claude Code 를 진짜로 받고 창 없는 로그인을 띄워 자동 복귀 주소 `localhost:<포트>/callback` 이 잡히는지 + CLI 가 없을 때 창을 띄우지 않고 「다시 받기」 안내로 멈추는지. OAuth 는 끝내지 않음. 2026-09-23 "로그인 브라우저가 전혀 안 뜸" 재발 방지)** → **`<zip>.sha256.sig` 서명**(Ed25519, P02 `daemon/modsign.mjs` `signManifest`, 열쇠 = `_agent\claude\secrets\iris-module-signing-2026-09.key` — **없으면 IRIS 창의 업데이트가 「.sha256.sig 첨부가 없습니다」로 거절한다**, 2026-09-18 실측) → 태그 푸시 → `gh release create --latest`(zip + .sha256 + .sha256.sig) → **`node build/mirror-upload.mjs --out _build/out-<판>`(zip·.sha256·.sig 미러 업로드 + 공개 주소 200/크기 검증)** → 홈페이지(P05 `site.js`) `CONFIG.fallback.installer` 값과 **`CONFIG.mirror.assets`에 zip 이름 추가** + `index.html` 정적 href. 푸시 전 R07 가드레일(`.stack`)과 정적 검사 ⑦⑧(저장소·이력 개인 문자열 0건)을 거친다. 홈페이지(P05, `iris-workspace.com`)는 이 저장소의 최신 릴리스만 가리키되 **내려받기 단추는 미러 1순위**다 — 학교·회사 망이 GitHub 릴리스 첨부 서버(`release-assets.githubusercontent.com`)만 끊는 것을 2026-09-14~17 실제 사용자가 4회 겪었다. **미러 검증이 실패한 판은 홈페이지에 올리지 않는다.**
- 고정 사항(2026-09-13 사용자 확정, 설계 11절): 설치 폴더는 **`C:\IRIS` 절대 고정**(사용자에게 이름을 묻지 않음), 바깥에는 바탕화면 「IRIS」 바로가기 하나. 사용자에게 보이는 글은 "IRIS"/"IRIS 창"(IRIS-Face는 내부 명칭). **이 개발 PC에서 설치기를 연습할 때는 반드시 `IRIS_INSTALLER_SOUL_NAME=<임시이름>`(+`IRIS_INSTALLER_NO_USER_ENV=1`)로 띄운다** — 진짜 `C:\IRIS`에 설치가 덮이지 않게. 시험 소울은 끝나면 지운다.

<!-- 상위(루트/R07/D09) AGENTS.md 규칙 재서술 금지 -->

<!-- self-improve:begin — 자기개선 플러그인이 자동으로 관리하는 구역입니다. 손으로 고치지 마세요. 규칙을 빼려면 에이전트에게 "규칙 R-001 빼"라고 말하세요. -->
## 자기개선 규칙 (자동 적용)

- [R-024] GitHub Release 첨부 파일 이름의 한글은 업로드 때 '.'로 지워지므로, 릴리스 첨부(zip·sha256)는 처음부터 영문 이름으로 올리고 sha256 파일 내용의 파일명도 그 영문 이름으로 맞춘다. (근거 기록: 2026-09-13-017, 2026-09-18-002)
<!-- self-improve:end -->
