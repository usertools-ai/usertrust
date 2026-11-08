// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The shell: the page the desk makes of four windows, the top bar, the filters and the timeline. Rendered as static
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

	it("puts the page in the desk's frame: backdrop, top bar, filters, the desk, then the timeline", async () => {
		const html = await shell({ data: loadedData() });
		const order = [
			'class="ut-dk"',
			'class="ut-dk-backdrop"',
			'class="ut-dk-top ut-glass"',
			'class="ut-dk-filters"',
			'class="ut-dk-desk"',
			'type="range"',
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

	it("draws the timeline whatever the data: empty, still loading, or loaded", async () => {
		for (const data of [{}, loadedData(), { summary: dayOneSummary() }]) {
			const html = await shell({ data });
			expect(html.match(/type="range"/g)).toHaveLength(1);
		}
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

	it("draws the list from one input and never from the bare phase", () => {
		expect(src).not.toContain("phase={phase}");
		expect(src).toContain("phase={list.phase}");
	});

	it("writes the CSV with a byte-order mark spelled as an escape, not as the invisible character", () => {
		expect(src).toContain("new Blob([");
		expect(src).toContain("new Blob([`\\uFEFF${toCsv(");
		expect(src).not.toContain(String.fromCodePoint(0xfeff));
	});

	it("never puts the timeline behind a condition", () => {
		const at = src.indexOf("<Timeline");
		expect(at).toBeGreaterThan(0);
		const before = src.slice(src.lastIndexOf(">", at - 1) + 1, at);
		expect(before).not.toMatch(/&&|\?/);
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
});
