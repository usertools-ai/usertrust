// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { PersistedAuditEvent } from "usertrust";
import { describe, expect, it } from "vitest";
import { CSV_HEADERS, csvFilename, toCsv } from "../src/shared/csv.js";
import { type LedgerRow, toLedgerRows } from "../src/shared/rows.js";

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: "evt-1",
		ts: "2026-07-27T13:45:02.000Z",
		kind: "llm_call",
		actor: "code-review",
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		costUt: 336,
		costUsd: 0.0336,
		settled: true,
		transferId: "tx_abc_123",
		hash: "a".repeat(64),
		previousHash: "b".repeat(64),
		integrity: "verified",
		...overrides,
	};
}

describe("toCsv", () => {
	it("emits a header row followed by one line per row", () => {
		const csv = toCsv([row(), row({ id: "evt-2", seq: 2 })]);
		const lines = csv.split("\r\n");
		expect(lines[0]).toBe(CSV_HEADERS.join(","));
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("code-review");
		expect(lines[1]).toContain("claude-sonnet-4-6");
	});

	it("writes an intact row's integrity as chained, never verified, and a row after a break as after-break", () => {
		const integrityAt = (r: LedgerRow) =>
			toCsv([r]).split("\r\n")[1]?.split(",")[CSV_HEADERS.indexOf("integrity")];
		expect(integrityAt(row())).toBe("chained");
		expect(integrityAt(row({ integrity: "after-break" }))).toBe("after-break");
	});

	it("writes numeric cost columns unquoted so spreadsheets sum them", () => {
		const cells = toCsv([row()]).split("\r\n")[1]?.split(",") as string[];
		expect(cells).toContain("336");
		expect(cells).toContain("0.0336");
	});

	it("quotes and escapes values containing commas or quotes", () => {
		const csv = toCsv([row({ actor: 'ops,"night"' })]);
		expect(csv).toContain('"ops,""night"""');
	});

	it("neutralizes spreadsheet formula injection", () => {
		for (const hostile of ["=cmd()", "+1", "-1", "@SUM(A1)"]) {
			const csv = toCsv([row({ actor: hostile })]);
			expect(csv).toContain(`"'${hostile}"`);
		}
	});

	it("renders missing optional fields as empty cells", () => {
		const csv = toCsv([
			row({ model: undefined, provider: undefined, costUt: undefined, costUsd: undefined }),
		]);
		const cells = csv.split("\r\n")[1]?.split(",") as string[];
		expect(cells.filter((c) => c === "").length).toBeGreaterThan(0);
	});

	it("writes the row's status; an outcome row the server gave none is unknown, never pending", () => {
		const statusAt = (line: string | undefined) => line?.split(",")[CSV_HEADERS.indexOf("status")];
		expect(statusAt(toCsv([row({ status: "settled" })]).split("\r\n")[1])).toBe("settled");
		expect(toCsv([row({ kind: "llm_call_failed", settled: false, status: "failed" })])).toContain(
			"failed",
		);
		const { status: _s, ...noStatus } = row({ settled: undefined });
		const lines = toCsv([noStatus]).split("\r\n");
		expect(lines[1]?.split(",")[CSV_HEADERS.indexOf("status")]).toBe("unknown");
		expect(toCsv([noStatus])).not.toContain("pending");
	});

	it("returns just the header for an empty ledger", () => {
		expect(toCsv([])).toBe(CSV_HEADERS.join(","));
	});
});

