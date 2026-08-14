/**
 * The fixture manifest (verify-page spec §8) — every checked-in artifact
 * under this directory, mapped to the obligation row it exercises. The
 * `exercises` field transcribes §8.1/§8.2's own table text, so a reviewer
 * checking this file against the spec is comparing prose to prose, not
 * prose to inference.
 *
 * `conformance.test.ts` iterates these arrays rather than re-listing file
 * names, so this manifest is the single place a new fixture gets wired in.
 */

export type ConformingFixtureId =
	| "C1"
	| "C2"
	| "C3"
	| "C4"
	| "C5"
	| "C6"
	| "C7"
	| "C8"
	| "C9"
	| "C10"
	| "C11"
	| "C12"
	| "C13"
	| "C14"
	| "C15"
	| "C16"
	| "C17"
	| "C18"
	| "C19"
	| "C20"
	| "C21"
	| "C22"
	| "C23"
	| "C24"
	| "C25"
	| "C26"
	| "C27"
	| "C28"
	| "C29";

export interface ConformingFixtureEntry {
	id: ConformingFixtureId;
	/** Relative to this directory. */
	files: string[];
	exercises: string;
}

export const conformingFixtures: ConformingFixtureEntry[] = [
	{
		id: "C1",
		files: ["commit-checkpoint.json"],
		exercises:
			"commit kind, floor rung + R6 disclaimer; `provider` posture; `workflowAttested` + `workloadId`; " +
			"public repo; `transferSet` present; full `verification` member with `trustSnapshotId` rendered (R9); " +
			"`predecessorLinkage: notApplicable` rendered as n/a, not a tick (R12); `display` annex with breakdown " +
			"rows + `pricingTables`/`pricingDeployment` + `execution` metadata, all labeled (R29-R31)",
	},
	{
		id: "C2",
		files: ["commit-history.json"],
		exercises: "history rung + `checkpointHistory` member + R7 caveat",
	},
	{
		id: "C3",
		files: ["commit-anchored.json"],
		exercises:
			"anchored rung — complete verified history PLUS Rekor evidence (cumulative ladder, §4.1 cap rule) + " +
			"R8's equivocation caveat; S3 probe present as context only",
	},
	{
		id: "C4",
		files: ["commit-s3-only.json"],
		exercises:
			"S3 evidence ONLY -> status stays `verified_checkpoint`, no anchor claim rendered (R8)",
	},
	{
		id: "C5",
		files: ["commit-anchor-failed.json"],
		exercises:
			"green base + `anchorEvidence: failed` / `ANCHOR_INVALID` — base verdict preserved, status capped " +
			"below anchored (R10, §4.1)",
	},
	{
		id: "C6",
		files: ["commit-history-failed.json"],
		exercises:
			"green base + `checkpointHistory: failed` / `HISTORY_INVALID` — base verdict preserved, status " +
			"capped at `verified_checkpoint` (R10, §4.1)",
	},
	{
		id: "C7",
		files: ["commit-checks-unavailable.json"],
		exercises:
			"`checkpointHistory: unavailable` with `registryBinding: passed` — extension unavailability " +
			"never degrades, status within cap (R11, §4.1); NOTE v0.4: `registryBinding: unavailable` on a " +
			"200 moved to the X6 rejection vectors (actor-conflation correction)",
	},
	{
		id: "C8",
		files: ["commit-large-mixed.json"],
		exercises:
			"`transferCount` > 32 -> `transferSet` ABSENT, root-as-commitment (R25), `derivations: notApplicable` " +
			"(R12); `mixed` usagePosture caveat; `conservative` pricingPosture (R21/R22)",
	},
	{
		id: "C9",
		files: ["commit-owner-asserted.json"],
		exercises:
			"commit kind x `ownerAsserted` (no `workloadId`) — the posture x kind pairing most likely to " +
			"overstate provenance on an artifact receipt (R20)",
	},
	{
		id: "C10",
		files: ["commit-gen1-addenda-advisory.json"],
		exercises: "generation 1 + `generationAddendum` advisory band (R34)",
	},
	{
		id: "C11",
		files: ["commit-gen2-addendum.json"],
		exercises:
			"generation 2, `prevGenerationEventHash`, `predecessorLinkage` result rendered (R34/R9)",
	},
	{
		id: "C12",
		files: ["commit-superseded-advisory.json"],
		exercises: "green + `receiptSuperseded` advisory (R33)",
	},
	{
		id: "C13",
		files: ["pr-private.json"],
		exercises:
			"pr kind, keyed `r1_` repoId (no `repo`), `privateHmacSha256V1` binding — R15's SERVER-ASSISTED " +
			"confirmation teaching; R13 pr headline",
	},
	{
		id: "C14",
		files: ["pr-revision-superseded.json"],
		exercises: "R16 display state via the `revisionSuperseded` advisory, verdict untouched",
	},
	{
		id: "C15",
		files: ["issue-public.json"],
		exercises:
			"issue kind, public repo, `publicSha256` contentBinding — R15's DIRECT-recomputation teaching",
	},
	{
		id: "C16",
		files: ["session-owner-estimated.json"],
		exercises:
			'session kind (NON-artifact, R14) x `ownerAsserted`; `estimated` posture caveat (R21); `"custom"` ' +
			"in models (R24)",
	},
	{
		id: "C17",
		files: ["session-workflow-attested.json"],
		exercises:
			"session kind x `workflowAttested` + `workloadId` — attested posture must NOT read as artifact " +
			"attestation; R14's copy unchanged (R20/R14)",
	},
	{
		id: "C18",
		files: ["session-fallback.json"],
		exercises: "fallback variant with `origin.billedUnfinalized` (R19) — the linked side of C21",
	},
	{ id: "C19", files: ["reserved.json"], exercises: "202 reserved" },
	{ id: "C20", files: ["reconciling.json"], exercises: "202 reconciling" },
	{
		id: "C21",
		files: ["billed-unfinalized.json"],
		exercises:
			"410 bundle: §4.2's amended shape (proxy envelope + `SegmentCheckpoint` v2 + chain/profile), links " +
			"to C18; R3 cross-checks pass",
	},
	{
		id: "C22",
		files: ["cancelled.json", "expired.json"],
		exercises: "410 empty-reservation terminals",
	},
	{ id: "C23", files: ["not-minted.json"], exercises: "410 notMinted" },
	{ id: "C24", files: ["unknown.json"], exercises: "404" },
	{
		id: "C25",
		files: ["unverifiable.json"],
		exercises:
			"409 — `verification` member names the failed step + its §4.1 closed-union failure code",
	},
	{
		id: "C26",
		files: ["verification-unavailable.json"],
		exercises: "503 + Retry-After",
	},
	{
		id: "C27",
		files: ["rate-limited.json"],
		exercises:
			"429 — body ABSENT and never parsed; state derives from the HTTP code + Retry-After alone (§4.2's " +
			"exemption). Exactly ONE prescribed outcome: the rate-limited state — never the protocol-error shell",
	},
	{
		id: "C28",
		files: ["posture-includes-some-delegated.json"],
		exercises:
			"`delegationPosture: includesSomeDelegated` on an otherwise-conformant 200 — a CONFORMING fixture, not a " +
			"rejection vector: the value is legal verifier vocabulary, `steps.semantics` may honestly be `passed`, " +
			"and the consumer's obligation is to RENDER it (recognizing is not permitting — the minting rule binds " +
			"the minter, R39 binds the page). Exercises R39's incomplete-attributed-subtotal framing AND R40's " +
			"soundness precondition FAILING: coverage is not established, so no floor claim may be inherited",
	},
	{
		id: "C29",
		files: ["posture-indeterminate.json"],
		exercises:
			"`delegationPosture: indeterminate` on an otherwise-conformant 200 — R39's end-to-end-coverage-cannot-be-" +
			"verified framing, and the NEGATIVE guard on the whole R40 amendment: unknown coverage supports no bound " +
			"in either direction, because the total may include cost the subject did not cause, so 'at least $X was " +
			"caused' can be flatly false. This row is the fixture that fails if the floor claim is ever applied " +
			"globally instead of per posture",
	},
];

