// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * External Anchor Verification — Zero-dependency standalone
 *
 * INTENTIONAL DUPLICATION: this file exists byte-for-byte in BOTH
 * packages/verify/src/anchor-verify.ts and
 * packages/core/src/audit/anchor-verify.ts — only the import paths differ.
 * The anchor differential/parity tests pin the two together; any change must
 * land in both packages.
 *
 * Verifies signed anchor checkpoints (spec: docs/superpowers/specs/
 * 2026-07-26-external-anchoring-design.md) against a caller-pinned trust root:
 *  - strict record parsing (unknown fields / range violations are INVALID)
 *  - Ed25519 signature verification via node:crypto (ECDSA P-256 helper kept
 *    alg-agile for Phase 2 transparency-log checkpoints)
 *  - anchor-chain verification: prevAnchorHash linkage, anchorSeq contiguity,
 *    key epochs via cross-signed rotation records, fork/duplicate semantics
 *  - vault binding: Merkle root / head hash at each anchored treeSize, with
 *    externally-bound consistency proofs between anchors
 *  - the spec §7.2 state machine (UNANCHORED / ANCHORED_VERIFIED / ANCHOR_STALE
 *    / ANCHOR_UNVERIFIABLE / ANCHOR_INVALID / ANCHOR_MISMATCH)
 *
 * Trust NEVER comes from the vault under audit: the caller pins the genesis
 * root key (and optional rotation-successor pins) out-of-band.
 */

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GENESIS_HASH } from "../shared/constants.js";
import { canonicalize } from "./canonical.js";
import {
	buildMerkleTree,
	generateConsistencyProof,
	type MerkleInclusionProof,
	verifyConsistencyProof,
	verifyInclusionProof,
} from "./merkle.js";

// ── Types ──

export interface AnchorRotation {
	readonly nextKeyId: string;
	readonly nextPublicKeySpki: string;
}

export interface AnchorRecord {
	readonly v: 1;
	readonly vaultId: string;
	readonly anchorSeq: number;
	readonly prevAnchorHash: string;
	readonly treeSize: number;
	readonly lastHash: string;
	readonly merkleRoot: string;
	readonly timestamp: string;
	readonly keyId: string;
	readonly rotation?: AnchorRotation;
	readonly sig: string;
}

/** Caller-pinned trust material. NEVER read from the vault under audit. */
export interface AnchorTrust {
	/** THE pinned genesis root key (PEM). anchorSeq 1 MUST verify under it. */
	readonly rootPem: string;
	/** Optional out-of-band pins for rotation successors. */
	readonly successorPinsPem?: readonly string[];
}

export type AnchorState =
	| "UNANCHORED"
	| "ANCHORED_VERIFIED"
	| "ANCHOR_STALE"
	| "ANCHOR_UNVERIFIABLE"
	| "ANCHOR_INVALID"
	| "ANCHOR_MISMATCH";

export type AnchorSource = "external" | "vault-mirror" | "none";
export type WitnessStatus = "agrees" | "disagrees" | "unreachable" | "not-consulted";

export interface WitnessInput {
	readonly requested: boolean;
	readonly ok?: boolean;
	readonly error?: string;
}

export interface AnchorEvaluationOptions {
	readonly maxAnchorAgeMs?: number;
	readonly maxUnanchoredEvents?: number;
	readonly expectedVaultId?: string;
	/** Injectable clock for tests. Defaults to Date.now(). */
	readonly nowMs?: number;
}

export interface AnchorEvaluationInput {
	/** Globally sequence-ordered stored event hashes (verifyVault ordering). */
	readonly orderedHashes: readonly string[];
	/** Caller-fetched external anchor records (already parsed). */
	readonly externalAnchors: readonly AnchorRecord[];
	/** Parse errors from caller-supplied artifacts (fail-closed). */
	readonly externalErrors: readonly string[];
	/** Records from the vault-local mirror — CACHE, never a trust root alone. */
	readonly mirrorAnchors: readonly AnchorRecord[];
	readonly mirrorErrors: readonly string[];
	readonly trust: AnchorTrust | null;
	readonly witness: WitnessInput;
	readonly opts?: AnchorEvaluationOptions;
}

export interface AnchorEvaluation {
	anchorState: AnchorState;
	/** false only on ANCHOR_INVALID / ANCHOR_MISMATCH. */
	anchorsValid: boolean;
	anchorSource: AnchorSource;
	anchorCount: number;
	latestAnchor: {
		anchorSeq: number;
		treeSize: number;
		lastHash: string;
		keyId: string;
		timestamp: string;
	} | null;
	unanchoredTail: { events: number; sinceTimestampMs: number | null };
	witness: { requested: boolean; status: WitnessStatus; error?: string };
	reasons: string[];
	warnings: string[];
	errors: string[];
}

function nullIfNaN(n: number): number | null {
	return Number.isFinite(n) ? n : null;
}

// ── Reason-code classes (see spec §7.2) ──

