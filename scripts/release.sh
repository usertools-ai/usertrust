#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Usertools, Inc.
#
# The release workflow's (.github/workflows/publish.yml) shell logic, in one place so that
# every step reads the same package list and packages/core/tests/harden/release-workflow.test.ts
# can run it against a fake `npm`, `gh` and git history. See docs/releasing.md.
#
#   release.sh dirs                      the lockstep package directories, in publish order
#   release.sh version                   the lockstep version; fails if the six packages disagree
#   release.sh assert-published          fails unless every <package>@<version> is on npm
#   release.sh assert-unreleased         fails if tag v<version> or any <package>@<version> exists
#   release.sh assert-protected <env>    fails unless environment <env> requires a reviewer
#   release.sh gate                      fails unless CI (ci.yml) passed on the commit released
#                                        (and, to republish, the tag commit is on master)
#   release.sh names                     the lockstep npm names, in publish order
#   release.sh version-at <commit>       the lockstep version recorded in <commit> (git blobs)
#   release.sh verify-release <bundle> <version>
#                                        imports the release tag from the build job's bundle,
#                                        verifies the commit, and prints it
#   release.sh latest-flag <version>     true if v<version> is the newest release, else false
#   release.sh pack <dir>                packs each package (already built) into <dir>
#   release.sh publish <dir> <commit> [--dry-run]
#                                        assembles each package's publish tarball from
#                                        <commit>'s files and the build tarball in <dir> (see
#                                        scripts/release-tarball.py), then publishes each
#                                        one not yet on npm
#
# Run from the repository root. Fails closed: an answer it cannot read is an error, never a pass.
#
# UNTRUSTED INPUT. The publish job holds the write token, the OIDC token and NPM_TOKEN, and
# everything the build job hands it (the git bundle, the commit in it, the tarballs, the version
# string) was made by dependency code. This script treats all of it as DATA: a manifest, like
# every root file the release ships, is read from a git blob whose mode is checked to be 100644,
# and is parsed with JSON.parse; nothing is require()d, sourced, executed or checked out, and a
# path from it is never globbed or matched as a pattern. A build tarball is never published, extracted or shown
# to npm: scripts/release-tarball.py reads it as data and writes the tarball npm publishes.

set -euo pipefail
# Bash clears -e inside $(...) unless told otherwise (bash 4.4+); on older bash every call
# that matters below also says `|| return 1` itself.
shopt -s inherit_errexit 2>/dev/null || true
# No pathname expansion anywhere: a path is a literal string.
set -f
# Every path given to git is literal, never a pathspec pattern.
export GIT_LITERAL_PATHSPECS=1

# The tool that writes the publish tarballs: this checkout's own copy, next to this script.
TARBALL_TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-tarball.py"

# The lockstep set, as <directory under packages/>:<npm name>, in publish order (a package
# comes after the packages it depends on). AGENTS.md lists the same six.
PACKAGES="core:usertrust verify:usertrust-verify openclaw:usertrust-openclaw server:usertrust-server acs-adapter:usertrust-acs-adapter ui:usertrust-ui"

REGISTRY="https://registry.npmjs.org/"

err() { echo "::error::$*" >&2; }

dirs() {
	local entry
	for entry in $PACKAGES; do echo "${entry%%:*}"; done
}

names() {
	local entry
	for entry in $PACKAGES; do echo "${entry##*:}"; done
}

name_of() {
	local entry
	for entry in $PACKAGES; do
		if [ "${entry%%:*}" = "$1" ]; then
			echo "${entry##*:}"
			return 0
		fi
	done
	err "no lockstep package in packages/$1"
	return 1
}

