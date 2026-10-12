#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Usertools, Inc.
#
# The release workflow's (.github/workflows/publish.yml) shell logic, in one place so that
# every step reads the same package list and packages/core/tests/harden/release-workflow.test.ts
# can run it against a fake `npm`, `gh` and git history. See docs/releasing.md.
#
#   release.sh dirs                  the lockstep package directories, one per line, in publish order
#   release.sh version               the lockstep version; fails if the six packages disagree
#   release.sh assert-published      fails unless every <package>@<version> is on npm
#   release.sh assert-unreleased     fails if tag v<version> or any <package>@<version> already exists
#   release.sh publish [--dry-run]   publishes each package not yet on npm, with provenance
#   release.sh gate                  fails unless CI (ci.yml) passed on the commit being released
#
# Run from the repository root. Fails closed: an answer it cannot read is an error, never a pass.

set -euo pipefail

# The lockstep set, as <directory under packages/>:<npm name>, in publish order (a package
# comes after the packages it depends on). AGENTS.md lists the same six.
PACKAGES="core:usertrust verify:usertrust-verify openclaw:usertrust-openclaw server:usertrust-server acs-adapter:usertrust-acs-adapter ui:usertrust-ui"

err() { echo "::error::$*" >&2; }

dirs() {
	local entry
	for entry in $PACKAGES; do echo "${entry%%:*}"; done
}

# The version every lockstep package carries. Fails if they differ: a lockstep release
# publishes one number, and a package that drifted would publish another.
lockstep_version() {
	# SC2016: the single quotes hold JavaScript, not shell. SC2046: one argument per directory.
	# shellcheck disable=SC2016,SC2046
	node -e '
		const [first, ...rest] = process.argv.slice(1).map((dir) => ({
			dir,
			version: require(`${process.cwd()}/packages/${dir}/package.json`).version,
		}));
		for (const p of rest) {
			if (p.version !== first.version) {
				console.error(`::error::packages/${p.dir} is at ${p.version} but packages/${first.dir} is at ${first.version}; the lockstep packages must share one version.`);
				process.exit(1);
			}
		}
		if (typeof first.version !== "string" || first.version === "") {
			console.error(`::error::packages/${first.dir} has no version.`);
			process.exit(1);
		}
		console.log(first.version);
	' $(dirs)
}

# Prints "yes" if <name>@<version> is on npm and "no" if it is not. Anything else (network,
# auth, an error it does not recognise) is a failure: an unreadable registry never reads as
# "not published", because that would lead to publishing over it or skipping it blind.
registry_has() {
	local spec="$1" out rc errf
	errf=$(mktemp)
	set +e
	out=$(npm view "$spec" version 2>"$errf")
	rc=$?
	set -e
	if [ "$rc" -eq 0 ]; then
		rm -f "$errf"
		# npm prints the version when it exists; older npm exits 0 with no output for a
		# version that does not.
		if [ -n "$out" ]; then echo yes; else echo no; fi
		return 0
	fi
	if grep -q 'E404' "$errf"; then
		rm -f "$errf"
		echo no
		return 0
	fi
	err "Could not tell whether ${spec} is on npm (npm view exited ${rc}):"
	cat "$errf" >&2
	rm -f "$errf"
	return 1
}

# Before a new release bumps past the committed version, that version must be complete on npm.
# A release whose publish failed after its commit and tag were pushed leaves exactly this
# state, and bumping past it would abandon a half-published version for good.
assert_published() {
	local version entry pkg state missing=""
	version=$(lockstep_version)
	for entry in $PACKAGES; do
		pkg="${entry##*:}"
		state=$(registry_has "${pkg}@${version}") || return 1
		[ "$state" = yes ] || missing="${missing} ${pkg}@${version}"
	done
	if [ -n "$missing" ]; then
		err "The committed version ${version} is not fully on npm (missing:${missing}). Finish it first: dispatch this workflow with republish on the tag v${version}."
		return 1
	fi
	echo "${version} is on npm for all six packages."
}

