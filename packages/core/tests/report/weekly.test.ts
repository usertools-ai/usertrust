// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import type { PersistedAuditEvent } from "../../src/audit/read.js";
import { PRICING_TABLE } from "../../src/ledger/pricing.js";
import { parseDeadLetters } from "../../src/report/dead-letters.js";
import { render } from "../../src/report/render.js";
import {
	buildWeeklyReport,
	detectProvider,
	type IntegrityInfo,
	UNATTRIBUTED,
	UNKNOWN_VOID_REASON_PREFIX,
} from "../../src/report/weekly.js";

const END = Date.parse("2026-10-12T00:00:00Z");
const OK: IntegrityInfo = {
	verified: true,
	errors: [],
	chainLength: 0,
	firstEvent: null,
	lastEvent: null,
};
let seq = 0;
function ev(
	kind: string,
	ts: string,
	data: Record<string, unknown>,
	actor = "local",
): PersistedAuditEvent {
	seq += 1;
	return {
		id: `id-${seq}`,
		timestamp: ts,
		previousHash: "p",
		hash: `h${seq}`.padEnd(64, "0"),
		kind,
		actor,
		data,
		sequence: seq,
	};
}
const RATES = { inputPer1k: 100, outputPer1k: 500, cacheReadPer1k: 10, cacheWritePer1k: 125 };
function call(ts: string, cost: number, over: Record<string, unknown> = {}): PersistedAuditEvent {
	return ev("llm_call", ts, {
		model: "claude-sonnet-5-5",
		cost,
		settled: true,
		transferId: `t-${seq + 1}`,
		usageSource: "provider",
		usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
		appliedRates: RATES,
		costBasis: "usd-proxy",
		rateSource: "table",
		endpointClass: "cloud",
		...over,
	});
}
const build = (events: PersistedAuditEvent[], over = {}, integrity: IntegrityInfo = OK) =>
	buildWeeklyReport(events, integrity, { endMs: END, ...over });

