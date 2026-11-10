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
import { amountOf, type LedgerRow } from "../../../shared/rows.js";

const NOT_RECORDED = "not recorded";

/** An exact usertoken figure as written by `chargeOf` (plain digits), with its whole part grouped and its unit. */
function exactUt(text: string): string {
	const [whole = "0", fraction] = text.split(".");
	const head = BigInt(whole).toLocaleString("en-US");
	return `${fraction === undefined ? head : `${head}.${fraction}`} UT`;
}

const tokens = (n: number | null | undefined): string =>
	n === null || n === undefined ? NOT_RECORDED : n.toLocaleString("en-US");
const rate = (n: number | null | undefined): string =>
	n === null || n === undefined ? NOT_RECORDED : `${n} UT`;

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
function unusableShare(
	line: ChargeLine,
	row: LedgerRow,
): { tokens?: number; ratePer1k?: number } | null {
	if (line.tier !== "cacheWrite" || line.parts.length > 0 || row.cacheWrite1h === undefined) {
		return null;
	}
	if (line.count === null || line.ratePer1k === null) return null;
	const share: { tokens?: number; ratePer1k?: number } = {};
	const count = amountOf(row.cacheWrite1h.tokens, true);
	const per1k = amountOf(row.cacheWrite1h.ratePer1k, false);
	if (count !== undefined) share.tokens = count;
	if (per1k !== undefined) share.ratePer1k = per1k;
	return share;
}

/** What keeps a charge from being added up, by name: "the cache-read rate", "the 1-hour cache-write token count". */
function missing(charge: Charge, row: LedgerRow): string[] {
	const names: string[] = [];
	for (const line of charge.lines) {
		const tier = line.label.toLowerCase().replace(" ", "-");
		if (line.count === null) names.push(`the ${tier} token count`);
		if (line.ratePer1k === null) names.push(`the ${tier} rate`);
		const share = unusableShare(line, row);
		if (share !== null && share.tokens === undefined) names.push(`the 1-hour ${tier} token count`);
		if (share !== null && share.ratePer1k === undefined) names.push(`the 1-hour ${tier} rate`);
	}
	return names;
}

/**
 * The sentence for the sum beside the whole usertokens a charge computes from it. A whole sum that computes one
 * higher is the floating-point case: the terms are exactly a whole number in decimals and land a hair above it when
 * summed as the charge sums them, and a charge rounds up. `residue` is true only then.
 */
function sumLine(
	sumText: string,
	computedUt: number,
	charged: boolean,
): { text: string; residue: boolean } {
	const sum = exactUt(sumText);
	const computed = formatUt(computedUt);
	if (sumText.includes("."))
		return { text: `Sum ${sum}, rounded up to ${computed}.`, residue: false };
	const whole = Number(sumText);
	if (whole < 1 && computedUt === 1) {
		return { text: `Sum ${sum}. A charge is at least ${computed}.`, residue: false };
	}
	if (computedUt !== whole + 1) return { text: `Sum ${sum}.`, residue: false };
	const how = `computed in floating point, came out a hair above ${whole.toLocaleString("en-US")}, and charges round up`;
	return {
		// "Charged" only when the record's cost is that figure; a record that charged something else says so below.
		text: charged
			? `Sum ${sum}. Charged ${computed}: the charge was ${how}.`
			: `Sum ${sum}. A charge of these tiers comes to ${computed}: it is ${how}.`,
		residue: true,
	};
}

function TierRows(props: { line: ChargeLine; row: LedgerRow }): React.JSX.Element {
	const { line } = props;
	const share = unusableShare(line, props.row);
	return (
		<>
			<tr>
				<th scope="row">{line.label}</th>
				<td>{tokens(line.count)}</td>
				<td>{rate(line.ratePer1k)}</td>
				<Cost ut={line.utText} usd={line.usdText} />
			</tr>
			{line.parts.length > 1 &&
				line.parts.map((part) => (
					<tr key={part.label} className="ut-lg-part">
						<th scope="row">{part.label}</th>
						<td>{tokens(part.count)}</td>
						<td>{rate(part.ratePer1k)}</td>
						<Cost ut={part.utText} usd={part.usdText} />
					</tr>
				))}
			{share !== null && (
				<tr className="ut-lg-part">
					<th scope="row">1-hour</th>
					<td>{tokens(share.tokens)}</td>
					<td>{rate(share.ratePer1k)}</td>
					<Cost ut={null} usd={null} />
				</tr>
			)}
		</>
	);
}

export function ChargeTable(props: { row: LedgerRow }): React.JSX.Element | null {
	const { row } = props;
	const charge = chargeOf(row);
	const { costUt, sumText, computedUt, differenceUt } = charge;
	if (charge.state === "none" || costUt === null) return null;
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
							<tr>
								<th scope="row" colSpan={3}>
									Adds up to
								</th>
								<td>
									<span data-fig="ledger.panel-sum-exact">{exactUt(sumText)}</span>
								</td>
							</tr>
							{sum?.residue === true && (
								<tr>
									<th scope="row" colSpan={3}>
										Added by floating-point rounding
									</th>
									<td>
										<span data-fig="ledger.panel-residue">{formatUt(1)}</span>
									</td>
								</tr>
							)}
							<tr>
								<th scope="row" colSpan={3}>
									Rounded up to a whole UT (minimum 1)
								</th>
								<td>
									<span data-fig="ledger.panel-sum">{formatUt(computedUt)}</span>
								</td>
							</tr>
						</>
					)}
					<tr>
						<th scope="row" colSpan={3}>
							Charged
						</th>
						<td>
							<span data-fig="ledger.panel-cost">{formatUt(costUt)}</span>
						</td>
					</tr>
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
			{priced && sum !== null && (
				<p>
					{sum.text}{" "}
					{differenceUt === 0
						? "The tiers add up to the charged cost."
						: `The tiers add up to ${formatUt(computedUt)}; the record charged ${formatUt(costUt)}; the charge is ${formatUt(Math.abs(differenceUt))} ${differenceUt > 0 ? "higher" : "lower"}. Shown as recorded.`}
				</p>
			)}
			<p className="ut-lg-src">Pricing table version: {charge.version ?? NOT_RECORDED}</p>
			<p className="ut-lg-src">
				Usage source: {row.usageSource === undefined ? NOT_RECORDED : usageView(row).text}
			</p>
		</div>
	);
}
