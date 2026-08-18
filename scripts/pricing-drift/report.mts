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
import { isFailing } from "./compare.mts";

const HEADINGS: Record<Exclude<Outcome, "agree">, string> = {
	understated: "Understated — our rate is BELOW upstream (never allowlistable)",
	disagree: "Disagrees with upstream, not allowlisted",
	"deviation-stale": "Stale allowlist entry — upstream now agrees, remove the exemption",
	unmapped: "In PRICING_TABLE but absent from MODEL_MAP — provenance undecided",
	"source-conflict": "Sources contradict each other — no value proposed",
	"deviation-expected": "Expected deviation (ours is higher — conservative, allowed)",
	uncorroborated: "No upstream source — shipped without any external check",
};

/** Order matters: failing outcomes first, so the issue opens on what to fix. */
const SECTION_ORDER: Exclude<Outcome, "agree">[] = [
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
		.map(
			(d) =>
				`\`${d.tier}\` ours **${d.ours === null ? "not published" : d.ours}** vs **${d.upstream}**`,
		)
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
		"",
		`Coverage: **${corroborated}/${expectedCorroborated}** models the map claims a source for were ` +
			"actually answered.",
		"",
	];

	if (corroborated < expectedCorroborated) {
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
	const { counts, corroborated, expectedCorroborated } = report;
	return [
		`agree=${counts.agree}`,
		`deviation=${counts["deviation-expected"]}`,
		`conflict=${counts["source-conflict"]}`,
		`uncorroborated=${counts.uncorroborated}`,
		`understated=${counts.understated}`,
		`disagree=${counts.disagree}`,
		`stale=${counts["deviation-stale"]}`,
		`unmapped=${counts.unmapped}`,
		`coverage=${corroborated}/${expectedCorroborated}`,
	].join(" ");
}
