// 사용자 환경 — macOS (docs/설계-macOS.md D-M08·D-M09).
//
// Windows userpath.mjs(HKCU\Environment·Run 키)와 **같은 이름·같은 모양의 함수**를 낸다.
// 세팅 엔진(setup/unpack.mjs runEnv)은 운영체제를 모른 채 이 함수들을 부른다.
//
//   PATH      `~/.zprofile`(있으면 `~/.bash_profile` 도)에 표시된 한 덩어리
//             (`# >>> IRIS >>>` … `# <<< IRIS <<<`)로 심 폴더 하나만 앞에 더한다.
//             그 덩어리 밖의 줄은 한 글자도 건드리지 않는다.
//   변수 네 개  걸지 않는다 — 심이 실행될 때 스스로 건다(D-M08). 이미 Claude Code 를 쓰는
//             Mac 에서 그 사람의 설정 폴더·중계기 주소를 바꾸지 않기 위해서다.
//   자동 시작  `~/Library/LaunchAgents/com.iris-workspace.relay.plist`(D-M09).
//
// 홈 폴더와 fs 는 주입할 수 있다 — 시험이 진짜 홈의 파일을 건드리지 않게.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BLOCK_BEGIN = '# >>> IRIS >>>';
export const BLOCK_END = '# <<< IRIS <<<';
export const LAUNCH_AGENT_LABEL = 'com.iris-workspace.relay';

