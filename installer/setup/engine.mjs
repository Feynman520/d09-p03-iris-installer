// ⑤ 자동 설치+세팅 엔진 (설계-v2 6절, 계약 = docs\세팅엔진-계약-v2.md "엔진")
//
// 하는 일은 하나다: 아홉 단계를 **순서대로** 부르고, 매 단계 전후로 영수증을
// 원자적으로 고쳐 쓰고, 화면이 볼 수 있게 진행을 방송한다. 판단은 하지 않는다 —
// 무엇을 만들지는 단계 모듈이, 무엇이 잘못됐는지는 ⑨ 검사가 안다.
//
// 이 파일이 지키는 약속 넷:
//   ① 순서 고정 — STAGES 배열이 유일한 순서표(계약 표와 같은 순서).
//   ② 재개 = 건너뛰기 — 영수증이 `done` 이라 말하는 단계는 다시 하지 않는다.
//      그래서 「다시 시도」는 곧 "실패한 단계부터"가 된다(서버는 재시작만 한다).
//   ③ 어떤 예외도 그냥 새어 나가지 않는다 — 단계 모듈이 무엇을 던지든
//      `E-<단계>` 코드와 사람이 읽을 한국어 한 문장으로 바뀐다.
//   ④ 실패해도 지우지 않는다 — 여기에 되돌리기(rollback)는 없다. 만든 것은
//      그대로 두고 멈춘다(설계-v2 6-4).
//
// 모듈은 **동적으로** 불러온다. 단계 모듈 파일이 아직(또는 영영) 없어도 엔진이
// 통째로 죽지 않고 그 단계만 `E-<단계>` + "부품 모듈이 없습니다" 로 실패한다.
import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StageError, isStageError } from '../lib/errors.mjs';
import {
  readReceipt as defaultReadReceipt,
  writeReceipt as defaultWriteReceipt,
  ensureV2Fields,
} from '../lib/receipt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 계약 표의 순서 그대로. 서버(`lib/state.mjs` SETUP_STAGES)와 같은 아홉 개.
export const STAGES = Object.freeze([
  'unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks',
]);

// 화면·로그에 쓰는 사람 말. 오류 문장을 만들 때도 쓴다.
export const STAGE_LABELS = Object.freeze({
  unpack: '부품 풀기',
  env: '심·환경변수',
  skeleton: '영혼 뼈대',
  structure: '작업 폴더',
  venv: '파이썬 환경',
  adapters: '에이전트 연결부',
  relay: '중계기 준비',
  ontology: '온톨로지',
  checks: '마무리 검사',
});

// 두 단계(`unpack`·`env`)가 한 모듈을 쓴다 — 계약 표 2행이 `setup/unpack.mjs`
// (export `runEnv`)를 가리킨다. 그래서 "모듈 파일"과 "부를 함수 이름"을 따로 적는다.
export const STAGE_MODULES = Object.freeze({
  unpack: { file: 'unpack.mjs', fn: 'run' },
  env: { file: 'unpack.mjs', fn: 'runEnv' },
  skeleton: { file: 'skeleton.mjs', fn: 'run' },
  structure: { file: 'structure.mjs', fn: 'run' },
  venv: { file: 'venv.mjs', fn: 'run' },
  adapters: { file: 'adapters.mjs', fn: 'run' },
  relay: { file: 'relay.mjs', fn: 'run' },
  ontology: { file: 'ontology.mjs', fn: 'run' },
  checks: { file: 'checks.mjs', fn: 'run' },
});

export function stageCode(id) {
  return `E-${String(id).toUpperCase()}`;
}

export function stageLabel(id) {
  return STAGE_LABELS[id] ?? String(id);
}

const MISSING_MODULE_MESSAGE = '부품 모듈이 없습니다';

// ---------------------------------------------------------------------------
// 단계 모듈 찾기
// ---------------------------------------------------------------------------