# The manifest checker. Its input is data only: it opens each file with O_NOFOLLOW and
# O_NONBLOCK, requires a regular file (a symlink, a FIFO or a directory is refused, and
# nothing is followed or waited on), and parses the bytes with JSON.parse.
#   read <file> <name>                         prints the version; the name must match
#   compare <base> <candidate> <name> <version>
#       the candidate must equal the base in every field but "version", which must be
#       <version>; its name must be <name>; neither may have publishConfig.
#   roots <file> <name> <version>
#       prints the root files "files" names besides dist, one per line; refuses any entry
#       that is not "dist" or a plain file name at the package root.
MANIFEST_JS='
const fs = require("node:fs");
const fail = (m) => { console.error("::error::" + m); process.exit(1); };
const load = (file) => {
	const c = fs.constants;
	let fd;
	try {
		fd = fs.openSync(file, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
	} catch (e) {
		fail(file + " cannot be opened as a regular file (" + e.code + "); a symlink is refused");
	}
	if (!fs.fstatSync(fd).isFile()) fail(file + " is not a regular file");
	const text = fs.readFileSync(fd, "utf8");
	fs.closeSync(fd);
	let v;
	try { v = JSON.parse(text); } catch (e) { fail(file + " is not JSON"); }
	if (v === null || typeof v !== "object" || Array.isArray(v)) fail(file + " is not a JSON object");
	return v;
};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const equal = (a, b) => {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every((k) => has(b, k) && equal(a[k], b[k]));
};
const [mode, ...args] = process.argv.slice(1);
if (mode === "read") {
	const [file, name] = args;
	const m = load(file);
	if (m.name !== name) fail(file + " names " + JSON.stringify(m.name) + ", not " + name);
	if (has(m, "publishConfig")) fail(file + " has publishConfig");
	if (typeof m.version !== "string") fail(file + " has no version");
	console.log(m.version);
} else if (mode === "compare") {
	const [baseFile, candFile, name, version] = args;
	const base = load(baseFile);
	const cand = load(candFile);
	if (has(base, "publishConfig") || has(cand, "publishConfig")) {
		fail(name + ": publishConfig is not allowed in a released manifest");
	}
	if (cand.name !== name || base.name !== name) {
		fail(name + ": the manifest names " + JSON.stringify(cand.name) + ", not " + name);
	}
	if (cand.version !== version) {
		fail(name + ": version is " + JSON.stringify(cand.version) + ", not " + version);
	}
	const keys = new Set([...Object.keys(base), ...Object.keys(cand)]);
	keys.delete("version");
	for (const k of keys) {
		if (!has(base, k) || !has(cand, k) || !equal(base[k], cand[k])) {
			fail(name + ": field " + JSON.stringify(k) + " differs; only \"version\" may change");
		}
	}
} else if (mode === "roots") {
	const [file, name, version] = args;
	const m = load(file);
	if (m.name !== name) fail(file + " names " + JSON.stringify(m.name) + ", not " + name);
	if (m.version !== version) fail(name + ": version is " + JSON.stringify(m.version) + ", not " + version);
	if (has(m, "publishConfig")) fail(name + ": publishConfig is not allowed in a released manifest");
	if (!Array.isArray(m.files) || !m.files.every((f) => typeof f === "string")) {
		fail(name + ": the manifest has no \"files\" list of strings; a release ships only what it names");
	}
	const special = ["dist", "package.json", "node_modules", "npm-shrinkwrap.json", "binding.gyp"];
	const roots = new Set();
	for (const f of m.files) {
		if (f === "dist") continue;
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(f) || special.includes(f.toLowerCase())) {
			fail(name + ": \"files\" entry " + JSON.stringify(f) + " is neither dist nor a plain file at the package root");
		}
		roots.add(f);
	}
	for (const f of roots) console.log(f);
} else {
	fail("manifest checker: unknown mode " + mode);
}
'

manifest() { node -e "$MANIFEST_JS" "$@"; }

# A strict release version: three numbers, nothing else (the bump makes no prereleases). Any
# version string that came from the build job is checked against this before it is used.
valid_version() {
	case "$1" in
	'' | *[!0-9.]* | .* | *. | *..*)
		return 1
		;;
	esac
	local rest="$1" parts=0
	while :; do
		parts=$((parts + 1))
		case "$rest" in
		*.*) rest="${rest#*.}" ;;
		*) break ;;
		esac
	done
	[ "$parts" -eq 3 ]
}

# The version every lockstep package carries in the working tree (the build job, before the
# bump is committed). Fails if they differ: a lockstep release publishes one number.
lockstep_version() {
	local dir v first="" firstdir=""
	for dir in $(dirs); do
		v=$(manifest read "packages/${dir}/package.json" "$(name_of "$dir")") || return 1
		if [ -z "$first" ]; then
			first="$v"
			firstdir="$dir"
		elif [ "$v" != "$first" ]; then
			err "packages/${dir} is at ${v} but packages/${firstdir} is at ${first}; the lockstep packages must share one version."
			return 1
		fi
	done
	if ! valid_version "$first"; then
		err "The lockstep version '${first}' is not a release version (major.minor.patch)."
		return 1
	fi
	echo "$first"
}

