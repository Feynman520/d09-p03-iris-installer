#!/usr/bin/env node
// iris-auth/status.mjs — 로그인 열쇠 만료 점검.
//   node status.mjs            사람용 요약 출력 + 상태 파일 갱신
//   node status.mjs --json     판정 JSON 출력(IRIS-Face 데몬·대시보드용) + 상태 파일 갱신
//   node status.mjs --notify   위와 같고, 곧 만료/만료가 있으면 윈도 알림 풍선(같은 내용은 12시간에 한 번)
//   node status.mjs --hook     세션 시작 훅용: 알릴 것이 있을 때만 한 줄
// 열쇠 값은 읽은 즉시 버리고 만료 시각·있음 여부만 남긴다.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
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

export function gather(now = Date.now()) {
  const tcFile = teamclaudeConfigFile();
  const tc = tcFile ? readJson(tcFile) : null;
  const health = tcFile ? readJson(path.join(path.dirname(tcFile), 'teamclaude.auth-health.json')) : null;
  const dir = configDir();
  const cli = sanitizeCli(readJson(path.join(dir, '.credentials.json')), readJson(path.join(dir, '.claude.json')));
  const longKey = sanitizeLongKey(readJson(longKeyFile()));
  return collect({ tcAccounts: sanitizeTeamclaude(tc), health, cli, longKey, now });
}

function writeStatus(result, memo) {
  const out = { updatedAt: new Date().toISOString(), ...result, notify: memo || null };
  const tmp = `${STATUS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  renameSync(tmp, STATUS_FILE);
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
  const result = gather(now);
  const prev = readJson(STATUS_FILE);
  let memo = prev?.notify || null;
  if (argv.includes('--notify')) {
    const d = shouldNotify(result, memo, now);
    if (d.notify && windowsNotify('IRIS 로그인 갱신 필요', summaryLine(result))) memo = { key: d.key, at: now };
    else if (!d.key) memo = null;
  }
  try { writeStatus(result, memo); } catch { /* 상태 파일 실패는 점검을 막지 않는다 */ }

  if (argv.includes('--json')) { process.stdout.write(JSON.stringify(result) + '\n'); return; }
  if (argv.includes('--hook')) {
    // 중계기 계정은 기존 세션 훅(teamclaude-auth-notice.py)이 알리므로 여기서는 IRIS 열쇠만 — 같은 줄이 두 번 나오지 않게.
    const iris = result.items.filter(i => i.group === 'iris');
    const line = summaryLine({ ...result, items: iris, due: result.due.filter(id => id.startsWith('iris:')) });
    if (line) process.stdout.write(`[IRIS 인증] ${line}. 사용자에게 알릴 것.\n`);
    return;
  }
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
