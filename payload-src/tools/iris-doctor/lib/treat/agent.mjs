// IRIS Doctor — 에이전트 치료의 실행 쪽(걸음 ④b): 실행 폴더와 가드 준비 · 원인 찾기 실행(읽기만) · 치료 실행 · 답 읽기 · 기준 사본의 대상.
//   · 에이전트는 중계기를 거치지 않는 직통 길(lib\launch.mjs runAgent)로, IRIS 폴더 **밖**의 작업 폴더에서 돈다(프로젝트 지침 · 프로젝트 설정이 끼지 않게).
//   · 치료에는 클로드의 --safe-mode 를 쓰지 않는다(그것은 훅까지 끈다) — Doctor 전용 설정 폴더에 가드 훅 하나만 넣고 나머지 격리 인자는 그대로 쓴다.
//   · 가드 훅 파일은 Doctor 가 시작할 때 메모리에 읽어 둔 내용으로 실행 때마다 새로 써 넣는다(에이전트가 고쳐도 다음 실행에는 원래 것이 들어간다).
//   · 에이전트의 "됐다"는 말은 근거가 아니다 — 답은 계획 · 한 일의 설명으로만 쓰고, 판정은 다시 검진으로 한다(lib\treat\verdict.mjs).
// 실제 에이전트로 확인해야 하는 것(가짜 프로그램 시험으로는 알 수 없다 — 걸음 ⑥에서 사용자 승인 뒤): 훅이 실제로 불리는가(클로드 matcher '*' · 코덱스 hooks.json 과 훅 신뢰 인자) ·
//   클로드 plan 방식의 한 번 실행이 답을 내고 끝나는가 · 격리 인자를 붙여도 구독 열쇠가 통하는가.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctorPaths, writeAtomic, readJsonFile } from '../home.mjs';
import { runAgent } from '../launch.mjs';
import { readCard } from '../link.mjs';
import { clean } from '../report.mjs';
import { bundledSpawn, canBundle } from './bundle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD_SRC = fs.readFileSync(path.join(HERE, 'guard-hook.mjs')); // 시작할 때의 가드를 메모리에 둔다
export const DIAGNOSE_LIMIT_MS = 10 * 60_000, TREAT_LIMIT_MS = 20 * 60_000;
const NAME = { claude: '클로드', codex: '코덱스' };
const UNSAFE_IN_COMMAND = /["%$`\r\n]/; // 훅 명령은 글 한 줄로 적어야 한다 — 따옴표로 감싸도 뜻이 바뀌는 글자가 경로에 있으면 가드를 걸 수 없다

/** 실행 폴더의 바탕(IRIS 폴더 밖). */
export const runBase = (env = process.env) => path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'IRIS Doctor');

/**
 * 치료 한 번의 실행 폴더를 마련하고 가드를 건다. → { ok:true, runDir, workDir, bundle, spawnFn, kindReady(kind) } | { ok:false, why }
 * deps: { base, nodePath, canBundle, bundledSpawn } 바꿔 낄 수 있다(시험).
 */
