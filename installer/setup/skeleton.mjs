// ⑤-3 영혼 뼈대 (설계-v2 6-2, 계약 v2 3단계)
//
// soul-state.json · 루트 AGENTS.md/CLAUDE.md · _agent/_ontology/_trash/
// _cleanup/_document-templates · 각 `_`폴더 미니 지침 · _cosmos.ico+desktop.ini.
//
// 이 단계의 유일한 규칙: **이미 있는 것은 절대 건드리지 않는다.** 1.x 영혼 위에
// 다시 깔아도, 같은 설치를 두 번 돌려도 기존 파일은 그대로다(S09). 그래서 모든
// 쓰기는 copyIfAbsent/writeIfAbsent를 지나고, 만들지 못한 것은 오류 대신
// recorded에 남겨 ⑤-9 검사와 설치보고가 사람에게 보여 준다.
import nodeFs from 'node:fs';
import path from 'node:path';
import { StageError } from '../lib/errors.mjs';
import {
  assertInside, ensureDir, copyIfAbsent, copyTreeIfAbsent, writeIfAbsent, fillTemplate,
} from '../lib/paths.mjs';
import {
  partPath, partDir, partBasename, partVersion, policyPath,
} from '../lib/payload.mjs';
import { writeMinimalSoulState, soulStatePath } from '../lib/soulstate.mjs';

export const id = 'skeleton';

// `_`폴더 = 위계(R/D/P) 폴더가 아닌 재사용 도구·자료 폴더. 미니 지침의 한 줄
// 정체성은 왕초보가 "이 폴더가 왜 있는지"를 한 번에 알 수 있게 쓴다.
export const UTIL_FOLDERS = [
  { name: '_agent', identity: '에이전트 살림 폴더 — 클로드·코덱스 설정, 함께 쓰는 도구, 설치 기록이 사는 곳이다.' },
  { name: '_ontology', identity: '온톨로지 도구 폴더 — 폴더 구조를 그래프로 만들고 검사하는 파이썬 도구가 산다.' },
  { name: '_trash', identity: '버리는 곳 — 지우는 대신 날짜 폴더로 옮겨 두는 임시 보관소다.' },
  { name: '_cleanup', identity: '정리 도구 폴더 — 폴더 정리 절차의 도구·리포트·정리대장이 쌓인다.' },
  { name: '_document-templates', identity: '문서 기본양식 폴더 — HWPX 기본양식과 쪽 배치 검사 도구가 산다.' },
];

const AGENT_SUBDIRS = ['claude', 'codex', 'shared', 'setup'];

// ---------------------------------------------------------------------------

