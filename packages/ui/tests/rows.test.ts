// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { PersistedAuditEvent } from "usertrust";
import { transferIdHash } from "usertrust-verify";
import { describe, expect, it } from "vitest";
import { TransferIndex } from "../src/server/verdicts.js";
import {
	KIND_CLASS,
	kindClass,
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
		const rows = toLedgerRows([evt({ kind: "mystery", data: { weird: true } })], {
			valid: true,
			breakIndex: null,
		});
		expect(rows[0]?.kind).toBe("mystery");
		expect(rows[0]?.model).toBeUndefined();
	});

	it("marks rows at/after a break as after-break", () => {
		const rows = toLedgerRows(
			[evt({ sequence: 1 }), evt({ id: "id-2", sequence: 2 }), evt({ id: "id-3", sequence: 3 })],
			{ valid: false, breakIndex: 1 },
		);
		expect(rows.map((r) => r.integrity)).toEqual(["verified", "after-break", "after-break"]);
	});
});

describe("statusOf", () => {
	const OK = { valid: true, breakIndex: null } as const;
	/** Rows as the server builds them: every event indexed by transfer, each row given its TRANSFER's verdict. */
	function classify(events: PersistedAuditEvent[]) {
		const index = new TransferIndex();
		index.add(events);
		return toLedgerRows(events, OK, index.verdictOf).map((r) => statusOf(r));
	}
	const at = (n: number, o: Partial<PersistedAuditEvent> & { data?: Record<string, unknown> }) =>
		evt({ id: `id-${n}`, sequence: n, ...o });

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
		index.add([optimistic]);
		expect(index.verdictOf(optimistic)).toBe("SETTLED");
		const touched = index.add([
			at(2, { kind: "settlement_ambiguous", data: { transferId: "tx_c", error: "post failed" } }),
		]);
		expect([...touched]).toEqual([transferIdHash("tx_c")]);
		expect(index.keyOfRow("id-1")).toBe(transferIdHash("tx_c"));
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
		const [policyDenied, ledgerRejected] = toLedgerRows(events, OK);
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
			const [row] = toLedgerRows([evt({ kind, data: {} })], { valid: true, breakIndex: null });
			expect(statusOf(row as never)).toBe("unknown");
		},
	);

	it("a kind nobody writes is UNKNOWN, never pending or settled", () => {
		expect(kindClass("something_new", {})).toBe("unknown");
		const [row] = toLedgerRows([evt({ kind: "something_new", data: {} })], {
			valid: true,
			breakIndex: null,
		});
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