assert_unreleased() {
	local version entry pkg state found=0
	version=$(lockstep_version)
	if git rev-parse -q --verify "refs/tags/v${version}" >/dev/null; then
		err "Tag v${version} already exists. Bump to a version that has not been released, or use republish to finish v${version}."
		found=1
	fi
	for entry in $PACKAGES; do
		pkg="${entry##*:}"
		state=$(registry_has "${pkg}@${version}") || return 1
		if [ "$state" = yes ]; then
			err "${pkg}@${version} is already on npm, but this repository has not recorded v${version}. Find out how it got there before releasing anything."
			found=1
		fi
	done
	[ "$found" -eq 0 ] || return 1
	echo "v${version}: no tag, and none of the six packages is on npm."
}

publish() {
	local dry="" entry dir pkg version state
	case "${1:-}" in
	--dry-run) dry="--dry-run" ;;
	"") ;;
	*)
		err "publish takes only --dry-run, not '$1'"
		return 1
		;;
	esac
	version=$(lockstep_version)
	for entry in $PACKAGES; do
		dir="${entry%%:*}"
		pkg="${entry##*:}"
		state=$(registry_has "${pkg}@${version}") || return 1
		if [ "$state" = yes ]; then
			echo "::notice::${pkg}@${version} is already on npm; skipping"
			continue
		fi
		echo "Publishing ${pkg}@${version}${dry:+ (dry run)}"
		# The same command with and without --dry-run, so a dry run exercises the real one.
		(cd "packages/${dir}" && npm publish --access public --provenance ${dry})
	done
}

# A republish runs on the release commit the workflow pushed. That push used the workflow's
# token, which does not trigger CI, so the release commit itself has no CI run. Accept it
# only if it changes nothing but the "version" field of lockstep package.json files, and
# gate on its parent: the commit CI did test, and the tree that was released apart from the
# version numbers.
release_commit_parent() {
	local version head tag_commit nparents changed f dir entry ok
	version=$(lockstep_version)
	head=$(git rev-parse HEAD)
	if ! tag_commit=$(git rev-parse -q --verify "refs/tags/v${version}^{commit}"); then
		err "Republish finishes a release that is already tagged, and tag v${version} does not exist. A version with no tag has not been released: run a normal release."
		return 1
	fi
	if [ "$tag_commit" != "$head" ]; then
		err "Tag v${version} is ${tag_commit}, but this run is on ${head}. Dispatch the republish on the tag (ref v${version}) so that what is published is what was tagged."
		return 1
	fi
	nparents=$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')
	if [ "$nparents" -ne 2 ]; then
		err "v${version} (${head}) is not a single-parent release commit."
		return 1
	fi
	changed=$(git diff --name-only HEAD^ HEAD)
	if [ -z "$changed" ]; then
		err "v${version} (${head}) changes no file; it is not a release commit."
		return 1
	fi
	for f in $changed; do
		ok=0
		for entry in $PACKAGES; do
			dir="${entry%%:*}"
			[ "$f" = "packages/${dir}/package.json" ] && ok=1
		done
		if [ "$ok" -ne 1 ]; then
			err "v${version} (${head}) changes ${f}; a release commit changes only the lockstep package.json files."
			return 1
		fi
		if ! node -e '
			const [a, b] = process.argv.slice(1).map((s) => JSON.parse(s));
			delete a.version;
			delete b.version;
			process.exit(JSON.stringify(a) === JSON.stringify(b) ? 0 : 1);
		' "$(git show "HEAD^:${f}")" "$(git show "HEAD:${f}")"; then
			err "v${version} (${head}) changes ${f} beyond its \"version\" field; a release commit changes only the version."
			return 1
		fi
	done
	git rev-parse HEAD^
}

