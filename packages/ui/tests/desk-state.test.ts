// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's state: the pieces the provider builds on (`memoOnce`, `computeBreakdown`, `ColorBook`) and the hooks the
 * windows read, exercised through the two contexts. The provider itself needs a browser address, so what it must keep
 * is pinned as source checks.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DeskData, DeskView } from "../src/app/desk/desk-types.js";
import { computeBreakdown, memoOnce } from "../src/app/desk/use-breakdown.js";
import { ColorBook } from "../src/app/desk/use-colors.js";
import { breakdown, type Dimension } from "../src/shared/breakdown.js";
import { SERIES } from "../src/shared/colors.js";
import { withoutDimension } from "../src/shared/desk-filters.js";
import type { WindowId } from "../src/shared/desk-layout.js";
import { applyFilters, EMPTY_FILTERS } from "../src/shared/filters.js";
import { listView } from "../src/shared/list-view.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { defaultDeskData, withDesk } from "./helpers/desk.js";

const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const HOUR = 3_600_000;
const WIN = { startMs: T0 - 24 * HOUR, endMs: T0 + HOUR };

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

/** One spend record per actor, costing what `costs` says, in the order given. */
function byActor(costs: Record<string, number>): LedgerRow[] {
	return Object.entries(costs).map(([actor, costUt], pos) => row({ pos, actor, costUt }));
}

describe("memoOnce", () => {
	it("does not call the function until the first read, and calls it once", () => {
		const fn = vi.fn(() => ({ n: 1 }));
		const read = memoOnce(fn);
		expect(fn).not.toHaveBeenCalled();
		const a = read();
		const b = read();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(b).toBe(a);
	});
});

describe("computeBreakdown", () => {
	const rows: LedgerRow[] = [
		row({ pos: 0, actor: "x", model: "m", costUt: 5 }),
		row({ pos: 1, actor: "y", model: "n", costUt: 3 }),
		row({ pos: 2, actor: "z", model: "m", costUt: 2 }),
	];

	it("lists every lane while one lane is selected, so the donut never collapses to one slice", () => {
		const f = { ...EMPTY_FILTERS, actors: ["x"] };
		const b = computeBreakdown(rows, f, WIN, "lane");
		expect([...b.keys].sort()).toEqual(["x", "y", "z"]);
	});

	it("keeps only the lanes that used a selected model, and the total is the one the rule gives", () => {
		const f = { ...EMPTY_FILTERS, models: ["m"] };
		const b = computeBreakdown(rows, f, WIN, "lane");
		expect([...b.keys].sort()).toEqual(["x", "z"]);
		expect(b.totalUt).toBe(
			breakdown(applyFilters(rows, withoutDimension(f, "lane")), WIN, "lane").totalUt,
		);
		expect(b.totalUt).toBe(7);
	});
});

describe("ColorBook", () => {
	it("is empty before the vault has loaded, then builds the real map", () => {
		const book = new ColorBook();
		const rows = byActor({ a: 9, b: 5 });
		const before = book.mapFor("lane", rows, false);
		expect(before.of("a")).not.toBe(SERIES[0]);
		const after = book.mapFor("lane", rows, true);
		expect(after.of("a")).toBe(SERIES[0]);
		expect(after.of("b")).toBe(SERIES[1]);
	});

	it("returns the same map for ever once built, and observing a superset repaints nothing", () => {
		const book = new ColorBook();
		const rows = byActor({ a: 9, b: 5, c: 3 });
		const map = book.mapFor("lane", rows, true);
		const was = ["a", "b", "c"].map((k) => map.of(k));
		const more = [...rows, row({ pos: 3, actor: "d", costUt: 1 })];
		book.observe("lane", more);
		expect(book.mapFor("lane", more, true)).toBe(map);
		expect(["a", "b", "c"].map((k) => map.of(k))).toEqual(was);
	});

	it("gives a key first seen on the live tail the next free slot", () => {
		const book = new ColorBook();
		const rows = byActor({ a: 9, b: 5, c: 3 });
		const map = book.mapFor("lane", rows, true);
		const more = [...rows, row({ pos: 3, actor: "d", costUt: 1 })];
		book.observe("lane", more);
		expect(map.of("d")).toBe(SERIES[3]);
		expect(map.of("a")).toBe(SERIES[0]);
	});

	it("keeps a dimension's colours apart from another's", () => {
		const book = new ColorBook();
		const rows = [
			row({ pos: 0, actor: "a", model: "m1", costUt: 9 }),
			row({ pos: 1, actor: "b", model: "m2", costUt: 1 }),
		];
		const lane = book.mapFor("lane", rows, true);
		const model = book.mapFor("model", rows, true);
		expect(lane).not.toBe(model);
		expect(lane.dim).toBe("lane");
		expect(model.dim).toBe("model");
		expect(model.of("m2")).toBe(SERIES[1]);
	});

	it("rescans after the array shrank without changing a colour it has given", () => {
		const book = new ColorBook();
		const rows = byActor({ a: 9, b: 5, c: 3 });
		const map = book.mapFor("lane", rows, true);
		// A resync: fewer rows than before, and one of them carries a key not seen yet.
		book.observe("lane", [rows[0] as LedgerRow, row({ pos: 1, actor: "f", costUt: 1 })]);
		expect(map.of("f")).toBe(SERIES[3]);
		expect(["a", "b", "c"].map((k) => map.of(k))).toEqual([SERIES[0], SERIES[1], SERIES[2]]);
	});

	it("does not give a slot to a key that never carries spend", () => {
		const book = new ColorBook();
		const rows = byActor({ a: 9 });
		const map = book.mapFor("lane", rows, true);
		const withGhost = [...rows, row({ pos: 1, actor: "ghost", kind: "budget_set", costUt: 0 })];
		book.observe("lane", withGhost);
		book.observe("lane", [...withGhost, row({ pos: 2, actor: "real", costUt: 1 })]);
		expect(map.of("real")).toBe(SERIES[1]);
	});
});

