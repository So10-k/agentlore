import { shrink } from './store.js';
import { isNoisyCommand } from './filters.js';
import { shq } from '../util/term.js';
import { loreCommand } from '../paths.js';

/*
 * The output compressor's half of the Bash hooks (Claude Code only).
 *
 * PostToolUse fires only for commands that exited 0. It replaces the output
 * through `updatedToolOutput`, so the command itself is untouched.
 *
 * Failed commands go to PostToolUseFailure, which can't replace output, and
 * failing test/build runs are the noisiest of all. So PreToolUse rewrites known
 * noisy commands to pipe through `lore filter`, keeping the exit status with
 * pipefail. No permissionDecision is returned: Claude Code's own permission
 * rules still decide whether the command runs.
 */

/** Returns a rewritten tool_input, or null. */
export function compressPre(ti) {
  if (!ti || ti.run_in_background || process.env.AGENTLORE_NO_REWRITE) return null;
  const command = rewriteCommand(ti.command);
  return command ? { ...ti, command } : null;
}

/** Returns a replacement tool_response, or null. */
export function compressPost(ti, r) {
  if (!r || typeof r.stdout !== 'string' || r.isImage) return null;
  const command = ti?.command || '';
  if (command.includes('lore filter')) return null; // already filtered on the way out
  const stdout = shrink(r.stdout, command, 'hook');
  const stderr = typeof r.stderr === 'string' ? shrink(r.stderr, command, 'hook') : { changed: false };
  if (!stdout.changed && !stderr.changed) return null;
  return {
    ...r,
    stdout: stdout.changed ? stdout.text : r.stdout,
    ...(stderr.changed && { stderr: stderr.text }),
  };
}

const CD = /^cd\s+("[^"]*"|'[^']*'|[^\s'"]+)$/;
const STATEFUL = /^(cd|export|source|\.|set|unset|alias|pushd|popd|exec|eval)\b/;

/**
 * `cd app && npm test` → `set -o pipefail; cd app && npm test 2>&1 | lore filter --cmd 'npm test'`
 *
 * Only simple `&&` chains are touched: anything with pipes, redirects, `;`,
 * backgrounding, subshells or newlines is left alone, since the agent may want
 * that exact output. Leading `cd`s stay outside the pipeline so they still move
 * the shell.
 */
export function rewriteCommand(command, bin = loreCommand()) {
  if (!command || /\blore\b/.test(command)) return null;
  const cmd = command.trim().replace(/\s+2>&1$/, '');
  if (/[\n|<>;&`()]/.test(cmd.replace(/&&/g, ''))) return null;
  const segs = cmd.split('&&').map((s) => s.trim());
  if (segs.some((s) => !s)) return null;
  let i = 0;
  while (i < segs.length - 1 && CD.test(segs[i])) i++;
  const prefix = segs.slice(0, i);
  const body = segs.slice(i);
  if (body.some((s) => STATEFUL.test(s)) || !body.some(isNoisyCommand)) return null;
  const inner = body.length > 1 ? `{ ${body.join(' && ')}; }` : body[0];
  const label = body.join(' && ');
  return `set -o pipefail; ${prefix.map((p) => `${p} && `).join('')}${inner} 2>&1 | ${bin} filter --cmd ${shq(label)}`;
}
