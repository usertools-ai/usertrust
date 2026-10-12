// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * usage.ts — the ONE normalization module (spec D2 + the D5 snapshot rule).
 *
 * Core's canonical usage is four DISJOINT tiers: fresh input, output, cache
 * read, cache write. Providers do not agree on that shape, so every boundary
 * that reads provider usage funnels through the extractors here. No boundary
 * hand-rolls the extraction math again — a second derivation is how the two
 * halves of a settle (the cost and the record) drift apart.
 *
 * Two rules govern everything below.
 *
 * **D2 — normalization is per SOURCE, not per provider.** Whether to subtract
 * depends on who normalized the counters first:
 *
 *   - Anthropic's SDK reports the three input counters as already disjoint
 *     (`input_tokens` is fresh-only) ⇒ PASS THROUGH. Subtracting there
 *     undercounts, which is the dangerous direction.
 *   - OpenAI completions / Responses and Gemini report an INCLUSIVE prompt
 *     count ⇒ SUBTRACT the cache tiers back out, clamped at 0.
 *   - pi-ai's pinned adapters normalize to disjoint before core ever sees the
 *     numbers ⇒ those boundaries pass through too and must NOT call the
 *     subtracting extractors. (That row lives at the openclaw boundary; it is
 *     named here so nobody "fixes" it by routing it through this file.)
 *
 * **D5 — one sanitized snapshot per settle.** The object an extractor returns
 * is what feeds `costFromRates` AND record emission. Raw provider values reach
 * neither. That is not tidiness: `canonicalize()` throws on NaN and Infinity,
 * so a single non-finite provider count would fail the audit write for the
 * whole settle. Everything that leaves this module is a finite integer >= 0.
 *
 * Every function here is pure — no I/O, no clock, no config.
 */

import type { CacheWrite1h, ReceiptUsage } from "../shared/types.js";
import {
	type ModelRates,
	promptTierRates,
	promptTokenCount,
	resolveCacheWrite1h,
	supportsCacheWrite1h,
} from "./pricing.js";

/**
 * A sanitized, four-tier, disjoint usage snapshot.
 *
 * Invariants held by construction (see `sanitizeUsage`): all four counts are
 * finite integers >= 0, and the tiers do not overlap — summing them gives the
 * total billable tokens for the call.
 */
/**
 * The most tokens ONE tier of ONE call may plausibly report: 100 million.
 *
 * No real response gets near it (the largest context windows are a few million tokens, and output is bounded by
 * `max_tokens`), and the bound is far enough above every real figure that it never rejects true usage. What it exists
 * for is a figure that is finite and absurd: `1e12` tokens priced to 2.77e18 UT, was added to the session counter,
 * persisted, and refused every later call in the vault. Nothing in the stack bounds it natively: a provider SDK types
 * a count as `number`, and TigerBeetle's amounts are 128-bit, so only the ledger's cap at the hold (not the counter)
 * limits what a bad figure does.
 */
export const MAX_PLAUSIBLE_TOKENS_PER_TIER = 100_000_000;

/** Every tier, in a fixed order: iteration over a caller's object never decides which tiers are read. */
export const USAGE_TIERS = [
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"cacheWrite1hTokens",
] as const;

/**
 * A caller's per-tier maxima as a PLAIN object, each tier read exactly once by name (a getter fires here, before any
 * hold is claimed; an inherited or non-enumerable tier is still read). Non-finite or negative values are dropped.
 */
export function materializeMaxima(raw: unknown): { [K in UsageTier]?: number } | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const out: { [K in UsageTier]?: number } = {};
	for (const tier of USAGE_TIERS) {
		const value = (raw as Record<string, unknown>)[tier];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[tier] = value;
	}
	return out;
}

/**
 * The finite figure a refusal records for a value that states no usable count: `Number.MAX_VALUE` for a positive
 * Infinity (the most absurd figure, not representable), 0 for anything else (NaN, a negative, a string, an object),
 * as the plugin's `providerFigure` records it. One rule for a provider's field and a caller's refused tier.
 */
function refusedStandIn(raw: unknown): number {
	return raw === Number.POSITIVE_INFINITY ? Number.MAX_VALUE : 0;
}

/**
 * A caller's REFUSED tiers as a PLAIN object, each tier read exactly once by name, as in {@link materializeMaxima}.
 * Unlike a maximum, a refusal is never dropped for its value: presence is the flag. `undefined` and `null` are absent; a
 * finite number >= 0 is kept as stated; any other value is kept at its {@link refusedStandIn}, so every figure out is a
 * finite number >= 0.
 */
export function materializeRefused(raw: unknown): { [K in UsageTier]?: number } | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const out: { [K in UsageTier]?: number } = {};
	for (const tier of USAGE_TIERS) {
		const value = (raw as Record<string, unknown>)[tier];
		if (value === undefined || value === null) continue;
		out[tier] =
			typeof value === "number" && Number.isFinite(value) && value >= 0
				? value
				: refusedStandIn(value);
	}
	return out;
}

/** The tiers a plausibility check can name. */
export type UsageTier =
	| "inputTokens"
	| "outputTokens"
	| "cacheReadTokens"
	| "cacheWriteTokens"
	| "cacheWrite1hTokens";

