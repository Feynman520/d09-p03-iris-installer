// ⑤-1 풀기 + ⑤-2 심·환경변수 (설계-v2 6-2, 계약 v2 1·2단계)
//
// 이 파일 하나가 두 단계를 export 한다 — `run`(=unpack) 과 `runEnv`(=env).
// 계약 v2 표가 그렇게 정해 두었다(두 단계 모두 "부품이 어디에 놓였나"를 알아야
// 해서 배치표를 나눌 이유가 없다).
//
// ── 무엇을 어디에 놓나 ─────────────────────────────────────────────────────
// **경로를 여기에 박지 않는다.** 부품이 놓이는 자리는 잠금표(lock.json)의 `dest`
// 가 정한다(`docs\lock-schema.md` 4절). 이 파일이 들고 있는 것은 "그 자리에
// 어떻게 놓느냐"(압축인가 낱개 파일인가, 겉껍질을 몇 겹 벗기나, 놓은 뒤 무엇으로
// 확인하나)뿐이다 — 아래 `V2_LAYOUT`.
//
// ── ⑤-3 뼈대(skeleton)와의 분담 ────────────────────────────────────────────
// 둘 다 payload 를 영혼 안으로 옮기므로 경계를 한 줄로 못 박는다:
//
//   · **unpack(여기)** = 압축을 풀어야 하는 것 전부 + 도구·런타임 낱개 파일.
//     `_agent\shared\tools` · `_agent\shared\skills` · `_agent\claude\{scripts,tools}`
//     · `face\modules\messenger` 는 물론, **`_ontology`(setup\ontology.zip)** 와
//     **`_document-templates`(tools\hwpx-templates.zip)** 도 여기 몫이다 —
//     `setup\skeleton.mjs` 의 `fillOntology`·`fillDocumentTemplates` 가 "폴더 모양일
//     때만" 복사하고 압축은 "풀기 단계 몫"이라고 스스로 적어 두었기 때문이다.
//   · **skeleton(⑤-3)** = 영혼 루트에 그대로 놓이는 낱개 파일 두 개
//     (`IRIS-온톨로지.md`·`_cosmos.ico`, 잠금표 `dest: "/"`)와 그 사람의 표지·지침·
//     빈 폴더·미니 지침. 아래 `SKELETON_OWNED` 가 그 둘을 unpack 에서 빼 둔다.
//
// unpack 이 skeleton 보다 **먼저** 돌기 때문에(계약 v2 단계 순서 1 → 3) skeleton 은
// 이미 채워진 `_ontology`·`_document-templates` 를 만나고, "있으면 안 건드린다"
// 규칙대로 registry.yml·requirements.txt 만 더한다. 순서가 뒤집히면 둘 다 각자
// 만들어 충돌하므로 순서를 바꾸지 않는다.
//
// ── 절대 하지 않는 것 ──────────────────────────────────────────────────────
//   · 무엇도 지우지 않는다. 자리를 비워야 하면 `<slot>.prev` 로 **옮긴다**
//     (`lib\install.mjs` 의 `preserveAside`·`restorePart` 를 그대로 쓴다).
//   · 영혼 밖에 쓰지 않는다(`assertInside`). 예외는 ⑤-2 의 사용자 PATH·환경변수
//     뿐이고, 그것도 `IRIS_INSTALLER_NO_USER_ENV=1` 이면 건너뛴다.
//   · 두 번 돌리면 아무것도 쓰지 않는다(`_agent\setup\unpack-state.json` 대조).
import nodeFs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractZip, listArchive } from '../../lib/zip.mjs';
import { StageError } from '../lib/errors.mjs';
import { assertInside, ensureDir } from '../lib/paths.mjs';
import {
  preserveAside, restorePart, stripMotw, carryOver, defaultVerifiers,
} from '../lib/install.mjs';
import { writeShims, shimsDir } from '../lib/shims.mjs';
import { portableTeamclaudeConfigPath } from '../lib/login.mjs';
import { readReceipt, writeReceipt } from '../lib/receipt.mjs';
import { listHolders, listFileHolders, splitHolders, holdersText } from '../lib/holders.mjs';
import * as userpathDefault from '../lib/userpath.mjs';

export const id = 'unpack';
export const envId = 'env';

// ---------------------------------------------------------------------------
// 잠금표 읽기 — manifest 가 먼저, 없으면 lock
// ---------------------------------------------------------------------------

// `dest`·`entry`·`expectedCount` 는 잠금표에만 있는 필드이고 `file`·`version`·
// `sha256` 은 manifest 가 더 정확하다(빌드가 실제 파일에서 읽은 값). 그래서 둘 다
// 본다. 계약 v2 "모듈끼리 서로 import 하지 않는다" 때문에 adapters.mjs 의 같은
// 이름 헬퍼를 가져오지 않고 여기에 다시 둔다(4줄).
export function lockField(ctx, partId, field) {
  const fromManifest = ctx?.manifest?.parts?.[partId]?.[field];
  if (fromManifest !== undefined && fromManifest !== null) return fromManifest;
  const fromLock = ctx?.lock?.parts?.[partId]?.[field];
  return fromLock === undefined ? null : fromLock;
}

// `_agent/shared/tools/...`(슬래시) → `<root>\_agent\shared\tools\...`
// `"/"` = 영혼 루트 자체.
export function underRoot(root, rel) {
  if (rel === undefined || rel === null) return null;
  const clean = String(rel).replace(/^[\\/]+/, '');
  if (!clean || clean === '.') return root;
  return path.join(root, clean.split('/').join(path.sep));
}

// ---------------------------------------------------------------------------
// 배치표
// ---------------------------------------------------------------------------

// ⑤-3 뼈대가 직접 놓는 부품 = 잠금표 `dest: "/"` 인 낱개 파일. unpack 은 손대지
// 않는다(두 단계가 같은 파일을 쓰면 "두 번 실행 변경 0"이 깨진다).
export const SKELETON_OWNED = new Set(['ontology-spec', 'folder-icon']);

// 놓는 순서. 런타임이 먼저다 — 뒤 부품의 검증이 동봉 node·python 을 쓰고,
// `messenger` 는 `face` 의 설치기를 통해 들어가므로 face 뒤여야 한다.
// `manage` 는 `teamclaude` 와 **같은 폴더**를 dest 로 쓰는 낱개 파일이라 그 뒤에.
export const UNPACK_ORDER = [
  // 런타임
  'node', 'python', 'pyyaml', 'uv', 'age', 'git',
  // 에이전트·중계기·앱
  'codex', 'teamclaude', 'manage', 'dash', 'face', 'messenger', 'updater',
  // 도구
  'superpowers', 'self-improve', 'playwright-mcp', 'ui-ux-pro-max',
  'hwp-automation', 'excel-automation', 'ppt-automation', 'word-automation', 'pdf-automation',
  'document-mcp-wheelhouse', 'frontend-design', 'insane-search', 'gen-image',
  // 영혼 살림
  'hooks', 'hwpx-templates', 'ontology',
];

