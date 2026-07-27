// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { createRng, hashInputs, Xoshiro256 } from "../../src/rng/xoshiro256.js";

describe("Xoshiro256 array-state seeding", () => {
	it("seeds from a 4-word state and is deterministic", () => {
		const a = new Xoshiro256();
		a.seed([1n, 2n, 3n, 4n]);
		const b = new Xoshiro256();
		b.seed([1n, 2n, 3n, 4n]);
		expect(a.nextUint64()).toBe(b.nextUint64());
	});

	it("round-trips a snapshot: restoring resumes the exact sequence", () => {
		const rng = new Xoshiro256(99);
		rng.nextUint64();
		const state = rng.snapshot();
		const expected = [rng.nextUint64(), rng.nextUint64()];
		const restored = new Xoshiro256();
		restored.seed(state);
		expect([restored.nextUint64(), restored.nextUint64()]).toEqual(expected);
	});

	it("rejects a state array of the wrong length", () => {
		const rng = new Xoshiro256();
		expect(() => rng.seed([1n, 2n, 3n])).toThrow(/4 bigint words/);
	});

	it("rejects an all-zero state array", () => {
		const rng = new Xoshiro256();
		expect(() => rng.seed([0n, 0n, 0n, 0n])).toThrow(/all-zero/);
	});
});

describe("Xoshiro256 bigint seeding", () => {
	it("accepts a bigint seed and is deterministic", () => {
		const a = new Xoshiro256(0xdead_beefn);
		const b = new Xoshiro256(0xdead_beefn);
		expect(a.nextFloat()).toBe(b.nextFloat());
	});

	it("masks bigint seeds wider than 64 bits without throwing", () => {
		const rng = new Xoshiro256((1n << 200n) | 1n);
		expect(Number.isFinite(rng.nextFloat())).toBe(true);
	});
});

describe("hashInputs / createRng", () => {
	it("hashInputs is deterministic, non-negative, and input-sensitive", () => {
		expect(hashInputs({ a: 1, b: [2, 3] })).toBe(hashInputs({ a: 1, b: [2, 3] }));
		expect(hashInputs({ a: 1, b: [2, 3] })).toBeGreaterThanOrEqual(0);
		expect(hashInputs({ a: 1 })).not.toBe(hashInputs({ a: 2 }));
	});

	it("createRng exposes random()/next() over the same seeded sequence", () => {
		const a = createRng(7);
		const b = new Xoshiro256(7);
		expect(a.random()).toBe(b.nextFloat());
		expect(typeof a.next()).toBe("number");
	});
});
