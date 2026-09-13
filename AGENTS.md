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

<!-- 상위(루트/R07/D09) AGENTS.md 규칙 재서술 금지 -->
