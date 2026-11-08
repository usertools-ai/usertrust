#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.
//
// Writes the npm-shrinkwrap.json a released package ships, so that an install gets exactly the
// dependency versions the release was tested with. See docs/releasing.md ("The shipped dependency tree").
//
//   node scripts/shrinkwrap.mjs <commit> <package dir> <version>      (stdout: the npm-shrinkwrap.json)
//
// It reads git BLOBS of <commit> only (the root package-lock.json and the packages' package.json
// files), never the working tree, so one commit always gives the same bytes. The tree is the
// closure of <package dir>'s run-time dependencies in the root lockfile, the one CI's `npm ci`
// installs and tests:
//   - a third-party package is copied from its lockfile entry (version, resolved, integrity and
//     the fields npm reads from a lockfile), at the place node's resolution finds it;
//   - one of our own lockstep packages (a workspace link in the lockfile) becomes a registry entry
//     at <version> with no integrity: its tarball is assembled in the same release, and its exact
//     version on an immutable registry, plus its provenance, already name its bytes;
//   - devDependencies are never followed.
// It refuses (exit 1, a reason on stderr) when a required dependency is missing from the lockfile,
// when two lockfile packages would land at one place in the shipped tree, or when a lockstep
// sibling is not pinned to <version>.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REGISTRY = "https://registry.npmjs.org";
// The lockfile fields npm reads back from a shrinkwrap. Anything else (dev, peer flags of the
// root, funding, ...) is left out, so an entry carries what the install needs and nothing more.
const ENTRY_FIELDS = [
	"version",
	"resolved",
	"integrity",
	"license",
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"bin",
	"engines",
	"os",
	"cpu",
	"libc",
	"optional",
	"hasInstallScript",
];
const MANIFEST_FIELDS = [
	"license",
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"bin",
	"engines",
];

export class Refused extends Error {}

const sortKeys = (v) => {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === "object") {
		const o = {};
		for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
		return o;
	}
	return v;
};
const pick = (from, fields) => {
	const o = {};
	for (const f of fields) if (from[f] !== undefined) o[f] = from[f];
	return o;
};

/**
 * The shrinkwrap for <dir> at <version>, from a root lockfile object and a manifest reader
 * (`manifestOf(path)` returns the parsed package.json at `path`, e.g. "packages/core"). Pure.
 */
