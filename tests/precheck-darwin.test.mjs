import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheck } from '../installer/lib/precheck.mjs';
import {
  parseMacVersion, checkMacOs, checkMacArch, checkHome, checkAutomationBrowser, checkGatekeeper,
} from '../installer/lib/precheck-darwin.mjs';

// macOS 검사표(docs/설계-macOS.md 3절). 모든 의존성을 주입하므로 어느 PC 에서나 돈다.
const GB = 1024 ** 3;
const HOME = '/Users/someone';

// sw_vers·sysctl·spctl 을 흉내 내는 runFn
function macRun({ version = '27.2', arm64 = '1', spctl = 'assessments enabled' } = {}) {
  return async (exe) => {
    if (exe.endsWith('sw_vers')) return version == null ? { code: 1, out: '', err: '' } : { code: 0, out: version, err: '' };
    if (exe.endsWith('sysctl')) return arm64 == null ? { code: 1, out: '', err: "sysctl: unknown oid 'hw.optional.arm64'" } : { code: 0, out: arm64, err: '' };
    if (exe.endsWith('spctl')) return { code: 0, out: spctl, err: '' };
    return { code: 127, out: '', err: 'unexpected' };
  };
}

function fakeFs({ freeBytes = 50 * GB, writable = true, statfsThrows = false } = {}) {
  return {
    mkdirSync: () => {},
    writeFileSync: () => { if (!writable) throw Object.assign(new Error(`EACCES: ${HOME}/x`), { code: 'EACCES' }); },
    unlinkSync: () => {},
    readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    statfsSync: () => { if (statfsThrows) throw Object.assign(new Error('boom'), { code: 'EIO' }); return { bavail: freeBytes / 4096, bsize: 4096 }; },
  };
}

const baseDeps = (over = {}) => ({
  platform: 'darwin',
  homedir: HOME,
  arch: 'arm64',
  runFn: macRun(),
  fsFn: fakeFs(),
  existsFn: (p) => p === '/Applications/Google Chrome.app',
  fetchFn: async () => ({ status: 200, text: async () => '' }),
  probeOpenFn: async () => false,
  envFn: {},
  ...over,
});

test('macOS 판 문자열 읽기', () => {
  assert.deepEqual(parseMacVersion('27.2'), [27, 2]);
  assert.deepEqual(parseMacVersion('13.5.1\n'), [13, 5]);
  assert.deepEqual(parseMacVersion('14'), [14, 0]);
  assert.equal(parseMacVersion(''), null);
});

test('macOS 판: 13.5 이상만 통과, 못 읽으면 unknown', async () => {
  assert.equal((await checkMacOs(1000, { runFn: macRun({ version: '13.5' }) })).ok, true);
  assert.equal((await checkMacOs(1000, { runFn: macRun({ version: '13.4.1' }) })).ok, false);
  assert.equal((await checkMacOs(1000, { runFn: macRun({ version: '12.7' }) })).ok, false);
  const u = await checkMacOs(1000, { runFn: macRun({ version: null }) });
  assert.equal(u.unknown, true);
});

test('CPU: arm64 node 는 바로 통과, Rosetta 아래 x64 node 는 하드웨어로 판정, Intel 은 막음', async () => {
  assert.deepEqual(await checkMacArch(1000, { arch: 'arm64' }), { ok: true, value: 'arm64' });
  assert.equal((await checkMacArch(1000, { arch: 'x64', runFn: macRun({ arm64: '1' }) })).rosetta, true);
  assert.equal((await checkMacArch(1000, { arch: 'x64', runFn: macRun({ arm64: '0' }) })).ok, false);
  const intel = await checkMacArch(1000, { arch: 'x64', runFn: macRun({ arm64: null }) });
  assert.equal(intel.ok, false);
  assert.ok(!intel.unknown, 'unknown oid 는 "모름"이 아니라 Intel 이라는 답이다');
});

