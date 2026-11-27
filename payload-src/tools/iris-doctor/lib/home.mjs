// IRIS Doctor 의 자기 자리(Doctor 집) — 창 · 중계기 · 평소 설정 폴더 밖에 따로 둔다(그것들이 깨져도 남게).
//   <영혼>\_agent\doctor\
//     cards\claude.json     클로드 카드(1년 열쇠 — 비밀)        cards\codex.json  코덱스 카드(전용 로그인 폴더를 가리킴)
//     claude-home\          Doctor 전용 클로드 설정 폴더(평소 설정 · 훅 · 도구 연결을 물려받지 않는 깨끗한 방)
//     codex-home\           Doctor 전용 코덱스 폴더(전용 로그인의 열쇠 + Doctor 것 설정)
//     work\                 Doctor 가 도는 작업 폴더        records\  진료 기록 · 사본(걸음 ④)
// 진단기(diagnose)는 이 자리를 읽기만 한다. 쓰는 것은 연결(link) · 실행(launch) · 치료 쪽뿐이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function doctorPaths(root) {
  const home = path.join(root, '_agent', 'doctor');
  return {
    home,
    cards: path.join(home, 'cards'),
    claudeCard: path.join(home, 'cards', 'claude.json'),
    codexCard: path.join(home, 'cards', 'codex.json'),
    // 바꾸는 중인 새 연결(후보) — 실제 연결에 성공한 뒤에만 위의 것과 바꿔 낀다
    claudeNext: path.join(home, 'cards', 'claude.next.json'),
    // 코덱스 후보 폴더는 실행마다 따로 만든다(codex-home.next-<시각>-<프로세스 번호>) — 앞선 실행의 프로그램이 아직 살아 있어도 같은 폴더를 다시 쓰지 않게
    codexNextPrefix: path.join(home, 'codex-home.next-'),
    codexSwap: path.join(home, 'codex-swap.json'), // 코덱스 폴더를 바꿔 끼는 동안만 있는 쪽지(도중에 끊겼을 때 되돌리는 근거)
    linkLock: path.join(home, 'link.lock'),        // 연결을 바꾸는 일은 한 번에 하나만
    claudeHome: path.join(home, 'claude-home'),
    codexHome: path.join(home, 'codex-home'),
    work: path.join(home, 'work'),
    records: path.join(home, 'records'),
  };
}

/** 파일을 한 번에 바꿔 쓴다(쓰다 끊겨도 반쯤 쓴 파일이 남지 않게). 실패하면 임시 파일을 치운다(열쇠가 든 임시 파일이 남지 않게). */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

/**
 * 폴더를 "이 사용자 · 시스템 · 관리자"만 열 수 있게 한다(윈도우 권한 — 물려받는 권한을 끊고 셋에게만 준다. 안에 새로 생기는 파일도 따라온다).
 * 열쇠가 든 Doctor 집 전체에 건다. 실패해도 일은 계속한다(돌려주는 값으로 알린다) — 권한을 못 걸었다고 Doctor 가 멎으면 안 된다.
 * → true 걸림 | false 못 걺
 */
// 권한을 거는 방식의 판 번호(표시 파일에 적는다): v2 = 이미 있던 파일도 읽히게 · v3 = 먼저 있던 다른 사용자의 권한까지 지움
const PROTECT_VERSION = 'v3';

// 권한 거는 스크립트(윈도우 PowerShell). 폴더 자리는 환경 변수로 넘긴다(한글 · 괄호가 든 경로가 명령 글에서 깨지지 않게).
//   ① 맨 위 폴더의 권한 목록을 **통째로 새로 쓴다**: 물려받기를 끊고, 이 사용자 · 시스템(S-1-5-18) · 관리자 묶음(S-1-5-32-544)만 남긴다.
//      (권한을 "덧붙이는" 방식은 먼저 누가 따로 넣어 둔 다른 사용자의 권한을 못 지운다 — 통째로 바꿔야 한다.)
//   ② 안에 이미 있던 것: 저마다의 권한을 지우고 맨 위 폴더의 것을 물려받게 한다.
//      (맨 위와 같은 명령을 안쪽까지 한 번에 걸면 안 된다 — 이미 있던 파일이 주인도 못 여는 파일이 된다. 2026-11-26 이 노트북 실증)
//   ③ 다시 읽어 셋 말고 다른 이가 없는지 확인한 뒤에만 OK 를 낸다.
const PROTECT_PS = [
  "$ErrorActionPreference='Stop'",
  '$d=$env:IRIS_DOCTOR_PROTECT_DIR',
  '$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  "$allow=@($me,'S-1-5-18','S-1-5-32-544')",
  '$acl=New-Object System.Security.AccessControl.DirectorySecurity',
  '$acl.SetAccessRuleProtection($true,$false)',
  "foreach($s in $allow){$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($s)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}",
  // Set-Acl 은 쓰지 않는다 — 폴더에 따라 감사 목록까지 쓰려다 'SeSecurityPrivilege' 가 없다고 거절된다(2026-11-26 이 노트북의 실제 Doctor 집에서 실측). 권한 목록만 쓰는 호출을 쓴다.
  '[System.IO.Directory]::SetAccessControl($d,$acl)',
  "if(@(Get-ChildItem -LiteralPath $d -Force).Count){ & icacls.exe (Join-Path $d '*') /reset /T /C /Q | Out-Null; if($LASTEXITCODE -ne 0){exit 3} }",
  '$bad=@((Get-Acl -LiteralPath $d).Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Where-Object { $allow -notcontains $_ })',
  'if($bad.Count){exit 4}',
  "'IRIS-DOCTOR-PROTECT-OK'",
].join('; ');

