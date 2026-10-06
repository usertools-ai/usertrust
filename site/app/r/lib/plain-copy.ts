/**
 * The plain-language layer: one calm word (2-4 words) and one line per state,
 * shown first. The spec's full wording stays on the page, in each state's
 * Details, and in `shell-copy.ts` where it is pinned — this module only says
 * what a visitor should read before they decide to dig further.
 *
 * Presentation only: nothing here decides a verdict. Every branch dispatches
 * on a state the resolver and `wire.ts` already produced.
 */
import type { IntegrityCause, PageState } from "./wire";

export type PlainRegister = "neutral" | "warning" | "danger";

export interface PlainState {
	word: string;
	line: string;
	register: PlainRegister;
}

export const PLAIN_INTEGRITY_LINE = "The proof didn't match the audit log.";

export function plainIntegrityLine(cause: IntegrityCause): string {
	if (cause.source === "resolver") return PLAIN_INTEGRITY_LINE;
	switch (cause.obligation) {
		case "R1":
			return "The receipt returned doesn't match the ID that was asked for.";
		case "R3":
			return "The supporting record doesn't match the receipt.";
		case "R4":
			return "The signed bytes don't match the receipt.";
		case "R39":
			return "This receipt claims to cover all delegated work, which can't be checked here.";
	}
}

export function plainState(state: Exclude<PageState, { kind: "verified" }>): PlainState {
	switch (state.kind) {
		case "pending":
			return state.status === "reserved"
				? {
						word: "Pending",
						line: "The work behind this receipt hasn't finished yet.",
						register: "neutral",
					}
				: {
						word: "Pending",
						line: "This receipt is still settling. Check back shortly.",
						register: "neutral",
					};
		case "terminalNoReceipt":
			return {
				word: "No receipt",
				line:
					state.status === "notMinted"
						? "No billable work was settled under this ID."
						: "This reservation ended without a receipt.",
				register: "neutral",
			};
		case "billedUnfinalized":
			return {
				word: "Not proven",
				line: "This work was billed, but its receipt was never finalized.",
				register: "danger",
			};
		// receipt-spec v0.10 §15.13: every 404 reads "no receipt under this ID
		// yet". An ID can be cited before its receipt is minted, so this is
		// never worded as forgery, never danger, and never green.
		case "unknownReceipt":
			return {
				word: "No receipt yet",
				line: "There's no receipt under this ID yet. Receipts are minted after the agent key goes idle — 10 minutes by default — and its audit segment seals.",
				register: "neutral",
			};
		case "integrityFailure":
			return { word: "Not verified", line: plainIntegrityLine(state.cause), register: "danger" };
		case "invalidId":
			return { word: "Invalid ID", line: "That isn't a valid receipt ID.", register: "neutral" };
		case "verificationUnavailable":
			return {
				word: "Can't verify now",
				line: "Verification is temporarily down. That is not a mismatch. Try again shortly.",
				register: "warning",
			};
		case "rateLimited":
			return {
				word: "Slow down",
				line: "Too many requests. Try again shortly.",
				register: "neutral",
			};
		case "protocolError":
			return {
				word: "No clear answer",
				line: "Couldn't get a trustworthy answer from the resolver.",
				register: "danger",
			};
	}
}
