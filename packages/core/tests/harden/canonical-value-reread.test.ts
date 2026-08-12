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
 *     HASHES one shape and PERSISTS another. A value that changes between the
 *     hash pre-image and the persisted line signs a document that does not say
 *     what was signed. That is the failure this whole module exists to prevent,
 *     and reading the property once closes it only WITHIN one traversal —
 *     `chain.ts` used to run two of them over the same caller object, which the
 *     last describe in this file pins at the writer.
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

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize as verifyCanonicalize } from "../../../verify/src/canonical.js";
import { canonicalize as coreCanonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

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

/**
 * ONE TRAVERSAL OF CALLER DATA PER EVENT — the same rule, one level up.
 *
 * Reading each property once makes a single traversal self-consistent; it
 * cannot make TWO traversals agree. `chain.ts` hashed `canonicalize(event)` and
 * then persisted `canonicalize(fullEvent)`, so a getter that answers a
 * different value on the second traversal made the chain hash one value and
 * store another — and `JSON.parse(line)` cannot detect it, because the line it
 * parses is internally consistent and simply is not what was signed.
 */
describe("HARDEN: the writer canonicalizes the caller's event exactly ONCE", () => {
	let root: string;
	let writer: ReturnType<typeof createAuditWriter>;
	let logPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "harden-one-traversal-"));
		writer = createAuditWriter(root);
		logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
	});

	afterEach(() => {
		writer.release();
		rmSync(root, { recursive: true, force: true });
	});

	it("hashes the value it persists when a data getter answers differently on each read", async () => {
		await writer.appendEvent({ kind: "drift.test", actor: "sys", data: driftingValue() });
		writer.release();

		const line = readFileSync(logPath, "utf-8").trim();
		const persisted = JSON.parse(line) as Record<string, unknown> & { hash: string };
		const { hash: storedHash, ...preImage } = persisted;

		// THE MEASUREMENT: the verifier's recomputation over the bytes on disk.
		// Pre-fix the hash covered read #1 and the line carried read #2, so this
		// event was unverifiable the instant it was written.
		expect(createHash("sha256").update(coreCanonicalize(preImage)).digest("hex")).toBe(storedHash);
		// And it is read #1 — the value that reached the hash — that is on disk.
		expect((persisted.data as { k: number }).k).toBe(1);
	});

	it("still persists a CANONICAL line, byte-for-byte", async () => {
		// The property the single-traversal form must not cost: the line is
		// canonicalize's own output (never `JSON.stringify`, which diverges for
		// any `toJSON`-bearing value), so the verifier recomputes the same bytes.
		await writer.appendEvent({
			kind: "canonical.test",
			actor: "sys",
			data: { z: 1, a: { n: [1, 2] }, blob: Buffer.from("hi") },
		});
		writer.release();

		const line = readFileSync(logPath, "utf-8").trim();
		expect(coreCanonicalize(JSON.parse(line))).toBe(line);
		expect(line).not.toContain('"type":"Buffer"');
	});
});

describe("the two canonicalizers answer these cases identically", () => {
	it("core and verify agree byte-for-byte on a vanishing and a drifting value", () => {
		// The parity contract, asserted on the exact inputs the fix changes: a
		// canonicalizer that split here would fork the hash for any payload a
		// caller can construct.
		expect(coreCanonicalize(vanishingValue())).toBe(verifyCanonicalize(vanishingValue()));
		expect(coreCanonicalize(driftingValue())).toBe(verifyCanonicalize(driftingValue()));
	});
});
