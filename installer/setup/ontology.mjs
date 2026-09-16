// ⑤-8 목록 카드·그래프·뷰·신선도 (설계-v2 6-2, 계약 v2 8단계)
//
// 영혼 루트에서 동봉 python으로 다섯 명령을 순서대로 실행한다:
//   build_graph.py --init --write  → 각 R/D/P AGENTS.md 맨 위에 머리말(카드)을 쓰고
//                                     그 자리에서 그래프도 함께 컴파일한다.
//   build_graph.py --compile       → 트리를 다시 스캔해 graph.json 을 확정판으로 다시 쓴다.
//   validate.py                    → 읽기 전용 3층 검사(형식·정합·규칙) 리포트.
//   render_view.py                 → 그래프의 거울인 오프라인 HTML 뷰를 만든다.
//   check_fresh.py                 → 그래프 지문과 실제 폴더가 같은지 마지막으로 확인한다.
// (구 `_map-generator/build_map.py` 단계는 2026-09-10 퇴역해 이 순서에 없다 — 뷰가 대체.)
//
// 다섯 명령 중 넷(초안쓰기·컴파일·검증·뷰)은 실패해도 단계 자체를 멈추지 않는다 —
// 결과를 recorded 에 남길 뿐이다. 오직 마지막 check_fresh 만 그래프가 실제와
// 어긋났다는 뜻이라 StageError(E-ONTOLOGY) 로 막는다. validate.py 의 3층(규칙) 실패는
// "충돌표 초안 후보"일 뿐 자동 수정 대상이 아니므로 실패가 아니라 경고로 기록한다
// (예: 태그 종류 미분류 — 새 영혼은 아직 태그〖 〗를 쓰지 않으니 보통 0건).
import nodeFs from 'node:fs';
import path from 'node:path';
import { StageError } from '../lib/errors.mjs';
import { assertInside, ensureDir } from '../lib/paths.mjs';

export const id = 'ontology';

// R/D/P 폴더 이름의 느슨한 판별(정본 정규식은 IRIS-온톨로지.md 5-1 — 여기서는 카드
// id 보존 여부만 확인하면 되므로 엄격히 따를 필요가 없다. 도메인 그룹 접두
// 〖…〗D0X- 도 허용한다.
const RDP_NAME_RE = /^(?:〖[^〗]*〗)?[RDP]\d{2}(?:\.\d{2})?-/;
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.astro',
  '.vercel', '.wrangler', 'dist', 'build', 'out', '.cache',
  '_trash', '_agent', '_backup', '_cleanup', '_ontology', '_document-templates',
]);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
// build_graph.py 는 머리말을 한 줄 흐름식 매핑으로 쓴다:
// `{id: 'iris:XXXXXXXX', type: role, code: R01, …}`. 블록식(각 줄에 `id: 값`)도
// 함께 지원해 둔다(단위 시험 픽스처·손으로 만든 카드 대비). 따옴표는 있을 수도
// 없을 수도 있고, 값 뒤에 쉼표·닫는 중괄호·줄바꿈이 올 수 있다. `parentId:`
// 처럼 "id"로 끝나는 다른 키와 헷갈리지 않도록 앞에 단어 경계를 요구한다.
const ID_LINE_RE = /\bid:\s*['"]?([^'",}\s]+)['"]?/;

// python 실행 파일: IRIS_PYTHON 지정 → 동봉 shim → PATH 의 python.
export function resolvePython(ctx) {
  const fs = ctx?.fs ?? nodeFs;
  if (ctx?.env?.IRIS_PYTHON) return ctx.env.IRIS_PYTHON;
  const shim = path.join(ctx.root, '_agent', 'shared', 'shims', 'python.cmd');
  try {
    if (fs.existsSync(shim)) return shim;
  } catch { /* 접근 불가 — PATH 로 폴백 */ }
  return 'python';
}

// AGENTS.md 머리말(카드)의 id 값(없으면 null).
export function readCardId(fs, agentsPath) {
  try {
    if (!fs.existsSync(agentsPath)) return null;
    const text = fs.readFileSync(agentsPath, 'utf8');
    const m = FRONTMATTER_RE.exec(text);
    if (!m) return null;
    const idm = ID_LINE_RE.exec(m[1]);
    return idm ? idm[1] : null;
  } catch {
    return null;
  }
}