describe("csvFilename", () => {
	it("stamps the date and marks filtered exports", () => {
		expect(csvFilename(new Date("2026-07-27T10:00:00Z"), false)).toBe(
			"usertrust-ledger-2026-07-27.csv",
		);
		expect(csvFilename(new Date("2026-07-27T10:00:00Z"), true)).toBe(
			"usertrust-ledger-2026-07-27-filtered.csv",
		);
	});

	it("an export at a past position is named for that point, live exports as before", () => {
		const now = new Date("2026-11-06T12:00:00Z");
		expect(csvFilename(now, false, undefined, { pos: 40, windowStartPos: 0 })).toBe(
			"usertrust-ledger-as-recorded-41.csv",
		);
		expect(csvFilename(now, true, 50, { pos: 120, windowStartPos: 100 })).toBe(
			"usertrust-ledger-as-recorded-121-from-101-filtered.csv",
		);
		expect(csvFilename(now, false, 50, null)).toBe("usertrust-ledger-2026-11-06-newest-50.csv");
	});

	it("writes an ungoverned_call's status as ungoverned", () => {
		const { settled: _s, costUt: _c, costUsd: _u, ...base } = row({ kind: "ungoverned_call" });
		const lines = toCsv([base]).split("\r\n");
		const statusIndex = CSV_HEADERS.indexOf("status");
		expect(lines[1]?.split(",")[statusIndex]).toBe("ungoverned");
	});
});

describe("the row window and the usage source in Export", () => {
	it("red-first (no trace of the 100k window): an export of a windowed ledger says so in its filename", () => {
		expect(csvFilename(new Date("2026-07-27T10:00:00Z"), false, 100_000)).toBe(
			"usertrust-ledger-2026-07-27-newest-100000.csv",
		);
		expect(csvFilename(new Date("2026-07-27T10:00:00Z"), true, 100_000)).toBe(
			"usertrust-ledger-2026-07-27-newest-100000-filtered.csv",
		);
		expect(csvFilename(new Date("2026-07-27T10:00:00Z"), false, undefined)).toBe(
			"usertrust-ledger-2026-07-27.csv",
		);
	});

	it("red-first (an estimated cost exported like a reported one): each row says where its usage came from", () => {
		const at = (csv: string) =>
			csv.split("\r\n")[1]?.split(",")[CSV_HEADERS.indexOf("usage_source")];
		// Columns added later go after it, so this one keeps its position.
		expect(CSV_HEADERS.indexOf("usage_source")).toBe(14);
		expect(at(toCsv([row({ usageSource: "estimated" })]))).toBe("estimated");
		expect(at(toCsv([row({ usageSource: "provider" })]))).toBe("provider");
		expect(at(toCsv([row()]))).toBe("");
	});
});

