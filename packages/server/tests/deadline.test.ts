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
