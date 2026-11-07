#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Usertools, Inc.
#
# CI's check of the shipped dependency tree (docs/releasing.md, "The shipped dependency tree").
# Run from the repository root after `npm ci` and a build of core, verify, server and ui. It needs
# the network: it installs what it assembles, as a user would, and reads the public registry.
#
#  1. Reproduce: assembles core, verify, server and ui as the release does (`release.sh assemble`),
#     and requires server's and ui's npm-shrinkwrap.json to be byte-identical to
#     `release.sh shrinkwrap` at this commit.
#  2. The matrix. For each way a tarball can be installed, it records whether npm installed the
#     package's dependency tree EXACTLY as its shrinkwrap writes it, place by place and both ways
#     (`shrinkwrap-acceptance.mjs placed`), for the tarball as built and for a CONTROL tarball whose
#     shrinkwrap moves one entry to another published version its requirer accepts:
#       (a) the server tarball installed alone from a file;
#       (b) the ui tarball alone from a file;
#       (c) both together from files;
#       (d) the way users install: the assembled tarballs published to a throwaway local registry
#           (verdaccio, pinned, our four packages served only from it), then `npm install` by name;
#       (e) the public registry: a published package that ships a shrinkwrap pinning a version
#           older than the newest its range allows, installed by name.
#     npm decides to honour a dependency's shrinkwrap from the package's `_hasShrinkwrap` flag,
#     which a file tarball never carries, so (a) to (c) are recorded but not required.
#  3. The verdict: (e) must be HONOURED (npm honours a registry package's shrinkwrap); (d) must be
#     HONOURED for server and ui, and each control HONOURED at its moved version, unless the local
#     registry does not report `_hasShrinkwrap` (then (d) is INCONCLUSIVE and says so).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
HELP="node scripts/shrinkwrap-acceptance.mjs"
VERDACCIO=verdaccio@6.10.6
PUBLIC_PKG=azure-functions-core-tools@4.16.0
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/shrinkwrap-acceptance.XXXXXX")
version=$(bash scripts/release.sh version)
fail() {
	echo "::error::$*" >&2
	exit 1
}
matrix() { echo "MATRIX $*" | tee -a "$work/matrix"; }

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

echo "== the controls: one entry of each shrinkwrap moved to another published version in range"
mutant() { # mutant <dir>: writes $work/<dir>.mutant.json and $work/mutant/<dir>/<tarball>; prints "<place> <locked> <alt>"
	local d=$1 place name range locked alt dist resolved integrity
	while read -r place name range; do
		[ -n "$place" ] || continue
		locked=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).packages;console.log(p[process.argv[2]].version)' "$work/$d.shipped.json" "$place")
		alt=$(npm view "${name}@${range}" version --json 2>/dev/null |
			node -e 'let v=JSON.parse(require("fs").readFileSync(0,"utf8")||"[]");v=Array.isArray(v)?v:[v];const o=v.filter(x=>x!==process.argv[1]&&!x.includes("-"));console.log(o.length?o[o.length-1]:"")' "$locked")
		[ -n "$alt" ] && break
	done < <($HELP candidate "$work/$d.shipped.json")
	[ -n "${alt:-}" ] || fail "no entry of $d's shrinkwrap has another published version in range: its control cannot run"
	dist=$(npm view "${name}@${alt}" dist --json)
	resolved=$(printf '%s' "$dist" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).tarball)')
	integrity=$(printf '%s' "$dist" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).integrity)')
	mkdir -p "$work/mutant/$d/x"
	tar -xzf "$(tgz "$d")" -C "$work/mutant/$d/x"
	$HELP mutate "$work/mutant/$d/x/package/npm-shrinkwrap.json" "$place" "$alt" "$resolved" "$integrity" >/dev/null
	cp "$work/mutant/$d/x/package/npm-shrinkwrap.json" "$work/$d.mutant.json"
	(cd "$work/mutant/$d/x" && tar -czf "$work/mutant/$d/$(basename "$(tgz "$d")")" package)
	echo "$place $locked $alt"
}
for d in server ui; do
	read -r place locked alt <<<"$(mutant "$d")"
	[ -n "${alt:-}" ] || fail "the $d control could not be built"
	printf '%s %s %s\n' "$place" "$locked" "$alt" >"$work/$d.moved"
	echo "$d control: $place $locked -> $alt"
