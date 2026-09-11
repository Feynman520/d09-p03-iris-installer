import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../lib/manifest.mjs';
import { zipDir } from '../lib/zip.mjs';

// Project root (one level up from build/), independent of process.cwd() --
// same convention as build/collect.mjs's ROOT_DIR. installer/ is a static
// source folder that lives in the repo, not something collect() stages, so
// pack() needs its own fixed anchor to find it when a caller doesn't pass
// installerDir explicitly.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INSTALLER_DIR = path.join(ROOT_DIR, 'installer');
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

// (2026-09-12 final review C1) The installer's own modules import shared
// helpers from the repo root's lib/ as `../../lib/<file>.mjs`
// (installer/lib/install.mjs, login.mjs, precheck.mjs, userpath.mjs,
// handoff.mjs) -- which, from inside the zip, resolves to <zipRoot>\lib\.
// Before this the zip shipped only IRIS-설치.cmd + installer/ + payload/, so
// server.mjs died with ERR_MODULE_NOT_FOUND on the user's PC and
// bootstrap.ps1 timed out with exit 13.
//
// Kept to exactly the files the installer needs, not the whole lib/ tree:
//   grep -rn "\.\./\.\./lib/" installer/    -> run.mjs, zip.mjs
//   (zip.mjs itself imports ./run.mjs; nothing else is reachable)
// glob.mjs / manifest.mjs are build- and verify-side only. Re-run that grep
// whenever installer/ grows a new import and extend this list.
const LIB_FILES = ['run.mjs', 'zip.mjs'];
const DEFAULT_LIB_DIR = path.join(ROOT_DIR, 'lib');
// (C2) installer/server.mjs's readLock() looks for <zipRoot>\lock.json first;
// without it every POST /api/install answered 500 payload_unreadable.
const DEFAULT_LOCK_FILE = path.join(ROOT_DIR, 'lock.json');

// (2026-09-12 final review I4) Per-part license notices, generated from
// lock.json so the shipped list can never drift from what was actually
// packed. Lands at payload/licenses/NOTICES.md -- the folder docs/설계.md
// 2-1 reserves for exactly this ("licenses\ 부품별 허가서 사본").
function partSource(p) {
  if (p.url) return p.url;
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

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
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

// pack({stageDir, outDir, manifest, version, installerDir}) -> {zipPath, sha256Path}
//
// Builds the zip-root layout (IRIS-설치.cmd at the root, installer/ copied
// wholesale, payload/ copied from stageDir/payload -- which the caller must
// already have populated, manifest.json included) and zips it with zipDir
// (tar -a). Also writes a `<zip>.sha256` sidecar containing
// "<hex>  <zipname>" (the same two-column format `sha256sum` produces, so
// `sha256sum -c` on the sidecar just works).
//
// `installerDir` defaults to this repo's own `installer/` folder so
// build.mjs can call pack() without knowing that detail; tests pass a fully
// self-contained fake installerDir so they don't depend on installer/'s
// real (evolving, Task 9+) contents.
export async function pack({
  stageDir, outDir, manifest, version = manifest?.package?.version,
  installerDir = DEFAULT_INSTALLER_DIR,
  patchRulesFile = DEFAULT_PATCH_RULES_FILE,
  libDir = DEFAULT_LIB_DIR,
  lockFile = DEFAULT_LOCK_FILE,
}) {
  if (!version) throw new Error('pack: version (or manifest.package.version) is required');

  const root = path.join(stageDir, 'zip-root');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const cmdSrc = path.join(installerDir, CMD_NAME);
  if (!fs.existsSync(cmdSrc)) throw new Error(`pack: ${CMD_NAME} not found under installerDir ${installerDir}`);
  fs.copyFileSync(cmdSrc, path.join(root, CMD_NAME));
  forceCRLF(path.join(root, CMD_NAME));

  const installerDest = path.join(root, 'installer');
  copyTree(installerDir, installerDest);
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
  if (!fs.existsSync(lockFile)) throw new Error(`pack: lock.json not found at ${lockFile}`);
  fs.copyFileSync(lockFile, path.join(root, 'lock.json'));

  const payloadSrc = path.join(stageDir, 'payload');
  if (!fs.existsSync(payloadSrc)) throw new Error(`pack: payload dir not found at ${payloadSrc}`);
  const payloadDest = path.join(root, 'payload');
  copyTree(payloadSrc, payloadDest);

  // payload/licenses/NOTICES.md (I4). Written here rather than in collect()
  // on purpose: it is a packaging artefact, not a collected part, so it
  // stays out of manifest.json (and therefore out of the integrity check and
  // the reproducibility comparison, both of which are about parts).
  const licensesDir = path.join(payloadDest, 'licenses');
  fs.mkdirSync(licensesDir, { recursive: true });
  fs.writeFileSync(
    path.join(licensesDir, 'NOTICES.md'),
    renderNotices(JSON.parse(fs.readFileSync(lockFile, 'utf8')), manifest),
    'utf8',
  );

  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  const zipName = `IRIS-설치_v${version}_${dateStr}.zip`;
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, zipName);
  fs.rmSync(zipPath, { force: true });
  await zipDir(root, zipPath);

  const hex = await sha256File(zipPath);
  const sha256Path = `${zipPath}.sha256`;
  fs.writeFileSync(sha256Path, `${hex}  ${path.basename(zipPath)}\n`);

  return { zipPath, sha256Path };
}
