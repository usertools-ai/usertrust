// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A money figure that changes counts to its new value like a precision counter: whole usertokens on every frame,
 * eased out, landing exactly on the new value and never passing it, in tabular digits that hold their width so
 * nothing beside the figure moves. A screen reader hears the final value once, never the count, and a reader who
 * asked for reduced motion sees the final value at once. Gold is the page's one accent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SummaryPayload } from "../src/shared/api.js";
import { formatUsdTotal } from "../src/shared/format.js";
import { frameAt, tickFrames } from "../src/shared/tick.js";

const CSS = readFileSync(
	join(import.meta.dirname, "..", "src", "app", "styles.css"),
	"utf-8",
).replace(/\/\*[\s\S]*?\*\//g, "");

// The components are .tsx files, which the tests' tsconfig (no `jsx`) cannot resolve statically: load them by a
// computed path, typed here by what the tests use.
type Component<P> = (props: P) => React.JSX.Element;
async function load<P>(file: string, name: string): Promise<Component<P>> {
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as Record<
		string,
		Component<P>
	>;
	return mod[name] as Component<P>;
}

const CASES: Array<[label: string, from: number, to: number]> = [
	["up", 0, 76_045],
	["down", 76_045, 1_200],
	["equal", 500, 500],
	["one step", 41, 42],
	["negative", -300, 9_000],
];

describe("tickFrames", () => {
	it("frames end on target and are monotonic", () => {
		for (const [label, from, to] of CASES) {
			const frames = tickFrames(from, to);
			expect(frames.at(-1), label).toBe(to);
			const dir = Math.sign(to - from);
			let prev = from;
			for (const f of frames) {
				// Each frame is no further from the target than the one before, and never past it.
				expect(Math.sign(to - f) === dir || f === to, `${label}: ${f} passed ${to}`).toBe(true);
				expect(Math.abs(to - f), `${label}: ${f} moved away from ${to}`).toBeLessThanOrEqual(
					Math.abs(to - prev),
				);
				prev = f;
			}
		}
	});

	it("from === to gives the target alone", () => {
		expect(tickFrames(500, 500)).toEqual([500]);
		expect(tickFrames(0, 0)).toEqual([0]);
	});

	it("frames are integers", () => {
		for (const [label, from, to] of CASES) {
			for (const f of tickFrames(from, to))
				expect(Number.isInteger(f), `${label}: ${f}`).toBe(true);
		}
		// A fractional input still counts in whole usertokens, landing on the exact target last.
		const frames = tickFrames(0.4, 10.6);
		expect(frames.slice(0, -1).every((f) => Number.isInteger(f) && f <= 10.6)).toBe(true);
		expect(frames.at(-1)).toBe(10.6);
	});

	it("one frame per frameMs over durationMs", () => {
		expect(tickFrames(0, 76_045)).toHaveLength(Math.ceil(600 / 16));
		expect(tickFrames(0, 76_045, 160, 16)).toHaveLength(10);
		expect(tickFrames(0, 76_045, 0, 16)).toEqual([76_045]);
		expect(tickFrames(0, 76_045, 600, 0)).toEqual([76_045]);
	});

	it("eases out: the first half of the frames covers most of the distance", () => {
		const frames = tickFrames(0, 100_000);
		const mid = frames[Math.floor(frames.length / 2) - 1] ?? 0;
		expect(mid).toBeGreaterThan(80_000);
	});

	it("a value that is not a number lands at once", () => {
		expect(tickFrames(Number.NaN, 5)).toEqual([5]);
		expect(tickFrames(0, Number.POSITIVE_INFINITY)).toEqual([Number.POSITIVE_INFINITY]);
	});
});

describe("frameAt", () => {
	const frames = tickFrames(0, 76_045);

	it("a frame timestamp from before the count began shows the first frame, never the final value", () => {
		// requestAnimationFrame's timestamp can be earlier than the performance.now() taken when the count began.
		expect(frameAt(frames, -5)).toBe(frames[0]);
		expect(frameAt(frames, -5)).not.toBe(76_045);
		expect(frameAt(frames, Number.NaN)).toBe(frames[0]);
	});

	it("past the end shows the last frame", () => {
		expect(frameAt(frames, 600)).toBe(76_045);
		expect(frameAt(frames, 1e9)).toBe(76_045);
		expect(frameAt(frames, Number.POSITIVE_INFINITY)).toBe(76_045);
	});

	it("every index in between is the frame for that elapsed time", () => {
		for (let i = 0; i < frames.length; i++) {
			expect(frameAt(frames, i * 16), `start of frame ${i}`).toBe(frames[i]);
			expect(frameAt(frames, i * 16 + 15.9), `end of frame ${i}`).toBe(frames[i]);
		}
		expect(frameAt([1, 2, 3], 25, 10)).toBe(3);
		expect(frameAt([1, 2, 3], 10, 10)).toBe(2);
	});
});

describe("the accent is gold", () => {
	/** A custom property declared in :root. */
	const token = (name: string): string => {
		const root = /:root\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
		const m = new RegExp(`(?:^|[\\s;])${name}\\s*:\\s*([^;]+);`).exec(root);
		if (!m) throw new Error(`no token ${name}`);
		return (m[1] ?? "").trim();
	};

	it("--accent resolves to var(--gold), the brand colour", () => {
		expect(token("--accent")).toBe("var(--gold)");
		expect(token("--gold").toLowerCase()).toBe("#e8b54b");
	});

	it("no selector outside --chart uses var(--intel)", () => {
		const uses = [...CSS.matchAll(/([\w-]+)\s*:[^;{}]*var\(--intel\)/g)].map((m) => m[1]);
		expect(uses).toEqual(["--chart"]);
	});

	it("no violet tint is left in the page's styles", () => {
		expect(CSS.match(/rgba\(\s*155\s*,\s*123\s*,\s*255/g) ?? []).toEqual([]);
	});

	it("no violet hex appears outside the --intel token itself", () => {
		const hits = [...CSS.matchAll(/([\w-]+)\s*:[^;{}]*#(?:cbbcff|9b7bff)\b/gi)].map((m) => m[1]);
		expect(hits).toEqual(["--intel"]);
	});

	it("amber --info stays its own colour, never the accent", () => {
		expect(token("--info").toLowerCase()).toBe("#ffb020");
		expect(token("--accent")).not.toContain("--info");
	});
});

describe("reduced motion", () => {
	const MARKER = "@media (prefers-reduced-motion: reduce)";

	/** The body of the one reduced-motion block, braces matched. */
	function block(): string {
		const start = CSS.indexOf(MARKER);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(CSS.indexOf(MARKER, start + 1)).toBe(-1);
		const open = CSS.indexOf("{", start);
		let depth = 0;
		for (let i = open; i < CSS.length; i++) {
			if (CSS[i] === "{") depth++;
			else if (CSS[i] === "}" && --depth === 0) return CSS.slice(open + 1, i);
		}
		throw new Error("unclosed reduced-motion block");
	}

	// The count is script, skipped under reduced motion by the component; the class itself carries no CSS motion or
	// colour change, so the block has nothing of it to hold back.
	it("the ticking class carries no CSS motion and no colour change, so the block needs no entry for it", () => {
		expect(block()).not.toContain(".ut-tick");
		const rules = [...CSS.matchAll(/([^{}]*\.ut-tick\b[^{}]*)\{([^}]*)\}/g)].map((m) => m[2] ?? "");
		expect(rules.length).toBeGreaterThan(0);
		for (const body of rules) expect(body).not.toMatch(/\b(transition|animation|color)\s*:/);
	});
});

describe("<TickingFigure>", () => {
	it("markup holds the final value for screen readers", async () => {
		const TickingFigure = await load<{ ut: number }>("ticking-figure", "TickingFigure");
		const html = renderToStaticMarkup(createElement(TickingFigure, { ut: 76_045 }));
		const final = formatUsdTotal(76_045);
		// The counting span is hidden from assistive tech and never announced; a visually hidden span holds the value.
		const tick = /<span class="ut-tick"([^>]*)>([^<]*)<\/span>/.exec(html);
		expect(tick, html).not.toBeNull();
		expect(tick?.[1]).toContain('aria-hidden="true"');
		expect(tick?.[1]).not.toContain("aria-live");
		expect(tick?.[1]).toContain(`min-width:${final.length}ch`);
		expect(tick?.[2]).toBe(final);
		expect(html).toContain(`<span class="sr-only">${final}</span>`);
	});

	it("the Spend fact and the Cost in view tile render their figure through it", async () => {
		const SummaryStrip = await load<{ summary: SummaryPayload | null; live: string }>(
			"summary-strip",
			"SummaryStrip",
		);
		const summary: SummaryPayload = {
			vaultPath: "/vault/.usertrust",
			budget: 120_000,
			budgetSource: "config",
			budgetWrittenAt: null,
			budgetProvenance: "from the vault config",
			spentUt: 76_045,
			remainingUt: 43_955,
			chain: { events: 12, valid: true, empty: false, breakIndex: null, errors: [] },
			anchorFile: "absent",
			remote: { kit: false },
			rowCount: 12,
			truncated: false,
			verifiedAt: null,
		};
		const strip = renderToStaticMarkup(createElement(SummaryStrip, { summary, live: "live" }));
		expect(strip).toMatch(/title="\$7\.6045"><span class="ut-tick"[^>]*>\$7\.60<\/span>/);

		const Trends = await load<{ rows: never[]; newestOf: number | undefined }>("trends", "Trends");
		const trends = renderToStaticMarkup(createElement(Trends, { rows: [], newestOf: undefined }));
		expect(trends).toMatch(/class="ut-tile-main"[^>]*><span class="ut-tick"[^>]*>\$0\.00<\/span>/);
	});

	it("the ticking class holds tabular digits and an inline-block width", () => {
		const rule = /\.ut-tick\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
		expect(rule).toMatch(/font-variant-numeric:\s*tabular-nums/);
		expect(rule).toMatch(/display:\s*inline-block/);
	});
});
