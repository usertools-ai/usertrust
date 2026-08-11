/**
 * The verify page's wire module — the ONLY place a resolver response becomes
 * something the page may render.
 *
 * Sources, in authority order (verify-page design spec §0's own ordering):
 *   1. `docs/specs/receipt-spec.md` v0.7 — §3/§12 (the ID rule), §7 (the nine
 *      steps, the four named online checks, the closed failure vocabulary),
 *      §2/§5 (the projection and the receipt document).
 *   2. `docs/specs/2026-08-11-verify-page-design.md` v0.5 — §3 (the wire
 *      table), §4.1/§4.2 (the concrete `apiVersion: "1"` union + the verdict
 *      algebra), §5 R1-R4 and R37 (identity, byte authority, fail-closed).
 *
 * Three rules govern everything below.
 *
 * **The page never computes a verdict (D2).** It renders the resolver's
 * `status` and its structured `verification` results. What this module DOES
 * compute is the small set of checks a consumer with no cryptographic
 * machinery can and must perform: the §12 ID decode (R2), the identity chain
 * (R1/R3), the `receiptBytes` <-> `receipt` byte agreement (R4), and the
 * §4.1 verdict ALGEBRA — which is not a verdict but a consistency check on
 * the resolver's own answer ("a resolver that computed these results and
 * still answered 200 must not have").
 *
 * **Fail closed (R37).** Every path that cannot produce a trustworthy answer
 * lands in `protocolError` or `integrityFailure`. There is no path from
 * doubt to green. HTTP 429 is the ONE documented exemption (§4.2): its state
 * derives from the status code and `Retry-After` alone, body unparsed.
 *
 * **`receiptBytes` is byte-authoritative; `receipt` is a convenience copy.**
 * R4's five-stage pipeline is implemented here in full, including a
 * hand-rolled JSON parser: an ordinary `JSON.parse` + deep-equal is
 * explicitly NOT conformant, because a post-parse check cannot see a
 * duplicate key at all and V8 silently rounds an unsafe integer literal.
 */

// ===========================================================================
// §4 — the response schema, as TypeScript
// ===========================================================================

/** `"ut1_" + base58btc(16 raw bytes)` — receipt-spec §3/§12. */
export type Ut1ReceiptId = string;

export type LadderStatus =
	| "verified_checkpoint"
	| "verified_checkpoint_history"
	| "verified_anchored";

export type NonReceiptStatus =
	| "reserved"
	| "reconciling"
	| "cancelled"
	| "expired"
	| "notMinted"
	| "billedUnfinalized"
	| "unknown"
	| "unverifiable"
	| "verificationUnavailable";

export type ResolverStatus = LadderStatus | NonReceiptStatus;

/** §7's four-valued structured result — never a boolean. */
export type StepResult = "passed" | "failed" | "notApplicable" | "unavailable";

/**
 * The closed failure-code union (verify-page §4.1, receipt-spec §7).
 * `PREDECESSOR_MISMATCH` was added at receipt-spec v0.7: the union previously
 * assigned no code to `predecessorLinkage`, so a generation-predecessor
 * contradiction could not be reported schema-validly at all.
 */
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
	| "PREDECESSOR_MISMATCH";

/** One structured result. `failure` is present iff `result === "failed"`. */
export interface CheckEntry {
	result: StepResult;
	failure?: FailureCode;
}

/** The nine §7 base/extension steps, by their §4.1 wire names. */
export type StepName =
	| "schema"
	| "event"
	| "registry"
	| "signature"
	| "inclusion"
	| "checkpoint"
	| "semantics"
	| "derivations"
	| "extensions";

/** The four named online checks (§7's table). */
export type CheckName =
	| "registryBinding"
	| "predecessorLinkage"
	| "checkpointHistory"
	| "anchorEvidence";

export interface Verification {
	/** The §8 trust-document snapshot this verification ran under (R9). */
	trustSnapshotId: string;
	steps: Record<StepName, CheckEntry>;
	checks: Record<CheckName, CheckEntry>;
}

export interface RepositoryMembership {
	status: "providerVerified";
	proofId: string;
}

export interface CommitWork {
	kind: "commit";
	repoId: string;
	repo?: string;
	oid: string;
	oidAlg: "sha1" | "sha256";
	objectSha256: string;
	repositoryMembership: RepositoryMembership;
}

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

export interface SessionWork {
	kind: "session";
	repoId: string;
	repo?: string;
	/** Present ONLY on the fallback variant (receipt-spec §2). */
	origin?: { kind: "billedUnfinalized"; sourceReservationReceiptId: Ut1ReceiptId };
}

export type Work = CommitWork | PrIssueWork | SessionWork;

export interface Spend {
	assessedUsertokens: number;
	postedUsertokens: number;
	roundingAdjustment: number;
	transferCount: number;
	usagePosture: "provider" | "mixed" | "estimated";
	pricingPosture: "exact" | "conservative";
}

export interface TransferPair {
	authorizationTransferId: string;
	settlementTransferId: string;
}

/** The mint event's `data` — receipt-spec §2. */
export interface Projection {
	spec: "ut1";
	scope: "session";
	sessionId: string;
	generation: number;
	/** Present iff `generation > 1`. */
	prevGenerationEventHash?: string;
	work: Work;
	sessionAssociation: "workflowAttested" | "ownerAsserted";
	/** Present iff `sessionAssociation === "workflowAttested"`. */
	workloadId?: string;
	models: string[];
	providers: string[];
	startedAt: string;
	endedAt: string;
	spend: Spend;
	pricing: { tableVersions: string[] };
	/** Present iff `transferCount <= 32`. */
	transferSet?: TransferPair[];
	transferSetRoot: string;
}

export interface ChainEnvelope<TKind extends string, TData> {
	id: string;
	timestamp: string;
	previousHash: string;
	kind: TKind;
	actor: { type: string; id: string; name: string };
	data: TData;
	sequence: number;
	hash: string;
}

export type MintEvent = ChainEnvelope<string, Projection>;

export interface MerkleInclusionProof {
	version: 1;
	leafHash: string;
	leafIndex: number;
	treeSize: number;
	root: string;
	siblings: { hash: string; position: "left" | "right" }[];
	segmentId: string;
}

/** `SegmentCheckpoint` v2 — the signed statement (receipt-spec §4a). */
export interface SegmentCheckpointV2 {
	v: 2;
	vaultId: string;
	profile: string;
	root: string;
	treeSize: number;
	segmentId: string;
	segmentFirstSequence: number;
	previousSegmentRoot: string;
	previousSegmentId: string;
	keyId: string;
	publishedAt: string;
	sig: string;
}

export interface Proof {
	profile: string;
	chain: string;
	mintEventHash: string;
	inclusion: MerkleInclusionProof;
	checkpoint: SegmentCheckpointV2;
}

/** The §5 receipt wire document — the signed artifact. */
export interface ReceiptDocument {
	spec: "ut1";
	receiptId: Ut1ReceiptId;
	scope: "session";
	/** The ONLY minter-asserted clock claim (R27). */
	mintedAt: string;
	minter: { kind: string; keyId: string; trustDomain: string };
	work: Work;
	event: MintEvent;
	proof: Proof;
	signature: { alg: string; keyId: string; sig: string };
}

export interface RevisionSupersededAdvisory {
	kind: "revisionSuperseded";
	observedRevision: string;
	currentRevision: string;
}

export interface ReceiptSupersededAdvisory {
	kind: "receiptSuperseded";
	supersededByReceiptId: Ut1ReceiptId;
	eventHash: string;
}

export interface GenerationAddendumAdvisory {
	kind: "generationAddendum";
	generation: number;
	receiptId: Ut1ReceiptId;
}

/** An advisory kind this version does not know — rendered generically, never dropped. */
export interface UnknownAdvisory {
	kind: string;
	[key: string]: unknown;
}

export type Advisory =
	| RevisionSupersededAdvisory
	| ReceiptSupersededAdvisory
	| GenerationAddendumAdvisory
	| UnknownAdvisory;

/**
 * `anchorEvidence` is a CONTAINER, not a single-format union (§4.1: "receipt-
 * spec §5 formats (RekorReceipt; S3 probes as context)"). Only the Rekor
 * member can earn `verified_anchored`; S3 probes are operator-asserted
 * configuration and upgrade no cryptographic verdict (R8).
 */
export interface AnchorEvidence {
	rekor?: unknown;
	s3ObjectLock?: unknown;
}

export interface DisplaySpendRow {
	provider: string;
	model: string;
	tier: string;
	usertokens: number;
}

/**
 * The unsigned, explicitly NOT-chain-committed member (§10.1, R28-R31).
 * Nothing here ever shares the chain-committed fields' treatment, and the
 * resolver's `A + roundingAdjustment` recompute is display-grade — the
 * resolver's own online check, never a verifier verdict (R29).
 */
export interface Display {
	spendBreakdown?: DisplaySpendRow[];
	recomputedTotal?: { a: number; roundingAdjustment: number; total: number };
	pricingTables?: { hashes: string[]; pricingDeployment?: string };
	execution?: { agent?: boolean; interactive?: boolean };
}

