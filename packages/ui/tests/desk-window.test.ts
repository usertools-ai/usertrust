// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Window: the chrome every desk window shares. One fill path, a fill button that never unmounts, solid panes, and
 * the other windows inert and hidden from assistive tech while one fills the desk.
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { WindowId } from "../src/shared/desk-layout.js";
import { withDesk } from "./helpers/desk.js";

interface WindowModule {
	Window(props: {
		id: WindowId;
		title: string;
		subtitle?: React.ReactNode;
		actions?: React.ReactNode;
		children: (filled: boolean) => React.ReactNode;
	}): React.JSX.Element;
	useWindow(): { id: WindowId; filled: boolean; settling: boolean; dimmed: boolean };
	useWindowDimmed(): boolean;
	fillGesture(
		kind: "enter" | "dblclick",
		target: { closest(sel: string): unknown } | null,
		bar: unknown,
	): boolean;
}

let mod: WindowModule;
beforeAll(async () => {
	mod = (await import(/* @vite-ignore */ `../src/app/desk/${"window"}.js`)) as WindowModule;
});

/** Window takes a render-prop as its one child; createElement's typing only knows node children, so it is cast once. */
const asChild = (fn: (filled: boolean) => React.ReactNode): React.ReactNode =>
	fn as unknown as React.ReactNode;

function win(id: WindowId, title: string, seen: boolean[] = [], actions?: React.ReactNode) {
	return createElement(
		mod.Window as unknown as React.ComponentType<{
			id: WindowId;
			title: string;
			actions?: React.ReactNode;
		}>,
		{ id, title, ...(actions === undefined ? {} : { actions }) },
		asChild((filled) => {
			seen.push(filled);
			return createElement("p", null, `body of ${id}`);
		}),
	);
}

/** The opening tag of the first element whose markup contains `marker`. */
function tagWith(html: string, marker: string): string {
	const at = html.indexOf(marker);
	const start = html.lastIndexOf("<", at);
	return html.slice(start, html.indexOf(">", at) + 1);
}

describe("a window at home", () => {
	it("is a labelled section with a focusable title bar and a button to fill the desk", async () => {
		const seen: boolean[] = [];
		const html = await withDesk(win("spend", "Spend", seen));
		const section = tagWith(html, 'data-win="spend"');
		expect(section).toContain("<section");
		expect(section).toContain('aria-label="Spend"');
		expect(section).toContain('data-filled="false"');
		expect(html).toMatch(/<[a-z]+[^>]*tabindex="0"[^>]*>/);
		const button = tagWith(html, 'aria-label="Fill the desk with Spend"');
		expect(button).toContain("<button");
		expect(button).toContain('aria-pressed="false"');
		expect(seen).toEqual([false]);
	});

	it("is not inert, hidden or dimmed, and neither is any other window", async () => {
		const html = await withDesk(
			createElement(
				"div",
				null,
				win("spend", "Spend"),
				win("share", "Share of spend"),
				win("ledger", "Ledger"),
				win("now", "Now"),
			),
		);
		expect(html).not.toContain("inert");
		expect(html).not.toContain("data-dim");
		for (const id of ["spend", "share", "ledger", "now"]) {
			expect(tagWith(html, `data-win="${id}"`)).not.toContain("aria-hidden");
		}
	});
});

describe("a window that fills the desk", () => {
	it("says so, offers Restore from the same button, and tells its children", async () => {
		const seen: boolean[] = [];
		const html = await withDesk(win("spend", "Spend", seen), { fill: "spend" });
		expect(tagWith(html, 'data-win="spend"')).toContain('data-filled="true"');
		const button = tagWith(html, 'aria-label="Restore Spend"');
		expect(button).toContain("<button");
		expect(button).toContain('aria-pressed="true"');
		expect(html).not.toContain("Fill the desk with Spend");
		expect(seen).toEqual([true]);
	});

	it("makes every other window inert and hidden from assistive tech, but keeps it in the tree", async () => {
		const html = await withDesk(
			createElement("div", null, win("spend", "Spend"), win("share", "Share of spend")),
			{ fill: "spend" },
		);
		const share = tagWith(html, 'data-win="share"');
		expect(share).toContain('inert=""');
		expect(share).toContain('aria-hidden="true"');
		expect(share).toContain('data-dim="true"');
		expect(html).toContain("body of share");
		const spend = tagWith(html, 'data-win="spend"');
		expect(spend).not.toContain("inert");
		expect(spend).not.toContain("aria-hidden");
	});
});