export async function run(ctx) {
  const fs = ctx?.fs ?? nodeFs;
  const root = ctx?.root;
  if (!root) throw new StageError('E-SKELETON', '설치 폴더 경로가 없어 뼈대를 만들 수 없습니다.', { ctx: 'root' });
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};

  const recorded = {
    soulState: null,
    rootAgentsKept: false,
    files: { created: [], kept: [] },
    dirs: { created: [], kept: [] },
    miniGuides: { created: [], kept: [] },
    ontology: {},
    documentTemplates: null,
    icon: {},
    missing: [],
    blocked: [],
  };

  const rel = (p) => path.relative(root, p).split(path.sep).join('\\') || '.';
  const linkCache = new Map(); // 정션 검사 결과(폴더별 1회)
  const at = (...segs) => assertInside(root, path.join(root, ...segs), { fs, cache: linkCache });

  // 정션·심볼릭 링크로 영혼 밖을 가리키는 자리는 뚫고 쓰지 않는다. 설치를
  // 통째로 멈추는 대신 그 항목만 blocked 에 남기고 나머지를 계속 만든다
  // (설계-v2 6-4 무삭제 · ⑤-9 검사가 blocked 를 보고 사람에게 알린다).
  const safe = (label, fn) => {
    try {
      return fn();
    } catch (e) {
      if (e?.code !== 'E-OUTSIDE-ROOT') throw e;
      recorded.blocked.push({ what: label, path: e.detail?.path ? rel(e.detail.path) : null, message: e.message });
      log(`[skeleton] ${label}: ${e.message}`);
      return null;
    }
  };

  const mkdir = (...segs) => safe(segs.join('\\'), () => {
    const dir = at(...segs);
    const r = ensureDir(dir, { fs });
    (r.created ? recorded.dirs.created : recorded.dirs.kept).push(rel(dir));
    return dir;
  });

  // src === null (부품 없음) 이면 missing 에 남기고 계속 간다: 꾸러미가 덜
  // 갖춰졌다고 이미 만든 것을 되돌리지는 않는다(설계-v2 6-4).
  const BLOCKED = { written: false, kept: false, missingSource: false, blocked: true };

  const place = (src, dstSegs, label) => safe(label ?? dstSegs.join('\\'), () => {
    const dst = at(...dstSegs);
    const r = copyIfAbsent(src, dst, { fs });
    if (r.missingSource) {
      recorded.missing.push({ what: label ?? rel(dst), from: src ? rel(src) : null });
      log(`[skeleton] 꾸러미에 ${label ?? rel(dst)} 이(가) 없어 건너뜀`);
      return r;
    }
    (r.written ? recorded.files.created : recorded.files.kept).push(rel(dst));
    return r;
  }) ?? BLOCKED;

  const put = (content, dstSegs, opts) => safe(dstSegs.join('\\'), () => {
    const dst = at(...dstSegs);
    const r = writeIfAbsent(dst, content, { fs, ...opts });
    (r.written ? recorded.files.created : recorded.files.kept).push(rel(dst));
    return r;
  }) ?? BLOCKED;

  ensureDir(root, { fs });

  // ── 1. soul-state.json ────────────────────────────────────────────────
  // 이미 있으면 그대로 둔다: 1.x 영혼의 표지는 그 사람의 자료다(S09).
  recorded.soulState = writeSoulState(ctx, { fs, root });

  // ── 2. 루트 지침 ──────────────────────────────────────────────────────
  recorded.rootAgentsKept = safe('AGENTS.md', () => fs.existsSync(at('AGENTS.md'))) === true;
  place(policyPath(ctx, 'root-AGENTS.md', { fs }), ['AGENTS.md'], '루트 AGENTS.md');
  place(policyPath(ctx, 'CLAUDE.md', { fs }), ['CLAUDE.md'], '루트 CLAUDE.md');
  // 2.0.35: 첫 세션 폴더 구조 인터뷰 대본. 꾸러미 소유 문서라(사용자가 고칠 것이 아님) 내용이 다르면 새로 쓴다 —
  // "두 번째 실행은 아무것도 바꾸지 않는다"(검사 8)는 바이트 비교로 지킨다. 사용자 자료가 아니므로 무삭제 원칙과 충돌하지 않는다.
  safe('_agent\\setup\\interview.md', () => {
    const src = policyPath(ctx, 'interview.md', { fs });
    const dst = at('_agent', 'setup', 'interview.md');
    const body = readText(fs, src);
    if (body == null) { recorded.missing.push({ what: '_agent\\setup\\interview.md', from: src ? rel(src) : null }); log('[skeleton] 꾸러미에 interview.md 가 없어 건너뜀'); return; }
    ensureDir(path.dirname(dst), { fs });
    let cur = null; try { cur = fs.readFileSync(dst, 'utf8'); } catch { cur = null; }
    if (cur === body) { recorded.files.kept.push(rel(dst)); return; }
    fs.writeFileSync(dst, body, 'utf8');
    recorded.files.created.push(rel(dst));
  });

  // ── 3. 폴더 ───────────────────────────────────────────────────────────
  mkdir('_agent');
  for (const sub of AGENT_SUBDIRS) mkdir('_agent', sub);
  for (const f of UTIL_FOLDERS) if (f.name !== '_agent') mkdir(f.name);

  // ── 4. _ontology 내용물 ───────────────────────────────────────────────
  recorded.ontology = fillOntology(ctx, { fs, root, at, rel, place, put, recorded, log, safe, linkCache });

  // ── 5. _document-templates ────────────────────────────────────────────
  // T13 unpack 이 tools\hwpx-templates.zip 을 풀 수도 있다. 폴더 모양으로
  // 들어 있을 때만 여기서 채우고, 이미 있는 파일은 건드리지 않는다.
  recorded.documentTemplates = fillDocumentTemplates(ctx, { fs, root, at, safe, linkCache })
    ?? { status: 'blocked', reason: 'reparse-point' };

  // ── 6. `_`폴더 미니 지침 ──────────────────────────────────────────────
  const utilTemplate = readText(fs, policyPath(ctx, 'mini-AGENTS-util.md', { fs }));
  const claudeShim = readText(fs, policyPath(ctx, 'CLAUDE.md', { fs })) ?? '@AGENTS.md\n';
  if (utilTemplate == null) {
    recorded.missing.push({ what: 'mini-AGENTS-util.md', from: null });
    log('[skeleton] 꾸러미에 mini-AGENTS-util.md 이(가) 없어 `_`폴더 미니 지침을 건너뜀');
  } else {
    for (const f of UTIL_FOLDERS) {
      const body = fillTemplate(utilTemplate, { folderName: f.name, identity: f.identity });
      for (const [file, content] of [['AGENTS.md', body], ['CLAUDE.md', claudeShim]]) {
        safe(`${f.name}\\${file}`, () => {
          const dst = at(f.name, file);
          const r = writeIfAbsent(dst, content, { fs });
          (r.written ? recorded.miniGuides.created : recorded.miniGuides.kept).push(rel(dst));
        });
      }
    }
  }

  // ── 7. 폴더 아이콘 ────────────────────────────────────────────────────
  recorded.icon = await applyFolderIcon(ctx, { fs, root, at, place, log, safe })
    ?? { ico: 'blocked', desktopIni: 'blocked', attributes: 'skipped' };

  log(`[skeleton] 폴더 ${recorded.dirs.created.length}개·파일 ${recorded.files.created.length}개 새로 만듦`
    + `(기존 유지 ${recorded.dirs.kept.length + recorded.files.kept.length}개`
    + `${recorded.blocked.length ? `, 연결(정션)이라 보류 ${recorded.blocked.length}개` : ''})`);

  return { recorded, pending: [] };
}

