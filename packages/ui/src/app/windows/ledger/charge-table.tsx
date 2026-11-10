// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How one charge adds up, as a table: each tier's tokens, the rate applied and their product, then the sum, the
 * whole usertokens it rounds up to and the cost the record carries. The figures are `chargeOf`'s; nothing is summed
 * here. A count or rate the record does not carry reads "not recorded", never 0, and a charge with one missing
 * prints no sum.
 */

import { type Charge, type ChargeLine, chargeOf } from "../../../shared/charge.js";
import { usageView } from "../../../shared/display.js";
import { formatUt } from "../../../shared/format.js";
import { amountOf, type LedgerRow, statusOf } from "../../../shared/rows.js";

const NOT_RECORDED = "not recorded";
/** The one kind of record that is a call, and so the only one with tokens to add up. */
const CALL_KIND = "llm_call";

/** An exact usertoken figure as written by `chargeOf` (plain digits), with its whole part grouped and its unit. */
function exactUt(text: string): string {
	const [whole = "0", fraction] = text.split(".");
	const head = BigInt(whole).toLocaleString("en-US");
	return `${fraction === undefined ? head : `${head}.${fraction}`} UT`;
}

/** The count and rate of one row; `null` where the record carries none. */
type Cells = Pick<ChargeLine, "count" | "ratePer1k">;

const tokens = (n: number | null): string => n?.toLocaleString("en-US") ?? NOT_RECORDED;
const rate = (n: number | null): string => (n === null ? NOT_RECORDED : `${n} UT`);

/** A product in usertokens with its dollars under it; a long dash when there is none to print. */
function Cost(props: { ut: string | null; usd: string | null }): React.JSX.Element {
	if (props.ut === null) return <td className="na">—</td>;
	return (
		<td>
			{exactUt(props.ut)}
			<small>{props.usd}</small>
		</td>
	);
}

/** The 1-hour share of a cache write as the row carries it, when its tier could not be priced because of it. */
function unusableShare(line: ChargeLine, row: LedgerRow): Cells | null {
	const share = row.cacheWrite1h;
	if (line.tier !== "cacheWrite" || line.parts.length > 0 || share === undefined) return null;
	if (line.count === null || line.ratePer1k === null) return null;
	const count = amountOf(share.tokens, true) ?? null;
	return { count, ratePer1k: amountOf(share.ratePer1k, false) ?? null };
}

/** What keeps a charge from being added up, by name: "the cache-read rate", "the 1-hour cache-write token count". */
function missing(charge: Charge, row: LedgerRow): string[] {
	const names: string[] = [];
	for (const line of charge.lines) {
		const tier = line.label.toLowerCase().replace(" ", "-");
		if (line.count === null) names.push(`the ${tier} token count`);
		if (line.ratePer1k === null) names.push(`the ${tier} rate`);
		const share = unusableShare(line, row);
		if (share !== null && share.count === null) names.push(`the 1-hour ${tier} token count`);
		if (share !== null && share.ratePer1k === null) names.push(`the 1-hour ${tier} rate`);
	}
	return names;
}

/**
 * The sentence for the sum, only where the rows under the tiers need words: a fractional sum rounded up and a whole
 * sum charged as it is are told by the rows alone (`text` is null). A whole sum that computes one higher is the
 * floating-point case: the terms are exactly a whole number in decimals and land a hair above it when summed as the
 * charge sums them, and a charge rounds up. `residue` is true only then.
 */
function sumLine(
	sumText: string,
	computedUt: number,
	charged: boolean,
): { text: string | null; residue: boolean } {
	const sum = exactUt(sumText);
	const computed = formatUt(computedUt);
	const whole = Number(sumText);
	if (sumText.includes(".")) return { text: null, residue: false };
	if (whole < 1 && computedUt === 1) {
		return { text: `Sum ${sum}. A charge is at least ${computed}.`, residue: false };
	}
	if (computedUt !== whole + 1) return { text: null, residue: false };
	const how = `computed in floating point, came out a hair above ${whole.toLocaleString("en-US")}, and charges round up`;
	return {
		// "Charged" only when the record's cost is that figure; a record that charged something else says so below.
		text: charged
			? `Sum ${sum}. Charged ${computed}: the charge was ${how}.`
			: `Sum ${sum}. A charge of these tiers comes to ${computed}: it is ${how}.`,
		residue: true,
	};
}

/** A row under the tiers: a label across the first three columns and one figure, under the hook that names it. */
function Foot(props: { label: string; fig: string; value: string }): React.JSX.Element {
	return (
		<tr>
			<th scope="row" colSpan={3}>
				{props.label}
			</th>
			<td>
				<span data-fig={props.fig}>{props.value}</span>
			</td>
		</tr>
	);
}

