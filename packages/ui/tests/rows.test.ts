// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { PersistedAuditEvent } from "usertrust";
import { transferIdHash } from "usertrust-verify";
import { describe, expect, it } from "vitest";
import { TransferIndex } from "../src/server/verdicts.js";
import {
	KIND_CLASS,
	kindClass,
	type LedgerRow,
	spendFactsOf,
	statusOf,
	toLedgerRows,
	VERDICT_STATUS,
} from "../src/shared/rows.js";

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

describe("toLedgerRows", () => {
	it("flattens llm_call data with provider + USD", () => {
		const rows = toLedgerRows(
			[
				evt({
					data: {
						model: "claude-sonnet-4-6",
						cost: 5,
						settled: true,
						transferId: "tx_1",
						usageSource: "provider",
						source: "headless",
					},
				}),
			],
			{ valid: true, breakIndex: null },
			undefined,
			0,
		);
		expect(rows[0]).toMatchObject({
			seq: 1,
			kind: "llm_call",
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			costUt: 5,
			costUsd: 0.0005,
			settled: true,
			transferId: "tx_1",
			usageSource: "provider",
			source: "headless",
			integrity: "verified",
		});
	});

	it("keeps unknown kinds with generic columns", () => {
		const rows = toLedgerRows(
			[evt({ kind: "mystery", data: { weird: true } })],
			{
				valid: true,
				breakIndex: null,
			},
			undefined,
			0,
		);
		expect(rows[0]?.kind).toBe("mystery");
		expect(rows[0]?.model).toBeUndefined();
	});

	it("marks rows at/after a break as after-break", () => {
		const rows = toLedgerRows(
			[evt({ sequence: 1 }), evt({ id: "id-2", sequence: 2 }), evt({ id: "id-3", sequence: 3 })],
			{ valid: false, breakIndex: 1 },
			undefined,
			0,
		);
		expect(rows.map((r) => r.integrity)).toEqual(["verified", "after-break", "after-break"]);
	});
});

