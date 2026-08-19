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
import { renderReport } from "./report.mts";
import { normalizeLiteLLM, normalizeModelsDev, usertokensPer1kFromUsdPerMTok } from "./sources.mts";

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
		floors?: { minMappings?: number; minCorroboratedModels?: number };
	} = {},
) {
	const map = opts.map ?? MAP;
	return compareTable({
		table,
		map,
		deviations: opts.deviations ?? {},
		...(opts.floors !== undefined ? { floors: opts.floors } : {}),
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
		assert.deepEqual(f?.diffs, [
			{
				tier: "inputPer1k",
				ours: 5,
				effective: 5,
				upstream: 50,
				upstreamMax: 50,
				publishedBy: ["litellm", "models.dev"],
				conflicted: false,
			},
		]);
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
		assert.deepEqual(
			r.findings[0]?.cacheGaps.map((g) => g.tier),
			["cacheReadPer1k"],
		);
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

// ── schema pin ────────────────────────────────────────────────────────────
//
// The real pin lives in sources.test.mts, which drives assertLiteLLMSchema /
// assertModelsDevSchema against realistic corpora with fields renamed. The
// test that used to live here asserted LITELLM_FIELDS against a hardcoded copy
// of itself — a constant compared to itself proves nothing about upstream, and
// it read as coverage while providing none.

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

// ── regressions from the first review ─────────────────────────────────────
//
// Four P1s and a P2, and three of the P1s were the same underlying mistake:
// electing ONE source as "the" consensus instead of resolving each tier across
// all of them. These tests exist so that mistake cannot come back.

describe("understatement cannot hide behind an omitted tier", () => {
	it("FAILS when an omitted cache-WRITE tier meters below upstream", () => {
		// The assumption this kills: "omitted tier => D1 fallback => conservative
		// overstatement". True for a cache-READ discount (~0.1x input); FALSE for
		// a cache-WRITE premium (1.25x input), where falling back to inputPer1k
		// understates by 20%. Judged on the effective rate, never on presence.
		const r = run(
			{ "test-model": MATCHING }, // omits cacheWritePer1k -> meters at 50
			{
				litellm: litellmRaw({ cache_creation_input_token_cost: 6.25e-6 }), // 62.5
				modelsDev: modelsDevRaw({ input: 5, output: 25, cache_write: 6.25 }),
			},
		);
		assert.equal(r.counts.understated, 1, "a cache-write premium we omit is understatement");
		assert.equal(r.failed, true);
		assert.equal(r.findings[0]?.cacheGaps.length, 0, "not a benign gap");
	});

	it("still reports a genuinely conservative omitted tier as a gap", () => {
		const r = run(
			{ "test-model": MATCHING },
			{
				litellm: litellmRaw({ cache_read_input_token_cost: 5e-7 }), // 5 < 50
				modelsDev: modelsDevRaw({ input: 5, output: 25, cache_read: 0.5 }),
			},
		);
		assert.equal(r.counts.agree, 1);
		assert.deepEqual(
			r.findings[0]?.cacheGaps.map((g) => g.tier),
			["cacheReadPer1k"],
		);
	});
});

describe("understatement survives cross-source conflict", () => {
	it("FAILS when ours is below BOTH conflicting sources", () => {
		// ours 50; sources 60 and 70. They disagree, but we are low on either
		// reading, so "we cannot say which is right" is no defence.
		const r = run(
			{ "test-model": { inputPer1k: 50, outputPer1k: 250 } },
			{
				litellm: litellmRaw({ input_cost_per_token: 6e-6 }),
				modelsDev: modelsDevRaw({ input: 7, output: 25 }),
			},
		);
		assert.equal(r.counts.understated, 1);
		assert.equal(r.counts["source-conflict"], 0);
		assert.equal(r.failed, true);
	});

	it("FAILS an understated tier even when a DIFFERENT tier conflicts", () => {
		const r = run(
			{ "test-model": { inputPer1k: 10, outputPer1k: 250 } }, // input low on both
			{
				litellm: litellmRaw({ output_cost_per_token: 3e-5 }), // output conflicts
				modelsDev: modelsDevRaw({ input: 5, output: 25 }),
			},
		);
		assert.equal(r.counts.understated, 1);
		assert.equal(r.failed, true);
	});

	it("reports conflict (without failing) when ours is not below any source", () => {
		const r = run(
			{ "test-model": MATCHING },
			{ modelsDev: modelsDevRaw({ input: 2.5, output: 12.5 }) },
		);
		assert.equal(r.counts["source-conflict"], 1);
		assert.equal(r.failed, false);
	});
});

describe("tiers merge across every source", () => {
	it("does not discard a tier only ONE source publishes", () => {
		// LiteLLM omits cache-write, models.dev publishes it. Electing LiteLLM as
		// the consensus would drop that value entirely — no diff, no gap.
		const r = run(
			{ "test-model": { ...MATCHING, cacheWritePer1k: 999 } },
			{
				litellm: litellmRaw(),
				modelsDev: modelsDevRaw({ input: 5, output: 25, cache_write: 6.25 }),
			},
		);
		const tiers = r.findings[0]?.diffs.map((d) => d.tier) ?? [];
		assert.ok(tiers.includes("cacheWritePer1k"), "single-source tier must still be compared");
	});

	it("gives the SAME verdict whichever source is listed first", () => {
		const table = { "test-model": { ...MATCHING, cacheWritePer1k: 1 } };
		const litellm = normalizeLiteLLM(litellmRaw(), MAP);
		const modelsDev = normalizeModelsDev(
			modelsDevRaw({ input: 5, output: 25, cache_write: 6.25 }),
			MAP,
		);
		const a = compareTable({ table, map: MAP, deviations: {}, sources: { litellm, modelsDev } });
		const b = compareTable({ table, map: MAP, deviations: {}, sources: { modelsDev, litellm } });
		assert.equal(a.counts.understated, b.counts.understated);
		assert.equal(a.failed, b.failed);
		assert.equal(a.failed, true, "1 < 62.5 is understatement either way");
	});
});

// ── regressions from the second review ────────────────────────────────────

describe("definitive diffs outrank source conflict", () => {
	it("FAILS a unanimous mismatch even when another tier conflicts", () => {
		// ours 75/250; sources 50/200 and 50/250. Input is unanimous at 50 and
		// ours contradicts it — a real, unallowlisted disagreement. Output
		// conflicts. Previously the conflict won and the run passed.
		const r = run(
			{ "test-model": { inputPer1k: 75, outputPer1k: 250 } },
			{
				litellm: litellmRaw({ input_cost_per_token: 5e-6, output_cost_per_token: 2e-5 }),
				modelsDev: modelsDevRaw({ input: 5, output: 25 }),
			},
		);
		assert.equal(r.counts.disagree, 1);
		assert.equal(r.counts["source-conflict"], 0);
		assert.equal(r.failed, true);
	});

	it("still reports source-conflict when EVERY diff is conflicted", () => {
		const r = run(
			{ "test-model": MATCHING },
			{ modelsDev: modelsDevRaw({ input: 2.5, output: 12.5 }) },
		);
		assert.equal(r.counts["source-conflict"], 1);
		assert.equal(r.failed, false);
	});
});

describe("an omitted tier is benign only above EVERY source", () => {
	it("does not call a gap conservative when it sits inside the source range", () => {
		// Our fallback meters at 50. Sources publish 5 and 62.5 — we are above one
		// and below the other, so the tier is neither understated nor safe.
		const r = run(
			{ "test-model": MATCHING },
			{
				litellm: litellmRaw({ cache_read_input_token_cost: 5e-7 }), // 5
				modelsDev: modelsDevRaw({ input: 5, output: 25, cache_read: 6.25 }), // 62.5
			},
		);
		assert.equal(r.findings[0]?.cacheGaps.length, 0, "must not be filed as a safe gap");
		const d = r.findings[0]?.diffs.find((x) => x.tier === "cacheReadPer1k");
		assert.equal(d?.conflicted, true);
		assert.equal(d?.upstream, 5);
		assert.equal(d?.upstreamMax, 62.5);
	});
});

describe("effective rates use the SDK's own resolver", () => {
	it("meters a NEGATIVE cache rate at inputPer1k, as costFromRates does", () => {
		// resolveAppliedRates guards on `>= 0`, so a negative rate resolves to
		// inputPer1k. A local `?? inputPer1k` would have compared -5 instead —
		// a monitor resolving rates differently from the thing it monitors.
		const r = run(
			{ "test-model": { ...MATCHING, cacheReadPer1k: -5 } },
			{
				litellm: litellmRaw({ cache_read_input_token_cost: 5e-7 }),
				modelsDev: modelsDevRaw({ input: 5, output: 25, cache_read: 0.5 }),
			},
		);
		assert.equal(r.counts.understated, 0, "-5 resolves to 50, which is above upstream 5");
	});
});

// ── regressions from the third review ─────────────────────────────────────

describe("coverage is enforced per source→model mapping", () => {
	it("FAILS when one mapped source drops a model the other still answers", () => {
		// The model-level count cannot see this: `sources.length > 0` keeps the
		// model "corroborated" while an entire independent check has vanished.
		const r = run(
			{ "test-model": MATCHING },
			{
				litellm: { "renamed-away": { litellm_provider: "testvendor" } },
				modelsDev: modelsDevRaw(),
			},
		);
		assert.equal(r.corroborated, 1, "still corroborated at model granularity");
		assert.equal(r.mappings, 1);
		assert.equal(r.expectedMappings, 2);
		assert.equal(r.failed, true, "a lost independent check must fail the run");
	});

	it("passes when every mapped source answers", () => {
		const r = run({ "test-model": MATCHING });
		assert.equal(r.mappings, 2);
		assert.equal(r.expectedMappings, 2);
		assert.equal(r.failed, false);
	});
});

describe("conflict reporting does not overclaim", () => {
	it("never says our rate exceeds every source when it sits in range", () => {
		const r = run(
			{ "test-model": { inputPer1k: 60, outputPer1k: 250 } },
			{
				litellm: litellmRaw({ input_cost_per_token: 5e-6 }), // 50
				modelsDev: modelsDevRaw({ input: 7, output: 25 }), // 70
			},
		);
		assert.equal(r.counts["source-conflict"], 1);
		assert.doesNotMatch(String(r.findings[0]?.note), /not below any of them/);
		assert.match(String(r.findings[0]?.note), /no definitive upstream value/);
	});

	it("keeps the conflicting range even when the omitted tier is conservative", () => {
		// Fallback 50 exceeds both 0.5 and 5, so it is a safe gap — but the
		// sources still disagree, so the model lands in source-conflict and the
		// report must show the values rather than an empty dash.
		const r = run(
			{ "test-model": MATCHING },
			{
				litellm: litellmRaw({ cache_read_input_token_cost: 5e-8 }), // 0.5
				modelsDev: modelsDevRaw({ input: 5, output: 25, cache_read: 0.5 }), // 5
			},
		);
		assert.equal(r.counts["source-conflict"], 1);
		assert.deepEqual(
			r.findings[0]?.cacheGaps.map((g) => g.tier),
			["cacheReadPer1k"],
		);
		const d = r.findings[0]?.diffs.find((x) => x.tier === "cacheReadPer1k");
		assert.equal(d?.upstream, 0.5);
		assert.equal(d?.upstreamMax, 5);
	});
});

// ── regressions from the fourth review ────────────────────────────────────

describe("a rate above EVERY source is definite drift", () => {
	it("FAILS when ours exceeds both conflicting sources", () => {
		// Sources at 50 and 70, ours at 100. They disagree about where the truth
		// is, but none of them supports 100 — the mismatch is definite even though
		// the sources argue.
		const r = run(
			{ "test-model": { inputPer1k: 100, outputPer1k: 250 } },
			{
				litellm: litellmRaw({ input_cost_per_token: 5e-6 }),
				modelsDev: modelsDevRaw({ input: 7, output: 25 }),
			},
		);
		assert.equal(r.counts.disagree, 1);
		assert.equal(r.counts["source-conflict"], 0);
		assert.equal(r.failed, true);
	});

	it("still treats a rate INSIDE the range as undecidable", () => {
		const r = run(
			{ "test-model": { inputPer1k: 60, outputPer1k: 250 } },
			{
				litellm: litellmRaw({ input_cost_per_token: 5e-6 }),
				modelsDev: modelsDevRaw({ input: 7, output: 25 }),
			},
		);
		assert.equal(r.counts["source-conflict"], 1);
		assert.equal(r.failed, false);
	});
});

describe("absolute coverage floors", () => {
	it("FAILS when the map itself is weakened, which the derived count cannot see", () => {
		// Dropping a source from the map lowers actual AND expected together, so
		// the derived check passes. Only a checked-in floor notices.
		const weakened: Record<string, ModelSourceMap> = {
			"test-model": { litellm: null, modelsDev: { provider: "testvendor", id: "test-model" } },
		};
		const r = compareTable({
			table: { "test-model": MATCHING },
			map: weakened,
			deviations: {},
			sources: {
				litellm: normalizeLiteLLM(litellmRaw(), weakened),
				"models.dev": normalizeModelsDev(modelsDevRaw(), weakened),
			},
			floors: { minMappings: 2, minCorroboratedModels: 1 },
		});
		assert.equal(r.mappings, r.expectedMappings, "derived check is satisfied");
		assert.equal(r.failed, true, "the absolute floor must still fail it");
	});
});

describe("missing mappings are NAMED, not just counted", () => {
	it("identifies which source stopped answering for which model", () => {
		const r = run(
			{ "test-model": MATCHING },
			{ litellm: { "renamed-away": { litellm_provider: "testvendor" } } },
		);
		assert.deepEqual(r.missingMappings, ["litellm:test-model"]);
	});
});

// ── regressions from the fifth review ─────────────────────────────────────

describe("range classification uses the effective rate", () => {
	it("FAILS a malformed cache rate that METERS above every source", () => {
		// cacheReadPer1k -5 resolves to inputPer1k (50) under the canonical rule.
		// Sources conflict at 5 and 10, so comparing raw -5 would read as in-range
		// and pass, while the SDK actually charges 50.
		const r = run(
			{ "test-model": { inputPer1k: 50, outputPer1k: 250, cacheReadPer1k: -5 } },
			{
				litellm: litellmRaw({ cache_read_input_token_cost: 5e-7 }), // 5
				modelsDev: modelsDevRaw({ input: 5, output: 25, cache_read: 1 }), // 10
			},
		);
		assert.equal(r.counts.disagree, 1);
		assert.equal(r.counts["source-conflict"], 0);
		assert.equal(r.failed, true);
	});
});

describe("absolute floor breaches are visible, not just fatal", () => {
	it("records the breach on the report so the issue states a reason", () => {
		// Both counts match their derived expectation, every model agrees, and
		// nothing is missing — the only signal is the absolute floor.
		const r = run(
			{ "test-model": MATCHING },
			{ floors: { minMappings: 99, minCorroboratedModels: 99 } },
		);
		assert.equal(r.counts.agree, 1);
		assert.deepEqual(r.missingMappings, []);
		assert.equal(r.mappings, r.expectedMappings);
		assert.equal(r.floors.breached, true);
		assert.equal(r.failed, true);

		const md = renderReport(r, {
			tableVersion: "test",
			fetchedAt: "now",
			sourceUrls: {},
			orphanDeviations: [],
		});
		assert.match(md, /Absolute coverage floor breached/);
	});

	it("does not report a breach when the floors are met", () => {
		const r = run(
			{ "test-model": MATCHING },
			{ floors: { minMappings: 2, minCorroboratedModels: 1 } },
		);
		assert.equal(r.floors.breached, false);
		assert.equal(r.failed, false);
	});
});

// ── regressions from the sixth review ─────────────────────────────────────

describe("our own table is validated before comparison", () => {
	for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -1] as const) {
		it(`FAILS a required tier of ${String(bad)} instead of reporting agree`, () => {
			// rawTier rejects a non-finite value, so this would fall through the
			// cache-absence path (required tiers are merely excluded from cacheGaps),
			// emit no diff, and report `agree` for a model whose metered cost is not
			// a number.
			const r = run({ "test-model": { inputPer1k: bad, outputPer1k: 250 } });
			assert.equal(r.counts["malformed-rate"], 1);
			assert.equal(r.counts.agree, 0);
			assert.equal(r.failed, true);
		});
	}

	it("keeps a valid table clean", () => {
		const r = run({ "test-model": MATCHING });
		assert.equal(r.counts["malformed-rate"], 0);
		assert.equal(r.failed, false);
	});
});

// ── regressions from the seventh review ───────────────────────────────────

describe("an allowlist cannot absorb a conflicted tier", () => {
	it("reports conflict when one tier is allowlisted-conservative and another straddles", () => {
		// ours 75/250; sources 50/200 and 50/300. Input is a definitive
		// conservative deviation (allowlisted). Output straddles our rate — one
		// source prices it ABOVE us. Labelling the whole model
		// `deviation-expected` would claim "ours is higher" while that is false
		// for output. An allowlist excuses a deviation we understand; it cannot
		// excuse a tier nobody can adjudicate.
		const r = run(
			{ "test-model": { inputPer1k: 75, outputPer1k: 250 } },
			{
				deviations: { "test-model": { reason: "documented" } },
				litellm: litellmRaw({ input_cost_per_token: 5e-6, output_cost_per_token: 2e-5 }),
				modelsDev: modelsDevRaw({ input: 5, output: 30 }),
			},
		);
		assert.equal(r.counts["source-conflict"], 1);
		assert.equal(r.counts["deviation-expected"], 0);
	});

	it("still reports deviation-expected when nothing conflicts", () => {
		const r = run(
			{ "test-model": { inputPer1k: 75, outputPer1k: 250 } },
			{ deviations: { "test-model": { reason: "documented" } } },
		);
		assert.equal(r.counts["deviation-expected"], 1);
		assert.equal(r.failed, false);
	});
});

describe("malformed findings keep their answered sources", () => {
	it("does not invent a coverage breach alongside a malformed rate", () => {
		const r = run({ "test-model": { inputPer1k: Number.NaN, outputPer1k: 250 } });
		assert.equal(r.counts["malformed-rate"], 1);
		assert.deepEqual(r.findings[0]?.sources, ["litellm", "models.dev"]);
		assert.equal(r.mappings, 2, "both sources answered and must still be counted");
		assert.deepEqual(r.missingMappings, [], "no mapping actually went missing");
	});
});

// ── regressions from the connector's review threads ───────────────────────

describe("tier differences are attributed to their publishing sources", () => {
	it("credits only the source that publishes a differing cache tier", () => {
		// Both sources answer input/output; only LiteLLM publishes cache-read.
		// Listing both beside that comparison would attribute a rate to a source
		// that never stated it.
		const r = run(
			{ "test-model": { inputPer1k: 50, outputPer1k: 250, cacheReadPer1k: 99 } },
			{
				litellm: litellmRaw({ cache_read_input_token_cost: 5e-7 }),
				modelsDev: modelsDevRaw({ input: 5, output: 25 }),
			},
		);
		const d = r.findings[0]?.diffs.find((x) => x.tier === "cacheReadPer1k");
		assert.deepEqual(d?.publishedBy, ["litellm"], "only litellm publishes this tier");
		assert.deepEqual(r.findings[0]?.sources, ["litellm", "models.dev"], "both still answered");
	});
});

// ── regressions from the twelfth review ───────────────────────────────────

describe("cache gaps carry their own publishers", () => {
	it("credits an omitted tier only to the source that publishes it", () => {
		// Both sources answer input/output; only LiteLLM publishes cache-read,
		// which our table omits. Listing both would send a reader to check a
		// source that never stated a cache rate.
		const r = run(
			{ "test-model": MATCHING },
			{
				litellm: litellmRaw({ cache_read_input_token_cost: 5e-7 }),
				modelsDev: modelsDevRaw({ input: 5, output: 25 }),
			},
		);
		assert.deepEqual(r.findings[0]?.cacheGaps, [
			{ tier: "cacheReadPer1k", publishedBy: ["litellm"] },
		]);
		assert.deepEqual(r.findings[0]?.sources, ["litellm", "models.dev"]);
	});
});

describe("a null upstream row is skipped, not dereferenced", () => {
	it("reports a named missing mapping rather than throwing", () => {
		// A retained key holding `null` passes an `=== undefined` check and the
		// next dereference throws, collapsing a named report into a generic
		// exit-2 "could not check".
		const r = run(
			{ "test-model": MATCHING },
			{ litellm: { "test-model": null }, modelsDev: modelsDevRaw() },
		);
		assert.deepEqual(r.missingMappings, ["litellm:test-model"]);
		assert.equal(r.failed, true);
	});
});
