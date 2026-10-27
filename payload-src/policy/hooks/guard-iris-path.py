# -*- coding: utf-8 -*-
r"""PreToolUse guard: IRIS 경로 실존 가드 (전역 규칙).

배경: 에이전트가 한글 경로를 일본어/한자로 잘못 타이핑하면 쓰기 도구가 없는 중간 폴더를
조용히 만들어 유령 R/D/P 트리가 생긴다. 글로 된 규칙만으로는 막히지 않으므로
도구 실행 직전에 기계적으로 막는다.

검사 대상: Write · Edit · MultiEdit · NotebookEdit · Bash · PowerShell
차단 조건(IRIS 루트 아래 경로에 한해):
  A. 경로 어느 조각에든 한자·가나(일본어/중국어 문자)가 들어 있으면 차단.
     IRIS 폴더명은 한글·영어·숫자만 쓴다.
  B. IRIS 바로 아래 최상위 폴더가 실존하지 않는데 그 밑에 무언가를 쓰려 하면 차단.
     (Write/Edit류는 항상, Bash/PowerShell은 mkdir·cp·mv·리다이렉션 등 생성 동사가 있을 때만)
  C. Write/Edit류가 존재하지 않는 R/D/P/S/T 코드 폴더를 암묵적으로 만들려 하면 차단.
     새 위계 폴더는 mkdir로 명시적으로 만든 뒤에 써야 한다.
  D. IRIS 루트 바로 밑에 **새 낱개 파일**을 만들려 하면 차단(이미 있는 루트 파일 수정은 통과).
     배경: 보조 에이전트가 임시 폴더 저장에 실패한 뒤 `cd <IRIS 루트> && curl -o …`로 조회 결과 임시 파일
     여러 개를 루트에 흘린 일이 있었다(글 규칙 "임시 파일은 %TEMP%만"이 있었는데도).
     Write류는 경로로, 셸은 cd 추적(훅 cwd 포함) + 저장 대상(>·>>, curl -o/-O, wget, tee, touch,
     cp/mv 목적지, Out-File·Set-Content·New-Item·-OutFile, python/node 인라인·heredoc의 open(...,'w') 등)으로 판정.
     한계: 스크립트 파일 **내부**의 저장은 못 본다.
     허용 새 루트 파일 = ROOT_ALLOW_NEW(전역 문서류). 새 루트 문서가 정말 필요하면 여기에 추가.
면제: `_trash\`, `_agent\` 아래 경로(격리물·세션 기록에는 유령 이름이 남아 있을 수 있음).

macOS(2026-10-27, P03 docs/설계-macOS.md M5): IRIS 루트 기본값 = ~/IRIS. 드라이브 문자 경로에 더해
루트 아래 POSIX 절대경로와 그 `~/`·`$HOME/` 표기를 같은 규칙으로 본다. Windows 에서는 이전과 글자까지 같다.

출력: 차단 시 hookSpecificOutput.permissionDecision=deny JSON 한 줄. 그 외 아무것도 출력하지 않는다.
오류가 나면 조용히 통과시킨다(가드가 정상 작업을 막아서는 안 된다).
"""
import json
import os
import re
import sys

# IRIS 루트. 설치 위치는 <시스템 드라이브>\IRIS(macOS 는 ~/IRIS)로 고정이며, 시험용으로만 IRIS_ROOT로 덮어쓴다.
WINDOWS = os.name == "nt"
HOME = os.path.expanduser("~")
IRIS_ROOT = os.environ.get("IRIS_ROOT") or (
    os.path.join(os.environ.get("SystemDrive", "C:") + os.sep, "IRIS") if WINDOWS else os.path.join(HOME, "IRIS")
)
POSIX_ROOT = IRIS_ROOT.rstrip("/")
EXEMPT_TOP = {"_trash", "_agent"}
CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
CODE_DIR = re.compile(r"^(〖[^〗]*〗)?[RDPST]\d")
PATH_IN_TEXT = re.compile(
    r"(?:[A-Za-z]:[\\/]{1,4}IRIS|/[A-Za-z]/IRIS)[\\/]{1,4}([^\"'\r\n;|&<>]*)"
)

def _home_forms(root: str):
    """루트가 홈 아래면 ~/·$HOME/·${HOME}/ 표기(정규식 조각)도 같은 루트로 본다."""
    if WINDOWS or not root.startswith(HOME.rstrip("/") + "/"):
        return []
    rel = re.escape(root[len(HOME.rstrip("/")) + 1:])
    return [r"~/" + rel, r"\$HOME/" + rel, r"\$\{HOME\}/" + rel]


