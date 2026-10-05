import { plainState } from "../lib/plain-copy";
import { UNKNOWN_HEADLINE, UNKNOWN_NOT_YET_NOTE } from "../lib/shell-copy";
import type { UnknownReceiptState } from "../lib/wire";
import Details from "./details";
import HashValue from "./hash-value";
import NonGreenMasthead from "./nongreen-masthead";

/**
 * 404: "no receipt under this ID yet" (receipt-spec v0.10 §15.13). The plain
 * word and line lead, the ID keeps its copy button, and the spec's headline
 * and its explanation sit in Details.
 *
 * Neutral, like pending, and never the danger register: an ID can be cited
 * before its receipt is minted, and a 404 cannot tell that ID from one that
 * will never have a receipt. The retired loud rendering flagged both as an
 * integrity red flag.
 */
export default function UnknownReceiptStateView({ state }: { state: UnknownReceiptState }) {
	const plain = plainState(state);
	return (
		<section data-state="unknownReceipt" className="flex flex-col gap-6">
			<NonGreenMasthead word={plain.word} register={plain.register}>
				<p className="text-[13px] leading-relaxed text-white/70">{plain.line}</p>
			</NonGreenMasthead>
			<p className="font-mono text-[13px]" data-testid="unknown-id">
				<HashValue value={state.receiptId} label="receipt ID" />
			</p>
			<Details>
				<p className="text-white/85">{UNKNOWN_HEADLINE}</p>
				<p className="text-[13px] leading-relaxed text-white/70">{UNKNOWN_NOT_YET_NOTE}</p>
			</Details>
		</section>
	);
}
