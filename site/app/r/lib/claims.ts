/**
 * The CLAIMS SURFACE — every sentence the verify page asserts about a receipt,
 * and the two derivations the page itself performs.
 *
 * This module exists because the page's honesty is made of STRINGS. The verdict
 * ladder's disclaimers, the per-kind headline claims, the posture caveats, the
 * epistemic labels in the check ledger, the not-chain-committed labels on
 * unsigned material — the specs mandate these VERBATIM, and a redesign that
 * silently drops one turns an honest exhibit into an overclaim. Keeping them
 * here, as exported constants a test pins character-for-character, is the
 * motion-doctrine-test pattern applied to copy: the component may change shape
 * freely, but it cannot lose a disclaimer without a test going red.
 *
 * Sources, in authority order (verify-page design spec's own ordering):
 *   1. `docs/specs/receipt-spec.md` v0.7 — §2 (the projection, postures,
 *      `amountUsd`, the disclosure rules), §6a (distinct rendering, the
 *      minter-asserted clock claim), §7 (the ladder, the four-valued results,
 *      the per-kind consumer rules), §8 (trust snapshots).
 *   2. `docs/specs/2026-08-11-verify-page-design.md` v0.5 — §5 R5-R34 (the
 *      numbered rendering obligations), §6 (the design binding), §7 (the copy
 *      anchors), §8 (the fixture matrix each string is asserted against).
 *
 * Two rules govern everything below.
 *
 * **The page never computes a verdict (D2).** Nothing here decides anything.
 * `warrantedRung`/`checkVerdictAlgebra` live in `wire.ts` and consume the
 * resolver's own structured results; this module only says what the rendered
 * answer MEANS.
 *
 * **Every claim is scoped to what the receipt EMBEDS.** The page has no
 * containing artifact (receipt-spec §7, "Verification consumers"), so it never
 * renders "this artifact is verified" — it renders what the receipt attests and
 * teaches the reader the comparison only they can make (R13/R15).
 */

import { type Bag, num, str } from "./unsigned-reads";
import type {
	Advisory,
	CheckName,
	DelegationPosture,
	LadderStatus,
	Projection,
	ReceiptDocument,
	StepName,
	StepResult,
	Work,
} from "./wire";

// ===========================================================================
// R5-R8 — the verdict ladder and its disclaimers
// ===========================================================================

/**
 * The three rungs, floor first. R5: the page "shows which rung this receipt
 * reached AND which rungs exist above it" — so the ladder is always rendered
 * whole, never truncated at the reached rung.
 */
export const LADDER: readonly LadderStatus[] = [
	"verified_checkpoint",
	"verified_checkpoint_history",
	"verified_anchored",
];

/**
 * §7's masthead words. "The verdict is never color-only: the word IS the
 * verdict" (§6.1) — which is why these are the rendered text and not labels
 * attached to a green dot. `ogCardWord` is this string: a qualification
 * that lives only in the ladder body never reaches the share card.
 *
 * R41: the anchored word carries `RESOLVER-ASSERTED` because the binding
 * is not independently checkable. An unqualified "VERIFIED — ANCHORED"
 * contradicts the disclosure that this is not verified anchoring.
 */
export const RUNG_VERDICT_WORD: Record<LadderStatus, string> = {
	verified_checkpoint: "VERIFIED — CHECKPOINT",
	verified_checkpoint_history: "VERIFIED — CHECKPOINT HISTORY",
	verified_anchored: "VERIFIED — ANCHORED · RESOLVER-ASSERTED",
};

/** Short rung name for the three-step indicator (§6.1). */
export const RUNG_SHORT_NAME: Record<LadderStatus, string> = {
	verified_checkpoint: "CHECKPOINT",
	verified_checkpoint_history: "CHECKPOINT HISTORY",
	verified_anchored: "ANCHORED",
};

/**
 * R5 — upper rungs are "outlined, labeled with what would earn them". An
 * unreached rung that says only "not reached" teaches nothing; naming the
 * evidence that would earn it is what makes the ladder honest rather than
 * merely decorative.
 */
export const RUNG_EARNED_BY: Record<LadderStatus, string> = {
	verified_checkpoint:
		"the base steps pass: this projection is an event included in a Merkle snapshot signed by the checkpoint key.",
	verified_checkpoint_history:
		"a COMPLETE segment-checkpoint history is served and walks clean — registered genesis → head, one checkpoint per segment, signed lineage — and contains this receipt's own checkpoint.",
	verified_anchored:
		"Rekor anchor evidence validates offline against a pinned log key, on top of the complete verified history (the ladder is cumulative).",
};

/**
 * R6, VERBATIM IN FORCE (receipt-spec §7, `VERIFIED_CHECKPOINT`). Rendered as
 * the rung's fine print, "not hidden behind interaction" (§7).
 */
export const FORK_DISCLAIMER =
	"this level does NOT prove whole-chain linear consistency, anchor-sequence continuity, or external immutability — a checkpoint signer could sign a fork.";

/** R7 / §7 — what the history walk actually proved. */
export const HISTORY_WALK_PROVED =
	"the served history walks clean from the chain's registered genesis to a head at or after this receipt's segment: exactly one checkpoint per segment, the signed lineage edge intact at every step, and this receipt's own checkpoint present in it.";

/**
 * R7, VERBATIM IN FORCE (receipt-spec §7). The history rung's surviving gap,
 * named precisely — a walk that proves everything above still proves nothing
 * about a SECOND history the same key could have signed.
 */
export const EQUIVOCATION_CAVEAT =
	"the surviving gap is EQUIVOCATION — the checkpoint key holder could sign two internally perfect histories and show each to different audiences.";

/**
 * R7 — closing equivocation is a NAMED v1 non-goal, and "the page must not
 * imply otherwise". Rendered beside the caveat so no reader infers that a
 * future rung already exists for it.
 */
export const EQUIVOCATION_NON_GOAL =
	"closing it needs a non-equivocation mechanism — witness cosigning, or a public append-only checkpoint log every verifier can compare against — and that is a named non-goal for v1.";

/** R8 — the anchored rung's honest strength: PARTIAL mitigation, never closure. */
export const ANCHOR_PARTIAL_MITIGATION = "Rekor anchoring PARTIALLY mitigates equivocation";

