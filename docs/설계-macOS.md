# IRIS 설치 패키지 — macOS 판 설계 (초안, 2026-10-27)

> 상태: **초안**. 정본 `설계-v2.md` 의 결정(D2-xx)은 아래 D-Mxx 가 macOS 에서 바꾸는 것만 빼고 그대로 유효하다.
> 원칙: **Windows 산출물은 한 글자도 바꾸지 않는다.** 운영체제 분기는 `installer/lib/platform.mjs` 한 곳을 거치고, Windows 쪽 시험은 Windows 에서 그대로 초록이어야 한다.

## 0. 한 줄 목표

Apple Silicon Mac 에서 zip 하나를 풀어 `IRIS-설치.command` 를 두 번 클릭하면, Windows 판과 같은 다섯 국면(준비 검사 → 질문 → 자동 세팅 → 로그인 → IRIS 창)이 끝까지 간다.

## 1. 결정 기록

| 번호 | 쟁점 | macOS 결정 | Windows 와 다른 까닭 |
|---|---|---|---|
| D-M01 | 코드 구조 | 같은 저장소·같은 모듈에 **운영체제 계층**(`installer/lib/platform.mjs`). 순수 함수는 `platform` 인자를 받아 어느 PC 에서나 시험한다 | 원작자 저장소에 PR 로 합친다 |
| D-M02 | 대상 | **macOS 13.5 이상 · Apple Silicon(arm64)**. Intel Mac 은 막는다 | Node 24 의 최저 지원 판. macOS 27 은 Apple Silicon 전용 |
| D-M03 | 설치 폴더 | **`~/IRIS` 고정**(홈 폴더 아래). 이름 질문 없음. 연습은 Windows 와 같은 `IRIS_INSTALLER_SOUL_NAME`·`IRIS_INSTALLER_NO_USER_ENV` | 일반 사용자가 쓸 수 있는 고정 자리는 홈뿐 |
| D-M04 | 진입 | zip 루트 `IRIS-설치.command` → `installer/bootstrap.sh`(POSIX sh, ASCII) → 동봉 node 로 `server.mjs`. sh 는 node 를 풀기 전까지만 일하고 나머지는 node 가 한다 | `.cmd`·PowerShell 이 없다 |
| D-M05 | Gatekeeper | 서명·공증 없이 시작. 처음 한 번 「시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기」 안내를 zip 안 `설치가 안 되면.txt`(mac 판)에. 풀어 놓은 부품은 설치기가 `com.apple.quarantine` 을 지운다(Windows 의 MotW 제거와 같은 자리) | SAC 대신 Gatekeeper. 공증(Developer ID)은 별도 결정 |
| D-M06 | 설치기 작업 폴더 | `~/Library/Application Support/IRIS-Installer`(로그·서버 PID·풀어 둔 node) | `%LOCALAPPDATA%\IRIS-Installer` 자리 |
| D-M07 | 심 | `_agent/shared/shims/` 에 **확장자 없는 POSIX sh**(LF, 실행 권한): `claude`·`codex`·`node`·`python`·`python3`·`git`·`uv`·`relay-ensure`. 내용(중계기 주소·설정 폴더·중계기 확인)은 `.cmd` 와 같다 | `.cmd` 를 못 쓴다 |
| D-M08 | 사용자 환경 | `~/.zprofile`(있으면 `~/.bash_profile` 도)에 표시된 한 덩어리(`# >>> IRIS >>>` … `# <<< IRIS <<<`)로 **PATH 앞에 심 폴더 하나만** 더한다. `CLAUDE_CONFIG_DIR` 등 네 값은 심 안에서만 건다 | 레지스트리가 없다. 이미 Claude Code 를 쓰는 Mac 의 설정을 바꾸지 않기 위해(v2 S08 "기존 무접촉") 전역 변수는 걸지 않는다 — **원작자 확인 필요** |
| D-M09 | 로그온 자동 시작 | `~/Library/LaunchAgents/com.iris-workspace.relay.plist` → 동봉 node 로 `relay-ensure.mjs`(창 없음) | HKCU Run + `.vbs` 자리 |
| D-M10 | 바로가기 | `<설치 폴더>/IRIS.command`(IRIS 창 실행) + `~/Applications/IRIS.app`(작은 앱 꾸러미, 아이콘 포함). 바탕화면은 쓰지 않는다 | 바탕화면 쓰기는 터미널의 「파일 접근」 허락 창을 부른다 |
| D-M11 | 폴더 아이콘 | `_cosmos.ico` → `sips` 로 PNG → `NSWorkspace.setIcon`(`osascript -l JavaScript`). 실패는 기록만 | `desktop.ini`·`attrib` 자리 |
| D-M12 | 부품 잠금 | `lock.json` 의 부품마다 선택 칸 `targets`(어느 대상에 싣는가)·`platforms.<대상>`(url·sha256·file·dest 등 덮어쓰기). 빌드는 `--target darwin-arm64`, zip 에는 **대상에 맞게 펼친 잠금표**만 싣는다 → 설치기는 대상을 몰라도 된다 | 부품마다 Mac 용 파일이 따로 있다 |
| D-M13 | Git | `dugite-native`(GitHub Desktop 이 쓰는 이동식 Git) macOS arm64 판을 동봉 | 공식 이동식 Git(MinGit) 의 macOS 판이 없다 |
| D-M14 | 중계기 관리 | `teamclaude-manage.mjs`(node). 3456 을 잡은 프로세스가 동봉 node + TeamClaude 진입 파일인지 `lsof`·`ps` 로 증명한 뒤에만 멈춘다(PID 만, 일괄 종료 금지) | `.ps1` 을 못 쓴다 |
| D-M15 | 로그인 | 창 없는 로그인(이미 있는 piped 방식) + `open` 으로 브라우저 | 새 콘솔 창(`start`) 자리 |
| D-M16 | 문서 MCP | ~~macOS 1차 판은 pdf 만~~ → **M6(2026-10-27): 다섯 개 모두 활성.** 엑셀·PPT·워드 = 무료 LibreOffice(따로 설치, 없으면 그 셋만 `pending`)를 화면 없이 띄워 같은 도구를 처리, 한글 = python-hwpx(한컴 없이 HWPX/HWP 5.0). 각 저장소 `mac/v1` 브랜치 | COM 이 없다 |
| D-M17 | 브라우저 조작 | Playwright MCP 브라우저 = 실행 래퍼가 **실행할 때마다** 고른다: Google Chrome → Microsoft Edge(`/Applications`·`~/Applications`, 뒤쪽은 `--executable-path`) → 둘 다 없으면 ⑦ 단계가 받아 둔 **Chrome for Testing**(잠금표 `playwright-chromium`: Playwright 공식 배포처 주소·SHA-256·191MB 고정, `_agent/shared/tools/playwright-browsers/chromium-<rev>/`, `PLAYWRIGHT_BROWSERS_PATH`). 받지 못하면 `pending` — Chrome 을 설치하면 래퍼를 다시 쓰지 않고 바로 켜진다. **2026-10-28 개정**: 처음엔 "내려받기 0 유지"였으나 사용자 결정("맥 사용자들이 바로 쓸 수 있게")으로 바꿨다. Chrome 이 있는 Mac 은 아무것도 받지 않는다. 판은 동봉 playwright-core 의 `browsers.json` 과 같아야 한다(정적 검사 ㉒) | Windows 는 Edge 내장 |
| D-M18 | 훅 | `block-blanket-kill` 을 파이썬 판으로(`pkill`·`killall`·`kill $(lsof …)` 차단). 나머지 두 훅은 이미 파이썬 | `.ps1` 훅 |
| D-M19 | 삭제기 | `IRIS-삭제.command` → `uninstall.mjs`(node). 영수증이 있는 폴더만 지우는 규칙은 같다 | `uninstall.ps1` 자리 |
| D-M20 | IRIS 창 | P02 포크에서 함께 고친다. 심은 두 저장소가 글자까지 같아야 한다(정적 검사 ⑥) | |

