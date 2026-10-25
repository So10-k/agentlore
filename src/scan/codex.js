import { estimateTokens, imageTokens } from '../util/tokens.js';
import { newSession, jsonLines, touch } from './session.js';

const SHELL_TOOLS = new Set(['shell', 'shell_command', 'exec', 'exec_command', 'local_shell', 'container.exec', 'unified_exec']);

function parseArgs(raw) {
  if (typeof raw !== 'string') return raw || {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

// Codex shell calls come in a few shapes: {command: [argv]}, {cmd: "..."}, or a
// JS snippet calling tools.exec_command({"cmd": "..."}).
function commandOf(args) {
  if (Array.isArray(args.command)) {
    const argv = args.command;
    return argv[0]?.endsWith('sh') && argv[1] === '-lc' ? argv.slice(2).join(' ') : argv.join(' ');
  }
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  const src = args.raw || args.code || args.input || '';
  const cmds = [...String(src).matchAll(/"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  });
  return cmds.length ? cmds.join(' ; ') : null; // JS that never ran a shell command
}

function outputContent(output) {
  if (typeof output === 'string') {
    // Older Codex wraps output as JSON: {"output": "...", "metadata": {...}}
    try {
      const j = JSON.parse(output);
      if (typeof j?.output === 'string') return { text: j.output, images: 0, imageCost: 0 };
    } catch {}
    return { text: output, images: 0, imageCost: 0 };
  }
  let text = '';
  let images = 0;
  let imageCost = 0;
  for (const block of Array.isArray(output) ? output : output?.content || []) {
    if (typeof block.text === 'string') text += (text ? '\n' : '') + block.text;
    else if (block.type?.includes('image')) {
      images++;
      imageCost += imageTokens(String(block.image_url || '').split(',')[1]);
    }
  }
  return { text, images, imageCost };
}

/** Parse one Codex rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). */
export async function parseCodex(file, seen) {
  const s = newSession('codex', file);
  const open = new Map();
  let lastTotal = -1;
  for await (const d of jsonLines(file)) {
    const p = d.payload || {};
    touch(s, d.timestamp);
    if (d.type === 'session_meta' || d.type === 'turn_context') {
      s.project ??= p.cwd || null;
      continue;
    }
    if (d.type === 'compacted') {
      s.compactions.push({ at: s.calls.length, seq: s.seq++ });
      continue;
    }
    if (d.type === 'event_msg' && p.type === 'token_count') {
      const total = p.info?.total_token_usage?.total_tokens;
      const u = p.info?.last_token_usage;
      if (!u || total === lastTotal) continue; // the same count is re-emitted
      lastTotal = total;
      const cached = u.cached_input_tokens || 0;
      s.calls.push({
        input: Math.max(0, (u.input_tokens || 0) - cached),
        cacheRead: cached,
        cacheCreate: u.cache_write_input_tokens || 0,
        output: u.output_tokens || 0,
      });
      continue;
    }
    if (d.type !== 'response_item') continue;

    if (p.type === 'message' && p.role === 'assistant') {
      for (const block of p.content || []) if (block.text) s.mentions.push({ seq: s.seq++, text: block.text });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const id = p.call_id || p.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const args = p.type === 'custom_tool_call' ? { raw: p.input } : parseArgs(p.arguments ?? p.action);
      const name = p.name || 'shell';
      const command = SHELL_TOOLS.has(name) || p.type === 'local_shell_call' ? commandOf(args) : null;
      const tool = {
        name: command ? 'shell' : name,
        kind: command ? 'shell' : name === 'apply_patch' ? 'edit' : 'other',
        command: command ?? undefined,
        label: command ? undefined : String(args.raw ?? p.arguments ?? '').slice(0, 120),
        text: '',
        tokens: 0,
        images: 0,
        isError: false,
        at: s.calls.length,
        seq: s.seq++,
      };
      open.set(id, tool);
      s.tools.push(tool);
      s.mentions.push({ seq: tool.seq, text: typeof p.arguments === 'string' ? p.arguments : String(p.input || '') });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') {
      const tool = open.get(p.call_id);
      if (!tool) continue;
      open.delete(p.call_id);
      const { text, images, imageCost } = outputContent(p.output);
      Object.assign(tool, { text, images, tokens: estimateTokens(text) + imageCost, at: s.calls.length, seq: s.seq++ });
    }
  }
  return s;
}