/** R8, VERBATIM IN FORCE (receipt-spec §7) — why it mitigates at all. */
export const ANCHOR_EXTERNAL_VISIBILITY =
	"publishing a checkpoint to a public transparency log makes one history externally visible, so a second private history has to contradict something the world can already see";

/** R8 — and the equivocation gap that SURVIVES the anchor. */
export const ANCHOR_NOT_PROOF_OF_UNIQUENESS =
	"it does not prove the signer never produced another history, and the fork disclaimer REMAINS at this rung.";

/**
 * R8/R32 — S3 Object Lock probes are OPERATOR-ASSERTED configuration. The
 * strongest sentence in this file: this evidence "must never render as a green
 * anchor claim", so the label travels with the data everywhere it appears.
 */
export const S3_OPERATOR_ASSERTED =
	"S3 Object Lock evidence is OPERATOR-ASSERTED configuration: displayed as context only. It upgrades no cryptographic verdict and is never a green anchor claim.";

/** R32 — what Rekor evidence IS, in the terms an offline verifier uses. */
export const REKOR_EVIDENCE_MEANING =
	"the independently-verifiable-offline attachment: stored bytes, log inclusion, a signed log checkpoint, and a log key the auditor pinned — never one the receipt names.";

/**
 * The fine print a given rung carries, in render order. The fork disclaimer is
 * FIRST at every rung and never drops off: R7 "keeps the fork disclaimer" and
 * R8 says it "REMAINS at this rung". A ladder whose disclaimers shrink as the
 * rung rises would read as each upgrade closing the previous gap, which is the
 * precise overclaim these three obligations exist to prevent.
 */
export function rungDisclaimers(rung: LadderStatus): string[] {
	switch (rung) {
		case "verified_checkpoint":
			return [FORK_DISCLAIMER];
		case "verified_checkpoint_history":
			return [FORK_DISCLAIMER, HISTORY_WALK_PROVED, EQUIVOCATION_CAVEAT, EQUIVOCATION_NON_GOAL];
		case "verified_anchored":
			return [
				FORK_DISCLAIMER,
				HISTORY_WALK_PROVED,
				EQUIVOCATION_CAVEAT,
				`${ANCHOR_PARTIAL_MITIGATION}: ${ANCHOR_EXTERNAL_VISIBILITY} — ${ANCHOR_NOT_PROOF_OF_UNIQUENESS}`,
				EQUIVOCATION_NON_GOAL,
			];
	}
}

// ===========================================================================
// R23 — `amountUsd`, the one arithmetic derivation the page performs
// ===========================================================================

/**
 * receipt-spec §2: usertokens per dollar. Not a float ratio — a divisor.
 *
 * `BigInt(10_000)` and not the `10_000n` literal: the site targets ES2017,
 * where TypeScript rejects BigInt LITERAL syntax (TS2737). The runtime value is
 * identical, and this module only ever runs server-side.
 */
export const USERTOKENS_PER_USD = BigInt(10_000);

/** §2: rendered with EXACTLY four decimals ("4.8224"). */
export const AMOUNT_USD_DECIMALS = 4;

/**
 * R23 — `amountUsd` is never stored; it is DERIVED for display as
 * `assessedUsertokens / 10000` by **integer quotient/remainder (no float)**,
 * rendered with exactly four decimals (receipt-spec §2). The page recomputes it
 * from `assessedUsertokens` rather than trusting a wire string.
 *
 * `BigInt` and not `n / 10000`: the projection admits any integer up to
 * 2^53 − 1, and IEEE-754 division at that magnitude is not exact — a float
 * quotient can land one ulp below an integer boundary and truncate to the wrong
 * dollar. Integer quotient/remainder is what §2 says, and BigInt is the only
 * way to spell it in JavaScript without a rounding step somewhere.
 */
export function amountUsdFromUsertokens(assessedUsertokens: number): string {
	if (!Number.isSafeInteger(assessedUsertokens) || assessedUsertokens < 0) {
		throw new RangeError(
			`amountUsdFromUsertokens: expected a non-negative safe integer, got ${assessedUsertokens}`,
		);
	}
	const tokens = BigInt(assessedUsertokens);
	const dollars = tokens / USERTOKENS_PER_USD;
	const remainder = tokens % USERTOKENS_PER_USD;
	return `${dollars}.${remainder.toString().padStart(AMOUNT_USD_DECIMALS, "0")}`;
}

// ===========================================================================
// R13/R14/R15/R17/R18 — work scoping, per kind
// ===========================================================================

/**
 * R13 — the headline claim, scoped to what the receipt EMBEDS, in the spec's
 * own words. Three forms, one per `work.kind`; `session` carries NO artifact
 * claim at all, which is why it takes the amount instead of an artifact.
 * That `$X` is still an amount, so R39's scope (and the epistemic frame)
 * render beside it on the paper and in `WorkClaims`. R40's floor stays in
 * `SpendBlock` only — a bound printed twice is two copies that drift.
 */
export function headlineClaim(work: Work, amountUsd: string): string {
	switch (work.kind) {
		case "commit":
			return `attests commit ${work.oid} in ${work.repoId}`;
		case "pr":
			return `attests ${work.repoId} PR #${work.number} at revision ${work.observedRevision}`;
		case "issue":
			return `attests ${work.repoId} issue #${work.number} at revision ${work.observedRevision}`;
		case "session":
			return `produced under this governed session — $${amountUsd}`;
	}
}

/**
 * R13, VERBATIM — the sentence that scopes the whole page. Rendered beside the
 * headline so the claim's LIMIT arrives with the claim.
 */
export const NEVER_ARTIFACT_VERIFIED =
	'this page never renders "this artifact is verified"; it renders WHAT this receipt attests and leaves the reader to compare.';

/** R14, VERBATIM IN FORCE (receipt-spec §7) — `session` is a defined NON-artifact. */
export const SESSION_NON_ARTIFACT =
	"a session receipt attests a governed session's spend and nothing about any commit, PR, or issue that happens to cite it.";

/** R14 — and the consequence a promotion gate must honor. */
export const SESSION_PROMOTION_GATE =
	'consumers MUST NOT treat it as artifact attestation, and a promotion gate MUST NOT accept it (the gate requires kind === "commit").';

