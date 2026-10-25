import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.js';
import { readJson, writeFileAtomic } from './util/io.js';

const SESSIONS = path.join(HOME, 'sessions');
const EVENTS = path.join(HOME, 'events.jsonl');
const CONFIG = path.join(HOME, 'config.json');
const SESSION_TTL_MS = 7 * 86_400_000;

export const DEFAULT_CONFIG = { compress: true, nudgeAt: 200_000 };
export const loadConfig = () => ({ ...DEFAULT_CONFIG, ...readJson(CONFIG, {}) });
export const saveConfig = (patch) => writeFileAtomic(CONFIG, JSON.stringify({ ...readJson(CONFIG, {}), ...patch }, null, 2) + '\n');

// Per-session hook state, so a lesson is shown once per session (or once per
// compaction, since compaction forgets it), not on every edit.
const sessionFile = (sid) => path.join(SESSIONS, `${String(sid || 'unknown').replace(/[^\w-]/g, '')}.json`);

export function loadSession(sid) {
  return { injected: [], nudgedAt: 0, ...readJson(sessionFile(sid), {}) };
}

export function saveSession(sid, state) {
  writeFileAtomic(sessionFile(sid), JSON.stringify(state));
  if (Math.random() < 0.02) pruneSessions();
}

function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const name of fs.readdirSync(SESSIONS)) {
    try {
      if (fs.statSync(path.join(SESSIONS, name)).mtimeMs < cutoff) fs.unlinkSync(path.join(SESSIONS, name));
    } catch {}
  }
}

// What agentlore did, for `lore score`: lessons shown/learned, handoffs saved/recalled, nudges.
export function logEvent(type, fields = {}) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(EVENTS, JSON.stringify({ ts: Date.now(), type, ...fields }) + '\n');
  } catch {}
}

export function readEvents() {
  try {
    return fs
      .readFileSync(EVENTS, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function logError(err) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(path.join(HOME, 'errors.log'), `${new Date().toISOString()} ${err?.stack || err}\n`);
  } catch {}
}

// Current context size: the last request's usage, read from the transcript's tail.
export function currentContext(transcriptPath) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('usage') && !line.includes('token_count')) continue;
      try {
        const d = JSON.parse(line);
        const u = d.message?.usage;
        if (d.type === 'assistant' && u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const c = d.payload?.info?.last_token_usage?.input_tokens;
        if (c) return c;
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return 0;
}
