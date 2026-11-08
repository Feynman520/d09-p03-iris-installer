// 대상(운영체제·CPU)별 잠금표 (docs/설계-macOS.md D-M12).
//
// `lock.json` 은 지금까지와 똑같이 Windows(win32-x64) 잠금표다 — 한 글자도 바꾸지 않는다.
// 다른 대상은 같은 폴더의 `lock.<대상>.json` 덮어쓰기 파일이 "무엇이 다른가"만 적는다:
//
//   { "target": "darwin-arm64",
//     "parts": {
//       "node":   { ...이 대상에서 바뀌는 칸만... },   → 기본 부품 위에 얕게 덮는다
//       "excel-automation": null,                   → 이 대상에는 싣지 않는다
//       "새 부품": { kind, ... }                      → 이 대상에만 있다
//     } }
//
// 덮을 때 칸 하나는 통째로 바뀐다(예: `fallback` 은 섞지 않고 바꾼다). `$comment` 는 덮지 않는다.
// 펼친 결과가 곧 그 대상 zip 의 `lock.json` 이다 — 설치기는 대상을 몰라도 된다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_TARGET = 'win32-x64';
export const KNOWN_TARGETS = Object.freeze(['win32-x64', 'darwin-arm64']);

export function overlayPath(target, { rootDir = ROOT_DIR } = {}) {
  return path.join(rootDir, `lock.${target}.json`);
}

/** 기본 잠금표 + 덮어쓰기 → 그 대상의 잠금표(새 객체). */
export function applyOverlay(base, overlay) {
  if (!overlay) return base;
  if (overlay.target && !KNOWN_TARGETS.includes(overlay.target)) {
    throw new Error(`lock overlay: unknown target ${overlay.target}`);
  }
  const out = structuredClone(base);
  out.target = overlay.target;
  for (const [name, patch] of Object.entries(overlay.parts ?? {})) {
    if (patch === null) {
      delete out.parts[name];
      continue;
    }
    const { $comment: _ignored, ...fields } = patch;
    out.parts[name] = { ...(out.parts[name] ?? {}), ...fields };
    // 덮어쓰기가 칸을 null 로 두면 "이 대상에는 그 칸이 없다"는 뜻이다.
    for (const [k, v] of Object.entries(fields)) if (v === null) delete out.parts[name][k];
  }
  return out;
}

/**
 * 그 대상의 잠금표를 읽는다. 기본 대상(win32-x64)은 `lock.json` 그대로이고
 * `text` 도 파일 원문 그대로다(그래서 Windows zip 의 lock.json 은 예전과 같은 바이트).
 * → { lock, text, target }
 */
export function loadLockForTarget(target = DEFAULT_TARGET, { rootDir = ROOT_DIR } = {}) {
  if (!KNOWN_TARGETS.includes(target)) throw new Error(`unknown build target: ${target} (known: ${KNOWN_TARGETS.join(', ')})`);
  const baseText = fs.readFileSync(path.join(rootDir, 'lock.json'), 'utf8');
  const base = JSON.parse(baseText);
  if (target === DEFAULT_TARGET) return { lock: base, text: baseText, target };
  const overlay = JSON.parse(fs.readFileSync(overlayPath(target, { rootDir }), 'utf8'));
  if (overlay.target !== target) throw new Error(`lock overlay ${overlayPath(target, { rootDir })} says target ${overlay.target}, expected ${target}`);
  const lock = applyOverlay(base, overlay);
  return { lock, text: `${JSON.stringify(lock, null, 2)}\n`, target };
}
