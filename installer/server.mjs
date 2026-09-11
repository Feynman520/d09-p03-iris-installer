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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// name-stub validation (Task 11 replaces this with the real precheck: guide
// 2-1 rules, existing-soul detection via soul-state.json, NTFS/reparse
// checks). For now this only screens out names that would collide with a
// well-known Windows system folder or contain characters/trailing
// dot-or-space Windows itself forbids in a path segment.
// ---------------------------------------------------------------------------
const RESERVED_NAMES = new Set([
  'windows',
  'users',
  'program files',
  'program files (x86)',
  'programdata',
  'system volume information',
]);
const FORBIDDEN_CHARS = /[<>:"/\\|?*]/;

// TODO Task 11: real precheck (existing soul detection, guide 2-1 full rule
// set, NTFS/reparse-point checks) -- this stub only rejects a fixed list of
// reserved Windows names plus the characters Windows forbids outright.
export function isReservedName(name) {
  if (typeof name !== 'string' || name.length === 0) return true;
  if (RESERVED_NAMES.has(name.toLowerCase())) return true;
  if (FORBIDDEN_CHARS.test(name)) return true;
  if (/[. ]$/.test(name)) return true; // trailing dot or space
  return false;
}

// ---------------------------------------------------------------------------
// small http helpers
// ---------------------------------------------------------------------------
function writeHeaders(res, status, extra = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...extra });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  writeHeaders(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
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
      sendJson(res, err.statusCode ?? 400, { ok: false, reason: 'bad_request' });
      return;
    }
    await handler(body, req, res, url);
  };
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export function startServer({ port = 3460, zipRoot, nodeDir, stateFile, onQuit } = {}) {
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

  // TODO Task 11: real precheck (OS version, 64-bit, free disk space,
  // claude.ai/chatgpt.com reachability, default browser present).
  routes.set('POST /api/precheck', withBody(async (body, req, res) => {
    sendJson(res, 501, { ok: false, reason: 'not_implemented', task: 11 });
  }));

  // TODO Task 11: real name check (guide 2-1 full rule set, existing-soul
  // detection via soul-state.json -> existing:'soul', occupied-non-soul
  // folder -> existing:'conflict').
  routes.set('POST /api/name', withBody(async (body, req, res) => {
    const name = body?.name;
    if (isReservedName(name)) {
      sendJson(res, 200, { ok: false, reason: 'reserved' });
      return;
    }
    sendJson(res, 200, { ok: true, path: `C:\\${name}`, existing: 'none' });
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

  // TODO Task 12: run the actual copy pipeline (payload -> _agent\shared\
  // tools, shims, PATH, receipt, MOTW removal) and drive install.parts via
  // the SSE stream below. For now this only flips the wizard step and
  // acknowledges the request.
  routes.set('POST /api/install', withBody(async (body, req, res) => {
    state.step = 'install';
    state.install = state.install ?? { parts: {} };
    saveState(stateFile, state);
    sendJson(res, 202, { ok: true, note: 'TODO Task 12: install pipeline not yet implemented' });
  }));

  // TODO Task 12: push {part, pct, done, error} events as the copy pipeline
  // actually progresses. For now this streams one snapshot of the current
  // install state and leaves the connection open.
  routes.set('GET /api/install/events', async (req, res) => {
    writeHeaders(res, 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(state.install ?? { parts: {} })}\n\n`);
  });

  // TODO Task 13: CLI self-login flow (spawn claude/codex login in a
  // proxy-free console, detect the resulting auth file, hand off to
  // TeamClaude) + status polling.
  routes.set('POST /api/login', withBody(async (body, req, res) => {
    sendJson(res, 501, { ok: false, reason: 'not_implemented', task: 13 });
  }));

  routes.set('GET /api/login/status', async (req, res) => {
    sendJson(res, 501, { ok: false, reason: 'not_implemented', task: 13 });
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
        close: () => new Promise((res) => server.close(() => res())),
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
