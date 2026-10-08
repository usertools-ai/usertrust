#!/usr/bin/env bash
# The agent-config check (ci.yml's `agent-config` job), run as the BASE has it.
#
# A change is never graded by its own rules. The guard (scripts/agent-config-guard.mjs)
# and its allowlist (.github/agent-config-allowlist.json) are read from the base: a pull
# request's base commit, or a push's `before`. So a change that adds agent config AND
# allowlists it, or that weakens the guard, fails until that widening has merged on its own.
# - Only the change that introduces the check runs its own copy. Its base has neither the
#   guard nor this file.
# - Once a base has this file, a base without the guard fails. It never falls back to the
#   change's copy.
# This file and ci.yml run from the change itself, as every workflow does: CODEOWNERS
# names their owner, whose review a change to either needs.
#
# Usage: agent-config.sh <base> <head>
set -euo pipefail

if [ $# -ne 2 ]; then
	echo "usage: agent-config.sh <base> <head>" >&2
	exit 2
fi
base=$1
head=$2
guard=scripts/agent-config-guard.mjs

for commit in "$base" "$head"; do
	if ! git rev-parse --verify --quiet "$commit^{commit}" >/dev/null; then
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
node "$dir/agent-config-guard.mjs" --rules "$rules" --base "$base" --head "$head"