export async function prepareRun({ ctx, id, mode = 'diagnose', deps = {} }) {
  const base = deps.base || runBase(ctx.env || process.env);
  const runDir = path.join(base, `run-${String(id).replace(/[^0-9a-z-]/gi, '')}`), workDir = path.join(base, 'work');
  const node = deps.nodePath || process.execPath;
  const hookFile = path.join(runDir, 'guard-hook.mjs');
  if (UNSAFE_IN_COMMAND.test(node) || UNSAFE_IN_COMMAND.test(hookFile)) return { ok: false, why: 'guard-path-unsafe' };
  try {
    fs.mkdirSync(runDir, { recursive: true }); fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(hookFile, GUARD_SRC);
  } catch { return { ok: false, why: 'run-dir' }; }
  let bundle = false; try { bundle = await (deps.canBundle || canBundle)({ runDir, env: ctx.env || process.env }); } catch {}
  const p = doctorPaths(ctx.root);
  const run = {
    ok: true, runDir, workDir, bundle, hookCommand: `"${node}" "${hookFile}"`,
    spawnFn: bundle ? (deps.bundledSpawn || bundledSpawn)({ runDir }) : undefined,
    extraDeny: [], mode,
    /** 사본을 뜨지 못한 파일들: 에이전트가 고치지 못하게 가드의 금지 자리에 더한다(되돌릴 수 없는 변경을 만들지 않게). */
    protect(paths) { run.extraDeny = [...new Set([...run.extraDeny, ...paths])]; run.setMode(run.mode); },
    /** 가드의 방식을 바꾼다(원인 찾기 = 읽기만 / 치료). 규칙 파일은 그때마다 새로 쓴다. */
    setMode(m) {
      run.mode = m;
      const policy = {
        mode: m, noBackground: !bundle, workDir, // workDir = 명령 글의 상대 경로를 풀 때의 기준
        // 치료 때 파일을 쓰는 도구가 쓸 수 있는 자리: IRIS 의 에이전트 · 설정 자리, 중계기 설정 자리, 작업 폴더. 사용자의 작업 자료(R · D · P 폴더 등)는 들어 있지 않다.
        writeRoots: [path.join(ctx.root, '_agent'), ...(ctx.home ? [path.join(ctx.home, '.config')] : []), workDir],
        denyRoots: [p.home, runDir, path.dirname(HERE), path.resolve(HERE, '..', '..'), path.join(ctx.root, '_agent', 'claude', 'secrets'), ...run.extraDeny],
        frozen: [...run.extraDeny], // 사본을 뜨지 못해 막아 둔 파일(거절 까닭을 따로 말하려고)
      };
      fs.writeFileSync(path.join(runDir, 'policy.json'), JSON.stringify(policy));
      fs.writeFileSync(hookFile, GUARD_SRC); // 가드도 다시 써 넣는다
    },
    /** 그 서비스의 전용 설정 폴더에 가드 훅을 건다(훅은 이것 하나뿐). */
    installHook(kind) {
      const entry = (matcher) => ({ matcher, hooks: [{ type: 'command', command: run.hookCommand, timeout: 20 }] });
      if (kind === 'claude') writeAtomic(path.join(p.claudeHome, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [entry('*')] } }, null, 2));
      else writeAtomic(path.join(p.codexHome, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [entry('.*'), entry('Bash|Write|Edit|apply_patch|shell')] } }, null, 2));
    },
    /** 가드가 거절한 횟수(규칙별). 명령 글은 적혀 있지 않다. */
    denied() { const out = {}; try { for (const l of fs.readFileSync(path.join(runDir, 'denied.jsonl'), 'utf8').split('\n').filter(Boolean)) { try { const j = JSON.parse(l); out[j.rule] = (out[j.rule] || 0) + 1; } catch {} } } catch {} return out; },
    /** 가드가 불린 횟수(도구 호출을 본 횟수). 에이전트가 도구를 썼는데 0 이면 가드가 걸리지 않은 것이다. */
    calls() { try { return fs.readFileSync(path.join(runDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } },
    cleanup() { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {} },
  };
  try { run.setMode(mode); } catch { return { ok: false, why: 'run-dir' }; }
  return run;
}

// ── 에이전트에게 주는 글
const RULES_KO = [
  '지킬 것(IRIS Doctor 의 가드가 어기는 명령을 거절한다 — 거절되면 다른 방법을 쓴다):',
  ' - 열쇠가 든 파일(.credentials.json · auth.json · teamclaude.json · secrets 폴더 · .env)과 환경 변수의 열쇠를 읽거나 찍거나 고치지 않는다. 로그인이 필요하면 사람이 할 일로 적는다.',
  ' - 프로세스는 번호와 명령줄을 확인한 그 하나만 번호로 끝낸다. 이름으로 골라 끝내지 않는다.',
  ' - API 키 종량 과금 길을 만들지 않는다. 인증서 검증을 끄지 않는다. 윈도우의 보안 설정 · 계정 · 서비스 · 예약 작업을 바꾸지 않는다.',
  ' - 폴더를 통째로 지우지 않는다(지우는 대신 이름을 바꿔 옆에 비켜 둔다). 사용자의 작업 자료(IRIS 폴더의 R · D · P 로 시작하는 폴더, 문서, 대화 기록)는 건드리지 않는다.',
  ' - IRIS Doctor 자신의 폴더(_agent\\doctor · iris-doctor)는 건드리지 않는다. 계정을 지우거나 로그아웃하지 않는다. 이 PC 의 내용을 바깥으로 올려 보내지 않는다.',
  ' - 윈도우에 저장되는 환경 변수(setx · 레지스트리의 Environment)는 바꾸지 않는다 — 되돌릴 수 없다. 바꿔야 하면 사람이 할 일(human)에 적는다.',
  ' - 중계기 · 창처럼 계속 켜져 있어야 하는 프로그램을 직접 켜지 않는다(네가 띄운 프로그램은 이 치료가 끝날 때 함께 끝난다). 켜야 하면 note 에 "중계기를 켜야 함"이라고 적어라 — Doctor 가 이어서 켠다.',
  ' - context.json 의 iris 자리들(root · toolsDir 등) 안에서만 고친다. 그 밖의 IRIS 나 다른 프로그램의 설정은 건드리지 않는다.',
].join('\n');
const PLAN_SHAPE = '{"cause":{"text":"원인 한두 문장","certainty":"confirmed | likely | unknown"},"steps":["처음 할 일(짧게)"],"alternatives":["안 될 때 해 볼 다른 방법"],"impact":{"endsSessions":true,"text":"끊기는 대화 · 다시 켜야 하는 것"},"human":["사람이 직접 해야 하는 일(브라우저 로그인 등)"],"nothing":false}';
const RESULT_SHAPE = '{"did":["한 일(짧게, 바꾼 파일의 자리 포함)"],"done":true,"more":false,"note":"남은 문제나 사람이 해야 할 일"}';