## 2. 설치 폴더 안의 모양

설치 폴더 안의 상대 경로(`_agent/shared/tools/<부품>`, `_agent/claude`, `_agent/codex`, `_agent/setup/…`)는 Windows 와 **같다**. 부품 안쪽만 다르다.

| 부품 | Windows | macOS |
|---|---|---|
| node | `tools/node/node.exe` | `tools/node/bin/node` |
| python | `tools/python/python.exe`, `Lib/site-packages` | `tools/python/bin/python3`, `lib/python3.12/site-packages` |
| 문서 MCP venv | `…/venvs/document-mcp/Scripts/python.exe` | `…/venvs/document-mcp/bin/python` |
| git | `tools/git/cmd/git.exe` | `tools/git/bin/git` — PATH 에 넣지 않고 늘 심으로(심이 `GIT_EXEC_PATH` 등 dugite 환경을 건다) |
| claude | `tools/claude/<판>/claude.exe` + `claude.cmd` | `tools/claude/<판>/claude` + `claude`(sh 전달자) |
| codex·teamclaude 등 npm 부품 | `npm i -g --prefix` → `<prefix>/codex.cmd`, `<prefix>/node_modules/…` | `npm i --prefix`(전역 아님) → `<prefix>/node_modules/…` 자리가 Windows 와 같다. codex 는 `node <prefix>/node_modules/@openai/codex/bin/codex.js` |
| 심 | `shims/*.cmd`(CRLF·ASCII) | `shims/*`(LF·ASCII·실행 권한) |

