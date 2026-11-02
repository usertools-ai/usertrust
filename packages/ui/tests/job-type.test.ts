// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Job types in the dashboard. A type is what the caller DECLARED when it authorized the job; the dashboard shows it,
 * filters on it and totals by it, and says "declared by the caller, not checked" wherever it does.
 *
 * Pinned here:
 *  - rows copy `job`, `jobType` and `typeSource` from the record, and a record without them stays without them;
 *  - a value outside core's closed lists is shown as `unrecognized`, never dropped and never mistaken for a listed type;
 *  - the facets filter on each, `untyped` selects the records with none, and they compose with the existing filters;
 *  - the by-job-type buckets add up to the total in view, `untyped` included;
 *  - the caveat is on every surface that shows a type or a total by type;
 *  - the lists mirror core's `JOB_TYPES` and `TYPE_SOURCES`.
 */

import type { PersistedAuditEvent } from "usertrust";
import { JOB_TYPES as CORE_JOB_TYPES, TYPE_SOURCES as CORE_TYPE_SOURCES } from "usertrust";
import { describe, expect, it } from "vitest";
import { costByJobType, statTiles } from "../src/shared/aggregate.js";
import { CSV_HEADERS, toCsv } from "../src/shared/csv.js";
import { applyFilters, EMPTY_FILTERS, isFiltering } from "../src/shared/filters.js";
import {
	JOB_TYPE_CAVEAT,
	JOB_TYPES,
	jobTypeOf,
	type LedgerRow,
	TYPE_SOURCES,
	toLedgerRows,
	typeSourceOf,
	UNRECOGNIZED,
	UNTYPED,
} from "../src/shared/rows.js";

