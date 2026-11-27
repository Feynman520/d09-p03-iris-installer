// 검진 묶음: 열쇠 · 창 · 프로그램 · 연결 설정 · 다시 열기와 시작 · 자원 · 업데이트 흔적 · Doctor 준비. 전부 읽기만.
import path from 'node:path';
import { finding } from '../report.mjs';
import { sharedPs } from '../context.mjs';
import { ownerFinding } from './relay.mjs';

const DAY = 86400_000;
const HOUR = 3600_000;
const daysLeft = (ms, now) => Math.floor((ms - now) / DAY);
const num = (v) => { const n = typeof v === 'string' ? Date.parse(v) : Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const join = (dir, ...rest) => (dir ? path.join(dir, ...rest) : null);

// ---------------------------------------------------------------- 열쇠
// 파일 안의 열쇠 값은 변수에 담지도 내보내지도 않는다 — 만료 시각 · 있는지 없는지 · 요금제 이름만 본다.
function jwtPlan(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    const auth = payload['https://api.openai.com/auth'] || {};
    return typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type.slice(0, 20) : null;
  } catch { return null; }
}

export async function checkKeys(ctx) {
  const G = 'keys', out = [], now = ctx.now();
  // 클로드 1년 열쇠
  const lk = ctx.claudeDir ? ctx.readJson(join(ctx.claudeDir, 'secrets', 'iris-cli-token.json')) : null;
  const lkExp = lk ? num(lk.value?.expiresAt) : null;
  let longOk = false;
  if (!lk || !lk.value?.token) out.push(finding('keys.claude-longkey', G, '클로드 1년 열쇠', 'warn', '1년 열쇠가 없습니다(클로드를 쓰지 않는 PC 라면 정상).', { source: '1년 열쇠 파일' }));
  else if (!lkExp) out.push(finding('keys.claude-longkey', G, '클로드 1년 열쇠', 'unknown', '1년 열쇠는 있지만 만료 시각을 읽지 못했습니다.', { dataAt: lk.mtime, source: '1년 열쇠 파일' }));
  else if (lkExp <= now) out.push(finding('keys.claude-longkey', G, '클로드 1년 열쇠', 'bad', `1년 열쇠가 ${-daysLeft(lkExp, now)}일 전에 만료됐습니다.`, { dataAt: lk.mtime, source: '1년 열쇠 파일' }));
  else { longOk = true; const d = daysLeft(lkExp, now); out.push(finding('keys.claude-longkey', G, '클로드 1년 열쇠', d <= 14 ? 'warn' : 'ok', `만료까지 ${d}일 남았습니다.`, { dataAt: lk.mtime, source: '1년 열쇠 파일' })); }
  // 클로드 프로그램 자체의 로그인(1년 열쇠가 살아 있으면 예비)
  const cr = ctx.claudeDir ? ctx.readJson(join(ctx.claudeDir, '.credentials.json')) : null;
  const o = cr?.value?.claudeAiOauth;
  // 만료를 정하는 것은 "갱신 열쇠의 만료"다. 짧은 접근 열쇠가 지났어도 갱신 열쇠가 있으면 프로그램이 스스로 갱신하므로 고장이라 하지 않는다.
  const refExp = o ? num(o.refreshTokenExpiresAt) : null;
  const accExp = o ? num(o.expiresAt) : null;
  const hasRefresh = !!o?.refreshToken;
  const src = { dataAt: cr?.mtime, source: '클로드 로그인 파일' };
  if (!o) out.push(finding('keys.claude-login', G, '클로드 프로그램 로그인', longOk ? 'skipped' : 'warn', '클로드 프로그램의 로그인 기록이 없습니다.', { skipped: longOk ? '1년 열쇠가 살아 있어 쓰이지 않음' : undefined, source: '클로드 로그인 파일' }));
  else if (refExp && refExp <= now) out.push(finding('keys.claude-login', G, '클로드 프로그램 로그인', longOk ? 'ok' : 'bad', `로그인이 만료됐습니다${longOk ? '(1년 열쇠가 살아 있어 지장 없음)' : ''}.`, src));
  else if (refExp) out.push(finding('keys.claude-login', G, '클로드 프로그램 로그인', daysLeft(refExp, now) <= 3 && !longOk ? 'warn' : 'ok', `만료까지 ${daysLeft(refExp, now)}일 남았습니다.`, src));
  else if (hasRefresh) out.push(finding('keys.claude-login', G, '클로드 프로그램 로그인', 'ok', '로그인 기록이 있습니다(만료일은 적혀 있지 않음 — 프로그램이 스스로 갱신).', src));
  else if (accExp && accExp <= now) out.push(finding('keys.claude-login', G, '클로드 프로그램 로그인', longOk ? 'ok' : 'warn', `갱신 열쇠 없는 로그인이 만료됐습니다${longOk ? '(1년 열쇠가 살아 있어 지장 없음)' : ''}.`, src));
  else out.push(finding('keys.claude-login', G, '클로드 프로그램 로그인', longOk ? 'ok' : 'unknown', '로그인 기록은 있지만 만료 시각을 읽지 못했습니다.', src));
  // 코덱스 로그인 — 파일이 있다는 것은 "지금 인증이 된다"는 증거가 아니다(그렇게 적지 않는다)
  const cx = ctx.codexDir ? ctx.readJson(join(ctx.codexDir, 'auth.json')) : null;
  const hasTokens = !!(cx?.value?.tokens && (cx.value.tokens.refresh_token || cx.value.tokens.access_token));
  if (!cx) out.push(finding('keys.codex-login', G, '코덱스 로그인', 'warn', '코덱스 로그인 기록이 없습니다(코덱스를 쓰지 않는 PC 라면 정상).', { source: '코덱스 로그인 파일' }));
  else if (!hasTokens) out.push(finding('keys.codex-login', G, '코덱스 로그인', 'warn', cx.value?.OPENAI_API_KEY ? '코덱스가 구독 로그인이 아니라 API 키로 설정돼 있습니다(종량 과금).' : '로그인 기록에 열쇠가 없습니다.', { dataAt: cx.mtime, source: '코덱스 로그인 파일' }));
  else {
    const plan = jwtPlan(cx.value.tokens.id_token);
    const last = num(cx.value.last_refresh);
    const stale = last && now - last > 30 * DAY;
    out.push(finding('keys.codex-login', G, '코덱스 로그인', plan === 'free' || stale ? 'warn' : 'ok', `로그인 기록이 있습니다${plan ? ` · 기록된 요금제 ${plan}${plan === 'free' ? '(무료 — 일부 기능이 빠질 수 있음. 기록일 뿐 지금 상태는 아닐 수 있음)' : ''}` : ''}${stale ? ' · 마지막 갱신이 30일보다 오래됨' : ''}.`, { dataAt: last ? new Date(last).toISOString() : cx.mtime, source: '코덱스 로그인 파일' }));
  }
  return out;
}

