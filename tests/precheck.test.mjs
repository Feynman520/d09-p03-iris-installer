import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  precheck, checkDisk, checkNet, checkBrowser,
  checkNtfs, checkPowerShell, checkPorts, checkEdge, checkSac, checkExisting,
  runPsBundle,
} from '../installer/lib/precheck.mjs';

const GB = 1024 ** 3;

// A runFn that answers the merged PS_BUNDLE_SCRIPT invocation with one JSON
// object (Task 25: disk/ntfs/powershell now share a single powershell.exe
// call instead of three separate ones).
function psRunFn(fields, { code = 0, err = '', timedOut = false } = {}) {
  return async () => ({ code, out: JSON.stringify(fields), err, timedOut });
}

const FULL_OK_FIELDS = {
  diskFreeBytes: 5 * GB,
  psVersion: '5.1.26100.9444',
  languageMode: 'FullLanguage',
  volumeFileSystem: 'NTFS',
};

// ---------------------------------------------------------------------------
// Real-probe shape tests (network may be off; this only asserts the shape
// and the environment-independent fields, never net/browser/edge booleans).
// ---------------------------------------------------------------------------

test('precheck shape (network may be off)', async () => {
  const p = await precheck({ timeoutMs: 5000 });
  assert.equal(typeof p.os.ok, 'boolean');
  assert.equal(p.arch.value, 'x64');
  assert.ok(p.disk.freeGB >= 0);
  assert.equal(typeof p.net.claude, 'boolean');
  assert.equal(typeof p.net.chatgpt, 'boolean');
  assert.equal(typeof p.net.ok, 'boolean');
  assert.equal(typeof p.browser.ok, 'boolean');
  assert.equal(typeof p.allOk, 'boolean');
  assert.equal(typeof p.canProceedOffline, 'boolean');
  // canProceedOffline must not depend on net -- flipping net.ok alone must
  // never change it (pre-v2 formula, kept verbatim -- see precheck.mjs
  // comment above the function).
  assert.equal(p.canProceedOffline, p.os.ok && p.arch.ok && p.disk.ok && p.browser.ok);
  // v2 shape is present alongside the compat fields.
  assert.ok(Array.isArray(p.blockers));
  assert.ok(Array.isArray(p.warnings));
  assert.equal(typeof p.info, 'object');
  assert.equal(typeof p.recorded, 'object');
  assert.ok(p.recorded.ntfs);
  assert.ok(p.recorded.powershell);
  assert.ok(Array.isArray(p.recorded.ports));
  assert.ok(p.recorded.edge);
  assert.ok(p.recorded.sac);
  assert.ok(p.recorded.existing);
});

test('precheck never throws even with a near-zero timeout', async () => {
  const p = await precheck({ timeoutMs: 1 });
  assert.equal(typeof p.allOk, 'boolean');
  assert.ok(Array.isArray(p.blockers));
});

// ---------------------------------------------------------------------------
// Task 25: runPsBundle -- one merged spawn, retry-once-on-timeout, never a
// definite failure for a probe that simply never answered.
// ---------------------------------------------------------------------------

test('runPsBundle: fast/happy path -- exactly one spawn', async () => {
  let calls = 0;
  const runFn = async (...a) => { calls += 1; return psRunFn(FULL_OK_FIELDS)(...a); };
  const bundle = await runPsBundle(1000, { runFn });
  assert.equal(calls, 1, 'the happy path must spawn powershell.exe exactly once');
  assert.deepEqual(bundle.data, FULL_OK_FIELDS);
});

test('runPsBundle: a timed-out first attempt is retried once at 2x the timeout, and the retry can succeed', async () => {
  const seenTimeouts = [];
  let calls = 0;
  const runFn = async (exe, args, { timeoutMs } = {}) => {
    calls += 1;
    seenTimeouts.push(timeoutMs);
    if (calls === 1) return { code: 0, out: '', err: '', timedOut: true }; // simulated slow cold start
    return { code: 0, out: JSON.stringify(FULL_OK_FIELDS), err: '', timedOut: false };
  };
  const bundle = await runPsBundle(1000, { runFn });
  assert.equal(calls, 2, 'exactly one retry, not more');
  assert.deepEqual(seenTimeouts, [1000, 2000], 'the retry must use double the original timeout');
  assert.deepEqual(bundle.data, FULL_OK_FIELDS, 'a slow-but-eventually-successful probe must not be reported as a failure');
});

