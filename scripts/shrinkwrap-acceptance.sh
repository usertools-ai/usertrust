#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Usertools, Inc.
#
# CI's check of the shipped dependency tree (docs/releasing.md, "The shipped dependency tree").
# Run from the repository root after `npm ci` and a build of core, verify, server and ui. It needs
# the registry: it installs what it assembles, as a user would.
#
#  1. Reproduce: packs server and ui, assembles them as the release does (`release.sh assemble`),
#     and requires each tarball's npm-shrinkwrap.json to be byte-identical to `release.sh shrinkwrap`
#     at this commit.
#  2. Accept: installs both assembled tarballs into an empty directory with --ignore-scripts, and
#     requires every third-party package installed to be a version the root lockfile holds.
#  3. Control: moves one third-party entry of server's shrinkwrap to another published version
#     that its requirer accepts, installs again, and requires step 2's check to FAIL on exactly
#     that package. This proves npm installs a dependency's shrinkwrap as written, so step 2 did
#     not pass only because the registry's newest versions happen to be the locked ones.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
HELP=scripts/shrinkwrap-acceptance.mjs
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/shrinkwrap-acceptance.XXXXXX")
version=$(bash scripts/release.sh version)
fail() {
	echo "::error::$*" >&2
	exit 1
}

mkdir -p "$work/packed"
for d in server ui; do
	(cd "packages/$d" && npm pack --ignore-scripts --pack-destination "$work/packed" >/dev/null)
done
bash scripts/release.sh assemble "$work/packed" HEAD "$work/assembled" server ui
server="$work/assembled/server/usertrust-server-${version}.tgz"
ui="$work/assembled/ui/usertrust-ui-${version}.tgz"

echo "== 1. the shipped shrinkwrap is the one the commit gives"
for d in server ui; do
	tgz="$work/assembled/$d/usertrust-$d-${version}.tgz"
	tar -xOzf "$tgz" package/npm-shrinkwrap.json >"$work/$d.shipped.json"
	bash scripts/release.sh shrinkwrap HEAD "$d" "$version" >"$work/$d.generated.json"
	cmp "$work/$d.shipped.json" "$work/$d.generated.json" || fail "$d's shipped npm-shrinkwrap.json is not the one HEAD gives"
	echo "$d: reproduced ($(wc -c <"$work/$d.shipped.json" | tr -d ' ') bytes)"
done

install_into() { # install_into <dir> <tarball>...: a user's install, in an empty directory
	local into=$1
	shift
	mkdir -p "$into"
	printf '{"name":"acceptance","private":true}\n' >"$into/package.json"
	(cd "$into" && npm install --ignore-scripts --no-audit --no-fund "$@" >"$into.log" 2>&1) ||
		fail "npm install failed: $(tail -c 2000 "$into.log")"
}

echo "== 2. an install gets exactly the tested tree"
install_into "$work/install" "$server" "$ui"
node "$HELP" installed package-lock.json "$work/install" || fail "an install of the assembled tarballs is not the tested tree"

echo "== 3. control: a moved shrinkwrap entry must make step 2 fail"
picked=""
while read -r place name range; do
	[ -n "$place" ] || continue
	locked=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).packages;console.log(p[process.argv[2]].version)' "$work/server.shipped.json" "$place")
	alt=$(npm view "${name}@${range}" version --json 2>/dev/null |
		node -e 'let v=JSON.parse(require("fs").readFileSync(0,"utf8")||"[]");v=Array.isArray(v)?v:[v];const o=v.filter(x=>x!==process.argv[1]&&!x.includes("-"));console.log(o.length?o[o.length-1]:"")' "$locked")
	if [ -n "$alt" ]; then
		picked="$place $name $locked $alt"
		break
	fi
done < <(node "$HELP" candidate "$work/server.shipped.json")
[ -n "$picked" ] || fail "no third-party entry of server's shrinkwrap has another published version in range: the control cannot run"
read -r place name locked alt <<<"$picked"
dist=$(npm view "${name}@${alt}" dist --json)
resolved=$(printf '%s' "$dist" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).tarball)')
integrity=$(printf '%s' "$dist" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).integrity)')
echo "control: ${place} ${locked} -> ${alt}"
mkdir -p "$work/mutant"
tar -xzf "$server" -C "$work/mutant"
node "$HELP" mutate "$work/mutant/package/npm-shrinkwrap.json" "$place" "$alt" "$resolved" "$integrity"
(cd "$work/mutant" && tar -czf "$work/usertrust-server-${version}-mutant.tgz" package)
install_into "$work/install-mutant" "$work/usertrust-server-${version}-mutant.tgz" "$ui"
if node "$HELP" installed package-lock.json "$work/install-mutant" >"$work/mutant.check"; then
	cat "$work/mutant.check"
	fail "the control passed: npm did not install the moved entry ${name}@${alt}, so it does not honour a dependency's shrinkwrap"
fi
cat "$work/mutant.check"
grep -qF "@${alt}" "$work/mutant.check" || fail "the control failed for another reason than the moved entry ${name}@${alt}"
echo "OK: the shipped tree is reproduced, installed as tested, and npm honours it (the control moved ${name} to ${alt})"