// ---------------------------------------------------------------------------
// soul-state.json
// ---------------------------------------------------------------------------

// v1 의 writeMinimalSoulState 를 그대로 쓰되 v2 표지로 손본다:
//   · packageInstall: true          (그대로)
//   · packageVersion: <꾸러미 판>    (추가 -- 어느 판이 깔았는지)
//   · schemaVersion: 7              (그대로 -- 옛 도구가 알아보게)
//   · guideVersion 계열 필드 없음    (v2 는 세팅가이드를 쓰지 않는다)
function writeSoulState(ctx, { fs, root }) {
  const dest = soulStatePath(root);
  if (fs.existsSync(dest)) return { status: 'kept', path: dest };

  const edition = ctx?.choice?.leadAgent === 'codex' ? 'codex' : 'claude';
  const r = writeMinimalSoulState(root, { edition, name: path.basename(root) });
  if (!r.written) return { status: 'kept', path: dest };

  const state = JSON.parse(fs.readFileSync(dest, 'utf8'));
  delete state.guideVersion;
  if (state.sourceGuide) delete state.sourceGuide.version; // = 옛 guideVersion
  state.packageInstall = true;
  state.schemaVersion = 7;
  state.packageVersion = ctx?.manifest?.package?.version ?? ctx?.lock?.package?.version ?? null;

  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, dest);
  return { status: 'created', path: dest, packageVersion: state.packageVersion };
}

// ---------------------------------------------------------------------------
// _ontology
// ---------------------------------------------------------------------------

function fillOntology(ctx, { fs, root, at, rel, place, put, recorded, log, safe, linkCache }) {
  const out = { pythonFiles: [], registry: null, requirements: null, spec: null };

  // 파이썬·뷰 파일: 부품이 폴더 모양일 때만. zip 이면 ⑤-1 unpack 몫이다.
  const dir = partDir(ctx, 'ontology', { fs });
  if (dir) {
    const r = safe('_ontology', () => copyTreeIfAbsent(dir, at('_ontology'), { fs, root, cache: linkCache }));
    if (!r) {
      out.pythonFiles = [];
      out.pythonSource = 'blocked';
    } else {
      out.pythonFiles = r.written;
      out.pythonKept = r.kept.length;
      for (const f of r.written) recorded.files.created.push(`_ontology\\${f}`);
    }
  } else {
    out.pythonFiles = [];
    out.pythonSource = partPath(ctx, 'ontology') ? 'archive-or-missing' : 'missing';
    log('[skeleton] _ontology 파이썬 파일은 꾸러미에 폴더로 들어 있지 않아 건너뜀(풀기 단계 몫)');
  }

  // registry.yml: 빈 템플릿. 있으면 그대로 둔다(그 사람의 등록부다).
  const hadRegistry = safe('_ontology\\registry.yml', () => fs.existsSync(at('_ontology', 'registry.yml'))) === true;
  const rr = place(policyPath(ctx, 'ontology-registry-template.yml', { fs }), ['_ontology', 'registry.yml'], 'registry.yml 템플릿');
  out.registry = rr.blocked ? 'blocked' : (hadRegistry ? 'kept' : (rr.written ? 'created' : 'missing'));

  // requirements.txt: 온톨로지 파이썬이 쓰는 유일한 외부 묶음. 판은 잠금표에서.
  const pyyaml = partVersion(ctx, 'pyyaml');
  if (pyyaml) {
    const r = put(`PyYAML==${pyyaml}\n`, ['_ontology', 'requirements.txt']);
    out.requirements = r.written ? `PyYAML==${pyyaml}` : 'kept';
  } else {
    out.requirements = 'missing-version';
    recorded.missing.push({ what: '_ontology\\requirements.txt (pyyaml 판 모름)', from: null });
  }

  // 온톨로지 명세서: 루트에 잠금표가 정한 원래 이름 그대로.
  const specSrc = partPath(ctx, 'ontology-spec');
  const specName = partBasename(ctx, 'ontology-spec');
  if (specSrc && specName) {
    const hadSpec = safe(specName, () => fs.existsSync(at(specName))) === true;
    const r = place(specSrc, [specName], `온톨로지 명세서(${specName})`);
    out.spec = r.blocked ? 'blocked' : (hadSpec ? 'kept' : (r.written ? specName : 'missing'));
  } else {
    out.spec = 'missing';
    recorded.missing.push({ what: '온톨로지 명세서', from: null });
  }

  return out;
}