export function protectDir(dir, { env = process.env, run = spawnSync } = {}) {
  if (process.platform !== 'win32') return false;
  try {
    const sys = env.SystemRoot || 'C:\\Windows';
    const ps = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROTECT_PS], {
      windowsHide: true, encoding: 'utf8', timeout: 30000,
      // PATHEXT 가 없으면 PowerShell 이 icacls.exe 를 "프로그램"이 아니라 "문서"로 보고 실행을 거절한다(2026-11-26 실측)
      env: { SystemRoot: sys, windir: sys, SystemDrive: env.SystemDrive || 'C:', PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: os.tmpdir(), TMP: os.tmpdir(), PATH: `${path.join(sys, 'System32')};${sys}`, IRIS_DOCTOR_PROTECT_DIR: dir },
    });
    return r.status === 0 && String(r.stdout || '').includes('IRIS-DOCTOR-PROTECT-OK');
  } catch { return false; }
}

/** Doctor 집에 권한이 걸려 있다는 표시가 있는가(지금 방식의 판으로). */
export function isProtected(root) { try { return fs.readFileSync(path.join(doctorPaths(root).home, '.protected'), 'utf8').startsWith(`${PROTECT_VERSION} `); } catch { return false; } }

/**
 * 코덱스 폴더 바꿔 끼기가 도중에 끊겼으면 되돌리거나 마저 끝낸다(바꿔 끼기 전에 적어 둔 쪽지 codex-swap.json 을 본다).
 *   후보 폴더가 아직 있다 = 새 폴더가 자리에 못 들어갔다 → 옛 폴더를 제자리로 되돌린다(옛 연결이 그대로 산다).
 *   후보 폴더가 없다     = 새 폴더는 자리에 들어갔다 → 카드를 새 계정 것으로 맞추고(확인 기록 없이) 옛 폴더를 치운다.
 * Doctor 집을 마련하기 전에 부른다(빈 폴더를 새로 만들어 옛 폴더의 자리를 막지 않게).
 */
/** 그 자리가 Doctor 집 바로 아래의 "<이름표><숫자…>" 폴더인가(쪽지 · 인자가 엉뚱한 자리를 가리켜도 건드리지 않게). */
export function inDoctorHome(root, dir, re) {
  const p = doctorPaths(root);
  return typeof dir === 'string' && path.dirname(path.resolve(dir)).toLowerCase() === path.resolve(p.home).toLowerCase() && re.test(path.basename(dir));
}
export const CODEX_NEXT_RE = /^codex-home\.next-\d+-\d+$/;
const CODEX_OLD_RE = /^codex-home\.old-\d+$/;
/** 지금 남아 있는 코덱스 후보 폴더들. */
export function listCodexNext(root) {
  const p = doctorPaths(root);
  try { return fs.readdirSync(p.home).filter((n) => CODEX_NEXT_RE.test(n)).map((n) => path.join(p.home, n)); } catch { return []; }
}

/**
 * **연결 잠금을 쥔 실행만 부른다**(다른 실행이 지금 바꿔 끼는 중일 수 있다 — 잠금 없이 부르면 진행 중인 것을 끊긴 것으로 잘못 본다).
 * → null 쪽지 없음 | 'rolled-back' | 'finished' | 'nothing' | 'failed'(쪽지를 남긴다 — 다음에 다시 본다)
 */
