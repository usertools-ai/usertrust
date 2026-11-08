#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Usertools, Inc.
#
# CI's checks of the shipped dependency tree (docs/releasing.md, "The shipped dependency tree"), in
# two modes, run from the repository root:
#
#   files     the REQUIRED `shrinkwrap` job, after `npm ci` and a build of core, verify, server and ui.
#             It decides only what this commit decides, so no registry outage can fail it:
#   1. Reproduce: assembles core, verify, server and ui as the release does (`release.sh assemble`),
#      and requires server's and ui's npm-shrinkwrap.json to be byte-identical to
#      `release.sh shrinkwrap` at this commit. This is the verdict.
#   2. The file rows, RECORDED, never required: whether npm installed each package's tree EXACTLY
#      as its shrinkwrap writes it, place by place and both ways (`shrinkwrap-acceptance.mjs
#      placed`), for the tarball as built and for a CONTROL tarball whose shrinkwrap moves one entry
#      to another published version its requirer accepts: (a) the server tarball alone from a file;
#      (b) the ui tarball alone; (c) both together. npm decides to honour a dependency's shrinkwrap
#      from the package's `_hasShrinkwrap` flag, which a file tarball never carries, and the installs
#      read the public registry, so a row (or a control) that cannot run is recorded as such.
#      All of this registry work shares ONE budget, SHRINKWRAP_OPTIONAL_S seconds (default 600),
#      counted from the verdict, and each npm call in it fetches with no retries, a 30 s fetch
#      timeout, and an alarm at the budget's end (`optional`). A slow or absent registry therefore
#      costs the required job at most the budget, never its timeout.
#
#   registry  the NON-required `shrinkwrap-registry` workflow (pull requests that touch the shipped
#             tree's files, and nightly). It needs no build:
#   (e) the public registry: a published package that ships a shrinkwrap pinning a version older
#       than the newest its range allows, installed by name, must be HONOURED: npm honours a
#       registry package's shrinkwrap. A failure is loud (::error::, a failed run, the job summary),
#       and an outage blocks no merge and no release.
#
# The release itself checks the published packages afterwards: scripts/shrinkwrap-published.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
HELP="node scripts/shrinkwrap-acceptance.mjs"
PUBLIC_PKG=azure-functions-core-tools@4.16.0
MODE=${1:-}
case $MODE in
files | registry) ;;
*)
	echo "usage: shrinkwrap-acceptance.sh files|registry" >&2
	exit 2
	;;
