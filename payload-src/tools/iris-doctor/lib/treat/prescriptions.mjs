// IRIS Doctor — 기계 처방(에이전트 없이 도는, 정해 둔 복구 절차). 첫 묶음.
// 원칙:
//   · 새로 지어내지 않는다 — IRIS 가 이미 쓰는 검증된 절차를 그대로 부르거나 같은 방식으로 한다(출처를 처방마다 적는다).
//   · 검진 항목이 있다는 것만으로 돌리지 않는다 — **처방마다 "지금 이 원인이 맞는가"를 스스로 다시 확인**(applies)하고, 동의 뒤에 하나씩 돌린다.
//   · 처방마다 정해 둔다: 무엇을 바꾸는가(targets) · 시작 조건(applies) · 성공 확인(verify — 실제로 되는지 다시 해 본다) · 되돌리는 법(복원점).
//   · 바꾸기 전에 복원점을 뜨고(lib\treat\restore.mjs), 못 뜨면 그 처방을 하지 않는다.
// 처방이 돌려주는 것: run → { ok, changed, note }   verify → { ok, note }   (note = 화면에 보일 짧은 글. 열쇠 · 원문을 싣지 않는다)
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJsonFile, writeAtomic } from '../home.mjs';
import { plainEnv } from '../launch.mjs';
import { createPoint, sealPoint } from './restore.mjs';

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const finding = (report, id) => (report?.findings || []).find((f) => f.id === id) || null;
const portOpen = (port, ms = 600) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }); const done = (v) => { try { s.destroy(); } catch {} res(v); }; s.setTimeout(ms, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FACE_NEED = ['daemon/server.mjs', 'launch.mjs', 'package.json']; // 진단기의 "창 폴더에 꼭 있어야 할 파일"과 같은 목록
const faceComplete = (dir) => FACE_NEED.every((f) => exists(path.join(dir, f)));
// 클로드 시작 안내창을 "이미 봤음"으로 — 창 daemon\trust.mjs · 설치기 installer\lib\firstrun.mjs 의 CLAUDE_START_NUDGES 와 같은 표
const NUDGES = Object.freeze({ hasCompletedClaudeInChromeOnboarding: true, fullscreenUpsellSeenCount: 3, hasSeenAutoDefaultNudge: true });

function runQuiet(exe, args, { env, timeoutMs, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let done = false, child;
    const fin = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { try { child?.kill(); } catch {} fin({ timeout: true }); }, timeoutMs);
    try { child = spawnFn(exe, args, { env, windowsHide: true, stdio: 'ignore', shell: false }); child.on('error', () => fin({ error: true })); child.on('close', (code) => fin({ code })); } catch { fin({ error: true }); }
  });
}

