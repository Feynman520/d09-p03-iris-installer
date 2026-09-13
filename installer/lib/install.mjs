import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../../lib/run.mjs';
import { extractZip } from '../../lib/zip.mjs';
import {
  newReceipt, readReceipt, writeReceipt, markStep, setInstalled,
} from './receipt.mjs';
import { writeShims, shimsDir } from './shims.mjs';
import { writeMinimalSoulState } from './soulstate.mjs';
import { portableTeamclaudeConfigDir, portableTeamclaudeConfigPath } from './login.mjs';
import * as userpathDefault from './userpath.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

// Fixed order (task-12-brief): the runtimes first because later parts are
// installed *with* them (claude is fetched by the bundled node+npm), then the
// agents, then the relay and the two apps, then the plain files.
export const PART_ORDER = [
  'node', 'python', 'pyyaml', 'git',
  'claude', 'codex', 'teamclaude', 'dash', 'face',
  'guides', 'manage',
];

export function toolsDir(root) {
  return path.join(root, '_agent', 'shared', 'tools');
}

// `dest`  = where the archive's contents are written.
// `slot`  = the single path that "is" this part on disk: what the skip check
//           looks for and what is moved aside as <slot>.prev on a version
//           change. For every part but pyyaml it is the same as `dest`;
//           pyyaml unpacks *into* the python part's site-packages, so only
//           its own `yaml` package may be moved aside -- never the whole
//           site-packages directory, which holds other parts' files.
// `strip` = tar --strip-components. Only node's archive has a wrapping
//           top-level folder (node-v24.17.0-win-x64/).
const LAYOUT = {
  node: { kind: 'archive', strip: 1, dest: (t) => path.join(t, 'node') },
  python: { kind: 'archive', strip: 0, dest: (t) => path.join(t, 'python'), after: 'python-pth' },
  pyyaml: {
    kind: 'archive',
    strip: 0,
    dest: (t) => path.join(t, 'python', 'Lib', 'site-packages'),
    slot: (t) => path.join(t, 'python', 'Lib', 'site-packages', 'yaml'),
  },
  git: { kind: 'archive', strip: 0, dest: (t) => path.join(t, 'git') },
  claude: { kind: 'npm-download', dest: (t) => path.join(t, 'claude') },
  codex: { kind: 'archive', strip: 0, dest: (t) => path.join(t, 'codex') },
  teamclaude: { kind: 'archive', strip: 0, dest: (t) => path.join(t, 'teamclaude') },
  // `teamclaude-dash`, not `dash`: Face's daemon/paths.mjs dashDir() looks for
  // <tools>\teamclaude-dash (docs/설계.md 2-2 layout) and hides the limits
  // drawer / skips the proxy start when it is not there.
  dash: { kind: 'archive', strip: 0, dest: (t) => path.join(t, 'teamclaude-dash') },
  face: { kind: 'archive', strip: 0, dest: (t) => path.join(t, 'face') },
  // docs/설계.md 2-2 + 4-1 ③: both guide editions live at <root>\_setup-guides,
  // not under _agent -- the agent is told to read them from there.
  guides: { kind: 'files', dest: (t, root) => path.join(root, '_setup-guides') },
  manage: { kind: 'file', dest: (t) => path.join(t, 'teamclaude', 'teamclaude-manage.ps1') },
};

function relToRoot(root, abs) {
  return path.relative(root, abs).split(path.sep).join('\\');
}

// ---------------------------------------------------------------------------
// versions / skip identity
// ---------------------------------------------------------------------------

// guides is a glob part: the manifest keys it as `guides:<basename>`, so its
// identity is the package-wide guideVersion rather than a per-part version.
export function expectedIdentity(name, manifest, lock) {
  if (name === 'guides') {
    return {
      version: manifest?.package?.guideVersion ?? lock?.package?.guideVersion ?? null,
      sha256: null,
    };
  }
  const mf = manifest?.parts?.[name];
  return {
    version: mf?.version ?? lock?.parts?.[name]?.version ?? null,
    sha256: mf?.sha256 ?? null,
  };
}

function guideFiles(payloadDir) {
  const dir = path.join(payloadDir, 'guides');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => path.join(dir, f));
}

