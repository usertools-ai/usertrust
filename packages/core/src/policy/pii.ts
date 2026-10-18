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

/**
 * An extension written right after a phone number: x, ext or ext., optional whitespace, then 1-6
 * digits that end the token ("555-867-5309x123", "…5309 ext. 12"). Tried where a run of phone
 * characters stops at a letter.
 */
const EXTENSION_RE = /(?:x|ext\.?)\s*\d{1,6}(?![A-Za-z0-9_])/iy;

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
 * from part of it (`12345678901234567890`), unless it is a dial string. A letter that starts an
 * extension (`x123`, `ext12`) does not glue the number before it. Each character is read a
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
			EXTENSION_RE.lastIndex = end;
			if (!EXTENSION_RE.test(value)) {
				while (end > start && isAsciiDigit(value.charCodeAt(end - 1))) end--;
			}
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

/** 5.0.4's card candidate: 13-24 characters of digits, whitespace and dashes, a digit at each end. */
const CARD_CANDIDATE_RE = /\b[\d][\d\s-]{11,22}[\d]\b/g;

/**
 * Credit card number detection: 13-19 digits that pass the Luhn check, found two ways.
 *
 * 1. 5.0.4's check, unchanged: each candidate with its separators removed. Nothing it found is lost.
 * 2. A card printed in a card's layout, which (1) misses when an adjacent number joins its
 *    candidate: a dashed card beside its expiry ("4111-1111-1111-1111 12/29"). See
 *    `hasCardInLayout`.
 */
function isCreditCard(value: string): boolean {
	return hasCardCandidate(value) || hasCardInLayout(value);
}

/** 5.0.4's check: some candidate, its whitespace and dashes removed, has 13-19 digits and passes Luhn. */
function hasCardCandidate(value: string): boolean {
	CARD_CANDIDATE_RE.lastIndex = 0;
	for (let m = CARD_CANDIDATE_RE.exec(value); m !== null; m = CARD_CANDIDATE_RE.exec(value)) {
		const digits = m[0].replace(/[\s-]/g, "");
		if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
	}
	return false;
}

/** A digit's value when Luhn doubles it: twice the digit, less 9 when that has two digits. */
function luhnDoubled(d: number): number {
	return d < 5 ? d * 2 : d * 2 - 9;
}

/** The Luhn check over a string of digits: every second digit from the right doubled, sum % 10 === 0. */
function luhnValid(digits: string): boolean {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		const d = digits.charCodeAt(digits.length - 1 - i) - 0x30;
		sum += i % 2 === 1 ? luhnDoubled(d) : d;
	}
	return sum % 10 === 0;
}

/**
 * The group lengths a card number is printed in: 4-4-4-4 (16 digits), 4-4-4 then 1-3 (13-15, as
 * in the Diners Club test number 3056 9309 0259 04), 4-4-4-4 then 1-3 more (17-19), 4-6-5 (15,
 * American Express) and 4-6-4 (14, Diners Club).
 */
const CARD_LAYOUTS: ReadonlyArray<Int32Array> = [
	Int32Array.of(4, 4, 4, 1),
	Int32Array.of(4, 4, 4, 2),
	Int32Array.of(4, 4, 4, 3),
	Int32Array.of(4, 4, 4, 4),
	Int32Array.of(4, 4, 4, 4, 1),
	Int32Array.of(4, 4, 4, 4, 2),
	Int32Array.of(4, 4, 4, 4, 3),
	Int32Array.of(4, 6, 5),
	Int32Array.of(4, 6, 4),
];

/** The most groups a layout has. A longer chain is never a card. */
const LAYOUT_GROUPS = 5;

/** What joins a card's groups: one space (kind 0) or one dash (kind 1). */
const CARD_SEPARATORS = Int32Array.of(0x20, 0x2d);

