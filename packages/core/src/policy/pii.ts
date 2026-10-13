// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * PII Detector
 *
 * Pattern-based PII detection for event payloads.
 * Recursively scans strings in objects/arrays and returns
 * which PII types were found and at which paths.
 *
 * Pure module — no side effects, no network calls.
 *
 * Detects: email, phone, SSN, credit card (Luhn-validated), IPv4,
 * API keys, AWS keys, GitHub tokens, bearer tokens, generic secrets.
 */

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface PIIDetection {
	/** Whether any PII was found */
	found: boolean;
	/** PII types detected (e.g. ["email", "ssn"]) */
	types: string[];
	/** Dot-paths where PII was found (e.g. ["user.email(email)", "billing.ssn(ssn)"]) */
	paths: string[];
}

// ---------------------------------------------------------------------------
// PII patterns
// ---------------------------------------------------------------------------

interface PIIPattern {
	type: string;
	test: (value: string) => boolean;
}

/** RFC 5322 simplified — local@domain.tld */
function isEmail(value: string): boolean {
	return /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(value);
}

/** US/international phone: +1-234-567-8901, (234) 567-8901, 234.567.8901, etc. */
function isPhoneNumber(value: string): boolean {
	const stripped = value.replace(/\s+/g, "");
	return /(?:\+?\d{1,3}[-.\s()]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(stripped);
}

/**
 * US SSN. High-confidence dashed form `XXX-XX-XXXX`, OR a bare/space-separated
 * 9-digit sequence that passes SSA structural validation (area 001-899 except
 * 666, group 01-99, serial 0001-9999). Structural validation keeps the bare
 * form from matching arbitrary 9-digit identifiers, and the word boundaries stop
 * it firing inside longer digit runs (phone/credit-card numbers).
 */
function isSSN(value: string): boolean {
	if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) return true;

	// Bare or single-space-separated: 123456789 or 123 45 6789. Require standalone.
	const bare = value.match(/\b(\d{3})[ ]?(\d{2})[ ]?(\d{4})\b/g);
	if (!bare) return false;
	for (const candidate of bare) {
		const digits = candidate.replace(/ /g, "");
		const area = Number(digits.slice(0, 3));
		const group = Number(digits.slice(3, 5));
		const serial = Number(digits.slice(5, 9));
		if (area >= 1 && area <= 899 && area !== 666 && group >= 1 && group <= 99 && serial >= 1) {
			return true;
		}
	}
	return false;
}

/** IPv4 address: 0-255.0-255.0-255.0-255 */
function isIPv4(value: string): boolean {
	const match = value.match(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/);
	if (!match) return false;
	return [match[1], match[2], match[3], match[4]].every((octet) => {
		const n = Number(octet);
		return n >= 0 && n <= 255;
	});
}

/**
 * Credit card number detection.
 * Finds 13-19 digit sequences (with optional dashes/spaces) and
 * validates them using the Luhn algorithm.
 */
function isCreditCard(value: string): boolean {
	const candidates = value.match(/\b[\d][\d\s-]{11,22}[\d]\b/g);
	if (!candidates) return false;
	return candidates.some((candidate) => {
		const digits = candidate.replace(/[\s-]/g, "");
		if (digits.length < 13 || digits.length > 19) return false;
		if (!/^\d+$/.test(digits)) return false;
		return luhnCheck(digits);
	});
}

/** Luhn algorithm for credit card validation. */
function luhnCheck(digits: string): boolean {
	let sum = 0;
	let alternate = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let n = Number(digits[i]);
		if (alternate) {
			n *= 2;
			if (n > 9) n -= 9;
		}
		sum += n;
		alternate = !alternate;
	}
	return sum % 10 === 0;
}

/** API key: sk-... (OpenAI/Anthropic) or sk_live_/sk_test_ (Stripe) */
function isApiKey(value: string): boolean {
	return /\b(?:sk-|sk_(?:live|test)_)[a-zA-Z0-9_-]{20,}\b/.test(value);
}

/** AWS access key: AKIA followed by 16 uppercase alphanumeric chars */
function isAwsKey(value: string): boolean {
	return /\bAKIA[0-9A-Z]{16}\b/.test(value);
}

/** GitHub token: ghp_, gho_, ghs_, ghr_, github_pat_ followed by 22+ alphanumeric chars */
function isGithubToken(value: string): boolean {
	return /\b(?:ghp_|gho_|ghs_|ghr_|github_pat_)[a-zA-Z0-9]{22,}\b/.test(value);
}

/** Bearer token: Authorization header with 20+ char token */
function isBearerToken(value: string): boolean {
	return /\bBearer\s+\S{20,}/.test(value);
}

/** JWT token: eyJ... header.payload.signature */
function isJwt(value: string): boolean {
	return /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/.test(value);
}

