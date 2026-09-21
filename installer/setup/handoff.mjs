// ⑦ 인수 문서 — `<영혼>\_agent\setup\handoff.json` (계약 = docs\인수문서-handoff-v2.md)
//
// 설치기가 Face 에게 건네는 **유일한 통로**다. Face 는 이 파일과 영수증만 읽고
// 세팅을 하지 않는다. 그래서 여기에는 딱 두 종류만 들어간다:
//   ① Face 가 분기에 쓰는 사실 — 다 됐나(`state`), 로그인은 끝났나, 무엇이 대기인가
//   ② Face 가 주도 에이전트에게 그대로 넘길 첫 인사 프롬프트(`firstMessage`)
//
// 넣지 않는 것: 토큰·키·이메일·사용자 이름·절대경로. 경로는 전부 영혼 루트
// 상대경로다(영혼 폴더를 통째로 옮겨도 그대로 읽힌다).
//
// 함께 하는 일이 하나 더 있다: 설치기 **프로그램 사본**을 영혼 안에 둔다
// (D2-21). 로그인이 남은 채 창을 닫아도 Face 의 「설치 이어하기」가
// `_agent\setup\installer\IRIS-설치.cmd --resume` 로 그 자리에서 이어 열 수 있다.
import nodeFs from 'node:fs';
import path from 'node:path';
import { assertInside, ensureDir, copyTreeIfAbsent } from '../lib/paths.mjs';
// 단계 목록은 공용 헬퍼에서 가져온다(엔진을 되부르지 않는다 — 계약: 모듈끼리
// 서로 import 하지 않는다). `lib/receipt.mjs` 의 것이 엔진 STAGES 와 같은 아홉 개다.
import { SETUP_STAGE_IDS as STAGES } from '../lib/receipt.mjs';

export const HANDOFF_SCHEMA = 1;

// 재개 진입점. 계약이 글자 그대로 정한 경로라 다른 이름을 쓰면 Face 가 못 찾는다.
export const RESUME_INSTALLER_PATH = '_agent/setup/installer/IRIS-설치.cmd';
export const RESUME_ARGS = Object.freeze(['--resume']);

export function setupDir(root) { return path.join(root, '_agent', 'setup'); }
export function handoffPath(root) { return path.join(setupDir(root), 'handoff.json'); }
export function installerCopyDir(root) { return path.join(setupDir(root), 'installer'); }

// 영혼 루트 상대경로 + 슬래시(계약 "경로는 전부 영혼 루트 상대경로").
export function relOf(root, p) {
  if (!p) return null;
  const rel = path.isAbsolute(p) ? path.relative(root, p) : String(p);
  return rel.split(/[\\/]+/).filter(Boolean).join('/');
}

function atomicWriteJson(fs, file, data) {
  ensureDir(path.dirname(file), { fs });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  return file;
}

// ---------------------------------------------------------------------------
// 첫 인사 프롬프트
// ---------------------------------------------------------------------------