describe("statusOf", () => {
	const OK = { valid: true, breakIndex: null } as const;
	/** Rows as the server builds them: every event indexed by transfer, each row given its TRANSFER's verdict. */
	function classify(events: PersistedAuditEvent[]) {
		const index = new TransferIndex();
		index.add(events, 0);
		return toLedgerRows(events, OK, index.verdictOf, 0).map((r) => statusOf(r));
	}
	// Each event its own hash, as on a chain: rows are indexed by it.
	const at = (n: number, o: Partial<PersistedAuditEvent> & { data?: Record<string, unknown> }) =>
		evt({ id: `id-${n}`, sequence: n, hash: n.toString(16).padStart(64, "0"), ...o });

	it("a failure, a settlement, and a transfer with no terminal (unknown, never pending)", () => {
		expect(
			classify([
				at(1, { kind: "llm_call_failed", data: { transferId: "tx_f", error: "boom" } }),
				at(2, { data: { transferId: "tx_s", settled: true } }),
				at(3, { kind: "anomaly_detected", data: { transferId: "tx_u", message: "spike" } }),
				at(4, { data: { transferId: "tx_u" } }),
			]),
		).toEqual(["failed", "settled", "info", "unknown"]);
	});

	it("labels a released hold as released: never pending, never failed", () => {
		expect(
			classify([
				at(1, {
					kind: "hold_released",
					data: { transferId: "tx_1", reason: "pending TTL expired" },
				}),
			]),
		).toEqual(["released"]);
	});

	it("red-first (failed): a settlement_unrecoverable is UNRECOVERABLE — ran and recorded, not charged", () => {
		expect(
			classify([
				at(1, {
					kind: "settlement_unrecoverable",
					data: { transferIdHash: "a".repeat(64), usage: { inputTokens: 5 } },
				}),
			]),
		).toEqual(["unrecoverable"]);
	});

	it("red-first (unrecoverable): a hash-only unrecoverable record after a TTL-swept release is RELEASED, as `--tx` says", () => {
		expect(
			classify([
				at(1, {
					kind: "hold_released",
					data: { transferId: "tx_swept", reason: "pending TTL expired" },
				}),
				at(2, {
					kind: "settlement_unrecoverable",
					data: { transferIdHash: transferIdHash("tx_swept"), usage: { inputTokens: 5 } },
				}),
			]),
		).toEqual(["released", "released"]);
	});

	it("red-first (released): a hash-only record joins a transfer recorded AFTER it; chain order decides", () => {
		expect(
			classify([
				at(1, {
					kind: "settlement_unrecoverable",
					data: { transferIdHash: transferIdHash("tx_late") },
				}),
				at(2, { kind: "hold_released", data: { transferId: "tx_late", reason: "ttl" } }),
			]),
		).toEqual(["unrecoverable", "unrecoverable"]);
	});

	it("red-first (redirected): a later record REUSING an event id never moves the earlier row to its transfer", () => {
		expect(
			classify([
				at(1, { id: "dup", data: { transferId: "tx_ok", settled: true } }),
				at(2, {
					id: "dup",
					kind: "llm_call_failed",
					data: { transferId: "tx_bad", error: "boom" },
				}),
			]),
		).toEqual(["settled", "failed"]);
	});

	it("a coincidental transferIdHash on any other kind joins nothing", () => {
		expect(
			classify([
				at(1, { kind: "hold_released", data: { transferId: "tx_h", reason: "ttl" } }),
				at(2, { data: { transferIdHash: transferIdHash("tx_h"), settled: true } }),
			]),
		).toEqual(["released", "settled"]);
	});

	it("a transfer's cached verdict is dropped when an event joins it", () => {
		const index = new TransferIndex();
		const optimistic = at(1, { data: { transferId: "tx_c", settled: true } });
		index.add([optimistic], 0);
		expect(index.verdictOf(optimistic)).toBe("SETTLED");
		const touched = index.add(
			[at(2, { kind: "settlement_ambiguous", data: { transferId: "tx_c", error: "post failed" } })],
			1,
		);
		expect([...touched]).toEqual([transferIdHash("tx_c")]);
		expect(index.keyOfRow(optimistic.hash)).toBe(transferIdHash("tx_c"));
		expect(index.verdictOf(optimistic)).toBe("AMBIGUOUS");
	});

	it("labels a denial as denied, not as a zero-cost failed transaction", () => {
		const events = [
			at(1, {
				kind: "policy_denied",
				data: { decision: "deny", denialClass: "pii", error: "Policy denied: PII detected" },
			}),
			at(2, {
				kind: "ledger_rejected",
				data: { decision: "deny", transferId: "tx_1", error: "Insufficient balance" },
			}),
		];
		expect(classify(events)).toEqual(["denied", "denied"]);
		const [policyDenied, ledgerRejected] = toLedgerRows(events, OK, undefined, 0);
		// No fabricated zero cost — a denial spent nothing and reports nothing.
		expect(policyDenied?.costUt).toBeUndefined();
		expect(ledgerRejected?.costUt).toBeUndefined();
	});

	it("red-first (settled): the audit-first path's OPTIMISTIC settled:true, then the POST's ambiguity → both AMBIGUOUS", () => {
		expect(
			classify([
				at(1, { data: { transferId: "tx_1", settled: true, cost: 5 } }),
				at(2, { kind: "settlement_ambiguous", data: { transferId: "tx_1", error: "post failed" } }),
			]),
		).toEqual(["ambiguous", "ambiguous"]);
	});

	it("red-first (pending): the headless path's ambiguity first, then settled:false → both AMBIGUOUS", () => {
		expect(
			classify([
				at(1, { kind: "settlement_ambiguous", data: { transferId: "tx_1", error: "post failed" } }),
				at(2, { data: { transferId: "tx_1", settled: false, cost: 5 } }),
			]),
		).toEqual(["ambiguous", "ambiguous"]);
	});

	it("an annotation on a settled transfer is info; the settlement row is settled", () => {
		expect(
			classify([
				at(1, { data: { transferId: "tx_1", settled: true, cost: 5 } }),
				at(2, { kind: "usage_implausible", data: { transferId: "tx_1", charged: "estimate" } }),
			]),
		).toEqual(["settled", "info"]);
	});

	it("an ungoverned_call is ungoverned: an unmetered call, never a pending hold", () => {
		// It carries no `settled` and no `error`: without its own arm it read "pending", a hold
		// that might still settle, hiding that the call ran with no hold at all.
		const [row] = toLedgerRows(
			[evt({ kind: "ungoverned_call", data: { method: "embeddings.create", provider: "openai" } })],
			{ valid: true, breakIndex: null },
			undefined,
			0,
		);
		expect(statusOf(row as never)).toBe("ungoverned");
	});
});

