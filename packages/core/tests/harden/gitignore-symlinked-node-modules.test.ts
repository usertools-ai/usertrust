// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A node_modules that is a symlink is ignored, like one that is a directory.
 *
 * An ignore pattern with a trailing slash (`node_modules/`) matches directories only. A checkout
 * that links its install from another checkout has `node_modules` as a symlink, which git treats
 * as a file: the pattern misses it, `git status` lists it as untracked, and a broad `git add`
 * commits a link to a path on the author's machine. The pattern without the slash matches both.
 *
 * The rows copy every tracked .gitignore into a scratch repository, so the checkout's own state
 * (an installed node_modules is a real directory) cannot decide the answer, and run git with no
 * global or system configuration and no global excludes file, so a developer's own ignore rules
 * cannot decide it either. Row (c) is the positive control: the same check reports a path that the
 * rules do not ignore. Row (d) is the mutant: the same rules with the trailing slash put back are
 * caught.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const NODE_MODULES_RULE = /^(\/?node_modules)(\/?)$/gm;

/** The caller's environment without anything that points git at another repository or config. */
function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_")) continue;
		env[key] = value;
	}
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CONFIG_NOSYSTEM = "1";
	return env;
}

function git(cwd: string, args: string[]): SpawnSyncReturns<string> {
	const result = spawnSync("git", ["-c", "core.excludesFile=/dev/null", ...args], {
		cwd,
		env: gitEnv(),
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return result;
}

const trackedFiles = (() => {
	const result = git(REPO_ROOT, ["ls-files", "-z"]);
	if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
	return result.stdout.split("\0").filter((f) => f !== "");
})();

const ignoreFiles = trackedFiles.filter((f) => posix.basename(f) === ".gitignore");

/**
 * Every directory a node_modules can appear in: each one whose .gitignore names node_modules, and
 * each workspace package (npm installs a package's own dependencies beside it).
 */
const places = (() => {
	const found = new Set<string>();
	for (const file of ignoreFiles) {
		if (
			new RegExp(NODE_MODULES_RULE.source, "m").test(readFileSync(join(REPO_ROOT, file), "utf8"))
		) {
			found.add(posix.dirname(file));
		}
	}
	for (const file of trackedFiles) {
		const match = /^(packages\/[^/]+)\/package\.json$/.exec(file);
		if (match?.[1] !== undefined) found.add(match[1]);
	}
	return [...found].sort();
})();

const scratchDirs: string[] = [];

afterAll(() => {
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch repository holding the tracked .gitignore files (each passed through `rewrite`), with
 * a node_modules in every place.
 */
function scratchRepo(
	kind: "symlink" | "directory",
	rewrite: (text: string) => string = (text) => text,
): string {
	const repo = mkdtempSync(join(tmpdir(), "ignore-node-modules-"));
	const target = mkdtempSync(join(tmpdir(), "ignore-node-modules-target-"));
	scratchDirs.push(repo, target);
	const init = git(repo, ["init", "-q"]);
	if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
	for (const file of ignoreFiles) {
		mkdirSync(join(repo, posix.dirname(file)), { recursive: true });
		writeFileSync(join(repo, file), rewrite(readFileSync(join(REPO_ROOT, file), "utf8")));
	}
	for (const place of places) {
		const at = join(repo, place, "node_modules");
		mkdirSync(dirname(at), { recursive: true });
		if (kind === "symlink") {
			symlinkSync(target, at);
		} else {
			mkdirSync(at);
			writeFileSync(join(at, "index.js"), "");
		}
	}
	return repo;
}

/** The paths git does NOT ignore; a git error throws, so it can never read as "ignored". */
function notIgnored(repo: string, paths: string[]): string[] {
	return paths.filter((path) => {
		const result = git(repo, ["check-ignore", "-q", "--", path]);
		if (result.status === 0) return false;
		if (result.status === 1) return true;
		throw new Error(`git check-ignore ${path} exited ${result.status}: ${result.stderr}`);
	});
}

const nodeModulesIn = (place: string): string => posix.join(place, "node_modules");

describe("a symlinked node_modules is ignored like a directory", () => {
	it("the places include the root, the site and a workspace package", () => {
		expect(places).toEqual(expect.arrayContaining([".", "site", "packages/core"]));
	});

	it("(a) a node_modules that is a symlink is ignored in every place", () => {
		const repo = scratchRepo("symlink");
		expect(notIgnored(repo, places.map(nodeModulesIn))).toEqual([]);
	});

	it("(b) a node_modules that is a directory is ignored in every place", () => {
		const repo = scratchRepo("directory");
		const files = places.map((place) => posix.join(nodeModulesIn(place), "index.js"));
		expect(notIgnored(repo, files)).toEqual([]);
	});

	it("(c) control: the same check reports a file the rules do not ignore", () => {
		const repo = scratchRepo("symlink");
		const probes = places.map((place) => posix.join(place, "probe.ts"));
		for (const probe of probes) writeFileSync(join(repo, probe), "");
		expect(notIgnored(repo, probes)).toEqual(probes);
	});

	it("(d) mutant: with the trailing slash put back on every rule, the symlinks are caught", () => {
		const repo = scratchRepo("symlink", (text) => text.replace(NODE_MODULES_RULE, "$1/"));
		const paths = places.map(nodeModulesIn);
		expect(notIgnored(repo, paths)).toEqual(paths);
	});
});
