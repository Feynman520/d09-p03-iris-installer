// IRIS 삭제기 — macOS (docs/설계-macOS.md M5, 규칙 정본 = docs/설계-삭제기.md).
//
// Windows uninstall.ps1 과 같은 약속을 지킨다:
//   · 설치 영수증(<폴더>/_agent/setup/package-receipt.json)이 JSON 으로 읽히는 폴더만 지운다.
//   · 위험한 자리(/, 홈 자체, 시스템 폴더, 연결(심볼릭 링크) 폴더)는 거부한다.
//   · 기본 = 「내 작업은 남기기」 — 사용자 항목은 <폴더>-보관-YYYY-MM-DD 로 옮기고 IRIS 가 깐 것만 지운다.
//     「전부 지우기」는 한 번 더 확인한 뒤에만(창 없이 돌릴 때는 --yes).
//   · 옮기기에 실패한 사용자 항목은 절대 지우지 않는다. 영수증은 맨 마지막에 — 무엇이든 남으면 영수증을 남겨 다시 돌릴 수 있게.
//   · 폴더 바깥 흔적은 **이 IRIS 폴더를 가리킬 때만** 뺀다: ~/.zprofile·~/.bash_profile 의 IRIS 덩어리,
//     ~/Library/LaunchAgents/com.iris-workspace.relay.plist, ~/Applications/<이름>.app, 설치기 작업 폴더.
//   · 프로그램은 PID 로만 끈다(이름으로 끄지 않는다). 자기 자신과 조상은 빼고.
//
// 종료 코드: 0 완료·흔적 정리·미리보기 / 1 일부 남음 / 2 거부·못 찾음·--mode all 에 --yes 없음 / 3 취소 / 4 오류·이미 실행 중.
//
// 시험 손잡이(진짜 홈을 건드리지 않게): --home <폴더> · --scan-roots <a:b> · --work-dir <폴더> · --no-launchctl · --lock <파일>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RECEIPT_REL = path.join('_agent', 'setup', 'package-receipt.json');
const SYSTEM_DIRS = ['_agent', '_ontology', '_cleanup', '_document-templates', '_setup-guides'];
const SYSTEM_FILES = ['soul-state.json', 'AGENTS.md', 'CLAUDE.md', '_cosmos.ico', 'Icon\r', '.DS_Store', 'IRIS-온톨로지.md', 'IRIS-온톨로지-뷰.html', '소환하기.command', '대시보드.command'];
const EMPTY_ONLY_DIRS = ['_trash', '_backup'];
// 명령줄에 IRIS 폴더가 보이면 끄는 스크립트 실행기들(Windows HostNames 와 같은 뜻).
const HOSTS = /^(node|python[0-9.]*|Python|sh|bash|zsh|dash|uv|uvx|git|osascript)$/;
const BROWSERS = /^(Google Chrome|Chromium|Microsoft Edge|Brave Browser|firefox|Arc)$/;
const BLOCK_BEGIN = '# >>> IRIS >>>';
const BLOCK_END = '# <<< IRIS <<<';
const AGENT_LABEL = 'com.iris-workspace.relay';
const ARCHIVE_WORD = '보관';

export function parseArgs(argv) {
  const o = { ui: true, mode: null, yes: false, dryRun: false, scan: false, root: null, scanRoots: null, home: null, workDir: null, launchctl: true, lock: null, log: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-ui') o.ui = false;
    else if (a === '--mode') o.mode = argv[++i];
    else if (a === '--yes') o.yes = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--scan') o.scan = true;
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--scan-roots') o.scanRoots = String(argv[++i] || '').split(':').filter(Boolean);
    else if (a === '--home') o.home = argv[++i];
    else if (a === '--work-dir') o.workDir = argv[++i];
    else if (a === '--no-launchctl') o.launchctl = false;
    else if (a === '--lock') o.lock = argv[++i];
    else if (a === '--log') o.log = argv[++i];
  }
  return o;
}

const under = (p, root) => String(p).startsWith(root.replace(/\/+$/, '') + '/');
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
const dirEmpty = (p) => { try { return fs.readdirSync(p).length === 0; } catch { return false; } };