// Every kind a producer writes, by class: a kind with no mapping is VISIBLE here, never silently pending.
describe("KIND_CLASS", () => {
	it.each([
		["llm_call", "outcome"],
		["llm_call_failed", "outcome"],
		["stream_partial_delivery", "outcome"],
		["settlement_ambiguous", "outcome"],
		["settlement_unrecoverable", "outcome"],
		["policy_denied", "outcome"],
		["ledger_rejected", "outcome"],
		["hold_released", "outcome"],
		["tool_use", "outcome"],
		["file_access", "outcome"],
		["shell_command", "outcome"],
		["api_request", "outcome"],
		["settlement_shortfall", "info"],
		["usage_implausible", "info"],
		["injection_detected", "info"],
		["anomaly_detected", "info"],
		["budget_allocated", "info"],
		["budget_reclaimed", "info"],
		["audit.quarantine.torn_tail", "info"],
		["credential_added", "info"],
		["credential_removed", "info"],
		["credential_rotated", "info"],
		["credential_access", "info"],
		["credential_denied", "info"],
		["ungoverned_call", "ungoverned"],
	] as const)("%s → %s", (kind, cls) => {
		expect(KIND_CLASS[kind]).toBe(cls);
		expect(kindClass(kind, {})).toBe(cls);
	});

	it("the table is exactly the inventory: no kind added or dropped unreviewed", () => {
		expect(Object.keys(KIND_CLASS)).toHaveLength(25);
	});

	it("an action named after the caller's action: `<kind>_failed`, or any kind carrying settled, is an outcome", () => {
		expect(kindClass("deploy_failed", {})).toBe("outcome");
		expect(kindClass("deploy", { settled: true })).toBe("outcome");
	});

	it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
		"red-first (a function or an object as the status): %s is not a listed kind",
		(kind) => {
			expect(kindClass(kind, {})).toBe("unknown");
			const [row] = toLedgerRows(
				[evt({ kind, data: {} })],
				{ valid: true, breakIndex: null },
				undefined,
				0,
			);
			expect(statusOf(row as never)).toBe("unknown");
		},
	);

	it("a kind nobody writes is UNKNOWN, never pending or settled", () => {
		expect(kindClass("something_new", {})).toBe("unknown");
		const [row] = toLedgerRows(
			[evt({ kind: "something_new", data: {} })],
			{
				valid: true,
				breakIndex: null,
			},
			undefined,
			0,
		);
		expect(statusOf(row as never)).toBe("unknown");
	});

	it("every transfer verdict has a row status, and PENDING (no terminal yet) is unknown", () => {
		expect(VERDICT_STATUS).toEqual({
			SETTLED: "settled",
			AMBIGUOUS: "ambiguous",
			FAILED: "failed",
			DENIED: "denied",
			RELEASED: "released",
			UNRECOVERABLE: "unrecoverable",
			PENDING: "unknown",
		});
	});
});

