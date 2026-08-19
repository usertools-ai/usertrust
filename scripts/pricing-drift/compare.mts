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
import { resolveAppliedRates } from "../../packages/core/src/ledger/pricing.js";
import type { ModelSourceMap } from "./model-map.mts";
import type { SourceRates } from "./sources.mts";

/** The four tiers, compared independently. */
export const TIERS = ["inputPer1k", "outputPer1k", "cacheReadPer1k", "cacheWritePer1k"] as const;
export type Tier = (typeof TIERS)[number];

/** Tiers that must be present on both sides for a model to count as corroborated. */
const REQUIRED_TIERS: readonly Tier[] = ["inputPer1k", "outputPer1k"];

/**
 * CHECKED-IN COVERAGE FLOORS, deliberately NOT derived from MODEL_MAP.
 *
 * The derived expectation catches a source dropping a model. It cannot catch
 * the map itself being weakened: setting one model's `litellm` to `null`
 * lowers the actual AND the expected count together, so 35/35 passes and an
 * independent check is lost with the gate unmoved. A gate computed from the
 * thing it is guarding is not a gate.
 *
 * Both are enforced. Lowering either number is an explicit, reviewable edit —
 * which is the point: a model legitimately leaving a feed should require
 * someone to say so.
 */
export const MIN_CORROBORATED_MODELS = 19;
export const MIN_MAPPINGS = 36;

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
	| "unmapped"
	/** A required tier in our own table is not a finite non-negative number. FAILS. */
	| "malformed-rate";

