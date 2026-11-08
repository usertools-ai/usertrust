#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Usertools, Inc.
#
# shrinkwrap-published.sh <version> <commit>: after a release is published, checks that the registry
# serves usertrust-server and usertrust-ui with the dependency tree the release claims they ship
# (docs/releasing.md, "The shipped dependency tree"). The publish workflow runs it in its
# `shipped-tree` job, after `publish`; run it by hand with a version and its tag (v<version>).
# For each of the two, all three of these must hold:
#  1. the registry reports `_hasShrinkwrap: true` for <name>@<version>. npm honours a dependency's
#     npm-shrinkwrap.json only when that flag is set. A fresh publish can take a while to appear,
#     so the flag is polled ($SHRINKWRAP_TRIES times, $SHRINKWRAP_WAIT_S apart);
#  2. the registry's tarball (`npm pack <name>@<version>`, which npm checks against the registry's
#     integrity) carries an npm-shrinkwrap.json byte-identical to `release.sh shrinkwrap <commit>`;
#  3. a clean install by name, into an empty directory with its own cache and --ignore-scripts,
#     places the tree exactly as that shrinkwrap writes it, place by place and both ways
#     (`shrinkwrap-acceptance.mjs placed`).
# Both packages are always checked. Any failure prints ::error:: lines, writes the job summary,
# and exits 1: the release's CHANGELOG claim is then wrong and gets a correction the same day.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
VERSION=${1:?usage: shrinkwrap-published.sh <version> <commit>}
COMMIT=${2:?usage: shrinkwrap-published.sh <version> <commit>}
NPM=${SHRINKWRAP_NPM:-npm}
TRIES=${SHRINKWRAP_TRIES:-30}
WAIT_S=${SHRINKWRAP_WAIT_S:-10}
HELP="node scripts/shrinkwrap-acceptance.mjs"
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/shrinkwrap-published.XXXXXX")
bad=()

summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"; return 0; }
broken() { # broken <pkg> <why>: one failed check, reported now and in the verdict
	echo "::error::$1@$VERSION: $2"
	bad+=("$1@$VERSION: $2")
}
attempt() { # attempt <n> <command...>: the command, up to n times, 5 s apart (a registry hiccup is not a verdict)
	local n=$1 i
	shift
	for ((i = 1; i <= n; i++)); do
		"$@" && return 0
		[ "$i" -lt "$n" ] && sleep "$((WAIT_S < 5 ? WAIT_S : 5))"
	done
	return 1
}

check() { # check <dir under packages/>
	local d=$1 pkg flag i into
	pkg=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)' "packages/$d/package.json") || {
		broken "$d" "its name could not be read"
		return
	}
	# 1. The flag npm reads.
	flag=""
	for ((i = 1; i <= TRIES; i++)); do
		flag=$("$NPM" view "$pkg@$VERSION" _hasShrinkwrap 2>/dev/null) && [ "$flag" = true ] && break
		[ "$i" -lt "$TRIES" ] && sleep "$WAIT_S"
	done
	if [ "$flag" != true ]; then
		broken "$pkg" "the registry reports _hasShrinkwrap=${flag:-absent} after $TRIES tries, so npm would not install its shrinkwrap"
		return
	fi
	echo "$pkg@$VERSION: _hasShrinkwrap=true"
	# 2. The shipped file is the one the commit gives.
	if ! bash scripts/release.sh shrinkwrap "$COMMIT" "$d" "$VERSION" >"$work/$d.expected.json"; then
		broken "$pkg" "release.sh shrinkwrap $COMMIT $d $VERSION failed"
		return
	fi
	mkdir -p "$work/$d.pack"
	if ! attempt 3 bash -c 'cd "$1" && "$2" pack "$3" >/dev/null 2>"$1/pack.err"' _ "$work/$d.pack" "$NPM" "$pkg@$VERSION"; then
		broken "$pkg" "npm pack from the registry failed: $(tail -c 600 "$work/$d.pack/pack.err" | tr '\n' ' ')"
		return
	fi
	if ! tar -xOzf "$work/$d.pack/$pkg-$VERSION.tgz" package/npm-shrinkwrap.json >"$work/$d.shipped.json" 2>/dev/null; then
		broken "$pkg" "the registry's tarball carries no npm-shrinkwrap.json"
		return
	fi
	if ! cmp -s "$work/$d.shipped.json" "$work/$d.expected.json"; then
		broken "$pkg" "the registry's npm-shrinkwrap.json is not the one $COMMIT gives"
		return
	fi
	echo "$pkg@$VERSION: the registry's npm-shrinkwrap.json is the one $COMMIT gives ($(wc -c <"$work/$d.shipped.json" | tr -d ' ') bytes)"
	# 3. A user's install places it as written.
	into=$work/$d.install
	mkdir -p "$into"
	printf '{"name":"shipped-tree","private":true}\n' >"$into/package.json"
	if ! attempt 3 bash -c 'cd "$1" && "$2" install --ignore-scripts --no-audit --no-fund --cache "$1.cache" "$3" >"$1.log" 2>&1' _ "$into" "$NPM" "$pkg@$VERSION"; then
		broken "$pkg" "a clean install by name failed: $(tail -c 600 "$into.log" | tr '\n' ' ')"
		return
	fi
	local out
	if out=$($HELP placed "$into" "$pkg" "$work/$d.shipped.json"); then
		printf '%s\n' "$out"
	else
		printf '%s\n' "$out"
		broken "$pkg" "a clean install by name does not place the tree as its shrinkwrap writes it"
	fi
}

for d in server ui; do check "$d"; done

if [ "${#bad[@]}" -gt 0 ]; then
	summary "### The shipped dependency tree check FAILED for v$VERSION"
	summary ""
	for b in "${bad[@]}"; do summary "- $b"; done
	summary ""
	summary "The CHANGELOG says installs of usertrust-server and usertrust-ui get exactly the tested tree. Correct that claim today (docs/releasing.md, \"The shipped dependency tree\")."
	echo "::error::the registry does not serve the shipped tree v$VERSION claims (${#bad[@]} failed); correct the CHANGELOG claim today"
	exit 1
fi
summary "### The shipped dependency tree: usertrust-server and usertrust-ui@$VERSION are served and installed as their shrinkwraps write them"
echo "OK: usertrust-server and usertrust-ui@$VERSION are served and installed as their shrinkwraps write them"
