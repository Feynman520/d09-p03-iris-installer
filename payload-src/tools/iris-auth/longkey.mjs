#!/usr/bin/env node
// iris-auth/longkey.mjs — IRIS 클로드코드용 1년 열쇠 발급.
// `claude setup-token` 과 같은 요청(권한 user:inference, expires_in 31536000)을 직접 보내고,
// 받은 열쇠를 화면에 보이지 않은 채 <CLAUDE_CONFIG_DIR>\secrets\iris-cli-token.json 에 바로 저장한다.
//   node longkey.mjs [--hint <이메일>] [--no-open] [--timeout <초>]          IRIS 창 세션용
//   node longkey.mjs --account <중계기 계정 이름> [--no-open] [--timeout <초>]   중계기 계정 한 개를 1년 열쇠로(승인 계정 대조·백업·다시 읽기)
//   node longkey.mjs --account <중계기 계정 이름> --also-iris [--no-open] [--timeout <초>]
//                                                승인 한 번으로 받은 열쇠를 두 자리(중계기 계정 줄 + IRIS 창 세션용 파일)에
//   --scope "<권한 …>"  기본 = IRIS 용 user:inference / 중계기 계정 user:inference user:profile. 300일보다 짧게 발급되면 저장하지 않는다.
// 사람이 할 일 = 열린 브라우저에서 「승인」 한 번. 마지막 줄 = RESULT {"ok":…} (IRIS-Face · 설치기가 읽음, 열쇠 값 없음).
//
// --also-iris (두 자리 쓰기)의 순서와 실패 처리:
//   ⓪ 300일보다 짧은 열쇠 · 승인한 계정이 대상과 다른 열쇠는 **어느 자리에도** 쓰지 않는다.
//   ① 중계기 계정 줄 → ② IRIS 창 세션용 파일 → ③ 중계기에 다시 읽기 부탁(①을 썼을 때만).
//      ①을 먼저 하는 까닭: "이 열쇠가 그 계정 것인가"를 가리는 대조가 ①에 있고, 갱신 열쇠를 지우는 것도 ①이다.
//   · 1년 열쇠는 쓸 때마다 바뀌지 않아 한 자리만 써져도 그 자리에서 유효하다 — "반쪽"은 고장이 아니라 미완이다.
//     그래서 한 자리가 실패해도 다른 자리는 그대로 쓰고(또는 이미 쓴 것을 두고), 쓴 자리만 RESULT 에 적는다:
//     relay · iris = ok | skipped | failed, ok = 둘 다 ok, partial = 하나만 ok, reason = 까닭 한 낱말.
//   · 중계기 설정 파일 **전체를 사본으로 되돌리지 않는다**(그사이 중계기가 저장한 다른 변경을 덮는다). 바꾸는 것은 그 계정 한 줄뿐이고,
//     이름을 바꿔 끼우기 직전에 파일을 다시 읽어 대상 줄이 달라졌으면 포기, 다른 줄만 달라졌으면 새로 읽은 것 위에 그 줄만 바꾼다(writeAccountKey).
//   · 이 길의 출력과 RESULT 에는 계정 이름(이메일)을 싣지 않는다(승인 주소의 계정 귀띔 칸에만 있다). 종료 코드 = 0 둘 다 / 2 하나만 / 1 실패.
//   · 한 자리에서 폐기하면 같은 열쇠를 쓰는 다른 자리도 함께 끊긴다 — 그때는 다시 받으면 된다.
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { longKeyFile, teamclaudeConfigFile } from './status.mjs';

const AUTHORIZE = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // 클로드코드 공개 클라이언트 id(중계기 oauth.js 와 같음)
const ONE_YEAR = 31536000;
const RELAY_PORT = 3456;

function b64url(buf) { return buf.toString('base64url'); }
/** 까닭 낱말이 붙은 오류(RESULT 의 reason 칸이 된다). 글은 예전 그대로. */
function fail(code, message) { const e = new Error(message); e.code = code; return e; }

