// verify/vm/create.mjs -- build one base VM, unattended-install Windows into
// it, wait for guest control, and snapshot it. Every 4층 scenario run
// (verify/vm/run.mjs) restores a snapshot made here, so each test starts from
// an identical, never-touched-by-a-previous-test install.
//
// Status (T23): NOT executed -- VirtualBox is absent on this PC (README.md).
// `createPlan()` is pure and unit-tested (tests/vm.test.mjs), so the argument
// arrays below are pinned even though no hypervisor has seen them yet.
//
// Usage:
//   $env:IRIS_VM_PASSWORD = "<password for the guest account>"
//   node verify/vm/create.mjs --name IRIS-Win11 --iso "<...>\win11-enterprise-eval-ko-kr.iso"
//   node verify/vm/create.mjs --name IRIS-Win10 --iso "<...>\win10-enterprise-eval-ko-kr.iso" --ostype Windows10_64
//   node verify/vm/create.mjs --name IRIS-Win11-EN   --iso "<...>\win11-enterprise-eval-en-us.iso" --locale en_US --language en-US --country US
//
// The password is never a CLI argument of THIS script -- only IRIS_VM_PASSWORD.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeVbox, requirePassword, requireFile, log, waitForGuestControl,
  parseAttachments, detachOpticalPlan, bootFromDiskPlan, waitForPowerOff,
  findVBoxManage,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = Object.freeze({
  memory: 4096,
  cpus: 2,
  diskMb: 65536, // Windows 11 minimum is 64 GB
  user: 'tester',
  fullName: 'Tester',
  timezone: 'Asia/Seoul',
  locale: 'ko_KR',
  language: 'ko-KR',
  country: 'KR',
  snapshot: 'clean',
  ostype: 'Windows11_64',
  // 평가판 ISO 의 install.wim 안 판(edition) 번호. Enterprise 평가판은 1번
  // 하나뿐이지만 명시해 두면 판이 여럿인 ISO 에서도 멈추지 않는다.
  imageIndex: 1,
  // `unattended install` 이 VM 을 직접 켤 때 쓰는 창 방식. headless 여야
  // 자동화 셸에서 창 없이 돈다(gui 로 두면 사람 화면을 차지한다).
  sessionType: 'headless',
  // 권한 굽기(Task 23e). **기본 켜짐** -- 안 구우면 S03·S04·S05·S07·S09 는
  // 시작조차 못 한다(bake.ps1 머리말이 이유의 정본). `--no-bake` 로 끈다.
  bake: true,
  bakeScript: 'bake.ps1',
});

// 굽기 블록을 끼워 넣을 자리. Oracle 이 주는 win_postinstall.cmd 안의 이 줄
// **앞**에 넣는다 -- 그 아래는 무인설치 매체를 치우는 마무리라, 그 뒤에 넣으면
// 우리 블록이 정리된 환경에서 돌게 된다.
export const POST_INSTALL_ANCHOR =
  'rem Eject/rename no longer needed unattended install configuration and media.';
export const STOCK_POST_INSTALL = 'win_postinstall.cmd';

export function parseArgs(argv) {
  const opts = { ...DEFAULTS, name: null, iso: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') opts.name = argv[++i];
    else if (a === '--iso') opts.iso = path.resolve(argv[++i]);
    else if (a === '--memory') opts.memory = Number(argv[++i]);
    else if (a === '--cpus') opts.cpus = Number(argv[++i]);
    else if (a === '--disk-mb') opts.diskMb = Number(argv[++i]);
    else if (a === '--user') opts.user = argv[++i];
    else if (a === '--snapshot') opts.snapshot = argv[++i];
    else if (a === '--ostype') opts.ostype = argv[++i];
    else if (a === '--locale') opts.locale = argv[++i];
    else if (a === '--language') opts.language = argv[++i];
    else if (a === '--country') opts.country = argv[++i];
    else if (a === '--image-index') opts.imageIndex = Number(argv[++i]);
    else if (a === '--session-type') opts.sessionType = argv[++i];
    else if (a === '--bake') opts.bake = true;
    else if (a === '--no-bake') opts.bake = false;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!opts.name) throw new Error('--name <vm-name> is required');
  if (!opts.iso) throw new Error('--iso <path-to-iso> is required');
  return opts;
}

