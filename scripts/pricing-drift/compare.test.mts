/**
 * compare.test.mts — contract tests for the drift checker's decision rules.
 *
 * No test performs network I/O; every case drives the pure functions from
 * in-memory fixtures.
 *
 * THE POSITIVE CONTROL IS MANDATORY AND IT IS THE FIRST TEST BELOW. Watching
 * every case pass proves the instrument can pass; it does NOT prove it can
 * fail, and an all-pass suite cannot detect an instrument that is disconnected.
 * A harness in this repo previously passed three mutations by rejecting an
 * empty file rather than the mutation under test; only a control caught it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelRates } from "../../packages/core/src/ledger/pricing.js";
import { PRICING_TABLE } from "../../packages/core/src/ledger/pricing.js";
import { compareTable, orphanDeviations } from "./compare.mts";
import type { ModelSourceMap } from "./model-map.mts";
import {
	LITELLM_FIELDS,
	MODELS_DEV_FIELDS,
	normalizeLiteLLM,
	normalizeModelsDev,
	usertokensPer1kFromUsdPerMTok,
} from "./sources.mts";

// ── fixtures ──────────────────────────────────────────────────────────────

const MAP: Record<string, ModelSourceMap> = {
	"test-model": {
		litellm: { key: "test-model", provider: "testvendor" },
		modelsDev: { provider: "testvendor", id: "test-model" },
	},
};

/** $5 in / $25 out per MTok = 50 / 250 usertokens per 1k. */
function litellmRaw(overrides: Record<string, unknown> = {}) {
	return {
		"test-model": {
			litellm_provider: "testvendor",
			input_cost_per_token: 5e-6,
			output_cost_per_token: 2.5e-5,
			...overrides,
		},
	};
}

function modelsDevRaw(cost: Record<string, unknown> = { input: 5, output: 25 }) {
	return { testvendor: { models: { "test-model": { cost } } } };
}

function run(
	table: Record<string, ModelRates>,
	opts: {
		map?: Record<string, ModelSourceMap>;
		deviations?: Record<string, { reason: string }>;
		litellm?: unknown;
		modelsDev?: unknown;
	} = {},
) {
	const map = opts.map ?? MAP;
	return compareTable({
		table,
		map,
		deviations: opts.deviations ?? {},
		sources: {
			litellm: normalizeLiteLLM(opts.litellm ?? litellmRaw(), map),
			"models.dev": normalizeModelsDev(opts.modelsDev ?? modelsDevRaw(), map),
		},
	});
}

const MATCHING: ModelRates = { inputPer1k: 50, outputPer1k: 250 };

// ── the control ───────────────────────────────────────────────────────────

describe("positive control", () => {
	it("REPORTS a rate mutated below upstream — proves the instrument can fail", () => {
		const r = run({ "test-model": { inputPer1k: 5, outputPer1k: 250 } });

		assert.equal(r.counts.understated, 1);
		assert.equal(r.failed, true);
		const f = r.findings[0];
		assert.equal(f?.outcome, "understated");
		assert.deepEqual(f?.diffs, [{ tier: "inputPer1k", ours: 5, upstream: 50 }]);
	});

	it("negative control: the same harness PASSES a matching table", () => {
		const r = run({ "test-model": MATCHING });
		assert.equal(r.counts.agree, 1);
		assert.equal(r.failed, false);
	});
});

// ── the allowlist rule (spec §5) ──────────────────────────────────────────

describe("expected-deviation allowlist", () => {
	const deviations = { "test-model": { reason: "documented conservative deviation" } };

	it("suppresses failure while ours is HIGHER than upstream", () => {
		const r = run({ "test-model": { inputPer1k: 75, outputPer1k: 250 } }, { deviations });
		assert.equal(r.counts["deviation-expected"], 1);
		assert.equal(r.failed, false);
	});

	it("CANNOT suppress understatement — fails even with an entry present", () => {
		// The load-bearing rule. If this ever passes, the allowlist has become a
		// way to permit under-billing, which no field is allowed to do.
		const r = run({ "test-model": { inputPer1k: 25, outputPer1k: 250 } }, { deviations });
		assert.equal(r.counts.understated, 1);
		assert.equal(r.counts["deviation-expected"], 0);
		assert.equal(r.failed, true);
		assert.match(String(r.findings[0]?.note), /CANNOT suppress understatement/);
	});

	it("reports a STALE entry once upstream agrees", () => {
		const r = run({ "test-model": MATCHING }, { deviations });
		assert.equal(r.counts["deviation-stale"], 1);
		assert.equal(r.failed, true);
	});

	it("reports an ORPHANED entry naming a model not in the table", () => {
		assert.deepEqual(
			orphanDeviations({ "test-model": MATCHING }, { "gone-model": { reason: "x" } }),
			["gone-model"],
		);
	});
});