// kind:
//   archive    압축을 dest 에 푼다(`strip` = 겉껍질 벗길 겹수)
//   file       낱개 파일을 dest **폴더** 안에 원래 이름으로 놓는다
//   dir-files  payload 의 폴더 하나를 통째로(파일만) dest 에 복사한다(바퀴집)
//   module     Face 자신의 모듈 설치기에 zip 을 건넨다(서명·경로 검사 포함)
//
// mode:
//   'slot'   그 폴더 전체가 이 부품이다 → 바꿔 놓기 전에 `<dest>.prev` 로 옮긴다
//   'merge'  그 사람 것과 **섞여 사는** 폴더다(`_ontology`·`_document-templates`·
//            `_agent\claude\scripts`) → 폴더를 통째로 옮기면 그 사람 파일까지
//            딸려 가므로 절대 옮기지 않고, 설치기 소유 파일만 그 위에 푼다.
//
// after:
//   'hoist-wheel-scripts'  바퀴(.whl) 안 `*.data\scripts\*.exe` 를 dest 바로 밑으로
//                          한 벌 더 복사한다(uv.exe 경로를 판마다 예측 가능하게).
export const V2_LAYOUT = {
  node: { kind: 'archive', strip: 1, mode: 'slot' },
  python: { kind: 'archive', strip: 1, mode: 'slot' },
  // 바퀴를 python 의 site-packages 에 푼다. 이 부품"인" 것은 그 안의 `yaml`
  // 폴더뿐이므로 slot 을 좁힌다 — site-packages 를 통째로 옮기면 다른 부품의
  // 파일까지 사라진다(v1 install.mjs 의 같은 규칙).
  pyyaml: { kind: 'archive', strip: 0, mode: 'slot', slot: 'yaml' },
  uv: { kind: 'archive', strip: 0, mode: 'slot', after: 'hoist-wheel-scripts' },
  age: { kind: 'archive', strip: 1, mode: 'slot' },
  git: { kind: 'archive', strip: 0, mode: 'slot' },
  codex: { kind: 'archive', strip: 0, mode: 'slot' },
  teamclaude: { kind: 'archive', strip: 0, mode: 'slot' },
  manage: { kind: 'file', mode: 'merge' },
  dash: { kind: 'archive', strip: 0, mode: 'slot' },
  // `carryOver` = 그 사람 것이라 새 사본으로 옮겨 타야 하는 폴더(세션 카드·설정·
  // 설치한 모듈). v1 install.mjs 와 같은 목록이며 바꾸면 업데이터도 같이 고쳐야
  // 한다.
  face: { kind: 'archive', strip: 0, mode: 'slot', carryOver: ['state', 'modules'] },
  messenger: { kind: 'module', moduleName: 'messenger' },
  updater: { kind: 'archive', strip: 0, mode: 'slot' },
  superpowers: { kind: 'archive', strip: 0, mode: 'slot' },
  'self-improve': { kind: 'archive', strip: 0, mode: 'slot' },
  'playwright-mcp': { kind: 'archive', strip: 0, mode: 'slot' },
  'ui-ux-pro-max': { kind: 'archive', strip: 0, mode: 'slot' },
  'hwp-automation': { kind: 'archive', strip: 0, mode: 'slot' },
  'excel-automation': { kind: 'archive', strip: 0, mode: 'slot' },
  'ppt-automation': { kind: 'archive', strip: 0, mode: 'slot' },
  'word-automation': { kind: 'archive', strip: 0, mode: 'slot' },
  'pdf-automation': { kind: 'archive', strip: 0, mode: 'slot' },
  'document-mcp-wheelhouse': { kind: 'dir-files', mode: 'slot' },
  'frontend-design': { kind: 'archive', strip: 0, mode: 'slot' },
  'insane-search': { kind: 'archive', strip: 0, mode: 'slot' },
  'gen-image': { kind: 'file', mode: 'merge' },
  hooks: { kind: 'archive', strip: 0, mode: 'merge' },
  'hwpx-templates': { kind: 'archive', strip: 0, mode: 'merge' },
  ontology: { kind: 'archive', strip: 0, mode: 'merge' },
};

// 실제로 풀 부품 목록. 잠금표에 없는 것·`redistribute:"download"`(허가서상 동봉
// 못 하는 claude·document-skills)·뼈대 몫은 뺀다.
export function partsToUnpack(ctx) {
  const lockParts = ctx?.lock?.parts ?? {};
  const known = new Set([...UNPACK_ORDER, ...Object.keys(lockParts)]);
  const ordered = [
    ...UNPACK_ORDER.filter((p) => lockParts[p]),
    // 잠금표에 새 부품이 생겼는데 순서표에 없으면 맨 뒤에 붙인다(조용히 빠지는
    // 것보다 낫다 — 검사 ③이 "잠금표 전 부품이 놓였나"를 본다).
    ...Object.keys(lockParts).filter((p) => !UNPACK_ORDER.includes(p)),
  ];
  return ordered.filter((p) => {
    if (SKELETON_OWNED.has(p)) return false;
    if (!known.has(p)) return false;
    const redistribute = lockField(ctx, p, 'redistribute');
    return redistribute !== 'download';
  });
}

// ---------------------------------------------------------------------------
// 부품 정체(같은 것을 또 풀지 않기 위한 열쇠)
// ---------------------------------------------------------------------------

// 판이 있으면 판, 없으면 manifest 의 파일 지문(sha256), 그것도 없으면 dest 의
// 마지막 칸(커밋 짧은 해시가 거기 들어간다). 셋 다 없으면 null = "모름"이고,
// 모르는 것은 건너뛰지 않고 늘 다시 놓는다.
export function partIdentity(ctx, partId) {
  const version = lockField(ctx, partId, 'version');
  // document-mcp-wheelhouse 처럼 manifest 의 `file` 이 폴더(끝이 "/")라 부품
  // 하나에 지문 하나가 없는 경우, 잠금표의 지문(`requirements.lock` 다이제스트,
  // Task 24b #3)으로 대신한다 — 그래야 이 부품도 "바뀌었다"로 잡혀 venv 를
  // 다시 만든다.
  const sha256 = ctx?.manifest?.parts?.[partId]?.sha256 ?? lockField(ctx, partId, 'sha256') ?? null;
  const dest = lockField(ctx, partId, 'dest');
  const tail = dest ? String(dest).split('/').filter(Boolean).pop() : null;
  return { version: version ?? null, sha256, tail: tail ?? null };
}

function sameIdentity(a, b) {
  if (!a || !b) return false;
  if (a.sha256 && b.sha256) return a.sha256 === b.sha256;
  if (a.version && b.version) return a.version === b.version;
  if (a.tail && b.tail) return a.tail === b.tail;
  return false;
}

export function statePath(root) {
  return path.join(root, '_agent', 'setup', 'unpack-state.json');
}

function readState(fs, root) {
  try {
    return JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
  } catch {
    return { schema: 1, parts: {} };
  }
}

function writeState(fs, root, state) {
  const file = statePath(root);
  ensureDir(path.dirname(file), { fs });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// 검증기
// ---------------------------------------------------------------------------

function exists(fs, ...p) { return fs.existsSync(path.join(...p)); }

function countFiles(fs, dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    let entries;
    try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(here, e.name));
      else n += 1;
    }
  }
  return n;
}

// 실행 파일을 실제로 돌려 보는 검증. `ctx.run` 을 쓰므로 시험에서 가짜 주입이
// 된다. 판 문자열이 출력 어딘가에 있으면 통과(예: `git --version` 은
// `git version 2.55.0.windows.1`, 잠금표는 `2.55.0.5`).
function versionProbe(ctx, exe, args, wanted, { timeoutMs = 120000 } = {}) {
  return async () => {
    const fs = ctx.fs ?? nodeFs;
    if (!fs.existsSync(exe)) return { ok: false, detail: `${exe} 없음` };
    const runner = typeof ctx.run === 'function' ? ctx.run : null;
    if (!runner) return { ok: true, detail: `${path.basename(exe)} 존재(실행 검사 건너뜀)` };
    // .cmd·.bat 은 여기서 부르지 않는다: Node 18.20/20.12 의 CVE-2024-27980
    // 대응 이후 셸 없이 .cmd 를 spawn 하면 **동기적으로** EINVAL 을 던진다
    // (2026-09-15 실측). 그런 부품(codex)은 v1 install.mjs 의 cmd.exe 래퍼를
    // 쓰는 검증기를 그대로 빌려 쓴다 — 아래 v2Verifiers 참조.
    let r;
    try {
      r = await runner(exe, args, { timeoutMs, env: ctx.env });
    } catch (err) {
      return { ok: false, detail: `실행 실패: ${String(err?.message ?? err)}`.slice(0, 200) };
    }
    const text = `${r?.out ?? ''}\n${r?.err ?? ''}`;
    const ok = r?.code === 0 && (!wanted || text.includes(String(wanted)));
    return { ok, detail: (r?.out || r?.err || `exit ${r?.code}`).slice(0, 200) };
  };
}