describe("spendFactsOf", () => {
	const FIELDS = [
		"ts",
		"kind",
		"actor",
		"model",
		"provider",
		"providerRecorded",
		"jobType",
		"costUt",
	] as const;

	function pick(row: LedgerRow): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		// Own keys only: a key present with the value undefined is a difference, so copy presence, not value.
		for (const f of FIELDS) if (Object.hasOwn(row, f)) out[f] = row[f];
		return out;
	}

	const CASES: Array<[string, Partial<PersistedAuditEvent> & { data?: Record<string, unknown> }]> =
		[
			["a claude model with a cost", { data: { model: "claude-sonnet-4-6", cost: 5 } }],
			["a grok model", { data: { model: "grok-4.7", cost: 2 } }],
			["no model", { data: { cost: 3 } }],
			["a recorded provider", { data: { model: "gpt-5", provider: "azure", cost: 1 } }],
			["a blank recorded provider", { data: { model: "gpt-5", provider: "", cost: 1 } }],
			["a recorded provider and no model", { data: { provider: "xai" } }],
			["a listed job type", { data: { jobType: "bugfix", cost: 4 } }],
			["an unlisted job type", { data: { jobType: "moonshot", cost: 4 } }],
			["no job type", { data: { model: "claude-haiku-4-5" } }],
			["no cost", { data: { model: "gemini-2" } }],
			["a cost that is a string", { data: { model: "claude-sonnet-4-6", cost: "5" } }],
			["a cost of zero", { kind: "llm_call_failed", actor: "ana", data: { cost: 0 } }],
			["a time that does not parse", { timestamp: "not a time", data: { cost: 7 } }],
		];

	// Literals for spendFactsOf alone: the parity test below compares it with toLedgerRows, which calls it.
	it("derives the provider from the model's prefix", () => {
		expect(spendFactsOf(evt({ data: { model: "claude-sonnet-4-6" } })).provider).toBe("anthropic");
		expect(spendFactsOf(evt({ data: { model: "grok-4.7" } })).provider).toBe("xai");
	});

	it("keeps the provider a record names, apart from the one the model gives", () => {
		expect(spendFactsOf(evt({ data: { model: "gpt-5", provider: "azure" } }))).toEqual({
			ts: "2026-07-27T10:00:00.000Z",
			kind: "llm_call",
			actor: "local",
			model: "gpt-5",
			provider: "openai",
			providerRecorded: "azure",
		});
	});

	it("keeps a listed job type, calls an unlisted one unrecognized, and leaves an absent one out", () => {
		expect(spendFactsOf(evt({ data: { jobType: "bugfix" } })).jobType).toBe("bugfix");
		expect(spendFactsOf(evt({ data: { jobType: "moonshot" } })).jobType).toBe("unrecognized");
		expect(Object.hasOwn(spendFactsOf(evt({ data: {} })), "jobType")).toBe(false);
	});

	it("takes a cost only when it is a number", () => {
		expect(spendFactsOf(evt({ data: { cost: 5 } })).costUt).toBe(5);
		expect(spendFactsOf(evt({ data: { cost: 0 } })).costUt).toBe(0);
		expect(Object.hasOwn(spendFactsOf(evt({ data: { cost: "5" } })), "costUt")).toBe(false);
		expect(Object.hasOwn(spendFactsOf(evt({ data: {} })), "costUt")).toBe(false);
	});

	it.each(CASES)("gives exactly the key and spend fields toLedgerRows gives: %s", (_name, over) => {
		const e = evt(over);
		const row = toLedgerRows([e], { valid: true, breakIndex: null }, undefined, 0)[0] as LedgerRow;
		expect(spendFactsOf(e)).toEqual(pick(row));
		// toEqual ignores keys holding undefined; compare the key lists too.
		expect(Object.keys(spendFactsOf(e)).sort()).toEqual(Object.keys(pick(row)).sort());
	});
});