/**
 * Whether the text holds a card printed in a card's layout: a WHOLE chain of digit groups, each
 * joined to the next by exactly one space, or each by exactly one dash, whose group lengths are
 * one of CARD_LAYOUTS; or one group of 13-19 digits. No letter, digit or underscore may touch
 * either end, and the digits must pass Luhn.
 *
 * The whole chain, never a window inside it: any four of a list of four-digit numbers pass Luhn
 * one time in ten, so a list of them would read as a card. A chain of six groups or more is never
 * one. A chain ends where the separator changes, so in "4111-1111-1111-1111 12/29" the dashed card
 * is one chain and the space before the expiry starts another.
 *
 * One pass over the text. Per separator kind, the current chain's first five groups are kept in
 * typed arrays, so nothing inherited from Array.prototype is read or written; each chain is
 * checked once, when it ends, so the check is linear and never recurses.
 */
function hasCardInLayout(value: string): boolean {
	const n = value.length;
	const chainStarts = [new Int32Array(LAYOUT_GROUPS), new Int32Array(LAYOUT_GROUPS)] as const;
	const chainEnds = [new Int32Array(LAYOUT_GROUPS), new Int32Array(LAYOUT_GROUPS)] as const;
	const chainSizes = new Int32Array(2);
	const chainGluedAfter = new Uint8Array(2);
	const chainIsCard = (kind: 0 | 1): boolean =>
		wholeChainIsCard(
			value,
			chainStarts[kind],
			chainEnds[kind],
			chainSizes[kind] as number,
			chainGluedAfter[kind] === 1,
		);
	let previousEnd = -1;
	let i = 0;
	while (i < n) {
		if (!isAsciiDigit(value.charCodeAt(i))) {
			i++;
			continue;
		}
		const start = i;
		while (i < n && isAsciiDigit(value.charCodeAt(i))) i++;
		const gluedBefore = start > 0 && isWordChar(value.charCodeAt(start - 1));
		const gluedAfter = i < n && isWordChar(value.charCodeAt(i));
		const length = i - start;
		if (length >= 13 && length <= 19 && !gluedBefore && !gluedAfter) {
			if (luhnValid(value.slice(start, i))) return true;
		}
		const joinedBy =
			previousEnd >= 0 && start - previousEnd === 1 ? value.charCodeAt(previousEnd) : -1;
		for (let k = 0; k < 2; k++) {
			const kind = k as 0 | 1;
			let size = chainSizes[kind] as number;
			if (joinedBy !== CARD_SEPARATORS[kind]) {
				// This group starts a new chain of this kind: the one before it has ended.
				if (chainIsCard(kind)) return true;
				size = 0;
			}
			if (size < LAYOUT_GROUPS) {
				chainStarts[kind][size] = start;
				chainEnds[kind][size] = i;
			}
			chainSizes[kind] = Math.min(size + 1, LAYOUT_GROUPS + 1);
			chainGluedAfter[kind] = gluedAfter ? 1 : 0;
		}
		previousEnd = i;
	}
	return chainIsCard(0) || chainIsCard(1);
}

/** Whether a whole chain of `size` groups is a card: a card's layout, untouched at both ends, Luhn. */
function wholeChainIsCard(
	value: string,
	starts: Int32Array,
	ends: Int32Array,
	size: number,
	gluedAfter: boolean,
): boolean {
	if (size < 3 || size > LAYOUT_GROUPS || gluedAfter) return false;
	const first = starts[0] as number;
	if (first > 0 && isWordChar(value.charCodeAt(first - 1))) return false;
	for (const layout of CARD_LAYOUTS) {
		if (layout.length !== size) continue;
		let fits = true;
		for (let g = 0; g < size && fits; g++) {
			fits = (ends[g] as number) - (starts[g] as number) === layout[g];
		}
		if (!fits) continue;
		let digits = "";
		for (let g = 0; g < size; g++) digits += value.slice(starts[g] as number, ends[g] as number);
		return luhnValid(digits);
	}
	return false;
}

