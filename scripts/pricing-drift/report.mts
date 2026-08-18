/**
 * report.mts — render a DriftReport as Markdown.
 *
 * The output is the GitHub issue body, so it must be readable by someone who
 * has never seen this tool. Every section states what the reader should DO.
 *
 * Only `agree` is omitted from the per-model sections — it is the one outcome
 * that carries no action. Its count still appears in the summary, because
 * "16 agreed" is the sentence that makes the other numbers mean something.
 */

import type { DriftReport, ModelFinding, Outcome } from "./compare.mts";
import { cacheGapFindings, isFailing } from "./compare.mts";

const HEADINGS: Record<Exclude<Outcome, "agree">, string> = {
	understated: "Understated — our rate is BELOW upstream (never allowlistable)",
	disagree: "Disagrees with upstream, not allowlisted",
	"deviation-stale": "Stale allowlist entry — upstream now agrees, remove the exemption",
	unmapped: "In PRICING_TABLE but absent from MODEL_MAP — provenance undecided",
	"malformed-rate": "Required rate is not a finite non-negative number in PRICING_TABLE",
	"source-conflict": "Sources contradict each other — no value proposed",
	"deviation-expected": "Expected deviation (ours is higher — conservative, allowed)",
	uncorroborated: "No upstream source — shipped without any external check",
};

/** Order matters: failing outcomes first, so the issue opens on what to fix. */
const SECTION_ORDER: Exclude<Outcome, "agree">[] = [
	"malformed-rate",
	"understated",
	"disagree",
	"deviation-stale",
	"unmapped",
	"source-conflict",
	"deviation-expected",
	"uncorroborated",
];

function renderTiers(f: ModelFinding): string {
	if (f.diffs.length === 0) return "—";
	return f.diffs
		.map((d) => {
			const ours = d.ours === null ? `not published (meters at ${d.effective})` : String(d.ours);
			// Show the RANGE when the sources disagree. Printing only the minimum
			// would describe a rate sitting between two sources as if one of them
			// did not exist.
			const up = d.upstream === d.upstreamMax ? `${d.upstream}` : `${d.upstream}–${d.upstreamMax}`;
			return `\`${d.tier}\` ours **${ours}** vs **${up}**`;
		})
		.join("; ");
}

function renderSection(outcome: Exclude<Outcome, "agree">, findings: ModelFinding[]): string {
	const rows = findings.filter((f) => f.outcome === outcome);
	if (rows.length === 0) return "";

	const marker = isFailing(outcome) ? "❌" : "ℹ️";
	const lines = [`### ${marker} ${HEADINGS[outcome]} (${rows.length})`, ""];

	for (const f of rows) {
		const srcs = f.sources.length > 0 ? ` _(${f.sources.join(", ")})_` : "";
		lines.push(`- **\`${f.model}\`** — ${renderTiers(f)}${srcs}`);
		if (f.note !== undefined) lines.push(`  - ${f.note}`);
		if (f.cacheGaps.length > 0) {
			lines.push(
				`  - upstream publishes \`${f.cacheGaps.join("`, `")}\` which our table omits ` +
					"(priced at `inputPer1k` via the D1 fallback — overstatement, not a defect)",
			);
		}
	}
	lines.push("");
	return lines.join("\n");
}

export interface ReportContext {
	tableVersion: string;
	fetchedAt: string;
	sourceUrls: Record<string, string>;
	orphanDeviations: string[];
}

