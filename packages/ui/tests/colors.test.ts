// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { breakdown } from "../src/shared/breakdown.js";
import {
	colorsFromRanking,
	MUTED,
	PROVIDER_COLOR,
	rankColors,
	SERIES,
} from "../src/shared/colors.js";
import type { LedgerRow } from "../src/shared/rows.js";

const T0 = Date.parse("2026-07-27T00:00:00.000Z");
const HOUR = 3_600_000;

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: Math.random().toString(36),
		ts: new Date(T0 + HOUR).toISOString(),
		kind: "llm_call",
		actor: "local",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		costUt: 1,
		...overrides,
	};
}

/** One spend-bearing record per actor, costing `cost`. */
function actors(costs: Record<string, number>): LedgerRow[] {
	return Object.entries(costs).map(([actor, costUt], pos) => row({ pos, actor, costUt }));
}

describe("the palette", () => {
	it("is the approved series, the muted tone and the four fixed provider colours", () => {
		expect(SERIES).toEqual(["#BE804D", "#5D6775", "#C8CCD3", "#7095C1", "#E8B54B"]);
		expect(MUTED).toBe("#8A877F");
		expect(PROVIDER_COLOR).toEqual({
			Anthropic: "#BE804D",
			OpenAI: "#5D6775",
			xAI: "#C8CCD3",
			Google: "#7095C1",
		});
	});
});

describe("rankColors", () => {
	const all = actors({ a: 70, b: 60, c: 50, d: 40, e: 30, f: 20, g: 10 });

	it("gives the top five by spend the series slots in order and the rest the muted tone", () => {
		const map = rankColors(all, "lane");
		expect(["a", "b", "c", "d", "e"].map((k) => map.of(k))).toEqual([...SERIES]);
		expect(map.of("f")).toBe(MUTED);
		expect(map.of("g")).toBe(MUTED);
	});

	it("breaks a tie by key, A to Z", () => {
		const map = rankColors(actors({ zed: 5, amy: 5, bob: 5 }), "lane");
		expect(map.of("amy")).toBe(SERIES[0]);
		expect(map.of("bob")).toBe(SERIES[1]);
		expect(map.of("zed")).toBe(SERIES[2]);
	});

	it("gives the same key the same colour whatever the filter: it is never built from filtered rows", () => {
		const map = rankColors(all, "lane");
		const before = all.map((r) => map.of(r.actor));
		// A filtered view ranks differently on its own; the map must not follow it.
		const only = all.filter((r) => r.actor === "g");
		const filteredRank = breakdown(only, { startMs: -Infinity, endMs: Infinity }, "lane");
		expect(filteredRank.keys).toEqual(["g"]);
		expect(all.map((r) => map.of(r.actor))).toEqual(before);
		// Control: a map built from the filtered rows would paint g with the first slot.
		expect(rankColors(only, "lane").of("g")).toBe(SERIES[0]);
		expect(map.of("g")).toBe(MUTED);
	});

	it("paints 'untyped' with the muted tone and does not spend a slot on it", () => {
		const rows = [
			row({ pos: 0, costUt: 100 }), // no jobType: untyped, the largest
			row({ pos: 1, costUt: 5, jobType: "feature" }),
			row({ pos: 2, costUt: 4, jobType: "bugfix" }),
		];
		const map = rankColors(rows, "role");
		expect(map.of("untyped")).toBe(MUTED);
		expect(map.of("feature")).toBe(SERIES[0]);
		expect(map.of("bugfix")).toBe(SERIES[1]);
	});

	it("paints the providers with their fixed colour, and Other with the muted tone", () => {
		const rows = [
			row({ pos: 0, costUt: 1, model: "grok-4.7" }),
			row({ pos: 1, costUt: 99, model: "command-r" }),
		];
		const map = rankColors(rows, "provider");
		expect(map.of("xAI")).toBe("#C8CCD3");
		expect(map.of("Anthropic")).toBe("#BE804D");
		expect(map.of("OpenAI")).toBe("#5D6775");
		expect(map.of("Google")).toBe("#7095C1");
		expect(map.of("Other")).toBe(MUTED);
	});

	it("returns the muted tone and no NaN for a vault with no spend-bearing record", () => {
		const map = rankColors([row({ kind: "info", costUt: 50 })], "lane");
		expect(map.of("local")).toBe(MUTED);
		expect(map.add("first")).toBe(SERIES[0]);
		expect(rankColors([], "model").of("anything")).toBe(MUTED);
	});

	it("gives a key never seen at load the next free slot, and never repaints an existing key", () => {
		const map = rankColors(actors({ a: 30, b: 20, c: 10 }), "lane");
		const before = ["a", "b", "c"].map((k) => map.of(k));
		expect(map.add("new")).toBe(SERIES[3]);
		expect(["a", "b", "c"].map((k) => map.of(k))).toEqual(before);
		// The same key keeps what it was given, however often it is added or read.
		expect(map.add("new")).toBe(SERIES[3]);
		expect(map.of("new")).toBe(SERIES[3]);
		expect(map.add("a")).toBe(SERIES[0]);
		expect(map.add("newer")).toBe(SERIES[4]);
		// The slots are gone: the next new key is muted.
		expect(map.add("latest")).toBe(MUTED);
		expect(map.of("latest")).toBe(MUTED);
	});

	it("paints a new 'untyped' or 'Other' muted without taking a slot", () => {
		const map = rankColors([row({ jobType: "feature" })], "role");
		expect(map.add("untyped")).toBe(MUTED);
		expect(map.add("next")).toBe(SERIES[1]);
	});

	it("keeps a provider's fixed colour when it arrives on the live tail", () => {
		const map = rankColors([], "provider");
		expect(map.add("xAI")).toBe("#C8CCD3");
		expect(map.add("Other")).toBe(MUTED);
	});

	it("records the dimension it was built for", () => {
		expect(rankColors([], "kind").dim).toBe("kind");
	});
});

describe("colorsFromRanking", () => {
	it("gives a ranking from anywhere the colours rankColors gives the same order", () => {
		const rows = actors({ a: 9, b: 8, c: 7, d: 6, e: 5, f: 4, untyped: 3 });
		const held = rankColors(rows, "lane");
		const open = { startMs: -Infinity, endMs: Infinity };
		const ranked = colorsFromRanking("lane", breakdown(rows, open, "lane").keys);
		for (const key of ["a", "b", "c", "d", "e", "f", "untyped", "nobody"])
			expect(ranked.of(key)).toBe(held.of(key));
	});

	it("does not repaint a key it already ranked when another is added", () => {
		const map = colorsFromRanking("lane", ["x", "y"]);
		const before = map.of("x");
		map.add("z");
		expect(map.of("x")).toBe(before);
		expect(map.of("z")).toBe(SERIES[2]);
	});
});
