/**
 * Types for the verify-page fixture matrix (spec §8) — transcribed from the
 * frozen shapes in receipt-spec.md §2 (projection), §4/§4a (mint event,
 * proof, checkpoint), §5 (receipt wire document) and the verify-page design
 * spec §4 (the concrete `apiVersion: "1"` response schema union).
 *
 * These are FIXTURE types: they exist to give the checked-in JSON under
 * `app/r/fixtures/*.json` a compile-time shape and to let
 * `conformance.test.ts` assert presence/exclusion rules structurally. They
 * are not the page's runtime parser (that is Task 2's `app/r/lib/wire.ts`,
 * which owns `parseResolverResponse` and may import these or define its own
 * — the two are drafted to agree; a discovered disagreement is a Task 2
 * problem, per the same headline rule receipt-spec.md uses for itself).
 *
 * Strict schema is REAL here in the TypeScript sense (discriminated unions,
 * presence-by-variant) everywhere TypeScript can carry it; hex/signature
 * VALUES are synthetic (§8: "hex/signature values synthetic") — this file
 * does not encode length/alphabet constraints TypeScript cannot express,
 * those are asserted at runtime in conformance.test.ts instead.
 */

// ---------------------------------------------------------------------------
// Shared scalars
// ---------------------------------------------------------------------------

/** `"ut1_" + base58btc(16 raw bytes)` — receipt-spec §3/§12. */
export type Ut1ReceiptId = string;

/** Lowercase hex, length varies by field (asserted at runtime, not here). */
export type HexString = string;

/** Standard (non-URL-safe) base64, canonical padding. */
export type Base64String = string;

/** RFC 3339 UTC, millisecond precision, `Z` suffix — receipt-spec §2. */
export type Iso8601Utc = string;

// ---------------------------------------------------------------------------
// The `work` union (receipt-spec §2, §6a; mirrored in §5's receipt body)
// ---------------------------------------------------------------------------

export interface RepositoryMembership {
	status: "providerVerified";
	proofId: string;
}

export interface CommitWork {
	kind: "commit";
	repoId: string;
	/** ABSENT unless disclosure is authorized (§2's public-safety rule). */
	repo?: string;
	oid: string;
	oidAlg: "sha1" | "sha256";
	objectSha256: string;
	repositoryMembership: RepositoryMembership;
}

/** The resolver's discriminated content-binding union — exactly one variant. */
export type ContentBinding =
	| { kind: "publicSha256"; sha256: string }
	| { kind: "privateHmacSha256V1"; commitment: string };

export interface PrIssueWork {
	kind: "pr" | "issue";
	repoId: string;
	repo?: string;
	number: number;
	providerArtifactId: string;
	observedRevision: string;
	contentBinding: ContentBinding;
	repositoryMembership: RepositoryMembership;
}

/** Ordinary session — `origin` is PROHIBITED (§2); no artifact, no membership. */
export interface SessionWorkOrdinary {
	kind: "session";
	repoId: string;
	repo?: string;
}

/** Fallback session — `origin` REQUIRED (the forced `billedUnfinalized` path). */
export interface SessionWorkFallback {
	kind: "session";
	repoId: string;
	repo?: string;
	origin: {
		kind: "billedUnfinalized";
		sourceReservationReceiptId: Ut1ReceiptId;
	};
}

export type SessionWork = SessionWorkOrdinary | SessionWorkFallback;

export type Work = CommitWork | PrIssueWork | SessionWork;

// ---------------------------------------------------------------------------
// Spend / the §2 projection
// ---------------------------------------------------------------------------

export interface Spend {
	/** integer, 0 < n <= 2^53-1 */
	assessedUsertokens: number;
	/** MUST equal assessedUsertokens in ut1 (P1-4) */
	postedUsertokens: number;
	/** integer, 0 <= n <= transferCount */
	roundingAdjustment: number;
	/** integer >= 1 */
	transferCount: number;
	usagePosture: "provider" | "mixed" | "estimated";
	pricingPosture: "exact" | "conservative";
}

export interface TransferPair {
	authorizationTransferId: string;
	settlementTransferId: string;
}

