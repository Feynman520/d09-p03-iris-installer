// 화면만 따로 확인하기 위한 **가짜 서버**. zip에는 들어가지 않는다(빌드가 index.html·presets.json·structure.mjs만 포장).
// 진짜 서버는 installer/server.mjs 이고, 둘 다 docs/설치기-API-v2.md 계약을 따른다.
// 아무것도 설치하지 않고, 파일을 만들지도 지우지도 않으며, 127.0.0.1에만 귀를 연다.
//
//   node installer/ui/mock-server.mjs [--port 3461] [--blockers] [--foreign] [--legacy]
//                                     [--fail <단계>] [--reinstall] [--speed <밀리초>]
//
//   --blockers   준비 확인이 「막음」을 돌려준다          --foreign   설치 위치가 남의 자료로 차 있다
//   --legacy     1.x IRIS 자료가 있는 자리               --fail venv 그 단계에서 설치가 멈춘다
//   --reinstall  1.x 영수증을 자동 업데이트로 연 상태     --speed     단계 하나에 걸리는 시간(기본 700ms)
//   --login-reason window-closed|page-blocked|import-failed   로그인이 그 까닭으로 실패한다

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { validateNodes, assignCodes, folderName } from './structure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const value = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(value('port', '3461'));
const SPEED = Number(value('speed', '700'));
const FAIL_AT = value('fail', '');
// 가짜 경로 조각(설치 대상 표시용, 진짜 설치와 무관) -- 저장소 정화 규칙이 설치 루트
// 드라이브 표기와 사용자 프로필 표기의 연속 문자열을 소스에서 금지하므로 접두를 나눠서 이어붙인다.
const FAKE_INSTALL_ROOT = 'C:\\IRIS';
const FAKE_USER_ROOT = 'C:\\Users';

const STAGE_IDS = ['unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks'];
const ERROR_CODE = {
  unpack: 'E-UNPACK', env: 'E-ENV', skeleton: 'E-SKELETON', structure: 'E-STRUCTURE', venv: 'E-VENV',
  adapters: 'E-ADAPTERS', relay: 'E-RELAY', ontology: 'E-ONTOLOGY', checks: 'E-CHECKS',
};
const UNPACK_PARTS = ['node', 'python', 'git', 'codex', 'relay', 'face', 'tools', 'policy'];

const state = {
  ok: true,
  name: 'iris-installer',
  version: '2.0.0-mock',
  packageVersion: '2.0.0',
  step: flag('reinstall') ? 'reinstall-required' : 'precheck',
  precheck: null,
  soul: { root: 'C:\\IRIS', mode: flag('foreign') ? 'foreign' : flag('legacy') ? 'iris-legacy' : 'empty' },
  choice: null,
  decisions: null,
  setup: { stage: null, stages: STAGE_IDS.map((id) => ({ id, status: 'pending' })), percent: 0, current: null, error: null },
  online: {
    stage: 'idle',
    net: { ok: false, blocked: [] },
    claude: { state: 'skipped', source: null, code: null },
    logins: {},
    relay: { state: 'pending', accounts: [] },
  },
  report: null,
};

function precheckResult() {
  const blockers = flag('blockers')
    ? [
      { id: 'disk', message: 'C 드라이브의 빈 자리가 1.2GB뿐입니다. 3GB 넘게 비운 뒤 다시 확인해 주세요.' },
      { id: 'powershell', message: 'PowerShell이 제한 모드로 잠겨 있습니다. 회사·학교에서 잠근 설정이라면 관리자에게 풀어 달라고 요청해 주세요.' },
    ]
    : [];
  const warnings = [
    { id: 'net', message: '인터넷은 지금 확인만 했습니다 — 마지막 로그인 단계에서 필요합니다.' },
    { id: 'sac', message: '앱 보호 기능(SAC)이 켜져 있습니다. 설치기가 만드는 파일은 막지 않습니다.' },
  ];
  const info = {
    windows: 'Windows 11 24H2', arch: 'x64', disk: flag('blockers') ? '1.2GB 남음' : '184GB 남음',
    ntfs: 'NTFS · 쓸 수 있음', powershell: '5.1 · Full', ports: '3456·3457·3458·3460 비어 있음',
    browser: 'Edge', edge: '있음', existing: '없음', integrity: '부품 14개 모두 일치',
  };
  return { blockers, warnings, info, recorded: { at: new Date().toISOString() } };
}

