import fs from 'node:fs';
import path from 'node:path';
import { handoffsDir, ensureLoreDir } from '../paths.js';
import { writeFileAtomic } from '../util/io.js';
import { readTranscript } from '../transcript.js';
import { buildHandoff } from './build.js';

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'session';

const stamp = (iso) => (iso ? iso.slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-') : 'undated');

/** Build and save the handoff for one transcript; one file per session, rewritten as it grows. */
export async function saveHandoff(transcriptPath, { root, trigger }) {
  const session = await readTranscript(transcriptPath);
  const built = buildHandoff(session, { root, trigger });
  if (!built) return null;
  ensureLoreDir(root);
  const dir = handoffsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const sid = String(session.sessionId || path.basename(transcriptPath, '.jsonl')).slice(0, 8);
  const file = path.join(dir, `${stamp(session.start)}-${slug(built.meta.title)}-${sid}.md`);
  for (const old of fs.readdirSync(dir)) if (old.endsWith(`-${sid}.md`) && path.join(dir, old) !== file) fs.unlinkSync(path.join(dir, old));
  writeFileAtomic(file, built.markdown);
  return { file, ...built.meta };
}

/** Newest first. */
export function listHandoffs(root) {
  const dir = handoffsDir(root);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    const m = first.match(/^<!-- lore (\{.*\}) -->$/);
    let meta = {};
    try {
      meta = m ? JSON.parse(m[1]) : {};
    } catch {}
    out.push({ file, title: meta.title || name, ...meta });
  }
  return out.sort((a, b) => String(b.end || '').localeCompare(String(a.end || '')));
}

/** `lore recall 2`, `lore recall auth refresh`: by position or best keyword match. */
export function findHandoff(root, query) {
  const all = listHandoffs(root);
  if (!all.length) return { all, match: null };
  if (!query) return { all, match: all[0] };
  if (/^\d+$/.test(query)) return { all, match: all[Number(query) - 1] || null };
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let best = null;
  for (const h of all) {
    const text = fs.readFileSync(h.file, 'utf8').toLowerCase();
    const title = String(h.title).toLowerCase();
    const score = terms.reduce((n, t) => n + (title.includes(t) ? 3 : 0) + (text.split(t).length - 1 > 0 ? 1 : 0), 0);
    if (score && (!best || score > best.score)) best = { h, score };
  }
  return { all, match: best?.h || null };
}
