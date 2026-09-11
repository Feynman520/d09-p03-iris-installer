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