function diagnosePrompt({ symptom }) {
  return [
    '너는 IRIS Doctor 의 진단 담당이다. 이 PC 의 IRIS(교사가 쓰는 에이전트 작업 환경 — 창 프로그램 · 중계기 · 클로드/코덱스 CLI)에 문제가 있다.',
    '**지금은 원인을 찾는 단계다. 아무것도 바꾸지 않는다(읽기만).** 지금 폴더의 context.json 에 기계 검진표(정상이 아닌 항목)와 IRIS 의 자리들이 있다. 먼저 그것을 읽고, 필요한 만큼 파일과 상태를 직접 살펴 원인을 찾아라.',
    symptom ? `사용자가 적은 증상: ${symptom}` : '',
    RULES_KO,
    '끝낼 때는 다른 말 없이 아래 모양의 JSON 한 덩어리만 ```json 블록으로 내라(값은 한국어 · 쉬운 말로, 각 항목 200자 안). 고칠 것이 없으면 "nothing": true.',
    PLAN_SHAPE,
  ].filter(Boolean).join('\n\n');
}
function treatPrompt({ attempt }) {
  return [
    '너는 IRIS Doctor 의 치료 담당이다. 사용자가 치료를 승인했다. 지금 폴더의 context.json 에 기계 검진표 · 원인과 계획(plan) · 지금까지 해 본 방법과 그 결과(history)가 있다.',
    attempt > 1 ? '**앞의 방법은 통하지 않았다(history 참고). 같은 방법을 되풀이하지 말고 다른 방법으로 고쳐라.** 해 볼 다른 방법이 정말 없으면 아무것도 바꾸지 말고 "more": false 로 끝내라.' : '계획대로 고쳐라. 계획이 맞지 않으면 직접 판단해 더 나은 방법으로 고쳐도 된다.',
    '묻지 말고 끝까지 하라. 한 번에 작은 변경 하나씩 하고 그때마다 되는지 확인하라. 바꾸기 전의 파일은 Doctor 가 이미 떠 두었다. 끝난 뒤 Doctor 가 다시 검진해 결과를 판정한다(네 말이 아니라 검진으로).',
    RULES_KO,
    '끝낼 때는 다른 말 없이 아래 모양의 JSON 한 덩어리만 ```json 블록으로 내라(한국어 · 쉬운 말로).',
    RESULT_SHAPE,
  ].join('\n\n');
}

/** 에이전트의 답에서 JSON 한 덩어리를 찾는다(마지막 ```json 블록 → 마지막 중괄호 덩어리). 못 찾으면 null. */
export function extractJson(text) {
  const s = String(text ?? '');
  const blocks = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of blocks.reverse()) { try { const j = JSON.parse(b.trim()); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch {} }
  for (let end = s.lastIndexOf('}'); end > 0; end = s.lastIndexOf('}', end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) { if (s[i] === '}') depth++; else if (s[i] === '{') { depth--; if (depth === 0) { try { const j = JSON.parse(s.slice(i, end + 1)); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch {} break; } } }
  }
  return null;
}
// 에이전트의 글을 화면 · 기록에 싣기 전에: 열쇠 · 이메일 모양을 가리고 길이를 줄인다
const line = (v, max = 300) => clean(String(v ?? '').replace(/\s+/g, ' ').trim()).slice(0, max);
const list = (v, n = 6) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, n).map((x) => line(x));
export function normalizePlan(j) {
  if (!j || typeof j !== 'object') return null;
  const cert = ['confirmed', 'likely', 'unknown'].includes(j.cause?.certainty) ? j.cause.certainty : 'unknown';
  const plan = { cause: { text: line(j.cause?.text ?? j.cause ?? ''), certainty: cert }, steps: list(j.steps), alternatives: list(j.alternatives), impact: { endsSessions: !!j.impact?.endsSessions, text: line(j.impact?.text ?? '') }, human: list(j.human), nothing: j.nothing === true };
  if (!plan.nothing && !plan.steps.length) return null; // 할 일이 없는 계획은 계획이 아니다
  return plan;
}
export const normalizeResult = (j) => (j && typeof j === 'object' ? { did: list(j.did, 12), done: j.done === true, more: j.more !== false, note: line(j.note ?? '') } : null);