PATH_IN_TEXT_POSIX = re.compile(
    "(?:" + "|".join([re.escape(POSIX_ROOT)] + _home_forms(POSIX_ROOT)) + r")/([^\"'\r\n;|&<>]*)"
)
CREATE_VERBS = re.compile(
    r"(?i)(\bmkdir\b|\bmd\b|New-Item|\bni\b|\bmv\b|\bcp\b|Move-Item|Copy-Item|Rename-Item|"
    r"\brobocopy\b|\bxcopy\b|Out-File|Set-Content|Add-Content|\btee\b|>|\btouch\b|\brsync\b|\bmove\b|\bcopy\b|\bren\b)"
)
EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "PowerShell"}

# --- 규칙 D: 루트 낱개 파일 ---
ROOT_ALLOW_NEW = re.compile(r"(?i)^(AGENTS\.md|CLAUDE\.md|\.gitignore|desktop\.ini|IRIS-[^\\/]+)$")
NULL_TARGETS = {"/dev/null", "nul", "/dev/stdout", "/dev/stderr", "-"}
OUT = "OUT"  # 현재 폴더가 IRIS 밖
CD_CMDS = {"cd", "set-location", "sl", "pushd", "push-location", "chdir"}
INTERP = {"python", "python3", "py", "node", "deno", "bun"}
HEREDOC_OPEN = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][\w-]*)\1")
SEP = re.compile(r"&&|\|\||;|\||\n")
REDIR = re.compile(r"(?<![-=<>])\d?>>?(?![&>])")
TOKEN = re.compile(r"\"[^\"]*\"|'[^']*'|\S+")
CODE_WRITES = [
    re.compile(r"""open\(\s*[rRbBuUfF]{0,2}(["'])([^"'\n]+)\1\s*,\s*(?:mode\s*=\s*)?[rRbB]?(["'])[rbt+]*[wax][^"']*\3"""),
    re.compile(r"""(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\(\s*(["'`])([^"'`\n]+)\1"""),
    re.compile(r"""Path\(\s*[rR]?(["'])([^"'\n]+)\1\s*\)\.(?:write_text|write_bytes|touch)\("""),
    re.compile(r"""\.(?:to_csv|to_json|to_excel|to_parquet|savefig|save)\(\s*[rR]?(["'])([^"'\n]+)\1"""),
]


def root_file_block(name: str, shown: str):
    """루트 바로 밑 파일 name을 새로 만들면 차단 사유, 아니면 None."""
    if not name or name in (".", "..") or ROOT_ALLOW_NEW.match(name):
        return None
    if os.path.exists(os.path.join(IRIS_ROOT, name)):
        return None
    return (
        f"BLOCKED - IRIS 루트 낱개 파일 가드: {IRIS_ROOT} 바로 밑에 새 파일 '{name}'을(를) 만들려 합니다 ({shown[:160]}). "
        "IRIS 루트에는 전역 문서만 둡니다. "
        "임시·중간 파일은 세션 스크래치패드(시스템 프롬프트의 Scratchpad directory, 없으면 %TEMP%\\<작업명>\\) 절대경로에, "
        "산출물은 해당 R/D/P 폴더에 쓰세요. 루트로 cd한 뒤 상대경로로 저장하는 것도 같은 행위입니다. "
        "정말 새 루트 문서가 필요하면 사용자 승인 후 guard-iris-path.py의 ROOT_ALLOW_NEW에 추가하세요. "
        "(BLOCKED: new loose file directly under the IRIS root. Write temp files to your scratchpad or %TEMP%, outputs to the project folder.)"
    )


def mask_quotes(s: str) -> str:
    """따옴표 안 글자를 '_'로 가려 같은 길이의 문자열을 돌려준다(따옴표 속 > ; | 를 연산자로 오인하지 않게)."""
    out, q = list(s), None
    for i, ch in enumerate(s):
        if q:
            if ch == q:
                q = None
            elif ch != "\n":
                out[i] = "_"
        elif ch in "\"'":
            q = ch
    return "".join(out)


