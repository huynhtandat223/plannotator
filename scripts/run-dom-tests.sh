#!/usr/bin/env bash
# Runs every DOM-gated test file with the happy-dom preload enabled.
#
# DOM-gated tests self-skip under plain `bun test` (via a `hasDom` guard on
# `typeof document`), so they only execute when DOM_TESTS=1 activates the
# happy-dom preload (see packages/ui/test-setup/happy-dom.ts). CI used to keep
# a hard-coded file list, and new DOM-gated files were repeatedly forgotten —
# never executing anywhere (upstream fixed 5 such orphans in 8350299; a later
# audit found 18 more). Discovering the batch by grepping for the guard makes
# that class of gap structurally impossible: write `const hasDom = typeof
# document !== 'undefined'` in a test file and it is automatically included.
set -euo pipefail
cd "$(dirname "$0")/.."

mapfile -t files < <(grep -rl "hasDom" --include='*.test.ts' --include='*.test.tsx' packages apps | sort)

if (( ${#files[@]} < 20 )); then
  echo "Only ${#files[@]} DOM-gated test files found — the hasDom glob looks broken (expected 30+)." >&2
  exit 1
fi

echo "Running ${#files[@]} DOM-gated test files"
DOM_TESTS=1 exec bun test "${files[@]}"
