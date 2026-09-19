// ⑤-6 에이전트 연결부 (설계-v2 6-2, 계약 v2 6단계)
//
// 클로드·코덱스가 **파일만으로** 플러그인·MCP 서버·훅·스킬을 보게 만든다.
// CLI 설치 명령(`claude plugin install`·`claude mcp add`·`codex mcp add`)은 한 번도
// 부르지 않는다 — T03 실측(`.superpowers\sdd\구현계획-v2\task-3-report.md`)이
// 파일 다섯 개(marketplace.json·known_marketplaces.json·installed_plugins.json·
// settings.json·.claude.json)와 `plugins\cache\` 복사본만으로 `claude plugin list`·
// `claude mcp list` 가 전부 인식함을 증명했다.
//
// 이 단계의 규칙(계약 v2 "멱등·무삭제"):
//   · 설정 파일은 **없는 키만 추가**한다. 그 사람이 이미 넣어 둔 값·훅·MCP 서버는
//     한 글자도 바꾸지 않는다(S08·S09).
//   · 두 번 돌려도 변경 0. 세 번째 실행이 첫 번째와 같은 바이트를 남긴다.
//   · 구독(클로드만/코덱스만)과 무관하게 **양쪽 다 등록**한다(D2-17). 나중에 구독을
//     하나 더 붙여도 설정이 이미 되어 있다.
//   · 도구 폴더 위치는 잠금표(lock.json)의 `dest` 가 정한다 — 여기에 경로를 박지 않는다.
//
// 심링크는 쓰지 않는다: 이 윈도우에서 비관리자 계정은 심링크를 못 만든다(T03 실측).
// 그래서 플러그인 캐시도 코덱스 스킬도 **실제 복사**다.
import nodeFs from 'node:fs';
import path from 'node:path';
import { StageError } from '../lib/errors.mjs';
import {
  assertInside, ensureDir, copyIfAbsent, copyTreeIfAbsent, writeIfAbsent,
} from '../lib/paths.mjs';
import { policyDir } from '../lib/payload.mjs';
import {
  seedClaudePermissions, seedCodexPermissions, seedClaudeFirstRun, seedCodexFirstRun,
  claudeSettingsPath, claudeConfigJsonPath, codexConfigTomlPath,
} from '../lib/firstrun.mjs';

export const id = 'adapters';

// 로컬 마켓플레이스 이름. 꾸러미가 들고 온 플러그인은 전부 이 하나에 속한다
// (깃허브 마켓플레이스와 달리 인터넷이 필요 없다).
export const MARKETPLACE = 'iris-local';

// 대화 기록 보존 기간. 기본값(30일)이면 몇 달 전 대화가 조용히 사라진다.
// 10년이면 사실상 "지우지 않음"이고, 설치기의 무삭제 약속과도 맞는다.
export const CLEANUP_PERIOD_DAYS = 3650;

// 훅 스크립트(부품 `hooks`)와 그 이름. `.test.py` 짝은 스크립트 옆에 같이 두되
// 훅으로 등록하지는 않는다(시험 파일이다).
export const HOOK_SCRIPTS = ['block-blanket-kill.ps1', 'guard-iris-path.py'];
export const HOOK_EXTRAS = ['block-blanket-kill.test.py', 'guard-iris-path.test.py'];

// 클로드 플러그인 5종. `part` = 잠금표 부품 id(= 도구 폴더 위치), `name` = 플러그인
// 이름(`<name>@iris-local` 로 켜진다). document-skills 만 허가서상 내려받기라
// 꾸러미에 없을 수 있다(`optional`).
export const CLAUDE_PLUGINS = Object.freeze([
  { part: 'superpowers', name: 'superpowers', description: '설계·계획·시험 주도 개발 등 작업 절차 스킬 묶음' },
  { part: 'self-improve', name: 'self-improve', description: '같은 실수를 반복하지 않도록 교훈을 기록·규칙화하는 자기개선 도구' },
  { part: 'frontend-design', name: 'frontend-design', description: '화면 디자인 감각을 잡아 주는 프런트엔드 디자인 지침' },
  { part: 'insane-search', name: 'insane-search', description: '차단된 사이트의 원문을 여러 경로로 확보하는 검색 도구' },
  { part: 'document-skills', name: 'document-skills', description: '엑셀·워드·파워포인트·PDF 문서를 직접 만들고 고치는 스킬 묶음', optional: true },
]);

// 문서 자동화 MCP 5종(파이썬). 오피스·한컴이 없어도 등록은 한다 — 나중에 깔면
// 바로 쓰이고, 지금은 `pending` 으로만 알린다(설계-v2 6-3 검사 2).
export const DOCUMENT_MCPS = Object.freeze([
  { part: 'hwp-automation', name: 'hwp-automation', app: 'hancom', label: '문서 자동화(한글)' },
  { part: 'excel-automation', name: 'excel-automation', app: 'office', label: '문서 자동화(엑셀)' },
  { part: 'ppt-automation', name: 'ppt-automation', app: 'office', label: '문서 자동화(파워포인트)' },
  { part: 'word-automation', name: 'word-automation', app: 'office', label: '문서 자동화(워드)' },
  { part: 'pdf-automation', name: 'pdf-automation', app: null, label: '문서 자동화(PDF)' },
]);

// ---------------------------------------------------------------------------
// 경로 계산 — 전부 잠금표 `dest` 에서 나온다
// ---------------------------------------------------------------------------

// manifest 가 먼저, 없으면 lock. `dest`·`entry`·`env` 는 잠금표에만 있는 필드라
// 둘 다 본다(manifest 는 dest 까지만 싣는다 — build\collect.mjs).
export function lockField(ctx, partId, field) {
  const fromManifest = ctx?.manifest?.parts?.[partId]?.[field];
  if (fromManifest !== undefined && fromManifest !== null) return fromManifest;
  const fromLock = ctx?.lock?.parts?.[partId]?.[field];
  return fromLock === undefined ? null : fromLock;
}

// `_agent/shared/tools/...`(슬래시) → `<root>\_agent\shared\tools\...`
export function underRoot(root, rel) {
  if (!rel) return null;
  const clean = String(rel).replace(/^[\\/]+/, '');
  if (!clean || clean === '.') return root;
  return path.join(root, clean.split('/').join(path.sep));
}

// 잠금표가 정한 그 도구의 폴더. dest 가 없으면 null.
export function toolDir(ctx, partId) {
  return underRoot(ctx.root, lockField(ctx, partId, 'dest'));
}

// 도구의 실행 진입점(잠금표 `entry`). entry 가 없으면 폴더만 돌려준다.
export function toolEntry(ctx, partId) {
  const dir = toolDir(ctx, partId);
  const entry = lockField(ctx, partId, 'entry');
  if (!dir) return null;
  return entry ? path.join(dir, String(entry).split('/').join(path.sep)) : dir;
}

// 도구의 판. 잠금표에 없으면 dest 의 마지막 칸(커밋 짧은 해시가 거기 들어간다).
export function toolVersion(ctx, partId) {
  const v = lockField(ctx, partId, 'version');
  if (v) return String(v);
  const dest = lockField(ctx, partId, 'dest');
  if (!dest) return 'unknown';
  const last = String(dest).split('/').filter(Boolean).pop();
  return last || 'unknown';
}

