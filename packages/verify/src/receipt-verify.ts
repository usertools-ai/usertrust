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
 * the §8 TRUST-SNAPSHOT LOADER, §7 steps 1–8 — the BASE verdict — and §7 step
 * 9's extension checks with the cumulative ladder. The CLI surface lands on
 * top of it.
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

/**
 * `syntax` — the bytes are not a JSON document (UNVERIFIABLE: the material
 * never arrived). `numeric` — they ARE a document, and a numeric LITERAL in it
 * breaks §3's frozen rules (FAILED / `SCHEMA_INVALID`: a real negative answer).
 * CLI spec §5's table makes that line decide the exit code, so the scan has to
 * carry the class rather than let the caller guess it from the wording.
 */
export type JsonScanFailureKind = "syntax" | "numeric";

export type JsonScanResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly kind: JsonScanFailureKind; readonly detail: string };

// ─────────────────────────────────────────────────────────────────────────────
// The frozen-numeric POLICY.
//
// ONE rule, stated once, for every structure this verifier reads:
//
//   A DECLARED-INTEGER field whose value is covered by a signature — or which
//   feeds a comparison against signed material — is validated on the LITERAL,
//   before `JSON.parse` is allowed to round it.
//
// The rule follows the declared FIELD, never the file. That is the whole
// correction. Three separate review rounds found the same defect in three
// different documents — the receipt, the §8 snapshot, and the served checkpoint
// history — and each was fixed only where it surfaced, because the scope was
// derived from the instance that revealed it rather than from the property. A
// policy keyed by declared-field identity has no "where it surfaced": a
// structure either declares a position as an integer or it does not.
//
// The policy is a TREE, descended in lockstep with the document, and NOT a path
// pattern. A pattern has to be matched against a path STRING, and a path string
// built by concatenating raw JSON keys is ambiguous: an unknown top-level member
// literally named `keys[0]` produces `$.keys[0].activationSequence`, the exact
// text the real declared path produces. Matching it rejected a document §4
// promises to accept. Descending the tree cannot express that confusion —
// `members.get("keys[0]")` and `members.get("keys")` are different lookups — so
// the ambiguity is not fixed here, it is unrepresentable.
//
// `ReadonlyMap` rather than an object, for the reason `fieldTable` documents:
// an object literal answers `["__proto__"]` and `["constructor"]` with inherited
// values, and a policy that says "declared" for a member nobody declared is the
// same class of hole pointing the other way.
// ─────────────────────────────────────────────────────────────────────────────

export interface NumericPolicy {
	/**
	 * Every number at or below this position is declared. For a CLOSED format
	 * with no fractional domain — the ut1 receipt (§2), §4a's v2 checkpoint
	 * statement — this is the accurate policy and not a blunt one: the schema
	 * admits no member that could legitimately carry a fraction.
	 */
	readonly frozen?: true;
	/** The number AT this position is declared. Its subtree is not. */
	readonly integer?: true;
	readonly members?: ReadonlyMap<string, NumericPolicy>;
	/** Every element of an array shares one declaration. */
	readonly elements?: NumericPolicy;
}

/** Every number below here is declared — a closed format with no fractions. */
export const FROZEN_SUBTREE: NumericPolicy = { frozen: true };
/** This one position is a declared integer; nothing below it is. */
export const DECLARED_INTEGER: NumericPolicy = { integer: true };

export function policyMembers(entries: Readonly<Record<string, NumericPolicy>>): NumericPolicy {
	return { members: new Map(Object.entries(entries)) };
}

export function policyElements(of: NumericPolicy): NumericPolicy {
	return { elements: of };
}

export interface JsonScanOptions {
	/**
	 * Which positions hold a declared integer. Absent ⇒ no position does, which
	 * is the honest answer for a structure this verifier reads no integer out of.
	 *
	 * A fraction anywhere the policy does NOT name stays legal, everywhere. That
	 * is the forward-compatibility promise §4 makes for the snapshot's unknown
	 * members and §3 makes for the resolver's envelope, and it survives intact
	 * because the constraint is attached to the declared field rather than to the
	 * document that happens to carry it.
	 */
	readonly policy?: NumericPolicy;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const HEX_DIGIT = /^[0-9a-fA-F]$/;

/** A scan failure carrying its class up through the recursive descent. */
interface ScanFailure {
	readonly kind: JsonScanFailureKind;
	readonly detail: string;
}

/**
 * The policy for a MEMBER of a position governed by `policy`. `undefined` in,
 * `undefined` out: once the walk leaves the declared region it stays outside it,
 * which is what keeps unknown members free to carry fractions.
 */
function memberPolicy(policy: NumericPolicy | undefined, key: string): NumericPolicy | undefined {
	if (policy === undefined) return undefined;
	if (policy.frozen === true) return policy;
	return policy.members?.get(key);
}

/** The same, for an array element. Every element shares one declaration. */
function elementPolicy(policy: NumericPolicy | undefined): NumericPolicy | undefined {
	if (policy === undefined) return undefined;
	if (policy.frozen === true) return policy;
	return policy.elements;
}

/**
 * A path SEGMENT for diagnostics only — never for a decision.
 *
 * Escaped, because a raw key is not safe to concatenate: `{"a.b":…}` and
 * `{"a":{"b":…}}` both render `$.a.b`, and a message that names two different
 * positions identically is a message an operator cannot act on. The DECISION
 * never reads this string (the policy is descended structurally), so this is the
 * only remaining job the path has and it may as well do it unambiguously.
 */
function pathSegment(path: string, key: string): string {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
		? `${path}.${key}`
		: `${path}[${JSON.stringify(key)}]`;
}

class JsonScanner {
	private pos = 0;
	private readonly policy: NumericPolicy | undefined;

	constructor(
		private readonly text: string,
		options: JsonScanOptions,
	) {
		this.policy = options.policy;
	}

	scan(): JsonScanResult {
		if (this.text.charCodeAt(0) === 0xfeff) {
			// Named explicitly. "unexpected character" would be true and useless:
			// the operator needs to know the BOM was RETAINED and rejected, not
			// that something invisible was somewhere.
			return {
				ok: false,
				kind: "syntax",
				detail: "byte-order mark at offset 0: canonical JSON carries none",
			};
		}
		const failure = this.value(0, "$", this.policy);
		if (failure !== null) return { ok: false, ...failure };
		this.whitespace();
		if (this.pos !== this.text.length) {
			return { ok: false, kind: "syntax", detail: `trailing content at offset ${this.pos}` };
		}
		return { ok: true };
	}

	private whitespace(): void {
		while (this.pos < this.text.length && WHITESPACE.has(this.text[this.pos] as string)) {
			this.pos += 1;
		}
	}

	/** Returns a failure, or `null` when one well-formed value was consumed. */
	private value(
		depth: number,
		path: string,
		policy: NumericPolicy | undefined,
	): ScanFailure | null {
		if (depth > MAX_JSON_DEPTH) {
			return syntax(`nesting deeper than ${MAX_JSON_DEPTH} at ${path}`);
		}
		this.whitespace();
		const ch = this.text[this.pos];
		if (ch === undefined) return syntax(`unexpected end of input at offset ${this.pos}`);
		if (ch === "{") return this.object(depth, path, policy);
		if (ch === "[") return this.array(depth, path, policy);
		if (ch === '"') return this.string();
		if (ch === "-" || (ch >= "0" && ch <= "9")) return this.number(path, policy);
		for (const literal of ["true", "false", "null"]) {
			if (this.text.startsWith(literal, this.pos)) {
				this.pos += literal.length;
				return null;
			}
		}
		return syntax(`unexpected character ${JSON.stringify(ch)} at offset ${this.pos}`);
	}

	private object(
		depth: number,
		path: string,
		policy: NumericPolicy | undefined,
	): ScanFailure | null {
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
				return syntax(`expected a member name at offset ${this.pos}`);
			}
			const start = this.pos;
			const stringFailure = this.string();
			if (stringFailure !== null) return stringFailure;
			const key = JSON.parse(this.text.slice(start, this.pos)) as string;
			if (seen.has(key)) {
				return syntax(`duplicate JSON key ${JSON.stringify(key)} at ${path}`);
			}
			seen.add(key);
			this.whitespace();
			if (this.text[this.pos] !== ":") return syntax(`expected ':' at offset ${this.pos}`);
			this.pos += 1;
			const valueFailure = this.value(depth + 1, pathSegment(path, key), memberPolicy(policy, key));
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
			return syntax(`expected ',' or '}' at offset ${this.pos}`);
		}
	}

	private array(
		depth: number,
		path: string,
		policy: NumericPolicy | undefined,
	): ScanFailure | null {
		this.pos += 1; // "["
		this.whitespace();
		if (this.text[this.pos] === "]") {
			this.pos += 1;
			return null;
		}
		const element = elementPolicy(policy);
		let index = 0;
		for (;;) {
			const failure = this.value(depth + 1, `${path}[${index}]`, element);
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
			return syntax(`expected ',' or ']' at offset ${this.pos}`);
		}
	}

	private string(): ScanFailure | null {
		this.pos += 1; // opening quote
		for (;;) {
			const ch = this.text[this.pos];
			if (ch === undefined) return syntax(`unterminated string at offset ${this.pos}`);
			if (ch === '"') {
				this.pos += 1;
				return null;
			}
			if (ch === "\\") {
				const escaped = this.text[this.pos + 1];
				if (escaped === undefined) return syntax(`unterminated escape at offset ${this.pos}`);
				if (escaped === "u") {
					for (let i = 2; i < 6; i += 1) {
						const digit = this.text[this.pos + i];
						if (digit === undefined || !HEX_DIGIT.test(digit)) {
							return syntax(`invalid \\u escape at offset ${this.pos}`);
						}
					}
					this.pos += 6;
					continue;
				}
				if (!'"\\/bfnrt'.includes(escaped)) {
					return syntax(`invalid escape ${JSON.stringify(escaped)} at offset ${this.pos}`);
				}
				this.pos += 2;
				continue;
			}
			if (ch.charCodeAt(0) < 0x20) {
				return syntax(`raw control character in string at offset ${this.pos}`);
			}
			this.pos += 1;
		}
	}

	/**
	 * The JSON number grammar — and, when the frozen rules are on, §3 step 4
	 * applied to the LITERAL rather than to what the parser makes of it.
	 *
	 * That distinction is the whole point of scanning the text. `JSON.parse`
	 * ROUNDS: `1.00000000000000001` has no double representation, so it comes
	 * back as exactly `1`, and every value-level check afterwards —
	 * `Number.isInteger`, `Number.isSafeInteger`, `Object.is(n, -0)` — is asking
	 * about a number the document never carried. Worse, everything downstream
	 * then agrees: `canonicalize` re-serializes the ROUNDED value, so the event
	 * hash recomputes, the §5 signature verifies, and the receipt is reported
	 * VERIFIED while its bytes say something §13 forbids. Information the parser
	 * destroys has to be checked before it is destroyed.
	 *
	 * The classification below reuses `describeNumberViolation`'s vocabulary so
	 * one rule reads the same wherever it is enforced.
	 */
	private number(path: string, policy: NumericPolicy | undefined): ScanFailure | null {
		const start = this.pos;
		if (this.text[this.pos] === "-") this.pos += 1;
		if (this.text[this.pos] === "0") {
			this.pos += 1;
		} else {
			const first = this.text[this.pos];
			if (first === undefined || first < "1" || first > "9") {
				return syntax(`invalid number at offset ${start}`);
			}
			while (this.isDigit(this.text[this.pos])) this.pos += 1;
		}
		// A fraction or an exponent means the literal is not an integer literal,
		// whatever value it rounds to. `1e999` (Infinity) and `1e2` (100) are
		// both refused, and both are correct: §2 declares no fractional domain
		// and §13's canonical form for an integer never carries an exponent.
		let fractional = false;
		if (this.text[this.pos] === ".") {
			fractional = true;
			this.pos += 1;
			if (!this.isDigit(this.text[this.pos])) return syntax(`invalid number at offset ${start}`);
			while (this.isDigit(this.text[this.pos])) this.pos += 1;
		}
		const exponent = this.text[this.pos];
		if (exponent === "e" || exponent === "E") {
			fractional = true;
			this.pos += 1;
			const sign = this.text[this.pos];
			if (sign === "+" || sign === "-") this.pos += 1;
			if (!this.isDigit(this.text[this.pos])) return syntax(`invalid number at offset ${start}`);
			while (this.isDigit(this.text[this.pos])) this.pos += 1;
		}
		// The ONE decision, and it is made on the POLICY NODE this walk arrived
		// at — never on the path string above, which by this line is diagnostics.
		if (policy?.frozen !== true && policy?.integer !== true) return null;

		const literal = this.text.slice(start, this.pos);
		const value = Number(literal);
		const numeric = (rule: string): ScanFailure => ({
			kind: "numeric",
			detail: `${rule} at ${path} (literal ${literal})`,
		});
		// Ordered so each refusal names the rule an operator can act on, not
		// merely the first clause that happened to catch it.
		if (!Number.isFinite(value)) return numeric("non-finite number");
		if (Object.is(value, -0)) return numeric("negative zero");
		if (fractional) return numeric("non-integer number");
		if (!Number.isSafeInteger(value)) return numeric("integer outside the safe range");
		return null;
	}

	private isDigit(ch: string | undefined): boolean {
		return ch !== undefined && ch >= "0" && ch <= "9";
	}
}

function syntax(detail: string): ScanFailure {
	return { kind: "syntax", detail };
}

export function scanJsonForDuplicateKeys(
	text: string,
	options: JsonScanOptions = {},
): JsonScanResult {
	return new JsonScanner(text, options).scan();
}

/**
 * `options` with the numeric axis SUBTRACTED — every other axis carried through
 * untouched.
 *
 * Written as a subtraction rather than as a fresh `{}` literal so it cannot
 * drift: an axis added to `JsonScanOptions` tomorrow reaches the syntax oracle
 * by inheritance, and nobody has to remember that a second call site exists.
 * The one thing removed is the one thing the oracle must not re-apply.
 */
function withoutNumericPolicy(options: JsonScanOptions): JsonScanOptions {
	const { policy: _numeric, ...rest } = options;
	return rest;
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

/** The first number in document order for which `offends` holds, or `null`. */
function findNumber(
	value: unknown,
	offends: (n: number) => boolean,
	path: string,
): NumberViolation | null {
	if (typeof value === "number") return offends(value) ? { path, value } : null;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i += 1) {
			const found = findNumber(value[i], offends, join(path, String(i)));
			if (found !== null) return found;
		}
		return null;
	}
	if (isJsonObject(value)) {
		for (const key of Object.keys(value)) {
			const found = findNumber(value[key], offends, join(path, key));
			if (found !== null) return found;
		}
	}
	return null;
}

/** The first offending number in document order, or `null`. */
export function findNonFrozenNumber(value: unknown, path = ""): NumberViolation | null {
	return findNumber(
		value,
		(n) => !Number.isFinite(n) || Object.is(n, -0) || !Number.isSafeInteger(n),
		path,
	);
}

/**
 * The NON-FINITE clause on its own, for documents the frozen rules do NOT
 * govern — the §8 snapshot, whose unknown members are deliberately tolerated
 * (CLI spec §4) and may one day carry a legitimate fraction.
 *
 * Non-finiteness is the clause that has to bind everywhere regardless, because
 * it is the one `canonicalize` THROWS on. A thrown canonicalization is not a
 * verdict — §7 is explicit that "the verdict is a function of those results,
 * not of an exception being thrown somewhere" — so wherever a value can reach
 * `canonicalize`, `1e999` has to be refused as a VALUE first.
 */
export function findNonFiniteNumber(value: unknown, path = ""): NumberViolation | null {
	return findNumber(value, (n) => !Number.isFinite(n), path);
}

