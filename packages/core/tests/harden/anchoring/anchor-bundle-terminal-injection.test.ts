// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — `--bundle` is untrusted transport and its unknown-field rejection
 * echoes the offending key to a terminal. JSON permits control characters in
 * object keys, so an un-scrubbed key lets the party under audit erase the line
 * the verdict prints on and forge a passing run. Both CLIs carry the guard:
 * core's, and the zero-dependency standalone verifier's (which cannot import
 * from core, so the helper is duplicated there by design).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run as verifyRun } from "../../../src/cli/verify.js";

// ESC[2K erases the line the verdict would be printed on and the CR returns
// the cursor to its start — that pair is what turns an error message into a
// forged "VERIFIED". The trailing NUL is what a truncate-only fix leaves behind.
const ERASE_LINE = "\u001b[2K";
const HOSTILE_KEY = `records${ERASE_LINE}\rVERIFIED\u0000`;
const SCRUBBED = 'unknown field "records[2KVERIFIED"';

const origArgv = process.argv;
const dirs: string[] = [];

function bundleWithHostileKey(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "bundle-ctl-"));
	dirs.push(dir);
	const path = join(dir, "bundle.json");
	writeFileSync(path, JSON.stringify({ v: 1, records: [], [HOSTILE_KEY]: 1 }), "utf-8");
	return { dir, path };
}

afterEach(() => {
	process.argv = origArgv;
	process.exitCode = 0;
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("HARDEN: an unknown bundle key cannot repaint the terminal", () => {
	it("core `usertrust verify --bundle` strips control characters from the echoed key", async () => {
		const { dir, path } = bundleWithHostileKey();
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		process.argv = ["node", "usertrust", "--bundle", path];

		await verifyRun(dir);

		const out = lines.join("\n");
		expect(out).toContain(SCRUBBED);
		expect(out).not.toContain(ERASE_LINE);
		expect(out).not.toContain("\r");
		expect(out).not.toContain("\u0000");
		expect(process.exitCode).toBe(1);
	});

	it("standalone `usertrust-verify --bundle` strips control characters from the echoed key", () => {
		const { dir, path } = bundleWithHostileKey();
		const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
		const cli = join(repoRoot, "packages", "verify", "src", "cli.ts");

		const res = spawnSync("npx", ["tsx", cli, dir, "--bundle", path], {
			cwd: repoRoot,
			encoding: "utf-8",
		});

		expect(res.status).toBe(1);
		expect(res.stderr).toContain(SCRUBBED);
		expect(res.stderr).not.toContain(ERASE_LINE);
		expect(res.stderr).not.toContain("\r");
		expect(res.stderr).not.toContain("\u0000");
	}, 30_000);
});