test('홈 폴더: 쓰기 실패는 code 만 남기고(사용자 이름 없음) 여유 공간은 statfs', () => {
  const ok = checkHome({ fsFn: fakeFs(), homedir: HOME });
  assert.equal(ok.writable.ok, true);
  assert.ok(ok.disk.freeGB > 49);
  const ro = checkHome({ fsFn: fakeFs({ writable: false }), homedir: HOME });
  assert.deepEqual(ro.writable, { ok: false, detail: 'EACCES' });
  assert.ok(!JSON.stringify(ro).includes('someone'));
  const unk = checkHome({ fsFn: fakeFs({ statfsThrows: true }), homedir: HOME });
  assert.equal(unk.disk.unknown, true);
});

test('브라우저 조작: Chrome → Edge 순, 홈 경로는 ~ 로 가린다', () => {
  assert.equal(checkAutomationBrowser({ existsFn: (p) => p.includes('Google Chrome'), homedir: HOME }).channel, 'chrome');
  const edge = checkAutomationBrowser({ existsFn: (p) => p === `${HOME}/Applications/Microsoft Edge.app`, homedir: HOME });
  assert.equal(edge.channel, 'msedge');
  assert.equal(edge.path, '~/Applications/Microsoft Edge.app');
  assert.equal(checkAutomationBrowser({ existsFn: () => false, homedir: HOME }).present, false);
});

test('Gatekeeper 는 기록만', async () => {
  assert.equal((await checkGatekeeper(1000, { runFn: macRun() })).enabled, true);
  assert.equal((await checkGatekeeper(1000, { runFn: macRun({ spctl: 'assessments disabled' }) })).enabled, false);
});

test('precheck(darwin): 다 괜찮으면 막는 것도 경고도 없고, 결과 모양은 Windows 와 같다', async () => {
  const p = await precheck({ timeoutMs: 1000, deps: baseDeps() });
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.warnings, []);
  for (const k of ['os', 'arch', 'disk', 'net', 'browser']) assert.ok(p[k], k);
  assert.equal(typeof p.allOk, 'boolean');
  assert.equal(p.canProceedOffline, true);
  assert.equal(p.recorded.platform, 'darwin');
  assert.equal(p.recorded.edge.present, true, '뒤 단계는 recorded.edge.present 를 읽는다');
  assert.equal(p.recorded.edge.channel, 'chrome');
});

test('precheck(darwin): 옛 macOS·Intel·홈 쓰기 불가·공간 부족·남의 포트는 막는다', async () => {
  const p = await precheck({
    timeoutMs: 1000,
    deps: baseDeps({
      runFn: macRun({ version: '12.7', arm64: null }),
      arch: 'x64',
      fsFn: fakeFs({ writable: false, freeBytes: 1 * GB }),
      probeOpenFn: async (port) => port === 3456,
      fetchFn: async () => ({ status: 200, text: async () => 'not teamclaude' }),
    }),
  });
  const ids = p.blockers.map((b) => b.id).sort();
  assert.deepEqual(ids, ['arch', 'disk', 'home', 'os', 'port-3456']);
});

test('precheck(darwin): 못 읽은 값은 경고일 뿐 진행을 막지 않는다', async () => {
  const p = await precheck({
    timeoutMs: 1000,
    deps: baseDeps({ runFn: macRun({ version: null }), fsFn: fakeFs({ statfsThrows: true }), existsFn: () => false }),
  });
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.warnings.map((w) => w.id).sort(), ['disk-unknown', 'edge', 'macos-unknown']);
});

test('precheck(darwin): 모든 의존성이 던져도 모양이 온전하다', async () => {
  const boom = async () => { throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }); };
  const p = await precheck({
    timeoutMs: 500,
    deps: baseDeps({
      runFn: boom,
      arch: 'x64',
      fetchFn: async () => { throw new Error('network down'); },
      fsFn: { ...fakeFs(), mkdirSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }, statfsSync: () => { throw new Error('x'); } },
      existsFn: () => { throw new Error('x'); },
      probeOpenFn: async () => { throw new Error('EPERM'); },
    }),
  });
  assert.ok(Array.isArray(p.blockers));
  assert.ok(Array.isArray(p.warnings));
  assert.equal(p.recorded.existing.exists, false);
});