function writeContext(workDir, ctx, extra) {
  const bad = (extra.report?.findings || []).filter((f) => f.state !== 'ok' && f.state !== 'skipped').map((f) => ({ id: f.id, group: f.group, title: f.title, state: f.state, summary: f.summary, detail: f.detail || [] }));
  const data = {
    about: 'IRIS Doctor 가 에이전트에게 주는 자료. 열쇠 값은 들어 있지 않다.',
    iris: { root: ctx.root, layout: ctx.layout, toolsDir: ctx.toolsDir, shimsDir: ctx.shimsDir, claudeConfigDir: ctx.claudeDir, codexHome: ctx.codexDir, windowDir: ctx.faceDir, relayPort: ctx.relayPort, windowPort: ctx.facePort },
    checkup: { finishedAt: extra.report?.finishedAt ?? null, mode: extra.report?.mode ?? null, notOk: bad },
    ...(extra.mechanical ? { alreadyPlanned: extra.mechanical } : {}), ...(extra.plan ? { plan: extra.plan } : {}), ...(extra.history ? { history: extra.history } : {}), ...(extra.symptom ? { symptom: extra.symptom } : {}),
  };
  fs.writeFileSync(path.join(workDir, 'context.json'), JSON.stringify(data, null, 2));
}

async function call({ kind, ctx, run, args, timeoutMs, runFn, model = null }) {
  const card = readCard(ctx.root, kind);
  if (!card) return { ok: false, why: 'no-card' };
  run.installHook(kind);
  const out = path.join(run.runDir, `answer-${Date.now()}.md`);
  // model = 그 서비스의 모델 이름(없으면 프로그램의 기본 모델). 정해진 모양의 이름만 받는다.
  const want = model ?? ctx.doctorModel?.[kind] ?? null; // ctx.doctorModel = { claude, codex } — 시험장에서 작은 모델을 고를 때 쓴다
  const m = typeof want === 'string' && /^[a-z0-9][a-z0-9._-]{0,60}$/i.test(want) ? want : null;
  const full = kind === 'claude' ? [...args.claude, ...(m ? ['--model', m] : [])] : [...args.codex.slice(0, -1), ...(m ? ['-m', m] : []), '-o', out, args.codex.at(-1)];
  let r;
  try { r = await (runFn || runAgent)({ kind, root: ctx.root, toolsDir: ctx.layout === 'installed' ? ctx.toolsDir : null, args: full, card, capture: true, timeoutMs, isolate: 'hooks', cwd: run.workDir, ...(run.spawnFn ? { spawnFn: run.spawnFn } : {}), ...(ctx.env ? { baseEnv: ctx.env } : {}) }); }
  catch { return { ok: false, why: 'failed' }; }
  if (r.blocked) return { ok: false, why: 'blocked', problems: r.blocked };
  if (r.timeout) return { ok: false, why: 'timeout', alive: !!r.alive };
  if (r.error || r.code !== 0) return { ok: false, why: 'failed' };
  let text = String(r.out || '');
  if (kind === 'codex') { try { const t = fs.readFileSync(out, 'utf8'); if (t.trim()) text = t; } catch {} }
  try { fs.rmSync(out, { force: true }); } catch {}
  return { ok: true, text };
}

