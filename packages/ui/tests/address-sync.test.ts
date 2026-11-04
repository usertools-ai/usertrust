// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The address writer never swallows a refused history write (review of #510): the address is marked behind, the page
 * says so, and the write is retried with the newest state until it lands, unless the user navigates first.
 */

import { describe, expect, it } from "vitest";
import {
	ADDRESS_RETRY_MS,
	type AddressIo,
	AddressSync,
	addressNoteFor,
} from "../src/shared/address-sync.js";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import {
	addressHolds,
	EMPTY_URL_STATE,
	encodeUrlState,
	type UrlState,
} from "../src/shared/url-state.js";

function withFilters(f: Partial<FilterState>): UrlState {
	return { ...EMPTY_URL_STATE, filters: { ...EMPTY_FILTERS, ...f } };
}

/** A browser stub: an address, a log of writes, a write that can be made to throw, and timers run by hand. */
function stubBrowser(initialHash = "") {
	const b = {
		hash: initialHash,
		writes: [] as Array<{ kind: "push" | "replace"; hash: string }>,
		refuse: 0,
		/** Writes to ignore WITHOUT throwing, as Chromium's navigation rate limiter does. */
		ignore: 0,
		timers: [] as Array<{ fn: () => void; ms: number; cancelled: boolean }>,
		behind: [] as boolean[],
	};
	const io: AddressIo = {
		hash: () => b.hash,
		write(kind, hash) {
			if (b.refuse > 0) {
				b.refuse--;
				throw new Error("SecurityError: too many calls to Location or History APIs");
			}
			if (b.ignore > 0) {
				b.ignore--;
				return; // no throw, and the address does not change
			}
			b.writes.push({ kind, hash });
			b.hash = hash;
		},
		later(fn, ms) {
			const t = { fn, ms, cancelled: false };
			b.timers.push(t);
			return () => {
				t.cancelled = true;
			};
		},
	};
	const runTimers = (): void => {
		const due = b.timers.splice(0);
		for (const t of due) if (!t.cancelled) t.fn();
	};
	return { b, io, runTimers };
}

