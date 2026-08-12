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
 * This file grows across the ship. Today it holds step 1's STRICT BYTE READER
 * and the §8 TRUST-SNAPSHOT LOADER; the nine steps land on top of it.
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
import { publicKeyFromPem, publicKeyFromSpkiBase64 } from "./anchor-verify.js";

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
