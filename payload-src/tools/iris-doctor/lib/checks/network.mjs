// 검진 묶음: 망. 열쇠 없이 "그 서버가 답하는가"만 본다(본문은 읽지 않는다). --offline 이면 통째로 건너뛴다.
import { finding } from '../report.mjs';

const G = 'network';
// [항목 이름, 사람이 읽는 이름, 주소들] — 주소 가운데 하나라도 답하면 닿는 것으로 본다(어떤 HTTP 상태든 "답"이다).
export const TARGETS = [
  ['anthropic', '클로드(Anthropic) 서버', ['https://api.anthropic.com/', 'https://platform.claude.com/']],
  ['openai', '코덱스(OpenAI) 서버', ['https://auth.openai.com/', 'https://chatgpt.com/']],
  ['github', '업데이트 서버(GitHub)', ['https://api.github.com/']],
];
const KIND_KO = { dns: '주소를 찾지 못함', refused: '연결이 거절됨', timeout: '시간 안에 답이 없음', cert: '인증서를 믿을 수 없음', other: '연결 실패' };

export async function checkNetwork(ctx) {
  if (ctx.offline) return [finding('network.all', G, '바깥 연결', 'skipped', '통신 없이 도는 방식이라 보지 않았습니다.', { skipped: '--offline', source: '없음' })];
  const out = [];
  const results = await Promise.all(TARGETS.map(async ([id, name, urls]) => {
    const rs = await Promise.all(urls.map((u) => ctx.httpProbe(u)));
    return { id, name, ok: rs.some((r) => r.ok), kinds: [...new Set(rs.filter((r) => !r.ok).map((r) => r.kind))] };
  }));
  const reached = results.filter((r) => r.ok).length;
  const certHit = results.some((r) => r.kinds.includes('cert'));
  for (const r of results) {
    if (r.ok) out.push(finding(`network.${r.id}`, G, r.name, 'ok', '답합니다.', { source: '열쇠 없는 연결 확인' }));
    else out.push(finding(`network.${r.id}`, G, r.name, r.kinds.includes('cert') ? 'warn' : 'bad', `닿지 않습니다 — ${r.kinds.map((k) => KIND_KO[k] || k).join(' · ')}.`, { source: '열쇠 없는 연결 확인' }));
  }
  // 전부 인증서 때문에 못 닿은 것이면 "인터넷이 끊김"이라 하지 않는다(망은 살아 있고 인증서만 다른 것일 수 있다)
  const onlyCert = !reached && results.every((r) => r.kinds.length && r.kinds.every((k) => k === 'cert'));
  if (onlyCert) out.push(finding('network.internet', G, '인터넷', 'warn', '확인한 서버 모두 인증서를 믿을 수 없다는 답이었습니다 — 인터넷은 되지만 망이 인증서를 바꿔 끼우는 것으로 보입니다.', { source: '열쇠 없는 연결 확인' }));
  else if (!reached) out.push(finding('network.internet', G, '인터넷', 'bad', '확인한 서버 어디에도 닿지 않습니다 — 인터넷이 끊겼거나 망이 막고 있습니다.', { source: '열쇠 없는 연결 확인' }));
  // 인증서를 바꿔 끼우는 망(학교 · 회사)으로 보이는가 — 단정하지 않고 '주의'로 둔다
  const hints = [];
  // Doctor 가 스스로 채운 값(IRIS_DOCTOR_CA_FILLED — lib/trust.mjs · 시작 파일)은 이 PC 의 설정이 아니므로 알리지 않는다
  if (ctx.env.NODE_USE_SYSTEM_CA && !ctx.env.IRIS_DOCTOR_CA_FILLED) hints.push('시스템 인증서를 쓰도록 설정돼 있음');
  if (ctx.env.NODE_EXTRA_CA_CERTS) hints.push('추가 인증서 파일이 설정돼 있음');
  if (ctx.env.HTTPS_PROXY || ctx.env.https_proxy || ctx.env.HTTP_PROXY || ctx.env.http_proxy) hints.push('프록시 변수가 설정돼 있음');
  if (certHit) out.push(finding('network.cert', G, '인증서', 'warn', '인증서를 믿을 수 없다는 답이 있었습니다 — 인증서를 바꿔 끼우는 망(학교 · 회사)일 수 있습니다.', { detail: hints, source: '열쇠 없는 연결 확인', fix: 'system-ca' }));
  else if (hints.length) out.push(finding('network.cert', G, '인증서 · 프록시 설정', 'ok', hints.join(' · ') + '.', { source: '이 실행의 환경' }));
  return out;
}
