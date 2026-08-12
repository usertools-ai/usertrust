// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ut1 receipt verification — receipt-spec v0.9 §7, offline.
 *
 * VERIFY-ONLY. There is no core counterpart and there must never be one: core
 * does not mint ut1 receipts, so this file is not a mirrored module and the
 * parity contract's byte-identity rule does not apply to it. What DOES apply is
 * the import rule — `node:crypto`, `node:fs`, `node:path` and `./`-relative
 * siblings only.
 *
 * This file grows across the ship. Today it holds step 1's STRICT BYTE READER,
 * the §8 TRUST-SNAPSHOT LOADER, and §7 steps 1–8 — the BASE verdict. Step 9's
 * extensions and the CLI surface land on top of it.
 *
 * Two rules govern everything here, and both are load-bearing rather than
 * stylistic:
 *
 *  1. **A throw is never a verdict.** Every entry point returns a discriminated
 *     result. `canonicalize` throws on `NaN`/`Infinity` by design, so the
 *     reader rejects those as VALUES before canonicalization is ever reached
 *     (CLI spec §3) — otherwise a data defect and a crash are the same event to
 *     the caller.
 *  2. **Refusals carry their CLASS, because the class picks the exit code.**
 *     Bytes that never became a document are missing material (UNVERIFIABLE,
 *     exit 2); a document that parsed and then broke §5 is a negative answer
 *     (FAILED / `SCHEMA_INVALID`, exit 1). CLI spec §5's table is normative on
 *     that line and the two must never collapse into one.
 *
 * What this module deliberately does NOT do: shape validation beyond key sets,
 * §12 ID decoding, and the literals `spec`/`scope`/`alg`. Those are step 1's
 * too, but they belong with the steps that own the conditions around them —
 * and CLI spec §5's precedence rule is explicit that step 1's schema
 * validation must not pre-empt a condition a normative equality names. The
 * clearest case is `event.actor`: equality 2 owns it as one canonical-bytes
 * comparison, so the unknown-field walk below does not descend into it.
 */

import { createHash, type KeyObject } from "node:crypto";
import { publicKeyFromPem, publicKeyFromSpkiBase64, verifySignatureRaw } from "./anchor-verify.js";
import { canonicalize } from "./canonical.js";
import { type MerkleInclusionProof, verifyInclusionProof } from "./verify.js";

// ─────────────────────────────────────────────────────────────────────────────
// JSON value model.
// ─────────────────────────────────────────────────────────────────────────────

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
	[key: string]: JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical base64 (CLI spec §3, §4).
//
// `verifySignatureRaw` and the SPKI parser both reach for
// `Buffer.from(x, "base64")`, which silently discards characters outside the
// alphabet and tolerates junk appended past the padding: two different strings
// decode to the same bytes, and only one of them is what was signed. Every
// signature, key and byte-blob input is checked here FIRST.
//
// The round-trip is the test, not the regex — it also catches a final sextet
// whose unused bits are non-zero, which no character-class check can see.
// ─────────────────────────────────────────────────────────────────────────────

const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

export function isCanonicalBase64(text: string): boolean {
	if (text.length % 4 !== 0) return false;
	if (!BASE64_ALPHABET.test(text)) return false;
	if (text.length === 0) return true;
	// Padding may appear only in the final quantum, which the alphabet regex
	// permits but does not require to be terminal ("AB=C" passes it).
	const firstPad = text.indexOf("=");
	if (firstPad !== -1 && firstPad < text.length - 2) return false;
	return Buffer.from(text, "base64").toString("base64") === text;
}

export function decodeCanonicalBase64(text: string): Buffer | null {
	return isCanonicalBase64(text) ? Buffer.from(text, "base64") : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fatal UTF-8 with ignoreBOM (CLI spec §3 step 2).
//
// `ignoreBOM: true` RETAINS the BOM rather than stripping it. That reads
// backwards until you remember what the flag names: it means "do not treat a
// leading U+FEFF as metadata", so the three bytes stay in the string and the
// document that carried them is rejected at parse. Stripping them would drop
// three SIGNED bytes from a document the verifier then reports as verified —
// PR #92's defect, and receipt-spec §7's own named example of a system that
// accepts what it cannot interpret and reports success.
// ─────────────────────────────────────────────────────────────────────────────

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeUtf8Strict(bytes: Uint8Array): string | null {
	try {
		return UTF8_STRICT.decode(bytes);
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-parse duplicate-key scan (§4a, §11).
//
// §4a applies the rule to "receipts AND well-known documents" and §11 requires
// it "before object parsing". `JSON.parse` cannot express it: it keeps the LAST
// occurrence silently, so `"state":"revoked"` followed by `"state":"active"`
// resolves to `active` with no error anywhere. A reviver sees the same collapsed
// object. Nothing short of a scan over the TEXT can decide it.
//
// The scanner validates the whole JSON grammar as it goes. That is not
// duplicated effort with `JSON.parse` — it is what lets a malformed document be
// refused by the scan rather than reported as "no duplicates found", which is
// the fail-open reading of a scan that only looks for one thing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nesting cap. It bounds the scanner's own recursion, and — because nothing
 * downstream sees a document the scanner refused — it bounds every later walk
 * over the parsed value too. A stack overflow is an uncatchable-shaped failure
 * in a tool whose contract is that a throw is never a verdict.
 */
const MAX_JSON_DEPTH = 128;

export type JsonScanResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly detail: string };

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const HEX_DIGIT = /^[0-9a-fA-F]$/;

class JsonScanner {
	private pos = 0;

	constructor(private readonly text: string) {}

	scan(): JsonScanResult {
		if (this.text.charCodeAt(0) === 0xfeff) {
			// Named explicitly. "unexpected character" would be true and useless:
			// the operator needs to know the BOM was RETAINED and rejected, not
			// that something invisible was somewhere.
			return { ok: false, detail: "byte-order mark at offset 0: canonical JSON carries none" };
		}
		const failure = this.value(0, "$");
		if (failure !== null) return { ok: false, detail: failure };
		this.whitespace();
		if (this.pos !== this.text.length) {
			return { ok: false, detail: `trailing content at offset ${this.pos}` };
		}
		return { ok: true };
	}

	private whitespace(): void {
		while (this.pos < this.text.length && WHITESPACE.has(this.text[this.pos] as string)) {
			this.pos += 1;
		}
	}

	/** Returns a failure detail, or `null` when one well-formed value was consumed. */
	private value(depth: number, path: string): string | null {
		if (depth > MAX_JSON_DEPTH) {
			return `nesting deeper than ${MAX_JSON_DEPTH} at ${path}`;
		}
		this.whitespace();
		const ch = this.text[this.pos];
		if (ch === undefined) return `unexpected end of input at offset ${this.pos}`;
		if (ch === "{") return this.object(depth, path);
		if (ch === "[") return this.array(depth, path);
		if (ch === '"') return this.string();
		if (ch === "-" || (ch >= "0" && ch <= "9")) return this.number();
		for (const literal of ["true", "false", "null"]) {
			if (this.text.startsWith(literal, this.pos)) {
				this.pos += literal.length;
				return null;
			}
		}
		return `unexpected character ${JSON.stringify(ch)} at offset ${this.pos}`;
	}

	private object(depth: number, path: string): string | null {
		this.pos += 1; // "{"
		const seen = new Set<string>();
		this.whitespace();
		if (this.text[this.pos] === "}") {
			this.pos += 1;
			return null;
		}
		for (;;) {
			this.whitespace();
			if (this.text[this.pos] !== '"') {
				return `expected a member name at offset ${this.pos}`;
			}
			const start = this.pos;
			const stringFailure = this.string();
			if (stringFailure !== null) return stringFailure;
			const key = JSON.parse(this.text.slice(start, this.pos)) as string;
			if (seen.has(key)) {
				return `duplicate JSON key ${JSON.stringify(key)} at ${path}`;
			}
			seen.add(key);
			this.whitespace();
			if (this.text[this.pos] !== ":") return `expected ':' at offset ${this.pos}`;
			this.pos += 1;
			const valueFailure = this.value(depth + 1, `${path}.${key}`);
			if (valueFailure !== null) return valueFailure;
			this.whitespace();
			const next = this.text[this.pos];
			if (next === ",") {
				this.pos += 1;
				continue;
			}
			if (next === "}") {
				this.pos += 1;
				return null;
			}
			return `expected ',' or '}' at offset ${this.pos}`;
		}
	}

	private array(depth: number, path: string): string | null {
		this.pos += 1; // "["
		this.whitespace();
		if (this.text[this.pos] === "]") {
			this.pos += 1;
			return null;
		}
		let index = 0;
		for (;;) {
			const failure = this.value(depth + 1, `${path}[${index}]`);
			if (failure !== null) return failure;
			this.whitespace();
			const next = this.text[this.pos];
			if (next === ",") {
				this.pos += 1;
				index += 1;
				continue;
			}
			if (next === "]") {
				this.pos += 1;
				return null;
			}
			return `expected ',' or ']' at offset ${this.pos}`;
		}
	}

	private string(): string | null {
		this.pos += 1; // opening quote
		for (;;) {
			const ch = this.text[this.pos];
			if (ch === undefined) return `unterminated string at offset ${this.pos}`;
			if (ch === '"') {
				this.pos += 1;
				return null;
			}
			if (ch === "\\") {
				const escaped = this.text[this.pos + 1];
				if (escaped === undefined) return `unterminated escape at offset ${this.pos}`;
				if (escaped === "u") {
					for (let i = 2; i < 6; i += 1) {
						const digit = this.text[this.pos + i];
						if (digit === undefined || !HEX_DIGIT.test(digit)) {
							return `invalid \\u escape at offset ${this.pos}`;
						}
					}
					this.pos += 6;
					continue;
				}
				if (!'"\\/bfnrt'.includes(escaped)) {
					return `invalid escape ${JSON.stringify(escaped)} at offset ${this.pos}`;
				}
				this.pos += 2;
				continue;
			}
			if (ch.charCodeAt(0) < 0x20) {
				return `raw control character in string at offset ${this.pos}`;
			}
			this.pos += 1;
		}
	}

	private number(): string | null {
		const start = this.pos;
		if (this.text[this.pos] === "-") this.pos += 1;
		if (this.text[this.pos] === "0") {
			this.pos += 1;
		} else {
			const first = this.text[this.pos];
			if (first === undefined || first < "1" || first > "9") {
				return `invalid number at offset ${start}`;
			}
			while (this.isDigit(this.text[this.pos])) this.pos += 1;
		}
		if (this.text[this.pos] === ".") {
			this.pos += 1;
			if (!this.isDigit(this.text[this.pos])) return `invalid number at offset ${start}`;
			while (this.isDigit(this.text[this.pos])) this.pos += 1;
		}
		const exponent = this.text[this.pos];
		if (exponent === "e" || exponent === "E") {
			this.pos += 1;
			const sign = this.text[this.pos];
			if (sign === "+" || sign === "-") this.pos += 1;
			if (!this.isDigit(this.text[this.pos])) return `invalid number at offset ${start}`;
			while (this.isDigit(this.text[this.pos])) this.pos += 1;
		}
		return null;
	}

	private isDigit(ch: string | undefined): boolean {
		return ch !== undefined && ch >= "0" && ch <= "9";
	}
}

export function scanJsonForDuplicateKeys(text: string): JsonScanResult {
	return new JsonScanner(text).scan();
}

// ─────────────────────────────────────────────────────────────────────────────
// The frozen numeric rules (CLI spec §3 step 4).
//
// Every number anywhere in a ut1 document is a SAFE INTEGER — §2 declares no
// fractional domain, and §13 is explicit that "§2's own integer domains (safe
// integers, no `-0`) are enforced by SCHEMA validation before canonicalization,
// not by this function".
//
// Each rejection earns its place:
//  - non-finite: `1e999` PARSES to Infinity, so it is a reachable VALUE, and
//    canonicalize THROWS on it. Rejecting it here is what keeps the throw off
//    the verdict path.
//  - `-0`: compares `=== 0` yet `JSON.stringify(-0)` is `0` while
//    `Object.is` separates them — equality and canonical bytes would disagree.
//  - unsafe integers: `9007199254740993` parses to …992. Accepting it means
//    signing a number that already lost a bit.
// ─────────────────────────────────────────────────────────────────────────────

export interface NumberViolation {
	/** Dotted path, `""` for a bare top-level number. Diagnostic only. */
	readonly path: string;
	/** The offending value, carried out rather than re-looked-up: a dotted path
	 * is lossy (a key containing `.` reads back as two segments), and a reader
	 * that mislabels WHY it refused is a reader an operator cannot act on. */
	readonly value: number;
}

/** The first offending number in document order, or `null`. */
export function findNonFrozenNumber(value: unknown, path = ""): NumberViolation | null {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0) || !Number.isSafeInteger(value)) {
			return { path, value };
		}
		return null;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i += 1) {
			const found = findNonFrozenNumber(value[i], path === "" ? String(i) : `${path}.${i}`);
			if (found !== null) return found;
		}
		return null;
	}
	if (isJsonObject(value)) {
		for (const key of Object.keys(value)) {
			const found = findNonFrozenNumber(value[key], path === "" ? key : `${path}.${key}`);
			if (found !== null) return found;
		}
	}
	return null;
}