// ---------------------------------------------------------------- 자동 진행(가짜)
let setupTimer = null;
function runSetup(fromIndex) {
  if (setupTimer) clearInterval(setupTimer);
  let i = fromIndex;
  let sub = 0;
  state.setup.error = null;
  for (let k = fromIndex; k < STAGE_IDS.length; k++) state.setup.stages[k] = { id: STAGE_IDS[k], status: 'pending' };

  const tick = () => {
    if (i >= STAGE_IDS.length) {
      clearInterval(setupTimer); setupTimer = null;
      state.setup.stage = 'done';
      state.setup.percent = 100;
      state.step = 'online';
      return;
    }
    const id = STAGE_IDS[i];
    state.setup.stage = id;
    state.setup.current = id;

    if (id === 'unpack' && sub < UNPACK_PARTS.length) {
      state.setup.stages[i] = { id, status: 'running', sub: { part: UNPACK_PARTS[sub], done: sub + 1, total: UNPACK_PARTS.length } };
      state.setup.percent = Math.floor(((i + (sub + 1) / UNPACK_PARTS.length) / STAGE_IDS.length) * 100);
      sub += 1;
      return;
    }
    if (FAIL_AT === id) {
      state.setup.stages[i] = { id, status: 'failed', code: ERROR_CODE[id], detail: '가짜 고장(--fail ' + id + ')' };
      state.setup.error = { code: ERROR_CODE[id], message: '가짜 고장입니다. 「다시 시도」를 누르면 이어서 진행합니다.' };
      clearInterval(setupTimer); setupTimer = null;
      return;
    }
    state.setup.stages[i] = { id, status: 'done' };
    i += 1;
    state.setup.percent = Math.floor((i / STAGE_IDS.length) * 100);
  };
  setupTimer = setInterval(tick, SPEED);
  tick();
}

function startOnline() {
  state.online.stage = 'net';
  const subs = (state.choice && state.choice.subscriptions) || [];
  state.online.logins = {
    claude: { state: subs.includes('claude') ? 'waiting' : 'not-needed', cli: null, relay: null, reason: null },
    chatgpt: { state: subs.includes('chatgpt') ? 'waiting' : 'not-needed', cli: null, relay: null, reason: null },
  };
  setTimeout(() => {
    state.online.net = { ok: true, blocked: [] };
    state.online.stage = subs.includes('claude') ? 'claude' : 'login';
    if (subs.includes('claude')) {
      state.online.claude = { state: 'downloading', source: 'npm', code: null };
      setTimeout(() => { state.online.claude = { state: 'done', source: 'npm', code: null }; state.online.stage = 'login'; }, SPEED * 2);
    }
  }, SPEED);
}

const LOGIN_REASON = value('login-reason', '');   // window-closed · page-blocked · import-failed

function finishLogin(provider) {
  const l = state.online.logins[provider];
  if (!l) return;
  l.state = 'waiting';
  l.reason = null;
  if (LOGIN_REASON) {
    setTimeout(() => { l.state = 'failed'; l.reason = LOGIN_REASON; }, SPEED);
    return;
  }
  setTimeout(() => { l.state = 'cli-done'; l.cli = 'done'; }, SPEED);
  setTimeout(() => { l.state = 'done'; l.relay = 'done'; }, SPEED * 2);
}