/** 200 — all three ladder statuses share this shape. */
export interface SuccessEnvelope {
	apiVersion: "1";
	receiptId: Ut1ReceiptId;
	status: LadderStatus;
	/** The PERSISTED signed receipt bytes VERBATIM — byte-authoritative. */
	receiptBytes: string;
	/** Parsed CONVENIENCE copy of `receiptBytes` — for rendering, never authority. */
	receipt: ReceiptDocument;
	verification: Verification;
	advisories: Advisory[];
	anchorEvidence?: AnchorEvidence;
	checkpointHistory?: SegmentCheckpointV2[];
	display?: Display;
}

export interface PendingEnvelope {
	apiVersion: "1";
	receiptId: Ut1ReceiptId;
	status: "reserved" | "reconciling";
}

export interface TerminalNoReceiptEnvelope {
	apiVersion: "1";
	receiptId: Ut1ReceiptId;
	status: "cancelled" | "expired" | "notMinted";
}

export interface BilledUnfinalizedTerminalProof {
	chain: string;
	profile: string;
	event: ChainEnvelope<string, unknown>;
	inclusion: MerkleInclusionProof;
	checkpoint: SegmentCheckpointV2;
}

/** 410 `billedUnfinalized` — the §10.15-amended bundle. */
export interface BilledUnfinalizedEnvelope {
	apiVersion: "1";
	status: "billedUnfinalized";
	/** The trailered, UNPROVEN ID. */
	receiptId: Ut1ReceiptId;
	/** The spend-only session receipt this bundle links to. */
	linkedReceiptId: Ut1ReceiptId;
	transferSetRoot: string;
	terminalEvent: BilledUnfinalizedTerminalProof;
}

export interface UnknownEnvelope {
	apiVersion: "1";
	receiptId: Ut1ReceiptId;
	status: "unknown";
}

export interface UnverifiableEnvelope {
	apiVersion: "1";
	receiptId: Ut1ReceiptId;
	status: "unverifiable";
	verification: Verification;
}

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

// ===========================================================================
// PageState — what the route hands the renderer
// ===========================================================================

/** `Retry-After`, kept raw AND parsed (the header may be a delta or a date). */
export interface RetryAfter {
	raw: string;
	/** Present only for the delta-seconds form. */
	seconds?: number;
}

/** Why the page could not obtain a trustworthy answer (R37's enumeration). */
export type ProtocolErrorReason =
	| "transportTimeout"
	| "networkFailure"
	| "malformedBody"
	| "outOfTableHttpStatus"
	| "httpStatusBodyMismatch"
	| "missingApiVersion"
	| "unsupportedApiVersion"
	| "unknownStatus"
	| "schemaInvalid"
	| "failureCodeInvalid"
	| "verdictAlgebra";

/** The four R3 equalities the `billedUnfinalized` bundle must satisfy. */
export type BundleEquality =
	| "routeBodyId"
	| "linkedReceiptId"
	| "sourceReservationId"
	| "transferSetRoot";

/** R4's five stages, plus the JSON syntax check that mechanically precedes 3 and 4. */
export type R4Stage = "base64" | "utf8" | "syntax" | "duplicateKey" | "numeric" | "comparison";

export type IntegrityCause =
	| {
			/** 409 — the resolver's own recompute failed against the chain. */
			source: "resolver";
			verification: Verification;
			/** Every step/check reporting `failed`, in wire order. */
			failed: { name: StepName | CheckName; failure: FailureCode }[];
	  }
	| { source: "page"; obligation: "R1"; detail: string }
	| { source: "page"; obligation: "R3"; brokenEquality: BundleEquality; detail: string }
	| { source: "page"; obligation: "R4"; stage: R4Stage; detail: string };

export interface InvalidIdState {
	kind: "invalidId";
	routeParamId: string;
	/** Which half of §12's rule failed, in renderable words. */
	reason: string;
}

export interface VerifiedState {
	kind: "verified";
	routeParamId: string;
	receiptId: Ut1ReceiptId;
	rung: LadderStatus;
	envelope: SuccessEnvelope;
	/** The decoded, R4-validated `receiptBytes` as UTF-8 text. */
	receiptBytesText: string;
}

export interface PendingState {
	kind: "pending";
	routeParamId: string;
	receiptId: Ut1ReceiptId;
	status: "reserved" | "reconciling";
}

export interface TerminalNoReceiptState {
	kind: "terminalNoReceipt";
	routeParamId: string;
	receiptId: Ut1ReceiptId;
	status: "cancelled" | "expired" | "notMinted";
}

/**
 * 410 `billedUnfinalized`. `linkage` starts `"unchecked"`: only ONE of R3's
 * four equalities (route <-> body) is decidable from this response alone. The
 * other three need the linked receipt, which is a second fetch — run them via
 * {@link verifyBilledUnfinalizedLinkage} and render the link ONLY when this
 * field reads `"verified"` (R3: "Any mismatch -> integrity-failure state, no
 * link rendered").
 */
export interface BilledUnfinalizedState {
	kind: "billedUnfinalized";
	routeParamId: string;
	receiptId: Ut1ReceiptId;
	linkedReceiptId: Ut1ReceiptId;
	transferSetRoot: string;
	envelope: BilledUnfinalizedEnvelope;
	linkage: "unchecked" | "verified";
}

export interface UnknownReceiptState {
	kind: "unknownReceipt";
	routeParamId: string;
	receiptId: Ut1ReceiptId;
}

export interface IntegrityFailureState {
	kind: "integrityFailure";
	routeParamId: string;
	receiptId?: Ut1ReceiptId;
	cause: IntegrityCause;
}

export interface VerificationUnavailableState {
	kind: "verificationUnavailable";
	routeParamId: string;
	retryAfter?: RetryAfter;
}

export interface RateLimitedState {
	kind: "rateLimited";
	routeParamId: string;
	retryAfter?: RetryAfter;
}

export interface ProtocolErrorState {
	kind: "protocolError";
	routeParamId: string;
	reason: ProtocolErrorReason;
	/** Diagnostic detail — never the rendered headline, which §7 fixes. */
	detail: string;
	/** Present when an HTTP response existed at all. */
	httpStatus?: number;
}

export type PageState =
	| InvalidIdState
	| VerifiedState
	| PendingState
	| TerminalNoReceiptState
	| BilledUnfinalizedState
	| UnknownReceiptState
	| IntegrityFailureState
	| VerificationUnavailableState
	| RateLimitedState
	| ProtocolErrorState;

// ===========================================================================
// R2 / §12 — the canonical ut1 ID rule
// ===========================================================================

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_VALUES: ReadonlyMap<string, number> = new Map(
	Array.from(BASE58_ALPHABET, (ch, index) => [ch, index] as const),
);

/** `ut1_` + 16*22 Bitcoin-alphabet base58 characters. Necessary, never sufficient. */
const UT1_GRAMMAR = /^ut1_([1-9A-HJ-NP-Za-km-z]{16,22})$/;

/** The raw ID is exactly 128 bits (receipt-spec §3). */
const UT1_ID_BYTES = 16;

function base58Decode(input: string): Uint8Array | null {
	const bytes: number[] = [];
	for (const ch of input) {
		const value = BASE58_VALUES.get(ch);
		if (value === undefined) return null;
		let carry = value;
		for (let i = bytes.length - 1; i >= 0; i--) {
			const next = bytes[i] * 58 + carry;
			bytes[i] = next & 0xff;
			carry = next >>> 8;
		}
		while (carry > 0) {
			bytes.unshift(carry & 0xff);
			carry >>>= 8;
		}
	}
	// Leading '1's are leading ZERO BYTES, counted exactly — never padding to a
	// fixed width. A decoder that pads instead of counting would let two
	// distinct strings name one ID, which is the hazard §12 exists to close.
	let leadingZeros = 0;
	while (leadingZeros < input.length && input[leadingZeros] === "1") leadingZeros++;
	const out = new Uint8Array(leadingZeros + bytes.length);
	out.set(bytes, leadingZeros);
	return out;
}

function base58Encode(bytes: Uint8Array): string {
	let zeros = 0;
	while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
	const digits: number[] = [];
	for (let i = zeros; i < bytes.length; i++) {
		let carry = bytes[i];
		for (let j = 0; j < digits.length; j++) {
			const next = (digits[j] << 8) + carry;
			digits[j] = next % 58;
			carry = (next / 58) | 0;
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = (carry / 58) | 0;
		}
	}
	let out = "1".repeat(zeros);
	for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
	return out;
}

export type ReceiptIdValidation = { valid: true } | { valid: false; reason: string };

/**
 * R2 / receipt-spec §12 — the two-step canonical decode rule.
 *
 * "The character-count rule is NOT the ID rule": after the grammar matches, a
 * conformant parser MUST decode to EXACTLY 16 bytes and re-encode
 * byte-identically. The route runs this BEFORE fetching (D4) — a malformed ID
 * never reaches the resolver.
 */