/** One line of R15's "verify against your artifact" teaching. */
export interface ComparisonStep {
	/** IDENTITY / BYTES / REVISION+CONTENT — the axis this comparison covers. */
	axis: string;
	body: string;
}

/**
 * R15 — the FULL comparison an ARTIFACT-AWARE consumer must make. The page
 * cannot perform any of it (it has no containing artifact); it renders it so
 * "no reader walks away with the unsafe check".
 *
 * The teaching is deliberately NOT a transplantable subset: the commit form
 * carries the promotion mandate WITH its reason, and the pr/issue form carries
 * both the immutable-ID rule and the frozen-revision rule, because dropping
 * either half is exactly how a transplant passes.
 */
export function artifactComparison(work: Work): ComparisonStep[] {
	switch (work.kind) {
		case "commit":
			return [
				{
					axis: "IDENTITY",
					body: "the containing commit's FULL object ID equals work.oid under work.oidAlg (prefixes never suffice), and its repository equals work.repoId — the immutable provider ID, never the mutable name.",
				},
				{
					axis: "BYTES",
					body: "work.objectSha256 compared over the canonical gitPreimage — MANDATORY for a green PROMOTION verdict: a promotion gate that cannot hash the merge candidate's bytes MUST NOT pass it, because OID equality alone leaves SHA-1 twins indistinguishable.",
				},
				{
					axis: "BYTES, OUTSIDE PROMOTION",
					body: "when a consumer genuinely has no bytes, the digest check is notApplicable and the verdict says so — never silently skipped.",
				},
			];
		case "pr":
		case "issue":
			return [
				{
					axis: "IDENTITY, FAIL ON MISMATCH",
					body: "work.providerArtifactId, work.repoId and work.number must ALL equal the containing artifact's — number and URL are both reusable, so the immutable provider ID is what fails a transplant.",
				},
				{
					axis: "REVISION + CONTENT",
					body:
						work.contentBinding.kind === "publicSha256"
							? "resolved against the FROZEN revision: at work.observedRevision the artifact's content satisfies work.contentBinding — publicSha256, recomputed DIRECTLY by the consumer."
							: "resolved against the FROZEN revision: at work.observedRevision the artifact's content satisfies work.contentBinding — privateHmacSha256V1, confirmed SERVER-ASSISTED via the resolver (the HMAC key is server-side and never exposed).",
				},
				{
					axis: "A NEWER REVISION IS NOT A MISMATCH",
					body: "a newer CURRENT revision is the revisionSuperseded display state, not a failure; a DIFFERENT artifact is a mismatch and fails.",
				},
			];
		case "session":
			return [
				{ axis: "NO ARTIFACT TO COMPARE", body: SESSION_NON_ARTIFACT },
				{ axis: "PROMOTION", body: SESSION_PROMOTION_GATE },
			];
	}
}

/**
 * R16, VERBATIM IN FORCE (receipt-spec §7) — a DISPLAY STATE, never a status.
 * "Not a failure, not a downgrade, and never silently a plain green check."
 */
export function revisionSupersededLine(observedRevision: string): string {
	return `attests revision ${observedRevision}; the artifact has since changed`;
}

/** R18 — the keyed `r1_…` form's rendering. Never dropped, never apologized for. */
export const UNDISCLOSED_PRIVATE_REPO = "undisclosed private repository";

/** R18's disclosure split: `repoId` is always the scope; `repo` is display metadata. */
export interface RepoScope {
	/** ALWAYS rendered — the normative scope. */
	repoId: string;
	/** The keyed `r1_…` form names a repository whose name was never disclosed. */
	undisclosed: boolean;
	/** `repo`, the MUTABLE name, present only under the §2 disclosure rule. */
	displayName?: string;
	/** What the scope line reads as. */
	label: string;
}

export function repoScope(work: Work): RepoScope {
	const undisclosed = work.repoId.startsWith("r1_");
	return {
		repoId: work.repoId,
		undisclosed,
		displayName: work.repo,
		label: undisclosed ? UNDISCLOSED_PRIVATE_REPO : (work.repo ?? work.repoId),
	};
}

/** R18 — why the mutable name is never the scope, rendered where the name is. */
export const REPO_NAME_IS_NOT_SCOPE =
	"repoId is the scope; repo is display metadata captured at mint — names are mutable and reusable, so a name is never scope.";

/**
 * R17 — "a display may truncate, the projection never does". A truncated value
 * is only honest when the full one is one interaction away, so every caller of
 * this helper renders a copy affordance carrying {@link full}.
 */
export const TRUNCATION_HEAD = 12;

export interface TruncatedValue {
	full: string;
	display: string;
	truncated: boolean;
}

export function truncateForDisplay(value: string, head: number = TRUNCATION_HEAD): TruncatedValue {
	if (value.length <= head) return { full: value, display: value, truncated: false };
	return { full: value, display: `${value.slice(0, head)}…`, truncated: true };
}

/**
 * R19 — the fallback-session variant. This receipt is the SPEND-ONLY record of
 * a reservation that billed but was never finalized, and it links back.
 */
export const FALLBACK_SESSION_ORIGIN =
	"this is the spend-only record of a reservation that billed but was never finalized; it links back to the reservation the trailer cited.";

// ===========================================================================
// R20-R27 — postures and spend, as ATTESTED CLAIMS
// ===========================================================================

/**
 * The epistemic frame binding the whole posture group (receipt-spec §2,
 * round-1 P2-7). Rendered once at the top of `AmountScope` — the first
 * posture the reader meets — and echoed in the check ledger's `semantics`
 * meaning (§6.3). A posture chip on its own reads like a measurement, and
 * this sentence is what stops it.
 */
export const POSTURES_ARE_ATTESTED_ENUMS =
	"postures are ATTESTED ENUMS, not verifier-established facts: the verifier checks enum validity and internal agreement — it CANNOT confirm them, because both are defined over per-constituent facts the projection deliberately does not carry.";

/** One rendered posture: a chain-committed CLAIM, never a re-derived fact. */
export interface PostureClaim {
	/** The wire enum value, rendered as itself. */
	value: string;
	/** The uppercase label the chip shows. */
	label: string;
	/** What the minter attested by choosing this enum. */
	claim: string;
	/** The mandated caveat, when the enum carries one. */
	caveat?: string;
}