// ── vendor pinning (spec §3.1) ────────────────────────────────────────────

describe("vendor pinning", () => {
	it("REJECTS a LiteLLM row whose litellm_provider is a reseller", () => {
		// Measured 2026-08-17: unpinned matching answered claude-fable-5 at 30/185
		// against a true 100/500. A reseller row is a wrong number, not an answer.
		const r = run(
			{ "test-model": MATCHING },
			{
				litellm: litellmRaw({ litellm_provider: "some-reseller", input_cost_per_token: 1e-6 }),
				modelsDev: { other: { models: {} } },
			},
		);
		assert.equal(r.counts.uncorroborated, 1);
		assert.equal(r.findings[0]?.sources.length, 0);
	});

	it("REJECTS a models.dev model carried by a non-vendor provider", () => {
		const r = run(
			{ "test-model": MATCHING },
			{
				litellm: { nothing: {} },
				modelsDev: { reseller: { models: { "test-model": { cost: { input: 1, output: 2 } } } } },
			},
		);
		assert.equal(r.counts.uncorroborated, 1);
	});

	it("reads ONLY the base cost object, never a long-context tier", () => {
		// models.dev carries cost.tiers / cost.context_over_200k uplifts that
		// PRICING_TABLE deliberately does not model. Comparing against a tier
		// would flag every long-context model as drifted.
		const r = run(
			{ "test-model": MATCHING },
			{
				modelsDev: modelsDevRaw({
					input: 5,
					output: 25,
					tiers: [{ input: 10, output: 45 }],
					context_over_200k: { input: 10, output: 45 },
				}),
			},
		);
		assert.equal(r.counts.agree, 1);
	});
});

// ── cache-tier semantics (spec §5.1) ──────────────────────────────────────

describe("cache tiers", () => {
	it("REPORTS but does not fail a tier upstream publishes and we omit", () => {
		// deepseek-chat is the live case: we omit cacheReadPer1k, LiteLLM
		// publishes 0.28, our effective rate is inputPer1k — overstatement.
		const r = run(
			{ "test-model": MATCHING },
			{
				litellm: litellmRaw({ cache_read_input_token_cost: 5e-7 }),
				modelsDev: modelsDevRaw({ input: 5, output: 25, cache_read: 0.5 }),
			},
		);
		assert.equal(r.counts.agree, 1);
		assert.equal(r.failed, false);
		assert.deepEqual(r.findings[0]?.cacheGaps, ["cacheReadPer1k"]);
	});

	it("compares our RAW field, never the effectiveCacheRate resolution", () => {
		// Resolving our side first would make an omitted tier compare as
		// inputPer1k (50) against upstream's real discount (5) and read as a
		// disagreement — inverting the row's meaning.
		const r = run(
			{ "test-model": MATCHING },
			{
				litellm: litellmRaw({ cache_read_input_token_cost: 5e-7 }),
				modelsDev: modelsDevRaw({ input: 5, output: 25, cache_read: 0.5 }),
			},
		);
		assert.equal(r.counts.disagree, 0);
	});

	it("fails understatement on a cache tier we DO publish", () => {
		const r = run(
			{ "test-model": { ...MATCHING, cacheReadPer1k: 1 } },
			{
				litellm: litellmRaw({ cache_read_input_token_cost: 5e-7 }),
				modelsDev: modelsDevRaw({ input: 5, output: 25, cache_read: 0.5 }),
			},
		);
		assert.equal(r.counts.understated, 1);
	});
});

// ── cross-source conflict ─────────────────────────────────────────────────

describe("source conflict", () => {
	it("reports sources contradicting each other, proposing no value", () => {
		// The live case: deepseek-chat, LiteLLM 2.8/4.2 vs models.dev 1.4/2.8.
		const r = run(
			{ "test-model": MATCHING },
			{
				modelsDev: modelsDevRaw({ input: 2.5, output: 12.5 }),
			},
		);
		assert.equal(r.counts["source-conflict"], 1);
		assert.equal(r.failed, false, "cannot say which source is right — must not fail");
	});
});

// ── coverage floor + exhaustiveness (spec §6.1) ───────────────────────────