done

install_into() { # install_into <dir> <args...>: a user's install, in an empty directory with its own cache
	local into=$1
	shift
	mkdir -p "$into"
	printf '{"name":"acceptance","private":true}\n' >"$into/package.json"
	(cd "$into" && npm install --ignore-scripts --no-audit --no-fund --cache "$into.cache" "$@" >"$into.log" 2>&1) ||
		fail "npm install failed in $into: $(tail -c 2000 "$into.log")"
}
row() { # row <variant> <install dir> <package dir> <expected shrinkwrap>: one matrix line
	local v=$1 dir=$2 d=$3 sw=$4 pkg out
	pkg=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)' "packages/$d/package.json")
	if out=$($HELP placed "$dir" "$pkg" "$sw"); then matrix "$v $d HONOURED"; else matrix "$v $d NOT-HONOURED"; fi
	printf '%s\n' "$out" | sed 's/^/    /'
	read -r place _ _ <"$work/$d.moved"
	$HELP where "$dir" "${place##*node_modules/}" | sed 's/^/    /'
}

echo "== 2. the matrix"
echo "-- (a)-(c): file tarballs (npm reads no _hasShrinkwrap from a file: recorded, not required)"
install_into "$work/a" "$(tgz server)"
row "(a)file-alone" "$work/a" server "$work/server.shipped.json"
install_into "$work/a-control" "$work/mutant/server/$(basename "$(tgz server)")"
row "(a)file-alone-control" "$work/a-control" server "$work/server.mutant.json"
install_into "$work/b" "$(tgz ui)"
row "(b)file-alone" "$work/b" ui "$work/ui.shipped.json"
install_into "$work/b-control" "$work/mutant/ui/$(basename "$(tgz ui)")"
row "(b)file-alone-control" "$work/b-control" ui "$work/ui.mutant.json"
install_into "$work/c" "$(tgz server)" "$(tgz ui)"
row "(c)file-both" "$work/c" server "$work/server.shipped.json"
row "(c)file-both" "$work/c" ui "$work/ui.shipped.json"

echo "-- (d): a throwaway local registry, installed by name"
registry_up() { # registry_up <name>: a fresh verdaccio on 127.0.0.1:4873 whose storage only holds what we publish
	local n=$1 r="$work/registry-$1"
	mkdir -p "$r/storage"
	cat >"$r/config.yaml" <<EOF
storage: $r/storage
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  'usertrust':
    access: \$all
    publish: \$all
  'usertrust-*':
    access: \$all
    publish: \$all
  '**':
    access: \$all
    proxy: npmjs
log: { type: file, path: $r/verdaccio.log, level: warn }
EOF
	npx --yes "$VERDACCIO" --config "$r/config.yaml" --listen 127.0.0.1:4873 >"$r/out.log" 2>&1 &
	echo $! >"$r/pid"
	local i
	for i in $(seq 1 60); do
		curl -sf http://127.0.0.1:4873/-/ping >/dev/null && return 0
		sleep 1
	done
	fail "the local registry did not start: $(tail -c 1000 "$r/out.log")"
}
registry_down() { kill "$(cat "$work/registry-$1/pid")" 2>/dev/null || true; sleep 1; }
publish_local() { # publish_local <tarball>
	printf '//127.0.0.1:4873/:_authToken=acceptance\n' >"$work/npmrc"
	npm publish "$1" --registry http://127.0.0.1:4873/ --userconfig "$work/npmrc" --ignore-scripts >"$work/publish.log" 2>&1 ||
		fail "publish to the local registry failed: $(tail -c 1500 "$work/publish.log")"
}
d_variant() { # d_variant <name> <server tarball> <ui tarball> <server shrinkwrap> <ui shrinkwrap>
	registry_up "$1"
	publish_local "$(tgz core)"
	publish_local "$(tgz verify)"
	publish_local "$2"
	publish_local "$3"
	for d in server ui; do
		pkg=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)' "packages/$d/package.json")
		flag=$(npm view "$pkg@$version" _hasShrinkwrap --registry http://127.0.0.1:4873/ 2>/dev/null || true)
		echo "local registry ($1): $pkg@$version _hasShrinkwrap=${flag:-absent}"
		echo "${flag:-absent}" >"$work/d-$1-$d.flag"
		install_into "$work/d-$1-$d" "$pkg@$version" --registry http://127.0.0.1:4873/
	done
	row "(d)registry-$1" "$work/d-$1-server" server "$4"
	row "(d)registry-$1" "$work/d-$1-ui" ui "$5"
	registry_down "$1"
}
d_variant built "$(tgz server)" "$(tgz ui)" "$work/server.shipped.json" "$work/ui.shipped.json"
d_variant control "$work/mutant/server/$(basename "$(tgz server)")" "$work/mutant/ui/$(basename "$(tgz ui)")" "$work/server.mutant.json" "$work/ui.mutant.json"

