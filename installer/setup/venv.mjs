// ⑤-5 파이썬 환경 (설계-v2 6-2, 계약 v2 5단계)
//
// standalone 파이썬 + uv 로 다섯 문서 MCP(hwp·excel·ppt·word·pdf-automation)가
// 함께 쓰는 `document-mcp` venv 를 **오프라인**으로 만들고, 온톨로지 스크립트가
// 쓰는 PyYAML 을 venv 가 아니라 "런타임"(standalone python 자신)에 놓는다.
//
// ── 경로는 전부 잠금표에서 다시 계산한다 ────────────────────────────────────
// python.exe · uv.exe · wheelhouse 폴더는 ⑤-1 unpack(`setup/unpack.mjs`)이 이미
// 놓아 두었다(V2_LAYOUT: python 은 strip 1 이라 `<dest>\python.exe` 가 바로
// 있고, uv 는 `hoist-wheel-scripts` 로 바퀴 안 `uv-<판>.data\scripts\uv.exe` 를
// `<dest>\uv.exe` 에도 복사해 둔다, document-mcp-wheelhouse 는 `dir-files` 로
// 바퀴(.whl)만 dest 에 평평하게 복사돼 있다 — 실측: `_build\stage\payload`로
// 만든 연습 소울에서 43개 바퀴 전부 확인). 이 파일은 그 결과 경로를 다시
// 계산할 뿐 unpack.mjs 를 import 하지 않는다("모듈끼리 서로 import 하지
// 않는다", 계약 v2 머리말). uv.exe 가 혹시 hoist 되지 않은 채로 남아 있어도
// 계속 진행할 수 있도록 dest 바로 밑이 아니면 bounded 재귀 탐색으로 한 번 더
// 찾는다.
//
// ── venv 자리는 lock.json 이 아니라 adapters.mjs 와 맞춘다 ─────────────────
// lock.json 의 `document-mcp-wheelhouse.venv` 필드는
// `_agent/shared/tools/python-envs/document-mcp` 를 적어 두었지만, 이미 커밋된
// `setup/adapters.mjs` 의 `venvPythonPath(root)` 는
// `<root>\_agent\runtime\venvs\document-mcp\Scripts\python.exe` 를 하드코딩해
// 문서 MCP 5종의 실행 명령을 이미 그리로 못박아 두었다(⑤-6). 두 경로가 다르면
// adapters 가 등록한 MCP 서버 5개가 전부 "파이썬을 찾을 수 없음"으로 죽는다.
// 그래서 이 파일은 lock.json 필드 대신 adapters.mjs 와 **글자 그대로 같은**
// 상대경로를 쓴다 (task-15-report.md 에 이 불일치를 남겨 lock.json 쪽 정정을
// 요청한다).
//
// ── requirements.lock 은 설치판에 오지 않는다 ──────────────────────────────
// 빌드는 wheelhouse 안에 43개 .whl 만 넣고 잠금 파일 자체는 담지 않는다(빌드
// 시점 파일 `payload-src\manifests\python-locks\document-mcp\requirements.lock`
// 은 저장소에만 있고 `_build\stage\payload` 트리 어디에도 없음 — 실측
// 확인). 그래서 wheelhouse 안에서 `requirements.lock` 을 먼저 찾아보되(미래에
// 실릴 경우를 대비), 없으면 wheelhouse 의 모든 .whl 절대경로를
// `uv pip install --offline --no-index --find-links <wheelhouse> <바퀴들...>`
// 의 위치 인자로 그대로 넘긴다 — wheelhouse 자체가 `--no-deps --require-hashes`
// 로 이미 해석이 끝난 고정 집합이고, wheelhouse 의 sha256(잠금표)이 무결성
// 닻이므로 기능적으로 동등하다.
//
// ── 격리 검사 ───────────────────────────────────────────────────────────────
// T02 실험(embedded python 은 레지스트리로 시스템 파이썬 .pyd 19개를 물어옴,
// standalone+uv venv 는 0개)을 일반화한 검사: venv·런타임 양쪽에서 불러온
// 모듈의 `__file__` 이 전부 soul root 아래인지 본다. `__main__`/`__mp_main__`
// (지금 돌리는 `-c` 스크립트 자신 — `-c` 실행은 `__file__` 이 애초에 없어 보통은
// 걸리지 않지만 방어적으로 제외)과 `win32com.gen_py.*`(pywin32 가 COM 형식
// 정보를 `%TEMP%\gen_py`에 캐시하는 자기 자신의 관행 — 다른 파이썬 설치가
// 끼어든 것이 아니므로 감사 대상에서 뺀다, 실측으로 확인)만 예외로 둔다.
import nodeFs from 'node:fs';
import path from 'node:path';
import { StageError } from '../lib/errors.mjs';
import { assertInside } from '../lib/paths.mjs';
import { partPath } from '../lib/payload.mjs';

