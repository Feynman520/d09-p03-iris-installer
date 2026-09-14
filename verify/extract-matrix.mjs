// verify/extract-matrix.mjs -- does the shipped zip actually open on the
// tools real users reach for?
//
// Background (2026-09-14): a user downloaded v1.3.1 from the home page on a
// second PC and Windows Explorer's "Extract All" failed with "The Compressed
// (zipped) Folder is invalid". Every check we ran before publishing (tar,
// Python, Expand-Archive) had passed, because none of them was Explorer.
// This script closes that gap: it extracts the newest zip under _build/out
// (or --zip <path>) with each unzipper below and compares the result with
// the archive's own central directory. It is wired into `npm run verify` and
// the release tool's post-build self-checks, so a zip that any *required*
// engine cannot open never reaches GitHub.
//
//   engine          how                                    required
//   explorer        Shell.Application (the exact engine     yes (Windows)
//                   behind "Extract All" / double-click)
//   expand-archive  PowerShell Expand-Archive (.NET)         yes (Windows)
//   tar             lib/zip.mjs extractZip (bsdtar)          yes
//   bandizip        bz.exe if Bandizip is installed          optional (skip)
//   python          zipfile.testzip() if python is on PATH   optional (skip)
//
// Usage: node verify/extract-matrix.mjs [--zip <path>] [--out <dir>]
// Exit 0 = every required engine extracted the full tree; 1 otherwise.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { extractZip } from '../lib/zip.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const BZ = 'C:\\Program Files\\Bandizip\\bz.exe';

