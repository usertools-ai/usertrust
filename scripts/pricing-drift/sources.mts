/**
 * sources.mts — fetch and normalize the upstream rate sources.
 *
 * Both sources are MIT-licensed (verified 2026-08-17), so their numbers may be
 * ingested and republished with attribution. OpenRouter is deliberately absent:
 * its access posture is public, but that is a fact about ACCESS, not about
 * redistribution rights, and this tool must not print numbers it has no
 * established right to republish. Adding it is a clean follow-up once someone
 * reads their ToS (spec §3).
 *
 * The normalize* functions are PURE — they take already-fetched JSON and the
 * model map. All I/O lives in `fetchSources`. That split is what lets the
 * vendor-pin rule (the load-bearing one) be driven from fixtures with no
 * network in the loop.
 */

import type { ModelSourceMap } from "./model-map.mts";

/** One model's rates in the table's own unit: usertokens per 1,000 tokens. */
export interface SourceRates {
	inputPer1k: number;
	outputPer1k: number;
	/** Absent means the source publishes no rate for this tier — never 0. */
	cacheReadPer1k?: number | undefined;
	cacheWritePer1k?: number | undefined;
}

/** Raised when a source is unreachable or its schema no longer matches. */
export class SourceError extends Error {}

export const LITELLM_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * THE ONE CONVERSION. 1 usertoken = $0.0001 (packages/core/src/ledger/pricing.ts),
 * so $X per MTok = ($X / 1000) per 1k tokens = ($X / 1000) / $0.0001 usertokens
 * = X * 10.
 *
 * Its test asserts against a REAL PRICING_TABLE entry, never a literal, and
 * that is the whole point. An identity conversion (`return perMTok`) sitting
 * under a comment that states the wrong denomination is off by 10x while
 * looking entirely correct, and a test written as
 * `assert.equal(convert(5), 5)` passes against it and locks the error in.
 * A unit conversion whose only specification is a comment is not specified.
 */
export function usertokensPer1kFromUsdPerMTok(usdPerMTok: number): number {
	// A FINITE input can overflow to Infinity (1e308 * 10). The row would stay
	// non-null and satisfy mapping coverage, while `resolveTier` filters the
	// non-finite value back out — leaving a one-source model classified `agree`
	// without either required tier having been compared. Absence created by
	// arithmetic is still absence read as agreement.
	if (!Number.isFinite(usdPerMTok)) {
		throw new SourceError(`non-finite rate before conversion: ${usdPerMTok}`);
	}
	const converted = Math.round(usdPerMTok * 10 * 1e6) / 1e6;
	if (!Number.isFinite(converted)) {
		throw new SourceError(`rate overflowed unit conversion: ${usdPerMTok} $/MTok`);
	}
	return converted;
}

/** LiteLLM publishes per-TOKEN USD; convert to per-MTok, then to usertokens. */
function usertokensPer1kFromUsdPerToken(usdPerToken: number): number {
	return usertokensPer1kFromUsdPerMTok(usdPerToken * 1e6);
}

