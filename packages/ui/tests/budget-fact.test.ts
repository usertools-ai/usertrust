// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Budget fact as the page draws it. A controller's record is a file written at one moment: while it is fresh the
 * fact reads `enforced` with the record's age, and once it is older than the bound it reads `recorded` in the amber
 * tone and the word `enforced` appears nowhere in it (not in a tooltip either).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SummaryPayload } from "../src/shared/api.js";

// The component is a .tsx file, which the tests' tsconfig (no `jsx`) cannot resolve statically: load it by a
// computed path, typed here by what the tests use.
type BudgetFactComponent = (props: { s: SummaryPayload }) => React.JSX.Element;
async function budgetFact(): Promise<BudgetFactComponent> {
	const file = "summary-strip";
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as {
		BudgetFact: BudgetFactComponent;
	};
	return mod.BudgetFact;
}

const WRITTEN = "2026-11-02T23:33:00.000Z";
const MIN = 60_000;

function summary(over: Partial<SummaryPayload>): SummaryPayload {
	return {
		vaultPath: "/v",
		budget: 1_000,
		budgetSource: "governor",
		budgetWrittenAt: WRITTEN,
		// The provenance sentence core writes for a controller's record: it says "enforced".
		budgetProvenance: `the enforced budget, as of ${WRITTEN}`,
		spentUt: 300,
		remainingUt: 700,
		chain: { events: 1, valid: true, empty: false, breakIndex: null, errors: [] },
		anchorFile: "absent",
		remote: { kit: false },
		rowCount: 1,
		truncated: false,
		verifiedAt: null,
		...over,
	};
}

async function render(over: Partial<SummaryPayload>, ageMs: number): Promise<string> {
	vi.setSystemTime(Date.parse(WRITTEN) + ageMs);
	const BudgetFact = await budgetFact();
	return renderToStaticMarkup(createElement(BudgetFact, { s: summary(over) }));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("the Budget fact", () => {
	it("a fresh record: enforced, the age under it, the exact time in a tooltip", async () => {
		const html = await render({}, 12 * MIN);
		expect(html).toContain('data-tone="ink">enforced</span>');
		expect(html).toContain("recorded 12 min ago");
		expect(html).toContain('title="as of 2026-11-02 23:33Z"');
		expect(html).toContain("70.0%");
	});

	it("exactly at the bound it is still fresh", async () => {
		const html = await render({}, 15 * MIN);
		expect(html).toContain('data-tone="ink">enforced</span>');
		expect(html).toContain("recorded 15 min ago");
	});

	it("a stale record: recorded in the amber tone, the age under it, and the word enforced nowhere", async () => {
		const html = await render({}, 65 * MIN);
		expect(html).toContain('data-tone="info">recorded</span>');
		expect(html).toContain("recorded 1 h 5 min ago");
		expect(html).toContain('title="as of 2026-11-02 23:33Z"');
		expect(html.toLowerCase()).not.toContain("enforced");
		// Amber is the info tone; red is for security only.
		expect(html).not.toContain('data-tone="danger"');
	});

	it("one minute past the bound it has already gone stale", async () => {
		const html = await render({}, 16 * MIN);
		expect(html).toContain('data-tone="info">recorded</span>');
		expect(html.toLowerCase()).not.toContain("enforced");
	});

	it("a record dated ahead of this clock reads recorded just now, and is fresh only within the window", async () => {
		const skewed = await render({}, -2 * MIN);
		expect(skewed).toContain("recorded just now");
		expect(skewed).toContain('data-tone="ink">enforced</span>');
		const far = await render({}, -(16 * MIN));
		expect(far).toContain("recorded just now");
		expect(far).toContain('data-tone="info">recorded</span>');
		expect(far.toLowerCase()).not.toContain("enforced");
	});

	it("a stale record with no usable figure still does not say enforced", async () => {
		const html = await render({ budget: null, remainingUt: null }, 2 * 24 * 60 * MIN);
		expect(html).toContain("recorded 2 days ago");
		expect(html.toLowerCase()).not.toContain("enforced");
	});

	it("a config budget is unchanged whatever the clock says", async () => {
		const html = await render(
			{
				budgetSource: "config",
				budgetWrittenAt: null,
				budgetProvenance: "from usertrust.config.json; not confirmed as enforced",
			},
			2 * 24 * 60 * MIN,
		);
		expect(html).toContain('data-tone="info">config · unconfirmed</span>');
		expect(html).toContain("from usertrust.config.json; not confirmed as enforced");
	});
});
