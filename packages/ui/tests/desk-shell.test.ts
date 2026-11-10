// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The shell: the page the desk makes of four windows, the top bar, the status under it and the filters. Rendered as static
 * markup inside the desk's contexts (`withDesk`); the parts that need a browser (focus after a fill, the glass, Esc)
 * are pinned in the source here and walked in the browser gate.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appSource } from "./helpers/app-source.js";
import { appExport, type Component, dayOneSummary, loadedData } from "./helpers/day-one.js";
import { withDesk } from "./helpers/desk.js";

let DeskShell: Component<Record<string, never>>;
beforeAll(async () => {
	DeskShell = await appExport("desk/desk-shell", "DeskShell");
});

// The Ledger window's list asks whether it is on a phone (window.matchMedia) as it first renders; there is no browser here.
beforeEach(() => {
	vi.stubGlobal("window", {
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const shell = (o: Parameters<typeof withDesk>[1] = {}): Promise<string> =>
	withDesk(createElement(DeskShell, {}), o);

const APP = join(import.meta.dirname, "..", "src", "app");

/** Every opening tag in the markup that carries `marker`, in order. */
function tagsWith(html: string, marker: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/<[a-z][^>]*>/g)) if (m[0].includes(marker)) out.push(m[0]);
	return out;
}

/** The class names on one opening tag. */
function classesOf(tag: string): string[] {
	return /\bclass="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? [];
}

describe("the desk shell", () => {
	it("has exactly four windows, in the order spend, share, ledger, now", async () => {
		const html = await shell();
		const wins = tagsWith(html, "data-win=").map((t) => /data-win="([a-z]+)"/.exec(t)?.[1]);
		expect(wins).toEqual(["spend", "share", "ledger", "now"]);
	});

	it("puts the page in the desk's frame: backdrop, top bar, the status under it, filters, then the desk", async () => {
		const html = await shell({ data: loadedData() });
		const order = [
			'class="ut-dk"',
			'class="ut-dk-backdrop"',
			'class="ut-dk-top ut-glass"',
			'class="ut-at-status"',
			'class="ut-dk-filters"',
			'class="ut-dk-desk"',
		].map((s) => html.indexOf(s));
		for (const at of order) expect(at).toBeGreaterThan(-1);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("puts the glass on the top bar, and never on a window's frame or body", async () => {
		const html = await shell({ data: loadedData() });
		const top = tagsWith(html, "ut-dk-top").filter((t) => classesOf(t).includes("ut-dk-top"));
		expect(top).toHaveLength(1);
		expect(top[0]).toContain("<header");
		expect(classesOf(top[0] ?? "")).toContain("ut-glass");
		// Glass is for controls (the top bar, a window's own controls), never for a pane: frames and bodies stay solid.
		const panes = tagsWith(html, "ut-win").filter((t) =>
			classesOf(t).some((c) => c === "ut-win" || c === "ut-win-body"),
		);
		expect(panes).toHaveLength(8);
		for (const tag of panes) expect(classesOf(tag)).not.toContain("ut-glass");
	});

	it("a vault the list does not hold whole: the Window notice is on the page once, in the top bar, whichever window fills the desk", async () => {
		const data = loadedData({ summary: dayOneSummary({ truncated: true, rowCount: 3 }) });
		for (const fill of [null, "spend", "share", "ledger", "now"] as const) {
			const html = await shell({ fill, data });
			if (fill !== null) expect(html).toContain(`data-win="${fill}" data-filled="true"`);
			expect(html.split('class="ut-notice"').length - 1).toBe(1);
			expect(html.split("<b>Window</b>").length - 1).toBe(1);
			// In the top bar, with the header: no window carries it, so none can hide it.
			const top = html.slice(
				html.indexOf('class="ut-dk-top ut-glass"'),
				html.indexOf('class="ut-at-status"'),
			);
			expect(top).toContain(
				'<div class="ut-notice" role="status"><b>Window</b>Showing the newest 3 of ',
			);
			expect(top).not.toContain("ut-asat");
			// The as-at line is the Now window's, once.
			expect(html.split('class="ut-asat"').length - 1).toBe(1);
			expect(html.indexOf('class="ut-asat"')).toBeGreaterThan(html.indexOf('data-win="now"'));
		}
		// A vault held whole has no notice anywhere.
		expect(await shell({ data: loadedData() })).not.toContain("ut-notice");
	});

	it("red-first (no mark on the desk for a filled window): draws the desk with its first-paint rows, and says whether a window fills it", async () => {
		// Without a page nothing is measured, so the rows are the ones the desk starts with.
		const home = tagsWith(await shell(), "ut-dk-desk");
		expect(home).toEqual([
			'<main class="ut-dk-desk" data-filled="false" style="grid-template-rows:minmax(0, 11fr) minmax(0, 9fr)">',
		]);
		for (const fill of ["spend", "share", "ledger", "now"] as const) {
			expect(tagsWith(await shell({ fill }), "ut-dk-desk"), fill).toEqual([
				'<main class="ut-dk-desk" data-filled="true" style="grid-template-rows:minmax(0, 11fr) minmax(0, 9fr)">',
			]);
		}
	});

	it("draws no slider and keeps the status under the header mounted, whatever the data", async () => {
		for (const data of [{}, loadedData(), { summary: dayOneSummary() }]) {
			const html = await shell({ data });
			expect(html).not.toContain('type="range"');
			expect(html).not.toContain("ut-tl-range");
			expect(html.match(/class="ut-at-status"/g)).toHaveLength(1);
		}
	});

	it("the status under the header says why a point did not show, and that one is loading", async () => {
		const failed = await shell({
			shell: {
				status: {
					error: "the dashboard did not answer",
					loading: false,
					reloaded: false,
					announce: "",
				},
			},
		});
		expect(failed).toContain("Could not show that point: the dashboard did not answer.");
		const loading = await shell({
			shell: { status: { error: null, loading: true, reloaded: false, announce: "" } },
		});
		expect(loading).toContain("Loading this point…");
	});

	it("keeps the search box to the length the address holds, under the same name and placeholder", async () => {
		const html = await shell();
		const search = tagsWith(html, 'type="search"');
		expect(search).toHaveLength(1);
		// React writes the attribute as `maxLength` in static markup; HTML reads it either way.
		expect(search[0]?.toLowerCase()).toContain('maxlength="512"');
		expect(search[0]).toContain('aria-label="search the ledger"');
		expect(search[0]).toContain('placeholder="Search id, actor, model, error');
	});

	it("announces the record count as a status", async () => {
		const html = await shell({ shell: { count: "3 records" } });
		const count = tagsWith(html, 'role="status"').filter((t) => t.includes("ut-label"));
		expect(count).toHaveLength(1);
		expect(html).toContain("3 records</span>");
	});

	it("says so when the address does not hold the view, and when the browser refused to update it", async () => {
		expect(await shell({ shell: { addressNote: "cannot-hold" } })).toContain(
			"Not kept in the address",
		);
		expect(await shell({ shell: { addressNote: "behind" } })).toContain("Address not updated yet");
		const none = await shell();
		expect(none).not.toContain("Not kept in the address");
		expect(none).not.toContain("Address not updated yet");
	});

	it("keeps Export and the count dimmed and busy while the views lag the header", async () => {
		const html = await shell({ held: true, data: { holdNote: "Updating to record 3…" } });
		expect(tagsWith(html, "ut-btn").some((t) => t.includes('data-held="true"'))).toBe(true);
		expect(tagsWith(html, "ut-label").some((t) => t.includes('data-held="true"'))).toBe(true);
	});
});

describe("the page's source, now spread over the shell", () => {
	const src = appSource();

	it("red-first (a memoized bar drawn again on every answer): hands FilterBar names only, never a node made in the render", () => {
		// FilterBar is memoized: the page re-renders on every answer, and the bar's rows change only after it. A node
		// written in the render (the record count, once handed to it as `beside={<span …>}`) is a new object every time,
		// so the memo never matched and the bar was drawn again with every answer. Each prop is a name now: the count is
		// a string, `held` a boolean, the rest references the desk keeps until they change.
		const shell = readFileSync(
			join(import.meta.dirname, "..", "src", "app", "desk", "desk-shell.tsx"),
			"utf-8",
		);
		const start = shell.indexOf("<FilterBar");
		expect(start).toBeGreaterThan(-1);
		const tag = shell.slice(start, shell.indexOf("/>", start) + 2);
		const props = [...tag.matchAll(/\s([\w-]+)=\{([^}]*)\}/g)].map((m) => [m[1], m[2]]);
		expect(props.map(([name]) => name)).toEqual(["rows", "filters", "onChange", "held", "count"]);
		for (const [name, value] of props) expect(value, name).toMatch(/^[A-Za-z_$][\w$]*$/);
	});

	it("draws the list from one input and never from the bare phase", () => {
		expect(src).not.toContain("phase={phase}");
		expect(src).toContain("phase={list.phase}");
	});

	it("writes the CSV with a byte-order mark spelled as an escape, not as the invisible character", () => {
		expect(src).toContain("new Blob([");
		expect(src).toContain("new Blob([`\\uFEFF${toCsv(");
		expect(src).not.toContain(String.fromCodePoint(0xfeff));
	});

	it("never puts the status under the header behind a condition, and mounts no slider", () => {
		const at = src.indexOf("<AtStatus");
		expect(at).toBeGreaterThan(0);
		const before = src.slice(src.lastIndexOf(">", at - 1) + 1, at);
		expect(before).not.toMatch(/&&|\?/);
		expect(src).not.toContain("<Timeline");
	});

	it("Export writes nothing while the past view waits for its vault's records", () => {
		const fn = /function exportCsv\(\): void \{([\s\S]*?)\n\t\}\n/.exec(src)?.[1] ?? "";
		expect(fn.length).toBeGreaterThan(20);
		expect(fn.slice(0, fn.indexOf("new Blob"))).toMatch(/if \(pastHeld\) return;/);
	});

	it("shrinks the root to the provider and the shell", () => {
		const app = readFileSync(join(APP, "app.tsx"), "utf-8");
		expect(app).toMatch(/<DeskProvider>\s*<DeskShell \/>\s*<\/DeskProvider>/);
		expect(app.split("\n").length).toBeLessThan(40);
	});

	it("loads the original stylesheet first and the desk's second", () => {
		const main = readFileSync(join(APP, "main.tsx"), "utf-8");
		const legacy = main.indexOf('import "./styles.css"');
		const desk = main.indexOf('import "./desk/desk.css"');
		expect(legacy).toBeGreaterThan(-1);
		expect(desk).toBeGreaterThan(legacy);
	});

	it("moves focus to the filled window's fill button after a fill change, and installs the glass and the Esc peel", () => {
		const shellSrc = readFileSync(join(APP, "desk", "desk-shell.tsx"), "utf-8");
		expect(shellSrc).toContain("installGlass()");
		expect(shellSrc).toContain("useEscapePeel(");
		expect(shellSrc).toContain("document.activeElement");
		expect(shellSrc).toContain(".ut-win-fill");
	});

	it("red-first (rows a fixed 11 to 9, so Now scrolled inside its window): the desk takes its rows from the fit, and its first-paint rows until there is one", () => {
		const shellSrc = readFileSync(join(APP, "desk", "desk-shell.tsx"), "utf-8");
		expect(shellSrc).toContain('import { useRowFit } from "./use-row-fit.js";');
		expect(shellSrc).toContain("const deskRef = useRef<HTMLElement>(null);");
		// Nothing is fitted while a window fills the desk.
		expect(shellSrc).toContain("const fit = useRowFit(deskRef, fill !== null);");
		expect(shellSrc.match(/useRowFit\(/g)).toHaveLength(1);
		const main = /<main\b[^>]*>/.exec(shellSrc.replace(/\s+/g, " "))?.[0];
		expect(main).toBe(
			'<main ref={deskRef} className="ut-dk-desk" data-filled={fill !== null} style={{ gridTemplateRows: fit ?? HOME_ROWS }} >',
		);
	});

	it("red-first (a phone's facts after the whole list): lays the windows out in the order the screen shows them", () => {
		// On a phone the DOM itself puts Now first and the Ledger last (`windowOrder`), never a CSS order: the Tab order
		// stays the order on screen.
		const shellSrc = readFileSync(join(APP, "desk", "desk-shell.tsx"), "utf-8");
		expect(shellSrc).toContain("const phone = useMedia(PHONE_QUERY, false);");
		expect(shellSrc).toContain("windowOrder(phone).map(");
		expect(shellSrc).not.toContain("WINDOWS.map(({ id, Component })");
		expect(sheetsSetOrder()).toEqual([]);
	});
});

/** Every desk stylesheet rule that sets `order`: one would make the Tab order differ from the order on screen. */
function sheetsSetOrder(): string[] {
	const files = [
		"desk/desk.css",
		"windows/spend/spend.css",
		"windows/share/share.css",
		"windows/ledger/ledger.css",
		"windows/now/now.css",
	];
	return files.filter((f) => /(^|[\s;{])order\s*:/.test(readFileSync(join(APP, f), "utf-8")));
}
