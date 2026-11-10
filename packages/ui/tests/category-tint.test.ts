// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The category tint: one colour for the line when a facet filter holds exactly one value. The function is pure and
 * shared by every window that tints, so the windows cannot disagree; the hook reads the filters the list was drawn
 * with and the colours of whichever dimension the tint comes from.
 */

import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import type { Dimension } from "../src/shared/breakdown.js";
import { categoryTint, TINT_ORDER } from "../src/shared/category-tint.js";
import { colorsFromRanking, PROVIDER_COLOR } from "../src/shared/colors.js";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import { listView } from "../src/shared/list-view.js";
import { withDesk } from "./helpers/desk.js";

/** A colour that names where it came from, so a test sees which dimension won. */
const fake = (dim: Dimension, key: string): string => `${dim}:${key}`;

function f(over: Partial<FilterState>): FilterState {
	return { ...EMPTY_FILTERS, ...over };
}

describe("categoryTint", () => {
	it("checks provider, then lane, role, model and kind", () => {
		expect(TINT_ORDER).toEqual(["provider", "lane", "role", "model", "kind"]);
	});

	it("one provider and one lane give the provider's colour (the order decides)", () => {
		expect(categoryTint(f({ providers: ["xAI"], actors: ["agent-7"] }), fake)).toBe("provider:xAI");
	});

	it("two providers and one lane give the lane's colour: a field with more than one value is skipped", () => {
		expect(categoryTint(f({ providers: ["xAI", "OpenAI"], actors: ["agent-7"] }), fake)).toBe(
			"lane:agent-7",
		);
	});

	it("one model alone gives the model's colour", () => {
		expect(categoryTint(f({ models: ["m-1"] }), fake)).toBe("model:m-1");
	});

	it("role comes before model, and model before kind", () => {
		expect(categoryTint(f({ jobTypes: ["review"], models: ["m-1"] }), fake)).toBe("role:review");
		expect(categoryTint(f({ models: ["m-1"], kinds: ["llm_call"] }), fake)).toBe("model:m-1");
		expect(categoryTint(f({ kinds: ["llm_call"] }), fake)).toBe("kind:llm_call");
	});

	it("no field with exactly one value gives null", () => {
		expect(categoryTint(EMPTY_FILTERS, fake)).toBeNull();
		expect(
			categoryTint(
				f({
					providers: ["xAI", "OpenAI"],
					actors: ["a", "b"],
					jobTypes: ["r", "s"],
					models: ["m", "n"],
					kinds: ["k", "l"],
				}),
				fake,
			),
		).toBeNull();
		// Fields that are not a dimension never tint: a status, a source, a search, a date or a cost.
		expect(
			categoryTint(
				f({
					statuses: ["failed"],
					typeSources: ["declared"],
					search: "gpt",
					from: "2026-11-01",
					costMax: 5,
				}),
				fake,
			),
		).toBeNull();
	});

	it("red-first (the old rule read only the current level's selection): a provider filter tints at the Lane level", () => {
		// The level is not an input at all: only the filters decide.
		const real = (d: Dimension, k: string): string => colorsFromRanking(d, []).of(k);
		expect(categoryTint(f({ providers: ["xAI"] }), real)).toBe(PROVIDER_COLOR.xAI);
	});
});

// The hook's module imports the desk's .tsx state, which the tests' tsconfig cannot import statically.
interface TintModule {
	useCategoryTint(): string | null;
}
let tint: TintModule;
beforeAll(async () => {
	tint = (await import(/* @vite-ignore */ `../src/app/desk/${"use-tint"}.js`)) as TintModule;
});

async function hookTint(o: Parameters<typeof withDesk>[1]): Promise<string | null> {
	let out: { v: string | null } | null = null;
	await withDesk(
		createElement(function Probe() {
			out = { v: tint.useCategoryTint() };
			return null;
		}),
		o,
	);
	if (out === null) throw new Error("the probe did not render");
	return (out as { v: string | null }).v;
}

describe("useCategoryTint", () => {
	const drawnWith = (filters: FilterState) =>
		listView({ rows: [], at: null, filters, phase: "loaded", summary: null });
	const colorsFor = (d: Dimension) => colorsFromRanking(d, d === "lane" ? ["agent-7"] : []);

	it("at the Lane level, a provider filter alone tints with the provider's fixed colour", async () => {
		const got = await hookTint({
			data: { level: "lane", list: drawnWith(f({ providers: ["xAI"] })), colorsFor },
			view: { filters: f({ providers: ["xAI"] }) },
		});
		expect(got).toBe(PROVIDER_COLOR.xAI);
	});

	it("reads the filters the list was drawn with, not the ones just typed", async () => {
		const got = await hookTint({
			data: { list: drawnWith(f({ providers: ["xAI"] })), colorsFor },
			view: { filters: f({ providers: ["OpenAI"] }) },
		});
		expect(got).toBe(PROVIDER_COLOR.xAI);
		const none = await hookTint({
			data: { list: drawnWith(EMPTY_FILTERS), colorsFor },
			view: { filters: f({ providers: ["OpenAI"] }) },
		});
		expect(none).toBeNull();
	});

	it("takes the colour from the map of the dimension that won, not the current level's", async () => {
		const got = await hookTint({
			data: { level: "model", list: drawnWith(f({ actors: ["agent-7"] })), colorsFor },
		});
		expect(got).toBe(colorsFor("lane").of("agent-7"));
	});
});
