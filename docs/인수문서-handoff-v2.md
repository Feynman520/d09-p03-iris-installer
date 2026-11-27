# 인수 문서 `handoff.json` v2 계약 (T18 설치기가 쓰고 T21 Face가 읽는다)

경로: `<영혼>\_agent\setup\handoff.json` (UTF-8, 원자 쓰기). 설치기→Face의 **유일한 통로**. Face는 이 파일과 영수증(`package-receipt.json`)만 읽고 세팅을 절대 하지 않는다.

```json
{
  "schema": 1,
  "packageVersion": "2.0.0",
  "writtenAt": "2026-09-15T12:00:00+09:00",
  "state": "ready",
  "subscriptions": ["claude", "chatgpt"],
  "leadAgent": "claude",
  "login": { "claude": "done", "chatgpt": "not-needed" },
  "relay": { "state": "done", "accounts": 1 },
  "setup": { "allDone": true, "failed": null },
  "folders": ["R01-교사(Teacher)", "R01-교사(Teacher)/D01-수업(Teaching)"],
  "nameEnMissing": ["R02-연구"],
  "deferred": ["S", "T", "tags"],
  "pendingCapabilities": [
    { "capability": "문서 자동화(한글)", "reason": "한컴오피스가 설치되어 있지 않습니다", "howToEnable": "한컴오피스를 설치하면 자동으로 켜집니다" }
  ],
  "checks": { "pass": 8, "pending": 1, "fail": 0 },
  "reportPath": "_agent/setup/설치보고-2026-09-15.md",
  "diagnosticsPath": "_agent/setup/diagnostics.json",
  "firstMessage": "세팅이 끝났다. …(설치기가 쓰는 첫 인사 프롬프트, 상대경로만)",
  "messenger": { "installed": true, "prompted": false },
  "resume": { "installerPath": "_agent/setup/installer/IRIS-설치.cmd", "args": ["--resume"] }
}
```

| 필드 | 값 | 뜻 |
|---|---|---|
| `state` | `"ready"` · `"login-pending"` · `"setup-incomplete"` | Face 첫 실행 분기. `ready`만 첫 인사. 나머지는 안내 카드 + 「설치 이어하기」 |
| `login.<provider>` | `not-needed` · `waiting` · `done` · `failed` | 구독별 로그인 |
| `setup.allDone` | 영수증 `setup.*` 9단계 전부 `done` | Face가 영수증을 다시 읽어 **교차 확인**한다(파일이 어긋나면 `setup-incomplete`로 취급) |
| `nameEnMissing` | 영어 이름이 비어 있는 폴더 이름 | 첫 인사에서 채우기 제안 |
| `firstMessage` | 첫 인사 프롬프트 | Face는 내용을 만들지 않고 이 문자열을 그대로 주도 에이전트에 보낸다 |
| `messenger.prompted` | Face가 메신저 로그인 안내를 한 번 보였는지 (정본 = 이 중첩 키; 평면 `messengerPrompted`는 쓰지 않는다) | Face가 `true`로 갱신(이 필드만 Face가 쓴다) |
| `messenger.installed` | 인수 문서를 처음 쓸 때 `face\modules\messenger` 폴더가 있었는지. **2.0.64 부터 새 설치는 `false`**(메신저 = 선택, 설치 패키지에 없음 — 위 예시의 `true` 는 2.0.63 까지의 값) | `true` 일 때만 Face가 메신저 로그인 안내를 1회 보인다. 나중에 설정에서 메신저를 설치해도 이 칸은 바뀌지 않는다(안내는 설치 흐름이 대신한다) |
| `resume` | 「설치 이어하기」가 실행할 것 | 영혼 안 설치기 사본 |
| `claudeLongKey` (2.0.66 — 더하기만, 위 예시에는 없다) | `{ "state": "received" · "partial" · "not-received" · "not-needed", "expiresAt": <ISO 시각 또는 null>, "howTo": "설정 → 계정 · 보안 → 1년 열쇠 받기" 또는 null }` | 설치 화면의 「1년 열쇠 받기(권장)」 카드 결과(영수증 `online.logins.claude` 의 `longKey` · `longKeyExpiresAt` · `longKeySlots` 에서 만든다). `partial` = 두 자리(계정 연결 · IRIS 창 세션) 가운데 하나에만 넣음, `not-needed` = Claude 구독을 고르지 않음. **안내용일 뿐 `state` 판정에 쓰지 않는다** — 받지 않아도 `ready` 다. 2.0.65 까지의 인수 문서에는 이 칸이 없다(없으면 "모름"으로 읽는다). 카드 결과가 난 뒤에는 설치기가 이 한 칸만 갈아 끼운다(다른 칸 · `writtenAt` 은 그대로) |

규칙: 경로는 전부 영혼 루트 상대경로(휴대성). 토큰·키·이메일·사용자 이름 없음. Face는 `messenger.prompted` 외 어떤 필드도 쓰지 않는다.
