// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The budget bar beside the "% left" figure. A reader takes a filling bar next to a percentage to BE that percentage,
 * so the bar must be as wide as the figure it sits beside: full when nothing is spent, draining as money is spent.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SummaryPayload } from "../src/shared/api.js";
import { budgetDisplay } from "../src/shared/budget-display.js";

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

const summary = (budget: number, remainingUt: number): SummaryPayload =>
	({
		budget,
		budgetSource: "governor",
		budgetWrittenAt: "2026-11-01T10:00:00.000Z",
		budgetProvenance: "P",
		spentUt: budget - remainingUt,
		remainingUt,
	}) as SummaryPayload;

async function render(budget: number, remainingUt: number): Promise<string> {
	const BudgetFact = await budgetFact();
	return renderToStaticMarkup(createElement(BudgetFact, { s: summary(budget, remainingUt) }));
}

const printedLeft = (html: string): number =>
	Number(/<span class="v">(?:<span class="ut-fit"[^>]*>)?([\d.]+)%/.exec(html)?.[1] ?? Number.NaN);
const barWidth = (html: string): number =>
	Number(/class="ut-meter"[^>]*><i style="width:([\d.]+)%/.exec(html)?.[1] ?? Number.NaN);
const barColour = (html: string): string =>
	/class="ut-meter"[^>]*><i style="[^"]*background:var\(--(\w+)\)/.exec(html)?.[1] ?? "";

describe("the budget bar is as wide as the percentage printed beside it", () => {
	it.each([
		["nothing spent: full", 1_000, 1_000, 100, "gold"],
		["63.4% spent, 36.6% left", 1_000, 366, 36.6, "gold"],
		["exactly 20% left: still gold", 1_000, 200, 20, "gold"],
		["19.9% left: warn", 1_000, 199, 19.9, "warn"],
		["exactly 5% left: still warn", 1_000, 50, 5, "warn"],
		["4.9% left: danger", 1_000, 49, 4.9, "danger"],
		["nothing left: empty", 1_000, 0, 0, "danger"],
		["overspent: empty", 1_000, -50, 0, "danger"],
	] as const)("%s", async (_n, budget, remainingUt, left, colour) => {
		const html = await render(budget, remainingUt);
		// The bar's inline width is the figure the label prints, to the label's one decimal.
		expect(barWidth(html)).toBeCloseTo(left, 1);
		expect(printedLeft(html)).toBeCloseTo(left, 1);
		expect(barWidth(html)).toBeCloseTo(printedLeft(html), 1);
		expect(barColour(html)).toBe(colour);
		expect(html).toContain("<small>left</small>");
		// The same function drives the display: the cut points are unchanged.
		const shown = budgetDisplay({ budget, remainingUt, budgetProvenance: "P" });
		expect(shown.kind === "known" ? shown.fill : "").toBe(colour);
	});

	it("the bar stays decorative: hidden from assistive tech, the printed figure carries the number", async () => {
		const html = await render(1_000, 366);
		expect(html).toMatch(/class="ut-meter" aria-hidden="true"/);
		expect(html).not.toContain("role=");
		expect(html).toContain("36.6%");
	});

	it("overspent keeps its wording beside an empty bar", async () => {
		const html = await render(1_000, -50);
		expect(html).toContain("overspent by");
		expect(barWidth(html)).toBe(0);
	});
});
