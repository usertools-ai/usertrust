// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Renderers for the weekly report model: Markdown, self-contained HTML, JSON.
 *
 * Every string that came from the chain (model, cost center, agent, ids) is untrusted text: it goes through the
 * repo's existing terminal scrubber FIRST (so a file that is later `cat`-ed cannot repaint the reader's terminal),
 * and through an HTML escape for the HTML form. Neither is a new sanitizer copy: `scrubForTerminal` is the one in
 * `cli/target.ts`.
 */

import { scrubForTerminal, toSafeJson } from "../cli/target.js";
import { type ModelRow, type ReportModel, type Row, UT_TO_USD } from "./weekly.js";

export type ReportFormat = "md" | "html" | "json";

function usd(ut: number): string {
	return `$${(ut * UT_TO_USD).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function utStr(ut: number): string {
	return `${Math.round(ut).toLocaleString("en-US")} UT`;
}

function pct(f: number): string {
	return `${(f * 100).toFixed(1)}%`;
}

function tokens(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

const clean = (s: string): string => scrubForTerminal(s);

function mdCell(s: string): string {
	return clean(s).replace(/\|/g, "\\|");
}

function esc(s: string): string {
	return clean(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * The integrity verdict. Its errors and first/last event ids come from a vault that may be hostile, so the WHOLE line is
 * scrubbed here, at the source of both renderers: a control sequence in an event id must not reach the reader's terminal
 * and erase the UNVERIFIED warning it sits beside.
 */
function verdictLine(m: ReportModel): string {
	if (m.integrity.verified) {
		return clean(
			`Audit chain VERIFIED: ${m.integrity.chainLength} event(s), ${m.integrity.firstEvent ?? "?"} to ${m.integrity.lastEvent ?? "?"}.`,
		);
	}
	return clean(
		`Audit chain UNVERIFIED: ${m.integrity.errors.length} problem(s). ${m.integrity.errors.slice(0, 3).join(" | ")}`,
	);
}

function budgetLines(m: ReportModel): string[] {
	const b = m.budget;
	if (b.configuredUt === null)
		return ["No budget is configured for this report (none in the vault config; pass --budget)."];
	const lines = [
		`Configured budget ${utStr(b.configuredUt)} (${usd(b.configuredUt)}), source: ${clean(b.source ?? "unknown")}. Session-wallet spend recorded in the chain (model calls and governed actions, not attributed to a cost-center envelope): ${utStr(b.recordedSessionUt)} (${usd(b.recordedSessionUt)}), ${pct(b.usedFraction ?? 0)} used${b.overBudget ? " (OVER BUDGET)" : ""}. This week: ${usd(b.windowSessionUt)}.`,
	];
	if (b.recordedEnvelopeUt > 0) {
		lines.push(
			`Spend attributed to cost-center envelopes is NOT charged to this budget: ${usd(b.recordedEnvelopeUt)} recorded, ${usd(b.windowEnvelopeUt)} this week.`,
		);
	}
	lines.push("This is the configured budget against recorded spend, not the live ledger balance.");
	return lines;
}

/** What this report is not, printed with every rendering. */
export const NOT_CLAIMED: readonly string[] = [
	"Only calls that went through usertrust are in this report. Agents or calls that were not metered are not counted and not estimated.",
	"Dollars are API-equivalent at the rates recorded on each call (usertoken = $0.0001), not an invoice.",
	"Denied or blocked calls moved no money and carry no dollar figure. Nothing here claims money was saved or prevented.",
	"Cache-write cost is shown as a cost driver, not as avoidable spend.",
	"Budget status compares the vault's configured budget with spend recorded in the chain. It is not the live ledger balance.",
];

function rowsTable(title: string, rows: readonly Row[], keyHeader: string): string[] {
	if (rows.length === 0) return [`### ${title}`, "", "_No confirmed spend in this window._", ""];
	return [
		`### ${title}`,
		"",
		`| ${keyHeader} | Calls | Spend | Share |`,
		"|---|---:|---:|---:|",
		...rows.map((r) => `| ${mdCell(r.key)} | ${r.calls} | ${usd(r.ut)} | ${pct(r.share)} |`),
		"",
	];
}

function modelsTable(rows: readonly ModelRow[]): string[] {
	if (rows.length === 0) return ["### By model", "", "_No confirmed spend in this window._", ""];
	return [
		"### By model",
		"",
		"| Model | Provider | Calls | Spend | Share | Rate basis |",
		"|---|---|---:|---:|---:|---|",
		...rows.map(
			(r) =>
				`| ${mdCell(r.key)} | ${r.provider} | ${r.calls} | ${usd(r.ut)} | ${pct(r.share)} | ${mdCell(r.costBasis.join(", "))} |`,
		),
		"",
	];
}

