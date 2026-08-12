// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Task 3 — receipt-spec §7 steps 1–8, the BASE verdict.
 *
 * Graded against the Task 1 corpus, whose expectations were read out of the
 * specs before any verifier existed. Three claims are asserted here, and the
 * third is the one a "reject the bad ones" suite always misses:
 *
 *  1. every receipt-mode vector reaches EXACTLY its declared verdict, and a
 *     FAILED one names the declared STEP and CODE — CLI spec §5's precedence
 *     rule is only meaningful if the code is checked, not just the redness;
 *  2. the UNVERIFIABLE/FAILED line holds in both directions, including the
 *     deliberate edge (key PRESENT but state forbids ⇒ FAILED, never
 *     UNVERIFIABLE) — the two verdicts carry different exit codes, so
 *     collapsing them is a real defect and not a wording preference;
 *  3. no step-9 mutant demotes the base verdict. Every history vector is a
 *     base-verdict PASS here, which is what "extension failure never demotes"
 *     means operationally.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	amountUsdFromAssessed,
	isCanonicalReceiptId,
	type JsonObject,
	loadTrustSnapshot,
	receiptIdFromArrivalContext,
	verifyCheckpointStatement,
	verifyReceiptBase,
} from "../../src/receipt-verify.js";
import {
	ALL_VECTORS,
	ENVELOPE_VECTORS,
	type Expectation,
	type Vector,
	vector,
} from "./fixtures.js";
import {
	ALT_RECEIPT_ID,
	DEFAULT_RECEIPT_ID,
	LEADING_ZERO_RECEIPT_ID,
	LONG_DECODE_RECEIPT_ID,
	mint,
	type Projection,
	SHORT_DECODE_RECEIPT_ID,
	type UnsignedReceipt,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// Running a vector through the base verifier.
// ─────────────────────────────────────────────────────────────────────────────

type Run = ReturnType<typeof verifyReceiptBase>;

/**
 * The snapshot load is part of the run, not a precondition: CLI spec §5 makes a
 * structurally invalid snapshot UNVERIFIABLE with `missing: trustSnapshot`, and
 * a test that loaded it separately could not assert that mapping at all.
 */
function run(v: Vector): Run {
	const bundle = v.build();
	const load = loadTrustSnapshot(bundle.snapshotBytes);
	if (!load.ok) {
		return {
			verdict: "UNVERIFIABLE",
			receiptId: null,
			steps: {
				schema: { result: "unavailable" },
				event: { result: "unavailable" },
				registry: { result: "unavailable" },
				signature: { result: "unavailable" },
				inclusion: { result: "unavailable" },
				checkpoint: { result: "unavailable" },
				semantics: { result: "unavailable" },
				derivations: { result: "unavailable" },
			},
			checks: {
				registryBinding: { result: "notApplicable" },
				predecessorLinkage: { result: "notApplicable" },
			},
			arrivalContext: { result: "notApplicable", expected: null },
			computed: { amountUsd: null },
			posture: null,
			failure: null,
			missing: { what: "trustSnapshot", detail: load.detail },
			verified: null,
		};
	}
	let arrivalId: string | undefined;
	if (v.expectId !== undefined) {
		const extracted = receiptIdFromArrivalContext(v.expectId);
		// A corpus vector whose arrival context does not parse would silently
		// become a `notApplicable` run and assert nothing.
		expect(extracted, `arrival context did not parse: ${v.expectId}`).not.toBeNull();
		arrivalId = extracted as string;
	}
	return verifyReceiptBase({
		receiptBytes: bundle.receiptBytes,
		snapshot: load.snapshot,
		...(arrivalId === undefined ? {} : { arrivalId }),
	});
}

function assertExpectation(name: string, expect_: Expectation, actual: Run): void {
	if (expect_.verdict === "FAILED") {
		expect(actual.verdict, name).toBe("FAILED");
		expect(actual.failure?.step, name).toBe(expect_.step);
		expect(actual.failure?.code, name).toBe(expect_.code);
		expect(actual.missing, name).toBeNull();
		return;
	}
	if (expect_.verdict === "UNVERIFIABLE") {
		expect(actual.verdict, name).toBe("UNVERIFIABLE");
		expect(actual.missing?.what, name).toBe(expect_.missing);
		expect(actual.failure, name).toBeNull();
		return;
	}
	expect(actual.verdict, name).toBe("VERIFIED_CHECKPOINT");
	expect(actual.failure, name).toBeNull();
	expect(actual.missing, name).toBeNull();
}

/**
 * Framing vectors (`--envelope`) are Task 5's: their subject is the resolver's
 * unsigned wrapper, which the base verifier never sees. Named as a set rather
 * than filtered by mode, so a future envelope vector cannot silently drop out
 * of the sweep below.
 */
const FRAMING_ONLY = new Set(ENVELOPE_VECTORS.map((v) => v.name));

const BASE_VECTORS = ALL_VECTORS.filter((v) => !FRAMING_ONLY.has(v.name));

// ─────────────────────────────────────────────────────────────────────────────

describe("§12 — the receipt-ID rule", () => {
	it("accepts an ID that decodes to 16 bytes and re-encodes byte-identically", () => {
		expect(isCanonicalReceiptId(DEFAULT_RECEIPT_ID)).toBe(true);
		expect(isCanonicalReceiptId(LEADING_ZERO_RECEIPT_ID)).toBe(true);
	});

	it("rejects a grammar-legal ID that decodes SHORT or LONG — the count is not the rule", () => {
		expect(isCanonicalReceiptId(SHORT_DECODE_RECEIPT_ID)).toBe(false);
		expect(isCanonicalReceiptId(LONG_DECODE_RECEIPT_ID)).toBe(false);
	});

	it("rejects a missing prefix, a non-alphabet character, and the out-of-grammar lengths", () => {
		expect(isCanonicalReceiptId(DEFAULT_RECEIPT_ID.slice(4))).toBe(false);
		expect(isCanonicalReceiptId("ut1_0OIl00000000000000")).toBe(false);
		expect(isCanonicalReceiptId("ut1_")).toBe(false);
		expect(isCanonicalReceiptId(`ut1_${"1".repeat(23)}`)).toBe(false);
	});
});

describe("§12 — arrival context extraction", () => {
	it("accepts the bare ID, the resolution URL, and the whole-line trailer", () => {
		for (const context of [
			DEFAULT_RECEIPT_ID,
			`https://usertrust.ai/r/${DEFAULT_RECEIPT_ID}`,
			`Usertrust-Receipt: https://usertrust.ai/r/${DEFAULT_RECEIPT_ID}`,
			`Usertrust-Receipt: https://usertrust.ai/r/${DEFAULT_RECEIPT_ID}\r\n`,
		]) {
			expect(receiptIdFromArrivalContext(context), context).toBe(DEFAULT_RECEIPT_ID);
		}
	});

	it("rejects the lexical variants §12 rules out", () => {
		for (const context of [
			` Usertrust-Receipt: https://usertrust.ai/r/${DEFAULT_RECEIPT_ID}`,
			`usertrust-receipt: https://usertrust.ai/r/${DEFAULT_RECEIPT_ID}`,
			`Usertrust-Receipt:  https://usertrust.ai/r/${DEFAULT_RECEIPT_ID}`,
			`Usertrust-Receipt: https://usertrust.ai/r/${DEFAULT_RECEIPT_ID} `,
			`Usertrust-Receipt: https://usertrust.ai/r/${DEFAULT_RECEIPT_ID} # comment`,
			`see https://usertrust.ai/r/${DEFAULT_RECEIPT_ID} for details`,
			`http://usertrust.ai/r/${DEFAULT_RECEIPT_ID}`,
			`https://evil.example/r/${DEFAULT_RECEIPT_ID}`,
			`https://usertrust.ai/r/${SHORT_DECODE_RECEIPT_ID}`,
			`${DEFAULT_RECEIPT_ID}\n${DEFAULT_RECEIPT_ID}`,
		]) {
			expect(receiptIdFromArrivalContext(context), context).toBeNull();
		}
	});
});

describe("§2 — amountUsd is COMPUTED on an integer path", () => {
	it("renders the four-decimal quotient/remainder of the default projection", () => {
		expect(amountUsdFromAssessed(48224)).toBe("4.8224");
	});

	it("pads the remainder and never loses a digit to float division", () => {
		expect(amountUsdFromAssessed(1)).toBe("0.0001");
		expect(amountUsdFromAssessed(10000)).toBe("1.0000");
		// The witness, found by search rather than assumed: for this assessed
		// value the float path overstates the last digit by one — a real
		// (if sub-cent) lie in the one number the document exists to report.
		// Quotient/remainder cannot produce it, because `%` and the subtraction
		// are exact on safe integers.
		expect((6788458427781391 / 10000).toFixed(4)).toBe("678845842778.1392");
		expect(amountUsdFromAssessed(6788458427781391)).toBe("678845842778.1391");
	});
});

describe("the corpus — steps 1–8", () => {
	for (const v of BASE_VECTORS) {
		if (v.mode === "receipt") {
			it(`${v.name}: ${v.what}`, () => {
				assertExpectation(v.name, v.expect, run(v));
			});
			continue;
		}
		// An envelope-mode vector that is NOT about framing is a step-9 vector:
		// its base verdict must be untouched. §7 step 9 in one assertion.
		it(`${v.name}: base verdict survives (extension failure never demotes)`, () => {
			const actual = run(v);
			expect(actual.verdict, v.name).toBe("VERIFIED_CHECKPOINT");
		});
	}
});

describe("the clean receipt", () => {
	const clean = run(vector("pass/canonical"));

	it("passes every base step and reports the offline checks by name", () => {
		expect(clean.verdict).toBe("VERIFIED_CHECKPOINT");
		for (const step of [
			"schema",
			"event",
			"signature",
			"inclusion",
			"checkpoint",
			"semantics",
			"derivations",
		] as const) {
			expect(clean.steps[step].result, step).toBe("passed");
		}
		// No arrival context was supplied, so 3(a) has nothing to compare.
		expect(clean.steps.registry.result).toBe("notApplicable");
		expect(clean.arrivalContext).toEqual({ result: "notApplicable", expected: null });
		expect(clean.checks.registryBinding.result).toBe("notApplicable");
		expect(clean.checks.predecessorLinkage.result).toBe("notApplicable");
	});

	it("carries the receipt identity, the computed amount and the posture labels", () => {
		expect(clean.receiptId).toBe(DEFAULT_RECEIPT_ID);
		expect(clean.computed.amountUsd).toBe("4.8224");
		expect(clean.posture).toEqual({
			delegation: "selfDebitsOnly",
			usage: "provider",
			pricing: "exact",
		});
	});

	it("hands step 9 the material it needs, and only on a base pass", () => {
		expect(clean.verified?.chain.vaultId).toBe("vlt_ut_proxy_prod_1");
		expect(clean.verified?.checkpoint.segmentId).toBe("seg_000003");
		expect(run(vector("signature/key-revoked")).verified).toBeNull();
	});

	it("reports step 8 as notApplicable when the >32-pair list is absent", () => {
		const absent = run(vector("pass/transfer-set-absent-above-32"));
		expect(absent.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(absent.steps.derivations.result).toBe("notApplicable");
		expect(absent.computed.amountUsd).toBe("4.8224");
	});
});

describe("step 3(a) — arrival context", () => {
	it("passes when the document's receiptId equals the ID it arrived under", () => {
		const passed = run(vector("pass/arrival-context-url"));
		expect(passed.steps.registry.result).toBe("passed");
		expect(passed.arrivalContext).toEqual({ result: "passed", expected: DEFAULT_RECEIPT_ID });
	});

	it("fails with ID_MISMATCH on a different ID, and says which was expected", () => {
		const mismatch = run(vector("arrival/id-mismatch"));
		expect(mismatch.failure).toMatchObject({ step: "registry", code: "ID_MISMATCH" });
		expect(mismatch.arrivalContext).toEqual({ result: "failed", expected: ALT_RECEIPT_ID });
	});
});

describe("the UNVERIFIABLE / FAILED line (CLI spec §5)", () => {
	// Every row of the table, named. The rows are already exercised by the
	// corpus sweep; restating them here is deliberate — the sweep proves the
	// corpus is green, and this proves the TABLE is what made it green.
	const unverifiable: readonly [string, string][] = [
		["parse/truncated", "receiptBytes"],
		["snapshot/unreadable", "trustSnapshot"],
		["snapshot/cyclic-lineage", "trustSnapshot"],
		["signature/key-absent-from-snapshot", "trustKey"],
		["checkpoint/key-unresolvable", "trustKey"],
		["snapshot/chain-not-registered", "trustKey"],
		["inclusion/proof-member-absent", "proof"],
		["inclusion/checkpoint-member-absent", "checkpoint"],
	];
	for (const [name, what] of unverifiable) {
		it(`${name} ⇒ UNVERIFIABLE (${what})`, () => {
			const actual = run(vector(name));
			expect(actual.verdict).toBe("UNVERIFIABLE");
			expect(actual.missing?.what).toBe(what);
			// Nothing FAILED: no step may carry a failure on a missing-material run.
			for (const step of Object.values(actual.steps)) expect(step.failure).toBeUndefined();
		});
	}

	// The deliberate edge. The material is PRESENT in all four; only the pinned
	// snapshot's STATE forbids it, which is a real negative answer.
	const stateForbids: readonly [string, string][] = [
		["signature/key-revoked", "SIG_INVALID"],
		["signature/retired-mint-key-out-of-bounds", "SIG_INVALID"],
		["signature/key-not-in-mint-key-ids", "SIG_INVALID"],
		["signature/key-wrong-role", "SIG_INVALID"],
		["checkpoint/key-revoked", "CHECKPOINT_INVALID"],
		["checkpoint/retired-key-out-of-bounds", "CHECKPOINT_INVALID"],
		["checkpoint/key-outside-pinned-lineage", "CHECKPOINT_INVALID"],
	];
	for (const [name, code] of stateForbids) {
		it(`${name} ⇒ FAILED ${code}, never UNVERIFIABLE`, () => {
			const actual = run(vector(name));
			expect(actual.verdict).toBe("FAILED");
			expect(actual.failure?.code).toBe(code);
			expect(actual.missing).toBeNull();
		});
	}

	it("verifies the retired key that IS in bounds — the boundary is a comparison, not a ban", () => {
		expect(run(vector("pass/retired-mint-key-in-bounds")).verdict).toBe("VERIFIED_CHECKPOINT");
		expect(run(vector("pass/retired-checkpoint-key-in-bounds")).verdict).toBe(
			"VERIFIED_CHECKPOINT",
		);
	});
});

describe("failure-code precedence (CLI spec §5)", () => {
	it("gives `minter.kind` to step 4, not to equality 7 — one condition, one code", () => {
		const actual = run(vector("signature/minter-kind-mismatch"));
		expect(actual.failure).toMatchObject({ step: "signature", code: "SIG_INVALID" });
		expect(actual.steps.event.result).toBe("passed");
	});

	it("gives an ABSENT `work` mirror to equality 9, not to step 1's schema walk", () => {
		const actual = run(vector("eq9/work-mirror-absent"));
		expect(actual.failure).toMatchObject({ step: "event", code: "EVENT_MISMATCH" });
		expect(actual.steps.schema.result).toBe("passed");
	});

	it("gives a step-7 length mismatch to step 7 even though step 8's root also moves", () => {
		const actual = run(vector("semantics/transfer-set-length-mismatch"));
		expect(actual.failure).toMatchObject({ step: "semantics", code: "SEMANTIC_INVALID" });
		expect(actual.steps.derivations.result).toBe("unavailable");
	});

	it("stops at the first failure: later steps are never reported as passed", () => {
		const actual = run(vector("eq1/mint-event-hash-differs"));
		expect(actual.steps.event.result).toBe("failed");
		for (const step of ["signature", "inclusion", "checkpoint", "semantics", "derivations"]) {
			expect(actual.steps[step as "signature"].result, step).toBe("unavailable");
		}
	});
});

describe("§2a — delegationPosture is load-bearing offline", () => {
	it("labels every value a v1 VERIFIER must recognize", () => {
		for (const value of ["selfDebitsOnly", "includesSomeDelegated", "indeterminate"]) {
			const bundle = mint({
				projection: (p: Projection) => ({ ...p, delegationPosture: value }),
			});
			const load = loadTrustSnapshot(bundle.snapshotBytes);
			if (!load.ok) throw new Error(load.detail);
			const actual = verifyReceiptBase({
				receiptBytes: bundle.receiptBytes,
				snapshot: load.snapshot,
			});
			expect(actual.verdict, value).toBe("VERIFIED_CHECKPOINT");
			expect(actual.posture?.delegation, value).toBe(value);
		}
	});

	it("never renders an amount for a posture it cannot interpret", () => {
		for (const name of [
			"semantics/delegation-posture-absent",
			"semantics/delegation-posture-unrecognized",
			"semantics/delegation-posture-includes-all-without-evidence",
		]) {
			const actual = run(vector(name));
			expect(actual.failure, name).toMatchObject({
				step: "semantics",
				code: "SEMANTIC_INVALID",
			});
			expect(actual.computed.amountUsd, name).toBeNull();
			expect(actual.posture, name).toBeNull();
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Paths the corpus does not reach, because every corpus receipt is a
// `kind: "commit"` receipt with every member present. They are still legal ut1
// documents and still Tier-0 code, so they are minted here rather than left as
// the one arm of the union nobody ever ran.
// ─────────────────────────────────────────────────────────────────────────────

function verifyMinted(options: Parameters<typeof mint>[0]): Run {
	const bundle = mint(options);
	const load = loadTrustSnapshot(bundle.snapshotBytes);
	if (!load.ok) throw new Error(`fixture snapshot did not load: ${load.detail}`);
	return verifyReceiptBase({ receiptBytes: bundle.receiptBytes, snapshot: load.snapshot });
}

function withWork(work: Record<string, unknown>): Run {
	return verifyMinted({ projection: (p: Projection) => ({ ...p, work }) });
}

const MEMBERSHIP = { status: "providerVerified", proofId: "pv_9f3a2c81d0" };
const REPO_ID = "github.com:R_kgDOK1x2Yw";
/**
 * Well-formed placeholders, and the reason they have to be well formed: step 1
 * now validates every member's DECLARED FORMAT (§2/§5), so a stand-in like
 * `oid: "x"` is refused as a schema failure and a vector built to isolate a
 * step-7 union rule would never reach step 7 at all. A mutant that fails for a
 * reason other than the one it is named after proves nothing about the rule it
 * was written for.
 */
const OID_SHA1 = "37df16d3a4c1b8e05f92d7a6c31e4b8079fa2d51";
const OBJECT_SHA256 = "b".repeat(64);
const CONTENT_SHA256 = "a".repeat(64);
/** `"c1_" + base64url(HMAC-SHA-256(…))` — a 32-byte MAC, per the resolver. */
const CONTENT_COMMITMENT = `c1_${createHash("sha256").update("usertrust/test-commitment").digest("base64url")}`;
const COMMIT_WORK = {
	kind: "commit",
	repoId: REPO_ID,
	oid: OID_SHA1,
	oidAlg: "sha1",
	objectSha256: OBJECT_SHA256,
	repositoryMembership: MEMBERSHIP,
};
const PUBLIC_BINDING = { kind: "publicSha256", sha256: CONTENT_SHA256 };
const ARTIFACT = {
	repoId: REPO_ID,
	number: 42,
	providerArtifactId: "PR_kwDOK1x2Yw6h3Qm2",
	observedRevision: "2026-08-11T18:00:00.000Z",
	repositoryMembership: MEMBERSHIP,
};

describe("§2 — the `work` union's other variants", () => {
	it("verifies a pr receipt under the publicSha256 content binding", () => {
		const actual = withWork({
			...ARTIFACT,
			kind: "pr",
			contentBinding: { kind: "publicSha256", sha256: CONTENT_SHA256 },
		});
		expect(actual.verdict).toBe("VERIFIED_CHECKPOINT");
	});

	it("verifies an issue receipt under the privateHmacSha256V1 commitment", () => {
		const actual = withWork({
			...ARTIFACT,
			kind: "issue",
			contentBinding: { kind: "privateHmacSha256V1", commitment: CONTENT_COMMITMENT },
		});
		expect(actual.verdict).toBe("VERIFIED_CHECKPOINT");
	});

	it("verifies both session variants — membership is EXEMPT where there is no artifact", () => {
		expect(withWork({ kind: "session", repoId: REPO_ID }).verdict).toBe("VERIFIED_CHECKPOINT");
		expect(
			withWork({
				kind: "session",
				repoId: REPO_ID,
				origin: { kind: "billedUnfinalized", sourceReservationReceiptId: ALT_RECEIPT_ID },
			}).verdict,
		).toBe("VERIFIED_CHECKPOINT");
	});

	it("fails every malformed variant at step 7, and never by throwing", () => {
		// Every member here is well FORMED and wrong SEMANTICALLY: the variant does
		// not match, a required member is absent, an enum is not a member of its
		// set. Step 1's format pass has nothing to say about any of them, which is
		// exactly what makes them step 7's.
		const malformed: readonly Record<string, unknown>[] = [
			{ kind: "workflow", repoId: REPO_ID },
			{
				kind: "commit",
				oid: OID_SHA1,
				oidAlg: "sha1",
				objectSha256: OBJECT_SHA256,
				repositoryMembership: MEMBERSHIP,
			},
			{
				kind: "commit",
				repoId: REPO_ID,
				oidAlg: "sha1",
				objectSha256: OBJECT_SHA256,
				repositoryMembership: MEMBERSHIP,
			},
			{
				kind: "commit",
				repoId: REPO_ID,
				oid: OID_SHA1,
				oidAlg: "sha3",
				objectSha256: OBJECT_SHA256,
				repositoryMembership: MEMBERSHIP,
			},
			{
				kind: "commit",
				repoId: REPO_ID,
				oid: OID_SHA1,
				oidAlg: "sha1",
				repositoryMembership: MEMBERSHIP,
			},
			{
				kind: "commit",
				repoId: REPO_ID,
				oid: OID_SHA1,
				oidAlg: "sha1",
				objectSha256: OBJECT_SHA256,
			},
			// v1 FAILS CLOSED on membership: "unverified" is not a ut1 value.
			{
				kind: "commit",
				repoId: REPO_ID,
				oid: OID_SHA1,
				oidAlg: "sha1",
				objectSha256: OBJECT_SHA256,
				repositoryMembership: { status: "unverified", proofId: "p" },
			},
			{ ...ARTIFACT, kind: "pr" },
			{ ...ARTIFACT, kind: "pr", contentBinding: { kind: "publicSha256" } },
			{ ...ARTIFACT, kind: "pr", contentBinding: { kind: "privateHmacSha256V1" } },
			{ ...ARTIFACT, kind: "issue", contentBinding: { kind: "somethingElse" } },
			{
				...ARTIFACT,
				kind: "pr",
				number: undefined,
				contentBinding: { kind: "publicSha256", sha256: CONTENT_SHA256 },
			},
			{ kind: "session", repoId: REPO_ID, origin: { kind: "billedUnfinalized" } },
			{
				kind: "session",
				repoId: REPO_ID,
				origin: { kind: "somethingElse", sourceReservationReceiptId: ALT_RECEIPT_ID },
			},
			{ kind: "session", repoId: REPO_ID, repo: `github.com/${"x".repeat(300)}` },
		];
		for (const work of malformed) {
			const actual = withWork(work);
			expect(actual.failure, JSON.stringify(work).slice(0, 90)).toMatchObject({
				step: "semantics",
				code: "SEMANTIC_INVALID",
			});
		}
	});

	it("fails every MIS-FORMATTED variant member at step 1 — the format is §5 shape", () => {
		// The other half of the same union, and the half that used to verify. Each
		// member below is PRESENT and is not the thing §2 declares it to be, which
		// is a §5 shape failure rather than a semantic one: §2's step-7 list is
		// exhaustive and names none of these, while CLI spec §5 binds step 1 to
		// "§3's strict reader + §12 canonical ID decode + §5 shape".
		const misformatted: readonly Record<string, unknown>[] = [
			// A 32-bit prefix where §2 requires the FULL object ID — the exact
			// transplant §7's consumer rule says a prefix never rules out.
			{ ...COMMIT_WORK, oid: OID_SHA1.slice(0, 8) },
			// sha256-shaped OID under a sha1 repository, and the reverse.
			{ ...COMMIT_WORK, oid: OBJECT_SHA256 },
			{ ...COMMIT_WORK, oid: OID_SHA1, oidAlg: "sha256" },
			{ ...COMMIT_WORK, oid: OID_SHA1.toUpperCase() },
			{ ...COMMIT_WORK, objectSha256: "not-a-digest" },
			{ ...COMMIT_WORK, objectSha256: OBJECT_SHA256.toUpperCase() },
			{ ...ARTIFACT, kind: "pr", number: "42", contentBinding: PUBLIC_BINDING },
			{ ...ARTIFACT, kind: "pr", providerArtifactId: "", contentBinding: PUBLIC_BINDING },
			{ ...ARTIFACT, kind: "pr", observedRevision: "", contentBinding: PUBLIC_BINDING },
			{
				...ARTIFACT,
				kind: "pr",
				contentBinding: { kind: "publicSha256", sha256: `${CONTENT_SHA256}zz` },
			},
			{
				...ARTIFACT,
				kind: "issue",
				contentBinding: { kind: "privateHmacSha256V1", commitment: "c1_9f3a2c81d0" },
			},
			{
				...ARTIFACT,
				kind: "issue",
				contentBinding: { kind: "privateHmacSha256V1", commitment: "not-a-commitment" },
			},
			// The keyed `r1_` scope form is a CONSTRUCTION, not a prefix: a string
			// that announces itself as one and is not one names nothing.
			{ ...COMMIT_WORK, repoId: "r1_not-a-mac" },
			{
				kind: "session",
				repoId: REPO_ID,
				origin: { kind: "billedUnfinalized", sourceReservationReceiptId: "not-an-id" },
			},
		];
		for (const work of misformatted) {
			const actual = withWork(work);
			expect(actual.failure, JSON.stringify(work).slice(0, 90)).toMatchObject({
				step: "schema",
				code: "SCHEMA_INVALID",
			});
		}
	});
});

describe("step 7 — a projection missing or mistyping what §2 enumerates", () => {
	const broken: readonly [string, (p: Projection) => Projection][] = [
		// ABSENT is step 7's; a member that is PRESENT and mistyped is step 1's
		// §5 shape (see the format tests). The two are different conditions and
		// §7's steps own their codes one apiece.
		["sessionId absent", (p) => ({ ...p, sessionId: undefined as unknown as string })],
		["startedAt absent", (p) => ({ ...p, startedAt: undefined as unknown as string })],
		["endedAt absent", (p) => ({ ...p, endedAt: undefined as unknown as string })],
		["generation below 1", (p) => ({ ...p, generation: 0 })],
		["sessionAssociation unrecognized", (p) => ({ ...p, sessionAssociation: "assumed" })],
		["workloadId not opaque", (p) => ({ ...p, workloadId: "wl 7c2f/4a91" })],
		// An ABSENT projection `work` is equality 9's (the mirror cannot match a
		// member that is not there); a work that is not an OBJECT survives eq 9 —
		// both copies canonicalize identically — and lands here.
		["work is not an object", (p) => ({ ...p, work: "commit" })],
		["models not an array", (p) => ({ ...p, models: "claude-opus-4-5" })],
		["providers carries a non-string", (p) => ({ ...p, providers: [1] })],
		["pricing absent", (p) => ({ ...p, pricing: undefined as unknown as object })],
		["spend absent", (p) => ({ ...p, spend: undefined as unknown as object })],
		[
			"spend member mistyped",
			(p) => ({ ...p, spend: { ...(p.spend as object), transferCount: "22" } }),
		],
		[
			"transferCount below 1",
			(p) => ({
				...p,
				spend: { ...(p.spend as object), transferCount: 0 },
				transferSet: [],
			}),
		],
		["transferSet member is not an object", (p) => ({ ...p, transferSet: Array(22).fill(1) })],
		[
			"transferSet member is not the ID pair",
			(p) => ({ ...p, transferSet: Array(22).fill({ authorizationTransferId: "a" }) }),
		],
		[
			"transfer ID is not canonical 128-bit hex",
			(p) => ({
				...p,
				transferSet: (p.transferSet as { authorizationTransferId: string }[]).map((pair, i) =>
					i === 0 ? { ...pair, authorizationTransferId: "NOTHEX" } : pair,
				),
			}),
		],
		[
			"a transfer PAIR repeats while its IDs do not",
			(p) => ({
				...p,
				spend: { ...(p.spend as object), transferCount: 2 },
				transferSet: [
					{ authorizationTransferId: "a".repeat(32), settlementTransferId: "b".repeat(32) },
					{ authorizationTransferId: "a".repeat(32), settlementTransferId: "b".repeat(32) },
				],
			}),
		],
		["transferSetRoot is not 64 lowercase hex", (p) => ({ ...p, transferSetRoot: "ABC" })],
		[
			"prevGenerationEventHash is not 64 lowercase hex",
			(p) => ({ ...p, generation: 2, prevGenerationEventHash: "not-a-hash" }),
		],
	];
	for (const [name, patch] of broken) {
		it(`${name} ⇒ SEMANTIC_INVALID`, () => {
			expect(verifyMinted({ projection: patch }).failure, name).toMatchObject({
				step: "semantics",
				code: "SEMANTIC_INVALID",
			});
		});
	}
});

describe("step 1 — a required member that is simply not there", () => {
	// Fail CLOSED and, above all, do not throw: a `TypeError` escaping the
	// verifier is indistinguishable from a crash to the caller that has to
	// choose an exit code, which is why §7 forbids a throw as a verdict.
	const drops: readonly [string, Parameters<typeof mint>[0]][] = [
		["mintedAt", { receiptBeforeSign: (r) => ({ ...r, mintedAt: undefined }) }],
		["minter", { receiptBeforeSign: (r) => ({ ...r, minter: undefined }) }],
		[
			"minter.keyId",
			{ receiptBeforeSign: (r) => ({ ...r, minter: { ...r.minter, keyId: undefined } }) },
		],
		[
			"minter.kind",
			{ receiptBeforeSign: (r) => ({ ...r, minter: { ...r.minter, kind: undefined } }) },
		],
		[
			"minter.trustDomain",
			{ receiptBeforeSign: (r) => ({ ...r, minter: { ...r.minter, trustDomain: undefined } }) },
		],
		["receiptId", { receiptBeforeSign: (r) => ({ ...r, receiptId: undefined }) }],
		["signature", { receiptAfterSign: (r) => ({ ...r, signature: undefined }) }],
		[
			"signature.keyId",
			{
				receiptAfterSign: (r) => ({
					...r,
					signature: { ...(r.signature as object), keyId: undefined },
				}),
			},
		],
		[
			"signature.sig",
			{
				receiptAfterSign: (r) => ({
					...r,
					signature: { ...(r.signature as object), sig: undefined },
				}),
			},
		],
		[
			"signature.sig canonical base64",
			{
				receiptAfterSign: (r) => ({
					...r,
					signature: { ...(r.signature as object), sig: "not base64!" },
				}),
			},
		],
		["event", { receiptBeforeSign: (r) => ({ ...r, event: undefined }) }],
		["event.timestamp", { event: (e) => ({ ...e, timestamp: undefined as unknown as string }) }],
		["event.sequence", { event: (e) => ({ ...e, sequence: undefined as unknown as number }) }],
		["event.actor", { event: (e) => ({ ...e, actor: undefined }) }],
		["event.data", { event: (e) => ({ ...e, data: undefined as unknown as Projection }) }],
		[
			"proof.profile",
			{ receiptBeforeSign: (r) => ({ ...r, proof: { ...r.proof, profile: undefined } }) },
		],
		[
			"proof.chain",
			{ receiptBeforeSign: (r) => ({ ...r, proof: { ...r.proof, chain: undefined } }) },
		],
		[
			"proof.mintEventHash",
			{ receiptBeforeSign: (r) => ({ ...r, proof: { ...r.proof, mintEventHash: undefined } }) },
		],
		["inclusion.version", { inclusion: (p) => ({ ...p, version: 2 }) }],
	];
	for (const [name, options] of drops) {
		it(`${name} ⇒ SCHEMA_INVALID`, () => {
			expect(verifyMinted(options).failure, name).toMatchObject({
				step: "schema",
				code: "SCHEMA_INVALID",
			});
		});
	}

	it("gives an absent work to equality 9 from EITHER side, not to step 7", () => {
		// Absent on both sides — the mirror has nothing to mirror.
		expect(
			verifyMinted({ projection: (p) => ({ ...p, work: undefined as unknown as object }) }).failure,
		).toMatchObject({ step: "event", code: "EVENT_MISMATCH" });
		// And the asymmetric case: a receipt asserting `work` over a projection
		// that commits none. This is the shape equality 9 exists for — the
		// signature covers the assertion, and nothing else would notice that the
		// CHAIN never said it.
		expect(
			verifyMinted({
				projection: (p) => ({ ...p, work: undefined as unknown as object }),
				receiptBeforeSign: (r) => ({
					...r,
					work: { kind: "session", repoId: "github.com:R_kgDOK1x2Yw" },
				}),
			}).failure,
		).toMatchObject({ step: "event", code: "EVENT_MISMATCH" });
	});

	it("treats an absent inclusion member as missing PROOF material, not a schema failure", () => {
		const actual = verifyMinted({
			receiptBeforeSign: (r) => ({ ...r, proof: { ...r.proof, inclusion: undefined } }),
		});
		expect(actual.verdict).toBe("UNVERIFIABLE");
		expect(actual.missing?.what).toBe("proof");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ABSENT is not MALFORMED (CLI spec §5's table, receipt-spec §7).
//
// §7 lists "a proof or checkpoint that is not there" under MISSING MATERIAL,
// which is UNVERIFIABLE and exit 2 — "we could not check". A member that is
// PRESENT and is a `null`, a string or an array is a different statement: the
// receipt made a claim and the claim is malformed, which is FAILED /
// SCHEMA_INVALID and exit 1 — "we checked, and this receipt is bad".
//
// Step 1 read all three through `objectAtKey`, which answers `undefined` for
// both, so a hostile `"proof": null` bought exit 2 from a CI gate that treats
// exit 1 as the only real negative. The two codes are the CI contract, so
// collapsing them is a defect and not a wording preference.
// ─────────────────────────────────────────────────────────────────────────────

describe("step 1 — a proof member that is PRESENT and malformed", () => {
	const NOT_AN_OBJECT: readonly unknown[] = [null, "proof", 7, true, [], [{}]];

	function withProofMember(member: "proof" | "inclusion" | "checkpoint", value: unknown) {
		return member === "proof"
			? { receiptBeforeSign: (r: UnsignedReceipt) => ({ ...r, proof: value }) }
			: {
					receiptBeforeSign: (r: UnsignedReceipt) => ({
						...r,
						proof: { ...r.proof, [member]: value },
					}),
				};
	}

	for (const member of ["proof", "inclusion", "checkpoint"] as const) {
		it(`${member} present as a non-object ⇒ FAILED / SCHEMA_INVALID, never UNVERIFIABLE`, () => {
			for (const value of NOT_AN_OBJECT) {
				const actual = verifyMinted(withProofMember(member, value));
				expect(actual.verdict, `${member} = ${JSON.stringify(value)}`).toBe("FAILED");
				expect(actual.failure, `${member} = ${JSON.stringify(value)}`).toMatchObject({
					step: "schema",
					code: "SCHEMA_INVALID",
				});
				expect(actual.missing, `${member} = ${JSON.stringify(value)}`).toBeNull();
			}
		});
	}

	it("keeps ABSENT on the UNVERIFIABLE side — the other half of the line", () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			["proof", "proof"],
			["inclusion", "proof"],
			["checkpoint", "checkpoint"],
		];
		for (const [member, missing] of cases) {
			const actual = verifyMinted(
				withProofMember(member as "proof" | "inclusion" | "checkpoint", undefined),
			);
			expect(actual.verdict, member).toBe("UNVERIFIABLE");
			expect(actual.missing?.what, member).toBe(missing);
			expect(actual.failure, member).toBeNull();
		}
	});

	it("still verifies when all three are the objects §5 declares", () => {
		expect(verifyMinted({}).verdict).toBe("VERIFIED_CHECKPOINT");
	});
});

describe("bindings the corpus cannot express with a commit receipt", () => {
	it("pins the profile literal even when the snapshot registers the other one", () => {
		// Every profile field AGREES here — checkpoint, proof and the registered
		// chain all say `ut-chain-v1`. Only §4a's rule that the verifier SELECTS
		// its equality set from the ut1 literal (never inferring it from the
		// shapes it sees) stands between this document and a ut1 verdict.
		const actual = verifyMinted({
			checkpointsUnsigned: (checkpoints) =>
				checkpoints.map((c) => ({ ...c, profile: "ut-chain-v1" })),
			receiptBeforeSign: (r) => ({ ...r, proof: { ...r.proof, profile: "ut-chain-v1" } }),
			snapshot: (s) => {
				(s.chains[0] as { profile: string }).profile = "ut-chain-v1";
				return s;
			},
		});
		expect(actual.failure).toMatchObject({ step: "event", code: "EVENT_MISMATCH" });
	});

	it("rejects a leaf beyond the signed tree even when equality 4's arithmetic holds", () => {
		// leafIndex 7 === sequence 18 − segmentFirstSequence 11, and the segment's
		// signed treeSize is 7 — so the proof claims a leaf the checkpoint never
		// covered. The arithmetic half of equality 4 cannot see it.
		const actual = verifyMinted({
			event: (e) => ({ ...e, sequence: e.sequence + 4 }),
			inclusion: (p) => ({ ...p, leafIndex: 7 }),
		});
		expect(actual.failure).toMatchObject({ step: "event", code: "EVENT_MISMATCH" });
	});

	it("rejects a checkpoint with no segmentFirstSequence to bind the leaf against", () => {
		const actual = verifyMinted({
			checkpointsUnsigned: (checkpoints) =>
				checkpoints.map((c) => {
					const { segmentFirstSequence: _dropped, ...rest } = c;
					return rest as typeof c;
				}),
		});
		expect(actual.failure).toMatchObject({ step: "event", code: "EVENT_MISMATCH" });
	});

	it("refuses a mint key registered for an algorithm the receipt does not claim", () => {
		const actual = verifyMinted({
			snapshot: (s) => {
				const key = s.keys.find((k) => k.role === "mint");
				if (key !== undefined) key.alg = "ecdsa-p256";
				return s;
			},
		});
		expect(actual.failure).toMatchObject({ step: "signature", code: "SIG_INVALID" });
	});

	it("refuses a checkpoint statement with no keyId or no sig", () => {
		for (const field of ["keyId", "sig"] as const) {
			const actual = verifyMinted({
				checkpointsAfterSign: (checkpoints) =>
					checkpoints.map((c, i) => {
						if (i !== 2) return c;
						const { [field]: _dropped, ...rest } = c;
						return rest as typeof c;
					}),
			});
			expect(actual.failure, field).toMatchObject({
				step: "checkpoint",
				code: "CHECKPOINT_INVALID",
			});
		}
	});
});

describe("the last few reads a hostile document can bend", () => {
	it("refuses a checkpoint that names the MINT key as its signer", () => {
		// Role separation from the other side: the keyId RESOLVES, its material is
		// real, and it signed nothing it was entitled to sign.
		const actual = verifyMinted({
			checkpointsUnsigned: (checkpoints) =>
				checkpoints.map((c, i) => (i === 2 ? { ...c, keyId: "utk_mint_2026_08" } : c)),
		});
		expect(actual.failure).toMatchObject({ step: "checkpoint", code: "CHECKPOINT_INVALID" });
	});

	it("refuses a non-integer leafIndex and a non-array transferSet", () => {
		expect(
			verifyMinted({ inclusion: (p) => ({ ...p, leafIndex: "3" as unknown as number }) }).failure,
		).toMatchObject({ step: "event", code: "EVENT_MISMATCH" });
		expect(verifyMinted({ projection: (p) => ({ ...p, transferSet: 5 }) }).failure).toMatchObject({
			step: "semantics",
			code: "SEMANTIC_INVALID",
		});
	});

	it("refuses the pr/issue members and the session origin shape one at a time", () => {
		for (const work of [
			{
				...ARTIFACT,
				kind: "pr",
				providerArtifactId: undefined,
				contentBinding: PUBLIC_BINDING,
			},
			{
				...ARTIFACT,
				kind: "pr",
				observedRevision: undefined,
				contentBinding: PUBLIC_BINDING,
			},
			{ kind: "session", repoId: REPO_ID, origin: "billedUnfinalized" },
		]) {
			expect(withWork(work).failure, JSON.stringify(work).slice(0, 70)).toMatchObject({
				step: "semantics",
				code: "SEMANTIC_INVALID",
			});
		}
	});

	it("refuses an EMPTY required string — present-and-blank is not present", () => {
		// Every one of these is SIGNED: the harness mints the empty value, so the
		// preimage covers it, `event.hash` recomputes and the mint signature
		// verifies. `typeof value === "string"` alone therefore hands a verdict of
		// VERIFIED to a receipt with no session, no mint time and no repository —
		// the §12/§2 identities the document exists to carry.
		expect(
			verifyMinted({ receiptBeforeSign: (r) => ({ ...r, mintedAt: "" }) }).failure,
		).toMatchObject({ step: "schema", code: "SCHEMA_INVALID" });
		expect(
			verifyMinted({
				receiptBeforeSign: (r) => ({
					...r,
					minter: { ...(r.minter as Record<string, unknown>), trustDomain: "" },
				}),
			}).failure,
		).toMatchObject({ step: "schema", code: "SCHEMA_INVALID" });
		// A blank `sessionId` is a §5 SHAPE failure now (step 1's format table),
		// not a semantic one: §2's exhaustive step-7 list does not mention it, and
		// the member is present — it just is not a session identifier.
		expect(
			verifyMinted({
				projection: (p: Projection) => ({ ...p, sessionId: "" }),
			}).failure,
		).toMatchObject({ step: "schema", code: "SCHEMA_INVALID" });
		expect(
			verifyMinted({
				projection: (p: Projection) => {
					(p.work as Record<string, unknown>).repoId = "";
					return p;
				},
			}).failure,
		).toMatchObject({ step: "semantics", code: "SEMANTIC_INVALID" });
	});

	it("refuses a checkpoint key the snapshot registers for another algorithm", () => {
		// The mint path binds `key.alg` to the receipt's `ed25519` (step 4). The
		// checkpoint path verifies Ed25519 unconditionally, so a snapshot saying
		// `ecdsa-p256` over Ed25519 material is silently overruled by the
		// verifier's preference. Conflicting trust metadata is a refusal: §8's
		// ambiguity rule, and the only reading under which the snapshot means
		// what it says.
		const actual = verifyMinted({
			snapshot: (s) => {
				const key = s.keys.find((k) => k.role === "checkpoint");
				if (key !== undefined) key.alg = "ecdsa-p256";
				return s;
			},
		});
		expect(actual.failure).toMatchObject({ step: "checkpoint", code: "CHECKPOINT_INVALID" });
	});

	it("refuses a signature whose base64 is non-canonical before the helper sees it", () => {
		// `Buffer.from(x, "base64")` decodes this to the SAME 64 bytes, so the
		// reused Ed25519 helper would verify it happily — which is why the check
		// runs first, on every signature and key input alike.
		const actual = verifyMinted({
			checkpointsAfterSign: (checkpoints) =>
				checkpoints.map((c, i) => (i === 2 ? { ...c, sig: `${c.sig.slice(0, -1)}!` } : c)),
		});
		expect(actual.failure).toMatchObject({ step: "checkpoint", code: "CHECKPOINT_INVALID" });
	});
});

describe("step 6 — §4a's member list, asserted where step 1 cannot reach", () => {
	// `verifyCheckpointStatement` is exported because step 9 applies it to EVERY
	// checkpoint in a supplied history, and those arrive from the resolver's
	// envelope — they never pass through step 1's unknown-field walk or its
	// frozen numeric reader. So step 6 has to be self-sufficient about what a
	// §4a v2 statement IS, and these assert it directly rather than through a
	// receipt whose step 1 would answer first.
	function statement(patch: (c: JsonObject) => JsonObject) {
		const bundle = mint();
		const load = loadTrustSnapshot(bundle.snapshotBytes);
		if (!load.ok) throw new Error(`fixture snapshot did not load: ${load.detail}`);
		const chain = load.snapshot.chains.get("vlt_ut_proxy_prod_1");
		if (chain === undefined) throw new Error("fixture snapshot registered no chain");
		const original = bundle.history[bundle.history.length - 1] as unknown as JsonObject;
		return verifyCheckpointStatement(patch({ ...original }), chain, load.snapshot);
	}

	it("accepts the statement as minted", () => {
		expect(statement((c) => c)).toEqual({ ok: true });
	});

	it("refuses a member OUTSIDE §4a's list — an extra member is signed, unspecified content", () => {
		const outcome = statement((c) => ({ ...c, publishedTo: "https://rekor.example/1" }));
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.missingTrustKey).toBe(false);
	});

	it("refuses each §4a member's absence, one at a time", () => {
		for (const member of [
			"vaultId",
			"profile",
			"root",
			"treeSize",
			"segmentId",
			"segmentFirstSequence",
			"previousSegmentRoot",
			"previousSegmentId",
			"keyId",
			"publishedAt",
			"sig",
		]) {
			const outcome = statement((c) => {
				const { [member]: _dropped, ...rest } = c;
				return rest;
			});
			expect(outcome.ok, member).toBe(false);
			// Not UNVERIFIABLE: an absent keyId is a malformed statement, not an
			// unresolvable key — the material is present and it is wrong.
			expect(outcome.ok === false && outcome.missingTrustKey, member).toBe(false);
		}
	});

	it("returns a VERDICT, never a throw, on a history checkpoint carrying Infinity", () => {
		// The value canonicalize throws on, in the one object step 9 canonicalizes
		// on material the reader never vetted. §7: the verdict is a function of the
		// step results, "not of an exception being thrown somewhere".
		const outcome = statement((c) => ({ ...c, treeSize: Number.POSITIVE_INFINITY }));
		expect(outcome.ok).toBe(false);
	});
});

describe("step 7 — §2's canonical provider-URL form for work.repo", () => {
	function withRepo(repo: unknown): Run {
		return verifyMinted({
			projection: (p: Projection) => {
				(p.work as Record<string, unknown>).repo = repo;
				return p;
			},
		});
	}

	it("accepts the forms §2's `<providerHost>/<owner>/<name>` describes", () => {
		for (const repo of [
			"github.com/usertools-ai/usertrust",
			"gitlab.com/Some.Owner/some_repo-2",
			"git.self-hosted.example.co.uk/team/repo",
		]) {
			expect(withRepo(repo).verdict, repo).toBe("VERIFIED_CHECKPOINT");
		}
	});

	it("refuses everything §2 says it is NOT — a public document must not carry a path", () => {
		for (const repo of [
			"/Users/cam/private/customer-acme/secret",
			"../../etc/passwd",
			"github.com/usertools-ai/usertrust/tree/main",
			"https://github.com/usertools-ai/usertrust",
			"git@github.com:usertools-ai/usertrust.git",
			"https://cam:ghp_secret@github.com/usertools-ai/usertrust",
			"github.com/usertools-ai/usertrust#my-worktree",
			"localhost/usertools-ai/usertrust",
			"GitHub.com/usertools-ai/usertrust",
			"github.com//usertrust",
			"github.com/usertools-ai/",
			"github.com/usertools-ai/..",
			"",
		]) {
			expect(withRepo(repo).failure, repo).toMatchObject({
				step: "semantics",
				code: "SEMANTIC_INVALID",
			});
		}
	});
});

describe("the amount never travels without a verdict that earns it", () => {
	it("withholds amountUsd and the posture labels on a step-8 failure", () => {
		// Step 8 computes the amount BEFORE it checks the derivation, so the value
		// exists at the moment the receipt fails. It is not released.
		const actual = run(vector("derivations/transfer-set-root-mismatch"));
		expect(actual.failure).toMatchObject({ step: "derivations", code: "DERIVATION_MISMATCH" });
		expect(actual.computed.amountUsd).toBeNull();
		expect(actual.posture).toBeNull();
	});
});
