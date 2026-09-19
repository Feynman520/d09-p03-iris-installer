# 설치기 화면 ↔ 서버 API v2 (T11 서버 · T12 화면 공용 계약)

서버 `installer/server.mjs`(127.0.0.1:3460)와 화면 `installer/ui/index.html`이 함께 따르는 계약. 한쪽만 바꾸지 않는다. 모든 응답은 JSON, 실패는 `{ ok:false, code, message }`(message는 사용자에게 보일 한국어 한 문장).

## 단계(step) 이름
`precheck → locate → choice → structure → summary → setup → online → done` (+ 업데이트 모드 `auto`, 1.x 영수증 거부 `reinstall-required`).

## 조회
- `GET /api/state` → `{ ok, name:"iris-installer", version, step, packageVersion, precheck, soul:{ root, mode }, choice, decisions, setup, online, report }`
  - `soul.mode`: `"empty"`(없거나 빈 폴더) · `"iris"`(v2 영수증 있는 IRIS) · `"iris-legacy"`(1.x 영수증 — 자료 보존 이어 설치) · `"foreign"`(IRIS가 아닌 자료 — 막음)
  - `precheck`: T10 결과 형태 `{ blockers:[{id,message}], warnings:[{id,message}], info:{}, recorded:{} }`
  - `choice`: `{ subscriptions:["claude"|"chatgpt"…], leadAgent }`
  - `decisions`: `POST /api/structure`가 저장한 것(아래)
  - `setup`: `{ stage, stages:[{ id, status:"pending"|"running"|"done"|"skipped"|"failed", code, detail }], percent, current, error }` — 9단계 id = `unpack, env, skeleton, structure, venv, adapters, relay, ontology, checks`; `unpack`은 `sub:{ part, done, total }` 하위 진행 포함
  - `online`: `{ stage, net:{ ok, blocked:[host…] }, claude:{ state:"skipped"|"pending"|"downloading"|"done"|"failed", source:"claude.ai"|"npm", code }, documentSkills:{ state:"skipped"|"downloading"|"done"|"pending", code }, logins:{ claude:{ state, cli, relay, reason }, chatgpt:{…} }, relay:{ state, accounts } }` — `logins.*.state`: `not-needed`|`waiting`|`cli-done`|`done`|`failed`; `reason`: `window-closed`|`page-blocked`|`import-failed`; `stage` 는 `net → claude → document-skills → login → relay`
  - `documentSkills`: 허가서상 꾸러미에 못 싣는 클로드 플러그인 하나(설계-v2 13절). Claude 구독을 고른 설치에서만 `claude` 다음에 받고, 못 받아도 설치는 멈추지 않는다(`pending` + 완료 보고의 「남은 일」).
  - `report`: `{ markdownPath, handoffPath, pendingCapabilities:[…] }` (done 단계에서만)

## 단계 진행
- `POST /api/precheck` → `{ ok, result:<precheck 형태>, canProceed }` (blockers 0이면 canProceed)
- `POST /api/locate` → `{ ok, root, mode, message }` (`mode:"foreign"`이면 ok:false, message = "이 폴더에 IRIS가 아닌 자료가 있습니다…")
- `POST /api/choice` 본문 `{ subscriptions:[…] }` → `{ ok, leadAgent }` (빈 배열 → ok:false)
- `POST /api/structure` 본문 `{ nodes:[{ id, parentId, level:"R"|"D"|"P", nameKo, nameEn|null, order }], later:boolean }` → 성공 `{ ok, decisions }` / 실패 `{ ok:false, errors:[{ nodeId, code, message }] }`
  - 서버 검증: R ≥1(later면 `R01-나(Me)` 자동), 부모 없는 자식 금지, 같은 부모 아래 nameKo 중복 금지, 윈도 금지 문자 `<>:"/\|?*`·끝 점/공백 금지, 자리표시자 이름(기타·임시·테스트·test·temp·misc) 금지, nameEn은 비울 수 있음(영문·숫자·공백·하이픈만), 번호는 서버가 같은 부모 아래 order 순으로 `01`부터 부여
  - 저장 `decisions.json`: `{ schema:1, createdAt, later, nodes:[{ …입력, code:"R01", folderName:"R01-교사(Teacher)" }], deferred:["S","T","tags", …], nameEnMissing:[folderName…] }`