/**
 * Structural equality over two STRICT-PARSED JSON values (CLI spec §3's R4).
 *
 * Key ORDER is not a disagreement — the resolver may serialize its convenience
 * copy however it likes — but everything else is, and that is why this is not
 * a canonical-string comparison. `canonicalize` is a serializer, and a
 * serializer's job is to erase distinctions: it renders `-0` as `0` (§13, and
 * `JSON.stringify` too), so two documents that are not the same document
 * produce the same string and R4 reports agreement about them. `Object.is` is
 * the only thing that separates the two, and the copy is what a consumer
 * reads. Comparing structurally also keeps `canonicalize` off this path
 * entirely, so a hostile `1e999` in the copy is a disagreement rather than a
 * throw — a throw is never a verdict here (§7).
 *
 * Total on `readStrictJson` output: no cycles (JSON has none), no `undefined`
 * (JSON.parse produces none), and depth is already bounded by the scanner.
 */
export function structurallyEqualJson(a: JsonValue, b: JsonValue): boolean {
	if (typeof a === "number" || typeof b === "number") {
		return typeof a === "number" && typeof b === "number" && Object.is(a, b);
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => structurallyEqualJson(entry, b[index] as JsonValue));
	}
	if (isJsonObject(a) || isJsonObject(b)) {
		if (!isJsonObject(a) || !isJsonObject(b)) return false;
		const keys = Object.keys(a);
		if (keys.length !== Object.keys(b).length) return false;
		// Duplicate keys are already refused by the scan, so a matching key COUNT
		// plus per-key presence is a set comparison.
		return keys.every(
			(key) =>
				Object.hasOwn(b, key) && structurallyEqualJson(a[key] as JsonValue, b[key] as JsonValue),
		);
	}
	// string | boolean | null — `===` separates every pair of these.
	return a === b;
}

export function describeNumberViolation(value: number): string {
	if (!Number.isFinite(value)) return "non-finite number";
	if (Object.is(value, -0)) return "negative zero";
	if (!Number.isInteger(value)) return "non-integer number";
	return "integer outside the safe range";
}

// ─────────────────────────────────────────────────────────────────────────────
// The FIELD TABLE — every member of the signed receipt, declared ONCE, with
// both the key set (§5: "Unknown fields in the signed receipt → FAIL"; §2:
// "any unknown field anywhere in a `ut1` document is FAIL") and the member's
// DECLARED FORMAT.
//
// The table replaces the bare key SETS this file used to carry, and the reason
// is a defect CLASS rather than tidiness. Two review rounds found nine holes
// and they were one hole nine times: the reader checked STRUCTURE (present? a
// string? a number?) and never FORMAT (the thing §2 says it is). `stringAt`
// cannot tell `"2026-08-11T18:00:00.000Z"` from `"not-a-date"`, and nothing
// downstream reads either as a time. A sibling hash of `<64 hex>zz` folds to
// the SAME root, because Node's hex decoder stops at the first non-hex pair and
// silently drops the tail — so the proof verifies here and FAILS under any
// implementation whose decoder refuses trailing junk, which is an interop split
// in a frozen format. `sourceReservationReceiptId: "not-an-id"` names no
// receipt and passed. Patching the three named instances would have left every
// other read in this file exactly as it was.
//
// So the key set and the format are ONE declaration now. A member cannot enter
// the schema without saying what it is — every `FieldRule` names a format and
// an owner — and `walkFieldTable` applies whatever the table says, in ONE
// traversal shared by the unknown-field walk and the format pass. Two walkers
// would be two chances to forget a subtree; one walker cannot visit a field for
// one purpose and miss it for the other.
//
// `owner` records WHICH step reports a violation, because §7's steps own their
// failure codes and CLI spec §5's precedence rule is explicit that step 1's
// schema validation must not pre-empt a condition a normative equality names:
//
//  - `schema`     — step 1's own pass, `findFormatViolation` below.
//  - `checkpoint` — §4a's v2 statement members, applied by
//                   `checkpointStatementShape` so that a SERVED history member
//                   (step 9), which never passes through this reader at all,
//                   gets the identical rule.
//  - `semantics`  — §2's enumerated public-safety and digest rules, which §7
//                   step 7 owns by name (`proofId`, `workloadId`, `repo`,
//                   `transferSetRoot`, `prevGenerationEventHash`, transfer IDs).
//  - `event` / `signature` / `inclusion` — a hash an equality already pins (the
//                   recompute is strictly stronger than any regex), the literal
//                   step 4 binds to the snapshot, the sibling `position` step 5
//                   compares against the DERIVED topology.
//
// A member with no declared syntax at all is `nonEmpty` and says so: §2 makes a
// receipt a public document in which "every string needs a presence rule or a
// syntax rule", and for an opaque server-generated handle the presence rule IS
// the whole rule. Inventing a syntax for it would fail honest receipts, which
// is the same defect wearing the other costume.
// ─────────────────────────────────────────────────────────────────────────────

type KeySet = ReadonlySet<string>;

/** Which §7 step reports a violation of the declared format. */
export type FormatOwner =
	| "schema"
	| "event"
	| "signature"
	| "inclusion"
	| "checkpoint"
	| "semantics";

/**
 * The declared formats, each traceable to spec text:
 *
 *  - `hex64` — a SHA-256 digest, lowercase hex (§2's `objectSha256`
 *    "lowercaseHex(SHA-256(gitPreimage))"; §4a's roots and event hashes).
 *  - `hex64OrGenesis` — a root, or §4a's fixed genesis string.
 *  - `hex32` — §2's "canonically-encoded transfer ID (lowercase-hex 128-bit
 *    TigerBeetle ID, fixed length, no `0x`)".
 *  - `gitOid` — §2's FULL git object ID, 40 or 64 lowercase hex SELECTED BY
 *    the sibling `oidAlg` ("a display may truncate, the projection never
 *    does"; the resolver: "FULL git object ID … <full 40/64-hex>").
 *  - `rfc3339UtcMs` — §2's RFC 3339 UTC "Z", millisecond precision.
 *  - `receiptId` — §12's canonical decode/re-encode, not the character count.
 *  - `opaqueHandle` — §2's `[A-Za-z0-9._-]{1,128}` public-safety syntax.
 *  - `keyedRepoId` — the plain immutable provider ID, or the keyed form
 *    `"r1_" + base64url(HMAC-SHA-256(…))` (resolver round-9 F4) — a 32-byte
 *    MAC, so the keyed arm has an exact decoded length.
 *  - `keyedContentCommitment` — `"c1_" + base64url(HMAC-SHA-256(…))`, same.
 *  - `providerRepoUrl` — §2's canonical `<providerHost>/<owner>/<name>`, ≤256.
 *  - `canonicalBase64` — signature material, canonical (no appended junk).
 *  - `nonEmpty` — a string the spec gives no syntax; presence is the rule.
 *  - `integer` — a JSON number. The frozen numeric reader has already refused
 *    `-0`, fractions and unsafe integers ANYWHERE in the document, so what is
 *    left here is the TYPE; per-field ranges belong to the step that owns them.
 *  - `literal` / `enum` — a fixed value or a closed set, checked by the step
 *    that knows the vocabulary (never here: this pass has no verdict).
 *  - `canonicalBytes` — `event.actor`, which equality 2 compares as canonical
 *    bytes against the registered `mintActor`; §4a is explicit that this is one
 *    comparison and not field plucking, so nothing descends into it.
 */
export type FormatName =
	| "hex64"
	| "hex64OrGenesis"
	| "hex32"
	| "gitOid"
	| "rfc3339UtcMs"
	| "receiptId"
	| "opaqueHandle"
	| "keyedRepoId"
	| "keyedContentCommitment"
	| "providerRepoUrl"
	| "canonicalBase64"
	| "nonEmpty"
	| "integer"
	| "literal"
	| "enum"
	| "canonicalBytes";

const FORMAT_DESCRIPTIONS: Readonly<Record<FormatName, string>> = {
	hex64: "64 lowercase hex characters",
	hex64OrGenesis: '64 lowercase hex characters or the fixed string "genesis"',
	hex32: "a canonical 128-bit lowercase-hex transfer ID",
	gitOid: "a FULL lowercase-hex git object ID under its oidAlg",
	rfc3339UtcMs: 'an RFC 3339 UTC "Z" timestamp with millisecond precision',
	receiptId: "a canonical §12 ut1 receipt ID",
	opaqueHandle: "an opaque [A-Za-z0-9._-]{1,128} handle",
	keyedRepoId: 'a provider repository ID, or "r1_" + base64url of a 32-byte MAC',
	keyedContentCommitment: '"c1_" + base64url of a 32-byte MAC',
	providerRepoUrl: "a ≤256-character <providerHost>/<owner>/<name> provider URL",
	canonicalBase64: "canonical base64",
	nonEmpty: "a non-empty string",
	integer: "an integer",
	literal: "the literal its step pins",
	enum: "a member of its closed value set",
	canonicalBytes: "the canonical form its equality pins",
};

type FieldRule =
	| { readonly kind: "scalar"; readonly format: FormatName; readonly owner: FormatOwner }
	/** Every entry is a string in one format — `models`, `providers`, `tableVersions`. */
	| { readonly kind: "stringArray"; readonly format: FormatName; readonly owner: FormatOwner }
	| { readonly kind: "object"; readonly table: FieldTable }
	| { readonly kind: "objectArray"; readonly table: FieldTable }
	/** A `kind`-discriminated union: `work`, `contentBinding`. An UNLISTED
	 * discriminant is step 7's union rule, not step 1's, so the walk stops. */
	| { readonly kind: "union"; readonly tables: ReadonlyMap<string, FieldTable> }
	/** Present, walked by nobody here — its owner compares it whole. */
	| { readonly kind: "opaqueValue"; readonly owner: FormatOwner };

type FieldTable = Readonly<Record<string, FieldRule>>;

/**
 * Every table is built through here, and the reason is a defect this table
 * INTRODUCED while closing the format class.
 *
 * A table written as an object literal inherits `Object.prototype`, so
 * `table["__proto__"]`, `table["constructor"]`, `table["toString"]` — every
 * name on that prototype — answer with an inherited value rather than
 * `undefined`. `walkFieldTable`'s unknown-field pass asked exactly that
 * question, so a signed member named after any of them read as DECLARED; the
 * declared pass then skipped it too, because `Object.keys(table)` never yields
 * an inherited name. The member was checked by NOBODY and the receipt reached
 * VERIFIED_CHECKPOINT — with a valid mint signature over it, since `JSON.parse`
 * creates `__proto__` as an OWN data property and `canonicalize` covers it.
 *
 * The lookup site now uses `Object.hasOwn`, which is the fix. This is the
 * second fence, and it is the one that survives the next edit: with no
 * prototype there is no inherited value for a future `table[key]` to find, so
 * the defect stops being expressible rather than merely being absent today.
 */
function fieldTable(entries: Record<string, FieldRule>): FieldTable {
	return Object.assign(Object.create(null) as Record<string, FieldRule>, entries);
}

function at(owner: FormatOwner, format: FormatName): FieldRule {
	return { kind: "scalar", format, owner };
}
function subtree(table: FieldTable): FieldRule {
	return { kind: "object", table };
}
function subtrees(table: FieldTable): FieldRule {
	return { kind: "objectArray", table };
}
function strings(owner: FormatOwner, format: FormatName): FieldRule {
	return { kind: "stringArray", format, owner };
}
function variants(tables: ReadonlyMap<string, FieldTable>): FieldRule {
	return { kind: "union", tables };
}

const MEMBERSHIP_FIELDS: FieldTable = fieldTable({
	// v1 FAILS CLOSED: `providerVerified` is the only ut1 value (step 7).
	status: at("semantics", "literal"),
	// §2's public-safety syntax, named there as step 7's.
	proofId: at("semantics", "opaqueHandle"),
});

const ORIGIN_FIELDS: FieldTable = fieldTable({
	kind: at("semantics", "literal"),
	// §2 types this `Ut1ReceiptId`: the fallback variant's whole purpose is the
	// bidirectional link to the reservation receipt, and a string that is not a
	// receipt ID cannot be that link.
	sourceReservationReceiptId: at("schema", "receiptId"),
});

const CONTENT_BINDING_FIELDS_BY_KIND: ReadonlyMap<string, FieldTable> = new Map<string, FieldTable>(
	[
		[
			"publicSha256",
			fieldTable({ kind: at("semantics", "literal"), sha256: at("schema", "hex64") }),
		],
		[
			"privateHmacSha256V1",
			fieldTable({
				kind: at("semantics", "literal"),
				commitment: at("schema", "keyedContentCommitment"),
			}),
		],
	],
);

/** §2's discriminated union. An UNLISTED `kind` is step 7's, not step 1's. */
const WORK_FIELDS_BY_KIND: ReadonlyMap<string, FieldTable> = new Map<string, FieldTable>([
	[
		"commit",
		fieldTable({
			kind: at("semantics", "enum"),
			repoId: at("schema", "keyedRepoId"),
			// §2 gives `repo` BOTH halves of its rule under step 7's public-safety
			// list, so the whole member stays there rather than splitting in two.
			repo: at("semantics", "providerRepoUrl"),
			oid: at("schema", "gitOid"),
			oidAlg: at("semantics", "enum"),
			objectSha256: at("schema", "hex64"),
			repositoryMembership: subtree(MEMBERSHIP_FIELDS),
		}),
	],
	[
		"pr",
		fieldTable({
			kind: at("semantics", "enum"),
			repoId: at("schema", "keyedRepoId"),
			repo: at("semantics", "providerRepoUrl"),
			number: at("schema", "integer"),
			providerArtifactId: at("schema", "nonEmpty"),
			observedRevision: at("schema", "nonEmpty"),
			contentBinding: variants(CONTENT_BINDING_FIELDS_BY_KIND),
			repositoryMembership: subtree(MEMBERSHIP_FIELDS),
		}),
	],
	[
		"issue",
		fieldTable({
			kind: at("semantics", "enum"),
			repoId: at("schema", "keyedRepoId"),
			repo: at("semantics", "providerRepoUrl"),
			number: at("schema", "integer"),
			providerArtifactId: at("schema", "nonEmpty"),
			observedRevision: at("schema", "nonEmpty"),
			contentBinding: variants(CONTENT_BINDING_FIELDS_BY_KIND),
			repositoryMembership: subtree(MEMBERSHIP_FIELDS),
		}),
	],
	// Both `session` variants in one table: `origin` present ⇒ fallback, absent
	// ⇒ ordinary, and §2 makes the two mutually exclusive rather than
	// differently keyed. Which variant this is, and whether `origin` is legal on
	// it, is step 7's ("`work` matching exactly one union variant").
	[
		"session",
		fieldTable({
			kind: at("semantics", "enum"),
			repoId: at("schema", "keyedRepoId"),
			repo: at("semantics", "providerRepoUrl"),
			origin: subtree(ORIGIN_FIELDS),
		}),
	],
]);

const SPEND_FIELDS: FieldTable = fieldTable({
	// Every range here is §2's enumerated semantic list — step 7's by name.
	assessedUsertokens: at("semantics", "integer"),
	postedUsertokens: at("semantics", "integer"),
	roundingAdjustment: at("semantics", "integer"),
	transferCount: at("semantics", "integer"),
	usagePosture: at("semantics", "enum"),
	pricingPosture: at("semantics", "enum"),
});

const PRICING_FIELDS: FieldTable = fieldTable({
	tableVersions: strings("semantics", "nonEmpty"),
});

const TRANSFER_PAIR_FIELDS: FieldTable = fieldTable({
	authorizationTransferId: at("semantics", "hex32"),
	settlementTransferId: at("semantics", "hex32"),
});

