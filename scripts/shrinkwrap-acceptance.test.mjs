// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.
//
// The shipped dependency tree's checks (docs/releasing.md, "The shipped dependency tree"), with no network:
// - shrinkwrap-acceptance.mjs `placed`, the comparator every install row and the post-release check rely on;
// - shrinkwrap-acceptance.sh's mode argument;
// - shrinkwrap-published.sh, the release's post-publish check, against a fake npm that serves this
//   commit's real shrinkwraps (`release.sh shrinkwrap HEAD`), each case breaking one thing.
// Run with `node --test scripts/shrinkwrap-acceptance.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const HELP = join(ROOT, "scripts/shrinkwrap-acceptance.mjs");
const fresh = (tag) => mkdtempSync(join(process.env.TMPDIR || tmpdir(), `${tag}-`));

/** An install directory whose npm lockfile records `tree` (place -> version) under node_modules/<pkg>. */
function installed(pkg, tree) {
	const dir = fresh("placed");
	const packages = { "": {}, [`node_modules/${pkg}`]: { version: "1.0.0" } };
	for (const [place, version] of Object.entries(tree))
		packages[`node_modules/${pkg}/${place}`] = { version };
	mkdirSync(join(dir, "node_modules"));
	writeFileSync(
		join(dir, "node_modules/.package-lock.json"),
		JSON.stringify({ lockfileVersion: 3, packages }),
	);
	return dir;
}
function shrinkwrapFile(tree) {
	const f = join(fresh("sw"), "npm-shrinkwrap.json");
	const packages = { "": { name: "p", version: "1.0.0" } };
	for (const [place, version] of Object.entries(tree)) packages[place] = { version };
	writeFileSync(f, JSON.stringify({ lockfileVersion: 3, packages }));
	return f;
}
const placed = (dir, pkg, file) =>
	spawnSync(process.execPath, [HELP, "placed", dir, pkg, file], { encoding: "utf8" });

describe("shrinkwrap-acceptance.mjs placed", () => {
	const want = {
		"node_modules/a": "1.2.0",
		"node_modules/b/node_modules/c": "2.0.0",
		"node_modules/b": "3.0.0",
	};
	it("HONOURED when every entry is at its place with its version, and nothing else is beneath", () => {
		const r = placed(installed("p", want), "p", shrinkwrapFile(want));
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.stdout, /^HONOURED p: all 3 entries/);
	});
	it("NOT-HONOURED when an entry is installed at another version", () => {
		const r = placed(
			installed("p", { ...want, "node_modules/a": "1.3.0" }),
			"p",
			shrinkwrapFile(want),
		);
		assert.equal(r.status, 1);
		assert.match(r.stdout, /NOT-HONOURED p: 1 of 3/);
		assert.match(r.stdout, /node_modules\/p\/node_modules\/a: want 1\.2\.0, installed 1\.3\.0/);
	});
	it("NOT-HONOURED when an entry is missing (hoisted out from under the package)", () => {
		const { "node_modules/b/node_modules/c": _, ...hoisted } = want;
		const r = placed(installed("p", hoisted), "p", shrinkwrapFile(want));
		assert.equal(r.status, 1);
		assert.match(r.stdout, /node_modules\/b\/node_modules\/c: want 2\.0\.0, installed nothing/);
	});
	it("NOT-HONOURED when something the shrinkwrap does not name is installed beneath it", () => {
		const r = placed(
			installed("p", { ...want, "node_modules/extra": "9.9.9" }),
			"p",
			shrinkwrapFile(want),
		);
		assert.equal(r.status, 1);
		assert.match(
			r.stdout,
			/node_modules\/p\/node_modules\/extra@9\.9\.9: installed, not in the shrinkwrap/,
		);
	});
	it("NOT-HONOURED for an empty shrinkwrap: nothing compared is never a pass", () => {
		const r = placed(installed("p", {}), "p", shrinkwrapFile({}));
		assert.equal(r.status, 1);
		assert.match(r.stdout, /nothing was compared/);
	});
});

