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
	// Round to 6dp: the inputs are decimal prices but arrive as binary floats
	// (LiteLLM stores 5e-06 per token, and 5e-06 * 1e7 is 50.000000000000007).
	// Table rates are given to at most 4dp, so 6dp cannot mask a real difference.
	return Math.round(usdPerMTok * 10 * 1e6) / 1e6;
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
 * How many rows must carry a field before we believe it still exists.
 *
 * >1 deliberately: a single surviving legacy row would let a rename pass a
 * "appears at least once" check. Both corpora carry thousands of entries, so
 * any live field appears in the hundreds; 5 is far below the real floor and far
 * above the noise.
 */
const SCHEMA_MIN_OCCURRENCES = 5;

/**
 * Is this field carrying a value the normalizer could actually use?
 *
 * `litellm_provider` is an attribution string; every other tracked field is a
 * price and must be a finite non-negative number.
 */
function isUsable(field: string, value: unknown): boolean {
	if (field === "litellm_provider") return typeof value === "string" && value.length > 0;
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertFieldsPresent(source: string, counts: Map<string, number>): void {
	const missing = [...counts.entries()]
		.filter(([, n]) => n < SCHEMA_MIN_OCCURRENCES)
		.map(([f, n]) => `${f} (seen ${n}x)`);
	if (missing.length > 0) {
		throw new SourceError(
			`${source}: expected field(s) absent or nearly absent — schema changed: ${missing.join(", ")}. ` +
				"Refusing to report a comparison that silently skipped these tiers.",
		);
	}
}

/**
 * Verify LiteLLM still publishes every field this tool reads, BY NAME, against
 * the fetched corpus. Throws SourceError (exit 2 — "could not check") rather
 * than letting a rename degrade into a clean-looking run.
 *
 * Called at INGEST (see run.mts), not from `normalizeLiteLLM`: the normalizers
 * are pure transforms and are driven from small fixtures, which by construction
 * cannot satisfy an occurrence floor meant for a 3,000-row corpus.
 */
export function assertLiteLLMSchema(raw: unknown): void {
	if (typeof raw !== "object" || raw === null) {
		throw new SourceError("LiteLLM: response is not an object");
	}
	const counts = new Map(LITELLM_FIELDS.map((f) => [f, 0]));
	for (const row of Object.values(raw as Record<string, unknown>)) {
		if (typeof row !== "object" || row === null) continue;
		const r = row as Record<string, unknown>;
		for (const f of LITELLM_FIELDS) {
			// USABLE values, not merely present keys. An upstream that keeps a
			// deprecated key around holding `null` (or a string) while the numeric
			// price moves elsewhere would clear a `in`-based floor while the
			// normalizer silently dropped every value — full coverage, exit 0,
			// cache comparison disabled. Presence of a name is not presence of a
			// rate.
			if (isUsable(f, r[f])) counts.set(f, (counts.get(f) ?? 0) + 1);
		}
	}
	assertFieldsPresent("LiteLLM", counts);
}

/** The same sentinel for models.dev, walked over every provider's models. */
export function assertModelsDevSchema(raw: unknown): void {
	if (typeof raw !== "object" || raw === null) {
		throw new SourceError("models.dev: response is not an object");
	}
	const counts = new Map(MODELS_DEV_FIELDS.map((f) => [f, 0]));
	for (const provider of Object.values(raw as Record<string, unknown>)) {
		const models = (provider as { models?: unknown } | null)?.models;
		if (typeof models !== "object" || models === null) continue;
		for (const model of Object.values(models as Record<string, unknown>)) {
			const cost = (model as { cost?: unknown } | null)?.cost;
			if (typeof cost !== "object" || cost === null) continue;
			const c = cost as Record<string, unknown>;
			for (const f of MODELS_DEV_FIELDS) {
				if (isUsable(f, c[f])) counts.set(f, (counts.get(f) ?? 0) + 1);
			}
		}
	}
	assertFieldsPresent("models.dev", counts);
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
		if (row === undefined) continue;
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