// Face 는 이 문자열을 **만들지 않고 그대로** 주도 에이전트에 보낸다(계약 표).
// 그래서 문구가 여기 한 곳에만 있다. 선택형 질문 도구(AskUserQuestion)를 막는
// 한 줄은 실측에서 나온 것이다 — 첫 화면에 노란 카드가 뜨면 사용자가 무엇을
// 하는 건지 모른 채 멈춘다.
export function firstMessageText({ nameEnMissing = [], interview = false } = {}) {
  // 2.0.35(2026-09-21 사용자 결정): 설치기가 폴더를 만들지 않은 PC(interview) 에서는 "무엇부터 할까요" 대신
  // 첫 세션이 **의무적으로** 폴더 구조 인터뷰(대본 = `_agent/setup/interview.md`)를 시작한다. R(역할)부터 자세히.
  if (interview) {
    return '세팅이 끝났다. 이 PC에는 아직 작업 폴더(R/D/P)가 하나도 없다 — 설치기가 일부러 만들지 않았다. '
      + '`_agent/setup/interview.md`(인터뷰 대본)를 먼저 끝까지 읽고, 그 대본대로 사용자와 폴더 구조 인터뷰를 지금 바로 시작해. '
      + '인사는 두 줄만 하고 곧장 첫 질문(역할)으로 들어가. 선택형 질문 도구는 쓰지 말고 번호 목록으로, 한 번에 한 질문씩 물어봐. '
      + '인터뷰가 끝나 사용자가 확정하기 전에는 폴더를 만들지 마.';
  }
  const n = Array.isArray(nameEnMissing) ? nameEnMissing.length : 0;
  const nameLine = n > 0
    ? `영어 이름이 비어 있는 폴더가 ${n}개 있으니 채우기를 제안해.`
    : '영어 이름이 비어 있는 폴더가 있으면 채우기를 제안해.';
  return '세팅이 끝났다. `_agent/setup/handoff.json`을 읽고 사용자에게 3줄로 인사한 뒤 무엇부터 할지 물어봐. '
    + `${nameLine} `
    + '선택형 질문 도구는 쓰지 말고 번호 목록으로 물어봐.';
}

// ---------------------------------------------------------------------------
// 상태 판정
// ---------------------------------------------------------------------------

/**
 * setupSummary(receipt, { assumeDone }) — 아홉 단계가 다 끝났나.
 *
 * `assumeDone` 은 "지금 돌고 있는 단계"다. ⑨ 검사 자신이 이 파일을 쓰는 순간
 * 검사 단계는 아직 `running` 이라, 그것까지 세지 않으면 방금 성공한 설치가
 * 영원히 `setup-incomplete` 로 보인다.
 */
export function setupSummary(receipt, { assumeDone = [] } = {}) {
  const setup = receipt?.setup ?? {};
  const assume = new Set(assumeDone);
  let allDone = true;
  let failed = null;
  const doneIds = [];
  for (const id of STAGES) {
    const entry = setup[id];
    if (entry?.status === 'done' || assume.has(id)) { doneIds.push(id); continue; }
    allDone = false;
    if (entry?.status === 'failed' && !failed) {
      failed = { id, code: entry.code ?? null, message: entry.message ?? null };
    }
  }
  return { allDone, failed, doneCount: doneIds.length, total: STAGES.length };
}

const LOGIN_STATES = new Set(['not-needed', 'waiting', 'done', 'failed']);

// 영수증의 로그인 기록 → 계약이 정한 네 값 중 하나.
// 온라인 단계(T19)가 `receipt.login[provider]`(`lib/online.mjs`)에 적고, 서버는
// 같은 내용을 `receipt.online.logins` 에도 비춘다 — 둘 다 본다.
export function loginStateOf(receipt, provider, subscriptions = []) {
  if (!subscriptions.includes(provider)) return 'not-needed';
  const a = receipt?.login?.[provider];
  const b = receipt?.online?.logins?.[provider];
  const raw = a?.state ?? b?.state ?? null;
  if (raw === 'cli-done') return 'waiting'; // CLI 는 됐지만 중계기 등록 전 = 아직 끝난 게 아니다
  if (LOGIN_STATES.has(raw)) return raw;
  if (a?.relay === true || b?.relay === true) return 'done';
  return 'waiting';
}

export function loginBlock(receipt, subscriptions = []) {
  const out = {};
  for (const provider of ['claude', 'chatgpt']) {
    out[provider] = loginStateOf(receipt, provider, subscriptions);
  }
  return out;
}

export function relayBlock(receipt) {
  const r = receipt?.online?.relay ?? {};
  return { state: r.state ?? 'pending', accounts: Number(r.accounts ?? 0) };
}

