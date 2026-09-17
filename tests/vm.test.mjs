// tests/vm.test.mjs -- the VM rig, exercised without a hypervisor.
//
// VirtualBox is not installed on this PC and cannot be installed without an
// interactive UAC approval (verify/vm/README.md). That leaves exactly one
// honest thing to test: the **commands** verify/vm would send. So every test
// here drives the real code with a fake `VBoxManage` runner that records its
// argv, and asserts the sequence per scenario. When a human finally installs
// VirtualBox, these are the argument arrays that will reach it unchanged.
//
// What this does NOT prove: that VirtualBox accepts those flags on whatever
// version gets installed, that Windows installs unattended, or that any
// scenario passes. Those need the real thing -- README.md says so in the
// same words.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeVbox, findVBoxManage, hasVBoxManage, NOT_FOUND_MESSAGE, requirePassword,
  guestRunCmd, guestRunPs, guestCopyTo, guestCopyFrom, waitForGuestControl,
  parseAttachments, parseVmState, detachOpticalPlan, isOpticalMedium, waitForPowerOff,
} from '../verify/vm/lib.mjs';
import {
  createPlan, finalizePlan, parseArgs as createArgs, DEFAULTS,
  cmdEchoLines, chunk64, bakeBlock, buildPostInstallTemplate, stockTemplatePath,
  POST_INSTALL_ANCHOR, STOCK_POST_INSTALL,
} from '../verify/vm/create.mjs';
import {
  SCENARIOS, scenarioPlan, parseArgs as runArgs,
  ENTRY, COLLECT, HOSTS_BLOCK_SCRIPT, GUEST_USERS,
  JUDGES, EXPECTED_INSTALLER_EXIT, RUNNER, DRIVER, DRIVE_RESULT, buildFingerprint,
  ACCOUNT_NAMES, ACCOUNT_PREP, USER_PREP, PUBLIC_DIR, SHARE_DIR, LEGACY_SCRIPT, LEGACY_SNAPSHOT, HOSTS_SCRIPT,
  BASE_VM, ELEVATE_SCRIPT, elevateArgs, argsB64,
} from '../verify/vm/run.mjs';

// 상승 문을 거쳐 보낸 인자 줄을 되읽는다 -- 시험이 base64 를 눈으로 읽을 수는 없으니.
const decodeElevated = (args) => {
  const i = args.indexOf('-ArgumentsB64');
  return i === -1 ? '' : Buffer.from(args[i + 1], 'base64').toString('utf8');
};
import {
  parseMatrix, setRow, formatRow, ROW_RE, RESULTS, updateRow, fingerprintOfZip,
} from '../verify/vm/report.mjs';
import { fingerprintTree, checkResumeShape } from '../verify/e2e.mjs';

// ---------------------------------------------------------------------------
// the fake VBoxManage
// ---------------------------------------------------------------------------

function fakeExec({ replies = {}, version = '7.1.4r165100' } = {}) {
  const calls = [];
  const exec = (exe, args) => {
    calls.push({ exe, args });
    if (args[0] === '--version') return { status: 0, stdout: version, stderr: '' };
    const key = args.slice(0, 3).join(' ');
    if (key in replies) return replies[key];
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const PLAN_OPTS = {
  zip: 'D:\\out\\IRIS-Setup_v2.0.0.zip',
  user: 'tester',
  password: 'pw',
  outDir: 'D:\\results\\S01',
  guestDir: `${GUEST_USERS}\\tester\\Desktop`,
};

// 저장소 정화 규칙(`verify/static.mjs` ⑦)은 "드라이브 문자 + IRIS/Users" 모양을
// 개발 PC 절대경로로 보고 막는다. 시험에서도 그 문자열을 통째로 적지 않는다.
const DRIVE = 'C:';

const argsOf = (plan, phase) => plan.filter((s) => s.phase === phase).map((s) => s.args);

const MATRIX_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', '시험행렬.md');

// ---------------------------------------------------------------------------
// lib.mjs
// ---------------------------------------------------------------------------

test('findVBoxManage tries PATH first, then the default install location', () => {
  const { exec, calls } = fakeExec();
  assert.equal(findVBoxManage({ exec }), 'VBoxManage');
  assert.deepEqual(calls[0].args, ['--version']);
});

test('findVBoxManage falls through to the Program Files path', () => {
  const exec = (exe, args) => (exe.includes('Program Files')
    ? { status: 0, stdout: '7.1.4', stderr: '' }
    : { status: 1, stdout: '', stderr: 'not found' });
  assert.equal(findVBoxManage({ exec }), 'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe');
});

test('a missing VirtualBox throws the install instruction, not a bare ENOENT', () => {
  const exec = () => { throw Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }); };
  assert.throws(() => findVBoxManage({ exec }), /winget install Oracle\.VirtualBox/);
  assert.equal(hasVBoxManage({ exec }), false);
  assert.match(NOT_FOUND_MESSAGE, /UAC/);
});

test('vbox() throws with stderr attached on a non-zero exit, unless allowFail', () => {
  const { exec } = fakeExec({ replies: { 'snapshot VM restore': { status: 1, stdout: '', stderr: 'no snapshot' } } });
  const vbox = makeVbox({ exec });
  assert.throws(() => vbox(['snapshot', 'VM', 'restore', 'clean']), /no snapshot/);
  assert.equal(vbox(['snapshot', 'VM', 'restore', 'clean'], { allowFail: true }).code, 1);
});

test('requirePassword reads only IRIS_VM_PASSWORD and never a CLI argument', () => {
  assert.throws(() => requirePassword({}), /IRIS_VM_PASSWORD/);
  assert.equal(requirePassword({ IRIS_VM_PASSWORD: 'secret' }), 'secret');
});

test('guest command builders wrap cmd.exe / powershell.exe with wait flags', () => {
  const run = guestRunCmd('VM', { user: 'u', password: 'p', command: 'echo hi' });
  assert.deepEqual(run.slice(0, 3), ['guestcontrol', 'VM', 'run']);
  assert.ok(run.includes('--wait-stdout') && run.includes('--wait-stderr'));
  // `--profile` 없이는 손님 프로세스에 PATH 조차 없어서 `powershell.exe` 를
  // 이름으로 부르는 설치기 사전점검 셋이 모두 실패한다(2026-09-15 실측).
  assert.ok(run.includes('--profile'), 'guest run needs the user environment');
  assert.deepEqual(run.slice(-3), ['cmd.exe', '/c', 'echo hi']);

  const ps = guestRunPs('VM', { user: 'u', password: 'p', script: 'Get-Date' });
  assert.ok(ps.at(-4) === '-ExecutionPolicy' || ps.includes('-ExecutionPolicy'));
  assert.equal(ps.at(-1), 'Get-Date');

  // 끝 구분자가 없으면 VBoxManage 7.2 가 그 경로를 "만들 파일"로 보고
  // "already exists and is a directory" 로 거절한다(2026-09-15 실측).
  assert.deepEqual(
    guestCopyTo('VM', { user: 'u', password: 'p', from: 'a.zip', toDir: 'C:\\D' }).slice(-2),
    ['a.zip', '--target-directory=C:\\D\\'],
  );
  assert.deepEqual(
    guestCopyFrom('VM', { user: 'u', password: 'p', from: 'C:\\x.json', toDir: 'D:\\o' }).slice(-2),
    ['C:\\x.json', '--target-directory=D:\\o\\'],
  );
  // 이미 붙어 있으면 덧붙이지 않는다.
  assert.equal(
    guestCopyTo('VM', { user: 'u', password: 'p', from: 'a.zip', toDir: 'C:\\D\\' }).at(-1),
    '--target-directory=C:\\D\\',
  );
});

