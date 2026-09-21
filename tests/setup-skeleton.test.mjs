import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as skeleton from '../installer/setup/skeleton.mjs';
import { assertInside } from '../installer/lib/paths.mjs';
import { partDir, partPath, partBasename } from '../installer/lib/payload.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_SRC = path.join(REPO, 'payload-src', 'policy');

// Real temp folders (contract: 두 번 실행 변경 0 is only meaningful on a real
// file system). IRIS_TEST_TMP lets a session point this at its scratchpad.
const tmp = fs.mkdtempSync(path.join(process.env.IRIS_TEST_TMP || os.tmpdir(), 'iris-t14-skel-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const SPEC_NAME = 'IRIS-온톨로지.md';
const ONTOLOGY_FILES = ['build_graph.py', 'validate.py', 'query.py', 'render_view.py', 'check_fresh.py', 'view_data.py'];

// 가짜 payload: 진짜 payload-src\policy 파일 + 최소 manifest 객체.
function makePayload(label) {
  const dir = path.join(tmp, label, 'payload');
  const put = (rel, body) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  fs.mkdirSync(path.join(dir, 'policy'), { recursive: true });
  for (const f of ['root-AGENTS.md', 'CLAUDE.md', 'mini-AGENTS.md', 'mini-AGENTS-util.md', 'ontology-registry-template.yml', 'interview.md']) {
    fs.copyFileSync(path.join(POLICY_SRC, f), path.join(dir, 'policy', f));
  }
  put(path.join('policy', '_cosmos.ico'), Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]));
  for (const f of ONTOLOGY_FILES) put(path.join('setup', 'ontology', f), `# ${f}\n`);
  put(path.join('setup', 'ontology', 'view_app.js'), '// view\n');
  put(path.join('setup', SPEC_NAME), '# 온톨로지 명세서\n');
  put(path.join('tools', 'hwpx-templates', 'IRIS-HWPX-기본양식-스타일.md'), '# 스타일\n');
  put(path.join('tools', 'hwpx-templates', 'iris_hwpx_layout.py'), '# layout\n');

  const manifest = {
    schema: 1,
    package: { version: '2.0.0' },
    parts: {
      pyyaml: { file: 'runtime/PyYAML-6.0.3-cp312-cp312-win_amd64.whl', version: '6.0.3' },
      // 잠금표대로 zip 이름을 적어 둔다 -- partDir 이 폴더 모양으로 풀어 찾는지 확인.
      ontology: { file: 'setup/ontology.zip' },
      'ontology-spec': { file: `setup/${SPEC_NAME}` },
      'folder-icon': { file: 'policy/_cosmos.ico' },
      'hwpx-templates': { file: 'tools/hwpx-templates.zip' },
    },
  };
  return { payloadDir: dir, manifest };
}

function makeCtx(label, { root: rootOverride, decisions } = {}) {
  const { payloadDir, manifest } = makePayload(label);
  const root = rootOverride ?? path.join(tmp, label, 'soul-IRIS');
  const logs = [];
  const runCalls = [];
  return {
    root,
    payloadDir,
    manifest,
    decisions: decisions ?? { later: true, nodes: [] },
    choice: { subscriptions: ['claude'], leadAgent: 'claude' },
    offline: true,
    log: (line) => logs.push(line),
    progress: () => {},
    run: async (exe, args) => { runCalls.push([exe, ...args]); return { code: 0, out: '', err: '' }; },
    fs,
    env: process.env,
    logs,
    runCalls,
  };
}

// 폴더 전체 지문: 경로 + 크기 + mtime + 내용 해시.
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const here = rel ? path.join(dir, rel) : dir;
    for (const e of fs.readdirSync(here, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { out[`${childRel}\\`] = 'dir'; walk(childRel); continue; }
      const st = fs.statSync(path.join(dir, childRel));
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, childRel))).digest('hex');
      out[childRel] = `${st.size}:${st.mtimeMs}:${hash}`;
    }
  };
  walk('');
  return out;
}

// ---------------------------------------------------------------------------