def split_heredocs(cmd: str):
    """heredoc·PS here-string 본문을 떼어 내고 여는 자리에 __HEREDOC_k__ 표시를 남긴다."""
    lines, out, bodies, i = cmd.split("\n"), [], [], 0
    while i < len(lines):
        line = lines[i]
        m = HEREDOC_OPEN.search(line)
        ps = re.search(r"@['\"]\s*$", line)
        if m or ps:
            end_ok = (lambda l, t=m.group(2): l.strip() == t) if m else (lambda l: l.lstrip().startswith(("'@", '"@')))
            body, i = [], i + 1
            while i < len(lines) and not end_ok(lines[i]):
                body.append(lines[i])
                i += 1
            k = len(bodies)
            bodies.append("\n".join(body))
            pos = m.end() if m else ps.start()
            out.append(line[:pos] + f" __HEREDOC_{k}__ " + line[pos:])
            i += 1
            continue
        out.append(line)
        i += 1
    return "\n".join(out), bodies


def strip_q(t: str) -> str:
    return t[1:-1] if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'" else t


def expand_home(t: str) -> str:
    """macOS: ~/·$HOME/·${HOME}/ 로 시작하는 경로를 홈 절대경로로. Windows 는 그대로."""
    if WINDOWS:
        return t
    for pre in ("~/", "$HOME/", "${HOME}/"):
        if t.startswith(pre):
            return os.path.join(HOME, t[len(pre):])
    return HOME if t in ("~", "$HOME", "${HOME}") else t


def resolve(t: str, cur):
    """저장 대상 t → IRIS 상대 조각 목록, 판정 불가·IRIS 밖이면 None."""
    t = expand_home(strip_q(t.strip()).rstrip(")"))
    if not t or t.lower() in NULL_TARGETS or t[0] in "$&~%(":
        return None
    segs = norm_rel(t)
    if segs is not None:
        return segs
    if re.match(r"^[A-Za-z]:[\\/]|^[\\/]", t):
        return None
    if cur is None or cur == OUT:
        return None
    res = list(cur)
    for p in re.split(r"[\\/]+", t):
        if p in ("", "."):
            continue
        if p == "..":
            if not res:
                return None
            res.pop()
        else:
            res.append(p)
    return res


def cmd_name(tokens):
    """앞의 환경변수 대입·& 호출 연산자를 건너뛴 명령 이름(소문자, .exe 제거)과 그 위치."""
    for idx, tok in enumerate(tokens):
        if tok in ("&", ".", "sudo", "time", "exec") or re.match(r"^\w+=", tok):
            continue
        name = re.split(r"[\\/]", strip_q(tok))[-1].lower()
        return (name[:-4] if name.endswith(".exe") else name), idx
    return "", -1


def seg_targets(seg: str, mseg: str, tokens, name: str, ci: int):
    """세그먼트의 저장 대상 목록: (대상문자열, 'file'|'remote'|'dest', 원본파일)."""
    found = []
    for m in REDIR.finditer(mseg):
        rest = seg[m.end():].lstrip()
        tm = re.match(r"\"[^\"]*\"|'[^']*'|[^\s;&|<>]+", rest)
        if tm:
            found.append((tm.group(0), "file", None))
    args = [t for t in tokens[ci + 1:]] if ci >= 0 else []
    plain = [a for a in args if not a.startswith("-") and not a.startswith(">") and not re.match(r"^\d?>", a)]
    if name == "curl":
        for j, a in enumerate(args):
            if a in ("-o", "--output") or re.match(r"^-[A-Za-z]*o$", a):
                if j + 1 < len(args):
                    found.append((args[j + 1], "file", None))
            elif a in ("-O", "--remote-name", "--remote-name-all") or re.match(r"^-[A-Za-z]*O[A-Za-z]*$", a):
                found.append(("", "remote", None))
    elif name == "wget":
        if "-O" in args:
            j = args.index("-O")
            if j + 1 < len(args):
                found.append((args[j + 1], "file", None))
        elif "-P" not in args and not any(a.startswith(("--directory-prefix", "-O")) for a in args):
            found.append(("", "remote", None))
    elif name in ("touch", "tee", "tee-object"):
        found += [(a, "file", None) for a in plain]
    elif name in ("cp", "mv", "copy-item", "move-item", "copy", "move", "cpi", "mi", "cpp"):
        dest = None
        for j, a in enumerate(args):
            if a.lower() == "-destination" and j + 1 < len(args):
                dest = args[j + 1]
        if dest is None and len(plain) >= 2:
            dest = plain[-1]
        if dest is not None and plain:
            found.append((dest, "dest", plain[0]))
    elif name in ("out-file", "set-content", "add-content", "new-item", "export-csv", "export-clixml", "ni", "sc", "ac"):
        low = [a.lower() for a in args]
        if name in ("new-item", "ni") and any(v in ("directory", "dir") for v in low):
            return found
        tgt = None
        for j, a in enumerate(low):
            if a in ("-filepath", "-path", "-literalpath") and j + 1 < len(args):
                tgt = args[j + 1]
        if tgt is None:
            skip_next = False
            for a in args:
                if skip_next:
                    skip_next = False
                    continue
                if a.startswith("-"):
                    skip_next = a.lower() in ("-encoding", "-itemtype", "-value", "-width", "-name", "-type")
                    continue
                tgt = a
                break
        if tgt is not None:
            found.append((tgt, "file", None))
    elif name in ("invoke-webrequest", "iwr", "invoke-restmethod", "irm"):
        for j, a in enumerate(args):
            if a.lower() == "-outfile" and j + 1 < len(args):
                found.append((args[j + 1], "file", None))
    return found


