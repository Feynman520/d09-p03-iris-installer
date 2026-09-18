// verify/vm/guest-drive.mjs — 손님(guest) 안에서 설치기 화면을 사람 대신 누르는 운전기.
//
// 왜 필요한가 (2026-09-15 T23c 실측으로 드러난 구멍):
//   `IRIS-설치.cmd` 는 설치를 **하지 않는다.** bootstrap.ps1 을 불러 서버(3460)를
//   띄우고 브라우저를 연 다음 **곧바로 끝난다**. 즉 `cmd /c IRIS-설치.cmd` 만
//   돌리면 종료 코드 0 이 즉시 돌아오고 아무것도 설치되지 않는다 — 원래
//   run.mjs 는 그 0 을 "설치 성공"으로 읽을 참이었다. 화면을 누르는 일(마법사
//   6단계 → 세팅 시작 → 온라인 시작)을 대신할 것이 필요하고, 그것이 이 파일이다.
//
// 계약은 `docs/설치기-API-v2.md` 이고, 누르는 순서는 `verify/offline.mjs` 의
// driveInstall() 과 **같다**(사본이 아니라 같은 순서 — 이 파일은 손님 안에서
// 혼자 돌아야 해서 저장소를 import 할 수 없다).
//
// 🔴 절대 하지 않는 것: `POST /api/online/login`. 진짜 구독 로그인은 사람만 한다.
//    이 운전기는 ⑥-1 인터넷 확인과 ⑥-2 Claude Code 내려받기까지만 가고,
//    로그인 대기(`stage: 'login'`)에서 정직하게 멈춘다. 그 멈춤이 곧 합격선이다.
//
// 사용법(손님 안):
//   <node.exe> guest-drive.mjs --url http://127.0.0.1:3460 --out C:\...\drive-result.json

import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 || i + 1 >= argv.length ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes(name);

const URL_BASE = arg('--url', 'http://127.0.0.1:3460').replace(/\/$/, '');
const OUT = arg('--out', 'drive-result.json');
const SUBS = String(arg('--subscriptions', 'claude')).split(',').map((s) => s.trim()).filter(Boolean);
const PRESET = arg('--preset', 'teacher');
const SKIP_ONLINE = flag('--skip-online');
const SERVER_WAIT_MS = Number(arg('--server-wait-ms', 5 * 60 * 1000));
// 2026-09-16 실측(4 GB/2 vCPU 손님): 세팅 9단계가 unpack 27분 + venv 10분 등 **약 45분**,
// 온라인은 230MB claude.exe 내려받기+첫 실행 확인으로 10분+ 가 걸린다. 45분 한도는
// checks(88%) 직전에 끊겨 S01 이 "진행 조회 시간 초과"로 끝났다. 넉넉히 잡는다 —
// 정말 멈춘 손님은 run.mjs 의 install 한도(LONG_PHASES)가 따로 끊는다.
const SETUP_TIMEOUT_MS = Number(arg('--setup-timeout-ms', 120 * 60 * 1000));
const ONLINE_TIMEOUT_MS = Number(arg('--online-timeout-ms', 40 * 60 * 1000));