test('waitForGuestControl polls until the guest echoes back, then stops', async () => {
  let n = 0;
  const vbox = () => { n += 1; return n < 3 ? { code: 1, out: '', err: '' } : { code: 0, out: 'ready', err: '' }; };
  const ok = await waitForGuestControl(vbox, 'VM', 'u', 'p', { pollMs: 0, maxMs: 10000, sleepFn: async () => {} });
  assert.equal(ok, true);
  assert.equal(n, 3);
});

test('waitForGuestControl gives up (false, not a throw) when the deadline passes', async () => {
  let clock = 0;
  const vbox = () => ({ code: 1, out: '', err: '' });
  const ok = await waitForGuestControl(vbox, 'VM', 'u', 'p', {
    pollMs: 100, maxMs: 300, sleepFn: async () => { clock += 100; }, now: () => clock,
  });
  assert.equal(ok, false);
});

// ---------------------------------------------------------------------------
// create.mjs
// ---------------------------------------------------------------------------

test('createPlan asks for the three things Windows 11 refuses to install without', () => {
  const opts = { ...DEFAULTS, name: 'VM1', iso: 'D:\\win11.iso' };
  const plan = createPlan(opts, { password: 'pw', diskPath: 'D:\\VM1.vdi' });
  const flat = plan.map((a) => a.join(' '));
  assert.ok(flat.some((l) => l.includes('--firmware efi')), 'EFI firmware');
  assert.ok(flat.some((l) => l.includes('--tpm-type 2.0')), 'TPM 2.0');
  // 보안 부팅은 modifyvm 스위치가 아니라 NVRAM 하위 명령이다(7.2.16 실측).
  // 플랫폼 키(PK)를 먼저 등록하지 않으면 `secureboot --enable` 이 거절한다.
  assert.deepEqual(
    plan.filter((a) => a[0] === 'modifynvram').map((a) => a.slice(2).join(' ')),
    ['inituefivarstore', 'enrollmssignatures', 'enrollorclpk', 'secureboot --enable'],
  );
  assert.ok(!flat.some((l) => l.includes('--secure-boot')), 'modifyvm --secure-boot 는 없는 스위치다');
  // USB 3.0(xHCI)은 확장팩이 있어야 하므로 기본 패키지의 OHCI 만 쓴다.
  assert.ok(!flat.some((l) => l.includes('--usbxhci')), 'xHCI 는 확장팩을 요구한다');
  assert.deepEqual(plan[0], ['createvm', '--name', 'VM1', '--ostype', 'Windows11_64', '--register']);
  assert.equal(plan.at(-1)[0], 'unattended');
  // `--start-vm` 없이는 VM 이 켜지지 않아 손님 제어가 영원히 올라오지 않는다.
  assert.ok(plan.at(-1).some((a) => a.startsWith('--start-vm=')), '--start-vm');
});

test('createPlan puts the password in VBoxManage argv but never in our own argv', () => {
  const opts = { ...DEFAULTS, name: 'VM1', iso: 'D:\\win11.iso' };
  const plan = createPlan(opts, { password: 'hunter2', diskPath: 'D:\\VM1.vdi' });
  // 실제 스위치 이름은 `--password` 가 아니라 `--user-password`(+`--admin-password`).
  assert.ok(plan.at(-1).includes('--user-password=hunter2'));
  assert.ok(plan.at(-1).includes('--admin-password=hunter2'));
  // ...and parseArgs has no --password switch at all, so a shell history can
  // never contain it.
  assert.throws(() => createArgs(['--name', 'VM1', '--iso', 'x.iso', '--password', 'hunter2']), /unknown arg/);
});

test('create.mjs parseArgs supports the Win10 and English-UI variants', () => {
  const win10 = createArgs(['--name', 'IRIS-Win10', '--iso', 'w10.iso', '--ostype', 'Windows10_64']);
  assert.equal(win10.ostype, 'Windows10_64');
  const en = createArgs(['--name', 'IRIS-Win11-EN', '--iso', 'w11.iso', '--locale', 'en_US', '--language', 'en-US', '--country', 'US']);
  assert.equal(en.language, 'en-US');
  assert.equal(en.country, 'US');
  assert.throws(() => createArgs(['--iso', 'x.iso']), /--name/);
});

// --- 권한 굽기 (Task 23e) ----------------------------------------------------
//
// 이 다섯 벌이 지키는 사실 하나: **손님 제어 세션은 상승할 수 없으므로, 상승은
// 무인 설치 때(그때만 SYSTEM 이 돈다) 미리 구워 두어야 한다**(verify/vm/bake.ps1).
// 굽는 길은 `--post-install-template` 하나뿐이고, 그 파일은 보조 ISO 의
// VBOXPOST.CMD 가 되므로 **순수 ASCII** 여야 한다.

test('bake is ON by default and --no-bake turns it off', () => {
  assert.equal(DEFAULTS.bake, true, '굽지 않으면 S03·S04·S05·S07 은 시작조차 못 한다');
  assert.equal(createArgs(['--name', 'V', '--iso', 'x.iso']).bake, true);
  assert.equal(createArgs(['--name', 'V', '--iso', 'x.iso', '--no-bake']).bake, false);
  assert.equal(createArgs(['--name', 'V', '--iso', 'x.iso', '--bake']).bake, true);
});

test('createPlan passes the generated post-install template only when one is given', () => {
  const opts = { ...DEFAULTS, name: 'VM1', iso: 'D:\\win11.iso' };
  const plain = createPlan(opts, { password: 'pw', diskPath: 'D:\\VM1.vdi' });
  assert.ok(!plain.at(-1).some((a) => a.startsWith('--post-install-template=')));
  const baked = createPlan(opts, { password: 'pw', diskPath: 'D:\\VM1.vdi', postInstallTemplate: 'D:\\t.cmd' });
  assert.ok(baked.at(-1).includes('--post-install-template=D:\\t.cmd'));
  // `--post-install-command` 는 "명령 한 줄"뿐이라 굽기 블록을 담지 못한다(7.2.16 도움말).
  assert.ok(!baked.at(-1).some((a) => a.startsWith('--post-install-command=')));
});

test('cmdEchoLines wraps every echo in parens -- a base64 line ending in a digit is a cmd redirect otherwise', () => {
  // `echo abc1>>f` 에서 `1>` 는 스트림 1번 리다이렉션이다. 괄호가 없으면 줄 끝
  // 숫자가 통째로 사라지고, 되돌린 파일은 조용히 깨진다.
  assert.deepEqual(cmdEchoLines('abc1\nde2', 'F'), ['(echo abc1)>>F', '(echo de2)>>F']);
  // 공백을 넣으면 그 공백이 파일에 들어간다 -- 절대 `echo x >>F` 로 쓰지 않는다.
  assert.ok(cmdEchoLines('x', 'F').every((l) => !/ >>/.test(l)));
  assert.equal(chunk64('a'.repeat(200), 76).split('\n').length, 3);
});

