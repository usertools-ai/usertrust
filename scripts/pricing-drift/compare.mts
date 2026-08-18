/**
 * compare.mts — every decision rule, and no I/O whatsoever.
 *
 * THE POSTURE: every model in PRICING_TABLE is assigned EXACTLY ONE outcome,
 * the outcome counts must sum to the table size, and **only `agree` is
 * silent**. Every other outcome reports by construction. Enumerating the cases
 * that deserve a mention is the wrong default — it fails toward silence, which
 * is the failure mode this whole tool exists to prevent.
 *
 * COMPARISON IS PER-TIER AND SPANS EVERY SOURCE. Each of the four tiers is
 * resolved independently across all answering sources, because the alternative
 * — electing one source as "the" consensus — discards tiers the other source
 * publishes and makes the verdict depend on source ORDER. Three of the four P1
 * findings in this file's first review were variations on that one mistake.
 *
 * UNDERSTATEMENT IS PROVEN AGAINST THE MINIMUM upstream value, and it is
 * checked BEFORE conflict, BEFORE the allowlist, and on tiers our table omits.
 * If our metered rate is below EVERY value any source publishes, disagreement
 * among those sources does not rescue it: it is low on all readings.
 */

import type { ModelRates } from "../../packages/core/src/ledger/pricing.js";
import type { ModelSourceMap } from "./model-map.mts";
import type { SourceRates } from "./sources.mts";

/** The four tiers, compared independently. */
export const TIERS = ["inputPer1k", "outputPer1k", "cacheReadPer1k", "cacheWritePer1k"] as const;
export type Tier = (typeof TIERS)[number];

/** Tiers that must be present on both sides for a model to count as corroborated. */
const REQUIRED_TIERS: readonly Tier[] = ["inputPer1k", "outputPer1k"];

export type Outcome =
	/** Corroborated and matching on every compared tier. THE ONLY SILENT OUTCOME. */
	| "agree"
	/** Allowlisted deviation, ours >= upstream. Reported, does not fail. */
	| "deviation-expected"
	/** Allowlisted, but the model now agrees — the exemption outlived its reason. FAILS. */
	| "deviation-stale"
	/** Ours meters below EVERY upstream value on some tier. Never allowlistable. FAILS. */
	| "understated"
	/** Ours differs upward with no allowlist entry. FAILS. */
	| "disagree"
	/** The sources contradict each other. Reported with NO value proposed. */
	| "source-conflict"
	/** No upstream source publishes this model. Reported, does not fail. */
	| "uncorroborated"
	/** In PRICING_TABLE but absent from MODEL_MAP. FAILS. */
	| "unmapped";

/** Outcomes that make the run fail with exit 1. */
const FAILING: ReadonlySet<Outcome> = new Set<Outcome>([
	"deviation-stale",
	"understated",
	"disagree",
	"unmapped",
]);

export function isFailing(outcome: Outcome): boolean {
	return FAILING.has(outcome);
}

export interface TierDiff {
	tier: Tier;
	/** `null` when our table omits this tier outright. */
	ours: number | null;
	/**
	 * What our table actually METERS this tier at: `ours` when the field is
	 * present, `inputPer1k` when it is omitted (the D1 fallback).
	 */
	effective: number;
	/** Lowest value any source publishes for this tier. */
	upstream: number;
	/** True when the sources disagree with each other on this tier. */
	conflicted: boolean;
}

export interface ModelFinding {
	model: string;
	outcome: Outcome;
	diffs: TierDiff[];
	/**
	 * Tiers upstream publishes that our table omits AND that meter at or above
	 * upstream through the `inputPer1k` fallback — genuine conservative
	 * overstatement. A gap that meters BELOW upstream is understatement; it
	 * lands in `diffs` under outcome `understated` instead.
	 */
	cacheGaps: Tier[];
	sources: string[];
	note?: string;
}

export interface DriftReport {
	findings: ModelFinding[];
	counts: Record<Outcome, number>;
	corroborated: number;
	expectedCorroborated: number;
	exhaustive: boolean;
	failed: boolean;
}