- `GET /api/presets` → `installer/ui/presets.json` 내용(화면이 직접 fetch 해도 됨)
- `POST /api/summary/confirm` → `{ ok }` (choice·decisions 둘 다 있어야 함) → step=setup
- `POST /api/setup/start` → 202 `{ ok, running:true }` · `GET /api/setup/progress` → `setup` 객체 · `POST /api/setup/retry` → 실패 단계부터 재시작
- `POST /api/online/start` → 인터넷 확인·(Claude 선택 시) Claude Code + document-skills 내려받기 시작 · `GET /api/online/status` → `online` 객체 · `POST /api/online/login` 본문 `{ provider }` → 로그인 창 띄움 · `POST /api/online/login/retry` 본문 `{ provider }` · `POST /api/online/relay` → 중계기 시작·확인
- `GET /api/report` → `{ ok, markdown, handoff, pendingCapabilities }` · `POST /api/open-face` → Face 실행 `{ ok }`
- **순서 가드**: 영혼 폴더에 쓰는 모든 POST(`/api/structure`·`/api/summary/confirm`·`/api/setup/*`·`/api/online/*`·`/api/open-face`)는 `POST /api/locate` 가 그 폴더를 받아들인 뒤에만 동작한다. 아니면 409 `{ ok:false, reason:"no_soul"|"no_locate" }` 이고 아무것도 쓰지 않는다. `mode:"foreign"` 판정은 앞서 받은 확인을 **취소**한다.
- `POST /api/log/path` → `{ ok, path }` (화면 「로그 경로 복사」용)
- `POST /api/report/send` 본문 `{ memo?, contact?, preview? }` → 「개발자에게 신고하기」(2026-09-19). `preview:true` 면 보내지 않고 `{ ok, preview:true, id, bytes, payload }`(화면 미리 보기용); 아니면 묶음(화면 상태·`diagnostics.json`·로그 꼬리, 사용자 이름 `<user>` 가림)을 개발자 접수 양식(구글 폼, `lib/report-send.mjs REPORT_FORM_URL`)에 POST 하고 `{ ok, id, status, error, bytes, savedTo }` — 사본은 `<root>\_agent\setup\신고-<id>.json`(영혼이 없으면 설치기 로그 폴더). 순서 가드 밖(영혼이 없어도 됨). 자동 전송 없음 — 사람이 단추를 눌렀을 때만.
- 업데이트 모드(`--auto`, 2.0.21): 세팅 엔진이 끝난 뒤 영수증에 온라인(계정 연결)이 끝나 있으면 중계기를 띄우고(`onlineRunner.startRelay`) 같은 재측정을 한다 — 진행 방송 `part:"relay-recheck"`(96~97%), 결과는 `online.recheck` + 영수증 갈아 끼움. 업데이트는 `checks` 단계를 건너뛰므로 이것이 없으면 이미 설치된 PC 는 「업데이트」로 CA 번들을 얻지 못한다.
- `online.recheck` (2026-09-19): `POST /api/online/relay` 가 성공하면 검사 12·13(중계기 경유)을 다시 재어 `{ at, items:[{id,num,label,status,detail}], error? }` 로 싣고, 영수증 `setup.checks.recorded.items` 의 같은 id 를 갈아 끼운다(신규 설치의 ⑥ 시점 "대기"가 ⑦ 뒤 "통과"로 바뀌고 CA 번들이 그때 만들어진다).

## 재실행·모드
- 서버 시작 시 영수증이 있으면: `setup` 전부 done·`online` 미완 → step=`online`; 전부 done → step=`done`(요약만); `decisions.json`만 있으면 step=`summary`.
- `--resume` 인수: 위 판정을 강제 적용(Face 「설치 이어하기」가 씀).
- `--auto`(업데이터): 영수증 `schema<2` → 즉시 `{ step:"reinstall-required" }`.

## 프리셋 파일 `installer/ui/presets.json`
```json
{ "schema": 1, "presets": [
  { "id": "teacher", "label": "교사", "tree": [
    { "level":"R", "nameKo":"교사", "nameEn":"Teacher", "children":[
      { "level":"D", "nameKo":"수업", "nameEn":"Teaching", "children":[
        { "level":"P", "nameKo":"이번 학기 수업 준비", "nameEn":"Semester Prep" } ] } ] } ] }
] }
```
7종 id: `teacher, researcher, business, developer, office-worker, student, writer`. 개인 항목(실명·학교·회사) 금지.