function evt(data: Record<string, unknown>, n = 1): PersistedAuditEvent {
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

const rowsOf = (events: PersistedAuditEvent[]): LedgerRow[] =>
	toLedgerRows(events, { valid: true, breakIndex: null });

/** A mixed fixture: typed (both sources), a value outside the lists, and records with no type at all. */
function mixed(): LedgerRow[] {
	return rowsOf([
		evt({ cost: 10, job: "j1", jobType: "feature", typeSource: "explicit" }, 1),
		evt({ cost: 20, job: "j2", jobType: "feature", typeSource: "agent" }, 2),
		evt({ cost: 5, job: "j3", jobType: "bugfix", typeSource: "agent" }, 3),
		evt({ cost: 7, job: "j4", jobType: "made-up-type", typeSource: "agent" }, 4),
		evt({ cost: 3 }, 5),
		evt({ model: "claude-sonnet-4-6" }, 6),
	]);
}

describe("rows carry the declared job type", () => {
	it("copies job, jobType and typeSource when the record has them", () => {
		const [r] = rowsOf([evt({ job: "j1", jobType: "bugfix", typeSource: "agent" })]);
		expect(r).toMatchObject({ job: "j1", jobType: "bugfix", typeSource: "agent" });
	});

	it("a record without them stays without them: no key, not an empty string", () => {
		const [r] = rowsOf([evt({ cost: 1 })]);
		expect(r).not.toHaveProperty("job");
		expect(r).not.toHaveProperty("jobType");
		expect(r).not.toHaveProperty("typeSource");
		expect(jobTypeOf(r as LedgerRow)).toBe(UNTYPED);
		expect(typeSourceOf(r as LedgerRow)).toBe(UNTYPED);
	});

	it("a value outside the closed lists is `unrecognized`, and a non-string is ignored", () => {
		const rows = rowsOf([
			evt({ jobType: "made-up-type", typeSource: "somebody" }, 1),
			evt({ jobType: 7, typeSource: { a: 1 } }, 2),
		]);
		expect(rows[0]).toMatchObject({ jobType: UNRECOGNIZED, typeSource: UNRECOGNIZED });
		expect(rows[1]).not.toHaveProperty("jobType");
		expect(rows[1]).not.toHaveProperty("typeSource");
	});

	it("a type with no stated source reads `not stated`, never `untyped`", () => {
		const [r] = rowsOf([evt({ jobType: "docs" })]);
		expect(typeSourceOf(r as LedgerRow)).toBe("not stated");
	});

	it("mirrors core's closed lists", () => {
		// mutant: a type added to core and not here → its records read `unrecognized`
		expect([...JOB_TYPES]).toEqual([...CORE_JOB_TYPES]);
		expect([...TYPE_SOURCES]).toEqual([...CORE_TYPE_SOURCES]);
	});
});

describe("the job type facets", () => {
	it("filter by declared type, by who declared it, and `untyped` selects the records with none", () => {
		const rows = mixed();
		const ids = (jobTypes: string[], typeSources: string[] = []) =>
			applyFilters(rows, { ...EMPTY_FILTERS, jobTypes, typeSources }).map((r) => r.id);
		// mutant: the jobTypes clause dropped from applyFilters → every row comes back
		expect(ids(["feature"])).toEqual(["id-1", "id-2"]);
		expect(ids(["bugfix", "feature"])).toEqual(["id-1", "id-2", "id-3"]);
		expect(ids([UNTYPED])).toEqual(["id-5", "id-6"]);
		expect(ids([UNRECOGNIZED])).toEqual(["id-4"]);
		expect(ids([], ["agent"])).toEqual(["id-2", "id-3", "id-4"]);
		expect(ids([], [UNTYPED])).toEqual(["id-5", "id-6"]);
		expect(ids(["feature"], ["agent"])).toEqual(["id-2"]);
	});

	it("compose with the existing filters, and count as filtering", () => {
		const rows = mixed();
		expect(isFiltering({ ...EMPTY_FILTERS, jobTypes: ["feature"] })).toBe(true);
		expect(isFiltering({ ...EMPTY_FILTERS, typeSources: ["agent"] })).toBe(true);
		expect(
			applyFilters(rows, {
				...EMPTY_FILTERS,
				jobTypes: [UNTYPED],
				models: ["claude-sonnet-4-6"],
			}).map((r) => r.id),
		).toEqual(["id-6"]);
	});

	it("the search box finds a job id", () => {
		expect(applyFilters(mixed(), { ...EMPTY_FILTERS, search: "j3" }).map((r) => r.id)).toEqual([
			"id-3",
		]);
	});
});

describe("cost by declared job type", () => {
	it("every row lands in a bucket, `untyped` included: the buckets add up to the total in view", () => {
		const rows = mixed();
		const totals = costByJobType(rows);
		// mutant: rows with no type dropped (as costByModel drops rows with no model) → the sum falls short
		expect(totals.reduce((n, t) => n + t.costUt, 0)).toBe(statTiles(rows).totalCostUt);
		expect(totals.reduce((n, t) => n + t.count, 0)).toBe(rows.length);
		expect(Object.fromEntries(totals.map((t) => [t.key, t.costUt]))).toEqual({
			feature: 30,
			bugfix: 5,
			[UNRECOGNIZED]: 7,
			[UNTYPED]: 3,
		});
	});

	it("the sum equals the grand total on rows with no cost at all, and on an empty view", () => {
		const rows = rowsOf([evt({}, 1), evt({ jobType: "ops", typeSource: "explicit" }, 2)]);
		expect(costByJobType(rows).reduce((n, t) => n + t.costUt, 0)).toBe(statTiles(rows).totalCostUt);
		expect(costByJobType([])).toEqual([]);
	});

	it("sorts by cost, largest first", () => {
		expect(costByJobType(mixed()).map((t) => t.key)).toEqual([
			"feature",
			UNRECOGNIZED,
			"bugfix",
			UNTYPED,
		]);
	});
});

describe("the caveat is on every surface that shows a type", () => {
	it("is 'declared by the caller, not checked'", () => {
		expect(JOB_TYPE_CAVEAT).toBe("declared by the caller, not checked");
	});

	it("the CSV columns are named for it and keep the earlier columns where they were", () => {
		expect(CSV_HEADERS.slice(-3)).toEqual([
			"job",
			"job_type_declared_not_checked",
			"type_declared_by",
		]);
		const csv = toCsv(mixed());
		const header = csv.split("\r\n")[0]?.split(",") ?? [];
		const line = csv.split("\r\n")[1]?.split(",") ?? [];
		expect(line[header.indexOf("job")]).toBe("j1");
		expect(line[header.indexOf("job_type_declared_not_checked")]).toBe("feature");
		expect(line[header.indexOf("type_declared_by")]).toBe("explicit");
		const untyped = csv.split("\r\n")[5]?.split(",") ?? [];
		expect(untyped[header.indexOf("job_type_declared_not_checked")]).toBe("");
	});

	it("the trends card, the facet chip and the row panel all carry it", async () => {
		const { readFile } = await import("node:fs/promises");
		const app = (f: string) => readFile(new URL(`../src/app/${f}`, import.meta.url), "utf8");
		const [trends, filterBar, rowPanel] = await Promise.all([
			app("trends.tsx"),
			app("filter-bar.tsx"),
			app("row-panel.tsx"),
		]);
		// mutant: the caveat dropped from a surface's text → that expression no longer appears
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of the component is what is asserted
		expect(trends).toContain("title={`Cost by job type (${JOB_TYPE_CAVEAT})`}");
		expect(trends).toContain("costByJobType(props.rows)");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of the component is what is asserted
		expect(filterBar).toContain("label: `job type: ${t} (${JOB_TYPE_CAVEAT})`");
		expect(filterBar).toContain('label="job type (declared)"');
		expect(rowPanel).toContain("({JOB_TYPE_CAVEAT}");
	});
});