const PAGE = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>IRIS 인증</title>
<body style="font-family:'Malgun Gothic',sans-serif;background:#0f1726;color:#e6ecf5;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:22px;margin-bottom:8px">${ok ? 'IRIS 인증 완료' : 'IRIS 인증 실패'}</div>
<div style="opacity:.75">${msg}</div></div></body>`;

export function buildAuthorizeUrl({ port, challenge, state, hint, scope = 'user:inference' }) {
  const u = new URL(AUTHORIZE);
  u.searchParams.set('code', 'true');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', `http://localhost:${port}/callback`);
  u.searchParams.set('scope', scope);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  if (hint) u.searchParams.set('login_hint', hint);
  return u.toString();
}

// --private: Edge InPrivate 창으로 연다 — 평소 브라우저의 claude.ai 로그인은 그대로 두고 그 창에서만 대상 계정으로 로그인한다
// (평소 창은 이미 승인한 계정이면 화면 없이 자동 승인돼 다른 계정을 고를 수 없다, 2026-10-15 실측).
const EDGE = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map(d => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(f => existsSync(f));
function openBrowser(url, { private: inPrivate = false } = {}) {
  try {
    const c = inPrivate && EDGE
      ? spawn(EDGE, ['--inprivate', url], { detached: true, stdio: 'ignore' })
      : spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => {});
    c.unref();
  } catch { /* 주소는 화면에 따로 찍는다 */ }
}

function waitForCode(state, timeoutMs) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (err || !code || u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(false, '승인이 취소됐거나 요청이 맞지 않습니다. IRIS에서 다시 시도해 주세요.'));
        finish(fail('denied', err ? `승인 거절(${err})` : 'state 불일치 또는 코드 없음'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(true, '이 창은 닫아도 됩니다.'));
      finish(null, code);
    });
    const timer = setTimeout(() => finish(fail('timeout', '시간 초과(승인 없음)')), timeoutMs);
    let done = false;
    function finish(e, code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // 답을 보낸 뒤 닫는다. 브라우저가 붙잡고 있는 빈 연결까지 끊어야 이 프로그램이 곧바로 끝난다.
      setTimeout(() => { server.close(); server.closeIdleConnections?.(); }, 200);
      e ? reject(e) : resolve({ code, port: server.address().port });
    }
    server.listen(0, '127.0.0.1');
    waitForCode.server = server;
  });
}

async function exchange({ code, state, verifier, port }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code', code, redirect_uri: `http://localhost:${port}/callback`,
      client_id: CLIENT_ID, code_verifier: verifier, state, expires_in: ONE_YEAR,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw fail('exchange-failed', `열쇠 교환 실패(HTTP ${res.status}): ${text.slice(0, 200).replace(/[A-Za-z0-9_-]{40,}/g, '…')}`);
  return JSON.parse(text);
}

export function toRecord(tok, now = Date.now()) {
  if (!tok?.access_token) throw fail('exchange-failed', '응답에 열쇠가 없음');
  const expiresIn = Number(tok.expires_in);
  return {
    token: tok.access_token,
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : ONE_YEAR) * 1000,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : null,
    scope: tok.scope || 'user:inference',
    email: tok.account?.email_address || null,
    accountUuid: tok.account?.uuid || null,
    orgUuid: tok.organization?.uuid || null,
    createdAt: new Date(now).toISOString(),
    source: 'iris-auth/longkey.mjs',
  };
}

function findAccount(cfg, account) {
  return (cfg?.accounts || []).find(x => x && x.name === account && (x.provider || 'anthropic') === 'anthropic') || null;
}

/**
 * 중계기(TeamClaude) 계정 한 개의 열쇠를 1년 열쇠로 바꾼다. 승인한 계정 이메일이 대상과 다르면 아무것도 쓰지 않는다.
 * 바꾸기 전 설정 전체를 ~\.config\teamclaude-before-longkey-<시각>.json 으로 남기고(되돌리기용), 쓴 뒤 중계기에 다시 읽기를 부탁한다.
 * 갱신 열쇠(refreshToken)는 지운다 — 1년 열쇠는 갱신하지 않으며, 남겨 두면 중계기가 옛 30일 열쇠로 덮어쓴다.
 */
