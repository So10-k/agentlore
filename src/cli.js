import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { scan, DEFAULT_DIRS } from './scan/index.js';
import { renderReport } from './scan/report.js';
import { toJSON } from './scan/analyze.js';
import { walkJsonl, jsonLines } from './scan/session.js';
import { runHook } from './hook.js';
import { install, uninstall } from './install.js';
import { shrink, readSavings } from './compress/store.js';
import { projectRoot, projectLessonsPath, userLessonsPath, ensureLoreDir, relative } from './paths.js';
import { learn, forget, loadLessons } from './lessons/store.js';
import { isGlobal } from './lessons/scope.js';
import { saveHandoff, findHandoff } from './handoffs/store.js';
import { buildBrief } from './brief.js';
import { score, renderScore } from './score.js';
import { logEvent } from './state.js';
import { readStdin } from './util/io.js';
import { c, human, pct, padEnd, padStart, shq } from './util/term.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const VALUE_FLAGS = new Set(['days', 'project', 'agent', 'cmd', 'top', 'claude-dir', 'codex-dir', 'scope', 'why', 'settings', 'transcript', 'limit']);

const HELP = `
${c.bold('agentlore')} ${VERSION} — memory for Claude Code and Codex: lessons, handoffs, and a scoreboard

${c.bold('Set up')}
  lore install                  Add the hooks to Claude Code (~/.claude/settings.json)
      --codex                   …to Codex instead (~/.codex/hooks.json)
      --settings project|local  Use .claude/settings(.local).json instead
      --no-compress             Don't compress noisy Bash output
  lore uninstall [--codex]      Remove them; .lore/ is left alone
  lore backfill [--days 14]     Write handoffs for this project's recent sessions

${c.bold('Lessons')} ${c.dim('(agents run these themselves; you can too)')}
  lore learn "<rule>"           Teach a lesson; teaching it again reinforces it
      --scope "<glob>, bash:<cmd>"  When to show it (default: always)
      --why "<reason>"          One line of context
      --user                    For every project (~/.agentlore/lessons.md)
  lore lessons                  List lessons for this project
  lore forget <id> [--user]     Remove one

${c.bold('Handoffs')}
  lore recall                   List recent sessions in this project
  lore recall <n | words>       Print one: what was asked, where it ended, files, checks, open items
  lore handoff [--transcript <path>]  Save one now (default: latest session here)

${c.bold('Measure')}
  lore score [--days 30]        Scoreboard: context per request, re-exploration, repeated corrections
  lore scan [--days 30]         Where tokens go: tool output, noisy commands, waste patterns
  lore brief                    What agents see at session start
  lore stats                    What the output compressor has saved

${c.bold('Compressor')}
  lore run -- <command>         Run a command, print compressed output, keep the exit code
  lore filter [--cmd <c>]       Compress output piped on stdin
`;