# Requires the latest ci.yml run for a push of <sha> to have completed, and every job in it,
# and every job REQUIRED_CI_JOBS names, to have concluded success. Missing, pending,
# skipped, cancelled and failed all stop the release, and each is named.
ci_gate() {
	local sha="$1" runs run run_id url status conclusion jobs name state fail=0 required others
	: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
	# One space between names, none around them, whatever whitespace the workflow used.
	required=$(printf '%s' "${REQUIRED_CI_JOBS:-}" | tr -s '[:space:]' ' ')
	required="${required# }"
	required="${required% }"
	if [ -z "$required" ]; then
		err "REQUIRED_CI_JOBS is empty; the workflow must pin the CI jobs a release requires."
		return 1
	fi
	runs=$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100")
	run=$(printf '%s' "$runs" | jq -c '.workflow_runs | sort_by(.created_at) | last // empty')
	if [ -z "$run" ]; then
		err "CI (ci.yml) has no run for a push of ${sha}, so nothing shows it passed. Release a commit that CI ran on (a release commit pushed by this workflow has no CI run of its own)."
		return 1
	fi
	run_id=$(printf '%s' "$run" | jq -r '.id')
	url=$(printf '%s' "$run" | jq -r '.html_url')
	status=$(printf '%s' "$run" | jq -r '.status')
	conclusion=$(printf '%s' "$run" | jq -r '.conclusion // "none"')
	echo "CI run for ${sha}: ${url} (${status}, ${conclusion})"
	jobs=$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?filter=latest&per_page=100")
	for name in $required; do
		state=$(printf '%s' "$jobs" | jq -r --arg n "$name" '
			[.jobs[] | select(.name == $n)]
			| if length == 0 then "missing"
			  elif length > 1 then "ambiguous (\(length) jobs share the name)"
			  elif .[0].status != "completed" then "pending (\(.[0].status))"
			  else (.[0].conclusion // "none") end')
		if [ "$state" = success ]; then
			echo "  ok  ${name}"
		else
			err "Required CI check '${name}' on ${sha} is ${state}, not success. ${url}"
			fail=1
		fi
	done
	# A job the list does not name must still pass; the list should name it.
	others=$(printf '%s' "$jobs" | jq -r --arg req " ${required} " '
		.jobs[] | select(.name as $n | ($req | contains(" " + $n + " ")) | not)
		| "\(.name)\t\(if .status != "completed" then "pending (\(.status))" else (.conclusion // "none") end)"')
	if [ -n "$others" ]; then
		while IFS="$(printf '\t')" read -r name state; do
			if [ "$state" = success ]; then
				echo "::warning::CI job '${name}' passed but is not in REQUIRED_CI_JOBS; add it there (and to the test that pins the list)."
			else
				err "CI job '${name}' on ${sha} is ${state}, not success (it is not in REQUIRED_CI_JOBS, but it still must pass). ${url}"
				fail=1
			fi
		done <<EOF
${others}
EOF
	fi
	if [ "$status" != completed ]; then
		err "CI run ${url} on ${sha} is ${status}; wait for it to finish."
		fail=1
	elif [ "$conclusion" != success ]; then
		err "CI run ${url} on ${sha} concluded ${conclusion}, not success."
		fail=1
	fi
	[ "$fail" -eq 0 ] || return 1
	echo "CI passed on ${sha}."
}

gate() {
	local sha
	if [ "${REPUBLISH:-}" = true ]; then
		sha=$(release_commit_parent)
		echo "Republish of $(git rev-parse HEAD): gating on its parent ${sha}, the commit CI tested."
	else
		sha=$(git rev-parse HEAD)
	fi
	ci_gate "$sha"
}

case "${1:-}" in
dirs) dirs ;;
version) lockstep_version ;;
assert-published) assert_published ;;
assert-unreleased) assert_unreleased ;;
publish) publish "${2:-}" ;;
gate) gate ;;
*)
	err "usage: release.sh dirs | version | assert-published | assert-unreleased | publish [--dry-run] | gate"
	exit 2
	;;
esac
