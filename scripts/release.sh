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
#   release.sh pin-siblings              sets every lockstep package a manifest depends on to
#                                        the lockstep version (the bump's second half)
#   release.sh assert-published          fails unless every <package>@<version> is on npm
#   release.sh assert-unreleased         fails if tag v<version> or any <package>@<version> exists
#   release.sh assert-protected <env>    fails unless environment <env> requires a reviewer
#   release.sh gate                      fails unless CI (ci.yml) passed on the commit released
#                                        (and, to republish, the tag commit is on master)
#   release.sh names                     the lockstep npm names, in publish order
#   release.sh version-at <commit>       the lockstep version recorded in <commit> (git blobs)
#   release.sh expected-version <bump>   the version a release dispatched on HEAD makes: HEAD's
#                                        committed version bumped by patch, minor or major
#   release.sh assert-bump <bump>        fails unless <bump> is the class the CHANGELOG's release
#                                        section requires (docs/releasing.md, "Choosing the
#                                        version"), and refuses an early major unless
#                                        ALLOW_EARLY_MAJOR gives the reason
#   release.sh verify-release <bundle> <version>
#                                        imports the release tag from the build job's bundle,
#                                        verifies the commit, and prints it
#   release.sh latest-flag <version>     true if v<version> is the newest release (no v* tag
#                                        on master, and no version of any package on npm, is
#                                        higher)
#   release.sh dist-tag <version>        the npm dist-tag v<version> publishes under, from
#                                        latest-flag: latest if true, backfill if false
#   release.sh assert-npm                prints node's and npm's versions; fails unless npm is
#                                        11.5.1 or later and node 22.14.0 or later (trusted
#                                        publishing, and npm's implicit-latest refusal; see
#                                        assert_npm)
#   release.sh pack <dir>                packs each package (already built) into <dir>
#   release.sh compare-builds <dir> <rebuild dir> <commit>
#                                        assembles each package's publish tarball from both
#                                        directories' build tarballs, and fails unless every
#                                        pair is byte-identical (sha256)
#   release.sh publish <dir> <commit> [--dry-run]
#                                        assembles each package's publish tarball from
#                                        <commit>'s files and the build tarball in <dir> (see
#                                        scripts/release-tarball.py), then publishes them
#                                        under the dist-tag above (latest as npm's default,
#                                        with no --tag). A new release refuses if any is on npm
#                                        already; a republish skips one only if npm holds this
#                                        run's exact bytes. See publish.
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
# npm reads every npm_config_<key> environment variable, the name in any letter case, as
# config. A tag from there would redirect `npm view <name>` (npm resolves a bare name against
# the tag config, lib/commands/view.js) and `npm publish` without --tag (it would apply that
# tag instead of latest). It is dropped here, once, before any npm command runs.
for _name in $(compgen -e); do
	case "$(printf '%s' "$_name" | tr '[:upper:]' '[:lower:]')" in
	npm_config_tag) unset "$_name" ;;
	esac
done
unset _name

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
#
# A SIBLING is a lockstep package (LOCKSTEP_NAMES, set by manifest() below) that a manifest
# names in one of its dependency fields (dependencies, optionalDependencies, peerDependencies,
# devDependencies). A released manifest names every sibling at exactly the release's version.
# A range such as "*" is satisfied by a sibling an earlier install left behind, and a package
# run against an older sibling can fail to start (an export it imports does not exist there).
#   read <file> <name>                         prints the version; the name must match
#   compare <base> <candidate> <name> <version>
#       the candidate's "version" must be <version>, and each sibling it names must be at
#       exactly <version>; it must equal the base in everything else (the same fields, and
#       in each dependency field the same names, with every non-sibling spec unchanged). Its
#       name must be <name>; neither may have publishConfig.
#   roots <file> <name> <version>
#       prints the root files "files" names besides dist, one per line; refuses any entry
#       that is not "dist" or a plain file name at the package root, and any sibling that is
#       not at exactly <version>.
#   pin <file> <name> <version>
#       sets each sibling the manifest names to <version>, rewriting the file only if that
#       changes it, and prints each change; the manifest's own version must be <version>.
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
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const LOCKSTEP = (process.env.LOCKSTEP_NAMES || "").split("\n").filter(Boolean);
if (LOCKSTEP.length === 0) fail("manifest checker: LOCKSTEP_NAMES is empty");
const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
// The siblings <m> names, as [field, name] pairs. A dependency field that is not an object is
// refused: what it names cannot be read.
const siblings = (m, name) => {
	const found = [];
	for (const f of DEP_FIELDS) {
		if (!has(m, f)) continue;
		if (!isObject(m[f])) fail(name + ": " + JSON.stringify(f) + " is not an object");
		for (const k of Object.keys(m[f])) if (LOCKSTEP.includes(k)) found.push([f, k]);
	}
	return found;
};
const requirePinned = (m, name, version) => {
	for (const [f, k] of siblings(m, name)) {
		if (m[f][k] !== version) {
			fail(name + ": " + f + " names " + k + " at " + JSON.stringify(m[f][k]) + ", not " + version + "; a release names each lockstep sibling at exactly its own version");
		}
	}
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
	requirePinned(cand, name, version);
	const keys = new Set([...Object.keys(base), ...Object.keys(cand)]);
	keys.delete("version");
	for (const k of keys) {
		const differs = name + ": field " + JSON.stringify(k) + " differs; only \"version\" and the lockstep siblings may change";
		if (!has(base, k) || !has(cand, k)) fail(differs);
		if (!DEP_FIELDS.includes(k)) {
			if (!equal(base[k], cand[k])) fail(differs);
			continue;
		}
		if (!isObject(base[k]) || !isObject(cand[k])) fail(differs);
		const deps = new Set([...Object.keys(base[k]), ...Object.keys(cand[k])]);
		for (const d of deps) {
			if (!has(base[k], d) || !has(cand[k], d)) {
				fail(name + ": " + k + " " + (has(cand[k], d) ? "adds " : "drops ") + d + "; a release adds and drops no dependency");
			}
			if (!LOCKSTEP.includes(d) && !equal(base[k][d], cand[k][d])) {
				fail(name + ": " + k + " changes " + d + "; a release changes only the lockstep siblings");
			}
		}
	}
} else if (mode === "roots") {
	const [file, name, version] = args;
	const m = load(file);
	if (m.name !== name) fail(file + " names " + JSON.stringify(m.name) + ", not " + name);
	if (m.version !== version) fail(name + ": version is " + JSON.stringify(m.version) + ", not " + version);
	if (has(m, "publishConfig")) fail(name + ": publishConfig is not allowed in a released manifest");
	requirePinned(m, name, version);
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
} else if (mode === "pin") {
	const [file, name, version] = args;
	const m = load(file);
	if (m.name !== name) fail(file + " names " + JSON.stringify(m.name) + ", not " + name);
	if (m.version !== version) fail(name + ": version is " + JSON.stringify(m.version) + ", not " + version);
	const changes = [];
	for (const [f, k] of siblings(m, name)) {
		if (m[f][k] === version) continue;
		changes.push(name + ": " + f + " " + k + " " + JSON.stringify(m[f][k]) + " -> " + JSON.stringify(version));
		m[f][k] = version;
	}
	if (changes.length > 0) {
		// The format npm and biome give these files: tabs, and a final newline.
		const c = fs.constants;
		const fd = fs.openSync(file, c.O_WRONLY | c.O_TRUNC | c.O_NOFOLLOW);
		fs.writeFileSync(fd, JSON.stringify(m, null, "\t") + "\n");
		fs.closeSync(fd);
	}
	for (const line of changes) console.log(line);
} else {
	fail("manifest checker: unknown mode " + mode);
}
'