export function validateReceiptId(routeParamId: string): ReceiptIdValidation {
	const match = UT1_GRAMMAR.exec(routeParamId);
	if (!match) {
		return {
			valid: false,
			reason: 'does not match the "ut1_" + 16-22 base58 (Bitcoin alphabet) grammar',
		};
	}
	const encoded = match[1];
	const decoded = base58Decode(encoded);
	if (decoded === null) {
		return { valid: false, reason: "contains a character outside the base58 alphabet" };
	}
	if (decoded.length !== UT1_ID_BYTES) {
		return {
			valid: false,
			reason: `decodes to ${decoded.length} bytes, not exactly ${UT1_ID_BYTES}`,
		};
	}
	if (base58Encode(decoded) !== encoded) {
		return { valid: false, reason: "is a non-canonical encoding (does not re-encode identically)" };
	}
	return { valid: true };
}

// ===========================================================================
// R4 stage 1 — canonical base64
// ===========================================================================

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES: ReadonlyMap<string, number> = new Map(
	Array.from(BASE64_ALPHABET, (ch, index) => [ch, index] as const),
);

/**
 * Canonical standard-base64 decode. Deliberately NOT `Buffer.from(s,
 * "base64")` / `atob`: both are lenient — they skip out-of-alphabet
 * characters and tolerate wrong padding — which would let a non-canonical
 * `receiptBytes` payload sail through the very check R4 exists to make.
 *
 * Canonicality is enforced structurally rather than by a re-encode round
 * trip: length is a multiple of 4, every character is in the alphabet,
 * padding occupies only the final one or two positions and matches the
 * leftover bit count exactly, and the leftover bits are zero. An input
 * satisfying all four re-encodes identically by construction.
 */
function base64DecodeCanonical(
	input: string,
): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
	if (input.length % 4 !== 0) {
		return { ok: false, reason: "length is not a multiple of 4 (non-canonical padding)" };
	}
	const padIndex = input.indexOf("=");
	let padCount = 0;
	if (padIndex !== -1) {
		padCount = input.length - padIndex;
		if (padCount > 2) return { ok: false, reason: "more than two padding characters" };
		for (let i = padIndex; i < input.length; i++) {
			if (input[i] !== "=")
				return { ok: false, reason: "padding appears before the final quantum" };
		}
	}
	const core = padIndex === -1 ? input : input.slice(0, padIndex);
	const bytes: number[] = [];
	let accumulator = 0;
	let bits = 0;
	for (const ch of core) {
		const value = BASE64_VALUES.get(ch);
		if (value === undefined) {
			return { ok: false, reason: `character "${ch}" is outside the standard base64 alphabet` };
		}
		accumulator = (accumulator << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((accumulator >> bits) & 0xff);
		}
	}
	if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
		return { ok: false, reason: "trailing bits of the final quantum are non-zero (non-canonical)" };
	}
	const expectedPad = bits === 0 ? 0 : bits === 2 ? 1 : bits === 4 ? 2 : -1;
	if (expectedPad !== padCount) {
		return { ok: false, reason: "padding length does not match the encoded byte count" };
	}
	return { ok: true, bytes: Uint8Array.from(bytes) };
}

// ===========================================================================
// R4 stages 3+4 — the strict JSON reader (never `JSON.parse`)
// ===========================================================================

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type StrictJsonResult =
	| { ok: true; value: JsonValue }
	| { ok: false; stage: "syntax" | "duplicateKey" | "numeric"; reason: string };

class StrictJsonError extends Error {
	readonly stage: "syntax" | "duplicateKey" | "numeric";
	constructor(stage: "syntax" | "duplicateKey" | "numeric", message: string) {
		super(message);
		this.stage = stage;
	}
}

export interface StrictJsonOptions {
	/**
	 * Apply the canonicalization appendix's FROZEN numeric rules (R4 stage 4):
	 * safe-integer-only numbers, no NaN/±Inf/−0.
	 *
	 * These govern the SIGNED receipt bytes. The unsigned envelope is not the
	 * signed artifact and is not bound by that appendix, so envelope parsing
	 * enforces only what JSON itself cannot express (non-finite values) —
	 * duplicate keys and syntax are rejected either way. Nothing is lost by
	 * the asymmetry: every number the page renders from `receipt` is byte-
	 * checked against `receiptBytes` by R4, which DOES apply the frozen rules,
	 * so an illegal literal cannot reach a rendered receipt through the
	 * convenience copy.
	 */
	frozenNumericRules: boolean;
}

/**
 * A hand-rolled recursive-descent JSON reader.
 *
 * Two things `JSON.parse` cannot do, both load-bearing for R4:
 *   - **duplicate keys are rejected BEFORE object construction** — a
 *     post-parse check cannot see the duplicate at all, because the last
 *     value silently wins (receipt-spec §11's corpus rule);
 *   - **numeric literals are checked as WRITTEN** — V8 rounds
 *     `9007199254740993` to `9007199254740992` during parsing, so a
 *     `Number.isSafeInteger` test on the parsed value is testing the wrong
 *     number.
 */
export function strictParseJson(text: string, options: StrictJsonOptions): StrictJsonResult {
	let i = 0;
	const n = text.length;

	function fail(stage: "syntax" | "duplicateKey" | "numeric", reason: string): never {
		throw new StrictJsonError(stage, `${reason} (at offset ${i})`);
	}

	function skipWhitespace(): void {
		while (i < n) {
			const c = text[i];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
			else break;
		}
	}

	function expectLiteral(literal: string): void {
		if (text.slice(i, i + literal.length) !== literal) fail("syntax", `expected "${literal}"`);
		i += literal.length;
	}

	function readHex4(): number {
		const hex = text.slice(i, i + 4);
		if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("syntax", "invalid \\u escape");
		i += 4;
		return Number.parseInt(hex, 16);
	}

	function readString(): string {
		i++; // opening quote
		let out = "";
		for (;;) {
			if (i >= n) fail("syntax", "unterminated string");
			const c = text[i];
			if (c === '"') {
				i++;
				return out;
			}
			if (c === "\\") {
				i++;
				const esc = text[i];
				i++;
				switch (esc) {
					case '"':
						out += '"';
						break;
					case "\\":
						out += "\\";
						break;
					case "/":
						out += "/";
						break;
					case "b":
						out += "\b";
						break;
					case "f":
						out += "\f";
						break;
					case "n":
						out += "\n";
						break;
					case "r":
						out += "\r";
						break;
					case "t":
						out += "\t";
						break;
					case "u":
						out += String.fromCharCode(readHex4());
						break;
					default:
						fail("syntax", `invalid escape "\\${esc ?? ""}"`);
				}
				continue;
			}
			if (c < " ") fail("syntax", "unescaped control character in string");
			out += c;
			i++;
		}
	}

	function readNumber(): number {
		const start = i;
		if (text[i] === "-") i++;
		if (text[i] === "0") {
			i++;
		} else if (text[i] >= "1" && text[i] <= "9") {
			while (i < n && text[i] >= "0" && text[i] <= "9") i++;
		} else {
			fail("syntax", "invalid number");
		}
		let fractional = false;
		if (text[i] === ".") {
			fractional = true;
			i++;
			if (!(text[i] >= "0" && text[i] <= "9")) fail("syntax", "no digits after the decimal point");
			while (i < n && text[i] >= "0" && text[i] <= "9") i++;
		}
		if (text[i] === "e" || text[i] === "E") {
			fractional = true;
			i++;
			if (text[i] === "+" || text[i] === "-") i++;
			if (!(text[i] >= "0" && text[i] <= "9")) fail("syntax", "no digits in the exponent");
			while (i < n && text[i] >= "0" && text[i] <= "9") i++;
		}
		const literal = text.slice(start, i);
		const value = Number(literal);
		if (!Number.isFinite(value)) fail("numeric", `non-finite numeric literal "${literal}"`);
		if (!options.frozenNumericRules) return value;
		if (Object.is(value, -0))
			fail("numeric", `negative zero literal "${literal}" is not permitted`);
		if (fractional) {
			fail("numeric", `non-integer numeric literal "${literal}" (safe integers only)`);
		}
		// Checked on the LITERAL, before the parser has a chance to round it.
		if (!Number.isSafeInteger(value)) {
			fail("numeric", `unsafe integer literal "${literal}" (outside +/-(2^53 - 1))`);
		}
		return value;
	}

	function readArray(): JsonValue[] {
		i++; // [
		const out: JsonValue[] = [];
		skipWhitespace();
		if (text[i] === "]") {
			i++;
			return out;
		}
		for (;;) {
			out.push(readValue());
			skipWhitespace();
			if (text[i] === ",") {
				i++;
				continue;
			}
			if (text[i] === "]") {
				i++;
				return out;
			}
			fail("syntax", 'expected "," or "]"');
		}
	}

	function readObject(): { [key: string]: JsonValue } {
		i++; // {
		const out: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
		const seen = new Set<string>();
		skipWhitespace();
		if (text[i] === "}") {
			i++;
			return { ...out };
		}
		for (;;) {
			skipWhitespace();
			if (text[i] !== '"') fail("syntax", "expected a string key");
			const key = readString();
			// Stage 3: the rejection happens HERE, before the value is attached.
			if (seen.has(key)) fail("duplicateKey", `duplicate key "${key}"`);
			seen.add(key);
			skipWhitespace();
			if (text[i] !== ":") fail("syntax", 'expected ":"');
			i++;
			out[key] = readValue();
			skipWhitespace();
			if (text[i] === ",") {
				i++;
				continue;
			}
			if (text[i] === "}") {
				i++;
				return { ...out };
			}
			fail("syntax", 'expected "," or "}"');
		}
	}

	function readValue(): JsonValue {
		skipWhitespace();
		if (i >= n) fail("syntax", "unexpected end of input");
		const c = text[i];
		if (c === "{") return readObject();
		if (c === "[") return readArray();
		if (c === '"') return readString();
		if (c === "t") {
			expectLiteral("true");
			return true;
		}
		if (c === "f") {
			expectLiteral("false");
			return false;
		}
		if (c === "n") {
			expectLiteral("null");
			return null;
		}
		if (c === "-" || (c >= "0" && c <= "9")) return readNumber();
		return fail("syntax", `unexpected character "${c}"`);
	}

	try {
		const value = readValue();
		skipWhitespace();
		if (i !== n) fail("syntax", "trailing data after the top-level value");
		return { ok: true, value };
	} catch (error) {
		if (error instanceof StrictJsonError) {
			return { ok: false, stage: error.stage, reason: error.message };
		}
		return { ok: false, stage: "syntax", reason: String(error) };
	}
}

