// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The BINDING MATRIX — every value `packages/verify` reads from a receipt, its
 * proof, or the served checkpoint history, and what binds it.
 *
 * Boundary bindings were found missing one at a time: the first event's
 * `previousHash` against the signed `segmentStartPreviousHash`, the chain-link
 * leaf at leaf 1 against the signed `previousSegmentRoot`, a successor's signed
 * start hash against the final event it starts from — and then the chain link
 * again at leaf 2. Each was a value the receipt exposes and two signatures
 * authenticate, compared against nothing. So the rule is now general (every
 * proof node the receipt can recompute is compared), and this file states the
 * class instead of the instances: one row per value, each tampering ONLY that
 * value — re-hashing the event and re-signing the receipt and the checkpoint
 * wherever a signature would otherwise catch the tamper first — and naming the
 * step and code that must refuse it.
 *
 *  - BOUND rows must fail exactly as stated.
 *  - DECLARED rows must still VERIFY. The value is unbound by design, and the
 *    row says why, so a future binding has to change the row deliberately
 *    rather than slip in unnoticed — and an accidental one fails here.
 *  - NOT_APPLICABLE rows name a binding that exists only where this verifier
 *    is not: the registry, a store's published rows. They are listed with the
 *    reason and never run, so the matrix records them instead of dropping them.
 *
 * The completeness test at the end holds the matrix to the verifier's own
 * field table by EXACT path: a member added to the signed receipt fails it
 * until a row names it. The history rows cover each clause of step 9's walk;
 * a member's key rules are `verifyCheckpointStatement`'s, the same function as
 * step 6, so its checkpoint rows pin them once for both.
 */