describe("the chrome", () => {
	it("renders the actions inside the title bar", async () => {
		const html = await withDesk(
			win("spend", "Spend", [], createElement("span", { className: "probe" }, "1w")),
		);
		const bar = html.slice(html.indexOf('class="ut-win-bar'), html.indexOf('class="ut-win-body'));
		expect(bar).toContain('class="probe"');
		expect(bar).toContain("Fill the desk with Spend");
	});

	it("has a body that scrolls on its own", async () => {
		const html = await withDesk(win("ledger", "Ledger"));
		expect(html).toContain('class="ut-win-body"');
	});

	it("marks a held body, except Now, which follows the header and not the deferred list", async () => {
		const held = await withDesk(win("ledger", "Ledger"), { held: true });
		const body = tagWith(held, 'class="ut-win-body"');
		expect(body).toContain('data-held="true"');
		expect(body).toContain('aria-busy="true"');
		const fresh = await withDesk(win("ledger", "Ledger"), { held: false });
		expect(tagWith(fresh, 'class="ut-win-body"')).not.toContain('data-held="true"');
		const now = await withDesk(win("now", "Now"), { held: true });
		const nowBody = tagWith(now, 'class="ut-win-body"');
		expect(nowBody).not.toContain("data-held");
		expect(nowBody).not.toContain("aria-busy");
	});
});

describe("fillGesture", () => {
	const bar = { id: "bar" };
	const inside = (hit: unknown) => ({ closest: () => hit });

	it("fills on Enter or a double-click on the bar itself or its text", () => {
		expect(mod.fillGesture("enter", inside(null), bar)).toBe(true);
		expect(mod.fillGesture("dblclick", inside(null), bar)).toBe(true);
		expect(mod.fillGesture("enter", inside(bar), bar)).toBe(true);
	});

	it("does not fill from a control inside the bar", () => {
		const button = { id: "button" };
		expect(mod.fillGesture("enter", inside(button), bar)).toBe(false);
		expect(mod.fillGesture("dblclick", inside(button), bar)).toBe(false);
	});

	it("asks for buttons, links, inputs, selects and role=button", () => {
		let asked = "";
		mod.fillGesture(
			"enter",
			{
				closest: (sel: string) => {
					asked = sel;
					return null;
				},
			},
			bar,
		);
		for (const part of ["button", "a", "input", "select", "[role=button]"]) {
			expect(asked.split(",").map((s) => s.trim())).toContain(part);
		}
	});

	it("does not fill with no target", () => {
		expect(mod.fillGesture("enter", null, bar)).toBe(false);
	});
});

