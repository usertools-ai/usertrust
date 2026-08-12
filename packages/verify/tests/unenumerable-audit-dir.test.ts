// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The STANDALONE verifier must refuse a vault it could not read.
 *
 * `packages/core/src/audit/verify.ts` and this package's `verifyVault` are a
 * mirrored pair (AGENTS.md). The first cut of this fix changed only the core
 * copy, which is the worse half to get right: `usertrust-verify` is the
 * zero-dependency binary an auditor is pointed at *instead of* trusting the SDK,
 * so a clean bill of health from THIS package is the one that matters most.
 *
 * Caught by Codex review, not by a parity test — unlike `anchor-verify.ts`, this
 * pair has no byte-identical seam, so nothing mechanical noticed the one-sided
 * edit. That gap is worth its own follow-up.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyVault } from "../src/index.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "usertrust-verify-unenum-"));
});

afterEach(() => {
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		// Best-effort; the OS reclaims the temp dir regardless.
	}
});

describe("verifyVault — an audit directory that cannot be enumerated", () => {
	it("does NOT report a clean vault it could not read", async () => {
		const vault = join(tmp, ".usertrust");
		const auditDir = join(vault, "audit");
		await mkdir(auditDir, { recursive: true });
		// A segment exists, so this vault is NOT empty. With `events.jsonl` absent
		// and the directory unreadable, this returned `valid: true, chainLength: 0`
		// and the CLI exited 0.
		await writeFile(join(auditDir, "segment-1.jsonl"), "{}\n", "utf-8");
		await chmod(auditDir, 0o000);

		try {
			// Probe rather than pattern-match: root ignores mode 000 entirely, and a
			// test that cannot establish its own precondition must skip, not fail.
			let readable = true;
			try {
				await readdir(auditDir);
			} catch {
				readable = false;
			}
			if (!readable) {
				const result = verifyVault(vault);
				expect(result.valid).toBe(false);
				expect(result.errors.join(" ")).toMatch(/could not be enumerated/i);
			}
		} finally {
			await chmod(auditDir, 0o700);
		}
	});

	it("still verifies a readable empty vault as empty, not as broken", async () => {
		const vault = join(tmp, ".usertrust");
		await mkdir(join(vault, "audit"), { recursive: true });
		const result = verifyVault(vault);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(0);
	});
});