# Prints the blob id of <path> in <commit>, or nothing if <commit> has no such path, after
# checking that the tree entry is a regular file (mode 100644): a symlink (120000), an
# executable (100755), a directory or a submodule is refused.
blob_id() {
	local commit="$1" path="$2" entry meta mode type sha
	entry=$(git ls-tree "$commit" -- "$path") || return 1
	[ -n "$entry" ] || return 0
	meta="${entry%%	*}"
	mode="${meta%% *}"
	type="${meta#* }"
	type="${type%% *}"
	sha="${meta##* }"
	if [ "$entry" != "${mode} ${type} ${sha}	${path}" ] || [ "$mode" != 100644 ] || [ "$type" != blob ]; then
		err "${path} in ${commit} is not a regular file (tree entry: '${entry}'); refusing."
		return 1
	fi
	echo "$sha"
}

# Writes <path> as recorded in <commit> to <out>, from its git blob (see blob_id). A missing
# path is refused.
blob_to() {
	local commit="$1" path="$2" out="$3" sha
	sha=$(blob_id "$commit" "$path") || return 1
	if [ -z "$sha" ]; then
		err "${path} in ${commit} is not a regular file (tree entry: none); refusing."
		return 1
	fi
	git cat-file blob "$sha" >"$out" || return 1
}

# Writes packages/<dir>/package.json as recorded in <commit> to <out>.
manifest_blob() {
	blob_to "$1" "packages/$2/package.json" "$3"
}

# Writes into <out> the root files that packages/<dir> ships, as recorded in <commit>, and prints
# their names: package.json; README.md, LICENSE and NOTICE where <commit> has them; and every
# root file the manifest's "files" names, which must exist. Each is a git blob of mode 100644.
root_files() {
	local commit="$1" dir="$2" version="$3" out="$4" listed name sha names="package.json"
	manifest_blob "$commit" "$dir" "${out}/package.json" || return 1
	listed=$(manifest roots "${out}/package.json" "$(name_of "$dir")" "$version") || return 1
	for name in README.md LICENSE NOTICE; do
		sha=$(blob_id "$commit" "packages/${dir}/${name}") || return 1
		[ -n "$sha" ] || continue
		git cat-file blob "$sha" >"${out}/${name}" || return 1
		names="${names} ${name}"
	done
	for name in $listed; do
		case " ${names} " in
		*" ${name} "*) continue ;;
		esac
		blob_to "$commit" "packages/${dir}/${name}" "${out}/${name}" || return 1
		names="${names} ${name}"
	done
	echo "$names"
}

# The lockstep version recorded in <commit>, read from git blobs only.
version_at() {
	local commit="$1" tmp dir v first="" firstdir=""
	tmp=$(mktemp -d) || return 1
	for dir in $(dirs); do
		manifest_blob "$commit" "$dir" "${tmp}/${dir}.json" || return 1
		v=$(manifest read "${tmp}/${dir}.json" "$(name_of "$dir")") || return 1
		if [ -z "$first" ]; then
			first="$v"
			firstdir="$dir"
		elif [ "$v" != "$first" ]; then
			err "In ${commit}, packages/${dir} is at ${v} but packages/${firstdir} is at ${first}."
			return 1
		fi
	done
	rm -rf "$tmp"
	if ! valid_version "$first"; then
		err "The version '${first}' in ${commit} is not a release version (major.minor.patch)."
		return 1
	fi
	echo "$first"
}

