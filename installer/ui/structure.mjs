// 작업 폴더 구성(④) 화면의 "머리" — 화면(DOM)을 전혀 모르는 순수 함수만 모았다.
// 브라우저(index.html의 <script type="module">)와 Node(tests/structure.test.mjs) 양쪽에서 같은 코드를 쓴다.
// 여기서 하는 판정은 어디까지나 "미리 보기"이고, 정본은 서버(POST /api/structure)가 다시 매긴다
// — 번호(code)도 서버가 부여한 것이 진짜다(계약 문서 `docs/설치기-API-v2.md`).

export const LEVELS = ['R', 'D', 'P'];

/** 한글·영어 단계 이름(화면 문구용). */
export const LEVEL_LABEL = { R: '가장 바깥(R)', D: '분야(D)', P: '일거리(P)' };

/** 자리표시자 이름 — 나중에 무엇이 들었는지 알 수 없어 폴더로 만들지 않는다. */
export const PLACEHOLDER_NAMES = ['기타', '임시', '테스트', 'test', 'temp', 'misc'];

/** 윈도우가 폴더 이름에 허락하지 않는 글자. */
const FORBIDDEN_CHARS = /[<>:"/\\|?*]/;
/** 영어 이름에 허락하는 글자(영문·숫자·빈칸·하이픈). */
const NAME_EN_OK = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;
/** 각 단계의 부모 단계. R은 부모가 없다. */
const PARENT_LEVEL = { R: null, D: 'R', P: 'D' };

/** 이름 길이 상한(글자 수). 폴더 이름은 `R01-<한글>(<영어>)`라 둘을 합쳐도 윈도 260자 한계에 여유가 있다. */
export const NAME_MAX = 40;

/**
 * 눈에 보이지 않는 제어 문자(U+0000~U+001F, U+007F)가 섞였는가.
 * 정규식 대신 코드 번호로 훑는다 — 소스에 진짜 제어 문자가 끼어드는 사고를 막기 위해서다.
 */
export function hasControlChar(value) {
  const s = str(value);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/** 글자 수(이모지·한글 결합을 한 글자로 세도록 코드 포인트 기준). */
const charLen = (value) => Array.from(str(value)).length;

const str = (v) => (v == null ? '' : String(v));
const pidOf = (node) => {
  const p = str(node && node.parentId).trim();
  return p === '' ? null : p;
};
const idOf = (node) => {
  const i = str(node && node.id).trim();
  return i === '' ? null : i;
};

/** 「나중에 비서와 정하기」를 고르면 서버가 만들어 주는 폴더 하나. 미리 보기에 쓴다. */
export function laterNodes() {
  return [{ id: 'later-root', parentId: null, level: 'R', nameKo: '나', nameEn: 'Me', order: 1 }];
}

export function isPlaceholderName(name) {
  const n = str(name).trim().toLowerCase();
  return PLACEHOLDER_NAMES.some((p) => p.toLowerCase() === n);
}

/**
 * 폴더 항목들을 검사한다. 서버(`POST /api/structure`)와 같은 규칙.
 * @param {Array} nodes  { id, parentId, level, nameKo, nameEn, order }
 * @param {{later?:boolean}} [opts]
 * @returns {{ ok:boolean, errors:Array<{nodeId:string|null, code:string, message:string}> }}
 */
export function validateNodes(nodes, opts) {
  const later = !!(opts && opts.later);
  const list = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
  const errors = [];
  const push = (nodeId, code, message) => errors.push({ nodeId: nodeId == null ? null : str(nodeId), code, message });

  if (later) {
    // 「나중에 비서와 정하기」는 서버가 R01-나(Me) 하나만 만든다. 이때 항목을 함께 보내면 뜻이 어긋난다.
    if (list.length > 0) push(null, 'later-with-nodes', '「나중에 비서와 정하기」를 고르면 적어 둔 폴더 항목은 보내지 않습니다.');
    return { ok: errors.length === 0, errors };
  }

  if (!list.some((n) => n.level === 'R')) {
    push(null, 'no-root', '가장 바깥 폴더(R)가 적어도 하나는 있어야 합니다. 예: 「교사」, 「연구자」.');
  }

  const byId = new Map();
  for (const n of list) {
    const id = idOf(n);
    if (!id) continue;
    // 같은 항목 번호가 두 번 오면 부모·중복 판정이 통째로 어긋난다. 화면 잘못이지만 서버도 같이 막는다.
    if (byId.has(id)) push(id, 'duplicate-id', '같은 항목이 두 번 들어왔습니다. 화면을 새로 고친 뒤 다시 해 주세요.');
    else byId.set(id, n);
  }

  for (const n of list) {
    const id = idOf(n);
    if (LEVELS.indexOf(n.level) < 0) {
      push(id, 'bad-level', '단계는 R·D·P 가운데 하나여야 합니다.');
      continue;
    }

    const ko = str(n.nameKo);
    const koTrim = ko.trim();
    if (koTrim === '') {
      push(id, 'empty-name', '한글 이름을 적어 주세요.');
    } else {
      if (FORBIDDEN_CHARS.test(ko)) push(id, 'bad-char', '이름에 < > : " / \\ | ? * 는 쓸 수 없습니다(윈도우가 막는 글자입니다).');
      if (hasControlChar(ko)) push(id, 'control-char', '한글 이름에 눈에 보이지 않는 특수 글자가 섞여 있습니다. 그 칸을 지우고 다시 적어 주세요.');
      if (/[. ]$/.test(ko)) push(id, 'bad-tail', '이름은 점(.)이나 빈칸으로 끝날 수 없습니다.');
      if (charLen(koTrim) > NAME_MAX) push(id, 'too-long', '한글 이름은 ' + NAME_MAX + '글자까지 쓸 수 있습니다(지금 ' + charLen(koTrim) + '글자). 짧게 줄여 주세요.');
      if (isPlaceholderName(ko)) push(id, 'placeholder', '「' + koTrim + '」는 나중에 무엇이 들었는지 알 수 없는 이름이라 만들지 않습니다. 하는 일이 드러나는 이름으로 바꿔 주세요.');
    }

    const en = str(n.nameEn).trim();
    if (en !== '') {
      if (hasControlChar(en)) push(id, 'control-char', '영어 이름에 눈에 보이지 않는 특수 글자가 섞여 있습니다. 그 칸을 지우고 다시 적어 주세요.');
      else if (!NAME_EN_OK.test(en)) push(id, 'bad-name-en', '영어 이름에는 영문·숫자·빈칸·하이픈(-)만 쓸 수 있습니다. 비워 두어도 됩니다.');
      if (charLen(en) > NAME_MAX) push(id, 'too-long', '영어 이름은 ' + NAME_MAX + '글자까지 쓸 수 있습니다(지금 ' + charLen(en) + '글자). 짧게 줄여 주세요.');
    }

    const wantParent = PARENT_LEVEL[n.level];
    const pid = pidOf(n);
    if (wantParent === null) {
      if (pid !== null) push(id, 'bad-parent-level', '가장 바깥 폴더(R)는 다른 폴더 안에 넣을 수 없습니다.');
    } else if (pid === null) {
      push(id, 'orphan', LEVEL_LABEL[n.level] + ' 폴더는 ' + LEVEL_LABEL[wantParent] + ' 폴더 안에 들어가야 합니다. 어디에 넣을지 골라 주세요.');
    } else {
      const parent = byId.get(pid);
      if (!parent) push(id, 'orphan', '넣으려는 자리(부모 폴더)가 목록에 없습니다. 다시 골라 주세요.');
      else if (parent.level !== wantParent) push(id, 'bad-parent-level', LEVEL_LABEL[n.level] + ' 폴더는 ' + LEVEL_LABEL[wantParent] + ' 폴더 안에만 넣을 수 있습니다.');
    }
  }

  const seen = new Map();
  for (const n of list) {
    const koTrim = str(n.nameKo).trim();
    if (koTrim === '') continue;
    const key = JSON.stringify([pidOf(n) || '', koTrim]);
    if (seen.has(key)) push(idOf(n), 'duplicate', '같은 자리에 같은 이름이 둘 있습니다: 「' + koTrim + '」');
    else seen.set(key, idOf(n));
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 같은 부모 아래에서 order 순으로 `01`부터 번호를 매긴다(원본은 건드리지 않고 사본을 돌려준다).
 * 정본은 서버가 매기지만, 화면에서도 같은 규칙으로 미리 보여 준다.
 */
export function assignCodes(nodes) {
  const list = (Array.isArray(nodes) ? nodes.filter(Boolean) : []).map((n, i) => ({ ...n, _at: i }));
  const groups = new Map();
  for (const n of list) {
    const key = pidOf(n) || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const ao = Number(a.order); const bo = Number(b.order);
      const an = Number.isFinite(ao) ? ao : Number.MAX_SAFE_INTEGER;
      const bn = Number.isFinite(bo) ? bo : Number.MAX_SAFE_INTEGER;
      return an === bn ? a._at - b._at : an - bn;
    });
    const seq = {};
    for (const n of group) {
      const lv = LEVELS.indexOf(n.level) >= 0 ? n.level : 'R';
      seq[lv] = (seq[lv] || 0) + 1;
      n.code = lv + String(seq[lv]).padStart(2, '0');
    }
  }
  return list.map((n) => { const { _at, ...rest } = n; return rest; });
}

/** `R01-교사(Teacher)` / 영어 이름이 비면 `R01-교사`. 괄호 앞에 빈칸을 넣지 않는다. */
export function folderName(node) {
  if (!node) return '';
  const code = str(node.code).trim();
  const ko = str(node.nameKo).trim();
  const en = str(node.nameEn).trim();
  const base = code ? code + '-' + ko : ko;
  return en ? base + '(' + en + ')' : base;
}

/** 폴더 나무를 들여쓴 문자열 배열로. 한 항목은 반드시 한 줄로 딱 한 번 나온다. */
export function renderTree(nodes) {
  const list = assignCodes(nodes);
  const out = [];
  const emitted = new Set();
  const childrenOf = (pid) => list.filter((n) => pidOf(n) === pid);

  const walk = (pid, depth) => {
    for (const n of childrenOf(pid)) {
      const id = idOf(n);
      if (id && emitted.has(id)) continue;
      if (id) emitted.add(id);
      out.push('  '.repeat(depth) + folderName(n));
      if (id) walk(id, depth + 1);
    }
  };
  walk(null, 0);

  // 부모를 잃은 항목도 숨기지 않는다 — 화면에서 사라지면 사용자가 무엇이 잘못됐는지 알 수 없다.
  for (const n of list) {
    const id = idOf(n);
    if (id && emitted.has(id)) continue;
    if (id) emitted.add(id);
    out.push('(자리 미정) ' + folderName(n));
  }
  return out;
}

/** presets.json 의 프리셋 하나를 편집기가 쓰는 평평한 항목 목록으로 편다. */
export function applyPreset(preset) {
  const nodes = [];
  let seq = 0;
  const walk = (items, parentId) => {
    (Array.isArray(items) ? items : []).forEach((item, i) => {
      if (!item) return;
      const id = 'n' + (++seq);
      nodes.push({
        id,
        parentId: parentId,
        level: item.level,
        nameKo: str(item.nameKo),
        nameEn: item.nameEn == null ? '' : str(item.nameEn),
        order: i + 1,
      });
      walk(item.children, id);
    });
  };
  walk(preset && preset.tree, null);
  return nodes;
}
