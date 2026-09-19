// 「개발자에게 신고하기」(2026-09-19 사용자 요청: 설치기가 멈추면 자세한 원인과 함께 개발자에게 오게).
//
// 길: 설치기 서버(127.0.0.1:3460)가 진단 묶음을 만들어 **개발자의 접수 양식(구글 폼)** 에 POST 한다.
//   - 사용자 PC 에서 직접 나가는 요청은 docs.google.com 하나뿐이다(학교·회사 망에서도 대개 열려 있다).
//   - 토큰·키·계정이 필요 없다(공개 접수 양식). 접수된 것은 개발자 계정의 응답 시트에 쌓이고 알림이 간다.
//   - 보내는 내용은 화면에 미리 보여 주고, 사람이 단추를 눌렀을 때만 보낸다. 자동 전송(텔레메트리)은 없다(D2-23).
//   - 사용자 이름은 `setup/report.mjs maskText` 로 `<user>` 처리한 뒤 보낸다. 로그인 토큰·키는 애초에 묶음에 넣지 않는다.
//   - 보낸 묶음의 사본을 로컬에 남긴다(`_agent\setup\신고-<접수번호>.json`, 영혼이 없으면 설치기 로그 폴더).
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { maskText } from '../setup/report.mjs';

export const REPORT_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSc-wXnIOPaMU9XSj0UM_t1gOFFfnMAly9NDKNDKkEGUtmAxZA/formResponse';
// 양식 항목 번호(2026-09-19 생성, Forms API questionId 를 십진수로 바꾼 값 — 응답 페이지의 FB_PUBLIC_LOAD_DATA_ 로 확인).
export const FORM_FIELDS = Object.freeze({
  id: 'entry.1325620015',
  version: 'entry.1633758488',
  where: 'entry.1840968860',
  summary: 'entry.800969080',
  diagnostics: 'entry.344610544',
  logs: 'entry.332237770',
  memo: 'entry.1736423815',
  contact: 'entry.2129489594',
});
// 구글 폼 긴 답 칸은 넉넉하지만 무한하지 않다 — 항목별 상한(글자 수). 넘치면 앞을 자르고 표시를 남긴다.
export const LIMITS = Object.freeze({ summary: 12_000, diagnostics: 60_000, logs: 40_000, memo: 4_000, contact: 200, tailLines: 200 });

export function newReportId(now = new Date(), rand = crypto.randomBytes(2).toString('hex')) {
  const p = (n) => String(n).padStart(2, '0');
  return `R-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${rand}`;
}

export function tailLines(text, n = LIMITS.tailLines) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

export function clip(text, max, { head = false } = {}) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return head ? `${s.slice(0, max)}\n…[${s.length - max}자 잘림]` : `…[앞 ${s.length - max}자 잘림]\n${s.slice(s.length - max)}`;
}

function readSafe(fs, file) {
  if (!file) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// 화면 상태(state)에서 보낼 것만 고른다 — 토큰·키가 들어올 수 있는 자리는 애초에 없지만, 로그인 세부(state.online.logins 의 reason)는 문장뿐이다.
export function pickState(state = {}) {
  const setup = state.setup ?? {};
  const online = state.online ?? {};
  return {
    step: state.step ?? null,
    packageVersion: state.packageVersion ?? null,
    choice: state.choice ?? null,
    soul: state.soul ? { root: state.soul.root ?? null, name: state.soul.name ?? null, kind: state.soul.kind ?? null } : null,
    precheck: state.precheck?.recorded
      ? { blockers: state.precheck.recorded.blockers ?? [], warnings: state.precheck.recorded.warnings ?? [], os: state.precheck.recorded.os ?? null }
      : (state.precheck ? { blockers: state.precheck.blockers ?? [], warnings: state.precheck.warnings ?? [] } : null),
    setup: { stage: setup.stage ?? null, percent: setup.percent ?? null, error: setup.error ?? null, stages: setup.stages ?? null, pending: setup.pending ?? null, live: setup.live ?? null },
    online: { stage: online.stage ?? null, net: online.net ?? null, claude: online.claude ?? null, documentSkills: online.documentSkills ?? null, logins: online.logins ?? null, relay: online.relay ?? null, error: online.error ?? null, recheck: online.recheck ?? null },
    auto: state.auto ? { eligible: state.auto.eligible ?? null, reason: state.auto.reason ?? null, from: state.auto.from ?? null, to: state.auto.to ?? null, viaWizard: state.auto.viaWizard ?? null } : null,
    autoResult: state.autoResult ?? null,
    installError: state.installError ?? null,
  };
}

export function environmentFingerprint() {
  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cpus: os.cpus()?.length ?? null,
    memGB: Math.round((os.totalmem() / 1073741824) * 10) / 10,
    at: new Date().toISOString(),
  };
}