/** sh 큰따옴표 안에 그대로 넣을 수 있게 \ " $ ` 를 막는다. */
function shDq(s) {
  return String(s).replace(/([\\"$`])/g, '\\$1');
}

/** PATH 덩어리. 프로필이 여러 번 읽혀도(중첩 셸) PATH 가 불어나지 않게 이미 있으면 넘긴다. */
export function renderPathBlock(dir) {
  const d = shDq(dir);
  return [
    BLOCK_BEGIN,
    '# Managed by the IRIS installer: puts the IRIS commands (claude, codex, ...) on PATH.',
    '# The IRIS uninstaller removes this block; nothing outside it is ever changed.',
    `case ":$PATH:" in *":${d}:"*) ;; *) export PATH="${d}:$PATH" ;; esac`,
    BLOCK_END,
  ].join('\n');
}

function findBlock(text) {
  const begin = text.indexOf(BLOCK_BEGIN);
  if (begin < 0) return null;
  const endAt = text.indexOf(BLOCK_END, begin);
  if (endAt < 0) return null;
  return { begin, end: endAt + BLOCK_END.length };
}

/** 덩어리를 넣거나(없으면 끝에) 바꾼다. → { text, changed } */
export function upsertBlock(text, block) {
  const src = String(text ?? '');
  const at = findBlock(src);
  if (at) {
    if (src.slice(at.begin, at.end) === block) return { text: src, changed: false };
    return { text: src.slice(0, at.begin) + block + src.slice(at.end), changed: true };
  }
  const sep = src.length === 0 ? '' : (src.endsWith('\n') ? '\n' : '\n\n');
  return { text: `${src}${sep}${block}\n`, changed: true };
}

/** 덩어리를 뺀다(앞뒤로 우리가 더한 빈 줄 하나까지). → { text, changed } */
export function removeBlock(text) {
  const src = String(text ?? '');
  const at = findBlock(src);
  if (!at) return { text: src, changed: false };
  let before = src.slice(0, at.begin);
  let after = src.slice(at.end);
  if (after.startsWith('\n')) after = after.slice(1);
  if (before.endsWith('\n\n') && after === '') before = before.slice(0, -1);
  return { text: before + after, changed: true };
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 로그온 자동 시작 plist. relay-ensure.mjs 는 중계기를 떼어 띄우고 곧 끝나므로
 * `AbandonProcessGroup` 으로 launchd 가 남은 프로세스를 정리하지 않게 한다.
 */
export function renderLaunchAgent(programArgs, { label = LAUNCH_AGENT_LABEL } = {}) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArgs.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>AbandonProcessGroup</key><true/>',
    '  <key>ProcessType</key><string>Background</string>',
    '  <key>StandardOutPath</key><string>/dev/null</string>',
    '  <key>StandardErrorPath</key><string>/dev/null</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function createDarwinUserEnv({ homedir = os.homedir(), fs = nodeFs } = {}) {
  const zprofile = path.join(homedir, '.zprofile');
  const bashProfile = path.join(homedir, '.bash_profile');
  const agentPlist = path.join(homedir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);

  // zsh(기본 셸)는 늘, bash 는 그 사람이 이미 bash 프로필을 쓸 때만.
  const profiles = () => [zprofile, ...(fs.existsSync(bashProfile) ? [bashProfile] : [])];

  // 점 파일 관리 도구가 프로필을 심볼릭 링크로 두는 일이 흔하다 — 링크를 파일로
  // 바꿔치지 않도록 진짜 대상에 쓴다. 권한도 그대로 둔다.
  function rewrite(file, edit) {
    let target = file;
    let text = '';
    let mode = 0o644;
    if (fs.existsSync(file)) {
      target = fs.realpathSync(file);
      text = fs.readFileSync(target, 'utf8');
      mode = fs.statSync(target).mode & 0o777;
    }
    const r = edit(text);
    if (!r.changed) return false;
    const tmp = `${target}.iris-tmp`;
    fs.writeFileSync(tmp, r.text, { encoding: 'utf8', mode });
    fs.renameSync(tmp, target);
    return true;
  }

  return {
    profiles,
    agentPlist,

    async addUserPath(dir) {
      const block = renderPathBlock(dir);
      const files = profiles();
      const touched = files.filter((f) => rewrite(f, (t) => upsertBlock(t, block)));
      return { changed: touched.length > 0, before: null, after: dir, files };
    },

    async removeUserPath() {
      const files = [zprofile, bashProfile].filter((f) => fs.existsSync(f));
      const touched = files.filter((f) => rewrite(f, (t) => removeBlock(t)));
      return { changed: touched.length > 0, before: null, after: null, files: touched };
    },

    // D-M08: 전역 변수는 걸지 않는다(심이 건다). 영수증 previous 가 비어 있게 null.
    async setUserEnv() {
      return { changed: false, previous: null, scope: 'shims' };
    },
    async removeUserEnv() {
      return { changed: false, previous: null };
    },
    async readUserEnv() {
      return { exists: false, type: null, value: null };
    },

    /** Windows 의 Run 키 자리. `command` = ProgramArguments 배열. → { changed, previous } */
    async setRunKey(_name, command) {
      const args = Array.isArray(command) ? command : [String(command)];
      const text = renderLaunchAgent(args);
      let previous = null;
      try { previous = fs.readFileSync(agentPlist, 'utf8'); } catch { /* 처음 */ }
      if (previous === text) return { changed: false, previous: agentPlist };
      fs.mkdirSync(path.dirname(agentPlist), { recursive: true });
      fs.writeFileSync(agentPlist, text, 'utf8');
      return { changed: true, ...(previous != null ? { previous: agentPlist } : {}) };
    },

    async removeRunKey() {
      try {
        fs.rmSync(agentPlist);
        return { removed: true };
      } catch {
        return { removed: false };
      }
    },
  };
}

// `import * as userenv` 로 userpath.mjs 와 같이 쓸 수 있게, 진짜 홈에 묶인 함수들.
const real = () => createDarwinUserEnv();
export const addUserPath = (...a) => real().addUserPath(...a);
export const removeUserPath = (...a) => real().removeUserPath(...a);
export const setUserEnv = (...a) => real().setUserEnv(...a);
export const removeUserEnv = (...a) => real().removeUserEnv(...a);
export const readUserEnv = (...a) => real().readUserEnv(...a);
export const setRunKey = (...a) => real().setRunKey(...a);
export const removeRunKey = (...a) => real().removeRunKey(...a);
