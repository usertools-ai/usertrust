// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How one charge adds up: each tier's token count, the rate applied to it and their product, the sum, and the
 * whole usertokens that sum was charged as, beside the cost the record carries.
 *
 * Two figures are kept apart on purpose. The WHOLE usertokens (`computedUt`) are worked out in floats exactly as
 * the charge was (`tieredCostRaw` in core's `ledger/pricing.ts`): each term `(tokens * ratePer1k) / 1000`, summed
 * in the order input, output, cache read, 5-minute write, 1-hour write, then rounded up, with a minimum of 1. The
 * TEXT of each product and of the sum is exact decimal arithmetic. The two can differ by a float's residue (three
 * terms whose decimals sum to exactly 3 can land just above 3 and be charged as 4): the whole figure then agrees
 * with the charge, and the text says what the terms come to.
 *
 * A count or rate the record does not carry is never read as 0: its tier has no product and the charge no sum.
 */

import { amountOf, type LedgerRow, type TierCounts, type TierRates } from "./rows.js";

/** The pricing tiers, in the order a charge sums them. Every list of tiers is in this order. */
export const TIERS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type Tier = (typeof TIERS)[number];

const FIELDS: Readonly<
	Record<Tier, { label: string; count: keyof TierCounts; rate: keyof TierRates }>
> = {
	input: { label: "Input", count: "inputTokens", rate: "inputPer1k" },
	output: { label: "Output", count: "outputTokens", rate: "outputPer1k" },
	cacheRead: { label: "Cache read", count: "cacheReadTokens", rate: "cacheReadPer1k" },
	cacheWrite: { label: "Cache write", count: "cacheWriteTokens", rate: "cacheWritePer1k" },
};

/** One term of the sum: a token count at one rate. `utText` and `usdText` are its exact product. */
export interface ChargePart {
	/** Set on the two terms of a cache write that has a 1-hour share; `null` on a tier that is one term. */
	label: "5-minute" | "1-hour" | null;
	count: number;
	ratePer1k: number;
	/** The product in usertokens: plain digits, no unit, no grouping. */
	utText: string;
	/** The product in dollars: `$`, at least 4 decimals, the whole part grouped. */
	usdText: string;
}

export interface ChargeLine {
	tier: Tier;
	label: string;
	/** The tier's recorded count and rate; `null` when the record carries none. Never 0 for an absent one. */
	count: number | null;
	ratePer1k: number | null;
	/** The tier's terms: empty when it cannot be priced, two for a cache write with a 1-hour share, else one. */
	parts: ChargePart[];
	/** The exact sum of the parts; `null` when the tier cannot be priced. */
	utText: string | null;
	usdText: string | null;
}

/**
 * - `none`: the record carries no cost.
 * - `no-counts`: a cost, and none of the four token counts.
 * - `partial`: at least one count, but a count or a rate is missing (or the 1-hour share is unusable).
 * - `priced`: every tier has its count and rate.
 */
export type ChargeState = "none" | "no-counts" | "partial" | "priced";

export interface Charge {
	state: ChargeState;
	/** Always four, in `TIERS` order. */
	lines: ChargeLine[];
	/** The exact, unrounded sum of every term, in usertokens. `null` unless `priced`. */
	sumText: string | null;
	/** The whole usertokens the terms come to, as a charge computes them. `null` unless `priced`. */
	computedUt: number | null;
	/** The cost the record carries (the metered amount). */
	costUt: number | null;
	/** `costUt - computedUt`: 0 when they agree, above 0 when the record charged more. `null` unless `priced`. */
	differenceUt: number | null;
	version: string | null;
}

/** An exact decimal: `digits / 10^places`. */
interface Decimal {
	digits: bigint;
	places: number;
}

/**
 * A recorded rate as an exact decimal: the shortest one that reads back as the same number, which for a rate
 * written in a record is the digits it was written with. (`0.3` is 0.3 here, not the float nearest to it.)
 */
function decimalOf(rate: number): Decimal {
	const [mantissa = "", exponent = "0"] = String(rate).split("e");
	const [whole = "", fraction = ""] = mantissa.split(".");
	const digits = BigInt(whole + fraction);
	const places = fraction.length - Number(exponent);
	return places >= 0 ? { digits, places } : { digits: digits * 10n ** BigInt(-places), places: 0 };
}

