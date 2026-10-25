import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

// Gitignore-flavored globs: `*` stays within a folder, `**` crosses folders,
// `{a,b}` alternates, a trailing `/` means everything under it, and a glob
// with no `/` matches the file name anywhere.
export function globToRegExp(glob) {
  let g = glob.trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{' && g.indexOf('}', i) > i) {
      const end = g.indexOf('}', i);
      re += `(${g.slice(i + 1, end).split(',').map(esc).join('|')})`;
      i = end;
    } else re += esc(ch);
  }
  return new RegExp(`^${re}$`);
}

export const isGlobal = (lesson) => !lesson.scope.length || lesson.scope.every((s) => s === '*' || s === '**');

function matchesFile(glob, rel) {
  const re = globToRegExp(glob);
  return re.test(rel) || (!glob.includes('/') && re.test(path.basename(rel)));
}

// `bash:git commit` matches any `&&`/`;`/`|` segment that starts with `git commit`.
function matchesCommand(prefix, command) {
  const want = prefix.trim().split(/\s+/);
  return command.split(/&&|\|\||;|\||\n/).some((seg) => {
    const words = seg.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w) && w !== 'sudo');
    if (words[0]) words[0] = words[0].replace(/^.*\//, '');
    return want.every((w, i) => words[i] === w);
  });
}

// Compare real paths: on macOS /var is /private/var, and git reports the latter.
// A file being created may not exist yet (nor its folders), so resolve the
// nearest ancestor that does and keep the rest as written.
export function canonical(p) {
  let rest = '';
  for (let dir = p; ; ) {
    try {
      return path.join(fs.realpathSync(dir), rest);
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return p;
      rest = path.join(path.basename(dir), rest);
      dir = up;
    }
  }
}

/** Does this lesson apply to what the agent is about to touch? */
export function appliesTo(lesson, { files = [], command = '' }, root) {
  if (isGlobal(lesson)) return false; // global lessons are already in the session brief
  const rels = files.map((f) => (path.isAbsolute(f) ? path.relative(canonical(root), canonical(f)) : f));
  return lesson.scope.some((s) => {
    if (s.startsWith('bash:')) return !!command && matchesCommand(s.slice(5), command);
    return rels.some((rel) => !rel.startsWith('..') && matchesFile(s, rel));
  });
}
