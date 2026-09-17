// verify/vm/run.mjs -- one scenario of the 4층 시험 행렬, start to finish.
//
//   node verify/vm/run.mjs --scenario S01 --zip <path-to-IRIS-Setup.zip>
//
// For a VM scenario that is: 스냅샷 복원 → 시나리오 준비(망 끊기 / hosts 막기 /
// SAC 켠 스냅샷 / 1.4.5 설치된 스냅샷 / 영어 UI 스냅샷) → zip 복사 → 게스트에서
// 풀기 → `cmd /c IRIS-설치.cmd` → `diagnostics.json`·로그 회수 → 판정 →
// `docs/시험행렬.md` 한 행 갱신(verify/vm/report.mjs).
//
// Status (T23d, 2026-09-15): VirtualBox 7.2.16 is installed and these scenarios
// have actually run against the frozen 2.0.0 build -- 결과는 docs/시험행렬.md 와
// .superpowers/sdd/구현계획-v2/task-23d-report.md 가 정본이다. tests/vm.test.mjs
// 는 여전히 가짜 VBoxManage 로 **보내는 명령**을 고정하고, `--dry-run` 은 그
// 명령만 보여 준다.
//
// One scenario family is deliberately NOT a VM:
//   S08·S11(있음)  이 PC 본계정 — run by `node verify/e2e.mjs --scenario s08`,
//            which installs into C:\IRIS-s08 and proves this PC's own C:\IRIS,
//            PATH, desktop and .claude* were untouched.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeVbox, requirePassword, requireFile, log, waitForGuestControl, hasVBoxManage,
  guestRunCmd, guestRunPs, guestRunPsFile, guestCopyTo, guestCopyFrom,
} from './lib.mjs';
import { updateRow, matrixPath } from './report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

export const ENTRY = 'IRIS-설치.cmd';
// 기준 VM 의 이름. 2026-09-16(Task 23e)에 `IRIS-Win11` → `IRIS-Win11-v2` 로 옮겼다:
// v2 는 무인 설치 때 **권한 상승 통로를 구워 넣은** 첫 기준 이미지다(verify/vm/bake.ps1).
// 옛 `IRIS-Win11` 도 그대로 남아 있고 `--vm IRIS-Win11` 로 고를 수 있지만, 거기에는
// 그 통로가 없어 S03·S04·S05·S07 준비가 UAC 앞에서 선다.
export const BASE_VM = 'IRIS-Win11-v2';
// 손님 안에서 화면을 대신 눌러 주는 두 벌(같은 폴더에 있다).
export const RUNNER = 'guest-run.ps1';
export const DRIVER = 'guest-drive.mjs';
export const DRIVE_RESULT = 'drive-result.json';
// 손님 안 계정 시나리오(S03·S04)와 SAC 시나리오(S05)가 쓰는 준비 스크립트.
export const ACCOUNT_PREP = 'guest-account.ps1';
export const USER_PREP = 'guest-user-prep.ps1';
export const SAC_SCRIPT = 'guest-sac.ps1';
export const LEGACY_SCRIPT = 'guest-legacy.ps1';
export const HOSTS_SCRIPT = 'guest-hosts.ps1';
// 손님 안에서 관리자 권한이 필요한 일을 대신 돌려 주는 문(실측 정본 = 그 파일 머리말).
export const ELEVATE_SCRIPT = 'guest-elevate.ps1';
export const ELEVATE_OUT = `${'C:'}\\Users\\Public\\iris-elevated-result.txt`;

/**
 * elevateArgs({ script, argumentLine }) -> guest-elevate.ps1 에 줄 인자 배열.
 *
 * 2026-09-16(Task 23e). 왜 base64 인가:
 * VBoxManage 는 `--` 뒤 인자들의 묶음을 지켜 주지 않는다(lib.mjs 주석). 그래서
 * `-Arguments '-Fixture s03 -Password abc'` 처럼 **공백이 든 한 덩어리**를 넘기면
 * 손님 쪽에서 토막으로 쪼개져 엉뚱하게 해석된다. base64 는 `A-Za-z0-9+/=` 뿐이라
 * 쪼개질 공백이 없고, cmd 의 인용·이스케이프 규칙도 건드리지 않는다.
 * (한글 인자나 비밀번호를 넘길 때도 같은 이유로 이 길을 쓴다.)
 */
export const argsB64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
export function elevateArgs({ script, argumentLine, out = ELEVATE_OUT }) {
  return ['-Script', script, '-ArgumentsB64', argsB64(argumentLine), '-Out', out];
}
// S09 가 1.4.5 를 깔아 둔 상태에 붙이는 스냅샷 이름.
export const LEGACY_SNAPSHOT = 'installed-1.4.5';
// 손님 안 시험 계정 이름. **정본은 guest-account.ps1 안**이다(한글+공백 이름을
// VBoxManage 인자로 넘길 수 없어서 -- lib.mjs 의 guestRunPsFile 주석 참조).
// 여기 있는 것은 그 계정으로 **명령을 보낼 때** 쓰는 사본이며 둘은 같아야 한다.
export const ACCOUNT_NAMES = Object.freeze({ s03: 'iristest', s04: '테스트 사용자' });

// 손님(guest) 안의 경로. 조각으로 나눠 이어 붙이는 것은 멋이 아니라 규칙이다 --
// 저장소 정화 규칙(`build/sanitize-rules.json`, `verify/static.mjs` ⑦)이
// "드라이브 문자 + IRIS/Users" 모양을 **개발 PC의 절대경로**로 보고 막는다.
// 여기 있는 것은 이 PC 가 아니라 VM 손님의 경로지만, 규칙은 둘을 구별할 수
// 없으므로 문자열 자체를 만들지 않는다.
const GUEST_DRIVE = 'C:';
export const SOUL = `${GUEST_DRIVE}\\IRIS`; // 손님 안에 설치기가 만드는 폴더
export const GUEST_USERS = `${GUEST_DRIVE}\\Users`;
// 표준 사용자 시나리오가 쓰는 공용 자리. 관리자(tester)가 zip 을 여기에 넣어 주고
// 시험 계정이 여기서 풀어 실행한다 -- 남의 프로필 안으로 파일을 밀어 넣지 않는다.
export const PUBLIC_DIR = `${GUEST_USERS}\\Public`;
export const SHARE_DIR = `${PUBLIC_DIR}\\iris-verify`;
export const COLLECT = Object.freeze([
  `${SOUL}\\_agent\\setup\\diagnostics.json`,
  `${SOUL}\\_agent\\setup\\handoff.json`,
  `${SOUL}\\_agent\\setup\\package-receipt.json`,
  `${SOUL}\\_agent\\setup\\setup.log`,
  `${SOUL}\\_agent\\setup\\installer.log`,
]);

// ---------------------------------------------------------------------------
// judgements -- each gets {exitCode, diagnostics, handoff, receipt, stdout}
// ---------------------------------------------------------------------------

const STAGES = ['unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks'];

const allStagesDone = (d) => STAGES.every((id) => d?.stages?.[id]?.status === 'done');
const checkItem = (d, id) => (d?.checks?.items ?? []).find((c) => c.id === id) ?? null;