test('bakeBlock stays pure ASCII and never puts the password in plaintext', () => {
  const b64 = Buffer.from('# 한글이 든 스크립트\n', 'utf8').toString('base64');
  const block = bakeBlock({ bakeB64: b64, passwordB64: Buffer.from('p@ss w0rd!', 'utf8').toString('base64') });
  assert.ok([...block].every((c) => c.charCodeAt(0) <= 126), 'VBOXPOST.CMD 는 코드페이지로 읽힌다 -- ASCII 만');
  assert.ok(!block.includes('p@ss w0rd!'), '비밀번호 평문은 굽힌 .cmd 에 들어가지 않는다');
  assert.ok(block.includes('certutil -f -decode'), '한글은 base64 로 실어 손님 안에서 되돌린다');
  assert.match(block, /-PasswordB64 "[A-Za-z0-9+/=]+"/);
});

test('buildPostInstallTemplate inserts before Oracle\u2019s cleanup block, and shouts if Oracle moved it', () => {
  const stock = `line one\n${POST_INSTALL_ANCHOR}\nrem tail\n`;
  const out = buildPostInstallTemplate(stock, 'MY-BLOCK\n');
  assert.ok(out.indexOf('MY-BLOCK') < out.indexOf(POST_INSTALL_ANCHOR), '정리 블록 앞에 들어간다');
  assert.ok(out.includes('rem tail'), '원본 꼬리는 그대로 남는다');
  assert.throws(() => buildPostInstallTemplate('nothing familiar here', 'X'), /anchor not found/);
  // 원본 템플릿은 VBoxManage.exe 옆에서 찾는다(설치 경로가 바뀌어도 따라간다).
  assert.equal(path.basename(stockTemplatePath('D:\\vb\\VBoxManage.exe')), STOCK_POST_INSTALL);
  assert.ok(stockTemplatePath('D:\\vb\\VBoxManage.exe').includes('UnattendedTemplates'));
});

test('elevateArgs hides spaces (and the password) inside base64', () => {
  const args = elevateArgs({ script: 'C:\\x\\a.ps1', argumentLine: '-Fixture s04 -Password "p w"' });
  // VBoxManage 가 쪼갤 공백이 인자 어디에도 없어야 한다.
  for (const a of args) assert.ok(!/\s/.test(a), `공백이 든 인자: ${a}`);
  assert.equal(Buffer.from(args[args.indexOf('-ArgumentsB64') + 1], 'base64').toString('utf8'),
    '-Fixture s04 -Password "p w"');
  assert.equal(argsB64('ab'), 'YWI=');
});

// --- 스냅샷 전 마무리 (Task 23d) --------------------------------------------
//
// 이 네 벌이 지키는 사실 하나: **보조 VISO 가 붙은 채, 또는 켜진 채로 찍은
// 스냅샷은 시험대가 아니다.** 되살려 냉부팅하면 Windows 설치가 다시 돈다
// (2026-09-15 Task 23c 실측 — 한 번 당했다).

const MACHINEREADABLE_AFTER_INSTALL = [
  'VMState="running"',
  '"SATA Controller-0-0"="C:\\\\VMs\\\\VM1\\\\VM1.vdi"',
  '"SATA Controller-ImageUUID-0-0"="1c0cd87b-bfd0-46c3-8766-2062dbd653de"',
  '"SATA Controller-nonrotational-0-0"="off"',
  '"SATA Controller-1-0"="C:\\\\VMs\\\\VM1\\\\Unattended-abc-aux-iso.viso"',
  '"IDE Controller-0-0"="D:\\\\win11.iso"',
  '"IDE Controller-0-1"="none"',
].join('\n');

test('parseAttachments keeps real media and drops the "none" and meta lines', () => {
  const at = parseAttachments(MACHINEREADABLE_AFTER_INSTALL);
  assert.deepEqual(at.map((a) => `${a.controller}:${a.port}:${a.device}`),
    ['SATA Controller:0:0', 'SATA Controller:1:0', 'IDE Controller:0:0']);
  assert.equal(parseVmState(MACHINEREADABLE_AFTER_INSTALL), 'running');
  assert.equal(parseVmState(''), '');
});

test('detachOpticalPlan removes the install ISO and the unattended aux VISO -- and never the hard disk', () => {
  const plan = detachOpticalPlan('VM1', parseAttachments(MACHINEREADABLE_AFTER_INSTALL));
  assert.equal(plan.length, 2, '.vdi 는 떼지 않는다');
  assert.deepEqual(plan[0], ['storageattach', 'VM1', '--storagectl', 'SATA Controller', '--port', '1', '--device', '0', '--medium', 'none']);
  assert.deepEqual(plan[1], ['storageattach', 'VM1', '--storagectl', 'IDE Controller', '--port', '0', '--device', '0', '--medium', 'none']);
  assert.ok(isOpticalMedium('x.VISO') && isOpticalMedium('x.iso') && !isOpticalMedium('x.vdi'));
});

test('finalizePlan powers off first, then detaches, then pins boot to disk, then snapshots', () => {
  const opts = { ...DEFAULTS, name: 'VM1', iso: 'D:\\win11.iso' };
  const plan = finalizePlan(opts, { machineReadable: MACHINEREADABLE_AFTER_INSTALL });
  assert.deepEqual(plan[0], ['controlvm', 'VM1', 'acpipowerbutton']);
  assert.equal(plan[1][0], 'storageattach');
  assert.equal(plan[2][0], 'storageattach');
  assert.deepEqual(plan[3], ['modifyvm', 'VM1', '--boot1', 'disk', '--boot2', 'none', '--boot3', 'none', '--boot4', 'none']);
  assert.deepEqual(plan.at(-1).slice(0, 4), ['snapshot', 'VM1', 'take', 'clean']);
  // 스냅샷은 언제나 맨 마지막이다 -- 그 앞의 무엇 하나라도 뒤로 가면
  // 「설치 매체가 붙은 스냅샷」이 다시 생긴다.
  assert.equal(plan.findIndex((a) => a[0] === 'snapshot'), plan.length - 1);
});

test('waitForPowerOff waits for the guest to stop itself, then forces it', async () => {
  let n = 0;
  const states = ['running', 'running', 'poweroff'];
  const vbox = (args) => {
    if (args[0] === 'showvminfo') return { code: 0, out: `VMState="${states[Math.min(n++, states.length - 1)]}"`, err: '' };
    return { code: 0, out: '', err: '' };
  };
  assert.equal(await waitForPowerOff(vbox, 'VM1', { sleepFn: async () => {}, pollMs: 0 }), 'poweroff');

  // 영원히 안 꺼지는 손님: 기한이 지나면 강제 종료를 보내고, 그 뒤 꺼진 것을 본다.
  const sent = [];
  let forced = false;
  const stuck = (args) => {
    sent.push(args.join(' '));
    if (args[0] === 'showvminfo') return { code: 0, out: `VMState="${forced ? 'poweroff' : 'running'}"`, err: '' };
    if (args[2] === 'poweroff') forced = true;
    return { code: 0, out: '', err: '' };
  };
  let clock = 0;
  const st = await waitForPowerOff(stuck, 'VM1', {
    sleepFn: async () => { clock += 1000; }, pollMs: 1000, maxMs: 3000, now: () => clock,
  });
  assert.equal(st, 'poweroff');
  assert.ok(sent.includes('controlvm VM1 poweroff'), '강제 종료로 넘어가야 한다');
});

// ---------------------------------------------------------------------------
// run.mjs -- the per-scenario command sequences
// ---------------------------------------------------------------------------