export function describeNumberViolation(value: number): string {
	if (!Number.isFinite(value)) return "non-finite number";
	if (Object.is(value, -0)) return "negative zero";
	if (!Number.isInteger(value)) return "non-integer number";
	return "integer outside the safe range";
}

// ─────────────────────────────────────────────────────────────────────────────
// Unknown-field rejection (§5: "Unknown fields in the signed receipt → FAIL";
// §2: "any unknown field anywhere in a `ut1` document is FAIL").
//
// A KEY-SET check, never a shape check. Missing members, wrong types and
// presence RULES (`workloadId` iff `workflowAttested`, `transferSet` iff
// `transferCount ≤ 32`) belong to steps 2 and 7, which own their failure codes.
// Descending into a member whose value is not an object is therefore silence
// here, not a pass — the step that consumes it reports it.
// ─────────────────────────────────────────────────────────────────────────────

type KeySet = ReadonlySet<string>;

const RECEIPT_KEYS: KeySet = new Set([
	"spec",
	"receiptId",
	"scope",
	"mintedAt",
	"minter",
	"work",
	"event",
	"proof",
	"signature",
]);
const MINTER_KEYS: KeySet = new Set(["kind", "keyId", "trustDomain"]);
const SIGNATURE_KEYS: KeySet = new Set(["alg", "keyId", "sig"]);
const EVENT_KEYS: KeySet = new Set([
	"id",
	"timestamp",
	"previousHash",
	"kind",
	"actor",
	"data",
	"sequence",
	"hash",
]);
const PROOF_KEYS: KeySet = new Set([
	"profile",
	"chain",
	"mintEventHash",
	"inclusion",
	"checkpoint",
]);
const INCLUSION_KEYS: KeySet = new Set([
	"version",
	"leafHash",
	"leafIndex",
	"treeSize",
	"root",
	"siblings",
	"segmentId",
]);
const SIBLING_KEYS: KeySet = new Set(["hash", "position"]);
const CHECKPOINT_KEYS: KeySet = new Set([
	"v",
	"vaultId",
	"profile",
	"root",
	"treeSize",
	"segmentId",
	"segmentFirstSequence",
	"previousSegmentRoot",
	"previousSegmentId",
	"keyId",
	"publishedAt",
	"sig",
]);
const PROJECTION_KEYS: KeySet = new Set([
	"spec",
	"scope",
	"sessionId",
	"generation",
	"prevGenerationEventHash",
	"work",
	"sessionAssociation",
	"workloadId",
	"models",
	"providers",
	"startedAt",
	"endedAt",
	"spend",
	"delegationPosture",
	"pricing",
	"transferSet",
	"transferSetRoot",
]);
const SPEND_KEYS: KeySet = new Set([
	"assessedUsertokens",
	"postedUsertokens",
	"roundingAdjustment",
	"transferCount",
	"usagePosture",
	"pricingPosture",
]);
const PRICING_KEYS: KeySet = new Set(["tableVersions"]);
const TRANSFER_PAIR_KEYS: KeySet = new Set(["authorizationTransferId", "settlementTransferId"]);
const MEMBERSHIP_KEYS: KeySet = new Set(["status", "proofId"]);
const ORIGIN_KEYS: KeySet = new Set(["kind", "sourceReservationReceiptId"]);

/** §2's discriminated union. An UNLISTED `kind` is step 7's, not step 1's. */
const WORK_KEYS_BY_KIND: ReadonlyMap<string, KeySet> = new Map<string, KeySet>([
	[
		"commit",
		new Set(["kind", "repoId", "repo", "oid", "oidAlg", "objectSha256", "repositoryMembership"]),
	],
	[
		"pr",
		new Set([
			"kind",
			"repoId",
			"repo",
			"number",
			"providerArtifactId",
			"observedRevision",
			"contentBinding",
			"repositoryMembership",
		]),
	],
	[
		"issue",
		new Set([
			"kind",
			"repoId",
			"repo",
			"number",
			"providerArtifactId",
			"observedRevision",
			"contentBinding",
			"repositoryMembership",
		]),
	],
	// Both `session` variants in one set: `origin` present ⇒ fallback, absent ⇒
	// ordinary, and §2 makes the two mutually exclusive rather than differently
	// keyed. Which variant this is, and whether `origin` is legal on it, is
	// step 7's ("`work` matching exactly one union variant").
	["session", new Set(["kind", "repoId", "repo", "origin"])],
]);

const CONTENT_BINDING_KEYS_BY_KIND: ReadonlyMap<string, KeySet> = new Map<string, KeySet>([
	["publicSha256", new Set(["kind", "sha256"])],
	["privateHmacSha256V1", new Set(["kind", "commitment"])],
]);

function join(path: string, key: string): string {
	return path === "" ? key : `${path}.${key}`;
}

function unknownIn(value: JsonValue | undefined, allowed: KeySet, path: string): string | null {
	if (!isJsonObject(value)) return null;
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) return join(path, key);
	}
	return null;
}

function objectAt(parent: JsonValue | undefined, key: string): JsonObject | undefined {
	if (!isJsonObject(parent)) return undefined;
	const child = parent[key];
	return isJsonObject(child) ? child : undefined;
}

function findUnknownWorkField(work: JsonValue | undefined, path: string): string | null {
	if (!isJsonObject(work)) return null;
	const kind = work.kind;
	if (typeof kind !== "string") return null;
	const allowed = WORK_KEYS_BY_KIND.get(kind);
	if (allowed === undefined) return null;
	const unknown = unknownIn(work, allowed, path);
	if (unknown !== null) return unknown;

	const membership = unknownIn(
		work.repositoryMembership,
		MEMBERSHIP_KEYS,
		join(path, "repositoryMembership"),
	);
	if (membership !== null) return membership;

	const origin = unknownIn(work.origin, ORIGIN_KEYS, join(path, "origin"));
	if (origin !== null) return origin;

	const binding = work.contentBinding;
	if (isJsonObject(binding) && typeof binding.kind === "string") {
		const bindingKeys = CONTENT_BINDING_KEYS_BY_KIND.get(binding.kind);
		if (bindingKeys !== undefined) {
			return unknownIn(binding, bindingKeys, join(path, "contentBinding"));
		}
	}
	return null;
}

function findUnknownProjectionField(data: JsonValue | undefined, path: string): string | null {
	if (!isJsonObject(data)) return null;
	const unknown = unknownIn(data, PROJECTION_KEYS, path);
	if (unknown !== null) return unknown;

	const work = findUnknownWorkField(data.work, join(path, "work"));
	if (work !== null) return work;

	const spend = unknownIn(data.spend, SPEND_KEYS, join(path, "spend"));
	if (spend !== null) return spend;

	const pricing = unknownIn(data.pricing, PRICING_KEYS, join(path, "pricing"));
	if (pricing !== null) return pricing;

	const transferSet = data.transferSet;
	if (Array.isArray(transferSet)) {
		for (let i = 0; i < transferSet.length; i += 1) {
			const pair = unknownIn(
				transferSet[i],
				TRANSFER_PAIR_KEYS,
				`${join(path, "transferSet")}.${i}`,
			);
			if (pair !== null) return pair;
		}
	}
	return null;
}

/** Path of the first unknown field in the SIGNED receipt, or `null`. */
export function findUnknownReceiptField(receipt: JsonObject): string | null {
	const top = unknownIn(receipt, RECEIPT_KEYS, "");
	if (top !== null) return top;

	const minter = unknownIn(receipt.minter, MINTER_KEYS, "minter");
	if (minter !== null) return minter;

	const signature = unknownIn(receipt.signature, SIGNATURE_KEYS, "signature");
	if (signature !== null) return signature;

	const work = findUnknownWorkField(receipt.work, "work");
	if (work !== null) return work;

	// `event.actor` is NOT walked. §4a fixes the actor as a closed union and
	// equality 2 compares it as canonical BYTES, so an extra actor member is an
	// EVENT_MISMATCH; reporting it as SCHEMA_INVALID here would name the wrong
	// step for a condition a normative equality already owns (CLI spec §5).
	const event = unknownIn(receipt.event, EVENT_KEYS, "event");
	if (event !== null) return event;
	const projection = findUnknownProjectionField(objectAt(receipt, "event")?.data, "event.data");
	if (projection !== null) return projection;

	const proof = unknownIn(receipt.proof, PROOF_KEYS, "proof");
	if (proof !== null) return proof;

	const proofObject = objectAt(receipt, "proof");
	const inclusion = unknownIn(proofObject?.inclusion, INCLUSION_KEYS, "proof.inclusion");
	if (inclusion !== null) return inclusion;

	const siblings = objectAt(proofObject, "inclusion")?.siblings;
	if (Array.isArray(siblings)) {
		for (let i = 0; i < siblings.length; i += 1) {
			const sibling = unknownIn(siblings[i], SIBLING_KEYS, `proof.inclusion.siblings.${i}`);
			if (sibling !== null) return sibling;
		}
	}

	return unknownIn(proofObject?.checkpoint, CHECKPOINT_KEYS, "proof.checkpoint");
}