const INVALID_REASONS = new Set(["malformed-anchor", "range-invalid", "sig-invalid"]);
const NON_FAIL_REASONS = new Set(["no-trust-material", "witness-unreachable"]);

// ── Strict parsing ──

const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^sha256:[0-9a-f]{64}$/;
const RECORD_KEYS = new Set([
	"v",
	"vaultId",
	"anchorSeq",
	"prevAnchorHash",
	"treeSize",
	"lastHash",
	"merkleRoot",
	"timestamp",
	"keyId",
	"rotation",
	"sig",
]);
const ROTATION_KEYS = new Set(["nextKeyId", "nextPublicKeySpki"]);

function isSafePositiveInt(n: unknown): n is number {
	return typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
}

/**
 * Strict parse of a single anchor record. Unknown fields, missing fields, and
 * range violations are all rejected (fail-closed — spec §3 strict-parse rules;
 * range checks run BEFORE any Merkle primitive so a validly-signed-but-
 * degenerate record yields a deterministic verdict, never a throw).
 * Returns `{ record }` or `{ error }` with a code-prefixed message.
 */
export function parseAnchorRecord(raw: string): {
	record: AnchorRecord | null;
	error: string | null;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { record: null, error: "malformed-anchor: not valid JSON" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { record: null, error: "malformed-anchor: not an object" };
	}
	const obj = parsed as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (!RECORD_KEYS.has(key)) {
			return { record: null, error: `malformed-anchor: unknown field "${key}"` };
		}
	}
	if (obj.v !== 1) {
		return { record: null, error: "malformed-anchor: unsupported version" };
	}
	if (typeof obj.vaultId !== "string" || obj.vaultId.length === 0) {
		return { record: null, error: "malformed-anchor: missing vaultId" };
	}
	if (!isSafePositiveInt(obj.anchorSeq)) {
		return { record: null, error: "range-invalid: anchorSeq must be a safe integer >= 1" };
	}
	if (!isSafePositiveInt(obj.treeSize)) {
		return { record: null, error: "range-invalid: treeSize must be a safe integer >= 1" };
	}
	if (typeof obj.prevAnchorHash !== "string" || !HEX64.test(obj.prevAnchorHash)) {
		return { record: null, error: "malformed-anchor: prevAnchorHash must be 64-hex" };
	}
	if (typeof obj.lastHash !== "string" || !HEX64.test(obj.lastHash)) {
		return { record: null, error: "malformed-anchor: lastHash must be 64-hex" };
	}
	if (typeof obj.merkleRoot !== "string" || !HEX64.test(obj.merkleRoot)) {
		return { record: null, error: "malformed-anchor: merkleRoot must be 64-hex" };
	}
	if (
		typeof obj.timestamp !== "string" ||
		obj.timestamp.length === 0 ||
		!Number.isFinite(Date.parse(obj.timestamp))
	) {
		// A signed-but-unparseable timestamp would make the --max-anchor-age
		// staleness gate silently fail open (Date.parse → NaN) — an
		// adversary-controlled bypass of the caller's freshness policy.
		return { record: null, error: "malformed-anchor: timestamp must be a parseable date-time" };
	}
	if (typeof obj.keyId !== "string" || !KEY_ID.test(obj.keyId)) {
		return { record: null, error: "malformed-anchor: keyId must be sha256:<64-hex>" };
	}
	if (typeof obj.sig !== "string" || obj.sig.length === 0) {
		return { record: null, error: "malformed-anchor: missing sig" };
	}
	if (obj.rotation !== undefined) {
		const rot = obj.rotation;
		if (rot === null || typeof rot !== "object" || Array.isArray(rot)) {
			return { record: null, error: "malformed-anchor: rotation must be an object" };
		}
		const rotObj = rot as Record<string, unknown>;
		for (const key of Object.keys(rotObj)) {
			if (!ROTATION_KEYS.has(key)) {
				return { record: null, error: `malformed-anchor: unknown rotation field "${key}"` };
			}
		}
		if (typeof rotObj.nextKeyId !== "string" || !KEY_ID.test(rotObj.nextKeyId)) {
			return {
				record: null,
				error: "malformed-anchor: rotation.nextKeyId must be sha256:<64-hex>",
			};
		}
		if (
			typeof rotObj.nextPublicKeySpki !== "string" ||
			Buffer.from(rotObj.nextPublicKeySpki, "base64").length === 0
		) {
			return {
				record: null,
				error: "malformed-anchor: rotation.nextPublicKeySpki must be base64",
			};
		}
	}
	return { record: obj as unknown as AnchorRecord, error: null };
}

/** Parse a JSONL (or single-JSON) anchors artifact. Every line must parse. */
export function parseAnchorsContent(content: string): {
	records: AnchorRecord[];
	errors: string[];
} {
	const records: AnchorRecord[] = [];
	const errors: string[] = [];
	const lines = content
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	for (let i = 0; i < lines.length; i++) {
		const { record, error } = parseAnchorRecord(lines[i] as string);
		if (record) {
			records.push(record);
		} else {
			errors.push(`anchor line ${i + 1}: ${error}`);
		}
	}
	return { records, errors };
}