esac
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/shrinkwrap-acceptance.XXXXXX")
fail() {
	echo "::error::$*" >&2
	[ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '### shrinkwrap (%s) FAILED\n\n%s\n' "$MODE" "$*" >>"$GITHUB_STEP_SUMMARY"
	exit 1
}
matrix() { echo "MATRIX $*" | tee -a "$work/matrix"; }
install_into() { # install_into <dir> <args...>: a user's install, in an empty directory with its own cache
	local into=$1
	shift
	mkdir -p "$into"
	printf '{"name":"acceptance","private":true}\n' >"$into/package.json"
	(cd "$into" && npm install --ignore-scripts --no-audit --no-fund --cache "$into.cache" "$@" >"$into.log" 2>&1) ||
		fail "npm install failed in $into: $(tail -c 2000 "$into.log")"
}

if [ "$MODE" = registry ]; then
	echo "== (e): the public registry, a package that ships a shrinkwrap"
	for p in "$PUBLIC_PKG" sfdx-cli@7.209.6 @cloudflare/wrangler@1.21.0; do
		echo "registry.npmjs.org: $p _hasShrinkwrap=$(npm view "$p" _hasShrinkwrap 2>/dev/null || echo absent)"
	done
	mkdir -p "$work/e-pack"
	(cd "$work/e-pack" && npm pack "$PUBLIC_PKG" >/dev/null 2>&1) || fail "(e): npm pack $PUBLIC_PKG failed"
	tar -xOzf "$work/e-pack/"*.tgz package/npm-shrinkwrap.json >"$work/e.shrinkwrap.json" ||
		fail "(e): $PUBLIC_PKG's tarball carries no npm-shrinkwrap.json"
	install_into "$work/e" "$PUBLIC_PKG"
	if out=$($HELP placed "$work/e" "${PUBLIC_PKG%@*}" "$work/e.shrinkwrap.json"); then matrix "(e)public $PUBLIC_PKG HONOURED"; else matrix "(e)public $PUBLIC_PKG NOT-HONOURED"; fi
	printf '%s\n' "$out" | sed 's/^/    /'
	$HELP where "$work/e" brace-expansion | sed 's/^/    /'
	echo "    newest brace-expansion in ^5: $(npm view 'brace-expansion@^5' version --json 2>/dev/null | node -e 'let v=JSON.parse(require("fs").readFileSync(0,"utf8"));v=Array.isArray(v)?v:[v];console.log(v[v.length-1])')"
	/usr/bin/grep -qF "MATRIX (e)public $PUBLIC_PKG HONOURED" "$work/matrix" ||
		fail "(e): npm did not install a registry package's shrinkwrap as written, so a released server or dashboard may not get its shipped tree"
	[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "### shrinkwrap (registry): (e) HONOURED" >>"$GITHUB_STEP_SUMMARY"
	echo "OK: (e) HONOURED"
	exit 0
fi

version=$(bash scripts/release.sh version)

mkdir -p "$work/packed"
for d in core verify server ui; do
	(cd "packages/$d" && npm pack --ignore-scripts --pack-destination "$work/packed" >/dev/null)
done
bash scripts/release.sh assemble "$work/packed" HEAD "$work/assembled" core verify server ui
tgz() { echo "$work/assembled/$1/$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)' "packages/$1/package.json")-${version}.tgz"; }

echo "== 1. the shipped shrinkwrap is the one the commit gives"
for d in server ui; do
	tar -xOzf "$(tgz "$d")" package/npm-shrinkwrap.json >"$work/$d.shipped.json"
	bash scripts/release.sh shrinkwrap HEAD "$d" "$version" >"$work/$d.generated.json"
	cmp "$work/$d.shipped.json" "$work/$d.generated.json" || fail "$d's shipped npm-shrinkwrap.json is not the one HEAD gives"
	echo "$d: reproduced ($(wc -c <"$work/$d.shipped.json" | tr -d ' ') bytes)"
done

# Everything below is recorded, never required: it shares one budget from here.
deadline=$((SECONDS + ${SHRINKWRAP_OPTIONAL_S:-600}))
optional() { # optional <cmd...>: runs <cmd> with bounded fetches, killed at the budget's end; 124 once it is spent
	local left=$((deadline - SECONDS))
	[ "$left" -gt 0 ] || return 124
	npm_config_fetch_retries=0 npm_config_fetch_timeout=30000 perl -e 'alarm shift; exec @ARGV or exit 127' "$left" "$@"
}

echo "== the controls: one entry of each shrinkwrap moved to another published version in range"
mutant() { # mutant <dir>: writes $work/<dir>.mutant.json and $work/mutant/<dir>/<tarball>; prints "<place> <locked> <alt>"
	local d=$1 place name range locked alt dist resolved integrity
	while read -r place name range; do
		[ -n "$place" ] || continue
		locked=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).packages;console.log(p[process.argv[2]].version)' "$work/$d.shipped.json" "$place")
		[ $((deadline - SECONDS)) -gt 0 ] || return 1 # the budget is spent
		alt=$(optional npm view "${name}@${range}" version --json 2>/dev/null |
			node -e 'let v=JSON.parse(require("fs").readFileSync(0,"utf8")||"[]");v=Array.isArray(v)?v:[v];const o=v.filter(x=>x!==process.argv[1]&&!x.includes("-"));console.log(o.length?o[o.length-1]:"")' "$locked")
		[ -n "$alt" ] && break
	done < <($HELP candidate "$work/$d.shipped.json")
	[ -n "${alt:-}" ] || return 1 # no entry has another published version in range (or the registry did not answer in time)
	dist=$(optional npm view "${name}@${alt}" dist --json) || return 1
	resolved=$(printf '%s' "$dist" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).tarball)')
	integrity=$(printf '%s' "$dist" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).integrity)')
	# The control tarball is assembled exactly as the release assembles one (scripts/release-tarball.py),
	# from the same build tarball and the same root files, with only npm-shrinkwrap.json moved.
	local roots="$work/mutant/$d/roots" name args=()
	mkdir -p "$roots"
	tar -xzf "$(tgz "$d")" -C "$work/mutant/$d"
	for name in $(cd "$work/mutant/$d/package" && find . -maxdepth 1 -type f | sed 's|^\./||'); do
		cp "$work/mutant/$d/package/$name" "$roots/$name"
	done
	$HELP mutate "$roots/npm-shrinkwrap.json" "$place" "$alt" "$resolved" "$integrity" >/dev/null || return 1
	cp "$roots/npm-shrinkwrap.json" "$work/$d.mutant.json"
	for name in $(ls "$roots"); do args+=(--root "$name=$roots/$name"); done
	python3 -I scripts/release-tarball.py assemble --input "$work/packed/$(basename "$(tgz "$d")")" \
		--output "$work/mutant/$d/$(basename "$(tgz "$d")")" --mtime "$(git show -s --format=%ct HEAD)" "${args[@]}" >/dev/null
	echo "$place $locked $alt"
}
for d in server ui; do
	place="" locked="" alt=""
	read -r place locked alt <<<"$(mutant "$d")" || true
	if [ -n "${alt:-}" ] && [ -f "$work/mutant/$d/$(basename "$(tgz "$d")")" ]; then
		printf '%s %s %s\n' "$place" "$locked" "$alt" >"$work/$d.moved"
		echo "$d control: $place $locked -> $alt"
	else
		: >"$work/$d.moved"
		matrix "$d control UNAVAILABLE (recorded: the registry gave no other version in range, or none within the budget)"
	fi