function parseArgs(argv) {
  const args = { _: [], flags: {}, rest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      args.flags[k] = v !== undefined ? v : VALUE_FLAGS.has(k) ? argv[++i] : true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const str = (v) => (typeof v === 'string' ? v : undefined);
const daysOf = (flags, fallback) => (flags.days !== undefined ? Number(flags.days) : fallback);

export async function main(argv) {
  const { _, flags, rest } = parseArgs(argv);
  const command = _[0] || 'help';
  if (flags.version || command === 'version') return console.log(VERSION);
  if (flags.help || command === 'help') return console.log(HELP);
  const root = projectRoot();

  switch (command) {
    case 'install':
      return install({ scope: str(flags.settings) || 'user', codex: !!flags.codex, compress: !flags['no-compress'], dryRun: !!flags['dry-run'] });
    case 'uninstall':
      return uninstall({ scope: str(flags.settings) || 'user', codex: !!flags.codex });
    case 'hook':
      return runHook();
    case 'learn':
      return cmdLearn(root, _.slice(1).join(' '), flags);
    case 'lessons':
      return cmdLessons(root);
    case 'forget':
      return cmdForget(root, _[1], flags);
    case 'recall':
      return cmdRecall(root, _.slice(1).join(' '));
    case 'handoff':
      return cmdHandoff(root, flags);
    case 'backfill':
      return cmdBackfill(root, flags);
    case 'brief':
      return console.log(buildBrief(root));
    case 'score':
      return cmdScore(flags);
    case 'scan':
      return cmdScan(flags);
    case 'filter':
      return cmdFilter(flags);
    case 'run':
      return cmdRun(rest ?? _.slice(1));
    case 'stats':
      return cmdStats();
    default:
      console.error(`Unknown command: ${command}\n${HELP}`);
      process.exitCode = 2;
  }
}

// ---- lessons -----------------------------------------------------------------

function cmdLearn(root, rule, flags) {
  const file = flags.user ? userLessonsPath() : projectLessonsPath(root);
  if (!flags.user) ensureLoreDir(root);
  const agent = process.env.CLAUDECODE ? 'claude' : process.env.CODEX_SANDBOX || process.env.CODEX_THREAD_ID ? 'codex' : '';
  const { lesson, action } = learn(file, { rule, scope: str(flags.scope), why: str(flags.why), agent });
  logEvent('learn', { action, id: lesson.id, user: !!flags.user });
  const where = flags.user ? 'for every project' : `for ${relative(process.cwd(), file)}`;
  const when = lesson.scope.length ? `shown when touching ${lesson.scope.join(', ')}` : 'shown at every session start';
  console.log(`${action === 'added' ? 'Learned' : `Reinforced (taught ${lesson.reinforced}×)`} ${where}: ${lesson.rule}\n  ${when} · id ${lesson.id}`);
}

function cmdLessons(root) {
  const groups = [
    ['This project', projectLessonsPath(root)],
    ['Every project (yours)', userLessonsPath()],
  ];
  let any = false;
  for (const [label, file] of groups) {
    const lessons = loadLessons(file);
    if (!lessons.length) continue;
    any = true;
    console.log(`\n ${c.bold(label)} ${c.dim(file)}`);
    for (const l of lessons) {
      const scope = isGlobal(l) ? c.dim('always') : c.cyan(l.scope.join(', '));
      console.log(`   ${c.dim(l.id)}  ${l.rule}${l.reinforced > 1 ? c.yellow(` ×${l.reinforced}`) : ''}\n           ${scope}${l.why ? c.dim(` · ${l.why}`) : ''}`);
    }
  }
  if (!any) console.log('\n No lessons yet. They appear as you correct your agents, or: lore learn "<rule>"\n');
}

function cmdForget(root, id, flags) {
  const ok = id && forget(flags.user ? userLessonsPath() : projectLessonsPath(root), id);
  console.log(ok ? `Forgot ${id}.` : `No lesson ${id || '(none given)'}; see \`lore lessons\`.`);
  if (!ok) process.exitCode = 1;
}

// ---- handoffs ----------------------------------------------------------------

function cmdRecall(root, query) {
  const { all, match } = findHandoff(root, query);
  if (!all.length) return console.log('No handoffs for this project yet. They are saved when a session compacts or ends; `lore backfill` creates them from past sessions.');
  if (!query) {
    console.log('Recent sessions in this project (`lore recall <n>` for one):');
    all.slice(0, 15).forEach((h, i) => {
      const bits = [String(h.end || '').slice(0, 10), h.title, h.agent, h.files ? `${h.files} files` : null, h.open ? `${h.open} open` : null];
      console.log(` ${String(i + 1).padStart(2)}. ${bits.filter(Boolean).join(' · ')}`);
    });
    return;
  }
  if (!match) {
    process.exitCode = 1;
    return console.log(`No handoff matches "${query}". \`lore recall\` lists them.`);
  }
  logEvent('recall', { file: match.file });
  console.log(fs.readFileSync(match.file, 'utf8').replace(/^<!-- lore .* -->\n/, ''));
}

// Transcripts (newest first) whose working directory is inside this project.
async function transcriptsFor(root, days) {
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const files = [...walkJsonl(DEFAULT_DIRS.claude), ...walkJsonl(DEFAULT_DIRS.codex)]
    .filter((f) => !f.includes('/subagents/'))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .filter((x) => !cutoff || x.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const { f } of files) {
    let n = 0;
    for await (const d of jsonLines(f)) {
      const cwd = d.cwd || d.payload?.cwd;
      if (cwd) {
        if (cwd === root || cwd.startsWith(root + '/')) out.push(f);
        break;
      }
      if (++n > 40) break;
    }
  }
  return out;
}

async function cmdHandoff(root, flags) {
  const file = str(flags.transcript) || (await transcriptsFor(root, 30))[0];
  if (!file) return console.log('No session found for this project.');
  const saved = await saveHandoff(file, { root, trigger: 'manual' });
  console.log(saved ? `Saved ${relative(process.cwd(), saved.file)}: ${saved.title}` : 'Nothing to save: that session has no messages or changes.');
}

async function cmdBackfill(root, flags) {
  const limit = Number(flags.limit) || 10;
  const files = (await transcriptsFor(root, daysOf(flags, 14))).slice(0, limit);
  if (!files.length) return console.log('No recent sessions found for this project.');
  let n = 0;
  for (const file of files) {
    const saved = await saveHandoff(file, { root, trigger: 'backfill' });
    if (!saved) continue;
    n++;
    console.log(`  ${c.green('✓')} ${String(saved.end || '').slice(0, 10)} · ${saved.title} ${c.dim(`(${saved.agent})`)}`);
  }
  console.log(`${n} handoff${n === 1 ? '' : 's'} saved to ${relative(process.cwd(), ensureLoreDir(root))}/handoffs/`);
}

// ---- measuring ---------------------------------------------------------------

const progress = (flags) =>
  process.stderr.isTTY && !flags.json ? (i, n) => process.stderr.write(`\r Reading transcripts… ${i}/${n}`) : undefined;
const clearProgress = (flags) => process.stderr.isTTY && !flags.json && process.stderr.write('\r\x1b[K');

async function cmdScore(flags) {
  const r = await score({ days: daysOf(flags, 30), project: str(flags.project), onProgress: progress(flags) });
  clearProgress(flags);
  console.log(flags.json ? JSON.stringify(r, null, 2) : renderScore(r));
}

async function cmdScan(flags) {
  const agg = await scan({
    days: daysOf(flags, 30),
    project: str(flags.project),
    agent: flags.agent || 'all',
    claudeDir: flags['claude-dir'],
    codexDir: flags['codex-dir'],
    topN: Number(flags.top) || 10,
    onProgress: progress(flags),
  });
  clearProgress(flags);
  console.log(flags.json ? JSON.stringify(toJSON(agg), null, 2) : renderReport(agg));
}

// ---- compressor --------------------------------------------------------------

async function cmdFilter(flags) {
  const raw = await readStdin();
  try {
    process.stdout.write(shrink(raw, str(flags.cmd) || '', 'filter').text);
  } catch {
    process.stdout.write(raw); // never lose output because of us
  }
}

function cmdRun(words) {
  if (!words.length) {
    console.error('Usage: lore run -- <command>');
    process.exitCode = 2;
    return;
  }
  // One argument is a shell string ("npm test && npm run lint"); several are argv.
  const command = words.length === 1 ? words[0] : words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : shq(w))).join(' ');
  const r = spawnSync(process.env.SHELL || '/bin/sh', ['-c', `{ ${command}\n} 2>&1`], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  const out = shrink(r.stdout || '', command, 'run').text;
  process.stdout.write(out.endsWith('\n') || !out ? out : out + '\n');
  process.exitCode = r.status ?? 1;
}

function cmdStats() {
  const rows = readSavings();
  if (!rows.length) return console.log('\n Nothing compressed yet.\n');
  const sum = (xs) => xs.reduce((n, r) => n + (r.before - r.after), 0);
  const week = rows.filter((r) => r.ts > Date.now() - 7 * 86_400_000);
  const before = rows.reduce((n, r) => n + r.before, 0);
  console.log(`\n ${c.bold('lore stats')}`);
  console.log(`   ${padEnd('Outputs compressed', 22)}${rows.length.toLocaleString('en-US')}`);
  console.log(`   ${padEnd('Tokens saved', 22)}${c.green(human(sum(rows)))} ${c.dim(`(−${pct(sum(rows), before)}% of what those commands printed)`)}`);
  console.log(`   ${padEnd('Last 7 days', 22)}${human(sum(week))}`);
  const byFilter = new Map();
  for (const r of rows) byFilter.set(r.filter, (byFilter.get(r.filter) || 0) + r.before - r.after);
  console.log(`\n ${c.bold('BY FILTER')}`);
  for (const [name, n] of [...byFilter].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`   ${padEnd(name, 22)}${padStart(human(n), 7)}`);
  }
  console.log(c.dim('\n Savings count each output once; it is re-sent on every later request, so the real effect is larger.\n'));
}