## 3. 준비 검사(macOS)

| 검사 | 기준 | 실패 시 |
|---|---|---|
| zip 을 풀었는가 | 임시 폴더(App Translocation 포함) 아님, `payload/manifest.json` 존재 | 막음 |
| 파일 무결성 | 전 부품 SHA-256 | 막음 |
| macOS 판 | 13.5 이상(`sw_vers`) | 막음 |
| CPU | arm64(`uname -m`, Rosetta 아래 x86_64 도 arm64 로 본다) | Intel 은 막음 |
| 홈 폴더 | 쓰기 가능, 여유 3GB(`fs.statfs`) | 값을 읽었는데 나쁘면 막음, 못 읽으면 경고 |
| 포트 3456·3457·3458·3460 | 비어 있거나 IRIS 것 | Windows 와 같음 |
| 브라우저 조작 | Chrome·Edge 존재 | 막지 않음, 없으면 ⑦ 이 Chrome for Testing 을 받는다(D-M17) — 받으면 인수 문서의 대기에서 빠진다 |
| Gatekeeper·관리자·기존 Node/Python/Git | — | 기록만 |

## 4. 단계

| 단계 | 내용 | 산출 |
|---|---|---|
| M1 | 운영체제 계층 · `IRIS-설치.command`·`bootstrap.sh` · 심 · 사용자 환경 · 준비 검사 | 설치 화면이 Mac 에서 뜬다 |
| M2 | 잠금표 `targets`·`platforms` · `build --target darwin-arm64` · Mac 바퀴집 · 비공개 부품은 공식 zip 에서 | Mac zip |
| M3 | Claude Code macOS 판 · 창 없는 로그인 · `teamclaude-manage.mjs` · LaunchAgent | 로그인·중계기 |
| M4 | IRIS 창(P02 포크) | 창이 열린다 |
| M5 | 앱 바로가기·폴더 아이콘·삭제기·Mac 시험 행렬 | 배포 후보 |
| M6 | 문서 MCP 대체 처리(각 저장소) | 문서 도구 — **끝(2026-10-27, 아래 5절)** |

## 5. 진행 상황 (2026-10-27)

