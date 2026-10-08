#!/usr/bin/env bash
# The agent-config check (the `agent-config` job), run as the BASE has it.
#
# A change is never graded by its own rules. The guard (scripts/agent-config-guard.mjs)
# and its allowlist (.github/agent-config-allowlist.json) are read from the base: a pull
# request's base commit, or a push's `before`. So a change that adds agent config AND
# allowlists it, or that weakens the guard, fails until that widening has merged on its own.
# - Only the change that introduces the check runs its own copy. Its base has neither the
#   guard nor this file.
# - Once a base has this file, a base without the guard fails. It never falls back to the
#   change's copy.
# A pull request is checked from where it branched; a push, tip to tip (the guard's
# `--event`).
# This file and the workflow that runs it come from the change itself, as every workflow
# does: CODEOWNERS names their owner, for the review of a change to either. As this file
# passes its own arguments to the BASE's guard, a new argument lands in the guard first, on
# its own.
#
# Usage: agent-config.sh <pull_request|push> <base> <head>
set -euo pipefail

if [ $# -ne 3 ] || { [ "$1" != pull_request ] && [ "$1" != push ]; }; then
	echo "usage: agent-config.sh <pull_request|push> <base> <head>" >&2
	exit 2
fi
event=$1
base=$2
head=$3
guard=scripts/agent-config-guard.mjs

present() { git rev-parse --verify --quiet "$1^{commit}" >/dev/null; }
for commit in "$base" "$head"; do
	# A push that rewrote the branch leaves its old tip on no ref, so a clone of every ref lacks
	# it: it is fetched once, by its sha. One that cannot be had either way cannot be checked.
	if ! present "$commit" && [[ $commit =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
		git fetch --quiet --no-tags origin "$commit" 2>/dev/null || true
	fi
	if ! present "$commit"; then
		echo "agent-config: CANNOT CHECK: $commit is not a commit here" >&2
		exit 2
	fi
done

if git cat-file -e "$base:$guard" 2>/dev/null; then
	rules=$base
elif git cat-file -e "$base:.github/agent-config.sh" 2>/dev/null; then
	echo "agent-config: FAILED: the base ($base) runs this check, but has no $guard" >&2
	exit 1
else
	rules=$head
	echo "agent-config: the base has no guard yet, so this change introduces it, and runs its own copy"
fi

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
git cat-file blob "$rules:$guard" >"$dir/agent-config-guard.mjs"
node "$dir/agent-config-guard.mjs" --event "$event" --rules "$rules" --base "$base" --head "$head"
