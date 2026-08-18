/**
 * sources.test.mts — the runtime schema sentinels, and the report surface for
 * cache gaps.
 *
 * WHY THESE EXIST. The first review of this tool found that its "schema pin"
 * test asserted a constant against a hardcoded copy of itself — it compared
 * `LITELLM_FIELDS` to a literal list and never touched upstream data. That
 * proves nothing. The failure it was supposed to catch is a rename of an
 * OPTIONAL field: `cache_creation_input_token_cost` moves, every cache value
 * silently becomes `undefined`, input and output still resolve so every row
 * still counts as answered, coverage stays full, and the run exits 0 with cache
 * comparison quietly disabled.
 *
 * A monitor built to catch silent degradation had a silent degradation in its
 * own instrument. These tests drive the sentinels against realistic corpora.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareTable } from "./compare.mts";
import type { ModelSourceMap } from "./model-map.mts";
import { renderReport } from "./report.mts";
import {
	assertLiteLLMSchema,
	assertModelsDevSchema,
	normalizeLiteLLM,
	normalizeModelsDev,
	SourceError,
	usertokensPer1kFromUsdPerMTok,
} from "./sources.mts";

/** Expected cache tiers for the fixture rows, mirroring the shipped set. */
const CORPUS_TIERS: ReadonlySet<string> = new Set(
	Array.from({ length: 40 }, (_, i) => [
		`litellm:model-${i}:cacheRead`,
		`litellm:model-${i}:cacheWrite`,
		`models.dev:model-${i}:cacheRead`,
		`models.dev:model-${i}:cacheWrite`,
	]).flat(),
);

/** A map covering every fixture row, so the scoped sentinel can see them. */
const CORPUS_MAP: Record<string, ModelSourceMap> = Object.fromEntries(
	Array.from({ length: 40 }, (_, i) => [
		`model-${i}`,
		{
			litellm: { key: `model-${i}`, provider: "testvendor" },
			modelsDev: { provider: "testvendor", id: `model-${i}` },
		},
	]),
);

/** A corpus big enough to clear the occurrence floor, as the real one is. */
function litellmCorpus(rename?: { from: string; to: string }) {
	const rows: Record<string, Record<string, unknown>> = {};
	for (let i = 0; i < 40; i++) {
		const row: Record<string, unknown> = {
			litellm_provider: "testvendor",
			input_cost_per_token: 5e-6,
			output_cost_per_token: 2.5e-5,
			cache_read_input_token_cost: 5e-7,
			cache_creation_input_token_cost: 6.25e-6,
		};
		if (rename !== undefined && rename.from in row) {
			row[rename.to] = row[rename.from];
			delete row[rename.from];
		}
		rows[`model-${i}`] = row;
	}
	return rows;
}

function modelsDevCorpus(rename?: { from: string; to: string }) {
	const models: Record<string, unknown> = {};
	for (let i = 0; i < 40; i++) {
		const cost: Record<string, unknown> = {
			input: 5,
			output: 25,
			cache_read: 0.5,
			cache_write: 6.25,
		};
		if (rename !== undefined && rename.from in cost) {
			cost[rename.to] = cost[rename.from];
			delete cost[rename.from];
		}
		models[`model-${i}`] = { cost };
	}
	return { testvendor: { models } };
}

describe("LiteLLM schema sentinel", () => {
	it("accepts a healthy corpus", () => {
		assert.doesNotThrow(() => assertLiteLLMSchema(litellmCorpus(), CORPUS_MAP, CORPUS_TIERS));
	});

	it("REFUSES when a required field is renamed", () => {
		assert.throws(
			() =>
				assertLiteLLMSchema(
					litellmCorpus({ from: "input_cost_per_token", to: "cost_per_input_token" }),
					CORPUS_MAP,
				),
			(e: unknown) => e instanceof SourceError && /input_cost_per_token/.test((e as Error).message),
		);
	});

	it("REFUSES when an OPTIONAL cache field is renamed — the silent case", () => {
		// This is the one that matters. Without the sentinel, input/output still
		// resolve, coverage stays full, and the run reports a clean comparison
		// that never looked at cache tiers at all.
		assert.throws(
			() =>
				assertLiteLLMSchema(
					litellmCorpus({
						from: "cache_creation_input_token_cost",
						to: "cache_write_input_token_cost",
					}),
					CORPUS_MAP,
					CORPUS_TIERS,
				),
			(e: unknown) =>
				e instanceof SourceError && /cache_creation_input_token_cost/.test((e as Error).message),
		);
	});

	it("REFUSES a non-object response", () => {
		assert.throws(
			() => assertLiteLLMSchema("a bare string", CORPUS_MAP, CORPUS_TIERS),
			SourceError,
		);
	});
});

