// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { breakdown } from "../src/shared/breakdown.js";
import {
	deskWindow,
	FACET_FIELD,
	orderFilters,
	removeFilterToken,
	selectedKeys,
	toggleCategory,
	withoutDimension,
} from "../src/shared/desk-filters.js";
import { applyFilters, EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import type { LedgerRow } from "../src/shared/rows.js";

function row(overrides: Partial<LedgerRow>): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: "id-1",
		ts: "2026-11-03T10:00:00.000Z",
		kind: "llm_call",
		actor: "local",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		...overrides,
	};
}

const f = (over: Partial<FilterState>): FilterState => ({ ...EMPTY_FILTERS, ...over });

describe("FACET_FIELD", () => {
	it("maps each dimension to its filter field", () => {
		expect(FACET_FIELD).toEqual({
			lane: "actors",
			role: "jobTypes",
			model: "models",
			kind: "kinds",
			provider: "providers",
		});
	});
});

describe("selectedKeys", () => {
	it("reads the field of the dimension", () => {
		expect([...selectedKeys(f({ actors: ["a", "b"], models: ["m"] }), "lane")]).toEqual(["a", "b"]);
		expect(selectedKeys(f({ actors: ["a"] }), "model").size).toBe(0);
	});
});

describe("withoutDimension", () => {
	it("clears only the dimension's field", () => {
		const base = f({ actors: ["x"], kinds: ["llm_call"], search: "q", from: "2026-11-01" });
		const out = withoutDimension(base, "lane");
		expect(out.actors).toEqual([]);
		expect(out).toEqual({ ...base, actors: [] });
	});

	it("clears each of the five fields", () => {
		const base = f({
			actors: ["a"],
			jobTypes: ["j"],
			models: ["m"],
			kinds: ["k"],
			providers: ["p"],
		});
		expect(withoutDimension(base, "role").jobTypes).toEqual([]);
		expect(withoutDimension(base, "model").models).toEqual([]);
		expect(withoutDimension(base, "kind").kinds).toEqual([]);
		expect(withoutDimension(base, "provider").providers).toEqual([]);
		expect(withoutDimension(base, "provider").actors).toEqual(["a"]);
	});

	it("gives one number per thing: the lane breakdown ignores the lane filter, the rows do not", () => {
		const rows = [
			row({ id: "1", actor: "x", costUt: 1 }),
			row({ id: "2", actor: "y", costUt: 2 }),
			row({ id: "3", actor: "z", costUt: 3 }),
		];
		const filters = f({ actors: ["x"] });
		const lanes = (rs: LedgerRow[]) => new Set(rs.map((r) => r.actor));
		expect(lanes(applyFilters(rows, filters))).toEqual(new Set(["x"]));
		expect(lanes(applyFilters(rows, withoutDimension(filters, "lane")))).toEqual(
			new Set(["x", "y", "z"]),
		);
	});
});

describe("toggleCategory", () => {
	it("makes an unselected key the only one, even when another is selected", () => {
		expect(toggleCategory(f({ actors: ["a"] }), "lane", "b", false).actors).toEqual(["b"]);
		expect(toggleCategory(EMPTY_FILTERS, "lane", "b", false).actors).toEqual(["b"]);
	});

	it("clears the field when the only selected key is clicked", () => {
		expect(toggleCategory(f({ actors: ["a"] }), "lane", "a", false).actors).toEqual([]);
	});

	it("narrows to one key when the clicked key is one of two and not additive", () => {
		expect(toggleCategory(f({ actors: ["a", "b"] }), "lane", "a", false).actors).toEqual(["a"]);
	});

	it("adds an unselected key when additive", () => {
		expect(toggleCategory(f({ actors: ["a"] }), "lane", "b", true).actors).toEqual(["a", "b"]);
	});

	it("removes one of two when additive", () => {
		expect(toggleCategory(f({ actors: ["a", "b"] }), "lane", "a", true).actors).toEqual(["b"]);
	});

	it("clears the field when additive on the only one", () => {
		expect(toggleCategory(f({ actors: ["a"] }), "lane", "a", true).actors).toEqual([]);
	});

	it("writes the right field for every dimension", () => {
		expect(toggleCategory(EMPTY_FILTERS, "role", "r", false).jobTypes).toEqual(["r"]);
		expect(toggleCategory(EMPTY_FILTERS, "model", "m", false).models).toEqual(["m"]);
		expect(toggleCategory(EMPTY_FILTERS, "kind", "k", false).kinds).toEqual(["k"]);
		expect(toggleCategory(EMPTY_FILTERS, "provider", "p", false).providers).toEqual(["p"]);
	});

	it("leaves every other field as it was, by reference", () => {
		const kinds = ["llm_call"];
		const base = f({ kinds, search: "q", from: "2026-11-01" });
		const out = toggleCategory(base, "lane", "a", false);
		expect(out.kinds).toBe(kinds);
		expect(out.search).toBe("q");
		expect(out.from).toBe("2026-11-01");
		expect(base.actors).toEqual([]);
	});
});

