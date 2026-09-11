import fs from 'node:fs';
import path from 'node:path';

// rules = { files: [ { path, replace: [{find, with, count}] } | { path, create: '<full file text>' } ] }
//
// `replace` entries implement the same "must_replace" contract as the v9
// packaging tool: `find` must occur exactly `count` (default 1) times in the
// file, or the whole build fails loudly instead of silently drifting from a
// pristine npm install.
//
// `create` is a small addition beyond the original spec: one of the four
// locally patched files (src/activity.js) does not exist at all in pristine
// @karpeleslab/teamclaude@1.1.16 (confirmed via `npm pack`) -- it is a wholly
// new file, so there is no anchor text to find-and-replace against. For that
// case the entry carries the full patched file content and is written as-is.
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