describe("a charge's inputs", () => {
	const OK = { valid: true, breakIndex: null } as const;
	const rowOf = (data: Record<string, unknown>) =>
		toLedgerRows([evt({ data })], OK, undefined, 0)[0] as LedgerRow;
	const USAGE = {
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 2000,
		cacheWriteTokens: 100,
	};
	const RATES = { inputPer1k: 30, outputPer1k: 150, cacheReadPer1k: 3, cacheWritePer1k: 37.5 };

	it("a row carries its record's token counts, applied rates and pricing table version", () => {
		const row = rowOf({ usage: USAGE, appliedRates: RATES, pricingTableVersion: "2026-11-02" });
		expect(row.usage).toEqual(USAGE);
		expect(row.appliedRates).toEqual(RATES);
		expect(row.pricingTableVersion).toBe("2026-11-02");
		expect("cacheWrite1h" in row).toBe(false);
	});

	it("a record with none of them gives a row with none of the keys", () => {
		const row = rowOf({ model: "m", cost: 5 });
		expect("usage" in row).toBe(false);
		expect("appliedRates" in row).toBe(false);
		expect("cacheWrite1h" in row).toBe(false);
		expect("pricingTableVersion" in row).toBe(false);
	});

	it("keeps only the counts that are whole numbers >= 0, and fills nothing in", () => {
		expect(
			rowOf({
				usage: { inputTokens: 5, outputTokens: "x", cacheReadTokens: -1, cacheWriteTokens: 1.5 },
			}).usage,
		).toEqual({ inputTokens: 5 });
		expect(
			rowOf({
				usage: {
					inputTokens: Number.POSITIVE_INFINITY,
					outputTokens: Number.NaN,
					cacheReadTokens: null,
					cacheWriteTokens: 7,
				},
			}).usage,
		).toEqual({ cacheWriteTokens: 7 });
	});

	it("a recorded 0 is kept: 0 is a count and a rate, not an absence", () => {
		expect(rowOf({ usage: { cacheReadTokens: 0 } }).usage).toEqual({ cacheReadTokens: 0 });
		expect(rowOf({ appliedRates: { outputPer1k: 0 } }).appliedRates).toEqual({ outputPer1k: 0 });
	});

	it("keeps only the rates that are finite numbers >= 0; a rate need not be whole", () => {
		expect(
			rowOf({
				appliedRates: {
					inputPer1k: 0.3,
					outputPer1k: -150,
					cacheReadPer1k: "3",
					cacheWritePer1k: 37.5,
				},
			}).appliedRates,
		).toEqual({ inputPer1k: 0.3, cacheWritePer1k: 37.5 });
		expect(
			rowOf({ appliedRates: { inputPer1k: Number.POSITIVE_INFINITY, outputPer1k: Number.NaN } }),
		).not.toHaveProperty("appliedRates");
	});

	it("copies the named keys only", () => {
		expect(rowOf({ usage: { inputTokens: 5, reasoningTokens: 9 } }).usage).toEqual({
			inputTokens: 5,
		});
		expect(rowOf({ appliedRates: { inputPer1k: 30, inputTokens: 9 } }).appliedRates).toEqual({
			inputPer1k: 30,
		});
		// A count under a rate's name, or a rate under a count's, is neither.
		expect(rowOf({ usage: RATES })).not.toHaveProperty("usage");
		expect(rowOf({ appliedRates: USAGE })).not.toHaveProperty("appliedRates");
	});

	it("a block that is not an object, or keeps no key, gives no key", () => {
		expect(rowOf({ usage: "oops", appliedRates: null })).not.toHaveProperty("usage");
		expect(rowOf({ usage: "oops", appliedRates: null })).not.toHaveProperty("appliedRates");
		expect(rowOf({ usage: {}, appliedRates: [] })).not.toHaveProperty("usage");
		expect(rowOf({ usage: {}, appliedRates: [] })).not.toHaveProperty("appliedRates");
		expect(rowOf({ usage: { inputTokens: -5 } })).not.toHaveProperty("usage");
		expect(rowOf({ usage: 7 })).not.toHaveProperty("usage");
	});

	it("a usable 1-hour cache write is kept as recorded: its tokens and its rate, and no other key", () => {
		expect(rowOf({ cacheWrite1h: { tokens: 500, ratePer1k: 60 } }).cacheWrite1h).toEqual({
			tokens: 500,
			ratePer1k: 60,
		});
		expect(
			rowOf({ cacheWrite1h: { tokens: 500, ratePer1k: 62.5, extra: 1 } }).cacheWrite1h,
		).toEqual({
			tokens: 500,
			ratePer1k: 62.5,
		});
		expect(rowOf({ cacheWrite1h: { tokens: 0, ratePer1k: 0 } }).cacheWrite1h).toEqual({
			tokens: 0,
			ratePer1k: 0,
		});
	});

	it("a 1-hour cache write the record carries stays on the row, with only its usable numbers", () => {
		// The row keeps the fact that the record carried one: without it the whole write would look like a 5-minute one.
		const kept = (cacheWrite1h: unknown) => rowOf({ cacheWrite1h }).cacheWrite1h;
		expect(kept({ tokens: 500 })).toEqual({ tokens: 500 });
		expect(kept({ ratePer1k: 60 })).toEqual({ ratePer1k: 60 });
		expect(kept({ tokens: 1.5, ratePer1k: 60 })).toEqual({ ratePer1k: 60 });
		expect(kept({ tokens: -1, ratePer1k: 60 })).toEqual({ ratePer1k: 60 });
		expect(kept({ tokens: Number.NaN, ratePer1k: 60 })).toEqual({ ratePer1k: 60 });
		expect(kept({ tokens: 500, ratePer1k: -60 })).toEqual({ tokens: 500 });
		expect(kept({ tokens: 500, ratePer1k: "60" })).toEqual({ tokens: 500 });
		expect(kept({ tokens: "500", ratePer1k: Number.POSITIVE_INFINITY })).toEqual({});
		// Present, with nothing usable in it: still on the row, and empty. Nothing is filled in.
		for (const present of [{}, [], 7, 0, "1h", false]) {
			expect(kept(present)).toEqual({});
			expect(Object.keys(kept(present) ?? { none: 1 })).toEqual([]);
		}
	});

	it("a record with no 1-hour cache write gives a row with no such key", () => {
		expect(rowOf({ cacheWrite1h: null })).not.toHaveProperty("cacheWrite1h");
		expect(rowOf({ cacheWrite1h: undefined })).not.toHaveProperty("cacheWrite1h");
		expect(rowOf({ usage: { cacheWriteTokens: 2000 } })).not.toHaveProperty("cacheWrite1h");
	});

	it("the pricing table version is kept only as a string that names one", () => {
		expect(rowOf({ pricingTableVersion: 20261102 })).not.toHaveProperty("pricingTableVersion");
		expect(rowOf({ pricingTableVersion: "" })).not.toHaveProperty("pricingTableVersion");
	});

	it("adds to the row and changes nothing else on it", () => {
		const data = { model: "claude-sonnet-4-6", cost: 115, settled: true, transferId: "tx_1" };
		const plain = rowOf(data);
		const withInputs = rowOf({
			...data,
			usage: USAGE,
			appliedRates: RATES,
			cacheWrite1h: { tokens: 50, ratePer1k: 60 },
			pricingTableVersion: "2026-11-02",
		});
		const {
			usage: _u,
			appliedRates: _r,
			cacheWrite1h: _h,
			pricingTableVersion: _v,
			...rest
		} = withInputs;
		expect(rest).toEqual(plain);
		expect(withInputs.costUt).toBe(115);
	});
});
