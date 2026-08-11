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
	| "C27";

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
];

export type RejectionVectorId = "X1" | "X2" | "X3" | "X4" | "X5" | "X6" | "X7";

export interface RejectionVectorEntry {
	id: RejectionVectorId;
	kind: "json" | "ts-module";
	/** Relative to this directory. */
	files: string[];
	mustFailInto: string;
	exercises: string;
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
		files: ["id-mismatch.json"],
		mustFailInto: "integrity failure",
		exercises: "otherwise-valid 200 whose `receipt.receiptId` != requested route (R1)",
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
];