# The checker reads the lockstep names from its environment, one per line.
manifest() { LOCKSTEP_NAMES="$(names)" node -e "$MANIFEST_JS" "$@"; }

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

# The bump's second half, in the working tree. `npm version` sets each package's own version
# and nothing else: it never rewrites a spec that names the package it bumped (npm has no
# workspace protocol, and the publish tarball's package.json comes from the release commit, so
# nothing rewrites one later either). This sets every sibling each manifest names to the
# lockstep version, so that the release commit, and the packages published from it, require
# exactly the siblings they are released with. verify_release_commit accepts exactly these
# changes.
pin_siblings() {
	local version dir
	version=$(lockstep_version) || return 1
	for dir in $(dirs); do
		manifest pin "packages/${dir}/package.json" "$(name_of "$dir")" "$version" || return 1
	done
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

# The version a new release dispatched on HEAD makes: HEAD's committed lockstep version (read
# from git blobs) bumped by <bump>, as `npm version <bump>` bumps a major.minor.patch version.
# The publish job checks the build's release commit against this, so the version is never the
# build job's word: it follows from the dispatched commit and the dispatch input alone.
expected_version() {
	local bump="${1:-}" v major minor patch
	v=$(version_at HEAD) || return 1
	IFS=. read -r major minor patch <<<"$v"
	case "$bump" in
	patch) patch=$((10#$patch + 1)) ;;
	minor)
		minor=$((10#$minor + 1))
		patch=0
		;;
	major)
		major=$((10#$major + 1))
		minor=0
		patch=0
		;;
	*)
		err "The bump is '${bump}', not patch, minor or major."
		return 1
		;;
	esac
	echo "$((10#$major)).$((10#$minor)).$((10#$patch))"
}

# The release's CHANGELOG section, read as data from CHANGELOG.md (argv[1]): [Unreleased] must
# hold no entry (everything is cut into the release's section before dispatch), and the section
# under it, `## [<version>] - <date>`, must hold at least one entry under a class heading. Prints
# "<version> <class>", the class being the highest among its entries'. A heading that is not a
# class or a note, or an entry under no heading, is refused: an unknown heading could otherwise
# hide an entry from the count. The classes are docs/releasing.md's "Choosing the version".
CHANGELOG_PY='
import re, sys
CLASSES = {
    "Removed": "major", "Breaking": "major",
    "Added": "minor", "Changed": "minor", "Deprecated": "minor",
    "Fixed": "patch", "Security": "patch", "Dependencies": "patch",
}
NOTES = {"Read before upgrading", "Known issues"}
RANK = {"patch": 1, "minor": 2, "major": 3}

def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)

lines = open(sys.argv[1], encoding="utf-8").read().split("\n")
sections = []
for line in lines:
    if line.startswith("## "):
        sections.append([line[3:].strip(), []])
    elif sections:
        sections[-1][1].append(line)
if not sections or sections[0][0] != "[Unreleased]":
    fail("CHANGELOG.md does not begin with a ## [Unreleased] section.")
left = [l for l in sections[0][1] if l.startswith("- ")]
if left:
    fail("[Unreleased] still holds %d entr%s. Cut every entry into the release section before dispatching (docs/releasing.md, \"Cutting the CHANGELOG\")." % (len(left), "y" if len(left) == 1 else "ies"))
if len(sections) < 2:
    fail("CHANGELOG.md has no section under [Unreleased] to release.")
m = re.fullmatch(r"\[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}", sections[1][0])
if not m:
    fail("The section under [Unreleased] is \"## %s\", not \"## [major.minor.patch] - YYYY-MM-DD\"." % sections[1][0])
heading, best, counts = None, None, []
for line in sections[1][1]:
    if line.startswith("### "):
        heading = line[4:].strip()
        if heading not in CLASSES and heading not in NOTES:
            fail("The %s section has a heading \"%s\", which is neither a class (%s) nor a note (%s)." % (m.group(1), heading, ", ".join(CLASSES), ", ".join(sorted(NOTES))))
        if heading in CLASSES:
            counts.append([heading, 0])
    elif line.startswith("- "):
        if heading is None:
            fail("The %s section has an entry under no ### heading." % m.group(1))
        if heading in CLASSES:
            counts[-1][1] += 1
            c = CLASSES[heading]
            if best is None or RANK[c] > RANK[best]:
                best = c
if best is None:
    fail("The %s section is empty: it has no entry under %s." % (m.group(1), ", ".join(CLASSES)))
for h, n in counts:
    if n:
        print("%s: %d entr%s (%s)" % (h, n, "y" if n == 1 else "ies", CLASSES[h]), file=sys.stderr)
print(m.group(1), best)
'

# The policy's cap on majors: at most one a quarter.
EARLY_MAJOR_DAYS=90

# Refuses a new release whose bump is not the one its CHANGELOG section requires (the highest
# class among its entries: docs/releasing.md, "Choosing the version"), in either direction: a
# patch with an Added entry, and a major with no Removed or Breaking entry, alike. Refuses an
# empty section, entries left in [Unreleased], and a section for another version. A major less
# than EARLY_MAJOR_DAYS after the last major (its v<N>.0.0 tag on master) is refused unless
# ALLOW_EARLY_MAJOR (the dispatch's allow_early_major input) gives a reason, which the release
# notes carry; a reason given to any other release is refused, so it is never silently unused.
# CHANGELOG.md is read from HEAD's blob, as every file this script releases is.
assert_bump() {
	local bump="${1:-}" reason="${ALLOW_EARLY_MAJOR:-}" expected tmp out section required
	local tags last="" last_n=-1 t n when now age
	expected=$(expected_version "$bump") || return 1
	tmp=$(mktemp -d) || return 1
	if ! blob_to HEAD CHANGELOG.md "${tmp}/CHANGELOG.md"; then
		rm -rf "$tmp"
		return 1
	fi
	if ! out=$(python3 -c "$CHANGELOG_PY" "${tmp}/CHANGELOG.md" 2>"${tmp}/err"); then
		err "$(cat "${tmp}/err")"
		rm -rf "$tmp"
		return 1
	fi
	cat "${tmp}/err"
	rm -rf "$tmp"
	read -r section required <<<"$out"
	if [ "$required" != "$bump" ]; then
		err "The CHANGELOG's ${section} section requires a ${required} release (its highest class), but this dispatch is ${bump}. Refusing (docs/releasing.md, \"Choosing the version\")."
		return 1
	fi
	if [ "$section" != "$expected" ]; then
		err "A ${bump} release of $(version_at HEAD) is ${expected}, but the CHANGELOG's newest section is ${section}. Refusing."
		return 1
	fi
	reason="$(printf '%s' "$reason" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
	if [ "$bump" != major ]; then
		if [ -n "$reason" ]; then
			err "allow_early_major is set, but this is a ${bump} release. Clear it and dispatch again."
			return 1
		fi
		echo "${expected}: a ${bump} release, as its CHANGELOG section requires."
		return 0
	fi
	if ! git fetch --quiet --tags origin; then
		err "Could not fetch tags from origin, so cannot tell when the last major release was."
		return 1
	fi
	fetch_master "when the last major release was" || return 1
	tags=$(git tag -l 'v*.0.0' --merged refs/remotes/origin/master) || return 1
	for t in $tags; do
		[[ "$t" =~ ^v([0-9]+)\.0\.0$ ]] || continue
		n=$((10#${BASH_REMATCH[1]}))
		if [ "$n" -gt "$last_n" ]; then
			last_n=$n
			last=$t
		fi
	done
	if [ -z "$last" ]; then
		age=""
	else
		when=$(git for-each-ref --format='%(creatordate:unix)' "refs/tags/${last}") || return 1
		if ! [[ "$when" =~ ^[0-9]+$ ]]; then
			err "Could not read when ${last} was tagged."
			return 1
		fi
		now=$(date +%s)
		age=$(((now - when) / 86400))
	fi
	if [ -n "$age" ] && [ "$age" -lt "$EARLY_MAJOR_DAYS" ]; then
		if [ -z "$reason" ]; then
			err "${last} was released ${age} days ago; a major release comes at most once every ${EARLY_MAJOR_DAYS} days. To release ${expected} anyway, give the reason in allow_early_major: it goes into the release notes."
			return 1
		fi
		echo "${expected}: a major release ${age} days after ${last}, allowed early: ${reason}"
		return 0
	fi
	if [ -n "$reason" ]; then
		err "allow_early_major is set, but ${last:-no earlier major} is not under ${EARLY_MAJOR_DAYS} days old. Clear it and dispatch again."
		return 1
	fi
	echo "${expected}: a major release, as its CHANGELOG section requires${last:+, ${age} days after ${last}}."
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

# Assembles each package's publish tarball into <out>/<dir>/<name>-<version>.tgz: the root
# files from <commit>'s git blobs, plus the package/dist/ members of the build tarball in
# <tardir> that pass scripts/release-tarball.py's rules (read as data, in a limited child
# process), under headers it makes. Every member's time is the release commit's, so one commit
# and one set of dist/ bytes always give the same tarball. Fails if any build tarball is
# missing or refused; <what> ("the build" or "the rebuild") names the source in the error.
assemble_all() {
	local tardir="$1" commit="$2" version="$3" out="$4" what="$5" mtime dir pkg tgz names name
	mtime=$(git show -s --format=%ct "$commit") || return 1
	case "$mtime" in
	'' | *[!0-9]*)
		err "Could not read the commit time of ${commit}."
		return 1
		;;
	esac
	for dir in $(dirs); do
		pkg=$(name_of "$dir") || return 1
		tgz="${tardir}/${pkg}-${version}.tgz"
		if [ -L "$tgz" ] || [ ! -f "$tgz" ]; then
			err "${pkg}-${version}.tgz is missing from ${tardir}, or is not a regular file"
			return 1
		fi
		mkdir "${out}/${dir}" "${out}/${dir}/root" || return 1
		names=$(root_files "$commit" "$dir" "$version" "${out}/${dir}/root") || return 1
		set -- assemble --input "$tgz" --output "${out}/${dir}/${pkg}-${version}.tgz" --mtime "$mtime"
		for name in $names; do
			set -- "$@" --root "${name}=${out}/${dir}/root/${name}"
		done
		if ! python3 -I "$TARBALL_TOOL" "$@"; then
			err "${pkg}-${version}.tgz from ${what} was refused; refusing to publish anything."
			return 1
		fi
	done
}

# The sha256 of a file, in hex. python3 is on every runner and on macOS, where sha256sum is not.
sha256_of() {
	python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"
}

# The rebuild check. The build job runs as two legs of one matrix, on two fresh runners, with
# the same steps: `release` builds what is published, `rebuild` builds the same commit with the
# same bump again. Both legs' tarballs are untrusted data. For each package, this assembles the
# publish tarball twice, from the same <commit> (so the same root files and member times) with
# the dist/ bytes of each leg's build tarball, and fails unless the two are byte-identical. So
# the bytes npm would receive are the bytes a second, independent build of the same tree gives,
# and neither leg alone chooses a dist/ byte or a dist/ path. Prints each package's sha256.
compare_builds() {
	local tardir="${1:-}" redir="${2:-}" commit="${3:-}" version tmp dir pkg a b sa sb bad=""
	if [ -z "$tardir" ] || [ ! -d "$tardir" ] || [ -z "$redir" ] || [ ! -d "$redir" ] || [ -z "$commit" ]; then
		err "usage: compare-builds <tarball directory> <rebuild tarball directory> <commit>"
		return 1
	fi
	tardir=$(cd "$tardir" && pwd) || return 1
	redir=$(cd "$redir" && pwd) || return 1
	if [ "$tardir" = "$redir" ]; then
		err "compare-builds was given one directory twice (${tardir}); it compares two builds."
		return 1
	fi
	version=$(version_at "$commit") || return 1
	tmp=$(mktemp -d) || return 1
	mkdir "${tmp}/release" "${tmp}/rebuild" || return 1
	assemble_all "$tardir" "$commit" "$version" "${tmp}/release" "the build" || return 1
	assemble_all "$redir" "$commit" "$version" "${tmp}/rebuild" "the rebuild" || return 1
	for dir in $(dirs); do
		pkg=$(name_of "$dir") || return 1
		a="${tmp}/release/${dir}/${pkg}-${version}.tgz"
		b="${tmp}/rebuild/${dir}/${pkg}-${version}.tgz"
		sa=$(sha256_of "$a") || return 1
		sb=$(sha256_of "$b") || return 1
		case "$sa" in
		'' | *[!0-9a-f]*)
			err "Could not hash ${pkg}-${version}.tgz."
			return 1
			;;
		esac
		if [ "$sa" = "$sb" ] && cmp -s "$a" "$b"; then
			echo "${pkg}-${version}.tgz sha256 ${sa}: the build and the rebuild agree"
		else
			err "${pkg}-${version}.tgz: the build assembles to sha256 ${sa}, the rebuild to ${sb}."
			bad="${bad} ${pkg}"
		fi
	done
	rm -rf "$tmp"
	if [ -n "$bad" ]; then
		err "The two builds of ${commit} differ for:${bad}. Either the build is not reproducible or one runner's output was changed; compare the two artifacts' dist/ files before releasing anything. Refusing to publish anything."
		return 1
	fi
}

# Publishes each package from a tarball this script assembles, never from the build's tarball
# and never from a directory. For each package, scripts/release-tarball.py reads the build
# tarball in <dir> as data (bounded, in a limited child process) and writes a new tarball: the
# root files from <commit>'s git blobs, plus the build's package/dist/ members that pass its
# rules, under headers it makes. All six are assembled and verified before any is published.
# npm then publishes that file, from an empty directory, with an explicit registry, a user
# config this script writes, an empty global config and a fresh cache of its own, so no .npmrc
# from the artifact or the checkout applies and no build-made file is in npm's reach. The
# dist-tag (dist_tag) is decided once, before anything else, for all six, and applies to every
# npm publish, the dry run included; if it cannot be decided, nothing is published. That
# pre-check decides before ANY package is published (npm's own guard fires per package, so
# alone it could leave a release half-published) and keeps the GitHub Release's Latest
# consistent with npm. latest is then applied as npm's default, with no --tag, so that npm's
# own refusal to apply latest implicitly to a version not higher than one it holds (added in
# npm 11.0.0, lib/commands/publish.js; the publish job requires npm 11, see assert-npm) stays
# active as a backstop; an explicit --tag latest would bypass it. backfill is passed as --tag
# backfill.
publish() {
	local tardir="${1:-}" commit="${2:-}" dry=0 dir pkg version tag state tmp cfg empty work cache skip present
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
	tag=$(dist_tag "$version") || return 1
	echo "npm dist-tag for ${version}: ${tag}"
	tmp=$(mktemp -d) || return 1
	assemble_all "$tardir" "$commit" "$version" "$tmp" "the build" || return 1
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
	# Which of the six are already on npm, all checked before any is published. A new release
	# (REPUBLISH false) refuses if any is: the build job checked none was (assert-unreleased),
	# but the approval can come hours later, and a version published in between is not this
	# release's. In a normal release this runs in the dry-run step, before the push. A republish
	# skips one only if npm holds exactly the tarball this run assembled (same_on_npm).
	case "${REPUBLISH:-}" in
	true | false) ;;
	*)
		err "REPUBLISH is '${REPUBLISH:-}', not true or false. Refusing to publish."
		return 1
		;;
	esac
	skip=" "
	present=""
	for dir in $(dirs); do
		pkg=$(name_of "$dir") || return 1
		state=$(registry_has "${pkg}@${version}") || return 1
		[ "$state" = yes ] || continue
		if [ "$REPUBLISH" != true ]; then
			present="${present} ${pkg}@${version}"
			continue
		fi
		if ! same_on_npm "${pkg}@${version}" "${tmp}/${dir}/${pkg}-${version}.tgz"; then
			err "${pkg}@${version} is on npm, but not as the tarball this run assembled from ${commit}. Refusing to publish anything."
			return 1
		fi
		echo "::notice::${pkg}@${version} is already on npm, byte-identical to this run's tarball; skipping"
		skip="${skip}${dir} "
	done
	if [ -n "$present" ]; then
		err "Already on npm:${present}. A new release publishes only versions nobody has published, and these appeared after the build job checked. Find out how before releasing anything. Refusing to publish anything."
		return 1
	fi
	for dir in $(dirs); do
		pkg=$(name_of "$dir") || return 1
		case "$skip" in
		*" ${dir} "*) continue ;;
		esac
		work=$(mktemp -d "${tmp}/work.XXXXXX") || return 1
		cache=$(mktemp -d "${tmp}/cache.XXXXXX") || return 1
		# The same command with and without --dry-run, so a dry run exercises the real one.
		set -- publish "${tmp}/${dir}/${pkg}-${version}.tgz" --access public
		case "$tag" in
		latest) ;;
		backfill) set -- "$@" --tag backfill ;;
		*)
			err "Unknown dist-tag '${tag}'. Refusing to publish."
			return 1
			;;
		esac
		set -- "$@" --provenance --ignore-scripts --registry "$REGISTRY" --userconfig "$cfg" --globalconfig "$empty"
		if [ "$dry" -eq 1 ]; then
			set -- "$@" --dry-run
			echo "Publishing ${pkg}@${version} under ${tag} (dry run)"
		else
			echo "Publishing ${pkg}@${version} under ${tag}"
		fi
		# With no --tag, npm takes the tag from its config: no npm_config_tag reaches it (see
		# the top of this script), and the user and global configs are ours.
		(cd "$work" && npm_config_cache="$cache" npm "$@") || return 1
	done
	rm -rf "$tmp"
}

