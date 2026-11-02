// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The job-type card says its buckets add up to the total in view, so what it DRAWS has to add up, not only the data
 * behind it. The set of buckets is closed (8 job types, `untyped`, `unrecognized`), so the card draws all of them;
 * every other list keeps its top 8.
 */

import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersistedAuditEvent } from "usertrust";
import { describe, expect, it } from "vitest";
import { costByJobType, type KeyTotal, statTiles } from "../src/shared/aggregate.js";
import { JOB_TYPES, toLedgerRows } from "../src/shared/rows.js";

// The component is a .tsx file, which the tests' tsconfig (no `jsx`) cannot resolve statically: load it by a
// computed path, typed here by what the tests use.
type BarListComponent = (props: {
	title: string;
	totals: KeyTotal[];
	limit?: number;
}) => React.JSX.Element;
async function barList(): Promise<BarListComponent> {
	const file = "bar-list";
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as {
		BarList: BarListComponent;
	};
	return mod.BarList;
}

function evt(n: number, data: Record<string, unknown>): PersistedAuditEvent {
	return {
		id: `id-${n}`,
		timestamp: "2026-07-27T10:00:00.000Z",
		previousHash: "0".repeat(64),
		hash: "a".repeat(64),
		kind: "llm_call",
		actor: "local",
		data,
		sequence: n,
	};
}

/** One record per bucket, each with its own cost: the 8 listed types, `unrecognized` and `untyped`. */
function tenBuckets() {
	const events = [
		...JOB_TYPES.map((t, i) =>
			evt(i + 1, { cost: 100 + i, job: `j${i}`, jobType: t, typeSource: "agent" }),
		),
		evt(20, { cost: 3, job: "jx", jobType: "made-up", typeSource: "agent" }),
		evt(21, { cost: 1 }),
	];
	return toLedgerRows(events, { valid: true, breakIndex: null });
}

const drawn = (html: string): number[] =>
	[...html.matchAll(/data-cost-ut="(\d+)"/g)].map((m) => Number(m[1]));

describe("the job-type card draws every bucket", () => {
	it("10 buckets: all drawn, the drawn costs add up to the total in view, and no 'top 8 of' line", async () => {
		const rows = tenBuckets();
		const totals = costByJobType(rows);
		expect(totals).toHaveLength(10);
		const BarList = await barList();
		const html = renderToStaticMarkup(
			createElement(BarList, { title: "t", totals, limit: Number.POSITIVE_INFINITY }),
		);
		const costs = drawn(html);
		// mutant: the card drawn with the default limit → 8 buckets, and the sum falls short of the total
		expect(costs).toHaveLength(10);
		expect(costs.reduce((n, c) => n + c, 0)).toBe(statTiles(rows).totalCostUt);
		expect(html).not.toContain("top ");
		for (const key of [...JOB_TYPES, "untyped", "unrecognized"])
			expect(html).toContain(`title="${key}"`);
	});

	it("control: the default keeps the top 8 and says so, as the kind and model lists do", async () => {
		const totals = costByJobType(tenBuckets());
		const BarList = await barList();
		const html = renderToStaticMarkup(createElement(BarList, { title: "t", totals }));
		expect(drawn(html)).toHaveLength(8);
		expect(html).toContain("top 8 of 10");
	});

	it("the trends card passes the unlimited list", async () => {
		const source = await readFile(new URL("../src/app/trends.tsx", import.meta.url), "utf8");
		expect(source).toContain("limit={Number.POSITIVE_INFINITY}");
		expect(source).toContain("totals={costByJobType(props.rows)}");
	});
});
