/**
 * run.mts — entry point. Fetch, compare, report, exit.
 *
 * EXIT CODES ARE THE CONTRACT (spec §6):
 *   0  every corroborated model agrees or deviates conservatively, floor met
 *   1  drift, understatement, stale/orphan allowlist, unmapped model, or the
 *      coverage floor was breached
 *   2  a source was unreachable or its schema no longer matches — THE CHECK DID
 *      NOT HAPPEN
 *
 * `2` is never collapsed into `0`. "Could not check" and "checked, found
 * nothing" are different states, and a tool that conflates them reports success
 * for work it never did. A watchdog that exits 0 on a path where it checked
 * nothing reads as healthy through consecutive total failures — the outage and
 * the all-clear become indistinguishable.
 *
 * Usage:
 *   node --import tsx scripts/pricing-drift/run.mts [--json] [--out <file>]
 */

import { writeFileSync } from "node:fs";
import { PRICING_TABLE, PRICING_TABLE_VERSION } from "../../packages/core/src/ledger/pricing.js";
import { compareTable, orphanDeviations } from "./compare.mts";
import { EXPECTED_DEVIATIONS, MODEL_MAP } from "./model-map.mts";
import { renderReport, renderSummary } from "./report.mts";
import {
	assertLiteLLMSchema,
	assertModelsDevSchema,
	fetchJson,
	LITELLM_URL,
	MODELS_DEV_URL,
	normalizeLiteLLM,
	normalizeModelsDev,
	SourceError,
} from "./sources.mts";

const SOURCE_URLS = { litellm: LITELLM_URL, "models.dev": MODELS_DEV_URL };

export async function main(argv: string[]): Promise<number> {
	const outIdx = argv.indexOf("--out");
	const outFile = outIdx >= 0 ? argv[outIdx + 1] : undefined;
	const asJson = argv.includes("--json");

	let litellmRaw: unknown;
	let modelsDevRaw: unknown;
	try {
		[litellmRaw, modelsDevRaw] = await Promise.all([
			fetchJson(LITELLM_URL),
			fetchJson(MODELS_DEV_URL),
		]);
	} catch (err) {
		// Exit 2, not 1 and never 0: this is "could not check".
		process.stderr.write(
			`pricing-drift: SOURCE UNAVAILABLE — the check did not run.\n  ${
				err instanceof Error ? err.message : String(err)
			}\n`,
		);
		return 2;
	}

	let sources: Record<string, Record<string, ReturnType<typeof normalizeLiteLLM>[string]>>;
	try {
		// Schema sentinels FIRST. A renamed optional field (say
		// `cache_creation_input_token_cost`) would otherwise leave input/output
		// resolving normally — every row still answered, coverage still full — and
		// the run would exit 0 with cache comparison silently disabled. That is the
		// exact failure this tool exists to catch, so it must not be able to happen
		// TO this tool.
		assertLiteLLMSchema(litellmRaw);
		assertModelsDevSchema(modelsDevRaw);
		sources = {
			litellm: normalizeLiteLLM(litellmRaw, MODEL_MAP),
			"models.dev": normalizeModelsDev(modelsDevRaw, MODEL_MAP),
		};
	} catch (err) {
		if (err instanceof SourceError) {
			process.stderr.write(
				`pricing-drift: SCHEMA MISMATCH — the check did not run.\n  ${err.message}\n`,
			);
			return 2;
		}
		throw err;
	}

	const report = compareTable({
		table: PRICING_TABLE,
		map: MODEL_MAP,
		deviations: EXPECTED_DEVIATIONS,
		sources,
	});
	const orphans = orphanDeviations(PRICING_TABLE, EXPECTED_DEVIATIONS);

	const markdown = renderReport(report, {
		tableVersion: PRICING_TABLE_VERSION,
		fetchedAt: new Date().toISOString(),
		sourceUrls: SOURCE_URLS,
		orphanDeviations: orphans,
	});

	if (outFile !== undefined) writeFileSync(outFile, markdown, "utf-8");
	process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${markdown}\n`);
	process.stderr.write(`pricing-drift: ${renderSummary(report)}\n`);

	return report.failed || orphans.length > 0 ? 1 : 0;
}

// Only self-execute when run directly, so the tests can import `main`.
if (process.argv[1]?.endsWith("run.mts") === true) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			// An unexpected throw is "could not check", not "nothing found".
			process.stderr.write(`pricing-drift: UNEXPECTED FAILURE — ${String(err)}\n`);
			process.exit(2);
		});
}
