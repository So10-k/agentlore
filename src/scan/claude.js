import { estimateTokens, imageTokens } from '../util/tokens.js';
import { newSession, jsonLines, touch } from './session.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function kindOf(name) {
  if (name === 'Bash') return 'shell';
  if (name === 'Read') return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  return 'other';
}

function resultContent(content) {
  if (typeof content === 'string') return { text: content, images: 0, imageCost: 0 };
  let text = '';
  let images = 0;
  let imageCost = 0;
  for (const block of content || []) {
    if (block.type === 'text') text += (text ? '\n' : '') + block.text;
    else if (block.type === 'image') {
      images++;
      imageCost += imageTokens(block.source?.data);
    }
  }
  return { text, images, imageCost };
}

/**
 * Parse one Claude Code transcript (~/.claude/projects/<project>/<session>.jsonl).
 * `seen` dedupes message and tool ids across files: resumed sessions copy their
 * history into a new file, and we only want to count it once.
 */
export async function parseClaude(file, seen) {
  const s = newSession('claude', file);
  const open = new Map();
  for await (const d of jsonLines(file)) {
    if (d.type !== 'assistant' && d.type !== 'user' && d.type !== 'system') continue;
    s.project ??= d.cwd || null;
    touch(s, d.timestamp);

    if (d.type === 'system') {
      if (d.subtype === 'compact_boundary') s.compactions.push({ at: s.calls.length, seq: s.seq++ });
      continue;
    }
    const m = d.message;
    if (!m) continue;

    if (d.type === 'assistant') {
      const id = m.id || d.requestId;
      const u = m.usage;
      if (u && id && !seen.has(id)) {
        seen.add(id);
        const call = {
          input: u.input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreate: u.cache_creation_input_tokens || 0,
          output: u.output_tokens || 0,
        };
        if (call.input + call.cacheRead + call.cacheCreate + call.output > 0) s.calls.push(call);
      }
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (block.type === 'text' && block.text) s.mentions.push({ seq: s.seq++, text: block.text });
        else if (block.type === 'thinking' && block.thinking) s.mentions.push({ seq: s.seq++, text: block.thinking });
        else if (block.type === 'tool_use' && !seen.has(block.id)) {
          seen.add(block.id);
          const input = block.input || {};
          const tool = {
            name: block.name,
            kind: kindOf(block.name),
            command: typeof input.command === 'string' ? input.command : undefined,
            file: input.file_path || input.notebook_path,
            range: `${input.offset ?? ''}:${input.limit ?? ''}`,
            label: JSON.stringify(input).slice(0, 120),
            text: '',
            tokens: 0,
            images: 0,
            isError: false,
            at: s.calls.length,
            seq: s.seq++,
          };
          open.set(block.id, tool);
          s.tools.push(tool);
          // Re-reading a file isn't evidence the first read was used.
          if (tool.kind !== 'read') s.mentions.push({ seq: tool.seq, text: JSON.stringify(input) });
        }
      }
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type !== 'tool_result') continue;
        const tool = open.get(block.tool_use_id);
        if (!tool) continue;
        open.delete(block.tool_use_id);
        const { text, images, imageCost } = resultContent(block.content);
        Object.assign(tool, {
          text,
          images,
          tokens: estimateTokens(text) + imageCost,
          isError: !!block.is_error,
          at: s.calls.length,
          seq: s.seq++,
        });
      }
    }
  }
  return s;
}