test('runPsBundle: still slow on the retry -> reports timedOut, never a definite failure, no third attempt', async () => {
  let calls = 0;
  const runFn = async () => { calls += 1; return { code: 0, out: '', err: '', timedOut: true }; };
  const bundle = await runPsBundle(1000, { runFn });
  assert.equal(calls, 2, 'must stop after one retry (no infinite/extra retries)');
  assert.equal(bundle.timedOut, true);
  assert.ok(!bundle.data, 'a still-timed-out bundle must not carry fabricated data');
});

test('runPsBundle: spawn throws -> probeFailed immediately, no retry (retrying a spawn failure cannot help)', async () => {
  let calls = 0;
  const runFn = async () => { calls += 1; const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e; };
  const bundle = await runPsBundle(1000, { runFn });
  assert.equal(calls, 1, 'a spawn failure must not be retried');
  assert.equal(bundle.probeFailed, true);
  assert.equal(bundle.detail, 'ENOENT');
});

test('runPsBundle: unparsable output -> probeFailed, no retry', async () => {
  let calls = 0;
  const runFn = async () => { calls += 1; return { code: 0, out: 'not json', err: '', timedOut: false }; };
  const bundle = await runPsBundle(1000, { runFn });
  assert.equal(calls, 1);
  assert.equal(bundle.probeFailed, true);
  assert.equal(bundle.detail, 'parse-failed');
});

// ---------------------------------------------------------------------------
// checkDisk (3GB threshold, raised from 2GB in v2) -- now a pure formatter
// over an already-fetched bundle.
// ---------------------------------------------------------------------------

test('checkDisk: 3GB threshold -- just under blocks, at/above passes', () => {
  const under = checkDisk({ data: { diskFreeBytes: 2.9 * GB } });
  assert.equal(under.ok, false);
  const atThreshold = checkDisk({ data: { diskFreeBytes: 3 * GB } });
  assert.equal(atThreshold.ok, true);
});

test('checkDisk: bundle timedOut -> unknown, never the "3GB 미만" wording', () => {
  const r = checkDisk({ timedOut: true, detail: 'timed-out' });
  assert.equal(r.ok, false);
  assert.equal(r.unknown, true);
  assert.equal(r.timedOut, true);
});

test('checkDisk: bundle probeFailed -> unknown, timedOut false', () => {
  const r = checkDisk({ probeFailed: true, detail: 'spawn-failed' });
  assert.equal(r.ok, false);
  assert.equal(r.unknown, true);
  assert.equal(r.timedOut, false);
});

test('checkDisk: bundle succeeded overall but diskFreeBytes itself is null -> unknown, not "3GB 미만"', () => {
  const r = checkDisk({ data: { diskFreeBytes: null } });
  assert.equal(r.ok, false);
  assert.equal(r.unknown, true);
});

// ---------------------------------------------------------------------------
// checkNtfs
// ---------------------------------------------------------------------------

function fakeFs({ mkdirOk = true, writeOk = true, unlinkOk = true } = {}) {
  return {
    mkdirSync: () => { if (!mkdirOk) throw new Error('mkdir denied'); },
    writeFileSync: () => { if (!writeOk) throw new Error('write denied'); },
    unlinkSync: () => { if (!unlinkOk) throw new Error('unlink denied'); },
  };
}

