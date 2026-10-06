// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A RELEASED hold is a terminal: nothing charged, nothing failed.
 *
 * `hold_released` (headless `release()`: a TTL sweep, a shutdown, a call not made)
 * and `settlement_duplicate` (a keyed settle whose key another hold already
 * charged — released, never posted) carry the hold's `transferId` and no `settled`
 * field. Before the RELEASED arm they fell through to PENDING: "may still settle",
 * for a hold that never can.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyTransaction } from "../src/index.js";
import { renderReceipt, type TransactionEvent } from "../src/receipt.js";

const ESC = String.fromCharCode(0x1b);

function released(kind: string, data: Record<string, unknown> = {}): TransactionEvent {
	return {
		id: "test-id",
		timestamp: "2026-10-05T12:00:00.000Z",
		previousHash: "0".repeat(64),
		kind,
		actor: "local",
		data: {
			model: "claude-sonnet-4-6",
			transferId: "tx_1",
			source: "headless",
			...data,
		} as TransactionEvent["data"],
		sequence: 1,
		hash: "a".repeat(64),
	};
}

function render(event: TransactionEvent): string {
	return renderReceipt({
		event,
		chainLength: 1,
		merkleRoot: "b".repeat(64),
		merkleVerified: true,
		chainVerified: true,
		cumulativeSpend: 0,
		verifiedAt: new Date("2026-10-05T12:00:01.000Z"),
	});
}

/** Write a chain of events and verify one transfer from it. */
function verifyChainOf(events: Array<Record<string, unknown>>, txId: string) {
	const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-released-"));
	try {
		mkdirSync(join(dir, "audit"), { recursive: true });
		const lines = events.map((e, i) => ({
			actor: "local",
			timestamp: `2026-10-05T12:00:0${i}.000Z`,
			previousHash: i === 0 ? "0".repeat(64) : String(i).repeat(64),
			sequence: i + 1,
			hash: String(i + 1).repeat(64),
			...e,
		}));
		writeFileSync(
			join(dir, "audit", "events.jsonl"),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
			"utf-8",
		);
		return verifyTransaction(dir, txId);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("renderReceipt — a released hold", () => {
	it.each(["hold_released", "settlement_duplicate"])(
		"%s renders RELEASED, never PENDING",
		(kind) => {
			const output = render(released(kind));
			expect(output).toContain("RELEASED");
			expect(output).not.toContain("PENDING");
			expect(output).not.toContain("FAILED (");
		},
	);

	it("prints the release reason, scrubbed, and no spend lines", () => {
		const output = render(released("hold_released", { reason: `pending TTL${ESC}[2J expired` }));
		expect(output).toContain("Reason:");
		expect(output).toContain("pending TTL");
		expect(output).not.toContain(ESC);
		expect(output).not.toContain("Conversion");
	});
});

describe("verifyTransaction — a released hold is a terminal", () => {
	it("a released hold resolves RELEASED", () => {
		const result = verifyChainOf(
			[{ kind: "hold_released", data: { model: "m", transferId: "tx_1", reason: "released" } }],
			"tx_1",
		);
		expect(result.found).toBe(true);
		expect(result.receipt).toContain("RELEASED");
	});

	it("a duplicate's chain — hold_released, then settlement_duplicate — resolves RELEASED", () => {
		const result = verifyChainOf(
			[
				{ kind: "hold_released", data: { model: "m", transferId: "tx_1", reason: "duplicate" } },
				{ kind: "settlement_duplicate", data: { model: "m", transferId: "tx_1" } },
			],
			"tx_1",
		);
		expect(result.receipt).toContain("RELEASED");
	});

	it("a LATER settled:true cannot rewrite a release into a settlement (first terminal wins)", () => {
		const result = verifyChainOf(
			[
				{ kind: "hold_released", data: { model: "m", transferId: "tx_1", reason: "released" } },
				{ kind: "llm_call", data: { model: "m", cost: 50, settled: true, transferId: "tx_1" } },
			],
			"tx_1",
		);
		expect(result.receipt).toContain("RELEASED");
		expect(result.receipt).not.toContain("SETTLED");
	});

	it("a release that comes AFTER a settlement does not unsettle it", () => {
		const result = verifyChainOf(
			[
				{ kind: "llm_call", data: { model: "m", cost: 50, settled: true, transferId: "tx_1" } },
				{ kind: "hold_released", data: { model: "m", transferId: "tx_1", reason: "released" } },
			],
			"tx_1",
		);
		expect(result.receipt).toContain("SETTLED");
	});
});
