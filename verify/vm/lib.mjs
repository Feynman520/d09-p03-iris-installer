// verify/vm/lib.mjs -- shared helpers for create.mjs / run.mjs / report.mjs.
//
// Status (T23, 2026-09-15): VirtualBox is still NOT installed on this PC --
// `VBoxManage` is absent and `winget install Oracle.VirtualBox` needs an
// interactive UAC approval no automation shell can grant (Task 5's finding,
// re-confirmed). So these scripts are **syntax-checked and unit-tested**
// (tests/vm.test.mjs drives every scenario through a fake VBoxManage and
// asserts the exact command sequence) but have never spoken to a real
// hypervisor. README.md lists the one-time human steps.
//
// The design consequence of that: nothing here calls spawnSync directly.
// Every VBoxManage call goes through a `vbox(args, opts)` function built by
// `makeVbox({ exec })`, so a test can pass a recorder instead of a process
// spawner and still exercise the real argument-building code. When the human
// finally installs VirtualBox, the only thing that changes is that `exec`
// is the real spawnSync again -- the argument arrays the tests pinned are the
// same ones that reach the hypervisor.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export const CANDIDATE_PATHS = Object.freeze([
  'VBoxManage',
  'VBoxManage.exe',
  'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe',
]);

export const NOT_FOUND_MESSAGE =
  'VBoxManage not found on PATH or at "C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe". '
  + 'Install VirtualBox first: `winget install Oracle.VirtualBox --accept-package-agreements '
  + '--accept-source-agreements` from an interactive prompt and approve the UAC 「예」 dialog '
  + '(headless automation cannot click it -- see verify/vm/README.md).';

