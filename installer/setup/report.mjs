// ⑦ 완료 보고 · 진단 파일 (설계-v2 8절)
//
// 두 파일을 만든다. 읽는 사람이 다르다.
//
//   설치보고-YYYY-MM-DD.md  — **사람**이 읽는다. 5순서 고정:
//        하려던 일 / 기존 자료의 안전 / 결과 / 남은 일의 뜻 / 사용자가 할 일
//        완료 화면도 같은 내용을 보여 준다(같은 글을 두 번 쓰지 않는다).
//   diagnostics.json        — **고장 났을 때** 사람이 손으로 보내 주는 파일.
//        환경 지문·단계 결과·실패 코드. 텔레메트리는 없다(D2-23).
//
// 진단 파일의 철칙: **사용자 이름을 남기지 않는다.** 경로에 섞여 들어오는
// 윈도 사용자 프로필 경로(`…:\Users\<계정 이름>\…`)는 계정 이름 자리를 `<user>`
// 로, 영혼 루트 이름은 `<root>` 로 바꾼 뒤에 적는다(maskText). 통째로 남에게 건네는 물건이니,
// "개인정보를 안 넣는다"가 아니라 "넣을 수 없게 만든다"가 맞다.
import nodeFs from 'node:fs';
import path from 'node:path';
import { assertInside, ensureDir } from '../lib/paths.mjs';
import { SETUP_STAGE_IDS as STAGES } from '../lib/receipt.mjs';

export function setupDir(root) { return path.join(root, '_agent', 'setup'); }

export function todayStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function reportPath(root, now = new Date()) {
  return path.join(setupDir(root), `설치보고-${todayStamp(now)}.md`);
}

export function diagnosticsPath(root) {
  return path.join(setupDir(root), 'diagnostics.json');
}

export const STAGE_LABELS = Object.freeze({
  unpack: '부품 풀기',
  env: '심·환경변수',
  skeleton: '영혼 뼈대',
  structure: '작업 폴더',
  venv: '파이썬 환경',
  adapters: '에이전트 연결부',
  relay: '중계기 준비',
  ontology: '온톨로지',
  checks: '마무리 검사',
});

// ---------------------------------------------------------------------------
// 진행 막대 (전역 지침 「진행상황 표시 원칙」: 칸 20개, 내림 퍼센트)
// ---------------------------------------------------------------------------
export function progressBar(done, total = STAGES.length, cells = 20) {
  const safeTotal = Math.max(1, Number(total) || 1);
  const ratio = Math.min(1, Math.max(0, Number(done) / safeTotal));
  const filled = Math.floor(ratio * cells);
  const percent = Math.floor(ratio * 100);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`;
  return { bar, percent, line: `[${bar}] ${String(percent).padStart(3)}%  (${done}/${safeTotal})` };
}

// ---------------------------------------------------------------------------
// 가리기 (masking)
// ---------------------------------------------------------------------------

// 정규식에 그대로 넣어도 안전하게.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * maskText(text, { root }) — 진단 파일에 들어갈 모든 글자를 지나가는 체.
 *   ① `…:\Users\<계정 이름>` → 그 자리를 `<user>` 로 (슬래시 방향 둘 다)
 *   ② 영혼 루트 폴더 이름(진짜 `IRIS` 든 연습용 이름이든) → `<root>`
 *   ③ 루트의 부모까지 포함한 절대경로 → `<root>` 로 시작하는 상대 표기
 * 순서가 중요하다: 루트를 먼저 접어야 사용자 폴더 **아래** 있는 영혼 경로에서
 * 계정 이름이 남지 않는다.
 */
export function maskText(text, { root = null } = {}) {
  let out = String(text ?? '');
  if (root) {
    // ① 루트 절대경로 통째로(슬래시 방향 무관)
    const both = escapeRe(root).replace(/\\\\/g, '[\\\\/]+');
    out = out.replace(new RegExp(both, 'gi'), '<root>');
    // ② 루트 폴더 이름이 **경로 조각으로** 나올 때만. 산문 속의 같은 낱말
    //    ("IRIS 창을 여세요")까지 바꾸면 진단 파일을 읽을 수 없게 된다.
    const name = path.basename(root);
    if (name && name.length > 1) {
      out = out.replace(new RegExp(`(^|[\\\\/"'\\s(])${escapeRe(name)}(?=[\\\\/])`, 'g'), '$1<root>');
    }
  }
  // 드라이브 문자 + Users + 계정 이름 (역슬래시·슬래시 둘 다)
  out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)([^\\/"'<>|:*?\r\n]+)/gi, (whole, head, who) => (
    /^(public|default|all users|<user>)$/i.test(who) ? whole : `${head}<user>`
  ));
  return out;
}