export function readReceipt(root) {
  try { const r = JSON.parse(fs.readFileSync(path.join(root, RECEIPT_REL), 'utf8')); return r && typeof r === 'object' ? r : null; } catch { return null; }
}

/** 지워도 되는 자리인가. 아니면 거부 사유(한국어). */
export function unsafeReason(root, { home }) {
  if (!root || !path.isAbsolute(root)) return '절대 경로가 아닙니다';
  const r = path.resolve(root);
  if (r === '/' || r === path.resolve(home) || path.dirname(r) === '/') return '디스크 뿌리·홈 폴더·최상위 폴더는 지우지 않습니다';
  if (/^\/(System|Library|Applications|usr|bin|sbin|etc|var|private|opt|cores|dev|Volumes)(\/|$)/.test(r) && !under(r, path.resolve(home))) return '시스템 폴더는 지우지 않습니다';
  if (path.resolve(home) === r || r === path.join(path.resolve(home), 'Library') || under(path.join(path.resolve(home), 'Library'), r)) return '홈 폴더의 시스템 영역은 지우지 않습니다';
  try { if (fs.lstatSync(r).isSymbolicLink()) return '폴더 자체가 연결(심볼릭 링크)이라 지우지 않습니다'; } catch { return '폴더가 없습니다'; }
  return null;
}

/** 맨 위 항목을 IRIS 가 깐 것(system)과 사용자 것(user)으로 나눈다. */
export function classify(root) {
  const system = []; const user = [];
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    const st = fs.lstatSync(p);
    let sys = false;
    if (st.isDirectory()) {
      if (SYSTEM_DIRS.includes(name)) sys = true;
      else if (EMPTY_ONLY_DIRS.includes(name)) sys = dirEmpty(p);
    } else if (st.isSymbolicLink() && EMPTY_ONLY_DIRS.includes(name)) sys = true;
    else if (SYSTEM_FILES.includes(name) || / Face\.command$/.test(name)) sys = true;
    (sys ? system : user).push(name);
  }
  return { system: system.sort(), user: user.sort() };
}

// ---------------------------------------------------------------- 바깥 흔적