/**
 * handoffState — Face 첫 실행의 세 갈래(계약 표).
 *   setup-incomplete : 아홉 단계가 덜 끝났다 → 안내 카드 + 「설치 이어하기」
 *   login-pending    : 세팅은 끝났고 고른 구독의 로그인이 남았다
 *   ready            : 첫 인사를 해도 되는 상태
 */
export function handoffState({ setup, login, subscriptions = [] }) {
  if (!setup?.allDone) return 'setup-incomplete';
  for (const provider of subscriptions) {
    if (login?.[provider] !== 'done') return 'login-pending';
  }
  return 'ready';
}

// ---------------------------------------------------------------------------
// 인수 문서 만들기
// ---------------------------------------------------------------------------

function structureRecorded(receipt) {
  return receipt?.setup?.structure?.recorded ?? {};
}

/** 루트 바로 아래에 역할 폴더(`R##-…`)가 하나라도 있는가. 읽기만 한다. */
export function rootHasRoles(root, fs = nodeFs) {
  try { return fs.readdirSync(root).some((n) => /^R\d{2}-/.test(n)); } catch { return false; }
}

function messengerBlock(ctx, receipt, { fs }) {
  const prior = receipt?.handoff?.messenger;
  if (prior && typeof prior.installed === 'boolean') return { ...prior };
  const dir = path.join(ctx.root, '_agent', 'shared', 'tools', 'face', 'modules', 'messenger');
  let installed = false;
  try { installed = fs.existsSync(dir); } catch { installed = false; }
  return { installed, prompted: false };
}

function packageVersionOf(ctx) {
  return ctx?.manifest?.package?.version
    ?? ctx?.receipt?.package?.version
    ?? ctx?.lock?.package?.version
    ?? null;
}

/**
 * buildHandoff(ctx, opts) — 파일에 쓸 객체 하나를 만든다(쓰지는 않는다).
 *
 * opts:
 *   checks        { pass, pending, fail }  개수 요약(⑨ 검사가 준다)
 *   pending       [{capability, reason, howToEnable?}]  엔진이 모은 대기 기능
 *   reportPath·diagnosticsPath   절대경로(여기서 상대경로로 바꾼다)
 *   assumeDone    지금 돌고 있는 단계 id 목록(검사가 통과했을 때만 ['checks'])
 *   failed        지금 돌고 있는 단계의 실패({id, code, message}). 영수증에는
 *                 아직 `running` 으로 적혀 있는 순간에도 실패를 실패로 적게 한다
 *                 — 이것이 없으면 검사가 깨진 설치가 `allDone:true` 로 남는다.
 *   state         강제 지정(시험용). 없으면 위 규칙으로 계산
 */