echo "-- (e): the public registry, a package that ships a shrinkwrap"
for p in "$PUBLIC_PKG" sfdx-cli@7.209.6 @cloudflare/wrangler@1.21.0 "usertrust-server@$version"; do
	echo "registry.npmjs.org: $p _hasShrinkwrap=$(npm view "$p" _hasShrinkwrap 2>/dev/null || echo absent)"
done
mkdir -p "$work/e-pack"
(cd "$work/e-pack" && npm pack "$PUBLIC_PKG" >/dev/null 2>&1)
tar -xOzf "$work/e-pack/"*.tgz package/npm-shrinkwrap.json >"$work/e.shrinkwrap.json"
install_into "$work/e" "$PUBLIC_PKG"
if out=$($HELP placed "$work/e" "${PUBLIC_PKG%@*}" "$work/e.shrinkwrap.json"); then matrix "(e)public $PUBLIC_PKG HONOURED"; else matrix "(e)public $PUBLIC_PKG NOT-HONOURED"; fi
printf '%s\n' "$out" | sed 's/^/    /'
$HELP where "$work/e" brace-expansion | sed 's/^/    /'
echo "    newest brace-expansion in ^5: $(npm view 'brace-expansion@^5' version --json 2>/dev/null | node -e 'let v=JSON.parse(require("fs").readFileSync(0,"utf8"));v=Array.isArray(v)?v:[v];console.log(v[v.length-1])')"

echo "== 3. the verdict"
cat "$work/matrix"
ok=1
/usr/bin/grep -qF "MATRIX (e)public $PUBLIC_PKG HONOURED" "$work/matrix" || {
	echo "::error::(e): npm did not install a registry package's shrinkwrap as written"
	ok=0
}
if [ "$(cat "$work/d-built-server.flag")" = true ]; then
	for want in "(d)registry-built server HONOURED" "(d)registry-built ui HONOURED" "(d)registry-control server HONOURED" "(d)registry-control ui HONOURED"; do
		/usr/bin/grep -qF "MATRIX $want" "$work/matrix" || {
			echo "::error::(d): expected '$want'"
			ok=0
		}
	done
else
	echo "::warning::(d) INCONCLUSIVE: the local registry reports _hasShrinkwrap=$(cat "$work/d-built-server.flag") for our package, so it does not show what registry.npmjs.org will do; (e) decides"
fi
[ "$ok" = 1 ] || fail "the shipped tree is not installed as written (see the matrix above)"
echo "OK: reproduced; the matrix above is the evidence"