// ---------------------------------------------------------------------------
// 권한 굽기 (Task 23e) -- 전부 순수 함수다. tests/vm.test.mjs 가 여기를 고정한다.
// ---------------------------------------------------------------------------

/**
 * cmdEchoLines(text, file) -> `(echo <line>)>>file` 줄들.
 *
 * 왜 괄호로 감싸는가(cmd 의 함정): `echo abc1>>f` 에서 `1>` 는 **스트림 1번
 * 리다이렉션**으로 읽힌다. base64 는 숫자로 끝나는 줄이 흔하므로 그대로 두면
 * 줄 끝 숫자가 통째로 사라진다. `(echo abc1)>>f` 는 리다이렉션이 괄호 밖이라
 * 안전하다. 같은 이유로 `echo x >>f` 처럼 공백을 넣어도 안 된다(공백이 파일에 들어간다).
 */
export function cmdEchoLines(text, file) {
  return String(text).split('\n').filter((l) => l !== '').map((l) => `(echo ${l})>>${file}`);
}

export function chunk64(b64, width = 76) {
  const out = [];
  for (let i = 0; i < b64.length; i += width) out.push(b64.slice(i, i + width));
  return out.join('\n');
}

/**
 * bakeBlock({ bakeB64, passwordB64, root }) -> 생성된 .cmd 에 끼워 넣을 텍스트.
 *
 * 순수 ASCII 여야 한다 -- 이 텍스트는 보조 ISO 의 VBOXPOST.CMD 가 되고, cmd 는
 * 그 파일을 시스템 코드페이지로 읽는다. 그래서 한글이 든 bake.ps1 은 통째로
 * base64 로 실어 보내고(BOM 포함), 손님 안에서 certutil 이 되돌린다.
 * 비밀번호도 base64 로만 넘긴다 -- cmd 인용 규칙과 로그를 동시에 피한다.
 */
