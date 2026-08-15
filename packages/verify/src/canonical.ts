// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Deterministic JSON canonicalization for hash computation.
 * Sorts object keys alphabetically at every nesting level.
 * Object-value undefined is omitted (key absent). Array holes and in-array
 * undefined encode as null. Functions and symbols throw.
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
	if (value === null || value === undefined) return "null";
	if (typeof value === "function" || typeof value === "symbol") {
		throw new Error("canonicalize: functions and symbols are not allowed in audit data");
	}
	if (typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		// Snapshot length once. `.map` skips holes; `join` turns a hole or an
		// in-array undefined into an empty slot — `{arr:[1,,2]}` is not JSON.
		const rawLen = value.length;
		if (typeof rawLen !== "number" || !Number.isFinite(rawLen) || rawLen < 0) {
			throw new Error("canonicalize: array length is not a finite number");
		}
		const len = Math.min(Math.trunc(rawLen), Number.MAX_SAFE_INTEGER);
		const items: string[] = [];
		for (let i = 0; i < len; i++) {
			items.push(canonicalize(value[i]));
		}
		return `[${items.join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	const parts: string[] = [];
	for (const key of keys) {
		const member = obj[key];
		if (member === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${canonicalize(member)}`);
	}
	return `{${parts.join(",")}}`;
}
