import { estimateTokens } from '../util/tokens.js';
import { normalize, dedupe, collapseSimilar, squeezeBlank, smartTruncate } from './generic.js';
import { pickFilters, isInspectCommand } from './filters.js';

const envInt = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const DEFAULTS = {
  minTokens: 250, // leave small outputs alone: nothing to gain, something to lose
  maxTokens: envInt('AGENTLORE_MAX_TOKENS', 2500),
  minSavedRatio: 0.15,
  minSavedTokens: 100,
};

/**
 * Compress one command's output. Returns the original text untouched unless
 * the result is meaningfully smaller. `saveLog(raw)` is called only when we do
 * compress, and its return value (a path) goes in the footer so the agent can
 * read the full output if it needs to.
 */
export function compress(raw, { command = '', saveLog, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const before = estimateTokens(raw);
  const unchanged = { text: raw, changed: false, before, after: before, filter: null };
  if (before < o.minTokens || isInspectCommand(command)) return unchanged;

  let lines = normalize(raw);
  const filters = pickFilters(command, lines);
  if (filters.length) {
    for (const f of filters) lines = f.apply(lines);
    lines = smartTruncate(squeezeBlank(collapseSimilar(dedupe(lines))), o.maxTokens);
  } else {
    // Unknown command: only the lossless-ish cleanups (colors, progress bars,
    // repeated lines). We don't know what in it matters.
    lines = squeezeBlank(dedupe(lines));
  }

  const body = lines.join('\n');
  const name = filters.map((f) => f.name).join('+') || 'generic';
  const estimate = estimateTokens(body) + 30;
  if (before - estimate < Math.max(o.minSavedTokens, before * o.minSavedRatio)) return unchanged;

  const logPath = saveLog?.(raw);
  const footer = `[lore: ${before.toLocaleString('en-US')} → ${estimate.toLocaleString('en-US')} tokens (${name})${
    logPath ? `. Full output: ${logPath}` : ''
  }]`;
  const text = `${body}\n${footer}\n`;
  return { text, changed: true, before, after: estimateTokens(text), filter: name };
}
