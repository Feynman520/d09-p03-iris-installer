// finalize-vm.mjs -- take over the tail of verify/vm/create.mjs after its
// 90-minute guest-control wait gave up while the unattended install was still
// running inside the guest. Same steps as create.mjs main() after the wait:
// wait for guest control -> check baked.json -> ACPI shutdown -> detach optical
// -> boot from disk -> snapshot "clean" (powered off).
//
// Usage: IRIS_VM_PASSWORD=... node finalize-vm.mjs <vm-name> [maxWaitMin]
import { makeVbox, requirePassword, waitForGuestControl, waitForPowerOff, log } from './lib.mjs';
import { finalizePlan, DEFAULTS } from './create.mjs';

const name = process.argv[2];
const maxWaitMin = Number(process.argv[3] ?? 120);
if (!name) throw new Error('vm name required');
const opts = { ...DEFAULTS, name };
const password = requirePassword(process.env);
const vbox = makeVbox();

log(`finalize: waiting for guest control on "${name}" (up to ${maxWaitMin} min, probe every 60 s)...`);
const ready = await waitForGuestControl(vbox, name, opts.user, password, { pollMs: 60 * 1000, maxMs: maxWaitMin * 60 * 1000 });
if (!ready) {
  log('WARNING: guest control still not answering. Nothing changed.');
  process.exitCode = 2;
} else {
  const probe = vbox([
    'guestcontrol', name, 'run', '--username', opts.user, '--password', password, '--profile',
    '--exe', 'C:\\Windows\\System32\\cmd.exe', '--wait-stdout', '--wait-stderr',
    '--', 'cmd.exe', '/c', 'type C:\\iris-vm\\baked.json',
  ], { allowFail: true, timeout: 60 * 1000 });
  if (probe.code === 0 && probe.out.includes('elevationQueue')) {
    log(`bake: baked.json is present in the guest (${probe.out.length} bytes).`);
    log(probe.out);
  } else {
    log('WARNING: C:\\iris-vm\\baked.json is missing or unreadable. Inspect C:\\vboxpostinstall.log and C:\\iris-vm\\bake-run.log inside the guest.');
    log(`probe code=${probe.code} out=${probe.out} err=${probe.err}`);
  }
  const info = vbox(['showvminfo', name, '--machinereadable'], { allowFail: true });
  const plan2 = finalizePlan(opts, { machineReadable: info.out });
  for (const args of plan2) {
    log(`VBoxManage ${args[0]} ${args[2] ?? args[1] ?? ''}`);
    vbox(args, { allowFail: args[1] === 'acpipowerbutton' || args[2] === 'acpipowerbutton' });
    if (args[2] === 'acpipowerbutton') {
      log('waiting for the guest to power off (up to 5 min)...');
      const st = await waitForPowerOff(vbox, name);
      log(`VM state: ${st}`);
    }
  }
  log(`done. VM "${name}" is installed and snapshotted as "${opts.snapshot}" (powered off, no install media attached).`);
}
