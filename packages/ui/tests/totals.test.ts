// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { PersistedAuditEvent } from "usertrust";
import { describe, expect, it } from "vitest";
import type { TotalsPayload } from "../src/shared/api.js";
import { breakdown, byTotalDesc, type Dimension, WHOLE_VAULT } from "../src/shared/breakdown.js";
import { spendFactsOf, toLedgerRows } from "../src/shared/rows.js";
import { rankingFrom, TOTALS_KEYS_MAX, TotalsIndex, topKeys } from "../src/shared/totals.js";

const DIMS: Dimension[] = ["lane", "role", "model", "kind", "provider"];

function evt(
	overrides: Partial<PersistedAuditEvent> & { data?: Record<string, unknown> },
): PersistedAuditEvent {
	return {
		id: "id-1",
		timestamp: "2026-07-27T10:00:00.000Z",
		previousHash: "0".repeat(64),
		hash: "a".repeat(64),
		kind: "llm_call",
		actor: "local",
		data: {},
		sequence: 1,
		...overrides,
	};
}

function foldAll(events: PersistedAuditEvent[]): TotalsIndex {
	const idx = new TotalsIndex();
	for (const e of events) idx.add(spendFactsOf(e));
	return idx;
}

describe("TotalsIndex", () => {
	it("folds to exactly what breakdown counts over every record", () => {
		const actors = ["ana", "bo", "cy", "dee"];
		const models = ["claude-sonnet-4-6", "grok-4.7", undefined];
		const jobTypes = ["bugfix", "moonshot", undefined];
		const events: PersistedAuditEvent[] = [];
		// 24 ordinary spend records spread over the actors, models and job types (listed, unlisted, absent).
		for (let i = 0; i < 24; i++) {
			const data: Record<string, unknown> = { cost: (i % 5) + 1 };
			const model = models[i % models.length];
			const jobType = jobTypes[i % jobTypes.length];
			if (model !== undefined) data.model = model;
			if (jobType !== undefined) data.jobType = jobType;
			if (i % 7 === 0) data.provider = "azure";
			events.push(evt({ id: `e${i}`, actor: actors[i % actors.length] as string, data }));
		}
		// The edge cases: each of these is a record breakdown does not count, or counts under a fallback name.
		events.push(evt({ id: "bad-time-1", timestamp: "not a time", data: { cost: 50 } }));
		events.push(evt({ id: "bad-time-2", timestamp: "", actor: "bo", data: { cost: 9 } }));
		events.push(evt({ id: "no-cost", actor: "cy", data: { model: "claude-sonnet-4-6" } }));
		events.push(evt({ id: "str-cost", actor: "cy", data: { cost: "5" } }));
		events.push(evt({ id: "failed", kind: "llm_call_failed", actor: "dee", data: { cost: 12 } }));
		events.push(evt({ id: "denied", kind: "policy_denied", actor: "ana", data: { cost: 8 } }));
		events.push(evt({ id: "zero", actor: "bo", data: { cost: 0, model: "grok-4.7" } }));

		const idx = foldAll(events);
		const rows = toLedgerRows(events, { valid: true, breakIndex: null }, undefined, 0);
		const payload = idx.payload(0);
		for (const dim of DIMS) {
			const b = breakdown(rows, WHOLE_VAULT, dim);
			const expected = b.keys.map((key) => ({
				key,
				spendUt: (b.byKey.get(key) as { spendUt: number }).spendUt,
				calls: (b.byKey.get(key) as { calls: number }).calls,
			}));
			expect(payload.dims[dim]).toEqual(expected);
			expect(payload.more[dim]).toBe(0);
		}
		// The oracle is not trivially empty, and it did skip records.
		expect(payload.dims.lane.length).toBeGreaterThan(1);
		expect(payload.records).toBe(events.length);
	});

	it("keeps the first TOTALS_KEYS_MAX keys by spend and counts the rest", () => {
		const idx = new TotalsIndex();
		// 105 lanes with distinct spends 1..105: the five left out are the five lowest.
		for (let i = 1; i <= 105; i++)
			idx.add({
				ts: "2026-07-27T10:00:00.000Z",
				kind: "llm_call",
				actor: `lane-${String(i).padStart(3, "0")}`,
				costUt: i,
			});
		const p = idx.payload(3);
		expect(p.dims.lane.length).toBe(TOTALS_KEYS_MAX);
		expect(p.more.lane).toBe(5);
		expect(p.dims.lane[0]?.spendUt).toBe(105);
		expect(p.dims.lane.at(-1)?.spendUt).toBe(6);
		// One kind, one role, one model fallback: nothing to cut there.
		expect(p.more.kind).toBe(0);
		expect(p.epoch).toBe(3);
	});

	it("breaks a tie at the cut A to Z", () => {
		const idx = new TotalsIndex();
		// 101 lanes all at the same spend: the one cut is the last A to Z.
		for (let i = 0; i < 101; i++)
			idx.add({
				ts: "2026-07-27T10:00:00.000Z",
				kind: "llm_call",
				actor: `lane-${String(i).padStart(3, "0")}`,
				costUt: 4,
			});
		const p = idx.payload(0);
		expect(p.dims.lane.length).toBe(TOTALS_KEYS_MAX);
		expect(p.more.lane).toBe(1);
		expect(p.dims.lane.at(-1)?.key).toBe("lane-099");
		expect(p.dims.lane.some((k) => k.key === "lane-100")).toBe(false);
	});

	it("counts every record it folds", () => {
		const idx = foldAll([
			evt({ data: { cost: 1 } }),
			evt({ data: { cost: 2 } }),
			evt({ data: { cost: 3 } }),
			evt({ kind: "policy_denied", data: { cost: 9 } }),
			evt({ timestamp: "not a time", data: { cost: 9 } }),
		]);
		expect(idx.records).toBe(5);
		expect(idx.payload(0).records).toBe(5);
		expect(idx.payload(0).dims.lane).toEqual([{ key: "local", spendUt: 6, calls: 3 }]);
	});

	it("is empty, never NaN, before any spend", () => {
		const none = new TotalsIndex().payload(0);
		const onlyNonSpend = foldAll([evt({ kind: "policy_denied", data: { cost: 4 } })]).payload(0);
		for (const p of [none, onlyNonSpend]) {
			for (const dim of DIMS) {
				expect(p.dims[dim]).toEqual([]);
				expect(p.more[dim]).toBe(0);
			}
		}
		expect(none.records).toBe(0);
		expect(onlyNonSpend.records).toBe(1);
	});

	it("hands back new arrays, so a caller cannot change the index", () => {
		const idx = foldAll([evt({ data: { cost: 2 } })]);
		const first = idx.payload(0);
		first.dims.lane.length = 0;
		first.dims.lane.push({ key: "x", spendUt: 99, calls: 1 });
		expect(idx.payload(0).dims.lane).toEqual([{ key: "local", spendUt: 2, calls: 1 }]);
	});
});

