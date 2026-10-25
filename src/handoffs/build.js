import path from 'node:path';
import { relative } from '../paths.js';
import { redact } from '../util/redact.js';
import { human } from '../util/term.js';
import { commandKey } from '../scan/analyze.js';
import { isNoisyCommand } from '../compress/filters.js';
import { detectCorrection } from '../lessons/corrections.js';

/*
 * A handoff is what the next session needs to pick up the work without the
 * last 400K tokens: what was asked (verbatim), where the agent left it, what
 * changed, what was verified, and what's still open. Everything except the
 * agent's own words is pulled from the transcript deterministically, so it's
 * accurate even when the session ended abruptly.
 */
// A "check" is a real test/build/lint run, not any command that mentions "test".
const isCheck = (cmd) => cmd.length < 300 && (isNoisyCommand(cmd) || /\b(ruff|mypy|pyright|rubocop|phpunit|rspec|dotnet test)\b/.test(cmd)) && !/\b(install|add|ci)\b/.test(commandKey(cmd));
const MAX_PROMPTS = 12;

const oneLine = (s, n) => {
  const t = redact(String(s).replace(/\s*\n\s*/g, ' ⏎ ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const clip = (s, n) => {
  const t = redact(String(s).trim());
  return t.length > n ? `${t.slice(0, n)}\n\n… (${t.length - n} more characters in the transcript)` : t;
};
const when = (iso) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '?';

export function handoffMeta(s, root) {
  const files = new Map();
  let outside = 0;
  for (const t of s.tools) {
    for (const f of t.files) {
      const rel = relative(root, f);
      if (path.isAbsolute(rel)) outside++;
      else files.set(rel, (files.get(rel) || 0) + 1);
    }
  }
  const checks = new Map();
  for (const t of s.tools) {
    if (!t.command || !isCheck(t.command)) continue;
    checks.set(commandKey(t.command), { command: t.command, ok: !t.isError });
  }
  const seen = new Set();
  const prompts = s.prompts.filter((p) => !seen.has(p.text) && seen.add(p.text));
  const open = s.todos.filter((t) => t.status !== 'completed' && t.text);
  const title = s.title || oneLine(prompts[0]?.text.split('\n')[0] || 'Untitled session', 70);
  return { title, files, outside, checks, prompts, open };
}

export function buildHandoff(s, { root, trigger = 'manual' } = {}) {
  const { title, files, outside, checks, prompts, open } = handoffMeta(s, root);
  if (!prompts.length && !files.size) return null;

  const meta = {
    sid: s.sessionId,
    agent: s.agent,
    title,
    start: s.start,
    end: s.end,
    files: files.size,
    open: open.length,
    trigger,
  };
  const L = [`<!-- lore ${JSON.stringify(meta)} -->`, `# ${title.replace(/^#+\s*/, '')}`, ''];
  L.push(`- **When:** ${when(s.start)} → ${when(s.end)} · ${s.agent} · session ${String(s.sessionId || '?').slice(0, 8)}`);
  const peak = Math.max(0, ...s.contexts);
  L.push(`- **Size:** ${s.contexts.length} requests · peak context ${human(peak)}${s.branch ? ` · branch \`${s.branch}\`` : ''}`);
  L.push(`- **Saved on:** ${trigger}`);

  L.push('', '## What the user asked');
  const shown = prompts.length > MAX_PROMPTS ? [...prompts.slice(0, 3), null, ...prompts.slice(-(MAX_PROMPTS - 3))] : prompts;
  let n = 0;
  for (const p of shown) {
    if (!p) {
      L.push(`   … ${prompts.length - MAX_PROMPTS} more`);
      n = prompts.length - (MAX_PROMPTS - 3);
      continue;
    }
    n++;
    const flag = detectCorrection(p.text).matched ? '⚑ ' : '';
    L.push(`${n}. ${flag}${oneLine(p.text, 400)}`);
  }

  if (s.finalMessage) L.push('', '## Where it ended', '', clip(s.finalMessage, 1800));
  if (s.summaries.length) L.push('', '## Summary (written by the agent at compaction)', '', clip(s.summaries.at(-1), 3000));

  if (files.size) {
    L.push('', '## Files changed');
    const sorted = [...files].sort((a, b) => b[1] - a[1]);
    for (const [f, count] of sorted.slice(0, 30)) L.push(`- ${f}${count > 1 ? ` ×${count}` : ''}`);
    if (sorted.length > 30) L.push(`- … ${sorted.length - 30} more`);
  }
  if (outside) L.push(`- (+ ${outside} edit${outside > 1 ? 's' : ''} to files outside the project)`);
  if (checks.size) {
    L.push('', '## Checks (last run of each)');
    for (const { command, ok } of checks.values()) L.push(`- ${ok ? '✓' : '✗'} \`${oneLine(command, 120)}\``);
  }
  if (open.length) {
    L.push('', '## Still open');
    for (const t of open) L.push(`- [ ] ${oneLine(t.text, 160)}${t.status === 'in_progress' ? ' (in progress)' : ''}`);
  }
  return { meta, markdown: L.join('\n') + '\n' };
}
