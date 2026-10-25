import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DIRS } from './scan/index.js';
import { walkJsonl } from './scan/session.js';
import { readTranscript } from './transcript.js';
import { detectCorrection, isContinuation } from './lessons/corrections.js';
import { similarity } from './lessons/store.js';
import { isInspectCommand } from './compress/filters.js';
import { loadConfig, readEvents } from './state.js';
import { redact } from './util/redact.js';
import { c, human, pct, padEnd, padStart, median, truncate } from './util/term.js';

/*
 * The scoreboard: is the agent getting better here? Measured from transcripts,
 * before and after agentlore was installed:
 *
 *   context per request      how much each message re-sends (long sessions)
 *   re-exploration           file reads/searches in a session's first 20 tool calls:
 *                            the cost of the agent re-learning what it knew yesterday
 *   corrections              user messages that correct the agent
 *   repeated corrections     the same correction in a later session: memory failures
 *   re-explaining            sessions whose first message is "continue X, read the handoff…"
 */
const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const FIRST_TOOLS = 20;

const isExploration = (t) => EXPLORE_TOOLS.has(t.name) || (t.command && isInspectCommand(t.command));

function sessionStats(s) {
  const corrections = s.prompts.filter((p) => detectCorrection(p.text).correction).map((p) => p.text);
  const explore = s.tools.slice(0, FIRST_TOOLS).filter(isExploration).reduce((n, t) => n + Math.ceil((t.outputChars || 0) / 4), 0);
  return {
    agent: s.agent,
    project: s.cwd || '(unknown)',
    start: s.start,
    requests: s.contexts.length,
    context: s.contexts.reduce((a, b) => a + b, 0),
    over200: s.contexts.filter((x) => x > 200_000).length,
    peak: Math.max(0, ...s.contexts),
    explore,
    prompts: s.prompts.length,
    continuation: isContinuation(s.prompts[0]?.text),
    corrections,
  };
}

export async function score({ days = 30, project, claudeDir, codexDir, onProgress } = {}) {
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const files = [
    ...[...walkJsonl(claudeDir || DEFAULT_DIRS.claude)].filter((f) => !f.includes('/subagents/')),
    ...walkJsonl(codexDir || DEFAULT_DIRS.codex),
  ].filter((f) => !cutoff || fs.statSync(f).mtimeMs >= cutoff);

  const sessions = [];
  let i = 0;
  for (const file of files) {
    onProgress?.(++i, files.length);
    const s = await readTranscript(file);
    if (!s.contexts.length || !s.prompts.length) continue;
    if (project && !(s.cwd || '').toLowerCase().includes(project.toLowerCase())) continue;
    sessions.push(sessionStats(s));
  }
  sessions.sort((a, b) => String(a.start).localeCompare(String(b.start)));

  // A correction that resembles one from an earlier session in the same project.
  const repeats = [];
  const past = new Map();
  for (const s of sessions) {
    const earlier = past.get(s.project) || [];
    for (const text of s.corrections) {
      const short = text.slice(0, 300);
      const hit = earlier.find((e) => e.session !== s && similarity(e.text, short) >= 0.4);
      if (hit) repeats.push({ text: short, earlier: hit.text, start: s.start, project: s.project });
    }
    past.set(s.project, [...earlier, ...s.corrections.map((t) => ({ text: t.slice(0, 300), session: s }))]);
  }

  const installedAt = loadConfig().installedAt || null;
  const split = (pred) => sessions.filter(pred);
  const before = installedAt ? split((s) => s.start < installedAt) : sessions;
  const after = installedAt ? split((s) => s.start >= installedAt) : [];
  const since = installedAt ? Date.parse(installedAt) : Infinity;
  const events = readEvents().filter((e) => e.ts >= since && (!cutoff || e.ts >= cutoff));

  return { days, installedAt, sessions, before: summarize(before, repeats), after: summarize(after, repeats), repeats, events };
}

function summarize(list, repeats) {
  if (!list.length) return null;
  const requests = list.reduce((n, s) => n + s.requests, 0);
  const starts = new Set(list.map((s) => s.start));
  const corrections = list.reduce((n, s) => n + s.corrections.length, 0);
  return {
    sessions: list.length,
    claude: list.filter((s) => s.agent === 'claude').length,
    codex: list.filter((s) => s.agent === 'codex').length,
    perRequest: list.reduce((n, s) => n + s.context, 0) / Math.max(1, requests),
    over200: pct(list.reduce((n, s) => n + s.over200, 0), requests),
    peak: median(list.map((s) => s.peak)),
    explore: median(list.map((s) => s.explore)),
    corrections: corrections / list.length,
    continuations: pct(list.filter((s) => s.continuation).length, list.length),
    correctionsTotal: corrections,
    repeats: repeats.filter((r) => starts.has(r.start)).length,
  };
}

export function renderScore(r) {
  if (!r.sessions.length) return '\n No sessions with messages found.\n';
  const L = [];
  const cols = r.after ? ['before', 'since install'] : ['baseline'];
  const scope = `${r.days ? `last ${r.days} days` : 'all time'} · ${r.sessions.length} sessions`;
  L.push(`\n ${c.bold('agentlore score')} ${c.dim(`· ${scope}`)}`);
  if (!r.installedAt) L.push(c.dim(' Not installed yet: this is your baseline. Run `lore install`, then compare in a week or two.'));
  L.push('', ` ${padEnd('', 40)}${cols.map((h) => padStart(c.dim(h), 16)).join('')}`);

  const row = (label, f, note = '') => {
    const cells = [r.before, r.after].slice(0, cols.length).map((x) => padStart(x ? f(x) : '—', 16));
    L.push(` ${padEnd(label, 40)}${cells.join('')}${note ? '  ' + c.dim(note) : ''}`);
  };
  row('Sessions (Claude Code / Codex)', (x) => `${x.claude} / ${x.codex}`);
  row('Context re-sent per request', (x) => human(x.perRequest), 'lower = fresher sessions');
  row('Requests over 200K context', (x) => `${x.over200}%`);
  row('Peak context per session (median)', (x) => human(x.peak));
  row('Re-exploration at session start', (x) => `${human(x.explore)} tok`, 'reads/searches in first 20 tool calls');
  row('Sessions opened by re-explaining', (x) => `${x.continuations}%`, '"continue…", pasted handoffs');
  row('Corrections per session', (x) => x.corrections.toFixed(2));
  row('Instructions you had to repeat', (x) => String(x.repeats), 'same correction/rule, later session');

  const count = (type) => r.events.filter((e) => e.type === type).length;
  if (r.installedAt) {
    L.push('', ` ${c.bold('What agentlore did')} ${c.dim(`since ${r.installedAt.slice(0, 10)}`)}`);
    L.push(`   ${count('learn')} lessons learned · ${count('inject')} times shown · ${count('handoff')} handoffs saved · ${count('recall')} recalled · ${count('nudge')} long-session nudges`);
  }

  const recent = r.repeats.slice(-5).reverse();
  if (recent.length) {
    L.push('', ` ${c.bold('Things you told agents more than once')} ${c.dim('(each one should be a lesson)')}`);
    for (const x of recent) L.push(`   ${c.dim(String(x.start).slice(0, 10))}  "${truncate(redact(x.text), 64)}"  ${c.dim(path.basename(x.project))}`);
    L.push(c.dim('   Turn one into a lesson: lore learn "<rule>" --scope "<glob>" --why "<reason>"'));
  }
  L.push(c.dim('\n Corrections are detected heuristically; context sizes come straight from the transcripts.\n'));
  return L.join('\n');
}
