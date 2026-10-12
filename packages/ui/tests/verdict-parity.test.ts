// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ONE classification: over the same vault, every outcome row the ledger UI shows for a transfer carries exactly the
 * verdict `usertrust-verify --tx` prints for it. Both call `transferVerdict`; this pins the call sites, so neither can
 * drift to a second answer.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transferIdHash, verifyTransaction } from "usertrust-verify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { loadState } from "../src/server/state.js";
import { kindClass, VERDICT_STATUS } from "../src/shared/rows.js";

// `hashOnly`: the record carries its transferId's hash instead of the id, as an unrecoverable settle writes it.
const TRANSFERS: Array<
	[string, Array<{ kind: string; data: Record<string, unknown>; hashOnly?: true }>]
> = [
	["tx_settled", [{ kind: "llm_call", data: { settled: true, cost: 5 } }]],
	[
		"tx_optimistic",
		[
			{ kind: "llm_call", data: { settled: true, cost: 5 } },
			{ kind: "settlement_ambiguous", data: { error: "post failed" } },
		],
	],
	[
		"tx_headless_ambiguous",
		[
			{ kind: "settlement_ambiguous", data: { error: "post failed" } },
			{ kind: "llm_call", data: { settled: false, cost: 5 } },
		],
	],
	["tx_failed", [{ kind: "llm_call_failed", data: { error: "provider 500" } }]],
	["tx_action_failed", [{ kind: "tool_use_failed", data: { error: "tool threw" } }]],
	["tx_denied", [{ kind: "ledger_rejected", data: { error: "Insufficient balance" } }]],
	["tx_released", [{ kind: "hold_released", data: { reason: "ttl" } }]],
	[
		"tx_detected_then_settled",
		[
			{ kind: "anomaly_detected", data: { message: "spike" } },
			{ kind: "llm_call", data: { settled: true, cost: 5 } },
		],
	],
	[
		"tx_partial",
		[
			{ kind: "anomaly_detected", data: { message: "spike" } },
			{ kind: "stream_partial_delivery", data: { error: "cut off" } },
		],
	],
	// A TTL sweep releases the hold, then the late settle finds no hold: one transfer, RELEASED (the first terminal).
	[
		"tx_swept_then_unrecoverable",
		[
			{ kind: "hold_released", data: { reason: "pending TTL expired" } },
			{ kind: "settlement_unrecoverable", data: { reason: "no hold" }, hashOnly: true },
		],
	],
	[
		"tx_unrecoverable",
		[{ kind: "settlement_unrecoverable", data: { reason: "no hold" }, hashOnly: true }],
	],
];

describe("PARITY: the ledger UI and `usertrust-verify --tx` give every transfer the same verdict", () => {
	let base: string;
	let vault: string;
	/** The ids of the events written for each transfer: a hash-only row carries no transferId to match on. */
	const written = new Map<string, string[]>();

	beforeAll(async () => {
		base = mkdtempSync(join(tmpdir(), "trust-verdict-parity-"));
		vault = join(base, ".usertrust");
		mkdirSync(join(vault, "audit"), { recursive: true });
		const writer = createAuditWriter(base);
		for (const [transferId, events] of TRANSFERS) {
			const ids: string[] = [];
			for (const e of events) {
				const id = e.hashOnly ? { transferIdHash: transferIdHash(transferId) } : { transferId };
				const event = await writer.appendEvent({
					kind: e.kind,
					actor: "local",
					data: { ...e.data, ...id },
				});
				ids.push(event.id);
			}
			written.set(transferId, ids);
		}
		writer.release();
	});
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	it.each(TRANSFERS.map(([id]) => id))("%s", (transferId) => {
		const tx = verifyTransaction(vault, transferId);
		expect(tx.found).toBe(true);
		expect(tx.status).toBeDefined();
		const expected = VERDICT_STATUS[tx.status as NonNullable<typeof tx.status>];
		const ids = written.get(transferId) ?? [];
		const outcomeRows = loadState(vault).rows.filter(
			(r) =>
				ids.includes(r.id) &&
				kindClass(r.kind, r.settled !== undefined ? { settled: r.settled } : {}) === "outcome",
		);
		// Every event written for the transfer is an outcome row here, or an annotation.
		expect(outcomeRows.length).toBe(
			(TRANSFERS.find(([id]) => id === transferId)?.[1] ?? []).filter(
				(e) => e.kind !== "anomaly_detected",
			).length,
		);
		for (const r of outcomeRows) expect(r.status, `${r.kind}`).toBe(expected);
	});
});
