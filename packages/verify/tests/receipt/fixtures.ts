// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The ut1 conformance corpus — TEST-ONLY.
 *
 * Every vector is a MINTED bundle (see `harness.ts`) plus the verdict
 * receipt-spec §7 and the CLI spec require of it. The verifier does not exist
 * yet while this file is written, and that is deliberate: the expectations are
 * read out of the specs, not out of an implementation, so Tasks 2–5 are graded
 * against the spec rather than against themselves.
 *
 * Each vector declares `breaks` — the INDEPENDENT facts (`FactName`) the
 * mutation invalidates, computed in `harness.test.ts` from the spec text. The
 * corpus test asserts the computed set EQUALS the declared one, which pins two
 * things at once: that a mutant breaks what it claims, and that it breaks
 * nothing else. An empty `breaks` on a failing vector is the strongest kind:
 * the material is cryptographically perfect and only trust state, semantics,
 * or the history walk distinguishes it from a pass.
 *
 * Authority order for every expectation here: receipt-spec v0.9 > the CLI spec
 * v0.3 > the plan. Where a reading required judgement, the vector says so.
 */

import {
	ALT_RECEIPT_ID,
	CHECKPOINT_KEY,
	CHECKPOINT_KEY_SUCCESSOR,
	checkpointPreimage,
	corruptBase64,
	DEFAULT_RECEIPT_ID,
	type FactName,
	FOREIGN_KEY,
	GAPPED_SEGMENTS,
	injectAfterOpeningBrace,
	LEADING_ZERO_RECEIPT_ID,
	LONG_DECODE_RECEIPT_ID,
	MINT_KEY,
	MINT_KEY_SUCCESSOR,
	type MintedBundle,
	mint,
	otherHash,
	type Projection,
	receiptSignaturePreimage,
	replaceOnce,
	type SegmentCheckpoint,
	SHORT_DECODE_RECEIPT_ID,
	signEd25519,
	type TrustKeyEntry,
	type TrustSnapshot,
	transferPairs,
	transferSetRoot,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// Expectation vocabulary.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `USAGE_ERROR` is not a §7 verdict — it is the CLI spec's exit 3, the case
 * where the caller handed the wrong document to the wrong mode. It lives here
 * because the corpus has to carry the vector; no verifier ever emits it as a
 * verdict.
 */
export type Verdict =
	| "VERIFIED_CHECKPOINT"
	| "VERIFIED_CHECKPOINT_HISTORY"
	| "VERIFIED_ANCHORED"
	| "FAILED"
	| "UNVERIFIABLE"
	| "USAGE_ERROR";

/**
 * The nine §7 step names (verify-page §4.1's wire names), plus `envelope` —
 * the CLI spec's distinct outcome for resolver-framing failures, which are
 * NOT a schema failure of the signed receipt.
 */
export type StepName =
	| "schema"
	| "event"
	| "registry"
	| "signature"
	| "inclusion"
	| "checkpoint"
	| "semantics"
	| "derivations"
	| "extensions"
	| "envelope";

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

export type MissingWhat = "trustSnapshot" | "receiptBytes" | "proof" | "checkpoint" | "trustKey";

export type CheckName =
	| "registryBinding"
	| "predecessorLinkage"
	| "checkpointHistory"
	| "anchorEvidence";

export type CheckResult = "passed" | "failed" | "notApplicable" | "unavailable";

export interface Expectation {
	readonly verdict: Verdict;
	/** Present iff `verdict === "FAILED"`. */
	readonly step?: StepName;
	readonly code?: FailureCode;
	/** Present iff `verdict === "UNVERIFIABLE"`. */
	readonly missing?: MissingWhat;
	/** A step-9 extension result reported ALONGSIDE the base verdict. */
	readonly extension?: {
		readonly check: CheckName;
		readonly result: CheckResult;
		readonly code?: FailureCode;
	};
	/** Checks this build declines to run — reported out of band, never as a §7 value. */
	readonly unimplemented?: readonly CheckName[];
	/** 0 verified · 1 FAILED · 2 UNVERIFIABLE · 3 usage (CLI spec §6). */
	readonly exitCode: 0 | 1 | 2 | 3;
}

export interface Vector {
	readonly name: string;
	/** One sentence: what this vector proves. */
	readonly what: string;
	/** `receipt` = the file IS the receipt; `envelope` = `--envelope`. */
	readonly mode: "receipt" | "envelope";
	readonly expect: Expectation;
	readonly breaks: readonly FactName[];
	/** `--expect-id` argument for step 3(a), when the vector exercises it. */
	readonly expectId?: string;
	readonly build: () => MintedBundle;
}

const PASS: Expectation = { verdict: "VERIFIED_CHECKPOINT", exitCode: 0 };
const PASS_HISTORY: Expectation = { verdict: "VERIFIED_CHECKPOINT_HISTORY", exitCode: 0 };

function failed(step: StepName, code: FailureCode): Expectation {
	return { verdict: "FAILED", step, code, exitCode: 1 };
}

function unverifiable(missing: MissingWhat): Expectation {
	return { verdict: "UNVERIFIABLE", missing, exitCode: 2 };
}

/** A step-9 failure NEVER demotes the base verdict (§7 step 9). */
function historyFailed(): Expectation {
	return {
		verdict: "VERIFIED_CHECKPOINT",
		exitCode: 0,
		extension: { check: "checkpointHistory", result: "failed", code: "HISTORY_INVALID" },
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Small mutation helpers.
// ─────────────────────────────────────────────────────────────────────────────

/** Mutate the freshly minted snapshot in place; `mint` hands out a new one each call. */
function snapshotPatch(fn: (s: TrustSnapshot) => void): (s: TrustSnapshot) => TrustSnapshot {
	return (snapshot) => {
		fn(snapshot);
		return snapshot;
	};
}

function projectionPatch(fn: (p: Projection) => void): (p: Projection) => Projection {
	return (projection) => {
		fn(projection);
		return projection;
	};
}

function keyEntry(snapshot: TrustSnapshot, keyId: string): TrustKeyEntry {
	const entry = snapshot.keys.find((key) => key.keyId === keyId);
	if (entry === undefined) throw new Error(`fixtures: no snapshot key ${keyId}`);
	return entry;
}

function spend(projection: Projection): Record<string, unknown> {
	return projection.spend as Record<string, unknown>;
}

function work(projection: Projection): Record<string, unknown> {
	return projection.work as Record<string, unknown>;
}

/** Re-sign a checkpoint whose unsigned payload was edited. */
function resign(checkpoint: SegmentCheckpoint, signer = CHECKPOINT_KEY): SegmentCheckpoint {
	const { sig: _dropped, ...unsigned } = checkpoint;
	return { ...unsigned, sig: signEd25519(signer, checkpointPreimage(unsigned)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Passing vectors — at least one per §7 step, plus the shape variants.
// ─────────────────────────────────────────────────────────────────────────────

export const PASS_VECTORS: readonly Vector[] = [
	{
		name: "pass/canonical",
		what: "A clean minted receipt passes steps 1–8; step 3(b) and step 9 are notApplicable offline.",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		build: () => mint(),
	},
	{
		name: "pass/envelope-clean-history",
		what: "A complete genesis-rooted history containing the embedded checkpoint upgrades the rung.",
		mode: "envelope",
		expect: PASS_HISTORY,
		breaks: [],
		build: () => mint(),
	},
	{
		name: "pass/transfer-set-absent-above-32",
		what: "37 pairs ⇒ transferSet ABSENT and step 8 notApplicable; transferSetRoot stays a commitment.",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		build: () => mint({ projectionOptions: { transferCount: 37 } }),
	},
	{
		name: "pass/leading-zero-receipt-id",
		what: "§3's leading zero bytes encode as leading `1`s and survive the §12 re-encode check.",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		build: () => mint({ receiptId: LEADING_ZERO_RECEIPT_ID }),
	},
	{
		name: "pass/generation-2-addendum",
		what: "generation 2 carries prevGenerationEventHash; predecessorLinkage stays notApplicable offline.",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		build: () => mint({ projectionOptions: { generation: 2 } }),
	},
	{
		name: "pass/owner-asserted-session",
		what: "sessionAssociation ownerAsserted with workloadId key-ABSENT is the other legal presence pairing.",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		build: () =>
			mint({
				projection: projectionPatch((p) => {
					p.sessionAssociation = "ownerAsserted";
					delete p.workloadId;
				}),
			}),
	},
	{
		name: "pass/retired-mint-key-in-bounds",
		what: "A retired MINT key verifies material whose segment precedes its successor's activation (§8).",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					const key = keyEntry(s, MINT_KEY.keyId);
					key.state = "retired";
					// The mint event's segment starts at 11; the successor activated at 18.
					key.activationSequence = 18;
					s.keys.push({
						keyId: MINT_KEY_SUCCESSOR.keyId,
						alg: "ed25519",
						publicKey: MINT_KEY_SUCCESSOR.publicKeyPem,
						role: "mint",
						minterKind: "proxy",
						predecessorKeyId: MINT_KEY.keyId,
						state: "active",
					});
					(s.chains[0] as { mintKeyIds: string[] }).mintKeyIds.push(MINT_KEY_SUCCESSOR.keyId);
				}),
			}),
	},
	{
		name: "pass/retired-checkpoint-key-in-bounds",
		what: "A retired CHECKPOINT key verifies checkpoints with segmentFirstSequence < activationSequence.",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					const key = keyEntry(s, CHECKPOINT_KEY.keyId);
					key.state = "retired";
					key.activationSequence = 18;
					s.keys.push({
						keyId: CHECKPOINT_KEY_SUCCESSOR.keyId,
						alg: "ed25519",
						publicKey: CHECKPOINT_KEY_SUCCESSOR.publicKeyPem,
						role: "checkpoint",
						predecessorKeyId: CHECKPOINT_KEY.keyId,
						state: "active",
					});
				}),
			}),
	},
	{
		name: "pass/delegation-posture-indeterminate",
		what: "`indeterminate` is RECOGNIZED verifier vocabulary: it labels the amount, it does not fail (§7).",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		build: () =>
			mint({ projection: projectionPatch((p) => (p.delegationPosture = "indeterminate")) }),
	},
	{
		name: "pass/snapshot-unknown-top-level-member",
		what: "§4's forward-compat rule: an unknown SNAPSHOT member is tolerated (the signing scheme is coming).",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					s.snapshotSignature = { alg: "ed25519", sig: "AAAA" };
					s.predecessorHash = otherHash("snapshot-predecessor");
				}),
			}),
	},
	{
		name: "pass/arrival-context-bare-id",
		what: "Step 3(a) passes when the document's receiptId equals the ID it arrived under.",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		expectId: DEFAULT_RECEIPT_ID,
		build: () => mint(),
	},
	{
		name: "pass/arrival-context-url",
		what: "§12's resolution URL is an accepted arrival context; the ID is extracted from it.",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		expectId: `https://usertrust.ai/r/${DEFAULT_RECEIPT_ID}`,
		build: () => mint(),
	},
	{
		name: "pass/arrival-context-trailer",
		what: "§12's whole-line trailer form is an accepted arrival context.",
		mode: "receipt",
		expect: PASS,
		breaks: [],
		expectId: `Usertrust-Receipt: https://usertrust.ai/r/${DEFAULT_RECEIPT_ID}`,
		build: () => mint(),
	},
	{
		name: "pass/anchor-evidence-present-is-unimplemented",
		what: "Present anchor evidence is named in `unimplemented`, NEVER given a §7 value, and never upgrades.",
		mode: "envelope",
		expect: {
			verdict: "VERIFIED_CHECKPOINT_HISTORY",
			exitCode: 0,
			unimplemented: ["anchorEvidence"],
		},
		breaks: [],
		build: () =>
			mint({
				envelope: (e) => {
					e.anchorEvidence = { kind: "rekor", logIndex: 918273, body: "…" };
					return e;
				},
			}),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// B. Step 1 — the strict byte reader and the §5 schema.
// ─────────────────────────────────────────────────────────────────────────────

export const PARSE_VECTORS: readonly Vector[] = [
	{
		name: "parse/bom",
		what: "A BOM is RETAINED (ignoreBOM: true) and then rejected at parse — never silently dropped (PR #92).",
		mode: "receipt",
		expect: unverifiable("receiptBytes"),
		breaks: ["parse"],
		build: () => mint({ bytes: (b) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) }),
	},
	{
		name: "parse/invalid-utf8",
		what: "A lone 0xFF byte is rejected by FATAL UTF-8 decoding, not replaced with U+FFFD.",
		mode: "receipt",
		expect: unverifiable("receiptBytes"),
		breaks: ["parse"],
		build: () => mint({ bytes: (b) => Buffer.concat([b, Buffer.from([0xff])]) }),
	},
	{
		name: "parse/duplicate-key",
		what: "A duplicate TOP-LEVEL key is rejected PRE-parse; JSON.parse would silently keep the last one.",
		mode: "receipt",
		expect: unverifiable("receiptBytes"),
		breaks: ["parse"],
		build: () => mint({ bytes: (b) => injectAfterOpeningBrace(b, '"spec":"ut1",') }),
	},
	{
		// §4a's duplicate-key rejection is about the DOCUMENT, not its first
		// level: "Strict duplicate-JSON-key rejection applies to receipts AND
		// well-known documents", and §11 requires it "before object parsing" —
		// a scanner that only walks depth 0 satisfies neither, yet a top-level-only
		// corpus is green on it. This vector sits three levels down
		// (receipt → event → data → spend).
		//
		// It duplicates a key with the SAME value on purpose, so the mutation is
		// invisible to everything except the duplicate rule: `JSON.parse` yields
		// a byte-identical object, so `event.hash` still recomputes and the §5
		// signature still verifies. Nothing but a pre-parse scan at depth can see
		// it. (The receipt is partly self-protecting against a DIFFERENT-valued
		// nested duplicate, because that changes the signature preimage — which is
		// exactly why the same-valued one is the vector that isolates the rule,
		// and why the snapshot, which carries no signature in v1, needs its own.)
		name: "parse/duplicate-key-nested",
		what: "A duplicate key THREE LEVELS DOWN (`event.data.spend`) is rejected pre-parse — depth-0-only dedupe is not the rule.",
		mode: "receipt",
		expect: unverifiable("receiptBytes"),
		breaks: ["parse"],
		build: () =>
			mint({
				bytes: (b) => replaceOnce(b, '"spend":{', '"spend":{"pricingPosture":"exact",'),
			}),
	},
	{
		name: "parse/truncated",
		what: "Truncated bytes will not parse — missing material, never a FAILED verdict.",
		mode: "receipt",
		expect: unverifiable("receiptBytes"),
		breaks: ["parse"],
		build: () => mint({ bytes: (b) => b.subarray(0, b.length - 1) }),
	},
	{
		name: "parse/nan-literal",
		what: "`NaN` has no JSON literal: it arrives as a parse error, which is why §3's NaN rule is about VALUES.",
		mode: "receipt",
		expect: unverifiable("receiptBytes"),
		breaks: ["parse"],
		build: () => mint({ bytes: (b) => replaceOnce(b, '"sequence":14', '"sequence":NaN') }),
	},
	{
		name: "schema/infinity-value",
		what: "`1e999` PARSES to Infinity — the one reachable non-finite value, rejected as a value, not by a throw.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: ["parse"],
		build: () =>
			mint({
				bytes: (b) => replaceOnce(b, '"assessedUsertokens":48224', '"assessedUsertokens":1e999'),
			}),
	},
	{
		name: "schema/non-integer",
		what: "A non-integer where §2 declares an integer domain is a schema failure of the frozen reader.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: ["parse"],
		build: () => mint({ bytes: (b) => replaceOnce(b, '"sequence":14', '"sequence":14.5') }),
	},
	{
		name: "schema/negative-zero",
		what: "`-0` is rejected: it compares equal to 0 but canonicalizes to `-0`, so equality and bytes disagree.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: ["parse"],
		build: () =>
			mint({ bytes: (b) => replaceOnce(b, '"roundingAdjustment":14', '"roundingAdjustment":-0') }),
	},
	{
		name: "schema/unsafe-integer",
		what: "2^53 is an integer and NOT a safe one; accepting it means accepting a number that already lost bits.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: ["parse"],
		build: () =>
			mint({
				bytes: (b) =>
					replaceOnce(b, '"assessedUsertokens":48224', '"assessedUsertokens":9007199254740993'),
			}),
	},
	{
		name: "schema/unknown-top-level-field",
		what: "An unknown field in the SIGNED receipt fails (§5) even though the signature covers it.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: [],
		build: () => mint({ receiptBeforeSign: (r) => ({ ...r, note: "hello" }) }),
	},
	{
		name: "schema/unknown-projection-field",
		what: "Unknown fields are rejected ANYWHERE in a ut1 document, including inside the chain-committed data.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: [],
		build: () => mint({ projection: projectionPatch((p) => (p.internalNote = "x")) }),
	},
	{
		name: "schema/duplicate-projection-copy",
		what: "A second projection copy is an unknown field; equality 3 has no falsifiable mutant in a one-copy wire.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: [],
		build: () =>
			mint({
				receiptBeforeSign: (r) => ({ ...r, data: structuredClone(r.event.data) }),
			}),
	},
	// ── Which step owns the `spec`/`scope` LITERALS ─────────────────────────
	// STEP 1 owns the receipt's, because CLI spec §5 binds step 1 to "§5 shape"
	// and receipt-spec §5's wire format pins `"spec": "ut1"` and
	// `"scope": "session"`. STEP 7 owns the projection's, because §2's
	// enumerated constraints are step 7's binding. EQUALITY 7 (step 2) owns only
	// the AGREEMENT between the two — and step 2 runs before step 7, which is
	// what makes `eq7/projection-*-disagrees` reachable at all.
	//
	// Both vectors below break the literals on BOTH sides, so the two agree and
	// equality 7 sees nothing. Without a literal pin at step 1 a document
	// declaring itself a DIFFERENT FORMAT sails through every remaining check
	// and is verified under ut1 rules — the corpus has to be able to fail a
	// verifier that pins neither.
	{
		name: "schema/spec-literal-not-ut1",
		what: "§5 pins `spec` to the literal `ut1`: a `ut2` document AGREES with its own projection, so only step 1's literal pin rejects it.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: [],
		build: () =>
			mint({
				projection: projectionPatch((p) => (p.spec = "ut2")),
				receiptBeforeSign: (r) => ({ ...r, spec: "ut2" }),
			}),
	},
	{
		name: "schema/scope-literal-not-session",
		what: '§2 reserves `"call"` for ut2 SDK minting, so it is not a legal ut1 `scope` on EITHER side — and both sides carrying it agrees.',
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: [],
		build: () =>
			mint({
				projection: projectionPatch((p) => (p.scope = "call")),
				receiptBeforeSign: (r) => ({ ...r, scope: "call" }),
			}),
	},
	{
		name: "schema/signature-alg-not-ed25519",
		what: "`alg` is the literal `ed25519`; anything else is a schema failure before any crypto runs.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: [],
		build: () =>
			mint({
				receiptAfterSign: (r) => ({
					...r,
					signature: { ...(r.signature as Record<string, unknown>), alg: "ed448" },
				}),
			}),
	},
	{
		name: "schema/signature-wrong-length",
		what: "`sig` is exactly 64 bytes; a 63-byte signature is a schema failure, not a verification failure.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: ["receiptSignature"],
		build: () =>
			mint({
				receiptAfterSign: (r) => {
					const signature = r.signature as Record<string, unknown>;
					const raw = Buffer.from(String(signature.sig), "base64").subarray(0, 63);
					return { ...r, signature: { ...signature, sig: raw.toString("base64") } };
				},
			}),
	},
	{
		name: "schema/signature-key-id-differs-from-minter",
		what: "§5 binds `signature.keyId === minter.keyId`; two different keyIds is a schema failure.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: ["receiptSignature"],
		build: () =>
			mint({
				receiptAfterSign: (r) => ({
					...r,
					signature: {
						...(r.signature as Record<string, unknown>),
						keyId: MINT_KEY_SUCCESSOR.keyId,
					},
				}),
			}),
	},
	{
		name: "schema/receipt-id-decodes-short",
		what: "§12: the character count is NOT the rule — this ID matches the grammar and decodes to 15 bytes.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: [],
		build: () => mint({ receiptId: SHORT_DECODE_RECEIPT_ID }),
	},
	{
		// NOT a rule-2 vector, whatever the leading `1` suggests: it re-encodes
		// byte-identically. Rule 2 is unfalsifiable against a conformant codec and
		// the corpus records that instead of faking coverage — see harness.test.ts
		// "records §12's rule 2 as UNFALSIFIABLE".
		name: "schema/receipt-id-decodes-long",
		what: "§12 rule 1: an extra leading `1` still matches the grammar and decodes to 17 bytes — the padded shape, caught by the LENGTH rule.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: [],
		build: () => mint({ receiptId: LONG_DECODE_RECEIPT_ID }),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// C. Step 2 — the event hash and §4's nine equalities.
// ─────────────────────────────────────────────────────────────────────────────

export const EVENT_VECTORS: readonly Vector[] = [
	{
		name: "event/hash-does-not-recompute",
		what: "A field edited AFTER hashing leaves `hash` self-consistent with the proof but wrong for the envelope.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eventHash"],
		build: () => mint({ eventAfterHash: (e) => ({ ...e, timestamp: "2026-08-11T18:42:14.007Z" }) }),
	},
	{
		name: "eq1/mint-event-hash-differs",
		what: "Equality 1: `proof.mintEventHash` must equal `event.hash`.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq1"],
		build: () =>
			mint({
				receiptBeforeSign: (r) => ({
					...r,
					proof: { ...r.proof, mintEventHash: otherHash("mint-event-hash") },
				}),
			}),
	},
	{
		name: "eq1/proof-covers-another-leaf",
		what: "A perfectly valid inclusion proof — of a DIFFERENT leaf. Only equality 1 catches it.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq1"],
		build: () => mint({ mintLeaf: () => otherHash("substituted-leaf") }),
	},
	{
		name: "eq2/event-kind",
		what: "Equality 2: the mint event's kind is the snake_case chain literal `receipt_settled` (§14).",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq2"],
		build: () => mint({ event: (e) => ({ ...e, kind: "llm_call" }) }),
	},
	{
		name: "eq2/actor-extra-field",
		what: "Equality 2 is CANONICAL equality against the registered mintActor — an extra actor field breaks it.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq2"],
		build: () =>
			mint({
				event: (e) => ({
					...e,
					actor: { type: "system", id: "receipt-minter", name: "receipt-minter", tenant: "acme" },
				}),
			}),
	},
	{
		name: "eq4/sequence-shifted",
		what: "Equality 4: leafIndex === event.sequence − checkpoint.segmentFirstSequence (segment-relative).",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq4"],
		build: () => mint({ event: (e) => ({ ...e, sequence: e.sequence + 1 }) }),
	},
	{
		name: "eq4/leaf-index-out-of-range",
		what: "Equality 4's second half: 0 ≤ leafIndex < treeSize. Step 2 owns it; step 5 must not pre-empt.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq4", "inclusionProof"],
		build: () => mint({ inclusion: (p) => ({ ...p, leafIndex: 7 }) }),
	},
	{
		name: "eq5/tree-size-differs",
		// Measured, not assumed: (leafIndex 3, treeSize 7) and (leafIndex 3,
		// treeSize 8) derive the SAME three-sibling topology, so the fold still
		// reaches the root and equality 5 is the only thing standing between a
		// verifier and a hidden eighth leaf.
		what: "Equality 5: `inclusion.treeSize === checkpoint.treeSize` — a leaf-hiding defence the fold cannot catch.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq5"],
		build: () => mint({ inclusion: (p) => ({ ...p, treeSize: p.treeSize + 1 }) }),
	},
	{
		name: "eq6/root-differs",
		what: "Equality 6: `inclusion.root === checkpoint.root`.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq6", "inclusionProof"],
		build: () => mint({ inclusion: (p) => ({ ...p, root: otherHash("inclusion-root") }) }),
	},
	// Equality 7 is falsifiable ONLY from the projection side, and the reason is
	// worth stating because the obvious vector is the wrong one. `spec` and
	// `scope` each have exactly ONE legal ut1 value (§5's `"ut1"`/`"session"`;
	// §2 reserves `"call"` for ut2), so any disagreement means one side is
	// illegal — there is no legal-but-different value to reach for. Break the
	// RECEIPT's copy and step 1's §5-shape pin fires first, as
	// `schema/spec-literal-not-ut1` requires it to; the vector would then be
	// asserting EVENT_MISMATCH against a reader that correctly says
	// SCHEMA_INVALID, and the corpus would be pushing the reader to leave the
	// literal open. Break the PROJECTION's copy and step 2 reaches equality 7
	// before step 7 gets to §2's constraints. That ordering is the assertion.
	{
		name: "eq7/projection-spec-disagrees",
		what: "Equality 7, `spec` half: the PROJECTION says `ut2` while the receipt says `ut1` — step 2 catches the disagreement before step 7 sees §2's constraint.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq7"],
		build: () => mint({ projection: projectionPatch((p) => (p.spec = "ut2")) }),
	},
	{
		name: "eq7/projection-scope-disagrees",
		what: "Equality 7, `scope` half: the PROJECTION says `call` while the receipt says `session` — the receipt's own literal stays legal, so step 1 cannot pre-empt.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq7"],
		build: () => mint({ projection: projectionPatch((p) => (p.scope = "call")) }),
	},
	{
		name: "eq8/inclusion-segment-id",
		what: "Equality 8: `inclusion.segmentId === checkpoint.segmentId` — the per-segment tree binding.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq8"],
		build: () => mint({ inclusion: (p) => ({ ...p, segmentId: "seg_000002" }) }),
	},
	{
		name: "eq8/checkpoint-vault-id",
		what: "Equality 8 reads vaultId out of the CHECKPOINT's own SIGNED payload — a valid signature over a lie.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq8"],
		build: () =>
			mint({
				checkpointsUnsigned: (checkpoints) =>
					checkpoints.map((c, i) => (i === 2 ? { ...c, vaultId: "vlt_other_chain" } : c)),
			}),
	},
	{
		name: "eq8/checkpoint-profile",
		what: "Equality 8: `checkpoint.profile === proof.profile`, both signed, both read before the registry.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq8"],
		build: () =>
			mint({
				checkpointsUnsigned: (checkpoints) =>
					checkpoints.map((c, i) => (i === 2 ? { ...c, profile: "ut-chain-v1" } : c)),
			}),
	},
	{
		name: "eq8/proof-profile-unregistered",
		what: "Equality 8's registry half: `proof.profile` must match the §8 chains[] entry's profile.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq8"],
		build: () =>
			mint({
				receiptBeforeSign: (r) => ({ ...r, proof: { ...r.proof, profile: "ut-chain-v1" } }),
			}),
	},
	{
		name: "eq9/work-mirror-differs",
		what: "Equality 9: a conflicting top-level `work` renders as chain-attested when only the signature covers it.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq9"],
		build: () =>
			mint({
				receiptBeforeSign: (r) => ({
					...r,
					work: { ...(r.work as Record<string, unknown>), oid: "0".repeat(40) },
				}),
			}),
	},
	{
		name: "eq9/work-mirror-absent",
		what: "§4 eq 9 explicitly owns the ABSENT mirror: EVENT_MISMATCH, not step 1's SCHEMA_INVALID.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: ["eq9"],
		build: () =>
			mint({
				receiptBeforeSign: (r) => {
					const { work: _dropped, ...rest } = r;
					return { ...rest };
				},
			}),
	},
	{
		name: "eq2/registered-mint-actor-form",
		what: "Equality 2 compares against the chain's REGISTERED mintActor form; the string form is not ut1's.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					(s.chains[0] as { mintActor: unknown }).mintActor = "receipt-minter";
				}),
			}),
	},
	{
		name: "eq8/chain-profile-mismatch-in-snapshot",
		what: "Equality 8's registry cross-check fails when the registered chain profile is not proxy-v1.",
		mode: "receipt",
		expect: failed("event", "EVENT_MISMATCH"),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					(s.chains[0] as { profile: string }).profile = "ut-chain-v1";
				}),
			}),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// D. Step 3(a) — arrival context.
