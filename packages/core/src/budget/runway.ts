// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * runway.ts — pure budget runway and burn-rate math
 *
 * A cost center's runway is a function of four numbers: what it was allocated,
 * what it has spent, when its period started, and what time it is now. This
 * module computes exactly that and nothing else.
 *
 * PURITY: no clock reads, no I/O, no ledger access. `nowMs` is always injected
 * by the caller so every result is reproducible and testable. Callers that need
 * the wall clock read it at their own call site, never in here.
 *
 * UNITS: `allocated` and `spent` are UT (usertokens). At every *ledger* call
 * site they are integers — TigerBeetle balances are integral and the allocation
 * API validates positive safe integers. `computeRunway` nonetheless tolerates
 * fractional values so analytics and projection callers can feed it derived or
 * averaged figures; it never rounds them. `projectedExhaustionMs` is always
 * rounded to an integer epoch-ms.
 *
 * TOTALITY: no field of the returned `Runway` is ever `NaN` or `Infinity`. A
 * non-finite threshold does not fail loudly downstream — it silently makes every
 * policy comparison (`lt`/`lte`/`gte`) false, which reads as "no limit tripped"
 * and would quietly disable the governance this module exists to feed. Degenerate
 * amounts are therefore normalized rather than propagated (see `computeRunway`).
 */

const MS_PER_HOUR = 3_600_000;

export interface RunwayInput {
	/** Total allocated to this cost center for the period, in UT. */
	allocated: number;
	/** Spent so far in the period, in UT. Settled + currently held. */
	spent: number;
	/** Period start, epoch ms. */
	periodStartMs: number;
	/** Period end, epoch ms. Omit for an open-ended allocation. */
	periodEndMs?: number | undefined;
	/** Injected clock — never read the clock inside this module. */
	nowMs: number;
}

export interface Runway {
	remaining: number;
	/** remaining / allocated, clamped 0..1. 0 when allocated is 0. */
	fractionRemaining: number;
	/** UT per hour over the elapsed window; 0 before any time has elapsed. */
	burnRatePerHour: number;
	/**
	 * Epoch ms when the budget is projected to hit 0, or null if not projectable.
	 *
	 * HONESTY: this is a naive linear extrapolation of the *average* burn rate
	 * across the whole elapsed window — `remaining / burnRatePerHour`. Early in a
	 * period the window is tiny, so a single large call dominates the average and
	 * the projection swings wildly from one read to the next. It is a signal, not
	 * a measurement. It MUST NOT drive irreversible decisions (killing a run,
	 * revoking an allocation) without hysteresis — dwell time, or a confirming
	 * second read — applied at the policy layer. Deliberately unsmoothed here:
	 * smoothing is a policy choice and belongs where the policy lives.
	 */
	projectedExhaustionMs: number | null;
	/**
	 * For a bounded period: true when projected exhaustion is at or after
	 * periodEnd (i.e. the budget lasts). null when there is no period end or
	 * no projection.
	 */
	onPace: boolean | null;
}

/** Non-finite or negative amounts normalize to 0; finite non-negative pass through. */
function normalizeAmount(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function projectExhaustion(
	remaining: number,
	burnRatePerHour: number,
	nowMs: number,
): number | null {
	// Already exhausted — the projection is "now", not a future estimate.
	if (remaining === 0) return Math.round(nowMs);
	// Nothing has been spent over the window, so there is nothing to extrapolate.
	if (burnRatePerHour === 0) return null;
	const projected = nowMs + (remaining / burnRatePerHour) * MS_PER_HOUR;
	return Number.isFinite(projected) ? Math.round(projected) : null;
}

/**
 * Compute remaining budget, burn rate, and projected exhaustion for a cost center.
 *
 * Input normalization is exact and total:
 *  - non-finite or negative `allocated` / `spent` → `0`
 *  - non-finite `periodStartMs` or `nowMs` → throws (a bad clock is a caller bug,
 *    and silently substituting a value would fabricate a runway)
 *  - non-finite `periodEndMs` → treated as absent (open-ended, `onPace` is null)
 *  - `periodEndMs <= periodStartMs` → treated as absent; an empty or inverted
 *    period cannot be paced against, so `onPace` is null rather than a coin flip
 *  - `nowMs < periodStartMs` → elapsed window of 0, so burn rate is 0
 *
 * @throws Error when `periodStartMs` or `nowMs` is not finite.
 */
export function computeRunway(input: RunwayInput): Runway {
	const { periodStartMs, nowMs } = input;
	if (!Number.isFinite(periodStartMs) || !Number.isFinite(nowMs)) {
		throw new Error("runway: periodStartMs and nowMs must be finite");
	}

	const allocated = normalizeAmount(input.allocated);
	const spent = normalizeAmount(input.spent);
	const periodEndMs =
		input.periodEndMs !== undefined &&
		Number.isFinite(input.periodEndMs) &&
		input.periodEndMs > periodStartMs
			? input.periodEndMs
			: undefined;

	const remaining = Math.max(0, allocated - spent);
	const fractionRemaining = allocated <= 0 ? 0 : clamp01(remaining / allocated);

	const elapsedHours = Math.max(0, nowMs - periodStartMs) / MS_PER_HOUR;
	const rawBurnRate = elapsedHours === 0 ? 0 : spent / elapsedHours;
	// A sub-ULP elapsed window with an enormous `spent` can overflow the division.
	// Saturate rather than emit Infinity — see TOTALITY in the module doc comment.
	const burnRatePerHour = Number.isFinite(rawBurnRate) ? rawBurnRate : Number.MAX_VALUE;

	const projectedExhaustionMs = projectExhaustion(remaining, burnRatePerHour, nowMs);
	const onPace =
		periodEndMs === undefined || projectedExhaustionMs === null
			? null
			: projectedExhaustionMs >= periodEndMs;

	return { remaining, fractionRemaining, burnRatePerHour, projectedExhaustionMs, onPace };
}