# Whether npm holds <name>@<version> (an explicit version, so no tag config applies) as exactly
# the bytes of <tgz>: its dist.integrity must be the sha512 of <tgz> and its dist.shasum the
# sha1. npm uploads a tarball spec's bytes unchanged (libnpmpack hands pacote's read of the file
# to libnpmpublish, which computes both from those bytes and uploads them; npm/cli v11.19.0),
# and this script assembles the same bytes from the same commit, so a package an earlier run of
# this workflow published matches. A missing, unreadable or different answer fails.
# shellcheck disable=SC2016 # JavaScript, not shell
SAME_JS='
const fs = require("node:fs");
const crypto = require("node:crypto");
const [file, spec] = process.argv.slice(1);
const fail = (m) => { console.error("::error::" + spec + ": " + m); process.exit(1); };
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
	let dist;
	try { dist = JSON.parse(s); } catch (e) { fail("npm answered no JSON for its dist"); }
	if (dist === null || typeof dist !== "object" || Array.isArray(dist)) fail("npm answered no dist object");
	if (typeof dist.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity)) {
		fail("npm gives no single sha512 integrity (" + JSON.stringify(dist.integrity) + ")");
	}
	if (typeof dist.shasum !== "string" || !/^[0-9a-f]{40}$/.test(dist.shasum)) {
		fail("npm gives no sha1 shasum (" + JSON.stringify(dist.shasum) + ")");
	}
	const bytes = fs.readFileSync(file);
	const sha512 = "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64");
	const sha1 = crypto.createHash("sha1").update(bytes).digest("hex");
	if (dist.integrity !== sha512) fail("npm holds integrity " + dist.integrity + ", this run assembled " + sha512);
	if (dist.shasum !== sha1) fail("npm holds shasum " + dist.shasum + ", this run assembled " + sha1);
});
'