// ===========================================================================
// R4 stage 5 — structural comparison
// ===========================================================================

/**
 * Key ORDER is immaterial (the §5 signature preimage is canonical, not
 * lexical); key PRESENCE is not — "absent != null" is one of the frozen
 * rules, so the key sets must match exactly.
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => structurallyEqual(item, b[index]));
	}
	if (typeof a === "object" && typeof b === "object") {
		const aKeys = Object.keys(a as Record<string, unknown>);
		const bKeys = Object.keys(b as Record<string, unknown>);
		if (aKeys.length !== bKeys.length) return false;
		const bRecord = b as Record<string, unknown>;
		return aKeys.every(
			(key) =>
				Object.hasOwn(bRecord, key) &&
				structurallyEqual((a as Record<string, unknown>)[key], bRecord[key]),
		);
	}
	return false;
}

// ===========================================================================
// R4 — the complete five-stage pipeline
// ===========================================================================

export type DecodedReceiptBytes =
	| { ok: true; bytes: Uint8Array; text: string }
	| { ok: false; stage: R4Stage; reason: string };

/**
 * Stages 1+2: canonical base64 decode, then FATAL UTF-8 decode (no
 * replacement characters). Exported for the `receipt.json` route, which
 * streams these bytes VERBATIM — it never re-serializes what the CLI will
 * hash (D2/R4).
 */
export function decodeReceiptBytes(receiptBytes: string): DecodedReceiptBytes {
	const decoded = base64DecodeCanonical(receiptBytes);
	if (!decoded.ok) return { ok: false, stage: "base64", reason: decoded.reason };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(decoded.bytes);
	} catch {
		return { ok: false, stage: "utf8", reason: "invalid UTF-8 sequence" };
	}
	return { ok: true, bytes: decoded.bytes, text };
}

export type ReceiptBytesAgreement =
	| { ok: true; text: string; parsed: JsonValue }
	| { ok: false; stage: R4Stage; reason: string };

/**
 * R4 in full: canonical base64 -> fatal UTF-8 -> pre-parse duplicate-key
 * rejection -> the frozen numeric rules -> structural comparison against
 * `receipt`.
 *
 * "A `receiptBytes` payload the strict verifier would reject renders the
 * integrity-failure state EVEN IF a lenient `JSON.parse` would accept it —
 * the page must never present bytes as 'the receipt' that the CLI will
 * refuse."
 */
export function checkReceiptBytesAgreement(
	receiptBytes: string,
	receipt: unknown,
): ReceiptBytesAgreement {
	const decoded = decodeReceiptBytes(receiptBytes);
	if (!decoded.ok) return decoded;
	const parsed = strictParseJson(decoded.text, { frozenNumericRules: true });
	if (!parsed.ok) return { ok: false, stage: parsed.stage, reason: parsed.reason };
	if (!structurallyEqual(parsed.value, receipt)) {
		return {
			ok: false,
			stage: "comparison",
			reason: "the decoded receiptBytes do not structurally match the `receipt` member",
		};
	}
	return { ok: true, text: decoded.text, parsed: parsed.value };
}

// ===========================================================================
// §4.1 — the verdict algebra and the closed failure-code union
// ===========================================================================

/**
 * Rule 1's mandatory base steps. For these, `failed` is disqualifying AND SO
 * ARE `unavailable`/`notApplicable` — "a mandatory step that did not run is
 * not a verification".
 */
export const MANDATORY_STEPS: readonly StepName[] = [
	"schema",
	"event",
	"registry",
	"signature",
	"inclusion",
	"checkpoint",
	"semantics",
];

const ALL_STEPS: readonly StepName[] = [...MANDATORY_STEPS, "derivations", "extensions"];

const ALL_CHECKS: readonly CheckName[] = [
	"registryBinding",
	"predecessorLinkage",
	"checkpointHistory",
	"anchorEvidence",
];

/**
 * Each code is legal only on its own step/check (§4.1). `extensions` is the
 * step-9 SUMMARY and owns no code of its own: the two step-9 codes belong to
 * the named extension checks, which is where §7 reports them.
 */
const LEGAL_FAILURE_CODE: Record<StepName | CheckName, FailureCode | null> = {
	schema: "SCHEMA_INVALID",
	event: "EVENT_MISMATCH",
	registry: "ID_MISMATCH",
	signature: "SIG_INVALID",
	inclusion: "PROOF_INVALID",
	checkpoint: "CHECKPOINT_INVALID",
	semantics: "SEMANTIC_INVALID",
	derivations: "DERIVATION_MISMATCH",
	extensions: null,
	registryBinding: "ID_MISMATCH",
	predecessorLinkage: "PREDECESSOR_MISMATCH",
	checkpointHistory: "HISTORY_INVALID",
	anchorEvidence: "ANCHOR_INVALID",
};

const FAILURE_CODES: ReadonlySet<string> = new Set<FailureCode>([
	"SCHEMA_INVALID",
	"EVENT_MISMATCH",
	"ID_MISMATCH",
	"SIG_INVALID",
	"PROOF_INVALID",
	"CHECKPOINT_INVALID",
	"SEMANTIC_INVALID",
	"DERIVATION_MISMATCH",
	"HISTORY_INVALID",
	"ANCHOR_INVALID",
	"PREDECESSOR_MISMATCH",
]);

export type AlgebraResult = { ok: true } | { ok: false; reason: string };

/**
 * The OPTIONAL §4.1 members an extension rung's claim rests on. The cap rules
 * key on the check result AND on the member that justifies it: a check saying
 * `passed` with nothing served to show for it is treated exactly as
 * `unavailable` (D1 — "a response without the member still parses (the §4.1
 * cap rules treat it as absent/unavailable — fail-closed to the rung below)").
 *
 * Deliberately widened to `unknown`: a `SuccessEnvelope` is assignable, and so
 * is a raw bag, so no caller can satisfy this by inventing a shape.
 */
export interface EvidenceMembers {
	anchorEvidence?: unknown;
	checkpointHistory?: unknown;
}

/**
 * The history walk itself. Absent (the `?include=checkpointHistory` opt-in was
 * not honored) or empty (a walk over nothing proves nothing) — either way the
 * history rung has no evidence under it.
 */
export function hasHistoryEvidence(evidence: EvidenceMembers): boolean {
	return Array.isArray(evidence.checkpointHistory) && evidence.checkpointHistory.length > 0;
}

/**
 * Only a Rekor attachment earns the anchored rung (R8): S3 Object Lock evidence
 * is OPERATOR-ASSERTED configuration that "may be displayed as context only,
 * upgrades no cryptographic verdict, and must never render as a green anchor
 * claim". An `anchorEvidence` member carrying only an S3 probe is therefore no
 * anchor evidence at all for the purposes of the ladder.
 */
export function hasAnchorEvidence(evidence: EvidenceMembers): boolean {
	return isBag(evidence.anchorEvidence) && isBag(evidence.anchorEvidence.rekor);
}

type ExtensionStanding = { upheld: true } | { upheld: false; why: string };

/**
 * Whether an extension check STANDS — the check passed and the envelope served
 * the evidence that check claims to have examined. Anything less caps the
 * status at the rung below, exactly as `unavailable` does (§4.1 rule 3).
 */
