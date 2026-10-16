// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * host-fixtures.test.ts: the hang guard the host-loop suites rely on. It must
 * fail a promise nothing can settle, by name, and must not fail one that is
 * merely slow.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { awaitSettled, consumeLikeOpenClawLoop, PinnedEventStream } from "./host-fixtures.js";

describe("awaitSettled", () => {
	it("fails a promise that nothing can settle, by name", async () => {
		await expect(awaitSettled(() => new Promise<never>(() => {}))).rejects.toThrow(
			"promise never settled",
		);
	});

	it("fails a stream that never ends, by name", async () => {
		const stream = new PinnedEventStream();
		await expect(awaitSettled(() => consumeLikeOpenClawLoop(stream))).rejects.toThrow(
			"promise never settled",
		);
	});

	it("fails a result() that a clean close left pending, by name", async () => {
		const stream = new PinnedEventStream();
		stream.end();
		await expect(awaitSettled(() => stream.result())).rejects.toThrow("promise never settled");
	});

	it("waits for a timer longer than the deadline it replaces", async () => {
		const value = await awaitSettled(
			() => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 700)),
		);
		expect(value).toBe("late");
	});

	it("waits through a chain of fs requests", async () => {
		const value = await awaitSettled(async () => {
			for (let i = 0; i < 20; i++) await readFile(new URL(import.meta.url));
			return "read";
		});
		expect(value).toBe("read");
	});

	it("waits through a timer that is armed only after an fs request returns", async () => {
		const value = await awaitSettled(async () => {
			await readFile(new URL(import.meta.url));
			await new Promise((resolve) => setTimeout(resolve, 50));
			await readFile(new URL(import.meta.url));
			return "done";
		});
		expect(value).toBe("done");
	});

	it("passes a rejection through unchanged", async () => {
		await expect(
			awaitSettled(() => Promise.reject(new Error("provider_exploded"))),
		).rejects.toThrow("provider_exploded");
	});
});
