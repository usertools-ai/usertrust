import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CHAIN_TAIL_COUNT,
	chainTail,
	type FleetChainEvent,
	formatMeter,
	formatShare,
	formatUsd,
	formatUt,
	isoDay,
	LATEST_RECEIPT_COUNT,
	latestReceipts,
	loadChainEvents,
	loadFleetSummary,
	loadVerifyTranscript,
	parseChainJsonl,
	receiptJson,
	sessionDisplayRows,
	shortHash,
} from "./fleet-lib";

// ---------------------------------------------------------------------------
// Formatters. Every figure on /fleet renders through one of these; the page
// itself contains zero digit literals, so THESE tests are where the display
// contract is pinned.
// ---------------------------------------------------------------------------

test("formatUt: usertokens with thousands separators and the ut suffix", () => {
	assert.equal(formatUt(159), "159 ut");
	assert.equal(formatUt(0), "0 ut");
	assert.equal(formatUt(1234567), "1,234,567 ut");
});

test("formatUsd: always two decimal places, thousands-separated", () => {
	assert.equal(formatUsd(0.0159), "$0.02");
	assert.equal(formatUsd(0), "$0.00");
	assert.equal(formatUsd(3), "$3.00");
	assert.equal(formatUsd(1234.5), "$1,234.50");
});

test("formatMeter: exact with separators below a million, abbreviated above", () => {
	assert.equal(formatMeter(0), "0");
	assert.equal(formatMeter(47), "47");
	assert.equal(formatMeter(5400), "5,400");
	assert.equal(formatMeter(999999), "999,999");
	assert.equal(formatMeter(1200000), "1.2M");
	assert.equal(formatMeter(2000000), "2M");
	assert.equal(formatMeter(3400000000), "3.4B");
	assert.equal(formatMeter(41000000000), "41B");
});

test("formatShare: fraction to percent, one decimal at most, exact ends clean", () => {
	assert.equal(formatShare(0), "0%");
	assert.equal(formatShare(1), "100%");
	assert.equal(formatShare(0.5), "50%");
	assert.equal(formatShare(0.1234), "12.3%");
});

test("isoDay: date part of an ISO timestamp", () => {
	assert.equal(isoDay("2026-08-10T12:00:06.000Z"), "2026-08-10");
});

test("shortHash: twelve-hex prefix with an ellipsis", () => {
	assert.equal(
		shortHash("498c802befef910317eae2e82593187230b8de350a50cdffafbb9629830c6110"),
		"498c802befef…",
	);
});

// ---------------------------------------------------------------------------
// Chain parsing + slicing.
// ---------------------------------------------------------------------------

function event(sequence: number, kind = "llm_call", extra?: Record<string, unknown>): string {
	return JSON.stringify({
		sequence,
		kind,
		hash: `hash-${sequence}`,
		previousHash: `hash-${sequence - 1}`,
		timestamp: `2026-08-10T12:00:0${sequence % 10}.000Z`,
		actor: "local",
		id: `id-${sequence}`,
		data: {
			costCenter: `fleet.aaaaaaaaaaaa.msg_${sequence}`,
			model: "claude-opus-5",
			cost: sequence,
			usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
			appliedRates: { inputPer1k: 50, outputPer1k: 250, cacheReadPer1k: 5, cacheWritePer1k: 62.5 },
			rateSource: "table",
			pricingTableVersion: "2026-08-10",
			usageSource: "provider",
			...extra,
		},
	});
}

test("parseChainJsonl: orders by sequence, skips blank lines, throws on garbage", () => {
	const text = `${[event(2), "", event(1), event(3)].join("\n")}\n`;
	const events = parseChainJsonl(text);
	assert.deepEqual(
		events.map((e) => e.sequence),
		[1, 2, 3],
	);
	assert.throws(() => parseChainJsonl('{"sequence": 1, "hash":'), /unparseable/);
	assert.throws(() => parseChainJsonl('{"kind": "llm_call"}'), /hash\/sequence/);
});

test("chainTail: the LAST eight in ingest order (ascending), fewer when short", () => {
	const ten = parseChainJsonl(Array.from({ length: 10 }, (_, i) => event(i + 1)).join("\n"));
	const tail = chainTail(ten);
	assert.equal(CHAIN_TAIL_COUNT, 8);
	assert.equal(tail.length, 8);
	assert.deepEqual(
		tail.map((e) => e.sequence),
		[3, 4, 5, 6, 7, 8, 9, 10],
	);

	const six = parseChainJsonl(Array.from({ length: 6 }, (_, i) => event(i + 1)).join("\n"));
	assert.deepEqual(
		chainTail(six).map((e) => e.sequence),
		[1, 2, 3, 4, 5, 6],
	);
});