/**
 * R20 — `sessionAssociation` postures RENDER DISTINCTLY (§6a: "identical
 * rendering is forbidden"). Distinct label, distinct visual weight, and the
 * distinction holds across every `work.kind`: an `ownerAsserted` commit and a
 * `workflowAttested` session both render their TRUE posture.
 */
export function sessionAssociationPosture(projection: Projection): PostureClaim & {
	/** The server-assigned attested workload identity — present iff attested. */
	workloadId?: string;
	/** Drives the distinct visual weight the §6a rule requires. */
	weight: "attested" | "asserted";
} {
	if (projection.sessionAssociation === "workflowAttested") {
		return {
			value: "workflowAttested",
			label: "WORKFLOW-ATTESTED",
			claim:
				"a trusted execution workflow controlled the reservation, the model traffic, the workspace, and the artifact creation; workloadId is the SERVER-ASSIGNED attested workload identity, bound by the orchestrator and never caller-selected.",
			workloadId: projection.workloadId,
			weight: "attested",
		};
	}
	return {
		value: "ownerAsserted",
		label: "OWNER-ASSERTED",
		claim:
			"a HUMAN-ASSERTED association — no attested workflow controlled this session, and no workload identity was bound. A posture, never an inference.",
		weight: "asserted",
	};
}

/**
 * R21 — `usagePosture` on EVERY receipt, as the attested claim it is.
 * `estimated`/`mixed` carry the caveat; `provider` carries the SCOPED claim of
 * §10.5 — the unconditional "never understates" is retired and must not appear.
 */
export const ESTIMATES_NOT_UPPER_BOUND = "estimates are NOT a guaranteed upper bound.";

export const PROVIDER_SCOPED_CLAIM =
	"never understates the ledger-POSTed cost of this governed session";

export function usagePostureClaim(usagePosture: Projection["spend"]["usagePosture"]): PostureClaim {
	switch (usagePosture) {
		case "provider":
			return {
				value: "provider",
				label: "PROVIDER-METERED",
				claim: `EVERY constituent was priced from provider-reported usage — ${PROVIDER_SCOPED_CLAIM}.`,
			};
		case "estimated":
			return {
				value: "estimated",
				label: "ESTIMATED",
				claim: "EVERY constituent used the estimate path.",
				caveat: ESTIMATES_NOT_UPPER_BOUND,
			};
		case "mixed":
			return {
				value: "mixed",
				label: "MIXED",
				claim: "both provider-metered and estimated constituents are present.",
				caveat: ESTIMATES_NOT_UPPER_BOUND,
			};
	}
}

/** R22 — `pricingPosture`, rendered distinctly, as an attested claim. */
export function pricingPostureClaim(
	pricingPosture: Projection["spend"]["pricingPosture"],
): PostureClaim {
	if (pricingPosture === "conservative") {
		return {
			value: "conservative",
			label: "CONSERVATIVE",
			claim: "at least one leg was priced by a fallback that can only round up.",
		};
	}
	return {
		value: "exact",
		label: "EXACT",
		claim: "every leg was priced from the published table at its committed version.",
	};
}

// ===========================================================================
// R38-R41 — `delegationPosture`: what the amount COVERS
// ===========================================================================

/**
 * R38's other half. `wire.ts` already refuses to render an amount whose posture
 * is missing or unrecognized (the fail-closed half); this is the LABEL half —
 * the sentence that travels with every figure the page does render.
 *
 * The four values are the VERIFIER's vocabulary, wider than v1 minting's: a
 * conformant v1 minter emits only `selfDebitsOnly`, and a verifier must
 * recognize and render all four. Each gets its OWN framing (R39) because the
 * distinction is the whole point — an amount rendered without its scope is an
 * amount whose scope the reader supplies from assumption, and the assumption is
 * always "this is what the work cost".
 */
export const DELEGATION_POSTURE_LABEL: Record<DelegationPosture, string> = {
	selfDebitsOnly: "SELF-DEBITS ONLY",
	includesSomeDelegated: "INCLUDES SOME DELEGATED",
	includesAllDelegated: "INCLUDES ALL DELEGATED",
	indeterminate: "INDETERMINATE",
};

/** R39 — `selfDebitsOnly`: DIRECT / self-account spend, delegated spend out of scope. */
export const SELF_DEBITS_ONLY_SCOPE =
	"this amount is DIRECT, self-account spend: it is built ONLY from debits charged to the receipt subject. Delegated spend is OUT OF SCOPE — work this subject caused a delegate to perform was charged to that delegate and is not counted in the figure above.";

/** R39 — `includesSomeDelegated`: an INCOMPLETE attributed subtotal, bounding nothing. */
export const INCLUDES_SOME_DELEGATED_SCOPE =
	"this amount is an INCOMPLETE ATTRIBUTED SUBTOTAL: some causally attributable delegated debits are included, and coverage is NOT established. How much delegated spend is left out is unquantified, so the figure above bounds nothing and must not be read as the cost of the work this subject caused.";

/**
 * R39 — `indeterminate`: end-to-end coverage cannot be verified.
 *
 * Unknown coverage is not "probably self-debits". It admits BOTH directions:
 * debits the subject did not cause may be in the total, and debits it did cause
 * may be missing. That is why this value supports no bound — see
 * {@link amountFloorClaim}, which refuses it for exactly this reason.
 */
export const INDETERMINATE_SCOPE =
	"END-TO-END COVERAGE CANNOT BE VERIFIED for this amount: the minter could not establish which delegated debits, if any, it covers. Unknown coverage supports no bound in either direction — the figure above is neither a floor nor a ceiling on the cost of the work this subject caused.";

/**
 * R39 — `includesAllDelegated`, the UNEVIDENCED fallback.
 *
 * This is the only value that may be worded as the total cost of work caused by
 * the subject, and only when signed evidence an offline verifier can validate
 * accompanies it. No such evidence format is specified in this version, so the
 * claim is currently unbackable — `wire.ts` fails the receipt closed before it
 * reaches a render. This string is the render layer's own refusal, so the
 * property does not depend on the parse layer remembering to hold it: if the
 * value ever reaches an amount, it renders as an unevidenced claim, never as a
 * total.
 */