export interface NormalizedUsage {
	/** Fresh (non-cached) prompt tokens. */
	inputTokens: number;
	/** Completion tokens, including any provider-billed thinking tokens. */
	outputTokens: number;
	/** Cache-hit prompt tokens (read from an existing cache entry). */
	cacheReadTokens: number;
	/** Cache-creation prompt tokens (written into a cache entry). */
	cacheWriteTokens: number;
	/**
	 * The 1-HOUR share of `cacheWriteTokens` (Anthropic's `ephemeral_1h` TTL), a SUBSET
	 * of it, never added to it: `0 <= cacheWrite1hTokens <= cacheWriteTokens`, held by
	 * `sanitizeUsage`. Absent means 0. Only the Anthropic extractor reports it; every
	 * other provider's cache writes are priced at the single write rate.
	 */
	cacheWrite1hTokens?: number | undefined;
	/**
	 * Provenance (D5). `"provider"` means the provider reported BOTH input and
	 * output; absent cache fields then legitimately mean zero. `"estimated"`
	 * means at least one of input/output was missing or unusable, so the caller
	 * must substitute its estimate and MUST NOT publish a `usage` record — a
	 * half-provider snapshot labelled "provider" is a mislabel, not a saving.
	 *
	 * Held by construction: `sanitizeUsage` downgrades a `"provider"` label to
	 * `"estimated"` whenever the input or output it was handed is not a usable
	 * count, so no snapshot leaving this module can carry a fabricated zero
	 * under a provider label — whichever entry point produced it.
	 */
	source: "provider" | "estimated";
	/**
	 * Present ONLY when a reported count exceeded {@link MAX_PLAUSIBLE_TOKENS_PER_TIER}: the offending tiers and the raw
	 * figures. The snapshot is then `"estimated"` with zero counts (the call is charged at the estimate, exactly as for a
	 * missing count) and the caller records a `usage_implausible` event instead of charging the figure.
	 */
	implausible?: Partial<Record<UsageTier, number>>;
	/** Which check put each tier in `implausible`: the aggregate sum (absent) or one response's maximum. */
	implausibleBy?: Partial<Record<UsageTier, "sum" | "maximum" | "refused">>;
}

/** Loose input to {@link sanitizeUsage}: any field may be missing or junk. */
export interface RawUsageCandidate {
	inputTokens?: unknown;
	outputTokens?: unknown;
	cacheReadTokens?: unknown;
	cacheWriteTokens?: unknown;
	cacheWrite1hTokens?: unknown;
	source?: "provider" | "estimated";
}

/**
 * Read one provider-reported count.
 *
 * Returns `null` when the value is not a usable count — absent, non-numeric,
 * NaN, Infinity or negative. `null` is distinct from `0`: an explicit 0 IS
 * data (a provider that used no cache reports zero), while `null` means the
 * provider told us nothing and the caller must fall back.
 *
 * A fractional count rounds UP. Providers report integers, so this only fires
 * on garbage or on a proxy that averaged something; rounding down would
 * understate the bill, and understatement is the direction that silently
 * drains budgets slower than the invoice.
 */
function readCount(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	// `-0 < 0` is false and `Math.ceil(-0) === -0`, so a provider-reported `-0`
	// would otherwise survive into the snapshot, breaching "finite ints >= 0"
	// in the `Object.is` sense (D5). `+ 0` normalizes `-0` to `+0` without
	// affecting any other value.
	return Math.ceil(value) + 0;
}

/** Read a nested object field, or `undefined` when it is not an object. */
function readObject(
	source: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = source[key];
	if (value == null || typeof value !== "object") return undefined;
	return value as Record<string, unknown>;
}

/** Narrow an unknown provider payload to a readable record (never throws). */
function asRecord(value: unknown): Record<string, unknown> {
	if (value == null || typeof value !== "object") return {};
	return value as Record<string, unknown>;
}

/**
 * Hold ONE component of a tier to the single-response ceiling BEFORE an extractor sums it with another. Summed first,
 * two finite components can pass the safe-integer range, or reach Infinity (which `readCount` then reads as a missing
 * count), before `sanitizeUsage` sees the total; and an absurd component would be reported only inside a sum. A
 * component above {@link MAX_PLAUSIBLE_TOKENS_PER_TIER} is recorded in `refused` under its tier, by its own figure, and
 * enters the sum as 0; `sanitizeUsage({ refused })` then flags the tier as for any refused figure. Components that
 * pass are each at most the ceiling, so the extractors' sums of two or three of them stay safe integers.
 *
 * It takes the RAW value, because `readCount` reads every invalid value as "the provider told us nothing". Only a
 * MISSING field (`undefined`, or JSON `null`) is absent. A field that is PRESENT but not a finite count >= 0 (an
 * infinity, NaN, a negative, a string, a boolean, an object) is refused under its tier and enters the sum as 0: read as
 * absent it would drop out of a sum or zero a tier under a "provider" label, an undercharge. The figure recorded in
 * `refused` is always a finite number >= 0, for the audit record: a positive Infinity (JSON.parse reads a literal like
 * `1e400` as one) is recorded as `Number.MAX_VALUE`, its raw figure not being representable; any other invalid value
 * is recorded as 0, as the plugin's `providerFigure` records it, since it states no figure at all.
 */
