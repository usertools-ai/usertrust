import { plainState } from "../lib/plain-copy";
import {
	RECONCILING_HEADLINE,
	RECONCILING_NO_CACHEABLE_TERMINAL,
	RESERVE_FINALIZE_NOTE,
	RESERVED_HEADLINE,
	RESERVED_NEVER_AN_ERROR,
} from "../lib/shell-copy";
import type { PendingState } from "../lib/wire";
import Details from "./details";
import NonGreenMasthead from "./nongreen-masthead";

/**
 * §7 — "Pending (202, both `no-store`)". Neutral register throughout: no
 * red, no green. `reserved` and `reconciling` share this component because
 * they share the register and the shape (a receiptId and nothing else) —
 * only the wording differs. The plain word and line lead; the spec's own
 * headline and notes sit in Details.
 */
export default function PendingStateView({ state }: { state: PendingState }) {
	const reserved = state.status === "reserved";
	const plain = plainState(state);
	return (
		<section data-state="pending" data-status={state.status} className="flex flex-col gap-6">
			<NonGreenMasthead word={plain.word} register={plain.register}>
				<p className="text-[13px] leading-relaxed text-white/70">{plain.line}</p>
			</NonGreenMasthead>
			<p className="font-mono text-[12px] tracking-wide text-white/50" data-testid="pending-id">
				{state.receiptId}
			</p>
			<Details>
				<p className="text-white/85">{reserved ? RESERVED_HEADLINE : RECONCILING_HEADLINE}</p>
				<p className="text-[13px] leading-relaxed text-white/70">
					{reserved ? RESERVED_NEVER_AN_ERROR : RECONCILING_NO_CACHEABLE_TERMINAL}
				</p>
				{reserved ? (
					<p className="text-[13px] leading-relaxed text-white/70">{RESERVE_FINALIZE_NOTE}</p>
				) : null}
			</Details>
		</section>
	);
}
