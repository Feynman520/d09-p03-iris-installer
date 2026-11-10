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
- **두 비서는 늘 함께 설치·활성**(2.0.38, 2026-09-23 사용자 결정): 로그인 화면에서 무엇을 고르든 클로드·코덱스 프로그램·심·영수증 `installed.<agent>.active:true`를 둘 다 만든다 — 고른 것은 로그인 상자만 가른다(고르지 않은 쪽 내려받기 실패는 경고). 계정은 나중에 대시보드에서 더하면 바로 붙는다. 업데이트는 `claude.cmd`가 **없을 때만** Claude Code를 채운다(옛 코덱스 단독 설치 PC — Face `missingAgents`와 같은 기준, 실패는 기록만). 같은 계정 재로그인은 중계기가 중복 제거해 개수가 안 늘므로 `import` + 계정 ≥1 이면 완료로 본다(`relayDedup`). 상세 = `docs\검증기록.md` 5-50.
- **비서 자동 업데이트**(2.0.45, 2026-10-16 사용자 결정 — 설계 정본 = `docs\설계-비서자동업데이트.md`): 설치 PC 의 클로드코드·코덱스는 `tools\updater\agents.mjs`(실행기 `--kick`, 6시간에 한 번)가 공식 검증(클로드 stable + manifest sha256 · 코덱스 npm latest + 처음 본 지 72시간 + npm integrity)을 거쳐 스스로 올린다. 잠금표 원칙의 **유일한 예외**이며 zip 자체는 계속 잠금 판으로 만든다. 클로드 전달자 `claude.cmd` 의 글자는 `online.mjs claudeForwarderText` 와 `agents.mjs claudeForwarder` 두 곳이 같아야 한다(시험이 묶음). **`lock.json` 의 클로드·코덱스 잠금 판은 공식 안정판까지만 올린다**(2026-11-10 사용자 결정 — 클로드 = stable 채널 판, 코덱스 = 72시간 지난 판; latest 판으로 잠그면 업데이트 도구가 내리지 않아 그 PC 가 안정판보다 앞선 판에 머문다). 잠금 판을 올릴 때는 설치기 씨앗을 넣은 오프라인 첫 실행 재현(시작 안내창·예상 기록·권한 모드)을 거친다(검증기록 5-74).
- **MCP 중계기**(2.0.52, 2026-10-28 사용자 결정 — 설계 정본 = `docs\설계-MCP중계기.md`, 원본 = `mcp-relay\`): IRIS 기본 구성요소다(선택 모듈·별도 P 아님). 설치기는 로컬 MCP 항목의 실행 명령만 안내원(`relay.py shim`)으로 쓰고 실제 명령은 등록부(`<설치 폴더>\_agent\shared\mcp-relay\registry\`)에 둔다. 실제 MCP는 세션이 처음 도구를 쓸 때 그 세션 전용으로 켜지며, 공용 중계기(`relay.py daemon`, 포트 3461)는 실행기 kick 줄로 IRIS 시작 때 뜬다. TeamClaude·Face에는 중계기 코드를 넣지 않는다. 중계기 시험은 실제 `CLAUDE_CONFIG_DIR`·`CODEX_HOME`을 건드리지 않게 임시 영혼 루트로만 한다(2026-10-28 사고 기록 = `mcp-relay\AGENTS.md`).
- **삭제기**(2.0.39, 설계 정본 = `docs\설계-삭제기.md`): zip 루트 `IRIS-삭제.cmd` → `installer\uninstall.ps1`(ASCII, 한글 문구는 `uninstall-ko.json`). **영수증(`_agent\setup\package-receipt.json`)이 JSON으로 읽히는 폴더만** 지우므로 영수증 없는 이 개발 PC의 `C:\IRIS`는 거부되지만, 그래도 진짜 `C:\IRIS`·진짜 환경변수를 대상으로 돌리지 않는다 — 시험은 `-ScanRoots`·`-EnvSubKey`/`-RunSubKey`(시험 키)·`-DesktopDir`·`-WorkDir`를 임시로 주고, 예행연습은 업그레이드 게이트가 만든 `C:\IRIS-upg`에만 한다.
- **로그인 열쇠 감시 도구**(2.0.53, 2026-11-02 사용자 신고 "다른 사용자는 계정·보안에 복구 문구만 있고 로그인 열쇠가 없다"): 부품 `iris-auth`(원본 = 저장소 `payload-src\tools\iris-auth`, 개발 PC 도구의 일반화 사본) → `_agent\shared\tools\iris-auth`. IRIS 창은 이 폴더가 있어야 「로그인 열쇠」 절·만료 3일 전 알림·「1년 열쇠 받기」를 켠다. 개발 PC 원본을 고치면 이 사본도 같은 차례에 맞춘다.
- **연결 설정은 데이터 호환 변경이다**(2.0.54, 2026-11-04 다른 선생님 신고 — 2.0.49 의 코덱스 `openai → iris` 전환 뒤 옛 대화 재개 실패): 코덱스 `model_provider`·중계기 연결 방식을 바꾸는 판은 ① IRIS 창의 재개 호환(P02 `daemon/codexcompat.mjs`)이 새 이름을 다루는지 보고 ② 업그레이드 게이트 ③ⓚ("업데이트 전 대화가 업데이트 뒤에도 재개 가능")를 통과시킨다. `config.toml` 을 바꿀 때마다 바꾸기 전 사본·이력 한 줄이 `<설치 폴더>\_agent\setup\config-history\` 에 남는다(`adapters.mjs recordConfigChange`, 비밀값 없음). Claude 계정 옮겨 담기(`teamclaude import`)는 뒤에서 돌고(60초 한도), 화면은 "n초째"와 실패 원인 한 줄을 보인다.
- **🔴 두 갈래 배포 — 새 판은 최신판, 안정판은 사용자가 올린다**(2026-11-09 사용자 결정, 설계 정본 = `docs\설계-배포채널-2026-11-09.md`): 홈페이지 `iris-workspace.com` 에는 「안정판(권장)」과 「최신판(시험 중)」 두 단추가 있고, **IRIS 안 「업데이트」는 안정판만** 받는다(GitHub `releases/latest` 는 사전 공개를 주지 않고, 미러 `latest.json` 은 안정판 전용, 창 업데이트기도 사전 공개 응답을 버린다). 새 판(설치 패키지·창·메신저)은 **언제나 사전 공개(prerelease)로만** 낸다 — 릴리스 도구 기본값 `--channel latest`. 안정판으로 올리기는 **사용자가 학교 PC 에서 시험하고 "안정판으로 올려"라고 한 뒤에만** `iris-release.mjs promote --installer <판> --face <판> [--yes]` 로 한다(설치 패키지 안의 창 판이 함께 올리는 창 판과 다르면 거절 · 해시·서명·미러를 다시 확인 · 다시 실행해도 안전). 에이전트가 스스로 안정판으로 올리거나 `--channel stable` 로 내지 않는다.
- **▶ 다음 배포 때 반드시 함께 낼 것**(2026-11-06 사용자 지시 "있으면 다음 배포때 꼭 같이 배포하도록 함" — 판을 낼 때마다 이 목록을 먼저 확인하고, 넣은 항목은 지운다):
  - (지금 비어 있음 — MCP 중계기 1.0.1 오삭제 수정은 2.0.55 에 넣었다, `docs\검증기록.md` 5-70·5-71)
- **클로드 훅 = 파워셸 고정 · 시작 안내창 "봤음"**(2.0.55, 2026-11-09 학교 컴퓨터실 3대 신고): 동봉 MinGit 에는 `bash.exe` 가 없어 Git 을 따로 깐 적 없는 PC 에서 클로드 훅이 깨졌다 → `adapters.mjs claudeHookGroups` 의 훅은 전부 `shell: 'powershell'` + `& "<심>" "<스크립트>"; exit $LASTEXITCODE`(파워셸 `-Command` 는 종료 코드 2 를 1 로 뭉갠다 — 실측) 이고, 업데이트 때 옛 판 훅도 `updateOwnedHook` 이 명령·껍데기를 함께 갈아 끼운다. **새 클로드 훅을 더할 때도 이 꼴로 만든다**(`"a" "b"` 꼴은 파워셸 문법 오류). 플러그인이 가진 bash 전용 훅(수퍼파워 등)은 Git Bash 없는 PC 에서 시작 때 오류 한 줄을 남기지만 막지는 않는다. `firstrun.mjs CLAUDE_START_NUDGES` = IRIS 창 2.99 `daemon/trust.mjs` 와 같은 값(크롬 안내 · 전체화면 권유 · 자동 모드 기본값 권유를 "이미 봤음"). 상세 = `docs\검증기록.md` 5-71.
- **빠른 내려받기 창구**(2026-11-09, 학교 유선 실측 r2.dev 초당 60~80KB → pages.dev 초당 30~43MB): 홈페이지 단추·새 IRIS 창의 미러 1순위는 R2 `iris-downloads` 를 내주는 Cloudflare Pages `https://iris-workspace-dl.pages.dev`(코드 = `mirror-worker\worker.js`, 배포 = `node build/mirror-worker-deploy.mjs`, 시험 = `tests\mirror-worker.test.mjs`). 허용 이름 = `IRIS-Setup_*.zip`·`iris-<부품>-vX.Y.Z*.zip`(+`.sha256`·`.sha256.sig`)·`latest.json` — **첨부 이름 모양을 새로 만들면 `ALLOWED_KEY` 부터 넓히고 재배포**한다(`mirror-upload.mjs`·릴리스 도구가 창구 200 을 확인하므로 안 넓히면 미러 실패로 걸린다). r2.dev 는 옛 IRIS 창 허용 주소라 끄지 않고, `latest.json` 의 url 칸도 r2.dev 그대로 둔다(새 창은 `fastMirror` 로 돌림). `*.workers.dev` 는 학교망에서 미국 경유·주소에 계정 이름이 붙어 쓰지 않는다.
- 관계: IRIS-Face(P02)·TeamClaude 대시보드·세팅가이드(`_setup-guides`)를 **소비**한다 — 그 원본을 여기서 고치지 않는다. 설치기 포트는 3460(3458=Face, 3459=Face 시험 데몬).
- **공개 저장소**(2026-09-13 밤, Task 20): `https://github.com/Feynman520/d09-p03-iris-installer` public·MIT·`.stack=A`·remote `git@gh-A:`·기본 브랜치 main(dev/v1 병합)·태그 `iris-installer--vX.Y.Z`. 설치 zip은 저장소가 아니라 **GitHub Release 첨부**(`…/releases/latest`)로만 배포한다. **⚠ Release 첨부 이름의 한글은 GitHub가 지우므로 첨부는 영문 이름(`IRIS-Setup_v<판>_<날짜>.zip`+`.sha256`)으로 올린다**(v1.2.0 실측). 새 판 순서(정본 도구 = `<IRIS 루트>\_agent\claude\tools\iris-release.mjs installer` — 판 올림·검사·**서명**·태그·릴리스·미러·홈페이지를 한 번에; 행렬 S01~S11 전부 통과가 문 앞 조건). 행렬이 아직 안 찬 상태에서 **수동으로** 낼 때는 같은 산출물을 빠짐없이 만든다: 재빌드 → `verify/static.mjs`·`reproduce.mjs` → **`verify/upgrade.mjs`(업그레이드 게이트, 2.0.31 — 직전 판을 `C:\IRIS-upg` 에 설치한 뒤 새 판 `--auto` 로 얹어 부품 전부 제자리·실행 파일 문법·인수 문서를 판정. 2.0.29 "프록시 연결 불가" 재발 방지. 통과 못 하면 내지 않는다)** → **`verify/login-probe.mjs`(실제 로그인 시험, 2.0.36 — 임시 폴더에 Claude Code 를 진짜로 받고 창 없는 로그인을 띄워 자동 복귀 주소 `localhost:<포트>/callback` 이 잡히는지 + CLI 가 없을 때 창을 띄우지 않고 「다시 받기」 안내로 멈추는지. OAuth 는 끝내지 않음. 2026-09-23 "로그인 브라우저가 전혀 안 뜸" 재발 방지)** → **`<zip>.sha256.sig` 서명**(Ed25519, P02 `daemon/modsign.mjs` `signManifest`, 열쇠 = `_agent\claude\secrets\iris-module-signing-2026-09.key` — **없으면 IRIS 창의 업데이트가 「.sha256.sig 첨부가 없습니다」로 거절한다**, 2026-09-18 실측) → 태그 푸시 → **`gh release create --prerelease`**(zip + .sha256 + .sha256.sig — 2026-11-09부터 새 판은 최신판, 아래 「두 갈래 배포」) → **`node build/mirror-upload.mjs --out _build/out-<판>`(zip·.sha256·.sig 미러 업로드 + 공개 주소 200/크기 검증. `--stable` 을 안 붙이면 `latest.json` 을 건드리지 않는다)** → **`node <IRIS 루트>\_agent\claude\tools\iris-release.mjs preview-homepage installer <판> --yes`**(홈페이지 `CONFIG.preview.installer`·미러 목록 덧붙임 — 값은 공개된 릴리스에서 읽음). 푸시 전 R07 가드레일(`.stack`)과 정적 검사 ⑦⑧(저장소·이력 개인 문자열 0건)을 거친다. 홈페이지(P05, `iris-workspace.com`)는 이 저장소의 최신 릴리스만 가리키되 **내려받기 단추는 미러 1순위**다 — 학교·회사 망이 GitHub 릴리스 첨부 서버(`release-assets.githubusercontent.com`)만 끊는 것을 2026-09-14~17 실제 사용자가 4회 겪었다. **미러 검증이 실패한 판은 홈페이지에 올리지 않는다.**
- 고정 사항(2026-09-13 사용자 확정, 설계 11절): 설치 폴더는 **`C:\IRIS` 절대 고정**(사용자에게 이름을 묻지 않음), 바깥에는 바탕화면 「IRIS」 바로가기 하나. 사용자에게 보이는 글은 "IRIS"/"IRIS 창"(IRIS-Face는 내부 명칭). **이 개발 PC에서 설치기를 연습할 때는 반드시 `IRIS_INSTALLER_SOUL_NAME=<임시이름>`(+`IRIS_INSTALLER_NO_USER_ENV=1`)로 띄운다** — 진짜 `C:\IRIS`에 설치가 덮이지 않게. 시험 소울은 끝나면 지운다.

<!-- 상위(루트/R07/D09) AGENTS.md 규칙 재서술 금지 -->

<!-- self-improve:begin — 자기개선 플러그인이 자동으로 관리하는 구역입니다. 손으로 고치지 마세요. 규칙을 빼려면 에이전트에게 "규칙 R-001 빼"라고 말하세요. -->
## 자기개선 규칙 (자동 적용)

- [R-024] GitHub Release 첨부 파일 이름의 한글은 업로드 때 '.'로 지워지므로, 릴리스 첨부(zip·sha256)는 처음부터 영문 이름으로 올리고 sha256 파일 내용의 파일명도 그 영문 이름으로 맞춘다. (근거 기록: 2026-09-13-017, 2026-09-18-002)
- [R-037] 설치기 시험·연습은 진짜 C:\<영혼이름>\ 아래에 흔적을 남기지 않는다 — 서버를 띄우는 단위 시험은 soulName과 함께 임시 폴더 soulRoot를 넘기고, 손 연습은 IRIS_INSTALLER_SOUL_NAME+IRIS_INSTALLER_NO_USER_ENV로 띄운 뒤 생긴 시험 폴더를 바로 지운다. (근거 기록: 2026-09-13-015, 2026-09-28-026)
- [R-038] P03 문서(docs/*.md·AGENTS.md)에는 설치 경로 원문(드라이브 문자로 시작하는 IRIS 설치 폴더 경로)을 쓰지 말고 `<설치 폴더>\…`로 적으며, 커밋 전에 `node verify/static.mjs`의 ⑦을 먼저 통과시킨다 — 이력에 들어가면 ⑧이 실패해 커밋을 다시 써야 한다. (근거 기록: 2026-09-21-005, 2026-09-28-030)
- [R-039] 릴리스 전에는 새 판 처음 설치 시험만 믿지 말고, 직전 판을 설치한 위에 새 판을 얹는 자동 업그레이드 시험(부품 전부 제자리·실행 파일 문법 확인)을 통과시키며, 시험 루트가 이 PC의 살아 있는 인프라(3456 등)를 두드리지 않도록 오프라인 손잡이를 검사 코드까지 관통시킨다. (근거 기록: 2026-09-20-003, 2026-09-28-029)
<!-- self-improve:end -->
