// Write-side guard rails shared by every setup stage
// (docs\세팅엔진-계약-v2.md "멱등·무삭제 규칙").
//
//   assertInside(root, p)  every write is checked against the soul root first
//   ensureDir / copyIfAbsent / writeIfAbsent
//                          the three "create it, never overwrite it" verbs
//
// Nothing here ever deletes, truncates or rewrites an existing path: that is
// the installer's single hardest rule (설계-v2 6-4: "어떤 실패도 만든 것을
// 지우지 않는다"), and a 1.x soul's own files must survive a 2.0 re-run
// untouched.
import nodeFs from 'node:fs';
import path from 'node:path';
import { StageError } from './errors.mjs';

// Windows paths are case-insensitive and happily mix `/` and `\`, so compare
// on a resolved, lower-cased, trailing-separator-free form.
export function normalizePath(p) {
  return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
}

export function isInside(root, p) {
  const r = normalizePath(root);
  const t = normalizePath(p);
  return t === r || t.startsWith(r + path.sep.toLowerCase()) || t.startsWith(r + '\\') || t.startsWith(r + '/');
}

// 글자만 비교하는 검사. 경로에 정션이 끼어 있으면 이것만으로는 못 막는다
// -- assertInside 가 아래 assertNoReparse 와 함께 쓴다.
function assertLexicallyInside(root, p) {
  if (!isInside(root, p)) {
    throw new StageError(
      'E-OUTSIDE-ROOT',
      'IRIS 폴더 밖에 파일을 쓰려고 해서 멈췄습니다.',
      { root: String(root), target: String(p) },
    );
  }
  return path.resolve(String(p));
}

// 루트의 진짜 경로. 루트 자체가 정션이어도 된다 -- 대신 아래 검사가 전부 이
// 값을 기준으로 삼아야 "루트 안"의 뜻이 흔들리지 않는다.
export function realRootPath(root, { fs = nodeFs } = {}) {
  const abs = path.resolve(String(root));
  try {
    return typeof fs.realpathSync?.native === 'function' ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
  } catch {
    return abs; // 아직 없는 루트: 글자 그대로 쓴다
  }
}

function reparseError(segment, realPath) {
  return new StageError(
    'E-OUTSIDE-ROOT',
    '영혼 안의 폴더가 다른 곳을 가리키는 연결(정션)이라 여기에 쓰지 않습니다',
    { path: segment, realPath: realPath ?? null },
  );
}

// NTFS 정션·심볼릭 링크(reparse point) 막기.
//
// 설치 루트 아래의 `R01-교사(Teacher)` 가 사실은 D 드라이브를 가리키는 정션이면, 글자로는
// 루트 안이지만 실제 쓰기는 영혼 밖에 떨어진다. 그래서 root 에서 p 까지
// **이미 존재하는** 조각을 하나씩 내려가며 lstat 으로 링크인지 보고, 진짜 경로가
// 루트 안인지도 확인한다(윈도에서 Node 는 정션도 isSymbolicLink() 로 알린다).
// 없는 조각을 만나면 그 아래도 없으므로 거기서 멈춘다.
//
// `cache` 를 주면 한 단계 실행 안에서 폴더별 판정을 재사용한다(조각 수 × 파일 수
// 만큼 lstat 을 다시 하지 않도록).
export function assertNoReparse(root, p, { fs = nodeFs, cache = null } = {}) {
  if (typeof fs.lstatSync !== 'function') return path.resolve(String(p));
  const realRoot = realRootPath(root, { fs });
  const from = path.resolve(String(root));
  const rel = path.relative(from, path.resolve(String(p)));
  if (rel.startsWith('..')) return path.resolve(String(p)); // 글자 검사가 이미 막았다
  let cur = from;
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    const key = cur.toLowerCase();
    const seen = cache?.get(key);
    if (seen === 'ok') continue;
    if (seen) throw reparseError(cur, seen.realPath);

    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break; // 여기부터는 아직 없는 경로 -- 링크일 수 없다
    }
    if (st.isSymbolicLink()) {
      cache?.set(key, { realPath: null });
      throw reparseError(cur, null);
    }
    let real = cur;
    try {
      if (typeof fs.realpathSync?.native === 'function') real = fs.realpathSync.native(cur);
      else if (typeof fs.realpathSync === 'function') real = fs.realpathSync(cur);
    } catch { /* 읽을 수 없으면 글자 경로로 본다 */ }
    if (!isInside(realRoot, real)) {
      cache?.set(key, { realPath: real });
      throw reparseError(cur, real);
    }
    cache?.set(key, 'ok');
  }
  return path.resolve(String(p));
}

