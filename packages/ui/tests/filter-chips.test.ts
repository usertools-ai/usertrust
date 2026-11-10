// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The active-filter chips: a filter the address carries is named on screen and can be cleared on its own. A link with
 * `#provider=<name>` filters the list, so the provider has a chip, as the model, actor and status filters do.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import {
	CHIP_FACETS,
	type Chip,
	chipsOf,
	toggleOnly,
	without,
} from "../src/shared/filter-chips.js";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import type { LedgerRow } from "../src/shared/rows.js";

// The component is .tsx, which the tests' typecheck (no jsx) cannot import statically: load it by a computed path.
type Component<P> = (props: P) => React.JSX.Element;
let FilterBar: Component<{
	rows: LedgerRow[];
	filters: FilterState;
	onChange(f: FilterState): void;
}>;
beforeAll(async () => {
	const file = "filter-bar";
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as {
		FilterBar: typeof FilterBar;
	};
	FilterBar = mod.FilterBar;
});

const bar = (filters: FilterState): string =>
	renderToStaticMarkup(createElement(FilterBar, { rows: [], filters, onChange: () => {} }));

describe("the active-filter chips", () => {
	it("red-first: a provider filter from the address has a chip that names it, one per provider", () => {
		expect(bar({ ...EMPTY_FILTERS, providers: ["OpenAI"] })).toContain("provider: OpenAI");
		const two = bar({ ...EMPTY_FILTERS, providers: ["OpenAI", "xAI"] });
		expect(two).toContain("provider: OpenAI");
		expect(two).toContain("provider: xAI");
	});

	it("CONTROL: no provider filter, no provider chip, while another filter's chip still shows", () => {
		expect(bar(EMPTY_FILTERS)).not.toContain("provider:");
		expect(bar({ ...EMPTY_FILTERS, models: ["gpt-5"] })).toContain("model: gpt-5");
	});

	it("clearing one provider's chip keeps the others (read in the source: these tests render without a DOM)", () => {
		const src = readFileSync(
			join(import.meta.dirname, "..", "src", "app", "filter-bar.tsx"),
			"utf-8",
		);
		expect(src).toMatch(
			/for \(const p of filters\.providers\)\s*chips\.push\(\{\s*label: `provider: \$\{p\}`,\s*clear: \(\) => onChange\(\{ \.\.\.filters, providers: filters\.providers\.filter\(\(x\) => x !== p\) \}\),/,
		);
	});
});

describe("the chip rules", () => {
	const f = (over: Partial<FilterState>): FilterState => ({ ...EMPTY_FILTERS, ...over });
	const chip = (field: Chip["field"], value: string): Chip => ({ field, value });

	it("names each facet a chip can show, in this order", () => {
		expect(CHIP_FACETS).toEqual([
			["providers", "Provider"],
			["models", "Model"],
			["actors", "Lane"],
			["kinds", "Kind"],
			["statuses", "Status"],
			["jobTypes", "Role (declared)"],
			["typeSources", "Type declared by"],
		]);
	});

	it("toggleOnly: an empty facet gets the value; the facet's one value clears it", () => {
		expect(toggleOnly(EMPTY_FILTERS, "actors", "a").actors).toEqual(["a"]);
		expect(toggleOnly(f({ actors: ["a"] }), "actors", "a").actors).toEqual([]);
	});

	it("toggleOnly: the value replaces the facet's others, and only that facet changes", () => {
		const before = f({ actors: ["a", "b"], models: ["m"], search: "x" });
		const after = toggleOnly(before, "actors", "a");
		expect(after.actors).toEqual(["a"]);
		expect(toggleOnly(f({ actors: ["b"] }), "actors", "a").actors).toEqual(["a"]);
		expect(after.models).toEqual(["m"]);
		expect(after.search).toBe("x");
		expect(before.actors).toEqual(["a", "b"]);
		expect(toggleOnly(f({ models: ["a"] }), "actors", "a")).toEqual(
			f({ models: ["a"], actors: ["a"] }),
		);
	});

	it("without drops the one value from its facet and no other", () => {
		const before = f({ actors: ["a", "b"], models: ["a"] });
		const after = without(before, chip("actors", "a"));
		expect(after.actors).toEqual(["b"]);
		expect(after.models).toEqual(["a"]);
		expect(before.actors).toEqual(["a", "b"]);
		expect(without(before, chip("actors", "z"))).toEqual(before);
	});

	it("chipsOf: values the order does not know come first, then the order's, newest last", () => {
		const filters = f({ actors: ["a", "b", "c"] });
		expect(chipsOf(filters, [chip("actors", "b"), chip("actors", "a")])).toEqual([
			chip("actors", "c"),
			chip("actors", "b"),
			chip("actors", "a"),
		]);
	});

	it("chipsOf: an order entry no longer set is dropped, also one with the same value in another facet", () => {
		const filters = f({ actors: ["a"] });
		expect(chipsOf(filters, [chip("actors", "gone"), chip("actors", "a")])).toEqual([
			chip("actors", "a"),
		]);
		expect(chipsOf(filters, [chip("models", "a")])).toEqual([chip("actors", "a")]);
	});

	it("chipsOf: with no order the chips follow the facets' order, and the search, dates and costs have none", () => {
		const filters = f({
			typeSources: ["t"],
			jobTypes: ["j"],
			statuses: ["s"],
			kinds: ["k"],
			actors: ["a"],
			models: ["m"],
			providers: ["p"],
			search: "q",
			from: "2026-11-01",
			costMin: 1,
		});
		expect(chipsOf(filters, [])).toEqual([
			chip("providers", "p"),
			chip("models", "m"),
			chip("actors", "a"),
			chip("kinds", "k"),
			chip("statuses", "s"),
			chip("jobTypes", "j"),
			chip("typeSources", "t"),
		]);
		expect(chipsOf(EMPTY_FILTERS, [chip("actors", "a")])).toEqual([]);
	});
});