describe("shrinkwrap-acceptance.sh", () => {
	for (const args of [[], ["verdaccio"], ["both"]]) {
		it(`refuses ${args.length ? `the mode "${args[0]}"` : "no mode"} with usage, exit 2`, () => {
			const r = spawnSync("bash", [join(ROOT, "scripts/shrinkwrap-acceptance.sh"), ...args], {
				cwd: ROOT,
				encoding: "utf8",
			});
			assert.equal(r.status, 2, r.stderr);
			assert.match(r.stderr, /usage: shrinkwrap-acceptance\.sh files\|registry/);
		});
	}
	it("has no local registry left in it", () => {
		assert.doesNotMatch(
			readFileSync(join(ROOT, "scripts/shrinkwrap-acceptance.sh"), "utf8"),
			/verdaccio/i,
		);
	});
});

// The fake npm: `view <pkg>@<v> _hasShrinkwrap`, `pack <pkg>@<v>` and `install ... <pkg>@<v>`, read from $FAKE:
//   flag-<pkg>       what view prints (default "true")
//   served-<pkg>.json the npm-shrinkwrap.json pack puts in the tarball (none: no file in the tarball)
//   installed-<pkg>.json the tree install places under node_modules/<pkg> (default: served)
//   calls             one line per call
const FAKE_NPM = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const F = process.env.FAKE, a = process.argv.slice(2), spec = a.find((x, i) => i > 0 && /^[^-].*@/.test(x));
const pkg = spec.slice(0, spec.lastIndexOf("@")), ver = spec.slice(spec.lastIndexOf("@") + 1);
fs.appendFileSync(path.join(F, "calls"), a.join(" ") + "\\n");
const opt = (n) => { const f = path.join(F, n); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined; };
if (a[0] === "view") { process.stdout.write((opt("flag-" + pkg) ?? "true").trim() + "\\n"); process.exit(0); }
if (a[0] === "pack") {
	const t = fs.mkdtempSync(path.join(F, "pack-")); fs.mkdirSync(path.join(t, "package"));
	fs.writeFileSync(path.join(t, "package/package.json"), JSON.stringify({ name: pkg, version: ver }));
	const sw = opt("served-" + pkg + ".json"); if (sw !== undefined) fs.writeFileSync(path.join(t, "package/npm-shrinkwrap.json"), sw);
	execFileSync("tar", ["-czf", path.join(process.cwd(), pkg + "-" + ver + ".tgz"), "-C", t, "package"]); process.exit(0);
}
if (a[0] === "install") {
	const sw = JSON.parse(opt("installed-" + pkg + ".json") ?? opt("served-" + pkg + ".json") ?? '{"packages":{}}');
	const packages = { "": {}, ["node_modules/" + pkg]: { version: ver } };
	for (const [p, e] of Object.entries(sw.packages)) if (p) packages["node_modules/" + pkg + "/" + p] = { version: e.version };
	fs.mkdirSync("node_modules", { recursive: true });
	fs.writeFileSync("node_modules/.package-lock.json", JSON.stringify({ lockfileVersion: 3, packages })); process.exit(0);
}
process.exit(9);
`;

describe("shrinkwrap-published.sh (the release's post-publish check)", { timeout: 120_000 }, () => {
	const version = execFileSync("bash", [join(ROOT, "scripts/release.sh"), "version"], {
		cwd: ROOT,
		encoding: "utf8",
	}).trim();
	const real = {};
	before(() => {
		for (const [d, pkg] of [
			["server", "usertrust-server"],
			["ui", "usertrust-ui"],
		]) {
			real[pkg] = execFileSync(
				"bash",
				[join(ROOT, "scripts/release.sh"), "shrinkwrap", "HEAD", d, version],
				{
					cwd: ROOT,
					encoding: "utf8",
				},
			);
		}
	});
	/** Runs the check against a fake npm serving this commit's shrinkwraps, after `breakIt(fake dir)`. */
	function run(breakIt = () => {}) {
		const fake = fresh("published");
		const npm = join(fake, "npm");
		writeFileSync(npm, FAKE_NPM);
		chmodSync(npm, 0o755);
		for (const [pkg, sw] of Object.entries(real))
			writeFileSync(join(fake, `served-${pkg}.json`), sw);
		breakIt(fake);
		const summary = join(fake, "summary.md");
		const r = spawnSync("bash", [join(ROOT, "scripts/shrinkwrap-published.sh"), version, "HEAD"], {
			cwd: fake,
			encoding: "utf8",
			env: {
				...process.env,
				FAKE: fake,
				SHRINKWRAP_NPM: npm,
				SHRINKWRAP_TRIES: "2",
				SHRINKWRAP_WAIT_S: "0",
				GITHUB_STEP_SUMMARY: summary,
				RUNNER_TEMP: fake,
			},
		});
		let sum = "";
		try {
			sum = readFileSync(summary, "utf8");
		} catch {}
		return {
			...r,
			out: r.stdout + r.stderr,
			sum,
			calls: readFileSync(join(fake, "calls"), "utf8"),
		};
	}
	const moved = (pkg) => {
		const sw = JSON.parse(real[pkg]);
		const place = Object.keys(sw.packages).find((p) => p && sw.packages[p].version);
		sw.packages[place] = { ...sw.packages[place], version: `${sw.packages[place].version}-moved` };
		return { sw: `${JSON.stringify(sw, null, 2)}\n`, place };
	};

	it("passes when the registry serves and installs both packages as this commit's shrinkwraps write them", () => {
		const r = run();
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /OK: usertrust-server and usertrust-ui@/);
		for (const pkg of ["usertrust-server", "usertrust-ui"]) {
			assert.match(
				r.out,
				new RegExp(`${pkg}@${version.replaceAll(".", "\\.")}: _hasShrinkwrap=true`),
			);
			assert.match(r.out, new RegExp(`HONOURED ${pkg}: all \\d+ entries`));
			// all three checks ran against the registry, by name
			for (const verb of ["view", "pack", "install"])
				assert.match(r.calls, new RegExp(`^${verb} .*${pkg}@`, "m"));
		}
		assert.match(r.sum, /are served and installed as their shrinkwraps write them/);
	});

	it("fails loudly when the registry does not set _hasShrinkwrap, and still checks the other package", () => {
		const r = run((f) => writeFileSync(join(f, "flag-usertrust-ui"), "false"));
		assert.equal(r.status, 1, r.out);
		assert.match(
			r.out,
			/::error::usertrust-ui@\S+: the registry reports _hasShrinkwrap=false after 2 tries/,
		);
		assert.match(r.out, /HONOURED usertrust-server/);
		assert.match(r.sum, /FAILED/);
		assert.match(r.sum, /Correct that claim today/);
	});

	it("fails when the registry's tarball carries another shrinkwrap than the commit gives", () => {
		const r = run((f) =>
			writeFileSync(join(f, "served-usertrust-server.json"), moved("usertrust-server").sw),
		);
		assert.equal(r.status, 1, r.out);
		assert.match(
			r.out,
			/::error::usertrust-server@\S+: the registry's npm-shrinkwrap\.json is not the one HEAD gives/,
		);
	});

	it("fails when the registry's tarball carries no shrinkwrap", () => {
		const r = run(
			(f) =>
				writeFileSync(join(f, "served-usertrust-ui.json"), "") ||
				execFileSync("mv", [join(f, "served-usertrust-ui.json"), join(f, "gone.json")]),
		);
		assert.equal(r.status, 1, r.out);
		assert.match(
			r.out,
			/::error::usertrust-ui@\S+: the registry's tarball carries no npm-shrinkwrap\.json/,
		);
	});

	it("fails when a clean install by name places the tree otherwise", () => {
		const { sw, place } = moved("usertrust-server");
		const r = run((f) => writeFileSync(join(f, "installed-usertrust-server.json"), sw));
		assert.equal(r.status, 1, r.out);
		assert.match(r.out, /NOT-HONOURED usertrust-server: 1 of/);
		assert.match(
			r.out,
			new RegExp(`node_modules/usertrust-server/${place.replaceAll("/", "\\/")}: want`),
		);
		assert.match(
			r.out,
			/::error::usertrust-server@\S+: a clean install by name does not place the tree as its shrinkwrap writes it/,
		);
	});
});
