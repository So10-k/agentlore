#!/usr/bin/env bash
# Produce real outputs from real tools, so the benchmark isn't graded on
# outputs we wrote ourselves. Usage: bench/make-fixtures.sh [workdir]
# Needs node/npm; python3 and swift are used when present.
set -u
OUT="$(cd "$(dirname "$0")" && pwd)/fixtures"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$OUT" "$WORK"
cd "$WORK" || exit 1
echo "working in $WORK"

# ---- JavaScript ------------------------------------------------------------
mkdir -p js && cd js
npm init -y >/dev/null
npm install --no-fund jest@29 vitest@2 typescript@5 eslint@8 >"$OUT/npm-install.txt" 2>&1
# Older packages with deprecation warnings, like a real project upgrade.
npm install --no-fund request@2 gulp@4 >"$OUT/npm-install-deprecated.txt" 2>&1

mkdir -p tests
for i in $(seq 1 40); do
  {
    echo "describe('module $i', () => {"
    for j in $(seq 1 12); do echo "  test('case $j', () => { expect($i + $j).toBe($((i + j))); });"; done
    if [ "$i" = 7 ] || [ "$i" = 23 ]; then
      echo "  test('parses config', () => { expect({ a: 1, b: [1, 2, 3] }).toEqual({ a: 1, b: [1, 2, 4] }); });"
    fi
    echo "});"
  } >"tests/m$i.test.js"
done
npx jest --verbose >"$OUT/jest-verbose-fail.txt" 2>&1
npx jest >"$OUT/jest-fail.txt" 2>&1
sed -i.bak 's/b: \[1, 2, 4\]/b: [1, 2, 3]/' tests/*.test.js && rm tests/*.bak
npx jest --verbose >"$OUT/jest-verbose-pass.txt" 2>&1
npx jest --coverage >"$OUT/jest-coverage.txt" 2>&1

mkdir -p vt
for i in $(seq 1 30); do
  {
    echo "import { describe, test, expect } from 'vitest';"
    echo "describe('unit $i', () => {"
    for j in $(seq 1 10); do echo "  test('works $j', () => { expect($j).toBeGreaterThan(0); });"; done
    [ "$i" = 11 ] && echo "  test('rounds', () => { expect(0.1 + 0.2).toBe(0.3); });"
    echo "});"
  } >"vt/u$i.spec.ts"
done
npx vitest run --reporter=verbose --dir vt >"$OUT/vitest-verbose-fail.txt" 2>&1

{
  echo "export function f(a: number): string {"
  for i in $(seq 1 40); do echo "  const v$i: string = $i;"; done
  for i in $(seq 1 20); do echo "  missing$i();"; done
  echo "  return a;"
  echo "}"
} >bad.ts
npx tsc --noEmit --strict bad.ts >"$OUT/tsc-errors.txt" 2>&1

cat >.eslintrc.json <<'EOF'
{ "root": true, "parserOptions": { "ecmaVersion": 2022, "sourceType": "module" },
  "rules": { "no-unused-vars": "error", "no-var": "error", "eqeqeq": "error", "semi": ["error", "always"], "quotes": ["error", "single"] } }
EOF
mkdir -p src
for i in $(seq 1 12); do
  { for j in $(seq 1 8); do echo "var x$j = \"v$j\""; echo "if (x$j == 'a') {}"; done; } >"src/f$i.js"
done
npx eslint src >"$OUT/eslint-errors.txt" 2>&1
cd ..

# ---- Python ------------------------------------------------------------------
if command -v python3 >/dev/null; then
  python3 -m venv venv && ./venv/bin/pip install pytest requests flask >"$OUT/pip-install.txt" 2>&1
  mkdir -p py && cd py
  for i in $(seq 1 25); do
    {
      echo "import pytest"
      for j in $(seq 1 15); do echo "def test_case_$j(): assert $j + $i == $((i + j))"; done
      [ "$i" = 9 ] && echo "def test_parse(): assert {'a': 1} == {'a': 2}"
    } >"test_m$i.py"
  done
  ../venv/bin/pytest -v >"$OUT/pytest-verbose-fail.txt" 2>&1
  ../venv/bin/pytest >"$OUT/pytest-fail.txt" 2>&1
  cd ..
fi

# ---- Swift ---------------------------------------------------------------------
if command -v swift >/dev/null; then
  mkdir -p Demo && cd Demo
  swift package init --type library --name Demo >/dev/null 2>&1
  mkdir -p Tests/DemoTests
  {
    echo "import XCTest"
    echo "@testable import Demo"
    echo "final class DemoTests: XCTestCase {"
    for j in $(seq 1 60); do echo "  func testCase$j() { XCTAssertEqual($j, $j) }"; done
    echo "  func testBroken() { XCTAssertEqual(1, 2) }"
    echo "}"
  } >Tests/DemoTests/DemoTests.swift
  swift build -v >"$OUT/swift-build-verbose.txt" 2>&1
  swift test >"$OUT/swift-test-fail.txt" 2>&1
  cd ..
fi

ls -la "$OUT"
