# `lock.json` 스키마 (schema 2)

부품 잠금표의 정본. 여기 적힌 필드만 쓰고, 새 필드가 필요하면 이 문서와 `tests/manifest.test.mjs`를 같은 턴에 고친다.
잠금표 자체는 `lock.json`, 검사는 `tests/manifest.test.mjs`(단위)와 `verify/static.mjs`(zip)가 한다.

## 0. 최상위

| 필드 | 뜻 |
|---|---|
| `$comment` | 사람이 읽는 머리말(문자열 배열). 도구는 무시한다. |
| `schema` | `2`. v1(=1)은 `guides`·`guideVersion`이 있던 판. |
| `package.version` | 설치 패키지 판(`2.0.0`). **`guideVersion`은 v2에서 사라졌다** — 세팅가이드 md를 zip에서 뺐기 때문(설계 D2-03). |
| `parts` | 부품 이름 → 부품 객체. 이름이 설치·영수증·manifest의 키다. |

## 1. 모든 부품의 공통 필수 필드

| 필드 | 뜻 |
|---|---|
| `kind` | `url` · `npm-prefix` · `claude-release` · `git` · `wheelhouse` · `dir` · `file` 중 하나. |
| `license` | 허가서 표기(SPDX 또는 설명). 포장(T08)이 이 값으로 부품 허가서 목록을 만든다. |
| `dest` | **영혼 루트 기준 '폴더' 경로**(POSIX 구분자). `"/"`는 영혼 루트 자체. 파일 이름은 부품이 정한다(`file` kind는 원본 이름 그대로). |
| `file` | zip 안 `payload\` 기준 경로. 끝이 `/`면 여러 파일이 들어가는 폴더(manifest가 파일마다 지문을 남긴다). |

선택 공통: `note`(사람용 설명) · `licenseNotice`(지우면 안 되는 허가서 주의 문구) · `bytes` · `redistribute`(`bundle`=동봉 / `download`=설치 중 내려받기) · `entry`(실행 진입 파일) · `env`(수집·설치 때 걸 환경변수) · `bin`.

## 2. kind별 필수 필드

| kind | 필수 | 선택 | 잠금 근거 |
|---|---|---|---|
| `url` | `version` · `url` · `sha256`(64자) · `sha256Source` | `fallback`(같은 모양의 예비 판) | 지문 |
| `npm-prefix` | `npm` · `version` · `integrity`(`sha512-…`) | `tarball` · `patches` · `entry` | 판 + integrity |
| `claude-release` | `version` · `url` · `manifestUrl` · `sha256` · `sha256Source` · `fallback{kind,npm,version,integrity}` | `binName` | 공식 manifest의 `platforms.win32-x64.checksum` |
| `git` | `repo` · `commit`(40자 16진) · `pinnedAt`(ISO 날짜) | `tag` · `version` · `subdir` · `include` · `requires` · `runtime` · `expectedSkillCount` | 커밋 |
| `wheelhouse` | `requirementsLock` · `sha256`(=lock 파일 지문) · `pythonTag` · `platform` · `expectedCount` | `requirementsIn` · `requirementsInSha256` · `venv` | requirements.lock 지문 + 바퀴 개수 |
| `dir` | `source`(저장소 상대경로 또는 이 PC 절대경로) | `include` · `exclude` · `redact` · `npmCi` · `asciiRequired` | 원본 폴더(빌드 때 manifest에 지문) |
| `file` | `source` | — | 원본 파일(빌드 때 manifest에 지문) |

### 읽는 법 몇 가지

- **`include` vs `subdir`** — `subdir`는 저장소 안 폴더 하나만 가져올 때, `include`는 여러 경로·파일을 골라 담을 때. 둘 다 없으면 저장소 전체.
- **`requires`** — 그 부품이 돌려면 PC에 있어야 하는 프로그램. 없으면 막지 않고 `pending`으로 기록한다(설계 6-3 검사 2).
- **`runtime`** — 이 부품이 쓰는 파이썬 환경 이름. `wheelhouse` 부품의 이름과 짝이 맞아야 한다.
- **`asciiRequired`** — 그 폴더의 `.ps1`이 순수 ASCII여야 한다는 뜻. 실제 사본 손질은 정책 단계(T20)가 한다.
- **`fallback`** — 출처가 막혔을 때 쓸 두 번째 출처. 주 출처와 **같은 판**이어야 한다(`claude`) 또는 검증된 구판(`uv`).

## 3. 잠금 규칙 (검사로 강제)

1. `latest` · `main` · `HEAD` · `*` 같은 **움직이는 참조는 어떤 값에도 넣지 않는다.** 커밋·판·지문으로만 고정한다.
2. `url`·`claude-release`는 `sha256` 64자 16진, `git`은 `commit` 40자 16진.
3. 모든 부품에 `kind`·`license`·`dest`·`file`이 있어야 한다.
4. `guides` 부품과 `package.guideVersion`은 v2에 없다.
5. 판을 손으로 적지 않는 부품(`face`)은 빌드가 원본 `package.json`에서 읽어 manifest에 넣는다.

## 4. `dest` 규칙

- 도구는 `_agent/shared/tools/…` 안에서만 산다(불변 원칙). 판이 있는 도구는 `…/<id>/<판>`으로, v1부터 있던 실행 부품(node·python·git·face·codex·teamclaude·dash·updater)은 **v1 설치기 배치 그대로** 판 없는 폴더를 쓴다 — 업데이터의 `.prev` 교체가 그 경로를 전제로 한다.
- 영혼 루트에 놓이는 것: 온톨로지 명세서·폴더 아이콘(`"/"`), 문서 양식(`_document-templates`), 온톨로지 파이썬(`_ontology`), 안전 훅(`_agent/claude/scripts`).
