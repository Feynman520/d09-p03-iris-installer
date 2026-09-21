// 작업 폴더 구성(④-3) 서버 쪽 규칙.
//
// 규칙 자체는 화면(`installer/ui/structure.mjs`, T12)과 **한 벌**이어야 한다
// — 미리 보기에서 통과한 나무가 제출하자마자 서버에서 거절당하면 왕초보는
// 무엇이 잘못됐는지 알 수 없다. 그래서 여기서 규칙을 다시 쓰지 않고 그 파일을
// 그대로 들여와 다시 내보낸다(두 구현이 어긋날 여지가 아예 없다). 이 파일이
// 더하는 것은 서버만 하는 일 —— `decisions.json` 만들기·원자 저장 —— 뿐이다.
//
// 정본 = docs/설치기-API-v2.md `POST /api/structure` 절.
import nodeFs from 'node:fs';
import path from 'node:path';

import {
  LEVELS,
  LEVEL_LABEL,
  PLACEHOLDER_NAMES,
  laterNodes,
  isPlaceholderName,
  validateNodes,
  assignCodes,
  folderName,
  renderTree,
  applyPreset,
} from '../ui/structure.mjs';

export {
  LEVELS,
  LEVEL_LABEL,
  PLACEHOLDER_NAMES,
  laterNodes,
  isPlaceholderName,
  validateNodes,
  assignCodes,
  folderName,
  renderTree,
  applyPreset,
};

// S(단계)·T(작업)·태그는 설치 때 묻지 않는다 — "일이 시작될 때 비서가 만든다"
// (설계-v2 5절). 「나중에 비서와 정하기」면 D·P까지 미룬다.
export const DEFERRED_ALWAYS = ['S', 'T', 'tags'];
export const DEFERRED_LATER = ['D', 'P', 'S', 'T', 'tags'];

export function decisionsPath(root) {
  return path.join(root, '_agent', 'setup', 'decisions.json');
}

/**
 * 검증을 통과한 항목들을 `decisions.json` 내용으로 만든다.
 * @param {{nodes?:Array, later?:boolean, now?:Date}} input
 */
export const DEFERRED_INTERVIEW = ['R', 'D', 'P', 'S', 'T', 'tags'];

export function buildDecisions({ nodes = [], later = false, interview = false, now = new Date() } = {}) {
  // 2.0.35(2026-09-21 사용자 결정): 설치기는 폴더 구조를 묻지 않는다. 설치는 IRIS 폴더(+도구 폴더)만 만들고,
  // R/D/P 는 첫 세션이 인터뷰(`_agent\setup\interview.md`)로 사용자와 함께 만든다. 그 결정이 `interview:true` 다.
  if (interview) {
    return { schema: 1, createdAt: now.toISOString(), later: false, interview: true, nodes: [], deferred: [...DEFERRED_INTERVIEW], nameEnMissing: [] };
  }
  const source = later ? laterNodes() : (Array.isArray(nodes) ? nodes.filter(Boolean) : []);
  const coded = assignCodes(source).map((n) => ({
    id: n.id ?? null,
    parentId: n.parentId ?? null,
    level: n.level,
    nameKo: String(n.nameKo ?? '').trim(),
    nameEn: n.nameEn == null ? '' : String(n.nameEn).trim(),
    order: n.order ?? null,
    code: n.code,
    folderName: folderName(n),
  }));
  return {
    schema: 1,
    createdAt: now.toISOString(),
    later: !!later,
    nodes: coded,
    deferred: later ? [...DEFERRED_LATER] : [...DEFERRED_ALWAYS],
    // 영어 이름을 비운 폴더 — Face 첫 인사에서 채우기를 제안한다(설계-v2 5절).
    nameEnMissing: coded.filter((n) => n.nameEn === '').map((n) => n.folderName),
  };
}

// 원자 저장: 임시 파일 → 이름 바꾸기. 반쯤 쓰인 decisions.json 은 없는 것만
// 못하다(설계-v2 6-4).
export function writeDecisions(root, decisions, { fs = nodeFs } = {}) {
  const dest = decisionsPath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(decisions, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
  return dest;
}

export function readDecisions(root, { fs = nodeFs } = {}) {
  try {
    return JSON.parse(fs.readFileSync(decisionsPath(root), 'utf8'));
  } catch {
    return null;
  }
}
