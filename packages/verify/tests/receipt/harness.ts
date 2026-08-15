// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ut1 mint harness — TEST-ONLY.
 *
 * Builds REAL proxy-v1 receipt material end to end with node builtins only:
 * Ed25519 keypairs, a receipt-spec §2 projection, the §4a event envelope with
 * `hash = sha256(canonicalize(event − hash))`, per-segment Merkle trees with
 * odd-node promotion, a `MerkleInclusionProof`, `SegmentCheckpoint` v2
 * statements signed over `canonicalize(unsigned)`, a signed §5 receipt over
 * `utf8("usertrust/receipt-signature/v1\n") ‖ canonicalize(receipt − signature)`,
 * and a §8 trust snapshot registering the keys and the chain.
 *
 * Why a harness and not fixtures-on-disk: no differential counterpart exists
 * in-repo (the mint side is the stealth proxy), so the corpus has to be minted.
 * Every mutant in `fixtures.ts` is produced by re-minting with ONE hook, so
 * everything downstream of the mutated fact is recomputed and the mutant breaks
 * exactly the fact it names. Post-hoc field surgery cannot make that claim:
 * editing a signed field breaks the field AND the signature, and a corpus of
 * doubly-broken vectors cannot tell a verifier which check caught what.
 *
 * WHY THIS FILE IMPORTS NOTHING FROM `src/`
 * ----------------------------------------
 * The corpus exists to catch a shared misreading of §4a/§13. A harness that
 * reaches its canonical bytes by calling the very `canonicalize` the verifier
 * calls cannot fail on a canonicalization bug — the two sides agree on the
 * wrong answer and every vector is green. receipt-spec §13 exists because that
 * happened: `packages/verify/src/canonical.ts` renders `[1, undefined, 2]` as
 * `[1,,2]`, which is not valid JSON, and no self-referential corpus could see
 * it. So the canonicalizer, the Merkle tree, the base58 codec and the signature
 * preimages below are INDEPENDENT implementations written from the spec text.
 * `harness.test.ts` cross-checks them against `src/` — that direction is a
 * differential assertion; importing `src/` here would be shared machinery.
 *
 * Nothing in `src/` may import this file either. This is corpus machinery.
 */