function component(
	raw: unknown,
	tiers: UsageTier | UsageTier[],
	refused: Partial<Record<UsageTier, number>>,
): number | null {
	if (raw === undefined || raw === null) return null;
	const value = readCount(raw);
	if (value !== null && value <= MAX_PLAUSIBLE_TOKENS_PER_TIER) return value;
	const figure = value ?? refusedStandIn(raw);
	for (const tier of Array.isArray(tiers) ? tiers : [tiers]) {
		refused[tier] = Math.max(refused[tier] ?? 0, figure);
	}
	return 0;
}

/** Subtract inclusive cache tiers out of an inclusive prompt count (clamp >= 0). */
function disjointInput(promptTokens: number, cacheReadTokens: number, cacheWriteTokens: number) {
	return Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
}

/**
 * The per-tier ceiling for counts that AGGREGATE `responses` provider responses (default 1). The ceiling's premise holds
 * per provider response, so a caller that sums a window of responses (the plugin's transcript settle) says how many it
 * summed, and the bound scales with it; a malformed value is one response.
 */
export function usageCeiling(responses: number | undefined): number {
	const n =
		typeof responses === "number" && Number.isSafeInteger(responses) && responses > 1
			? Math.min(responses, MAX_AGGREGATED_RESPONSES)
			: 1;
	return MAX_PLAUSIBLE_TOKENS_PER_TIER * n;
}

/** The most responses one settle may claim to aggregate: keeps the scaled ceiling a safe integer. */
export const MAX_AGGREGATED_RESPONSES = 1_000_000;

/** True when the 1-hour share is the only over-ceiling reading. */
function only1h(found: Partial<Record<UsageTier, number>>): boolean {
	const tiers = Object.keys(found);
	return tiers.length === 1 && tiers[0] === "cacheWrite1hTokens";
}

/** Which check put each tier in an implausible record; a tier with no entry was the aggregate "sum". */
export type ImplausibleChecks = NonNullable<NormalizedUsage["implausibleBy"]>;

/**
 * An implausible record with `found` merged in: the larger figure per tier and, per tier, the label of the FIRST check
 * that fired, as `sanitizeUsage` labels it (a tier first seen unlabelled stays a "sum"). Every stream accumulator and
 * the stream settle merge through this, so a refused figure is never relabelled a sum on its way to the record.
 */
export function mergeImplausible(
	implausible: Partial<Record<UsageTier, number>> | undefined,
	implausibleBy: ImplausibleChecks | undefined,
	found: Partial<Record<UsageTier, number>> | undefined,
	foundBy: ImplausibleChecks | undefined,
): {
	implausible: Partial<Record<UsageTier, number>> | undefined;
	implausibleBy: ImplausibleChecks | undefined;
} {
	if (found === undefined) return { implausible, implausibleBy };
	const merged: Partial<Record<UsageTier, number>> = { ...implausible };
	let mergedBy = implausibleBy;
	for (const [tier, value] of Object.entries(found) as Array<[UsageTier, number]>) {
		const by = foundBy?.[tier];
		if (merged[tier] === undefined && by !== undefined) mergedBy = { ...mergedBy, [tier]: by };
		merged[tier] = Math.max(merged[tier] ?? 0, value);
	}
	return { implausible: merged, implausibleBy: mergedBy };
}

/**
 * The snapshot with `extra` implausible readings merged in (the larger figure per tier), with `extraBy` saying which
 * check fired for each: a stream that saw an absurd count in ANY chunk settles at the estimate, even when an earlier
 * chunk reported plausible usage.
 */
export function withImplausible(
	snapshot: NormalizedUsage,
	extra: Partial<Record<UsageTier, number>> | undefined,
	extraBy?: ImplausibleChecks | undefined,
): NormalizedUsage {
	if (extra === undefined || Object.keys(extra).length === 0) return snapshot;
	const { implausible, implausibleBy } = mergeImplausible(
		snapshot.implausible,
		snapshot.implausibleBy,
		extra,
		extraBy,
	);
	const merged = implausible ?? {};
	const by = implausibleBy !== undefined ? { implausibleBy } : {};
	// An absurd 1-hour share ALONE does not condemn the counts: whether it matters depends on the model, and that is
	// `withSupported1hTier`'s decision. The counts are kept until then.
	if (only1h(merged)) return { ...snapshot, implausible: merged, ...by };
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		source: "estimated",
		implausible: merged,
		...by,
	};
}

