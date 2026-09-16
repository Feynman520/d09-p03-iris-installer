import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Task 20: payload-src/policy/ is the single source for the root instruction
// file, the mini-instruction templates, the human-readable policy summary, the
// "install won't start" notice and the two global PreToolUse hooks that go into
// a new user's soul. Nothing here is code, so these checks are what keep it
// honest: size, section order, zero personal strings, BOM/encoding, and the
// ASCII-only constraint the .ps1 hook depends on (it runs under PS 5.1 without
// a BOM, so a single non-ASCII byte would corrupt it).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = path.resolve(HERE, '..', 'payload-src', 'policy');

const ROOT_AGENTS_MAX_LINES = 260;

// Every heading the design doc (docs/설계-v2.md section 9) requires, in the
// order it requires them.
const REQUIRED_SECTIONS = [
  '# IRIS Workspace — 전역 지침',
  '## 사용자 응대',
  '## 쉽고 명료한 설명',
  '## 안전',
  '## 설계 우선',
  '## 🔴 중계기 항상 경유 — 직결 금지',
  '## 🔴 프로세스 종료',
  '## 파일 쓰기 경로 검증',
  '## 결과물 전달',
  '## 폴더 계층',
  '## 태그 용도',
  '## 목록 카드와 정본',
  '## 조회·갱신·검사',
  '## 지침과 작업 범위',
  '## 도구 규칙',
  '## 윈도·한글 환경 기술 규칙',
  '## 자기개선 규칙 (자동 적용)',
];

// Written split-and-joined on purpose: this test file is itself git-tracked and
// gets scanned by tests/repo-clean.test.mjs with the developer's real personal
// strings, so a literal occurrence here would trip that scan (same trick as
// tests/sanitize.test.mjs's synthetic marker).
const FORBIDDEN_LITERALS = [
  ['se', 'junham'],
  ['Feynman', '520'],
  ['shin', 'jang'],
  ['함', '세준'],
  ['신', '장고'],
  ['@', 'gmail.com'],
  ['C:\\', 'Users\\'],
].map((parts) => parts.join(''));

const EMAIL_RE = new RegExp('[A-Za-z0-9._%+-]+' + '@' + '[A-Za-z0-9.-]+\\.[a-z]{2,}');

function policyFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(POLICY);
  return out.sort();
}

const read = (rel) => fs.readFileSync(path.join(POLICY, rel), 'utf8');
const readBytes = (rel) => fs.readFileSync(path.join(POLICY, rel));

test('policy: every expected source file exists', () => {
  for (const rel of [
    'root-AGENTS.md',
    'mini-AGENTS.md',
    'mini-AGENTS-util.md',
    'CLAUDE.md',
    'policy-summary.md',
    'install-notice.txt',
    'ontology-registry-template.yml',
    'README.md',
    path.join('hooks', 'block-blanket-kill.ps1'),
    path.join('hooks', 'block-blanket-kill.test.py'),
    path.join('hooks', 'guard-iris-path.py'),
    path.join('hooks', 'guard-iris-path.test.py'),
  ]) {
    assert.ok(fs.existsSync(path.join(POLICY, rel)), `missing policy file: ${rel}`);
  }
});

test(`policy: root-AGENTS.md stays at or under ${ROOT_AGENTS_MAX_LINES} lines`, () => {
  const lines = read('root-AGENTS.md').split('\n');
  // trailing newline produces one empty last element -- do not count it
  const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  assert.ok(
    count <= ROOT_AGENTS_MAX_LINES,
    `root-AGENTS.md is ${count} lines (max ${ROOT_AGENTS_MAX_LINES}) -- trim it, a rule nobody reads is not a rule`,
  );
});

test('policy: root-AGENTS.md carries every required section, in order', () => {
  const text = read('root-AGENTS.md');
  const headings = text.split('\n').filter((l) => /^#{1,2} /.test(l));
  let cursor = 0;
  for (const wanted of REQUIRED_SECTIONS) {
    const at = headings.indexOf(wanted, cursor);
    assert.notEqual(at, -1, `missing (or out of order) section heading: ${wanted}`);
    cursor = at + 1;
  }
});

test('policy: root-AGENTS.md has the self-improve markers around its empty rule section', () => {
  const text = read('root-AGENTS.md');
  const begin = text.indexOf('<!-- self-improve:begin');
  const end = text.indexOf('<!-- self-improve:end -->');
  const section = text.indexOf('## 자기개선 규칙 (자동 적용)');
  assert.ok(begin !== -1, 'missing <!-- self-improve:begin --> marker');
  assert.ok(end !== -1, 'missing <!-- self-improve:end --> marker');
  assert.ok(begin < section && section < end, 'the empty rule section must sit between the two markers');
});

test('policy: no personal string, email or user-profile path anywhere in payload-src/policy', () => {
  const hits = [];
  for (const file of policyFiles()) {
    const rel = path.relative(POLICY, file);
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const needle of FORBIDDEN_LITERALS) {
        if (line.includes(needle)) hits.push(`${rel}:${i + 1} forbidden literal`);
      }
      if (EMAIL_RE.test(line)) hits.push(`${rel}:${i + 1} email-shaped string`);
    });
  }
  assert.deepEqual(hits, [], `personal data in policy sources:\n${hits.join('\n')}`);
});