export function buildHandoff(ctx, {
  checks = { pass: 0, pending: 0, fail: 0 },
  pending = [],
  reportPath = null,
  diagnosticsPath = null,
  assumeDone = [],
  failed: forcedFailed = null,
  state: forcedState = null,
  fs = ctx?.fs ?? nodeFs,
  now = new Date(),
} = {}) {
  const root = ctx.root;
  const receipt = ctx.receipt ?? {};
  const subscriptions = Array.isArray(ctx?.choice?.subscriptions) ? ctx.choice.subscriptions.slice() : [];
  // 창(Face)은 'claude' | 'codex' 만 안다 — 구독 id 'chatgpt' 가 그대로 넘어가 코덱스만 고른 설치의 첫 세션이
  // 클로드로 열렸다(2026-09-19 데스크탑 실측, 2.0.25). 여기서 에이전트 이름으로 바꿔 적는다.
  const rawLead = ctx?.choice?.leadAgent ?? (subscriptions.includes('claude') ? 'claude' : (subscriptions[0] ?? null));
  const leadAgent = rawLead === 'chatgpt' ? 'codex' : rawLead;

  const summary = setupSummary(receipt, { assumeDone });
  const setupFailed = forcedFailed ?? summary.failed;
  const setup = { ...summary, allDone: summary.allDone && !setupFailed, failed: setupFailed };
  const login = loginBlock(receipt, subscriptions);
  const structure = structureRecorded(receipt);

  const folders = [...(structure.created ?? []), ...(structure.skipped ?? [])]
    .map((f) => relOf(root, f))
    .filter(Boolean);
  const nameEnMissing = (structure.nameEnMissing ?? []).slice();
  const deferred = (structure.deferred ?? []).slice();
  // 2.0.35: 인터뷰 방식인가 — 폴더 단계가 interview 로 끝났고 루트에 R 폴더가 정말 하나도 없을 때만.
  // (업데이트 PC 는 옛 구조 기록(created)이 남아 있고 R 폴더도 있으므로 지금 문장 그대로 — 인터뷰를 다시 하지 않는다.)
  const interview = structure.interview === true && !rootHasRoles(root, fs);

  const state = forcedState ?? handoffState({ setup, login, subscriptions });

  return {
    schema: HANDOFF_SCHEMA,
    packageVersion: packageVersionOf(ctx),
    writtenAt: now.toISOString(),
    state,
    subscriptions,
    leadAgent,
    login,
    relay: relayBlock(receipt),
    setup: { allDone: setup.allDone, failed: setup.failed },
    folders,
    // 2.0.35: 첫 세션이 볼 구조 상태. interview = 설치기가 R/D/P 를 만들지 않았고 첫 세션이 인터뷰로 만든다.
    structure: { mode: interview ? 'interview' : 'preset', folders: folders.length, script: interview ? '_agent\\setup\\interview.md' : null },
    nameEnMissing,
    deferred,
    pendingCapabilities: (pending ?? []).map((p) => ({
      capability: p.capability,
      reason: p.reason,
      ...(p.howToEnable ? { howToEnable: p.howToEnable } : {}),
    })),
    checks: {
      pass: Number(checks?.pass ?? 0),
      pending: Number(checks?.pending ?? 0),
      fail: Number(checks?.fail ?? 0),
    },
    reportPath: relOf(root, reportPath),
    diagnosticsPath: relOf(root, diagnosticsPath),
    firstMessage: firstMessageText({ nameEnMissing, interview }),
    messenger: messengerBlock(ctx, receipt, { fs }),
    resume: { installerPath: RESUME_INSTALLER_PATH, args: [...RESUME_ARGS] },
    setupCompletedAt: setup.allDone ? now.toISOString() : null,
  };
}

export function writeHandoff(ctx, opts = {}) {
  const fs = opts.fs ?? ctx?.fs ?? nodeFs;
  const root = ctx.root;
  const handoff = buildHandoff(ctx, { ...opts, fs });
  const file = assertInside(root, handoffPath(root), { fs });
  atomicWriteJson(fs, file, handoff);
  return { path: file, handoff };
}

