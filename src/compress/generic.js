import { estimateTokens } from '../util/tokens.js';

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const MAX_LINE = 500;

export const marker = (what) => `… [lore: ${what}]`;

// Strip colors, resolve carriage-return progress bars to their final state,
// and cap absurdly long lines (minified code, base64 blobs).
export function normalize(text) {
  return text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => {
      line = line.replace(/\r+$/, '');
      const cr = line.lastIndexOf('\r');
      if (cr !== -1) line = line.slice(cr + 1);
      line = line.trimEnd();
      if (line.length > MAX_LINE) line = `${line.slice(0, 400)} ${marker(`+${line.length - 400} chars`)}`;
      return line;
    });
}

// Replace every line matching `re` with one note at the first match's position.
// A couple of matches aren't worth a note, so those stay as they are.
export function hide(lines, re, label, keepIfFew = 2) {
  const out = [];
  let hits = 0;
  let at = -1;
  for (const line of lines) {
    if (re.test(line)) {
      if (at === -1) at = out.push(null) - 1;
      hits++;
    } else {
      out.push(line);
    }
  }
  if (hits <= keepIfFew) return lines;
  out[at] = marker(`${hits} ${label} hidden`);
  return out;
}

// Keep a section's header and first `keep` body lines; sections end at the next
// "==== title ====" rule (pytest style).
export function collapseSection(lines, headerRe, keep, label) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!headerRe.test(lines[i])) {
      out.push(lines[i++]);
      continue;
    }
    out.push(lines[i]);
    let j = i + 1;
    const body = [];
    while (j < lines.length && !/^=+ .* =+$/.test(lines[j])) body.push(lines[j++]);
    out.push(...body.slice(0, keep));
    if (body.length > keep) out.push(marker(`${body.length - keep} ${label} hidden`));
    i = j;
  }
  return out;
}

export function dedupe(lines) {
  const out = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i] && lines[i].trim()) j++;
    const repeats = j - i - 1;
    out.push(lines[i]);
    if (repeats === 1) out.push(lines[i]);
    else if (repeats > 1) out.push(marker(`line above repeated ${repeats} more times`));
    i = j;
  }
  return out;
}

const shape = (line) =>
  line.replace(/0x[0-9a-f]+|\b[0-9a-f]{8,}\b/gi, 'H').replace(/\d+(\.\d+)?/g, 'N');

// Runs of lines that differ only in numbers/hashes (progress, timings, sizes).
export function collapseSimilar(lines, minRun = 8) {
  const out = [];
  for (let i = 0; i < lines.length; ) {
    const s = shape(lines[i]);
    let j = i + 1;
    while (j < lines.length && lines[i].trim() && shape(lines[j]) === s) j++;
    const run = j - i;
    if (run >= minRun) {
      out.push(...lines.slice(i, i + 3), marker(`${run - 5} similar lines hidden`), ...lines.slice(j - 2, j));
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return out;
}

export function squeezeBlank(lines) {
  const out = lines.filter((line, i) => line.trim() || (i > 0 && lines[i - 1].trim()));
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

const IMPORTANT =
  /\b(errors?|err!|fail(ed|ure|ing)?|panic(ked)?|exception|traceback|fatal|assert(ion)?|cannot find|not found|denied|undefined)\b|✗|✖|×|❌/i;

// Over budget: keep the head, the tail, and error-looking lines from the middle.
export function smartTruncate(lines, maxTokens) {
  if (estimateTokens(lines.join('\n')) <= maxTokens) return lines;
  let head = 30;
  let tail = 50;
  let important = 40;
  for (;;) {
    const keep = new Set();
    for (let i = 0; i < Math.min(head, lines.length); i++) keep.add(i);
    for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) keep.add(i);
    let found = 0;
    for (let i = head; i < lines.length - tail && found < important; i++) {
      if (IMPORTANT.test(lines[i])) {
        keep.add(i - 1).add(i).add(i + 1);
        found++;
      }
    }
    const out = [];
    let gap = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!keep.has(i)) {
        gap++;
        continue;
      }
      if (gap) out.push(marker(`${gap} lines omitted`));
      gap = 0;
      out.push(lines[i]);
    }
    if (gap) out.push(marker(`${gap} lines omitted`));
    if (estimateTokens(out.join('\n')) <= maxTokens || (head <= 5 && tail <= 10 && important <= 5)) return out;
    head = Math.max(5, head >> 1);
    tail = Math.max(10, tail >> 1);
    important = Math.max(5, important >> 1);
  }
}
