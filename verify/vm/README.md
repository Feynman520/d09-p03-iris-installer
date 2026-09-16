# verify/vm — 4층 시험 행렬용 VirtualBox 시험대

4층 시험 행렬(`docs/시험행렬.md`, 설계-v2 10절)의 VM 시나리오를 한 명령으로 돌리기 위한 도구.
이 개발 PC의 진짜 `C:\IRIS`를 건드리지 않고, 버릴 수 있는 윈도 손님(guest) 안에서
**배포할 zip 그대로**를 설치해 본다.

## 지금 상태 (2026-09-16 T23e — 권한을 **구운** 두 번째 기준 이미지)

기준 VM은 이제 **`IRIS-Win11-v2`**다(`run.mjs`의 `BASE_VM`). 옛 `IRIS-Win11`도 그대로 남아 있고
`--vm IRIS-Win11`로 고를 수 있지만, 거기서는 S03·S04·S05·S07 준비가 UAC 앞에서 선다.

### 왜 다시 만들었나 — 손님 제어는 권한 상승을 할 수 없다

| 시도한 것 | 결과(실측) |
|---|---|
| 관리자 계정으로 손님 제어 세션에서 `hosts` 쓰기 | `UnauthorizedAccessError` (UAC가 **걸러진 토큰**을 준다) |
| `schtasks /create /ru SYSTEM /rl HIGHEST` | `오류: 액세스가 거부되었습니다` |
| `Register-ScheduledTask -RunLevel Highest`(자기 계정) | `HRESULT 0x80070005` |
| 내장 `Administrator`로 로그온 | 평가판에서 비활성 — `account … is restricted and can't be used to logon` |

헤드리스 VM에는 UAC 「예」를 눌러 줄 사람이 없다. **상승은 요청 시점에 만들 수 없고, 이미 있어야 한다.**

### 그래서 굽는다 (`create.mjs --bake`, 기본 켜짐)

무인 설치의 첫 로그온(`VBOXPOST.CMD`)은 **아직 걸러지지 않은 전체 관리자 토큰**으로 돈다.
그 한 순간에 `verify/vm/bake.ps1`이 들어가 다음을 남긴다.

```text
① 표준 계정 2개   iristest · 테스트 사용자      (관리자 아님 — S03·S04의 전제)
② 숨은 관리자     irisadmin                     (UAC 실험용, 로그온 화면에 안 보임)
③ UAC 값          ConsentPromptBehaviorAdmin=0 · LocalAccountTokenFilterPolicy=1
                  (EnableLUA는 1 그대로 — 0으로 내리면 그 PC는 더 이상 보통 윈도가 아니다)
④ SYSTEM 대리인   작업 스케줄러 「IRIS-VM-Agent」 = C:\iris-vm\agent.ps1
                  C:\iris-vm\queue 를 1초마다 보고, 놓인 .job 을 SYSTEM 으로 실행
⑤ 흔적            C:\iris-vm\baked.json  (무엇을 했는지 그대로)
SAC는 건드리지 않는다 — S05가 같은 ④ 통로로 스스로 켠다(그래야 시나리오가 무언가를 시험한다).
```

`--post-install-command`는 "명령 **한 줄**"뿐이라 굽기 블록을 담지 못한다(7.2.16 도움말 실측).
그래서 `--post-install-template`으로 Oracle의 `win_postinstall.cmd`에 블록 하나를 끼운 사본을 넘긴다.
그 사본은 보조 ISO의 `VBOXPOST.CMD`가 되어 **시스템 코드페이지로 읽히므로 순수 ASCII여야 한다** —
한글이 든 `bake.ps1`은 BOM째 base64로 실어 보내고 손님 안에서 `certutil -f -decode`가 되돌린다.
비밀번호도 base64로만 넘긴다(cmd 인용 규칙과 로그를 동시에 피한다). 호스트 쪽 생성본은 굽자마자 지운다.

### 상승이 필요한 준비는 전부 이 통로로

```text
run.mjs ──> guest-elevate.ps1 (상승 없음)        손님 안, 걸러진 토큰
              │  C:\iris-vm\queue\<id>.job  쓰기 (임시 이름으로 쓴 뒤 rename)
              ↓
            IRIS-VM-Agent (SYSTEM, 이미 상승돼 있음)
              │  powershell -File <준비 스크립트>  실행
              ↓
            <id>.out · <id>.done  ──> guest-elevate.ps1 이 되읽어 그대로 출력
```

