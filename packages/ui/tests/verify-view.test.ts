// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { applyStatusChanges } from "../src/shared/live.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { heldFor, verifyOutcome } from "../src/shared/verify-view.js";

describe("verifyOutcome", () => {
	it("found and valid: VERIFIED", () => {
		expect(
			verifyOutcome(200, { found: true, valid: true, receipt: "R", errors: [], status: "SETTLED" }),
		).toEqual({ kind: "verified", receipt: "R" });
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
		expect(verifyOutcome(200, { found: "yes", valid: true, receipt: "R" })).toMatchObject({
			kind: "request-failed",
		});
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
