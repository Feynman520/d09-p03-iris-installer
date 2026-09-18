// installer/ui/index.html(v2 화면 8장)을 **글자 수준**으로 지키는 시험.
// node --test 에는 DOM이 없으므로, 화면 동작 자체는 verify/e2e-checklist.md(사람)와
// installer/ui/mock-server.mjs(가짜 서버)로 확인하고, 여기서는 "절대 깨지면 안 되는 약속"만 본다.
//
// 이 파일은 v1 시험(tests/handoff.test.mjs 안의 ⓐ~ⓕ 6카드 시험 2벌)을 대신한다 — v2는 카드가
// 8장이고 상태 이름·복원 방식이 모두 바뀌었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'installer', 'ui');
const html = () => fs.readFileSync(path.join(UI, 'index.html'), 'utf8');

test('ui/index.html: 중계 프로그램 상표 이름 0회 · 바깥 자원 0건 · 20칸 막대 · doctype', () => {
  const src = html();

  assert.ok(!src.includes('TeamClaude'), '화면은 중계 프로그램의 상표 이름을 쓰지 않는다(= "계정 연결")');
  assert.ok(src.includes('계정 연결'), '중계기는 화면에서 「계정 연결」로 부른다');
  assert.ok(src.includes('Claude 계정 로그인'));
  assert.ok(src.includes('ChatGPT 계정 로그인'));

  // 단일 파일 — 인터넷이 끊긴 PC에서도 똑같이 보여야 한다.
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(src), '바깥 CDN·글꼴 참조가 없어야 한다');
  assert.ok(!/@import/.test(src));
  // 같은 폴더의 structure.mjs 만 모듈로 가져온다.
  assert.ok(/from '\.\/structure\.mjs'/.test(src), 'structure.mjs를 상대 경로로 import 한다');
  assert.ok(/<script type="module">/.test(src));

  // 20칸 고정 진행 막대(전역 표기 규칙), 퍼센트는 내림.
  assert.ok(src.includes('█') && src.includes('░'));
  assert.ok(/BAR_CELLS\s*=\s*20/.test(src), '진행 막대는 20칸');
  assert.ok(src.includes('Math.floor'), '퍼센트는 올림이 아니라 내림');

  assert.ok(src.startsWith('<!doctype html>\n'), '첫 줄은 doctype(없으면 옛 방식으로 그려진다)');
});

test('ui/index.html: 카드 8장 + 업데이트 2장이 모두 있다', () => {
  const src = html();
  for (const mark of ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧']) {
    assert.ok(src.includes(mark), `카드 표시 ${mark} 없음`);
  }
  for (const id of ['precheck', 'locate', 'choice', 'structure', 'summary', 'setup', 'online', 'done', 'auto', 'reinstall']) {
    assert.ok(src.includes('card-' + id), `카드 id card-${id} 없음`);
  }
  // 계약의 step 순서
  assert.ok(/const STEPS = \['precheck', 'locate', 'choice', 'structure', 'summary', 'setup', 'online', 'done'\]/.test(src));
  // 1.x 영수증 안내는 홈페이지·릴리스 노트와 같은 한 문장이어야 한다(설계 11절).
  assert.ok(src.includes('2.0은 설치 방식이 바뀌어 새로 설치합니다. 기존 자료는 그대로 두고 설치기를 실행하면 됩니다.'));
});

test('ui/index.html: 계약(API v2)의 길만 부른다', () => {
  const src = html();
  const must = [
    '/api/state', '/api/precheck', '/api/locate', '/api/choice', '/api/structure', '/api/presets',
    '/api/summary/confirm', '/api/setup/start', '/api/setup/progress', '/api/setup/retry', '/api/setup/fresh', '/api/setup/close-holders',
    '/api/online/start', '/api/online/status', '/api/online/login', '/api/online/login/retry',
    '/api/online/relay', '/api/report', '/api/report/send', '/api/open-face', '/api/log/path',
  ];
  for (const p of must) assert.ok(src.includes(p), `계약의 길 ${p} 를 부르지 않는다`);
  // v1에만 있던 길은 업데이트 카드(/api/auto·SSE) 말고는 남아 있지 않아야 한다.
  for (const gone of ['/api/name', '/api/install\'', '/api/login/status', '/api/handoff', '/api/health']) {
    assert.ok(!src.includes(gone), `v1의 길 ${gone} 이 남아 있다`);
  }
});