function extensionStanding(
	name: "checkpointHistory" | "anchorEvidence",
	result: StepResult,
	evidence: EvidenceMembers,
): ExtensionStanding {
	if (result !== "passed") {
		return { upheld: false, why: `${name} is "${result}", not "passed"` };
	}
	if (name === "checkpointHistory") {
		if (!hasHistoryEvidence(evidence)) {
			return {
				upheld: false,
				why:
					'checkpointHistory is "passed" but the envelope serves no non-empty checkpointHistory member — ' +
					"the history rung cannot render without the history it walked (D1), so the absent member caps " +
					'the status exactly as "unavailable" does',
			};
		}
		return { upheld: true };
	}
	if (!isBag(evidence.anchorEvidence)) {
		return {
			upheld: false,
			why:
				'anchorEvidence is "passed" but the envelope serves no anchorEvidence member — the absent member ' +
				'caps the status exactly as "unavailable" does (D1)',
		};
	}
	if (!isBag(evidence.anchorEvidence.rekor)) {
		return {
			upheld: false,
			why:
				'anchorEvidence is "passed" but the anchorEvidence member carries no Rekor attachment — S3 Object ' +
				"Lock evidence is operator-asserted configuration that upgrades no cryptographic verdict and must " +
				"never render as a green anchor claim (R8)",
		};
	}
	return { upheld: true };
}

/**
 * The closed failure-code rule: `failure` is present iff `result === "failed"`,
 * and each code is legal only where §4.1 places it. "An unknown or misplaced
 * code is a schema failure (R37)."
 */
export function checkFailureCodePlacement(verification: Verification): AlgebraResult {
	const entries: [StepName | CheckName, CheckEntry][] = [
		...ALL_STEPS.map((name) => [name, verification.steps[name]] as [StepName, CheckEntry]),
		...ALL_CHECKS.map((name) => [name, verification.checks[name]] as [CheckName, CheckEntry]),
	];
	for (const [name, entry] of entries) {
		if (entry.result === "failed") {
			if (entry.failure === undefined) {
				return { ok: false, reason: `"${name}" is failed but names no failure code` };
			}
			const legal = LEGAL_FAILURE_CODE[name];
			if (legal === null) {
				return { ok: false, reason: `"${name}" carries a failure code but owns none` };
			}
			if (entry.failure !== legal) {
				return {
					ok: false,
					reason: `"${name}" carries "${entry.failure}", but only "${legal}" is legal there`,
				};
			}
		} else if (entry.failure !== undefined) {
			return {
				ok: false,
				reason: `"${name}" is "${entry.result}" but carries a failure code (legal only on "failed")`,
			};
		}
	}
	return { ok: true };
}

/**
 * §4.1's three numbered rules. A 200 bearing any `verified_*` status is VALID
 * only when all of them hold; any violation is a protocol error — "a resolver
 * that computed these results and still answered 200 must not have".
 */
export function checkVerdictAlgebra(
	status: LadderStatus,
	verification: Verification,
	evidence: EvidenceMembers,
): AlgebraResult {
	const { steps, checks } = verification;

	// Rule 1 — mandatory base steps, all `passed`.
	for (const name of MANDATORY_STEPS) {
		if (steps[name].result !== "passed") {
			return {
				ok: false,
				reason: `mandatory step "${name}" is "${steps[name].result}", not "passed"`,
			};
		}
	}

	// Rule 2 — named non-mandatory results.
	//
	// `derivations`: passed, or notApplicable when transferSet is absent —
	// never failed/unavailable on a 200 (the recompute needs nothing outside
	// the receipt).
	if (steps.derivations.result !== "passed" && steps.derivations.result !== "notApplicable") {
		return {
			ok: false,
			reason: `"derivations" is "${steps.derivations.result}" — must be passed or notApplicable on a 200`,
		};
	}
	// `extensions` (the step-9 summary) may be anything — it is upgrade-only.
	//
	// `registryBinding` MUST be `passed` on a resolver-issued 200 (v0.4
	// actor-conflation correction): the registry IS the resolver's backing
	// store, so `unavailable` would assert "I read the registry for the bytes
	// but not for the binding". `unavailable`/`notApplicable` here are
	// OFFLINE-verification report values only.
	if (checks.registryBinding.result !== "passed") {
		return {
			ok: false,
			reason: `"registryBinding" is "${checks.registryBinding.result}" — must be "passed" on a resolver-issued 200`,
		};
	}
	// `predecessorLinkage`: passed, notApplicable (generation 1), or
	// unavailable. `failed` is a positive contradiction and disqualifying.
	const predecessor = checks.predecessorLinkage.result;
	if (
		predecessor !== "passed" &&
		predecessor !== "notApplicable" &&
		predecessor !== "unavailable"
	) {
		return {
			ok: false,
			reason: `"predecessorLinkage" is "${predecessor}" — must be passed, notApplicable, or unavailable on a 200`,
		};
	}

	// Rule 3 — extension checks CAP the status (exact status<->extension
	// agreement). A failed/unavailable extension never demotes the base
	// verdict (R10/R11), but a status above its cap is a protocol error.
	//
	// The cap binds the check result to the MEMBER that justifies it. A rung
	// claimed on a `passed` check whose evidence the envelope never served
	// (D1), or whose anchor evidence is operator-asserted S3 configuration
	// rather than a Rekor attachment (R8), is a rung with nothing under it —
	// capped exactly as `unavailable` caps, and therefore a protocol error at
	// the claimed status. Fail-closed: the page never renders green on
	// evidence it was not given.
	const history = extensionStanding("checkpointHistory", checks.checkpointHistory.result, evidence);
	const anchor = extensionStanding("anchorEvidence", checks.anchorEvidence.result, evidence);
	if (status === "verified_checkpoint_history" && !history.upheld) {
		return {
			ok: false,
			reason: `"verified_checkpoint_history" is above its cap: ${history.why}`,
		};
	}
	if (status === "verified_anchored" && !(history.upheld && anchor.upheld)) {
		const why = anchor.upheld ? (history as { why: string }).why : anchor.why;
		return {
			ok: false,
			reason: `"verified_anchored" is above its cap (the ladder is cumulative — it presupposes the complete verified history PLUS Rekor evidence): ${why}`,
		};
	}

	return { ok: true };
}

/**
 * The highest rung this `verification` warrants — R5's "which rungs exist
 * above". A function of the check results AND the evidence members: the rung
 * an envelope could claim is never higher than what it actually served.
 */
export function warrantedRung(verification: Verification, evidence: EvidenceMembers): LadderStatus {
	const history = extensionStanding(
		"checkpointHistory",
		verification.checks.checkpointHistory.result,
		evidence,
	).upheld;
	const anchor = extensionStanding(
		"anchorEvidence",
		verification.checks.anchorEvidence.result,
		evidence,
	).upheld;
	if (history && anchor) return "verified_anchored";
	if (history) return "verified_checkpoint_history";
	return "verified_checkpoint";
}

// ===========================================================================
// §3 — the wire table
// ===========================================================================

/** The HTTP codes §3 defines. Anything else fails closed (R37). */
const WIRE_HTTP_CODES: ReadonlySet<number> = new Set([200, 202, 410, 404, 409, 503, 429]);

/** Each body `status` answers exactly one HTTP code (§3). */
const HTTP_CODE_FOR_STATUS: Record<ResolverStatus, number> = {
	verified_checkpoint: 200,
	verified_checkpoint_history: 200,
	verified_anchored: 200,
	reserved: 202,
	reconciling: 202,
	cancelled: 410,
	expired: 410,
	notMinted: 410,
	billedUnfinalized: 410,
	unknown: 404,
	unverifiable: 409,
	verificationUnavailable: 503,
};

const LADDER_STATUSES: ReadonlySet<string> = new Set<LadderStatus>([
	"verified_checkpoint",
	"verified_checkpoint_history",
	"verified_anchored",
]);

// ===========================================================================
// Headers
// ===========================================================================

/** Either a `Headers` instance (the SSR fetch) or a plain bag (fixtures/tests). */
export type ResolverHeaders =
	| { get(name: string): string | null }
	| Record<string, string | string[] | undefined>;

function headerValue(headers: ResolverHeaders | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const maybeGet = (headers as { get?: unknown }).get;
	if (typeof maybeGet === "function") {
		return (headers as { get(n: string): string | null }).get(name) ?? undefined;
	}
	const bag = headers as Record<string, string | string[] | undefined>;
	const wanted = name.toLowerCase();
	for (const key of Object.keys(bag)) {
		if (key.toLowerCase() !== wanted) continue;
		const value = bag[key];
		const single = Array.isArray(value) ? value[0] : value;
		return single ?? undefined;
	}
	return undefined;
}

function readRetryAfter(headers: ResolverHeaders | undefined): RetryAfter | undefined {
	const raw = headerValue(headers, "retry-after");
	if (raw === undefined || raw.trim() === "") return undefined;
	const trimmed = raw.trim();
	if (/^\d+$/.test(trimmed)) return { raw: trimmed, seconds: Number(trimmed) };
	return { raw: trimmed };
}

// ===========================================================================
// §4 schema validation (shape only — the resolver owns the verdict, D2)
// ===========================================================================

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function requireString(bag: Bag, path: string, key: string): string | null {
	return isNonEmptyString(bag[key]) ? null : `${path}.${key} must be a non-empty string`;
}

/**
 * An integer-valued member. Deliberately NOT `Number.isSafeInteger`: the
 * frozen safe-integer rule belongs to the canonicalization appendix and is
 * enforced exactly once, on the SIGNED bytes, by R4 stage 4. Enforcing it a
 * second time here on the parsed convenience copy would re-route an
 * R4 byte-integrity failure into the protocol-error shell and rob the reader
 * of the honest diagnosis.
 */