same_on_npm() {
	local spec="$1" tgz="$2" out rc errf
	errf=$(mktemp) || return 1
	set +e
	out=$(npm view "$spec" dist --json --registry "$REGISTRY" 2>"$errf")
	rc=$?
	set -e
	if [ "$rc" -ne 0 ]; then
		err "Could not read ${spec}'s published tarball digest from npm (npm view exited ${rc}):"
		cat "$errf" >&2
		rm -f "$errf"
		return 1
	fi
	rm -f "$errf"
	printf '%s' "$out" | node -e "$SAME_JS" "$tgz" "$spec" || return 1
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
	# Slurped, so the answer must be exactly one JSON document: jq 1.6 does not fail `-e` on
	# empty input, and an answer of several documents would otherwise be read one by one.
	if ! reviewers=$(printf '%s' "$body" | jq -ers --arg env "$env" '
		if length != 1 then error("not an environment") else .[0] end
		| if (type == "object") and (.name == $env) and ((.protection_rules // []) | type == "array")
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
	# Accepted while the project has one maintainer who can approve: with 'Prevent self-review'
	# on, nobody could approve that maintainer's release. The warning stays, so that it is seen
	# on every release until a second reviewer exists. docs/releasing.md, "Self-approval".
	if [ "$(printf '%s' "$body" | jq -r '[.protection_rules[] | select(.type == "required_reviewers") | .prevent_self_review] | any')" != true ]; then
		echo "::warning::Environment '${env}' lets whoever dispatches the release approve it. This is accepted while the project has a single maintainer who can approve (docs/releasing.md, 'Self-approval'); turn on 'Prevent self-review' once a second reviewer is added."
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
#   - each names every lockstep sibling at exactly <version>, changes nothing but "version"
#     and those siblings' specs (pin_siblings), and carries no publishConfig.
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
			err "v${version} (${commit}) changes packages/${ok}/package.json beyond its \"version\" and its lockstep siblings, or leaves a sibling at another version; a release commit sets exactly those to v${version}."
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
		err "The version to verify, '${version}', is not major.minor.patch; refusing."
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

# A republish finishes a release that master records. A release-shaped commit tagged on a side
# branch was never released, so its tag must be an ancestor of master as master is NOW: fetched
# here, in full. A shallow history, a failed fetch or a missing ref cannot show ancestry, so
# each of them refuses.
# Fetches master from origin afresh, into refs/remotes/origin/master. Fails, saying <what>
# cannot be told, if the fetch fails, if origin/master is missing after it, or if the history
# is shallow: the fetch does not deepen a shallow clone, and shallow history cannot prove that
# a commit is NOT on master's line, nor, past its boundary, that it is.
fetch_master() {
	local what="$1"
	if ! git fetch --quiet --no-tags origin "+refs/heads/master:refs/remotes/origin/master"; then
		err "Could not fetch master from origin, so cannot tell ${what}."
		return 1
	fi
	if ! git rev-parse -q --verify "refs/remotes/origin/master^{commit}" >/dev/null; then
		err "origin/master is missing after the fetch, so cannot tell ${what}."
		return 1
	fi
	if [ "$(git rev-parse --is-shallow-repository)" != false ]; then
		err "This history is shallow, so cannot tell ${what}."
		return 1
	fi
}

assert_on_master() {
	local head
	head=$(git rev-parse HEAD)
	if ! fetch_master "whether ${head} is on master"; then
		err "Refusing to republish."
		return 1
	fi
	if ! git merge-base --is-ancestor "$head" "refs/remotes/origin/master"; then
		err "${head} is not on master (not an ancestor of origin/master): a tag on a side branch is not a release. Refusing to republish."
		return 1
	fi
	echo "${head} is on master."
}

# The one semver comparison. Reads versions, whitespace-separated, on stdin, and prints true if
# <version> (its first argument) is not a prerelease and no release among them (major.minor.patch,
# an optional leading v) is a higher semver, else false. An equal version is not higher, and a
# prerelease among them is skipped (npm's own implicit-latest check skips them too). Anything
# else among them is skipped too, unless the second argument is "strict": then it fails. Fails
# if <version> is not semver.
# shellcheck disable=SC2016 # JavaScript, not shell
NEWEST_JS='
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const parse = (t) => {
	const m = SEMVER.exec(t);
	return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] } : null;
};
const cmp = (a, b) => {
	for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
	return 0;
};
const [version, mode] = process.argv.slice(1);
const me = parse(version);
if (!me) {
	console.error(`::error::${version} is not a semver version.`);
	process.exit(1);
}
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
	const tokens = s.split(/\s+/).filter(Boolean);
	const bad = tokens.filter((t) => !parse(t));
	if (mode === "strict" && bad.length > 0) {
		console.error(`::error::Not a semver version: ${JSON.stringify(bad[0])}.`);
		process.exit(1);
	}
	const releases = tokens.map(parse).filter((t) => t && t.pre === undefined);
	const newest = me.pre === undefined && releases.every((t) => cmp(t, me) <= 0);
	console.log(newest ? "true" : "false");
});
'