test("latestReceipts: three most recent llm_call events, newest first", () => {
	const events = parseChainJsonl(
		[event(1), event(2, "policy_denial"), event(3), event(4), event(5)].join("\n"),
	);
	const latest = latestReceipts(events);
	assert.equal(LATEST_RECEIPT_COUNT, 3);
	assert.deepEqual(
		latest.map((e) => e.sequence),
		[5, 4, 3],
	);
	for (const e of latest) assert.equal(e.kind, "llm_call");
});

// ---------------------------------------------------------------------------
// Receipt JSON — ALLOWLIST rendering. budgetRemaining and receiptUrl must
// never reach the page, even if a future chain event carries them.
// ---------------------------------------------------------------------------

test("receiptJson: allowlisted chained fields only, keyed for display", () => {
	const [e] = parseChainJsonl(event(7));
	const json = receiptJson(e as FleetChainEvent);
	assert.deepEqual(Object.keys(json), [
		"costCenter",
		"model",
		"usage",
		"cost",
		"appliedRates",
		"rateSource",
		"pricingTableVersion",
		"auditHash",
	]);
	assert.equal(json.auditHash, "hash-7");
	assert.equal(json.costCenter, "fleet.aaaaaaaaaaaa.msg_7");
});

test("receiptJson: budgetRemaining/receiptUrl NEVER render, even when present", () => {
	const [e] = parseChainJsonl(
		event(9, "llm_call", { budgetRemaining: 9999999, receiptUrl: "https://usertrust.ai/r/x" }),
	);
	const rendered = JSON.stringify(receiptJson(e as FleetChainEvent));
	assert.ok(!rendered.includes("budgetRemaining"));
	assert.ok(!rendered.includes("receiptUrl"));
	assert.ok(!rendered.includes("/r/"));
});

// ---------------------------------------------------------------------------
// Sessions — the top-N + "other" render model. The rollup already folds; the
// page's job is to show the fold honestly and never restyle it as a session.
// ---------------------------------------------------------------------------

test("sessionDisplayRows: rows pass through in rollup order; only 'other' is flagged", () => {
	const rows = sessionDisplayRows([
		{ sessionHash: "d9dd19e2ebba", calls: 1, usertokens: 62, sidechainShare: 0 },
		{ sessionHash: "e279159a3ffc", calls: 1, usertokens: 39, sidechainShare: 1 },
		{ sessionHash: "other", calls: 12, usertokens: 5, sidechainShare: 0.25 },
	]);
	assert.deepEqual(
		rows.map((r) => r.label),
		["d9dd19e2ebba", "e279159a3ffc", "other"],
	);
	assert.deepEqual(
		rows.map((r) => r.isOther),
		[false, false, true],
	);
	assert.equal(rows[2]?.share, "25%");
});

test("sessionDisplayRows: no synthetic 'other' when the rollup did not fold", () => {
	const rows = sessionDisplayRows([
		{ sessionHash: "eb18cc80abb6", calls: 1, usertokens: 6, sidechainShare: 1 },
	]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]?.isOther, false);
});

// ---------------------------------------------------------------------------
// Loaders — the committed artifacts under site/public/fleet/ must parse and
// hold together, because the page renders every figure from them.
// ---------------------------------------------------------------------------

test("loadFleetSummary: committed artifact parses with a sane shape", () => {
	const summary = loadFleetSummary();
	assert.match(summary.window.publishedMonth, /^\d{4}-\d{2}$/);
	assert.ok(summary.month.calls > 0);
	assert.ok(summary.byModel.length > 0);
	assert.ok(summary.bySession.length > 0);
	assert.equal(summary.residualCauses.length, 4);
	for (const row of summary.byModel) assert.equal(row.rateSource, "table");
});

test("loadChainEvents: committed chain parses ascending with hashes", () => {
	const events = loadChainEvents();
	assert.ok(events.length > 0);
	for (let i = 1; i < events.length; i++) {
		const prev = events[i - 1];
		const curr = events[i];
		assert.ok(prev && curr && prev.sequence < curr.sequence);
		assert.equal(curr.previousHash, prev.hash);
	}
});

test("loadVerifyTranscript: committed transcript is a passing run", () => {
	const transcript = loadVerifyTranscript();
	assert.equal(transcript.exitCode, 0);
	assert.ok(transcript.lines.length > 0);
	assert.ok(transcript.command.includes("usertrust-verify"));
});
