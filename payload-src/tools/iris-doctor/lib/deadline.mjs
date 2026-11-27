// 일을 따로 떨어진 프로세스에서 돌리고, 정한 시간 안에 안 끝나면 그 프로세스를 끝낸다.
// 까닭: 검사 안의 파일 읽기는 동기식이라, 연결이 끊긴 공유 폴더 같은 데서 멎으면 같은 프로세스의 제한 시간 장치도 함께 멎는다.
// 일을 자식 프로세스에 맡기면 본 프로세스에는 멎을 것이 없다 — 시간이 지나면 자식을 끝내고(또는 버려 두고) 스스로는 반드시 끝난다.
// (같은 프로세스의 일꾼 스레드는 운영체제 읽기에서 멎으면 끝내기 요청이 듣지 않을 수 있어 쓰지 않는다 — 2026-11-26 코덱스 재검토.)
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const MAX_OUT = 8 * 1024 * 1024;

/**
 * script 를 node 로 띄워 표준 출력의 JSON 한 덩어리를 받는다. data 는 인자 하나(base64 JSON)로 넘긴다.
 * → { ok:true, value } | { ok:false, why: 'timeout' | 'exit' | 'parse' | 'spawn' }
 */
export function runInChild(script, data, timeoutMs, { execPath = process.execPath, onChild = null } = {}) {
  return new Promise((resolve) => {
    let done = false, size = 0, child = null;
    const chunks = [];
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { child?.kill(); } catch {} try { child?.unref(); child?.stdout?.destroy(); } catch {} finish({ ok: false, why: 'timeout' }); }, timeoutMs);
    try {
      const arg = Buffer.from(JSON.stringify(data ?? {}), 'utf8').toString('base64url');
      child = spawn(execPath, [script, arg], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
      try { onChild?.(child); } catch {} // 부른 쪽이 먼저 끝날 때 이 자식을 끝낼 수 있게 알려 준다(제한 시간 장치는 부른 쪽이 살아 있을 때만 돈다)
      // 바이트를 모았다가 한 번에 글로 바꾼다(조각마다 바꾸면 한글 한 글자가 두 조각에 걸칠 때 깨진다)
      child.stdout.on('data', (d) => { if (size < MAX_OUT) { chunks.push(d); size += d.length; } });
      child.on('error', () => finish({ ok: false, why: 'spawn' }));
      child.on('close', (code, signal) => {
        if (code !== 0 || signal) return finish({ ok: false, why: 'exit' }); // 오류로 죽었으면 낸 글이 있어도 믿지 않는다
        const out = Buffer.concat(chunks).toString('utf8');
        const i = out.indexOf('{');
        if (i < 0) return finish({ ok: false, why: 'exit' }); // 아무것도 내지 않고 끝남
        try { finish({ ok: true, value: JSON.parse(out.slice(i)) }); } catch { finish({ ok: false, why: 'parse' }); }
      });
    } catch { finish({ ok: false, why: 'spawn' }); }
  });
}

/**
 * 글을 표준 출력에 내고 끝난다. 받는 쪽이 멈춰 글이 다 나가지 않아도 graceMs 뒤에는 끝난다(출력을 기다리다 영영 멎지 않게).
 * 한 번에 내지 않고 작은 조각으로 내어, 받는 쪽이 멈췄을 때도 제한 시간 장치가 돌 틈을 준다.
 */
export function writeAndExit(text, code, { graceMs = 5000, stream = process.stdout, exit = (c) => process.exit(c), watchdog = stream === process.stdout } = {}) {
  const buf = Buffer.from(String(text), 'utf8');
  // 윈도우의 출력 통로는 쓰기가 동기식이라, 받는 쪽이 읽지 않으면 이 줄기가 쓰기에서 멎어 아래 타이머도 돌지 못한다(2026-11-26 실측).
  // 그래서 따로 도는 감시 줄기를 하나 둔다 — 정한 시간이 지나면 이 프로세스를 통째로 끝낸다(그때의 종료 코드는 운영체제 값).
  if (watchdog) {
    try {
      const w = new Worker("const { workerData } = require('node:worker_threads'); setTimeout(() => { try { process.kill(workerData.pid); } catch {} }, workerData.ms);", { eval: true, workerData: { pid: process.pid, ms: graceMs + 500 } });
      w.unref();
    } catch { /* 감시 줄기를 못 띄워도 아래 타이머는 남는다 */ }
  }
  let at = 0, left = false, timer = null;
  const leave = () => { if (left) return; left = true; clearTimeout(timer); exit(code); }; // 끝내기는 한 번만(시간이 다 돼 끝낸 뒤 늦은 알림이 와도 다시 부르지 않는다)
  timer = setTimeout(leave, graceMs);
  const step = () => {
    if (at >= buf.length) return leave(); // 마지막 조각의 "다 나갔다"는 알림까지 받은 뒤에만 끝낸다
    const part = buf.subarray(at, at + 16 * 1024); at += part.length;
    // write() 가 true 를 돌려줘도 "다 나갔다"는 뜻이 아니다 — 조각마다 완료 알림을 받고 다음으로 간다
    try { stream.write(part, () => step()); } catch { leave(); }
  };
  step();
}

/** 자식 쪽에서: 넘겨받은 값을 꺼낸다. */
export function childData(argv = process.argv) {
  try { return JSON.parse(Buffer.from(String(argv[2] || ''), 'base64url').toString('utf8')) || {}; } catch { return {}; }
}
