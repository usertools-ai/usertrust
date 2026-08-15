// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Task 4 — receipt-spec §7 step 9, and the CUMULATIVE ladder.
 *
 * Step 9 is the only place in the procedure where a check can make the verdict
 * BETTER, which makes it the only place where a missing check is invisible: a
 * history walk that forgets a rule still issues `VERIFIED_CHECKPOINT_HISTORY`,
 * and nothing about the output looks wrong. So the suite is organised around
 * the four claims that failure mode breaks:
 *
 *  1. every rule §7's history paragraph names is INDIVIDUALLY load-bearing —
 *     one mutant per rule, each of which upgrades if the rule is absent;
 *  2. `anchorEvidence` is reported OUT OF BAND (CLI spec §5). Absent ⇒ the §7
 *     value `notApplicable`; PRESENT ⇒ omitted from `checks` entirely and named
 *     in `unimplemented`, because none of §7's four values means "the verifier
 *     declined to look";
 *  3. the ladder is cumulative, so `VERIFIED_ANCHORED` — which needs history
 *     AND validated anchor evidence — is UNREACHABLE in this build. Asserted
 *     over the whole corpus, not argued;
 *  4. an extension NEVER demotes. Every history mutant here is a base-verdict
 *     pass with a `failed` extension beside it, and the top-level `failure`
 *     stays null — that is what "upgrade-only" means to the exit code.
 */

