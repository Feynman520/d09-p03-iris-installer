"""
gen-image.py — IRIS 공용 이미지 생성기 (코덱스 우선 → OpenAI API 폴백, API 모델은 항상 최신)

사용법:
  python %IRIS_ROOT%\\_agent\\claude\\tools\\gen-image.py --prompt-file <프롬프트.txt> --out <저장경로.png>
        [--size 1536x1024] [--quality high] [--provider auto|codex|api] [--ref <참조이미지> ...]
        [--fast] [--transparent] [--check]

우선순위(전역 AGENTS.md 「이미지 생성」 절이 정본):
  ① TeamClaude(127.0.0.1:3456)에 활성 코덱스 계정이 있으면 `codex exec` + 내장 image_gen 도구(구독, 추가 과금 없음)
  ② 없거나 코덱스 경로가 실패하면 OpenAI Images API(종량 과금). 모델은 호출 직전 모델 목록에서
     가장 높은 버전의 gpt-image-* 를 고른다(-mini·날짜 스냅샷 제외). 같은 버전에 변종이 있으면
     기본 sunburst(가장 유능), --fast 면 flare(가장 빠름).

크기:
  - 코덱스 내장 도구는 픽셀이 아니라 **비율**만 맞춘다(실측 2026-09-11: 가로형 요청 1536x1024 → 1448x1086,
    정사각 → 1254x1254, 약 157만 화소). 결과가 요청과 다르면 출력 한 줄에 size-mismatch 를 붙인다.
  - 정확한 픽셀이 필요하면 --exact-size (API 경로 강제, 과금) 를 쓴다.

규칙:
  - 프롬프트 파일은 UTF-8. 한글이 든 파일은 Bash heredoc 대신 Write 도구로 만든다(R-002).
  - 경로 기본값: CLAUDE_CONFIG_DIR · CODEX_HOME · IRIS_ROOT 환경변수에서 얻는다(설치본은 이미 설정돼 있다).
  - API 키는 secrets .env 의 OPENAI_API_KEY. 키 원문은 어디에도 출력하지 않는다.
  - 저장 폴더가 없으면 만들지 않고 오류로 끝낸다(경로 실존 검증 규칙).
  - 마지막 줄에 항상 한 줄 요약: saved <경로> (<바이트>) provider=… model=… size=… quality=… [fallback: …]
  - --check 는 생성 없이 판정 결과만 출력한다(과금 없음).
"""
import sys, os, re, io, json, time, uuid, base64, shutil, pathlib, argparse, subprocess, urllib.request, urllib.error
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

TOOLS_DIR = pathlib.Path(__file__).resolve().parent
# 경로 기본값은 IRIS 설치 뿌리에서 유도한다(설치본에는 이 환경변수들이 이미 설정돼 있다).
IRIS_ROOT = pathlib.Path(os.environ.get("IRIS_ROOT", r"C:\IRIS"))
CFG_DIR = pathlib.Path(os.environ.get("CLAUDE_CONFIG_DIR") or (IRIS_ROOT / "_agent" / "claude"))
CODEX_HOME = pathlib.Path(os.environ.get("CODEX_HOME") or (IRIS_ROOT / "_agent" / "codex"))
STATE_FILE = TOOLS_DIR / "gen-image.state.json"
TEAMCLAUDE_STATUS = "http://127.0.0.1:3456/teamclaude/status"
OPENAI_BASE = "https://api.openai.com/v1"
DEFAULT_API_MODEL = "gpt-image-2.5-sunburst"   # 모델 목록 조회가 실패했을 때의 마지막 보루
CODEX_TIMEOUT = 600