// ---------------------------------------------------------------------------
// pre-install path checks (deferred from Task 11 -- these need the real
// target path, which only exists once the name step has run)
// ---------------------------------------------------------------------------

// Both probes deliberately avoid fsutil.exe, which the brief suggested and
// which measurement on a normal (unelevated) account rules out: `fsutil
// fsinfo volumeinfo C:` answers "Access denied" there, and -- worse -- fsutil
// exits with code 0 even when it prints that error, so an exit-code test
// silently reads "access denied" as "yes, reparse point" / "not NTFS"
// (measured 2026-09-11: the first rehearsal aborted with a bogus `not-ntfs`).
// The installer is explicitly designed to run without admin rights, so both
// checks use primitives that need none:
//   - reparse point: libuv reports a Windows directory *junction* as a
//     symlink, so lstat covers both junctions and symlinks (measured on a
//     real junction: isSymbolicLink() === true; plain directory === false).
//   - file system: System.IO.DriveInfo.DriveFormat, readable by any user.
export const defaultFsutil = {
  isReparsePoint: async (p) => {
    try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
  },
  volumeFileSystem: async (drive) => {
    const root = drive.endsWith('\\') ? drive : `${drive}\\`;
    const r = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(New-Object System.IO.DriveInfo '${root}').DriveFormat`,
    ], { timeoutMs: 20000 });
    return r.code === 0 && r.out ? r.out.trim() : 'unknown';
  },
};

// Refusals, in order: a *file* at the soul path (extracting into it would
// fail halfway and leave a mess), a reparse point (junction/symlink -- the
// install would silently land somewhere else, possibly on a network or
// non-NTFS volume), and a non-NTFS volume (no alternate data streams, so no
// MOTW handling, and no reliable long-path/ACL behaviour).
export async function checkRootPath(root, fsutil = defaultFsutil) {
  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory()) return { ok: false, reason: 'root-is-file' };
    if (await fsutil.isReparsePoint(root)) return { ok: false, reason: 'root-reparse' };
  }
  const drive = root.slice(0, 2);
  const fsName = await fsutil.volumeFileSystem(drive);
  if (!/NTFS/i.test(fsName)) return { ok: false, reason: 'not-ntfs' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// MOTW
// ---------------------------------------------------------------------------

// Deleting the :Zone.Identifier alternate data stream is exactly what
// Unblock-File does, and needs no admin rights. Without it the first run of
// electron.exe / node.exe out of a downloaded zip trips SmartScreen.
// fs.rmSync(force) on a file that has no such stream is a no-op, so this can
// be called blindly on every extracted file.
export function stripMotw(target) {
  let stat;
  try { stat = fs.statSync(target); } catch { return 0; }
  if (stat.isFile()) {
    try { fs.rmSync(`${target}:Zone.Identifier`, { force: true }); } catch { /* not NTFS / no stream */ }
    return 1;
  }
  if (!stat.isDirectory()) return 0;
  let n = 0;
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try { fs.rmSync(`${p}:Zone.Identifier`, { force: true }); n += 1; } catch { /* ignore */ }
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// never delete: move aside instead
// ---------------------------------------------------------------------------

// The installer's global rule is that it removes nothing the user might
// still want. A part being replaced is renamed to <slot>.prev; if that name
// is taken (a third install), .prev-2, .prev-3, ... are used, so no earlier
// copy is ever clobbered either.
export function preserveAside(slot) {
  if (!fs.existsSync(slot)) return null;
  let candidate = `${slot}.prev`;
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = `${slot}.prev-${n}`;
    n += 1;
  }
  fs.renameSync(slot, candidate);
  return candidate;
}

// The undo half of preserveAside, run when a part fails after its old copy
// was already moved aside (fix round 1 finding 1). Without it a re-install
// that dies mid-part -- the realistic case being `claude` on a machine whose
// network blocks the npm registry -- left the soul with `claude.prev` and no
// `claude` at all, so the shim pointed at nothing and the previously working
// install was worse off than if the user had never re-run the installer.
//
// Whatever sits at `slot` when this runs is this run's own half-written
// output: the slot was either empty to begin with or renamed out of the way
// by preserveAside before the attempt started. Clearing it is therefore
// never a deletion of user data -- it is the only way to give the backup its
// real name back -- and it is the single exception to the installer's
// never-delete rule. If the clear fails (a file still locked by a crashed
// child), the backup is deliberately left under its .prev name rather than
// risking a half-merged directory.
export function restorePart(slot, moved) {
  const result = { clearedPartial: false, restored: false };
  if (fs.existsSync(slot)) {
    try {
      fs.rmSync(slot, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      result.clearedPartial = true;
    } catch {
      return result; // slot still occupied -> do not clobber it with the backup
    }
  }
  if (moved && fs.existsSync(moved) && !fs.existsSync(slot)) {
    try {
      fs.renameSync(moved, slot);
      result.restored = true;
    } catch { /* backup stays under .prev; reported in the receipt */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// python embeddable: enable site-packages so PyYAML is importable
// ---------------------------------------------------------------------------

// The embeddable distribution ships a `pythonNNN._pth` whose presence puts
// the interpreter in isolated mode: sys.path is exactly the lines of that
// file and `site` is not imported, so `Lib\site-packages` is invisible no
// matter what is unpacked there. Adding the directory plus `import site` is
// the documented way to make an embeddable install accept wheels.
function ensurePythonPth(pythonDir) {
  const pth = fs.readdirSync(pythonDir).find((f) => /^python\d+\._pth$/.test(f));
  if (!pth) return { changed: false, file: null };
  const file = path.join(pythonDir, pth);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  let changed = false;
  if (!lines.some((l) => l.trim().toLowerCase() === 'lib\\site-packages')) {
    const dot = lines.findIndex((l) => l.trim() === '.');
    lines.splice(dot === -1 ? lines.length : dot + 1, 0, 'Lib\\site-packages');
    changed = true;
  }
  if (!lines.some((l) => l.trim() === 'import site')) {
    const commented = lines.findIndex((l) => l.trim() === '#import site');
    if (commented === -1) lines.push('import site');
    else lines[commented] = 'import site';
    changed = true;
  }
  if (changed) fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  return { changed, file };
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

const COMSPEC = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

// Node 24 refuses to spawn a .cmd without a shell (the CVE-2024-27980 fix),
// and going through `shell: true` would re-quote the arguments. So the npm
// wrappers are invoked through cmd.exe with a hand-built, verbatim command
// line: `cmd /d /s /c ""<path with spaces>" --version"` -- /s makes cmd strip
// exactly the outer quote pair, leaving a correctly quoted inner command.
function runWrapper(cmdPath, args, { extraPath, extraEnv, timeoutMs = 120000 } = {}) {
  const line = `""${cmdPath}" ${args.join(' ')}"`;
  const env = { ...process.env, ...extraEnv };
  if (extraPath) env.PATH = `${extraPath};${env.PATH ?? ''}`;
  return new Promise((resolve) => {
    const c = spawn(COMSPEC, ['/d', '/s', '/c', line], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => c.kill(), timeoutMs);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: e.message }); });
  });
}

function resolvePatchRules(zipRoot, explicit) {
  const candidates = [
    explicit,
    zipRoot ? path.join(zipRoot, 'installer', 'patches', 'teamclaude', 'rules.json') : null,
    path.resolve(HERE, '..', '..', 'patches', 'teamclaude', 'rules.json'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

// The marker the build's patcher leaves behind. Every IRIS-authored
// replacement carries it in a comment ("local patch ... IRIS" / "(... IRIS)");
// a few rules only change upstream signatures and carry no marker, and for
// those the first replacement's own text is the evidence instead.
const PATCH_MARKER = 'IRIS';

function verifyTeamclaudePatches(tcDir, rulesFile) {
  if (!fs.existsSync(path.join(tcDir, 'node_modules', '@karpeleslab', 'teamclaude', 'src', 'index.js'))) {
    return { ok: false, detail: 'teamclaude src/index.js missing' };
  }
  if (!rulesFile) return { ok: false, detail: 'patch rules.json not found next to the installer' };
  let rules;
  try { rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8')); } catch (e) {
    return { ok: false, detail: `patch rules.json unreadable: ${e.message}` };
  }
  const missing = [];
  const unpatched = [];
  const bySnippet = [];
  for (const entry of rules.files ?? []) {
    const abs = path.join(tcDir, entry.path.split('/').join(path.sep));
    if (!fs.existsSync(abs)) { missing.push(entry.path); continue; }
    const text = fs.readFileSync(abs, 'utf8');

    // Two rule shapes (build/patch-teamclaude.mjs): `create` writes a whole
    // new file verbatim -- so byte equality is both available and the
    // strongest possible check -- while `replace` splices snippets into an
    // upstream file.
    if (entry.create !== undefined) {
      if (text !== entry.create) unpatched.push(entry.path);
      else bySnippet.push(entry.path);
      continue;
    }

    const replacements = entry.replace ?? [];
    const marked = replacements.some((r) => (r.with ?? '').includes(PATCH_MARKER));
    if (marked) {
      if (!text.includes(PATCH_MARKER)) unpatched.push(entry.path);
    } else {
      // No IRIS marker in this file's replacements -- check that the first
      // replacement's produced text is actually present instead.
      const first = replacements[0]?.with;
      if (!first || !text.includes(first)) unpatched.push(entry.path);
      else bySnippet.push(entry.path);
    }
  }
  if (missing.length || unpatched.length) {
    return { ok: false, detail: `missing=${missing.join(',') || '-'} unpatched=${unpatched.join(',') || '-'}` };
  }
  return {
    ok: true,
    detail: `${(rules.files ?? []).length} patched files verified (${bySnippet.length} by snippet)`,
    files: (rules.files ?? []).map((f) => path.basename(f.path)),
  };
}

function exists(...p) { return fs.existsSync(path.join(...p)); }

// defaultVerifiers({root, manifest, lock, zipRoot, patchRulesFile})
//   -> { [part]: async () => {ok, detail} }
// Each verifier proves the part actually *works* (or, where running it is
// unsafe/pointless during an install, that the files that matter are there
// and carry the right version).
export function defaultVerifiers({ root, manifest, lock, zipRoot, patchRulesFile } = {}) {
  const t = toolsDir(root);
  const nodeDir = path.join(t, 'node');
  const want = (name) => expectedIdentity(name, manifest, lock).version;

  const contains = (r, needle) => `${r.out}\n${r.err}`.includes(needle);

  return {
    node: async () => {
      const r = await run(path.join(nodeDir, 'node.exe'), ['-v'], { timeoutMs: 60000 });
      const v = `v${want('node')}`;
      return { ok: r.code === 0 && r.out.trim() === v, detail: r.out || r.err };
    },
    python: async () => {
      const r = await run(path.join(t, 'python', 'python.exe'), ['-V'], { timeoutMs: 60000 });
      return { ok: r.code === 0 && contains(r, want('python')), detail: r.out || r.err };
    },
    pyyaml: async () => {
      const r = await run(path.join(t, 'python', 'python.exe'), ['-c', 'import yaml; print(yaml.__version__)'], { timeoutMs: 60000 });
      return { ok: r.code === 0 && contains(r, want('pyyaml')), detail: r.out || r.err };
    },
    git: async () => {
      const r = await run(path.join(t, 'git', 'cmd', 'git.exe'), ['--version'], { timeoutMs: 60000 });
      // lock version is 2.54.0.windows.1; `git --version` prints 2.54.0.windows.1
      return { ok: r.code === 0 && contains(r, String(want('git')).split('.windows')[0]), detail: r.out || r.err };
    },
    // The version probes run with this soul's config dirs, exactly as the
    // shims will: a CLI asked for its version still reads (and can migrate or
    // scaffold) whatever CLAUDE_CONFIG_DIR / CODEX_HOME points at, and the
    // machine doing the installing may well have those pointing at another,
    // already-live soul. Pinning them here keeps the probe inside the soul
    // being installed. ANTHROPIC_BASE_URL is deliberately left exactly as the
    // installer inherited it -- never unset, never redirected.
    claude: async () => {
      const r = await runWrapper(path.join(t, 'claude', 'claude.cmd'), ['--version'], {
        extraPath: nodeDir, extraEnv: { CLAUDE_CONFIG_DIR: path.join(root, '_agent', 'claude') },
      });
      return { ok: r.code === 0 && contains(r, want('claude')), detail: r.out || r.err };
    },
    codex: async () => {
      const r = await runWrapper(path.join(t, 'codex', 'codex.cmd'), ['--version'], {
        extraPath: nodeDir, extraEnv: { CODEX_HOME: path.join(root, '_agent', 'codex') },
      });
      return { ok: r.code === 0 && contains(r, want('codex')), detail: r.out || r.err };
    },
    // File-based on purpose: starting the relay here would bind port 3456 on
    // a machine that may already have one running, and it has nothing to
    // route until the login step anyway.
    teamclaude: async () => verifyTeamclaudePatches(path.join(t, 'teamclaude'), resolvePatchRules(zipRoot, patchRulesFile)),
    dash: async () => {
      const d = path.join(t, 'teamclaude-dash');
      const need = ['dashboard.html', 'launch.mjs', 'server.mjs', 'ensure-proxy.mjs', 'ensure-dash.mjs'];
      const gone = need.filter((f) => !exists(d, f));
      return { ok: gone.length === 0, detail: gone.length ? `missing ${gone.join(',')}` : need.join(',') };
    },
    face: async () => {
      const pkg = path.join(t, 'face', 'package.json');
      if (!fs.existsSync(pkg)) return { ok: false, detail: 'package.json missing' };
      const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
      const wanted = want('face');
      // The manifest is the authority (build/collect.mjs records the version
      // it read out of the shipped package.json). A manifest with no face
      // version is a broken build, not a pass: without it there is nothing to
      // check the shipped package.json against, and "the file exists" is not
      // verification (fix round 1 finding 4).
      if (wanted == null) {
        return { ok: false, detail: `manifest carries no face version (shipped package.json=${version}) -- cannot verify` };
      }
      return { ok: version === wanted, detail: `package.json=${version} manifest=${wanted}` };
    },
    guides: async () => {
      const dir = path.join(root, '_setup-guides');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')) : [];
      const min = lock?.parts?.guides?.minCount ?? 2;
      return { ok: files.length >= min, detail: `${files.length} guide file(s)` };
    },
    manage: async () => {
      const f = path.join(t, 'teamclaude', 'teamclaude-manage.ps1');
      return { ok: fs.existsSync(f), detail: f };
    },
  };
}

// ---------------------------------------------------------------------------
// claude: the one part that is fetched instead of shipped
// ---------------------------------------------------------------------------

// lock.json marks @anthropic-ai/claude-code `redistribute: "download"` -- its
// licence does not permit shipping it inside the zip, so it is installed from
// the npm registry at install time with the bundled node+npm, into the same
// global-prefix layout the bundled parts use. The cache is kept inside the
// soul so nothing is written to the user's %APPDATA%.
export const defaultNpmInstall = ({ nodeExe, npmCli, prefix, spec, cacheDir }) => run(
  nodeExe,
  [npmCli, 'install', '-g', '--prefix', prefix, spec, '--no-fund', '--no-audit'],
  { env: { ...process.env, npm_config_cache: cacheDir }, timeoutMs: 600000 },
);

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// install log
// ---------------------------------------------------------------------------

// docs/설계.md 3-3: "로그 = _agent\setup\package-install.log 하나(단계·시각·
// 결과, 비밀 없음)", and the receipt's `log` field already points at it.
// Deliberately narrow: ISO timestamp, part, status/pct, error CODE. Free-form
// `detail` (npm stderr, a CLI's --version output, a verifier message) is kept
// out of the log on purpose -- the receipt already carries it, and a log is
// the artefact most likely to be pasted into a bug report, so it gets only
// fields whose shape the installer controls.
export function installLogPath(root) {
  return path.join(root, '_agent', 'setup', 'package-install.log');
}

function makeLogger(root) {
  const file = installLogPath(root);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* logged nowhere, then */ }
  return (text) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${text}\r\n`, 'utf8');
    } catch { /* a log that cannot be written must never fail the install */ }
  };
}

