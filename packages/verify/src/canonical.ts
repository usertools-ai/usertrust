// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Deterministic JSON canonicalization for hash computation.
 * Sorts object keys alphabetically at every nesting level.
 * Strips undefined values. Preserves null. Arrays keep order.
 *
 * INTENTIONAL DUPLICATION: This is a zero-dep copy for the usertrust-verify
 * package. Do NOT import from usertrust.
 */
export function canonicalize(value: unknown): string {
	// Guard against values that JSON.stringify silently coerces to "null"
	if (typeof value === "number" && Number.isNaN(value)) {
		throw new Error("canonicalize: NaN is not allowed in audit data");
	}
	if (value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY) {
		throw new Error("canonicalize: Infinity is not allowed in audit data");
	}
	// Convert Date to ISO string to avoid double-quoting divergence
	if (value instanceof Date) {
		return JSON.stringify(value.toISOString());
	}
	if (value === null || value === undefined) return JSON.stringify(value);
	if (typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((v) => canonicalize(v)).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	const parts: string[] = [];
	for (const key of keys) {
		if (obj[key] === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${canonicalize(obj[key])}`);
	}
	return `{${parts.join(",")}}`;
}
