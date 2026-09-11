import { spawn } from 'node:child_process';

export function run(exe, args, { cwd, env = process.env, timeoutMs = 600000, stdin = 'ignore' } = {}) {
  return new Promise((resolve) => {
    const c = spawn(exe, args, { cwd, env, windowsHide: true, stdio: [stdin, 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => c.kill(), timeoutMs);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: e.message }); });
  });
}