done

try_into() { # try_into <dir> <args...>: as install_into, for a row that is recorded, not required
	local into=$1
	shift
	mkdir -p "$into"
	printf '{"name":"acceptance","private":true}\n' >"$into/package.json"
	(cd "$into" && optional npm install --ignore-scripts --no-audit --no-fund --cache "$into.cache" "$@" >"$into.log" 2>&1) && return 0
	echo "    install failed, or the budget ran out (recorded): $(tail -c 600 "$into.log" | tr '\n' ' ')"
	return 1
}
row() { # row <variant> <install dir> <package dir> <expected shrinkwrap>: one matrix line
	local v=$1 dir=$2 d=$3 sw=$4 pkg out
	pkg=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)' "packages/$d/package.json")
	if out=$($HELP placed "$dir" "$pkg" "$sw"); then matrix "$v $d HONOURED"; else matrix "$v $d NOT-HONOURED"; fi
	printf '%s\n' "$out" | sed 's/^/    /'
	place=""
	read -r place _ _ <"$work/$d.moved" || true
	[ -z "$place" ] || $HELP where "$dir" "${place##*node_modules/}" | sed 's/^/    /'
}
control() { # control <dir>: the control tarball, when it was built
	[ -s "$work/$1.moved" ] && echo "$work/mutant/$1/$(basename "$(tgz "$1")")"
}

echo "== 2. the file rows (npm reads no _hasShrinkwrap from a file: recorded, not required)"
if try_into "$work/a" "$(tgz server)"; then row "(a)file-alone" "$work/a" server "$work/server.shipped.json"; else matrix "(a)file-alone server INSTALL-FAILED"; fi
if [ -n "$(control server)" ]; then
	if try_into "$work/a-control" "$(control server)"; then row "(a)file-alone-control" "$work/a-control" server "$work/server.mutant.json"; else matrix "(a)file-alone-control server INSTALL-FAILED"; fi
fi
if try_into "$work/b" "$(tgz ui)"; then row "(b)file-alone" "$work/b" ui "$work/ui.shipped.json"; else matrix "(b)file-alone ui INSTALL-FAILED"; fi
if [ -n "$(control ui)" ]; then
	if try_into "$work/b-control" "$(control ui)"; then row "(b)file-alone-control" "$work/b-control" ui "$work/ui.mutant.json"; else matrix "(b)file-alone-control ui INSTALL-FAILED"; fi
fi
if try_into "$work/c" "$(tgz server)" "$(tgz ui)"; then
	row "(c)file-both" "$work/c" server "$work/server.shipped.json"
	row "(c)file-both" "$work/c" ui "$work/ui.shipped.json"
else
	matrix "(c)file-both server+ui INSTALL-FAILED"
fi

echo "== the record"
cat "$work/matrix"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo "### shrinkwrap (files): reproduced; the file rows, recorded"; sed 's/^MATRIX /- /' "$work/matrix"; } >>"$GITHUB_STEP_SUMMARY"
echo "OK: reproduced; the file rows above are recorded, not required"
