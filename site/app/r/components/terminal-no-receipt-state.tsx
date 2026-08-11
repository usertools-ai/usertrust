import {
	CANCELLED_EXPIRED_HEADLINE,
	NOT_MINTED_DISTINCT_NOTE,
	NOT_MINTED_HEADLINE,
	RESERVATION_ASYMMETRY_NOTE,
} from "../lib/shell-copy";
import type { TerminalNoReceiptState } from "../lib/wire";
import NonGreenMasthead from "./nongreen-masthead";
import TerminalPaperStub from "./terminal-paper-stub";

/**
 * §7 — "Terminal without a receipt (410)", the `cancelled` / `expired` /
 * `notMinted` trio. All three are NEUTRAL-TERMINAL, not danger — the
 * asymmetry note exists precisely so a reader who expects every 410 to be
 * alarming (per `billedUnfinalized`, which IS) does not read this one that
 * way. `cancelled`/`expired` get the `VOID` stamp on an empty paper stub
 * (§6.2); `notMinted` is unstamped — §7 names no stamp for it, and stamping
 * every terminal state identically would erase the one distinction §7 draws
 * ("distinct from both an error and a green check").
 */
/** Readable status words — `state.status` is camelCase wire vocabulary, not display copy. */
const STATUS_WORD: Record<TerminalNoReceiptState["status"], string> = {
	cancelled: "CANCELLED",
	expired: "EXPIRED",
	notMinted: "NOT MINTED",
};

export default function TerminalNoReceiptStateView({ state }: { state: TerminalNoReceiptState }) {
	const isNotMinted = state.status === "notMinted";
	const headline = isNotMinted ? NOT_MINTED_HEADLINE : CANCELLED_EXPIRED_HEADLINE;
	const note = isNotMinted ? NOT_MINTED_DISTINCT_NOTE : RESERVATION_ASYMMETRY_NOTE;
	return (
		<section
			data-state="terminalNoReceipt"
			data-status={state.status}
			className="flex flex-col gap-6"
		>
			<NonGreenMasthead word={headline} register="neutral">
				<p className="text-[13px] leading-relaxed text-white/70">{note}</p>
			</NonGreenMasthead>
			<TerminalPaperStub
				receiptId={state.receiptId}
				statusWord={STATUS_WORD[state.status]}
				stamp={isNotMinted ? undefined : { word: "VOID", colorClassName: "text-paper-steel" }}
			/>
		</section>
	);
}