/** ~/.zprofile·~/.bash_profile 의 IRIS 덩어리가 가리키는 심 폴더들. */
function profileBlocks(home) {
  const out = [];
  for (const f of ['.zprofile', '.bash_profile'].map((n) => path.join(home, n))) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const b = text.indexOf(BLOCK_BEGIN); if (b < 0) continue;
    const e = text.indexOf(BLOCK_END, b); if (e < 0) continue;
    const m = /export PATH="((?:[^"\\]|\\.)*?):\$PATH"/.exec(text.slice(b, e));
    out.push({ file: f, dir: m ? m[1].replace(/\\([\\"$`])/g, '$1') : '' });
  }
  return out;
}
/** 덩어리를 뺀다(덩어리 밖은 한 글자도 안 건드림, 심볼릭 링크면 대상에, 권한 유지 — userenv-darwin.mjs 와 같은 규칙). */
function removeProfileBlock(file) {
  const target = fs.realpathSync(file);
  const src = fs.readFileSync(target, 'utf8');
  const b = src.indexOf(BLOCK_BEGIN); const e = src.indexOf(BLOCK_END, b);
  if (b < 0 || e < 0) return false;
  let before = src.slice(0, b); let after = src.slice(e + BLOCK_END.length);
  if (after.startsWith('\n')) after = after.slice(1);
  if (before.endsWith('\n\n') && after === '') before = before.slice(0, -1);
  const mode = fs.statSync(target).mode & 0o777;
  const tmp = `${target}.iris-tmp`;
  fs.writeFileSync(tmp, before + after, { encoding: 'utf8', mode });
  fs.renameSync(tmp, target);
  return true;
}
function agentPlist(home) { return path.join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`); }
function plistArgs(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
}
/** ~/Applications 의 IRIS 실행 앱(설치기가 만든 것 = 식별자 com.iris-workspace.launcher)과 그 대상. */
function launcherApps(home) {
  const dir = path.join(home, 'Applications'); const out = [];
  let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.app')); } catch { return out; }
  for (const n of names) {
    const app = path.join(dir, n);
    let plist = ''; try { plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'); } catch { continue; }
    if (!plist.includes('<string>com.iris-workspace.launcher</string>')) continue;
    const exe = path.join(app, 'Contents', 'MacOS', n.slice(0, -4));
    let body = ''; try { body = fs.readFileSync(exe, 'utf8'); } catch {}
    const m = /exec '((?:[^']|'\\'')*)'/.exec(body);
    out.push({ app, target: m ? m[1].replace(/'\\''/g, "'") : '' });
  }
  return out;
}
/** 경로 문자열 → 그 경로가 속한 IRIS 폴더(…/_agent/… 또는 "… Face.command" 의 폴더). */
function soulOf(p) {
  const s = String(p || '');
  const i = s.indexOf('/_agent/'); if (i > 0) return s.slice(0, i);
  if (/ Face\.command$/.test(s)) return path.dirname(s);
  return null;
}

/** 이 폴더(또는 없어진 폴더들)를 가리키는 바깥 흔적. pick(soul) = 그 흔적을 뺄 대상인가. */
export function outsideTraces(home, pick) {
  const t = { profiles: [], plist: null, apps: [] };
  for (const b of profileBlocks(home)) if (pick(soulOf(b.dir))) t.profiles.push(b);
  const pl = agentPlist(home); const args = plistArgs(pl);
  if (args && args.some((a) => pick(soulOf(a)))) t.plist = pl;
  for (const a of launcherApps(home)) if (pick(soulOf(a.target))) t.apps.push(a);
  return t;
}
const traceCount = (t) => t.profiles.length + (t.plist ? 1 : 0) + t.apps.length;

// ---------------------------------------------------------------- 프로그램 끄기

function psTable() {
  const run = (col) => spawnSync('/bin/ps', ['-axww', '-o', `pid=,ppid=,${col}=`], { encoding: 'utf8' }).stdout || '';
  const rows = new Map();
  for (const l of run('comm').split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(l); if (m) rows.set(+m[1], { pid: +m[1], ppid: +m[2], comm: m[3].trim(), args: '' }); }
  for (const l of run('args').split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(l); if (m && rows.has(+m[1])) rows.get(+m[1]).args = m[3]; }
  return rows;
}
/** 끌 PID 들: 실행 파일이 폴더 안 · 실행기인데 명령줄에 폴더 · 그 자식 실행기 · 사용자 자료 폴더가 폴더 안인 브라우저. 자기와 조상은 뺀다. */
export function processesFor(roots, rows = psTable()) {
  const self = new Set(); for (let p = process.pid; p > 1 && rows.has(p) && !self.has(p); p = rows.get(p).ppid) self.add(p);
  self.add(process.pid);
  const hit = new Set();
  const inRoots = (s) => roots.some((r) => under(s, r) || s.includes(r.replace(/\/+$/, '') + '/'));
  for (const r of rows.values()) {
    if (self.has(r.pid)) continue;
    const base = path.basename(r.comm);
    if (roots.some((root) => under(r.comm, root))) hit.add(r.pid);
    else if (HOSTS.test(base) && inRoots(r.args)) hit.add(r.pid);
    else if (BROWSERS.test(base) && roots.some((root) => r.args.includes(`--user-data-dir=${root.replace(/\/+$/, '')}/`))) hit.add(r.pid);
  }
  let grew = true;
  while (grew) { grew = false; for (const r of rows.values()) if (!hit.has(r.pid) && !self.has(r.pid) && hit.has(r.ppid) && HOSTS.test(path.basename(r.comm))) { hit.add(r.pid); grew = true; } }
  return [...hit].map((pid) => rows.get(pid));
}
async function stopProcesses(list, log) {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const p of list) { try { process.kill(p.pid, 'SIGTERM'); log(`끔(TERM) pid=${p.pid} ${path.basename(p.comm)}`); } catch {} }
  for (let i = 0; i < 30 && list.some((p) => alive(p.pid)); i++) await new Promise((r) => setTimeout(r, 100));
  for (const p of list) if (alive(p.pid)) { try { process.kill(p.pid, 'SIGKILL'); log(`끔(KILL) pid=${p.pid}`); } catch {} }
}

// ---------------------------------------------------------------- 옮기기·지우기

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** <부모>/<이름>-보관-YYYY-MM-DD. 같은 이름의 **폴더**가 있으면 이어 쓰고, 파일·링크로 차 있으면 -2, -3 … */
export function archivePath(root) {
  const base = path.join(path.dirname(root), `${path.basename(root)}-${ARCHIVE_WORD}-${today()}`);
  for (let n = 1; ; n++) {
    const p = n === 1 ? base : `${base}-${n}`;
    if (!exists(p) || (isDir(p) && !fs.lstatSync(p).isSymbolicLink())) return p;
  }
}
/** 겹치지 않는 이름: 폴더는 이름 전체 뒤에 " (2)", 파일은 확장자 앞에(점으로 시작하는 이름은 끝에). */
export function uniqueName(dir, name, folder) {
  if (!exists(path.join(dir, name))) return name;
  const ext = folder || /^\.[^.]*$/.test(name) ? '' : path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; ; n++) { const c = `${stem} (${n})${ext}`; if (!exists(path.join(dir, c))) return c; }
}
function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {
    // 읽기 전용 폴더 안은 지울 수 없다 — 쓰기 권한을 돌려준 뒤 한 번 더(연결은 따라가지 않음).
    const fix = (q) => { let st; try { st = fs.lstatSync(q); } catch { return; } if (st.isSymbolicLink() || !st.isDirectory()) return; try { fs.chmodSync(q, st.mode | 0o700); } catch {} for (const n of fs.readdirSync(q)) fix(path.join(q, n)); };
    fix(p);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
  return !exists(p);
}

// ---------------------------------------------------------------- 실행

export async function uninstall(opts) {
  const home = path.resolve(opts.home || os.homedir());
  const realHome = home === path.resolve(os.homedir());
  const scanRoots = (opts.root ? [opts.root] : (opts.scanRoots || [path.join(home, 'IRIS')])).map((r) => path.resolve(r));
  const workDir = path.resolve(opts.workDir || process.env.IRIS_INSTALLER_WORK_DIR || path.join(home, 'Library', 'Application Support', 'IRIS-Installer'));
  const log = opts.log || (() => {});
  const ui = opts.ui || null;

  // 연결(심볼릭 링크) 폴더도 여기서는 설치로 잡고, 아래 unsafeReason 이 그 이유로 거부한다(못 찾음으로 보이지 않게).
  const installs = scanRoots.filter((r) => exists(r) && readReceipt(r)).map((root) => ({ root, receipt: readReceipt(root) }));
  const rejected = scanRoots.filter((r) => exists(r) && !readReceipt(r));

  if (opts.scan) return { code: 0, scan: { installs: installs.map((i) => ({ root: i.root, version: i.receipt.packageVersion || i.receipt.version || null })), rejected, traces: outsideTraces(home, (s) => s && !exists(s)) } };

  if (!installs.length) {
    // 폴더는 없고 흔적만: 없어진 폴더를 가리키는 흔적만 뺀다. 작업 폴더만 남은 것은 흔적으로 치지 않는다(진행 중인 설치일 수 있다).
    const t = outsideTraces(home, (s) => s && !exists(s));
    if (traceCount(t)) {
      if (ui && !(await ui.confirmTraces(t))) return { code: 3 };
      if (opts.dryRun) return { code: 0, dryRun: true, traces: t };
      const done = await removeTraces(t, { home, realHome, launchctl: opts.launchctl, log });
      return { code: 0, tracesOnly: true, done };
    }
    if (rejected.length) { log(`영수증이 없어 지우지 않음: ${rejected.join(', ')}`); return { code: 2, reason: 'no-receipt', rejected }; }
    return { code: 2, reason: 'not-found' };
  }

  let target = installs[0];
  if (installs.length > 1) { if (!ui) return { code: 2, reason: 'several — use --root', installs: installs.map((i) => i.root) }; target = await ui.pick(installs); if (!target) return { code: 3 }; }
  const root = target.root;
  const why = unsafeReason(root, { home });
  if (why) { log(`거부: ${root} — ${why}`); return { code: 2, reason: why, root }; }

  const parts = classify(root);
  let mode = opts.mode;
  if (ui) { mode = await ui.chooseMode(root, parts); if (!mode) return { code: 3 }; if (mode === 'all' && !(await ui.confirmAll(parts))) return { code: 3 }; }
  mode = mode || 'keep';
  if (!['keep', 'all'].includes(mode)) return { code: 2, reason: `모르는 방식: ${mode}` };
  if (mode === 'all' && !ui && !opts.yes) return { code: 2, reason: '--mode all 은 --yes 가 있어야 합니다' };

  const traces = outsideTraces(home, (s) => s === root);
  const procs = processesFor([root, ...(isDir(workDir) ? [workDir] : [])]);
  const plan = { root, mode, system: parts.system, user: parts.user, traces, processes: procs.map((p) => ({ pid: p.pid, name: path.basename(p.comm) })) };
  if (opts.dryRun) { log(`미리보기: ${JSON.stringify(plan)}`); return { code: 0, dryRun: true, plan }; }

  const step = (s) => { log(`— ${s}`); ui?.step?.(s); };
  step('프로그램 끄기'); await stopProcesses(procs, log);
  step('자동 시작·명령 경로·앱 바로가기 빼기'); const traceDone = await removeTraces(traces, { home, realHome, launchctl: opts.launchctl, log });

  const moved = []; const failed = []; let archive = null;
  if (mode === 'keep' && parts.user.length) {
    step('내 작업 옮기기'); archive = archivePath(root); fs.mkdirSync(archive, { recursive: true });
    for (const name of parts.user) {
      const src = path.join(root, name); const dest = path.join(archive, uniqueName(archive, name, isDir(src)));
      try { fs.renameSync(src, dest); moved.push(name); log(`옮김 ${name} → ${dest}`); } catch (e) { failed.push(name); log(`옮기지 못함(그대로 둠) ${name}: ${e.code || e.message}`); }
    }
    // 루트 AGENTS.md 는 사용자가 규칙을 고쳤을 수 있어 사본을 둔다(같은 내용이면 건너뜀).
    const agents = path.join(root, 'AGENTS.md');
    if (exists(agents)) {
      const prev = path.join(archive, 'AGENTS.md');
      let same = false; try { same = fs.readFileSync(prev, 'utf8') === fs.readFileSync(agents, 'utf8'); } catch {}
      if (!same) { try { fs.copyFileSync(agents, path.join(archive, uniqueName(archive, 'AGENTS.md', false))); } catch {} }
    }
  }

  step('IRIS 가 깐 것 지우기');
  const doomed = [...parts.system, ...(mode === 'all' ? parts.user : [])];
  const receipt = path.join(root, RECEIPT_REL);
  for (const name of doomed) {
    if (name === '_agent') {
      // 영수증은 맨 마지막 — _agent 안에서 setup/package-receipt.json 만 남기고 지운다.
      for (const n of fs.readdirSync(path.join(root, '_agent'))) if (n !== 'setup') rmTree(path.join(root, '_agent', n));
      const setup = path.join(root, '_agent', 'setup');
      if (isDir(setup)) for (const n of fs.readdirSync(setup)) if (n !== 'package-receipt.json') rmTree(path.join(setup, n));
    } else rmTree(path.join(root, name));
  }
  const left = (() => {
    const out = [];
    for (const n of fs.readdirSync(root)) {
      if (n === '_agent') { const inside = (d) => fs.readdirSync(d); try { const a = inside(path.join(root, '_agent')); if (a.length > 1 || (a.length === 1 && a[0] !== 'setup') || inside(path.join(root, '_agent', 'setup')).some((x) => x !== 'package-receipt.json')) out.push('_agent'); } catch { out.push('_agent'); } }
      else if (doomed.includes(n) || failed.includes(n)) out.push(n);
    }
    return out;
  })();
  let rootRemoved = false;
  if (!left.length) {
    rmTree(path.join(root, '_agent'));
    if (dirEmpty(root)) { try { fs.rmdirSync(root); rootRemoved = true; } catch {} }
  } else log(`남은 것(영수증 유지 — 다시 실행하면 마저 지웁니다): ${left.join(', ')}`);

  // 설치기 작업 폴더: 이 Mac 에 다른 IRIS 설치가 하나도 안 남을 때만.
  let workRemoved = false;
  const others = scanRoots.filter((r) => r !== root && readReceipt(r));
  if (!left.length && !others.length && isDir(workDir) && unsafeReason(workDir, { home }) === null) { step('설치기 작업 폴더 지우기'); workRemoved = rmTree(workDir); }

  const code = left.length || failed.length ? 1 : 0;
  return { code, root, mode, archive, moved, failed, left, rootRemoved, receiptKept: exists(receipt), traces: traceDone, workRemoved, stopped: procs.length };
}

async function removeTraces(t, { home, realHome, launchctl, log }) {
  const done = { profiles: [], plist: false, apps: [] };
  for (const b of t.profiles) { try { if (removeProfileBlock(b.file)) { done.profiles.push(b.file); log(`명령 경로 덩어리 뺌: ${b.file}`); } } catch (e) { log(`덩어리를 빼지 못함 ${b.file}: ${e.message}`); } }
  if (t.plist) {
    // 진짜 홈일 때만 launchd 에서 내린다(시험 홈의 plist 는 launchd 가 모른다).
    if (launchctl && realHome) spawnSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${AGENT_LABEL}`], { stdio: 'ignore' });
    try { fs.rmSync(t.plist); done.plist = true; log(`자동 시작 뺌: ${t.plist}`); } catch {}
  }
  for (const a of t.apps) { if (rmTree(a.app)) { done.apps.push(a.app); log(`앱 바로가기 지움: ${a.app}`); } }
  return done;
}