/** A finite, non-negative number, or undefined for any other shape. */
function optionalRate(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * The LiteLLM fields this tool depends on, checked AGAINST THE FETCHED DATA by
 * `assertLiteLLMSchema` — not merely listed.
 *
 * Listing them and asserting the list in a unit test proves nothing: it
 * compares a constant to itself. The failure that matters is a rename of an
 * OPTIONAL field — `cache_creation_input_token_cost` moves, every cache value
 * silently becomes `undefined`, input/output still resolve so every row still
 * counts as answered, coverage stays full, and the run exits 0 with cache
 * comparison quietly disabled. Only a check against real data catches that.
 */
export const LITELLM_FIELDS = [
	"litellm_provider",
	"input_cost_per_token",
	"output_cost_per_token",
	"cache_read_input_token_cost",
	"cache_creation_input_token_cost",
] as const;

/** The models.dev fields this tool depends on, same reasoning. */
export const MODELS_DEV_FIELDS = ["input", "output", "cache_read", "cache_write"] as const;

/**
 * WHICH MAPPED MODELS CARRY WHICH OPTIONAL CACHE TIER, per source.
 *
 * Aggregate counts are not enough, and this is the third narrowing of the same
 * check. A single shared floor is cleared by unaffected rows. Per-field totals
 * are still only a LOWER BOUND, so an upstream ADDITION creates headroom: once
 * one row gains `cache_write`, a later loss on a different row keeps the total
 * at or above the baseline and passes. That row still answers from input and
 * output, so mapping coverage stays full and the comparison silently skips the
 * missing tier.
 *
 * Only a per-(source, model, tier) expectation closes it: a specific model
 * losing a specific tier is then a specific, named failure. Measured against
 * the live feeds on 2026-08-18.
 *
 * Adding a tier upstream is fine and is not enforced here. Losing one listed
 * below fails the run, and removing an entry is a deliberate, reviewable edit.
 */
export const EXPECTED_TIERS: ReadonlySet<string> = new Set([
	"litellm:claude-fable-5:cacheRead",
	"litellm:claude-fable-5:cacheWrite",
	"litellm:claude-haiku-4-5:cacheRead",
	"litellm:claude-haiku-4-5:cacheWrite",
	"litellm:claude-opus-4-6:cacheRead",
	"litellm:claude-opus-4-6:cacheWrite",
	"litellm:claude-opus-4-8:cacheRead",
	"litellm:claude-opus-4-8:cacheWrite",
	"litellm:claude-opus-5:cacheRead",
	"litellm:claude-opus-5:cacheWrite",
	"litellm:claude-sonnet-4-6:cacheRead",
	"litellm:claude-sonnet-4-6:cacheWrite",
	"litellm:claude-sonnet-5:cacheRead",
	"litellm:claude-sonnet-5:cacheWrite",
	"litellm:deepseek-chat:cacheRead",
	"litellm:deepseek-reasoner:cacheRead",
	"litellm:gemini-2.5-flash:cacheRead",
	"litellm:gemini-2.5-pro:cacheRead",
	"litellm:gpt-4o-mini:cacheRead",
	"litellm:gpt-4o:cacheRead",
	"litellm:gpt-5.4:cacheRead",
	"litellm:gpt-5.6-sol:cacheRead",
	"litellm:gpt-5.6-sol:cacheWrite",
	"litellm:o3:cacheRead",
	"litellm:o4-mini:cacheRead",
	"models.dev:claude-fable-5:cacheRead",
	"models.dev:claude-fable-5:cacheWrite",
	"models.dev:claude-haiku-4-5:cacheRead",
	"models.dev:claude-haiku-4-5:cacheWrite",
	"models.dev:claude-opus-4-6:cacheRead",
	"models.dev:claude-opus-4-6:cacheWrite",
	"models.dev:claude-opus-4-8:cacheRead",
	"models.dev:claude-opus-4-8:cacheWrite",
	"models.dev:claude-opus-5:cacheRead",
	"models.dev:claude-opus-5:cacheWrite",
	"models.dev:claude-sonnet-4-6:cacheRead",
	"models.dev:claude-sonnet-4-6:cacheWrite",
	"models.dev:claude-sonnet-5:cacheRead",
	"models.dev:claude-sonnet-5:cacheWrite",
	"models.dev:deepseek-chat:cacheRead",
	"models.dev:deepseek-reasoner:cacheRead",
	"models.dev:gemini-2.5-flash:cacheRead",
	"models.dev:gemini-2.5-pro:cacheRead",
	"models.dev:gpt-4o-mini:cacheRead",
	"models.dev:gpt-4o:cacheRead",
	"models.dev:gpt-5.4:cacheRead",
	"models.dev:gpt-5.6-sol:cacheRead",
	"models.dev:gpt-5.6-sol:cacheWrite",
	"models.dev:kimi-k3:cacheRead",
	"models.dev:o3:cacheRead",
	"models.dev:o4-mini:cacheRead",
]);

/** Required fields, which every mapped row must carry to be usable at all. */
const REQUIRED_LITELLM_FIELDS = [
	"litellm_provider",
	"input_cost_per_token",
	"output_cost_per_token",
] as const;
const REQUIRED_MODELS_DEV_FIELDS = ["input", "output"] as const;

/**
 * Is this field carrying a value the normalizer could actually use?
 *
 * `litellm_provider` is an attribution string; every other tracked field is a
 * price and must be a finite non-negative number. Presence of a NAME is not
 * presence of a RATE — an upstream keeping a deprecated key holding `null`
 * would clear any check written with `in`.
 */
function isUsable(field: string, value: unknown): boolean {
	if (field === "litellm_provider") return typeof value === "string" && value.length > 0;
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function raiseSchemaError(source: string, problems: string[]): void {
	if (problems.length === 0) return;
	throw new SourceError(
		`${source}: schema/coverage regression — ${problems.join("; ")}. ` +
			"Refusing to report a comparison that silently skipped these rates. If upstream " +
			"legitimately dropped them, update the expectations in sources.mts deliberately.",
	);
}

/**
 * Verify LiteLLM still publishes, for every MAPPED VENDOR ROW, the fields this
 * tool reads. Throws SourceError (exit 2 — "could not check") rather than
 * letting a rename degrade into a clean-looking run.
 *
 * Called at INGEST (see run.mts), not from `normalizeLiteLLM`: the normalizers
 * are pure transforms driven from small fixtures, which by construction cannot
 * satisfy an expectation measured against the live feed.
 */
export function assertLiteLLMSchema(
	raw: unknown,
	map: Record<string, ModelSourceMap>,
	expectedTiers: ReadonlySet<string> = EXPECTED_TIERS,
): void {
	if (typeof raw !== "object" || raw === null) {
		throw new SourceError("LiteLLM: response is not an object");
	}
	const table = raw as Record<string, unknown>;
	const problems: string[] = [];
	let expected = 0;
	let found = 0;

	for (const [model, entry] of Object.entries(map)) {
		if (entry.litellm === null) continue;
		expected++;
		const row = table[entry.litellm.key];
		// An ABSENT row is not a schema change — the model may simply have left
		// the feed, which coverage reports as a named missing mapping (exit 1).
		if (typeof row !== "object" || row === null) continue;
		found++;
		const r = row as Record<string, unknown>;
		// A row that exists but has LOST `litellm_provider` is a different thing:
		// the field this tool pins on is gone, so every mapped row would silently
		// fail the vendor check and normalize away. That is a schema failure
		// (exit 2), and skipping it here would misreport it as ordinary drift.
		if (!("litellm_provider" in r)) {
			problems.push(`${model} row is missing litellm_provider entirely`);
			continue;
		}
		// A row belonging to a DIFFERENT vendor is expected and fine.
		if (r.litellm_provider !== entry.litellm.provider) continue;

		for (const f of REQUIRED_LITELLM_FIELDS) {
			if (!isUsable(f, r[f])) problems.push(`${model} lost required ${f}`);
		}
		if (
			expectedTiers.has(`litellm:${model}:cacheRead`) &&
			!isUsable("cache_read_input_token_cost", r.cache_read_input_token_cost)
		) {
			problems.push(`${model} lost cache_read_input_token_cost`);
		}
		if (
			expectedTiers.has(`litellm:${model}:cacheWrite`) &&
			!isUsable("cache_creation_input_token_cost", r.cache_creation_input_token_cost)
		) {
			problems.push(`${model} lost cache_creation_input_token_cost`);
		}
	}
	// ONE absent row is a model leaving the feed (coverage names it, exit 1).
	// EVERY absent row is the table's SHAPE having changed — `{}`, or a new
	// wrapper around the rows — and the per-row loop then finds nothing to
	// complain about, so `problems` stays empty and the sentinel passes. Total
	// absence must not be the quietest outcome.
	if (expected > 0 && found === 0) {
		problems.push(
			`no mapped row was found at all (${expected} expected) — the response shape has changed`,
		);
	}
	raiseSchemaError("LiteLLM", problems);
}

/** The same per-model sentinel for models.dev. */
export function assertModelsDevSchema(
	raw: unknown,
	map: Record<string, ModelSourceMap>,
	expectedTiers: ReadonlySet<string> = EXPECTED_TIERS,
): void {
	if (typeof raw !== "object" || raw === null) {
		throw new SourceError("models.dev: response is not an object");
	}
	const providers = raw as Record<string, { models?: Record<string, unknown> } | undefined>;
	const problems: string[] = [];
	let expected = 0;
	let found = 0;

	for (const [model, entry] of Object.entries(map)) {
		if (entry.modelsDev === null) continue;
		expected++;
		// Vendor-pinned by construction: the provider is indexed, never scanned.
		const foundModel = providers[entry.modelsDev.provider]?.models?.[entry.modelsDev.id];
		// Absent model: not a schema change, coverage names it. Present model
		// whose `cost` object has vanished: the structure this tool reads is
		// gone, which is a schema failure and must not degrade into drift.
		if (typeof foundModel !== "object" || foundModel === null) continue;
		found++;
		const cost = (foundModel as { cost?: unknown }).cost;
		if (typeof cost !== "object" || cost === null) {
			problems.push(`${model} is present but its cost object is missing`);
			continue;
		}
		const c = cost as Record<string, unknown>;

		for (const f of REQUIRED_MODELS_DEV_FIELDS) {
			if (!isUsable(f, c[f])) problems.push(`${model} lost required ${f}`);
		}
		if (
			expectedTiers.has(`models.dev:${model}:cacheRead`) &&
			!isUsable("cache_read", c.cache_read)
		) {
			problems.push(`${model} lost cache_read`);
		}
		if (
			expectedTiers.has(`models.dev:${model}:cacheWrite`) &&
			!isUsable("cache_write", c.cache_write)
		) {
			problems.push(`${model} lost cache_write`);
		}
	}
	// Same rule as LiteLLM: total absence is a shape change, not 19 coincidental
	// model removals.
	if (expected > 0 && found === 0) {
		problems.push(
			`no mapped model was found at all (${expected} expected) — the response shape has changed`,
		);
	}
	raiseSchemaError("models.dev", problems);
}

/**
 * Normalize LiteLLM's table, VENDOR-PINNED.
 *
 * A row whose `litellm_provider` is not the vendor the map names is treated as
 * ABSENT. LiteLLM carries `us.` / `eu.` / `au.` / `jp.` regional rows at a 10%
 * premium and `azure_ai/` + `vertex_ai/` reseller rows beside the vendor row;
 * accepting any of them would answer with a plausible wrong number.
 */
export function normalizeLiteLLM(
	raw: unknown,
	map: Record<string, ModelSourceMap>,
): Record<string, SourceRates | null> {
	if (typeof raw !== "object" || raw === null) {
		throw new SourceError("LiteLLM: response is not an object");
	}
	const table = raw as Record<string, Record<string, unknown> | undefined>;
	const out: Record<string, SourceRates | null> = {};

	for (const [model, entry] of Object.entries(map)) {
		out[model] = null;
		if (entry.litellm === null) continue;

		const row = table[entry.litellm.key];
		// `typeof !== object || null`, not `=== undefined`. A retained key holding
		// `null` passes an undefined-only check and the next dereference throws a
		// TypeError, collapsing a NAMED missing-mapping report into a generic
		// exit-2. The sentinel already treats such a row as absent; normalization
		// must agree with it.
		if (typeof row !== "object" || row === null) continue;
		// The vendor pin. Not a lint — a reseller row here is a wrong number.
		if (row.litellm_provider !== entry.litellm.provider) continue;

		const input = optionalRate(row.input_cost_per_token);
		const output = optionalRate(row.output_cost_per_token);
		// Input and output are mandatory; a row without both corroborates nothing.
		if (input === undefined || output === undefined) continue;

		const cacheRead = optionalRate(row.cache_read_input_token_cost);
		const cacheWrite = optionalRate(row.cache_creation_input_token_cost);

		out[model] = {
			inputPer1k: usertokensPer1kFromUsdPerToken(input),
			outputPer1k: usertokensPer1kFromUsdPerToken(output),
			// NOT `cache_creation_input_token_cost_above_1hr`: our table collapses
			// per-TTL cache pricing to the 5-minute rate as a documented
			// approximation, so the 5m field is the one that corresponds.
			cacheReadPer1k:
				cacheRead === undefined ? undefined : usertokensPer1kFromUsdPerToken(cacheRead),
			cacheWritePer1k:
				cacheWrite === undefined ? undefined : usertokensPer1kFromUsdPerToken(cacheWrite),
		};
	}
	return out;
}

/**
 * Normalize models.dev, VENDOR-PINNED by provider id.
 *
 * 190 providers, most of them resellers and gateways. Measured 2026-08-17, an
 * unpinned matcher answered claude-fable-5 at 30/185 against a true 100/500 and
 * claude-opus-5 at 55/275 (a regional premium) — both well-formed, both wrong.
 *
 * Only the BASE `cost` object is read. `cost.tiers` / `cost.context_over_200k`
 * carry long-context uplifts that PRICING_TABLE deliberately does not model
 * (documented approximation); comparing against a tier would flag every
 * long-context model as drifted.
 */
export function normalizeModelsDev(
	raw: unknown,
	map: Record<string, ModelSourceMap>,
): Record<string, SourceRates | null> {
	if (typeof raw !== "object" || raw === null) {
		throw new SourceError("models.dev: response is not an object");
	}
	const providers = raw as Record<string, { models?: Record<string, unknown> } | undefined>;
	const out: Record<string, SourceRates | null> = {};

	for (const [model, entry] of Object.entries(map)) {
		out[model] = null;
		if (entry.modelsDev === null) continue;

		// The vendor pin: index the named provider directly. Never scan for the id.
		const provider = providers[entry.modelsDev.provider];
		const found = provider?.models?.[entry.modelsDev.id];
		if (typeof found !== "object" || found === null) continue;

		const cost = (found as { cost?: unknown }).cost;
		if (typeof cost !== "object" || cost === null) continue;
		const c = cost as Record<string, unknown>;

		const input = optionalRate(c.input);
		const output = optionalRate(c.output);
		if (input === undefined || output === undefined) continue;

		const cacheRead = optionalRate(c.cache_read);
		const cacheWrite = optionalRate(c.cache_write);

		out[model] = {
			inputPer1k: usertokensPer1kFromUsdPerMTok(input),
			outputPer1k: usertokensPer1kFromUsdPerMTok(output),
			cacheReadPer1k:
				cacheRead === undefined ? undefined : usertokensPer1kFromUsdPerMTok(cacheRead),
			cacheWritePer1k:
				cacheWrite === undefined ? undefined : usertokensPer1kFromUsdPerMTok(cacheWrite),
		};
	}
	return out;
}

/** Fetch one JSON document. Any failure is a SourceError — never a silent null. */
export async function fetchJson(url: string, timeoutMs = 30_000): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) {
			throw new SourceError(`${url}: HTTP ${res.status} ${res.statusText}`);
		}
		return await res.json();
	} catch (err) {
		if (err instanceof SourceError) throw err;
		throw new SourceError(`${url}: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		clearTimeout(timer);
	}
}
