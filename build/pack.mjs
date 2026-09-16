import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../lib/manifest.mjs';
import { zipDir } from '../lib/zip.mjs';
import { sanitize } from './sanitize.mjs';
import { loadRules } from './rules.mjs';

// Project root (one level up from build/), independent of process.cwd() --
// same convention as build/collect.mjs's ROOT_DIR. installer/ and
// payload-src/ are static source folders that live in the repo, not something
// collect() stages, so pack() needs its own fixed anchor to find them when a
// caller doesn't pass them explicitly.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INSTALLER_DIR = path.join(ROOT_DIR, 'installer');
const DEFAULT_PAYLOAD_SRC_DIR = path.join(ROOT_DIR, 'payload-src');
// payload\setup\presets.json is the SAME file the installer UI reads as
// installer\ui\presets.json -- one source, two places (설계 3-1). It is
// copied rather than duplicated in the repo so the ④ folder-preset screen and
// the setup engine can never disagree about what a preset tree looks like.
const DEFAULT_PRESETS_FILE = path.join(ROOT_DIR, 'installer', 'ui', 'presets.json');
// The TeamClaude patch rules travel *inside* the zip (as
// installer\patches\teamclaude\rules.json) because the installer verifies
// the relay by checking that every file rules.json names is present and
// actually patched (installer/lib/install.mjs verifyTeamclaudePatches).
// Without this the check has no list to verify against on the user's PC.
//
// Exactly this one file, not the whole patches/ tree: the only other thing
// in there is teamclaude-manage.ps1, which already ships as the `manage`
// part of the payload and would otherwise be in the zip twice (fix round 1
// finding 6).
const PATCH_RULES_REL = path.join('patches', 'teamclaude', 'rules.json');
const DEFAULT_PATCH_RULES_FILE = path.join(ROOT_DIR, PATCH_RULES_REL);
const CMD_NAME = 'IRIS-설치.cmd';
// 설계 4-1: the SAC two-ways notice sits at the zip root under a name the
// person reads without opening anything, and is the SAME text the homepage
// shows -- one source (payload-src/policy/install-notice.txt), two places.
const NOTICE_NAME = '설치가 안 되면.txt';
const NOTICE_SRC_REL = path.join('policy', 'install-notice.txt');

// (2026-09-12 final review C1) The installer's own modules import shared
// helpers from the repo root's lib/ as `../../lib/<file>.mjs`
// (installer/lib/install.mjs, login.mjs, precheck.mjs, userpath.mjs,
// handoff.mjs) -- which, from inside the zip, resolves to <zipRoot>\lib\.
// Before this the zip shipped only IRIS-설치.cmd + installer/ + payload/, so
// server.mjs died with ERR_MODULE_NOT_FOUND on the user's PC and
// bootstrap.ps1 timed out with exit 13.
//
// Kept to exactly the files the installer needs, not the whole lib/ tree:
//   grep -rn "\.\./\.\./lib/" installer/ --include="*.mjs" | grep -v ".test."
//     -> run.mjs, zip.mjs, net.mjs
//   (zip.mjs itself imports ./run.mjs; net.mjs has no further imports of its
//   own; nothing else is reachable)
// glob.mjs / manifest.mjs are build- and verify-side only. Re-run that grep
// whenever installer/ grows a new import and extend this list.
// (2026-09-15, Task 9) net.mjs added: installer/lib/{install,online,precheck}.mjs
// all import assertOnline/isOffline from it for the network-0 proof -- it was
// missing from this list even for precheck.mjs's PRE-EXISTING import, a gap
// masked until now by static.mjs's check 9 running against a stale zip.
const LIB_FILES = ['run.mjs', 'zip.mjs', 'net.mjs'];
const DEFAULT_LIB_DIR = path.join(ROOT_DIR, 'lib');
// (C2) installer/server.mjs's readLock() looks for <zipRoot>\lock.json first;
// without it every POST /api/install answered 500 payload_unreadable.
const DEFAULT_LOCK_FILE = path.join(ROOT_DIR, 'lock.json');