export function renderReport(report: DriftReport, ctx: ReportContext): string {
	const { counts, corroborated, expectedCorroborated, exhaustive } = report;
	const total = Object.values(counts).reduce((a, b) => a + b, 0);

	const out: string[] = [
		"# Pricing table drift report",
		"",
		`\`PRICING_TABLE_VERSION\` = **${ctx.tableVersion}** · ${total} models · checked ${ctx.fetchedAt}`,
		"",
		"| Outcome | Count |",
		"| --- | --- |",
		`| Agreed with upstream | ${counts.agree} |`,
		`| Expected deviation (ours higher) | ${counts["deviation-expected"]} |`,
		`| Sources conflict | ${counts["source-conflict"]} |`,
		`| No upstream source | ${counts.uncorroborated} |`,
		`| **Understated** | **${counts.understated}** |`,
		`| **Disagreed** | **${counts.disagree}** |`,
		`| **Stale allowlist** | **${counts["deviation-stale"]}** |`,
		`| **Unmapped** | **${counts.unmapped}** |`,
		`| **Malformed rate** | **${counts["malformed-rate"]}** |`,
		"",
		`Coverage: **${report.mappings}/${report.expectedMappings}** source→model mappings answered ` +
			`(across **${corroborated}/${expectedCorroborated}** models). The gate is per-mapping: a model ` +
			"answered by one source when the map names two has lost an independent check.",
		"",
	];

	if (report.missingMappings.length > 0) {
		out.push(
			`> ❌ **Mappings that did not answer:** \`${report.missingMappings.join("`, `")}\` — ` +
				"the map names these sources for these models and they returned nothing. Counting alone " +
				"would not say WHICH independent check disappeared.",
			"",
		);
	}

	if (report.floors.breached) {
		out.push(
			`> ❌ **Absolute coverage floor breached.** ${report.mappings} mappings ` +
				`(floor ${report.floors.minMappings}) across ${corroborated} models ` +
				`(floor ${report.floors.minCorroboratedModels}). These floors are checked in rather than ` +
				"derived from `MODEL_MAP`, so this fires even when the map's own expectation is satisfied — " +
				"which is exactly the case where every model can read `agree` while coverage has shrunk.",
			"",
		);
	}

	if (report.mappings < report.expectedMappings || corroborated < expectedCorroborated) {
		out.push(
			"> ❌ **Coverage floor breached.** Fewer models were answered than the map expects. " +
				"This usually means a source changed its schema and matches are silently evaporating — " +
				"read this as *the check did not happen*, not as a clean result.",
			"",
		);
	}

	if (!exhaustive) {
		out.push(
			"> ❌ **Exhaustiveness check failed.** The outcome counts do not sum to the table size, " +
				"so some model was not assigned an outcome. The report below is incomplete.",
			"",
		);
	}

	if (ctx.orphanDeviations.length > 0) {
		out.push(
			`> ❌ **Orphaned allowlist entries:** \`${ctx.orphanDeviations.join("`, `")}\` — ` +
				"named in the deviation allowlist but absent from `PRICING_TABLE`.",
			"",
		);
	}

	for (const outcome of SECTION_ORDER) out.push(renderSection(outcome, report.findings));

	// Cache gaps are rendered from ALL findings, not from SECTION_ORDER. They
	// attach to `agree` models too, and `agree` has no section — so a model whose
	// input/output match while our cache field is omitted would otherwise produce
	// no row at all, silently contradicting "every gap is reported".
	const gaps = cacheGapFindings(report);
	if (gaps.length > 0) {
		out.push(
			`### ℹ️ Cache tiers upstream publishes that our table omits (${gaps.length})`,
			"",
			"These meter at `inputPer1k` through the D1 fallback, at or above the upstream rate — " +
				"overstatement, not a defect. A gap that metered BELOW upstream would appear under " +
				"*Understated* instead.",
			"",
			...gaps.map(
				(f) => `- **\`${f.model}\`** — \`${f.cacheGaps.join("`, `")}\` _(${f.sources.join(", ")})_`,
			),
			"",
		);
	}

	out.push(
		"---",
		"",
		"**Sources** (both MIT-licensed; rates ingested and republished with attribution):",
		"",
		...Object.entries(ctx.sourceUrls).map(([name, url]) => `- ${name}: ${url}`),
		"",
		"Rates are compared in usertokens per 1,000 tokens (1 usertoken = $0.0001), the unit " +
			"`PRICING_TABLE` itself uses. Upstream is converted on ingest; the table is never converted.",
		"",
		"This tool reports only — it does not edit `pricing.ts`, bump `PRICING_TABLE_VERSION`, or " +
			"commit. A human adjudicates every rate change.",
	);

	return out.join("\n");
}

/** Terse stdout summary. The Markdown above goes to the issue; this goes to the log. */
export function renderSummary(report: DriftReport): string {
	const { counts } = report;
	return [
		`agree=${counts.agree}`,
		`deviation=${counts["deviation-expected"]}`,
		`conflict=${counts["source-conflict"]}`,
		`uncorroborated=${counts.uncorroborated}`,
		`understated=${counts.understated}`,
		`disagree=${counts.disagree}`,
		`stale=${counts["deviation-stale"]}`,
		`unmapped=${counts.unmapped}`,
		`malformed=${counts["malformed-rate"]}`,
		`coverage=${report.mappings}/${report.expectedMappings} mappings`,
	].join(" ");
}
