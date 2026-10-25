import path from 'node:path';
import { projectLessonsPath, userLessonsPath, loreCommand, isOnPath } from './paths.js';
import { loadLessons } from './lessons/store.js';
import { isGlobal } from './lessons/scope.js';
import { listHandoffs } from './handoffs/store.js';

const MAX_GLOBAL = 15;
const MAX_HANDOFFS = 5;

export function allLessons(root) {
  return [
    ...loadLessons(userLessonsPath()).map((l) => ({ ...l, source: 'user' })),
    ...loadLessons(projectLessonsPath(root)).map((l) => ({ ...l, source: 'project' })),
  ];
}

export const lessonLine = (l) => `- ${l.rule}${l.why ? ` (${l.why})` : ''}${l.reinforced > 1 ? ` [taught ${l.reinforced}×]` : ''}`;

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?');

export const learnHint = () =>
  'When the user corrects you or states a preference that should last beyond this task, save it after handling it: ' +
  '`lore learn "<rule, as an instruction>" --scope "<file glob or bash:command, comma-separated; omit for always>" --why "<one line>"` ' +
  '(add `--user` if it applies to every project, not just this one). Skip one-off instructions.';

/**
 * What an agent sees when a session starts: standing lessons, how many
 * file-specific ones exist, and an index of recent handoffs. Kept small on
 * purpose: everything else is fetched only when needed.
 */
export function buildBrief(root) {
  const lessons = allLessons(root);
  const global = lessons.filter(isGlobal).sort((a, b) => b.reinforced - a.reinforced);
  const scoped = lessons.length - global.length;
  const handoffs = listHandoffs(root).slice(0, MAX_HANDOFFS);

  const L = [`agentlore: memory for ${path.basename(root)}, shared by Claude Code and Codex.`];
  // Spell out a non-global install once rather than in every command below.
  if (!isOnPath() && !process.env.AGENTLORE_BIN) L.push(`(\`lore\` isn't on PATH here; run it as ${loreCommand()})`);
  if (global.length) {
    L.push('', 'Lessons you have been taught here (follow them):');
    L.push(...global.slice(0, MAX_GLOBAL).map(lessonLine));
    if (global.length > MAX_GLOBAL) L.push(`- … ${global.length - MAX_GLOBAL} more: \`lore lessons\``);
  }
  if (scoped) L.push('', `${scoped} more lesson${scoped > 1 ? 's' : ''} apply to specific files or commands; each is shown when you touch them.`);
  if (handoffs.length) {
    L.push('', `Recent sessions here. If the user is continuing one, run \`lore recall <n>\` first (what was asked, where it ended, files, checks, open items) instead of re-exploring:`);
    handoffs.forEach((h, i) => {
      const bits = [day(h.end), h.title, h.agent, h.files ? `${h.files} files changed` : null, h.open ? `${h.open} open` : null];
      L.push(` ${i + 1}. ${bits.filter(Boolean).join(' · ')}`);
    });
  }
  L.push('', learnHint());
  return L.join('\n');
}
