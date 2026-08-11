import { UNKNOWN_HEADLINE, UNKNOWN_RED_FLAG_NOTE } from "../lib/shell-copy";
import type { UnknownReceiptState } from "../lib/wire";
import HashValue from "./hash-value";
import NonGreenMasthead from "./nongreen-masthead";

/**
 * §7 — `unknown` (404): "This receipt ID was never allocated." Rendered
 * LOUDLY per the resolver's fail-closed convention — full danger register,
 * no stamp/paper motif (there was never anything to stamp: the ID does not
 * exist in the registry at all, which is a different claim than "this
 * reservation existed and ended").
 */
export default function UnknownReceiptStateView({ state }: { state: UnknownReceiptState }) {
	return (
		<section data-state="unknownReceipt" className="flex flex-col gap-6">
			<NonGreenMasthead word={UNKNOWN_HEADLINE} register="danger">
				<p className="text-[13px] leading-relaxed text-white/70">{UNKNOWN_RED_FLAG_NOTE}</p>
			</NonGreenMasthead>
			<p className="font-mono text-[13px]" data-testid="unknown-id">
				<HashValue value={state.receiptId} label="receipt ID" />
			</p>
		</section>
	);
}