/**
 * receipt-spec §2a — WHAT THE AMOUNT COVERS with respect to DELEGATED work.
 *
 * All four values are the VERIFIER's vocabulary. Conformant v1 MINTING emits
 * only `selfDebitsOnly` (§2a's minting rule) — but minting and verifying are
 * different verbs for different actors, so a verifier must RECOGNIZE and
 * RENDER the others per §7/R39. Recognizing is not permitting, and a wire
 * response carrying `includesSomeDelegated` or `indeterminate` is conformant.
 *
 * `includesAllDelegated` is unreachable in v1: §2a requires signed evidence an
 * offline verifier can validate, and no such format is specified yet, so §7's
 * "reports a failure, not a total" applies to every instance of it.
 */
export type DelegationPosture =
	| "selfDebitsOnly"
	| "includesSomeDelegated"
	| "includesAllDelegated"
	| "indeterminate";

/** The mint event's `data` field — receipt-spec §2. */
export interface Projection {
	spec: "ut1";
	scope: "session";
	sessionId: string;
	/** integer >= 1 */
	generation: number;
	/** present iff generation > 1 */
	prevGenerationEventHash?: HexString;
	work: Work;
	sessionAssociation: "workflowAttested" | "ownerAsserted";
	/** present iff sessionAssociation === "workflowAttested" */
	workloadId?: string;
	/** sorted unique, ASCII-lexicographic */
	models: string[];
	/** sorted unique, ASCII-lexicographic */
	providers: string[];
	startedAt: Iso8601Utc;
	endedAt: Iso8601Utc;
	spend: Spend;
	/** REQUIRED (v0.9, §2a). Absence is a step-7 SEMANTIC_INVALID, never a default. */
	delegationPosture: DelegationPosture;
	pricing: { tableVersions: string[] };
	/** present iff transferCount <= 32; ABSENT iff transferCount > 32 */
	transferSet?: TransferPair[];
	transferSetRoot: HexString;
}

// ---------------------------------------------------------------------------
// Chain envelope (receipt-spec §4/§4a)
// ---------------------------------------------------------------------------

export interface MintActor {
	type: "system";
	id: "receipt-minter";
	name: "receipt-minter";
}

/** The proxy audit writer's envelope, field-complete (§4a). */
export interface ChainEnvelope<TKind extends string, TData> {
	id: string;
	timestamp: Iso8601Utc;
	previousHash: HexString;
	kind: TKind;
	actor: MintActor;
	data: TData;
	sequence: number;
	hash: HexString;
}

export type MintEvent = ChainEnvelope<"receipt_settled", Projection>;

export interface MerkleSibling {
	hash: HexString;
	position: "left" | "right";
}

/** `MerkleInclusionProof` verbatim (receipt-spec §4/§4a) — one tree per segment. */
export interface MerkleInclusionProof {
	version: 1;
	leafHash: HexString;
	leafIndex: number;
	treeSize: number;
	root: HexString;
	siblings: MerkleSibling[];
	segmentId: string;
}

/** `SegmentCheckpoint` v2 — the signed statement (receipt-spec §4a). */
export interface SegmentCheckpointV2 {
	v: 2;
	vaultId: string;
	profile: "proxy-v1";
	root: HexString;
	treeSize: number;
	segmentId: string;
	segmentFirstSequence: number;
	/** the fixed string "genesis" for the first segment */
	previousSegmentRoot: HexString | "genesis";
	/** the fixed string "genesis" for the first segment */
	previousSegmentId: string | "genesis";
	keyId: string;
	publishedAt: Iso8601Utc;
	sig: Base64String;
}

export interface Proof {
	profile: "proxy-v1";
	chain: string;
	mintEventHash: HexString;
	inclusion: MerkleInclusionProof;
	checkpoint: SegmentCheckpointV2;
}

export interface Signature {
	alg: "ed25519";
	keyId: string;
	sig: Base64String;
}

export interface Minter {
	kind: "proxy";
	keyId: string;
	trustDomain: string;
}

/** The §5 receipt wire document — the signed artifact. */
export interface ReceiptDocument {
	spec: "ut1";
	receiptId: Ut1ReceiptId;
	scope: "session";
	/** minter-asserted clock claim — the ONLY one (R27) */
	mintedAt: Iso8601Utc;
	minter: Minter;
	/** equality-checked mirror of event.data.work (equality 9) */
	work: Work;
	event: MintEvent;
	proof: Proof;
	signature: Signature;
}

// ---------------------------------------------------------------------------
// The `verification` member (verify-page spec §4.1)
// ---------------------------------------------------------------------------

