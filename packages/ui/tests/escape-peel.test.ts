// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Escape takes the desk apart one layer at a time: the record panel, the fill, the pin, then the newest filter. It
 * never acts on Escape that something else owns (a search box, a select, a dialog, an open popover).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface PeelState {
	recordOpen: boolean;
	fill: "spend" | "share" | "ledger" | "now" | null;
	pinned: boolean;
	newestFilter: string | null;
}
interface PeelModule {
	nextPeel(s: PeelState): "record" | "fill" | "pin" | "filter" | null;
	shouldPeel(e: {
		key: string;
		defaultPrevented: boolean;
		target: { closest?: (sel: string) => unknown } | null;
	}): boolean;
	PEEL_SKIP: string;
}
async function peel(): Promise<PeelModule> {
	return (await import(/* @vite-ignore */ "../src/app/desk/escape-peel.js")) as PeelModule;
}

const none: PeelState = { recordOpen: false, fill: null, pinned: false, newestFilter: null };

describe("nextPeel", () => {
	it("peels the record panel first when all four layers are set", async () => {
		const { nextPeel } = await peel();
		expect(
			nextPeel({ recordOpen: true, fill: "spend", pinned: true, newestFilter: "kinds:a" }),
		).toBe("record");
	});

	it("peels the fill when no record is open", async () => {
		const { nextPeel } = await peel();
		expect(nextPeel({ ...none, fill: "spend", pinned: true, newestFilter: "kinds:a" })).toBe(
			"fill",
		);
	});

	it("peels the pin when there is no record or fill", async () => {
		const { nextPeel } = await peel();
		expect(nextPeel({ ...none, pinned: true, newestFilter: "kinds:a" })).toBe("pin");
	});

	it("peels the newest filter when it is the only layer", async () => {
		const { nextPeel } = await peel();
		expect(nextPeel({ ...none, newestFilter: "kinds:a" })).toBe("filter");
	});

	it("peels nothing when nothing is set", async () => {
		const { nextPeel } = await peel();
		expect(nextPeel(none)).toBeNull();
	});

	it("never closes a fill by removing a filter", async () => {
		const { nextPeel } = await peel();
		expect(nextPeel({ ...none, fill: "share", newestFilter: "kinds:a" })).toBe("fill");
	});
});

describe("shouldPeel", () => {
	const esc = (over: Partial<Parameters<PeelModule["shouldPeel"]>[0]> = {}) => ({
		key: "Escape",
		defaultPrevented: false,
		target: { closest: () => null } as { closest?: (sel: string) => unknown } | null,
		...over,
	});

	it("peels a plain Escape", async () => {
		const { shouldPeel } = await peel();
		expect(shouldPeel(esc())).toBe(true);
	});

	it("peels an Escape with no target", async () => {
		const { shouldPeel } = await peel();
		expect(shouldPeel(esc({ target: null }))).toBe(true);
	});

	it("peels an Escape whose target has no closest()", async () => {
		const { shouldPeel } = await peel();
		expect(shouldPeel(esc({ target: {} }))).toBe(true);
	});

	it("ignores any other key", async () => {
		const { shouldPeel } = await peel();
		expect(shouldPeel(esc({ key: "Enter" }))).toBe(false);
		expect(shouldPeel(esc({ key: "Esc" }))).toBe(false);
	});

	it("ignores an Escape something already handled", async () => {
		const { shouldPeel } = await peel();
		expect(shouldPeel(esc({ defaultPrevented: true }))).toBe(false);
	});

	it("red-first: the record panel marks the Escape it closes on, so one keypress never peels a second layer", () => {
		// The panel listens in the capture phase and the peel in the bubble phase of the SAME keydown; the page re-renders
		// in between, so an unmarked Escape reached the peel with the record already closed, and it took the fill too.
		const src = readFileSync(
			join(import.meta.dirname, "..", "src", "app", "row-panel.tsx"),
			"utf-8",
		);
		const branch =
			/if \(e\.key === "Escape"\) \{([\s\S]*?)\n\t\t\t\treturn;\n\t\t\t\}/.exec(src)?.[1] ?? "";
		expect(branch).toContain("onClose(");
		expect(branch).toMatch(/e\.preventDefault\(\);[\s\S]*onClose\(/);
		// A popover's Escape is the popover's: the panel leaves it unmarked and open.
		expect(branch.indexOf("e.preventDefault()")).toBeGreaterThan(
			branch.indexOf("if (popoverOwnsEscape(document)) return;"),
		);
	});

	it("ignores an Escape typed in a search box, a select or a popover", async () => {
		const { shouldPeel, PEEL_SKIP } = await peel();
		const seen: string[] = [];
		const inside = {
			closest: (sel: string) => {
				seen.push(sel);
				return {};
			},
		};
		expect(shouldPeel(esc({ target: inside }))).toBe(false);
		expect(seen).toEqual([PEEL_SKIP]);
	});
});

describe("PEEL_SKIP", () => {
	it("names the controls and layers that own their own Escape", async () => {
		const { PEEL_SKIP } = await peel();
		expect(PEEL_SKIP).toBe("input, textarea, select, [role=dialog], .ut-pop");
	});
});
