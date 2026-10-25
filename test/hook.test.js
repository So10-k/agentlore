import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rewriteCommand } from '../src/compress/hook.js';

const BIN = fileURLToPath(new URL('../bin/lore.js', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-test-'));

function hook(payload) {
  const r = spawnSync(process.execPath, [BIN, 'hook'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, AGENTLORE_HOME: home, AGENTLORE_BIN: 'lore' },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('rewrites noisy commands to pipe through the filter', () => {
  assert.equal(rewriteCommand('npm test', 'lore'), "set -o pipefail; npm test 2>&1 | lore filter --cmd 'npm test'");
  assert.equal(
    rewriteCommand('cd "my app" && pytest -x', 'lore'),
    `set -o pipefail; cd "my app" && pytest -x 2>&1 | lore filter --cmd 'pytest -x'`,
  );
  assert.equal(
    rewriteCommand('npm run build && npm test', 'lore'),
    "set -o pipefail; { npm run build && npm test; } 2>&1 | lore filter --cmd 'npm run build && npm test'",
  );
  assert.equal(rewriteCommand("pytest -k 'it''s'", 'lore'), `set -o pipefail; pytest -k 'it''s' 2>&1 | lore filter --cmd 'pytest -k '\\''it'\\'''\\''s'\\'''`);
});

test('leaves everything else alone', () => {
  for (const cmd of [
    'cat package.json',
    'git status',
    'npm test | tail -5',
    'npm test > out.log',
    'npm test; echo done',
    'npm test &',
    'export CI=1 && npm test',
    'echo $(npm test)',
    'npm test\nnpm run lint',
    'lore filter',
    '',
  ]) {
    assert.equal(rewriteCommand(cmd, 'lore'), null, JSON.stringify(cmd));
  }
});

test('a rewritten command keeps its exit status and shrinks its output', () => {
  const script = path.join(home, 'noisy.js');
  fs.writeFileSync(script, `for (let i = 0; i < 300; i++) console.log(' PASS  t' + i + '.test.js');\nconsole.log(' FAIL  bad.test.js\\nTests: 1 failed, 300 passed');\nprocess.exit(3);\n`);
  const shim = path.join(home, 'lore');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  const cmd = rewriteCommand(`npm test`, shim).replace('npm test 2>&1', `node ${script} 2>&1`);
  const r = spawnSync('/bin/bash', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, AGENTLORE_HOME: home } });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /300 passing suites hidden/);
  assert.match(r.stdout, /FAIL {2}bad\.test\.js/);
});

test('PreToolUse returns updatedInput and no permission decision', () => {
  const out = hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cargo test', description: 'x', timeout: 5000 } });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.deepEqual(Object.keys(out.hookSpecificOutput.updatedInput).sort(), ['command', 'description', 'timeout']);
  assert.match(out.hookSpecificOutput.updatedInput.command, /cargo test 2>&1 \| lore filter/);
});

test('PreToolUse skips background commands', () => {
  assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } }), null);
});

test('PostToolUse replaces noisy stdout and keeps the output shape', () => {
  const stdout = Array.from({ length: 300 }, (_, i) => ` PASS  tests/m${i}.test.js`).join('\n') + '\nTests: 300 passed\n';
  const tool_response = { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
  const out = hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make test' }, tool_response });
  const replaced = out.hookSpecificOutput.updatedToolOutput;
  assert.deepEqual(Object.keys(replaced).sort(), Object.keys(tool_response).sort());
  assert.match(replaced.stdout, /300 passing suites hidden/);
  assert.match(replaced.stdout, /Full output: .*\.log/);
  const log = replaced.stdout.match(/Full output: (.*\.log)/)[1];
  assert.equal(fs.readFileSync(log, 'utf8'), stdout);
});

test('PostToolUse ignores small output, file reads and other tools', () => {
  const r = { stdout: 'hi\n', stderr: '', interrupted: false, isImage: false };
  assert.equal(hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: r }), null);
  const big = { ...r, stdout: 'x\n'.repeat(5000) };
  assert.equal(hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat big.txt' }, tool_response: big }), null);
  assert.equal(hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: big }), null);
});
