#!/usr/bin/env node
// IRIS Doctor — 실행 입구. 명령마다 하는 일이 다르다(전체 목록은 아래 USAGE):
//   start                  터미널 차림표(검진 · 계정 연결 · 연결 확인 · 치료) — 보통은 시작 파일 「IRIS Doctor.cmd」가 부른다
//   diagnose               검진만 한다: 읽기만 하고 아무것도 고치지 않으며, 결과는 화면(표준 출력)에만 낸다
//   checkup · records · open · link summary   IRIS 창이 부르는 짧은 명령(JSON 한 줄)
//   link · login · probe   Doctor 계정 연결(login · probe 는 중계기를 거치지 않는 실제 호출이다)
//
//   node iris-doctor.mjs diagnose            사람이 읽는 검진표
//   node iris-doctor.mjs diagnose --json     기계가 읽는 검진표(JSON 한 덩어리)
//   node iris-doctor.mjs diagnose --offline  바깥 통신 없이(이 PC 안만 본다)
//   node iris-doctor.mjs diagnose --only relay,keys   고른 묶음만
//
// diagnose 의 종료 코드: 0 = 고장 없음(정상 · 주의 · 모름) · 1 = 고장이 하나 이상 · 2 = 진단기 자체가 돌지 못함
import { VERSION } from './lib/diagnose.mjs';
import { renderText } from './lib/report.mjs';
import { fileURLToPath } from 'node:url';
import { runInChild, writeAndExit } from './lib/deadline.mjs';

const DEADLINE_MS = 90_000; // 검진 전체의 상한 — 넘으면 멎은 것으로 보고 끝낸다
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) || 'diagnose';
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };

const USAGE = [
  '사용법:',
  '  node iris-doctor.mjs start                             Doctor 터미널(차림표: 검진 · 계정 연결 · 연결 확인 · 치료). 보통은 「IRIS Doctor.cmd」로 연다',
  '  node iris-doctor.mjs diagnose [--json] [--offline] [--only 묶음,묶음] [--root <IRIS 폴더>]   검진(읽기만)',
  '  node iris-doctor.mjs link [status | claude | codex]   Doctor 계정 연결(상태 보기 · 클로드 카드 만들기 · 코덱스 전용 폴더 마련)',
  '  node iris-doctor.mjs link summary                     연결 상태 요약(JSON 한 줄 · 계정 이름 없음 — IRIS 창의 설정 화면이 읽는다)',
  '  node iris-doctor.mjs link auto | auto-claude | auto-codex   손 없이 되는 준비만(통신 없음 · JSON 한 줄): 클로드 카드가 없고 IRIS 1년 열쇠가 있으면 사본 · 코덱스 전용 폴더 마련. 이미 되어 있으면 아무것도 쓰지 않는다(설치 프로그램이 부른다)',
  '  node iris-doctor.mjs checkup [--offline]              검진하고 검진표를 기록에 남긴 뒤 JSON 한 줄로(IRIS 창의 검진표 창이 부른다)',
  '  node iris-doctor.mjs records                          기록 장부의 마지막 줄들을 JSON 한 줄로(검진 · 열기 · 계정 연결 · 치료 — 이 PC 에만 있다)',
  '  node iris-doctor.mjs open                          Doctor 터미널을 바깥 창으로 띄우고 결과를 JSON 한 줄로(IRIS 창의 「IRIS Doctor 열기」가 부른다)',
  '  node iris-doctor.mjs login codex                     코덱스 전용 로그인(브라우저에서 직접 승인) → 연결 확인 → 연결. 이미 연결이 있으면 확인에 성공한 뒤에만 바꿔 낌',
  '  node iris-doctor.mjs probe [claude | codex]           연결된 계정으로 직통 연결을 한 번 확인(짧은 요청 1회)',
  '',
].join('\n');
if (has('--version')) { process.stdout.write(`iris-doctor ${VERSION}\n`); process.exit(0); }
if (has('--help') || has('-h')) { process.stdout.write(USAGE); process.exit(0); }
if (cmd === 'selftest') {
  // 시작 파일(IRIS Doctor.cmd)이 "이 node 로 Doctor 가 뜨는가"를 정한 시간 안에 확인할 때 부른다: node 판 + 프로그램 파일 전부를 읽어 본다(통신 · 쓰기 0).
  let ok = Number(process.versions.node.split('.')[0]) >= 18;
  if (ok) { try { for (const m of ['session', 'commands', 'launch', 'link', 'home', 'integrity', 'open', 'context']) await import(`./lib/${m}.mjs`); for (const m of ['relay', 'system', 'network']) await import(`./lib/checks/${m}.mjs`); } catch { ok = false; } }
  process.stdout.write(ok ? 'IRIS-DOCTOR-SELFTEST-OK\n' : 'IRIS-DOCTOR-SELFTEST-FAIL\n');
  process.exit(ok ? 0 : 3);
}
// 윈도우가 믿는 인증서도 믿는다(학교 · 회사 망이 인증서를 바꿔 끼워도 검진의 「인터넷」이 '인증서 주의'로만 나오지 않게 — lib/trust.mjs).
// 이 프로세스의 기본 목록에 윈도우 목록을 더하고, 자식(검진 일꾼 · 직통 실행)에게는 NODE_USE_SYSTEM_CA 를 비어 있을 때만 채워 넘긴다.
// 그 파일이 없거나 옛 node 여도 조용히 넘어간다 — 이것 때문에 Doctor 가 안 뜨는 일은 없어야 한다.
try { (await import('./lib/trust.mjs')).trustSystemRoots(); } catch {}
if (cmd === 'start') {
  // 터미널 대화 흐름(차림표). 사용자가 닫으면 0. 흐름을 시작하지 못하면 3(시작 파일이 다른 node 로 다시 해 본다).
  let run;
  try { ({ runSession: run } = await import('./lib/session.mjs')); } catch { process.stdout.write('IRIS Doctor 를 시작하지 못했습니다(프로그램 파일이 깨졌을 수 있습니다).\n'); process.exit(3); }
  let code = 0;
  try { code = await run({}); } catch { process.stdout.write('IRIS Doctor 가 도중에 멈췄습니다.\n'); code = 4; }
  process.exit(code);
}
if (cmd === 'open') {
  // 창 안 입구(걸음 ⑦)가 부른다: Doctor 를 바깥 터미널로 띄우고(탐색기에 시작 파일 하나) 떴는지 확인한 결과를 JSON 한 줄로 낸다.
  let out = { ok: false, why: 'failed', others: 0 };
  try { const { openCommand } = await import('./lib/open.mjs'); out = await openCommand({ doctorDir: fileURLToPath(new URL('.', import.meta.url)) }); } catch {}
  writeAndExit(`${JSON.stringify(out)}\n`, out.ok ? 0 : 1, { graceMs: 3000 });
  await new Promise(() => {});
}
if (cmd === 'checkup') {
  // IRIS 창의 검진표 창이 부른다: 검진(읽기만)하고 → 검진표를 Doctor 집에 남기고 → 화면에 그릴 것만 JSON 한 줄로 낸다.
  // (diagnose 는 아무것도 쓰지 않는 개발자용 그대로 둔다 — 사용자가 누르는 길은 모두 기록을 남긴다.)
  let out = { ok: false, why: 'failed' };
  try {
    const [{ makeContext }, { saveCheckup, note }, { GROUPS }] = await Promise.all([import('./lib/context.mjs'), import('./lib/journal.mjs'), import('./lib/report.mjs')]);
    let root = val('--root'); if (!root) { try { root = makeContext({}).root; } catch {} }
    const from = ['window', 'cli'].includes(val('--from')) ? val('--from') : 'cli';
    const r = await runInChild(fileURLToPath(new URL('./lib/worker.mjs', import.meta.url)), { offline: has('--offline'), root: val('--root'), only: null }, DEADLINE_MS);
    const report = r.ok && r.value && Array.isArray(r.value.findings) ? r.value : null;
    if (!report) { note({ root, kind: 'checkup-failed', from, why: r.why === 'timeout' ? 'timeout' : 'failed' }); out = { ok: false, why: r.why === 'timeout' ? 'timeout' : 'failed' }; }
    else {
      const rec = saveCheckup({ root, report, from });
      // 화면에는 쉬운 말을 함께 준다(lib/plain.mjs): 묶음의 쉬운 이름 + 항목마다 name · say · more. 원래 글(title · summary)도 그대로 싣는다 — 기록 · 치료는 원래 글을 쓴다.
      // 쉬운 말 표를 읽지 못하거나 한 항목에서 탈이 나도 살펴본 결과는 그대로 준다(화면이 원래 글로 물러난다) — 표 때문에 살펴보기가 실패하지 않게.
      let plainTitle = new Map(), plainOf = () => ({});
      try { const m = await import('./lib/plain.mjs'); plainTitle = new Map(m.PLAIN_GROUPS); plainOf = (f) => { try { return m.plainOf(f); } catch { return {}; } }; } catch {}
      out = { ok: true, at: new Date().toISOString(), recorded: rec.ok, id: rec.id, groups: GROUPS.map(([id, title]) => ({ id, title: plainTitle.get(id) || title })), findings: report.findings.map((f) => ({ id: f.id, group: f.group, title: f.title, state: f.state, summary: f.summary, ...plainOf(f) })) };
    }
  } catch {}
  writeAndExit(`${JSON.stringify(out)}\n`, out.ok ? 0 : 1, { graceMs: 5000 });
  await new Promise(() => {});
}
if (cmd === 'records') {
  // 장부의 마지막 줄들(새것이 앞) — IRIS 창의 「기록」이 읽는다. 이 PC 에만 있는 기록이다.
  // ok:false = 장부를 읽지 못함(권한 · 손상) — "아직 기록이 없음"(ok:true · 빈 목록)과 다르다
  let out = { v: 1, ok: false, items: [] };
  try { const [{ makeContext }, { readJournal }] = await Promise.all([import('./lib/context.mjs'), import('./lib/journal.mjs')]); let root = val('--root'); if (!root) root = makeContext({}).root; if (root) out = { v: 1, ...readJournal({ root, limit: 40 }) }; } catch {}
  writeAndExit(`${JSON.stringify(out)}\n`, 0, { graceMs: 5000 });
  await new Promise(() => {});
}
if (cmd === 'link' || cmd === 'probe' || cmd === 'login') {
  // 연결 · 연결 확인은 Doctor 자기 자리에 쓴다(검진과 다름). 오류의 원문은 찍지 않는다.
  const sub = args.filter((a) => !a.startsWith('-'))[1] || '';
  let out;
  try { const { runCommand } = await import('./lib/commands.mjs'); out = await runCommand(cmd, sub); } catch { out = { text: 'IRIS Doctor 가 그 일을 끝내지 못했습니다(프로그램 파일이 깨졌을 수 있습니다).\n', code: 2 }; }
  writeAndExit(out.text || USAGE, out.code, { graceMs: 5000 });
  await new Promise(() => {}); // writeAndExit 가 끝낸다
}
if (cmd !== 'diagnose') { process.stdout.write(USAGE); process.exit(2); }

