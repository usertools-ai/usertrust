// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The transparency-log options were removed from the standalone verifier. The
 * two flags now fail like any other unknown option, and an auditor bundle that
 * still carries the old `rekorReceipts` member is refused by name so the
 * exporter knows to re-export it, rather than the evidence being dropped.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runCli(...args: string[]) {
	const repoRoot = join(import.meta.dirname, "..", "..", "..");
	return spawnSync("npx", ["tsx", join(repoRoot, "packages", "verify", "src", "cli.ts"), ...args], {
		cwd: repoRoot,
		encoding: "utf-8",
	});
}

function emptyVault(): string {
	const root = mkdtempSync(join(tmpdir(), "verify-cli-removed-"));
	dirs.push(root);
	mkdirSync(join(root, ".usertrust", "audit"), { recursive: true });
	writeFileSync(join(root, ".usertrust", "audit", "events.jsonl"), "", "utf-8");
	return join(root, ".usertrust");
}

function writeBundle(body: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "verify-cli-bundle-"));
	dirs.push(dir);
	const file = join(dir, "bundle.json");
	writeFileSync(file, JSON.stringify(body), "utf-8");
	return file;
}

describe("removed transparency-log options", () => {
	it.each(["--rekor-receipts", "--rekor-pubkey"])("%s fails as an unknown option", (flag) => {
		const known = runCli(emptyVault(), "--bogus-option", "x");
		const res = runCli(emptyVault(), flag, "x");
		expect(res.status).toBe(known.status);
		expect(res.status).toBe(1);
		// the same usage text an unknown option gets, and no verdict
		expect(res.stdout).toBe(known.stdout);
		expect(res.stdout).toContain("Usage:");
		expect(res.stdout).not.toContain(flag);
		expect(res.stdout).not.toContain("VERIFIED");
	});

	it("a bundle carrying a rekorReceipts member is refused, naming the removed field", () => {
		const bundle = writeBundle({ v: 1, records: [], rekorReceipts: [] });
		const res = runCli(emptyVault(), "--bundle", bundle);
		expect(res.status).toBe(1);
		expect(res.stderr).toContain("rekorReceipts field was removed");
		expect(res.stderr).toContain("re-export");
	});

	it("a bundle with any other unknown member is still refused as unknown", () => {
		const bundle = writeBundle({ v: 1, records: [], extra: 1 });
		const res = runCli(emptyVault(), "--bundle", bundle);
		expect(res.status).toBe(1);
		expect(res.stderr).toContain('unknown field "extra"');
	});
});