# Prints "yes" if <name>@<version> is on npm and "no" if it is not. Anything else (network,
# auth, an error it does not recognise) is a failure: an unreadable registry never reads as
# "not published", because that would lead to publishing over it or skipping it blind.
registry_has() {
	local spec="$1" out rc errf
	errf=$(mktemp)
	set +e
	out=$(npm view "$spec" version --registry "$REGISTRY" 2>"$errf")
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
	version=$(lockstep_version) || return 1
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
	version=$(lockstep_version) || return 1
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

# Packs each package, already built, into <dir> as <name>-<version>.tgz. No lifecycle
# scripts: the build ran in its own step, and packing must not rebuild anything.
pack() {
	local out="${1:-}" entry dir pkg version
	if [ -z "$out" ]; then
		err "pack needs the directory to write the tarballs to"
		return 1
	fi
	version=$(lockstep_version) || return 1
	mkdir -p "$out"
	out=$(cd "$out" && pwd) || return 1
	for entry in $PACKAGES; do
		dir="${entry%%:*}"
		pkg="${entry##*:}"
		(cd "packages/${dir}" && npm pack --ignore-scripts --pack-destination "$out" >/dev/null)
		if [ ! -f "${out}/${pkg}-${version}.tgz" ]; then
			err "npm pack did not write ${pkg}-${version}.tgz to ${out}"
			return 1
		fi
		echo "packed ${pkg}-${version}.tgz"
	done
}

# Publishes each package from a tarball this script assembles, never from the build's tarball
# and never from a directory. For each package, scripts/release-tarball.py reads the build
# tarball in <dir> as data (bounded, in a limited child process) and writes a new tarball: the
# root files from <commit>'s git blobs, plus the build's package/dist/ members that pass its
# rules, under headers it makes. All six are assembled and verified before any is published.
# npm then publishes that file, from an empty directory, with an explicit registry, a user
# config this script writes, an empty global config and a fresh cache of its own, so no .npmrc
# from the artifact or the checkout applies and no build-made file is in npm's reach.
publish() {
	local tardir="${1:-}" commit="${2:-}" dry=0 dir pkg version mtime state tgz tmp cfg empty work cache names name
	if [ -z "$tardir" ] || [ ! -d "$tardir" ] || [ -z "$commit" ]; then
		err "usage: publish <tarball directory> <commit> [--dry-run]"
		return 1
	fi
	case "${3:-}" in
	--dry-run) dry=1 ;;
	"") ;;
	*)
		err "publish takes only --dry-run after the commit, not '$3'"
		return 1
		;;
	esac
	tardir=$(cd "$tardir" && pwd) || return 1
	version=$(version_at "$commit") || return 1
	# Every member's time is the release commit's, so the same commit assembles the same bytes.
	mtime=$(git show -s --format=%ct "$commit") || return 1
	case "$mtime" in
	'' | *[!0-9]*)
		err "Could not read the commit time of ${commit}."
		return 1
		;;
	esac
	tmp=$(mktemp -d) || return 1
	for dir in $(dirs); do
		pkg=$(name_of "$dir") || return 1
		tgz="${tardir}/${pkg}-${version}.tgz"
		if [ -L "$tgz" ] || [ ! -f "$tgz" ]; then
			err "${pkg}-${version}.tgz is missing from ${tardir}, or is not a regular file"
			return 1
		fi
		mkdir "${tmp}/${dir}" "${tmp}/${dir}/root" || return 1
		names=$(root_files "$commit" "$dir" "$version" "${tmp}/${dir}/root") || return 1
		set -- assemble --input "$tgz" --output "${tmp}/${dir}/${pkg}-${version}.tgz" --mtime "$mtime"
		for name in $names; do
			set -- "$@" --root "${name}=${tmp}/${dir}/root/${name}"
		done
		if ! python3 -I "$TARBALL_TOOL" "$@"; then
			err "${pkg}-${version}.tgz from the build was refused; refusing to publish anything."
			return 1
		fi
	done
	cfg="${tmp}/npmrc"
	empty="${tmp}/empty-npmrc"
	: >"$empty"
	if [ "$dry" -eq 1 ]; then
		: >"$cfg"
	else
		# The token is not in this file: it holds a reference, ${NODE_AUTH_TOKEN}, that npm
		# (not the shell) expands from this step's environment.
		printf '//registry.npmjs.org/:_authToken=%s{NODE_AUTH_TOKEN}\n' '$' >"$cfg"
	fi
	for dir in $(dirs); do
		pkg=$(name_of "$dir") || return 1
		state=$(registry_has "${pkg}@${version}") || return 1
		if [ "$state" = yes ]; then
			echo "::notice::${pkg}@${version} is already on npm; skipping"
			continue
		fi
		work=$(mktemp -d "${tmp}/work.XXXXXX") || return 1
		cache=$(mktemp -d "${tmp}/cache.XXXXXX") || return 1
		# The same command with and without --dry-run, so a dry run exercises the real one.
		set -- publish "${tmp}/${dir}/${pkg}-${version}.tgz" --access public --provenance \
			--ignore-scripts --registry "$REGISTRY" --userconfig "$cfg" --globalconfig "$empty"
		if [ "$dry" -eq 1 ]; then
			set -- "$@" --dry-run
			echo "Publishing ${pkg}@${version} (dry run)"
		else
			echo "Publishing ${pkg}@${version}"
		fi
		(cd "$work" && npm_config_cache="$cache" npm "$@") || return 1
	done
	rm -rf "$tmp"
}

