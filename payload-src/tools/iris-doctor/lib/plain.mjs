// IRIS Doctor — 검진 항목의 "쉬운 말"(2026-11-26 사용자 요청: "설명이 무슨 말인지 잘 모르겠음. 쉽고 명확하고 깔끔하게").
//  · 검사 코드가 만드는 title · summary 는 그대로 둔다 — 포트 · 번호 · 연결 이름처럼 정밀한 글은 치료(원인 찾기)와 터미널 검진표에 필요하다.
//  · 이 파일은 그 위에 **쓰는 사람의 말**을 얹는다: 항목마다 name(쉬운 이름) · say(지금 상태 한 문장) · more(문제일 때 "그래서 · 할 일" 한 문장).
//    IRIS 창의 검진표 창이 이것을 보여 준다. 표에 없는 항목은 원래 글을 그대로 쓴다(새 검사를 더해도 화면은 돈다).
//  · 원칙: ① 만든 사람의 말 대신 쓰는 사람의 말(중계기 → IRIS Gate, 열쇠 → 로그인) ② 문제는 "무엇이 → 그래서 → 할 일" ③ 될지 모르는 것을 된다고 적지 않는다.
//  · 글은 여기서 지어낸 사실을 더하지 않는다 — 숫자는 summary 에서 꺼내 쓴다.

/** 묶음의 쉬운 이름(차례 = 검진 묶음의 차례) */
export const PLAIN_GROUPS = [
  ['relay', 'IRIS Gate'],
  ['keys', '로그인'],
  ['window', 'IRIS 창'],
  ['programs', '프로그램'],
  ['wiring', '요금과 설정'],
  ['resume', '대화 시작'],
  ['network', '인터넷'],
  ['resources', '이 PC'],
  ['update', '업데이트'],
  ['doctor', 'Doctor 계정'],
];

const SERVICE = { anthropic: 'Claude', claude: 'Claude', codex: 'Codex', openai: 'Codex', google: 'Antigravity' };
const PROGRAM = { node: '기본 프로그램(Node)', git: 'Git', python: 'Python', claude: 'Claude 프로그램', codex: 'Codex 프로그램' };
const num = (s, re) => { const m = re.exec(String(s || '')); return m ? m[1] : null; };
const gb = (f) => num(f.summary, /([\d.]+)\s*GB/);
const days = (f) => num(f.summary, /(\d+)일/);
const SKIP = '이번에는 보지 않았습니다';
const UNREAD = '확인하지 못했습니다';