/**
 * One row of tokens, rate and product: a tier, or (`part`) one of the two parts of a cache write under it. A tier
 * shown in two parts (`split`) was charged at two rates, so its own row prints none: its tokens and cost are totals.
 */
function Line(props: {
	label: string | null;
	part?: boolean;
	split?: boolean;
	of: Cells & Partial<Pick<ChargeLine, "utText" | "usdText">>;
}): React.JSX.Element {
	const { of } = props;
	return (
		<tr className={props.part === true ? "ut-lg-part" : undefined}>
			<th scope="row">{props.label}</th>
			<td>{tokens(of.count)}</td>
			{props.split === true ? (
				<td className="na" aria-label="two rates, below">
					—
				</td>
			) : (
				<td>{rate(of.ratePer1k)}</td>
			)}
			<Cost ut={of.utText ?? null} usd={of.usdText ?? null} />
		</tr>
	);
}

function TierRows(props: { line: ChargeLine; row: LedgerRow }): React.JSX.Element {
	const { line } = props;
	const share = unusableShare(line, props.row);
	return (
		<>
			<Line label={line.label} split={line.parts.length > 1} of={line} />
			{line.parts.length > 1 &&
				line.parts.map((part) => <Line key={part.label} label={part.label} part of={part} />)}
			{share !== null && <Line label="1-hour" part of={share} />}
		</>
	);
}

export function ChargeTable(props: { row: LedgerRow }): React.JSX.Element | null {
	const { row } = props;
	// Only a call is added up from tokens. Another kind of record can carry a cost and a model too (an outcome that
	// was never confirmed, a denial), and a table under it would read as a charge that was made.
	if (row.kind !== CALL_KIND) return null;
	const charge = chargeOf(row);
	const { costUt, sumText, computedUt, differenceUt } = charge;
	if (charge.state === "none" || costUt === null) return null;
	// An unresolved call's cost is recorded, not confirmed: it is not said to have been charged.
	const unresolved = statusOf(row) === "ambiguous";
	const priced = sumText !== null && computedUt !== null && differenceUt !== null;
	const sum = priced ? sumLine(sumText, computedUt, differenceUt === 0) : null;
	const lacking = charge.state === "partial" ? missing(charge, row) : [];
	return (
		<div className="ut-lg-charge">
			<table className="ut-lg-sums">
				<caption>How this charge adds up</caption>
				<thead>
					<tr>
						<th scope="col">Tier</th>
						<th scope="col">Tokens</th>
						<th scope="col">Rate per 1k</th>
						<th scope="col">Cost</th>
					</tr>
				</thead>
				<tbody>
					{charge.lines.map((line) => (
						<TierRows key={line.tier} line={line} row={row} />
					))}
				</tbody>
				<tfoot>
					{priced && (
						<>
							<Foot label="Adds up to" fig="ledger.panel-sum-exact" value={exactUt(sumText)} />
							{sum?.residue === true && (
								<Foot
									label="Added by floating-point rounding"
									fig="ledger.panel-residue"
									value={formatUt(1)}
								/>
							)}
							<Foot
								label="Rounded up to a whole UT (minimum 1)"
								fig="ledger.panel-sum"
								value={formatUt(computedUt)}
							/>
						</>
					)}
					<Foot
						label={unresolved ? "Recorded cost" : "Charged"}
						fig="ledger.panel-cost"
						value={formatUt(costUt)}
					/>
				</tfoot>
			</table>
			{charge.state === "no-counts" && (
				<p>No token counts are recorded for this charge, so it cannot be added up from tokens.</p>
			)}
			{charge.state === "partial" && (
				<p>
					Cannot be added up:{" "}
					{new Intl.ListFormat("en-GB", { type: "conjunction" }).format(lacking)}{" "}
					{lacking.length === 1 ? "was" : "were"} not recorded.
				</p>
			)}
			{priced && sum !== null && (sum.text !== null || differenceUt !== 0) && (
				<p className="ut-lg-sumnote">
					{sum.text}
					{sum.text !== null && differenceUt !== 0 && " "}
					{differenceUt !== 0 &&
						`The tiers add up to ${formatUt(computedUt)}; the record ${unresolved ? "holds" : "charged"} ${formatUt(costUt)}; the charge is ${formatUt(Math.abs(differenceUt))} ${differenceUt > 0 ? "higher" : "lower"}. Shown as recorded.`}
				</p>
			)}
			<p className="ut-lg-src">Pricing table version: {charge.version ?? NOT_RECORDED}</p>
			<p className="ut-lg-src">
				Usage source: {row.usageSource === undefined ? NOT_RECORDED : usageView(row).text}
			</p>
		</div>
	);
}
