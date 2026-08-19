// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `Deadline` — the shared bound every governor await draws on.
 *
 * Unit-level rather than through the server, because the property under test is
 * one the server's own callers cannot violate: `server.ts` passes an `onAbandoned`
 * that already catches internally, so driving this through an HTTP request proves
 * only that THAT callback is careful. The guard exists for the next callback.
 */

import { describe, expect, it } from "vitest";
import { Deadline, GovernorTimeoutError } from "../src/deadline.js";

describe("Deadline", () => {
	it("shares one budget across sequential awaits", async () => {
		const deadline = new Deadline(200);
		await deadline.run("first", new Promise((resolve) => setTimeout(resolve, 120)));
		// A restarted budget would give this a fresh 200ms and let it succeed.
		await expect(
			deadline.run("second", new Promise((resolve) => setTimeout(resolve, 120))),
		).rejects.toBeInstanceOf(GovernorTimeoutError);
	}, 10_000);

	it("reports the whole budget, not the slice that was left", async () => {
		const deadline = new Deadline(150);
		await deadline.run("first", new Promise((resolve) => setTimeout(resolve, 100)));
		const err = await deadline.run("second", new Promise(() => {})).then(
			() => null,
			(e: unknown) => e,
		);
		// ~50ms actually remained, but 150ms is the number that explains the request.
		expect((err as Error).message).toContain("within 150ms");
	}, 10_000);

	it("hands a late value to onAbandoned exactly once, after timing out", async () => {
		let land: ((value: string) => void) | undefined;
		const op = new Promise<string>((resolve) => {
			land = resolve;
		});
		const seen: string[] = [];
		await expect(
			new Deadline(50).run("op", op, (value) => {
				seen.push(value);
			}),
		).rejects.toBeInstanceOf(GovernorTimeoutError);
		land?.("landed late");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual(["landed late"]);
	}, 10_000);

	it("does not call onAbandoned when the operation wins", async () => {
		const seen: string[] = [];
		await expect(
			new Deadline(500).run("op", Promise.resolve("in time"), (value) => {
				seen.push(value);
			}),
		).resolves.toBe("in time");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual([]);
	}, 10_000);

	it("refuses an already-fulfilled op when the budget is already spent", async () => {
		// Promise reactions run before timers, so racing an already-fulfilled `op`
		// against `setTimeout(..., 0)` returns the value — to a caller that has long
		// since timed out — and skips the reclamation. The decision has to come from the
		// clock, not from a race the clock cannot win.
		const deadline = new Deadline(60);
		// Spend the budget WITHOUT timing out the first call — the caller is still
		// waiting at this point; it is the clock that has run out.
		await deadline.run("first", new Promise((resolve) => setTimeout(resolve, 10)));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(deadline.remainingMs()).toBe(0);
		const seen: string[] = [];
		await expect(
			deadline.run("second", Promise.resolve("already here"), (value) => {
				seen.push(value);
			}),
		).rejects.toBeInstanceOf(GovernorTimeoutError);
		// And the value it refused is still reclaimed rather than stranded.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual(["already here"]);
	}, 10_000);

	it("observes a late rejection even when no cleanup was supplied", async () => {
		// The reclamation continuation was attached only when `onAbandoned` was given —
		// so on the early-timeout path with no cleanup, `op` had NO handler at all. A
		// slow factory can exhaust the budget, return a promise, get its 503, and reject
		// a second later into nothing: an unhandled rejection that can terminate Node.
		// Most callers pass no cleanup, so this was the common path, not the rare one.
		const deadline = new Deadline(60);
		await deadline.run("first", new Promise((resolve) => setTimeout(resolve, 10)));
		await new Promise((resolve) => setTimeout(resolve, 80));

		let failLate: ((err: Error) => void) | undefined;
		const op = new Promise<string>((_resolve, reject) => {
			failLate = reject;
		});
		await expect(deadline.run("second", op)).rejects.toBeInstanceOf(GovernorTimeoutError);
		failLate?.(new Error("landed as a failure, after nobody was listening"));
		// An escaped rejection shows up as an unhandled error for this file and a
		// non-zero exit, not as a failed assertion here.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(true).toBe(true);
	}, 10_000);

	it("refuses a value that WINS the race but arrives after the budget", async () => {
		// The scenario is a stalled event loop, and it is reproducible rather than
		// theoretical. `op` resolves from a timer due at 30ms and the deadline's timer is
		// due at 50ms; the loop is then blocked synchronously past both. When it resumes,
		// Node runs the earlier timer first and drains microtasks before the next one —
		// so `op`'s reaction settles the race while the budget is already spent. Winning
		// a race is not the same as being on time.
		const deadline = new Deadline(50);
		const op = new Promise<string>((resolve) => setTimeout(() => resolve("late winner"), 30));
		setTimeout(() => {
			const until = Date.now() + 120;
			while (Date.now() < until) {
				// Deliberate synchronous stall: this is the condition under test.
			}
		}, 10);

		const seen: string[] = [];
		const settled = await deadline
			.run("op", op, (value) => {
				seen.push(value);
			})
			.then(
				() => "resolved" as const,
				(err: unknown) => err,
			);

		expect(settled).toBeInstanceOf(GovernorTimeoutError);
		// And the value it refused is reclaimed rather than silently kept — for
		// /v1/authorize that value is a ledger hold nobody can settle.
		expect(seen).toEqual(["late winner"]);
	}, 10_000);

	it("contains a cleanup that rejects, instead of taking the process down", async () => {
		// `onAbandoned` is typed void-returning, but an async function is assignable to
		// it — so a cleanup that rejects hands back a promise nobody observes, and an
		// unhandled rejection can terminate Node. A server that dies while cleaning up
		// after a timeout is strictly worse than one that leaks the thing it was
		// cleaning up. An escape shows as an unhandled error for this file.
		let land: ((value: string) => void) | undefined;
		const op = new Promise<string>((resolve) => {
			land = resolve;
		});
		await expect(
			new Deadline(50).run("op", op, async () => {
				throw new Error("cleanup failed too");
			}),
		).rejects.toBeInstanceOf(GovernorTimeoutError);
		land?.("landed late");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(true).toBe(true);
	}, 10_000);

	it("contains a cleanup that throws synchronously", async () => {
		let land: ((value: string) => void) | undefined;
		const op = new Promise<string>((resolve) => {
			land = resolve;
		});
		await expect(
			new Deadline(50).run("op", op, () => {
				throw new Error("sync cleanup failure");
			}),
		).rejects.toBeInstanceOf(GovernorTimeoutError);
		land?.("landed late");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(true).toBe(true);
	}, 10_000);
});