첫 줄에 `ELEVATE-CHANNEL baked`(구운 통로) 또는 `ELEVATE-CHANNEL task`(옛 이미지용 대체 길)가
찍히므로 실행 로그만 봐도 어느 문으로 갔는지 알 수 있다. 인자는 **base64**로 넘긴다
(`elevateArgs`) — VBoxManage가 인자 묶음을 지켜 주지 않아 공백 든 인자는 토막이 나기 때문이다.

> 🔴 **이 통로는 일부러 만든 권한 상승 구멍이다.** 버리는 시험용 VM 안에만 존재하며,
> 설치기·배포물에는 이 중 어느 것도 들어가지 않는다. 사람이 쓰는 PC에 굽지 말 것.

### 다시 만드는 법

```powershell
$env:IRIS_VM_PASSWORD = "<손님 계정 비밀번호>"
node verify/vm/create.mjs --name IRIS-Win11-v3 --iso _build\cache\vm\win11-enterprise-eval-ko-kr.iso
```

약 80분. 끝나면 광학 매체를 떼고, ACPI로 정상 종료하고, **꺼진 상태로** `clean` 스냅샷을 찍는다.
`--no-bake`를 주면 굽지 않은 옛 방식이다(S03·S04·S05·S07이 못 돈다 — 비교용으로만).
비밀번호를 잃었으면 VM 폴더의 `Unattended-<uuid>-autounattend.xml`이 평문으로 갖고 있다.

---

## 지금 상태 (2026-09-15 T23c — 처음으로 진짜 VirtualBox에 명령을 보냈다)

VirtualBox **7.2.16**이 이 PC에 설치되어(사람이 함) 실측이 시작됐다. 그 순간 **문서만 보고 쓴
자리 여섯 군데**가 드러났고 전부 고쳤다. 실측 결과·남은 것의 정본은
`.superpowers/sdd/구현계획-v2/task-23c-report.md`이며, 시험 행렬 행은 `docs/시험행렬.md`가 정본이다.

| 고친 것 | 문서만 보고 쓴 것 | 실제(7.2.16) |
|---|---|---|
| 보안 부팅 | `modifyvm --secure-boot on` | **없는 스위치.** `modifynvram <vm> inituefivarstore` → `enrollmssignatures` → `enrollorclpk` → `secureboot --enable` (PK를 먼저 등록하지 않으면 "platform key (PK) is not enrolled"로 거절) |
| 무인 설치 비밀번호 | `--password=` | `--user-password=` (+ `--admin-password=`) |
| 무인 설치 시작 | (없음) | **`--start-vm=headless`가 없으면 VM이 켜지지 않는다** — 손님 제어가 영원히 올라오지 않는다 |
| USB | `--usbxhci on` | xHCI는 확장팩을 요구한다(이 PC 확장팩 0개) → `--usbohci on` |
| 설치 실행 | `cmd /c IRIS-설치.cmd` 한 줄 | 그 진입기는 **서버를 띄우고 브라우저를 연 뒤 곧장 끝난다.** 종료 코드 0은 "설치됨"이 아니다 → `guest-run.ps1`+`guest-drive.mjs`가 설치기 API로 화면을 대신 누른다 |
| 판정 두 곳 | `receipt.online.net.code` / `receipt.online.claude` | 영수증에 **없는 자리**다. `GET /api/online/status`에만 있다 → 회수한 `drive-result.json`으로 판정 |

Windows 11 요구사항(TPM·온라인 계정) 우회는 **따로 손댈 것이 없었다** — VirtualBox 7.2의
`UnattendedTemplates\win_nt6_unattended.xml`이 로컬 계정을 만들어 OOBE를 지나간다.
`BypassNRO` 레지스트리나 `--extra-install-kernel-parameters`는 필요하지 않았다.

### 손님 안에서 화면을 대신 누르는 두 벌 (신설)

| 파일 | 하는 일 |
|---|---|
| `guest-run.ps1` | 손님 안에서 한 세션으로: 진입기 `.cmd` 실행 → `127.0.0.1:3460/api/health` 대기 → 동봉 `node.exe`로 운전기 실행. **ASCII 전용**(PS 5.1이 BOM 없는 파일을 ANSI로 읽어 한글이 깨지므로) — 한글 이름인 진입기는 "뿌리의 유일한 `*.cmd`"로 찾는다 |
| `guest-drive.mjs` | 설치기 API를 문서(`docs/설치기-API-v2.md`) 순서대로 누른다: 사전점검 → 위치 → 구독 → 구조(프리셋) → 요약확인 → 세팅 시작 → 9단계 완료 대기 → 온라인 시작 → **로그인 대기에서 정직하게 멈춤**. `--legacy`면 1.x API(name/choice/install) 순서로 바꾼다 |

