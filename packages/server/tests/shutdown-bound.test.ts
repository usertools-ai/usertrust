// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The command line's bound on a close that never finishes. `close()` waits for every hold's void
 * and record now, so a ledger that never answers would otherwise hold the process open past a
 * supervisor's kill timeout.
 */

import { describe, expect, it, vi } from "vitest";
import { closeWithin } from "../src/cli/shutdown.js";

vi.useFakeTimers();

describe("closeWithin", () => {
	it("answers 'timed out' once the bound passes, and 'closed' for a close that finishes", async () => {
		let settled: string | undefined;
		const stuck = closeWithin(() => new Promise<void>(() => {}), 5_000);
		void stuck.then((v) => {
			settled = v;
		});
		await vi.advanceTimersByTimeAsync(4_999);
		expect(settled).toBeUndefined();
		await vi.advanceTimersByTimeAsync(2);
		// mutant: no bound → the stuck close holds the process open forever
		expect(settled).toBe("timed out");
		await expect(closeWithin(async () => {}, 5_000)).resolves.toBe("closed");
	});

	it("a close that throws is not swallowed", async () => {
		await expect(
			closeWithin(async () => {
				throw new Error("boom");
			}, 5_000),
		).rejects.toThrow("boom");
	});
});