// The hooks live in a .tsx file the tests' tsconfig cannot import statically: load it by a computed path.
interface StateModule {
	useDeskData(): DeskData;
	useFilters(): {
		filters: DeskView["filters"];
		setFilters(f: DeskView["filters"]): void;
		clear(): void;
	};
	useRange(): { range: string; setRange(r: string): void; window: DeskData["window"] };
	useDimension(): { dim: Dimension; setDim(d: Dimension): void; level: Dimension };
	useFill(): {
		fill: WindowId | null;
		setFill(id: WindowId | null): void;
		toggle(id: WindowId): void;
	};
	useOpenRecord(): {
		openHash: string | null;
		setOpenHash(h: string | null): void;
		open: LedgerRow | null;
	};
	usePosition(): { at: number | null; setAt(p: number | null): void; shown: DeskData["at"] };
	useBreakdown(): ReturnType<DeskData["breakdown"]>;
	useColors(): ReturnType<DeskData["colors"]>;
	useSelection(): { dim: Dimension; keys: ReadonlySet<string> };
	useLit(key: string): "selected" | "hover" | "dim" | "rest";
	setHoverMoment: unknown;
	useHoverMoment: unknown;
	setHoverCategory: unknown;
	useHoverCategory: unknown;
	useShellBinding: unknown;
	DeskShellContext: unknown;
	DeskProvider: unknown;
}
let state: StateModule;
beforeAll(async () => {
	state = (await import(/* @vite-ignore */ `../src/app/desk/${"desk-state"}.js`)) as StateModule;
});

/** Run `hook` inside the desk's contexts and return what it gave. */
async function probe<T>(hook: () => T, o: Parameters<typeof withDesk>[1] = {}): Promise<T> {
	let out: { v: T } | null = null;
	await withDesk(
		createElement(function Probe() {
			out = { v: hook() };
			return null;
		}),
		o,
	);
	if (out === null) throw new Error("the probe did not render");
	return (out as { v: T }).v;
}