// R → D → P 3단만 훑어 그 AGENTS.md 경로를 모은다(카드가 실제로 붙는 자리만).
export function findCardPaths(fs, root) {
  const out = [];
  const listDirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !SKIP_DIR_NAMES.has(e.name) && RDP_NAME_RE.test(e.name));
    } catch {
      return [];
    }
  };
  for (const r of listDirs(root)) {
    const roleDir = path.join(root, r.name);
    out.push(path.join(roleDir, 'AGENTS.md'));
    for (const d of listDirs(roleDir)) {
      const domDir = path.join(roleDir, d.name);
      out.push(path.join(domDir, 'AGENTS.md'));
      for (const p of listDirs(domDir)) {
        out.push(path.join(domDir, p.name, 'AGENTS.md'));
      }
    }
  }
  return out;
}

function tailOf(out, err, maxLen = 400) {
  const combined = [out, err].filter(Boolean).join('\n').trim();
  if (!combined) return '';
  return combined.length > maxLen ? `…${combined.slice(-maxLen)}` : combined;
}

function relOf(root, p) {
  return path.relative(root, p).split(path.sep).join('\\');
}

// build_graph(초안쓰기·컴파일)·render_view: 종료코드만으로 통과/실패를 가른다.
function classifyByExit(res) {
  return res.code === 0 ? '통과' : '실패';
}