/**
 * The single sanitizer. Every extractor ends here, and any boundary that
 * assembles a snapshot from already-disjoint counters (the pi-ai pass-through
 * rows, headless caller-supplied usage) should route through it too rather
 * than clamping by hand.
 *
 * Non-finite, negative and non-numeric values collapse to 0; fractional counts
 * round up; an absent `source` defaults to the conservative `"estimated"`.
 *
 * **The D5 provenance rule is enforced HERE, not only in the extractors.** A
 * caller may label a snapshot `"provider"`, but the label survives only if
 * BOTH `inputTokens` and `outputTokens` are usable counts (an explicit `0`
 * qualifies — a provider that used no cache reports zero, and that is data).
 * When either is absent or garbage, the clamped `0` is *fabricated*, so the
 * label is downgraded to `"estimated"` and the caller must not publish a
 * `usage` record. Without this guard a boundary that derives `source` from a
 * `typeof value === "number"` check on a NaN counter would publish a
 * provider-labelled zero-input call — the exact mislabel D5 kills, and one
 * that understates money by pricing fresh input at the 1-usertoken floor.
 * Absent CACHE fields never downgrade: D5 says they legitimately default to 0.
 *
 * A finite count above {@link MAX_PLAUSIBLE_TOKENS_PER_TIER} is NOT priced: the
 * snapshot comes back `"estimated"` with zero counts and an `implausible` record, so
 * the caller charges the estimate and reports the anomaly. (An earlier version let
 * it through on the reasoning that overstating is fail-safe for money; it is not
 * fail-safe for availability, because the inflated cost reached the persisted
 * session counter.)
 */
export function sanitizeUsage(
	raw: RawUsageCandidate | null | undefined,
	opts: {
		responses?: number | undefined;
		/** The largest single-response count per tier in an aggregate; checked against the BASE ceiling. */
		maxima?: { [K in UsageTier]?: number | undefined } | undefined;
		/**
		 * Tiers the CALLER refused (a figure that was invalid or above its own per-response ceiling): presence is the flag,
		 * the value is the raw figure when representable. They never entered the counts, which are arithmetic-safe. A
		 * present value that is not a finite number >= 0 still flags its tier, recorded as `Number.MAX_VALUE`; `undefined`
		 * and `null` are absent, as a missing provider field is.
		 */
		refused?: { [K in UsageTier]?: number | undefined } | undefined;
	} = {},
): NormalizedUsage {
	const r = raw ?? {};
	const input = readCount(r.inputTokens);
	const output = readCount(r.outputTokens);
	const reported = input != null && output != null;
	// Each raw count is read EXACTLY ONCE and reused: a getter that answers differently on a second read must not
	// pass the plausibility check on one value and be priced on another.
	const cacheRead = readCount(r.cacheReadTokens) ?? 0;
	const cacheWrite = readCount(r.cacheWriteTokens) ?? 0;
	// The RAW 1-hour share is checked, not the clamped one: a share above the write total is garbage the clamp would
	// otherwise hide, and an absurd one must be reported like any other tier.
	const rawCacheWrite1h = readCount(r.cacheWrite1hTokens) ?? 0;
	const cacheWrite1h = Math.min(rawCacheWrite1h, cacheWrite);
	const ceiling = usageCeiling(opts.responses);
	// A finite figure above the plausibility ceiling is not usage: it is charged as an ESTIMATE and reported (see
	// MAX_PLAUSIBLE_TOKENS_PER_TIER). The raw figures are kept for the chain event, never for pricing.
	const readings: Array<[UsageTier, number]> = [
		["inputTokens", input ?? 0],
		["outputTokens", output ?? 0],
		["cacheReadTokens", cacheRead],
		["cacheWriteTokens", cacheWrite],
		["cacheWrite1hTokens", rawCacheWrite1h],
	];
	const implausible: Partial<Record<UsageTier, number>> = {};
	for (const [tier, value] of readings) {
		if (value > ceiling) implausible[tier] = value;
	}
	// An aggregate's SUM may sit under n x ceiling while one response inside it is absurd: the caller's per-tier maxima
	// are held to the unscaled ceiling. A caller that sends none keeps the aggregate check alone.
	const implausibleBy: Partial<Record<UsageTier, "sum" | "maximum" | "refused">> = {};
	for (const tier of USAGE_TIERS) {
		const value = opts.maxima?.[tier];
		if (value !== undefined && Number.isFinite(value) && value > MAX_PLAUSIBLE_TOKENS_PER_TIER) {
			if (implausible[tier] === undefined) implausibleBy[tier] = "maximum";
			implausible[tier] = Math.max(implausible[tier] ?? 0, value);
		}
	}
	// Presence is the flag: a refused Infinity (or any figure that is not representable) is still a refusal, recorded at
	// the finite stand-in so the chain event can be written. `undefined` and `null` are not a flag.
	for (const tier of USAGE_TIERS) {
		const value = opts.refused?.[tier];
		if (value != null) {
			const figure =
				typeof value === "number" && Number.isFinite(value) && value >= 0
					? Math.max(1, value)
					: Number.MAX_VALUE;
			if (implausible[tier] === undefined) implausibleBy[tier] = "refused";
			implausible[tier] = Math.max(implausible[tier] ?? 0, figure);
		}
	}
	// The 1-hour share alone leaves the counts standing until `withSupported1hTier` decides whether the model has the
	// tier at all (a model without one ignores the share). Any other tier condemns the counts here.
	if (Object.keys(implausible).length > 0 && !only1h(implausible)) {
		return {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			source: "estimated",
			implausible,
			implausibleBy,
		};
	}
	return {
		inputTokens: input ?? 0,
		outputTokens: output ?? 0,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		// A SUBSET of the write total: a 1-hour count above it is garbage and clamps, so
		// the two can never be summed into a larger bill than the provider reported. The
		// key is ABSENT when 0, so a snapshot with no 1-hour writes is the shape it
		// always was.
		...(cacheWrite1h > 0 ? { cacheWrite1hTokens: cacheWrite1h } : {}),
		source: r.source === "provider" && reported ? "provider" : "estimated",
		...(Object.keys(implausible).length > 0 ? { implausible, implausibleBy } : {}),
	};
}