describe("weekly report model", () => {
	it("sums confirmed spend, and the by-agent and by-model rows reconcile to it exactly", () => {
		const m = build([
			call("2026-10-06T01:00:00Z", 100, { costCenter: "a.1" }),
			call("2026-10-07T01:00:00Z", 250, { costCenter: "b.1", model: "gpt-5" }),
			call("2026-10-08T01:00:00Z", 50),
		]);
		expect(m.totals.confirmedUt).toBe(400);
		expect(m.byAgent.reduce((s, r) => s + r.ut, 0)).toBe(400);
		expect(m.byModel.reduce((s, r) => s + r.ut, 0)).toBe(400);
		expect(m.hourlyUt.reduce((s, v) => s + v, 0)).toBe(400);
		expect(m.byAgent.map((r) => r.key)).toEqual(["b.1", "a.1", UNATTRIBUTED]);
		expect(m.byModel.map((r) => [r.key, r.provider])).toEqual([
			["gpt-5", "openai"],
			["claude-sonnet-5-5", "anthropic"],
		]);
	});

	it("the window is half-open: start included, end excluded, outside ignored", () => {
		const m = build([
			call("2026-10-05T00:00:00Z", 1), // exactly the start (end - 7d): included
			call("2026-10-04T23:59:59.999Z", 10), // just before: out
			call("2026-10-11T23:59:59.999Z", 100), // last millisecond: in
			call("2026-10-12T00:00:00Z", 1000), // exactly the end: out
		]);
		expect(m.totals.confirmedUt).toBe(101);
		expect(m.totals.confirmedCalls).toBe(2);
	});

	it("an AMBIGUOUS settle is UNCONFIRMED: shown, never counted as spent, wherever the ambiguity was recorded", () => {
		const ambiguous = call("2026-10-08T00:00:00Z", 700, { transferId: "t-amb" });
		const m = build([
			call("2026-10-08T01:00:00Z", 100),
			ambiguous,
			// the correction can land outside (after) the window of the call it corrects
			ev("settlement_ambiguous", "2026-10-13T00:00:00Z", { transferId: "t-amb", cost: 700 }),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.unconfirmedUt).toBe(700);
		expect(m.totals.unconfirmedCalls).toBe(1);
		expect(m.totals.contradictedCalls).toBe(1);
		expect(m.notes.join(" ")).toMatch(/unconfirmed/);
		// the governors COUNTED the ambiguous call (their counter adds before/at the POST attempt): the budget mirrors it
		expect(m.budget.recordedSessionUt).toBe(100 + 700);
	});

	it("a chain that did not verify marks the model UNVERIFIED and says so first in the notes", () => {
		const m = build(
			[call("2026-10-08T01:00:00Z", 5)],
			{},
			{
				...OK,
				verified: false,
				errors: ["hash mismatch at 3"],
			},
		);
		expect(m.integrity.verified).toBe(false);
		expect(m.notes[0]).toMatch(/did NOT verify/);
	});

	it("nominal-denominated rows are unit counts: counted, excluded from dollar totals", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100),
			call("2026-10-08T02:00:00Z", 1, { endpointClass: "local", costBasis: "nominal" }),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.nominalCalls).toBe(1);
		expect(m.totals.nominalUt).toBe(1);
	});

	it("classification is by recorded DENOMINATION: a GPU-amortized local call (usd-proxy) IS dollars", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100, { endpointClass: "local", costBasis: "usd-proxy" }),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.nominalCalls).toBe(0);
	});

	it("a row with NO costBasis (headless) is counted as dollars but reported as unlabelled; unlabelled + local is nominal", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100, { costBasis: undefined, rateSource: undefined }),
			call("2026-10-08T02:00:00Z", 7, { costBasis: undefined, endpointClass: "local" }),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.unlabelledUt).toBe(100);
		expect(m.totals.unlabelledCalls).toBe(1);
		expect(m.totals.nominalUt).toBe(7);
		expect(m.notes.join(" ")).toMatch(/no cost basis/);
	});

	it("an explicit settled:false is UNCONFIRMED on its own, with no correction event", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100),
			call("2026-10-08T02:00:00Z", 40, { settled: false }),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.unconfirmedUt).toBe(40);
		expect(m.totals.unsettledCalls).toBe(1);
		// a settle marked unsettled with nothing else: the chain cannot say whether the counter added it
		expect(m.budget.recordedSessionUt).toBe(100);
		expect(m.budget.recordedSessionUncertain).toBe(40);
	});

	it("malformed ROWS are skipped and counted, never a crash", () => {
		const good = call("2026-10-08T01:00:00Z", 10);
		const rows = [
			good,
			{ ...good, data: null },
			{ ...good, data: undefined },
			{ ...good, data: [] },
			{ ...good, kind: undefined },
			{ ...good, timestamp: undefined },
			null,
			"junk",
		] as unknown as PersistedAuditEvent[];
		let m: ReturnType<typeof build> | undefined;
		expect(() => {
			m = build(rows);
		}).not.toThrow();
		expect(m?.totals.confirmedUt).toBe(10);
		expect(m?.totals.malformedEvents).toBe(7);
		expect(m?.notes.join(" ")).toMatch(/not readable events/);
	});

	it("estimated rows are confirmed spend flagged as estimates, with no token split", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 40, { usageSource: "estimated", usage: undefined }),
			call("2026-10-08T02:00:00Z", 60),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.estimatedUt).toBe(40);
		expect(m.tiers.calls).toBe(1);
		expect(m.notes.join(" ")).toMatch(/ESTIMATE/);
	});

	it("the tier split uses the applied rates, reports cache-write as a share, and shows its own rounding", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 900, {
				usage: {
					inputTokens: 1000,
					outputTokens: 200,
					cacheReadTokens: 10_000,
					cacheWriteTokens: 4000,
				},
			}),
		]);
		// 1000*100/1000 + 200*500/1000 + 10000*10/1000 + 4000*125/1000
		expect(m.tiers.inputUt).toBe(100);
		expect(m.tiers.outputUt).toBe(100);
		expect(m.tiers.cacheReadUt).toBe(100);
		expect(m.tiers.cacheWriteUt).toBe(500);
		expect(m.tiers.cacheWriteShare).toBeCloseTo(500 / 800);
		expect(m.tiers.roundingUt).toBe(800 - 900);
	});

	it("an ABSENT cache rate prices at the input rate, as the ledger does", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 1, {
				appliedRates: { inputPer1k: 100, outputPer1k: 500 },
				usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 1000 },
			}),
		]);
		expect(m.tiers.cacheReadUt).toBe(100);
		expect(m.tiers.cacheWriteUt).toBe(100);
	});

	it("malformed rows are counted and in no figure; NaN/negative costs never reach a sum", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 10),
			call("2026-10-08T01:00:00Z", Number.NaN),
			call("2026-10-08T01:00:00Z", -5),
			call("not-a-time", 99),
		]);
		expect(m.totals.confirmedUt).toBe(10);
		expect(m.totals.malformedCalls).toBe(3);
	});

	it("budget status: configured vs RECORDED session spend over the whole chain; none configured is not 100% remaining", () => {
		const events = [call("2026-09-01T00:00:00Z", 300), call("2026-10-08T01:00:00Z", 100)];
		const none = build(events, { budget: 0 });
		expect(none.budget.configuredUt).toBeNull();
		expect(none.budget.usedFraction).toBeNull();
		const some = build(events, { budget: 1000, budgetSource: "--budget" });
		expect(some.budget).toMatchObject({
			configuredUt: 1000,
			source: "--budget",
			windowSessionUt: 100,
			recordedSessionUt: 400,
			usedFraction: 0.4,
			overBudget: false,
		});
		expect(build(events, { budget: 300 }).budget).toMatchObject({
			usedFraction: 1,
			overBudget: true,
		});
	});

	it("budget utilization includes GOVERNED ACTIONS, in or out of the window, and nominal units that debit the wallet", () => {
		const events = [
			call("2026-10-08T01:00:00Z", 100),
			ev("tool_call", "2026-10-08T02:00:00Z", { actionName: "search", cost: 30, transferId: "a1" }),
			ev("tool_call", "2026-08-01T02:00:00Z", {
				actionName: "search",
				cost: 500,
				transferId: "a2",
			}), // far outside the window
			call("2026-10-08T03:00:00Z", 1, { endpointClass: "local", costBasis: "nominal" }),
		];
		const m = build(events, { budget: 10_000 });
		expect(m.budget.recordedSessionUt).toBe(100 + 30 + 500);
		expect(m.budget.windowSessionUt).toBe(100 + 30);
		// the local call debited UNITS: kept in its own accumulator, never summed with the dollar figure
		expect(m.budget.recordedSessionNominal).toBe(1);
		expect(m.budget.windowSessionNominal).toBe(1);
	});

	it("a mixed window keeps session and attributed totals apart per denomination", () => {
		const m = build(
			[
				call("2026-10-08T01:00:00Z", 100),
				call("2026-10-08T02:00:00Z", 7, { endpointClass: "local", costBasis: "nominal" }),
				call("2026-10-08T03:00:00Z", 900, { costCenter: "team-a" }),
				call("2026-10-08T04:00:00Z", 11, {
					costCenter: "team-a",
					endpointClass: "local",
					costBasis: "nominal",
				}),
			],
			{ budget: 10_000 },
		);
		expect(m.budget.recordedSessionUt).toBe(100);
		expect(m.budget.recordedSessionNominal).toBe(7);
		expect(m.budget.recordedAttributedUt).toBe(900);
		expect(m.budget.recordedAttributedNominal).toBe(11);
		expect(m.totals.confirmedUt).toBe(1000);
		expect(m.totals.nominalUt).toBe(18);
	});

	it("spend WITH a cost center is ATTRIBUTED, payer not recorded: it bounds the budget instead of being assumed away", () => {
		const events = [
			call("2026-10-08T01:00:00Z", 100), // no cost center: debited the session wallet
			call("2026-10-08T02:00:00Z", 900, { costCenter: "team-a" }), // payer not recorded
			ev("tool_call", "2026-10-08T03:00:00Z", {
				actionName: "x",
				cost: 50,
				costCenter: "team-a",
				transferId: "a",
			}),
		];
		const m = build(events, { budget: 1000 });
		expect(m.budget.recordedSessionUt).toBe(100);
		expect(m.budget.recordedAttributedUt).toBe(950);
		expect(m.budget.windowAttributedUt).toBe(950);
		expect(m.budget.usedFraction).toBe(0.1); // the lower bound: only what provably debited the session
		expect(m.budget.usedFractionUpper).toBe(1); // clamped: if the session paid for all of it
		expect(m.budget.overBudget).toBe(false);
		expect(m.budget.possiblyOverBudget).toBe(true);
		expect(m.notes.join(" ")).toMatch(/payer|envelope or the session/);
	});

	it("a dry-run call attributed to a cost center is NOT read as 0% used: the upper bound shows it (a label is not a payer)", () => {
		const m = build([call("2026-10-08T01:00:00Z", 400, { costCenter: "team-a" })], {
			budget: 1000,
		});
		expect(m.budget.usedFraction).toBe(0);
		expect(m.budget.usedFractionUpper).toBe(0.4);
		expect(m.budget.possiblyOverBudget).toBe(false);
	});

	it("llm_call_failed beside an llm_call is UNCONFIRMED: shown, never dropped, never counted as spent", () => {
		const m = build(
			[
				call("2026-10-08T01:00:00Z", 100),
				call("2026-10-08T02:00:00Z", 700, { transferId: "t-fail" }),
				ev("llm_call_failed", "2026-10-08T02:00:01Z", {
					transferId: "t-fail",
					error: "audit unavailable",
				}),
				ev("tool_call", "2026-10-08T03:00:00Z", {
					actionName: "x",
					cost: 40,
					transferId: "t-fail",
				}),
			],
			{ budget: 1000 },
		);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.unconfirmedCalls).toBe(1);
		expect(m.totals.unconfirmedUt).toBe(700);
		// a settled call that a void marker contradicts, with no post evidence: UNCERTAIN, in the upper bound only
		expect(m.budget.recordedSessionUt).toBe(100);
		expect(m.budget.recordedSessionUncertain).toBe(700 + 0);
		expect(m.totals.actionUt).toBe(0);
		expect(m.totals.unconfirmedActionCalls).toBe(1);
		expect(m.totals.unconfirmedActionUt).toBe(40);
	});

	it("a failed-action marker is unconfirmed, and never itself a governed action", () => {
		const m = build([
			ev("tool_call", "2026-10-08T03:00:00Z", { actionName: "x", cost: 40, transferId: "t-a" }),
			ev("tool_call_failed", "2026-10-08T03:00:01Z", {
				actionName: "x",
				cost: 40,
				transferId: "t-a",
			}),
		]);
		expect(m.totals.actionUt).toBe(0);
		expect(m.totals.unconfirmedActionCalls).toBe(1);
	});

	it("a hold_released beside a call is proven not charged: in no figure", () => {
		const m = build([
			call("2026-10-08T02:00:00Z", 700, { transferId: "t-rel" }),
			ev("hold_released", "2026-10-08T02:00:01Z", { transferId: "t-rel" }),
		]);
		expect(m.totals.confirmedUt).toBe(0);
		expect(m.totals.unconfirmedCalls).toBe(0);
		expect(m.totals.releasedCalls).toBe(1);
	});

	it("a settlement_ambiguous with no call of its own is counted as unconfirmed spend", () => {
		const m = build([
			ev("settlement_ambiguous", "2026-10-08T02:00:00Z", {
				transferId: "t-solo",
				cost: 300,
				costBasis: "usd-proxy",
			}),
			// no denomination on the record: shown, never assumed to be dollars
			ev("settlement_ambiguous", "2026-10-08T03:00:00Z", { transferId: "t-solo2", cost: 50 }),
		]);
		expect(m.totals.unconfirmedUt).toBe(300);
		expect(m.totals.unconfirmedUnlabelledUt).toBe(50);
		expect(m.totals.unconfirmedUnlabelledCalls).toBe(1);
		expect(m.totals.unconfirmedCalls).toBe(2);
	});

	it("a DRY-RUN headless record (settled: true, no ledgerPosted) is confirmed but not ledger-proven", () => {
		const m = build(
			[
				call("2026-10-08T01:00:00Z", 45, { transferId: "t-dry", source: "headless" }),
				call("2026-10-08T02:00:00Z", 55, {
					transferId: "t-real",
					source: "headless",
					ledgerPosted: true,
				}),
			],
			{ deadLetters: { shortfalls: new Map() } },
		);
		expect(m.totals.confirmedUt).toBe(100);
		// no shortfall record: an upper bound, never an exact proven figure
		expect(m.totals.postProvenUt).toBe(0);
		expect(m.totals.postProvenUpperUt).toBe(55);
		expect(m.totals.postProvenUpperCalls).toBe(1);
	});

	it("the proven subtotal sums what the ledger POSTED, not the metered cost", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100, { transferId: "t-cap" }),
			ev("settlement_shortfall", "2026-10-08T01:00:01Z", {
				transferId: "t-cap",
				actual: 100,
				posted: 60,
				shortfall: 40,
			}),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.postProvenUt).toBe(60);
	});

	it("a warn-mode injection_detected beside a charged call does not unconfirm it (call and action)", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100, { transferId: "t-inj" }),
			ev("injection_detected", "2026-10-08T01:00:01Z", { transferId: "t-inj" }),
			ev("tool_call", "2026-10-08T02:00:00Z", { actionName: "x", cost: 7, transferId: "t-inj2" }),
			ev("injection_detected", "2026-10-08T02:00:01Z", { transferId: "t-inj2" }),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.actionUt).toBe(7);
		expect(m.totals.unconfirmedCalls).toBe(0);
	});

	it("a standalone settlement_ambiguous that names an action goes to the ACTION totals", () => {
		const m = build([
			ev("settlement_ambiguous", "2026-10-08T02:00:00Z", {
				transferId: "t-aa",
				actionKind: "tool_call",
				actionName: "x",
				cost: 321,
			}),
		]);
		expect(m.totals.unconfirmedActionUt).toBe(321);
		expect(m.totals.unconfirmedActionCalls).toBe(1);
		expect(m.totals.unconfirmedUt).toBe(0);
		expect(m.totals.unconfirmedCalls).toBe(0);
	});

	it("a release beside a proven post, or with a failed or unknown void, is unconfirmed, not 'released'", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 10, {
				transferId: "t-a",
				source: "headless",
				ledgerPosted: true,
			}),
			ev("hold_released", "2026-10-08T01:00:01Z", { transferId: "t-a" }),
			call("2026-10-08T02:00:00Z", 20, { transferId: "t-b" }),
			ev("hold_released", "2026-10-08T02:00:01Z", { transferId: "t-b", voidError: "x" }),
			call("2026-10-08T03:00:00Z", 30, { transferId: "t-c" }),
			ev("hold_released", "2026-10-08T03:00:01Z", {
				transferId: "t-c",
				reason: `${UNKNOWN_VOID_REASON_PREFIX}: its void had not completed)`,
			}),
			call("2026-10-08T04:00:00Z", 40, { transferId: "t-d" }),
			ev("hold_released", "2026-10-08T04:00:01Z", { transferId: "t-d" }),
		]);
		expect(m.totals.releasedCalls).toBe(1);
		expect(m.totals.unconfirmedCalls).toBe(3);
		expect(m.totals.confirmedUt).toBe(0);
	});

	it("two llm_call records for one transfer cannot both be the charge", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100, { transferId: "t-dup" }),
			call("2026-10-08T01:00:05Z", 100, { transferId: "t-dup" }),
		]);
		expect(m.totals.confirmedUt).toBe(0);
		expect(m.totals.unconfirmedCalls).toBe(2);
	});

	it("a headless LOCAL call that records its denomination is nominal, never dollars; an older record with none is labelled", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 10, {
				transferId: "t-l",
				source: "headless",
				costBasis: "nominal",
				endpointClass: "local",
			}),
			call("2026-10-08T02:00:00Z", 20, {
				transferId: "t-o",
				source: "headless",
				costBasis: undefined,
			}),
		]);
		expect(m.totals.nominalCalls).toBe(1);
		expect(m.totals.confirmedUt).toBe(20);
		expect(m.totals.unlabelledUt).toBe(20);
		expect(m.totals.unlabelledCalls).toBe(1);
	});

	it("budget uses the metered spend when a settlement was capped, and a note says what the ledger posted", () => {
		const m = build(
			[
				call("2026-10-08T01:00:00Z", 100, { transferId: "t-cap" }),
				ev("settlement_shortfall", "2026-10-08T01:00:01Z", {
					transferId: "t-cap",
					actual: 100,
					posted: 60,
					shortfall: 40,
				}),
			],
			{ budget: 1000 },
		);
		expect(m.budget.recordedSessionUt).toBe(100);
		expect(m.notes.join(" ")).toMatch(/capped at the ledger hold/);
	});

	it("governAction({ kind: 'llm_call' }) is an ACTION, not an unknown-model call: keyed on actionName", () => {
		const m = build([
			ev("llm_call", "2026-10-08T02:00:00Z", {
				actionName: "search",
				cost: 40,
				transferId: "t-act",
			}),
			call("2026-10-08T03:00:00Z", 100),
		]);
		expect(m.totals.actionUt).toBe(40);
		expect(m.totals.actionCalls).toBe(1);
		expect(m.totals.confirmedUt).toBe(100); // only the model call is model spend
		expect(m.totals.confirmedCalls).toBe(1);
		expect(m.byModel.map((r) => r.key)).not.toContain("unknown");
	});

	it("a settlement_unrecoverable record is disclosed with its usage and no dollar value, in no spend total", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100),
			ev("settlement_unrecoverable", "2026-10-08T02:00:00Z", {
				transferIdHash: "a".repeat(64),
				usage: { inputTokens: 40, outputTokens: 7, cacheReadTokens: 900, cacheWriteTokens: 3 },
				source: "headless",
			}),
		]);
		expect(m.unrecoverable).toEqual({
			records: 1,
			priorChargeKnown: 0,
			inputTokens: 40,
			outputTokens: 7,
			cacheReadTokens: 900,
			cacheWriteTokens: 3,
		});
		expect(m.totals.confirmedUt).toBe(100); // spend is unchanged
		expect(m.unrecognised).toEqual({}); // it is READ, not "unrecognised"
	});

	it("a record of an invented kind is counted as unrecognised, never dropped", () => {
		const m = build([
			ev("brand_new_kind", "2026-10-08T02:00:00Z", { x: 1 }),
			ev("brand_new_kind", "2026-10-08T03:00:00Z", { x: 2 }),
			ev("another_kind", "2026-10-08T04:00:00Z", {}),
			ev("policy_denied", "2026-10-08T05:00:00Z", {}), // known: governance, not unrecognised
		]);
		expect(m.unrecognised).toEqual({ another_kind: 1, brand_new_kind: 2 });
		expect(m.totals.confirmedUt).toBe(0);
	});

	it("ONE RULE: a record that only qualifies a call, with no spend record for its transfer, is disclosed as a record without its call", () => {
		const m = build([
			// a capped post succeeded but the llm_call append failed: the shortfall is the only trace of the charge
			ev("settlement_shortfall", "2026-10-08T01:00:00Z", {
				transferId: "t-s",
				actual: 100,
				posted: 60,
				shortfall: 40,
			}),
			ev("llm_call_failed", "2026-10-08T02:00:00Z", { transferId: "t-f", cost: 7, error: "x" }),
			ev("tool_call_failed", "2026-10-08T03:00:00Z", {
				transferId: "t-g",
				actionName: "x",
				cost: 9,
			}),
			ev("usage_implausible", "2026-10-08T04:00:00Z", { transferId: "t-u" }),
			// beside its call: NOT an orphan
			call("2026-10-08T05:00:00Z", 100, { transferId: "t-ok" }),
			ev("settlement_shortfall", "2026-10-08T05:00:01Z", {
				transferId: "t-ok",
				posted: 80,
				shortfall: 20,
			}),
		]);
		expect(m.withoutCall["settlement_shortfall"]).toEqual({ records: 1, amount: 60 });
		expect(m.withoutCall["llm_call_failed"]).toEqual({ records: 1, amount: 7 });
		expect(m.withoutCall["tool_call_failed"]).toEqual({ records: 1, amount: 9 });
		expect(m.withoutCall["usage_implausible"]).toEqual({ records: 1, amount: 0 });
		expect(m.chargedUnrecorded).toEqual({ records: 1, posted: 60 });
		// never in a spend figure
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.actionUt).toBe(0);
	});

	it("budget_allocated and budget_reclaimed are known (deliberately not read), so an envelope vault does not list them as unrecognised", () => {
		const m = build([
			ev("budget_allocated", "2026-10-08T01:00:00Z", { amount: 5 }),
			ev("budget_reclaimed", "2026-10-08T02:00:00Z", { amount: 5 }),
		]);
		expect(m.unrecognised).toEqual({});
	});

	it("an unrecoverable record whose transfer is ALSO charged in the chain is counted as prior-charge-known", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100, { transferId: "t-charged" }),
			ev("settlement_unrecoverable", "2026-10-08T02:00:00Z", {
				transferIdHash: createHash("sha256").update("t-charged").digest("hex"),
				usage: { inputTokens: 1, outputTokens: 1 },
			}),
			ev("settlement_unrecoverable", "2026-10-08T03:00:00Z", {
				transferIdHash: createHash("sha256").update("t-never-seen").digest("hex"),
				usage: { inputTokens: 1, outputTokens: 1 },
			}),
		]);
		expect(m.unrecoverable.records).toBe(2);
		expect(m.unrecoverable.priorChargeKnown).toBe(1);
	});

	it("records without their call are capped at 50 kinds plus '(more kinds)'", () => {
		const events: PersistedAuditEvent[] = [];
		for (let i = 0; i < 80; i++) {
			events.push(
				ev(`kind_${i}_failed`, "2026-10-08T01:00:00Z", { transferId: `t-${i}`, cost: 1 }),
			);
		}
		const m = build(events);
		expect(Object.keys(m.withoutCall)).toHaveLength(51);
		expect(m.withoutCall["(more kinds)"]?.records).toBe(30);
	});

	it("the spend-ledger leg: equal to the chain is silent; a difference is flagged, either direction", () => {
		const base = [call("2026-10-08T01:00:00Z", 100)];
		const eq = build(base, { spendLedger: { value: 100 } });
		expect(eq.spendLedger).toMatchObject({ recorded: 100, differs: false, difference: null });
		const low = build(base, { spendLedger: { value: 60 } });
		expect(low.spendLedger).toMatchObject({ differs: true, difference: -40 });
		const high = build(base, { spendLedger: { value: 150 } });
		expect(high.spendLedger).toMatchObject({ differs: true, difference: 50 });
		// attributed spend widens the band: the payer is not recorded
		const att = build([...base, call("2026-10-08T02:00:00Z", 50, { costCenter: "a" })], {
			spendLedger: { value: 150 },
		});
		expect(att.spendLedger.differs).toBe(false);
		expect(build(base, { spendLedger: { unreadable: true } }).spendLedger.unreadable).toBe(true);
		expect(build(base).spendLedger).toMatchObject({ recorded: null, differs: false });
	});

	describe("the bounded mirror: three classes per transfer from a closed evidence set", () => {
		const wallet = (events: PersistedAuditEvent[], opts: Record<string, unknown> = {}) =>
			build(events, { budget: 1000, ...opts }).budget;

		it("post evidence OUTRANKS a failure marker: shortfall, ambiguity or ledgerPosted beside a void is DEBITED", () => {
			for (const evidence of [
				ev("settlement_shortfall", "2026-10-08T01:00:01Z", {
					transferId: "t",
					actual: 100,
					posted: 60,
				}),
				ev("settlement_ambiguous", "2026-10-08T01:00:01Z", { transferId: "t" }),
			]) {
				const b = wallet([
					call("2026-10-08T01:00:00Z", 100, { transferId: "t" }),
					evidence,
					ev("llm_call_failed", "2026-10-08T01:00:02Z", { transferId: "t" }),
				]);
				expect(b.recordedSessionWallet, evidence.kind).toBe(100);
				expect(b.recordedSessionUncertain, evidence.kind).toBe(0);
			}
			const posted = wallet([
				call("2026-10-08T01:00:00Z", 100, {
					transferId: "t",
					ledgerPosted: true,
					source: "headless",
				}),
				ev("llm_call_failed", "2026-10-08T01:00:02Z", { transferId: "t" }),
			]);
			expect(posted.recordedSessionWallet).toBe(100);
		});

		it("a settled call a void or release contradicts, with no post evidence, is UNCERTAIN (upper bound only)", () => {
			for (const marker of ["llm_call_failed", "hold_released"]) {
				const b = wallet([
					call("2026-10-08T01:00:00Z", 100, { transferId: "t" }),
					ev(marker, "2026-10-08T01:00:01Z", { transferId: "t" }),
				]);
				expect(b.recordedSessionWallet, marker).toBe(0);
				expect(b.recordedSessionUncertain, marker).toBe(100);
				expect(b.uncertainTransfers, marker).toBe(1);
			}
		});

		it("a void or a release alone is NOT DEBITED: nothing counted", () => {
			for (const marker of ["llm_call_failed", "hold_released"]) {
				const b = wallet([ev(marker, "2026-10-08T01:00:01Z", { transferId: "t", cost: 50 })]);
				expect(b.recordedSessionWallet, marker).toBe(0);
				expect(b.recordedSessionUncertain, marker).toBe(0);
			}
		});

		it("a standalone ambiguity is DEBITED with its cost (the governor wrote it after adding)", () => {
			const b = wallet([
				ev("settlement_ambiguous", "2026-10-08T01:00:01Z", { transferId: "t", cost: 32 }),
			]);
			expect(b.recordedSessionWallet).toBe(32);
		});

		it("'prior charge known' (an unrecoverable record) is NOT post evidence for the transfer it names", () => {
			const b = wallet([
				call("2026-10-08T01:00:00Z", 80, { transferId: "t", settled: false }),
				ev("settlement_unrecoverable", "2026-10-08T02:00:00Z", {
					transferIdHash: createHash("sha256").update("t").digest("hex"),
				}),
			]);
			expect(b.recordedSessionWallet).toBe(0);
			expect(b.recordedSessionUncertain).toBe(80);
		});

		it("an orphan shortfall is wallet units of unknown denomination: out of the usd and nominal figures", () => {
			const b = wallet([
				ev("settlement_shortfall", "2026-10-08T01:00:01Z", {
					transferId: "t",
					actual: 90,
					posted: 60,
				}),
			]);
			expect(b.recordedSessionUndenominated).toBe(90);
			expect(b.recordedSessionWallet).toBe(90);
			expect(b.recordedSessionUt).toBe(0);
			expect(b.recordedSessionNominal).toBe(0);
		});

		it("'over budget' is claimed only on the definite figure; 'possibly over' uses the upper bound", () => {
			const events = [
				call("2026-10-08T01:00:00Z", 600, { transferId: "a" }),
				call("2026-10-08T02:00:00Z", 600, { transferId: "b", settled: false }), // uncertain
			];
			const b = build(events, { budget: 1000 }).budget;
			expect(b.overBudget).toBe(false); // definite 600 <= 1000
			expect(b.possiblyOverBudget).toBe(true); // 1200 > 1000 with the uncertain one
			const over = build([call("2026-10-08T01:00:00Z", 1200, { transferId: "a" })], {
				budget: 1000,
			}).budget;
			expect(over.overBudget).toBe(true);
			expect(over.possiblyOverBudget).toBe(false);
		});

		it("the persisted counter is flagged only OUTSIDE [definite, definite + uncertain + attributed]", () => {
			const events = [
				call("2026-10-08T01:00:00Z", 100, { transferId: "a" }),
				call("2026-10-08T02:00:00Z", 40, { transferId: "b", settled: false }), // uncertain
			];
			for (const [value, differs] of [
				[99, true],
				[100, false],
				[140, false],
				[141, true],
			] as const) {
				expect(build(events, { spendLedger: { value } }).spendLedger.differs, String(value)).toBe(
					differs,
				);
			}
		});
	});

	it("an unknown future record kind beside a call unconfirms it by default; shortfall and implausible do not", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100, { transferId: "t-s" }),
			ev("settlement_shortfall", "2026-10-08T01:00:01Z", { transferId: "t-s", shortfall: 5 }),
			ev("usage_implausible", "2026-10-08T01:00:02Z", { transferId: "t-s" }),
			call("2026-10-08T02:00:00Z", 200, { transferId: "t-u" }),
			ev("brand_new_kind", "2026-10-08T02:00:01Z", { transferId: "t-u" }),
			call("2026-10-08T03:00:00Z", 50, { transferId: undefined }),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.postProvenUt).toBe(100);
		expect(m.totals.unconfirmedUt).toBe(250);
		expect(m.totals.uncorrelatedCalls).toBe(1);
	});

	it("unconfirmed NOMINAL units are counted, never added to the dollar figure", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100),
			call("2026-10-08T02:00:00Z", 55, {
				costBasis: "nominal",
				endpointClass: "local",
				settled: false,
			}),
			call("2026-10-08T03:00:00Z", 60, { costBasis: "nominal", transferId: "t-amb-n" }),
			ev("settlement_ambiguous", "2026-10-08T03:00:01Z", { transferId: "t-amb-n" }),
		]);
		expect(m.totals.unconfirmedUt).toBe(0);
		expect(m.totals.unconfirmedCalls).toBe(2);
		expect(m.totals.unconfirmedNominalCalls).toBe(2);
	});

	it("a malformed hash or id never crashes the render: top costs normalise them", () => {
		const bad = call("2026-10-08T01:00:00Z", 50) as unknown as Record<string, unknown>;
		bad["hash"] = undefined;
		bad["id"] = 7;
		const m = build([bad as unknown as PersistedAuditEvent, call("2026-10-08T02:00:00Z", 50)]);
		expect(m.topCosts).toHaveLength(2);
		expect(m.topCosts.every((c) => typeof c.hash === "string" && typeof c.id === "string")).toBe(
			true,
		);
	});

	it("an ambiguous or settled:false governed action IS counted in the budget (the governor's counter added it) but not in confirmed spend", () => {
		const events = [
			ev("tool_call", "2026-10-08T02:00:00Z", { actionName: "x", cost: 50, transferId: "amb" }),
			ev("settlement_ambiguous", "2026-10-08T02:00:01Z", { transferId: "amb" }),
			ev("tool_call", "2026-10-08T03:00:00Z", {
				actionName: "y",
				cost: 70,
				settled: false,
				transferId: "u",
			}),
		];
		const m = build(events, { budget: 1000 });
		expect(m.budget.recordedSessionUt).toBe(50); // the ambiguity is positive evidence the counter added it
		expect(m.budget.recordedSessionUncertain).toBe(70); // settled:false with nothing else is not
		expect(m.totals.actionUt).toBe(0);
	});

	it("the 1-hour cache-write tier is priced at its OWN rate and shown, not folded into 'rounding'", () => {
		// 10,000 one-hour writes at 200/1k = 2,000 UT; at the 5-minute rate (125) it would be 1,250
		const m = build([
			call("2026-10-08T01:00:00Z", 2000, {
				usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10_000 },
				cacheWrite1h: { tokens: 10_000, ratePer1k: 200 },
			}),
		]);
		expect(m.tiers.cacheWriteTokens).toBe(10_000);
		expect(m.tiers.cacheWrite1hTokens).toBe(10_000);
		expect(m.tiers.cacheWriteUt).toBe(2000);
		expect(m.tiers.cacheWrite1hUt).toBe(2000);
		expect(m.tiers.roundingUt).toBe(0);
	});

	it("a mixed write splits: the 5-minute remainder at the 5-minute rate, the 1-hour tokens at theirs", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 1250 + 400, {
				usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 12_000 },
				cacheWrite1h: { tokens: 2000, ratePer1k: 200 },
			}),
		]);
		// (12000-2000)*125/1000 + 2000*200/1000 = 1250 + 400
		expect(m.tiers.cacheWriteUt).toBe(1650);
		expect(m.tiers.cacheWrite1hUt).toBe(400);
	});

	it("a 1-hour share larger than the write total is clamped, never a negative remainder", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 10, {
				usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 100 },
				cacheWrite1h: { tokens: 99_999, ratePer1k: 200 },
			}),
		]);
		expect(m.tiers.cacheWrite1hTokens).toBe(100);
		expect(m.tiers.cacheWriteUt).toBe(20);
	});

	it("providers: o4 models are OpenAI", async () => {
		const { detectProvider } = await import("../../src/report/weekly.js");
		expect(detectProvider("o4-mini")).toBe("openai");
		expect(detectProvider("o3")).toBe("openai");
		expect(detectProvider("ollama-x")).toBe("unknown");
	});

	it("shortfall is reported separately and never changes spend", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100, { transferId: "t-s" }),
			ev("settlement_shortfall", "2026-10-08T01:00:01Z", {
				transferId: "t-s",
				actual: 100,
				posted: 60,
				shortfall: 40,
			}),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.shortfall).toEqual({ events: 1, ut: 40 });
	});

	it("governed actions are their own line, and denials are COUNTED with no dollar value", () => {
		const m = build([
			ev("tool_call", "2026-10-08T01:00:00Z", { actionName: "search", cost: 30, transferId: "a1" }),
			ev("policy_denied", "2026-10-08T02:00:00Z", { cost: 99999 }),
			ev("hold_released", "2026-10-08T03:00:00Z", {}),
			call("2026-10-08T04:00:00Z", 100),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.actionUt).toBe(30);
		expect(m.totals.actionCalls).toBe(1);
		expect(m.governance["policy_denied"]).toBe(1);
		expect(m.governance["hold_released"]).toBe(1);
	});

	describe("the agent dimension", () => {
		const principal = { id: "builder-7", type: "main", origin: "claude-code:s1", unit: "platform" };
		it("auto: cost center first, then principal.id, else ONE unattributed row (never the actor 'local')", () => {
			const m = build([
				call("2026-10-08T01:00:00Z", 10, { costCenter: "fleet.s1.m1" }),
				call("2026-10-08T02:00:00Z", 20, { principal }),
				call("2026-10-08T03:00:00Z", 40),
			]);
			expect(Object.fromEntries(m.byAgent.map((r) => [r.key, r.ut]))).toEqual({
				[UNATTRIBUTED]: 40,
				"builder-7": 20,
				"fleet.s1.m1": 10,
			});
		});
		it("a cost-center segment groups a family of cost centers; a missing segment is unattributed", () => {
			const m = build(
				[
					call("2026-10-08T01:00:00Z", 10, { costCenter: "fleet.s1.m1" }),
					call("2026-10-08T02:00:00Z", 20, { costCenter: "fleet.s1.m2" }),
					call("2026-10-08T03:00:00Z", 40, { costCenter: "solo" }),
				],
				{ agentKey: "cost-center", segment: 1 },
			);
			expect(Object.fromEntries(m.byAgent.map((r) => [r.key, r.ut]))).toEqual({
				s1: 30,
				[UNATTRIBUTED]: 40,
			});
		});
		it("explicit keys read principal fields; actor 'local' is unattributed", () => {
			const events = [
				call("2026-10-08T01:00:00Z", 10, { principal }),
				call("2026-10-08T02:00:00Z", 5),
			];
			expect(build(events, { agentKey: "principal.unit" }).byAgent.map((r) => r.key)).toEqual([
				"platform",
				UNATTRIBUTED,
			]);
			expect(build(events, { agentKey: "actor" }).byAgent.map((r) => r.key)).toEqual([
				UNATTRIBUTED,
			]);
		});
	});

	it("by session: principal.origin groups a client's calls, and is empty when no call records one", () => {
		const origin = (o: string) => ({ principal: { id: "main", origin: o } });
		const m = build([
			call("2026-10-08T01:00:00Z", 10, origin("claude-code:s1")),
			call("2026-10-08T02:00:00Z", 30, origin("claude-code:s1")),
			call("2026-10-08T03:00:00Z", 5, origin("claude-code:s2")),
			call("2026-10-08T04:00:00Z", 2),
		]);
		expect(Object.fromEntries(m.bySession.map((r) => [r.key, r.ut]))).toEqual({
			"claude-code:s1": 40,
			"claude-code:s2": 5,
		});
		expect(build([call("2026-10-08T01:00:00Z", 10)]).bySession).toEqual([]);
	});

	it("a call with neither cost basis nor rate source says 'not recorded', not an invented label", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 10, { costBasis: undefined, rateSource: undefined }),
		]);
		expect(m.byModel[0]?.costBasis).toEqual(["not recorded"]);
	});

	it("top costs: ordered, capped, and each names the chain hash that locates the event", () => {
		const events = [5, 90, 40, 70].map((c, i) => call(`2026-10-08T0${i}:00:00Z`, c));
		const m = build(events, { topN: 2 });
		expect(m.topCosts.map((c) => c.ut)).toEqual([90, 70]);
		expect(m.topCosts[0]?.hash).toMatch(/^h\d+0+$/);
	});
});

