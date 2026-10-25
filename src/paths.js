import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Per-user state: personal lessons, logs, stats, per-session hook state.
export const HOME = process.env.AGENTLORE_HOME || path.join(os.homedir(), '.agentlore');

// Project memory lives in the repo so it can be reviewed and shared:
//   .lore/lessons.md    committed: what the team's agents have learned
//   .lore/handoffs/     gitignored by default: session handoffs (they quote prompts)
export function projectRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

export const loreDir = (root) => path.join(root, '.lore');
export const projectLessonsPath = (root) => path.join(loreDir(root), 'lessons.md');
export const handoffsDir = (root) => path.join(loreDir(root), 'handoffs');
export const userLessonsPath = () => path.join(HOME, 'lessons.md');

export function ensureLoreDir(root) {
  const dir = loreDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# Handoffs quote your prompts; commit them only if you mean to.\nhandoffs/\n');
  return dir;
}

export const relative = (root, file) => {
  if (!file) return file;
  const rel = path.relative(root, path.resolve(root, file));
  return rel.startsWith('..') ? file : rel;
};

const BIN = fileURLToPath(new URL('../bin/lore.js', import.meta.url));
const onPath = (name) => (process.env.PATH || '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, name)));

// How agents and hooks should invoke us: `lore` once installed globally, the
// absolute script otherwise (development, npx).
export function loreCommand() {
  if (process.env.AGENTLORE_BIN) return process.env.AGENTLORE_BIN;
  return onPath('lore') ? 'lore' : `"${process.execPath}" "${BIN}"`;
}
export const isOnPath = () => onPath('lore');