export const id = 'venv';

// ---------------------------------------------------------------------------
// 잠금표 읽기 (unpack.mjs 의 같은 이름 헬퍼와 동작이 같다 — 모듈 간 import
// 금지 규칙 때문에 각자 갖는다)
// ---------------------------------------------------------------------------
export function lockField(ctx, partId, field) {
  const fromManifest = ctx?.manifest?.parts?.[partId]?.[field];
  if (fromManifest !== undefined && fromManifest !== null) return fromManifest;
  const fromLock = ctx?.lock?.parts?.[partId]?.[field];
  return fromLock === undefined ? null : fromLock;
}

export function underRoot(root, rel) {
  if (rel === undefined || rel === null) return null;
  const clean = String(rel).replace(/^[\\/]+/, '');
  if (!clean || clean === '.') return root;
  return path.join(root, clean.split('/').join(path.sep));
}

export const KEY_MODULES = ['mcp', 'pyhwpx', 'pypdf', 'pypdfium2', 'PIL'];

// 2026-09-16 VM S01 실측(2.0.0, 한컴 없는 깨끗한 Windows 11): `import pyhwpx` 는
// 불러오는 순간 한/글의 COM 형식 라이브러리를 찾는다(win32com gencache). 한컴이 없는
// PC — 곧 새 PC 대부분 — 에서는 `pywintypes.com_error(-2147319779, '라이브러리가
// 등록되지 않았습니다')` 로 import 자체가 실패했고, 그 하나 때문에 세팅 전체가 44% 에서
// E-VENV 로 멈췄다. 한컴 없음은 설계상 checks 단계가 `pending`(대기)으로 판정할 일이지
// 설치 실패가 아니다(setup/checks.mjs 머리말). 그래서 이 모듈의 import 실패는 **기록만**
// 하고 넘어간다. 이 개발 PC 는 한컴이 있어 S08 이 통과했고, 그래서 배포 전에 못 잡았다.
export const SOFT_MODULES = ['pyhwpx'];

export function isLeakAuditExempt(name) {
  return name === '__main__' || name === '__mp_main__' || name.startsWith('win32com.gen_py');
}

// ---------------------------------------------------------------------------
// 작은 유틸
// ---------------------------------------------------------------------------

// uv.exe 가 hoist 되지 않았을 때를 대비한 bounded 재귀 탐색(폭발 방지로 깊이
// 제한). 판 폴더 하나 안에서만 찾으므로 몇 단계면 충분하다.
function findFileUnder(fs, dir, filename, { maxDepth = 4 } = {}) {
  const stack = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: cur, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(cur, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return p;
      if (entry.isDirectory() && depth < maxDepth) stack.push({ dir: p, depth: depth + 1 });
    }
  }
  return null;
}

function locateRequirementsLock(fs, wheelhouseDir) {
  const candidate = path.join(wheelhouseDir, 'requirements.lock');
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  } catch {
    /* 후보가 안 읽히면 다음 방법(바퀴 목록)으로 */
  }
  return null;
}

