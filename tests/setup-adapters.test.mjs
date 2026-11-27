import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as adapters from '../installer/setup/adapters.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_SRC = path.join(REPO, 'payload-src', 'policy', 'hooks');
// 진짜 잠금표를 그대로 쓴다: dest·entry·env 가 바뀌면 이 시험이 먼저 깨져야 한다.
const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, 'lock.json'), 'utf8'));

const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-t16-adapt-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const under = (root, rel) => path.join(root, String(rel).split('/').join(path.sep));

// ⑤-1 풀기가 끝난 상태를 흉내 낸다: 잠금표 dest 에 도구 폴더가 이미 있다.
function makeTools(root, { withDocumentSkills = false, withUiUx = false } = {}) {
  const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

  const sp = under(root, LOCK.parts.superpowers.dest);
  put(path.join(sp, '.claude-plugin', 'plugin.json'), '{"name":"superpowers","version":"6.3.0"}\n');
  for (const skill of ['brainstorming', 'systematic-debugging', 'writing-plans']) {
    put(path.join(sp, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n# ${skill}\n`);
  }
  put(path.join(sp, 'skills', 'writing-plans', 'reviewer.md'), '# reviewer\n');
  fs.mkdirSync(path.join(sp, 'skills', '.not-a-skill'), { recursive: true }); // SKILL.md 없음 → 건너뛰어야

  const si = under(root, LOCK.parts['self-improve'].dest);
  put(path.join(si, '.claude-plugin', 'plugin.json'), '{"name":"self-improve","version":"0.2.0"}\n');
  put(path.join(si, 'server', 'index.js'), '// server\n');

  put(path.join(under(root, LOCK.parts['frontend-design'].dest), '.claude-plugin', 'plugin.json'), '{"name":"frontend-design"}\n');
  put(path.join(under(root, LOCK.parts['insane-search'].dest), '.claude-plugin', 'plugin.json'), '{"name":"insane-search"}\n');

  put(path.join(under(root, LOCK.parts['playwright-mcp'].dest), ...LOCK.parts['playwright-mcp'].entry.split('/')), '// cli\n');
  for (const id of ['hwp-automation', 'excel-automation', 'ppt-automation', 'word-automation', 'pdf-automation']) {
    put(path.join(under(root, LOCK.parts[id].dest), 'server.py'), '# server\n');
  }
  if (withDocumentSkills) {
    put(path.join(under(root, LOCK.parts['document-skills'].dest), '.claude-plugin', 'plugin.json'), '{"name":"document-skills"}\n');
    put(path.join(under(root, LOCK.parts['document-skills'].dest), 'skills', 'xlsx', 'SKILL.md'), '# xlsx\n');
  }
  if (withUiUx) {
    put(path.join(under(root, LOCK.parts['ui-ux-pro-max'].dest), ...LOCK.parts['ui-ux-pro-max'].entry.split('/')), '// ui-ux\n');
  }
  // 훅 스크립트는 ⑤-1 이 `_agent\claude\scripts` 로 풀지만, 이 시험은 풀기 전
  // 상태(= payload\policy\hooks 에서 복사)를 확인한다.
}

function makePayload(label) {
  const dir = path.join(tmp, label, 'payload');
  fs.mkdirSync(path.join(dir, 'policy', 'hooks'), { recursive: true });
  for (const f of fs.readdirSync(HOOKS_SRC)) {
    fs.copyFileSync(path.join(HOOKS_SRC, f), path.join(dir, 'policy', 'hooks', f));
  }
  return dir;
}

function makeCtx(label, { apps = {}, edge = true, tools = {}, precheck } = {}) {
  const root = path.join(tmp, label, 'soul-IRIS');
  fs.mkdirSync(root, { recursive: true });
  makeTools(root, tools);
  const logs = [];
  const runCalls = [];
  return {
    root,
    payloadDir: makePayload(label),
    manifest: { schema: 1, package: { version: '2.0.0' }, parts: {} },
    lock: LOCK,
    choice: { subscriptions: ['claude'], leadAgent: 'claude' },
    precheck: precheck ?? { edge: { present: edge } },
    offline: true,
    log: (line) => logs.push(line),
    progress: () => {},
    run: async (exe, args) => {
      runCalls.push([exe, ...args]);
      if (exe === 'reg') {
        const key = String(args[1] ?? '');
        const isOffice = /Microsoft\\Office/i.test(key);
        const want = isOffice ? apps.office : apps.hancom;
        return { code: want ? 0 : 1, out: '', err: '' };
      }
      return { code: 0, out: 'ok', err: '' };
    },
    fs,
    env: { PATH: 'X' },
    logs,
    runCalls,
  };
}

function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const here = rel ? path.join(dir, rel) : dir;
    for (const e of fs.readdirSync(here, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { out[`${childRel}\\`] = 'dir'; walk(childRel); continue; }
      const st = fs.statSync(path.join(dir, childRel));
      out[childRel] = `${st.size}:${st.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, childRel))).digest('hex')}`;
    }
  };
  walk('');
  return out;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const agentFile = (root, ...segs) => path.join(root, '_agent', ...segs);

// ---------------------------------------------------------------------------

test('adapters: 빈 루트 -> 클로드 설정 5파일 + 코덱스 설정 2파일을 만든다', async () => {
  const ctx = makeCtx('fresh', { apps: { office: true, hancom: true } });
  const { recorded, pending } = await adapters.run(ctx);
  const root = ctx.root;

  // --- 파일 목록 스냅샷(경로) ------------------------------------------
  const expected = [
    ['claude', 'settings.json'],
    ['claude', '.claude.json'],
    ['claude', 'plugins', 'known_marketplaces.json'],
    ['claude', 'plugins', 'installed_plugins.json'],
    ['claude', 'plugins', 'marketplaces', 'iris-local', '.claude-plugin', 'marketplace.json'],
    ['claude', 'scripts', 'block-blanket-kill.ps1'],
    ['claude', 'scripts', 'guard-iris-path.py'],
    ['claude', 'scripts', 'bg-leftover-guard.py'],
    ['claude', 'secrets', '.env'],
    ['claude', 'secrets', 'README.md'],
    ['codex', 'config.toml'],
    ['codex', 'hooks.json'],
    ['shared', 'tools', 'playwright-mcp', 'playwright-mcp.cmd'],
  ];
  for (const segs of expected) assert.ok(fs.existsSync(agentFile(root, ...segs)), `없음: ${segs.join('\\')}`);

  // --- settings.json ----------------------------------------------------
  const settings = readJson(agentFile(root, 'claude', 'settings.json'));
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.equal(settings.env.ENABLE_TOOL_SEARCH, 'true');
  assert.equal(settings.env.SUPERPOWERS_DISABLE_TELEMETRY, '1');
  // 플러그인이 스스로 띄우는 self-improve 서버도 같은 창고를 보게 한다
  assert.equal(settings.env.SELF_IMPROVE_DIR, under(root, '_agent/shared/self-improvement'));
  assert.equal(settings.cleanupPeriodDays, adapters.CLEANUP_PERIOD_DAYS);
  assert.ok(settings.cleanupPeriodDays >= 365);

  // 훅 3종: 일괄 킬·경로 가드·신선도
  const pre = settings.hooks.PreToolUse;
  assert.equal(pre.length, 2);
  assert.equal(pre[0].matcher, 'Bash|PowerShell');
  assert.match(pre[0].hooks[0].command, /powershell -NoProfile -ExecutionPolicy Bypass -File ".*block-blanket-kill\.ps1"/);
  assert.equal(pre[1].matcher, 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell');
  assert.ok(pre[1].hooks[0].command.includes(path.join(root, '_agent', 'shared', 'shims', 'python.cmd')));
  assert.ok(pre[1].hooks[0].command.includes('guard-iris-path.py'));
  const start = settings.hooks.SessionStart;
  assert.equal(start.length, 2);
  assert.ok(start[0].hooks[0].command.includes(path.join(root, '_ontology', 'check_fresh.py')));
  // 2.0.65: 로그인 열쇠 알림 — 동봉 node 로 부품 iris-auth 의 status.mjs --hook 을 부른다(따로 둔 항목, 10초 제한)
  assert.equal(start[1].matcher, 'startup|resume|clear|compact');
  assert.equal(start[1].hooks.length, 1);
  // 알리기만 하는 훅이라 어떤 경우에도 종료 코드 0 · 오류 글 없음 — 세션 시작 화면에 오류 줄을 남기지 않는다.
  // 오래 걸려도 그렇다: 바깥 제한(10초)보다 짧은 안쪽 제한(6초)으로 node 를 직접 끊고 0 으로 마친다.
  const notice = start[1].hooks[0].command;
  assert.ok(notice.includes(`$p.StartInfo.FileName = '${path.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe')}';`));
  assert.ok(notice.includes(`$p.StartInfo.Arguments = '"${under(root, `${LOCK.parts['iris-auth'].dest}/status.mjs`)}" --hook';`));
  assert.ok(notice.includes('$p.WaitForExit(6000)') && notice.includes('$p.Kill()'));
  assert.ok(notice.endsWith('} catch { }; exit 0'));
  assert.equal(start[1].hooks[0].timeout, 10);
  // Node 를 띄우는 자리: 윈도우 인증서 목록도 믿게 — 비어 있을 때만 채운다(사용자가 정한 값은 덮지 않는다)
  assert.ok(notice.startsWith("if (-not $env:NODE_USE_SYSTEM_CA) { $env:NODE_USE_SYSTEM_CA = '1' }; try { $ErrorActionPreference = 'Stop'; "));
  // 2.0.42: 안 끈 배경 명령 가드(클로드 전용 Stop 훅, matcher 없음)
  const stop = settings.hooks.Stop;
  assert.equal(stop.length, 1);
  assert.equal(stop[0].matcher, undefined);
  assert.ok(stop[0].hooks[0].command.includes(path.join(root, '_agent', 'shared', 'shims', 'python.cmd')));
  assert.ok(stop[0].hooks[0].command.includes('bg-leftover-guard.py'));
  // 새 PC 에는 시스템 파이썬이 없다 -> 맨 `python` 으로 시작하면 안 된다
  for (const group of [...pre, ...start, ...stop]) {
    for (const h of group.hooks) assert.ok(!/^python\b/.test(h.command), `shim 절대경로가 아님: ${h.command}`);
  }
  // 2.0.55: Git Bash 없는 PC(동봉 MinGit 엔 bash.exe 없음)에서도 돌게 파워셸 고정 + 차단(2)이 1로 뭉개지지 않게 종료 코드 전달
  for (const group of [...pre, ...start, ...stop]) {
    for (const h of group.hooks) {
      assert.equal(h.shell, 'powershell', `훅 실행 껍데기: ${h.command}`);
      assert.ok(!/^"/.test(h.command), `파워셸에서 "a" "b" 꼴은 문법 오류: ${h.command}`);
    }
  }
  // 막는 훅 넷은 스크립트의 종료 코드를 그대로 넘긴다(차단 2 가 살아야 한다). 알리기만 하는 훅(2.0.65)만 늘 0 이다.
  for (const group of [...pre, start[0], ...stop]) {
    for (const h of group.hooks) assert.ok(h.command.endsWith('; exit $LASTEXITCODE'), `종료 코드 전달: ${h.command}`);
  }
  assert.ok(!start[1].hooks[0].command.includes('$LASTEXITCODE'), '알림 훅은 프로그램의 종료 코드를 넘기지 않는다');

  // 플러그인 4종이 켜져 있고 document-skills 는 없다
  assert.deepEqual(Object.keys(settings.enabledPlugins).sort(), [
    'frontend-design@iris-local', 'insane-search@iris-local', 'self-improve@iris-local', 'superpowers@iris-local',
  ]);
  assert.equal(settings.extraKnownMarketplaces['iris-local'].source.source, 'directory');
  assert.equal(settings.extraKnownMarketplaces['iris-local'].source.path, adapters.marketplaceDir(root));

  // --- 플러그인 3파일 + 캐시 복사본 --------------------------------------
  const known = readJson(agentFile(root, 'claude', 'plugins', 'known_marketplaces.json'));
  assert.equal(known['iris-local'].source.source, 'directory');
  assert.equal(known['iris-local'].installLocation, adapters.marketplaceDir(root));
  assert.ok(typeof known['iris-local'].lastUpdated === 'string');

  const installed = readJson(agentFile(root, 'claude', 'plugins', 'installed_plugins.json'));
  assert.equal(installed.version, 2);
  const entry = installed.plugins['superpowers@iris-local'][0];
  assert.equal(entry.scope, 'user');
  assert.equal(entry.version, '6.3.0');
  assert.equal(entry.installPath, adapters.pluginCacheDir(root, 'superpowers', '6.3.0'));
  assert.ok(fs.existsSync(path.join(entry.installPath, '.claude-plugin', 'plugin.json')), '캐시가 실제 복사본이어야 한다');
  // 심링크가 아니라 진짜 파일
  assert.ok(fs.lstatSync(path.join(entry.installPath, '.claude-plugin', 'plugin.json')).isFile());

  const market = readJson(agentFile(root, 'claude', 'plugins', 'marketplaces', 'iris-local', '.claude-plugin', 'marketplace.json'));
  assert.equal(market.name, 'iris-local');
  assert.ok(market.owner);
  assert.deepEqual(market.plugins.map((p) => p.name).sort(), ['frontend-design', 'insane-search', 'self-improve', 'superpowers']);
  for (const p of market.plugins) {
    assert.ok(typeof p.source === 'string' && p.source.length, `source 없음: ${p.name}`);
    assert.ok(fs.existsSync(path.resolve(agentFile(root, 'claude', 'plugins', 'marketplaces', 'iris-local'), p.source)), `source 가 실제 폴더를 가리켜야: ${p.name}`);
  }

  // --- .claude.json mcpServers (6종: self-improve 는 플러그인이 띄운다) ----
  const cj = readJson(agentFile(root, 'claude', '.claude.json'));
  assert.deepEqual(Object.keys(cj.mcpServers).sort(), [
    'excel-automation', 'hwp-automation', 'pdf-automation', 'playwright', 'ppt-automation', 'word-automation',
  ]);
  assert.equal(cj.mcpServers.playwright.type, 'stdio');
  assert.equal(cj.mcpServers.playwright.command, adapters.playwrightWrapper(root));
  assert.equal(cj.mcpServers.playwright.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
  for (const name of ['hwp-automation', 'excel-automation', 'ppt-automation', 'word-automation', 'pdf-automation']) {
    assert.equal(cj.mcpServers[name].command, adapters.venvPythonPath(root), `${name} 은 venv 파이썬으로`);
    assert.match(cj.mcpServers[name].args[0], /server\.py$/);
  }

  // 플레이라이트 래퍼: 엣지 채널 + 작업 폴더 고정, ASCII·CRLF
  const wrap = fs.readFileSync(adapters.playwrightWrapper(root), 'utf8');
  assert.match(wrap, /--browser msedge/);
  assert.match(wrap, /cd \/d "%~dp0work"/);
  assert.ok(wrap.includes('\r\n'));
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(wrap), '래퍼는 ASCII 만');
  assert.ok(fs.existsSync(adapters.playwrightWorkDir(root)));

  // --- secrets -----------------------------------------------------------
  assert.equal(fs.readFileSync(agentFile(root, 'claude', 'secrets', '.env'), 'utf8'), '');
  const readme = fs.readFileSync(agentFile(root, 'claude', 'secrets', 'README.md'), 'utf8');
  assert.ok(readme.includes('OPENAI_API_KEY') && readme.includes('ANTHROPIC_API_KEY'));

  // --- 코덱스 config.toml -------------------------------------------------
  const toml = fs.readFileSync(agentFile(root, 'codex', 'config.toml'), 'utf8');
  const firstTable = toml.search(/^\s*\[/m);
  const top = toml.slice(0, firstTable);
  for (const key of ['approval_policy', 'sandbox_mode', 'project_root_markers', 'web_search', 'bypass_hook_trust']) {
    assert.ok(new RegExp(`^${key} = `, 'm').test(top), `최상위 키가 첫 [table] 위에 없음: ${key}`);
  }
  assert.match(top, /project_root_markers = \["soul-state\.json"\]/);
  assert.match(top, /web_search = "live"/);
  assert.match(toml, /\[features\]\nmulti_agent = true/);
  // 2026-09-19: 윈도 샌드박스는 관리자 설정 없이(unelevated) — "Couldn't set up your sandbox with Administrator permissions" 물음 예방
  assert.match(toml, /\[windows\]\nsandbox = "unelevated"/);
  // 2.0.49(2026-10-27): 코덱스 = 중계기 주소 직접 지정 + 웹소켓 끔(가로채기 길의 "Reconnecting 5/5" 와 0.163+ 실패 대체)
  assert.match(top, /^model_provider = "iris"$/m);
  assert.match(toml, /\[model_providers\.iris\]\nname = "OpenAI"\nbase_url = "http:\/\/127\.0\.0\.1:3456\/backend-api\/codex"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n/);
  // 2026-09-19: 첫 실행 물음(폴더 신뢰) 선답 — v2 엔진이 빠뜨려 2.0.0~2.0.19 신규 설치에서 영어 물음이 떴다
  assert.match(toml, /\[projects\.'[^']+'\]\ntrust_level = "trusted"/);
  assert.equal(recorded.codex.firstRun.written, 'appended', 'config.toml 은 6단계가 먼저 만들었으니 신뢰 표는 덧붙는다');
  const claudeJson = JSON.parse(fs.readFileSync(agentFile(root, 'claude', '.claude.json'), 'utf8'));
  assert.equal(claudeJson.hasCompletedOnboarding, true);
  const trustKey = Object.keys(claudeJson.projects ?? {}).find((k) => claudeJson.projects[k]?.hasTrustDialogAccepted === true);
  assert.ok(trustKey && !trustKey.includes('\\'), `클로드 신뢰 키(슬래시)가 없음: ${JSON.stringify(Object.keys(claudeJson.projects ?? {}))}`);
  assert.ok(['created', 'merged'].includes(recorded.claude.firstRun.written), recorded.claude.firstRun.written);
  for (const name of ['playwright', 'self-improve', 'hwp-automation', 'excel-automation', 'ppt-automation', 'word-automation', 'pdf-automation']) {
    assert.ok(adapters.hasTable(toml, `mcp_servers.${name}`), `코덱스 MCP 없음: ${name}`);
  }
  assert.match(toml, /\[mcp_servers\.self-improve\.env\]\nSELF_IMPROVE_DIR = "/);
  assert.ok(toml.includes('\\\\'), 'TOML 문자열의 역슬래시는 두 번 적어야 한다');

  // --- 코덱스 스킬: 플러그인 통째로가 아니라 스킬 단위(T03 5절) -----------
  const skills = agentFile(root, 'codex', 'skills');
  assert.deepEqual(fs.readdirSync(skills).sort(), ['brainstorming', 'systematic-debugging', 'writing-plans']);
  assert.ok(fs.existsSync(path.join(skills, 'brainstorming', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(skills, 'superpowers')), '플러그인 통째 복사 금지');
  assert.ok(fs.existsSync(path.join(skills, 'writing-plans', 'reviewer.md')), '스킬 안 자료도 함께');

  // --- 코덱스 훅 ---------------------------------------------------------
  const chooks = readJson(agentFile(root, 'codex', 'hooks.json'));
  assert.equal(chooks.hooks.PreToolUse.length, 2);
  assert.ok(chooks.hooks.PreToolUse[1].hooks[0].command.startsWith('& "'));
  assert.equal(chooks.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  // 2.0.65: 로그인 열쇠 알림 훅은 클로드에만 건다 — 코덱스 훅 파일은 한 글자도 늘지 않는다(바뀌면 코덱스가 훅 신뢰를 다시 묻는 길에 닿는다)
  assert.equal(chooks.hooks.SessionStart.length, 1);
  assert.deepEqual(Object.keys(chooks.hooks).sort(), ['PreToolUse', 'SessionStart']);
  assert.ok(!fs.readFileSync(agentFile(root, 'codex', 'hooks.json'), 'utf8').includes('status.mjs'));

  // --- recorded / pending ------------------------------------------------
  assert.equal(recorded.claude.mcp.length, 6);
  assert.deepEqual(recorded.claude.mcpViaPlugin, ['self-improve']);
  assert.equal(recorded.codex.mcp.length, 7);
  assert.deepEqual(recorded.codex.skills.copied.sort(), ['brainstorming', 'systematic-debugging', 'writing-plans']);
  assert.equal(recorded.apps.office, true);
  assert.equal(recorded.apps.hancom, true);
  // 오피스·한컴·엣지가 다 있으면 남는 대기는 document-skills 와 UI/UX 둘뿐
  assert.deepEqual(pending.map((p) => p.capability).sort(), ['문서 작성 스킬(엑셀·워드·PPT·PDF)', '코덱스 UI/UX 스킬']);
  for (const p of pending) assert.ok(typeof p.reason === 'string' && p.reason.length > 5);
});

test('adapters: self-improve 는 클로드엔 안 적고(플러그인이 띄움) 코덱스엔 적는다', async () => {
  const ctx = makeCtx('selfimprove', { apps: { office: true, hancom: true } });
  const { recorded } = await adapters.run(ctx);
  const root = ctx.root;

  // 클로드: `.claude.json` 에 없다 -- 플러그인 자신의 .mcp.json 이 같은 서버를
  // 띄우므로 여기에도 적으면 같은 도구가 두 벌 뜬다(2026-09-15 실측).
  const cj = readJson(agentFile(root, 'claude', '.claude.json'));
  assert.equal(cj.mcpServers['self-improve'], undefined);
  assert.equal(Object.keys(cj.mcpServers).length, 6);
  assert.ok(!recorded.claude.mcp.includes('self-improve'));
  assert.deepEqual(recorded.claude.mcpViaPlugin, ['self-improve']);
  // 대신 플러그인은 등록돼 있고, 기록 창고를 이어 주는 다리가 있다
  assert.equal(readJson(agentFile(root, 'claude', 'settings.json')).enabledPlugins['self-improve@iris-local'], true);
  assert.equal(readJson(agentFile(root, 'claude', 'settings.json')).env.SELF_IMPROVE_DIR, under(root, '_agent/shared/self-improvement'));

  // 코덱스: 플러그인 체계가 없으므로 stdio 등록이 유일한 길
  const toml = fs.readFileSync(agentFile(root, 'codex', 'config.toml'), 'utf8');
  assert.ok(adapters.hasTable(toml, 'mcp_servers.self-improve'));
  assert.ok(toml.includes(under(root, `${LOCK.parts['self-improve'].dest}/server/index.js`).replace(/\\/g, '\\\\')));
  assert.match(toml, /\[mcp_servers\.self-improve\.env\]\nSELF_IMPROVE_DIR = "/);
  assert.equal(recorded.codex.mcp.length, 7);
  assert.ok(recorded.codex.mcp.includes('self-improve'));
});

test('adapters: 두 번 실행해도 변경 0', async () => {
  const ctx = makeCtx('twice', { apps: { office: true, hancom: true } });
  await adapters.run(ctx);
  const before = snapshot(path.join(ctx.root, '_agent'));
  const second = await adapters.run(ctx);
  const after2 = snapshot(path.join(ctx.root, '_agent'));
  assert.deepEqual(after2, before, '두 번째 실행이 파일을 건드렸다');
  // 세 번째도 같아야 한다
  await adapters.run(ctx);
  assert.deepEqual(snapshot(path.join(ctx.root, '_agent')), before);
  assert.equal(second.recorded.claude.mcp.length, 6);
});

test('adapters(2.0.49): 업데이트 = 옛 config.toml 에 provider iris 를 더하고, 사람이 고른 model_provider 는 그대로', async () => {
  const old = makeCtx('provider-add');
  fs.mkdirSync(agentFile(old.root, 'codex'), { recursive: true });
  fs.writeFileSync(agentFile(old.root, 'codex', 'config.toml'), 'model = "gpt-6"\n\n[features]\nmulti_agent = true\n');
  await adapters.run(old);
  const t1 = fs.readFileSync(agentFile(old.root, 'codex', 'config.toml'), 'utf8');
  assert.match(t1.slice(0, t1.search(/^\s*\[/m)), /^model_provider = "iris"$/m, '옛 설정(기본 provider)에도 더해진다');
  assert.equal((t1.match(/\[model_providers\.iris\]/g) || []).length, 1);
  await adapters.run(old);
  assert.equal(fs.readFileSync(agentFile(old.root, 'codex', 'config.toml'), 'utf8'), t1, '두 번째 실행은 그대로');

  const mine = makeCtx('provider-keep');
  fs.mkdirSync(agentFile(mine.root, 'codex'), { recursive: true });
  fs.writeFileSync(agentFile(mine.root, 'codex', 'config.toml'), 'model_provider = "mine"\n\n[model_providers.mine]\nbase_url = "http://x"\n');
  await adapters.run(mine);
  const t2 = fs.readFileSync(agentFile(mine.root, 'codex', 'config.toml'), 'utf8');
  assert.match(t2, /^model_provider = "mine"$/m);
  assert.ok(!/^model_provider = "iris"$/m.test(t2), '사람이 고른 provider 를 바꾸지 않는다');
});

test('adapters(2.0.54): config.toml 을 바꾸면 바꾸기 전 사본 + 이력 한 줄(연결 이름 전후, 비밀값 없음), 안 바뀌면 이력도 없음', async () => {
  const ctx = makeCtx('cfg-history');
  fs.mkdirSync(agentFile(ctx.root, 'codex'), { recursive: true });
  const before = 'model = "gpt-6"\n\n[features]\nmulti_agent = true\n';
  fs.writeFileSync(agentFile(ctx.root, 'codex', 'config.toml'), before);
  await adapters.run(ctx);
  const dir = adapters.configHistoryDir(ctx.root);
  const lines = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].added.includes('model_provider'));
  assert.deepEqual({ from: lines[0].connection.from, to: lines[0].connection.to }, { from: 'openai(코덱스 기본)', to: 'iris' });
  assert.equal(fs.readFileSync(path.join(ctx.root, lines[0].backup), 'utf8'), before, '사본 = 바꾸기 전 그대로');
  assert.ok(!/token|apiKey|sk-/i.test(JSON.stringify(lines[0])), '이력에 비밀값 없음');
  await adapters.run(ctx);
  assert.equal(fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').length, 1, '안 바뀐 두 번째 실행은 이력을 더하지 않는다');
  assert.equal(adapters.topModelProvider('model_provider = "x"\n[t]\nmodel_provider = "y"\n'), 'x');
  assert.equal(adapters.topModelProvider('[t]\nmodel_provider = "y"\n'), null);
});

test('adapters: 기존 설정의 다른 키·훅·MCP 를 보존한다', async () => {
  const ctx = makeCtx('existing', { apps: { office: true, hancom: true } });
  const root = ctx.root;

  fs.mkdirSync(agentFile(root, 'claude'), { recursive: true });
  fs.writeFileSync(agentFile(root, 'claude', 'settings.json'), `${JSON.stringify({
    statusLine: { type: 'command', command: 'mine.ps1' },
    cleanupPeriodDays: 7,
    env: { ENABLE_TOOL_SEARCH: 'false', MY_KEY: 'keep' },
    permissions: { defaultMode: 'acceptEdits', allow: ['Bash(ls:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    enabledPlugins: { 'mine@somewhere': true },
  }, null, 2)}\n`);
  fs.writeFileSync(agentFile(root, 'claude', '.claude.json'), `${JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: { playwright: { type: 'stdio', command: 'mine.exe', args: [] }, mine: { type: 'stdio', command: 'x' } },
  }, null, 2)}\n`);
  fs.mkdirSync(agentFile(root, 'codex'), { recursive: true });
  fs.writeFileSync(agentFile(root, 'codex', 'config.toml'),
    'model = "gpt-6"\nweb_search = "off"\n\n[features]\nenable_request_compression = false\n\n'
    + '[mcp_servers.playwright]\ncommand = "mine.exe"\n');

  const { recorded } = await adapters.run(ctx);

  const settings = readJson(agentFile(root, 'claude', 'settings.json'));
  assert.deepEqual(settings.statusLine, { type: 'command', command: 'mine.ps1' });
  assert.equal(settings.cleanupPeriodDays, 7, '있는 값은 덮지 않는다');
  assert.equal(settings.env.ENABLE_TOOL_SEARCH, 'false', '있는 값은 덮지 않는다');
  assert.equal(settings.env.MY_KEY, 'keep');
  // 권한 모드만은 예외다: 더 약한 모드는 최대로 올린다(2026-09-14 사용자 결정,
  // 기존 `seedClaudePermissions` 의 계약 — tests/firstrun.test.mjs 가 정본).
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
  assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)']);
  assert.equal(settings.enabledPlugins['mine@somewhere'], true);
  assert.equal(settings.enabledPlugins['superpowers@iris-local'], true);
  // 기존 훅은 맨 앞에 그대로, 우리 훅은 뒤에 추가
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.equal(settings.hooks.PreToolUse.length, 3);

  const cj = readJson(agentFile(root, 'claude', '.claude.json'));
  assert.equal(cj.hasCompletedOnboarding, true);
  assert.equal(cj.mcpServers.playwright.command, 'mine.exe', '같은 이름 MCP 는 덮지 않는다');
  assert.equal(cj.mcpServers.mine.command, 'x');
  assert.equal(Object.keys(cj.mcpServers).length, 7);

  const toml = fs.readFileSync(agentFile(root, 'codex', 'config.toml'), 'utf8');
  assert.equal((toml.match(/^web_search = /gm) ?? []).length, 1);
  assert.match(toml, /web_search = "off"/, '있는 값은 덮지 않는다');
  assert.match(toml, /model = "gpt-6"/);
  assert.match(toml, /\[mcp_servers\.playwright\]\ncommand = "mine\.exe"/);
  assert.equal((toml.match(/\[mcp_servers\.playwright\]/g) ?? []).length, 1);
  // [features] 가 이미 있으면 그 안에 한 줄만 들어간다
  assert.match(toml, /\[features\]\nmulti_agent = true\nenable_request_compression = false/);
  assert.equal((toml.match(/\[features\]/g) ?? []).length, 1);
  // 최상위 키는 여전히 첫 테이블 위
  const top = toml.slice(0, toml.search(/^\s*\[/m));
  assert.match(top, /project_root_markers = /);
  assert.ok(recorded.codex.config.added.includes('project_root_markers'));

  // 이 상태에서 한 번 더 -> 변경 0
  const before = snapshot(path.join(root, '_agent'));
  await adapters.run(ctx);
  assert.deepEqual(snapshot(path.join(root, '_agent')), before);
});

// ---------------------------------------------------------------------------
// 업데이트(--auto): "설치기 소유 항목만" 새 판 경로로 갱신
// ---------------------------------------------------------------------------
//
// 기본 규칙은 여전히 "없는 키만 추가"다(위 시험들이 그것을 지킨다). 예외는 딱
// 하나 — 명령·경로가 `_agent\shared\tools` 또는 `_agent\claude\scripts` 아래를
// 가리키는 **우리가 쓴 항목**. 그 줄까지 못 고치면 업데이트가 부품만 새로 놓고
// 설정은 옛 판 폴더를 가리킨 채로 남아 MCP 서버가 통째로 죽는다.

// 새 판 잠금표: 판 폴더 이름이 달라진 부품 몇 개 + 그 폴더를 실제로 만들어 둔다.
function bumpLock(root, changes) {
  const next = JSON.parse(JSON.stringify(LOCK));
  for (const [id, change] of Object.entries(changes)) {
    const dest = typeof change === 'string' ? change : change.dest;
    next.parts[id].dest = dest;
    if (typeof change === 'object' && change.version) next.parts[id].version = change.version;
    const dir = under(root, dest);
    fs.mkdirSync(dir, { recursive: true });
    const entry = next.parts[id].entry;
    if (entry) {
      const f = path.join(dir, ...entry.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '// new version\n');
    } else {
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), `{"name":"${id}"}\n`);
      fs.mkdirSync(path.join(dir, 'skills', 'brainstorming'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\n---\n');
    }
  }
  return next;
}

test('adapters(업데이트): 우리가 쓴 MCP 항목은 새 판 경로로 갱신하고, 그 사람이 바꾼 항목은 그대로 둔다', async () => {
  const ctx = makeCtx('update-mcp', { apps: { office: true, hancom: true } });
  const root = ctx.root;
  await adapters.run(ctx);

  // 그 사람이 손본 것 둘: 우리 이름이지만 자기 파이썬을 쓰는 항목 + 자기 서버.
  const cjPath = agentFile(root, 'claude', '.claude.json');
  const cj0 = readJson(cjPath);
  cj0.mcpServers['hwp-automation'] = { type: 'stdio', command: 'C:\\my\\python.exe', args: ['C:\\my\\hwp.py'], env: {} };
  cj0.mcpServers.mine = { type: 'stdio', command: 'C:\\my\\thing.exe', args: [] };
  fs.writeFileSync(cjPath, `${JSON.stringify(cj0, null, 2)}\n`);

  const tomlPath = agentFile(root, 'codex', 'config.toml');
  const toml0 = fs.readFileSync(tomlPath, 'utf8');
  assert.match(toml0, /\[mcp_servers\.self-improve\]/);

  // 새 판: self-improve · pdf-automation 의 판 폴더가 바뀌었다.
  const nextLock = bumpLock(root, {
    'self-improve': '_agent/shared/tools/self-improve/9.9.9',
    'pdf-automation': '_agent/shared/tools/document-mcp/pdf/newhash',
  });
  await adapters.run({ ...ctx, lock: nextLock });

  const cj = readJson(cjPath);
  assert.match(cj.mcpServers['pdf-automation'].args[0], /pdf[\\/]newhash/, '우리 항목은 새 판 경로를 가리켜야 한다');
  assert.equal(cj.mcpServers['hwp-automation'].command, 'C:\\my\\python.exe', '그 사람이 바꾼 항목은 그대로');
  assert.deepEqual(cj.mcpServers['hwp-automation'].args, ['C:\\my\\hwp.py']);
  assert.equal(cj.mcpServers.mine.command, 'C:\\my\\thing.exe', '그 사람이 더한 항목은 그대로');

  const toml = fs.readFileSync(tomlPath, 'utf8');
  assert.match(toml, /self-improve[\\\\]+9\.9\.9/, '코덱스 쪽도 새 판 경로');
  assert.equal((toml.match(/\[mcp_servers\.self-improve\]/g) ?? []).length, 1, '블록이 늘어나면 안 된다');
  assert.equal((toml.match(/\[mcp_servers\.pdf-automation\]/g) ?? []).length, 1);
  assert.match(toml, /\[mcp_servers\.self-improve\.env\]/, '하위 env 테이블도 함께 갈아 끼운다');

  // 같은 판으로 한 번 더 -> 변경 0 (갱신이 멱등을 깨지 않는다)
  const before = snapshot(path.join(root, '_agent'));
  await adapters.run({ ...ctx, lock: nextLock });
  assert.deepEqual(snapshot(path.join(root, '_agent')), before);
});

test('adapters(업데이트, Task 24b #2): 우리가 쓴 MCP 항목을 갱신해도 그 사람이 손으로 더한 env 키·args 인자는 지워지지 않는다(JSON)', async () => {
  const ctx = makeCtx('update-mcp-env-keep', { apps: { office: true, hancom: true } });
  const root = ctx.root;
  await adapters.run(ctx);

  const cjPath = agentFile(root, 'claude', '.claude.json');
  const cj0 = readJson(cjPath);
  // pdf-automation 은 우리 항목(venv 파이썬). 그 사람이 env 에 키를 더하고
  // args 끝에 자기 플래그를 붙였다고 가정한다.
  cj0.mcpServers['pdf-automation'].env.MY_KEY = 'user-added';
  cj0.mcpServers['pdf-automation'].args.push('--verbose');
  fs.writeFileSync(cjPath, `${JSON.stringify(cj0, null, 2)}\n`);

  // 새 판: pdf-automation 의 판 폴더가 바뀐다(우리 관리 인자만 바뀌어야 한다).
  const nextLock = bumpLock(root, { 'pdf-automation': '_agent/shared/tools/document-mcp/pdf/newhash2' });
  await adapters.run({ ...ctx, lock: nextLock });

  const cj = readJson(cjPath);
  const pdf = cj.mcpServers['pdf-automation'];
  assert.match(pdf.args[0], /pdf[\\/]newhash2/, '우리 관리 인자(진입 경로)는 새 판으로 갱신된다');
  assert.equal(pdf.args.includes('--verbose'), true, '그 사람이 더한 인자는 지워지지 않는다');
  assert.equal(pdf.env.PYTHONUTF8, '1', '우리 env 키는 그대로');
  assert.equal(pdf.env.MY_KEY, 'user-added', '그 사람이 더한 env 키는 지워지지 않는다');
});

test('adapters(업데이트, Task 24b #2): 코덱스 TOML 은 command·args 줄만 바꾸고, 그 사람이 손으로 더한 줄은 살린다', async () => {
  const ctx = makeCtx('update-mcp-toml-keep', { apps: { office: true, hancom: true } });
  const root = ctx.root;
  await adapters.run(ctx);

  const tomlPath = agentFile(root, 'codex', 'config.toml');
  let toml0 = fs.readFileSync(tomlPath, 'utf8');
  // self-improve 블록의 env 하위 테이블에 그 사람이 줄을 하나 더한다.
  assert.match(toml0, /\[mcp_servers\.self-improve\.env\]\n/);
  toml0 = toml0.replace(
    /(\[mcp_servers\.self-improve\.env\]\n)/,
    '$1MY_USER_KEY = "keep-me"\n',
  );
  fs.writeFileSync(tomlPath, toml0);

  const nextLock = bumpLock(root, { 'self-improve': '_agent/shared/tools/self-improve/9.9.8' });
  await adapters.run({ ...ctx, lock: nextLock });

  const toml = fs.readFileSync(tomlPath, 'utf8');
  assert.match(toml, /self-improve[\\\\]+9\.9\.8/, '우리 command/args 줄은 새 판 경로로 갱신된다');
  assert.match(toml, /MY_USER_KEY = "keep-me"/, '그 사람이 env 하위 테이블에 더한 줄은 그대로 남는다');
  assert.equal((toml.match(/\[mcp_servers\.self-improve\]/g) ?? []).length, 1, '블록이 늘어나면 안 된다');
});

test('adapters(업데이트): 우리 훅의 경로는 고치고, 그 사람 사본을 부르는 훅은 건드리지 않는다', async () => {
  const ctx = makeCtx('update-hooks', { apps: { office: true, hancom: true } });
  const root = ctx.root;
  await adapters.run(ctx);

  const sPath = agentFile(root, 'claude', 'settings.json');
  const s0 = readJson(sPath);
  // ① 우리 훅인데 옛 판이 쓰던 경로(동봉 파이썬 직접 호출)로 되어 있다.
  const ours = s0.hooks.PreToolUse.find((e) => JSON.stringify(e).includes('guard-iris-path.py'));
  const wanted = ours.hooks[0].command;
  ours.hooks[0].command = `"${path.join(root, '_agent', 'shared', 'tools', 'python', 'python.exe')}" "${path.join(root, '_agent', 'claude', 'scripts', 'guard-iris-path.py')}"`;
  // ② 그 사람이 자기 폴더의 사본을 부르는 훅(우리 폴더 밖).
  s0.hooks.SessionStart = [
    { matcher: 'startup', hooks: [{ type: 'command', command: '"C:\\mine\\python.exe" "C:\\mine\\check_fresh.py" --hook session' }] },
  ];
  fs.writeFileSync(sPath, `${JSON.stringify(s0, null, 2)}\n`);

  await adapters.run(ctx);

  const s = readJson(sPath);
  const after = s.hooks.PreToolUse.find((e) => JSON.stringify(e).includes('guard-iris-path.py'));
  assert.equal(after.hooks[0].command, wanted, '우리 폴더를 가리키던 우리 훅은 새 명령으로 갱신');
  assert.equal(after.hooks[0].shell, 'powershell', '옛 판 훅(shell 없음)도 파워셸로 갈아 끼운다(2.0.55)');
  assert.equal(s.hooks.PreToolUse.length, 2, '훅을 하나 더 만들지 않는다');
  // 그 사람이 신선도 훅을 자기 사본으로 돌려 두었으면 우리 신선도 훅을 옆에 끼워 넣지 않는다(그대로).
  // 2.0.65 의 로그인 열쇠 알림은 그와 다른 훅이라 한 번 더해진다 — 그래서 2개다(그 사람 것 1 + 알림 1).
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, '"C:\\mine\\python.exe" "C:\\mine\\check_fresh.py" --hook session');
  assert.equal(s.hooks.SessionStart.filter((e) => JSON.stringify(e).includes('check_fresh.py')).length, 1, '그 사람 훅 옆에 우리 신선도 훅을 끼워 넣지 않는다');
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.ok(s.hooks.SessionStart[1].hooks[0].command.includes('status.mjs'));
});

// 재현 시험(영구): 2.0.54 이전 판으로 처음 설치한 PC 의 신선도 훅은 `"<파이썬 심>" "<설치 폴더>\_ontology\check_fresh.py" --hook session`
// (껍데기 없음) 꼴이었다. 2.0.55 가 훅을 파워셸 꼴로 바꿨지만, 이 훅은 명령이 `shims` 와 `_ontology` 만 가리켜 "설치기 소유"로
// 보이지 않아 업데이트해도 옛 꼴 그대로 남았다 — Git Bash 가 없는 PC 에서 파워셸이 `"a" "b"` 를 문법 오류로 읽어 세션 시작 때마다 깨진다.
test('adapters(업데이트 · 2.0.65): 2.0.54 이전 판이 놓은 신선도 훅도 파워셸 꼴로 갈아 끼운다 — 중복 없음 · 그 사람 훅 그대로 · 코덱스 훅 파일 그대로', async () => {
  const ctx = makeCtx('fresh-hook-old-form', { apps: { office: true, hancom: true } });
  const root = ctx.root;
  await adapters.run(ctx);
  const sPath = agentFile(root, 'claude', 'settings.json');
  const codexHooksPath = agentFile(root, 'codex', 'hooks.json');
  const shim = path.join(root, '_agent', 'shared', 'shims', 'python.cmd');
  const scripts = path.join(root, '_agent', 'claude', 'scripts');

  // 2.0.54 의 adapters.mjs 가 쓰던 글자 그대로(껍데기 칸 없음).
  const s0 = readJson(sPath);
  const wantedFresh = { ...s0.hooks.SessionStart.find((e) => JSON.stringify(e).includes('check_fresh.py')).hooks[0] };
  const mine = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine', timeout: 5 }] };
  s0.hooks = {
    PreToolUse: [
      { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(scripts, 'block-blanket-kill.ps1')}"`, timeout: 15, statusMessage: '일괄 킬 가드 검사 중' }] },
      { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell', hooks: [{ type: 'command', command: `"${shim}" "${path.join(scripts, 'guard-iris-path.py')}"`, timeout: 10, statusMessage: 'IRIS 경로 실존 가드 검사 중' }] },
    ],
    SessionStart: [
      mine,
      { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: `"${shim}" "${path.join(root, '_ontology', 'check_fresh.py')}" --hook session`, timeout: 30, statusMessage: '온톨로지 신선도 점검' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: `"${shim}" "${path.join(scripts, 'bg-leftover-guard.py')}"`, timeout: 15 }] }],
  };
  fs.writeFileSync(sPath, `${JSON.stringify(s0, null, 2)}\n`);
  const codexBefore = fs.readFileSync(codexHooksPath, 'utf8');

  await adapters.run(ctx);

  const s = readJson(sPath);
  const fresh = s.hooks.SessionStart.filter((e) => JSON.stringify(e).includes('check_fresh.py'));
  assert.equal(fresh.length, 1, '신선도 훅은 하나 — 옛 것 옆에 새 것을 더하지 않는다');
  assert.equal(fresh[0].hooks[0].command, wantedFresh.command, '옛 꼴이 지금의 명령으로 바뀌었다');
  assert.equal(fresh[0].hooks[0].shell, 'powershell', '파워셸 꼴(Git Bash 가 없어도 돈다)');
  assert.ok(fresh[0].hooks[0].command.startsWith('& "') && fresh[0].hooks[0].command.endsWith('; exit $LASTEXITCODE'));
  assert.equal(fresh[0].hooks[0].timeout, 30);
  assert.equal(fresh[0].hooks[0].statusMessage, '온톨로지 신선도 점검');
  assert.deepEqual(s.hooks.SessionStart[0], mine, '그 사람 훅은 그대로(자리도)');
  assert.equal(s.hooks.SessionStart.length, 3, '그 사람 것 1 + 신선도 1 + 로그인 열쇠 알림 1');
  // 나머지 셋은 지금까지처럼: 설치기 소유 폴더의 스크립트를 부르던 옛 꼴은 새 꼴로, 개수는 그대로.
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.Stop.length, 1);
  for (const h of [...s.hooks.PreToolUse, ...s.hooks.Stop].map((e) => e.hooks[0])) {
    assert.equal(h.shell, 'powershell');
    assert.ok(h.command.endsWith('; exit $LASTEXITCODE'));
  }
  assert.equal(fs.readFileSync(codexHooksPath, 'utf8'), codexBefore, '코덱스 훅 파일은 바뀌지 않는다');

  // 한 번 더 얹어도 변경 0.
  const once = fs.readFileSync(sPath, 'utf8');
  await adapters.run(ctx);
  assert.equal(fs.readFileSync(sPath, 'utf8'), once);
});

test('adapters(업데이트 · 2.0.65): 다른 폴더의 check_fresh.py 를 부르는 훅(다른 영혼 · 자기 사본)과 다른 쓰임의 훅은 건드리지 않는다', async () => {
  const ctx = makeCtx('fresh-hook-others', { apps: { office: true, hancom: true } });
  const root = ctx.root;
  await adapters.run(ctx);
  const sPath = agentFile(root, 'claude', 'settings.json');
  const shim = path.join(root, '_agent', 'shared', 'shims', 'python.cmd');
  const cases = [
    // 우리 파이썬 심으로 **다른 영혼**의 신선도 점검을 부른다.
    `"${shim}" "D:\\OtherSoul\\_ontology\\check_fresh.py" --hook session`,
    // 이 설치 폴더 안이지만 `_ontology` 가 아닌 곳의 같은 이름.
    `"${shim}" "${path.join(root, 'my-copy', 'check_fresh.py')}" --hook session`,
    // 이 설치 폴더의 그 파일이지만 훅 방식(--hook session)이 아닌 다른 쓰임.
    `"${shim}" "${path.join(root, '_ontology', 'check_fresh.py')}" --verbose`,
    // 옛 판이 놓은 줄 뒤에 그 사람이 자기 명령을 붙였다 — 갈아 끼우면 그 명령이 지워진다. 한 글자도 바꾸지 않는다.
    `"${shim}" "${path.join(root, '_ontology', 'check_fresh.py')}" --hook session; "D:\\mine\\after-fresh.cmd"`,
    `& "${shim}" "${path.join(root, '_ontology', 'check_fresh.py')}" --hook session; "D:\\mine\\after-fresh.cmd"; exit $LASTEXITCODE`,
    // 인자를 더했다.
    `"${shim}" "${path.join(root, '_ontology', 'check_fresh.py')}" --hook session --quiet`,
  ];
  for (const command of cases) {
    const s0 = readJson(sPath);
    const theirs = { matcher: 'startup', hooks: [{ type: 'command', command, timeout: 99 }] };
    s0.hooks.SessionStart = [theirs];
    fs.writeFileSync(sPath, `${JSON.stringify(s0, null, 2)}\n`);
    await adapters.run(ctx);
    const s = readJson(sPath);
    assert.deepEqual(s.hooks.SessionStart[0], theirs, `그대로여야 한다: ${command}`);
    assert.equal(s.hooks.SessionStart.filter((e) => JSON.stringify(e).includes('check_fresh.py')).length, 1, '같은 이름의 훅이 이미 있으면 우리 신선도 훅을 더하지 않는다(지금까지와 같다)');
  }
});

test('adapters(2.0.65): 옛 판 설정에 세 번 되풀이 적용해도 로그인 열쇠 알림 훅은 한 번만 — 그 사람 훅은 그대로', async () => {
  const ctx = makeCtx('auth-hook-repeat', { apps: { office: true, hancom: true } });
  const root = ctx.root;
  await adapters.run(ctx);
  const sPath = agentFile(root, 'claude', 'settings.json');
  const codexHooksPath = agentFile(root, 'codex', 'hooks.json');

  // 옛 판(2.0.64 까지)이 남긴 모양으로 되돌린다: 알림 훅이 없고, 그 사람이 건 훅이 섞여 있다.
  const s0 = readJson(sPath);
  s0.hooks.SessionStart = s0.hooks.SessionStart.filter((e) => !JSON.stringify(e).includes('status.mjs'));
  assert.equal(s0.hooks.SessionStart.length, 1, '옛 판에는 신선도 훅 하나뿐이었다');
  const mine = [
    { matcher: 'startup', hooks: [{ type: 'command', command: 'node "D:\\my tools\\status.mjs" --hook', timeout: 77 }] }, // 같은 이름의 그 사람 스크립트
    { hooks: [{ type: 'command', command: 'echo hello' }] },
  ];
  s0.hooks.SessionStart.unshift(...mine);
  fs.writeFileSync(sPath, `${JSON.stringify(s0, null, 2)}\n`);
  const codexBefore = fs.readFileSync(codexHooksPath, 'utf8');

  await adapters.run(ctx); // 새 판으로 한 번
  const once = fs.readFileSync(sPath, 'utf8');
  await adapters.run(ctx); // 두 번
  await adapters.run(ctx); // 세 번
  assert.equal(fs.readFileSync(sPath, 'utf8'), once, '두 번째 · 세 번째 적용은 설정을 한 글자도 바꾸지 않는다');

  const s = readJson(sPath);
  assert.deepEqual(s.hooks.SessionStart.slice(0, 2), mine, '그 사람 훅은 순서 · 명령 · 시간 제한까지 그대로');
  const auth = s.hooks.SessionStart.filter((e) => (e.hooks ?? []).some((h) => h.command.includes(path.join(root, '_agent', 'shared', 'tools', 'iris-auth', 'status.mjs'))));
  assert.equal(auth.length, 1, '우리 알림 훅은 딱 하나');
  assert.equal(s.hooks.SessionStart.length, 4, '그 사람 것 2 + 신선도 1 + 알림 1');
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(fs.readFileSync(codexHooksPath, 'utf8'), codexBefore, '코덱스 훅 파일은 바뀌지 않는다');
});

test('adapters(2.0.65): 옛 꼴로 남은 우리 알림 훅(시간 제한 · 껍데기가 다름)은 제자리에서 새 꼴로 — 하나 더 만들지 않는다', async () => {
  const ctx = makeCtx('auth-hook-refresh', { apps: { office: true, hancom: true } });
  const root = ctx.root;
  await adapters.run(ctx);
  const sPath = agentFile(root, 'claude', 'settings.json');
  const s0 = readJson(sPath);
  const ours = s0.hooks.SessionStart.find((e) => JSON.stringify(e).includes('status.mjs'));
  const wanted = { ...ours.hooks[0] };
  ours.hooks[0].command = `"${path.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe')}" "${path.join(root, '_agent', 'shared', 'tools', 'iris-auth', 'status.mjs')}" --hook`;
  ours.hooks[0].timeout = 60;
  delete ours.hooks[0].shell;
  fs.writeFileSync(sPath, `${JSON.stringify(s0, null, 2)}\n`);

  await adapters.run(ctx);

  const s = readJson(sPath);
  const after = s.hooks.SessionStart.filter((e) => JSON.stringify(e).includes('status.mjs'));
  assert.equal(after.length, 1);
  assert.equal(after[0].hooks[0].command, wanted.command);
  assert.equal(after[0].hooks[0].shell, 'powershell');
  assert.equal(after[0].hooks[0].timeout, 10);

  // 꼴만 다른 것도 간다. 이 훅이 거쳐 온 꼴 둘: ① 종료 코드를 그대로 넘기던 꼴(실패 때 오류 한 줄이 남는다)
  // ② 늘 0 이지만 안쪽 시간 제한이 없던 꼴(오래 걸리면 바깥 제한이 먼저 끊는다) → 지금의 꼴(안쪽 제한 + 늘 0).
  const node = path.join(root, '_agent', 'shared', 'tools', 'node', 'node.exe');
  const script = path.join(root, '_agent', 'shared', 'tools', 'iris-auth', 'status.mjs');
  const ca = "if (-not $env:NODE_USE_SYSTEM_CA) { $env:NODE_USE_SYSTEM_CA = '1' }";
  for (const older of [
    `${ca}; & "${node}" "${script}" --hook; exit $LASTEXITCODE`,
    `${ca}; try { & "${node}" "${script}" --hook 2>$null } catch { }; exit 0`,
  ]) {
    const s1 = readJson(sPath);
    const mine = s1.hooks.SessionStart.find((e) => JSON.stringify(e).includes('status.mjs'));
    mine.hooks[0].command = older;
    fs.writeFileSync(sPath, `${JSON.stringify(s1, null, 2)}\n`);
    await adapters.run(ctx);
    const s2 = readJson(sPath);
    const again = s2.hooks.SessionStart.filter((e) => JSON.stringify(e).includes('status.mjs'));
    assert.equal(again.length, 1, older);
    assert.equal(again[0].hooks[0].command, wanted.command, older);
    assert.ok(again[0].hooks[0].command.includes('$p.WaitForExit(6000)') && again[0].hooks[0].command.endsWith('} catch { }; exit 0'));
  }
  // 지금의 꼴 그대로면 다시 얹어도 변경 0(따옴표가 겹친 꼴에서도 우리 훅을 알아본다).
  const settled = fs.readFileSync(sPath, 'utf8');
  await adapters.run(ctx);
  assert.equal(fs.readFileSync(sPath, 'utf8'), settled);
});

test('adapters(업데이트): 플러그인은 새 판 캐시를 가리키고, 사람이 바꾼 source 는 그대로 둔다', async () => {
  const ctx = makeCtx('update-plugin', { apps: { office: true, hancom: true } });
  const root = ctx.root;
  await adapters.run(ctx);

  const marketPath = agentFile(root, 'claude', 'plugins', 'marketplaces', 'iris-local', '.claude-plugin', 'marketplace.json');
  const installedPath = agentFile(root, 'claude', 'plugins', 'installed_plugins.json');
  const m0 = readJson(marketPath);
  // 그 사람이 insane-search 를 자기 폴더로 돌려 두었다.
  m0.plugins.find((p) => p.name === 'insane-search').source = '../../../../my-plugins/insane-search';
  fs.writeFileSync(marketPath, `${JSON.stringify(m0, null, 2)}\n`);

  const nextLock = bumpLock(root, { superpowers: { dest: '_agent/shared/skills/superpowers/v7.0.0', version: 'v7.0.0' } });
  await adapters.run({ ...ctx, lock: nextLock });

  const m = readJson(marketPath);
  assert.match(m.plugins.find((p) => p.name === 'superpowers').source, /superpowers[\\/]v7\.0\.0/);
  assert.equal(m.plugins.find((p) => p.name === 'insane-search').source, '../../../../my-plugins/insane-search');
  assert.equal(m.plugins.length, 4, '플러그인이 늘어나면 안 된다(document-skills 는 아직 없음)');

  const installed = readJson(installedPath);
  const entry = installed.plugins['superpowers@iris-local'][0];
  assert.match(entry.installPath, /superpowers[\\/]v7\.0\.0/);
  assert.equal(entry.version, 'v7.0.0');
});

test('adapters: 설치기 소유 판정 — 우리 두 폴더 아래만 참', () => {
  const root = 'C:\\SOUL';
  assert.equal(adapters.isInstallerOwnedPath(root, 'C:\\SOUL\\_agent\\shared\\tools\\node\\node.exe'), true);
  assert.equal(adapters.isInstallerOwnedPath(root, `"C:\\SOUL\\_agent\\claude\\scripts\\guard-iris-path.py"`), true);
  assert.equal(adapters.isInstallerOwnedPath(root, 'C:\\SOUL\\_agent\\runtime\\venvs\\document-mcp\\Scripts\\python.exe'), false);
  assert.equal(adapters.isInstallerOwnedPath(root, 'C:\\Program Files\\node\\node.exe'), false);
  assert.equal(adapters.isInstallerOwnedPath(root, ''), false);
  assert.equal(adapters.isInstallerOwnedEntry(root, { command: 'C:\\my\\python.exe', args: ['C:\\SOUL\\_agent\\shared\\tools\\x\\server.py'] }), true);
  assert.equal(adapters.isInstallerOwnedEntry(root, { command: 'C:\\my\\python.exe', args: ['C:\\my\\server.py'] }), false);
});

test('adapters: document-skills 가 없으면 등록을 건너뛰고 대기로 남긴다', async () => {
  const ctx = makeCtx('nodocskills', { apps: { office: true, hancom: true } });
  const { recorded, pending } = await adapters.run(ctx);
  const root = ctx.root;

  const settings = readJson(agentFile(root, 'claude', 'settings.json'));
  assert.equal(settings.enabledPlugins['document-skills@iris-local'], undefined);
  const installed = readJson(agentFile(root, 'claude', 'plugins', 'installed_plugins.json'));
  assert.equal(installed.plugins['document-skills@iris-local'], undefined);
  assert.ok(!fs.existsSync(adapters.pluginCacheDir(root, 'document-skills', '34040c9')));
  assert.ok(recorded.claude.plugins.some((p) => p.name === 'document-skills' && p.status === 'missing'));
  assert.ok(pending.some((p) => p.capability.includes('문서 작성 스킬')));

  // 온라인 단계가 내려받은 뒤 같은 함수를 다시 부르면 그때 등록된다
  const dest = under(root, LOCK.parts['document-skills'].dest);
  fs.mkdirSync(path.join(dest, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.claude-plugin', 'plugin.json'), '{"name":"document-skills"}\n');
  const r = adapters.registerDocumentSkills(ctx);
  assert.equal(r.status, 'registered');
  const settings2 = readJson(agentFile(root, 'claude', 'settings.json'));
  assert.equal(settings2.enabledPlugins['document-skills@iris-local'], true);
  const installed2 = readJson(agentFile(root, 'claude', 'plugins', 'installed_plugins.json'));
  assert.ok(installed2.plugins['document-skills@iris-local'][0].installPath.endsWith(path.join('document-skills', '34040c9')));
  const market = readJson(agentFile(root, 'claude', 'plugins', 'marketplaces', 'iris-local', '.claude-plugin', 'marketplace.json'));
  assert.equal(market.plugins.length, 5);
  // 다시 불러도 변경 0
  const before = snapshot(path.join(root, '_agent'));
  adapters.registerDocumentSkills(ctx);
  assert.deepEqual(snapshot(path.join(root, '_agent')), before);
});

test('adapters: 오피스·한컴·엣지가 없으면 등록은 하되 대기로 알린다', async () => {
  const ctx = makeCtx('nooffice', { apps: { office: false, hancom: false }, edge: false });
  const { recorded, pending } = await adapters.run(ctx);
  const cj = readJson(agentFile(ctx.root, 'claude', '.claude.json'));
  // D2-17: 없어도 등록은 한다
  assert.equal(Object.keys(cj.mcpServers).length, 6);
  assert.equal(recorded.apps.office, false);
  assert.equal(recorded.apps.hancom, false);
  const caps = pending.map((p) => p.capability);
  for (const label of ['문서 자동화(한글)', '문서 자동화(엑셀)', '문서 자동화(파워포인트)', '문서 자동화(워드)', '브라우저 조작(Playwright)']) {
    assert.ok(caps.includes(label), `대기 없음: ${label}`);
  }
  assert.ok(!caps.includes('문서 자동화(PDF)'), 'PDF 는 오피스가 필요 없다');
  assert.ok(ctx.runCalls.some(([exe, sub]) => exe === 'reg' && sub === 'query'));
});

test('adapters: UI/UX 스킬 생성기를 오프라인·코덱스 대상으로 부른다', async () => {
  const ctx = makeCtx('uiux', { apps: { office: true, hancom: true }, tools: { withUiUx: true } });
  const { recorded, pending } = await ctx && await adapters.run(ctx);
  const call = ctx.runCalls.find((c) => String(c[1] ?? '').includes('ui-ux-pro-max'));
  assert.ok(call, 'ui-ux-pro-max 를 부르지 않았다');
  assert.equal(call[0], adapters.nodeExePath(ctx.root));
  assert.deepEqual(call.slice(2), ['init', '--ai', 'codex', '--offline']);
  assert.equal(recorded.codex.uiUx.status, 'ok');
  assert.ok(!pending.some((p) => p.capability === '코덱스 UI/UX 스킬'));
});

test('adapters: UI/UX 생성기가 실패해도 설치는 계속된다', async () => {
  const ctx = makeCtx('uiuxfail', { apps: { office: true, hancom: true }, tools: { withUiUx: true } });
  ctx.run = async (exe, args) => {
    if (String(args[0] ?? '').includes('ui-ux-pro-max')) return { code: 3, out: '', err: 'boom' };
    return { code: 0, out: '', err: '' };
  };
  const { recorded, pending } = await adapters.run(ctx);
  assert.equal(recorded.codex.uiUx.status, 'failed');
  assert.ok(pending.some((p) => p.capability === '코덱스 UI/UX 스킬'));
  // 나머지는 정상 등록
  assert.equal(Object.keys(readJson(agentFile(ctx.root, 'claude', '.claude.json')).mcpServers).length, 6);
});

test('adapters: root 가 없으면 StageError E-ADAPTERS', async () => {
  await assert.rejects(() => adapters.run({ fs }), (e) => e.code === 'E-ADAPTERS');
});

test('adapters: 잠금표 dest 가 바뀌면 경로도 따라간다(경로를 박지 않는다)', () => {
  // 연습 루트(= 설치 폴더가 어디든)에서도 같은 계산이어야 한다
  const fake = path.join('D:', 'soul');
  const ctx = { root: fake, lock: { parts: { foo: { dest: '_agent/shared/tools/foo/1.2.3', entry: 'bin/cli.js', version: '1.2.3' } } } };
  assert.equal(adapters.toolDir(ctx, 'foo'), path.join(fake, '_agent', 'shared', 'tools', 'foo', '1.2.3'));
  assert.equal(adapters.toolEntry(ctx, 'foo'), path.join(fake, '_agent', 'shared', 'tools', 'foo', '1.2.3', 'bin', 'cli.js'));
  assert.equal(adapters.toolVersion(ctx, 'foo'), '1.2.3');
  // 판이 없으면 dest 의 마지막 칸(커밋 짧은 해시)
  assert.equal(adapters.toolVersion({ root: fake, lock: { parts: { bar: { dest: 'a/b/da823e8' } } } }, 'bar'), 'da823e8');
});