// `modules` 는 시험이 진짜 파일 대신 끼워 넣는 가짜 지도다:
//   { skeleton: { run: async (ctx) => ({recorded:{}, pending:[]}) },  // 객체
//     venv: async (ctx) => ({...}) }                                  // 함수만
// 지도에 없는 단계는 평소대로 파일에서 불러온다(섞어 쓸 수 있다).
function fromOverride(id, modules) {
  if (!modules) return null;
  const entry = modules[id];
  if (!entry) return null;
  if (typeof entry === 'function') return entry;
  const fn = STAGE_MODULES[id]?.fn ?? 'run';
  if (typeof entry[fn] === 'function') return entry[fn].bind(entry);
  if (typeof entry.run === 'function') return entry.run.bind(entry);
  return null;
}

/**
 * stageModule(id, { modules, importer }) → 그 단계를 실행할 함수.
 *
 * 파일이 없거나 원하는 export 가 없으면 `E-<단계>` StageError 를 던진다 —
 * "모듈이 없다"는 것은 이 단계의 실패이지 엔진의 고장이 아니기 때문이다.
 */
export async function stageModule(id, { modules = null, importer = null } = {}) {
  const override = fromOverride(id, modules);
  if (override) return override;

  const spec = STAGE_MODULES[id];
  if (!spec) throw new StageError(stageCode(id), `${stageLabel(id)} 단계를 알지 못합니다.`, { id });

  const load = importer ?? ((file) => import(pathToFileUrl(path.join(HERE, file))));
  let mod;
  try {
    mod = await load(spec.file, id);
  } catch (err) {
    throw new StageError(
      stageCode(id),
      `${stageLabel(id)} ${MISSING_MODULE_MESSAGE}.`,
      { module: spec.file, cause: String(err?.message ?? err) },
    );
  }
  const fn = mod?.[spec.fn];
  if (typeof fn !== 'function') {
    throw new StageError(
      stageCode(id),
      `${stageLabel(id)} ${MISSING_MODULE_MESSAGE}.`,
      { module: spec.file, missingExport: spec.fn },
    );
  }
  return fn;
}

// 윈도 경로를 동적 import 가 받는 file:// URL 로. `C:\...` 를 그대로 import 하면
// 드라이브 문자를 스킴으로 읽어 깨진다.
function pathToFileUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, '/');
  return `file:///${abs.replace(/^\/+/, '')}`;
}

// ---------------------------------------------------------------------------
// ctx 만들기
// ---------------------------------------------------------------------------

export function setupDir(root) {
  return path.join(root, '_agent', 'setup');
}

export function setupLogPath(root) {
  return path.join(setupDir(root), 'setup.log');
}

function shimsDir(root) {
  return path.join(root, '_agent', 'shared', 'shims');
}

// 자식 프로세스가 볼 PATH. 동봉 부품이 시스템 것보다 **앞**이어야 한다 —
// 새 PC 에는 시스템 node·python·git 이 아예 없고, 있는 PC 에서는 우리 판이
// 이겨야 설치 결과가 PC 마다 달라지지 않는다.
export function toolPathParts(root, { toolsDir } = {}) {
  const tools = toolsDir ?? path.join(root, '_agent', 'shared', 'tools');
  return [
    shimsDir(root),
    path.join(tools, 'node'),
    path.join(tools, 'git', 'cmd'),
    path.join(tools, 'python'),
  ];
}