export function patchAccount(cfg, account, rec) {
  const a = findAccount(cfg, account);
  if (!a) throw fail('relay-account-missing', `중계기에 그 계정이 없음: ${account}`);
  if (rec.email && /@/.test(account) && rec.email.toLowerCase() !== account.toLowerCase()) throw fail('account-mismatch', `승인한 계정(${rec.email})이 대상(${account})과 다름 — 바꾸지 않음`);
  a.accessToken = rec.token;
  a.expiresAt = rec.expiresAt;
  a.refreshTokenExpiresAt = rec.expiresAt; // 중계기 auth-health 의 만료 3일 전 경고가 이 값을 본다
  delete a.refreshToken;
  a.irisLongKey = true;
  a.irisLongKeyAt = rec.createdAt;
  return a;
}

/** 원래 파일의 들여쓰기 · 줄끝 · 끝 줄바꿈대로 다시 적는다 — 바꾸지 않은 줄의 바이트가 달라지지 않게. */
function formatLike(raw, cfg) {
  const m = /^\s*\{\r?\n([ \t]+)"/.exec(raw);
  const indent = m ? m[1] : (/\n/.test(raw.trim()) ? 2 : 0);
  let text = JSON.stringify(cfg, null, indent);
  if (raw.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
  return text + /(?:\r?\n)*$/.exec(raw)[0];
}

/**
 * 중계기 설정에서 **그 계정 한 줄만** 1년 열쇠로 바꿔 쓴다. 다른 줄 · 다른 칸은 건드리지 않는다.
 *   ① 읽는다 → 그 줄만 바꾼 글을 임시 파일에 쓴다(바꾸기 전 설정 전체 사본도 옆에 남긴다 — 사람이 손으로 되돌릴 때용).
 *   ② 이름을 바꿔 끼우기 **직전에 다시 읽는다.** 그사이 파일이 달라졌으면(중계기가 열쇠를 갱신해 저장한 경우 등):
 *      대상 줄이 달라졌다 → 포기(아무것도 바꾸지 않고 사본 · 임시 파일을 치운다, 오류 code='relay-changed')
 *      다른 줄만 달라졌다 → 새로 읽은 것 위에 그 줄만 다시 바꿔 쓴다(한 번. 그 사이에 또 달라졌으면 포기).
 *   도구는 사본으로 설정 전체를 되돌리지 않는다 — 그사이 중계기가 저장한 변경을 덮기 때문이다.
 * beforeCommit = 시험 이음매(①과 ② 사이에 다른 프로그램이 파일을 바꾼 상황을 만든다).
 */
export function writeAccountKey(file, account, rec, { beforeCommit = null } = {}) {
  const rawA = readFileSync(file, 'utf8');
  const cfgA = JSON.parse(rawA);
  const before = JSON.stringify(findAccount(cfgA, account));
  patchAccount(cfgA, account, rec);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const backup = path.join(path.dirname(file), `teamclaude-before-longkey-${stamp}.json`);
  const tmp = `${file}.tmp-longkey`;
  let wroteBackup = false;
  try {
    writeFileSync(backup, rawA, { encoding: 'utf8', mode: 0o600 });
    wroteBackup = true;
    writeFileSync(tmp, formatLike(rawA, cfgA), { encoding: 'utf8', mode: 0o600 });
    if (beforeCommit) beforeCommit();
    const rawB = readFileSync(file, 'utf8');
    if (rawB !== rawA) {
      const cfgB = JSON.parse(rawB);
      if (JSON.stringify(findAccount(cfgB, account)) !== before) throw fail('relay-changed', '쓰는 사이에 중계기 설정의 그 계정 줄이 바뀜 — 바꾸지 않음');
      patchAccount(cfgB, account, rec);
      writeFileSync(tmp, formatLike(rawB, cfgB), { encoding: 'utf8', mode: 0o600 });
      if (readFileSync(file, 'utf8') !== rawB) throw fail('relay-changed', '쓰는 사이에 중계기 설정이 거듭 바뀜 — 바꾸지 않음');
    }
    renameSync(tmp, file);
  } catch (e) {
    // 아무것도 바꾸지 못했다 — 방금 만든 사본(열쇠가 든 설정 전체)과 임시 파일을 남기지 않는다.
    try { unlinkSync(tmp); } catch { /* 없으면 그만 */ }
    if (wroteBackup) { try { unlinkSync(backup); } catch { /* 없으면 그만 */ } }
    if (!e.code || /^E[A-Z]+$/.test(e.code)) e.code = 'relay-write-failed';
    throw e;
  }
  return { backup, port: Number(cfgA?.proxy?.port) || RELAY_PORT };
}

/** IRIS 창 세션용 1년 열쇠 파일을 쓴다(임시 파일 → 이름 바꾸기). */
export function writeIrisKey(file, rec) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(rec, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 없으면 그만 */ }
    throw e;
  }
}