describe("topKeys", () => {
	it("keeps exactly what a full ranking keeps", () => {
		// 1,000 keys over only 12 distinct spends, so many keys tie, including a tie that straddles the cut.
		const map = new Map<string, number>();
		for (let i = 0; i < 1000; i++) map.set(`key-${String(i).padStart(4, "0")}`, (i * 7) % 12);
		// Shuffled insertion order (a fixed permutation, so a failure reproduces).
		const pairs = [...map.entries()];
		for (let i = pairs.length - 1; i > 0; i--) {
			const j = (i * 7919 + 13) % (i + 1);
			[pairs[i], pairs[j]] = [pairs[j] as [string, number], pairs[i] as [string, number]];
		}
		const shuffled = new Map(pairs);
		const full = byTotalDesc(shuffled);
		// The cut at 100 falls inside a run of equal spends: the key after the cut ties with the last one kept.
		expect(shuffled.get(full[99] as string)).toBe(shuffled.get(full[100] as string));
		expect(topKeys(shuffled, 100)).toEqual(full.slice(0, 100));
		expect(topKeys(shuffled, 1)).toEqual(full.slice(0, 1));
		expect(topKeys(shuffled, 1000)).toEqual(full);
		expect(topKeys(shuffled, 5000)).toEqual(full);
		expect(topKeys(shuffled, 0)).toEqual([]);
		expect(topKeys([], 10)).toEqual([]);
	});
});

describe("rankingFrom", () => {
	it("gives the payload's order", () => {
		const payload: TotalsPayload = {
			epoch: 0,
			records: 3,
			dims: {
				lane: [
					{ key: "zed", spendUt: 9, calls: 1 },
					{ key: "amy", spendUt: 5, calls: 2 },
					{ key: "bob", spendUt: 5, calls: 1 },
				],
				role: [],
				model: [],
				kind: [],
				provider: [],
			},
			more: { lane: 0, role: 0, model: 0, kind: 0, provider: 0 },
		};
		expect(rankingFrom(payload, "lane")).toEqual(["zed", "amy", "bob"]);
		expect(rankingFrom(payload, "model")).toEqual([]);
	});
});
