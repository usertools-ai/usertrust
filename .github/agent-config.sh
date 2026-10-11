#!/usr/bin/env bash
# The agent-config check (the `agent-config` job), run as the BASE has it.
#
# What is checked is what will land:
# - A pull request: the merge commit GitHub tests (`github.sha`, refs/pull/N/merge), against
#   its first parent, the base it was made on. The branch's head is not what lands: when
#   both sides edit a pinned file, git merges them into content neither side's check read.
# - A push: tip to tip, from `before` to `after`.
#
# A change is never graded by its own rules. The guard (scripts/agent-config-guard.mjs)
# and its allowlist (.github/agent-config-allowlist.json) are read from the base: the merge
# commit's first parent, or a push's `before`. So a change that adds agent config AND
# allowlists it, or that weakens the guard, fails until that widening has merged on its own.
# - Only the change that introduces the check runs its own copy. Its base has neither the
#   guard nor this file.
# - Once a base has this file, a base without the guard fails. It never falls back to the
#   change's copy.
# This file and the workflow that runs it come from the change itself, as every workflow
# does: CODEOWNERS names their owner, for the review of a change to either. As this file
# passes its own arguments to the BASE's guard, a new argument lands in the guard first, on
# its own.
#
# The guard's verdict is its exit code AND its own last word. An exit 0 counts only when the
# guard's last line is its `agent-config: OK (...)` summary, so a guard that exits 0 without
# running (a stub, a module that returns early) fails; any other exit passes through. As with
# its arguments, a change to that line's form lands here first, on its own.
#
# Usage: agent-config.sh pull_request <merge-commit>
#        agent-config.sh push <before> <after>
set -euo pipefail

usage() {
	echo "usage: agent-config.sh pull_request <merge-commit> | push <before> <after>" >&2
	exit 2
}
event=${1:-}
case $event in
pull_request) [ $# -eq 2 ] || usage ;;
push) [ $# -eq 3 ] || usage ;;
*) usage ;;
esac
guard=scripts/agent-config-guard.mjs

present() { git rev-parse --verify --quiet "$1^{commit}" >/dev/null; }

# A commit that must be here. A push that rewrote the branch leaves its old tip on no ref, so a
# clone of every ref lacks it: it is fetched once, by its sha. One that cannot be had either way
# cannot be checked.
need() {
	if ! present "$1" && [[ $1 =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
		git fetch --quiet --no-tags origin "$1" 2>/dev/null || true
	fi
	if ! present "$1"; then
		echo "agent-config: CANNOT CHECK: $1 is not a commit here" >&2
		exit 2
	fi
}

if [ "$event" = pull_request ]; then
	head=$2
	need "$head"
	if ! present "$head^2"; then
		echo "agent-config: CANNOT CHECK: $head is not a merge commit; a pull request is checked as the merge commit GitHub tests" >&2
		exit 2
	fi
	if ! base=$(git rev-parse --verify --quiet "$head^1^{commit}"); then
		echo "agent-config: CANNOT CHECK: the base of $head is not a commit here" >&2
		exit 2
	fi
else
	base=$2
	head=$3
	need "$base"
	need "$head"
fi

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
status=0
out=$(node "$dir/agent-config-guard.mjs" --event "$event" --rules "$rules" --base "$base" --head "$head") || status=$?
printf '%s\n' "$out"
if [ "$status" -ne 0 ]; then
	exit "$status"
fi
ok='^agent-config: OK \([0-9]+ paths changed, [0-9]+ of them agent config; [0-9]+ settings files in the tree\)$'
if [[ ! ${out##*$'\n'} =~ $ok ]]; then
	echo "agent-config: FAILED: the guard exited 0 without its OK line, so it did not say it checked" >&2
	exit 1
fi
