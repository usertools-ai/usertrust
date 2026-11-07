// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * MONEY FIGURES ON A MIXED LOG. In a log where some events carry a `sequence` and some do not, the
 * chain walk leaves the sequence-less events out (each is its own error), but the events a
 * reading hands back are every event of the log. `usertrust inspect` and `usertrust report` build
 * their spend from those events, so a sequence-less `llm_call` still counts: a figure that dropped
 * it understated the spend and overstated the remaining budget.
 *
 * Each row compares the mixed vault with the same calls all sequenced: the figures are equal.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { run as inspectRun } from "../../src/cli/inspect.js";
import { run as reportRun } from "../../src/cli/report.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";

const RATES = { inputPer1k: 100, outputPer1k: 500, cacheReadPer1k: 10, cacheWritePer1k: 125 };

interface Call {
	sequence: number | null;
	cost: number;
	transferId: string;
}

/** The three calls of every row: the middle one (50 UT) carries no sequence in the mixed vault. */
const MIXED: readonly Call[] = [
	{ sequence: 1, cost: 100, transferId: "tx_one" },
	{ sequence: null, cost: 50, transferId: "tx_unsequenced" },
	{ sequence: 2, cost: 25, transferId: "tx_three" },
];
const SEQUENCED: readonly Call[] = MIXED.map((c, i) => ({ ...c, sequence: i + 1 }));

let tempDir: string;
let logOutput: string[];
let stdout: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "trust-mixed-figures-"));
	logOutput = [];
	stdout = "";
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logOutput.push(args.map(String).join(" "));
	});
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		stdout += String(chunk);
		return true;
	});
	process.exitCode = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
	rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Write `calls` as `llm_call` events to a fresh project's `events.jsonl`, each hashed over its
 * canonical form and linked to the one before it (the first to GENESIS), with a vault budget of
 * 1,000 UT. A `null` sequence writes an event with no `sequence` field. Returns the project root.
 */
function project(calls: readonly Call[]): string {
	const root = mkdtempSync(join(tempDir, "project-"));
	const auditDir = join(root, VAULT_DIR, "audit");
	mkdirSync(auditDir, { recursive: true });
	writeFileSync(join(root, VAULT_DIR, "usertrust.config.json"), JSON.stringify({ budget: 1000 }));
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];
	const start = Date.now() - 60_000;
	for (let i = 0; i < calls.length; i++) {
		const c = calls[i] as Call;
		const event: Record<string, unknown> = {
			id: `evt-${i + 1}`,
			timestamp: new Date(start + i * 1000).toISOString(),
			previousHash,
			kind: "llm_call",
			actor: "local",
			data: {
				model: "claude-sonnet-5-5",
				cost: c.cost,
				settled: true,
				transferId: c.transferId,
				usageSource: "provider",
				usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
				appliedRates: RATES,
			},
		};
		if (c.sequence !== null) event.sequence = c.sequence;
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		lines.push(JSON.stringify({ ...event, hash }));
		previousHash = hash;
	}
	writeFileSync(join(auditDir, "events.jsonl"), `${lines.join("\n")}\n`);
	return root;
}

interface InspectJson {
	data: {
		spent: number;
		remaining: number | null;
		chain: { events: number; valid: boolean; errors: string[] };
		transactions: { cost: number | null; receipt: string }[];
	};
}

