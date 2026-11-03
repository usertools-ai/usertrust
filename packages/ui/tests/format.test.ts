// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { applyFilters, EMPTY_FILTERS } from "../src/shared/filters.js";
import {
	compactActor,
	costBoundLabel,
	formatUsd,
	formatUsdApprox,
	formatUsdAxis,
	formatUsdTotal,
	formatUt,
	formatUtc,
	formatUtcMinute,
	middleTruncate,
	UT_KEY,
	utcDay,
	utcHour,
} from "../src/shared/format.js";
import type { LedgerRow } from "../src/shared/rows.js";

describe("formatUtc", () => {
	it("red-first (no zone): a time is shown in UTC WITH its Z, never as a bare clock reading", () => {
		expect(formatUtc("2026-10-12T17:59:02.770Z")).toBe("10-12 17:59:02Z");
	});

	it("an offset timestamp is shown at its UTC instant, not its local clock", () => {
		expect(formatUtc("2026-10-12T19:59:02+02:00")).toBe("10-12 17:59:02Z");
	});

	it("an unreadable timestamp is shown verbatim, never as a made-up time", () => {
		expect(formatUtc("not a time")).toBe("not a time");
	});

	// A call late in the UTC day falls on the NEXT local day west of UTC. The date the row shows is the date the
	// filter compares, so "10-10" in the row and "From (UTC) 2026-10-10" agree.
	it("the date a row shows is the date the date filters keep it under", () => {
		const row: LedgerRow = {
			seq: 1,
			id: "e1",
			ts: "2026-10-10T23:41:08.311Z",
			kind: "llm_call",
			actor: "local",
			hash: "a".repeat(64),
			previousHash: "0".repeat(64),
			integrity: "verified",
		};
		expect(formatUtc(row.ts).slice(0, 5)).toBe("10-10");
		expect(applyFilters([row], { ...EMPTY_FILTERS, from: "2026-10-10", to: "2026-10-10" })).toEqual(
			[row],
		);
		expect(applyFilters([row], { ...EMPTY_FILTERS, from: "2026-10-11" })).toEqual([]);
	});

	it("a timestamp written with an offset is shown AND filtered at its UTC date, never its local one", () => {
		const row: LedgerRow = {
			seq: 1,
			id: "e2",
			ts: "2026-10-13T01:30:00+02:00",
			kind: "llm_call",
			actor: "local",
			hash: "b".repeat(64),
			previousHash: "0".repeat(64),
			integrity: "verified",
		};
		expect(formatUtc(row.ts)).toBe("10-12 23:30:00Z");
		expect(utcDay(row.ts)).toBe("2026-10-12");
		expect(applyFilters([row], { ...EMPTY_FILTERS, from: "2026-10-12", to: "2026-10-12" })).toEqual(
			[row],
		);
		expect(applyFilters([row], { ...EMPTY_FILTERS, from: "2026-10-13" })).toEqual([]);
	});
});

describe("formatUtcMinute and utcHour", () => {
	it("red-first (sliced and labelled Z): an offset timestamp is shown at its UTC instant", () => {
		expect(formatUtcMinute("2026-10-13T01:30:00+02:00")).toBe("2026-10-12 23:30Z");
		expect(utcHour("2026-10-13T01:30:00+02:00")).toBe("2026-10-12 23:00");
		expect(formatUtcMinute("not a time")).toBe("not a time");
	});
});

describe("money", () => {
	it("red-first (2 dp in the header, 4 dp in rows): one formatter, exact at 1 UT = $0.0001", () => {
		expect(formatUsd(9_535)).toBe("$0.9535");
		expect(formatUsd(97)).toBe("$0.0097");
		expect(formatUsd(1)).toBe("$0.0001");
		expect(formatUsd(0)).toBe("$0.0000");
	});

	it("usertokens carry their unit", () => {
		expect(formatUt(412)).toBe("412 UT");
	});
});

describe("compactActor", () => {
	it("red-first (cut to 'claude-code:5f…'): keeps the part that tells two sessions apart", () => {
		expect(compactActor("claude-code:5f1c2a9e-7b3d-4e0f-9a21-0c6d8e4b2f17")).toBe(
			"claude-code · 5f1c2a9e",
		);
		expect(compactActor("claude-code:15e2c1d0-6a4b-4c1e-8f3a-2d9b7e5c4a10")).toBe(
			"claude-code · 15e2c1d0",
		);
	});

	it("an actor without an instance id is shown whole", () => {
		expect(compactActor("research-agent")).toBe("research-agent");
		expect(compactActor("local")).toBe("local");
	});

	it("only the LAST segment is the instance id", () => {
		expect(compactActor("tenant:acme:9f8e7d6c5b4a")).toBe("tenant:acme · 9f8e7d6c");
	});
});

