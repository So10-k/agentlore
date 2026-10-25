import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compress } from '../src/compress/index.js';

const fixture = (name) => fs.readFileSync(new URL(`../bench/fixtures/${name}.txt`, import.meta.url), 'utf8');
const commands = JSON.parse(fs.readFileSync(new URL('../bench/commands.json', import.meta.url), 'utf8'));
const run = (name) => compress(fixture(name), { command: commands[name] });

// What the agent must still see after compression, per real fixture.
const MUST_KEEP = {
  'jest-verbose-fail': ['FAIL tests/m7.test.js', 'FAIL tests/m23.test.js', '● module 23 › parses config', '-     4,', 'Tests:'],
  'jest-fail': ['● module 7 › parses config', 'Tests:'],
  'vitest-verbose-fail': ['× vt/u11.spec.ts > unit 11 > rounds', 'AssertionError: expected 0.30000000000000004 to be 0.3', 'Test Files'],
  'pytest-verbose-fail': ['test_m9.py::test_parse FAILED', "E   AssertionError: assert {'a': 1} == {'a': 2}", '1 failed, 375 passed'],
  'pytest-fail': ['AssertionError', '1 failed, 375 passed'],
  'tsc-errors': ['error TS2322', 'error TS2304', 'more TS2322 errors hidden'],
  'eslint-errors': ['no-var', 'eqeqeq', '384 problems'],
  'swift-test-fail': ['XCTAssertEqual failed: ("1") is not equal to ("2")', "testBroken]' failed", 'Executed 61 tests, with 1 failure'],
  'npm-install': ['added'],
};

for (const [name, needles] of Object.entries(MUST_KEEP)) {
  test(`${name}: keeps what matters`, () => {
    const r = run(name);
    for (const n of needles) assert.ok(r.text.includes(n), `missing ${JSON.stringify(n)}`);
  });
}

test('big noisy outputs shrink a lot', () => {
  for (const name of ['jest-verbose-pass', 'pytest-verbose-fail', 'swift-build-verbose', 'eslint-errors']) {
    const r = run(name);
    assert.ok(r.changed, name);
    assert.ok(r.after < r.before * 0.2, `${name}: ${r.before} → ${r.after}`);
  }
});

test('small outputs pass through untouched', () => {
  const raw = 'ok\nall good\n';
  assert.equal(compress(raw, { command: 'npm test' }).text, raw);
});

test('file contents are never trimmed', () => {
  const big = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n');
  for (const command of ['cat src/app.js', 'sed -n 1,400p src/app.js', 'git diff', 'rg foo', 'node -e "print()"', 'cd x && head -400 a.js']) {
    const r = compress(big, { command });
    assert.equal(r.changed, false, command);
    assert.equal(r.text, big);
  }
});

test('reading a test log is not mistaken for running tests', () => {
  const r = compress(fixture('jest-verbose-pass'), { command: 'cat jest.log' });
  assert.equal(r.changed, false);
});

test('mixed output keeps lines that are not tests', () => {
  const mixed = `${fixture('eslint-errors')}\n PASS  a.test.js\n PASS  b.test.js\n PASS  c.test.js\n`;
  const r = compress(mixed, { command: 'make check' });
  assert.ok(r.text.includes('no-var'));
});

test('unknown commands only get lossless-ish cleanup', () => {
  const raw = Array.from({ length: 200 }, () => 'waiting for server...').join('\n') + '\nready on :3000\n';
  const r = compress(raw, { command: './dev.sh' });
  assert.ok(r.changed);
  assert.ok(r.text.includes('ready on :3000'));
  assert.ok(r.text.includes('repeated 199 more times'));
});

test('progress bars collapse to their final state', () => {
  const raw = Array.from({ length: 100 }, (_, i) => `\rDownloading ${i}%`).join('') + '\rDownloading 100%\n' + 'x'.repeat(1200);
  const r = compress(raw, { command: './fetch.sh' });
  assert.ok(r.text.startsWith('Downloading 100%'));
});

test('footer names the full log when one is saved', () => {
  const r = compress(fixture('pytest-verbose-fail'), { command: 'pytest -v', saveLog: () => '/tmp/x.log' });
  assert.match(r.text, /\[lore: [\d,]+ → [\d,]+ tokens \(pytest\)\. Full output: \/tmp\/x\.log\]/);
});