/** 중계기에 다시 읽기를 부탁한다(꺼져 있으면 다음 켜기 때 읽는다). IRIS_AUTH_RELOAD=0 이면 부탁하지 않는다. */
async function reloadRelay(port = RELAY_PORT) {
  if (process.env.IRIS_AUTH_RELOAD === '0') return false;
  try { const r = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' }); return r.ok; } catch { return false; }
}

/**
 * 두 자리 쓰기가 볼 중계기 설정 파일. TEAMCLAUDE_CONFIG 가 정해져 있으면 **그 파일만** 본다 — 그 파일이 없다고
 * 다른 자리(사용자 폴더의 옛 설정 등)를 찾아 나서면 엉뚱한 중계기의 계정 줄을 바꾸게 된다.
 */
export function relayConfigForBoth(env = process.env, fallback = teamclaudeConfigFile) {
  return env.TEAMCLAUDE_CONFIG ? env.TEAMCLAUDE_CONFIG : fallback();
}

/** 사람이 읽는 줄 · RESULT 에 계정 이름이 섞이지 않게(두 자리 쓰기 길). */
function noNames(s) { return String(s ?? '').replace(/[^\s()'"]+@[^\s()'"]+/g, '(계정)'); }

/**
 * 도구 한 번. argv = process.argv 모양. deps 는 시험 이음매다(가짜 열쇠 교환 · 브라우저 안 엶 · 파일 자리 지정 · 가짜 다시 읽기).
 * 돌려주는 값 = 마지막 RESULT 줄에 실은 것과 같다. 던지지 않는다(실패도 RESULT 로).
 */
export async function run(argv = process.argv, {
  exchangeFn = exchange, openFn = openBrowser, reloadFn = reloadRelay,
  write = (s) => process.stdout.write(s), paths = {}, beforeCommit = null,
} = {}) {
  const arg = (name) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : null; };
  const emit = (obj) => { write(`RESULT ${JSON.stringify(obj)}\n`); return obj; };
  const account = arg('--account');
  const both = argv.includes('--also-iris');
  const slots = { relay: 'skipped', iris: 'skipped' };
  const failed = (e) => {
    if (!both) { write(`발급 실패: ${e.message}\n`); return emit({ ok: false, error: e.message }); }
    const reason = e.code || 'failed';
    write(`발급 실패: ${noNames(e.message)}\n`);
    return emit({ ok: false, target: 'both', ...slots, reason, error: noNames(e.message) });
  };

  try {
    if (both && !account) throw fail('usage', '--also-iris 는 --account <중계기 계정 이름> 과 함께 쓴다');
    const hint = arg('--hint') || account;
    const timeoutMs = (Number(arg('--timeout')) || 600) * 1000;
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(32));

    const p = waitForCode(state, timeoutMs);
    p.catch(() => {}); // 아래에서 기다리기 전에 다른 까닭으로 끝나도, 뒤늦은 시간 초과가 처리되지 않은 오류로 남지 않게
    const server = waitForCode.server;
    await new Promise(r => (server.listening ? r() : server.once('listening', r)));
    const port = server.address().port;
    // 중계기 계정은 사용량 조회(/api/oauth/usage)에 user:profile 이 필요하다(2026-10-15 실측: inference 만이면 403, 둘 다 넣어도 365일 발급).
    const scope = arg('--scope') || (account ? 'user:inference user:profile' : 'user:inference');
    const url = buildAuthorizeUrl({ port, challenge, state, hint, scope });
    const who = both ? '' : (hint ? ` (계정 ${hint})` : '');
    write(`브라우저에서 ${both ? '' : (account ? '중계기 계정 ' : 'IRIS ')}1년 열쇠 발급을 승인해 주세요${who}.\n브라우저가 안 열리면 이 주소를 여세요:\n${url}\n`);
    if (!argv.includes('--no-open')) openFn(url, { private: argv.includes('--private') });

    const { code } = await p;
    const tok = await exchangeFn({ code, state, verifier, port });
    const rec = toRecord(tok);
    // 1년을 요청했는데 짧게 내주면(권한을 넓혔을 때 등) 저장하지 않는다 — 지금 열쇠가 더 낫다.
    if (rec.expiresIn != null && rec.expiresIn < 300 * 86400) throw fail('short-lived', `수명이 ${Math.round(rec.expiresIn / 86400)}일로 짧게 발급됨(권한 ${rec.scope}) — 저장하지 않음`);

    if (both) {
      // ① 중계기 계정 줄. 두 자리 쓰기에서는 TEAMCLAUDE_CONFIG 가 가리키는 그 파일만 본다(없다고 다른 자리의 설정을 찾아 나서지 않는다).
      let reason = null;
      let relayPort = RELAY_PORT;
      const cfgFile = paths.configFile ?? relayConfigForBoth();
      if (!cfgFile || !existsSync(cfgFile)) { slots.relay = 'failed'; reason = 'relay-config-missing'; }
      else {
        try { relayPort = writeAccountKey(cfgFile, account, rec, { beforeCommit }).port; slots.relay = 'ok'; } catch (e) {
          slots.relay = 'failed';
          reason = e.code || 'relay-write-failed';
          if (reason === 'account-mismatch') return failed(e); // 다른 계정의 열쇠다 — IRIS 자리에도 넣지 않는다
        }
      }
      // ② IRIS 창 세션용 파일. ①이 실패했어도 쓴다 — 이 열쇠는 이 자리에서 그대로 유효하다.
      try { writeIrisKey(paths.longKeyFile ?? longKeyFile(), rec); slots.iris = 'ok'; } catch { slots.iris = 'failed'; reason = reason ?? 'iris-write-failed'; }
      // ③ 중계기 설정을 바꿨을 때만 다시 읽기를 부탁한다.
      const reloaded = slots.relay === 'ok' ? await reloadFn(relayPort) : false;
      const ok = slots.relay === 'ok' && slots.iris === 'ok';
      const word = { ok: '넣음', skipped: '건너뜀', failed: '못 넣음' };
      write(`1년 열쇠(만료 ${new Date(rec.expiresAt).toLocaleString('ko-KR')}) · 중계기 계정 줄 ${word[slots.relay]} · IRIS 창 세션 ${word[slots.iris]}${slots.relay === 'ok' ? ` · 다시 읽기 ${reloaded ? '완료' : '못 함'}` : ''}\n`);
      return emit({
        ok, target: 'both', ...slots, ...(ok ? {} : { partial: slots.relay === 'ok' || slots.iris === 'ok' }),
        expiresAt: rec.expiresAt, expiresIn: rec.expiresIn, reloaded, ...(reason ? { reason } : {}),
      });
    }

    if (account) {
      const file = paths.configFile ?? teamclaudeConfigFile();
      if (!file) throw new Error('중계기 설정 파일을 찾지 못함');
      const { backup, port: relayPort } = writeAccountKey(file, account, rec, { beforeCommit });
      const reloaded = await reloadFn(relayPort);
      write(`중계기 계정 ${account} → 1년 열쇠(만료 ${new Date(rec.expiresAt).toLocaleString('ko-KR')}) · 백업 ${path.basename(backup)} · 다시 읽기 ${reloaded ? '완료' : '못 함'}\n`);
      return emit({ ok: true, target: 'teamclaude', account, email: rec.email, expiresAt: rec.expiresAt, expiresIn: rec.expiresIn, reloaded });
    }

    writeIrisKey(paths.longKeyFile ?? longKeyFile(), rec);
    const days = Math.floor((rec.expiresAt - Date.now()) / 86400000);
    write(`발급 완료: ${rec.email || '(계정 이름 없음)'} · 만료 ${new Date(rec.expiresAt).toLocaleString('ko-KR')} (약 ${days}일)\n`);
    return emit({ ok: true, email: rec.email, expiresAt: rec.expiresAt, expiresIn: rec.expiresIn, scope: rec.scope });
  } catch (e) {
    return failed(e);
  }
}

if (process.argv[1]?.endsWith('longkey.mjs')) {
  run().then((r) => { process.exitCode = r.ok ? 0 : (r.partial ? 2 : 1); });
}