export const INCLUDES_ALL_DELEGATED_UNEVIDENCED =
	"this receipt claims its amount is the TOTAL COST OF WORK CAUSED BY THE SUBJECT — every causally attributable delegated debit, transitive descendants included, exactly once. That claim may be presented as a total ONLY when signed evidence a verifier can validate accompanies it, and no such evidence format exists in this version — so the claim is UNEVIDENCED, is checkable by no one, and is not presented here as a total.";

/** R39's four framings, by value. */
export const DELEGATION_POSTURE_SCOPE: Record<DelegationPosture, string> = {
	selfDebitsOnly: SELF_DEBITS_ONLY_SCOPE,
	includesSomeDelegated: INCLUDES_SOME_DELEGATED_SCOPE,
	indeterminate: INDETERMINATE_SCOPE,
	includesAllDelegated: INCLUDES_ALL_DELEGATED_UNEVIDENCED,
};

/**
 * R38/R39 — the posture rendered as the attested claim it is, beside the amount
 * it scopes. Same shape as the other three postures so it inherits their
 * treatment rather than inventing a second one.
 */
export function delegationScopeClaim(delegationPosture: DelegationPosture): PostureClaim {
	return {
		value: delegationPosture,
		label: DELEGATION_POSTURE_LABEL[delegationPosture],
		claim: DELEGATION_POSTURE_SCOPE[delegationPosture],
	};
}

/**
 * R40 — the FLOOR claim: the amount rendered as a lower bound on total caused
 * cost, alongside the exact charged figure.
 *
 * Delegated spend is never negative, so a `selfDebitsOnly` amount — built only
 * from debits the subject itself incurred — is ALREADY a valid floor on the
 * cost of the work this subject caused. A floor cannot understate, because it
 * does not claim to be the total. So this is not an exception carved out of a
 * promise; it is the strong claim, made with the number the receipt already
 * carries.
 *
 * **The bound is PER-POSTURE, and three of the four values do not earn it.**
 * A posture whose soundness precondition fails degrades to its R39 copy alone
 * rather than silently inheriting a bound it cannot support:
 *
 * - `selfDebitsOnly` — VALID. Every included debit is one the subject actually
 *   incurred, the omitted delegated spend is non-negative, and the charged
 *   figure is exact (§2 pins `posted === assessed`).
 * - `includesSomeDelegated` — REFUSED. A floor needs every included constituent
 *   to be provably caused by the subject, and the projection carries no
 *   per-constituent facts to establish that. Unreachable in v1 minting anyway.
 * - `indeterminate` — REFUSED, and asserting it here would be a NEW honesty
 *   defect rather than a missing nicety: if coverage is unknown, the total may
 *   include cost the subject did not cause, so "at least this much was caused"
 *   could be flatly false. Unknown coverage bounds nothing in either direction.
 * - `includesAllDelegated` — unnecessary (the value claims to BE the total) and
 *   unreachable pending the signed-evidence format.
 *
 * INTERIM: this framing retires on PARENT-STAMPING — attributing delegated
 * debits to the parent receipt as signed non-billing entries makes the figure
 * an exact total, at which point the floor wording is replaced by the total.
 *
 * This function is the ONLY place the string and its trigger condition live, so
 * retiring it is a single-site change.
 */
export function amountFloorClaim(
	delegationPosture: DelegationPosture,
	amountUsd: string,
): string | undefined {
	if (delegationPosture !== "selfDebitsOnly") return undefined;
	return `at least $${amountUsd} of spend was CAUSED by this subject, and exactly $${amountUsd} was CHARGED to this session. Delegated work is charged to the delegate and delegated spend is never negative, so the caused total is equal to or higher than this figure — never lower.`;
}

/**
 * R41 — the anchored rung is RESOLVER-ASSERTED.
 *
 * No normative binding is defined today between a transparency-log entry and
 * a `SegmentCheckpoint`. Publishing a record would not make the rung
 * independently checkable, because there is no rule a third party could apply
 * to that record. The honest statement is therefore about the binding, not
 * about unpublished evidence: the rung reports the resolver's claim, and no
 * one — this page, the offline CLI, a third party — can confirm it. R8's
 * copy alone would read as independently established anchoring, which is the
 * overclaim this corrects.
 *
 * The rung still renders: the resolver's claim is real and reporting it is
 * honest (D2 — the page renders the resolver's verdict, it does not compute
 * one). It simply must not be worded as verified anchoring, and it must not
 * claim a check already exists that merely awaits publication.
 *
 * INTERIM: retires when a binding is defined *and* the evidence a third
 * party would need to apply it is served. Either half alone is not enough.
 */
export const ANCHOR_BINDING_RESOLVER_ASSERTED =
	"the anchor binding at this rung is ASSERTED BY THE RESOLVER and, today, independently checkable by no one: no normative binding is defined between a transparency-log entry and this checkpoint's signed payload, so no consumer — this page, the offline CLI, or a third party — can confirm the binding for itself. What is missing is the binding, not merely published evidence. Until that rule exists, this rung reports the resolver's claim and is not verified anchoring.";

/** R24, VERBATIM — the `"custom"` literal renders honestly, never expanded, never hidden. */
export const CUSTOM_MODEL_MEANING = "one or more non-catalog or custom-rate models";

/** The single fixed literal §2 defines for any non-catalog / custom-rate model. */
export const CUSTOM_MODEL_LITERAL = "custom";

export interface CatalogRendering {
	/** Published-catalog identifiers, rendered as themselves. */
	catalog: string[];
	/** Whether the `"custom"` literal is present. */
	hasCustom: boolean;
	/** What `"custom"` means, when it is. */
	customMeaning?: string;
}

/**
 * R24 — `models[]` / `providers[]` render as the CATALOG IDENTIFIERS they are.
 * `"custom"` is pulled out and explained rather than shown as if it were a
 * model name: it is one literal standing for N models, and rendering it inline
 * would read as a single custom model (understating) while expanding it would
 * invent names §2 deliberately keeps off the wire (leaking).
 */
