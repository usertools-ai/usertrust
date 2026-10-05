import { plainState } from "../lib/plain-copy";
import {
	CANCELLED_EXPIRED_HEADLINE,
	NOT_MINTED_DISTINCT_NOTE,
	NOT_MINTED_HEADLINE,
	RESERVATION_ASYMMETRY_NOTE,
} from "../lib/shell-copy";
import type { TerminalNoReceiptState } from "../lib/wire";
import Details from "./details";
import NonGreenMasthead from "./nongreen-masthead";
import TerminalPaperStub from "./terminal-paper-stub";

const STATUS_WORD: Record<TerminalNoReceiptState["status"], string> = {
	cancelled: "CANCELLED",
	expired: "EXPIRED",
	notMinted: "NOT MINTED",
};

/**
 * 410, no receipt: a plain word and line first; the spec's headline, its
 * asymmetry note and the paper stub are in Details.
 */
export default function TerminalNoReceiptStateView({ state }: { state: TerminalNoReceiptState }) {
	const isNotMinted = state.status === "notMinted";
	const headline = isNotMinted ? NOT_MINTED_HEADLINE : CANCELLED_EXPIRED_HEADLINE;
	const note = isNotMinted ? NOT_MINTED_DISTINCT_NOTE : RESERVATION_ASYMMETRY_NOTE;
	const plain = plainState(state);
	return (
		<section
			data-state="terminalNoReceipt"
			data-status={state.status}
			className="flex flex-col gap-6"
		>
			<NonGreenMasthead word={plain.word} register={plain.register}>
				<p className="text-[13px] leading-relaxed text-white/70">{plain.line}</p>
			</NonGreenMasthead>
			<Details>
				<p className="text-white/85">{headline}</p>
				<p className="text-[13px] leading-relaxed text-white/70">{note}</p>
				<TerminalPaperStub
					receiptId={state.receiptId}
					statusWord={STATUS_WORD[state.status]}
					stamp={isNotMinted ? undefined : { word: "VOID", colorClassName: "text-paper-steel" }}
				/>
			</Details>
		</section>
	);
}
