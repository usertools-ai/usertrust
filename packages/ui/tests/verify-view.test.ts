// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTransaction } from "usertrust-verify";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { type ReceiptData, renderReceipt } from "../../verify/src/receipt.js";
import { applyStatusChanges } from "../src/shared/live.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { heldFor, receiptAnchored, verifyOutcome } from "../src/shared/verify-view.js";

/** A receipt as usertrust-verify renders it, with the Merkle row `merkleLabel` and the event's model `model`. */
function receipt(merkleLabel: string | undefined, model = "claude-sonnet-4-6"): string {
	const data: ReceiptData = {
		event: {
			id: "e1",
			timestamp: "2026-10-12T17:59:02.770Z",
			previousHash: "0".repeat(64),
			kind: "llm_call",
			actor: "local",
			data: { model, cost: 5, settled: true, transferId: "tx_1" },
			sequence: 1,
			hash: "a".repeat(64),
		},
		chainLength: 1,
		merkleRoot: "b".repeat(64),
		merkleVerified: true,
		chainVerified: true,
		verifiedAt: new Date("2026-10-12T18:00:00.000Z"),
		merkleLabel,
	};
	return renderReceipt(data);
}

const valid = (r: string) => ({
	found: true,
	valid: true,
	receipt: r,
	errors: [],
	status: "SETTLED",
});

describe("verifyOutcome", () => {
	it("found, valid and anchored (the receipt proves inclusion against an anchor): verified", () => {
		const r = receipt("INCLUSION VERIFIED (anchor #7)");
		expect(verifyOutcome(200, valid(r))).toEqual({ kind: "verified", receipt: r });
	});

	it("found and valid but UNANCHORED: consistent, unanchored, never verified", () => {
		const r = receipt(undefined);
		expect(r).toContain("CHAIN CONSISTENT (UNANCHORED)");
		expect(verifyOutcome(200, valid(r))).toEqual({ kind: "consistent-unanchored", receipt: r });
	});

	it("every valid receipt short of an inclusion proof is unanchored: a tail past the last anchor, an unverifiable anchor, a bare string", () => {
		for (const r of [receipt("IN UNANCHORED TAIL"), receipt("INCLUSION UNVERIFIABLE"), "R"])
			expect(verifyOutcome(200, valid(r)).kind).toBe("consistent-unanchored");
	});

	it("reads the Merkle row only: an event field saying INCLUSION VERIFIED does not make an unanchored receipt verified", () => {
		const r = receipt(undefined, "INCLUSION VERIFIED");
		expect(r).toContain("INCLUSION VERIFIED");
		expect(receiptAnchored(r)).toBe(false);
		expect(verifyOutcome(200, valid(r)).kind).toBe("consistent-unanchored");
	});

	it("an anchor number long enough that the Merkle row has no dots is still read", () => {
		const r = receipt("INCLUSION VERIFIED (anchor #123456)");
		expect(r).not.toMatch(/Merkle \.+ INCLUSION/);
		expect(receiptAnchored(r)).toBe(true);
	});

	it("found and not valid: FAILED, with the first reason", () => {
		expect(
			verifyOutcome(200, { found: true, valid: false, receipt: "R", errors: ["hash mismatch"] }),
		).toEqual({ kind: "failed", receipt: "R", reason: "hash mismatch" });
	});

	it("red-first (a red 'FAILED: Audit log not found'): a transaction not in the log is NOT FOUND, not a failed check", () => {
		for (const errors of [
			["Audit log not found: /v/audit/events.jsonl"],
			["Audit log is empty"],
			[],
		]) {
			const shown = verifyOutcome(404, { found: false, valid: false, receipt: "NF", errors });
			expect(shown.kind).toBe("not-found");
			expect(shown).toMatchObject({ receipt: "NF", reason: errors[0] });
		}
	});

	it("a response that is not a verification (a 400, a proxy page, garbage) is a failed REQUEST", () => {
		expect(verifyOutcome(400, { error: "malformed percent-encoding" })).toEqual({
			kind: "request-failed",
			reason: "malformed percent-encoding",
		});
		expect(verifyOutcome(502, "<html>")).toEqual({ kind: "request-failed", reason: "HTTP 502" });
		// The server's answer when an audit segment cannot be read: a failed request with its reason, never a receipt.
		expect(verifyOutcome(500, { error: "audit log could not be read" })).toEqual({
			kind: "request-failed",
			reason: "audit log could not be read",
		});
		expect(verifyOutcome(200, { found: "yes", valid: true, receipt: "R" })).toMatchObject({
			kind: "request-failed",
		});
	});
});

