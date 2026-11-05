// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { afterEach, describe, expect, it, vi } from "vitest";

// A chain can verify and still be missing an event that was dead-lettered. The demo must say so, as `usertrust verify`
// does, so this wraps the real verifier and only flips its completeness verdict.
vi.mock("../../src/audit/complete.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/audit/complete.js")>();
	return {
		...actual,
		verifyVaultComplete: (dir: string) => ({
			...actual.verifyVaultComplete(dir),
			complete: false,
			valid: false,
		}),
	};
});

import { demoLines, run, runDemo } from "../../src/cli/demo.js";

describe("usertrust demo, when the chain is not complete", () => {
	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("is not ok, says the chain is incomplete, and exits 1", async () => {
		const result = await runDemo();
		expect(result.verified.complete).toBe(false);
		expect(result.ok).toBe(false);
		const text = demoLines(result).join("\n");
		expect(text).toContain("the audit chain is INCOMPLETE");
		expect(text).not.toContain("verifies and is complete");
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await run(undefined, {});
		expect(process.exitCode).toBe(1);
	});
});
