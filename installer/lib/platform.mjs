// 운영체제 계층 (docs/설계-macOS.md D-M01).
//
// Windows 와 macOS 가 갈리는 "어디에 무엇이 있는가"를 이 파일 한 곳에 모은다.
// 다른 모듈은 `process.platform` 을 직접 보지 않고 여기 함수를 부른다.
//
// 함수마다 `platform` 을 인자로 받는다(기본값 = 지금 PC). 경로도 그 운영체제의
// 규칙(`path.win32` / `path.posix`)으로 만들기 때문에, Windows 판 결과를 Mac 에서,
// Mac 판 결과를 Windows 에서 그대로 시험할 수 있다. Windows 에서 기본값으로
// 부르면 지금까지의 `path.join` 결과와 글자 하나 다르지 않다.
import os from 'node:os';
import path from 'node:path';

export const WIN32 = 'win32';
export const DARWIN = 'darwin';

export function isWindows(platform = process.platform) { return platform === WIN32; }
export function isMac(platform = process.platform) { return platform === DARWIN; }

/** 그 운영체제의 path 모듈. */
export function pathFor(platform = process.platform) {
  return isWindows(platform) ? path.win32 : path.posix;
}

/** PATH 칸 구분자. */
export function pathDelimiter(platform = process.platform) {
  return isWindows(platform) ? ';' : ':';
}

/**
 * 잠금표·빌드가 쓰는 대상 이름(`win32-x64`, `darwin-arm64`).
 * Rosetta 아래의 x64 node 도 Apple Silicon Mac 이므로 Mac 은 늘 arm64 로 본다 —
 * Intel Mac 을 가려내는 일은 준비 검사가 `sysctl` 로 따로 한다(D-M02).
 */
export function hostTarget({ platform = process.platform, arch = process.arch } = {}) {
  if (isWindows(platform)) return `win32-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (isMac(platform)) return 'darwin-arm64';
  return `${platform}-${arch}`;
}

/**
 * 영혼(설치) 폴더. Windows = `C:\<이름>`(D2-07), macOS = `~/<이름>`(D-M03).
 * 이름 검사는 soulname.mjs 가 하고, 여기서는 자리만 정한다.
 */
export function soulRootFor(name, { platform = process.platform, homedir = os.homedir() } = {}) {
  if (isWindows(platform)) return `C:\\${name}`;
  return path.posix.join(homedir, name);
}

/**
 * 설치기 작업 폴더(로그·state.json·server.pid·풀어 둔 node).
 * Windows 는 지금까지와 같다(`%LOCALAPPDATA%\IRIS-Installer`, 없으면 임시 폴더).
 */
export function installerWorkDir({ platform = process.platform, env = process.env, homedir = os.homedir(), tmpdir = os.tmpdir() } = {}) {
  const p = pathFor(platform);
  if (isWindows(platform)) {
    return env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'IRIS-Installer') : p.join(tmpdir, 'IRIS-Installer');
  }
  // IRIS_INSTALLER_WORK_DIR: 시험·연습용 손잡이(bootstrap.sh 도 같은 값을 본다) — 진짜
  // ~/Library 를 건드리지 않고 겉옷부터 서버까지 끝까지 돌려 볼 수 있게.
  if (isMac(platform)) return env.IRIS_INSTALLER_WORK_DIR || p.join(homedir, 'Library', 'Application Support', 'IRIS-Installer');
  return p.join(tmpdir, 'IRIS-Installer');
}

/**
 * 동봉 부품의 실행 파일 자리(docs/설계-macOS.md 2절 표).
 *
 *   toolsDir = <root>/_agent/shared/tools (또는 설치기 작업 폴더의 node 처럼 따로 둔 곳)
 *
 * `binDirs` 는 자식 프로세스 PATH 앞자리에 붙일 폴더들 — 순서가 곧 우선순위다.
 */
export function toolLayout(toolsDir, { platform = process.platform } = {}) {
  const p = pathFor(platform);
  const t = (...xs) => p.join(toolsDir, ...xs);
  if (isWindows(platform)) {
    return {
      nodeDir: t('node'),
      node: t('node', 'node.exe'),
      python: t('python', 'python.exe'),
      pythonScripts: t('python', 'Scripts'),
      git: t('git', 'cmd', 'git.exe'),
      codex: t('codex', 'codex.cmd'),
      claude: t('claude', 'claude.cmd'),
      binDirs: [t('node'), t('git', 'cmd'), t('python')],
    };
  }
  // macOS: npm 부품(codex·teamclaude…)은 `-g` 없이 `--prefix` 로 깔아 node_modules 자리가
  // Windows 와 같다(build/collect.mjs). codex 는 npm 의 .bin 링크 대신 진입 파일을 동봉 node 로 부른다.
  // git/bin 은 PATH 에 넣지 않는다 — dugite git 은 심이 환경변수를 걸어 줘야 온전하다(shims.mjs).
  return {
    nodeDir: t('node'),
    node: t('node', 'bin', 'node'),
    python: t('python', 'bin', 'python3'),
    pythonScripts: t('python', 'bin'),
    git: t('git', 'bin', 'git'),
    codex: t('codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    claude: t('claude', 'claude'),
    binDirs: [t('node', 'bin'), t('python', 'bin')],
  };
}

/** node 압축을 풀어 둔 폴더(nodeDir) 안의 node 실행 파일. */
export function nodeBinIn(nodeDir, { platform = process.platform } = {}) {
  const p = pathFor(platform);
  return isWindows(platform) ? p.join(nodeDir, 'node.exe') : p.join(nodeDir, 'bin', 'node');
}

/** venv 안의 python. */
export function venvPython(venvDir, { platform = process.platform } = {}) {
  const p = pathFor(platform);
  return isWindows(platform) ? p.join(venvDir, 'Scripts', 'python.exe') : p.join(venvDir, 'bin', 'python');
}

/** 심 파일 이름. Windows = `<이름>.cmd`, macOS = 확장자 없음(D-M07). */
export function shimFileName(name, { platform = process.platform } = {}) {
  return isWindows(platform) ? `${name}.cmd` : name;
}
