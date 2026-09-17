// 설치 폴더의 **우리 프로그램**이 아직 돌고 있는가 (2026-09-17 실제 사용자 실측, 2.0.4).
//
// 2.0.0 이 멈춘 PC 에 2.0.4 를 다시 깔자 부품 풀기가 `_agent\shared\tools\teamclaude-dash`
// 를 `.prev` 로 옮기다 EBUSY 로 섰다 — 이전 설치가 띄운 한도 화면 서버(동봉 node)가 그
// 폴더를 붙잡고 있었다. 「다시 시도」로는 풀리지 않는다(붙잡은 것이 그대로니까).
//
// 여기서 찾는 것은 오직 **실행 파일이나 명령줄이 `<root>\_agent\shared\tools\` 아래인
// 프로세스**뿐이다 — 동봉 런타임으로 도는 것은 전부 이 설치기가 놓은 우리 프로그램이다
// (IRIS 창·중계기·한도 화면·문서 MCP). 그 밖의 프로세스는 이름이 node.exe 여도 절대
// 건드리지 않는다(사용자의 다른 프로그램일 수 있다). 멈출 때도 이름이 아니라 **PID 하나씩**.
// 설치기 자신(%LOCALAPPDATA% 의 node)은 그 폴더 밖이라 목록에 들지 않는다.
import path from 'node:path';
import { run as defaultRun } from '../../lib/run.mjs';

const PS = 'powershell.exe';
const LIST_PS = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';

export function toolsDirOf(root) {
  return path.join(root, '_agent', 'shared', 'tools') + path.sep;
}

function under(value, prefix) {
  const v = String(value ?? '').toLowerCase();
  return v.length > 0 && v.includes(prefix.toLowerCase());
}

/** `<root>\_agent\shared\tools\` 에서 도는 프로세스 목록. 실패하면 빈 목록(막지 않는다). */
export async function listHolders(root, { run = defaultRun, selfPid = process.pid } = {}) {
  if (!root) return [];
  const prefix = toolsDirOf(root);
  let out = '';
  try {
    const r = await run(PS, ['-NoProfile', '-NonInteractive', '-Command', LIST_PS], { timeoutMs: 30000 });
    if (r.code !== 0) return [];
    out = r.out ?? '';
  } catch {
    return [];
  }
  let rows;
  try {
    const parsed = JSON.parse(out.trim());
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
  return rows
    .filter((p) => p && Number(p.ProcessId) > 0 && Number(p.ProcessId) !== selfPid)
    .filter((p) => under(p.ExecutablePath, prefix) || under(p.CommandLine, prefix))
    .map((p) => ({
      pid: Number(p.ProcessId),
      name: String(p.Name ?? ''),
      exe: p.ExecutablePath ? String(p.ExecutablePath) : null,
      // 사람이 "무엇인지" 알아보게 명령줄에서 우리 폴더 뒤의 꼬리만 남긴다(한도 화면·중계기·IRIS 창).
      what: describe(p.CommandLine, prefix),
    }));
}

function describe(cmd, prefix) {
  const s = String(cmd ?? '');
  const i = s.toLowerCase().lastIndexOf(prefix.toLowerCase());
  if (i < 0) return null;
  const tail = s.slice(i + prefix.length).replace(/^["']+/, '').split(/["'\s]/)[0];
  return tail || null;
}

/** 목록의 프로세스를 PID 로 하나씩 멈춘다. `<root>` 아래에서 돈다는 것을 여기서 **다시** 확인한다. */
export async function stopHolders(root, holders, { run = defaultRun, list = listHolders } = {}) {
  const live = await list(root, { run });
  const allowed = new Set(live.map((h) => h.pid));
  const results = [];
  for (const h of holders ?? []) {
    const pid = Number(h?.pid);
    if (!pid || !allowed.has(pid)) { results.push({ pid, stopped: false, reason: 'not under tools dir any more' }); continue; }
    try {
      const r = await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10000 });
      results.push({ pid, name: h.name, what: h.what, stopped: r.code === 0, detail: (r.out || r.err || '').trim().slice(0, 200) });
    } catch (err) {
      results.push({ pid, name: h.name, what: h.what, stopped: false, detail: String(err?.message ?? err) });
    }
  }
  return results;
}

/** 화면 한 줄용: `node.exe(PID 1234, teamclaude-dash\server.mjs)` */
export function holdersText(holders) {
  return (holders ?? []).map((h) => `${h.name || '?'}(PID ${h.pid}${h.what ? `, ${h.what}` : ''})`).join(' · ');
}