async function inspectJson(root: string): Promise<InspectJson["data"]> {
	logOutput = [];
	await inspectRun(root, { json: true });
	return (JSON.parse(logOutput.at(-1) as string) as InspectJson).data;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips SGR codes (ESC [ ... m) from captured output
const SGR = /\x1b\[[0-9;]*m/g;

async function inspectTable(root: string): Promise<string> {
	logOutput = [];
	await inspectRun(root);
	return logOutput.join("\n").replace(SGR, "");
}

describe("usertrust inspect: a sequence-less llm_call in a mixed log is in every figure", () => {
	it("positive control: the all-sequenced vault spends 175 of 1,000 UT", async () => {
		const data = await inspectJson(project(SEQUENCED));
		expect(data.spent).toBe(175);
		expect(data.remaining).toBe(825);
		expect(data.chain.valid).toBe(true);
		expect(data.transactions.map((t) => t.receipt)).toContain("tx_unsequenced");
	});

	it("the JSON spend and remaining budget include the sequence-less call", async () => {
		const mixed = await inspectJson(project(MIXED));
		const sequenced = await inspectJson(project(SEQUENCED));
		expect(mixed.spent).toBe(175);
		expect(mixed.remaining).toBe(825);
		expect(mixed.spent).toBe(sequenced.spent);
		expect(mixed.remaining).toBe(sequenced.remaining);
		// The verdict still fails the log: the call has no place in the walk.
		expect(mixed.chain.valid).toBe(false);
		expect(mixed.chain.errors).toContain("event without sequence (events.jsonl:2)");
		expect(mixed.chain.events).toBe(2);
	});

	it("the JSON transactions list the sequence-less call with its own cost", async () => {
		const mixed = await inspectJson(project(MIXED));
		const row = mixed.transactions.find((t) => t.receipt === "tx_unsequenced");
		expect(row).toEqual(expect.objectContaining({ cost: 50 }));
		expect(mixed.transactions.map((t) => t.receipt).sort()).toEqual(
			["tx_one", "tx_three", "tx_unsequenced"].sort(),
		);
	});

	it("the printed table shows the remaining budget and the sequence-less call", async () => {
		const table = await inspectTable(project(MIXED));
		expect(table).toContain("Budget: 825 / 1,000 UT remaining (82.5%)");
		expect(table).toContain("tx_unsequenced");
		expect(table).toContain("50 UT");
		expect(table).toContain("INTEGRITY FAILURE");
	});

	it("the chain count is the WALKED count, printed beside a table that lists every call", async () => {
		// Deliberate: the count is what the chain check covered (two sequenced calls), and the
		// error naming the third is printed with it; the table and the spend still hold all three.
		const table = await inspectTable(project(MIXED));
		expect(table).toContain("Chain: 2 events | Integrity: INTEGRITY FAILURE");
		for (const tx of ["tx_one", "tx_unsequenced", "tx_three"]) expect(table).toContain(tx);
		expect(table).toContain("event without sequence (events.jsonl:2)");
	});
});

interface ReportTotals {
	confirmedUt: number;
	confirmedCalls: number;
}

async function reportTotals(root: string): Promise<ReportTotals> {
	stdout = "";
	process.exitCode = undefined;
	const end = new Date(Date.now() + 3_600_000).toISOString();
	await reportRun(root, {}, ["--week", "--end", end, "--format", "json"]);
	return (JSON.parse(stdout) as { totals: ReportTotals }).totals;
}

describe("usertrust report: a sequence-less llm_call in a mixed log is in the spend", () => {
	it("positive control: the all-sequenced vault confirms 175 UT over 3 calls", async () => {
		const totals = await reportTotals(project(SEQUENCED));
		expect(totals).toMatchObject({ confirmedUt: 175, confirmedCalls: 3 });
	});

	it("the confirmed spend includes the sequence-less call, equal to the all-sequenced vault", async () => {
		const mixed = await reportTotals(project(MIXED));
		const sequenced = await reportTotals(project(SEQUENCED));
		expect(mixed).toMatchObject({ confirmedUt: 175, confirmedCalls: 3 });
		expect(mixed.confirmedUt).toBe(sequenced.confirmedUt);
		expect(mixed.confirmedCalls).toBe(sequenced.confirmedCalls);
	});

	it("the report still fails the mixed log's integrity and exits 2", async () => {
		const root = project(MIXED);
		stdout = "";
		process.exitCode = undefined;
		const end = new Date(Date.now() + 3_600_000).toISOString();
		await reportRun(root, {}, ["--week", "--end", end, "--format", "json"]);
		expect(process.exitCode).toBe(2);
		const out = JSON.parse(stdout) as { integrity: { verified: boolean } };
		expect(out.integrity.verified).toBe(false);
	});
});

/**
 * EVIDENCE ON A MIXED LOG. A sequence-less record is in every figure, but it was never checked,
 * and the log fails its chain check, so no record of it may prove anything: not a release, not a
 * post. Each row compares the mixed vault with the same records all sequenced.
 */
interface LogRecord {
	sequence: number | null;
	kind: string;
	data: Record<string, unknown>;
}

/** An `llm_call` record's data, denominated in dollars. */
function callData(cost: number, transferId: string, extra: Record<string, unknown> = {}) {
	return {
		model: "claude-sonnet-5-5",
		cost,
		settled: true,
		transferId,
		costBasis: "usd-proxy",
		usageSource: "provider",
		usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
		appliedRates: RATES,
		...extra,
	};
}

/** `project`, for records of any kind: hashed over the canonical form and linked in file order. */
function projectOf(records: readonly LogRecord[]): string {
	const root = mkdtempSync(join(tempDir, "project-"));
	const auditDir = join(root, VAULT_DIR, "audit");
	mkdirSync(auditDir, { recursive: true });
	writeFileSync(join(root, VAULT_DIR, "usertrust.config.json"), JSON.stringify({ budget: 1000 }));
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];
	const start = Date.now() - 60_000;
	for (let i = 0; i < records.length; i++) {
		const r = records[i] as LogRecord;
		const event: Record<string, unknown> = {
			id: `evt-${i + 1}`,
			timestamp: new Date(start + i * 1000).toISOString(),
			previousHash,
			kind: r.kind,
			actor: "local",
			data: r.data,
		};
		if (r.sequence !== null) event.sequence = r.sequence;
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		lines.push(JSON.stringify({ ...event, hash }));
		previousHash = hash;
	}
	writeFileSync(join(auditDir, "events.jsonl"), `${lines.join("\n")}\n`);
	return root;
}

/** Every record with its place in the file as its sequence. */
function allSequenced(records: readonly LogRecord[]): LogRecord[] {
	return records.map((r, i) => ({ ...r, sequence: i + 1 }));
}

interface ReportJson {
	proofStatus: string;
	integrity: { verified: boolean };
	totals: Record<string, number>;
}

async function reportJson(root: string): Promise<ReportJson> {
	stdout = "";
	process.exitCode = undefined;
	const end = new Date(Date.now() + 3_600_000).toISOString();
	await reportRun(root, {}, ["--week", "--end", end, "--format", "json"]);
	return JSON.parse(stdout) as ReportJson;
}

describe("usertrust report: a sequence-less record on a mixed log proves nothing", () => {
	const RELEASE: readonly LogRecord[] = [
		{ sequence: 1, kind: "llm_call", data: callData(100, "tx_one") },
		{ sequence: 2, kind: "llm_call", data: callData(700, "tx_rel") },
		{ sequence: null, kind: "hold_released", data: { transferId: "tx_rel" } },
	];
	const ANSWERED: readonly LogRecord[] = [
		{ sequence: 1, kind: "llm_call", data: callData(100, "tx_one") },
		{
			sequence: null,
			kind: "llm_call",
			data: callData(50, "tx_head", { source: "headless", ledgerPosted: true }),
		},
		{ sequence: 2, kind: "llm_call", data: callData(25, "tx_three") },
	];

	it("a sequence-less hold_released cannot release a sequenced call: the call stays unconfirmed, in the spend", async () => {
		const mixed = await reportJson(projectOf(RELEASE));
		expect(mixed.integrity.verified).toBe(false);
		expect(mixed.totals).toMatchObject({
			releasedCalls: 0,
			unconfirmedCalls: 1,
			unconfirmedUt: 700,
			confirmedUt: 100,
		});
		// control: the same release, sequenced, releases the call
		const sequenced = await reportJson(projectOf(allSequenced(RELEASE)));
		expect(sequenced.integrity.verified).toBe(true);
		expect(sequenced.totals).toMatchObject({
			releasedCalls: 1,
			unconfirmedCalls: 0,
			confirmedUt: 100,
		});
	});

	it("a sequence-less headless call the ledger answered is in the confirmed spend, and no figure is shown as proven", async () => {
		const mixed = await reportJson(projectOf(ANSWERED));
		expect(mixed.proofStatus).toBe("withheld");
		expect(mixed.totals).toMatchObject({
			confirmedUt: 175,
			postProvenUt: 0,
			postProvenCalls: 0,
			postProvenUpperUt: 0,
			postProvenUpperCalls: 0,
		});
		// control: the same calls, sequenced: the headless post is an upper bound, shown
		const sequenced = await reportJson(projectOf(allSequenced(ANSWERED)));
		expect(sequenced.proofStatus).toBe("shown");
		expect(sequenced.totals).toMatchObject({
			confirmedUt: 175,
			postProvenUpperUt: 50,
			postProvenUpperCalls: 1,
		});
	});
});