const only = val('--only') ? val('--only').split(',').map((s) => s.trim()).filter((s) => /^[a-z]{1,20}$/.test(s)) : null;
// 검진은 자식 프로세스에서 돈다 — 이 프로세스에는 멎을 것이 없으므로, 무슨 일이 있어도 글을 내고 스스로 끝난다.
// 글을 받는 쪽이 멈춰 있어도 5초 뒤에는 끝난다(writeAndExit).
const leave = (text, code) => writeAndExit(text, code);
const r = await runInChild(fileURLToPath(new URL('./lib/worker.mjs', import.meta.url)), { offline: has('--offline'), root: val('--root'), only }, DEADLINE_MS);
const report = r.ok && r.value && Array.isArray(r.value.findings) ? r.value : null;
if (report) leave(has('--json') ? JSON.stringify(report, null, 2) + '\n' : renderText(report), report.findings.some((f) => f.state === 'bad') ? 1 : 0);
else {
  // 오류의 원문은 찍지 않는다(바깥 글이 섞일 수 있다) — 정해 둔 글만
  const why = r.why === 'timeout' ? `검진이 ${DEADLINE_MS / 1000}초 안에 끝나지 않았습니다 — 파일을 읽다 멎은 것으로 보입니다(연결이 끊긴 공유 폴더 등).` : '검진 프로그램이 도중에 멈췄습니다 — 진단기 파일이 깨졌을 수 있습니다.';
  leave(`IRIS Doctor 진단기가 검진을 끝내지 못했습니다.\n${why}\n`, 2);
}