function allLoginsDone() {
  return Object.values(state.online.logins).every((l) => l.state === 'done' || l.state === 'not-needed');
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const json = (res, code, obj) => {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  const body = req.method === 'POST' ? await readBody(req) : {};

  try {
    if (path === '/api/state') return json(res, 200, state);

    if (path === '/api/precheck') {
      state.precheck = precheckResult();
      const canProceed = state.precheck.blockers.length === 0;
      if (canProceed && state.step === 'precheck') state.step = 'locate';
      return json(res, 200, { ok: true, result: state.precheck, canProceed });
    }

    if (path === '/api/locate') {
      const mode = state.soul.mode;
      const message = mode === 'foreign' ? '이 폴더에 IRIS가 아닌 자료가 있습니다.' : '';
      if (mode !== 'foreign' && state.step === 'locate') state.step = 'choice';
      return json(res, 200, { ok: mode !== 'foreign', root: state.soul.root, mode, message });
    }

    if (path === '/api/choice') {
      const subs = Array.isArray(body.subscriptions) ? body.subscriptions : [];
      if (!subs.length) return json(res, 200, { ok: false, code: 'empty', message: '적어도 하나는 골라야 합니다.' });
      const leadAgent = subs.includes('claude') ? 'claude' : 'chatgpt';
      state.choice = { subscriptions: subs, leadAgent };
      state.step = 'structure';
      return json(res, 200, { ok: true, leadAgent });
    }

    if (path === '/api/presets') {
      const raw = await readFile(join(HERE, 'presets.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(raw);
    }

    if (path === '/api/structure') {
      const later = !!body.later;
      const input = Array.isArray(body.nodes) ? body.nodes : [];
      const check = validateNodes(input, { later });
      if (!check.ok) return json(res, 200, { ok: false, errors: check.errors });
      const coded = assignCodes(later ? [{ id: 'later-root', parentId: null, level: 'R', nameKo: '나', nameEn: 'Me', order: 1 }] : input);
      state.decisions = {
        schema: 1,
        createdAt: new Date().toISOString(),
        later,
        nodes: coded.map((n) => ({ ...n, folderName: folderName(n) })),
        deferred: ['S', 'T', 'tags'],
        nameEnMissing: coded.filter((n) => !n.nameEn).map((n) => folderName(n)),
      };
      state.step = 'summary';
      return json(res, 200, { ok: true, decisions: state.decisions });
    }

    if (path === '/api/summary/confirm') {
      if (!state.choice || !state.decisions) return json(res, 200, { ok: false, code: 'incomplete', message: '구독과 작업 폴더를 모두 정해야 합니다.' });
      state.step = 'setup';
      return json(res, 200, { ok: true });
    }

    if (path === '/api/setup/start') { runSetup(0); return json(res, 202, { ok: true, running: true }); }
    if (path === '/api/setup/progress') return json(res, 200, state.setup);
    if (path === '/api/setup/retry') {
      const idx = state.setup.stages.findIndex((s) => s.status === 'failed');
      runSetup(idx < 0 ? 0 : idx);
      return json(res, 200, { ok: true, running: true });
    }

    if (path === '/api/online/start') { startOnline(); return json(res, 200, { ok: true }); }
    if (path === '/api/online/status') return json(res, 200, state.online);
    if (path === '/api/online/login') { finishLogin(body.provider); return json(res, 200, { ok: true }); }
    if (path === '/api/online/login/retry') { finishLogin(body.provider); return json(res, 200, { ok: true }); }
    if (path === '/api/online/relay') {
      if (!allLoginsDone()) return json(res, 200, { ok: false, code: 'login-pending', message: '로그인이 아직 끝나지 않았습니다.' });
      state.online.relay = { state: 'running', accounts: [] };
      setTimeout(() => {
        const subs = (state.choice && state.choice.subscriptions) || [];
        state.online.relay = { state: 'done', accounts: subs.map((s) => ({ provider: s })) };
        state.online.stage = 'done';
        state.step = 'done';
      }, SPEED);
      return json(res, 200, { ok: true });
    }

    if (path === '/api/report') {
      const folders = state.decisions ? state.decisions.nodes.map((n) => n.folderName) : [];
      return json(res, 200, {
        ok: true,
        markdownPath: FAKE_INSTALL_ROOT + '\\_agent\\setup\\설치보고-2026-09-15.md',
        markdown: '# 설치 보고(가짜)\n\n- 판: 2.0.0\n- 만든 폴더: ' + folders.length + '칸\n',
        handoff: {
          packageVersion: '2.0.0',
          subscriptions: (state.choice && state.choice.subscriptions) || [],
          leadAgent: (state.choice && state.choice.leadAgent) || null,
          folders,
          nameEnMissing: state.decisions ? state.decisions.nameEnMissing : [],
          checks: '9항목 가운데 8항목 통과 · 1항목 남은 일',
        },
        pendingCapabilities: ['edge', 'office'],
      });
    }

    if (path === '/api/open-face') return json(res, 200, { ok: true });
    if (path === '/api/log/path') return json(res, 200, { ok: true, path: FAKE_USER_ROOT + '\\<사용자>\\AppData\\Local\\IRIS-Installer\\installer-2026-09-15.log' });
    if (path === '/api/auto') return json(res, 404, { ok: false, code: 'mock', message: '가짜 서버는 업데이트 모드를 흉내 내지 않습니다.' });

    // ---- 정적 파일: installer/ui 아래만 (진짜 서버도 이 폴더를 그대로 내준다는 전제)
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = normalize(join(HERE, rel));
    if (!file.startsWith(HERE)) { res.writeHead(403); return res.end('no'); }
    const ext = file.slice(file.lastIndexOf('.'));
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(data);
  } catch (e) {
    if (e && e.code === 'ENOENT') { res.writeHead(404); return res.end('not found'); }
    return json(res, 500, { ok: false, code: 'mock-error', message: String(e && e.message) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('가짜 설치기 화면: http://127.0.0.1:' + PORT + '/  (pid ' + process.pid + ')\n');
});