test('buildFingerprint stamps the build content fingerprint, not the zip sha256', () => {
  const zip = path.join(os.tmpdir(), `iris-fp-${process.pid}.zip`);
  fs.writeFileSync(zip, 'not a real zip');
  try {
    const cf = 'a'.repeat(64);
    assert.equal(buildFingerprint(zip, { readJsonFn: () => ({ contentFingerprint: cf }) }), cf.slice(0, 12));
    // last-build.json 이 없거나 값이 이상하면 zip 해시로 내려간다(조용히 빈 값을 쓰지 않는다).
    const fallback = buildFingerprint(zip, { readJsonFn: () => null });
    assert.match(fallback, /^[0-9a-f]{12}$/);
    assert.equal(buildFingerprint(zip, { readJsonFn: () => ({ contentFingerprint: 'nope' }) }), fallback);
  } finally { fs.rmSync(zip, { force: true }); }
});

test('the scenario table covers S01..S11 and matches 설계-v2 10절 placement', () => {
  const ids = Object.keys(SCENARIOS);
  assert.deepEqual(ids, ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11']);
  // S03·S04 는 2026-09-15(Task 23d)에 VM 손님 계정으로 옮겼다 -- 사용자의 진짜
  // PC 에 계정·프로필·바탕화면 리디렉션을 남기지 않기 위해서다.
  assert.equal(SCENARIOS.S03.where, 'vm');
  assert.equal(SCENARIOS.S04.where, 'vm');
  assert.equal(SCENARIOS.S08.where, 'this-pc');
  for (const id of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S09', 'S10', 'S11']) {
    assert.equal(SCENARIOS[id].where, 'vm', id);
    assert.equal(typeof SCENARIOS[id].judge, 'function', `${id} needs a judge`);
  }
});

test('judgeRelayProbe: 운전기의 중계기 시작 결과가 있으면 실패는 곧 시나리오 실패다 (S13 몫, 2026-09-17)', async () => {
  const { judgeRelayProbe } = await import('../verify/vm/run.mjs');
  assert.deepEqual(judgeRelayProbe({}), { ok: true, reason: '' }, '옛 운전기·못 간 경우는 다른 판정이 말한다');
  assert.deepEqual(judgeRelayProbe({ drive: { relayProbe: { ok: true, accounts: 0 } } }), { ok: true, reason: '중계기 시작 OK(계정 0)' });
  const bad = judgeRelayProbe({ drive: { relayProbe: { ok: false, code: 'E-ONLINE-RELAY', message: '중계기를 시작하지 못했습니다 — 포트 3456 에서 답하지 않습니다.' } } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /중계기 시작 실패: 중계기를 시작하지 못했습니다/);
});

test('S03 runs the installer as a standard user out of the shared public folder', () => {
  const plan = scenarioPlan('S03', PLAN_OPTS);
  const account = ACCOUNT_NAMES.s03;
  // 계정 확인은 관리자(tester)가 **상승 문을 거쳐**, 설치는 표준 사용자가.
  // 2026-09-16(Task 23e): 계정 자체는 무인 설치 때 구워져 있고(bake.ps1), 여기서
  // 하는 일은 "정말 있고 정말 표준 사용자인가"를 SYSTEM 으로 확인하는 것이다.
  const prep = argsOf(plan, 'prep-guest');
  const elevated = prep.find((a) => a.join(' ').includes(ELEVATE_SCRIPT) && a.includes('-ArgumentsB64'));
  assert.ok(elevated, '계정 준비는 상승 문을 거친다');
  assert.ok(elevated.join(' ').includes(`${PUBLIC_DIR}\\${ACCOUNT_PREP}`));
  assert.match(decodeElevated(elevated), /-Fixture s03\b/);
  // 2026-09-17: guestcontrol --profile 은 표준 사용자 하이브를 얹지 않아 HKCU 가 .DEFAULT 로 떨어진다 →
  // 계정 확인 때 자동 로그온을 그 계정으로 바꾸고(-AutoLogon) 재부팅해 진짜 대화형 로그온을 만든 뒤 준비한다.
  assert.match(decodeElevated(elevated), /-AutoLogon\b/, '자동 로그온을 표준 계정으로 바꾼다');
  const userPrep = prep.filter((a) => a.join(' ').includes(`${PUBLIC_DIR}\\${USER_PREP}`));
  assert.equal(userPrep.length, 1, 'S03 은 리디렉션이 없으니 그 계정 준비는 한 번');
  assert.equal(userPrep[0][userPrep[0].indexOf('--username') + 1], account, '프로필 만들기는 그 계정으로');
  const phases = plan.map((st) => st.phase);
  const rebootAt = phases.indexOf('reboot');
  assert.ok(rebootAt > 0, '계정 준비 뒤 재부팅이 있다');
  const idxOf = (args) => plan.findIndex((st) => st.args === args);
  assert.ok(idxOf(elevated) < rebootAt && rebootAt < idxOf(userPrep[0]), '계정 확인 → 재부팅 → 그 계정 준비 순서');

  const install = argsOf(plan, 'install')[0];
  assert.equal(install[install.indexOf('--username') + 1], account);
  assert.ok(install.includes(`${SHARE_DIR}\\${RUNNER}`));
  // zip 은 관리자가 공용 폴더에 놓는다(남의 프로필 안으로 밀어 넣지 않는다).
  const zip = argsOf(plan, 'copy-zip')[0];
  assert.equal(zip[zip.indexOf('--username') + 1], 'tester');
  assert.equal(zip.at(-1), `--target-directory=${SHARE_DIR}\\`);
  // 표준 사용자 시나리오에 바탕화면 확인 단계는 없다(S04 만 옮긴 바탕화면을 본다).
  assert.ok(!plan.some((st) => st.args.includes('-Check')));
});

test('S04 makes the Korean+space account, redirects its desktop, and checks where the .lnk landed', () => {
  const plan = scenarioPlan('S04', PLAN_OPTS);
  const account = ACCOUNT_NAMES.s04;
  assert.ok(/\s/.test(account) && /[가-힣]/.test(account), '이름에 한글과 공백이 둘 다 있어야 시나리오가 성립한다');

  const prep = argsOf(plan, 'prep-guest');
  const elevated = prep.find((a) => a.includes('-ArgumentsB64'));
  assert.ok(elevated && /-Fixture s04\b/.test(decodeElevated(elevated)));
  // 비밀번호는 **base64 안에만** 있고 평문으로 VBoxManage 인자에 서지 않는다.
  assert.ok(!elevated.includes('-Password'), '-Password 는 base64 뒤에 숨는다');
  const userPrep = prep.at(-1);
  assert.equal(userPrep[userPrep.indexOf('--username') + 1], account);
  assert.ok(userPrep.includes('-Redirect'), 'S04 는 바탕화면을 옮겨 둔 뒤 설치한다');
  // 2026-09-17: 리디렉션(HKCU 쓰기)은 그 계정이 자동 로그온으로 **진짜 로그온한 뒤**(재부팅 뒤) 한다.
  assert.match(decodeElevated(elevated), /-AutoLogon\b/, '자동 로그온을 표준 계정으로 바꾼다');
  const rebootAt = plan.findIndex((st) => st.phase === 'reboot');
  assert.ok(rebootAt > 0 && rebootAt < plan.findIndex((st) => st.args === userPrep), '-Redirect 는 재부팅(진짜 로그온) 뒤');

  // 한글+공백 이름은 **인자로 넘기지 않는다** -- VBoxManage 가 인자 묶음을 지켜
  // 주지 않아 두 토막이 된다(lib.mjs). 그래서 -File 뒤 인자에는 공백이 없다.
  for (const st of plan) {
    const i = st.args.indexOf('-File');
    if (i === -1) continue;
    for (const a of st.args.slice(i + 2)) assert.ok(!/\s/.test(a), `-File 인자에 공백: ${a}`);
  }

  const check = argsOf(plan, 'collect').find((a) => a.includes('-Check'));
  assert.ok(check, '설치 뒤 옮겨진 바탕화면을 확인해야 한다');
  assert.equal(check[check.indexOf('--username') + 1], account, 'HKCU 는 그 계정만 볼 수 있다');
});

test('judgeKoreanUser fails when the shortcut is missing or unverified, passes when it is on the moved desktop', () => {
  const ok = {
    exitCode: 0,
    diagnostics: { stages: Object.fromEntries(['unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks'].map((id) => [id, { status: 'done' }])), checks: { summary: { fail: 0, pending: 1 } } },
  };
  assert.equal(JUDGES.koreanUser({ ...ok, redirectedShortcut: true }).ok, true);
  assert.equal(JUDGES.koreanUser({ ...ok, redirectedShortcut: false }).ok, false);
  // 확인 자체를 못 한 것(null)은 "놓였다"가 아니다.
  assert.equal(JUDGES.koreanUser({ ...ok, redirectedShortcut: null }).ok, false);
  assert.match(JUDGES.koreanUser({ ...ok, redirectedShortcut: null }).reason, /확인하지 못했/);
});

test('S01 baseline: restore -> start -> copy zip+driver -> unzip -> drive -> collect -> poweroff', () => {
  const plan = scenarioPlan('S01', PLAN_OPTS);
  assert.deepEqual(plan.map((s) => s.phase), [
    'pre-stop', 'restore', 'start', 'copy-zip', 'copy-driver', 'copy-driver', 'extract', 'install',
    'collect', ...COLLECT.map(() => 'collect'),
    'stop',
  ]);
  // 스냅샷 되돌리기는 꺼진 VM 에서만 된다 -- 먼저 끄고(실패 무시) 되돌린다.
  assert.deepEqual(plan[0].args, ['controlvm', BASE_VM, 'poweroff']);
  assert.deepEqual(plan[1].args, ['snapshot', BASE_VM, 'restore', 'clean']);
  assert.deepEqual(plan[2].args, ['startvm', BASE_VM, '--type', 'headless']);
  // 진입기(IRIS-설치.cmd)를 직접 부르지 않는다 -- 그것은 서버를 띄우고 곧장
  // 끝나는 물건이라 "설치됨"을 뜻하지 않는다. 화면을 눌러 주는 운전기를 부른다.
  const install = plan.find((s) => s.phase === 'install').args.join(' ');
  assert.ok(install.includes(RUNNER), '설치 단계는 guest-run.ps1 을 부른다');
  assert.ok(install.includes(DRIVER), '운전기 경로를 넘긴다');
  assert.ok(!install.includes(ENTRY), '진입기를 직접 부르지 않는다');
  assert.deepEqual(plan.at(-1).args, ['controlvm', BASE_VM, 'poweroff']);
});

test('every VM scenario collects the drive result plus diagnostics.json and the four other records', () => {
  for (const id of ['S01', 'S02', 'S05', 'S06', 'S07', 'S09', 'S10', 'S11']) {
    const collected = argsOf(scenarioPlan(id, PLAN_OPTS), 'collect')
      .filter((a) => a[2] === 'copyfrom')
      .map((a) => a.at(-2));
    assert.deepEqual(collected, [`${PLAN_OPTS.guestDir}\\${DRIVE_RESULT}`, ...COLLECT], id);
  }
});

test('S06 pulls the cable BEFORE boot and plugs it back after poweroff', () => {
  const plan = scenarioPlan('S06', PLAN_OPTS);
  const phases = plan.map((s) => s.phase);
  assert.ok(phases.indexOf('prep-host') < phases.indexOf('start'), '망 차단은 부팅 전이어야 한다');
  assert.deepEqual(plan[phases.indexOf('prep-host')].args, ['modifyvm', BASE_VM, '--cable-connected1', 'off']);
  assert.deepEqual(plan.at(-1).args, ['modifyvm', BASE_VM, '--cable-connected1', 'on']);
  assert.ok(phases.indexOf('stop') < phases.lastIndexOf('restore-host'));
});

test('S07 blocks only the npm registry, in the guest, after boot', () => {
  const plan = scenarioPlan('S07', PLAN_OPTS);
  const phases = plan.map((s) => s.phase);
  assert.ok(phases.indexOf('start') < phases.indexOf('prep-guest'), 'hosts 편집은 손님이 켜진 뒤');
  assert.ok(phases.indexOf('prep-guest') < phases.indexOf('install'), 'hosts 편집은 설치 전');
  // 막기는 **파일**이 한다 -- 한 줄 -Command 는 VBoxManage 가 토막 내 파서 오류를
  // 냈다(2026-09-15 실측). 그래서 준비 단계는 복사 + -File 두 벌이다.
  const prep = argsOf(plan, 'prep-guest');
  assert.equal(prep.length, 3);
  assert.ok(prep.slice(0, 2).every((a) => a.includes('copyto')), '먼저 스크립트 두 벌을 넣고');
  // hosts 는 권한 상승이 있어야 고칠 수 있는데 손님 제어 세션은 상승돼 있지 않다
  // (2026-09-15 실측: UnauthorizedAccessError). 그래서 상승 문을 거쳐 돌린다.
  assert.ok(prep[2].join(' ').includes(HOSTS_SCRIPT) && prep[2].join(' ').includes('guest-elevate.ps1'));
  // 어떤 준비 단계도 손님 쪽 PowerShell 에 공백 든 스크립트 본문을 넘기지 않는다.
  assert.ok(!prep.some((a) => a.includes('-Command')));

  const script = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'verify', 'vm', HOSTS_SCRIPT), 'utf8');
  const names = /\ = @\(([^)]*)\)/.exec(script)?.[1] ?? '';
  assert.match(names, /registry\.npmjs\.org/);
  // 막는 이름 목록에 npm 아닌 곳이 들어가면 이 시나리오는 다른 것을 시험하게 된다.
  assert.doesNotMatch(names, /claude\.ai|anthropic/, 'npm 만 막는 시나리오다');
  // 막혔다고 적어 놓고 안 막힌 채 시험하지 않도록, 스크립트가 스스로 확인한다.
  assert.match(script, /NPM-UNREACHABLE-CONFIRMED/);
});

