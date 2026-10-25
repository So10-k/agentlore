import fs from 'node:fs';
import readline from 'node:readline';

/*
 * Both transcript parsers produce the same shape, which is all the analyzer sees:
 *
 *   calls        one entry per model request: { input, cacheRead, cacheCreate, output }
 *   tools        { name, kind: shell|read|edit|other, command?, file?, range?, text,
 *                  tokens, images, isError, at, seq }
 *                `at` = calls made before the result arrived, so every later call
 *                (until a compaction) re-sent it.
 *   compactions  { at, seq } — context was summarized; earlier results are gone.
 *   mentions     { seq, text } — what the agent itself wrote (prose, thinking,
 *                tool arguments), used to guess whether a file read was used.
 */
export function newSession(agent, file) {
  return {
    agent,
    file,
    project: null,
    start: null,
    end: null,
    sidechain: file.includes('/subagents/'),
    calls: [],
    tools: [],
    compactions: [],
    mentions: [],
    seq: 0,
  };
}

export async function* jsonLines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

export function* walkJsonl(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = `${root}/${e.name}`;
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

export function touch(s, timestamp) {
  if (!timestamp) return;
  s.start ??= timestamp;
  s.end = timestamp;
}
