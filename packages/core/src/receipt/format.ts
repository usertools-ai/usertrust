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

/** One usertoken is exactly one ten-thousandth of a dollar. */
export const UT_TO_USD = 0.0001;

/** Usertokens, with their unit. Grouped with `en-US` separators so the figure never depends on the machine's locale. */
export function formatUt(ut: number): string {
	return `${ut.toLocaleString("en-US")} UT`;
}

/**
 * Dollars at 4 dp: 1 UT is exactly $0.0001, so 4 dp is exact. A header that printed 2 dp beside rows that printed 4
 * once summed a $0.0097 call into a "$0.95" that no row added up to.
 */
export function formatUsd(ut: number): string {
	return `$${(ut * UT_TO_USD).toFixed(4)}`;
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
}

/**
 * Every C0 and C1 control character, DEL, the Unicode line and paragraph separators and every format character
 * (the bidirectional overrides among them, which reorder text without a glyph), replaced by `?`.
 */
function plain(text: string): string {
	return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "?");
}

/** A usertoken count as plain words: `1 usertoken`, `104 usertokens`, `1,000,000 usertokens`. */
function usertokens(ut: number): string {
	return `${ut.toLocaleString("en-US")} usertoken${ut === 1 ? "" : "s"}`;
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
	const cost = `${formatUsd(receipt.cost)} (${usertokens(receipt.cost)})`;

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
	const left = `${usertokens(receipt.budgetRemaining)} (${formatUsd(receipt.budgetRemaining)}) left in the budget`;

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