export function renderMarkdown(m: ReportModel): string {
	const t = m.totals;
	const out: string[] = [];
	if (!m.integrity.verified) {
		out.push("# UNVERIFIED: this report is computed from a chain that did not verify", "");
	}
	out.push(
		`# usertrust weekly spend report`,
		"",
		`Window: ${m.window.startIso} to ${m.window.endIso} (${m.window.days} days, end exclusive)`,
		"",
		`**${verdictLine(m)}**`,
		"",
		"## Headline",
		"",
		`- **Confirmed spend:** ${usd(t.confirmedUt)} (${utStr(t.confirmedUt)}) across ${t.confirmedCalls} call(s)`,
		`- **Unconfirmed:** ${usd(t.unconfirmedUt)} across ${t.unconfirmedCalls} call(s) with an ambiguous or unsettled settlement (not counted as spent)`,
	);
	if (t.estimatedCalls > 0) {
		out.push(
			`- **Of which priced from an estimate:** ${usd(t.estimatedUt)} across ${t.estimatedCalls} call(s) (no provider-reported usage)`,
		);
	}
	if (t.actionCalls > 0) {
		out.push(
			`- **Governed actions (non-model):** ${usd(t.actionUt)} across ${t.actionCalls} action(s), reported separately`,
		);
	}
	if (m.shortfall.events > 0) {
		out.push(
			`- **Posted below metered:** ${m.shortfall.events} settlement(s) metered ${utStr(m.shortfall.ut)} more than the ledger could post (settlement_shortfall)`,
		);
	}
	out.push("");

	out.push("## Budget status", "");
	out.push(...budgetLines(m).map((l) => `${l}\n`), "");

	out.push(...rowsTable("Spend by agent", m.byAgent, "Agent"));
	out.push(
		`_Agent key: ${m.agentKey.requested}${m.agentKey.segment !== null ? `, cost-center segment ${m.agentKey.segment}` : ""}. Calls with no attribution are one "(unattributed)" row._`,
		"",
	);
	if (m.bySession.length > 0)
		out.push(...rowsTable("Spend by session / origin", m.bySession, "Origin"));
	out.push(...modelsTable(m.byModel));

	out.push("### Cost drivers: tokens by tier", "");
	const k = m.tiers;
	if (k.calls === 0) {
		out.push("_No provider-reported usage in this window._", "");
	} else {
		out.push(
			"| Tier | Tokens | Cost |",
			"|---|---:|---:|",
			`| Input | ${tokens(k.inputTokens)} | ${usd(k.inputUt)} |`,
			`| Output | ${tokens(k.outputTokens)} | ${usd(k.outputUt)} |`,
			`| Cache read | ${tokens(k.cacheReadTokens)} | ${usd(k.cacheReadUt)} |`,
			`| Cache write (5 min) | ${tokens(k.cacheWriteTokens - k.cacheWrite1hTokens)} | ${usd(k.cacheWriteUt - k.cacheWrite1hUt)} |`,
			`| Cache write (1 hour) | ${tokens(k.cacheWrite1hTokens)} | ${usd(k.cacheWrite1hUt)} |`,
			"",
			`Cache write is ${k.cacheWriteShare === null ? "n/a" : pct(k.cacheWriteShare)} of provider-reported cost. It is a cost driver, not avoidable spend. Tier costs are tokens times the rates applied on each call; per-call rounding makes them differ from the metered ${usd(k.costUt)} by ${utStr(k.roundingUt)}.`,
			"",
		);
	}

	out.push("### Top costs", "");
	if (m.topCosts.length === 0) out.push("_None._", "");
	else {
		out.push(
			"| Spend | When (UTC) | Model | Agent | Transfer | Chain hash |",
			"|---:|---|---|---|---|---|",
			...m.topCosts.map(
				(c) =>
					`| ${usd(c.ut)} | ${mdCell(c.timestamp)} | ${mdCell(c.model)} | ${mdCell(c.agent)} | ${mdCell(c.transferId)} | \`${mdCell(c.hash.slice(0, 16))}\` |`,
			),
			"",
			"_The chain hash locates the exact event for `usertrust-verify`._",
			"",
		);
	}

	out.push("### Governance activity (counts only)", "");
	out.push(
		"| Event | Count |",
		"|---|---:|",
		...Object.entries(m.governance).map(([kind, n]) => `| ${kind} | ${n} |`),
		"",
	);

	out.push("## Notes", "");
	if (m.notes.length === 0) out.push("None.", "");
	else out.push(...m.notes.map((n) => `- ${mdCell(n)}`), "");
	out.push("## What this report does not claim", "", ...NOT_CLAIMED.map((n) => `- ${n}`), "");
	return `${out.join("\n")}\n`;
}