test('judgeNpmBlocked refuses to pass when the block never took effect', () => {
  const ev = { npmBlocked: false, drive: { online: { claude: { source: 'claude.ai', state: 'done' } } }, handoff: { state: 'login-pending' } };
  assert.equal(JUDGES.npmBlocked(ev).ok, false);
  assert.equal(JUDGES.npmBlocked({ ...ev, npmBlocked: true }).ok, true);
});

test('S05 turns SAC on itself, reboots, then tries the double-click before the documented way round', () => {
  const plan = scenarioPlan('S05', PLAN_OPTS);
  // 깨끗한 상태에서 **매번 켠다** -- 언제 무엇으로 만들어졌는지 모르는
  // `sac-on` 스냅샷에 기대지 않는다(2026-09-15 Task 23d).
  assert.deepEqual(plan[1].args, ['snapshot', BASE_VM, 'restore', 'clean']);
  const phases = plan.map((st) => st.phase);
  assert.ok(phases.includes('reboot'), '정책은 재부팅해야 적용된다');
  // 순서가 뜻이다: SAC 켜기 → 재부팅 → 풀기 → 두 번 누르기 시험 → 우회로 설치.
  assert.ok(phases.indexOf('reboot') < phases.indexOf('extract'));
  assert.ok(phases.indexOf('sac-test') < phases.indexOf('install'));
  const sacTest = plan.find((st) => st.phase === 'sac-test').args.join(' ');
  assert.ok(sacTest.includes('-TestEntry') && sacTest.includes('guest-sac.ps1'));
  assert.ok(plan.some((st) => st.args.join(' ').includes('설치가 안 되면.txt')));
});

