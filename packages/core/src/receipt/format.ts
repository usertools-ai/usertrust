// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How a receipt reads to a person. Pure and free of Node imports, so the command line, the demo and
 * the visual ledger's browser bundle print the same figure the same way: one formatter per quantity.
 * It is the `usertrust/receipt` entry point.
 *
 * A receipt's strings (a model name, a path, a transfer id) come from the caller's request or the
 * filesystem, and the output of the command line is read by people and by agents that follow it. So
 * every string is stripped of control characters before it is printed, and `formatReceipt` takes
 * receipt fields only: it has no way to print a model's response.
 */

/** Usertokens, with their unit. Grouped with `en-US` separators so the figure never depends on the machine's locale. */
export function formatUt(ut: number): string {
	return `${ut.toLocaleString("en-US")} UT`;
}

/** Usertokens in a dollar: 1 UT is exactly $0.0001. */
const UT_PER_DOLLAR = 10_000n;

/**
 * Dollars from a usertoken count, by integer arithmetic only: 1 UT is exactly $0.0001, so a count is never
 * multiplied by 0.0001 (a float), and a large vault's figure cannot drift. `dp` is 2 or 4; the cut to 2 dp rounds
 * half up on the magnitude. The whole part is grouped with commas. A count that is not finite has no dollar figure.
 */
export function dollarsFromUt(ut: number, dp: 2 | 4): string {
	if (!Number.isFinite(ut)) return "n/a";
	const total = BigInt(Math.round(Math.abs(ut)));
	const scale = dp === 4 ? 1n : 100n;
	const units = (total + scale / 2n) / scale;
	const per = UT_PER_DOLLAR / scale;
	const whole = (units / per).toString().replace(/\B(?=(\d{3})+$)/g, ",");
	const frac = (units % per).toString().padStart(dp, "0");
	return `${ut < 0 && units > 0n ? "-" : ""}$${whole}.${frac}`;
}

/**
 * Dollars at 4 dp, for one call or one record: 1 UT is exactly $0.0001, so 4 dp is exact, and a call can cost under
 * a cent. A header that printed 2 dp beside rows that printed 4 once summed a $0.0097 call into a "$0.95" that no
 * row added up to.
 */
export function formatUsd(ut: number): string {
	return dollarsFromUt(ut, 4);
}

/** The fields of a receipt that `formatReceipt` reads: a structural subset of `TrustReceipt`, so any receipt fits. */
export interface ReceiptFields {
	readonly transferId: string;
	readonly cost: number;
	readonly postedCost?: number | undefined;
	readonly budgetRemaining: number;
	readonly auditHash: string;
	readonly chainPath: string;
	readonly receiptUrl?: string | null | undefined;
	readonly settled: boolean;
	readonly model: string;
	readonly provider: string;
	readonly timestamp: string;
	readonly auditDegraded?: boolean | undefined;
	readonly usageSource?: "provider" | "estimated" | undefined;
	/** Set on a governed action's receipt, which has no `usageSource`. */
	readonly actionKind?: string | undefined;
	/**
	 * What the cost is denominated in: `usd-proxy` is a dollar-proxy (a metered provider), `nominal` is a bookkeeping unit
	 * (a local model, where no dollar was spent). Absent on a receipt with no meter, which is read as dollars.
	 */
	readonly meter?: { readonly costBasis: "usd-proxy" | "nominal" } | undefined;
	/**
	 * The cost-center envelope that paid, read after the call settled. Present only for a call inside a cost-center scope.
	 * `budgetRemaining` is the SESSION wallet, which an exhausted envelope does not touch.
	 */
	readonly budget?: { readonly costCenter: string; readonly remaining: number } | undefined;
}

/**
 * Every C0 and C1 control character, DEL, the Unicode line and paragraph separators and every format character
 * (the bidirectional overrides among them, which reorder text without a glyph), replaced by `?`.
 */
function plain(text: string): string {
	return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "?");
}

/** A usertoken count as plain words: `1 usertoken`, `104 usertokens`, `1,000,000 usertokens`. */
function usertokens(ut: number, nominal = false): string {
	return `${ut.toLocaleString("en-US")} ${nominal ? "nominal " : ""}usertoken${ut === 1 ? "" : "s"}`;
}

/**
 * The receipt as plain lines, dollars first. Five lines, one fact each:
 *
 * 1. what it cost: `$0.0104 (104 usertokens)`;
 * 2. the model and the provider;
 * 3. the hold and the charge, and what is left of the budget;
 * 4. the seal: the audit hash that links the receipt into the chain, and where the chain is;
 * 5. the receipt's id and time.
 *
 * It states what the receipt says and no more: a receipt whose audit record could not be written says so,
 * and a charge capped at its hold says what was posted.
 */
export function formatReceipt(receipt: ReceiptFields): string {
	// A local model's cost is a nominal unit, not a dollar: it is shown as units, never as money.
	const nominal = receipt.meter?.costBasis === "nominal";
	const cost = nominal
		? `${usertokens(receipt.cost, true)} (nominal units: no dollars were spent)`
		: `${formatUsd(receipt.cost)} (${usertokens(receipt.cost)})`;
	const worth = (ut: number): string =>
		nominal ? usertokens(ut, true) : `${usertokens(ut)} (${formatUsd(ut)})`;

	const model = `${plain(receipt.model)} via ${plain(receipt.provider)}${
		receipt.usageSource === "estimated" ? " (token counts estimated)" : ""
	}`;

	let charge: string;
	if (!receipt.settled) {
		// A lost reply to the post is recorded as an ambiguous settlement whose charge stands on the ledger, so an
		// unsettled receipt claims neither a charge nor a release.
		charge = "settlement is not confirmed: the hold may still stand as a charge on the ledger";
	} else if (receipt.postedCost !== undefined && receipt.postedCost < receipt.cost) {
		charge = `held, then charged ${usertokens(receipt.postedCost)} (the hold capped the charge below the ${usertokens(receipt.cost)} metered)`;
	} else {
		charge = `held, then charged ${usertokens(receipt.cost)}`;
	}
	// The envelope that paid, when the call ran in a cost-center scope; otherwise the session budget, named as such, since
	// an exhausted envelope leaves the session wallet untouched.
	const left =
		receipt.budget !== undefined
			? `${worth(receipt.budget.remaining)} left in the ${plain(receipt.budget.costCenter)} cost center's envelope`
			: `${worth(receipt.budgetRemaining)} left in the session budget`;

	// Only a stream's estimate handle (unsettled, before the stream is consumed) carries a placeholder hash for a spend
	// event that is not on the chain yet. Every final receipt of a call has a usageSource and every governed action has
	// an actionKind; an unsettled one of those is an ambiguous settlement, whose record IS on the chain under its hash.
	const placeholderHash =
		!receipt.settled && receipt.usageSource === undefined && receipt.actionKind === undefined;
	const seal =
		receipt.auditDegraded === true
			? "not sealed: the audit record could not be written (auditDegraded)"
			: placeholderHash
				? `provisional: not yet recorded in the audit chain at ${plain(receipt.chainPath)}`
				: `sealed ${plain(receipt.auditHash).slice(0, 12)}... in the audit chain at ${plain(receipt.chainPath)}`;

	const where =
		receipt.receiptUrl !== undefined && receipt.receiptUrl !== null
			? `receipt ${plain(receipt.transferId)} at ${plain(receipt.receiptUrl)}, ${plain(receipt.timestamp)}`
			: `receipt ${plain(receipt.transferId)}, ${plain(receipt.timestamp)}`;

	return [cost, model, `${charge}; ${left}`, seal, where].join("\n");
}