export function locateParts(ctx) {
  const { root } = ctx;
  const fs = ctx.fs ?? nodeFs;

  const pythonDest = underRoot(root, lockField(ctx, 'python', 'dest'));
  const pythonExe = pythonDest ? path.join(pythonDest, 'python.exe') : null;

  const uvDest = underRoot(root, lockField(ctx, 'uv', 'dest'));
  let uvExe = uvDest ? path.join(uvDest, 'uv.exe') : null;
  if (uvDest && (!uvExe || !fs.existsSync(uvExe))) {
    uvExe = findFileUnder(fs, uvDest, 'uv.exe') ?? uvExe;
  }

  const wheelhouseDir = underRoot(root, lockField(ctx, 'document-mcp-wheelhouse', 'dest'));
  // 기대 개수는 lock.json 이 유일한 출처다 -- 빌드된 manifest.json 은 이
  // 부품을 `null`로 담고(바퀴 각각을 개별 항목으로 적을 뿐 wheelCount 묶음
  // 필드가 없다, 실측), lockField() 는 manifest 값이 null 이면 이미 lock
  // 으로 폴백하므로 여기 별도 manifest.wheelCount 폴백은 죽은 코드였다
  // (리뷰 지적사항 -- 제거).
  const expectedCount = lockField(ctx, 'document-mcp-wheelhouse', 'expectedCount') ?? null;

  const pyyamlWheel = partPath(ctx, 'pyyaml');

  // adapters.mjs 의 venvPythonPath(root) 와 글자 그대로 같은 상대경로(머리말 참고).
  const venvDir = path.join(root, '_agent', 'runtime', 'venvs', 'document-mcp');
  const venvPython = path.join(venvDir, 'Scripts', 'python.exe');

  return {
    pythonDest, pythonExe, uvDest, uvExe, wheelhouseDir, expectedCount, pyyamlWheel, venvDir, venvPython,
  };
}

function baseEnv(ctx) {
  return {
    ...ctx.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    UV_OFFLINE: '1',
  };
}

async function runLogged(ctx, exe, args, opts = {}) {
  ctx.log(`[venv] ${[exe, ...args].join(' ')}`);
  return ctx.run(exe, args, { env: baseEnv(ctx), timeoutMs: 600000, ...opts });
}

function fail(message, detail) {
  throw new StageError('E-VENV', message, detail);
}

function lastJsonLine(text) {
  const lines = String(text ?? '').trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

async function probeInstalledCount(ctx, uvExe, venvPython) {
  const fs = ctx.fs ?? nodeFs;
  if (!fs.existsSync(venvPython)) return null;
  const r = await runLogged(ctx, uvExe, ['pip', 'list', '--python', venvPython, '--format', 'json']);
  if (r.code !== 0) return null;
  try {
    const arr = JSON.parse(lastJsonLine(r.out) || r.out);
    return Array.isArray(arr) ? arr.length : null;
  } catch {
    return null;
  }
}

// venv 안에서 5개 핵심 모듈을 불러오고, 동시에 root 밖 파이썬이 끼어들지
// 않았는지(격리) 한 번의 `-c` 로 함께 확인한다.
export function buildImportCheckScript(root, modules) {
  return [
    'import sys, os, json',
    'sys.stdout.reconfigure(encoding="utf-8", errors="replace")',
    `root = os.path.realpath(${JSON.stringify(root)}).lower()`,
    `mods = ${JSON.stringify(modules)}`,
    'out = {"imports": {}, "leaks": []}',
    'for m in mods:',
    '    try:',
    '        mod = __import__(m)',
    '        out["imports"][m] = {"ok": True, "file": getattr(mod, "__file__", None)}',
    '    except Exception as e:',
    '        out["imports"][m] = {"ok": False, "error": str(e)}',
    'skip_exact = ("__main__", "__mp_main__")',
    'for name, mod in list(sys.modules.items()):',
    '    if name in skip_exact or name.startswith("win32com.gen_py"):',
    '        continue',
    '    f = getattr(mod, "__file__", None)',
    '    if not f:',
    '        continue',
    '    try:',
    '        real = os.path.realpath(f).lower()',
    '    except Exception:',
    '        continue',
    '    if not real.startswith(root):',
    '        out["leaks"].append({"module": name, "file": f})',
    'print(json.dumps(out))',
  ].join('\n');
}

// import 실패 상세에 "앱 제어 정책이 차단" 흔적이 있는가 (한국어·영어 윈도 둘 다).
export function appControlBlocked(detail) {
  const text = JSON.stringify(detail ?? '');
  return /DLL load failed/i.test(text)
    && /(애플리케이션 제어 정책|application control policy|앱 제어 정책|Smart App Control)/i.test(text);
}

async function runImportAndLeakCheck(ctx, venvPython, root) {
  const script = buildImportCheckScript(root, KEY_MODULES);
  const r = await runLogged(ctx, venvPython, ['-c', script]);
  if (r.code !== 0) return { ok: false, leaks: [], detail: { code: r.code, out: r.out, err: r.err } };
  let parsed;
  try {
    parsed = JSON.parse(lastJsonLine(r.out));
  } catch (e) {
    return { ok: false, leaks: [], detail: { parseError: e.message, out: r.out } };
  }
  const entries = Object.entries(parsed.imports ?? {});
  const failed = entries.filter(([m, v]) => !v?.ok && !SOFT_MODULES.includes(m));
  const soft = Object.fromEntries(entries.filter(([m, v]) => !v?.ok && SOFT_MODULES.includes(m)));
  if (failed.length > 0) return { ok: false, leaks: parsed.leaks ?? [], detail: { failed, soft } };
  return { ok: true, leaks: parsed.leaks ?? [], imports: parsed.imports, soft };
}

// PyYAML 은 순수 파이썬 `yaml` 뒤에 컴파일된 `_yaml` 확장을 함께 물어올 수
// 있어(리뷰 지적사항), `yaml.__file__` 하나만 보면 `_yaml`이 root 밖에서
// 새어 들어온 것을 놓친다. 그래서 venv 쪽 buildImportCheckScript 와 같은
// 방식으로 바꾼다: yaml(및 있으면 _yaml)을 불러온 뒤 그 시점의
// sys.modules 전체를 감사해, root 아래가 아닌 `__file__`을 가진 모듈을
// 전부 leaks 로 모은다.
export function buildYamlProbeScript(root) {
  return [
    'import sys, os, json',
    'sys.stdout.reconfigure(encoding="utf-8", errors="replace")',
    `root = os.path.realpath(${JSON.stringify(root)}).lower()`,
    'out = {"ok": True, "file": None, "leaks": []}',
    'try:',
    '    import yaml',
    '    out["file"] = getattr(yaml, "__file__", None)',
    '    try:',
    '        import _yaml',
    '    except Exception:',
    '        pass',
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "error": str(e)}))',
    '    sys.exit(0)',
    'skip_exact = ("__main__", "__mp_main__")',
    'for name, mod in list(sys.modules.items()):',
    '    if name in skip_exact or name.startswith("win32com.gen_py"):',
    '        continue',
    '    f = getattr(mod, "__file__", None)',
    '    if not f:',
    '        continue',
    '    try:',
    '        real = os.path.realpath(f).lower()',
    '    except Exception:',
    '        continue',
    '    if not real.startswith(root):',
    '        out["leaks"].append({"module": name, "file": f})',
    'print(json.dumps(out))',
  ].join('\n');
}

