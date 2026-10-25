import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../util/io.js';

/*
 * Lessons live in plain Markdown so people can read, edit and review them in a PR:
 *
 *   ## Use pnpm, never npm
 *   - scope: bash:npm, package.json
 *   - why: the repo is a pnpm workspace; npm writes a stray package-lock.json
 *   - learned: 2026-10-25 (claude)
 *   - reinforced: 2
 *   - id: L3f2a9c
 *
 *   Optional free-form notes.
 *
 * `scope` says when the lesson is shown: file globs relative to the project
 * root, `bash:<command prefix>`, or nothing / `*` for always.
 */

const HEADER = `# Lessons

What agents working here have been taught. agentlore shows each lesson to Claude Code and Codex
when it applies (see \`scope\`). Edit freely: one \`## \` section per lesson.
`;

const FIELD = /^- (scope|why|learned|reinforced|id):\s*(.*)$/;

export const lessonId = (rule) => 'L' + crypto.createHash('sha1').update(rule.toLowerCase().trim()).digest('hex').slice(0, 6);

export const splitScope = (scope) =>
  (Array.isArray(scope) ? scope : String(scope || '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);

export function parseLessons(text) {
  const lessons = [];
  for (const block of String(text).split(/^## /m).slice(1)) {
    const [title, ...rest] = block.split('\n');
    const lesson = { rule: title.trim(), scope: [], why: '', learned: '', reinforced: 1, id: '', notes: '' };
    const notes = [];
    for (const line of rest) {
      const m = line.match(FIELD);
      if (!m) {
        notes.push(line);
        continue;
      }
      const [, key, value] = m;
      if (key === 'scope') lesson.scope = splitScope(value);
      else if (key === 'reinforced') lesson.reinforced = Number.parseInt(value, 10) || 1;
      else lesson[key] = value.trim();
    }
    lesson.notes = notes.join('\n').trim();
    lesson.id ||= lessonId(lesson.rule);
    if (lesson.rule) lessons.push(lesson);
  }
  return lessons;
}

export function serializeLessons(lessons) {
  const blocks = lessons.map((l) => {
    const lines = [`## ${l.rule}`];
    if (l.scope.length) lines.push(`- scope: ${l.scope.join(', ')}`);
    if (l.why) lines.push(`- why: ${l.why}`);
    if (l.learned) lines.push(`- learned: ${l.learned}`);
    if (l.reinforced > 1) lines.push(`- reinforced: ${l.reinforced}`);
    lines.push(`- id: ${l.id}`);
    if (l.notes) lines.push('', l.notes);
    return lines.join('\n');
  });
  return `${HEADER}\n${blocks.join('\n\n')}\n`;
}

export function loadLessons(file) {
  try {
    return parseLessons(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

const STOP = new Set('the a an and or to of in on for with is are be use do dont not never always when you your it this that from by as at'.split(' '));
const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9.+#/-]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w)));

export function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/**
 * Add a lesson, or reinforce the existing one it duplicates. Being taught the
 * same thing twice is a signal worth keeping: it means the memory failed once.
 */
export function learn(file, { rule, scope, why = '', agent = '' }) {
  rule = String(rule || '').trim().replace(/\s+/g, ' ');
  if (!rule) throw new Error('A lesson needs a rule, e.g. lore learn "Use pnpm, never npm"');
  const lessons = loadLessons(file);
  const scopes = splitScope(scope);
  const today = new Date().toISOString().slice(0, 10);
  const existing = lessons.find((l) => l.id === lessonId(rule) || similarity(l.rule, rule) >= 0.6);
  if (existing) {
    existing.reinforced++;
    existing.scope = [...new Set([...existing.scope, ...scopes])];
    if (why && !existing.why) existing.why = why;
    writeFileAtomic(file, serializeLessons(lessons));
    return { lesson: existing, action: 'reinforced' };
  }
  const lesson = { rule, scope: scopes, why, learned: `${today}${agent ? ` (${agent})` : ''}`, reinforced: 1, id: lessonId(rule), notes: '' };
  lessons.push(lesson);
  writeFileAtomic(file, serializeLessons(lessons));
  return { lesson, action: 'added' };
}

export function forget(file, idOrText) {
  const lessons = loadLessons(file);
  const keep = lessons.filter((l) => l.id !== idOrText && l.rule !== idOrText);
  if (keep.length === lessons.length) return false;
  writeFileAtomic(file, serializeLessons(keep));
  return true;
}