test('S09 restores the 1.4.5 snapshot and checks the sentinel + legacy receipt', () => {
  const plan = scenarioPlan('S09', PLAN_OPTS);
  assert.deepEqual(plan[1].args, ['snapshot', BASE_VM, 'restore', 'installed-1.4.5']);
  // 감시 파일·1.x 영수증 확인은 한글 이름을 아는 손님 쪽 스크립트가 한다
  // (한글 이름을 VBoxManage 인자로 넘기면 코드페이지에서 깨질 수 있다).
  const check = plan.filter((st) => st.phase === 'collect')
    .map((st) => st.args.join(' ')).find((t) => t.includes('-Check'));
  assert.ok(check && check.includes(LEGACY_SCRIPT), '설치 뒤 확인 단계');
  // 준비(1.4.5 깔기)는 --legacy-zip 을 줬을 때만 붙는다.
  assert.ok(!plan.some((st) => st.phase === 'install-legacy'), '스냅샷이 있으면 다시 깔지 않는다');
});

test('S09 with --legacy-zip builds the snapshot itself: 1.4.5 -> plant user data -> snapshot -> 2.0.0', () => {
  const plan = scenarioPlan('S09', { ...PLAN_OPTS, legacyZip: 'D:\\out\\IRIS-Setup_v1.4.5.zip' });
  // 되돌릴 곳이 「1.4.5 가 깔린 스냅샷」이 아니라 깨끗한 상태여야 한다.
  assert.deepEqual(plan[1].args, ['snapshot', BASE_VM, 'restore', 'clean']);
  const phases = plan.map((st) => st.phase);
  for (const want of ['install-legacy', 'plant', 'snapshot-stop', 'snapshot-drop', 'snapshot-take', 'install']) {
    assert.ok(phases.includes(want), want);
  }
  // 순서: 1.4.5 설치 → 자료 심기 → 끄기 → 스냅샷 → 2.0.0 설치
  const at = (ph) => phases.indexOf(ph);
  assert.ok(at('install-legacy') < at('plant'));
  assert.ok(at('plant') < at('snapshot-stop'));
  assert.ok(at('snapshot-stop') < at('snapshot-take'));
  assert.ok(at('snapshot-take') < at('install'));
  // 1.4.5 는 **로그인 직전까지만** 간다 -- 운전기의 --legacy 갈래.
  const legacy = plan.find((st) => st.phase === 'install-legacy').args.join(' ');
  assert.ok(legacy.includes('-Legacy'));
  // 같은 이름의 옛 스냅샷은 조용히 이기지 못한다(지우고 다시 찍는다).
  const drop = plan.find((st) => st.phase === 'snapshot-drop').args;
  assert.deepEqual(drop, ['snapshot', BASE_VM, 'delete', 'installed-1.4.5']);
});

test('S02 and S10 run on their own VMs, not the Win11 KO one', () => {
  assert.equal(scenarioPlan('S02', PLAN_OPTS)[1].args[1], 'IRIS-Win10');
  assert.equal(scenarioPlan('S10', PLAN_OPTS)[1].args[1], 'IRIS-Win11-EN');
});

test('S11(없음) restores the Office-free snapshot', () => {
  assert.deepEqual(scenarioPlan('S11', PLAN_OPTS)[1].args, ['snapshot', BASE_VM, 'restore', 'no-office']);
});

test('scenarioPlan refuses the non-VM scenario rather than inventing a VM', () => {
  assert.throws(() => scenarioPlan('S08', PLAN_OPTS), /VM 시나리오가 아닙니다/);
  assert.throws(() => scenarioPlan('S99', PLAN_OPTS), /알 수 없는 시나리오/);
});

test('--collect-only keeps only the evidence steps, so a run that died mid-flight is not thrown away', () => {
  const plan = scenarioPlan('S01', { ...PLAN_OPTS, collectOnly: true });
  assert.ok(plan.length > 0);
  assert.deepEqual([...new Set(plan.map((st) => st.phase))], ['collect']);
  // 되돌리기·켜기·설치가 섞여 들어가면 이미 끝난 설치를 덮어써 증거를 없앤다.
  const text = plan.map((st) => st.args.join(' ')).join('\n');
  assert.ok(!text.includes('snapshot') && !text.includes('startvm') && !text.includes('poweroff'));
});

test('--vm overrides the table so one VM can stand in for another', () => {
  const plan = scenarioPlan('S01', { ...PLAN_OPTS, vm: 'Borrowed' });
  assert.equal(plan[0].args[1], 'Borrowed');
});

test('run.mjs parseArgs requires a known scenario', () => {
  assert.throws(() => runArgs([]), /--scenario/);
  assert.throws(() => runArgs(['--scenario', 'S99']), /알 수 없는 시나리오/);
  assert.equal(runArgs(['--scenario', 's01']).scenario, 'S01');
  assert.equal(runArgs(['--scenario', 'S01', '--dry-run']).dryRun, true);
});

// ---------------------------------------------------------------------------
// run.mjs -- S03/S04: what the human must do, verbatim
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// run.mjs -- 판정 규칙 (조용히 틀리면 아무도 못 보는 자리)
// ---------------------------------------------------------------------------

const STAGE_IDS = ['unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks'];
const goodDiagnostics = ({ mcp = 'pass', fail = 0, pending = 0 } = {}) => ({
  stages: Object.fromEntries(STAGE_IDS.map((id) => [id, { status: 'done' }])),
  checks: { summary: { pass: 11 - fail - pending, pending, fail }, items: [{ id: 'mcp', status: mcp, detail: '7개 중 통과 7개' }] },
  pendingCapabilities: pending ? [{ capability: '문서 자동화(한글)', reason: '한컴 없음' }] : [],
});

test('baseline 판정은 종료 코드 0과 9단계 done 과 검사 실패 0 을 모두 요구한다', () => {
  const ev = { exitCode: 0, diagnostics: goodDiagnostics() };
  assert.equal(JUDGES.baseline(ev).ok, true);
  assert.equal(JUDGES.baseline({ ...ev, exitCode: 1 }).ok, false);
  assert.equal(JUDGES.baseline({ ...ev, diagnostics: null }).ok, false);
  const oneUndone = goodDiagnostics();
  oneUndone.stages.venv = { status: 'failed' };
  assert.match(JUDGES.baseline({ ...ev, diagnostics: oneUndone }).reason, /venv/);
  assert.match(JUDGES.baseline({ ...ev, diagnostics: goodDiagnostics({ fail: 1 }) }).reason, /검사 실패 1건/);
});

