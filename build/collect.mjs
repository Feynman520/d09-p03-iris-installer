import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { run as defaultRun } from '../lib/run.mjs';
import { extractZip, extractMembers, listArchive, zipDir } from '../lib/zip.mjs';
import { sha256File } from '../lib/manifest.mjs';
import { assertOnline, isOffline } from '../lib/net.mjs';
import { applyPatches } from './patch-teamclaude.mjs';

// Project root (one level up from this file, build/), independent of the
// caller's process.cwd() -- lock.json's `patches` paths (e.g.
// 'patches/teamclaude/rules.json') are always relative to here, not to
// wherever `node build/collect.mjs` (or a test importing collect()) happens
// to be run from.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Long-running child processes: a cold `git clone` of a plugin monorepo or a
// `pip download` of 43 wheels (numpy/pandas/pillow included) can outlast
// lib/run.mjs's 10-minute default on a slow link.
const LONG_TIMEOUT_MS = 1_800_000;

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

async function defaultDownload(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
  fs.renameSync(part, dest);
}

// Every file under `dir`, as sorted POSIX-style relative paths.
export function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(abs, base, out);
    else if (entry.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

// Content identity of a whole directory: sha256 over "<relative path> <file
// sha256>\n" lines, sorted by path. Path-sensitive (a file moving changes the
// hash) and order-independent (readdir order cannot change it), so two
// machines that check out the same git commit compute the same value. This is
// what a `git` part records as `treeHash`, and what validates its cache slot.
export async function treeHash(dir) {
  const h = createHash('sha256');
  for (const rel of listFiles(dir).sort()) {
    h.update(`${rel} ${await sha256File(path.join(dir, rel))}\n`);
  }
  return h.digest('hex');
}

function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// A repo URL turned into a filesystem-safe folder name for the shared clone.
// Repo name + 8 hex of the URL: short (MAX_PATH, see below) but still unique
// per remote, so two forks with the same repo name never share a clone.
function repoSlug(repo) {
  const tail = repo.replace(/\.git$/, '').replace(/\/+$/, '').split('/').pop() ?? 'repo';
  return `${tail.replace(/[^A-Za-z0-9._-]/g, '_')}-${shortHash(repo).slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// cache slots:  _build\cache\<kind>\<part name>\  (content)
//               _build\cache\<kind>\<part name>.meta.json
//               _build\cache\<kind>\<part name>.lic\
//
// `url` keeps its historical flat layout (_build\cache\<basename>) -- the file
// itself is the cache and its sha256 is the validation, so there is nothing a
// slot would add, and moving it would throw away every already-downloaded
// runtime on this PC.
//
// Why the fingerprint is in meta.json and NOT in the folder name: Windows'
// 260-character MAX_PATH. This repo already sits ~100 characters deep, and
// codex's npm prefix reaches another ~121 through
// node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\
// x86_64-pc-windows-msvc\bin\codex-code-mode-host.exe. The first draft of
// this task used _build\cache\npm-prefix\<name>-<16 hex>\content\ and blew
// straight past the limit (measured 2026-09-15: PowerShell could no longer
// stat that .exe). `_build\cache\npm\<name>\` is byte-for-byte the same
// length as the `_build\stage\npm\<name>\` the previous build used, so this
// layout cannot regress a build that worked before.
//
// One slot per part rather than one per version is not a weakening: the slot
// is only ever *trusted* when meta.json still matches what lock.json asks for
// (git -> repo+commit+subdir/include, npm -> npm+version+integrity+patch
// digest, wheelhouse -> requirements.lock digest) AND the content
// re-validates (tree hash / wheel count + per-wheel sha256). A re-pin simply
// invalidates and replaces the slot instead of leaving a second copy behind.
// ---------------------------------------------------------------------------

function slotPaths(cacheDir, kind, name) {
  const base = path.join(cacheDir, kind);
  return {
    content: path.join(base, name),
    licenses: path.join(base, `${name}.lic`),
    meta: path.join(base, `${name}.meta.json`),
  };
}

function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

// meta.json is the flag that says "this slot is trustworthy", so it is
// written the same way defaultDownload() writes a file: to a `.tmp` sibling
// first, then renamed into place. A rename is atomic, so a build killed
// mid-write leaves either the previous meta or none -- never a truncated one
// that readMeta() would reject (turning a good slot into a re-download) or,
// worse, a partially-updated one. Same reason freshSlot() removes meta first.
function writeMeta(metaPath, meta) {
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  const tmp = `${metaPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, metaPath);
}

function freshSlot(paths) {
  fs.rmSync(paths.meta, { force: true }); // first: a half-built slot must never look valid
  fs.rmSync(paths.content, { recursive: true, force: true });
  fs.rmSync(paths.licenses, { recursive: true, force: true });
  fs.mkdirSync(paths.content, { recursive: true });
  fs.mkdirSync(paths.licenses, { recursive: true });
}

// ---------------------------------------------------------------------------
// licence harvesting
// ---------------------------------------------------------------------------

// `LICENSE*` / `LICENCE*` / `COPYING*` / `NOTICE*`, case-insensitively --
// covers LICENSE, LICENSE.txt, LICENSE-MIT, LICENCE.md, COPYING.LESSER,
// NOTICE, and the plural LICENSES some repos use.
const LICENSE_NAME = /^(LICENSE|LICENCE|COPYING|NOTICE)/i;

function isLicenseName(name) {
  return LICENSE_NAME.test(name);
}

// The pattern also matches *folder* names -- numpy's wheel ships
// `numpy-2.5.2.dist-info/licenses/`, and bsdtar's zip listing does not always
// put a trailing slash on a directory entry, so "is this a file" has to be
// answered from the filesystem after extraction, not from the entry name
// (2026-09-15: the first real build died with EPERM copying that folder).
function copyIfFile(from, to) {
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return false;
  fs.copyFileSync(from, to);
  return true;
}

// Copies every licence-looking file sitting directly in `rootDir` into
// `destDir` as `<partName>-<original file name>`. Returns the names written.
// Only the root is scanned on purpose: a deep walk of a node_modules tree or a
// checked-out monorepo would drag in hundreds of dependencies' licences, which
// is a different (and much larger) question than "what is this part's own
// licence text".
function harvestLicensesFrom(rootDir, destDir, partName, prefix = '') {
  const written = [];
  if (!fs.existsSync(rootDir)) return written;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isFile() || !isLicenseName(entry.name)) continue;
    const name = `${partName}-${prefix}${entry.name}`;
    fs.copyFileSync(path.join(rootDir, entry.name), path.join(destDir, name));
    written.push(name);
  }
  return written;
}