// ─────────────────────────────────────────────────────────────────────────────
// The strict byte reader (CLI spec §3, receipt-spec §7 step 1).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `unparseable` — the bytes never became a ut1 document. Missing required
 * material: UNVERIFIABLE, `missing: receiptBytes`, exit 2.
 *
 * `schema` — a document that parsed and then broke §3's frozen numerics or
 * §5's strict schema. A real negative answer: FAILED, `SCHEMA_INVALID`, exit 1.
 */
export interface ReadRefusal {
	readonly kind: "unparseable" | "schema";
	readonly detail: string;
}

export type ReadOutcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly refusal: ReadRefusal };

function unparseable(detail: string): ReadOutcome<never> {
	return { ok: false, refusal: { kind: "unparseable", detail } };
}

function schemaRefusal(detail: string): ReadOutcome<never> {
	return { ok: false, refusal: { kind: "schema", detail } };
}

/** Bytes → a JSON value, with fatal UTF-8, retained BOM and duplicate-key rejection. */
export function readStrictJson(bytes: Uint8Array): ReadOutcome<JsonValue> {
	const text = decodeUtf8Strict(bytes);
	if (text === null) return unparseable("not valid UTF-8 (decoded fatally, BOM retained)");

	const scan = scanJsonForDuplicateKeys(text);
	if (!scan.ok) return unparseable(scan.detail);

	let parsed: JsonValue;
	try {
		parsed = JSON.parse(text) as JsonValue;
	} catch (error) {
		// Reachable only if the scanner and `JSON.parse` disagree about the
		// grammar. Fail closed and say so rather than presenting a document
		// neither of them fully vouched for.
		return unparseable(`JSON parse failed: ${(error as Error).message}`);
	}
	return { ok: true, value: parsed };
}

/**
 * The receipt document. `bytes` are the authority in every mode: in
 * `--envelope` mode the caller decodes `receiptBytes` with
 * `decodeCanonicalBase64` and passes the RESULT here, never the envelope's
 * parsed `receipt` copy (verify-page §4.1).
 */
export function readReceiptDocument(bytes: Uint8Array): ReadOutcome<JsonObject> {
	const parsed = readStrictJson(bytes);
	if (!parsed.ok) return parsed;
	if (!isJsonObject(parsed.value)) {
		return schemaRefusal("the receipt document is not a JSON object");
	}
	const document = parsed.value;

	const badNumber = findNonFrozenNumber(document);
	if (badNumber !== null) {
		const where = badNumber.path === "" ? "the document root" : badNumber.path;
		return schemaRefusal(`${describeNumberViolation(badNumber.value)} at ${where}`);
	}

	const unknown = findUnknownReceiptField(document);
	if (unknown !== null) return schemaRefusal(`unknown field ${unknown} in the signed receipt`);

	return { ok: true, value: document };
}

// ─────────────────────────────────────────────────────────────────────────────
// The §8 trust snapshot (CLI spec §4).
//
// v1 does NOT verify the snapshot's signature — §8 leaves the scheme open — so
// the structural rules below are the ONLY remaining defense, and every
// violation is UNVERIFIABLE rather than a pass (§8: "Ambiguity → UNVERIFIABLE").
//
// Unknown MEMBERS are tolerated, and not as laxity: the signing scheme is a
// live ship-gate item that will add members, and a v1 strict reader would brick
// every pinned CLI the day it lands. What is bound instead is everything a
// later step actually consumes — a snapshot missing `checkpointRootKeyId` is
// ambiguity, not forward compatibility.
// ─────────────────────────────────────────────────────────────────────────────

export type TrustKeyRole = "mint" | "checkpoint";
export type TrustKeyState = "active" | "retired" | "revoked";

export interface TrustKey {
	readonly keyId: string;
	readonly alg: string;
	readonly role: TrustKeyRole;
	readonly state: TrustKeyState;
	readonly minterKind?: string;
	readonly predecessorKeyId?: string;
	/** §8's offline retirement boundary. Present iff `state === "retired"`. */
	readonly activationSequence?: number;
	readonly publicKey: KeyObject;
	/** `sha256:…` over the SPKI DER — the identity used to spot shared material. */
	readonly materialId: string;
}

export interface TrustChain {
	readonly vaultId: string;
	readonly profile: string;
	readonly genesisSegmentId: string;
	readonly genesisChoice?: "backfill" | "newVault";
	readonly headSegmentId?: string;
	readonly headSegmentFirstSequence?: number;
	readonly mintActor: JsonValue;
	readonly checkpointRootKeyId: string;
	readonly mintKeyIds: readonly string[];
	/** Every key in the rotation lineage `checkpointRootKeyId` pins (§8). */
	readonly checkpointLineage: ReadonlySet<string>;
}

export interface TrustSnapshotIdentity {
	/** `sha256(file bytes)` — R-OUT-1: the report ALWAYS names the snapshot. */
	readonly sha256: string;
	readonly version: string | null;
	readonly predecessor: string | null;
}

export interface TrustSnapshot {
	readonly identity: TrustSnapshotIdentity;
	readonly keys: ReadonlyMap<string, TrustKey>;
	readonly chains: ReadonlyMap<string, TrustChain>;
}

export type TrustSnapshotLoad =
	| { readonly ok: true; readonly sha256: string; readonly snapshot: TrustSnapshot }
	| { readonly ok: false; readonly sha256: string; readonly detail: string };

const TRUST_ROLES = new Set(["mint", "checkpoint"]);
const TRUST_STATES = new Set(["active", "retired", "revoked"]);
const GENESIS_CHOICES = new Set(["backfill", "newVault"]);

function nonEmptyString(value: JsonValue | undefined): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function safeNonNegativeInteger(value: JsonValue | undefined): number | null {
	if (typeof value !== "number") return null;
	if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) return null;
	return value;
}

/**
 * §4's last structural rule. Encoding follows the in-repo convention
 * `anchor-verify.ts` already implements — PEM, or base64 SPKI DER — and the
 * parser is REUSED rather than reinvented. Canonical base64 is validated before
 * the reused helper sees the string, because `Buffer.from(x, "base64")` accepts
 * junk that decodes to the same bytes.
 */
function parseTrustPublicKey(encoded: string): KeyObject | null {
	if (encoded.startsWith("-----BEGIN ")) return publicKeyFromPem(encoded);
	if (!isCanonicalBase64(encoded)) return null;
	return publicKeyFromSpkiBase64(encoded);
}