import { describe, expect, it } from "vitest";
import {
	type JsonObject,
	type JsonValue,
	loadTrustSnapshot,
	type ReceiptExtensionMaterial,
	type ReceiptReport,
	type ReceiptVerdict,
	type TrustSnapshot,
	verifyReceipt,
} from "../../src/receipt-verify.js";
import {
	ALL_VECTORS,
	ENVELOPE_VECTORS,
	type Expectation,
	HISTORY_VECTORS,
	type Vector,
	vector,
} from "./fixtures.js";
import {
	CHECKPOINT_KEY,
	checkpointPreimage,
	FOREIGN_KEY,
	type MintedBundle,
	mint,
	otherHash,
	type SegmentCheckpoint,
	signEd25519,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// Running a vector through the FULL verifier (base + step 9).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The extension material as the resolver would hand it over: parsed JSON, not
 * the harness's live objects. The round trip matters — step 9 must treat every
 * member as untrusted wire data, and a test that passed the harness's own
 * object graph would be handing the verifier material it never sees in
 * production.
 *
 * Envelope FRAMING (`receiptBytes` authority, the R4 agreement check,
 * `apiVersion`) is Task 5's; this file supplies only what step 9 consumes.
 */
function extensionsOf(bundle: MintedBundle, mode: Vector["mode"]): ReceiptExtensionMaterial {
	if (mode !== "envelope") return {};
	const envelope = JSON.parse(JSON.stringify(bundle.envelope)) as JsonObject;
	const material: { checkpointHistory?: JsonValue; anchorEvidence?: JsonValue } = {};
	if (envelope.checkpointHistory !== undefined) {
		material.checkpointHistory = envelope.checkpointHistory;
	}
	if (envelope.anchorEvidence !== undefined) material.anchorEvidence = envelope.anchorEvidence;
	return material;
}

function snapshotOf(bundle: MintedBundle): TrustSnapshot {
	const load = loadTrustSnapshot(bundle.snapshotBytes);
	if (!load.ok) throw new Error(`fixture snapshot did not load: ${load.detail}`);
	return load.snapshot;
}

function runVector(v: Vector): ReceiptReport {
	const bundle = v.build();
	return verifyReceipt({
		receiptBytes: bundle.receiptBytes,
		snapshot: snapshotOf(bundle),
		extensions: extensionsOf(bundle, v.mode),
	});
}

/**
 * The verdict for a vector whose snapshot may itself be one of the corpus's
 * §4 structural mutants. A snapshot that will not load is UNVERIFIABLE by CLI
 * spec §5 and never reaches a verifier at all — reported as such rather than
 * skipped, so the sweep below covers every vector instead of the convenient
 * ones.
 */
function verdictOf(v: Vector): ReceiptVerdict {
	const bundle = v.build();
	const load = loadTrustSnapshot(bundle.snapshotBytes);
	if (!load.ok) return "UNVERIFIABLE";
	return verifyReceipt({
		receiptBytes: bundle.receiptBytes,
		snapshot: load.snapshot,
		extensions: extensionsOf(bundle, v.mode),
	}).verdict;
}

/** Run a bundle with an explicitly supplied history, bypassing the envelope. */
function runWithHistory(bundle: MintedBundle, history: JsonValue): ReceiptReport {
	return verifyReceipt({
		receiptBytes: bundle.receiptBytes,
		snapshot: snapshotOf(bundle),
		extensions: { checkpointHistory: history },
	});
}

function asJson(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** The default three-segment history, as wire JSON, ready to be mutated. */
function historyOf(bundle: MintedBundle): JsonObject[] {
	return asJson(bundle.history) as JsonObject[];
}

/**
 * Sign an edited unsigned statement. Every structural mutant below is RE-SIGNED
 * rather than left broken: a mutant that also breaks its own signature proves
 * only that the signature check works, and would pass a walk that implements
 * nothing else.
 */
function resign(unsigned: Record<string, unknown>): JsonValue {
	return {
		...unsigned,
		sig: signEd25519(CHECKPOINT_KEY, checkpointPreimage(unsigned)),
	} as unknown as JsonValue;
}

function assertExpectation(name: string, expected: Expectation, actual: ReceiptReport): void {
	expect(actual.verdict, name).toBe(expected.verdict);
	// An extension result NEVER becomes the run's failure: §7 step 9 is
	// upgrade-only, and the exit code is computed from these two fields.
	expect(actual.failure, name).toBeNull();
	expect(actual.missing, name).toBeNull();

	const extension = expected.extension;
	if (extension !== undefined) {
		expect(extension.check, `${name}: this build only reports checkpointHistory`).toBe(
			"checkpointHistory",
		);
		expect(actual.checks.checkpointHistory.result, name).toBe(extension.result);
		expect(actual.checks.checkpointHistory.failure?.code, name).toBe(extension.code);
		// WHICH clause refused, not merely that one did. `HISTORY_INVALID` covers
		// a dozen rules, so a vector asserting the code alone stays green when an
		// earlier clause catches its mutant — and the rule it was written for is
		// then dead with nothing to show it.
		if (extension.detail !== undefined) {
			expect(actual.checks.checkpointHistory.failure?.detail, name).toContain(extension.detail);
		}
		// The step ledger and the named check are the same fact reported twice;
		// they must never disagree.
		expect(actual.steps.extensions, name).toEqual(actual.checks.checkpointHistory);
	}
	expect([...actual.unimplemented], name).toEqual([...(expected.unimplemented ?? [])]);
}

/**
 * Vectors whose subject is the resolver's unsigned WRAPPER — Task 5's. Named as
 * a set rather than filtered by mode so a new envelope vector cannot silently
 * drop out of the sweeps below.
 */
const FRAMING_ONLY = new Set(ENVELOPE_VECTORS.map((v) => v.name));

// ─────────────────────────────────────────────────────────────────────────────

describe("§7 step 9 — the history walk, rule by rule", () => {
	it.each(HISTORY_VECTORS.map((v) => [v.name, v] as const))("%s", (name, v) => {
		assertExpectation(name, v.expect, runVector(v));
	});

	it("upgrades a complete, genesis-rooted, fully signed history", () => {
		const v = vector("pass/envelope-clean-history");
		const report = runVector(v);
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
		expect(report.checks.checkpointHistory.result).toBe("passed");
		expect(report.steps.extensions.result).toBe("passed");
		expect(report.failure).toBeNull();
	});

	it("every history mutant would UPGRADE if its rule were missing", () => {
		// The claim the corpus cannot make on its own. Each of these vectors is a
		// clean base verdict with a history that differs from the clean one by
		// exactly one fact, so a walk that skipped that rule would hand out the
		// history rung. That is what makes each rule load-bearing rather than
		// decorative, and it is the only reason the mutants are worth running.
		for (const v of HISTORY_VECTORS) {
			const report = runVector(v);
			expect(report.verdict, v.name).toBe("VERIFIED_CHECKPOINT");
			expect(report.checks.checkpointHistory.result, v.name).toBe("failed");
			expect(report.checks.checkpointHistory.failure?.code, v.name).toBe("HISTORY_INVALID");
			expect(report.checks.checkpointHistory.failure?.detail, v.name).not.toBe("");
		}
	});
});

describe("§7 step 9 — history material the walk must refuse structurally", () => {
	it("refuses a history that is not an array", () => {
		const report = runWithHistory(mint(), { segments: [] } as unknown as JsonValue);
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
	});

	it("refuses an EMPTY history rather than reading it as a clean walk", () => {
		// A zero-length walk satisfies every per-member rule vacuously. Without
		// this the emptiest possible input is the easiest upgrade in the system.
		const report = runWithHistory(mint(), []);
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
		// Named, not merely refused: the embedded-checkpoint clause would also
		// refuse an empty walk, so a code-only assertion leaves THIS guard free
		// to be deleted. Pinning the detail keeps the length check load-bearing.
		expect(report.checks.checkpointHistory.failure?.detail).toContain("empty");
	});

	it("refuses a member that is not a JSON object", () => {
		const bundle = mint();
		const history = historyOf(bundle);
		const report = runWithHistory(bundle, [
			history[0] as JsonValue,
			"seg_000002",
			history[2] as JsonValue,
		]);
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
		// The §4a shape check would ALSO refuse a bare string (`v` is not 2), so
		// without naming the clause this test cannot tell the type guard from its
		// downstream backstop — and the guard could be deleted unobserved.
		expect(report.checks.checkpointHistory.failure?.detail).toContain("is not a JSON object");
	});

	it("refuses a member that is not a §4a v2 statement", () => {
		// Step 1 never sees a history member, so the §4a member list is step 9's
		// to enforce: a reduced-and-re-signed payload verifies perfectly while the
		// lineage edge v2 exists to authenticate is simply gone.
		const bundle = mint();
		const history = historyOf(bundle);
		const member = history[1] as JsonObject;
		const { previousSegmentRoot: _dropped, sig: _sig, ...reduced } = member;
		const resigned = {
			...reduced,
			sig: signEd25519(CHECKPOINT_KEY, checkpointPreimage(reduced)),
		};
		const report = runWithHistory(bundle, [
			history[0] as JsonValue,
			resigned,
			history[2] as JsonValue,
		]);
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
		expect(report.checks.checkpointHistory.failure?.detail).toContain("previousSegmentRoot");
	});
});

describe("§7 step 9 — the §8 lineage binds every member, not just the receipt's", () => {
	it("refuses a member signed by a key outside the pinned lineage", () => {
		const bundle = mint({
			// Segment 1 is signed by the SUCCESSOR key, which the snapshot never
			// registers — a domain-wide key confers no authority here either.
			checkpointSigner: (index) => (index === 1 ? FOREIGN_KEY : CHECKPOINT_KEY),
		});
		const report = runWithHistory(bundle, asJson(bundle.history));
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
	});

	it("an unresolvable member key is HISTORY_INVALID, never UNVERIFIABLE", () => {
		// The line CLI spec §5 draws for the RECEIPT's own checkpoint (unresolvable
		// trust key ⇒ missing material ⇒ exit 2) must not leak into step 9: an
		// extension can never demote, so an unresolvable key in supplied optional
		// material is a failed extension beside an intact base verdict — not a
		// missing-material verdict for the receipt.
		const bundle = mint({
			checkpointSigner: (index) => (index === 0 ? FOREIGN_KEY : CHECKPOINT_KEY),
		});
		const report = runWithHistory(bundle, asJson(bundle.history));
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(report.missing).toBeNull();
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
	});

	it("refuses a member whose signing key is REVOKED", () => {
		const bundle = mint({
			snapshot: (snapshot) => {
				const key = snapshot.keys.find((k) => k.keyId === CHECKPOINT_KEY.keyId);
				if (key === undefined) throw new Error("no checkpoint key");
				key.state = "revoked";
				return snapshot;
			},
		});
		// The base verdict is itself FAILED here (step 6 owns the receipt's own
		// checkpoint), so the extension never runs — which is the point of the
		// next describe block, asserted from the other side.
		const report = runWithHistory(bundle, asJson(bundle.history));
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.code).toBe("CHECKPOINT_INVALID");
		expect(report.checks.checkpointHistory.result).toBe("unavailable");
	});
});

describe("§7 step 9 — contiguity arithmetic", () => {
	it("refuses a zero-leaf predecessor that stands still", () => {
		// §7 asks for "strictly increasing AND contiguous", and this is why the
		// two are separate clauses rather than one: with `prev.treeSize === 0` the
		// contiguity sum is satisfied by a successor that never moves, so the
		// arithmetic alone would walk a chain of empty segments forever.
		const bundle = mint();
		const history = historyOf(bundle);
		const { sig: _g, ...genesis } = history[0] as unknown as SegmentCheckpoint;
		const { sig: _s, ...second } = history[1] as unknown as SegmentCheckpoint;
		const standingStill = { ...second, segmentFirstSequence: genesis.segmentFirstSequence };
		const report = runWithHistory(bundle, [
			resign({ ...genesis, treeSize: 0 }),
			resign(standingStill),
			history[2] as JsonValue,
		]);
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
		expect(report.checks.checkpointHistory.failure?.detail).toContain("strictly increase");
	});

	it("refuses a contiguity sum that leaves the safe-integer range", () => {
		// `prev.first + prev.treeSize` is the comparison the whole walk rests on.
		// Both operands are safe integers, their SUM need not be, and an
		// imprecise sum compares equal to values that are not it. Cheap to close,
		// and the alternative is a walk that can be talked into agreeing.
		const bundle = mint();
		const history = historyOf(bundle);
		const { sig: _g, ...genesis } = history[0] as unknown as SegmentCheckpoint;
		const { sig: _s, ...second } = history[1] as unknown as SegmentCheckpoint;
		const report = runWithHistory(bundle, [
			resign({
				...genesis,
				segmentFirstSequence: 4503599627370496,
				treeSize: Number.MAX_SAFE_INTEGER,
			}),
			resign({ ...second, segmentFirstSequence: 4503599627370500 }),
			history[2] as JsonValue,
		]);
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
		expect(report.checks.checkpointHistory.failure?.detail).toContain("safe-integer");
	});

	it("refuses `-0` in a served checkpoint — the walk's integers are §13's, not JavaScript's", () => {
		// The gap this closes: history members never pass through
		// `readReceiptDocument`, so the frozen numeric rules never see them, and
		// the typed read standing in for those rules is `Number.isSafeInteger`,
		// which answers TRUE for `-0`. Every downstream comparison agrees too
		// (`-0 === 0`, `-0 < 0` is false), and `canonicalize` renders it as `0`,
		// so the signature over the HONEST statement verifies over the dishonest
		// bytes. Nothing in the walk can see the flip except `Object.is` — and
		// §13 forbids `-0` outright.
		//
		// The genesis boundary is where it bites: a zero-based chain's first
		// segment carries `segmentFirstSequence: 0`, and genesis is the one member
		// with no predecessor to contradict it.
		const bundle = mint({
			segments: [
				{ segmentId: "seg_000001", segmentFirstSequence: 0, treeSize: 4 },
				{ segmentId: "seg_000002", segmentFirstSequence: 4, treeSize: 6 },
				{ segmentId: "seg_000003", segmentFirstSequence: 10, treeSize: 7 },
			],
		});
		// Through the WIRE, not by handing the verifier a JS object: the flip has
		// to survive as text, which is exactly how a hostile resolver would serve
		// it. (`JSON.stringify(-0)` is `"0"`, so the object route cannot express
		// this vector at all.)
		const served = JSON.stringify(bundle.history).replace(
			'"segmentFirstSequence":0,',
			'"segmentFirstSequence":-0,',
		);
		const history = JSON.parse(served) as JsonObject[];
		expect(Object.is(history[0]?.segmentFirstSequence, -0)).toBe(true);

		const report = runWithHistory(bundle, history as unknown as JsonValue);
		// The base verdict is untouched — the receipt itself is clean.
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
	});

	it("refuses a history served out of order", () => {
		// §7: segmentIds "appear once each, in strictly increasing
		// segmentFirstSequence order". Sorting the input before walking would make
		// the served order unfalsifiable, so the order as SERVED is the claim.
		const bundle = mint();
		const history = historyOf(bundle);
		const report = runWithHistory(bundle, [
			history[0] as JsonValue,
			history[2] as JsonValue,
			history[1] as JsonValue,
		]);
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
	});

	it("refuses a head that stops short of the receipt's own segment", () => {
		const bundle = mint();
		const history = historyOf(bundle);
		const report = runWithHistory(bundle, [history[0] as JsonValue, history[1] as JsonValue]);
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
		expect(report.checks.checkpointHistory.failure?.detail).toContain("does not appear");
	});

	it("accepts a head BEYOND the receipt's segment", () => {
		// §7 asks for a head "at/after the receipt's segment" — a chain that has
		// sealed further segments since the mint must still upgrade, or the rung
		// would decay with time for no cryptographic reason.
		const bundle = mint({ mintSegmentIndex: 1, mintLeafIndex: 2 });
		const report = runWithHistory(bundle, asJson(bundle.history));
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
	});

	it("refuses a member whose root was rewritten without re-signing the edge", () => {
		const bundle = mint();
		const history = historyOf(bundle);
		const member = history[1] as JsonObject;
		const report = runWithHistory(bundle, [
			history[0] as JsonValue,
			{ ...member, root: otherHash("rewritten-root") },
			history[2] as JsonValue,
		]);
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
	});
});

describe("CLI spec §5 — anchorEvidence is reported OUT OF BAND", () => {
	it("absent evidence is the §7 value notApplicable", () => {
		const bundle = mint();
		const report = runWithHistory(bundle, asJson(bundle.history));
		expect(report.checks.anchorEvidence).toEqual({ result: "notApplicable" });
		expect(report.unimplemented).toEqual([]);
	});

	it("PRESENT evidence is omitted from `checks` and named in `unimplemented`", () => {
		// §7's four values describe the INPUT. `unavailable` means "exists but
		// could not be obtained"; none of them means "the verifier declined to
		// look", so reporting any of them here would misstate why the check did
		// not run. The consumer machine-detects the gap instead of inferring it.
		const v = vector("pass/anchor-evidence-present-is-unimplemented");
		const report = runVector(v);
		expect("anchorEvidence" in report.checks).toBe(false);
		expect(report.checks.anchorEvidence).toBeUndefined();
		expect(report.unimplemented).toEqual(["anchorEvidence"]);
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
	});

	it("present evidence with NO history does not upgrade past the checkpoint rung", () => {
		const bundle = mint();
		const report = verifyReceipt({
			receiptBytes: bundle.receiptBytes,
			snapshot: snapshotOf(bundle),
			extensions: { anchorEvidence: { kind: "rekor", logIndex: 918273 } },
		});
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(report.unimplemented).toEqual(["anchorEvidence"]);
		expect(report.checks.checkpointHistory.result).toBe("notApplicable");
	});

	it("declining to look is reported even when the base verdict is not green", () => {
		const bundle = mint({
			receiptAfterSign: (r) => ({ ...r, mintedAt: "2020-01-01T00:00:00.000Z" }),
		});
		const report = verifyReceipt({
			receiptBytes: bundle.receiptBytes,
			snapshot: snapshotOf(bundle),
			extensions: { anchorEvidence: { kind: "rekor" } },
		});
		expect(report.verdict).toBe("FAILED");
		expect(report.unimplemented).toEqual(["anchorEvidence"]);
		expect("anchorEvidence" in report.checks).toBe(false);
	});
});

describe("§7 — the ladder is CUMULATIVE", () => {
	it("VERIFIED_ANCHORED is unreachable in this build, over the whole corpus", () => {
		// Not an argument — a sweep. `VERIFIED_ANCHORED` requires history AND
		// validated anchor evidence (receipt-spec §7; verify-page §4.1 rule 3),
		// and this build validates no anchor evidence at all, so no input reaches
		// it. When the artifact-hash rule lands (§9's residual) this test is the
		// one that has to be deliberately changed.
		for (const v of ALL_VECTORS) {
			if (FRAMING_ONLY.has(v.name)) continue;
			expect(verdictOf(v), v.name).not.toBe("VERIFIED_ANCHORED");
		}
	});

	it("also unreachable when history passes AND anchor evidence is supplied", () => {
		const bundle = mint();
		const report = verifyReceipt({
			receiptBytes: bundle.receiptBytes,
			snapshot: snapshotOf(bundle),
			extensions: {
				checkpointHistory: asJson(bundle.history),
				anchorEvidence: { kind: "rekor", logIndex: 4 },
			},
		});
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
		expect(report.unimplemented).toEqual(["anchorEvidence"]);
	});

	it("history alone reaches exactly one rung above the base", () => {
		const bundle = mint();
		expect(runWithHistory(bundle, asJson(bundle.history)).verdict).toBe(
			"VERIFIED_CHECKPOINT_HISTORY",
		);
	});
});

describe("§7 step 9 — an extension never demotes, and never rescues", () => {
	it("a failed history leaves the base verdict, the amount and the posture intact", () => {
		const clean = runVector(vector("pass/envelope-clean-history"));
		const broken = runVector(vector("history/unsigned-member"));
		expect(broken.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(broken.failure).toBeNull();
		expect(broken.computed.amountUsd).toBe(clean.computed.amountUsd);
		expect(broken.posture).toEqual(clean.posture);
	});

	it("a clean history does not rescue a FAILED base verdict", () => {
		// The extension material is genuine and complete; the receipt is not. An
		// upgrade path that ran here would let optional, unsigned-by-the-minter
		// material carry a receipt that failed its own signature.
		const bundle = mint({
			receiptAfterSign: (r) => ({ ...r, mintedAt: "2020-01-01T00:00:00.000Z" }),
		});
		const report = runWithHistory(bundle, asJson(bundle.history));
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.step).toBe("signature");
		expect(report.checks.checkpointHistory.result).toBe("unavailable");
		expect(report.steps.extensions.result).toBe("unavailable");
	});

	it("a clean history does not rescue an UNVERIFIABLE receipt", () => {
		const bundle = mint({ bytes: (b) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) });
		const report = runWithHistory(bundle, asJson(bundle.history));
		expect(report.verdict).toBe("UNVERIFIABLE");
		expect(report.missing?.what).toBe("receiptBytes");
		expect(report.checks.checkpointHistory.result).toBe("unavailable");
	});

	it("no supplied history on a non-green base is notApplicable, not unavailable", () => {
		// `unavailable` says the input exists and could not be obtained;
		// `notApplicable` says it does not exist here. With nothing supplied the
		// second is the true statement, and it stays true whatever the base did.
		const bundle = mint({
			receiptAfterSign: (r) => ({ ...r, mintedAt: "2020-01-01T00:00:00.000Z" }),
		});
		const report = verifyReceipt({
			receiptBytes: bundle.receiptBytes,
			snapshot: snapshotOf(bundle),
		});
		expect(report.verdict).toBe("FAILED");
		expect(report.checks.checkpointHistory.result).toBe("notApplicable");
	});

	it("carries the base run's own fields through untouched", () => {
		const bundle = mint();
		const report = runWithHistory(bundle, asJson(bundle.history));
		expect(report.receiptId).toBe(bundle.receipt.receiptId);
		expect(report.computed.amountUsd).toBe("4.8224");
		expect(report.posture?.delegation).toBe("selfDebitsOnly");
		expect(report.checks.registryBinding).toEqual({ result: "notApplicable" });
		expect(report.checks.predecessorLinkage).toEqual({ result: "notApplicable" });
		expect(report.arrivalContext).toEqual({ result: "notApplicable", expected: null });
		expect(report.steps.schema.result).toBe("passed");
	});

	it("never throws, whatever the supplied history is", () => {
		// A throw is not a verdict (CLI spec §3). The walk canonicalizes untrusted
		// members, and `canonicalize` throws on non-finite numbers — which is why
		// §4a's member list and its types are checked before it is ever reached.
		const bundle = mint();
		const hostile: JsonValue[] = [
			null,
			42,
			"a string",
			[[]],
			[{ v: 2 }],
			[{ v: 2, treeSize: Number.POSITIVE_INFINITY }] as unknown as JsonValue,
			asJson(bundle.history[0]),
		];
		for (const history of hostile) {
			const report = runWithHistory(bundle, history);
			expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
			expect(report.checks.checkpointHistory.result).toBe("failed");
		}
	});
});
