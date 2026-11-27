// verify/upgrade-applier.mjs -- 업그레이드 게이트의 "적용기 길"(verify/upgrade.mjs --via-applier, 2.0.67)
//
// 왜: 업그레이드 게이트는 새 zip 의 설치기를 `--auto` 로 **직접** 띄운다. 그런데 IRIS 안 「업데이트」가 실제로 밟는 길은
//     창이 받아 둔 계획(plan.json) → 설치본의 적용기(<설치 폴더>\_agent\shared\tools\updater\apply.mjs) → 새 zip 의
//     IRIS-설치.cmd --auto → bootstrap.ps1 → 설치기 서버다. 앞의 세 마디(계획 · 옛 적용기 · 시작 파일)는 게이트가 밟지 않았다.
//     이 파일은 그 길을 밟는 데 필요한 조각이다: 창이 쓰는 꼴 그대로의 계획 만들기 · 적용기를 띄우는 명령 · 판정.
//
// 범위(2.0.67): **지금 동작을 굳히는 검사만.** 적용기(updater/apply.mjs)와 설치기는 고치지 않는다. 그래서 아래 판정에는
//     "고치고 싶은 지금 동작"도 있는 그대로 적혀 있다(이름 앞에 「지금 동작」): 적용기는 설치기를 띄운 **직후** 결과 파일에
//     ok:true 를 쓰고 끝나며(= "설치가 끝났다"가 아니라 "설치기에 넘겼다"), 설치기는 끝난 뒤에도 그 파일을 다시 쓰지 않는다.
//     이 동작을 바꾸는 판은 이 판정을 **함께** 바꾼다(docs\설계-업데이트적용기-약속.md 4절).
//
// 이 파일의 함수는 순수하거나(판정 · 글 만들기) 넘겨받은 폴더 안에만 쓴다(계획 놓기). 프로세스를 띄우거나 끝내지 않는다 —
// 그것은 verify/upgrade.mjs 가 한다. 단위 시험 = tests/upgrade-applier.test.mjs.

import fs from 'node:fs';
import path from 'node:path';

/** 창이 쓰는 계획의 판(P01 daemon/update.mjs) = 적용기가 받는 판(updater/apply.mjs PLAN_SCHEMA). 올리면 옛 적용기가 멈춘다. */
export const PLAN_SCHEMA = 1;
/** 계획 파일 이름(받아 둔 폴더 바로 아래) */
export const PLAN_FILE = 'plan.json';
/** 설치 패키지를 풀어 둔 폴더 이름(받아 둔 폴더 바로 아래) */
export const PACKAGE_DIR = 'package';

const pad2 = (n) => String(n).padStart(2, '0');
/** 창의 `stamp()` 와 같은 꼴: YYYYMMDD-HHMMSS(이 PC 의 시각). */
export function windowStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 창이 받아 두는 자리: <설치 폴더>\_agent\shared\downloads\update-<시각>. 적용기는 이 downloads 아래의 폴더만 받는다. */
export function stagingDir(root, ms) {
  return path.join(root, '_agent', 'shared', 'downloads', `update-${windowStamp(ms)}`);
}

/**
 * 창이 쓰는 꼴 그대로의 계획(설치 패키지 한 부품).
 *   { schema: 1, root, daemonPort, daemonPid, createdAt, items: [{ kind: 'package', dir, version }], relaunch }
 * 칸의 이름 · 차례는 창의 것과 같다. 값이 다른 곳은 둘이다(게이트가 진짜 창을 건드리지 않게):
 *   daemonPid · daemonPort = 이미 끝난 번호 · 닫힌 포트(게이트가 준다 — 적용기는 그 둘이 사라질 때까지 기다린다)
 *   relaunch = false(창은 true). 넘기기가 실패했을 때 적용기가 연습 폴더의 IRIS 창을 진짜로 띄우지 않게.
 *              넘기기가 성공하면 적용기는 이 칸을 쓰지 않는다(창을 다시 여는 것은 설치기 몫).
 */