# Requires the deployment environment the publishing job runs in to exist and to require at
# least one reviewer, so that no dispatch publishes without an approval. Reading an
# environment's protection rules needs the token's `actions: read`. A missing environment,
# a permission error and an answer it cannot read all REFUSE: none of them shows a reviewer.
assert_protected() {
	local env="${1:-}" body rc errf reviewers
	if [ -z "$env" ]; then
		err "assert-protected needs the environment name"
		return 1
	fi
	: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
	errf=$(mktemp)
	set +e
	body=$(gh api "repos/${GITHUB_REPOSITORY}/environments/${env}" 2>"$errf")
	rc=$?
	set -e
	if [ "$rc" -ne 0 ]; then
		if grep -q 'HTTP 404' "$errf"; then
			err "Environment '${env}' does not exist, so nothing requires an approval before publishing. Owner step: create '${env}' (Settings > Environments) with at least one required reviewer; see docs/releasing.md. Refusing to release."
		elif grep -q 'HTTP 403' "$errf"; then
			err "Not allowed to read environment '${env}' (HTTP 403). Reading its protection rules needs the job token's 'actions: read' permission. Refusing to release."
		else
			err "Could not read environment '${env}' (gh api exited ${rc}). Refusing to release."
		fi
		cat "$errf" >&2
		rm -f "$errf"
		return 1
	fi
	rm -f "$errf"
	if ! reviewers=$(printf '%s' "$body" | jq -er --arg env "$env" '
		if (type == "object") and (.name == $env) and ((.protection_rules // []) | type == "array")
		then [(.protection_rules // [])[] | select(.type == "required_reviewers") | (.reviewers // []) | length] | add // 0
		else error("not an environment") end' 2>/dev/null); then
		err "Could not read environment '${env}': the answer is not an environment. Refusing to release."
		return 1
	fi
	case "$reviewers" in
	'' | *[!0-9]*)
		err "Could not read environment '${env}': reviewer count '${reviewers}'. Refusing to release."
		return 1
		;;
	esac
	if [ "$reviewers" -lt 1 ]; then
		err "Environment '${env}' requires no reviewer, so a dispatch would publish without an approval. Owner step: add at least one required reviewer to '${env}'; see docs/releasing.md. Refusing to release."
		return 1
	fi
	if [ "$(printf '%s' "$body" | jq -r '.deployment_branch_policy == null')" = true ]; then
		echo "::warning::Environment '${env}' has no deployment-branch policy; docs/releasing.md recommends master and tags v*."
	fi
	if [ "$(printf '%s' "$body" | jq -r '[.protection_rules[] | select(.type == "required_reviewers") | .prevent_self_review] | any')" != true ]; then
		echo "::warning::Environment '${env}' lets whoever dispatches the release approve it; consider 'Prevent self-review'."
	fi
	echo "Environment '${env}' requires ${reviewers} reviewer(s)."
}

# A release commit is the bump on top of the commit CI tested, and nothing else. For a
# republish it is the commit the run was dispatched on (pushed with the workflow's token, which
# triggers no CI, so CI is gated on its parent); for a new release it is the commit in the
# build job's bundle, about to be pushed. Accept <commit> only if:
#   - its version (from git blobs) is tagged v<version>, and the tag points at it;
#   - it has exactly one parent (and that parent is <expected parent>, when one is given);
#   - it changes exactly the six lockstep package.json paths, compared as literal strings,
#     each a modified regular file (100644 before and after);
#   - each changes nothing but "version", and carries no publishConfig.
# Prints the parent.
verify_release_commit() {
	local commit="$1" expected_parent="${2:-}" version tag_commit parents parent raw tmp meta path dir seen count ok
	commit=$(git rev-parse -q --verify "${commit}^{commit}") || {
		err "${1} is not a commit."
		return 1
	}
	version=$(version_at "$commit") || return 1
	if ! tag_commit=$(git rev-parse -q --verify "refs/tags/v${version}^{commit}"); then
		err "Tag v${version} does not exist. A version with no tag has not been released: run a normal release."
		return 1
	fi
	if [ "$tag_commit" != "$commit" ]; then
		err "Tag v${version} is ${tag_commit}, not ${commit}. Dispatch the republish on the tag (ref v${version}) so that what is published is what was tagged."
		return 1
	fi
	parents=$(git rev-list --parents -n 1 "$commit") || return 1
	parent="${parents#* }"
	if [ "$parents" = "$commit" ] || [ "$parent" != "${parent%% *}" ]; then
		err "v${version} (${commit}) is not a single-parent release commit."
		return 1
	fi
	if [ -n "$expected_parent" ] && [ "$parent" != "$expected_parent" ]; then
		err "v${version} (${commit}) sits on ${parent}, not on ${expected_parent}."
		return 1
	fi
	tmp=$(mktemp -d) || return 1
	raw="${tmp}/diff"
	if ! git diff-tree -z -r --raw --no-renames --no-ext-diff --no-textconv "$parent" "$commit" >"$raw"; then
		err "Could not diff ${parent}..${commit}."
		return 1
	fi
	seen=" "
	count=0
	while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
		ok=""
		for dir in $(dirs); do
			if [ "$path" = "packages/${dir}/package.json" ]; then ok="$dir"; fi
		done
		if [ -z "$ok" ]; then
			err "v${version} (${commit}) changes '${path}', which is not one of the six lockstep package.json paths; a release commit changes only those."
			return 1
		fi
		case "$meta" in
		":100644 100644 "*" M") ;;
		*)
			err "v${version} (${commit}) changes '${path}' as '${meta}'; a release commit only modifies regular files (100644)."
			return 1
			;;
		esac
		case "$seen" in
		*" ${ok} "*)
			err "v${version} (${commit}) lists '${path}' twice."
			return 1
			;;
		esac
		seen="${seen}${ok} "
		count=$((count + 1))
		manifest_blob "$parent" "$ok" "${tmp}/${ok}.before.json" || return 1
		manifest_blob "$commit" "$ok" "${tmp}/${ok}.after.json" || return 1
		if ! manifest compare "${tmp}/${ok}.before.json" "${tmp}/${ok}.after.json" "$(name_of "$ok")" "$version"; then
			err "v${version} (${commit}) changes packages/${ok}/package.json beyond its \"version\" field; a release commit changes only the version."
			return 1
		fi
	done <"$raw"
	if [ "$count" -ne 6 ]; then
		err "v${version} (${commit}) changes ${count} of the six lockstep package.json files; a release commit bumps all six."
		return 1
	fi
	rm -rf "$tmp"
	echo "$parent"
}

# For a new release: import the tag v<version> from the build job's bundle (git objects and
# one ref, nothing else), verify the release commit it names sits on this run's commit and
# carries a DCO sign-off, and print it. The version string is validated before it is used in a
# ref.
verify_release() {
	local bundle="${1:-}" version="${2:-}" commit ident message
	if ! valid_version "$version"; then
		err "The build job reported version '${version}', which is not major.minor.patch; refusing."
		return 1
	fi
	if [ -L "$bundle" ] || [ ! -f "$bundle" ]; then
		err "The release bundle '${bundle}' is missing or not a regular file."
		return 1
	fi
	git bundle verify -q "$bundle" >/dev/null || return 1
	git fetch --quiet --no-tags "$bundle" "refs/tags/v${version}:refs/tags/v${version}" || return 1
	commit=$(git rev-parse -q --verify "refs/tags/v${version}^{commit}") || return 1
	verify_release_commit "$commit" "$(git rev-parse HEAD)" >/dev/null || return 1
	if [ "$(version_at "$commit")" != "$version" ]; then
		err "The release commit is not at version ${version}."
		return 1
	fi
	# The message the build job's `git commit -s` writes, and nothing else: the subject and the
	# DCO sign-off of the commit's own committer.
	ident=$(git show -s --format='%cn <%ce>' "$commit") || return 1
	message=$(git show -s --format=%B "$commit") || return 1
	if [ "$message" != "release: v${version}

Signed-off-by: ${ident}" ]; then
		err "The release commit's message is not exactly 'release: v${version}' and its committer's DCO sign-off; refusing."
		return 1
	fi
	echo "$commit"
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

# A republish finishes a release that master records. A version-only commit tagged on a side
# branch was never released, so its tag must be an ancestor of master as master is NOW: fetched
# here, in full. A shallow history, a failed fetch or a missing ref cannot show ancestry, so
# each of them refuses.
assert_on_master() {
	local head
	head=$(git rev-parse HEAD)
	if ! git fetch --quiet --no-tags origin "+refs/heads/master:refs/remotes/origin/master"; then
		err "Could not fetch master from origin, so nothing shows that ${head} is on master. Refusing to republish."
		return 1
	fi
	if ! git rev-parse -q --verify "refs/remotes/origin/master^{commit}" >/dev/null; then
		err "origin/master is missing after the fetch. Refusing to republish."
		return 1
	fi
	# After the fetch, which does not deepen a shallow clone: shallow history cannot prove
	# that a commit is NOT on master's line, nor, past its boundary, that it is.
	if [ "$(git rev-parse --is-shallow-repository)" != false ]; then
		err "This history is shallow, so it cannot show that ${head} is on master. Refusing to republish."
		return 1
	fi
	if ! git merge-base --is-ancestor "$head" "refs/remotes/origin/master"; then
		err "${head} is not on master (not an ancestor of origin/master): a tag on a side branch is not a release. Refusing to republish."
		return 1
	fi
	echo "${head} is on master."
}

# Whether v<version> should be the repository's Latest release: only if it is not a
# prerelease and no v* release tag is a higher semver. A republish of an older version must
# never take Latest from a newer one. Tags are fetched first, so a newer release made since
# this run started counts. Prints true or false; fails if it cannot tell.
latest_flag() {
	local version="${1:-}"
	if [ -z "$version" ]; then
		err "latest-flag needs the version"
		return 1
	fi
	if ! git fetch --quiet --tags origin; then
		err "Could not fetch tags from origin, so cannot tell whether v${version} is the newest release."
		return 1
	fi
	# shellcheck disable=SC2016 # JavaScript, not shell
	git tag -l 'v*' | node -e '
		const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
		const parse = (t) => {
			const m = SEMVER.exec(t);
			return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] } : null;
		};
		const cmp = (a, b) => {
			for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
			return 0;
		};
		const me = parse(process.argv[1]);
		if (!me) {
			console.error(`::error::${process.argv[1]} is not a semver version.`);
			process.exit(1);
		}
		let s = "";
		process.stdin.on("data", (d) => { s += d; });
		process.stdin.on("end", () => {
			const releases = s.split(/\s+/).map(parse).filter((t) => t && t.pre === undefined);
			const newest = me.pre === undefined && releases.every((t) => cmp(t, me) <= 0);
			console.log(newest ? "true" : "false");
		});
	' "$version"
}

gate() {
	local sha
	if [ "${REPUBLISH:-}" = true ]; then
		sha=$(verify_release_commit HEAD) || return 1
		assert_on_master || return 1
		echo "Republish of $(git rev-parse HEAD): gating on its parent ${sha}, the commit CI tested."
	else
		sha=$(git rev-parse HEAD)
	fi
	ci_gate "$sha"
}

case "${1:-}" in
dirs) dirs ;;
names) names ;;
version) lockstep_version ;;
version-at) version_at "${2:?usage: version-at <commit>}" ;;
verify-release) verify_release "${2:-}" "${3:-}" ;;
assert-published) assert_published ;;
assert-unreleased) assert_unreleased ;;
assert-protected) assert_protected "${2:-}" ;;
release-parent) verify_release_commit HEAD ;;
latest-flag) latest_flag "${2:-}" ;;
pack) pack "${2:-}" ;;
publish) publish "${2:-}" "${3:-}" "${4:-}" ;;
gate) gate ;;
*)
	err "usage: release.sh dirs | names | version | version-at <commit> | assert-published | assert-unreleased | assert-protected <env> | gate | release-parent | verify-release <bundle> <version> | latest-flag <version> | pack <dir> | publish <dir> <commit> [--dry-run]"
	exit 2
	;;
esac