/**
 * The `data` of the `usage_implausible` chain event for a snapshot that carries an `implausible` record: the raw figures
 * that were refused (never priced), the ceiling, and what was charged instead. One builder for every settle site.
 */
export function implausibleUsageData(
	snapshot: NormalizedUsage,
	fields: { model: string; transferId: string; responses?: number | undefined },
): Record<string, unknown> | undefined {
	if (snapshot.implausible === undefined) return undefined;
	const byMaximum = Object.values(snapshot.implausibleBy ?? {}).includes("maximum");
	return {
		// Which check fired for each tier: the aggregate "sum" (scaled ceiling) or one response's "maximum" (unscaled).
		checks: Object.fromEntries(
			Object.keys(snapshot.implausible).map((t) => [
				t,
				snapshot.implausibleBy?.[t as UsageTier] ?? "sum",
			]),
		),
		...(byMaximum ? { maximumCeilingTokensPerResponse: MAX_PLAUSIBLE_TOKENS_PER_TIER } : {}),
		model: fields.model,
		transferId: fields.transferId,
		tiers: { ...snapshot.implausible },
		ceilingTokensPerTier: usageCeiling(fields.responses),
		charged: "estimate",
	};
}

/**
 * The four tiers of a snapshot, but ONLY when they are publishable (D5).
 *
 * Returns `undefined` for an estimated snapshot, and that is the whole point:
 * `receipt.usage` and `llm_call.data.usage` are present IFF the settle was
 * provider-sourced. An estimated settle's cost comes from the pre-call
 * estimate, not from counts, so publishing a four-tier block of fabricated
 * zeros beside it would invite an auditor to "recompute" a number that was
 * never derived from tokens — and to conclude the call cost 1 usertoken.
 *
 * The rule lives HERE, in one function, rather than as an `if` repeated at
 * each of the four emission sites (headless settle, govern non-stream, govern
 * stream terminal, the estimate-priced stream handle). Four copies of a
 * provenance rule is three chances to publish a fabrication.
 *
 * The returned object is a fresh copy, so a caller cannot hand the same
 * mutable snapshot to both the chain and the receipt and have a later mutation
 * rewrite an already-emitted record. `source` is deliberately dropped: it is
 * published once, as `usageSource`, not twice under two names.
 */
export function publishableUsage(snapshot: NormalizedUsage): ReceiptUsage | undefined {
	if (snapshot.source !== "provider") return undefined;
	return {
		inputTokens: snapshot.inputTokens,
		outputTokens: snapshot.outputTokens,
		cacheReadTokens: snapshot.cacheReadTokens,
		cacheWriteTokens: snapshot.cacheWriteTokens,
	};
}

/**
 * The snapshot with its 1-hour share DROPPED when these rates have no 1-hour tier
 * (`supportsCacheWrite1h`). The write TOTAL stays: it prices at the single write rate.
 * Applied to every snapshot a governor meters from, before the cost and the records, so
 * a model with no 1-hour tier is never billed (or recorded) at an invented 2x input
 * because a caller reported a share for it.
 */
export function withSupported1hTier(
	snapshot: NormalizedUsage,
	rates: ModelRates,
	operatorOwned: boolean,
): NormalizedUsage {
	const supported = supportsCacheWrite1h(rates, operatorOwned);
	const found = snapshot.implausible;
	const has1h = found?.cacheWrite1hTokens !== undefined;
	if (!has1h) {
		if (snapshot.cacheWrite1hTokens === undefined || supported) return snapshot;
		const { cacheWrite1hTokens: _dropped, ...rest } = snapshot;
		return rest;
	}
	if (supported) {
		// The tier exists, so an absurd share is a real anomaly: the counts are not priced.
		if (only1h(found)) {
			return {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				source: "estimated",
				implausible: found,
				...(snapshot.implausibleBy !== undefined ? { implausibleBy: snapshot.implausibleBy } : {}),
			};
		}
		return snapshot;
	}
	// No such tier: the share is IGNORED, and so is its reading. Whatever else was implausible still stands; when the
	// 1-hour share was the only entry the counts were never condemned and price as reported.
	const { cacheWrite1hTokens: _share, ...rest } = snapshot;
	const { cacheWrite1hTokens: _reading, ...others } = found;
	if (Object.keys(others).length > 0) {
		const { cacheWrite1hTokens: _by1h, ...othersBy } = snapshot.implausibleBy ?? {};
		return { ...rest, implausible: others, implausibleBy: othersBy };
	}
	const { implausible: _gone, implausibleBy: _by, ...clean } = rest;
	return clean;
}