function requireInteger(bag: Bag, path: string, key: string): string | null {
	const value = bag[key];
	return typeof value === "number" && Number.isInteger(value)
		? null
		: `${path}.${key} must be an integer`;
}

function requireBag(bag: Bag, path: string, key: string): string | null {
	return isBag(bag[key]) ? null : `${path}.${key} must be an object`;
}

function requireStringArray(bag: Bag, path: string, key: string): string | null {
	const value = bag[key];
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? null
		: `${path}.${key} must be an array of strings`;
}

function first(...errors: (string | null)[]): string | null {
	for (const error of errors) if (error !== null) return error;
	return null;
}

const STEP_RESULTS: ReadonlySet<string> = new Set<StepResult>([
	"passed",
	"failed",
	"notApplicable",
	"unavailable",
]);

function validateCheckEntry(value: unknown, path: string): string | null {
	if (!isBag(value)) return `${path} must be an object`;
	if (typeof value.result !== "string" || !STEP_RESULTS.has(value.result)) {
		return `${path}.result must be one of passed|failed|notApplicable|unavailable`;
	}
	if (Object.hasOwn(value, "failure")) {
		if (typeof value.failure !== "string" || !FAILURE_CODES.has(value.failure)) {
			return `${path}.failure is not a member of the closed failure-code union`;
		}
	}
	return null;
}

function validateVerification(value: unknown, path: string): string | null {
	if (!isBag(value)) return `${path} must be an object`;
	const snapshot = requireString(value, path, "trustSnapshotId");
	if (snapshot !== null) return snapshot;
	if (!isBag(value.steps)) return `${path}.steps must be an object`;
	if (!isBag(value.checks)) return `${path}.checks must be an object`;
	for (const name of ALL_STEPS) {
		const error = validateCheckEntry(value.steps[name], `${path}.steps.${name}`);
		if (error !== null) return error;
	}
	for (const name of ALL_CHECKS) {
		const error = validateCheckEntry(value.checks[name], `${path}.checks.${name}`);
		if (error !== null) return error;
	}
	return null;
}

function validateWork(value: unknown, path: string): string | null {
	if (!isBag(value)) return `${path} must be an object`;
	const repoId = requireString(value, path, "repoId");
	if (repoId !== null) return repoId;
	if (Object.hasOwn(value, "repo") && typeof value.repo !== "string") {
		return `${path}.repo, when present, must be a string`;
	}
	switch (value.kind) {
		case "commit":
			return first(
				requireString(value, path, "oid"),
				value.oidAlg === "sha1" || value.oidAlg === "sha256"
					? null
					: `${path}.oidAlg must be "sha1" or "sha256"`,
				requireString(value, path, "objectSha256"),
				requireBag(value, path, "repositoryMembership"),
			);
		case "pr":
		case "issue": {
			const scalars = first(
				requireInteger(value, path, "number"),
				requireString(value, path, "providerArtifactId"),
				requireString(value, path, "observedRevision"),
				requireBag(value, path, "contentBinding"),
				requireBag(value, path, "repositoryMembership"),
			);
			if (scalars !== null) return scalars;
			const binding = value.contentBinding as Bag;
			if (binding.kind === "publicSha256")
				return requireString(binding, `${path}.contentBinding`, "sha256");
			if (binding.kind === "privateHmacSha256V1") {
				return requireString(binding, `${path}.contentBinding`, "commitment");
			}
			return `${path}.contentBinding.kind must be publicSha256 or privateHmacSha256V1`;
		}
		case "session": {
			if (!Object.hasOwn(value, "origin")) return null;
			const origin = value.origin;
			if (!isBag(origin)) return `${path}.origin must be an object`;
			if (origin.kind !== "billedUnfinalized") {
				return `${path}.origin.kind must be "billedUnfinalized"`;
			}
			return requireString(origin, `${path}.origin`, "sourceReservationReceiptId");
		}
		default:
			return `${path}.kind must be commit|pr|issue|session`;
	}
}

function validateProjection(value: unknown, path: string): string | null {
	if (!isBag(value)) return `${path} must be an object`;
	const scalars = first(
		value.spec === "ut1" ? null : `${path}.spec must be "ut1"`,
		value.scope === "session" ? null : `${path}.scope must be "session"`,
		requireString(value, path, "sessionId"),
		requireInteger(value, path, "generation"),
		requireStringArray(value, path, "models"),
		requireStringArray(value, path, "providers"),
		requireString(value, path, "startedAt"),
		requireString(value, path, "endedAt"),
		requireBag(value, path, "pricing"),
		requireString(value, path, "transferSetRoot"),
		requireBag(value, path, "spend"),
		validateWork(value.work, `${path}.work`),
	);
	if (scalars !== null) return scalars;

	const spend = value.spend as Bag;
	const spendErrors = first(
		requireInteger(spend, `${path}.spend`, "assessedUsertokens"),
		requireInteger(spend, `${path}.spend`, "postedUsertokens"),
		requireInteger(spend, `${path}.spend`, "roundingAdjustment"),
		requireInteger(spend, `${path}.spend`, "transferCount"),
		spend.usagePosture === "provider" ||
			spend.usagePosture === "mixed" ||
			spend.usagePosture === "estimated"
			? null
			: `${path}.spend.usagePosture must be provider|mixed|estimated`,
		spend.pricingPosture === "exact" || spend.pricingPosture === "conservative"
			? null
			: `${path}.spend.pricingPosture must be exact|conservative`,
	);
	if (spendErrors !== null) return spendErrors;

	// The three §2 presence/exclusion rules the page's own rendering depends
	// on. These gate RENDERABILITY (R20's posture label, R34's linkage, R25's
	// list-vs-commitment split); the semantic verdict itself stays the
	// resolver's (step 7).
	const attested = value.sessionAssociation === "workflowAttested";
	if (!attested && value.sessionAssociation !== "ownerAsserted") {
		return `${path}.sessionAssociation must be workflowAttested|ownerAsserted`;
	}
	if (attested !== Object.hasOwn(value, "workloadId")) {
		return `${path}.workloadId must be present iff sessionAssociation is workflowAttested`;
	}
	if (attested && !isNonEmptyString(value.workloadId)) {
		return `${path}.workloadId must be a non-empty string`;
	}
	const generation = value.generation as number;
	if (generation > 1 !== Object.hasOwn(value, "prevGenerationEventHash")) {
		return `${path}.prevGenerationEventHash must be present iff generation > 1`;
	}
	const transferCount = spend.transferCount as number;
	if (transferCount <= 32 !== Object.hasOwn(value, "transferSet")) {
		return `${path}.transferSet must be present iff spend.transferCount <= 32`;
	}
	if (Object.hasOwn(value, "transferSet") && !Array.isArray(value.transferSet)) {
		return `${path}.transferSet must be an array`;
	}
	return null;
}

function validateInclusion(value: unknown, path: string): string | null {
	if (!isBag(value)) return `${path} must be an object`;
	return first(
		value.version === 1 ? null : `${path}.version must be 1`,
		requireString(value, path, "leafHash"),
		requireInteger(value, path, "leafIndex"),
		requireInteger(value, path, "treeSize"),
		requireString(value, path, "root"),
		Array.isArray(value.siblings) ? null : `${path}.siblings must be an array`,
		requireString(value, path, "segmentId"),
	);
}

function validateCheckpoint(value: unknown, path: string): string | null {
	if (!isBag(value)) return `${path} must be an object`;
	// v1 `PublishedMerkleRoot` objects never appear in receipts (§4a): their
	// root-only signature leaves treeSize and the lineage edge unauthenticated.
	return first(
		value.v === 2 ? null : `${path}.v must be 2 (a v1 checkpoint never appears in a receipt)`,
		requireString(value, path, "vaultId"),
		requireString(value, path, "profile"),
		requireString(value, path, "root"),
		requireInteger(value, path, "treeSize"),
		requireString(value, path, "segmentId"),
		requireInteger(value, path, "segmentFirstSequence"),
		requireString(value, path, "previousSegmentRoot"),
		requireString(value, path, "previousSegmentId"),
		requireString(value, path, "keyId"),
		requireString(value, path, "publishedAt"),
		requireString(value, path, "sig"),
	);
}

function validateChainEnvelope(value: unknown, path: string): string | null {
	if (!isBag(value)) return `${path} must be an object`;
	return first(
		requireString(value, path, "id"),
		requireString(value, path, "timestamp"),
		requireString(value, path, "previousHash"),
		requireString(value, path, "kind"),
		requireBag(value, path, "actor"),
		requireInteger(value, path, "sequence"),
		requireString(value, path, "hash"),
		Object.hasOwn(value, "data") ? null : `${path}.data must be present`,
	);
}

