// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the list draws, derived in one place from one (deferred) input: the rows at the position, the filters, the
 * chain the list reads, whether the position is before the rows held, and the load phase. The page calls `listView`
 * and hands its result to the list as it is, so these are the page's own derivations.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AtPayload, SummaryPayload } from "../src/shared/api.js";
import { listState } from "../src/shared/display.js";
import { EMPTY_FILTERS } from "../src/shared/filters.js";
import { heldInput, type ListInput, listView } from "../src/shared/list-view.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { Scrubber } from "../src/shared/scrub.js";

function row(pos: number): LedgerRow {
	return {
		seq: pos,
		pos,
		id: `id-${pos}`,
		ts: "2026-10-12T17:59:02.770Z",
		kind: "llm_call",
		actor: "local",
		hash: pos.toString(16).padStart(64, "0"),
		previousHash: "0".repeat(64),
		integrity: "verified",
		status: "settled",
	};
}

function at(over: Partial<AtPayload> = {}): AtPayload {
	return {
		pos: 40,
		ts: "2026-11-06T10:04:05.000Z",
		head: 99,
		clamped: false,
		epoch: 0,
		spentUt: 0,
		counts: { llm_call: 0, denied: 0, other: 0 },
		chain: { valid: true, breakIndex: null },
		budget: { ut: null, note: "" },
		plan: null,
		windowStartPos: 0,
		statusAt: {},
		...over,
	};
}

const summary = (over: Partial<SummaryPayload["chain"]> = {}): SummaryPayload =>
	({
		chain: { events: 100, valid: true, empty: false, breakIndex: null, errors: [], ...over },
	}) as unknown as SummaryPayload;

const held = Array.from({ length: 50 }, (_, i) => row(50 + i));

const state = (v: ReturnType<typeof listView>): ReturnType<typeof listState> =>
	listState({
		phase: v.phase,
		chain: v.chain,
		total: v.total,
		shown: v.filtered.length,
		beforeWindow: v.beforeWindow !== null,
	});

describe("listView", () => {
	it("an empty cut at T is before the window, whatever the server's windowStartPos says (a resync gap)", () => {
		// The server says the window starts at 0, the page's rows start at 50: the cut at 10 is empty.
		const v = listView({
			rows: held,
			at: at({ pos: 10, windowStartPos: 0 }),
			filters: EMPTY_FILTERS,
			phase: "loaded",
			summary: summary(),
		});
		expect(v.beforeWindow).toEqual({ firstHeld: 50, upTo: 10 });
		expect(state(v)).toBe("before-window");
	});

	it("at T, no-rows (the 'failed verification' state) is unreachable, rows held or not", () => {
		for (const rows of [held, []])
			for (const valid of [true, false])
				for (const windowStartPos of [0, 50, 200]) {
					const v = listView({
						rows,
						at: at({ pos: 10, windowStartPos, chain: { valid, breakIndex: valid ? null : 3 } }),
						filters: EMPTY_FILTERS,
						phase: "loaded",
						summary: summary(),
					});
					expect(state(v)).not.toBe("no-rows");
				}
	});

	it("with no rows held at all, the list starts where the server says", () => {
		const v = listView({
			rows: [],
			at: at({ pos: 10, windowStartPos: 70 }),
			filters: EMPTY_FILTERS,
			phase: "loaded",
			summary: summary(),
		});
		expect(v.beforeWindow).toEqual({ firstHeld: 70, upTo: 10 });
	});

	it("the chain at T is the position's; live, the summary's", () => {
		const broken = summary({ valid: false, breakIndex: 80 });
		expect(
			listView({
				rows: held,
				at: at({ pos: 60 }),
				filters: EMPTY_FILTERS,
				phase: "loaded",
				summary: broken,
			}).chain,
		).toBe("verified");
		expect(
			listView({ rows: held, at: null, filters: EMPTY_FILTERS, phase: "loaded", summary: broken })
				.chain,
		).toBe("broken");
	});

	it("the phase travels with the rows it describes: one input, one answer", () => {
		const loading = listView({
			rows: [],
			at: null,
			filters: EMPTY_FILTERS,
			phase: "loading",
			summary: null,
		});
		expect(state(loading)).toBe("loading");
		const loaded = listView({
			rows: held,
			at: null,
			filters: EMPTY_FILTERS,
			phase: "loaded",
			summary: summary(),
		});
		expect(loaded.phase).toBe("loaded");
		expect(state(loaded)).toBe("rows");
	});

	it("the page draws the list from listView over ONE deferred input, phase included", () => {
		const app = readFileSync(join(import.meta.dirname, "..", "src", "app", "app.tsx"), "utf-8");
		expect(app).toMatch(/useDeferredValue\(/);
		expect(app).toContain("listView(drawn)");
		expect(app).toContain("phase={list.phase}");
		expect(app).not.toMatch(/phase=\{phase\}/);
	});

	it("while dragging, the list's input does not change; on release it takes the latest, once", () => {
		// The page's own wiring, without React: the Scrubber says when a drag is on, and heldInput keeps the list's
		// input while it is.
		let holding = false;
		const frames: Array<() => void> = [];
		const scrub = new Scrubber(
			{
				frame: (fn) => {
					frames.push(fn);
					return () => {};
				},
				later: () => () => {},
			},
			() => {},
			() => {},
			(a) => {
				holding = a;
			},
		);
		const input = (pos: number | null): ListInput => ({
			rows: held,
			at: pos === null ? null : at({ pos }),
			filters: EMPTY_FILTERS,
			phase: "loaded",
			summary: summary(),
		});
		let drawn = input(null);
		const render = (next: ListInput): void => {
			drawn = heldInput(drawn, next, holding);
		};
		const before = drawn;
		scrub.move(60);
		for (const pos of [60, 61, 62, 63]) render(input(pos));
		expect(drawn).toBe(before);
		scrub.release();
		const last = input(63);
		render(last);
		expect(drawn).toBe(last);
	});

	it("the page holds the list while the timeline says a drag is on", () => {
		const app = readFileSync(join(import.meta.dirname, "..", "src", "app", "app.tsx"), "utf-8");
		expect(app).toMatch(/heldInput\(/);
		expect(app).toContain("onHold={setHolding}");
		// And shows it: the held list is dimmed (opacity only, so nothing shifts).
		expect(app).toContain("data-holding={holding}");
		const css = readFileSync(join(import.meta.dirname, "..", "src", "app", "styles.css"), "utf-8");
		expect(css).toMatch(/\.ut-body\[data-holding="true"\] \.ut-pane \{\s*opacity: 0\.55;\s*\}/);
	});
});