// installer\ travels wholesale except for two kinds of file that exist only
// for development (T08):
//   ui/mock-server.mjs  -- the screen-only fake backend (it also carries
//                          dev-PC example paths, which the gate flags)
//   *.test.*            -- any unit test that ends up under installer/
const INSTALLER_EXCLUDE_RELS = new Set(['ui/mock-server.mjs']);
const TEST_FILE_RE = /\.test\.[^.\\/]+$/i;

// payload-src\policy\* all ships as payload\policy\* EXCEPT the folder's own
// README, which is a note to us (what these templates are, how to edit them)
// and means nothing on a user's PC. payload-src\policy\licenses\README.md is
// NOT excluded -- that one explains the licence folder to the user.
const POLICY_EXCLUDE_RELS = new Set(['README.md']);

// (2026-09-12 final review I4) Per-part license notices, generated from
// lock.json so the shipped list can never drift from what was actually
// packed. Lands at payload/policy/licenses/NOTICES.md -- next to the licence
// texts collect() harvests, which is the folder 설계 3-1 reserves for exactly
// this ("policy\ ... 부품별 허가서").
function partSource(p) {
  if (p.url) return p.url;
  if (p.repo) return p.repo;
  if (p.npm) return `https://www.npmjs.com/package/${p.npm}`;
  return 'IRIS 패키지 자체 (this package)';
}

// A part's version for the notice table. lock.json is the authority where it
// carries one; `guides` is versioned package-wide (lock.package.guideVersion,
// the same single source of truth buildManifest uses); `face` has no lock
// version at all -- collect() reads it out of the shipped package.json, so
// the manifest is the only place it exists. Anything else is honestly "-"
// rather than a wrong number.
function partVersion(lock, manifest, name, p) {
  if (p.version) return p.version;
  if (name === 'guides') return lock?.package?.guideVersion ?? '-';
  return manifest?.parts?.[name]?.version ?? '-';
}