describe("the charge columns", () => {
	// The header as 5.5.0 wrote it, kept here as text. It is never rebuilt from CSV_HEADERS: a column that moved or
	// was renamed would otherwise move or rename this too.
	const OLD_HEADER =
		"seq,timestamp,kind,actor,model,provider,cost_ut,cost_usd,status,integrity,transfer_id,event_id,hash,previous_hash,usage_source,job,job_type_declared_not_checked,type_declared_by";
	// The whole header, as text. A new column only ever goes on the end of this line.
	const HEADER =
		"seq,timestamp,kind,actor,model,provider,cost_ut,cost_usd,status,integrity,transfer_id,event_id,hash,previous_hash,usage_source,job,job_type_declared_not_checked,type_declared_by,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,input_rate_ut_per_1k,output_rate_ut_per_1k,cache_read_rate_ut_per_1k,cache_write_rate_ut_per_1k,pricing_table_version,cache_write_1h_tokens,cache_write_1h_rate_ut_per_1k,cache_write_1h_recorded";

	const TS = "2026-07-27T13:45:02.000Z";
	function bare(seq: number, kind: string, actor: string): LedgerRow {
		return {
			seq,
			pos: seq,
			id: `evt-${seq}`,
			ts: TS,
			kind,
			actor,
			hash: `h${seq}`,
			previousHash: `h${seq - 1}`,
			integrity: "verified",
		};
	}
	const paid = {
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		costUt: 115,
		costUsd: 0.0115,
		settled: true,
		transferId: "tx_7",
	};

	// One row of every kind the tests above use, each with a different part of a charge's inputs.
	const FIXTURE: LedgerRow[] = [
		// A settled charge with everything recorded, a 1-hour share included. All twelve values differ.
		{
			...bare(7, "llm_call", "code-review"),
			...paid,
			status: "settled",
			usageSource: "provider",
			job: "j1",
			jobType: "feature",
			typeSource: "explicit",
			usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 },
			appliedRates: { inputPer1k: 30, outputPer1k: 150, cacheReadPer1k: 3, cacheWritePer1k: 37.5 },
			cacheWrite1h: { tokens: 40, ratePer1k: 60 },
			pricingTableVersion: "2026-11-02",
		},
		// A failed call: no cost, no counts, no rates.
		{
			...bare(8, "llm_call_failed", "code-review"),
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			settled: false,
			status: "failed",
			error: "boom",
		},
		// An unmetered call.
		bare(9, "ungoverned_call", "nightly"),
		// No status from the server, after a chain break, a hostile actor; a recorded 0 count, a recorded 0 rate and
		// a 1-hour share with no usable number.
		{
			...bare(10, "llm_call", "=cmd()"),
			integrity: "after-break",
			costUt: 1,
			costUsd: 0.0001,
			usage: { cacheReadTokens: 0 },
			appliedRates: { outputPer1k: 0 },
			cacheWrite1h: {},
		},
		// An actor that needs quoting, an estimated cost, a 1-hour share with a count and no rate, and a version that
		// needs quoting.
		{
			...bare(11, "llm_call", 'ops,"night"'),
			...paid,
			status: "ambiguous",
			usageSource: "estimated",
			usage: { cacheWriteTokens: 2000 },
			appliedRates: { cacheWritePer1k: 37.5 },
			cacheWrite1h: { tokens: 500 },
			pricingTableVersion: 'v1,"beta"',
		},
		// An action kind at no cost: a 1-hour share with a rate and no count, small and fractional rates, and a
		// version that a spreadsheet would run.
		{
			...bare(12, "tool_use", "agent-x"),
			settled: true,
			status: "settled",
			costUt: 0,
			costUsd: 0,
			usage: { inputTokens: 0 },
			appliedRates: { inputPer1k: 1e-7, outputPer1k: 12.5, cacheReadPer1k: 0.1 },
			cacheWrite1h: { ratePer1k: 60 },
			pricingTableVersion: "=cmd()",
		},
	];
	// What 5.5.0 wrote for each fixture row: its first eighteen cells, byte for byte.
	const OLD_LINES = [
		`7,${TS},llm_call,code-review,claude-sonnet-4-6,anthropic,115,0.0115,settled,chained,tx_7,evt-7,h7,h6,provider,j1,feature,explicit`,
		`8,${TS},llm_call_failed,code-review,claude-sonnet-4-6,anthropic,,,failed,chained,,evt-8,h8,h7,,,,`,
		`9,${TS},ungoverned_call,nightly,,,,,ungoverned,chained,,evt-9,h9,h8,,,,`,
		`10,${TS},llm_call,"'=cmd()",,,1,0.0001,unknown,after-break,,evt-10,h10,h9,,,,`,
		`11,${TS},llm_call,"ops,""night""",claude-sonnet-4-6,anthropic,115,0.0115,ambiguous,chained,tx_7,evt-11,h11,h10,estimated,,,`,
		`12,${TS},tool_use,agent-x,,,0,0,settled,chained,,evt-12,h12,h11,,,,`,
	];
	// The twelve cells each row gains, in the header's order. The last says whether the record carried a 1-hour
	// share at all: `yes` for the four rows that have one, usable or not, and empty for the two that have none.
	const NEW_CELLS = [
		"1000,500,2000,100,30,150,3,37.5,2026-11-02,40,60,yes",
		",,,,,,,,,,,",
		",,,,,,,,,,,",
		",,0,,,0,,,,,,yes",
		`,,,2000,,,,37.5,"v1,""beta""",500,,yes`,
		`0,,,,1e-7,12.5,0.1,,"'=cmd()",,60,yes`,
	];

	/** One cell of a single row, found by its name in the header text above. Only for rows with no quoted cell. */
	function at(r: LedgerRow, name: string): string | undefined {
		return toCsv([r]).split("\r\n")[1]?.split(",")[HEADER.split(",").indexOf(name)];
	}

	it("the header is exactly this line, in this order", () => {
		expect(toCsv([])).toBe(HEADER);
		expect(CSV_HEADERS.join(",")).toBe(HEADER);
		expect(CSV_HEADERS).toHaveLength(30);
	});

	it("the 5.5.0 header is a prefix of it, column for column, and the twelve new names follow", () => {
		const old = OLD_HEADER.split(",");
		expect(old).toHaveLength(18);
		const now = toCsv([]).split(",");
		old.forEach((name, i) => {
			expect(now[i]).toBe(name);
		});
		expect(toCsv([]).startsWith(`${OLD_HEADER},`)).toBe(true);
		expect(now.slice(18)).toEqual([
			"input_tokens",
			"output_tokens",
			"cache_read_tokens",
			"cache_write_tokens",
			"input_rate_ut_per_1k",
			"output_rate_ut_per_1k",
			"cache_read_rate_ut_per_1k",
			"cache_write_rate_ut_per_1k",
			"pricing_table_version",
			"cache_write_1h_tokens",
			"cache_write_1h_rate_ut_per_1k",
			"cache_write_1h_recorded",
		]);
		expect(now[now.length - 1]).toBe("cache_write_1h_recorded");
	});

	it("every row keeps its first eighteen cells byte for byte", () => {
		const lines = toCsv(FIXTURE).split("\r\n").slice(1);
		expect(lines).toHaveLength(OLD_LINES.length);
		OLD_LINES.forEach((old, i) => {
			expect(lines[i]?.startsWith(`${old},`)).toBe(true);
		});
	});

	it("every row gains exactly its twelve cells, after the old ones", () => {
		const lines = toCsv(FIXTURE).split("\r\n").slice(1);
		expect(NEW_CELLS).toHaveLength(OLD_LINES.length);
		OLD_LINES.forEach((old, i) => {
			expect(lines[i]).toBe(`${old},${NEW_CELLS[i]}`);
		});
	});

	it("a row with no usage has all twelve cells empty, never 0 and never no", () => {
		const line = toCsv([bare(9, "ungoverned_call", "nightly")]).split("\r\n")[1] as string;
		expect(line.split(",")).toHaveLength(30);
		expect(line.split(",").slice(18)).toEqual(["", "", "", "", "", "", "", "", "", "", "", ""]);
		expect(line.endsWith("h8,,,,,,,,,,,,,,,,")).toBe(true);
	});

	it("a recorded 0 prints 0, and the count or rate beside it that is absent stays empty", () => {
		const r: LedgerRow = {
			...bare(1, "llm_call", "a"),
			usage: { cacheReadTokens: 0 },
			appliedRates: { cacheWritePer1k: 0 },
			cacheWrite1h: { tokens: 0, ratePer1k: 0 },
		};
		expect(at(r, "cache_read_tokens")).toBe("0");
		expect(at(r, "cache_write_rate_ut_per_1k")).toBe("0");
		expect(at(r, "cache_write_1h_tokens")).toBe("0");
		expect(at(r, "cache_write_1h_rate_ut_per_1k")).toBe("0");
		for (const absent of [
			"input_tokens",
			"output_tokens",
			"cache_write_tokens",
			"input_rate_ut_per_1k",
			"output_rate_ut_per_1k",
			"cache_read_rate_ut_per_1k",
			"pricing_table_version",
		]) {
			expect(at(r, absent)).toBe("");
		}
		// Every count and every rate recorded as 0: ten cells of 0, the version still empty, and a share of 0 tokens
		// is still a share the record carried.
		const zeros: LedgerRow = {
			...bare(1, "llm_call", "a"),
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			appliedRates: { inputPer1k: 0, outputPer1k: 0, cacheReadPer1k: 0, cacheWritePer1k: 0 },
			cacheWrite1h: { tokens: 0, ratePer1k: 0 },
		};
		expect(toCsv([zeros]).split("\r\n")[1]?.endsWith(",h0,,,,,0,0,0,0,0,0,0,0,,0,0,yes")).toBe(
			true,
		);
	});

	it("a 1-hour share prints the numbers it has: both, one, or neither, and never the 5-minute rate", () => {
		const share = (cacheWrite1h: { tokens?: number; ratePer1k?: number }): LedgerRow => ({
			...bare(1, "llm_call", "a"),
			usage: { cacheWriteTokens: 2000 },
			appliedRates: { cacheWritePer1k: 37.5 },
			cacheWrite1h,
		});
		const pair = (r: LedgerRow) => [
			at(r, "cache_write_1h_tokens"),
			at(r, "cache_write_1h_rate_ut_per_1k"),
		];
		expect(pair(share({ tokens: 500, ratePer1k: 60 }))).toEqual(["500", "60"]);
		expect(pair(share({ tokens: 500 }))).toEqual(["500", ""]);
		expect(pair(share({ ratePer1k: 60 }))).toEqual(["", "60"]);
		expect(pair(share({}))).toEqual(["", ""]);
		// The write tier's own cells are the record's, whatever the share holds.
		expect(at(share({}), "cache_write_tokens")).toBe("2000");
		expect(at(share({}), "cache_write_rate_ut_per_1k")).toBe("37.5");
		// No 1-hour field at all: the same two empty cells. The last column is what tells the two apart.
		const { cacheWrite1h: _none, ...plain } = share({});
		expect(pair(plain)).toEqual(["", ""]);
	});

	it("no share, a share with no usable number and a usable share print three different endings", () => {
		const write = { usage: { cacheWriteTokens: 2000 }, appliedRates: { cacheWritePer1k: 37.5 } };
		const ending = (r: LedgerRow) =>
			(toCsv([r]).split("\r\n")[1] as string).split(",").slice(-3).join(",");
		const none = ending({ ...bare(1, "llm_call", "a"), ...write });
		const unusable = ending({ ...bare(1, "llm_call", "a"), ...write, cacheWrite1h: {} });
		const usable = ending({
			...bare(1, "llm_call", "a"),
			...write,
			cacheWrite1h: { tokens: 500, ratePer1k: 60 },
		});
		expect(none).toBe(",,");
		expect(unusable).toBe(",,yes");
		expect(usable).toBe("500,60,yes");
		expect(new Set([none, unusable, usable]).size).toBe(3);
		// A share with one usable number is a share too.
		expect(ending({ ...bare(1, "llm_call", "a"), ...write, cacheWrite1h: { tokens: 500 } })).toBe(
			"500,,yes",
		);
		expect(ending({ ...bare(1, "llm_call", "a"), ...write, cacheWrite1h: { ratePer1k: 60 } })).toBe(
			",60,yes",
		);
		// The cell is `yes` or empty. It is never `no`, `0`, `true` or `false`.
		const cells = FIXTURE.map((r) => at(r, "cache_write_1h_recorded"));
		expect(cells.slice(1, 3)).toEqual(["", ""]);
		for (const c of toCsv(FIXTURE)
			.split("\r\n")
			.slice(1)
			.map((l) => l.slice(l.lastIndexOf(",") + 1))) {
			expect(["", "yes"]).toContain(c);
		}
	});

	it("from the record: a null or malformed 1-hour share is a share the record carried, and no field is none", () => {
		const recorded = (data: Record<string, unknown>) => {
			const event: PersistedAuditEvent = {
				id: "id-1",
				timestamp: TS,
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: "llm_call",
				actor: "local",
				data,
				sequence: 1,
			};
			const rows = toLedgerRows([event], { valid: true, breakIndex: null }, undefined, 0);
			return (toCsv(rows).split("\r\n")[1] as string).split(",").slice(-3).join(",");
		};
		const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 2000 };
		expect(recorded({ usage })).toBe(",,");
		expect(recorded({ usage, cacheWrite1h: null })).toBe(",,yes");
		expect(recorded({ usage, cacheWrite1h: "soon" })).toBe(",,yes");
		expect(recorded({ usage, cacheWrite1h: { tokens: -1, ratePer1k: "x" } })).toBe(",,yes");
		expect(recorded({ usage, cacheWrite1h: { tokens: 500 } })).toBe("500,,yes");
		expect(recorded({ usage, cacheWrite1h: { tokens: 500, ratePer1k: 60 } })).toBe("500,60,yes");
	});

	it("numbers print bare, in the shortest form that reads back as the recorded number", () => {
		const rate = (inputPer1k: number) =>
			at({ ...bare(1, "llm_call", "a"), appliedRates: { inputPer1k } }, "input_rate_ut_per_1k");
		expect(rate(12.5)).toBe("12.5");
		expect(rate(0.1)).toBe("0.1");
		expect(rate(30)).toBe("30");
		expect(rate(0.000001)).toBe("0.000001");
		// Below one millionth the shortest form is exponent notation, which spreadsheets read as a number.
		expect(rate(1e-7)).toBe("1e-7");
		expect(Number(rate(1e-7))).toBe(1e-7);
		const count = (inputTokens: number) =>
			at({ ...bare(1, "llm_call", "a"), usage: { inputTokens } }, "input_tokens");
		expect(count(1234567)).toBe("1234567");
	});

	it("the pricing table version is text: quoted when it must be, and never left runnable", () => {
		const version = (pricingTableVersion: string) =>
			toCsv([{ ...bare(1, "llm_call", "a"), pricingTableVersion }]).split("\r\n")[1] as string;
		expect(version("2026-11-02").endsWith(",2026-11-02,,,")).toBe(true);
		expect(version('v1,"beta"').endsWith(',"v1,""beta""",,,')).toBe(true);
		expect(version("line\nbreak").endsWith(',"line\nbreak",,,')).toBe(true);
		for (const hostile of ["=cmd()", "+1", "-1", "@SUM(A1)"]) {
			expect(version(hostile).endsWith(`,"'${hostile}",,,`)).toBe(true);
		}
	});

	it("the export prints what the record carries and works nothing out: no product, no sum", () => {
		const line = toCsv([FIXTURE[0] as LedgerRow]).split("\r\n")[1] as string;
		// 1000 at 30 is 30 UT, the tiers sum to 114.75 and the 1-hour remainder is 60 tokens: none is a cell.
		expect(line.split(",")).toHaveLength(30);
		expect(line).not.toContain("114.75");
		expect(line.split(",").slice(18)).not.toContain("75");
	});
});