// `cmd /c IRIS-설치.cmd` 가 돌려주는 코드. 진입기는 bootstrap.ps1 을 부르고
// 그 코드를 그대로 넘기므로, 정상 경로는 언제나 0이다(오프라인이어도 ⑥에서
// 멈추는 것은 화면 안의 일이지 프로세스 실패가 아니다). 시나리오가 다른 값을
// 기대해야 한다면 표에 `expectExit` 로 **명시**한다 -- 판정 함수가 실제 코드를
// 0으로 갈아 끼우고 넘어가는 일은 없어야 한다(그러면 진입 실패를 못 본다).
export const EXPECTED_INSTALLER_EXIT = 0;

// 손님 안에서 실제로 설치를 돌리는 단계들 -- 이 단계들만 `--install-timeout` 을 받는다.
export const LONG_PHASES = new Set(['install', 'install-legacy']);

function judgeExit(ev) {
  const want = ev.expectExit ?? EXPECTED_INSTALLER_EXIT;
  if (ev.exitCode !== want) return { ok: false, reason: `설치기 종료 코드가 ${ev.exitCode} 입니다(기대 ${want})` };
  return { ok: true };
}

function judgeBaseline(ev) {
  const exit = judgeExit(ev);
  if (!exit.ok) return exit;
  if (!ev.diagnostics) return { ok: false, reason: 'diagnostics.json 을 회수하지 못했습니다' };
  if (!allStagesDone(ev.diagnostics)) {
    const bad = STAGES.filter((id) => ev.diagnostics.stages?.[id]?.status !== 'done');
    return { ok: false, reason: `끝나지 않은 단계: ${bad.join(', ')}` };
  }
  const fail = ev.diagnostics.checks?.summary?.fail ?? -1;
  if (fail !== 0) return { ok: false, reason: `검사 실패 ${fail}건` };
  // 2026-09-17(S13 몫): 운전기가 로그인 없이 중계기 시작을 밟은 결과. 있으면 반드시 통과해야 한다 —
  // 2.0.4~2.0.8 이 실제 PC 의 ⑦에서만 터진 결함(proxy.port 누락·시작 스크립트 파이프 대기)을 잡는 자리.
  const relay = judgeRelayProbe(ev);
  if (!relay.ok) return relay;
  return { ok: true, reason: `9단계 완료 · 검사 실패 0건 · 대기 ${ev.diagnostics.checks?.summary?.pending ?? 0}건${relay.reason ? ` · ${relay.reason}` : ''}` };
}

export function judgeRelayProbe(ev) {
  const p = ev?.drive?.relayProbe;
  if (!p) return { ok: true, reason: '' }; // 운전기가 그 단계까지 못 갔거나 옛 운전기 — 다른 판정이 이유를 말한다
  if (p.ok === true) return { ok: true, reason: `중계기 시작 OK(계정 ${p.accounts ?? 0})` };
  return { ok: false, reason: `중계기 시작 실패: ${p.message ?? p.code ?? '까닭 없음'}` };
}

// S05 -- SAC 켜짐. 잡는 것은 "설치가 되는가"가 아니라 "막혔을 때 안내가 실효성이
// 있는가"다. 그래서 둘 다 통과로 본다: ⓐ SAC 가 허용해 끝까지 갔다,
// ⓑ 진입이 막혔고 zip 뿌리에 「설치가 안 되면.txt」 안내가 놓여 있다.
// ⓑ 는 사람이 화면 문구를 한 번 눈으로 봐야 완결된다(notes 로 남긴다).
function judgeSac(ev) {
  const notes = [];
  // SAC 가 정말 켜졌는가. 안 켜졌으면 이 시나리오는 **아무것도 시험하지 않은 것**이라
  // 통과로 적으면 안 된다(평가판 이미지가 되돌리는 일이 있다).
  if (ev.sacOn !== true) {
    return { ok: false, reason: `SAC 를 켜지 못했습니다(정책 상태=${ev.sacState ?? '확인 못 함'})` };
  }
  if (ev.motwShellExec === 'allowed') notes.push('MotW 가 붙은 진입기를 두 번 눌러도 SAC 가 막지 않았다(이 판에서는 안내가 필요 없다)');
  if (ev.motwShellExec === 'blocked') notes.push('두 번 누르기는 막혔다 -- 안내 문서의 우회로가 유일한 길이다');
  if (!ev.noticeFilePresent) notes.push('zip 뿌리에서 안내 파일을 찾지 못했다');
  // 우회로(`cmd /c`)가 끝까지 갔는가 = 기준선 그대로.
  if (ev.exitCode === 0 && ev.diagnostics) {
    const base = judgeBaseline(ev);
    if (!base.ok) return { ...base, notes };
    return { ok: true, reason: `SAC 켜짐 · 두 번 누르기 ${ev.motwShellExec ?? '확인 못 함'} · 우회로로 ${base.reason}`, notes };
  }
  const noticed = ev.noticeFilePresent === true;
  return {
    ok: noticed,
    reason: noticed
      ? 'SAC 켜짐 · 진입이 막혔고 안내 파일이 zip 뿌리에 있습니다(사람 확인 필요)'
      : 'SAC 켜짐 · 진입이 막혔는데 안내 파일을 찾지 못했습니다',
    notes: [...notes, '사람이 게스트 화면에서 안내 문구를 한 번 눈으로 확인할 것'],
  };
}

// S06 -- 완전 오프라인. ③(=⑤ 세팅)까지 끝나고, ④(온라인)에서 정직하게 멈추고,
// 인수 문서가 login-pending 이어야 한다(설계-v2 7절).
//
// 2026-09-15 T23c 고치기: 원래 이 함수는 `receipt.online.net.code` 를 봤는데
// **영수증에는 그 자리가 없다.** `installer/lib/online.mjs` 의 checkNet 은
// 영수증을 건드리지 않고(`patchReceipt` 는 중계기·설치물에만 쓴다) 결과를
// 서버 상태(`GET /api/online/status` 의 `net`)로만 돌려준다. 그래서 실제로
// 돌렸다면 code 는 언제나 `null` 이었고 S06 은 영원히 실패했을 것이다.
// 이제 손님 안 운전기(guest-drive.mjs)가 회수해 온 온라인 상태를 본다.
function judgeOffline(ev) {
  // 종료 코드를 갈아 끼우지 않는다 -- 망이 없어도 진입기는 정상 종료해야 하고,
  // 그렇지 않았다면 그것이야말로 이 시나리오가 잡아야 할 사실이다.
  const base = judgeBaseline(ev);
  if (!base.ok) return base;
  const net = ev.drive?.online?.net ?? null;
  if (!net) return { ok: false, reason: '온라인 확인 결과를 회수하지 못했습니다(drive-result.json 없음)' };
  if (net.code !== 'E-ONLINE-NET') return { ok: false, reason: `온라인 멈춤 코드가 E-ONLINE-NET 이 아닙니다(${net.code})` };
  if (ev.handoff?.state !== 'login-pending') return { ok: false, reason: `handoff.state=${ev.handoff?.state}` };
  return { ok: true, reason: `⑤ 9단계 완료 · ⑥-1 E-ONLINE-NET 정직한 멈춤(막힌 곳 ${(net.blocked ?? []).length}개) · handoff login-pending` };
}

