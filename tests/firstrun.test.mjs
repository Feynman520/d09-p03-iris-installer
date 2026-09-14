import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  seedClaudeFirstRun, seedCodexFirstRun, seedFirstRun,
  seedClaudePermissions, seedCodexPermissions, seedPermissions, claudeSettingsPath,
  claudeProjectKey, codexProjectKey, claudeConfigJsonPath, codexConfigTomlPath,
} from '../installer/lib/firstrun.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-firstrun-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const freshRoot = (label) => { const r = path.join(tmp, label, 'NOVA'); fs.mkdirSync(r, { recursive: true }); return r; };

test('project keys: Claude uses forward slashes as-is, Codex lower-case with backslashes', () => {
  assert.equal(claudeProjectKey('C:\\NOVA'), 'C:/NOVA');
  assert.equal(claudeProjectKey('C:\\NOVA\\'), 'C:/NOVA');
  assert.equal(codexProjectKey('C:\\NOVA'), 'c:\\nova');
  assert.equal(codexProjectKey('C:/NOVA/'), 'c:\\nova');
});

test('claude: fresh home -> .claude.json created with onboarding done + folder trusted', () => {
  const root = freshRoot('c-fresh');
  const r = seedClaudeFirstRun(root, { claudeVersion: '2.1.270' });
  assert.equal(r.written, 'created');
  assert.equal(r.path, claudeConfigJsonPath(root));
  const data = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.equal(data.hasCompletedOnboarding, true);
  assert.equal(data.lastOnboardingVersion, '2.1.270');
  assert.equal(data.projects[claudeProjectKey(root)].hasTrustDialogAccepted, true);
  assert.ok(!fs.existsSync(`${r.path}.tmp`), 'atomic write leaves no tmp file');
});

test('claude: existing file (login already wrote oauthAccount) -> only missing keys added, nothing else touched', () => {
  const root = freshRoot('c-merge');
  const file = claudeConfigJsonPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = {
    // No e-mail-shaped literal here on purpose: the repo-wide sanitize gate
    // (build/sanitize-rules.json) flags anything that looks like an address.
    oauthAccount: { emailAddress: 'kept-as-is', accountUuid: 'u-1' },
    numStartups: 3,
    projects: { 'D:/other': { hasTrustDialogAccepted: false, allowedTools: ['Bash'] } },
  };
  fs.writeFileSync(file, JSON.stringify(before), 'utf8');

  const r = seedClaudeFirstRun(root, { claudeVersion: '2.1.270' });
  assert.equal(r.written, 'merged');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data.oauthAccount, before.oauthAccount, 'login data must survive untouched');
  assert.equal(data.numStartups, 3);
  assert.deepEqual(data.projects['D:/other'], before.projects['D:/other'], 'other projects untouched');
  assert.equal(data.hasCompletedOnboarding, true);
  assert.equal(data.projects[claudeProjectKey(root)].hasTrustDialogAccepted, true);

  // Second run is a no-op.
  const again = seedClaudeFirstRun(root, { claudeVersion: '2.1.270' });
  assert.equal(again.written, 'unchanged');
  assert.deepEqual(again.added, []);
});