describe("the desk's hooks", () => {
	it("useSelection is the filter's values for the level's field", async () => {
		const view = { filters: { ...EMPTY_FILTERS, actors: ["a"] } };
		const lane = await probe(() => state.useSelection(), { view, data: { level: "lane" } });
		expect(lane.dim).toBe("lane");
		expect([...lane.keys]).toEqual(["a"]);
		const model = await probe(() => state.useSelection(), { view, data: { level: "model" } });
		expect(model.dim).toBe("model");
		expect(model.keys.size).toBe(0);
	});

	it("useLit is selected, dim or rest from the filter", async () => {
		const view = { filters: { ...EMPTY_FILTERS, actors: ["a"] } };
		expect(await probe(() => state.useLit("a"), { view })).toBe("selected");
		expect(await probe(() => state.useLit("b"), { view })).toBe("dim");
		expect(await probe(() => state.useLit("b"))).toBe("rest");
	});

	it("useFill.toggle fills, restores, and moves the fill", async () => {
		const calls: Array<WindowId | null> = [];
		const setFill = (id: WindowId | null): void => void calls.push(id);
		(await probe(() => state.useFill(), { view: { fill: null, setFill } })).toggle("share");
		(await probe(() => state.useFill(), { view: { fill: "share", setFill } })).toggle("share");
		(await probe(() => state.useFill(), { view: { fill: "spend", setFill } })).toggle("share");
		expect(calls).toEqual(["share", null, "share"]);
	});

	it("useFilters.clear writes the empty filter", async () => {
		const seen: Array<DeskView["filters"]> = [];
		const f = await probe(() => state.useFilters(), {
			view: {
				filters: { ...EMPTY_FILTERS, kinds: ["llm_call"] },
				setFilters: (x) => void seen.push(x),
			},
		});
		f.clear();
		expect(seen).toEqual([EMPTY_FILTERS]);
		expect(f.filters.kinds).toEqual(["llm_call"]);
	});

	it("useDimension carries the level the data says, apart from the chosen dimension", async () => {
		const d = await probe(() => state.useDimension(), {
			view: { dim: "lane" },
			data: { level: "model" },
		});
		expect(d.dim).toBe("lane");
		expect(d.level).toBe("model");
	});

	it("useRange carries the window the data says", async () => {
		const data = defaultDeskData();
		const r = await probe(() => state.useRange(), {
			view: { range: "1d" },
			data: { window: data.window },
		});
		expect(r.range).toBe("1d");
		expect(r.window).toBe(data.window);
	});

	it("useOpenRecord resolves the hash from the rows shown, and is null when absent", async () => {
		const rows = [row({ hash: "h".repeat(64), pos: 0 }), row({ hash: "k".repeat(64), pos: 1 })];
		const list = listView({
			rows,
			at: null,
			filters: EMPTY_FILTERS,
			phase: "loaded",
			summary: null,
		});
		const found = await probe(() => state.useOpenRecord(), {
			view: { openHash: "k".repeat(64) },
			data: { rows, list },
		});
		expect(found.open?.pos).toBe(1);
		const absent = await probe(() => state.useOpenRecord(), {
			view: { openHash: "z".repeat(64) },
			data: { rows, list },
		});
		expect(absent.open).toBeNull();
		const none = await probe(() => state.useOpenRecord(), { data: { rows, list } });
		expect(none.open).toBeNull();
	});

	it("usePosition.shown is the header's answer", async () => {
		const at = {
			pos: 4,
			ts: new Date(T0).toISOString(),
		} as unknown as NonNullable<DeskData["at"]>;
		const p = await probe(() => state.usePosition(), { view: { at: 4 }, data: { at } });
		expect(p.at).toBe(4);
		expect(p.shown).toBe(at);
	});

	it("useBreakdown and useColors return the thunks' values, and a tree that never reads them never calls them", async () => {
		const win = defaultDeskData().window;
		const b = breakdown(byActor({ a: 4 }), win, "lane");
		const breakdownFn = vi.fn(() => b);
		const colorsFn = vi.fn(() => defaultDeskData().colors());
		const got = await probe(() => state.useBreakdown(), { data: { breakdown: breakdownFn } });
		expect(got).toBe(b);
		expect(breakdownFn).toHaveBeenCalledTimes(1);
		await probe(() => state.useColors(), { data: { colors: colorsFn } });
		expect(colorsFn).toHaveBeenCalledTimes(1);

		const never = vi.fn(() => b);
		const neverColors = vi.fn(() => defaultDeskData().colors());
		await probe(() => state.useFill(), { data: { breakdown: never, colors: neverColors } });
		expect(never).not.toHaveBeenCalled();
		expect(neverColors).not.toHaveBeenCalled();
	});

	it("exports the hover functions and the shell binding from this one module", () => {
		for (const name of [
			"setHoverMoment",
			"useHoverMoment",
			"setHoverCategory",
			"useHoverCategory",
			"useShellBinding",
			"DeskShellContext",
			"DeskProvider",
		] as const)
			expect(typeof state[name]).not.toBe("undefined");
	});
});

describe("the provider keeps what the page had", () => {
	const src = readFileSync(join(import.meta.dirname, "../src/app/desk/desk-state.tsx"), "utf8");

	it("holds the list input through a drag, and draws one deferred input", () => {
		expect(src).toContain("useDeferredValue(heldInput(frozen, listInput))");
		expect(src).toContain("listView(drawn)");
		expect(src).toContain("const holdNote = heldNote(list.at, shownAt);");
		expect(src).toContain("setAnnounce((prev) => holdAnnouncement(prev, holdNote, shownAt));");
	});

	it("writes no ref while rendering", () => {
		expect(src).not.toMatch(/^\t[a-z]+\.current = /m);
	});

	it("calls effectiveLevel with its final shape: rows without the models filter, and the window", () => {
		// The formatter may break the call over lines: compare with whitespace and trailing commas removed.
		const flat = (t: string): string => t.replace(/\s+/g, "").replace(/,\)/g, ")");
		expect(flat(src)).toContain(
			flat(
				'effectiveLevel(dim, applyFilters(list.shownRows, withoutDimension(filters, "model")), window).dim',
			),
		);
		expect(src).not.toContain("effectiveLevel(dim, rows)");
	});

	it("takes the window from the drawn answer, never the newer shown position", () => {
		expect(src).toContain("deskWindow(range, list.at, nowMs)");
		expect(src).not.toContain("deskWindow(range, shownAt");
	});
});
