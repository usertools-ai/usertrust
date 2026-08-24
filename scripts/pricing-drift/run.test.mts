/**
 * run.test.mts — the exit-code contract (spec §6).
 *
 * The claim this whole tool rests on is that "could not check" and "checked,
 * found nothing" are DIFFERENT STATES. These tests are the only thing standing
 * between that claim and a source outage silently scoring as a pass.
 *
 * `fetch` is stubbed rather than the network being blocked at the OS level:
 * Node's fetch ignores `https_proxy`, so a proxy-based probe succeeds normally
 * and proves nothing. (Confirmed the hard way, 2026-08-18.)
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PRICING_TABLE } from "../../packages/core/src/ledger/pricing.js";
import { MODEL_MAP } from "./model-map.mts";
import { EXPECTED_TIERS } from "./sources.mts";

const realFetch = globalThis.fetch;

async function runMain(stub: typeof globalThis.fetch): Promise<number> {
	globalThis.fetch = stub;
	// Import fresh each time so the module picks up the current stub.
	const { main } = await import("./run.mts");
	return main([]);
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("exit-code contract", () => {
	it("returns 2 when a source is unreachable — never 0", async () => {
		const code = await runMain((async () => {
			throw new Error("ENETDOWN (simulated)");
		}) as typeof globalThis.fetch);

		assert.equal(code, 2, "a dead network must not score as a clean table");
		assert.notEqual(code, 0);
	});

	it("returns 2 on an HTTP error response", async () => {
		const code = await runMain(
			(async () =>
				new Response("nope", {
					status: 500,
					statusText: "Server Error",
				})) as typeof globalThis.fetch,
		);

		assert.equal(code, 2);
	});

	it("returns 2 when a source returns valid JSON of the wrong shape", async () => {
		// A schema change is "could not check", not "checked and found nothing".
		const code = await runMain(
			(async () =>
				new Response('"a bare string"', {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof globalThis.fetch,
		);

		assert.equal(code, 2);
	});
});

// ── the process-level contract the workflow actually consumes ─────────────
//
// Everything in compare.test.mts drives `compareTable` and reads its return
// value. The workflow reads a PROCESS EXIT CODE. Nothing connected the two:
// `main()` could produce a non-empty failed report and still return 0, and
// every other test would pass while the weekly run accepted that zero and
// CLOSED a valid drift issue.
//
// The first version of this test fed `{}` to both sources — which trips the
// SCHEMA SENTINEL and returns 2 from an early path, never reaching the
// `failed ? 1 : 0` line it was written to protect. Forcing that line to
// `return 0` left it passing. A test named for one guard reaching another is
// the defect this whole file exists to catch, so the fixtures below are built
// from the real map and table: every mapped row present and valid, so the run
// gets all the way to the comparison.

/** A complete, valid corpus for both sources, derived from the shipped map. */
function fullCorpus(perturb?: (model: string, rates: { input: number; output: number }) => void) {
	const litellm: Record<string, Record<string, unknown>> = {};
	const modelsDev: Record<string, { models: Record<string, unknown> }> = {};

	for (const [model, entry] of Object.entries(MODEL_MAP)) {
		const ours = PRICING_TABLE[model];
		if (!ours) continue;
		// usertokens per 1k -> $/MTok is a divide by 10; LiteLLM is per TOKEN.
		const rates = { input: ours.inputPer1k / 10, output: ours.outputPer1k / 10 };
		// claude-sonnet-5 genuinely deviates upstream (the introductory rate the
		// table deliberately does not carry). A corpus where it AGREES makes its
		// allowlist entry stale, which is a real failure — so the baseline
		// fixture has to reproduce the deviation, not flatten it.
		if (model === "claude-sonnet-5") {
			rates.input = rates.input * (2 / 3);
			rates.output = rates.output * (2 / 3);
		}
		perturb?.(model, rates);

		if (entry.litellm) {
			litellm[entry.litellm.key] = {
				litellm_provider: entry.litellm.provider,
				input_cost_per_token: rates.input / 1e6,
				output_cost_per_token: rates.output / 1e6,
				...(EXPECTED_TIERS.has(`litellm:${model}:cacheRead`)
					? { cache_read_input_token_cost: (ours.cacheReadPer1k ?? 0) / 10 / 1e6 }
					: {}),
				...(EXPECTED_TIERS.has(`litellm:${model}:cacheWrite`)
					? { cache_creation_input_token_cost: (ours.cacheWritePer1k ?? 0) / 10 / 1e6 }
					: {}),
			};
		}
		if (entry.modelsDev) {
			const p: { models: Record<string, unknown> } = modelsDev[entry.modelsDev.provider] ?? {
				models: {},
			};
			modelsDev[entry.modelsDev.provider] = p;
			p.models[entry.modelsDev.id] = {
				cost: {
					input: rates.input,
					output: rates.output,
					...(EXPECTED_TIERS.has(`models.dev:${model}:cacheRead`)
						? { cache_read: (ours.cacheReadPer1k ?? 0) / 10 }
						: {}),
					...(EXPECTED_TIERS.has(`models.dev:${model}:cacheWrite`)
						? { cache_write: (ours.cacheWritePer1k ?? 0) / 10 }
						: {}),
				},
			};
		}
	}
	return { litellm, modelsDev };
}

async function runMainWith(litellm: unknown, modelsDev: unknown): Promise<number> {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const body = String(input).includes("models.dev") ? modelsDev : litellm;
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof globalThis.fetch;
	const { main } = await import("./run.mts");
	return main([]);
}

describe("drift-to-exit-code wiring", () => {
	it("returns 0 for a corpus that agrees with the table — negative control", async () => {
		const { litellm, modelsDev } = fullCorpus();
		assert.equal(await runMainWith(litellm, modelsDev), 0);
	});

	it("returns 1 when a rate drifts — the code the workflow actually reads", async () => {
		// Halve one model's input rate upstream: our table is then ABOVE it, an
		// unallowlisted disagreement. Reaches `failed ? 1 : 0`, which is the line
		// the workflow's entire alerting contract rests on.
		const { litellm, modelsDev } = fullCorpus((model, rates) => {
			if (model === "claude-opus-5") rates.input = rates.input / 2;
		});
		assert.equal(await runMainWith(litellm, modelsDev), 1);
	});
});