# Reads `npm view <name> versions --json` on stdin and prints each version on its own line. The
# answer must be a JSON array of strings (or one string, for a single version); anything else
# fails, and so does a string that is not one version (whitespace in it).
# shellcheck disable=SC2016 # JavaScript, not shell
VERSIONS_JS='
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
	let v;
	try { v = JSON.parse(s); } catch (e) { v = undefined; }
	const list = typeof v === "string" ? [v] : v;
	if (!Array.isArray(list) || !list.every((x) => typeof x === "string" && /^\S+$/.test(x))) {
		console.error(`::error::npm answered ${JSON.stringify(s.slice(0, 200))}, not a list of versions.`);
		process.exit(1);
	}
	for (const x of list) console.log(x);
});
'

# Classifies a failed `npm view <name> ... --json` from the error npm prints on stdout with
# --json ({"error": {"code", "summary", "detail"}}; lib/utils/error-message.js, npm 10.9.2 and
# 11.19.0). Prints "absent" only for the registry's own 404 for the package document, which
# npm reports as code E404 with the summary "Not Found - GET <registry><name>" (npm-registry-
# fetch's message; the registry may append " - <reason>"). Prints "unpublished: ..." for E404
# "Unpublished on <time>" (lib/commands/view.js, when the package's time.unpublished is set),
# and "other: <code>: <summary>" for anything else, E404 "No match found for version <tag>"
# included (a version or tag that matched nothing is not a package that does not exist).
# Argument: the package document's URL.
# shellcheck disable=SC2016 # JavaScript, not shell
NPM_404_JS='
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
	let e;
	try { e = JSON.parse(s).error; } catch (x) { e = undefined; }
	if (e === null || typeof e !== "object" || typeof e.code !== "string" || typeof e.summary !== "string") {
		console.log("other: npm printed no error it names");
		return;
	}
	const head = "Not Found - GET " + process.argv[1];
	const packageGone = e.summary === head || (e.summary.startsWith(head + " - ") && !e.summary.includes("\n"));
	if (e.code === "E404" && packageGone) console.log("absent");
	else if (e.code === "E404" && /^Unpublished on /.test(e.summary)) console.log("unpublished: " + e.summary);
	else console.log("other: " + e.code + ": " + e.summary.split("\n")[0]);
});
'

