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

import { isRealAbortSignal } from "../shared/abort-signal.js";

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

/** `[0-9]` by char code. */
function isAsciiDigit(c: number): boolean {
	return c >= 0x30 && c <= 0x39;
}

/** `[a-zA-Z0-9]` by char code. */
function isAsciiAlnum(c: number): boolean {
	return isAsciiDigit(c) || isAsciiLetter(c);
}

/** A word character, `\w`: `[a-zA-Z0-9_]` by char code. */
function isWordChar(c: number): boolean {
	return isAsciiAlnum(c) || c === 0x5f;
}

/** `[a-zA-Z]` by char code. */
function isAsciiLetter(c: number): boolean {
	return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** The local-part class `[a-zA-Z0-9._%+-]`. */
function isEmailLocalChar(c: number): boolean {
	// . _ % + -
	return isAsciiAlnum(c) || c === 0x2e || c === 0x5f || c === 0x25 || c === 0x2b || c === 0x2d;
}

/** The domain class `[a-zA-Z0-9.-]`. */
function isEmailDomainChar(c: number): boolean {
	return isAsciiAlnum(c) || c === 0x2e || c === 0x2d;
}

/**
 * RFC 5322 simplified — local@domain.tld. Exactly what
 * `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/` matches, found from each `@` instead of from
 * every position. That regex re-scanned the greedy local part from every start when no `@`
 * followed, so one message of N separator-free characters took time in N squared (200k `x`
 * characters: 26 s, on the event loop, before the hold).
 *
 * The pattern carries no boundary, so it matches as soon as ONE local character sits right before
 * an `@` and the domain-class run after it holds a `.` (not its first character) followed by two
 * letters. Both checks are made from the `@`: the local side reads one character, and the domain
 * side reads the run after the `@`, which ends at the next `@` at the latest (`@` is not in the
 * domain class), so no character is read by two domain scans and the whole scan is linear. Neither
 * side is clipped to a length limit: a longer local part or domain matches today, and still does.
 */
function isEmail(value: string): boolean {
	for (let at = value.indexOf("@"); at !== -1; at = value.indexOf("@", at + 1)) {
		if (at === 0 || !isEmailLocalChar(value.charCodeAt(at - 1))) continue;
		for (let i = at + 1; i < value.length && isEmailDomainChar(value.charCodeAt(i)); i++) {
			if (
				i > at + 1 &&
				value.charCodeAt(i) === 0x2e &&
				isAsciiLetter(value.charCodeAt(i + 1)) &&
				isAsciiLetter(value.charCodeAt(i + 2))
			) {
				return true;
			}
		}
	}
	return false;
}

/** A run of the characters a phone number is written with: digits, whitespace and `( ) + - .`. */
const PHONE_RUN_RE = /[\d\s()+.-]+/g;

/** The phone pattern, tested on a run with its whitespace removed. */
const PHONE_RE = /(?:\+?\d{1,3}[-.\s()]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

/**
 * A group of 16 or more digits: longer than any phone number (E.164 allows 15), so an id or a card
 * number, never part of a phone, unless it is a dial string (`isDialString`).
 */
const OVERSIZED_DIGITS_RE = /\d{16,}/g;

/**
 * International access prefixes: 00 in most of the world, 011 in North America, 010 in Japan, 0011
 * in Australia. Dialled before a number of up to 15 digits, one makes a group longer than 15
 * ("0114915123456789" is +49 1512 3456789 dialled from North America).
 */
const ACCESS_PREFIXES = ["0011", "011", "010", "00"];

/** Whether a long digit group is a dial string: an access prefix, then at most 15 digits. */
function isDialString(group: string): boolean {
	return ACCESS_PREFIXES.some(
		(prefix) => group.startsWith(prefix) && group.length - prefix.length <= 15,
	);
}

/**
 * US/international phone: +1-234-567-8901, (234) 567-8901, 234.567.8901, +44 20 7946 0958, etc.
 *
 * The pattern is tested on each run of phone characters with its whitespace removed, so spaced
 * formats match, international ones included. That is what testing it on the whole message with
 * its whitespace removed did, since the pattern holds phone characters only. The difference: a
 * digit group at the edge of a run that touches a letter or an underscore belongs to that word, and
 * is left out. So digits inside an identifier are not a phone (a tool call id such as
 * `toolu_1234567890123abc`, or `ref-5558675309z`), while a number after one still is
 * ("SKU12 555 867 5309"). Those ids read as phones, and redaction then gave different ids the same
 * placeholder. A group of 16 or more digits is a token too: it splits the run, so no phone is read
 * from part of it (`12345678901234567890`), unless it is a dial string. Each character is read a
 * bounded number of times, so the check is linear.
 */
function isPhoneNumber(value: string): boolean {
	PHONE_RUN_RE.lastIndex = 0;
	for (let run = PHONE_RUN_RE.exec(value); run !== null; run = PHONE_RUN_RE.exec(value)) {
		let start = run.index;
		let end = start + run[0].length;
		if (start > 0 && isWordChar(value.charCodeAt(start - 1))) {
			while (start < end && isAsciiDigit(value.charCodeAt(start))) start++;
		}
		if (end < value.length && isWordChar(value.charCodeAt(end))) {
			while (end > start && isAsciiDigit(value.charCodeAt(end - 1))) end--;
		}
		const rest = value
			.slice(start, end)
			.replace(OVERSIZED_DIGITS_RE, (group) => (isDialString(group) ? group : "|"))
			.replace(/\s+/g, "");
		if (PHONE_RE.test(rest)) return true;
	}
	return false;
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

/** An IPv4-shaped candidate: four numbers of 1-3 digits joined by dots. */
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/**
 * IPv4 address: 0-255.0-255.0-255.0-255.
 *
 * Every candidate is checked, not only the first, so an out-of-range one ("1.2.3.256") cannot hide
 * a real address after it. Candidates can overlap ("999.1.2.3.4" holds 1.2.3.4), so after a
 * rejected candidate the search resumes one character after its start, not after its end. A
 * candidate is at most 15 characters long, so the scan stays linear.
 */
function isIPv4(value: string): boolean {
	for (let from = 0; ; ) {
		IPV4_RE.lastIndex = from;
		const match = IPV4_RE.exec(value);
		if (match === null) return false;
		if (match.slice(1, 5).every((octet) => Number(octet) <= 255)) return true;
		from = match.index + 1;
	}
}

/**
 * Where a card number can be: a run of digit groups joined by spaces or dashes, with no word
 * character on either side.
 */
const CARD_RUN_RE = /(?<!\w)\d+(?:[\s-]+\d+)*(?!\w)/g;

/**
 * Credit card number detection: 13-19 digits that pass the Luhn check.
 *
 * Within each run of digit groups, every span of whole, adjacent groups holding 13-19 digits is
 * checked. So a number written beside a card cannot hide it by joining its run: an expiry
 * ("4111 1111 1111 1111 12 29") or a reference before it. A digit string with no separator is a
 * single group, so it is still checked only whole, and a long numeric id gains no card inside it.
 */
function isCreditCard(value: string): boolean {
	for (const run of value.matchAll(CARD_RUN_RE)) {
		if (hasLuhnSpan(run[0])) return true;
	}
	return false;
}

/** A digit's value when Luhn doubles it: twice the digit, less 9 when that has two digits. */
function luhnDoubled(d: number): number {
	return d < 5 ? d * 2 : d * 2 - 9;
}

/**
 * Whether some span of whole groups in `run` holds 13-19 digits and passes the Luhn check.
 *
 * Luhn doubles every second digit counting back from a span's last digit, which are the digits
 * whose index has the same parity as the span's end. So `sums[p][k]` adds up the run's first k
 * digits, doubling those whose index has parity p, and the Luhn sum of the span [a, b) is
 * `sums[b % 2][b] - sums[b % 2][a]`, one subtraction. A span starts and ends at a group boundary,
 * and every group holds at least one digit, so a start has at most 19 ends within reach and the
 * check is linear in the run.
 */
function hasLuhnSpan(run: string): boolean {
	const sums: [number[], number[]] = [[0], [0]];
	/** The digit index where each group starts, then the digit count. */
	const boundaries: number[] = [];
	let count = 0;
	let inGroup = false;
	for (let i = 0; i < run.length; i++) {
		const c = run.charCodeAt(i);
		if (c < 0x30 || c > 0x39) {
			inGroup = false;
			continue;
		}
		if (!inGroup) boundaries.push(count);
		inGroup = true;
		const d = c - 0x30;
		const doubledAtEven = count % 2 === 0 ? luhnDoubled(d) : d;
		const doubledAtOdd = count % 2 === 1 ? luhnDoubled(d) : d;
		sums[0].push((sums[0][count] as number) + doubledAtEven);
		sums[1].push((sums[1][count] as number) + doubledAtOdd);
		count++;
	}
	boundaries.push(count);
	for (let s = 0; s < boundaries.length - 1; s++) {
		const a = boundaries[s] as number;
		for (let e = s + 1; e < boundaries.length; e++) {
			const b = boundaries[e] as number;
			if (b - a > 19) break;
			if (b - a < 13) continue;
			const parity = sums[b % 2] as number[];
			if (((parity[b] as number) - (parity[a] as number)) % 10 === 0) return true;
		}
	}
	return false;
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

/** Where a JWT can start: `eyJ` after a word boundary. */
const JWT_START_RE = /\beyJ/g;

/** A whole JWT, tried only at a start `JWT_START_RE` found (sticky). */
const JWT_AT_RE = /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/y;

/** The segment class `[a-zA-Z0-9_-]`. */
function isJwtSegmentChar(c: number): boolean {
	return isAsciiAlnum(c) || c === 0x5f || c === 0x2d;
}

/**
 * JWT token: eyJ... header.payload.signature. Exactly what
 * `/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/` matches. As one regex it
 * was tried from every start, and a start's header ran to the end of its segment-class run before
 * failing on the missing `.`; `-eyJ-eyJ-eyJ…` is one such run with a start every four characters,
 * so it took time in N squared (1M characters: minutes).
 *
 * The header is the whole segment-class run after `eyJ`, because it must be followed by a `.`,
 * which the class does not contain. Every later start inside that run therefore ends its header
 * at the same `.` with a shorter header and the same payload and signature after it, so it fails
 * whenever this start fails, and the search resumes at the end of the run. Each run is then read
 * a bounded number of times (as a header, a payload, a signature), so the scan is linear.
 */
function isJwt(value: string): boolean {
	let from = 0;
	for (;;) {
		JWT_START_RE.lastIndex = from;
		const start = JWT_START_RE.exec(value);
		if (start === null) return false;
		JWT_AT_RE.lastIndex = start.index;
		if (JWT_AT_RE.test(value)) return true;
		let end = start.index + 3;
		while (end < value.length && isJwtSegmentChar(value.charCodeAt(end))) end++;
		from = end;
	}
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
	// Long hex strings — require at least one digit and one letter to avoid false positives. Every
	// candidate is checked, so a run of letters or of digits alone cannot hide a real one after it.
	for (const match of value.matchAll(/\b[0-9a-fA-F]{64,}\b/g)) {
		if (/[0-9]/.test(match[0]) && /[a-fA-F]/.test(match[0])) return true;
	}
	return false;
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
	return detectIn(data, false);
}

function detectIn(data: unknown, signalSent: boolean): PIIDetection {
	const types = new Set<string>();
	const paths: string[] = [];

	scanValue(data, "", types, paths, signalSent);

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

/**
 * THE CLOSED ALLOWLIST, in one place: the opaque, text-free types that redaction keeps BY
 * REFERENCE and the scan does not walk into. Today: `AbortSignal` only. Flattening it into
 * a plain object (what the generic walk does) made it `{}`, so a redacted request could no
 * longer be cancelled. Binary values (ArrayBuffer, typed arrays, DataView, Blob/File) are
 * deliberately NOT here: they carry content this scanner cannot read, so they keep today's
 * behaviour (flattened by redaction).
 *
 * Each member is recognised by BRAND, never by duck-typing, and without running caller code: an
 * AbortSignal by `isRealAbortSignal` (shared/abort-signal.ts), the same predicate the governor uses
 * to leave the transport's signal out of its serialization check, so neither a look-alike
 * (`{ aborted: false, addEventListener() {} }`), a Proxy, nor an object made from the prototype
 * with no signal state (`Object.create(AbortSignal.prototype)`) is kept.
 */
const OPAQUE_TEXT_FREE: ReadonlyArray<(value: object) => boolean> = [(v) => isRealAbortSignal(v)];

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

/**
 * Every strict prefix of a transport slot ("config" for "config.abortSignal"): an object reached
 * there may hold a slot, so its clone depends on WHERE it is walked, not only on what it is.
 */
const TRANSPORT_PREFIXES: ReadonlySet<string> = new Set(
	[...TRANSPORT_SLOTS].flatMap((slot) => {
		const parts = slot.split(".");
		return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("."));
	}),
);

/**
 * Kept by reference and not walked: the transport's value at a transport position. By default
 * that is an opaque, text-free value (`isOpaqueTextFree`).
 *
 * `signalSent` is the caller's statement that the value walked is a request whose transport slot
 * goes to the transport and is never serialized: the governor's Google request, whose SDK hands
 * `config.abortSignal` to its HTTP layer as it is. There a real signal is kept whatever own fields
 * it carries, because none of them is sent (the governor's serialization check leaves it out for
 * the same reason). Walking it instead flattened it into a plain object the transport rejects, and
 * a cycle among its fields never ended the scan. Everywhere else (an action's audit copy, the
 * public `detectPII`) a value is kept only when it has no own string-named field at all.
 */
function keptByReference(value: unknown, path: string, signalSent: boolean): boolean {
	if (!TRANSPORT_SLOTS.has(path) || value === null || typeof value !== "object") return false;
	return signalSent ? isRealAbortSignal(value) : isOpaqueTextFree(value);
}

function scanValue(
	value: unknown,
	currentPath: string,
	types: Set<string>,
	paths: string[],
	signalSent: boolean,
): void {
	if (typeof value === "string") {
		scanString(value, currentPath, types, paths);
		return;
	}

	// The transport's value at a transport position is not walked (see keptByReference).
	if (keptByReference(value, currentPath, signalSent)) return;

	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const itemPath = currentPath ? `${currentPath}[${i}]` : `[${i}]`;
			scanValue(value[i], itemPath, types, paths, signalSent);
		}
		return;
	}

	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			const fieldPath = currentPath ? `${currentPath}.${key}` : key;
			scanValue(record[key], fieldPath, types, paths, signalSent);
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

/** How a redaction walk treats the request's transport slot (see `keptByReference`). */
export interface RedactOptions {
	/**
	 * The data is a request whose transport slot is handed to the transport and never serialized
	 * (the governor's Google request): a real AbortSignal there is kept by reference whatever own
	 * fields it carries. Default `false`: kept only with no own string-named field.
	 */
	signalSent?: boolean;
}

/**
 * Deep-clone data and replace detected PII values with redacted placeholders.
 * Returns both the redacted data and the detection metadata.
 */
export function redactPII(data: unknown, options: RedactOptions = {}): RedactedData {
	const signalSent = options.signalSent === true;
	const detection = detectIn(data, signalSent);
	if (!detection.found) {
		return { data, detection };
	}
	const redacted = redactValue(data, "", {
		anywhere: new WeakMap(),
		atPrefix: new Map(),
		signalSent,
	});
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

/**
 * Return matched PII type names for a string value. Built with `filter` / `map`, which define each
 * element rather than assign it, so an index setter on Array.prototype cannot swallow a name.
 */
function matchedTypes(value: string): string[] {
	return PII_PATTERNS.filter((pattern) => pattern.test(value)).map((pattern) => pattern.type);
}

function defineData(obj: object, key: string, value: unknown, enumerable: boolean): void {
	Object.defineProperty(obj, key, { value, writable: true, enumerable, configurable: true });
}

/**
 * The clones made so far in one redaction walk. `anywhere` maps each object or array to its clone,
 * registered BEFORE its properties are walked, so a revisit (a cycle, such as a hidden
 * back-reference to a parent, or one object referenced twice) answers that clone: the copy keeps
 * the original's shape and the walk always ends. At a prefix of a transport slot the clone depends
 * on the path (walked there, it keeps the signal by reference; walked anywhere else, the signal is
 * flattened), so reuse never crosses that line, in either direction: at such a path only a clone
 * made at that same path is answered, from `atPrefix`, and a clone made there is never answered
 * anywhere else. Finitely many prefixes exist, so a cycle through one still ends.
 */
interface Clones {
	anywhere: WeakMap<object, unknown>;
	atPrefix: Map<string, WeakMap<object, unknown>>;
	/** The transport rule this walk was asked for (`RedactOptions.signalSent`). */
	signalSent: boolean;
}

function cachedClone(clones: Clones, value: object, path: string): unknown {
	return TRANSPORT_PREFIXES.has(path)
		? clones.atPrefix.get(path)?.get(value)
		: clones.anywhere.get(value);
}

function registerClone(clones: Clones, value: object, path: string, clone: unknown): void {
	if (!TRANSPORT_PREFIXES.has(path)) {
		clones.anywhere.set(value, clone);
		return;
	}
	let atPath = clones.atPrefix.get(path);
	if (atPath === undefined) {
		atPath = new WeakMap();
		clones.atPrefix.set(path, atPath);
	}
	atPath.set(value, clone);
}

/** Recursively traverse data and replace PII strings with redacted placeholders. */
function redactValue(value: unknown, path: string, clones: Clones): unknown {
	if (typeof value === "string") {
		const types = matchedTypes(value);
		if (types.length > 0) {
			return `[REDACTED:${types.join(",")}]`;
		}
		return value;
	}

	if (Array.isArray(value)) {
		const clone = cachedClone(clones, value, path);
		if (clone !== undefined) return clone;
		// Built by index, not with `map`, so the clone is registered before its items are walked. As
		// with `map`: the length read once, a hole stays a hole, and each item is an own property.
		const length = value.length;
		const result: unknown[] = new Array(length);
		registerClone(clones, value, path, result);
		for (let i = 0; i < length; i++) {
			// Defined, never assigned: an index setter on Array.prototype must not swallow the item.
			if (i in value)
				defineData(result, String(i), redactValue(value[i], `${path}[${i}]`, clones), true);
		}
		return result;
	}

	// The transport's value at a transport position is kept BY REFERENCE (see keptByReference).
	if (keptByReference(value, path, clones.signalSent)) return value;

	if (value !== null && typeof value === "object") {
		// Looked up only after the transport check: the same signal is kept by reference at its
		// transport slot even when it was flattened where it appeared earlier.
		const clone = cachedClone(clones, value, path);
		if (clone !== undefined) return clone;
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		registerClone(clones, value, path, result);
		// Every key is DEFINED, never assigned: an own "__proto__" key (as JSON.parse makes one) stays
		// a key of the clone instead of becoming its prototype.
		for (const key of Object.keys(record)) {
			defineData(
				result,
				key,
				redactValue(record[key], path === "" ? key : `${path}.${key}`, clones),
				true,
			);
		}
		// A non-enumerable own DATA property stays one, redacted, so a consumer that reads the request
		// by name still finds the field, and JSON.stringify still skips it. Data only: a function (a
		// hidden `toJSON` hook) is never carried into the clone, where serializing would run it; an
		// accessor is never invoked.
		for (const key of Object.getOwnPropertyNames(record)) {
			const d = Object.getOwnPropertyDescriptor(record, key);
			if (d === undefined || d.enumerable === true || !("value" in d)) continue;
			if (typeof d.value === "function") continue;
			defineData(
				result,
				key,
				redactValue(d.value, path === "" ? key : `${path}.${key}`, clones),
				false,
			);
		}
		return result;
	}

	return value;
}
