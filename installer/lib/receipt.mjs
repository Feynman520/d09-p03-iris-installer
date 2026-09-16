import fs from 'node:fs';
import path from 'node:path';

// Schema = docs/설계.md §4-1 ("설치기가 남기는 세 가지" ①) verbatim, schema: 1.
// `root` is the soul root (e.g. C:\NOVA) chosen during the "name" step --
// nothing under it exists yet when newReceipt() is called (the global
// constraint: nothing is written under C:\ before the soul name is chosen),
// writeReceipt() is what first creates root\_agent\setup.

export function receiptPath(root) {
  return path.join(root, '_agent', 'setup', 'package-receipt.json');
}

export function newReceipt({ root, name, manifest, createdBy }) {
  const pkg = manifest?.package ?? {};
  return {
    schema: 1,
    package: {
      name: pkg.name ?? 'IRIS',
      version: pkg.version ?? null,
      // Real manifest.json (lib/manifest.mjs buildManifest) carries `built`
      // at the top level, not under `package` -- fall back to that shape
      // too so this also works when fed the actual payload manifest.
      built: pkg.built ?? manifest?.built ?? null,
      guideVersion: pkg.guideVersion ?? null,
      license: pkg.license ?? 'MIT',
    },
    soul: { root, name, createdBy },
    choice: null,
    installed: {},
    login: {},
    env: null,
    steps: {
      precheck: 'pending',
      name: 'pending',
      choice: 'pending',
      copy: 'pending',
      login: 'pending',
      handoff: 'pending',
    },
    log: path.win32.join('_agent', 'setup', 'package-install.log'),
  };
}

// ---------------------------------------------------------------------------
// v2 (schema 2) -- docs/설계-v2.md 4·6·7절, docs/설치기-API-v2.md "재실행·모드"
// ---------------------------------------------------------------------------
// What v2 adds on top of the schema-1 shape (kept above, unchanged, because
// the updater and every 1.x install still read it):
//   precheck.recorded  준비 검사 결과 전문 -- 뒤 단계가 재검사 없이 읽는다
//   choice             { subscriptions, leadAgent }  (옛 guideEdition 없음)
//   decisionsPath      작업 폴더 답안 파일의 경로
//   setup              { <stage id>: { status, startedAt, finishedAt, recorded, code, message } }
//   online             { stage, net, claude, logins, relay, completed }
// A 1.x receipt (schema < 2) is NOT upgraded in place: the v2 engine lays out
// a different soul, so an automatic update over a 1.x install is refused and
// the person is told to install 2.0 fresh (D2-24).
export const RECEIPT_SCHEMA = 2;

export const SETUP_STAGE_IDS = [
  'unpack', 'env', 'skeleton', 'structure', 'venv', 'adapters', 'relay', 'ontology', 'checks',
];

export function isLegacyReceipt(receipt) {
  return !!receipt && Number(receipt.schema ?? 1) < RECEIPT_SCHEMA;
}

// Where a 1.x receipt is kept when 2.0 installs over it (설계-v2 S09).
export function legacyReceiptBackupPath(root) {
  return path.join(root, '_agent', 'setup', 'package-receipt.v1.json');
}

// A 1.x receipt is the only record of what 1.x put on that PC -- which parts,
// which versions, which logins. 2.0 writes a different receipt at the same
// path, so without this the record is simply gone, and the installer's first
// rule is that it never destroys what it did not create.
//
// Returns { written, kept, path }. `kept: true` means a backup was already
// there and was left alone: a SECOND 2.0 run would otherwise back up the
// (already replaced) v2 receipt over the real 1.x original.
export function backupLegacyReceipt(root, receipt, { fs: fsImpl = fs } = {}) {
  const dest = legacyReceiptBackupPath(root);
  if (fsImpl.existsSync(dest)) return { written: false, kept: true, path: dest };
  fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify(receipt, null, 2), 'utf8');
  fsImpl.renameSync(tmp, dest);
  return { written: true, kept: false, path: dest };
}

export function newReceiptV2({ root, name, manifest, createdBy }) {
  const base = newReceipt({ root, name, manifest, createdBy });
  return {
    ...base,
    schema: RECEIPT_SCHEMA,
    precheck: { recorded: null, at: null },
    choice: null,
    decisionsPath: null,
    setup: {},
    online: {},
    steps: {
      precheck: 'pending',
      locate: 'pending',
      choice: 'pending',
      structure: 'pending',
      summary: 'pending',
      setup: 'pending',
      online: 'pending',
    },
  };
}

// Adds any v2 field a receipt is missing without touching what is there --
// used when a run re-opens a receipt this same package wrote earlier.
export function ensureV2Fields(receipt) {
  if (!receipt) return receipt;
  receipt.schema = RECEIPT_SCHEMA;
  receipt.precheck = receipt.precheck ?? { recorded: null, at: null };
  receipt.setup = receipt.setup ?? {};
  receipt.online = receipt.online ?? {};
  receipt.steps = receipt.steps ?? {};
  if (!('choice' in receipt)) receipt.choice = null;
  if (!('decisionsPath' in receipt)) receipt.decisionsPath = null;
  return receipt;
}

export function setPrecheck(receipt, recorded) {
  ensureV2Fields(receipt);
  receipt.precheck = { recorded: recorded ?? null, at: new Date().toISOString() };
  return receipt;
}

// The engine owns setup.<id> (contract v2), but the server writes the same
// shape when it has to record a stage the engine could not even start.
export function setSetupStage(receipt, id, info) {
  ensureV2Fields(receipt);
  receipt.setup[id] = { ...(receipt.setup[id] ?? {}), ...info };
  return receipt;
}

export function setupAllDone(receipt) {
  if (!receipt || isLegacyReceipt(receipt)) return false;
  return SETUP_STAGE_IDS.every((id) => receipt.setup?.[id]?.status === 'done');
}

export function onlineDone(receipt) {
  if (!receipt || isLegacyReceipt(receipt)) return false;
  return receipt.online?.completed === true || receipt.steps?.online === 'done';
}

export function readReceipt(root) {
  try {
    const raw = fs.readFileSync(receiptPath(root), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Atomic write: write to a sibling .tmp file then rename over the real path,
// so a crash mid-write (or a concurrent reader) never observes a
// half-written receipt.
export function writeReceipt(root, receipt) {
  const dest = receiptPath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
}

export function markStep(receipt, step, value) {
  receipt.steps[step] = value;
  return receipt;
}

export function setInstalled(receipt, name, info) {
  receipt.installed[name] = info;
  return receipt;
}

// Shape = task-13-brief.md: login.<provider> = {cli, relay, relayMethod, at}.
// `cli`/`relay` are booleans (never secrets); `relayMethod` is 'import' or
// 'login' (which mechanism registered the account with TeamClaude).
export function setLogin(receipt, provider, { cli, relay, relayMethod }) {
  receipt.login[provider] = { cli, relay, relayMethod, at: new Date().toISOString() };
  return receipt;
}