/**
 * buildReportPayload({ state, root, logs:{server,soul}, memo, contact, now, fs })
 *   -> { id, version, where, summary, diagnostics, logs, memo, contact }  (전부 문자열, 사용자 이름 가림·상한 적용)
 */
export function buildReportPayload({ state = {}, root = null, logs = {}, memo = '', contact = '', now = new Date(), fs = nodeFs, env = environmentFingerprint() } = {}) {
  const mask = (t) => maskText(String(t ?? ''), { root });
  const picked = pickState(state);
  const code = picked.setup.error?.code ?? picked.online?.error?.code ?? picked.auto?.error?.code ?? null;
  const where = [
    `step=${picked.step ?? '?'}`,
    `setup.stage=${picked.setup.stage ?? '-'}`,
    `online.stage=${picked.online.stage ?? '-'}`,
    `code=${code ?? '-'}`,
  ].join(' / ');
  const summary = clip(mask(JSON.stringify({ env, ...picked }, null, 2)), LIMITS.summary, { head: true });
  const diagFile = root ? path.join(root, '_agent', 'setup', 'diagnostics.json') : null;
  const diag = readSafe(fs, diagFile);
  const diagnostics = diag == null ? `(diagnostics.json 없음: ${diagFile ?? '영혼 폴더가 아직 정해지지 않음'})` : clip(mask(diag), LIMITS.diagnostics, { head: true });
  const logParts = [];
  for (const [name, file] of [['설치기 로그', logs.server], ['영혼 사본', logs.soul]]) {
    const t = readSafe(fs, file);
    if (t == null) continue;
    logParts.push(`=== ${name} (${mask(file)}) 마지막 ${LIMITS.tailLines}줄 ===\n${mask(tailLines(t))}`);
  }
  const bootstrap = logs.server ? readSafe(fs, path.join(path.dirname(logs.server), 'bootstrap.log')) : null;
  if (bootstrap != null) logParts.push(`=== bootstrap.log 마지막 60줄 ===\n${mask(tailLines(bootstrap, 60))}`);
  // IRIS 창 쪽(2.0.22): 창의 「업데이트」가 왜 안 됐는지는 창 데몬 로그·적용기 결과에만 남는다.
  if (root) {
    const faceState = path.join(root, '_agent', 'shared', 'tools', 'face', 'state');
    for (const [name, file, n] of [
      ['IRIS 창 데몬 로그', path.join(faceState, 'daemon.log'), 120],
      ['IRIS 창 실행기 로그', path.join(faceState, 'launch.log'), 40],
      ['업데이트 적용 결과', path.join(root, '_agent', 'setup', 'update-result.json'), 80],
    ]) {
      const t = readSafe(fs, file);
      if (t == null) continue;
      logParts.push(`=== ${name} (${mask(file)}) 마지막 ${n}줄 ===\n${mask(tailLines(t, n))}`);
    }
  }
  return {
    id: newReportId(now),
    version: String(picked.packageVersion ?? 'unknown'),
    where: mask(where),
    summary,
    diagnostics,
    logs: clip(logParts.join('\n\n') || '(로그 파일 없음)', LIMITS.logs),
    memo: clip(mask(String(memo ?? '').trim()), LIMITS.memo, { head: true }),
    contact: clip(String(contact ?? '').trim().replace(/[\r\n]+/g, ' '), LIMITS.contact, { head: true }),
  };
}

export function encodeForm(payload, fields = FORM_FIELDS) {
  const p = new URLSearchParams();
  for (const [key, entry] of Object.entries(fields)) p.set(entry, String(payload[key] ?? ''));
  return p.toString();
}

/** POST 한 번. 구글 폼은 접수되면 200(HTML) 을 준다. 실패는 4xx/5xx 또는 예외. → { ok, status, error? } */
export async function sendReport(payload, { fetchImpl = globalThis.fetch, url = REPORT_FORM_URL, timeoutMs = 20_000 } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, status: null, error: 'fetch 없음' };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: encodeForm(payload),
      redirect: 'follow',
      signal: ac.signal,
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch (e) {
    return { ok: false, status: null, error: e?.name === 'AbortError' ? `응답 없음(${timeoutMs / 1000}초)` : String(e?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

/** 보낸(또는 보내려던) 묶음의 사본. 영혼이 있으면 `_agent\setup\`, 없으면 설치기 로그 폴더. */
export function saveReportCopy({ root = null, fallbackDir = null, payload, fs = nodeFs, sent = null }) {
  const dir = root ? path.join(root, '_agent', 'setup') : fallbackDir;
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `신고-${payload.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...payload, sent, savedAt: new Date().toISOString() }, null, 2), 'utf8');
    return { path: file };
  } catch (e) {
    return { path: null, error: String(e?.message ?? e) };
  }
}

export default { buildReportPayload, sendReport, saveReportCopy, encodeForm, newReportId, tailLines, clip, pickState, REPORT_FORM_URL, FORM_FIELDS, LIMITS };