test('ui/index.html: 설치 9단계와 오류 코드가 한국어 설명과 함께 있다', () => {
  const src = html();
  for (const [id, label] of [
    ['unpack', '풀기'], ['env', '환경변수'], ['skeleton', '영혼 뼈대'], ['structure', '작업 폴더'],
    ['venv', '파이썬 환경'], ['adapters', '에이전트 연결'], ['relay', '중계기 준비'],
    ['ontology', '목록 카드'], ['checks', '검사'],
  ]) {
    assert.ok(src.includes("['" + id + "', '" + label + "']"), `단계 ${id}(${label}) 없음`);
  }
  for (const code of ['E-UNPACK', 'E-ENV', 'E-SKELETON', 'E-STRUCTURE', 'E-VENV', 'E-ADAPTERS', 'E-RELAY', 'E-ONTOLOGY', 'E-CHECKS']) {
    assert.ok(src.includes(code), `오류 코드 ${code} 의 쉬운 설명이 없다`);
  }
  assert.ok(src.includes('다시 시도'), '실패 카드에는 「다시 시도」가 있다');
  assert.ok(src.includes('로그 경로 복사'), '실패 카드에는 「로그 경로 복사」가 있다');
  // 2026-09-17 실제 사용자 요청: 처음부터 다시 + 자세한 원인.
  assert.ok(src.includes('처음부터 다시 설치'), '실패 카드에는 「처음부터 다시 설치」가 있다');
  assert.ok(src.includes('자세한 원인 보기'), '실패 카드는 원문(detail)과 기록 파일 위치를 펼침 상자로 보여 준다');
  assert.ok(/st\.error\.detail/.test(src) && /logs\.soul/.test(src), '원문과 기록 파일 경로를 진행 상태에서 읽는다');
  assert.ok(src.includes('IRIS 프로그램 닫고 다시 시도') && /st\.error\.holders/.test(src), '붙잡은 IRIS 프로그램 목록과 「닫고 다시 시도」가 있다');
  // 2026-09-17 사용자 요청: 긴 단계에서 멈춤/진행이 보여야 한다 — 경과 시간·마지막 기록·회전 표시.
  assert.ok(/function fmtElapsed/.test(src) && /st\.live/.test(src) && /x\.startedAt/.test(src), '진행 중인 단계에 경과 시간과 마지막 기록을 붙인다');
  // 2026-09-17 실제 사용자 실측: 로그인은 끝났는데 계정 연결(중계기)이 실패하면 누를 단추가 없었다.
  assert.ok(src.includes('계정 연결 다시 시도') && /relay\.message/.test(src), '중계기 실패에 원인 문장과 「계정 연결 다시 시도」가 있다');
  assert.ok(/x\.sub && x\.sub\.total/.test(src), '풀기 단계에는 부품별 하위 막대가 있다');
});

test('ui/index.html: 로그인 실패 3종·2분 대기·완료 보고 5순서', () => {
  const src = html();
  for (const reason of ['window-closed', 'page-blocked', 'import-failed']) {
    assert.ok(src.includes("'" + reason + "'"), `로그인 실패 까닭 ${reason} 안내가 없다`);
  }
  assert.ok(src.includes('다른 망'), '차단된 망일 때의 안내');
  assert.ok(/120000/.test(src), '「다시 열기」는 2분 뒤에 눌린다');
  for (const head of ['1. 하려던 일', '2. 기존 자료의 안전', '3. 결과', '4. 남은 일의 뜻', '5. 이제 하실 일']) {
    assert.ok(src.includes(head), `완료 보고 순서 「${head}」 없음`);
  }
  assert.ok(src.includes('별밭 아이콘'), '요약에 아이콘 한 줄이 있다');
});

test('ui/index.html: 복원은 GET /api/state의 step으로 첫 화면을 정한다', () => {
  const src = html();
  assert.ok(/STEPS\.indexOf\(st\.step\)/.test(src), 'state.step으로 첫 화면을 고른다');
  assert.ok(src.includes("st.step === 'reinstall-required'"));
  assert.ok(src.includes("st.step === 'auto'"));
  // v1의 판정 값은 더 쓰지 않는다(계약이 blockers/warnings 로 바뀌었다).
  for (const gone of ['canProceedOffline', 'allOk', 'userEnvSkipped', 'reopenAvailable', 'installError']) {
    assert.ok(!src.includes(gone), `v1 판정 값 ${gone} 이 남아 있다`);
  }
  assert.ok(src.includes('blockers') && src.includes('warnings'), '준비 확인은 blockers·warnings 를 읽는다');
});