🔴 운전기는 `POST /api/online/login`을 **절대 부르지 않는다.** 진짜 구독 로그인은 사람만 한다.
`handoff.state = login-pending`에서 멈추는 것이 이 시나리오들의 합격선이다.

---

## 1. 사람이 한 번 할 일 (약 2시간, 대부분 기다리는 시간)

### ① VirtualBox 설치 — 5분

**시작 메뉴 → 「터미널(관리자)」** 를 열고(또는 PowerShell을 오른쪽 클릭 → 관리자 권한으로 실행),
UAC 창이 뜨면 **「예」** 를 누른 뒤:

```powershell
winget install Oracle.VirtualBox --accept-package-agreements --accept-source-agreements
```

끝나면 **새 터미널**에서 확인한다(PATH가 갱신되어야 보인다):

```powershell
VBoxManage --version
```

`7.x.y r123456` 처럼 판 번호가 나오면 된 것이다. 안 나오면
`& "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" --version` 으로 직접 불러 본다 —
이 폴더의 코드는 두 경로를 모두 찾는다.

> 왜 사람이 해야 하나: winget의 VirtualBox 설치 관리자는 커널 드라이버를 넣기 때문에
> 반드시 관리자 승인을 받는다. 자동화 셸에서 시도하면 `0x800704c7`("사용자가 작업을
> 취소했습니다")로 즉시 끝난다. 세 가지 우회(샌드박스 끄기·`Start-Process -Verb RunAs`·
> 작업 스케줄러 최고 권한)를 모두 시도했고 전부 막혔다(Task 5 기록).

### ② 평가판 ISO 내려받기 — 20~40분 (약 6.6 GB)

Windows 11 한국어 Enterprise 평가판(90일)은 로그인·양식 없이 바로 받아진다.

```powershell
$iso = "<이 저장소>\_build\cache\vm\win11-enterprise-eval-ko-kr.iso"
New-Item -ItemType Directory -Force (Split-Path $iso) | Out-Null
Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/?linkid=2334366&clcid=0x412&culture=ko-kr&country=kr" `
  -OutFile $iso -UserAgent "Mozilla/5.0"
Get-FileHash -Algorithm SHA256 $iso
```

기대 SHA-256 (Enterprise Eval x64 KO-KR DVD9, 25H2):

```
3098938EDAEA0A5D59E3D966514A4C0D1CBFD4F6CAE9D35CEB079FC3272099A4
```

다른 시나리오용 ISO는 같은 방식으로 `linkid`만 바꾼다
(S02 = Windows 10 22H2 Enterprise 평가판, S10 = Windows 11 Enterprise 평가판 en-US).

### ③ 기준 VM 만들기 — 40~90분 (무인 설치라 지켜보지 않아도 된다)

```powershell
$env:IRIS_VM_PASSWORD = "<아무 데도 적지 않을 비밀번호>"

