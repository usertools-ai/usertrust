// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's colours rank over the whole vault: the request for the totals (`loadTotals`) never throws and answers
 * null on any failure, and the colour book is built once, from the totals when they came and from the held rows when
 * they did not, and never rebuilt.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTotals } from "../src/app/desk/load-totals.js";
import { ColorBook } from "../src/app/desk/use-colors.js";
import type { TotalsPayload } from "../src/shared/api.js";
import { SERIES } from "../src/shared/colors.js";
import type { LedgerRow } from "../src/shared/rows.js";

const T0 = Date.parse("2026-11-08T10:00:00.000Z");

function row(over: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: Math.random().toString(36),
		ts: new Date(T0).toISOString(),
		kind: "llm_call",
		actor: "local",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		costUt: 1,
		...over,
	};
}

/** Held rows whose own ranking puts "recent-a" first, then "recent-b" (model follows the actor). */
function heldRows(): LedgerRow[] {
	return [
		row({ pos: 0, actor: "recent-a", model: "m-recent-a", costUt: 9 }),
		row({ pos: 1, actor: "recent-b", model: "m-recent-b", costUt: 5 }),
	];
}

/** A whole-vault ranking the held rows cannot produce: "old-heavy" first. */
function payload(): TotalsPayload {
	const key = (k: string, spendUt: number) => ({ key: k, spendUt, calls: 1 });
	return {
		epoch: 1,
		records: 100,
		dims: {
			lane: [key("old-heavy", 900), key("recent-a", 9), key("recent-b", 5)],
			role: [key("old-heavy", 900)],
			model: [key("m-old", 900), key("m-recent-a", 9)],
			kind: [key("llm_call", 914)],
			provider: [],
		},
		more: { lane: 0, role: 0, model: 0, kind: 0, provider: 0 },
	};
}

function reply(status: number, body: unknown): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

afterEach(() => {
	vi.useRealTimers();
});

describe("loadTotals", () => {
	it("returns the payload of a 200 with the right shape, asking for /api/totals uncached", async () => {
		const fetchFn = vi.fn(async () => reply(200, payload()));
		const got = await loadTotals(fetchFn as unknown as typeof fetch, 10_000);
		expect(got).toEqual(payload());
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("/api/totals");
		expect(init.cache).toBe("no-store");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("returns null for a 500", async () => {
		const fetchFn = vi.fn(async () => reply(500, { error: "totals failed" }));
		expect(await loadTotals(fetchFn as unknown as typeof fetch, 10_000)).toBeNull();
	});

	it("returns null for a network rejection", async () => {
		const fetchFn = vi.fn(async () => {
			throw new TypeError("network down");
		});
		expect(await loadTotals(fetchFn as unknown as typeof fetch, 10_000)).toBeNull();
	});

	it("returns null for a body that is not JSON, and for one missing dims", async () => {
		const notJson = vi.fn(async () => reply(200, "<html>nope</html>"));
		expect(await loadTotals(notJson as unknown as typeof fetch, 10_000)).toBeNull();
		const { dims: _dims, ...noDims } = payload();
		const missing = vi.fn(async () => reply(200, noDims));
		expect(await loadTotals(missing as unknown as typeof fetch, 10_000)).toBeNull();
		const oneDimShort = payload();
		delete (oneDimShort.dims as Partial<TotalsPayload["dims"]>).kind;
		const short = vi.fn(async () => reply(200, oneDimShort));
		expect(await loadTotals(short as unknown as typeof fetch, 10_000)).toBeNull();
	});

	it("returns null after the timeout for a request that never answers, and aborts it", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const fetchFn = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					signal = init.signal as AbortSignal;
					signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}),
		);
		const pending = loadTotals(fetchFn as unknown as typeof fetch, 10_000);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await pending).toBeNull();
		expect(signal?.aborted).toBe(true);
	});
});

describe("ColorBook with the totals", () => {
	it("ranks over the whole vault when the payload came", () => {
		const book = new ColorBook();
		const map = book.mapFor("lane", heldRows(), true, payload());
		expect(map.of("old-heavy")).toBe(SERIES[0]);
		expect(map.of("recent-a")).toBe(SERIES[1]);
		expect(book.source).toBe("whole vault");
	});

	it("falls back to the held rows when the request failed, and says so", () => {
		const book = new ColorBook();
		const map = book.mapFor("lane", heldRows(), true, null);
		expect(map.of("recent-a")).toBe(SERIES[0]);
		expect(map.of("old-heavy")).not.toBe(SERIES[0]);
		expect(book.source).toBe("held rows");
	});

	it("is not built while the request is pending: a throwaway map, no source", () => {
		const book = new ColorBook();
		const map = book.mapFor("lane", heldRows(), true, "pending");
		expect(map.of("recent-a")).not.toBe(SERIES[0]);
		expect(book.source).toBeNull();
		// Once it settles, the real map is built, and it is the one that stays.
		const built = book.mapFor("lane", heldRows(), true, payload());
		expect(built.of("old-heavy")).toBe(SERIES[0]);
		expect(book.mapFor("lane", heldRows(), true, "pending")).toBe(built);
	});

	it("is not built before the rows have loaded, even with the payload in hand", () => {
		const book = new ColorBook();
		const map = book.mapFor("lane", heldRows(), false, payload());
		expect(map.of("old-heavy")).not.toBe(SERIES[0]);
		expect(book.source).toBeNull();
	});

	it("repaints nothing when the answer arrives after a build from the held rows", () => {
		const book = new ColorBook();
		const first = book.mapFor("lane", heldRows(), true, null);
		const later = book.mapFor("lane", heldRows(), true, payload());
		expect(later).toBe(first);
		expect(later.of("old-heavy")).not.toBe(SERIES[0]);
		expect(later.of("recent-a")).toBe(SERIES[0]);
		expect(book.source).toBe("held rows");
	});

	it("uses the source chosen at the first build for a dimension built later", () => {
		const fromHeld = new ColorBook();
		fromHeld.mapFor("lane", heldRows(), true, null);
		const model = fromHeld.mapFor("model", heldRows(), true, payload());
		expect(model.of("m-recent-a")).toBe(SERIES[0]);
		expect(model.of("m-old")).not.toBe(SERIES[0]);

		const fromVault = new ColorBook();
		fromVault.mapFor("lane", heldRows(), true, payload());
		const modelV = fromVault.mapFor("model", heldRows(), true, payload());
		expect(modelV.of("m-old")).toBe(SERIES[0]);
		expect(fromVault.source).toBe("whole vault");
	});

	it("still gives a key first seen on the live tail the next free slot", () => {
		const book = new ColorBook();
		const rows = heldRows();
		const map = book.mapFor("lane", rows, true, payload());
		book.observe("lane", [...rows, row({ pos: 2, actor: "newcomer", costUt: 1 })]);
		// Three keys took slots 0 to 2; the newcomer takes the next free one.
		expect(map.of("newcomer")).toBe(SERIES[3]);
		expect(map.of("old-heavy")).toBe(SERIES[0]);
	});
});