describe("useWindow", () => {
	it("throws outside a Window", () => {
		function Probe(): React.JSX.Element {
			mod.useWindow();
			return createElement("p");
		}
		expect(() => renderToStaticMarkup(createElement(Probe))).toThrow("useWindow outside Window");
	});

	it("names the window, whether it is filled, and that it is not settling at rest", async () => {
		function Probe(): React.JSX.Element {
			const w = mod.useWindow();
			return createElement("p", null, `${w.id} ${w.filled} ${w.settling}`);
		}
		const html = await withDesk(
			createElement(
				mod.Window as unknown as React.ComponentType<{ id: WindowId; title: string }>,
				{ id: "share", title: "Share of spend" },
				asChild(() => createElement(Probe)),
			),
			{ fill: "share" },
		);
		expect(html).toContain("<p>share true false</p>");
	});

	it("red-first (an explainer left open behind a filled window): says whether another window fills the desk", async () => {
		// Filled from the keyboard, another window left Now's open explainer mounted, inert and out of sight, and the next
		// Esc closed it instead of restoring the desk. What a window holds open must know it is dimmed.
		function Probe(): React.JSX.Element {
			const w = mod.useWindow();
			return createElement(
				"p",
				null,
				`${w.id} dimmed ${String(w.dimmed)} ${String(mod.useWindowDimmed())}`,
			);
		}
		const body = (id: WindowId, title: string) =>
			createElement(
				mod.Window as unknown as React.ComponentType<{ id: WindowId; title: string }>,
				{ id, title },
				asChild(() => createElement(Probe)),
			);
		const filled = await withDesk(
			createElement("div", null, body("spend", "Spend"), body("now", "Now")),
			{
				fill: "spend",
			},
		);
		expect(filled).toContain("<p>now dimmed true true</p>");
		expect(filled).toContain("<p>spend dimmed false false</p>");
		const rest = await withDesk(body("now", "Now"), {});
		expect(rest).toContain("<p>now dimmed false false</p>");
	});

	it("red-first (an explainer left open in a dimmed window): the explainers' hook closes an open one when its window is dimmed, and every explainer hands it its own close", () => {
		// Pinned in the source: these tests run without a DOM (no jsdom or any other in the repo), so React runs no
		// effect here, as at-follow's dependency pin says. The browser check runs it: one Esc restores the desk.
		const src = readFileSync(new URL("../src/app/summary-strip.tsx", import.meta.url), "utf-8");
		const start = src.indexOf("function usePopPlace(");
		expect(start).toBeGreaterThan(-1);
		const hook = src.slice(start, src.indexOf("\n}\n", start));
		expect(hook).toContain("const dimmed = useWindowDimmed();");
		expect(hook).toMatch(
			/useEffect\(\(\) => \{\s*if \(open && dimmed\) close\(\);\s*\}, \[open, dimmed, close\]\);/,
		);
		expect(src).toContain('import { useWindowDimmed } from "./desk/window.js";');
		// The Anchor and UT explainers (usePopover's close) and a cut fact line's explainer (its own close).
		// The fact line also hands its line (`, el`), placed from it.
		expect(src.match(/usePopPlace\([^)]*, popRef, close(?:, el)?\)/g)?.length).toBe(3);
		expect(src.match(/usePopPlace\(/g)?.length).toBe(4);
	});

	it("red-first (a cut line's explainer placed from its whole fact): a fact line's explainer is placed from its own line", () => {
		// Pinned in the source, as the dimmed close is: these tests have no DOM. The fact line hands the hook its line, and
		// the hook measures the room from it (placePop's `line`). Placed from the whole fact, a cut line's explainer near
		// the bottom of a short Now window was capped to 23px over a line in view.
		const src = readFileSync(new URL("../src/app/summary-strip.tsx", import.meta.url), "utf-8");
		expect(src).toContain("usePopPlace(cut && open, popRef, close, el)");
		const start = src.indexOf("function usePopPlace(");
		const hook = src.slice(start, src.indexOf("\n}\n", start));
		expect(hook).toContain(
			"const lineBox = line !== null && line !== anchor ? line.getBoundingClientRect() : null;",
		);
		expect(hook).toContain("outside(lineBox ?? at, clip)");
		expect(hook).toMatch(/placePopAt\(at, [^\n]*, lineBox\)/);
		// The line is watched with the boxes around it (its window, its body, its fact): a line that changes size inside a
		// fact whose own box does not change still places its explainer again.
		expect(hook).toMatch(
			/whenMoved\(\s*\[\.\.\.clippers\(pop\), anchor, \.\.\.\(line !== null && line !== anchor \? \[line\] : \[\]\)\],/,
		);
	});

	it("outside a Window, nothing is dimmed (and asking does not throw)", () => {
		function Probe(): React.JSX.Element {
			return createElement("p", null, `dimmed ${String(mod.useWindowDimmed())}`);
		}
		expect(renderToStaticMarkup(createElement(Probe))).toBe("<p>dimmed false</p>");
	});
});