// ── Crypto helpers ──

/** Signing pre-image = canonicalize(record − sig). Spec §3. */
export function anchorSigningPreimage(record: AnchorRecord): string {
	const { sig: _sig, ...rest } = record;
	return canonicalize(rest);
}

/** sha256 hex of the signing pre-image — what the successor's prevAnchorHash carries. */
export function anchorPayloadHash(record: AnchorRecord): string {
	return createHash("sha256").update(anchorSigningPreimage(record), "utf8").digest("hex");
}

export function keyIdFromSpkiDer(der: Buffer): string {
	return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function publicKeyFromPem(pem: string): KeyObject | null {
	try {
		return createPublicKey(pem);
	} catch {
		return null;
	}
}

export function publicKeyFromSpkiBase64(b64: string): KeyObject | null {
	try {
		return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
	} catch {
		return null;
	}
}

export function keyIdFromKeyObject(key: KeyObject): string {
	return keyIdFromSpkiDer(key.export({ type: "spki", format: "der" }) as Buffer);
}

/**
 * Raw signature verification over UTF-8 data. Ed25519 for usertrust anchor
 * records; ECDSA P-256 kept alg-agile for Phase 2 transparency-log checkpoints
 * (Rekor signs with ECDSA — spec reconciliation R2). Never throws.
 */
export function verifySignatureRaw(
	alg: "ed25519" | "ecdsa-p256",
	dataUtf8: string,
	publicKey: KeyObject,
	sigBase64: string,
): boolean {
	const data = Buffer.from(dataUtf8, "utf8");
	const sig = Buffer.from(sigBase64, "base64");
	if (sig.length === 0) return false;
	try {
		if (alg === "ed25519") {
			return cryptoVerify(null, data, publicKey, sig);
		}
		return (
			cryptoVerify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig) ||
			cryptoVerify("sha256", data, { key: publicKey, dsaEncoding: "der" }, sig)
		);
	} catch {
		return false;
	}
}

/**
 * Verify one record's Ed25519 signature against explicit candidate keys.
 * The candidate whose keyId matches the record's keyId is used; a record whose
 * keyId matches none of the candidates fails with a distinct error.
 */
export function verifyAnchorSignature(
	record: AnchorRecord,
	candidateKeysPem: readonly string[],
): { ok: boolean; keyId: string; errors: string[] } {
	const errors: string[] = [];
	for (const pem of candidateKeysPem) {
		const key = publicKeyFromPem(pem);
		if (key === null) {
			errors.push("sig-invalid: unparseable candidate public key");
			continue;
		}
		if (keyIdFromKeyObject(key) !== record.keyId) continue;
		if (verifySignatureRaw("ed25519", anchorSigningPreimage(record), key, record.sig)) {
			return { ok: true, keyId: record.keyId, errors: [] };
		}
		errors.push(`sig-invalid: signature does not verify under keyId ${record.keyId}`);
		return { ok: false, keyId: record.keyId, errors };
	}
	errors.push(`sig-invalid: no candidate key matches keyId ${record.keyId}`);
	return { ok: false, keyId: record.keyId, errors };
}

// ── Duplicate / fork semantics (spec §7.2) ──

/** Committed-field equality: everything except timestamp and sig. */
export function committedFieldsEqual(a: AnchorRecord, b: AnchorRecord): boolean {
	const strip = (r: AnchorRecord): string => {
		const { sig: _s, timestamp: _t, ...rest } = r;
		return canonicalize(rest);
	};
	return strip(a) === strip(b);
}

/**
 * Collapse same-anchorSeq records WITHIN one stream (store or mirror):
 * identical committed content = benign duplicate (warn, keep first);
 * divergent committed content = fork evidence (MISMATCH).
 */
export function dedupeAnchorSet(records: readonly AnchorRecord[]): {
	unique: AnchorRecord[];
	/** Committed-equal twins collapsed out — still signature-checked by the walk. */
	dropped: AnchorRecord[];
	warnings: string[];
	errors: string[];
	mismatchReasons: string[];
} {
	const warnings: string[] = [];
	const errors: string[] = [];
	const mismatchReasons: string[] = [];
	const dropped: AnchorRecord[] = [];
	const bySeq = new Map<number, AnchorRecord>();
	for (const r of records) {
		const existing = bySeq.get(r.anchorSeq);
		if (existing === undefined) {
			bySeq.set(r.anchorSeq, r);
		} else if (committedFieldsEqual(existing, r)) {
			// Benign duplicate ONLY if its signature also verifies — the walk
			// re-checks every dropped twin under its epoch key (spec §7.2
			// "both signatures valid"). Order must not decide the verdict.
			warnings.push("duplicate-anchor");
			dropped.push(r);
		} else {
			errors.push(
				`fork: divergent records at anchorSeq ${r.anchorSeq} (same position, different committed content)`,
			);
			mismatchReasons.push("fork");
		}
	}
	const unique = [...bySeq.values()].sort((a, b) => a.anchorSeq - b.anchorSeq);
	return { unique, dropped, warnings, errors, mismatchReasons };
}