def check_root_shell(cmd: str, cwd_raw: str):
    """셸 명령이 IRIS 루트 바로 밑에 새 파일을 만들면 차단 사유."""
    cur = norm_rel(cwd_raw) if cwd_raw else None
    if cwd_raw and cur is None:
        cur = OUT
    text, bodies = split_heredocs(cmd)
    text = re.sub(r"[\\`]\r?\n", " ", text)  # 줄 이어쓰기(bash \ · PowerShell `)를 한 줄로
    masked = mask_quotes(text)
    starts = [0] + [m.end() for m in SEP.finditer(masked)]
    ends = [m.start() for m in SEP.finditer(masked)] + [len(text)]
    for s, e in zip(starts, ends):
        seg, mseg = text[s:e], masked[s:e]
        tokens = TOKEN.findall(seg)
        name, ci = cmd_name(tokens)
        if name in CD_CMDS:
            rest = [t for t in tokens[ci + 1:] if not t.startswith(("-", "/d", "/D"))]
            if not rest:
                cur = OUT
            else:
                tgt = expand_home(strip_q(rest[0]))
                segs = norm_rel(tgt)
                if segs is not None:
                    cur = segs
                elif re.match(r"^[A-Za-z]:[\\/]|^/", tgt):
                    cur = OUT
                elif tgt.startswith(("$", "~", "-", "%")):
                    cur = None
                else:
                    cur = resolve(tgt, cur) if cur not in (None, OUT) else cur
            continue
        cands = seg_targets(seg, mseg, tokens, name, ci)
        if name in INTERP:
            code = seg
            for k in re.findall(r"__HEREDOC_(\d+)__", seg):
                code += "\n" + bodies[int(k)]
            for pat in CODE_WRITES:
                for m in pat.finditer(code):
                    cands.append((m.group(2), "file", None))
        for tgt, kind, src in cands:
            if kind == "remote":
                if cur == []:
                    return root_file_block("(원격 파일명 그대로 저장)", seg.strip())
                continue
            r = resolve(tgt, cur)
            if r is None:
                continue
            if kind == "dest" and r == []:
                base = re.split(r"[\\/]", strip_q(src).rstrip("\\/"))[-1]
                why = root_file_block(base, seg.strip())
            elif len(r) == 1:
                why = root_file_block(r[0], seg.strip())
            else:
                why = None
            if why:
                return why
    return None


def norm_rel(raw: str):
    r"""`<드라이브>:\IRIS\a\b` 또는 `/c/IRIS/a/b` → ['a', 'b'] (IRIS 상대 조각). IRIS 밖이면 None."""
    s = raw.replace("/", "\\")
    s = re.sub(r"\\{2,}", "\\\\", s)
    m = re.match(r"(?i)^(?:[A-Za-z]:\\IRIS|\\[A-Za-z]\\IRIS)(?:\\(.*))?$", s)
    if not m:
        return None if WINDOWS else norm_rel_posix(raw)
    rest = m.group(1) or ""
    return [seg.strip() for seg in rest.split("\\") if seg.strip()]


def norm_rel_posix(raw: str):
    """macOS: `<루트>/a/b`(·`~/IRIS/a/b`) → ['a', 'b']. 루트 밖이면 None."""
    s = re.sub(r"/{2,}", "/", expand_home(raw.strip()))
    if s != POSIX_ROOT and not s.startswith(POSIX_ROOT + "/"):
        return None
    return [seg.strip() for seg in s[len(POSIX_ROOT):].split("/") if seg.strip()]