// The default process runner. Shaped like spawnSync's result so a fake can be
// a two-line function: ({args}) => ({status, stdout, stderr}).
export function defaultExec(exe, args, opts = {}) {
  return spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

export function findVBoxManage({ exec = defaultExec } = {}) {
  for (const candidate of CANDIDATE_PATHS) {
    let r;
    try { r = exec(candidate, ['--version'], {}); } catch { continue; }
    if (r && r.status === 0) return candidate;
  }
  throw new Error(NOT_FOUND_MESSAGE);
}

export function hasVBoxManage({ exec = defaultExec } = {}) {
  try { findVBoxManage({ exec }); return true; } catch { return false; }
}

/**
 * makeVbox({ exec, exe }) -> vbox(args, { allowFail, timeout, captureOutput })
 *
 * `exe` is resolved once, lazily, so a test can hand in a fake exec and never
 * touch the filesystem. Non-zero exits throw with stderr attached unless
 * `allowFail` -- probes (is guest control up yet?) use that.
 */
export function makeVbox({ exec = defaultExec, exe = null } = {}) {
  let resolved = exe;
  return function vbox(args, { allowFail = false, timeout = 10 * 60 * 1000, captureOutput = true } = {}) {
    if (!resolved) resolved = findVBoxManage({ exec });
    const r = exec(resolved, args, {
      timeout,
      stdio: captureOutput ? 'pipe' : 'inherit',
    });
    if (r?.error) throw r.error;
    const out = captureOutput ? String(r?.stdout ?? '').trim() : '';
    const err = captureOutput ? String(r?.stderr ?? '').trim() : '';
    if (r?.status !== 0 && !allowFail) {
      // 비밀번호는 오류 문장에도 남기지 않는다(2026-09-17: 던진 문장이 실행 로그 파일에 그대로 찍힌 사고).
      // -ArgumentsB64 는 상승 스크립트 인자(비밀번호 포함)를 base64 로 싼 것이라 같이 가린다.
      const shown = args.map((a, i) => (['--password', '-ArgumentsB64'].includes(args[i - 1]) ? '<redacted>' : a));
      throw new Error(`VBoxManage ${shown.join(' ')} -- failed: ${(err || out || `exit ${r?.status}`).trim()}`);
    }
    return { code: r?.status ?? -1, out, err };
  };
}

// The VM password never lives in argv of *our* scripts nor in this file --
// only in IRIS_VM_PASSWORD. (VBoxManage itself still needs it on its own
// command line; that is Oracle's interface, not our choice.)
export function requirePassword(env = process.env) {
  const pw = env.IRIS_VM_PASSWORD;
  if (!pw) {
    throw new Error('IRIS_VM_PASSWORD is not set. Set it in the environment before running this script -- never pass the password as a command-line argument to these scripts.');
  }
  return pw;
}

export function requireFile(p, label, { exists = (f) => fs.existsSync(f) } = {}) {
  if (!exists(p)) throw new Error(`${label} not found: ${p}`);
  return p;
}

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// guest-side command builders (pure -- this is what tests pin)
// ---------------------------------------------------------------------------

const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export function guestRunCmd(vm, { user, password, command }) {
  return [
    'guestcontrol', vm, 'run',
    '--username', user, '--password', password, '--profile',
    '--exe', CMD_EXE,
    '--wait-stdout', '--wait-stderr',
    '--', 'cmd.exe', '/c', command,
  ];
}

export function guestRunPs(vm, { user, password, script }) {
  return [
    'guestcontrol', vm, 'run',
    '--username', user, '--password', password, '--profile',
    '--exe', PS_EXE,
    '--wait-stdout', '--wait-stderr',
    '--', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ];
}

// 2026-09-15 실측(7.2.16): `--target-directory=` 에 **끝 구분자가 없으면**
// VBoxManage 가 그 경로를 "만들 파일"로 보고
// "Destination ... already exists and is a directory" 로 거절한다.
// 그래서 끝에 `\`(host 쪽은 `/`도 허용)를 반드시 붙인다.
const withTrailingSep = (dir) => (/[\\/]$/.test(dir) ? dir : `${dir}\\`);

// 손님 안의 .ps1 파일을 `-File` 로 실행한다.
//
// 왜 `-Command` 가 아니라 `-File` 인가 (2026-09-15 실측):
// VBoxManage 는 `--` 뒤 인자들의 **묶음을 지켜 주지 않는다** — 공백이 든
// 인자 하나를 넘겨도 손님 쪽 PowerShell 은 여러 토막으로 받아 다시 이어 붙여
// 해석한다. 그래서 `-Command "& 'C:\…\x.ps1' -Dir '…'"` 는 맨 앞 `&` 가
// 따로 떨어진 토막이 되어 `AmpersandNotAllowed` 파서 오류로 죽는다
// (`Expand-Archive …` 처럼 `&` 로 시작하지 않는 명령은 우연히 살아남는다).
// `-File` 은 그 위험이 아예 없다. 인자에는 공백을 넣지 않는다.
export function guestRunPsFile(vm, { user, password, file, args = [] }) {
  return [
    'guestcontrol', vm, 'run',
    '--username', user, '--password', password, '--profile',
    '--exe', PS_EXE,
    '--wait-stdout', '--wait-stderr',
    '--', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args,
  ];
}

export function guestCopyTo(vm, { user, password, from, toDir }) {
  return ['guestcontrol', vm, 'copyto', '--username', user, '--password', password, from, `--target-directory=${withTrailingSep(toDir)}`];
}

export function guestCopyFrom(vm, { user, password, from, toDir }) {
  return ['guestcontrol', vm, 'copyfrom', '--username', user, '--password', password, from, `--target-directory=${withTrailingSep(toDir)}`];
}

// ---------------------------------------------------------------------------
// VM state / attached media (pure parsers + one poll)
// ---------------------------------------------------------------------------

export const STOPPED_STATES = Object.freeze(['poweroff', 'aborted', 'saved']);

export function parseVmState(machineReadable) {
  return /VMState="(.*?)"/.exec(String(machineReadable ?? ''))?.[1] ?? '';
}

// `showvminfo --machinereadable` 의 저장장치 줄에서 **실제로 붙어 있는 매체**만
// 골라낸다. 줄 모양: `"SATA Controller-1-0"="C:\...\x.viso"` ("none" 도 온다).
// 같은 접두로 오는 메타 줄(`-ImageUUID-0-0`, `-nonrotational-0-0` …)은 버린다.
const ATTACH_RE = /^"(.*)-(\d+)-(\d+)"="(.*)"$/;
const META_SUFFIX = /-(ImageUUID|nonrotational|discard|hotpluggable|bandwidthgroup|tempeject)$/;

export function parseAttachments(machineReadable) {
  const out = [];
  for (const line of String(machineReadable ?? '').split(/\r?\n/)) {
    const m = ATTACH_RE.exec(line.trim());
    if (!m) continue;
    const [, controller, port, device, medium] = m;
    if (META_SUFFIX.test(controller)) continue;
    if (!medium || medium === 'none') continue;
    out.push({ controller, port: Number(port), device: Number(device), medium });
  }
  return out;
}

// 광학 매체(설치 ISO·무인설치 보조 VISO)만 골라낸다. 하드디스크(.vdi)는 건드리지 않는다.
export const isOpticalMedium = (medium) => /\.(iso|viso|dmg)$/i.test(String(medium ?? '')) || medium === 'emptydrive';

/**
 * detachOpticalPlan(vm, attachments) -> VBoxManage argument arrays.
 *
 * 왜 이것이 필요한가(2026-09-15 실측, Task 23c 가 손으로 당한 일):
 * `unattended install` 이 끝난 뒤에도 보조 VISO 가 SATA 1번에 그대로 붙어 있다.
 * 그 상태로 냉부팅하면 **Windows 설치가 처음부터 다시 시작된다** — 그렇게 찍힌
 * 스냅샷은 시험대가 아니라 재설치기를 되살린다. 그래서 스냅샷 직전에 뗀다.
 */
export function detachOpticalPlan(vm, attachments) {
  return attachments.filter((a) => isOpticalMedium(a.medium)).map((a) => [
    'storageattach', vm,
    '--storagectl', a.controller,
    '--port', String(a.port),
    '--device', String(a.device),
    '--medium', 'none',
  ]);
}

export function bootFromDiskPlan(vm) {
  return ['modifyvm', vm, '--boot1', 'disk', '--boot2', 'none', '--boot3', 'none', '--boot4', 'none'];
}

/**
 * waitForPowerOff(vbox, vm, opts) -> final state string.
 * ACPI 전원 단추는 「눌렀다」만 돌려주고 손님이 스스로 끄기를 기다려야 한다.
 * 기한 안에 안 꺼지면 `force()` 로 강제 종료한 뒤 다시 기다린다.
 */
export async function waitForPowerOff(vbox, vm, {
  maxMs = 5 * 60 * 1000, pollMs = 5 * 1000, sleepFn = sleep, now = () => Date.now(), force = true,
} = {}) {
  const deadline = now() + maxMs;
  for (;;) {
    const info = vbox(['showvminfo', vm, '--machinereadable'], { allowFail: true });
    const st = parseVmState(info.out);
    if (STOPPED_STATES.includes(st)) return st;
    if (now() >= deadline) {
      if (!force) return st;
      log(`게스트가 ${Math.round(maxMs / 1000)}초 안에 스스로 꺼지지 않았습니다 — 강제 종료합니다.`);
      vbox(['controlvm', vm, 'poweroff'], { allowFail: true });
      return waitForPowerOff(vbox, vm, { maxMs: 60 * 1000, pollMs, sleepFn, now, force: false });
    }
    await sleepFn(pollMs);
  }
}

// Poll guest control readiness by actually running a trivial command as the
// target user -- that IS the capability every later step needs, so it is a
// better gate than any guest property whose name Oracle does not guarantee.
//
// 2026-09-18 IRIS-Win10 실측: Windows 10 무인설치는 post-install 이 끝나면 **손님이 스스로
// 꺼진다**(Win11 은 켜진 채 남는다). 꺼진 VM 에는 손님 제어가 영영 안 열리므로, 프로브가
// 실패할 때 VM 상태를 보고 꺼져 있으면 headless 로 다시 켠다(최대 maxRestarts 번).
export async function waitForGuestControl(vbox, vmName, username, password, {
  pollMs = 30 * 1000, maxMs = 90 * 60 * 1000, sleepFn = sleep, now = () => Date.now(),
  vmStateFn = () => parseVmState(vbox(['showvminfo', vmName, '--machinereadable'], { allowFail: true }).out),
  maxRestarts = 2,
} = {}) {
  const start = now();
  const deadline = start + maxMs;
  let attempt = 0;
  let restarts = 0;
  while (now() < deadline) {
    attempt += 1;
    log(`guest control probe #${attempt} (elapsed ${Math.round((now() - start) / 60000)} min)...`);
    const r = vbox(guestRunCmd(vmName, { user: username, password, command: 'echo ready' }),
      { allowFail: true, timeout: 60 * 1000 });
    if (r.code === 0 && r.out.includes('ready')) {
      log('guest control is ready.');
      return true;
    }
    let state = '';
    try { state = String(vmStateFn() ?? ''); } catch { state = ''; }
    if (STOPPED_STATES.includes(state) && restarts < maxRestarts) {
      restarts += 1;
      log(`VM is ${state} while waiting for guest control (the guest shut itself down after post-install?) -- starting it headless (${restarts}/${maxRestarts}).`);
      vbox(['startvm', vmName, '--type', 'headless'], { allowFail: true });
    }
    await sleepFn(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  return false;
}