// ── Anchor chain verification ──

export interface AnchorChainResult {
	/** anchorSeq-ordered records that entered the walk. */
	records: AnchorRecord[];
	errors: string[];
	/** ANCHOR_INVALID-class reason codes. */
	invalidReasons: string[];
	/** ANCHOR_MISMATCH-class reason codes. */
	mismatchReasons: string[];
	warnings: string[];
}

/**
 * Verify the anchor stream as its own hash chain under the pinned trust root:
 * signatures per key epoch (rotations walked forward from the root),
 * prevAnchorHash linkage from GENESIS, anchorSeq contiguity from 1, treeSize
 * monotonicity, single vaultId, and — when event hashes are supplied —
 * consistency binding between consecutive anchored roots. The proof's
 * firstRoot/secondRoot are compared to the SIGNED roots before
 * verifyConsistencyProof is called: the bare call checks only internal proof
 * consistency and passes unconditionally on locally generated proofs
 * (spec §7.2 — omitting the binding recreates F1).
 *
 * Callers pass a set already deduped per stream (dedupeAnchorSet); same-seq
 * survivors here are treated as forks.
 */
export function verifyAnchorChain(
	records: readonly AnchorRecord[],
	trust: AnchorTrust,
	eventHashes?: readonly string[],
): AnchorChainResult {
	const errors: string[] = [];
	const invalidReasons: string[] = [];
	const mismatchReasons: string[] = [];
	const warnings: string[] = [];

	const rootKey = publicKeyFromPem(trust.rootPem);
	if (rootKey === null) {
		errors.push("trust root public key is not a parseable PEM");
		invalidReasons.push("sig-invalid");
		return { records: [], errors, invalidReasons, mismatchReasons, warnings };
	}
	const pinKeyIds = new Set<string>();
	const knownKeys = new Map<string, KeyObject>();
	const rootKeyId = keyIdFromKeyObject(rootKey);
	knownKeys.set(rootKeyId, rootKey);
	for (const pem of trust.successorPinsPem ?? []) {
		const k = publicKeyFromPem(pem);
		if (k !== null) {
			const id = keyIdFromKeyObject(k);
			pinKeyIds.add(id);
			knownKeys.set(id, k);
		}
	}

	// A mixed-vaultId set is rejected wholesale, BEFORE dedup can collapse a
	// replayed foreign record into a same-seq group (cross-vault replay).
	const vaultIds = new Set(records.map((r) => r.vaultId));
	if (vaultIds.size > 1) {
		errors.push(`vault-id-mismatch: anchor set mixes ${vaultIds.size} distinct vaultIds`);
		mismatchReasons.push("vault-id-mismatch");
	}

	const dedup = dedupeAnchorSet(records);
	warnings.push(...dedup.warnings);
	errors.push(...dedup.errors);
	mismatchReasons.push(...dedup.mismatchReasons);
	const ordered = dedup.unique;
	const droppedBySeq = new Map<number, AnchorRecord[]>();
	for (const d of dedup.dropped) {
		const list = droppedBySeq.get(d.anchorSeq) ?? [];
		list.push(d);
		droppedBySeq.set(d.anchorSeq, list);
	}

	let epochKeyId = rootKeyId;
	let epochKey: KeyObject | null = rootKey;
	let prev: AnchorRecord | null = null;

	// A partial history may legitimately START in a later key epoch — the
	// documented lone-checkpoint bind (§7.5) fetched after a rotation. When
	// the first record's key is a caller-TRUSTED key (root or successor pin),
	// adopt it as the starting epoch instead of condemning the unprovable
	// prefix; an untrusted key stays fail-closed (sig-invalid below).
	const firstRecord = ordered[0];
	if (firstRecord !== undefined && firstRecord.anchorSeq !== 1 && firstRecord.keyId !== rootKeyId) {
		const pinnedStart = knownKeys.get(firstRecord.keyId);
		if (pinnedStart !== undefined) {
			epochKeyId = firstRecord.keyId;
			epochKey = pinnedStart;
		}
	}

	for (let i = 0; i < ordered.length; i++) {
		const r = ordered[i] as AnchorRecord;

		if (i === 0 && r.anchorSeq !== 1) {
			// A supplied history that simply does not START at genesis (e.g. the
			// documented single-checkpoint bind, §7.5) is PARTIAL, not tampered:
			// the missing prefix is unprovable, not proof of deletion, and every
			// present record still binds to the vault content. A gap BETWEEN two
			// present records (checked below) remains a hard MISMATCH.
			warnings.push("partial-history");
		}
		if (prev !== null && r.anchorSeq !== prev.anchorSeq + 1) {
			errors.push(`anchor-chain-gap: anchorSeq ${r.anchorSeq} follows ${prev.anchorSeq}`);
			mismatchReasons.push("anchor-chain-gap");
		}
		if (r.anchorSeq === 1 && r.prevAnchorHash !== GENESIS_HASH) {
			errors.push("anchor-chain-gap: anchorSeq 1 prevAnchorHash must be GENESIS");
			mismatchReasons.push("anchor-chain-gap");
		}
		if (prev !== null && r.anchorSeq === prev.anchorSeq + 1) {
			// The predecessor may exist as several benign committed-equal twins
			// (differing only in timestamp/sig — racing-emitter duplicates), and
			// timestamp IS part of the signing pre-image: the successor
			// legitimately links to WHICHEVER twin its emitter had as the mirror
			// tail, so linkage accepts any twin's payload hash.
			const prevTwins = [prev, ...(droppedBySeq.get(prev.anchorSeq) ?? [])];
			if (!prevTwins.some((t) => r.prevAnchorHash === anchorPayloadHash(t))) {
				errors.push(
					`anchor-chain-gap: anchorSeq ${r.anchorSeq} prevAnchorHash does not link to its predecessor`,
				);
				mismatchReasons.push("anchor-chain-gap");
			}
		}
		if (prev !== null && r.treeSize < prev.treeSize) {
			errors.push(
				`anchor monotonicity violation: treeSize ${r.treeSize} at anchorSeq ${r.anchorSeq} decreases from ${prev.treeSize}`,
			);
			mismatchReasons.push("rollback");
		}
		if (prev !== null && r.vaultId !== prev.vaultId) {
			errors.push(`vault-id-mismatch: mixed vaultId in anchor set at anchorSeq ${r.anchorSeq}`);
			mismatchReasons.push("vault-id-mismatch");
		}

		// Signature under the current epoch key. A cryptographically valid
		// signature under a trusted key that is WRONG for this chain position
		// is MISMATCH (key/rotation continuity); a signature no trusted key
		// verifies is INVALID (spec §7.1 rule).
		let sigOk = false;
		if (r.keyId === epochKeyId && epochKey !== null) {
			if (verifySignatureRaw("ed25519", anchorSigningPreimage(r), epochKey, r.sig)) {
				sigOk = true;
			} else {
				errors.push(`sig-invalid: anchorSeq ${r.anchorSeq} signature fails under keyId ${r.keyId}`);
				invalidReasons.push("sig-invalid");
			}
		} else {
			const candidate = knownKeys.get(r.keyId);
			if (
				candidate !== undefined &&
				verifySignatureRaw("ed25519", anchorSigningPreimage(r), candidate, r.sig)
			) {
				errors.push(
					`rotation-continuity: anchorSeq ${r.anchorSeq} signed by keyId ${r.keyId}, expected epoch key ${epochKeyId}`,
				);
				mismatchReasons.push("rotation-continuity");
			} else {
				errors.push(
					`sig-invalid: anchorSeq ${r.anchorSeq} signed by untrusted or failing keyId ${r.keyId}`,
				);
				invalidReasons.push("sig-invalid");
			}
		}

		// A committed-equal twin dropped by dedup must ALSO verify (spec §7.2
		// "both signatures valid") — otherwise record order would decide the
		// verdict. keyId is a committed field, so the twin resolves to the
		// same epoch/known key as its survivor.
		for (const twin of droppedBySeq.get(r.anchorSeq) ?? []) {
			const twinKey = twin.keyId === epochKeyId ? epochKey : (knownKeys.get(twin.keyId) ?? null);
			if (
				twinKey === null ||
				!verifySignatureRaw("ed25519", anchorSigningPreimage(twin), twinKey, twin.sig)
			) {
				errors.push(
					`sig-invalid: duplicate record at anchorSeq ${r.anchorSeq} has a signature that does not verify under keyId ${twin.keyId}`,
				);
				invalidReasons.push("sig-invalid");
			}
		}

		// Rotation: cross-signed successor introduction. Only a record whose
		// own signature verified in its epoch may advance the epoch — a forged
		// rotation must never install a key.
		if (r.rotation !== undefined && sigOk) {
			const nextKey = publicKeyFromSpkiBase64(r.rotation.nextPublicKeySpki);
			if (nextKey === null || keyIdFromKeyObject(nextKey) !== r.rotation.nextKeyId) {
				errors.push(
					`malformed-anchor: rotation at anchorSeq ${r.anchorSeq} — nextKeyId does not match nextPublicKeySpki`,
				);
				invalidReasons.push("malformed-anchor");
			} else {
				if (pinKeyIds.size > 0 && !pinKeyIds.has(r.rotation.nextKeyId)) {
					errors.push(
						`rotation-unpinned: rotation at anchorSeq ${r.anchorSeq} to keyId ${r.rotation.nextKeyId} not in the supplied successor pins`,
					);
					mismatchReasons.push("rotation-unpinned");
				} else if (pinKeyIds.size === 0) {
					warnings.push("rotation-unpinned");
				}
				knownKeys.set(r.rotation.nextKeyId, nextKey);
				epochKeyId = r.rotation.nextKeyId;
				epochKey = nextKey;
			}
		}

		// Consistency binding between consecutive anchored roots (spec §7.2).
		if (
			eventHashes !== undefined &&
			prev !== null &&
			prev.treeSize >= 1 &&
			r.treeSize <= eventHashes.length &&
			prev.treeSize <= r.treeSize
		) {
			if (prev.treeSize === r.treeSize) {
				if (prev.merkleRoot !== r.merkleRoot) {
					errors.push(
						`consistency-failure: anchorSeq ${prev.anchorSeq}->${r.anchorSeq} same treeSize, different roots`,
					);
					mismatchReasons.push("consistency-failure");
				}
			} else {
				const proof = generateConsistencyProof(prev.treeSize, r.treeSize, [...eventHashes]);
				if (
					proof.firstRoot !== prev.merkleRoot ||
					proof.secondRoot !== r.merkleRoot ||
					!verifyConsistencyProof(proof)
				) {
					errors.push(
						`consistency-failure: anchored root at treeSize ${prev.treeSize} is not a prefix of the tree at ${r.treeSize}`,
					);
					mismatchReasons.push("consistency-failure");
				}
			}
		}

		prev = r;
	}

	return { records: ordered, errors, invalidReasons, mismatchReasons, warnings };
}

