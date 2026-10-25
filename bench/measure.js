#!/usr/bin/env node
// Compress every fixture in bench/fixtures and print a before/after table.
// The fixture's command is in bench/commands.json; run make-fixtures.sh to regenerate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compress } from '../src/compress/index.js';

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const commands = JSON.parse(fs.readFileSync(new URL('./commands.json', import.meta.url), 'utf8'));
const rows = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()) {
  const name = path.basename(file, '.txt');
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  const r = compress(raw, { command: commands[name] || '' });
  rows.push({ name, command: commands[name] || '?', before: r.before, after: r.after, filter: r.filter || '(unchanged)' });
}
const total = rows.reduce((a, r) => ({ before: a.before + r.before, after: a.after + r.after }), { before: 0, after: 0 });
const cut = (r) => (r.before ? Math.round((1 - r.after / r.before) * 100) : 0);

if (process.argv.includes('--md')) {
  console.log('| Output | Command | Before | After | Cut |\n|---|---|---:|---:|---:|');
  for (const r of rows) console.log(`| ${r.name} | \`${r.command}\` | ${r.before.toLocaleString('en-US')} | ${r.after.toLocaleString('en-US')} | **${cut(r)}%** |`);
  console.log(`| **Total** | | ${total.before.toLocaleString('en-US')} | ${total.after.toLocaleString('en-US')} | **${cut(total)}%** |`);
} else {
  for (const r of rows) console.log(`${r.name.padEnd(28)} ${String(r.before).padStart(7)} → ${String(r.after).padStart(6)}  ${String(cut(r)).padStart(3)}%  ${r.filter}`);
  console.log(`${'TOTAL'.padEnd(28)} ${String(total.before).padStart(7)} → ${String(total.after).padStart(6)}  ${String(cut(total)).padStart(3)}%`);
}
