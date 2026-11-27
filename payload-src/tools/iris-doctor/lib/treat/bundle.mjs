// IRIS Doctor — 치료 프로세스 묶음. 치료 에이전트와 그것이 띄운 모든 프로세스가 **Doctor 가 끝나면 함께 끝나게** 한다.
// 방법: 지킴이(job-keeper.ps1)가 윈도우의 작업 묶음(Job, "묶음이 닫히면 안의 것을 모두 끝냄")을 만들어 자기 자신을 넣은 뒤 에이전트를 띄운다
//       — 에이전트는 첫 순간부터 묶음 안이다(먼저 띄우고 나중에 넣는 틈이 없다). 지킴이는 Doctor 프로세스가 사라지면 스스로 끝나고, 그러면 묶음이 닫힌다.
// 묶음을 못 만드는 PC(PowerShell 이 막혔거나 제한 방식)에서는: 에이전트 치료를 막지 않되, 가드가 "뒤에 남는 실행"을 막고(policy.noBackground)
//       Doctor 가 시간 제한 · 끝날 때 그 프로세스 가계도를 번호로 끝낸다. 그래도 자손이 남을 수 있다는 것을 화면에 알린다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KEEPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'job-keeper.ps1');
export const JOB_FAILED = 97; // 지킴이가 묶음을 만들지 못해 에이전트를 띄우지 않았다
const psExe = (env) => path.join(env.SystemRoot || process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * spawn 과 같은 모양의 함수를 돌려준다: (exe, args, opts) → 지킴이를 거쳐 띄운 child.
 * runDir = 이 실행의 폴더(인자 목록 파일 · 묶음 표시 파일을 둔다). 호출마다 번호가 다른 파일을 쓴다.
 */
export function bundledSpawn({ runDir, parentPid = process.pid, spawnFn = spawn, keeper = KEEPER } = {}) {
  let n = 0;
  return (exe, args, opts = {}) => {
    const id = `${Date.now()}-${++n}`;
    const argsFile = path.join(runDir, `args-${id}.json`), flag = path.join(runDir, `job-${id}.flag`);
    fs.writeFileSync(argsFile, JSON.stringify(args.map(String)), 'utf8');
    const env = { ...(opts.env || {}), IRIS_DOCTOR_JOB_EXE: exe, IRIS_DOCTOR_JOB_ARGS: argsFile, IRIS_DOCTOR_JOB_CWD: opts.cwd || '', IRIS_DOCTOR_JOB_FLAG: flag, IRIS_DOCTOR_JOB_PARENT: String(parentPid) };
    const child = spawnFn(psExe(env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', keeper], { ...opts, env, shell: false });
    child.jobFlag = flag;
    child.on?.('close', () => { try { fs.rmSync(argsFile, { force: true }); } catch {} });
    return child;
  };
}

/** 이 PC 에서 묶음을 만들 수 있는가(아무 일도 하지 않는 프로그램을 한 번 띄워 본다). → true | false */
export function canBundle({ runDir, env = process.env, spawnFn = spawn, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    let child;
    const t = setTimeout(() => { try { child?.kill(); } catch {} fin(false); }, timeoutMs);
    try {
      const sys = env.SystemRoot || process.env.SystemRoot || 'C:\\Windows';
      child = bundledSpawn({ runDir, spawnFn })(path.join(sys, 'System32', 'cmd.exe'), ['/d', '/c', 'exit', '0'], { env: { SystemRoot: sys, windir: sys, TEMP: env.TEMP || '', TMP: env.TMP || '', PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: `${path.join(sys, 'System32')};${sys}` }, stdio: 'ignore', windowsHide: true });
      child.on('error', () => fin(false));
      child.on('close', (code) => { const ok = code === 0 && fs.existsSync(child.jobFlag); try { fs.rmSync(child.jobFlag, { force: true }); } catch {} fin(ok); });
    } catch { fin(false); }
  });
}
