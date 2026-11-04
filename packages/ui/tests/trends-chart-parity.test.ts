// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The chart's text alternative states money, so it must print each figure the way the chart does. The Tooltip's own
 * `formatter` and `labelFormatter` props are captured from the rendered component (recharts is stubbed so its
 * children render at any size) and called with each bucket's value, then compared with the hidden table's cells.
 * Reuse is by import: the table's dollar and UT cells are `formatUsd` and `formatUt`, the functions the tooltip's
 * formatter calls; the tooltip prints them dollars first, as `$x · y UT`.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersistedAuditEvent } from "usertrust";
import { describe, expect, it, vi } from "vitest";
import { formatUsd, formatUt } from "../src/shared/format.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { toLedgerRows } from "../src/shared/rows.js";

interface TooltipProps {
	formatter: (value: unknown) => [string, string];
	labelFormatter: (label: unknown) => string;
}
const captured = vi.hoisted(() => ({ tooltip: undefined as unknown }));

vi.mock("recharts", async () => {
	const { createElement: h, Fragment } = await import("react");
	const passthrough = (props: Record<string, unknown>) =>
		h(
			"div",
			{ role: props.role as string, "aria-label": props["aria-label"] as string },
			props.children as never,
		);
	return {
		ResponsiveContainer: passthrough,
		BarChart: (props: Record<string, unknown>) => h(Fragment, null, props.children as never),
		Tooltip: (props: Record<string, unknown>) => {
			captured.tooltip = props;
			return null;
		},
		Bar: () => null,
		CartesianGrid: () => null,
		XAxis: () => null,
		YAxis: () => null,
	};
});

type TrendsComponent = (props: {
	rows: LedgerRow[];
	newestOf: number | undefined;
}) => React.JSX.Element;
async function load(): Promise<TrendsComponent> {
	const file = "trends";
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as {
		Trends: TrendsComponent;
	};
	return mod.Trends;
}

function evt(n: number, timestamp: string, cost: number): PersistedAuditEvent {
	return {
		id: `id-${n}`,
		timestamp,
		previousHash: "0".repeat(64),
		hash: "a".repeat(64),
		kind: "llm_call",
		actor: "local",
		data: { cost, model: "claude-sonnet-5" },
		sequence: n,
	};
}

const DAYS: Array<[string, number]> = [
	["2026-11-01T10:00:00.000Z", 1_500],
	["2026-11-02T10:00:00.000Z", 28_000],
	["2026-11-03T10:00:00.000Z", 1_234_567],
];

describe("the table prints each bucket as the chart's tooltip does", () => {
	it("for every bucket, the table's dollar and UT cells are the tooltip's figure (dollars first) and its label the labelFormatter's", async () => {
		const rows = toLedgerRows(
			DAYS.map(([ts, cost], i) => evt(i + 1, ts, cost)),
			{ valid: true, breakIndex: null },
		);
		const Trends = await load();
		const html = renderToStaticMarkup(createElement(Trends, { rows, newestOf: undefined }));
		const tip = captured.tooltip as TooltipProps;
		expect(typeof tip.formatter).toBe("function");

		const body = /<tbody>(.*?)<\/tbody>/s.exec(html)?.[1] ?? "";
		const cells = [...body.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) =>
			[...(m[1] ?? "").matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((c) => c[1]),
		);
		expect(cells).toHaveLength(DAYS.length);
		DAYS.forEach(([ts, cost], i) => {
			const day = `${ts.slice(0, 10)}T00:00:00Z`;
			expect(cells[i]?.[0]).toBe(tip.labelFormatter(Date.parse(day)));
			// mutant: a table that formats a figure its own way (no separators, a different unit, UT first) differs here
			expect(`${cells[i]?.[1]} · ${cells[i]?.[2]}`).toBe(tip.formatter(cost)[0]);
			expect(cells[i]?.[1]).toBe(formatUsd(cost));
			expect(cells[i]?.[2]).toBe(formatUt(cost));
		});
	});
});
