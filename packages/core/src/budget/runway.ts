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
	 *
	 * An exhausted budget is never on pace. `remaining` of 0 projects exhaustion
	 * to `now`, so once `now` drifts past `periodEnd` the raw comparison would
	 * turn true again and report every fully-spent cost center from a closed
	 * period as healthy. `remaining` of 0 therefore forces false regardless of
	 * the clock; only the genuinely-unknown cases stay null.
	 */
	onPace: boolean | null;
}

/** Non-finite or negative allocations normalize to 0; finite positive pass through. */
function normalizeAllocated(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * A non-finite spend normalizes to `allocated`, not to 0.
 *
 * The asymmetry with {@link normalizeAllocated} is deliberate: both directions
 * are the fail-CLOSED one. An unusable allocation must not fabricate headroom,
 * so it reads as "nothing was granted". An unusable spend must not fabricate an
 * untouched budget — coercing NaN to 0 makes a broken figure (a caller deriving
 * `spent = costTotal / callCount` with a zero call count, say) byte-identical to
 * a cost center that has spent nothing, and a `budgetFractionRemaining lt 0.3`
 * tier then never fires on it. Assume the worst instead: fully consumed.
 *
 * A negative spend is a different case — an over-funded cost center holding more
 * than it was allocated, not a broken figure — and clamps to 0. `allocated` is
 * already normalized finite, so the result is always finite (see TOTALITY).
 */
function normalizeSpent(value: number, allocated: number): number {
	if (!Number.isFinite(value)) return allocated;
	return value > 0 ? value : 0;
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
 *  - non-finite or negative `allocated` → `0`
 *  - non-finite `spent` → `allocated`, i.e. fully consumed; negative `spent` → `0`
 *    (see `normalizeSpent` for why the two amounts coerce in opposite directions)
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

	const allocated = normalizeAllocated(input.allocated);
	const spent = normalizeSpent(input.spent, allocated);
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
	// `remaining > 0` is not redundant with the comparison: an exhausted budget
	// projects to `now`, which overtakes `periodEnd` once the period closes.
	const onPace =
		periodEndMs === undefined || projectedExhaustionMs === null
			? null
			: remaining > 0 && projectedExhaustionMs >= periodEndMs;

	return { remaining, fractionRemaining, burnRatePerHour, projectedExhaustionMs, onPace };
}

/**
 * Hours of runway left, or `null` when there is no projection.
 *
 * This is the ONLY safe way to derive `budgetRunwayHours` for a `PolicyContext`.
 * The obvious inline conversion — `(runway.projectedExhaustionMs - nowMs) / 3.6e6`
 * — coerces the `null` case (nothing spent yet, so nothing to extrapolate from)
 * to a large NEGATIVE number, and a `budgetRunwayHours lt 12` escalation rule
 * then fires on a cost center that is merely idle. Null in, null out: an absent
 * field is the honest input for "unknown", and the policy layer already treats
 * it as such.
 *
 * A projection at or before `nowMs` (the budget is already exhausted) clamps to
 * `0`. Negative hours would be meaningless and would order wrongly against any
 * threshold a caller sets.
 *
 * @throws Error when `nowMs` is not finite — same contract as {@link computeRunway}.
 */
export function runwayHours(runway: Runway, nowMs: number): number | null {
	if (!Number.isFinite(nowMs)) throw new Error("runway: nowMs must be finite");
	const { projectedExhaustionMs } = runway;
	if (projectedExhaustionMs === null) return null;
	return Math.max(0, (projectedExhaustionMs - nowMs) / MS_PER_HOUR);
}
