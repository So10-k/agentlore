import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { c } from './util/term.js';
import { loreCommand, isOnPath } from './paths.js';
import { saveConfig, loadConfig } from './state.js';
import { readJson } from './util/io.js';

// The agent runs these itself; they only read or append to .lore/ and ~/.agentlore.
const LORE_RULES = ['learn', 'recall', 'lessons', 'forget', 'filter'].map((sub) => `Bash(lore ${sub}:*)`);
const PIPEFAIL_RULE = 'Bash(set -o pipefail)';

const CLAUDE_EVENTS = (compress) => [
  ['SessionStart', null, 10],
  ['UserPromptSubmit', null, 10],
  ['PreToolUse', 'Read|Edit|Write|MultiEdit|NotebookEdit|Bash', 10],
  ...(compress ? [['PostToolUse', 'Bash', 15]] : []),
  ['PreCompact', null, 30],
  ['PostCompact', null, 30],
  ['SessionEnd', null, 30], // the default 1.5s budget is too tight for a big transcript
];
const CODEX_EVENTS = [
  ['SessionStart', null, 10],
  ['UserPromptSubmit', null, 10],
  ['PreToolUse', null, 10],
  ['PreCompact', null, 30],
  ['PostCompact', null, 30],
  ['SessionEnd', null, 30],
];

function claudeSettingsPath(scope) {
  if (scope === 'project') return path.resolve('.claude/settings.json');
  if (scope === 'local') return path.resolve('.claude/settings.local.json');
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}
const codexHooksPath = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');

// Ours: our own hook command, or slimctx's (agentlore's predecessor).
const isOurs = (group) => group?.hooks?.some((h) => /(\blore|lore\.js"?|\bslimctx(\.js"?)?) hook$/.test(h.command || ''));

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.agentlore-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function setHooks(settings, events, command) {
  settings.hooks ??= {};
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event].filter((g) => !isOurs(g));
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  for (const [event, matcher, timeout] of events) {
    (settings.hooks[event] ??= []).push({
      ...(matcher && { matcher }),
      hooks: [{ type: 'command', command: `${command} hook`, timeout, ...(timeout >= 30 && { statusMessage: 'agentlore: saving handoff' }) }],
    });
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

export function install({ scope = 'user', codex = false, compress = true, dryRun = false } = {}) {
  const command = loreCommand();
  const global = isOnPath();
  const file = codex ? codexHooksPath() : claudeSettingsPath(scope);
  const settings = readJson(file, {});
  setHooks(settings, codex ? CODEX_EVENTS : CLAUDE_EVENTS(compress), command);

  if (!codex) {
    // Rewriting commands through `lore filter` needs `lore` on PATH.
    const rewrite = compress && global;
    settings.permissions ??= {};
    const allow = (settings.permissions.allow ?? []).filter((r) => !LORE_RULES.includes(r) && r !== PIPEFAIL_RULE && !/slimctx filter/.test(r));
    if (global) allow.push(...LORE_RULES.filter((r) => rewrite || !/filter/.test(r)));
    if (rewrite) allow.push(PIPEFAIL_RULE);
    settings.permissions.allow = allow;
    if (!allow.length) delete settings.permissions.allow;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
  }

  if (dryRun) return console.log(JSON.stringify(settings, null, 2));
  writeJson(file, settings);
  saveConfig({ compress, installedAt: loadConfig().installedAt || new Date().toISOString() });

  const agent = codex ? 'Codex' : 'Claude Code';
  console.log(`${c.green('✓')} agentlore hooks added to ${c.bold(file)}`);
  console.log(`  ${c.dim('session start')}   brief: standing lessons + recent handoffs`);
  console.log(`  ${c.dim('your messages')}   after a correction, ${agent} is asked to save a lesson`);
  console.log(`  ${c.dim('before tools')}    lessons for the file or command it's about to touch`);
  console.log(`  ${c.dim('compact / end')}   handoff saved to .lore/handoffs/`);
  if (!codex && compress) console.log(`  ${c.dim('Bash output')}     noisy test/build/install output compressed`);
  if (!global) console.log(c.yellow(`  ! \`lore\` isn't on your PATH. Run \`npm i -g agentlore\` so agents can run \`lore learn\` and \`lore recall\`.`));
  if (codex) console.log(`  Open Codex and run ${c.bold('/hooks')} to review and trust them; Codex skips untrusted hooks.`);
  else console.log(`  Takes effect in new sessions. Undo with \`lore uninstall\`.`);
}

export function uninstall({ scope = 'user', codex = false } = {}) {
  const file = codex ? codexHooksPath() : claudeSettingsPath(scope);
  if (!fs.existsSync(file)) return console.log(`Nothing to do: ${file} doesn't exist.`);
  const settings = readJson(file, {});
  setHooks(settings, [], '');
  if (settings.permissions?.allow) {
    settings.permissions.allow = settings.permissions.allow.filter((r) => !LORE_RULES.includes(r) && r !== PIPEFAIL_RULE && !/slimctx filter/.test(r));
    if (!settings.permissions.allow.length) delete settings.permissions.allow;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
  }
  // Rewrite rather than delete: Claude Code reloads hooks when the file changes.
  writeJson(file, settings);
  console.log(`${c.green('✓')} Removed agentlore hooks from ${c.bold(file)}. Your lessons and handoffs in .lore/ are untouched.`);
}
