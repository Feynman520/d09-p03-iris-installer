#!/usr/bin/env node
// iris-auth/status.mjs — 로그인 열쇠 만료 점검.
//   node status.mjs            사람용 요약 출력 + 상태 파일 갱신
//   node status.mjs --json     판정 JSON 출력(IRIS-Face 데몬·대시보드용) + 상태 파일 갱신
//   node status.mjs --notify   위와 같고, 곧 만료/만료가 있으면 윈도 알림 풍선(같은 내용은 12시간에 한 번)
//   node status.mjs --hook     세션 시작 훅용: 알릴 것이 있을 때만 한 줄(읽기만 — 상태 파일을 쓰지 않고 풍선도 띄우지 않는다)
//   … --skip-provider=google   그 공급자의 중계기 계정을 알림 · 상태 파일 · 출력에서 처음부터 뺀다(쉼표로 여럿)
// 열쇠 값은 읽은 즉시 버리고 만료 시각·있음 여부만 남긴다.
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { collect, summaryLine, shouldNotify } from './lib.mjs';

export const STATUS_FILE = path.join(homedir(), '.config', 'iris-auth-status.json');

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
}
export function longKeyFile() {
  return process.env.IRIS_LONGKEY_FILE || path.join(configDir(), 'secrets', 'iris-cli-token.json');
}
export function teamclaudeConfigFile() {
  if (process.env.TEAMCLAUDE_CONFIG && existsSync(process.env.TEAMCLAUDE_CONFIG)) return process.env.TEAMCLAUDE_CONFIG;
  const home = path.join(homedir(), '.config', 'teamclaude.json');
  if (existsSync(home)) return home;
  const portable = path.join(path.dirname(configDir()), 'shared', 'portable-state', 'teamclaude', 'teamclaude.json');
  return existsSync(portable) ? portable : null;
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

export function sanitizeTeamclaude(cfg) {
  return (cfg?.accounts || []).filter(a => a && a.name && a.type === 'oauth').map(a => ({
    name: a.name, provider: a.provider || 'anthropic', hasRefresh: Boolean(a.refreshToken), longKey: a.irisLongKey === true,
    refreshTokenExpiresAt: num(a.refreshTokenExpiresAt), expiresAt: num(a.expiresAt),
    longKeyAt: a.irisLongKeyAt ? (Date.parse(a.irisLongKeyAt) || null) : null, // 1년 열쇠를 받은 시각 — 낡은 중계기 판정 가르기(lib.mjs staleHealth)
  }));
}
export function sanitizeCli(cred, claudeJson) {
  const o = cred?.claudeAiOauth;
  if (!o) return null;
  return { hasRefresh: Boolean(o.refreshToken), refreshTokenExpiresAt: num(o.refreshTokenExpiresAt), email: claudeJson?.oauthAccount?.emailAddress || null };
}
export function sanitizeLongKey(k) {
  if (!k || !k.token) return null;
  return { expiresAt: num(k.expiresAt), email: k.email || null };
}

/**
 * 인자의 `--skip-provider=google[,…]` → 빼고 볼 공급자 이름 목록(없으면 빈 목록). 2026-11-27: IRIS 창이 아직 열지 않은 공급자의
 * 계정을 알림 · 상태 파일 · 출력 **전에** 빼려고 넘긴다(뒤에서 걸러 내면 알림 풍선과 상태 파일에는 이미 들어간다).
 */
export function skipProvidersOf(argv = []) {
  const out = [];
  for (const a of argv) {
    if (typeof a !== 'string' || !a.startsWith('--skip-provider=')) continue;
    for (const p of a.slice('--skip-provider='.length).split(',')) { const v = p.trim().toLowerCase(); if (/^[a-z0-9_-]{1,32}$/.test(v) && !out.includes(v)) out.push(v); }
  }
  return out;
}
/** 중계기 계정 목록에서 그 공급자의 계정을 뺀다(순수 함수 — 목록이 비었으면 받은 그대로) */
export function withoutProviders(accounts, skip) {
  if (!Array.isArray(skip) || !skip.length || !Array.isArray(accounts)) return accounts;
  return accounts.filter(a => !skip.includes(String(a?.provider || 'anthropic').toLowerCase()));
}

export function gather(now = Date.now(), { skipProviders = [] } = {}) {
  const tcFile = teamclaudeConfigFile();
  const tc = tcFile ? readJson(tcFile) : null;
  const health = tcFile ? readJson(path.join(path.dirname(tcFile), 'teamclaude.auth-health.json')) : null;
  const dir = configDir();
  const cli = sanitizeCli(readJson(path.join(dir, '.credentials.json')), readJson(path.join(dir, '.claude.json')));
  const longKey = sanitizeLongKey(readJson(longKeyFile()));
  return collect({ tcAccounts: withoutProviders(sanitizeTeamclaude(tc), skipProviders), health, cli, longKey, now });
}

/**
 * 알림 기록(같은 내용은 12시간에 한 번)이 사는 칸의 이름. 뺀 공급자 조합마다 따로 둔다 — 구글을 빼고 본 호출이
 * "알릴 것 없음"이라며 기록을 지우면, 빼지 않고 보는 호출이 12시간 안에 같은 알림을 다시 띄우게 된다(2026-11-27).
 */
export function memoField(skip) {
  return Array.isArray(skip) && skip.length ? `notify_skip_${[...skip].sort().join('_')}` : 'notify';
}
/** 상태 파일에 있던 알림 기록 칸들(notify · notify_skip_*)만 골라 낸다 — 이번 호출의 칸만 고치고 나머지는 그대로 다시 쓴다 */
export function memosOf(prev) {
  const out = { notify: null };
  for (const [k, v] of Object.entries(prev && typeof prev === 'object' ? prev : {})) if (k === 'notify' || k.startsWith('notify_skip_')) out[k] = v || null;
  return out;
}

function writeStatus(result, memos) {
  const out = { updatedAt: new Date().toISOString(), ...result, ...memos };
  const tmp = `${STATUS_FILE}.${process.pid}.tmp`; // 프로세스마다 다른 이름 — 세션 시작 훅과 창의 주기 점검이 겹쳐도 서로의 임시 파일을 밟지 않는다(2026-11-27)
  writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  try { renameSync(tmp, STATUS_FILE); } catch (err) {
    // 윈도우에서는 둘이 같은 순간에 같은 파일로 이름을 바꾸면 한쪽이 거절된다(시험으로 재현). 진 쪽은 자기 임시 파일을 치우고 물러난다 —
    // 이긴 쪽이 방금 같은 내용을 썼다. 치우지 않으면 `<상태 파일>.<번호>.tmp` 가 겹칠 때마다 하나씩 쌓인다.
    try { unlinkSync(tmp); } catch { /* 이미 없으면 그만 */ }
    throw err;
  }
}

function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }
export function windowsNotify(title, body) {
  if (process.platform !== 'win32' || process.env.IRIS_AUTH_NOTIFY === '0') return false;
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms', 'Add-Type -AssemblyName System.Drawing',
    '$n = New-Object System.Windows.Forms.NotifyIcon', '$n.Icon = [System.Drawing.SystemIcons]::Warning',
    "$n.BalloonTipIcon = 'Warning'", `$n.BalloonTipTitle = ${psQuote(String(title).slice(0, 60))}`,
    `$n.BalloonTipText = ${psQuote(String(body).slice(0, 250))}`, '$n.Visible = $true',
    '$n.ShowBalloonTip(15000)', 'Start-Sleep -Seconds 20', '$n.Dispose()',
  ].join('\n');
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

