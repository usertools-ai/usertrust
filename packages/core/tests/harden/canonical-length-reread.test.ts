// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — the array loop that fixed holes re-read `value.length` every
 * iteration, so the bound it checked was never the bound it iterated to.
 *
 * `for (let i = 0; i < value.length; i++)` is a fresh property access on the
 * CALLER's array on every pass. Two ways that breaks, both on the audit WRITE
 * path, both reachable from any caller-supplied payload:
 *
 *   - SHRINKING. An element getter that assigns `value.length = 0` ends the
 *     loop early, so `canonicalize([0,1])` emitted `[0]` where `JSON.stringify`
 *     emits `[0,null]`. A silently dropped position, in the code whose entire
 *     purpose is that a position is never dropped — every later element
 *     re-indexes, and the signed document no longer says what the caller
 *     committed.
 *   - GROWING. A Proxy (or a getter) that appends on read makes the condition
 *     recede forever: an UNBOUNDED loop inside `appendEvent`, i.e. a hang on the
 *     audit write path. The growth here is capped so the pre-fix run terminates
 *     and reports a wrong LENGTH instead of hanging the suite; uncapped, the
 *     pre-fix loop never returns at all.
 *
 * This is `a value you re-read is not the value you checked` — the invariant
 * this branch wrote into AGENTS.md and applied to every caller-owned handle in
 * `headless.ts` — violated by the branch's own canonicalizer fix. The bound is
 * read ONCE, into a local, before the loop.
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
 * Codex's repro, verbatim: reading index 0 truncates the array to nothing and
 * answers `0`. Fresh per call — the getter is single-use by construction, so a
 * shared instance would measure the second read, not the first.
 */
function shrinkingArray(): unknown[] {
	const a: unknown[] = [0, 1];
	Object.defineProperty(a, "0", {
		configurable: true,
		enumerable: true,
		get(): number {
			a.length = 0;
			return 0;
		},
	});
	return a;
}

/**
 * An array-backed Proxy that appends one element on every indexed read, up to
 * `cap`. `Array.isArray` is true through a Proxy, so this reaches the same
 * branch a plain array does.
 */
function growingArray(cap: number): unknown[] {
	const target: unknown[] = [0, 1];
	return new Proxy(target, {
		get(t, prop, receiver): unknown {
			if (typeof prop === "string" && /^\d+$/.test(prop) && t.length < cap) {
				t.push(t.length);
			}
			return Reflect.get(t, prop, receiver);
		},
	}) as unknown[];
}

describe.each(IMPLEMENTATIONS)(
	"HARDEN (%s): the array length canonicalize checks is the length it iterates to",
	(_name, canonicalize) => {
		it("keeps every original position when an element getter SHRINKS the array", () => {
			// The guarantee the hole fix exists to provide, stated against the
			// normative proxy: absence at a position is written as `null`, and the
			// position count never changes under the writer's feet.
			expect(canonicalize(shrinkingArray())).toBe("[0,null]");
			expect(canonicalize(shrinkingArray())).toBe(JSON.stringify(shrinkingArray()));

			const parsed = JSON.parse(canonicalize(shrinkingArray())) as unknown[];
			expect(parsed).toEqual([0, null]);
			expect(parsed).toHaveLength(2);
		});

		it("TERMINATES at the captured length when reads GROW the array", () => {
			const out = canonicalize(growingArray(25));
			const parsed = JSON.parse(out) as unknown[];

			// Two positions existed when the bound was taken, so two positions are
			// written. Pre-fix this ran until the cap and emitted 25.
			expect(parsed).toHaveLength(2);
			expect(out).toBe("[0,1]");
		});

		it("still writes holes and in-array undefined as null on an honest array", () => {
			// The regression pin: reading the bound once must not cost the hole fix
			// the loop was introduced for.
			const holey: unknown[] = [];
			holey[0] = 1;
			holey[2] = 2;
			expect(1 in holey).toBe(false);

			expect(canonicalize(holey)).toBe("[1,null,2]");
			expect(canonicalize([undefined, 1])).toBe("[null,1]");
			expect(canonicalize([])).toBe("[]");
			expect(canonicalize([[1, [2]], 3])).toBe("[[1,[2]],3]");
		});
	},
);

describe("the two canonicalizers answer these cases identically", () => {
	it("core and verify agree byte-for-byte on a shrinking and a growing array", () => {
		// The parity contract, asserted on the exact inputs the fix changes: a
		// canonicalizer that split here would fork the hash for any payload a
		// caller can construct.
		expect(coreCanonicalize(shrinkingArray())).toBe(verifyCanonicalize(shrinkingArray()));
		expect(coreCanonicalize(growingArray(25))).toBe(verifyCanonicalize(growingArray(25)));
	});
});