const JSON_HDR = { 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

const result = {
  startedAt: now(),
  url: URL_BASE,
  steps: [],
  errors: [],
  setup: null,
  online: null,
  locate: null,
  state: null,
  report: null,
  finishedAt: null,
};

function note(step, data) {
  result.steps.push({ step, at: now(), data });
  console.log(`[${now()}] ${step}: ${JSON.stringify(data).slice(0, 400)}`);
}

// 🔴 모든 요청에 제한 시간을 건다. 2026-09-15(T23d) 실측: 서버가 대답을 멈추면
// (설치기 서버가 동기 작업으로 이벤트 루프를 붙들면 그렇게 된다) `fetch` 는
// 기본적으로 **영원히** 기다리고, 그러면 아래 대기 함수들의 기한 검사에 영영
// 도달하지 못한다 — 시나리오 하나가 통째로 매달린 채 증거 없이 끝난다.
const REQ_TIMEOUT_MS = Number(arg('--request-timeout-ms', 60 * 1000));

async function fetchWithTimeout(url, init = {}, { timeoutMs = REQ_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function post(p, body, opts = {}) {
  const res = await fetchWithTimeout(`${URL_BASE}${p}`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify(body ?? {}) }, opts);
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function getJson(p) {
  const res = await fetchWithTimeout(`${URL_BASE}${p}`);
  return res.json();
}

// 프리셋은 나무({level,nameKo,nameEn,children})로 오고 서버는 납작한 목록을
// 원한다 — 배포되는 브라우저 화면(installer/ui/structure.mjs)이 하는 것과 같은 평탄화.
function flattenPresetTree(tree) {
  const nodes = [];
  let counter = 0;
  const walk = (list, parentId) => {
    list.forEach((n, i) => {
      const id = `n${++counter}`;
      nodes.push({ id, parentId, level: n.level, nameKo: n.nameKo, nameEn: n.nameEn ?? '', order: i + 1 });
      if (Array.isArray(n.children) && n.children.length) walk(n.children, id);
    });
  };
  walk(tree, null);
  return nodes;
}

async function waitForServer() {
  const deadline = Date.now() + SERVER_WAIT_MS;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${URL_BASE}/api/health`);
      if (r.ok) { note('server-up', { status: r.status }); return true; }
      last = `HTTP ${r.status}`;
    } catch (e) { last = String(e?.message ?? e); }
    await sleep(2000);
  }
  throw new Error(`설치기 서버가 ${SERVER_WAIT_MS / 1000}초 안에 응답하지 않았습니다 (마지막: ${last})`);
}

async function waitForSetupDone() {
  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  let lastStage = null;
  for (;;) {
    let body = null;
    try {
      body = await getJson('/api/setup/progress');
    } catch (e) {
      // 서버가 잠깐 대답을 못 해도 곧장 포기하지 않는다 -- 기한까지는 다시 묻는다.
      note('setup-poll-failed', { error: String(e?.message ?? e) });
      if (Date.now() > deadline) throw new Error('세팅이 끝나지 않았습니다(진행 조회가 응답하지 않습니다)');
      await sleep(3000);
      continue;
    }
    if (body.stage !== lastStage) { lastStage = body.stage; note('setup-stage', { stage: body.stage, percent: body.percent }); }
    if (body.running === false && (body.percent === 100 || body.error)) return body;
    if (Date.now() > deadline) throw new Error('세팅이 끝나지 않았습니다(진행 조회 시간 초과)');
    await sleep(1000);
  }
}

// ⑥ 온라인. 세 가지 끝 중 하나에서 멈춘다:
//   ⓐ 인터넷 확인 실패(net.ok=false) — 오프라인 시나리오(S06)가 기대하는 끝.
//   ⓑ 로그인 대기(stage='login') — 정상 경로의 끝. 여기서 멈추는 것이 합격선이다.
//   ⓒ 오류(state.online.error)
async function waitForOnlineStop() {
  const deadline = Date.now() + ONLINE_TIMEOUT_MS;
  let lastStage = null;
  for (;;) {
    let body = null;
    try {
      body = await getJson('/api/online/status');
    } catch (e) {
      note('online-poll-failed', { error: String(e?.message ?? e) });
      if (Date.now() > deadline) throw new Error('온라인 단계가 끝나지 않았습니다(상태 조회가 응답하지 않습니다)');
      await sleep(3000);
      continue;
    }
    const st = body?.stage ?? null;
    if (st !== lastStage) { lastStage = st; note('online-stage', { stage: st, net: body?.net ?? null, claude: body?.claude ?? null }); }
    if (body?.net && body.net.ok === false) return body;
    if (body?.error) return body;
    if (st === 'login') return body;
    if (Date.now() > deadline) throw new Error('온라인 단계가 끝나지 않았습니다(상태 조회 시간 초과)');
    await sleep(1500);
  }
}

// ---------------------------------------------------------------------------
// 1.x 판 운전 (S09 의 밑준비) — API 가 v2 와 다르다
// ---------------------------------------------------------------------------
//
// 1.4.5 의 서버는 마법사가 여섯 걸음이 아니라 네 걸음이고 이름도 다르다:
//   precheck → name(설치 위치) → choice(구독) → install(복사) → login
// 복사 진행은 SSE(`GET /api/install/events`)로 흐르지만, 우리는 끝났는지만
// 알면 되므로 `GET /api/state` 를 본다. 🔴 `POST /api/login` 은 부르지 않는다.
async function driveLegacy() {
  // precheck 는 손님에서 41~49초 걸린다(2026-09-17 S04·09-18 S03 실측: 오프라인 망 탐침 시한 + PowerShell 기동).
  // 기본 60초 한도를 조금만 넘겨도 운전기가 중단돼 판정 없이 끝나므로(09-18 22:01 S04) 4분을 준다.
  const pre = (await post('/api/precheck', {}, { timeoutMs: 4 * 60 * 1000 })).json;
  note('legacy-precheck', { ok: pre?.ok, canProceed: pre?.canProceed });

  const name = (await post('/api/name')).json;
  result.locate = name;
  note('legacy-name', { ok: name?.ok, existing: name?.existing, reason: name?.reason ?? null });
  if (!name?.ok) throw new Error(`1.x 설치 위치 확인 실패: ${name?.reason ?? ''}`);

  const choice = (await post('/api/choice', { subscriptions: SUBS })).json;
  note('legacy-choice', { ok: choice?.ok });
  if (!choice?.ok) throw new Error(`1.x 구독 선택 실패: ${JSON.stringify(choice)}`);

  const started = await post('/api/install');
  note('legacy-install-start', { status: started.status });
  if (started.status !== 202) throw new Error(`1.x 복사 시작이 ${started.status} 를 돌려줬습니다`);

  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  let lastStep = null;
  let lastError = null;
  let retries = 0;
  for (;;) {
    const st = await getJson('/api/state');
    if (st?.step !== lastStep) { lastStep = st?.step; note('legacy-step', { step: st?.step }); }
    // 복사가 끝나면 서버가 로그인 걸음으로 넘어간다 — 거기서 멈춘다.
    if (st?.step && st.step !== 'install' && st.step !== 'choice' && st.step !== 'name' && st.step !== 'precheck') {
      result.state = st;
      return st;
    }
    // 2026-09-17 VM S09 실측: 1.4.5 는 뿌리 검사의 파워셸 프로브가 느린 손님에서 시간 초과하면
    // `installError: "not-ntfs"` 로 복사를 접는다(2.0.0 Task 26 이 고친 바로 그 버그 — 옛 zip 은
    // 못 고친다). 그 뒤에도 step 은 'install' 그대로라 여기가 120분을 헛기다렸다. 오류가 보이면
    // 45초 뒤 다시 시작한다(두 번째는 파워셸이 따뜻해 통과한다). 네 번까지.
    if (st?.installError && st.installError !== lastError) {
      lastError = st.installError;
      note('legacy-install-error', { error: st.installError, retries });
      if (retries >= 4) throw new Error(`1.x 복사가 계속 실패합니다: ${st.installError}`);
      retries += 1;
      await sleep(45000);
      const again = await post('/api/install');
      note('legacy-install-retry', { status: again.status, attempt: retries });
      lastError = null;
      continue;
    }
    if (Date.now() > deadline) throw new Error('1.x 복사가 끝나지 않았습니다(state 조회 시간 초과)');
    await sleep(2000);
  }
}

async function main() {
  await waitForServer();

  if (flag('--legacy')) {
    await driveLegacy();
    return;
  }

  // precheck 는 손님에서 41~49초 걸린다(2026-09-17 S04·09-18 S03 실측: 오프라인 망 탐침 시한 + PowerShell 기동).
  // 기본 60초 한도를 조금만 넘겨도 운전기가 중단돼 판정 없이 끝나므로(09-18 22:01 S04) 4분을 준다.
  const pre = (await post('/api/precheck', {}, { timeoutMs: 4 * 60 * 1000 })).json;
  note('precheck', { ok: pre?.ok, canProceed: pre?.canProceed, blockers: pre?.result?.blockers?.length ?? null });
  if (!pre?.canProceed) throw new Error(`사전 점검이 진행을 막았습니다: ${JSON.stringify(pre?.result?.blockers ?? pre)}`);

  const loc = (await post('/api/locate')).json;
  result.locate = loc;
  note('locate', { ok: loc?.ok, mode: loc?.mode });
  if (!loc?.ok) throw new Error(`설치 위치 확인 실패(mode=${loc?.mode}): ${loc?.message ?? ''}`);

  const choice = (await post('/api/choice', { subscriptions: SUBS })).json;
  note('choice', { ok: choice?.ok, leadAgent: choice?.leadAgent });
  if (!choice?.ok) throw new Error(`구독 선택 실패: ${JSON.stringify(choice)}`);

  const presets = await getJson('/api/presets');
  const preset = (presets.presets ?? []).find((p) => p.id === PRESET);
  if (!preset) throw new Error(`presets.json 에 '${PRESET}' 프리셋이 없습니다`);
  const nodes = flattenPresetTree(preset.tree);
  const st = (await post('/api/structure', { nodes, later: false })).json;
  note('structure', { ok: st?.ok, nodes: nodes.length, errors: st?.errors ?? null });
  if (!st?.ok) throw new Error(`구조 저장 실패: ${JSON.stringify(st?.errors ?? st)}`);

  const confirm = (await post('/api/summary/confirm')).json;
  note('summary-confirm', { ok: confirm?.ok });
  if (!confirm?.ok) throw new Error(`요약 확인 실패: ${JSON.stringify(confirm)}`);

  const started = await post('/api/setup/start');
  note('setup-start', { status: started.status });
  if (started.status !== 202) throw new Error(`세팅 시작이 ${started.status} 를 돌려줬습니다`);

  result.setup = await waitForSetupDone();
  note('setup-done', { percent: result.setup?.percent, error: result.setup?.error ?? null });

  if (!SKIP_ONLINE) {
    const onlineStarted = await post('/api/online/start');
    note('online-start', { status: onlineStarted.status });
    result.online = await waitForOnlineStop();
    note('online-stop', { stage: result.online?.stage, net: result.online?.net ?? null, claude: result.online?.claude ?? null });
    // 🔴 `/api/online/login` 은 절대 부르지 않는다(사람만 할 수 있는 구독 로그인).
    // 2026-09-17 추가(S13 몫): 로그인 없이도 **중계기 시작**은 밟는다 — 2.0.4~2.0.8 이 실제 PC 의
    // ⑦에서만 세 번 연속 터진 까닭이 바로 이 단계를 시험이 한 번도 밟지 않아서였다(중계기 설정
    // proxy.port 누락, 시작 스크립트 파이프 대기). `/api/online/relay` 는 로그인 상태를 묻지 않고
    // 중계기를 띄워 건강 확인까지 한다. 오프라인(net 차단)에서도 로컬 중계기는 뜰 수 있어 시도한다.
    try {
      // 중계기 시작은 관리 스크립트 한도(90초)+건강 확인까지 2분 넘게 걸릴 수 있다 — 요청 한도 4분.
      const relay = await post('/api/online/relay', {}, { timeoutMs: 4 * 60 * 1000 });   // { status, json } — Response 가 아니다
      const body = relay.json ?? {};
      const status = await getJson('/api/online/status').catch(() => null);
      result.relayProbe = {
        status: relay.status,
        ok: body?.ok === true,
        code: body?.code ?? null,
        message: body?.message ?? status?.relay?.message ?? null,
        detail: status?.relay?.detail ?? null,
        accounts: status?.relay?.accounts ?? null,
      };
      note('relay-probe', { ok: result.relayProbe.ok, code: result.relayProbe.code, message: result.relayProbe.message });
    } catch (e) {
      result.relayProbe = { status: null, ok: false, code: 'E-PROBE', message: String(e?.message ?? e), detail: null };
      note('relay-probe', { ok: false, error: String(e?.message ?? e) });
    }
  }

  try { result.report = await getJson('/api/report'); } catch (e) { result.errors.push(`report: ${String(e?.message ?? e)}`); }
  try { result.state = await getJson('/api/state'); } catch (e) { result.errors.push(`state: ${String(e?.message ?? e)}`); }
}

main()
  .catch((e) => {
    result.errors.push(String(e?.message ?? e));
    console.error(`guest-drive: ${e?.message ?? e}`);
    process.exitCode = 1;
  })
  .finally(() => {
    result.finishedAt = now();
    // 보고서 markdown 은 길고 회수할 필요가 없다 — 있으면 크기만 남긴다.
    if (result.report?.markdown) {
      result.report = { ...result.report, markdown: `(${result.report.markdown.length}자 생략)` };
    }
    try {
      fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      console.log(`guest-drive: 결과를 ${OUT} 에 썼습니다`);
    } catch (e) {
      console.error(`guest-drive: 결과 파일을 쓰지 못했습니다: ${e?.message ?? e}`);
    }
  });