// 객체 안의 모든 문자열(키 포함)에 체를 적용한다.
export function maskDeep(value, opts) {
  if (typeof value === 'string') return maskText(value, opts);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, opts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[maskText(k, opts)] = maskDeep(v, opts);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 설치보고 md
// ---------------------------------------------------------------------------

function bullet(lines) {
  return lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- (없음)';
}

function checksTable(items = []) {
  if (!items.length) return '';
  const mark = { pass: '통과', pending: '대기', fail: '실패' };
  const rows = items.map((c) => `| ${c.num ?? ''} | ${c.label} | ${mark[c.status] ?? c.status} | ${String(c.detail ?? '').replace(/\|/g, '/')} |`);
  return ['', '| # | 검사 | 결과 | 설명 |', '|---|---|---|---|', ...rows, ''].join('\n');
}

/**
 * buildReport(ctx, opts) → 보고서 본문(문자열).
 *
 * 5순서는 설계-v2 8절이 정한 것이고, 바꾸지 않는다. 사람이 읽는 순서가 곧
 * 안심하는 순서이기 때문이다 — 무엇을 하려 했나 → **내 자료는 그대로인가** →
 * 무엇이 됐나 → 안 된 것은 무슨 뜻인가 → 이제 내가 할 일.
 */
export function buildReport(ctx, {
  checks = { pass: 0, pending: 0, fail: 0 },
  checkItems = [],
  pending = [],
  stages = {},
  failed = null,
  handoff = null,
  now = new Date(),
} = {}) {
  const receipt = ctx.receipt ?? {};
  const subscriptions = Array.isArray(ctx?.choice?.subscriptions) ? ctx.choice.subscriptions : [];
  const structure = receipt?.setup?.structure?.recorded ?? {};
  const folders = [...(structure.created ?? []), ...(structure.skipped ?? [])];
  const kept = (structure.skipped ?? []).length;

  // 이번 실행이 알려 준 상태가 우선이고(엔진의 `stages`), 없는 단계만 영수증을
  // 본다 — 재개 실행에서는 "이번엔 안 돌았지만 지난번에 끝난" 단계가 있다.
  const statusOf = (id) => (
    Object.prototype.hasOwnProperty.call(stages, id)
      ? (stages[id]?.status ?? 'pending')
      : (receipt?.setup?.[id]?.status ?? 'pending')
  );
  const doneCount = STAGES.filter((id) => ['done', 'skipped-done'].includes(statusOf(id))).length;
  const bar = progressBar(failed ? doneCount : STAGES.length);

  const stageLines = STAGES.map((id) => {
    const st = statusOf(id);
    const word = st === 'done' || st === 'skipped-done' ? '완료' : (st === 'failed' ? '막힘' : '대기');
    const label = (STAGE_LABELS[id] ?? id).padEnd(9, ' ');
    return `${label} ${word}`;
  });

  const subsWord = subscriptions.length
    ? subscriptions.map((s) => (s === 'claude' ? '클로드' : (s === 'chatgpt' ? 'ChatGPT' : s))).join('·')
    : '(고르지 않음)';

  const pendingLines = (pending ?? []).map((p) => {
    const how = p.howToEnable ? ` 켜는 법: ${p.howToEnable}` : '';
    return `**${p.capability}** — ${p.reason}${how}`;
  });

  const todo = [];
  if (failed) {
    todo.push(`설치가 **${STAGE_LABELS[failed.id] ?? failed.id}** 단계에서 멈췄습니다(코드 \`${failed.code}\`). 설치기 화면의 「다시 시도」를 눌러 주세요 — 이미 끝난 단계는 건너뛰고 멈춘 곳부터 다시 합니다.`);
  }
  const loginLeft = subscriptions.filter((s) => handoff?.login?.[s] !== 'done');
  if (loginLeft.length) {
    todo.push(`구독 로그인이 남았습니다(${loginLeft.map((s) => (s === 'claude' ? '클로드' : 'ChatGPT')).join('·')}). 설치기 화면이 열어 주는 창에서 한 번만 로그인하면 끝입니다 — 사람만 할 수 있는 유일한 단계입니다.`);
  }
  if ((handoff?.nameEnMissing ?? []).length) {
    todo.push(`영어 이름이 비어 있는 폴더가 ${handoff.nameEnMissing.length}개 있습니다. IRIS 창이 열리면 채우기를 먼저 제안할 것입니다(그대로 두어도 괜찮습니다).`);
  }
  if (!todo.length) {
    todo.push('없습니다. 바탕화면의 「IRIS」를 두 번 눌러 시작하세요.');
  }

  const lines = [
    `# IRIS 설치 보고 (${todayStamp(now)})`,
    '',
    '```text',
    `설치 진행  ${bar.line}`,
    '```',
    '',
    '## 1. 하려던 일',
    '',
    `이 PC 에 IRIS 체계 전체를 설치하고, 실행기·에이전트·중계기·IRIS 창·도구·작업 폴더·지침을 **인터넷 없이** 세팅하려 했습니다. 고른 구독은 ${subsWord}입니다.`,
    '',
    '## 2. 기존 자료의 안전',
    '',
    '- 설치기는 **아무것도 지우거나 덮어쓰지 않습니다.** 이미 있던 파일은 그대로 두고, 없는 것만 새로 만듭니다.',
    `- 이미 있어서 그대로 둔 작업 폴더: ${kept}개`,
    '- 설정 파일(클로드·코덱스)은 **없는 칸만** 채웠습니다. 직접 넣어 둔 설정·MCP·훅은 한 글자도 바뀌지 않았습니다.',
    '',
    '## 3. 결과',
    '',
    '```text',
    ...stageLines,
    '```',
    '',
    `- 만든(또는 확인한) 작업 폴더 ${folders.length}개`,
    `- 마무리 검사: 통과 ${checks.pass}개 · 대기 ${checks.pending}개 · 실패 ${checks.fail}개`,
    checksTable(checkItems),
    '## 4. 남은 일의 뜻',
    '',
    pendingLines.length
      ? '아래 기능은 **이 PC 에 아직 없는 프로그램** 때문에 잠시 쉬고 있습니다. 설치가 잘못된 것이 아니라, 그 프로그램을 깔면 그때부터 저절로 켜집니다.'
      : '쉬고 있는 기능은 없습니다. 동봉된 기능이 전부 켜졌습니다.',
    '',
    bullet(pendingLines),
    '',
    '## 5. 사용자가 할 일',
    '',
    bullet(todo),
    '',
  ];
  return lines.join('\n');
}

export function writeReport(ctx, opts = {}) {
  const fs = opts.fs ?? ctx?.fs ?? nodeFs;
  const root = ctx.root;
  const now = opts.now ?? new Date();
  const file = assertInside(root, reportPath(root, now), { fs });
  ensureDir(path.dirname(file), { fs });
  const text = buildReport(ctx, { ...opts, now });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  return { path: file, text };
}

// ---------------------------------------------------------------------------
// diagnostics.json
// ---------------------------------------------------------------------------

/**
 * buildDiagnostics(ctx, opts) — 손으로 건네는 진단 파일.
 *
 * 환경 지문은 준비 검사(`precheck.recorded`)에서 그대로 온다 — 다시 재지 않는다
 * (같은 것을 두 번 재면 두 값이 달라졌을 때 어느 쪽이 맞는지 알 수 없다).
 */
export function buildDiagnostics(ctx, {
  checks = { pass: 0, pending: 0, fail: 0 },
  checkItems = [],
  pending = [],
  stages = {},
  failed = null,
  now = new Date(),
} = {}) {
  const root = ctx.root;
  const receipt = ctx.receipt ?? {};
  const pre = ctx?.precheck?.recorded ?? ctx?.precheck ?? {};

  const stageResults = {};
  for (const id of STAGES) {
    const fromReceipt = receipt?.setup?.[id] ?? {};
    const fromRun = stages[id] ?? {};
    stageResults[id] = {
      status: fromRun.status ?? fromReceipt.status ?? 'pending',
      code: fromRun.code ?? fromReceipt.code ?? null,
      message: fromRun.message ?? fromReceipt.message ?? null,
      startedAt: fromReceipt.startedAt ?? null,
      finishedAt: fromReceipt.finishedAt ?? null,
    };
  }

  const raw = {
    schema: 1,
    writtenAt: now.toISOString(),
    packageVersion: ctx?.manifest?.package?.version ?? receipt?.package?.version ?? null,
    environment: {
      os: pre.os ?? null,
      arch: pre.arch ?? null,
      disk: pre.disk ?? null,
      ntfs: pre.ntfs ?? null,
      powershell: pre.powershell ?? null,
      edge: pre.edge ?? null,
      sac: pre.sac ?? null,
      ports: pre.ports ?? null,
      node: process.version,
      offline: ctx.offline !== false,
    },
    stages: stageResults,
    failed: failed ?? null,
    checks: {
      summary: { pass: Number(checks.pass ?? 0), pending: Number(checks.pending ?? 0), fail: Number(checks.fail ?? 0) },
      items: checkItems.map((c) => ({ id: c.id, num: c.num ?? null, label: c.label, status: c.status, detail: c.detail ?? null })),
    },
    pendingCapabilities: pending ?? [],
  };

  // 마지막 관문 — 여기를 지나지 않은 값은 파일에 들어가지 않는다.
  return maskDeep(raw, { root });
}

export function writeDiagnostics(ctx, opts = {}) {
  const fs = opts.fs ?? ctx?.fs ?? nodeFs;
  const root = ctx.root;
  const file = assertInside(root, diagnosticsPath(root), { fs });
  ensureDir(path.dirname(file), { fs });
  const data = buildDiagnostics(ctx, opts);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  return { path: file, diagnostics: data };
}

export default { writeReport, writeDiagnostics, buildReport, buildDiagnostics, progressBar, maskText };