# Whether no v* release tag on master is a higher semver than v<version>. Only a tag whose
# commit is on master (reachable from origin/master) is a release: a v* tag pushed for an
# abandoned branch is not, and must not make the newest release look old. Tags and master are
# fetched first, here, so a newer release made since this run started counts and nothing
# depends on what ran before; if either cannot be fetched, or the history is shallow, it fails,
# never counting every tag instead. v<version> itself need not be on master yet (a new
# release's tag is pushed after this runs): it is compared against the others. Prints true or
# false; fails if it cannot tell.
newest_among_tags() {
	local version="$1" tags
	if ! git fetch --quiet --tags origin; then
		err "Could not fetch tags from origin, so cannot tell whether v${version} is the newest release."
		return 1
	fi
	fetch_master "whether v${version} is the newest release" || return 1
	tags=$(git tag -l 'v*' --merged refs/remotes/origin/master) || return 1
	printf '%s\n' "$tags" | node -e "$NEWEST_JS" "$version" || return 1
}

# Whether no lockstep package has a published version that is a higher semver than <version>:
# npm's own rule for refusing an implicit latest (the highest version it holds, prereleases
# skipped), checked here for all six before any is published. `npm view` is given --tag latest
# so that no tag config (from an .npmrc as well as the environment) narrows what it reads. A
# package npm has never published (the registry's 404 for it; NPM_404_JS) holds nothing; an
# equal version (a partial republish) is not higher. Anything else fails, never reading as
# "nothing newer": an unreadable registry, any other E404 (a version or tag that matched
# nothing), an unpublished package (which versions it held cannot be read), an answer that is
# not a list of versions, or a version in it that is not semver. Prints true or false.
newest_on_npm() {
	local version="$1" entry pkg out rc errf list kind all=""
	for entry in $PACKAGES; do
		pkg="${entry##*:}"
		errf=$(mktemp) || return 1
		set +e
		out=$(npm view "$pkg" versions --json --tag latest --registry "$REGISTRY" 2>"$errf")
		rc=$?
		set -e
		if [ "$rc" -ne 0 ]; then
			kind=$(printf '%s' "$out" | node -e "$NPM_404_JS" "${REGISTRY}${pkg}") || kind="other: unreadable"
			case "$kind" in
			absent)
				rm -f "$errf"
				continue
				;;
			unpublished:*)
				err "${pkg} was unpublished from npm (${kind#unpublished: }), so which versions it held cannot be read. Refusing."
				;;
			*)
				err "Could not read the versions of ${pkg} on npm (npm view exited ${rc}; ${kind#other: }):"
				;;
			esac
			cat "$errf" >&2
			rm -f "$errf"
			return 1
		fi
		rm -f "$errf"
		if ! list=$(printf '%s' "$out" | node -e "$VERSIONS_JS"); then
			err "Could not read the versions of ${pkg} on npm."
			return 1
		fi
		all="${all} ${list}"
	done
	if ! printf '%s\n' "$all" | node -e "$NEWEST_JS" "$version" strict; then
		err "A version npm holds is not semver, so cannot tell whether it is newer than ${version}."
		return 1
	fi
}

