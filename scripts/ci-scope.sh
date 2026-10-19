#!/usr/bin/env bash
# ci-scope — decide whether the CI gate runs in full or skips a docs-only PR.
#
# Called by the Scope step in .github/workflows/ci.yml from the checked-out
# PR merge commit (fetch-depth: 2). Writes scope=full|docs-only and
# run=true|false to $GITHUB_OUTPUT. Reads GITHUB_EVENT_NAME.
#
# The rule (see the comment on the Scope step for why docs are not inert):
# a pull_request skips only when EVERY changed path is docs/** or a
# top-level *.md AND no changed file's basename appears in code, tests,
# scripts or workflows. Every other event, and any error, means FULL.
#
# ERREXIT. GitHub runs `shell: bash` as `bash --noprofile --norc -eo
# pipefail`, and this file sets the same flags itself, so every command
# whose non-zero status is an ANSWER rather than a failure (git grep with no
# match exits 1) is evaluated inside an `if`. The first version captured
# `rc=$?` on the next line; under -e the shell exited on the no-match
# before reaching it, so the docs-only branch could never report (TARS
# R323-1). scripts/ci-scope.test.mjs runs this under the runner's flags.
set -euo pipefail

out="${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"
event="${GITHUB_EVENT_NAME:-}"

full() {
  echo "scope=full" >> "$out"
  echo "run=true" >> "$out"
  echo "Scope: FULL. $1"
  exit 0
}

if [ "$event" != "pull_request" ]; then
  full "Event '$event' always runs everything."
fi

# --no-renames: a rename must list the OLD path too, or moving a doc a test
# reads would look like adding an unreferenced doc.
if ! files=$(git diff --no-renames --name-only HEAD^1 HEAD); then
  full "Could not compute the changed files."
fi
[ -n "$files" ] || full "Empty change list (unexpected)."
echo "Changed files:"
printf '%s\n' "$files" | sed 's/^/  /'

CODE_PATHS=(client client-diocese server scripts api tools .github vercel.json package.json)
while IFS= read -r f; do
  # docs/** or a top-level *.md only. A .md inside client/, server/ etc.
  # counts as code.
  if ! [[ "$f" =~ ^docs/ || "$f" =~ ^[^/]+\.md$ ]]; then
    full "Not a docs file: $f"
  fi
  b=$(basename "$f")
  rc=0
  git grep -qF -- "$b" -- "${CODE_PATHS[@]}" || rc=$?
  if [ "$rc" -eq 0 ]; then
    where=$(git grep -lF -- "$b" -- "${CODE_PATHS[@]}" 2>/dev/null | sed -n '1,3p' | tr '\n' ' ' || true)
    full "$f is named in code/tests: $where"
  elif [ "$rc" -ne 1 ]; then
    full "git grep failed for $f (exit $rc)."
  fi
  # rc == 1: no reference anywhere; keep checking the next file.
done <<< "$files"

echo "scope=docs-only" >> "$out"
echo "run=false" >> "$out"
echo "Scope: DOCS-ONLY. Every change is an unreferenced doc; tests, lints and builds are skipped."
