import { jsonLines } from './scan/session.js';

/*
 * One shape for a Claude Code or Codex session, for handoffs and the scoreboard:
 *
 *   agent, sessionId, cwd, title, branch, start, end
 *   prompts        what the user typed, in order: { text, ts }
 *   finalMessage   the agent's last message (where it says what it did)
 *   summaries      compaction summaries written by the agent itself
 *   tools          { name, input, command?, files[], isError, output }
 *   todos          the latest task list: { text, status }
 *   contexts       context size of each model request, in tokens
 */
function emptySession(agent, file) {
  return {
    agent,
    file,
    sessionId: null,
    cwd: null,
    title: null,
    branch: null,
    start: null,
    end: null,
    prompts: [],
    finalMessage: '',
    summaries: [],
    tools: [],
    todos: [],
    contexts: [],
  };
}

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NOT_A_PROMPT = /^\s*(<command-(name|message|args)>|<local-command-|<bash-(input|stdout|stderr)>|Caveat: The messages below|\[Request interrupted|<task-notification>|<side-sessions-event>|<ci-monitor-event>|\[SYSTEM NOTIFICATION)/;

export function cleanPrompt(text) {
  if (typeof text !== 'string' || NOT_A_PROMPT.test(text)) return '';
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content || [])
        .filter((b) => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text'))
        .map((b) => b.text)
        .join('\n');

// Task lists: TodoWrite, the desktop app's update_plan (incremental), Codex update_plan.
function applyPlan(s, name, input) {
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    s.todos = input.todos.map((t) => ({ text: t.content || t.activeForm || '', status: t.status }));
  } else if (/update_plan$/.test(name)) {
    if (Array.isArray(input.items)) s.todos = input.items.map((t) => ({ text: t.content, status: t.status }));
    else if (Array.isArray(input.plan)) s.todos = input.plan.map((t) => ({ text: t.step, status: t.status }));
    else if (input.advance) {
      const i = s.todos.findIndex((t) => t.status === 'in_progress');
      if (i !== -1) s.todos[i].status = 'completed';
      const next = s.todos.find((t) => t.status === 'pending');
      if (next) next.status = 'in_progress';
    } else {
      for (const n of input.done || []) if (s.todos[n - 1]) s.todos[n - 1].status = 'completed';
      if (input.start && s.todos[input.start - 1]) s.todos[input.start - 1].status = 'in_progress';
    }
  }
}

const patchFiles = (patch) => [...String(patch).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());

async function readClaude(file) {
  const s = emptySession('claude', file);
  const open = new Map();
  const seen = new Set();
  for await (const d of jsonLines(file)) {
    if (d.sessionId) s.sessionId ??= d.sessionId;
    if (d.cwd) s.cwd ??= d.cwd;
    if (d.gitBranch && d.gitBranch !== 'HEAD') s.branch = d.gitBranch;
    if (d.timestamp && d.type !== 'queue-operation') {
      s.start ??= d.timestamp;
      s.end = d.timestamp;
    }
    if (d.type === 'custom-title' && d.customTitle) s.title = d.customTitle;
    if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && d.attachment.origin?.kind === 'human') {
      const text = cleanPrompt(d.attachment.prompt);
      if (text) s.prompts.push({ text, ts: d.timestamp });
    }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const m = d.message;
    if (!m) continue;

    if (d.type === 'user') {
      if (d.isCompactSummary) {
        s.summaries.push(textOf(m.content));
        continue;
      }
      if (typeof m.content === 'string' || m.content?.some?.((b) => b.type === 'text')) {
        if (!d.isMeta) {
          const text = cleanPrompt(textOf(m.content));
          if (text) s.prompts.push({ text, ts: d.timestamp });
        }
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'tool_result') continue;
        const tool = open.get(b.tool_use_id);
        if (!tool) continue;
        const out = textOf(b.content);
        tool.isError = !!b.is_error;
        tool.output = out.slice(0, 2000);
        tool.outputChars = out.length;
      }
      continue;
    }

    const u = m.usage;
    if (u && m.id && !seen.has(m.id)) {
      seen.add(m.id);
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx) s.contexts.push(ctx);
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'text' && b.text?.trim()) s.finalMessage = b.text;
      if (b.type !== 'tool_use') continue;
      const input = b.input || {};
      const tool = {
        name: b.name,
        input,
        command: b.name === 'Bash' ? input.command : undefined,
        files: EDITS.has(b.name) ? [input.file_path || input.notebook_path].filter(Boolean) : [],
        isError: false,
        output: '',
        outputChars: 0,
      };
      open.set(b.id, tool);
      s.tools.push(tool);
      applyPlan(s, b.name, input);
    }
  }
  return s;
}

async function readCodex(file) {
  const s = emptySession('codex', file);
  const open = new Map();
  let lastTotal = -1;
  for await (const d of jsonLines(file)) {
    const p = d.payload || {};
    if (d.timestamp) {
      s.start ??= d.timestamp;
      s.end = d.timestamp;
    }
    if (d.type === 'session_meta') {
      s.sessionId ??= p.id || p.session_id;
      s.cwd ??= p.cwd;
      if (p.git?.branch) s.branch = p.git.branch;
    } else if (d.type === 'turn_context') {
      s.cwd ??= p.cwd;
    } else if (d.type === 'event_msg') {
      if (p.type === 'user_message') {
        const text = cleanPrompt(p.message);
        if (text && !/^\s*# Files mentioned by the user:\s*$/.test(text)) s.prompts.push({ text, ts: d.timestamp });
      } else if (p.type === 'task_complete' && p.last_agent_message) {
        s.finalMessage = p.last_agent_message;
      } else if (p.type === 'agent_message' && p.message && p.phase !== 'commentary') {
        s.finalMessage = p.message;
      } else if (p.type === 'token_count') {
        const total = p.info?.total_token_usage?.total_tokens;
        const ctx = p.info?.last_token_usage?.input_tokens;
        if (ctx && total !== lastTotal) s.contexts.push(ctx);
        lastTotal = total;
      }
    } else if (d.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        let input = p.input ?? p.arguments ?? p.action ?? {};
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            input = { raw: input };
          }
        }
        const raw = typeof input.raw === 'string' ? input.raw : '';
        const cmd = typeof input.cmd === 'string' ? input.cmd : Array.isArray(input.command) ? input.command.slice(-1)[0] : input.command;
        const tool = {
          name: p.name || 'shell',
          input,
          command: typeof cmd === 'string' ? cmd : undefined,
          files: patchFiles(raw || JSON.stringify(input)),
          isError: false,
          output: '',
          outputChars: 0,
        };
        open.set(p.call_id || p.id, tool);
        s.tools.push(tool);
        applyPlan(s, tool.name, input);
      } else if (p.type?.endsWith('_output')) {
        const tool = open.get(p.call_id);
        if (!tool) continue;
        const out = typeof p.output === 'string' ? p.output : textOf(p.output);
        tool.output = out.slice(0, 2000);
        tool.outputChars = out.length;
        tool.isError = /exit code:? [1-9]|Process exited with code [1-9]/i.test(out.slice(0, 300));
      }
    }
  }
  return s;
}

export const isCodexTranscript = (file) => /[\\/]\.codex[\\/]|rollout-/.test(file || '');

export function readTranscript(file) {
  return isCodexTranscript(file) ? readCodex(file) : readClaude(file);
}
