// iris-auth/lib.mjs — 로그인 열쇠 만료 판정(순수 함수). 열쇠 값은 받지도 돌려주지도 않는다.
// 입력은 호출자가 만료 시각·있음 여부만 골라 낸 객체다(status.mjs 의 sanitize*).

export const DAY = 86400000;
export const WARN_DAYS = 3;
export const NOTIFY_EVERY_MS = 12 * 3600000;

/** 만료 시각(ms) → 'ok' | 'soon' | 'expired' | 'unknown' */
export function levelOf(expiresAt, now, warnDays = WARN_DAYS) {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return 'unknown';
  const left = expiresAt - now;
  if (left <= 0) return 'expired';
  if (left <= warnDays * DAY) return 'soon';
  return 'ok';
}

/** 남은 날(내림). 만료 뒤는 0, 모르면 null. */
export function daysLeft(expiresAt, now) {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  return Math.max(0, Math.floor((expiresAt - now) / DAY));
}

const RANK = { expired: 3, soon: 2, unknown: 1, ok: 0 };

export function short(name) { return String(name || '').split('@')[0]; }

/**
 * 판정 목록을 만든다.
 * tcAccounts: [{name, provider, hasRefresh, refreshTokenExpiresAt, expiresAt, longKey}]
 * health:     {accounts:[{name, provider, state}]} | null  (중계기 auth-health 상태 파일)
 * cli:        {hasRefresh, refreshTokenExpiresAt, email} | null   (IRIS 클로드코드 /login 열쇠)
 * longKey:    {expiresAt, email} | null                            (IRIS 1년 열쇠 파일)
 */
export function collect({ tcAccounts = [], health = null, cli = null, longKey = null, now = Date.now(), warnDays = WARN_DAYS }) {
  const items = [];
  const healthState = new Map((health?.accounts || []).map(a => [`${a.provider || 'anthropic'}:${a.name}`, a.state]));

  for (const a of tcAccounts) {
    const provider = a.provider || 'anthropic';
    const hs = healthState.get(`${provider}:${a.name}`);
    let expiresAt = null;
    let renew = 'teamclaude-login';
    // 클로드 계정은 30일 열쇠든 1년 열쇠든 갱신 = 1년 열쇠 발급(2026-10-15 실측 통과). 코덱스는 대시보드 로그인.
    if (provider === 'anthropic') {
      renew = 'teamclaude-longkey';
      expiresAt = (a.longKey || !a.hasRefresh) ? (a.expiresAt ?? null) : (a.refreshTokenExpiresAt ?? null);
    }
    let level = provider === 'anthropic' ? levelOf(expiresAt, now, warnDays) : 'ok';
    if (hs === 'needs-login') level = 'expired';
    else if (hs === 'expiring' && level === 'ok') level = 'soon';
    items.push({
      id: `tc:${provider}:${a.name}`, group: 'teamclaude', provider, name: a.name, label: short(a.name),
      longKey: provider === 'anthropic' && Boolean(a.longKey || !a.hasRefresh), expiresAt, daysLeft: daysLeft(expiresAt, now), level, renew, optional: false,
    });
  }

  const longOk = longKey && levelOf(longKey.expiresAt, now, 0) !== 'expired';
  if (longKey) {
    const level = levelOf(longKey.expiresAt, now, warnDays);
    items.push({
      id: 'iris:longkey', group: 'iris', provider: 'anthropic', name: longKey.email || 'IRIS', label: 'IRIS 1년 열쇠',
      longKey: true, expiresAt: longKey.expiresAt, daysLeft: daysLeft(longKey.expiresAt, now), level, renew: 'iris-longkey', optional: false,
    });
  }
  if (cli) {
    const expiresAt = cli.hasRefresh ? (cli.refreshTokenExpiresAt ?? null) : null;
    const level = cli.hasRefresh ? levelOf(expiresAt, now, warnDays) : 'expired';
    items.push({
      id: 'iris:login', group: 'iris', provider: 'anthropic', name: cli.email || 'IRIS', label: longOk ? 'IRIS 터미널 로그인' : 'IRIS 로그인',
      longKey: false, expiresAt, daysLeft: daysLeft(expiresAt, now), level, renew: 'claude-login',
      // 1년 열쇠가 살아 있으면 IRIS 창 세션은 이 열쇠를 쓰지 않는다 → 알림 대상에서 뺀다(손으로 연 터미널 전용).
      optional: Boolean(longOk),
    });
  }

  const counted = items.filter(i => !i.optional);
  const worst = counted.reduce((w, i) => (RANK[i.level] > RANK[w] ? i.level : w), 'ok');
  const due = counted.filter(i => i.level === 'expired' || i.level === 'soon');
  const next = counted.filter(i => Number.isFinite(i.expiresAt)).sort((x, y) => x.expiresAt - y.expiresAt)[0] || null;
  return { items, worst, due: due.map(i => i.id), nextExpiry: next ? { id: next.id, label: next.label, expiresAt: next.expiresAt } : null };
}

/** 사람에게 보일 한 줄(알림 풍선·세션 훅 공용). due 가 없으면 null. */
export function summaryLine(result) {
  const due = result.items.filter(i => result.due.includes(i.id));
  if (!due.length) return null;
  const expired = due.filter(i => i.level === 'expired').map(i => i.label);
  const soon = due.filter(i => i.level === 'soon').map(i => `${i.label}(D-${i.daysLeft})`);
  const parts = [];
  if (expired.length) parts.push(`만료 ${expired.length}개: ${expired.join(', ')}`);
  if (soon.length) parts.push(`곧 만료 ${soon.length}개: ${soon.join(', ')}`);
  return `${parts.join(' / ')} — IRIS 설정 → 인증에서 갱신`;
}

/** 알림 풍선을 띄울지: 같은 내용이면 12시간에 한 번, 내용이 바뀌면 바로. */
export function shouldNotify(result, memo, now) {
  const key = result.items.filter(i => result.due.includes(i.id)).map(i => `${i.id}=${i.level}`).sort().join('|');
  if (!key) return { notify: false, key };
  if (memo?.key !== key) return { notify: true, key };
  return { notify: !memo.at || now - memo.at >= NOTIFY_EVERY_MS, key };
}
