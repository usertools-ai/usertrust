// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// Xoshiro256** — fast, high-quality seedable PRNG (64-bit)
// Reference: https://prng.di.unimi.it/xoshiro256starstar.c (Blackman & Vigna, 2019, public domain)
//
// Provenance: foundation logic ported from PRISM Monte Carlo engine
// (monday-roi-calculator: src/utils/xoshiro256.js — which used the 32-bit
// xoshiro128** variant). This implementation upgrades to the canonical
// 64-bit xoshiro256** using bigint for u64 math, since strict TS rejects
// silent precision loss on number-typed bit operations beyond 32 bits.
//
// All public methods are deterministic: seeding with the same input always
// produces the same sequence — the foundational invariant for any Monte
// Carlo simulation that must be reproducible (audit, regression, what-if).

const U64_MASK = 0xffffffffffffffffn;
const U32_MASK = 0xffffffffn;
const FLOAT_53_DIVISOR = 0x20000000000000n; // 2^53, max-precision Number mantissa

/**
 * Hash an arbitrary JSON-serializable input into a 32-bit unsigned seed.
 * Use this when you want simulation outputs to be deterministically tied to
 * a configuration object — the same config will always seed the same RNG.
 */
export function hashInputs(inputs: unknown): number {
	const str = JSON.stringify(inputs);
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash |= 0;
	}
	return Math.abs(hash);
}

/**
 * SplitMix64 — used to expand a single 64-bit seed into the four 64-bit
 * state words required by xoshiro256**. Recommended by the xoshiro authors
 * to avoid pathological state initialization.
 */
function splitmix64(state: bigint): { state: bigint; value: bigint } {
	let z = (state + 0x9e3779b97f4a7c15n) & U64_MASK;
	z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
	z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
	z = (z ^ (z >> 31n)) & U64_MASK;
	return { state: (state + 0x9e3779b97f4a7c15n) & U64_MASK, value: z };
}

function rotl(x: bigint, k: bigint): bigint {
	return ((x << k) | (x >> (64n - k))) & U64_MASK;
}

/**
 * Xoshiro256** — 64-bit seedable PRNG.
 *
 * Use one instance per simulation. Re-seeding with the same value resets
 * the sequence, which is the property simulators rely on for reproducibility.
 */
export class Xoshiro256 {
	private state: BigUint64Array;

	constructor(seed: number | bigint = 0) {
		this.state = new BigUint64Array(4);
		this.seed(seed);
	}

	/**
	 * Re-seed from a single 64-bit value or from a pre-computed 4-word state
	 * (advanced — use only when you have an existing xoshiro state to restore).
	 * After seeding, the next 4 outputs are fully determined by the seed.
	 */
	seed(seed: number | bigint | bigint[]): void {
		if (Array.isArray(seed)) {
			if (seed.length !== 4) {
				throw new Error("Xoshiro256.seed(state[]): expected 4 bigint words");
			}
			let allZero = true;
			for (let i = 0; i < 4; i++) {
				const word = (seed[i] as bigint) & U64_MASK;
				this.state[i] = word;
				if (word !== 0n) allZero = false;
			}
			if (allZero) {
				throw new Error("Xoshiro256.seed: state must not be all-zero");
			}
			return;
		}

		// Expand a single seed via SplitMix64.
		let sm = (typeof seed === "bigint" ? seed : BigInt(seed >>> 0)) & U64_MASK;
		for (let i = 0; i < 4; i++) {
			const step = splitmix64(sm);
			sm = step.state;
			this.state[i] = step.value;
		}

		// Guard against the (astronomically unlikely) all-zero state.
		if (
			this.state[0] === 0n &&
			this.state[1] === 0n &&
			this.state[2] === 0n &&
			this.state[3] === 0n
		) {
			this.state[0] = 1n;
		}
	}

	/**
	 * Return the next 64-bit unsigned integer in the sequence (as bigint).
	 * Core primitive — all other output methods derive from this.
	 */
	nextUint64(): bigint {
		const s0 = this.state[0] as bigint;
		const s1 = this.state[1] as bigint;
		const s2 = this.state[2] as bigint;
		const s3 = this.state[3] as bigint;

		const result = (rotl((s1 * 5n) & U64_MASK, 7n) * 9n) & U64_MASK;
		const t = (s1 << 17n) & U64_MASK;

		const ns2 = (s2 ^ s0) & U64_MASK;
		const ns3 = (s3 ^ s1) & U64_MASK;
		const ns1 = (s1 ^ ns2) & U64_MASK;
		const ns0 = (s0 ^ ns3) & U64_MASK;
		const ns2b = (ns2 ^ t) & U64_MASK;
		const ns3b = rotl(ns3, 45n);

		this.state[0] = ns0;
		this.state[1] = ns1;
		this.state[2] = ns2b;
		this.state[3] = ns3b;

		return result;
	}

	/**
	 * Return the next 32-bit unsigned integer (top 32 bits of nextUint64).
	 * Useful when you don't need full 64-bit width and want to skip the
	 * bigint -> number conversion overhead.
	 */
	nextUint32(): number {
		return Number((this.nextUint64() >> 32n) & U32_MASK);
	}

	/**
	 * Return a uniformly distributed float in the half-open interval [0, 1).
	 * Uses the top 53 bits of the 64-bit output — the maximum precision an
	 * IEEE-754 double can faithfully represent.
	 */
	nextFloat(): number {
		const top53 = this.nextUint64() >> 11n;
		return Number(top53) / Number(FLOAT_53_DIVISOR);
	}

	/**
	 * Snapshot the current 4-word state. Pair with `seed(state[])` to resume
	 * a simulation from an exact point — useful for checkpointing long runs.
	 */
	snapshot(): bigint[] {
		return [
			this.state[0] as bigint,
			this.state[1] as bigint,
			this.state[2] as bigint,
			this.state[3] as bigint,
		];
	}
}

/**
 * Convenience factory: returns an object with `random()` and `next()` methods,
 * matching the legacy createRng() interface from the source PRISM engine.
 * Distributions and other consumers may use either this shape or the class
 * directly — both wrap the same seeded sequence.
 */
export function createRng(seed: number | bigint = 0): {
	random: () => number;
	next: () => number;
	rng: Xoshiro256;
} {
	const rng = new Xoshiro256(seed);
	return {
		random: () => rng.nextFloat(),
		next: () => rng.nextUint32(),
		rng,
	};
}
