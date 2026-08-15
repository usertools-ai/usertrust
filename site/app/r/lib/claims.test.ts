/**
 * The COPY PIN for the verify page's claims surface.
 *
 * Every assertion below re-states a spec-mandated string INDEPENDENTLY of the
 * module under test — transcribed from `docs/specs/receipt-spec.md` §2/§6a/§7
 * and `docs/specs/2026-08-11-verify-page-design.md` §5/§6/§7 — so an edit to
 * `claims.ts` that softens a disclaimer fails here instead of shipping. This is
 * the motion-doctrine-test pattern (`app/lib/motion-doctrine.test.ts`) applied
 * to normative copy: the spec's own §8 closes with "copy that the spec mandates
 * is test-pinned so a redesign cannot silently drop a disclaimer".
 *
 * The spec files themselves are NOT readable from this test (they live outside
 * the site package and outside the repo's tracked tree), which is why the
 * strings are transcribed rather than diffed. Transcription is the obligation:
 * a reviewer compares this file to the spec, prose to prose.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	ADVISORY_NEVER_ALTERS_VERDICT,
	ANCHOR_BINDING_RESOLVER_ASSERTED,
	ANCHOR_EXTERNAL_VISIBILITY,
	ANCHOR_NOT_PROOF_OF_UNIQUENESS,
	ANCHOR_PARTIAL_MITIGATION,
	advisoryBand,
	amountFloorClaim,
	amountUsdFromUsertokens,
	artifactComparison,
	CHECK_ROWS,
	CUSTOM_MODEL_MEANING,
	catalogRendering,
	DISPLAY_ANNEX_LABEL,
	delegationScopeClaim,
	EQUIVOCATION_CAVEAT,
	ESTIMATES_NOT_UPPER_BOUND,
	EXECUTION_METADATA_NOTE,
	FORK_DISCLAIMER,
	headlineClaim,
	LADDER,
	LEDGER_ROWS,
	MEMBERSHIP_EPISTEMIC_SCOPE,
	MINTED_AT_LABEL,
	MINTED_AT_NOTE,
	membershipLedgerNote,
	NOT_APPLICABLE_MEANING,
	POSTURES_ARE_ATTESTED_ENUMS,
	PRICING_TABLES_NOTE,
	PROVIDER_SCOPED_CLAIM,
	pricingPostureClaim,
	RESULT_LABEL,
	RUNG_VERDICT_WORD,
	repoScope,
	revisionSupersededLine,
	rungDisclaimers,
	S3_OPERATOR_ASSERTED,
	SESSION_NON_ARTIFACT,
	SESSION_PROMOTION_GATE,
	sessionAssociationPosture,
	TRANSFER_SET_ROOT_COMMITMENT,
	transferSetRendering,
	truncateForDisplay,
	trustSnapshotLine,
	UNDISCLOSED_PRIVATE_REPO,
	usagePostureClaim,
} from "./claims";
import type { Projection, Work } from "./wire";

// ---------------------------------------------------------------------------
// R5-R8 — the ladder and its disclaimers
// ---------------------------------------------------------------------------

test("R5: the ladder is the three rungs, floor first, and every rung has its own word", () => {
	assert.deepEqual(LADDER, [
		"verified_checkpoint",
		"verified_checkpoint_history",
		"verified_anchored",
	]);
	assert.equal(RUNG_VERDICT_WORD.verified_checkpoint, "VERIFIED — CHECKPOINT");
	assert.equal(RUNG_VERDICT_WORD.verified_checkpoint_history, "VERIFIED — CHECKPOINT HISTORY");
	assert.equal(RUNG_VERDICT_WORD.verified_anchored, "VERIFIED — ANCHORED");
	// Three DISTINCT verdicts (R5) — not one word with a suffix.
	assert.equal(new Set(Object.values(RUNG_VERDICT_WORD)).size, 3);
});

test("R6: the checkpoint rung's disclaimer is carried VERBATIM", () => {
	assert.equal(
		FORK_DISCLAIMER,
		"this level does NOT prove whole-chain linear consistency, anchor-sequence continuity, or external immutability — a checkpoint signer could sign a fork.",
	);
	assert.deepEqual(rungDisclaimers("verified_checkpoint"), [FORK_DISCLAIMER]);
});

test("R7: the history rung names EQUIVOCATION verbatim and KEEPS the fork disclaimer", () => {
	assert.equal(
		EQUIVOCATION_CAVEAT,
		"the surviving gap is EQUIVOCATION — the checkpoint key holder could sign two internally perfect histories and show each to different audiences.",
	);
	const fine = rungDisclaimers("verified_checkpoint_history");
	assert.ok(fine.includes(FORK_DISCLAIMER), "R7 keeps the fork disclaimer");
	assert.ok(fine.includes(EQUIVOCATION_CAVEAT));
	// The v1 non-goal is stated so the page cannot imply equivocation is closed.
	assert.ok(fine.some((line) => line.includes("named non-goal for v1")));
});

test("R8: the anchored rung carries the surviving equivocation caveat, VERBATIM", () => {
	assert.equal(ANCHOR_PARTIAL_MITIGATION, "Rekor anchoring PARTIALLY mitigates equivocation");
	assert.equal(
		ANCHOR_EXTERNAL_VISIBILITY,
		"publishing a checkpoint to a public transparency log makes one history externally visible, so a second private history has to contradict something the world can already see",
	);
	assert.match(ANCHOR_NOT_PROOF_OF_UNIQUENESS, /does not prove the signer never produced another/);
	assert.match(ANCHOR_NOT_PROOF_OF_UNIQUENESS, /fork disclaimer REMAINS/);

	const fine = rungDisclaimers("verified_anchored");
	// The ladder is cumulative, so the anchored rung inherits BOTH lower caveats.
	assert.ok(fine.includes(FORK_DISCLAIMER), "R8: the fork disclaimer REMAINS at this rung");
	assert.ok(fine.includes(EQUIVOCATION_CAVEAT), "R8 presupposes the history rung's gap");
	assert.ok(fine.some((line) => line.includes(ANCHOR_EXTERNAL_VISIBILITY)));
});

test("R8: no rung's fine print ever drops a caveat the rung below carried", () => {
	// The overclaim this forbids: "each upgrade closed the previous gap".
	const floor = rungDisclaimers("verified_checkpoint");
	const history = rungDisclaimers("verified_checkpoint_history");
	const anchored = rungDisclaimers("verified_anchored");
	for (const line of floor) assert.ok(history.includes(line), `history dropped: ${line}`);
	for (const line of history) assert.ok(anchored.includes(line), `anchored dropped: ${line}`);
});

test("R8/R32: S3 Object Lock evidence is labeled operator-asserted and never a green anchor claim", () => {
	assert.match(S3_OPERATOR_ASSERTED, /OPERATOR-ASSERTED/);
	assert.match(S3_OPERATOR_ASSERTED, /context only/);
	assert.match(S3_OPERATOR_ASSERTED, /upgrades no cryptographic verdict/);
	assert.match(S3_OPERATOR_ASSERTED, /never a green anchor claim/);
});

// ---------------------------------------------------------------------------
// R23 — the one arithmetic derivation
// ---------------------------------------------------------------------------

test("R23: amountUsd is integer quotient/remainder at 10,000/dollar with exactly four decimals", () => {
	// receipt-spec §2's own worked example.
	assert.equal(amountUsdFromUsertokens(48224), "4.8224");
	assert.equal(amountUsdFromUsertokens(10000), "1.0000");
	assert.equal(amountUsdFromUsertokens(1), "0.0001");
	assert.equal(amountUsdFromUsertokens(0), "0.0000");
	// Remainder is ZERO-PADDED to four places, never trimmed.
	assert.equal(amountUsdFromUsertokens(20001), "2.0001");
	assert.equal(amountUsdFromUsertokens(903120), "90.3120");
});

test("R23: the derivation is exact at the top of the safe-integer range (no float quotient)", () => {
	assert.equal(amountUsdFromUsertokens(Number.MAX_SAFE_INTEGER), "900719925474.0991");

	// The obvious float implementation — `(n / 10000).toFixed(4)` — is WRONG
	// here, which is why §2 says "integer quotient/remainder (no float)" and why
	// this module spends a BigInt on it. If this vector ever stops diverging the
	// guard has gone stale and should be re-derived, not deleted.
	const naive = 9_007_199_254_740_987;
	assert.equal((naive / 10_000).toFixed(4), "900719925474.0988");
	assert.equal(amountUsdFromUsertokens(naive), "900719925474.0987");

	// Exactness as a property: the rendered digits reconstruct the input
	// EXACTLY, for every magnitude the projection admits.
	for (const n of [1, 9999, 10_000, 48_224, 903_120, naive, Number.MAX_SAFE_INTEGER]) {
		const [dollars, cents] = amountUsdFromUsertokens(n).split(".");
		assert.equal(cents.length, 4);
		assert.equal(
			BigInt(dollars) * BigInt(10_000) + BigInt(cents),
			BigInt(n),
			`round trip failed for ${n}`,
		);
	}
});

test("R23: a non-integer or negative usertoken count is a programmer error, not a rendered lie", () => {
	assert.throws(() => amountUsdFromUsertokens(1.5), RangeError);
	assert.throws(() => amountUsdFromUsertokens(-1), RangeError);
	assert.throws(() => amountUsdFromUsertokens(Number.NaN), RangeError);
});

// ---------------------------------------------------------------------------
// R13/R14/R15 — work scoping, per kind
// ---------------------------------------------------------------------------

const commitWork: Work = {
	kind: "commit",
	repoId: "github.com:R_kgDOK1x2Yw",
	repo: "github.com/usertrust-ai/usertrust",
	oid: "12283b89ad55b584c7959394a527e24da0ec1f5e",
	oidAlg: "sha1",
	objectSha256: "c1aa41337b942621eb9b231bb27e308bea27b6f1f3b66e737975b62ce764e55f",
	repositoryMembership: { status: "providerVerified", proofId: "05b196f30cc951033216613a" },
};

const prWork: Work = {
	kind: "pr",
	repoId: "r1_9f2a7c31e8b4",
	number: 412,
	providerArtifactId: "PR_kwDOK1x2Yw",
	observedRevision: "4a7459a0ca3e4a9882985df4baa1079fc40ada00",
	contentBinding: { kind: "privateHmacSha256V1", commitment: "c1_deadbeef" },
	repositoryMembership: { status: "providerVerified", proofId: "handle-1" },
};

const issueWork: Work = {
	kind: "issue",
	repoId: "github.com:R_kgDOK1x2Yw",
	repo: "github.com/usertrust-ai/usertrust",
	number: 231,
	providerArtifactId: "I_kwDOK1x2Yw",
	observedRevision: "e4689855dad05ef1b6ee459c7e354ad1f41d65dc",
	contentBinding: { kind: "publicSha256", sha256: "aa".repeat(32) },
	repositoryMembership: { status: "providerVerified", proofId: "handle-2" },
};

const sessionWork: Work = { kind: "session", repoId: "github.com:R_kgDOK1x2Yw" };

test("R13: the three headline forms are the spec's own words, per kind", () => {
	assert.equal(
		headlineClaim(commitWork),
		"attests commit 12283b89ad55b584c7959394a527e24da0ec1f5e in github.com:R_kgDOK1x2Yw",
	);
	assert.equal(
		headlineClaim(prWork),
		"attests r1_9f2a7c31e8b4 PR #412 at revision 4a7459a0ca3e4a9882985df4baa1079fc40ada00",
	);
	assert.equal(
		headlineClaim(issueWork),
		"attests github.com:R_kgDOK1x2Yw issue #231 at revision e4689855dad05ef1b6ee459c7e354ad1f41d65dc",
	);
	assert.equal(headlineClaim(sessionWork), "produced under this governed session");
});

test("R13: the headline uses the FULL oid and the repoId — never a prefix, never the name", () => {
	const headline = headlineClaim(commitWork);
	assert.ok(headline.includes(commitWork.kind === "commit" ? commitWork.oid : ""));
	assert.ok(headline.includes("github.com:R_kgDOK1x2Yw"));
	assert.ok(
		!headline.includes("github.com/usertrust-ai/usertrust"),
		"the mutable name is never the scope in the headline claim",
	);
});

test("R14: session carries NO artifact claim and states the promotion-gate rule", () => {
	const headline = headlineClaim(sessionWork);
	assert.ok(!/attests/.test(headline), "a session headline never says it attests an artifact");
	assert.ok(
		!headline.includes("$"),
		"the amount lives only beside its scope, never in the headline",
	);
	assert.equal(
		SESSION_NON_ARTIFACT,
		"a session receipt attests a governed session's spend and nothing about any commit, PR, or issue that happens to cite it.",
	);
	assert.match(SESSION_PROMOTION_GATE, /promotion gate MUST NOT accept it/);
	assert.match(SESSION_PROMOTION_GATE, /kind === "commit"/);
	const comparison = artifactComparison(sessionWork);
	assert.ok(comparison.some((step) => step.body === SESSION_NON_ARTIFACT));
	assert.ok(comparison.some((step) => step.body === SESSION_PROMOTION_GATE));
});

test("R15: the commit teaching carries the MANDATORY-for-promotion digest rule WITH its reason", () => {
	const bytes = artifactComparison(commitWork).find((step) => step.axis === "BYTES");
	assert.ok(bytes, "the commit comparison names a BYTES axis");
	assert.match(bytes.body, /MANDATORY for a green PROMOTION verdict/);
	assert.match(
		bytes.body,
		/a promotion gate that cannot hash the merge candidate's bytes MUST NOT pass it, because OID equality alone leaves SHA-1 twins indistinguishable/,
	);
	const identity = artifactComparison(commitWork).find((step) => step.axis === "IDENTITY");
	assert.ok(identity);
	assert.match(identity.body, /FULL object ID/);
	assert.match(identity.body, /prefixes never suffice/);
	assert.match(identity.body, /immutable provider ID, never the mutable name/);
	// The unsafe subset — OID-only — is never taught alone.
	const outside = artifactComparison(commitWork).find((s) => s.axis === "BYTES, OUTSIDE PROMOTION");
	assert.ok(outside);
	assert.match(outside.body, /notApplicable/);
	assert.match(outside.body, /never silently skipped/);
});

test("R15: pr uses SERVER-ASSISTED confirmation, issue uses DIRECT recomputation", () => {
	const prRevision = artifactComparison(prWork).find((s) => s.axis === "REVISION + CONTENT");
	assert.ok(prRevision);
	assert.match(prRevision.body, /privateHmacSha256V1/);
	assert.match(prRevision.body, /SERVER-ASSISTED/);
	assert.match(prRevision.body, /the HMAC key is server-side and never exposed/);

	const issueRevision = artifactComparison(issueWork).find((s) => s.axis === "REVISION + CONTENT");
	assert.ok(issueRevision);
	assert.match(issueRevision.body, /publicSha256/);
	assert.match(issueRevision.body, /recomputed DIRECTLY by the consumer/);

	for (const work of [prWork, issueWork]) {
		const identity = artifactComparison(work)[0];
		assert.match(identity.body, /providerArtifactId/);
		assert.match(identity.body, /number and URL are both reusable/);
	}
});

test("R16: the revisionSuperseded line is verbatim and is a DISPLAY state", () => {
	assert.equal(
		revisionSupersededLine("6e5a66a7ddeab4ac0a3adaaa11dc50e0b08bf406"),
		"attests revision 6e5a66a7ddeab4ac0a3adaaa11dc50e0b08bf406; the artifact has since changed",
	);
	const band = advisoryBand({
		kind: "revisionSuperseded",
		observedRevision: "6e5a66a7ddeab4ac0a3adaaa11dc50e0b08bf406",
		currentRevision: "ffffffffffffffffffffffffffffffffffffffff",
	});
	assert.match(
		band.body,
		/attests revision 6e5a66a7ddeab4ac0a3adaaa11dc50e0b08bf406; the artifact has since changed/,
	);
	assert.match(band.body, /not a failure, not a downgrade, and never silently a plain green check/);
});

test("R17: a truncated display value always keeps the FULL value one interaction away", () => {
	const oid = "12283b89ad55b584c7959394a527e24da0ec1f5e";
	const truncated = truncateForDisplay(oid);
	assert.equal(truncated.full, oid);
	assert.ok(truncated.truncated);
	assert.ok(truncated.display.length < oid.length);
	assert.ok(oid.startsWith(truncated.display.replace("…", "")));
	// Short values are not decorated with an ellipsis they do not need.
	assert.deepEqual(truncateForDisplay("short"), {
		full: "short",
		display: "short",
		truncated: false,
	});
});

test("R18: a keyed r1_ repoId renders as an undisclosed private repository, ID shown", () => {
	assert.equal(UNDISCLOSED_PRIVATE_REPO, "undisclosed private repository");
	const keyed = repoScope(prWork);
	assert.ok(keyed.undisclosed);
	assert.equal(keyed.label, UNDISCLOSED_PRIVATE_REPO);
	assert.equal(keyed.repoId, "r1_9f2a7c31e8b4", "the opaque ID is never dropped");
	assert.equal(keyed.displayName, undefined);

	const disclosed = repoScope(commitWork);
	assert.ok(!disclosed.undisclosed);
	assert.equal(disclosed.displayName, "github.com/usertrust-ai/usertrust");
	assert.equal(disclosed.repoId, "github.com:R_kgDOK1x2Yw");
});

// ---------------------------------------------------------------------------
// R20-R27 — postures and spend
// ---------------------------------------------------------------------------

function projectionWith(overrides: Partial<Projection>): Projection {
	return {
		spec: "ut1",
		scope: "session",
		sessionId: "sess_test",
		generation: 1,
		work: commitWork,
		sessionAssociation: "ownerAsserted",
		models: ["claude-sonnet-4-6"],
		providers: ["anthropic"],
		startedAt: "2026-08-10T14:00:00.000Z",
		endedAt: "2026-08-10T14:12:00.000Z",
		spend: {
			assessedUsertokens: 48224,
			postedUsertokens: 48224,
			roundingAdjustment: 14,
			transferCount: 22,
			usagePosture: "provider",
			pricingPosture: "exact",
		},
		// §2a — REQUIRED, and the only value v1 minting may emit. Overridable
		// like every other field, so a caller can build the postures R39 renders.
		delegationPosture: "selfDebitsOnly",
		pricing: { tableVersions: ["2026-07-01"] },
		transferSet: [{ authorizationTransferId: "a", settlementTransferId: "b" }],
		transferSetRoot: "4d".repeat(32),
		...overrides,
	};
}

test("the posture preamble states the ATTESTED-ENUM frame verbatim (P2-7)", () => {
	assert.match(
		POSTURES_ARE_ATTESTED_ENUMS,
		/postures are ATTESTED ENUMS, not verifier-established facts/,
	);
	assert.match(POSTURES_ARE_ATTESTED_ENUMS, /CANNOT confirm them/);
	assert.match(
		POSTURES_ARE_ATTESTED_ENUMS,
		/per-constituent facts the projection deliberately does not carry/,
	);
});

test("R20: the two sessionAssociation postures render DISTINCTLY — identical rendering is forbidden", () => {
	const attested = sessionAssociationPosture(
		projectionWith({ sessionAssociation: "workflowAttested", workloadId: "wl-1" }),
	);
	const asserted = sessionAssociationPosture(
		projectionWith({ sessionAssociation: "ownerAsserted" }),
	);
	assert.notEqual(attested.label, asserted.label);
	assert.notEqual(attested.claim, asserted.claim);
	assert.notEqual(attested.weight, asserted.weight, "distinct visual weight, not just wording");
	assert.equal(attested.workloadId, "wl-1");
	assert.equal(asserted.workloadId, undefined, "ownerAsserted binds no workload identity");
	assert.match(attested.claim, /SERVER-ASSIGNED/);
	assert.match(asserted.claim, /HUMAN-ASSERTED/);
	assert.match(asserted.claim, /A posture, never an inference/);
});

test("R20: the posture distinction holds across every work kind", () => {
	for (const work of [commitWork, prWork, issueWork, sessionWork]) {
		const attested = sessionAssociationPosture(
			projectionWith({ work, sessionAssociation: "workflowAttested", workloadId: "wl" }),
		);
		const asserted = sessionAssociationPosture(projectionWith({ work }));
		assert.equal(attested.label, "WORKFLOW-ATTESTED");
		assert.equal(asserted.label, "OWNER-ASSERTED");
	}
});

test("R21: estimated and mixed carry the NOT-an-upper-bound caveat; provider carries the SCOPED claim", () => {
	assert.equal(ESTIMATES_NOT_UPPER_BOUND, "estimates are NOT a guaranteed upper bound.");
	assert.equal(usagePostureClaim("estimated").caveat, ESTIMATES_NOT_UPPER_BOUND);
	assert.equal(usagePostureClaim("mixed").caveat, ESTIMATES_NOT_UPPER_BOUND);
	assert.equal(usagePostureClaim("provider").caveat, undefined);

	const provider = usagePostureClaim("provider");
	assert.equal(
		PROVIDER_SCOPED_CLAIM,
		"never understates the ledger-POSTed cost of this governed session",
	);
	assert.match(provider.claim, /never understates the ledger-POSTed cost of this governed session/);
	// The RETIRED unconditional form must not appear anywhere in the claim.
	assert.ok(
		!/never understates\.$/.test(provider.claim),
		'the unconditional "never understates" is retired and must not appear',
	);
});

// ---------------------------------------------------------------------------
// R38-R41 — what the amount COVERS, what it BOUNDS, and the anchored rung
// ---------------------------------------------------------------------------

const ALL_POSTURES = [
	"selfDebitsOnly",
	"includesSomeDelegated",
	"includesAllDelegated",
	"indeterminate",
] as const;

test("R39: all four delegation postures render, and no two share a label or a framing", () => {
	// "Identical rendering is forbidden" applied to the axis where it matters
	// most: these four framings are the only thing separating a scoped figure
	// from a total, and two that collapsed onto one string would read as one
	// claim. A verifier must recognize all four even though v1 minting emits one.
	const labels = new Set<string>();
	const framings = new Set<string>();
	for (const posture of ALL_POSTURES) {
		const claim = delegationScopeClaim(posture);
		assert.equal(claim.value, posture, `${posture}: the wire value renders as itself`);
		assert.ok(claim.label.length > 0 && claim.claim.length > 0, `${posture}: nothing may be blank`);
		labels.add(claim.label);
		framings.add(claim.claim);
	}
	assert.equal(labels.size, 4, "four distinct labels");
	assert.equal(framings.size, 4, "four distinct framings");
});

test("R39: selfDebitsOnly is DIRECT / self-account spend, delegated spend OUT OF SCOPE", () => {
	const claim = delegationScopeClaim("selfDebitsOnly");
	assert.equal(claim.label, "SELF-DEBITS ONLY");
	assert.match(claim.claim, /DIRECT, self-account spend/);
	assert.match(claim.claim, /built ONLY from debits charged to the receipt subject/);
	assert.match(claim.claim, /Delegated spend is OUT OF SCOPE/);
	assert.match(claim.claim, /charged to that delegate and is not counted/);
});

test("R39: includesSomeDelegated is an INCOMPLETE attributed subtotal that bounds nothing", () => {
	const claim = delegationScopeClaim("includesSomeDelegated");
	assert.match(claim.claim, /INCOMPLETE ATTRIBUTED SUBTOTAL/);
	assert.match(claim.claim, /coverage is NOT established/);
	assert.match(claim.claim, /must not be read as the cost of the work this subject caused/);
});

test("R39: indeterminate states end-to-end coverage CANNOT BE VERIFIED, and bounds nothing", () => {
	const claim = delegationScopeClaim("indeterminate");
	assert.match(claim.claim, /END-TO-END COVERAGE CANNOT BE VERIFIED/);
	assert.match(claim.claim, /no bound in either direction/);
	assert.match(claim.claim, /neither a floor nor a ceiling/);
});

test("R39: includesAllDelegated is an UNEVIDENCED claim, never worded as a total", () => {
	// The one value that MAY be worded as the total cost of work caused by the
	// subject — and only with validating signed evidence, a format this version
	// does not specify. `wire.ts` fails such a receipt closed before it renders;
	// this fallback is the render layer's own refusal, so the property does not
	// depend on the parse layer remembering to hold it.
	const claim = delegationScopeClaim("includesAllDelegated");
	assert.match(claim.claim, /TOTAL COST OF WORK CAUSED BY THE SUBJECT/);
	assert.match(claim.claim, /transitive descendants included, exactly once/);
	assert.match(claim.claim, /ONLY when signed evidence a verifier can validate accompanies it/);
	assert.match(claim.claim, /no such evidence format exists in this version/);
	assert.match(claim.claim, /is not presented here as a total/);
	assert.match(claim.claim, /UNEVIDENCED/);
});

test("R40: the floor claim is granted to selfDebitsOnly and REFUSED to every other posture", () => {
	// The default is NO claim, with the bound as the named exception. A posture
	// whose soundness precondition fails must not silently inherit a bound.
	const granted = amountFloorClaim("selfDebitsOnly", "4.8224");
	assert.ok(granted, "selfDebitsOnly earns the bound");
	assert.match(granted ?? "", /at least \$4\.8224 of spend was CAUSED by this subject/);
	assert.match(granted ?? "", /exactly \$4\.8224 was CHARGED to this session/);
	assert.match(granted ?? "", /delegated spend is never negative/);
	assert.match(granted ?? "", /can only be higher than this figure — never lower/);

	for (const posture of ALL_POSTURES) {
		if (posture === "selfDebitsOnly") continue;
		assert.equal(
			amountFloorClaim(posture, "4.8224"),
			undefined,
			`${posture}: the precondition fails, so no bound may be inherited`,
		);
	}
});

test("R40: the floor restores the strong claim WITHOUT restating the retired unconditional promise", () => {
	// The premise correction this amendment rests on: the unconditional "never
	// understates what the work cost" is retired, and the live form is scoped.
	// Floor framing is precisely what lets the strong claim hold without
	// resurrecting the retired sentence — including in order to except it.
	const granted = amountFloorClaim("selfDebitsOnly", "1.0000") ?? "";
	for (const framing of ALL_POSTURES.map((p) => delegationScopeClaim(p).claim)) {
		assert.ok(!/never understates/i.test(framing), "R39 copy must not restate the retired promise");
	}
	assert.ok(!/never understates/i.test(granted), "R40 copy must not restate it either");
});

test("R41: the anchored rung's binding is resolver-asserted TODAY, not inherently uncheckable", () => {
	// The distinction is load-bearing: one says no binding is defined yet,
	// the other says the design forbids one. The check does not exist to
	// apply; publishing today's record would not make the rung checkable.
	// The disclosure retires when a binding is defined, not on publication
	// of an unbound record, and not by calling the gap permanent.
	assert.match(ANCHOR_BINDING_RESOLVER_ASSERTED, /ASSERTED BY THE RESOLVER/);
	assert.match(ANCHOR_BINDING_RESOLVER_ASSERTED, /today, independently checkable by no one/);
	assert.match(ANCHOR_BINDING_RESOLVER_ASSERTED, /no normative binding is defined/);
	assert.match(
		ANCHOR_BINDING_RESOLVER_ASSERTED,
		/What is missing is the binding, not merely published evidence/,
	);
	assert.match(ANCHOR_BINDING_RESOLVER_ASSERTED, /is not verified anchoring/);
	assert.ok(
		!/cannot ever|inherently|by design/i.test(ANCHOR_BINDING_RESOLVER_ASSERTED),
		"the copy must not read as a permanent design limit",
	);
	assert.ok(
		!/not the check|already exists|merely awaits/i.test(ANCHOR_BINDING_RESOLVER_ASSERTED),
		"the copy must not claim a check that is only unpublished",
	);
});

test("R22: the two pricing postures render distinctly, conservative naming the round-up", () => {
	const conservative = pricingPostureClaim("conservative");
	const exact = pricingPostureClaim("exact");
	assert.notEqual(conservative.label, exact.label);
	assert.match(
		conservative.claim,
		/at least one leg was priced by a fallback that can only round up/,
	);
});

test('R24: the "custom" literal renders honestly — never expanded, never hidden', () => {
	assert.equal(CUSTOM_MODEL_MEANING, "one or more non-catalog or custom-rate models");
	const mixed = catalogRendering(["claude-sonnet-4-6", "custom"]);
	assert.deepEqual(mixed.catalog, ["claude-sonnet-4-6"]);
	assert.ok(mixed.hasCustom);
	assert.equal(mixed.customMeaning, CUSTOM_MODEL_MEANING);

	const onlyCustom = catalogRendering(["custom"]);
	assert.deepEqual(onlyCustom.catalog, [], "the literal is never rendered as a model NAME");
	assert.ok(onlyCustom.hasCustom, "and it is never dropped either");

	const plain = catalogRendering(["claude-sonnet-4-6"]);
	assert.ok(!plain.hasCustom);
	assert.equal(plain.customMeaning, undefined);
});

test("R25: transferSet present is a recomputable digest; absent is a COMMITMENT, verbatim", () => {
	assert.equal(
		TRANSFER_SET_ROOT_COMMITMENT,
		"checkable against disclosed data, not recomputable from the receipt alone",
	);
	const present = transferSetRendering(projectionWith({}));
	assert.ok(!present.rootIsCommitment);
	assert.match(present.rootMeaning, /recomputable digest/);

	const absent = transferSetRendering(
		projectionWith({
			transferSet: undefined,
			spend: { ...projectionWith({}).spend, transferCount: 57 },
		}),
	);
	assert.ok(absent.rootIsCommitment);
	assert.equal(absent.rootMeaning, TRANSFER_SET_ROOT_COMMITMENT);
	assert.notEqual(present.rootMeaning, absent.rootMeaning, "the two render DIFFERENTLY");
});

test("R26: repositoryMembership reads as the minter's COMMITTED OBSERVATION, verbatim", () => {
	assert.equal(
		MEMBERSHIP_EPISTEMIC_SCOPE,
		"an offline verifier proves the minter committed to having observed membership, not the observation itself.",
	);
	const note = membershipLedgerNote("providerVerified", "05b196f30cc951033216613a");
	assert.match(note, /providerVerified/);
	assert.match(note, /05b196f30cc951033216613a/, "the opaque proofId is rendered, not described");
	assert.match(note, /the chain commits the MINTER'S CLAIM to have observed membership/);
	assert.match(note, /not the observation itself/);
});

test("R27: mintedAt is labeled minter-asserted — the ONLY one", () => {
	assert.equal(MINTED_AT_LABEL, "MINTER-ASSERTED");
	assert.equal(MINTED_AT_NOTE, "the only minter-asserted clock claim.");
});

// ---------------------------------------------------------------------------
// R28-R31 — the unsigned display annex
// ---------------------------------------------------------------------------

test("R28-R31: the display annex label and each member's not-chain-committed note", () => {
	assert.equal(DISPLAY_ANNEX_LABEL, "DISPLAY DATA — NOT CHAIN-COMMITTED");
	assert.match(PRICING_TABLES_NOTE, /never rendered as if the chain vouched for them/);
	assert.match(EXECUTION_METADATA_NOTE, /never a work-class claim/);
});

// ---------------------------------------------------------------------------
// R9-R12 — the check ledger
// ---------------------------------------------------------------------------

test("R9: the ledger covers all nine steps and all four named online checks, by name", () => {
	assert.deepEqual(
		LEDGER_ROWS.filter((row) => row.group === "steps").map((row) => row.name),
		[
			"schema",
			"event",
			"registry",
			"signature",
			"inclusion",
			"checkpoint",
			"semantics",
			"derivations",
			"extensions",
		],
	);
	assert.deepEqual(
		CHECK_ROWS.map((row) => row.name),
		["registryBinding", "predecessorLinkage", "checkpointHistory", "anchorEvidence"],
	);
	for (const row of LEDGER_ROWS) {
		assert.ok(row.meaning.length > 0, `${row.name} has a one-line meaning`);
		assert.ok(row.label === row.label.toUpperCase(), `${row.name}'s label is the uppercase voice`);
	}
});

test("R9: the ledger footer names the trust snapshot the verification ran under", () => {
	assert.equal(
		trustSnapshotLine("usertrust-verify@2026-08-10T00:00:00Z"),
		"verified under trust snapshot usertrust-verify@2026-08-10T00:00:00Z",
	);
});

test("R9: the four-valued result is rendered by NAME — never a boolean", () => {
	assert.deepEqual(Object.keys(RESULT_LABEL).sort(), [
		"failed",
		"notApplicable",
		"passed",
		"unavailable",
	]);
	assert.equal(RESULT_LABEL.notApplicable, "N/A");
	assert.equal(new Set(Object.values(RESULT_LABEL)).size, 4, "four distinct rendered words");
});

test("R12: notApplicable's meaning is the spec's own sentence, and it is not a tick", () => {
	assert.equal(
		NOT_APPLICABLE_MEANING,
		"neither a pass nor a failure; it NARROWS the verdict and MUST be reported.",
	);
});

test("§6.3: the semantics row carries the attested-enum epistemic label", () => {
	const semantics = LEDGER_ROWS.find((row) => row.name === "semantics");
	assert.ok(semantics);
	assert.match(semantics.meaning, /POSTURE ENUM VALIDITY/);
	assert.ok(semantics.meaning.includes(POSTURES_ARE_ATTESTED_ENUMS));
});

test("§6.3: the anchorEvidence row names the AUDITOR's pinned key, never one the receipt names", () => {
	const anchor = CHECK_ROWS.find((row) => row.name === "anchorEvidence");
	assert.ok(anchor);
	assert.match(anchor.meaning, /AUDITOR'S pinned log key/);
	assert.match(anchor.meaning, /can never demote the base verdict/);
});

// ---------------------------------------------------------------------------
// R33/R34 — advisories
// ---------------------------------------------------------------------------

test("R33: a supersession advisory links the superseding receipt and leaves the verdict alone", () => {
	const band = advisoryBand({
		kind: "receiptSuperseded",
		supersededByReceiptId: "ut1_AAAAAAAAAAAAAAAAAAAAAA",
		eventHash: "ab".repeat(32),
	});
	assert.equal(band.linkedReceiptId, "ut1_AAAAAAAAAAAAAAAAAAAAAA");
	assert.match(band.body, /never alters this receipt's cryptographic verdict/);
});

test("R34: a generation addendum says the trailer cites generation 1 forever", () => {
	const band = advisoryBand({
		kind: "generationAddendum",
		generation: 2,
		receiptId: "ut1_BBBBBBBBBBBBBBBBBBBBBB",
	});
	assert.match(band.body, /generation 2 was minted as ut1_BBBBBBBBBBBBBBBBBBBBBB/);
	assert.match(band.body, /trailer cites generation 1 forever/);
	assert.match(band.body, /never a trailer rewrite/);
	assert.equal(band.linkedReceiptId, "ut1_BBBBBBBBBBBBBBBBBBBBBB");
});

test("§4.1: an UNKNOWN advisory kind is named generically — never silently dropped", () => {
	const band = advisoryBand({ kind: "somethingNewInV1_1", detail: "whatever" });
	assert.equal(band.kind, "somethingNewInV1_1");
	assert.match(band.body, /somethingNewInV1_1/);
	assert.match(band.body, /never alters this receipt's cryptographic verdict/);
});

test("every advisory band states that it is advisory-only", () => {
	const advisories = [
		{ kind: "receiptSuperseded", supersededByReceiptId: "ut1_x", eventHash: "aa" },
		{ kind: "generationAddendum", generation: 2, receiptId: "ut1_y" },
		{ kind: "totallyUnknown" },
	];
	for (const advisory of advisories) {
		assert.ok(advisoryBand(advisory).body.includes(ADVISORY_NEVER_ALTERS_VERDICT));
	}
});
