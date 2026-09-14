import fs from 'node:fs';
import path from 'node:path';

// First-run seeding (2026-09-13 pre-release review, step ⓕ).
//
// The very first thing a beginner sees inside the IRIS window is the lead
// CLI starting in a brand-new config home. Without these two files that
// means Claude Code's first-run wizard (text-style picker, notes) and the
// "Do you trust the files in this folder?" question, in English, before the
// setting-up session can even read its first request. Both are one-time
// prompts about a folder the installer itself just created, so the installer
// answers them the way the person would have to anyway.
//
// Rules (the installer's global promise: never delete or overwrite):
//   - Claude: `<root>\_agent\claude\.claude.json` -- created if absent,
//     otherwise only the missing keys are ADDED; every existing key (the
//     login step's oauthAccount, later session data) is kept byte-for-byte
//     as JSON values. An unreadable existing file is left alone.
//   - Codex:  `<root>\_agent\codex\config.toml` -- created if absent,
//     otherwise a `[projects.'<root>']` table is APPENDED only when the file
//     has no trust entry for this root yet. Nothing already in the file is
//     touched.
// Key names/shapes were read off a live Claude Code 2.1.x `.claude.json`
// (hasCompletedOnboarding, lastOnboardingVersion, projects["C:/IRIS"].
// hasTrustDialogAccepted -- note the FORWARD slashes in the project key) and
// a live Codex 0.154 config.toml ([projects.'c:\iris'] trust_level, lower
// case path in single quotes).

export function claudeConfigJsonPath(root) {
  return path.join(root, '_agent', 'claude', '.claude.json');
}

export function codexConfigTomlPath(root) {
  return path.join(root, '_agent', 'codex', 'config.toml');
}

// Claude Code keys `projects` by the absolute path with forward slashes.
export function claudeProjectKey(root) {
  return String(root).replace(/\\/g, '/').replace(/\/+$/, '');
}

// Codex writes the project table name lower-cased, backslashes kept, in
// single quotes (TOML literal string -- no escaping needed).
export function codexProjectKey(root) {
  return String(root).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * seedClaudeFirstRun(root, {claudeVersion})
 *   -> {path, written: 'created'|'merged'|'unchanged', added: string[], reason?}
 */
export function seedClaudeFirstRun(root, { claudeVersion = null } = {}) {
  const file = claudeConfigJsonPath(root);
  let data = {};
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { path: file, written: 'unchanged', added: [], reason: 'not-an-object' };
      }
      data = parsed;
    } catch (err) {
      return { path: file, written: 'unchanged', added: [], reason: `unreadable: ${err.message}` };
    }
  }

  const added = [];
  if (data.hasCompletedOnboarding !== true) {
    data.hasCompletedOnboarding = true;
    added.push('hasCompletedOnboarding');
  }
  if (claudeVersion && !data.lastOnboardingVersion) {
    data.lastOnboardingVersion = String(claudeVersion);
    added.push('lastOnboardingVersion');
  }
  if (data.projects === null || typeof data.projects !== 'object' || Array.isArray(data.projects)) {
    data.projects = {};
  }
  const key = claudeProjectKey(root);
  const existing = data.projects[key];
  const proj = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
  if (proj.hasTrustDialogAccepted !== true) {
    proj.hasTrustDialogAccepted = true;
    added.push(`projects[${key}].hasTrustDialogAccepted`);
  }
  data.projects[key] = proj;

  if (added.length === 0) return { path: file, written: 'unchanged', added };
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  return { path: file, written: existed ? 'merged' : 'created', added };
}

/**
 * seedCodexFirstRun(root)
 *   -> {path, written: 'created'|'appended'|'unchanged'}
 */
export function seedCodexFirstRun(root) {
  const file = codexConfigTomlPath(root);
  const key = codexProjectKey(root);
  const block = `[projects.'${key}']\ntrust_level = "trusted"\n`;
  if (!fs.existsSync(file)) {
    writeAtomic(file, block);
    return { path: file, written: 'created' };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { path: file, written: 'unchanged', reason: `unreadable: ${err.message}` };
  }
  // Already has a table for this root (any quoting style, any case)? Leave it.
  // TOML allows the path as a literal string ('c:\iris', what Codex writes)
  // or a basic string with doubled backslashes ("c:\\iris"); accept both.
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literal = reEsc(key);
  const basic = reEsc(key.replace(/\\/g, '\\\\'));
  const tableRe = new RegExp(`^\\s*\\[projects\\.(?:'${literal}'|"${basic}"|${literal})\\]`, 'im');
  if (tableRe.test(text)) return { path: file, written: 'unchanged' };
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(file, `${sep}\n${block}`, 'utf8');
  return { path: file, written: 'appended' };
}