// 쓰기 직전 관문. 글자 검사 → 정션 검사 순.
// 반환은 해석된 경로라 `const f = assertInside(root, ...)` 로 바로 쓸 수 있다.
export function assertInside(root, p, { fs = nodeFs, cache = null, followLinks = true } = {}) {
  const resolved = assertLexicallyInside(root, p);
  if (followLinks) assertNoReparse(root, p, { fs, cache });
  return resolved;
}

export function ensureDir(dir, { fs = nodeFs, root = null, cache = null } = {}) {
  if (root) assertInside(root, dir, { fs, cache });
  if (fs.existsSync(dir)) return { created: false, path: dir };
  fs.mkdirSync(dir, { recursive: true });
  return { created: true, path: dir };
}

// Atomic: temp file in the destination folder, then rename. A half-written
// AGENTS.md or soul-state.json would be worse than none at all.
function atomicWrite(dst, data, { fs, encoding }) {
  const tmp = `${dst}.tmp`;
  if (typeof data === 'string') fs.writeFileSync(tmp, data, encoding);
  else fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  return dst;
}

// `content` may be a string (written as `encoding`, default utf8) or a Buffer
// (written byte-for-byte -- desktop.ini needs UTF-16LE with a BOM).
export function writeIfAbsent(dst, content, { fs = nodeFs, encoding = 'utf8', root = null, cache = null } = {}) {
  if (root) assertInside(root, dst, { fs, cache });
  if (fs.existsSync(dst)) return { written: false, kept: true, path: dst };
  ensureDir(path.dirname(dst), { fs });
  atomicWrite(dst, content, { fs, encoding });
  return { written: true, kept: false, path: dst };
}

export function copyIfAbsent(src, dst, { fs = nodeFs, root = null, cache = null } = {}) {
  if (root) assertInside(root, dst, { fs, cache });
  if (fs.existsSync(dst)) return { written: false, kept: true, missingSource: false, path: dst };
  if (!src || !fs.existsSync(src)) return { written: false, kept: false, missingSource: true, path: dst };
  ensureDir(path.dirname(dst), { fs });
  return { written: true, kept: false, missingSource: false, path: atomicWrite(dst, fs.readFileSync(src), { fs }) };
}

// Recursive copy with the same "never overwrite" contract: every file that is
// already there is left exactly as it is. Returns the relative paths it wrote.
export function copyTreeIfAbsent(srcDir, dstDir, { fs = nodeFs, root = null, filter = null, cache = null } = {}) {
  const written = [];
  const kept = [];
  if (!srcDir || !fs.existsSync(srcDir)) return { written, kept, missingSource: true };
  const memo = cache ?? new Map(); // 한 트리 안에서 폴더 판정을 한 번씩만
  const walk = (rel) => {
    const from = rel ? path.join(srcDir, rel) : srcDir;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (filter && !filter(childRel, entry)) continue;
      const to = path.join(dstDir, childRel);
      if (root) assertInside(root, to, { fs, cache: memo });
      if (entry.isDirectory()) {
        ensureDir(to, { fs });
        walk(childRel);
      } else {
        const r = copyIfAbsent(path.join(srcDir, childRel), to, { fs });
        (r.written ? written : kept).push(childRel);
      }
    }
  };
  if (root) assertInside(root, dstDir, { fs, cache: memo });
  ensureDir(dstDir, { fs });
  walk('');
  return { written, kept, missingSource: false };
}

// `{{folderName}}` / `{{identity}}` substitution for the mini AGENTS.md
// templates. Unknown placeholders are left alone on purpose -- a typo in a
// template should be visible in the produced file, not silently blanked.
export function fillTemplate(text, values) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
  ));
}