// ── Vault gathering ──

/**
 * Gather the globally sequence-ordered stored event hashes of a vault, using
 * the exact segment-gathering and ordering semantics of verifyVault
 * (events.jsonl first, then every other *.jsonl sorted; order by persisted
 * global `sequence` when every event has one, else file order). Malformed
 * lines are skipped here — chain-level errors are verifyVault's job, not the
 * anchor evaluator's.
 */
export function gatherOrderedEventHashes(vaultPath: string): string[] {
	const auditDir = join(vaultPath, "audit");
	const segmentFiles: string[] = [];
	const mainLog = join(auditDir, "events.jsonl");
	if (existsSync(mainLog)) {
		segmentFiles.push(mainLog);
	}
	if (existsSync(auditDir)) {
		try {
			for (const entry of readdirSync(auditDir).sort()) {
				if (entry.endsWith(".jsonl") && entry !== "events.jsonl") {
					segmentFiles.push(join(auditDir, entry));
				}
			}
		} catch {
			// Directory read failure — non-fatal
		}
	}
	const events: { hash: string; sequence?: number | undefined }[] = [];
	for (const segmentFile of segmentFiles) {
		let content: string;
		try {
			content = readFileSync(segmentFile, "utf-8").trim();
		} catch {
			continue;
		}
		if (content === "") continue;
		for (const raw of content.split("\n").filter((l) => l.trim())) {
			try {
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				events.push({
					hash: typeof parsed.hash === "string" ? parsed.hash : "",
					sequence: typeof parsed.sequence === "number" ? parsed.sequence : undefined,
				});
			} catch {
				// skip malformed line
			}
		}
	}
	const allHaveSeq = events.every((e) => typeof e.sequence === "number");
	const ordered = allHaveSeq
		? [...events].sort((a, b) => (a.sequence as number) - (b.sequence as number))
		: events;
	return ordered.map((e) => e.hash);
}