export function shrinkwrap(lock, manifestOf, dir, version) {
	if (lock.lockfileVersion < 2 || !lock.packages || typeof lock.packages !== "object") {
		throw new Refused("the root package-lock.json is not lockfileVersion 2 or 3");
	}
	const P = lock.packages;
	const home = `packages/${dir}`;
	const self = manifestOf(home);
	if (!self?.name) throw new Refused(`${home}/package.json has no name`);
	// Our lockstep packages: the workspace links in the lockfile (node_modules/<name> -> packages/<dir>).
	const workspaceOf = new Map(); // "packages/core" -> "usertrust"
	for (const [key, meta] of Object.entries(P)) {
		if (meta.link && typeof meta.resolved === "string" && key.startsWith("node_modules/")) {
			workspaceOf.set(meta.resolved, key.slice("node_modules/".length));
		}
	}
	// Node's resolution of <name> from the package at lockfile key <from>.
	const resolve = (from, name) => {
		let at = from;
		for (;;) {
			const k = at === "" ? `node_modules/${name}` : `${at}/node_modules/${name}`;
			if (P[k]) return k;
			if (at === "") return null;
			const i = at.lastIndexOf("/node_modules/");
			at = i >= 0 ? at.slice(0, i) : ""; // a workspace dir (packages/x) resolves next at the root
		}
	};
	// Where a lockfile key lands in the shipped tree: our package is the root (""), a sibling's
	// own nested modules move under its node_modules/<name>, root-level modules stay where they are.
	const placeOf = (key) => {
		if (key === home) return "";
		if (key.startsWith(`${home}/`)) return key.slice(home.length + 1);
		for (const [wdir, name] of workspaceOf) {
			if (key === wdir) return `node_modules/${name}`;
			if (key.startsWith(`${wdir}/`)) return `node_modules/${name}/${key.slice(wdir.length + 1)}`;
		}
		return key;
	};
	const out = {};
	const sourceAt = new Map(); // place -> lockfile key, to refuse two packages at one place
	const put = (place, key, entry) => {
		const was = sourceAt.get(place);
		if (was !== undefined && was !== key)
			throw new Refused(`${was} and ${key} would both land at ${place}`);
		sourceAt.set(place, key);
		out[place] = entry;
	};
	const queue = [[home, self, true]];
	const seen = new Set();
	while (queue.length) {
		const [key, manifest] = queue.shift();
		if (seen.has(key)) continue;
		seen.add(key);
		const deps = [
			...Object.keys(manifest.dependencies ?? {}).map((n) => [n, false]),
			...Object.keys(manifest.optionalDependencies ?? {}).map((n) => [n, true]),
			...Object.entries(manifest.peerDependencies ?? {})
				.filter(([n]) => !manifest.peerDependenciesMeta?.[n]?.optional)
				.map(([n]) => [n, false]),
		];
		for (const [name, optional] of deps) {
			const at = resolve(key, name);
			if (at === null) {
				if (optional) continue;
				throw new Refused(
					`${key || "the root"} needs ${name}, which the root lockfile does not hold`,
				);
			}
			const meta = P[at];
			if (meta.link) {
				// One of ours: a registry entry at the release's version.
				const wdir = meta.resolved;
				const sib = manifestOf(wdir);
				const want = manifest.dependencies?.[name] ?? manifest.optionalDependencies?.[name];
				if (want !== version)
					throw new Refused(`${key || home} pins ${name} to ${want}, not the release's ${version}`);
				put(placeOf(at), at, {
					...pick(sib, MANIFEST_FIELDS),
					version,
					resolved: `${REGISTRY}/${name}/-/${name.split("/").pop()}-${version}.tgz`,
				});
				queue.push([wdir, sib]);
				continue;
			}
			if (meta.dev && !meta.optional && !meta.peer) {
				// A run-time dependency marked dev would mean the lockfile is stale: refuse rather than guess.
				throw new Refused(
					`${at} is a run-time dependency of ${key || home} but the lockfile marks it dev`,
				);
			}
			put(placeOf(at), at, pick(meta, ENTRY_FIELDS));
			queue.push([at, meta]);
		}
	}
	const root = { name: self.name, version, ...pick(self, MANIFEST_FIELDS) };
	const packages = { "": root };
	for (const place of Object.keys(out).sort()) packages[place] = out[place];
	return sortKeys({ name: self.name, version, lockfileVersion: 3, requires: true, packages });
}

/** The file's bytes: npm's own lockfile format (two-space JSON and a final newline). */
export const render = (sw) => `${JSON.stringify(sw, null, 2)}\n`;

/**
 * The commit a revision names, as a 40-hex sha: a revision that begins with "-" (which git would read as an
 * option) or names no commit is refused before any blob is read.
 */
export function commitOf(rev) {
	if (typeof rev !== "string" || rev === "" || rev.startsWith("-"))
		throw new Refused(`not a revision: ${rev}`);
	let sha;
	try {
		sha = execFileSync(
			"git",
			["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
			{
				encoding: "utf8",
			},
		).trim();
	} catch {
		throw new Refused(`${rev} names no commit`);
	}
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Refused(`${rev} did not resolve to a commit sha`);
	return sha;
}

function blob(commit, path) {
	return execFileSync("git", ["show", `${commit}:${path}`], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
}

// Is this file the command being run? Compared through realpath, so a path with a space or a
// symlinked directory (macOS /tmp and /var) still runs it (the guard of scripts/changelog-guard.mjs).
const runAsCommand = (() => {
	try {
		return (
			process.argv[1] !== undefined &&
			import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
		);
	} catch {
		return false;
	}
})();
if (runAsCommand) {
	const [commit, dir, version] = process.argv.slice(2);
	if (!commit || !dir || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
		process.stderr.write("usage: shrinkwrap.mjs <commit> <package dir> <version>\n");
		process.exit(2);
	}
	try {
		const sha = commitOf(commit);
		const lock = JSON.parse(blob(sha, "package-lock.json"));
		const manifestOf = (path) => JSON.parse(blob(sha, `${path}/package.json`));
		process.stdout.write(render(shrinkwrap(lock, manifestOf, dir, version)));
	} catch (e) {
		process.stderr.write(
			`shrinkwrap: ${e instanceof Refused ? "refused" : "failed"}: ${e.message}\n`,
		);
		process.exit(1);
	}
}
