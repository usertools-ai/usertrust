// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersistedAuditEvent } from "../../src/audit/read.js";
import { PRICING_TABLE } from "../../src/ledger/pricing.js";
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
		expect(m.budget.recordedSessionUt).toBe(100); // the budget figure uses the same exclusion
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
		expect(m.budget.recordedSessionUt).toBe(100);
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
		expect(m.budget.recordedSessionUt).toBe(100);
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
		const m = build([
			call("2026-10-08T01:00:00Z", 45, { transferId: "t-dry", source: "headless" }),
			call("2026-10-08T02:00:00Z", 55, {
				transferId: "t-real",
				source: "headless",
				ledgerPosted: true,
			}),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.postProvenUt).toBe(55);
		expect(m.totals.postProvenCalls).toBe(1);
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

	it("an ambiguous or settled:false governed action does not debit the budget", () => {
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
		expect(m.budget.recordedSessionUt).toBe(0);
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