| 단계 | 상태 | 근거 |
|---|---|---|
| M1 | 끝 | 겉옷(`IRIS-설치.command`→`bootstrap.sh`→`bootstrap.mjs`)·준비 검사·심·사용자 환경. 단위 시험 |
| M2 | 끝 | `node build/build.mjs --target darwin-arm64` → `IRIS-Setup-macOS-arm64_v<판>_<날짜>.zip`(약 460MB). 임시 폴더 연습 설치에서 세팅 9단계 전부 `done`, 검사 13개 중 통과 10·대기 3(브라우저·중계기 2) |
| M3 | 코드 끝, 실측 남음 | Claude Code `darwin-arm64` 받기·sh 전달자·창 없는 로그인(lsof)·중계기 시작(`teamclaude-manage.mjs`)·재개 사본. **진짜 구독 로그인은 아직 해 보지 않았다**(아래 미결 ①) |
| M4 | 코드 끝, 창 눈 확인 남음 | P02 `mac/v1`: 운영체제 차이를 `daemon/platform.mjs` 한 곳에(Windows 갈래는 이식 전 글자 그대로). 세션 = sh 심을 node-pty 로 직접·닫기 = 프로세스 그룹 · 화면 상대경로는 `\` 약속 그대로, 데몬 입구에서 바꿈 · macOS 심 사본(`posixAgentShimText`)은 정적 검사 ⑥·`tests/shims-parity` 가 바이트 비교 · 코덱스 신뢰 키 = 경로 그대로 · 「설치 이어하기」= `.command` 를 `/bin/sh` 로 · Electron.app·메뉴(편집·Cmd)·Dock. P02 `verify:*` 전부 macOS 통과, 가짜 심 데몬 시험 15/15, 연습 설치한 영혼의 창 데몬이 뜨고 `login-pending` 카드·`spawn-helper` 권한 자가 수리 확인. **Electron 창을 사람 눈으로 본 확인은 아직**(아래 미결 ⑦) |
| M5 | 거의 끝 | **삭제기**(`IRIS-삭제.command` → `installer/uninstall.mjs`, 설계-삭제기.md 7절, 시험 11개 + 연습 설치본에서 사본 실행 확인) · **비서 자동 업데이트 macOS 판**(설계-비서자동업데이트.md 끝 절, codex.js 전달자) · **`guard-iris-path.py` macOS 경로**(시험 52개) · **정적 검사 macOS 대응**(`verify/static.mjs` 가 zip 뿌리로 대상을 알아보고 ③⑤⑨⑱⑳㉑ 의 macOS 판을 본다 — macOS zip 에서 전부 통과) · **IRIS.app 아이콘**(iris.ico 의 PNG 판 → ICNS, 외부 도구 없음). **재현성**(`verify/reproduce.mjs --target darwin-arm64` — 두 번 빌드한 부품 59개·내용 지문 일치. 막힌 곳 두 개: bsdtar 가 지역 머리에 싣는 ctime·심볼릭 링크 mtime, `lib/zip.mjs` 가 macOS 에서 고정) · **무네트워크**(`verify/offline.mjs --build --target darwin-arm64 --out _build/out-mac` 와 `--out _build/out-mac` 설치 — 네트워크 0회로 세팅 완료, 연습 루트는 `_build/` 안). 남은 것: `verify/e2e`·`upgrade`(직전 macOS 판이 생긴 뒤)·`login-probe`(외부 코드 실행 — 허락 필요) |
| M6 | 끝(코드·실측) | 네 문서 MCP 저장소(`d01-p01`~`p04`)의 로컬 `mac/v1`: `server.py` 가 macOS 에서 엔진만 바꾼다(도구 이름·반환은 Windows 와 같음). **엑셀·PPT·워드** = `engine/lo_bridge.py` 가 soffice 를 화면 없이 띄우고 그 안에서 UNO 매크로(`engine/lo_macro/iris_uno.py`)를 돈다 — LibreOffice 26 의 내장 Python 은 실행 제약 때문에 soffice 만 띄울 수 있어 밖에서 부를 수 없다(실측: 커널이 "Launch Constraint Violation" 으로 죽임). 화면 없는 LibreOffice 는 fontconfig 로 글꼴을 찾아 macOS 시스템 글꼴(한글)을 못 보므로 다리가 fonts.conf 를 만들어 넘긴다(없으면 한글이 □). 두 파일은 네 저장소에 바이트까지 같은 사본. **한글** = python-hwpx(Apache-2.0): HWP 5.0→HWPX, 추출, `{{이름}}`→그 자리 누름틀(실제 한컴 CLICK_HERE 모양), `[[이름]]`→셀 필드, 채우기·검증, 정규화 저장 — 결과는 OWPML 스키마 검사 통과. HWPX→PDF 만 근사본(HTML→LibreOffice, `approximate: true` + "제출용은 Windows 한컴" 안내). 시험: 엑셀 9 · PPT 8 · 워드 16 · 한글 17 개, 연습 설치본에서 다섯 MCP 를 클로드처럼 stdio 로 띄워 실제 호출 7개 통과. 설치기: 맥 잠금표가 네 MCP 를 새 커밋으로 고정(저장소 주소는 원 저장소 — PR 이 **합쳐진 뒤 같은 커밋이 원 저장소에 있어야** 빌드된다, 스쿼시 병합이면 다시 고정), 휠 묶음 34개(+python-hwpx·lxml), LibreOffice 가 없으면 엑셀·PPT·워드만 대기, LibreOffice 프로필은 `_agent/shared/portable-state/libreoffice/<도구>`. 개발 빌드는 `IRIS_<부품>_REPO=<로컬 클론>` 으로 고정 커밋을 받는다 |

연습 설치는 홈 폴더를 건드리지 않는다: `IRIS_INSTALLER_SOUL_ROOT`(설치 폴더)·`IRIS_INSTALLER_WORK_DIR`(작업 폴더)·`IRIS_INSTALLER_NO_USER_ENV=1`·`IRIS_INSTALLER_NO_BROWSER=1`·`IRIS_INSTALLER_OFFLINE=1`.
원작자 PC 에만 있는 부품(대시보드·온톨로지·HWPX 양식·명세·아이콘)은 `node build/seed-from-release.mjs` 가 공식 zip 에서 꺼내 `IRIS_<부품>_SOURCE` 로 가리킨다.

## 6. 미결

1. **Claude Code 로그인과 키체인.** macOS 의 Claude Code 는 토큰을 `.credentials.json` 이 아니라 키체인에 둔다. 설치기는 로그인 완료를 `.claude.json` 의 `oauthAccount`(토큰 아님)로 알아보고, 중계기 연결은 파일이 있을 때만 `import --from` 하며 없으면 중계기 자신의 브라우저 로그인(원래 설계의 대체 경로)으로 간다 — 키체인 기본 항목을 읽으면 그 Mac 에 원래 있던 **다른** 계정을 가져올 수 있어서다. 실제 계정으로 한 번 확인해야 한다(브라우저 로그인이 두 번 뜨는지).
2. **D-M08 전역 변수**(원작자 확인).
3. ~~비서 자동 업데이트 macOS 판~~ — M5 에서 옮겼다(설계-비서자동업데이트.md 끝 절). 실제 내려받기·npm 설치는 가짜로만 시험했다 — 진짜 네트워크로 한 번 돌려 볼 일.
4. ~~`guard-iris-path.py` macOS 경로~~ — M5 에서 옮겼다(`~/IRIS`·`$HOME/IRIS` 표기 포함).
5. **서명·공증**(D-M05) — Gatekeeper 안내문으로 시작. Developer ID 는 별도 결정.
6. **Windows 회귀 확인** — Windows 판 시험은 Mac 에서도 Windows 판으로 고정해 돌지만, PR 전에 원작자 PC 에서 `npm test`·`npm run verify` 를 한 번 돌려야 한다.
7. **IRIS 창 눈 확인(M4).** Electron 의 `capturePage` 로 창 내용을 그림으로 떠서 확인했다(머리줄·별 무대·폴더/에이전트/모델 선택·입력창·한글 정상). 그 과정에서 메모리 고리가 macOS 에서 늘 99%(빨강)로 보이던 것을 찾아 고쳤다(P02 `vm_stat`). 메뉴 막대·트레이·Dock 아이콘·Cmd 단축키는 그림으로 뜰 수 없어 사람 눈 확인이 남았다.
8. ~~문서 미리보기(macOS)~~ — LibreOffice 26.8 을 깔고 확인했다: 오피스는 LibreOffice, 한/글은 python-hwpx → HTML → LibreOffice 근사본, 둘 다 한글 글꼴이 박힌다(화면 없는 LibreOffice 에 fonts.conf 를 넘겨야 한다는 것을 이때 찾았다).
9. **메모리 계기판(macOS)** — RAM 은 `vm_stat` 기준으로 고쳤다(위 7). 커밋 고리는 macOS 에서 꺼진 채(스왑 기준 판은 나중에).
10. **로그인 검사 ②(실제 Claude Code 받기 + 창 없는 로그인)** 는 macOS 판으로 옮겼지만(`verify/login-probe.mjs`) 돌리지 않았다 — macOS 의 Claude Code 는 키체인을 쓰므로 같은 Mac 의 실제 계정 항목에 닿을 수 있다. 미결 ① 과 함께 사람이 지켜보며 돌린다(`--no-online` 인 ③ 은 통과).
11. **사용자 수준 캐시**: 설치의 venv 단계는 uv 공용 캐시(`~/.cache/uv`)를 쓴다 — Windows 의 `%LOCALAPPDATA%\uv` 와 같은 취급(지우지 않음).