/**
 * The record fields a PUBLISHABLE snapshot adds to a chain event or receipt: the
 * four-tier `usage` block and, only when the call wrote 1-hour cache, the root
 * `cacheWrite1h` record. ONE function so the four emission sites cannot disagree
 * about either; both are absent for an estimated snapshot.
 */
export function publishableUsageFields(
	snapshot: NormalizedUsage,
	rates: ModelRates,
): { usage?: ReceiptUsage; cacheWrite1h?: CacheWrite1h } {
	const usage = publishableUsage(snapshot);
	if (usage === undefined) return {};
	// The 1-hour rate published is the one THIS call's prompt tier priced it at (a
	// `longPrompt` row), from the same counts the cost used.
	const cacheWrite1h = resolveCacheWrite1h(
		promptTierRates(
			rates,
			promptTokenCount(snapshot.inputTokens, snapshot.cacheReadTokens, snapshot.cacheWriteTokens),
		),
		snapshot.cacheWrite1hTokens ?? 0,
		snapshot.cacheWriteTokens,
	);
	return cacheWrite1h === undefined ? { usage } : { usage, cacheWrite1h };
}

/**
 * D2 row — **Anthropic SDK, core direct: pass through.**
 *
 * `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`
 * are disjoint in the SDK (messages.ts:1139), so nothing is subtracted here.
 *
 * `cache_creation` carries the per-TTL breakdown
 * (`ephemeral_5m_input_tokens` + `ephemeral_1h_input_tokens`). When it reports
 * both TTL counts it is the write total and wins over the flat
 * `cache_creation_input_tokens`; when it reports only one of them (a partial
 * breakdown) the total is the dearer of that partial sum and the flat field, so the
 * unaccounted remainder is not dropped. (The two agree in practice — the flat field is
 * the sum — so this is about surviving whichever one a given SDK version, proxy or
 * fixture omits, or reports only part of.) The 1-hour share rides along as
 * `cacheWrite1hTokens` and is priced at `cacheWrite1hPer1k`.
 */
export function fromAnthropicUsage(usage: unknown): NormalizedUsage {
	const u = asRecord(usage);

	// Every figure is read through `component`, so an absurd or invalid one (an infinite one included) is refused under
	// its tier, never priced and never read as absent. The write figures are summed (the two TTLs) and subtracted below,
	// which is why they are held to the ceiling before that. An absurd TTL share is an absurd write total too, so it is
	// refused as the write tier; an absurd 1-hour share is ALSO reported as the 1-hour tier, as the sum-then-check path
	// reported it.
	const refused: Partial<Record<UsageTier, number>> = {};
	const input = component(u.input_tokens, "inputTokens", refused);
	const output = component(u.output_tokens, "outputTokens", refused);
	const cacheRead = component(u.cache_read_input_tokens, "cacheReadTokens", refused);
	const breakdown = readObject(u, "cache_creation");
	const ephemeral5m = breakdown
		? component(breakdown.ephemeral_5m_input_tokens, "cacheWriteTokens", refused)
		: null;
	const ephemeral1h = breakdown
		? component(
				breakdown.ephemeral_1h_input_tokens,
				["cacheWriteTokens", "cacheWrite1hTokens"],
				refused,
			)
		: null;
	const nestedWrite =
		ephemeral5m == null && ephemeral1h == null ? null : (ephemeral5m ?? 0) + (ephemeral1h ?? 0);
	const flatWrite = component(u.cache_creation_input_tokens, "cacheWriteTokens", refused);
	// A COMPLETE breakdown (both TTL fields usable) is authoritative and wins over the flat
	// total. A PARTIAL one (a single TTL field) sums to less than the whole: the flat total
	// is the sum of the two TTLs, so what the partial sum leaves out is a real write whose
	// TTL the payload did not attribute. It is kept (never dropped) and, being unattributed,
	// priced at the DEARER 1-hour rate: understating a write is the dangerous direction.
	const complete = ephemeral5m != null && ephemeral1h != null;
	const unattributed =
		complete || nestedWrite == null ? 0 : Math.max(0, (flatWrite ?? 0) - nestedWrite);

	return sanitizeUsage(
		{
			inputTokens: input ?? 0,
			outputTokens: output ?? 0,
			cacheReadTokens: cacheRead ?? 0,
			cacheWriteTokens: complete ? (nestedWrite ?? 0) : Math.max(nestedWrite ?? 0, flatWrite ?? 0),
			// Only the per-TTL breakdown can say how much was 1-hour. A payload that carries
			// just the flat total (no breakdown at all) cannot be told apart from a genuine
			// 5-minute write and is priced at the 5-minute rate; the API reports the breakdown.
			cacheWrite1hTokens: (ephemeral1h ?? 0) + unattributed,
			source: input != null && output != null ? "provider" : "estimated",
		},
		{ refused },
	);
}