export function buildEnv(root, { base = process.env, toolsDir } = {}) {
  const parts = toolPathParts(root, { toolsDir });
  const existing = base?.PATH ?? base?.Path ?? '';
  const seen = new Set();
  const merged = [];
  for (const p of [...parts, ...String(existing).split(';')]) {
    const clean = String(p ?? '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(clean);
  }
  const env = { ...base };
  delete env.Path; // 윈도는 대소문자를 안 가리지만 Node 객체는 가린다 — 한 칸만 남긴다
  env.PATH = merged.join(';');
  return env;
}

// 서버가 이미 대부분을 채워 보낸다(`server.mjs buildSetupContext`). 여기서는
// **빠진 것만** 채우고, 준 것은 그대로 존중한다. 그래야 시험이 ctx 를 통째로
// 가짜로 만들어도, 서버가 진짜를 보내도 같은 엔진이 돈다.
export function normalizeContext(ctx = {}, { fs = ctx.fs ?? nodeFs } = {}) {
  const root = ctx.root;
  if (!root) {
    throw new StageError('E-SETUP', '설치 폴더 경로가 없어 세팅을 시작할 수 없습니다.', { ctx: 'root' });
  }
  const toolsDir = ctx.toolsDir ?? path.join(root, '_agent', 'shared', 'tools');
  const out = {
    ...ctx,
    root,
    payloadDir: ctx.payloadDir ?? null,
    manifest: ctx.manifest ?? null,
    lock: ctx.lock ?? null,
    receipt: ensureV2Fields(ctx.receipt ?? { schema: 2, setup: {}, online: {} }),
    decisions: ctx.decisions ?? null,
    choice: ctx.choice ?? null,
    precheck: ctx.precheck ?? null,
    fs,
    offline: ctx.offline === undefined ? true : ctx.offline,
    toolsDir,
    env: ctx.env ?? buildEnv(root, { toolsDir }),
    progress: typeof ctx.progress === 'function' ? ctx.progress : () => {},
  };
  if (typeof out.run !== 'function') out.run = lazyRun;
  out.log = makeLogger(root, ctx.log, fs);
  return out;
}

// `lib/run.mjs` 를 쓰는 순간에만 불러온다 — 시험이 ctx.run 을 주면 자식
// 프로세스 모듈을 건드릴 일 자체가 없다.
async function lazyRun(exe, args, opts) {
  const mod = await import(pathToFileUrl(path.join(HERE, '..', '..', 'lib', 'run.mjs')));
  return mod.run(exe, args, opts);
}

// 로그는 두 곳으로 간다: 서버가 준 log(설치기 로그·화면) + 영혼 안 setup.log.
// 영혼 쪽 쓰기가 실패해도(폴더가 아직 없다, 잠겨 있다) 세팅을 멈추지 않는다 —
// 로그를 못 남기는 것이 설치를 못 하는 이유가 되어서는 안 된다.
function makeLogger(root, outer, fs) {
  const file = setupLogPath(root);
  let broken = false;
  return (line) => {
    const text = String(line ?? '');
    try { if (typeof outer === 'function') outer(text); } catch { /* 화면 로그는 선택 */ }
    if (broken) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${new Date().toISOString()} ${text}\r\n`, 'utf8');
    } catch {
      broken = true;
    }
  };
}

// ---------------------------------------------------------------------------
// ② 심·환경변수 단계가 알려 준 PATH 를 뒤 단계가 물려받게
// ---------------------------------------------------------------------------

// `unpack.runEnv` 가 무엇을 `recorded` 에 담는지는 그 모듈의 몫이다. 엔진은
// 세 가지 모양만 알아본다(하나라도 맞으면 쓴다):
//   recorded.env       = { PATH: '...', CLAUDE_CONFIG_DIR: '...' }  통째로
//   recorded.childEnv  = 같은 뜻의 다른 이름
//   recorded.vars      = 같은 뜻의 다른 이름(사용자 환경변수 기록용)
// 어느 것도 없으면 엔진이 처음에 만든 PATH 를 그대로 쓴다(이미 동봉 경로가 앞).
export function envFromRecorded(recorded) {
  if (!recorded || typeof recorded !== 'object') return null;
  for (const key of ['env', 'childEnv', 'vars']) {
    const v = recorded[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v).filter(([, val]) => typeof val === 'string');
      if (entries.length) return Object.fromEntries(entries);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 엔진
// ---------------------------------------------------------------------------

function percentOf(done) {
  return Math.floor((done / STAGES.length) * 100);
}

function normalizePending(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      capability: String(p.capability ?? p.what ?? '알 수 없는 기능'),
      reason: String(p.reason ?? ''),
      ...(p.howToEnable ? { howToEnable: String(p.howToEnable) } : {}),
    }));
}

function mergePending(into, list) {
  const seen = new Set(into.map((p) => `${p.capability}::${p.reason}`));
  for (const p of normalizePending(list)) {
    const key = `${p.capability}::${p.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(p);
  }
  return into;
}

/**
 * runSetup(ctx, { failAt, onStage, modules }) — 계약 v2 "엔진".
 *
 * @returns {Promise<{ok:boolean, failed:?{id,code,message}, pending:Array, stages:Object}>}
 */
export async function runSetup(ctx, options = {}) {
  const {
    failAt = process.env.IRIS_INSTALLER_FAIL_AT,
    onStage,
    modules = null,
    importer = null,
    readReceipt = defaultReadReceipt,
    writeReceipt = defaultWriteReceipt,
  } = options;

  let engineCtx;
  try {
    engineCtx = normalizeContext(ctx);
  } catch (err) {
    const e = isStageError(err) ? err : new StageError('E-SETUP', '세팅을 시작할 수 없습니다.', String(err?.message ?? err));
    return { ok: false, failed: { id: null, code: e.code, message: e.message }, pending: [], stages: {} };
  }

  const { root } = engineCtx;
  const log = engineCtx.log;

  // 영수증은 "지금까지 무엇이 끝났나"의 유일한 진실 소스다. 서버가 준 사본이
  // 낡았을 수 있으니(다른 창에서 이미 한 번 돌았다) 디스크 것을 한 번 더 읽는다.
  let receipt = ensureV2Fields(readReceipt(root) ?? engineCtx.receipt ?? { schema: 2, setup: {}, online: {} });
  engineCtx.receipt = receipt;

  const emit = (event) => {
    if (typeof onStage !== 'function') return;
    try { onStage(event); } catch (e) { log(`[engine] 진행 방송 실패: ${String(e?.message ?? e)}`); }
  };

  const saveStage = (id, info) => {
    receipt.setup = receipt.setup ?? {};
    receipt.setup[id] = { ...(receipt.setup[id] ?? {}), ...info };
    try {
      writeReceipt(root, receipt);
    } catch (e) {
      // 영수증을 못 쓰면 재개가 불가능해진다 — 이것만은 조용히 넘기지 않는다.
      log(`[engine] 영수증을 쓰지 못했습니다: ${String(e?.message ?? e)}`);
      throw new StageError('E-RECEIPT-WRITE', '설치 기록을 저장하지 못해 멈췄습니다.', String(e?.message ?? e));
    }
  };

  const pending = [];
  const stages = {};
  let done = 0;
  let failed = null;

  log(`[engine] 세팅 시작 — 단계 ${STAGES.length}개, 설치 폴더 ${root}`);

  for (const id of STAGES) {
    const code = stageCode(id);
    const label = stageLabel(id);
    const prior = receipt.setup?.[id];

    // ── 재실행: 이미 끝난 단계는 건너뛴다 ────────────────────────────────
    if (prior?.status === 'done') {
      done += 1;
      stages[id] = { status: 'skipped-done', recorded: prior.recorded ?? null };
      mergePending(pending, prior.pending);
      // 건너뛴 것이 ② 심·환경변수라면 **그 단계가 지난번에 알려 준 자식 환경을
      // 여기서 되살린다.** 아래 정상 경로와 같은 일을 하는 것인데, 이것이 없으면
      // 재개·「다시 시도」 실행에서 뒤 단계(venv·adapters·ontology)가 동봉 파이썬
      // 대신 PATH 의 아무 파이썬을 보고, CLAUDE_CONFIG_DIR 도 없이 돈다.
      if (id === 'env') {
        const fromPrior = envFromRecorded(prior.recorded);
        if (fromPrior) {
          engineCtx.env = { ...engineCtx.env, ...fromPrior };
          log('[engine] 이미 끝난 심·환경변수 단계의 기록에서 자식 환경을 되살림');
        }
      }
      log(`[engine] ${id}(${label}) — 이미 끝나 있어 건너뜀`);
      emit({ id, status: 'skipped-done', percent: percentOf(done), sub: null });
      continue;
    }

    emit({ id, status: 'running', percent: percentOf(done), sub: null });
    const startedAt = new Date().toISOString();
    try {
      saveStage(id, { status: 'running', startedAt, finishedAt: null, code: null, message: null });
    } catch (err) {
      failed = { id, code: err.code, message: err.message };
      emit({ id, status: 'failed', code: err.code, message: err.message, detail: err.message, percent: percentOf(done) });
      break;
    }

    // 하위 진행(풀기 부품별 등)은 단계가 도는 동안만 그 단계 이름으로 방송한다.
    const stageCtx = {
      ...engineCtx,
      progress: (sub) => {
        try { engineCtx.progress(sub); } catch { /* 서버 쪽 실패는 무시 */ }
        emit({ id, status: 'running', percent: percentOf(done), sub: sub ?? null });
      },
    };

    try {
      const fn = await stageModule(id, { modules, importer });

      // 고장 주입(계약: run 호출 **직전**). 시험 행렬의 9회 재개 실험이 이 한 줄을 쓴다.
      if (failAt && String(failAt) === id) {
        throw new StageError(code, `${label} 단계에서 일부러 멈췄습니다(고장 주입).`, { failAt: id, injected: true });
      }

      const result = await fn(stageCtx);
      const recorded = result?.recorded ?? null;
      const stagePending = normalizePending(result?.pending);
      mergePending(pending, stagePending);

      // ② 단계가 알려 준 자식 환경을 뒤 단계가 물려받는다.
      if (id === 'env') {
        const fromStage = envFromRecorded(recorded) ?? envFromRecorded(result);
        if (fromStage) {
          engineCtx.env = { ...engineCtx.env, ...fromStage };
          log('[engine] 심·환경변수 단계가 준 환경을 뒤 단계에 물려줌');
        }
      }

      done += 1;
      stages[id] = { status: 'done', recorded };
      saveStage(id, {
        status: 'done',
        startedAt,
        finishedAt: new Date().toISOString(),
        recorded,
        pending: stagePending,
        code: null,
        message: null,
      });
      log(`[engine] ${id}(${label}) — 끝(${percentOf(done)}%)`);
      emit({ id, status: 'done', percent: percentOf(done), sub: null });
    } catch (err) {
      // E-OUTSIDE-ROOT 는 단계 밖 공용 코드라 다시 감싸지 않는다(계약 "멱등·무삭제").
      const stageErr = isStageError(err)
        ? err
        : new StageError(code, `${label} 단계에서 예상치 못한 오류가 났습니다.`, String(err?.stack ?? err?.message ?? err));
      failed = { id, code: stageErr.code, message: stageErr.message };
      stages[id] = { status: 'failed', code: stageErr.code, message: stageErr.message };
      log(`[engine] ${id}(${label}) — 실패 ${stageErr.code}: ${stageErr.message}`);
      try {
        saveStage(id, {
          status: 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          code: stageErr.code,
          message: stageErr.message,
          detail: stageErr.detail ?? null,
        });
      } catch (e2) {
        log(`[engine] 실패 기록도 저장하지 못했습니다: ${String(e2?.message ?? e2)}`);
      }
      emit({
        id, status: 'failed', code: stageErr.code, message: stageErr.message,
        detail: stageErr.message, percent: percentOf(done),
      });
      break; // 뒤 단계는 앞 단계의 결과 위에 선다 — 계속 갈 수 없다
    }
  }

  const ok = !failed;
  log(ok
    ? `[engine] 세팅 완료 — 단계 ${done}/${STAGES.length}, 대기 기능 ${pending.length}개`
    : `[engine] 세팅 멈춤 — ${failed.id}(${failed.code})`);

  return { ok, failed, pending, stages };
}

// 서버 어댑터가 다른 이름을 찾더라도 걸리도록 별칭 하나를 함께 내보낸다
// (`lib/adapters/setup-runner.mjs` 는 `runSetup` 을 쓴다).
export { runSetup as run };

export default { runSetup, STAGES, stageModule, stageCode, stageLabel };