test('claude: an already-completed onboarding version is never overwritten; unreadable JSON is left alone', () => {
  const root = freshRoot('c-keep');
  const file = claudeConfigJsonPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.100' }), 'utf8');
  seedClaudeFirstRun(root, { claudeVersion: '2.1.270' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastOnboardingVersion, '2.1.100');

  const root2 = freshRoot('c-broken');
  const file2 = claudeConfigJsonPath(root2);
  fs.mkdirSync(path.dirname(file2), { recursive: true });
  fs.writeFileSync(file2, '{ not json', 'utf8');
  const r = seedClaudeFirstRun(root2);
  assert.equal(r.written, 'unchanged');
  assert.match(r.reason, /unreadable/);
  assert.equal(fs.readFileSync(file2, 'utf8'), '{ not json', 'a broken file is never rewritten');
});

test('codex: fresh home -> config.toml created; existing file -> table appended once; existing trust -> unchanged', () => {
  const root = freshRoot('x-fresh');
  const r = seedCodexFirstRun(root);
  assert.equal(r.written, 'created');
  const text = fs.readFileSync(codexConfigTomlPath(root), 'utf8');
  assert.match(text, /^\[projects\.'c:\\[^']*\\nova'\]\ntrust_level = "trusted"\n$/);

  const root2 = freshRoot('x-append');
  const file2 = codexConfigTomlPath(root2);
  fs.mkdirSync(path.dirname(file2), { recursive: true });
  fs.writeFileSync(file2, 'model = "gpt-5.6-terra"\napprovals_reviewer = "user"', 'utf8'); // no trailing newline on purpose
  assert.equal(seedCodexFirstRun(root2).written, 'appended');
  const text2 = fs.readFileSync(file2, 'utf8');
  assert.ok(text2.startsWith('model = "gpt-5.6-terra"\napprovals_reviewer = "user"\n'), 'existing lines kept, newline restored');
  assert.equal((text2.match(/trust_level/g) || []).length, 1);
  assert.equal(seedCodexFirstRun(root2).written, 'unchanged', 'second run appends nothing');
  assert.equal((fs.readFileSync(file2, 'utf8').match(/trust_level/g) || []).length, 1);

  const root3 = freshRoot('x-has');
  const file3 = codexConfigTomlPath(root3);
  fs.mkdirSync(path.dirname(file3), { recursive: true });
  fs.writeFileSync(file3, `[projects."${codexProjectKey(root3).replace(/\\/g, '\\\\')}"]\ntrust_level = "trusted"\n`, 'utf8');
  assert.equal(seedCodexFirstRun(root3).written, 'unchanged');
});

test('seedFirstRun: seeds only the agents asked for', () => {
  const root = freshRoot('both');
  const r = seedFirstRun(root, { agents: ['claude'], claudeVersion: '2.1.270' });
  assert.ok(r.claude);
  assert.equal(r.codex, undefined);
  assert.ok(!fs.existsSync(codexConfigTomlPath(root)));
  const r2 = seedFirstRun(root, { agents: ['claude', 'codex'] });
  assert.equal(r2.claude.written, 'unchanged');
  assert.equal(r2.codex.written, 'created');
});

// 2026-09-14 (user decision): the first session already runs with maximum
// permissions -- the installer seeds them, add-only, before Face opens.
test('claude permissions: fresh settings.json created with bypassPermissions; existing keys kept; second run unchanged', () => {
  const root = freshRoot('perm-c');
  const r = seedClaudePermissions(root);
  assert.equal(r.written, 'created');
  assert.deepEqual(r.added, ['permissions.defaultMode', 'skipDangerousModePermissionPrompt']);
  const data = JSON.parse(fs.readFileSync(claudeSettingsPath(root), 'utf8'));
  assert.equal(data.permissions.defaultMode, 'bypassPermissions');
  assert.equal(data.skipDangerousModePermissionPrompt, true);
  assert.equal(seedClaudePermissions(root).written, 'unchanged');

  // an existing settings.json with its own keys (and an allow list) keeps them all
  const root2 = freshRoot('perm-c2');
  const file2 = claudeSettingsPath(root2);
  fs.mkdirSync(path.dirname(file2), { recursive: true });
  fs.writeFileSync(file2, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(git *)'], defaultMode: 'acceptEdits' } }), 'utf8');
  const r2 = seedClaudePermissions(root2);
  assert.equal(r2.written, 'merged');
  const d2 = JSON.parse(fs.readFileSync(file2, 'utf8'));
  assert.equal(d2.model, 'opus');
  assert.deepEqual(d2.permissions.allow, ['Bash(git *)']);
  assert.equal(d2.permissions.defaultMode, 'bypassPermissions', 'a weaker mode is raised to the maximum');
  assert.equal(d2.skipDangerousModePermissionPrompt, true);

  // unreadable JSON is left alone
  const root3 = freshRoot('perm-c3');
  const file3 = claudeSettingsPath(root3);
  fs.mkdirSync(path.dirname(file3), { recursive: true });
  fs.writeFileSync(file3, '{ not json', 'utf8');
  assert.equal(seedClaudePermissions(root3).written, 'unchanged');
  assert.equal(fs.readFileSync(file3, 'utf8'), '{ not json');
});

test('codex permissions: top-level keys land ABOVE any [table]; present keys untouched; second run unchanged', () => {
  const root = freshRoot('perm-x');
  assert.equal(seedCodexPermissions(root).written, 'created');
  const text = fs.readFileSync(codexConfigTomlPath(root), 'utf8');
  assert.equal(text, 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n');
  assert.equal(seedCodexPermissions(root).written, 'unchanged');

  // the trust table the first-run seeding wrote must stay a table of its own:
  // keys go before it, never after it
  const root2 = freshRoot('perm-x2');
  seedCodexFirstRun(root2);
  const r2 = seedCodexPermissions(root2);
  assert.equal(r2.written, 'merged');
  const text2 = fs.readFileSync(codexConfigTomlPath(root2), 'utf8');
  assert.ok(text2.startsWith('approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'), text2);
  assert.ok(text2.indexOf('approval_policy') < text2.indexOf('[projects.'), 'keys must precede the table');
  assert.equal((text2.match(/trust_level = "trusted"/g) || []).length, 1);

  // a key already set at top level (any value) is respected; only the missing one is added
  const root3 = freshRoot('perm-x3');
  const file3 = codexConfigTomlPath(root3);
  fs.mkdirSync(path.dirname(file3), { recursive: true });
  fs.writeFileSync(file3, 'approval_policy = "on-request"\n[projects.\'c:\\x\']\ntrust_level = "trusted"\n', 'utf8');
  const r3 = seedCodexPermissions(root3);
  assert.deepEqual(r3.added, ['sandbox_mode']);
  const text3 = fs.readFileSync(file3, 'utf8');
  assert.equal((text3.match(/approval_policy/g) || []).length, 1);
  assert.match(text3, /^sandbox_mode = "danger-full-access"\n/);

  // a same-named key INSIDE a table does not count as the top-level setting
  const root4 = freshRoot('perm-x4');
  const file4 = codexConfigTomlPath(root4);
  fs.mkdirSync(path.dirname(file4), { recursive: true });
  fs.writeFileSync(file4, '[profiles.x]\napproval_policy = "never"\nsandbox_mode = "read-only"\n', 'utf8');
  assert.deepEqual(seedCodexPermissions(root4).added, ['approval_policy', 'sandbox_mode']);
});

test('seedPermissions: seeds only the agents asked for', () => {
  const root = freshRoot('perm-both');
  const r = seedPermissions(root, { agents: ['claude'] });
  assert.ok(r.claude);
  assert.equal(r.codex, undefined);
  assert.ok(!fs.existsSync(codexConfigTomlPath(root)));
  const r2 = seedPermissions(root, { agents: ['claude', 'codex'] });
  assert.equal(r2.claude.written, 'unchanged');
  assert.equal(r2.codex.written, 'created');
});