test('skeleton: 빈 루트 -> 표지·지침·폴더·온톨로지·아이콘을 전부 만든다', async () => {
  const ctx = makeCtx('fresh');
  const { recorded, pending } = await skeleton.run(ctx);
  const at = (...s) => path.join(ctx.root, ...s);

  assert.deepEqual(pending, []);

  // soul-state.json: v2 표지
  const state = JSON.parse(fs.readFileSync(at('soul-state.json'), 'utf8'));
  assert.equal(state.schemaVersion, 7);
  assert.equal(state.packageInstall, true);
  assert.equal(state.packageVersion, '2.0.0');
  assert.ok(!('guideVersion' in state), 'v2 표지에는 guideVersion 이 없어야 한다');
  assert.ok(!('version' in (state.sourceGuide ?? {})), 'sourceGuide.version(= 옛 guideVersion)도 없어야 한다');
  assert.ok(state.soulId && state.createdAt);
  assert.equal(recorded.soulState.status, 'created');

  // 루트 지침
  assert.equal(
    fs.readFileSync(at('AGENTS.md'), 'utf8'),
    fs.readFileSync(path.join(POLICY_SRC, 'root-AGENTS.md'), 'utf8'),
  );
  assert.equal(fs.readFileSync(at('CLAUDE.md'), 'utf8').trim(), '@AGENTS.md');
  assert.equal(recorded.rootAgentsKept, false);

  // 폴더
  for (const d of ['_agent', '_agent\\claude', '_agent\\codex', '_agent\\shared', '_agent\\setup',
    '_ontology', '_trash', '_cleanup', '_document-templates']) {
    assert.ok(fs.statSync(at(...d.split('\\'))).isDirectory(), `${d} 폴더가 없다`);
  }
  assert.ok(!fs.existsSync(at('_map-generator')), '_map-generator 는 2026-09-10 퇴역이라 만들지 않는다');

  // _ontology 내용물
  for (const f of ONTOLOGY_FILES) assert.ok(fs.existsSync(at('_ontology', f)), `${f} 없음`);
  assert.ok(fs.existsSync(at('_ontology', 'registry.yml')));
  assert.equal(fs.readFileSync(at('_ontology', 'requirements.txt'), 'utf8'), 'PyYAML==6.0.3\n');
  assert.equal(recorded.ontology.registry, 'created');
  assert.equal(recorded.ontology.spec, SPEC_NAME);

  // 명세서는 잠금표가 정한 원래 이름으로 루트에
  assert.ok(fs.existsSync(at(SPEC_NAME)));

  // _document-templates
  assert.ok(fs.existsSync(at('_document-templates', 'iris_hwpx_layout.py')));
  assert.equal(recorded.documentTemplates.status, 'copied');

  // `_`폴더 미니 지침: 치환이 끝나 있어야 한다
  for (const f of skeleton.UTIL_FOLDERS) {
    const body = fs.readFileSync(at(f.name, 'AGENTS.md'), 'utf8');
    assert.ok(body.startsWith(`# ${f.name}`), `${f.name}\\AGENTS.md 머리글 틀림`);
    assert.ok(body.includes(f.identity), `${f.name} 정체성 한 줄 없음`);
    assert.ok(!body.includes('{{'), `${f.name}\\AGENTS.md 에 치환 안 된 자리표시자가 남았다`);
    assert.equal(fs.readFileSync(at(f.name, 'CLAUDE.md'), 'utf8').trim(), '@AGENTS.md');
  }
  assert.equal(recorded.miniGuides.created.length, skeleton.UTIL_FOLDERS.length * 2);

  // 아이콘
  assert.ok(fs.existsSync(at('_cosmos.ico')));
  const ini = fs.readFileSync(at('desktop.ini'));
  assert.deepEqual([...ini.subarray(0, 2)], [0xff, 0xfe], 'desktop.ini 는 UTF-16LE BOM 으로 시작해야 한다');
  const iniText = ini.subarray(2).toString('utf16le');
  assert.equal(iniText, `[.ShellClassInfo]\r\nIconResource=${at('_cosmos.ico')},0\r\n`);
  assert.equal(recorded.icon.attributes, 'set');
  assert.deepEqual(ctx.runCalls, [
    ['attrib', '+s', '+h', at('desktop.ini')],
    ['attrib', '+h', at('_cosmos.ico')],
    ['attrib', '+r', ctx.root],
  ]);

  assert.deepEqual(recorded.missing, []);
});

test('skeleton: 두 번 실행해도 변경 0 (내용·크기·mtime 동일, attrib 재실행 없음)', async () => {
  const ctx = makeCtx('twice');
  await skeleton.run(ctx);
  const before = snapshot(ctx.root);
  const callsAfterFirst = ctx.runCalls.length;

  const second = await skeleton.run(ctx);
  const after2 = snapshot(ctx.root);

  assert.deepEqual(after2, before, '두 번째 실행이 파일을 바꿨다');
  assert.equal(ctx.runCalls.length, callsAfterFirst, '두 번째 실행이 attrib 을 다시 걸었다');
  assert.equal(second.recorded.soulState.status, 'kept');
  assert.equal(second.recorded.dirs.created.length, 0);
  assert.equal(second.recorded.files.created.length, 0);
  assert.equal(second.recorded.miniGuides.created.length, 0);
  assert.equal(second.recorded.icon.attributes, 'already');
  assert.equal(second.recorded.rootAgentsKept, true);
});