export type StepResult = "passed" | "failed" | "notApplicable" | "unavailable";

/** The closed failure-code union (verify-page spec §4.1) — no free text. */
export type FailureCode =
	| "SCHEMA_INVALID"
	| "EVENT_MISMATCH"
	| "ID_MISMATCH"
	| "SIG_INVALID"
	| "PROOF_INVALID"
	| "CHECKPOINT_INVALID"
	| "SEMANTIC_INVALID"
	| "DERIVATION_MISMATCH"
	| "HISTORY_INVALID"
	| "ANCHOR_INVALID"
	/**
	 * Added at receipt-spec v0.7 (verify-page spec v0.5): legal ONLY on
	 * `checks.predecessorLinkage`. The union previously assigned no code to
	 * that check, so a generation-predecessor contradiction could not be
	 * reported schema-validly at all.
	 */
	| "PREDECESSOR_MISMATCH";

export interface CheckResult {
	result: StepResult;
	/** present iff result === "failed" */
	failure?: FailureCode;
}

/** The nine §7 base/extension steps, by wire name. */
export interface VerificationSteps {
	schema: CheckResult;
	event: CheckResult;
	registry: CheckResult;
	signature: CheckResult;
	inclusion: CheckResult;
	checkpoint: CheckResult;
	semantics: CheckResult;
	derivations: CheckResult;
	extensions: CheckResult;
}

/** The four named online checks (§7's table). */
export interface VerificationChecks {
	registryBinding: CheckResult;
	predecessorLinkage: CheckResult;
	checkpointHistory: CheckResult;
	anchorEvidence: CheckResult;
}

export interface Verification {
	trustSnapshotId: string;
	steps: VerificationSteps;
	checks: VerificationChecks;
}

// ---------------------------------------------------------------------------
// Advisories (verify-page spec §4.1; receipt-spec §8/§6a)
// ---------------------------------------------------------------------------

export interface RevisionSupersededAdvisory {
	kind: "revisionSuperseded";
	observedRevision: string;
	currentRevision: string;
}

export interface ReceiptSupersededAdvisory {
	kind: "receiptSuperseded";
	supersededByReceiptId: Ut1ReceiptId;
	eventHash: HexString;
}

export interface GenerationAddendumAdvisory {
	kind: "generationAddendum";
	generation: number;
	receiptId: Ut1ReceiptId;
}

/** Unknown kinds render generic, never dropped (verify-page spec §4.1). */
export interface UnknownAdvisory {
	kind: Exclude<string, "revisionSuperseded" | "receiptSuperseded" | "generationAddendum">;
	[key: string]: unknown;
}

export type Advisory =
	| RevisionSupersededAdvisory
	| ReceiptSupersededAdvisory
	| GenerationAddendumAdvisory
	| UnknownAdvisory;

// ---------------------------------------------------------------------------
// Anchor evidence (receipt-spec §5)
// ---------------------------------------------------------------------------

/**
 * The repo's existing `RekorReceipt` shape, transcribed VERBATIM from
 * `packages/core/src/audit/rekor-verify.ts` (receipt-spec §5: "Rekor = the
 * repo's existing `RekorReceipt` shape"). No `format` discriminator exists on
 * the real type — the wrapping `AnchorEvidence` container's `rekor` key IS
 * the discriminator — and no `logKeyId` is carried IN the evidence: the
 * verifying party pins its OWN log key out of band ("a log key the AUDITOR
 * pinned (never one the receipt names)", rekor-verify.ts:18-19); a
 * self-declared key inside the evidence would let attacker-shaped evidence
 * name its own trust anchor.
 */
export interface RekorReceipt {
	v: 1;
	vaultId: string;
	anchorSeq: number;
	/** 64-hex — MUST equal anchorPayloadHash(record). */
	artifactHash: HexString;
	/** base64 of the entry bytes AS STORED BY THE LOG, never a reserialization. */
	entryBody: Base64String;
	log: {
		url: string;
		logIndex: number;
		treeSize: number;
		/** 64-hex root the inclusion path must reconstruct. */
		rootHash: HexString;
		/** 64-hex inclusion path, leaf -> root order. */
		hashes: HexString[];
		/** Signed note (checkpoint) over treeSize + rootHash — one opaque string. */
		checkpoint: string;
		/** Unix SECONDS (not ISO 8601) the log claims it integrated the entry. */
		integratedTime: number;
		/** base64 ECDSA signature; optional — a log without a SET still yields inclusion. */
		signedEntryTimestamp?: Base64String;
		/** 64-hex log identity, part of the SET payload. Required with a SET. */
		logID?: HexString;
	};
}

