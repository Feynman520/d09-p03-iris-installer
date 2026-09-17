// TeamClaude proxy (127.0.0.1:3456) liveness + start, modeled on the shipped
// dashboard/Face helper (_build/stage/dir/dash/ensure-proxy.mjs): probe first,
// and only run the manage script's `start` action when nothing answers.
// NEVER kill or restart an already-running proxy -- an already-alive proxy is
// left completely untouched (task-13-brief.md, binding rehearsal rule).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { resolveTeamclaudeConfigPath } from './login.mjs';

const DEFAULT_PORT = 3456;

// Any HTTP response counts as "alive" -- this deliberately probes the bare
// root (not /teamclaude/status specifically) per the brief's rehearsal rule
// ("probing http://127.0.0.1:3456/ -- any HTTP response = alive"), so the
// check works even before any TeamClaude-specific route is known.
export function defaultProbe(port, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export function defaultRunManage(managePs1, args, { timeoutMs = 90000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', managePs1, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: e.message }); });
  });
}

export function manageScriptPath(root) {
  return path.join(root, '_agent', 'shared', 'tools', 'teamclaude', 'teamclaude-manage.ps1');
}

export function teamclaudeEntryPath(root) {
  return path.join(
    root, '_agent', 'shared', 'tools', 'teamclaude',
    'node_modules', '@karpeleslab', 'teamclaude', 'src', 'index.js',
  );
}

/**
 * Ensure the TeamClaude proxy is reachable, starting it only if nothing
 * answers on `port` yet.
 *
 * @returns {Promise<{alive: boolean, started: boolean}>}
 *   alive   = true if the proxy answers by the time this returns
 *   started = true only if this call actually ran the manage script's
 *             `start` action (never true when the proxy was already alive)
 */
export async function ensureProxy({
  root,
  nodeDir,
  port = DEFAULT_PORT,
  teamclaudeConfigPath,
  probe = defaultProbe,
  runManage = defaultRunManage,
} = {}) {
  if (await probe(port)) {
    return { alive: true, started: false };
  }

  const managePs1 = manageScriptPath(root);
  const nodeExe = path.join(nodeDir, 'node.exe');
  const entryPath = teamclaudeEntryPath(root);
  // I2: the manage script resolves its config from $env:TEAMCLAUDE_CONFIG
  // (patches/teamclaude/teamclaude-manage.ps1 line 3) and falls back to
  // %USERPROFILE%\.config otherwise. The installer's own process does not
  // carry the user variable install() just wrote, so pass it explicitly --
  // otherwise the relay this starts would serve the wrong account file.
  const configPath = teamclaudeConfigPath ?? resolveTeamclaudeConfigPath({ root });

  let manage = null;
  try {
    manage = await runManage(managePs1, ['-Action', 'start', '-NodePath', nodeExe, '-EntryPath', entryPath], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    });
  } catch (err) {
    manage = { code: -1, out: '', err: String(err?.message ?? err) };
  }

  const alive = await probe(port);
  // 2026-09-17 실제 사용자 실측(2.0.5): 「계정 연결 확인 — 아직 연결되지 않았습니다」만 보이고
  // 왜 못 띄웠는지(스크립트 없음·node 없음·포트 점유·시작 스크립트 오류)가 어디에도 없었다.
  // 살아 있지 않으면 근거를 함께 돌려준다 — 화면 문장과 로그가 이것을 쓴다.
  const tail = (s) => String(s ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 300);
  const detail = alive ? null : {
    port,
    manageScript: managePs1,
    manageScriptExists: fs.existsSync(managePs1),
    nodeExeExists: fs.existsSync(nodeExe),
    entryExists: fs.existsSync(entryPath),
    manageExit: manage?.code ?? null,
    manageOut: tail(manage?.out),
    manageErr: tail(manage?.err),
  };
  return { alive, started: true, ...(detail ? { detail } : {}) };
}