describe("models.dev schema sentinel", () => {
	it("accepts a healthy corpus", () => {
		assert.doesNotThrow(() => assertModelsDevSchema(modelsDevCorpus(), CORPUS_MAP, CORPUS_TIERS));
	});

	it("REFUSES when a cost field is renamed", () => {
		assert.throws(
			() =>
				assertModelsDevSchema(
					modelsDevCorpus({ from: "cache_write", to: "cacheWrite" }),
					CORPUS_MAP,
					CORPUS_TIERS,
				),
			(e: unknown) => e instanceof SourceError && /cache_write/.test((e as Error).message),
		);
	});

	it("REFUSES when a required cost field is lost on a mapped model", () => {
		const corpus = modelsDevCorpus();
		delete (corpus.testvendor.models["model-0"] as { cost: Record<string, unknown> }).cost.input;
		assert.throws(
			() => assertModelsDevSchema(corpus, CORPUS_MAP, CORPUS_TIERS),
			(e: unknown) =>
				e instanceof SourceError && /model-0 lost required input/.test((e as Error).message),
		);
	});

	it("names the SPECIFIC model that lost a tier, not just a count", () => {
		// The aggregate-count version passed here: one row losing cache_write
		// while 39 keep it clears any total-based floor.
		const corpus = modelsDevCorpus();
		delete (corpus.testvendor.models["model-7"] as { cost: Record<string, unknown> }).cost
			.cache_write;
		assert.throws(
			() => assertModelsDevSchema(corpus, CORPUS_MAP, CORPUS_TIERS),
			(e: unknown) =>
				e instanceof SourceError && /model-7 lost cache_write/.test((e as Error).message),
		);
	});
});

// ── the P2: cache gaps must reach the report ──────────────────────────────

describe("cache gaps reach the report", () => {
	const MAP: Record<string, ModelSourceMap> = {
		"test-model": {
			litellm: { key: "test-model", provider: "testvendor" },
			modelsDev: { provider: "testvendor", id: "test-model" },
		},
	};

	it("renders a gap on an AGREEING model, which has no section of its own", () => {
		// `agree` is deliberately absent from SECTION_ORDER, so a gap attached to
		// an agreeing model previously produced no row anywhere — silently
		// contradicting "every gap is reported".
		const report = compareTable({
			table: { "test-model": { inputPer1k: 50, outputPer1k: 250 } },
			map: MAP,
			deviations: {},
			sources: {
				litellm: normalizeLiteLLM(
					{
						"test-model": {
							litellm_provider: "testvendor",
							input_cost_per_token: 5e-6,
							output_cost_per_token: 2.5e-5,
							cache_read_input_token_cost: 5e-7,
						},
					},
					MAP,
				),
				"models.dev": normalizeModelsDev(
					{ testvendor: { models: { "test-model": { cost: { input: 5, output: 25 } } } } },
					MAP,
				),
			},
		});

		assert.equal(report.counts.agree, 1);
		const md = renderReport(report, {
			tableVersion: "test",
			fetchedAt: "now",
			sourceUrls: {},
			orphanDeviations: [],
		});
		assert.match(md, /Cache tiers upstream publishes that our table omits/);
		assert.match(md, /test-model/);
	});
});

describe("unit conversion rejects overflow", () => {
	it("REFUSES a finite rate that overflows to Infinity", () => {
		// 1e308 * 10 is Infinity. The row would stay non-null and satisfy mapping
		// coverage while resolveTier filtered the value back out, leaving a
		// one-source model `agree` with neither required tier compared.
		assert.throws(() => usertokensPer1kFromUsdPerMTok(1e308), SourceError);
	});

	it("REFUSES a non-finite input outright", () => {
		assert.throws(() => usertokensPer1kFromUsdPerMTok(Number.POSITIVE_INFINITY), SourceError);
	});

	it("still converts ordinary rates against the real table", () => {
		assert.equal(usertokensPer1kFromUsdPerMTok(5), 50);
	});
});

describe("structural loss is a SCHEMA failure, absence is not", () => {
	it("REFUSES a LiteLLM row that has lost litellm_provider entirely", () => {
		// Distinct from a row belonging to another vendor, which is expected.
		// Losing the pin field itself means every mapped row would fail the
		// vendor check and normalize away — schema failure (exit 2), not drift.
		const corpus = litellmCorpus() as Record<string, Record<string, unknown>>;
		for (const row of Object.values(corpus)) delete row.litellm_provider;
		assert.throws(
			() => assertLiteLLMSchema(corpus, CORPUS_MAP, CORPUS_TIERS),
			(e: unknown) =>
				e instanceof SourceError && /missing litellm_provider/.test((e as Error).message),
		);
	});

	it("ACCEPTS a row that simply belongs to another vendor", () => {
		const corpus = litellmCorpus() as Record<string, Record<string, unknown>>;
		for (const row of Object.values(corpus)) row.litellm_provider = "someone-else";
		// Not a schema change: the pin works, it just does not match. Coverage
		// reports the missing mappings instead.
		assert.doesNotThrow(() => assertLiteLLMSchema(corpus, CORPUS_MAP, CORPUS_TIERS));
	});

	it("REFUSES a models.dev model whose cost object vanished", () => {
		const corpus = modelsDevCorpus() as { testvendor: { models: Record<string, unknown> } };
		corpus.testvendor.models["model-3"] = { name: "still here, no cost" };
		assert.throws(
			() => assertModelsDevSchema(corpus, CORPUS_MAP, CORPUS_TIERS),
			(e: unknown) =>
				e instanceof SourceError &&
				/model-3 is present but its cost object is missing/.test((e as Error).message),
		);
	});

	it("ACCEPTS a model that is simply absent from the feed", () => {
		const corpus = modelsDevCorpus() as { testvendor: { models: Record<string, unknown> } };
		delete corpus.testvendor.models["model-3"];
		assert.doesNotThrow(() => assertModelsDevSchema(corpus, CORPUS_MAP, CORPUS_TIERS));
	});
});