/** A payload holds a letter or a digit: a run of dashes or underscores alone is not a key. */
const HAS_ALNUM_RE = /[A-Za-z0-9]/;

/**
 * A payload holds a capital letter. Applied to the prefixes 5.0.5 added: a real token's random
 * characters almost surely hold one (20 random base64url characters lack one about once in 30,000
 * tokens, and longer tokens far less often), while a lowercase kebab-case name after a prefix
 * holds none, even with a version number in it (`glrt-runner-registration-walkthrough`,
 * `xapp-config-service-production-v2`).
 */
const HAS_CAPITAL_RE = /[A-Z]/;

/**
 * Whether some match of `re` (global, its payload in the first group that matched) has a payload
 * that passes `payloadOk`. A failed match is skipped whole: a later start inside its payload sees
 * the same characters, so it fails too, and the scan stays linear.
 */
function hasPrefixedToken(
	value: string,
	re: RegExp,
	payloadOk: RegExp | ((payload: string) => boolean),
): boolean {
	const ok = typeof payloadOk === "function" ? payloadOk : (p: string) => payloadOk.test(p);
	re.lastIndex = 0;
	for (let m = re.exec(value); m !== null; m = re.exec(value)) {
		const payload = m[1] ?? m[2] ?? "";
		if (ok(payload)) return true;
	}
	return false;
}

/**
 * A payload of at least four distinct characters. Applied to the prefixes 5.0.5 and 5.0.6 add, not
 * to those released before: a real key's random characters always pass, while a placeholder of one
 * repeated character, or a few (`gsk_xxxx…`, an `.env.example` value), does not.
 */
function hasVariedPayload(payload: string): boolean {
	return new Set(payload).size >= 4;
}

/** A capital and at least four distinct characters: the guard for the prefixes 5.0.5 added. */
function hasVariedCapitalPayload(payload: string): boolean {
	return HAS_CAPITAL_RE.test(payload) && hasVariedPayload(payload);
}

/**
 * API keys released before: sk-... (OpenAI, Anthropic), and Stripe's sk_live_ and sk_test_. No
 * closing `\b`, since the payload can hold `-` and a key whose characters end in `-` has no word
 * boundary there; instead the payload must hold a letter or a digit.
 */
const API_KEY_RE = /\b(?:sk-|sk_(?:live|test)_)([a-zA-Z0-9_-]{20,})/g;

/** Stripe's restricted keys (rk_live_, rk_test_) and organization keys (sk_org_). */
const NEW_API_KEY_RE = /\b(?:rk_(?:live|test)_|sk_org_)([a-zA-Z0-9_-]{20,})/g;

/**
 * A Google API key: AIza, then exactly 35 letters, digits, `_` and `-`, and no further token
 * character (Google's docs show one, `AIzaSy…`, 39 characters in all, and describe the string as
 * upper and lower case letters, numbers, underscores and hyphens).
 */