def deny(reason: str):
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    # 윈도 콘솔(cp949)에서 한글이 깨지지 않도록: UTF-8로 재설정하고 JSON은 ASCII 이스케이프로 내보낸다.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.stdout.write(json.dumps(out, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def check(tool: str, segs, is_edit: bool, has_create_verb: bool, shown: str):
    if not segs:
        return None
    if segs[0].lower() in EXEMPT_TOP:
        return None
    # A. 한자·가나
    for seg in segs:
        if CJK.search(seg):
            return (
                "BLOCKED - IRIS 경로 실존 가드: 경로에 한자·가나(일본어/중국어 문자)가 들어 있습니다: "
                f"'{shown}'. IRIS 폴더명은 한글·영어만 씁니다. 이 경로는 실존하는 한글 경로를 잘못 번역해 "
                "지어낸 것일 가능성이 매우 높습니다. 실제 디렉터리 목록(ls)에서 정확한 이름을 복사해 다시 시도하세요. "
                "(BLOCKED: kanji/kana in an IRIS path - the folder name was almost certainly hallucinated. "
                "Copy the exact existing Korean folder name from a directory listing.)"
            )
    dir_segs = segs[:-1] if is_edit else segs
    if len(segs) < 2:
        return None
    top = segs[0]
    top_exists = os.path.isdir(os.path.join(IRIS_ROOT, top))
    # B. 최상위 폴더 미실존
    if not top_exists and (is_edit or has_create_verb):
        return (
            f"BLOCKED - IRIS 경로 실존 가드: {os.path.join(IRIS_ROOT, top)} 은(는) 존재하지 않는 최상위 폴더인데 그 밑에 쓰려 합니다: "
            f"'{shown}'. 폴더명을 기억으로 타이핑하지 말고 `ls {IRIS_ROOT}`로 실제 이름을 복사해 다시 시도하세요. "
            "정말 새 최상위 폴더가 필요하면 먼저 mkdir로 그 폴더 하나만 명시적으로 만든 뒤 쓰세요. "
            f"(BLOCKED: writing under a non-existent top-level IRIS folder. Copy the exact existing name from `ls {IRIS_ROOT}`.)"
        )
    # C. Write/Edit가 없는 R/D/P/S/T 코드 폴더를 암묵 생성
    if is_edit and top_exists:
        cur = IRIS_ROOT
        for seg in dir_segs:
            cur = os.path.join(cur, seg)
            if not os.path.isdir(cur):
                if CODE_DIR.match(seg):
                    return (
                        f"BLOCKED - IRIS 경로 실존 가드: 존재하지 않는 위계 폴더 '{seg}'를 Write/Edit가 암묵적으로 만들려 합니다: "
                        f"'{shown}'. 가장 가까운 실존 조상은 '{os.path.dirname(cur)}' 입니다. 이름 오타면 실제 목록에서 복사하고, "
                        "정말 새 R/D/P/S/T 폴더가 필요하면 먼저 mkdir로 명시적으로 만든 뒤(AGENTS.md 동반) 쓰세요. "
                        "(BLOCKED: Write would implicitly create a non-existent R/D/P/S/T folder. mkdir it explicitly first.)"
                    )
                break
    return None


def main():
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        j = json.loads(raw)
    except Exception:
        return
    tool = j.get("tool_name") or ""
    inp = j.get("tool_input") or {}
    if tool in EDIT_TOOLS:
        p = inp.get("file_path") or inp.get("notebook_path") or ""
        segs = norm_rel(p)
        if segs is None:
            return
        r = check(tool, segs, True, False, p)
        # D. 루트 낱개 파일(Edit/MultiEdit는 없는 파일을 만들 수 없으므로 Write·NotebookEdit만)
        if not r and len(segs) == 1 and tool in ("Write", "NotebookEdit"):
            r = root_file_block(segs[0], p)
        if r:
            deny(r)
        return
    if tool in SHELL_TOOLS:
        cmd = inp.get("command") or ""
        cwd_raw = j.get("cwd") or ""
        if "IRIS" not in cmd.upper() and norm_rel(cwd_raw) != []:
            return
        r = check_root_shell(cmd, cwd_raw)
        if r:
            deny(r)
            return
        has_verb = bool(CREATE_VERBS.search(cmd))
        matches = list(PATH_IN_TEXT.finditer(cmd)) + ([] if WINDOWS else list(PATH_IN_TEXT_POSIX.finditer(cmd)))
        for m in matches:
            whole = m.group(0)
            segs = norm_rel(whole)
            if not segs:
                continue
            r = check(tool, segs, False, has_verb, whole.strip())
            if r:
                deny(r)
                return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