export function renderJson(m: ReportModel): string {
	return `${toSafeJson(m)}\n`;
}

function barsSvg(values: readonly number[]): string {
	const max = Math.max(1, ...values);
	const w = 4;
	const h = 80;
	const bars = values
		.map((v, i) => {
			const bh = Math.round((v / max) * h);
			return `<rect x="${i * w}" y="${h - bh}" width="${w - 1}" height="${bh}" fill="var(--bar)"/>`;
		})
		.join("");
	return `<svg role="img" aria-label="Confirmed spend per hour" viewBox="0 0 ${values.length * w} ${h}" preserveAspectRatio="none" style="width:100%;height:96px">${bars}</svg>`;
}

function htmlRows(title: string, keyHeader: string, rows: readonly Row[]): string {
	if (rows.length === 0)
		return `<h3>${esc(title)}</h3><p class="muted">No confirmed spend in this window.</p>`;
	return `<h3>${esc(title)}</h3><table><thead><tr><th>${esc(keyHeader)}</th><th class="n">Calls</th><th class="n">Spend</th><th class="n">Share</th></tr></thead><tbody>${rows
		.map(
			(r) =>
				`<tr><td>${esc(r.key)}</td><td class="n">${r.calls}</td><td class="n">${usd(r.ut)}</td><td class="n">${pct(r.share)}</td></tr>`,
		)
		.join("")}</tbody></table>`;
}

