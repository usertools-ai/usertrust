// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { PersistedAuditEvent } from "../../src/audit/read.js";
import { buildWeeklyReport, type IntegrityInfo, UNATTRIBUTED } from "../../src/report/weekly.js";

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
		expect(m.notes.join(" ")).toMatch(/settlement_ambiguous/);
		expect(m.budget.recordedUt).toBe(100); // the budget figure uses the same exclusion
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

	it("local-endpoint rows are nominal units: counted, excluded from dollar totals", () => {
		const m = build([
			call("2026-10-08T01:00:00Z", 100),
			call("2026-10-08T02:00:00Z", 1, { endpointClass: "local" }),
		]);
		expect(m.totals.confirmedUt).toBe(100);
		expect(m.totals.localCalls).toBe(1);
		expect(m.totals.localNominalUt).toBe(1);
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

	it("budget status: configured vs RECORDED spend over the whole chain; none configured is not 100% remaining", () => {
		const events = [call("2026-09-01T00:00:00Z", 300), call("2026-10-08T01:00:00Z", 100)];
		const none = build(events, { budget: 0 });
		expect(none.budget.configuredUt).toBeNull();
		expect(none.budget.usedFraction).toBeNull();
		const some = build(events, { budget: 1000 });
		expect(some.budget).toMatchObject({
			configuredUt: 1000,
			windowUt: 100,
			recordedUt: 400,
			usedFraction: 0.4,
			overBudget: false,
		});
		expect(build(events, { budget: 300 }).budget).toMatchObject({
			usedFraction: 1,
			overBudget: true,
		});
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
