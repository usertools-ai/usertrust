// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — the absence of witnessing must be REPORTABLE, not silent.
 *
 * The defect this closes, measured on this repo: `verifySuppliedRekorReceipts`
 * returns null when no receipts are supplied, so nothing downstream changed and
 * a vault that had NEVER been witnessed verified byte-identically to one that
 * had — reporting ANCHORED_VERIFIED while doing it. The Rekor sink was
 * structurally non-functional for six months and no verdict noticed, because a
 * verifier that cannot report the absence of its own strongest evidence has
 * nothing to report.
 */

import { describe, expect, it } from "vitest";
import {
	exitCodeForAnchored,
	foldWitnessLog,
	type RekorReport,
} from "../../../src/audit/verify.js";

const report = (covered: number[], invalid: number[] = []): RekorReport => ({
	receiptsVerified: covered.length,
	receiptsFailed: invalid.length,
	coveredAnchorSeqs: covered,
	invalidAnchorSeqs: invalid,
	latestAttestedTimeMs: null,
	errors: [],
});

describe("foldWitnessLog", () => {
	it("reports UNKNOWN — never a clean verdict — when nothing was supplied", () => {
		// THE regression. Before this existed, this case produced no signal at all.
		const r = foldWitnessLog([1, 2, 3], null);
		expect(r.state).toBe("WITNESS_UNKNOWN");
		expect(r.unknown).toBe(3);
		expect(r.covered).toBe(0);
		expect(r.reasons).toContain("witness-undeclared");
	});

	it("VERIFIED requires EVERY anchor covered, not merely one", () => {
		expect(foldWitnessLog([1, 2, 3], report([1, 2, 3])).state).toBe("WITNESS_VERIFIED");
	});

	it("one uncovered anchor beside nine covered ones is NOT verified", () => {
		// The vacuous-truth guard. A fold over RECEIPTS would let the tenth anchor
		// contribute nothing and vanish, and nine-of-ten would read as fully
		// witnessed. The fold is over anchors precisely so it cannot.
		const anchors = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const r = foldWitnessLog(anchors, report([1, 2, 3, 4, 5, 6, 7, 8, 9]));
		expect(r.state).toBe("WITNESS_UNKNOWN");
		expect(r.covered).toBe(9);
		expect(r.unknown).toBe(1);
	});

	it("an empty fold is UNKNOWN, not VERIFIED", () => {
		// Zero anchors makes every "all anchors are covered" test trivially true.
		const r = foldWitnessLog([], null);
		expect(r.state).toBe("WITNESS_UNKNOWN");
		expect(r.reasons).toContain("witness-no-anchors");
	});

	it("a failing receipt outranks a passing one for the same anchor", () => {
		// A forgery sitting beside a good receipt is evidence of an attempt, not
		// noise to discard in favour of the one that happens to pass.
		const r = foldWitnessLog([1, 2], report([1, 2], [2]));
		expect(r.state).toBe("WITNESS_INVALID");
		expect(r.invalid).toBe(1);
	});

	it("a lone covered anchor at seq 10 is NOT verified (Codex #128 F2)", () => {
		// anchorSeq is 1-based and contiguous, so a newest anchor of 10 asserts
		// that 1..9 existed. Folding over only the records in hand returned
		// WITNESS_VERIFIED and passed --require-witness while nine anchors went
		// unaccounted for. `partial-history` is legitimately accepted for
		// anchorState; it is not a witness claim.
		const r = foldWitnessLog([10], report([10]));
		expect(r.state).toBe("WITNESS_UNKNOWN");
		expect(r.unknown).toBe(9);
		expect(r.covered).toBe(1);
		expect(r.reasons).toContain("witness-history-gap");
	});

	it("a gap in the middle of the history is unknown, not verified", () => {
		const r = foldWitnessLog([1, 2, 5], report([1, 2, 5]));
		expect(r.state).toBe("WITNESS_UNKNOWN");
		expect(r.unknown).toBe(2); // seq 3 and 4
		expect(r.reasons).toContain("witness-history-gap");
	});

	it("a contiguous fully covered history is still VERIFIED", () => {
		// The guard must not make the good case unreachable.
		const r = foldWitnessLog([1, 2, 3], report([1, 2, 3]));
		expect(r.state).toBe("WITNESS_VERIFIED");
		expect(r.reasons).not.toContain("witness-history-gap");
	});

	it("duplicate anchorSeqs do not inflate the count", () => {
		const r = foldWitnessLog([1, 1, 2, 2], report([1, 2]));
		expect(r.anchors).toBe(2);
		expect(r.state).toBe("WITNESS_VERIFIED");
	});

	it("counts every anchor exactly once", () => {
		const r = foldWitnessLog([1, 2, 3, 4], report([1], [2]));
		expect(r.covered + r.unknown + r.invalid).toBe(r.anchors);
		expect(r.anchors).toBe(4);
	});
});

describe("exitCodeForAnchored --require-witness", () => {
	const base = {
		valid: true,
		anchorState: "ANCHORED_VERIFIED" as const,
		anchoring: { anchorSource: "external" as const },
	};

	it("is opt-in: default exit codes are unchanged by an unwitnessed vault", () => {
		// A vault that verified clean yesterday must still verify clean today.
		const unwitnessed = {
			...base,
			anchoring: { ...base.anchoring, witnessLog: foldWitnessLog([1], null) },
		};
		expect(exitCodeForAnchored(unwitnessed)).toBe(0);
	});

	it("fails an unwitnessed vault when the caller asks to be held to it", () => {
		const unwitnessed = {
			...base,
			anchoring: { ...base.anchoring, witnessLog: foldWitnessLog([1], null) },
		};
		expect(exitCodeForAnchored(unwitnessed, { requireWitness: true })).toBe(1);
	});

	it("passes a fully witnessed vault under the same flag", () => {
		const witnessed = {
			...base,
			anchoring: { ...base.anchoring, witnessLog: foldWitnessLog([1], report([1])) },
		};
		expect(exitCodeForAnchored(witnessed, { requireWitness: true })).toBe(0);
	});

	it("fails closed when the field is absent entirely", () => {
		// An older result shape must not satisfy a witness requirement by omission
		// — absence of a statement is not a statement.
		expect(exitCodeForAnchored(base, { requireWitness: true })).toBe(1);
	});
});
