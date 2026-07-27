// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — VERIFIER/GLUE/CLI regressions for the implementation review
 * findings: signature-blind dedup (order-dependent verdict), post-rotation
 * --tx inclusion, lone-checkpoint false-mismatch, witness empty-body bypass,
 * and the result-shape contract (unanchoredTail.sinceTimestampMs).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyTransaction as pkgVerifyTransaction } from "../../../../verify/src/index.js";
import { canonicalize } from "../../../src/audit/canonical.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	rotateOnce,
	signRecord,
	storeRaw,
	storeRecords,
	verify,
} from "./fixtures.js";

afterEach(() => {
	cleanupAll();
});

describe("HARDEN: benign-duplicate dedup is signature-checked (order-independent)", () => {
	it("a committed-equal twin with a BAD signature is ANCHOR_INVALID regardless of record order", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const { sig: _sig, ...payload } = r1;
		// Same committed content, different timestamp, GARBAGE signature.
		const badTwin = {
			...payload,
			timestamp: new Date(Date.parse(r1.timestamp) + 1000).toISOString(),
			sig: Buffer.from("not-a-valid-signature").toString("base64"),
		};
		// Order A: valid first, bad twin second.
		const a = verify(s, { external: [`${canonicalize(r1)}\n${canonicalize(badTwin)}\n`] });
		expect(a.anchorState).toBe("ANCHOR_INVALID");
		expect(a.anchoring.reasons).toContain("sig-invalid");
		// Order B: bad twin first, valid second — verdict must not flip.
		const b = verify(s, { external: [`${canonicalize(badTwin)}\n${canonicalize(r1)}\n`] });
		expect(b.anchorState).toBe("ANCHOR_INVALID");
		expect(b.anchoring.reasons).toContain("sig-invalid");
	});

	it("a committed-equal twin with a VALID signature stays a benign duplicate", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const { sig: _sig, ...payload } = r1;
		const goodTwin = signRecord(
			{ ...payload, timestamp: new Date(Date.parse(r1.timestamp) + 1000).toISOString() },
			s.keyFile,
		);
		const result = verify(s, { external: [`${canonicalize(r1)}\n${canonicalize(goodTwin)}\n`] });
		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.warnings).toContain("duplicate-anchor");
	});
});

describe("HARDEN: post-rotation --tx inclusion (no false INCLUSION FAILED)", () => {
	it("an event covered only by a post-rotation anchor verifies with root-key trust alone", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 1, 4);
		const successor = await rotateOnce(s);
		await appendEvents(s.root, 2, 5); // events 5,6 under the new epoch
		await anchorOnce(s, successor.keyFile); // covers up to treeSize 6

		// Vault verdict is ANCHORED_VERIFIED with only the root pinned (§6/row 27).
		const vault = verify(s);
		expect(vault.anchorState).toBe("ANCHORED_VERIFIED");

		// A tx in the post-rotation region must NOT report INCLUSION FAILED just
		// because its covering anchor was signed by the in-chain successor key.
		const tx = pkgVerifyTransaction(s.vaultPath, "tr_5", {
			externalAnchorsRaw: [storeRaw(s)],
			trust: s.trust, // root only — no successor pin supplied
			witness: { requested: false },
		});
		expect(tx.valid).toBe(true);
		expect(tx.receipt).toContain("INCLUSION VERIFIED (anchor #");
	});
});

describe("HARDEN: lone external checkpoint (partial history, not tampered)", () => {
	it("a single anchorSeq>1 checkpoint with no mirror is ANCHORED_VERIFIED + partial-history warning", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 2, 4);
		await anchorOnce(s);
		const latest = storeRecords(s).at(-1) as NonNullable<ReturnType<typeof storeRecords>[0]>;
		expect(latest.anchorSeq).toBe(2);
		// Wipe the mirror so no local linkage back to genesis is available.
		writeFileSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"), "");

		const result = verify(s, { external: [canonicalize(latest)] });
		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.warnings).toContain("partial-history");
		expect(result.valid).toBe(true);
	});

	it("a GAP between two present records is still a hard ANCHOR_MISMATCH", async () => {
		const s = await makeAnchoredVault(2);
		await anchorOnce(s);
		await appendEvents(s.root, 2, 3);
		await anchorOnce(s);
		await appendEvents(s.root, 2, 5);
		await anchorOnce(s);
		const recs = storeRecords(s);
		const gapped = [recs[0], recs[2]].map((r) => canonicalize(r as object)).join("\n");
		writeFileSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"), "");
		const result = verify(s, { external: [gapped] });
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("anchor-chain-gap");
	});
});

describe("HARDEN: witness external-source gating (AC-2.4 defense in depth)", () => {
	it("witnessOk with zero parsed external records does not launder mirror into anchorSource=external", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		// Simulate a 200-empty-body witness: witness.ok true but no external
		// records supplied. Mirror is intact and valid.
		const result = verify(s, {
			external: [],
			witness: { requested: true, ok: true },
		});
		expect(result.anchoring.anchorSource).toBe("vault-mirror");
	});
});

describe("HARDEN: result-shape contract (spec §7.3)", () => {
	it("unanchoredTail exposes sinceTimestampMs as a number|null, not an ISO string", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const result = verify(s);
		const tail = result.anchoring.unanchoredTail as unknown as Record<string, unknown>;
		expect("sinceTimestampMs" in tail).toBe(true);
		expect("sinceTimestamp" in tail).toBe(false);
		expect(typeof result.anchoring.unanchoredTail.sinceTimestampMs).toBe("number");
		expect(result.anchoring.unanchoredTail.sinceTimestampMs).toBe(Date.parse(r1.timestamp));
	});
});

// touch: keep readFileSync imported for potential future fixtures
void readFileSync;
