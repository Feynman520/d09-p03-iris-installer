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
| D-M16 | 문서 MCP | macOS 1차 판은 **pdf 만 활성**, word·excel·ppt·hwp 는 `pending`. 대체 처리(LibreOffice → Office for Mac AppleScript, HWPX 파이썬)는 M6 에서 각 저장소에 | COM 이 없다 |
| D-M17 | 브라우저 조작 | Playwright MCP 채널 = Google Chrome → 없으면 Microsoft Edge → 둘 다 없으면 `pending`(내려받기 0 유지) | Windows 는 Edge 내장 |
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
| 브라우저 조작 | Chrome·Edge 존재 | 막지 않음, 없으면 `pending` |
| Gatekeeper·관리자·기존 Node/Python/Git | — | 기록만 |

## 4. 단계

| 단계 | 내용 | 산출 |
|---|---|---|
| M1 | 운영체제 계층 · `IRIS-설치.command`·`bootstrap.sh` · 심 · 사용자 환경 · 준비 검사 | 설치 화면이 Mac 에서 뜬다 |
| M2 | 잠금표 `targets`·`platforms` · `build --target darwin-arm64` · Mac 바퀴집 · 비공개 부품은 공식 zip 에서 | Mac zip |
| M3 | Claude Code macOS 판 · 창 없는 로그인 · `teamclaude-manage.mjs` · LaunchAgent | 로그인·중계기 |
| M4 | IRIS 창(P02 포크) | 창이 열린다 |
| M5 | 앱 바로가기·폴더 아이콘·삭제기·Mac 시험 행렬 | 배포 후보 |
| M6 | 문서 MCP 대체 처리(각 저장소) | 문서 도구 |

## 5. 진행 상황 (2026-10-27)

| 단계 | 상태 | 근거 |
|---|---|---|
| M1 | 끝 | 겉옷(`IRIS-설치.command`→`bootstrap.sh`→`bootstrap.mjs`)·준비 검사·심·사용자 환경. 단위 시험 |
| M2 | 끝 | `node build/build.mjs --target darwin-arm64` → `IRIS-Setup-macOS-arm64_v<판>_<날짜>.zip`(약 460MB). 임시 폴더 연습 설치에서 세팅 9단계 전부 `done`, 검사 13개 중 통과 10·대기 3(브라우저·중계기 2) |
| M3 | 코드 끝, 실측 남음 | Claude Code `darwin-arm64` 받기·sh 전달자·창 없는 로그인(lsof)·중계기 시작(`teamclaude-manage.mjs`)·재개 사본. **진짜 구독 로그인은 아직 해 보지 않았다**(아래 미결 ①) |
| M4 | 시작 전 | IRIS 창(P02 포크) |
| M5 | 시작 전 | 삭제기·비서 자동 업데이트(macOS 판)·`guard-iris-path.py` macOS 경로·검사소(`verify/*`) macOS 대응 |

연습 설치는 홈 폴더를 건드리지 않는다: `IRIS_INSTALLER_SOUL_ROOT`(설치 폴더)·`IRIS_INSTALLER_WORK_DIR`(작업 폴더)·`IRIS_INSTALLER_NO_USER_ENV=1`·`IRIS_INSTALLER_NO_BROWSER=1`·`IRIS_INSTALLER_OFFLINE=1`.
원작자 PC 에만 있는 부품(대시보드·온톨로지·HWPX 양식·명세·아이콘)은 `node build/seed-from-release.mjs` 가 공식 zip 에서 꺼내 `IRIS_<부품>_SOURCE` 로 가리킨다.

## 6. 미결

1. **Claude Code 로그인과 키체인.** macOS 의 Claude Code 는 토큰을 `.credentials.json` 이 아니라 키체인에 둔다. 설치기는 로그인 완료를 `.claude.json` 의 `oauthAccount`(토큰 아님)로 알아보고, 중계기 연결은 파일이 있을 때만 `import --from` 하며 없으면 중계기 자신의 브라우저 로그인(원래 설계의 대체 경로)으로 간다 — 키체인 기본 항목을 읽으면 그 Mac 에 원래 있던 **다른** 계정을 가져올 수 있어서다. 실제 계정으로 한 번 확인해야 한다(브라우저 로그인이 두 번 뜨는지).
2. **D-M08 전역 변수**(원작자 확인).
3. **비서 자동 업데이트**(`updater/agents.mjs`)는 macOS 에서 아무것도 하지 않고 끝나게 막아 두었다 — Windows 경로(claude.exe·codex.cmd)를 macOS 설치에 돌리지 않기 위해. macOS 판은 M5.
4. **`guard-iris-path.py`** 는 드라이브 문자 경로만 알아본다 — macOS 경로에서는 아무것도 막지 않는다(해는 없지만 보호도 없다). M5.
5. **서명·공증**(D-M05) — Gatekeeper 안내문으로 시작. Developer ID 는 별도 결정.
6. **Windows 회귀 확인** — Windows 판 시험은 Mac 에서도 Windows 판으로 고정해 돌지만, PR 전에 원작자 PC 에서 `npm test`·`npm run verify` 를 한 번 돌려야 한다.
