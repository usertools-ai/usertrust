// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Deterministic JSON canonicalization for hash computation.
 * Sorts object keys alphabetically at every nesting level.
 * Strips undefined OBJECT VALUES. Preserves null. Arrays keep order.
 *
 * The output IS the audit line — `chain.ts` persists these bytes verbatim — so
 * it must always be readable back. The governing rule: if JSON can represent
 * the value faithfully, represent it deterministically; if it cannot, THROW.
 * Never emit bytes that do not parse: one unparseable line dangles the next
 * event's `previousHash` forever, indistinguishable from real tampering.
 */
export function canonicalize(value: unknown): string {
	// Guard against values that JSON.stringify silently coerces to "null"
	if (typeof value === "number" && Number.isNaN(value)) {
		throw new Error("canonicalize: NaN is not allowed in audit data");
	}
	if (value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY) {
		throw new Error("canonicalize: Infinity is not allowed in audit data");
	}
	// Convert Date to ISO string (JSON.stringify would otherwise double-quote it)
	if (value instanceof Date) {
		return JSON.stringify(value.toISOString());
	}
	if (value === null) return "null";
	// ut1 §13 clause 1: `undefined` and `null` BOTH serialize to `null` — at the
	// top level, inside arrays, everywhere. A top-level `undefined` is not the JS
	// value; it is the absence a caller means, and the normative proxy returns
	// "null" for it. Throwing here would re-open a minter/verifier divergence on
	// the exact input class this function exists to unify, just pointing the
	// other way. Object VALUES that are undefined are still omitted (§2
	// key-ABSENT); that asymmetry is deliberate.
	if (value === undefined) return "null";
	if (typeof value !== "object") {
		// `JSON.stringify` returns `undefined` — NOT a string — for functions and
		// symbols (top-level `undefined` is handled above). Emitting it produced `{"f":undefined}`: an audit
		// line that cannot be parsed back. Refuse, for the same reason `NaN` is
		// refused above, and refuse rather than OMIT: dropping the key would sign
		// a document missing a member the caller believed they committed — the
		// same defect one layer quieter.
		const encoded = JSON.stringify(value);
		if (typeof encoded !== "string") {
			throw new Error(`canonicalize: ${typeof value} is not representable in audit data`);
		}
		return encoded;
	}
	if (Array.isArray(value)) {
		// INDEX LOOP, never `Array.map`: map SKIPS holes, so `[1,,2]` joined back
		// to the unparseable `[1,,2]`. A hole and an in-array `undefined` are the
		// same thing — absence at a position — and JSON writes both as `null`.
		// The position cannot be dropped without re-indexing every later element.
		const items: string[] = [];
		for (let i = 0; i < value.length; i++) {
			const element = value[i];
			items.push(element === undefined ? "null" : canonicalize(element));
		}
		return `[${items.join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	const parts: string[] = [];
	for (const key of keys) {
		// An object-value `undefined` is OMITTED, not written as null. Unlike an
		// array position, a key that is not there is exactly what the caller meant
		// — absence is faithful, so this is not a coercion. The spec's
		// `key-ABSENT (never null)` rules and every live event depend on it.
		if (obj[key] === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${canonicalize(obj[key])}`);
	}
	return `{${parts.join(",")}}`;
}