export const PRESCRIPTIONS = [
  {
    // 출처: 설치 패키지의 relay-ensure.mjs(심 폴더)가 하는 일 — 포트가 답하지 않으면 관리 스크립트(teamclaude-manage.ps1 start)로 중계기를 띄운다. 이미 켜져 있으면 아무것도 하지 않는다(중복 실행 없음).
    id: 'relay-start', title: '꺼진 중계기 켜기', goals: ['relay.listening'], changes: '파일을 바꾸지 않습니다(중계기 프로그램을 켭니다).', impact: '열려 있는 대화를 끊지 않습니다.',
    async applies({ report, ctx, probe = portOpen }) {
      const f = finding(report, 'relay.listening');
      if (!f || f.state !== 'bad') return { ok: false, why: '검진에서 중계기가 꺼져 있다고 나오지 않았습니다' };
      if (ctx.layout !== 'installed' || !ctx.toolsDir || !ctx.shimsDir) return { ok: false, why: '설치본이 아닙니다(이 PC 에서는 중계기를 켜는 정해진 절차가 없습니다)' };
      if (await probe(ctx.relayPort)) return { ok: false, why: `포트 ${ctx.relayPort} 을 무엇인가 쓰고 있습니다(꺼진 것이 아니라 다른 문제 — 켜는 것으로는 낫지 않습니다)` };
      if (finding(report, 'relay.guard')?.state === 'bad') return { ok: false, why: '시작 전 검사가 켜기를 막고 있습니다(그 까닭부터 풀어야 합니다)' };
      for (const [what, p] of [['동봉 node', path.join(ctx.toolsDir, 'node', 'node.exe')], ['중계기 관리 스크립트', path.join(ctx.toolsDir, 'teamclaude', 'teamclaude-manage.ps1')]]) if (!exists(p)) return { ok: false, why: `${what} 파일이 없습니다(설치 프로그램으로 복구해야 합니다)` };
      return { ok: true, cause: '중계기 프로그램이 꺼져 있습니다(포트가 비어 있음).' };
    },
    async run({ ctx, deps = {} }) {
      // IRIS 의 관리 스크립트를 relay-ensure.mjs 가 부르는 것과 **같은 인자로** 직접 부른다(start · -NodePath · -EntryPath · TEAMCLAUDE_CONFIG).
      // relay-ensure.mjs 를 거치지 않는 까닭: 그것은 PowerShell 을 "떨어져 뜨게"(detached) 띄우는데, 그렇게 띄운 PowerShell 이 아무것도 실행하지 않고
      // 곧바로 끝나는 PC 가 있다(2026-11-26 이 노트북 실측 — 윈도우 11 · node 24.17 / 24.21 모두). 여기서는 떨어뜨리지 않고 끝날 때까지 기다린다.
      // 관리 스크립트는 중계기를 창 없는 따로 선 프로그램으로 띄우므로 Doctor 창을 닫아도 중계기는 남는다. 이미 켜져 있으면 스크립트가 아무것도 하지 않는다.
      const node = path.join(ctx.toolsDir, 'node', 'node.exe');
      const manage = path.join(ctx.toolsDir, 'teamclaude', 'teamclaude-manage.ps1');
      const entry = path.join(ctx.toolsDir, 'teamclaude', 'node_modules', '@karpeleslab', 'teamclaude', 'src', 'index.js');
      const env = plainEnv(ctx.env || process.env, { IRIS_RELAY_PORT: String(ctx.relayPort), TEAMCLAUDE_CONFIG: ctx.relayConfig || path.join(ctx.root, '_agent', 'shared', 'portable-state', 'teamclaude', 'teamclaude.json') });
      const ps = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // 관리 스크립트는 켠 뒤 최대 2분쯤 답을 기다린다(설치기가 이 스크립트에 주는 시간 = 180초)
      const r = await runQuiet(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', manage, 'start', '-NodePath', node, '-EntryPath', entry], { env, timeoutMs: deps.manageMs ?? 180_000, spawnFn: deps.spawnFn });
      if (r.error) return { ok: false, changed: false, note: '중계기 관리 스크립트를 띄우지 못했습니다.' };
      if (r.timeout) return { ok: false, changed: true, note: '중계기 관리 스크립트가 정한 시간 안에 끝나지 않았습니다.' };
      return r.code === 0 ? { ok: true, changed: true, note: '중계기 관리 스크립트로 중계기를 켰습니다.' } : { ok: false, changed: true, note: '중계기 관리 스크립트가 오류로 끝났습니다(켜기를 거절했을 수 있습니다 — 포트 주인이나 설정을 확인해야 합니다).' };
    },
    async verify({ ctx, deps = {} }) {
      // 관리 스크립트는 켠 뒤 최대 2분까지 답을 기다린다 — 같은 만큼 기다리며 "중계기의 답 모양"인지 본다(포트만 열린 것으로 치지 않는다)
      const until = Date.now() + (deps.waitMs ?? 120_000);
      const local = deps.localJson || ctx.localJson;
      while (Date.now() < until) {
        try { const r = await local(`http://127.0.0.1:${ctx.relayPort}/teamclaude/status`); if (r?.ok && r.body && Array.isArray(r.body.accounts)) return { ok: true, note: `중계기가 답합니다(포트 ${ctx.relayPort}).` }; } catch {}
        await sleep(deps.pollMs ?? 1000);
      }
      return { ok: false, note: '켰지만 정한 시간 안에 중계기가 답하지 않습니다.' };
    },
  },
  {
    // 출처: 창 daemon\trust.mjs trustClaude · 설치기 firstrun.mjs — 없는 키만 채우고, "본 횟수"는 올리기만 한다. 파일을 못 읽거나 모양이 다르면 손대지 않는다.
    id: 'start-nudges', title: '클로드 시작 안내창을 "이미 봤음"으로', goals: ['resume.claude-nudges'], changes: '클로드 설정 파일(.claude.json)의 안내창 칸 3개만 채웁니다(다른 칸 · 로그인은 그대로).', impact: '열려 있는 대화에는 영향이 없고, 새로 여는 대화부터 안내창이 뜨지 않습니다.',
    async applies({ report, ctx }) {
      const f = finding(report, 'resume.claude-nudges');
      if (!f || f.state !== 'warn') return { ok: false, why: '검진에서 시작 안내창 문제가 나오지 않았습니다' };
      if (!ctx.claudeDir) return { ok: false, why: '클로드 설정 폴더를 찾지 못했습니다' };
      const file = path.join(ctx.claudeDir, '.claude.json');
      if (!exists(file)) return { ok: false, why: '클로드를 아직 한 번도 켜지 않은 PC 입니다(첫 로그인 뒤에 채워집니다)' };
      const j = readJsonFile(file);
      if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, why: '클로드 설정 파일을 읽지 못했습니다(깨졌을 수 있어 손대지 않습니다)' };
      const miss = Object.entries(NUDGES).filter(([k, v]) => j[k] === undefined || (k === 'fullscreenUpsellSeenCount' && typeof j[k] === 'number' && j[k] < v));
      if (!miss.length) return { ok: false, why: '안내창 칸이 이미 채워져 있습니다' };
      return { ok: true, cause: `시작 안내창 ${miss.length}종이 "봤음"으로 적혀 있지 않아, 클로드를 켤 때 안내창이 떠서 멈춘 것처럼 보입니다.` };
    },
    async run({ ctx, kase }) {
      const file = path.join(ctx.claudeDir, '.claude.json');
      const point = createPoint({ caseDir: kase.dir, name: 'start-nudges', targets: [{ kind: 'fields', path: file, fields: Object.keys(NUDGES) }] });
      const j = readJsonFile(file);
      if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, changed: false, note: '클로드 설정 파일을 읽지 못해 바꾸지 않았습니다.' };
      let changed = false;
      for (const [k, v] of Object.entries(NUDGES)) { if (j[k] === undefined) { j[k] = v; changed = true; } }
      if (typeof j.fullscreenUpsellSeenCount === 'number' && j.fullscreenUpsellSeenCount < NUDGES.fullscreenUpsellSeenCount) { j.fullscreenUpsellSeenCount = NUDGES.fullscreenUpsellSeenCount; changed = true; }
      if (changed) writeAtomic(file, JSON.stringify(j, null, 2) + '\n');
      sealPoint(point);
      return { ok: true, changed, note: changed ? '안내창 칸을 채웠습니다.' : '이미 채워져 있었습니다.' };
    },
    async verify({ ctx }) {
      const j = readJsonFile(path.join(ctx.claudeDir, '.claude.json'));
      const ok = !!j && Object.entries(NUDGES).every(([k, v]) => (k === 'fullscreenUpsellSeenCount' ? typeof j[k] === 'number' && j[k] >= v : j[k] !== undefined));
      return { ok, note: ok ? '안내창 칸 3개가 모두 채워져 있습니다.' : '안내창 칸이 아직 비어 있습니다.' };
    },
  },
  {
    // 출처: 설치 패키지 업데이트 적용기(updater\apply.mjs)의 되돌리기 — 새 창 폴더를 치우고 비켜 둔 옛 폴더(face.prev)를 제자리로. 적용기가 도중에 끊긴 PC 를 위한 같은 동작.
    id: 'update-recover', title: '끊긴 업데이트 되돌리기(옛 창 폴더를 제자리로)', goals: ['window.folder'], changes: '창 프로그램 폴더의 이름을 바꿉니다: 지금의(반쯤 된) 폴더는 옆으로 비켜 두고(지우지 않음), 업데이트 전의 폴더를 제자리에 둡니다.', impact: 'IRIS 창이 꺼져 있을 때만 합니다. 대화 기록 · 설정은 건드리지 않습니다.',
    async applies({ ctx, probe = portOpen }) {
      if (ctx.layout !== 'installed' || !ctx.toolsDir) return { ok: false, why: '설치본이 아닙니다' };
      const face = path.join(ctx.toolsDir, 'face'), prev = path.join(ctx.toolsDir, 'face.prev');
      // 이 PC 의 창이 실제로 그 자리(tools\face)에 있을 때만 — 다른 자리에 깔린 창인데 옆에 남은 face.prev 를 끌어오지 않는다
      if (!ctx.faceDir || path.resolve(ctx.faceDir).toLowerCase() !== path.resolve(face).toLowerCase()) return { ok: false, why: '이 PC 의 창 프로그램은 다른 자리에 있습니다' };
      if (faceComplete(face)) return { ok: false, why: '창 프로그램 폴더는 멀쩡합니다' };
      if (!exists(prev) || !faceComplete(prev)) return { ok: false, why: '되돌릴 업데이트 전 폴더가 없습니다(설치 프로그램으로 복구해야 합니다)' };
      if (await probe(ctx.facePort)) return { ok: false, why: 'IRIS 창이 켜져 있습니다(창을 닫은 뒤에 할 수 있습니다)' };
      if (exists(path.join(ctx.root, '_agent', 'setup', 'agent-update.lock')) && !ctx.treatHoldsUpdateLock) return { ok: false, why: '업데이트가 진행 중입니다' };
      return { ok: true, cause: '창 프로그램 폴더가 반쯤만 바뀐 채 남아 있고, 업데이트 전의 폴더가 옆에 그대로 있습니다(업데이트가 도중에 끊긴 흔적).' };
    },
    async run({ ctx, kase, now = Date.now(), deps = {} }) {
      const face = path.join(ctx.toolsDir, 'face'), prev = path.join(ctx.toolsDir, 'face.prev'), aside = path.join(ctx.toolsDir, `face.broken-${now}`);
      // 이름 바꾸기 하나마다 복원점 하나(거꾸로 되돌릴 수 있게)
      const rename = deps?.rename || fs.renameSync;
      let moved = false;
      if (exists(face)) { const p1 = createPoint({ caseDir: kase.dir, name: 'face-aside', targets: [{ kind: 'move', from: face, to: aside }] }); rename(face, aside); sealPoint(p1); moved = true; }
      try {
        const p2 = createPoint({ caseDir: kase.dir, name: 'face-prev-back', targets: [{ kind: 'move', from: prev, to: face }] });
        rename(prev, face); sealPoint(p2);
      } catch {
        // 두 번째 이름 바꾸기가 막힘(다른 프로그램이 폴더를 쥠 등): 창 폴더가 없는 채로 남기지 않는다 — 비켜 둔 것을 곧바로 제자리로
        let undone = !moved;
        if (moved && !exists(face)) { try { rename(aside, face); undone = true; } catch {} }
        return undone ? { ok: false, changed: false, note: '업데이트 전의 폴더를 제자리에 두지 못해, 비켜 둔 폴더를 원래대로 돌려놓았습니다(바뀐 것 없음).' }
          : { ok: false, changed: true, partial: true, note: '업데이트 전의 폴더를 제자리에 두지 못했고, 비켜 둔 폴더도 돌려놓지 못했습니다.' };
      }
      return { ok: true, changed: true, note: '업데이트 전의 창 폴더를 제자리에 두었습니다(반쯤 된 폴더는 옆에 비켜 둠).' };
    },
    async verify({ ctx }) { const ok = faceComplete(path.join(ctx.toolsDir, 'face')); return { ok, note: ok ? '창 프로그램 폴더에 꼭 있어야 할 파일이 모두 있습니다.' : '창 프로그램 폴더가 아직 온전하지 않습니다.' }; },
  },
];

