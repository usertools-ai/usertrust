// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's rows, fitted to the Now window. The arithmetic and everything the effect does are plain functions over
 * the few sizes they read, so they run here against a page made of plain objects; the hook itself is rendered as
 * static markup, where it reads nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gridRowsStyle, homeGrid, rowsFor, rowsToFit } from "../src/shared/desk-grid.js";

const APP = join(import.meta.dirname, "..", "src", "app");

interface Sizes {
	deskHeightPx: number;
	nowBarPx: number;
	nowChildrenPx: number;
}
interface Box {
	offsetHeight: number;
}
interface BodyBox extends Box {
	children: Box[];
}
interface NowBox extends Box {
	offsetWidth: number;
	getAttribute(name: string): string | null;
	querySelector(sel: string): BodyBox | null;
}
interface DeskBox {
	clientHeight: number;
	scrollTop: number;
	querySelector(sel: string): NowBox | null;
}
interface RowFitModule {
	fitRows(s: Sizes): { top: number; bottom: number };
	measureDesk(desk: DeskBox): Sizes | null;
	watchRowFit(desk: DeskBox, onFit: (rows: string) => void): () => void;
	rowFitEffect(
		desk: DeskBox | null,
		paused: boolean,
		compact: boolean,
		onFit: (rows: string) => void,
	): (() => void) | undefined;
	useRowFit(ref: { current: DeskBox | null }, paused: boolean): string | null;
}

let fit: RowFitModule;
beforeAll(async () => {
	fit = (await import(/* @vite-ignore */ `../src/app/desk/${"use-row-fit"}.js`)) as RowFitModule;
});

/** The title bar's 44 px and the frame's two 1 px borders: what a window is around its body. */
const AROUND = 46;

interface NowSpec {
	/** The body's own height: what its row leaves it. */
	body: number;
	/** The heights of the body's children: what it holds. */
	children: number[];
	state?: string;
	width?: number;
	/** No body inside the window. */
	bodiless?: boolean;
}

/** A desk made of plain objects, with the few sizes the fit reads. It answers the two selectors the fit asks, only. */
function page(o: { desk: number; scrollTop?: number; now?: NowSpec | null }): {
	desk: DeskBox;
	now: NowSpec | null;
	kids: Box[];
} {
	const spec = o.now === undefined ? { body: 200, children: [339] } : o.now;
	const kids: Box[] = [];
	let now: NowBox | null = null;
	if (spec !== null) {
		// The children are read live, so a test can change a height after the page is made.
		for (const h of spec.children) kids.push({ offsetHeight: h });
		const body: BodyBox = {
			get offsetHeight() {
				return spec.body;
			},
			children: kids,
		};
		now = {
			get offsetHeight() {
				return AROUND + spec.body;
			},
			get offsetWidth() {
				return spec.width ?? 320;
			},
			getAttribute: (name) => {
				if (name !== "data-state") throw new Error(`unexpected attribute ${name}`);
				return spec.state ?? "home";
			},
			querySelector: (sel) => {
				if (sel !== ".ut-win-body") throw new Error(`unexpected selector ${sel}`);
				return spec.bodiless === true ? null : body;
			},
		};
	}
	const desk: DeskBox = {
		clientHeight: o.desk,
		scrollTop: o.scrollTop ?? 0,
		querySelector: (sel) => {
			if (sel !== '[data-win="now"]') throw new Error(`unexpected selector ${sel}`);
			return now;
		},
	};
	return { desk, now: spec, kids };
}

/** A stand-in for the browser's observer: it keeps what it was asked to watch, and the test fires it. */
class FakeObserver {
	static made: FakeObserver[] = [];
	watched: unknown[] = [];
	disconnected = false;
	constructor(readonly fire: () => void) {
		FakeObserver.made.push(this);
	}
	observe(el: unknown): void {
		this.watched.push(el);
	}
	disconnect(): void {
		this.disconnected = true;
	}
}

type Listener = () => void;
let listeners: Array<{ type: string; fn: Listener }> = [];
let removed: Array<{ type: string; fn: Listener }> = [];