describe("the unknown-void release reason is still the one headless writes", () => {
	it("headless.ts carries the prefix the report matches", () => {
		const src = readFileSync(join(import.meta.dirname, "../../src/headless.ts"), "utf-8");
		expect(src).toContain(UNKNOWN_VOID_REASON_PREFIX);
	});
});

describe("every built-in pricing entry has a vendor family", () => {
	it("no model in the pricing table is labelled 'unknown' (a model added tomorrow cannot regress silently)", () => {
		const unlabelled = Object.keys(PRICING_TABLE).filter((m) => detectProvider(m) === "unknown");
		expect(unlabelled).toEqual([]);
	});

	it("spot checks the families the report used to print as unknown", () => {
		expect(detectProvider("kimi-k3")).toBe("moonshot");
		expect(detectProvider("deepseek-chat")).toBe("deepseek");
		expect(detectProvider("grok-3")).toBe("xai");
		expect(detectProvider("totally-new-model")).toBe("unknown");
	});
});

describe("one classifier: standing and prior-charge both follow the per-transfer evidence", () => {
	const T = "2026-10-08T01:00:00Z";
	const hash = (t: string) => createHash("sha256").update(t).digest("hex");
	const unrecoverable = (t: string) =>
		ev("settlement_unrecoverable", "2026-10-08T02:00:00Z", {
			transferIdHash: hash(t),
			usage: { inputTokens: 1, outputTokens: 1 },
		});

	it("a capped post followed by a post-commit failure marker stays CONFIRMED spend (post outranks failure)", () => {
		const m = build([
			call(T, 100, { transferId: "t" }),
			ev("settlement_shortfall", T, { transferId: "t", actual: 100, posted: 60, shortfall: 40 }),
			ev("llm_call_failed", T, { transferId: "t", error: "audit degraded" }),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.postProvenUt).toBe(60);
		expect(m.totals.contradictedCalls).toBe(0);
		expect(m.shortfall).toEqual({ events: 1, ut: 40 });
	});

	it("the same failure marker with NO post evidence still contradicts the call", () => {
		const m = build([
			call(T, 100, { transferId: "t" }),
			ev("llm_call_failed", T, { transferId: "t", error: "boom" }),
		]);
		expect(m.totals.confirmedUt).toBe(0);
		expect(m.totals.contradictedCalls).toBe(1);
	});

	it("prior-charge-known needs the charge evidenced: a settled:false call, or an ambiguous one, is not 'already charged'", () => {
		for (const [name, events] of [
			["settled:false", [call(T, 80, { transferId: "t", settled: false })]],
			[
				"ambiguous",
				[
					call(T, 80, { transferId: "t" }),
					ev("settlement_ambiguous", T, { transferId: "t", cost: 80 }),
				],
			],
		] as const) {
			const m = build([...events, unrecoverable("t")]);
			expect(m.unrecoverable.records, name).toBe(1);
			expect(m.unrecoverable.priorChargeKnown, name).toBe(0);
		}
	});

	it("prior-charge-known still counts a settled call and a capped post", () => {
		const m = build([
			call(T, 80, { transferId: "a" }),
			call(T, 80, { transferId: "b" }),
			ev("settlement_shortfall", T, { transferId: "b", actual: 80, posted: 50, shortfall: 30 }),
			unrecoverable("a"),
			unrecoverable("b"),
		]);
		expect(m.unrecoverable.priorChargeKnown).toBe(2);
	});

	it("the renderer never says 'already charged' for an uncharged-or-unknown transfer", () => {
		const m = build([call(T, 80, { transferId: "t", settled: false }), unrecoverable("t")]);
		expect(render(m, "md")).not.toContain("already charged");
	});
});

describe("undenominated wallet units are carried like the other denominations", () => {
	const IN_WEEK = "2026-10-08T01:00:00Z";
	const BEFORE = "2026-09-01T01:00:00Z";

	it("an orphan shortfall INSIDE the week is in 'This week', and one outside the week only in the total", () => {
		const m = build([
			ev("settlement_shortfall", IN_WEEK, { transferId: "in", actual: 90, posted: 60 }),
			ev("settlement_shortfall", BEFORE, { transferId: "out", actual: 40, posted: 30 }),
		]).budget;
		expect(m.recordedSessionUndenominated).toBe(130);
		expect(m.windowSessionUndenominated).toBe(90);
		expect(m.windowSessionWallet).toBe(90);
		expect(m.windowSessionUt).toBe(0);
	});

	it("a standalone ambiguity with no denomination is undenominated, out of the usd-priced figure", () => {
		const b = build([ev("settlement_ambiguous", IN_WEEK, { transferId: "t", cost: 32 })]).budget;
		expect(b.recordedSessionUndenominated).toBe(32);
		expect(b.windowSessionUndenominated).toBe(32);
		expect(b.recordedSessionUt).toBe(0);
		expect(b.windowSessionUt).toBe(0);
		expect(b.recordedSessionWallet).toBe(32);
	});

	it("a standalone ambiguity that CARRIES its denomination keeps it", () => {
		const b = build([
			ev("settlement_ambiguous", IN_WEEK, { transferId: "t", cost: 32, costBasis: "usd-proxy" }),
		]).budget;
		expect(b.recordedSessionUt).toBe(32);
		expect(b.recordedSessionUndenominated).toBe(0);
	});

	it("an ATTRIBUTED orphan is carried into the attributed wallet, and the rendered split adds up", () => {
		const m = build(
			[
				call(IN_WEEK, 100, { transferId: "a", costCenter: "cc.1" }),
				ev("settlement_shortfall", IN_WEEK, {
					transferId: "b",
					actual: 70,
					posted: 50,
					costCenter: "cc.1",
				}),
			],
			{ budget: 1000 },
		);
		expect(m.budget.recordedAttributedUndenominated).toBe(70);
		expect(m.budget.recordedAttributedWallet).toBe(170);
		expect(m.budget.windowAttributedWallet).toBe(170);
		const text = render(m, "md");
		// the attributed wallet total, with its undenominated part stated beside it
		expect(text).toContain("170 budget units");
		expect(text).toContain("70 budget units of undenominated units");
	});

	it("the 'This week' line states the undenominated part, so its figure adds up", () => {
		const m = build(
			[ev("settlement_shortfall", IN_WEEK, { transferId: "in", actual: 90, posted: 60 })],
			{ budget: 1000 },
		);
		const week = render(m, "md")
			.split("\n")
			.find((l) => l.includes("This week:"));
		expect(week).toContain("of undenominated units");
	});
});

describe("no definite over-budget claim when the governor's counter contradicts the lower bound", () => {
	// A bare non-stream SDK call is recorded BEFORE its budget commit, so after a crash between the two the chain can
	// include a call the counter never added. The lower bound is then not definite.
	const events = () => [call("2026-10-08T01:00:00Z", 1200, { transferId: "a" })];

	it("counter BELOW the lower bound: a range with 'possibly over', neutral wording, never 'OVER BUDGET'", () => {
		const m = build(events(), { budget: 1000, spendLedger: { value: 0 } });
		expect(m.budget.overBudget).toBe(false);
		expect(m.budget.overBudgetDisputed).toBe(true);
		expect(m.budget.possiblyOverBudget).toBe(true);
		const text = render(m, "md");
		expect(text).not.toContain("(OVER BUDGET)");
		expect(text).toContain("POSSIBLY OVER BUDGET");
		expect(text).toContain(
			"The chain and the governor's counter disagree: a crash between an SDK call's audit record and its budget commit, or a counter error.",
		);
		// neutral: it never asserts the counter is wrong
		expect(text).toContain("Either leg may be wrong.");
	});

	it("an AGREEING counter: the definite claim stands", () => {
		const m = build(events(), { budget: 1000, spendLedger: { value: 1200 } });
		expect(m.budget.overBudget).toBe(true);
		expect(m.budget.overBudgetDisputed).toBe(false);
		expect(render(m, "md")).toContain("(OVER BUDGET)");
	});

	it("no counter file, or an unreadable one: nothing contradicts the chain, so the claim stands", () => {
		expect(build(events(), { budget: 1000 }).budget.overBudget).toBe(true);
		expect(
			build(events(), { budget: 1000, spendLedger: { unreadable: true } }).budget.overBudget,
		).toBe(true);
	});

	it("a counter ABOVE the lower bound does not dispute it", () => {
		const m = build(events(), { budget: 1000, spendLedger: { value: 1500 } });
		expect(m.budget.overBudget).toBe(true);
	});
});

describe("an unrecognised sibling kind never leaves a transfer definite (one sibling definition)", () => {
	const T = "2026-10-08T01:00:00Z";

	it("an invented kind beside a settled call puts it in the UNCERTAIN band, not the definite lower bound", () => {
		const m = build([
			call(T, 100, { transferId: "t" }),
			ev("brand_new_kind", T, { transferId: "t" }),
		]);
		expect(m.budget.recordedSessionWallet).toBe(0);
		expect(m.budget.recordedSessionUncertain).toBe(100);
		expect(m.budget.uncertainTransfers).toBe(1);
		// and the spend side agrees: the call is unconfirmed, not confirmed
		expect(m.totals.confirmedUt).toBe(0);
		expect(m.totals.contradictedCalls).toBe(1);
	});

	it("two spend records of one kind for one transfer are uncertain in the budget too", () => {
		const m = build([
			call(T, 100, { transferId: "t" }),
			call("2026-10-08T01:00:05Z", 100, { transferId: "t" }),
		]);
		expect(m.budget.recordedSessionWallet).toBe(0);
		expect(m.budget.recordedSessionUncertain).toBe(100);
	});

	it("post evidence still outranks the unknown sibling", () => {
		const m = build([
			call(T, 100, { transferId: "t" }),
			ev("settlement_shortfall", T, { transferId: "t", actual: 100, posted: 60, shortfall: 40 }),
			ev("brand_new_kind", T, { transferId: "t" }),
		]);
		expect(m.budget.recordedSessionWallet).toBeGreaterThan(0);
	});

	it("a benign sibling (an implausible-usage note) does not disturb a definite call", () => {
		const m = build([
			call(T, 100, { transferId: "t" }),
			ev("usage_implausible", T, { transferId: "t" }),
		]);
		expect(m.budget.recordedSessionWallet).toBe(100);
	});
});

describe("both renderers state the same thing about records without their call", () => {
	it("markdown and html carry the same note: in no dollar figure, but in the budget as undenominated units", () => {
		const m = build(
			[
				ev("settlement_shortfall", "2026-10-08T01:00:00Z", {
					transferId: "o",
					actual: 90,
					posted: 60,
				}),
			],
			{ budget: 1000 },
		);
		for (const format of ["md", "html"] as const) {
			const text = render(m, format);
			expect(text, format).toContain("in no spend (dollar) figure");
			expect(text, format).toContain("counted in the budget section as undenominated wallet units");
			expect(text, format).not.toContain("in no spend or budget figure");
		}
	});
});

describe("a headless post with no shortfall record: exact only with a shortfall record, on the chain or dead-lettered", () => {
	const T = "2026-10-08T01:00:00Z";
	const headless = (cost: number, tid = "t") =>
		call(T, cost, { transferId: tid, source: "headless", ledgerPosted: true });
	const sealed = (payload: Record<string, unknown>, over: Record<string, unknown> = {}) => {
		const entry = { source: "audit.chain.appendEvent", payload, error: "disk full", timestamp: T };
		const checksum = createHash("sha256").update(canonicalize(entry)).digest("hex");
		return JSON.stringify({ ...entry, checksum, checksumAlg: "sha256", ...over });
	};
	const shortfallLetter = (tid: string, posted: number) =>
		sealed({
			kind: "settlement_shortfall",
			actor: "local",
			data: { transferId: tid, actual: 100, posted, shortfall: 100 - posted },
		});

	it("a readable but EMPTY queue proves nothing: the shortfall may not have been appended yet, so it is an upper bound", () => {
		const m = build([headless(100)], { deadLetters: parseDeadLetters("") });
		expect(m.totals.postProvenUt).toBe(0);
		expect(m.totals.postProvenUpperUt).toBe(100);
		expect(m.totals.postProvenUpperCalls).toBe(1);
		expect(render(m, "md")).toContain(
			"this record format cannot tell a capped post from an uncapped one",
		);
	});

	it("a dead-lettered shortfall gives the exact POSTED amount, labelled as read from the queue", () => {
		const m = build([headless(100)], {
			deadLetters: parseDeadLetters(`${shortfallLetter("t", 60)}\n`),
		});
		expect(m.totals.postProvenUt).toBe(60);
		expect(m.totals.postProvenDeadLetterUt).toBe(60);
		expect(m.totals.postProvenDeadLetterCalls).toBe(1);
		expect(m.totals.postProvenUpperCalls).toBe(0);
		const text = render(m, "md");
		expect(text).toContain("read from the dead-letter queue");
		expect(text).toContain("never part of the VERIFIED claim");
	});

	it("an unreadable queue, a bad checksum or an unparseable line leaves only an UPPER bound, never an exact figure", () => {
		const bad = [
			["unreadable", { unreadable: true } as const],
			["bad checksum", parseDeadLetters(sealed({ kind: "other" }, { checksum: "0".repeat(64) }))],
			["not json", parseDeadLetters("{nope\n")],
			["unknown algorithm", parseDeadLetters(sealed({ kind: "other" }, { checksumAlg: "md5" }))],
		] as const;
		for (const [name, deadLetters] of bad) {
			const m = build([headless(100)], { deadLetters });
			expect(m.totals.postProvenUt, name).toBe(0);
			expect(m.totals.postProvenUpperUt, name).toBe(100);
			expect(m.totals.postProvenUpperCalls, name).toBe(1);
			const text = render(m, "md");
			expect(text, name).toContain("up to");
			expect(text, name).toContain("upper bound");
		}
	});

	it("a dead letter the writer sealed with its NaN fallback (JSON.stringify) is READABLE, not a corrupt queue", () => {
		// the writer: canonicalize throws on NaN, so it checksums JSON.stringify(entry), which writes the NaN as null
		const entry = {
			source: "audit.chain.appendEvent",
			payload: { kind: "llm_call", data: { transferId: "x", cost: Number.NaN } },
			error: "disk full",
			timestamp: T,
		};
		const checksum = createHash("sha256").update(JSON.stringify(entry)).digest("hex");
		const line = JSON.stringify({ ...entry, checksum, checksumAlg: "sha256" });
		const parsed = parseDeadLetters(`${line}\n${shortfallLetter("t", 60)}\n`);
		expect("shortfalls" in parsed).toBe(true);
		const m = build([headless(100)], { deadLetters: parsed });
		expect(m.totals.postProvenUt).toBe(60);
	});

	it("a caller that did not read the queue gets the upper bound too (absent is not 'none')", () => {
		const m = build([headless(100)]);
		expect(m.totals.postProvenUt).toBe(0);
		expect(m.totals.postProvenUpperUt).toBe(100);
	});

	it("only a dead-lettered CHAIN append counts: a shortfall-shaped payload from another source leaves an upper bound", () => {
		const foreign = sealed(
			{
				kind: "settlement_shortfall",
				actor: "local",
				data: { transferId: "t", actual: 100, posted: 60, shortfall: 40 },
			},
			{},
		);
		// re-seal under another source (the ledger engine shares the directory)
		const other = (() => {
			const entry = {
				source: "ledger.engine.postSettlement",
				payload: JSON.parse(foreign).payload,
				error: "x",
				timestamp: T,
			};
			const checksum = createHash("sha256").update(canonicalize(entry)).digest("hex");
			return JSON.stringify({ ...entry, checksum, checksumAlg: "sha256" });
		})();
		const m = build([headless(100)], { deadLetters: parseDeadLetters(`${other}\n`) });
		expect(m.totals.postProvenUt).toBe(0);
		expect(m.totals.postProvenUpperUt).toBe(100);
		// the same entry under the chain source is exact
		const m2 = build([headless(100)], { deadLetters: parseDeadLetters(`${foreign}\n`) });
		expect(m2.totals.postProvenUt).toBe(60);
	});

	it("a shortfall record ON THE CHAIN wins over the queue, and stays exact", () => {
		const m = build(
			[
				headless(100),
				ev("settlement_shortfall", T, { transferId: "t", actual: 100, posted: 70, shortfall: 30 }),
			],
			{ deadLetters: parseDeadLetters(`${shortfallLetter("t", 60)}\n`) },
		);
		expect(m.totals.postProvenUt).toBe(70);
		expect(m.totals.postProvenDeadLetterCalls).toBe(0);
	});

	it("an unrelated dead letter is no evidence either way: still an upper bound", () => {
		const m = build([headless(100)], {
			deadLetters: parseDeadLetters(`${sealed({ kind: "llm_call", data: { transferId: "x" } })}\n`),
		});
		expect(m.totals.postProvenUt).toBe(0);
		expect(m.totals.postProvenUpperUt).toBe(100);
	});
});

describe("a headless call that records the amount the ledger posted is exact by construction", () => {
	const T = "2026-10-08T01:00:00Z";
	const headless = (cost: number, over: Record<string, unknown> = {}) =>
		call(T, cost, { transferId: "t", source: "headless", ledgerPosted: true, ...over });

	it("a capped post whose shortfall append was lost is exact at postedAmount, with no queue read", () => {
		const m = build([headless(100, { postedAmount: 60 })]);
		expect(m.totals.postProvenUt).toBe(60);
		expect(m.totals.postProvenUpperCalls).toBe(0);
	});

	it("a full post is exact at the metered cost", () => {
		const m = build([headless(100, { postedAmount: 100 })]);
		expect(m.totals.postProvenUt).toBe(100);
	});

	it("an older record without postedAmount stays an upper bound", () => {
		const m = build([headless(100)]);
		expect(m.totals.postProvenUt).toBe(0);
		expect(m.totals.postProvenUpperUt).toBe(100);
	});
});

describe("an anomaly DETECTION beside a settled call is an annotation, not a contradiction", () => {
	const T = "2026-10-08T01:00:00Z";
	const detection = (tid: string) =>
		ev("anomaly_detected", T, {
			transferId: tid,
			anomalyKind: "velocity",
			model: "claude-sonnet-5-5",
		});

	it("detection + a settled llm_call: confirmed spend and a definite budget debit", () => {
		const m = build([call(T, 100, { transferId: "t" }), detection("t")]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.contradictedCalls).toBe(0);
		expect(m.budget.recordedSessionWallet).toBe(100);
		expect(m.budget.uncertainTransfers).toBe(0);
		// it is still counted as governance activity
		expect(m.governance["anomaly_detected"]).toBe(1);
	});

	it("detection + the abort's own terminal still contradicts the call", () => {
		for (const terminal of ["llm_call_failed", "stream_partial_delivery"]) {
			const m = build([
				call(T, 100, { transferId: "t" }),
				detection("t"),
				ev(terminal, T, { transferId: "t" }),
			]);
			expect(m.totals.confirmedUt, terminal).toBe(0);
			expect(m.totals.contradictedCalls, terminal).toBe(1);
		}
	});
});