# ---------- 공통 ----------
def log(msg):
    print(msg, flush=True)


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(patch):
    st = load_state()
    st.update(patch)
    try:
        STATE_FILE.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def load_openai_key():
    key = os.environ.get("OPENAI_API_KEY")
    env_path = CFG_DIR / "secrets" / ".env"
    if not key and env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("OPENAI_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"')
    return key


def png_size(path):
    """PNG IHDR에서 (w,h). PNG가 아니면 None."""
    try:
        with open(path, "rb") as f:
            head = f.read(24)
        if head[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        w = int.from_bytes(head[16:20], "big")
        h = int.from_bytes(head[20:24], "big")
        return (w, h)
    except Exception:
        return None


# ---------- ① TeamClaude 코덱스 계정 판정 ----------
def codex_accounts():
    """(사용 가능 여부, 활성 계정 이름 목록, 사유)"""
    try:
        with urllib.request.urlopen(TEAMCLAUDE_STATUS, timeout=5) as r:
            d = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return False, [], f"teamclaude status unreachable ({type(e).__name__})"
    active = []
    for a in d.get("accounts", []):
        if a.get("provider") != "codex":
            continue
        if a.get("disabled"):
            continue
        if a.get("unavailable"):
            continue
        if a.get("status") not in (None, "active"):
            continue
        active.append(a.get("name"))
    if not active:
        return False, [], "no active codex account in teamclaude"
    return True, active, "ok"


# ---------- ② API 최신 모델 판별 ----------
MODEL_RE = re.compile(r"^gpt-image-(\d+(?:\.\d+)?)(?:-([a-z]+))?$")


def resolve_api_model(fast=False, key=None):
    """(모델 ID, 출처) — 출처: 'models-api' | 'state' | 'default'"""
    key = key or load_openai_key()
    ids = []
    if key:
        try:
            req = urllib.request.Request(f"{OPENAI_BASE}/models", headers={"Authorization": f"Bearer {key}"})
            with urllib.request.urlopen(req, timeout=15) as r:
                ids = [m["id"] for m in json.loads(r.read().decode("utf-8")).get("data", [])]
        except Exception:
            ids = []
    cands = []
    for mid in ids:
        m = MODEL_RE.match(mid)
        if not m:
            continue
        ver, variant = float(m.group(1)), (m.group(2) or "")
        if variant == "mini":
            continue
        cands.append((ver, variant, mid))
    if cands:
        top = max(v for v, _, _ in cands)
        same = [(variant, mid) for v, variant, mid in cands if v == top]

        def pick(pref):
            for p in pref:
                for variant, mid in same:
                    if variant == p:
                        return mid
            return sorted(mid for _, mid in same)[0]

        chosen_default = pick(["sunburst", "flare", ""])
        chosen_fast = pick(["flare", "sunburst", ""])
        save_state({"last_api_model": chosen_default, "last_api_model_fast": chosen_fast,
                    "last_models_seen": sorted(mid for _, _, mid in cands),
                    "last_models_checked_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
        return (chosen_fast if fast else chosen_default), "models-api"
    st = load_state()
    k = "last_api_model_fast" if fast else "last_api_model"
    if st.get(k):
        return st[k], "state"
    return DEFAULT_API_MODEL, "default"


# ---------- ③ 코덱스 경로 ----------
def build_codex_prompt(prompt, size, quality, refs, transparent):
    w, h = size.split("x")
    lines = [
        "You are an image-generation relay. Do exactly the following and nothing else.",
        "1. Call the built-in image_gen tool ONCE to produce exactly ONE image.",
        f"   - Requested output size: {w}x{h} pixels (width x height). Requested quality: {quality}.",
    ]
    if transparent:
        lines.append("   - The background must be transparent (real alpha channel PNG).")
    if refs:
        lines.append(f"   - {len(refs)} reference image(s) are attached to this message. Use them as the edit source / visual reference exactly as the image prompt describes.")
    lines += [
        "   - The image prompt is the text between <image_prompt> and </image_prompt> below. Pass it to the tool faithfully; do not shorten, translate, or rewrite it.",
        "2. Do NOT run shell commands, do NOT read or write files, do NOT move or copy the image, do NOT call any other tool.",
        "3. After the image is generated, reply with exactly: DONE",
        "",
        "<image_prompt>",
        prompt,
        "</image_prompt>",
    ]
    return "\n".join(lines)


def gen_codex(prompt, size, quality, refs, out, transparent, simulate_fail=False):
    """성공 시 (True, info dict) / 실패 시 (False, 사유)"""
    if simulate_fail:
        return False, "simulated codex failure"
    codex = shutil.which("codex")
    if not codex:
        return False, "codex CLI not found"
    work = pathlib.Path(os.environ.get("TEMP", ".")) / "iris-gen-image" / uuid.uuid4().hex[:8]
    work.mkdir(parents=True, exist_ok=True)
    cmd = [codex, "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
           "-C", str(work), "-c", 'model_reasoning_effort="low"']
    for r in refs:
        cmd += ["-i", str(r)]
    cmd.append(build_codex_prompt(prompt, size, quality, refs, transparent))
    t0 = time.time()
    try:
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception as e:
        return False, f"codex spawn failed ({type(e).__name__})"
    try:
        so, se = p.communicate(timeout=CODEX_TIMEOUT)
    except subprocess.TimeoutExpired:
        p.kill()   # 자기가 띄운 프로세스만 종료
        return False, f"codex timeout after {CODEX_TIMEOUT}s"
    thread_id = None
    final_text = ""
    for line in so.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("type") == "thread.started":
            thread_id = ev.get("thread_id")
        if ev.get("type") == "item.completed" and ev.get("item", {}).get("type") == "agent_message":
            final_text = ev["item"].get("text", "")
    shutil.rmtree(work, ignore_errors=True)
    if p.returncode != 0:
        return False, f"codex exit {p.returncode}: {se.decode('utf-8','replace')[-300:].strip()}"
    # 생성물 회수: generated_images/<thread_id>/*.png (없으면 시작 시각 이후 새 PNG 전체 탐색)
    cands = []
    if thread_id and (CODEX_HOME / "generated_images" / thread_id).exists():
        cands = list((CODEX_HOME / "generated_images" / thread_id).glob("*.png"))
    if not cands and (CODEX_HOME / "generated_images").exists():
        cands = [f for f in (CODEX_HOME / "generated_images").rglob("*.png") if f.stat().st_mtime >= t0 - 5]
    if not cands:
        return False, f"codex produced no image (reply: {final_text[:120]!r})"
    src = max(cands, key=lambda f: f.stat().st_mtime)
    shutil.copyfile(src, out)
    return True, {"model": "codex-builtin", "source": str(src), "elapsed": round(time.time() - t0, 1),
                  "thread_id": thread_id, "reply": final_text[:80]}


# ---------- ④ API 경로 ----------
def _multipart(fields, files):
    boundary = "----iris" + uuid.uuid4().hex
    body = io.BytesIO()
    for k, v in fields.items():
        body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode("utf-8"))
    for k, path in files:
        data = pathlib.Path(path).read_bytes()
        ext = pathlib.Path(path).suffix.lower().lstrip(".") or "png"
        mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(ext, "image/png")
        body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{pathlib.Path(path).name}\"\r\nContent-Type: {mime}\r\n\r\n".encode("utf-8"))
        body.write(data)
        body.write(b"\r\n")
    body.write(f"--{boundary}--\r\n".encode("utf-8"))
    return body.getvalue(), f"multipart/form-data; boundary={boundary}"


def gen_api(prompt, size, quality, refs, out, transparent, model, key):
    if not key:
        return False, "OPENAI_API_KEY not found"
    try:
        if refs:
            fields = {"model": model, "prompt": prompt, "size": size, "quality": quality, "n": "1"}
            if transparent:
                fields["background"] = "transparent"
            data, ctype = _multipart(fields, [("image[]", r) for r in refs])
            req = urllib.request.Request(f"{OPENAI_BASE}/images/edits", data=data,
                                         headers={"Authorization": f"Bearer {key}", "Content-Type": ctype})
        else:
            payload = {"model": model, "prompt": prompt, "size": size, "quality": quality, "n": 1}
            if transparent:
                payload["background"] = "transparent"
            req = urllib.request.Request(f"{OPENAI_BASE}/images/generations", data=json.dumps(payload).encode("utf-8"),
                                         headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=600) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code} {e.read().decode('utf-8','replace')[:300]}"
    except Exception as e:
        return False, f"api error ({type(e).__name__})"
    img = body["data"][0]
    if "b64_json" in img:
        pathlib.Path(out).write_bytes(base64.b64decode(img["b64_json"]))
    else:
        urllib.request.urlretrieve(img["url"], str(out))
    return True, {"model": model, "elapsed": round(time.time() - t0, 1)}


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt-file", required=False)
    ap.add_argument("--out", required=False)
    ap.add_argument("--size", default="1536x1024")        # 1024x1024 | 1536x1024 | 1024x1536 | WxH(16의 배수)
    ap.add_argument("--quality", default="high")          # low | medium | high | xhigh | max | auto
    ap.add_argument("--provider", default="auto", choices=["auto", "codex", "api"])
    ap.add_argument("--ref", action="append", default=[], help="참조 이미지(편집·스타일 참고). 여러 번 지정 가능")
    ap.add_argument("--fast", action="store_true", help="API 변종을 flare(가장 빠름)로")
    ap.add_argument("--transparent", action="store_true")
    ap.add_argument("--exact-size", action="store_true", help="정확한 픽셀 크기가 필요할 때(API 경로 강제, 과금)")
    ap.add_argument("--check", action="store_true", help="생성 없이 판정만 출력")
    ap.add_argument("--simulate-no-codex", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--simulate-codex-fail", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--model", default=None, help="API 모델 강제 지정(보통 쓰지 않음)")
    a = ap.parse_args()

    if not re.fullmatch(r"\d+x\d+|auto", a.size):
        log(f"bad --size {a.size}"); sys.exit(2)
    for r in a.ref:
        if not pathlib.Path(r).exists():
            log(f"ref not found: {r}"); sys.exit(2)

    key = load_openai_key()
    ok, names, reason = (False, [], "simulated: no codex") if a.simulate_no_codex else codex_accounts()
    api_model = a.model or resolve_api_model(fast=a.fast, key=key)[0]
    if a.exact_size and a.provider == "auto":
        a.provider = "api"
        reason = "exact-size requested"
    if a.provider == "codex":
        route = "codex"
    elif a.provider == "api":
        route = "api"
    else:
        route = "codex" if ok else "api"

    if a.check:
        log(f"teamclaude codex: {'available' if ok else 'unavailable'} ({reason}) accounts={names}")
        log(f"api candidate model: {api_model} (source={resolve_api_model(fast=a.fast, key=key)[1]}, fast={a.fast})")
        log(f"route: provider={route}" + ("" if ok or route == 'codex' else f" (codex unavailable: {reason})"))
        if a.simulate_codex_fail and route == "codex":
            log(f"fallback simulation: codex failed -> provider=api model={api_model} [fallback: codex failed: simulated codex failure]")
        sys.exit(0)

    if not a.prompt_file or not a.out:
        log("--prompt-file and --out are required unless --check"); sys.exit(2)
    prompt = pathlib.Path(a.prompt_file).read_text(encoding="utf-8").strip()
    out = pathlib.Path(a.out)
    if not out.parent.exists():
        log(f"parent folder does not exist: {out.parent}"); sys.exit(3)

    fallback = None
    info = None
    if route == "codex":
        okc, res = gen_codex(prompt, a.size, a.quality, a.ref, out, a.transparent, simulate_fail=a.simulate_codex_fail)
        if okc:
            info = res; provider = "codex"
        else:
            if a.provider == "codex":
                log(f"codex failed: {res}"); sys.exit(1)
            fallback = f"codex failed: {res}"
            route = "api"
    if route == "api":
        if fallback is None and a.provider == "auto":
            fallback = f"codex unavailable: {reason}"
        oka, res = gen_api(prompt, a.size, a.quality, a.ref, out, a.transparent, api_model, key)
        if not oka:
            log(f"api failed: {res}" + (f" [after {fallback}]" if fallback else "")); sys.exit(1)
        info = res; provider = "api"

    actual = png_size(out)
    size_note = ""
    if actual and a.size != "auto" and f"{actual[0]}x{actual[1]}" != a.size:
        size_note = f" size-mismatch(actual={actual[0]}x{actual[1]})"
    log(f"saved {out} ({out.stat().st_size} bytes) provider={provider} model={info['model']} "
        f"size={a.size}{size_note} quality={a.quality} elapsed={info.get('elapsed')}s"
        + (f" [fallback: {fallback}]" if fallback else ""))


if __name__ == "__main__":
    main()
