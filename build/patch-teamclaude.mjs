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
//     -- path does not need to already exist. Its full final content is
//        written as-is (parent directories created as needed).
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
// file content and is written as-is.
export async function applyPatches(prefixDir, rules, log) {
  for (const f of rules.files) {
    const abs = path.join(prefixDir, f.path);
    if (f.create !== undefined) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.create);
      log(`created ${f.path}`);
      continue;
    }
    let text = fs.readFileSync(abs, 'utf8');
    f.replace.forEach((r, i) => {
      const n = text.split(r.find).length - 1;
      if (n !== (r.count ?? 1)) throw new Error(`anchor mismatch ${f.path} #${i} (found ${n})`);
      text = text.split(r.find).join(r.with);
    });
    fs.writeFileSync(abs, text);
    log(`patched ${f.path} (${f.replace.length})`);
  }
}