/** PEM-encoded private key */
function isPrivateKey(value: string): boolean {
	return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

/** Generic secret: known prefixes (xox, SG., glpat-, npm_) or long hex strings (64+ chars) */
function isGenericSecret(value: string): boolean {
	// Note: sk- and sk_ prefixes handled by isApiKey — not duplicated here
	if (
		/\b(?:xox[bpars]-[a-zA-Z0-9-]+|SG\.[a-zA-Z0-9_-]{20,}|glpat-[a-zA-Z0-9_-]{20,}|npm_[a-zA-Z0-9]{36,})\b/.test(
			value,
		)
	) {
		return true;
	}
	// Long hex strings — require at least one digit and one letter to avoid false positives
	const hexMatch = value.match(/\b[0-9a-fA-F]{64,}\b/);
	if (!hexMatch) return false;
	const hex = hexMatch[0];
	return /[0-9]/.test(hex) && /[a-fA-F]/.test(hex);
}

const PII_PATTERNS: PIIPattern[] = [
	{ type: "email", test: isEmail },
	{ type: "phone", test: isPhoneNumber },
	{ type: "ssn", test: isSSN },
	{ type: "credit_card", test: isCreditCard },
	{ type: "ipv4", test: isIPv4 },
	{ type: "api_key", test: isApiKey },
	{ type: "aws_key", test: isAwsKey },
	{ type: "github_token", test: isGithubToken },
	{ type: "bearer_token", test: isBearerToken },
	{ type: "jwt", test: isJwt },
	{ type: "private_key", test: isPrivateKey },
	{ type: "generic_secret", test: isGenericSecret },
];

// ---------------------------------------------------------------------------
// Recursive scanner
// ---------------------------------------------------------------------------

/**
 * Detect PII in any value by recursively scanning strings in objects/arrays.
 *
 * Returns which PII types were found and at which dot-paths.
 */
export function detectPII(data: unknown): PIIDetection {
	const types = new Set<string>();
	const paths: string[] = [];

	scanValue(data, "", types, paths);

	return {
		found: types.size > 0,
		types: [...types],
		paths,
	};
}

// ---------------------------------------------------------------------------
// Opaque, text-free values: kept BY REFERENCE, never walked
// ---------------------------------------------------------------------------

/** The built-in `aborted` getter, a brand check: it throws for anything but a real AbortSignal. */
const ABORT_SIGNAL_ABORTED: ((this: unknown) => unknown) | undefined =
	typeof AbortSignal === "function"
		? (Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get as
				| ((this: unknown) => unknown)
				| undefined)
		: undefined;

/**
 * The abort state of `signal` as the BUILT-IN `AbortSignal.prototype.aborted` getter reports it,
 * never an own `aborted` property or getter decorating the object. `undefined` when the value is
 * not a real AbortSignal (the getter's brand check throws) or the platform has none.
 */
export function builtInAborted(signal: object): boolean | undefined {
	if (ABORT_SIGNAL_ABORTED === undefined) return undefined;
	try {
		return ABORT_SIGNAL_ABORTED.call(signal) === true;
	} catch {
		return undefined;
	}
}

/** Does the built-in getter accept `value` as its receiver (a real instance, not a look-alike)? */
function passesBrand(getter: ((this: unknown) => unknown) | undefined, value: object): boolean {
	if (getter === undefined) return false;
	try {
		getter.call(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * THE CLOSED ALLOWLIST, in one place: the opaque, text-free types that redaction keeps BY
 * REFERENCE and the scan does not walk into. Today: `AbortSignal` only. Flattening it into
 * a plain object (what the generic walk does) made it `{}`, so a redacted request could no
 * longer be cancelled. Binary values (ArrayBuffer, typed arrays, DataView, Blob/File) are
 * deliberately NOT here: they carry content this scanner cannot read, so they keep today's
 * behaviour (flattened by redaction).
 *
 * Each member is recognised by BRAND, never by duck-typing: `instanceof` this realm's own
 * constructor (guarded by `typeof … === "function"`), AND the built-in's own getter
 * accepting the value as its receiver, so neither a look-alike (`{ aborted: false,
 * addEventListener() {} }`) nor an object made from the prototype
 * (`Object.create(AbortSignal.prototype)`) is kept.
 */
const OPAQUE_TEXT_FREE: ReadonlyArray<(value: object) => boolean> = [
	(v) =>
		typeof AbortSignal === "function" &&
		v instanceof AbortSignal &&
		passesBrand(ABORT_SIGNAL_ABORTED, v),
];

/**
 * `value` is, by brand, a member of OPAQUE_TEXT_FREE, and carries no own STRING-named property
 * at all, enumerable or not (where a string, or a `toJSON` a serializer would call, could hide).
 */
export function isOpaqueTextFree(value: object): boolean {
	return (
		OPAQUE_TEXT_FREE.some((isMember) => isMember(value)) &&
		Object.getOwnPropertyNames(value).length === 0
	);
}

/**
 * The positions, from the root of the value being scanned or redacted, where an opaque value is
 * a TRANSPORT input the SDK hands to its HTTP layer and never serializes into the request:
 * Google's `params.config.abortSignal`. Only there is it kept by reference and not walked.
 * Anywhere else (nested in a function response, a tool, a part) it is walked and flattened
 * like any other object, because there a serializer would read it. OpenAI and Anthropic take
 * their signal in the request OPTIONS, the second argument, which redaction never touches.
 */
const TRANSPORT_SLOTS: ReadonlySet<string> = new Set(["config.abortSignal"]);

/** Kept by reference and not walked: an opaque, text-free value at a transport position. */
function keptByReference(value: unknown, path: string): boolean {
	return (
		TRANSPORT_SLOTS.has(path) &&
		value !== null &&
		typeof value === "object" &&
		isOpaqueTextFree(value)
	);
}

function scanValue(value: unknown, currentPath: string, types: Set<string>, paths: string[]): void {
	if (typeof value === "string") {
		scanString(value, currentPath, types, paths);
		return;
	}

	// An opaque, text-free value at a transport position is not walked (see TRANSPORT_SLOTS).
	if (keptByReference(value, currentPath)) return;

	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const itemPath = currentPath ? `${currentPath}[${i}]` : `[${i}]`;
			scanValue(value[i], itemPath, types, paths);
		}
		return;
	}

	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			const fieldPath = currentPath ? `${currentPath}.${key}` : key;
			scanValue(record[key], fieldPath, types, paths);
		}
	}
}

