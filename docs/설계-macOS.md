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
| git | `tools/git/cmd/git.exe` | `tools/git/bin/git` |
| claude | `tools/claude/<판>/claude.exe` + `claude.cmd` | `tools/claude/<판>/claude` + `claude`(sh 전달자) |
| codex·teamclaude (npm -g --prefix) | `<prefix>/codex.cmd`, `<prefix>/node_modules/…` | `<prefix>/bin/codex`, `<prefix>/lib/node_modules/…` |
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
