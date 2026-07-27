// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — REKOR RECEIPTS IN THE ANCHORED-VAULT FLOW (plan T5)
 *
 * The receipt verifier itself is covered by rekor-verify.test.ts. What is at
 * stake here is the GLUE: whether a receipt supplied alongside a vault changes
 * the verdict the way it must — evidence that verifies strengthens the vault's
 * freshness claim with a time the operator could not choose, and evidence that
 * does not verify fails the vault closed instead of being quietly dropped.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	exitCodeForAnchored as pkgExitCodeForAnchored,
	verifyVaultWithAnchors as pkgVerifyVaultWithAnchors,
} from "../../../../verify/src/index.js";
import { exitCodeForAnchored, verifyVaultWithAnchors } from "../../../src/audit/verify.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	storeRaw,
	verify,
} from "./fixtures.js";
import { makeRekorReceipt } from "./rekor-fixtures.js";

afterEach(() => {
	cleanupAll();
});

const ATTESTED_SECONDS = 1_760_000_000;

describe("HARDEN: Rekor receipts in verifyVaultWithAnchors", () => {
	it("1. a verifying receipt keeps the vault ANCHORED_VERIFIED and reports the attested time", async () => {
		const s = await makeAnchoredVault(3);
		const record = await anchorOnce(s);
		const f = makeRekorReceipt(record, { integratedTime: ATTESTED_SECONDS });

		const result = verify(s, {
			rekorReceiptsRaw: [JSON.stringify(f.receipt)],
			rekorLogPubkeysPem: [f.logPubkeyPem],
		});

		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.valid).toBe(true);
		expect(result.anchoring.rekor).toEqual({
			receiptsVerified: 1,
			receiptsFailed: 0,
			latestAttestedTimeMs: ATTESTED_SECONDS * 1000,
			errors: [],
		});
		expect(exitCodeForAnchored(result)).toBe(0);
	});

	it("2. no receipts supplied ⇒ no rekor block at all (additive)", async () => {
		const s = await makeAnchoredVault(2);
		await anchorOnce(s);
		const result = verify(s);
		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.rekor).toBeUndefined();
	});

	it("3. a tampered receipt is ANCHOR_INVALID with reason rekor-receipt-invalid and exit 1", async () => {
		const s = await makeAnchoredVault(3);
		const record = await anchorOnce(s);
		const f = makeRekorReceipt(record, { integratedTime: ATTESTED_SECONDS });
		const tampered = f.tamper((r) => {
			r.log.hashes[0] = "a".repeat(64);
		});

		const result = verify(s, {
			rekorReceiptsRaw: [JSON.stringify(tampered)],
			rekorLogPubkeysPem: [f.logPubkeyPem],
		});

		expect(result.anchorState).toBe("ANCHOR_INVALID");
		expect(result.valid).toBe(false);
		expect(result.anchoring.reasons).toContain("rekor-receipt-invalid");
		expect(result.anchoring.rekor?.receiptsVerified).toBe(0);
		expect(result.anchoring.rekor?.receiptsFailed).toBe(1);
		expect(result.errors.some((e) => e.includes("inclusion proof"))).toBe(true);
		expect(exitCodeForAnchored(result)).toBe(1);
	});

	it("4. an unparseable receipt fails closed rather than being ignored", async () => {
		const s = await makeAnchoredVault(2);
		await anchorOnce(s);
		const result = verify(s, { rekorReceiptsRaw: ['{"v":1,"nope":true}'] });
		expect(result.anchorState).toBe("ANCHOR_INVALID");
		expect(result.anchoring.rekor?.receiptsFailed).toBe(1);
	});

	it("5. a receipt for an anchorSeq the record set does not contain is INVALID", async () => {
		const s = await makeAnchoredVault(3);
		const record = await anchorOnce(s);
		const f = makeRekorReceipt(record);
		const orphan = f.tamper((r) => {
			r.anchorSeq = 99;
		});

		const result = verify(s, {
			rekorReceiptsRaw: [JSON.stringify(orphan)],
			rekorLogPubkeysPem: [f.logPubkeyPem],
		});

		expect(result.anchorState).toBe("ANCHOR_INVALID");
		expect(result.errors.some((e) => e.includes("receipt for unknown anchorSeq 99"))).toBe(true);
	});

	it("6. a custom log with no pinned key is refused, never trusted (D4)", async () => {
		const s = await makeAnchoredVault(3);
		const record = await anchorOnce(s);
		const f = makeRekorReceipt(record, { url: "https://log.example.org" });

		// The receipt is internally perfect — only the TRUST is missing.
		expect(
			verify(s, {
				rekorReceiptsRaw: [JSON.stringify(f.receipt)],
				rekorLogPubkeysPem: [f.logPubkeyPem],
			}).anchorState,
		).toBe("ANCHORED_VERIFIED");

		const unpinned = verify(s, { rekorReceiptsRaw: [JSON.stringify(f.receipt)] });
		expect(unpinned.anchorState).toBe("ANCHOR_INVALID");
		expect(unpinned.errors.some((e) => e.includes("custom log requires --rekor-pubkey"))).toBe(
			true,
		);
	});

	it("7. a receipts artifact holding no receipts fails closed (P2-5)", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);

		// The caller asked for receipt evidence and handed over a blank file. That
		// is a missing receipt, not an absence of a claim — treating it as "no
		// receipts supplied" would silently drop the evidence they meant to show.
		const result = verify(s, { rekorReceiptsRaw: ["  \n"] });

		expect(result.anchorState).toBe("ANCHOR_INVALID");
		expect(result.valid).toBe(false);
		expect(result.anchoring.reasons).toContain("rekor-receipt-invalid");
		expect(result.anchoring.rekor?.receiptsVerified).toBe(0);
		expect(result.anchoring.rekor?.receiptsFailed).toBe(1);
		expect(result.errors.some((e) => e.includes("receipts artifact contained no receipts"))).toBe(
			true,
		);
		expect(exitCodeForAnchored(result)).toBe(1);
	});

	it("8. JSONL input: several receipts for one anchor verify, newest attested time wins (D11)", async () => {
		const s = await makeAnchoredVault(3);
		const record = await anchorOnce(s);
		const older = makeRekorReceipt(record, { integratedTime: ATTESTED_SECONDS });
		const newer = makeRekorReceipt(record, { integratedTime: ATTESTED_SECONDS + 4242 });

		const result = verify(s, {
			rekorReceiptsRaw: [`${JSON.stringify(older.receipt)}\n${JSON.stringify(newer.receipt)}\n`],
			rekorLogPubkeysPem: [older.logPubkeyPem, newer.logPubkeyPem],
		});

		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.rekor?.receiptsVerified).toBe(2);
		expect(result.anchoring.rekor?.latestAttestedTimeMs).toBe((ATTESTED_SECONDS + 4242) * 1000);
	});
});

