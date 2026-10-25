import os from 'node:os';
import path from 'node:path';
import { c, human, pct, bar, padEnd, padStart, truncate, median } from '../util/term.js';
import { redact } from '../util/redact.js';

const W = 72;
const home = os.homedir();

const tidy = (p) => redact(p && p.startsWith(home) ? '~' + p.slice(home.length) : p || '');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?');
const heading = (title, right = '') => `\n ${c.bold(padEnd(title.toUpperCase(), W - right.length - 1))}${c.dim(right)}`;

function box(lines) {
  const inner = W - 4;
  return [
    ` ╭${'─'.repeat(inner + 2)}╮`,
    ...lines.map((l) => ` │ ${padEnd(l, inner)} │`),
    ` ╰${'─'.repeat(inner + 2)}╯`,
  ].join('\n');
}

function denyRule(file) {
  const dir = file.match(/(^|\/)(dist|build|out|\.next|node_modules|coverage|DerivedData|Pods)\//);
  return dir ? `Read(**/${dir[2]}/**)` : `Read(**/${path.basename(file).replace(/^.*\.(min\.(js|css)|map|snap)$/, '*.$1')})`;
}

function suggestions(a) {
  const out = [];
  const saved = a.sim.carriedBefore - a.sim.carriedAfter;
  if (a.sim.before - a.sim.after > 0) {
    out.push(
      `Install the compressor ${c.dim('(Claude Code hooks)')}:\n` +
        `      ${c.cyan('npx lore install')}\n` +
        `   It would have cut shell output by ${pct(a.sim.before - a.sim.after, a.sim.before)}%, about ${human(saved)} tokens of context.`,
    );
  }
  if (a.generated.count) {
    const rules = [...new Set([...a.generated.files.keys()].map(denyRule))].slice(0, 6);
    out.push(
      `Stop reading lock and generated files (${a.generated.count} reads, ${human(a.generated.tokens)} tokens).\n` +
        `   Add to ~/.claude/settings.json → "permissions": { "deny": [ ... ] }:\n` +
        rules.map((r) => `      ${c.cyan(JSON.stringify(r))}`).join('\n'),
    );
  }
  const big = a.instructions.filter((f) => f.tokens >= 1500);
  if (big.length) {
    out.push(
      `Trim always-loaded instructions; these go out with every request:\n` +
        big.slice(0, 4).map((f) => `      ${padStart(human(f.tokens), 5)}  ${tidy(f.file)}`).join('\n'),
    );
  }
  const startup = median(a.startup);
  if (startup > 25_000) {
    out.push(
      `Sessions start at ~${human(startup)} tokens before you type. Tool schemas from MCP servers\n` +
        `   are the usual culprit: disable the ones you don't use in this project.`,
    );
  }
  const long = a.peaks.filter((p) => p > 150_000).length;
  if (long) {
    out.push(
      `${long} session${long > 1 ? 's' : ''} grew past 150K tokens of context. Use /clear between unrelated tasks;\n` +
        `   every request in a long session re-sends all of it.`,
    );
  }
  if (a.images.carried > a.context * 0.03) {
    out.push(
      `Screenshots: ${a.images.count} images carried ${human(a.images.carried)} tokens. Ask for page text or\n` +
        `   the accessibility tree when you don't need pixels.`,
    );
  }
  return out;
}

export function renderReport(a) {
  if (!a.sessions) {
    return `\n No sessions found${a.days ? ` in the last ${a.days} days` : ''}. Looked in ~/.claude/projects and ~/.codex/sessions.\n`;
  }
  const L = [];
  const agents = [
    a.agents.claude && `${a.agents.claude} Claude Code`,
    a.agents.codex && `${a.agents.codex} Codex`,
  ].filter(Boolean);
  const saved = a.sim.carriedBefore - a.sim.carriedAfter;

  L.push(`\n ${c.bold('lore')} ${c.dim('· where your tokens went')}`);
  L.push(` ${c.dim(`${a.days ? `Last ${a.days} days` : 'All time'} · ${agents.join(' + ')} sessions · ${day(a.first)} – ${day(a.last)}`)}\n`);
  L.push(
    box([
      `${c.bold(human(a.context))} tokens of context read by your agents`,
      `${c.bold(pct(a.toolCarried, a.context) + '%')} of it was tool output, re-sent request after request`,
      saved >= a.context * 0.01
        ? `lore would have cut ${c.green(c.bold(human(saved)))} of that ${c.dim(`(${pct(saved, a.context)}% of all context)`)}`
        : `Shell output is already lean here; ${c.dim('see Fix it for the real waste')}`,
    ]),
  );

  L.push(heading('Overview'));
  const row = (k, v) => L.push(`   ${padEnd(k, 24)}${v}`);
  row('Model requests', a.calls.toLocaleString('en-US'));
  row('Context read', `${human(a.context)}  ${c.dim(`(${pct(a.cacheRead, a.context)}% from cache)`)}`);
  row('Output written', human(a.output));
  row('Size at session start', `${human(median(a.startup))} tokens ${c.dim('median, before your first message')}`);
  const over = a.peaks.filter((p) => p > 150_000).length;
  row('Peak context', `${human(median(a.peaks))} median${over ? c.dim(` · ${over} sessions passed 150K`) : ''}`);

  const tools = [...a.byTool].sort((x, y) => y[1].carried - x[1].carried).slice(0, 8);
  const maxCarried = tools[0]?.[1].carried || 1;
  L.push(heading('Where tool output came from', 'output   carried*'));
  for (const [name, t] of tools) {
    L.push(`   ${padEnd(truncate(name, 22), 23)}${bar(t.carried / maxCarried, 22)} ${padStart(human(t.tokens), 7)}  ${padStart(human(t.carried), 8)}`);
  }
  L.push(c.dim('   * carried = output × the number of later requests that re-sent it'));

  const cmds = [...a.commands].sort((x, y) => y[1].tokens - x[1].tokens).slice(0, 10);
  if (cmds.length) {
    L.push(heading('Noisiest commands', 'runs   output   lore'));
    for (const [key, r] of cmds) {
      const cut = pct(r.tokens - r.after, r.tokens);
      const cutText = cut > 0 ? c.green(`−${cut}%`) : c.dim('—');
      L.push(`   ${padEnd(truncate(redact(key), 44), 45)}${padStart(String(r.runs), 6)}  ${padStart(human(r.tokens), 7)}  ${padStart(cutText, 8)}`);
    }
    L.push(c.dim('   — = file contents or search results; lore leaves those alone'));
  }

  if (a.biggest.length) {
    L.push(heading('Biggest single results', 'tokens × re-sent'));
    for (const b of a.biggest.slice(0, 8)) {
      const what = truncate(b.what ? tidy(b.what) : '', 42);
      L.push(`   ${padEnd(truncate(b.tool, 14), 15)}${padEnd(what, 43)}${padStart(human(b.tokens), 6)} ${c.dim('×' + b.times)}`);
    }
  }

  L.push(heading('Waste patterns', 'count   tokens'));
  const waste = (label, w, note = '') =>
    w.count &&
    L.push(`   ${padEnd(label, 47)}${padStart(String(w.count), 6)}  ${padStart(human(w.tokens), 7)}${note ? '  ' + c.dim(note) : ''}`);
  const topReread = [...a.rereads.files].sort((x, y) => y[1].count - x[1].count)[0];
  waste('Re-read a file that had not changed', a.rereads, topReread ? `top: ${path.basename(topReread[0])} ×${topReread[1].count}` : '');
  waste('Read a lock or generated file', a.generated);
  waste('Read a file, never mentioned it again', a.unused, 'heuristic');
  waste('Screenshots and images', a.images);

  if (a.sim.runs) {
    L.push(heading('What lore would have saved'));
    L.push(`   ${padEnd('Shell output', 22)}${human(a.sim.before)} → ${c.green(human(a.sim.after))}  ${c.dim(`(−${pct(a.sim.before - a.sim.after, a.sim.before)}%, ${a.sim.runs} runs)`)}`);
    L.push(`   ${padEnd('Context carried', 22)}${human(a.sim.carriedBefore)} → ${c.green(human(a.sim.carriedAfter))}  ${c.dim(`(−${human(saved)})`)}`);
  }

  const fixes = suggestions(a);
  if (fixes.length) {
    L.push(heading('Fix it'));
    fixes.forEach((f, i) => L.push(` ${c.bold(`${i + 1}.`)} ${f}\n`));
  }
  L.push(c.dim(' Token counts for tool output are estimates (~4 chars/token). Request totals come from the transcripts.\n'));
  return L.join('\n');
}