export type RejectionVectorId =
	| "X1"
	| "X2"
	| "X3"
	| "X4"
	| "X5"
	| "X6"
	| "X7"
	| "X8"
	| "X9"
	| "X10"
	| "X11";

export interface RejectionVectorEntry {
	id: RejectionVectorId;
	kind: "json" | "ts-module";
	/** Relative to this directory. */
	files: string[];
	mustFailInto: string;
	exercises: string;
	/**
	 * WHICH CONSUMER this vector is aimed at. Defaults to `"page"`: the vector
	 * must drive the verify page into a non-green state, and `wire.test.ts`
	 * asserts exactly that over every `page` vector.
	 *
	 * `"historyWalk"` marks a vector the PAGE CANNOT AND MUST NOT CATCH. The
	 * page renders the resolver's verdict and never recomputes one (design D2),
	 * so a vector whose only defect is inside a served `checkpointHistory`
	 * reaches a green page state CORRECTLY — the consumers that must reject it
	 * are `usertrust-verify` and the resolver, which walk the history.
	 *
	 * This field exists so that exemption is STRUCTURAL and asserted rather
	 * than a quiet special case inside a coverage test: a vector that cannot go
	 * red at the page has to say so here and carry its own dedicated test, and
	 * `wire.test.ts` asserts that too.
	 */
	consumer?: "page" | "historyWalk";
}

