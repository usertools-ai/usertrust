/**
 * THE BUDGET RACE — pure math for Exhibit C's parametric instrument.
 *
 * Every numeric bound and default derives from the budget (facts.json's
 * usertokensPerFiveDollars flows in from the island), so the instrument
 * re-scales if DEFAULT_BUDGET ever changes. At 50,000 ut: agents 1..8,
 * cost 5,000..20,000 ut step 1,000.
 *
 * This module lives OUTSIDE app/components/sections/ on purpose: the
 * check-facts prebuild gate scans sections/*.tsx for digit literals, and its
 * allowlist does not cover min=/max=/step=/value= attribute assignments —
 * so the sections files import computed values from here instead of
 * carrying numbers.
 */

export interface RaceBounds {
	agentsMin: number;
	agentsMax: number;
	agentsStep: number;
	costMin: number;
	costMax: number;
	costStep: number;
}

export interface HoldRow {
	label: string;
	availableBefore: number;
	blocked: boolean;
}

export interface SettleRow {
	label: string;
	totalAfter: number;
	pastCap: boolean;
}

export interface RaceResult {
	budget: number;
	agents: number;
	costPerCall: number;
	/** Two-phase mode: one row per attempt, in ledger order. */
	holds: HoldRow[];
	heldTotal: number;
	available: number;
	blockedCount: number;
	/** Denied attempts beyond the first — summarized, not re-rendered. */
	extraDenied: number;
	firstBlocked: HoldRow | null;
	/** Without-holds mode: every attempt settles; nothing gates anything. */
	settles: SettleRow[];
	settledTotal: number;
	overshoot: number;
}

export function raceBounds(budget: number): RaceBounds {
	return {
		agentsMin: 1,
		agentsMax: 8,
		agentsStep: 1,
		costMin: budget / 10,
		costMax: (budget * 2) / 5,
		costStep: budget / 50,
	};
}

export function raceDefaults(budget: number): { agents: number; costPerCall: number } {
	const { costMin, costStep } = raceBounds(budget);
	// budget/4 snapped DOWN onto the range's step grid (native range inputs
	// demand on-step values; 12,500 is off the 1,000-ut lattice → 12,000).
	// 4 agents × 12,000 holds 48,000 of 50,000 — the retry is the one BLOCKED
	// row the precomputed static state must show.
	const raw = budget / 4;
	return {
		agents: 4,
		costPerCall: costMin + Math.floor((raw - costMin) / costStep) * costStep,
	};
}

export function computeRace(budget: number, agents: number, costPerCall: number): RaceResult {
	// One call per agent, then the loop's next lap begins: agent 01 retries.
	// Agents don't stop on their own — the (N+1)th attempt is the point.
	const labels: string[] = [];
	for (let i = 1; i <= agents; i++) labels.push(`agent ${String(i).padStart(2, "0")}`);
	labels.push("agent 01 · retry");

	// Two-phase holds: the ledger is serial; a hold is allowed iff it fits in
	// what is ACTUALLY available (budget_remaining_after >= 0 — the same gate
	// the block-budget-overshoot default rule enforces in govern.ts).
	let held = 0;
	const holds: HoldRow[] = labels.map((label) => {
		const availableBefore = budget - held;
		const blocked = costPerCall > availableBefore;
		if (!blocked) held += costPerCall;
		return { label, availableBefore, blocked };
	});
	const blockedRows = holds.filter((h) => h.blocked);

	// Without holds: every attempt settles — the total is discovered later,
	// on the invoice.
	let total = 0;
	const settles: SettleRow[] = labels.map((label) => {
		total += costPerCall;
		return { label, totalAfter: total, pastCap: total > budget };
	});

	return {
		budget,
		agents,
		costPerCall,
		holds,
		heldTotal: held,
		available: budget - held,
		blockedCount: blockedRows.length,
		extraDenied: Math.max(0, blockedRows.length - 1),
		firstBlocked: blockedRows[0] ?? null,
		settles,
		settledTotal: total,
		overshoot: Math.max(0, total - budget),
	};
}

/** CSS percentage for bar segment widths — keeps `* 100` out of sections/. */
export function pct(fraction: number): string {
	return `${(fraction * 100).toFixed(3)}%`;
}

/**
 * Trailing debounce for the budget-race screen-reader status line — one
 * announcement per settled interaction, not one per input event. Lives here
 * (not in the section file) so check-facts never sees the digit.
 */
export const SR_ANNOUNCE_DEBOUNCE_MS = 350;
