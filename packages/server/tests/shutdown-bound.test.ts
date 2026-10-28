// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The command line's bound on a close that never finishes. `close()` waits for every hold's void
 * and record now, so a ledger that never answers would otherwise hold the process open past a
 * supervisor's kill timeout.
 */

import { describe, expect, it, vi } from "vitest";
import { closeWithin, SHUTDOWN_BOUND_MS, shutdownExitCode } from "../src/cli/shutdown.js";

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

describe("shutdownExitCode", () => {
	const scrub = (text: string) => text.replaceAll("\x1b", "");

	it("0 and silent when close finishes in time", async () => {
		const lines: string[] = [];
		await expect(
			shutdownExitCode(
				async () => {},
				8_000,
				(l) => lines.push(l),
				scrub,
			),
		).resolves.toBe(0);
		expect(lines).toEqual([]);
	});

	it("0, and says so, when close does not finish within the bound", async () => {
		const lines: string[] = [];
		const done = shutdownExitCode(
			() => new Promise<void>(() => {}),
			8_000,
			(l) => lines.push(l),
			scrub,
		);
		await vi.advanceTimersByTimeAsync(8_001);
		await expect(done).resolves.toBe(0);
		expect(lines).toEqual([
			"usertrust-server: shutdown did not finish within 8000 ms; holds not yet voided expire at the ledger's pending timeout\n",
		]);
	});

	it("1, with the scrubbed message, when close throws: never an unhandled rejection", async () => {
		const lines: string[] = [];
		const code = await shutdownExitCode(
			async () => {
				throw new Error("ledger \x1b[2Jgone");
			},
			8_000,
			(l) => lines.push(l),
			scrub,
		);
		expect(code).toBe(1);
		expect(lines).toEqual(["usertrust-server: shutdown failed: ledger [2Jgone\n"]);
	});
});

describe("SHUTDOWN_BOUND_MS", () => {
	it("exceeds the governors' 5 s wait for calls in flight by at least 2 s, so one stuck call cannot use the whole bound", () => {
		// mutant: a bound equal to the drain → the voids and records after the drain never get their time
		expect(SHUTDOWN_BOUND_MS).toBeGreaterThanOrEqual(5_000 + 2_000);
	});
});