// 항목마다: name + 상태별 글. 상태별 글 = '한 문장'(say 만) 또는 [say, more] 또는 (f) => 그 둘 가운데 하나.
const T = {
  'relay.listening': { name: 'IRIS Gate',
    ok: '켜져 있습니다',
    bad: ['IRIS Gate가 응답하지 않습니다', 'AI 계정과 이어 주는 문입니다. 꺼져 있거나 멈추면 Claude · Codex에 요청을 보낼 수 없습니다.'] },
  'relay.owner': { name: 'IRIS Gate 자리',
    ok: '제자리에 있습니다',
    bad: ['다른 프로그램이 IRIS Gate 자리를 쓰고 있습니다', '그 프로그램 때문에 IRIS Gate가 켜지지 못합니다.'],
    warn: ['IRIS Gate 자리를 여러 프로그램이 쓰고 있습니다', '어느 것이 IRIS Gate인지 가리지 못했습니다.'],
    unknown: ['IRIS Gate 자리를 확인하지 못했습니다', 'IRIS Gate가 꺼져 있으면 함께 확인되지 않습니다.'] },
  'relay.accounts': { name: 'AI 계정',
    bad: ['등록된 AI 계정이 없습니다', '계정을 추가해야 대화를 보낼 수 있습니다.'],
    warn: ['다시 로그인이 필요한 계정이 있었습니다', 'IRIS Gate가 꺼져 있어 마지막 기록으로만 알 수 있습니다.'],
    unknown: ['AI 계정의 지금 상태를 알 수 없습니다', 'IRIS Gate가 꺼져 있어 볼 수 없습니다.'] },
  'relay.credit': { name: '충전 크레딧',
    warn: ['충전 크레딧으로 쓰고 있습니다', '요금제 몫이 아니라 충전해 둔 크레딧이 줄어듭니다.'] },
  'relay.guard': { name: 'IRIS Gate 시작 점검',
    ok: '마지막 시작 점검을 통과했습니다',
    bad: ['IRIS Gate가 시작 점검에 걸려 켜지지 못했습니다', '프로그램 파일에 문제가 있어 켜기를 멈췄습니다.'],
    warn: ['IRIS Gate의 화면 점검에 걸린 것이 있습니다', '켜지는 데는 지장이 없습니다.'] },
  'relay.startlog': { name: 'IRIS Gate 시작 기록',
    // 본 것만 말한다: 기록에서 "알려진 고장"을 찾았는가. 글이 남아 있기만 한 것(알려진 고장은 아님)과 가른다.
    ok: '알려진 오류가 보이지 않습니다',
    warn: (f) => (/알려진 고장 종류는 없음/.test(f.summary) ? ['IRIS Gate의 오류 기록에 글이 남아 있습니다', '알려진 고장은 아닙니다. IRIS Gate가 꺼져 있어 함께 알립니다.'] : ['IRIS Gate의 오류 기록에 알려진 고장이 남아 있습니다', '계속되면 「치료하기」로 살펴볼 수 있습니다.']),
    bad: ['IRIS Gate의 오류 기록에 알려진 고장이 남아 있습니다', '「치료하기」로 살펴볼 수 있습니다.'],
    unknown: ['IRIS Gate의 오류 기록을 읽지 못했습니다', ''] },
  'relay.refresh': { name: '로그인 자동 연장',
    ok: '최근 1시간에 실패한 적이 없습니다',
    warn: ['로그인 자동 연장이 실패한 적이 있습니다', '계속되면 그 계정은 다시 로그인해야 합니다.'] },
  'relay.rejects': { name: '사용 한도',
    ok: '최근 1시간에 한도에 자주 걸리지 않았습니다',
    warn: ['사용 한도에 자주 걸리고 있습니다', '최근 1시간에 한도 때문에 거절된 요청이 많습니다.'] },

  'keys.claude-longkey': { name: 'Claude 로그인',
    ok: (f) => (days(f) ? `${days(f)}일 남았습니다` : '살아 있습니다'),
    warn: (f) => (/없습니다/.test(f.summary) ? ['Claude 로그인이 없습니다', 'Claude를 쓰지 않는 PC라면 정상입니다.'] : [`Claude 로그인이 ${days(f) ?? '며칠'}일 뒤 끝납니다`, '끝나기 전에 설정 → 계정 · 보안에서 다시 로그인해 주세요.']),
    bad: ['Claude 로그인이 끝났습니다', '설정 → 계정 · 보안에서 다시 로그인해 주세요.'],
    unknown: ['Claude 로그인이 언제 끝나는지 읽지 못했습니다', ''] },
  'keys.claude-login': { name: 'Claude 프로그램 로그인',
    // 정상에도 뜻이 여럿이다(끝났지만 Claude 로그인이 살아 있어 지장 없음 / 며칠 남음 / 기록만 있음) — 원래 글로 갈라 말한다
    ok: (f) => (/만료됐습니다/.test(f.summary) ? '이 로그인은 끝났지만 Claude 로그인이 살아 있어 지장 없습니다' : /만료까지 \d+일/.test(f.summary) ? `${days(f)}일 남았습니다` : /읽지 못했습니다/.test(f.summary) ? '로그인 기록이 있습니다(언제 끝나는지는 읽지 못했습니다)' : '로그인 기록이 있습니다'),
    warn: ['Claude 프로그램의 로그인을 확인해 주세요', '로그인이 없거나, 끝났거나, 곧 끝납니다. 설정 → 계정 · 보안에서 다시 로그인해 주세요.'],
    bad: ['Claude 프로그램의 로그인이 끝났습니다', '설정 → 계정 · 보안에서 다시 로그인해 주세요.'],
    unknown: ['Claude 프로그램의 로그인 상태를 읽지 못했습니다', ''] },
  'keys.codex-login': { name: 'Codex 로그인',
    ok: '로그인 기록이 있습니다',
    warn: (f) => (/기록이 없습니다/.test(f.summary) ? ['Codex 로그인이 없습니다', 'Codex를 쓰지 않는 PC라면 정상입니다.']
      : /API 키|종량/.test(f.summary) ? ['Codex가 따로 요금이 나가는 방식으로 설정돼 있습니다', '구독 로그인이 아니라 쓴 만큼 내는 방식입니다.']
        : /열쇠가 없습니다/.test(f.summary) ? ['Codex 로그인이 온전하지 않습니다', '로그인 기록은 있지만 쓸 수 없습니다. 다시 로그인해 주세요.']
        : ['Codex 로그인을 확인해 주세요', '무료 요금제로 기록돼 있거나 오래된 로그인입니다.']) },

  'window.daemon': { name: 'IRIS 창',
    ok: '켜져 있습니다',
    warn: ['IRIS 창이 응답하지 않습니다', '꺼져 있거나 다른 프로그램이 그 자리에 있습니다. IRIS를 다시 켜 주세요.'],
    bad: ['IRIS 창이 멈춘 것 같습니다', '응답이 없습니다. 「치료하기」로 살펴볼 수 있습니다.'] },
  'window.owner': { name: 'IRIS 창 자리',
    ok: '제자리에 있습니다',
    bad: ['다른 프로그램이 IRIS 창 자리를 쓰고 있습니다', '그 프로그램 때문에 IRIS 창이 켜지지 못합니다.'],
    warn: ['IRIS 창 자리를 여러 프로그램이 쓰고 있습니다', '어느 것이 IRIS 창인지 가리지 못했습니다.'],
    unknown: ['IRIS 창 자리를 확인하지 못했습니다', ''] },
  'window.folder': { name: 'IRIS 창 파일',
    ok: '꼭 있어야 할 파일이 모두 있습니다',
    bad: ['IRIS 창의 파일이 빠져 있습니다', '꼭 있어야 할 파일이 없습니다. 설치 프로그램을 다시 실행하면 채워집니다.'],
    unknown: ['IRIS 창 폴더의 자리를 알 수 없습니다', ''] },
  'window.log': { name: 'IRIS 창 기록',
    // 오류가 몇 번(다섯 번 미만) 있어도 검사는 정상으로 본다 — 그때는 "없습니다"가 아니라 있었다고 말한다
    ok: (f) => (/눈에 띄는 오류가 없습니다/.test(f.summary) ? '최근 1시간 기록에 눈에 띄는 오류가 없습니다' : `최근 1시간 기록에 오류가 조금 있었습니다(${cut(String(f.summary || '').replace(/\.\s*$/, ''), 60)})`),
    warn: ['IRIS 창에 오류가 여러 번 있었습니다', '최근 1시간 기록에 오류가 여러 번 남았습니다.'] },
  'window.shutdown': { name: '마지막 종료',
    ok: '정상이었습니다',
    // 남은 프로그램이 0개여도 "정상으로 끝났다"는 기록이 없으면 검사는 경고다 — 남은 것이 있었다고 단정하지 않는다
    warn: (f) => (Number(num(f.summary, /(\d+)\s*개/)) > 0 ? ['지난번에 IRIS가 깔끔하게 꺼지지 않았습니다', '끝나지 않고 남은 프로그램이 있었습니다.'] : ['지난번 종료가 정상으로 기록되지 않았습니다', '']) },
  'window.receipt': { name: '설치 기록',
    ok: '설치가 끝까지 됐습니다',
    warn: ['설치가 끝까지 되지 않았습니다', '설치 프로그램을 다시 실행하면 이어서 합니다.'],
    bad: ['설치 기록을 읽을 수 없습니다', '기록 파일이 깨졌거나 비어 있습니다.'],
    unknown: ['옛 판으로 설치한 PC라 설치 단계는 보지 않았습니다', ''] },

  'programs.shims': { name: '프로그램 연결',
    ok: '있습니다',
    warn: ['프로그램을 부르는 연결이 빠져 있습니다', 'claude · codex 명령이 안 될 수 있습니다.'] },

  'wiring.claude': { name: 'Claude 연결 길',
    ok: 'IRIS Gate를 거치게 설정돼 있습니다',
    warn: (f) => (/찾지 못했습니다/.test(f.summary) ? ['Claude가 IRIS Gate를 거치지 않습니다', 'IRIS Gate 없이 직접 연결하는 PC라면 정상입니다.'] : ['Claude가 다른 곳으로 연결되게 설정돼 있습니다', 'IRIS Gate가 아닌 주소가 적혀 있습니다.']) },
  'wiring.codex': { name: 'Codex 연결 길',
    ok: 'IRIS Gate를 거치게 설정돼 있습니다',
    warn: ['Codex가 IRIS Gate를 거치지 않습니다', '직접 연결하도록 설정돼 있습니다.'],
    unknown: ['Codex의 연결 설정을 읽지 못했습니다', ''] },
  'wiring.billing': { name: '요금',
    ok: '따로 요금이 나가는 설정은 보이지 않습니다', // 환경 변수만 본다 — "구독으로만 나간다"고 보장하지 않는다
    warn: (f) => { const names = [...new Set(String(f.summary || '').match(/\b[A-Z][A-Z0-9_]{5,}\b/g) || [])].slice(0, 3); return ['따로 요금이 나갈 수 있는 설정이 있습니다', `구독 대신 쓴 만큼 내는 방식으로 나갈 수 있습니다${names.length ? `(${names.join(' · ')})` : ''}.`]; } },

  'resume.claude-nudges': { name: 'Claude 시작 안내',
    ok: '뜨지 않게 돼 있습니다',
    warn: ['Claude를 켤 때 안내 창이 떠서 멈춘 것처럼 보일 수 있습니다', '「치료하기」의 대상입니다.'] },
  'resume.installer': { name: '설치 프로그램',
    ok: '남아 있지 않습니다',
    warn: ['끝나지 않은 설치 프로그램이 남아 있을 수 있습니다', '설치 창이 열려 있으면 끝까지 마치거나 닫아 주세요.'],
    unknown: ['남아 있는 설치 프로그램이 있는지 확인하지 못했습니다', ''] },
  'resume.codex-provider': { name: 'Codex 옛 대화' },

  'network.all': { name: '인터넷' },
  'network.internet': { name: '인터넷',
    // 원인은 가능성으로만 말한다(검사는 몇몇 서버에 닿는지만 본다)
    warn: ['인터넷은 되지만 보안 인증서를 확인하지 못했습니다', '학교 · 회사 망이 인증서를 바꿔 끼우는 경우일 수 있습니다. AI 연결이 막힐 수 있습니다.'],
    bad: ['확인한 서버에 연결되지 않습니다', '인터넷이 끊겼거나 이 망이 막고 있을 수 있습니다.'] },
  'network.cert': { name: '보안 인증서',
    ok: '확인한 범위에서는 문제가 보이지 않습니다',
    warn: ['보안 인증서를 확인하지 못한 서버가 있습니다', '학교 · 회사 망이 인증서를 바꿔 끼우는 경우일 수 있습니다. AI 연결이 막히면 따로 설정이 필요합니다.'] },

  'resources.commit': { name: '메모리',
    ok: '여유가 충분합니다',
    warn: (f) => ['메모리 여유가 적습니다', `여유 ${gb(f) ?? '?'}GB — 안 쓰는 프로그램을 닫아 주세요.`],
    bad: (f) => ['메모리가 거의 다 찼습니다', `여유 ${gb(f) ?? '?'}GB — 안 쓰는 프로그램을 닫아 주세요.`] },
  'resources.ram': { name: '메모리',
    ok: '여유가 충분합니다',
    warn: (f) => ['메모리 여유가 적습니다', `여유 ${gb(f) ?? '?'}GB — 안 쓰는 프로그램을 닫아 주세요.`] },
  'resources.disk': { name: '저장 공간',
    ok: '여유가 충분합니다',
    warn: (f) => ['저장 공간이 적습니다', `여유 ${gb(f) ?? '?'}GB — 안 쓰는 파일을 지워 주세요.`],
    bad: (f) => ['저장 공간이 거의 다 찼습니다', `여유 ${gb(f) ?? '?'}GB — 안 쓰는 파일을 지워 주세요.`],
    unknown: ['저장 공간을 확인하지 못했습니다', ''] },

  'update.traces': { name: '업데이트' },
  'update.result': { name: '마지막 업데이트',
    // 기록이 없는 것(한 적이 없음)을 "잘 끝났다"고 하지 않는다
    ok: (f) => (/기록이 없습니다/.test(f.summary) ? '업데이트한 기록이 없습니다' : '정상으로 끝났다는 기록이 있습니다'),
    bad: ['지난 업데이트가 끝까지 되지 않았습니다', '「치료하기」로 살펴볼 수 있습니다.'],
    unknown: ['지난 업데이트가 어떻게 끝났는지 알 수 없습니다', ''] },

  'doctor.cards': { name: 'Doctor 계정',
    warn: ['Doctor에 연결된 계정이 없습니다', 'Doctor가 원인을 찾아 고치려면 계정을 연결해 주세요. 살펴보기와 정해진 처방은 계정 없이도 됩니다.'] },
  'doctor.protect': { name: 'Doctor 로그인 보관함',
    warn: ['Doctor의 로그인 보관함을 잠그지 못했습니다', '이 PC의 다른 사용자가 읽을 수 있을 수 있습니다.'] },
};