// ---------------------------------------------------------------- 터미널 화면

function terminalUi() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res(String(a || '').trim())));
  const say = (s = '') => process.stdout.write(`${s}\n`);
  return {
    close: () => rl.close(),
    ask,
    say,
    step: (s) => say(`  · ${s}`),
    async pick(list) {
      say('IRIS 설치를 여러 개 찾았습니다.'); list.forEach((x, i) => say(`  ${i + 1}) ${x.root}`));
      const n = Number(await ask('지울 번호를 고르세요(그만두려면 엔터): ')); return list[n - 1] || null;
    },
    async chooseMode(root, parts) {
      say(''); say('이 Mac 에서 IRIS 를 지웁니다'); say('');
      say(`  지울 IRIS 폴더: ${root}`);
      say('  항상 지우는 것: IRIS 프로그램·설정(구독 로그인 정보·API 키·에이전트 기억·대화 기록 포함), 명령 경로, 자동 시작, 앱 바로가기');
      say(`  내 작업(${parts.user.length}개): ${parts.user.length ? parts.user.slice(0, 8).join(', ') + (parts.user.length > 8 ? ' …' : '') : '없음'}`);
      say('');
      say(`  1) 내 작업은 남기기(추천) — ${path.basename(archivePath(root))} 폴더로 옮깁니다`);
      say('  2) 전부 지우기 — 내 작업까지 지웁니다(되돌릴 수 없음)');
      say('  3) 그만두기');
      const a = await ask('고르세요 [1]: ');
      return a === '' || a === '1' ? 'keep' : a === '2' ? 'all' : null;
    },
    async confirmAll(parts) {
      say(''); say('정말 전부 지울까요? 아래 내 자료도 함께 지워지며 되돌릴 수 없습니다.');
      for (const n of parts.user.slice(0, 20)) say(`  - ${n}`);
      return (await ask('계속하려면 "지우기" 라고 입력하세요: ')) === '지우기';
    },
    async confirmTraces(t) {
      say('IRIS 폴더는 이미 없고 설정 흔적만 남아 있습니다.');
      for (const b of t.profiles) say(`  - 명령 경로 덩어리: ${b.file}`);
      if (t.plist) say(`  - 자동 시작: ${t.plist}`);
      for (const a of t.apps) say(`  - 앱 바로가기: ${a.app}`);
      const a = await ask('흔적을 지울까요? [Y/n]: '); return a === '' || /^y/i.test(a);
    },
  };
}

