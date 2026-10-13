// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { applyFilters, EMPTY_FILTERS } from "../src/shared/filters.js";
import {
	compactActor,
	formatUsd,
	formatUt,
	formatUtc,
	formatUtcMinute,
	middleTruncate,
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
