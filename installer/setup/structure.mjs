// ⑤-4 작업 폴더 (설계-v2 6-2, 계약 v2 4단계)
//
// decisions.json 의 R/D/P 를 실제 폴더로 만들고, 각 폴더에 한 줄짜리
// AGENTS.md·CLAUDE.md 를 둔다. 온톨로지 카드(머리말)는 여기서 붙이지 않는다 --
// ⑤-8 의 build_graph --init --write 몫이다.
//
// 사용자 자료 보호가 최우선이다:
//   · 같은 이름 폴더가 이미 있으면 → 그 폴더를 그대로 쓰고 skipped 에
//   · 이름은 다른데 같은 코드(R01-…)가 이미 있으면 → **만들지 않고** conflicts 에
//     (그 사람이 이미 R01 을 다른 뜻으로 쓰고 있다는 뜻이다. 오류는 아니다.)
//   · 그 폴더가 다른 곳을 가리키는 정션·링크면 → **뚫고 쓰지 않고** conflicts 에
//     (reason:'reparse-point'. 영혼 밖에 파일을 떨구는 유일한 샛길이었다.)
import nodeFs from 'node:fs';
import path from 'node:path';
import { StageError } from '../lib/errors.mjs';
import { assertInside, ensureDir, writeIfAbsent, fillTemplate } from '../lib/paths.mjs';
import { policyPath } from '../lib/payload.mjs';

export const id = 'structure';

// "나중에 정하기"를 고른 사람도 빈 영혼으로 시작하지는 않는다. 서버가 이미
// 넣어 주지만, 결정 파일이 비어 온 경우를 대비해 같은 기본값을 여기서도 둔다.
export const DEFAULT_NODE = Object.freeze({
  id: 'r-default', parentId: null, level: 'R', nameKo: '나', nameEn: 'Me', order: 1,
  code: 'R01', folderName: 'R01-나(Me)',
});

// 미니 지침의 한 줄 정체성. 레벨이 무엇을 뜻하는지 왕초보 말로 못 박는다.
export function identityLine(node) {
  const name = node.nameKo || node.folderName;
  switch (node.level) {
    case 'R': return `역할: ${name} — 이 역할로 하는 모든 일의 규칙과 정체성`;
    case 'D': return `분야: ${name} — 계속 관리하는 분야`;
    case 'P': return `프로젝트: ${name} — 끝이 있는 구체적인 일`;
    default: return `${name} — 이 폴더가 맡는 일`;
  }
}

