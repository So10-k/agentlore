import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { learn, forget, loadLessons, parseLessons, serializeLessons } from '../src/lessons/store.js';
import { appliesTo, globToRegExp, isGlobal } from '../src/lessons/scope.js';
import { detectCorrection, isContinuation } from '../src/lessons/corrections.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-lessons-'));

test('learn adds, then reinforces a near-duplicate instead of duplicating', () => {
  const file = path.join(tmp(), 'lessons.md');
  assert.equal(learn(file, { rule: 'Use pnpm, never npm', scope: 'bash:npm', why: 'pnpm workspace' }).action, 'added');
  const again = learn(file, { rule: 'use pnpm and never npm', scope: 'package.json' });
  assert.equal(again.action, 'reinforced');
  const [l] = loadLessons(file);
  assert.equal(l.reinforced, 2);
  assert.deepEqual(l.scope, ['bash:npm', 'package.json']);
  assert.equal(l.why, 'pnpm workspace');
  assert.equal(learn(file, { rule: 'Run migrations before seeding' }).action, 'added');
  assert.equal(loadLessons(file).length, 2);
});

test('lessons.md round-trips, keeps notes, and survives hand edits', () => {
  const text = `# Lessons\n\n## Spacing comes from tokens\n- scope: src/ui/**\n- why: design system\n- id: Labc123\n\nSee docs/design.md.\n\n## Hand-written lesson with no fields\n`;
  const lessons = parseLessons(text);
  assert.equal(lessons.length, 2);
  assert.equal(lessons[0].notes, 'See docs/design.md.');
  assert.ok(lessons[1].id.startsWith('L'));
  assert.deepEqual(parseLessons(serializeLessons(lessons)), lessons);
});

test('forget removes by id', () => {
  const file = path.join(tmp(), 'lessons.md');
  const { lesson } = learn(file, { rule: 'Never edit generated files' });
  assert.equal(forget(file, lesson.id), true);
  assert.equal(forget(file, lesson.id), false);
  assert.equal(loadLessons(file).length, 0);
});

test('globs behave like .gitignore', () => {
  assert.ok(globToRegExp('src/**/*.tsx').test('src/a/b/c.tsx'));
  assert.ok(globToRegExp('src/**/*.tsx').test('src/c.tsx'));
  assert.ok(!globToRegExp('src/*.tsx').test('src/a/c.tsx'));
  assert.ok(globToRegExp('src/ui/').test('src/ui/x/y.ts'));
  assert.ok(globToRegExp('*.{css,scss}').test('app.scss'));
});

test('appliesTo matches files relative to the root, names anywhere, and command prefixes', () => {
  const root = tmp();
  const L = (scope) => ({ rule: 'x', scope, reinforced: 1 });
  assert.ok(appliesTo(L(['src/ui/**']), { files: [path.join(root, 'src/ui/Button.tsx')] }, root));
  assert.ok(appliesTo(L(['*.css']), { files: ['styles/app.css'] }, root));
  assert.ok(!appliesTo(L(['src/ui/**']), { files: [path.join(root, 'src/api/x.ts')] }, root));
  assert.ok(!appliesTo(L(['*.ts']), { files: ['/elsewhere/x.ts'] }, root), 'files outside the project never match');
  assert.ok(appliesTo(L(['bash:git commit']), { command: 'git add -A && git commit -m wip' }, root));
  assert.ok(appliesTo(L(['bash:npm']), { command: 'cd web && FOO=1 /usr/local/bin/npm install' }, root));
  assert.ok(!appliesTo(L(['bash:npm']), { command: 'pnpm install' }, root));
  assert.ok(!appliesTo(L([]), { command: 'anything' }, root), 'global lessons come from the brief instead');
  assert.ok(isGlobal(L(['*'])));
});

test('corrections and preferences are detected; ordinary requests are not', () => {
  for (const t of [
    'no, use the Box component',
    'dont use inline styles',
    'also when you commit to git dont do cowritetn by claude',
    'I told you to run the tests first',
    'why did you delete that file?',
    'from now on always write tests',
    'revert that change',
  ]) assert.ok(detectCorrection(t).matched, t);
  for (const t of ['add a settings page', 'build the lessons MVP', 'what does this function do?', 'make the header sticky']) {
    assert.ok(!detectCorrection(t).matched, t);
  }
  assert.ok(!detectCorrection('```\n// never do this\n```\nexplain this snippet').matched, 'pasted code is not a correction');
  assert.ok(!detectCorrection(`Build this spec. ${'never '.repeat(400)}`).matched, 'long specs are not corrections');
});

test('continuations are recognized', () => {
  assert.ok(isContinuation('Continue Mathbloom. Read CLAUDE.md, then the handoff doc.'));
  assert.ok(isContinuation('pick up where we left off on the auth refactor'));
  assert.ok(!isContinuation('add dark mode'));
});