import { describe, expect, it } from "vitest";
import {
	type FailureCode,
	type JsonValue,
	loadTrustSnapshot,
	type MissingWhat,
	type ReceiptReport,
	receiptFieldFormats,
	type StepName,
	verifyReceipt,
} from "../../src/receipt-verify.js";
import {
	ALT_RECEIPT_ID,
	CHECKPOINT_KEY,
	corruptBase64,
	DEFAULT_RECEIPT_ID,
	DEFAULT_SEGMENTS,
	FOREIGN_KEY,
	GAPPED_SEGMENTS,
	type HarnessKey,
	MINT_KEY,
	type MintOptions,
	mint,
	otherHash,
	type Projection,
	receiptSignaturePreimage,
	type SegmentCheckpoint,
	SHORT_DECODE_RECEIPT_ID,
	signEd25519,
	transferPairs,
	type UnsignedCheckpoint,
	type UnsignedReceipt,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// Rows.
// ─────────────────────────────────────────────────────────────────────────────

type Expected =
	| {
			readonly verdict: "FAILED";
			readonly step: StepName;
			readonly code: FailureCode;
			/** A substring the failure's detail must carry: WHICH check refused. */
			readonly detail?: string;
	  }
	| { readonly verdict: "UNVERIFIABLE"; readonly missing: MissingWhat }
	| { readonly verdict: "VERIFIED_CHECKPOINT" | "VERIFIED_CHECKPOINT_HISTORY" }
	| {
			/** Step 9 is upgrade-only: the base verdict stands and the walk fails. */
			readonly verdict: "VERIFIED_CHECKPOINT";
			readonly history: { readonly detail: string };
	  };

interface Row {
	readonly id: string;
	/** The value tampered, and nothing else. */
	readonly value: string;
	/** The signed or recomputed value that binds it (or, if DECLARED, why nothing does). */
	readonly boundTo: string;
	/** Field-table paths (or prefixes) whose value this row exercises. */
	readonly covers: readonly string[];
	/** Present ⇒ a DECLARED row: unbound on purpose, and it must still verify. */
	readonly declared?: string;
	readonly run: () => ReceiptReport;
	readonly expect: Expected;
}

interface NotApplicableRow {
	readonly id: string;
	readonly value: string;
	/** Where the binding lives, which is never here. */
	readonly boundTo: string;
	readonly reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Running a row.
// ─────────────────────────────────────────────────────────────────────────────

interface RunContext {
	/** Serve the bundle's `history` as the step-9 extension material. */
	readonly history?: boolean;
	/** The §12 id the receipt arrived under (step 3(a)). */
	readonly arrivalId?: string;
}

function verify(options: MintOptions = {}, context: RunContext = {}): ReceiptReport {
	const bundle = mint(options);
	const load = loadTrustSnapshot(bundle.snapshotBytes);
	if (!load.ok) throw new Error(`fixture snapshot did not load: ${load.detail}`);
	return verifyReceipt({
		receiptBytes: bundle.receiptBytes,
		snapshot: load.snapshot,
		...(context.arrivalId === undefined ? {} : { arrivalId: context.arrivalId }),
		...(context.history === true
			? {
					extensions: {
						checkpointHistory: JSON.parse(JSON.stringify(bundle.history)) as JsonValue,
					},
				}
			: {}),
	});
}

function failed(step: StepName, code: FailureCode, detail?: string): Expected {
	return detail === undefined
		? { verdict: "FAILED", step, code }
		: { verdict: "FAILED", step, code, detail };
}

const VERIFIED: Expected = { verdict: "VERIFIED_CHECKPOINT" };
const VERIFIED_HISTORY: Expected = { verdict: "VERIFIED_CHECKPOINT_HISTORY" };

function historyFailed(detail: string): Expected {
	return { verdict: "VERIFIED_CHECKPOINT", history: { detail } };
}

function assertOutcome(row: Row, report: ReceiptReport): void {
	const what = `${row.id}: ${row.value}`;
	const expected = row.expect;
	expect(report.verdict, what).toBe(expected.verdict);
	if (expected.verdict === "FAILED") {
		expect(report.failure, what).toMatchObject({ step: expected.step, code: expected.code });
		if (expected.detail !== undefined) {
			expect(report.failure?.detail, what).toContain(expected.detail);
		}
		return;
	}
	if (expected.verdict === "UNVERIFIABLE") {
		expect(report.missing?.what, what).toBe(expected.missing);
		return;
	}
	expect(report.failure, what).toBeNull();
	if ("history" in expected) {
		expect(report.checks.checkpointHistory, what).toMatchObject({
			result: "failed",
			failure: { code: "HISTORY_INVALID" },
		});
		expect(report.checks.checkpointHistory.failure?.detail, what).toContain(
			expected.history.detail,
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tamper helpers. Each re-hashes and re-signs what the tamper would otherwise
// break, so the ONLY wrong fact left is the value the row names.
// ─────────────────────────────────────────────────────────────────────────────

/** The mint segment's checkpoint (index 2 by default), re-signed by its key. */
function resignedCheckpoint(
	patch: (c: UnsignedCheckpoint) => UnsignedCheckpoint,
	segmentIndex = 2,
): Pick<MintOptions, "checkpointsUnsigned"> {
	return {
		checkpointsUnsigned: (checkpoints) =>
			checkpoints.map((c, i) => (i === segmentIndex ? patch(c) : c)),
	};
}

/** The receipt, edited before the mint signature is computed over it. */
function resignedReceipt(
	patch: (r: UnsignedReceipt) => UnsignedReceipt,
): Pick<MintOptions, "receiptBeforeSign"> {
	return { receiptBeforeSign: (r) => patch(r) as unknown as Record<string, unknown> };
}

/** The receipt re-signed by `key`, with both keyIds naming it. */
function signedAs(key: HarnessKey): Pick<MintOptions, "receiptAfterSign"> {
	return {
		receiptAfterSign: (r) => {
			const { signature: _dropped, ...rest } = r;
			const unsigned = { ...rest, minter: { ...(rest.minter as object), keyId: key.keyId } };
			return {
				...unsigned,
				signature: {
					alg: "ed25519",
					keyId: key.keyId,
					sig: signEd25519(key, receiptSignaturePreimage(unsigned)),
				},
			};
		},
	};
}

/** The receipt's signature member, replaced AFTER signing (it is not signed). */
function signatureMember(patch: Record<string, unknown>): Pick<MintOptions, "receiptAfterSign"> {
	return {
		receiptAfterSign: (r) => ({
			...r,
			signature: { ...(r.signature as Record<string, unknown>), ...patch },
		}),
	};
}

/** One projection member replaced; the event hash, tree and both signatures follow. */
function projectionMember(key: string, value: unknown): Pick<MintOptions, "projection"> {
	return { projection: (p: Projection) => ({ ...p, [key]: value }) };
}

function spendMember(key: string, value: unknown): Pick<MintOptions, "projection"> {
	return {
		projection: (p: Projection) => ({
			...p,
			spend: { ...(p.spend as Record<string, unknown>), [key]: value },
		}),
	};
}

function workMember(key: string, value: unknown): Pick<MintOptions, "projection"> {
	return {
		projection: (p: Projection) => ({
			...p,
			work: { ...(p.work as Record<string, unknown>), [key]: value },
		}),
	};
}

/** The inclusion proof's sibling list, edited (the receipt is re-signed over it). */
function siblings(
	patch: (
		s: { hash: string; position: "left" | "right" }[],
	) => { hash: string; position: string }[],
): Pick<MintOptions, "inclusion"> {
	return {
		inclusion: (p) => ({ ...p, siblings: patch(structuredClone(p.siblings)) as typeof p.siblings }),
	};
}

const IMPOSSIBLE_INSTANT = "2026-02-30T00:00:00.000Z";
const MEMBERSHIP = { status: "providerVerified", proofId: "pv_9f3a2c81d0" };
const COMMIT_WORK = {
	kind: "commit",
	repoId: "github.com:R_kgDOK1x2Yw",
	oid: "37df16d3a4c1b8e05f92d7a6c31e4b8079fa2d51",
	oidAlg: "sha1",
	objectSha256: otherHash("commit-object"),
	repositoryMembership: MEMBERSHIP,
};
const ARTIFACT_WORK = {
	repoId: "github.com:R_kgDOK1x2Yw",
	number: 42,
	providerArtifactId: "PR_kwDOK1x2Yw6h3Qm2",
	observedRevision: "2026-08-11T18:00:00.000Z",
	contentBinding: { kind: "publicSha256", sha256: otherHash("artifact-content") },
	repositoryMembership: MEMBERSHIP,
};

/** Default chain: mint segment 2 (non-genesis, first sequence 11, treeSize 7). */
const LEAF_1 = { mintLeafIndex: 1 } as const;
/** Segment 1's LAST leaf: its event is the final one, and segment 2 succeeds it. */
const FINAL_LEAF = { mintSegmentIndex: 1, mintLeafIndex: 6 } as const;
const WITH_SUCCESSOR: Pick<MintOptions, "history"> = { history: (_history, all) => [...all] };

// ─────────────────────────────────────────────────────────────────────────────
// §7 step 1 — schema.
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_ROWS: readonly Row[] = [
	{
		id: "schema.spec",
		value: "spec ut2, re-signed",
		boundTo: "§5 literal `ut1`; equality 7 against event.data.spec",
		covers: ["spec"],
		run: () => verify(resignedReceipt((r) => ({ ...r, spec: "ut2" }))),
		expect: failed("schema", "SCHEMA_INVALID", "spec"),
	},
	{
		id: "schema.scope",
		value: "scope call, re-signed",
		boundTo: "§5 literal `session`; equality 7 against event.data.scope",
		covers: ["scope"],
		run: () => verify(resignedReceipt((r) => ({ ...r, scope: "call" }))),
		expect: failed("schema", "SCHEMA_INVALID", "scope"),
	},
	{
		id: "schema.receiptId",
		value: "receiptId that decodes short, re-signed",
		boundTo: "§12 canonical decode/re-encode",
		covers: ["receiptId"],
		run: () => verify({ receiptId: SHORT_DECODE_RECEIPT_ID }),
		expect: failed("schema", "SCHEMA_INVALID", "receiptId"),
	},
	{
		id: "schema.mintedAt-impossible",
		value: "mintedAt 2026-02-30, re-signed",
		boundTo: "§2 RFC 3339 instant (round-trip), never a throw",
		covers: ["mintedAt"],
		run: () => verify(resignedReceipt((r) => ({ ...r, mintedAt: IMPOSSIBLE_INSTANT }))),
		expect: failed("schema", "SCHEMA_INVALID", "mintedAt"),
	},
	{
		id: "schema.event.timestamp-impossible",
		value: "event.timestamp 2026-02-30, re-hashed and re-signed",
		boundTo: "§2 RFC 3339 instant (round-trip), never a throw",
		covers: ["event.timestamp"],
		run: () => verify({ event: (e) => ({ ...e, timestamp: IMPOSSIBLE_INSTANT }) }),
		expect: failed("schema", "SCHEMA_INVALID", "timestamp"),
	},
	{
		id: "schema.data.startedAt-impossible",
		value: "event.data.startedAt 2026-02-30, re-hashed and re-signed",
		boundTo: "§2 RFC 3339 instant (round-trip), never a throw",
		covers: ["event.data.startedAt"],
		run: () => verify(projectionMember("startedAt", IMPOSSIBLE_INSTANT)),
		expect: failed("schema", "SCHEMA_INVALID", "startedAt"),
	},
	{
		id: "schema.data.endedAt-impossible",
		value: "event.data.endedAt 2026-13-01, re-hashed and re-signed",
		boundTo: "§2 RFC 3339 instant (round-trip), never a throw",
		covers: ["event.data.endedAt"],
		run: () => verify(projectionMember("endedAt", "2026-13-01T00:00:00.000Z")),
		expect: failed("schema", "SCHEMA_INVALID", "endedAt"),
	},
	{
		id: "schema.data.sessionId-blank",
		value: "event.data.sessionId empty, re-hashed and re-signed",
		boundTo: "presence (a blank identity identifies nothing)",
		covers: ["event.data.sessionId"],
		run: () => verify(projectionMember("sessionId", "")),
		expect: failed("schema", "SCHEMA_INVALID", "sessionId"),
	},
	{
		id: "schema.event.sequence-negative",
		value: "event.sequence −1, re-hashed and re-signed",
		boundTo: "a non-negative sequence number",
		covers: ["event.sequence"],
		run: () => verify({ event: (e) => ({ ...e, sequence: -1 }) }),
		expect: failed("schema", "SCHEMA_INVALID", "sequence"),
	},
	{
		id: "schema.signature.alg",
		value: "signature.alg rsa (the signature member is unsigned)",
		boundTo: "§5 literal `ed25519`",
		covers: ["signature.alg"],
		run: () => verify(signatureMember({ alg: "rsa" })),
		expect: failed("schema", "SCHEMA_INVALID", "signature.alg"),
	},
	{
		id: "schema.signature.sig-noncanonical",
		value: "signature.sig with junk past the padding",
		boundTo: "canonical base64 decoding to 64 bytes",
		covers: ["signature.sig"],
		run: () =>
			verify({
				receiptAfterSign: (r) => {
					const signature = r.signature as { alg: string; keyId: string; sig: string };
					return { ...r, signature: { ...signature, sig: `${signature.sig}AA==` } };
				},
			}),
		expect: failed("schema", "SCHEMA_INVALID", "signature.sig"),
	},
	{
		id: "schema.inclusion.version",
		value: "proof.inclusion.version 2, re-signed",
		boundTo: "the literal 1",
		covers: ["proof.inclusion.version"],
		run: () => verify({ inclusion: (p) => ({ ...p, version: 2 }) }),
		expect: failed("schema", "SCHEMA_INVALID", "inclusion.version"),
	},
	{
		id: "schema.inclusion.sibling-hash-tail",
		value: "a sibling hash with a non-hex tail, re-signed",
		boundTo: "64 lowercase hex — Node's decoder would drop the tail and fold the same root",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () =>
			verify(siblings((s) => s.map((x, i) => (i === 0 ? { ...x, hash: `${x.hash}zz` } : x)))),
		expect: failed("schema", "SCHEMA_INVALID", "siblings"),
	},
	{
		id: "schema.checkpoint.extra-member",
		value: "an extra member in the checkpoint, re-signed by both keys",
		boundTo: "§4a's closed twelve-member statement (unknown-field walk)",
		covers: [],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, note: "x" }) as UnsignedCheckpoint)),
		expect: failed("schema", "SCHEMA_INVALID", "note"),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// §2 (v0.9.6) — the artifact variants, refused at step 7 even well formed.
// ─────────────────────────────────────────────────────────────────────────────

const WORK_KIND_ROWS: readonly Row[] = (
	[
		["commit", COMMIT_WORK],
		["pr", { ...ARTIFACT_WORK, kind: "pr" }],
		["issue", { ...ARTIFACT_WORK, kind: "issue" }],
	] as const
).map(([kind, work]) => ({
	id: `semantics.work.kind-${kind}`,
	value: `a well-formed ${kind} variant, in the projection and its mirror, re-hashed and re-signed`,
	boundTo:
		"nothing a verifier holds binds its provider proofs (membership proofId, oid/objectSha256, contentBinding), so v1 refuses the claim — never VERIFIED",
	covers: [`work[${kind}]`, `event.data.work[${kind}]`],
	run: () => verify(projectionMember("work", work)),
	expect: failed("semantics", "SEMANTIC_INVALID", `work.kind ${kind} is an artifact claim`),
}));

// ─────────────────────────────────────────────────────────────────────────────
// §7 step 4 — the mint signature and its authority binding.
// ─────────────────────────────────────────────────────────────────────────────

const SIGNATURE_ROWS: readonly Row[] = [
	{
		id: "signature.minter.keyId",
		value: "minter.keyId alone names another key, re-signed",
		boundTo: "signature.keyId (§5: the two keyIds are one key)",
		covers: ["minter.keyId"],
		run: () =>
			verify(
				resignedReceipt((r) => ({ ...r, minter: { ...r.minter, keyId: CHECKPOINT_KEY.keyId } })),
			),
		expect: failed("schema", "SCHEMA_INVALID", "minter.keyId"),
	},
	{
		id: "signature.keyId-wrong-role",
		value: "both keyIds name the registered CHECKPOINT key, which signs",
		boundTo: "the snapshot key's role `mint`",
		covers: ["minter.keyId", "signature.keyId"],
		run: () => verify(signedAs(CHECKPOINT_KEY)),
		expect: failed("signature", "SIG_INVALID", "role"),
	},
	{
		id: "signature.keyId-unregistered",
		value: "both keyIds name a key the snapshot never saw, which signs",
		boundTo: "the pinned snapshot (missing trust material)",
		covers: ["minter.keyId", "signature.keyId"],
		run: () => verify(signedAs(FOREIGN_KEY)),
		expect: { verdict: "UNVERIFIABLE", missing: "trustKey" },
	},
	{
		id: "signature.sig-foreign",
		value: "a VALID Ed25519 signature by a foreign key, keyIds unchanged",
		boundTo: "Ed25519 under the registered mint key",
		covers: ["signature.sig"],
		run: () =>
			verify({
				receiptAfterSign: (r) => ({
					...r,
					signature: {
						...(r.signature as Record<string, unknown>),
						sig: signEd25519(FOREIGN_KEY, receiptSignaturePreimage(r)),
					},
				}),
			}),
		expect: failed("signature", "SIG_INVALID", "does not verify"),
	},
	{
		id: "signature.sig-garbage",
		value: "signature.sig with one character flipped",
		boundTo: "Ed25519 under the registered mint key",
		covers: ["signature.sig"],
		run: () =>
			verify({
				receiptAfterSign: (r) => {
					const signature = r.signature as { alg: string; keyId: string; sig: string };
					return { ...r, signature: { ...signature, sig: corruptBase64(signature.sig) } };
				},
			}),
		expect: failed("signature", "SIG_INVALID", "does not verify"),
	},
	{
		id: "signature.minter.kind",
		value: "minter.kind sdk, re-signed",
		boundTo: "v1's literal `proxy` and the key's registered minterKind",
		covers: ["minter.kind"],
		run: () => verify(resignedReceipt((r) => ({ ...r, minter: { ...r.minter, kind: "sdk" } }))),
		expect: failed("signature", "SIG_INVALID", "minter.kind"),
	},
	{
		id: "signature.minter.trustDomain",
		value: "a lookalike trustDomain, re-signed",
		boundTo: "§8's pinned literal `usertrust.ai`",
		covers: ["minter.trustDomain"],
		run: () =>
			verify(
				resignedReceipt((r) => ({
					...r,
					minter: { ...r.minter, trustDomain: "usertrust.ai.evil" },
				})),
			),
		expect: failed("signature", "SIG_INVALID", "trustDomain"),
	},
	{
		id: "signature.covers-the-document",
		value: "mintedAt edited AFTER signing",
		boundTo: "Ed25519 over the prefix ‖ canonicalize(receipt − signature)",
		covers: ["mintedAt"],
		run: () =>
			verify({ receiptAfterSign: (r) => ({ ...r, mintedAt: "2026-08-11T18:42:20.115Z" }) }),
		expect: failed("signature", "SIG_INVALID", "does not verify"),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// §7 step 2 — the RECOMPUTED event hash. Each edit lands after hashing, the
// receipt is re-signed over it, and the tree still holds the old hash.
// ─────────────────────────────────────────────────────────────────────────────

const RECOMPUTE = "event.hash does not recompute";

const EVENT_ENVELOPE_ROWS: readonly Row[] = (
	[
		["id", "evt_01K2Q7WD5J3N8H4TB2MYE0PXQS"],
		["timestamp", "2026-08-11T18:42:14.007Z"],
		["previousHash", otherHash("another-previous-event")],
		["sequence", 14],
		["hash", otherHash("another-event-hash")],
	] as const
).map(([member, value]) => ({
	id: `event.recompute.${member}`,
	value: `event.${member} edited after hashing, re-signed`,
	boundTo: "the recomputed sha256(canonicalize(event − hash))",
	covers: [`event.${member}`],
	run: () => verify({ eventAfterHash: (e) => ({ ...e, [member]: value }) }),
	expect: failed("event", "EVENT_MISMATCH", RECOMPUTE),
}));

/** Every projection member, each replaced by a schema-valid alternative. */
const PROJECTION_ALTERNATIVES: readonly (readonly [string, (p: Projection) => unknown])[] = [
	["spec", () => "ut2"],
	["scope", () => "call"],
	["sessionId", () => "01K2Q7V8ZC4M6N0PABCDEF3XYA"],
	["generation", () => 2],
	["prevGenerationEventHash", () => otherHash("prev-generation")],
	["work", (p) => ({ ...(p.work as Record<string, unknown>), repoId: "github.com:R_other" })],
	["sessionAssociation", () => "ownerAsserted"],
	["workloadId", () => "wl_other"],
	["models", () => ["claude-opus-4-5"]],
	["providers", () => ["openai"]],
	["startedAt", () => "2026-08-11T18:00:00.001Z"],
	["endedAt", () => "2026-08-11T18:42:13.513Z"],
	[
		"spend",
		(p) => ({
			...(p.spend as Record<string, unknown>),
			assessedUsertokens: 48225,
			postedUsertokens: 48225,
		}),
	],
	["delegationPosture", () => "indeterminate"],
	["pricing", () => ({ tableVersions: ["2026-08-02"] })],
	["transferSet", (p) => [...(p.transferSet as unknown[])].reverse()],
	["transferSetRoot", () => otherHash("transfer-set-root")],
];

const EVENT_DATA_ROWS: readonly Row[] = PROJECTION_ALTERNATIVES.map(([member, alternative]) => ({
	id: `event.recompute.data.${member}`,
	value: `event.data.${member} edited after hashing, re-signed`,
	boundTo: "the recomputed event hash",
	covers: [`event.data.${member}`],
	run: () =>
		verify({
			eventAfterHash: (e) => ({ ...e, data: { ...e.data, [member]: alternative(e.data) } }),
		}),
	expect: failed("event", "EVENT_MISMATCH", RECOMPUTE),
}));

// ─────────────────────────────────────────────────────────────────────────────
// §7 step 2 — §4's cross-field equalities, every side re-signed.
// ─────────────────────────────────────────────────────────────────────────────

const EQUALITY_ROWS: readonly Row[] = [
	{
		id: "event.eq1.mintEventHash",
		value: "proof.mintEventHash, re-signed",
		boundTo: "equality 1: event.hash",
		covers: ["proof.mintEventHash"],
		run: () =>
			verify(
				resignedReceipt((r) => ({ ...r, proof: { ...r.proof, mintEventHash: otherHash("m") } })),
			),
		expect: failed("event", "EVENT_MISMATCH", "equality 1"),
	},
	{
		id: "event.eq1.leafHash",
		value: "inclusion.leafHash, re-signed",
		boundTo: "equality 1: event.hash",
		covers: ["proof.inclusion.leafHash"],
		run: () => verify({ inclusion: (p) => ({ ...p, leafHash: otherHash("leaf") }) }),
		expect: failed("event", "EVENT_MISMATCH", "equality 1"),
	},
	{
		id: "event.eq1.another-leaf",
		value: "a valid proof of ANOTHER leaf, checkpoint signed over that tree",
		boundTo: "equality 1: event.hash",
		covers: ["proof.inclusion.leafHash"],
		run: () => verify({ mintLeaf: () => otherHash("substituted-leaf") }),
		expect: failed("event", "EVENT_MISMATCH", "equality 1"),
	},
	{
		id: "event.eq2.kind",
		value: "event.kind llm_call, re-hashed and re-signed",
		boundTo: "equality 2: the literal receipt_settled",
		covers: ["event.kind"],
		run: () => verify({ event: (e) => ({ ...e, kind: "llm_call" }) }),
		expect: failed("event", "EVENT_MISMATCH", "equality 2"),
	},
	{
		id: "event.eq2.actor",
		value: "event.actor with a tenant member, re-hashed and re-signed",
		boundTo: "equality 2: §4a's closed system actor, then the registered mintActor",
		covers: ["event.actor"],
		run: () =>
			verify({
				event: (e) => ({
					...e,
					actor: { type: "system", id: "receipt-minter", name: "receipt-minter", tenant: "acme" },
				}),
			}),
		expect: failed("event", "EVENT_MISMATCH", "equality 2"),
	},
	{
		id: "event.eq4.leafIndex",
		value: "inclusion.leafIndex 2, re-signed",
		boundTo: "equality 4: sequence − segmentFirstSequence + offset",
		covers: ["proof.inclusion.leafIndex"],
		run: () => verify({ inclusion: (p) => ({ ...p, leafIndex: 2 }) }),
		expect: failed("event", "EVENT_MISMATCH", "equality 4"),
	},
	{
		id: "event.eq4.sequence",
		value: "event.sequence − 1, re-hashed and re-signed",
		boundTo: "equality 4",
		covers: ["event.sequence"],
		run: () => verify({ event: (e) => ({ ...e, sequence: e.sequence - 1 }) }),
		expect: failed("event", "EVENT_MISMATCH", "equality 4"),
	},
	{
		id: "event.eq4.segmentFirstSequence",
		value: "checkpoint.segmentFirstSequence + 1, re-signed",
		boundTo: "equality 4",
		covers: ["proof.checkpoint.segmentFirstSequence"],
		run: () =>
			verify(
				resignedCheckpoint((c) => ({ ...c, segmentFirstSequence: c.segmentFirstSequence + 1 })),
			),
		expect: failed("event", "EVENT_MISMATCH", "equality 4"),
	},
	{
		id: "event.eq4.offset",
		value: "a non-genesis checkpoint re-signed with previousSegmentRoot `genesis`",
		boundTo: "equality 4: the offset is read from the SIGNED edge",
		covers: ["proof.checkpoint.previousSegmentRoot"],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, previousSegmentRoot: "genesis" }))),
		expect: failed("event", "EVENT_MISMATCH", "equality 4"),
	},
	{
		id: "event.eq4.chain-link-claimed",
		value: "a non-genesis proof claiming leaf 0, the chain link",
		boundTo: "equality 4's range [offset, treeSize)",
		covers: ["proof.inclusion.leafIndex"],
		run: () =>
			verify({
				event: (e) => ({ ...e, sequence: e.sequence - 3 }),
				inclusion: (p) => ({ ...p, leafIndex: 0 }),
			}),
		expect: failed("event", "EVENT_MISMATCH", "equality 4"),
	},
	{
		id: "event.eq5.inclusion-treeSize",
		value: "inclusion.treeSize + 1, re-signed",
		boundTo: "equality 5: checkpoint.treeSize",
		covers: ["proof.inclusion.treeSize"],
		run: () => verify({ inclusion: (p) => ({ ...p, treeSize: p.treeSize + 1 }) }),
		expect: failed("event", "EVENT_MISMATCH", "equality 5"),
	},
	{
		id: "event.eq5.checkpoint-treeSize",
		value: "checkpoint.treeSize + 1, re-signed",
		boundTo: "equality 5: inclusion.treeSize",
		covers: ["proof.checkpoint.treeSize"],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, treeSize: c.treeSize + 1 }))),
		expect: failed("event", "EVENT_MISMATCH", "equality 5"),
	},
	{
		id: "event.eq6.inclusion-root",
		value: "inclusion.root, re-signed",
		boundTo: "equality 6: checkpoint.root",
		covers: ["proof.inclusion.root"],
		run: () => verify({ inclusion: (p) => ({ ...p, root: otherHash("inclusion-root") }) }),
		expect: failed("event", "EVENT_MISMATCH", "equality 6"),
	},
	{
		id: "event.eq6.checkpoint-root",
		value: "checkpoint.root, re-signed",
		boundTo: "equality 6: inclusion.root",
		covers: ["proof.checkpoint.root"],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, root: otherHash("checkpoint-root") }))),
		expect: failed("event", "EVENT_MISMATCH", "equality 6"),
	},
	{
		id: "event.eq7.data.spec",
		value: "event.data.spec ut2, re-hashed and re-signed",
		boundTo: "equality 7: receipt.spec",
		covers: ["event.data.spec"],
		run: () => verify(projectionMember("spec", "ut2")),
		expect: failed("event", "EVENT_MISMATCH", "equality 7"),
	},
	{
		id: "event.eq7.data.scope",
		value: "event.data.scope call, re-hashed and re-signed",
		boundTo: "equality 7: receipt.scope",
		covers: ["event.data.scope"],
		run: () => verify(projectionMember("scope", "call")),
		expect: failed("event", "EVENT_MISMATCH", "equality 7"),
	},
	{
		id: "event.eq8.inclusion-segmentId",
		value: "inclusion.segmentId, re-signed",
		boundTo: "equality 8: checkpoint.segmentId",
		covers: ["proof.inclusion.segmentId"],
		run: () => verify({ inclusion: (p) => ({ ...p, segmentId: "seg_000002" }) }),
		expect: failed("event", "EVENT_MISMATCH", "equality 8"),
	},
	{
		id: "event.eq8.checkpoint-segmentId",
		value: "checkpoint.segmentId, re-signed",
		boundTo: "equality 8: inclusion.segmentId",
		covers: ["proof.checkpoint.segmentId"],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, segmentId: "seg_000099" }))),
		expect: failed("event", "EVENT_MISMATCH", "equality 8"),
	},
	{
		id: "event.eq8.checkpoint-vaultId",
		value: "checkpoint.vaultId, re-signed",
		boundTo: "equality 8: proof.chain",
		covers: ["proof.checkpoint.vaultId"],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, vaultId: "vlt_other_chain" }))),
		expect: failed("event", "EVENT_MISMATCH", "equality 8"),
	},
	{
		id: "event.eq8.proof-chain",
		value: "proof.chain, re-signed",
		boundTo: "equality 8: the SIGNED checkpoint.vaultId",
		covers: ["proof.chain"],
		run: () =>
			verify(resignedReceipt((r) => ({ ...r, proof: { ...r.proof, chain: "vlt_other_chain" } }))),
		expect: failed("event", "EVENT_MISMATCH", "equality 8"),
	},
	{
		id: "event.eq8.checkpoint-profile",
		value: "checkpoint.profile, re-signed",
		boundTo: "equality 8: proof.profile",
		covers: ["proof.checkpoint.profile"],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, profile: "ut-chain-v1" }))),
		expect: failed("event", "EVENT_MISMATCH", "equality 8"),
	},
	{
		id: "event.eq8.proof-profile",
		value: "proof.profile, re-signed",
		boundTo: "equality 8: the SIGNED checkpoint.profile",
		covers: ["proof.profile"],
		run: () =>
			verify(resignedReceipt((r) => ({ ...r, proof: { ...r.proof, profile: "ut-chain-v1" } }))),
		expect: failed("event", "EVENT_MISMATCH", "equality 8"),
	},
	{
		id: "event.eq8.profile-literal",
		value: "proof.profile AND checkpoint.profile both ut-chain-v1, both re-signed",
		boundTo: "equality 8: the literal proxy-v1, from which §4a's equality set is selected",
		covers: ["proof.profile", "proof.checkpoint.profile"],
		run: () =>
			verify({
				...resignedReceipt((r) => ({ ...r, proof: { ...r.proof, profile: "ut-chain-v1" } })),
				...resignedCheckpoint((c) => ({ ...c, profile: "ut-chain-v1" })),
			}),
		expect: failed("event", "EVENT_MISMATCH", "is not ut1's"),
	},
	{
		id: "event.eq9.work-mirror",
		value: "receipt.work ≠ event.data.work, re-signed",
		boundTo: "equality 9: canonicalize(event.data.work)",
		covers: ["work"],
		run: () =>
			verify(
				resignedReceipt((r) => ({
					...r,
					work: { ...(r.work as Record<string, unknown>), repoId: "github.com:R_other" },
				})),
			),
		expect: failed("event", "EVENT_MISMATCH", "equality 9"),
	},
	{
		id: "event.eq9.work-absent",
		value: "receipt.work absent, re-signed",
		boundTo: "equality 9: the REQUIRED mirror",
		covers: ["work"],
		run: () =>
			verify(
				resignedReceipt((r) => {
					const { work: _dropped, ...rest } = r;
					return rest as UnsignedReceipt;
				}),
			),
		expect: failed("event", "EVENT_MISMATCH", "equality 9"),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// §7 step 2 — the SEGMENT BOUNDARIES and every proof node the receipt can
// RECOMPUTE (§4a, v0.9.6), everything re-signed.
// ─────────────────────────────────────────────────────────────────────────────

const CHAIN_LINK = "chain link";
const PREDECESSOR = "predecessor event";
const FIRST_EVENT = "first event";

/** The mint segment holds its link and two events: treeSize 3, so level 0
 * PROMOTES leaf 2 and the node over leaves 0 and 1 is sibling 0. */
/** `proof.chain` and the checkpoint's signed `vaultId` both renamed to a chain
 * the snapshot never registered — re-signed, so equality 8 still holds. */
const UNREGISTERED = "vlt_unregistered";
const UNREGISTERED_CHAIN = {
	receiptBeforeSign: (r: UnsignedReceipt): Record<string, unknown> => ({
		...r,
		proof: { ...r.proof, chain: UNREGISTERED },
	}),
	checkpointsUnsigned: (cs: UnsignedCheckpoint[]): UnsignedCheckpoint[] =>
		cs.map((c, i) => (i === 2 ? { ...c, vaultId: UNREGISTERED } : c)),
} satisfies Pick<MintOptions, "receiptBeforeSign" | "checkpointsUnsigned">;

/** A non-genesis mint segment of nine leaves, minting at its odd leaf 7. */
const LEAF_7_OF_9: Pick<MintOptions, "segments" | "mintSegmentIndex" | "mintLeafIndex"> = {
	segments: [
		{ segmentId: "seg_000001", segmentFirstSequence: 1, treeSize: 4 },
		{ segmentId: "seg_000002", segmentFirstSequence: 5, treeSize: 9 },
	],
	mintSegmentIndex: 1,
	mintLeafIndex: 7,
};
const PROMOTED_LEAF_2: Pick<MintOptions, "segments" | "mintSegmentIndex" | "mintLeafIndex"> = {
	segments: [
		{ segmentId: "seg_000001", segmentFirstSequence: 1, treeSize: 4 },
		{ segmentId: "seg_000002", segmentFirstSequence: 5, treeSize: 3 },
	],
	mintSegmentIndex: 1,
	mintLeafIndex: 2,
};

const BOUNDARY_ROWS: readonly Row[] = [
	{
		id: "event.boundary.first-event-previousHash",
		value: "the segment's FIRST event (leaf 1) links elsewhere, re-hashed and re-signed",
		boundTo: "the signed segmentStartPreviousHash",
		covers: ["event.previousHash"],
		run: () =>
			verify({ ...LEAF_1, event: (e) => ({ ...e, previousHash: otherHash("elsewhere") }) }),
		expect: failed("event", "EVENT_MISMATCH", FIRST_EVENT),
	},
	{
		id: "event.boundary.first-event-genesis",
		value: "the GENESIS segment's first event (leaf 0) links elsewhere, re-hashed and re-signed",
		boundTo: "the signed all-zero segmentStartPreviousHash",
		covers: ["event.previousHash"],
		run: () =>
			verify({
				mintSegmentIndex: 0,
				mintLeafIndex: 0,
				event: (e) => ({ ...e, previousHash: otherHash("elsewhere") }),
			}),
		expect: failed("event", "EVENT_MISMATCH", FIRST_EVENT),
	},
	{
		id: "event.boundary.start-hash-resigned",
		value: "at leaf 1, the checkpoint re-signed over another segmentStartPreviousHash",
		boundTo: "the first event's own previousHash",
		covers: ["proof.checkpoint.segmentStartPreviousHash"],
		run: () =>
			verify({
				...LEAF_1,
				...resignedCheckpoint((c) => ({ ...c, segmentStartPreviousHash: otherHash("start") })),
			}),
		expect: failed("event", "EVENT_MISMATCH", FIRST_EVENT),
	},
	{
		id: "event.boundary.chain-link-leaf-1",
		value:
			"at leaf 1, a tree built over a FORGED leaf 0 — fold, root and checkpoint all re-signed to match",
		boundTo: "the level-0 sibling === leafNode(signed previousSegmentRoot)",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () => verify({ ...LEAF_1, chainLinkLeaf: () => otherHash("forged-chain-link") }),
		expect: failed("event", "EVENT_MISMATCH", CHAIN_LINK),
	},
	{
		id: "event.boundary.chain-link-leaf-2",
		value: "at leaf 2, a tree built over a FORGED leaf 0, everything re-signed",
		boundTo: "sibling 1 === node(leafNode(previousSegmentRoot), leafNode(event.previousHash))",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () => verify({ mintLeafIndex: 2, chainLinkLeaf: () => otherHash("forged-chain-link") }),
		expect: failed("event", "EVENT_MISMATCH", CHAIN_LINK),
	},
	{
		id: "event.boundary.chain-link-leaf-2-promoted",
		value: "at leaf 2 of a three-leaf tree, a FORGED leaf 0, everything re-signed",
		boundTo: "sibling 0 — the same node, which level 0's promotion moves down the list",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () => verify({ ...PROMOTED_LEAF_2, chainLinkLeaf: () => otherHash("forged-chain-link") }),
		expect: failed("event", "EVENT_MISMATCH", CHAIN_LINK),
	},
	{
		id: "event.boundary.chain-link-root-resigned",
		value: "at leaf 1, the checkpoint re-signed over another previousSegmentRoot",
		boundTo: "the tree's leaf 0, exposed as the level-0 sibling",
		covers: ["proof.checkpoint.previousSegmentRoot"],
		run: () =>
			verify({
				...LEAF_1,
				...resignedCheckpoint((c) => ({ ...c, previousSegmentRoot: otherHash("another-root") })),
			}),
		expect: failed("event", "EVENT_MISMATCH", CHAIN_LINK),
	},
	{
		id: "event.boundary.predecessor-odd-leaf",
		value: "at leaf 3, the event re-hashed over a previousHash that is not leaf 2",
		boundTo: "the level-0 sibling === leafNode(event.previousHash): the leaves ARE the hash chain",
		covers: ["event.previousHash"],
		run: () => verify({ event: (e) => ({ ...e, previousHash: otherHash("not-leaf-2") }) }),
		expect: failed("event", "EVENT_MISMATCH", PREDECESSOR),
	},
	{
		id: "event.boundary.predecessor-odd-leaf-7",
		value: "at leaf 7 of a nine-leaf tree, a previousHash that is not leaf 6",
		boundTo: "the level-0 sibling === leafNode(event.previousHash), at any odd leaf",
		covers: ["event.previousHash"],
		run: () =>
			verify({
				...LEAF_7_OF_9,
				event: (e) => ({ ...e, previousHash: otherHash("not-leaf-6") }),
			}),
		expect: failed("event", "EVENT_MISMATCH", PREDECESSOR),
	},
	{
		id: "event.boundary.predecessor-genesis-leaf-1",
		value: "at leaf 1 of the GENESIS segment, a previousHash that is not leaf 0",
		boundTo: "the level-0 sibling === leafNode(event.previousHash)",
		covers: ["event.previousHash"],
		run: () =>
			verify({
				mintSegmentIndex: 0,
				mintLeafIndex: 1,
				event: (e) => ({ ...e, previousHash: otherHash("not-leaf-0") }),
			}),
		expect: failed("event", "EVENT_MISMATCH", PREDECESSOR),
	},
	{
		id: "event.boundary.predecessor-leaf-2",
		value: "at leaf 2, a previousHash that is not leaf 1",
		boundTo: "sibling 1 === node(leafNode(previousSegmentRoot), leafNode(event.previousHash))",
		covers: ["event.previousHash"],
		run: () =>
			verify({ mintLeafIndex: 2, event: (e) => ({ ...e, previousHash: otherHash("not-leaf-1") }) }),
		expect: failed("event", "EVENT_MISMATCH", PREDECESSOR),
	},
	{
		id: "event.boundary.start-hash-not-a-digest",
		value:
			"at leaf 1 (the first event), a segmentStartPreviousHash that is not a digest, re-signed",
		boundTo: "the first event's previousHash — fails CLOSED, in step 2's receipt-local phase",
		covers: ["proof.checkpoint.segmentStartPreviousHash"],
		run: () =>
			verify({
				...LEAF_1,
				...resignedCheckpoint((c) => ({ ...c, segmentStartPreviousHash: "not-a-digest" })),
			}),
		expect: failed("event", "EVENT_MISMATCH", FIRST_EVENT),
	},
	{
		id: "event.boundary.chain-link-not-a-digest",
		value: "at leaf 1, a previousSegmentRoot that is not a digest, re-signed",
		boundTo: "the chain-link node — fails CLOSED, in step 2's receipt-local phase",
		covers: ["proof.checkpoint.previousSegmentRoot"],
		run: () =>
			verify({
				...LEAF_1,
				...resignedCheckpoint((c) => ({ ...c, previousSegmentRoot: "not-a-root" })),
			}),
		expect: failed("event", "EVENT_MISMATCH", CHAIN_LINK),
	},
	{
		id: "event.boundary.chain-link-absent",
		value: "at leaf 1, previousSegmentRoot dropped and the rest re-signed — never a throw",
		boundTo: "the chain-link node — fails CLOSED without hashing a missing operand",
		covers: ["proof.checkpoint.previousSegmentRoot"],
		run: () =>
			verify({
				...LEAF_1,
				...resignedCheckpoint((c) => {
					const { previousSegmentRoot: _dropped, ...rest } = c;
					return rest as UnsignedCheckpoint;
				}),
			}),
		expect: failed("event", "EVENT_MISMATCH", CHAIN_LINK),
	},
	{
		id: "event.boundary.chain-link-number",
		value: "at leaf 2, previousSegmentRoot a NUMBER, re-signed — never a throw",
		boundTo: "the node over the link and the predecessor — fails CLOSED without hashing it",
		covers: ["proof.checkpoint.previousSegmentRoot"],
		run: () =>
			verify({
				mintLeafIndex: 2,
				...resignedCheckpoint(
					(c) => ({ ...c, previousSegmentRoot: 7 }) as unknown as UnsignedCheckpoint,
				),
			}),
		expect: failed("event", "EVENT_MISMATCH", CHAIN_LINK),
	},
	{
		id: "event.boundary.recomputable-sibling-absent",
		value: "at leaf 1, a proof with no siblings at all, re-signed",
		boundTo: "the owed chain-link node — fails CLOSED, before step 5 counts the path",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () => verify({ ...LEAF_1, ...siblings(() => []) }),
		expect: failed("event", "EVENT_MISMATCH", CHAIN_LINK),
	},
	{
		id: "event.boundary.recomputable-sibling-edited",
		value: "at leaf 3, sibling 0 (the recomputed predecessor node) replaced, re-signed",
		boundTo: "the recomputed predecessor node, before step 5's fold",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () =>
			verify(siblings((s) => s.map((x, i) => (i === 0 ? { ...x, hash: otherHash("s0") } : x)))),
		expect: failed("event", "EVENT_MISMATCH", PREDECESSOR),
	},
	{
		id: "partition.chain-link-unmaskable",
		value:
			"a forged chain link at leaf 1, AND proof.chain renamed to an unregistered chain (re-signed)",
		boundTo: "step 2's receipt-local phase runs before the chain lookup",
		covers: [],
		run: () =>
			verify({ ...LEAF_1, ...UNREGISTERED_CHAIN, chainLinkLeaf: () => otherHash("forged") }),
		expect: failed("event", "EVENT_MISMATCH", CHAIN_LINK),
	},
	{
		id: "partition.start-hash-unmaskable",
		value: "a malformed start hash at the first event, AND an unregistered chain",
		boundTo: "step 2's receipt-local phase runs before the chain lookup",
		covers: [],
		run: () =>
			verify({
				...LEAF_1,
				receiptBeforeSign: UNREGISTERED_CHAIN.receiptBeforeSign,
				checkpointsUnsigned: (cs) =>
					cs.map((c, i) =>
						i === 2 ? { ...c, vaultId: UNREGISTERED, segmentStartPreviousHash: "not-a-digest" } : c,
					),
			}),
		expect: failed("event", "EVENT_MISMATCH", FIRST_EVENT),
	},
	{
		id: "partition.sibling-absent-unmaskable",
		value: "no siblings at leaf 1, AND an unregistered chain",
		boundTo: "step 2's receipt-local phase runs before the chain lookup",
		covers: [],
		run: () => verify({ ...LEAF_1, ...UNREGISTERED_CHAIN, ...siblings(() => []) }),
		expect: failed("event", "EVENT_MISMATCH", CHAIN_LINK),
	},
	{
		id: "partition.unregistered-chain-control",
		value: "an honest receipt whose proof.chain and checkpoint.vaultId name an unregistered chain",
		boundTo: "the pinned snapshot's chains (missing trust material)",
		covers: [],
		run: () => verify(UNREGISTERED_CHAIN),
		expect: { verdict: "UNVERIFIABLE", missing: "trustKey" },
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// §7 step 5 — the inclusion path.
// ─────────────────────────────────────────────────────────────────────────────

const INCLUSION_ROWS: readonly Row[] = [
	{
		id: "inclusion.sibling-hash",
		value: "a sibling hash replaced, re-signed",
		boundTo: "the fold to the signed root",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () =>
			verify(siblings((s) => s.map((x, i) => (i === 1 ? { ...x, hash: otherHash("s") } : x)))),
		expect: failed("inclusion", "PROOF_INVALID"),
	},
	{
		id: "inclusion.sibling-hash-top",
		value: "the TOP sibling at leaf 3 replaced, re-signed",
		boundTo: "the fold to the signed root (a node over leaves the receipt does not carry)",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () =>
			verify(siblings((s) => s.map((x, i) => (i === 2 ? { ...x, hash: otherHash("s2") } : x)))),
		expect: failed("inclusion", "PROOF_INVALID"),
	},
	{
		id: "inclusion.sibling-position",
		value: "a sibling's position flipped, re-signed",
		boundTo: "the topology DERIVED from (leafIndex, treeSize)",
		covers: ["proof.inclusion.siblings[].position"],
		run: () =>
			verify(
				siblings((s) =>
					s.map((x, i) =>
						i === 1 ? { ...x, position: x.position === "left" ? "right" : "left" } : x,
					),
				),
			),
		expect: failed("inclusion", "PROOF_INVALID"),
	},
	{
		id: "inclusion.sibling-count-short",
		value: "the last sibling dropped, re-signed",
		boundTo: "the derived path length",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () => verify(siblings((s) => s.slice(0, -1))),
		expect: failed("inclusion", "PROOF_INVALID"),
	},
	{
		id: "inclusion.sibling-count-long",
		value: "an extra sibling appended, re-signed",
		boundTo: "the derived path length",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () => verify(siblings((s) => [...s, { hash: otherHash("extra"), position: "right" }])),
		expect: failed("inclusion", "PROOF_INVALID"),
	},
	{
		id: "inclusion.above-the-chain-link",
		value: "at leaf 1, a sibling ABOVE level 0 replaced, re-signed",
		boundTo: "the fold — the chain-link binding opens level 0 only",
		covers: ["proof.inclusion.siblings[].hash"],
		run: () =>
			verify({
				...LEAF_1,
				...siblings((s) => s.map((x, i) => (i === 1 ? { ...x, hash: otherHash("above") } : x))),
			}),
		expect: failed("inclusion", "PROOF_INVALID"),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// §7 step 6 — the checkpoint statement.
// ─────────────────────────────────────────────────────────────────────────────

const CHECKPOINT_ROWS: readonly Row[] = [
	{
		id: "checkpoint.sig-garbage",
		value: "checkpoint.sig with one character flipped",
		boundTo: "Ed25519 over canonicalize(statement) under the lineage key",
		covers: ["proof.checkpoint.sig"],
		run: () =>
			verify({
				checkpointsAfterSign: (cs) =>
					cs.map((c, i) => (i === 2 ? { ...c, sig: corruptBase64(c.sig) } : c)),
			}),
		expect: failed("checkpoint", "CHECKPOINT_INVALID", "signature does not verify"),
	},
	{
		id: "checkpoint.signs-every-member",
		value: "checkpoint.publishedAt edited AFTER signing",
		boundTo: "Ed25519 over the whole statement",
		covers: ["proof.checkpoint.publishedAt"],
		run: () =>
			verify({
				checkpointsAfterSign: (cs) =>
					cs.map((c, i) => (i === 2 ? { ...c, publishedAt: "2026-08-13T00:00:00.001Z" } : c)),
			}),
		expect: failed("checkpoint", "CHECKPOINT_INVALID", "signature does not verify"),
	},
	{
		id: "checkpoint.keyId-unregistered",
		value: "a checkpoint signed by, and naming, a key the snapshot never saw",
		boundTo: "the pinned snapshot (missing trust material)",
		covers: ["proof.checkpoint.keyId"],
		run: () => verify({ checkpointSigner: (i) => (i === 2 ? FOREIGN_KEY : CHECKPOINT_KEY) }),
		expect: { verdict: "UNVERIFIABLE", missing: "trustKey" },
	},
	{
		id: "checkpoint.keyId-wrong-role",
		value: "a checkpoint signed by, and naming, the registered MINT key",
		boundTo: "the snapshot key's role `checkpoint` and the chain's lineage",
		covers: ["proof.checkpoint.keyId"],
		run: () => verify({ checkpointSigner: (i) => (i === 2 ? MINT_KEY : CHECKPOINT_KEY) }),
		expect: failed("checkpoint", "CHECKPOINT_INVALID", "role"),
	},
	{
		id: "checkpoint.v",
		value: "checkpoint.v 1, re-signed",
		boundTo: "§4a: only the v2 statement",
		covers: ["proof.checkpoint.v"],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, v: 1 }))),
		expect: failed("checkpoint", "CHECKPOINT_INVALID", "v2"),
	},
	{
		id: "checkpoint.member-dropped",
		value: "segmentStartPreviousHash dropped, the eleven members re-signed",
		boundTo: "§4a's twelve-member list, checked before the signature",
		covers: ["proof.checkpoint.segmentStartPreviousHash"],
		run: () =>
			verify(
				resignedCheckpoint((c) => {
					const { segmentStartPreviousHash: _dropped, ...rest } = c;
					return rest as UnsignedCheckpoint;
				}),
			),
		expect: failed("checkpoint", "CHECKPOINT_INVALID", "segmentStartPreviousHash"),
	},
	{
		id: "checkpoint.start-hash-zero-non-genesis",
		value: "a non-genesis statement re-signed with the all-zero start hash",
		boundTo: "§4a: all-zero ⇔ previousSegmentRoot `genesis`",
		covers: ["proof.checkpoint.segmentStartPreviousHash"],
		run: () =>
			verify(resignedCheckpoint((c) => ({ ...c, segmentStartPreviousHash: "0".repeat(64) }))),
		expect: failed("checkpoint", "CHECKPOINT_INVALID", "all-zero"),
	},
	{
		id: "checkpoint.start-hash-nonzero-genesis",
		value: "the GENESIS statement re-signed with a non-zero start hash (receipt at leaf 2)",
		boundTo: "§4a: all-zero ⇔ previousSegmentRoot `genesis`",
		covers: ["proof.checkpoint.segmentStartPreviousHash"],
		run: () =>
			verify({
				mintSegmentIndex: 0,
				mintLeafIndex: 2,
				...resignedCheckpoint((c) => ({ ...c, segmentStartPreviousHash: otherHash("start") }), 0),
			}),
		expect: failed("checkpoint", "CHECKPOINT_INVALID", "all-zero"),
	},
	{
		id: "checkpoint.previousSegmentRoot-format",
		value: "previousSegmentRoot that is not a digest, re-signed",
		boundTo: "§4a's declared format (step 6 owns the checkpoint's formats)",
		covers: ["proof.checkpoint.previousSegmentRoot"],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, previousSegmentRoot: "not-a-root" }))),
		expect: failed("checkpoint", "CHECKPOINT_INVALID", "previousSegmentRoot"),
	},
	{
		id: "checkpoint.previousSegmentId-blank",
		value: "previousSegmentId empty, re-signed",
		boundTo: "§4a: every member present",
		covers: ["proof.checkpoint.previousSegmentId"],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, previousSegmentId: "" }))),
		expect: failed("checkpoint", "CHECKPOINT_INVALID", "previousSegmentId"),
	},
	{
		id: "checkpoint.publishedAt-impossible",
		value: "publishedAt 2026-02-30, re-signed",
		boundTo: "§4a's RFC 3339 instant, never a throw",
		covers: ["proof.checkpoint.publishedAt"],
		run: () => verify(resignedCheckpoint((c) => ({ ...c, publishedAt: IMPOSSIBLE_INSTANT }))),
		expect: failed("checkpoint", "CHECKPOINT_INVALID", "publishedAt"),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// §7 step 9 — what the served history binds. Upgrade-only: the base verdict
// stands, and only the history rung is refused.
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_ROWS: readonly Row[] = [
	{
		id: "history.successor-start-hash",
		value:
			"the receipt at its segment's LAST leaf; the served successor re-signed over another start hash",
		boundTo: "the successor's signed segmentStartPreviousHash === event.hash (the final event)",
		covers: ["event.hash"],
		run: () =>
			verify(
				{
					...FINAL_LEAF,
					...WITH_SUCCESSOR,
					...resignedCheckpoint((c) => ({ ...c, segmentStartPreviousHash: otherHash("final") }), 2),
				},
				{ history: true },
			),
		expect: historyFailed("though that event is the preceding segment's final event"),
	},
	{
		id: "history.previousSegmentRoot",
		value: "the receipt's checkpoint re-signed over another previousSegmentRoot (leaf 3)",
		boundTo: "the preceding history member's signed root",
		covers: ["proof.checkpoint.previousSegmentRoot"],
		run: () =>
			verify(
				resignedCheckpoint((c) => ({ ...c, previousSegmentRoot: otherHash("root") })),
				{
					history: true,
				},
			),
		expect: historyFailed("previousSegmentRoot is not the preceding checkpoint's root"),
	},
	{
		id: "history.previousSegmentId",
		value: "the receipt's checkpoint re-signed over another previousSegmentId",
		boundTo: "the preceding history member's signed segmentId",
		covers: ["proof.checkpoint.previousSegmentId"],
		run: () =>
			verify(
				resignedCheckpoint((c) => ({ ...c, previousSegmentId: "seg_000099" })),
				{
					history: true,
				},
			),
		expect: historyFailed("previousSegmentId does not name the preceding checkpoint's segment"),
	},
	{
		id: "history.two-successors",
		value: "the receipt at its segment's last leaf, with TWO honest successors served",
		boundTo: "only the IMMEDIATE successor starts from the receipt's event",
		declared: "control: the successor binding must not reach past the next member",
		covers: [],
		run: () =>
			verify(
				{
					segments: [
						...DEFAULT_SEGMENTS,
						{ segmentId: "seg_000004", segmentFirstSequence: 17, treeSize: 3 },
					],
					...FINAL_LEAF,
					...WITH_SUCCESSOR,
				},
				{ history: true },
			),
		expect: VERIFIED_HISTORY,
	},
	{
		id: "history.member.sig",
		value: "a history member's signature corrupted",
		boundTo: "Ed25519 under the chain's checkpoint lineage, for EVERY member",
		covers: [],
		run: () =>
			verify(
				{ history: (h) => h.map((c, i) => (i === 1 ? { ...c, sig: corruptBase64(c.sig) } : c)) },
				{ history: true },
			),
		expect: historyFailed("signature does not verify"),
	},
	{
		id: "history.member.vaultId",
		value: "a history member re-signed for another vault",
		boundTo: "the receipt's registered chain",
		covers: [],
		run: () =>
			verify(
				resignedCheckpoint((c) => ({ ...c, vaultId: "vlt_other_chain" }), 1),
				{ history: true },
			),
		expect: historyFailed("vaultId is not the receipt's chain"),
	},
	{
		id: "history.member.profile",
		value: "a history member re-signed under another profile",
		boundTo: "the chain's registered profile",
		covers: [],
		run: () =>
			verify(
				resignedCheckpoint((c) => ({ ...c, profile: "ut-chain-v1" }), 1),
				{ history: true },
			),
		expect: historyFailed("profile is not the chain's registered"),
	},
	{
		id: "history.member.segmentId-repeated",
		value: "a member served twice",
		boundTo: "§4a: one checkpoint per segment",
		covers: [],
		run: () =>
			verify(
				{ history: (h) => [h[0], h[1], h[1], h[2]] as SegmentCheckpoint[] },
				{ history: true },
			),
		expect: historyFailed("appears more than once"),
	},
	{
		id: "history.member.genesis",
		value: "a history that does not start at the registered genesis",
		boundTo: "the snapshot's genesisSegmentId",
		covers: [],
		run: () => verify({ history: (h) => h.slice(1) }, { history: true }),
		expect: historyFailed("not the registered genesis"),
	},
	{
		id: "history.member.genesis-sentinel",
		value: "the genesis member re-signed with a previousSegmentId that is not `genesis`",
		boundTo: "§4a: genesis values exact",
		covers: [],
		run: () =>
			verify(
				resignedCheckpoint((c) => ({ ...c, previousSegmentId: "seg_000000" }), 0),
				{
					history: true,
				},
			),
		expect: historyFailed("are not the fixed string"),
	},
	{
		id: "history.member.contiguity",
		value: "a one-sequence gap between two members",
		boundTo: "next.first === prev.first + (prev.treeSize − offset(prev))",
		covers: [],
		run: () => verify({ segments: GAPPED_SEGMENTS }, { history: true }),
		expect: historyFailed("the walk has a gap"),
	},
	{
		id: "history.member.key-role",
		value: "a history member signed by, and naming, the registered MINT key",
		boundTo: "step 6's key rules, applied to every member (role, lineage, state)",
		covers: [],
		run: () =>
			verify({ checkpointSigner: (i) => (i === 1 ? MINT_KEY : CHECKPOINT_KEY) }, { history: true }),
		expect: historyFailed("registered with role mint"),
	},
	{
		id: "history.member.format",
		value: "a history member re-signed with an impossible publishedAt",
		boundTo: "§4a's declared formats, applied to every member",
		covers: [],
		run: () =>
			verify(
				resignedCheckpoint((c) => ({ ...c, publishedAt: IMPOSSIBLE_INSTANT }), 1),
				{
					history: true,
				},
			),
		expect: historyFailed("publishedAt"),
	},
	{
		id: "history.member.not-increasing",
		value:
			"a member that holds only its chain link, so its successor's first sequence stands still",
		boundTo: "§7: segmentFirstSequence strictly increasing, beside contiguity",
		covers: [],
		run: () =>
			verify(
				{
					segments: [
						{ segmentId: "seg_000001", segmentFirstSequence: 1, treeSize: 4 },
						{ segmentId: "seg_000002", segmentFirstSequence: 5, treeSize: 1 },
						{ segmentId: "seg_000003", segmentFirstSequence: 5, treeSize: 7 },
					],
				},
				{ history: true },
			),
		expect: historyFailed("does not strictly increase"),
	},
	{
		id: "history.member.embedded-absent",
		value: "a history that ends before the receipt's own segment",
		boundTo: "§7: the embedded checkpoint appears EXACTLY in the history",
		covers: [],
		run: () => verify({ history: (h) => h.slice(0, 2) }, { history: true }),
		expect: historyFailed("does not appear EXACTLY"),
	},
	{
		id: "history.member.not-v2",
		value: "a member re-signed as v1",
		boundTo: "§7: a member that is not a v2 statement stops the walk",
		covers: [],
		run: () =>
			verify(
				resignedCheckpoint((c) => ({ ...c, v: 1 }), 1),
				{ history: true },
			),
		expect: historyFailed("not the v2 statement"),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// §7 steps 7–8 — semantics and the one derivation.
// ─────────────────────────────────────────────────────────────────────────────

const SEMANTIC_ROWS: readonly Row[] = [
	{
		id: "derivations.transferSetRoot",
		value: "transferSetRoot (≤ 32 pairs), re-hashed and re-signed",
		boundTo: "sha256(prefix ‖ canonicalize(transferSet)) — recomputed",
		covers: ["event.data.transferSetRoot"],
		run: () => verify(projectionMember("transferSetRoot", otherHash("root"))),
		expect: failed("derivations", "DERIVATION_MISMATCH"),
	},
	{
		id: "derivations.transferSet",
		value: "the transferSet's order changed, root left as minted",
		boundTo: "the recomputed transferSetRoot (the order is chain-committed)",
		covers: ["event.data.transferSet[]"],
		run: () => verify(projectionMember("transferSet", transferPairs(22).reverse())),
		expect: failed("derivations", "DERIVATION_MISMATCH"),
	},
	{
		id: "semantics.posted-vs-assessed",
		value: "postedUsertokens ≠ assessedUsertokens",
		boundTo: "§2: 0 < posted === assessed",
		covers: ["event.data.spend.postedUsertokens", "event.data.spend.assessedUsertokens"],
		run: () => verify(spendMember("postedUsertokens", 48223)),
		expect: failed("semantics", "SEMANTIC_INVALID", "postedUsertokens"),
	},
	{
		id: "semantics.roundingAdjustment",
		value: "roundingAdjustment above transferCount",
		boundTo: "§2: 0 ≤ roundingAdjustment ≤ transferCount",
		covers: ["event.data.spend.roundingAdjustment"],
		run: () => verify(spendMember("roundingAdjustment", 23)),
		expect: failed("semantics", "SEMANTIC_INVALID", "roundingAdjustment"),
	},
	{
		id: "semantics.transferCount",
		value: "transferCount ≠ the transferSet's length",
		boundTo: "§2: transferSet.length === transferCount",
		covers: ["event.data.spend.transferCount"],
		run: () => verify(spendMember("transferCount", 21)),
		expect: failed("semantics", "SEMANTIC_INVALID", "transferCount"),
	},
	{
		id: "semantics.usagePosture",
		value: "usagePosture outside its enum",
		boundTo: "§2's closed set",
		covers: ["event.data.spend.usagePosture"],
		run: () => verify(spendMember("usagePosture", "guessed")),
		expect: failed("semantics", "SEMANTIC_INVALID", "usagePosture"),
	},
	{
		id: "semantics.pricingPosture",
		value: "pricingPosture outside its enum",
		boundTo: "§2's closed set",
		covers: ["event.data.spend.pricingPosture"],
		run: () => verify(spendMember("pricingPosture", "approximate")),
		expect: failed("semantics", "SEMANTIC_INVALID", "pricingPosture"),
	},
	{
		id: "semantics.delegationPosture",
		value: "includesAllDelegated, with no evidence format to validate it",
		boundTo: "§2a: a claim that must be verifiable fails without evidence",
		covers: ["event.data.delegationPosture"],
		run: () => verify(projectionMember("delegationPosture", "includesAllDelegated")),
		expect: failed("semantics", "SEMANTIC_INVALID", "includesAllDelegated"),
	},
	{
		id: "semantics.generation",
		value: "generation 0",
		boundTo: "§2: an integer ≥ 1",
		covers: ["event.data.generation"],
		run: () => verify(projectionMember("generation", 0)),
		expect: failed("semantics", "SEMANTIC_INVALID", "generation"),
	},
	{
		id: "semantics.prevGenerationEventHash",
		value: "prevGenerationEventHash present at generation 1",
		boundTo: "§2: present iff generation > 1 (the OFFLINE half of linkage)",
		covers: ["event.data.prevGenerationEventHash"],
		run: () => verify(projectionMember("prevGenerationEventHash", otherHash("prev"))),
		expect: failed("semantics", "SEMANTIC_INVALID", "prevGenerationEventHash"),
	},
	{
		id: "semantics.sessionAssociation",
		value: "sessionAssociation outside its enum",
		boundTo: "§6a's two postures",
		covers: ["event.data.sessionAssociation"],
		run: () => verify(projectionMember("sessionAssociation", "assumed")),
		expect: failed("semantics", "SEMANTIC_INVALID", "sessionAssociation"),
	},
	{
		id: "semantics.workloadId",
		value: "workloadId absent on a workflowAttested receipt",
		boundTo: "§2: present iff workflowAttested",
		covers: ["event.data.workloadId"],
		run: () =>
			verify({
				projection: (p: Projection) => {
					const { workloadId: _dropped, ...rest } = p;
					return rest;
				},
			}),
		expect: failed("semantics", "SEMANTIC_INVALID", "workloadId"),
	},
	{
		id: "semantics.models",
		value: "models unsorted",
		boundTo: "§2: sorted-unique ASCII",
		covers: ["event.data.models[]"],
		run: () => verify(projectionMember("models", ["claude-sonnet-4-5", "claude-opus-4-5"])),
		expect: failed("semantics", "SEMANTIC_INVALID", "models"),
	},
	{
		id: "semantics.providers",
		value: "providers repeated",
		boundTo: "§2: sorted-unique ASCII",
		covers: ["event.data.providers[]"],
		run: () => verify(projectionMember("providers", ["anthropic", "anthropic"])),
		expect: failed("semantics", "SEMANTIC_INVALID", "providers"),
	},
	{
		id: "semantics.pricing.tableVersions",
		value: "tableVersions unsorted",
		boundTo: "§2: sorted-unique ASCII",
		covers: ["event.data.pricing.tableVersions[]"],
		run: () => verify(projectionMember("pricing", { tableVersions: ["2026-08-02", "2026-08-01"] })),
		expect: failed("semantics", "SEMANTIC_INVALID", "tableVersions"),
	},
	{
		id: "semantics.transfer-id",
		value: "a transfer ID that repeats across the list",
		boundTo: "§2: no transfer ID repeats, in either position",
		covers: [
			"event.data.transferSet[].authorizationTransferId",
			"event.data.transferSet[].settlementTransferId",
		],
		run: () =>
			verify({
				projection: (p: Projection) => {
					const pairs = transferPairs(22);
					pairs[1] = {
						...(pairs[1] as (typeof pairs)[number]),
						authorizationTransferId: pairs[0]?.authorizationTransferId as string,
					};
					return { ...p, transferSet: pairs };
				},
			}),
		expect: failed("semantics", "SEMANTIC_INVALID", "repeats"),
	},
	{
		id: "semantics.work.repo",
		value: "work.repo a local path, in the projection and its mirror",
		boundTo: "§2 public safety: <providerHost>/<owner>/<name>",
		covers: ["work[session].repo", "event.data.work[session].repo"],
		run: () => verify(workMember("repo", "/Users/someone/private/customer-acme")),
		expect: failed("semantics", "SEMANTIC_INVALID", "work.repo"),
	},
	{
		id: "semantics.work.kind-unknown",
		value: "work.kind outside §2's union, in the projection and its mirror",
		boundTo: "§2: exactly one union variant",
		covers: ["work[session].kind", "event.data.work[session].kind"],
		run: () => verify(workMember("kind", "workflow")),
		expect: failed("semantics", "SEMANTIC_INVALID", "matches no §2 union variant"),
	},
	{
		id: "semantics.work.origin",
		value: "a fallback session variant whose origin carries no source link",
		boundTo: "§2: origin REQUIRES sourceReservationReceiptId",
		covers: [
			"work[session].origin.sourceReservationReceiptId",
			"event.data.work[session].origin.sourceReservationReceiptId",
		],
		run: () => verify(workMember("origin", { kind: "billedUnfinalized" })),
		expect: failed("semantics", "SEMANTIC_INVALID", "sourceReservationReceiptId"),
	},
	{
		id: "semantics.work.origin-kind",
		value: "a fallback session variant whose origin.kind is not billedUnfinalized",
		boundTo: "§2: the fallback discriminator",
		covers: ["work[session].origin.kind", "event.data.work[session].origin.kind"],
		run: () =>
			verify(
				workMember("origin", { kind: "somethingElse", sourceReservationReceiptId: ALT_RECEIPT_ID }),
			),
		expect: failed("semantics", "SEMANTIC_INVALID", "origin.kind"),
	},
	{
		id: "schema.work.origin-source-id",
		value: "a fallback session variant whose source link is not a receipt id",
		boundTo: "§12: a canonical ut1 receipt id",
		covers: [
			"work[session].origin.sourceReservationReceiptId",
			"event.data.work[session].origin.sourceReservationReceiptId",
		],
		run: () =>
			verify(
				workMember("origin", {
					kind: "billedUnfinalized",
					sourceReservationReceiptId: "not-an-id",
				}),
			),
		expect: failed("schema", "SCHEMA_INVALID", "sourceReservationReceiptId"),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// DECLARED — unbound on purpose. Each must still verify.
// ─────────────────────────────────────────────────────────────────────────────

const DECLARED_ROWS: readonly Row[] = [
	{
		id: "declared.mintedAt",
		value: "mintedAt re-signed to another valid instant",
		boundTo: "the mint signature only",
		declared: "a minter-attested display value; no verdict reads it",
		covers: ["mintedAt"],
		run: () => verify(resignedReceipt((r) => ({ ...r, mintedAt: "2026-08-11T18:42:20.115Z" }))),
		expect: VERIFIED,
	},
	{
		id: "declared.chain-link-leaf-3",
		value: "at leaf 3 (the default), a tree built over a FORGED leaf 0, everything re-signed",
		boundTo: "the signed root commits to it; no proof node the receipt can rebuild contains it",
		declared:
			"at leaf 3 the link shares the level-1 node with leaf 1, and the receipt carries leaf 2 (its predecessor), not leaf 1",
		covers: [],
		run: () => verify({ chainLinkLeaf: () => otherHash("forged-chain-link") }),
		expect: VERIFIED,
	},
	{
		id: "declared.leaf-2-honest",
		value: "an honest receipt at leaf 2 of a seven-leaf non-genesis tree",
		boundTo: "sibling 1 is node(leafNode(link), leafNode(predecessor)), and it is",
		declared: "control: the leaf-2 node binding accepts an honest tree",
		covers: [],
		run: () => verify({ mintLeafIndex: 2 }),
		expect: VERIFIED,
	},
	{
		id: "declared.leaf-2-honest-promoted",
		value: "an honest receipt at leaf 2 of a three-leaf non-genesis tree",
		boundTo: "sibling 0 is that node once level 0 promotes leaf 2, and it is",
		declared: "control: the promotion rule picks the right sibling",
		covers: [],
		run: () => verify(PROMOTED_LEAF_2),
		expect: VERIFIED,
	},
	{
		id: "declared.predecessor-even-leaf",
		value: "at leaf 4, the event re-hashed over a previousHash that is not leaf 3",
		boundTo: "the signed root commits to leaf 3; no proof node the receipt can rebuild contains it",
		declared:
			"at an even leaf past 2 the predecessor shares an interior node with leaves the receipt does not carry",
		covers: [],
		run: () =>
			verify({ mintLeafIndex: 4, event: (e) => ({ ...e, previousHash: otherHash("not-leaf-3") }) }),
		expect: VERIFIED,
	},
	{
		id: "declared.predecessor-genesis-leaf-2",
		value: "at leaf 2 of the GENESIS segment, a previousHash that is not leaf 1",
		boundTo: "the signed root commits to leaf 1; the node over leaves 0 and 1 needs leaf 0",
		declared:
			"a genesis segment's leaf 0 is its first event, which the receipt at leaf 2 does not carry",
		covers: [],
		run: () =>
			verify({
				mintSegmentIndex: 0,
				mintLeafIndex: 2,
				event: (e) => ({ ...e, previousHash: otherHash("not-leaf-1") }),
			}),
		expect: VERIFIED,
	},
	{
		id: "declared.genesis-leaf-1",
		value: "an honest receipt at leaf 1 of the GENESIS segment",
		boundTo: "the predecessor node (a genesis tree has no chain link), and it holds",
		declared:
			"control: leaf 1's level-0 sibling is an EVENT here, so the predecessor binding applies and the chain-link one must not",
		covers: [],
		run: () => verify({ mintSegmentIndex: 0, mintLeafIndex: 1 }),
		expect: VERIFIED,
	},
	{
		id: "declared.genesis-leaf-0",
		value: "an honest receipt at leaf 0 of the GENESIS segment",
		boundTo: "the all-zero start hash (bound, and honest here)",
		declared: "the control for the genesis arm of the first-event binding",
		covers: [],
		run: () => verify({ mintSegmentIndex: 0, mintLeafIndex: 0 }),
		expect: VERIFIED,
	},
	{
		id: "declared.spend-vs-ledger",
		value: "assessed = posted = 99999, re-hashed and re-signed",
		boundTo: "the ledger, which is not offline material",
		declared:
			"the amounts are minter-attested: the mint signature binds what was said, not what was charged",
		covers: ["event.data.spend"],
		run: () =>
			verify({
				projection: (p: Projection) => ({
					...p,
					spend: {
						...(p.spend as Record<string, unknown>),
						assessedUsertokens: 99999,
						postedUsertokens: 99999,
					},
				}),
			}),
		expect: VERIFIED,
	},
	{
		id: "declared.transferSetRoot-without-set",
		value: "transferSetRoot changed on a 37-pair receipt (no inline set)",
		boundTo: "a commitment, checkable only against disclosed pairs",
		declared: "nothing in the receipt to recompute it from",
		covers: ["event.data.transferSetRoot"],
		run: () =>
			verify({
				projectionOptions: { transferCount: 37 },
				...projectionMember("transferSetRoot", otherHash("undisclosed")),
			}),
		expect: VERIFIED,
	},
	{
		id: "declared.models-providers-pricing",
		value: "models, providers and tableVersions re-valued",
		boundTo: "the published catalog, which is not offline material",
		declared: "catalog MEMBERSHIP is not decidable from the receipt; only the shape is",
		covers: ["event.data.models[]", "event.data.providers[]", "event.data.pricing.tableVersions[]"],
		run: () =>
			verify({
				projection: (p: Projection) => ({
					...p,
					models: ["custom"],
					providers: ["openai"],
					pricing: { tableVersions: ["2019-01-01"] },
				}),
			}),
		expect: VERIFIED,
	},
	{
		id: "declared.temporal-order",
		value: "mintedAt before the event; event.timestamp after its checkpoint's publishedAt",
		boundTo: "three clocks: the chain's, the checkpoint signer's, the minter's",
		declared:
			"the signers share no clock, so event.timestamp ≤ publishedAt ≤ mintedAt is not a rule a verifier can hold",
		covers: [],
		run: () =>
			verify({
				event: (e) => ({ ...e, timestamp: "2027-01-01T00:00:00.000Z" }),
				...resignedReceipt((r) => ({ ...r, mintedAt: "2020-01-01T00:00:00.000Z" })),
			}),
		expect: VERIFIED,
	},
	{
		id: "declared.backward-link-start-hash",
		value: "at leaf 3, the checkpoint re-signed over another non-zero segmentStartPreviousHash",
		boundTo: "the PREDECESSOR's final event hash",
		declared:
			"no signed statement carries N−1's final event; only at the first event (leaf offset) is the start hash in hand",
		covers: ["proof.checkpoint.segmentStartPreviousHash"],
		run: () =>
			verify(resignedCheckpoint((c) => ({ ...c, segmentStartPreviousHash: otherHash("s") }))),
		expect: VERIFIED,
	},
	{
		id: "declared.backward-link-edge",
		value: "at leaf 3, previousSegmentRoot and previousSegmentId re-signed (no history served)",
		boundTo: "the predecessor's signed root and segmentId — in the served history",
		declared:
			"the N−1 link is history-only: the base verdict has no N−1 (the history rows bind it)",
		covers: ["proof.checkpoint.previousSegmentRoot", "proof.checkpoint.previousSegmentId"],
		run: () =>
			verify(
				resignedCheckpoint((c) => ({
					...c,
					previousSegmentRoot: otherHash("edge"),
					previousSegmentId: "seg_000099",
				})),
			),
		expect: VERIFIED,
	},
	{
		id: "declared.successor-absent",
		value: "a receipt at its segment's LAST leaf, the history ending at its own segment",
		boundTo: "the successor's signed start hash — not served",
		declared:
			"§7's history needs a head at/after the receipt's segment; with no successor there is nothing to bind",
		covers: [],
		run: () => verify(FINAL_LEAF, { history: true }),
		expect: VERIFIED_HISTORY,
	},
	{
		id: "declared.successor-of-a-middle-event",
		value:
			"the successor re-signed over another start hash, the receipt NOT at its segment's last leaf",
		boundTo: "the predecessor's final event — not in hand",
		declared: "only a final-leaf receipt carries the event a successor starts from",
		covers: [],
		run: () =>
			verify(
				{
					mintSegmentIndex: 1,
					mintLeafIndex: 3,
					...WITH_SUCCESSOR,
					...resignedCheckpoint((c) => ({ ...c, segmentStartPreviousHash: otherHash("mid") }), 2),
				},
				{ history: true },
			),
		expect: VERIFIED_HISTORY,
	},
	{
		id: "declared.publishedAt",
		value: "publishedAt re-signed to another valid instant",
		boundTo: "the store's published row (N/A offline)",
		declared:
			"no offline statement repeats it, and its order against the other clocks is not a rule",
		covers: ["proof.checkpoint.publishedAt"],
		run: () =>
			verify(resignedCheckpoint((c) => ({ ...c, publishedAt: "2026-08-14T00:00:00.000Z" }))),
		expect: VERIFIED,
	},
	{
		id: "declared.receiptId-no-arrival",
		value: "receiptId re-signed to another valid id, no arrival context",
		boundTo: "the registry (online) and the arrival context (absent here)",
		declared: "step 3(a) has nothing to compare and is notApplicable; 3(b) is online",
		covers: ["receiptId"],
		run: () => verify({ receiptId: ALT_RECEIPT_ID }),
		expect: VERIFIED,
	},
	{
		id: "declared.sessionId",
		value: "sessionId re-valued, re-hashed and re-signed",
		boundTo: "the registry's (vault, session, generation) row (online)",
		declared: "an opaque identity the minter assigns",
		covers: ["event.data.sessionId"],
		run: () => verify(projectionMember("sessionId", "01K2Q7V8ZC4M6N0PABCDEF3XYA")),
		expect: VERIFIED,
	},
	{
		id: "declared.prevGenerationEventHash",
		value: "an addendum's prevGenerationEventHash re-valued",
		boundTo: "predecessorLinkage against the registry (online)",
		declared: "only its presence and form are offline rules",
		covers: ["event.data.prevGenerationEventHash"],
		run: () =>
			verify({
				projectionOptions: { generation: 2 },
				...projectionMember("prevGenerationEventHash", otherHash("another-prev")),
			}),
		expect: VERIFIED,
	},
	{
		id: "declared.work.repoId-workloadId",
		value: "work.repoId and workloadId re-valued, in the projection and its mirror",
		boundTo: "the provider and the orchestrator, neither offline material",
		declared: "minter-attested identifiers; only their syntax is an offline rule",
		covers: ["work[session].repoId", "event.data.work[session].repoId", "event.data.workloadId"],
		run: () =>
			verify({
				projection: (p: Projection) => ({
					...p,
					work: { ...(p.work as Record<string, unknown>), repoId: "github.com:R_other" },
					workloadId: "wl_other",
				}),
			}),
		expect: VERIFIED,
	},
	{
		id: "declared.arrival-context",
		value: "the receipt arriving under its own id",
		boundTo: "step 3(a): the arrival id",
		declared: "the control for the ID_MISMATCH row below",
		covers: [],
		run: () => verify({}, { arrivalId: DEFAULT_RECEIPT_ID }),
		expect: VERIFIED,
	},
];

/** Step 3(a), the one row that needs an arrival context. */
const REGISTRY_ROWS: readonly Row[] = [
	{
		id: "registry.receiptId-arrival",
		value: "receiptId re-signed to another valid id, arriving under the original",
		boundTo: "step 3(a): the id the document arrived under",
		covers: ["receiptId"],
		run: () => verify({ receiptId: ALT_RECEIPT_ID }, { arrivalId: DEFAULT_RECEIPT_ID }),
		expect: failed("registry", "ID_MISMATCH"),
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// NOT APPLICABLE — bindings that live where this verifier is not.
// ─────────────────────────────────────────────────────────────────────────────

const NOT_APPLICABLE_ROWS: readonly NotApplicableRow[] = [
	{
		id: "n/a.signedBytesSha256",
		value: "a stored-bytes digest beside the receipt",
		boundTo: "sha256 of the stored bytes (a resolver storage row)",
		reason:
			"this verifier takes the BYTES as the artifact and the mint signature covers them; --envelope's analog is canonical-base64 receiptBytes plus the bytes↔copy agreement check, a CLI-layer ENVELOPE_INVALID",
	},
	{
		id: "n/a.registryBinding",
		value: "receiptId → event.hash",
		boundTo: "the registry (§7 step 3(b), ID_MISMATCH)",
		reason: "offline, registryBinding is notApplicable by rule",
	},
	{
		id: "n/a.registry-row",
		value: "the registry row's vault, session, generation and settled sequence",
		boundTo: "the registry",
		reason: "online only",
	},
	{
		id: "n/a.predecessorLinkage",
		value: "prevGenerationEventHash",
		boundTo: "the registry's event.hash at generation − 1 (PREDECESSOR_MISMATCH)",
		reason:
			"offline, predecessorLinkage is notApplicable by rule; the offline half is a semantics row",
	},
	{
		id: "n/a.published-row",
		value:
			"checkpoint.{previousSegmentRoot, previousSegmentId, segmentStartPreviousHash, publishedAt}",
		boundTo: "the store's published row for the segment (equivocation check)",
		reason:
			"offline there is only the embedded statement and the served history; the history rows and the leaf-1 and first-event rows bind what can be bound",
	},
	{
		id: "n/a.terminal-anchor",
		value: "segment N+1 sealed and verified",
		boundTo: "the store's successor checkpoint",
		reason:
			"§7 requires no successor offline; when one is SERVED, step 9 binds its start hash (history.successor-start-hash)",
	},
	{
		id: "n/a.anchorEvidence",
		value: "Rekor anchor evidence",
		boundTo: "a pinned transparency-log key",
		reason: "this build validates no anchor evidence and reports it as unimplemented",
	},
];

const MATRIX: readonly Row[] = [
	...SCHEMA_ROWS,
	...WORK_KIND_ROWS,
	...SIGNATURE_ROWS,
	...EVENT_ENVELOPE_ROWS,
	...EVENT_DATA_ROWS,
	...EQUALITY_ROWS,
	...BOUNDARY_ROWS,
	...REGISTRY_ROWS,
	...INCLUSION_ROWS,
	...CHECKPOINT_ROWS,
	...HISTORY_ROWS,
	...SEMANTIC_ROWS,
	...DECLARED_ROWS,
];

// ─────────────────────────────────────────────────────────────────────────────
// The walk.
// ─────────────────────────────────────────────────────────────────────────────

describe("the binding matrix", () => {
	it("has unique row ids, and every DECLARED row says why and expects a pass", () => {
		const ids = [...MATRIX.map((r) => r.id), ...NOT_APPLICABLE_ROWS.map((r) => r.id)];
		expect(new Set(ids).size).toBe(ids.length);
		for (const row of MATRIX) {
			const passes = row.expect.verdict !== "FAILED" && row.expect.verdict !== "UNVERIFIABLE";
			expect(row.declared !== undefined, row.id).toBe(passes && !("history" in row.expect));
		}
		for (const row of NOT_APPLICABLE_ROWS) expect(row.reason.length, row.id).toBeGreaterThan(0);
	});

	it("starts from a clean bundle that verifies", () => {
		expect(verify().verdict).toBe("VERIFIED_CHECKPOINT");
		expect(verify({}, { history: true }).verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
	});

	for (const row of MATRIX) {
		it(`${row.id} — ${row.value}`, () => {
			assertOutcome(row, row.run());
		});
	}

	it("names every member the verifier's own field table declares, by EXACT path", () => {
		// A member added to the signed receipt fails here until a row names it —
		// except inside a REFUSED artifact variant, whose every member is refused
		// with it (§2, v0.9.6).
		const refused = ["work[commit]", "work[pr]", "work[issue]"].flatMap((v) => [
			v,
			`event.data.${v}`,
		]);
		const under = (path: string, prefix: string): boolean =>
			path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
		const paths = receiptFieldFormats().map((field) => field.path);
		const named = new Set(MATRIX.flatMap((row) => row.covers));
		const unnamed = paths.filter(
			(path) => !named.has(path) && !refused.some((prefix) => under(path, prefix)),
		);
		expect(unnamed).toEqual([]);
		// …and every name a row gives is a real member or a real subtree.
		expect([...named].filter((name) => !paths.some((path) => under(path, name)))).toEqual([]);
	});
});