describe("coverage floor", () => {
	it("FAILS when a renamed upstream field collapses matches to nothing", () => {
		// The silent-schema-break case. A naive checker finds no mismatches here
		// and reports a clean sweep — of nothing.
		const r = run(
			{ "test-model": MATCHING },
			{
				litellm: litellmRaw({ input_cost_per_token: undefined, cost_per_input_token: 5e-6 }),
				modelsDev: { testvendor: { models: { "test-model": { pricing: { input: 5 } } } } },
			},
		);
		assert.equal(r.corroborated, 0);
		assert.equal(r.expectedCorroborated, 1);
		assert.equal(r.failed, true, "zero coverage must never read as a pass");
	});

	it("derives the floor from the map, so it self-maintains", () => {
		const r = run({ "test-model": MATCHING });
		assert.equal(r.expectedCorroborated, 1);
	});

	it("assigns EXACTLY ONE outcome to every model and sums to the table size", () => {
		const r = run({ "test-model": MATCHING });
		assert.equal(r.exhaustive, true);
		assert.equal(
			Object.values(r.counts).reduce((a, b) => a + b, 0),
			r.findings.length,
		);
	});
});

describe("unmapped models", () => {
	it("FAILS a PRICING_TABLE key absent from MODEL_MAP", () => {
		const r = run({ "test-model": MATCHING, "surprise-model": MATCHING });
		assert.equal(r.counts.unmapped, 1);
		assert.equal(r.failed, true);
	});
});

// ── the unit conversion (spec §7.1) ───────────────────────────────────────

describe("unit conversion", () => {
	it("is pinned to a REAL PRICING_TABLE entry, not to a literal", () => {
		// 1 usertoken = $0.0001, so $X/MTok -> X * 10. Anthropic publishes
		// claude-opus-5 at $5.00/MTok and the table holds 50.
		//
		// A test written as `assert.equal(convert(5), 5)` passes against a
		// BROKEN identity conversion and locks the error in. The assertion has
		// to reach the table.
		assert.equal(usertokensPer1kFromUsdPerMTok(5), PRICING_TABLE["claude-opus-5"]?.inputPer1k);
		assert.equal(usertokensPer1kFromUsdPerMTok(25), PRICING_TABLE["claude-opus-5"]?.outputPer1k);
		assert.equal(
			usertokensPer1kFromUsdPerMTok(6.25),
			PRICING_TABLE["claude-opus-5"]?.cacheWritePer1k,
		);
	});

	it("survives the binary-float round trip from LiteLLM per-token values", () => {
		// 5e-06 * 1e7 is 50.000000000000007 before rounding.
		const norm = normalizeLiteLLM(litellmRaw(), MAP);
		assert.equal(norm["test-model"]?.inputPer1k, 50);
		assert.equal(norm["test-model"]?.outputPer1k, 250);
	});
});

// ── schema pin (spec §7 case 6) ───────────────────────────────────────────

describe("upstream schema", () => {
	it("names the LiteLLM fields it depends on, so a rename fails by name", () => {
		assert.deepEqual(
			[...LITELLM_FIELDS],
			[
				"litellm_provider",
				"input_cost_per_token",
				"output_cost_per_token",
				"cache_read_input_token_cost",
				"cache_creation_input_token_cost",
			],
		);
	});

	it("names the models.dev fields it depends on", () => {
		assert.deepEqual([...MODELS_DEV_FIELDS], ["input", "output", "cache_read", "cache_write"]);
	});
});

// ── the real map against the real table ───────────────────────────────────

describe("shipped map vs shipped table", () => {
	it("maps every PRICING_TABLE key — no model ships without decided provenance", async () => {
		const { MODEL_MAP } = await import("./model-map.mts");
		const unmapped = Object.keys(PRICING_TABLE).filter((m) => !(m in MODEL_MAP));
		assert.deepEqual(unmapped, [], `unmapped models: ${unmapped.join(", ")}`);
	});

	it("requires a note on every model recorded as having no source", async () => {
		const { MODEL_MAP } = await import("./model-map.mts");
		const missing = Object.entries(MODEL_MAP)
			.filter(([, e]) => e.litellm === null && e.modelsDev === null && e.note === undefined)
			.map(([m]) => m);
		assert.deepEqual(missing, [], `no-source models missing a note: ${missing.join(", ")}`);
	});

	it("carries no allowlist entry for a model outside the table", async () => {
		const { EXPECTED_DEVIATIONS } = await import("./model-map.mts");
		assert.deepEqual(orphanDeviations(PRICING_TABLE, EXPECTED_DEVIATIONS), []);
	});
});