// ---------------------------------------------------------------------------
// _document-templates
// ---------------------------------------------------------------------------

function fillDocumentTemplates(ctx, { fs, root, at, safe, linkCache }) {
  const dir = partDir(ctx, 'hwpx-templates', { fs });
  if (!dir) return { status: 'skipped', reason: 'archive-or-missing' };
  return safe('_document-templates', () => {
    const r = copyTreeIfAbsent(dir, at('_document-templates'), { fs, root, cache: linkCache });
    return { status: r.written.length ? 'copied' : 'kept', written: r.written.length, kept: r.kept.length };
  });
}

// ---------------------------------------------------------------------------
// 폴더 아이콘
// ---------------------------------------------------------------------------

// desktop.ini 는 탐색기가 UTF-16LE(BOM)·CRLF 로 읽는 파일이다. 이 PC 의 실제
// 파일과 같은 바이트 모양으로 쓰고, 속성은 새로 만들었을 때만 건다 -- 두 번째
// 실행에서 attrib 을 다시 돌리지 않아야 "변경 0"이 된다.
export function desktopIniBytes(root) {
  const text = `[.ShellClassInfo]\r\nIconResource=${path.join(root, '_cosmos.ico')},0\r\n`;
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

async function applyFolderIcon(ctx, { fs, root, at, place, log, safe }) {
  const out = { ico: null, desktopIni: null, attributes: 'skipped' };

  const icoDst = safe('_cosmos.ico', () => at('_cosmos.ico'));
  const iniDst = safe('desktop.ini', () => at('desktop.ini'));
  if (!icoDst || !iniDst) return null; // 루트가 링크로 새고 있다 -- 아무것도 쓰지 않는다

  const hadIco = fs.existsSync(icoDst);
  const icoSrc = partPath(ctx, 'folder-icon') ?? policyPath(ctx, '_cosmos.ico', { fs });
  const r = place(icoSrc, ['_cosmos.ico'], '폴더 아이콘(_cosmos.ico)');
  out.ico = hadIco ? 'kept' : (r.written ? 'created' : 'missing');

  const hadIni = fs.existsSync(iniDst);
  const ini = writeIfAbsent(iniDst, desktopIniBytes(root), { fs });
  out.desktopIni = hadIni ? 'kept' : 'created';

  // 아이콘 파일이 없으면 속성을 걸어 봐야 소용없다.
  const freshlyMade = (!hadIni && ini.written) || (!hadIco && r.written);
  if (!freshlyMade) { out.attributes = 'already'; return out; }
  if (typeof ctx.run !== 'function') { out.attributes = 'skipped-no-run'; return out; }

  const calls = [
    ['+s', '+h', iniDst],   // 숨김·시스템: 탐색기가 desktop.ini 를 읽는 조건
    ['+h', icoDst],         // 아이콘 파일은 숨김만
    ['+r', root],           // 폴더 읽기전용: 사용자 지정 아이콘이 붙는 조건
  ];
  const failed = [];
  for (const args of calls) {
    try {
      const res = await ctx.run('attrib', args, { cwd: root, env: ctx.env });
      if (res && res.code !== 0) failed.push({ args, code: res.code, err: res.err });
    } catch (e) {
      failed.push({ args, error: String(e?.message ?? e) });
    }
  }
  if (failed.length) {
    out.attributes = 'failed';
    out.attributeErrors = failed;
    log(`[skeleton] 폴더 아이콘 속성 설정 실패 ${failed.length}건(아이콘만 안 보일 뿐 설치는 계속)`);
  } else {
    out.attributes = 'set';
  }
  return out;
}

// ---------------------------------------------------------------------------

function readText(fs, p) {
  try {
    if (!p || !fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
