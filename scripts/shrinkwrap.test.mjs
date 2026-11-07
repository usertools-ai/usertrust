// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.
//
// scripts/shrinkwrap.mjs: the tree a released server or dashboard ships, written from the root
// lockfile. Fixture lockfiles pin each rule; the real tree is checked at HEAD.
// Run with `node --test scripts/shrinkwrap.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { commitOf, Refused, render, shrinkwrap } from "./shrinkwrap.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const third = (version, extra = {}) => ({
	version,
	resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`,
	integrity: `sha512-${version}`,
	license: "MIT",
	...extra,
});
/** A workspace: packages/server -> usertrust (packages/core) -> a; server -> b (nested c under b). */
function world() {
	const manifests = {
		"packages/server": {
			name: "usertrust-server",
			version: "2.0.0",
			license: "Apache-2.0",
			dependencies: { usertrust: "2.0.0", b: "^1.0.0" },
			devDependencies: { devonly: "^1" },
		},
		"packages/core": {
			name: "usertrust",
			version: "2.0.0",
			license: "Apache-2.0",
			dependencies: { a: "^3.0.0" },
		},
	};
	const lock = {
		name: "root",
		lockfileVersion: 3,
		packages: {
			"": { name: "root" },
			"node_modules/usertrust": { link: true, resolved: "packages/core" },
			"node_modules/usertrust-server": { link: true, resolved: "packages/server" },
			"packages/server": { version: "1.9.0", dependencies: { usertrust: "1.9.0" } }, // stale, as after a bump
			"packages/core": { version: "1.9.0" },
			"node_modules/a": third("3.1.0"),
			"node_modules/b": third("1.2.0", { dependencies: { c: "^2.0.0" } }),
			"node_modules/b/node_modules/c": third("2.5.0"),
			"node_modules/c": third("1.0.0"), // a different c at the root: b's own nested one must win
			"node_modules/devonly": third("1.0.0", { dev: true }),
		},
	};
	return { lock, manifestOf: (p) => manifests[p], manifests };
}

describe("shrinkwrap", () => {
	it("is the run-time closure, with node's resolution, siblings at the release version, no dev dependencies", () => {
		const { lock, manifestOf } = world();
		const sw = shrinkwrap(lock, manifestOf, "server", "2.0.0");
		assert.deepEqual(Object.keys(sw.packages), [
			"",
			"node_modules/a",
			"node_modules/b",
			"node_modules/b/node_modules/c",
			"node_modules/usertrust",
		]);
		assert.equal(sw.lockfileVersion, 3);
		assert.equal(sw.packages[""].version, "2.0.0");
		assert.equal(sw.packages["node_modules/b/node_modules/c"].version, "2.5.0");
		assert.deepEqual(sw.packages["node_modules/usertrust"], {
			dependencies: { a: "^3.0.0" },
			license: "Apache-2.0",
			resolved: "https://registry.npmjs.org/usertrust/-/usertrust-2.0.0.tgz",
			version: "2.0.0",
		});
		// A third-party entry is the lockfile's, field for field.
		assert.deepEqual(sw.packages["node_modules/b"], lock.packages["node_modules/b"]);
		assert.ok(!JSON.stringify(sw).includes("devonly"));
	});

	it("gives the same bytes every time, with sorted keys", () => {
		const { lock, manifestOf } = world();
		const a = render(shrinkwrap(lock, manifestOf, "server", "2.0.0"));
		const b = render(shrinkwrap(JSON.parse(JSON.stringify(lock)), manifestOf, "server", "2.0.0"));
		assert.equal(a, b);
		assert.ok(a.endsWith("}\n"));
		assert.deepEqual(Object.keys(JSON.parse(a)), [
			"lockfileVersion",
			"name",
			"packages",
			"requires",
			"version",
		]);
	});

	it("a changed lockfile changes the shipped tree (the tree follows the lockfile, not the registry)", () => {
		const { lock, manifestOf } = world();
		const before = render(shrinkwrap(lock, manifestOf, "server", "2.0.0"));
		lock.packages["node_modules/a"] = third("3.2.0");
		const after = shrinkwrap(lock, manifestOf, "server", "2.0.0");
		assert.notEqual(render(after), before);
		assert.equal(after.packages["node_modules/a"].version, "3.2.0");
	});

	it("a sibling's own nested module lands under that sibling", () => {
		const { lock, manifestOf } = world();
		lock.packages["packages/core/node_modules/a"] = third("3.0.5");
		const sw = shrinkwrap(lock, manifestOf, "server", "2.0.0");
		assert.equal(sw.packages["node_modules/usertrust/node_modules/a"].version, "3.0.5");
		assert.equal(sw.packages["node_modules/a"], undefined);
	});

	it("refuses a sibling not pinned to the release's version", () => {
		const { lock, manifestOf, manifests } = world();
		manifests["packages/server"].dependencies.usertrust = "^2.0.0";
		assert.throws(
			() => shrinkwrap(lock, manifestOf, "server", "2.0.0"),
			(e) => e instanceof Refused && /pins usertrust to \^2\.0\.0/.test(e.message),
		);
	});

	it("refuses a required dependency the lockfile does not hold, and skips a missing optional one", () => {
		const { lock, manifestOf, manifests } = world();
		manifests["packages/core"].optionalDependencies = { "fsevents-like": "^1" };
		assert.doesNotThrow(() => shrinkwrap(lock, manifestOf, "server", "2.0.0"));
		delete lock.packages["node_modules/a"];
		assert.throws(
			() => shrinkwrap(lock, manifestOf, "server", "2.0.0"),
			(e) =>
				e instanceof Refused && /needs a, which the root lockfile does not hold/.test(e.message),
		);
	});

	it("refuses a run-time dependency the lockfile marks dev (a stale lockfile)", () => {
		const { lock, manifestOf } = world();
		lock.packages["node_modules/a"] = third("3.1.0", { dev: true });
		assert.throws(
			() => shrinkwrap(lock, manifestOf, "server", "2.0.0"),
			(e) => e instanceof Refused && /marks it dev/.test(e.message),
		);
	});

	it("refuses two lockfile packages that would land at one place", () => {
		// server's own nested a@9 lands at node_modules/a; core resolves the root's a@3, also node_modules/a.
		const { lock, manifestOf, manifests } = world();
		manifests["packages/server"].dependencies.a = "^9.0.0";
		lock.packages["packages/server/node_modules/a"] = third("9.0.0");
		assert.throws(
			() => shrinkwrap(lock, manifestOf, "server", "2.0.0"),
			(e) => e instanceof Refused && /would both land at node_modules\/a/.test(e.message),
		);
	});

	it("refuses a lockfile older than version 2", () => {
		const { manifestOf } = world();
		assert.throws(
			() => shrinkwrap({ lockfileVersion: 1, dependencies: {} }, manifestOf, "server", "2.0.0"),
			Refused,
		);
	});
});

describe("the commit it reads", () => {
	it("is resolved to a 40-hex sha; an option-like or unknown revision is refused before any blob is read", () => {
		assert.match(commitOf("HEAD"), /^[0-9a-f]{40}$/);
		for (const bad of ["--output=/tmp/x", "-p", "", "no-such-revision-at-all"]) {
			assert.throws(() => commitOf(bad), Refused, bad);
		}
		const r = spawnSync(
			"node",
			[`${ROOT}scripts/shrinkwrap.mjs`, "--output=/tmp/x", "server", "1.0.0"],
			{ cwd: ROOT, encoding: "utf8" },
		);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /refused: not a revision: --output=\/tmp\/x/);
	});
});

describe("the real tree at HEAD", () => {
	const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
	for (const dir of ["server", "ui"]) {
		it(`${dir}: every third-party entry is the root lockfile's, and our siblings are at the lockstep version`, () => {
			const out = execFileSync(
				"node",
				[
					`${ROOT}scripts/shrinkwrap.mjs`,
					"HEAD",
					dir,
					JSON.parse(
						execFileSync("git", ["show", `HEAD:packages/${dir}/package.json`], {
							cwd: ROOT,
							encoding: "utf8",
						}),
					).version,
				],
				{
					cwd: ROOT,
					encoding: "utf8",
				},
			);
			const sw = JSON.parse(out);
			const version = sw.version;
			let third = 0;
			for (const [place, entry] of Object.entries(sw.packages)) {
				if (place === "") continue;
				const name = place.slice(place.lastIndexOf("node_modules/") + "node_modules/".length);
				if (name === "usertrust" || name.startsWith("usertrust-")) {
					assert.equal(entry.version, version, `${place} is not at ${version}`);
					assert.equal(entry.integrity, undefined);
					continue;
				}
				third++;
				const inLock = Object.entries(lock.packages).filter(
					([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`),
				);
				assert.ok(
					inLock.some(
						([, m]) =>
							m.version === entry.version &&
							m.integrity === entry.integrity &&
							m.resolved === entry.resolved,
					),
					`${place}@${entry.version} is not the lockfile's`,
				);
			}
			assert.ok(third > 0, `${dir} ships no third-party entries: the walk found nothing`);
		});
	}
});
