#!/usr/bin/env node
// iris-auth/longkey.mjs — IRIS 클로드코드용 1년 열쇠 발급.
// `claude setup-token` 과 같은 요청(권한 user:inference, expires_in 31536000)을 직접 보내고,
// 받은 열쇠를 화면에 보이지 않은 채 <CLAUDE_CONFIG_DIR>\secrets\iris-cli-token.json 에 바로 저장한다.
//   node longkey.mjs [--hint <이메일>] [--no-open] [--timeout <초>]          IRIS 창 세션용
//   node longkey.mjs --account <중계기 계정 이름> [--no-open] [--timeout <초>]   중계기 계정 한 개를 1년 열쇠로(승인 계정 대조·백업·다시 읽기)
//   --scope "<권한 …>"  기본 = IRIS 용 user:inference / 중계기 계정 user:inference user:profile. 300일보다 짧게 발급되면 저장하지 않는다.
// 사람이 할 일 = 열린 브라우저에서 「승인」 한 번. 마지막 줄 = RESULT {"ok":…} (IRIS-Face 가 읽음, 열쇠 값 없음).
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { longKeyFile, teamclaudeConfigFile } from './status.mjs';

const AUTHORIZE = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // 클로드코드 공개 클라이언트 id(중계기 oauth.js 와 같음)
const ONE_YEAR = 31536000;

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
function result(obj) { process.stdout.write(`RESULT ${JSON.stringify(obj)}\n`); }
function b64url(buf) { return buf.toString('base64url'); }

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
        finish(new Error(err ? `승인 거절(${err})` : 'state 불일치 또는 코드 없음'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(true, '이 창은 닫아도 됩니다.'));
      finish(null, code);
    });
    const timer = setTimeout(() => finish(new Error('시간 초과(승인 없음)')), timeoutMs);
    let done = false;
    function finish(e, code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setTimeout(() => server.close(), 200);
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
  if (!res.ok) throw new Error(`열쇠 교환 실패(HTTP ${res.status}): ${text.slice(0, 200).replace(/[A-Za-z0-9_-]{40,}/g, '…')}`);
  return JSON.parse(text);
}

export function toRecord(tok, now = Date.now()) {
  if (!tok?.access_token) throw new Error('응답에 열쇠가 없음');
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

/**
 * 중계기(TeamClaude) 계정 한 개의 열쇠를 1년 열쇠로 바꾼다. 승인한 계정 이메일이 대상과 다르면 아무것도 쓰지 않는다.
 * 바꾸기 전 설정 전체를 ~\.config\teamclaude-before-longkey-<시각>.json 으로 남기고(되돌리기용), 쓴 뒤 중계기에 다시 읽기를 부탁한다.
 * 갱신 열쇠(refreshToken)는 지운다 — 1년 열쇠는 갱신하지 않으며, 남겨 두면 중계기가 옛 30일 열쇠로 덮어쓴다.
 */
export function patchAccount(cfg, account, rec) {
  const a = (cfg.accounts || []).find(x => x && x.name === account && (x.provider || 'anthropic') === 'anthropic');
  if (!a) throw new Error(`중계기에 그 계정이 없음: ${account}`);
  if (rec.email && /@/.test(account) && rec.email.toLowerCase() !== account.toLowerCase()) throw new Error(`승인한 계정(${rec.email})이 대상(${account})과 다름 — 바꾸지 않음`);
  a.accessToken = rec.token;
  a.expiresAt = rec.expiresAt;
  a.refreshTokenExpiresAt = rec.expiresAt; // 중계기 auth-health 의 만료 3일 전 경고가 이 값을 본다
  delete a.refreshToken;
  a.irisLongKey = true;
  a.irisLongKeyAt = rec.createdAt;
  return a;
}
async function saveToTeamclaude(account, rec) {
  const file = teamclaudeConfigFile();
  if (!file) throw new Error('중계기 설정 파일을 찾지 못함');
  const raw = readFileSync(file, 'utf8');
  const cfg = JSON.parse(raw);
  patchAccount(cfg, account, rec);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const backup = path.join(path.dirname(file), `teamclaude-before-longkey-${stamp}.json`);
  writeFileSync(backup, raw, { encoding: 'utf8', mode: 0o600 });
  const tmp = `${file}.tmp-longkey`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  let reloaded = false;
  try { const r = await fetch('http://127.0.0.1:3456/teamclaude/reload', { method: 'POST' }); reloaded = r.ok; } catch { /* 꺼져 있으면 다음 켜기 때 읽음 */ }
  process.stdout.write(`중계기 계정 ${account} → 1년 열쇠(만료 ${new Date(rec.expiresAt).toLocaleString('ko-KR')}) · 백업 ${path.basename(backup)} · 다시 읽기 ${reloaded ? '완료' : '못 함'}\n`);
  result({ ok: true, target: 'teamclaude', account, email: rec.email, expiresAt: rec.expiresAt, expiresIn: rec.expiresIn, reloaded });
}

let account = null;
async function main() {
  account = arg('--account');
  const hint = arg('--hint') || account;
  const timeoutMs = (Number(arg('--timeout')) || 600) * 1000;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(32));

  const p = waitForCode(state, timeoutMs);
  const server = waitForCode.server;
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;
  // 중계기 계정은 사용량 조회(/api/oauth/usage)에 user:profile 이 필요하다(2026-10-15 실측: inference 만이면 403, 둘 다 넣어도 365일 발급).
  const scope = arg('--scope') || (account ? 'user:inference user:profile' : 'user:inference');
  const url = buildAuthorizeUrl({ port, challenge, state, hint, scope });
  process.stdout.write(`브라우저에서 ${account ? '중계기 계정' : 'IRIS'} 1년 열쇠 발급을 승인해 주세요${hint ? ` (계정 ${hint})` : ''}.\n브라우저가 안 열리면 이 주소를 여세요:\n${url}\n`);
  if (!process.argv.includes('--no-open')) openBrowser(url, { private: process.argv.includes('--private') });

  const { code } = await p;
  const tok = await exchange({ code, state, verifier, port });
  const rec = toRecord(tok);
  // 1년을 요청했는데 짧게 내주면(권한을 넓혔을 때 등) 저장하지 않는다 — 지금 열쇠가 더 낫다.
  if (rec.expiresIn != null && rec.expiresIn < 300 * 86400) throw new Error(`수명이 ${Math.round(rec.expiresIn / 86400)}일로 짧게 발급됨(권한 ${rec.scope}) — 저장하지 않음`);
  if (account) { await saveToTeamclaude(account, rec); return; }
  const file = longKeyFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  const days = Math.floor((rec.expiresAt - Date.now()) / 86400000);
  process.stdout.write(`발급 완료: ${rec.email || '(계정 이름 없음)'} · 만료 ${new Date(rec.expiresAt).toLocaleString('ko-KR')} (약 ${days}일)\n`);
  result({ ok: true, email: rec.email, expiresAt: rec.expiresAt, expiresIn: rec.expiresIn, scope: rec.scope });
}

if (process.argv[1]?.endsWith('longkey.mjs')) {
  main().catch(e => { process.stdout.write(`발급 실패: ${e.message}\n`); result({ ok: false, error: e.message }); process.exitCode = 1; });
}
