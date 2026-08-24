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

/** Short labels for the summary table. Total Record: a new outcome cannot omit one. */
const SUMMARY_LABELS: Record<Exclude<Outcome, "agree">, string> = {
	understated: "Understated",
	disagree: "Disagreed",
	"deviation-stale": "Stale allowlist",
	unmapped: "Unmapped",
	"malformed-rate": "Malformed rate",
	"source-conflict": "Sources conflict",
	"deviation-expected": "Expected deviation (ours higher)",
	uncorroborated: "No upstream source",
};

/**
 * Order matters: failing outcomes first, so the issue opens on what to fix.
 *
 * EXHAUSTIVENESS IS COMPILE-ENFORCED (see `_sectionOrderIsExhaustive` below).
 * `HEADINGS` is a total Record, so a new outcome cannot be added without a
 * heading — but this ARRAY is what drives rendering, and an array omission
 * compiles cleanly and silently drops the outcome from every report. A new
 * failing outcome would then be counted, would fail the run, and would appear
 * nowhere in the issue explaining why. Exhaustiveness that depends on
 * remembering is a failure rate, not a guarantee.
 */
const SECTION_ORDER = [
	"malformed-rate",
	"understated",
	"disagree",
	"deviation-stale",
	"unmapped",
	"source-conflict",
	"deviation-expected",
	"uncorroborated",
] as const satisfies readonly Exclude<Outcome, "agree">[];

/**
 * Compile-time proof that SECTION_ORDER covers every non-`agree` outcome.
 * Omit one and this stops type-checking, naming the missing member.
 *
 * `as const` above is LOAD-BEARING. With the array annotated
 * `Exclude<Outcome, "agree">[]` instead, `(typeof SECTION_ORDER)[number]` is
 * the DECLARED element type — every outcome — so `_Uncovered` is `never`
 * whatever the array actually contains, and this check passes vacuously. It
 * did exactly that when first written, and only a mutation (deleting a member
 * and confirming the build breaks) revealed it. A guard is not verified by
 * being present.
 */
type _AssertNever<T extends never> = T;
type _Uncovered = Exclude<Exclude<Outcome, "agree">, (typeof SECTION_ORDER)[number]>;
// `_AssertNever`, not `const x: _Uncovered[] = []`. That form is ALSO vacuous:
// an empty array is assignable to `T[]` for every T, so it passes whatever
// `_Uncovered` resolves to. Two plausible-looking versions of this guard were
// dead before this one — both caught by deleting a member and checking that
// the build actually breaks, neither by reading the code.
export type _SectionOrderIsExhaustive = _AssertNever<_Uncovered>;

function renderTiers(f: ModelFinding): string {
	if (f.diffs.length === 0) return "—";
	return f.diffs
		.map((d) => {
			// Print the EFFECTIVE rate whenever it differs from the raw field.
			// A negative cache entry is preserved by `rawTier` but replaced with
			// `inputPer1k` by the canonical resolver, so `cacheReadPer1k: -5`
			// against sources at 5–10 would read "ours -5" while classification
			// and metering both used 50 — a report contradicting its own heading
			// on the one number that represents money.
			const ours =
				d.ours === null
					? `not published (meters at ${d.effective})`
					: d.ours === d.effective
						? String(d.ours)
						: `${d.ours} (meters at ${d.effective})`;
			// Show the RANGE when the sources disagree. Printing only the minimum
			// would describe a rate sitting between two sources as if one of them
			// did not exist.
			const up = d.upstream === d.upstreamMax ? `${d.upstream}` : `${d.upstream}–${d.upstreamMax}`;
			// Attribute to the sources that publish THIS tier, not to every source
			// that answered for the model — otherwise a cache-tier difference is
			// credited to a source that never stated a cache rate.
			const by = d.publishedBy.length > 0 ? ` per ${d.publishedBy.join(" + ")}` : "";
			return `\`${d.tier}\` ours **${ours}** vs **${up}**${by}`;
		})
		.join("; ");
}

function renderSection(outcome: Exclude<Outcome, "agree">, findings: ModelFinding[]): string {
	const rows = findings.filter((f) => f.outcome === outcome);
	if (rows.length === 0) return "";

	const marker = isFailing(outcome) ? "❌" : "ℹ️";
	const lines = [`### ${marker} ${HEADINGS[outcome]} (${rows.length})`, ""];

	for (const f of rows) {
		// Model-level: which sources answered at all. Per-tier attribution is
		// rendered inside renderTiers, where the distinction actually matters.
		// Report EVIDENCE TIERS, not a source count. Two catalogs agreeing is one
		// upstream fact with two mirrors; printing "2 sources" invites a reader to
		// treat it as independent confirmation, which is what nearly shipped a
		// 50% overcharge on gpt-5.6-sol.
		const srcs =
			f.sources.length > 0
				? ` _(${f.sources.join(", ")} — ${f.evidence} evidence tier${f.evidence === 1 ? "" : "s"})_`
				: "";
		lines.push(`- **\`${f.model}\`** — ${renderTiers(f)}${srcs}`);
		if (f.note !== undefined) lines.push(`  - ${f.note}`);
		if (f.cacheGaps.length > 0) {
			lines.push(
				`  - upstream also publishes ${f.cacheGaps
					.map((g) => `\`${g.tier}\` (per ${g.publishedBy.join(" + ")})`)
					.join(", ")} which our table omits ` +
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
		// DERIVED from SECTION_ORDER, which is itself compile-checked for
		// exhaustiveness. Hand-listing these rows meant a new outcome could be
		// counted, could fail the run, and could still appear in no table and no
		// section — present in the verdict, absent from the report explaining it.
		`| Agreed with upstream | ${counts.agree} |`,
		...SECTION_ORDER.map((o) => {
			const label = SUMMARY_LABELS[o];
			return isFailing(o) ? `| **${label}** | **${counts[o]}** |` : `| ${label} | ${counts[o]} |`;
		}),
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
			...gaps.map((f) => {
				// Per-gap publishers, not the model's answering sources: when both
				// sources answer input/output but only one publishes the omitted
				// tier, listing both credits it to a source that never stated it.
				const parts = f.cacheGaps.map((g) => `\`${g.tier}\` per ${g.publishedBy.join(" + ")}`);
				return `- **\`${f.model}\`** — ${parts.join("; ")}`;
			}),
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