import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization — receipt-spec §13, implemented from the appendix text.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The §13 algorithm, stated completely there and implemented literally here:
 *
 * 1. `undefined` and `null` both serialize to `null` — top level, inside
 *    arrays, everywhere.
 * 2. Non-finite numbers THROW (data-corruption signal, never a verdict);
 *    finite numbers are `JSON.stringify(n)`.
 * 3. `Date` → its ISO-8601 string; an invalid Date throws a DELIBERATE,
 *    IDENTIFIABLE error — §13 pins the error identity so a verifier mapping a
 *    throw to MALFORMED can tell a data defect from a crash, which an
 *    uncontrolled `RangeError` escaping `.toISOString()` cannot.
 * 4. Non-objects: `JSON.stringify(value)` — **and the RESULT is checked.**
 *    `JSON.stringify` returns the JS value `undefined` (not a string) for
 *    functions and symbols, which string-concatenates into the literal
 *    `undefined` and produces unparseable output. §13 rules that a value whose
 *    serialization is not a string is REJECTED, never emitted: omitting the key
 *    would silently drop a field the caller believed they committed.
 * 5. Arrays: elements in order, joined by `,` — never sorted. Holes read as
 *    `undefined` and therefore serialize as `null` (rule 1), which is why the
 *    loop indexes rather than using `Array#map` — `map` skips holes and emits
 *    `[1,,2]`, the exact non-conformance §13 records.
 * 6. Objects: own enumerable keys only, sorted in UTF-16 code-unit order
 *    (JavaScript's default comparator), `undefined`-valued keys SKIPPED
 *    entirely so that absent ≠ null.
 *
 * Rules 3 and 4 are the two §13 rows on which ALL THREE real implementations
 * (proxy, core, verify) are defective. They are unreachable from parsed wire
 * data, so no corpus vector turns on them — but this function is the corpus's
 * statement of what §13 SAYS, and a reference implementation that reproduces
 * the defects it exists to detect is worth exactly nothing.
 */
export function canonicalizeNormative(value: unknown): string {
	if (value === undefined || value === null) return "null";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("canonicalizeNormative: non-finite number is not allowed");
		}
		return JSON.stringify(value);
	}
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throw new Error("canonicalizeNormative: invalid Date in audit data");
		}
		const iso = value.toISOString();
		if (typeof iso !== "string") {
			throw new Error("canonicalizeNormative: Date.toISOString must return a string");
		}
		return JSON.stringify(iso);
	}
	if (typeof value === "function" || typeof value === "symbol") {
		throw new Error(`canonicalizeNormative: ${typeof value} has no JSON serialization`);
	}
	if (typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (let i = 0; i < value.length; i += 1) {
			parts.push(canonicalizeNormative(value[i]));
		}
		return `[${parts.join(",")}]`;
	}
	const object = value as Record<string, unknown>;
	const keys = Object.keys(object)
		.filter((key) => Object.hasOwn(object, key))
		.sort();
	const parts: string[] = [];
	for (const key of keys) {
		const member = object[key];
		if (member === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${canonicalizeNormative(member)}`);
	}
	return `{${parts.join(",")}}`;
}

export function sha256Hex(input: string | Buffer): string {
	return createHash("sha256").update(input).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Merkle — receipt-spec §4a, implemented from the profile text.
// ─────────────────────────────────────────────────────────────────────────────

/** §4a: leaf = `sha256(0x00 || hexDecode(rawEventHash))`. */
export function merkleLeafHash(rawHashHex: string): string {
	return createHash("sha256")
		.update(Buffer.from([0x00]))
		.update(Buffer.from(rawHashHex, "hex"))
		.digest("hex");
}

/** §4a: interior = `sha256(0x01 || left || right)` over DECODED bytes. */
export function merkleInteriorHash(leftHex: string, rightHex: string): string {
	return createHash("sha256")
		.update(Buffer.from([0x01]))
		.update(Buffer.from(leftHex, "hex"))
		.update(Buffer.from(rightHex, "hex"))
		.digest("hex");
}

/** Layer 0 is the hashed leaves; odd nodes PROMOTE unchanged (§4a). */
export function merkleLayers(rawLeafHashes: readonly string[]): string[][] {
	if (rawLeafHashes.length === 0) throw new Error("merkleLayers: empty segment");
	let layer: string[] = rawLeafHashes.map(merkleLeafHash);
	const layers: string[][] = [layer];
	while (layer.length > 1) {
		const next: string[] = [];
		for (let i = 0; i < layer.length; i += 2) {
			const left = layer[i] as string;
			const right = layer[i + 1];
			next.push(right === undefined ? left : merkleInteriorHash(left, right));
		}
		layer = next;
		layers.push(layer);
	}
	return layers;
}

export function merkleRoot(rawLeafHashes: readonly string[]): string {
	const layers = merkleLayers(rawLeafHashes);
	return (layers[layers.length - 1] as string[])[0] as string;
}

export interface HarnessMerkleSibling {
	hash: string;
	position: "left" | "right";
}

/** The `MerkleInclusionProof` shape of receipt-spec §4, declared here rather
 * than imported from `src/verify.ts` (see the file header). */
export interface HarnessInclusionProof {
	version: number;
	leafHash: string;
	leafIndex: number;
	treeSize: number;
	root: string;
	siblings: HarnessMerkleSibling[];
	segmentId: string;
}

/**
 * A promoted node has NO sibling at its level, so the path is SHORTER than
 * `ceil(log2(treeSize))`. Walking the levels is the only way to get a
 * promotion-shaped tree right (§4a's normative topology rule).
 */
export function inclusionProofFor(
	leafIndex: number,
	rawLeafHashes: readonly string[],
	segmentId: string,
): HarnessInclusionProof {
	if (!Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= rawLeafHashes.length) {
		throw new RangeError(`inclusionProofFor: leafIndex ${leafIndex} out of bounds`);
	}
	const layers = merkleLayers(rawLeafHashes);
	const siblings: HarnessMerkleSibling[] = [];
	let index = leafIndex;
	for (let level = 0; level < layers.length - 1; level += 1) {
		const layer = layers[level] as string[];
		const promoted = index === layer.length - 1 && layer.length % 2 === 1;
		if (!promoted) {
			siblings.push(
				index % 2 === 0
					? { hash: layer[index + 1] as string, position: "right" }
					: { hash: layer[index - 1] as string, position: "left" },
			);
		}
		index = Math.floor(index / 2);
	}
	return {
		version: 1,
		// §4a: `leafHash` carries the RAW event hash, not the prefixed leaf.
		leafHash: rawLeafHashes[leafIndex] as string,
		leafIndex,
		treeSize: rawLeafHashes.length,
		root: (layers[layers.length - 1] as string[])[0] as string,
		siblings,
		segmentId,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// base58btc — receipt-spec §3 / §12.
// ─────────────────────────────────────────────────────────────────────────────

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
	let zeros = 0;
	while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
	const digits: number[] = [];
	for (let i = zeros; i < bytes.length; i += 1) {
		let carry = bytes[i] as number;
		for (let j = 0; j < digits.length; j += 1) {
			carry += (digits[j] as number) << 8;
			digits[j] = carry % 58;
			carry = Math.floor(carry / 58);
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = Math.floor(carry / 58);
		}
	}
	let out = "1".repeat(zeros);
	for (let i = digits.length - 1; i >= 0; i -= 1) {
		out += B58_ALPHABET[digits[i] as number];
	}
	return out;
}

/** Returns null for any character outside the Bitcoin alphabet. */
export function base58Decode(text: string): Uint8Array | null {
	let zeros = 0;
	while (zeros < text.length && text[zeros] === "1") zeros += 1;
	const bytes: number[] = [];
	for (let i = zeros; i < text.length; i += 1) {
		const value = B58_ALPHABET.indexOf(text[i] as string);
		if (value < 0) return null;
		let carry = value;
		for (let j = 0; j < bytes.length; j += 1) {
			carry += (bytes[j] as number) * 58;
			bytes[j] = carry & 0xff;
			carry >>= 8;
		}
		while (carry > 0) {
			bytes.push(carry & 0xff);
			carry >>= 8;
		}
	}
	const out = new Uint8Array(zeros + bytes.length);
	for (let i = 0; i < bytes.length; i += 1) {
		out[zeros + bytes.length - 1 - i] = bytes[i] as number;
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire types (receipt-spec §2, §4, §4a, §5, §8, and the resolver envelope).
// ─────────────────────────────────────────────────────────────────────────────

export interface MintActor {
	type: "system";
	id: string;
	name: string;
}

export interface TransferPair {
	authorizationTransferId: string;
	settlementTransferId: string;
}

export interface CommitWork {
	kind: "commit";
	repoId: string;
	repo?: string;
	oid: string;
	oidAlg: "sha1" | "sha256";
	objectSha256: string;
	repositoryMembership: { status: "providerVerified"; proofId: string };
}

/**
 * Deliberately loose: mutants must add, drop and retype members the strict
 * schema forbids, and a closed type would make half the corpus unwritable.
 */
export type Projection = Record<string, unknown>;

export interface EventEnvelope {
	id: string;
	timestamp: string;
	previousHash: string;
	kind: string;
	actor: unknown;
	data: Projection;
	sequence: number;
	hash: string;
}

export interface SegmentCheckpoint {
	v: number;
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

export type UnsignedCheckpoint = Omit<SegmentCheckpoint, "sig">;

export interface ReceiptDocument {
	spec: string;
	receiptId: string;
	scope: string;
	mintedAt: string;
	minter: { kind: string; keyId: string; trustDomain: string };
	work: unknown;
	event: EventEnvelope;
	proof: {
		profile: string;
		chain: string;
		mintEventHash: string;
		inclusion: HarnessInclusionProof;
		checkpoint: SegmentCheckpoint;
	};
	signature: { alg: string; keyId: string; sig: string };
}

export type UnsignedReceipt = Omit<ReceiptDocument, "signature">;

export interface TrustKeyEntry {
	keyId: string;
	alg: string;
	publicKey: string;
	role: "mint" | "checkpoint";
	minterKind?: string;
	predecessorKeyId?: string;
	activationSequence?: number;
	state: "active" | "retired" | "revoked";
}

export interface TrustChainEntry {
	vaultId: string;
	profile: string;
	genesisSegmentId: string;
	genesisChoice: "backfill" | "newVault";
	headSegmentId: string;
	headSegmentFirstSequence: number;
	mintActor: unknown;
	checkpointRootKeyId: string;
	mintKeyIds: string[];
}

export interface TrustSnapshot {
	keys: TrustKeyEntry[];
	chains: TrustChainEntry[];
	[extra: string]: unknown;
}

export interface ResolverEnvelope {
	apiVersion: string;
	receiptId: string;
	status: string;
	receiptBytes?: string;
	receipt?: unknown;
	checkpointHistory?: SegmentCheckpoint[];
	anchorEvidence?: unknown;
	[extra: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants the corpus and the verifier must agree on.
// ─────────────────────────────────────────────────────────────────────────────

export const RECEIPT_SIGNATURE_PREFIX = "usertrust/receipt-signature/v1\n";
export const TRANSFER_SET_PREFIX = "usertrust/receipt-transfers/v1\n";
export const PROFILE = "proxy-v1";
export const MINT_EVENT_KIND = "receipt_settled";
export const TRUST_DOMAIN = "usertrust.ai";
export const GENESIS_SENTINEL = "genesis";
export const VAULT_ID = "vlt_ut_proxy_prod_1";
export const MINT_ACTOR: MintActor = {
	type: "system",
	id: "receipt-minter",
	name: "receipt-minter",
};

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic Ed25519 keys.
// ─────────────────────────────────────────────────────────────────────────────

/** PKCS#8 prefix for a raw Ed25519 seed (RFC 8410 §7). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface HarnessKey {
	readonly keyId: string;
	readonly privateKey: KeyObject;
	readonly publicKey: KeyObject;
	readonly publicKeyPem: string;
	readonly publicKeySpkiBase64: string;
}

/**
 * Deterministic keypair from a 32-byte seed. Deterministic on purpose: a
 * conformance corpus whose bytes change every run cannot be diffed, quoted in
 * a bug report, or compared across implementations.
 */
export function keyFromSeed(keyId: string, seed: Buffer): HarnessKey {
	if (seed.length !== 32) throw new Error("keyFromSeed: seed must be 32 bytes");
	const privateKey = createPrivateKey({
		key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
		format: "der",
		type: "pkcs8",
	});
	const publicKey = createPublicKey(privateKey);
	return {
		keyId,
		privateKey,
		publicKey,
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		publicKeySpkiBase64: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString(
			"base64",
		),
	};
}

function seedFrom(label: string): Buffer {
	return createHash("sha256").update(`usertrust/test-seed/${label}`).digest();
}

export const MINT_KEY = keyFromSeed("utk_mint_2026_08", seedFrom("mint-2026-08"));
export const MINT_KEY_SUCCESSOR = keyFromSeed("utk_mint_2026_09", seedFrom("mint-2026-09"));
export const CHECKPOINT_KEY = keyFromSeed("utk_ckpt_2026_08", seedFrom("ckpt-2026-08"));
export const CHECKPOINT_KEY_SUCCESSOR = keyFromSeed("utk_ckpt_2026_09", seedFrom("ckpt-2026-09"));
/** Registered nowhere. Used for "signed by a key the snapshot never saw". */
export const FOREIGN_KEY = keyFromSeed("utk_foreign", seedFrom("foreign"));

/** Every key the harness can mint with, by keyId — the corpus's key directory. */
export const ALL_KEYS: readonly HarnessKey[] = [
	MINT_KEY,
	MINT_KEY_SUCCESSOR,
	CHECKPOINT_KEY,
	CHECKPOINT_KEY_SUCCESSOR,
	FOREIGN_KEY,
];

export function signEd25519(key: HarnessKey, dataUtf8: string): string {
	return sign(null, Buffer.from(dataUtf8, "utf8"), key.privateKey).toString("base64");
}

// ─────────────────────────────────────────────────────────────────────────────
// The default chain shape.
// ─────────────────────────────────────────────────────────────────────────────

export interface SegmentSpec {
	readonly segmentId: string;
	readonly segmentFirstSequence: number;
	readonly treeSize: number;
}

/**
 * Three real segments. Contiguity is arithmetic, per §7's history walk:
 * `next.segmentFirstSequence === prev.segmentFirstSequence + prev.treeSize`.
 * The mint segment is the head and has an ODD leaf count, so the mint event's
 * inclusion path exercises odd-node promotion rather than a perfect tree.
 */
export const DEFAULT_SEGMENTS: readonly SegmentSpec[] = [
	{ segmentId: "seg_000001", segmentFirstSequence: 1, treeSize: 4 },
	{ segmentId: "seg_000002", segmentFirstSequence: 5, treeSize: 6 },
	{ segmentId: "seg_000003", segmentFirstSequence: 11, treeSize: 7 },
];

/** Same three segments with a ONE-SEQUENCE GAP between segment 1 and 2 —
 * §7's `next.first === prev.first + prev.treeSize` contiguity mutant. */
export const GAPPED_SEGMENTS: readonly SegmentSpec[] = [
	{ segmentId: "seg_000001", segmentFirstSequence: 1, treeSize: 4 },
	{ segmentId: "seg_000002", segmentFirstSequence: 6, treeSize: 6 },
	{ segmentId: "seg_000003", segmentFirstSequence: 12, treeSize: 7 },
];

export const DEFAULT_MINT_SEGMENT_INDEX = 2;
export const DEFAULT_MINT_LEAF_INDEX = 3;

/** 16 bytes → `"ut1_" + base58btc`, §3. */
export const DEFAULT_RECEIPT_ID_BYTES = Buffer.from("7f3a1c04b9e2465d8a11c0de5f6b2390", "hex");
export const DEFAULT_RECEIPT_ID = `ut1_${base58Encode(DEFAULT_RECEIPT_ID_BYTES)}`;

/** A DIFFERENT valid ID — the arrival-context (step 3(a)) mismatch partner. */
export const ALT_RECEIPT_ID_BYTES = Buffer.from("1d90f4a7c26b3e58097fab41d3c65e02", "hex");
export const ALT_RECEIPT_ID = `ut1_${base58Encode(ALT_RECEIPT_ID_BYTES)}`;

/** Leading zero bytes must encode as leading `1`s and survive a round trip. */
export const LEADING_ZERO_RECEIPT_ID_BYTES = Buffer.from("00004c9a2b7d18e3f05a6c81becd4271", "hex");
export const LEADING_ZERO_RECEIPT_ID = `ut1_${base58Encode(LEADING_ZERO_RECEIPT_ID_BYTES)}`;

/** 15 decoded bytes: matches §12's `16*22base58char` grammar, decodes SHORT. */
export const SHORT_DECODE_RECEIPT_ID = `ut1_${base58Encode(
	Buffer.from("4c9a2b7d18e3f05a6c81becd4271ff", "hex"),
)}`;

/**
 * One extra leading `1` beyond the actual leading zero bytes — the padded shape
 * §12's rule 2 is written against, caught here by rule 1.
 *
 * Built on the LEADING-ZERO ID rather than the default one so the result is 22
 * characters and still inside §12's `16*22base58char` grammar — 23 would be
 * rejected by the grammar and the vector would prove nothing.
 *
 * It fails §12's rule 1 ONLY: it decodes to 17 bytes. It does NOT fail rule 2 —
 * measured, not assumed: `base58Encode(base58Decode(body)) === body`. Rule 2 is
 * **unfalsifiable against a conformant codec** and no fixture can pretend
 * otherwise: a leading `1` decodes to a leading zero byte, which re-encodes to
 * the same leading `1`, and `encode ∘ decode` is the identity on every string
 * in the alphabet (see the dedicated test in `harness.test.ts`). Rule 2 is a
 * defence against a LENIENT reader — one that strips leading `1`s, or pads or
 * truncates to 16 bytes — which is a property of the implementation under test,
 * not of any byte string this corpus can hand it. Recorded rather than
 * asserted, exactly as equality 3 is.
 */
export const LONG_DECODE_RECEIPT_ID = `ut1_1${base58Encode(LEADING_ZERO_RECEIPT_ID_BYTES)}`;

function fillerLeaf(segmentId: string, index: number): string {
	return sha256Hex(`usertrust/test-filler/${segmentId}/${index}`);
}

export function transferPairs(count: number): TransferPair[] {
	const pairs: TransferPair[] = [];
	for (let i = 0; i < count; i += 1) {
		pairs.push({
			authorizationTransferId: sha256Hex(`auth/${i}`).slice(0, 32),
			settlementTransferId: sha256Hex(`settle/${i}`).slice(0, 32),
		});
	}
	return pairs;
}

/** §2: `sha256( utf8(prefix) || canonicalize(fullOrderedPairList) )`, lowercase hex. */
export function transferSetRoot(pairs: readonly TransferPair[]): string {
	return sha256Hex(TRANSFER_SET_PREFIX + canonicalizeNormative(pairs));
}

export interface ProjectionOptions {
	/** POSTed logical pairs. `> 32` ⇒ `transferSet` is ABSENT (§2's presence rule). */
	readonly transferCount?: number;
	readonly generation?: number;
	readonly sessionId?: string;
}

export function buildProjection(options: ProjectionOptions = {}): Projection {
	const transferCount = options.transferCount ?? 22;
	const generation = options.generation ?? 1;
	const pairs = transferPairs(transferCount);
	const work: CommitWork = {
		kind: "commit",
		repoId: "github.com:R_kgDOK1x2Yw",
		repo: "github.com/usertools-ai/usertrust",
		oid: "37df16d3a4c1b8e05f92d7a6c31e4b8079fa2d51",
		oidAlg: "sha1",
		objectSha256: sha256Hex("usertrust/test-commit-object"),
		repositoryMembership: { status: "providerVerified", proofId: "pv_9f3a2c81d0" },
	};
	const projection: Projection = {
		spec: "ut1",
		scope: "session",
		sessionId: options.sessionId ?? "01K2Q7V8ZC4M6N0PABCDEF3XYZ",
		generation,
		work,
		sessionAssociation: "workflowAttested",
		workloadId: "wl_7c2f4a91b8",
		models: ["claude-opus-4-5", "claude-sonnet-4-5"],
		providers: ["anthropic"],
		startedAt: "2026-08-11T18:00:00.000Z",
		endedAt: "2026-08-11T18:42:13.512Z",
		spend: {
			assessedUsertokens: 48224,
			postedUsertokens: 48224,
			roundingAdjustment: 14,
			transferCount,
			usagePosture: "provider",
			pricingPosture: "exact",
		},
		// REQUIRED (v0.9 §2a). v1 conformant minting emits ONLY this value.
		delegationPosture: "selfDebitsOnly",
		pricing: { tableVersions: ["2026-08-01"] },
		transferSetRoot: transferSetRoot(pairs),
	};
	if (generation > 1) {
		projection.prevGenerationEventHash = sha256Hex(`usertrust/test-prev-generation/${generation}`);
	}
	// §2: present iff transferCount ≤ 32, ABSENT iff > 32.
	if (transferCount <= 32) {
		projection.transferSet = pairs;
	}
	return projection;
}

/** `48224 / 10000` by integer quotient/remainder, four decimals (§2). */
export const DEFAULT_AMOUNT_USD = "4.8224";

// ─────────────────────────────────────────────────────────────────────────────
// The mint pipeline.
// ─────────────────────────────────────────────────────────────────────────────

export interface MintOptions {
	readonly mintKey?: HarnessKey;
	readonly checkpointKey?: HarnessKey;
	readonly projectionOptions?: ProjectionOptions;
	readonly segments?: readonly SegmentSpec[];
	readonly mintSegmentIndex?: number;
	readonly mintLeafIndex?: number;
	readonly receiptId?: string;

	/** Tweak the projection before the event envelope is built. */
	readonly projection?: (p: Projection) => Projection;
	/** Tweak the envelope BEFORE `hash` is computed — the hash stays correct. */
	readonly event?: (e: Omit<EventEnvelope, "hash">) => Omit<EventEnvelope, "hash">;
	/** Tweak the envelope AFTER `hash` is computed — breaks the recompute. */
	readonly eventAfterHash?: (e: EventEnvelope) => EventEnvelope;
	/** Replace the leaf the mint event occupies (proves inclusion of something else). */
	readonly mintLeaf?: (eventHash: string) => string;
	readonly inclusion?: (p: HarnessInclusionProof) => HarnessInclusionProof;
	/** Tweak every unsigned checkpoint before signing — signatures stay valid. */
	readonly checkpointsUnsigned?: (c: UnsignedCheckpoint[]) => UnsignedCheckpoint[];
	/** Which key signs checkpoint i. Default: the checkpoint key. */
	readonly checkpointSigner?: (index: number) => HarnessKey;
	/** Tweak signed checkpoints — breaks whichever signature it touches. */
	readonly checkpointsAfterSign?: (c: SegmentCheckpoint[]) => SegmentCheckpoint[];
	/** Tweak the receipt before signing — the signature stays valid. */
	readonly receiptBeforeSign?: (r: UnsignedReceipt) => Record<string, unknown>;
	/** Tweak the receipt after signing — breaks the signature. */
	readonly receiptAfterSign?: (r: Record<string, unknown>) => Record<string, unknown>;
	/** Raw byte surgery on the receipt document — the parse-vector hook. */
	readonly bytes?: (b: Buffer) => Buffer;
	readonly snapshot?: (s: TrustSnapshot) => TrustSnapshot;
	readonly snapshotBytes?: (b: Buffer) => Buffer;
	readonly history?: (h: SegmentCheckpoint[]) => SegmentCheckpoint[];
	readonly envelope?: (e: ResolverEnvelope) => ResolverEnvelope;
}

export interface MintedSegment {
	readonly spec: SegmentSpec;
	readonly leaves: readonly string[];
	readonly root: string;
}

export interface MintedBundle {
	/** The parsed receipt as minted. `receiptBytes` is the authority. */
	readonly receipt: Record<string, unknown>;
	readonly receiptBytes: Buffer;
	readonly snapshot: TrustSnapshot;
	readonly snapshotBytes: Buffer;
	/** Genesis → the mint segment, one checkpoint per segment. */
	readonly history: readonly SegmentCheckpoint[];
	readonly envelope: ResolverEnvelope;
	readonly segments: readonly MintedSegment[];
	readonly mintSegmentIndex: number;
	readonly mintLeafIndex: number;
	readonly mintKey: HarnessKey;
	readonly checkpointKey: HarnessKey;
}

/** §5's signature preimage. */
export function receiptSignaturePreimage(unsigned: Record<string, unknown>): string {
	const { signature: _dropped, ...rest } = unsigned;
	return RECEIPT_SIGNATURE_PREFIX + canonicalizeNormative(rest);
}

/** §4a's checkpoint preimage — `canonicalize(unsigned)`, NO domain prefix. */
export function checkpointPreimage(checkpoint: Record<string, unknown>): string {
	const { sig: _dropped, ...rest } = checkpoint;
	return canonicalizeNormative(rest);
}

/** §4a's event-hash rule, with key-ABSENT (not undefined-valued) exclusion. */
export function eventHash(event: Record<string, unknown>): string {
	const { hash: _dropped, ...rest } = event;
	return sha256Hex(canonicalizeNormative(rest));
}

export function mint(options: MintOptions = {}): MintedBundle {
	const mintKey = options.mintKey ?? MINT_KEY;
	const checkpointKey = options.checkpointKey ?? CHECKPOINT_KEY;
	const segmentSpecs = options.segments ?? DEFAULT_SEGMENTS;
	const mintSegmentIndex = options.mintSegmentIndex ?? DEFAULT_MINT_SEGMENT_INDEX;
	const mintLeafIndex = options.mintLeafIndex ?? DEFAULT_MINT_LEAF_INDEX;
	const mintSegment = segmentSpecs[mintSegmentIndex] as SegmentSpec;

	// 1. Projection.
	let projection = buildProjection(options.projectionOptions);
	if (options.projection) projection = options.projection(projection);

	// 2. Event envelope; hash over the envelope minus `hash`.
	let unsignedEvent: Omit<EventEnvelope, "hash"> = {
		id: "evt_01K2Q7WD5J3N8H4TB2MYE0PXQR",
		timestamp: "2026-08-11T18:42:14.006Z",
		previousHash: sha256Hex("usertrust/test-previous-event"),
		kind: MINT_EVENT_KIND,
		actor: { ...MINT_ACTOR },
		data: projection,
		sequence: mintSegment.segmentFirstSequence + mintLeafIndex,
	};
	if (options.event) unsignedEvent = options.event(unsignedEvent);
	let event: EventEnvelope = {
		...unsignedEvent,
		hash: eventHash(unsignedEvent as unknown as Record<string, unknown>),
	};
	if (options.eventAfterHash) event = options.eventAfterHash(event);

	// 3. Real per-segment Merkle trees. The mint event occupies one leaf of the
	//    mint segment; every other leaf is an unrelated (but real) event hash.
	const minted: MintedSegment[] = segmentSpecs.map((spec, segmentIndex) => {
		const leaves: string[] = [];
		for (let i = 0; i < spec.treeSize; i += 1) {
			if (segmentIndex === mintSegmentIndex && i === mintLeafIndex) {
				leaves.push(options.mintLeaf ? options.mintLeaf(event.hash) : event.hash);
			} else {
				leaves.push(fillerLeaf(spec.segmentId, i));
			}
		}
		return { spec, leaves, root: merkleRoot(leaves) };
	});

	// 4. Inclusion proof over the mint segment's real tree.
	const mintTree = minted[mintSegmentIndex] as MintedSegment;
	let inclusion = inclusionProofFor(mintLeafIndex, mintTree.leaves, mintSegment.segmentId);
	if (options.inclusion) inclusion = options.inclusion(inclusion);

	// 5. SegmentCheckpoint v2 per segment, lineage-chained from genesis.
	let unsignedCheckpoints: UnsignedCheckpoint[] = minted.map((segment, index) => {
		const previous = index === 0 ? null : (minted[index - 1] as MintedSegment);
		return {
			v: 2,
			vaultId: VAULT_ID,
			profile: PROFILE,
			root: segment.root,
			treeSize: segment.spec.treeSize,
			segmentId: segment.spec.segmentId,
			segmentFirstSequence: segment.spec.segmentFirstSequence,
			previousSegmentRoot: previous === null ? GENESIS_SENTINEL : previous.root,
			previousSegmentId: previous === null ? GENESIS_SENTINEL : previous.spec.segmentId,
			keyId: (options.checkpointSigner ? options.checkpointSigner(index) : checkpointKey).keyId,
			publishedAt: `2026-08-1${index + 1}T00:00:00.000Z`,
		};
	});
	if (options.checkpointsUnsigned) {
		unsignedCheckpoints = options.checkpointsUnsigned(unsignedCheckpoints);
	}

	let checkpoints: SegmentCheckpoint[] = unsignedCheckpoints.map((unsigned, index) => {
		const signer = options.checkpointSigner ? options.checkpointSigner(index) : checkpointKey;
		return { ...unsigned, sig: signEd25519(signer, checkpointPreimage(unsigned)) };
	});
	if (options.checkpointsAfterSign) checkpoints = options.checkpointsAfterSign(checkpoints);

	// 6. Sign the receipt.
	const unsignedReceipt: UnsignedReceipt = {
		spec: "ut1",
		receiptId: options.receiptId ?? DEFAULT_RECEIPT_ID,
		scope: "session",
		mintedAt: "2026-08-11T18:42:20.114Z",
		minter: { kind: "proxy", keyId: mintKey.keyId, trustDomain: TRUST_DOMAIN },
		work: structuredClone(projection.work),
		event,
		proof: {
			profile: PROFILE,
			chain: VAULT_ID,
			mintEventHash: event.hash,
			inclusion,
			checkpoint: checkpoints[mintSegmentIndex] as SegmentCheckpoint,
		},
	};
	const toSign: Record<string, unknown> = options.receiptBeforeSign
		? options.receiptBeforeSign(unsignedReceipt)
		: (unsignedReceipt as unknown as Record<string, unknown>);
	let receipt: Record<string, unknown> = {
		...toSign,
		signature: {
			alg: "ed25519",
			keyId: mintKey.keyId,
			sig: signEd25519(mintKey, receiptSignaturePreimage(toSign)),
		},
	};
	if (options.receiptAfterSign) receipt = options.receiptAfterSign(receipt);

	// 7. Bytes. The document is emitted canonically; `bytes` is the only hook
	//    that can produce something the strict reader must reject.
	let receiptBytes: Buffer = Buffer.from(canonicalizeNormative(receipt), "utf8");
	if (options.bytes) receiptBytes = options.bytes(receiptBytes);

	// 8. §8 trust snapshot.
	let snapshot: TrustSnapshot = {
		keys: [
			{
				keyId: mintKey.keyId,
				alg: "ed25519",
				publicKey: mintKey.publicKeyPem,
				role: "mint",
				minterKind: "proxy",
				state: "active",
			},
			{
				keyId: checkpointKey.keyId,
				alg: "ed25519",
				publicKey: checkpointKey.publicKeyPem,
				role: "checkpoint",
				state: "active",
			},
		],
		chains: [
			{
				vaultId: VAULT_ID,
				profile: PROFILE,
				genesisSegmentId: (segmentSpecs[0] as SegmentSpec).segmentId,
				genesisChoice: "newVault",
				headSegmentId: (segmentSpecs[segmentSpecs.length - 1] as SegmentSpec).segmentId,
				headSegmentFirstSequence: (segmentSpecs[segmentSpecs.length - 1] as SegmentSpec)
					.segmentFirstSequence,
				mintActor: { ...MINT_ACTOR },
				checkpointRootKeyId: checkpointKey.keyId,
				mintKeyIds: [mintKey.keyId],
			},
		],
	};
	if (options.snapshot) snapshot = options.snapshot(snapshot);
	let snapshotBytes: Buffer = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	if (options.snapshotBytes) snapshotBytes = options.snapshotBytes(snapshotBytes);

	// 9. History (genesis → the mint segment) + the resolver envelope.
	let history: SegmentCheckpoint[] = checkpoints.slice(0, mintSegmentIndex + 1);
	if (options.history) history = options.history(history);

	// The convenience copy mirrors the emitted bytes. When a byte vector made
	// those bytes unparseable, it falls back to the pre-mutation document —
	// `receiptBytes` is the authority in every mode, and a harness that threw
	// here could not express the parse vectors at all.
	let receiptCopy: unknown;
	try {
		receiptCopy = JSON.parse(receiptBytes.toString("utf8"));
	} catch {
		receiptCopy = JSON.parse(canonicalizeNormative(receipt));
	}

	let envelope: ResolverEnvelope = {
		apiVersion: "1",
		receiptId: String(receipt.receiptId),
		status: "verified_checkpoint",
		receiptBytes: receiptBytes.toString("base64"),
		receipt: receiptCopy,
		checkpointHistory: history,
	};
	if (options.envelope) envelope = options.envelope(envelope);

	return {
		receipt,
		receiptBytes,
		snapshot,
		snapshotBytes,
		history,
		envelope,
		segments: minted,
		mintSegmentIndex,
		mintLeafIndex,
		mintKey,
		checkpointKey,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation helpers.
// ─────────────────────────────────────────────────────────────────────────────

/** Deep clone that keeps key ORDER, so byte-level vectors stay predictable. */
export function clone<T>(value: T): T {
	return structuredClone(value);
}

/** Reach into a plain object graph and replace one leaf, returning a copy. */
export function withPath<T extends Record<string, unknown>>(
	root: T,
	path: readonly (string | number)[],
	value: unknown,
): T {
	const copy = structuredClone(root) as Record<string, unknown>;
	let cursor: Record<string, unknown> = copy;
	for (let i = 0; i < path.length - 1; i += 1) {
		cursor = cursor[path[i] as string] as Record<string, unknown>;
	}
	cursor[path[path.length - 1] as string] = value;
	return copy as T;
}

/** Remove one key, returning a copy. Key-ABSENT, never undefined-valued. */
export function withoutPath<T extends Record<string, unknown>>(
	root: T,
	path: readonly (string | number)[],
): T {
	const copy = structuredClone(root) as Record<string, unknown>;
	let cursor: Record<string, unknown> = copy;
	for (let i = 0; i < path.length - 1; i += 1) {
		cursor = cursor[path[i] as string] as Record<string, unknown>;
	}
	delete cursor[path[path.length - 1] as string];
	return copy as T;
}

/**
 * Replace a substring of the canonical bytes exactly once, THROWING when the
 * needle is absent or ambiguous. A byte vector that silently matched nothing
 * would be a green test asserting nothing — the failure mode a corpus exists
 * to prevent.
 */
export function replaceOnce(bytes: Buffer, needle: string, replacement: string): Buffer {
	const text = bytes.toString("utf8");
	const first = text.indexOf(needle);
	if (first < 0) throw new Error(`replaceOnce: needle not found: ${needle}`);
	if (text.indexOf(needle, first + 1) >= 0) {
		throw new Error(`replaceOnce: needle is ambiguous: ${needle}`);
	}
	return Buffer.from(
		text.slice(0, first) + replacement + text.slice(first + needle.length),
		"utf8",
	);
}

/** Inject raw text straight after the opening `{` — the duplicate-key vector. */
export function injectAfterOpeningBrace(bytes: Buffer, raw: string): Buffer {
	const text = bytes.toString("utf8");
	if (!text.startsWith("{")) throw new Error("injectAfterOpeningBrace: not a JSON object");
	return Buffer.from(`{${raw}${text.slice(1)}`, "utf8");
}

/** A different 64-hex string — used wherever a mutant needs "not that hash". */
export function otherHash(label: string): string {
	return sha256Hex(`usertrust/test-other/${label}`);
}

/** Flip one base64 character of a signature, keeping the length and alphabet. */
export function corruptBase64(value: string): string {
	const index = Math.floor(value.length / 2);
	const character = value[index] as string;
	return `${value.slice(0, index)}${character === "A" ? "B" : "A"}${value.slice(index + 1)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The independent fact vocabulary (see harness.test.ts for the checker).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The CRYPTOGRAPHIC and STRUCTURAL facts a mutant can break, computed in
 * `harness.test.ts` from the spec text and NOT from the verifier. Every vector
 * in `fixtures.ts` declares exactly which of these it breaks; the corpus test
 * asserts the computed set equals the declared one.
 *
 * The vocabulary stops at facts an independent checker can decide cheaply.
 * Authority state (revoked keys, `mintKeyIds` membership), §2's semantic
 * constraints, the §4 snapshot rules and the §7 history walk are deliberately
 * OUT of it: those vectors declare an EMPTY break set, which is itself the
 * assertion worth making — a revoked-key vector is cryptographically perfect,
 * and only trust state distinguishes it from a pass.
 */
export type FactName =
	| "parse"
	| "eq1"
	| "eq2"
	| "eq3"
	| "eq4"
	| "eq5"
	| "eq6"
	| "eq7"
	| "eq8"
	| "eq9"
	| "eventHash"
	| "receiptSignature"
	| "checkpointSignature"
	| "inclusionProof"
	| "transferSetRoot"
	| "envelopeAgreement";