export function buildPlan({ root, packageDir, version, daemonPort, daemonPid, createdAt, relaunch = false }) {
  if (!root || !packageDir || !version) throw new Error('buildPlan: root, packageDir and version are required');
  return {
    schema: PLAN_SCHEMA,
    root,
    daemonPort,
    daemonPid,
    createdAt,
    items: [{ kind: 'package', dir: packageDir, version }],
    relaunch,
  };
}

/** 계획을 창처럼 쓴다(임시 파일 → 이름 바꾸기, 두 칸 들여쓰기). 돌려주는 값 = 계획 파일 경로. */
export function writePlan(dir, plan) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PLAN_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 창이 적용기를 띄우는 꼴: 동봉 node · `apply.mjs --plan <계획>` · 작업 폴더 = 적용기 폴더. 넘기는 인자는 계획 하나뿐이다. */
export function applierCommand(root, planFile) {
  const apply = path.join(root, '_agent', 'shared', 'tools', 'updater', 'apply.mjs');
  return {
    exe: path.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe'),
    args: [apply, '--plan', planFile],
    cwd: path.dirname(apply),
    apply,
  };
}

/**
 * 풀어 놓은 **사본**의 bootstrap.ps1 에서 브라우저 열기만 끈다(환경 변수 IRIS_VERIFY_NO_BROWSER=1 일 때).
 * 적용기 길은 진짜 시작 파일을 거치므로 그대로 두면 이 PC 의 브라우저에 설치 화면 탭이 열린다. zip 과 저장소의 원본은 건드리지 않는다
 * (verify/upgrade.mjs 의 neutralizeRelaunchIfLegacy 와 같은 방식 — 사본에만 덧댄다). 끄는 것은 그 한 줄뿐이고, 서버 띄우기 ·
 * 지문 확인 · node 풀기는 원본 그대로다. 자리를 찾지 못하면 던진다(브라우저를 여는 채로 조용히 진행하지 않는다).
 */
export const NO_BROWSER_ENV = 'IRIS_VERIFY_NO_BROWSER';
export function shimBootstrapNoBrowser(text) {
  // 줄끝(CRLF/LF)은 그 줄의 것을 그대로 둔다. 그 줄이 정확히 하나일 때만 덧댄다.
  const anchor = /^([ \t]*)Start-Process \$url[ \t]*(\r?)$/gm;
  if (text.includes(NO_BROWSER_ENV)) return { text, changed: false };
  const hits = text.match(anchor) ?? [];
  if (hits.length !== 1) throw new Error(`bootstrap.ps1: expected exactly one browser-opening line (Start-Process $url), found ${hits.length} -- refusing to run the applier route with a browser that would open`);
  const out = text.replace(anchor, (m, indent, cr) => `${indent}if ($env:${NO_BROWSER_ENV} -eq '1') { Log 'Browser not opened (${NO_BROWSER_ENV}=1, verify gate).' } else { Start-Process $url }${cr}`);
  return { text: out, changed: true };
}

// ---------------------------------------------------------------------------
// 판정 — 전부 { name, ok, detail } 의 목록을 돌려준다(게이트가 그대로 찍는다)
// ---------------------------------------------------------------------------
const row = (name, ok, detail = '') => ({ name, ok: !!ok, detail });

/** 적용기가 표준 출력에 낸 마지막 JSON 줄(없으면 null). */
export function lastJsonLine(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* 다음 줄 */ }
  }
  return null;
}

/**
 * ⓝ-1 적용기가 설치기에 넘겼는가 — 적용기 프로세스의 끝(종료 코드 · 출력)과 그때의 결과 파일.
 *   exit       { code, signal }       적용기 프로세스
 *   stdout     적용기의 표준 출력
 *   result     적용기가 끝난 직후의 update-result.json(없으면 null)
 *   version    계획의 판(= 새 판)
 */
