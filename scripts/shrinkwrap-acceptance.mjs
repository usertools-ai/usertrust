#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.
//
// Helpers for scripts/shrinkwrap-acceptance.sh (CI only; see that file).
//
//   placed <install dir> <package name> <npm-shrinkwrap.json>
//       did npm install <package name>'s dependency tree EXACTLY as that shrinkwrap writes it? Each
//       entry at place P must be installed at node_modules/<package name>/P with its version, and
//       nothing else may be installed under node_modules/<package name>/node_modules (both ways,
//       place by place). Prints HONOURED or NOT-HONOURED with each difference; exit 0 / 1.
//   where <install dir> <name>
//       prints every place <name> is installed at, with its version (for the log)
//   candidate <npm-shrinkwrap.json>
//       prints "<place> <name> <range>" for each third-party entry, with the range its requirer asks
//       for (a control picks one it can move to another published version)
//   mutate <npm-shrinkwrap.json> <place> <version> <resolved> <integrity>
//       rewrites that one entry in place
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ours = (name) => name === "usertrust" || name.startsWith("usertrust-");
const nameOf = (place) => place.slice(place.lastIndexOf("node_modules/") + "node_modules/".length);
const read = (f) => JSON.parse(readFileSync(f, "utf8"));
const installedTree = (dir) => read(`${dir}/node_modules/.package-lock.json`).packages;

function placed(dir, pkg, file) {
	const want = read(file).packages;
	const got = installedTree(dir);
	const base = `node_modules/${pkg}`;
	const diffs = [];
	let n = 0;
	for (const [place, entry] of Object.entries(want)) {
		if (!place) continue;
		n++;
		const at = `${base}/${place}`;
		const have = got[at]?.version;
		if (have !== entry.version)
			diffs.push(`${at}: want ${entry.version}, installed ${have ?? "nothing"}`);
	}
	for (const [at, entry] of Object.entries(got)) {
		if (!at.startsWith(`${base}/node_modules/`)) continue;
		if (!want[at.slice(base.length + 1)])
			diffs.push(`${at}@${entry.version}: installed, not in the shrinkwrap`);
	}
	if (n === 0) diffs.push("the shrinkwrap has no entries: nothing was compared");
	if (diffs.length === 0) {
		console.log(`HONOURED ${pkg}: all ${n} entries at their places, nothing else beneath it`);
		return 0;
	}
	console.log(`NOT-HONOURED ${pkg}: ${diffs.length} of ${n} entries differ`);
	for (const d of diffs.slice(0, 40)) console.log(`  ${d}`);
	return 1;
}

function where(dir, name) {
	const got = installedTree(dir);
	const at = Object.entries(got).filter(([k]) => k && nameOf(k) === name);
	if (at.length === 0) console.log(`${name}: not installed`);
	for (const [k, e] of at) console.log(`${name}: ${k} @ ${e.version}`);
	return 0;
}

function candidate(file) {
	const P = read(file).packages;
	for (const [place, entry] of Object.entries(P)) {
		const name = nameOf(place);
		if (!place || ours(name) || !entry.version) continue;
		// The requirer: the nested parent, else the root, else the first entry that depends on it.
		const i = place.lastIndexOf("/node_modules/");
		const parent = i >= 0 ? place.slice(0, i) : "";
		const req = [P[parent], ...Object.values(P)].find((e) => e?.dependencies?.[name]);
		if (req) console.log(`${place} ${name} ${req.dependencies[name]}`);
	}
	return 0;
}

function mutate(file, place, version, resolved, integrity) {
	const sw = read(file);
	if (!sw.packages[place]) {
		console.log(`no entry ${place}`);
		return 1;
	}
	sw.packages[place] = { ...sw.packages[place], version, resolved, integrity };
	writeFileSync(file, `${JSON.stringify(sw, null, 2)}\n`);
	return 0;
}

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
	const [cmd, ...a] = process.argv.slice(2);
	const fn = { placed, where, candidate, mutate }[cmd];
	if (!fn) {
		console.error(
			"usage: shrinkwrap-acceptance.mjs placed <dir> <pkg> <shrinkwrap> | where <dir> <name> | candidate <shrinkwrap> | mutate <shrinkwrap> <place> <version> <resolved> <integrity>",
		);
		process.exit(2);
	}
	process.exitCode = fn(...a);
}