test('skeleton: 이미 있는 AGENTS.md·soul-state.json·미니 지침은 그대로 둔다(S09)', async () => {
  const ctx = makeCtx('kept');
  fs.mkdirSync(path.join(ctx.root, '_trash'), { recursive: true });
  const mine = '# 내가 쓴 루트 지침\n';
  const oldState = { schemaVersion: 7, soulId: 'old-soul', soulName: '내 영혼', packageInstall: false };
  const myTrashGuide = '# _trash\n\n내가 고친 설명\n';
  fs.writeFileSync(path.join(ctx.root, 'AGENTS.md'), mine, 'utf8');
  fs.writeFileSync(path.join(ctx.root, 'soul-state.json'), JSON.stringify(oldState), 'utf8');
  fs.writeFileSync(path.join(ctx.root, '_trash', 'AGENTS.md'), myTrashGuide, 'utf8');

  const { recorded } = await skeleton.run(ctx);

  assert.equal(fs.readFileSync(path.join(ctx.root, 'AGENTS.md'), 'utf8'), mine);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.root, 'soul-state.json'), 'utf8')), oldState);
  assert.equal(fs.readFileSync(path.join(ctx.root, '_trash', 'AGENTS.md'), 'utf8'), myTrashGuide);
  assert.equal(recorded.soulState.status, 'kept');
  assert.equal(recorded.rootAgentsKept, true);
  assert.ok(recorded.files.kept.includes('AGENTS.md'));
  assert.ok(recorded.miniGuides.kept.includes('_trash\\AGENTS.md'));
  // 나머지는 정상 생성
  assert.ok(fs.existsSync(path.join(ctx.root, '_ontology', 'requirements.txt')));
});

test('skeleton: 꾸러미에 없는 부품은 오류 없이 missing 으로 기록한다', async () => {
  const ctx = makeCtx('missing-parts');
  fs.rmSync(path.join(ctx.payloadDir, 'policy', '_cosmos.ico'));
  fs.rmSync(path.join(ctx.payloadDir, 'setup', SPEC_NAME));
  delete ctx.manifest.parts.pyyaml;

  const { recorded } = await skeleton.run(ctx);

  assert.equal(recorded.icon.ico, 'missing');
  assert.equal(recorded.ontology.spec, 'missing');
  assert.equal(recorded.ontology.requirements, 'missing-version');
  assert.equal(recorded.missing.length, 3);
  // 그래도 만들 수 있는 것은 다 만든다
  assert.ok(fs.existsSync(path.join(ctx.root, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(ctx.root, '_ontology', 'registry.yml')));
});

test('skeleton: `_`폴더가 정션이면 뚫고 쓰지 않고 blocked 에 남기고 나머지는 계속 만든다', { skip: process.platform !== 'win32' ? '윈도 전용' : false }, async (t) => {
  const ctx = makeCtx('junction-skeleton');
  const outside = path.join(tmp, 'junction-skeleton', 'outside-target');
  const link = path.join(ctx.root, '_ontology');
  fs.mkdirSync(ctx.root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  // 폴더 정션은 관리자 권한 없이 만들 수 있다. 못 만드는 환경이면 조용히
  // 통과하지 않고 '건너뜀'으로 보이게 한다.
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, outside], { stdio: 'ignore' });
  } catch {
    t.skip('이 환경에서 mklink /J 가 막혀 있다');
    return;
  }
  if (!fs.lstatSync(link).isSymbolicLink()) { t.skip('정션이 링크로 보이지 않는다'); return; }

  const { recorded } = await skeleton.run(ctx);

  assert.ok(recorded.blocked.length > 0, '정션을 blocked 에 남기지 않았다');
  assert.ok(recorded.blocked.every((b) => b.message.includes('정션')));
  assert.ok(recorded.blocked.some((b) => b.what === '_ontology'));
  assert.deepEqual(fs.readdirSync(outside), [], '정션 대상(영혼 밖)에 파일이 쓰였다');
  // 나머지 뼈대는 정상적으로 만들어진다
  assert.ok(fs.existsSync(path.join(ctx.root, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(ctx.root, '_trash', 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(ctx.root, 'desktop.ini')));
});

test('paths: assertInside 는 루트 밖 경로를 막는다(..·다른 드라이브·형제 폴더)', () => {
  const root = path.join(tmp, 'guard', 'soul-IRIS');
  assert.equal(assertInside(root, path.join(root, 'a', 'b.md')), path.join(root, 'a', 'b.md'));
  assert.equal(assertInside(root, path.join(root.toUpperCase(), 'a')), path.join(root.toUpperCase(), 'a'));
  for (const bad of [path.join(root, '..', 'elsewhere.md'), path.join(tmp, 'guard', 'soul-IRIS-other', 'x.md'), 'Z:\\somewhere\\x.md']) {
    assert.throws(() => assertInside(root, bad), (e) => e.name === 'StageError' && e.code === 'E-OUTSIDE-ROOT', `막지 못함: ${bad}`);
  }
});

test('payload: partPath 는 manifest 의 file 값을, partDir 은 zip 이름에서 푼 폴더를 찾는다', () => {
  const ctx = makeCtx('payload-helpers');
  assert.equal(partPath(ctx, 'folder-icon'), path.join(ctx.payloadDir, 'policy', '_cosmos.ico'));
  assert.equal(partBasename(ctx, 'ontology-spec'), SPEC_NAME);
  assert.equal(partDir(ctx, 'ontology'), path.join(ctx.payloadDir, 'setup', 'ontology'));
  assert.equal(partDir(ctx, 'pyyaml'), null, '휠 파일은 폴더가 아니다');
  assert.equal(partPath(ctx, '없는부품'), null);
});
