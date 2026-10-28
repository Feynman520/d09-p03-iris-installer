// macOS 준비 검사 (docs/설계-macOS.md 3절).
//
// precheck.mjs 의 Windows 검사와 **같은 모양**의 결과를 돌려준다:
//   { blockers, warnings, info, recorded, os, arch, disk, net, browser, allOk, canProceedOffline }
// 화면(ui/index.html renderPrecheck)·영수증·설치 보고는 이 모양만 보고 운영체제를 모른다.
//
// 규칙도 Windows 와 같다(설계-v2 4-2, Task 25·26):
//   - 값을 **읽었는데 나쁘면** 막는다.
//   - 값을 **못 읽었으면** 경고만 한다("확인 못 함"은 "나쁨"이 아니다).
//   - `recorded` 에는 사용자 이름·경로가 들어가지 않는다(오류는 code 만).
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../lib/run.mjs';
import { checkNet, checkPorts, checkExisting } from './precheck.mjs';
import { installerWorkDir } from './platform.mjs';

export const MIN_MACOS = [13, 5]; // Node 24 의 최저 지원 판(D-M02)
const MIN_DISK_GB = 3; // Windows 와 같다(설계-v2 4-2)

/** `sw_vers -productVersion` 의 "27.2" / "13.5.1" → [27, 2] */
export function parseMacVersion(text) {
  const m = /^(\d+)(?:\.(\d+))?/.exec(String(text ?? '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0)];
}

export async function checkMacOs(timeoutMs, { runFn = run } = {}) {
  try {
    const r = await runFn('/usr/bin/sw_vers', ['-productVersion'], { timeoutMs });
    const v = r?.code === 0 ? parseMacVersion(r.out) : null;
    if (!v) return { ok: false, version: null, unknown: true, detail: r?.timedOut ? 'timed-out' : 'no-value' };
    const ok = v[0] > MIN_MACOS[0] || (v[0] === MIN_MACOS[0] && v[1] >= MIN_MACOS[1]);
    return { ok, version: r.out.trim() };
  } catch (e) {
    return { ok: false, version: null, unknown: true, detail: e?.code || 'spawn-failed' };
  }
}

// 동봉 node 는 arm64 판이라 여기까지 왔다면 대개 arm64 다. 그래도 x64 node(Rosetta)로
// 띄운 경우를 위해 하드웨어에 직접 묻는다: Apple Silicon 이면 Rosetta 아래에서도
// hw.optional.arm64 = 1 이다. Intel Mac 에는 이 값이 없거나 0 이다.
export async function checkMacArch(timeoutMs, { runFn = run, arch = process.arch } = {}) {
  if (arch === 'arm64') return { ok: true, value: 'arm64' };
  try {
    const r = await runFn('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { timeoutMs });
    if (r?.code === 0 && r.out.trim() === '1') return { ok: true, value: 'arm64', rosetta: true };
    if (r?.code === 0 || /unknown oid/i.test(r?.err ?? '')) return { ok: false, value: 'x64' };
    return { ok: false, value: arch, unknown: true, detail: 'no-value' };
  } catch (e) {
    return { ok: false, value: arch, unknown: true, detail: e?.code || 'spawn-failed' };
  }
}

// 쓰기 시험은 설치 폴더(아직 정해지기 전)가 아니라 설치기 작업 폴더에서 한다 — 같은
// 홈 볼륨이므로 "이 계정이 홈에 쓸 수 있는가"에 답한다. 오류는 code 만 남긴다.
export function checkHome({ fsFn = nodeFs, homedir = os.homedir(), workDir = null, envFn = process.env } = {}) {
  const dir = workDir ?? installerWorkDir({ platform: 'darwin', homedir, env: envFn });
  const probe = path.join(dir, `.precheck-write-${process.pid}-${Date.now()}.tmp`);
  let writable = { ok: true };
  try {
    fsFn.mkdirSync(dir, { recursive: true });
    fsFn.writeFileSync(probe, 'ok');
    fsFn.unlinkSync(probe);
  } catch (e) {
    writable = { ok: false, detail: e?.code || 'write-failed' };
  }
  let disk;
  try {
    const s = fsFn.statfsSync(homedir);
    const bytes = Number(s.bavail) * Number(s.bsize);
    if (!Number.isFinite(bytes)) throw Object.assign(new Error('no-value'), { code: 'no-value' });
    const freeGB = bytes / 1024 ** 3;
    disk = { ok: freeGB >= MIN_DISK_GB, freeGB };
  } catch (e) {
    disk = { ok: false, freeGB: 0, unknown: true, detail: e?.code || 'no-value' };
  }
  return { writable, disk };
}

// 브라우저 조작(Playwright MCP) 채널 — Chrome 먼저, 없으면 Edge(D-M17). 둘 다 없으면 ⑦ 단계가 Chrome for Testing 을
// 받는다(online.mjs installPlaywrightBrowser, 2026-10-28 개정) — 이 검사 자체는 아무것도 받지 않는다.
// 결과는 Windows 의 `edge` 칸과 같은 모양(present·path)에 `channel` 을 더한다 —
// 뒤 단계(adapters·checks)가 `recorded.edge.present` 를 읽기 때문이다.
export function checkAutomationBrowser({ existsFn = nodeFs.existsSync, homedir = os.homedir() } = {}) {
  const candidates = [
    ['chrome', '/Applications/Google Chrome.app'],
    ['chrome', path.join(homedir, 'Applications', 'Google Chrome.app')],
    ['msedge', '/Applications/Microsoft Edge.app'],
    ['msedge', path.join(homedir, 'Applications', 'Microsoft Edge.app')],
  ];
  for (const [channel, appPath] of candidates) {
    try {
      if (existsFn(appPath)) return { ok: true, present: true, channel, path: appPath.startsWith(homedir) ? `~${appPath.slice(homedir.length)}` : appPath };
    } catch { /* 다음 후보 */ }
  }
  return { ok: true, present: false, channel: null, path: null };
}

// 기록만 한다(막지도 경고하지도 않는다) — Windows 의 SAC 칸 자리.
export async function checkGatekeeper(timeoutMs, { runFn = run } = {}) {
  try {
    const r = await runFn('/usr/sbin/spctl', ['--status'], { timeoutMs });
    const text = `${r?.out ?? ''} ${r?.err ?? ''}`;
    if (/assessments enabled/i.test(text)) return { ok: true, enabled: true };
    if (/assessments disabled/i.test(text)) return { ok: true, enabled: false };
    return { ok: true, enabled: null, detail: 'no-value' };
  } catch (e) {
    return { ok: true, enabled: null, detail: e?.code || 'spawn-failed' };
  }
}

function pushBlocker(list, id, message) { list.push({ id, message }); }
function pushWarning(list, id, message) { list.push({ id, message }); }

export async function precheckDarwin({ timeoutMs = 15000, deps = {} } = {}) {
  const homedir = deps.homedir ?? os.homedir();
  const [osResult, arch, gatekeeper] = await Promise.all([
    checkMacOs(timeoutMs, deps),
    checkMacArch(timeoutMs, deps),
    checkGatekeeper(timeoutMs, deps),
  ]);
  const home = checkHome({ fsFn: deps.fsFn, homedir, workDir: deps.workDir, envFn: deps.envFn });
  const disk = home.disk;
  const [net_, ports] = await Promise.all([
    checkNet(timeoutMs, deps),
    checkPorts(timeoutMs, deps),
  ]);
  const edge = checkAutomationBrowser({ existsFn: deps.existsFn, homedir });
  const existing = checkExisting({ ...deps, platform: 'darwin', homedir });
  // macOS 는 `open` 이 늘 기본 브라우저를 연다 — Windows 의 연결 프로그램 검사에 해당하는 일이 없다.
  const browser = { ok: true, via: 'open' };

  const blockers = [];
  const warnings = [];

  if (osResult.unknown) {
    pushWarning(warnings, 'macos-unknown', 'macOS 판을 확인하지 못했습니다. 설치는 계속할 수 있지만 문제가 생기면 「다시 확인」을 눌러 주세요.');
  } else if (!osResult.ok) {
    pushBlocker(blockers, 'os', `macOS ${MIN_MACOS.join('.')} 이상이 필요합니다. 이 Mac은 지원 범위 밖입니다.`);
  }
  if (arch.unknown) {
    pushWarning(warnings, 'arch-unknown', 'CPU 종류를 확인하지 못했습니다. 설치는 계속할 수 있지만 문제가 생기면 「다시 확인」을 눌러 주세요.');
  } else if (!arch.ok) {
    pushBlocker(blockers, 'arch', '지원하지 않는 CPU입니다. Apple Silicon(M1 이후) Mac에서만 설치할 수 있습니다.');
  }
  if (!home.writable.ok) {
    pushBlocker(blockers, 'home', '홈 폴더에 쓰기 권한이 없습니다. 쓰기 가능한 계정으로 다시 시도하세요.');
  }
  if (disk.unknown) {
    pushWarning(warnings, 'disk-unknown', '디스크 여유 공간을 확인하지 못했습니다. 설치는 계속할 수 있지만 문제가 생기면 「다시 확인」을 눌러 주세요.');
  } else if (!disk.ok) {
    pushBlocker(blockers, 'disk', `디스크 여유 공간이 ${MIN_DISK_GB}GB 미만입니다. 공간을 확보한 뒤 다시 시도하세요.`);
  }
  for (const foreignPort of ports.foreign ?? []) {
    pushBlocker(blockers, `port-${foreignPort.port}`, `포트 ${foreignPort.port}번을 다른 프로그램이 사용하고 있어 설치를 진행할 수 없습니다. 그 프로그램을 종료하거나 재시동한 뒤 다시 시도하세요.`);
  }
  if (!net_.ok) {
    pushWarning(warnings, 'net', '인터넷 연결을 확인하지 못했습니다. 인터넷은 로그인 단계에서 필요합니다.');
  }
  if (!edge.present) {
    pushWarning(warnings, 'edge', 'Chrome·Edge 브라우저를 찾지 못했습니다. 브라우저 조작 기능은 설치 후 대기 상태로 남습니다.');
  }

  const allOk = osResult.ok && arch.ok && disk.ok && net_.ok && browser.ok;
  const canProceedOffline = osResult.ok && arch.ok && disk.ok && browser.ok;

  return {
    blockers,
    warnings,
    info: { net: net_, automationBrowser: edge, gatekeeper, existing, ports: ports.ports },
    recorded: {
      platform: 'darwin', os: osResult, arch, disk, net: net_, browser,
      home: { writable: home.writable.ok, ...(home.writable.detail ? { detail: home.writable.detail } : {}) },
      ports: ports.ports, edge, gatekeeper, existing,
    },
    os: osResult, arch, disk, net: net_, browser, allOk, canProceedOffline,
  };
}