/**
 * D2 row — **OpenAI chat.completions, core direct: subtract.**
 *
 * `prompt_tokens` is INCLUSIVE of the cached read (`prompt_tokens_details.
 * cached_tokens`) and, where a vendor reports one, of the cache write
 * (`cache_write_tokens`). Fresh input is the remainder, clamped at 0 — a proxy
 * that reports `cached_tokens > prompt_tokens` must not produce a negative
 * count that would collapse the whole cost to the 1-usertoken floor.
 *
 * `completion_tokens` already includes reasoning tokens
 * (`completion_tokens_details.reasoning_tokens` is a breakdown, not an
 * addition), so nothing is added to output.
 *
 * THE TWO CACHE COUNTERS ARE DISJOINT, and subtracting both is correct even
 * when both are non-zero (Codex PR-85 P2-5, investigated and refuted).
 * OpenRouter's own examples put both inside `prompt_tokens` without overlap —
 * `prompt_tokens: 194 / cached_tokens: 0 / cache_write_tokens: 100 /
 * completion_tokens: 2 / total_tokens: 196`, and `prompt_tokens: 10339 /
 * cached_tokens: 10318 / cache_write_tokens: 0` — and both vendors define the
 * pair as tokens READ from vs WRITTEN to the cache in the same request. They
 * also map from Anthropic's `cache_read_input_tokens` /
 * `cache_creation_input_tokens`, whose disjointness the pass-through row above
 * already depends on. Do not add a "reads are inclusive of writes" correction
 * here: OpenRouter and native OpenAI gpt-5.6+ emit the SAME field names, so
 * such a rule cannot be scoped to one of them, and it would reprice every
 * cache-writing OpenAI call off a shape neither vendor documents.
 */
export function fromOpenAICompletionsUsage(usage: unknown): NormalizedUsage {
	const u = asRecord(usage);
	const promptDetails = readObject(u, "prompt_tokens_details");

	const prompt = readCount(u.prompt_tokens);
	const completion = readCount(u.completion_tokens);

	const cacheRead = (promptDetails ? readCount(promptDetails.cached_tokens) : null) ?? 0;
	const cacheWrite =
		readCount(u.cache_write_tokens) ??
		(promptDetails ? readCount(promptDetails.cache_write_tokens) : null) ??
		0;

	return sanitizeUsage({
		inputTokens: disjointInput(prompt ?? 0, cacheRead, cacheWrite),
		outputTokens: completion ?? 0,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		source: prompt != null && completion != null ? "provider" : "estimated",
	});
}

/**
 * D2 row — **OpenAI Responses API, core direct: subtract per details.**
 *
 * Same inclusivity as completions with a different field map: `input_tokens`
 * with the cache tiers nested under `input_tokens_details`. This must be used
 * by BOTH the non-stream path and the terminal stream path (streaming.ts:94) —
 * two paths, one extractor.
 *
 * `output_tokens` already includes `output_tokens_details.reasoning_tokens`;
 * adding it would double-bill thinking.
 */
export function fromOpenAIResponsesUsage(usage: unknown): NormalizedUsage {
	const u = asRecord(usage);
	const inputDetails = readObject(u, "input_tokens_details");

	const input = readCount(u.input_tokens);
	const output = readCount(u.output_tokens);

	const cacheRead = (inputDetails ? readCount(inputDetails.cached_tokens) : null) ?? 0;
	const cacheWrite = inputDetails
		? (readCount(inputDetails.cache_creation_tokens) ??
			readCount(inputDetails.cache_write_tokens) ??
			0)
		: 0;

	return sanitizeUsage({
		inputTokens: disjointInput(input ?? 0, cacheRead, cacheWrite),
		outputTokens: output ?? 0,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		source: input != null && output != null ? "provider" : "estimated",
	});
}

/**
 * D2 row — **Gemini, core direct: subtract, and thinking is output.**
 *
 * Takes the root `usageMetadata` object. `promptTokenCount` is INCLUSIVE of
 * `cachedContentTokenCount`, so fresh input is the difference (clamp >= 0).
 * `thoughtsTokenCount` is billed at the output rate and is NOT included in
 * `candidatesTokenCount`, so it is added.
 *
 * `toolUsePromptTokenCount` is billable INPUT and is NOT inside
 * `promptTokenCount`, so it is ADDED to fresh input rather than subtracted from
 * anything. `@google/genai` (1.52.0) is explicit on both halves of that:
 * `GenerateContentResponseUsageMetadata.totalTokenCount` is documented as "the
 * sum of `prompt_token_count`, `candidates_token_count`,
 * `tool_use_prompt_token_count`, and `thoughts_token_count`" — four separate
 * summands — and `toolUsePromptTokenCount` itself as "the number of tokens in
 * the results from tool executions, which are provided back to the model as
 * input". Ignoring it silently understates every tools-using Gemini call.
 *
 * It is added AFTER the cache clamp, not inside it: only `promptTokenCount` is
 * inclusive of `cachedContentTokenCount`, so an over-large cached count must
 * not be allowed to swallow tool-use input that was never part of the prompt.
 *
 * `cacheWriteTokens` is always 0: Gemini bills cache creation as ordinary
 * input (plus an hourly storage charge this per-token model does not carry —
 * a documented D6 approximation) and reports no write counter. Those tokens
 * ride inside `promptTokenCount` and price at `inputPer1k`, which is exactly
 * what the provider charges.
 *
 * A thinking-only response (thoughts but no candidates) still counts as
 * provider-reported output — that is real, billed output.
 */
