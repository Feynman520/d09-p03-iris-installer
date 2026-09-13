import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Two-tier sanitize rules: build/sanitize-rules.json is tracked and contains
// only generic, non-personal rules (safe to commit). build/sanitize-local.json
// is gitignored and holds this developer's actual personal strings (real
// account emails, dev-PC username, school domain, etc.) so they never have to
// be written into a tracked file (and therefore never enter git history).
// build/sanitize-local.example.json (tracked) documents the shape with
// placeholders. When the local file is absent (e.g. a fresh clone, or CI),
// loadRules() falls back to just the base rules -- but LOUDLY (2026-09-12
// final review I7): the base rules carry no personal literals at all, so a
// build without the local file passes a much weaker gate while printing the
// same "sanitize: ok (0 hits)" line. `requireLocal` turns that into a hard
// failure, which is what release builds use (build/build.mjs
// --require-local / IRIS_BUILD_REQUIRE_LOCAL=1).
export function loadRules({
  baseFile = path.join(HERE, 'sanitize-rules.json'),
  localFile = path.join(HERE, 'sanitize-local.json'),
  requireLocal = false,
  warn = (msg) => console.warn(msg),
} = {}) {
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  if (!fs.existsSync(localFile)) {
    if (requireLocal) {
      throw new Error(
        `sanitize rules: local rule file is required but missing: ${localFile} `
        + '(copy build/sanitize-local.example.json and fill it in; release builds must not run without it)',
      );
    }
    warn(
      `WARNING: sanitize local rule file not found (${localFile}) -- scanning with the `
      + 'generic base rules ONLY. No personal-string rule is in effect for this run. '
      + 'Do not publish a zip built this way; use --require-local for release builds.',
    );
    return base;
  }
  const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  return {
    ...base,
    forbiddenNames: [...(base.forbiddenNames ?? []), ...(local.forbiddenNames ?? [])],
    forbiddenStrings: [...(base.forbiddenStrings ?? []), ...(local.forbiddenStrings ?? [])],
    forbiddenRegex: [...(base.forbiddenRegex ?? []), ...(local.forbiddenRegex ?? [])],
  };
}

// ---------------------------------------------------------------------------
// the repository's own deploy-stack pointers (2026-09-14)
// ---------------------------------------------------------------------------

// `<repo root>/.stack` and `<repo root>/.supa` are one-line labels -- a stack
// letter, an account label -- that say which hosting account this project is
// bound to. The R07 guardrail reads them before any push, so this repo tracks
// its own on purpose (added 2026-09-13 when it went public).
//
// The `**/.stack` / `**/.supa` forbiddenNames rule exists for the SHIPPED ZIP:
// a collected part (Face, the dashboard) could carry its own pointer, and that
// must never travel to a stranger's PC. That rule is untouched -- check ②
// scans the whole extracted zip with no exception whatsoever.
//
// Only the repository-side scans (verify/static.mjs ⑦ and ⑧, and the two tests
// that mirror them) take these two ROOT files out of the hit list, and they
// print them as allowed exceptions rather than hiding them. A `.stack` under
// any other path is still a hit, in the repo as much as in the zip, and so is
// a *content* hit inside one of these files -- only the name rule is excused.
export const REPO_ROOT_STACK_POINTERS = ['.stack', '.supa'];

export function splitRepoStackPointers(hits) {
  const allowed = [];
  const rest = [];
  for (const hit of hits ?? []) {
    const isRootPointer = REPO_ROOT_STACK_POINTERS.includes(String(hit?.file ?? ''))
      && String(hit?.rule ?? '').startsWith('name:');
    (isRootPointer ? allowed : rest).push(hit);
  }
  return { allowed, rest };
}
