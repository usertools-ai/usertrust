// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — the object loop read `obj[key]` TWICE: once to decide whether the
 * key is absent, once to serialize it. The value it tested is therefore not the
 * value it wrote.
 *
 * Both accesses are fresh property reads on the CALLER's object, so a getter
 * (or a Proxy) that answers differently on the second read splits the two:
 *
 *   - DEFINED, THEN `undefined`. The absence test sees a value, so the key is
 *     kept; the serialization then sees `undefined` and canonicalize's
 *     top-level rule writes it as `null`. Output: `{"k":null}` — an object
 *     value written as null, which is the exact asymmetry §13 and this
 *     canonicalizer's own comment forbid (`key-ABSENT (never null)`).
 *   - ONE VALUE, THEN ANOTHER. The general case, and the worse one: the writer
 *     HASHES one shape and PERSISTS another. `chain.ts` computes the hash over
 *     `canonicalize(event)` and then persists `canonicalize(fullEvent)` — two
 *     separate traversals of the same caller object — so a value that changes
 *     between them signs a document that does not say what was signed. That is
 *     the failure this whole module exists to prevent.
 *
 * This is `a value you re-read is not the value you checked` — the invariant
 * this branch wrote into AGENTS.md and applied to every caller-owned handle in
 * `headless.ts`, and to the array bound one loop above — violated a third time
 * by the branch's own canonicalizer. The property is read ONCE, into a local,
 * before the test that decides its fate.
 *
 * BOTH COPIES. `packages/core` and `packages/verify` carry byte-identical
 * canonicalizers (the parity contract), so every case below runs against both:
 * a fix that lands in one and not the other splits the minter from the verifier,
 * which is worse than the defect.
 */

import { describe, expect, it } from "vitest";
import { canonicalize as verifyCanonicalize } from "../../../verify/src/canonical.js";
import { canonicalize as coreCanonicalize } from "../../src/audit/canonical.js";

const IMPLEMENTATIONS: ReadonlyArray<readonly [string, (value: unknown) => string]> = [
	["core", coreCanonicalize],
	["verify", verifyCanonicalize],
];

/**
 * A property that is defined on its first read and `undefined` on every later
 * one. Fresh per call — the getter is single-use by construction, so a shared
 * instance would measure the second read, not the first.
 */
function vanishingValue(): Record<string, unknown> {
	const o: Record<string, unknown> = {};
	let reads = 0;
	Object.defineProperty(o, "k", {
		configurable: true,
		enumerable: true,
		get(): unknown {
			reads++;
			return reads === 1 ? 1 : undefined;
		},
	});
	return o;
}

/** A property that answers `1`, then `2`, then `3`… — one value per read. */
function driftingValue(): Record<string, unknown> {
	const o: Record<string, unknown> = {};
	let reads = 0;
	Object.defineProperty(o, "k", {
		configurable: true,
		enumerable: true,
		get(): unknown {
			reads++;
			return reads;
		},
	});
	return o;
}

/** Counts the reads of every property, so "read once" can be asserted exactly. */
function countingObject(): { obj: Record<string, unknown>; reads: () => number } {
	const o: Record<string, unknown> = {};
	let reads = 0;
	for (const key of ["a", "b", "c"]) {
		Object.defineProperty(o, key, {
			configurable: true,
			enumerable: true,
			get(): unknown {
				reads++;
				return key;
			},
		});
	}
	return { obj: o, reads: () => reads };
}

describe.each(IMPLEMENTATIONS)(
	"HARDEN (%s): the object value canonicalize checks is the value it writes",
	(_name, canonicalize) => {
		it("never writes an object value as null because the SECOND read vanished", () => {
			// Pre-fix: `{"k":null}` — the key survived the absence test and then
			// serialized the later `undefined` through the top-level null rule.
			expect(canonicalize(vanishingValue())).toBe('{"k":1}');
		});

		it("writes the value the absence test approved, not a later one", () => {
			// Pre-fix: `{"k":2}` — checked read #1, wrote read #2.
			expect(canonicalize(driftingValue())).toBe('{"k":1}');
		});

		it("reads each property EXACTLY once", () => {
			// Asserted exactly, so a re-read cannot be reintroduced without failing
			// here. Pre-fix this was 6 for three keys.
			const { obj, reads } = countingObject();
			expect(canonicalize(obj)).toBe('{"a":"a","b":"b","c":"c"}');
			expect(reads()).toBe(3);
		});

		it("still OMITS an honestly-undefined object value, and still keeps null", () => {
			// The regression pin: reading the property once must not cost the
			// key-ABSENT asymmetry the test exists for.
			expect(canonicalize({ a: undefined })).toBe("{}");
			expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
			expect(canonicalize({ a: null })).toBe('{"a":null}');
			expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
			expect(canonicalize({ a: { u: undefined }, b: [{ u: undefined }] })).toBe(
				'{"a":{},"b":[{}]}',
			);
		});
	},
);

describe("the two canonicalizers answer these cases identically", () => {
	it("core and verify agree byte-for-byte on a vanishing and a drifting value", () => {
		// The parity contract, asserted on the exact inputs the fix changes: a
		// canonicalizer that split here would fork the hash for any payload a
		// caller can construct.
		expect(coreCanonicalize(vanishingValue())).toBe(verifyCanonicalize(vanishingValue()));
		expect(coreCanonicalize(driftingValue())).toBe(verifyCanonicalize(driftingValue()));
	});
});
