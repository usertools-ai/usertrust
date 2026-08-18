/**
 * compare.mts — every decision rule, and no I/O whatsoever.
 *
 * THE POSTURE: every model in PRICING_TABLE is assigned EXACTLY ONE outcome,
 * the outcome counts must sum to the table size, and **only `agree` is
 * silent**. Every other outcome
 * reports by construction. Enumerating the cases that deserve a mention is the
 * wrong default — it fails toward silence, which is the failure mode this whole
 * tool exists to prevent.
 *
 * The exhaustiveness is mechanical (`assertExhaustive` below), not a
 * hand-maintained list that drifts from the union.
 */

import type { ModelRates } from "../../packages/core/src/ledger/pricing.js";
import type { ModelSourceMap } from "./model-map.mts";
import type { SourceRates } from "./sources.mts";

/** The four tiers, compared independently. */
export const TIERS = ["inputPer1k", "outputPer1k", "cacheReadPer1k", "cacheWritePer1k"] as const;
export type Tier = (typeof TIERS)[number];

/** Tiers that MUST be present on both sides for a model to count as corroborated. */
const REQUIRED_TIERS: Tier[] = ["inputPer1k", "outputPer1k"];

export type Outcome =
	/** Corroborated and matching on every compared tier. THE ONLY SILENT OUTCOME. */
	| "agree"
	/** Allowlisted deviation, ours >= upstream. Reported, does not fail. */
	| "deviation-expected"
	/** Allowlisted, but the model now agrees — the exemption outlived its reason. FAILS. */
	| "deviation-stale"
	/** Ours is BELOW a consensus upstream rate. Never allowlistable. FAILS. */
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
	/** `null` when our table omits this tier (priced at inputPer1k via D1). */
	ours: number | null;
	upstream: number;
}

export interface ModelFinding {
	model: string;
	outcome: Outcome;
	/** Per-tier mismatches, for the report. */
	diffs: TierDiff[];
	/** Tiers upstream publishes that our table omits (we price them at inputPer1k). */
	cacheGaps: Tier[];
	/** Which sources answered for this model. */
	sources: string[];
	/** Map note (why there is no source) or deviation reason. */
	note?: string;
}

export interface DriftReport {
	findings: ModelFinding[];
	counts: Record<Outcome, number>;
	/** Models with at least one answering source. */
	corroborated: number;
	/** Models the MAP claims should be corroborated — the coverage floor. */
	expectedCorroborated: number;
	/** True when every model was assigned an outcome and the counts sum correctly. */
	exhaustive: boolean;
	failed: boolean;
}

/** Compile-time + runtime proof that the Outcome union is fully handled. */
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
 * This is deliberate and load-bearing (spec §5.1). `pricing.ts` omits a cache
 * field wherever the provider publishes no rate, and `costFromRates` then
 * prices those tokens at `inputPer1k` — conservative overstatement by design.
 * Resolving our side before comparing would make an omitted tier compare as
 * `inputPer1k` against upstream's real discount and read as a disagreement,
 * inverting the row's meaning. Compare raw fields; interpret absence explicitly.
 */
function ourTier(rates: ModelRates, tier: Tier): number | undefined {
	const v = rates[tier];
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Do two sources agree on every tier they both publish? */
function sourcesAgree(a: SourceRates, b: SourceRates): boolean {
	return TIERS.every((t) => {
		const x = a[t];
		const y = b[t];
		if (x === undefined || y === undefined) return true;
		return x === y;
	});
}

export interface CompareInput {
	table: Record<string, ModelRates>;
	map: Record<string, ModelSourceMap>;
	deviations: Record<string, { reason: string }>;
	/** Normalized, vendor-pinned source outputs, keyed by source name. */
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

		// Collect the sources that actually answered for this model.
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

		// Sources that contradict EACH OTHER: report, propose nothing. We cannot
		// say which is right, so failing here would be a permanently-red row.
		const conflict = answered.some(
			(a, i) => i > 0 && !sourcesAgree(a.rates, (answered[0] as { rates: SourceRates }).rates),
		);
		if (conflict) {
			const diffs: TierDiff[] = [];
			for (const t of TIERS) {
				const vals = answered.map((a) => a.rates[t]).filter((v): v is number => v !== undefined);
				if (new Set(vals).size > 1) {
					const our = ourTier(ours, t);
					// `null`, never NaN: an omitted tier is a fact about our table,
					// and NaN in a report reads as a broken number instead.
					diffs.push({ tier: t, ours: our ?? null, upstream: Math.min(...vals) });
				}
			}
			findings.push({
				model,
				outcome: "source-conflict",
				diffs,
				cacheGaps: [],
				sources: sourceNames,
			});
			counts["source-conflict"]++;
			continue;
		}

		// Sources agree with each other (or there is only one): their shared value
		// is the consensus this model is measured against.
		const consensus = (answered[0] as { rates: SourceRates }).rates;
		const diffs: TierDiff[] = [];
		const cacheGaps: Tier[] = [];
		let understated = false;

		for (const t of TIERS) {
			const up = consensus[t];
			if (up === undefined) continue;
			const our = ourTier(ours, t);
			if (our === undefined) {
				// Upstream publishes a tier we omit. Our effective rate is inputPer1k
				// (the D1 fallback) — an overstatement, so never a failure — but it
				// is a real gap and is always reported.
				if (!REQUIRED_TIERS.includes(t)) cacheGaps.push(t);
				continue;
			}
			if (our !== up) {
				diffs.push({ tier: t, ours: our, upstream: up });
				if (our < up) understated = true;
			}
		}

		const deviation = deviations[model];

		// UNDERSTATEMENT IS CHECKED BEFORE THE ALLOWLIST AND IGNORES IT.
		// There is no field that permits it and no path that reaches a pass with
		// our rate below a corroborated upstream rate. This is what enforces the
		// D1 invariant rather than restating it.
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

		if (diffs.length === 0) {
			// Matches upstream. If an allowlist entry still names it, the exemption
			// has outlived its reason and must be removed.
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

		// Ours differs upward on at least one tier.
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

	// THE COVERAGE FLOOR (spec §6.1) is DERIVED from the map, not a transcribed
	// constant: every model the map claims a source for must actually have been
	// answered. If models.dev renames `cost.cache_read`, a naive checker finds no
	// mismatches and reports a clean sweep — of nothing. This turns that silence
	// into a failure, and it self-maintains as models are added.
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

/**
 * Allowlist entries naming a model that is not in PRICING_TABLE at all. Kept
 * separate from the per-model walk because there is no table row to hang it on,
 * but it is the same class as `deviation-stale`: an exemption with nothing left
 * to exempt.
 */
export function orphanDeviations(
	table: Record<string, ModelRates>,
	deviations: Record<string, { reason: string }>,
): string[] {
	return Object.keys(deviations)
		.filter((m) => !(m in table))
		.sort();
}
