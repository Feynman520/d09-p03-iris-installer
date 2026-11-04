// 2.0.54 — 옮겨 담는 동안의 화면 글(교장선생님 PC 신고 "멈춘 건지 진행 중인지 모름").
// index.html 의 두 함수만 떼어 node:vm 에서 돌린다(브라우저·서버 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'installer', 'ui', 'index.html'), 'utf8');
const grab = (re) => { const m = HTML.match(re); assert.ok(m, `index.html 에 ${re} 없음`); return m[0]; };
const code = [
  grab(/const RELAY_SLOW_MS = \d+;/),
  grab(/function relayWaitText\(sec\) \{[\s\S]*?\n\}/),
  grab(/function relaySeconds\(s, nowMs\) \{[\s\S]*?\n\}/),
  'this.relayWaitText = relayWaitText; this.relaySeconds = relaySeconds;',
].join('\n');
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);

test('초가 오른다 — 시작 시각에서 지금까지(내림)', () => {
  assert.equal(ctx.relaySeconds({ relayStartedAt: 1000 }, 13999), 12);
  assert.equal(ctx.relaySeconds({}, 5000), null);
  assert.equal(ctx.relaySeconds({ relayStartedAt: 9000 }, 5000), 0, '시계가 어긋나도 음수가 아니다');
});

test('30초 전: "n초째 · 보통 몇 초 · 새로고침해도 이어집니다", 30초부터: "평소보다 오래 · 멈춘 것이 아님 · 60초"', () => {
  const a = ctx.relayWaitText(12);
  assert.match(a, /12초째/); assert.match(a, /보통 몇 초/); assert.match(a, /새로고침해도 이어집니다/);
  const b = ctx.relayWaitText(31);
  assert.match(b, /평소보다 오래 걸립니다\(31초째\)/); assert.match(b, /멈춘 것이 아니라/); assert.match(b, /60초/); assert.match(b, /새로고침해도 이어집니다/);
  assert.match(ctx.relayWaitText(null), /보통 몇 초/);
});

test('끝난 실패에는 「자동으로 다시 시도합니다」를 남기지 않고, 원인 줄은 글로만(esc) 넣는다', () => {
  assert.match(HTML, /s\.state === 'failed' && s\.reason === 'import-failed' \? 'import-failed-final'/);
  assert.match(HTML, /'import-failed-final': '[^']*다시 로그인/);
  assert.doesNotMatch(HTML.match(/'import-failed-final': '[^']*'/)[0], /자동으로 다시 시도/);
  assert.match(HTML, /'<br>원인: ' \+ esc\(s\.detail\)/);
  for (const k of ['import-timeout', 'import-profile']) assert.match(HTML, new RegExp(`'${k}': '[^']*여기까지 한 설치는 그대로`));
});