export function fromGeminiUsage(metadata: unknown): NormalizedUsage {
	const m = asRecord(metadata);

	// Every component is held to the ceiling BEFORE it is summed (see `component`): input adds the tool-use prompt to
	// the fresh prompt, output adds thoughts to candidates. A refused component condemns the counts in sanitizeUsage.
	const refused: Partial<Record<UsageTier, number>> = {};
	const prompt = component(m.promptTokenCount, "inputTokens", refused);
	const candidates = component(m.candidatesTokenCount, "outputTokens", refused);
	const thoughts = component(m.thoughtsTokenCount, "outputTokens", refused);
	const cacheRead = component(m.cachedContentTokenCount, "cacheReadTokens", refused) ?? 0;
	const toolUsePrompt = component(m.toolUsePromptTokenCount, "inputTokens", refused) ?? 0;

	return sanitizeUsage(
		{
			inputTokens: disjointInput(prompt ?? 0, cacheRead, 0) + toolUsePrompt,
			outputTokens: (candidates ?? 0) + (thoughts ?? 0),
			cacheReadTokens: cacheRead,
			cacheWriteTokens: 0,
			source: prompt != null && (candidates != null || thoughts != null) ? "provider" : "estimated",
		},
		{ refused },
	);
}

/**
 * Which D2 row a payload belongs to. This is the SOURCE identity, not the
 * provider name: "openai" is two rows (completions vs Responses) with different
 * field maps, and the pi-ai adapters are a third family that never reaches this
 * module at all (they are already disjoint — see the header).
 */
export type UsageWireShape = "anthropic" | "openai-completions" | "openai-responses" | "gemini";

/**
 * Pick the D2 row from the field names actually present, falling back to the
 * caller's hint.
 *
 * Shape wins over the hint because the hint is derived from the CLIENT
 * (`detectClientKind` + the intercepted surface), and an OpenAI-compatible
 * server behind an OpenAI client is free to answer in a different dialect. The
 * dispatch is unambiguous exactly where it matters: the two "pass through" vs
 * "subtract" families use disjoint cache field names
 * (`cache_read_input_tokens` vs `input_tokens_details.cached_tokens`), so a
 * payload that could be read either way carries no cache tokens and both
 * readings agree.
 */
function detectWireShape(container: Record<string, unknown>, hint: UsageWireShape): UsageWireShape {
	if (
		"promptTokenCount" in container ||
		"candidatesTokenCount" in container ||
		"cachedContentTokenCount" in container ||
		"thoughtsTokenCount" in container
	) {
		return "gemini";
	}
	if (
		"prompt_tokens" in container ||
		"completion_tokens" in container ||
		"prompt_tokens_details" in container
	) {
		return "openai-completions";
	}
	if ("input_tokens_details" in container || "output_tokens_details" in container) {
		return "openai-responses";
	}
	if (
		"cache_read_input_tokens" in container ||
		"cache_creation_input_tokens" in container ||
		"cache_creation" in container
	) {
		return "anthropic";
	}
	// A bare `input_tokens`/`output_tokens` pair with no cache detail anywhere.
	// Anthropic and the Responses API share these names, and with no cache fields
	// present the pass-through and subtracting readings produce identical numbers,
	// so either row is correct — pick by hint. The `openai-completions` hint lands
	// here too: core's old `??` chain read `input_tokens` before `prompt_tokens`,
	// and some OpenAI-compatible servers do answer chat.completions in those
	// names. Falling through to the completions extractor (which looks only for
	// `prompt_tokens`) would read nothing and demote a real settle to an estimate.
	if ("input_tokens" in container || "output_tokens" in container) {
		return hint === "anthropic" ? "anthropic" : "openai-responses";
	}
	return hint;
}

/**
 * D4 row 3 — read a NON-STREAM provider response into the one snapshot.
 *
 * Finds the usage container, picks the D2 row, and delegates. Two containers
 * exist in the wild and core previously read only the first:
 *
 *   - `response.usage` — Anthropic, OpenAI completions, OpenAI Responses.
 *   - `response.usageMetadata` — Google. It sits at the ROOT of a
 *     `GenerateContentResponse` (genai.d.ts:4658), so the old
 *     `"usage" in response` test was FALSE for every real Gemini call and every
 *     one of them silently settled at the estimate.
 *
 * When neither container is a usable object the result is an all-zero snapshot
 * with `source: "estimated"` — the caller must then fall back to its estimate
 * and must NOT publish a usage record (D5).
 */
export function fromProviderResponse(response: unknown, hint: UsageWireShape): NormalizedUsage {
	const r = asRecord(response);
	const usage = readObject(r, "usage");
	const metadata = readObject(r, "usageMetadata");
	// Prefer the container the hint expects; fall back to the other one so a
	// misdetected client still meters off real numbers.
	const container = hint === "gemini" ? (metadata ?? usage) : (usage ?? metadata);
	if (container === undefined) return sanitizeUsage(null);

	switch (detectWireShape(container, hint)) {
		case "gemini":
			return fromGeminiUsage(container);
		case "openai-completions":
			return fromOpenAICompletionsUsage(container);
		case "openai-responses":
			return fromOpenAIResponsesUsage(container);
		default:
			return fromAnthropicUsage(container);
	}
}