export function judgeHandoff({ exit, stdout, result, version }) {
  const out = [];
  const printed = lastJsonLine(stdout);
  // 실패 사유는 결과의 맨 위(모르는 판 · 데몬이 안 끝남)나 부품 줄(시작 파일 없음 · 새로 설치 필요)에 있다.
  const why = printed?.reason ?? (Array.isArray(printed?.items) ? printed.items.find((i) => i?.reason)?.reason : null) ?? null;
  out.push(row('ⓝ 적용기가 계획을 받아 종료 코드 0 으로 끝났다', exit?.code === 0, `code=${exit?.code ?? null} signal=${exit?.signal ?? null}${why ? ` reason=${why}` : ''}`));
  const item = Array.isArray(result?.items) ? result.items.find((i) => i?.kind === 'package') : null;
  out.push(row('ⓝ 결과 파일이 있고 설치 패키지 한 줄이 계획의 판이다', !!result && !!item && item.version === version && result.items.length === 1,
    result ? `items=${JSON.stringify(result.items ?? null).slice(0, 160)}` : 'update-result.json 없음'));
  // 「지금 동작」: ok:true 는 "설치기를 띄우는 데 성공했다"는 뜻이다. 설치가 끝났다는 뜻이 아니다.
  out.push(row('ⓝ 「지금 동작」 결과 파일 = 넘김 성공(ok:true · handedOffToInstaller:true · relaunched:false)',
    result?.ok === true && result?.handedOffToInstaller === true && result?.relaunched === false && item?.ok === true,
    result ? JSON.stringify({ ok: result.ok, handedOffToInstaller: result.handedOffToInstaller ?? null, relaunched: result.relaunched ?? null }) : ''));
  out.push(row('ⓝ 적용기가 낸 글과 결과 파일이 같은 내용이다', !!printed && !!result && JSON.stringify(printed) === JSON.stringify(result),
    printed ? '' : '표준 출력에서 결과 줄을 찾지 못함'));
  out.push(row('ⓝ 결과의 시각(at)이 읽히는 시각이다', Number.isFinite(Date.parse(result?.at ?? '')), String(result?.at ?? '')));
  return out;
}

/**
 * ⓝ-2 「지금 동작」 넘긴 직후의 사실 — 적용기가 끝난 그때 설치는 아직 끝나지 않았다.
 *   receiptVersionAtExit   적용기가 끝난 직후 읽은 영수증의 판
 *   prevVersion · nextVersion
 */
export function judgeHandoffIsNotCompletion({ receiptVersionAtExit, prevVersion, nextVersion }) {
  return [row('ⓝ 「지금 동작」 적용기가 "ok" 를 적은 때 영수증은 아직 옛 판이다(ok = 넘김 성공이지 설치 완료가 아니다)',
    receiptVersionAtExit === prevVersion && receiptVersionAtExit !== nextVersion, `영수증 ${receiptVersionAtExit ?? '(없음)'} · 옛 ${prevVersion} · 새 ${nextVersion}`)];
}

/**
 * ⓝ-3 적용기의 기록(update.log) — 계획을 읽고 · 데몬이 사라진 것을 확인하고 · 시작 파일을 --auto 로 띄웠다.
 *   logText   <설치 폴더>\_agent\setup\update.log 가운데 이번 실행이 덧붙인 부분
 *   soulName  설치 폴더의 이름(적용기가 설치기에 넘기는 이름)
 */
