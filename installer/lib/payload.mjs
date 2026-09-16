// One place that knows "where does part <id> live inside payload\".
//
// The packed manifest (payload\manifest.json) is the authority: every entry is
// `parts[<id>] = { file, version, sha256, bytes }` where `file` is the path
// *relative to payload\* (build\pack.mjs / _build\stage\payload\manifest.json).
// lock.json carries the same `file` value, so it is the fallback when a stage
// is handed a lock but no manifest (fault-injection runs, unit tests).
//
// Stages call partPath/partFile instead of hard-coding names, so when T08
// moves the payload tree around only this file changes.
import nodeFs from 'node:fs';
import path from 'node:path';

export function partEntry(ctx, id) {
  return ctx?.manifest?.parts?.[id] ?? ctx?.lock?.parts?.[id] ?? null;
}

export function partVersion(ctx, id) {
  const e = partEntry(ctx, id);
  return e?.version ?? null;
}

// Absolute path of the part as it was packed. null = the package does not
// carry this part (a stage then records it as missing instead of crashing).
export function partPath(ctx, id) {
  const e = partEntry(ctx, id);
  if (!e?.file || !ctx?.payloadDir) return null;
  return path.join(ctx.payloadDir, e.file.split('/').join(path.sep));
}

// The name the part must keep on disk (lock's `file` basename): the ontology
// spec ships as setup\<그 이름>.md and lands in the soul root under exactly
// that name, so the name lives in lock.json, not in the stage code.
export function partBasename(ctx, id) {
  const p = partPath(ctx, id);
  return p ? path.basename(p) : null;
}

// Directory form of a part. Some parts are packed as a .zip that ⑤-1 unpack
// expands (setup\ontology.zip, tools\hwpx-templates.zip); a dev/stage tree may
// instead carry the plain folder. Try, in order:
//   1. the packed path itself, if it is a directory
//   2. the same path with the archive suffix dropped
//   3. payload\<dir>\<id>            (e.g. payload\setup\ontology)
// Returns null when none of them exists -- the caller then knows the files are
// still inside an archive and leaves them to the unpack stage.
export function partDir(ctx, id, { fs = nodeFs } = {}) {
  const p = partPath(ctx, id);
  const candidates = [];
  if (p) {
    candidates.push(p);
    const stripped = p.replace(/\.(zip|tar|tar\.gz|tgz)$/i, '');
    if (stripped !== p) candidates.push(stripped);
    candidates.push(path.join(path.dirname(p), id));
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch { /* unreadable candidate: try the next one */ }
  }
  return null;
}

// A single file inside a directory-shaped part.
export function partFile(ctx, id, relative, { fs = nodeFs } = {}) {
  const dir = partDir(ctx, id, { fs });
  if (!dir) return null;
  return path.join(dir, String(relative).split('/').join(path.sep));
}

// payload\policy\ -- the guide templates, the registry template and the folder
// icon. They are plain files (no archive), so the folder name is fixed; a
// future `policy` part id overrides it without touching the stages.
export function policyDir(ctx, { fs = nodeFs } = {}) {
  return partDir(ctx, 'policy', { fs }) ?? path.join(ctx.payloadDir, 'policy');
}

export function policyPath(ctx, name, { fs = nodeFs } = {}) {
  return path.join(policyDir(ctx, { fs }), name);
}