function scanString(value: string, currentPath: string, types: Set<string>, paths: string[]): void {
	for (const pattern of PII_PATTERNS) {
		if (pattern.test(value)) {
			types.add(pattern.type);
			paths.push(currentPath ? `${currentPath}(${pattern.type})` : `(${pattern.type})`);
		}
	}
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export interface RedactedData {
	/** The data with PII values replaced by placeholders */
	data: unknown;
	/** The detection result (same as detectPII) */
	detection: PIIDetection;
}

/**
 * Deep-clone data and replace detected PII values with redacted placeholders.
 * Returns both the redacted data and the detection metadata.
 */
export function redactPII(data: unknown): RedactedData {
	const detection = detectPII(data);
	if (!detection.found) {
		return { data, detection };
	}
	const redacted = redactValue(data);
	return { data: redacted, detection };
}

/**
 * Redact PII from an LLM request's message array for OUTBOUND transmission.
 *
 * Contract:
 * - **Pure**: does not mutate `messages`; deep-clones and returns a new value.
 * - Redacts only string values that match a PII pattern, replacing them with
 *   `[REDACTED:<types>]` (same placeholder as {@link redactPII}).
 * - Non-string / non-PII values are returned structurally unchanged.
 * - Never touches sibling request fields — callers apply this to the message
 *   array ONLY, then rebuild `params` with the redacted messages.
 * - Returns the detection metadata so the caller can audit what was redacted.
 *
 * Intended caller (GOVERN), when `config.pii === "redact"`:
 *   const { data: safeMessages } = redactMessages(messages);
 *   const safeArgs = [{ ...params, messages: safeMessages }, ...args.slice(1)];
 *   await originalFn.apply(thisArg, safeArgs);
 *
 * @returns `{ data: <redacted messages>, detection }`
 */
export function redactMessages(messages: unknown): RedactedData {
	return redactPII(messages);
}

/** Return matched PII type names for a string value. */
function matchedTypes(value: string): string[] {
	const matched: string[] = [];
	for (const pattern of PII_PATTERNS) {
		if (pattern.test(value)) {
			matched.push(pattern.type);
		}
	}
	return matched;
}

function defineData(obj: object, key: string, value: unknown, enumerable: boolean): void {
	Object.defineProperty(obj, key, { value, writable: true, enumerable, configurable: true });
}

/** Recursively traverse data and replace PII strings with redacted placeholders. */
function redactValue(value: unknown, path = ""): unknown {
	if (typeof value === "string") {
		const types = matchedTypes(value);
		if (types.length > 0) {
			return `[REDACTED:${types.join(",")}]`;
		}
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item, i) => redactValue(item, `${path}[${i}]`));
	}

	// An opaque, text-free value at a transport position is kept BY REFERENCE (TRANSPORT_SLOTS).
	if (keptByReference(value, path)) return value;

	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		// Every key is DEFINED, never assigned: an own "__proto__" key (as JSON.parse makes one) stays
		// a key of the clone instead of becoming its prototype.
		for (const key of Object.keys(record)) {
			defineData(result, key, redactValue(record[key], path === "" ? key : `${path}.${key}`), true);
		}
		// A non-enumerable own DATA property stays one, redacted, so a consumer that reads the request
		// by name still finds the field, and JSON.stringify still skips it. Data only: a function (a
		// hidden `toJSON` hook) is never carried into the clone, where serializing would run it; an
		// accessor is never invoked.
		for (const key of Object.getOwnPropertyNames(record)) {
			const d = Object.getOwnPropertyDescriptor(record, key);
			if (d === undefined || d.enumerable === true || !("value" in d)) continue;
			if (typeof d.value === "function") continue;
			defineData(result, key, redactValue(d.value, path === "" ? key : `${path}.${key}`), false);
		}
		return result;
	}

	return value;
}