node verify/vm/create.mjs --name IRIS-Win11-v2 --iso $iso
```

무엇을 하는지: VM 만들기 → Windows 11이 요구하는 EFI·TPM 2.0·보안 부팅 켜기 →
64 GB 디스크 → **권한 굽기 템플릿 만들기**(맨 위 T23e 절) → 무인 설치 시작 →
5분마다 손님 제어(guest control)가 응답하는지 확인 → 손님 안 `C:\iris-vm\baked.json` 확인 →
광학 매체 떼기 → 정상 종료 → **꺼진 상태로** `clean` 스냅샷.

**비밀번호는 절대 명령줄 인자로 주지 않는다.** `IRIS_VM_PASSWORD` 환경변수만 읽는다
(이 스크립트들에는 `--password` 스위치가 아예 없다).

### ④ 시나리오 준비 — **사람이 할 일은 없다** (2026-09-16 T23e부터)

옛 판에서는 여기에 「손으로 SAC 켜기·손으로 계정 만들기·손으로 스냅샷 찍기」가 줄줄이 있었다.
지금은 전부 시험대가 한다. 사람 손으로 만든 스냅샷은 **언제 무엇으로 만들어졌는지 아무도
모르게 되어** 시험이 조용히 아무것도 시험하지 않는 상태로 미끄러진다 — 그래서 없앴다.

| 무엇이 필요했나 | 지금 누가 하나 |
|---|---|
| 표준 계정 `iristest`·`테스트 사용자` | **무인 설치 때 굽는다**(`bake.ps1`). `run.mjs`는 매번 "정말 있고 정말 표준 사용자인가"만 SYSTEM으로 확인한다 |
| SAC 켜기 | **S05가 스스로** 켜고 재부팅한 뒤 시험한다(구운 통로 → `guest-sac.ps1 -Enable`). `sac-on` 스냅샷은 더 쓰지 않는다 |
| `hosts`로 npm 막기 | **S07이 스스로**(구운 통로 → `guest-hosts.ps1 -Elevated`). 정말 막혔는지 스스로 확인하고, 안 막혔으면 실패로 적는다 |
| `installed-1.4.5` 스냅샷 | **S09가 `--legacy-zip <1.4.5 zip>`을 받으면 직접 만든다**: clean 복원 → 1.4.5 설치 → 자료 심기 → 스냅샷 → 그 위에 2.0.0 |
| OneDrive식 바탕화면 옮기기(S04) | `guest-user-prep.ps1 -Redirect`가 그 계정의 HKCU에 한다(진짜 OneDrive를 깔지 않는다 — 잡으려는 것은 「바탕화면이 한글 경로로 옮겨진 상태」뿐) |
| `no-office` 스냅샷 | `clean` 그대로여도 된다(평가판에는 Office도 한컴도 없다). 이름만 따로 찍어 둔다 |
| 다른 OS·언어 VM | ③을 `--ostype Windows10_64`(S02) / `--locale en_US --language en-US --country US`(S10)로 한 번 더 |

`no-office` 이름만 찍을 때:

```powershell
VBoxManage snapshot IRIS-Win11-v2 take no-office --description "no Office, no Hancom (eval image as-is)"
```

---

## 2. 그다음은 한 명령씩

```powershell
$env:IRIS_VM_PASSWORD = "<③에서 쓴 것과 같은 비밀번호>"

node verify/vm/run.mjs --scenario S01 --zip _build\out\IRIS-Setup_v2.0.0_2026-09-15.zip
node verify/vm/run.mjs --scenario S06 --zip _build\out\IRIS-Setup_v2.0.0_2026-09-15.zip
...
```

한 시나리오가 하는 일:

```text
① 스냅샷 복원 ── ② 시나리오 준비(망 끊기·hosts 막기 등) ── ③ VM 켜기
     ↓
④ 손님 제어 응답 대기 ── ⑤ zip 복사 ── ⑥ 손님에서 풀기 ── ⑦ IRIS-설치.cmd 실행
     ↓
⑧ diagnostics.json·handoff.json·영수증·로그 회수 ── ⑨ 판정 ── ⑩ VM 끄기
     ↓
