import fs from 'node:fs';
import path from 'node:path';

// Screen-facing state (kept in memory by server.mjs + mirrored to
// %LOCALAPPDATA%\IRIS-Installer\state.json so a browser refresh, or the
// installer being re-run, resumes at the same wizard step). Once the soul
// root is chosen, the receipt (installer/lib/receipt.mjs) is the source of
// truth for what is actually installed; this file is only the UI's copy of
// "which screen am I on right now".
//
// v2 (docs/설치기-API-v2.md): the eight-step machine
//   precheck -> locate -> choice -> structure -> summary -> setup -> online -> done
// plus two mode-only steps: `auto` (the updater's part-swap run) and
// `reinstall-required` (an --auto run over a 1.x receipt).

export const STEPS = [
  'precheck', 'locate', 'choice', 'structure', 'summary', 'setup', 'online', 'done',
];

// Not part of the linear machine -- entered by a flag, never by a click.
export const MODE_STEPS = ['auto', 'reinstall-required'];

// docs/세팅엔진-계약-v2.md: the nine engine stages, in order. The server never
// runs them itself; it mirrors what runSetup()'s onStage callback reports.
export const SETUP_STAGES = [
  'unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks',
];

// docs/설계-v2.md 7절 (조각 ⑥). `document-skills` 는 Claude 구독을 골랐을 때만
// 들르는 칸이다(허가서상 내려받기 부품 — 설계-v2 13절).
export const ONLINE_STAGES = ['net', 'claude', 'document-skills', 'login', 'relay'];

export function initialSetup() {
  return {
    stage: null,
    stages: SETUP_STAGES.map((id) => ({ id, status: 'pending', code: null, detail: null })),
    percent: 0,
    current: null,
    error: null,
  };
}

export function initialOnline() {
  return {
    stage: null,
    net: null,
    claude: { state: 'skipped', source: null, code: null },
    documentSkills: { state: 'skipped', code: null },
    logins: {},
    relay: { state: 'pending', accounts: 0 },
  };
}

export function initialState({ zipRoot, nodeDir, packageVersion = null } = {}) {
  return {
    step: 'precheck',
    zipRoot,
    nodeDir,
    packageVersion,
    precheck: null,
    soul: null,
    choice: null,
    decisions: null,
    setup: initialSetup(),
    online: initialOnline(),
    report: null,
  };
}

export function loadState(stateFile) {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Same tmp-file-then-rename pattern as receipt.mjs's writeReceipt: a crash
// mid-write must never leave a half-written state.json behind.
export function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, stateFile);
}

// 2026-09-14 (second PC): re-running a NEWER zip resumed at the old run's
// step, so the copy never ran and the handoff named a guide that was never
// copied. A saved state therefore belongs to the package version that wrote
// it; anything else (including a state with no version at all, written by
// 1.4.3 and earlier) is foreign and starts over from precheck.
export function isSamePackage(state, version) {
  return !!state && state.packageVersion === version;
}

// Fills in whatever a state restored from disk is missing, so a state written
// by an older build of this same package version can still be read back
// without every route having to guard for undefined.
export function normalizeState(state, { zipRoot, nodeDir, packageVersion }) {
  const base = initialState({ zipRoot, nodeDir, packageVersion });
  const merged = { ...base, ...state, zipRoot, nodeDir, packageVersion };
  merged.setup = mergeSetup(state?.setup);
  merged.online = { ...initialOnline(), ...(state?.online ?? {}) };
  return merged;
}

function mergeSetup(saved) {
  const fresh = initialSetup();
  if (!saved || !Array.isArray(saved.stages)) return fresh;
  const byId = new Map(saved.stages.filter(Boolean).map((s) => [s.id, s]));
  fresh.stages = fresh.stages.map((s) => ({ ...s, ...(byId.get(s.id) ?? {}) }));
  fresh.stage = saved.stage ?? null;
  fresh.current = saved.current ?? null;
  fresh.error = saved.error ?? null;
  fresh.percent = setupPercent(fresh);
  return fresh;
}

// Floor, never rounded up: 8 of 9 stages done must not read as 100%
// (AGENTS.md 진행상황 표시 원칙).
export function setupPercent(setup) {
  const stages = setup?.stages ?? [];
  if (stages.length === 0) return 0;
  const finished = stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return Math.floor((finished / stages.length) * 100);
}

// One engine stage transition (or one sub-progress tick). Mutates + returns
// `setup` so the caller can save it in the same turn.
export function markSetupStage(setup, { id, status, code = null, detail = null, sub = null, percent = null }) {
  const entry = setup.stages.find((s) => s.id === id);
  if (entry) {
    if (status) entry.status = status === 'skipped-done' ? 'done' : status;
    if (code !== null) entry.code = code;
    if (detail !== null) entry.detail = detail;
    if (sub !== null) entry.sub = sub;
  }
  if (id) {
    setup.stage = id;
    setup.current = id;
  }
  if (status === 'failed') {
    setup.error = {
      id,
      code,
      message: typeof detail === 'string' ? detail : (detail?.message ?? null),
    };
  }
  setup.percent = percent === null ? setupPercent(setup) : percent;
  return setup;
}