function validateReceiptDocument(value: unknown, path: string): string | null {
	if (!isBag(value)) return `${path} must be an object`;
	const scalars = first(
		value.spec === "ut1" ? null : `${path}.spec must be "ut1"`,
		requireString(value, path, "receiptId"),
		value.scope === "session" ? null : `${path}.scope must be "session"`,
		requireString(value, path, "mintedAt"),
		requireBag(value, path, "minter"),
		requireBag(value, path, "event"),
		requireBag(value, path, "proof"),
		requireBag(value, path, "signature"),
		validateWork(value.work, `${path}.work`),
	);
	if (scalars !== null) return scalars;

	const envelopeError = validateChainEnvelope(value.event, `${path}.event`);
	if (envelopeError !== null) return envelopeError;
	const projectionError = validateProjection((value.event as Bag).data, `${path}.event.data`);
	if (projectionError !== null) return projectionError;

	const proof = value.proof as Bag;
	return first(
		requireString(proof, `${path}.proof`, "profile"),
		requireString(proof, `${path}.proof`, "chain"),
		requireString(proof, `${path}.proof`, "mintEventHash"),
		validateInclusion(proof.inclusion, `${path}.proof.inclusion`),
		validateCheckpoint(proof.checkpoint, `${path}.proof.checkpoint`),
		requireString(value.minter as Bag, `${path}.minter`, "keyId"),
		requireString(value.signature as Bag, `${path}.signature`, "sig"),
	);
}

function validateAdvisories(value: unknown, path: string): string | null {
	if (!Array.isArray(value)) return `${path} must be an array (possibly empty)`;
	for (const [index, advisory] of value.entries()) {
		if (!isBag(advisory)) return `${path}[${index}] must be an object`;
		// Unknown kinds are TOLERATED and rendered generically (§4.1) — only the
		// discriminator itself is required.
		if (!isNonEmptyString(advisory.kind))
			return `${path}[${index}].kind must be a non-empty string`;
	}
	return null;
}

function validateSuccessEnvelope(body: Bag): string | null {
	return first(
		requireString(body, "body", "receiptId"),
		requireString(body, "body", "receiptBytes"),
		validateReceiptDocument(body.receipt, "body.receipt"),
		validateVerification(body.verification, "body.verification"),
		validateAdvisories(body.advisories, "body.advisories"),
		!Object.hasOwn(body, "anchorEvidence") || isBag(body.anchorEvidence)
			? null
			: "body.anchorEvidence, when present, must be an object",
		!Object.hasOwn(body, "checkpointHistory") || Array.isArray(body.checkpointHistory)
			? null
			: "body.checkpointHistory, when present, must be an array",
		!Object.hasOwn(body, "display") || isBag(body.display)
			? null
			: "body.display, when present, must be an object",
	);
}

function validateBilledUnfinalizedEnvelope(body: Bag): string | null {
	const scalars = first(
		requireString(body, "body", "receiptId"),
		requireString(body, "body", "linkedReceiptId"),
		requireString(body, "body", "transferSetRoot"),
		requireBag(body, "body", "terminalEvent"),
	);
	if (scalars !== null) return scalars;
	const terminal = body.terminalEvent as Bag;
	return first(
		requireString(terminal, "body.terminalEvent", "chain"),
		requireString(terminal, "body.terminalEvent", "profile"),
		validateChainEnvelope(terminal.event, "body.terminalEvent.event"),
		validateInclusion(terminal.inclusion, "body.terminalEvent.inclusion"),
		validateCheckpoint(terminal.checkpoint, "body.terminalEvent.checkpoint"),
	);
}

// ===========================================================================
// State constructors
// ===========================================================================

function protocolError(
	routeParamId: string,
	reason: ProtocolErrorReason,
	detail: string,
	httpStatus?: number,
): ProtocolErrorState {
	return { kind: "protocolError", routeParamId, reason, detail, httpStatus };
}

/**
 * R37's transport half — "resolver timeout, network failure". There is no
 * HTTP response to evaluate, so the route builds the state directly rather
 * than manufacturing a fake one to hand to {@link parseResolverResponse}.
 */
export function transportFailureState(
	routeParamId: string,
	failure: "timeout" | "networkFailure",
	detail?: string,
): ProtocolErrorState {
	return failure === "timeout"
		? protocolError(
				routeParamId,
				"transportTimeout",
				detail ?? "the resolver did not answer within the deadline",
			)
		: protocolError(routeParamId, "networkFailure", detail ?? "the resolver could not be reached");
}

function integrityFailure(
	routeParamId: string,
	cause: IntegrityCause,
	receiptId?: string,
): IntegrityFailureState {
	return { kind: "integrityFailure", routeParamId, receiptId, cause };
}

// ===========================================================================
// The entry point
// ===========================================================================

export interface ResolverResponseInput {
	/**
	 * The ID from `/r/<receiptId>` — the ARRIVAL CONTEXT (receipt-spec §7 step
	 * 3(a)). R1's identity chain is meaningless without it, which is why it is
	 * a required input rather than an optional one.
	 */
	routeParamId: string;
	httpStatus: number;
	headers?: ResolverHeaders;
	/**
	 * The response body EXACTLY as served, unparsed. `null` for a body-less
	 * response — the shape HTTP 429 always takes here (§4.2: its body is
	 * absent or untrusted and is NEVER parsed).
	 */
	raw: string | null;
}

/**
 * The only door from the wire into the page.
 *
 * Order of operations, and why:
 *   1. **§12 ID rule** — a malformed route never reaches the resolver (D4);
 *      re-checked here so no caller can skip it.
 *   2. **429** — the documented exemption: state from the status code and
 *      `Retry-After` alone, BEFORE any parsing (§4.2).
 *   3. **§3 wire table** — an HTTP code outside it fails closed (R37).
 *   4. **Body** — strict parse, then `apiVersion`, then `status`, then
 *      HTTP/status agreement. Version and status discipline fail closed
 *      BEFORE any shape is trusted; future-version data never receives green
 *      v1 treatment.
 *   5. **Per-status schema**, then (on a 200) the closed failure-code
 *      placement rule, then the §4.1 verdict algebra — three ways of asking
 *      "is this answer internally coherent?", all of which land in the
 *      protocol-error shell.
 *   6. **R1 identity**, then **R4 byte authority** — two ways of asking "is
 *      this answer about MY receipt, and do its bytes agree?", both of which
 *      land in the integrity-failure state.
 */
export function parseResolverResponse(input: ResolverResponseInput): PageState {
	const { routeParamId, httpStatus, headers, raw } = input;

	// 1 — R2 / §12.
	const idCheck = validateReceiptId(routeParamId);
	if (!idCheck.valid) {
		return { kind: "invalidId", routeParamId, reason: idCheck.reason };
	}

	// 2 — the 429 exemption (§4.2). Exactly one outcome; never protocol error.
	if (httpStatus === 429) {
		return { kind: "rateLimited", routeParamId, retryAfter: readRetryAfter(headers) };
	}

	// 3 — §3's wire table.
	if (!WIRE_HTTP_CODES.has(httpStatus)) {
		return protocolError(
			routeParamId,
			"outOfTableHttpStatus",
			`HTTP ${httpStatus} is not one of the §3 wire codes`,
			httpStatus,
		);
	}

	// 4 — the body.
	if (raw === null || raw.trim() === "") {
		return protocolError(routeParamId, "malformedBody", "the response body was empty", httpStatus);
	}
	const parsed = strictParseJson(raw, { frozenNumericRules: false });
	if (!parsed.ok) {
		return protocolError(
			routeParamId,
			"malformedBody",
			`the response body is not well-formed JSON: ${parsed.reason}`,
			httpStatus,
		);
	}
	if (!isBag(parsed.value)) {
		return protocolError(
			routeParamId,
			"schemaInvalid",
			"the response body is not a JSON object",
			httpStatus,
		);
	}
	const body = parsed.value as Bag;

	if (!Object.hasOwn(body, "apiVersion")) {
		return protocolError(
			routeParamId,
			"missingApiVersion",
			"the body carries no apiVersion",
			httpStatus,
		);
	}
	if (body.apiVersion !== "1") {
		return protocolError(
			routeParamId,
			"unsupportedApiVersion",
			`apiVersion ${JSON.stringify(body.apiVersion)} is not the supported version "1"`,
			httpStatus,
		);
	}

	const status = body.status;
	if (typeof status !== "string" || !Object.hasOwn(HTTP_CODE_FOR_STATUS, status)) {
		return protocolError(
			routeParamId,
			"unknownStatus",
			`status ${JSON.stringify(status)} is not one of the §3 statuses`,
			httpStatus,
		);
	}
	const resolverStatus = status as ResolverStatus;
	if (HTTP_CODE_FOR_STATUS[resolverStatus] !== httpStatus) {
		return protocolError(
			routeParamId,
			"httpStatusBodyMismatch",
			`status "${resolverStatus}" answers HTTP ${HTTP_CODE_FOR_STATUS[resolverStatus]}, but the response was HTTP ${httpStatus}`,
			httpStatus,
		);
	}

	// 503 has no receiptId to compare and no receipt to check.
	if (resolverStatus === "verificationUnavailable") {
		return { kind: "verificationUnavailable", routeParamId, retryAfter: readRetryAfter(headers) };
	}

	// Every remaining body names the receipt it is answering about. A body
	// answering about a DIFFERENT ID is the §10.15 "answer B under receipt A"
	// class — R1's rule, applied wherever the wire gives us the two IDs.
	const envelopeReceiptId = body.receiptId;
	if (!isNonEmptyString(envelopeReceiptId)) {
		return protocolError(
			routeParamId,
			"schemaInvalid",
			"body.receiptId must be a non-empty string",
			httpStatus,
		);
	}

	if (LADDER_STATUSES.has(resolverStatus)) {
		return parseSuccess(routeParamId, body, resolverStatus as LadderStatus, httpStatus);
	}

	switch (resolverStatus) {
		case "reserved":
		case "reconciling": {
			const identity = checkEnvelopeIdentity(routeParamId, envelopeReceiptId);
			return (
				identity ?? {
					kind: "pending",
					routeParamId,
					receiptId: envelopeReceiptId,
					status: resolverStatus,
				}
			);
		}
		case "cancelled":
		case "expired":
		case "notMinted": {
			const identity = checkEnvelopeIdentity(routeParamId, envelopeReceiptId);
			return (
				identity ?? {
					kind: "terminalNoReceipt",
					routeParamId,
					receiptId: envelopeReceiptId,
					status: resolverStatus,
				}
			);
		}
		case "unknown": {
			const identity = checkEnvelopeIdentity(routeParamId, envelopeReceiptId);
			return identity ?? { kind: "unknownReceipt", routeParamId, receiptId: envelopeReceiptId };
		}
		case "billedUnfinalized":
			return parseBilledUnfinalized(routeParamId, body, httpStatus);
		case "unverifiable":
			return parseUnverifiable(routeParamId, body, envelopeReceiptId, httpStatus);
		default:
			return protocolError(
				routeParamId,
				"unknownStatus",
				`status "${resolverStatus}" has no page state`,
				httpStatus,
			);
	}
}

