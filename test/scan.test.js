import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan } from '../src/scan/index.js';
import { commandKey } from '../src/scan/analyze.js';
import { renderReport } from '../src/scan/report.js';
import { redact } from '../src/util/redact.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-scan-'));
const write = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

// A small Claude Code session: 5 requests, a compaction after the 3rd.
let n = 0;
const usage = (cacheRead) => ({ input_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 5 });
const assistant = (content, cacheRead = 1000) => ({ type: 'assistant', cwd: '/proj', timestamp: '2026-10-01T00:00:00Z', message: { id: `msg${++n}`, usage: usage(cacheRead), content } });
const result = (id, content, extra = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });
const noisy = Array.from({ length: 200 }, (_, i) => ` PASS  tests/m${i}.test.js`).join('\n') + '\nTests: 200 passed';

write(path.join(tmp, 'claude/proj/s1.jsonl'), [
  assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd app && npm test' } }]),
  result('t1', noisy),
  assistant([{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/proj/package-lock.json' } }]),
  result('t2', 'x'.repeat(4000)),
  assistant([{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/proj/package-lock.json' } }]),
  { type: 'system', subtype: 'compact_boundary' },
  result('t3', 'x'.repeat(4000)),
  assistant([{ type: 'text', text: 'done' }]),
  assistant([{ type: 'text', text: 'really done' }]),
  // A streamed message repeats its usage on every content line: count it once.
  { ...assistant([{ type: 'text', text: 'dup' }]), message: { id: 'msg1', usage: usage(1000), content: [] } },
]);

write(path.join(tmp, 'codex/2026/10/01/rollout-a.jsonl'), [
  { type: 'session_meta', payload: { cwd: '/proj2' } },
  { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'pytest -v' }) } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'test_x.py::test_a PASSED\n'.repeat(300) } },
  { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 }, last_token_usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 20 } } } },
  { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 }, last_token_usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 20 } } } },
]);

const dirs = { claudeDir: path.join(tmp, 'claude'), codexDir: path.join(tmp, 'codex'), days: 0 };

test('counts requests once and tool output as it was re-sent', async () => {
  const a = await scan(dirs);
  assert.equal(a.sessions, 2);
  assert.equal(a.calls, 5 + 1); // claude: 5 unique message ids; codex: duplicate count skipped
  const bash = a.byTool.get('Bash / shell');
  assert.equal(bash.calls, 2);
  // npm test's result arrived after request 1, rode along in requests 2 and 3,
  // then the compaction dropped it.
  const npm = a.commands.get('npm test');
  assert.equal(npm.carried, npm.tokens * 2);
  assert.ok(a.commands.has('pytest'));
});

test('finds re-reads, generated files and stops carrying at a compaction', async () => {
  const a = await scan(dirs);
  assert.equal(a.rereads.count, 1);
  assert.equal(a.generated.count, 2);
  // The second read landed after the compaction boundary was written, so the
  // first read's carry stops at request 3 (it arrived after request 2).
  assert.equal(a.generated.carried, 1000 * 1 + 1000 * 2);
});

test('simulates the compressor on recorded shell output', async () => {
  const a = await scan(dirs);
  assert.ok(a.sim.after < a.sim.before * 0.3);
});

test('report renders and filters by project', async () => {
  const text = renderReport(await scan(dirs));
  assert.match(text, /where your tokens went/);
  assert.match(text, /npm test/);
  const only = await scan({ ...dirs, project: 'proj2' });
  assert.equal(only.sessions, 1);
});

test('commandKey groups by what actually ran', () => {
  assert.equal(commandKey('cd app && FOO=1 npm run test -- -u'), 'npm run test');
  assert.equal(commandKey('K=abc; curl -s https://x | jq .'), 'curl');
  assert.equal(commandKey('npx tsc --noEmit'), 'npx tsc');
  assert.equal(commandKey('python3 -m pytest -q'), 'python3 -m pytest');
  assert.equal(commandKey('/usr/local/bin/git status'), 'git status');
  assert.equal(commandKey('# note\nls -la'), 'ls');
});

// Fake keys are assembled at runtime so no secret-shaped string sits in the source.
const fakeKey = (prefix, n) => prefix + '0'.repeat(n);

test('redacts secrets before anything is printed', () => {
  assert.equal(redact(`curl -H "xi-api-key: $K" K=${fakeKey('sk_', 32)}`), 'curl -H "xi-api-key: $K" K=[redacted]');
  assert.equal(redact(`export GITHUB_TOKEN=${fakeKey('ghp_', 36)}`), 'export [redacted]');  assert.equal(redact('Authorization: Bearer abcdefghijklmnopqrstuvwx'), 'Authorization: [redacted]');
  assert.equal(redact('npm test'), 'npm test');
});
