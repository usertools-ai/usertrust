// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * An unparseable `--successor-pin` must reach the VERDICT.
 *
 * Split out of `false-ok.test.ts` because the change it covers is not the
 * one-line kind the rest of that file holds. `anchor-verify` carries a verdict
 * lattice — UNANCHORED / ANCHORED_VERIFIED / ANCHOR_STALE / ANCHOR_UNVERIFIABLE
 * / ANCHOR_INVALID / ANCHOR_MISMATCH — with precedence rules, several
 * early-return paths, and a byte-identical twin in `packages/verify`. Three
 * review rounds each found a defect in the previous round's FIX rather than in
 * the original code:
 *
 *   1. the pin was discarded silently;
 *   2. fixed → recorded into `errors`, which the verdict does not read;
 *   3. fixed → validated inside `verifyAnchorChain`, which the UNANCHORED
 *      early-return skips entirely;
 *   4. fixed → returned immediately, short-circuiting the anchor-content checks
 *      and masking ANCHOR_MISMATCH, which OUTRANKS ANCHOR_INVALID.
 *
 * Each correction was sound in isolation and wrong about its surroundings —
 * which is what editing a state machine through a peephole looks like. On its
 * own branch the whole lattice is the diff, so a reviewer can see the precedence
 * rather than one arm of it.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateAnchoredVault, verifyAnchorChain } from "../../src/audit/anchor-verify.js";

describe("false OK — an unparseable --successor-pin", () => {
	// A real root, so the run gets past the root-key guard and reaches the pins.
	const rootPem = generateKeyPairSync("ed25519").publicKey.export({
		type: "spki",
		format: "pem",
	}) as string;

	it("REPORTS a pin it could not parse instead of dropping it", () => {
		const result = verifyAnchorChain([], {
			rootPem,
			successorPinsPem: ["-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----"],
		} as Parameters<typeof verifyAnchorChain>[1]);
		// The operator supplied a pin to CONSTRAIN which successor is acceptable.
		// Silently discarding it verified against a weaker trust set than they
		// asked for — and still reported success.
		expect(result.errors.join(" ")).toMatch(/successor pin #1 is not a parseable PEM/i);
	});

	it("names WHICH pin failed when several are supplied", () => {
		const result = verifyAnchorChain([], {
			rootPem,
			successorPinsPem: [rootPem, "garbage", rootPem],
		} as Parameters<typeof verifyAnchorChain>[1]);
		expect(result.errors.join(" ")).toMatch(/successor pin #2/i);
	});

	it("makes the PUBLIC verdict fail, not just an error string", () => {
		// The finding Codex caught in the first cut of this fix: `errors` does not
		// reach the verdict. `evaluateAnchoredVault` derives it from
		// `invalidReasons` + `mismatchReasons` alone, so recording only the error
		// left `verifyVaultWithAnchors` still answering ANCHORED_VERIFIED with exit
		// 0 — the reported input error changed nothing an auditor would see. Assert
		// at the level the verdict is actually read.
		const result = verifyAnchorChain([], {
			rootPem,
			successorPinsPem: ["nope"],
		} as Parameters<typeof verifyAnchorChain>[1]);
		expect(result.invalidReasons).toContain("malformed-successor-pin");
	});

	it("classifies as INVALID rather than falling into the MISMATCH default", () => {
		// An UNregistered reason lands in the default bucket at classification,
		// which is MISMATCH — the most severe verdict and the wrong one. A mismatch
		// means the anchors disagree with the vault; a malformed pin means the
		// operator's own input could not be read.
		const evaluation = evaluateAnchoredVault({
			orderedHashes: [],
			externalAnchors: [],
			externalErrors: [],
			mirrorAnchors: [],
			mirrorErrors: [],
			trust: { rootPem, successorPinsPem: ["nope"] },
			witness: { requested: false },
		} as Parameters<typeof evaluateAnchoredVault>[0]);
		expect(evaluation.anchorState).not.toBe("ANCHOR_MISMATCH");
	});

	it("rejects a malformed pin on an UNANCHORED vault, where the check matters most", () => {
		// The re-review finding. `evaluateAnchoredVault` returns UNANCHORED at the
		// discovery step for an empty or legacy vault, BEFORE trust material is
		// ever examined — so validating the pin inside `verifyAnchorChain` left
		// exactly the case with nothing to check still answering valid, exit 0.
		const evaluation = evaluateAnchoredVault({
			orderedHashes: [],
			externalAnchors: [],
			externalErrors: [],
			mirrorAnchors: [],
			mirrorErrors: [],
			trust: { rootPem, successorPinsPem: ["nope"] },
			witness: { requested: false },
		} as Parameters<typeof evaluateAnchoredVault>[0]);
		expect(evaluation.anchorState).toBe("ANCHOR_INVALID");
		expect(evaluation.anchorsValid).toBe(false);
		expect(evaluation.reasons).toContain("malformed-successor-pin");
	});

	it("still reports UNANCHORED for an empty vault whose pins are fine", () => {
		// The guard must not turn every unanchored vault into a failure.
		const evaluation = evaluateAnchoredVault({
			orderedHashes: [],
			externalAnchors: [],
			externalErrors: [],
			mirrorAnchors: [],
			mirrorErrors: [],
			trust: { rootPem, successorPinsPem: [rootPem] },
			witness: { requested: false },
		} as Parameters<typeof evaluateAnchoredVault>[0]);
		expect(evaluation.anchorState).toBe("UNANCHORED");
	});

	it("stays silent when every pin parses", () => {
		const result = verifyAnchorChain([], {
			rootPem,
			successorPinsPem: [rootPem],
		} as Parameters<typeof verifyAnchorChain>[1]);
		expect(result.errors.join(" ")).not.toMatch(/parseable PEM/i);
	});
});