describe("deskWindow", () => {
	const now = Date.UTC(2026, 10, 8, 12, 34, 56, 789);

	it("live: ends at the end of the current minute and spans the range", () => {
		const w = deskWindow("1w", null, now);
		expect(w.endMs).toBe(Date.UTC(2026, 10, 8, 12, 35));
		expect(w.startMs).toBe(w.endMs - 7 * 86_400_000);
	});

	it("live: a record stamped inside the current minute is counted", () => {
		const w = deskWindow("1w", null, now);
		const rows = [
			row({ id: "a", ts: new Date(now - 1000).toISOString(), costUt: 4 }),
			row({ id: "b", ts: new Date(now).toISOString(), costUt: 1 }),
		];
		expect(breakdown(rows, w, "lane").totalUt).toBe(5);
	});

	it("counts a record at the window start (half-open, start inclusive)", () => {
		const w = deskWindow("1w", null, now);
		const rows = [row({ id: "a", ts: new Date(w.startMs).toISOString(), costUt: 3 })];
		expect(breakdown(rows, w, "lane").totalUt).toBe(3);
	});

	it("past: ends one millisecond after the record at the position, which then counts", () => {
		const ts = "2026-11-03T10:00:00.000Z";
		const w = deskWindow("1w", { ts }, now);
		expect(w.endMs).toBe(Date.parse(ts) + 1);
		const rows = [
			row({ id: "a", ts, costUt: 7 }),
			row({ id: "b", ts: "2026-11-03T10:00:00.001Z", costUt: 9 }),
		];
		expect(breakdown(rows, w, "lane").totalUt).toBe(7);
	});

	it("the drawn answer decides, not a newer position mid-drag", () => {
		const drawn = { ts: "2026-11-03T10:00:00.000Z" };
		const w = deskWindow("1w", drawn, now);
		expect(w.endMs).toBe(Date.parse("2026-11-03T10:00:00.000Z") + 1);
	});

	it("uses the range's own span past a position (ytd starts at 1 January of that year)", () => {
		const w = deskWindow("ytd", { ts: "2026-11-03T10:00:00.000Z" }, now);
		expect(w.startMs).toBe(Date.UTC(2026, 0, 1));
	});

	it("floors nothing when the minute is exact: now on a minute edge ends at that edge plus a minute", () => {
		const edge = Date.UTC(2026, 10, 8, 12, 35, 0, 0);
		expect(deskWindow("1d", null, edge).endMs).toBe(edge + 60_000);
	});
});

describe("model-less spend (the key the breakdown gives it)", () => {
	const rows = [
		row({ id: "m", costUt: 1, model: "gpt-5" }),
		row({ id: "n", costUt: 2 }),
		row({ id: "o", costUt: 3 }),
	];

	it("a click on the unknown slice keeps exactly the model-less rows", () => {
		const out = applyFilters(rows, toggleCategory(EMPTY_FILTERS, "model", "unknown", false));
		expect(out.map((r) => r.id)).toEqual(["n", "o"]);
	});
});

describe("orderFilters", () => {
	it("starts in chip order", () => {
		expect(orderFilters([], f({ kinds: ["a"], actors: ["b"] }))).toEqual(["kinds:a", "actors:b"]);
	});

	it("keeps the previous order and appends a new token last", () => {
		expect(
			orderFilters(["actors:b", "kinds:a"], f({ kinds: ["a"], actors: ["b"], models: ["m"] })),
		).toEqual(["actors:b", "kinds:a", "models:m"]);
	});

	it("drops a removed value", () => {
		expect(orderFilters(["actors:b", "kinds:a"], f({ kinds: ["a"] }))).toEqual(["kinds:a"]);
	});

	it("appends several new tokens in chip order", () => {
		const out = orderFilters(
			["kinds:a"],
			f({
				search: "q",
				kinds: ["a"],
				models: ["m"],
				statuses: ["failed"],
				jobTypes: ["j"],
				typeSources: ["s"],
				providers: ["p"],
				from: "2026-11-01",
				to: "2026-11-02",
				costMin: 1,
				costMax: 9,
			}),
		);
		expect(out).toEqual([
			"kinds:a",
			"search:q",
			"models:m",
			"statuses:failed",
			"jobTypes:j",
			"typeSources:s",
			"providers:p",
			"from:2026-11-01",
			"to:2026-11-02",
			"costMin:1",
			"costMax:9",
		]);
	});

	it("ignores a blank search", () => {
		expect(orderFilters([], f({ search: "   " }))).toEqual([]);
	});
});

describe("removeFilterToken", () => {
	const all = f({
		search: "q",
		kinds: ["a", "b"],
		from: "2026-11-01",
		to: "2026-11-02",
		costMin: 1,
		costMax: 9,
		models: ["x:y"],
	});

	it("removes one value of a list", () => {
		expect(removeFilterToken(all, "kinds:a").kinds).toEqual(["b"]);
	});

	it("removes a value that contains a colon", () => {
		expect(removeFilterToken(all, "models:x:y").models).toEqual([]);
	});

	it("clears from, to, search and the cost bounds", () => {
		expect(removeFilterToken(all, "from:2026-11-01").from).toBeUndefined();
		expect(removeFilterToken(all, "to:2026-11-02").to).toBeUndefined();
		expect(removeFilterToken(all, "search:q").search).toBe("");
		expect(removeFilterToken(all, "costMin:1").costMin).toBeUndefined();
		expect(removeFilterToken(all, "costMax:9").costMax).toBeUndefined();
	});

	it("leaves everything else as it was", () => {
		const out = removeFilterToken(all, "kinds:a");
		expect(out).toEqual({ ...all, kinds: ["b"] });
	});

	it("returns the same state for a token it does not know", () => {
		expect(removeFilterToken(all, "nope:1")).toBe(all);
	});
});