export const nodeExePath = (root) => path.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe');
export const pythonShimPath = (root) => path.join(root, '_agent', 'shared', 'shims', 'python.cmd');
export const venvPythonPath = (root) => path.join(root, '_agent', 'runtime', 'venvs', 'document-mcp', 'Scripts', 'python.exe');
export const claudeScriptsDir = (root) => path.join(root, '_agent', 'claude', 'scripts');
export const checkFreshPath = (root) => path.join(root, '_ontology', 'check_fresh.py');
export const codexHomeDir = (root) => path.join(root, '_agent', 'codex');
export const codexSkillsDir = (root) => path.join(root, '_agent', 'codex', 'skills');
export const marketplaceDir = (root) => path.join(root, '_agent', 'claude', 'plugins', 'marketplaces', MARKETPLACE);
export const pluginCacheDir = (root, name, version) => path.join(root, '_agent', 'claude', 'plugins', 'cache', MARKETPLACE, name, version);
// 플레이라이트 MCP 는 실행한 폴더에 `.playwright-mcp\` 스냅샷 폴더를 만든다(T01).
// 그래서 전용 작업 폴더를 정해 두고 래퍼 .cmd 가 거기로 옮겨 간 뒤 실행한다 —
// MCP 설정에는 "실행 폴더" 항목이 없기 때문이다.
export const playwrightWrapDir = (root) => path.join(root, '_agent', 'shared', 'tools', 'playwright-mcp');
export const playwrightWorkDir = (root) => path.join(playwrightWrapDir(root), 'work');
export const playwrightWrapper = (root) => path.join(playwrightWrapDir(root), 'playwright-mcp.cmd');

// ---------------------------------------------------------------------------
// 작은 유틸
// ---------------------------------------------------------------------------

function atomicWrite(fs, file, text) {
  ensureDir(path.dirname(file), { fs });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  return file;
}

function readJson(fs, file) {
  if (!fs.existsSync(file)) return { data: {}, existed: false, ok: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, existed: true, ok: false, reason: 'not-an-object' };
    }
    return { data: parsed, existed: true, ok: true };
  } catch (err) {
    return { data: {}, existed: true, ok: false, reason: `unreadable: ${err.message}` };
  }
}

// 읽기 → mutate(data) 가 추가한 키 목록을 돌려줌 → 바뀐 게 있을 때만 원자 쓰기.
// 읽을 수 없는 기존 파일은 **건드리지 않는다**(그 사람 파일을 날리는 것보다 낫다).
function mergeJson(fs, root, file, mutate) {
  assertInside(root, file);
  const { data, existed, ok, reason } = readJson(fs, file);
  if (!ok) return { path: file, written: 'unchanged', added: [], reason };
  const added = mutate(data) ?? [];
  if (added.length === 0) return { path: file, written: 'unchanged', added: [] };
  atomicWrite(fs, file, `${JSON.stringify(data, null, 2)}\n`);
  return { path: file, written: existed ? 'merged' : 'created', added };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// data[key] 가 객체가 아니면 새 객체로 바꿔 돌려준다(원래 값이 객체면 그대로).
function objectAt(data, key) {
  if (!isPlainObject(data[key])) data[key] = {};
  return data[key];
}

function crlf(lines) {
  return `${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// 설치기 소유 판정 — 업데이트(--auto)가 갱신해도 되는 항목인가
// ---------------------------------------------------------------------------
//
// 이 단계의 기본 규칙은 "없는 키만 추가"다(머리말). 그런데 그 규칙만으로는
// **업데이트가 아무것도 못 고친다**: 새 판의 playwright-mcp 가 `…\npm\
// playwright-mcp\0.0.41` 로 옮겨 가도 `.claude.json` 의 명령은 옛 판 폴더를
// 계속 가리켜 MCP 서버가 통째로 죽는다.
//
// 그래서 딱 한 갈래만 예외로 둔다 — **우리가 쓴 것이 분명한 항목**:
// 명령·경로가 `<root>\_agent\shared\tools` 또는 `<root>\_agent\claude\scripts`
// 아래를 가리키는 MCP 서버·훅 항목. 이 둘은 설치기가 만들고 설치기만 쓰는
// 폴더라, 거기를 가리키는 줄은 지난 설치가 쓴 우리 줄이다.
//
// 반대로 **절대 건드리지 않는 것**: 그 사람이 손수 넣은 키(우리가 쓰는 이름이
// 아예 아닌 것), 그리고 이름은 같아도 명령이 저 두 폴더 **밖**을 가리키는 항목
// (= 그 사람이 자기 설치본으로 바꿔 놓은 것). 그런 항목은 그대로 둔다.
export function installerOwnedDirs(root) {
  return [
    path.join(root, '_agent', 'shared', 'tools'),
    path.join(root, '_agent', 'claude', 'scripts'),
  ];
}

// 문자열(명령·경로·인자) 하나가 설치기 소유 폴더 아래를 가리키나.
export function isInstallerOwnedPath(root, value) {
  if (!root || typeof value !== 'string' || !value.trim()) return false;
  const text = value.replace(/"/g, '');
  const dirs = installerOwnedDirs(root).map((d) => d.toLowerCase().replace(/[\\/]+$/, ''));
  // 명령 한 줄 안에 여러 경로가 섞여 있을 수 있어(powershell -File "<경로>")
  // 부분 문자열로 본다 — 슬래시 방향만 맞춰 준다.
  const hay = text.toLowerCase().split('/').join('\\');
  return dirs.some((d) => hay.includes(`${d}\\`));
}

// 플러그인 쪽 "우리 것" 판정. 플러그인 캐시(`_agent\claude\plugins\cache\
// iris-local\…`)도 설치기가 만들고 설치기만 쓰는 자리라 같은 예외를 받는다 —
// 새 판은 캐시 폴더 이름(판)이 달라지므로, 이 갱신이 없으면 업데이트해도
// 플러그인은 옛 판 폴더를 계속 가리킨다.
export function isOurPluginCache(root, p) {
  if (!root || typeof p !== 'string' || !p.trim()) return false;
  const base = path.join(root, '_agent', 'claude', 'plugins', 'cache', MARKETPLACE).toLowerCase();
  return p.toLowerCase().split('/').join('\\').startsWith(`${base}\\`);
}

// marketplace.json 의 `source` 는 marketplace 폴더 기준 **상대경로**다
// (`../../cache/iris-local/<이름>/<판>`). 우리가 쓴 모양인지만 본다.
export function isOurPluginSource(source) {
  if (typeof source !== 'string') return false;
  return source.split('\\').join('/').includes(`cache/${MARKETPLACE}/`);
}

// MCP 서버 항목(객체) 전체를 본다: command 와 args 중 하나라도 우리 폴더면 우리 것.
export function isInstallerOwnedEntry(root, entry) {
  if (!entry || typeof entry !== 'object') return false;
  const candidates = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  return candidates.some((c) => isInstallerOwnedPath(root, c));
}

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// 등록할 MCP 서버 목록
// ---------------------------------------------------------------------------
//
// 코덱스는 7종 전부를 `[mcp_servers.*]` 로 적는다. 클로드는 **6종**만 적는다
// (플레이라이트 + 문서 MCP 5) — self-improve 는 플러그인 자신이 `.mcp.json`
// (`command:"node"`, `args:["${CLAUDE_PLUGIN_ROOT}/server/index.js"]`)으로 이미
// 띄우기 때문이다. 둘 다 적으면 `claude mcp list` 에 `plugin:self-improve:
// self-improve` 와 `self-improve` 가 함께 떠 같은 도구 9종이 두 벌 보인다
// (2026-09-15 실측). 이 PC 의 실제 운영도 플러그인 쪽 하나만 쓴다.
// 대신 `settings.json` 의 `env.SELF_IMPROVE_DIR` 로 그 플러그인 서버가 영혼 안
// 기록 창고를 보게 이어 준다(플러그인 `.mcp.json` 에는 env 가 없어 세션 환경을
// 물려받는다). 코덱스에는 플러그인 체계가 없으므로 stdio 등록이 유일한 길이다.

export function mcpServerSpecs(ctx) {
  const root = ctx.root;
  const out = [];

  // 플레이라이트: 엣지 채널(D2-11). 래퍼 .cmd 가 작업 폴더로 옮겨 간 뒤 실행한다.
  out.push({
    name: 'playwright',
    part: 'playwright-mcp',
    command: playwrightWrapper(root),
    args: [],
    env: { ...(lockField(ctx, 'playwright-mcp', 'env') ?? { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }) },
    entryFile: toolEntry(ctx, 'playwright-mcp'),
    kind: 'browser',
  });

  // 자기개선: 동봉 node 로 server\index.js.
  const selfEnv = lockField(ctx, 'self-improve', 'env') ?? { SELF_IMPROVE_DIR: '_agent/shared/self-improvement' };
  const selfEnvAbs = {};
  for (const [k, v] of Object.entries(selfEnv)) {
    // 잠금표의 env 값이 영혼 안 상대경로면 절대경로로 편다.
    selfEnvAbs[k] = /^_|^\./.test(String(v)) ? underRoot(root, v) : String(v);
  }
  out.push({
    name: 'self-improve',
    part: 'self-improve',
    command: nodeExePath(root),
    args: [toolEntry(ctx, 'self-improve')].filter(Boolean),
    env: selfEnvAbs,
    entryFile: toolEntry(ctx, 'self-improve'),
    kind: 'tool',
    // 클로드에는 적지 않는다(위 머리말) — 플러그인이 같은 서버를 이미 띄운다.
    claude: false,
  });

  // 문서 MCP 5종: venv 파이썬 + server.py.
  for (const doc of DOCUMENT_MCPS) {
    out.push({
      name: doc.name,
      part: doc.part,
      command: venvPythonPath(root),
      args: [toolEntry(ctx, doc.part)].filter(Boolean),
      env: { PYTHONUTF8: '1' },
      entryFile: toolEntry(ctx, doc.part),
      kind: 'document',
      app: doc.app,
      label: doc.label,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 클로드 훅 (개발 PC 의 살아 있는 `_agent\claude\settings.json` 형식을 그대로 복제)
// ---------------------------------------------------------------------------

// 새 PC에는 시스템 파이썬이 없다. 그래서 훅의 파이썬은 동봉 shim 의 **절대경로**다
// (`python` 만 적으면 PATH 반영 전 첫 세션에서 훅이 통째로 실패한다).
export function claudeHookGroups(root) {
  const scripts = claudeScriptsDir(root);
  const py = pythonShimPath(root);
  return {
    PreToolUse: [
      {
        matcher: 'Bash|PowerShell',
        hooks: [{
          type: 'command',
          command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(scripts, 'block-blanket-kill.ps1')}"`,
          timeout: 15,
          statusMessage: '일괄 킬 가드 검사 중',
        }],
      },
      {
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell',
        hooks: [{
          type: 'command',
          command: `"${py}" "${path.join(scripts, 'guard-iris-path.py')}"`,
          timeout: 10,
          statusMessage: 'IRIS 경로 실존 가드 검사 중',
        }],
      },
    ],
    SessionStart: [
      {
        matcher: 'startup|resume|clear|compact',
        hooks: [{
          type: 'command',
          command: `"${py}" "${checkFreshPath(root)}" --hook session`,
          timeout: 30,
          statusMessage: '온톨로지 신선도 점검',
        }],
      },
    ],
  };
}

// 코덱스 `hooks.json` — 개발 PC 의 살아 있는 `_agent\codex\hooks.json` 형식.
// 같은 두 훅이지만 ⓐ 도구 이름이 다르고(`Bash` 만) ⓑ 명령 앞에 파워셸 호출
// 연산자 `&` 가 붙는다.
export function codexHookConfig(root) {
  const scripts = claudeScriptsDir(root); // 훅 스크립트는 한 벌만 둔다(양쪽이 같은 파일을 부른다)
  const py = pythonShimPath(root);
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{
            type: 'command',
            command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(scripts, 'block-blanket-kill.ps1')}"`,
            timeout: 15,
            statusMessage: '일괄 킬 가드 검사 중',
          }],
        },
        {
          matcher: 'Bash',
          hooks: [{
            type: 'command',
            command: `& "${py}" "${path.join(scripts, 'guard-iris-path.py')}"`,
            timeout: 10,
            statusMessage: 'IRIS 경로 실존 가드 검사 중',
          }],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup|resume|clear|compact',
          hooks: [{
            type: 'command',
            command: `& "${py}" "${checkFreshPath(root)}" --hook session`,
            timeout: 30,
            statusMessage: '온톨로지 신선도 점검',
          }],
        },
      ],
    },
  };
}