/** Read the vault-local anchor mirror (cache, never a trust root alone). */
export function readAnchorMirror(vaultPath: string): {
	records: AnchorRecord[];
	errors: string[];
} {
	const mirrorPath = join(vaultPath, "audit", "anchors", "anchors.jsonl");
	if (!existsSync(mirrorPath)) return { records: [], errors: [] };
	try {
		return parseAnchorsContent(readFileSync(mirrorPath, "utf-8"));
	} catch {
		return { records: [], errors: ["malformed-anchor: anchor mirror unreadable"] };
	}
}

// ── State machine ──

const STATE_SEVERITY: Record<AnchorState, number> = {
	ANCHORED_VERIFIED: 0,
	UNANCHORED: 1,
	ANCHOR_UNVERIFIABLE: 2,
	ANCHOR_STALE: 3,
	ANCHOR_INVALID: 4,
	ANCHOR_MISMATCH: 5,
};

function worseState(a: AnchorState, b: AnchorState): AnchorState {
	return (STATE_SEVERITY[a] ?? 0) >= (STATE_SEVERITY[b] ?? 0) ? a : b;
}

/**
 * The spec §7.2 state machine. Pure function over gathered inputs so both
 * packages (and the differential test) evaluate identically. Evaluation order
 * per constraints §4.2: discover → trust check → parse/signature → content
 * cross-checks → freshness; worst state wins. The witness-fetch-failure rule
 * (AC-2.4) caps the state below ANCHORED_VERIFIED without discarding
 * caller-supplied artifacts.
 */
