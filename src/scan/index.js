import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens } from '../util/tokens.js';
import { walkJsonl } from './session.js';
import { parseClaude } from './claude.js';
import { parseCodex } from './codex.js';
import { createAggregate, addSession, finalize } from './analyze.js';

export const DEFAULT_DIRS = {
  claude: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'),
  codex: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
};

export async function scan({ days = 30, project, agent = 'all', claudeDir, codexDir, topN = 10, onProgress } = {}) {
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const files = [];
  if (agent !== 'codex') for (const f of walkJsonl(claudeDir || DEFAULT_DIRS.claude)) files.push(['claude', f]);
  if (agent !== 'claude') for (const f of walkJsonl(codexDir || DEFAULT_DIRS.codex)) files.push(['codex', f]);

  const recent = files.filter(([, f]) => !cutoff || fs.statSync(f).mtimeMs >= cutoff);
  const agg = createAggregate();
  const seen = new Set();
  let done = 0;
  for (const [kind, file] of recent) {
    onProgress?.(++done, recent.length);
    const s = kind === 'claude' ? await parseClaude(file, seen) : await parseCodex(file, seen);
    if (!s.calls.length && !s.tools.length) continue;
    if (project && !(s.project || '').toLowerCase().includes(project.toLowerCase())) continue;
    addSession(agg, s, { topN });
  }
  finalize(agg, { topN });
  agg.days = days;
  agg.instructions = instructionFiles(agg);
  return agg;
}

// Always-loaded instruction files for the busiest projects: these ride along
// in every single request.
function instructionFiles(agg) {
  const projects = [...agg.projects]
    .filter(([p]) => p.startsWith('/') && !p.includes('/worktrees/'))
    .sort((a, b) => b[1].context - a[1].context)
    .slice(0, 8)
    .map(([p]) => p);
  const candidates = [
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    path.join(os.homedir(), '.codex', 'AGENTS.md'),
    ...projects.flatMap((p) => ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md'].map((n) => path.join(p, n))),
  ];
  const out = [];
  for (const file of new Set(candidates)) {
    try {
      const tokens = estimateTokens(fs.readFileSync(file, 'utf8'));
      if (tokens) out.push({ file, tokens });
    } catch {}
  }
  return out.sort((a, b) => b.tokens - a.tokens);
}