// 훅 항목이 어느 스크립트를 부르는지(파일 이름만).
function hookScriptNames(entry) {
  return (entry?.hooks ?? [])
    .map((h) => path.basename(String(h?.command ?? '').replace(/"/g, '').split(/\s+/).find((t) => /\.(ps1|py|cjs|js)$/i.test(t)) ?? ''))
    .filter(Boolean);
}

// 같은 스크립트를 부르는 훅이 이미 있는지(=우리 훅이 이미 등록됐는지) 본다.
// 사람이 손으로 고친 경로·인자까지 같을 필요는 없다 — 스크립트 파일 이름이 같으면
// "이미 있다"로 보고 (경로 갱신 말고는) 건드리지 않는다.
function findHookEntry(list, entry) {
  const marks = hookScriptNames(entry);
  if (marks.length === 0) return null;
  for (const existing of list) {
    for (const h of existing.hooks ?? []) {
      const cmd = String(h?.command ?? '');
      if (marks.some((m) => cmd.toLowerCase().includes(m.toLowerCase()))) return existing;
    }
  }
  return null;
}

// 업데이트 예외: 이미 있는 우리 훅의 명령이 **설치기 소유 폴더**를 가리키면서
// 새 판의 명령과 다르면 그 한 줄만 갈아 끼운다(판 폴더가 바뀌면 옛 경로는 없다).
// 그 사람이 다른 곳의 스크립트를 부르도록 바꿔 두었으면 손대지 않는다.
function updateOwnedHook(root, existing, wanted) {
  let changed = false;
  for (const w of wanted.hooks ?? []) {
    const marks = hookScriptNames({ hooks: [w] });
    if (marks.length === 0) continue;
    for (const h of existing.hooks ?? []) {
      const cmd = String(h?.command ?? '');
      if (!marks.some((m) => cmd.toLowerCase().includes(m.toLowerCase()))) continue;
      if (!isInstallerOwnedPath(root, cmd)) continue; // 그 사람 사본 — 그대로
      if (cmd === w.command) continue;
      h.command = w.command;
      changed = true;
    }
  }
  return changed;
}

// hooks 블록에 우리 항목을 **더하기만** 한다(기존 항목은 순서까지 그대로).
// 예외는 하나 — 위 updateOwnedHook 의 "우리 훅 경로 갱신".
function mergeHooks(data, groups, added, prefix, root = null) {
  const hooks = objectAt(data, 'hooks');
  for (const [event, entries] of Object.entries(groups)) {
    if (!Array.isArray(hooks[event])) {
      if (hooks[event] !== undefined) continue; // 모양이 다르면 손대지 않는다
      hooks[event] = [];
    }
    for (const entry of entries) {
      const existing = findHookEntry(hooks[event], entry);
      if (existing) {
        if (root && updateOwnedHook(root, existing, entry)) {
          added.push(`${prefix}${event}[${entry.matcher}](updated)`);
        }
        continue;
      }
      hooks[event].push(entry);
      added.push(`${prefix}${event}[${entry.matcher}]`);
    }
  }
}

// ---------------------------------------------------------------------------
// TOML 병합 — 텍스트로 다룬다(코덱스가 쓴 주석·순서를 살리려고)
// ---------------------------------------------------------------------------

// TOML 기본 문자열: 역슬래시와 따옴표만 이스케이프하면 윈도 경로에 충분하다.
export function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function tomlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => tomlValue(v)).join(', ')}]`;
  return tomlString(value);
}

// 최상위(첫 `[table]` 앞) 영역에만 있는 키인지. 테이블 안의 같은 이름은 다른 설정이다.
function topRegion(text) {
  const firstTable = text.search(/^\s*\[/m);
  return firstTable === -1 ? text : text.slice(0, firstTable);
}

export function hasTopKey(text, key) {
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'm').test(topRegion(text));
}

export function hasTable(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[${esc}\\]`, 'm').test(text);
}