export function evaluateAnchoredVault(input: AnchorEvaluationInput): AnchorEvaluation {
	const opts = input.opts ?? {};
	const nowMs = opts.nowMs ?? Date.now();
	const reasons: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];

	const witnessRequested = input.witness.requested;
	const witnessOk = input.witness.ok === true;
	const witnessFailed = witnessRequested && !witnessOk;

	const observed = input.orderedHashes.length;
	const anchorsPresent =
		input.externalAnchors.length > 0 ||
		input.mirrorAnchors.length > 0 ||
		input.externalErrors.length > 0 ||
		input.mirrorErrors.length > 0;

	// "external" requires at least one PARSED external record (or a parse error
	// to fail on) — a witness that returned 2xx with an empty/zero-record body
	// must not launder vault-mirror-only evidence into "external" and slip past
	// --require-external-anchor (AC-2.4 defense in depth).
	const hasExternal = input.externalAnchors.length > 0 || input.externalErrors.length > 0;
	const anchorSource: AnchorSource = hasExternal
		? "external"
		: anchorsPresent
			? "vault-mirror"
			: "none";

	const finish = (state: AnchorState, records: readonly AnchorRecord[]): AnchorEvaluation => {
		// Witness-unreachable cap: inconclusive, never a silent downgrade
		// (AC-2.4). MISMATCH/INVALID/STALE from remaining inputs still win;
		// ANCHORED_VERIFIED and UNANCHORED are capped to UNVERIFIABLE.
		let finalState = state;
		if (witnessFailed) {
			reasons.push("witness-unreachable");
			finalState = worseState(finalState, "ANCHOR_UNVERIFIABLE");
			errors.push(`witness-unreachable: ${input.witness.error ?? "anchor URL fetch failed"}`);
		}
		let witness: { requested: boolean; status: WitnessStatus; error?: string };
		if (!witnessRequested) {
			witness = { requested: false, status: "not-consulted" };
		} else if (!witnessOk) {
			witness =
				input.witness.error !== undefined
					? { requested: true, status: "unreachable", error: input.witness.error }
					: { requested: true, status: "unreachable" };
		} else {
			const disagrees = finalState === "ANCHOR_MISMATCH" || finalState === "ANCHOR_INVALID";
			witness = { requested: true, status: disagrees ? "disagrees" : "agrees" };
		}
		const latest =
			records.length > 0 ? ([...records].sort((a, b) => b.treeSize - a.treeSize)[0] ?? null) : null;
		const tailEvents = latest === null ? observed : Math.max(0, observed - latest.treeSize);
		return {
			anchorState: finalState,
			anchorsValid: finalState !== "ANCHOR_INVALID" && finalState !== "ANCHOR_MISMATCH",
			anchorSource,
			anchorCount: records.length,
			latestAnchor:
				latest === null
					? null
					: {
							anchorSeq: latest.anchorSeq,
							treeSize: latest.treeSize,
							lastHash: latest.lastHash,
							keyId: latest.keyId,
							timestamp: latest.timestamp,
						},
			unanchoredTail: {
				events: tailEvents,
				sinceTimestampMs: latest === null ? null : nullIfNaN(Date.parse(latest.timestamp)),
			},
			witness,
			reasons: [...new Set(reasons)],
			warnings: [...new Set(warnings)],
			errors,
		};
	};

	// Step 2 — discovery.
	if (!anchorsPresent) {
		return finish("UNANCHORED", []);
	}

	// Step 3 — trust material (before parse escalation, per constraints §4.2).
	if (input.trust === null) {
		reasons.push("no-trust-material");
		errors.push("anchor artifacts present but no trust material supplied (pin the public key)");
		return finish("ANCHOR_UNVERIFIABLE", [...input.externalAnchors, ...input.mirrorAnchors]);
	}

	// Step 4 — parse failures are fail-closed (mirrors the `.meta` precedent).
	for (const e of [...input.externalErrors, ...input.mirrorErrors]) {
		errors.push(e);
		reasons.push(e.includes("range-invalid") ? "range-invalid" : "malformed-anchor");
	}

	// Cross-vault replay: a mixed-vaultId union is rejected BEFORE dedup can
	// collapse a replayed foreign record into a same-seq group.
	const allVaultIds = new Set(
		[...input.externalAnchors, ...input.mirrorAnchors].map((r) => r.vaultId),
	);
	if (allVaultIds.size > 1) {
		errors.push(`vault-id-mismatch: anchor set mixes ${allVaultIds.size} distinct vaultIds`);
		reasons.push("vault-id-mismatch");
	}

	// Dedup within each stream (racing-emitter duplicates live in ONE stream),
	// then merge external over mirror. A mirror copy of an external record is
	// expected, not a duplicate; divergence at one anchorSeq is MISMATCH
	// (AC-1.2 — the external copy governs).
	const ext = dedupeAnchorSet(input.externalAnchors);
	const mir = dedupeAnchorSet(input.mirrorAnchors);
	for (const set of [ext, mir]) {
		warnings.push(...set.warnings);
		errors.push(...set.errors);
		reasons.push(...set.mismatchReasons);
	}
	const extBySeq = new Map(ext.unique.map((r) => [r.anchorSeq, r]));
	const mergedBySeq = new Map(extBySeq);
	for (const m of mir.unique) {
		const e = extBySeq.get(m.anchorSeq);
		if (e === undefined) {
			mergedBySeq.set(m.anchorSeq, m);
		} else if (!committedFieldsEqual(e, m)) {
			errors.push(
				`mirror-disagreement: vault mirror and external copy differ at anchorSeq ${m.anchorSeq} (external governs)`,
			);
			reasons.push("mirror-disagreement");
		}
	}
	const mergedRecords = [...mergedBySeq.values()].sort((a, b) => a.anchorSeq - b.anchorSeq);

	// Steps 4-5 — signatures, chain linkage, consistency binding. Per-stream
	// dropped twins are re-appended so the walk signature-checks them too
	// (spec §7.2 "both signatures valid" — a bad-sig committed-equal twin is
	// ANCHOR_INVALID regardless of record order).
	const chain = verifyAnchorChain(
		[...mergedRecords, ...ext.dropped, ...mir.dropped],
		input.trust,
		input.orderedHashes,
	);
	errors.push(...chain.errors);
	reasons.push(...chain.invalidReasons, ...chain.mismatchReasons);
	warnings.push(...chain.warnings);
	const records = chain.records;

	// Step 5 — vault binding per record.
	for (const r of records) {
		if (opts.expectedVaultId !== undefined && r.vaultId !== opts.expectedVaultId) {
			errors.push(
				`vault-id-mismatch: anchorSeq ${r.anchorSeq} carries vaultId ${r.vaultId}, expected ${opts.expectedVaultId}`,
			);
			reasons.push("vault-id-mismatch");
		}
		if (r.treeSize > observed) {
			if (observed === 0) {
				errors.push(
					`deletion: anchor anchorSeq ${r.anchorSeq} attests ${r.treeSize} event(s); vault presents 0 (deletion detected)`,
				);
				reasons.push("deletion");
			} else {
				errors.push(
					`rollback: anchor anchorSeq ${r.anchorSeq} attests ${r.treeSize} event(s); vault presents ${observed}`,
				);
				reasons.push("rollback");
			}
			continue;
		}
		const tree = buildMerkleTree(input.orderedHashes.slice(0, r.treeSize));
		if (tree.root === undefined || tree.root !== r.merkleRoot) {
			errors.push(
				`root-mismatch: recomputed Merkle root at treeSize ${r.treeSize} does not match anchorSeq ${r.anchorSeq}`,
			);
			reasons.push("root-mismatch");
		}
		if (input.orderedHashes[r.treeSize - 1] !== r.lastHash) {
			errors.push(
				`head-mismatch: stored hash at sequence ${r.treeSize} does not match anchorSeq ${r.anchorSeq} lastHash`,
			);
			reasons.push("head-mismatch");
		}
	}

	// Classify: MISMATCH ≥ INVALID (constraints §4.2 severity).
	const hasMismatch = reasons.some((c) => !INVALID_REASONS.has(c) && !NON_FAIL_REASONS.has(c));
	const hasInvalid = reasons.some((c) => INVALID_REASONS.has(c));
	if (hasMismatch) {
		return finish("ANCHOR_MISMATCH", records);
	}
	if (hasInvalid) {
		return finish("ANCHOR_INVALID", records);
	}

	// Step 6 — freshness (caller-supplied policy only; tail always reported).
	const latest = [...records].sort((a, b) => b.treeSize - a.treeSize)[0];
	if (latest !== undefined) {
		const ts = Date.parse(latest.timestamp);
		if (Number.isFinite(ts) && ts > nowMs) {
			// Operator-claimed time is in the auditor's future — clock gaming
			// (buyer-rejection §5.13). --max-unanchored-events is the
			// clock-independent control.
			warnings.push("future-timestamp");
		}
		const tail = Math.max(0, observed - latest.treeSize);
		if (opts.maxUnanchoredEvents !== undefined && tail > opts.maxUnanchoredEvents) {
			errors.push(
				`stale: ${tail} event(s) since the newest anchor exceed the supplied threshold ${opts.maxUnanchoredEvents}`,
			);
			return finish("ANCHOR_STALE", records);
		}
		if (
			opts.maxAnchorAgeMs !== undefined &&
			Number.isFinite(ts) &&
			nowMs - ts > opts.maxAnchorAgeMs &&
			observed > latest.treeSize
		) {
			errors.push(
				"stale: newest anchor is older than the supplied --max-anchor-age (operator-claimed time)",
			);
			return finish("ANCHOR_STALE", records);
		}
	}

	return finish("ANCHORED_VERIFIED", records);
}

// ── Inclusion against an external anchor (the F1 fix) ──

/**
 * Verify a Merkle inclusion proof against a SIGNED EXTERNAL anchor record —
 * root and treeSize come from the record, never recomputed from the events
 * under check (spec §7.1; closes F1). The record must verify under the pinned
 * root or a supplied successor pin.
 */
export function verifyInclusionAgainstAnchor(
	proof: MerkleInclusionProof,
	record: AnchorRecord,
	trust: AnchorTrust,
): boolean {
	const sig = verifyAnchorSignature(record, [trust.rootPem, ...(trust.successorPinsPem ?? [])]);
	if (!sig.ok) return false;
	return verifyInclusionProof(proof, record.merkleRoot, record.treeSize);
}
