#!/usr/bin/env node
// IRIS installer local server. Launched by installer/bootstrap.ps1 as:
//   node server.mjs --zip-root "<zipRoot>" --port 3460 --node-dir "<nodeDir>"
// node:http only, no dependencies, ESM. 127.0.0.1 only. English/code
// messages only -- Korean UI text lives in installer/ui/index.html, not
// here (repo-wide constraint: server messages are for logs/JSON, not
// screens).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initialState, loadState, saveState } from './lib/state.mjs';
import { precheck } from './lib/precheck.mjs';
import { validateSoulName, detectExisting } from './lib/soulname.mjs';
import { install as defaultInstall } from './lib/install.mjs';
import { ensureProxy as defaultEnsureProxy } from './lib/proxy.mjs';
import {
  startCliLogin as defaultStartCliLogin,
  cliLoginStatus as defaultCliLoginStatus,
  relayImport as defaultRelayImport,
  relayStatus as defaultRelayStatus,
  resolveTeamclaudeConfigPath,
  countProviderAccounts as defaultCountProviderAccounts,
} from './lib/login.mjs';
import {
  readReceipt, writeReceipt, setLogin as setReceiptLogin, markStep as markReceiptStep,
} from './lib/receipt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// small http helpers
// ---------------------------------------------------------------------------
function writeHeaders(res, status, extra = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...extra });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  writeHeaders(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

// Rejects with statusCode 413 once `limit` is exceeded, but does NOT destroy
// the request/socket itself -- that is the caller's job, and only *after*
// the 413 JSON response has been written and flushed (see withBody). Doing
// it here raced the response write against the socket teardown and produced
// a client-side ECONNRESET instead of the coded 413 (fix round 1 finding 1).
// Memory still stays bounded: once overLimit flips, further chunks are
// dropped on the floor (never pushed to `chunks`) instead of being buffered.
function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overLimit = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (overLimit) return; // already rejected; drop without buffering
      size += chunk.length;
      if (size > limit) {
        overLimit = true;
        chunks.length = 0; // release what we had buffered so far
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overLimit) return; // already settled above
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid json'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Static files come only from installer/ui/ -- GET / -> ui/index.html
// (which does not exist yet as of Task 10; Task 14 adds it, so this
// currently 404s, by design). path.normalize + a startsWith prefix check
// keeps `..`/absolute-path segments in the URL from escaping uiDir.
function serveStatic(uiDir, pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.slice(1));
  } catch {
    sendJson(res, 400, { ok: false, reason: 'bad_request' });
    return;
  }
  const resolved = path.normalize(path.join(uiDir, rel));
  const uiDirNormalized = path.normalize(uiDir);
  if (resolved !== uiDirNormalized && !resolved.startsWith(uiDirNormalized + path.sep)) {
    sendJson(res, 403, { ok: false, reason: 'forbidden' });
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, reason: 'not_found' });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    writeHeaders(res, 200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function readPackageVersion(zipRoot) {
  try {
    const manifestPath = path.join(zipRoot, 'payload', 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return mf?.package?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function withBody(handler) {
  return async (req, res, url) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const status = err.statusCode ?? 400;
      if (status === 413) {
        // The client may still be streaming the rest of an oversized body.
        // Write the JSON response (with Connection: close so the socket is
        // not reused for a request we never fully read) and only destroy
        // the request stream once that response has actually been flushed,
        // so the client sees the coded 413 instead of a connection reset.
        sendJson(res, 413, { ok: false, reason: 'bad_request' }, { Connection: 'close' });
        res.on('finish', () => { req.destroy(); });
      } else {
        sendJson(res, status, { ok: false, reason: 'bad_request' });
      }
      return;
    }
    await handler(body, req, res, url);
  };
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function readPayloadManifest(zipRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(zipRoot, 'payload', 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

// lock.json is a build-time artifact that also travels in the zip next to
// installer/ (it is what says which parts exist, their kinds and the
// download-only ones). Fall back to the repo copy when running from a git
// checkout (dev / rehearsal).
function readLock(zipRoot) {
  const candidates = [
    zipRoot ? path.join(zipRoot, 'lock.json') : null,
    path.resolve(HERE, '..', 'lock.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* try next */ }
  }
  return null;
}

export function startServer({
  port = 3460,
  zipRoot,
  nodeDir,
  stateFile,
  onQuit,
  installFn = defaultInstall,
  ensureProxyFn = defaultEnsureProxy,
  startCliLoginFn = defaultStartCliLogin,
  cliLoginStatusFn = defaultCliLoginStatus,
  relayImportFn = defaultRelayImport,
  relayStatusFn = defaultRelayStatus,
  countProviderAccountsFn = defaultCountProviderAccounts,
  teamclaudeConfigPath,
} = {}) {
  const uiDir = path.join(HERE, 'ui');
  const version = readPackageVersion(zipRoot);

  // Restore prior progress (refresh / re-run) but always take this run's
  // zipRoot/nodeDir -- the invocation just told us where those actually are
  // right now.
  let state = loadState(stateFile);
  if (!state) {
    state = initialState({ zipRoot, nodeDir });
  } else {
    state.zipRoot = zipRoot;
    state.nodeDir = nodeDir;
  }
  saveState(stateFile, state);

  const routes = new Map();

  routes.set('GET /api/health', async (req, res) => {
    sendJson(res, 200, { ok: true, name: 'iris-installer', version, step: state.step });
  });

  routes.set('GET /api/state', async (req, res) => {
    sendJson(res, 200, state);
  });

  routes.set('POST /api/precheck', withBody(async (body, req, res) => {
    const result = await precheck();
    state.precheck = result;
    state.step = 'name';
    saveState(stateFile, state);
    sendJson(res, 200, result);
  }));

  routes.set('POST /api/name', withBody(async (body, req, res) => {
    const name = body?.name;
    const validation = validateSoulName(name);
    if (!validation.ok) {
      sendJson(res, 200, { ok: false, reason: validation.reason });
      return;
    }
    const existing = detectExisting(validation.path);
    if (existing === 'conflict') {
      sendJson(res, 200, { ok: false, reason: 'conflict' });
      return;
    }
    state.soul = { name, root: validation.path, existing };
    state.step = 'choice';
    saveState(stateFile, state);
    sendJson(res, 200, { ok: true, path: validation.path, existing });
  }));

  // Decision rule = docs/설계.md D7/§3-3 ⓒ: choosing both subscriptions has
  // Claude Code lead the initial setup.
  routes.set('POST /api/choice', withBody(async (body, req, res) => {
    const subs = Array.isArray(body?.subscriptions)
      ? [...new Set(body.subscriptions.filter((s) => s === 'claude' || s === 'chatgpt'))]
      : [];
    if (subs.length === 0) {
      sendJson(res, 200, { ok: false, reason: 'empty' });
      return;
    }
    const leadAgent = subs.includes('claude') ? 'claude' : 'chatgpt';
    const guideEdition = leadAgent;
    state.choice = { subscriptions: subs, leadAgent, guideEdition };
    saveState(stateFile, state);
    sendJson(res, 200, { ok: true, leadAgent, guideEdition });
  }));

  // --- install (copy) step ------------------------------------------------
  // The copy runs in the background while the screen watches
  // GET /api/install/events. Events are also buffered, so a browser that
  // refreshes mid-install (or connects after POST) replays everything it
  // missed instead of showing an empty progress bar. The receipt under the
  // soul root -- not this buffer -- stays the source of truth.
  const installEvents = [];
  const sseClients = new Set();
  let installRunning = false;

  function pushEvent(event) {
    installEvents.push(event);
    if (event.part) {
      state.install = state.install ?? { parts: {} };
      // `status` is authoritative when the event carries one. The old
      // pct === 100 heuristic was wrong for every part but the last: install()
      // reports a part's completion at floor((i+1)/total*100) -- 9, 18, ... 90
      // -- so ten of eleven parts stayed 'running' forever in the state a
      // refreshed screen reads back (fix round 1 finding 2). pct is now only
      // the fallback for an event that has no status at all.
      state.install.parts[event.part] = event.error ? 'error'
        : event.skipped ? 'skipped'
          : event.status ? event.status
            : event.pct === 100 ? 'done' : 'running';
    }
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  }

  routes.set('POST /api/install', withBody(async (body, req, res) => {
    if (!state.soul?.root) {
      sendJson(res, 409, { ok: false, reason: 'no_soul' });
      return;
    }
    if (installRunning) {
      sendJson(res, 202, { ok: true, running: true });
      return;
    }
    const manifest = readPayloadManifest(state.zipRoot);
    const lock = readLock(state.zipRoot);
    if (!manifest || !lock) {
      sendJson(res, 500, { ok: false, reason: 'payload_unreadable' });
      return;
    }

    installRunning = true;
    installEvents.length = 0;
    state.step = 'install';
    state.install = { parts: {} };
    saveState(stateFile, state);
    sendJson(res, 202, { ok: true });

    // Deliberately not awaited: the HTTP response is already out and the
    // caller now follows /api/install/events.
    installFn({
      root: state.soul.root,
      name: state.soul.name,
      existing: state.soul.existing,
      zipRoot: state.zipRoot,
      manifest,
      lock,
      choice: state.choice ?? { subscriptions: [], leadAgent: 'claude', guideEdition: 'claude' },
      onProgress: (e) => pushEvent({ part: null, pct: null, done: false, error: null, ...e }),
    }).then(() => {
      state.step = 'login';
      saveState(stateFile, state);
    }).catch((err) => {
      // install() already emitted the coded error event; state.install.parts
      // keeps the failing part marked 'error' for a screen refresh.
      state.step = 'install';
      state.installError = err?.code ?? String(err?.message ?? err);
      saveState(stateFile, state);
    }).finally(() => {
      installRunning = false;
      saveState(stateFile, state);
    });
  }));

  routes.set('GET /api/install/events', async (req, res) => {
    writeHeaders(res, 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    for (const e of installEvents) res.write(`data: ${JSON.stringify(e)}\n\n`);
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
  });

  // --- login step ----------------------------------------------------------
  // Two-stage flow (task-13-brief.md): ① startCliLogin opens the CLI's own
  // OAuth in a proxy-free console; ② once that credential file exists,
  // relayImport hands it to TeamClaude and relayStatus polls the config
  // file's per-provider account count. GET /api/login/status is what the
  // screen polls every 2s -- it also advances stage ①→② and, once every
  // chosen subscription is fully done, flips the receipt/state to handoff.
  const relayImportInFlight = new Set();

  function getTeamclaudeConfigPath() {
    return teamclaudeConfigPath ?? resolveTeamclaudeConfigPath();
  }

  routes.set('POST /api/login', withBody(async (body, req, res) => {
    const provider = body?.provider;
    if (provider !== 'claude' && provider !== 'chatgpt') {
      sendJson(res, 200, { ok: false, reason: 'bad_provider' });
      return;
    }
    if (!state.soul?.root) {
      sendJson(res, 409, { ok: false, reason: 'no_soul' });
      return;
    }
    const root = state.soul.root;
    const configPath = getTeamclaudeConfigPath();
    const [proxyResult, accountsBefore] = await Promise.all([
      ensureProxyFn({ root, nodeDir: state.nodeDir }),
      countProviderAccountsFn({ teamclaudeConfigPath: configPath, provider }).catch(() => 0),
    ]);
    const { pid } = startCliLoginFn({ root, nodeDir: state.nodeDir, provider });

    state.login = state.login ?? {};
    state.login[provider] = {
      startedAt: new Date().toISOString(),
      accountsBefore,
      cli: 'pending',
      relay: 'pending',
      relayMethod: null,
      pid,
    };

    // Record which TeamClaude config path is in play (brief: receipt
    // env.teamclaudeConfig). Only meaningful once the receipt exists
    // (created by install's copy step, which always runs before login).
    const receipt = readReceipt(root);
    if (receipt) {
      receipt.env = receipt.env ?? {};
      receipt.env.teamclaudeConfig = configPath;
      writeReceipt(root, receipt);
    }

    saveState(stateFile, state);
    sendJson(res, 200, { ok: true, alive: proxyResult.alive, started: proxyResult.started, pid });
  }));

  routes.set('GET /api/login/status', async (req, res) => {
    const root = state.soul?.root;
    const subs = state.choice?.subscriptions ?? [];
    if (!root || !state.login || subs.length === 0) {
      sendJson(res, 200, { ok: true, step: state.step, providers: {} });
      return;
    }
    const configPath = getTeamclaudeConfigPath();

    for (const provider of subs) {
      const entry = state.login[provider];
      if (!entry) continue;

      if (entry.cli !== 'done') {
        entry.cli = cliLoginStatusFn({ provider, root });
      }

      // Stage ①→② handoff: kick off relayImport exactly once per provider,
      // and never run two at the same time for the same provider (this
      // route is polled every 2s and relayImport can be slow -- a real
      // spawn/CLI call).
      if (entry.cli === 'done' && entry.relayMethod == null && !relayImportInFlight.has(provider)) {
        relayImportInFlight.add(provider);
        relayImportFn({ provider, root, nodeDir: state.nodeDir, teamclaudeConfigPath: configPath })
          .then((r) => {
            entry.relayMethod = r.method;
            saveState(stateFile, state);
          })
          .catch(() => { /* leave relayMethod null -- retried on next poll */ })
          .finally(() => { relayImportInFlight.delete(provider); });
      }

      if (entry.relayMethod != null && entry.relay !== 'done') {
        entry.relay = await relayStatusFn({
          teamclaudeConfigPath: configPath, provider, accountsBefore: entry.accountsBefore,
        });
      }
    }
    saveState(stateFile, state);

    const allDone = subs.every((p) => state.login[p]?.cli === 'done' && state.login[p]?.relay === 'done');
    if (allDone && state.step !== 'handoff') {
      const receipt = readReceipt(root);
      if (receipt) {
        for (const provider of subs) {
          setReceiptLogin(receipt, provider, { cli: true, relay: true, relayMethod: state.login[provider].relayMethod });
        }
        markReceiptStep(receipt, 'login', 'done');
        writeReceipt(root, receipt);
      }
      state.step = 'handoff';
      saveState(stateFile, state);
    }

    const now = Date.now();
    const REOPEN_AFTER_MS = 60 * 60 * 1000; // 60 minutes, per the brief's "다시 열기" affordance
    const providers = {};
    for (const provider of subs) {
      const entry = state.login[provider];
      if (!entry) continue;
      const elapsedMs = now - Date.parse(entry.startedAt);
      providers[provider] = {
        cli: entry.cli,
        relay: entry.relay,
        relayMethod: entry.relayMethod,
        reopenAvailable: entry.cli !== 'done' && elapsedMs > REOPEN_AFTER_MS,
      };
    }
    sendJson(res, 200, { ok: true, step: state.step, providers });
  });

  // TODO Task 14: launch Face (launch.mjs --first-session), confirm the
  // daemon + one session, mark receipt steps.handoff=done, then quit.
  routes.set('POST /api/handoff', withBody(async (body, req, res) => {
    sendJson(res, 501, { ok: false, reason: 'not_implemented', task: 14 });
  }));

  routes.set('POST /api/quit', async (req, res) => {
    sendJson(res, 200, { ok: true });
    setTimeout(() => {
      if (onQuit) onQuit();
      else process.exit(0);
    }, 200);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (handler) {
        await handler(req, res, url);
        return;
      }
      if (req.method === 'GET') {
        serveStatic(uiDir, url.pathname, res);
        return;
      }
      sendJson(res, 404, { ok: false, reason: 'not_found' });
    } catch (err) {
      try {
        sendJson(res, 500, { ok: false, reason: 'internal_error', message: String(err?.message ?? err) });
      } catch {
        // response already sent/closed; nothing more to do
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((res) => {
          // An open SSE response keeps the socket alive forever, so
          // server.close() would never call back. End them first.
          for (const client of sseClients) { try { client.end(); } catch { /* already gone */ } }
          sseClients.clear();
          server.close(() => res());
        }),
      });
    });
  });
}

function parseArgs(argv) {
  const args = { port: 3460 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip-root') args.zipRoot = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--node-dir') args.nodeDir = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const work = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'IRIS-Installer')
    : path.join(os.tmpdir(), 'IRIS-Installer');
  const stateFile = path.join(work, 'state.json');
  startServer({ ...args, stateFile })
    .then(({ port }) => {
      console.log(`iris-installer server listening on 127.0.0.1:${port}`);
    })
    .catch((err) => {
      console.error(`iris-installer server failed to start: ${err?.stack ?? err}`);
      process.exit(1);
    });
}