// 압축 안 파일 수 = 놓인 파일 수. `git`·`dir` 부품처럼 실행해 볼 것이 없는
// 부품의 "전부 들어왔나" 검사다. manifest 의 `treeHash` 는 깃 트리 해시라
// 풀린 파일에서 다시 계산할 수 없어서(깃 배관 필요) 이 방식을 쓴다.
function archiveCountProbe(ctx, archive, dest, { strip = 0, atLeast = null } = {}) {
  return async () => {
    const fs = ctx.fs ?? nodeFs;
    const entries = await listArchive(archive);
    const files = entries.filter((e) => !e.endsWith('/'))
      .filter((e) => strip === 0 || e.split('/').filter(Boolean).length > strip);
    const placed = countFiles(fs, dest);
    const want = atLeast ?? files.length;
    if (files.length === 0) {
      // 목록을 못 읽었다(tar 실패). 파일이 하나라도 놓였는지만 본다.
      return { ok: placed > 0, detail: `압축 목록을 읽지 못함, 놓인 파일 ${placed}개` };
    }
    return { ok: placed >= want, detail: `놓인 파일 ${placed}개 / 압축 안 ${files.length}개` };
  };
}

/**
 * v2 검증기 표. `{ [partId]: async () => ({ok, detail}) }`
 *
 * 부품마다 "그게 정말 쓸 수 있는 상태인가"를 가장 싸게 증명하는 방법을 고른다:
 *   · 실행 파일이 있는 부품 → 실제로 `--version` 을 돌린다(node·python·git·codex)
 *   · 진입 파일이 잠금표에 있는 부품 → 그 파일이 있는지(playwright-mcp cli.js 등)
 *   · 그 외 압축 부품 → 압축 안 파일 수와 놓인 파일 수 대조
 * 중계기(teamclaude)는 **띄우지 않는다** — 3456 을 건드리지 않는다는 규칙이고,
 * 로그인 전에는 중계할 것도 없다.
 */