// Same idea for a `url` part, where the original is an archive we deliberately
// never unpack in full. tar lists the entries, we keep the licence-looking
// ones no deeper than two segments (depth 2 covers the single wrapper folder
// that node/python/git/age archives all have), and extract only those.
async function harvestLicensesFromArchive(archive, destDir, partName) {
  const entries = await listArchive(archive);
  const picks = entries.filter((e) => {
    const segs = e.replace(/\/+$/, '').split('/');
    return segs.length >= 1 && segs.length <= 2 && isLicenseName(segs[segs.length - 1]);
  });
  if (picks.length === 0) return [];
  const tmp = path.join(destDir, `.extract-${partName}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    await extractMembers(archive, tmp, picks);
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    return [];
  }
  const written = [];
  fs.mkdirSync(destDir, { recursive: true });
  for (const rel of picks) {
    const from = path.join(tmp, ...rel.split('/'));
    const name = `${partName}-${path.basename(rel)}`;
    if (copyIfFile(from, path.join(destDir, name))) written.push(name);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return written;
}

// And for a wheelhouse: each wheel is a zip carrying its licence under
// `<pkg>-<ver>.dist-info/`. Named `<part>-<pkg>-<ver>-<file>` so 43 wheels'
// licences stay distinguishable in one flat folder.
async function harvestLicensesFromWheel(wheel, destDir, partName) {
  const entries = await listArchive(wheel);
  const picks = entries.filter((e) => e.includes('.dist-info/') && isLicenseName(path.basename(e)));
  if (picks.length === 0) return [];
  const tmp = path.join(destDir, `.extract-${path.basename(wheel)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    await extractMembers(wheel, tmp, picks);
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    return [];
  }
  const written = [];
  fs.mkdirSync(destDir, { recursive: true });
  for (const rel of picks) {
    const from = path.join(tmp, ...rel.split('/'));
    const dist = rel.split('/').find((s) => s.endsWith('.dist-info')) ?? '';
    const name = `${partName}-${dist.replace(/\.dist-info$/, '')}-${path.basename(rel)}`;
    if (copyIfFile(from, path.join(destDir, name))) written.push(name);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return written;
}

function publishLicenses(slotLicenseDir, payloadLicenseDir) {
  if (!fs.existsSync(slotLicenseDir)) return [];
  fs.mkdirSync(payloadLicenseDir, { recursive: true });
  const names = fs.readdirSync(slotLicenseDir).filter((n) => !n.startsWith('.')).sort();
  for (const n of names) fs.copyFileSync(path.join(slotLicenseDir, n), path.join(payloadLicenseDir, n));
  return names;
}

// ---------------------------------------------------------------------------
// url parts (unchanged cache layout)
// ---------------------------------------------------------------------------

// `noCache` re-downloads even when the cached file's digest already matches.
// Strictly speaking nothing can be learned from that -- the lock's own sha256
// having matched means the bytes on disk ARE the bytes the lock demands -- but
// --no-cache is an explicit, rarely-used escape hatch and "force a re-collect"
// has to mean the same thing for every kind, or the flag is a trap (T07 review
// round 1, finding 3). Cost: ~400 MB of runtimes re-fetched, only when asked.
async function ensureCached(name, p, cacheDir, log, skipDownload, download, noCache = false) {
  if (!p.sha256) throw new Error(`sha256 missing for ${name}`);
  const cached = path.join(cacheDir, path.basename(p.file));
  let hit = false;
  if (!noCache && fs.existsSync(cached) && (await sha256File(cached)) === p.sha256) {
    hit = true;
  } else {
    if (skipDownload) throw new Error(`cache miss for ${name} (--skip-download)`);
    assertOnline(`download ${name} (${p.url})`);
    log(`download ${name}`);
    await download(p.url, cached);
  }
  if ((await sha256File(cached)) !== p.sha256) throw new Error(`sha256 mismatch for ${name}`);
  return { cached, hit };
}

function npmCliPath(nodeDir) {
  return path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

// Resolve which Node executable / npm-cli.js to use for every `npm install`/`npm ci`
// this collect() run performs. The bundled runtime (lock.parts.node) always wins so
// npm never runs under whatever Node happens to be on the build PC's PATH; an
// explicit `nodeDir` overrides that; a bare fallback to this PC's own Node only
// exists so unit tests with fake locks (no node part, no npmCi/npm-prefix use) work.
async function resolveNode({ lock, cacheDir, stageDir, nodeDir, log, skipDownload, download }) {
  if (nodeDir) return { nodeExe: path.join(nodeDir, 'node.exe'), npmCli: npmCliPath(nodeDir), nodeDir };
  const p = lock.parts?.node;
  if (p && p.kind === 'url') {
    // Deliberately NOT passing noCache: this call is bootstrapping the
    // toolchain npm runs under, not collecting the shipped part. The `node`
    // part goes through the main loop like everything else a moment later,
    // and that pass does honour --no-cache (into the same cache file).
    const { cached } = await ensureCached('node', p, cacheDir, log, skipDownload, download);
    const runtimeDir = path.join(stageDir, 'node-runtime');
    await extractZip(cached, runtimeDir, { strip: 1 });
    return { nodeExe: path.join(runtimeDir, 'node.exe'), npmCli: npmCliPath(runtimeDir), nodeDir: runtimeDir };
  }
  const fallbackDir = path.dirname(process.execPath);
  return {
    nodeExe: process.execPath,
    npmCli: path.join(fallbackDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    nodeDir: null,
  };
}

// Applies a single redaction to one already-copied staged file (never to the
// source outside P03). `label` is only used for the log line / error
// message. entry is either {find, replace} (plain-text substring, for
// non-personal text) or {findRegex, replace, count?:1} (regex-based, used
// whenever the matched text contains personal data -- so the tracked
// lock.json itself never has to embed the literal personal string; only the
// shape of what to strip). A plain `find` throws if not found; a
// `findRegex` throws unless it matches exactly `count` times -- either way
// an upstream source change (the anchor moved/vanished) surfaces loudly
// instead of silently shipping the original text again.
function redactFile(absPath, entry, log, label) {
  const text = fs.readFileSync(absPath, 'utf8');
  if (entry.findRegex) {
    const expectedCount = entry.count ?? 1;
    const re = new RegExp(entry.findRegex, 'g');
    const matches = text.match(re);
    const actualCount = matches ? matches.length : 0;
    if (actualCount !== expectedCount) {
      throw new Error(
        `redact: findRegex matched ${actualCount} time(s), expected ${expectedCount}, in ${label} (source may have changed): ${entry.findRegex}`,
      );
    }
    fs.writeFileSync(absPath, text.replace(re, entry.replace), 'utf8');
  } else {
    if (!text.includes(entry.find)) throw new Error(`redact: pattern not found in ${label} (source may have changed)`);
    fs.writeFileSync(absPath, text.split(entry.find).join(entry.replace), 'utf8');
  }
  log(`redacted ${label}`);
}

// Applies lock.json-declared redactions to files already copied into a
// staged `dir`-kind work copy (never to the source outside P03). Used to
// strip dev-machine-only content (hardcoded org accounts/paths) from parts
// collected from outside this project (e.g. dash) that sanitize() correctly
// flags and that we are not allowed to edit at the source. Each entry names
// a specific `file` relative to workDir.
function applyRedactions(workDir, redact, log) {
  for (const entry of redact ?? []) {
    redactFile(path.join(workDir, entry.file), entry, log, entry.file);
  }
}

// `exclude` entries: a plain name matches the FIRST path segment only
// (`node_modules`, `state`); an entry containing `/` is a source-relative
// path prefix (`daemon/__pycache__`) -- the 2026-09-12 review's "copyTree
// first-segment-only" minor, fixed 2026-09-13 when Face's nested
// daemon/__pycache__ showed up in the shipped zip.
//
// Names that NEVER travel, at ANY depth, whatever a part's own `exclude`
// says (T08 ruling 1, 2026-09-15):
//   .git          history + the clone's remote/config, not payload
//   .stack/.supa  R07 deploy-stack pointers -- one-line labels saying which
//                 hosting/Supabase account a repo is bound to. Several
//                 upstream repos we clone (hwp/excel/ppt/pdf-automation,
//                 self-improve) carry their own; they are dev-only markers
//                 and must never reach a stranger's PC. `sanitize-rules.json`
//                 forbids the NAME in the shipped zip, so before this the
//                 build stopped with 6 hits.
//   __pycache__   sources include this PC's live _ontology and
//                 _document-templates, whose python is run in place.
// A part that genuinely needs one of these can still name it in `include`
// (copySelected copies named files directly).
const ALWAYS_EXCLUDE_NAMES = new Set(['.git', '.stack', '.supa', '__pycache__']);

export function copyTree(src, dest, exclude = []) {
  fs.mkdirSync(dest, { recursive: true });
  const names = exclude.filter((e) => !e.includes('/'));
  const prefixes = exclude.filter((e) => e.includes('/')).map((e) => e.replace(/\/+$/, ''));
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      if (rel === '') return true;
      const posix = rel.split(path.sep).join('/');
      const segs = rel.split(path.sep);
      if (segs.some((s) => ALWAYS_EXCLUDE_NAMES.has(s))) return false;
      if (names.includes(segs[0])) return false;
      return !prefixes.some((p) => posix === p || posix.startsWith(p + '/'));
    },
  });
}

// `include`: copy only the named paths (files or folders), keeping their
// relative position. schema 2 uses it for the `ontology` dir part (eight named
// python/js/html files out of a working folder full of generated graph output)
// and for `git` parts that want a handful of folders (`document-skills`).
// A missing entry is a hard error: silently shipping a part with a file
// missing is exactly the failure this lock file exists to prevent.
export function copySelected(src, dest, include, exclude = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of include) {
    const from = path.join(src, ...rel.split('/'));
    if (!fs.existsSync(from)) throw new Error(`include path not found: ${rel} (under ${src})`);
    const to = path.join(dest, ...rel.split('/'));
    if (fs.statSync(from).isDirectory()) {
      copyTree(from, to, exclude);
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

// `asciiRequired: true` on a dir part (the safety hooks) means its PowerShell
// must be pure ASCII -- a .ps1 with Hangul in it is read as ANSI (cp949) by
// Windows PowerShell 5.1 unless it carries a UTF-8 BOM, and a mangled guard
// hook is a guard that does not guard. Checked at collect time so a source
// edit cannot reach a zip.
function assertAsciiPs1(dir, name) {
  for (const rel of listFiles(dir)) {
    if (!rel.toLowerCase().endsWith('.ps1')) continue;
    const buf = fs.readFileSync(path.join(dir, rel));
    const at = buf.findIndex((b) => b > 0x7f);
    if (at >= 0) {
      throw new Error(`asciiRequired: ${name}/${rel} has a non-ASCII byte 0x${buf[at].toString(16)} at offset ${at}`);
    }
  }
}

// (2026-09-12 final review I5) A `dir`/`file` part's source directory, with an
// env override per part name: IRIS_DASH_SOURCE, IRIS_FACE_SOURCE, ...
// lock.json's dash/hwpx-templates/ontology sources are absolute paths to this
// development PC's own folders, so a second machine (fresh clone, CI, another
// checkout) has to be able to point at its own copy without editing a tracked
// file. Unset (the normal case) = exactly the lock value.
//
// Relative values resolve against the project root, not process.cwd() (2026-
// 09-14): the `updater` part's source is `./updater`, a folder *inside* this
// repo, and `face`'s is a sibling `../P02-...`. Both used to work only
// because every build happened to be started from the repo root. verify/
// static.mjs's own partSource() has always resolved against ROOT_DIR; this
// makes the two agree. Absolute values are unaffected.
export function partSource(name, p) {
  const value = process.env[`IRIS_${name.toUpperCase().replace(/-/g, '_')}_SOURCE`] || p.source;
  return value ? path.resolve(ROOT_DIR, value) : value;
}

// ---------------------------------------------------------------------------
// kind: git
// ---------------------------------------------------------------------------

async function collectGit({ name, p, cacheDir, log, noCache, skipDownload, run, licensesDir }) {
  if (!/^[0-9a-f]{40}$/.test(p.commit ?? '')) throw new Error(`git part ${name}: commit must be 40 hex chars`);
  const paths = slotPaths(cacheDir, 'git', name);
  const want = {
    repo: p.repo,
    commit: p.commit,
    subdir: p.subdir ?? null,
    include: p.include ?? null,
    // What copyTree strips, recorded in the slot so that CHANGING the policy
    // invalidates every slot built under the old one. Without this, the
    // 2026-09-15 addition of .stack/.supa silently did nothing for the seven
    // repos whose slots were already valid -- they kept their old content and
    // the build still stopped with 5 `.stack` hits.
    stripped: [...ALWAYS_EXCLUDE_NAMES].sort().join(','),
  };

  let meta = noCache ? null : readMeta(paths.meta);
  let hit = false;
  if (meta && fs.existsSync(paths.content)
    && meta.repo === want.repo && meta.commit === want.commit
    && meta.subdir === want.subdir && JSON.stringify(meta.include) === JSON.stringify(want.include)
    && meta.stripped === want.stripped) {
    // Re-hash rather than trust the slot: a half-written cache (killed build,
    // antivirus quarantine) must look like a miss, not like a good part.
    const actual = await treeHash(paths.content);
    if (actual === meta.treeHash) hit = true;
    else log(`cache stale for ${name} (tree hash ${actual.slice(0, 12)} != ${String(meta.treeHash).slice(0, 12)})`);
  }

  if (!hit) {
    if (skipDownload) throw new Error(`cache miss for ${name} (--skip-download)`);
    const reposDir = path.join(cacheDir, 'git', '_repos');
    const clone = path.join(reposDir, repoSlug(p.repo));
    if (!fs.existsSync(path.join(clone, '.git'))) {
      assertOnline(`git clone ${p.repo} (${name})`);
      fs.mkdirSync(reposDir, { recursive: true });
      fs.rmSync(clone, { recursive: true, force: true });
      log(`git clone ${name} ${p.repo}`);
      const r = await run('git', ['clone', '--filter=blob:none', '--no-checkout', p.repo, clone], { timeoutMs: LONG_TIMEOUT_MS });
      if (r.code !== 0) throw new Error(`git clone ${name}: ${r.err || r.out}`);
    }
    // A blobless clone has the commit graph but not necessarily this commit's
    // blobs, and a commit outside the default branch may not be present at
    // all -- both are network moments, so both sit behind assertOnline.
    const has = await run('git', ['-C', clone, 'cat-file', '-e', `${p.commit}^{commit}`]);
    if (has.code !== 0) {
      assertOnline(`git fetch ${p.commit} for ${name}`);
      const f = await run('git', ['-C', clone, 'fetch', '--filter=blob:none', 'origin', p.commit], { timeoutMs: LONG_TIMEOUT_MS });
      if (f.code !== 0) throw new Error(`git fetch ${name} ${p.commit}: ${f.err || f.out}`);
    }
    assertOnline(`git checkout ${p.commit} for ${name} (blobless clone fetches on demand)`);
    const co = await run('git', ['-C', clone, '-c', 'advice.detachedHead=false', 'checkout', '--force', p.commit], { timeoutMs: LONG_TIMEOUT_MS });
    if (co.code !== 0) throw new Error(`git checkout ${name} ${p.commit}: ${co.err || co.out}`);

    freshSlot(paths);
    // `.git` never travels: it is history, not payload, and it would also
    // leak the clone's own remote/config into a shipped zip.
    const exclude = ['.git'];
    const from = p.subdir ? path.join(clone, ...p.subdir.split('/')) : clone;
    if (p.subdir && !fs.existsSync(from)) throw new Error(`git part ${name}: subdir not found: ${p.subdir}`);
    if (p.include) copySelected(from, paths.content, p.include, exclude);
    else copyTree(from, paths.content, exclude);

    // Licences: the repo root always (that is where an Apache/MIT text lives
    // even when we only ship one plugin folder), plus the subdir root when a
    // subdir was taken.
    harvestLicensesFrom(clone, paths.licenses, name);
    if (p.subdir) harvestLicensesFrom(from, paths.licenses, name, `${p.subdir.split('/').pop()}-`);

    meta = { ...want, treeHash: await treeHash(paths.content), collectedAt: new Date().toISOString() };
    writeMeta(paths.meta, meta);
  }

  // `expectedSkillCount` is the lock's own tripwire against an upstream
  // reshuffle: superpowers is pinned by commit, but if a future re-pin lands
  // on a tree with a different number of skills that is a content change the
  // human must look at, not something the build should ship quietly.
  if (typeof p.expectedSkillCount === 'number') {
    const skills = listFiles(paths.content).filter((rel) => /^skills\/[^/]+\/SKILL\.md$/i.test(rel)).length;
    if (skills !== p.expectedSkillCount) {
      throw new Error(`git part ${name}: expectedSkillCount ${p.expectedSkillCount} but found ${skills} skills/*/SKILL.md`);
    }
  }

  const licenseFiles = publishLicenses(paths.licenses, licensesDir);
  return { content: paths.content, treeHash: meta.treeHash, licenseFiles, hit };
}

// ---------------------------------------------------------------------------
// kind: npm-prefix
// ---------------------------------------------------------------------------

async function collectNpmPrefix({ name, p, cacheDir, log, noCache, skipDownload, run, nodeExe, npmCli, npmEnv, licensesDir }) {
  const patchesFile = p.patches ? path.resolve(ROOT_DIR, p.patches) : null;
  const patchesSha = patchesFile && fs.existsSync(patchesFile) ? await sha256File(patchesFile) : null;
  const paths = slotPaths(cacheDir, 'npm', name);
  const want = { npm: p.npm, version: p.version, integrity: p.integrity ?? null, patchesSha };

  let meta = noCache ? null : readMeta(paths.meta);
  let hit = false;
  if (meta && fs.existsSync(paths.content) && fs.readdirSync(paths.content).length > 0
    && meta.npm === want.npm && meta.version === want.version
    && meta.integrity === want.integrity && meta.patchesSha === want.patchesSha) {
    hit = true;
  }

  if (!hit) {
    if (skipDownload) throw new Error(`cache miss for ${name} (--skip-download)`);
    assertOnline(`npm install ${p.npm}@${p.version} (${name})`);
    freshSlot(paths);
    // p.env is the lock's per-part environment (schema 2): playwright-mcp
    // carries PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 so its postinstall does not
    // pull ~400 MB of browsers we deliberately never ship (the design uses
    // Windows' own Edge channel instead).
    const env = { ...npmEnv, ...(p.env ?? {}) };
    log(`npm install ${name} ${p.npm}@${p.version}`);
    const r = await run(
      nodeExe,
      [npmCli, 'install', '-g', '--prefix', paths.content, `${p.npm}@${p.version}`, '--no-fund', '--no-audit'],
      { env, timeoutMs: LONG_TIMEOUT_MS },
    );
    if (r.code !== 0) throw new Error(`npm install ${name}: ${r.err || r.out}`);
    if (patchesFile) await applyPatches(paths.content, JSON.parse(fs.readFileSync(patchesFile, 'utf8')), log);

    const pkgRoot = path.join(paths.content, 'node_modules', ...String(p.npm).split('/'));
    harvestLicensesFrom(pkgRoot, paths.licenses, name);

    // npm's own lockfile, when the install produced one -- a second fingerprint
    // of what actually landed, next to the registry integrity the lock pins.
    const lockFile = path.join(paths.content, 'package-lock.json');
    const packageLockSha256 = fs.existsSync(lockFile) ? await sha256File(lockFile) : null;
    meta = { ...want, packageLockSha256, collectedAt: new Date().toISOString() };
    writeMeta(paths.meta, meta);
  }

  const licenseFiles = publishLicenses(paths.licenses, licensesDir);
  return { content: paths.content, packageLockSha256: meta.packageLockSha256 ?? null, licenseFiles, hit };
}

// ---------------------------------------------------------------------------
// kind: wheelhouse
// ---------------------------------------------------------------------------

async function resolvePython(run) {
  for (const [exe, pre] of [['python', []], ['py', ['-3.12']]]) {
    const r = await run(exe, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
    if (r.code === 0 && r.out.trim()) return { exe, pre, version: r.out.trim() };
  }
  throw new Error('wheelhouse: no python found on this build PC (tried `python`, `py -3.12`)');
}

async function collectWheelhouse({ name, p, cacheDir, log, noCache, skipDownload, run, licensesDir }) {
  const lockFile = path.resolve(ROOT_DIR, p.requirementsLock);
  if (!fs.existsSync(lockFile)) throw new Error(`wheelhouse ${name}: requirementsLock not found: ${p.requirementsLock}`);
  // The lock file's own sha256 is the wheelhouse's identity (lock.json says so
  // in as many words). Check it before anything else: a stray line-ending
  // conversion here silently changes which wheels get downloaded.
  const lockSha = await sha256File(lockFile);
  if (lockSha !== p.sha256) {
    throw new Error(`wheelhouse ${name}: requirements.lock sha256 ${lockSha} != lock.json ${p.sha256}`);
  }
  if (p.requirementsIn && p.requirementsInSha256) {
    const inFile = path.resolve(ROOT_DIR, p.requirementsIn);
    if (fs.existsSync(inFile)) {
      const inSha = await sha256File(inFile);
      if (inSha !== p.requirementsInSha256) {
        throw new Error(`wheelhouse ${name}: requirements.in sha256 ${inSha} != lock.json ${p.requirementsInSha256}`);
      }
    }
  }

  const paths = slotPaths(cacheDir, 'wh', name);
  const want = { requirementsLockSha256: lockSha, pythonTag: p.pythonTag, platform: p.platform, expectedCount: p.expectedCount };

  let meta = noCache ? null : readMeta(paths.meta);
  let hit = false;
  if (meta && fs.existsSync(paths.content)
    && meta.requirementsLockSha256 === want.requirementsLockSha256
    && meta.pythonTag === want.pythonTag && meta.platform === want.platform) {
    const names = fs.readdirSync(paths.content).filter((f) => f.endsWith('.whl')).sort();
    hit = names.length === p.expectedCount && Object.keys(meta.wheels ?? {}).length === names.length;
    for (const w of names) {
      if (!hit) break;
      if ((await sha256File(path.join(paths.content, w))) !== meta.wheels[w]) {
        log(`cache stale for ${name} (wheel ${w} changed)`);
        hit = false;
      }
    }
  }

  if (!hit) {
    if (skipDownload) throw new Error(`cache miss for ${name} (--skip-download)`);
    assertOnline(`pip download ${name} (${p.requirementsLock})`);
    const py = await resolvePython(run);
    freshSlot(paths);
    log(`pip download ${name} (python ${py.version}, ${p.platform}/${p.pythonTag})`);
    // --require-hashes: requirements.lock is pip-compile output with a
    // --hash= for every pinned version, so pip verifies each wheel it fetches
    // against the lock instead of trusting the index (verified working on
    // this PC's pip 25.0.1, 2026-09-15). --no-deps because --platform
    // cross-downloads cannot resolve a dependency graph anyway, and the lock
    // already names the full closure.
    const args = [
      ...py.pre, '-m', 'pip', 'download',
      '--only-binary=:all:',
      '--platform', p.platform,
      '--python-version', '3.12',
      '--implementation', 'cp',
      '--abi', p.pythonTag,
      '-r', lockFile,
      '-d', paths.content,
      '--no-deps',
      '--require-hashes',
      '--disable-pip-version-check',
    ];
    const r = await run(py.exe, args, { timeoutMs: LONG_TIMEOUT_MS });
    if (r.code !== 0) throw new Error(`pip download ${name}: ${r.err || r.out}`);

    const wheels = fs.readdirSync(paths.content).filter((f) => f.endsWith('.whl')).sort();
    if (wheels.length !== p.expectedCount) {
      throw new Error(`wheelhouse ${name}: expectedCount ${p.expectedCount} but downloaded ${wheels.length} wheel(s)`);
    }
    const map = {};
    for (const w of wheels) {
      map[w] = await sha256File(path.join(paths.content, w));
      await harvestLicensesFromWheel(path.join(paths.content, w), paths.licenses, name);
    }
    meta = { ...want, wheels: map, collectedAt: new Date().toISOString() };
    writeMeta(paths.meta, meta);
  }

  const wheelNames = Object.keys(meta.wheels ?? {}).sort();
  if (wheelNames.length !== p.expectedCount) {
    throw new Error(`wheelhouse ${name}: expectedCount ${p.expectedCount} but cache holds ${wheelNames.length} wheel(s)`);
  }
  const licenseFiles = publishLicenses(paths.licenses, licensesDir);
  return { content: paths.content, wheels: meta.wheels, licenseFiles, hit };
}

// ---------------------------------------------------------------------------
// collect()
// ---------------------------------------------------------------------------

export async function collect({
  lock,
  cacheDir,
  stageDir,
  nodeDir,
  log = () => {},
  skipDownload = false,
  noCache = false,
  // Injection points for the unit tests: every child process and every byte
  // off the network goes through exactly one of these two.
  run = defaultRun,
  download = defaultDownload,
}) {
  // Guard: stageDir is wiped (rmSync below) at the start of every collect()
  // run, and cacheDir exists precisely to survive across runs (downloads,
  // npm cache, git clones, wheels). If cacheDir were nested inside stageDir,
  // the very next collect() call would delete the cache it depends on. Equal
  // paths are deliberately NOT rejected here (some unit tests reuse one tmp
  // dir for both) -- only cacheDir being a strict subdirectory of stageDir is.
  const resolvedCache = path.resolve(cacheDir);
  const resolvedStage = path.resolve(stageDir);
  // Case-insensitive: Windows paths are case-insensitive, so cacheDir nested
  // under stageDir with different casing (e.g. .../Stage/cache vs
  // .../stage/Cache) must still be caught.
  if (resolvedCache.toLowerCase().startsWith(resolvedStage.toLowerCase() + path.sep)) {
    throw new Error('cacheDir must not be inside stageDir');
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  const payloadDir = path.join(stageDir, 'payload');
  fs.mkdirSync(payloadDir, { recursive: true });
  // Every part's own licence text lands here; Task 20's hand-written files in
  // payload-src/policy/licenses/ are copied in by pack() (T08), not here.
  const licensesDir = path.join(payloadDir, 'policy', 'licenses');
  fs.mkdirSync(licensesDir, { recursive: true });

  const { nodeExe, npmCli, nodeDir: resolvedNodeDir } = await resolveNode({ lock, cacheDir, stageDir, nodeDir, log, skipDownload, download });
  const npmEnv = { ...process.env, npm_config_cache: path.join(cacheDir, 'npm-cache') };

  const skipped = [];
  const partsMeta = {};
  let faceVersion = null;

  const note = (name, p, version, state) => {
    log(`${name} ${p.kind} ${version ?? '-'} -> ${p.dest ?? '-'} [${state}]`);
  };

  for (const [name, p] of Object.entries(lock.parts)) {
    // redistribute:'download' wins over kind: whatever the part is made of, it
    // is NOT collected and NOT bundled -- the installer fetches it on the
    // user's PC at install time. `claude` (proprietary) and `document-skills`
    // (source-available but explicitly non-redistributable) are the two.
    // Nothing here opens a socket for them, not even to check a hash.
    if (p.redistribute === 'download') {
      skipped.push(name);
      partsMeta[name] = {
        kind: p.kind,
        version: p.version ?? null,
        dest: p.dest ?? null,
        file: p.file ?? null,
        license: p.license ?? null,
        licenseNotice: p.licenseNotice ?? null,
        licenseFiles: [],
        redistribute: 'download',
        download: {
          url: p.url ?? null,
          manifestUrl: p.manifestUrl ?? null,
          sha256: p.sha256 ?? null,
          repo: p.repo ?? null,
          commit: p.commit ?? null,
          include: p.include ?? null,
          subdir: p.subdir ?? null,
          binName: p.binName ?? null,
          fallback: p.fallback ?? null,
        },
      };
      note(name, p, p.version, 'download at install (not bundled)');
      continue;
    }

    const isDirDest = String(p.file ?? '').endsWith('/');
    const dest = path.join(payloadDir, p.file);
    if (isDirDest) fs.mkdirSync(dest, { recursive: true });
    else fs.mkdirSync(path.dirname(dest), { recursive: true });

    const base = {
      kind: p.kind,
      version: p.version ?? null,
      dest: p.dest ?? null,
      file: p.file ?? null,
      license: p.license ?? null,
      licenseNotice: p.licenseNotice ?? null,
      redistribute: p.redistribute ?? 'bundle',
      licenseFiles: [],
    };

    if (p.kind === 'url') {
      const { cached, hit } = await ensureCached(name, p, cacheDir, log, skipDownload, download, noCache);
      fs.copyFileSync(cached, dest);
      // Two `url` parts (uv, pyyaml) are single wheels, whose licence lives at
      // <pkg>.dist-info/licenses/LICENSE -- three segments deep, so the
      // top-level scan below would miss it.
      const licenseFiles = /\.whl$/i.test(cached)
        ? await harvestLicensesFromWheel(cached, licensesDir, name)
        : await harvestLicensesFromArchive(cached, licensesDir, name);
      partsMeta[name] = { ...base, sha256: p.sha256, url: p.url, licenseFiles };
      note(name, p, p.version, hit ? 'cache hit' : 'downloaded');
    } else if (p.kind === 'npm-prefix') {
      const r = await collectNpmPrefix({ name, p, cacheDir, log, noCache, skipDownload, run, nodeExe, npmCli, npmEnv, licensesDir });
      await zipDir(r.content, dest, log);
      partsMeta[name] = {
        ...base,
        npm: p.npm,
        integrity: p.integrity ?? null,
        packageLockSha256: r.packageLockSha256,
        licenseFiles: r.licenseFiles,
      };
      note(name, p, p.version, r.hit ? 'cache hit' : 'downloaded');
    } else if (p.kind === 'git') {
      const r = await collectGit({ name, p, cacheDir, log, noCache, skipDownload, run, licensesDir });
      await zipDir(r.content, dest, log);
      partsMeta[name] = {
        ...base,
        repo: p.repo,
        commit: p.commit,
        tag: p.tag ?? null,
        treeHash: r.treeHash,
        licenseFiles: r.licenseFiles,
      };
      note(name, p, p.version ?? p.tag ?? p.commit.slice(0, 7), r.hit ? 'cache hit' : 'downloaded');
    } else if (p.kind === 'wheelhouse') {
      const r = await collectWheelhouse({ name, p, cacheDir, log, noCache, skipDownload, run, licensesDir });
      for (const w of Object.keys(r.wheels).sort()) fs.copyFileSync(path.join(r.content, w), path.join(dest, w));
      partsMeta[name] = {
        ...base,
        requirementsLock: p.requirementsLock,
        sha256: p.sha256,
        platform: p.platform,
        pythonTag: p.pythonTag,
        wheelCount: Object.keys(r.wheels).length,
        wheels: r.wheels,
        venv: p.venv ?? null,
        licenseFiles: r.licenseFiles,
      };
      note(name, p, `${Object.keys(r.wheels).length} wheels`, r.hit ? 'cache hit' : 'downloaded');
    } else if (p.kind === 'dir') {
      const work = path.join(stageDir, 'dir', name);
      const source = partSource(name, p);
      if (!fs.existsSync(source)) throw new Error(`dir part ${name}: source not found: ${source}`);
      if (p.include) copySelected(source, work, p.include, p.exclude ?? []);
      else copyTree(source, work, p.exclude ?? []);
      if (p.redact) applyRedactions(work, p.redact, log);
      if (p.asciiRequired) assertAsciiPs1(work, name);
      if (p.npmCi) {
        // Not part-cached: a `dir` part's source is a live working tree that
        // can change between any two builds, so there is no lock value to key
        // a slot on (the other kinds all have one: a commit, an integrity, a
        // requirements digest).
        //
        // So this is the one kind whose offline path is "try the cache, then
        // give up" rather than "refuse before starting" (T07 review round 1,
        // finding 1). The deliberate choice, and why:
        //
        //   * `npm ci --offline` is a genuine cache-only path -- npm
        //     guarantees it never opens a socket, it just fails if its own
        //     cache (_build\cache\npm-cache, populated by the first build)
        //     cannot satisfy package-lock.json. Refusing outright instead
        //     would break the offline rebuild that actually works today
        //     (measured 2026-09-15: face's npm ci passes from cache alone).
        //   * But a FAILED --offline run means exactly one thing: the only way
        //     to finish is the network. That is the moment the centralized
        //     guard has to speak, so the failure a caller sees is the same
        //     `offline: <what>` contract every other kind throws -- not an
        //     npm error message they would have to decode.
        //
        // assertOnline() is a no-op when the flag is not set, so a plain
        // --skip-download failure still surfaces npm's own message below.
        const offline = isOffline() || skipDownload;
        const r = await run(nodeExe, [npmCli, 'ci', '--no-fund', '--no-audit', ...(offline ? ['--offline'] : [])], { cwd: work, env: npmEnv, timeoutMs: LONG_TIMEOUT_MS });
        if (r.code !== 0) {
          assertOnline(`npm ci ${name} (npm cache cannot satisfy package-lock.json)`);
          throw new Error(`npm ci ${name}: ${r.err || r.out}`);
        }
      }
      if (name === 'face') {
        const pkgPath = path.join(work, 'package.json');
        if (fs.existsSync(pkgPath)) faceVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
      }
      const licenseFiles = harvestLicensesFrom(source, licensesDir, name);
      await zipDir(work, dest, log);
      partsMeta[name] = { ...base, version: name === 'face' ? faceVersion : base.version, source: p.source, licenseFiles };
      note(name, p, name === 'face' ? faceVersion : p.version, 'copied');
    } else if (p.kind === 'file') {
      const source = partSource(name, p);
      if (!fs.existsSync(source)) throw new Error(`file part ${name}: source not found: ${source}`);
      fs.copyFileSync(source, dest);
      // `redact` on a single-file part applies to that one staged file, so
      // its entries may omit `file` (there is only one). Used by
      // `ontology-spec`, whose source is this PC's live IRIS-온톨로지.md and
      // therefore carries real example IDs and an account handle (T08 ruling
      // 5). The source outside P03 is never touched.
      if (p.redact) {
        for (const entry of p.redact) {
          redactFile(entry.file ? path.join(path.dirname(dest), entry.file) : dest, entry, log, entry.file ?? p.file);
        }
      }
      partsMeta[name] = { ...base, source: p.source };
      note(name, p, p.version, 'copied');
    } else {
      throw new Error(`unknown part kind for ${name}: ${p.kind}`);
    }
  }

  // Hand partsMeta to pack() through the stage dir (T08). build/build.mjs is
  // the only caller and it does not pass partsMeta on to pack(), so this file
  // -- written at the stage ROOT, deliberately NOT inside payload\, so it
  // never travels into the zip -- is the bridge that lets pack() fold every
  // part's collection evidence (commit/treeHash/integrity/wheel digests/
  // licence list/download info) into payload\manifest.json without
  // recomputing any of it.
  fs.writeFileSync(path.join(stageDir, 'parts-meta.json'), `${JSON.stringify(partsMeta, null, 2)}\n`, 'utf8');

  return { payloadDir, faceVersion, skipped, partsMeta, nodeDir: resolvedNodeDir };
}
