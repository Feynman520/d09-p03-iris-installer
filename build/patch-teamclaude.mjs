import fs from 'node:fs';
import path from 'node:path';

// Schema: rules = { files: [ <fileRule>, ... ] }
//
// Each <fileRule> is one of two shapes:
//   { path, replace: [ { find, with, count } , ... ] }
//     -- path is patched in place. Every `find` must occur in the file's
//        current text exactly `count` (default 1) times before being
//        swapped for `with`, in array order (so a later rule sees the
//        text left behind by earlier ones in the same file).
//   { path, create: '<full file text>' }
//     -- path must NOT already exist (see guard below). Its full final
//        content is written as-is (parent directories created as needed).
//
// `path` is always relative to the npm --prefix root, e.g.
// 'node_modules/@karpeleslab/teamclaude/src/server.js'.
//
// `replace` entries implement the same "must_replace" contract as the v9
// packaging tool: `find` must occur exactly `count` (default 1) times in the
// file, or the whole build fails loudly instead of silently drifting from a
// pristine npm install.
//
// `create` is a small addition beyond the original brief's spec: some of the
// locally patched files (src/activity.js, and as of the 2026-09-08 patch
// round also the three *.test.js/*.test.mjs files at the package root) do
// not exist at all in pristine @karpeleslab/teamclaude@1.1.16 (confirmed via
// `npm pack`) -- they are wholly new files, so there is no anchor text to
// find-and-replace against. For those, the entry carries the full patched
// file content and is written as-is. Because `create` is only meant for
// files absent from pristine, a `create` whose target already exists on
// disk is treated as a build error (rules.json / pristine drift, or a rule
// that should have been a `replace`) rather than silently overwritten.
//
// Fix round 2 (2026-09-11): applyPatches is two-phase. Phase 1 reads every
// target file and computes every replacement / validates every `create`
// guard in memory -- ALL anchor-count checks and ALL create-existence checks
// -- without writing anything. Phase 2 (only reached if every phase-1 check
// passed) writes every result. This means a failure on file N of a
// multi-file rules.json never leaves files 1..N-1 partially patched on disk:
// either the whole batch applies, or nothing does.
export async function applyPatches(prefixDir, rules, log) {
  // Phase 1: compute everything, write nothing.
  const ops = [];
  for (const f of rules.files) {
    const abs = path.join(prefixDir, f.path);
    if (f.create !== undefined) {
      if (fs.existsSync(abs)) throw new Error(`create target exists ${f.path}`);
      ops.push({ kind: 'create', abs, relPath: f.path, content: f.create });
      continue;
    }
    let text = fs.readFileSync(abs, 'utf8');
    f.replace.forEach((r, i) => {
      const n = text.split(r.find).length - 1;
      if (n !== (r.count ?? 1)) throw new Error(`anchor mismatch ${f.path} #${i} (found ${n})`);
      text = text.split(r.find).join(r.with);
    });
    ops.push({ kind: 'replace', abs, relPath: f.path, text, ruleCount: f.replace.length });
  }
  // Phase 2: every check above passed -- now write.
  for (const op of ops) {
    if (op.kind === 'create') {
      fs.mkdirSync(path.dirname(op.abs), { recursive: true });
      fs.writeFileSync(op.abs, op.content);
      log(`created ${op.relPath}`);
    } else {
      fs.writeFileSync(op.abs, op.text);
      log(`patched ${op.relPath} (${op.ruleCount})`);
    }
  }
}