function materialIdOf(key: KeyObject): string {
	const der = key.export({ type: "spki", format: "der" }) as Buffer;
	return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function loadTrustSnapshot(bytes: Uint8Array): TrustSnapshotLoad {
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const fail = (detail: string): TrustSnapshotLoad => ({ ok: false, sha256, detail });

	const parsed = readStrictJson(bytes);
	if (!parsed.ok) return fail(parsed.refusal.detail);
	if (!isJsonObject(parsed.value)) return fail("the trust snapshot is not a JSON object");
	const document = parsed.value;

	const rawKeys = document.keys;
	const rawChains = document.chains;
	if (!Array.isArray(rawKeys)) return fail("`keys` is missing or not an array");
	if (!Array.isArray(rawChains)) return fail("`chains` is missing or not an array");

	// ── keys[] ────────────────────────────────────────────────────────────────
	const keys = new Map<string, TrustKey>();
	for (let i = 0; i < rawKeys.length; i += 1) {
		const entry = rawKeys[i];
		if (!isJsonObject(entry)) return fail(`keys[${i}] is not an object`);

		const keyId = nonEmptyString(entry.keyId);
		if (keyId === null) return fail(`keys[${i}] has no keyId`);
		// §8: keyIds are globally unique, never reused, retained forever. A
		// duplicate otherwise resolves by insertion order, which silently decides
		// between an `active` and a `revoked` entry for the same key.
		if (keys.has(keyId)) return fail(`duplicate keyId ${JSON.stringify(keyId)}`);

		const alg = nonEmptyString(entry.alg);
		if (alg === null) return fail(`key ${keyId} has no alg`);

		const role = entry.role;
		if (typeof role !== "string" || !TRUST_ROLES.has(role)) {
			return fail(`key ${keyId} has an unrecognized role`);
		}
		const state = entry.state;
		if (typeof state !== "string" || !TRUST_STATES.has(state)) {
			return fail(`key ${keyId} has an unrecognized state`);
		}

		const encoded = nonEmptyString(entry.publicKey);
		if (encoded === null) return fail(`key ${keyId} has no publicKey`);
		const publicKey = parseTrustPublicKey(encoded);
		if (publicKey === null) return fail(`key ${keyId} has a publicKey that does not parse`);

		if (entry.minterKind !== undefined && typeof entry.minterKind !== "string") {
			return fail(`key ${keyId} has a non-string minterKind`);
		}
		if (entry.predecessorKeyId !== undefined && nonEmptyString(entry.predecessorKeyId) === null) {
			return fail(`key ${keyId} has an invalid predecessorKeyId`);
		}

		// §4: `activationSequence` inconsistent with `state`. Present on an
		// `active` key claims a boundary a key with no successor cannot have;
		// absent on a `retired` key removes the comparison §8 makes the deciding
		// one for retired material.
		let activationSequence: number | undefined;
		if (entry.activationSequence !== undefined) {
			const value = safeNonNegativeInteger(entry.activationSequence);
			if (value === null) return fail(`key ${keyId} has an invalid activationSequence`);
			activationSequence = value;
		}
		if (state === "active" && activationSequence !== undefined) {
			return fail(`active key ${keyId} carries an activationSequence`);
		}
		if (state === "retired" && activationSequence === undefined) {
			return fail(`retired key ${keyId} has no activationSequence`);
		}

		keys.set(keyId, {
			keyId,
			alg,
			role: role as TrustKeyRole,
			state: state as TrustKeyState,
			...(typeof entry.minterKind === "string" ? { minterKind: entry.minterKind } : {}),
			...(typeof entry.predecessorKeyId === "string"
				? { predecessorKeyId: entry.predecessorKeyId }
				: {}),
			...(activationSequence === undefined ? {} : { activationSequence }),
			publicKey,
			materialId: materialIdOf(publicKey),
		});
	}

	const lineageFailure = validateLineages(keys);
	if (lineageFailure !== null) return fail(lineageFailure);

	// §8's role separation: mint and checkpoint entries sharing key material
	// collapse the very separation the two signatures rely on.
	const materialRoles = new Map<string, TrustKeyRole>();
	for (const key of keys.values()) {
		const seen = materialRoles.get(key.materialId);
		if (seen !== undefined && seen !== key.role) {
			return fail(`key ${key.keyId} shares key material across the mint/checkpoint roles`);
		}
		materialRoles.set(key.materialId, key.role);
	}

	// ── chains[] ──────────────────────────────────────────────────────────────
	const chains = new Map<string, TrustChain>();
	const lineageOwner = new Map<string, string>();
	for (let i = 0; i < rawChains.length; i += 1) {
		const entry = rawChains[i];
		if (!isJsonObject(entry)) return fail(`chains[${i}] is not an object`);

		const vaultId = nonEmptyString(entry.vaultId);
		if (vaultId === null) return fail(`chains[${i}] has no vaultId`);
		if (chains.has(vaultId)) return fail(`duplicate vaultId ${JSON.stringify(vaultId)}`);

		const profile = nonEmptyString(entry.profile);
		if (profile === null) return fail(`chain ${vaultId} has no profile`);
		const genesisSegmentId = nonEmptyString(entry.genesisSegmentId);
		if (genesisSegmentId === null) return fail(`chain ${vaultId} has no genesisSegmentId`);
		if (entry.mintActor === undefined) return fail(`chain ${vaultId} has no mintActor`);

		const checkpointRootKeyId = nonEmptyString(entry.checkpointRootKeyId);
		if (checkpointRootKeyId === null) return fail(`chain ${vaultId} has no checkpointRootKeyId`);
		const rootKey = keys.get(checkpointRootKeyId);
		if (rootKey === undefined) {
			return fail(
				`chain ${vaultId} pins checkpointRootKeyId ${checkpointRootKeyId}, not in keys[]`,
			);
		}
		if (rootKey.role !== "checkpoint") {
			return fail(`chain ${vaultId} pins ${checkpointRootKeyId}, whose role is ${rootKey.role}`);
		}

		const rawMintKeyIds = entry.mintKeyIds;
		if (!Array.isArray(rawMintKeyIds)) return fail(`chain ${vaultId} has no mintKeyIds array`);
		const mintKeyIds: string[] = [];
		for (const candidate of rawMintKeyIds) {
			const mintKeyId = nonEmptyString(candidate);
			if (mintKeyId === null) return fail(`chain ${vaultId} has a non-string mintKeyIds entry`);
			// An entry that does not RESOLVE is not a structural defect: §7's
			// unresolvable-key case is UNVERIFIABLE with `missing: trustKey`, and
			// resolution belongs to the step that needs the key. What is structural
			// is a resolved entry whose registered role contradicts the list it
			// appears in (§8's role separation).
			const mintKey = keys.get(mintKeyId);
			if (mintKey !== undefined && mintKey.role !== "mint") {
				return fail(
					`chain ${vaultId} lists ${mintKeyId} as a mint key, but its role is ${mintKey.role}`,
				);
			}
			mintKeyIds.push(mintKeyId);
		}

		let genesisChoice: "backfill" | "newVault" | undefined;
		if (entry.genesisChoice !== undefined) {
			if (typeof entry.genesisChoice !== "string" || !GENESIS_CHOICES.has(entry.genesisChoice)) {
				return fail(`chain ${vaultId} has an unrecognized genesisChoice`);
			}
			genesisChoice = entry.genesisChoice as "backfill" | "newVault";
		}
		let headSegmentFirstSequence: number | undefined;
		if (entry.headSegmentFirstSequence !== undefined) {
			const value = safeNonNegativeInteger(entry.headSegmentFirstSequence);
			if (value === null) return fail(`chain ${vaultId} has an invalid headSegmentFirstSequence`);
			headSegmentFirstSequence = value;
		}
		if (entry.headSegmentId !== undefined && nonEmptyString(entry.headSegmentId) === null) {
			return fail(`chain ${vaultId} has an invalid headSegmentId`);
		}

		// §8's one-lineage-one-vault rule: a lineage trusted by two vaults could
		// sign statements attributable to either, and `proof.chain` — receipt-
		// signed only — could not settle which.
		const checkpointLineage = lineageOf(keys, checkpointRootKeyId);
		for (const member of checkpointLineage) {
			const owner = lineageOwner.get(member);
			if (owner !== undefined) {
				return fail(
					`checkpoint lineage member ${member} is pinned by both ${owner} and ${vaultId}`,
				);
			}
			lineageOwner.set(member, vaultId);
		}

		chains.set(vaultId, {
			vaultId,
			profile,
			genesisSegmentId,
			...(genesisChoice === undefined ? {} : { genesisChoice }),
			...(typeof entry.headSegmentId === "string" ? { headSegmentId: entry.headSegmentId } : {}),
			...(headSegmentFirstSequence === undefined ? {} : { headSegmentFirstSequence }),
			mintActor: entry.mintActor,
			checkpointRootKeyId,
			mintKeyIds,
			checkpointLineage,
		});
	}

	return {
		ok: true,
		sha256,
		snapshot: {
			identity: {
				sha256,
				version: typeof document.version === "string" ? document.version : null,
				// §8 records only that "each snapshot embeds the hash of its
				// predecessor"; the member's NAME lands with the signing scheme, so
				// both spellings are read and neither is required.
				predecessor:
					typeof document.predecessorHash === "string"
						? document.predecessorHash
						: typeof document.predecessor === "string"
							? document.predecessor
							: null,
			},
			keys,
			chains,
		},
	};
}

/**
 * §8's rotation rules, checked once over the whole key set:
 * every `predecessorKeyId` resolves, stays WITHIN one role, is declared at most
 * once, and the walk terminates. An undeclared cycle is a non-terminating walk
 * at step 6, so it is a structural failure rather than something to guard
 * against at use time.
 */
function validateLineages(keys: ReadonlyMap<string, TrustKey>): string | null {
	const successorOf = new Map<string, string>();
	for (const key of keys.values()) {
		const predecessorKeyId = key.predecessorKeyId;
		if (predecessorKeyId === undefined) continue;

		const predecessor = keys.get(predecessorKeyId);
		if (predecessor === undefined) {
			return `key ${key.keyId} names predecessor ${predecessorKeyId}, absent from the snapshot`;
		}
		if (predecessor.role !== key.role) {
			return `key ${key.keyId} (${key.role}) names a ${predecessor.role} predecessor — a lineage is a walk within one role`;
		}
		const existing = successorOf.get(predecessorKeyId);
		if (existing !== undefined) {
			return `rotation link from ${predecessorKeyId} is declared twice (${existing}, ${key.keyId})`;
		}
		successorOf.set(predecessorKeyId, key.keyId);
	}

	for (const start of keys.keys()) {
		const visited = new Set<string>([start]);
		let cursor = keys.get(start)?.predecessorKeyId;
		while (cursor !== undefined) {
			if (visited.has(cursor)) return `rotation lineage through ${cursor} is cyclic`;
			visited.add(cursor);
			cursor = keys.get(cursor)?.predecessorKeyId;
		}
	}
	return null;
}

/**
 * The rotation lineage a pinned member pins (§8: "`checkpointRootKeyId` pins any
 * member; pinning a member pins its lineage"). Walked in BOTH directions —
 * pinning the newest key must confer the same lineage as pinning the oldest, or
 * a rotation would silently change which checkpoints a chain accepts.
 *
 * Safe to walk unguarded only because `validateLineages` has already rejected
 * cycles and forked links; it is called after that, never before.
 */
function lineageOf(keys: ReadonlyMap<string, TrustKey>, pinned: string): ReadonlySet<string> {
	const lineage = new Set<string>();
	let cursor: string | undefined = pinned;
	while (cursor !== undefined && !lineage.has(cursor)) {
		lineage.add(cursor);
		cursor = keys.get(cursor)?.predecessorKeyId;
	}
	for (;;) {
		let grew = false;
		for (const key of keys.values()) {
			if (key.predecessorKeyId !== undefined && lineage.has(key.predecessorKeyId)) {
				if (!lineage.has(key.keyId)) {
					lineage.add(key.keyId);
					grew = true;
				}
			}
		}
		if (!grew) break;
	}
	return lineage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Literals the ut1 profile pins (receipt-spec §4a, §5, §8, §14).
//
// Named constants rather than inline strings because each one is a FORMAT
// BREAK if it moves: §14 is explicit that renaming across the snake_case /
// camelCase boundary is never a cleanup.
// ─────────────────────────────────────────────────────────────────────────────

export const RECEIPT_SIGNATURE_PREFIX = "usertrust/receipt-signature/v1\n";
export const TRANSFER_SET_PREFIX = "usertrust/receipt-transfers/v1\n";
export const UT1_PROFILE = "proxy-v1";
export const UT1_MINT_EVENT_KIND = "receipt_settled";
export const UT1_TRUST_DOMAIN = "usertrust.ai";
export const UT1_SPEC = "ut1";
export const UT1_SCOPE = "session";

// ─────────────────────────────────────────────────────────────────────────────
// §12 — the receipt-ID rule.
//
// "The character-count rule is NOT the ID rule." §12 requires a canonical
// DECODE to exactly 16 bytes and a byte-identical RE-ENCODE; the `16*22`
// character grammar is necessary and nowhere near sufficient, because many
// strings of that length decode short and some decode long.
// ─────────────────────────────────────────────────────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RECEIPT_ID_PREFIX = "ut1_";
const RECEIPT_ID_BYTES = 16;

function base58Decode(text: string): Uint8Array | null {
	let zeros = 0;
	while (zeros < text.length && text[zeros] === "1") zeros += 1;
	const bytes: number[] = [];
	for (let i = zeros; i < text.length; i += 1) {
		const value = BASE58_ALPHABET.indexOf(text[i] as string);
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

function base58Encode(bytes: Uint8Array): string {
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
	for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58_ALPHABET[digits[i] as number];
	return out;
}

/** §12's two rules, applied after the `16*22base58char` grammar. */
export function isCanonicalReceiptId(id: string): boolean {
	if (!id.startsWith(RECEIPT_ID_PREFIX)) return false;
	const body = id.slice(RECEIPT_ID_PREFIX.length);
	if (body.length < 16 || body.length > 22) return false;
	const decoded = base58Decode(body);
	if (decoded === null || decoded.length !== RECEIPT_ID_BYTES) return false;
	return base58Encode(decoded) === body;
}

const TRAILER_PREFIX = "Usertrust-Receipt: ";
const RESOLUTION_URL_PREFIX = "https://usertrust.ai/r/";

/**
 * The ID a receipt ARRIVED under, extracted from `--expect-id` (CLI spec §2).
 *
 * §12's lexical rules are enforced rather than paraphrased: the key is
 * case-SENSITIVE, followed by exactly one `:` and exactly one space, the value
 * runs to end-of-line, and there is no folding, no trailing whitespace and no
 * inline comment. A URL that merely APPEARS inside prose is not a trailer, so
 * this never searches — it matches from the start of the (single) line.
 *
 * `null` means the context is not a §12 form. That is a USAGE error for the
 * caller to report (exit 3), never a silent `notApplicable`: an unparseable
 * `--expect-id` that quietly disabled step 3(a) would answer a question the
 * operator did not ask.
 */
export function receiptIdFromArrivalContext(context: string): string | null {
	let text = context;
	// "line endings may be LF or CRLF and the CR is not part of the value".
	if (text.endsWith("\n")) text = text.slice(0, -1);
	if (text.endsWith("\r")) text = text.slice(0, -1);
	if (text.includes("\n") || text.includes("\r")) return null;
	if (text.startsWith(TRAILER_PREFIX)) text = text.slice(TRAILER_PREFIX.length);
	if (text.startsWith(RESOLUTION_URL_PREFIX)) text = text.slice(RESOLUTION_URL_PREFIX.length);
	return isCanonicalReceiptId(text) ? text : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict vocabulary (receipt-spec §7; CLI spec §5, §6).
// ─────────────────────────────────────────────────────────────────────────────

/** §7's eight BASE steps. Step 9 is `extensions`; `envelope` is the CLI's. */
export type BaseStepName =
	| "schema"
	| "event"
	| "registry"
	| "signature"
	| "inclusion"
	| "checkpoint"
	| "semantics"
	| "derivations";

export type StepName = BaseStepName | "extensions" | "envelope";

/** §7's CLOSED failure vocabulary. */
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

/** §7: "Every check reports a structured result, not a boolean." */
export type CheckResultValue = "passed" | "failed" | "notApplicable" | "unavailable";

export type MissingWhat = "trustSnapshot" | "receiptBytes" | "proof" | "checkpoint" | "trustKey";

export interface StepOutcome {
	readonly result: CheckResultValue;
	readonly failure?: { readonly code: FailureCode; readonly detail: string };
}

/** R39's machine-readable labels. The amount is never rendered without them. */
export interface PostureLabels {
	readonly delegation: string;
	readonly usage: string;
	readonly pricing: string;
}

/**
 * What step 9 needs and cannot re-derive. Present ONLY on a base pass: an
 * extension may upgrade a verdict, never rescue one, so handing this out after
 * a failure would be handing out an invitation to try.
 */
export interface VerifiedMaterial {
	readonly document: JsonObject;
	readonly chain: TrustChain;
	readonly checkpoint: JsonObject;
}

export interface BaseVerdictReport {
	readonly verdict: "VERIFIED_CHECKPOINT" | "FAILED" | "UNVERIFIABLE";
	readonly receiptId: string | null;
	readonly steps: Readonly<Record<BaseStepName, StepOutcome>>;
	/** §7's named online checks. Both are `notApplicable` offline, by rule. */
	readonly checks: {
		readonly registryBinding: StepOutcome;
		readonly predecessorLinkage: StepOutcome;
	};
	readonly arrivalContext: {
		readonly result: CheckResultValue;
		readonly expected: string | null;
	};
	readonly computed: { readonly amountUsd: string | null };
	readonly posture: PostureLabels | null;
	readonly failure: {
		readonly step: StepName;
		readonly code: FailureCode;
		readonly detail: string;
	} | null;
	readonly missing: { readonly what: MissingWhat; readonly detail: string } | null;
	readonly verified: VerifiedMaterial | null;
}

export interface ReceiptVerifyInput {
	/** The BYTES are the artifact. In `--envelope` mode these are the decoded
	 * `receiptBytes`, never the envelope's parsed `receipt` copy. */
	readonly receiptBytes: Uint8Array;
	readonly snapshot: TrustSnapshot;
	/** The §12-validated ID the document arrived under. Omitted ⇒ 3(a) is n/a. */
	readonly arrivalId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §2 — `amountUsd`, computed on an integer path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `assessedUsertokens / 10000` by integer quotient/remainder, four decimals.
 *
 * §2 says "no float", and it is not a style rule: `999999999999999 / 10000`
 * is 99999999999.99991 as a double and `.toFixed(4)` reads it back as
 * 100000000000.0000 — a cent-scale overstatement at the top of the safe-integer
 * range, in the one number the whole document exists to report. `%` and the
 * subtraction below are exact on safe integers.
 */
export function amountUsdFromAssessed(assessed: number): string {
	const remainder = assessed % 10000;
	const whole = (assessed - remainder) / 10000;
	return `${whole}.${String(remainder).padStart(4, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step resolutions.
// ─────────────────────────────────────────────────────────────────────────────

type Resolution =
	| { readonly kind: "passed" }
	| { readonly kind: "notApplicable" }
	| { readonly kind: "failed"; readonly code: FailureCode; readonly detail: string }
	| { readonly kind: "missing"; readonly what: MissingWhat; readonly detail: string };

const PASSED: Resolution = { kind: "passed" };
const NOT_APPLICABLE: Resolution = { kind: "notApplicable" };
const NOT_APPLICABLE_OUTCOME: StepOutcome = { result: "notApplicable" };

function failure(code: FailureCode, detail: string): Resolution {
	return { kind: "failed", code, detail };
}

function missingMaterial(what: MissingWhat, detail: string): Resolution {
	return { kind: "missing", what, detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed reads. Every one of these returns `null` rather than throwing: the
// document is untrusted, and the step that needed the value reports its own
// code for the absence.
// ─────────────────────────────────────────────────────────────────────────────

function stringAt(object: JsonObject, key: string): string | null {
	const value = object[key];
	return typeof value === "string" ? value : null;
}

function numberAt(object: JsonObject, key: string): number | null {
	const value = object[key];
	// The frozen reader has already rejected every non-safe-integer, so a number
	// reaching here is one; the guard is belt, and it keeps this usable on the
	// snapshot path too.
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function objectAtKey(object: JsonObject, key: string): JsonObject | undefined {
	const value = object[key];
	return isJsonObject(value) ? value : undefined;
}

function arrayAt(object: JsonObject, key: string): JsonValue[] | null {
	const value = object[key];
	return Array.isArray(value) ? value : null;
}

const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/;
const LOWERCASE_HEX_32 = /^[0-9a-f]{32}$/;
const OPAQUE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Canonical base64 FIRST, then the reused Ed25519 helper (CLI spec §4). */
function verifyEd25519(preimage: string, key: KeyObject, sigBase64: string): boolean {
	if (!isCanonicalBase64(sigBase64)) return false;
	return verifySignatureRaw("ed25519", preimage, key, sigBase64);
}

/** `canonicalize(x − key)` with key-ABSENT exclusion, never an undefined value. */
function canonicalizeWithout(object: JsonObject, key: string): string {
	const { [key]: _dropped, ...rest } = object;
	return canonicalize(rest);
}

// ─────────────────────────────────────────────────────────────────────────────
// The key-state rule (§8), shared by steps 4 and 6.
//
// One function for both because §8 states one rule: "MINT keys have no
// segment-indexed material of their own; their retirement boundary is the mint
// event's segment, evaluated the same way through the receipt's checkpoint."
// Two copies would be two chances to implement `state permitting` as a state
// check alone — which is precisely the defect that accepts a freshly-signed
// receipt from a retired key.
// ─────────────────────────────────────────────────────────────────────────────

function keyStatePermits(key: TrustKey, segmentFirstSequence: number): string | null {
	if (key.state === "revoked") {
		return `key ${key.keyId} is revoked — a revoked key verifies nothing, past or present`;
	}
	if (key.state === "retired") {
		// The loader has already refused a `retired` key with no
		// `activationSequence`, so an unevaluable boundary never reaches here.
		const boundary = key.activationSequence;
		if (boundary === undefined || !(segmentFirstSequence < boundary)) {
			return `retired key ${key.keyId} signed material at segmentFirstSequence ${segmentFirstSequence}, at or after its successor's activation (${String(boundary)})`;
		}
	}
	return null;
}

/**
 * §7 step 6, factored out because step 9's history walk applies it to EVERY
 * checkpoint it is handed and must reach the same answer for each.
 *
 * `missingTrustKey` is not the same outcome as a failure and the caller must
 * keep them apart: an unresolvable `checkpoint.keyId` is missing material
 * (UNVERIFIABLE), while a resolved key whose state forbids is a real negative
 * answer (FAILED).
 */
export type CheckpointOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly missingTrustKey: boolean; readonly detail: string };

export function verifyCheckpointStatement(
	checkpoint: JsonObject,
	chain: TrustChain,
	snapshot: TrustSnapshot,
): CheckpointOutcome {
	const reject = (detail: string): CheckpointOutcome => ({
		ok: false,
		missingTrustKey: false,
		detail,
	});

	// §7 step 6, first clause: a v1 `PublishedMerkleRoot` in a receipt is FAIL.
	// Its root-only signature leaves `treeSize` and the lineage edge
	// unauthenticated, which is exactly what v2 exists to close.
	if (checkpoint.v !== 2) {
		return reject(`checkpoint.v is ${JSON.stringify(checkpoint.v)}, not the v2 statement`);
	}
	const keyId = stringAt(checkpoint, "keyId");
	if (keyId === null) return reject("checkpoint carries no keyId");
	const segmentFirstSequence = numberAt(checkpoint, "segmentFirstSequence");
	if (segmentFirstSequence === null) return reject("checkpoint carries no segmentFirstSequence");
	const sig = stringAt(checkpoint, "sig");
	if (sig === null) return reject("checkpoint carries no sig");

	const key = snapshot.keys.get(keyId);
	if (key === undefined) {
		return {
			ok: false,
			missingTrustKey: true,
			detail: `checkpoint key ${keyId} is not in the pinned snapshot`,
		};
	}
	if (key.role !== "checkpoint") {
		return reject(`checkpoint key ${keyId} is registered with role ${key.role}`);
	}
	// Per-chain authority (R3-2): a domain-wide checkpoint key confers NO
	// authority over a chain whose `checkpointRootKeyId` pins another lineage.
	if (!chain.checkpointLineage.has(keyId)) {
		return reject(
			`checkpoint key ${keyId} is outside the lineage pinned by ${chain.checkpointRootKeyId}`,
		);
	}
	const stateFailure = keyStatePermits(key, segmentFirstSequence);
	if (stateFailure !== null) return reject(stateFailure);

	// §4a: the checkpoint preimage is `canonicalize(unsigned)` with NO domain
	// prefix. The asymmetry with the receipt signature is intentional and must
	// not be "fixed" — adding a prefix here rejects every real checkpoint.
	if (!verifyEd25519(canonicalizeWithout(checkpoint, "sig"), key.publicKey, sig)) {
		return reject(`checkpoint signature does not verify under key ${keyId}`);
	}
	return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 7 — §2's EXHAUSTIVE semantic constraints.
//
// "Exhaustive" is load-bearing in both directions: a constraint §2 does not
// list is not step 7's to invent (over-rejection fails honest receipts), and
// every constraint it does list is decidable from the receipt alone.
// ─────────────────────────────────────────────────────────────────────────────

const USAGE_POSTURES = new Set(["provider", "mixed", "estimated"]);
const PRICING_POSTURES = new Set(["exact", "conservative"]);
const SESSION_ASSOCIATIONS = new Set(["workflowAttested", "ownerAsserted"]);
/** §2a's four values — the VERIFIER's vocabulary, wider than v1 minting's. */
const DELEGATION_POSTURES = new Set([
	"selfDebitsOnly",
	"includesSomeDelegated",
	"includesAllDelegated",
	"indeterminate",
]);
const WORK_KINDS = new Set(["commit", "pr", "issue", "session"]);

/** Sorted-unique, ASCII-lexicographic — one helper, three fields (§2). */
function sortedUniqueStrings(value: JsonValue | undefined, field: string): string | null {
	if (!Array.isArray(value)) return `${field} is missing or not an array`;
	let previous: string | null = null;
	for (const entry of value) {
		if (typeof entry !== "string") return `${field} carries a non-string entry`;
		if (previous !== null && !(previous < entry)) {
			return `${field} is not sorted-unique ASCII-lexicographic at ${JSON.stringify(entry)}`;
		}
		previous = entry;
	}
	return null;
}

function checkWorkVariant(work: JsonObject): string | null {
	const kind = stringAt(work, "kind");
	if (kind === null || !WORK_KINDS.has(kind)) {
		return `work.kind ${JSON.stringify(work.kind)} matches no §2 union variant`;
	}
	if (stringAt(work, "repoId") === null)
		return "work.repoId is missing — it is the NORMATIVE scope";
	const repo = work.repo;
	if (repo !== undefined) {
		// Public safety: `repo` is the canonical provider-URL form, ≤ 256 chars.
		if (typeof repo !== "string" || repo.length > 256) {
			return "work.repo is not a ≤256-character canonical provider URL";
		}
	}

	if (kind === "session") {
		// The two session variants MUST NOT overlap: `origin` present ⇒ fallback.
		const origin = work.origin;
		if (origin !== undefined) {
			if (!isJsonObject(origin)) return "work.origin is not an object";
			if (origin.kind !== "billedUnfinalized") {
				return "work.origin.kind is not the fallback discriminator billedUnfinalized";
			}
			if (stringAt(origin, "sourceReservationReceiptId") === null) {
				return "the fallback session variant requires sourceReservationReceiptId";
			}
		}
		// §2: a session receipt claims NO artifact membership, so
		// `repositoryMembership` is exempt — and present-anyway is an unknown
		// field, already refused by step 1.
		return null;
	}

	// v1 FAILS CLOSED on membership: `unverified` is not a ut1 value.
	const membership = objectAtKey(work, "repositoryMembership");
	if (membership === undefined) return `work.repositoryMembership is REQUIRED on kind ${kind}`;
	if (membership.status !== "providerVerified") {
		return "repositoryMembership.status is not providerVerified — v1 has no other value";
	}
	const proofId = stringAt(membership, "proofId");
	if (proofId === null || !OPAQUE_ID.test(proofId)) {
		return "repositoryMembership.proofId is not an opaque [A-Za-z0-9._-]{1,128} handle";
	}

	if (kind === "commit") {
		if (stringAt(work, "oid") === null) return "work.oid is missing";
		const oidAlg = stringAt(work, "oidAlg");
		if (oidAlg !== "sha1" && oidAlg !== "sha256") return "work.oidAlg is not sha1 or sha256";
		if (stringAt(work, "objectSha256") === null) return "work.objectSha256 is missing";
		return null;
	}

	// pr / issue.
	if (numberAt(work, "number") === null) return `work.number is missing on kind ${kind}`;
	if (stringAt(work, "providerArtifactId") === null) return "work.providerArtifactId is missing";
	if (stringAt(work, "observedRevision") === null) return "work.observedRevision is missing";
	const binding = objectAtKey(work, "contentBinding");
	if (binding === undefined) return "work.contentBinding is missing";
	if (binding.kind === "publicSha256") {
		return stringAt(binding, "sha256") === null ? "contentBinding.sha256 is missing" : null;
	}
	if (binding.kind === "privateHmacSha256V1") {
		return stringAt(binding, "commitment") === null ? "contentBinding.commitment is missing" : null;
	}
	return "contentBinding matches neither arm of §2's EXACTLY-ONE union";
}

function checkTransferSet(projection: JsonObject, transferCount: number): string | null {
	const present = projection.transferSet !== undefined;
	// §2: "transferSet presence is a RULE, not an option."
	if (transferCount > 32) {
		return present ? "transferSet is present on a >32-pair receipt" : null;
	}
	if (!present) return "transferSet is absent on a ≤32-pair receipt";

	const list = arrayAt(projection, "transferSet");
	if (list === null) return "transferSet is not an array";
	if (list.length !== transferCount) {
		return `transferSet carries ${list.length} pairs against transferCount ${transferCount}`;
	}
	// §2 states two rules — no repeated transfer ID "in either position", and no
	// repeated pair. The first SUBSUMES the second (a repeated pair repeats both
	// of its IDs), so one set decides both and there is no second, unreachable
	// branch pretending otherwise.
	const seenIds = new Set<string>();
	for (const entry of list) {
		if (!isJsonObject(entry)) return "a transferSet member is not an object";
		const authorization = stringAt(entry, "authorizationTransferId");
		const settlement = stringAt(entry, "settlementTransferId");
		if (authorization === null || settlement === null) {
			return "a transferSet member is not the {authorization, settlement} ID pair";
		}
		for (const id of [authorization, settlement]) {
			if (!LOWERCASE_HEX_32.test(id)) {
				return `transfer ID ${JSON.stringify(id)} is not a canonical 128-bit lowercase-hex ID`;
			}
			// "no transfer ID repeats anywhere in the list, in EITHER position".
			if (seenIds.has(id)) return `transfer ID ${id} repeats in the list`;
			seenIds.add(id);
		}
	}
	return null;
}

function checkSemantics(projection: JsonObject): string | null {
	// The projection's own literals. Step 2's equality 7 already proved the two
	// copies AGREE, so this is the check that both are ut1's — and it is
	// unreachable-but-correct: a disagreement is caught earlier, and a matching
	// pair of illegal literals is caught by step 1 on the receipt's side.
	if (projection.spec !== UT1_SPEC) return `projection spec is not ${UT1_SPEC}`;
	if (projection.scope !== UT1_SCOPE) return `projection scope is not ${UT1_SCOPE}`;
	if (stringAt(projection, "sessionId") === null) return "sessionId is missing";
	if (stringAt(projection, "startedAt") === null) return "startedAt is missing";
	if (stringAt(projection, "endedAt") === null) return "endedAt is missing";

	const generation = numberAt(projection, "generation");
	if (generation === null || generation < 1) return "generation is not an integer ≥ 1";
	const previousGeneration = projection.prevGenerationEventHash;
	if (generation > 1) {
		if (typeof previousGeneration !== "string" || !LOWERCASE_HEX_64.test(previousGeneration)) {
			return "generation > 1 requires a 64-lowercase-hex prevGenerationEventHash";
		}
	} else if (previousGeneration !== undefined) {
		return "prevGenerationEventHash is present at generation 1";
	}

	const association = stringAt(projection, "sessionAssociation");
	if (association === null || !SESSION_ASSOCIATIONS.has(association)) {
		return "sessionAssociation is missing or not a §6a posture";
	}
	const workloadId = projection.workloadId;
	if (association === "workflowAttested") {
		if (typeof workloadId !== "string" || !OPAQUE_ID.test(workloadId)) {
			// The posture can never claim attestation without naming what was
			// attested — present-without-attested and attested-without-present are
			// BOTH failures, and this is the second half.
			return "workflowAttested requires an opaque workloadId";
		}
	} else if (workloadId !== undefined) {
		return "workloadId is present on an ownerAsserted receipt";
	}

	const work = objectAtKey(projection, "work");
	if (work === undefined) return "work is missing from the projection";
	const workFailure = checkWorkVariant(work);
	if (workFailure !== null) return workFailure;

	for (const [field, value] of [
		["models", projection.models],
		["providers", projection.providers],
	] as const) {
		const sortFailure = sortedUniqueStrings(value, field);
		if (sortFailure !== null) return sortFailure;
	}
	const pricing = objectAtKey(projection, "pricing");
	if (pricing === undefined) return "pricing is missing";
	const versionFailure = sortedUniqueStrings(pricing.tableVersions, "pricing.tableVersions");
	if (versionFailure !== null) return versionFailure;

	const spend = objectAtKey(projection, "spend");
	if (spend === undefined) return "spend is missing";
	const assessed = numberAt(spend, "assessedUsertokens");
	const posted = numberAt(spend, "postedUsertokens");
	const rounding = numberAt(spend, "roundingAdjustment");
	const transferCount = numberAt(spend, "transferCount");
	if (assessed === null || posted === null || rounding === null || transferCount === null) {
		return "spend is missing one of its integer members";
	}
	// P1-4: ut1 has no shortfall branch. A receipt with posted < assessed would
	// need a negative roundingAdjustment to satisfy §2's own recompute equation,
	// which the bound below forbids.
	if (!(posted > 0) || posted !== assessed) {
		return `0 < postedUsertokens === assessedUsertokens fails (${posted} vs ${assessed})`;
	}
	if (transferCount < 1) return "transferCount is not ≥ 1 — empty sessions are unmintable";
	if (rounding < 0 || rounding > transferCount) {
		return `roundingAdjustment ${rounding} is outside [0, ${transferCount}]`;
	}
	const usagePosture = stringAt(spend, "usagePosture");
	if (usagePosture === null || !USAGE_POSTURES.has(usagePosture)) {
		return "usagePosture is not one of provider | mixed | estimated";
	}
	const pricingPosture = stringAt(spend, "pricingPosture");
	if (pricingPosture === null || !PRICING_POSTURES.has(pricingPosture)) {
		return "pricingPosture is not one of exact | conservative";
	}

	// §2a / §7's REQUIRED verifier behavior. Missing or unrecognized fails
	// closed: a v1 verifier meeting a value a later spec adds must refuse rather
	// than render a total whose coverage it cannot interpret.
	const delegation = stringAt(projection, "delegationPosture");
	if (delegation === null || !DELEGATION_POSTURES.has(delegation)) {
		return `delegationPosture ${JSON.stringify(projection.delegationPosture)} is missing or unrecognized — the amount's coverage cannot be interpreted`;
	}
	if (delegation === "includesAllDelegated") {
		// Pinned in §2a: this posture is a CLAIM THAT MUST BE VERIFIABLE. No
		// signed-evidence format is specified, so in v1 the claim can never be
		// substantiated — and an unsubstantiated claim is a failed step, not a
		// rendered total.
		return "includesAllDelegated carries no validating signed evidence — §2a specifies no evidence format in v1";
	}

	const transferFailure = checkTransferSet(projection, transferCount);
	if (transferFailure !== null) return transferFailure;

	const root = stringAt(projection, "transferSetRoot");
	if (root === null || !LOWERCASE_HEX_64.test(root)) {
		return "transferSetRoot is not 64 lowercase hex characters";
	}
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The base run (receipt-spec §7 steps 1–8).
// ─────────────────────────────────────────────────────────────────────────────

const BASE_STEPS: readonly BaseStepName[] = [
	"schema",
	"event",
	"registry",
	"signature",
	"inclusion",
	"checkpoint",
	"semantics",
	"derivations",
];

/** What step 1 binds once, so no later step re-reads the document by hand. */
interface BoundReceipt {
	readonly document: JsonObject;
	readonly receiptId: string;
	readonly minter: JsonObject;
	readonly signature: JsonObject;
	readonly event: JsonObject;
	readonly projection: JsonObject;
	readonly proof: JsonObject;
	readonly inclusion: JsonObject;
	readonly checkpoint: JsonObject;
}

class BaseRun {
	private readonly results = new Map<BaseStepName, StepOutcome>();
	private receiptId: string | null = null;
	private amountUsd: string | null = null;
	private posture: PostureLabels | null = null;
	private arrival: CheckResultValue = "notApplicable";
	private bound: BoundReceipt | null = null;
	private chain: TrustChain | null = null;

	constructor(private readonly input: ReceiptVerifyInput) {}

	run(): BaseVerdictReport {
		for (const step of BASE_STEPS) {
			const resolution = this.evaluate(step);
			if (resolution.kind === "failed") {
				this.results.set(step, {
					result: "failed",
					failure: { code: resolution.code, detail: resolution.detail },
				});
				return this.report({
					verdict: "FAILED",
					failure: { step, code: resolution.code, detail: resolution.detail },
					missing: null,
				});
			}
			if (resolution.kind === "missing") {
				// Nothing FAILED — the material was not there to judge. §7 reserves
				// UNVERIFIABLE for exactly this, and the exit code (2, not 1) is what
				// makes the distinction operationally load-bearing.
				return this.report({
					verdict: "UNVERIFIABLE",
					failure: null,
					missing: { what: resolution.what, detail: resolution.detail },
				});
			}
			this.results.set(step, {
				result: resolution.kind === "passed" ? "passed" : "notApplicable",
			});
		}
		return this.report({ verdict: "VERIFIED_CHECKPOINT", failure: null, missing: null });
	}

	private evaluate(step: BaseStepName): Resolution {
		switch (step) {
			case "schema":
				return this.stepSchema();
			case "event":
				return this.stepEvent();
			case "registry":
				return this.stepRegistry();
			case "signature":
				return this.stepSignature();
			case "inclusion":
				return this.stepInclusion();
			case "checkpoint":
				return this.stepCheckpoint();
			case "semantics":
				return this.stepSemantics();
			default:
				return this.stepDerivations();
		}
	}

	/** Non-null once step 1 has passed; every later step runs after it. */
	private get receipt(): BoundReceipt {
		return this.bound as BoundReceipt;
	}

	private get boundChain(): TrustChain {
		return this.chain as TrustChain;
	}

	// ── Step 1: strict schema + §12 ID + §5 shape ────────────────────────────
	private stepSchema(): Resolution {
		const read = readReceiptDocument(this.input.receiptBytes);
		if (!read.ok) {
			return read.refusal.kind === "unparseable"
				? missingMaterial("receiptBytes", read.refusal.detail)
				: failure("SCHEMA_INVALID", read.refusal.detail);
		}
		const document = read.value;
		const schema = (detail: string): Resolution => failure("SCHEMA_INVALID", detail);

		if (document.spec !== UT1_SPEC) return schema(`spec is not the literal ${UT1_SPEC}`);
		if (document.scope !== UT1_SCOPE) return schema(`scope is not the literal ${UT1_SCOPE}`);
		const receiptId = stringAt(document, "receiptId");
		if (receiptId === null) return schema("receiptId is missing");
		if (!isCanonicalReceiptId(receiptId)) {
			// §12's rules, not the character count: many grammar-legal strings
			// decode to something other than 16 bytes.
			return schema(`receiptId ${JSON.stringify(receiptId)} is not a canonical §12 ut1 ID`);
		}
		this.receiptId = receiptId;
		if (stringAt(document, "mintedAt") === null) return schema("mintedAt is missing");

		const minter = objectAtKey(document, "minter");
		if (minter === undefined) return schema("minter is missing");
		const minterKeyId = stringAt(minter, "keyId");
		if (minterKeyId === null) return schema("minter.keyId is missing");
		if (stringAt(minter, "kind") === null) return schema("minter.kind is missing");
		if (stringAt(minter, "trustDomain") === null) return schema("minter.trustDomain is missing");

		const signature = objectAtKey(document, "signature");
		if (signature === undefined) return schema("signature is missing");
		if (signature.alg !== "ed25519") return schema("signature.alg is not the literal ed25519");
		const signatureKeyId = stringAt(signature, "keyId");
		if (signatureKeyId === null) return schema("signature.keyId is missing");
		// §5's binding. Two different keyIds would leave the report naming one key
		// while the crypto used another.
		if (signatureKeyId !== minterKeyId) {
			return schema("signature.keyId does not equal minter.keyId");
		}
		const sig = stringAt(signature, "sig");
		if (sig === null) return schema("signature.sig is missing");
		const rawSignature = decodeCanonicalBase64(sig);
		if (rawSignature === null) return schema("signature.sig is not canonical base64");
		if (rawSignature.length !== 64) {
			return schema(`signature.sig is ${rawSignature.length} bytes, not the RFC 8032 64`);
		}

		const event = objectAtKey(document, "event");
		if (event === undefined) return schema("event is missing");
		for (const key of ["id", "timestamp", "previousHash", "kind", "hash"]) {
			if (stringAt(event, key) === null) return schema(`event.${key} is missing`);
		}
		const sequence = numberAt(event, "sequence");
		if (sequence === null || sequence < 0) return schema("event.sequence is not a sequence number");
		if (event.actor === undefined) return schema("event.actor is missing");
		const projection = objectAtKey(event, "data");
		if (projection === undefined) return schema("event.data is missing");

		// `work` is deliberately NOT required here: §4's equality 9 owns the absent
		// mirror ("receipt.work is REQUIRED, so an absent mirror fails HERE"), and
		// step 1 must not pre-empt a condition a normative equality names.

		// Proof material is the UNVERIFIABLE case, not a schema failure: §7 lists
		// "a proof or checkpoint that is not there" under missing material.
		const proof = objectAtKey(document, "proof");
		if (proof === undefined) return missingMaterial("proof", "the receipt carries no proof");
		const inclusion = objectAtKey(proof, "inclusion");
		if (inclusion === undefined) {
			return missingMaterial("proof", "the proof carries no inclusion member");
		}
		const checkpoint = objectAtKey(proof, "checkpoint");
		if (checkpoint === undefined) {
			return missingMaterial("checkpoint", "the proof carries no checkpoint member");
		}
		if (stringAt(proof, "profile") === null) return schema("proof.profile is missing");
		if (stringAt(proof, "chain") === null) return schema("proof.chain is missing");
		if (stringAt(proof, "mintEventHash") === null) return schema("proof.mintEventHash is missing");
		if (inclusion.version !== 1) return schema("proof.inclusion.version is not 1");

		this.bound = {
			document,
			receiptId,
			minter,
			signature,
			event,
			projection,
			proof,
			inclusion,
			checkpoint,
		};
		return PASSED;
	}

	// ── Step 2: recompute `event.hash`, then §4's nine equalities ────────────
	private stepEvent(): Resolution {
		const { document, event, projection, proof, inclusion, checkpoint } = this.receipt;
		const mismatch = (detail: string): Resolution => failure("EVENT_MISMATCH", detail);

		// The chain must resolve before equality 2 or 8 can be evaluated at all —
		// both read the REGISTERED form. An unregistered `proof.chain` is
		// unresolvable trust material, not a mismatch.
		const chainId = stringAt(proof, "chain") as string;
		const chain = this.input.snapshot.chains.get(chainId);
		if (chain === undefined) {
			return missingMaterial("trustKey", `chain ${chainId} is not registered in the snapshot`);
		}
		this.chain = chain;

		const eventHash = stringAt(event, "hash") as string;
		if (canonicalHash(canonicalizeWithout(event, "hash")) !== eventHash) {
			return mismatch("event.hash does not recompute from the embedded envelope");
		}

		// Equality 1.
		if (stringAt(proof, "mintEventHash") !== eventHash) {
			return mismatch("equality 1: proof.mintEventHash ≠ event.hash");
		}
		if (stringAt(inclusion, "leafHash") !== eventHash) {
			return mismatch("equality 1: inclusion.leafHash ≠ event.hash");
		}

		// Equality 2 — canonical BYTES against the registered mintActor form, not
		// field plucking: the closed union has a string form too, and the chain
		// entry selects which one this vault uses.
		if (event.kind !== UT1_MINT_EVENT_KIND) {
			return mismatch(`equality 2: event.kind is not ${UT1_MINT_EVENT_KIND}`);
		}
		if (canonicalize(event.actor) !== canonicalize(chain.mintActor)) {
			return mismatch("equality 2: event.actor is not the chain's registered mintActor");
		}

		// Equality 3 holds BY CONSTRUCTION and cannot be given a mutant: §4 says
		// the projection and `event.data` "are the same object — no duplicate
		// copies", and step 1's unknown-field walk refuses any second copy. There
		// is nothing to compare, which is the strongest form of the guarantee.

		const segmentFirstSequence = numberAt(checkpoint, "segmentFirstSequence");
		const checkpointTreeSize = numberAt(checkpoint, "treeSize");
		if (segmentFirstSequence === null || checkpointTreeSize === null) {
			return mismatch("the checkpoint carries no segmentFirstSequence/treeSize to bind against");
		}
		const leafIndex = numberAt(inclusion, "leafIndex");
		const sequence = numberAt(event, "sequence") as number;
		if (leafIndex === null) return mismatch("inclusion.leafIndex is not an integer");
		// Equality 4 — SEGMENT-RELATIVE (§4a: one tree per segment).
		if (leafIndex !== sequence - segmentFirstSequence) {
			return mismatch(
				`equality 4: leafIndex ${leafIndex} ≠ sequence ${sequence} − segmentFirstSequence ${segmentFirstSequence}`,
			);
		}
		if (leafIndex < 0 || leafIndex >= checkpointTreeSize) {
			return mismatch(`equality 4: leafIndex ${leafIndex} is outside [0, ${checkpointTreeSize})`);
		}
		// Equality 5 — the leaf-hiding defence the fold cannot make: a proof can
		// reach the signed root under a treeSize the checkpoint never signed.
		if (numberAt(inclusion, "treeSize") !== checkpointTreeSize) {
			return mismatch("equality 5: inclusion.treeSize ≠ checkpoint.treeSize");
		}
		// Equality 6.
		if (stringAt(inclusion, "root") !== stringAt(checkpoint, "root")) {
			return mismatch("equality 6: inclusion.root ≠ checkpoint.root");
		}
		// Equality 7 — the receipt/projection agreement half. `minter.kind` is
		// step 4's (CLI spec §5's precedence rule: one condition, one code).
		if (document.spec !== projection.spec || document.scope !== projection.scope) {
			return mismatch("equality 7: receipt spec/scope disagree with the projection");
		}
		// Equality 8 — read out of the CHECKPOINT's own SIGNED payload first, so
		// the statement says which chain it belongs to; the registry is a second
		// fence, not the only one.
		if (stringAt(inclusion, "segmentId") !== stringAt(checkpoint, "segmentId")) {
			return mismatch("equality 8: inclusion.segmentId ≠ checkpoint.segmentId");
		}
		if (stringAt(checkpoint, "vaultId") !== chainId) {
			return mismatch("equality 8: checkpoint.vaultId ≠ proof.chain");
		}
		const profile = stringAt(proof, "profile") as string;
		if (stringAt(checkpoint, "profile") !== profile) {
			return mismatch("equality 8: checkpoint.profile ≠ proof.profile");
		}
		// The verifier SELECTS §4a's equality set from this literal; it never
		// infers the profile from the shapes it happens to see. A future ut-chain
		// profile ships under a different literal and is not this build's.
		if (profile !== UT1_PROFILE) {
			return mismatch(`equality 8: proof.profile ${JSON.stringify(profile)} is not ut1's`);
		}
		if (chain.profile !== profile) {
			return mismatch("equality 8: the registered chain profile disagrees with proof.profile");
		}
		// §4 keeps this "defensively" and names it redundant with equality 4, which
		// is exactly what it is: `sequence < segmentFirstSequence` makes eq 4's
		// leafIndex negative, and the range check above has already refused it. It
		// is UNREACHABLE by construction and retained anyway, because the day
		// someone loosens eq 4 this is what still holds the line. No fixture can
		// cover it; saying so beats a vector that pretends to.
		if (sequence < segmentFirstSequence) {
			return mismatch("equality 8: event.sequence precedes checkpoint.segmentFirstSequence");
		}
		// Equality 9 — the mirror. Without it a conflicting top-level `work`
		// renders as chain-attested when only the mint signature covers it.
		// Both sides are guarded before `canonicalize` sees them. `canonical.ts`
		// answers the JS value `undefined` for an absent input rather than the
		// `null` §13 specifies, and a comparison resting on that quirk would be a
		// correct answer for the wrong reason — and would move the day the
		// canonicalization correction lands.
		if (document.work === undefined) {
			return mismatch("equality 9: receipt.work is REQUIRED and the mirror is absent");
		}
		if (projection.work === undefined) {
			return mismatch("equality 9: the projection carries no work for the mirror to match");
		}
		if (canonicalize(document.work) !== canonicalize(projection.work)) {
			return mismatch("equality 9: receipt.work is not the projection's work");
		}
		return PASSED;
	}

	// ── Step 3(a): arrival context. 3(b) is notApplicable offline, by rule ───
	private stepRegistry(): Resolution {
		const expected = this.input.arrivalId;
		if (expected === undefined) {
			// §7: "a receipt read from a file with no arrival context has nothing to
			// compare and this half is reported as not-applicable, NOT as a pass".
			this.arrival = "notApplicable";
			return NOT_APPLICABLE;
		}
		if (expected !== this.receipt.receiptId) {
			this.arrival = "failed";
			return failure(
				"ID_MISMATCH",
				`the document's receiptId is ${this.receipt.receiptId}, but it arrived as ${expected}`,
			);
		}
		this.arrival = "passed";
		return PASSED;
	}

	// ── Step 4: the mint signature and its FULL authority binding ────────────
	private stepSignature(): Resolution {
		const { document, minter, signature, checkpoint } = this.receipt;
		const invalid = (detail: string): Resolution => failure("SIG_INVALID", detail);

		const keyId = stringAt(signature, "keyId") as string;
		const key = this.input.snapshot.keys.get(keyId);
		if (key === undefined) {
			return missingMaterial("trustKey", `mint key ${keyId} is not in the pinned snapshot`);
		}
		if (key.role !== "mint") return invalid(`key ${keyId} is registered with role ${key.role}`);
		if (key.minterKind !== stringAt(minter, "kind")) {
			return invalid(
				`minter.kind ${JSON.stringify(minter.kind)} disagrees with the key's registered minterKind`,
			);
		}
		// Per-chain authority (R3-2): a domain-wide mint key confers NO authority
		// over a chain that does not list it.
		if (!this.boundChain.mintKeyIds.includes(keyId)) {
			return invalid(`key ${keyId} is not in chains[].mintKeyIds for ${this.boundChain.vaultId}`);
		}
		// §8's v1 pin. Offline the snapshot carries no domain, so the literal is
		// the only thing there is to check — and a lookalike domain is exactly the
		// string an attacker supplies.
		if (stringAt(minter, "trustDomain") !== UT1_TRUST_DOMAIN) {
			return invalid(`minter.trustDomain is not the pinned literal ${UT1_TRUST_DOMAIN}`);
		}
		if (key.alg !== "ed25519") {
			return invalid(`key ${keyId} is registered for ${key.alg}, not the receipt's ed25519`);
		}
		// The retired-MINT-key boundary, evaluated through the mint event's
		// SEGMENT (§8). "State permitting" alone accepts a freshly-signed receipt
		// from a retired key — the exact attack rotation exists to bound.
		const segmentFirstSequence = numberAt(checkpoint, "segmentFirstSequence") as number;
		const stateFailure = keyStatePermits(key, segmentFirstSequence);
		if (stateFailure !== null) return invalid(stateFailure);

		const preimage = RECEIPT_SIGNATURE_PREFIX + canonicalizeWithout(document, "signature");
		if (!verifyEd25519(preimage, key.publicKey, stringAt(signature, "sig") as string)) {
			return invalid(`the mint signature does not verify under key ${keyId}`);
		}
		return PASSED;
	}

	// ── Step 5: the inclusion path ───────────────────────────────────────────
	private stepInclusion(): Resolution {
		const { inclusion, checkpoint } = this.receipt;
		// Reused verbatim from `verify.ts`: leaf `sha256(0x00‖hexDecode(leafHash))`,
		// interior `sha256(0x01‖L‖R)`, odd-promote, and — the part a hand-rolled
		// fold always misses — topology DERIVED from (leafIndex, treeSize) rather
		// than taken from the supplied siblings (R3-3, PR #86).
		const folded = verifyInclusionProof(
			inclusion as unknown as MerkleInclusionProof,
			stringAt(checkpoint, "root") as string,
			numberAt(checkpoint, "treeSize") as number,
		);
		return folded
			? PASSED
			: failure("PROOF_INVALID", "the inclusion path does not fold to the signed root");
	}

	// ── Step 6: the checkpoint statement ─────────────────────────────────────
	private stepCheckpoint(): Resolution {
		const outcome = verifyCheckpointStatement(
			this.receipt.checkpoint,
			this.boundChain,
			this.input.snapshot,
		);
		if (outcome.ok) return PASSED;
		return outcome.missingTrustKey
			? missingMaterial("trustKey", outcome.detail)
			: failure("CHECKPOINT_INVALID", outcome.detail);
	}

	// ── Step 7: §2's semantic constraints ────────────────────────────────────
	private stepSemantics(): Resolution {
		const { projection } = this.receipt;
		const detail = checkSemantics(projection);
		if (detail !== null) return failure("SEMANTIC_INVALID", detail);
		const spend = objectAtKey(projection, "spend") as JsonObject;
		this.posture = {
			delegation: stringAt(projection, "delegationPosture") as string,
			usage: stringAt(spend, "usagePosture") as string,
			pricing: stringAt(spend, "pricingPosture") as string,
		};
		return PASSED;
	}

	// ── Step 8: the one derivation, and the computed amount ──────────────────
	private stepDerivations(): Resolution {
		const { projection } = this.receipt;
		const spend = objectAtKey(projection, "spend") as JsonObject;
		// §2: `amountUsd` is never stored, so it cannot MISMATCH — step 8 computes
		// it. `DERIVATION_MISMATCH` never refers to it.
		this.amountUsd = amountUsdFromAssessed(numberAt(spend, "assessedUsertokens") as number);

		const transferSet = projection.transferSet;
		if (transferSet === undefined) {
			// The >32-pair receipt: the root stays a COMMITMENT, checkable against
			// disclosed data but not recomputable from the receipt alone.
			return NOT_APPLICABLE;
		}
		const recomputed = canonicalHash(TRANSFER_SET_PREFIX + canonicalize(transferSet));
		if (recomputed !== stringAt(projection, "transferSetRoot")) {
			return failure(
				"DERIVATION_MISMATCH",
				"transferSetRoot is not the digest of the transferSet as given",
			);
		}
		return PASSED;
	}

	private report(outcome: {
		verdict: BaseVerdictReport["verdict"];
		failure: BaseVerdictReport["failure"];
		missing: BaseVerdictReport["missing"];
	}): BaseVerdictReport {
		const steps = {} as Record<BaseStepName, StepOutcome>;
		for (const step of BASE_STEPS) {
			// A step that never ran is `unavailable`, never `notApplicable`:
			// `notApplicable` asserts the input could not exist in this context,
			// which would be a claim about the receipt rather than about this run.
			steps[step] = this.results.get(step) ?? { result: "unavailable" };
		}
		const verified: VerifiedMaterial | null =
			outcome.verdict === "VERIFIED_CHECKPOINT" && this.bound !== null && this.chain !== null
				? { document: this.bound.document, chain: this.chain, checkpoint: this.bound.checkpoint }
				: null;
		return {
			verdict: outcome.verdict,
			receiptId: this.receiptId,
			steps,
			// Both are `notApplicable` offline BY RULE (§7's Offline column, and
			// CLI spec §5 for `predecessorLinkage`): the registry does not exist in
			// this context and never could.
			checks: {
				registryBinding: NOT_APPLICABLE_OUTCOME,
				predecessorLinkage: NOT_APPLICABLE_OUTCOME,
			},
			arrivalContext: { result: this.arrival, expected: this.input.arrivalId ?? null },
			// The amount and its labels are released ONLY on a base pass, even
			// though step 8 computes the amount before it checks the derivation.
			// A verifier that hands a renderable total to a report about a
			// TAMPERED receipt is one careless template away from printing it, and
			// §2a's whole point is that an amount never travels without a scope
			// its reader can trust. Withheld is not the same as absent: the
			// failure names the step, and that is what the caller renders.
			computed: {
				amountUsd: outcome.verdict === "VERIFIED_CHECKPOINT" ? this.amountUsd : null,
			},
			posture: outcome.verdict === "VERIFIED_CHECKPOINT" ? this.posture : null,
			failure: outcome.failure,
			missing: outcome.missing,
			verified,
		};
	}
}

function canonicalHash(preimage: string): string {
	return createHash("sha256").update(preimage, "utf8").digest("hex");
}

/**
 * receipt-spec §7 steps 1–8 over one receipt and one PINNED §8 snapshot.
 *
 * Offline and total: it performs no I/O, and it never throws — every refusal
 * comes back as a verdict with the step, the code and the reason, because a
 * thrown exception cannot be told apart from a crash by the caller that has to
 * choose an exit code.
 */
export function verifyReceiptBase(input: ReceiptVerifyInput): BaseVerdictReport {
	return new BaseRun(input).run();
}