// ─────────────────────────────────────────────────────────────────────────────

export const ARRIVAL_VECTORS: readonly Vector[] = [
	{
		name: "arrival/id-mismatch",
		what: "Step 3(a): the document's receiptId must equal the ID it ARRIVED under.",
		mode: "receipt",
		expect: failed("registry", "ID_MISMATCH"),
		breaks: [],
		expectId: ALT_RECEIPT_ID,
		build: () => mint(),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// E. Step 4 — the mint signature and its FULL authority binding.
// ─────────────────────────────────────────────────────────────────────────────

export const SIGNATURE_VECTORS: readonly Vector[] = [
	{
		name: "signature/tampered-after-signing",
		what: "An edit to a signed field is caught by the signature, not by a field comparison.",
		mode: "receipt",
		expect: failed("signature", "SIG_INVALID"),
		breaks: ["receiptSignature"],
		build: () =>
			mint({ receiptAfterSign: (r) => ({ ...r, mintedAt: "2026-08-11T18:42:20.115Z" }) }),
	},
	{
		name: "signature/foreign-signer",
		what: "The claimed keyId is registered and the bytes are intact — only the signer is wrong.",
		mode: "receipt",
		expect: failed("signature", "SIG_INVALID"),
		breaks: ["receiptSignature"],
		build: () =>
			mint({
				receiptAfterSign: (r) => ({
					...r,
					signature: {
						...(r.signature as Record<string, unknown>),
						sig: signEd25519(FOREIGN_KEY, receiptSignaturePreimage(r)),
					},
				}),
			}),
	},
	{
		name: "signature/key-absent-from-snapshot",
		what: "An unresolvable mint key is MISSING MATERIAL — UNVERIFIABLE, never a negative answer.",
		mode: "receipt",
		expect: unverifiable("trustKey"),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					s.keys = s.keys.filter((k) => k.keyId !== MINT_KEY.keyId);
				}),
			}),
	},
	{
		name: "signature/key-revoked",
		what: "The deliberate edge: material is PRESENT and state forbids ⇒ FAILED, not UNVERIFIABLE. Revoked verifies NOTHING.",
		mode: "receipt",
		expect: failed("signature", "SIG_INVALID"),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					keyEntry(s, MINT_KEY.keyId).state = "revoked";
				}),
			}),
	},
	{
		name: "signature/retired-mint-key-out-of-bounds",
		what: "The attack rotation exists to bound: a retired MINT key signing material at/after its boundary. `state permitting` alone accepts this.",
		mode: "receipt",
		expect: failed("signature", "SIG_INVALID"),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					const key = keyEntry(s, MINT_KEY.keyId);
					key.state = "retired";
					// Boundary is EXCLUSIVE: segmentFirstSequence (11) < activationSequence (11) is false.
					key.activationSequence = 11;
					s.keys.push({
						keyId: MINT_KEY_SUCCESSOR.keyId,
						alg: "ed25519",
						publicKey: MINT_KEY_SUCCESSOR.publicKeyPem,
						role: "mint",
						minterKind: "proxy",
						predecessorKeyId: MINT_KEY.keyId,
						state: "active",
					});
					(s.chains[0] as { mintKeyIds: string[] }).mintKeyIds.push(MINT_KEY_SUCCESSOR.keyId);
				}),
			}),
	},
	{
		name: "signature/key-wrong-role",
		what: "A role-`checkpoint` key cannot mint. The snapshot stays self-consistent — this is receipt-relative, not structural.",
		mode: "receipt",
		expect: failed("signature", "SIG_INVALID"),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					const key = keyEntry(s, MINT_KEY.keyId);
					key.role = "checkpoint";
					delete key.minterKind;
					(s.chains[0] as { mintKeyIds: string[] }).mintKeyIds = [];
				}),
			}),
	},
	{
		name: "signature/key-not-in-mint-key-ids",
		what: "Per-chain authority (R3-2): a domain-wide mint key confers NO authority over a chain that does not list it.",
		mode: "receipt",
		expect: failed("signature", "SIG_INVALID"),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					s.keys.push({
						keyId: MINT_KEY_SUCCESSOR.keyId,
						alg: "ed25519",
						publicKey: MINT_KEY_SUCCESSOR.publicKeyPem,
						role: "mint",
						minterKind: "proxy",
						state: "active",
					});
					(s.chains[0] as { mintKeyIds: string[] }).mintKeyIds = [MINT_KEY_SUCCESSOR.keyId];
				}),
			}),
	},
	{
		name: "signature/minter-kind-mismatch",
		what: "`minter.kind` disagreeing with the key's registered minterKind is step 4's, NOT equality 7's — one condition, one code.",
		mode: "receipt",
		expect: failed("signature", "SIG_INVALID"),
		breaks: [],
		build: () =>
			mint({
				receiptBeforeSign: (r) => ({ ...r, minter: { ...r.minter, kind: "sdk" } }),
			}),
	},
	{
		name: "signature/trust-domain-not-pinned-literal",
		what: "§8's v1 pin: `minter.trustDomain` is the literal `usertrust.ai`; offline there is nothing else to check it against.",
		mode: "receipt",
		expect: failed("signature", "SIG_INVALID"),
		breaks: [],
		build: () =>
			mint({
				receiptBeforeSign: (r) => ({
					...r,
					minter: { ...r.minter, trustDomain: "usertrust.ai.evil.example" },
				}),
			}),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// F. Step 5 — the inclusion path.
// ─────────────────────────────────────────────────────────────────────────────

export const INCLUSION_VECTORS: readonly Vector[] = [
	{
		name: "inclusion/sibling-hash-tampered",
		what: "The fold no longer reaches the signed root.",
		mode: "receipt",
		expect: failed("inclusion", "PROOF_INVALID"),
		breaks: ["inclusionProof"],
		build: () =>
			mint({
				inclusion: (p) => ({
					...p,
					siblings: p.siblings.map((s, i) =>
						i === 0 ? { ...s, hash: otherHash("sibling-0") } : s,
					),
				}),
			}),
	},
	{
		name: "inclusion/sibling-position-flipped",
		what: "Topology is DERIVED from (leafIndex, treeSize): folding the siblings as given is non-conformant (R3-3).",
		mode: "receipt",
		expect: failed("inclusion", "PROOF_INVALID"),
		breaks: ["inclusionProof"],
		build: () =>
			mint({
				inclusion: (p) => ({
					...p,
					siblings: p.siblings.map((s, i) =>
						i === 0 ? { ...s, position: s.position === "left" ? "right" : "left" } : s,
					),
				}),
			}),
	},
	{
		name: "inclusion/extra-sibling",
		what: "A path longer than the derived one is rejected on LENGTH, before any hashing.",
		mode: "receipt",
		expect: failed("inclusion", "PROOF_INVALID"),
		breaks: ["inclusionProof"],
		build: () =>
			mint({
				inclusion: (p) => ({
					...p,
					siblings: [...p.siblings, { hash: otherHash("extra-sibling"), position: "right" }],
				}),
			}),
	},
	{
		name: "inclusion/proof-member-absent",
		what: "An absent `proof` is missing REQUIRED material (§7) — UNVERIFIABLE, and nothing is `failed`.",
		mode: "receipt",
		expect: unverifiable("proof"),
		breaks: [],
		build: () =>
			mint({
				receiptBeforeSign: (r) => {
					const { proof: _dropped, ...rest } = r;
					return { ...rest };
				},
			}),
	},
	{
		name: "inclusion/checkpoint-member-absent",
		what: "An absent `checkpoint` is missing REQUIRED material — UNVERIFIABLE.",
		mode: "receipt",
		expect: unverifiable("checkpoint"),
		breaks: [],
		build: () =>
			mint({
				receiptBeforeSign: (r) => {
					const { checkpoint: _dropped, ...proof } = r.proof;
					return { ...r, proof };
				},
			}),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// G. Step 6 — the checkpoint.
// ─────────────────────────────────────────────────────────────────────────────

export const CHECKPOINT_VECTORS: readonly Vector[] = [
	{
		name: "checkpoint/v1-statement",
		what: "A v1 PublishedMerkleRoot in a receipt is FAIL: its root-only signature leaves treeSize and the lineage edge unauthenticated.",
		mode: "receipt",
		expect: failed("checkpoint", "CHECKPOINT_INVALID"),
		breaks: [],
		build: () =>
			mint({ checkpointsUnsigned: (checkpoints) => checkpoints.map((c) => ({ ...c, v: 1 })) }),
	},
	{
		// The mutant `v === 2` alone cannot see. Nothing here is broken
		// cryptographically — the reduced payload is re-signed by the real
		// checkpoint key and every signature verifies — but the statement is no
		// longer §4a's, and the member it is missing is exactly the lineage edge
		// v2 was introduced to authenticate ("rewritable while every signature
		// verified"). A verifier that gates only on the version label accepts it.
		name: "checkpoint/v2-lineage-member-stripped",
		what: "§4a fixes the v2 signed payload's MEMBERS: a checkpoint stripped of previousSegmentRoot and re-signed is not a v2 statement.",
		mode: "receipt",
		expect: failed("checkpoint", "CHECKPOINT_INVALID"),
		breaks: [],
		build: () =>
			mint({
				checkpointsUnsigned: (checkpoints) =>
					checkpoints.map((c) => {
						const { previousSegmentRoot: _dropped, ...rest } = c;
						return rest as typeof c;
					}),
			}),
	},
	{
		// The same hole worn the other way round: a v1 `PublishedMerkleRoot`'s
		// member subset, relabelled `v: 2` and signed. §4a says v1 objects never
		// appear in receipts; a version label an attacker writes is not what
		// keeps them out.
		name: "checkpoint/v1-shaped-payload-relabelled-v2",
		what: "A v1 PublishedMerkleRoot member subset re-signed under `v: 2` is still not a v2 statement — the label is not the payload.",
		mode: "receipt",
		expect: failed("checkpoint", "CHECKPOINT_INVALID"),
		breaks: [],
		build: () =>
			mint({
				checkpointsUnsigned: (checkpoints) =>
					checkpoints.map(
						(c) =>
							({
								v: 2,
								vaultId: c.vaultId,
								profile: c.profile,
								root: c.root,
								treeSize: c.treeSize,
								segmentId: c.segmentId,
								segmentFirstSequence: c.segmentFirstSequence,
								keyId: c.keyId,
							}) as typeof c,
					),
			}),
	},
	{
		// Nothing OUTSIDE §4a's member list either — an extra member changes the
		// canonical preimage, so a signature over it commits unspecified content.
		// INSIDE the receipt step 1 owns this (§5's unknown-field rule, and CLI
		// spec §5: the earlier step's code wins), which is what this vector pins.
		// The step-6 half of the same rule exists for step 9's history
		// checkpoints, which never pass through step 1 — asserted directly
		// against `verifyCheckpointStatement` in `steps.test.ts`.
		name: "checkpoint/extra-signed-member",
		what: "An extra member in the embedded checkpoint is an unknown field in the signed receipt: step 1 owns it, not step 6.",
		mode: "receipt",
		expect: failed("schema", "SCHEMA_INVALID"),
		breaks: [],
		build: () =>
			mint({
				checkpointsUnsigned: (checkpoints) =>
					checkpoints.map((c) => ({ ...c, publishedTo: "https://rekor.example/1" }) as typeof c),
			}),
	},
	{
		name: "checkpoint/signature-tampered",
		what: "The checkpoint signature covers the whole unsigned payload (§4a) with NO domain prefix.",
		mode: "receipt",
		expect: failed("checkpoint", "CHECKPOINT_INVALID"),
		breaks: ["checkpointSignature"],
		build: () =>
			mint({
				checkpointsAfterSign: (checkpoints) =>
					checkpoints.map((c, i) => (i === 2 ? { ...c, sig: corruptBase64(c.sig) } : c)),
			}),
	},
	{
		name: "checkpoint/foreign-signer",
		what: "A checkpoint signed by a key the snapshot never saw, while naming a key it did.",
		mode: "receipt",
		expect: failed("checkpoint", "CHECKPOINT_INVALID"),
		breaks: ["checkpointSignature"],
		build: () =>
			mint({
				checkpointsAfterSign: (checkpoints) =>
					checkpoints.map((c, i) => (i === 2 ? resign(c, FOREIGN_KEY) : c)),
			}),
	},
	{
		name: "checkpoint/key-unresolvable",
		what: "An unresolvable checkpoint key is missing trust material — UNVERIFIABLE, not CHECKPOINT_INVALID.",
		mode: "receipt",
		expect: unverifiable("trustKey"),
		breaks: [],
		build: () =>
			mint({
				checkpointsUnsigned: (checkpoints) =>
					checkpoints.map((c, i) => (i === 2 ? { ...c, keyId: "utk_never_registered" } : c)),
			}),
	},
	{
		name: "checkpoint/key-revoked",
		what: "A revoked checkpoint key verifies NOTHING, past or present.",
		mode: "receipt",
		expect: failed("checkpoint", "CHECKPOINT_INVALID"),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					keyEntry(s, CHECKPOINT_KEY.keyId).state = "revoked";
				}),
			}),
	},
	{
		name: "checkpoint/retired-key-out-of-bounds",
		what: "§8's offline retirement boundary: a retired key signing at/after its successor's activation FAILS at step 6.",
		mode: "receipt",
		expect: failed("checkpoint", "CHECKPOINT_INVALID"),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					const key = keyEntry(s, CHECKPOINT_KEY.keyId);
					key.state = "retired";
					key.activationSequence = 11;
					s.keys.push({
						keyId: CHECKPOINT_KEY_SUCCESSOR.keyId,
						alg: "ed25519",
						publicKey: CHECKPOINT_KEY_SUCCESSOR.publicKeyPem,
						role: "checkpoint",
						predecessorKeyId: CHECKPOINT_KEY.keyId,
						state: "active",
					});
				}),
			}),
	},
	{
		name: "checkpoint/key-outside-pinned-lineage",
		what: "A domain-wide role-`checkpoint` key confers NO authority over a chain whose checkpointRootKeyId pins another lineage.",
		mode: "receipt",
		expect: failed("checkpoint", "CHECKPOINT_INVALID"),
		breaks: [],
		build: () =>
			mint({
				checkpointSigner: (index) => (index === 2 ? CHECKPOINT_KEY_SUCCESSOR : CHECKPOINT_KEY),
				snapshot: snapshotPatch((s) => {
					// Registered, active, right role — and in NO lineage with the pinned root key.
					s.keys.push({
						keyId: CHECKPOINT_KEY_SUCCESSOR.keyId,
						alg: "ed25519",
						publicKey: CHECKPOINT_KEY_SUCCESSOR.publicKeyPem,
						role: "checkpoint",
						state: "active",
					});
				}),
			}),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// H. Step 7 — §2's EXHAUSTIVE semantic constraints.
// ─────────────────────────────────────────────────────────────────────────────

function semantic(name: string, what: string, patch: (p: Projection) => void): Vector {
	return {
		name,
		what,
		mode: "receipt",
		expect: failed("semantics", "SEMANTIC_INVALID"),
		breaks: [],
		build: () => mint({ projection: projectionPatch(patch) }),
	};
}

export const SEMANTIC_VECTORS: readonly Vector[] = [
	semantic("semantics/models-unsorted", "models[] is sorted-unique ASCII-lexicographic.", (p) => {
		p.models = ["claude-sonnet-4-5", "claude-opus-4-5"];
	}),
	semantic("semantics/models-duplicate", "models[] entries are UNIQUE after sorting.", (p) => {
		p.models = ["claude-opus-4-5", "claude-opus-4-5"];
	}),
	semantic(
		"semantics/pricing-versions-unsorted",
		"pricing.tableVersions carries the same sorted-unique rule.",
		(p) => {
			p.pricing = { tableVersions: ["2026-08-01", "2026-07-01"] };
		},
	),
	semantic(
		"semantics/posted-differs-from-assessed",
		"ut1 removes the shortfall branch: posted !== assessed is rejected outright (P1-4).",
		(p) => {
			spend(p).postedUsertokens = 48000;
		},
	),
	semantic("semantics/zero-spend", "`0 < postedUsertokens === assessedUsertokens`.", (p) => {
		spend(p).postedUsertokens = 0;
		spend(p).assessedUsertokens = 0;
	}),
	semantic(
		"semantics/rounding-adjustment-above-transfer-count",
		"The algebraic bound: per-transfer rounding adds at most ONE usertoken per transfer.",
		(p) => {
			spend(p).roundingAdjustment = 23;
		},
	),
	semantic(
		"semantics/rounding-adjustment-negative",
		"Per-transfer minimum charging can only round UP, so the adjustment is non-negative.",
		(p) => {
			spend(p).roundingAdjustment = -1;
		},
	),
	semantic(
		"semantics/usage-posture-not-an-enum-value",
		"Postures are ATTESTED ENUMS: the verifier checks validity, never re-derives them.",
		(p) => {
			spend(p).usagePosture = "guessed";
		},
	),
	semantic("semantics/pricing-posture-invalid", "pricingPosture ∈ {exact, conservative}.", (p) => {
		spend(p).pricingPosture = "optimistic";
	}),
	semantic(
		"semantics/transfer-set-present-above-32",
		"§2's presence RULE: transferSet is ABSENT iff transferCount > 32.",
		(p) => {
			spend(p).transferCount = 37;
			const pairs = transferPairs(37);
			p.transferSet = pairs;
			p.transferSetRoot = transferSetRoot(pairs);
		},
	),
	semantic(
		"semantics/transfer-set-absent-below-32",
		"…and PRESENT iff transferCount ≤ 32. Omitting it at 22 pairs is equally a failure.",
		(p) => {
			delete p.transferSet;
		},
	),
	semantic(
		"semantics/duplicate-transfer-id",
		"No transfer ID repeats anywhere in the list, in either position.",
		(p) => {
			const pairs = transferPairs(22);
			const first = pairs[0] as { authorizationTransferId: string };
			(pairs[1] as { authorizationTransferId: string }).authorizationTransferId =
				first.authorizationTransferId;
			p.transferSet = pairs;
			// Recomputed, so this vector fails at step 7 and NOT at step 8.
			p.transferSetRoot = transferSetRoot(pairs);
		},
	),
	semantic(
		"semantics/workload-id-with-owner-asserted",
		"workloadId is present IFF sessionAssociation === workflowAttested.",
		(p) => {
			p.sessionAssociation = "ownerAsserted";
		},
	),
	semantic(
		"semantics/workload-id-absent-with-attested",
		"…and attested-without-present is equally a failure.",
		(p) => {
			delete p.workloadId;
		},
	),
	semantic(
		"semantics/prev-generation-hash-at-generation-1",
		"prevGenerationEventHash is present IFF generation > 1 — the OFFLINE half of generation linkage.",
		(p) => {
			p.prevGenerationEventHash = otherHash("prev-generation");
		},
	),
	semantic(
		"semantics/proof-id-syntax",
		"Public-safety syntax: proofId matches [A-Za-z0-9._-]{1,128} — an opaque handle, never a description.",
		(p) => {
			(work(p).repositoryMembership as Record<string, unknown>).proofId = "cam@usertools.ai";
		},
	),
	semantic(
		"semantics/repo-too-long",
		"`repo` is ≤ 256 characters in canonical provider-URL form.",
		(p) => {
			work(p).repo = `github.com/usertools-ai/${"x".repeat(260)}`;
		},
	),
	semantic(
		// The half a length check cannot see, and the one that leaks: §2 makes a
		// receipt a PUBLIC document and puts `repo` under "no local paths", right
		// beside "Never present anywhere: … file paths, PII". A 39-character
		// absolute path is well under 256 and names a customer.
		"semantics/repo-local-path",
		"`repo` is the canonical <providerHost>/<owner>/<name> form and NOTHING else — a local filesystem path is not it.",
		(p) => {
			work(p).repo = "/Users/cam/private/customer-acme/secret";
		},
	),
	semantic(
		"semantics/repo-with-credentials",
		"…nor a remote string carrying credentials, which is the other form §2 names.",
		(p) => {
			work(p).repo = "https://cam:ghp_secret@github.com/usertools-ai/usertrust";
		},
	),
	semantic(
		"semantics/repo-with-branch-decoration",
		"…nor branch or worktree decoration: `<providerHost>/<owner>/<name>` is three parts, not five.",
		(p) => {
			work(p).repo = "github.com/usertools-ai/usertrust/tree/main";
		},
	),
	semantic(
		"semantics/delegation-posture-absent",
		"v0.9 §2a: the field is REQUIRED, so absence is a step-7 failure — the offline verifier has no page to carry a caveat.",
		(p) => {
			delete p.delegationPosture;
		},
	),
	semantic(
		"semantics/delegation-posture-unrecognized",
		"An unrecognized posture FAILS CLOSED rather than rendering a total whose coverage cannot be interpreted.",
		(p) => {
			p.delegationPosture = "includesEverything";
		},
	),
	semantic(
		"semantics/delegation-posture-includes-all-without-evidence",
		"§2a: the posture is a CLAIM THAT MUST BE VERIFIABLE. No signed evidence format exists, so this reports a failure, not a total.",
		(p) => {
			p.delegationPosture = "includesAllDelegated";
		},
	),
	{
		name: "semantics/prev-generation-hash-absent-at-generation-2",
		what: "An addendum without its predecessor hash breaks the offline half of generation linkage.",
		mode: "receipt",
		expect: failed("semantics", "SEMANTIC_INVALID"),
		breaks: [],
		build: () =>
			mint({
				projectionOptions: { generation: 2 },
				projection: projectionPatch((p) => {
					delete p.prevGenerationEventHash;
				}),
			}),
	},
	{
		name: "semantics/transfer-set-length-mismatch",
		what: "transferSet.length === transferCount. Step 7 owns it even though the root also stops matching — first failure wins.",
		mode: "receipt",
		expect: failed("semantics", "SEMANTIC_INVALID"),
		breaks: ["transferSetRoot"],
		build: () =>
			mint({
				projection: projectionPatch((p) => {
					p.transferSet = transferPairs(22).slice(0, 21);
				}),
			}),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// I. Step 8 — the one derivation the receipt can carry.
// ─────────────────────────────────────────────────────────────────────────────

export const DERIVATION_VECTORS: readonly Vector[] = [
	{
		name: "derivations/transfer-set-root-mismatch",
		what: "transferSetRoot commits the ORDERED PAIR LIST as given — which is what makes chain order chain-committed.",
		mode: "receipt",
		expect: failed("derivations", "DERIVATION_MISMATCH"),
		breaks: ["transferSetRoot"],
		build: () =>
			mint({
				projection: projectionPatch((p) => {
					p.transferSetRoot = otherHash("transfer-set-root");
				}),
			}),
	},
	{
		name: "derivations/transfer-set-reordered",
		what: "Reordering the pairs without reissuing the root is exactly the tamper the commitment exists to catch.",
		mode: "receipt",
		expect: failed("derivations", "DERIVATION_MISMATCH"),
		breaks: ["transferSetRoot"],
		build: () =>
			mint({
				projection: projectionPatch((p) => {
					const pairs = transferPairs(22);
					p.transferSet = [pairs[1], pairs[0], ...pairs.slice(2)];
				}),
			}),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// J. §4 — trust-snapshot structure. Every violation is UNVERIFIABLE.
// ─────────────────────────────────────────────────────────────────────────────

function snapshotVector(name: string, what: string, patch: (s: TrustSnapshot) => void): Vector {
	return {
		name,
		what,
		mode: "receipt",
		expect: unverifiable("trustSnapshot"),
		breaks: [],
		build: () => mint({ snapshot: snapshotPatch(patch) }),
	};
}

export const SNAPSHOT_VECTORS: readonly Vector[] = [
	snapshotVector(
		"snapshot/duplicate-vault-id",
		"Duplicate/ambiguous vaultId registrations are rejected (§8) — otherwise resolution is array order.",
		(s) => {
			s.chains.push(structuredClone(s.chains[0]) as (typeof s.chains)[number]);
		},
	),
	snapshotVector(
		"snapshot/one-lineage-two-vaults",
		"One checkpoint lineage serves exactly ONE vault: a lineage trusted by two could sign statements attributable to either.",
		(s) => {
			const second = structuredClone(s.chains[0]) as (typeof s.chains)[number];
			second.vaultId = "vlt_ut_proxy_prod_2";
			second.genesisSegmentId = "seg_100001";
			second.headSegmentId = "seg_100001";
			s.chains.push(second);
		},
	),
	snapshotVector(
		"snapshot/duplicate-key-id",
		"keyIds are globally unique; a duplicate silently decides between an `active` and a `revoked` entry by insertion order.",
		(s) => {
			const shadow = structuredClone(keyEntry(s, MINT_KEY.keyId));
			shadow.state = "revoked";
			s.keys.push(shadow);
		},
	),
	snapshotVector(
		"snapshot/role-kind-violation",
		"A keyId listed in mintKeyIds whose registered role is `checkpoint` makes the DOCUMENT invalid (§8's role separation).",
		(s) => {
			s.keys.push({
				keyId: "utk_confused",
				alg: "ed25519",
				publicKey: MINT_KEY_SUCCESSOR.publicKeyPem,
				role: "checkpoint",
				state: "active",
			});
			(s.chains[0] as { mintKeyIds: string[] }).mintKeyIds.push("utk_confused");
		},
	),
	snapshotVector(
		"snapshot/shared-key-material",
		"Mint and checkpoint entries sharing key material collapses the role separation the two signatures rely on.",
		(s) => {
			keyEntry(s, CHECKPOINT_KEY.keyId).publicKey = MINT_KEY.publicKeyPem;
		},
	),
	snapshotVector(
		"snapshot/cyclic-lineage",
		"A rotation lineage is ACYCLIC; an undeclared cycle is a non-terminating walk at step 6.",
		(s) => {
			keyEntry(s, MINT_KEY.keyId).predecessorKeyId = MINT_KEY_SUCCESSOR.keyId;
			s.keys.push({
				keyId: MINT_KEY_SUCCESSOR.keyId,
				alg: "ed25519",
				publicKey: MINT_KEY_SUCCESSOR.publicKeyPem,
				role: "mint",
				minterKind: "proxy",
				predecessorKeyId: MINT_KEY.keyId,
				state: "active",
			});
		},
	),
	snapshotVector(
		"snapshot/predecessor-declared-twice",
		"Each rotation link is declared ONCE; two keys naming one predecessor is a forked lineage.",
		(s) => {
			s.keys.push(
				{
					keyId: MINT_KEY_SUCCESSOR.keyId,
					alg: "ed25519",
					publicKey: MINT_KEY_SUCCESSOR.publicKeyPem,
					role: "mint",
					minterKind: "proxy",
					predecessorKeyId: MINT_KEY.keyId,
					state: "active",
				},
				{
					keyId: "utk_mint_2026_10",
					alg: "ed25519",
					publicKey: FOREIGN_KEY.publicKeyPem,
					role: "mint",
					minterKind: "proxy",
					predecessorKeyId: MINT_KEY.keyId,
					state: "active",
				},
			);
		},
	),
	snapshotVector(
		"snapshot/unresolvable-predecessor",
		"A predecessorKeyId naming a key absent from the snapshot leaves the lineage unwalkable.",
		(s) => {
			keyEntry(s, CHECKPOINT_KEY.keyId).predecessorKeyId = "utk_ghost";
		},
	),
	snapshotVector(
		"snapshot/unresolvable-checkpoint-root",
		"checkpointRootKeyId must name a key in keys[]; otherwise the pinned lineage is empty.",
		(s) => {
			(s.chains[0] as { checkpointRootKeyId: string }).checkpointRootKeyId = "utk_ghost";
		},
	),
	snapshotVector(
		"snapshot/cross-role-predecessor",
		"A lineage is a walk WITHIN one role: a mint key whose predecessor is a checkpoint key invalidates the document.",
		(s) => {
			keyEntry(s, MINT_KEY.keyId).predecessorKeyId = CHECKPOINT_KEY.keyId;
		},
	),
	snapshotVector(
		"snapshot/activation-sequence-on-active-key",
		"An `active` key has no successor and therefore no boundary; carrying one is a contradiction.",
		(s) => {
			keyEntry(s, CHECKPOINT_KEY.keyId).activationSequence = 18;
		},
	),
	snapshotVector(
		"snapshot/activation-sequence-missing-on-retired-key",
		"A `retired` key without activationSequence has an UNEVALUABLE boundary — the deciding comparison is gone.",
		(s) => {
			keyEntry(s, CHECKPOINT_KEY.keyId).state = "retired";
		},
	),
	snapshotVector(
		"snapshot/public-key-unparseable",
		"A publicKey that does not parse is ambiguity, and ambiguity is UNVERIFIABLE.",
		(s) => {
			keyEntry(s, MINT_KEY.keyId).publicKey = "not-a-key";
		},
	),
	snapshotVector(
		"snapshot/public-key-non-canonical-base64",
		"Buffer.from(x,'base64') silently tolerates appended junk decoding to the same bytes — canonical base64 is checked FIRST.",
		(s) => {
			keyEntry(s, MINT_KEY.keyId).publicKey = `${MINT_KEY.publicKeySpkiBase64}=`;
		},
	),
	{
		name: "snapshot/duplicate-json-key",
		what: "The snapshot is parsed with TOP-LEVEL duplicate-key rejection even though unknown MEMBERS are tolerated.",
		mode: "receipt",
		expect: unverifiable("trustSnapshot"),
		breaks: [],
		build: () => mint({ snapshotBytes: (b) => injectAfterOpeningBrace(b, '"keys": [],') }),
	},
	{
		// The one that actually bites. v1 does NOT verify the snapshot's
		// signature (§8 leaves the scheme open), so CLI spec §4 is explicit that
		// "its STRUCTURAL rules are the only remaining defense" — there is no
		// second mechanism behind a missed duplicate the way the receipt has its
		// §5 signature.
		//
		// This entry declares the mint key `revoked` and then `active`.
		// `JSON.parse` silently resolves it to `active`, so a reader that dedupes
		// only top-level members verifies the receipt under a key the pinned
		// snapshot ALSO declares revoked, and prints VERIFIED. That is
		// accept-what-should-be-rejected on the trust root itself.
		name: "snapshot/duplicate-json-key-nested",
		what: '`"state":"revoked"` then `"state":"active"` INSIDE a keys[] entry: JSON.parse keeps `active`, and v1 has no snapshot signature behind the structural rules.',
		mode: "receipt",
		expect: unverifiable("trustSnapshot"),
		breaks: [],
		build: () =>
			mint({
				snapshotBytes: (b) =>
					replaceOnce(
						b,
						`"keyId": "${MINT_KEY.keyId}",`,
						`"state": "revoked",\n      "keyId": "${MINT_KEY.keyId}",`,
					),
			}),
	},
	{
		// `1e999` is grammatical JSON that PARSES to Infinity, and `canonicalize`
		// throws on Infinity. `mintActor` is the one snapshot value equality 2
		// canonicalizes, so without a value-level guard this vector does not
		// produce a verdict at all — it produces an uncaught exception, which the
		// CLI can only turn into exit 1 (FAILED: a real negative answer about the
		// receipt) for what §4 calls a structurally invalid snapshot (exit 2).
		// The snapshot is spliced at the BYTE level because no JSON writer can
		// emit this: `JSON.stringify(Infinity)` is `null`.
		name: "snapshot/non-finite-number",
		what: "A snapshot number that parses to Infinity is refused as a VALUE — canonicalize must never be the thing that decides a verdict by throwing.",
		mode: "receipt",
		expect: unverifiable("trustSnapshot"),
		breaks: [],
		build: () =>
			mint({
				snapshotBytes: (b) =>
					replaceOnce(b, '"mintActor": {', '"mintActor": 1e999,\n      "retiredActor": {'),
			}),
	},
	{
		name: "snapshot/unreadable",
		what: "An unreadable --trust file is MISSING MATERIAL (exit 2), distinct from a MISSING --trust FLAG (exit 3).",
		mode: "receipt",
		expect: unverifiable("trustSnapshot"),
		breaks: [],
		build: () => mint({ snapshotBytes: () => Buffer.from("not json at all\n", "utf8") }),
	},
	{
		name: "snapshot/chain-not-registered",
		what: "`proof.chain` absent from the snapshot is an unresolvable key situation — UNVERIFIABLE.",
		mode: "receipt",
		expect: unverifiable("trustKey"),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					(s.chains[0] as { vaultId: string }).vaultId = "vlt_some_other_vault";
				}),
			}),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// K. Step 9 — the history walk. A failure NEVER demotes the base verdict.
// ─────────────────────────────────────────────────────────────────────────────

export const HISTORY_VECTORS: readonly Vector[] = [
	{
		name: "history/short-of-genesis",
		what: "The history's first checkpoint must be the REGISTERED genesis; a short history never earns the rung.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () => mint({ history: (h) => h.slice(1) }),
	},
	{
		name: "history/genesis-not-registered",
		what: "…and an over-claimed history fails the same way: the served root must equal chains[].genesisSegmentId.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () =>
			mint({
				snapshot: snapshotPatch((s) => {
					(s.chains[0] as { genesisSegmentId: string }).genesisSegmentId = "seg_000000";
				}),
			}),
	},
	{
		name: "history/broken-lineage-edge",
		what: "v2 SIGNS the lineage edge, so a rewritten previousSegmentRoot has to be re-signed — and still fails the walk.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () =>
			mint({
				checkpointsUnsigned: (checkpoints) =>
					checkpoints.map((c, i) =>
						i === 1 ? { ...c, previousSegmentRoot: otherHash("broken-edge") } : c,
					),
			}),
	},
	{
		name: "history/genesis-sentinel-wrong",
		what: "Genesis values are EXACT: the first checkpoint's previous* fields are the fixed string `genesis`.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () =>
			mint({
				checkpointsUnsigned: (checkpoints) =>
					checkpoints.map((c, i) => (i === 0 ? { ...c, previousSegmentId: "seg_000000" } : c)),
			}),
	},
	{
		name: "history/segment-first-sequence-gap",
		what: "Contiguity is arithmetic: next.segmentFirstSequence === prev.segmentFirstSequence + prev.treeSize.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () => mint({ segments: GAPPED_SEGMENTS }),
	},
	{
		name: "history/duplicate-segment-id",
		what: "Exactly ONE checkpoint per segmentId — the rule that makes prefix ROLLBACK detectable rather than merely unlikely.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () => mint({ history: (h) => [...h, structuredClone(h[1]) as SegmentCheckpoint] }),
	},
	{
		name: "history/embedded-checkpoint-absent",
		what: "The receipt's own checkpoint must appear in the supplied history.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () => mint({ history: (h) => h.slice(0, 2) }),
	},
	{
		name: "history/embedded-checkpoint-near-match",
		what: "EXACT equality, not segmentId matching: this variant is internally valid, validly signed, and differs in publishedAt.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () =>
			mint({
				history: (h) => {
					const last = h[h.length - 1] as SegmentCheckpoint;
					return [...h.slice(0, -1), resign({ ...last, publishedAt: "2026-08-14T00:00:00.000Z" })];
				},
			}),
	},
	{
		name: "history/unsigned-member",
		what: "EVERY checkpoint's signature verifies under the §8 lineage — an unsigned history must never upgrade.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () =>
			mint({
				checkpointsAfterSign: (checkpoints) =>
					checkpoints.map((c, i) => (i === 1 ? { ...c, sig: corruptBase64(c.sig) } : c)),
			}),
	},
	{
		name: "history/member-vault-id-differs",
		what: "Every checkpoint's vaultId equals proof.chain — they are SIGNED now, so a foreign member is detectable.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () =>
			mint({
				checkpointsUnsigned: (checkpoints) =>
					checkpoints.map((c, i) => (i === 1 ? { ...c, vaultId: "vlt_other_chain" } : c)),
			}),
	},
	{
		name: "history/member-profile-differs",
		what: "…and every checkpoint's profile equals proof.profile.",
		mode: "envelope",
		expect: historyFailed(),
		breaks: [],
		build: () =>
			mint({
				checkpointsUnsigned: (checkpoints) =>
					checkpoints.map((c, i) => (i === 1 ? { ...c, profile: "ut-chain-v1" } : c)),
			}),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// L. The resolver envelope (`--envelope`).
// ─────────────────────────────────────────────────────────────────────────────

export const ENVELOPE_VECTORS: readonly Vector[] = [
	{
		name: "envelope/receipt-copy-differs-from-bytes",
		what: "R4: `receiptBytes` is authority and `receipt` is a convenience copy. Verifying the copy verifies exactly what an attacker substitutes.",
		mode: "envelope",
		expect: { verdict: "FAILED", step: "envelope", exitCode: 1 },
		breaks: ["envelopeAgreement"],
		build: () =>
			mint({
				envelope: (e) => ({
					...e,
					receipt: {
						...(e.receipt as Record<string, unknown>),
						mintedAt: "2026-01-01T00:00:00.000Z",
					},
				}),
			}),
	},
	{
		name: "envelope/receipt-id-differs",
		what: "The envelope's own receiptId is compared against the DECODED receipt's — framing that lies about identity.",
		mode: "envelope",
		expect: { verdict: "FAILED", step: "envelope", exitCode: 1 },
		breaks: ["envelopeAgreement"],
		build: () => mint({ envelope: (e) => ({ ...e, receiptId: ALT_RECEIPT_ID }) }),
	},
	{
		name: "envelope/api-version-unsupported",
		what: "An unsupported apiVersion is a PROTOCOL error — the framing is unreadable, the material is not missing.",
		mode: "envelope",
		expect: { verdict: "FAILED", step: "envelope", exitCode: 1 },
		breaks: [],
		build: () => mint({ envelope: (e) => ({ ...e, apiVersion: "2" }) }),
	},
	{
		name: "envelope/non-receipt-status",
		what: "A 202/404/410 body carries no receipt: the caller handed the wrong document to the wrong mode — exit 3.",
		mode: "envelope",
		expect: { verdict: "USAGE_ERROR", exitCode: 3 },
		breaks: [],
		build: () =>
			mint({
				envelope: (e) => {
					const { receiptBytes: _bytes, receipt: _copy, checkpointHistory: _h, ...rest } = e;
					return { ...rest, status: "reserved" };
				},
			}),
	},
	{
		name: "envelope/receipt-bytes-absent",
		what: "A receipt-bearing status with no receiptBytes is MISSING MATERIAL, not a protocol error.",
		mode: "envelope",
		expect: unverifiable("receiptBytes"),
		breaks: [],
		build: () =>
			mint({
				envelope: (e) => {
					const { receiptBytes: _dropped, ...rest } = e;
					return rest;
				},
			}),
	},
	{
		name: "envelope/receipt-bytes-non-canonical-base64",
		what: "Canonical base64 is validated BEFORE any decode: permissive decoders tolerate junk that decodes to the same bytes.",
		mode: "envelope",
		expect: unverifiable("receiptBytes"),
		breaks: [],
		build: () => mint({ envelope: (e) => ({ ...e, receiptBytes: `${String(e.receiptBytes)} ` }) }),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// The corpus.
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_VECTORS: readonly Vector[] = [
	...PASS_VECTORS,
	...PARSE_VECTORS,
	...EVENT_VECTORS,
	...ARRIVAL_VECTORS,
	...SIGNATURE_VECTORS,
	...INCLUSION_VECTORS,
	...CHECKPOINT_VECTORS,
	...SEMANTIC_VECTORS,
	...DERIVATION_VECTORS,
	...SNAPSHOT_VECTORS,
	...HISTORY_VECTORS,
	...ENVELOPE_VECTORS,
];

export function vector(name: string): Vector {
	const found = ALL_VECTORS.find((v) => v.name === name);
	if (found === undefined) throw new Error(`fixtures: no vector named ${name}`);
	return found;
}
