// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `verifyTransaction`'s `inclusionVerified`: true ONLY when the transaction's inclusion was proven against a verified
 * anchor root on a valid chain. These rows pin each way it must be false, including the one a reader of the
 * dashboard takes (no anchor inputs on a valid chain), where `valid`, `chainVerified` and `merkleVerified` are all
 * true, so a flag computed from any of them would read true there.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyTransaction as pkgVerifyTransaction } from "../../../../verify/src/index.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	storeRaw,
	verify,
} from "./fixtures.js";

afterEach(() => {
	cleanupAll();
});

describe("inclusionVerified", () => {
	it("a valid chain checked with NO anchor inputs: valid, and inclusionVerified false", async () => {
		const s = await makeAnchoredVault(3);
		const tx = pkgVerifyTransaction(s.vaultPath, "tr_2");
		expect(tx.found).toBe(true);
		expect(tx.valid).toBe(true);
		expect(tx.receipt).toContain("CHAIN CONSISTENT (UNANCHORED)");
		expect(tx.inclusionVerified).toBe(false);
	});

	it("an anchored transaction whose inclusion proof holds, in a vault whose unanchored tail was edited: inclusionVerified false", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 2, 4);
		// Edit one tail event in place (no re-chain): its hash no longer matches, so the chain is broken past the
		// anchor, while the anchor's own range (and so tr_2's inclusion proof) is untouched.
		const logPath = join(s.vaultPath, "audit", "events.jsonl");
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		const last = JSON.parse(lines[lines.length - 1] as string) as { data: Record<string, unknown> };
		last.data = { ...last.data, cost: 999 };
		lines[lines.length - 1] = JSON.stringify(last);
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		const vault = verify(s);
		expect(vault.valid).toBe(false);
		const tx = pkgVerifyTransaction(s.vaultPath, "tr_2", {
			externalAnchorsRaw: [storeRaw(s)],
			trust: s.trust,
			witness: { requested: false },
		});
		expect(tx.found).toBe(true);
		expect(tx.valid).toBe(false);
		expect(tx.inclusionVerified).toBe(false);
	});

	it("control: the same anchored transaction on the untouched vault: inclusionVerified true", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 2, 4);
		const tx = pkgVerifyTransaction(s.vaultPath, "tr_2", {
			externalAnchorsRaw: [storeRaw(s)],
			trust: s.trust,
			witness: { requested: false },
		});
		expect(tx.valid).toBe(true);
		expect(tx.receipt).toContain("INCLUSION VERIFIED (anchor #");
		expect(tx.inclusionVerified).toBe(true);
	});
});