/** R1's envelope half — returns the integrity failure, or `null` when they agree. */
function checkEnvelopeIdentity(
	routeParamId: string,
	envelopeReceiptId: string,
): IntegrityFailureState | null {
	if (envelopeReceiptId === routeParamId) return null;
	return integrityFailure(
		routeParamId,
		{
			source: "page",
			obligation: "R1",
			detail: `the resolver answered about "${envelopeReceiptId}", but the page asked about "${routeParamId}"`,
		},
		envelopeReceiptId,
	);
}

function parseSuccess(
	routeParamId: string,
	body: Bag,
	status: LadderStatus,
	httpStatus: number,
): PageState {
	const schemaError = validateSuccessEnvelope(body);
	if (schemaError !== null) {
		return protocolError(routeParamId, "schemaInvalid", schemaError, httpStatus);
	}
	const envelope = body as unknown as SuccessEnvelope;

	// The closed failure-code union first: an unknown or misplaced code is a
	// schema failure (§4.1), and the algebra's reasons are only meaningful
	// once the codes are where they belong.
	const placement = checkFailureCodePlacement(envelope.verification);
	if (!placement.ok) {
		return protocolError(routeParamId, "failureCodeInvalid", placement.reason, httpStatus);
	}

	// The envelope IS the evidence argument — the members and the checks that
	// claim them can never be read from two different objects.
	const algebra = checkVerdictAlgebra(status, envelope.verification, envelope);
	if (!algebra.ok) {
		return protocolError(routeParamId, "verdictAlgebra", algebra.reason, httpStatus);
	}

	// R1 — the ut1 identity chain: route === envelope.receiptId === receipt.receiptId.
	const envelopeIdentity = checkEnvelopeIdentity(routeParamId, envelope.receiptId);
	if (envelopeIdentity !== null) return envelopeIdentity;
	if (envelope.receipt.receiptId !== routeParamId) {
		return integrityFailure(
			routeParamId,
			{
				source: "page",
				obligation: "R1",
				detail: `the receipt document names "${envelope.receipt.receiptId}", but the page asked about "${routeParamId}"`,
			},
			envelope.receiptId,
		);
	}

	// R4 — byte authority.
	const agreement = checkReceiptBytesAgreement(envelope.receiptBytes, envelope.receipt);
	if (!agreement.ok) {
		return integrityFailure(
			routeParamId,
			{ source: "page", obligation: "R4", stage: agreement.stage, detail: agreement.reason },
			envelope.receiptId,
		);
	}

	return {
		kind: "verified",
		routeParamId,
		receiptId: envelope.receiptId,
		rung: status,
		envelope,
		receiptBytesText: agreement.text,
	};
}

function parseUnverifiable(
	routeParamId: string,
	body: Bag,
	envelopeReceiptId: string,
	httpStatus: number,
): PageState {
	const schemaError = validateVerification(body.verification, "body.verification");
	if (schemaError !== null) {
		return protocolError(routeParamId, "schemaInvalid", schemaError, httpStatus);
	}
	const verification = body.verification as unknown as Verification;
	const placement = checkFailureCodePlacement(verification);
	if (!placement.ok) {
		return protocolError(routeParamId, "failureCodeInvalid", placement.reason, httpStatus);
	}
	const identity = checkEnvelopeIdentity(routeParamId, envelopeReceiptId);
	if (identity !== null) return identity;

	const failed: { name: StepName | CheckName; failure: FailureCode }[] = [];
	for (const name of ALL_STEPS) {
		const entry = verification.steps[name];
		if (entry.result === "failed" && entry.failure) failed.push({ name, failure: entry.failure });
	}
	for (const name of ALL_CHECKS) {
		const entry = verification.checks[name];
		if (entry.result === "failed" && entry.failure) failed.push({ name, failure: entry.failure });
	}

	// §4.2: a 409 names WHICH step failed, with its closed-union code — a
	// body claiming "unverifiable" while its own verification names no
	// failure contradicts its HTTP status, and R37 routes that to the
	// protocol-error shell, not to the resolver's integrity wording.
	if (failed.length === 0) {
		return protocolError(
			routeParamId,
			"httpStatusBodyMismatch",
			`a 409 "unverifiable" body must name the failed step (§4.2); its verification names none`,
			httpStatus,
		);
	}

	return integrityFailure(
		routeParamId,
		{ source: "resolver", verification, failed },
		envelopeReceiptId,
	);
}

function parseBilledUnfinalized(routeParamId: string, body: Bag, httpStatus: number): PageState {
	const schemaError = validateBilledUnfinalizedEnvelope(body);
	if (schemaError !== null) {
		return protocolError(routeParamId, "schemaInvalid", schemaError, httpStatus);
	}
	const envelope = body as unknown as BilledUnfinalizedEnvelope;

	// R3's first equality — the only one decidable from this response alone.
	if (envelope.receiptId !== routeParamId) {
		return integrityFailure(
			routeParamId,
			{
				source: "page",
				obligation: "R3",
				brokenEquality: "routeBodyId",
				detail: `the bundle answers about "${envelope.receiptId}", but the page asked about "${routeParamId}"`,
			},
			envelope.receiptId,
		);
	}

	return {
		kind: "billedUnfinalized",
		routeParamId,
		receiptId: envelope.receiptId,
		linkedReceiptId: envelope.linkedReceiptId,
		transferSetRoot: envelope.transferSetRoot,
		envelope,
		linkage: "unchecked",
	};
}

/**
 * R3's remaining three equalities, which need the LINKED receipt — a second
 * resolution. Run this before rendering or following the link; "any mismatch
 * -> integrity-failure state, no link rendered".
 *
 * `linkedReceipt` is the linked ID's own successfully-parsed page state, so a
 * linked side that is anything but a clean `verified` receipt (a 404, a
 * protocol error, an integrity failure of its own) can never satisfy the
 * cross-check.
 */
export function verifyBilledUnfinalizedLinkage(
	state: BilledUnfinalizedState,
	linkedReceipt: PageState,
): BilledUnfinalizedState | IntegrityFailureState {
	const fail = (brokenEquality: BundleEquality, detail: string): IntegrityFailureState =>
		integrityFailure(
			state.routeParamId,
			{ source: "page", obligation: "R3", brokenEquality, detail },
			state.receiptId,
		);

	if (linkedReceipt.kind !== "verified") {
		return fail(
			"linkedReceiptId",
			`the linked receipt did not resolve to a verified receipt (it resolved to "${linkedReceipt.kind}")`,
		);
	}
	const linked = linkedReceipt.envelope;
	if (linked.receiptId !== state.linkedReceiptId) {
		return fail(
			"linkedReceiptId",
			`the bundle names linkedReceiptId "${state.linkedReceiptId}", but the linked receipt is "${linked.receiptId}"`,
		);
	}
	const work = linked.receipt.work;
	const origin = work.kind === "session" ? work.origin : undefined;
	if (origin === undefined) {
		return fail(
			"sourceReservationId",
			"the linked receipt is not the fallback variant (no work.origin.billedUnfinalized)",
		);
	}
	if (origin.sourceReservationReceiptId !== state.receiptId) {
		return fail(
			"sourceReservationId",
			`the linked receipt's origin cites "${origin.sourceReservationReceiptId}", not "${state.receiptId}"`,
		);
	}
	if (linked.receipt.event.data.transferSetRoot !== state.transferSetRoot) {
		return fail(
			"transferSetRoot",
			"the transfer-set root differs between the terminal event and the fallback receipt",
		);
	}
	return { ...state, linkage: "verified" };
}