# Whether v<version> is the newest release: the one answer that decides both the GitHub
# Release's Latest and the npm dist-tag (dist_tag). True only if it is not a prerelease, no v*
# release tag on master is a higher semver (newest_among_tags), and no package has a higher version on
# npm (newest_on_npm: a version published without a tag, whose tag was lost, or under another
# dist-tag still counts). A republish of an older version must never take Latest from a newer one.
# Prints true or false; fails if either check cannot tell.
latest_flag() {
	local version="${1:-}" tags npm
	if [ -z "$version" ]; then
		err "latest-flag needs the version"
		return 1
	fi
	tags=$(newest_among_tags "$version") || return 1
	if ! npm=$(newest_on_npm "$version"); then
		err "Could not read every package's versions from npm, so cannot tell whether v${version} is the newest release."
		return 1
	fi
	case "${tags}:${npm}" in
	true:true) echo true ;;
	true:false | false:true | false:false) echo false ;;
	*)
		err "Could not tell whether v${version} is the newest release (tags: '${tags}', npm: '${npm}')."
		return 1
		;;
	esac
}

# The npm dist-tag v<version> publishes under, decided by latest_flag, the same answer that
# decides the GitHub Release's Latest: "latest" for the newest release, "backfill" for an
# older version (a republish), so that finishing an old version never moves npm's latest back
# to it. latest_flag reads every package's versions on npm as well as the tags, so the decision
# is made for all six before any is published (see publish). Fails if latest_flag cannot tell: it never
# defaults to latest.
dist_tag() {
	local version="${1:-}" flag
	if ! flag=$(latest_flag "$version"); then
		err "Could not tell whether v${version} is the newest release, so its npm dist-tag is unknown. Refusing to publish."
		return 1
	fi
	case "$flag" in
	true) echo latest ;;
	false) echo backfill ;;
	*)
		err "latest-flag answered '${flag}' for v${version}, not true or false. Refusing to publish."
		return 1
		;;
	esac
}