// S07 -- npm 저장소만 차단. Claude Code 를 공식 설치기 쪽 출처로 폴백해 받았는가.
//
// 2026-09-15 T23c 고치기: 여기도 자리가 틀렸다. 영수증에 남는 것은
// `installed.claude`(setInstalled) 이고, 진행 중 상태는 온라인 상태의
// `claude` 다. 둘 다 본다 -- 어느 쪽이든 출처가 npm 이 아니면 폴백 성공.
function judgeNpmBlocked(ev) {
  // 막지 못한 채로 통과가 찍히면 이 시나리오는 아무것도 잡지 않은 것이다.
  if (ev.npmBlocked === false) return { ok: false, reason: 'npm 저장소를 막지 못했습니다(hosts 가 적용되지 않았습니다)' };
  const claude = ev.drive?.online?.claude ?? {};
  const installed = ev.receipt?.installed?.claude ?? {};
  const source = claude.source ?? installed.source ?? null;
  if (claude.state && claude.state !== 'done') return { ok: false, reason: `Claude Code 내려받기 상태=${claude.state}` };
  if (!source) return { ok: false, reason: 'Claude Code 내려받기 출처를 확인하지 못했습니다' };
  if (source === 'npm') return { ok: false, reason: `출처 폴백이 일어나지 않았습니다(source=${source})` };
  if (ev.handoff?.state !== 'login-pending') return { ok: false, reason: `handoff.state=${ev.handoff?.state}` };
  return { ok: true, reason: `npm 막힌 상태에서 출처 '${source}' 로 폴백 성공 · handoff login-pending` };
}

// S09 -- 기존 C:\IRIS(1.4.5) 위. 옛 영수증을 사본으로 남기고, 사용자가 넣어 둔
// 파일(감시 파일)이 그대로 있어야 한다.
function judgeUpgrade(ev) {
  const base = judgeBaseline(ev);
  if (!base.ok) return base;
  // 설치 위치 확인이 이 폴더를 「예전 판 IRIS」로 알아봤는가(server.mjs soulMode).
  // 이걸 안 보면 옛 폴더를 그냥 새 설치로 덮어써도 통과가 찍힌다.
  const mode = ev.drive?.locate?.mode ?? null;
  if (mode !== 'iris-legacy') return { ok: false, reason: `설치 위치 판정이 iris-legacy 가 아닙니다(mode=${mode})` };
  if (!ev.legacyReceiptKept) return { ok: false, reason: '1.x 영수증 사본(package-receipt.v1.json)이 없습니다' };
  // `null` = 확인 자체를 못 했다(회수 명령이 아무 표시도 못 남겼다). 그것은
  // "보존됐다"가 아니다 -- 자료 보존이 이 시나리오의 전부인데 모르는 채로
  // 통과시키면 시험을 한 뜻이 없다.
  if (ev.sentinelKept !== true) {
    return {
      ok: false,
      reason: ev.sentinelKept === false
        ? '설치 전에 넣어 둔 사용자 파일이 사라졌습니다'
        : '사용자 파일 보존 여부를 확인하지 못했습니다(감시 파일 회수 실패)',
    };
  }
  return { ok: true, reason: `${base.reason} · 1.x 영수증 보존 · 사용자 파일 보존` };
}

// S04 -- 한글+공백 사용자 이름 + OneDrive 식으로 옮겨진 바탕화면.
// 기준선 전부 + 「바로가기가 **옮겨진** 바탕화면에 놓였는가」. 옛
// `%USERPROFILE%\Desktop` 에 놓였다면 사용자는 바로가기를 영영 못 본다.
function judgeKoreanUser(ev) {
  const base = judgeBaseline(ev);
  if (!base.ok) return base;
  if (ev.redirectedShortcut !== true) {
    return {
      ok: false,
      reason: ev.redirectedShortcut === false
        ? '옮겨진 바탕화면에 바로가기가 없습니다(옛 Desktop 에 놓였을 수 있습니다)'
        : '바로가기 위치를 확인하지 못했습니다',
    };
  }
  const notes = [];
  if (ev.oldDesktopShortcut === true) notes.push('옛 Desktop 에도 바로가기가 생겼다 -- 중복');
  return { ok: true, reason: `${base.reason} · 옮겨진 바탕화면에 바로가기 확인`, notes };
}

// S11(없음) -- Office·한컴이 없는 PC 에서 문서 MCP 가 fail 이 아니라 pending 인가.
function judgeDocPending(ev) {
  if (!ev.diagnostics) return { ok: false, reason: 'diagnostics.json 을 회수하지 못했습니다' };
  const mcp = checkItem(ev.diagnostics, 'mcp');
  if (!mcp) return { ok: false, reason: 'MCP 검사 항목이 없습니다' };
  if (mcp.status !== 'pending') return { ok: false, reason: `MCP 검사가 ${mcp.status} 입니다(기대: pending)` };
  if ((ev.diagnostics.checks?.summary?.fail ?? -1) !== 0) return { ok: false, reason: '다른 검사가 실패했습니다' };
  const caps = ev.diagnostics.pendingCapabilities ?? [];
  if (!caps.length) return { ok: false, reason: '대기 기능 목록이 비었습니다' };
  return { ok: true, reason: `문서 MCP pending · 대기 기능 ${caps.length}건 (${mcp.detail ?? ''})`.slice(0, 200) };
}

// 시험이 판정 규칙을 직접 겨눌 수 있게 내보낸다 -- 판정은 이 파일에서 가장
// 조용히 틀릴 수 있는 부분이라(아무도 못 본 채 "통과"가 찍힌다) 시험 대상이다.
export const JUDGES = Object.freeze({
  baseline: judgeBaseline, sac: judgeSac, offline: judgeOffline,
  npmBlocked: judgeNpmBlocked, upgrade: judgeUpgrade, docPending: judgeDocPending,
  koreanUser: judgeKoreanUser,
});

// ---------------------------------------------------------------------------
// the scenario table (설계-v2 10절 / docs/시험행렬.md)
// ---------------------------------------------------------------------------

// npm 저장소만 막는 일은 **손님 안 스크립트 파일**(guest-hosts.ps1)이 한다.
// 2026-09-15 실측: 여기 있던 한 줄짜리 -Command 는 VBoxManage 가 인자 묶음을
// 지켜 주지 않아 손님 쪽에서 토막으로 쪼개졌고 UnexpectedToken 파서 오류로 죽었다
// (lib.mjs guestRunPsFile 주석과 같은 함정). 이름만 남겨 시험이 겨눌 수 있게 한다.
export const HOSTS_BLOCK_SCRIPT = HOSTS_SCRIPT;

