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
import { heldInput, heldNote, type ListInput, listView } from "../src/shared/list-view.js";
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
		// The server says the window starts at 0, the page's rows start at 50: the cut at 10 is empty. The server's window
		// covers the position, so these records are not held yet: no position the list holds is named.
		const v = listView({
			rows: held,
			at: at({ pos: 10, windowStartPos: 0 }),
			filters: EMPTY_FILTERS,
			phase: "loaded",
			summary: summary(),
		});
		expect(v.beforeWindow).toEqual({ kind: "not-held", upTo: 10 });
		expect(state(v)).toBe("before-window");
	});

	it("a position before the server's window, with rows held, names the first record the list holds", () => {
		const v = listView({
			rows: held,
			at: at({ pos: 10, windowStartPos: 50 }),
			filters: EMPTY_FILTERS,
			phase: "loaded",
			summary: summary(),
		});
		expect(v.beforeWindow).toEqual({ kind: "before", firstHeld: 50, upTo: 10 });
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

	it("with no rows held at all, no position is named as where the list starts: it holds none", () => {
		for (const windowStartPos of [0, 10, 70]) {
			const v = listView({
				rows: [],
				at: at({ pos: 10, windowStartPos }),
				filters: EMPTY_FILTERS,
				phase: "loaded",
				summary: summary(),
			});
			expect(v.beforeWindow).toEqual({ kind: "not-held", upTo: 10 });
		}
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
		// The page's own wiring, without React: the Scrubber says when a drag is on, the input is frozen then (from the
		// last one committed), and heldInput keeps it while it is.
		let frozen: ListInput | null = null;
		let committed: ListInput;
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
				frozen = a ? committed : null;
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
		committed = drawn;
		const render = (next: ListInput): void => {
			drawn = heldInput(frozen, next);
			committed = next;
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

	it("the page holds the list while the timeline says a drag is on, frozen in the drag's event, not while rendering", () => {
		const app = readFileSync(join(import.meta.dirname, "..", "src", "app", "app.tsx"), "utf-8");
		expect(app).toContain("useDeferredValue(heldInput(frozen, listInput))");
		expect(app).toContain("onHold={onHold}");
		expect(app).toMatch(/setFrozen\(on \? committed\.current : null\)/);
		// No ref is written during render: the committed input is recorded in an effect.
		expect(app).toMatch(
			/useEffect\(\(\) => \{\s*committed\.current = listInput;\s*\}, \[listInput\]\);/,
		);
		expect(app).not.toMatch(/^\t[a-z]+\.current = /m);
	});

	it("every view drawn from the list's input is marked from the drawn position, not from the drag", () => {
		const app = readFileSync(join(import.meta.dirname, "..", "src", "app", "app.tsx"), "utf-8");
		expect(app).toContain("const holdNote = heldNote(list.at, shownAt);");
		expect(app).not.toMatch(/setHolding|data-holding|aria-busy=\{holding\}/);
		// The list or Trends, the count, Export, the facets, both inspectors, and the note in the timeline.
		expect(app).toMatch(/className="ut-pane"[\s\S]{0,200}data-held=\{held\}\s*aria-busy=\{held\}/);
		expect(app).toContain('<span className="ut-label" role="status" data-held={held}>');
		expect(app).toMatch(/<ExportButton[\s\S]{0,120}held=\{held\}/);
		expect(app).toMatch(/<FilterBar [^>]*held=\{held\}/);
		expect(app.match(/<RowPanel[^>]*held=\{held\}/g)).toHaveLength(2);
		expect(app).toContain("holdNote={holdNote}");
		// Dimmed: opacity only, so nothing shifts. The drawer is dimmed inside, so it stays opaque over the page.
		const css = readFileSync(join(import.meta.dirname, "..", "src", "app", "styles.css"), "utf-8");
		const dim = /([^{}]*)\{\s*opacity: 0\.55;\s*\}/.exec(
			css.slice(css.indexOf('.ut-pane[data-held="true"]') - 1),
		);
		expect(dim?.[1]).toContain('.ut-pane[data-held="true"]');
		for (const sel of [
			'.ut-head .ut-label[data-held="true"]',
			'.ut-btn[data-held="true"]',
			'.ut-bar[data-held="true"] .ut-facet',
			'.ut-insp[data-held="true"] > .ut-insp-in',
			'.ut-drawer[data-held="true"] > .ut-insp-in',
		])
			expect(dim?.[1]).toContain(sel);
	});
});

describe("heldNote", () => {
	it("is null while the drawn views show the header's position, live or past", () => {
		expect(heldNote(null, null)).toBeNull();
		expect(heldNote(at({ pos: 40 }), at({ pos: 40 }))).toBeNull();
		// A re-read of the same position (another answer object) is not a held view.
		expect(heldNote(at({ pos: 40, statusAt: {} }), at({ pos: 40, epoch: 1 }))).toBeNull();
	});

	it("names the position coming, from 1, while they show another (during a drag, after one, after Back or Forward)", () => {
		expect(heldNote(at({ pos: 40 }), at({ pos: 61 }))).toBe("Updating to record 62…");
		expect(heldNote(null, at({ pos: 1_233 }))).toBe(
			`Updating to record ${(1_234).toLocaleString()}…`,
		);
	});

	it("says live when going Live, until the list catches up", () => {
		expect(heldNote(at({ pos: 40 }), null)).toBe("Updating to the live vault…");
	});

	it("after a release: the drag's frozen input is gone, but the list still draws the old position until it renders", () => {
		// What the page computes in the urgent render after release (the deferred value still the old input), then after.
		const old = at({ pos: 10 });
		const now = at({ pos: 63 });
		expect(heldNote(old, now)).not.toBeNull();
		expect(heldNote(now, now)).toBeNull();
	});
});