// 사람 손이 필요한 일(기계가 대신하지 않는다 — 동의가 아니라 "차례 안내"). 검진 항목의 처방 이름 → 안내.
export const HUMAN_STEPS = {
  'cli-repair': { title: '에이전트 프로그램 파일 복구', guide: 'IRIS 설치 프로그램을 다시 실행해 주세요(프로그램 파일을 다시 깝니다). 설치 프로그램은 iris-workspace.com 의 「설치」에서 받습니다.' },
  'system-ca': { title: '학교 · 회사 망의 인증서', guide: '이 망은 보안 장비가 인증서를 바꿔 끼웁니다. IRIS 는 윈도우에 등록된 인증서를 쓰도록 되어 있어 보통은 그대로 됩니다 — 그래도 안 되면 망 관리자에게 "윈도우 인증서 저장소에 기관 인증서가 들어 있는지"를 확인해 달라고 해 주세요.' },
};

/** 지금 검진표에서 돌릴 수 있는 기계 처방과 사람 손이 필요한 일을 고른다. → { ready: [{ rx, cause }], skipped: [{ rx, why }], human: [{ id, title, guide, findings }] } */
export async function planPrescriptions({ report, ctx, list = PRESCRIPTIONS, deps = {} }) {
  const ready = [], skipped = [];
  for (const rx of list) {
    let a; try { a = await rx.applies({ report, ctx, ...deps }); } catch { a = { ok: false, why: '시작 조건을 확인하지 못했습니다' }; }
    if (a.ok) ready.push({ rx, cause: a.cause }); else skipped.push({ rx, why: a.why });
  }
  const human = [];
  for (const [id, h] of Object.entries(HUMAN_STEPS)) { const hits = (report?.findings || []).filter((f) => f.fix === id && (f.state === 'bad' || f.state === 'warn')); if (hits.length) human.push({ id, ...h, findings: hits.map((f) => f.title), ids: hits.map((f) => f.id) }); }
  return { ready, skipped, human };
}