test('policy: every source file is UTF-8 with LF endings (only install-notice.txt carries a BOM)', () => {
  for (const file of policyFiles()) {
    const rel = path.relative(POLICY, file);
    const buf = fs.readFileSync(file);
    // .ps1/.cmd are CRLF in the working tree by this repo's .gitattributes
    // (PowerShell 5.1 / cmd.exe convention); everything else must stay LF-only
    // so a checkout on any platform produces byte-identical policy text.
    if (!/\.(ps1|cmd)$/i.test(rel)) {
      assert.equal(buf.includes(0x0d), false, `${rel} contains CR -- policy sources must be LF-only`);
    }
    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    assert.equal(hasBom, rel === 'install-notice.txt', `${rel}: unexpected BOM state`);
  }
});

test('policy: install-notice.txt has exactly one BOM, at the very start', () => {
  const buf = readBytes('install-notice.txt');
  assert.ok(buf.length > 0, 'install-notice.txt is empty');
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'install-notice.txt must start with a UTF-8 BOM (Notepad)');
  let count = 0;
  for (let i = 0; i + 2 < buf.length; i += 1) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbb && buf[i + 2] === 0xbf) count += 1;
  }
  assert.equal(count, 1, `install-notice.txt contains ${count} BOM sequences -- exactly one is allowed`);
});

test('policy: install-notice.txt names both SAC routes, the log path and the homepage anchor', () => {
  const text = read('install-notice.txt');
  for (const needle of [
    '차단 해제',
    'cmd /c IRIS-설치.cmd',
    '%LOCALAPPDATA%\\IRIS-Installer\\bootstrap.log',
    'https://iris-workspace.com/install.html#sac',
  ]) {
    assert.ok(text.includes(needle), `install-notice.txt must mention: ${needle}`);
  }
});

test('policy: mini templates keep their placeholders and the no-restatement guard', () => {
  for (const rel of ['mini-AGENTS.md', 'mini-AGENTS-util.md']) {
    const text = read(rel);
    assert.ok(text.includes('{{folderName}}'), `${rel} lost the {{folderName}} placeholder`);
    assert.ok(text.includes('{{identity}}'), `${rel} lost the {{identity}} placeholder`);
    assert.match(text, /<!--[^>]*재서술 금지[^>]*-->/, `${rel} lost the "do not restate parent rules" comment`);
    assert.match(text, /^# \{\{folderName\}\}$/m, `${rel} must open with the folder-name heading`);
  }
});

test('policy: CLAUDE.md is the one-line @AGENTS.md shim', () => {
  assert.equal(read('CLAUDE.md').trim(), '@' + 'AGENTS.md');
});

test('policy: hooks/*.ps1 are pure ASCII (PS 5.1 reads them without a BOM)', () => {
  const hooksDir = path.join(POLICY, 'hooks');
  const ps1 = fs.readdirSync(hooksDir).filter((f) => f.toLowerCase().endsWith('.ps1'));
  assert.ok(ps1.length > 0, 'no .ps1 hook found under payload-src/policy/hooks');
  for (const name of ps1) {
    const buf = fs.readFileSync(path.join(hooksDir, name));
    const bad = [];
    for (let i = 0; i < buf.length; i += 1) if (buf[i] > 0x7f) bad.push(i);
    assert.deepEqual(
      bad.slice(0, 5),
      [],
      `hooks/${name} has ${bad.length} non-ASCII byte(s) (first at offset ${bad[0]}) -- rewrite comments/strings in English`,
    );
  }
});

test('policy: licenses/ exists and its README states who fills it (auto vs manual)', () => {
  // The per-part license copies are collected by the build (T07); this folder
  // is also where the manual ones go -- the parts whose license text lives only
  // in a README (ui-ux-pro-max's CC-BY-NC-4.0 skill assets) and would otherwise
  // be collected as nothing at all. Git cannot track an empty folder, so the
  // README is what makes the directory ship.
  const dir = path.join(POLICY, 'licenses');
  assert.ok(fs.statSync(dir).isDirectory(), 'payload-src/policy/licenses/ must exist');
  const text = read(path.join('licenses', 'README.md'));
  assert.match(text, /자동/, 'licenses/README.md must say which copies are collected automatically');
  assert.match(text, /수동/, 'licenses/README.md must say which copies are added by hand');
  assert.ok(text.includes('ui-ux-pro-max'), 'licenses/README.md must list the ui-ux-pro-max manual item');
  assert.ok(text.includes('CC-BY-NC-4.0'), 'licenses/README.md must keep the CC-BY-NC-4.0 non-commercial notice');
  assert.ok(
    read('README.md').includes('licenses\\'),
    'payload-src/policy/README.md must mention the licenses\\ folder',
  );
});

test('policy: the ontology registry template ships empty (structure only, no entries, no secrets)', () => {
  const text = read('ontology-registry-template.yml');
  for (const key of ['tools:', 'stores:', 'accounts:', 'persons:', 'memory_stores:']) {
    assert.ok(text.includes(key), `registry template is missing the ${key} section`);
  }
  // no card ids, and every collection is an empty literal
  assert.equal(/iris:[a-z0-9]{8}/.test(text), false, 'registry template must not carry a card id');
  for (const empty of ['tools: {}', 'stores: {}', 'accounts: {}', 'persons: {}', 'memory_stores: []']) {
    assert.ok(text.includes(empty), `registry template must ship ${empty} (zero entries)`);
  }
});
