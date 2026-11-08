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