describe("HARDEN: attested-time staleness (clock gaming defeated)", () => {
	it("9. a stale ATTESTED time makes a fresh operator timestamp ANCHOR_STALE", async () => {
		const s = await makeAnchoredVault(3);
		const record = await anchorOnce(s);
		// Unanchored tail: --max-anchor-age only bites once the vault has moved on.
		await appendEvents(s.root, 2, 4);
		const nowMs = Date.parse(record.timestamp) + 1000;
		const f = makeRekorReceipt(record, {
			integratedTime: Math.floor(nowMs / 1000) - 30 * 86_400,
		});
		const policy = { maxAnchorAgeMs: 60_000, nowMs };

		// Operator-claimed time alone says fresh...
		expect(verify(s, policy).anchorState).toBe("ANCHORED_VERIFIED");

		// ...the witness says otherwise, and the witness is the one the operator
		// cannot choose.
		const attested = verify(s, {
			...policy,
			rekorReceiptsRaw: [JSON.stringify(f.receipt)],
			rekorLogPubkeysPem: [f.logPubkeyPem],
		});
		expect(attested.anchorState).toBe("ANCHOR_STALE");
		expect(
			attested.errors.some((e) => e.includes("--max-anchor-age (witness-attested time)")),
		).toBe(true);
	});

	it("10. a fresh ATTESTED time rescues an anchor whose operator timestamp looks stale", async () => {
		const s = await makeAnchoredVault(3);
		const record = await anchorOnce(s);
		await appendEvents(s.root, 2, 4);
		// The auditor's clock is 30 days ahead of the operator's claim.
		const nowMs = Date.parse(record.timestamp) + 30 * 86_400_000;
		const f = makeRekorReceipt(record, { integratedTime: Math.floor(nowMs / 1000) - 30 });
		const policy = { maxAnchorAgeMs: 60_000, nowMs };

		expect(verify(s, policy).anchorState).toBe("ANCHOR_STALE");

		const attested = verify(s, {
			...policy,
			rekorReceiptsRaw: [JSON.stringify(f.receipt)],
			rekorLogPubkeysPem: [f.logPubkeyPem],
		});
		expect(attested.anchorState).toBe("ANCHORED_VERIFIED");
		expect(attested.anchoring.rekor?.receiptsVerified).toBe(1);
	});

	it("11. only the NEWEST anchor's receipt drives freshness", async () => {
		const s = await makeAnchoredVault(3);
		const first = await anchorOnce(s);
		await appendEvents(s.root, 3, 4);
		const second = await anchorOnce(s);
		await appendEvents(s.root, 2, 7);
		const nowMs = Date.parse(second.timestamp) + 1000;

		// A stale receipt for the SUPERSEDED anchor must not age out the vault.
		const stale = makeRekorReceipt(first, {
			integratedTime: Math.floor(nowMs / 1000) - 30 * 86_400,
		});
		const result = verify(s, {
			maxAnchorAgeMs: 60_000,
			nowMs,
			rekorReceiptsRaw: [JSON.stringify(stale.receipt)],
			rekorLogPubkeysPem: [stale.logPubkeyPem],
		});
		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.rekor?.latestAttestedTimeMs).toBeNull();
	});
});

describe("HARDEN: core ↔ verify pkg behavior parity on the receipt path (D12)", () => {
	it("12. identical inputs produce deep-equal results and exit codes in both glues", async () => {
		const s = await makeAnchoredVault(3);
		const record = await anchorOnce(s);
		await appendEvents(s.root, 2, 4);
		const f = makeRekorReceipt(record, { integratedTime: ATTESTED_SECONDS });
		const tampered = f.tamper((r) => {
			r.log.rootHash = "b".repeat(64);
		});

		for (const receipt of [f.receipt, tampered]) {
			const params = {
				externalAnchorsRaw: [storeRaw(s)],
				trust: s.trust,
				rekorReceiptsRaw: [JSON.stringify(receipt)],
				rekorLogPubkeysPem: [f.logPubkeyPem],
				nowMs: Date.parse(record.timestamp) + 1000,
			};
			const core = verifyVaultWithAnchors(s.vaultPath, params);
			const pkg = pkgVerifyVaultWithAnchors(s.vaultPath, params);
			expect(pkg).toEqual(core);
			expect(pkgExitCodeForAnchored(pkg)).toBe(exitCodeForAnchored(core));
		}
	});
});