test('ui/index.html: 되묻기는 실패가 이어지면 간격을 넓히고, 카드에 「연결 확인 중…」을 띄운다', () => {
  const src = html();

  // 고정 1초 setInterval 은 없어야 한다 — 서버가 죽어도 영원히 1초마다 두드리는 화면이 된다.
  assert.ok(!/setInterval\(/.test(src), '되묻기는 setInterval 이 아니라 물러나는 setTimeout 고리로 돈다');

  assert.ok(/POLL_BASE = 1000/.test(src), '기본 간격 1초');
  assert.ok(/POLL_MAX = 10000/.test(src), '상한 10초');
  assert.ok(/POLL_TOLERATE = 3/.test(src), '연이어 3번 실패해야 간격을 넓힌다');
  assert.ok(/Math\.min\(POLL_MAX, delay \* 2\)/.test(src), '간격은 두 배씩(1→2→4→8→10초)');

  // 성공하면 곧바로 1초로 돌아오고 안내도 지운다.
  assert.ok(/fails = 0;\s*\n\s*delay = POLL_BASE;\s*\n\s*conn\(false\);/.test(src), '한 번 성공하면 간격과 안내를 되돌린다');

  // 카드마다 제 안내 자리를 쓴다(오류 문구와 섞이지 않게).
  assert.ok(src.includes('id="setup-conn"') && src.includes('id="online-conn"'));
  assert.ok(src.includes('연결 확인 중…'));

  // 끝났거나(=stop) 카드를 떠나면 멈춘다.
  assert.ok(src.includes("if (step !== 'setup' && setupPoll) setupPoll.stop();"));
  assert.ok(src.includes("if (step !== 'online' && onlinePoll) onlinePoll.stop();"));
  assert.ok(/res === 'stop'/.test(src));
  // 서버가 대답은 했지만 500이면 그것도 실패로 센다.
  assert.ok(/status >= 500\) return 'error'/.test(src));
});

test('ui/index.html: 이름 칸은 40글자를 넘겨 적을 수 없다', () => {
  const src = html();
  assert.ok((src.match(/maxlength="40"/g) || []).length >= 2, '한글·영어 칸 모두 maxlength=40');
});

test('ui/index.html: 서버가 없어도 프리셋을 읽을 길이 하나 더 있다', () => {
  const src = html();
  assert.ok(src.includes("fetch('/api/presets')"));
  assert.ok(src.includes("fetch('./presets.json')"), '/api/presets 가 없으면 파일을 직접 읽는다');
});

test('ui/: zip에 들어가는 화면 파일 3개는 NUL 바이트나 CRLF 없이 UTF-8이다', () => {
  for (const name of ['index.html', 'structure.mjs', 'presets.json']) {
    const buf = fs.readFileSync(path.join(UI, name));
    assert.ok(!buf.includes(0), `${name} 에 NUL 바이트가 있다(git이 바이너리로 본다)`);
    assert.equal(buf[0] === 0xEF && buf[1] === 0xBB, false, `${name} 에 BOM이 있다`);
  }
});

test('ui/index.html: 자동 업데이트 카드는 세팅 9단계 id를 날것으로 보이지 않는다(STAGE_LABEL)', () => {
  const src = html();
  assert.ok(/const STAGE_LABEL = Object\.fromEntries\(SETUP_STAGES\)/.test(src), 'STAGE_LABEL = SETUP_STAGES 한글 이름표');
  assert.ok(/STAGE_LABEL\[k\] \|\| PART_LABEL\[k\] \|\| k/.test(src), '자동 업데이트 줄은 STAGE_LABEL부터 찾은 뒤 PART_LABEL, 마지막에만 id');
  // SETUP_STAGES(세팅 9단계) 각 id마다 한글 이름표가 실제로 붙어 있어야
  // STAGE_LABEL[k]가 채워지고, 자동 업데이트 카드에 'unpack — 바꾸는 중' 같은
  // 날것 id가 남지 않는다.
  const m = src.match(/const SETUP_STAGES = \[([\s\S]*?)\];/);
  assert.ok(m, 'SETUP_STAGES 정의를 찾지 못했다');
  const pairs = [...m[1].matchAll(/\['([a-z]+)', '([^']+)'\]/g)];
  const ids = pairs.map((p) => p[1]);
  for (const id of ['unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks']) {
    assert.ok(ids.includes(id), `단계 id ${id} 가 SETUP_STAGES에 없다`);
  }
  for (const [, label] of pairs) {
    assert.ok(label.trim().length > 0, '단계마다 빈 문자열이 아닌 한글 이름표가 있어야 한다');
  }
});

test('ui/mock-server.mjs: 127.0.0.1에만 귀를 열고, 화면 파일만 내준다', () => {
  const src = fs.readFileSync(path.join(UI, 'mock-server.mjs'), 'utf8');
  assert.ok(src.includes("server.listen(PORT, '127.0.0.1'"), '바깥에서 닿을 수 있으면 안 된다');
  assert.ok(src.includes('startsWith(HERE)'), 'installer/ui 밖의 파일을 내주면 안 된다');
  assert.ok(!src.includes('TeamClaude'));
});
