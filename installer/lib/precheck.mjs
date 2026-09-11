import os from 'node:os';
import { run } from '../../lib/run.mjs';

// docs/설계.md "정직한 한계" -- what this screen checks and why:
//   - Windows 10 1809+ or 11, 64-bit (Node 24 does not run on anything older
//     or 32-bit).
//   - claude.ai / chatgpt.com reachable at login time (a network that blocks
//     both has no workaround).
//   - 2 GB free disk.
//   - everything else (admin rights, existing Node, antivirus, execution
//     policy, PATH) is worked around by the self-contained bundle.
const MIN_BUILD = 17763; // Windows 10 version 1809
const MIN_DISK_GB = 2;
const NET_TARGETS = { claude: 'https://claude.ai/', chatgpt: 'https://chatgpt.com/' };
const BROWSER_ASSOC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';

function checkOs() {
  try {
    const detail = os.release(); // e.g. '10.0.26200' on Windows
    const build = Number(detail.split('.')[2]);
    if (!Number.isFinite(build)) return { ok: false, build: null, detail };
    return { ok: build >= MIN_BUILD, build, detail };
  } catch (err) {
    return { ok: false, build: null, detail: String(err?.message ?? err) };
  }
}

function checkArch() {
  try {
    const value = os.arch();
    return { ok: value === 'x64', value };
  } catch (err) {
    return { ok: false, value: null, detail: String(err?.message ?? err) };
  }
}

async function checkDisk(timeoutMs) {
  try {
    const { code, out, err } = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-PSDrive C).Free'], { timeoutMs });
    const bytes = Number(out);
    if (code !== 0 || !Number.isFinite(bytes)) {
      return { ok: false, freeGB: 0, detail: err || out || `powershell exit ${code}` };
    }
    const freeGB = bytes / 1024 ** 3;
    return { ok: freeGB >= MIN_DISK_GB, freeGB };
  } catch (e) {
    return { ok: false, freeGB: 0, detail: String(e?.message ?? e) };
  }
}

// Any HTTP response (even 4xx/5xx) means the host is reachable -- only a
// network error or the timeout firing counts as unreachable.
async function probeReachable(url, timeoutMs) {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

async function checkNet(timeoutMs) {
  try {
    const [claude, chatgpt] = await Promise.all([
      probeReachable(NET_TARGETS.claude, timeoutMs),
      probeReachable(NET_TARGETS.chatgpt, timeoutMs),
    ]);
    return { claude, chatgpt, ok: claude && chatgpt };
  } catch (e) {
    return { claude: false, chatgpt: false, ok: false, detail: String(e?.message ?? e) };
  }
}

// Missing/unreadable default-browser association is warning-level, not a
// hard blocker -- Start-Process URL usually still works without it. It is
// still folded into canProceedOffline per the interface contract; the
// screen (Task 14) is the one that decides whether to treat browser:false
// as a soft warning vs. blocking progress.
async function checkBrowser(timeoutMs) {
  try {
    const { code, out } = await run('reg.exe', ['query', BROWSER_ASSOC_KEY, '/v', 'ProgId'], { timeoutMs });
    const match = /ProgId\s+REG_SZ\s+(\S+)/.exec(out);
    if (code !== 0 || !match) return { ok: false, progId: null };
    return { ok: true, progId: match[1] };
  } catch (e) {
    return { ok: false, progId: null, detail: String(e?.message ?? e) };
  }
}

// precheck({timeoutMs=4000}) -> full shape, see task-11-brief.md. Never
// throws -- every probe above is individually wrapped so one failing check
// (e.g. no network) still yields a complete, well-shaped result.
export async function precheck({ timeoutMs = 4000 } = {}) {
  const osResult = checkOs();
  const arch = checkArch();
  const [disk, net, browser] = await Promise.all([
    checkDisk(timeoutMs),
    checkNet(timeoutMs),
    checkBrowser(timeoutMs),
  ]);
  const allOk = osResult.ok && arch.ok && disk.ok && net.ok && browser.ok;
  // Internet alone being unreachable still lets the wizard proceed as far as
  // guide-2-1 step (d) (인터넷만 ✗면 ⓓ까지 허용) -- login (Task 13) is where
  // the lack of network actually stops the user.
  const canProceedOffline = osResult.ok && arch.ok && disk.ok && browser.ok;
  return { os: osResult, arch, disk, net, browser, allOk, canProceedOffline };
}