export function readHandoff(root, { fs = nodeFs } = {}) {
  try {
    return JSON.parse(fs.readFileSync(handoffPath(root), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * refreshHandoffAfterOnline(ctx) — 로그인·중계기가 끝난 뒤 서버가 부른다.
 *
 * 설치기가 ⑨ 검사에서 이 파일을 쓸 때는 아직 로그인 전이라 `login-pending`
 * 이다. 온라인 묶음이 끝나면 같은 파일의 로그인·중계기·상태만 갱신한다.
 * Face 가 이미 고쳐 둔 `messenger.prompted` 는 건드리지 않는다(계약: 그 칸만
 * Face 의 것이다).
 */
export function refreshHandoffAfterOnline(ctx, { fs = ctx?.fs ?? nodeFs, now = new Date() } = {}) {
  const root = ctx.root;
  const prior = readHandoff(root, { fs });
  if (!prior) {
    // 인수 문서가 아직 없다 = ⑨ 검사가 돌지 않았다. 여기서 새로 만들지 않는다
    // (검사 결과 없이 "다 됐다"고 적을 수 없다). 그대로 알린다.
    return { path: handoffPath(root), handoff: null, written: false, reason: 'no-handoff' };
  }
  const receipt = ctx.receipt ?? {};
  const subscriptions = Array.isArray(prior.subscriptions) ? prior.subscriptions : [];
  const login = loginBlock(receipt, subscriptions);
  const setup = setupSummary(receipt, { assumeDone: [] });
  const next = {
    ...prior,
    writtenAt: now.toISOString(),
    login,
    relay: relayBlock(receipt),
    setup: { allDone: setup.allDone, failed: setup.failed },
    state: handoffState({ setup, login, subscriptions }),
  };
  if (next.state === 'ready' && !next.setupCompletedAt) next.setupCompletedAt = now.toISOString();
  const file = assertInside(root, handoffPath(root), { fs });
  atomicWriteJson(fs, file, next);
  return { path: file, handoff: next, written: true };
}

// ---------------------------------------------------------------------------
// 설치기 프로그램 사본 (D2-21)
// ---------------------------------------------------------------------------

// 사본에서 빼는 것: 시험·가짜·의존성 폴더. 부품(payload)은 통째로 뺀다 —
// "부품 없이 프로그램만"(D2-21). 몇 백 MB 를 영혼 안에 두 벌 두지 않는다.
//
// 마디(segment) 검사만으로는 모자란다: `installer\ui\mock-server.mjs` 나
// `tests\` 밖에 홀로 있는 `foo.test.mjs` 는 마디가 딱 맞지 않아 그대로 복사돼
// 버린다. 그래서 세 갈래로 본다 —
//   ① 마디가 통째로 시험·가짜·의존성 폴더            tests\ · __tests__\ · mocks\ · node_modules\ · .git\
//   ② 파일 이름이 `*.test.*`                        foo.test.mjs
//   ③ 마디가 `mock-`·`mock.` 으로 시작              mock-server.mjs · mocks.json
const COPY_SKIP = /(^|[\\/])(tests?|__tests__|mocks?|node_modules|\.git)([\\/]|$)|\.test\.[^\\/]*$|(^|[\\/])mocks?[-.]/i;

// 영혼 안 사본이 어느 판인지 적어 두는 자리. 이 파일이 있으면 그 사본은
// **그 판의 설치기**다(아래 "판이 다르면 갈아 끼운다").
export function installerCopyVersionPath(root) {
  return path.join(installerCopyDir(root), '.version');
}

function readCopyVersion(fs, root) {
  try {
    const v = String(fs.readFileSync(installerCopyVersionPath(root), 'utf8')).trim();
    return v || null;
  } catch {
    return null;
  }
}

function copyFileIfAbsent(fs, root, src, dst) {
  assertInside(root, dst, { fs });
  if (fs.existsSync(dst)) return { written: false, kept: true };
  if (!fs.existsSync(src)) return { written: false, kept: false, missingSource: true };
  ensureDir(path.dirname(dst), { fs });
  const tmp = `${dst}.tmp`;
  fs.writeFileSync(tmp, fs.readFileSync(src));
  fs.renameSync(tmp, dst);
  return { written: true, kept: false };
}

/**
 * copyInstallerProgram(ctx) — zip 안 설치기 프로그램을 영혼 안으로.
 *
 * 만들어지는 모양(= zip 루트와 같은 모양이라야 `IRIS-설치.cmd` 가 자기 옆
 * `installer\bootstrap.ps1` 을 찾는다):
 *
 *   _agent\setup\installer\IRIS-설치.cmd        ← 계약이 정한 재개 진입점
 *   _agent\setup\installer\installer\…          ← bootstrap.ps1·server.mjs·ui·lib
 *   _agent\setup\installer\lib\…                ← server.mjs 가 `../lib/run.mjs` 로 부른다
 *   _agent\setup\installer\lock.json
 *   _agent\setup\installer\payload\manifest.json ← 부품 0개짜리 표(아래 주석)
 *
 * 마지막 한 줄이 필요한 이유: `bootstrap.ps1` 은 `payload\manifest.json` 이 없으면
 * "zip 을 먼저 푸세요"(코드 10)로 멈춘다. 부품을 뺀 사본이니 부품 표는 비우고
 * 표 자체는 둔다 — 무결성 검사가 0개를 돌고 지나가고, Node 는 이미 이 PC 에
 * 풀려 있는 것(%LOCALAPPDATA%\IRIS-Installer\node)을 재사용한다.
 *
 * **판이 다르면 갈아 끼운다.** 사본은 덮어쓰지 않는 것이 규칙이지만(무삭제),
 * 2.0.0 으로 깔린 영혼에 2.0.1 을 설치하면 낡은 사본이 그대로 남아 「설치
 * 이어하기」가 **구판 화면**을 연다. 그래서 `.version` 을 함께 두고, 판이
 * 다르면 옆에 새로 지은 뒤(`installer.new`) 한 번에 바꿔 끼우고 직전 것은
 * `installer.prev` 로 한 세대만 남긴다. 사용자 자료가 아니라 설치기 자신의
 * 물건이라 이것만은 갈아 끼울 수 있다.
 */
export function copyInstallerProgram(ctx, { fs = ctx?.fs ?? nodeFs, log = ctx?.log ?? (() => {}) } = {}) {
  const root = ctx.root;
  const finalDir = assertInside(root, installerCopyDir(root), { fs });
  // zip 안에서는 `installer\` 가 `payload\` 옆에 있다. 서버가 `zipRoot` 를 따로
  // 넘겨 주면 그것을 먼저 믿는다(빌드 중간 폴더를 payload 로 가리키는 시험 실행
  // 처럼, payload 의 부모가 zip 루트가 아닌 경우가 있다).
  const zipRoot = [ctx.zipRoot, ctx.payloadDir ? path.dirname(ctx.payloadDir) : null]
    .filter(Boolean)
    .find((dir) => { try { return fs.existsSync(path.join(dir, 'installer')); } catch { return false; } })
    ?? (ctx.payloadDir ? path.dirname(ctx.payloadDir) : null);
  const version = packageVersionOf(ctx);
  const had = readCopyVersion(fs, root);
  // 판을 알 수 없으면(꾸러미 표가 없는 시험 등) 갈아 끼우지 않는다 — 모르는
  // 이유로 멀쩡한 사본을 버리는 것이 낡은 사본보다 나쁘다.
  const stale = Boolean(version) && fs.existsSync(finalDir) && had !== version;
  const dest = stale ? `${finalDir}.new` : finalDir;

  const result = {
    dir: relOf(root, finalDir),
    entry: RESUME_INSTALLER_PATH,
    copied: 0,
    kept: 0,
    ok: false,
    missing: [],
    version: version ?? null,
    previousVersion: had,
    replaced: false,
  };
  if (!zipRoot || !fs.existsSync(path.join(zipRoot, 'installer'))) {
    result.missing.push('installer');
    log('[handoff] 설치기 사본을 만들 원본(installer 폴더)을 찾지 못했습니다.');
    return result;
  }

  // 지난번에 갈아 끼우다 만 찌꺼기가 있으면 치우고 새로 짓는다.
  if (stale) {
    assertInside(root, dest, { fs });
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 없으면 그만 */ }
    log(`[handoff] 설치기 사본이 낡았습니다(${had ?? '판 모름'} → ${version}) — 새로 지어 바꿔 끼웁니다.`);
  }
  ensureDir(dest, { fs });

  // ① installer\ 통째로(시험·가짜 제외)
  const tree = copyTreeIfAbsent(path.join(zipRoot, 'installer'), path.join(dest, 'installer'), {
    fs, root, filter: (rel) => !COPY_SKIP.test(rel),
  });
  result.copied += tree.written.length;
  result.kept += tree.kept.length;

  // ② 옆에 있는 lib\ (server.mjs 가 `../lib/run.mjs` 로 부른다)
  if (fs.existsSync(path.join(zipRoot, 'lib'))) {
    const libTree = copyTreeIfAbsent(path.join(zipRoot, 'lib'), path.join(dest, 'lib'), {
      fs, root, filter: (rel) => !COPY_SKIP.test(rel),
    });
    result.copied += libTree.written.length;
    result.kept += libTree.kept.length;
  } else {
    result.missing.push('lib');
  }

  // ③ 진입점 — 계약이 정한 **정확한** 자리. zip 루트 것이 먼저, 없으면 installer\ 안의 같은 파일.
  const entryDst = path.join(dest, 'IRIS-설치.cmd');
  let entry = copyFileIfAbsent(fs, root, path.join(zipRoot, 'IRIS-설치.cmd'), entryDst);
  if (!entry.written && !entry.kept) {
    entry = copyFileIfAbsent(fs, root, path.join(zipRoot, 'installer', 'IRIS-설치.cmd'), entryDst);
  }
  if (entry.written) result.copied += 1;
  if (entry.kept) result.kept += 1;

  // ④ 잠금표
  const lock = copyFileIfAbsent(fs, root, path.join(zipRoot, 'lock.json'), path.join(dest, 'lock.json'));
  if (lock.written) result.copied += 1;
  if (lock.kept) result.kept += 1;

  // ⑤ 부품 0개짜리 manifest
  const mfFile = path.join(dest, 'payload', 'manifest.json');
  assertInside(root, mfFile, { fs });
  if (!fs.existsSync(mfFile)) {
    const source = ctx.manifest ?? {};
    atomicWriteJson(fs, mfFile, {
      ...(source.schema ? { schema: source.schema } : {}),
      package: source.package ?? { name: 'IRIS', version: packageVersionOf(ctx) },
      built: source.built ?? null,
      parts: {},
      resumeOnly: true,
      note: '재개 전용 사본입니다. 부품(payload)은 들어 있지 않습니다.',
    });
    result.copied += 1;
  } else {
    result.kept += 1;
  }

  // ⑥ 판 표시 — 다음 설치가 "이 사본이 몇 판인가"를 이걸로 판정한다.
  if (version) {
    const vFile = assertInside(root, path.join(dest, '.version'), { fs });
    const tmp = `${vFile}.tmp`;
    fs.writeFileSync(tmp, `${version}\n`, 'utf8');
    fs.renameSync(tmp, vFile);
  }

  // ⑦ 낡은 사본이었으면 여기서 한 번에 바꿔 끼운다(직전 것은 한 세대만 보관).
  if (stale && fs.existsSync(path.join(dest, 'IRIS-설치.cmd'))) {
    const prev = assertInside(root, `${finalDir}.prev`, { fs });
    try { fs.rmSync(prev, { recursive: true, force: true }); } catch { /* 없으면 그만 */ }
    fs.renameSync(finalDir, prev);
    fs.renameSync(dest, finalDir);
    result.replaced = true;
    log(`[handoff] 설치기 사본을 ${version} 판으로 바꿔 끼웠습니다(직전 판은 installer.prev 에 남김).`);
  }

  const entryFinal = path.join(finalDir, 'IRIS-설치.cmd');
  result.ok = fs.existsSync(entryFinal);
  if (!result.ok) {
    result.missing.push('IRIS-설치.cmd');
    log('[handoff] 설치기 사본에 IRIS-설치.cmd 가 없습니다 — 「설치 이어하기」가 동작하지 않습니다.');
  } else {
    log(`[handoff] 설치기 사본 준비 — 새로 ${result.copied}개·그대로 ${result.kept}개 (${RESUME_INSTALLER_PATH})`);
  }
  return result;
}

export default {
  writeHandoff, buildHandoff, refreshHandoffAfterOnline, copyInstallerProgram,
  handoffPath, firstMessageText, handoffState, setupSummary,
};