describe("verifyOutcome on this dashboard's own check", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("a real receipt from this dashboard's own check (no anchor) reads consistent, unanchored, never verified", async () => {
		dir = mkdtempSync(join(tmpdir(), "trust-words-"));
		const writer = createAuditWriter(dir);
		await writer.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { model: "claude-sonnet-4-6", cost: 5, settled: true, transferId: "tx_words" },
		});
		writer.release();
		// The call the server's /api/verify makes: no anchor inputs.
		const result = verifyTransaction(join(dir, ".usertrust"), "tx_words");
		expect(result.found && result.valid).toBe(true);
		expect(result.receipt).toContain("UNANCHORED");
		expect(verifyOutcome(200, result).kind).toBe("consistent-unanchored");
	});
});

describe("heldFor: a verify response belongs to the row VERSION it was requested for", () => {
	const settled: LedgerRow = {
		seq: 13,
		id: "e13",
		ts: "2026-10-11T21:36:58.402Z",
		kind: "llm_call",
		actor: "local",
		transferId: "tx_7c1e1389",
		status: "settled",
		hash: "c".repeat(64),
		previousHash: "b".repeat(64),
		integrity: "verified",
	};

	it("shown for the row it was requested for", () => {
		expect(heldFor({ row: settled, value: "VERIFIED" }, settled)).toBe("VERIFIED");
		expect(heldFor(null, settled)).toBeNull();
	});

	// The race: verify is clicked while the row reads settled; before the response lands, a live correction makes
	// the transfer ambiguous. Clearing the panel on the status change ran BEFORE the in-flight response landed, so the
	// earlier status's receipt was then shown beside the new status.
	it("red-first (an earlier status's receipt landed after the correction): never shown on the corrected row", () => {
		const held = { row: settled, value: "VERIFIED (as settled)" };
		const [corrected] = applyStatusChanges(
			[settled],
			[{ id: settled.id, hash: settled.hash, status: "ambiguous" }],
		) as [LedgerRow];
		expect(corrected.status).toBe("ambiguous");
		expect(corrected.hash).toBe(settled.hash);
		expect(heldFor(held, corrected)).toBeNull();
	});

	it("a status that changes and changes BACK is still a new version: the old receipt stays hidden", () => {
		const held = { row: settled, value: "VERIFIED (first settled)" };
		const [ambiguous] = applyStatusChanges(
			[settled],
			[{ id: settled.id, hash: settled.hash, status: "ambiguous" }],
		) as [LedgerRow];
		const [again] = applyStatusChanges(
			[ambiguous],
			[{ id: settled.id, hash: settled.hash, status: "settled" }],
		) as [LedgerRow];
		expect(again.status).toBe(settled.status);
		expect(heldFor(held, again)).toBeNull();
	});

	it("an unrelated row's correction leaves the held response shown", () => {
		const other = { ...settled, id: "e14", hash: "d".repeat(64) };
		const held = { row: settled, value: "VERIFIED" };
		const [same] = applyStatusChanges(
			[settled, other],
			[{ id: other.id, hash: other.hash, status: "failed" }],
		) as [LedgerRow];
		expect(same).toBe(settled);
		expect(heldFor(held, same)).toBe("VERIFIED");
	});
});
