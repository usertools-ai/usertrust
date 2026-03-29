#!/usr/bin/env bash
set -euo pipefail

# preflight.sh — Local pre-flight validation for usertrust.
# Catches errors before CI to save GH Actions minutes.
#
# Usage:
#   scripts/preflight.sh          # Fast checks only (~5s)
#   scripts/preflight.sh --full   # Fast + typecheck + lint + test (~60s)

MODE="${1:-fast}"
PASS=0
FAIL=0
WARN=0

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠ $1"; WARN=$((WARN + 1)); }

echo "=== usertrust pre-flight checks ==="
echo ""

# --- Required files ---
echo "Required files:"
for f in \
  packages/core/package.json \
  packages/verify/package.json \
  packages/core/tsconfig.json \
  packages/verify/tsconfig.json \
  tsconfig.base.json \
  vitest.config.ts \
  biome.json \
  .github/workflows/ci.yml \
  .github/workflows/codex-review.yml \
  .github/workflows/publish.yml \
  CLAUDE.md
do
  if [[ -f "$f" ]]; then
    pass "$f"
  else
    fail "$f missing"
  fi
done

echo ""

# --- YAML syntax (workflows) ---
echo "Workflow YAML syntax:"
if ! command -v python3 &> /dev/null || ! python3 -c "import yaml" 2>/dev/null; then
  warn "python3 + PyYAML not available — skipping YAML validation"
else
  for f in .github/workflows/*.yml; do
    if python3 -c "import yaml; yaml.safe_load(open('$f'))" 2>/dev/null; then
      pass "$(basename "$f")"
    else
      fail "$(basename "$f") — invalid YAML"
    fi
  done
fi

echo ""

# --- Package versions in sync ---
echo "Package version sync:"
CORE_VER=$(node -p 'require("./packages/core/package.json").version' 2>/dev/null || echo "?")
VERIFY_VER=$(node -p 'require("./packages/verify/package.json").version' 2>/dev/null || echo "?")
if [[ "$CORE_VER" == "$VERIFY_VER" ]]; then
  pass "core ($CORE_VER) == verify ($VERIFY_VER)"
else
  fail "core ($CORE_VER) != verify ($VERIFY_VER) — versions must match"
fi

echo ""

# --- Zero-dep verify check ---
echo "Zero-dep verify:"
VERIFY_DEPS=$(node -p 'Object.keys(require("./packages/verify/package.json").dependencies || {}).length' 2>/dev/null || echo "?")
if [[ "$VERIFY_DEPS" == "0" ]]; then
  pass "usertrust-verify has 0 dependencies"
else
  fail "usertrust-verify has $VERIFY_DEPS dependencies — must be zero"
fi

echo ""

# --- Biome config ---
echo "Biome config:"
INDENT=$(node -p 'require("./biome.json").formatter.indentStyle' 2>/dev/null || echo "?")
WIDTH=$(node -p 'require("./biome.json").formatter.lineWidth' 2>/dev/null || echo "?")
if [[ "$INDENT" == "tab" ]]; then
  pass "indent: tab"
else
  fail "indent: $INDENT (expected tab)"
fi
if [[ "$WIDTH" == "100" ]]; then
  pass "lineWidth: 100"
else
  fail "lineWidth: $WIDTH (expected 100)"
fi

echo ""

# --- Full mode ---
if [[ "$MODE" == "--full" ]]; then
  echo "Typecheck:"
  if npx tsc -b --noEmit 2>/dev/null; then
    pass "tsc -b --noEmit"
  else
    fail "typecheck failed"
  fi

  echo ""
  echo "Lint:"
  if npx biome check . 2>/dev/null; then
    pass "biome check"
  else
    fail "lint failed"
  fi

  echo ""
  echo "Tests:"
  if npx vitest run 2>/dev/null; then
    pass "vitest run"
  else
    fail "tests failed"
  fi

  echo ""
fi

# --- Summary ---
echo "=== Summary ==="
echo "  ✓ $PASS passed"
[[ $WARN -gt 0 ]] && echo "  ⚠ $WARN warnings"
[[ $FAIL -gt 0 ]] && echo "  ✗ $FAIL failed"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "Pre-flight FAILED — fix issues before pushing."
  exit 1
else
  echo ""
  echo "Pre-flight PASSED."
  exit 0
fi
