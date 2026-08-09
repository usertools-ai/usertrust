// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { PersistedAuditEvent } from "usertrust";
import { describe, expect, it } from "vitest";
import { statusOf, toLedgerRows } from "../src/shared/rows.js";

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
	it("failed kind wins; settled flag otherwise; default pending", () => {
		const [failed, settled, pending] = toLedgerRows(
			[
				evt({ kind: "llm_call_failed", data: { error: "boom" } }),
				evt({ id: "id-2", sequence: 2, data: { settled: true } }),
				evt({ id: "id-3", sequence: 3, data: {} }),
			],
			{ valid: true, breakIndex: null },
		);
		expect(statusOf(failed as never)).toBe("failed");
		expect(statusOf(settled as never)).toBe("settled");
		expect(statusOf(pending as never)).toBe("pending");
	});

	it("labels a denial as denied, not as a zero-cost failed transaction", () => {
		// A denial carries an `error` string, which the generic mapping would
		// otherwise read as a failed CALL — putting refusals in the same column
		// as provider failures and displacing real receipts.
		const [policyDenied, ledgerRejected] = toLedgerRows(
			[
				evt({
					kind: "policy_denied",
					data: { decision: "deny", denialClass: "pii", error: "Policy denied: PII detected" },
				}),
				evt({
					id: "id-2",
					sequence: 2,
					kind: "ledger_rejected",
					data: { decision: "deny", transferId: "tx_1", error: "Insufficient balance" },
				}),
			],
			{ valid: true, breakIndex: null },
		);
		expect(statusOf(policyDenied as never)).toBe("denied");
		expect(statusOf(ledgerRejected as never)).toBe("denied");
		// No fabricated zero cost — a denial spent nothing and reports nothing.
		expect(policyDenied?.costUt).toBeUndefined();
		expect(ledgerRejected?.costUt).toBeUndefined();
	});
});
