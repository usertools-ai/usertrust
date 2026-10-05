import { plainState } from "../lib/plain-copy";
import { UNKNOWN_HEADLINE, UNKNOWN_RED_FLAG_NOTE } from "../lib/shell-copy";
import type { UnknownReceiptState } from "../lib/wire";
import Details from "./details";
import HashValue from "./hash-value";
import NonGreenMasthead from "./nongreen-masthead";

/** 404: a plain word and line, the ID with its copy button; the spec wording is in Details. */
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
				<p className="text-[13px] leading-relaxed text-white/70">{UNKNOWN_RED_FLAG_NOTE}</p>
			</Details>
		</section>
	);
}