function formatEvent(e) {
  const bits = [];
  bits.push(`part=${e.part ?? '-'}`);
  if (e.skipped) bits.push('status=skipped');
  else if (e.status) bits.push(`status=${e.status}`);
  if (typeof e.pct === 'number') bits.push(`pct=${e.pct}`);
  if (e.error) bits.push(`error=${e.error}`);
  if (e.done) bits.push('done=true');
  return bits.join(' ');
}

class InstallError extends Error {
  constructor(code, part, detail) {
    super(`${code}${part ? ` (${part})` : ''}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.part = part;
    this.detail = detail;
  }
}

/**
 * install({root, name, zipRoot, manifest, lock, choice, existing, onProgress, ...})
 *   -> Promise<Receipt>
 *
 * Unpacks every part in PART_ORDER into <root>\_agent\shared\tools, writes the
 * shims, the minimal soul-state, the user PATH/env entries and the receipt.
 * Nothing is ever deleted: a replaced part is moved to <name>.prev first.
 *
 * Stops at the first part that fails verification (the receipt records
 * verified:false for it) -- a half-installed runtime must not be papered over
 * by continuing with the next part.
 */
export async function install({
  root,
  name,
  zipRoot,
  manifest,
  lock,
  choice = { subscriptions: [], leadAgent: 'claude', guideEdition: 'claude' },
  existing = 'none',
  onProgress = () => {},
  verifiers,
  userpath = userpathDefault,
  fsutil = defaultFsutil,
  npmInstall = defaultNpmInstall,
  patchRulesFile,
} = {}) {
  // `log` only exists once the root is known to be safe to write to; until
  // then it is a no-op, so the path-safety refusal below writes nothing under
  // C:\ (global constraint).
  let log = () => {};
  // Both helpers contain listener errors: a screen that throws while
  // rendering progress must never take the install down with it. The terminal
  // (done:true) events go through emitFinal for exactly the same containment
  // -- they used to call onProgress bare (fix round 1 finding 5).
  const emit = (e) => {
    log(formatEvent(e));
    try { onProgress({ done: false, ...e }); } catch { /* listener errors never break the install */ }
  };
  const emitFinal = (e) => {
    log(formatEvent({ ...e, done: true }));
    try { onProgress({ ...e, done: true }); } catch { /* same containment as emit */ }
  };

  // --- 0. path safety, before anything under C:\ is touched ---------------
  const pathCheck = await checkRootPath(root, fsutil);
  if (!pathCheck.ok) {
    emitFinal({ part: 'root', error: pathCheck.reason });
    throw new InstallError(pathCheck.reason, 'root');
  }

  const payloadDir = path.join(zipRoot, 'payload');
  const tools = toolsDir(root);
  fs.mkdirSync(tools, { recursive: true });
  // Created up front, not at the env step: the claude/codex version probes
  // below already run with CLAUDE_CONFIG_DIR / CODEX_HOME pointed here.
  const claudeCfg = path.join(root, '_agent', 'claude');
  const codexHome = path.join(root, '_agent', 'codex');
  fs.mkdirSync(claudeCfg, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  // docs/설계.md 2-2 + 10 #4 (2026-09-12 final review I2): the soul's own
  // TeamClaude config lives here, so the relay's account list travels with
  // the soul folder. Created up front (next to the two config homes) because
  // the login step's very first spawn already points TEAMCLAUDE_CONFIG at it.
  const teamclaudeStateDir = portableTeamclaudeConfigDir(root);
  const teamclaudeConfig = portableTeamclaudeConfigPath(root);
  fs.mkdirSync(teamclaudeStateDir, { recursive: true });

  // --- 1. receipt ---------------------------------------------------------
  log = makeLogger(root);
  log(`install start root=${root} package=${manifest?.package?.version ?? '?'} parts=${PART_ORDER.length}`);

  const prior = readReceipt(root);
  const receipt = prior ?? newReceipt({
    root,
    name,
    manifest,
    createdBy: existing === 'soul' ? 'existing' : 'package-installer',
  });
  // Re-install over an older receipt: the package identity is whatever is
  // being installed *now*, so it is refreshed from this manifest, while
  // `installed` keeps its per-part history (that is what the skip check reads)
  // -- fix round 1 finding 7.
  const fresh = newReceipt({ root, name, manifest, createdBy: receipt.soul?.createdBy });
  receipt.package = fresh.package;
  receipt.soul = { root, name, createdBy: receipt.soul?.createdBy ?? 'package-installer' };
  receipt.choice = choice;
  markStep(receipt, 'precheck', 'done');
  markStep(receipt, 'name', 'done');
  markStep(receipt, 'choice', 'done');
  markStep(receipt, 'copy', 'running');
  writeReceipt(root, receipt);

  const verify = verifiers ?? defaultVerifiers({ root, manifest, lock, zipRoot, patchRulesFile });
  const activeAgents = [];
  if (choice.subscriptions?.includes('claude')) activeAgents.push('claude');
  if (choice.subscriptions?.includes('chatgpt')) activeAgents.push('codex');

  const parts = PART_ORDER.filter((p) => lock?.parts?.[p]);
  const total = parts.length;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const layout = LAYOUT[part];
    const lockPart = lock.parts[part];
    const want = expectedIdentity(part, manifest, lock);
    const dest = layout.dest(tools, root);
    const slot = layout.slot ? layout.slot(tools, root) : dest;
    const basePct = Math.floor((i / total) * 100);

    emit({ part, pct: basePct, status: 'running' });

    // --- skip when the very same version is already there -----------------
    const recorded = prior?.installed?.[part];
    const same = recorded
      && recorded.verified === true
      && recorded.version === want.version
      && (want.sha256 === null || recorded.sha256 === want.sha256);
    if (same && fs.existsSync(slot)) {
      emit({ part, pct: 100, skipped: true });
      continue;
    }

    // --- replace, never delete -------------------------------------------
    const moved = preserveAside(slot);

    try {
      if (layout.kind === 'archive') {
        const archive = path.join(payloadDir, (manifest?.parts?.[part]?.file ?? lockPart.file));
        if (!fs.existsSync(archive)) throw new InstallError('payload-missing', part, archive);
        fs.mkdirSync(dest, { recursive: true });
        await extractZip(archive, dest, { strip: layout.strip });
      } else if (layout.kind === 'file') {
        const src = path.join(payloadDir, (manifest?.parts?.[part]?.file ?? lockPart.file));
        if (!fs.existsSync(src)) throw new InstallError('payload-missing', part, src);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      } else if (layout.kind === 'files') {
        const files = guideFiles(payloadDir);
        if (files.length === 0) throw new InstallError('payload-missing', part, 'guides/');
        fs.mkdirSync(dest, { recursive: true });
        for (const f of files) fs.copyFileSync(f, path.join(dest, path.basename(f)));
      } else if (layout.kind === 'npm-download') {
        const nodeExe = path.join(tools, 'node', 'node.exe');
        const npmCli = path.join(tools, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
        const cacheDir = path.join(root, '_agent', 'runtime', 'host', 'npm-cache');
        fs.mkdirSync(dest, { recursive: true });
        fs.mkdirSync(cacheDir, { recursive: true });
        const r = await npmInstall({
          nodeExe, npmCli, prefix: dest, cacheDir,
          spec: `${lockPart.npm}@${lockPart.version}`,
        });
        if (r.code !== 0) throw new InstallError('npm-unreachable', part, (r.err || r.out || '').slice(0, 300));
      }

      if (layout.after === 'python-pth') ensurePythonPth(dest);

      // MOTW: on the part's own slot for a normal part; on each copied file
      // for the glob/file parts.
      if (layout.kind === 'files') {
        for (const f of fs.readdirSync(dest)) stripMotw(path.join(dest, f));
      } else {
        stripMotw(slot);
      }

      emit({ part, pct: Math.floor(((i + 0.7) / total) * 100), status: 'verifying' });

      const verifier = verify[part];
      const result = verifier ? await verifier() : { ok: true, detail: 'no verifier' };

      const info = {
        version: want.version,
        path: relToRoot(root, dest),
        sha256: want.sha256,
        verified: !!result.ok,
        detail: result.detail ?? null,
      };
      if (part === 'claude' || part === 'codex') {
        info.active = activeAgents.includes(part);
        info.source = part === 'claude' ? 'npm-registry' : 'bundled';
      }
      if (part === 'teamclaude' && result.files) info.patches = result.files;
      if (moved) info.previous = relToRoot(root, moved);
      setInstalled(receipt, part, info);
      writeReceipt(root, receipt);

      if (!result.ok) {
        // Verification failing means the new copy is *there* but wrong, so
        // the old one deliberately stays under .prev (already recorded in
        // `info.previous` above) rather than being swapped back over it --
        // that is a decision for the user, with both copies on disk.
        markStep(receipt, 'copy', 'error');
        writeReceipt(root, receipt);
        emitFinal({ part, error: 'verify-failed', detail: result.detail ?? null });
        throw new InstallError('verify-failed', part, result.detail);
      }

      emit({ part, pct: Math.floor(((i + 1) / total) * 100), status: 'done' });
    } catch (err) {
      if (err instanceof InstallError && err.code === 'verify-failed') throw err; // already recorded above

      // The part never got far enough to produce a usable copy (payload
      // missing, extraction died, npm unreachable): put the previous install
      // back so a failed re-install leaves the soul exactly as it was.
      const restore = restorePart(slot, moved);
      const code = err instanceof InstallError ? err.code : 'install-failed';
      const detail = err instanceof InstallError ? (err.detail ?? null) : String(err?.message ?? err);

      setInstalled(receipt, part, {
        version: want.version,
        path: relToRoot(root, dest),
        sha256: want.sha256,
        verified: false,
        detail,
        // Always recorded on the error path (fix round 1 finding 1): the path
        // of a backup that still exists on disk, or null once it has been put
        // back under its real name. `priorRestored` says which of those
        // happened, and `priorExisted` distinguishes "restored" from "there
        // was nothing to restore" (a first install).
        previous: restore.restored ? null : (moved ? relToRoot(root, moved) : null),
        priorExisted: moved !== null,
        priorRestored: restore.restored,
      });
      markStep(receipt, 'copy', 'error');
      writeReceipt(root, receipt);
      log(`part=${part} rollback priorExisted=${moved !== null} restored=${restore.restored} clearedPartial=${restore.clearedPartial}`);
      emitFinal({ part, error: code, detail });
      throw err;
    }
  }

  // --- 2. shims -----------------------------------------------------------
  const shims = writeShims(root, activeAgents);
  emit({ part: 'shims', pct: 100, status: 'done' });

  // --- 3. minimal soul-state (never over an existing one) -----------------
  const soul = writeMinimalSoulState(root, { edition: choice.guideEdition ?? 'claude', name });
  emit({ part: 'soul-state', pct: 100, status: soul.written ? 'done' : 'skipped', skipped: !soul.written });

  // --- 4. user PATH + env -------------------------------------------------
  const env = {
    CLAUDE_CONFIG_DIR: claudeCfg,
    CODEX_HOME: codexHome,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',
    TEAMCLAUDE_CONFIG: teamclaudeConfig,
    pathShim: shims.dir,
    // Same value under the name the rest of the installer reads it by
    // (server.mjs's login route, login.mjs's resolveTeamclaudeConfigPath):
    // the receipt is the authority for which config file this soul uses.
    teamclaudeConfig,
    previous: {},
    // `applied` says whether these values were actually written to
    // HKCU\Environment or only recorded here (fix round 1 finding 3). The
    // installer's --no-user-env rehearsal switch injects a recording
    // `userpath`, and without this field the receipt of such a run is
    // indistinguishable from a real install -- the setting-up agent is told by
    // the guide to *verify* these values, and with applied:false it knows they
    // are not there to verify yet.
    applied: userpath?.recording !== true,
  };
  if (env.applied === false) env.skippedReason = userpath?.skippedReason ?? 'no-user-env';
  // The *previous* full Path is deliberately not recorded: it is the user's
  // own machine layout (personal folder names), the receipt is a file the
  // agent reads and quotes, and removeUserPath re-reads the live value
  // anyway. Only a per-variable previous value is kept, and only when the
  // variable already existed pointing somewhere else.
  const pathResult = await userpath.addUserPath(shims.dir);
  env.pathAdded = pathResult.changed;
  for (const [key, value] of [
    ['CLAUDE_CONFIG_DIR', claudeCfg],
    ['CODEX_HOME', codexHome],
    ['ANTHROPIC_BASE_URL', 'http://127.0.0.1:3456'],
    ['TEAMCLAUDE_CONFIG', teamclaudeConfig],
  ]) {
    const r = await userpath.setUserEnv(key, value);
    if (r.previous != null) env.previous[key] = r.previous;
  }
  receipt.env = env;
  emit({ part: 'env', pct: 100, status: 'done' });

  // --- 5. done ------------------------------------------------------------
  markStep(receipt, 'copy', 'done');
  writeReceipt(root, receipt);
  log('install done steps.copy=done');
  emitFinal({ pct: 100 });
  return receipt;
}
