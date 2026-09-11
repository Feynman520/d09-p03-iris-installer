import fs from 'node:fs';
import path from 'node:path';

// Screen-facing state (kept in memory by server.mjs + mirrored to
// %LOCALAPPDATA%\IRIS-Installer\state.json so a browser refresh, or the
// installer being re-run, resumes at the same wizard step). Once the soul
// root is chosen, the receipt (installer/lib/receipt.mjs) is the source of
// truth for what is actually installed; this file is only the UI's copy of
// "which screen am I on right now".

export function initialState({ zipRoot, nodeDir }) {
  return { step: 'precheck', zipRoot, nodeDir };
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
