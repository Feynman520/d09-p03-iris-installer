#!/usr/bin/env python3
"""codex-ready.py — 이 PC 의 중계기(127.0.0.1:3456)로 지금 코덱스를 부를 수 있는지 판정한다(모델 호출 없음, 무료).

중계기 상태 주소를 한 번 읽는 것이 전부다. 읽기 제한 시간은 5초 — 중계기가 꺼져 있으면 보통 바로 답이 오고,
답이 없으면 길어도 5초 뒤에 "쓸 수 없음"으로 끝난다.

용도: "코덱스를 먼저 쓴다"는 일(그림 생성 등)에서, 부르기 전에 쓸 수 있는지 확인한다.
출력 한 줄(마지막 줄):
  codex=ready  accounts=<계정 이름,…>                                    (종료코드 0) 요금제가 남은 계정이 있음
  codex=credit account=<계정 이름> balance=<잔액> accounts=…  note=plan-spent-paying-with-credits
                                                                         (종료코드 0) 요금제는 다 찼고 충전 크레딧으로 처리됨
  codex=none   reason=<사유>                                             (종료코드 1)
판정:
  ① 요금제: provider=codex · disabled 아님 · unavailable 없음 · status active
  ② 크레딧: ①이 하나도 없을 때만. 중계기 상태 creditFallback.codex 가 켜져 있고, 요금제 한도 때문에만 빠진 계정
     (unavailable 'quota'·'upstream-rejected') 가운데 creditBlock 칸이 **있고 null**(= 중계기가 지금 크레딧을 쓸 수 있다고 봄)인 것.
     크레딧 사용 여부의 판단은 중계기(creditBlock)가 정본이다 — 여기서 잔액·관측 시각을 다시 계산하지 않는다.
     칸이 없는 옛 중계기·대체 꺼짐·낡음·바닥이면 none(돈을 짐작으로 쓰지 않는다). 과금 경로는 바꾸지 않는다 — 요청은 늘 중계기로 간다.
  account = 지금 쓰는 계정(creditMode) → 없으면 중계기와 같은 순서로 예상(사용자 순서 creditFallback.order → limit_reached 아님 → 잔액 큰 순).
옵션: --json(판정 전체를 JSON으로, 마지막 줄은 같음) · 시험 전용: --status-file <json> · --no-cli-check
같은 판정을 쓰는 곳: 같은 폴더의 gen-image.py(이 파일을 불러 쓴다 — 두 파일은 한 부품으로 함께 놓인다).
"""
import sys, json, shutil, urllib.request

TEAMCLAUDE_STATUS = "http://127.0.0.1:3456/teamclaude/status"
STATUS_TIMEOUT = 5  # 초. 위 설명의 "길어도 5초"가 이 값이다.
PLAN_REASONS = ("quota", "upstream-rejected")  # 요금제 한도로만 빠진 상태(중계기의 크레딧 고르기와 같은 목록)


def fetch_status(timeout=STATUS_TIMEOUT):
    with urllib.request.urlopen(TEAMCLAUDE_STATUS, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _credits(a):
    return ((a.get("quota") or {}).get("codexCredits") or {})


def judge(d):
    """중계기 상태 응답 → {kind: ready|credit|none, ok, accounts, reason, credit, raw}."""
    raw = [a for a in (d.get("accounts") or []) if a.get("provider") == "codex"]
    usable = [a for a in raw if not a.get("disabled") and a.get("status") in (None, "active")]
    plan = [a.get("name") for a in usable if not a.get("unavailable")]
    out = {"kind": "none", "ok": False, "accounts": [], "reason": "", "credit": None, "raw": raw}
    if plan:
        return {**out, "kind": "ready", "ok": True, "accounts": plan, "reason": "ok"}
    if not raw:
        return {**out, "reason": "no codex account in teamclaude"}
    cf = d.get("creditFallback") or {}
    if not cf.get("codex"):
        return {**out, "reason": "no active codex account in teamclaude (credit fallback off)"}
    plan_spent = [a for a in usable if a.get("unavailable") in PLAN_REASONS]
    cands = [a for a in plan_spent if "creditBlock" in a and a.get("creditBlock") is None]
    if not cands:
        why = ", ".join(f"{a.get('name')}:{a.get('creditBlock') if 'creditBlock' in a else 'unknown'}" for a in plan_spent) or "no plan-spent account"
        return {**out, "reason": f"no active codex account in teamclaude (credits not usable: {why})"}
    mode = (d.get("creditMode") or {}).get("codex") or None
    held = mode and next((a for a in cands if a.get("name") == mode.get("account")), None)
    if held:
        pick = held
    else:
        order = [n for n in (cf.get("order") or []) if isinstance(n, str)]
        rank = {n: i for i, n in enumerate(order)}
        bal = lambda a: float("inf") if _credits(a).get("unlimited") else float(_credits(a).get("balance") or 0)
        pick = sorted(cands, key=lambda a: (rank.get(a.get("name"), len(rank)), 1 if _credits(a).get("limitReached") else 0, -bal(a)))[0]
    c = _credits(pick)
    credit = {"account": pick.get("name"), "balance": None if c.get("unlimited") else c.get("balance"), "unlimited": bool(c.get("unlimited")),
              "inUse": bool(held), "since": (mode or {}).get("since") if held else None, "requests": (mode or {}).get("requests") if held else None}
    return {**out, "kind": "credit", "ok": True, "accounts": [a.get("name") for a in cands], "reason": "plan spent; paid credits", "credit": credit}


def line(r):
    if r["kind"] == "ready":
        return f"codex=ready accounts={','.join(r['accounts'])}"
    if r["kind"] == "credit":
        c = r["credit"]
        bal = "unlimited" if c["unlimited"] else (f"{c['balance']:.0f}" if isinstance(c["balance"], (int, float)) else "?")
        return f"codex=credit account={c['account']} balance={bal} accounts={','.join(r['accounts'])} note=plan-spent-paying-with-credits"
    return f"codex=none reason={r['reason']}"


def readiness(status=None, cli_check=True):
    """판정 + CLI 확인. status 를 주지 않으면 중계기에서 읽는다."""
    if status is None:
        try:
            status = fetch_status()
        except Exception as e:
            return {"kind": "none", "ok": False, "accounts": [], "reason": f"teamclaude status unreachable ({type(e).__name__})", "credit": None, "raw": []}
    r = judge(status)
    if r["ok"] and cli_check and not shutil.which("codex"):
        r = {**r, "kind": "none", "ok": False, "reason": "codex CLI not found on PATH"}
    return r


def codex_accounts():
    """옛 호출 모양 호환: (사용 가능 여부, 계정 이름 목록, 사유, 원본 계정 목록). 크레딧 판정도 '사용 가능'이다."""
    r = readiness(cli_check=False)
    return r["ok"], r["accounts"], r["reason"], r["raw"]


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    argv = sys.argv[1:]
    status = None
    if "--status-file" in argv:
        with open(argv[argv.index("--status-file") + 1], encoding="utf-8") as f:
            status = json.load(f)
    r = readiness(status, cli_check="--no-cli-check" not in argv)
    if "--json" in argv:
        print(json.dumps({"ready": r["ok"], "mode": {"ready": "plan", "credit": "credit"}.get(r["kind"]), "accounts": r["accounts"],
                          "reason": r["reason"], "credit": r["credit"], "raw": r["raw"]}, ensure_ascii=False, indent=1))
    print(line(r))
    return 0 if r["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
