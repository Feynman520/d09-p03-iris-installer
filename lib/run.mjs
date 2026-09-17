import { spawn } from 'node:child_process';

export function isBatch(exe) {
  return /\.(cmd|bat)$/i.test(String(exe));
}

/**
 * quoteArg — 배치 파일에 인자 하나를 온전히 넘기기 위한 따옴표.
 *
 * 배치 파일의 `%~1` 은 C 런타임이 아니라 **바깥 따옴표 한 쌍만 벗기는** 단순한
 * 규칙이라, `\"` 같은 C 식 이스케이프는 값에 그대로 남아 망가진다(2026-09-15 실측).
 * 그래서 값을 손대지 않고 통째로 따옴표로 감싼다 — 공백·`&`·`|`·`>`·`^`·끝
 * 백슬래시·짝 맞는 따옴표가 모두 그대로 전달된다.
 *
 * 다만 값 안 따옴표 개수가 **홀수**면 cmd 의 따옴표 상태가 다음 인자로 새어
 * 리다이렉션(`>`)까지 살아난다. 표현할 안전한 방법이 없으므로 여기서 멈춘다.
 */
export function quoteArg(value) {
  const s = String(value);
  if (((s.match(/"/g) ?? []).length % 2) !== 0) {
    throw new Error(`배치 파일에 넘길 수 없는 인자입니다(따옴표 개수가 홀수): ${s}`);
  }
  return `"${s}"`;
}

/**
 * batchLine — `.cmd`·`.bat` 을 `cmd.exe /d /s /c` 한 줄로 만든다.
 *
 * 왜: 윈도의 Node 는 보안 수정(CVE-2024-27980) 이후 배치 파일을 셸 없이 띄우지
 * 못하고 `spawn EINVAL` 로 즉사한다(2026-09-15 T18 통합 실기에서 실측). 그렇다고
 * `shell: true` 를 쓰면 Node 가 인자를 다시 따옴표로 감싸며 망가뜨린다.
 * 그래서 명령줄을 직접 만들어 `windowsVerbatimArguments` 로 넘긴다.
 *
 * `/s` 는 "첫 글자와 끝 글자가 따옴표면 그 한 쌍만 벗긴다"는 규칙이라,
 * 바깥에 한 겹을 더 씌워야 안쪽 따옴표가 그대로 살아남는다:
 *   `cmd /d /s /c ""C:\경로 있는\x.cmd" "인자 1""`
 */
export function batchLine(exe, args = []) {
  const inner = args.length ? `${quoteArg(exe)} ${args.map(quoteArg).join(' ')}` : quoteArg(exe);
  return `"${inner}"`;
}

export function run(exe, args, { cwd, env = process.env, timeoutMs = 600000, stdin = 'ignore' } = {}) {
  return new Promise((resolve) => {
    let file = exe;
    let argv = args;
    const opts = { cwd, env, windowsHide: true, stdio: [stdin, 'pipe', 'pipe'] };
    if (isBatch(exe)) {
      try {
        argv = ['/d', '/s', '/c', batchLine(exe, args ?? [])];
      } catch (e) {
        resolve({ code: -1, out: '', err: e.message, timedOut: false });
        return;
      }
      file = process.env.ComSpec || 'cmd.exe';
      opts.windowsVerbatimArguments = true;
    }
    // `timedOut` (Task 25) is the single source of truth for "this result is
    // a kill, not a real exit code" -- callers that need to tell a slow probe
    // apart from a probe that genuinely answered "no"/"bad value" (e.g.
    // installer/lib/precheck.mjs's merged PowerShell probe) read this instead
    // of guessing from `code` (a killed process's exit code is platform-
    // dependent and not a reliable timeout signal on its own).
    let timedOut = false;
    // 2026-09-17 VM S01 실측: Node 는 ENOENT/EACCES 같은 몇몇 오류만 'error' 이벤트로 주고,
    // 그 밖의 spawn 오류(예: Defender 가 갓 받은 exe 를 훑는 동안의 **EBUSY**)는 spawn() 이
    // **동기적으로 던진다**. 그러면 이 Promise 가 거부돼 호출자의 재시도 논리가 한 번도
    // 돌지 못한 채 "spawn EBUSY" 로 끝난다(2.0.1 Claude 출처 1 이 그렇게 넘어졌다).
    // 던져진 오류도 'error' 이벤트와 같은 모양으로 돌려준다.
    let c;
    try {
      c = spawn(file, argv, opts);
    } catch (e) {
      resolve({ code: -1, out: '', err: e?.message ?? String(e), timedOut: false });
      return;
    }
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { timedOut = true; c.kill(); }, timeoutMs);   // 내가 띄운 PID 하나만 — 이름 기반 일괄 종료 금지
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim(), timedOut }); });
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: e.message, timedOut }); });
  });
}
