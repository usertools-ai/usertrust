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
} from "./sources.mts";

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
		assert.doesNotThrow(() => assertLiteLLMSchema(litellmCorpus(), CORPUS_MAP));
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
				),
			(e: unknown) =>
				e instanceof SourceError && /cache_creation_input_token_cost/.test((e as Error).message),
		);
	});

	it("REFUSES a non-object response", () => {
		assert.throws(() => assertLiteLLMSchema("a bare string", CORPUS_MAP), SourceError);
	});
});

describe("models.dev schema sentinel", () => {
	it("accepts a healthy corpus", () => {
		assert.doesNotThrow(() => assertModelsDevSchema(modelsDevCorpus(), CORPUS_MAP));
	});

	it("REFUSES when a cost field is renamed", () => {
		assert.throws(
			() =>
				assertModelsDevSchema(
					modelsDevCorpus({ from: "cache_write", to: "cacheWrite" }),
					CORPUS_MAP,
				),
			(e: unknown) => e instanceof SourceError && /cache_write/.test((e as Error).message),
		);
	});

	it("REFUSES when the whole cost object disappears", () => {
		assert.throws(
			() => assertModelsDevSchema({ testvendor: { models: { a: {} } } }, CORPUS_MAP),
			SourceError,
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