async function probeYaml(ctx, pythonExe, root) {
  const script = buildYamlProbeScript(root);
  const r = await runLogged(ctx, pythonExe, ['-c', script]);
  if (r.code !== 0) return { ok: false, detail: { code: r.code, out: r.out, err: r.err } };
  try {
    const parsed = JSON.parse(lastJsonLine(r.out));
    return { ok: !!parsed.ok, file: parsed.file ?? null, leaks: parsed.leaks ?? [], detail: parsed };
  } catch (e) {
    return { ok: false, detail: { parseError: e.message, out: r.out } };
  }
}

// ---------------------------------------------------------------------------
// 단계 본체
// ---------------------------------------------------------------------------
export async function run(ctx) {
  const { root } = ctx;
  const fs = ctx.fs ?? nodeFs;
  const cache = new Map();
  const t0 = Date.now();

  const parts = locateParts(ctx);

  if (!parts.pythonExe || !fs.existsSync(parts.pythonExe)) {
    fail('동봉 파이썬(python.exe)을 찾지 못해 문서 자동화 환경을 만들 수 없습니다.', { pythonExe: parts.pythonExe, pythonDest: parts.pythonDest });
  }
  if (!parts.uvExe || !fs.existsSync(parts.uvExe)) {
    fail('동봉 uv 도구를 찾지 못해 문서 자동화 환경을 만들 수 없습니다.', { uvExe: parts.uvExe, uvDest: parts.uvDest });
  }
  if (!parts.wheelhouseDir || !fs.existsSync(parts.wheelhouseDir)) {
    fail('문서 자동화 바퀴집(wheelhouse)을 찾지 못해 설치할 수 없습니다.', { wheelhouseDir: parts.wheelhouseDir });
  }
  let wheelFiles;
  try {
    wheelFiles = fs.readdirSync(parts.wheelhouseDir).filter((f) => f.toLowerCase().endsWith('.whl'));
  } catch (e) {
    fail('문서 자동화 바퀴집을 읽지 못했습니다.', { wheelhouseDir: parts.wheelhouseDir, error: e.message });
  }
  if (wheelFiles.length === 0) {
    fail('문서 자동화 바퀴집이 비어 있어 설치할 수 없습니다.', { wheelhouseDir: parts.wheelhouseDir });
  }
  if (!parts.pyyamlWheel) {
    fail('PyYAML 부품을 찾지 못해 온톨로지 스크립트 환경을 완성할 수 없습니다.', { pyyamlWheel: parts.pyyamlWheel });
  }

  assertInside(root, parts.venvDir, { fs, cache });

  const recorded = {
    paths: {
      pythonExe: parts.pythonExe,
      uvExe: parts.uvExe,
      wheelhouseDir: parts.wheelhouseDir,
      venvDir: parts.venvDir,
      venvPython: parts.venvPython,
      pyyamlWheel: parts.pyyamlWheel,
    },
    counts: { wheelhouse: wheelFiles.length, expected: parts.expectedCount, installed: null },
    durations: {},
    venv: { created: false, kept: false, path: parts.venvDir },
    installSource: null,
    isolationCheck: { venvLeaks: [], runtimeYaml: { file: null, leaks: [] } },
    keyModules: { modules: KEY_MODULES, ok: false },
    pyyaml: { installed: false, kept: false, file: null },
  };

  // 1) venv: 없으면 만든다. 있고 개수가 기대치 이상이면 그대로 둔다(멱등).
  const venvT0 = Date.now();
  let created = false;
  if (!fs.existsSync(parts.venvPython)) {
    const r = await runLogged(ctx, parts.uvExe, ['venv', '--python', parts.pythonExe, parts.venvDir]);
    if (r.code !== 0) fail('문서 자동화 venv 를 만들지 못했습니다.', { code: r.code, out: r.out, err: r.err });
    created = true;
  }

  let installedCount = await probeInstalledCount(ctx, parts.uvExe, parts.venvPython);
  const want = parts.expectedCount ?? wheelFiles.length;
  let kept = !created && installedCount !== null && installedCount >= want;

  if (!kept) {
    const requirementsLock = locateRequirementsLock(fs, parts.wheelhouseDir);
    const installArgs = ['pip', 'install', '--python', parts.venvPython, '--offline', '--no-index', '--find-links', parts.wheelhouseDir];
    if (requirementsLock) {
      installArgs.push('-r', requirementsLock);
      recorded.installSource = 'requirements.lock';
    } else {
      installArgs.push(...wheelFiles.map((f) => path.join(parts.wheelhouseDir, f)));
      recorded.installSource = 'wheel-file-list';
    }
    const r = await runLogged(ctx, parts.uvExe, installArgs);
    if (r.code !== 0) fail('문서 자동화 패키지를 오프라인으로 설치하지 못했습니다.', { code: r.code, out: r.out, err: r.err });
    installedCount = await probeInstalledCount(ctx, parts.uvExe, parts.venvPython);
    if (installedCount === null || installedCount < want) {
      fail('문서 자동화 패키지 설치 개수가 기대보다 적습니다.', { installedCount, want });
    }
  } else {
    recorded.installSource = 'kept';
  }
  recorded.counts.installed = installedCount;
  recorded.venv = { created, kept, path: parts.venvDir };
  recorded.durations.venvMs = Date.now() - venvT0;

  // 2) venv 안 5개 핵심 모듈 임포트 + 격리 감사(한 번의 -c 로 함께)
  const importT0 = Date.now();
  // 2026-09-17 VM S01 5차 실측: 같은 손님·같은 부품인데 4차에서는 통과한 import 검사가
  // 5차에서는 실패했다(상세가 로그에 없어 무엇이 넘어졌는지도 몰랐다). 갓 풀어 놓은
  // .pyd/.dll 을 Defender 가 훑는 동안 잠깐 못 여는 일이 있다(`mcp` import 만 29초).
  // 그래서 ⓐ 실패 상세를 반드시 로그에 남기고 ⓑ 앱 제어 정책 차단이 아니면 30초 뒤
  // 두 번까지 다시 검사한다(세 번째도 실패면 진짜 실패).
  let importCheck = await runImportAndLeakCheck(ctx, parts.venvPython, root);
  for (let attempt = 1; !importCheck.ok && attempt <= 2 && !appControlBlocked(importCheck.detail); attempt += 1) {
    ctx.log(`[venv] import 검사 실패(${attempt}/3) — 30초 뒤 다시: ${JSON.stringify(importCheck.detail).slice(0, 600)}`);
    await new Promise((res) => setTimeout(res, 30000));
    importCheck = await runImportAndLeakCheck(ctx, parts.venvPython, root);
  }
  if (!importCheck.ok) {
    ctx.log(`[venv] import 검사 최종 실패: ${JSON.stringify(importCheck.detail).slice(0, 1500)}`);
    // 2026-09-16 실측: 스마트 앱 컨트롤(코드 무결성)이 동봉 파이썬의 .pyd 를 막으면 모든 모듈이
    // `DLL load failed … 애플리케이션 제어 정책에서 이 파일을 차단했습니다` 로 함께 넘어진다.
    // 그때 "핵심 모듈을 불러오지 못했습니다" 만으로는 사람이 무엇을 해야 하는지 알 수 없다.
    fail(appControlBlocked(importCheck.detail)
      ? '스마트 앱 컨트롤(앱 제어 정책)이 동봉 파이썬 부품을 차단해 문서 자동화 venv 를 만들지 못했습니다. 설정 › 개인 정보 및 보안 › Windows 보안 › 앱 및 브라우저 컨트롤 › 스마트 앱 컨트롤 설정을 「끄기」로 바꾼 뒤 「다시 시도」를 눌러 주세요.'
      : '문서 자동화 venv 에서 핵심 모듈을 불러오지 못했습니다.', importCheck.detail);
  }
  if (importCheck.leaks.length > 0) {
    fail('문서 자동화 venv 가 영혼 밖 다른 파이썬을 물어와 격리가 깨졌습니다.', { leaks: importCheck.leaks });
  }
  const soft = importCheck.soft ?? {};
  for (const [m, v] of Object.entries(soft)) {
    ctx.log(`[venv] ${m} 은(는) 불러오지 못했지만 설치는 계속합니다(이 PC 에 그 모듈이 기다리는 프로그램이 없을 때 정상 — checks 단계가 pending 으로 판정): ${String(v?.error ?? '').slice(0, 200)}`);
  }
  recorded.keyModules = { modules: KEY_MODULES, ok: true, soft };
  recorded.isolationCheck.venvLeaks = importCheck.leaks;
  recorded.durations.venvImportCheckMs = Date.now() - importT0;

  // 3) PyYAML 을 런타임에 (probe 먼저 -- unpack.mjs 가 이미 놓았으면 여기서는
  //    아무것도 설치하지 않는다. 없을 때만 uv 로 설치한다.)
  const pyyamlT0 = Date.now();
  let yamlProbe = await probeYaml(ctx, parts.pythonExe, root);
  if (!yamlProbe.ok) {
    const r = await runLogged(ctx, parts.uvExe, ['pip', 'install', '--python', parts.pythonExe, '--offline', '--no-index', parts.pyyamlWheel]);
    if (r.code !== 0) fail('PyYAML 을 런타임에 설치하지 못했습니다.', { code: r.code, out: r.out, err: r.err });
    yamlProbe = await probeYaml(ctx, parts.pythonExe, root);
    if (!yamlProbe.ok) fail('PyYAML 설치 후에도 불러오지 못했습니다.', yamlProbe.detail);
    recorded.pyyaml = { installed: true, kept: false, file: yamlProbe.file };
  } else {
    recorded.pyyaml = { installed: false, kept: true, file: yamlProbe.file };
  }
  if (yamlProbe.leaks.length > 0) {
    fail('런타임 PyYAML 이 영혼 밖 다른 파이썬을 물어와 격리가 깨졌습니다.', { file: yamlProbe.file, leaks: yamlProbe.leaks });
  }
  recorded.isolationCheck.runtimeYaml = { file: yamlProbe.file, leaks: yamlProbe.leaks };
  recorded.durations.pyyamlMs = Date.now() - pyyamlT0;

  recorded.durations.totalMs = Date.now() - t0;
  return { recorded, pending: [] };
}