export function renderHtml(m: ReportModel): string {
	const t = m.totals;
	const unverified = !m.integrity.verified;
	const k = m.tiers;
	const body: string[] = [];
	if (unverified) {
		body.push(
			`<div class="banner" role="alert">UNVERIFIED: this report is computed from an audit chain that did not verify. Do not rely on any figure.</div>`,
		);
	}
	body.push(
		`<header><p class="muted">usertrust</p><h1>Weekly spend report</h1><p class="muted">${esc(m.window.startIso)} to ${esc(m.window.endIso)} (${m.window.days} days, end exclusive)</p><p class="${unverified ? "bad" : "ok"}"><strong>${esc(verdictLine(m))}</strong></p></header>`,
		`<section class="headline"><div><span class="big">${usd(t.confirmedUt)}</span><span class="muted">confirmed spend, ${t.confirmedCalls} call(s)</span></div><div><span class="big">${usd(t.unconfirmedUt)}</span><span class="muted">unconfirmed (ambiguous or unsettled), ${t.unconfirmedCalls} call(s)</span></div>${
			t.estimatedCalls > 0
				? `<div><span class="big">${usd(t.estimatedUt)}</span><span class="muted">of confirmed spend priced from an estimate</span></div>`
				: ""
		}${
			t.actionCalls > 0
				? `<div><span class="big">${usd(t.actionUt)}</span><span class="muted">governed actions, reported separately</span></div>`
				: ""
		}${
			m.shortfall.events > 0
				? `<div><span class="big">${usd(m.shortfall.ut)}</span><span class="muted">metered above what the ledger could post, ${m.shortfall.events} settlement(s) (settlement_shortfall)</span></div>`
				: ""
		}</section>`,
		`<h2>Spend per hour</h2>${barsSvg(m.hourlyUt)}`,
	);
	body.push(`<h2>Budget status</h2>`);
	body.push(...budgetLines(m).map((l) => `<p>${esc(l)}</p>`));
	body.push(htmlRows("Spend by agent", "Agent", m.byAgent));
	body.push(
		`<p class="muted">Agent key: ${esc(m.agentKey.requested)}${m.agentKey.segment !== null ? `, cost-center segment ${m.agentKey.segment}` : ""}. Calls with no attribution are one "(unattributed)" row.</p>`,
	);
	if (m.bySession.length > 0)
		body.push(htmlRows("Spend by session / origin", "Origin", m.bySession));
	body.push(
		m.byModel.length === 0
			? `<h3>By model</h3><p class="muted">No confirmed spend in this window.</p>`
			: `<h3>By model</h3><table><thead><tr><th>Model</th><th>Provider</th><th class="n">Calls</th><th class="n">Spend</th><th class="n">Share</th><th>Rate basis</th></tr></thead><tbody>${m.byModel
					.map(
						(r) =>
							`<tr><td>${esc(r.key)}</td><td>${esc(r.provider)}</td><td class="n">${r.calls}</td><td class="n">${usd(r.ut)}</td><td class="n">${pct(r.share)}</td><td>${esc(r.costBasis.join(", "))}</td></tr>`,
					)
					.join("")}</tbody></table>`,
	);
	body.push(`<h3>Cost drivers: tokens by tier</h3>`);
	if (k.calls === 0) body.push(`<p class="muted">No provider-reported usage in this window.</p>`);
	else {
		body.push(
			`<table><thead><tr><th>Tier</th><th class="n">Tokens</th><th class="n">Cost</th></tr></thead><tbody><tr><td>Input</td><td class="n">${tokens(k.inputTokens)}</td><td class="n">${usd(k.inputUt)}</td></tr><tr><td>Output</td><td class="n">${tokens(k.outputTokens)}</td><td class="n">${usd(k.outputUt)}</td></tr><tr><td>Cache read</td><td class="n">${tokens(k.cacheReadTokens)}</td><td class="n">${usd(k.cacheReadUt)}</td></tr><tr><td>Cache write (5 min)</td><td class="n">${tokens(k.cacheWriteTokens - k.cacheWrite1hTokens)}</td><td class="n">${usd(k.cacheWriteUt - k.cacheWrite1hUt)}</td></tr><tr><td>Cache write (1 hour)</td><td class="n">${tokens(k.cacheWrite1hTokens)}</td><td class="n">${usd(k.cacheWrite1hUt)}</td></tr></tbody></table><p class="muted">Cache write is ${k.cacheWriteShare === null ? "n/a" : pct(k.cacheWriteShare)} of provider-reported cost: a cost driver, not avoidable spend. Tier costs are tokens times the rates applied on each call; per-call rounding makes them differ from the metered ${usd(k.costUt)} by ${utStr(k.roundingUt)}.</p>`,
		);
	}
	body.push(`<h3>Top costs</h3>`);
	if (m.topCosts.length === 0) body.push(`<p class="muted">None.</p>`);
	else {
		body.push(
			`<table><thead><tr><th class="n">Spend</th><th>When (UTC)</th><th>Model</th><th>Agent</th><th>Transfer</th><th>Chain hash</th></tr></thead><tbody>${m.topCosts
				.map(
					(c) =>
						`<tr><td class="n">${usd(c.ut)}</td><td>${esc(c.timestamp)}</td><td>${esc(c.model)}</td><td>${esc(c.agent)}</td><td>${esc(c.transferId)}</td><td><code>${esc(c.hash.slice(0, 16))}</code></td></tr>`,
				)
				.join("")}</tbody></table>`,
		);
	}
	body.push(
		`<h3>Governance activity (counts only)</h3><table><tbody>${Object.entries(m.governance)
			.map(([kind, n]) => `<tr><td>${esc(kind)}</td><td class="n">${n}</td></tr>`)
			.join("")}</tbody></table>`,
		`<h2>Notes</h2>${m.notes.length === 0 ? "<p>None.</p>" : `<ul>${m.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`}`,
		`<h2>What this report does not claim</h2><ul>${NOT_CLAIMED.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`,
	);

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>usertrust weekly spend report</title>
<style>
:root{--bg:#fff;--fg:#14171a;--muted:#5b6670;--line:#dfe3e6;--bar:#4a5fd0;--ok:#157f3b;--bad:#b3261e}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#101316;--fg:#e8ebed;--muted:#9aa5ad;--line:#2a3036;--bar:#8da0ff;--ok:#5fd68a;--bad:#ff8a80}}
:root[data-theme="dark"]{--bg:#101316;--fg:#e8ebed;--muted:#9aa5ad;--line:#2a3036;--bar:#8da0ff;--ok:#5fd68a;--bad:#ff8a80}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:880px;margin-inline:auto}
h1{font-size:28px;margin:4px 0}h2{margin-top:32px;font-size:20px}h3{margin-top:24px;font-size:16px}
.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}
.banner{background:var(--bad);color:#fff;padding:12px 16px;border-radius:6px;font-weight:600;margin-bottom:16px}
.headline{display:flex;flex-wrap:wrap;gap:24px;margin:16px 0}.headline>div{display:flex;flex-direction:column;min-width:200px}
.big{font-size:30px;font-weight:700}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th.n,td.n{text-align:right;font-variant-numeric:tabular-nums}code{font-size:12px}
@media print{body{max-width:none}}
</style></head><body>
${body.join("\n")}
</body></html>
`;
}

export function render(m: ReportModel, format: ReportFormat): string {
	return format === "json" ? renderJson(m) : format === "html" ? renderHtml(m) : renderMarkdown(m);
}
