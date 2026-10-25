import { projectRoot, loreCommand } from './paths.js';
import { readStdin } from './util/io.js';
import { human } from './util/term.js';
import { isCodexTranscript } from './transcript.js';
import { buildBrief, allLessons, lessonLine } from './brief.js';
import path from 'node:path';
import { appliesTo, canonical } from './lessons/scope.js';
import { detectCorrection } from './lessons/corrections.js';
import { saveHandoff } from './handoffs/store.js';
import { compressPre, compressPost } from './compress/hook.js';
import { loadConfig, loadSession, saveSession, logEvent, logError, currentContext } from './state.js';

/*
 * `lore hook`: one entry point for every Claude Code and Codex hook event.
 * It must never get in the agent's way: any error is logged and swallowed.
 *
 *   SessionStart       → the brief: standing lessons + recent handoffs
 *   UserPromptSubmit   → after a correction, ask the agent to save a lesson;
 *                        in a huge session, tell the user starting fresh is cheap
 *   PreToolUse         → lessons scoped to the file/command about to be touched
 *                        (+ Claude Code: pipe noisy commands through the compressor)
 *   PostToolUse        → Claude Code: compress noisy Bash output
 *   PreCompact, PostCompact, SessionEnd → save the handoff
 */
export async function runHook() {
  let out = null;
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    const ctx = {
      input,
      agent: isCodexTranscript(input.transcript_path) ? 'codex' : 'claude',
      root: projectRoot(input.cwd || process.cwd()),
      config: loadConfig(),
    };
    const handler = HANDLERS[input.hook_event_name];
    if (handler) out = await handler(ctx);
  } catch (err) {
    logError(err);
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

const context = (event, text, extra = {}) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text, ...extra } });

const HANDLERS = {
  SessionStart({ input, root }) {
    if (input.source === 'resume') return null; // the brief is already in the resumed conversation
    const state = loadSession(input.session_id);
    state.injected = []; // a fresh or compacted context has forgotten them
    saveSession(input.session_id, state);
    return context('SessionStart', buildBrief(root));
  },

  UserPromptSubmit({ input, agent, config }) {
    const out = {};
    if (detectCorrection(input.prompt).matched) {
      logEvent('correction', { agent });
      out.hookSpecificOutput = {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          `agentlore: this message may be a correction or a lasting preference. Handle it first; then, if it should apply in future sessions too, save it with \`${loreCommand()} learn "<rule>" --scope "<glob or bash:cmd>" --why "<reason>"\` (\`--user\` for every project). If it was a one-off, ignore this.`,
      };
    }
    const size = currentContext(input.transcript_path);
    const state = loadSession(input.session_id);
    if (config.nudgeAt && size >= config.nudgeAt && size >= state.nudgedAt + 100_000) {
      state.nudgedAt = size;
      saveSession(input.session_id, state);
      logEvent('nudge', { agent, size });
      const fresh = agent === 'codex' ? 'start a new chat' : '/clear';
      out.systemMessage = `lore: this conversation is ${human(size)} tokens, and every message re-sends all of it. If you're switching tasks, ${fresh}: the handoff is saved and the next session can pick it up with \`lore recall\`.`;
    }
    return Object.keys(out).length ? out : null;
  },

  PreToolUse({ input, root, agent, config }) {
    const ti = input.tool_input || {};
    const target = targetOf(input.tool_name, ti);
    let note = null;
    if (target.files.length || target.command) {
      const state = loadSession(input.session_id);
      const fresh = allLessons(root).filter((l) => !state.injected.includes(l.id) && appliesTo(l, target, root));
      if (fresh.length) {
        state.injected.push(...fresh.map((l) => l.id));
        saveSession(input.session_id, state);
        logEvent('inject', { agent, lessons: fresh.map((l) => l.id) });
        const what = target.files[0] ? target.files.map((f) => (path.isAbsolute(f) ? path.relative(canonical(root), canonical(f)) : f)).join(', ') : `\`${target.command.slice(0, 60)}\``;
        note = `agentlore: lessons for ${what}:\n${fresh.slice(0, 6).map(lessonLine).join('\n')}`;
      }
    }
    // Codex only accepts updatedInput together with "allow", which we never grant.
    const rewritten = agent === 'claude' && config.compress && input.tool_name === 'Bash' ? compressPre(ti) : null;
    if (!note && !rewritten) return null;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        ...(note && { additionalContext: note }),
        ...(rewritten && { updatedInput: rewritten }),
      },
    };
  },

  PostToolUse({ input, agent, config }) {
    if (agent !== 'claude' || !config.compress || input.tool_name !== 'Bash') return null;
    const replaced = compressPost(input.tool_input, input.tool_response);
    return replaced ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: replaced } } : null;
  },

  PreCompact: (ctx) => save(ctx, `compaction (${ctx.input.trigger || 'auto'})`),
  PostCompact: (ctx) => save(ctx, `compaction (${ctx.input.trigger || 'auto'})`),
  SessionEnd: (ctx) => save(ctx, ctx.input.reason && ctx.input.reason !== 'other' ? ctx.input.reason : 'session end'),
};

async function save({ input, root, agent }, trigger) {
  if (!input.transcript_path) return null;
  const saved = await saveHandoff(input.transcript_path, { root, trigger });
  if (saved) logEvent('handoff', { agent, file: saved.file });
  return null;
}

// What a tool call is about to touch, for both agents' tool names.
export function targetOf(tool, ti) {
  const files = [];
  let command = '';
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) files.push(ti.file_path || ti.notebook_path);
  if (typeof ti.command === 'string') command = ti.command;
  else if (Array.isArray(ti.command)) command = ti.command.at(-1);
  else if (typeof ti.cmd === 'string') command = ti.cmd;
  const raw = typeof ti === 'string' ? ti : JSON.stringify(ti);
  for (const m of raw.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/g)) files.push(m[1].trim());
  if (tool === 'apply_patch' || /\*\*\* Begin Patch/.test(raw)) command = '';
  return { files: files.filter(Boolean), command: command || '' };
}