export function recoverCodexSwap(root) {
  const p = doctorPaths(root);
  if (!fs.existsSync(p.codexSwap)) return null;
  const j = readJsonFile(p.codexSwap);
  if (!j) { try { fs.rmSync(p.codexSwap, { force: true }); } catch {} return null; } // 쪽지는 한 번에 바꿔 쓰므로 깨졌으면 근거가 못 된다
  const old = inDoctorHome(root, j.old, CODEX_OLD_RE) ? path.resolve(j.old) : null;
  const next = inDoctorHome(root, j.next, CODEX_NEXT_RE) ? path.resolve(j.next) : null;
  const hasAuth = (d) => fs.existsSync(path.join(d, 'auth.json'));
  const oldThere = !!old && fs.existsSync(old);
  const rollBack = () => { // 옛 폴더를 제자리로(사이에 생긴 빈 폴더는 치운다). 정식 폴더에 로그인이 있으면 덮지 않는다.
    if (fs.existsSync(p.codexHome) && !hasAuth(p.codexHome)) fs.rmSync(p.codexHome, { recursive: true, force: true });
    if (fs.existsSync(p.codexHome)) return false;
    fs.renameSync(old, p.codexHome);
    return true;
  };
  let did = 'nothing';
  try {
    if (next && fs.existsSync(next)) {
      // 새 폴더가 아직 자리에 못 들어갔다
      if (oldThere && !rollBack()) return 'failed';
      if (oldThere) did = 'rolled-back';
    } else if (hasAuth(p.codexHome)) {
      // 새 폴더가 자리에 들어갔다 → 카드를 새 계정 것으로 맞추고(확인 기록 없이) 옛 폴더를 치운다
      const card = readJsonFile(p.codexCard);
      if (!card || card.swap !== j.id) {
        const stamp = typeof j.at === 'string' && Number.isFinite(Date.parse(j.at)) ? j.at : new Date().toISOString();
        writeAtomic(p.codexCard, JSON.stringify({ v: 1, kind: 'codex', source: 'own-login', linkedAt: stamp, lastOkAt: null, lastFailAt: null, credit: 'unknown', billingAckAt: null, preparedAt: stamp, swap: j.id ?? null }, null, 2));
      }
      if (oldThere) fs.rmSync(old, { recursive: true, force: true });
      did = 'finished';
    } else if (oldThere) {
      if (!rollBack()) return 'failed';
      did = 'rolled-back';
    }
    fs.rmSync(p.codexSwap, { force: true });
  } catch { return 'failed'; }
  return did;
}

export function readJsonFile(file) {
  try { const s = fs.readFileSync(file, 'utf8'); return JSON.parse(s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s); } catch { return null; }
}

// 클로드코드가 새 설정 폴더의 첫 실행에 띄우는 안내창을 "이미 봤음"으로 — 창 daemon/trust.mjs CLAUDE_START_NUDGES 와 같은 표.
// (신뢰 · 권한 물음을 대신 승인하는 것이 아니다: Doctor 전용 작업 폴더 하나에 대한 신뢰만 적는다.)
export const CLAUDE_START_NUDGES = Object.freeze({ hasCompletedClaudeInChromeOnboarding: true, fullscreenUpsellSeenCount: 3, hasSeenAutoDefaultNudge: true });
const projectKey = (cwd) => String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');

/** Doctor 의 폴더들과 깨끗한 클로드 설정 폴더를 마련한다(있는 값은 덮지 않는다). */
export function ensureHome(root, { protect = true } = {}) {
  const p = doctorPaths(root);
  const fresh = !fs.existsSync(p.home);
  // 코덱스 폴더를 바꿔 끼는 중(쪽지가 있음)이면 그 폴더는 만들지 않는다 — 빈 폴더를 만들어 두면 진행 중인 바꿔 끼기 · 되돌리기의 자리를 막는다.
  // (끊긴 바꿔 끼기의 정리는 여기서 하지 않는다. 연결 잠금을 쥔 실행만 한다 — link.mjs withLinkLock)
  const swapping = fs.existsSync(p.codexSwap);
  for (const d of [p.cards, p.claudeHome, ...(swapping ? [] : [p.codexHome]), p.work, p.records]) fs.mkdirSync(d, { recursive: true });
  // 권한은 집을 처음 만들 때와, 걸렸다는 표시가 없을 때 건다(매번 걸지 않는다 — 느리다)
  // 표시에는 거는 방식의 판 번호를 적는다 — 거는 방식을 고치면 옛 표시가 있는 PC 에서 한 번 다시 건다.
  // 못 걸면 옛 표시를 지운다(걸리지 않았는데 걸렸다고 남지 않게). 못 걸어도 일은 계속한다 — 상태 글과 검진표가 "권한 못 걺"을 알린다.
  const mark = path.join(p.home, '.protected');
  if (protect && (fresh || !isProtected(root))) {
    if (protectDir(p.home)) { try { fs.writeFileSync(mark, `${PROTECT_VERSION} ${new Date().toISOString()}`); } catch {} }
    else { try { fs.rmSync(mark, { force: true }); } catch {} }
  }
  p.protected = isProtected(root);
  const cj = path.join(p.claudeHome, '.claude.json');
  const data = readJsonFile(cj) || {};
  let changed = false;
  if (data.hasCompletedOnboarding === undefined) { data.hasCompletedOnboarding = true; changed = true; }
  for (const [k, v] of Object.entries(CLAUDE_START_NUDGES)) if (data[k] === undefined) { data[k] = v; changed = true; }
  if (!data.projects || typeof data.projects !== 'object') { data.projects = {}; changed = true; }
  const key = projectKey(p.work);
  if (!data.projects[key]) { data.projects[key] = { hasTrustDialogAccepted: true }; changed = true; }
  if (changed) writeAtomic(cj, JSON.stringify(data, null, 2));
  return p;
}
