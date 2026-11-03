// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The last-run record is written atomically, and a failed directory sync afterwards is a
 * warning that carries the vault path. A scheduled run must scrub it for the terminal,
 * so a control character in the project's path name never reaches stderr raw.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let failDirSync = false;
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		openSync: (...a: Parameters<typeof real.openSync>) => {
			// Opening the anchors directory read-only is the post-rename directory sync.
			if (failDirSync && a[1] === "r" && String(a[0]).endsWith("anchors")) {
				throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
			}
			return real.openSync(...a);
		},
	};
});

import { run as anchorRun } from "../../../src/cli/anchor.js";
import { cleanupAll, makeAnchoredVault, tmp } from "./fixtures.js";

const origCwd = process.cwd();
const origHome = process.env.HOME;

beforeEach(() => {
	process.env.HOME = tmp("anchor-warn-home-");
});

afterEach(() => {
	process.chdir(origCwd);
	process.env.HOME = origHome;
	delete process.env.USERTRUST_ANCHOR_KEY;
	process.exitCode = 0;
	failDirSync = false;
	vi.restoreAllMocks();
	cleanupAll();
});

async function stderrOf(root: string, keyFile: string, storeFile: string): Promise<string> {
	process.chdir(root);
	process.env.USERTRUST_ANCHOR_KEY = keyFile;
	let err = "";
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		err += String(chunk);
		return true;
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	await anchorRun(["now", "--scheduled", "--sink-file", storeFile], { json: true });
	process.exitCode = 0;
	vi.restoreAllMocks();
	return err;
}

describe("the directory-sync warning of the last-run record", () => {
	it("is scrubbed: a control character in the vault path never reaches stderr", async () => {
		const s = await makeAnchoredVault(3);
		// positive control: with a plain path the same failure does produce a warning
		failDirSync = true;
		const plain = await stderrOf(s.root, s.keyFile, s.storeFile);
		expect(plain).toContain("could not be synced");
		// the same vault reached through a directory whose name holds an escape
		const odd = join(tmp("anchor-warn-"), "\u001b[31mred");
		mkdirSync(odd, { recursive: true });
		const t = await makeAnchoredVault(3);
		const { cpSync } = await import("node:fs");
		cpSync(t.root, join(odd, "v"), { recursive: true });
		const err = await stderrOf(join(odd, "v"), t.keyFile, t.storeFile);
		expect(err).toContain("could not be synced");
		expect(err).not.toContain("\u001b");
	});
});
