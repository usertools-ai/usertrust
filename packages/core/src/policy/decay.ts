// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Decay Rate Calculator
 *
 * Calculates exponential decay rates for quota/budget consumption.
 * Enables time-weighted rate limiting that rewards idle periods.
 *
 * The decay model uses: value(t) = initial * e^(-lambda * t)
 * where lambda is the decay constant and t is time elapsed.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for decay rate calculation. */
export interface DecayConfig {
	/** Half-life in milliseconds — time for value to decay to 50%. */
	halfLifeMs: number;
	/** Minimum threshold below which value is considered zero. */
	minThreshold?: number;
}

/** A timestamped entry for weighted sum calculation. */
export interface TimestampedEntry {
	/** Timestamp in milliseconds (e.g. Date.now()) */
	ts: number;
	/** The value at that timestamp */
	value: number;
}

/** Result of a decay rate calculation. */
export interface DecayResult {
	/** The decayed value. */
	decayedValue: number;
	/** The decay factor applied (0-1). */
	decayFactor: number;
	/** Time elapsed since reference point (ms). */
	elapsedMs: number;
	/** Whether the value has decayed below threshold. */
	fullyDecayed: boolean;
}

// ---------------------------------------------------------------------------
// DecayRateCalculator
// ---------------------------------------------------------------------------

/**
 * Decay rate calculator using exponential decay model.
 *
 * Used for time-weighted rate limiting. Older consumption contributes less
 * to current budget usage, rewarding tenants who space out their requests.
 */
export class DecayRateCalculator {
	/** Decay constant (lambda = ln(2) / halfLife) */
	private readonly lambda: number;
	/** Minimum threshold for considering a value "fully decayed" */
	private readonly minThreshold: number;

	constructor(config: DecayConfig) {
		if (config.halfLifeMs <= 0) {
			throw new Error("Half-life must be positive");
		}
		this.lambda = Math.LN2 / config.halfLifeMs;
		this.minThreshold = config.minThreshold ?? 1e-9;
	}

	/**
	 * Calculate the decayed value after a given time elapsed.
	 *
	 * @param initialValue - The original value before decay
	 * @param elapsedMs - Time elapsed in milliseconds
	 * @returns Decay result with decayed value and metadata
	 */
	calculate(initialValue: number, elapsedMs: number): DecayResult {
		if (elapsedMs < 0) {
			throw new Error("Elapsed time cannot be negative");
		}

		if (initialValue <= 0) {
			return {
				decayedValue: 0,
				decayFactor: 1,
				elapsedMs,
				fullyDecayed: true,
			};
		}

		const decayFactor = Math.exp(-this.lambda * elapsedMs);
		const decayedValue = initialValue * decayFactor;
		const fullyDecayed = decayedValue < this.minThreshold;

		return {
			decayedValue: fullyDecayed ? 0 : decayedValue,
			decayFactor,
			elapsedMs,
			fullyDecayed,
		};
	}

	/**
	 * Calculate the weighted sum of multiple timestamped values.
	 * Each value is decayed based on its age relative to the reference time.
	 *
	 * @param entries - Array of timestamped entries
	 * @param referenceTime - The reference time (usually Date.now())
	 * @returns Total decayed value
	 */
	calculateWeightedSum(entries: TimestampedEntry[], referenceTime: number = Date.now()): number {
		let total = 0;

		for (const entry of entries) {
			const elapsedMs = referenceTime - entry.ts;
			if (elapsedMs < 0) {
				// Future entry — use full value
				total += entry.value;
			} else {
				const result = this.calculate(entry.value, elapsedMs);
				total += result.decayedValue;
			}
		}

		return total;
	}

	/**
	 * Calculate time required for a value to decay to a target.
	 *
	 * @param currentValue - Current value
	 * @param targetValue - Target value to decay to
	 * @returns Time in milliseconds, or Infinity if target >= current
	 */
	timeToDecay(currentValue: number, targetValue: number): number {
		if (targetValue >= currentValue || targetValue <= 0) {
			return Number.POSITIVE_INFINITY;
		}

		// t = -ln(target/current) / lambda
		return -Math.log(targetValue / currentValue) / this.lambda;
	}

	/**
	 * Get the half-life of this calculator.
	 */
	getHalfLifeMs(): number {
		return Math.LN2 / this.lambda;
	}
}

// ---------------------------------------------------------------------------
// Convenience: calculateDecayRate function
// ---------------------------------------------------------------------------

/**
 * Calculate the decay rate for a set of timestamped entries.
 *
 * This is the primary entry point — a pure function that creates a calculator,
 * computes the weighted sum, and returns the total decayed value.
 *
 * @param entries - Array of timestamped entries
 * @param halfLife - Half-life in milliseconds (default: 1 hour)
 * @returns Total decayed value (weighted sum)
 */
export function calculateDecayRate(entries: TimestampedEntry[], halfLife = 3_600_000): number {
	const calc = new DecayRateCalculator({ halfLifeMs: halfLife });
	return calc.calculateWeightedSum(entries);
}

/**
 * Create a decay calculator with a half-life matching a cost window.
 * The half-life is set to 1/4 of the window so most decay occurs within it.
 */
export function createCostDecayCalculator(windowMs: number): DecayRateCalculator {
	return new DecayRateCalculator({
		halfLifeMs: windowMs / 4,
		minThreshold: 0.0001, // $0.0001 threshold for cost values
	});
}
