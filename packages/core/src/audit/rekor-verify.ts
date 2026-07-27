// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Rekor Transparency-Log Receipt Verification — Zero-dependency standalone
 *
 * INTENTIONAL DUPLICATION: this file exists byte-for-byte in BOTH
 * packages/verify/src/rekor-verify.ts and
 * packages/core/src/audit/rekor-verify.ts — here even the import paths match,
 * since the module's only sibling import is anchor-verify.js. The parity test
 * pins the two together; any change must land in both packages.
 *
 * A receipt is EVIDENCE SUPPLIED BY THE PARTY UNDER AUDIT: it proves nothing on
 * its own, and every field in it is attacker-shaped. What verification
 * establishes, end to end, is a single chain of bindings:
 *
 *   our signed anchor record -> the bytes the log stored -> that entry's
 *   position in a tree -> a checkpoint over that tree -> a log key the AUDITOR
 *   pinned (never one the receipt names).
 *
 * Break any link and the receipt is worthless, so each is checked in order and
 * the first failure is fatal (fail-closed). Rekor data deliberately lives in
 * SEPARATE receipt files: the anchor record schema is frozen, and a
 * transparency log must never become a field inside the thing it witnesses.
 *
 * Offline scope: a verified receipt proves the entry was included in the log at
 * `integratedTime` under a pinned key. It does NOT prove the log's current head
 * is consistent with that checkpoint — that needs a witness/consistency query,
 * which stays out of the zero-dependency verifier by design.
 */

import { createHash } from "node:crypto";
import {
	type AnchorRecord,
	anchorPayloadHash,
	publicKeyFromPem,
	verifySignatureRaw,
} from "./anchor-verify.js";

// ── Types ──

export interface RekorReceipt {
	v: 1;
	vaultId: string;
	anchorSeq: number;
	/** 64-hex — MUST equal anchorPayloadHash(record). */
	artifactHash: string;
	/** base64 of the entry bytes AS STORED BY THE LOG, never a reserialization. */
	entryBody: string;
	log: {
		url: string;
		logIndex: number;
		treeSize: number;
		/** 64-hex root the inclusion path must reconstruct. */
		rootHash: string;
		/** 64-hex inclusion path, leaf -> root order. */
		hashes: string[];
		/** Signed note (checkpoint) over treeSize + rootHash. */
		checkpoint: string;
		/** Unix seconds the log attests it integrated the entry. */
		integratedTime: number;
	};
}

export interface SignedNote {
	origin: string;
	treeSize: number;
	rootHashHex: string;
	/** EXACTLY the bytes the log signs: 3 body lines including the trailing LF. */
	body: string;
	/**
	 * Note signatures, each with its 4-byte key hint stripped off the front. A
	 * checkpoint carries the log's own signature plus one per co-signing witness.
	 */
	sigs: Buffer[];
}

export interface RekorVerification {
	ok: boolean;
	/** Witness-attested time in ms — the input to staleness policy when present. */
	attestedTimeMs: number | null;
	errors: string[];
}

// ── Constants ──

/**
 * The rekor.sigstore.dev v1 log key, as served by
 * https://rekor.sigstore.dev/api/v1/log/publicKey — ECDSA P-256, SPKI sha256
 * c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d (the log's
 * published logID). This is DATA, not a dependency, and it is not a blanket
 * trust root: it is consulted ONLY for receipts whose log URL host IS
 * rekor.sigstore.dev. Any other log must be pinned by the operator with
 * --rekor-pubkey.
 */