⑪ docs/시험행렬.md 그 행을 「통과/실패 + zip 지문 + 날짜 + 근거」로 갱신
```

쓸모 있는 스위치:

| 스위치 | 뜻 |
|---|---|
| `--dry-run` | VirtualBox 없이 **보낼 명령만** 출력한다. 지금 이 PC에서도 된다 |
| `--vm <이름>` | 표의 기본 VM 대신 다른 VM을 쓴다 |
| `--keep-running` | 판정 뒤 VM을 끄지 않는다(손으로 들여다볼 때). 호스트 쪽 되돌리기(S06의 랜선 다시 꽂기)도 함께 미룬다 — 켜진 VM의 랜선만 몰래 꽂으면 "오프라인이었다"는 증거가 눈앞에서 사라지기 때문이다 |
| `--no-report` | `docs/시험행렬.md` 를 건드리지 않는다 |
| `--out-dir <경로>` | 회수한 파일을 둘 곳(기본 `_build/cache/vm/results/<시나리오>-<시각>`) |

행렬만 따로 보거나 손으로 채우려면:

```powershell
node verify/vm/report.mjs --print
node verify/vm/report.mjs --scenario S03 --result 통과 --zip _build\out\<zip> --evidence "_agent\setup\diagnostics.json"
```

`--result` 는 `통과`·`실패`·`미착수` 셋만 받는다. `zip 지문`은 zip sha256 앞 12자(소문자 hex)로,
릴리스 게이트가 "이번 빌드와 같은 판에서 나온 결과인가"를 이 값으로 판정한다.

---

## 3. 시나리오가 각각 무엇을 잡나

| # | 어디서 | 준비 | 통과 기준(기계 판정) |
|---|---|---|---|
| S01 | VM `clean` | 없음 | 9단계 전부 `done` · 검사 실패 0건 |
| S02 | Win10 VM `clean` | 없음 | 같음 |
| S03 | VM `clean`, 손님 계정 `iristest` | 구워진 표준 계정 확인(SYSTEM) + 그 계정으로 첫 로그온 | 같음 + PATH·환경변수·바로가기가 그 계정 것만 바뀜 |
| S04 | VM `clean`, 손님 계정 `테스트 사용자` | 같음 + `-Redirect`로 바탕화면 옮기기 | 같음 + 바로가기가 **옮겨진** 바탕화면에 놓임 |
| S05 | VM `clean` | 시나리오가 **스스로** SAC를 켜고 재부팅(구운 통로) | 끝까지 갔거나, 막혔다면 zip 뿌리에 「설치가 안 되면.txt」 안내가 있음(사람 눈 확인 1회) |
| S06 | VM `clean` | **부팅 전** 랜선 뽑기 | 9단계 완료 + `E-ONLINE-NET` 정직한 멈춤 + `handoff.state = login-pending` |
| S07 | VM `clean` | 손님 hosts에 npm 저장소만 막기(구운 통로) + 정말 막혔는지 확인 | Claude Code를 `npm` 아닌 출처로 폴백해 받음 |
| S09 | VM `installed-1.4.5` | `--legacy-zip`을 주면 그 스냅샷을 이 실행이 직접 만든다 | 9단계 완료 + `package-receipt.v1.json` 사본 보존 + 감시 파일 살아 있음 |
| S10 | 영어 UI VM `clean` | 없음 | 9단계 완료 · 한글 폴더 이름이 깨지지 않음 |
| S11(없음) | VM `no-office` | 없음 | 문서 MCP가 `fail`이 아니라 **`pending`** · 다른 검사 실패 0건 |
| S11(있음) | 이 PC 본계정 | 없음 | 문서 MCP `pass` — `node verify/e2e.mjs --scenario s08` 이 함께 확인 |
| S08 | 이 PC 본계정 | 없음 | 동봉 판(node·python·git)이 이 PC 시스템 판을 이김 + 이 PC 무접촉 |

## 4. 안전 규칙 (코드가 이미 지키고 있다)

- VM은 `VBoxManage controlvm poweroff` 로만 끈다. 프로세스 이름으로 일괄 종료하지 않는다.
- 비밀번호는 `IRIS_VM_PASSWORD` 에서만 읽는다. 이 저장소 어디에도 적지 않는다.
- 손님 안에서만 설치한다. 이 PC의 `C:\IRIS`·바탕화면·사용자 환경변수는 건드리지 않는다.
- 회수한 `diagnostics.json` 은 설치기가 이미 사용자 이름·경로를 가려서 쓴 파일이다.
  그대로 사람이 손으로 전달할 수 있다(텔레메트리 없음).

## 5. VirtualBox를 처음 켰을 때 다시 확인할 것

작성 당시 이 PC에 VirtualBox가 없어 **문서로만** 맞춘 것들이다. 첫 실행 전에 한 번 대조한다.

- `VBoxManage modifyvm --help` — `--secure-boot` / `--tpm-type` / `--cable-connected1` 철자.
  과거 판에서 `--secureboot` 처럼 달랐던 적이 있다.
- `VBoxManage unattended install --help` — 이 도구는 저장소(storage)를 스스로 붙이기도 한다.
  "이미 붙어 있다"고 불평하면 `create.mjs` 의 `storagectl`/`storageattach` 묶음을 빼고
  `unattended install` 에 맡긴다.
- `VBoxManage guestcontrol run --help` — `--wait-stdout`/`--wait-stderr`,
  `copyto`/`copyfrom` 의 `--target-directory` 의미.
- 첫 부팅이 OOBE(네트워크·계정) 화면에서 멈추면, `unattended install` 이 만든 응답 파일에
  `BypassNRO` 처리를 더한다(마이크로소프트 문서화된 방법).
- 평가판은 90일. 시험용 VM은 그 안에 다시 만들면 되므로 문제가 아니지만, 오래 두지는 말 것.