function parseArgs(argv) {
  const opts = { out: path.join(ROOT_DIR, '_build', 'out'), zip: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--zip') opts.zip = path.resolve(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  return opts;
}

function findNewestZip(outDir) {
  const zips = fs.readdirSync(outDir).filter((f) => f.endsWith('.zip'));
  if (zips.length === 0) throw new Error(`no .zip found under ${outDir}`);
  return zips.map((f) => path.join(outDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

// ---- the archive's own view: names from the central directory ----
// Minimal ZIP central-directory reader (no zip64 -- the build never produces
// entries or archives near 4 GB; if it ever does, this throws loudly rather
// than silently under-counting).
function readCentralDirectory(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('end-of-central-directory record not found');
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 archive -- extend readCentralDirectory');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const names = [];
    let p = 0;
    for (let n = 0; n < total; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory header at ${p}`);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    fs.closeSync(fd);
  }
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n += 1;
  }
  return n;
}

// Each engine gets a fresh dir and must reproduce: every file (count equal
// to the central directory's file entries) and every root entry by name.
function judge(label, dir, expected) {
  const missingRoots = expected.roots.filter((r) => !fs.existsSync(path.join(dir, r)));
  const files = fs.existsSync(dir) ? countFiles(dir) : 0;
  const ok = missingRoots.length === 0 && files === expected.files;
  return { label, ok, detail: ok ? `${files} files` : `${files}/${expected.files} files${missingRoots.length ? `, missing root: ${missingRoots.join(', ')}` : ''}` };
}

// PowerShell gets every path through the environment, never argv: argv is
// re-encoded to the ANSI code page on the way in and this repo lives under
// a folder whose name (`〖 〗`) cp949 cannot spell (see lib/zip.mjs).
function ps(script, env) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 10 * 60 * 1000,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

async function runExplorer(zipPath, dir, expected) {
  fs.mkdirSync(dir, { recursive: true });
  // 1) Can Explorer even list the root? (0 items == "invalid folder")
  const list = ps(
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $s = New-Object -ComObject Shell.Application; $ns = $s.NameSpace($env:IRIS_ZIP); if ($null -eq $ns) { 'NULL' } else { ($ns.Items() | ForEach-Object { Split-Path -Leaf $_.Path }) -join '|' }",
    { IRIS_ZIP: zipPath },
  );
  if (list.code !== 0 || list.out === 'NULL') return { label: 'explorer', ok: false, detail: `cannot open: ${list.err || list.out}` };
  const roots = list.out ? list.out.split('|') : [];
  if (roots.length === 0) return { label: 'explorer', ok: false, detail: 'Explorer lists 0 items (the "invalid folder" symptom)' };
  // 2) Extract the way "Extract All" does: CopyHere with 4 (no progress UI)
  //    | 16 (yes to all) | 512 (no new-folder prompt) | 1024 (no error UI).
  //    CopyHere is asynchronous -- wait until the file count stops growing.
  const copy = ps(
    "$s = New-Object -ComObject Shell.Application; $src = $s.NameSpace($env:IRIS_ZIP); $dst = $s.NameSpace($env:IRIS_DEST); $dst.CopyHere($src.Items(), 1556); " +
    "$want = [int]$env:IRIS_WANT; $deadline = (Get-Date).AddMinutes(8); do { Start-Sleep -Milliseconds 500; $n = (Get-ChildItem -LiteralPath $env:IRIS_DEST -Recurse -File -Force | Measure-Object).Count } while ($n -lt $want -and (Get-Date) -lt $deadline); Start-Sleep -Seconds 2; $n",
    { IRIS_ZIP: zipPath, IRIS_DEST: dir, IRIS_WANT: String(expected.files) },
  );
  if (copy.code !== 0) return { label: 'explorer', ok: false, detail: `CopyHere failed: ${copy.err}` };
  return judge('explorer', dir, expected);
}

function runExpandArchive(zipPath, dir, expected) {
  const r = ps('$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:IRIS_ZIP -DestinationPath $env:IRIS_DEST -Force', { IRIS_ZIP: zipPath, IRIS_DEST: dir });
  if (r.code !== 0) return { label: 'expand-archive', ok: false, detail: r.err.split('\n')[0] };
  return judge('expand-archive', dir, expected);
}

async function runTar(zipPath, dir, expected) {
  try { await extractZip(zipPath, dir); } catch (e) { return { label: 'tar', ok: false, detail: e.message }; }
  return judge('tar', dir, expected);
}

function runBandizip(zipPath, dir, expected) {
  if (!fs.existsSync(BZ)) return { label: 'bandizip', skip: true, detail: 'Bandizip not installed' };
  const r = spawnSync(BZ, ['x', `-o:${dir}`, zipPath], { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 });
  if (r.status !== 0) return { label: 'bandizip', ok: false, detail: `bz exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}` };
  return judge('bandizip', dir, expected);
}

function runPython(zipPath) {
  const probe = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) return { label: 'python', skip: true, detail: 'python not on PATH' };
  const code = 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nbad = z.testzip()\nprint(len(z.infolist()))\nsys.exit(1 if bad else 0)\n';
  const r = spawnSync('python', ['-c', code, zipPath], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
  if (r.status !== 0) return { label: 'python', ok: false, detail: (r.stderr || '').trim().split('\n').pop() || 'testzip reported a bad entry' };
  return { label: 'python', ok: true, detail: `${(r.stdout || '').trim()} entries, testzip clean` };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const zipPath = opts.zip || findNewestZip(opts.out);
  console.log(`extract-matrix: ${zipPath}`);

  const names = readCentralDirectory(zipPath);
  const dotted = names.filter((n) => n === './' || n.startsWith('./') || n.startsWith('/'));
  if (dotted.length) {
    console.error(`FAIL  entry names carry a ./ or / prefix (${dotted.length}, e.g. ${dotted[0]}) -- Windows Explorer shows such a zip as empty`);
    process.exit(1);
  }
  const expected = {
    files: names.filter((n) => !n.endsWith('/')).length,
    roots: [...new Set(names.map((n) => n.split('/')[0]))],
  };
  console.log(`  central directory: ${names.length} entries, ${expected.files} files, roots = ${expected.roots.join(', ')}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-extract-matrix-'));
  const results = [];
  try {
    if (IS_WIN) {
      results.push(await runExplorer(zipPath, path.join(work, 'explorer'), expected));
      results.push(runExpandArchive(zipPath, path.join(work, 'expand'), expected));
    }
    results.push(await runTar(zipPath, path.join(work, 'tar'), expected));
    if (IS_WIN) results.push(runBandizip(zipPath, path.join(work, 'bandizip'), expected));
    results.push(runPython(zipPath));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  let failed = 0;
  for (const r of results) {
    const mark = r.skip ? 'skip' : r.ok ? 'ok  ' : 'FAIL';
    if (!r.skip && !r.ok) failed += 1;
    console.log(`  ${mark}  ${r.label.padEnd(15)} ${r.detail}`);
  }
  if (failed) {
    console.error(`extract-matrix: ${failed} engine(s) could not extract the zip -- do not publish`);
    process.exit(1);
  }
  console.log('extract-matrix: every engine extracted the full tree');
}

main().catch((e) => { console.error(`extract-matrix: ${e.message}`); process.exit(1); });