function fmt(ms) {
  if (!ms) return '모름';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const WORD = { ok: '정상', soon: '곧 만료', expired: '만료', unknown: '모름' };

function main(argv) {
  const now = Date.now();
  const skip = skipProvidersOf(argv);
  const result = gather(now, { skipProviders: skip });
  if (argv.includes('--hook')) {
    // 세션 시작 훅: **읽고 한 줄 내기만** 한다 — 상태 파일을 쓰지 않고 풍선 알림도 띄우지 않는다(2026-11-27).
    // 훅과 창의 주기 점검이 같은 옛 알림 기록을 읽은 뒤 창이 새 기록을 저장하고 훅이 늦게 저장하면, 새 기록이 옛 기록으로
    // 되돌아가 다음 점검에서 같은 알림이 되풀이된다. 상태 파일은 창의 점검(--json · --notify) 한쪽만 쓴다.
    // 중계기 계정은 IRIS 창과 대시보드가 알리므로 여기서는 IRIS 열쇠만 — 같은 알림이 두 번 나오지 않게.
    const iris = result.items.filter(i => i.group === 'iris');
    const line = summaryLine({ ...result, items: iris, due: result.due.filter(id => id.startsWith('iris:')) });
    if (line) process.stdout.write(`[IRIS 인증] ${line}. 사용자에게 알릴 것.\n`);
    return;
  }
  const memos = memosOf(readJson(STATUS_FILE));
  const field = memoField(skip); // 인자가 없으면 'notify' — 예전과 같은 칸
  let memo = memos[field] || null;
  if (argv.includes('--notify')) {
    const d = shouldNotify(result, memo, now);
    if (d.notify && windowsNotify('IRIS 로그인 갱신 필요', summaryLine(result))) memo = { key: d.key, at: now };
    else if (!d.key) memo = null;
  }
  memos[field] = memo;
  try { writeStatus(result, memos); } catch { /* 상태 파일 실패는 점검을 막지 않는다 */ }

  if (argv.includes('--json')) { process.stdout.write(JSON.stringify(result) + '\n'); return; }
  for (const i of result.items) {
    const tail = i.optional ? ' (IRIS 창은 1년 열쇠 사용 — 손으로 연 터미널 전용)' : '';
    process.stdout.write(`${i.label.padEnd(16)} ${WORD[i.level].padEnd(5)} 만료 ${fmt(i.expiresAt)}${i.daysLeft != null ? ` (D-${i.daysLeft})` : ''}${tail}\n`);
  }
  const line = summaryLine(result);
  process.stdout.write(line ? `\n알림: ${line}\n` : '\n알릴 것 없음\n');
}

if (process.argv[1]?.endsWith('status.mjs')) {
  process.stdout.setDefaultEncoding?.('utf8');
  main(process.argv.slice(2));
}
