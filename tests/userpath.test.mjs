import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readUserEnv, addUserPath, removeUserPath, setUserEnv, removeUserEnv,
} from '../installer/lib/userpath.mjs';

// Every test injects regQuery/regAdd/regDelete/notify so the real HKCU
// registry of the machine running `node --test` is never touched. The
// injected fakes speak the exact shape the real ones do:
//   regQuery(name) -> {code, out}       (reg.exe query HKCU\Environment /v <name>)
//   regAdd(name, type, value) -> {code} (reg.exe add ... /t <type> /d <value> /f)
//   regDelete(name) -> {code}           (reg.exe delete ... /v <name> /f)

function makeReg(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { add: [], del: [], notify: 0 };
  const deps = {
    regQuery: async (name) => {
      const hit = store.get(name);
      if (!hit) return { code: 1, out: '', err: 'ERROR: unable to find the specified registry key or value.' };
      return { code: 0, out: `\r\nHKEY_CURRENT_USER\\Environment\r\n    ${name}    ${hit.type}    ${hit.value}\r\n\r\n`, err: '' };
    },
    regAdd: async (name, type, value) => {
      calls.add.push({ name, type, value });
      store.set(name, { type, value });
      return { code: 0, out: '', err: '' };
    },
    regDelete: async (name) => {
      calls.del.push({ name });
      store.delete(name);
      return { code: 0, out: '', err: '' };
    },
    notify: async () => { calls.notify += 1; return { code: 0, out: '', err: '' }; },
  };
  return { store, calls, deps };
}

test('readUserEnv parses reg.exe output, including values containing spaces', async () => {
  const reg = makeReg({ Path: { type: 'REG_EXPAND_SZ', value: 'C:\\Program Files\\Git\\cmd;%USERPROFILE%\\bin' } });
  const got = await readUserEnv('Path', reg.deps);
  assert.equal(got.exists, true);
  assert.equal(got.type, 'REG_EXPAND_SZ');
  assert.equal(got.value, 'C:\\Program Files\\Git\\cmd;%USERPROFILE%\\bin');

  const missing = await readUserEnv('CODEX_HOME', reg.deps);
  assert.equal(missing.exists, false);
  assert.equal(missing.value, null);
});

test('addUserPath: already present -> changed=false, nothing written', async () => {
  const dir = 'C:\\NOVA\\_agent\\shared\\shims';
  const reg = makeReg({ Path: { type: 'REG_EXPAND_SZ', value: `C:\\other;${dir};C:\\more` } });
  const r = await addUserPath(dir, reg.deps);
  assert.equal(r.changed, false);
  assert.equal(r.before, r.after);
  assert.deepEqual(reg.calls.add, []);
  assert.equal(reg.calls.notify, 0);
});

test('addUserPath: absent -> prepended, written as REG_EXPAND_SZ, WM_SETTINGCHANGE broadcast', async () => {
  const dir = 'C:\\NOVA\\_agent\\shared\\shims';
  const reg = makeReg({ Path: { type: 'REG_EXPAND_SZ', value: 'C:\\other;C:\\more' } });
  const r = await addUserPath(dir, reg.deps);
  assert.equal(r.changed, true);
  assert.equal(r.before, 'C:\\other;C:\\more');
  assert.equal(r.after, `${dir};C:\\other;C:\\more`);
  assert.equal(reg.calls.add.length, 1);
  assert.equal(reg.calls.add[0].name, 'Path');
  // REG_EXPAND_SZ must survive: writing REG_SZ back would permanently break
  // every %VAR% already in the user's Path.
  assert.equal(reg.calls.add[0].type, 'REG_EXPAND_SZ');
  assert.equal(reg.calls.add[0].value, `${dir};C:\\other;C:\\more`);
  assert.equal(reg.calls.notify, 1);
  assert.equal(reg.store.get('Path').value, `${dir};C:\\other;C:\\more`);
});

// Measured on the development machine 2026-09-11: the user Path there is
// REG_SZ, not REG_EXPAND_SZ. Forcing REG_EXPAND_SZ on the way back would
// change the semantics of a value the installer was only asked to prepend one
// entry to (and would show up as a registry diff after an uninstall).
test('addUserPath / setUserEnv: an existing REG_SZ value keeps REG_SZ', async () => {
  const dir = 'C:\\NOVA\\_agent\\shared\\shims';
  const reg = makeReg({
    Path: { type: 'REG_SZ', value: 'C:\\other' },
    CODEX_HOME: { type: 'REG_SZ', value: 'D:\\elsewhere' },
  });
  await addUserPath(dir, reg.deps);
  assert.equal(reg.calls.add[0].type, 'REG_SZ');
  assert.equal(reg.store.get('Path').type, 'REG_SZ');

  await setUserEnv('CODEX_HOME', 'C:\\NOVA\\_agent\\codex', reg.deps);
  assert.equal(reg.calls.add[1].type, 'REG_SZ');

  await removeUserPath(dir, reg.deps);
  assert.equal(reg.calls.add[2].type, 'REG_SZ');
  assert.equal(reg.store.get('Path').value, 'C:\\other');
});