// `[table]` 의 본문(다음 테이블 헤더 전까지)에 그 키가 있는지.
export function hasTableKey(text, table, key) {
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^\\s*\\[${esc}\\]\\s*$`, 'm').exec(text);
  if (!m) return false;
  const after = text.slice(m.index + m[0].length);
  const next = after.search(/^\s*\[/m);
  const body = next === -1 ? after : after.slice(0, next);
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'm').test(body);
}

// `[table]` 머리 바로 다음 줄에 키를 끼워 넣는다(테이블이 이미 있을 때).
function insertIntoTable(text, table, line) {
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^\\s*\\[${esc}\\]\\s*$`, 'm').exec(text);
  if (!m) return null;
  const at = m.index + m[0].length;
  return `${text.slice(0, at)}\n${line}${text.slice(at)}`;
}

// `[mcp_servers.<이름>]` 블록 하나의 범위(머리 ~ 다음 다른 테이블 앞)를 찾는다.
// `[mcp_servers.<이름>.env]` 같은 하위 테이블은 그 블록의 일부다.
export function findMcpTable(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^[ \\t]*\\[mcp_servers\\.${esc}\\][ \\t]*$`, 'm').exec(text);
  if (!head) return null;
  const start = head.index;
  const after = text.slice(start + head[0].length);
  const headerRe = /^[ \t]*\[([^\]]+)\][ \t]*$/gm;
  let end = text.length;
  let m;
  while ((m = headerRe.exec(after)) !== null) {
    const table = m[1].trim();
    if (table === `mcp_servers.${name}` || table.startsWith(`mcp_servers.${name}.`)) continue;
    end = start + head[0].length + m.index;
    break;
  }
  return { start, end, body: text.slice(start, end) };
}

// 업데이트 예외(위 〈설치기 소유 판정〉의 TOML 판): 그 블록의 `command` 가 우리
// 폴더를 가리키면 `command`·`args` 두 줄만 새 판으로 바꾼다. 블록을 통째로
// 바꾸지 않는다 — 그 사람이 `[mcp_servers.<이름>.env]` 하위 테이블에 손으로
// 더한 줄이나 다른 키는 그대로 남아야 한다.
export function updateOwnedMcpTable(text, name, block, root) {
  const found = findMcpTable(text, name);
  if (!found) return null;
  const cmd = /^[ \t]*command[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/m.exec(found.body);
  const value = cmd ? cmd[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"') : null;
  if (!isInstallerOwnedPath(root, value)) return null;

  const newCmdLine = /^[ \t]*command[ \t]*=.*$/m.exec(block);
  const newArgsLine = /^[ \t]*args[ \t]*=.*$/m.exec(block);
  let body = found.body;
  if (newCmdLine) body = body.replace(/^[ \t]*command[ \t]*=.*$/m, newCmdLine[0]);
  if (newArgsLine) body = body.replace(/^[ \t]*args[ \t]*=.*$/m, newArgsLine[0]);
  if (body === found.body) return null;
  return `${text.slice(0, found.start)}${body}${text.slice(found.end)}`;
}

// MCP 서버 한 개를 TOML 블록으로.
export function mcpTomlBlock(spec) {
  const lines = [`[mcp_servers.${spec.name}]`, `command = ${tomlString(spec.command)}`];
  lines.push(`args = ${tomlValue(spec.args ?? [])}`);
  lines.push('startup_timeout_sec = 30');
  const env = spec.env ?? {};
  if (Object.keys(env).length) {
    lines.push('');
    lines.push(`[mcp_servers.${spec.name}.env]`);
    for (const [k, v] of Object.entries(env)) lines.push(`${k} = ${tomlString(v)}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// 단계 본체
// ---------------------------------------------------------------------------

export async function run(ctx) {
  const fs = ctx?.fs ?? nodeFs;
  const root = ctx?.root;
  if (!root) throw new StageError('E-ADAPTERS', '설치 폴더 경로가 없어 에이전트 설정을 만들 수 없습니다.', { ctx: 'root' });
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};

  const recorded = {
    claude: { files: [], plugins: [], mcp: [], hooks: [], settings: null, marketplace: MARKETPLACE },
    codex: { files: [], mcp: [], skills: { copied: [], kept: 0 }, hooks: null, config: null },
    missing: [],
    apps: {},
  };
  const pending = [];
  const seen = new Set();
  const addPending = (capability, reason) => {
    const key = `${capability}::${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    pending.push({ capability, reason });
  };
  const rel = (p) => path.relative(root, p).split(path.sep).join('\\') || '.';
  const note = (side, p) => recorded[side].files.push(rel(p));

  ensureDir(assertInside(root, path.join(root, '_agent', 'claude')), { fs });
  ensureDir(assertInside(root, codexHomeDir(root)), { fs });

  // ── 1. 훅 스크립트 두 개 ──────────────────────────────────────────────
  placeHookScripts(ctx, { fs, root, recorded, note, log });

  // ── 2. 클로드 settings.json ───────────────────────────────────────────
  recorded.claude.settings = writeClaudeSettings(ctx, { fs, root, recorded, note, log });

  // ── 3. 클로드 플러그인(로컬 마켓플레이스 + 캐시 복사) ──────────────────
  for (const spec of CLAUDE_PLUGINS) {
    if (spec.optional) continue; // document-skills 는 아래에서 따로
    const r = registerClaudePlugin(ctx, spec, { fs, root, log });
    recorded.claude.plugins.push(r);
    for (const f of r.files ?? []) note('claude', f);
  }
  // document-skills: 허가서상 **내려받기** 부품이라 꾸러미에 없을 수 있다.
  // 있으면 지금 등록하고, 없으면 대기로 남긴다. 온라인 단계가 내려받은 뒤
  // 같은 함수를 다시 부르면 그때 등록된다.
  const docSkills = registerDocumentSkills(ctx, { fs, log });
  recorded.claude.plugins.push(docSkills);
  for (const f of docSkills.files ?? []) note('claude', f);
  if (docSkills.status === 'missing') {
    recorded.missing.push({ what: 'document-skills 플러그인', from: docSkills.source ?? null });
    addPending('문서 작성 스킬(엑셀·워드·PPT·PDF)', '허가서상 내려받기 부품이라 꾸러미에 없음 — 다음 ⑦ 계정 연결 단계가 인터넷에서 받아 자동 등록합니다(인터넷이 없으면 다음 실행에서)');
  }

  // ── 4. 클로드 .claude.json 의 mcpServers (6종 — self-improve 는 플러그인 몫) ─
  const specs = mcpServerSpecs(ctx);
  const claudeSpecs = specs.filter((s) => s.claude !== false);
  writePlaywrightWrapper(ctx, { fs, root, recorded, note, log });
  const claudeMcp = writeClaudeMcpServers(ctx, claudeSpecs, { fs, root });
  recorded.claude.mcp = claudeSpecs.map((s) => s.name);
  recorded.claude.mcpViaPlugin = specs.filter((s) => s.claude === false).map((s) => s.name);
  recorded.claude.mcpFile = { path: rel(claudeMcp.path), written: claudeMcp.written, added: claudeMcp.added };
  if (claudeMcp.written !== 'unchanged') note('claude', claudeMcp.path);

  // ── 5. secrets ────────────────────────────────────────────────────────
  for (const f of writeSecrets(ctx, { fs, root })) note('claude', f);

  // ── 6. 코덱스 config.toml ─────────────────────────────────────────────
  recorded.codex.config = writeCodexConfig(ctx, specs, { fs, root, log });
  recorded.codex.mcp = specs.map((s) => s.name);
  note('codex', codexConfigTomlPath(root));

  // ── 6-2. 첫 실행 물음 미리 답하기(온보딩·폴더 신뢰) ────────────────────
  // v1 설치기(install.mjs)만 부르던 것을 v2 엔진이 빠뜨려 2.0.0~2.0.19 신규 설치는
  // 첫 세션에서 "Do you trust the files in this folder?" 가 영어로 떴다(2026-09-19 실제 사용자 실측).
  // 두 헬퍼 모두 빠진 키만 더한다(있는 값 무접촉) — 두 번 실행해도 변경 0.
  recorded.claude.firstRun = seedClaudeFirstRun(root);
  recorded.codex.firstRun = seedCodexFirstRun(root);
  if (recorded.claude.firstRun.written !== 'unchanged') note('claude', recorded.claude.firstRun.path);
  if (recorded.codex.firstRun.written !== 'unchanged') note('codex', recorded.codex.firstRun.path);

  // ── 7. 코덱스 스킬(superpowers 를 스킬 단위로 풀어서) ──────────────────
  recorded.codex.skills = copySuperpowersSkills(ctx, { fs, root, log });
  if (recorded.codex.skills.status === 'missing') {
    recorded.missing.push({ what: 'superpowers 스킬 폴더', from: recorded.codex.skills.source ?? null });
  }

  // ── 8. UI/UX Pro Max — 코덱스 스킬 생성기 ─────────────────────────────
  recorded.codex.uiUx = await runUiUxProMax(ctx, { fs, root, log });
  if (recorded.codex.uiUx.status !== 'ok') {
    addPending('코덱스 UI/UX 스킬', `스킬 생성기를 돌리지 못했습니다(${recorded.codex.uiUx.reason ?? recorded.codex.uiUx.status})`);
  }

  // ── 9. 코덱스 훅 ──────────────────────────────────────────────────────
  recorded.codex.hooks = writeCodexHooks(ctx, { fs, root });
  if (recorded.codex.hooks.written !== 'unchanged') note('codex', recorded.codex.hooks.path);

  // ── 10. 대기 판정(오피스·한컴·엣지) ───────────────────────────────────
  const apps = await detectApps(ctx, { log });
  recorded.apps = apps;
  for (const spec of specs) {
    if (spec.kind !== 'document' || !spec.app) continue;
    if (apps[spec.app] === false) {
      addPending(spec.label, spec.app === 'hancom' ? '한컴오피스(한글)가 없음 — 설치하면 바로 쓰입니다' : '마이크로소프트 오피스가 없음 — 설치하면 바로 쓰입니다');
    }
  }
  const edge = ctx?.precheck?.edge?.present ?? ctx?.precheck?.recorded?.edge?.present;
  if (edge === false) addPending('브라우저 조작(Playwright)', '엣지 브라우저를 찾지 못함 — 엣지를 설치하면 바로 쓰입니다');

  // 진입 파일이 아직 없는 MCP 는 기록만 남긴다(⑤-9 검사가 사람에게 보여 준다).
  for (const spec of specs) {
    const f = spec.entryFile;
    if (f && !fs.existsSync(f)) recorded.missing.push({ what: `MCP ${spec.name} 진입 파일`, from: rel(f) });
  }

  log(`[adapters] 클로드 플러그인 ${recorded.claude.plugins.filter((p) => p.status === 'registered' || p.status === 'kept').length}개·MCP ${claudeSpecs.length}개(+플러그인이 띄우는 ${recorded.claude.mcpViaPlugin.length}개)·훅 ${recorded.claude.hooks.length}종, 코덱스 MCP ${specs.length}개·스킬 ${recorded.codex.skills.copied?.length ?? 0}개 등록`);

  return { recorded, pending };
}

// ---------------------------------------------------------------------------
// 1. 훅 스크립트
// ---------------------------------------------------------------------------

// 부품 `hooks` 의 dest 가 이미 `_agent\claude\scripts` 라 ⑤-1 풀기가 끝났으면
// 파일이 거기 있다. 아직 없으면(시험·부분 실행) payload\policy\hooks\ 에서 복사한다.
function hookSource(ctx, name, { fs }) {
  const fromPolicy = path.join(policyDir(ctx, { fs }), 'hooks', name);
  if (fs.existsSync(fromPolicy)) return fromPolicy;
  const dest = lockField(ctx, 'hooks', 'file');
  if (dest && ctx.payloadDir) {
    const stripped = String(dest).replace(/\.zip$/i, '');
    const candidate = path.join(ctx.payloadDir, stripped.split('/').join(path.sep), name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function placeHookScripts(ctx, { fs, root, recorded, note, log }) {
  const dir = assertInside(root, claudeScriptsDir(root));
  ensureDir(dir, { fs });
  for (const name of [...HOOK_SCRIPTS, ...HOOK_EXTRAS]) {
    const dst = assertInside(root, path.join(dir, name));
    if (fs.existsSync(dst)) { note('claude', dst); continue; }
    const src = hookSource(ctx, name, { fs });
    const r = copyIfAbsent(src, dst, { fs });
    if (r.missingSource) {
      recorded.missing.push({ what: `훅 스크립트 ${name}`, from: null });
      log(`[adapters] 꾸러미에 훅 스크립트 ${name} 이(가) 없어 파일 복사를 건너뜀(등록은 그대로 함)`);
      continue;
    }
    note('claude', dst);
  }
}

// ---------------------------------------------------------------------------
// 2. 클로드 settings.json
// ---------------------------------------------------------------------------

function writeClaudeSettings(ctx, { fs, root, recorded, note, log }) {
  // 권한 두 줄은 기존 헬퍼가 정본이다(같은 값을 두 군데 적지 않는다).
  const perms = seedClaudePermissions(root);
  const file = claudeSettingsPath(root);
  const groups = claudeHookGroups(root);
  recorded.claude.hooks = Object.entries(groups).flatMap(([event, entries]) => entries.map((e) => `${event}:${e.matcher}`));

  const superEnv = lockField(ctx, 'superpowers', 'env') ?? { SUPERPOWERS_DISABLE_TELEMETRY: '1' };

  const r = mergeJson(fs, root, file, (data) => {
    const added = [];

    // env — 도구 스키마 지연 로드(토큰 절약)와 수퍼파워 원격 수집 끄기.
    // SELF_IMPROVE_DIR 도 여기 둔다: self-improve 플러그인은 자기 `.mcp.json` 으로
    // 서버를 한 번 더 띄우는데(`command: "node"`, env 없음) 그 서버는 세션 환경을
    // 물려받는다. 여기 없으면 플러그인 쪽과 우리가 등록한 쪽이 **서로 다른 기록
    // 창고**를 쓰게 된다(실측 2026-09-15: `claude mcp list` 에 두 항목이 함께 뜬다).
    const env = objectAt(data, 'env');
    const selfDir = (lockField(ctx, 'self-improve', 'env') ?? {}).SELF_IMPROVE_DIR ?? '_agent/shared/self-improvement';
    const wanted = { ENABLE_TOOL_SEARCH: 'true', SELF_IMPROVE_DIR: underRoot(root, selfDir), ...superEnv };
    for (const [k, v] of Object.entries(wanted)) {
      if (env[k] === undefined) { env[k] = String(v); added.push(`env.${k}`); }
    }

    // 대화 기록 보존 기간.
    if (data.cleanupPeriodDays === undefined) {
      data.cleanupPeriodDays = CLEANUP_PERIOD_DAYS;
      added.push('cleanupPeriodDays');
    }

    // 훅.
    mergeHooks(data, groups, added, 'hooks.', root);

    // 로컬 마켓플레이스 알리기. 플러그인 개별 켜기(enabledPlugins)는
    // registerClaudePlugin 이 한다 — 나중에 내려받은 document-skills 도 같은
    // 경로로 켜지게 하려고 한 군데에 모았다.
    const markets = objectAt(data, 'extraKnownMarketplaces');
    if (markets[MARKETPLACE] === undefined) {
      markets[MARKETPLACE] = { source: { source: 'directory', path: marketplaceDir(root) } };
      added.push(`extraKnownMarketplaces.${MARKETPLACE}`);
    }
    return added;
  });

  if (r.written !== 'unchanged' || perms.written !== 'unchanged') note('claude', file);
  if (r.reason) log(`[adapters] settings.json 을 읽지 못해 그대로 두었습니다(${r.reason})`);
  return { path: file, permissions: perms.written, merged: r.written, added: [...(perms.added ?? []), ...r.added], reason: r.reason ?? null };
}

// ---------------------------------------------------------------------------
// 3. 클로드 플러그인
// ---------------------------------------------------------------------------

function toolDirExists(ctx, partId, { fs }) {
  const dir = toolDir(ctx, partId);
  try { return Boolean(dir) && fs.existsSync(dir) && fs.statSync(dir).isDirectory(); } catch { return false; }
}

/**
 * registerClaudePlugin — 플러그인 하나를 파일만으로 등록한다(T03 형식).
 *   ① plugins\cache\iris-local\<이름>\<판>\   ← 도구 폴더 실제 복사(심링크 아님)
 *   ② plugins\marketplaces\iris-local\.claude-plugin\marketplace.json 에 한 줄
 *   ③ plugins\known_marketplaces.json 에 iris-local
 *   ④ plugins\installed_plugins.json 에 <이름>@iris-local
 * settings.json 의 enabledPlugins·extraKnownMarketplaces 는 ②단계에서 따로.
 */
export function registerClaudePlugin(ctx, spec, { fs = nodeFs, root = ctx?.root, log = () => {} } = {}) {
  const src = toolDir(ctx, spec.part);
  const version = toolVersion(ctx, spec.part);
  const files = [];
  if (!toolDirExists(ctx, spec.part, { fs })) {
    log(`[adapters] ${spec.name} 플러그인 폴더가 없어 등록을 건너뜀(${src ? '아직 안 풀림' : '잠금표에 dest 없음'})`);
    return { name: spec.name, status: 'missing', source: src, version, files };
  }

  // ① 캐시 복사
  const cache = assertInside(root, pluginCacheDir(root, spec.name, version));
  const copied = copyTreeIfAbsent(src, cache, { fs, root });
  files.push(cache);

  // ② 로컬 마켓플레이스 — 플러그인 내용은 캐시에 한 벌만 두고, 여기서는
  //    캐시를 가리키는 상대경로만 적는다(같은 2MB를 두 번 복사하지 않는다).
  const mdir = assertInside(root, marketplaceDir(root));
  const mfile = path.join(mdir, '.claude-plugin', 'marketplace.json');
  const source = path.relative(mdir, cache).split(path.sep).join('/');
  const mr = mergeJson(fs, root, mfile, (data) => {
    const added = [];
    if (data.name === undefined) { data.name = MARKETPLACE; added.push('name'); }
    if (data.owner === undefined) { data.owner = { name: 'IRIS' }; added.push('owner'); }
    if (!Array.isArray(data.plugins)) { data.plugins = []; added.push('plugins'); }
    const prior = data.plugins.find((p) => p && p.name === spec.name);
    if (!prior) {
      data.plugins.push({ name: spec.name, source, description: spec.description });
      added.push(`plugins.${spec.name}`);
    } else if (prior.source !== source && isOurPluginSource(prior.source)) {
      // 업데이트: 새 판은 캐시 폴더 이름(판)이 다르다. 우리 캐시를 가리키던
      // 줄만 새 자리로 옮긴다(그 사람이 다른 곳을 가리키게 고쳤으면 그대로).
      prior.source = source;
      added.push(`plugins.${spec.name}(updated)`);
    }
    return added;
  });
  if (mr.written !== 'unchanged') files.push(mfile);

  // ③ 알려진 마켓플레이스
  const kfile = path.join(root, '_agent', 'claude', 'plugins', 'known_marketplaces.json');
  const kr = mergeJson(fs, root, kfile, (data) => {
    if (data[MARKETPLACE] !== undefined) return [];
    data[MARKETPLACE] = {
      source: { source: 'directory', path: mdir },
      installLocation: mdir,
      lastUpdated: nowIso(),
    };
    return [MARKETPLACE];
  });
  if (kr.written !== 'unchanged') files.push(kfile);

  // ④ 설치된 플러그인
  const ifile = path.join(root, '_agent', 'claude', 'plugins', 'installed_plugins.json');
  const key = `${spec.name}@${MARKETPLACE}`;
  const ir = mergeJson(fs, root, ifile, (data) => {
    const added = [];
    if (data.version !== 2) { data.version = 2; added.push('version'); }
    const plugins = objectAt(data, 'plugins');
    if (!Array.isArray(plugins[key])) {
      const when = nowIso();
      plugins[key] = [{ scope: 'user', installPath: cache, version, installedAt: when, lastUpdated: when }];
      added.push(key);
    } else {
      // 같은 이유로(위 마켓플레이스 주석) 우리 캐시를 가리키는 항목의 판·경로만 갱신.
      let touched = false;
      for (const item of plugins[key]) {
        if (!item || item.installPath === cache) continue;
        if (!isOurPluginCache(root, item.installPath)) continue;
        item.installPath = cache;
        item.version = version;
        item.lastUpdated = nowIso();
        touched = true;
      }
      if (touched) added.push(`${key}(updated)`);
    }
    return added;
  });
  if (ir.written !== 'unchanged') files.push(ifile);

  // ⑤ settings.json 에서 켜기 + 마켓플레이스 알리기(온라인 단계가 나중에 이
  //    함수만 다시 불러도 플러그인이 켜지도록 여기에 둔다).
  const sfile = claudeSettingsPath(root);
  const sr = mergeJson(fs, root, sfile, (data) => {
    const added = [];
    const enabled = objectAt(data, 'enabledPlugins');
    if (enabled[key] === undefined) { enabled[key] = true; added.push(`enabledPlugins.${key}`); }
    const markets = objectAt(data, 'extraKnownMarketplaces');
    if (markets[MARKETPLACE] === undefined) {
      markets[MARKETPLACE] = { source: { source: 'directory', path: mdir } };
      added.push(`extraKnownMarketplaces.${MARKETPLACE}`);
    }
    return added;
  });
  if (sr.written !== 'unchanged') files.push(sfile);

  const status = copied.written.length > 0 ? 'registered' : 'kept';
  return { name: spec.name, status, version, installPath: cache, copied: copied.written.length, kept: copied.kept.length, files };
}

/**
 * registerDocumentSkills(ctx) — document-skills 전용 입구.
 *
 * 이 부품만 허가서가 재배포를 막아(`redistribute: download`) 꾸러미에 없을 수
 * 있다. 그래서 ⑤-6 은 "있으면 등록"만 하고, 온라인 단계(⑥)가 내려받은 뒤
 * **같은 함수를 다시 부르면** 그때 등록된다. 두 번 불러도 안전하다(멱등).
 */
export function registerDocumentSkills(ctx, { fs = ctx?.fs ?? nodeFs, log = ctx?.log ?? (() => {}) } = {}) {
  const spec = CLAUDE_PLUGINS.find((p) => p.name === 'document-skills');
  return registerClaudePlugin(ctx, spec, { fs, root: ctx.root, log });
}

// ---------------------------------------------------------------------------
// 4. MCP 서버
// ---------------------------------------------------------------------------

// 플레이라이트 래퍼. MCP 설정에는 "실행 폴더" 항목이 없어서, 스냅샷 폴더가
// 엉뚱한 곳(마지막 작업 폴더)에 생기는 것을 막으려면 래퍼가 필요하다.
// 내용은 ASCII·CRLF(다른 shim 과 같은 규칙) + `%~dp0` 상대경로라 영혼 폴더가
// 어디로 옮겨져도 그대로 동작한다.
export function playwrightWrapperText(ctx) {
  const dest = String(lockField(ctx, 'playwright-mcp', 'dest') ?? '_agent/shared/tools/npm/playwright-mcp');
  const entry = String(lockField(ctx, 'playwright-mcp', 'entry') ?? 'node_modules/@playwright/mcp/cli.js');
  // dest 는 `_agent/shared/tools/npm/playwright-mcp/<판>` — 래퍼는
  // `_agent\shared\tools\playwright-mcp\` 에 있으므로 `..\` 하나로 tools 에 닿는다.
  const fromTools = dest.replace(/^_agent\/shared\/tools\//, '').split('/').join('\\');
  const cli = `%~dp0..\\${fromTools}\\${entry.split('/').join('\\')}`;
  return crlf([
    '@echo off',
    'setlocal',
    'if not exist "%~dp0work" mkdir "%~dp0work"',
    'cd /d "%~dp0work"',
    `"%~dp0..\\node\\node.exe" "${cli}" --browser msedge %*`,
    'exit /b %errorlevel%',
  ]);
}

function writePlaywrightWrapper(ctx, { fs, root, recorded, note, log }) {
  ensureDir(assertInside(root, playwrightWorkDir(root)), { fs });
  const file = assertInside(root, playwrightWrapper(root));
  const text = playwrightWrapperText(ctx);
  // 설치기 소유 파일이라 내용이 달라졌으면 갱신한다(계약 v2: 우리 파일만 갱신).
  const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text;
  if (!same) {
    atomicWrite(fs, file, text);
    log('[adapters] 플레이라이트 실행 래퍼를 썼습니다(스냅샷 폴더 고정)');
  }
  note('claude', file);
  recorded.claude.playwrightWork = path.relative(root, playwrightWorkDir(root)).split(path.sep).join('\\');
  return file;
}

// 인자(args) 배열 병합: 우리가 관리하는 경로 인자(설치기 소유 폴더를 가리키는
// 것)는 새 판 값으로 갈아 끼우고, 그 사람이 손으로 더한 나머지 인자(플래그 등)는
// 그대로 살린다. `existing.args` 를 통째로 버리지 않는다.
function mergeOwnedArgs(root, existingArgs, wantedArgs) {
  const existing = Array.isArray(existingArgs) ? existingArgs : [];
  const wanted = Array.isArray(wantedArgs) ? wantedArgs : [];
  const extra = existing.filter((a) => !isInstallerOwnedPath(root, a) && !wanted.includes(a));
  return extra.length ? [...wanted, ...extra] : wanted;
}

// specs 는 **클로드 몫만** 걸러 넘어온다(6종: 플레이라이트 + 문서 MCP 5).
function writeClaudeMcpServers(ctx, specs, { fs, root }) {
  // 전역 MCP 서버는 settings.json 이 아니라 `.claude.json` 최상위 mcpServers 에
  // 산다(T03 2절 — 이걸 몰라 설치기가 헛발질하기 쉬운 지점).
  const file = claudeConfigJsonPath(root);
  return mergeJson(fs, root, file, (data) => {
    const added = [];
    const servers = objectAt(data, 'mcpServers');
    for (const spec of specs) {
      const wanted = {
        type: 'stdio',
        command: spec.command,
        args: spec.args ?? [],
        env: spec.env ?? {},
      };
      const existing = servers[spec.name];
      if (existing !== undefined) {
        // 업데이트 예외(위 〈설치기 소유 판정〉): 우리가 쓴 줄이고 새 판에서
        // 경로가 달라졌을 때만 갱신한다. 그 사람이 바꿔 놓은 줄은 그대로.
        if (!isInstallerOwnedEntry(root, existing)) continue;
        // env는 병합(그 사람이 손으로 더한 키를 지우지 않는다), args는
        // 우리 소유 경로 부분만 새 값으로(그 사람이 더한 인자는 살린다).
        const merged = {
          ...existing,
          type: wanted.type,
          command: wanted.command,
          args: mergeOwnedArgs(root, existing.args, wanted.args),
          env: { ...(existing.env ?? {}), ...(wanted.env ?? {}) },
        };
        if (JSON.stringify(merged) === JSON.stringify(existing)) continue;
        servers[spec.name] = merged;
        added.push(`mcpServers.${spec.name}(updated)`);
        continue;
      }
      servers[spec.name] = wanted;
      added.push(`mcpServers.${spec.name}`);
    }
    return added;
  });
}

// ---------------------------------------------------------------------------
// 5. secrets
// ---------------------------------------------------------------------------

export const SECRETS_README = `# API 키 보관함

이 폴더의 \`.env\` 한 곳에서만 API 키를 관리한다. 형식은 한 줄에 하나씩 \`이름=값\`이다.

\`\`\`text
OPENAI_API_KEY=여기에-키를-붙여넣는다
ANTHROPIC_API_KEY=여기에-키를-붙여넣는다
\`\`\`

- 키는 **이 파일에 적지 않는다.** 여기는 이름 예시만 적는 안내문이다.
- 지침(AGENTS.md)·코드·로그에 키 원문을 넣지 않는다. 필요할 때 \`.env\`에서 읽어 쓴다.
- 키가 없어도 IRIS는 동작한다. 이미지 생성처럼 키가 필요한 기능만 대기 상태로 남는다.
`;

function writeSecrets(ctx, { fs, root }) {
  const dir = assertInside(root, path.join(root, '_agent', 'claude', 'secrets'));
  ensureDir(dir, { fs });
  const files = [];
  const env = assertInside(root, path.join(dir, '.env'));
  writeIfAbsent(env, '', { fs });
  files.push(env);
  const readme = assertInside(root, path.join(dir, 'README.md'));
  writeIfAbsent(readme, SECRETS_README, { fs });
  files.push(readme);
  return files;
}

// ---------------------------------------------------------------------------
// 6. 코덱스 config.toml
// ---------------------------------------------------------------------------

function writeCodexConfig(ctx, specs, { fs, root, log }) {
  // 승인·샌드박스 두 줄은 기존 헬퍼가 정본(최상위 키라 파일 맨 위에 들어간다).
  const perms = seedCodexPermissions(root);
  const file = assertInside(root, codexConfigTomlPath(root));

  let text = '';
  if (fs.existsSync(file)) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      log(`[adapters] config.toml 을 읽지 못해 그대로 두었습니다(${err.message})`);
      return { path: file, written: 'unchanged', added: [], permissions: perms.written, reason: `unreadable: ${err.message}` };
    }
  }

  const added = [];

  // ── 최상위 키: 첫 `[table]` 앞에 들어가야 한다(뒤에 적으면 그 테이블의 키가 된다).
  const topLines = [];
  if (!hasTopKey(text, 'project_root_markers')) {
    topLines.push(`project_root_markers = ${tomlValue(['soul-state.json'])}`);
    added.push('project_root_markers');
  }
  if (!hasTopKey(text, 'web_search')) {
    topLines.push(`web_search = ${tomlString('live')}`);
    added.push('web_search');
  }
  // 코덱스 0.154+ 는 hooks.json 이 새로 생기거나 바뀌면 첫 실행에 "Hooks need review"(신뢰 물음)를 띄운다.
  // 이 훅은 설치기가 직접 쓴 것이고 IRIS 세션은 최대 권한(approval never · danger-full-access)이 사용자 결정이므로
  // 같은 결정의 연장으로 훅 신뢰 물음도 건너뛴다(2026-09-19 데스크탑 실측, 2.0.25). `-c bypass_hook_trust=true` 와 같은 키.
  if (!hasTopKey(text, 'bypass_hook_trust')) {
    topLines.push('bypass_hook_trust = true');
    added.push('bypass_hook_trust');
  }
  if (topLines.length) {
    const block = `${topLines.join('\n')}\n`;
    text = text.length === 0 ? block : `${block}${text.startsWith('\n') ? text : `\n${text}`}`;
  }

  // ── [features] multi_agent — 테이블이 이미 있으면 그 안에 한 줄만 끼운다.
  if (!hasTableKey(text, 'features', 'multi_agent')) {
    const line = 'multi_agent = true';
    if (hasTable(text, 'features')) {
      const merged = insertIntoTable(text, 'features', line);
      if (merged) { text = merged; added.push('features.multi_agent'); }
    } else {
      text = `${endWithBlankLine(text)}[features]\n${line}\n`;
      added.push('features.multi_agent');
    }
  }

  // ── [windows] sandbox — 코덱스 0.154 는 윈도에서 첫 실행 때 "관리자 권한 샌드박스"를 만들려다
  // (UAC·로컬 사용자 생성·방화벽 규칙) 실패하면 "Couldn't set up your sandbox with Administrator permissions"
  // 물음을 띄운다(2026-09-19 실제 사용자 실측). IRIS 세션은 sandbox_mode = danger-full-access 라 샌드박스를
  // 쓰지 않으므로 관리자 설정 자체를 건너뛰게 "unelevated"(제한 토큰 방식)를 미리 적는다. 있으면 손대지 않는다.
  if (!hasTableKey(text, 'windows', 'sandbox')) {
    const line = 'sandbox = "unelevated"';
    if (hasTable(text, 'windows')) {
      const merged = insertIntoTable(text, 'windows', line);
      if (merged) { text = merged; added.push('windows.sandbox'); }
    } else {
      text = `${endWithBlankLine(text)}[windows]\n${line}\n`;
      added.push('windows.sandbox');
    }
  }

  // ── [mcp_servers.*] 7종 — 이미 있는 이름은 건드리지 않는다.
  // 예외 하나: 그 블록이 **우리가 쓴 것**(명령이 설치기 소유 폴더)이고 새 판에서
  // 경로가 달라졌으면 그 블록만 갈아 끼운다(업데이트가 되게 하는 최소한).
  for (const spec of specs) {
    if (hasTable(text, `mcp_servers.${spec.name}`)) {
      const updated = updateOwnedMcpTable(text, spec.name, mcpTomlBlock(spec), root);
      if (updated) {
        text = updated;
        added.push(`mcp_servers.${spec.name}(updated)`);
      }
      continue;
    }
    text = `${endWithBlankLine(text)}${mcpTomlBlock(spec)}`;
    added.push(`mcp_servers.${spec.name}`);
  }

  if (added.length === 0) {
    return { path: file, written: perms.written === 'unchanged' ? 'unchanged' : 'merged', added: perms.added ?? [], permissions: perms.written };
  }
  atomicWrite(fs, file, text);
  return { path: file, written: 'merged', added: [...(perms.added ?? []), ...added], permissions: perms.written };
}