export function renderNotices(lock, manifest) {
  const lines = [];
  lines.push('# 부품 허가서 목록 (Third-party notices)');
  lines.push('');
  lines.push('이 목록은 빌드할 때 `lock.json`에서 자동으로 만들어집니다 (손으로 고치지 마세요).');
  lines.push('This file is generated from `lock.json` at build time. Do not edit by hand.');
  lines.push('');
  lines.push(`- 패키지 / package: IRIS ${lock?.package?.version ?? '?'}`);
  lines.push('- IRIS 자체 코드 / IRIS\'s own code: MIT (see the repository\'s LICENSE file)');
  lines.push('');
  lines.push('| 부품 (part) | 버전 (version) | 허가서 (license) | 출처 (source) |');
  lines.push('| --- | --- | --- | --- |');
  for (const [name, p] of Object.entries(lock?.parts ?? {})) {
    const version = partVersion(lock, manifest, name, p);
    const license = p.license ?? '(미기재 / not stated in lock.json)';
    lines.push(`| ${name} | ${version} | ${license} | ${partSource(p)} |`);
  }
  lines.push('');
  const notices = Object.entries(lock?.parts ?? {}).filter(([, p]) => p.licenseNotice);
  if (notices.length > 0) {
    for (const [name, p] of notices) lines.push(`> **${name}**: ${p.licenseNotice}`);
    lines.push('');
  }
  const downloaded = Object.entries(lock?.parts ?? {})
    .filter(([, p]) => p.redistribute === 'download')
    .map(([name]) => name);
  if (downloaded.length > 0) {
    lines.push(
      `> ${downloaded.join(', ')}: 이 패키지에 **들어 있지 않습니다**. 재배포가 허용되지 않는 독점 소프트웨어라, `
      + '설치할 때 공식 배포처에서 내려받아 설치합니다 (설치 대상 PC의 네트워크로).',
    );
    lines.push('>');
    lines.push(
      `> ${downloaded.join(', ')}: NOT bundled in this package. It is proprietary and not redistributable, `
      + 'so the installer downloads it from the official registry at install time.',
    );
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const FIXTURES_README = `# setup\\fixtures\\ — 설치 중 자가 시험 재료

설치기가 ⑤ 단계에서 "정말 되는가"를 스스로 확인할 때 쓰는 **작은 시험 재료**가 들어가는 자리입니다.
아직 비어 있습니다 (자리만 잡아 둔 폴더).

- 여기 있는 파일은 **설치 결과물이 아닙니다.** 지워도 IRIS 동작에는 영향이 없습니다.
- 사용자가 만든 자료는 여기에 두지 마세요. 새 판을 설치하면 이 폴더는 통째로 갈립니다.
`;

// Every file under `dir`, as POSIX-style paths relative to `base`.
function listRel(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listRel(abs, base, out);
    else if (entry.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

function copyTree(src, dest, { skip } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      if (!skip) return true;
      const rel = path.relative(src, source);
      if (rel === '') return true;
      return !skip(rel.split(path.sep).join('/'), source);
    },
  });
}

// The repo's working tree and the packed zip must both ship .cmd/.ps1 with
// CRLF line endings (Windows batch/PowerShell convention) regardless of the
// git checkout that produced installerDir on the machine doing the build --
// .gitattributes' `eol=crlf` only re-hydrates CRLF on a fresh `git checkout`,
// not on files already sitting in a working tree from before the attribute
// took effect, and pack() must not depend on that checkout having happened
// correctly. Force it here so the zip is right independent of local git
// config/state.
const CRLF_EXTENSIONS = new Set(['.cmd', '.ps1']);

function forceCRLF(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  if (normalized !== text) fs.writeFileSync(filePath, normalized, 'utf8');
}

function forceCRLFTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) forceCRLFTree(p);
    else if (entry.isFile() && CRLF_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) forceCRLF(p);
  }
}

// ---------------------------------------------------------------------------
// payload\ additions that come from the repo, not from collect()
// ---------------------------------------------------------------------------