// validate.py 는 실패 건이 있어도 항상 0으로 끝난다(사람이 읽는 리포트일 뿐,
// 자동 수정이 없다) — 그래서 여기서는 종료코드가 아니라 표로 찍힌 요약을 읽는다.
// 표 한 줄 형식(고정폭): 번호·층·대상·통과·실패·판독불능·상태.
const VALIDATE_ROW_RE = /^(전제\S+|#\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/gm;

export function classifyValidate(res) {
  const rows = [];
  let m;
  VALIDATE_ROW_RE.lastIndex = 0;
  while ((m = VALIDATE_ROW_RE.exec(res.out))) {
    rows.push({
      no: m[1],
      layer: Number(m[2]),
      targets: Number(m[3]),
      passed: Number(m[4]),
      fails: Number(m[5]),
      unreadable: Number(m[6]),
      status: m[7].trim(),
    });
  }
  let failCount = 0;
  let warnCount = 0;
  let noTargetCount = 0;
  for (const r of rows) {
    if (r.targets === 0) { noTargetCount += 1; continue; }
    if (r.fails > 0) {
      // 3층(규칙)은 자동 수정 없는 "충돌표 초안 후보" — 실패가 아니라 경고.
      if (r.layer === 3) warnCount += 1; else failCount += 1;
    }
  }
  const reportM = /리포트\s*→\s*(.+)$/m.exec(res.out);
  let overall;
  if (res.code !== 0) overall = '실패';
  else if (failCount > 0) overall = '실패';
  else if (warnCount > 0) overall = '경고';
  else overall = rows.length ? '통과' : '미검사';
  return {
    overall, rows, failCount, warnCount, noTargetCount,
    reportPath: reportM ? reportM[1].trim() : null,
    exitCode: res.code,
  };
}

export async function run(ctx) {
  const fs = ctx?.fs ?? nodeFs;
  const root = ctx?.root;
  if (!root) {
    throw new StageError('E-ONTOLOGY', '설치 폴더 경로가 없어 온톨로지 단계를 실행할 수 없습니다.', { ctx: 'root' });
  }
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};
  const runExe = typeof ctx.run === 'function' ? ctx.run : null;
  if (!runExe) {
    throw new StageError('E-ONTOLOGY', '명령을 실행할 방법이 없습니다.', { ctx: 'run' });
  }

  const python = resolvePython(ctx);
  const ontDir = path.join(root, '_ontology');
  // render_view.py 의 `from view_data import build_data` 는 파이썬이 스크립트 자신의
  // 폴더를 sys.path[0] 에 자동으로 넣어 주는 동작에 기대므로 엄밀히는 없어도 되지만,
  // 작업지시서가 명시한 "PYTHONPATH 주입"을 따르기 위해 방어적으로 온톨로지 폴더를
  // 앞자리에 붙여 넣는다(기존 PYTHONPATH 가 있으면 그 뒤에 이어 붙인다).
  const baseEnv = ctx.env ?? process.env;
  const existingPyPath = baseEnv?.PYTHONPATH;
  const pythonPath = existingPyPath ? `${ontDir}${path.delimiter}${existingPyPath}` : ontDir;
  const env = { ...baseEnv, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: pythonPath };
  const timeoutMs = Number(ctx.timeoutMs) || 300000;

  // build_graph.py --init --write 가 미리보기 리포트를 _cleanup\리포트\ 밑에 쓰는데
  // 그 스크립트 자신은 이 폴더를 만들지 않는다(검증기와 달리 mkdir 이 없음) — 첫
  // 설치라면 없을 수 있으니 여기서 먼저 만들어 둔다(있으면 그대로 둠).
  try {
    ensureDir(assertInside(root, path.join(root, '_cleanup', '리포트'), { fs }), { fs });
  } catch (e) {
    log(`[ontology] _cleanup\\리포트 준비 중 문제(무시하고 계속): ${e?.message ?? e}`);
  }

  // 카드 보존 확인(S09) — 실행 전 id 를 적어 두고, 끝난 뒤 같은지 대조한다.
  const cardPaths = findCardPaths(fs, root);
  const beforeIds = new Map();
  for (const p of cardPaths) {
    const cid = readCardId(fs, p);
    if (cid) beforeIds.set(p, cid);
  }

  const recorded = { commands: [], counts: {}, viewPath: null, validate: null, preservedIds: null };

  async function step(label, script, args) {
    const scriptPath = path.join(ontDir, script);
    const cmdLine = [python, scriptPath, ...args].join(' ');
    log(`[ontology] ${label} 실행: ${cmdLine}`);
    const res = await runExe(python, [scriptPath, ...args], { cwd: root, env, timeoutMs });
    const tail = tailOf(res.out, res.err);
    log(`[ontology] ${label} → 종료코드 ${res.code}${tail ? `\n${tail}` : ''}`);
    const entry = { label, script, args: args.slice(), code: res.code, tail };
    recorded.commands.push(entry);
    return { ...res, entry };
  }

  // 1) 머리말 초안 쓰기 + 곧바로 그래프 1차 컴파일(스크립트 자체 동작).
  const initRes = await step('머리말 초안·쓰기', 'build_graph.py', ['--init', '--write']);
  const writtenM = /머리말 씀 (\d+)/.exec(initRes.out);
  recorded.counts.cardsWritten = writtenM ? Number(writtenM[1]) : null;
  initRes.entry.classification = classifyByExit(initRes);

  // 2) 그래프 확정 컴파일 — 트리를 다시 스캔해 graph.json 을 최신으로.
  const compileRes = await step('그래프 컴파일', 'build_graph.py', ['--compile']);
  const countM = /노드\s*(\d+)\s*·\s*간선\s*(\d+)/.exec(compileRes.out);
  recorded.counts.graphNodes = countM ? Number(countM[1]) : null;
  recorded.counts.graphEdges = countM ? Number(countM[2]) : null;
  compileRes.entry.classification = classifyByExit(compileRes);

  // 3) 검증(읽기 전용, 실패해도 파일을 고치지 않음) — 실패/경고/미검사로 나눈다.
  const validateRes = await step('검증', 'validate.py', []);
  const validateSummary = classifyValidate(validateRes);
  recorded.validate = validateSummary;
  validateRes.entry.classification = validateSummary.overall;

  // 4) 뷰 렌더 — 손 편집 금지, 그래프의 거울 HTML.
  const renderRes = await step('뷰 렌더', 'render_view.py', []);
  renderRes.entry.classification = classifyByExit(renderRes);
  recorded.viewPath = path.join(root, 'IRIS-온톨로지-뷰.html');

  // 5) 신선도 확인 — 여기만 유일한 관문. 통과 못 하면 단계 실패.
  const freshRes = await step('신선도 확인', 'check_fresh.py', []);
  freshRes.entry.classification = freshRes.code === 0 ? '통과' : '실패';

  // 카드 보존 대조.
  let checked = 0;
  let preserved = 0;
  const mismatches = [];
  for (const [p, before] of beforeIds) {
    checked += 1;
    const after = readCardId(fs, p);
    if (after === before) preserved += 1;
    else mismatches.push({ path: relOf(root, p), before, after });
  }
  recorded.preservedIds = { checked, preserved, mismatches };

  log(`[ontology] 요약 — 카드 ${recorded.counts.cardsWritten ?? '?'}개 씀`
    + ` · 그래프 노드 ${recorded.counts.graphNodes ?? '?'}개`
    + ` · 검증 ${validateSummary.overall}(실패 ${validateSummary.failCount}·경고 ${validateSummary.warnCount}·미검사 ${validateSummary.noTargetCount})`
    + ` · 기존 ID 보존 ${preserved}/${checked}`
    + ` · 신선도 ${freshRes.entry.classification}`);

  if (freshRes.code !== 0) {
    throw new StageError(
      'E-ONTOLOGY',
      '온톨로지 그래프가 최신이 아닙니다(신선도 확인 실패) — 그래프 재컴파일이 필요합니다.',
      { code: freshRes.code, out: freshRes.out, err: freshRes.err, commands: recorded.commands },
    );
  }

  return { recorded, pending: [] };
}