/** Outcomes that make the run fail with exit 1. */
const FAILING: ReadonlySet<Outcome> = new Set<Outcome>([
	"deviation-stale",
	"understated",
	"disagree",
	"unmapped",
	"malformed-rate",
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
	/** Highest value any source publishes. Differs from `upstream` on conflict. */
	upstreamMax: number;
	/** True when the sources disagree with each other on this tier. */
	conflicted: boolean;
	/**
	 * The sources that actually publish THIS tier.
	 *
	 * Not the model's answering sources: when both answer input/output but only
	 * one publishes the cache tier that differs, rendering both beside that
	 * comparison attributes a rate to a source that never stated it. A reader
	 * checking the other source finds nothing and cannot tell whether the tool
	 * or the source is wrong.
	 */
	publishedBy: string[];
}

/**
 * A tier upstream publishes that our table omits, with the sources that
 * actually publish it — never the model's full answering set. Same reason as
 * `TierDiff.publishedBy`: crediting a cache tier to a source that never stated
 * one sends a reader to check something that was never there.
 */
export interface CacheGap {
	tier: Tier;
	publishedBy: string[];
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
	cacheGaps: CacheGap[];
	sources: string[];
	note?: string;
}

export interface DriftReport {
	findings: ModelFinding[];
	counts: Record<Outcome, number>;
	/** Models with at least one answering source (human-facing summary). */
	corroborated: number;
	expectedCorroborated: number;
	/**
	 * Answered (source, model) PAIRS — the quantity the coverage gate actually
	 * enforces. Counting models is too coarse: if LiteLLM drops `gpt-4o` while
	 * models.dev still answers, the model stays "corroborated" and a whole
	 * independent check disappears with the floor unmoved.
	 */
	mappings: number;
	expectedMappings: number;
	/** `source:model` pairs the map promised that no source answered. */
	missingMappings: string[];
	/** Absolute floors applied, and whether either was breached. */
	floors: { minMappings: number; minCorroboratedModels: number; breached: boolean };
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
		"malformed-rate": 0,
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
 * What our table actually METERS a tier at, THROUGH THE CANONICAL RESOLVER.
 *
 * An omitted cache tier is priced at `inputPer1k` by `costFromRates`. That is
 * conservative for a cache-READ discount (~0.1x input) but NOT for a
 * cache-WRITE premium (1.25x input), where falling back to `inputPer1k`
 * UNDERSTATES by 20%. Understatement therefore has to be judged on the
 * effective rate, never on field presence.
 *
 * `resolveAppliedRates` is used rather than a local `?? inputPer1k`, because
 * AGENTS.md forbids a second D1 resolution site — and the duplicate had already
 * diverged: a NEGATIVE finite cache rate is metered at `inputPer1k` by the SDK
 * (its guard is `>= 0`) but would have been compared as negative here. A
 * monitor that resolves rates differently from the thing it monitors is
 * measuring the wrong quantity.
 */
function effectiveRate(rates: ModelRates, tier: Tier): number {
	return resolveAppliedRates(rates)[tier];
}

/**
 * One tier resolved across every answering source.
 *
 * BOTH ends of the range are retained. The minimum alone cannot answer
 * "is our rate conservative?": with sources at 50 and 70 and our fallback at
 * 60, we are above one and below the other, which is neither understatement
 * nor a benign gap — and a report showing only 50 would call it conservative
 * while hiding the source that says otherwise.
 */
interface TierConsensus {
	min: number;
	max: number;
	conflicted: boolean;
	publishedBy: string[];
}

function resolveTier(
	answered: { name: string; rates: SourceRates }[],
	tier: Tier,
): TierConsensus | null {
	const publishing = answered.filter((a) => {
		const v = a.rates[tier];
		return v !== undefined && Number.isFinite(v);
	});
	if (publishing.length === 0) return null;
	const values = publishing.map((a) => a.rates[tier] as number);
	return {
		min: Math.min(...values),
		max: Math.max(...values),
		conflicted: new Set(values).size > 1,
		publishedBy: publishing.map((a) => a.name),
	};
}

export interface CompareInput {
	table: Record<string, ModelRates>;
	map: Record<string, ModelSourceMap>;
	deviations: Record<string, { reason: string }>;
	sources: Record<string, Record<string, SourceRates | null>>;
	/**
	 * Absolute coverage floors. Passed in rather than hardcoded here so this
	 * function stays drivable from small fixtures; run.mts supplies the shipped
	 * `MIN_MAPPINGS` / `MIN_CORROBORATED_MODELS`. Default 0 = derived checks only.
	 */
	floors?: { minMappings?: number; minCorroboratedModels?: number };
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

		// Sources are collected BEFORE the malformed check so a malformed finding
		// still reports who answered. `mappings` and `corroborated` are derived
		// from finding.sources, so hard-coding [] here invented a coverage breach
		// with an empty `missingMappings` — a second, false failure reason
		// attached to a real one.
		const answeredEarly: { name: string; rates: SourceRates }[] = [];
		for (const [name, normalized] of Object.entries(sources)) {
			const r = normalized[model];
			if (r) answeredEarly.push({ name, rates: r });
		}

		// OUR OWN TABLE IS VALIDATED FIRST. `rawTier` rejects a non-finite value,
		// so an `inputPer1k` of Infinity or NaN would fall through the cache-absence
		// path — required tiers are merely excluded from `cacheGaps` — and emit no
		// diff at all, reporting `agree` for a model whose metered cost is not a
		// number. A malformed rate is a failure of the table, not agreement with
		// upstream, and it is caught before any comparison is attempted.
		// Finite AND non-negative. `rawTier` alone accepts -1, and a negative input
		// rate is not a rate — for the CACHE tiers a negative value has a defined
		// meaning (it resolves to inputPer1k, per the canonical resolver), but for
		// input and output there is nothing to fall back to.
		const malformed = REQUIRED_TIERS.filter((t) => {
			const v = rawTier(ours, t);
			return v === undefined || v < 0;
		});
		if (malformed.length > 0) {
			findings.push({
				model,
				outcome: "malformed-rate",
				diffs: [],
				cacheGaps: [],
				sources: answeredEarly.map((a) => a.name),
				note: `required tier(s) ${malformed.join(", ")} are not finite non-negative numbers in PRICING_TABLE`,
			});
			counts["malformed-rate"]++;
			continue;
		}

		const answered = answeredEarly;
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
		const cacheGaps: CacheGap[] = [];
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
					upstreamMax: up.max,
					publishedBy: up.publishedBy,
					conflicted: up.conflicted,
				});
				continue;
			}

			if (raw === undefined) {
				// An omitted tier is only BENIGN if it meters at or above EVERY
				// source. Between min and max it is above one source and below
				// another — not understatement, but not conservative either, so it
				// is reported as a conflicted diff rather than filed as a safe gap.
				if (effective >= up.max) {
					if (!REQUIRED_TIERS.includes(tier)) {
						cacheGaps.push({ tier, publishedBy: up.publishedBy });
					}
					// Conservative, but if the sources disagreed on this tier the model
					// is still classified `source-conflict` — and with no diff recorded
					// the report would render "—", hiding the very values that caused
					// the conflict.
					if (up.conflicted) {
						diffs.push({
							tier,
							ours: null,
							effective,
							upstream: up.min,
							upstreamMax: up.max,
							publishedBy: up.publishedBy,
							conflicted: true,
						});
					}
				} else {
					diffs.push({
						tier,
						ours: null,
						effective,
						upstream: up.min,
						upstreamMax: up.max,
						publishedBy: up.publishedBy,
						conflicted: true,
					});
				}
				continue;
			}

			// A conflicted tier proposes no value — EXCEPT when our rate sits
			// outside the range entirely. Above every source it matches none of
			// them, so the disagreement is definite even though the sources argue
			// about where the true value is. Only a rate INSIDE the range is
			// genuinely undecidable.
			if (up.conflicted) {
				diffs.push({
					tier,
					ours: raw,
					effective,
					upstream: up.min,
					upstreamMax: up.max,
					publishedBy: up.publishedBy,
					// `effective`, not `raw`: a negative cache rate meters at inputPer1k
					// under the canonical rule, so raw -5 against sources 5/10 would
					// read as in-range when the SDK is actually charging 50.
					conflicted: effective <= up.max,
				});
				continue;
			}

			if (raw !== up.min) {
				diffs.push({
					tier,
					ours: raw,
					effective,
					upstream: up.min,
					upstreamMax: up.max,
					publishedBy: up.publishedBy,
					conflicted: false,
				});
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

		// DEFINITIVE DIFFS OUTRANK CONFLICT. A tier every source agrees on, that
		// our table contradicts, is a finding regardless of what the sources do
		// on some OTHER tier — otherwise ours 75/250 against 50/200 and 50/250
		// returns a non-failing `source-conflict` while input is a unanimous,
		// unallowlisted mismatch.
		//
		// This is the round-1 understatement fix reappearing one level up: that
		// round stopped conflict from masking understatement but left it masking
		// plain disagreement. Same defect, same file, one abstraction higher.
		const definitive = diffs.filter((d) => !d.conflicted);

		// A model-wide allowlist must NOT absorb a conflicted tier. For ours
		// 75/250 against sources 50/200 and 50/300, input is a definitive
		// conservative deviation but output straddles our rate — labelling the
		// whole model `deviation-expected` reports "ours is higher" while one
		// source prices output above us. An allowlist excuses a deviation we
		// understand; it cannot excuse a tier nobody can adjudicate.
		const definitiveFailing = definitive.length > 0 && deviations[model] === undefined;

		if (anyConflict && !definitiveFailing) {
			findings.push({
				model,
				outcome: "source-conflict",
				diffs,
				cacheGaps,
				sources: sourceNames,
				// Deliberately does NOT claim our rate exceeds every source: with
				// sources at 50 and 70 and ours at 60 that would be false, and this
				// outcome does not fail, so the note would falsely reassure. All that
				// is true here is that no definitive value can be selected.
				note: "sources disagree with each other; no definitive upstream value can be selected. Our rate is not below the lowest of them.",
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

	// THE GATE IS PER-MAPPING. Every source the map names for a model must have
	// answered for it. A model corroborated by one source when the map promised
	// two has lost an independent check, and a model-level count cannot see it:
	// if LiteLLM drops `gpt-4o` while models.dev still answers, the model stays
	// "corroborated" and the floor never moves.
	const expectedMappings = Object.entries(map)
		.filter(([m]) => m in table)
		.reduce((n, [, e]) => n + (e.litellm !== null ? 1 : 0) + (e.modelsDev !== null ? 1 : 0), 0);
	const mappings = findings.reduce((n, f) => n + f.sources.length, 0);

	// Which (source, model) pairs the map promised and did not get — named, not
	// merely counted, so the issue says WHICH check disappeared.
	const missingMappings: string[] = [];
	for (const [model, entry] of Object.entries(map)) {
		if (!(model in table)) continue;
		const answered = new Set(
			Object.entries(sources)
				.filter(([, norm]) => norm[model])
				.map(([name]) => name),
		);
		if (entry.litellm !== null && !answered.has("litellm"))
			missingMappings.push(`litellm:${model}`);
		if (entry.modelsDev !== null && !answered.has("models.dev")) {
			missingMappings.push(`models.dev:${model}`);
		}
	}
	missingMappings.sort();

	const minMappings = input.floors?.minMappings ?? 0;
	const minCorroboratedModels = input.floors?.minCorroboratedModels ?? 0;
	// Surfaced on the report, not just folded into `failed`. Both counts can
	// match their derived expectation while sitting below the absolute floor —
	// no missing mappings, every model `agree`, and an issue with no stated
	// reason unless this is rendered.
	const floorsBreached = mappings < minMappings || corroborated < minCorroboratedModels;

	const exhaustive = assertExhaustive(counts, Object.keys(table).length);
	const failed =
		findings.some((f) => isFailing(f.outcome)) ||
		mappings < expectedMappings ||
		corroborated < expectedCorroborated ||
		floorsBreached ||
		!exhaustive;

	return {
		findings,
		counts,
		corroborated,
		expectedCorroborated,
		mappings,
		expectedMappings,
		missingMappings,
		floors: { minMappings, minCorroboratedModels, breached: floorsBreached },
		exhaustive,
		failed,
	};
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