// 설계 3-1 puts three things in payload\ that no lock part produces, because
// their source is this repository itself:
//   payload\policy\*          Task 20's templates + the policy summary
//   payload\setup\presets.json  the ④ screen's preset trees
//   payload\setup\fixtures\     a placeholder for install-time test material
// They are written into the STAGE payload (not straight into the zip root) so
// the stage dir and the zip stay byte-identical, and `verify/reproduce.mjs`
// -- which compares the two stage manifests -- sees exactly what shipped.
//
// Returns the list of payload-relative paths it added, so pack() can run the
// sanitize gate over precisely them (build/build.mjs's own pass ran before
// pack() was called, so these files would otherwise reach the zip ungated;
// verify/static.mjs ② is the only other thing that would catch them, and that
// is after a zip has already been written).
export function addRepoPayloadSources(payloadDir, {
  payloadSrcDir = DEFAULT_PAYLOAD_SRC_DIR,
  presetsFile = DEFAULT_PRESETS_FILE,
} = {}) {
  const added = [];

  const policySrc = path.join(payloadSrcDir, 'policy');
  if (fs.existsSync(policySrc)) {
    const policyDest = path.join(payloadDir, 'policy');
    copyTree(policySrc, policyDest, { skip: (rel) => POLICY_EXCLUDE_RELS.has(rel) });
    for (const rel of listRel(policySrc)) {
      if (!POLICY_EXCLUDE_RELS.has(rel)) added.push(`policy/${rel}`);
    }
  }

  if (presetsFile && fs.existsSync(presetsFile)) {
    const dest = path.join(payloadDir, 'setup', 'presets.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(presetsFile, dest);
    added.push('setup/presets.json');
  }

  const fixturesDir = path.join(payloadDir, 'setup', 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(path.join(fixturesDir, 'README.md'), FIXTURES_README, 'utf8');
  added.push('setup/fixtures/README.md');

  return added;
}

// ---------------------------------------------------------------------------
// payload\manifest.json  (schema 2)
// ---------------------------------------------------------------------------

// v1 recorded {file, version, sha256, bytes} per part and nothing else. v2
// (설계 11절: "도구도 부품") adds two things:
//
//   parts[<id>]  = the v1 four PLUS collect()'s evidence for that part --
//                  kind, dest, license/licenseFiles/redistribute, and the
//                  kind-specific lock proof (url+sha256 / npm+integrity /
//                  commit+treeHash / requirements digest + per-wheel digests).
//                  Nothing is recomputed: collect() already established all
//                  of it and handed it over via _build\stage\parts-meta.json.
//   files[<rel>] = EVERY file in payload\, fingerprinted -- including the
//                  ones no part owns (policy templates, presets.json). This
//                  is what makes "the zip is what the manifest says" a
//                  statement about the whole payload rather than about 33
//                  archives.
//
// Shape decisions that are load-bearing elsewhere, kept from v1 on purpose:
//   - a part whose lock `file` ends with "/" (the wheelhouse) fans out into
//     "<name>:<basename>" keys, one per file -- lib/manifest.mjs's
//     verifyManifest() and verify/static.mjs ③ both expect that;
//   - redistribute:"download" parts are NOT in `parts` (they have no file in
//     payload\, and verifyManifest would report every one of them as a
//     mismatch). They get their own `downloads` section, which is where the
//     installer finds the url/checksum/fallback it must fetch with.
export async function buildPackManifest({ payloadDir, lock, partsMeta, manifest }) {
  const files = {};
  for (const rel of listRel(payloadDir).sort()) {
    if (rel === 'manifest.json') continue; // a file cannot fingerprint itself
    const abs = path.join(payloadDir, rel);
    files[rel] = { bytes: fs.statSync(abs).size, sha256: await sha256File(abs) };
  }

  const parts = {};
  const downloads = {};
  const meta = partsMeta ?? null;

  if (meta && Object.keys(meta).length > 0) {
    for (const [name, m] of Object.entries(meta)) {
      // `source` is where the BUILD machine read a dir/file part from (this
      // PC's _ontology, _document-templates, …). It is a build input, means
      // nothing on a user's PC, and is an absolute path off this developer's
      // disk -- 2026-09-15 verify ② caught five of them in the shipped
      // manifest. Everything else collect() recorded travels.
      const { file, source, ...rest } = m;
      void source;
      if (m.redistribute === 'download') {
        downloads[name] = { ...rest, file: file ?? null };
        continue;
      }
      if (typeof file === 'string' && file.endsWith('/')) {
        const prefix = file;
        const members = Object.keys(files).filter((rel) => rel.startsWith(prefix));
        if (members.length === 0) throw new Error(`pack/manifest: part ${name} declares ${file} but no file was staged there`);
        for (const rel of members) {
          parts[`${name}:${path.posix.basename(rel)}`] = { ...rest, file: rel, ...files[rel] };
        }
        continue;
      }
      const entry = files[file];
      if (!entry) throw new Error(`pack/manifest: part ${name} declares ${file} but it is not in payload`);
      parts[name] = { ...rest, file, ...entry };
    }
  } else {
    // No parts-meta.json (a unit test's fake stage, or a stage produced by an
    // older collect()): fall back to whatever the caller already computed.
    for (const [key, p] of Object.entries(manifest?.parts ?? {})) {
      parts[key] = { ...p, ...(files[p.file] ?? {}) };
    }
  }

  return {
    schema: 2,
    built: manifest?.built ?? new Date().toISOString(),
    package: {
      name: 'IRIS',
      version: manifest?.package?.version ?? lock?.package?.version ?? null,
      license: 'MIT',
    },
    parts,
    ...(Object.keys(downloads).length > 0 ? { downloads } : {}),
    files,
  };
}

// ---------------------------------------------------------------------------
// 내용 지문 (contentFingerprint)
// ---------------------------------------------------------------------------

// The zip's own sha256 changes on EVERY build, because payload\manifest.json
// carries a `built` timestamp -- which is why verify/reproduce.mjs compares
// part digests instead of zip hashes. That made the release gate
// (iris-release.mjs checkTestMatrix) impossible to satisfy: it builds, then
// demands that every S01~S11 row of docs\시험행렬.md already carry the zip
// sha of the build it just made, so no row could ever match (2026-09-15,
// Task 24a ruling).
//
// 내용 지문 = sha256 over the sorted list of "<zip-relative path>:<sha256>"
// for every file that ships inside the zip, EXCLUDING payload\manifest.json
// (the only file whose bytes depend on `built`). So:
//   - rebuild with nothing changed  -> same 내용 지문, different zip sha
//   - change any shipped file       -> different 내용 지문 (intended: a code
//                                      change invalidates the matrix rows and
//                                      the scenarios must be re-run)
//
// Scope note (deviation from the ruling's wording, kept on purpose): the
// ruling said "every file the manifest fingerprints (manifest.files --
// installer/ + payload/)". manifest.files actually covers payload\ ONLY (see
// buildPackManifest above: it walks payloadDir). Fingerprinting just that
// would leave installer\, lib\, lock.json and IRIS-설치.cmd out -- i.e. a
// change to the installer's own code would NOT invalidate the rows, which is
// the exact thing the ruling wants caught. So this walks the whole zip root.
// payload\ digests are reused from manifest.files (already computed, ~365MB
// not re-read); the handful of non-payload files are hashed here.
export async function computeContentFingerprint(rootDir, { payloadFiles = null } = {}) {
  const lines = [];
  for (const rel of listRel(rootDir)) {
    if (rel === 'payload/manifest.json') continue; // its bytes carry `built`
    let sha = null;
    if (payloadFiles && rel.startsWith('payload/')) {
      sha = payloadFiles[rel.slice('payload/'.length)]?.sha256 ?? null;
    }
    if (!sha) sha = await sha256File(path.join(rootDir, ...rel.split('/')));
    lines.push(`${rel}:${sha}`);
  }
  lines.sort();
  const hex = crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
  return { contentFingerprint: hex, count: lines.length };
}

// pack({stageDir, outDir, manifest, version, installerDir}) -> {zipPath, sha256Path}
//
// Builds the zip-root layout (설계 3-1):
//   IRIS-설치.cmd · 설치가 안 되면.txt · installer\ · lib\ · lock.json · payload\
// and zips it with zipDir (tar -a). Also writes a `<zip>.sha256` sidecar
// containing "<hex>  <zipname>" (the same two-column format `sha256sum`
// produces, so `sha256sum -c` on the sidecar just works).
//
// `installerDir` defaults to this repo's own `installer/` folder so
// build.mjs can call pack() without knowing that detail; tests pass a fully
// self-contained fake installerDir so they don't depend on installer/'s
// real (evolving) contents.
export async function pack({
  stageDir, outDir, manifest, version = manifest?.package?.version,
  installerDir = DEFAULT_INSTALLER_DIR,
  patchRulesFile = DEFAULT_PATCH_RULES_FILE,
  libDir = DEFAULT_LIB_DIR,
  lockFile = DEFAULT_LOCK_FILE,
  payloadSrcDir = DEFAULT_PAYLOAD_SRC_DIR,
  presetsFile = DEFAULT_PRESETS_FILE,
  rules = null,
  log = () => {},
}) {
  if (!version) throw new Error('pack: version (or manifest.package.version) is required');

  const payloadSrc = path.join(stageDir, 'payload');
  if (!fs.existsSync(payloadSrc)) throw new Error(`pack: payload dir not found at ${payloadSrc}`);

  if (!fs.existsSync(lockFile)) throw new Error(`pack: lock.json not found at ${lockFile}`);
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));

  // collect()'s per-part record, handed over through the stage dir. Read up
  // front because renderNotices() needs it too: `face` carries no version in
  // lock.json (collect reads it out of P02's package.json), so partsMeta is
  // the only place the notice table can get it.
  const partsMetaPath = path.join(stageDir, 'parts-meta.json');
  const partsMeta = fs.existsSync(partsMetaPath) ? JSON.parse(fs.readFileSync(partsMetaPath, 'utf8')) : null;

  // ---- 1. the repo's own contributions to payload\ (policy, presets, fixtures)
  const addedPayloadRels = addRepoPayloadSources(payloadSrc, { payloadSrcDir, presetsFile });

  // ---- 2. payload\policy\licenses\NOTICES.md (I4)
  const licensesDir = path.join(payloadSrc, 'policy', 'licenses');
  fs.mkdirSync(licensesDir, { recursive: true });
  fs.writeFileSync(
    path.join(licensesDir, 'NOTICES.md'),
    renderNotices(lock, { parts: partsMeta ?? manifest?.parts ?? {} }),
    'utf8',
  );
  addedPayloadRels.push('policy/licenses/NOTICES.md');

  // ---- 3. the zip root
  const root = path.join(stageDir, 'zip-root');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const cmdSrc = path.join(installerDir, CMD_NAME);
  if (!fs.existsSync(cmdSrc)) throw new Error(`pack: ${CMD_NAME} not found under installerDir ${installerDir}`);
  fs.copyFileSync(cmdSrc, path.join(root, CMD_NAME));
  forceCRLF(path.join(root, CMD_NAME));

  // 설치가 안 되면.txt -- a byte copy of payload-src\policy\install-notice.txt.
  // copyFileSync, never a read/write round trip: the file starts with a UTF-8
  // BOM so Windows Notepad shows the Korean correctly on a double click, and
  // re-encoding it here would be exactly how that BOM gets lost.
  const noticeSrc = path.join(payloadSrcDir, NOTICE_SRC_REL);
  const rootNoticePath = path.join(root, NOTICE_NAME);
  let noticePacked = false;
  if (fs.existsSync(noticeSrc)) {
    fs.copyFileSync(noticeSrc, rootNoticePath);
    noticePacked = true;
  }

  const installerDest = path.join(root, 'installer');
  copyTree(installerDir, installerDest, {
    skip: (rel) => INSTALLER_EXCLUDE_RELS.has(rel) || TEST_FILE_RE.test(path.posix.basename(rel)),
  });
  // Lands at installer\patches\teamclaude\rules.json -- the first candidate
  // installer/lib/install.mjs's resolvePatchRules() looks for inside a zip.
  // Optional so tests can pack a self-contained fake installerDir.
  if (patchRulesFile && fs.existsSync(patchRulesFile)) {
    const rulesDest = path.join(installerDest, PATCH_RULES_REL);
    fs.mkdirSync(path.dirname(rulesDest), { recursive: true });
    fs.copyFileSync(patchRulesFile, rulesDest);
  }
  forceCRLFTree(installerDest);

  // lib/ next to installer/ -- this is what `../../lib/run.mjs` resolves to
  // once server.mjs is running out of the extracted zip (C1). Missing files
  // fail the build loudly: a zip without them is dead on arrival.
  const libDest = path.join(root, 'lib');
  fs.mkdirSync(libDest, { recursive: true });
  for (const file of LIB_FILES) {
    const src = path.join(libDir, file);
    if (!fs.existsSync(src)) throw new Error(`pack: required lib file not found: ${src}`);
    fs.copyFileSync(src, path.join(libDest, file));
  }

  // lock.json at the zip root -- readLock()'s first candidate (C2).
  fs.copyFileSync(lockFile, path.join(root, 'lock.json'));

  // ---- 4. the sanitize gate over exactly what pack() added
  // build/build.mjs sanitizes payload\ BEFORE calling pack(), so everything
  // above (policy templates, presets.json, the fixtures note, the root SAC
  // notice) would otherwise ship without ever meeting the gate. Scanning just
  // those files -- rather than the whole 369MB tree a second time -- keeps the
  // build honest at no measurable cost.
  const gateFiles = addedPayloadRels.map((rel) => path.join('payload', rel));
  if (noticePacked) gateFiles.push(NOTICE_NAME);
  const gateRules = rules ?? loadRules({ warn: log });
  // Scan them where they will actually live: the zip root (payload\ has not
  // been copied there yet, so scan the stage for those and the root for the
  // notice).
  const stageHits = (await sanitize(path.dirname(payloadSrc), gateRules, {
    files: addedPayloadRels.map((rel) => path.join('payload', rel)),
  })).hits;
  const rootHits = noticePacked ? (await sanitize(root, gateRules, { files: [NOTICE_NAME] })).hits : [];
  const gateHits = [...stageHits, ...rootHits];
  if (gateHits.length > 0) {
    throw new Error(`pack: sanitize found ${gateHits.length} hit(s) in pack-time files: ${JSON.stringify(gateHits)}`);
  }
  log(`pack: sanitize ok for ${gateFiles.length} pack-time file(s)`);

  // ---- 5. payload\ -> zip root, then the v2 manifest over what landed there
  const payloadDest = path.join(root, 'payload');
  copyTree(payloadSrc, payloadDest);

  const packedManifest = await buildPackManifest({ payloadDir: payloadDest, lock, partsMeta, manifest });

  // 내용 지문 -- computed over the assembled zip root BEFORE manifest.json is
  // written into it (so the file that carries `built` can never influence it),
  // then recorded inside that same manifest. schema stays 2: this is one more
  // top-level field, and nothing reads the manifest by a fixed key set.
  const { contentFingerprint, count: fingerprintedCount } = await computeContentFingerprint(root, {
    payloadFiles: packedManifest.files,
  });
  const { schema, built, ...restOfManifest } = packedManifest;
  const finalManifest = { schema, built, contentFingerprint, ...restOfManifest };
  log(`pack: 내용 지문(contentFingerprint) ${contentFingerprint} over ${fingerprintedCount} shipped file(s)`);

  const manifestText = `${JSON.stringify(finalManifest, null, 2)}\n`;
  fs.writeFileSync(path.join(payloadDest, 'manifest.json'), manifestText, 'utf8');
  // ...and back into the stage, so the stage payload and the shipped payload
  // are the same bytes (verify/reproduce.mjs reads the stage one).
  fs.writeFileSync(path.join(payloadSrc, 'manifest.json'), manifestText, 'utf8');

  const payloadBytes = Object.values(finalManifest.files).reduce((n, f) => n + f.bytes, 0);
  log(`pack: payload ${Object.keys(finalManifest.files).length} file(s), ${payloadBytes} bytes, ${Object.keys(finalManifest.parts).length} part entr(ies)`);

  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  // ASCII on purpose (2026-09-14): the zip is published as a GitHub Release
  // attachment, and GitHub strips the Korean out of an attachment's file name
  // (measured on v1.2.0), so `IRIS-설치_v1.2.0_....zip` arrived as
  // `_v1.2.0_....zip`. The .cmd *inside* the zip keeps its Korean name -- that
  // one is what the person double-clicks, and nothing rewrites it.
  const zipName = `IRIS-Setup_v${version}_${dateStr}.zip`;
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, zipName);
  fs.rmSync(zipPath, { force: true });
  await zipDir(root, zipPath);

  const hex = await sha256File(zipPath);
  const sha256Path = `${zipPath}.sha256`;
  fs.writeFileSync(sha256Path, `${hex}  ${path.basename(zipPath)}\n`);
  log(`pack: zip ${fs.statSync(zipPath).size} bytes sha256=${hex}`);

  return { zipPath, sha256Path, manifest: finalManifest, payloadBytes, contentFingerprint };
}
