#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.
//
// Helpers for scripts/shrinkwrap-acceptance.sh (CI only; see that file).
//
//   installed <root package-lock.json> <install dir>
//       every third-party package npm installed into <install dir> (its node_modules/.package-lock.json)
//       must be a name@version the root lockfile holds as a run-time package; prints each one that is not,
//       and exits 1 when there is any
//   candidate <npm-shrinkwrap.json>
//       prints "<place> <name> <range>" for each third-party entry, with the range its requirer asks for
//       (the control picks one it can move to another published version)
//   mutate <npm-shrinkwrap.json> <place> <version> <resolved> <integrity>
//       rewrites that one entry in place
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ours = (name) => name === "usertrust" || name.startsWith("usertrust-");
const nameOf = (place) => place.slice(place.lastIndexOf("node_modules/") + "node_modules/".length);
const read = (f) => JSON.parse(readFileSync(f, "utf8"));

function installed(rootLock, dir) {
	const lock = read(rootLock).packages;
	const have = new Set();
	for (const [k, m] of Object.entries(lock))
		if (k && !m.link && !m.dev && m.version) have.add(`${nameOf(k)}@${m.version}`);
	const got = read(`${dir}/node_modules/.package-lock.json`).packages;
	const bad = [];
	let checked = 0;
	for (const [k, m] of Object.entries(got)) {
		const name = nameOf(k);
		if (!k || ours(name)) continue;
		checked++;
		if (!have.has(`${name}@${m.version}`)) bad.push(`${k}@${m.version}`);
	}
	if (checked === 0) {
		console.log("no third-party package was installed: nothing was compared");
		return 1;
	}
	for (const b of bad) console.log(`not the tested tree: ${b}`);
	console.log(`${checked} third-party packages compared, ${bad.length} not the root lockfile's`);
	return bad.length ? 1 : 0;
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
	const fn = { installed, candidate, mutate }[cmd];
	if (!fn) {
		console.error(
			"usage: shrinkwrap-acceptance.mjs installed <lock> <dir> | candidate <shrinkwrap> | mutate <shrinkwrap> <place> <version> <resolved> <integrity>",
		);
		process.exit(2);
	}
	process.exitCode = fn(...a);
}