test('offline 판정은 실제 종료 코드를 보고, 0으로 갈아 끼우지 않는다', () => {
  const ev = {
    exitCode: 0,
    diagnostics: goodDiagnostics(),
    drive: { online: { net: { ok: false, code: 'E-ONLINE-NET', blocked: ['claude.ai'] } } },
    handoff: { state: 'login-pending' },
  };
  assert.equal(JUDGES.offline(ev).ok, true);
  // 예전 판은 exitCode 를 0 으로 덮어써서 아래가 통과해 버렸다.
  const bad = JUDGES.offline({ ...ev, exitCode: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /종료 코드가 1/);
  assert.equal(EXPECTED_INSTALLER_EXIT, 0);
  // 시나리오가 다른 코드를 기대한다고 명시하면 그 값을 쓴다.
  assert.equal(JUDGES.offline({ ...ev, exitCode: 3, expectExit: 3 }).ok, true);
});

test('offline 판정은 E-ONLINE-NET 과 login-pending 둘 다 없으면 통과시키지 않는다', () => {
  const base = { exitCode: 0, diagnostics: goodDiagnostics(), handoff: { state: 'login-pending' } };
  assert.match(JUDGES.offline({ ...base, drive: { online: { net: { ok: false, code: null } } } }).reason, /E-ONLINE-NET/);
  assert.match(JUDGES.offline({ ...base, drive: null }).reason, /drive-result\.json/);
  assert.match(
    JUDGES.offline({ ...base, drive: { online: { net: { ok: false, code: 'E-ONLINE-NET' } } }, handoff: { state: 'ready' } }).reason,
    /handoff\.state=ready/,
  );
});

test('upgrade 판정은 "확인 못 함"(null)을 통과로 세지 않는다', () => {
  const ev = { exitCode: 0, diagnostics: goodDiagnostics(), legacyReceiptKept: true, sentinelKept: true, drive: { locate: { mode: 'iris-legacy' } } };
  assert.equal(JUDGES.upgrade(ev).ok, true);
  // 옛 폴더를 「예전 판 IRIS」로 알아보지 못하면 자료 보존 시험이 성립하지 않는다.
  assert.match(JUDGES.upgrade({ ...ev, drive: { locate: { mode: 'iris' } } }).reason, /iris-legacy/);
  const unknown = JUDGES.upgrade({ ...ev, sentinelKept: null });
  assert.equal(unknown.ok, false, 'null 은 보존됐다는 뜻이 아니다');
  assert.match(unknown.reason, /확인하지 못했습니다/);
  const gone = JUDGES.upgrade({ ...ev, sentinelKept: false });
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /사라졌습니다/);
  assert.match(JUDGES.upgrade({ ...ev, legacyReceiptKept: false }).reason, /package-receipt\.v1\.json/);
});

test('docPending 판정은 문서 MCP 가 pass 여도 통과시키지 않는다(없음 시나리오다)', () => {
  const pending = { diagnostics: goodDiagnostics({ mcp: 'pending', pending: 1 }) };
  assert.equal(JUDGES.docPending(pending).ok, true);
  assert.match(JUDGES.docPending({ diagnostics: goodDiagnostics({ mcp: 'pass' }) }).reason, /기대: pending/);
  assert.match(JUDGES.docPending({ diagnostics: null }).reason, /diagnostics/);
});

test('sac 판정은 막혔더라도 안내 파일이 있으면 통과이되 사람 확인을 남긴다', () => {
  const on = { sacOn: true, sacState: 1 };
  const blocked = JUDGES.sac({ ...on, exitCode: 1, diagnostics: null, noticeFilePresent: true, motwShellExec: 'blocked' });
  assert.equal(blocked.ok, true);
  assert.ok(blocked.notes.some((n) => n.includes('사람')));
  assert.equal(JUDGES.sac({ ...on, exitCode: 1, diagnostics: null, noticeFilePresent: false }).ok, false);
  assert.equal(JUDGES.sac({ ...on, exitCode: 0, diagnostics: goodDiagnostics() }).ok, true);
});

test('sac 판정은 SAC 가 켜지지 않았으면 통과시키지 않는다(아무것도 시험하지 않은 것이다)', () => {
  // 평가 모드(2) 그대로면 이 시나리오는 SAC 를 한 번도 겪지 않았다.
  const notOn = JUDGES.sac({ sacOn: false, sacState: 2, exitCode: 0, diagnostics: goodDiagnostics() });
  assert.equal(notOn.ok, false);
  assert.match(notOn.reason, /SAC 를 켜지 못했습니다/);
  // 확인 자체를 못 한 경우(null)도 통과가 아니다.
  assert.equal(JUDGES.sac({ sacOn: null, exitCode: 0, diagnostics: goodDiagnostics() }).ok, false);
});

// ---------------------------------------------------------------------------
// report.mjs -- the matrix writer the release gate reads back
// ---------------------------------------------------------------------------

const MATRIX_FIXTURE = [
  '# 제목',
  '',
  '| # | 환경 | 잡는 것 | 어디서 | 결과 | zip 지문 | 날짜 | 근거(로그 경로) |',
  '|---|---|---|---|---|---|---|---|',
  '| S01 | 깨끗한 Windows 11 | 기준선 | VM | 미착수 | | | |',
  '| S08 | 기존 Node 있는 PC | 동봉본 우선 | 이 PC 본계정 | 미착수 | | | |',
  '| S12 | 회사 PC | 현장 | 베타 | 미착수 | | | |',
  '',
].join('\n');

test('parseMatrix reads exactly the rows the release gate regex reads', () => {
  const rows = parseMatrix(MATRIX_FIXTURE);
  assert.deepEqual(rows.map((r) => r.id), ['S01', 'S08', 'S12']);
  assert.equal(rows[0].where, 'VM');
  assert.equal(rows[0].result, '미착수');
});

test('a row this writer produces is still readable by the gate regex', () => {
  const after = setRow(MATRIX_FIXTURE, {
    id: 'S08', result: '통과', fingerprint: 'd3e5f3193ac9', date: '2026-09-15',
    evidence: '_agent\\setup\\diagnostics.json',
  });
  const line = after.split('\n').find((l) => l.startsWith('| S08 '));
  const m = ROW_RE.exec(line);
  assert.ok(m, '갱신한 행을 릴리스 게이트 정규식이 다시 읽어야 한다');
  assert.equal(m[5].trim(), '통과');
  assert.equal(m[6].trim(), 'd3e5f3193ac9');
  assert.equal(m[7].trim(), '2026-09-15');
  assert.equal(m[8].trim(), '_agent\\setup\\diagnostics.json');
  // 환경·잡는 것·어디서 열은 건드리지 않는다.
  assert.equal(m[2].trim(), '기존 Node 있는 PC');
  assert.equal(m[4].trim(), '이 PC 본계정');
});

test('only the three allowed result words are accepted', () => {
  for (const r of RESULTS) {
    assert.doesNotThrow(() => setRow(MATRIX_FIXTURE, { id: 'S01', result: r }));
  }
  assert.throws(() => setRow(MATRIX_FIXTURE, { id: 'S01', result: '부분 통과' }), /통과/);
  assert.throws(() => setRow(MATRIX_FIXTURE, { id: 'S01', result: 'PASS' }), /통과/);
});

test('a bad fingerprint is refused rather than written as "낡음" forever', () => {
  assert.throws(() => setRow(MATRIX_FIXTURE, { id: 'S01', result: '통과', fingerprint: 'D3E5F3193AC9' }), /소문자 hex 12자/);
  assert.throws(() => setRow(MATRIX_FIXTURE, { id: 'S01', result: '통과', fingerprint: 'abc' }), /소문자 hex 12자/);
  assert.doesNotThrow(() => setRow(MATRIX_FIXTURE, { id: 'S01', result: '통과', fingerprint: '0123456789ab' }));
});