beforeEach(() => {
	FakeObserver.made = [];
	listeners = [];
	removed = [];
	vi.stubGlobal("ResizeObserver", FakeObserver);
	vi.stubGlobal("window", {
		addEventListener: (type: string, fn: Listener) => listeners.push({ type, fn }),
		removeEventListener: (type: string, fn: Listener) => removed.push({ type, fn }),
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fitRows", () => {
	it("red-first (Now scrolled in a row a fixed 9/20 of the desk): a 1000 px desk gives Now the 11 rows its 385 px need", () => {
		expect(fit.fitRows({ deskHeightPx: 1000, nowBarPx: 45, nowChildrenPx: 340 })).toEqual({
			top: 14,
			bottom: 11,
		});
	});

	it("gives a Now that needs 100 px the least a window gets, and the upper row the rest", () => {
		expect(fit.fitRows({ deskHeightPx: 1000, nowBarPx: 45, nowChildrenPx: 55 })).toEqual({
			top: 21,
			bottom: 4,
		});
	});

	it("keeps the upper row at 9 on a 600 px desk, and Now's rows whole: the desk will scroll", () => {
		const g = fit.fitRows({ deskHeightPx: 600, nowBarPx: 45, nowChildrenPx: 340 });
		expect(g).toEqual({ top: 9, bottom: 11 });
		expect(g.top + g.bottom).toBeGreaterThan(rowsFor(600));
	});

	it("counts what is around the body with what the body holds: either can cost a row", () => {
		expect(fit.fitRows({ deskHeightPx: 1000, nowBarPx: 0, nowChildrenPx: 380 }).bottom).toBe(10);
		expect(fit.fitRows({ deskHeightPx: 1000, nowBarPx: 44, nowChildrenPx: 380 }).bottom).toBe(11);
		// The frame's two pixels are the difference of a row here: 426 px does not fit a window of 424.
		expect(fit.fitRows({ deskHeightPx: 1000, nowBarPx: 46, nowChildrenPx: 380 }).bottom).toBe(12);
		expect(fit.fitRows({ deskHeightPx: 1000, nowBarPx: 380, nowChildrenPx: 46 }).bottom).toBe(12);
	});

	it("counts the desk's rows from its height: one pixel short of a row is a row fewer above", () => {
		expect(fit.fitRows({ deskHeightPx: 984, nowBarPx: 44, nowChildrenPx: 380 })).toEqual({
			top: 14,
			bottom: 11,
		});
		expect(fit.fitRows({ deskHeightPx: 983, nowBarPx: 44, nowChildrenPx: 380 })).toEqual({
			top: 13,
			bottom: 11,
		});
	});

	it("is the grid's own arithmetic, for every size", () => {
		for (let deskHeightPx = 400; deskHeightPx <= 1300; deskHeightPx += 37) {
			for (let nowChildrenPx = 0; nowChildrenPx <= 700; nowChildrenPx += 13) {
				expect(fit.fitRows({ deskHeightPx, nowBarPx: AROUND, nowChildrenPx })).toEqual(
					homeGrid(rowsFor(deskHeightPx), rowsToFit(AROUND + nowChildrenPx)),
				);
			}
		}
	});
});

describe("measureDesk", () => {
	it("reads the desk's height, what is around Now's body, and the sum of what the body holds", () => {
		const { desk } = page({ desk: 733, now: { body: 150, children: [300, 85, 4] } });
		expect(fit.measureDesk(desk)).toEqual({
			deskHeightPx: 733,
			nowBarPx: AROUND,
			nowChildrenPx: 389,
		});
	});

	it("reads what the body holds, not the body's own height: a body shorter or taller than its content changes nothing", () => {
		const short = page({ desk: 800, now: { body: 100, children: [339] } });
		const tall = page({ desk: 800, now: { body: 900, children: [339] } });
		expect(fit.measureDesk(short.desk)).toEqual(fit.measureDesk(tall.desk));
		expect(fit.measureDesk(short.desk)?.nowChildrenPx).toBe(339);
		expect(fit.measureDesk(short.desk)?.nowBarPx).toBe(AROUND);
	});

	it("an empty body holds nothing", () => {
		const { desk } = page({ desk: 800, now: { body: 300, children: [] } });
		expect(fit.measureDesk(desk)).toEqual({
			deskHeightPx: 800,
			nowBarPx: AROUND,
			nowChildrenPx: 0,
		});
	});

	it("says nothing when there is no Now window, or it has no body", () => {
		expect(fit.measureDesk(page({ desk: 800, now: null }).desk)).toBeNull();
		expect(
			fit.measureDesk(page({ desk: 800, now: { body: 1, children: [1], bodiless: true } }).desk),
		).toBeNull();
	});

	it("says nothing for a Now window that is not laid out", () => {
		const hidden = page({ desk: 800, now: { body: 200, children: [339], width: 0 } });
		expect(fit.measureDesk(hidden.desk)).toBeNull();
		const thin = page({ desk: 800, now: { body: 200, children: [339], width: 1 } });
		expect(fit.measureDesk(thin.desk)).not.toBeNull();
	});

	it("says nothing while Now is on its way to or from filling the desk: it is then the desk's size, not its cell's", () => {
		for (const state of ["grow", "filled", "shrink"]) {
			const flying = page({ desk: 800, now: { body: 700, children: [250], state } });
			expect(fit.measureDesk(flying.desk), state).toBeNull();
		}
		const home = page({ desk: 800, now: { body: 700, children: [250], state: "home" } });
		expect(fit.measureDesk(home.desk)).not.toBeNull();
	});
});

describe("watchRowFit", () => {
	it("red-first: tells the rows at once, as the desk's grid-template-rows", () => {
		const told: string[] = [];
		const { desk } = page({ desk: 1000, now: { body: 400, children: [339] } });
		fit.watchRowFit(desk, (rows) => told.push(rows));
		// 46 px around and 339 px held: the 385 px that need 11 rows of a 25-row desk.
		expect(told).toEqual(["544px 424px"]);
		expect(told[0]).toBe(gridRowsStyle({ top: 14, bottom: 11 }));
	});

	it("watches the desk and each child of Now's body, with one observer", () => {
		const { desk, kids } = page({ desk: 1000, now: { body: 400, children: [300, 39] } });
		fit.watchRowFit(desk, () => undefined);
		expect(FakeObserver.made).toHaveLength(1);
		expect(FakeObserver.made[0]?.watched).toEqual([desk, kids[0], kids[1]]);
		expect(FakeObserver.made[0]?.watched[0]).toBe(desk);
		expect(FakeObserver.made[0]?.watched[1]).toBe(kids[0]);
	});

	it("measures again when a watched box changes size, and tells the rows only when they changed", () => {
		const told: string[] = [];
		const p = page({ desk: 1000, now: { body: 400, children: [339] } });
		fit.watchRowFit(p.desk, (rows) => told.push(rows));
		const fire = FakeObserver.made[0]?.fire ?? (() => undefined);
		fire();
		fire();
		expect(told).toEqual(["544px 424px"]);
		// A line of Now wraps: 40 px more is a row more below, and one fewer above.
		(p.kids[0] as Box).offsetHeight = 379;
		fire();
		expect(told).toEqual(["544px 424px", "504px 464px"]);
		fire();
		expect(told).toHaveLength(2);
		// Back to what it was: that is a change too.
		(p.kids[0] as Box).offsetHeight = 339;
		fire();
		expect(told).toEqual(["544px 424px", "504px 464px", "544px 424px"]);
	});

	it("measures again when the browser window is resized", () => {
		const told: string[] = [];
		const p = page({ desk: 1000, now: { body: 400, children: [339] } });
		fit.watchRowFit(p.desk, (rows) => told.push(rows));
		expect(listeners.map((l) => l.type)).toEqual(["resize"]);
		p.desk.clientHeight = 600;
		listeners[0]?.fn();
		expect(told).toEqual(["544px 424px", "344px 424px"]);
	});

	it("tells nothing while Now cannot be read, keeps watching, and tells the rows once it can", () => {
		const told: string[] = [];
		const p = page({ desk: 1000, now: { body: 954, children: [200], state: "shrink" } });
		fit.watchRowFit(p.desk, (rows) => told.push(rows));
		expect(told).toEqual([]);
		// Now's children are watched from the start, so the fit hears of it when Now is back in its cell.
		expect(FakeObserver.made[0]?.watched).toEqual([p.desk, p.kids[0]]);
		(p.now as NowSpec).state = "home";
		(p.kids[0] as Box).offsetHeight = 339;
		FakeObserver.made[0]?.fire();
		expect(told).toEqual(["544px 424px"]);
	});

	it("watches the desk alone when it has no Now window", () => {
		const told: string[] = [];
		const { desk } = page({ desk: 1000, now: null });
		fit.watchRowFit(desk, (rows) => told.push(rows));
		expect(told).toEqual([]);
		expect(FakeObserver.made[0]?.watched).toEqual([desk]);
	});

	it("its clean-up stops the observer and takes the same listener back", () => {
		const { desk } = page({ desk: 1000 });
		const stop = fit.watchRowFit(desk, () => undefined);
		expect(FakeObserver.made[0]?.disconnected).toBe(false);
		expect(removed).toEqual([]);
		stop();
		expect(FakeObserver.made[0]?.disconnected).toBe(true);
		expect(removed.map((l) => l.type)).toEqual(["resize"]);
		expect(removed[0]?.fn).toBe(listeners[0]?.fn);
	});

	it("still measures, on a resize, where the browser has no observer", () => {
		vi.stubGlobal("ResizeObserver", undefined);
		const told: string[] = [];
		const p = page({ desk: 1000, now: { body: 400, children: [339] } });
		const stop = fit.watchRowFit(p.desk, (rows) => told.push(rows));
		expect(told).toEqual(["544px 424px"]);
		expect(FakeObserver.made).toHaveLength(0);
		p.desk.clientHeight = 600;
		listeners[0]?.fn();
		expect(told).toEqual(["544px 424px", "344px 424px"]);
		expect(() => stop()).not.toThrow();
		expect(removed.map((l) => l.type)).toEqual(["resize"]);
	});

	it("never writes to the page: the desk's scroll is left where it is", () => {
		const { desk } = page({ desk: 600, scrollTop: 120 });
		fit.watchRowFit(desk, () => undefined)();
		expect(desk.scrollTop).toBe(120);
	});
});

describe("rowFitEffect", () => {
	it("fits the rows of a desk at home, and hands back the clean-up", () => {
		const told: string[] = [];
		const { desk } = page({ desk: 1000, scrollTop: 120, now: { body: 400, children: [339] } });
		const stop = fit.rowFitEffect(desk, false, false, (rows) => told.push(rows));
		expect(told).toEqual(["544px 424px"]);
		expect(FakeObserver.made).toHaveLength(1);
		// A desk too short for its rows is scrolled by its reader, never by the fit.
		expect(desk.scrollTop).toBe(120);
		expect(typeof stop).toBe("function");
		stop?.();
		expect(FakeObserver.made[0]?.disconnected).toBe(true);
		expect(removed).toHaveLength(1);
	});

	it("red-first (a filled window lying over a scrolled desk): when a fill starts it puts the desk at its top, and measures nothing", () => {
		const told: string[] = [];
		const { desk } = page({ desk: 600, scrollTop: 120 });
		const stop = fit.rowFitEffect(desk, true, false, (rows) => told.push(rows));
		expect(desk.scrollTop).toBe(0);
		expect(stop).toBeUndefined();
		expect(told).toEqual([]);
		expect(FakeObserver.made).toHaveLength(0);
		expect(listeners).toEqual([]);
	});

	it("does nothing in the compact column, filled or not: there are no rows to fit and the page is the scroller", () => {
		for (const paused of [false, true]) {
			const told: string[] = [];
			const { desk } = page({ desk: 2400, scrollTop: 120 });
			expect(fit.rowFitEffect(desk, paused, true, (rows) => told.push(rows))).toBeUndefined();
			expect(told).toEqual([]);
			expect(desk.scrollTop).toBe(120);
			expect(FakeObserver.made).toHaveLength(0);
			expect(listeners).toEqual([]);
		}
	});

	it("does nothing before the desk is in the page", () => {
		for (const paused of [false, true]) {
			const told: string[] = [];
			expect(fit.rowFitEffect(null, paused, false, (rows) => told.push(rows))).toBeUndefined();
			expect(told).toEqual([]);
			expect(FakeObserver.made).toHaveLength(0);
			expect(listeners).toEqual([]);
		}
	});
});

describe("useRowFit", () => {
	/** A desk that fails the test if anything at all is read from it or written to it. */
	const untouchable = new Proxy({} as DeskBox, {
		get: (_t, key) => {
			throw new Error(`read ${String(key)} while rendering`);
		},
		set: (_t, key) => {
			throw new Error(`wrote ${String(key)} while rendering`);
		},
	});

	it("gives no rows under static markup, and reads nothing from the desk while rendering", () => {
		for (const paused of [false, true]) {
			function Probe(): React.JSX.Element {
				return createElement("p", null, String(fit.useRowFit({ current: untouchable }, paused)));
			}
			expect(renderToStaticMarkup(createElement(Probe))).toBe("<p>null</p>");
		}
		expect(FakeObserver.made).toHaveLength(0);
		expect(listeners).toEqual([]);
	});

	const source = readFileSync(join(APP, "desk", "use-row-fit.ts"), "utf-8");
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

	it("red-first (rows fitted after the first paint, so the page moved): measures in a layout effect, through the one function the tests run, and keeps the rows it is told", () => {
		// A layout effect runs before the browser paints: the Now window's boxes are already reserved then, so the
		// first frame has the fitted rows.
		expect(code).toContain('import { type RefObject, useLayoutEffect, useState } from "react";');
		expect(code).not.toMatch(/\buseEffect\b/);
		expect(code).toContain("const [fit, setFit] = useState<string | null>(null);");
		expect(code.replace(/\s+/g, " ")).toContain(
			"useLayoutEffect( () => rowFitEffect(deskRef.current, paused, compact, setFit), [deskRef, paused, compact], );",
		);
		expect(code.match(/useLayoutEffect\(/g)).toHaveLength(1);
	});

	it("red-first (the windows stepped to other rows when one filled the desk): keeps the fitted rows while a window fills the desk, and gives none in the compact column", () => {
		expect(code).toContain("const compact = useMedia(COMPACT_QUERY, false);");
		expect(code).toContain("return compact ? null : fit;");
		// The rows are not a matter of `paused`: it stops the measuring, nothing else.
		expect(
			code.slice(code.indexOf("export function useRowFit(")).match(/\bpaused\b/g),
		).toHaveLength(3);
	});

	it("touches the browser only where the effect runs: one listener put on and taken off, no frame, clock or document", () => {
		expect(code.match(/\bwindow\./g)).toHaveLength(2);
		expect(code).toContain('window.addEventListener("resize", measure);');
		expect(code).toContain('window.removeEventListener("resize", measure);');
		for (const word of ["document", "matchMedia", "requestAnimationFrame", "performance"]) {
			expect(code, word).not.toContain(word);
		}
		// The hook's own body is four lines: nothing in it reads the page.
		const hook = code.slice(code.indexOf("export function useRowFit("));
		for (const read of ["offsetHeight", "clientHeight", "querySelector", "scrollTop", "window"]) {
			expect(hook, read).not.toContain(read);
		}
	});
});

describe("what the measure stands on", () => {
	it("the window marks itself, its phase and its body the way the fit looks for them", () => {
		const win = readFileSync(join(APP, "desk", "window.tsx"), "utf-8");
		expect(win).toContain("data-win={id}");
		expect(win).toContain("data-state={phase}");
		expect(win).toContain('className="ut-win-body"');
		expect(win).toContain('useState<Phase>(target ? "filled" : "home")');
	});

	it("Now's body holds one box that takes its content's height, whatever the height of the window", () => {
		const now = readFileSync(join(APP, "windows", "now", "now-window.tsx"), "utf-8");
		expect(now).toContain('<div className="ut-nw" data-gen={gen}>');
		const css = readFileSync(join(APP, "windows", "now", "now.css"), "utf-8");
		// Were this box to grow with the window, the fit would read back the height it had just set.
		expect(/\n\t\.ut-nw \{([^}]*)\}/.exec(css)?.[1]).toMatch(/flex:\s*0 0 auto;/);
	});
});
