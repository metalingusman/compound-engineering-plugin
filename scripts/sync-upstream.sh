#!/usr/bin/env bash
#
# sync-upstream.sh — Rebase this fork's main onto the latest upstream
# `compound-engineering-vX.Y.Z` tag and verify the Warp target still works.
#
# This is the canonical hygiene step for keeping the metalingusman fork in
# sync with EveryInc's main without inheriting churn between releases.
# Pinning to upstream tags (not main) limits the rebase surface to stable
# release boundaries and makes test failures easier to bisect.
#
# Workflow:
#   1. Ensure an `upstream` remote exists pointing at EveryInc.
#   2. Fetch upstream tags.
#   3. Pick the latest `compound-engineering-vX.Y.Z` tag by version sort.
#   4. Rebase local main onto that tag.
#   5. Run `bun test` and the Warp conversion smoke test.
#   6. Print next-step guidance — but never push or force-push for the
#      operator. Pushing is a deliberate decision that should not be
#      automated by this script.
#
# Usage:
#   bun run sync:upstream   # via package.json wrapper
#   ./scripts/sync-upstream.sh
#
# Exit codes:
#   0  success — fork is rebased onto latest upstream tag and tests pass
#   1  any failure during fetch, rebase, test, or conversion smoke

set -euo pipefail

UPSTREAM_NAME="upstream"
UPSTREAM_URL="https://github.com/EveryInc/compound-engineering-plugin.git"
TAG_PREFIX="compound-engineering-v"
SMOKE_OUTPUT_DIR="/tmp/warp-sync-smoke-$$"

cleanup() {
  if [[ -d "${SMOKE_OUTPUT_DIR}" ]]; then
    rm -rf "${SMOKE_OUTPUT_DIR}"
  fi
}
trap cleanup EXIT

# 1. Ensure upstream remote exists. We do not change an existing one — if a
# user has pointed `upstream` at a different URL on purpose, surface that
# rather than silently rewriting it.
if ! git remote get-url "${UPSTREAM_NAME}" >/dev/null 2>&1; then
  echo "Adding upstream remote: ${UPSTREAM_NAME} -> ${UPSTREAM_URL}"
  git remote add "${UPSTREAM_NAME}" "${UPSTREAM_URL}"
else
  current_url=$(git remote get-url "${UPSTREAM_NAME}")
  if [[ "${current_url}" != "${UPSTREAM_URL}" ]]; then
    echo "Note: upstream remote already exists with URL: ${current_url}"
    echo "Expected: ${UPSTREAM_URL}"
    echo "Continuing with the existing URL. Adjust manually if this is wrong."
  fi
fi

# 2. Fetch upstream tags.
echo "Fetching upstream tags from ${UPSTREAM_NAME}..."
git fetch "${UPSTREAM_NAME}" --tags --quiet

# 3. Pick the latest compound-engineering-v* tag. Use `sort -V` for proper
# semver ordering across major bumps (v3.9.0 < v3.10.0).
latest_tag=$(git tag --list "${TAG_PREFIX}*" | sort -V | tail -1)
if [[ -z "${latest_tag}" ]]; then
  echo "ERROR: No ${TAG_PREFIX}* tags found. Has the upstream fetch succeeded?" >&2
  exit 1
fi
echo "Latest upstream tag: ${latest_tag}"

# Bail early if we are already on or ahead of the latest tag.
if git merge-base --is-ancestor "${latest_tag}" HEAD; then
  echo "Already at or ahead of ${latest_tag}. Nothing to do."
  exit 0
fi

# 4. Confirm the working tree is clean before rebasing — a rebase against
# an unstable tree is the single fastest way to lose work.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Working tree is not clean. Commit or stash changes before syncing." >&2
  exit 1
fi

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "${current_branch}" != "main" ]]; then
  echo "ERROR: sync-upstream.sh expects to run on main (current: ${current_branch})." >&2
  exit 1
fi

echo "Rebasing main onto ${latest_tag}..."
git rebase "${latest_tag}"

# 5. Validate. Test failures here usually mean upstream introduced a change
# that conflicts with the Warp target's expectations — investigate before
# pushing.
echo "Running bun test..."
bun test

echo "Running Warp conversion smoke test..."
mkdir -p "${SMOKE_OUTPUT_DIR}"
bun run src/index.ts convert plugins/compound-engineering --to warp --output "${SMOKE_OUTPUT_DIR}" >/dev/null

# Sanity-check the smoke output: the install must produce both a SKILL.md
# for ce-plan (the most commonly invoked skill) and the AGENTS.md merge.
if [[ ! -f "${SMOKE_OUTPUT_DIR}/.warp/skills/ce-plan/SKILL.md" ]]; then
  echo "ERROR: Smoke test did not produce ce-plan SKILL.md at ${SMOKE_OUTPUT_DIR}." >&2
  exit 1
fi
if [[ ! -f "${SMOKE_OUTPUT_DIR}/AGENTS.md" ]]; then
  echo "ERROR: Smoke test did not produce AGENTS.md at ${SMOKE_OUTPUT_DIR}." >&2
  exit 1
fi

echo ""
echo "Sync complete."
echo "  - Rebased onto ${latest_tag}"
echo "  - bun test: passed"
echo "  - Warp conversion smoke: passed"
echo ""
echo "Next steps (manual, deliberate):"
echo "  - Review the rebase: git --no-pager log --oneline ${latest_tag}..HEAD"
echo "  - Push when satisfied: git push --force-with-lease origin main"
echo "  - The --force-with-lease is necessary because rebase rewrites history;"
echo "    --force-with-lease prevents clobbering an unexpected remote update."