test('a missing row is an error, not a silently appended one', () => {
  assert.throws(() => setRow(MATRIX_FIXTURE, { id: 'S99', result: '통과' }), /S99 행이 없습니다/);
});

test('a pipe inside evidence text cannot split the row', () => {
  const after = setRow(MATRIX_FIXTURE, { id: 'S01', result: '통과', evidence: 'a|b|c' });
  const line = after.split('\n').find((l) => l.startsWith('| S01 '));
  assert.ok(ROW_RE.exec(line));
  assert.match(line, /a\/b\/c/);
});

test('formatRow keeps the eight-cell shape', () => {
  const line = formatRow({ id: 'S01', env: 'e', catches: 'c', where: 'w', result: '통과', fingerprint: '', date: '', evidence: '' });
  assert.equal(line.split('|').length - 2, 8);
});

test('updateRow keeps the file’s line ending and reports whether it changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-vm-test-'));
  const file = path.join(dir, 'matrix.md');
  try {
    fs.writeFileSync(file, Buffer.from(MATRIX_FIXTURE.replace(/\n/g, '\r\n'), 'utf8'));
    assert.equal(updateRow(file, { id: 'S01', result: '통과', fingerprint: '0123456789ab', date: '2026-09-15', evidence: 'x' }), true);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('\r\n'), 'CRLF 원본을 LF 로 바꾸지 않는다 (R-022)');
    assert.equal(text.split('\n').filter((l) => l.trim() && !l.includes('\r')).length, 0);
    assert.equal(updateRow(file, { id: 'S01', result: '통과', fingerprint: '0123456789ab', date: '2026-09-15', evidence: 'x' }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fingerprintOfZip gives the 12 lowercase hex chars the gate compares', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-vm-test-'));
  const file = path.join(dir, 'a.zip');
  try {
    fs.writeFileSync(file, 'hello');
    const fp = fingerprintOfZip(file);
    assert.match(fp, /^[0-9a-f]{12}$/);
    // sha256("hello") = 2cf24dba5fb0a30e...
    assert.equal(fp, '2cf24dba5fb0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the real docs/시험행렬.md must stay machine-readable
// ---------------------------------------------------------------------------

test('docs/시험행렬.md still parses into S01..S12 with legal result words', () => {
  const rows = parseMatrix(fs.readFileSync(MATRIX_FILE, 'utf8'));
  assert.deepEqual(rows.map((r) => r.id), ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12']);
  for (const r of rows) {
    assert.ok(RESULTS.includes(r.result), `${r.id} 결과 열 "${r.result}" 은 허용 목록에 없다`);
    if (r.result === '통과') assert.match(r.fingerprint, /^[0-9a-f]{12}$/, `${r.id} 통과 행에는 zip 지문이 있어야 한다`);
  }
});

test('the matrix never carries this PC’s absolute paths (저장소 청결)', () => {
  const rows = parseMatrix(fs.readFileSync(MATRIX_FILE, 'utf8'));
  for (const r of rows) {
    assert.doesNotMatch(r.evidence, new RegExp(`${DRIVE}\\\\Users`, 'i'), r.id);
    assert.doesNotMatch(r.evidence, new RegExp(`${DRIVE}\\\\IRIS\\\\R0`, 'i'), r.id);
  }
});

// ---------------------------------------------------------------------------
// verify/e2e.mjs -- 순수 판정 함수 두 개
// ---------------------------------------------------------------------------
//
// 여기 두는 이유: 이 둘은 3층 실행 **중간에만** 돌아서(고장 주입 9회 ≒ 11분,
// 두 번 실행 비교) 손으로 확인하기가 비싸다. 같은 커밋의 검증 도구이므로
// 같은 시험 파일에서 겨눈다.

test('checkResumeShape: 앞은 그대로, 주입 단계부터는 새 시각이어야 통과', () => {
  const before = {};
  const after = {};
  // venv 에서 멈춘 상황: 앞 네 단계 done, venv 는 failed, 뒤는 아예 없음.
  STAGE_IDS.forEach((id, i) => {
    if (i < 4) { before[id] = { status: 'done', finishedAt: `T${i}` }; after[id] = { status: 'done', finishedAt: `T${i}` }; return; }
    before[id] = i === 4 ? { status: 'failed', finishedAt: 'X' } : null;
    after[id] = { status: 'done', finishedAt: `N${i}` };
  });
  const ok = checkResumeShape('venv', before, after);
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.detail, /앞 4단계 그대로/);
  assert.match(ok.detail, /venv부터 5단계 새로 실행/);
});

test('checkResumeShape: 앞 단계가 다시 돌면 실패 (재개가 아니라 전체 재실행)', () => {
  const before = {};
  const after = {};
  STAGE_IDS.forEach((id, i) => {
    before[id] = i < 4 ? { status: 'done', finishedAt: `T${i}` } : (i === 4 ? { status: 'failed', finishedAt: 'X' } : null);
    after[id] = { status: 'done', finishedAt: `N${i}` }; // 전부 새 시각 = 처음부터 다시 돌았다
  });
  const bad = checkResumeShape('venv', before, after);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /건너뛰지 않고 다시 돌았다/);
});

test('checkResumeShape: 주입 단계가 그대로면 실패 (다시 돌지 않았다)', () => {
  const before = {};
  const after = {};
  STAGE_IDS.forEach((id, i) => {
    before[id] = i < 4 ? { status: 'done', finishedAt: `T${i}` } : (i === 4 ? { status: 'done', finishedAt: 'X' } : null);
    after[id] = i <= 4 ? { status: 'done', finishedAt: i < 4 ? `T${i}` : 'X' } : { status: 'done', finishedAt: `N${i}` };
  });
  const bad = checkResumeShape('venv', before, after);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /다시 돌지 않았다/);
});

test('fingerprintTree: 같은 길이의 다른 내용을 잡고, 못 읽은 것을 삼키지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-fp-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'AAAA');
    const first = fingerprintTree(dir);
    assert.equal(first.errors.length, 0);
    assert.equal(first.count, 1);

    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'BBBB'); // 같은 크기, 다른 내용
    const second = fingerprintTree(dir);
    assert.notEqual(second.hash, first.hash, '크기만 보던 옛 판은 이 변화를 놓쳤다');

    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'AAAA');
    assert.equal(fingerprintTree(dir).hash, first.hash, '되돌리면 같은 지문');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fingerprintTree: 없는 폴더는 errors 로 보고한다(조용히 0개가 아니다)', () => {
  const gone = path.join(os.tmpdir(), `iris-fp-missing-${Date.now()}`);
  const r = fingerprintTree(gone);
  assert.equal(r.count, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /readdir/);
});

// A fake-driven smoke test of makeVbox wiring: the plan a scenario produces is
// exactly what the runner would hand the hypervisor, call for call.
test('a scenario plan replayed through a fake VBoxManage records the same argv', () => {
  const { exec, calls } = fakeExec();
  const vbox = makeVbox({ exec });
  const plan = scenarioPlan('S06', PLAN_OPTS);
  for (const step of plan) vbox(step.args, { allowFail: true });
  // calls[0] is the --version probe findVBoxManage does once.
  assert.deepEqual(calls.slice(1).map((c) => c.args), plan.map((s) => s.args));
  assert.ok(calls.every((c) => c.exe === 'VBoxManage'));
});