const PROJECTION_FIELDS: FieldTable = fieldTable({
	spec: at("schema", "literal"),
	scope: at("schema", "literal"),
	// §9-A.c requires a unique identifier minted at session open (nonce/ULID) and
	// pins no syntax; §2's decidable public-safety list names `proofId` and
	// `workloadId` and not this. Presence is therefore the whole rule.
	sessionId: at("schema", "nonEmpty"),
	generation: at("semantics", "integer"),
	prevGenerationEventHash: at("semantics", "hex64"),
	work: variants(WORK_FIELDS_BY_KIND),
	sessionAssociation: at("semantics", "enum"),
	workloadId: at("semantics", "opaqueHandle"),
	// Catalog MEMBERSHIP is not decidable from the receipt alone (§2); what is
	// decidable — sorted-unique, and entries that are well-formed at all — is
	// step 7's, beside the sort it shares a sentence with.
	models: strings("semantics", "nonEmpty"),
	providers: strings("semantics", "nonEmpty"),
	startedAt: at("schema", "rfc3339UtcMs"),
	endedAt: at("schema", "rfc3339UtcMs"),
	spend: subtree(SPEND_FIELDS),
	delegationPosture: at("semantics", "enum"),
	pricing: subtree(PRICING_FIELDS),
	transferSet: subtrees(TRANSFER_PAIR_FIELDS),
	transferSetRoot: at("semantics", "hex64"),
});

const MINTER_FIELDS: FieldTable = fieldTable({
	// The VALUE is bound at step 4 against the key's registered `minterKind`;
	// the snapshot decides the vocabulary, so there is nothing to pin here.
	kind: at("schema", "nonEmpty"),
	keyId: at("schema", "nonEmpty"),
	// §8's v1 pin (`usertrust.ai`) is step 4's — one condition, one code.
	trustDomain: at("signature", "literal"),
});

const SIGNATURE_FIELDS: FieldTable = fieldTable({
	alg: at("schema", "literal"),
	keyId: at("schema", "nonEmpty"),
	sig: at("schema", "canonicalBase64"),
});

const SIBLING_FIELDS: FieldTable = fieldTable({
	// The hole this table exists for. Unsigned by any statement of its own and
	// hex-decoded by the fold, so a lenient decoder is the only thing standing
	// between `<64 hex>zz` and a verdict.
	hash: at("schema", "hex64"),
	// Compared STRICTLY against the topology derived from (leafIndex, treeSize)
	// in `verify.ts` — step 5 owns it, and the fold treats every non-"left"
	// value as "right", which is exactly why it is compared and not read.
	position: at("inclusion", "enum"),
});

const INCLUSION_FIELDS: FieldTable = fieldTable({
	version: at("schema", "literal"),
	// Equality 1 pins these to `event.hash`, which step 2 RECOMPUTES — a
	// stronger statement than the digest shape, and the equality's to report.
	leafHash: at("event", "hex64"),
	leafIndex: at("event", "integer"),
	treeSize: at("event", "integer"),
	root: at("event", "hex64"),
	siblings: subtrees(SIBLING_FIELDS),
	segmentId: at("schema", "nonEmpty"),
});

const CHECKPOINT_FIELDS: FieldTable = fieldTable({
	v: at("checkpoint", "literal"),
	vaultId: at("checkpoint", "nonEmpty"),
	profile: at("checkpoint", "nonEmpty"),
	root: at("checkpoint", "hex64"),
	treeSize: at("checkpoint", "integer"),
	segmentId: at("checkpoint", "nonEmpty"),
	segmentFirstSequence: at("checkpoint", "integer"),
	// §4a: the lineage edge, or the fixed genesis string for the first segment.
	previousSegmentRoot: at("checkpoint", "hex64OrGenesis"),
	previousSegmentId: at("checkpoint", "nonEmpty"),
	keyId: at("checkpoint", "nonEmpty"),
	publishedAt: at("checkpoint", "rfc3339UtcMs"),
	sig: at("checkpoint", "canonicalBase64"),
});

const PROOF_FIELDS: FieldTable = fieldTable({
	// Equality 8 selects §4a's equality set from this literal and cross-checks
	// it against the registered chain — step 2's, by name.
	profile: at("event", "literal"),
	chain: at("schema", "nonEmpty"),
	mintEventHash: at("event", "hex64"),
	inclusion: subtree(INCLUSION_FIELDS),
	checkpoint: subtree(CHECKPOINT_FIELDS),
});

const EVENT_FIELDS: FieldTable = fieldTable({
	id: at("schema", "nonEmpty"),
	timestamp: at("schema", "rfc3339UtcMs"),
	// The previous event's `hash`, which is `sha256(canonicalize(event − hash))`
	// — the same digest domain, including the all-zero genesis sentinel.
	previousHash: at("schema", "hex64"),
	kind: at("event", "literal"),
	actor: { kind: "opaqueValue", owner: "event" },
	data: subtree(PROJECTION_FIELDS),
	sequence: at("schema", "integer"),
	hash: at("event", "hex64"),
});

const RECEIPT_FIELDS: FieldTable = fieldTable({
	spec: at("schema", "literal"),
	receiptId: at("schema", "receiptId"),
	scope: at("schema", "literal"),
	mintedAt: at("schema", "rfc3339UtcMs"),
	minter: subtree(MINTER_FIELDS),
	// The §5 mirror. Equality 9 makes it canonically identical to the
	// projection's `work`, and the same table validates both.
	work: variants(WORK_FIELDS_BY_KIND),
	event: subtree(EVENT_FIELDS),
	proof: subtree(PROOF_FIELDS),
	signature: subtree(SIGNATURE_FIELDS),
});

function keysOf(table: FieldTable): KeySet {
	return new Set(Object.keys(table));
}

const CHECKPOINT_KEYS: KeySet = keysOf(CHECKPOINT_FIELDS);

// ─────────────────────────────────────────────────────────────────────────────
// THE POLICY REGISTRY — every structure this verifier reads, and the declared
// integers in it, in ONE place.
//
// Enumerated here rather than beside each reader, because "fixed where it was
// found" is the defect this block exists to end. A reader that decides its own
// numeric policy decides it from the document in front of it; a registry has to
// answer for every structure at once, including the ones nobody attacked yet.
//
// `packages/verify` also reads FOUR structures that are not in this registry —
// the anchors JSONL, the audit-log segment line, the Rekor receipt, and the
// `--bundle` transport. Every one of them lives in a file the parity contract
// MIRRORS into `packages/core` (AGENTS.md, "Mirrored files"), so the rule cannot
// be added on this side alone without splitting the two implementations against
// each other — which §13 already names as worse than a shared bug. They are
// recorded, with their exposure, in `tests/receipt/numeric-policy.test.ts`'s
// registry so that the next reader inherits the enumeration instead of
// rediscovering it. That test FAILS if a parse site appears in either world
// without an entry.
// ─────────────────────────────────────────────────────────────────────────────

/** A position within a structure: a member name, or "every array element". */
export const ELEMENT: unique symbol = Symbol.for("usertrust.numericPolicy.element");
export type PolicyStep = string | typeof ELEMENT;

/**
 * The RECEIPT document. Frozen WHOLE, and that is the accurate policy rather
 * than a conservative one: §2 declares no fractional domain anywhere in a ut1
 * document, and §5 refuses unknown fields, so the schema admits no position at
 * which a fraction could ever be legitimate.
 */
export const RECEIPT_NUMERIC_POLICY: NumericPolicy = FROZEN_SUBTREE;

/**
 * §4a's v2 checkpoint statement. Also frozen whole, for the same reason and on
 * the same authority: `checkpointStatementShape` refuses ANY member outside
 * `CHECKPOINT_KEYS`, so the member set is CLOSED and every number under it is
 * declared — `v`, `treeSize`, `segmentFirstSequence`, and nothing else can
 * exist. `v` matters as much as the other two: it is `!==`-compared against the
 * literal `2`, so `2.0000000000000001` rounds into the version gate and is then
 * re-canonicalized as `2` for the signature.
 */
export const CHECKPOINT_NUMERIC_POLICY: NumericPolicy = FROZEN_SUBTREE;

/**
 * Every position the FIELD TABLE declares as a number, as structured paths.
 *
 * This is the exhaustiveness ORACLE, and it is derived from the same table that
 * already declares the schema — one source, so a new `at(owner, "integer")`
 * cannot enter the receipt or the checkpoint without appearing here. The test
 * asserts the live policy covers every position this returns; a declared
 * integer that no policy reaches fails the build rather than waiting for a
 * tenth review round to notice it.
 *
 * `literal` counts as numeric. A literal is a FIXED value, so a fraction is
 * illegal at that position whatever its type; for the string literals it is
 * inert, because the scanner never meets a number there.
 */
function declaredNumericPositions(table: FieldTable): PolicyStep[][] {
	const found: PolicyStep[][] = [];
	const walk = (current: FieldTable, prefix: PolicyStep[]): void => {
		for (const [key, rule] of Object.entries(current)) {
			const here: PolicyStep[] = [...prefix, key];
			if (rule.kind === "scalar") {
				if (rule.format === "integer" || rule.format === "literal") found.push(here);
			} else if (rule.kind === "object") {
				walk(rule.table, here);
			} else if (rule.kind === "objectArray") {
				walk(rule.table, [...here, ELEMENT]);
			} else if (rule.kind === "union") {
				for (const variant of rule.tables.values()) walk(variant, here);
			}
		}
	};
	walk(table, []);
	return found;
}

export const RECEIPT_DECLARED_NUMERIC_POSITIONS: readonly (readonly PolicyStep[])[] =
	declaredNumericPositions(RECEIPT_FIELDS);
export const CHECKPOINT_DECLARED_NUMERIC_POSITIONS: readonly (readonly PolicyStep[])[] =
	declaredNumericPositions(CHECKPOINT_FIELDS);

/** Does `policy` freeze the literal at `position`? The coverage oracle's other half. */
export function numericPolicyCovers(
	policy: NumericPolicy | undefined,
	position: readonly PolicyStep[],
): boolean {
	let node = policy;
	for (const step of position) {
		node = step === ELEMENT ? elementPolicy(node) : memberPolicy(node, step);
	}
	return node?.frozen === true || node?.integer === true;
}

/**
 * The §8 snapshot's declared integers, derived from the PARSED SHAPE.
 *
 * The snapshot has no field table — its loader reads members ad hoc — so the
 * declaration that already exists is the interface itself. `DeclaredIntegers<T>`
 * maps every `number`-typed member of `T` to a REQUIRED policy entry, so adding
 * `retiredAtSequence: number` to `TrustKey` and not declaring it here is a
 * COMPILE error. That is the only kind of enumeration that cannot go stale: a
 * hand-maintained list is correct the day it is written, and this one is checked
 * by `tsc` on every build.
 *
 * `[NonNullable<T[K]>] extends [number]` and not `number extends T[K]`: the
 * tuple wrapper stops the check distributing over unions, so `mintActor:
 * JsonValue` — which merely INCLUDES `number` — is correctly excluded. §4a
 * compares `mintActor` whole as canonical bytes and never plucks a field out of
 * it, so it declares no integer position at all.
 */
type NumberTypedKeys<T> = {
	[K in keyof T]-?: [NonNullable<T[K]>] extends [number] ? K : never;
}[keyof T];
type DeclaredIntegers<T> = { readonly [K in NumberTypedKeys<T>]-?: NumericPolicy };

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

// ─────────────────────────────────────────────────────────────────────────────
// The format predicates. Each is the spec's sentence, made decidable.
// ─────────────────────────────────────────────────────────────────────────────

const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/;
const LOWERCASE_HEX_40 = /^[0-9a-f]{40}$/;
const LOWERCASE_HEX_32 = /^[0-9a-f]{32}$/;
const OPAQUE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const RFC3339_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL_BODY = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * §2's RFC 3339 UTC "Z", millisecond precision — and a REAL instant.
 *
 * The regex alone accepts `2026-02-30T00:00:00.000Z`, a date that does not
 * exist; `Date` accepts it too and silently rolls it to March 2nd. So the
 * round-trip is the test: `toISOString()` emits exactly this grammar, and a
 * string that survives it is both well-formed AND the instant it names. A
 * rolled-over date fails because the round trip returns a different string.
 *
 * (Consequence, stated rather than discovered later: a leap second — RFC 3339's
 * `23:59:60` — is refused. No JS minter can emit one through `toISOString`, and
 * accepting a value this verifier cannot map to an instant would be the very
 * thing §7 names.)
 */