export const REKOR_PROD_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwr
kBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==
-----END PUBLIC KEY-----
`;

/** The one host the embedded key above is allowed to speak for. */
const REKOR_PROD_HOST = "rekor.sigstore.dev";

const ERR = "rekor-receipt-invalid";

// Caps on untrusted input. A receipt is a small artifact; anything near these
// bounds is an attempt to make the verifier do work, not to prove inclusion.
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_ENTRY_BODY_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024;
const MAX_INCLUSION_PATH = 64;
const MAX_PEM_BYTES = 16 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
// Matching control characters is the entire point here — they are what gets
// removed from anything echoed back to a terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the intent
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

const RECEIPT_KEYS = new Set(["v", "vaultId", "anchorSeq", "artifactHash", "entryBody", "log"]);
const LOG_KEYS = new Set([
	"url",
	"logIndex",
	"treeSize",
	"rootHash",
	"hashes",
	"checkpoint",
	"integratedTime",
]);

// ── Small helpers ──

/**
 * Untrusted values are never echoed whole into an error string. Control
 * characters are stripped BEFORE truncation, because these strings are printed
 * to a terminal: an escape sequence or a bare CR inside a field name would let
 * the party under audit repaint the line its own verdict is printed on, and
 * truncating first would leave a half-consumed escape behind.
 */
function clip(value: string): string {
	const scrubbed = value.replace(CONTROL_CHARS, "");
	return scrubbed.length <= 80 ? scrubbed : `${scrubbed.slice(0, 80)}...`;
}

function asObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isSafeIntAtLeast(value: unknown, min: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

/** Lowercased host (INCLUDING port) of an http(s) URL, or null. */
function logHost(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	return parsed.host.toLowerCase();
}

function nodeHash(left: Buffer, right: Buffer): Buffer {
	return createHash("sha256").update(NODE_PREFIX).update(left).update(right).digest();
}

// ── Signed notes (checkpoints) ──

/**
 * Parse a signed note:
 *   <origin>\n<treeSize>\n<base64 rootHash>\n\n— <keyname> <base64 sig>\n...
 * Strictly LF-only and strictly this shape — a note is a signed artifact, so
 * accepting variants would mean verifying a signature over bytes we did not
 * actually parse. The signature payload is `4-byte keyhint || DER signature`;
 * the hint identifies which key the log used and is ADVISORY only, because the
 * auditor pins the key out-of-band. Only its 4 bytes are skipped.
 *
 * ONE OR MORE signature lines are accepted: a production checkpoint is signed by
 * the log and co-signed by its witnesses, and every line must still be
 * well-formed. Which of them (if any) speaks for the auditor is decided later,
 * against the pinned keyring — never here.
 */
export function parseSignedNote(note: string): SignedNote | null {
	if (note.length === 0 || Buffer.byteLength(note, "utf8") > MAX_CHECKPOINT_BYTES) return null;
	if (note.includes("\r")) return null;
	const lines = note.split("\n");
	if (lines.length > 5 && lines[lines.length - 1] === "") lines.pop();
	if (lines.length < 5) return null;
	const origin = lines[0] as string;
	const sizeLine = lines[1] as string;
	const rootB64 = lines[2] as string;
	if (origin.length === 0 || lines[3] !== "") return null;
	if (!UINT.test(sizeLine)) return null;
	const treeSize = Number(sizeLine);
	if (!Number.isSafeInteger(treeSize)) return null;
	if (!BASE64.test(rootB64)) return null;
	const root = Buffer.from(rootB64, "base64");
	if (root.length !== 32) return null;
	const sigs: Buffer[] = [];
	for (const line of lines.slice(4)) {
		const parts = line.split(" ");
		if (parts.length !== 3 || parts[0] !== "—" || (parts[1] as string).length === 0) return null;
		const sigField = parts[2] as string;
		if (!BASE64.test(sigField)) return null;
		const raw = Buffer.from(sigField, "base64");
		if (raw.length <= 4) return null;
		sigs.push(raw.subarray(4));
	}
	return {
		origin,
		treeSize,
		rootHashHex: root.toString("hex"),
		body: `${origin}\n${sizeLine}\n${rootB64}\n`,
		sigs,
	};
}

/**
 * Does a checkpoint's signed origin name the host the receipt says it came from?
 * A production Rekor checkpoint's origin is `"<host> - <treeID>"`, while the
 * signed-note format also permits the bare host; both identify the same log, so
 * only the part before the first " - " is compared. The comparison stays exact
 * on that part — a suffix rule would let evil.example.org.attacker.net pass.
 */
function originNamesHost(origin: string, host: string): boolean {
	const separator = origin.indexOf(" - ");
	const named = separator === -1 ? origin : origin.slice(0, separator);
	return named.toLowerCase() === host;
}

// ── RFC 9162 inclusion ──

/**
 * RFC 9162 §2.1.3.2 inclusion verification: walk the audit path from the leaf
 * to the root, deciding sibling order from the leaf index rather than from any
 * hint the proof supplies. `fn`/`sn` track the leaf's and the last leaf's
 * positions within the current subtree; the right-shift after a left-sibling
 * merge is what makes right-edge (incomplete) subtrees come out correct.
 *
 * Never throws: malformed hex, out-of-range indices, and over-long paths are
 * rejections, because this runs on attacker-supplied input.
 */
export function verifyIndexInclusion(
	leafHex: string,
	index: number,
	treeSize: number,
	pathHex: readonly string[],
	rootHex: string,
): boolean {
	if (!Number.isSafeInteger(index) || !Number.isSafeInteger(treeSize)) return false;
	if (index < 0 || treeSize < 1 || index >= treeSize) return false;
	if (!HEX64.test(leafHex) || !HEX64.test(rootHex)) return false;
	if (pathHex.length > MAX_INCLUSION_PATH) return false;

	let fn = index;
	let sn = treeSize - 1;
	let r: Buffer = Buffer.from(leafHex, "hex");
	for (const pHex of pathHex) {
		if (!HEX64.test(pHex)) return false;
		if (sn === 0) return false;
		const p = Buffer.from(pHex, "hex");
		if (fn % 2 === 1 || fn === sn) {
			r = nodeHash(p, r);
			// LSB(fn) not set (the fn === sn right-edge case): shift both equally
			// until LSB(fn) is set or fn is 0.
			while (fn % 2 === 0 && fn !== 0) {
				fn = Math.floor(fn / 2);
				sn = Math.floor(sn / 2);
			}
		} else {
			r = nodeHash(r, p);
		}
		fn = Math.floor(fn / 2);
		sn = Math.floor(sn / 2);
	}
	return sn === 0 && r.toString("hex") === rootHex;
}

// ── Strict receipt parsing ──

/**
 * Strict parse of one receipt. Unknown fields, wrong types, and range
 * violations are all rejected before any crypto runs — the same fail-closed
 * posture as parseAnchorRecord, for the same reason: a field the verifier
 * silently ignores is a field an attacker can use.
 */
export function parseRekorReceipt(raw: string): {
	receipt: RekorReceipt | null;
	error: string | null;
} {
	const bad = (message: string): { receipt: null; error: string } => ({
		receipt: null,
		error: `${ERR}: ${message}`,
	});

	if (Buffer.byteLength(raw, "utf8") > MAX_RECEIPT_BYTES) return bad("receipt exceeds 256 KiB");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return bad("not valid JSON");
	}
	const obj = asObject(parsed);
	if (obj === null) return bad("not an object");
	for (const key of Object.keys(obj)) {
		if (!RECEIPT_KEYS.has(key)) return bad(`unknown field "${clip(key)}"`);
	}
	if (obj.v !== 1) return bad("unsupported version");
	if (typeof obj.vaultId !== "string" || obj.vaultId.length === 0) return bad("missing vaultId");
	if (!isSafeIntAtLeast(obj.anchorSeq, 1)) {
		return bad("anchorSeq must be a safe integer >= 1");
	}
	if (typeof obj.artifactHash !== "string" || !HEX64.test(obj.artifactHash)) {
		return bad("artifactHash must be 64 lowercase hex characters");
	}
	if (typeof obj.entryBody !== "string" || obj.entryBody.length === 0) {
		return bad("missing entryBody");
	}
	if (!BASE64.test(obj.entryBody)) return bad("entryBody must be base64");
	if (Buffer.from(obj.entryBody, "base64").length > MAX_ENTRY_BODY_BYTES) {
		return bad("entryBody exceeds 64 KiB decoded");
	}

	const log = asObject(obj.log);
	if (log === null) return bad("log must be an object");
	for (const key of Object.keys(log)) {
		if (!LOG_KEYS.has(key)) return bad(`unknown log field "${clip(key)}"`);
	}
	if (typeof log.url !== "string" || logHost(log.url) === null) {
		return bad("log.url must be an http(s) URL");
	}
	if (!isSafeIntAtLeast(log.logIndex, 0)) return bad("log.logIndex must be a safe integer >= 0");
	if (!isSafeIntAtLeast(log.treeSize, 1)) return bad("log.treeSize must be a safe integer >= 1");
	if (log.logIndex >= log.treeSize) return bad("log.logIndex must be < log.treeSize");
	if (typeof log.rootHash !== "string" || !HEX64.test(log.rootHash)) {
		return bad("log.rootHash must be 64 lowercase hex characters");
	}
	if (!Array.isArray(log.hashes) || log.hashes.length > MAX_INCLUSION_PATH) {
		return bad(`log.hashes must be an array of at most ${MAX_INCLUSION_PATH} hashes`);
	}
	for (const h of log.hashes) {
		if (typeof h !== "string" || !HEX64.test(h)) {
			return bad("log.hashes entries must be 64 lowercase hex characters");
		}
	}
	if (
		typeof log.checkpoint !== "string" ||
		log.checkpoint.length === 0 ||
		Buffer.byteLength(log.checkpoint, "utf8") > MAX_CHECKPOINT_BYTES
	) {
		return bad("log.checkpoint must be a non-empty string of at most 8 KiB");
	}
	if (!isSafeIntAtLeast(log.integratedTime, 1)) {
		return bad("log.integratedTime must be a safe integer > 0");
	}
	return { receipt: obj as unknown as RekorReceipt, error: null };
}

// ── Entry binding ──

/**
 * The logged entry must commit to OUR artifact AND OUR signature. Without the
 * signature binding, anyone could log the (public) payload hash of someone
 * else's anchor and present the resulting receipt as their own.
 */
function checkHashedRekordEntry(
	entryBytes: Buffer,
	artifactHash: string,
	recordSigBase64: string,
): string | null {
	if (entryBytes.length === 0) return "entryBody decodes to no bytes";
	if (entryBytes.length > MAX_ENTRY_BODY_BYTES) return "entryBody exceeds 64 KiB decoded";
	let parsed: unknown;
	try {
		parsed = JSON.parse(entryBytes.toString("utf8"));
	} catch {
		return "entryBody is not valid JSON";
	}
	const entry = asObject(parsed);
	if (entry === null) return "entryBody is not a JSON object";
	if (entry.kind !== "hashedrekord") return "entryBody kind is not hashedrekord";
	const spec = asObject(entry.spec);
	if (spec === null) return "entryBody spec is missing";
	const hash = asObject(asObject(spec.data)?.hash);
	if (hash === null) return "entryBody spec.data.hash is missing";
	if (hash.algorithm !== "sha256") return "entryBody spec.data.hash.algorithm is not sha256";
	if (hash.value !== artifactHash) {
		return "entryBody spec.data.hash.value does not match the receipt artifactHash";
	}
	const signature = asObject(spec.signature);
	if (signature === null || typeof signature.content !== "string") {
		return "entryBody spec.signature.content is missing";
	}
	// Compare DECODED bytes: base64 spelling is not canonical, so string
	// equality would reject honest receipts and is not what "same signature"
	// means.
	const logged = Buffer.from(signature.content, "base64");
	const ours = Buffer.from(recordSigBase64, "base64");
	if (ours.length === 0 || !logged.equals(ours)) {
		return "entryBody spec.signature.content is not the anchor record signature";
	}
	return null;
}

/**
 * Which key(s) may speak for this log. Supplying no key is only meaningful for
 * the one log whose key ships with the verifier; for anything else, an unpinned
 * receipt would be self-certifying, so it is refused rather than trusted.
 *
 * A caller who supplied material that ALL got discarded (empty file, oversized
 * blob) is not a caller who supplied nothing: silently falling back to the
 * embedded key there would verify a rekor.sigstore.dev receipt under a key the
 * auditor never chose, and pass a merge gate the auditor thought they had
 * pinned. Discarded-everything is refused instead.
 */
function resolveLogKeyring(
	host: string,
	logPubkeysPem: readonly string[],
): { keys: readonly string[]; error: string | null } {
	const supplied = logPubkeysPem.filter(
		(pem) => pem.length > 0 && Buffer.byteLength(pem, "utf8") <= MAX_PEM_BYTES,
	);
	if (supplied.length > 0) return { keys: supplied, error: null };
	if (logPubkeysPem.length > 0) {
		return {
			keys: [],
			error:
				"supplied --rekor-pubkey material is empty or invalid — refusing to fall back to the embedded key",
		};
	}
	if (host === REKOR_PROD_HOST) return { keys: [REKOR_PROD_PUBKEY_PEM], error: null };
	return {
		keys: [],
		error: `custom log requires --rekor-pubkey (no pinned key for log host ${clip(host)})`,
	};
}

// ── Receipt verification ──

/**
 * Verify one receipt against the anchor record it claims to witness, under a
 * caller-pinned keyring (any key in the ring may verify the checkpoint).
 *
 * The order below is the binding chain, and it is deliberate: cheap identity
 * and hash checks first, then the entry decode, then the inclusion walk, and
 * only then the signature — so a receipt for the wrong record can never cost an
 * ECDSA verification, and a failure always names the earliest broken link.
 */
export function verifyRekorReceipt(
	receipt: RekorReceipt,
	record: AnchorRecord,
	logPubkeysPem: readonly string[],
): RekorVerification {
	const errors: string[] = [];
	const fail = (message: string): RekorVerification => {
		errors.push(`${ERR}: ${message}`);
		return { ok: false, attestedTimeMs: null, errors };
	};

	// 1 — the receipt must name THIS record.
	if (receipt.vaultId !== record.vaultId || receipt.anchorSeq !== record.anchorSeq) {
		return fail(
			`record mismatch: receipt claims vault ${clip(receipt.vaultId)} anchorSeq ${receipt.anchorSeq}`,
		);
	}

	// 2 — and must carry that record's signing-payload hash.
	const payloadHash = anchorPayloadHash(record);
	if (receipt.artifactHash !== payloadHash) {
		return fail("artifactHash is not the anchor payload hash of this record");
	}

	// 3 — the bytes the log stored must commit to the artifact and our signature.
	const entryBytes = Buffer.from(receipt.entryBody, "base64");
	const entryError = checkHashedRekordEntry(entryBytes, payloadHash, record.sig);
	if (entryError !== null) return fail(entryError);

	// 4/5 — sha256(0x00 || stored bytes) must sit at logIndex under log.rootHash.
	const leafHex = createHash("sha256").update(LEAF_PREFIX).update(entryBytes).digest("hex");
	if (
		!verifyIndexInclusion(
			leafHex,
			receipt.log.logIndex,
			receipt.log.treeSize,
			receipt.log.hashes,
			receipt.log.rootHash,
		)
	) {
		return fail(
			`inclusion proof does not reconstruct log.rootHash from logIndex ${receipt.log.logIndex} of ${receipt.log.treeSize}`,
		);
	}

	// 6 — the checkpoint must be this log's, at this size, over this root.
	const host = logHost(receipt.log.url);
	if (host === null) return fail("log.url is not an http(s) URL");
	const note = parseSignedNote(receipt.log.checkpoint);
	if (note === null) return fail("log.checkpoint is not a parseable signed note");
	if (!originNamesHost(note.origin, host)) {
		return fail(`log.checkpoint origin ${clip(note.origin)} is not the log.url host ${clip(host)}`);
	}
	if (note.treeSize !== receipt.log.treeSize) {
		return fail(
			`log.checkpoint treeSize ${note.treeSize} does not match log.treeSize ${receipt.log.treeSize}`,
		);
	}
	if (note.rootHashHex !== receipt.log.rootHash) {
		return fail("log.checkpoint root hash does not match log.rootHash");
	}

	// 7 — and must be signed by a key the AUDITOR pinned. A co-signed checkpoint
	// carries one signature per witness, and the auditor pins only the parties
	// they trust: ONE line verifying under ONE pinned key is the whole claim.
	const keyring = resolveLogKeyring(host, logPubkeysPem);
	if (keyring.error !== null) return fail(keyring.error);
	const sigsBase64 = note.sigs.map((sig) => sig.toString("base64"));
	const signed = keyring.keys.some((pem) => {
		const key = publicKeyFromPem(pem);
		if (key === null) return false;
		return sigsBase64.some((sig) => verifySignatureRaw("ecdsa-p256", note.body, key, sig));
	});
	if (!signed) {
		return fail("log.checkpoint signature does not verify under any pinned log public key");
	}

	// 8 — every link held, so the log's integration time is witness-attested.
	return { ok: true, attestedTimeMs: receipt.log.integratedTime * 1000, errors };
}
