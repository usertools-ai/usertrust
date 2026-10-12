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
import {
	type ModelRow,
	type NominalUt,
	type ReportModel,
	type Row,
	type UsdUt,
	UT_TO_USD,
	type WalletUt,
} from "./weekly.js";

export type ReportFormat = "md" | "html" | "json";

/** Dollars. Takes ONLY a dollar-denominated amount: a nominal-unit figure here is a compile error, not a review finding. */
/**
 * Appends every item WITHOUT spreading them into a call: `out.push(...items)` throws RangeError past ~120,000 arguments,
 * and a report with that many distinct agents or models must still render.
 */
function pushAll<T>(out: T[], items: readonly T[]): void {
	for (const item of items) out.push(item);
}

function usd(ut: UsdUt): string {
	return `$${(ut * UT_TO_USD).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Budget units: the session wallet the governors enforce (usd-priced and nominal together). Never dollars. */
function walletStr(ut: WalletUt): string {
	return `${Math.round(ut).toLocaleString("en-US")} budget units`;
}

/** A difference of two amounts in the SAME denomination (dollars). */
function usdMinus(a: UsdUt, b: UsdUt): UsdUt {
	return (a - b) as UsdUt;
}

/** Nominal units (a local endpoint): never dollars. */
function nominalStr(ut: NominalUt): string {
	return `${Math.round(ut).toLocaleString("en-US")} nominal units`;
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

/**
 * THE OUTPUT BOUNDARIES: every string that came from the vault (a model, an agent, a cost center, an id, a hash, an
 * integrity error, a cost basis) leaves this module through exactly one of these two functions, whichever field it is:
 *  - `md` for Markdown is an ALLOWLIST, not an escaper: only letters, digits, space and `. , : ; _ @ / + = -` survive;
 *    every other code point becomes `?` (which is not itself in the set, so a placeholder is never mistaken for input).
 *    Nothing that survives is Markdown or HTML syntax, so there is no escape to break out of: the earlier escape-based
 *    version was beaten twice (a `\|` the escaper doubled into `\\|`, closing the cell). The result is still wrapped in a
 *    code span so an `https://` value cannot autolink. The exact value is in the JSON report.
 *  - `esc` for HTML: control bytes scrubbed, then `& < > " '` escaped. The page has no remote resource of its own.
 */
export const MD_ALLOWED = /^[A-Za-z0-9 .,:;_@/+=-]*$/;
const MD_DISALLOWED = /[^A-Za-z0-9 .,:;_@/+=-]/gu;

const PROOF_NOTE =
	"Confirmed means no record contradicts the call; ledger-proven means a record written after the ledger post proves it. The SDK path's call records do not say whether the ledger post took place, so its spend is confirmed but not proven.";

export function md(s: string): string {
	const text = s.replace(MD_DISALLOWED, "?");
	return `\`${text === "" ? " " : text}\``;
}

export function esc(s: string): string {
	return clean(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * The integrity verdict, with every vault-derived piece (error text, first/last event id) passed through `v`, the
 * format's own boundary. A control sequence in an event id must not reach a terminal and erase the UNVERIFIED warning it
 * sits beside, and Markdown or HTML in it must not become live.
 */
function verdictLine(m: ReportModel, v: (s: string) => string): string {
	// The instant the claim is about: a verdict on an empty or busy vault must not read as a statement about the vault's
	// state after the run.
	const asRead =
		m.integrity.readAtIso !== undefined ? ` Chain as read at ${v(m.integrity.readAtIso)}.` : "";
	if (m.integrity.verified) {
		return `Audit chain VERIFIED: ${m.integrity.chainLength} event(s), ${v(m.integrity.firstEvent ?? "?")} to ${v(m.integrity.lastEvent ?? "?")}.${asRead}`;
	}
	return `Audit chain UNVERIFIED: ${m.integrity.errors.length} problem(s). ${m.integrity.errors
		.slice(0, 3)
		.map(v)
		.join(" | ")}${asRead}`;
}

/** The governor's counter against the chain's INTERVAL: rendered whether or not a budget is configured. */
function reconciliationLines(m: ReportModel): string[] {
	const b = m.budget;
	const led = m.spendLedger;
	const lower = b.recordedSessionWallet;
	const upper = (b.recordedSessionWallet +
		b.recordedSessionUncertain +
		b.recordedAttributedWallet +
		b.recordedAttributedUncertain) as WalletUt;
	const out: string[] = [];
	if (b.uncertainTransfers > 0) {
		out.push(
			`${b.uncertainTransfers} transfer(s) are UNCERTAIN: the chain does not say whether the governor's counter added them (${walletStr(b.recordedSessionUncertain)} session, ${walletStr(b.recordedAttributedUncertain)} attributed). They are in the upper bound only, never in the definite figure or the VERIFIED claim.`,
		);
	}
	if (led.unreadable) {
		out.push(
			"The governor's spend ledger (spend-ledger.json) exists but could not be read, so it could not be compared with the chain. It is a plain file the chain does not verify.",
		);
	} else if (led.differs && led.recorded !== null) {
		out.push(
			`DIFFERENCE: the governor's spend ledger (as recorded by the governor; not chain-verified) says ${tokens(led.recorded)} units, outside what the chain accounts for: ${walletStr(lower)} definite, up to ${walletStr(upper)} counting uncertain and cost-center spend. The chain and the governor's counter disagree: a crash between an SDK call's audit record and its budget commit, or a counter error. Either leg may be wrong.`,
		);
	}
	return out;
}

function budgetLines(m: ReportModel, v: (s: string) => string): string[] {
	const b = m.budget;
	if (b.unknown)
		return [
			b.unknownReason !== null
				? `Budget ${v(b.unknownReason)}. This is not 'no budget configured'.`
				: "Budget unknown (the vault config could not be read). This is not 'no budget configured': fix the read error and run the report again.",
			...reconciliationLines(m),
		];
	if (b.configuredUt === null)
		return [
			"No budget is configured for this report (none in the vault config; pass --budget).",
			...reconciliationLines(m),
		];
	const split = (usdPart: UsdUt, nominalPart: NominalUt): string =>
		`${usd(usdPart)} usd-priced + ${nominalStr(nominalPart)}`;
	const undenom = (amount: WalletUt): string =>
		amount > 0
			? ` + ${walletStr(amount)} of undenominated units (a settlement record with no call record)`
			: "";
	const undenominated = undenom(b.recordedSessionUndenominated);
	const lines = [
		`Configured budget ${utStr(b.configuredUt)} (budget units: usd-priced and nominal, as the governor enforces them), source: ${v(b.source ?? "unknown")}. Session-wallet debits the chain shows the governor counted (definite): ${walletStr(b.recordedSessionWallet)} = ${split(b.recordedSessionUt, b.recordedSessionNominal)}${undenominated}; ${pct(b.usedFraction ?? 0)} of the budget used${b.overBudget ? " (OVER BUDGET)" : b.overBudgetDisputed ? " (POSSIBLY OVER BUDGET: the chain and the governor's counter disagree, so no definite claim is made)" : ""}. This week: ${walletStr(b.windowSessionWallet)} = ${split(b.windowSessionUt, b.windowSessionNominal)}${undenom(b.windowSessionUndenominated)}.`,
	];
	if (
		b.recordedAttributedWallet > 0 ||
		b.recordedSessionUncertain > 0 ||
		b.recordedAttributedUncertain > 0
	) {
		lines.push(
			`Upper bound: ${pct(b.usedFractionUpper ?? 0)} of the budget used if the session also paid for the cost-center spend (ATTRIBUTED: its payer is not recorded, the cost-center envelope with a ledger or the session in a dry run; ${walletStr(b.recordedAttributedWallet)} = ${split(b.recordedAttributedUt, b.recordedAttributedNominal)}${undenom(b.recordedAttributedUndenominated)}) and every uncertain transfer was counted${b.possiblyOverBudget ? " (WOULD BE OVER BUDGET)" : ""}. "Over budget" is claimed only on the definite figure, and only when the governor's counter does not contradict it.`,
		);
	}
	lines.push(...reconciliationLines(m));
	lines.push(
		"Session-wallet debits mirror what the governor's own counter adds: a call or action once its post was decided (including an ambiguous one), plus a capped settlement whose call record is missing; never a void or a release.",
	);
	lines.push("This is the configured budget against recorded spend, not the live ledger balance.");
	return lines;
}

/**
 * What a record without its call is, stated ONCE for both renderers. It is in no spend (dollar) figure, but a standalone
 * shortfall or ambiguity IS counted in the budget section as undenominated wallet units, because the governor counted it.
 */
const WITHOUT_CALL_NOTE =
	"These records qualify a call (a shortfall, an ambiguity, an implausible-usage note, a failure marker) but the chain holds no record of the call itself. Their amounts are usertokens with no denomination assumed, and they are in no spend (dollar) figure. A standalone shortfall or ambiguity is counted in the budget section as undenominated wallet units, because the governor counted it; a standalone ambiguity is also in the unconfirmed totals.";

/** The disclosure line for ungoverned call attempts, stated ONCE for both renderers; the count follows it. */
const UNGOVERNED_LINE = "Ungoverned call attempts (opted out with allowUngoverned, unmetered):";
const UNGOVERNED_NOTE =
	"Each attempt is recorded as the call is made: before the provider is reached when audit.failClosed is set, best-effort otherwise, so an attempt may have failed or never reached the provider, and a call whose record could not be written is not counted. The caller opted it out of governance: no budget check, no hold and no recorded cost, so what it spent is not known. Attempts are in no spend, cost or budget figure, and no amount is estimated for them.";

const UPPER_BOUND_NOTE =
	"A headless call the ledger answered, with no shortfall record on the chain or in the dead-letter queue, is counted as an upper bound (at most its metered cost), not as an exact figure: this record format cannot tell a capped post from an uncapped one, because the shortfall is written after the call and may not exist yet, or may have been lost in a crash.";
const DEAD_LETTER_NOTE =
	"The posted amount of the dead-lettered call(s) comes from the writer's dead-letter queue, a plain file the chain does not verify; it is never part of the VERIFIED claim.";

/** The ledger-proven headline: the exact part, then any upper-bounded part, then any dead-letter-sourced part, each stated once. */
function provenText(t: ReportModel["totals"]): string {
	const parts = [`${usd(t.postProvenUt)} across ${t.postProvenCalls} call(s).`];
	if (t.postProvenDeadLetterCalls > 0) {
		parts.push(
			`Of that, ${usd(t.postProvenDeadLetterUt)} across ${t.postProvenDeadLetterCalls} call(s) is the posted amount read from the dead-letter queue. ${DEAD_LETTER_NOTE}`,
		);
	}
	if (t.postProvenUpperCalls > 0) {
		parts.push(
			`Plus up to ${usd(t.postProvenUpperUt)} across ${t.postProvenUpperCalls} call(s) as an upper bound. ${UPPER_BOUND_NOTE}`,
		);
	}
	return parts.join(" ");
}

/** What this report is not, printed with every rendering. */
export const NOT_CLAIMED: readonly string[] = [
	"Only calls that went through usertrust are in this report. Agents or calls that were not metered are not counted and not estimated, except call attempts made unmetered through allowUngoverned, which are counted by method with no amount.",
	"Dollars are API-equivalent at the rates recorded on each call (usertoken = $0.0001), not an invoice.",
	"Denied or blocked calls moved no money and carry no dollar figure. Nothing here claims money was saved or prevented.",
	"Cache-write cost is shown as a cost driver, not as avoidable spend.",
	"Budget status compares the vault's configured budget with spend recorded in the chain. It is not the live ledger balance.",
	"After a crash between an SDK call's audit record and its budget commit, the definite lower bound can include that call. The governor's counter leg flags the disagreement, and no definite over-budget claim is made then.",
];

function rowsTable(title: string, rows: readonly Row[], keyHeader: string): string[] {
	if (rows.length === 0) return [`### ${title}`, "", "_No confirmed spend in this window._", ""];
	return [
		`### ${title}`,
		"",
		`| ${keyHeader} | Calls | Spend | Share |`,
		"|---|---:|---:|---:|",
		...rows.map((r) => `| ${md(r.key)} | ${r.calls} | ${usd(r.ut)} | ${pct(r.share)} |`),
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
				`| ${md(r.key)} | ${r.provider} | ${r.calls} | ${usd(r.ut)} | ${pct(r.share)} | ${md(r.costBasis.join(", "))} |`,
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
		`**${verdictLine(m, md)}**`,
		"",
		"## Headline",
		"",
		`- **Confirmed spend:** ${usd(t.confirmedUt)} (${utStr(t.confirmedUt)}) across ${t.confirmedCalls} call(s)`,
		`- **Of which ledger-proven:** ${provenText(t)} ${PROOF_NOTE}`,
		`- **Unconfirmed:** ${usd(t.unconfirmedUt)} across ${t.unconfirmedCalls} call(s) whose charge is not proven (not counted as spent)${
			t.unconfirmedUnlabelledCalls > 0
				? `; ${t.unconfirmedUnlabelledCalls} of them record no denomination (${tokens(t.unconfirmedUnlabelledUt)} usertokens, not shown as dollars)`
				: ""
		}`,
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
	if (t.nominalCalls > 0 || t.unconfirmedNominalCalls > 0) {
		out.push(
			`- **Nominal units (local calls, not dollars):** ${nominalStr(t.nominalUt)} across ${t.nominalCalls} confirmed call(s)${
				t.unconfirmedNominalCalls > 0
					? `; ${nominalStr(t.unconfirmedNominalUt)} across ${t.unconfirmedNominalCalls} unconfirmed call(s)`
					: ""
			}. These are bookkeeping units, in no dollar figure.`,
		);
	}
	if (t.unlabelledCalls > 0) {
		out.push(
			`- **Of which denomination not recorded:** ${usd(t.unlabelledUt)} across ${t.unlabelledCalls} call(s) (older headless records: treated as dollars, but may include nominal units)`,
		);
	}
	if (t.unconfirmedActionCalls > 0) {
		out.push(
			`- **Governed actions, unconfirmed:** ${usd(t.unconfirmedActionUt)} across ${t.unconfirmedActionCalls} action(s) whose charge is not proven (not counted as spent)`,
		);
	}
	if (m.shortfall.events > 0) {
		out.push(
			`- **Posted below metered:** ${m.shortfall.events} settlement(s) metered ${utStr(m.shortfall.ut)} more than the ledger could post (settlement_shortfall)`,
		);
	}
	out.push("");

	out.push("## Budget status", "");
	out.push(...budgetLines(m, md).map((l) => `${l}\n`), "");

	pushAll(out, rowsTable("Spend by agent", m.byAgent, "Agent"));
	out.push(
		`_Agent key: ${m.agentKey.requested}${m.agentKey.segment !== null ? `, cost-center segment ${m.agentKey.segment}` : ""}. Calls with no attribution are one "(unattributed)" row._`,
		"",
	);
	if (m.bySession.length > 0)
		pushAll(out, rowsTable("Spend by session / origin", m.bySession, "Origin"));
	pushAll(out, modelsTable(m.byModel));

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
			`| Cache write (5 min) | ${tokens(k.cacheWriteTokens - k.cacheWrite1hTokens)} | ${usd(usdMinus(k.cacheWriteUt, k.cacheWrite1hUt))} |`,
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
					`| ${usd(c.ut)} | ${md(c.timestamp)} | ${md(c.model)} | ${md(c.agent)} | ${md(c.transferId)} | ${md(c.hash.slice(0, 16))} |`,
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

	const r = m.unrecoverable;
	if (r.records > 0) {
		out.push(
			"### Settles reported after their hold was gone",
			"",
			`${r.records} settle(s) were reported after their hold was gone: the prior charge status is unknown (the call may never have been charged, or may have been charged before a restart). Reported usage: ${tokens(r.inputTokens)} input, ${tokens(r.outputTokens)} output, ${tokens(r.cacheReadTokens)} cache-read and ${tokens(r.cacheWriteTokens)} cache-write tokens. There is no dollar value: they are in no spend or budget figure.${r.priorChargeKnown > 0 ? ` ${r.priorChargeKnown} of them match a transfer that is already charged in this chain.` : ""}`,
			"",
		);
	}
	const orphans = Object.entries(m.withoutCall);
	if (orphans.length > 0) {
		out.push(
			"### Records without their call",
			"",
			WITHOUT_CALL_NOTE,
			"",
			"| Kind | Records | Amount (usertokens) |",
			"|---|---:|---:|",
			...orphans.map(([kind, v]) => `| ${md(kind)} | ${v.records} | ${tokens(v.amount)} |`),
			"",
		);
		if (m.chargedUnrecorded.records > 0) {
			out.push(
				`**Charged but unrecorded:** ${m.chargedUnrecorded.records} capped settlement(s) posted ${tokens(m.chargedUnrecorded.posted)} usertokens to the ledger whose call record is missing. That money moved; it is not counted as spend here because the denomination is not recorded.`,
				"",
			);
		}
	}
	if (m.ungoverned.calls > 0) {
		out.push(
			"### Ungoverned call attempts",
			"",
			`${UNGOVERNED_LINE} ${m.ungoverned.calls}`,
			"",
			UNGOVERNED_NOTE,
			"",
			"| Method | Attempts |",
			"|---|---:|",
			...Object.entries(m.ungoverned.byMethod).map(([method, n]) => `| ${md(method)} | ${n} |`),
			"",
		);
	}
	const kinds = Object.entries(m.unrecognised);
	if (kinds.length > 0) {
		out.push(
			"### Records this report does not read",
			"",
			"Records of these kinds are in the chain but this report has no reading for them; they are counted here so none vanishes silently.",
			"",
			"| Kind | Count |",
			"|---|---:|",
			...kinds.map(([kind, n]) => `| ${md(kind)} | ${n} |`),
			"",
		);
	}

	out.push("## Notes", "");
	if (m.notes.length === 0) out.push("None.", "");
	// Notes are authored by the model builder from counts and fixed text, never from a vault string.
	else out.push(...m.notes.map((n) => `- ${clean(n)}`), "");
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
		`<header><p class="muted">usertrust</p><h1>Weekly spend report</h1><p class="muted">${esc(m.window.startIso)} to ${esc(m.window.endIso)} (${m.window.days} days, end exclusive)</p><p class="${unverified ? "bad" : "ok"}"><strong>${esc(verdictLine(m, (x) => x))}</strong></p></header>`,
		`<p class="muted">${esc(PROOF_NOTE)}</p>`,
		`<section class="headline"><div><span class="big">${usd(t.confirmedUt)}</span><span class="muted">confirmed spend, ${t.confirmedCalls} call(s); of which ledger-proven ${esc(provenText(t))}</span></div><div><span class="big">${usd(t.unconfirmedUt)}</span><span class="muted">unconfirmed (failed, ambiguous, unsettled or uncorrelated), ${t.unconfirmedCalls} call(s)${t.unconfirmedUnlabelledCalls > 0 ? `; ${t.unconfirmedUnlabelledCalls} record no denomination (not shown as dollars)` : ""}</span></div>${
			t.estimatedCalls > 0
				? `<div><span class="big">${usd(t.estimatedUt)}</span><span class="muted">of confirmed spend priced from an estimate</span></div>`
				: ""
		}${
			t.actionCalls > 0
				? `<div><span class="big">${usd(t.actionUt)}</span><span class="muted">governed actions, reported separately</span></div>`
				: ""
		}${
			t.nominalCalls > 0 || t.unconfirmedNominalCalls > 0
				? `<div><span class="big">${nominalStr(t.nominalUt)}</span><span class="muted">nominal units from local calls (not dollars), ${t.nominalCalls} confirmed call(s)${t.unconfirmedNominalCalls > 0 ? `; ${nominalStr(t.unconfirmedNominalUt)} unconfirmed, ${t.unconfirmedNominalCalls} call(s)` : ""}</span></div>`
				: ""
		}${
			t.unlabelledCalls > 0
				? `<div><span class="big">${usd(t.unlabelledUt)}</span><span class="muted">of confirmed spend with no recorded denomination, ${t.unlabelledCalls} call(s) (may include nominal units)</span></div>`
				: ""
		}${
			t.unconfirmedActionCalls > 0
				? `<div><span class="big">${usd(t.unconfirmedActionUt)}</span><span class="muted">governed actions unconfirmed, ${t.unconfirmedActionCalls} action(s) (not counted as spent)</span></div>`
				: ""
		}${
			m.shortfall.events > 0
				? `<div><span class="big">${usd(m.shortfall.ut)}</span><span class="muted">metered above what the ledger could post, ${m.shortfall.events} settlement(s) (settlement_shortfall)</span></div>`
				: ""
		}</section>`,
		`<h2>Spend per hour</h2>${barsSvg(m.hourlyUt)}`,
	);
	body.push(`<h2>Budget status</h2>`);
	body.push(...budgetLines(m, (x) => x).map((l) => `<p>${esc(l)}</p>`));
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
			`<table><thead><tr><th>Tier</th><th class="n">Tokens</th><th class="n">Cost</th></tr></thead><tbody><tr><td>Input</td><td class="n">${tokens(k.inputTokens)}</td><td class="n">${usd(k.inputUt)}</td></tr><tr><td>Output</td><td class="n">${tokens(k.outputTokens)}</td><td class="n">${usd(k.outputUt)}</td></tr><tr><td>Cache read</td><td class="n">${tokens(k.cacheReadTokens)}</td><td class="n">${usd(k.cacheReadUt)}</td></tr><tr><td>Cache write (5 min)</td><td class="n">${tokens(k.cacheWriteTokens - k.cacheWrite1hTokens)}</td><td class="n">${usd(usdMinus(k.cacheWriteUt, k.cacheWrite1hUt))}</td></tr><tr><td>Cache write (1 hour)</td><td class="n">${tokens(k.cacheWrite1hTokens)}</td><td class="n">${usd(k.cacheWrite1hUt)}</td></tr></tbody></table><p class="muted">Cache write is ${k.cacheWriteShare === null ? "n/a" : pct(k.cacheWriteShare)} of provider-reported cost: a cost driver, not avoidable spend. Tier costs are tokens times the rates applied on each call; per-call rounding makes them differ from the metered ${usd(k.costUt)} by ${utStr(k.roundingUt)}.</p>`,
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
		...(m.unrecoverable.records > 0
			? [
					`<h3>Settles reported after their hold was gone</h3><p>${m.unrecoverable.records} settle(s) were reported after their hold was gone: the prior charge status is unknown (the call may never have been charged, or may have been charged before a restart). Reported usage: ${tokens(m.unrecoverable.inputTokens)} input, ${tokens(m.unrecoverable.outputTokens)} output, ${tokens(m.unrecoverable.cacheReadTokens)} cache-read and ${tokens(m.unrecoverable.cacheWriteTokens)} cache-write tokens. There is no dollar value: they are in no spend or budget figure.${m.unrecoverable.priorChargeKnown > 0 ? ` ${m.unrecoverable.priorChargeKnown} of them match a transfer that is already charged in this chain.` : ""}</p>`,
				]
			: []),
		...(Object.keys(m.withoutCall).length > 0
			? [
					`<h3>Records without their call</h3><p>${esc(WITHOUT_CALL_NOTE)}</p><table><thead><tr><th>Kind</th><th class="n">Records</th><th class="n">Amount (usertokens)</th></tr></thead><tbody>${Object.entries(
						m.withoutCall,
					)
						.map(
							([kind, v]) =>
								`<tr><td>${esc(kind)}</td><td class="n">${v.records}</td><td class="n">${tokens(v.amount)}</td></tr>`,
						)
						.join("")}</tbody></table>${
						m.chargedUnrecorded.records > 0
							? `<p><strong>Charged but unrecorded:</strong> ${m.chargedUnrecorded.records} capped settlement(s) posted ${tokens(m.chargedUnrecorded.posted)} usertokens to the ledger whose call record is missing. That money moved; it is not counted as spend here because the denomination is not recorded.</p>`
							: ""
					}`,
				]
			: []),
		...(m.ungoverned.calls > 0
			? [
					`<h3>Ungoverned call attempts</h3><p>${esc(`${UNGOVERNED_LINE} ${m.ungoverned.calls}`)}</p><p>${esc(UNGOVERNED_NOTE)}</p><table><thead><tr><th>Method</th><th class="n">Attempts</th></tr></thead><tbody>${Object.entries(
						m.ungoverned.byMethod,
					)
						.map(([method, n]) => `<tr><td>${esc(method)}</td><td class="n">${n}</td></tr>`)
						.join("")}</tbody></table>`,
				]
			: []),
		...(Object.keys(m.unrecognised).length > 0
			? [
					`<h3>Records this report does not read</h3><p>Records of these kinds are in the chain but this report has no reading for them; they are counted here so none vanishes silently.</p><table><tbody>${Object.entries(
						m.unrecognised,
					)
						.map(([kind, n]) => `<tr><td>${esc(kind)}</td><td class="n">${n}</td></tr>`)
						.join("")}</tbody></table>`,
				]
			: []),
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
