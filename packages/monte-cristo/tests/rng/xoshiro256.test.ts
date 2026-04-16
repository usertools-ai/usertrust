// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { Xoshiro256, createRng, hashInputs } from "../../src/rng/xoshiro256.js";

describe("Xoshiro256", () => {
	describe("seeded determinism", () => {
		it("same seed produces identical sequences (nextFloat)", () => {
			const a = new Xoshiro256(12345);
			const b = new Xoshiro256(12345);
			for (let i = 0; i < 1000; i++) {
				expect(a.nextFloat()).toBe(b.nextFloat());
			}
		});

		it("same seed produces identical sequences (nextUint64)", () => {
			const a = new Xoshiro256(0xdeadbeef);
			const b = new Xoshiro256(0xdeadbeef);
			for (let i = 0; i < 200; i++) {
				expect(a.nextUint64()).toBe(b.nextUint64());
			}
		});

		it("different seeds produce different sequences", () => {
			const a = new Xoshiro256(1);
			const b = new Xoshiro256(2);
			let differences = 0;
			for (let i = 0; i < 100; i++) {
				if (a.nextFloat() !== b.nextFloat()) differences++;
			}
			expect(differences).toBeGreaterThan(95);
		});

		it("re-seeding resets the sequence", () => {
			const rng = new Xoshiro256(42);
			const first10 = Array.from({ length: 10 }, () => rng.nextFloat());
			rng.seed(42);
			const second10 = Array.from({ length: 10 }, () => rng.nextFloat());
			expect(second10).toEqual(first10);
		});

		it("snapshot + seed(state) restores exact sequence", () => {
			const rng = new Xoshiro256(99);
			for (let i = 0; i < 50; i++) rng.nextUint64(); // advance
			const snap = rng.snapshot();
			const next10A = Array.from({ length: 10 }, () => rng.nextUint64());
			rng.seed(snap);
			const next10B = Array.from({ length: 10 }, () => rng.nextUint64());
			expect(next10B).toEqual(next10A);
		});
	});

	describe("nextFloat output", () => {
		it("stays in [0, 1)", () => {
			const rng = new Xoshiro256(7);
			for (let i = 0; i < 10_000; i++) {
				const v = rng.nextFloat();
				expect(v).toBeGreaterThanOrEqual(0);
				expect(v).toBeLessThan(1);
			}
		});

		it("approximates uniform mean ~0.5 over 10K draws", () => {
			const rng = new Xoshiro256(101);
			let sum = 0;
			const n = 10_000;
			for (let i = 0; i < n; i++) sum += rng.nextFloat();
			const mean = sum / n;
			expect(mean).toBeGreaterThan(0.48);
			expect(mean).toBeLessThan(0.52);
		});

		it("distributes roughly uniformly across 10 bins (chi-squared style)", () => {
			const rng = new Xoshiro256(2024);
			const bins = new Array(10).fill(0);
			const n = 100_000;
			for (let i = 0; i < n; i++) {
				const idx = Math.min(9, Math.floor(rng.nextFloat() * 10));
				bins[idx]++;
			}
			const expected = n / 10;
			for (const count of bins) {
				// Each bin within 5% of expected over 100K draws.
				expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
			}
		});
	});

	describe("nextUint64", () => {
		it("returns bigints in [0, 2^64)", () => {
			const rng = new Xoshiro256(13);
			for (let i = 0; i < 1000; i++) {
				const v = rng.nextUint64();
				expect(typeof v).toBe("bigint");
				expect(v).toBeGreaterThanOrEqual(0n);
				expect(v).toBeLessThan(0x10000000000000000n);
			}
		});
	});

	describe("seed validation", () => {
		it("rejects all-zero state array", () => {
			const rng = new Xoshiro256(1);
			expect(() => rng.seed([0n, 0n, 0n, 0n])).toThrow(/all-zero/);
		});

		it("rejects state array of wrong length", () => {
			const rng = new Xoshiro256(1);
			expect(() => rng.seed([1n, 2n, 3n])).toThrow(/4 bigint/);
		});

		it("accepts bigint seed", () => {
			const a = new Xoshiro256(0xabcdef0123456789n);
			const b = new Xoshiro256(0xabcdef0123456789n);
			expect(a.nextUint64()).toBe(b.nextUint64());
		});
	});
});

describe("createRng", () => {
	it("matches Xoshiro256 when seeded identically", () => {
		const wrapped = createRng(555);
		const direct = new Xoshiro256(555);
		for (let i = 0; i < 100; i++) {
			expect(wrapped.random()).toBe(direct.nextFloat());
		}
	});

	it("exposes the underlying rng instance", () => {
		const wrapped = createRng(0);
		expect(wrapped.rng).toBeInstanceOf(Xoshiro256);
	});
});

describe("hashInputs", () => {
	it("is deterministic for equal inputs", () => {
		expect(hashInputs({ a: 1, b: 2 })).toBe(hashInputs({ a: 1, b: 2 }));
	});

	it("differs for different inputs", () => {
		expect(hashInputs({ a: 1 })).not.toBe(hashInputs({ a: 2 }));
	});

	it("returns a non-negative integer", () => {
		const h = hashInputs({ x: "test", y: 42 });
		expect(h).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(h)).toBe(true);
	});
});