function endWithBlankLine(text) {
  if (text.length === 0) return '';
  if (text.endsWith('\n\n')) return text;
  return text.endsWith('\n') ? `${text}\n` : `${text}\n\n`;
}

// ---------------------------------------------------------------------------
// 7. 코덱스 스킬
// ---------------------------------------------------------------------------

// T03 5절의 함정: 플러그인을 통째로 `skills\superpowers\` 에 복사하면
// SKILL.md 가 두 단계 더 깊어져 코덱스가 못 본다. 반드시 **스킬 하나씩**
// `skills\<스킬이름>\SKILL.md` 깊이로 풀어서 복사한다.
function copySuperpowersSkills(ctx, { fs, root, log }) {
  const src = toolDir(ctx, 'superpowers');
  const from = src ? path.join(src, 'skills') : null;
  if (!from || !fs.existsSync(from)) {
    log('[adapters] superpowers 스킬 폴더가 없어 코덱스 스킬 복사를 건너뜀');
    return { status: 'missing', source: from, copied: [], kept: 0 };
  }
  const dstRoot = assertInside(root, codexSkillsDir(root));
  ensureDir(dstRoot, { fs });
  const copied = [];
  let kept = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(from, entry.name);
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue; // 스킬이 아니다
    const dst = assertInside(root, path.join(dstRoot, entry.name));
    const r = copyTreeIfAbsent(skillDir, dst, { fs, root });
    if (r.written.length) copied.push(entry.name); else kept += 1;
  }
  return { status: 'ok', copied, kept };
}