// ---------------------------------------------------------------- 창
export async function checkWindow(ctx) {
  const G = 'window', out = [], now = ctx.now();
  const h = await ctx.localJson(`http://127.0.0.1:${ctx.facePort}/api/health`);
  const up = h.ok && h.body && h.body.ok === true;
  if (up) out.push(finding('window.daemon', G, '창이 켜져 있는가', 'ok', `켜져 있습니다(판 ${String(h.body.version || '?').slice(0, 20)} · 열린 대화 ${Number(h.body.sessions) || 0}개).`, { source: '창 상태 주소' }));
  else out.push(finding('window.daemon', G, '창이 켜져 있는가', h.kind === 'timeout' ? 'bad' : 'warn', h.kind === 'timeout' ? `포트 ${ctx.facePort} 이 3초 안에 답하지 않습니다(멈춘 것으로 보임).` : h.kind === 'refused' ? '창이 켜져 있지 않습니다.' : `포트 ${ctx.facePort} 의 답이 창의 답 모양이 아닙니다.`, { source: '창 상태 주소' }));

  const ps = await sharedPs(ctx);
  const own = ps?.owners?.find((x) => Number(x.port) === ctx.facePort);
  out.push(ownerFinding('window.owner', G, '포트 주인이 창인가', ps, own, { port: ctx.facePort, up, offText: '창이 꺼져 있음', okText: '창의 데몬입니다', is: (x) => x.isFace }));

  if (!ctx.faceDir) out.push(finding('window.folder', G, '창 폴더', ctx.layout === 'installed' ? 'bad' : 'unknown', ctx.layout === 'installed' ? '창 폴더를 찾지 못했습니다.' : '창 폴더의 자리를 모릅니다(개발 PC — local.json 에 적어 두면 봅니다).', { source: '설치 구조' }));
  else {
    const need = ['daemon/server.mjs', 'launch.mjs', 'package.json'].filter((f) => !ctx.exists(join(ctx.faceDir, f)));
    out.push(finding('window.folder', G, '창 폴더', need.length ? 'bad' : 'ok', need.length ? `창 폴더에 꼭 있어야 할 파일 ${need.length}개가 없습니다(${need.join(' · ')}).` : '꼭 있어야 할 파일이 모두 있습니다.', { source: '창 폴더' }));
    // 최근 한 시간의 로그 — 원문은 싣지 않고 종류별 횟수만
    const t = ctx.readTail(join(ctx.faceDir, 'state', 'daemon.log'), 48 * 1024);
    if (t) {
      const kinds = { '요청 전달 실패': 0, '첫 요청 전달 실패': 0, '오류 줄': 0 };
      for (const line of t.text.split('\n')) {
        const ts = Date.parse(line.slice(0, 24));
        if (!Number.isFinite(ts) || now - ts > HOUR) continue;
        if (/enter FAILED/.test(line)) kinds['요청 전달 실패']++;
        else if (/first send failed/.test(line)) kinds['첫 요청 전달 실패']++;
        else if (/\b(Error|ECONNREFUSED|EADDRINUSE|uncaught|unhandled)\b/i.test(line)) kinds['오류 줄']++;
      }
      const total = Object.values(kinds).reduce((a, b) => a + b, 0);
      out.push(finding('window.log', G, '창의 최근 기록(1시간)', total >= 5 ? 'warn' : 'ok', total ? Object.entries(kinds).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ') + '.' : '눈에 띄는 오류가 없습니다.', { dataAt: t.mtime, source: '창 기록의 꼬리' }));
    }
    const sr = ctx.readJson(join(ctx.faceDir, 'state', 'shutdown-report.json'));
    if (sr && !up) out.push(finding('window.shutdown', G, '마지막 종료', sr.value.ok && !(sr.value.survivors || []).length ? 'ok' : 'warn', sr.value.ok && !(sr.value.survivors || []).length ? '마지막 종료는 정상이었습니다.' : `마지막 종료 때 남은 프로세스가 ${(sr.value.survivors || []).length}개 있었습니다.`, { dataAt: sr.value.at || sr.mtime, source: '창 종료 보고서' }));
  }
  // 설치 기록(설치본만)
  if (ctx.layout === 'installed') {
    // 2.x 영수증(schema 2) = 세팅 아홉 단계(setup.<이름>.status)가 모두 done 이어야 "설치 끝". 1.x 영수증은 구조가 달라 단정하지 않는다.
    const SETUP = ['unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks'];
    const rsrc = { dataAt: ctx.receiptAt || undefined, source: '설치 영수증' };
    if (ctx.receiptBroken) out.push(finding('window.receipt', G, '설치 기록', 'bad', '설치 영수증 파일이 있지만 읽을 수 없습니다(깨졌거나 비어 있음).', rsrc));
    else if (Number(ctx.receipt?.schema ?? 1) < 2) out.push(finding('window.receipt', G, '설치 기록', 'unknown', '옛 판(1.x) 설치 기록이라 단계를 판정하지 않습니다.', rsrc));
    else {
      const undone = SETUP.filter((id) => ctx.receipt?.setup?.[id]?.status !== 'done');
      out.push(finding('window.receipt', G, '설치 기록', undone.length ? 'warn' : 'ok', undone.length ? `설치 단계 ${undone.length}개가 끝나지 않았습니다(${undone.slice(0, 6).join(' · ')}).` : '설치 단계가 모두 끝났습니다.', rsrc));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 프로그램
// 전달 심(shims)으로는 판을 묻지 않는다 — 심은 중계기를 켠다. 실제 실행 파일의 자리만 본다.
function findOnPath(ctx, names) {
  const dirs = String(ctx.env.PATH || ctx.env.Path || '').split(';').map((d) => d.trim()).filter(Boolean);
  for (const d of dirs) {
    if (/[\\/]shims[\\/]?$/i.test(d)) continue; // 심 폴더는 건너뛴다
    for (const n of names) { const p = path.join(d, n); if (ctx.exists(p)) return p; }
  }
  return null;
}

export async function checkPrograms(ctx) {
  const G = 'programs', out = [];
  const tool = (name, ...rel) => join(ctx.toolsDir, name, ...rel);
  const where = {
    node: ctx.layout === 'installed' ? [tool('node', 'node.exe')] : [process.execPath],
    claude: [tool('claude', 'claude.cmd'), findOnPath(ctx, ['claude.exe', 'claude.cmd'])],
    codex: [tool('codex', 'codex.cmd'), findOnPath(ctx, ['codex.exe', 'codex.cmd'])],
    git: [tool('git', 'cmd', 'git.exe'), findOnPath(ctx, ['git.exe'])],
    python: [tool('python', 'python.exe'), findOnPath(ctx, ['python.exe'])],
  };
  const found = {};
  const KO = { node: '동봉 node', claude: '클로드 프로그램', codex: '코덱스 프로그램', git: 'git', python: '파이썬' };
  for (const [k, cands] of Object.entries(where)) {
    const hit = cands.find((p) => p && ctx.exists(p)) || null;
    found[k] = hit;
    if (k === 'claude' || k === 'codex') continue; // 둘은 아래에서 함께 판단
    out.push(finding(`programs.${k}`, G, KO[k], hit ? 'ok' : k === 'node' ? 'bad' : 'warn', hit ? '있습니다.' : '찾지 못했습니다.', { source: ctx.layout === 'installed' ? '설치 도구 폴더' : '실행 경로(PATH)' }));
  }
  // 전달 파일(.cmd)만 남고 그것이 가리키는 실제 프로그램이 없는 경우를 가른다 — 전달 파일 안의 "%~dp0…" 자리가 실제로 있는지 본다(실행하지 않는다)
  //   · 가리키는 자리 가운데 node.exe 는 "있으면 쓰고 없으면 PATH 의 node"라 꼭 있어야 하는 대상이 아니다 — 그 밖의 자리는 **모두** 있어야 한다
  //   · 전달 파일을 읽지 못하거나 가리키는 자리를 하나도 못 읽어 내면 '모름'(정상이라 하지 않는다)
  const hollow = {};
  for (const k of ['claude', 'codex']) {
    const p = found[k];
    if (!p || !/\.cmd$/i.test(p)) continue;
    const text = ctx.readText(p, 64 * 1024);
    const refs = text ? [...text.matchAll(/"%~dp0\\?([^"%]+)"/g)].map((m) => m[1]).filter((rel) => !/(^|[\\/])node\.exe$/i.test(rel)) : [];
    if (!refs.length) hollow[k] = 'unparsed';
    else if (!refs.every((rel) => ctx.exists(path.join(path.dirname(p), rel)))) hollow[k] = 'missing';
  }
  for (const k of ['claude', 'codex']) {
    const src = { source: ctx.layout === 'installed' ? '설치 도구 폴더' : '실행 경로(PATH)' };
    const real = found[k] && !hollow[k];
    const other = ['claude', 'codex'].some((x) => found[x] && hollow[x] !== 'missing');
    if (real) out.push(finding(`programs.${k}`, G, KO[k], 'ok', '있습니다.', src));
    else if (hollow[k] === 'missing') out.push(finding(`programs.${k}`, G, KO[k], 'bad', '실행 길(전달 파일)은 있는데 그것이 가리키는 실제 프로그램이 없습니다.', { ...src, fix: 'cli-repair' }));
    else if (hollow[k] === 'unparsed') out.push(finding(`programs.${k}`, G, KO[k], 'unknown', '실행 길(전달 파일)은 있지만 그것이 가리키는 실제 프로그램을 확인하지 못했습니다.', src));
    else out.push(finding(`programs.${k}`, G, KO[k], other ? 'warn' : 'bad', other ? '찾지 못했습니다(쓰지 않는 PC 라면 정상).' : '클로드 · 코덱스 프로그램을 둘 다 찾지 못했습니다.', { ...src, fix: other ? undefined : 'cli-repair' }));
  }
  if (ctx.layout === 'installed') {
    const miss = ['claude.cmd', 'codex.cmd', 'relay-ensure.cmd'].filter((f) => !ctx.exists(join(ctx.shimsDir, f)));
    out.push(finding('programs.shims', G, '전달 심(실행 길)', miss.length ? 'warn' : 'ok', miss.length ? `전달 심 ${miss.length}개가 없습니다(${miss.join(' · ')}).` : '있습니다.', { source: '전달 심 폴더' }));
  }
  return out;
}

// ---------------------------------------------------------------- 연결 설정
const originOf = (url) => { try { const u = new URL(String(url)); return `${u.protocol}//${u.host}`; } catch { return null; } };

export async function checkWiring(ctx) {
  const G = 'wiring', out = [];
  const want = `http://127.0.0.1:${ctx.relayPort}`;
  const isRelay = (v) => { const o = originOf(v); return !!o && /^(http:\/\/)(127\.0\.0\.1|localhost):/i.test(o) && o.endsWith(`:${ctx.relayPort}`); };
  // 클로드가 어디를 가리키는가 — 자리 셋(사용자 환경 변수 · 클로드 설정 · 전달 심)
  const places = [];
  if (ctx.env.ANTHROPIC_BASE_URL) places.push(['이 실행의 환경', ctx.env.ANTHROPIC_BASE_URL]);
  const userEnv = await ctx.userEnvValue('ANTHROPIC_BASE_URL');
  if (userEnv) places.push(['사용자 환경 변수', userEnv]);
  const st = ctx.claudeDir ? ctx.readJson(join(ctx.claudeDir, 'settings.json')) : null;
  if (st?.value?.env?.ANTHROPIC_BASE_URL) places.push(['클로드 설정', st.value.env.ANTHROPIC_BASE_URL]);
  const shim = ctx.shimsDir ? ctx.readText(join(ctx.shimsDir, 'claude.cmd'), 64 * 1024) : null;
  const m = shim && shim.match(/ANTHROPIC_BASE_URL=([^"\r\n]+)/);
  if (m) places.push(['전달 심', m[1]]);
  const stray = places.filter(([, v]) => !isRelay(v));
  if (!places.length) out.push(finding('wiring.claude', G, '클로드 → 중계기 연결', 'warn', '클로드가 중계기를 가리키는 설정을 찾지 못했습니다(중계기 없이 직접 연결하는 PC 라면 정상).', { source: '환경 변수 · 클로드 설정 · 전달 심' }));
  else if (stray.length) out.push(finding('wiring.claude', G, '클로드 → 중계기 연결', 'warn', `중계기(${want})가 아닌 곳을 가리키는 설정이 있습니다.`, { detail: stray.map(([k, v]) => `${k}: ${originOf(v) || '주소 모양 아님'}`), source: '환경 변수 · 클로드 설정 · 전달 심' }));
  else out.push(finding('wiring.claude', G, '클로드 → 중계기 연결', 'ok', `중계기를 가리킵니다(${places.map(([k]) => k).join(' · ')}).`, { source: '환경 변수 · 클로드 설정 · 전달 심' }));
  // 코덱스가 어디를 가리키는가 — 가벼운 읽기(확실하지 않으면 '모름')
  const toml = ctx.codexDir ? ctx.readText(join(ctx.codexDir, 'config.toml')) : null;
  if (toml === null) out.push(finding('wiring.codex', G, '코덱스 → 중계기 연결', 'skipped', '코덱스 설정 파일이 없습니다.', { skipped: '코덱스를 쓰지 않는 PC 이거나 기본 설정', source: '코덱스 설정' }));
  else {
    // 가벼운 읽기: 표 머리 줄([이름] · [[이름]])로만 구획을 나눈다(여러 줄 배열의 '[' 를 구획으로 읽지 않게). 확실하지 않으면 '모름'.
    const src = { source: '코덱스 설정' };
    const lines = toml.split(/\r?\n/);
    const HEADER = /^\s*\[\[?\s*([A-Za-z0-9_."'-]+(?:\s*\.\s*[A-Za-z0-9_."'-]+)*)\s*\]\]?\s*(?:#.*)?$/;
    const firstHeader = lines.findIndex((l) => HEADER.test(l));
    const top = (firstHeader < 0 ? lines : lines.slice(0, firstHeader)).join('\n');
    const mp = top.match(/^\s*model_provider\s*=\s*(["'])([^"'\r\n]+)\1\s*(?:#.*)?$/m);
    const profile = top.match(/^\s*profile\s*=\s*["']([^"'\r\n]+)["']/m);
    if (profile) out.push(finding('wiring.codex', G, '코덱스 → 중계기 연결', 'unknown', '코덱스가 따로 고른 설정 묶음(profile)을 쓰고 있어 실제 연결을 단정하지 못합니다.', src));
    else if (!mp) out.push(finding('wiring.codex', G, '코덱스 → 중계기 연결', 'warn', '연결 이름(model_provider)이 없습니다 — 코덱스가 중계기를 거치지 않고 직접 연결합니다.', src));
    else if (!/^[\w-]{1,40}$/.test(mp[2])) out.push(finding('wiring.codex', G, '코덱스 → 중계기 연결', 'unknown', '연결 이름이 이 진단기가 읽는 모양이 아니라 단정하지 못합니다.', src));
    else {
      const name = mp[2];
      const start = lines.findIndex((l) => { const h = l.match(HEADER); return !!h && h[1].replace(/["'\s]/g, '') === `model_providers.${name}`; });
      let bu = null;
      if (start >= 0) for (let i = start + 1; i < lines.length && !HEADER.test(lines[i]); i++) { const m2 = lines[i].match(/^\s*base_url\s*=\s*(["'])([^"'\r\n]+)\1/); if (m2) { bu = m2[2]; break; } }
      if (!bu) out.push(finding('wiring.codex', G, '코덱스 → 중계기 연결', name === 'openai' ? 'warn' : 'unknown', name === 'openai' ? '기본 연결(openai)을 씁니다 — 중계기를 거치지 않습니다.' : `연결 이름은 「${name}」인데 그 주소를 읽지 못했습니다.`, src));
      else out.push(finding('wiring.codex', G, '코덱스 → 중계기 연결', isRelay(bu) ? 'ok' : 'warn', isRelay(bu) ? `중계기를 가리킵니다(연결 이름 「${name}」).` : `연결 「${name}」이 중계기가 아닌 곳(${originOf(bu) || '주소 모양 아님'})을 가리킵니다.`, src));
    }
  }
  // 종량 과금 열쇠 변수가 있는가(값은 읽지 않고 있는지만)
  const billing = [];
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    if (ctx.env[k]) billing.push(`${k}(이 실행의 환경)`);
    else if (await ctx.userEnvValue(k)) billing.push(`${k}(사용자 환경 변수)`);
  }
  out.push(finding('wiring.billing', G, '종량 과금 열쇠 변수', billing.length ? 'warn' : 'ok', billing.length ? `API 키 변수가 있습니다 — 에이전트가 구독이 아니라 종량 과금으로 나갈 수 있습니다(${billing.join(' · ')}).` : 'API 키 변수가 없습니다.', { source: '환경 변수(있는지만 확인)' }));
  return out;
}

// ---------------------------------------------------------------- 다시 열기 · 시작
export const CLAUDE_START_NUDGES = { hasCompletedClaudeInChromeOnboarding: true, fullscreenUpsellSeenCount: 3, hasSeenAutoDefaultNudge: true }; // 창 daemon/trust.mjs 와 같은 표

export async function checkResume(ctx) {
  const G = 'resume', out = [];
  const cj = ctx.claudeDir ? ctx.readJson(join(ctx.claudeDir, '.claude.json')) : null;
  if (!cj) out.push(finding('resume.claude-nudges', G, '클로드 시작 안내창', 'warn', '클로드의 첫 실행 기록이 없습니다 — 처음 켤 때 안내창이 떠서 대화가 멈춘 것처럼 보일 수 있습니다.', { source: '클로드 첫 실행 기록' }));
  else {
    const miss = Object.entries(CLAUDE_START_NUDGES).filter(([k, v]) => (typeof v === 'number' ? !(Number(cj.value[k]) >= v) : cj.value[k] !== v)).map(([k]) => k);
    out.push(finding('resume.claude-nudges', G, '클로드 시작 안내창', miss.length ? 'warn' : 'ok', miss.length ? `시작 안내창 ${miss.length}종이 아직 "봤음"으로 적혀 있지 않습니다 — 켤 때 안내창이 떠서 멈춘 것처럼 보일 수 있습니다.` : '시작 안내창이 뜨지 않게 적혀 있습니다.', { dataAt: cj.mtime, source: '클로드 첫 실행 기록', fix: miss.length ? 'claude-nudges' : undefined }));
  }
  const ps = await sharedPs(ctx);
  const inst = ps?.owners?.find((x) => Number(x.port) === ctx.installerPort);
  if (inst?.error) out.push(finding('resume.installer', G, '남아 있는 설치기', 'unknown', '설치기 포트를 조회하지 못했습니다.', { skipped: '포트 조회 실패', source: '윈도우 프로세스 표' }));
  else if (inst?.listening) out.push(finding('resume.installer', G, '남아 있는 설치기', 'warn', `설치기 포트(${ctx.installerPort})를 프로그램(PID ${Number(inst.pid)})이 쓰고 있습니다${inst.isInstaller ? ' — 끝나지 않은 설치기로 보입니다' : ' — 설치기가 아닐 수 있습니다(단정하지 않음)'}.`, { source: '윈도우 프로세스 표' }));
  else if (inst) out.push(finding('resume.installer', G, '남아 있는 설치기', 'ok', '남아 있는 설치기가 없습니다.', { source: '윈도우 프로세스 표' }));
  out.push(finding('resume.codex-provider', G, '코덱스 옛 대화의 연결 이름', 'skipped', '이 판의 진단기는 코덱스 대화 목록(DB)을 열지 않습니다.', { skipped: 'DB 를 열면 보조 파일이 생길 수 있어 읽기만 하는 진단에서 뺌', source: '코덱스 대화 목록' }));
  return out;
}

// ---------------------------------------------------------------- 자원
const GB = 1024 ** 3;
export async function checkResources(ctx) {
  const G = 'resources', out = [];
  const ps = await sharedPs(ctx);
  if (ps && !ps.error && Number(ps.commitFreeKb) > 0) {
    const free = Number(ps.commitFreeKb) * 1024 / GB;
    out.push(finding('resources.commit', G, '메모리 여유(커밋)', free < 1.5 ? 'bad' : free < 4 ? 'warn' : 'ok', `커밋 여유 ${free.toFixed(1)}GB.`, { source: '윈도우 메모리 정보' }));
  } else {
    const free = ctx.freemem() / GB;
    out.push(finding('resources.ram', G, '메모리 여유(실제 RAM)', free < 1 ? 'warn' : 'ok', `RAM 여유 ${free.toFixed(1)}GB(커밋 여유는 확인하지 못함).`, { source: '운영체제 메모리 정보' }));
  }
  const fsi = ctx.root ? ctx.statfs(ctx.root) : null;
  if (!fsi) out.push(finding('resources.disk', G, '디스크 여유', 'unknown', '디스크 여유를 확인하지 못했습니다.', { source: '파일 시스템 정보' }));
  else { const free = Number(fsi.bavail) * Number(fsi.bsize) / GB; out.push(finding('resources.disk', G, '디스크 여유', free < 1 ? 'bad' : free < 5 ? 'warn' : 'ok', `IRIS 가 있는 드라이브의 여유 ${free.toFixed(1)}GB.`, { source: '파일 시스템 정보' })); }
  return out;
}

// ---------------------------------------------------------------- 업데이트 흔적
export async function checkUpdate(ctx) {
  const G = 'update', out = [];
  if (ctx.layout !== 'installed') return [finding('update.traces', G, '업데이트 흔적', 'skipped', '설치본이 아니라서 보지 않습니다.', { skipped: '개발 PC(설치 영수증 없음)', source: '설치 구조' })];
  // 이전 판 폴더(.prev)가 있다는 것만으로 "반쯤 적용됨"이라 하지 않는다 — 마지막 업데이트 결과와 함께 본다.
  const prev = (ctx.listDir(ctx.toolsDir) || []).filter((n) => /\.prev(-\d+)?$/i.test(n));
  const res = ctx.readJson(join(ctx.setupDir, 'update-result.json'));
  if (!res) out.push(finding('update.result', G, '마지막 업데이트', prev.length ? 'unknown' : 'ok', prev.length ? `업데이트 결과 기록이 없는데 이전 판 폴더가 ${prev.length}개 남아 있습니다.` : '업데이트 기록이 없습니다(한 적이 없음).', { source: '업데이트 결과 기록' }));
  else {
    const failed = [].concat(res.value?.items || []).filter((i) => i && i.ok === false);
    const kinds = failed.map((i) => (/^[\w-]{1,20}$/.test(String(i.kind || '')) ? String(i.kind) : '부품')).slice(0, 4); // 부품 이름은 정해진 글자만
    const extra = { dataAt: res.value?.at || res.mtime, source: '업데이트 결과 기록', detail: prev.length ? [`이전 판 폴더 ${prev.length}개가 남아 있음(되돌리기용 사본)`] : undefined };
    if (res.value?.ok === false || failed.length) out.push(finding('update.result', G, '마지막 업데이트', 'bad', `마지막 업데이트가 끝까지 되지 않았습니다(실패한 부품 ${failed.length}개${kinds.length ? `: ${kinds.join(' · ')}` : ''}).`, { ...extra, fix: 'update-recover' }));
    else if (res.value?.ok === true) out.push(finding('update.result', G, '마지막 업데이트', 'ok', '마지막 업데이트는 정상으로 끝났습니다.', extra));
    else out.push(finding('update.result', G, '마지막 업데이트', 'unknown', '업데이트 결과 기록에 성공 · 실패 표시가 없습니다.', extra)); // 빈 기록을 성공으로 읽지 않는다
  }
  return out;
}

// ---------------------------------------------------------------- Doctor 준비
export async function checkDoctor(ctx) {
  const G = 'doctor', out = [];
  // 준비 상태는 셋을 구별한다: 카드 없음 / 카드만 있음(실제 연결 미확인) / 실제 연결에 성공한 적 있음. 열쇠 값은 읽어도 싣지 않는다.
  const now = ctx.now();
  const src = { source: 'Doctor 계정 자리' };
  const cl = ctx.doctorHome ? ctx.readJson(join(ctx.doctorHome, 'cards', 'claude.json')) : null;
  const cx = ctx.doctorHome ? ctx.readJson(join(ctx.doctorHome, 'cards', 'codex.json')) : null;
  const cxAuth = ctx.doctorHome ? ctx.readJson(join(ctx.doctorHome, 'codex-home', 'auth.json')) : null;
  const clOn = !!(cl?.value?.kind === 'claude' && cl.value.token);
  const cxTok = cxAuth?.value?.tokens;
  const cxOn = !!(cx?.value?.kind === 'codex' && !cxAuth?.value?.OPENAI_API_KEY && cxTok && (cxTok.refresh_token || cxTok.access_token)); // 연결 쪽 codexLoggedIn 과 같은 조건
  // 카드 파일이 있는데 읽지 못했거나 모양이 틀린 것은 "연결 없음"이 아니다(깨진 것 · 권한 문제):
  //   클로드 = 카드를 못 읽음 · 종류 칸이 다름 · 열쇠 칸이 없음 / 코덱스 = 카드를 못 읽음 · 종류 칸이 다름 · 로그인 파일이 있는데 못 읽음
  const there = (...p) => !!ctx.doctorHome && ctx.exists(join(ctx.doctorHome, ...p));
  const broken = [];
  if (there('cards', 'claude.json') && !clOn) broken.push('claude');
  if ((there('cards', 'codex.json') && cx?.value?.kind !== 'codex') || (there('codex-home', 'auth.json') && !cxAuth)) broken.push('codex');
  for (const k of broken) out.push(finding(`doctor.card-${k}`, G, `Doctor 의 ${k === 'claude' ? '클로드' : '코덱스'} 연결`, 'unknown', '연결 파일이 있지만 읽지 못했거나 모양이 맞지 않습니다(깨졌거나 권한 문제일 수 있음) — 다시 연결하면 됩니다.', src));
  // 열쇠가 든 자리에 권한이 걸려 있는가(표시 파일의 방식 판 번호까지 본다) — 못 걸었어도 Doctor 는 돌지만 알린다
  if (clOn || cxOn) {
    const mark = ctx.readTail(join(ctx.doctorHome, '.protected'), 64);
    if (!mark || !/^v3 /.test(mark.text)) out.push(finding('doctor.protect', G, 'Doctor 열쇠 자리의 권한', 'warn', '열쇠가 든 Doctor 폴더를 이 사용자만 열 수 있게 하는 권한을 걸지 못했습니다(이 PC 의 다른 사용자가 읽을 수 있을 수 있음).', src));
  }
  if (!clOn && !cxOn && broken.length) return out;
  if (!clOn && !cxOn) return [finding('doctor.cards', G, 'Doctor 에 연결된 계정', 'warn', '아직 연결된 계정이 없습니다 — 복구 준비 미완료(기계 검진과 기계 처방은 계정 없이도 됩니다).', src)];
  if (clOn) {
    const exp = num(cl.value.expiresAt);
    const ok = cl.value.lastOkAt;
    if (exp && exp <= now) out.push(finding('doctor.card-claude', G, 'Doctor 의 클로드 연결', 'bad', 'Doctor 에 연결한 클로드 열쇠가 만료됐습니다 — 다시 연결해야 합니다.', { ...src, dataAt: cl.mtime }));
    else out.push(finding('doctor.card-claude', G, 'Doctor 의 클로드 연결', ok ? (exp && daysLeft(exp, now) <= 14 ? 'warn' : 'ok') : 'warn', `${ok ? '실제 연결에 성공한 적이 있습니다' : '카드는 있지만 실제 연결을 아직 확인하지 못했습니다'}${exp ? ` · 열쇠 만료까지 ${daysLeft(exp, now)}일` : ''}.`, { ...src, dataAt: ok || cl.mtime }));
  }
  if (cxOn) {
    const ok = cx.value.lastOkAt;
    out.push(finding('doctor.card-codex', G, 'Doctor 의 코덱스 연결', ok ? 'ok' : 'warn', ok ? '실제 연결에 성공한 적이 있습니다.' : '로그인은 돼 있지만 실제 연결을 아직 확인하지 못했습니다.', { ...src, dataAt: ok || cx.mtime }));
  }
  return out;
}