function plus(a: Decimal, b: Decimal): Decimal {
	const places = Math.max(a.places, b.places);
	return {
		digits:
			a.digits * 10n ** BigInt(places - a.places) + b.digits * 10n ** BigInt(places - b.places),
		places,
	};
}

/** `value / 10^shift` written out, trailing zeros dropped down to `minPlaces` decimals. */
function written(value: Decimal, shift: number, minPlaces: number, grouped: boolean): string {
	const places = value.places + shift;
	const digits = value.digits.toString().padStart(places + 1, "0");
	const whole = digits.slice(0, digits.length - places);
	const fraction = digits
		.slice(digits.length - places)
		.replace(/0+$/, "")
		.padEnd(minPlaces, "0");
	const head = grouped ? whole.replace(/\B(?=(\d{3})+$)/g, ",") : whole;
	return fraction === "" ? head : `${head}.${fraction}`;
}

/** A sum of `tokens * ratePer1k` in usertokens: the rate is per 1,000 tokens. */
const utText = (product: Decimal): string => written(product, 3, 0, false);
/** The same in dollars: 1 usertoken is $0.0001, four more places. */
const usdText = (product: Decimal): string => `$${written(product, 3 + 4, 4, true)}`;

const ZERO: Decimal = { digits: 0n, places: 0 };

type Term = Pick<ChargePart, "label" | "count" | "ratePer1k">;

/**
 * The terms a tier is priced as. A cache write with a 1-hour share is two: the share (never more than the write
 * count) at its own rate, and the 5-minute remainder at the tier's rate. A share the row carries but that holds no
 * usable number leaves the tier unpriced.
 */
function termsOf(
	tier: Tier,
	count: number,
	ratePer1k: number,
	write1h: LedgerRow["cacheWrite1h"],
): Term[] {
	if (tier !== "cacheWrite" || write1h === undefined) return [{ label: null, count, ratePer1k }];
	const tokens = amountOf(write1h.tokens, true);
	const rate1h = amountOf(write1h.ratePer1k, false);
	if (tokens === undefined || rate1h === undefined) return [];
	const share = Math.min(tokens, count);
	return [
		{ label: "5-minute", count: count - share, ratePer1k },
		{ label: "1-hour", count: share, ratePer1k: rate1h },
	];
}

export function chargeOf(
	row: Pick<
		LedgerRow,
		"costUt" | "usage" | "appliedRates" | "cacheWrite1h" | "pricingTableVersion"
	>,
): Charge {
	// The charge's own arithmetic, in floats and in its order. Do not reorder or regroup: see the note above.
	let sum = 0;
	let exact = ZERO;
	const lines: ChargeLine[] = [];
	for (const tier of TIERS) {
		const field = FIELDS[tier];
		const count = amountOf(row.usage?.[field.count], true) ?? null;
		const ratePer1k = amountOf(row.appliedRates?.[field.rate], false) ?? null;
		const terms =
			count === null || ratePer1k === null ? [] : termsOf(tier, count, ratePer1k, row.cacheWrite1h);
		let tierExact = ZERO;
		const parts: ChargePart[] = [];
		for (const term of terms) {
			sum += (term.count * term.ratePer1k) / 1000;
			const rate = decimalOf(term.ratePer1k);
			const product = { digits: BigInt(term.count) * rate.digits, places: rate.places };
			tierExact = plus(tierExact, product);
			parts.push({ ...term, utText: utText(product), usdText: usdText(product) });
		}
		exact = plus(exact, tierExact);
		const priced = parts.length > 0;
		lines.push({
			tier,
			label: field.label,
			count,
			ratePer1k,
			parts,
			utText: priced ? utText(tierExact) : null,
			usdText: priced ? usdText(tierExact) : null,
		});
	}
	const costUt = row.costUt ?? null;
	const state: ChargeState =
		costUt === null
			? "none"
			: lines.every((line) => line.count === null)
				? "no-counts"
				: lines.every((line) => line.parts.length > 0)
					? "priced"
					: "partial";
	const computedUt = state === "priced" ? Math.max(1, Math.ceil(sum)) : null;
	return {
		state,
		lines,
		sumText: state === "priced" ? utText(exact) : null,
		computedUt,
		costUt,
		differenceUt: costUt === null || computedUt === null ? null : costUt - computedUt,
		version: row.pricingTableVersion ?? null,
	};
}