const GOOGLE_API_KEY_RE = /\bAIza([A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/g;

/**
 * xAI (xai-), Groq (gsk_) and Perplexity (pplx-) API keys: the prefix, then a run of letters and
 * digits, 20 or more (16 for Perplexity), that is the whole run of token characters after it: no
 * `-` or `_` joins another word on. Their docs show the prefix (xAI `xai-...`, Groq `gsk_...`) or
 * a placeholder of letters and digits (Perplexity's: `pplx-`, then 16 of them), not a full format,
 * so a kebab-case name after the prefix is a name, not a key, however long its first word.
 */
const PROVIDER_API_KEY_RE =
	/\b(?:(?:xai-|gsk_)([A-Za-z0-9]{20,})|pplx-([A-Za-z0-9]{16,}))(?![A-Za-z0-9_-])/g;

/**
 * API key: sk-... (OpenAI, Anthropic), a Stripe secret, restricted or organization key, or a
 * Google, xAI, Groq or Perplexity key.
 */
function isApiKey(value: string): boolean {
	return (
		hasPrefixedToken(value, API_KEY_RE, HAS_ALNUM_RE) ||
		hasPrefixedToken(value, NEW_API_KEY_RE, hasVariedCapitalPayload) ||
		hasPrefixedToken(value, GOOGLE_API_KEY_RE, hasVariedPayload) ||
		hasPrefixedToken(value, PROVIDER_API_KEY_RE, hasVariedPayload)
	);
}

/**
 * A temporary AWS access key id (from STS): ASIA then 16 base32 characters, the alphabet AWS key
 * ids are written in, so a word such as `ASIA` then `PACIFICREGION001` is not one.
 */
const AWS_TEMPORARY_KEY_RE = /\bASIA([A-Z2-7]{16})\b/g;

/**
 * AWS access key id: AKIA (long-term) then 16 uppercase alphanumerics, as released; or a temporary
 * one, its 16 characters holding at least four distinct ones.
 */
function isAwsKey(value: string): boolean {
	return (
		/\bAKIA[0-9A-Z]{16}\b/.test(value) ||
		hasPrefixedToken(value, AWS_TEMPORARY_KEY_RE, hasVariedPayload)
	);
}

/** GitHub's prefixes as released: ghp_, gho_, ghs_, ghr_, github_pat_, then 22+ alphanumerics. */
const GITHUB_TOKEN_RE = /\b(?:ghp_|gho_|ghs_|ghr_|github_pat_)[a-zA-Z0-9]{22,}\b/;

/**
 * A fine-grained personal access token: github_pat_, 22 alphanumerics, `_`, then 59. The `_` is a
 * word character, so the released form's closing `\b` never matched inside one.
 */
const GITHUB_FINE_GRAINED_RE = /\bgithub_pat_([a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})/g;

/** A user access token for a GitHub App: ghu_ then 22+ alphanumerics. */
const GITHUB_USER_TOKEN_RE = /\bghu_([a-zA-Z0-9]{22,})\b/g;

/** Where a stateless installation token can start: ghs_, the app id, `_`, then a JWT's `eyJ`. */
const GITHUB_STATELESS_START_RE = /\bghs_[0-9]+_(?=eyJ)/g;

/** The JWT after it: three base64url segments, tried at the `eyJ` (sticky). */
const GITHUB_STATELESS_JWT_RE = /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/y;

/**
 * A stateless installation token, `ghs_<app id>_<JWT>`: the prefix and a whole JWT after it, so
 * `ghs_1_eyJ` alone is not one, and the JWT's characters after `eyJ`, its dots aside, holding at
 * least four distinct ones. Where the JWT fails, the search resumes at the end of its run of
 * segment characters: a later start inside that run is followed by the same characters, so its
 * JWT has the same end and a subset of these characters, and it fails too. Each run is read a
 * bounded number of times, so the check is linear.
 */
function hasStatelessInstallationToken(value: string): boolean {
	let from = 0;
	for (;;) {
		GITHUB_STATELESS_START_RE.lastIndex = from;
		const start = GITHUB_STATELESS_START_RE.exec(value);
		if (start === null) return false;
		const jwtAt = start.index + start[0].length;
		GITHUB_STATELESS_JWT_RE.lastIndex = jwtAt;
		if (
			GITHUB_STATELESS_JWT_RE.test(value) &&
			hasVariedPayload(value.slice(jwtAt + 3, GITHUB_STATELESS_JWT_RE.lastIndex).replace(/\./g, ""))
		) {
			return true;
		}
		let end = jwtAt;
		while (end < value.length && isJwtSegmentChar(value.charCodeAt(end))) end++;
		from = end;
	}
}

/**
 * GitHub token, by the prefixes GitHub documents for each type: ghp_ (classic personal access
 * token), gho_ (OAuth), ghs_ (installation access token), ghr_ (refresh token) and github_pat_, as
 * released; the fine-grained form; ghu_ (user access token for an app); and the stateless
 * installation token.
 */
function isGithubToken(value: string): boolean {
	return (
		GITHUB_TOKEN_RE.test(value) ||
		hasPrefixedToken(value, GITHUB_FINE_GRAINED_RE, hasVariedPayload) ||
		hasPrefixedToken(value, GITHUB_USER_TOKEN_RE, hasVariedCapitalPayload) ||
		hasStatelessInstallationToken(value)
	);
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

/**
 * Secret prefixes released before: Slack's xoxb-, xoxp-, xoxa-, xoxr-, xoxs- (a rotating token,
 * xoxe.xoxb- or xoxe.xoxp-, is matched by its inner prefix); SendGrid's SG.; GitLab's glpat-. No
 * closing `\b`, since the payload can hold `-` and one that ends in `-` has no word boundary there
 * (a SendGrid key whose first part ends `---` read as clean); instead the payload must hold a
 * letter or a digit. A Slack payload never holds `_`, so no word character may follow one:
 * `xoxb-service_policy_production` is a name, as 5.0.4 read it.
 */
const SECRET_PREFIX_RE =
	/\b(?:xox[bpars]-([a-zA-Z0-9-]+)(?!\w)|(?:SG\.|glpat-)([a-zA-Z0-9_-]{20,}))/g;

/** npm's access tokens: npm_ then letters and digits, so the closing `\b` stays. */
const NPM_TOKEN_RE = /\bnpm_[a-zA-Z0-9]{36,}\b/;

/**
 * Slack's prefixes 5.0.5 added: xapp- (app-level; rotating ones as xoxe.xapp-), xwfp- (workflow)
 * and xoxe-<n>- (the refresh token that rotation issues). The payload holds a capital and at least
 * four distinct characters.
 */
const SLACK_NEW_PREFIX_RE = /\b(?:xapp|xwfp|xoxe-[0-9])-([a-zA-Z0-9-]{20,})(?!\w)/g;

/**
 * GitLab's prefixes 5.0.5 added: the token types GitLab documents besides glpat- (OAuth
 * application secret, deploy, runner, CI/CD job, trigger, feed, incoming mail, agent, workspace,
 * SCIM, feature flags client). The payload holds a capital and at least four distinct characters.
 */
const GITLAB_NEW_PREFIX_RE =
	/\bgl(?:oas|dt|rtr?|cbt|ptt|ft|imt|agent|wt|soat|ffct)-([a-zA-Z0-9_-]{20,})/g;

/**
 * A webhook signing secret: whsec_, then base64 of 24 to 64 bytes (32 or more characters), as the
 * Standard Webhooks specification serializes one; Stripe's are 32 letters and digits. It must be
 * the whole run of token characters after the prefix, so a snake_case name after the prefix is a
 * name, not a secret, however long its first word.
 */
const WEBHOOK_SECRET_RE = /\bwhsec_([A-Za-z0-9+/]{32,}={0,2})(?![A-Za-z0-9+/=_-])/g;

/** Generic secret: known prefixes, or long hex strings (64+ chars). */
function isGenericSecret(value: string): boolean {
	// Note: sk- and sk_ prefixes handled by isApiKey — not duplicated here
	if (
		hasPrefixedToken(value, SECRET_PREFIX_RE, HAS_ALNUM_RE) ||
		NPM_TOKEN_RE.test(value) ||
		hasPrefixedToken(value, SLACK_NEW_PREFIX_RE, hasVariedCapitalPayload) ||
		hasPrefixedToken(value, GITLAB_NEW_PREFIX_RE, hasVariedCapitalPayload) ||
		hasPrefixedToken(value, WEBHOOK_SECRET_RE, hasVariedPayload)
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

	scanValue(data, types, paths, signalSent);

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

/** The longest transport path. A longer path is none of them. */
const TRANSPORT_PATH_MAX = Math.max(...[...TRANSPORT_SLOTS].map((slot) => slot.length));

/**
 * Whether `path` is in `paths` (TRANSPORT_SLOTS or TRANSPORT_PREFIXES), answered by its length
 * alone when it is longer than any of them. Each level of a walk builds its path from its parent's,
 * and looking a path up in a set hashes its characters, so without this a walk thousands of levels
 * deep spent most of its time rehashing paths (6,250 levels: about 100 times slower).
 */
function isTransportPath(paths: ReadonlySet<string>, path: string): boolean {
	return path.length <= TRANSPORT_PATH_MAX && paths.has(path);
}

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
	if (!isTransportPath(TRANSPORT_SLOTS, path) || value === null || typeof value !== "object") {
		return false;
	}
	return signalSent ? isRealAbortSignal(value) : isOpaqueTextFree(value);
}

/** An array or object being scanned: its children are read one at a time, in order. */
type ScanFrame =
	| { kind: "array"; items: unknown[]; path: string; next: number; below: ScanFrame | undefined }
	| {
			kind: "object";
			record: Record<string, unknown>;
			keys: string[];
			path: string;
			next: number;
			below: ScanFrame | undefined;
	  };

/**
 * Scan `root` and everything under it: each string is scanned at its dot-path, in the order a
 * depth-first walk reaches it (an array's items by index, an object's enumerable keys in order).
 *
 * The walk keeps its own stack of frames, linked one to the next, instead of recursing: nesting a
 * few thousand levels deep (about 20 KB of JSON) exhausted the call stack, and detection threw.
 * The frames are linked objects, not an array, so an index setter on Array.prototype cannot
 * swallow one. Each child is read when its turn comes, as before, so getters run in the same order.
 * An object already open on the current path (an enumerable cycle) is not entered again: the
 * recursion never ended there either, and threw.
 */
function scanValue(root: unknown, types: Set<string>, paths: string[], signalSent: boolean): void {
	let top: ScanFrame | undefined;
	const open = new Set<object>();
	const visit = (value: unknown, path: string): void => {
		if (typeof value === "string") {
			scanString(value, path, types, paths);
			return;
		}
		// The transport's value at a transport position is not walked (see keptByReference).
		if (keptByReference(value, path, signalSent)) return;
		if (value === null || typeof value !== "object" || open.has(value)) return;
		open.add(value);
		if (Array.isArray(value)) {
			top = { kind: "array", items: value, path, next: 0, below: top };
		} else {
			const record = value as Record<string, unknown>;
			top = { kind: "object", record, keys: Object.keys(record), path, next: 0, below: top };
		}
	};
	visit(root, "");
	while (top !== undefined) {
		const frame = top;
		if (frame.kind === "array" && frame.next < frame.items.length) {
			const i = frame.next++;
			visit(frame.items[i], frame.path ? `${frame.path}[${i}]` : `[${i}]`);
			continue;
		}
		if (frame.kind === "object" && frame.next < frame.keys.length) {
			const key = frame.keys[frame.next++] as string;
			visit(frame.record[key], frame.path ? `${frame.path}.${key}` : key);
			continue;
		}
		open.delete(frame.kind === "array" ? frame.items : frame.record);
		top = frame.below;
	}
}

/** Whether every character is ASCII: NFKC changes none of those, and no format character is one. */
function isAscii(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) > 0x7f) return false;
	}
	return true;
}

/** A format character (Unicode category Cf): zero-width spaces and joiners, soft hyphens, bidi marks. */
const FORMAT_CHAR_RE = /^\p{Cf}$/u;

/** Only ASCII: the characters every pattern here reads. */
const ASCII_ONLY_RE = /^[ -~\t\n\r\f\v]+$/;

/** What the view does with a code point: not yet seen, keep it, remove it, or replace it. */
const KIND_UNSEEN = 0;
const KIND_KEEP = 1;
const KIND_REMOVE = 2;
const KIND_REPLACE = 3;

/**
 * Each code point's kind, found the first time it is seen. A fixed table (1.1 MB), so no input can
 * grow it; the replacements hold only the code points whose NFKC form is ASCII (1,439 under Unicode
 * 16, 1,440 under 17).
 */
const CODE_POINT_KIND = new Uint8Array(0x110000);
const ASCII_FORM = new Map<number, string>();

function codePointKind(cp: number): number {
	let kind = CODE_POINT_KIND[cp] as number;
	if (kind !== KIND_UNSEEN) return kind;
	const c = String.fromCodePoint(cp);
	const form = c.normalize("NFKC");
	if (FORMAT_CHAR_RE.test(c)) kind = KIND_REMOVE;
	else if (form !== c && ASCII_ONLY_RE.test(form)) {
		kind = KIND_REPLACE;
		ASCII_FORM.set(cp, form);
	} else kind = KIND_KEEP;
	CODE_POINT_KIND[cp] = kind;
	return kind;
}

/**
 * The view each pattern is also tried on. Every pattern here reads ASCII, so the view is the string
 * with each format character (category Cf) removed and each character whose NFKC form is ASCII
 * replaced by that form: fullwidth letters and digits, the ideographic space, circled and
 * parenthesized numbers. A key with a zero-width space inside, or a key, card or phone number typed
 * in fullwidth forms (as an input method may type it), reads as the plain value there. Any other
 * character stays as it is. One pass; no character becomes more than 4 (`VIII`, `(10)`), so the
 * view is never more than four times the string, where NFKC itself can make one character 18
 * (U+FDFA). ASCII text is its own view, and is returned as it is.
 */
export function normalizedView(value: string): string {
	if (isAscii(value)) return value;
	let out = "";
	let from = 0;
	for (let i = 0; i < value.length; ) {
		const cp = value.codePointAt(i) as number;
		const width = cp > 0xffff ? 2 : 1;
		if (cp > 0x7f) {
			const kind = codePointKind(cp);
			if (kind !== KIND_KEEP) {
				out += value.slice(from, i);
				if (kind === KIND_REPLACE) out += ASCII_FORM.get(cp) as string;
				from = i + width;
			}
		}
		i += width;
	}
	return from === 0 ? value : out + value.slice(from);
}

/**
 * Whether `pattern` matches `value` or its normalized view `view`. A value flagged before is still
 * flagged; the view only adds. Either way the whole value is what redaction replaces.
 */
function matches(pattern: PIIPattern, value: string, view: string): boolean {
	return pattern.test(value) || (view !== value && pattern.test(view));
}

function scanString(value: string, currentPath: string, types: Set<string>, paths: string[]): void {
	const view = normalizedView(value);
	for (const pattern of PII_PATTERNS) {
		if (matches(pattern, value, view)) {
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
	const redacted = redactValue(data, {
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
	const view = normalizedView(value);
	return PII_PATTERNS.filter((pattern) => matches(pattern, value, view)).map(
		(pattern) => pattern.type,
	);
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
	return isTransportPath(TRANSPORT_PREFIXES, path)
		? clones.atPrefix.get(path)?.get(value)
		: clones.anywhere.get(value);
}

function registerClone(clones: Clones, value: object, path: string, clone: unknown): void {
	if (!isTransportPath(TRANSPORT_PREFIXES, path)) {
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

/**
 * A container being copied: its clone (registered before any child is walked) and where the walk
 * is. An array's items by index, holes kept; an object's enumerable keys, then its own property
 * names (`hidden`, listed when the enumerable keys are done), of which only non-enumerable data
 * properties are copied.
 */
type RedactFrame =
	| {
			kind: "array";
			source: unknown[];
			clone: unknown[];
			length: number;
			path: string;
			next: number;
			below: RedactFrame | undefined;
	  }
	| {
			kind: "object";
			source: Record<string, unknown>;
			clone: Record<string, unknown>;
			keys: string[];
			hidden: string[] | undefined;
			/** The next of `hidden`, a cursor of its own: `next` stays past the enumerable keys. */
			nextHidden: number;
			path: string;
			next: number;
			below: RedactFrame | undefined;
	  };

/**
 * Copy `root` with each PII string replaced by its placeholder. The same copy the recursive walk
 * made, built on an explicit stack of linked frames, so a deeply nested value no longer exhausts
 * the call stack and throws:
 * - a string matching a pattern becomes `[REDACTED:<types>]`, any other value stays as it is;
 * - an array is copied by index (its length read once, a hole kept a hole), an object by its
 *   enumerable keys, then its non-enumerable own data properties, redacted and still
 *   non-enumerable; a function there (a hidden `toJSON` hook) is never carried into the copy,
 *   and an accessor is never invoked;
 * - each property is DEFINED on the copy, never assigned, so an index setter on Array.prototype
 *   cannot swallow an item and an own "__proto__" key stays a key;
 * - each clone is registered before its children are walked, so a revisit (a cycle, or one object
 *   referenced twice) answers that clone and the walk ends;
 * - the transport's value at a transport position is kept by reference (see keptByReference),
 *   checked after the array case and before the object case, as before.
 */
function redactValue(root: unknown, clones: Clones): unknown {
	let top: RedactFrame | undefined;
	const copy = (value: unknown, path: string): unknown => {
		if (typeof value === "string") {
			const types = matchedTypes(value);
			return types.length > 0 ? `[REDACTED:${types.join(",")}]` : value;
		}
		if (Array.isArray(value)) {
			const cached = cachedClone(clones, value, path);
			if (cached !== undefined) return cached;
			const length = value.length;
			const clone: unknown[] = new Array(length);
			registerClone(clones, value, path, clone);
			top = { kind: "array", source: value, clone, length, path, next: 0, below: top };
			return clone;
		}
		if (keptByReference(value, path, clones.signalSent)) return value;
		if (value !== null && typeof value === "object") {
			// Looked up only after the transport check: the same signal is kept by reference at its
			// transport slot even when it was flattened where it appeared earlier.
			const cached = cachedClone(clones, value, path);
			if (cached !== undefined) return cached;
			const source = value as Record<string, unknown>;
			const clone: Record<string, unknown> = {};
			registerClone(clones, value, path, clone);
			const keys = Object.keys(source);
			top = {
				kind: "object",
				source,
				clone,
				keys,
				hidden: undefined,
				nextHidden: 0,
				path,
				next: 0,
				below: top,
			};
			return clone;
		}
		return value;
	};
	const childPath = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);
	const result = copy(root, "");
	while (top !== undefined) {
		const frame = top;
		if (frame.kind === "array") {
			if (frame.next < frame.length) {
				const i = frame.next++;
				if (i in frame.source) {
					defineData(frame.clone, String(i), copy(frame.source[i], `${frame.path}[${i}]`), true);
				}
				continue;
			}
		} else if (frame.next < frame.keys.length) {
			const key = frame.keys[frame.next++] as string;
			defineData(frame.clone, key, copy(frame.source[key], childPath(frame.path, key)), true);
			continue;
		} else {
			if (frame.hidden === undefined) {
				// The enumerable keys are done: list the own property names now, as the walk did.
				frame.hidden = Object.getOwnPropertyNames(frame.source);
			}
			if (frame.nextHidden < frame.hidden.length) {
				// Each one's descriptor is read once, in its turn. Only a non-enumerable DATA property
				// that is not a function is copied.
				const key = frame.hidden[frame.nextHidden++] as string;
				const d = Object.getOwnPropertyDescriptor(frame.source, key);
				if (
					d !== undefined &&
					d.enumerable !== true &&
					"value" in d &&
					typeof d.value !== "function"
				) {
					defineData(frame.clone, key, copy(d.value, childPath(frame.path, key)), false);
				}
				continue;
			}
		}
		top = frame.below;
	}
	return result;
}
