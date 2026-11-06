// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The header and the timeline at a past position, rendered as the browser gets them. The past view says what it is
 * ("As recorded at"), reads every figure from `/api/at` and never today's budget as the budget then, and never says
 * "verified".
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { AtPayload, SummaryPayload } from "../src/shared/api.js";
import { formatUsdTotal } from "../src/shared/format.js";
import { timelineLabel } from "../src/shared/timeline-view.js";

// The components are .tsx files, which the tests' tsconfig (no `jsx`) cannot resolve statically: load them by a
// computed path, typed here by what the tests use.
type Component<P> = (props: P) => React.JSX.Element;
async function app<T>(file: string): Promise<T> {
	return (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as T;
}

interface TimelineProps {
	at: AtPayload | null;
	wanted: number | null;
	head: number;
	loading: boolean;
	error: string | null;
	reloaded: boolean;
	onMove(pos: number): void;
	onLive(): void;
}

let SummaryStrip: Component<{
	summary: SummaryPayload | null;
	live: "live";
	at?: AtPayload | null;
}>;
let Timeline: Component<TimelineProps>;
beforeAll(async () => {
	SummaryStrip = (await app<{ SummaryStrip: typeof SummaryStrip }>("summary-strip")).SummaryStrip;
	Timeline = (await app<{ Timeline: typeof Timeline }>("timeline")).Timeline;
});

/** The text a reader sees: tags removed, and the entities React escapes read back. */
const text = (html: string): string =>
	html
		.replace(/<[^>]*>/g, "")
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");

function summary(over: Partial<SummaryPayload> = {}): SummaryPayload {
	return {
		vaultPath: "/v/.usertrust",
		budget: 1_000_000,
		budgetSource: "config",
		budgetWrittenAt: null,
		budgetProvenance: "from the vault config",
		spentUt: 123_400,
		remainingUt: 876_600,
		chain: { events: 100, valid: true, empty: false, breakIndex: null, errors: [] },
		anchorFile: "absent",
		remote: { kit: false },
		rowCount: 100,
		truncated: false,
		verifiedAt: "2026-10-13T09:15:00.000Z",
		...over,
	};
}

const NOTE = "budget history starts with the first budget record; this is today's budget";

function at(over: Partial<AtPayload> = {}): AtPayload {
	return {
		pos: 40,
		ts: "2026-11-06T10:04:05.000Z",
		head: 99,
		clamped: false,
		epoch: 0,
		spentUt: 56_700,
		counts: { llm_call: 30, denied: 2, other: 9 },
		chain: { valid: true, breakIndex: null },
		budget: { ut: 1_000_000, note: NOTE },
		plan: null,
		windowStartPos: 0,
		statusAt: {},
		...over,
	};
}

const strip = (a: AtPayload | null, s: SummaryPayload = summary()): string =>
	renderToStaticMarkup(createElement(SummaryStrip, { summary: s, live: "live", at: a }));

describe("the header at a past position", () => {
	it("with at set, it shows the dollars of at.spentUt and says As recorded at", () => {
		const html = strip(at());
		expect(text(html)).toContain(formatUsdTotal(56_700));
		expect(text(html)).toContain("As recorded at");
		// Today's spend is not the spend then.
		expect(text(html)).not.toContain(formatUsdTotal(123_400));
	});

	it("with at null, it shows neither", () => {
		const html = strip(null);
		expect(text(html)).not.toContain("As recorded at");
		expect(text(html)).not.toContain(formatUsdTotal(56_700));
		expect(text(html)).toContain(formatUsdTotal(123_400));
	});

	it("the budget then is the server's note, never today's budget presented as then", () => {
		const html = text(strip(at()));
		expect(html).toContain(NOTE);
		// Today's live budget figures (87.7% left, $87.66 of $100.00) are not shown as the budget then.
		expect(html).not.toContain("% left");
		expect(html).not.toContain(formatUsdTotal(876_600));
	});

	it("the chain then reads from at.chain: a position that reads broken looks broken", () => {
		const html = strip(at({ chain: { valid: false, breakIndex: 30 } }));
		expect(html).toContain('data-tone="stakes"');
		expect(text(html)).toContain("broken");
		expect(text(html)).not.toContain("chained");
		// The live vault is intact; the position is not, and the header follows the position.
		const intact = strip(at());
		expect(intact).toContain('data-tone="approve"');
		expect(text(intact)).not.toContain("broken");
	});

	it("counts the records up to the position", () => {
		expect(text(strip(at({ pos: 40 })))).toContain("41 events");
	});

	it("never says verified", () => {
		for (const a of [at(), at({ chain: { valid: false, breakIndex: 3 } }), at({ clamped: true })])
			expect(text(strip(a))).not.toMatch(/verif/i);
	});

	it("window note at T: a position before the first row held says so, once", () => {
		const html = text(
			strip(
				at({ pos: 10, windowStartPos: 50 }),
				summary({ truncated: true, rowCount: 50, chain: { ...summary().chain, events: 100 } }),
			),
		);
		expect(html).toContain("The list holds records from position 50");
		// One note, not two: the live truncation notice gives way to the position's own.
		expect(html).not.toContain("Showing the newest");
	});

	it("a position inside the window keeps the live truncation notice", () => {
		const html = text(
			strip(
				at({ pos: 60, windowStartPos: 50 }),
				summary({ truncated: true, rowCount: 50, chain: { ...summary().chain, events: 100 } }),
			),
		);
		expect(html).toContain("Showing the newest 50 of 100 events");
		expect(html).not.toContain("The list holds records from position");
	});
});

describe("the timeline", () => {
	const props = (over: Partial<TimelineProps> = {}): TimelineProps => ({
		at: null,
		wanted: null,
		head: 99,
		loading: false,
		error: null,
		reloaded: false,
		onMove: () => {},
		onLive: () => {},
		...over,
	});
	const render = (over: Partial<TimelineProps> = {}): string =>
		renderToStaticMarkup(createElement(Timeline, props(over)));

	it("is a native range over 0..head whose aria-valuetext is the label: live", () => {
		const html = render();
		expect(html).toMatch(/<input[^>]*type="range"/);
		expect(html).toMatch(/<input[^>]*min="0"/);
		expect(html).toMatch(/<input[^>]*max="99"/);
		expect(html).toMatch(/<input[^>]*aria-valuetext="Live"/);
		expect(html).toMatch(/<input[^>]*value="99"/);
		// Live: no Live button to press.
		expect(html).not.toMatch(/<button[^>]*>Live<\/button>/);
	});

	it("at a past position, aria-valuetext equals the visible label, and Live is a real button", () => {
		const a = at();
		const label = timelineLabel(a, new Date().toISOString());
		const html = render({ at: a, wanted: 40 });
		expect(label).toContain("As recorded at");
		expect(html).toContain(`aria-valuetext="${label}"`);
		expect(text(html)).toContain(label);
		expect(html).toMatch(/<input[^>]*value="40"/);
		expect(html).toMatch(/<button type="button"[^>]*>Live<\/button>/);
	});

	it("records added since the position was chosen show as a real button", () => {
		const html = render({ at: at({ head: 99 }), wanted: 40, head: 120 });
		expect(html).toMatch(/<button type="button"[^>]*>21 new since<\/button>/);
		expect(html).toMatch(/<input[^>]*max="120"/);
		expect(render({ at: at({ head: 99 }), wanted: 40, head: 99 })).not.toContain("new since");
	});

	it("while the first answer loads, it says so and never claims Live", () => {
		const html = render({ wanted: 40, loading: true });
		expect(html).not.toMatch(/aria-valuetext="Live"/);
		expect(html).toMatch(/aria-valuetext="Loading[^"]*"/);
	});

	it("an error is a short inline note beside the last good view", () => {
		const html = render({ at: at(), wanted: 41, error: "the dashboard did not answer" });
		expect(text(html)).toContain("the dashboard did not answer");
		expect(text(html)).toContain("As recorded at");
	});

	it("an error with nothing loaded says the live vault is shown", () => {
		const html = text(render({ wanted: 41, error: "the vault has no records" }));
		expect(html).toContain("the vault has no records");
		expect(html).toContain("showing the live vault");
	});

	it("an epoch change says the vault was reloaded", () => {
		expect(text(render({ at: at(), wanted: 40, reloaded: true }))).toContain(
			"the vault was reloaded",
		);
	});
});