// ---------------------------------------------------------------------------
// 8. UI/UX Pro Max (코덱스 스킬 생성기)
// ---------------------------------------------------------------------------

// 이 도구는 "스킬을 만들어 주는 프로그램"이라 파일 복사만으로는 끝나지 않는다.
// 오프라인으로 한 번 돌려 `<CODEX_HOME>\skills\` 에 스킬을 놓게 한다. 실패해도
// 설치를 멈추지 않는다 — 대기 기능 한 줄로 남긴다.
async function runUiUxProMax(ctx, { fs, root, log }) {
  const entry = toolEntry(ctx, 'ui-ux-pro-max');
  if (!entry || !fs.existsSync(entry)) return { status: 'skipped', reason: '도구가 꾸러미에 없음' };
  if (typeof ctx.run !== 'function') return { status: 'skipped', reason: '실행 헬퍼 없음' };
  const node = nodeExePath(root);
  const env = { ...(ctx.env ?? {}), CODEX_HOME: codexHomeDir(root) };
  try {
    const res = await ctx.run(node, [entry, 'init', '--ai', 'codex', '--offline'], { cwd: root, env });
    if (res && res.code !== 0) {
      log(`[adapters] UI/UX 스킬 생성기가 ${res.code} 로 끝났습니다(설치는 계속)`);
      return { status: 'failed', reason: `종료 코드 ${res.code}`, err: String(res.err ?? '').slice(0, 400) };
    }
    return { status: 'ok', out: String(res?.out ?? '').slice(0, 200) };
  } catch (e) {
    log(`[adapters] UI/UX 스킬 생성기를 돌리지 못했습니다(${e?.message ?? e})`);
    return { status: 'failed', reason: String(e?.message ?? e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// 9. 코덱스 훅
// ---------------------------------------------------------------------------

function writeCodexHooks(ctx, { fs, root }) {
  const file = assertInside(root, path.join(codexHomeDir(root), 'hooks.json'));
  const groups = codexHookConfig(root).hooks;
  return mergeJson(fs, root, file, (data) => {
    const added = [];
    mergeHooks(data, groups, added, 'hooks.', root);
    return added;
  });
}

// ---------------------------------------------------------------------------
// 10. 오피스·한컴 판정
// ---------------------------------------------------------------------------

// 준비 검사(③)가 이미 본 게 있으면 그걸 쓰고, 없으면 레지스트리를 직접 본다.
// 없다고 등록을 빼지는 않는다(D2-17) — 나중에 깔면 바로 쓰이게 두고 대기로만 알린다.
async function detectApps(ctx, { log }) {
  const pre = ctx?.precheck?.recorded ?? ctx?.precheck ?? {};
  const out = {
    office: typeof pre.office === 'boolean' ? pre.office : (pre.office?.present ?? null),
    hancom: typeof pre.hancom === 'boolean' ? pre.hancom : (pre.hancom?.present ?? null),
  };
  if (typeof ctx.run !== 'function') return out;

  const probe = async (keys) => {
    for (const key of keys) {
      try {
        const res = await ctx.run('reg', ['query', key], { env: ctx.env });
        if (res && res.code === 0) return true;
      } catch { /* 레지스트리를 못 읽으면 "모름"으로 둔다 */ }
    }
    return false;
  };

  try {
    if (out.office === null) {
      out.office = await probe(['HKLM\\SOFTWARE\\Microsoft\\Office', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Office']);
    }
    if (out.hancom === null) {
      out.hancom = await probe(['HKCR\\HWPFrame.HwpObject', 'HKLM\\SOFTWARE\\HNC', 'HKLM\\SOFTWARE\\WOW6432Node\\HNC']);
    }
  } catch (e) {
    log(`[adapters] 오피스·한컴 유무를 확인하지 못했습니다(${e?.message ?? e})`);
  }
  return out;
}