export function v2Verifiers(ctx) {
  const root = ctx.root;
  const fs = ctx.fs ?? nodeFs;
  const dest = (p) => underRoot(root, lockField(ctx, p, 'dest'));
  const want = (p) => lockField(ctx, p, 'version');
  const V = {};

  V.node = versionProbe(ctx, path.join(dest('node'), 'node.exe'), ['-v'], `v${want('node')}`);
  // standalone 배포판이라 `<dest>\python.exe` 가 바로 있다(임베드판과 달리
  // Lib\site-packages 가 처음부터 살아 있어 ._pth 손질이 필요 없다).
  V.python = versionProbe(ctx, path.join(dest('python'), 'python.exe'), ['-V'], want('python'));
  V.pyyaml = async () => {
    const py = path.join(dest('python'), 'python.exe');
    const probe = versionProbe(ctx, py, ['-c', 'import yaml; print(yaml.__version__)'], want('pyyaml'));
    return probe();
  };
  V.git = versionProbe(
    ctx,
    path.join(dest('git'), 'cmd', 'git.exe'),
    ['--version'],
    String(want('git')).split('.').slice(0, 3).join('.'),
  );
  // codex 는 npm 래퍼(`codex.cmd`)로만 부를 수 있고(플랫폼 실행파일 경로가
  // 판마다 바뀐다), .cmd 는 cmd.exe 를 거쳐야 한다. v1 install.mjs 가 이미 그
  // 래퍼(`runWrapper`: `cmd /d /s /c ""<경로>" --version"` + windowsVerbatim)를
  // 들고 있고 v2 의 codex dest 가 v1 과 같은 자리(`<tools>\codex`)라, 그 검증기를
  // **그대로 빌려 쓴다**(같은 코드를 두 벌 두지 않는다).
  V.codex = defaultVerifiers({ root, manifest: ctx.manifest, lock: ctx.lock }).codex;
  V.uv = async () => {
    const exe = path.join(dest('uv'), 'uv.exe');
    return { ok: fs.existsSync(exe), detail: exe };
  };
  V.age = async () => {
    const exe = path.join(dest('age'), 'age.exe');
    return { ok: fs.existsSync(exe), detail: exe };
  };
  V.teamclaude = async () => {
    const entry = path.join(dest('teamclaude'), 'node_modules', '@karpeleslab', 'teamclaude', 'src', 'index.js');
    return { ok: fs.existsSync(entry), detail: entry };
  };
  V.manage = async () => {
    const f = path.join(dest('manage'), 'teamclaude-manage.ps1');
    return { ok: fs.existsSync(f), detail: f };
  };
  V.dash = async () => {
    const d = dest('dash');
    const need = ['dashboard.html', 'launch.mjs', 'server.mjs', 'ensure-proxy.mjs', 'ensure-dash.mjs'];
    const gone = need.filter((f) => !exists(fs, d, f));
    return { ok: gone.length === 0, detail: gone.length ? `없음: ${gone.join(',')}` : need.join(',') };
  };
  V.face = async () => {
    const pkg = path.join(dest('face'), 'package.json');
    if (!fs.existsSync(pkg)) return { ok: false, detail: 'package.json 없음' };
    let version;
    try { version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version; } catch (e) { return { ok: false, detail: `package.json 읽기 실패: ${e.message}` }; }
    const wanted = want('face') ?? ctx?.manifest?.parts?.face?.version ?? null;
    if (wanted == null) return { ok: !!version, detail: `package.json=${version}(대조할 판이 manifest 에 없음)` };
    return { ok: String(version) === String(wanted), detail: `package.json=${version} 잠금표=${wanted}` };
  };
  V.messenger = async () => {
    const dir = dest('messenger');
    const info = path.join(dir, 'module.json');
    if (!fs.existsSync(info)) return { ok: false, detail: 'module.json 없음' };
    let mod;
    try { mod = JSON.parse(fs.readFileSync(info, 'utf8')); } catch (e) { return { ok: false, detail: `module.json 읽기 실패: ${e.message}` }; }
    const wanted = want('messenger');
    const official = fs.existsSync(path.join(dir, '.official'));
    const ok = mod.name === 'messenger' && (wanted == null || String(mod.version) === String(wanted)) && official;
    return { ok, detail: `name=${mod.name} version=${mod.version} 잠금표=${wanted} official=${official}` };
  };
  V.updater = async () => {
    const entry = path.join(dest('updater'), 'apply.mjs');
    if (!fs.existsSync(entry)) return { ok: false, detail: `${entry} 없음` };
    const text = fs.readFileSync(entry, 'utf8');
    const ok = text.includes('export async function applyPlan');
    return { ok, detail: ok ? entry : `${entry} 에 applyPlan 이 없음` };
  };
  V['document-mcp-wheelhouse'] = async () => {
    const d = dest('document-mcp-wheelhouse');
    let names = [];
    try { names = fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.whl')); } catch { /* 폴더 없음 */ }
    const wanted = lockField(ctx, 'document-mcp-wheelhouse', 'expectedCount')
      ?? ctx?.manifest?.parts?.['document-mcp-wheelhouse']?.wheelCount
      ?? null;
    const ok = wanted == null ? names.length > 0 : names.length === Number(wanted);
    return { ok, detail: `바퀴 ${names.length}개 / 기대 ${wanted ?? '미상'}개` };
  };
  V['gen-image'] = async () => {
    const f = path.join(dest('gen-image'), 'gen-image.py');
    let size = 0;
    try { size = fs.statSync(f).size; } catch { /* 없음 */ }
    return { ok: size > 0, detail: `${f} (${size} bytes)` };
  };
  V.hooks = async () => {
    const d = dest('hooks');
    const need = ['block-blanket-kill.ps1', 'guard-iris-path.py'];
    const gone = need.filter((f) => !exists(fs, d, f));
    return { ok: gone.length === 0, detail: gone.length ? `없음: ${gone.join(',')}` : need.join(',') };
  };
  V.ontology = async () => {
    const d = dest('ontology');
    const need = ['build_graph.py', 'validate.py', 'query.py', 'render_view.py', 'check_fresh.py'];
    const gone = need.filter((f) => !exists(fs, d, f));
    return { ok: gone.length === 0, detail: gone.length ? `없음: ${gone.join(',')}` : `${need.length}개 확인` };
  };
  V['hwpx-templates'] = async () => {
    const d = dest('hwpx-templates');
    let names = [];
    try { names = fs.readdirSync(d); } catch { /* 없음 */ }
    const hwpx = names.filter((f) => f.toLowerCase().endsWith('.hwpx')).length;
    const py = names.includes('iris_hwpx_layout.py');
    return { ok: hwpx > 0 && py, detail: `hwpx ${hwpx}개, iris_hwpx_layout.py=${py}` };
  };
  V.superpowers = async () => {
    const d = dest('superpowers');
    const skillsDir = path.join(d, 'skills');
    let skills = 0;
    try { skills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch { /* 없음 */ }
    const wanted = lockField(ctx, 'superpowers', 'expectedSkillCount');
    const ok = wanted == null ? skills > 0 : skills >= Number(wanted);
    return { ok, detail: `스킬 폴더 ${skills}개 / 기대 ${wanted ?? '미상'}개` };
  };

  return V;
}

// 표에 없는 부품의 기본 검증기: 잠금표 `entry` 가 있으면 그 파일, 없으면
// 압축 안 파일 수 대조.
function fallbackVerifier(ctx, partId, { archive, dest, strip }) {
  const fs = ctx.fs ?? nodeFs;
  const entry = lockField(ctx, partId, 'entry');
  if (entry) {
    const f = path.join(dest, String(entry).split('/').join(path.sep));
    return async () => ({ ok: fs.existsSync(f), detail: f });
  }
  if (archive) return archiveCountProbe(ctx, archive, dest, { strip });
  return async () => ({ ok: fs.existsSync(dest), detail: dest });
}

// ---------------------------------------------------------------------------
// ⑤-1 풀기
// ---------------------------------------------------------------------------

export async function run(ctx) {
  const fs = ctx?.fs ?? nodeFs;
  const root = ctx?.root;
  if (!root) throw new StageError('E-UNPACK', '설치 폴더 경로가 없어 부품을 풀 수 없습니다.', { ctx: 'root' });
  if (!ctx?.payloadDir) throw new StageError('E-UNPACK', '꾸러미(payload) 위치를 몰라 부품을 풀 수 없습니다.', { ctx: 'payloadDir' });
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};
  const progress = typeof ctx.progress === 'function' ? ctx.progress : () => {};
  const rel = (p) => path.relative(root, p).split(path.sep).join('\\') || '.';

  const parts = partsToUnpack(ctx);
  if (parts.length === 0) {
    throw new StageError('E-UNPACK', '잠금표에서 설치할 부품을 하나도 찾지 못했습니다.', { lockParts: Object.keys(ctx?.lock?.parts ?? {}).length });
  }

  const linkCache = new Map();
  const state = readState(fs, root);
  state.parts = state.parts ?? {};
  const verifiers = ctx.verifiers ?? v2Verifiers(ctx);

  const recorded = {
    total: parts.length,
    placed: [],
    skipped: [],
    moved: [],
    motw: 0,
    parts: {},
    downloadLater: Object.keys(ctx?.lock?.parts ?? {}).filter((p) => lockField(ctx, p, 'redistribute') === 'download'),
    skeletonOwned: [...SKELETON_OWNED].filter((p) => ctx?.lock?.parts?.[p]),
  };
  const pending = [];

  ensureDir(root, { fs });

  // 2026-09-17 실제 사용자 실측(2.0.4): 이전 설치가 띄운 우리 프로그램(한도 화면 서버)이
  // `tools\teamclaude-dash` 를 붙잡고 있어 아홉 번째 부품에서 EBUSY 로 섰고, 「다시 시도」로는
  // 풀리지 않았다. 그래서 **아무것도 옮기기 전에** 실제로 바꿀 부품이 하나라도 있고 그 폴더에서
  // 도는 우리 프로그램이 있으면 그 목록과 함께 멈춘다 — 화면이 「IRIS 프로그램 닫고 다시 시도」를
  // 내민다. 바꿀 부품이 없으면(같은 판 재실행·이어하기) 프로그램이 돌고 있어도 막지 않는다.
  const willPlace = parts.filter((partId) => {
    const layout = V2_LAYOUT[partId] ?? { kind: 'archive', strip: 0, mode: 'slot' };
    const destRel = lockField(ctx, partId, 'dest');
    if (!destRel) return true;
    const dest = underRoot(root, destRel);
    const slot = layout.slot ? path.join(dest, layout.slot) : dest;
    const prior = state.parts[partId];
    return !(prior?.verified && sameIdentity(prior.identity, partIdentity(ctx, partId)) && fs.existsSync(slot));
  });
  const procs = ctx.processes ?? {
    list: (r) => listHolders(r, { run: ctx.run }),
    files: (dir) => listFileHolders(dir, { run: ctx.run }),
  };
  const holders = willPlace.length > 0 ? await procs.list(root) : [];
  if (holders.length > 0) {
    log(`[unpack] 설치 폴더에서 도는 우리 프로그램 ${holders.length}개: ${holdersText(holders)}`);
    throw new StageError(
      'E-UNPACK',
      `설치 폴더의 IRIS 프로그램 ${holders.length}개가 아직 실행 중이라 부품을 바꿀 수 없습니다: ${holdersText(holders)}. 「IRIS 프로그램 닫고 다시 시도」를 누르거나, PC 를 다시 시작한 뒤 「다시 시도」를 눌러 주세요.`,
      { holders, willPlace },
    );
  }

  for (let i = 0; i < parts.length; i += 1) {
    const partId = parts[i];
    const layout = V2_LAYOUT[partId] ?? { kind: 'archive', strip: 0, mode: 'slot' };
    const destRel = lockField(ctx, partId, 'dest');
    if (!destRel) {
      throw new StageError('E-UNPACK', `부품 "${partId}" 이(가) 어디로 가야 하는지 잠금표에 없습니다.`, { part: partId });
    }
    const dest = assertInside(root, underRoot(root, destRel), { fs, cache: linkCache });
    const slot = layout.slot ? path.join(dest, layout.slot) : dest;

    progress({ done: i, total: parts.length, label: partId });

    const identity = partIdentity(ctx, partId);
    const prior = state.parts[partId];
    // 낱개 파일 부품(manage 등)은 폴더가 아니라 **그 파일**이 있어야 건너뛴다(2.0.30). 같은 폴더를 쓰는 다른 부품(teamclaude)이
    // 이번 업데이트에서 폴더째 새로 놓이면 파일은 사라졌는데 폴더만 보고 건너뛰어, 중계기 시작 스크립트 없이 남았다
    // (2026-09-20 데스크탑: 2.0.29 = 중계기 부품이 바뀐 첫 업데이트 → 그 뒤 대시보드 "프록시에 연결할 수 없음").
    const presence = layout.kind === 'file'
      ? path.join(dest, path.basename(String(lockField(ctx, partId, 'file') ?? '')))
      : slot;
    if (prior?.verified && sameIdentity(prior.identity, identity) && fs.existsSync(presence)) {
      recorded.skipped.push(partId);
      recorded.parts[partId] = { ...prior, skipped: true };
      progress({ done: i + 1, total: parts.length, label: partId });
      continue;
    }

    const fileRel = lockField(ctx, partId, 'file');
    const source = fileRel ? path.join(ctx.payloadDir, String(fileRel).split('/').join(path.sep)) : null;
    if (!source || !fs.existsSync(source)) {
      throw new StageError(
        'E-UNPACK',
        `꾸러미 안에 부품 "${partId}" 이(가) 없습니다.`,
        { part: partId, source: source ?? null },
      );
    }

    // 자리 비우기. 'merge' 폴더는 그 사람 것과 섞여 살기 때문에 절대 옮기지
    // 않는다(옮기면 그 사람 파일이 `.prev` 로 끌려간다).
    let moved = null;
    // 2026-09-17 실제 사용자 실측(2.0.2): 이 이름 바꾸기가 던진 예외가 try 밖이라 "예상치
    // 못한 오류"로만 보였다. 옛 사본을 옆으로 옮기지 못한 것은 거의 언제나 **다른 프로그램이
    // 그 폴더를 붙잡고 있는 것**(옛 설치 서버·IRIS 창·터미널·백신)이라 그 사실을 문장으로 말한다.
    const aside = typeof ctx.preserveAside === 'function' ? ctx.preserveAside : preserveAside;
    const setAside = async (target) => {
      try {
        return aside(target);
      } catch (err) {
        const codeText = err?.code ? `(${err.code})` : '';
        // 누가 붙잡고 있는지 찾아 문장에 넣는다: ① 우리 폴더에서 도는 프로그램(닫아 줄 수 있음)
        // ② 그 폴더의 파일을 연 **어떤** 프로그램이든(Restart Manager; 탐색기·백신·동기화 도구 —
        //    사람이 닫아야 함). 2026-09-17 실측: 재부팅 뒤에도 EBUSY 인데 ①은 비어 있던 사례.
        let ours = [];
        let theirs = [];
        try { ours = await procs.list(root); } catch { ours = []; }
        try {
          const fileHolders = typeof procs.files === 'function' ? await procs.files(target) : [];
          const split = splitHolders(root, fileHolders);
          const seen = new Set(ours.map((h) => h.pid));
          for (const h of split.ours) if (!seen.has(h.pid)) ours.push(h);
          theirs = split.theirs;
        } catch { theirs = []; }
        const who = [
          ours.length ? `IRIS 프로그램 ${holdersText(ours)} 이(가) 돌고 있습니다(「IRIS 프로그램 닫고 다시 시도」).` : '',
          theirs.length ? `다른 프로그램 ${holdersText(theirs)} 이(가) 그 폴더의 파일을 열어 놓았습니다 — 그 프로그램을 닫은 뒤 「다시 시도」를 눌러 주세요.` : '',
          !ours.length && !theirs.length ? '그 폴더를 탐색기 창으로 열어 두었다면 닫고, 백신이 검사 중이면 잠시 뒤 「다시 시도」를 눌러 주세요. 그래도 같으면 PC 를 다시 시작한 뒤 다시 시도해 주세요.' : '',
        ].filter(Boolean).join(' ');
        throw new StageError(
          'E-UNPACK',
          `옛 부품 폴더 "${rel(target)}" 을(를) 옆으로 옮기지 못했습니다${codeText}. ${who}`,
          { part: partId, slot: rel(target), error: String(err?.message ?? err), code: err?.code ?? null, holders: ours, blockers: theirs },
        );
      }
    };
    // 2.0.34(2026-09-21 사용자 실측 "메신저 모듈이 2개·삭제 불가·헤더 느낌표"): 'module' 부품은 옆으로 옮기지 않는다.
    // Face 의 installZip 이 스스로 교체하며 옛 사본의 state(로그인·열쇠)를 새 사본으로 옮긴다. 여기서 옮겨 두면
    // `face\modules\messenger.prev` 가 modules\ 안에 남아 Face 가 두 번째 모듈(맞지 않음, 이름 규칙 밖이라 제거도 안 됨)로
    // 보이고, 새 사본은 state 없이 시작해 로그인이 날아갔다(2.0.x 업데이트마다 .prev-N 이 하나씩 늘었다).
    if (layout.kind === 'module') moved = null;
    else if (layout.mode !== 'merge') moved = await setAside(slot);
    else if (layout.kind === 'file') {
      // 낱개 파일은 그 파일만 옮긴다(폴더가 아니라).
      const target = path.join(dest, path.basename(source));
      if (fs.existsSync(target) && !sameBytes(fs, source, target)) moved = await setAside(target);
    }

    try {
      await placePart(ctx, { partId, layout, source, dest, fs, log });

      // MotW(다른 컴퓨터에서 받아 온 표식) 제거. 남아 있으면 첫 실행에서
      // SmartScreen 이 node.exe·electron.exe 를 막는다.
      recorded.motw += stripMotw(layout.kind === 'file' ? path.join(dest, path.basename(source)) : slot);

      const verify = verifiers[partId] ?? fallbackVerifier(ctx, partId, { archive: source, dest, strip: layout.strip ?? 0 });
      const result = await verify();

      // 그 사람의 폴더는 **검증을 통과한 뒤에** 새 사본으로 옮겨 탄다. 그 전에
      // 옮기면 되돌리기(restorePart)가 그 사람 자료를 지우는 일이 된다.
      let carried = [];
      let carryFailed = [];
      if (result.ok && moved && layout.carryOver) {
        ({ carried, failed: carryFailed } = carryOver(moved, slot, layout.carryOver));
      }

      const info = {
        identity,
        dest: rel(dest),
        verified: !!result.ok,
        detail: result.detail ?? null,
        ...(moved ? { previous: rel(moved) } : {}),
        ...(layout.carryOver ? { carried, carryFailed: carryFailed.length ? carryFailed : null } : {}),
      };
      state.parts[partId] = { ...info, at: new Date().toISOString() };
      writeState(fs, root, state);
      recorded.parts[partId] = info;
      if (moved) recorded.moved.push({ part: partId, previous: rel(moved) });

      if (!result.ok) {
        // 새 사본이 **있지만 잘못됐다**. 옛 사본은 일부러 `.prev` 에 그대로 둔다
        // — 어느 쪽을 살릴지는 두 벌을 다 보고 사람이 정할 일이다.
        throw new StageError(
          'E-UNPACK',
          `부품 "${partId}" 을(를) 놓았지만 확인에 실패했습니다.`,
          { part: partId, detail: result.detail ?? null, dest: rel(dest) },
        );
      }

      recorded.placed.push(partId);
      log(`[unpack] ${partId} → ${rel(dest)} (${result.detail ?? 'ok'})`);
      progress({ done: i + 1, total: parts.length, label: partId });
    } catch (err) {
      if (err instanceof StageError) throw err;
      // 쓸 만한 사본이 나오지도 못했다(압축이 깨졌거나 Face 모듈 설치기가
      // 거절했거나). 옛 사본을 제 이름으로 되돌려 두고 멈춘다.
      // 'module' 은 installZip 이 실패 때 옛 사본을 스스로 되돌린다 — 여기서 restorePart 를 부르면(moved=null) 멀쩡한 옛 모듈을 지운다.
      const restore = (layout.mode === 'merge' || layout.kind === 'module') ? { restored: false } : restorePart(slot, moved);
      state.parts[partId] = {
        identity, dest: rel(dest), verified: false,
        detail: String(err?.message ?? err),
        priorExisted: moved !== null,
        priorRestored: !!restore.restored,
        at: new Date().toISOString(),
      };
      writeState(fs, root, state);
      log(`[unpack] ${partId} 실패: ${String(err?.message ?? err)}`);
      throw new StageError(
        'E-UNPACK',
        `부품 "${partId}" 을(를) 푸는 중 문제가 생겼습니다.`,
        { part: partId, error: String(err?.message ?? err), priorRestored: !!restore.restored },
      );
    }
  }

  log(`[unpack] 부품 ${recorded.placed.length}개 놓음, ${recorded.skipped.length}개 그대로(같은 판), MotW ${recorded.motw}개 제거`);
  return { recorded, pending };
}

function sameBytes(fs, a, b) {
  try {
    const x = fs.readFileSync(a);
    const y = fs.readFileSync(b);
    return x.length === y.length && x.equals(y);
  } catch {
    return false;
  }
}

async function placePart(ctx, { partId, layout, source, dest, fs, log }) {
  if (layout.kind === 'archive') {
    ensureDir(dest, { fs });
    await extractZip(source, dest, { strip: layout.strip ?? 0 });
    if (layout.after === 'hoist-wheel-scripts') hoistWheelScripts(fs, dest);
    return;
  }
  if (layout.kind === 'file') {
    ensureDir(dest, { fs });
    const target = path.join(dest, path.basename(source));
    if (!fs.existsSync(target) || !sameBytes(fs, source, target)) {
      fs.copyFileSync(source, target);
    }
    return;
  }
  if (layout.kind === 'dir-files') {
    // payload 의 폴더 하나(바퀴집)를 파일만 복사한다. 이미 같은 바이트가 있으면
    // 건드리지 않는다("두 번 실행 변경 0").
    ensureDir(dest, { fs });
    const names = fs.readdirSync(source, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    for (const name of names) {
      const from = path.join(source, name);
      const to = path.join(dest, name);
      if (fs.existsSync(to) && sameBytes(fs, from, to)) continue;
      fs.copyFileSync(from, to);
    }
    return;
  }
  if (layout.kind === 'module') {
    // Face 자신의 모듈 설치기에 맡긴다 — 설정 서랍에서 모듈을 넣을 때와 **같은**
    // 경로·manifest·서명 검사를 거치게 하려는 것이다. face 가 먼저 놓여 있어야
    // 한다(UNPACK_ORDER 가 보장).
    const faceDir = path.dirname(path.dirname(dest)); // <…>\face\modules\<name> → <…>\face
    const modinstall = path.join(faceDir, 'daemon', 'modinstall.mjs');
    if (!fs.existsSync(modinstall)) throw new Error(`${modinstall} 없음 (face 가 먼저 설치돼야 한다)`);
    const faceVersion = JSON.parse(fs.readFileSync(path.join(faceDir, 'package.json'), 'utf8')).version;
    const { installZip } = await import(pathToFileURL(modinstall).href);
    const modulesDir = path.dirname(dest);
    ensureDir(modulesDir, { fs });
    // 옛 판(≤2.0.33)이 남긴 `<name>.prev(-N)` 을 거둔다 — state 는 물려주고 폴더는 modules\ 밖으로(무삭제).
    const salvaged = salvageModulePrev(fs, modulesDir, layout.moduleName);
    if (salvaged.moved.length) log(`[unpack] ${partId} 옛 .prev 폴더 ${salvaged.moved.length}개 → modules-prev\\ (state ${salvaged.stateRestored ? '물려줌' : '그대로'})`);
    const r = installZip(fs.readFileSync(source), { modulesDir, faceVersion });
    if (r.name !== layout.moduleName) throw new Error(`zip 이 "${r.name}" 모듈을 설치한다(기대: "${layout.moduleName}")`);
    log(`[unpack] ${partId} 모듈 ${r.name} v${r.version} official=${r.official}`);
    return;
  }
  throw new Error(`알 수 없는 배치 종류 ${layout.kind}`);
}

/**
 * 2.0.34: ≤2.0.33 업데이트가 `face\modules\<name>.prev(-N)` 을 남겼다(모듈 부품을 slot 처럼 옆으로 옮긴 뒤 installZip 이 새로 놓음).
 * Face 는 modules\ 의 모든 하위 폴더를 모듈로 읽으므로 그것이 "두 번째 모듈(맞지 않음·제거 불가)"로 보였고, 새 사본은 state 없이 시작했다.
 *  ① 현재 `<name>\state` 가 없고 가장 최근 .prev 에 state 가 있으면 그 state 를 현재 사본으로 옮긴다(로그인·열쇠 복구; 이어지는 installZip 이 새 사본으로 다시 옮긴다).
 *  ② .prev 폴더들은 `face\modules-prev\` 로 옮긴다 — 지우지 않는다(무삭제). Face 는 modules\ 바깥을 보지 않는다.
 * @returns {{ moved: string[], stateRestored: boolean }}
 */
export function salvageModulePrev(fs, modulesDir, name) {
  const out = { moved: [], stateRestored: false };
  let entries = [];
  try { entries = fs.readdirSync(modulesDir); } catch { return out; }
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.prev(-\\d+)?$`);
  const prevs = entries.filter((e) => re.test(e)).map((e) => {
    const p = path.join(modulesDir, e);
    let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch {}
    return { name: e, path: p, mtime };
  }).filter((x) => { try { return fs.statSync(x.path).isDirectory(); } catch { return false; } })
    .sort((a, b) => b.mtime - a.mtime);
  if (!prevs.length) return out;
  const cur = path.join(modulesDir, name);
  const curState = path.join(cur, 'state');
  const prevState = path.join(prevs[0].path, 'state');
  if (fs.existsSync(cur) && !fs.existsSync(curState) && fs.existsSync(prevState)) {
    try { fs.renameSync(prevState, curState); out.stateRestored = true; } catch { /* 못 옮기면 .prev 안에 그대로 남는다(무삭제) */ }
  }
  const archive = path.join(path.dirname(modulesDir), 'modules-prev');
  for (const p of prevs) {
    try {
      fs.mkdirSync(archive, { recursive: true });
      let target = path.join(archive, p.name);
      for (let n = 2; fs.existsSync(target); n++) target = path.join(archive, `${p.name}-${n}`);
      fs.renameSync(p.path, target);
      out.moved.push(p.name);
    } catch { /* 붙잡혀 있으면 다음 업데이트 때 다시 시도된다 */ }
  }
  return out;
}

// 바퀴(.whl) 안 `<이름>.data\scripts\*.exe` 를 dest 바로 밑으로 한 벌 더 놓는다.
// uv 는 판마다 폴더 이름이 달라지므로(`uv-0.12.14.data`) 그대로 두면 ⑤-5 venv
// 단계와 shim 이 실행 파일 경로를 판 문자열로 조립해야 한다. 원본은 지우지 않고
// 복사만 한다(무삭제).
function hoistWheelScripts(fs, dest) {
  let names = [];
  try { names = fs.readdirSync(dest); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!/\.data$/i.test(name)) continue;
    const scripts = path.join(dest, name, 'scripts');
    let files = [];
    try { files = fs.readdirSync(scripts); } catch { continue; }
    for (const f of files) {
      const from = path.join(scripts, f);
      const to = path.join(dest, f);
      if (fs.existsSync(to) && sameBytes(fs, from, to)) continue;
      fs.copyFileSync(from, to);
      n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// ⑤-2 심·환경변수
// ---------------------------------------------------------------------------

export const RELAY_BASE_URL = 'http://127.0.0.1:3456';

// uv 는 판이 폴더 이름에 들어가는(`uv\0.12.14`) 유일한 shim 이라 `lib\shims.mjs`
// 의 고정 템플릿에 넣을 수 없다. 여기서 만든다 — 규칙은 같다: **ASCII·CRLF**,
// 전부 `%~dp0` 상대(영혼 폴더를 옮겨도 살아 있게).
export function uvShimText(relFromTools) {
  return [
    '@echo off',
    'setlocal',
    `"%~dp0..\\tools\\${relFromTools}\\uv.exe" %*`,
    'exit /b %errorlevel%',
  ].join('\r\n') + '\r\n';
}

// 자식 프로세스용 PATH 앞자리. 순서가 곧 우선순위다 — shim 이 맨 앞이라
// `claude`·`codex`·`python` 이 늘 이 영혼 것으로 잡힌다.
export function childPathPrefix(root) {
  const tools = path.join(root, '_agent', 'shared', 'tools');
  return [
    shimsDir(root),
    path.join(tools, 'node'),
    path.join(tools, 'git', 'cmd'),
    path.join(tools, 'python'),
    path.join(tools, 'python', 'Scripts'),
  ];
}

export async function runEnv(ctx) {
  const fs = ctx?.fs ?? nodeFs;
  const root = ctx?.root;
  if (!root) throw new StageError('E-ENV', '설치 폴더 경로가 없어 환경을 준비할 수 없습니다.', { ctx: 'root' });
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};
  const rel = (p) => path.relative(root, p).split(path.sep).join('\\') || '.';
  const linkCache = new Map();

  const claudeCfg = assertInside(root, path.join(root, '_agent', 'claude'), { fs, cache: linkCache });
  const codexHome = assertInside(root, path.join(root, '_agent', 'codex'), { fs, cache: linkCache });
  const dir = assertInside(root, shimsDir(root), { fs, cache: linkCache });
  ensureDir(claudeCfg, { fs });
  ensureDir(codexHome, { fs });
  ensureDir(dir, { fs });

  const recorded = {
    shimsDir: rel(dir),
    shims: [],
    vars: {},
    userEnv: { applied: false, skippedReason: null, pathAdded: false, previous: {} },
    env: null,
  };
  const pending = [];

  // ── 심 ────────────────────────────────────────────────────────────────
  // 양쪽 에이전트 항상(D2-17): 구독을 하나만 골랐어도 나중에 하나 더 붙일 때
  // 심이 이미 있어야 한다. 다만 **claude 심은 가리킬 것이 있을 때만** 쓴다 —
  // Claude Code 는 허가서상 동봉하지 못해 ⑥-2(online)이 내려받아
  // `_agent\shared\tools\claude\<판>\claude.exe` 와 그 앞의 `claude.cmd` 를
  // 만든다. 그전에 심을 써 두면 "명령은 있는데 실행이 안 되는" 상태가 된다.
  const toolsDir = path.join(root, '_agent', 'shared', 'tools');
  const claudeVersion = lockField(ctx, 'claude', 'version');
  const claudeExe = claudeVersion
    ? path.join(toolsDir, 'claude', String(claudeVersion), lockField(ctx, 'claude', 'binName') ?? 'claude.exe')
    : null;
  const claudeCmd = path.join(toolsDir, 'claude', 'claude.cmd');
  const claudeReady = (claudeExe && fs.existsSync(claudeExe)) || fs.existsSync(claudeCmd);

  const agents = ['codex'];
  if (claudeReady) agents.unshift('claude');
  else {
    pending.push({ capability: 'Claude Code 명령(claude)', reason: '온라인 단계에서 내려받은 뒤 심이 만들어집니다' });
    recorded.claudeShim = { written: false, expectedExe: claudeExe ? rel(claudeExe) : null };
  }

  let shims;
  try {
    shims = writeShims(root, agents);
  } catch (err) {
    throw new StageError('E-ENV', '명령 바로가기(shim)를 만들지 못했습니다.', { error: String(err?.message ?? err) });
  }
  recorded.shims = shims.written.map((f) => path.basename(f));
  if (claudeReady) recorded.claudeShim = { written: true, expectedExe: claudeExe ? rel(claudeExe) : null };

  // uv 심(판 폴더라 여기서 만든다)
  const uvDest = lockField(ctx, 'uv', 'dest');
  if (uvDest) {
    const relFromTools = String(uvDest).replace(/^_agent\/shared\/tools\//, '').split('/').join('\\');
    const uvCmd = path.join(dir, 'uv.cmd');
    const text = uvShimText(relFromTools);
    if (!fs.existsSync(uvCmd) || fs.readFileSync(uvCmd, 'ascii') !== text) {
      fs.writeFileSync(uvCmd, text, 'ascii');
    }
    recorded.shims.push('uv.cmd');
  }

  // ── 환경변수 ──────────────────────────────────────────────────────────
  // `TEAMCLAUDE_CONFIG` = 이 영혼 안의 중계기 설정 파일(⑤-7 relay 가 만드는 바로
  // 그 파일). 계약 v2 표에는 앞의 세 개만 적혀 있지만 **네 번째가 반드시 있어야
  // 한다**(2026-09-15 검토 지적): `lib\login.mjs` 의 resolveTeamclaudeConfigPath
  // 는 영수증 `env.teamclaudeConfig` 를 1순위로 읽고, P02 Face 의
  // `daemon\wake.mjs` 는 폴백 없이 그 값만 본다. 없으면 로그인·중계기가
  // `%USERPROFILE%\.config\teamclaude.json`(= 이 개발 PC의 진짜 계정 파일)을
  // 건드리게 된다. v1 `install.mjs` 가 같은 값을 같은 자리에 적었다.
  const teamclaudeConfig = portableTeamclaudeConfigPath(root);
  const vars = {
    CLAUDE_CONFIG_DIR: claudeCfg,
    CODEX_HOME: codexHome,
    ANTHROPIC_BASE_URL: RELAY_BASE_URL,
    TEAMCLAUDE_CONFIG: teamclaudeConfig,
  };
  recorded.vars = { ...vars };

  // 연습(이 개발 PC)에서는 진짜 사용자 PATH·환경변수를 건드리지 않는다.
  const noUserEnv = (ctx.env?.IRIS_INSTALLER_NO_USER_ENV ?? process.env.IRIS_INSTALLER_NO_USER_ENV) === '1';
  const userpath = ctx.userpath ?? userpathDefault;
  if (noUserEnv) {
    recorded.userEnv = { applied: false, skippedReason: 'IRIS_INSTALLER_NO_USER_ENV=1', pathAdded: false, previous: {} };
    log('[env] IRIS_INSTALLER_NO_USER_ENV=1 — 사용자 PATH·환경변수는 건드리지 않음(기록만)');
  } else {
    try {
      const pathResult = await userpath.addUserPath(dir);
      recorded.userEnv.pathAdded = !!pathResult.changed;
      for (const [key, value] of Object.entries(vars)) {
        const r = await userpath.setUserEnv(key, value);
        if (r?.previous != null) recorded.userEnv.previous[key] = r.previous;
      }
      // 2.0.35: 로그온 자동 시작 — 중계기(3456)가 IRIS 창을 열지 않아도 떠 있게(어느 터미널에서나 claude/codex 가 되게).
      // 실패는 설치를 막지 않는다(기록만). 심 자체도 실행 때 중계기를 확인·기동하므로 이것은 두 번째 안전망이다.
      if (typeof userpath.setRunKey === 'function') {
        const vbs = path.join(dir, 'relay-autostart.vbs');
        try {
          const r = await userpath.setRunKey('IRIS relay', `wscript.exe //nologo "${vbs}"`);
          recorded.userEnv.autostart = { name: 'IRIS relay', changed: !!r?.changed, ...(r?.previous ? { previous: r.previous } : {}) };
        } catch (err) {
          recorded.userEnv.autostart = { name: 'IRIS relay', changed: false, error: String(err?.message ?? err) };
          log(`[env] 로그온 자동 시작 등록 실패(계속 진행): ${String(err?.message ?? err)}`);
        }
      }
      recorded.userEnv.applied = userpath?.recording !== true;
      if (!recorded.userEnv.applied) recorded.userEnv.skippedReason = userpath?.skippedReason ?? 'recording';
    } catch (err) {
      throw new StageError('E-ENV', '사용자 PATH·환경변수를 설정하지 못했습니다.', { error: String(err?.message ?? err) });
    }
  }

  // ── 뒤 단계용 환경 ────────────────────────────────────────────────────
  // ⑤-5 venv·⑤-8 온톨로지·⑤-9 검사는 동봉 python·git·node 를 써야 한다. 새
  // 프로세스는 만들어질 때 한 번만 HKCU\Environment 를 읽으므로(방금 쓴 값이
  // 이 설치기 프로세스에는 보이지 않는다) **자식용 env 를 여기서 만들어 넘긴다.**
  // 계약상 ctx 는 단계가 바꾸지 않는 물건이라, 새 env 를 `recorded.env` 로
  // 돌려주고 ctx.env 가 고쳐 쓸 수 있는 평범한 객체일 때만 제자리에서 갱신한다
  // (엔진 T18 이 `recorded.env` 를 받아 다음 단계 ctx 에 넣으면 그쪽이 정본).
  const basePath = ctx.env?.PATH ?? ctx.env?.Path ?? process.env.PATH ?? '';
  const childEnv = {
    ...(ctx.env ?? process.env),
    ...vars,
    PATH: [...childPathPrefix(root), basePath].filter(Boolean).join(';'),
  };
  delete childEnv.Path; // 윈도는 대소문자를 안 가리지만 두 키가 같이 있으면 헷갈린다
  recorded.env = { PATH: childEnv.PATH, ...vars };
  if (ctx.env && typeof ctx.env === 'object' && ctx.env !== process.env) {
    try { Object.assign(ctx.env, { ...vars, PATH: childEnv.PATH }); } catch { /* 얼린 객체면 recorded.env 가 정본 */ }
  }

  // ── 영수증 `env` (v1 install.mjs 와 같은 자리·같은 모양) ───────────────
  // 이것은 엔진이 쓰는 `receipt.setup.<단계>` 와 **다른 최상위 칸**이다. 계약은
  // 단계가 `setup[id]` 를 직접 쓰지 못하게 할 뿐이고, `env` 는 v1 때부터
  // 설치기가 "어디에 무엇을 걸어 두었는가"를 적어 온 자리다. 여기에 값이 없으면
  //   · `lib\login.mjs resolveTeamclaudeConfigPath` 가 사용자 홈의 진짜 계정
  //     파일로 떨어지고(⑥-3 로그인·⑥-4 중계기가 남의 설정을 건드린다)
  //   · P02 Face 의 `daemon\wake.mjs` 는 폴백이 없어 세션에 값을 못 넘긴다.
  recorded.receiptEnv = writeReceiptEnv(ctx, {
    root,
    claudeCfg,
    codexHome,
    teamclaudeConfig,
    shims: dir,
    userEnv: recorded.userEnv,
  });

  // ── 영수증 `installed.codex` (2.0.38) ─────────────────────────────────
  // 코덱스는 꾸러미에 동봉돼 이 단계에서 이미 쓸 수 있는데, 영수증에 한 번도 적히지
  // 않았다. IRIS 창(P02 daemon\wake.mjs)은 영수증에 적힌 비서만 "아는 비서"로 보므로
  // `installed.claude` 만 있는 PC 에서는 코덱스 단추가 끝내 나타나지 않았다
  // (2026-09-23 다른 선생님 PC 실사고). 구독 선택과 상관없이 늘 켠 상태로 적는다.
  recorded.codexReceipt = writeCodexInstalled(ctx, root, {
    state: 'installed',
    version: lockField(ctx, 'codex', 'version') ?? null,
    source: 'bundled',
    path: lockField(ctx, 'codex', 'dest') ? String(lockField(ctx, 'codex', 'dest')).split('/').join('\\') : null,
    verified: true,
    active: true,
  });

  log(`[env] shim ${recorded.shims.length}개, 환경변수 ${Object.keys(vars).length}개`
    + `${recorded.userEnv.applied ? ' 적용' : ' 기록만'}`);
  return { recorded, pending };
}