describe("AddressSync", () => {
	it("writes a filter tweak as a replace, and is not behind", () => {
		const { b, io } = stubBrowser();
		const sync = new AddressSync(EMPTY_URL_STATE, io, (x) => b.behind.push(x));
		sync.sync(withFilters({ search: "gpt" }));
		expect(b.writes).toEqual([{ kind: "replace", hash: "#q=gpt" }]);
		expect(sync.behind).toBe(false);
		expect(b.behind).toEqual([]);
	});

	it("red-first: a write that throws once marks the address behind, then the retry lands and clears it", () => {
		const { b, io, runTimers } = stubBrowser("#q=old");
		const sync = new AddressSync(withFilters({ search: "old" }), io, (x) => b.behind.push(x));
		b.refuse = 1;
		sync.sync(withFilters({ search: "new" }));
		// Not swallowed: the address still says the old filters, and the page is told.
		expect(b.hash).toBe("#q=old");
		expect(sync.behind).toBe(true);
		expect(b.behind).toEqual([true]);
		expect(b.timers).toHaveLength(1);
		expect(b.timers[0]?.ms).toBe(ADDRESS_RETRY_MS);
		runTimers();
		expect(b.hash).toBe("#q=new");
		expect(b.writes).toEqual([{ kind: "replace", hash: "#q=new" }]);
		expect(sync.behind).toBe(false);
		expect(b.behind).toEqual([true, false]);
	});

	it("red-first: a write the browser silently ignores is caught by reading the address back, then retried", () => {
		// Review of #510, round 4: no throw, so without the read-back the state was marked written and a reload or a
		// copied link restored the OLD filters with no note.
		const { b, io, runTimers } = stubBrowser("#q=old");
		const sync = new AddressSync(withFilters({ search: "old" }), io, (x) => b.behind.push(x));
		b.ignore = 1;
		sync.sync(withFilters({ search: "new" }));
		expect(b.hash).toBe("#q=old");
		expect(sync.behind).toBe(true);
		expect(b.timers).toHaveLength(1);
		runTimers();
		expect(b.hash).toBe("#q=new");
		expect(sync.behind).toBe(false);
		expect(b.behind).toEqual([true, false]);
	});

	it("keeps retrying while the browser refuses, and stays behind", () => {
		const { b, io, runTimers } = stubBrowser();
		const sync = new AddressSync(EMPTY_URL_STATE, io, (x) => b.behind.push(x));
		b.refuse = 3;
		sync.sync(withFilters({ search: "x" }));
		runTimers();
		runTimers();
		expect(sync.behind).toBe(true);
		expect(b.writes).toEqual([]);
		runTimers();
		expect(b.hash).toBe("#q=x");
		expect(sync.behind).toBe(false);
		// told once that it fell behind, once that it caught up: not on every retry
		expect(b.behind).toEqual([true, false]);
	});

	it("a refused push (a view change) is retried as a push, so Back still returns to the previous view", () => {
		const { b, io, runTimers } = stubBrowser();
		const sync = new AddressSync(EMPTY_URL_STATE, io, (x) => b.behind.push(x));
		b.refuse = 1;
		sync.sync({ ...EMPTY_URL_STATE, view: "trends" });
		runTimers();
		expect(b.writes).toEqual([{ kind: "push", hash: "#view=trends" }]);
	});

	it("the retry writes the NEWEST state: typing on while behind does not write a stale search", () => {
		const { b, io, runTimers } = stubBrowser();
		const sync = new AddressSync(EMPTY_URL_STATE, io, (x) => b.behind.push(x));
		b.refuse = 2;
		sync.sync(withFilters({ search: "g" }));
		sync.sync(withFilters({ search: "gp" })); // refused too; replaces the pending retry
		expect(b.timers.filter((t) => !t.cancelled)).toHaveLength(1);
		sync.sync(withFilters({ search: "gpt" })); // lands
		expect(b.writes).toEqual([{ kind: "replace", hash: "#q=gpt" }]);
		expect(sync.behind).toBe(false);
		runTimers(); // the cancelled retries do nothing
		expect(b.writes).toHaveLength(1);
	});

	it("a navigation cancels the pending retry: the address the user went to is not overwritten", () => {
		const { b, io, runTimers } = stubBrowser("#q=a");
		const sync = new AddressSync(withFilters({ search: "a" }), io, (x) => b.behind.push(x));
		b.refuse = 1;
		sync.sync(withFilters({ search: "ab" }));
		// The user presses Back before the retry fires; the page adopts the address's state.
		b.hash = "#view=trends";
		sync.adopt({ ...EMPTY_URL_STATE, view: "trends" });
		runTimers();
		expect(b.writes).toEqual([]);
		expect(b.hash).toBe("#view=trends");
		// The page then applies the address's state; the address already describes it, so nothing is written.
		sync.sync({ ...EMPTY_URL_STATE, view: "trends" });
		expect(b.writes).toEqual([]);
		expect(sync.behind).toBe(false);
	});

	it("red-first: a refused view write, then a navigation TO that view, leaves nothing stale", () => {
		// Review of #510, round 3: the page already shows Trends, so applying the navigation changes no state and no
		// write runs; the writer must still learn that the address now says Trends.
		const { b, io, runTimers } = stubBrowser("");
		const sync = new AddressSync(EMPTY_URL_STATE, io, (x) => b.behind.push(x));
		const trends: UrlState = { ...EMPTY_URL_STATE, view: "trends" };
		b.refuse = 1;
		sync.sync(trends); // the push is refused: the address still says Audit
		expect(sync.behind).toBe(true);
		b.hash = "#view=trends"; // the user follows a link to Trends
		sync.adopt(trends);
		expect(sync.behind).toBe(false); // the note comes down
		runTimers();
		expect(b.writes).toEqual([]); // the dropped retry does not write a duplicate entry
		// The next change is planned from Trends: going back to Audit is a view change, so it is a push.
		sync.sync(EMPTY_URL_STATE);
		expect(b.writes).toEqual([{ kind: "push", hash: "" }]);
	});

	it("writes nothing when the address already describes the state", () => {
		const s = withFilters({ statuses: ["failed"] });
		const { b, io } = stubBrowser(encodeUrlState(s));
		const sync = new AddressSync(s, io, (x) => b.behind.push(x));
		sync.sync(s);
		expect(b.writes).toEqual([]);
		expect(sync.behind).toBe(false);
	});
});

describe("addressNoteFor: which note the page shows", () => {
	it("BEHIND wins: a refused write means the address still holds the previous view", () => {
		expect(addressNoteFor(true, false)).toBeNull();
		expect(addressNoteFor(false, false)).toBe("cannot-hold");
		expect(addressNoteFor(true, true)).toBe("behind");
		expect(addressNoteFor(false, true)).toBe("behind");
	});

	it("red-first: a refused CLEAR says the old address is still there, not that a reload opens a clean page", () => {
		// Review of #510, round 3: the address held a filtered view; the next state cannot be held, so the page writes
		// the empty hash, and the browser refuses that write.
		const { b, io } = stubBrowser("#q=old");
		const sync = new AddressSync(withFilters({ search: "old" }), io, (x) => b.behind.push(x));
		const unholdable = withFilters({ search: `a${String.fromCodePoint(0x200b)}b` });
		b.refuse = 1;
		sync.sync(unholdable);
		expect(b.hash).toBe("#q=old"); // a reload would open the OLD filtered view
		expect(addressNoteFor(addressHolds(unholdable), sync.behind)).toBe("behind");
	});
});
