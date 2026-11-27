// verify/doctor-bundle.mjs -- IRIS Doctor 묶음을 "풀어 놓은 폴더"에서 보는 두 가지 판정(2.0.66).
//
// 정적 검사(verify/static.mjs ㉒ 여섯째 자리 · ㉓)는 zip 안 `payload\tools\iris-doctor.zip` 을 푼 폴더에,
// 업그레이드 게이트(verify/upgrade.mjs ③ⓜ)는 업데이트 뒤 설치 폴더의 `_agent\shared\tools\iris-doctor` 에 같은 판정을 쓴다.
// 순수 함수다 — 폴더를 읽기만 하고, Doctor 를 실행하지 않는다. 그래서 무거운 검사를 돌리지 않고도 단위 시험
// (tests/iris-doctor.test.mjs)이 저장소의 사본과 일부러 망가뜨린 사본으로 이 판정을 잰다.
//
// 설치기의 부품 검증기(installer/setup/unpack.mjs doctorBundleCheck)와 같은 규칙을 **일부러 따로** 적었다:
// 검사소가 설치기의 코드로 설치기를 검사하면 둘이 같이 틀렸을 때 아무도 모른다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DOCTOR_PART_ZIP = 'tools/iris-doctor.zip';
export const DOCTOR_REQUIRED_FILES = Object.freeze(['iris-doctor.mjs', 'IRIS Doctor.cmd', 'lib/session.mjs', 'lib/start-check.ps1', 'guide/cannot-start.ko.txt']);
// 실리면 안 되는 것: 만드는 사람용 문서 · 시험 · 묶는 도구와 시험장 · 그 PC 만의 자리 표 · 열쇠 파일 · 저장소 기록 · 임시와 사본.
const FORBIDDEN = [
  [/(^|\/)(AGENTS|CLAUDE)\.md$/i, '지침 문서'],
  [/(^|\/)tests?\//i, '시험 폴더'],
  [/\.test\.(mjs|js|ps1)$/i, '시험 파일'],
  [/^tools\//i, '도구 폴더(묶는 도구 · 시험장)'],
  [/(^|\/)local\.json$/i, '그 PC 만의 자리 표'],
  [/(^|\/)iris-keys\.json$/i, '열쇠 파일'],
  [/(^|\/)(cards|codex-home|claude-home)\//i, 'Doctor 의 집(열쇠가 드는 자리)'],
  [/(^|\/)\.git(\/|ignore$|attributes$)/i, '저장소 기록'],
  [/\.(tmp|bak|orig|log|restore|doctor-aside|prev)$/i, '임시 · 사본 파일'],
];

/** 폴더 안 모든 항목의 상대 경로('/' 구분)와 종류. 링크는 따라가지 않는다. */
function walk(dir) {
  const files = []; const links = [];
  const go = (rel) => {
    for (const name of fs.readdirSync(rel ? path.join(dir, ...rel.split('/')) : dir)) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(dir, ...r.split('/')));
      if (st.isSymbolicLink()) links.push(r);
      else if (st.isDirectory()) go(r);
      else if (st.isFile()) files.push(r);
      else links.push(r);
    }
  };
  go('');
  return { files: files.sort(), links: links.sort() };
}

/**
 * ㉓ Doctor 묶음이 온전한가. → 문제 글의 배열(비어 있으면 통과).
 *   · 꼭 있어야 할 파일 다섯 · manifest.json 이 읽히고 그 다섯을 담고 있다
 *   · 목록의 모든 파일이 있고 sha256 · 크기가 같다 · 목록에 없는 파일 0 · 링크 0
 *   · 실리면 안 되는 것(지침 · 시험 · 도구 · local.json · iris-keys.json …) 0 · 0바이트 파일 0
 *   · 시작 파일(.cmd)과 PowerShell 도우미(.ps1)는 ASCII · 줄끝 전부 CRLF
 *   · 목록의 판 = lib\diagnose.mjs 의 판
 */
export function doctorBundleProblems(dir) {
  const problems = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [`Doctor 묶음 폴더가 없다: ${path.basename(dir)}`];
  let tree;
  try { tree = walk(dir); } catch (err) { return [`Doctor 묶음을 읽지 못했다: ${err?.code ?? 'error'}`]; }
  const { files, links } = tree;
  if (links.length) problems.push(`링크 · 연결 폴더: ${links.slice(0, 5).join(', ')}`);
  for (const need of DOCTOR_REQUIRED_FILES) if (!files.includes(need)) problems.push(`없음: ${need}`);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { problems.push('manifest.json 을 읽지 못했다'); }
  const listed = Array.isArray(manifest?.files) ? manifest.files : null;
  if (manifest && (!listed || listed.length === 0)) problems.push('manifest.json 에 파일 목록이 없다');
  if (listed && listed.length) {
    const want = new Map();
    for (const f of listed) {
      if (!f || typeof f.path !== 'string' || !/^[0-9a-f]{64}$/.test(String(f.sha256)) || /[\\:]|(^|\/)\.\.?(\/|$)/.test(f.path)) { problems.push(`manifest.json 의 줄이 이상하다: ${String(f?.path).slice(0, 60)}`); continue; }
      if (want.has(f.path)) problems.push(`manifest.json 에 두 번 적힘: ${f.path}`);
      want.set(f.path, f);
    }
    for (const need of DOCTOR_REQUIRED_FILES) if (!want.has(need)) problems.push(`manifest.json 에 꼭 있어야 할 파일이 빠졌다: ${need}`);
    for (const [rel, f] of want) {
      if (!files.includes(rel)) { problems.push(`목록에는 있는데 파일이 없다: ${rel}`); continue; }
      const buf = fs.readFileSync(path.join(dir, ...rel.split('/')));
      if (createHash('sha256').update(buf).digest('hex') !== f.sha256) problems.push(`지문이 다르다: ${rel}`);
      else if (Number.isInteger(f.size) && f.size !== buf.length) problems.push(`크기가 다르다: ${rel}`);
    }
    for (const rel of files) if (rel !== 'manifest.json' && !want.has(rel)) problems.push(`목록에 없는 파일: ${rel}`);
    // 판: 지문 목록 = 프로그램 글
    let programVersion = null;
    try { programVersion = /VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(dir, 'lib', 'diagnose.mjs'), 'utf8'))?.[1] ?? null; } catch { /* 위에서 이미 잡힌다 */ }
    if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) problems.push(`manifest.json 의 판이 이상하다: ${String(manifest.version).slice(0, 20)}`);
    else if (programVersion !== null && programVersion !== manifest.version) problems.push(`판이 어긋난다: 목록 ${manifest.version} · 프로그램 ${programVersion}`);
  }
  for (const rel of files) {
    const hit = FORBIDDEN.find(([re]) => re.test(rel));
    if (hit) problems.push(`실리면 안 되는 것(${hit[1]}): ${rel}`);
    const buf = fs.readFileSync(path.join(dir, ...rel.split('/')));
    if (buf.length === 0) problems.push(`0바이트 파일: ${rel}`);
    if (/\.(cmd|ps1)$/i.test(rel)) {
      const hi = buf.findIndex((b) => b > 0x7f);
      if (hi !== -1) problems.push(`${rel}: ASCII 가 아닌 바이트(offset ${hi})`);
      const text = buf.toString('latin1');
      if (/(^|[^\r])\n/.test(text)) problems.push(`${rel}: CRLF 가 아닌 줄끝`);
      if (!text.includes('\r\n')) problems.push(`${rel}: 줄끝이 없다`);
    }
  }
  return problems;
}

