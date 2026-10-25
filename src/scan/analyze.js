import path from 'node:path';
import { compress } from '../compress/index.js';
import { redact } from '../util/redact.js';

// Files an agent almost never needs to read in full.
export const GENERATED =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|Podfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$|\.snap$|(^|\/)(dist|build|out|\.next|node_modules|coverage|DerivedData|Pods)\//;

const TWO_WORD = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'uv', 'pip', 'pip3', 'swift', 'xcrun', 'brew',
  'make', 'gh', 'kubectl', 'deno', 'poetry', 'terraform', 'flutter', 'dart', 'dotnet', 'mvn', 'gradle', 'gradlew',
  'expo', 'eas', 'supabase', 'vercel', 'firebase', 'wrangler', 'fly', 'aws', 'gcloud', 'rails', 'bundle', 'mix',
]);

/** Group commands by what they run: `cd app && FOO=1 npm run test -- -u` → "npm run test". */
export function commandKey(command = '') {
  const wordsOf = (seg) => seg.split(/\s+/).filter((w) => w && !/^\w+=/.test(w) && w !== 'sudo' && w !== 'time');
  const segs = command
    .split(/&&|;|\|\||\n/)
    .map((s) => s.split('|')[0].trim())
    .filter((s) => wordsOf(s).length && !/^(cd|export|source|set|setopt|pushd|popd|sleep|echo|#)/.test(s));
  const words = wordsOf(segs[0] || '');
  if (!words.length) return '(other)';
  const [a0, b, c] = words.map((w) => w.replace(/^['"]|['"]$/g, ''));
  const a = a0.replace(/^.*\/(?=.)/, '');
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(a) && b === 'run' && c) return `${a} run ${c}`;
  if (['npx', 'bunx', 'pnpx', 'uvx'].includes(a) && b) return `${a} ${b.replace(/^.*\//, '')}`;
  if (/^python3?$/.test(a) && b === '-m' && c) return `${a} -m ${c}`;
  if (TWO_WORD.has(a) && b && !b.startsWith('-')) return `${a} ${b}`;
  return a;
}

export function createAggregate() {
  return {
    sessions: 0,
    agents: {},
    calls: 0,
    input: 0,
    cacheRead: 0,
    cacheCreate: 0,
    output: 0,
    toolTokens: 0,
    toolCarried: 0, // tokens × number of later requests that re-sent them
    byTool: new Map(),
    commands: new Map(),
    biggest: [],
    rereads: { count: 0, tokens: 0, carried: 0, files: new Map() },
    generated: { count: 0, tokens: 0, carried: 0, files: new Map() },
    unused: { count: 0, tokens: 0, carried: 0 },
    images: { count: 0, tokens: 0, carried: 0 },
    sim: { runs: 0, before: 0, after: 0, carriedBefore: 0, carriedAfter: 0 },
    startup: [],
    peaks: [],
    projects: new Map(),
    first: null,
    last: null,
  };
}

const bump = (map, key, fields) => {
  const row = map.get(key) || {};
  for (const [k, v] of Object.entries(fields)) row[k] = (row[k] || 0) + v;
  map.set(key, row);
  return row;
};

const contextOf = (call) => call.input + call.cacheRead + call.cacheCreate;

export function addSession(agg, s, { topN = 10 } = {}) {
  agg.sessions++;
  agg.agents[s.agent] = (agg.agents[s.agent] || 0) + 1;
  if (s.start && (!agg.first || s.start < agg.first)) agg.first = s.start;
  if (s.end && (!agg.last || s.end > agg.last)) agg.last = s.end;

  let peak = 0;
  let sessionContext = 0;
  for (const call of s.calls) {
    agg.calls++;
    agg.input += call.input;
    agg.cacheRead += call.cacheRead;
    agg.cacheCreate += call.cacheCreate;
    agg.output += call.output;
    sessionContext += contextOf(call);
    peak = Math.max(peak, contextOf(call));
  }
  if (s.calls.length && !s.sidechain) agg.startup.push(contextOf(s.calls[0]));
  if (s.calls.length) agg.peaks.push(peak);
  bump(agg.projects, s.project || '(unknown)', { sessions: 1, context: sessionContext });

  // A tool result rides along in every request after it, until the next compaction.
  const carried = (tool) => {
    const next = s.compactions.find((cpt) => cpt.seq > tool.seq);
    return Math.max(0, (next ? next.at : s.calls.length) - tool.at);
  };

  // For "read but never mentioned again": everything the agent wrote, in order.
  const mentionText = s.mentions.map((m) => m.text).join('\n');
  const mentionOffsets = [];
  let offset = 0;
  for (const m of s.mentions) {
    mentionOffsets.push(offset);
    offset += m.text.length + 1;
  }
  const mentionedAfter = (seq, needle) => {
    let lo = 0;
    let hi = s.mentions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.mentions[mid].seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return lo < s.mentions.length && mentionText.indexOf(needle, mentionOffsets[lo]) !== -1;
  };

  const reads = new Map(); // file → { ranges, edited }
  for (const t of s.tools) {
    const times = carried(t);
    const carriedTokens = t.tokens * times;
    agg.toolTokens += t.tokens;
    agg.toolCarried += carriedTokens;
    const label = t.kind === 'shell' ? 'Bash / shell' : t.name.startsWith('mcp__') ? `mcp:${t.name.split('__')[1]}` : t.name;
    bump(agg.byTool, label, { calls: 1, tokens: t.tokens, carried: carriedTokens });

    if (t.tokens > 0) {
      agg.biggest.push({
        tool: label,
        what: redact(t.command || t.file || t.label || ''),
        tokens: t.tokens,
        times,
        project: s.project,
        when: s.start,
      });
      if (agg.biggest.length > topN * 4) agg.biggest = agg.biggest.sort((a, b) => b.tokens - a.tokens).slice(0, topN);
    }

    if (t.images) {
      const imageTokens = t.tokens - Math.ceil(t.text.length / 4);
      agg.images.count += t.images;
      agg.images.tokens += imageTokens;
      agg.images.carried += imageTokens * times;
    }

    if (t.kind === 'shell' && t.text) {
      const sim = compress(t.text, { command: t.command || '' });
      const row = bump(agg.commands, commandKey(t.command), {
        runs: 1,
        tokens: t.tokens,
        carried: carriedTokens,
        after: sim.after,
      });
      row.example ??= redact(t.command || '');
      agg.sim.runs++;
      agg.sim.before += sim.before;
      agg.sim.after += sim.after;
      agg.sim.carriedBefore += sim.before * times;
      agg.sim.carriedAfter += sim.after * times;
    }

    if (t.kind === 'edit' && t.file) {
      const r = reads.get(t.file);
      if (r) r.edited = true;
    }

    if (t.kind === 'read' && t.file && !t.isError && !t.images) {
      const r = reads.get(t.file) || { ranges: new Set(), edited: false };
      if (!r.edited && r.ranges.has(t.range)) {
        agg.rereads.count++;
        agg.rereads.tokens += t.tokens;
        agg.rereads.carried += carriedTokens;
        bump(agg.rereads.files, t.file, { count: 1, tokens: t.tokens });
      }
      if (r.edited) r.ranges.clear();
      r.edited = false;
      r.ranges.add(t.range);
      reads.set(t.file, r);

      if (GENERATED.test(t.file)) {
        agg.generated.count++;
        agg.generated.tokens += t.tokens;
        agg.generated.carried += carriedTokens;
        bump(agg.generated.files, t.file, { count: 1, tokens: t.tokens });
      }

      const base = path.basename(t.file);
      if (t.tokens >= 500 && base.length >= 4 && !mentionedAfter(t.seq, base)) {
        agg.unused.count++;
        agg.unused.tokens += t.tokens;
        agg.unused.carried += carriedTokens;
      }
    }
  }
}

export function finalize(agg, { topN = 10 } = {}) {
  agg.biggest = agg.biggest.sort((a, b) => b.tokens - a.tokens).slice(0, topN);
  agg.context = agg.input + agg.cacheRead + agg.cacheCreate;
  return agg;
}

// Maps → plain objects for --json.
export function toJSON(agg) {
  const plain = (v) =>
    v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
  return plain(agg);
}