export function catalogRendering(entries: string[]): CatalogRendering {
	const hasCustom = entries.includes(CUSTOM_MODEL_LITERAL);
	return {
		catalog: entries.filter((entry) => entry !== CUSTOM_MODEL_LITERAL),
		hasCustom,
		customMeaning: hasCustom ? CUSTOM_MODEL_MEANING : undefined,
	};
}

/** R25 — the absent-`transferSet` root is a COMMITMENT, and that is a RULE, not a gap. */
export const TRANSFER_SET_ROOT_COMMITMENT =
	"checkable against disclosed data, not recomputable from the receipt alone";

export const TRANSFER_SET_ROOT_RECOMPUTABLE =
	"the recomputable digest of the pair list below — recomputed offline by verification step 8.";

export interface TransferSetRendering {
	root: string;
	/** Present iff `transferCount <= 32` (§2's presence rule). */
	pairs?: Projection["transferSet"];
	/** Whether the list is absent BECAUSE it exceeds the 32-pair ceiling. */
	rootIsCommitment: boolean;
	rootMeaning: string;
}

/**
 * R25 — the two cases render DIFFERENTLY. The pair list present makes the root
 * a recomputable digest; the pair list absent (> 32 pairs) makes the same field
 * a commitment, and the reader has to be told which one they are looking at.
 */
export function transferSetRendering(projection: Projection): TransferSetRendering {
	const pairs = projection.transferSet;
	const rootIsCommitment = pairs === undefined;
	return {
		root: projection.transferSetRoot,
		pairs,
		rootIsCommitment,
		rootMeaning: rootIsCommitment ? TRANSFER_SET_ROOT_COMMITMENT : TRANSFER_SET_ROOT_RECOMPUTABLE,
	};
}

/**
 * R26, VERBATIM IN FORCE (resolver round-32) — the honest epistemic scope of
 * `repositoryMembership`. The chain commits the MINTER'S CLAIM to have observed
 * membership; it does not embed the provider's proof.
 */
export const MEMBERSHIP_EPISTEMIC_SCOPE =
	"an offline verifier proves the minter committed to having observed membership, not the observation itself.";

/** R26 — `proofId` is a LOOKUP HANDLE for the operator, not a description. */
export const PROOF_ID_IS_A_HANDLE =
	"proofId is an opaque lookup handle for the operator, not a description — it embeds no user data by construction (§2).";

/** R27, VERBATIM (receipt-spec §6a) — the header's attested-vs-asserted split. */
export const MINTED_AT_LABEL = "MINTER-ASSERTED";

export const MINTED_AT_NOTE = "the only minter-asserted clock claim.";

/** R27 — what `startedAt`/`endedAt` are instead (receipt-spec §2/§8). */
export const CHAIN_CLOCK_CLAIM_LABEL = "CHAIN-COMMITTED";

export const CHAIN_CLOCK_CLAIM_NOTE =
	"chain timestamps of the first and last constituent event — clock CLAIMS committed to the chain, not minter assertions.";

// ===========================================================================
// R28-R31 — the unsigned `display` annex
// ===========================================================================

/** R28 — the explicit label §10.1 requires, in the voice reserved for unsigned material. */
export const DISPLAY_ANNEX_LABEL = "DISPLAY DATA — NOT CHAIN-COMMITTED";

/** R28, VERBATIM (§10.1) — the rule the label discharges. */
export const DISPLAY_NOT_ATTESTED =
	"consumers MUST NOT treat display content as attested. Nothing in this section shares the chain-committed fields' treatment.";

/**
 * R29 — the breakdown rows and the resolver's `A + roundingAdjustment`
 * recompute. Display-grade, and "presented as the resolver's ONLINE CHECK —
 * never as a verifier verdict".
 */
export const BREAKDOWN_ROWS_NOTE =
	"per provider/model/tier spend rows live in the unsigned envelope — display-grade, not chain-committed.";

export const RECOMPUTE_IS_RESOLVER_ONLINE_CHECK =
	"the A + roundingAdjustment recomputation is the RESOLVER'S display-grade online check over these unsigned rows — never a verifier verdict. A packages/verify run neither has the rows nor needs them.";

/** R29 — and what IS chain-committed, so the split is visible rather than implied. */
export const CHAIN_COMMITTED_SPEND_FIELDS =
	"the totals, roundingAdjustment and pricing.tableVersions ARE chain-committed — they are rendered on the receipt above, not here.";

/** R30 — `pricingTables` hashes / `pricingDeployment` are `display` data in ut1 (§10.5b). */
export const PRICING_TABLES_NOTE =
	"pricing-table content hashes and the pricingDeployment reference are display data in ut1 — never rendered as if the chain vouched for them.";

/** R31 — `execution.agent` / `interactive` are `display` data (§10.6). */
export const EXECUTION_METADATA_NOTE =
	"execution.agent / execution.interactive are display data — never a work-class claim.";

// ===========================================================================
// R9-R12 / §6.3 — the check ledger and its EPISTEMIC meanings
// ===========================================================================

/** §7's four-valued result, rendered by NAME — never a boolean, never a tick alone. */
export const RESULT_LABEL: Record<StepResult, string> = {
	passed: "PASSED",
	failed: "FAILED",
	notApplicable: "N/A",
	unavailable: "UNAVAILABLE",
};

/**
 * The glyph beside the label. `notApplicable` is deliberately NOT a tick (R12:
 * "n/a is never drawn as a green tick") and the glyph never carries the result
 * alone — the four-valued word does.
 */
export const RESULT_GLYPH: Record<StepResult, string> = {
	passed: "✓",
	failed: "✕",
	notApplicable: "—",
	unavailable: "?",
};

/** R12, VERBATIM IN FORCE (receipt-spec §7). */
export const NOT_APPLICABLE_MEANING =
	"neither a pass nor a failure; it NARROWS the verdict and MUST be reported.";

/** R11 — `unavailable` NEVER degrades. Not an error page, not a paler green. */
export const UNAVAILABLE_MEANING =
	"the input exists but could not be obtained right now. The verdict is the OFFLINE verdict, with this check's status reported beside it — unreachability never degrades a receipt that verifies offline.";

/** R10 — an EXTENSION failure preserves the base verdict and is named, never hidden. */
export const EXTENSION_FAILURE_MEANING =
	"an extension check failed. The base verdict is PRESERVED and the status is capped below this rung — unsigned material is exactly what an attacker can substitute, so it must not demote a sound receipt.";