# Whether release version <a> (major.minor.patch, digits only) is at least <b>. Fails on
# anything else, so a version it cannot read never passes.
version_at_least() {
	local a="$1" b="$2" x y i
	valid_version "$a" && valid_version "$b" || return 1
	for i in 1 2 3; do
		x=$(printf '%s' "$a" | cut -d. -f"$i")
		y=$(printf '%s' "$b" | cut -d. -f"$i")
		if [ "$((10#$x))" -gt "$((10#$y))" ]; then return 0; fi
		if [ "$((10#$x))" -lt "$((10#$y))" ]; then return 1; fi
	done
	return 0
}

# The floor the publish job needs, before anything reads or writes the registry:
#   - npm trusted publishing (OIDC) needs npm 11.5.1 or later and Node 22.14.0 or later
#     (docs.npmjs.com/trusted-publishers). npm tries it on every publish by itself and falls
#     back to the configured token (lib/utils/oidc.js, called from lib/commands/publish.js);
#     below the floor it would publish with the token alone, silently.
#   - npm's refusal to apply latest implicitly to a version not higher than one npm holds (see
#     publish), which npm added in 11.0.0 (lib/commands/publish.js; absent in 10.9).
# Prints node's and npm's versions, and fails unless both are at or above the floor. A version
# it cannot read fails too.
NPM_FLOOR="11.5.1"
NODE_FLOOR="22.14.0"
assert_npm() {
	local nodev npmv
	nodev=$(node --version) || return 1
	npmv=$(npm --version) || return 1
	echo "node ${nodev}, npm ${npmv}"
	if ! valid_version "$npmv"; then
		err "Could not read npm's version ('${npmv}'). Refusing to release."
		return 1
	fi
	if ! valid_version "${nodev#v}"; then
		err "Could not read node's version ('${nodev}'). Refusing to release."
		return 1
	fi
	if ! version_at_least "$npmv" "$NPM_FLOOR"; then
		err "npm ${npmv} is older than ${NPM_FLOOR}. npm trusted publishing needs npm ${NPM_FLOOR} or later and Node ${NODE_FLOOR} or later (docs.npmjs.com/trusted-publishers), and npm 11.0.0 added the refusal to apply latest implicitly to a lower version (the backstop for the dist-tag check). Refusing to release."
		return 1
	fi
	if ! version_at_least "${nodev#v}" "$NODE_FLOOR"; then
		err "Node ${nodev} is older than ${NODE_FLOOR}, which npm trusted publishing needs (docs.npmjs.com/trusted-publishers). Refusing to release."
		return 1
	fi
	echo "npm ${npmv} >= ${NPM_FLOOR} and node ${nodev} >= ${NODE_FLOOR}: npm uses trusted publishing (OIDC) where npmjs.com trusts this workflow, and the token otherwise."
}

# Annotates the release tag on <commit> in the publish job, replacing the one the build job made
# (whose message is never read): the version, then, for a major released early, its reason
# (ALLOW_EARLY_MAJOR). The tag is pushed with the release commit, so the reason outlives the run:
# a republish, which refuses allow_early_major, reads it back with release-note.
tag_release() {
	local version="${1:-}" commit="${2:-}"
	local message=(-m "v${version}")
	if ! valid_version "$version" || [ -z "$commit" ]; then
		err "usage: tag-release <version> <commit>"
		return 1
	fi
	if [ -n "${ALLOW_EARLY_MAJOR:-}" ]; then
		message+=(-m "Released less than 90 days after the previous major: ${ALLOW_EARLY_MAJOR}")
	fi
	git -c user.name="github-actions[bot]" \
		-c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
		tag -a -f "${message[@]}" "v${version}" "${commit}^{commit}" > /dev/null
}

# What leads the GitHub Release's notes: the release tag's message after its first line (an
# early major's reason), or nothing. The tag must be an annotated one; any other is refused, so a
# reason can never be lost by reading the wrong object.
release_note() {
	local version="${1:-}"
	if ! valid_version "$version"; then
		err "usage: release-note <version>"
		return 1
	fi
	if [ "$(git cat-file -t "refs/tags/v${version}" 2> /dev/null)" != tag ]; then
		err "v${version} is not an annotated tag here; refusing to guess the release notes."
		return 1
	fi
	git for-each-ref --format='%(contents:body)' "refs/tags/v${version}"
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
pin-siblings) pin_siblings ;;
version-at) version_at "${2:?usage: version-at <commit>}" ;;
verify-release) verify_release "${2:-}" "${3:-}" ;;
expected-version) expected_version "${2:-}" ;;
assert-bump) assert_bump "${2:-}" ;;
assert-published) assert_published ;;
assert-unreleased) assert_unreleased ;;
assert-protected) assert_protected "${2:-}" ;;
assert-npm) assert_npm ;;
release-parent) verify_release_commit HEAD ;;
latest-flag) latest_flag "${2:-}" ;;
tag-release) tag_release "${2:-}" "${3:-}" ;;
release-note) release_note "${2:-}" ;;
dist-tag) dist_tag "${2:-}" ;;
pack) pack "${2:-}" ;;
publish) publish "${2:-}" "${3:-}" "${4:-}" ;;
compare-builds) compare_builds "${2:-}" "${3:-}" "${4:-}" ;;
gate) gate ;;
*)
	err "usage: release.sh dirs | names | version | pin-siblings | version-at <commit> | expected-version <bump> | assert-bump <bump> | assert-published | assert-unreleased | assert-protected <env> | assert-npm | gate | release-parent | verify-release <bundle> <version> | latest-flag <version> | tag-release <version> <commit> | release-note <version> | dist-tag <version> | pack <dir> | publish <dir> <commit> [--dry-run] | compare-builds <dir> <rebuild dir> <commit>"
	exit 2
	;;
esac