// 영수증 `installed.codex` 를 적는다 — writeReceiptEnv 와 같은 두 군데(엔진 객체·디스크).
// 이미 적힌 칸이 있으면 그 위에 얹되 `active` 는 늘 true 로 되돌린다(옛 판이 잠재운 코덱스를 깨운다).
export function writeCodexInstalled(ctx, root, info) {
  const apply = (receipt) => {
    receipt.installed = receipt.installed ?? {};
    receipt.installed.codex = { ...(receipt.installed.codex ?? {}), ...info, active: true };
  };
  if (ctx?.receipt && typeof ctx.receipt === 'object') apply(ctx.receipt);
  try {
    const onDisk = readReceipt(root);
    if (onDisk) { apply(onDisk); writeReceipt(root, onDisk); }
  } catch { /* 엔진이 단계 끝에 ctx.receipt 를 다시 쓴다 */ }
  return info;
}

// 영수증의 최상위 `env` 칸을 v1 과 같은 모양으로 채운다.
//
// 두 군데에 남긴다:
//   ① `ctx.receipt.env`  — 엔진(T18)이 단계가 끝날 때마다 통째로 저장하므로
//                          그 객체를 그대로 고치면 자동으로 디스크에 간다.
//   ② 디스크의 영수증     — 엔진 없이 이 단계만 부른 경우(시험·재개 진단)에도
//                          `readReceipt(root)?.env` 가 답할 수 있어야 한다.
//                          디스크에 이미 영수증이 있으면 **그 위에 `env` 칸만**
//                          얹어 다시 쓴다(다른 칸은 한 글자도 건드리지 않는다).
export function writeReceiptEnv(ctx, { root, claudeCfg, codexHome, teamclaudeConfig, shims, userEnv }) {
  const env = {
    CLAUDE_CONFIG_DIR: claudeCfg,
    CODEX_HOME: codexHome,
    ANTHROPIC_BASE_URL: RELAY_BASE_URL,
    TEAMCLAUDE_CONFIG: teamclaudeConfig,
    // 같은 값을 설치기 안쪽이 읽는 이름으로 한 번 더(v1 과 동일):
    // login.mjs·server.mjs·Face 가 `env.teamclaudeConfig` 를 본다.
    teamclaudeConfig,
    shims,
    pathShim: shims, // v1 이름(옛 영수증을 읽는 코드가 있다)
    applied: !!userEnv?.applied,
    pathAdded: !!userEnv?.pathAdded,
    previous: userEnv?.previous ?? {},
  };
  if (!env.applied) env.skippedReason = userEnv?.skippedReason ?? 'no-user-env';

  if (ctx?.receipt && typeof ctx.receipt === 'object') ctx.receipt.env = env;

  try {
    const onDisk = readReceipt(root);
    if (onDisk) {
      onDisk.env = env;
      writeReceipt(root, onDisk);
    } else if (ctx?.receipt && typeof ctx.receipt === 'object') {
      writeReceipt(root, ctx.receipt);
    }
  } catch { /* 영수증을 못 쓰면 엔진이 단계 끝에 다시 쓴다 -- 설치를 멈출 일은 아니다 */ }

  return env;
}