// R01-교사(Teacher) → R01 / R01-교사 → R01
export function codeOf(folderName) {
  const m = /^([A-Z]\d{2}(?:\.\d{2})?)(?:-|$)/.exec(String(folderName ?? ''));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------

export async function run(ctx) {
  const fs = ctx?.fs ?? nodeFs;
  const root = ctx?.root;
  if (!root) throw new StageError('E-STRUCTURE', '설치 폴더 경로가 없어 작업 폴더를 만들 수 없습니다.', { ctx: 'root' });
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};

  const decisions = ctx?.decisions ?? {};
  let nodes = Array.isArray(decisions.nodes) ? decisions.nodes.slice() : [];
  // 2.0.35: 인터뷰 결정 — 이 단계는 아무 R/D/P 도 만들지 않는다. 첫 세션이 사용자와 인터뷰해 만든다(handoff firstMessage).
  if (decisions.interview === true) {
    log('[structure] 인터뷰 방식 — 설치기는 작업 폴더를 만들지 않는다(첫 세션이 사용자와 함께 만든다)');
    return {
      recorded: {
        interview: true, created: [], skipped: [], conflicts: [], nameEnMissing: [],
        deferred: Array.isArray(decisions.deferred) ? decisions.deferred.slice() : ['R', 'D', 'P', 'S', 'T', 'tags'],
        guides: { created: 0, kept: 0 }, later: false,
      },
    };
  }
  if (nodes.length === 0) {
    if (!decisions.later) {
      throw new StageError(
        'E-STRUCTURE',
        '만들 폴더 목록이 비어 있습니다. 질문 화면에서 폴더를 다시 정해 주세요.',
        { decisions: Object.keys(decisions) },
      );
    }
    nodes = [{ ...DEFAULT_NODE }];
  }

  const template = readText(fs, policyPath(ctx, 'mini-AGENTS.md', { fs }));
  const claudeShim = readText(fs, policyPath(ctx, 'CLAUDE.md', { fs })) ?? '@AGENTS.md\n';

  const recorded = {
    created: [], skipped: [], conflicts: [], nameEnMissing: [], deferred: [],
    guides: { created: 0, kept: 0 },
    later: Boolean(decisions.later),
  };
  if (!template) recorded.miniTemplateMissing = true;

  // deferred / nameEnMissing 은 서버가 이미 적어 둔 것을 그대로 인수인계로
  // 넘긴다(handoff 가 "영어 이름 미정 폴더 채우기"를 제안한다). 없으면 계산.
  recorded.deferred = Array.isArray(decisions.deferred) ? decisions.deferred.slice() : [];
  recorded.nameEnMissing = Array.isArray(decisions.nameEnMissing)
    ? decisions.nameEnMissing.slice()
    : nodes.filter((n) => !n.nameEn).map((n) => n.folderName).filter(Boolean);

  // 부모 → 자식 순서. decisions 의 나열 순서를 믿지 않고 깊이로 정렬한다.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthOf = (n, seen = new Set()) => {
    if (!n.parentId) return 0;
    if (seen.has(n.id)) {
      throw new StageError('E-STRUCTURE', '폴더 관계가 고리를 이루고 있습니다.', { nodeId: n.id });
    }
    seen.add(n.id);
    const parent = byId.get(n.parentId);
    if (!parent) throw new StageError('E-STRUCTURE', `부모 폴더를 찾지 못했습니다: ${n.folderName ?? n.id}`, { nodeId: n.id, parentId: n.parentId });
    return depthOf(parent, seen) + 1;
  };
  const ordered = nodes
    .map((n) => ({ n, depth: depthOf(n), order: Number(n.order ?? 0) }))
    .sort((a, b) => (a.depth - b.depth) || (a.order - b.order))
    .map((x) => x.n);

  const dirById = new Map();   // node.id → 실제 절대경로
  const blocked = new Set();   // 부모가 막혀 못 만든 가지
  const linkCache = new Map(); // 정션 검사 결과(폴더별 1회)

  for (const node of ordered) {
    const folderName = node.folderName;
    if (!folderName) {
      throw new StageError('E-STRUCTURE', '이름이 정해지지 않은 폴더가 있습니다.', { nodeId: node.id, level: node.level });
    }

    if (node.parentId && blocked.has(node.parentId)) {
      blocked.add(node.id);
      recorded.conflicts.push({ code: node.code ?? codeOf(folderName), wanted: folderName, reason: 'parent-conflict' });
      continue;
    }

    const parentDir = node.parentId ? dirById.get(node.parentId) : root;
    if (!parentDir) {
      throw new StageError('E-STRUCTURE', `부모 폴더를 찾지 못했습니다: ${folderName}`, { nodeId: node.id, parentId: node.parentId });
    }

    const relParent = path.relative(root, parentDir).split(path.sep).join('\\') || '.';
    const relDir = path.relative(root, path.join(parentDir, folderName)).split(path.sep).join('\\');

    // 정션·심볼릭 링크는 글자로만 보면 루트 안이지만 실제로는 밖을 가리킨다.
    // 뚫고 쓰지 않고 그 가지를 통째로 보류한다(자료 보호, 오류 아님).
    let dir;
    try {
      dir = assertInside(root, path.join(parentDir, folderName), { fs, cache: linkCache });
    } catch (e) {
      if (e?.code !== 'E-OUTSIDE-ROOT') throw e;
      blocked.add(node.id);
      recorded.conflicts.push({
        code: node.code ?? codeOf(folderName),
        wanted: folderName,
        parent: relParent,
        reason: 'reparse-point',
        at: (e.detail?.path ? path.relative(root, e.detail.path).split(path.sep).join('\\') : relDir),
      });
      log(`[structure] ${relDir}: ${e.message}`);
      continue;
    }

    if (fs.existsSync(dir)) {
      recorded.skipped.push(relDir);
    } else {
      const taken = findByCode(fs, parentDir, node.code ?? codeOf(folderName));
      if (taken && taken !== folderName) {
        // 같은 코드를 다른 이름이 이미 쓰고 있다 → 만들지 않는다(자료 보호).
        blocked.add(node.id);
        recorded.conflicts.push({
          code: node.code ?? codeOf(folderName),
          wanted: folderName,
          existing: taken,
          parent: relParent,
          reason: 'code-taken',
        });
        log(`[structure] ${relDir}: 같은 번호를 쓰는 폴더 "${taken}" 이(가) 이미 있어 만들지 않음`);
        continue;
      }
      ensureDir(dir, { fs });
      recorded.created.push(relDir);
    }

    dirById.set(node.id, dir);

    // 미니 지침. 이미 있으면 그대로 둔다(그 사람이 쓴 지침이 우선).
    if (template) {
      const body = fillTemplate(template, { folderName, identity: identityLine(node) });
      for (const [file, content] of [['AGENTS.md', body], ['CLAUDE.md', claudeShim]]) {
        const r = writeIfAbsent(assertInside(root, path.join(dir, file), { fs, cache: linkCache }), content, { fs });
        if (r.written) recorded.guides.created += 1; else recorded.guides.kept += 1;
      }
    }
  }

  log(`[structure] 폴더 ${recorded.created.length}개 새로 만듦`
    + ` · 기존 ${recorded.skipped.length}개 그대로 · 번호 충돌 ${recorded.conflicts.length}건`
    + ` · 영어 이름 미정 ${recorded.nameEnMissing.length}개`);

  return { recorded, pending: [] };
}

// ---------------------------------------------------------------------------

// 같은 부모 아래에서 그 코드를 이미 쓰고 있는 폴더 이름(없으면 null).
function findByCode(fs, parentDir, code) {
  if (!code) return null;
  let entries;
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (codeOf(e.name) === code) return e.name;
  }
  return null;
}

function readText(fs, p) {
  try {
    if (!p || !fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