function report(r, say) {
  say('');
  if (r.code === 0 && r.tracesOnly) say('설정 흔적을 지웠습니다.');
  else if (r.code === 0 && r.dryRun) say('미리보기만 했습니다(아무것도 바꾸지 않음).');
  else if (r.code === 0) {
    say('IRIS 를 지웠습니다.');
    if (r.archive) say(`  내 작업은 여기로 옮겼습니다: ${r.archive}`);
    say('  다시 설치하려면 설치 zip 의 IRIS-설치.command 를 두 번 누르세요.');
    say('  구독 해지는 Mac 에서 할 수 없습니다 — claude.ai · chatgpt.com 에서 따로 하세요.');
    say('  열려 있던 터미널은 닫고 새로 여세요(명령 경로가 바뀌었습니다).');
  } else if (r.code === 1) {
    say('일부를 지우지 못했습니다.');
    for (const n of [...(r.failed || []), ...(r.left || [])]) say(`  - ${n}`);
    say('  그 파일을 쓰는 프로그램을 닫고 한 번 더 실행하세요. 그래도 남으면 Mac 을 다시 시작한 뒤 한 번 더.');
  } else if (r.code === 2) say(r.reason === 'not-found' ? '이 Mac 에서 IRIS 를 찾지 못했습니다.' : `지우지 않았습니다: ${r.reason}`);
  else if (r.code === 3) say('그만두었습니다. 아무것도 바꾸지 않았습니다.');
}