export const SCENARIOS = Object.freeze({
  S01: {
    id: 'S01', where: 'vm', vm: BASE_VM, snapshot: 'clean',
    label: '깨끗한 Windows 11 24H2, 관리자', catches: '기준선', judge: judgeBaseline,
  },
  S02: {
    id: 'S02', where: 'vm', vm: 'IRIS-Win10', snapshot: 'clean',
    label: 'Windows 10 22H2', catches: '최저 지원 판', judge: judgeBaseline,
  },
  // S03·S04 는 2026-09-15(Task 23d)에 **이 PC 새 로컬 계정 → VM 손님 계정**으로
  // 옮겼다. 이 PC 에 계정을 만드는 일은 관리자 UAC 가 필요해 자동화가 못 하고,
  // 무엇보다 그 시험이 사용자의 진짜 PC 에 계정·프로필·바탕화면 리디렉션을 남긴다.
  // 손님 안에서는 tester 가 관리자라 계정을 만들 수 있고 스냅샷을 되돌리면 흔적이
  // 0이다. 잡으려는 것(표준 사용자 권한·한글 경로·옮겨진 바탕화면)은 그대로다.
  S03: {
    id: 'S03', where: 'vm', vm: BASE_VM, snapshot: 'clean',
    label: '표준 사용자(관리자 아님)', catches: 'PATH·환경변수·바로가기',
    account: { fixture: 's03', redirect: false }, judge: judgeBaseline,
  },
  S04: {
    id: 'S04', where: 'vm', vm: BASE_VM, snapshot: 'clean',
    label: '사용자 이름 한글+공백, OneDrive 바탕화면', catches: '경로·바탕화면 금지',
    account: { fixture: 's04', redirect: true }, judge: judgeKoreanUser,
  },
  // SAC 는 **스냅샷이 아니라 시나리오가 켠다**(2026-09-15 Task 23d). 평가판 이미지는
  // `VerifiedAndReputablePolicyState = 2`(평가 모드)로 오고, 그 값을 1로 바꾼 뒤
  // 재부팅해야 실제로 켜진다. 따로 `sac-on` 스냅샷을 두면 그 스냅샷이 언제 무엇으로
  // 만들어졌는지 아무도 모르게 되므로, 깨끗한 상태에서 매번 켜고 그 사실을 증거로 남긴다.
  S05: {
    id: 'S05', where: 'vm', vm: BASE_VM, snapshot: 'clean',
    label: 'SAC 켜짐', catches: '진입 안내 실효성', judge: judgeSac, sac: true,
  },
  S06: {
    id: 'S06', where: 'vm', vm: BASE_VM, snapshot: 'clean',
    label: '완전 오프라인', catches: '③까지 완료·④에서 정직한 멈춤',
    // 손님이 켜지기 전에 랜선을 뽑는다 -- 부팅 도중에도 망이 없어야 진짜 오프라인이다.
    hostPrep: (vm) => [['modifyvm', vm, '--cable-connected1', 'off']],
    hostRestore: (vm) => [['modifyvm', vm, '--cable-connected1', 'on']],
    judge: judgeOffline,
  },
  S07: {
    id: 'S07', where: 'vm', vm: BASE_VM, snapshot: 'clean',
    label: 'npm 저장소만 차단', catches: 'Claude Code 출처 폴백',
    // hosts 파일은 관리자 **권한 상승**이 있어야 고칠 수 있는데 손님 제어 세션은
    // 상승돼 있지 않다(guest-elevate.ps1 머리말이 실측 정본). 그래서 그 문을 거친다.
    guestPrep: (vm, o) => [
      guestCopyTo(vm, { user: o.user, password: o.password, from: path.join(HERE, ELEVATE_SCRIPT), toDir: PUBLIC_DIR }),
      guestCopyTo(vm, { user: o.user, password: o.password, from: path.join(HERE, HOSTS_SCRIPT), toDir: PUBLIC_DIR }),
      guestRunPsFile(vm, {
        user: o.user,
        password: o.password,
        file: `${PUBLIC_DIR}\\${ELEVATE_SCRIPT}`,
        args: elevateArgs({
          script: `${PUBLIC_DIR}\\${HOSTS_SCRIPT}`,
          argumentLine: `-Elevated -Out "${ELEVATE_OUT}"`,
        }),
      }),
    ],
    judge: judgeNpmBlocked,
  },
  S08: {
    id: 'S08', where: 'this-pc',
    label: '기존 Node·Python·Git·Claude Code 설치·로그인 PC', catches: '동봉본 우선·기존 무접촉',
  },
  S09: {
    id: 'S09', where: 'vm', vm: BASE_VM, snapshot: LEGACY_SNAPSHOT,
    label: '기존 C:\\IRIS(1.4.5)', catches: '자료 보존 이어 설치',
    // `--legacy-zip <1.4.5 zip>` 을 주면 그 스냅샷을 **이 실행이 직접 만든다**:
    // clean 복원 → 1.4.5 를 로그인 직전까지 설치 → 사용자 자료(감시 파일) 심기 →
    // 스냅샷 → 그 위에 2.0.0. 스냅샷이 이미 있으면 --legacy-zip 없이 바로 쓴다.
    baseSnapshot: 'clean',
    // 감시 파일 이름은 guest-legacy.ps1 안에 있다(한글 이름을 인자로 넘기지 않는다).
    sentinel: true,
    judge: judgeUpgrade,
  },
  S10: {
    id: 'S10', where: 'vm', vm: 'IRIS-Win11-EN', snapshot: 'clean',
    label: '영어 UI 윈도', catches: '한글 경로·코드페이지', judge: judgeBaseline,
  },
  S11: {
    id: 'S11', where: 'vm', vm: BASE_VM, snapshot: 'no-office',
    label: 'Office·한컴 없음 / 있음', catches: '문서 MCP `pending` 판정', judge: judgeDocPending,
  },
});

// ---------------------------------------------------------------------------
// the plan (pure -- tests/vm.test.mjs pins this per scenario)
// ---------------------------------------------------------------------------

/**
 * scenarioPlan(id, opts) -> [{ phase, args }] in execution order.
 * opts: { zip, user, password, outDir, guestDir }
 */
