import fs from 'node:fs';
import path from 'node:path';
import { compress } from './index.js';

import { HOME } from '../paths.js';
const LOGS = path.join(HOME, 'logs');
const STATS = path.join(HOME, 'stats.jsonl');
const LOG_TTL_MS = 3 * 24 * 3600 * 1000;

function saveRawLog(text, label) {
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    const slug = (label || 'output').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'output';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(LOGS, `${stamp}-${Math.random().toString(36).slice(2, 6)}-${slug}.log`);
    fs.writeFileSync(file, text);
    if (Math.random() < 0.05) pruneLogs();
    return file;
  } catch {
    return null;
  }
}

function pruneLogs() {
  const cutoff = Date.now() - LOG_TTL_MS;
  for (const name of fs.readdirSync(LOGS)) {
    const file = path.join(LOGS, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}

function recordSaving(entry) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(STATS, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch {}
}

export function readSavings() {
  try {
    return fs
      .readFileSync(STATS, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Compress live output: keep the raw copy on disk and record the saving.
export function shrink(raw, command, mode) {
  const label = command.replace(/^(\s*cd\s+\S+\s*&&\s*)+/, '');
  const r = compress(raw, { command, saveLog: (text) => saveRawLog(text, label) });
  if (r.changed) recordSaving({ mode, cmd: command.slice(0, 200), before: r.before, after: r.after, filter: r.filter });
  return r;
}
