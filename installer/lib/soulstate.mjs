import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// The "minimal nameplate" (docs/설계.md 4-1 ②): the setup guide's appendix-A
// schema with only the fields the installer can honestly know, plus the
// guide's new `packageInstall` flag. Its whole job is to make the guide
// recognise this folder as its own soul instead of raising `soul-conflict`;
// every real decision (structure, icon) is deliberately left at
// `wizard-paused` because the agent, not the installer, asks those questions.
//
// It is never overwritten. If a soul-state.json is already there, the folder
// belongs to an earlier install (or an earlier guide run) and its content is
// the user's data -- the installer's global rule is that it deletes and
// overwrites nothing.

export function soulStatePath(root) {
  return path.join(root, 'soul-state.json');
}

export function writeMinimalSoulState(root, { edition = 'claude', name, guideVersion = '7' } = {}) {
  const dest = soulStatePath(root);
  if (fs.existsSync(dest)) return { written: false, path: dest };

  const state = {
    schemaVersion: 7,
    soulId: randomUUID(),
    soulName: name ?? path.basename(root),
    createdAt: new Date().toISOString(),
    structureDecision: { status: 'wizard-paused' },
    iconDecision: { status: 'wizard-paused' },
    sourceGuide: { edition, version: guideVersion },
    packageInstall: true,
  };
  fs.mkdirSync(root, { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
  return { written: true, path: dest, state };
}