export function bakeBlock({ bakeB64, passwordB64, root = 'C:\\iris-vm' }) {
  const b64 = `${root}\\bake.b64`;
  const ps1 = `${root}\\bake.ps1`;
  return [
    'rem --- IRIS rig bake begin (verify/vm/create.mjs --bake) ---------------',
    'echo *** IRIS bake start >> %MY_LOG_FILE%',
    `mkdir ${root} 2>nul`,
    `if exist ${b64} del /q ${b64}`,
    ...cmdEchoLines(chunk64(bakeB64), b64),
    `certutil -f -decode ${b64} ${ps1} >> %MY_LOG_FILE% 2>&1`,
    `del /q ${b64}`,
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${ps1} -PasswordB64 "${passwordB64}" >> ${root}\\bake-run.log 2>&1`,
    'echo *** IRIS bake ERRORLEVEL: %ERRORLEVEL% >> %MY_LOG_FILE%',
    'rem --- IRIS rig bake end -------------------------------------------------',
    '',
  ].join('\r\n');
}

export function buildPostInstallTemplate(stockText, block) {
  const text = String(stockText);
  if (!text.includes(POST_INSTALL_ANCHOR)) {
    throw new Error(`post-install template anchor not found (looked for: ${POST_INSTALL_ANCHOR}). `
      + 'Oracle changed win_postinstall.cmd -- re-read it and move the anchor.');
  }
  return text.replace(POST_INSTALL_ANCHOR, `${block}${POST_INSTALL_ANCHOR}`);
}

// Oracle 이 설치해 주는 원본 템플릿 자리. VBoxManage.exe 옆의 UnattendedTemplates\.
export function stockTemplatePath(vboxExe, file = STOCK_POST_INSTALL) {
  const exe = String(vboxExe ?? '');
  const dir = exe.includes('\\') || exe.includes('/')
    ? path.dirname(exe)
    : 'C:\\Program Files\\Oracle\\VirtualBox';
  return path.join(dir, 'UnattendedTemplates', file);
}

// 답변 파일(autounattend.xml) 틀. Oracle 의 win_nt6_unattended.xml 은 제품 키를
// 안 줘도 `<ProductKey><Key></Key>…</ProductKey>` 를 **빈 채로** 넣는다
// (VirtualBox 버그 #19839·#21712). Windows 11 설치기는 빈 키를 넘기지만
// **Windows 10(19041) 평가판은 첫 화면에서 「Microsoft 소프트웨어 사용 조건을
// 찾을 수 없습니다」로 멈춘다**(2026-09-18 IRIS-Win10 실측, 90 분 무응답).
// 평가판은 제품 키가 필요 없으므로 그 블록을 통째로 뺀 사본을 --script-template 로 넘긴다.
export const STOCK_SCRIPT_TEMPLATE = 'win_nt6_unattended.xml';
const PRODUCT_KEY_BLOCK_RE = /^[ \t]*<ProductKey>[\s\S]*?<\/ProductKey>[ \t]*\r?\n/m;

/** Windows 10 setup stops at the license-terms screen on an empty <ProductKey>; Windows 11 does not. */
export function needsProductKeyStrip(ostype) {
  return /^Windows10/i.test(String(ostype ?? ''));
}

export function buildScriptTemplate(stockText) {
  const text = String(stockText);
  if (!PRODUCT_KEY_BLOCK_RE.test(text)) {
    throw new Error('script template: <ProductKey> block not found in win_nt6_unattended.xml -- '
      + 'Oracle changed the template; re-read it before stripping.');
  }
  const out = text.replace(PRODUCT_KEY_BLOCK_RE, '');
  if (/<ProductKey>/.test(out)) throw new Error('script template: more than one <ProductKey> block -- refusing to guess.');
  return out;
}

/**
 * createPlan(opts, { password, diskPath }) -> VBoxManage argument arrays, in
 * order. Pure: no process, no filesystem. This is the thing tests pin.
 *
 * Windows 11 refuses to install without EFI + TPM 2.0 + Secure Boot.
 *
 * 2026-09-15 실측(VirtualBox 7.2.16)으로 고친 것 — 이 셋은 문서만 보고 쓴
 * 철자가 실제 도구와 달랐던 자리다:
 *   ⓐ `modifyvm --secure-boot on` 은 **없는 스위치**다. 보안 부팅은 NVRAM
 *      쪽 하위 명령 셋(`modifynvram <vm> inituefivarstore` →
 *      `enrollmssignatures` → `secureboot --enable`)으로 켠다.
 *   ⓑ `unattended install --password=` 도 없다. 실제 이름은
 *      `--user-password=`(+ 관리자용 `--admin-password=`)다.
 *   ⓒ `unattended install` 은 준비만 하고 VM 을 켜지 않는다. `--start-vm=`
 *      을 주지 않으면 손님 제어가 영원히 올라오지 않는다.
 *   ⓓ `--usbxhci`(USB 3.0)는 확장팩이 있어야 한다. 이 PC 는 확장팩 0개라
 *      기본 패키지에 있는 `--usbohci` 로 바꿨다(시험에 USB 는 필요 없다).
 */
export function createPlan(opts, { password, diskPath, postInstallTemplate = null, scriptTemplate = null }) {
  return [
    ['createvm', '--name', opts.name, '--ostype', opts.ostype, '--register'],
    [
      'modifyvm', opts.name,
      '--memory', String(opts.memory),
      '--cpus', String(opts.cpus),
      '--vram', '128',
      '--graphicscontroller', 'vmsvga',
      '--firmware', 'efi',
      '--chipset', 'ich9',
      '--ioapic', 'on',
      '--rtc-use-utc', 'on',
      '--usbohci', 'on',
      '--nic1', 'nat',
    ],
    ['modifyvm', opts.name, '--tpm-type', '2.0'],
    ['modifynvram', opts.name, 'inituefivarstore'],
    ['modifynvram', opts.name, 'enrollmssignatures'],
    // 플랫폼 키(PK)가 등록돼 있지 않으면 `secureboot --enable` 이
    // "platform key (PK) is not enrolled" 로 거절한다(2026-09-15 실측).
    // Oracle 이 넣어 주는 기본 PK 를 먼저 등록한다.
    ['modifynvram', opts.name, 'enrollorclpk'],
    ['modifynvram', opts.name, 'secureboot', '--enable'],
    ['createmedium', 'disk', '--filename', diskPath, '--size', String(opts.diskMb), '--format', 'VDI'],
    ['storagectl', opts.name, '--name', 'SATA Controller', '--add', 'sata', '--controller', 'IntelAhci'],
    ['storageattach', opts.name, '--storagectl', 'SATA Controller', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', diskPath],
    ['storagectl', opts.name, '--name', 'IDE Controller', '--add', 'ide'],
    ['modifyvm', opts.name, '--boot1', 'dvd', '--boot2', 'disk', '--boot3', 'none', '--boot4', 'none'],
    [
      'unattended', 'install', opts.name,
      `--iso=${opts.iso}`,
      `--user=${opts.user}`,
      `--user-password=${password}`,
      `--admin-password=${password}`,
      `--full-user-name=${opts.fullName}`,
      '--install-additions',
      `--time-zone=${opts.timezone}`,
      `--locale=${opts.locale}`,
      `--language=${opts.language}`,
      `--country=${opts.country}`,
      `--image-index=${opts.imageIndex}`,
      // 굽기는 **여기 한 자리**로 들어간다. Oracle 의 win_postinstall.cmd 를
      // 그대로 쓰되 우리 블록 하나를 끼운 사본을 넘긴다(buildPostInstallTemplate).
      // `--post-install-command` 는 "명령 한 줄"뿐이라 우리 블록(수십 줄)을 담지 못한다.
      ...(postInstallTemplate ? [`--post-install-template=${postInstallTemplate}`] : []),
      // 제품 키 블록을 뺀 답변 틀(buildScriptTemplate). 없으면 Windows 10 평가판이 멈춘다.
      ...(scriptTemplate ? [`--script-template=${scriptTemplate}`] : []),
      `--start-vm=${opts.sessionType}`,
    ],
  ];
}

export function snapshotPlan(opts) {
  return [['snapshot', opts.name, 'take', opts.snapshot,
    '--description', 'post-install clean state, before any test-matrix file copy']];
}

/**
 * finalizePlan(opts, { machineReadable }) -> 스냅샷을 찍기 **전에** 보낼 것들.
 *
 * 2026-09-15 Task 23d 신설. Task 23c 가 손으로 당한 두 가지를 스크립트가 대신한다:
 *   ⓐ 무인설치 보조 VISO 가 붙은 채 스냅샷을 찍으면, 그 스냅샷을 되살려 냉부팅했을 때
 *      **Windows 설치가 처음부터 다시 돈다**(실측). → 광학 매체를 전부 뗀다.
 *   ⓑ 켜진 채(saved-state) 찍은 스냅샷은 이 판에서 되살아나지 않았다(startvm 이 거절).
 *      → ACPI 전원 단추로 정상 종료한 뒤 **꺼진 상태**에서 찍는다.
 * 순서가 중요하다: 먼저 끄고(전원이 들어온 채 매체를 떼면 손님이 놀란다),
 * 그다음 떼고, 부팅 순서를 디스크로 고정하고, 마지막에 스냅샷.
 */
export function finalizePlan(opts, { machineReadable = '' } = {}) {
  const attachments = parseAttachments(machineReadable);
  return [
    ['controlvm', opts.name, 'acpipowerbutton'],   // ← 이 뒤에 waitForPowerOff 가 들어간다
    ...detachOpticalPlan(opts.name, attachments),
    bootFromDiskPlan(opts.name),
    ...snapshotPlan(opts),
  ];
}

export async function main(argv = process.argv.slice(2), { vbox = makeVbox(), env = process.env } = {}) {
  const opts = parseArgs(argv);
  const password = requirePassword(env);
  requireFile(opts.iso, 'ISO');

  const ver = vbox(['--version']);
  log(`VirtualBox ${ver.out}`);

  // The disk has to live next to the VM config, which VBox only tells us
  // after createvm -- so the plan is built in two halves around that call.
  log(`creating VM "${opts.name}" (${opts.ostype})...`);
  vbox(['createvm', '--name', opts.name, '--ostype', opts.ostype, '--register']);
  const vmInfo = vbox(['showvminfo', opts.name, '--machinereadable']);
  const cfg = vmInfo.out.match(/CfgFile="(.*?)"/);
  const diskPath = cfg ? path.join(path.dirname(cfg[1]), `${opts.name}.vdi`) : `${opts.name}.vdi`;

  // --- 권한 굽기 템플릿 만들기 (Task 23e) --------------------------------
  // 생성물은 **VM 폴더 안**에 둔다: 경로가 ASCII 라 VBoxManage 가 확실히 읽고,
  // 그 VM 의 부속물이라 자리도 맞다. 비밀번호(base64)가 들어 있으므로
  // `unattended install` 이 보조 ISO 로 구워 간 직후 지운다.
  let postInstallTemplate = null;
  if (opts.bake) {
    const src = requireFile(path.join(HERE, opts.bakeScript), 'bake script');
    const stock = requireFile(stockTemplatePath(findVBoxManage()), 'stock post-install template');
    const bakeB64 = fs.readFileSync(src).toString('base64');
    const passwordB64 = Buffer.from(password, 'utf8').toString('base64');
    const block = bakeBlock({ bakeB64, passwordB64 });
    postInstallTemplate = path.join(path.dirname(cfg ? cfg[1] : '.'), `${opts.name}-postinstall.cmd`);
    fs.writeFileSync(postInstallTemplate, buildPostInstallTemplate(fs.readFileSync(stock, 'latin1'), block), 'latin1');
    log(`bake: ${path.basename(src)} (${bakeB64.length} b64 chars) -> ${path.basename(postInstallTemplate)}`);
  } else {
    log('bake: OFF (--no-bake) -- S03/S04/S05/S07/S09 will have no elevation channel.');
  }

  // --- 답변 틀: 제품 키 블록 제거 — **Windows 10 에만** ---------------------------
  // Windows 11 평가판은 빈 키를 그대로 넘기고(기준 VM IRIS-Win11-v2, 2026-09-16), 오히려 블록을
  // 뺀 틀로 만든 IRIS-Win11-EN 은 두 번 다 「Installing 42%」에서 30분 넘게 멈췄다(2026-09-18
  // 17:46·20:35 실측, CPU 는 계속 바쁨). 검증된 길에서 벗어나지 않도록 Win10 에만 뺀다.
  // 비밀은 없으니(비밀번호는 VBoxManage 가 따로 채움) 진단용으로 VM 폴더에 남긴다.
  let scriptTemplate = null;
  if (needsProductKeyStrip(opts.ostype)) {
    scriptTemplate = path.join(path.dirname(cfg ? cfg[1] : '.'), `${opts.name}-unattended.xml`);
    const stockXml = requireFile(stockTemplatePath(findVBoxManage(), STOCK_SCRIPT_TEMPLATE), 'stock answer-file template');
    fs.writeFileSync(scriptTemplate, buildScriptTemplate(fs.readFileSync(stockXml, 'utf8')), 'utf8');
    log(`answer file: ${STOCK_SCRIPT_TEMPLATE} minus <ProductKey> -> ${path.basename(scriptTemplate)} (${opts.ostype})`);
  } else {
    log(`answer file: Oracle stock template (${opts.ostype} tolerates the empty <ProductKey>)`);
  }

  const plan = createPlan(opts, { password, diskPath, postInstallTemplate, scriptTemplate }).slice(1); // createvm already ran
  for (const args of plan) {
    const isInstall = args[0] === 'unattended';
    log(isInstall ? `starting unattended install from ${opts.iso} (30-60 min)...` : `VBoxManage ${args[0]} ${args[1] ?? ''}`);
    vbox(args, isInstall ? { timeout: 20 * 60 * 1000, captureOutput: false } : {});
    if (isInstall && postInstallTemplate) {
      // 템플릿은 이미 보조 ISO 안으로 들어갔다. 호스트 쪽 사본은 비밀번호를
      // 갖고 있으니 남기지 않는다(손님 안 사본은 스냅샷과 함께 사라진다).
      fs.rmSync(postInstallTemplate, { force: true });
      log('bake: generated template removed from the host (it carried the password).');
    }
  }

  log('polling guest control (up to 90 min) for install completion...');
  const ready = await waitForGuestControl(vbox, opts.name, opts.user, password, { pollMs: 5 * 60 * 1000, maxMs: 90 * 60 * 1000 });
  if (!ready) {
    log(`WARNING: guest control did not answer within 90 minutes. Inspect with \`VBoxManage showvminfo ${opts.name}\`.`);
    process.exitCode = 2;
    return;
  }

  // --- 굽기가 실제로 됐는지 확인 (Task 23e) --------------------------------
  // 「구웠다」를 믿지 않고 손님 안 baked.json 을 읽어 본다. 없으면 경고로 남기고
  // 계속 간다 -- 기준 VM 자체는 쓸 수 있고, 무엇이 안 됐는지는 사람이 봐야 한다.
  if (opts.bake) {
    const probe = vbox([
      'guestcontrol', opts.name, 'run', '--username', opts.user, '--password', password, '--profile',
      '--exe', 'C:\\Windows\\System32\\cmd.exe', '--wait-stdout', '--wait-stderr',
      '--', 'cmd.exe', '/c', 'type C:\\iris-vm\\baked.json',
    ], { allowFail: true, timeout: 60 * 1000 });
    if (probe.code === 0 && probe.out.includes('elevationQueue')) {
      log(`bake: baked.json is present in the guest (${probe.out.length} bytes).`);
    } else {
      log('WARNING: bake ran but C:\\iris-vm\\baked.json is missing or unreadable. '
        + 'Inspect C:\\vboxpostinstall.log and C:\\iris-vm\\bake-run.log inside the guest.');
    }
  }

  // --- 스냅샷 전 마무리 (Task 23d) ---------------------------------------
  // 여기서 하는 일은 finalizePlan 의 주석이 정본이다: 정상 종료 → 광학 매체 떼기
  // → 부팅 순서 디스크 고정 → 꺼진 상태 스냅샷.
  const info = vbox(['showvminfo', opts.name, '--machinereadable'], { allowFail: true });
  const plan2 = finalizePlan(opts, { machineReadable: info.out });
  for (const args of plan2) {
    log(`VBoxManage ${args[0]} ${args[2] ?? args[1] ?? ''}`);
    vbox(args, { allowFail: args[1] === 'acpipowerbutton' || args[2] === 'acpipowerbutton' });
    if (args[2] === 'acpipowerbutton') {
      log('게스트가 스스로 꺼지기를 기다립니다(최대 5분)...');
      const st = await waitForPowerOff(vbox, opts.name);
      log(`VM 상태: ${st}`);
    }
  }
  log(`done. VM "${opts.name}" is installed and snapshotted as "${opts.snapshot}" (powered off, no install media attached).`);
  log(`next: node verify/vm/run.mjs --scenario S01 --vm ${opts.name} --zip <path-to-IRIS-zip>`);
}

const isMain = process.argv[1] && process.argv[1].endsWith('create.mjs');
if (isMain) main().catch((e) => { console.error(`create.mjs: ${e.message}`); process.exitCode = 1; });