/** One `anchor doctor` check — `packages/core/src/audit/anchor-doctor.ts`. */
export interface DoctorCheck {
	name: string;
	status: "pass" | "fail" | "info";
	detail: string;
}

/**
 * The anchor-doctor's ACTUAL output shape (receipt-spec §5: "S3 Object Lock
 * = operator-asserted configuration probes (anchor-doctor output)"),
 * transcribed from `packages/core/src/audit/anchor-doctor.ts`'s
 * `DoctorReport` — an append-only-store PERMISSION probe, never a
 * cryptographic claim, which is why it "can NEVER by itself reach
 * `VERIFIED_ANCHORED`" (§8.1 C4).
 */
export interface DoctorReport {
	sink: string;
	checks: DoctorCheck[];
	failed: boolean;
}

/**
 * The `anchorEvidence` member is a CONTAINER, not a single-format union
 * (verify-page spec §4.1: "receipt-spec §5 formats (RekorReceipt; S3 probes
 * as context)") — a receipt may carry Rekor evidence (the only format that
 * can earn `verified_anchored`), S3 Object Lock probes (context only, per
 * R8 they can NEVER by themselves reach that rung), or both (C3: anchored
 * via Rekor, S3 shown alongside as context; C4: S3 only, no anchor claim).
 */
export interface AnchorEvidence {
	rekor?: RekorReceipt;
	s3ObjectLock?: DoctorReport[];
}

// ---------------------------------------------------------------------------
// The unsigned `display` annex (verify-page spec §4.1/§10.1/§10.5/§10.5b/§10.6)
// ---------------------------------------------------------------------------

export interface DisplaySpendRow {
	provider: string;
	model: string;
	tier: "input" | "output" | "cacheRead" | "cacheWrite" | "unknown";
	usertokens: number;
}

export interface DisplayPricingTables {
	hashes: HexString[];
	pricingDeployment?: string;
}

export interface DisplayExecution {
	agent?: boolean;
	interactive?: boolean;
}

export interface Display {
	spendBreakdown?: DisplaySpendRow[];
	/** the resolver's `A + roundingAdjustment` recompute — display-grade, never a verdict */
	recomputedTotal?: { a: number; roundingAdjustment: number; total: number };
	pricingTables?: DisplayPricingTables;
	execution?: DisplayExecution;
}

// ---------------------------------------------------------------------------
// The response envelope union (verify-page spec §4.1/§4.2)
// ---------------------------------------------------------------------------

export type LadderStatus =
	| "verified_checkpoint"
	| "verified_checkpoint_history"
	| "verified_anchored";

/** 200 — all three ladder statuses share this shape. */
export interface SuccessEnvelope {
	apiVersion: "1";
	receiptId: Ut1ReceiptId;
	status: LadderStatus;
	receiptBytes: Base64String;
	receipt: ReceiptDocument;
	verification: Verification;
	advisories: Advisory[];
	anchorEvidence?: AnchorEvidence;
	checkpointHistory?: SegmentCheckpointV2[];
	display?: Display;
}

/** 202 — `reserved` (pre-mint) or `reconciling` (settlement draining). */
export interface PendingEnvelope {
	apiVersion: "1";
	receiptId: Ut1ReceiptId;
	status: "reserved" | "reconciling";
}

/** 410 — a reservation that ended with no billable work settled under it. */
export interface TerminalNoReceiptEnvelope {
	apiVersion: "1";
	receiptId: Ut1ReceiptId;
	status: "cancelled" | "expired" | "notMinted";
}

/**
 * The terminal accounting event proving a `billedUnfinalized` outcome. Not
 * necessarily `kind: "receipt_settled"` (it proves work billed WITHOUT a
 * receipt) — the spec names it "the §4a proxy envelope, field-complete"
 * without fixing its `kind`, so this stays generic over it.
 */
export type TerminalEvent = ChainEnvelope<string, unknown>;

export interface BilledUnfinalizedTerminalProof {
	chain: string;
	profile: "proxy-v1";
	event: TerminalEvent;
	inclusion: MerkleInclusionProof;
	checkpoint: SegmentCheckpointV2;
}

