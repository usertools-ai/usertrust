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
		await deadline.run("first", () => new Promise((resolve) => setTimeout(resolve, 120)));
		// A restarted budget would give this a fresh 200ms and let it succeed.
		await expect(
			deadline.run("second", () => new Promise((resolve) => setTimeout(resolve, 120))),
		).rejects.toBeInstanceOf(GovernorTimeoutError);
	}, 10_000);

	it("reports the whole budget, not the slice that was left", async () => {
		const deadline = new Deadline(150);
		await deadline.run("first", () => new Promise((resolve) => setTimeout(resolve, 100)));
		const err = await deadline
			.run("second", () => new Promise(() => {}))
			.then(
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
			new Deadline(50).run(
				"op",
				() => op,
				(value) => {
					seen.push(value);
				},
			),
		).rejects.toBeInstanceOf(GovernorTimeoutError);
		land?.("landed late");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual(["landed late"]);
	}, 10_000);

	it("does not call onAbandoned when the operation wins", async () => {
		const seen: string[] = [];
		await expect(
			new Deadline(500).run(
				"op",
				() => Promise.resolve("in time"),
				(value) => {
					seen.push(value);
				},
			),
		).resolves.toBe("in time");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual([]);
	}, 10_000);

	it("refuses an already-fulfilled op when the budget is already spent", async () => {
		// Promise reactions run before timers, so racing an already-fulfilled `op`
		// against `setTimeout(..., 0)` returns the value — to a caller that has long
		// since timed out. The decision has to come from the clock, not from a race the
		// clock cannot win, and it has to come BEFORE the work is started.
		const deadline = new Deadline(60);
		// Spend the budget WITHOUT timing out the first call — the caller is still
		// waiting at this point; it is the clock that has run out.
		await deadline.run("first", () => new Promise((resolve) => setTimeout(resolve, 10)));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(deadline.remainingMs()).toBe(0);
		const seen: string[] = [];
		let started = 0;
		await expect(
			deadline.run(
				"second",
				() => {
					started += 1;
					return Promise.resolve("already here");
				},
				(value) => {
					seen.push(value);
				},
			),
		).rejects.toBeInstanceOf(GovernorTimeoutError);
		await new Promise((resolve) => setTimeout(resolve, 50));
		// STRONGER than the reclamation this used to assert. While `run` took a promise,
		// the operation was already issued by the time the clock was consulted, so the
		// best available outcome was to hand the result to `onAbandoned` and hope the
		// cleanup worked. Taking a thunk means there is nothing to reclaim, because
		// nothing was ever started — no hold, no governor, nothing to strand.
		expect(started).toBe(0);
		expect(seen).toEqual([]);
	}, 10_000);

	it("observes a late rejection even when no cleanup was supplied", async () => {
		// The reclamation continuation was attached only when `onAbandoned` was given, so
		// an `op` that outlived the call with no cleanup had NO handler at all, and its
		// later rejection became an unhandled rejection that can terminate Node. Most
		// callers pass no cleanup, so this is the common path, not the rare one.
		//
		// The TIMER path is now the only way an op outlives the call: on the early-refusal
		// path the thunk is never invoked, so no promise exists to go unobserved. Started
		// here, then timed out, then failed afterwards.
		let failLate: ((err: Error) => void) | undefined;
		const op = new Promise<string>((_resolve, reject) => {
			failLate = reject;
		});
		await expect(new Deadline(50).run("second", () => op)).rejects.toBeInstanceOf(
			GovernorTimeoutError,
		);
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
			.run(
				"op",
				() => op,
				(value) => {
					seen.push(value);
				},
			)
			.then(
				() => "resolved" as const,
				(err: unknown) => err,
			);

		expect(settled).toBeInstanceOf(GovernorTimeoutError);
		// And the value it refused is reclaimed rather than silently kept — for
		// /v1/authorize that value is a ledger hold nobody can settle.
		expect(seen).toEqual(["late winner"]);
	}, 10_000);

	it("reports a late rejection as a timeout, not as the operation's own failure", async () => {
		// The clock decided on the way IN and on the way OUT, but only for VALUES. A
		// rejection that won the race jumped straight out through `finally` and skipped
		// the post-race check entirely, so the same helper decided on the clock for
		// success and on the race for failure.
		//
		// That asymmetry is not cosmetic. `server.ts` shadows every mapped status under
		// 500, so a policy verdict that lost the race came back as a clean
		// `200 {"decision":"would_deny"}` on a request whose deadline had already blown —
		// a blown deadline laundered into a policy opinion, which is the same class this
		// package already fixed once for 503s.
		//
		// Same reproducible stall as the value case above: `op` rejects from a timer due
		// at 30ms, the deadline's timer is due at 50ms, and the loop is blocked past both.
		// On resume Node runs the earlier timer first and drains microtasks before the
		// next one, so the rejection settles the race with the budget already spent.
		const deadline = new Deadline(50);
		const denied = new Error("policy denied: over budget");
		denied.name = "PolicyDeniedError";
		const op = new Promise<string>((_resolve, reject) => setTimeout(() => reject(denied), 30));
		setTimeout(() => {
			const until = Date.now() + 120;
			while (Date.now() < until) {
				// Deliberate synchronous stall: this is the condition under test.
			}
		}, 10);

		const settled = await deadline
			.run("authorize", () => op)
			.then(
				() => "resolved" as const,
				(err: unknown) => err,
			);

		// The load-bearing assertion is which error comes back. Reporting `denied` here
		// is the defect: past the budget the server has no basis to assert any verdict.
		expect(settled).toBeInstanceOf(GovernorTimeoutError);
		expect(settled).not.toBe(denied);
	}, 10_000);

	it("still reports an ON-TIME failure as itself", async () => {
		// The positive control for the conversion above. Without it, a `run` that turned
		// EVERY rejection into a timeout would pass that test while destroying the error
		// reporting this server depends on — `ledger_unavailable` names the TigerBeetle
		// addresses, and an on-time outage must keep saying so.
		const failed = new Error("ledger unavailable: 127.0.0.1:3001");
		failed.name = "LedgerUnavailableError";
		const settled = await new Deadline(500)
			.run("authorize", () => Promise.reject(failed))
			.then(
				() => "resolved" as const,
				(err: unknown) => err,
			);
		expect(settled).toBe(failed);
		expect(settled).not.toBeInstanceOf(GovernorTimeoutError);
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
			new Deadline(50).run(
				"op",
				() => op,
				async () => {
					throw new Error("cleanup failed too");
				},
			),
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
			new Deadline(50).run(
				"op",
				() => op,
				() => {
					throw new Error("sync cleanup failure");
				},
			),
		).rejects.toBeInstanceOf(GovernorTimeoutError);
		land?.("landed late");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(true).toBe(true);
	}, 10_000);
});