export function scenarioPlan(id, opts) {
  const s = SCENARIOS[id];
  if (!s) throw new Error(`알 수 없는 시나리오: ${id}`);
  if (s.where !== 'vm') throw new Error(`${id} 은(는) VM 시나리오가 아닙니다(where=${s.where})`);

  const vm = opts.vm ?? s.vm;
  // 손님 계정 시나리오(S03·S04)는 공용 폴더에서 일한다. 관리자(tester)가 zip 을
  // 거기 놓아 주고, 푸는 것과 설치는 **시험 계정이** 한다.
  const baseDir = s.account ? SHARE_DIR : opts.guestDir;
  const zipName = path.basename(opts.zip);
  const guestZip = `${baseDir}\\${zipName}`;
  const guestDir = `${baseDir}\\iris-verify-extract`;
  const guestRunner = `${baseDir}\\${RUNNER}`;
  const guestDriver = `${baseDir}\\${DRIVER}`;
  const guestResult = `${baseDir}\\${DRIVE_RESULT}`;
  const g = { user: opts.user, password: opts.password };
  // 실제로 설치기를 돌리는 사람. 계정 시나리오면 갓 만든 표준 사용자다.
  const gu = s.account
    ? { user: opts.accountName ?? ACCOUNT_NAMES[s.account.fixture], password: opts.password }
    : g;
  const steps = [];
  const add = (phase, args) => steps.push({ phase, args });

  // 스냅샷 되돌리기는 **꺼진 VM 에서만** 된다. 앞 시나리오가 `--keep-running`
  // 으로 켜 둔 채 끝났거나 사람이 열어 봤으면 여기서 막힌다 -- 그래서 먼저
  // 끈다(이미 꺼져 있으면 이 명령은 실패하고, 그 실패는 무시한다).
  add('pre-stop', ['controlvm', vm, 'poweroff']);
  // `--legacy-zip` 이 있으면 「1.4.5 가 깔린 스냅샷」을 이 실행이 직접 만든다 --
  // 그래서 되돌릴 곳은 그 스냅샷이 아니라 깨끗한 상태다.
  const buildingLegacy = Boolean(opts.legacyZip && s.baseSnapshot);
  add('restore', ['snapshot', vm, 'restore', buildingLegacy ? s.baseSnapshot : s.snapshot]);
  for (const args of s.hostPrep?.(vm, { ...opts, vm }) ?? []) add('prep-host', args);
  add('start', ['startvm', vm, '--type', 'headless']);
  for (const args of s.guestPrep?.(vm, { ...opts, vm }) ?? []) add('prep-guest', args);
  if (s.sac) {
    // ① SAC 를 켜고 ② 재부팅한다(재부팅 없이는 정책이 적용되지 않는다).
    add('prep-guest', guestCopyTo(vm, { ...g, from: path.join(HERE, ELEVATE_SCRIPT), toDir: PUBLIC_DIR }));
    add('prep-guest', guestCopyTo(vm, { ...g, from: path.join(HERE, SAC_SCRIPT), toDir: PUBLIC_DIR }));
    // 정책 값은 HKLM 에 있어 권한 상승이 필요하다 -- 손님 제어 세션은 상승돼 있지 않다.
    add('prep-guest', guestRunPsFile(vm, {
      ...g,
      file: `${PUBLIC_DIR}\\${ELEVATE_SCRIPT}`,
      args: elevateArgs({
        script: `${PUBLIC_DIR}\\${SAC_SCRIPT}`,
        argumentLine: `-Enable -Out "${ELEVATE_OUT}"`,
      }),
    }));
    add('reboot', guestRunCmd(vm, { ...g, command: 'shutdown /r /t 0' }));
  }
  if (s.account) {
    // ① 관리자가 준비 스크립트를 공용 폴더에 놓고 ② 표준 계정을 **확인**하고
    // ③ 그 계정으로 한 번 로그온해 프로필(+S04 는 바탕화면 옮기기)을 만든다.
    //
    // 2026-09-16(Task 23e): 계정은 이제 무인 설치 때 미리 구워져 있다(bake.ps1).
    // 그래도 ②를 그대로 두는 이유는 두 가지다 -- ⓐ 굽지 않은 옛 이미지에서도
    // 이 시험대가 돌아야 하고 ⓑ "정말 표준 사용자인가"를 매번 확인해야 한다
    // (관리자로 잘못 만들어진 계정으로 돌면 이 시나리오는 아무것도 잡지 못한다).
    // 계정 만들기는 권한이 필요하므로 ②는 굽힌 SYSTEM 문을 거친다.
    add('prep-guest', guestCopyTo(vm, { ...g, from: path.join(HERE, ELEVATE_SCRIPT), toDir: PUBLIC_DIR }));
    add('prep-guest', guestCopyTo(vm, { ...g, from: path.join(HERE, ACCOUNT_PREP), toDir: PUBLIC_DIR }));
    add('prep-guest', guestCopyTo(vm, { ...g, from: path.join(HERE, USER_PREP), toDir: PUBLIC_DIR }));
    // ② 계정 확인 + **자동 로그온을 그 계정으로 바꿈**(-AutoLogon) → ③ 재부팅 → 그 계정이 진짜
    // 대화형 로그온을 한다. 2026-09-17 실측: guestcontrol `--profile` 은 표준 사용자의 하이브를 얹지
    // 않아(HKU 에 그 SID 없음) HKCU 가 읽기 전용 .DEFAULT 로 떨어졌고(S03 E-ENV·S04 reg add 거부),
    // SYSTEM 의 `reg load` 로 얹어도 그 계정 프로세스에 붙지 않았다. 관리자 tester 가 되는 까닭은
    // 대화형 자동 로그온 세션이라서다 — 같은 조건을 표준 계정에 준다(실제 사용자와 같은 모양).
    add('prep-guest', guestRunPsFile(vm, {
      ...g,
      file: `${PUBLIC_DIR}\\${ELEVATE_SCRIPT}`,
      args: elevateArgs({
        script: `${PUBLIC_DIR}\\${ACCOUNT_PREP}`,
        argumentLine: `-Fixture ${s.account.fixture} -Password "${opts.password}" -AutoLogon -Out "${ELEVATE_OUT}"`,
      }),
    }));
    add('reboot', guestRunCmd(vm, { ...g, command: 'shutdown /r /t 0' }));
    // ④ 그 계정으로 준비(HKCU 탐침 한 줄 + S04 는 바탕화면을 OneDrive 한글 경로로 옮김).
    add('prep-guest', guestRunPsFile(vm, {
      ...gu,
      file: `${PUBLIC_DIR}\\${USER_PREP}`,
      args: s.account.redirect ? ['-Redirect'] : [],
    }));
  }
  if (buildingLegacy) {
    // ① 1.4.5 를 풀어 **로그인 직전까지** 돌린다(운전기의 --legacy 갈래).
    add('copy-legacy', guestCopyTo(vm, { ...g, from: opts.legacyZip, toDir: baseDir }));
    add('copy-driver', guestCopyTo(vm, { ...g, from: path.join(HERE, RUNNER), toDir: baseDir }));
    add('copy-driver', guestCopyTo(vm, { ...g, from: path.join(HERE, DRIVER), toDir: baseDir }));
    add('copy-driver', guestCopyTo(vm, { ...g, from: path.join(HERE, LEGACY_SCRIPT), toDir: PUBLIC_DIR }));
    add('extract-legacy', guestRunPs(vm, {
      ...g,
      script: `Expand-Archive -LiteralPath '${baseDir}\\${path.basename(opts.legacyZip)}' -DestinationPath '${baseDir}\\legacy-extract' -Force`,
    }));
    add('install-legacy', guestRunPsFile(vm, {
      ...g,
      file: guestRunner,
      args: ['-Dir', `${baseDir}\\legacy-extract`, '-Driver', guestDriver,
        '-Out', `${baseDir}\\legacy-drive-result.json`, '-Legacy'],
    }));
    // ② 사용자가 자기 자료를 넣어 둔 상태를 만든다(한글 이름 파일 + 한글 이름 폴더).
    add('plant', guestRunPsFile(vm, { ...g, file: `${PUBLIC_DIR}\\${LEGACY_SCRIPT}`, args: ['-Plant'] }));
    // ③ 그 상태를 스냅샷으로 굳힌다 -- 다음 사람이 1.4.5 를 다시 깔지 않아도 되게.
    //    (같은 이름이 있으면 지우고 다시 찍는다: 옛 스냅샷이 조용히 이기면 안 된다.)
    // 2026-09-16 실측: `acpipowerbutton` 은 윈도 11 기본값대로 종료가 아니라 **잠자기**다 →
    // 손님 안에서 `shutdown /s` 를 부른다(guest-elevate 필요 없음, 관리자 세션이면 된다).
    add('snapshot-stop', guestRunCmd(vm, { ...g, command: 'shutdown /s /t 0' }));
    add('snapshot-drop', ['snapshot', vm, 'delete', s.snapshot]);
    add('snapshot-take', ['snapshot', vm, 'take', s.snapshot,
      '--description', '1.4.5 installed up to (not including) login, with user data planted (Task 23d)']);
    add('start', ['startvm', vm, '--type', 'headless']);
  }
  add('copy-zip', guestCopyTo(vm, { ...g, from: opts.zip, toDir: baseDir }));
  // 화면을 대신 누르는 운전기 두 벌. 손님 안에서만 도는 물건이라 zip 에 넣지
  // 않고(배포물을 시험 도구로 더럽히지 않는다) 매번 복사해 넣는다.
  add('copy-driver', guestCopyTo(vm, { ...g, from: path.join(HERE, RUNNER), toDir: baseDir }));
  add('copy-driver', guestCopyTo(vm, { ...g, from: path.join(HERE, DRIVER), toDir: baseDir }));
  add('extract', guestRunPs(vm, {
    ...gu,
    script: `Expand-Archive -LiteralPath '${guestZip}' -DestinationPath '${guestDir}' -Force`,
  }));
  if (s.sac) {
    // 내려받은 파일에 진짜 MotW 를 붙이고 **두 번 누르기(ShellExecute)** 를 해 본다.
    // 막히는지 여부가 이 시나리오의 알맹이다. 그 뒤에 이어지는 install 단계는
    // 안내 문서가 시키는 우회로(`cmd /c`)가 정말로 끝까지 가는지를 본다.
    add('sac-test', guestRunPsFile(vm, {
      ...g, file: `${PUBLIC_DIR}\\${SAC_SCRIPT}`, args: ['-TestEntry', '-Dir', guestDir],
    }));
  }
  // ⚠ `cmd /c IRIS-설치.cmd` 하나만으로는 설치가 되지 않는다 -- 그 진입기는
  // 서버를 띄우고 브라우저를 연 뒤 **즉시 끝난다**(installer/IRIS-설치.cmd).
  // 그래서 진입기 실행 + 서버 대기 + 마법사 API 운전을 한 세션에 묶은
  // guest-run.ps1 을 부른다. 진입기 자체는 그 안에서 `cmd /c` 로 돈다.
  add('install', guestRunPsFile(vm, {
    ...gu,
    file: guestRunner,
    args: ['-Dir', guestDir, '-Driver', guestDriver, '-Out', guestResult, ...(s.driveArgs ?? [])],
  }));
  add('collect', guestCopyFrom(vm, { ...g, from: guestResult, toDir: opts.outDir }));
  for (const file of COLLECT) add('collect', guestCopyFrom(vm, { ...g, from: file, toDir: opts.outDir }));
  if (s.sentinel) {
    // 감시 파일·1.x 영수증 확인은 한글 이름을 아는 스크립트가 한다(인자로 넘기지 않는다).
    add('collect', guestRunPsFile(vm, { ...g, file: `${PUBLIC_DIR}\\${LEGACY_SCRIPT}`, args: ['-Check'] }));
  }
  if (s.account?.redirect) {
    // 바로가기가 **옮겨진** 바탕화면에 놓였는지는 그 계정만 볼 수 있다(HKCU).
    add('collect', guestRunPsFile(vm, { ...gu, file: `${PUBLIC_DIR}\\${USER_PREP}`, args: ['-Check'] }));
  }
  if (s.id === 'S05') {
    add('collect', guestRunCmd(vm, { ...g, command: `if exist "${guestDir}\\설치가 안 되면.txt" (echo NOTICE-PRESENT) else (echo NOTICE-MISSING)` }));
  }
  add('stop', ['controlvm', vm, 'poweroff']);
  for (const args of s.hostRestore?.(vm, { ...opts, vm }) ?? []) add('restore-host', args);
  // --collect-only: 이미 켜져 있고 설치가 끝난(또는 시험대가 중간에 넘어진) 손님에서
  // 증거만 걷어 온다. 시험대가 설치보다 먼저 포기한 판을 통째로 버리지 않기 위한 문이다
  // (2026-09-15 실측: 제한 시간에 걸려 VBoxManage 는 죽었는데 손님 안 설치는 멀쩡히 끝났다).
  if (opts.collectOnly) return steps.filter((st) => st.phase === 'collect');
  return steps;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    scenario: null, zip: null, legacyZip: null, vm: null, collectOnly: false, user: 'tester',
    outDir: null, dryRun: false, keepRunning: false, noReport: false,
    // 2026-09-15 실측: 2 vCPU VM 에서 설치 한 판이 60분을 넘겼다(그 판은 여기서
    // 잘려 증거를 못 남겼다). 손님 쪽 운전기의 최대 대기(서버 5 + 세팅 45 + 온라인 20
    // = 70분)보다 **길어야** 시험대가 설치기보다 먼저 포기하지 않는다.
    // 2026-09-16 실측: 4 GB/2 vCPU 손님에서 세팅 45분 + 온라인 10분+ → 한 시나리오의 install 이 60분을 넘는다.
    // 2026-09-17: 연결 복제본을 다른 VM 과 **동시에** 부팅하면(디스크 경합) 손님 제어가 15분을 넘긴다 → 30분.
    bootWaitMs: 30 * 60 * 1000, installTimeoutMs: 180 * 60 * 1000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scenario') opts.scenario = String(argv[++i]).toUpperCase();
    else if (a === '--zip') opts.zip = path.resolve(argv[++i]);
    else if (a === '--legacy-zip') opts.legacyZip = path.resolve(argv[++i]);
    else if (a === '--vm') opts.vm = argv[++i];
    else if (a === '--user') opts.user = argv[++i];
    else if (a === '--out-dir') opts.outDir = path.resolve(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--keep-running') opts.keepRunning = true;
    else if (a === '--no-report') opts.noReport = true;
    else if (a === '--collect-only') opts.collectOnly = true;
    else if (a === '--install-timeout-min') opts.installTimeoutMs = Number(argv[++i]) * 60 * 1000;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!opts.scenario) throw new Error('--scenario S01..S11 is required');
  if (!SCENARIOS[opts.scenario]) throw new Error(`알 수 없는 시나리오: ${opts.scenario}`);
  return opts;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function sha256Head(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

// 시험 행렬의 `zip 지문` 열에 적어야 하는 값은 zip 파일의 sha256 이 **아니라**
// 빌드의 **내용 지문**(contentFingerprint) 앞 12자다. zip 자체의 sha256 은
// `payload\manifest.json` 의 `built` 시각 때문에 빌드마다 달라져 어떤 행도
// 게이트와 일치할 수 없다(docs/시험행렬.md 머리말 · Task 24a 교착).
// 그래서 `_build\out\last-build.json` 을 먼저 보고, 없을 때만 zip 해시로 내려간다.
export function buildFingerprint(zipFile, { repo = REPO, readJsonFn = readJson } = {}) {
  const lb = readJsonFn(path.join(repo, '_build', 'out', 'last-build.json'));
  const cf = lb?.contentFingerprint;
  if (typeof cf === 'string' && /^[0-9a-f]{12,}$/.test(cf)) return cf.slice(0, 12);
  return sha256Head(zipFile);
}

export async function main(argv = process.argv.slice(2), { vbox = null, env = process.env } = {}) {
  const opts = parseArgs(argv);
  const s = SCENARIOS[opts.scenario];

  // --- 이 PC 시나리오 두 갈래 -------------------------------------------
  if (s.where === 'this-pc') {
    console.log(`시나리오 ${s.id} — ${s.label}`);
    console.log('이 시나리오는 VM 이 아니라 이 PC 본계정에서 돕니다:');
    console.log('  node verify/e2e.mjs --scenario s08     (C:\\IRIS-s08 에 설치 · 이 PC 무접촉 증명)');
    console.log('그 실행이 시험 행렬 행(S08·S11 있음)까지 채웁니다.');
    return;
  }
  // --- VM 시나리오 -------------------------------------------------------
  if (!opts.zip) throw new Error('--zip <path-to-install-zip> is required for a VM scenario');
  requireFile(opts.zip, 'install zip');
  const password = opts.dryRun ? '<IRIS_VM_PASSWORD>' : requirePassword(env);
  const vm = opts.vm ?? s.vm;
  const outDir = opts.outDir ?? path.join(REPO, '_build', 'cache', 'vm', 'results', `${s.id}-${stamp()}`);
  const guestDir = `${GUEST_USERS}\\${opts.user}\\Desktop`;

  const plan = scenarioPlan(s.id, {
    zip: opts.zip, legacyZip: opts.legacyZip, user: opts.user, password, outDir, guestDir, vm,
    collectOnly: opts.collectOnly,
  });

  if (opts.dryRun) {
    console.log(`시나리오 ${s.id} — ${s.label} (VM ${vm}, 스냅샷 ${s.snapshot})`);
    for (const step of plan) console.log(`  [${step.phase}] VBoxManage ${step.args.join(' ')}`);
    return;
  }

  if (!hasVBoxManage()) {
    console.error('VirtualBox 가 이 PC 에 없습니다. verify/vm/README.md 의 「사람이 한 번 할 일」을 먼저 끝내 주세요.');
    process.exitCode = 4;
    return;
  }

  const V = vbox ?? makeVbox();
  fs.mkdirSync(outDir, { recursive: true });
  const evidence = { exitCode: null, stdout: '', stderr: '' };
  const marks = {};

  // `controlvm poweroff` 는 바로 돌아오지만 VirtualBox 쪽 세션이 닫히는 데는
  // 몇 초가 더 걸린다. 그 사이에 `startvm` 을 부르면
  // "The VM session was closed before any attempt to power it on" 으로 죽는다
  // (2026-09-15 실측 — S01 첫 시도가 이것으로 넘어졌다). 그래서 끄기·되돌리기
  // 뒤에는 VM 이 실제로 멈춘 것을 보고 다음으로 간다.
  const settleStopped = async (maxMs = 90 * 1000) => {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const info = V(['showvminfo', vm, '--machinereadable'], { allowFail: true });
      const st = /VMState="(.*?)"/.exec(info.out)?.[1] ?? '';
      if (['poweroff', 'aborted', 'saved'].includes(st)) return st;
      if (Date.now() > deadline) return st;
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  for (const step of plan) {
    if (step.phase === 'reboot') {
      log('[reboot] 손님에게 재시작을 요청했습니다 -- 다시 올라오기를 기다립니다...');
      V(step.args, { allowFail: true, timeout: 60 * 1000 });
      await new Promise((res) => setTimeout(res, 30 * 1000));
      const back = await waitForGuestControl(V, vm, opts.user, password, { pollMs: 20 * 1000, maxMs: opts.bootWaitMs });
      if (!back) throw new Error('재부팅 뒤 손님 제어가 돌아오지 않았습니다');
      continue;
    }
    if (step.phase === 'start') {
      // 앞 실행의 VBoxHeadless 가 아직 안 죽었으면 `startvm` 이
      // "The VM session was closed before any attempt to power it on" 으로
      // 죽는다(2026-09-15 실측). 몇 초 뒤면 풀리므로 세 번까지 다시 시도한다.
      let started = false;
      for (let attempt = 1; attempt <= 3 && !started; attempt++) {
        const r = V(step.args, { allowFail: attempt < 3 });
        if (r.code === 0) { started = true; break; }
        log(`startvm 실패(${attempt}/3) — 10초 뒤 다시: ${r.err.split('\n')[0]}`);
        await new Promise((res) => setTimeout(res, 10 * 1000));
      }
      log('waiting for guest control...');
      const ready = await waitForGuestControl(V, vm, opts.user, password, { pollMs: 30 * 1000, maxMs: opts.bootWaitMs });
      if (!ready) throw new Error(`guest control did not come up within ${opts.bootWaitMs / 60000} min`);
      continue;
    }
    // `--keep-running`: 손으로 들여다보려고 VM 을 켜 둔다. 끄기와 호스트 쪽
    // 되돌리기(S06 의 랜선 다시 꽂기)는 같이 미룬다 -- 켜진 VM 의 랜선만 몰래
    // 꽂아 두면 "오프라인이었다"는 증거가 사람 눈앞에서 사라진다.
    if (opts.keepRunning && (step.phase === 'stop' || step.phase === 'restore-host')) {
      log(`[${step.phase}] --keep-running 이라 건너뜀: VBoxManage ${step.args.join(' ')}`);
      continue;
    }
    const allowFail = step.phase === 'install' || step.phase === 'collect'
      || step.phase === 'stop' || step.phase === 'pre-stop'
      || step.phase === 'snapshot-stop' || step.phase === 'snapshot-drop'
      || step.phase === 'install-legacy';
    log(`[${step.phase}] ${step.args.slice(0, 3).join(' ')}...`);
    // 설치를 돌리는 단계는 몇십 분이 걸린다. 2026-09-15 실측: `install-legacy`
    // 가 이 목록에 없어 10분에서 잘렸고(ETIMEDOUT), VBoxManage 가 죽어도 손님
    // 안의 설치는 계속 돌아 시나리오가 통째로 넘어졌다. 단계 이름을 여기 적는 것을
    // 잊으면 같은 일이 또 난다 -- 그래서 목록을 한곳에 둔다.
    // `prep-guest` 는 표준 사용자 계정 만들기 + 상승(runas 재시도 20초×6) 을 거치는데,
    // 링크 클론은 스냅샷을 되돌릴 때마다 첫 부팅 하드웨어 재탐지가 다시 걸려 이 단계가
    // 느려진다(2026-09-17 실측: 포렌식은 2.3분, 클론 재실행은 10분 기본 한도에서 잘림).
    // 그래서 prep-guest 에는 20분을 준다 -- 설치 단계가 아니므로 --install-timeout 은
    // 받지 않되, 클론 첫 부팅 변동을 견딜 만큼은 늘린다.
    const timeout = LONG_PHASES.has(step.phase)
      ? opts.installTimeoutMs
      : (step.phase === 'prep-guest' ? 20 * 60 * 1000 : 10 * 60 * 1000);
    let r;
    if (step.phase.startsWith('copy')) {
      // 손님이 부팅 직후 디스크로 바쁘면(첫 부팅 작업·Defender) 383MB zip 의 copyto 가
      // 64KB 쓰기에서 VERR_TIMEOUT 으로 넘어진다(2026-09-16 실측, 손님 제어 응답 2분 뒤).
      // 복사 단계는 세 번까지 다시 시도한다. 오류 문구에 비밀번호가 든 전체 인자를
      // 싣지 않는다(makeVbox 의 기본 오류는 인자를 통째로 붙인다).
      for (let attempt = 1; ; attempt++) {
        r = V(step.args, { allowFail: true, timeout });
        if (r.code === 0) break;
        const first = String(r.err ?? '').split('\n')[0];
        if (attempt >= 3) {
          if (!allowFail) throw new Error(`[${step.phase}] ${attempt}번 실패: ${first}`);
          break;
        }
        log(`[${step.phase}] 실패(${attempt}/3) — 45초 뒤 다시: ${first}`);
        await new Promise((res) => setTimeout(res, 45 * 1000));
      }
    } else {
      r = V(step.args, { allowFail, timeout });
    }
    if (step.phase === 'pre-stop' || step.phase === 'restore' || step.phase === 'snapshot-stop') {
      const st = await settleStopped();
      log(`[${step.phase}] VM 상태 ${st}`);
    }
    if (step.phase === 'install-legacy') {
      fs.writeFileSync(path.join(outDir, 'legacy-install.log'),
        `exit code: ${r.code}\n\n--- stdout ---\n${r.out}\n\n--- stderr ---\n${r.err}\n`, 'utf8');
      evidence.legacyExit = r.code;
    }
    if (step.phase === 'install') {
      evidence.exitCode = r.code;
      evidence.stdout = r.out;
      evidence.stderr = r.err;
      fs.writeFileSync(path.join(outDir, 'install-run.log'),
        `exit code: ${r.code}\n\n--- stdout ---\n${r.out}\n\n--- stderr ---\n${r.err}\n`, 'utf8');
    }
    // 상승이 어느 문으로 갔는지는 **로그에 남아야 한다.** 남지 않으면 "준비가 됐다"는
    // 사실만 있고 "무엇이 그것을 해 줬는가"가 사라져, 다음 사람이 같은 조사를 처음부터
    // 다시 한다(2026-09-16 Task 23e). guest-elevate.ps1 이 첫 줄에 찍어 준다.
    if (step.phase === 'prep-guest' && r.out?.includes('ELEVATE-CHANNEL')) {
      const line = r.out.split(/\r?\n/).find((l) => l.includes('ELEVATE-CHANNEL')) ?? '';
      const exit = r.out.split(/\r?\n/).find((l) => l.startsWith('ELEVATE-EXIT')) ?? '';
      log(`[prep-guest] ${line.trim()}${exit ? ` · ${exit.trim()}` : ''}`);
      marks[line.trim()] = true;
    }
    // 손님 계정 HKCU 탐침(guest-user-prep.ps1, 2026-09-17 S03 E-ENV 조사) — 한 줄 그대로 남긴다.
    if (step.phase === 'prep-guest' && r.out?.includes('HKCU-PROBE')) {
      const line = r.out.split(/\r?\n/).find((l) => l.includes('HKCU-PROBE')) ?? '';
      log(`[prep-guest] ${line.trim()}`);
      evidence.hkcuProbe = line.trim();
    }
    if (r.out) {
      for (const mark of ['SENTINEL-KEPT', 'SENTINEL-GONE', 'LEGACY-KEPT', 'LEGACY-GONE',
        'NOTICE-PRESENT', 'NOTICE-MISSING', 'REDIRECTED-SHORTCUT-PRESENT',
        'REDIRECTED-SHORTCUT-MISSING', 'OLD-DESKTOP-SHORTCUT-PRESENT', 'OLD-DESKTOP-CLEAN',
        'SAC-ENABLE-OK', 'SAC-ENABLE-FAILED', 'SAC-STATE-AT-TEST-1', 'SAC-STATE-AT-TEST-2',
        'MOTW-SET', 'MOTW-SET-FAILED', 'MOTW-SHELLEXEC-BLOCKED', 'MOTW-SHELLEXEC-ALLOWED',
        'NPM-BLOCKED', 'NPM-BLOCK-FAILED', 'NPM-UNREACHABLE-CONFIRMED', 'NPM-REACHABLE-STILL']) {
        if (r.out.includes(mark)) marks[mark] = true;
      }
    }
  }

  evidence.drive = readJson(path.join(outDir, DRIVE_RESULT));
  evidence.diagnostics = readJson(path.join(outDir, 'diagnostics.json'));
  evidence.handoff = readJson(path.join(outDir, 'handoff.json'));
  evidence.receipt = readJson(path.join(outDir, 'package-receipt.json'));
  evidence.sentinelKept = marks['SENTINEL-KEPT'] === true ? true : (marks['SENTINEL-GONE'] ? false : null);
  evidence.legacyReceiptKept = marks['LEGACY-KEPT'] === true;
  evidence.noticeFilePresent = marks['NOTICE-PRESENT'] === true;
  evidence.redirectedShortcut = marks['REDIRECTED-SHORTCUT-PRESENT'] === true
    ? true : (marks['REDIRECTED-SHORTCUT-MISSING'] ? false : null);
  evidence.oldDesktopShortcut = marks['OLD-DESKTOP-SHORTCUT-PRESENT'] === true;
  evidence.sacOn = marks['SAC-STATE-AT-TEST-1'] === true
    ? true : ((marks['SAC-STATE-AT-TEST-2'] || marks['SAC-ENABLE-FAILED']) ? false : null);
  evidence.sacState = marks['SAC-STATE-AT-TEST-1'] ? 1 : (marks['SAC-STATE-AT-TEST-2'] ? 2 : null);
  evidence.npmBlocked = marks['NPM-BLOCKED'] === true ? true : (marks['NPM-BLOCK-FAILED'] ? false : null);
  evidence.motwShellExec = marks['MOTW-SHELLEXEC-BLOCKED'] === true
    ? 'blocked' : (marks['MOTW-SHELLEXEC-ALLOWED'] ? 'allowed' : null);
  evidence.expectExit = s.expectExit ?? EXPECTED_INSTALLER_EXIT;
  // 판정에는 쓰지 않는다(판정 함수는 이 작업에서 건드리지 않았다) -- 증거로만 남긴다.
  evidence.elevationChannel = marks['ELEVATE-CHANNEL baked'] ? 'baked'
    : (marks['ELEVATE-CHANNEL task'] ? 'task' : null);

  const verdict = s.judge(evidence);
  console.log(`\n시나리오 ${s.id}: ${verdict.ok ? '통과' : '실패'} — ${verdict.reason}`);
  for (const n of verdict.notes ?? []) console.log(`  · ${n}`);
  fs.writeFileSync(path.join(outDir, 'verdict.json'),
    `${JSON.stringify({ scenario: s.id, ...verdict, at: new Date().toISOString() }, null, 2)}\n`, 'utf8');

  if (!opts.noReport) {
    const written = updateRow(matrixPath(REPO), {
      id: s.id,
      result: verdict.ok ? '통과' : '실패',
      fingerprint: buildFingerprint(opts.zip),
      date: new Date().toISOString().slice(0, 10),
      evidence: `VM ${vm}/${s.snapshot} · _agent\\setup\\diagnostics.json`,
    });
    console.log(`시험 행렬 ${written ? '갱신' : '갱신 실패'}: docs/시험행렬.md ${s.id} 행`);
  }
  process.exitCode = verdict.ok ? 0 : 1;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

const isMain = process.argv[1] && process.argv[1].endsWith('run.mjs') && process.argv[1].includes('vm');
if (isMain) main().catch((e) => { console.error(`run.mjs: ${e.message}`); process.exitCode = 1; });