function isRfc3339UtcMs(value: string): boolean {
	if (!RFC3339_UTC_MS.test(value)) return false;
	const parsed = new Date(value);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * `"<prefix>" + base64url(HMAC-SHA-256(…))` — the resolver's keyed forms
 * (`r1_` for an undisclosed repo, `c1_` for a private content commitment).
 *
 * The MAC is 32 bytes, which is the whole check: the padded and unpadded
 * spellings of base64url both decode to it, and `isCanonicalBase64` refuses a
 * final sextet whose unused bits are non-zero — the alternative encoding that
 * would otherwise let two strings name one commitment.
 */
function isKeyedMac(value: string, prefix: string): boolean {
	if (!value.startsWith(prefix)) return false;
	const body = value.slice(prefix.length);
	if (!BASE64URL_BODY.test(body)) return false;
	const standard = body.replaceAll("-", "+").replaceAll("_", "/");
	const remainder = standard.length % 4;
	const padded = remainder === 0 ? standard : standard + "=".repeat(4 - remainder);
	if (!isCanonicalBase64(padded)) return false;
	return Buffer.from(padded, "base64").length === 32;
}

/**
 * One member against one declared format. `parent` is passed because exactly
 * one format is context-dependent: §2's `oid` is the FULL object ID under the
 * repository's own `oidAlg`, so its LENGTH is decided by a sibling member.
 *
 * `literal`, `enum` and `canonicalBytes` return `null` here by design — the
 * step that knows the vocabulary reports those, and this pass has no verdict of
 * its own to give them.
 *
 * The switch is TOTAL over `FormatName`, including formats that only a
 * `semantics`-owned member declares today (`hex32`, `opaqueHandle`,
 * `providerRepoUrl` — §2 assigns those three to step 7 by name, and step 7
 * checks them with these same predicates). Writing them out is not dead code
 * to be pruned: it is what makes moving a member between owners a one-word
 * edit instead of a silent fall-through to `nonEmpty`, which is the failure
 * mode this whole table exists to prevent.
 */
function formatViolation(
	path: string,
	value: JsonValue,
	format: FormatName,
	parent: JsonObject,
): string | null {
	const refuse = (): string => `${path} is not ${FORMAT_DESCRIPTIONS[format]}`;
	switch (format) {
		case "literal":
		case "enum":
		case "canonicalBytes":
			return null;
		case "integer":
			// The frozen numeric reader has already refused `-0`, fractions and
			// unsafe integers anywhere in the document, so the TYPE is what is left.
			return typeof value === "number" ? null : refuse();
		default:
			break;
	}
	if (typeof value !== "string") return refuse();
	switch (format) {
		case "hex64":
			return LOWERCASE_HEX_64.test(value) ? null : refuse();
		case "hex64OrGenesis":
			return value === GENESIS_SENTINEL || LOWERCASE_HEX_64.test(value) ? null : refuse();
		case "hex32":
			return LOWERCASE_HEX_32.test(value) ? null : refuse();
		case "gitOid": {
			// sha1 ⇒ 40, sha256 ⇒ 64. An `oidAlg` that is neither is step 7's enum
			// failure, not this pass's — refusing it here would report the wrong
			// condition under the wrong code.
			const alg = parent.oidAlg;
			if (alg === "sha1") return LOWERCASE_HEX_40.test(value) ? null : refuse();
			if (alg === "sha256") return LOWERCASE_HEX_64.test(value) ? null : refuse();
			return null;
		}
		case "rfc3339UtcMs":
			return isRfc3339UtcMs(value) ? null : refuse();
		case "receiptId":
			return isCanonicalReceiptId(value) ? null : refuse();
		case "opaqueHandle":
			return OPAQUE_ID.test(value) ? null : refuse();
		case "keyedRepoId":
			// The plain arm is the provider's immutable ID, for which §2 pins no
			// grammar; the KEYED arm is a construction, and a string that announces
			// itself with `r1_` and is not one is a scope identifier that names
			// nothing.
			return !value.startsWith("r1_") || isKeyedMac(value, "r1_") ? null : refuse();
		case "keyedContentCommitment":
			return isKeyedMac(value, "c1_") ? null : refuse();
		case "providerRepoUrl":
			return isCanonicalProviderRepo(value) ? null : refuse();
		case "canonicalBase64":
			return isCanonicalBase64(value) ? null : refuse();
		default:
			return value.length > 0 ? null : refuse();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The one traversal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called for every PRESENT member, with the rule the table declares for it —
 * `undefined` when the table declares none, which is the unknown-field case.
 * Returning a string stops the walk and becomes the refusal.
 *
 * Absent members are not visited, deliberately: presence RULES (`workloadId`
 * iff `workflowAttested`, `transferSet` iff `transferCount ≤ 32`, the required
 * members of §5) belong to the steps that own their codes, and a format pass
 * that also decided presence would pre-empt every one of them.
 */
type FieldVisitor = (
	parent: JsonObject,
	path: string,
	value: JsonValue,
	rule: FieldRule | undefined,
) => string | null;

function walkFieldTable(
	value: JsonValue | undefined,
	table: FieldTable,
	path: string,
	visit: FieldVisitor,
): string | null {
	// Descending into a member whose value is not an object is SILENCE, not a
	// pass — the step that consumes it reports the type it wanted.
	if (!isJsonObject(value)) return null;

	// Unrecognized members of THIS level first, in document order, before
	// anything descends. A document's key order is whatever its writer chose
	// (canonical bytes sort them), so the walk cannot take its order from the
	// document and still name the same member twice running.
	//
	// `Object.hasOwn`, never `table[key] !== undefined`: the key comes from the
	// DOCUMENT, and an indexed read answers with the prototype. This loop asked
	// the wrong question and a member named `__proto__` (or `constructor`, or
	// `toString`) was declared by `Object.prototype` on the table's behalf —
	// then skipped by the declared loop below too, since `Object.keys(table)`
	// yields no inherited name. Checked by nobody, and VERIFIED_CHECKPOINT with
	// a mint signature over it. The tables are also null-prototype now (see
	// `fieldTable`), so this is belt and braces on purpose: the question is
	// right AND there is no wrong answer left to give.
	for (const key of Object.keys(value)) {
		if (Object.hasOwn(table, key)) continue;
		const reported = visit(value, join(path, key), value[key] as JsonValue, undefined);
		if (reported !== null) return reported;
	}

	// Then the declared members, in TABLE order — the file's own reading order,
	// so a refusal names the same member no matter how the bytes were written.
	for (const key of Object.keys(table)) {
		if (!Object.hasOwn(value, key)) continue;
		const child = value[key] as JsonValue;
		const childPath = join(path, key);
		const rule = table[key] as FieldRule;
		const reported = visit(value, childPath, child, rule);
		if (reported !== null) return reported;
		switch (rule.kind) {
			case "object": {
				const nested = walkFieldTable(child, rule.table, childPath, visit);
				if (nested !== null) return nested;
				break;
			}
			case "objectArray": {
				if (!Array.isArray(child)) break;
				for (let index = 0; index < child.length; index += 1) {
					const nested = walkFieldTable(
						child[index] as JsonValue,
						rule.table,
						`${childPath}.${index}`,
						visit,
					);
					if (nested !== null) return nested;
				}
				break;
			}
			case "union": {
				if (!isJsonObject(child) || typeof child.kind !== "string") break;
				const nestedTable = rule.tables.get(child.kind);
				if (nestedTable === undefined) break;
				const nested = walkFieldTable(child, nestedTable, childPath, visit);
				if (nested !== null) return nested;
				break;
			}
			default:
				break;
		}
	}
	return null;
}

/** Path of the first unknown field in the SIGNED receipt, or `null`. */
export function findUnknownReceiptField(receipt: JsonObject): string | null {
	return walkFieldTable(receipt, RECEIPT_FIELDS, "", (_parent, path, _value, rule) =>
		rule === undefined ? path : null,
	);
}

/** A visitor applying every format the given step OWNS, and no other. */
function formatVisitorFor(owner: FormatOwner): FieldVisitor {
	return (parent, path, value, rule) => {
		if (rule === undefined) return null;
		if (rule.kind === "scalar") {
			return rule.owner === owner ? formatViolation(path, value, rule.format, parent) : null;
		}
		if (rule.kind !== "stringArray" || rule.owner !== owner || !Array.isArray(value)) return null;
		for (let index = 0; index < value.length; index += 1) {
			const entry = formatViolation(
				`${path}.${index}`,
				value[index] as JsonValue,
				rule.format,
				parent,
			);
			if (entry !== null) return entry;
		}
		return null;
	};
}

const SCHEMA_FORMAT_VISITOR = formatVisitorFor("schema");
const CHECKPOINT_FORMAT_VISITOR = formatVisitorFor("checkpoint");

/**
 * The first member of the SIGNED receipt whose value is not the format §2/§5
 * declares for it — step 1's half of the table, the rest belonging to the steps
 * named in `owner`.
 */
export function findFormatViolation(receipt: JsonObject): string | null {
	return walkFieldTable(receipt, RECEIPT_FIELDS, "", SCHEMA_FORMAT_VISITOR);
}

export interface ReceiptFieldFormat {
	/**
	 * `event.data.startedAt`, `proof.inclusion.siblings[].hash`,
	 * `work[commit].oid`, `event.data.work[pr].contentBinding[publicSha256].sha256`
	 * — `[]` is every element of an array, `[name]` selects a union variant.
	 */
	readonly path: string;
	readonly format: FormatName;
	readonly owner: FormatOwner;
}

/**
 * The table, FLATTENED — the enumeration that makes this a closed class rather
 * than a sampled one.
 *
 * It exists because the failure mode here is silent: a member that no rule
 * covers looks exactly like a member whose rule passes, and the only way to
 * tell them apart is to list every member and say, one at a time, which rule
 * applies. The corpus drives its coverage test off this list, so a member added
 * to the schema without a format cannot be added at all (the type demands one),
 * and a member whose format the walk never reaches fails that test rather than
 * shipping as an unchecked field nobody remembers.
 */
export function receiptFieldFormats(): readonly ReceiptFieldFormat[] {
	const out: ReceiptFieldFormat[] = [];
	const flatten = (table: FieldTable, path: string): void => {
		for (const [key, rule] of Object.entries(table)) {
			const here = join(path, key);
			switch (rule.kind) {
				case "scalar":
					out.push({ path: here, format: rule.format, owner: rule.owner });
					break;
				case "stringArray":
					out.push({ path: `${here}[]`, format: rule.format, owner: rule.owner });
					break;
				case "opaqueValue":
					out.push({ path: here, format: "canonicalBytes", owner: rule.owner });
					break;
				case "object":
					flatten(rule.table, here);
					break;
				case "objectArray":
					flatten(rule.table, `${here}[]`);
					break;
				default:
					for (const [variant, table_] of rule.tables) flatten(table_, `${here}[${variant}]`);
					break;
			}
		}
	};
	flatten(RECEIPT_FIELDS, "");
	return out;
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

/**
 * Bytes → a JSON value, with fatal UTF-8, retained BOM and duplicate-key
 * rejection. Where `options.policy` declares an integer, §3 step 4 is applied
 * to the numeric LITERAL as well — and a literal that breaks it is a SCHEMA
 * refusal, not an unparseable one: the bytes did become a document, and what it
 * says is illegal (CLI spec §5's table, which is what picks the exit code).
 */
export function readStrictJson(
	bytes: Uint8Array,
	options: JsonScanOptions = {},
): ReadOutcome<JsonValue> {
	const text = decodeUtf8Strict(bytes);
	if (text === null) return unparseable("not valid UTF-8 (decoded fatally, BOM retained)");

	const scan = scanJsonForDuplicateKeys(text, options);
	if (!scan.ok) {
		if (scan.kind !== "numeric") return unparseable(scan.detail);
		// A numeric refusal is a statement ABOUT A DOCUMENT: FAILED/exit 1 says
		// "we read what these bytes say, and what they say is illegal". The
		// scanner reaches the illegal literal in ONE left-to-right pass, so it can
		// reach it in bytes that never became a document at all — `{"spec":1.5,`
		// refuses at the literal and never learns the rest is missing. Classifying
		// straight off that verdict reports FAILED for truncated bytes, where §5's
		// table says unreadable material is UNVERIFIABLE/exit 2.
		//
		// So SYNTAX is settled first — and by THE SAME SCANNER, re-run with the
		// numeric axis switched off, rather than by a second opinion.
		//
		// `JSON.parse` was that second opinion, and a second opinion is a proxy:
		// it is a WEAKER grammar than the one this verifier enforces. It accepts
		// duplicate keys, and nesting past `MAX_JSON_DEPTH`, which the scanner
		// refuses as syntax. So `{"x":1.5,"a":1,"a":2}` — where the one-pass
		// scanner stops at the literal before it ever reaches the duplicate —
		// parsed cleanly and was reported schema/FAILED/exit 1, while the same
		// duplicate keys ALONE are syntax/UNVERIFIABLE/exit 2. One construct,
		// two verdicts, decided by which defect happened to come first in the
		// byte order. A proxy that accepts more than the thing it stands in for
		// disagrees with it SOMEWHERE, always; the only fix that does not leave
		// another somewhere is to stop using a proxy.
		//
		// Same code path, same rules, ONE axis removed — so the two cannot drift,
		// because there are no longer two. Hand-adding duplicate-key and depth
		// checks to the oracle instead would rebuild the identical drift one
		// level down.
		//
		// It refuses ⇒ the bytes were never a document, whatever else is also
		// wrong with them; it passes ⇒ the numeric refusal stands, in full. The
		// rule itself is untouched: this decides which of two true things to
		// report, not whether to report. (A `numeric` verdict cannot come back
		// from this call — the only line that emits one is behind a policy node,
		// and there is no policy.)
		const syntaxOnly = scanJsonForDuplicateKeys(text, withoutNumericPolicy(options));
		if (!syntaxOnly.ok) return unparseable(syntaxOnly.detail);
		return schemaRefusal(scan.detail);
	}

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
	// The policy is where §3 step 4 is actually decided — on the literals, before
	// `JSON.parse` rounds them. The value-level sweep below stays as the second
	// fence: it is what holds if a future caller ever hands this function an
	// already-parsed document, and it costs one walk.
	const parsed = readStrictJson(bytes, { policy: RECEIPT_NUMERIC_POLICY });
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
	/**
	 * §8's rotation boundary. Present iff the key is `retired` OR is named as
	 * another key's `predecessorKeyId` — NOT `retired` alone.
	 *
	 * Meaningful ONLY through the lineage edge, as the predecessor's upper bound
	 * and its successor's lower bound; never a property of the key carrying it.
	 * So a `revoked` key no other key names as predecessor may carry a value that
	 * is explicitly ignored, and no verifier may derive anything from it.
	 */
	readonly activationSequence?: number;
	/**
	 * Ed25519 BY TYPE, not by the entry's `alg` label. Only the loader's
	 * `parseTrustPublicKey` produces one, so a step that reaches a key through
	 * this member has the material constraint already applied to it.
	 */
	readonly publicKey: Ed25519PublicKey;
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
	| {
			readonly ok: false;
			readonly sha256: string;
			/**
			 * R-OUT-1 again, on the arm where it is easy to drop: the report ALWAYS
			 * names the snapshot, and a refusal is when an operator most needs to
			 * know WHICH snapshot. `version` and `predecessor` are readable the
			 * moment the document parses — before any structural rule runs — so a
			 * refusal after that point carries them rather than reporting an
			 * anonymous file. Both stay `null` when the bytes never became a
			 * document: nothing was declared, so nothing is invented.
			 */
			readonly identity: TrustSnapshotIdentity;
			readonly detail: string;
	  };

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
 * A `KeyObject` whose MATERIAL has been checked to be Ed25519.
 *
 * The brand is the point. `verifyEd25519` calls `crypto.verify(null, …)`, and
 * `null` there means "infer the algorithm from the key" — so an RSA, ECDSA or
 * Ed448 key reaching that call verifies RSA, ECDSA or Ed448 signatures happily,
 * whatever the document CALLED the key. That is algorithm confusion: the
 * declared `alg` is trusted and the material is not constrained. A `KeyObject`
 * parameter cannot express the difference, so every future verify site would
 * have to remember the check — N copies of one fact, and a new site gets it
 * wrong by default. Only `parseTrustPublicKey` mints this type, so the
 * constraint is INHERITED instead: a site that has one of these has already had
 * its material checked, and a site holding a bare `KeyObject` does not compile.
 */
declare const ED25519_MATERIAL: unique symbol;
export type Ed25519PublicKey = KeyObject & { readonly [ED25519_MATERIAL]: true };

export type TrustKeyMaterial =
	| { readonly ok: true; readonly key: Ed25519PublicKey }
	/** Reads as the tail of "key <id> has a publicKey that …". */
	| { readonly ok: false; readonly reason: string };

/**
 * The length of the ONE DER value starting at byte 0, or `null` when the header
 * is not one — a truncated length, BER's indefinite form, or a non-minimal
 * length DER forbids.
 *
 * `createPublicKey` reads the leading SPKI value and IGNORES whatever follows
 * it, so `valid-SPKI-DER || extra bytes` loads as the same key the clean bytes
 * do. Two distinct byte strings then name one key: the snapshot verifies
 * receipts under material a strict DER verifier refuses outright, and the two
 * verifiers disagree about the same pinned bytes. §8 pins KEY MATERIAL, so the
 * encoding has to span the bytes it was decoded from.
 *
 * DIAGNOSTICS, NOT THE AUTHORITY. This reads the OUTER TLV, and the outer TLV
 * is one level of a nested structure: `30 2b 30 81 05 …` spells the INNER
 * AlgorithmIdentifier's length in the long form, spans its buffer exactly, and
 * walks straight through here — and `06 81 03 2b 65 70` does the same one level
 * deeper still, inside the OID. Reaching for an inner-length check next would
 * fix level 2 and leave level 3; there is no depth at which the enumeration
 * ends. The round-trip in `parseTrustPublicKey` is what actually decides, at
 * every depth at once. What this buys, and the only reason it is retained, is
 * that it can say HOW MANY bytes ran past the value — which a byte-inequality
 * cannot.
 */
function derValueLength(der: Uint8Array): number | null {
	// SubjectPublicKeyInfo is a SEQUENCE; nothing else is a key here.
	if (der.length < 2 || der[0] !== 0x30) return null;
	const lengthByte = der[1] as number;
	if (lengthByte < 0x80) return 2 + lengthByte;
	const count = lengthByte & 0x7f;
	// 0 is BER's indefinite form, which DER forbids; >4 is longer than any key.
	if (count === 0 || count > 4 || der.length < 2 + count) return null;
	let contentLength = 0;
	for (let i = 0; i < count; i += 1) contentLength = contentLength * 256 + (der[2 + i] as number);
	// DER's minimal-length rule, both halves: no leading zero byte, and no long
	// form carrying a length the short form could have. Either spelling would be
	// a second encoding of one key, which is the defect above wearing a hat.
	if (der[2] === 0 || contentLength < 0x80) return null;
	return 2 + count + contentLength;
}

/**
 * The DER inside a PEM SPKI block, or `null` when the string is not one.
 *
 * The PEM arm carries the SAME suffix defect as the base64 arm — Node accepts
 * `-----BEGIN PUBLIC KEY-----` around `valid-SPKI-DER ‖ junk`, wrapped or not,
 * and hands back the clean key. It was verified BY TEST that it does, after a
 * first probe wrongly said Node refused it (the probe's line-wrapper had
 * emitted a blank line, and the decoder was refusing THAT). So the bytes both
 * arms will be judged on are recovered here and both go through one gate,
 * rather than the base64 arm carrying a check the PEM arm is trusted to not
 * need.
 */
const PEM_PUBLIC_KEY = /^-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]*)-----END PUBLIC KEY-----\s*$/;

function spkiDerFromPem(pem: string): Buffer | null {
	const match = PEM_PUBLIC_KEY.exec(pem);
	if (match === null) return null;
	// Line breaks are the encoding's, not the value's; what remains must still be
	// canonical base64, for the reason the other arm checks it.
	return decodeCanonicalBase64((match[1] as string).replace(/\s+/g, ""));
}

/**
 * §4's last structural rule, and the ONE place a snapshot's key material
 * becomes usable. Encoding follows the in-repo convention `anchor-verify.ts`
 * already implements — PEM, or base64 SPKI DER — and the parser is REUSED
 * rather than reinvented. Canonical base64 is validated before the reused
 * helper sees the string, because `Buffer.from(x, "base64")` accepts junk that
 * decodes to the same bytes.
 *
 * Both remaining rules are bound HERE rather than at the verify sites, because
 * this is the choke point every key passes through exactly once:
 *
 *  - the bytes must be THE canonical DER encoding of the key they decode to, on
 *    EITHER encoding; and
 *  - the material must actually be Ed25519. ut1 permits nothing else — §5 pins
 *    the receipt signature's `alg` to the literal `ed25519` and §4a's
 *    checkpoint statements are signed the same way — and the label on the
 *    snapshot entry is a claim by the same document that supplies the key.
 *
 * The type check runs after BOTH arms for the same reason the round-trip does:
 * an arm-specific rule is a rule the other arm can be missing.
 *
 * THE ROUND-TRIP IS THE RULE, and it is stated as one comparison rather than as
 * a list of DER's encoding rules because a list has to be kept complete. Node
 * NORMALIZES on parse: whatever spelling goes in, `export` hands back the one
 * canonical encoding of the key that came out. So re-encoding and demanding
 * byte equality with the input refuses every non-canonical spelling — a
 * trailing suffix, a long-form length at the outer SEQUENCE, at the inner
 * AlgorithmIdentifier, inside the OID, in the BIT STRING, and any depth or form
 * neither this comment nor the reviewer who reads it has thought of. One check,
 * the whole class, and nothing to keep in sync with a spec.
 *
 * Verified rather than assumed, on both arms and at three depths, in
 * `reader.test.ts` — including the premise that Node really does accept each of
 * those spellings and hand back the clean key, without which the vectors would
 * be proving something else.
 */
function parseTrustPublicKey(encoded: string): TrustKeyMaterial {
	const isPem = encoded.startsWith("-----BEGIN ");
	const der = isPem ? spkiDerFromPem(encoded) : decodeCanonicalBase64(encoded);
	if (der === null) {
		return {
			ok: false,
			reason: isPem
				? "is not a PEM SPKI block whose body is canonical base64"
				: "is not canonical base64",
		};
	}
	// Diagnostics first, and only diagnostics: every refusal these two lines make
	// the round-trip below makes too. They run first so the common case keeps the
	// message that names the actual defect and counts the bytes.
	const spanned = derValueLength(der);
	if (spanned === null) return { ok: false, reason: "does not decode to one DER value" };
	if (spanned !== der.length) {
		return {
			ok: false,
			reason: `carries ${der.length - spanned} byte(s) past the end of its SPKI DER value`,
		};
	}
	const key = isPem ? publicKeyFromPem(encoded) : publicKeyFromSpkiBase64(encoded);
	if (key === null) return { ok: false, reason: "does not parse" };
	if (key.asymmetricKeyType !== "ed25519") {
		return {
			ok: false,
			reason: `is ${String(key.asymmetricKeyType)} material, and ut1 verifies Ed25519 only`,
		};
	}
	const canonicalDer = key.export({ type: "spki", format: "der" }) as Buffer;
	if (!canonicalDer.equals(der)) {
		return {
			ok: false,
			reason:
				`is not the canonical DER encoding of the key it decodes to — ${der.length} byte(s) in, ` +
				`${canonicalDer.length} byte(s) back out, and they differ. A second spelling of one key ` +
				"is a second key as far as an independent verifier is concerned",
		};
	}
	return { ok: true, key: key as Ed25519PublicKey };
}

function materialIdOf(key: KeyObject): string {
	const der = key.export({ type: "spki", format: "der" }) as Buffer;
	return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

/**
 * The §8 snapshot. Scoped, NOT frozen whole, and the distinction is the §4
 * forward-compatibility promise: the signing scheme is a live ship-gate item
 * that will add members, and one of them may one day legitimately carry a
 * fraction. What is declared is what this loader READS as a number —
 * `JSON.parse` rounds, so `18.000000000000001` reaches `safeNonNegativeInteger`
 * as exactly `18` and authorizes a key window the document never carried.
 *
 * The two entries below are type-checked against `TrustKey` and `TrustChain`,
 * so the enumeration is the shape's, not a maintainer's memory of it.
 */
const TRUST_KEY_INTEGERS: DeclaredIntegers<TrustKey> = {
	activationSequence: DECLARED_INTEGER,
};
const TRUST_CHAIN_INTEGERS: DeclaredIntegers<TrustChain> = {
	headSegmentFirstSequence: DECLARED_INTEGER,
};

export const SNAPSHOT_NUMERIC_POLICY: NumericPolicy = policyMembers({
	keys: policyElements(policyMembers(TRUST_KEY_INTEGERS)),
	chains: policyElements(policyMembers(TRUST_CHAIN_INTEGERS)),
});

/**
 * The resolver's §3 envelope. Not a ut1 document, and deliberately open at the
 * top level — an unknown member the resolver adds tomorrow may carry anything.
 * Two of its members are declared to BE structures this registry already
 * governs, and they inherit those structures' policies rather than restating
 * them:
 *
 *  - `receipt` — §3's convenience copy. It is not the byte authority, which is
 *    exactly why it needs this: R4 compares it STRUCTURALLY against the parsed
 *    receipt bytes, and a fractional literal in the copy rounds to the integer
 *    the bytes carry, so the two "agree", the receipt verifies from its own
 *    (frozen) bytes, and the run reports VERIFIED over an envelope whose copy
 *    is not the document that was signed. A consumer reading the copy — which
 *    is the only thing the copy is FOR — reads a value nobody signed.
 *  - `checkpointHistory` — §7 step 9's served history. Each member is a §4a v2
 *    statement whose signature is checked over `canonicalize(member)`, so a
 *    fractional `treeSize` re-serializes to the signed integer and the walk
 *    awards `VERIFIED_CHECKPOINT_HISTORY` for an unsigned mutation.
 *
 * `anchorEvidence` gets NO policy, and that is a real entry rather than an
 * omission: this build validates none of it (`unimplemented: ["anchorEvidence"]`
 * — no authority yet defines the binding), so it declares no integer here. The
 * day that check lands, its format joins this registry with it.
 */
export const ENVELOPE_NUMERIC_POLICY: NumericPolicy = policyMembers({
	receipt: RECEIPT_NUMERIC_POLICY,
	checkpointHistory: policyElements(CHECKPOINT_NUMERIC_POLICY),
});

export function loadTrustSnapshot(bytes: Uint8Array): TrustSnapshotLoad {
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	// Widened the instant the document parses, so every refusal after that point
	// carries the identity the document declared rather than an anonymous hash.
	let identity: TrustSnapshotIdentity = { sha256, version: null, predecessor: null };
	const fail = (detail: string): TrustSnapshotLoad => ({ ok: false, sha256, identity, detail });

	const parsed = readStrictJson(bytes, { policy: SNAPSHOT_NUMERIC_POLICY });
	if (!parsed.ok) {
		// A `schema` refusal is the NUMERIC one, and it is a document-level defect:
		// these bytes DID become a document, and R-OUT-1 ("the report always names
		// the snapshot") does not stop applying because one literal was illegal.
		// Null identity is reserved for bytes that never became a document at all,
		// so reporting null/null here would classify a numeric refusal as
		// unparseable in the one field an operator uses to tell the two apart.
		//
		// The identity is RECOVERED, never invented: the same reader, minus the one
		// rule that refused it, still has to produce a JSON object before anything
		// is read off it. Every other rule — UTF-8, the BOM, duplicate keys, the
		// grammar, the depth cap — has already passed, so this re-read cannot
		// succeed where the first failed for any reason but the numeric literal.
		if (parsed.refusal.kind === "schema") {
			const declared = readStrictJson(bytes);
			if (declared.ok && isJsonObject(declared.value)) {
				identity = snapshotIdentity(sha256, declared.value);
			}
		}
		return fail(parsed.refusal.detail);
	}
	if (!isJsonObject(parsed.value)) return fail("the trust snapshot is not a JSON object");
	const document = parsed.value;
	identity = snapshotIdentity(sha256, document);

	// The snapshot is not read by the frozen numeric reader WHOLESALE — §4
	// tolerates unknown members precisely so the open signing scheme can add
	// them, and only the declared integer members above are scanned — but the
	// NON-FINITE clause still has to bind over ALL of it, and this is the
	// document where it
	// bites: `mintActor` is canonicalized by equality 2, `1e999` PARSES to
	// Infinity, and `canonicalize` throws on it. Without this guard a snapshot
	// carrying one takes `verifyReceiptBase` out through an uncaught exception —
	// no verdict at all, and in the CLI an exit 1 (FAILED, "we checked and this
	// receipt is bad") for what §4 classifies as a structurally invalid snapshot
	// (UNVERIFIABLE, exit 2). Ambiguity → UNVERIFIABLE, never a throw.
	const nonFinite = findNonFiniteNumber(document);
	if (nonFinite !== null) {
		const where = nonFinite.path === "" ? "the document root" : nonFinite.path;
		return fail(`${describeNumberViolation(nonFinite.value)} at ${where}`);
	}

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
		// A key type §8's ut1 profile does not permit makes the SNAPSHOT
		// malformed, not the receipt wrong — so it refuses here, with every other
		// structural violation, as UNVERIFIABLE. `fail` carries the reason, which
		// is the difference between "this snapshot is unusable" and knowing why.
		const material = parseTrustPublicKey(encoded);
		if (!material.ok) return fail(`key ${keyId} has a publicKey that ${material.reason}`);
		const publicKey = material.key;

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

	// §8's keyId is an IDENTITY, not a label — one material, one ID.
	//
	// The role clause is §8's own ("mint and checkpoint entries sharing key
	// material collapse the very separation the two signatures rely on") and
	// keeps its specific message, because an operator acts on which separation
	// broke. The general clause behind it is the one a review round found
	// missing, and it subsumes the first: EVERY rule this loader has — role,
	// state, `activationSequence`, lineage membership, and the
	// one-lineage-one-vault ownership below — is keyed by `keyId`, so two IDs
	// over one signing capability let the document give every one of those rules
	// two different answers about the same key. §8 resolves ambiguity as
	// UNVERIFIABLE, never as a pass.
	//
	// Two instances, both live before this line:
	//
	//  · REVOCATION EVADED. Revoke `utk_mint_A` and re-register its material as
	//    `utk_mint_B`/`active`, and a receipt naming B verifies under the
	//    revoked key's own crypto. The state rules are per-ENTRY and could not
	//    see it.
	//  · ONE LINEAGE, TWO VAULTS. `lineageOwner` below compares keyIds, so the
	//    identical checkpoint SPKI registered under a second ID produced two
	//    DISJOINT lineages over one capability and walked past the rule §8 wrote
	//    for exactly this ("a lineage trusted by two vaults makes the document
	//    invalid" — `proof.chain` is receipt-signed only and could not settle
	//    which vault a statement belonged to). With material unique, keyId and
	//    capability are in bijection and the ID-keyed check below is sound
	//    again.
	const materialOwner = new Map<string, TrustKey>();
	for (const key of keys.values()) {
		const seen = materialOwner.get(key.materialId);
		if (seen !== undefined) {
			if (seen.role !== key.role) {
				return fail(`key ${key.keyId} shares key material across the mint/checkpoint roles`);
			}
			return fail(
				`keys ${seen.keyId} and ${key.keyId} register the same key material — §8 makes a keyId an identity, and two names for one key give every ID-keyed rule two answers`,
			);
		}
		materialOwner.set(key.materialId, key);
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
		// §8 RULES ut1 to `genesisChoice: "newVault"` (Cam, 2026-08-12), against
		// evidence: segment rotation has never run in production, so there are
		// ZERO finalized segments and `"backfill"` would have re-issued v2
		// statements over nothing. On a `proxy-v1` chain the member is therefore
		// not a two-valued union — one value is admissible and absent is not it.
		//
		// This is the last SNAPSHOT-ONLY constraint in §8, and snapshot-only is
		// exactly why it has to be here. No receipt field disagrees with
		// `genesisChoice`, so no §7 equality reaches it, and step 9's walk roots
		// the served history at the registered `genesisSegmentId` whatever the
		// snapshot claims produced it — an internally perfect fabricated history
		// satisfies every clause the walk has and takes the receipt to
		// VERIFIED_CHECKPOINT_HISTORY. Where the constraint IS receipt-relative
		// (`profile` at equality 8, `mintActor` at equality 2, `minterKind` at
		// step 4) the spec puts the refusal at that step and calls it FAIL; here
		// there is no such step, and §8's own resolution for a document it does
		// not admit is UNVERIFIABLE.
		//
		// Conditioned on the profile because the RULING is scoped to ut1: a future
		// ut-chain profile ships under a different literal (§4a) and its genesis
		// story is not this one's, so a snapshot registering one alongside ut1
		// must not be refused wholesale. There is no evasion in that — a receipt
		// only reaches the walk through equality 8, which pins
		// `chain.profile === proof.profile === UT1_PROFILE`.
		if (profile === UT1_PROFILE && genesisChoice !== UT1_GENESIS_CHOICE) {
			return fail(
				`chain ${vaultId} is a ${UT1_PROFILE} chain whose genesisChoice is ${JSON.stringify(genesisChoice ?? null)} — §8 RULES ut1 to ${JSON.stringify(UT1_GENESIS_CHOICE)}`,
			);
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

	return { ok: true, sha256, snapshot: { identity, keys, chains } };
}

/**
 * The snapshot's self-declared identity, read straight off a parsed document.
 *
 * Factored out because BOTH arms of `TrustSnapshotLoad` need it and only one of
 * them used to have it: R-OUT-1 says the report always names the snapshot, and
 * a run refused by a structural rule is not exempt — the two facts were already
 * in hand when the rule fired.
 */
function snapshotIdentity(sha256: string, document: JsonObject): TrustSnapshotIdentity {
	return {
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

	// §8's retirement boundary, from the side the loader could not see.
	//
	// The loader already refuses an `activationSequence` on an `active` key
	// ("an active key has no upper bound … it has no successor yet") and refuses
	// a `retired` key without one. Both read ONE entry. This is the same rule
	// read across the LINK: a key that a successor names as its predecessor DOES
	// have a successor, so `active` is a contradiction — and a contradiction that
	// pays. `keyStatePermits` gives an `active` key no upper bound at all, so a
	// rotated-away key whose entry was never moved off `active` keeps signing
	// new material forever, in a snapshot that looks like a clean rotation and
	// puts both keys in the pinned lineage. That is precisely the attack
	// rotation exists to bound, arriving through the one door the per-entry
	// rules left open.
	//
	// `retired` is the ordinary end state (its `activationSequence` is then
	// required, so the boundary is evaluable) and `revoked` is the compromise
	// path; both are legal predecessors. Only `active` is not.
	//
	// Checked AFTER the walks above so a snapshot that is BOTH cyclic and
	// active-predecessor is still reported as cyclic: the cycle is the deeper
	// defect and the corpus vector for it must keep isolating its own clause.
	for (const [predecessorKeyId, successorKeyId] of successorOf) {
		const predecessor = keys.get(predecessorKeyId) as TrustKey;
		if (predecessor.state === "active") {
			return `key ${predecessorKeyId} is active but ${successorKeyId} names it as predecessor — a rotated-away key has no activation boundary while it stays active`;
		}
	}

	// The same rule one step further: a predecessor carrying NO boundary at all.
	//
	// The per-entry rules require `activationSequence` on a `retired` key and
	// forbid it on an `active` one, and the loop above refuses an `active`
	// predecessor — which leaves `revoked`, whose boundary the per-entry rules
	// make OPTIONAL because §8 says a revoked key verifies nothing "bounded or
	// not". Read across the LINK, that optionality does not survive: the number
	// is not only the predecessor's upper bound, it is the SUCCESSOR's lower
	// bound, and the successor is very much alive. Without it, "did this
	// successor sign material from before it activated?" is a question §8
	// requires the verifier to ask and leaves it unable to answer.
	//
	// It is refused HERE, at load, rather than at the point of use, and the
	// distinction is the VERDICT CLASS. Nothing is wrong with a receipt whose
	// successor key is in good standing; what is incomplete is the trust
	// DATA — a property of the SNAPSHOT, true of every receipt it will ever be
	// asked about, and §8's own resolution for a document it cannot admit is
	// UNVERIFIABLE. Failing at use time instead reports SIG_INVALID /
	// CHECKPOINT_INVALID — "we checked, and this receipt is bad" — for a
	// comparison the verifier never actually made. That is the same
	// receipt-relative vs snapshot-only split `genesisChoice` and the backward
	// boundary above are on this side of.
	for (const [predecessorKeyId, successorKeyId] of successorOf) {
		const predecessor = keys.get(predecessorKeyId) as TrustKey;
		if (predecessor.activationSequence === undefined) {
			return `key ${predecessorKeyId} is named as predecessor by ${successorKeyId} but carries no activationSequence — ${successorKeyId}'s lower bound is unevaluable, and an unanswerable question is UNVERIFIABLE`;
		}
	}

	// §8's boundary has an ORDER, and the per-entry rules cannot see it.
	//
	// The boundary "is set at the moment its successor activates, and equals the
	// successor's first sealed segment's `segmentFirstSequence`", and §4a makes
	// `segmentFirstSequence` strictly increasing over sealed segments. So along
	// `key0 → key1 → key2`, key0's boundary is key1's first segment and key1's is
	// key2's — a later segment. The boundaries only ever move FORWARD.
	//
	// Inverted, they hand the OLDEST key in the lineage the WIDEST window:
	// `keyStatePermits` reads one entry, so a checkpoint signed long after a key
	// was rotated away verifies under it, in a document that otherwise looks like
	// a clean rotation. That is the same defect shape the active-predecessor rule
	// above closes, one level up — and, like it, nothing downstream can catch it,
	// because no receipt field disagrees with a snapshot's own boundary set.
	//
	// EQUAL is admitted deliberately. A successor that seals no segment before
	// rotating again has no "first sealed segment" of its own, and the honest
	// encoding is then its predecessor's own boundary; refusing that would reject
	// conformant trust material to catch nothing. Only backwards is refused.
	//
	// The walk to the nearest ancestor that HAS a boundary is retained even
	// though the rule above now guarantees the FIRST one does: it states the
	// comparison transitively, which is what makes it independent of how the
	// boundary's presence happens to be enforced today. Treating an absent
	// boundary as zero, rather than walking past it, would be the bug — it
	// invents an ordering claim the document never made.
	//
	// THE INERT CELL IS NOT ORDERED, because ordering it is READING it. §8:
	// `activationSequence` "is meaningful ONLY through the lineage edge — as the
	// predecessor's upper bound and its successor's lower bound … NEVER a
	// property of the key that carries it, standing alone", so a `revoked` key
	// that nothing names as its predecessor carries a number that is EXPLICITLY
	// IGNORED and from which "no verifier may derive anything". Comparing it with
	// an ancestor derives something: it turns a conformant lineage — retired at
	// 18, rotated to a key later revoked, whose own boundary sits at 11 and whose
	// successor was never registered here — into UNVERIFIABLE. A false refusal on
	// trust material, which is the direction a corpus of hostile vectors cannot
	// see.
	//
	// It grants an attacker nothing because the cell governs no acceptance
	// decision in either direction. Outgoing: no key names it, so the number is
	// nobody's lower bound. Incoming: `keyStatePermits` refuses a `revoked` key
	// before it reads any boundary at all — revocation is a floor, not a window,
	// so the key verifies nothing whatever the number says.
	//
	// Scoped to exactly that cell, in BOTH of its conditions, because either one
	// alone is a hole:
	//  · a `retired` tail keeps the check. §8 admits a retired key "whose
	//    successor is not registered in THIS snapshot", and `keyStatePermits`
	//    reads its boundary as that key's own upper bound — the edge is not what
	//    makes a retired key's number matter.
	//  · a `revoked` key that IS named keeps it. The number is then its
	//    successor's lower bound, and that successor may be `active`.
	// The ANCESTOR arm below needs no such guard and must not grow one: being
	// walked to as an ancestor means some key named it, which is the edge — so an
	// inert boundary is unreachable there, and a skip written for it would be
	// fail-open code no test could ever reach.
	for (const key of keys.values()) {
		const boundary = key.activationSequence;
		if (boundary === undefined) continue;
		if (key.state === "revoked" && !successorOf.has(key.keyId)) continue;
		let cursor = key.predecessorKeyId;
		while (cursor !== undefined) {
			const ancestor = keys.get(cursor) as TrustKey;
			if (ancestor.activationSequence !== undefined) {
				if (ancestor.activationSequence > boundary) {
					return `key ${ancestor.keyId} precedes ${key.keyId} in one lineage but its activationSequence ${ancestor.activationSequence} is past ${key.keyId}'s ${boundary} — a retirement boundary never moves backwards`;
				}
				break;
			}
			cursor = ancestor.predecessorKeyId;
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
/**
 * §8's ruling, not a default: ut1's genesis IS the v2 cutover, because rotation
 * never ran and `"backfill"` would have backfilled nothing. The union's other
 * member stays in the vocabulary for a profile that is not this one.
 */
export const UT1_GENESIS_CHOICE = "newVault";
export const UT1_MINT_EVENT_KIND = "receipt_settled";
export const UT1_TRUST_DOMAIN = "usertrust.ai";
export const UT1_SPEC = "ut1";
export const UT1_SCOPE = "session";
/** §4a/§8: ut1 v1 has no SDK mint keys at all, so this is a LITERAL. */
export const UT1_MINTER_KIND = "proxy";

/**
 * §4a's proxy-v1 mint actor, EXACTLY — three members, these values, nothing
 * else.
 *
 * AGREEMENT IS NOT CONFORMANCE. Equality 2 compares `event.actor` against the
 * chain's registered `mintActor`, and until now that comparison was the whole
 * rule. But both documents are inputs here: a receipt carrying
 * `actor: "receipt-minter"`, or `null`, or the closed form plus a `tenant`
 * member, verified whenever the pinned chain's `mintActor` was malformed the
 * same way — and two inputs agreeing proves only that one party wrote both.
 * Where the spec fixes a literal, the literal is checked against the SPEC
 * first; the agreement is then a second, independent fence, not the only one.
 */
export const UT1_MINT_ACTOR: Readonly<Record<string, string>> = {
	type: "system",
	id: "receipt-minter",
	name: "receipt-minter",
};

/** `event.actor` is §4a's closed form — the member SET as well as the values. */
function isUt1MintActor(value: JsonValue | undefined): value is JsonObject {
	if (!isJsonObject(value)) return false;
	// The member set is closed, so a count plus per-member presence is the whole
	// comparison — and `Object.hasOwn`, never an indexed read, because the
	// document chooses these keys (see `walkFieldTable`'s own note).
	if (Object.keys(value).length !== Object.keys(UT1_MINT_ACTOR).length) return false;
	for (const [member, literal] of Object.entries(UT1_MINT_ACTOR)) {
		if (!Object.hasOwn(value, member) || value[member] !== literal) return false;
	}
	return true;
}

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

const TRAILER_KEY = "Usertrust-Receipt:";
const RESOLUTION_URL_PREFIX = "https://usertrust.ai/r/";

/** §12 form 2 — the resolution URL, whole. The origin and path are part of
 * the production, so a foreign origin or a bare `http` scheme is not a
 * shorter spelling of it, it is a different string. */
function receiptIdFromResolutionUrl(url: string): string | null {
	if (!url.startsWith(RESOLUTION_URL_PREFIX)) return null;
	const id = url.slice(RESOLUTION_URL_PREFIX.length);
	return isCanonicalReceiptId(id) ? id : null;
}

/**
 * The ID a receipt ARRIVED under, extracted from `--expect-id` (CLI spec §2).
 *
 * THREE forms, parsed SEPARATELY and each one WHOLE — a bare `ut1_…`, a
 * resolution URL, and a §12 trailer line. They are not one form with two
 * optional prefixes, and treating them that way is what made
 * `Usertrust-Receipt: ut1_…` pass: strip the key, and what is left is a valid
 * bare id. §12's trailer grammar is a single production —
 * `"Usertrust-Receipt: https://usertrust.ai/r/" "ut1_" 16*22base58char` —
 * whose VALUE is "the full https URL", so a trailer carrying anything else is
 * not a trailer, and no artifact in the world carries the line we were
 * accepting. Passing step 3(a) on it would report that the receipt is bound to
 * the artifact that cited it, on the strength of a string an artifact could
 * never contain — the one check that makes the binding is the one check that
 * must not be satisfiable by a form nothing emits.
 *
 * §12's lexical rules are enforced rather than paraphrased: the key is
 * case-SENSITIVE, followed by exactly one `:` and exactly one space, the value
 * runs to end-of-line, and there is no folding, no trailing whitespace and no
 * inline comment. A URL that merely APPEARS inside prose is not a trailer, so
 * this never searches — it matches from the start of the (single) line.
 *
 * `null` means the context is not a §12 form. That is a USAGE error for the
 * caller to report (exit 3), never a silent `notApplicable` and never a pass:
 * an unparseable `--expect-id` that quietly disabled step 3(a) would answer a
 * question the operator did not ask.
 */
export function receiptIdFromArrivalContext(context: string): string | null {
	let text = context;
	// "line endings may be LF or CRLF and the CR is not part of the value" — and
	// those are the only two the format admits, so the CR comes off ONLY as half
	// of a CRLF. Stripping `\n` and then `\r` as two independent slices also
	// trimmed a LONE trailing CR, which is an old-Mac terminator the receipt
	// format does not admit: the context then parsed as a clean bare id and
	// passed step 3(a), the one check that binds a receipt to the artifact that
	// cited it. A terminator the spec does not define is a usage error, not a
	// value to be repaired — so the lone CR falls through to the rejection below.
	if (text.endsWith("\r\n")) text = text.slice(0, -2);
	else if (text.endsWith("\n")) text = text.slice(0, -1);
	if (text.includes("\n") || text.includes("\r")) return null;

	// Form 3 — the trailer line. Once the key matches, this IS the trailer
	// production: it either satisfies §12 in full or it is malformed. It never
	// falls back to another form.
	if (text.startsWith(TRAILER_KEY)) {
		const value = text.slice(TRAILER_KEY.length);
		// "exactly one `:` then exactly one space" — a second space belongs to
		// the value, where §12's grammar has no room for it.
		if (!value.startsWith(" ")) return null;
		return receiptIdFromResolutionUrl(value.slice(1));
	}
	// Form 2 — the resolution URL, likewise committed to once its origin
	// matches, so a malformed one never re-reads as a bare id.
	if (text.startsWith(RESOLUTION_URL_PREFIX)) return receiptIdFromResolutionUrl(text);
	// Form 1 — the bare id.
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
	/** Step 9's OPTIONAL material, from the resolver envelope. Absent ⇒ the
	 * extension checks have no input, which is `notApplicable`, not a failure. */
	readonly extensions?: ReceiptExtensionMaterial;
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

/**
 * A REQUIRED string member. Empty is absent.
 *
 * `typeof value === "string"` alone answers yes to `""`, and every member read
 * through here is an identity or a digest: a `sessionId`, a `mintedAt`, a
 * `work.repoId`, a checkpoint's `vaultId`. A signed receipt can carry all of
 * them blank — the harness mints one, the preimage covers the blanks, both
 * signatures verify — and a verifier that accepts present-and-blank reports
 * VERIFIED for a document that identifies nothing. The one non-empty helper
 * the snapshot loader already uses (`nonEmptyString`) makes the same call for
 * the same reason; this is that rule, applied to the receipt.
 */
function stringAt(object: JsonObject, key: string): string | null {
	const value = object[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * An integer member, by §13's rules rather than JavaScript's.
 *
 * `Number.isSafeInteger(-0)` is TRUE, and `-0` then passes every comparison a
 * reader might make afterwards (`-0 === 0`, `-0 < 0` is false) while
 * `canonicalize` renders it as `0`. That combination is exactly a signature
 * that verifies over bytes it did not sign the meaning of, and §13 forbids
 * `-0` outright. The receipt's own numbers are already refused at the literal
 * by `readReceiptDocument`; a history checkpoint's are NOT — step 9's members
 * never pass through that reader — so the rule has to hold here too.
 */
function numberAt(object: JsonObject, key: string): number | null {
	const value = object[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
	return Object.is(value, -0) ? null : value;
}

function objectAtKey(object: JsonObject, key: string): JsonObject | undefined {
	const value = object[key];
	return isJsonObject(value) ? value : undefined;
}

function arrayAt(object: JsonObject, key: string): JsonValue[] | null {
	const value = object[key];
	return Array.isArray(value) ? value : null;
}

/**
 * Canonical base64 FIRST, then the reused Ed25519 helper (CLI spec §4).
 *
 * `key` is an `Ed25519PublicKey` and NOT a `KeyObject`, because the helper
 * underneath passes `null` as the algorithm — "infer it from the key". A key of
 * any other type would verify signatures of that other type here, so what
 * constrains this call is the material, and the material is constrained at the
 * loader. The type is how that constraint reaches this line: a caller holding
 * an unchecked `KeyObject` cannot call this function at all.
 */
function verifyEd25519(preimage: string, key: Ed25519PublicKey, sigBase64: string): boolean {
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

function keyStatePermits(
	key: TrustKey,
	segmentFirstSequence: number,
	keys: ReadonlyMap<string, TrustKey>,
): string | null {
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
	// §8's boundary is ONE number governing TWO keys, and enforcing it in one
	// direction only leaves the other open. `activationSequence` sits on the
	// PREDECESSOR and equals the successor's first sealed segment — so it is
	// the predecessor's UPPER bound (above) and the successor's LOWER bound
	// (here). Without this, a key rotated IN at segment 18 signs a checkpoint
	// at segment 11 and verifies: a successor retroactively authenticating
	// material from before it existed, which is the mirror image of a retired
	// key signing after it was replaced.
	const predecessorKeyId = key.predecessorKeyId;
	if (predecessorKeyId !== undefined) {
		const predecessor = keys.get(predecessorKeyId);
		const activatedAt = predecessor?.activationSequence;
		if (activatedAt === undefined) {
			// UNREACHABLE, deliberately kept. The LOADER owns this rule: it refuses
			// any snapshot in which a named predecessor carries no
			// `activationSequence`, because a missing lower bound is a defect in
			// the SNAPSHOT (UNVERIFIABLE) and not in the receipt this function is
			// judging (FAILED). Answering it here instead is what shipped the wrong
			// verdict class for every successor of a `revoked` key. Left as a
			// defensive assertion so a future loader change cannot silently turn
			// the comparison below into a skip — but the rule lives in
			// `validateLineages`, and that is where it must be changed.
			return `key ${key.keyId} names predecessor ${predecessorKeyId}, whose activation boundary is unevaluable — the successor's lower bound cannot be checked`;
		}
		if (segmentFirstSequence < activatedAt) {
			return `key ${key.keyId} signed material at segmentFirstSequence ${segmentFirstSequence}, BEFORE it activated (${activatedAt}) — a rotation successor cannot authenticate pre-rotation material`;
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

/** §4a's v2 signed payload, by member and by type. `sig` closes the statement. */
const CHECKPOINT_STRING_MEMBERS: readonly string[] = [
	"vaultId",
	"profile",
	"root",
	"segmentId",
	"previousSegmentRoot",
	"previousSegmentId",
	"keyId",
	"publishedAt",
	"sig",
];
const CHECKPOINT_INTEGER_MEMBERS: readonly string[] = ["treeSize", "segmentFirstSequence"];

/**
 * §7 step 6's first clause, in full. `checkpoint.v === 2` is a LABEL, and a
 * label is not the statement: §4a fixes the v2 canonical signed payload as
 * exactly `{ v, vaultId, profile, root, treeSize, segmentId,
 * segmentFirstSequence, previousSegmentRoot, previousSegmentId, keyId,
 * publishedAt }` + `sig`, and every signature check downstream verifies
 * whatever payload it is handed. Strip `previousSegmentRoot`, re-sign the
 * reduced object, and the version gate, the lineage pin, the key state and the
 * Ed25519 verification all still pass — while the unauthenticated lineage edge
 * that v2 exists to close (§4a: "rewritable while every signature verified") is
 * simply gone again. A statement missing a §4a member is not a §4a statement,
 * whoever signed it, so the member list is checked BEFORE the signature.
 *
 * Nothing outside the list either. An extra member changes the canonical
 * preimage, so tolerating one would let a checkpoint carry signed-but-
 * unspecified content; step 1 already refuses that inside the receipt, but
 * step 9's history checkpoints never pass through step 1. Bounding the member
 * set also bounds the TYPES, which is what keeps `canonicalize` below reachable
 * only by strings and safe integers — it can no longer be handed the `1e999`
 * that would take this function out through a throw instead of a verdict.
 */
function checkpointStatementShape(checkpoint: JsonObject): string | null {
	// A v1 `PublishedMerkleRoot` in a receipt is FAIL: its root-only signature
	// leaves `treeSize` and the lineage edge unauthenticated.
	if (checkpoint.v !== 2) {
		return `checkpoint.v is ${JSON.stringify(checkpoint.v)}, not the v2 statement`;
	}
	for (const member of CHECKPOINT_STRING_MEMBERS) {
		if (stringAt(checkpoint, member) === null) {
			return `the v2 statement carries no ${member} — §4a fixes its signed payload exactly`;
		}
	}
	for (const member of CHECKPOINT_INTEGER_MEMBERS) {
		const value = numberAt(checkpoint, member);
		if (value === null || value < 0) {
			return `the v2 statement's ${member} is not a non-negative integer`;
		}
	}
	const extra = unknownIn(checkpoint, CHECKPOINT_KEYS, "checkpoint");
	if (extra !== null) return `${extra} is not a member of §4a's v2 signed payload`;
	// …and every member in the FORMAT §4a declares for it. The receipt's own
	// checkpoint reaches this through step 6; a SERVED history member reaches it
	// through step 9 and through nothing else — it never passes the step-1
	// reader — so this is the only place the rule can hold for both. Without it
	// a served history walks clean on roots that are not digests and a
	// `publishedAt` that is not a time, each duly signed by the checkpoint key.
	return walkFieldTable(checkpoint, CHECKPOINT_FIELDS, "checkpoint", CHECKPOINT_FORMAT_VISITOR);
}

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

	// §7 step 6's first clause: the version label AND §4a's member list, because
	// the label alone is a gate a re-signed reduced payload walks straight
	// through. Once this passes, every member is present and typed.
	const shapeFailure = checkpointStatementShape(checkpoint);
	if (shapeFailure !== null) return reject(shapeFailure);
	const keyId = stringAt(checkpoint, "keyId") as string;
	const segmentFirstSequence = numberAt(checkpoint, "segmentFirstSequence") as number;
	const sig = stringAt(checkpoint, "sig") as string;

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
	// The same binding step 4 makes for the mint key, and for the same reason:
	// §4a fixes the v2 statement's signature as Ed25519, and this function
	// verifies Ed25519 unconditionally. Without the check, a snapshot declaring
	// `ecdsa-p256` for this keyId is silently overruled by the verifier's own
	// preference — the trust document says one thing, the verifier does another,
	// and the report claims the snapshot authorized it. Conflicting trust
	// metadata is a refusal (§8: ambiguity → never a pass), not a preference.
	if (key.alg !== "ed25519") {
		return reject(
			`checkpoint key ${keyId} is registered for ${key.alg}, not the ed25519 §4a fixes for the v2 statement`,
		);
	}
	// Per-chain authority (R3-2): a domain-wide checkpoint key confers NO
	// authority over a chain whose `checkpointRootKeyId` pins another lineage.
	if (!chain.checkpointLineage.has(keyId)) {
		return reject(
			`checkpoint key ${keyId} is outside the lineage pinned by ${chain.checkpointRootKeyId}`,
		);
	}
	const stateFailure = keyStatePermits(key, segmentFirstSequence, snapshot.keys);
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

/**
 * Sorted-unique, ASCII-lexicographic — one helper, three fields (§2).
 *
 * The entries themselves get the only check §2 leaves an offline verifier:
 * "everyone else checks only that entries are WELL-FORMED and that `custom`
 * appears at most once". Catalog membership is not decidable from the receipt
 * alone, uniqueness is the sort's job — and an EMPTY entry is the one
 * well-formedness question that is decidable here. `""` sorts first and passes
 * every comparison, so a receipt can name a blank model and still print a
 * `models` line, which is a document that identifies nothing claiming to
 * identify something.
 */
function sortedUniqueStrings(value: JsonValue | undefined, field: string): string | null {
	if (!Array.isArray(value)) return `${field} is missing or not an array`;
	let previous: string | null = null;
	for (const entry of value) {
		if (typeof entry !== "string") return `${field} carries a non-string entry`;
		if (entry.length === 0) return `${field} carries an empty entry`;
		if (previous !== null && !(previous < entry)) {
			return `${field} is not sorted-unique ASCII-lexicographic at ${JSON.stringify(entry)}`;
		}
		previous = entry;
	}
	return null;
}

/**
 * §2's public-safety rule for `repo`, BOTH halves. The length half is the easy
 * one; the half that matters is the FORM: "the CANONICAL PROVIDER URL FORM
 * (`<providerHost>/<owner>/<name>`), ≤ 256 characters, and nothing else — no
 * local paths, no remote strings with credentials, no branch or worktree
 * decoration". A length-only check accepts
 * `/Users/cam/private/customer-acme/secret` on a document §2 calls PUBLIC,
 * which is the exact leak the rule exists to prevent.
 *
 * Three slash-separated parts, no more and no fewer. That one shape decides
 * every case §2 enumerates: a local path has the wrong count (and an empty
 * leading part), `https://host/o/n` has the wrong count, `u:p@host/o/n` has a
 * host that is not a hostname, and `host/o/n/tree/main` has the wrong count.
 * The host must be a dotted DNS name in LOWERCASE — DNS is case-insensitive, so
 * two spellings of one host are two spellings of one repo, which is what
 * "canonical" rules out — while `owner`/`name` keep their case, because
 * providers do.
 */
const REPO_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const REPO_PART = /^[A-Za-z0-9._-]+$/;

function isCanonicalProviderRepo(repo: string): boolean {
	if (repo.length > 256) return false;
	const parts = repo.split("/");
	if (parts.length !== 3) return false;
	const [host, owner, name] = parts as [string, string, string];
	if (!REPO_HOST.test(host)) return false;
	for (const part of [owner, name]) {
		// `.` and `..` are in the character class and are path traversal, not names.
		if (!REPO_PART.test(part) || part === "." || part === "..") return false;
	}
	return true;
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
		if (typeof repo !== "string" || !isCanonicalProviderRepo(repo)) {
			return "work.repo is not a ≤256-character <providerHost>/<owner>/<name> provider URL";
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

// ─────────────────────────────────────────────────────────────────────────────
// Step 2's PARTITION — and why it is a partition rather than a running order.
//
// The invariant: EVERY check decidable from the receipt alone runs before ANY
// check that needs external trust material. A definite failure must never be
// masked as "we could not check", because `proof.chain` is carried BY THE
// RECEIPT — so an attacker who has already been caught by a receipt-local check
// can rename it to something unregistered and convert exit 1 into exit 2, the
// code a CI gate is likeliest to tolerate.
//
// Ordering the call sites by hand does not hold that. It was ordered by hand
// once already, the lookup moved down to the first comparison that read the
// registered form, and the equalities that came AFTER that comparison were
// still maskable. The correction was a nudge, so it fixed the example.
//
// So the two phases are separated by SCOPE, and each direction is closed by the
// type checker rather than by the next reviewer:
//
//  - phase 1 is a method that never resolves the chain, so a check needing
//    registered material CANNOT be written there — there is no `chain` to
//    write it against;
//  - phase 2 is a FREE FUNCTION. It has no `this`, so it cannot reach the
//    receipt at all, and a check that belongs in phase 1 cannot be smuggled
//    into it without widening `ChainBoundClaims` — which is a visible edit to
//    a named type, reviewed as such.
//
// A check added next year lands in the right phase because the wrong phase
// does not compile, which is the only version of this rule that does not decay.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything phase 2 is allowed to see. Deliberately NOT the receipt: this is
 * the list of facts §4 compares against the REGISTERED chain, and it is short
 * because only two comparisons in the whole of step 2 need one.
 */
interface ChainBoundClaims {
	/** The lookup key, and what a missing-material refusal names. */
	readonly chainId: string;
	/** Equality 2's second half — already checked against §4a's closed form. */
	readonly actor: JsonValue;
	/** Equality 8's registry half — already checked to be `UT1_PROFILE`. */
	readonly profile: string;
}

type ReceiptLocalOutcome =
	| { readonly ok: true; readonly claims: ChainBoundClaims }
	| { readonly ok: false; readonly resolution: Resolution };

/**
 * Phase 2. The ONLY two comparisons in step 2 that need the registered chain.
 *
 * Both are second fences rather than the only ones — §4a's closed actor form
 * and the `UT1_PROFILE` literal are checked in phase 1, against the spec — so
 * nothing definite is lost by their running last.
 */
function chainBoundEqualities(chain: TrustChain, claims: ChainBoundClaims): Resolution {
	// Equality 2, the agreement half — canonical BYTES against the registered
	// form, not field plucking (§4a is explicit that this is one comparison).
	if (canonicalize(claims.actor) !== canonicalize(chain.mintActor)) {
		return failure(
			"EVENT_MISMATCH",
			"equality 2: event.actor is not the chain's registered mintActor",
		);
	}
	// Equality 8, the registry cross-check.
	if (chain.profile !== claims.profile) {
		return failure(
			"EVENT_MISMATCH",
			"equality 8: the registered chain profile disagrees with proof.profile",
		);
	}
	return PASSED;
}

class BaseRun {
	private readonly results = new Map<BaseStepName, StepOutcome>();
	private receiptId: string | null = null;
	private amountUsd: string | null = null;
	private posture: PostureLabels | null = null;
	/**
	 * §7's four values describe the INPUT, so the starting value is a claim
	 * about the run and has to be true before step 3 gets there.
	 *
	 * No arrival context ⇒ `notApplicable`: the input "does not exist in this
	 * context and never could", which is §7's own canonical case. Context
	 * SUPPLIED but step 3 never reached (an earlier step failed) ⇒ `unavailable`:
	 * the input plainly exists — the operator handed it over — and the check did
	 * not run. Reporting `notApplicable` there tells the reader their
	 * `--expect-id` could not have applied to this document, which is false, and
	 * it is the same misstatement §7 rules out for a check the verifier declined
	 * to perform.
	 */
	private arrival: CheckResultValue;
	private bound: BoundReceipt | null = null;
	private chain: TrustChain | null = null;

	constructor(private readonly input: ReceiptVerifyInput) {
		this.arrival = input.arrivalId === undefined ? "notApplicable" : "unavailable";
	}

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
		//
		// ABSENT is not MALFORMED, and `objectAtKey` cannot tell them apart — it
		// answers `undefined` for both, so `"proof": null` (or a string, or an
		// array) reported "the receipt carries no proof" and bought exit 2. §7
		// reserves UNVERIFIABLE for material that IS NOT THERE: "we could not
		// check". A member that is present and is not the object §5 declares is a
		// claim the receipt made and got wrong — FAILED / SCHEMA_INVALID, exit 1,
		// "we checked, and this receipt is bad". The two exit codes are the CI
		// contract, so PRESENCE is now decided separately from shape.
		// JSON cannot express an `undefined` VALUE, so "the key is there and the
		// value is not an object" is exactly `hasOwn && objectAtKey === undefined`.
		const malformed = (holder: JsonObject, key: string): boolean =>
			Object.hasOwn(holder, key) && objectAtKey(holder, key) === undefined;
		if (malformed(document, "proof")) return schema("proof is present and is not an object");
		const proof = objectAtKey(document, "proof");
		if (proof === undefined) return missingMaterial("proof", "the receipt carries no proof");
		if (malformed(proof, "inclusion")) {
			return schema("proof.inclusion is present and is not an object");
		}
		const inclusion = objectAtKey(proof, "inclusion");
		if (inclusion === undefined) {
			return missingMaterial("proof", "the proof carries no inclusion member");
		}
		if (malformed(proof, "checkpoint")) {
			return schema("proof.checkpoint is present and is not an object");
		}
		const checkpoint = objectAtKey(proof, "checkpoint");
		if (checkpoint === undefined) {
			return missingMaterial("checkpoint", "the proof carries no checkpoint member");
		}
		if (stringAt(proof, "profile") === null) return schema("proof.profile is missing");
		if (stringAt(proof, "chain") === null) return schema("proof.chain is missing");
		if (stringAt(proof, "mintEventHash") === null) return schema("proof.mintEventHash is missing");
		if (inclusion.version !== 1) return schema("proof.inclusion.version is not 1");

		// §5 SHAPE, the half that was missing: every member present is the FORMAT
		// §2/§5 declares for it, from the same table that decided which members may
		// be present at all. It runs last inside step 1 so the named per-member
		// refusals above keep their own wording, and it runs HERE rather than in
		// `readReceiptDocument` because the reader's scope is deliberately narrow —
		// bytes, duplicate keys, frozen numerics, key sets — and §12 decoding and
		// the §5 literals already live at this level for the same reason.
		const format = findFormatViolation(document);
		if (format !== null) return schema(format);

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
	//
	// TWO PHASES, and the split is the fix — not the running order inside them.
	// The partition note above `ChainBoundClaims` says why, and says what stops
	// a check landing in the wrong one.
	private stepEvent(): Resolution {
		// PHASE 1 — everything §4 can decide from the receipt's own bytes.
		const local = this.receiptLocalEqualities();
		if (!local.ok) return local.resolution;
		const { chainId } = local.claims;

		// THE BOUNDARY, and it is the only place external trust material enters
		// step 2. Nothing receipt-local is left undecided by this line, so an
		// unresolvable chain can mask only another unresolvable — never a proof of
		// forgery. `missingMaterial` still describes the snapshot accurately for a
		// receipt whose own bytes are intact: that case is unchanged, and is the
		// control the corpus keeps (`snapshot/chain-not-registered`).
		const chain = this.input.snapshot.chains.get(chainId);
		if (chain === undefined) {
			return missingMaterial("trustKey", `chain ${chainId} is not registered in the snapshot`);
		}
		this.chain = chain;

		// PHASE 2 — the comparisons that need the registered form, and nothing else.
		return chainBoundEqualities(chain, local.claims);
	}

	/**
	 * Phase 1. Reads the receipt and NOTHING ELSE: there is no chain in scope
	 * here, which is what makes "receipt-local" a property of the code rather
	 * than a claim about it.
	 */
	private receiptLocalEqualities(): ReceiptLocalOutcome {
		const { document, event, projection, proof, inclusion, checkpoint } = this.receipt;
		const mismatch = (detail: string): ReceiptLocalOutcome => ({
			ok: false,
			resolution: failure("EVENT_MISMATCH", detail),
		});

		const chainId = stringAt(proof, "chain") as string;

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

		// Equality 2's FIRST half — which is not an equality at all, and is the
		// half that stands on the receipt alone.
		//
		// §4a fixes proxy-v1's mint actor to exactly
		// `{type:"system", id:"receipt-minter", name:"receipt-minter"}`, and the
		// canonical comparison in phase 2 cannot see that: it compares two INPUTS,
		// so a receipt carrying the string form (or `null`, or the closed form plus
		// a `tenant`) verified whenever the pinned chain registered the identical
		// malformation. Agreement proves the two documents came from one writer,
		// which is precisely what an attacker supplying both already has.
		//
		// The literal is safe to apply here even though `proof.profile` is not
		// pinned until equality 8 below: no receipt reaches a verdict under any
		// other profile (equality 8 refuses everything but `UT1_PROFILE`), and no
		// existing profile mutant touches the actor, so this cannot pre-empt the
		// condition that vector isolates.
		if (event.kind !== UT1_MINT_EVENT_KIND) {
			return mismatch(`equality 2: event.kind is not ${UT1_MINT_EVENT_KIND}`);
		}
		if (!isUt1MintActor(event.actor)) {
			return mismatch(
				"equality 2: event.actor is not §4a's fixed proxy-v1 system actor, whatever the chain registers",
			);
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

		// Every receipt-local equality has passed. What is handed over is only
		// what the chain-bound half compares — the receipt itself does not travel.
		return { ok: true, claims: { chainId, actor: event.actor, profile } };
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
		// AGREEMENT IS NOT CONFORMANCE, the same defect as equality 2's actor.
		// §4a/§8 give ut1 v1 NO SDK mint keys — `minter.kind` is the literal
		// `proxy`, and the snapshot does not get to widen the vocabulary. Until
		// this line, a snapshot registering `minterKind: "sdk"` and a receipt
		// claiming `"sdk"` agreed with each other and verified, which is a receipt
		// asserting an authority v1 cannot confer, attested by a document the same
		// party supplied. The literal is checked FIRST, against the spec.
		const minterKind = stringAt(minter, "kind");
		if (minterKind !== UT1_MINTER_KIND) {
			return invalid(
				`minter.kind ${JSON.stringify(minter.kind)} is not v1's pinned literal ${JSON.stringify(UT1_MINTER_KIND)}`,
			);
		}
		// And only then the agreement, which still has work to do: a key
		// registered for some other minterKind confers no authority over a receipt
		// claiming `proxy`.
		if (key.minterKind !== minterKind) {
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
		const stateFailure = keyStatePermits(key, segmentFirstSequence, this.input.snapshot.keys);
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

// ─────────────────────────────────────────────────────────────────────────────
// §7 step 9 — the EXTENSION checks, and the CUMULATIVE ladder.
//
// Step 9 is the only step that can make a verdict BETTER, and that inverts the
// usual risk: everywhere else a missing rule shows up as a receipt that should
// have been rejected, but here it shows up as a rung that was not earned — and
// the output of an under-implemented walk is indistinguishable from that of a
// complete one. So every clause of §7's history paragraph is written out
// separately below, and each has a corpus mutant that upgrades without it.
//
// Two invariants hold over the whole section. **Upgrade-only:** an extension
// result never becomes the run's `failure` and never touches `missing` (§7:
// "Neither changes the base verdict from step 8"), because unsigned optional
// material is exactly what an attacker can freely substitute and turning a
// sound receipt red on it would be a denial of service against honest ones.
// **Never a rescue:** the walk runs only on a base pass, gated on
// `BaseVerdictReport.verified`, since material that could lift a failed receipt
// would be material that carries one.
// ─────────────────────────────────────────────────────────────────────────────

/** §4a: the first segment's lineage edge is these fixed strings, exactly. */
export const GENESIS_SENTINEL = "genesis";

/** The two §7 step-9 checks. Both are named in output, never inferred. */
export type ExtensionCheckName = "checkpointHistory" | "anchorEvidence";

/**
 * Step 9's inputs, as PARSED WIRE DATA from the resolver's unsigned envelope
 * (§5) — untrusted in exactly the way the receipt is, and validated here rather
 * than assumed because the envelope carried it. An ABSENT key means nothing was
 * served, which is `notApplicable` and not `unavailable`; this offline CLI has
 * nothing to fetch from and so can never produce the latter.
 */
export interface ReceiptExtensionMaterial {
	readonly checkpointHistory?: JsonValue;
	readonly anchorEvidence?: JsonValue;
}

export type ReceiptVerdict =
	| "VERIFIED_CHECKPOINT"
	| "VERIFIED_CHECKPOINT_HISTORY"
	| "VERIFIED_ANCHORED"
	| "FAILED"
	| "UNVERIFIABLE";

/** The nine §7 steps as the report names them. */
export type ReportStepName = BaseStepName | "extensions";

export interface ReceiptChecks {
	readonly registryBinding: StepOutcome;
	readonly predecessorLinkage: StepOutcome;
	readonly checkpointHistory: StepOutcome;
	/**
	 * OMITTED — not `unavailable`, not `notApplicable` — when evidence was
	 * supplied and this build declined to check it. See `unimplemented`.
	 */
	readonly anchorEvidence?: StepOutcome;
}

/**
 * The base report widened by step 9. `receiptId`, `arrivalContext`, `computed`,
 * `posture`, `failure`, `missing` and `verified` are INHERITED rather than
 * restated: step 9 copies them through untouched, and two hand-written copies
 * of one shape are two shapes that will eventually disagree.
 */
export interface ReceiptReport extends Omit<BaseVerdictReport, "verdict" | "steps" | "checks"> {
	readonly verdict: ReceiptVerdict;
	readonly steps: Readonly<Record<ReportStepName, StepOutcome>>;
	readonly checks: ReceiptChecks;
	/**
	 * Checks this build DECLINED TO RUN, named out of band because §7 has no
	 * vocabulary for them: its four values describe the INPUT (`notApplicable` =
	 * cannot exist here; `unavailable` = exists but was unobtainable) and neither
	 * describes a verifier that did not look. Reporting present-but-unchecked
	 * evidence as `unavailable` would read as "we tried"; this field lets a
	 * consumer machine-detect the gap instead of inferring it.
	 */
	readonly unimplemented: readonly ExtensionCheckName[];
}

const PASSED_OUTCOME: StepOutcome = { result: "passed" };
const UNAVAILABLE_OUTCOME: StepOutcome = { result: "unavailable" };

/** `history[3] (seg_000004)` — untrusted text, sanitized by the reporter. */
function historyMemberLabel(index: number, member: JsonObject): string {
	const segmentId = stringAt(member, "segmentId");
	return segmentId === null ? `history[${index}]` : `history[${index}] (${segmentId})`;
}

/**
 * §7's `VERIFIED_CHECKPOINT_HISTORY` predicate, clause by clause.
 *
 * Returns `null` when the served history earns the rung, or the reason it does
 * not. Total: it never throws, which is why §4a's member list and its TYPES are
 * checked (inside `verifyCheckpointStatement`) before `canonicalize` is handed
 * a member.
 *
 * Chain identity comes from the REGISTERED `TrustChain`, not a second read of
 * `proof`: step 2 has already bound `checkpoint.vaultId === proof.chain ===
 * chain.vaultId` and the same for `profile`, so re-reading the document here
 * would add unreachable guards and a second place for the two to drift.
 */
function walkCheckpointHistory(
	supplied: JsonValue,
	verified: VerifiedMaterial,
	snapshot: TrustSnapshot,
): string | null {
	if (!Array.isArray(supplied)) return "the served checkpointHistory is not an array";
	// A zero-length walk satisfies every per-member clause vacuously, so without
	// this the emptiest possible input would be the cheapest upgrade in the
	// system. §7 requires a history "from the DECLARED GENESIS BOUNDARY to a head
	// at/after the receipt's segment", which is at minimum one checkpoint.
	if (supplied.length === 0) return "the served checkpointHistory is empty";

	const { chain, checkpoint } = verified;
	// Byte equality over the whole signed statement INCLUDING `sig`. §7 says the
	// embedded checkpoint "appears EXACTLY in the supplied history": a
	// segmentId-keyed lookup would accept a different, internally valid, validly
	// signed checkpoint for the same segment — which is the second-checkpoint
	// integrity incident §4a makes a hard fail, arriving through the one door
	// that was left open.
	const embedded = canonicalize(checkpoint);

	const seenSegmentIds = new Set<string>();
	let previous: JsonObject | null = null;
	let embeddedFound = false;

	for (let index = 0; index < supplied.length; index += 1) {
		const member = supplied[index] as JsonValue;
		if (!isJsonObject(member)) return `history[${index}] is not a JSON object`;

		// §4a's full v2 statement, the §8 lineage, the key's role, and its state
		// evaluated at THIS member's own segment — the same function step 6 uses,
		// because "every checkpoint's signature verifies under the §8 lineage"
		// must reach the same answer for a history member as for the receipt's
		// own. A second copy would be a second chance to weaken one of them.
		//
		// An unresolvable member key comes back as `missingTrustKey`, and here it
		// is a FAILED EXTENSION, not missing material: CLI spec §5's
		// unresolvable-key row is about the receipt's own trust material, and an
		// extension can never demote the base verdict to UNVERIFIABLE.
		const statement = verifyCheckpointStatement(member, chain, snapshot);
		if (!statement.ok) return `${historyMemberLabel(index, member)}: ${statement.detail}`;

		// The shape check inside `verifyCheckpointStatement` passed, so every §4a
		// member is present and typed and the reads below are total.
		const label = historyMemberLabel(index, member);
		const segmentId = stringAt(member, "segmentId") as string;
		const segmentFirstSequence = numberAt(member, "segmentFirstSequence") as number;

		// §4a: `vaultId`/`profile` are SIGNED, so each statement says which chain
		// it belongs to. A foreign member in an otherwise clean walk is exactly
		// what one checkpoint key trusted by two vaults would produce.
		if (stringAt(member, "vaultId") !== chain.vaultId) {
			return `${label}: vaultId is not the receipt's chain ${chain.vaultId}`;
		}
		if (stringAt(member, "profile") !== chain.profile) {
			return `${label}: profile is not the chain's registered ${chain.profile}`;
		}

		// §4a: exactly ONE checkpoint per segment, ever. This is what makes prefix
		// ROLLBACK detectable rather than merely unlikely — a second checkpoint
		// over the same segment is an integrity incident, not a later revision.
		if (seenSegmentIds.has(segmentId)) {
			return `${label}: segmentId appears more than once — §4a seals each segment with its single checkpoint`;
		}
		seenSegmentIds.add(segmentId);

		if (previous === null) {
			// §8's REGISTERED genesis, made checkable. A short history and an
			// over-claimed one both fail here, which is the point: the served root
			// is compared against the snapshot's `genesisSegmentId`, never against
			// whatever the history happens to start with.
			if (segmentId !== chain.genesisSegmentId) {
				return `${label}: the history roots at ${segmentId}, not the registered genesis ${chain.genesisSegmentId}`;
			}
			// §4a: "genesis values exact". Accepting anything else would let a
			// history claim a predecessor the registration says cannot exist.
			if (
				stringAt(member, "previousSegmentRoot") !== GENESIS_SENTINEL ||
				stringAt(member, "previousSegmentId") !== GENESIS_SENTINEL
			) {
				return `${label}: the genesis checkpoint's previousSegment* are not the fixed string "${GENESIS_SENTINEL}"`;
			}
		} else {
			const previousFirst = numberAt(previous, "segmentFirstSequence") as number;
			const previousTreeSize = numberAt(previous, "treeSize") as number;
			if (stringAt(member, "previousSegmentId") !== stringAt(previous, "segmentId")) {
				return `${label}: previousSegmentId does not name the preceding checkpoint's segment`;
			}
			if (stringAt(member, "previousSegmentRoot") !== stringAt(previous, "root")) {
				return `${label}: previousSegmentRoot is not the preceding checkpoint's root`;
			}
			// §7: "strictly increasing AND contiguous". The two are separate
			// clauses because a zero-leaf predecessor satisfies the arithmetic
			// while standing still.
			if (segmentFirstSequence <= previousFirst) {
				return `${label}: segmentFirstSequence ${segmentFirstSequence} does not strictly increase past ${previousFirst}`;
			}
			const expected = previousFirst + previousTreeSize;
			// Both operands are safe integers; their SUM need not be, and an
			// imprecise sum compares equal to values that are not it. The whole
			// walk rests on this one comparison, so it refuses rather than guesses.
			if (!Number.isSafeInteger(expected)) {
				return `${label}: the contiguity sum ${previousFirst} + ${previousTreeSize} leaves the safe-integer range`;
			}
			if (segmentFirstSequence !== expected) {
				return `${label}: segmentFirstSequence ${segmentFirstSequence} ≠ ${previousFirst} + ${previousTreeSize} — the walk has a gap`;
			}
		}

		if (canonicalize(member) === embedded) embeddedFound = true;
		previous = member;
	}

	// §7's "a head at/after the receipt's segment" needs no separate check: the
	// receipt's own checkpoint is IN this walk, and the walk is strictly
	// increasing, so the head is at or after it by construction. Saying that
	// beats a second comparison that could disagree with the first.
	if (!embeddedFound) {
		return "the receipt's own checkpoint does not appear EXACTLY in the served history";
	}
	return null;
}

/**
 * receipt-spec §7 steps 1–9 over one receipt, one PINNED §8 snapshot, and
 * whatever optional material the resolver envelope carried.
 *
 * **The ladder is CUMULATIVE, and its top rung is unreachable here.**
 * `VERIFIED_CHECKPOINT` is steps 1–8. `VERIFIED_CHECKPOINT_HISTORY` adds a
 * clean history walk. `VERIFIED_ANCHORED` requires that history AND validated
 * anchor evidence (§7; verify-page §4.1 rule 3 — "Rekor alone upgrades nothing
 * past the checkpoint floor"). This build validates NO anchor evidence, so
 * there is deliberately no branch below that returns it: writing one would be
 * dead code that reads to the next maintainer as a live path. The blocker is
 * normative, not schedule — no authority yet defines the artifact-hash preimage
 * binding Rekor evidence to a `SegmentCheckpoint`'s signed payload, and
 * `rekor-verify.ts` binds a vault `AnchorRecord`, a different object. When that
 * rule lands, this becomes an ordinary §7 check and the rung becomes reachable.
 *
 * Offline and total, exactly like the base run: no I/O, and never a throw.
 */
export function verifyReceipt(input: ReceiptVerifyInput): ReceiptReport {
	const base = verifyReceiptBase(input);
	const material = input.extensions ?? {};
	const suppliedHistory = material.checkpointHistory;
	// Present at all ⇒ this build declined to look at it. That is true whatever
	// the base verdict did, so it is reported the same way either way.
	const anchorSupplied = material.anchorEvidence !== undefined;

	let verdict: ReceiptVerdict = base.verdict;
	let history: StepOutcome;
	if (suppliedHistory === undefined) {
		// Nothing was served. `notApplicable` — the input does not exist in this
		// context — and that stays the true statement whatever the base run did.
		history = NOT_APPLICABLE_OUTCOME;
	} else if (base.verified === null) {
		// Material WAS served and the walk did not run, because an extension
		// upgrades a verdict and never rescues one. A step that never ran is
		// `unavailable`; calling it `notApplicable` would assert something about
		// the input rather than about this run.
		history = UNAVAILABLE_OUTCOME;
	} else {
		const detail = walkCheckpointHistory(suppliedHistory, base.verified, input.snapshot);
		if (detail === null) {
			history = PASSED_OUTCOME;
			verdict = "VERIFIED_CHECKPOINT_HISTORY";
		} else {
			history = { result: "failed", failure: { code: "HISTORY_INVALID", detail } };
		}
	}

	return {
		verdict,
		receiptId: base.receiptId,
		// The step ledger and the named check are the same fact, reported under
		// the two names §7 and the `--json` shape each use for it.
		steps: { ...base.steps, extensions: history },
		checks: {
			registryBinding: base.checks.registryBinding,
			predecessorLinkage: base.checks.predecessorLinkage,
			checkpointHistory: history,
			...(anchorSupplied ? {} : { anchorEvidence: NOT_APPLICABLE_OUTCOME }),
		},
		arrivalContext: base.arrivalContext,
		computed: base.computed,
		posture: base.posture,
		unimplemented: anchorSupplied ? ["anchorEvidence"] : [],
		// §7 step 9 is upgrade-only: an extension result is never the run's
		// failure, and the exit code is computed from these two fields.
		failure: base.failure,
		missing: base.missing,
		verified: base.verified,
	};
}