/** One row of the §6.3 ledger. */
export interface LedgerRow {
	name: StepName | CheckName;
	/** The 12px mono uppercase label of the TerminalFrame label voice (§6.3). */
	label: string;
	/** The one-line MEANING — the column that carries the epistemic labels. */
	meaning: string;
	/** `steps` are the nine §7 base/extension steps; `checks` the four named online ones. */
	group: "steps" | "checks";
}

/**
 * The nine §7 base/extension steps. The MEANINGS are what make this a ledger
 * rather than a status list: `semantics` says posture validity is enum-checking
 * and not confirmation (the P2-7 obligation), `derivations` says which single
 * derivation is recomputed and that `amountUsd` is not it, and `registry` says
 * which HALF of step 3 it is.
 */
export const STEP_ROWS: readonly LedgerRow[] = [
	{
		name: "schema",
		label: "SCHEMA",
		group: "steps",
		meaning: "strict schema + canonicalization validation of the signed receipt bytes.",
	},
	{
		name: "event",
		label: "EVENT",
		group: "steps",
		meaning: "the mint event's hash recomputes, and §4's nine equalities hold.",
	},
	{
		name: "registry",
		label: "REGISTRY (LOCATOR)",
		group: "steps",
		meaning:
			"step 3(a): the signed document's receiptId equals the ID it ARRIVED under — this URL. There is no recomputation; the ID is random, issued at reservation.",
	},
	{
		name: "signature",
		label: "SIGNATURE",
		group: "steps",
		meaning:
			"the mint signature verifies under a key with role mint, in a permitting state, bound to this minter kind.",
	},
	{
		name: "inclusion",
		label: "INCLUSION",
		group: "steps",
		meaning: "the Merkle inclusion path reconstructs the checkpoint's signed root.",
	},
	{
		name: "checkpoint",
		label: "CHECKPOINT",
		group: "steps",
		meaning:
			"the checkpoint is v2 and its signature verifies under a checkpoint-role key inside this chain's pinned rotation lineage.",
	},
	{
		name: "semantics",
		label: "SEMANTICS",
		group: "steps",
		meaning: `§2's presence/exclusion rules, the spend bounds, and POSTURE ENUM VALIDITY — ${POSTURES_ARE_ATTESTED_ENUMS}`,
	},
	{
		name: "derivations",
		label: "DERIVATIONS",
		group: "steps",
		meaning:
			"the ONE derivation a receipt can carry: transferSetRoot recomputed over the ≤ 32-pair transferSet. Absent list → notApplicable, and the root stays a commitment. amountUsd is never stored and never compared.",
	},
	{
		name: "extensions",
		label: "EXTENSIONS",
		group: "steps",
		meaning:
			"the step-9 summary. UPGRADE-ONLY: it can raise the rung and can never demote the base verdict.",
	},
];

/**
 * The four named online checks. `registryBinding` and `predecessorLinkage` bind
 * IDENTITY and LINEAGE and fail only on a positive contradiction;
 * `repositoryMembership`'s epistemic scope (R26) rides on the row that reports
 * the artifact's membership claim — see {@link membershipLedgerNote}.
 */
export const CHECK_ROWS: readonly LedgerRow[] = [
	{
		name: "registryBinding",
		label: "REGISTRY BINDING",
		group: "checks",
		meaning:
			"step 3(b), ONLINE: the registry's binding for this receiptId resolves to THIS receipt's event.hash. Failed only on a positive contradiction — a binding to a different event.",
	},
	{
		name: "predecessorLinkage",
		label: "PREDECESSOR LINKAGE",
		group: "checks",
		meaning:
			"addenda only: prevGenerationEventHash equals the registry's event.hash for the previous generation. notApplicable at generation 1 — there is no predecessor to check.",
	},
	{
		name: "checkpointHistory",
		label: "CHECKPOINT HISTORY",
		group: "checks",
		meaning:
			"extension: the served segment-checkpoint history walks clean and contains this receipt's checkpoint. Earns the history rung; can never demote the base verdict.",
	},
	{
		name: "anchorEvidence",
		label: "ANCHOR EVIDENCE",
		group: "checks",
		meaning:
			"extension: Rekor evidence validates against the AUDITOR'S pinned log key. Earns the anchored rung; can never demote the base verdict. S3 Object Lock probes are not this check's input.",
	},
];

export const LEDGER_ROWS: readonly LedgerRow[] = [...STEP_ROWS, ...CHECK_ROWS];

/**
 * R26's epistemic note, rendered in the ledger beside the membership claim it
 * qualifies (§6.3: "`repositoryMembership` reads as the minter's committed
 * observation"). It is not a step result — no step verifies the observation —
 * which is exactly why it needs a line of its own rather than a glyph.
 */
export function membershipLedgerNote(status: string, proofId: string): string {
	return `repositoryMembership: ${status}, proofId ${proofId} — the chain commits the MINTER'S CLAIM to have observed membership; ${MEMBERSHIP_EPISTEMIC_SCOPE}`;
}

/**
 * R9 / §6.3 — the ledger's footer line. Verdicts are relative to a pinned
 * snapshot "and the verifier says which one" (receipt-spec §8), so the page
 * names the snapshot it rendered under.
 */
export function trustSnapshotLine(trustSnapshotId: string): string {
	return `verified under trust snapshot ${trustSnapshotId}`;
}

/** R9 — why the ledger exists at all: the page shows the function's INPUTS. */
export const LEDGER_SHOWS_THE_INPUTS =
	"the verdict is a function of these results, and this page shows the function's inputs — not just its output.";

// ===========================================================================
// R16 / R33 / R34 — advisories (amber, never red, never green)
// ===========================================================================

/** R33/R34 — advisories never touch the verdict. Rendered above it, in amber. */
export const ADVISORY_NEVER_ALTERS_VERDICT =
	"advisory only — it never alters this receipt's cryptographic verdict.";

/** One rendered advisory band. */
export interface AdvisoryBand {
	kind: string;
	title: string;
	body: string;
	/** A receipt this band points at, when the advisory names one. */
	linkedReceiptId?: string;
}