// 한 번에 하나만(Windows 의 이름 있는 뮤텍스 자리). 주인 PID 가 죽었으면 낡은 잠금으로 보고 넘긴다.
function takeLock(file) {
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return () => { try { fs.rmSync(file); } catch {} }; } catch {}
    const pid = Number(fs.readFileSync(file, 'utf8')); let alive = false; try { process.kill(pid, 0); alive = pid > 0; } catch {}
    if (alive) return null;
    try { fs.rmSync(file); } catch {}
  }
  return null;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const logFile = o.log || path.join(os.tmpdir(), `IRIS-uninstall-${stamp}.log`);
  const log = (m) => { const line = `${new Date().toISOString().slice(11, 19)}  ${m}`; try { fs.appendFileSync(logFile, line + '\n'); } catch {} if (!o.ui) process.stdout.write(line + '\n'); };
  const home = path.resolve(o.home || os.homedir());
  const lockFile = o.lock || (home === path.resolve(os.homedir()) ? path.join(os.tmpdir(), `IRIS-uninstaller-${process.getuid()}.lock`) : path.join(home, '.iris-uninstaller.lock'));
  const release = takeLock(lockFile);
  if (!release) { process.stdout.write('IRIS 삭제기가 이미 실행 중입니다.\n'); process.exit(4); }
  const ui = o.ui ? terminalUi() : null;
  let r;
  try { r = await uninstall({ ...o, ui, log }); }
  catch (e) { log(`오류: ${e.stack || e}`); r = { code: 4, reason: String(e.message || e) }; }
  finally { release(); }
  if (ui) { report(r, ui.say); ui.say(`  기록: ${logFile}`); await ui.ask('\n엔터를 누르면 이 창을 닫을 수 있습니다.'); ui.close(); }
  else process.stdout.write(`RESULT ${JSON.stringify(r)}\n`);
  process.exit(r.code);
}

// 진입: $TMPDIR 은 /var → /private/var 연결이라 실제 경로끼리 비교한다(.command 가 임시 폴더 사본을 돌린다).
const isEntry = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isEntry()) main();