export function judgeApplierLog({ logText, version, soulName }) {
  const text = String(logText ?? '');
  const out = [];
  out.push(row('ⓝ 적용기 기록: 계획(판 1 · 설치 패키지 한 부품)을 읽었다', new RegExp(`apply start root=.* schema=${PLAN_SCHEMA} items=package@${String(version).replace(/\./g, '\\.')}(\\s|$)`, 'm').test(text),
    (text.match(/apply start[^\r\n]*/) ?? ['(apply start 줄 없음)'])[0].slice(0, 160)));
  out.push(row('ⓝ 적용기 기록: 데몬이 사라진 것을 확인한 뒤에 움직였다', /daemon gone after \d+ms/.test(text) && text.indexOf('daemon gone after') < text.indexOf('package: started'),
    (text.match(/daemon (gone|still)[^\r\n]*/) ?? ['(daemon 줄 없음)'])[0].slice(0, 120)));
  const started = /package: started (.+?IRIS-설치\.cmd) \(pid (\d+)\) with IRIS_INSTALLER_AUTO=1 soul=(\S+)/.exec(text);
  out.push(row('ⓝ 적용기 기록: 새 zip 의 시작 파일을 --auto 로 띄우고 이 설치 폴더의 이름을 넘겼다', !!started && started[3] === soulName,
    started ? `pid ${started[2]} soul=${started[3]}` : '(package: started 줄 없음)'));
  out.push(row('ⓝ 적용기 기록: ok=true 로 끝났다', /apply done ok=true/.test(text), (text.match(/apply done[^\r\n]*/) ?? ['(apply done 줄 없음)'])[0].slice(0, 80)));
  return out;
}
/** 적용기 기록에서 띄운 시작 파일 프로세스의 번호(없으면 null). 게이트가 끝낼 때 "우리가 띄운 것"을 가리는 데만 쓴다. */
export function startedCmdPid(logText) {
  const m = /package: started .+? \(pid (\d+)\)/.exec(String(logText ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * ⓝ-4 설치기가 끝난 뒤.
 *   resultAtExit    적용기가 끝난 직후의 결과 파일 글(바이트 그대로의 문자열)
 *   resultAtEnd     설치기가 끝난 뒤의 결과 파일 글
 *   installerDoneMs 설치기의 autoResult 를 본 시각(ms)
 *   planAtStart · planAtEnd   계획 파일 글
 *   packageDirExists 받아 둔 설치 패키지 폴더가 남아 있는가
 */
export function judgeAfterInstaller({ resultAtExit, resultAtEnd, installerDoneMs, planAtStart, planAtEnd, packageDirExists }) {
  const out = [];
  let at = NaN;
  try { at = Date.parse(JSON.parse(resultAtExit).at); } catch { at = NaN; }
  out.push(row('ⓝ 「지금 동작」 결과 파일의 시각은 설치기가 끝나기 전이다(넘긴 직후에 쓴 것)', Number.isFinite(at) && Number.isFinite(installerDoneMs) && at < installerDoneMs,
    `결과 ${Number.isFinite(at) ? new Date(at).toISOString() : '(읽지 못함)'} · 설치기 끝 ${Number.isFinite(installerDoneMs) ? new Date(installerDoneMs).toISOString() : '(모름)'}`));
  out.push(row('ⓝ 「지금 동작」 설치기는 끝난 뒤에도 결과 파일을 다시 쓰지 않는다(적용기가 쓴 그대로)', typeof resultAtExit === 'string' && resultAtExit.length > 0 && resultAtExit === resultAtEnd,
    resultAtExit === resultAtEnd ? '' : '결과 파일이 달라졌다 — 설치기가 마지막 결과를 쓰게 고쳤다면 이 판정을 함께 바꾼다'));
  out.push(row('ⓝ 적용기와 설치기는 계획 파일을 고치지 않는다', typeof planAtStart === 'string' && planAtStart === planAtEnd, planAtStart === planAtEnd ? '' : 'plan.json 이 달라졌다'));
  out.push(row('ⓝ 받아 둔 설치 패키지 폴더는 그대로 남는다(치우는 것은 창의 몫)', packageDirExists === true));
  return out;
}

/**
 * ⓝ-5 「내 것 유지」는 잠긴 채다 — 새로 깔린 적용기 폴더에 능력 표가 없거나, 있어도 keepFiles 가 true 가 아니다.
 * 창은 `<적용기 폴더>\capabilities.json` 의 keepFiles === true 하나만 보고 파일 선택을 푼다. 고친 파일을 남기는 장치가 없는 판이
 * 이 값을 true 로 내면 창이 "남기겠다"고 약속한 파일이 통째 교체된다.
 *   capabilitiesText   그 파일의 글(없으면 null)
 */
export function judgeKeepFilesLocked({ capabilitiesText }) {
  if (capabilitiesText == null) return [row('ⓝ 「내 것 유지」 잠김: 새 적용기에 능력 표(capabilities.json)가 없다', true, '파일 없음 = 창이 파일 선택을 잠근다')];
  let keep = null; let readable = true;
  try { keep = JSON.parse(capabilitiesText)?.keepFiles; } catch { readable = false; }
  return [row('ⓝ 「내 것 유지」 잠김: 능력 표가 있어도 keepFiles 가 true 가 아니다', readable ? keep !== true : true,
    readable ? `keepFiles=${JSON.stringify(keep ?? null)}` : '읽히지 않는 글 = 창은 거짓으로 본다')];
}
