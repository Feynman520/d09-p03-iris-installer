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
// loadRules() silently falls back to just the base rules.
export function loadRules({
  baseFile = path.join(HERE, 'sanitize-rules.json'),
  localFile = path.join(HERE, 'sanitize-local.json'),
} = {}) {
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  if (!fs.existsSync(localFile)) return base;
  const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  return {
    ...base,
    forbiddenNames: [...(base.forbiddenNames ?? []), ...(local.forbiddenNames ?? [])],
    forbiddenStrings: [...(base.forbiddenStrings ?? []), ...(local.forbiddenStrings ?? [])],
    forbiddenRegex: [...(base.forbiddenRegex ?? []), ...(local.forbiddenRegex ?? [])],
  };
}