/** 규칙으로 만드는 항목(계정 · 프로그램 · 바깥 서버 · Doctor 의 계정) */
function ruled(f) {
  let m = /^relay\.accounts\.([a-z0-9-]+)$/.exec(f.id);
  if (m) { const n = SERVICE[m[1]] || m[1]; return { name: `${n} 계정`, ok: f.summary, warn: [`쓸 수 없는 ${n} 계정이 있습니다`, `${f.summary} 다시 로그인이 필요할 수 있습니다.`], bad: [`${n} 계정을 하나도 쓸 수 없습니다`, `${f.summary} 다시 로그인이 필요할 수 있습니다.`] }; }
  m = /^programs\.(node|git|python|claude|codex)$/.exec(f.id);
  if (m) {
    const n = PROGRAM[m[1]], agent = m[1] === 'claude' || m[1] === 'codex';
    return { name: n, ok: '있습니다',
      bad: [`${n}이 빠져 있습니다`, agent ? '「치료하기」의 대상입니다.' : 'IRIS가 쓰는 프로그램입니다. 설치 프로그램을 다시 실행하면 채워집니다.'],
      warn: [`${n}을 찾지 못했습니다`, agent ? '쓰지 않는 PC라면 정상입니다.' : '설치 프로그램을 다시 실행하면 채워집니다.'],
      unknown: [`${n}이 온전한지 확인하지 못했습니다`, ''] };
  }
  m = /^doctor\.card-(claude|codex)$/.exec(f.id);
  if (m) {
    const n = SERVICE[m[1]];
    return { name: `Doctor의 ${n} 계정`, ok: '연결해 두었습니다',
      warn: [`Doctor의 ${n} 계정을 확인해 주세요`, '연결은 했지만 실제로 되는지 아직 확인하지 못했거나, 곧 끝납니다.'],
      bad: [`Doctor의 ${n} 계정이 끝났습니다`, `아래 「${n}」 뱃지를 눌러 다시 연결해 주세요.`],
      unknown: [`Doctor의 ${n} 계정을 읽지 못했습니다`, `아래 「${n}」 뱃지를 눌러 다시 연결하면 됩니다.`] };
  }
  if (/^network\.[a-z0-9-]+$/.test(f.id) && !T[f.id]) return { name: f.title, ok: '연결됩니다', bad: [`${f.title}에 연결되지 않습니다`, f.summary], warn: [`${f.title} 연결이 온전하지 않습니다`, f.summary] };
  return null;
}

const cut = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);

/**
 * 항목 하나의 쉬운 말. → { name, say, more }
 *  · name = 쉬운 이름 · say = 지금 상태 한 문장(문제면 그 문제를 말하는 문장) · more = 문제일 때 "그래서 · 할 일"(없으면 '')
 *  · 표에 없으면 원래 글(title · summary)을 쓴다.
 */
export function plainOf(f) {
  const base = { name: cut(f?.title, 40), say: cut(f?.summary, 120), more: '' };
  if (!f || typeof f.id !== 'string') return base;
  const e = T[f.id] || ruled(f);
  if (!e) return base;
  const name = cut(e.name || f.title, 40);
  if (f.state === 'skipped') return { name, say: SKIP, more: '' };
  let v = e[f.state];
  if (typeof v === 'function') { try { v = v(f); } catch { v = undefined; } }
  if (v === undefined || v === null) return f.state === 'unknown' ? { name, say: UNREAD, more: cut(f.summary, 200) } : { name, say: cut(f.summary, 120), more: '' };
  const [say, more] = Array.isArray(v) ? v : [v, ''];
  return { name, say: cut(say, 120) || cut(f.summary, 120), more: cut(more, 200) };
}