describe("middleTruncate", () => {
	it("keeps both ends of a long path, and a short one whole", () => {
		const path = "/Users/someone/projects/acme/agents/.usertrust";
		expect(middleTruncate(path, 100)).toBe(path);
		const cut = middleTruncate(path, 24);
		expect(cut).toHaveLength(24);
		expect(cut.startsWith("/Users")).toBe(true);
		expect(cut.endsWith(".usertrust")).toBe(true);
		expect(cut).toContain("…");
	});
});

describe("dollars first", () => {
	it("red-first (a total printed in usertokens): a total is 2 dp, and its exact 4 dp figure is the tooltip", () => {
		// 76,045 UT is $7.6045: no float drift in either figure.
		expect(formatUsdTotal(76_045)).toBe("$7.60");
		expect(formatUsd(76_045)).toBe("$7.6045");
	});

	it("groups the whole dollars with commas", () => {
		expect(formatUsdTotal(12_045_500)).toBe("$1,204.55");
		expect(formatUsd(12_045_500)).toBe("$1,204.5500");
		expect(formatUsdTotal(1_000_000_000)).toBe("$100,000.00");
	});

	it("edge values are exact: 0, 1 UT, 9,999 UT, and one dollar", () => {
		expect(formatUsdTotal(0)).toBe("$0.00");
		expect(formatUsd(0)).toBe("$0.0000");
		expect(formatUsd(1)).toBe("$0.0001");
		expect(formatUsdTotal(1)).toBe("$0.00");
		expect(formatUsd(9_999)).toBe("$0.9999");
		expect(formatUsdTotal(9_999)).toBe("$1.00");
		expect(formatUsd(10_000)).toBe("$1.0000");
		expect(formatUsdTotal(10_000)).toBe("$1.00");
	});

	it("rounds a half cent up, never by a float's whim", () => {
		expect(formatUsdTotal(49)).toBe("$0.00");
		expect(formatUsdTotal(50)).toBe("$0.01");
		// 1.005 * 100 is 100.49999999999999 in floats: integer math has no such case
		expect(formatUsdTotal(10_050)).toBe("$1.01");
		expect(formatUsdTotal(76_050)).toBe("$7.61");
	});

	it("a very large count has no float drift", () => {
		// 9,007,199,254,740,991 UT = $900,719,925,474.0991
		expect(formatUsd(Number.MAX_SAFE_INTEGER)).toBe("$900,719,925,474.0991");
		expect(formatUsdTotal(Number.MAX_SAFE_INTEGER)).toBe("$900,719,925,474.10");
		expect(formatUsd(123_456_789_012_345)).toBe("$12,345,678,901.2345");
	});

	it("a count that is not finite has no dollar figure, never $NaN", () => {
		expect(formatUsd(Number.NaN)).toBe("n/a");
		expect(formatUsdTotal(Number.POSITIVE_INFINITY)).toBe("n/a");
	});

	it("the key says what a UT is, in exactly these words", () => {
		expect(UT_KEY).toBe("1 UT = $0.0001, one hundredth of a cent");
	});

	it("a typed bound gets a dollar echo; under a cent it keeps 4 dp so it does not read $0.00", () => {
		expect(formatUsdApprox(5_000)).toBe("≈ $0.50");
		expect(formatUsdApprox(100)).toBe("≈ $0.01");
		expect(formatUsdApprox(10)).toBe("≈ $0.0010");
		expect(costBoundLabel("≥", 5_000)).toBe("cost ≥ 5000 UT ≈ $0.50 · uncosted hidden");
		expect(costBoundLabel("≤", 10)).toBe("cost ≤ 10 UT ≈ $0.0010 · uncosted hidden");
	});

	it("an axis tick drops trailing zeros but keeps 2 dp", () => {
		expect(formatUsdAxis(20_000)).toBe("$2.00");
		expect(formatUsdAxis(5_000)).toBe("$0.50");
		expect(formatUsdAxis(5)).toBe("$0.0005");
		expect(formatUsdAxis(50)).toBe("$0.005");
		expect(formatUsdAxis(12_045_500)).toBe("$1,204.55");
	});
});