export const rejectionVectors: RejectionVectorEntry[] = [
	{
		id: "X1",
		kind: "json",
		files: [
			"billed-unfinalized-mutants/route-body-id-mismatch.json",
			"billed-unfinalized-mutants/linked-receipt-id-mismatch.json",
			"billed-unfinalized-mutants/source-reservation-id-mismatch.json",
			"billed-unfinalized-mutants/transfer-set-root-mismatch.json",
		],
		mustFailInto: "integrity failure, no link rendered",
		exercises:
			"one file per broken equality: route/body-ID mismatch (`body.receiptId` != requested route — R1's " +
			"410-side application, §10.15), `linkedReceiptId` mismatch, `origin.sourceReservationReceiptId` " +
			"mismatch, `transferSetRoot` mismatch (R3)",
	},
	{
		id: "X2",
		kind: "json",
		files: ["unsupported-apiversion.json"],
		mustFailInto: "protocol-error shell",
		exercises: '`apiVersion: "2"`, never green v1 treatment (R37)',
	},
	{
		id: "X3",
		kind: "json",
		files: ["unknown-status.json"],
		mustFailInto: "protocol-error shell",
		exercises: '`apiVersion: "1"`, unrecognized `status` (R37)',
	},
	{
		id: "X4",
		kind: "json",
		files: ["id-mismatch.json", "id-mismatch-receipt-document.json"],
		mustFailInto: "integrity failure",
		exercises:
			"otherwise-valid 200 whose `receipt.receiptId` != requested route (R1) — one file per HALF of R1's " +
			"identity chain: `id-mismatch.json` breaks the ENVELOPE half (`body.receiptId` != route, and the " +
			"receipt/bytes agree with it), `id-mismatch-receipt-document.json` breaks the RECEIPT-DOCUMENT half " +
			"alone (`body.receiptId` == route, so only the SIGNED receipt names another ID — the §10.15 " +
			"answer-B-under-receipt-A case R1 exists to close, and the one the envelope check cannot see)",
	},
	{
		id: "X5",
		kind: "json",
		files: [
			"receipt-bytes-mutants/value-mismatch.json",
			"receipt-bytes-mutants/non-canonical-base64.json",
			"receipt-bytes-mutants/duplicate-key.json",
			"receipt-bytes-mutants/unsafe-integer.json",
		],
		mustFailInto: "integrity failure via R4's STRICT pipeline",
		exercises:
			"value mismatch vs `receipt`; non-canonical base64; duplicate key inside the `receiptBytes` JSON " +
			"(pre-parse rejection); unsafe integer. Each must fail even where a lenient `JSON.parse` would accept",
	},
	{
		id: "X6",
		kind: "ts-module",
		files: ["protocol-vectors.ts"],
		mustFailInto: "protocol-error shell",
		exercises:
			"malformed-body vector, HTTP-code/body-`status` mismatches (200+`unverifiable`, 410+ladder status), " +
			"§4.1 verdict-algebra violations (200 with a mandatory step not `passed`; `registryBinding: failed` " +
			"on a 200; status above its extension cap; misplaced failure code), timeout/network simulation " +
			"hooks (R37)",
	},
	{
		id: "X7",
		kind: "ts-module",
		files: ["id-vectors.ts"],
		mustFailInto: "local invalid-ID state",
		exercises:
			"§12 decode vectors — valid 16-byte IDs (incl. leading-`1`s) as the passing controls, 16-22-char " +
			"strings that do NOT decode to 16 bytes, non-canonical encodings (R2)",
	},
	{
		id: "X8",
		kind: "json",
		files: ["posture-missing.json"],
		mustFailInto: "protocol-error shell",
		exercises:
			"`delegationPosture` ABSENT from an otherwise-conformant 200 whose `steps.semantics` still claims " +
			"`passed`. §2 makes the field REQUIRED and §7 makes absence a step-7 SEMANTIC_INVALID, so the resolver " +
			"asserted a step that did not pass; R38 sends missing-or-unrecognized postures to the protocol-error " +
			"shell, because the page must not out-render its own verifier. This is the shape the ENTIRE corpus had " +
			"before v0.9 — 29 receipts, and a green suite",
	},
	{
		id: "X9",
		kind: "json",
		files: ["posture-unrecognized.json"],
		mustFailInto: "protocol-error shell",
		exercises:
			"`delegationPosture` PRESENT but not one of §2a's four values. This is the forward-compatibility " +
			"guarantee made testable: a v1 verifier meeting a value some later spec adds must FAIL CLOSED rather " +
			"than render a total whose coverage it cannot interpret (§7, R38). Untested, that guarantee is a comment",
	},
	{
		id: "X10",
		kind: "json",
		files: ["history-noncontiguous.json"],
		consumer: "historyWalk",
		mustFailInto:
			"HISTORY_INVALID from any consumer that WALKS the served history — NOT a page state. " +
			"The page renders the resolver's verdict and does not walk (D2), so this vector is aimed at " +
			"`usertrust-verify` and the resolver, and its envelope is deliberately §4-conformant",
		exercises:
			"§7's contiguity clause in ISOLATION: `next.segmentFirstSequence === prev.segmentFirstSequence + " +
			"prev.treeSize`. The history seats seg-0002 at 500 where 1 + 400 = 401, while `previousSegmentId` and " +
			"`previousSegmentRoot` stay correct and the receipt's embedded checkpoint still appears EXACTLY in the " +
			"history. C6 breaks the ID chain AND the arithmetic at once (seg-9999 with prev=seg-9998), so an " +
			"implementation that never wrote the contiguity comparison passes C6 for the wrong reason; only this " +
			"vector catches it",
	},
	{
		id: "X11",
		kind: "json",
		files: ["posture-all-delegated.json"],
		mustFailInto: "integrity failure — recognized, but never green",
		exercises:
			"`delegationPosture: includesAllDelegated`, the STRONGEST claim in §2a's vocabulary (every causally " +
			"attributable delegated debit, transitive descendants included, exactly once). §7 pins what backing it " +
			"requires: only that value may be presented as the total cost of work caused by the subject, and only " +
			"when its §2a signed evidence validates — a verifier given it WITHOUT validating evidence 'reports a " +
			"failure, not a total'. No evidence format exists in v1 (§2a: unreachable until one is), so every " +
			"instance fails by CONSTRUCTION rather than by policy. Accepting the value at the validation gate is " +
			"correct (recognizing is not permitting, §2a vs §7) — but the gate is not the verdict, and this vector " +
			"is what proves the difference. Integrity failure, not the protocol-error shell: the shell is for " +
			"material the page cannot interpret, and this value is interpreted exactly",
	},
];