test('checkNtfs: NTFS + writable -> ok', () => {
  const r = checkNtfs({ data: { volumeFileSystem: 'NTFS' } }, {
    fsFn: fakeFs(),
    envFn: { LOCALAPPDATA: 'C:\\FAKE\\LocalAppData' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.fsName, 'NTFS');
  assert.equal(r.writable, true);
});

test('checkNtfs: non-NTFS volume -> not ok', () => {
  const r = checkNtfs({ data: { volumeFileSystem: 'FAT32' } }, {
    fsFn: fakeFs(),
    envFn: { LOCALAPPDATA: 'C:\\FAKE\\LocalAppData' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.fsName, 'FAT32');
});

test('checkNtfs: NTFS but not writable -> not ok', () => {
  const r = checkNtfs({ data: { volumeFileSystem: 'NTFS' } }, {
    fsFn: fakeFs({ writeOk: false }),
    envFn: { LOCALAPPDATA: 'C:\\FAKE\\LocalAppData' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.writable, false);
});

test('checkNtfs: bundle timedOut -> unknown, never rejects', () => {
  const r = checkNtfs({ timedOut: true, detail: 'timed-out' }, { fsFn: fakeFs() });
  assert.equal(r.ok, false);
  assert.equal(r.unknown, true);
  assert.equal(r.timedOut, true);
});

test('checkNtfs: bundle succeeded overall but volumeFileSystem itself is null -> unknown, not "not NTFS"', () => {
  const r = checkNtfs({ data: { volumeFileSystem: null } }, { fsFn: fakeFs() });
  assert.equal(r.ok, false);
  assert.equal(r.fsName, null);
  assert.equal(r.unknown, true);
});

// Fix round 1 (critical): Node fs errors embed the full failing path, e.g.
// "EPERM: mkdir 'C:\Users\<name>\AppData\Local\IRIS-Installer'" -- that path
// contains the signed-in Windows account name and must never reach
// recorded/the receipt. Only e.code (path-free) may be stored.
test('checkNtfs: an fs error whose message contains a username never leaks into the result or precheck()', async () => {
  const username = 'CorpUser42';
  const leaky = new Error(`EPERM: mkdir 'C:\\Users\\${username}\\AppData\\Local\\IRIS-Installer'`);
  leaky.code = 'EPERM';
  const fsFn = {
    mkdirSync: () => { throw leaky; },
    writeFileSync: () => {},
    unlinkSync: () => {},
  };

  const r = checkNtfs({ data: { volumeFileSystem: 'NTFS' } }, { fsFn, envFn: { LOCALAPPDATA: `C:\\Users\\${username}\\AppData\\Local` } });
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'EPERM');
  assert.ok(!JSON.stringify(r).includes(username), `leaked username into checkNtfs result: ${JSON.stringify(r)}`);

  const p = await precheck({
    timeoutMs: 1000,
    deps: {
      runFn: psRunFn(FULL_OK_FIELDS),
      fsFn,
      envFn: { LOCALAPPDATA: `C:\\Users\\${username}\\AppData\\Local` },
    },
  });
  assert.ok(!JSON.stringify(p).includes(username), `leaked username into precheck() result: ${JSON.stringify(p)}`);
});

// Fix round 1 (minor), updated for Task 25, then reclassified in Task 26:
// if the merged probe never got a real fs-type value (bundle timed out /
// spawn failed / the PS script's own try/catch came back null), we don't
// actually know whether it's a non-NTFS volume or an unwritable one. Task 26
// (VM-matrix evidence: three fresh Win11 VMs stuck forever behind exactly
// this "ntfs-unknown" id) demoted this from a blocker to a warning --
// PowerShell 5.1 provably exists (bootstrap.ps1 already ran it), and the
// writability probe already guards the write path, so an "unknown" here must
// never stop the install; a genuinely bad value (read successfully) still
// blocks exactly as before.
test('checkNtfs: fs-type probe unknown -> precheck() gives the "확인하지 못했습니다" WARNING with id ntfs-unknown (canProceed stays true), not the old blocking wording', async () => {
  const p = await precheck({
    timeoutMs: 1000,
    deps: {
      runFn: async () => ({ code: 0, out: '', err: '', timedOut: true }), // times out on both attempts
      fsFn: { mkdirSync: () => {}, writeFileSync: () => {}, unlinkSync: () => {} },
    },
  });
  assert.ok(!p.blockers.find((b) => b.id === 'ntfs'), 'the old ntfs id/wording must not be used for an unknown state');
  assert.ok(!p.blockers.find((b) => b.id === 'ntfs-unknown'), 'ntfs-unknown must be a warning, never a blocker (Task 26)');
  const warning = p.warnings.find((w) => w.id === 'ntfs-unknown');
  assert.ok(warning, 'ntfs-unknown warning expected when the fs-type probe never answers');
  assert.equal(warning.message, '파일 시스템을 확인하지 못했습니다. 설치는 계속할 수 있지만 문제가 생기면 「다시 확인」을 눌러 주세요.');
  assert.equal(p.blockers.length, 0, 'an unknown-only precheck must allow the user to proceed');
});

// ---------------------------------------------------------------------------
// checkPowerShell
// ---------------------------------------------------------------------------

test('checkPowerShell: 5.1 + FullLanguage -> ok', () => {
  const r = checkPowerShell({ data: { psVersion: '5.1.26100.9444', languageMode: 'FullLanguage' } });
  assert.equal(r.ok, true);
  assert.equal(r.languageMode, 'FullLanguage');
});

test('checkPowerShell: 7.x + FullLanguage -> ok (major above 5)', () => {
  const r = checkPowerShell({ data: { psVersion: '7.4.6', languageMode: 'FullLanguage' } });
  assert.equal(r.ok, true);
});

test('checkPowerShell: version below 5.1 -> not ok', () => {
  const r = checkPowerShell({ data: { psVersion: '5.0.10586.0', languageMode: 'FullLanguage' } });
  assert.equal(r.ok, false);
});

test('checkPowerShell: bundle timedOut -> unknown, never rejects', () => {
  const r = checkPowerShell({ timedOut: true, detail: 'timed-out' });
  assert.equal(r.ok, false);
  assert.equal(r.unknown, true);
  assert.equal(r.timedOut, true);
});

test('checkPowerShell: ConstrainedLanguage -> not ok, precheck() gives the exact company-policy message (genuine bad value, not "unknown")', async () => {
  const r = checkPowerShell({ data: { psVersion: '5.1.26100.9444', languageMode: 'ConstrainedLanguage' } });
  assert.equal(r.ok, false);
  assert.equal(r.languageMode, 'ConstrainedLanguage');
  assert.ok(!r.unknown, 'a successfully-read ConstrainedLanguage value must not be flagged unknown');

  const p = await precheck({
    timeoutMs: 1000,
    deps: { runFn: psRunFn({ ...FULL_OK_FIELDS, languageMode: 'ConstrainedLanguage' }) },
  });
  const blocker = p.blockers.find((b) => b.id === 'powershell');
  assert.ok(blocker, 'ConstrainedLanguage must produce a powershell blocker (not powershell-unknown)');
  assert.equal(blocker.message, '회사 정책이 PowerShell 스크립트를 제한하고 있습니다.');
  assert.ok(!p.blockers.find((b) => b.id === 'powershell-unknown'));
});

// Task 26: a spawn/timeout failure on the powershell probe is a warning, not
// a blocker -- bootstrap.ps1 running at all already proves PowerShell 5.1+
// exists on this machine, so "couldn't confirm it" must not stop the install.
test('checkPowerShell: spawn/timeout failure -> precheck() gives the "확인하지 못했습니다" WARNING with id powershell-unknown (canProceed stays true)', async () => {
  const p = await precheck({
    timeoutMs: 1000,
    deps: { runFn: async () => { const e = new Error('spawn EPERM'); e.code = 'EPERM'; throw e; } },
  });
  assert.ok(!p.blockers.find((b) => b.id === 'powershell'), 'the old powershell id/wording must not be used for an unknown state');
  assert.ok(!p.blockers.find((b) => b.id === 'powershell-unknown'), 'powershell-unknown must be a warning, never a blocker (Task 26)');
  const warning = p.warnings.find((w) => w.id === 'powershell-unknown');
  assert.ok(warning, 'powershell-unknown warning expected on a spawn failure');
  assert.equal(warning.message, 'PowerShell 상태를 확인하지 못했습니다. 설치는 계속할 수 있지만 문제가 생기면 「다시 확인」을 눌러 주세요.');
  assert.equal(p.blockers.length, 0, 'an unknown-only precheck must allow the user to proceed');
});

// ---------------------------------------------------------------------------
// Task 25: the slow-VM scenario end to end -- a probe slow enough to miss
// the first timeout, but that answers correctly on the retry, must produce
// NO false blocker at all (this is the exact defect task-23c-report.md
// documented: "C 드라이브 여유 공간이 3GB 미만" at 44GB free).
// ---------------------------------------------------------------------------

// checkBrowser/checkEdge/checkSac ALSO receive `deps.runFn` inside
// precheck() (they call reg.exe through it) -- a mock aimed only at the
// merged PS_BUNDLE_SCRIPT call must recognize its own invocation (by the
// distinctive 'diskFreeBytes' fragment) and answer everything else with an
// inert reg.exe-shaped result so it doesn't distort the bundle call count.
function isBundleCall(args) {
  return Array.isArray(args) && args.some((a) => typeof a === 'string' && a.includes('diskFreeBytes'));
}

test('precheck: a probe that times out once but succeeds on the doubled-timeout retry produces zero disk/ntfs/powershell blockers', async () => {
  let calls = 0;
  const runFn = async (exe, args, { timeoutMs } = {}) => {
    if (!isBundleCall(args)) return { code: 1, out: '', err: '', timedOut: false }; // checkBrowser/checkEdge/checkSac's reg.exe calls
    calls += 1;
    if (calls === 1) return { code: 0, out: '', err: '', timedOut: true };
    return { code: 0, out: JSON.stringify(FULL_OK_FIELDS), err: '', timedOut: false };
  };
  const p = await precheck({
    timeoutMs: 1000,
    deps: {
      runFn,
      fsFn: { mkdirSync: () => {}, writeFileSync: () => {}, unlinkSync: () => {} },
      fetchFn: async () => ({ status: 200, text: async () => '' }),
      probeOpenFn: async () => false,
      existsFn: () => false,
    },
  });
  assert.equal(calls, 2, 'exactly one retry for the merged probe');
  assert.ok(!p.blockers.find((b) => ['disk', 'disk-unknown', 'ntfs', 'ntfs-unknown', 'powershell', 'powershell-unknown'].includes(b.id)), JSON.stringify(p.blockers));
  assert.ok(!p.warnings.find((w) => ['disk-unknown', 'ntfs-unknown', 'powershell-unknown'].includes(w.id)), JSON.stringify(p.warnings));
  assert.equal(p.disk.ok, true);
  assert.equal(p.recorded.ntfs.ok, true);
  assert.equal(p.recorded.powershell.ok, true);
});

// Task 26 (VM-matrix evidence: three fresh Win11 VMs stuck forever behind
// exactly this trio of *-unknown ids): a probe that is STILL unknown after
// the retry must produce WARNINGS, never blockers -- canProceed = no
// blockers must stay true, so the install can go on even though the probe
// itself never answered.
test('precheck: a probe still slow after the retry reports "unknown" wording for disk/ntfs/powershell as WARNINGS, canProceed stays true (Task 26)', async () => {
  const runFn = async (exe, args) => {
    if (!isBundleCall(args)) return { code: 1, out: '', err: '', timedOut: false };
    return { code: 0, out: '', err: '', timedOut: true };
  };
  const p = await precheck({
    timeoutMs: 1000,
    deps: {
      runFn,
      fsFn: { mkdirSync: () => {}, writeFileSync: () => {}, unlinkSync: () => {} },
      fetchFn: async () => ({ status: 200, text: async () => '' }),
      probeOpenFn: async () => false,
      existsFn: () => false,
    },
  });
  for (const id of ['disk-unknown', 'ntfs-unknown', 'powershell-unknown']) {
    assert.ok(!p.blockers.find((b) => b.id === id), `${id} must never be a blocker (Task 26)`);
    const warning = p.warnings.find((w) => w.id === id);
    assert.ok(warning, `${id} warning expected`);
    assert.ok(warning.message.includes('확인하지 못했습니다'), warning.message);
    assert.ok(warning.message.includes('설치는 계속할 수 있지만'), warning.message);
    assert.ok(warning.message.includes('다시 확인'), warning.message);
    assert.ok(!warning.message.includes('시간 초과'), 'wording must not claim it was specifically a timeout');
  }
  // The old definite-failure wording/ids must never appear alongside this.
  for (const id of ['disk', 'ntfs', 'powershell']) {
    assert.ok(!p.blockers.find((b) => b.id === id), `old id "${id}" must not appear for an unknown state`);
  }
  // canProceed's single source of truth (server.mjs) is blockers.length === 0.
  assert.equal(p.blockers.length, 0, 'three unknowns with zero blockers must still allow proceeding');
});

// Task 26: the bundle script must probe via Get-CimInstance Win32_LogicalDisk
// (fast, no Storage module, no elevation) and must no longer call Get-Volume
// (the slow/WMI-heavy Storage-module cmdlet that timed out cold on fresh
// Win11 VMs -- the actual VM-matrix root cause).
test('precheck: the merged PS bundle call uses Get-CimInstance Win32_LogicalDisk, never Get-Volume', async () => {
  let seenArgs = null;
  const runFn = async (exe, args) => {
    if (isBundleCall(args) && seenArgs === null) seenArgs = args;
    if (!isBundleCall(args)) return { code: 1, out: '', err: '', timedOut: false };
    return { code: 0, out: JSON.stringify(FULL_OK_FIELDS), err: '', timedOut: false };
  };
  await precheck({
    timeoutMs: 1000,
    deps: {
      runFn,
      fsFn: { mkdirSync: () => {}, writeFileSync: () => {}, unlinkSync: () => {} },
      fetchFn: async () => ({ status: 200, text: async () => '' }),
      probeOpenFn: async () => false,
      existsFn: () => false,
    },
  });
  assert.ok(seenArgs, 'the merged bundle call must have happened');
  const joined = seenArgs.join(' ');
  assert.ok(joined.includes('Win32_LogicalDisk'), joined);
  assert.ok(joined.includes('Get-CimInstance'), joined);
  assert.ok(!joined.includes('Get-Volume'), 'Get-Volume (slow Storage-module cmdlet) must not be used any more');
  assert.ok(!joined.includes('Get-PSDrive'), 'Get-PSDrive must not be used any more (merged into the CIM call)');
});

test('precheck: fast/happy path leaves the pre-v2 compat fields (disk/ntfs/powershell shapes) exactly as before this task', async () => {
  const p = await precheck({
    timeoutMs: 1000,
    deps: {
      runFn: psRunFn(FULL_OK_FIELDS),
      fsFn: { mkdirSync: () => {}, writeFileSync: () => {}, unlinkSync: () => {} },
      fetchFn: async () => ({ status: 200, text: async () => '' }),
      probeOpenFn: async () => false,
      existsFn: () => false,
    },
  });
  // Field names/shapes server.mjs and the receipt already depend on.
  assert.equal(typeof p.disk.ok, 'boolean');
  assert.equal(typeof p.disk.freeGB, 'number');
  assert.equal(typeof p.recorded.ntfs.ok, 'boolean');
  assert.equal(typeof p.recorded.ntfs.fsName, 'string');
  assert.equal(typeof p.recorded.ntfs.writable, 'boolean');
  assert.equal(typeof p.recorded.powershell.ok, 'boolean');
  assert.equal(typeof p.recorded.powershell.version, 'string');
  assert.equal(typeof p.recorded.powershell.languageMode, 'string');
  assert.equal(p.allOk, p.os.ok && p.arch.ok && p.disk.ok && p.net.ok && p.browser.ok);
  assert.equal(p.canProceedOffline, p.os.ok && p.arch.ok && p.disk.ok && p.browser.ok);
});

// ---------------------------------------------------------------------------
// checkPorts
// ---------------------------------------------------------------------------

test('checkPorts: closed port -> free, never a blocker', async () => {
  const r = await checkPorts(1000, { probeOpenFn: async () => false });
  assert.ok(r.ports.every((p) => p.state === 'free'));
  assert.equal(r.foreign.length, 0);
});

test('checkPorts: open + IRIS-shaped response -> iris, never a blocker', async () => {
  const bodies = {
    3456: JSON.stringify({ activity: { instanceId: 'x' } }),
    3457: '<html><head><title>TeamClaude 대시보드</title></head></html>',
    3458: JSON.stringify({ ok: true, about: { name: 'IRIS' } }),
    3460: JSON.stringify({ ok: true, name: 'iris-installer' }),
  };
  const r = await checkPorts(1000, {
    probeOpenFn: async () => true,
    fetchFn: async (url) => {
      const port = Number(new URL(url).port);
      return { status: 200, text: async () => bodies[port] };
    },
  });
  assert.ok(r.ports.every((p) => p.state === 'iris'), JSON.stringify(r.ports));
  assert.equal(r.foreign.length, 0);
});

test('checkPorts: open + unrecognized response -> foreign -> blocker per port', async () => {
  const r = await checkPorts(1000, {
    probeOpenFn: async () => true,
    fetchFn: async () => ({ status: 200, text: async () => 'some other program' }),
  });
  assert.ok(r.ports.every((p) => p.state === 'foreign'));
  assert.equal(r.foreign.length, 4);

  const p = await precheck({ timeoutMs: 1000, deps: { probeOpenFn: async () => true, fetchFn: async () => ({ status: 200, text: async () => 'nope' }) } });
  for (const port of [3456, 3457, 3458, 3460]) {
    assert.ok(p.blockers.find((b) => b.id === `port-${port}`), `expected a blocker for port ${port}`);
  }
});

test('checkPorts: open but HTTP probe throws -> foreign (conservative), never throws itself', async () => {
  const r = await checkPorts(1000, {
    probeOpenFn: async () => true,
    fetchFn: async () => { throw new Error('ECONNRESET'); },
  });
  assert.ok(r.ports.every((p) => p.state === 'foreign'));
});

// Fix round 1 (minor): a single port's TCP-open probe throwing must not
// reject the whole Promise.all and discard the other three ports' results.
test('checkPorts: one port\'s probeOpenFn throws -> that port is "unknown", the other three still resolve, never a blocker', async () => {
  const r = await checkPorts(1000, {
    probeOpenFn: async (port) => {
      if (port === 3457) { const e = new Error('boom'); e.code = 'EWEIRD'; throw e; }
      return false; // the other three: closed -> free
    },
    fetchFn: async () => ({ status: 200, text: async () => '' }),
  });
  assert.equal(r.ports.length, 4, 'all four ports must still be present');
  const bad = r.ports.find((p) => p.port === 3457);
  assert.equal(bad.state, 'unknown');
  assert.equal(bad.detail, 'EWEIRD');
  assert.ok(r.ports.filter((p) => p.port !== 3457).every((p) => p.state === 'free'));
  assert.equal(r.foreign.length, 0, '"unknown" must not count as foreign / must not block');

  const p = await precheck({ timeoutMs: 1000, deps: { probeOpenFn: async (port) => { if (port === 3457) throw new Error('boom'); return false; }, fetchFn: async () => ({ status: 200, text: async () => '' }) } });
  assert.ok(!p.blockers.find((b) => b.id === 'port-3457'), 'an unknown-state port must never be a blocker');
});

// ---------------------------------------------------------------------------
// checkEdge
// ---------------------------------------------------------------------------

test('checkEdge: found via standard file path -> present, no registry call', async () => {
  let regCalled = false;
  const r = await checkEdge(1000, {
    existsFn: (p) => p.includes('Program Files (x86)'),
    runFn: async () => { regCalled = true; return { code: 1, out: '' }; },
    envFn: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' },
  });
  assert.equal(r.present, true);
  assert.equal(r.source, 'file');
  assert.equal(regCalled, false);
});

test('checkEdge: not on disk, found via registry App Paths -> present', async () => {
  const r = await checkEdge(1000, {
    existsFn: () => false,
    runFn: async () => ({
      code: 0,
      out: 'HKEY_LOCAL_MACHINE\\...\\msedge.exe\n    (기본값)    REG_SZ    C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\n    Path    REG_SZ    C:\\Program Files (x86)\\Microsoft\\Edge\\Application',
    }),
    envFn: {},
  });
  assert.equal(r.present, true);
  assert.equal(r.source, 'registry');
  assert.equal(r.path, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
});

test('checkEdge: not found anywhere -> absent, precheck() warns (not a blocker)', async () => {
  const r = await checkEdge(1000, { existsFn: () => false, runFn: async () => ({ code: 1, out: '' }), envFn: {} });
  assert.equal(r.present, false);

  const p = await precheck({ timeoutMs: 1000, deps: { existsFn: () => false, runFn: async () => ({ code: 1, out: '' }) } });
  assert.ok(p.warnings.find((w) => w.id === 'edge'));
  assert.ok(!p.blockers.find((b) => b.id === 'edge'), 'missing Edge must never be a blocker');
});

// ---------------------------------------------------------------------------
// checkSac
// ---------------------------------------------------------------------------

test('checkSac: REG_DWORD parsed -> state 1 (on)', async () => {
  const r = await checkSac(1000, {
    runFn: async () => ({
      code: 0,
      out: 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\n    VerifiedAndReputablePolicyState    REG_DWORD    0x1',
    }),
  });
  assert.equal(r.state, 1);
});

// 2026-09-16 실측: SAC 켜짐(1)인 개발 PC 에서 코드 무결성이 동봉 파이썬 .pyd 를 막아 venv 가
// E-VENV 로 멈췄다. 켜짐이면 막지는 않되 미리 알린다(warning `sac-on`). 평가(2)·꺼짐(0)은 조용.
test('precheck: SAC 켜짐(1) -> warning sac-on 하나, blocker 없음; 평가(2)면 아무 말 없음', async () => {
  const sacRun = (state) => async (exe, args) => (args.includes('VerifiedAndReputablePolicyState')
    ? { code: 0, out: `HKEY_LOCAL_MACHINE\\...\\Policy\n    VerifiedAndReputablePolicyState    REG_DWORD    0x${state}` }
    : { code: 0, out: '' });
  const on = await precheck({ timeoutMs: 1000, deps: { runFn: sacRun(1) } });
  assert.ok(!on.blockers.find((b) => b.id.startsWith('sac')), 'SAC 는 막지 않는다');
  const w = on.warnings.find((x) => x.id === 'sac-on');
  assert.ok(w, 'sac-on warning 이 있어야 한다');
  assert.ok(/스마트 앱 컨트롤/.test(w.message) && /끄기/.test(w.message), '끄는 길을 안내한다');
  const evalMode = await precheck({ timeoutMs: 1000, deps: { runFn: sacRun(2) } });
  assert.ok(!evalMode.warnings.find((x) => x.id === 'sac-on'));
});

test('checkSac: key not found -> state 0, never a blocker/warning', async () => {
  const r = await checkSac(1000, { runFn: async () => ({ code: 1, out: '' }) });
  assert.equal(r.state, 0);
  assert.equal(r.ok, true);

  const p = await precheck({ timeoutMs: 1000, deps: { runFn: async (exe, args) => (args.includes('VerifiedAndReputablePolicyState') ? { code: 1, out: '' } : { code: 0, out: '' }) } });
  assert.ok(!p.blockers.find((b) => b.id === 'sac'));
  assert.ok(!p.warnings.find((w) => w.id === 'sac'));
});

// ---------------------------------------------------------------------------
// checkExisting
// ---------------------------------------------------------------------------

test('checkExisting: receipt found -> exists true with schema/packageVersion, never a blocker', async () => {
  const fsFn = { readFileSync: () => JSON.stringify({ schema: 1, package: { version: '2.0.0' } }) };
  const r = checkExisting({ fsFn, envFn: {} });
  assert.deepEqual(r, { ok: true, exists: true, schema: 1, packageVersion: '2.0.0' });
});

test('checkExisting: no receipt -> exists false, no throw', async () => {
  const fsFn = { readFileSync: () => { throw new Error('ENOENT'); } };
  const r = checkExisting({ fsFn, envFn: {} });
  assert.equal(r.exists, false);
});

test('checkExisting: honors IRIS_INSTALLER_SOUL_NAME for the rehearsal soul root', async () => {
  const seen = [];
  const fsFn = { readFileSync: (p) => { seen.push(p); throw new Error('ENOENT'); } };
  checkExisting({ fsFn, envFn: { IRIS_INSTALLER_SOUL_NAME: 'REHEARSAL-SOUL' } });
  assert.ok(seen[0].includes('REHEARSAL-SOUL'), seen[0]);
  assert.ok(!seen[0].includes('\\IRIS\\'), seen[0]);
});

// ---------------------------------------------------------------------------
// Cross-cutting: one check throwing must not take down the whole result.
// ---------------------------------------------------------------------------

test('precheck: every dependency throwing still yields a complete, well-shaped result', async () => {
  const throwingRun = async () => { throw new Error('spawn EPERM'); };
  const p = await precheck({
    timeoutMs: 500,
    deps: {
      runFn: throwingRun,
      fetchFn: async () => { throw new Error('network down'); },
      fsFn: { readFileSync: () => { throw new Error('ENOENT'); }, mkdirSync: () => { throw new Error('EPERM'); }, writeFileSync: () => {}, unlinkSync: () => {} },
      existsFn: () => false,
      probeOpenFn: async () => { throw new Error('EPERM'); },
    },
  });
  assert.ok(Array.isArray(p.blockers));
  assert.ok(Array.isArray(p.warnings));
  assert.equal(typeof p.allOk, 'boolean');
  assert.equal(p.recorded.ntfs.ok, false);
  assert.equal(p.recorded.powershell.ok, false);
  assert.equal(p.recorded.existing.exists, false);
});

// ---------------------------------------------------------------------------
// Compatibility: allOk/canProceedOffline keep the pre-v2 formula -- a new
// (v2-only) blocker such as ntfs/powershell/a foreign port must NOT change
// them, since server.mjs (until Task 11 rewires it) only reads these two.
// ---------------------------------------------------------------------------

test('compat: a v2-only blocker (ntfs) does not change allOk/canProceedOffline', async () => {
  const p = await precheck({
    timeoutMs: 1000,
    deps: {
      // Task 25: one merged JSON response instead of per-command branching --
      // disk 5GB (ok) + PS 5.1.1.1 FullLanguage (ok) + FAT32 (not ok) so only
      // the ntfs check fails, in one round trip.
      runFn: psRunFn({
        diskFreeBytes: 5 * GB,
        psVersion: '5.1.1.1',
        languageMode: 'FullLanguage',
        volumeFileSystem: 'FAT32',
      }),
      fetchFn: async () => ({ status: 200, text: async () => '' }),
      probeOpenFn: async () => false,
      existsFn: () => true,
    },
  });
  assert.ok(p.blockers.find((b) => b.id === 'ntfs'), 'ntfs blocker expected');
  // Pre-v2 formula only ever looked at os/arch/disk/net/browser.
  assert.equal(p.allOk, p.os.ok && p.arch.ok && p.disk.ok && p.net.ok && p.browser.ok);
  assert.equal(p.canProceedOffline, p.os.ok && p.arch.ok && p.disk.ok && p.browser.ok);
});