function assertExhaustive(counts: Record<Outcome, number>, total: number): boolean {
	return Object.values(counts).reduce((a, b) => a + b, 0) === total;
}

function emptyCounts(): Record<Outcome, number> {
	return {
		agree: 0,
		"deviation-expected": 0,
		"deviation-stale": 0,
		understated: 0,
		disagree: 0,
		"source-conflict": 0,
		uncorroborated: 0,
		unmapped: 0,
	};
}

/**
 * Read one tier off our table WITHOUT resolving it through `effectiveCacheRate`.
 *
 * Deliberate. `pricing.ts` omits a cache field wherever the provider publishes
 * no rate; resolving our side before comparing would make an omitted tier
 * compare as `inputPer1k` against upstream's real discount and read as a
 * disagreement. Absence is interpreted explicitly instead — see `effectiveRate`
 * for the one question that genuinely needs the D1 resolution.
 */
function rawTier(rates: ModelRates, tier: Tier): number | undefined {
	const v = rates[tier];
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * What our table actually METERS a tier at — the D1 resolution.
 *
 * An omitted cache tier is priced at `inputPer1k` by `costFromRates`. That is
 * conservative for a cache-READ discount (~0.1x input) but NOT for a
 * cache-WRITE premium (1.25x input), where falling back to `inputPer1k`
 * UNDERSTATES by 20%. Understatement therefore has to be judged on the
 * effective rate, never on field presence.
 */
function effectiveRate(rates: ModelRates, tier: Tier): number {
	return rawTier(rates, tier) ?? rates.inputPer1k;
}

/** One tier resolved across every answering source. */
interface TierConsensus {
	min: number;
	conflicted: boolean;
}

function resolveTier(answered: { rates: SourceRates }[], tier: Tier): TierConsensus | null {
	const values = answered
		.map((a) => a.rates[tier])
		.filter((v): v is number => v !== undefined && Number.isFinite(v));
	if (values.length === 0) return null;
	return { min: Math.min(...values), conflicted: new Set(values).size > 1 };
}

export interface CompareInput {
	table: Record<string, ModelRates>;
	map: Record<string, ModelSourceMap>;
	deviations: Record<string, { reason: string }>;
	sources: Record<string, Record<string, SourceRates | null>>;
}

export function compareTable(input: CompareInput): DriftReport {
	const { table, map, deviations, sources } = input;
	const findings: ModelFinding[] = [];
	const counts = emptyCounts();

	for (const model of Object.keys(table).sort()) {
		const ours = table[model];
		if (ours === undefined) continue;

		const mapping = map[model];
		if (mapping === undefined) {
			findings.push({
				model,
				outcome: "unmapped",
				diffs: [],
				cacheGaps: [],
				sources: [],
				note: "present in PRICING_TABLE but absent from MODEL_MAP — provenance undecided",
			});
			counts.unmapped++;
			continue;
		}

		const answered: { name: string; rates: SourceRates }[] = [];
		for (const [name, normalized] of Object.entries(sources)) {
			const r = normalized[model];
			if (r) answered.push({ name, rates: r });
		}
		const sourceNames = answered.map((a) => a.name);

		if (answered.length === 0) {
			findings.push({
				model,
				outcome: "uncorroborated",
				diffs: [],
				cacheGaps: [],
				sources: [],
				...(mapping.note !== undefined ? { note: mapping.note } : {}),
			});
			counts.uncorroborated++;
			continue;
		}

		const diffs: TierDiff[] = [];
		const cacheGaps: Tier[] = [];
		let understated = false;
		let anyConflict = false;

		for (const tier of TIERS) {
			const up = resolveTier(answered, tier);
			if (up === null) continue; // no source publishes this tier
			if (up.conflicted) anyConflict = true;

			const raw = rawTier(ours, tier);
			const effective = effectiveRate(ours, tier);

			// UNDERSTATEMENT IS PROVEN AGAINST THE MINIMUM. Metering below every
			// value any source publishes means we are low on all readings, so
			// neither cross-source disagreement nor the allowlist can rescue it.
			if (effective < up.min) {
				understated = true;
				diffs.push({
					tier,
					ours: raw ?? null,
					effective,
					upstream: up.min,
					conflicted: up.conflicted,
				});
				continue;
			}

			if (raw === undefined) {
				// Omitted tier metering at or above upstream: conservative
				// overstatement through the D1 fallback. Reported, never failed.
				if (!REQUIRED_TIERS.includes(tier)) cacheGaps.push(tier);
				continue;
			}

			// A conflicted tier proposes no value, so nothing beyond the
			// understatement check above can be concluded from it.
			if (up.conflicted) {
				diffs.push({ tier, ours: raw, effective, upstream: up.min, conflicted: true });
				continue;
			}

			if (raw !== up.min) {
				diffs.push({ tier, ours: raw, effective, upstream: up.min, conflicted: false });
			}
		}

		const deviation = deviations[model];

		if (understated) {
			findings.push({
				model,
				outcome: "understated",
				diffs,
				cacheGaps,
				sources: sourceNames,
				...(deviation !== undefined
					? {
							note: `allowlisted, but the allowlist CANNOT suppress understatement: ${deviation.reason}`,
						}
					: {}),
			});
			counts.understated++;
			continue;
		}

		if (anyConflict) {
			findings.push({
				model,
				outcome: "source-conflict",
				diffs,
				cacheGaps,
				sources: sourceNames,
				note: "sources disagree with each other; no value proposed. Our rate is not below any of them.",
			});
			counts["source-conflict"]++;
			continue;
		}

		if (diffs.length === 0) {
			if (deviation !== undefined) {
				findings.push({
					model,
					outcome: "deviation-stale",
					diffs,
					cacheGaps,
					sources: sourceNames,
					note: `upstream now agrees; remove this allowlist entry: ${deviation.reason}`,
				});
				counts["deviation-stale"]++;
			} else {
				findings.push({ model, outcome: "agree", diffs, cacheGaps, sources: sourceNames });
				counts.agree++;
			}
			continue;
		}

		if (deviation !== undefined) {
			findings.push({
				model,
				outcome: "deviation-expected",
				diffs,
				cacheGaps,
				sources: sourceNames,
				note: deviation.reason,
			});
			counts["deviation-expected"]++;
		} else {
			findings.push({ model, outcome: "disagree", diffs, cacheGaps, sources: sourceNames });
			counts.disagree++;
		}
	}

	const corroborated = findings.filter(
		(f) => f.sources.length > 0 && f.outcome !== "uncorroborated",
	).length;

	// THE COVERAGE FLOOR is DERIVED from the map, never a transcribed constant:
	// every model the map claims a source for must actually have been answered.
	// If a source renames a field, a naive checker finds no mismatches and
	// reports a clean sweep — of nothing. This turns that silence into a
	// failure, and it self-maintains as models are added.
	const expectedCorroborated = Object.entries(map).filter(
		([m, e]) => m in table && (e.litellm !== null || e.modelsDev !== null),
	).length;

	const exhaustive = assertExhaustive(counts, Object.keys(table).length);
	const failed =
		findings.some((f) => isFailing(f.outcome)) ||
		corroborated < expectedCorroborated ||
		!exhaustive;

	return { findings, counts, corroborated, expectedCorroborated, exhaustive, failed };
}

/** Every model carrying a reported cache gap, whatever its outcome. */
export function cacheGapFindings(report: DriftReport): ModelFinding[] {
	return report.findings.filter((f) => f.cacheGaps.length > 0);
}

/**
 * Allowlist entries naming a model that is not in PRICING_TABLE at all — the
 * same class as `deviation-stale`: an exemption with nothing left to exempt.
 */
export function orphanDeviations(
	table: Record<string, ModelRates>,
	deviations: Record<string, { reason: string }>,
): string[] {
	return Object.keys(deviations)
		.filter((m) => !(m in table))
		.sort();
}