/**
 * What an advisory member reads as when the resolver did not serve it in a
 * readable shape. Advisories are UNSIGNED (§4.1) and `wire.ts` validates only
 * the `kind` discriminator, so every other member is read defensively — R10's
 * rule: unsigned material must not demote a sound receipt, and it must not
 * throw the render either (see `lib/unsigned-reads.ts`).
 */
export const ADVISORY_FIELD_NOT_SERVED = "(not served)";

function advisoryText(advisory: Advisory, key: string): string {
	return str(advisory as Bag, key) ?? ADVISORY_FIELD_NOT_SERVED;
}

/** A member the band LINKS to: a link is a claim, so an unreadable one is no link. */
function advisoryLink(advisory: Advisory, key: string): string | undefined {
	return str(advisory as Bag, key);
}

/**
 * R16/R33/R34 — every advisory kind, plus the generic fallback §4.1 requires:
 * an unknown kind "renders as a generic advisory notice naming the kind (never
 * silently dropped, never verdict-affecting)".
 */
export function advisoryBand(advisory: Advisory): AdvisoryBand {
	switch (advisory.kind) {
		case "revisionSuperseded":
			return {
				kind: advisory.kind,
				title: "REVISION SUPERSEDED",
				body: `${revisionSupersededLine(advisoryText(advisory, "observedRevision"))} (current revision ${advisoryText(advisory, "currentRevision")}). A display state, never a status: not a failure, not a downgrade, and never silently a plain green check.`,
			};
		case "receiptSuperseded":
			return {
				kind: advisory.kind,
				title: "RECEIPT SUPERSEDED",
				body: `a later receipt_superseded chain event names ${advisoryText(advisory, "supersededByReceiptId")} (event hash ${advisoryText(advisory, "eventHash")}). ${ADVISORY_NEVER_ALTERS_VERDICT}`,
				linkedReceiptId: advisoryLink(advisory, "supersededByReceiptId"),
			};
		case "generationAddendum": {
			const generation = num(advisory as Bag, "generation");
			return {
				kind: advisory.kind,
				title: "GENERATION ADDENDUM",
				body: `generation ${generation ?? ADVISORY_FIELD_NOT_SERVED} was minted as ${advisoryText(advisory, "receiptId")}. The commit's trailer cites generation 1 forever — a later generation is advisory-surfaced, never a trailer rewrite. ${ADVISORY_NEVER_ALTERS_VERDICT}`,
				linkedReceiptId: advisoryLink(advisory, "receiptId"),
			};
		}
		default:
			return {
				kind: advisory.kind,
				title: "ADVISORY",
				body: `this resolver reported an advisory of kind "${advisory.kind}", which this page does not know how to expand. ${ADVISORY_NEVER_ALTERS_VERDICT}`,
			};
	}
}

/**
 * R34 — an ADDENDUM receipt (generation > 1) renders its predecessor linkage
 * and states that the trailer's citation never moves.
 */
export const TRAILER_CITES_GENERATION_ONE =
	"the commit's trailer cites generation 1 forever; later generations are advisory-surfaced, never a trailer rewrite.";

export function predecessorLinkageLine(
	generation: number,
	prevGenerationEventHash: string,
): string {
	return `generation ${generation}; prevGenerationEventHash ${prevGenerationEventHash}`;
}

// ===========================================================================
// Derived view model — one pass over a verified receipt
// ===========================================================================

/**
 * Everything the §6 components need, derived once. Assembling it here rather
 * than in the components keeps every derivation (and every numeric literal that
 * drives rendering) in a lib module, per §6's closing rule and the check-facts
 * precedent.
 */
export interface ReceiptClaims {
	projection: Projection;
	work: Work;
	amountUsd: string;
	headline: string;
	repo: RepoScope;
	comparison: ComparisonStep[];
	association: ReturnType<typeof sessionAssociationPosture>;
	usage: PostureClaim;
	pricing: PostureClaim;
	/** R38/R39 — what the amount COVERS, rendered beside the amount it scopes. */
	delegation: PostureClaim;
	/** R40 — the floor claim, present only where the posture earns one. */
	amountFloor?: string;
	models: CatalogRendering;
	providers: CatalogRendering;
	transfers: TransferSetRendering;
	/**
	 * Present on every artifact variant; `session` has no artifact to observe.
	 * The FIELD renders on the paper (it is chain-committed); the epistemic
	 * scope renders once, in the check ledger, per §6.3 — the same sentence in
	 * both places reads as two claims rather than one.
	 */
	membership?: { status: string; proofId: string };
	/** R26 / §6.3 — the ledger line for {@link membership}. */
	membershipNote?: string;
	/** Present iff `generation > 1` (§2's presence rule). */
	predecessor?: string;
	/** Present iff the fallback session variant. */
	fallbackOrigin?: { sourceReservationReceiptId: string; note: string };
}

export function receiptClaims(receipt: ReceiptDocument): ReceiptClaims {
	const projection = receipt.event.data;
	const work = projection.work;
	const amountUsd = amountUsdFromUsertokens(projection.spend.assessedUsertokens);
	const membership = work.kind === "session" ? undefined : work.repositoryMembership;
	const origin = work.kind === "session" ? work.origin : undefined;
	return {
		projection,
		work,
		amountUsd,
		headline: headlineClaim(work, amountUsd),
		repo: repoScope(work),
		comparison: artifactComparison(work),
		association: sessionAssociationPosture(projection),
		usage: usagePostureClaim(projection.spend.usagePosture),
		pricing: pricingPostureClaim(projection.spend.pricingPosture),
		delegation: delegationScopeClaim(projection.delegationPosture),
		amountFloor: amountFloorClaim(projection.delegationPosture, amountUsd),
		models: catalogRendering(projection.models),
		providers: catalogRendering(projection.providers),
		transfers: transferSetRendering(projection),
		membership,
		membershipNote:
			membership === undefined
				? undefined
				: membershipLedgerNote(membership.status, membership.proofId),
		predecessor:
			projection.prevGenerationEventHash === undefined
				? undefined
				: predecessorLinkageLine(projection.generation, projection.prevGenerationEventHash),
		fallbackOrigin:
			origin === undefined
				? undefined
				: {
						sourceReservationReceiptId: origin.sourceReservationReceiptId,
						note: FALLBACK_SESSION_ORIGIN,
					},
	};
}
