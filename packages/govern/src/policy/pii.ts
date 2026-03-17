/**
 * PII Detector
 *
 * Pattern-based PII detection for event payloads.
 * Recursively scans strings in objects/arrays and returns
 * which PII types were found and at which paths.
 *
 * Pure module — no side effects, no network calls.
 *
 * Detects: email, phone, SSN, credit card (Luhn-validated), IPv4.
 *
 * Adapted from Field Project fermion/src/higgs/pii-detector.ts.
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

/** US SSN: XXX-XX-XXXX (with dashes required to avoid false positives) */
function isSSN(value: string): boolean {
	return /\b\d{3}-\d{2}-\d{4}\b/.test(value);
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

const PII_PATTERNS: PIIPattern[] = [
	{ type: "email", test: isEmail },
	{ type: "phone", test: isPhoneNumber },
	{ type: "ssn", test: isSSN },
	{ type: "credit_card", test: isCreditCard },
	{ type: "ipv4", test: isIPv4 },
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

function scanValue(value: unknown, currentPath: string, types: Set<string>, paths: string[]): void {
	if (typeof value === "string") {
		scanString(value, currentPath, types, paths);
		return;
	}

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