test('addUserPath: no Path value at all -> creates it with just the shim dir', async () => {
  const dir = 'C:\\NOVA\\_agent\\shared\\shims';
  const reg = makeReg({});
  const r = await addUserPath(dir, reg.deps);
  assert.equal(r.changed, true);
  assert.equal(r.before, '');
  assert.equal(r.after, dir);
  assert.equal(reg.calls.add[0].type, 'REG_EXPAND_SZ');
});

test('addUserPath: comparison ignores case and a trailing backslash', async () => {
  const dir = 'C:\\NOVA\\_agent\\shared\\shims';
  const reg = makeReg({ Path: { type: 'REG_EXPAND_SZ', value: 'C:\\nova\\_AGENT\\shared\\shims\\;C:\\more' } });
  const r = await addUserPath(dir, reg.deps);
  assert.equal(r.changed, false);
  assert.deepEqual(reg.calls.add, []);
});

test('removeUserPath: drops only that entry and leaves the rest in order', async () => {
  const dir = 'C:\\NOVA\\_agent\\shared\\shims';
  const reg = makeReg({ Path: { type: 'REG_EXPAND_SZ', value: `${dir};C:\\other;C:\\more` } });
  const r = await removeUserPath(dir, reg.deps);
  assert.equal(r.changed, true);
  assert.equal(r.after, 'C:\\other;C:\\more');
  assert.equal(reg.calls.add.length, 1);
  assert.equal(reg.calls.add[0].type, 'REG_EXPAND_SZ');
  assert.equal(reg.store.get('Path').value, 'C:\\other;C:\\more');
});

test('removeUserPath: not present -> changed=false, no write', async () => {
  const reg = makeReg({ Path: { type: 'REG_EXPAND_SZ', value: 'C:\\other;C:\\more' } });
  const r = await removeUserPath('C:\\NOVA\\_agent\\shared\\shims', reg.deps);
  assert.equal(r.changed, false);
  assert.deepEqual(reg.calls.add, []);
});

test('setUserEnv: absent -> written, previous=null (so cleanup knows to delete)', async () => {
  const reg = makeReg({});
  const r = await setUserEnv('CODEX_HOME', 'C:\\NOVA\\_agent\\codex', reg.deps);
  assert.equal(r.changed, true);
  assert.equal(r.previous, null);
  assert.equal(reg.calls.add[0].name, 'CODEX_HOME');
  assert.equal(reg.calls.add[0].value, 'C:\\NOVA\\_agent\\codex');
});

test('setUserEnv: different value -> previous preserved for the receipt', async () => {
  const reg = makeReg({ CODEX_HOME: { type: 'REG_SZ', value: 'D:\\elsewhere\\codex' } });
  const r = await setUserEnv('CODEX_HOME', 'C:\\NOVA\\_agent\\codex', reg.deps);
  assert.equal(r.changed, true);
  assert.equal(r.previous, 'D:\\elsewhere\\codex');
});

test('setUserEnv: same value -> changed=false, no write', async () => {
  const reg = makeReg({ CODEX_HOME: { type: 'REG_EXPAND_SZ', value: 'C:\\NOVA\\_agent\\codex' } });
  const r = await setUserEnv('CODEX_HOME', 'C:\\NOVA\\_agent\\codex', reg.deps);
  assert.equal(r.changed, false);
  assert.deepEqual(reg.calls.add, []);
});

test('removeUserEnv: deletes when present, no-ops when absent', async () => {
  const reg = makeReg({ CODEX_HOME: { type: 'REG_SZ', value: 'C:\\NOVA\\_agent\\codex' } });
  const hit = await removeUserEnv('CODEX_HOME', reg.deps);
  assert.equal(hit.changed, true);
  assert.equal(hit.previous, 'C:\\NOVA\\_agent\\codex');
  assert.equal(reg.store.has('CODEX_HOME'), false);

  const miss = await removeUserEnv('CODEX_HOME', reg.deps);
  assert.equal(miss.changed, false);
  assert.equal(reg.calls.del.length, 1);
});