/**
 * ㉒ 여섯째 자리 — Doctor 가 띄우는 Node 가 윈도우 인증서도 믿는가. → 문제 글의 배열.
 *   · lib\trust.mjs 가 내장 목록에 윈도우 목록을 **더한다**(tls.setDefaultCACertificates · getCACertificates('system'))
 *   · 실행 입구와 검진 일꾼이 그것을 부른다
 *   · 시작 파일이 NODE_USE_SYSTEM_CA 를 **비어 있을 때만** 채운다 · NODE_OPTIONS 는 지금처럼 비운다
 *   · `--use-system-ca` 플래그를 쓰지 않는다 · NODE_OPTIONS 에 값을 넣지 않는다(주석 줄은 빼고 본다)
 */
export function doctorTrustProblems(dir) {
  const problems = [];
  const read = (rel, enc = 'utf8') => { try { return fs.readFileSync(path.join(dir, ...rel.split('/')), enc); } catch { problems.push(`없음: ${rel}`); return ''; } };
  const trust = read('lib/trust.mjs');
  if (!/setDefaultCACertificates\(\[\.\.\.current, \.\.\.extra\]\)/.test(trust)) problems.push('lib/trust.mjs 가 내장 목록에 윈도우 목록을 더하지 않는다(setDefaultCACertificates)');
  if (!/getCACertificates\('system'\)/.test(trust)) problems.push("lib/trust.mjs 가 윈도우 목록을 읽지 않는다(getCACertificates('system'))");
  if (!/import\('\.\/lib\/trust\.mjs'\)\)\.trustSystemRoots\(\)/.test(read('iris-doctor.mjs'))) problems.push('iris-doctor.mjs 가 trustSystemRoots() 를 부르지 않는다');
  if (!/import\('\.\/trust\.mjs'\)\)\.trustSystemRoots\(\)/.test(read('lib/worker.mjs'))) problems.push('lib/worker.mjs 가 trustSystemRoots() 를 부르지 않는다');
  const cmd = read('IRIS Doctor.cmd', 'latin1');
  if (!/^if not defined NODE_USE_SYSTEM_CA set "NODE_USE_SYSTEM_CA=1"\r?$/m.test(cmd)) problems.push('IRIS Doctor.cmd 가 NODE_USE_SYSTEM_CA 를 비어 있을 때만 채우지 않는다');
  if (!/^set "NODE_OPTIONS="\r?$/m.test(cmd)) problems.push('IRIS Doctor.cmd 가 NODE_OPTIONS 를 비우지 않는다');
  let files = [];
  try { files = walk(dir).files; } catch { /* 위에서 이미 잡힌다 */ }
  for (const rel of files) {
    if (!/\.(mjs|cmd|ps1)$/i.test(rel)) continue;
    const code = read(rel).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|rem\b|#)/i.test(l)).join('\n');
    if (code.includes('--use-system-ca')) problems.push(`${rel}: --use-system-ca 플래그를 쓴다`);
    const setsOptions = /\.mjs$/i.test(rel) ? /NODE_OPTIONS\s*[:=]\s*['"`][^'"`\s]/.test(code) : /NODE_OPTIONS\s*=\s*[^"'\s]/i.test(code);
    if (setsOptions) problems.push(`${rel}: NODE_OPTIONS 에 값을 넣는다`);
  }
  return problems;
}