// ---------------------------------------------------------------------------
// Maximum agent permissions from the very first session (user decision
// 2026-09-14: "권한을 최대로 주게 설정을 확실하게 확고하게"). The setting-up guide
// (1-3절) merges the same values later; seeding them here means the first
// session -- the one that reads the guide -- already runs without prompts.
// Same promise as above: only missing keys are added, nothing is overwritten.
//   Claude: <root>\_agent\claude\settings.json
//             permissions.defaultMode = "bypassPermissions"
//             skipDangerousModePermissionPrompt = true
//   Codex:  <root>\_agent\codex\config.toml  (top-level keys, so they are
//             written at the *top* of the file -- anything after a [table]
//             line would belong to that table)
//             approval_policy = "never"
//             sandbox_mode = "danger-full-access"
export function claudeSettingsPath(root) {
  return path.join(root, '_agent', 'claude', 'settings.json');
}
export const CLAUDE_MAX_PERMISSIONS = Object.freeze({
  permissions: Object.freeze({ defaultMode: 'bypassPermissions' }),
  skipDangerousModePermissionPrompt: true,
});
export const CODEX_MAX_PERMISSIONS = Object.freeze({ approval_policy: 'never', sandbox_mode: 'danger-full-access' });

export function seedClaudePermissions(root) {
  const file = claudeSettingsPath(root);
  let data = {};
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { path: file, written: 'unchanged', added: [], reason: 'not-an-object' };
      }
      data = parsed;
    } catch (err) {
      return { path: file, written: 'unchanged', added: [], reason: `unreadable: ${err.message}` };
    }
  }
  const added = [];
  const perms = (data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions)) ? data.permissions : {};
  if (perms.defaultMode !== CLAUDE_MAX_PERMISSIONS.permissions.defaultMode) {
    perms.defaultMode = CLAUDE_MAX_PERMISSIONS.permissions.defaultMode;
    added.push('permissions.defaultMode');
  }
  data.permissions = perms;
  if (data.skipDangerousModePermissionPrompt !== true) {
    data.skipDangerousModePermissionPrompt = true;
    added.push('skipDangerousModePermissionPrompt');
  }
  if (added.length === 0) return { path: file, written: 'unchanged', added };
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  return { path: file, written: existed ? 'merged' : 'created', added };
}

export function seedCodexPermissions(root) {
  const file = codexConfigTomlPath(root);
  let text = '';
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return { path: file, written: 'unchanged', added: [], reason: `unreadable: ${err.message}` };
    }
  }
  // Only the top-level region (before the first [table]) counts: a key of the
  // same name inside a table is a different setting.
  const firstTable = text.search(/^\s*\[/m);
  const top = firstTable === -1 ? text : text.slice(0, firstTable);
  const added = [];
  const lines = [];
  for (const [key, value] of Object.entries(CODEX_MAX_PERMISSIONS)) {
    if (!new RegExp(`^\\s*${key}\\s*=`, 'm').test(top)) {
      lines.push(`${key} = "${value}"`);
      added.push(key);
    }
  }
  if (added.length === 0) return { path: file, written: 'unchanged', added };
  const block = `${lines.join('\n')}\n`;
  const rest = text.length === 0 || text.startsWith('\n') ? text : `\n${text}`;
  writeAtomic(file, existed ? `${block}${rest}` : block);
  return { path: file, written: existed ? 'merged' : 'created', added };
}

/**
 * seedPermissions(root, {agents: ['claude','codex']})
 *   -> { claude?: ..., codex?: ... } -- one entry per agent actually seeded.
 */
export function seedPermissions(root, { agents = ['claude'] } = {}) {
  const out = {};
  if (agents.includes('claude')) out.claude = seedClaudePermissions(root);
  if (agents.includes('codex')) out.codex = seedCodexPermissions(root);
  return out;
}

/**
 * seedFirstRun(root, {agents: ['claude','codex'], claudeVersion})
 *   -> { claude?: ..., codex?: ... } -- one entry per agent actually seeded.
 */
export function seedFirstRun(root, { agents = ['claude'], claudeVersion = null } = {}) {
  const out = {};
  if (agents.includes('claude')) out.claude = seedClaudeFirstRun(root, { claudeVersion });
  if (agents.includes('codex')) out.codex = seedCodexFirstRun(root);
  return out;
}