/** 원인 찾기(읽기만). → { ok:true, plan } | { ok:false, why: 'no-card' | 'blocked' | 'timeout' | 'failed' | 'unparsed', problems? } */
export async function agentDiagnose({ kind, ctx, run, report, mechanical = null, symptom = null, runFn = null }) {
  run.setMode('diagnose');
  const sx = symptom ? line(symptom, 400) : null; // 사용자가 적은 글도 열쇠 · 이메일 모양을 가린 뒤에만 에이전트에게 준다(자료 파일 · 지시문 모두)
  writeContext(run.workDir, ctx, { report, mechanical, symptom: sx });
  const prompt = diagnosePrompt({ symptom: sx });
  const r = await call({ kind, ctx, run, timeoutMs: DIAGNOSE_LIMIT_MS, runFn, args: {
    claude: ['-p', prompt, '--permission-mode', 'plan', '--disallowedTools', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    codex: ['exec', '--skip-git-repo-check', '-s', 'read-only', '--dangerously-bypass-hook-trust', '-C', run.workDir, prompt],
  } });
  if (!r.ok) return r;
  const plan = normalizePlan(extractJson(r.text));
  return plan ? { ok: true, plan } : { ok: false, why: 'unparsed' };
}

/** 치료 실행 한 번(방법 하나). → { ok:true, result } | { ok:false, why, problems?, alive? } */
export async function agentTreat({ kind, ctx, run, report, plan, history = [], attempt = 1, runFn = null }) {
  run.setMode('treat');
  writeContext(run.workDir, ctx, { report, plan, history });
  const prompt = treatPrompt({ attempt });
  const r = await call({ kind, ctx, run, timeoutMs: TREAT_LIMIT_MS, runFn, args: {
    claude: ['-p', prompt, '--permission-mode', 'bypassPermissions'],
    codex: ['exec', '--skip-git-repo-check', '-s', 'danger-full-access', '--dangerously-bypass-hook-trust', '-C', run.workDir, prompt],
  } });
  if (!r.ok) return r;
  // 답의 모양이 틀려도 실행은 된 것이다 — 판정은 어차피 다시 검진으로 한다
  return { ok: true, result: normalizeResult(extractJson(r.text)) || { did: [], done: false, more: true, note: '에이전트의 답을 읽지 못했습니다(한 일은 다시 검진으로 확인합니다).' } };
}

// ── 치료 전 기준 사본의 대상: 에이전트가 고칠 만한 IRIS 의 작은 설정 파일들. 열쇠가 섞인 파일은 열쇠가 아닌 맨 위 칸만.
const SECRET_KEY = /token|secret|oauth|credential|password|apikey|api_key|accounts?$/i;
const SMALL = 5 * 1024 * 1024;
export function baselineTargets(ctx) {
  const targets = []; const unprotected = [];
  // 파일: 있으면 통째로 · **없으면 "원래 없음"으로 적어 둔다**(에이전트가 새로 만들면 되돌릴 때 지운다) · 있는데 못 읽거나 너무 크면 "사본 없음"(가드가 그 파일을 고치지 못하게 막는다)
  const file = (p) => {
    try { const st = fs.statSync(p); if (st.isFile() && st.size <= SMALL) { fs.accessSync(p, fs.constants.R_OK); targets.push({ kind: 'file', path: p }); } else unprotected.push(p); }
    catch (e) { if (e?.code === 'ENOENT') targets.push({ kind: 'file', path: p }); else unprotected.push(p); } // 폴더째 없어도 "원래 없음"으로 적는다(치료가 폴더와 파일을 새로 만들어도 그 파일은 되돌릴 때 지운다)
  };
  const fields = (p) => {
    if (!fs.existsSync(p)) return;
    const j = readJsonFile(p);
    if (!j || typeof j !== 'object' || Array.isArray(j)) { unprotected.push(p); return; } // 못 읽는 파일은 칸으로 뜰 수 없다(통째로 뜨지도 않는다 — 열쇠가 들어 있을 수 있다)
    const keys = Object.keys(j).filter((k) => !SECRET_KEY.test(k));
    if (keys.length) targets.push({ kind: 'fields', path: p, fields: keys });
  };
  if (ctx.root) file(path.join(ctx.root, '_agent', 'setup', 'package-receipt.json'));
  if (ctx.shimsDir) { try { for (const n of fs.readdirSync(ctx.shimsDir)) if (/\.(cmd|mjs|vbs|ps1|json)$/i.test(n)) file(path.join(ctx.shimsDir, n)); } catch {} }
  if (ctx.toolsDir) for (const k of ['claude', 'codex']) file(path.join(ctx.toolsDir, k, `${k}.cmd`));
  if (ctx.claudeDir) { file(path.join(ctx.claudeDir, 'settings.json')); fields(path.join(ctx.claudeDir, '.claude.json')); }
  if (ctx.codexDir) { file(path.join(ctx.codexDir, 'config.toml')); file(path.join(ctx.codexDir, 'hooks.json')); }
  if (ctx.faceDir) file(path.join(ctx.faceDir, 'state', 'settings.json'));
  if (ctx.relayConfig) fields(ctx.relayConfig);
  return { targets, unprotected };
}

export { NAME as AGENT_NAME };