/** 410 `billedUnfinalized` — the §10.15-amended bundle. */
export interface BilledUnfinalizedEnvelope {
	apiVersion: "1";
	status: "billedUnfinalized";
	/** the trailered, unproven ID */
	receiptId: Ut1ReceiptId;
	/** the spend-only session receipt this bundle links to */
	linkedReceiptId: Ut1ReceiptId;
	transferSetRoot: HexString;
	terminalEvent: BilledUnfinalizedTerminalProof;
}

/** 404 — an ID that was never allocated. */
export interface UnknownEnvelope {
	apiVersion: "1";
	receiptId: Ut1ReceiptId;
	status: "unknown";
}

/** 409 — integrity failure; the failed step named via `verification`. */
export interface UnverifiableEnvelope {
	apiVersion: "1";
	receiptId: Ut1ReceiptId;
	status: "unverifiable";
	verification: Verification;
}

/** 503 — operational, not cryptographic. */
export interface ServiceUnavailableEnvelope {
	apiVersion: "1";
	status: "verificationUnavailable";
}

export type ResolverEnvelope =
	| SuccessEnvelope
	| PendingEnvelope
	| TerminalNoReceiptEnvelope
	| BilledUnfinalizedEnvelope
	| UnknownEnvelope
	| UnverifiableEnvelope
	| ServiceUnavailableEnvelope;

// ---------------------------------------------------------------------------
// The wire wrapper — HTTP status/headers alongside the (possibly ABSENT) body
// ---------------------------------------------------------------------------

export interface WireHeaders {
	"cache-control"?: string;
	"retry-after"?: string;
	etag?: string;
}

/**
 * One simulated resolver response: the HTTP status/headers plus the body AS
 * SERVED ON THE WIRE. `body` is `string` for vectors that need to carry
 * bytes a strict JSON parser must reject (duplicate keys, unsafe integers,
 * non-canonical base64 payloads embedded inside otherwise-valid JSON) —
 * conforming fixtures and most rejection vectors carry a structured object
 * instead. `body: null` models HTTP 429's exemption (§4.2): the body is
 * absent/untrusted and MUST NOT be parsed.
 */
export interface WireResponse<TBody = ResolverEnvelope> {
	httpStatus: number;
	headers: WireHeaders;
	body: TBody | string | null;
}

/**
 * One fixture case: the route param the page was asked to resolve, plus the
 * wire response the resolver returned for it. Every conforming/rejection
 * JSON file (except the X6/X7 TS vector modules, which carry many cases
 * each) is one of these.
 */
export interface FixtureCase<TBody = ResolverEnvelope> {
	routeParamId: string;
	wire: WireResponse<TBody>;
}

/**
 * X1 — a `billed-unfinalized-mutants/*.json` case. Self-contained: bundles
 * its OWN copy of "the linked receipt" (rather than reading C18 off disk) so
 * exactly one R3 equality is broken per file while the rest of the scenario
 * stays internally consistent.
 */
export interface BilledUnfinalizedMutantCase {
	routeParamId: string;
	wire: WireResponse<BilledUnfinalizedEnvelope>;
	linkedReceipt: SuccessEnvelope;
	brokenEquality: "routeBodyId" | "linkedReceiptId" | "sourceReservationId" | "transferSetRoot";
}

// ---------------------------------------------------------------------------
// X6/X7 — the TS vector modules (verify-page spec §8.2)
// ---------------------------------------------------------------------------

export type ProtocolVectorKind =
	| "malformedBody"
	| "outOfTableHttpStatus"
	| "httpStatusBodyMismatch"
	| "missingApiVersion"
	| "verdictAlgebraViolation"
	| "transportFailure";

/** One X6 case — every one MUST fail into the protocol-error shell (R37). */
export interface ProtocolVector {
	label: string;
	kind: ProtocolVectorKind;
	reason: string;
	routeParamId?: string;
	/** present for body-based vectors (httpStatusBodyMismatch, verdictAlgebraViolation) */
	wire?: WireResponse<unknown>;
	/** present ONLY for malformedBody vectors — raw bytes that are not valid JSON */
	rawBody?: string;
	/** present ONLY for transportFailure vectors */
	simulate?: "timeout" | "networkFailure";
}

/** One X7 case — §12's ID-decode rule (R2). */
export interface IdVector {
	label: string;
	id: string;
	expected: "valid" | "invalid";
	reason: string;
}