describe("the formula guard, from the record", () => {
	const TS = "2026-07-27T13:45:02.000Z";
	type Text = { actor?: string; model?: string; job?: string; pricingTableVersion?: string };

	/** The export's one data row for a record that carries these text fields, read by the real reader. */
	function exported(text: Text): string {
		const data: Record<string, unknown> = { model: text.model ?? "m" };
		if (text.job !== undefined) data.job = text.job;
		if (text.pricingTableVersion !== undefined) data.pricingTableVersion = text.pricingTableVersion;
		const event: PersistedAuditEvent = {
			id: "id-1",
			timestamp: TS,
			previousHash: "0".repeat(64),
			hash: "a".repeat(64),
			kind: "llm_call",
			actor: text.actor ?? "local",
			data,
			sequence: 1,
		};
		const rows = toLedgerRows([event], { valid: true, breakIndex: null }, undefined, 0);
		// Everything after the header and its CRLF: a cell may hold a line break of its own.
		return toCsv(rows).slice(CSV_HEADERS.join(",").length + 2);
	}

	/** The row the export should write: these cells as written in the file, every other cell as the record gives it. */
	function line(cells: Partial<Record<(typeof CSV_HEADERS)[number], string>>): string {
		const base: Partial<Record<(typeof CSV_HEADERS)[number], string>> = {
			seq: "1",
			timestamp: TS,
			kind: "llm_call",
			actor: "local",
			model: "m",
			provider: "unknown",
			status: "unknown",
			integrity: "chained",
			event_id: "id-1",
			hash: "a".repeat(64),
			previous_hash: "0".repeat(64),
		};
		return CSV_HEADERS.map((name) => ({ ...base, ...cells })[name] ?? "").join(",");
	}

	// Ordinary text, and how the export has always written it. None of these may change by a single byte.
	const ORDINARY: [string, string][] = [
		["local", "local"],
		["2026-11-02", "2026-11-02"],
		// Leading spaces before ordinary text, and cells of spaces only.
		["  hello", "  hello"],
		[" ", " "],
		["   ", "   "],
		[" hello", " hello"],
		// A formula character after the first ordinary character.
		["a=b", "a=b"],
		["1+1", "1+1"],
		["x-y", "x-y"],
		["e@mail", "e@mail"],
		["hello =cmd()", "hello =cmd()"],
		// A tab or carriage return that is not the first character.
		["hello\tworld", "hello\tworld"],
		[" \thello", " \thello"],
		["a\rb", '"a\rb"'],
		[" \rhello", '" \rhello"'],
		// A line feed, first or later, before ordinary text: quoted for the line break, as it always was.
		["\nhello", '"\nhello"'],
		["line\nbreak", '"line\nbreak"'],
		['ops,"night"', '"ops,""night"""'],
	];

	it("ordinary text prints exactly as it always has, in every text column the record fills", () => {
		for (const [value, written] of ORDINARY) {
			expect(exported({ actor: value, model: value, job: value, pricingTableVersion: value })).toBe(
				line({ actor: written, model: written, job: written, pricing_table_version: written }),
			);
		}
	});

	// Text a spreadsheet would run: a formula character first, or first after whitespace, or a tab or carriage return
	// first, whatever follows.
	const FORMULAS = ["=cmd()", "+1", "-1", "@SUM(A1)"];
	const BEFORE = ["", " ", "   ", "\t", "\r", "\n", " \t ", "\r\n", " "];
	const HOSTILE = [
		...FORMULAS.flatMap((formula) => BEFORE.map((before) => `${before}${formula}`)),
		...["\t", "\r"].flatMap((first) => [
			`${first}hello`,
			`${first} hello`,
			`${first}${first}hello`,
			`${first}`,
			`${first}=1+1`,
		]),
	];
	const COLUMNS = [
		["actor", "actor"],
		["model", "model"],
		["job", "job"],
		["pricingTableVersion", "pricing_table_version"],
	] as const;

	it("each such cell is written with a leading apostrophe, quoted, in every text column the record fills", () => {
		for (const [field, column] of COLUMNS) {
			for (const value of HOSTILE) {
				expect(exported({ [field]: value })).toBe(line({ [column]: `"'${value}"` }));
			}
		}
	});

	it("a formula character after leading whitespace is defanged like one at the start", () => {
		expect(exported({ actor: "  =cmd()" })).toBe(line({ actor: `"'  =cmd()"` }));
		expect(exported({ model: "\t=1+1" })).toBe(line({ model: `"'\t=1+1"` }));
		expect(exported({ job: " @SUM(A1)" })).toBe(line({ job: `"' @SUM(A1)"` }));
		expect(exported({ pricingTableVersion: " -1" })).toBe(
			line({ pricing_table_version: `"' -1"` }),
		);
	});

	it("a cell that starts with a tab or a carriage return is defanged, whatever follows", () => {
		expect(exported({ actor: "\thello" })).toBe(line({ actor: `"'\thello"` }));
		expect(exported({ job: "\rhello" })).toBe(line({ job: `"'\rhello"` }));
	});
});
