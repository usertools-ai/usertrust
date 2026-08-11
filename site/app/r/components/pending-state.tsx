import {
	RECONCILING_HEADLINE,
	RECONCILING_NO_CACHEABLE_TERMINAL,
	RESERVE_FINALIZE_NOTE,
	RESERVED_HEADLINE,
	RESERVED_NEVER_AN_ERROR,
} from "../lib/shell-copy";
import type { PendingState } from "../lib/wire";
import NonGreenMasthead from "./nongreen-masthead";

/**
 * §7 — "Pending (202, both `no-store`)". Neutral register throughout: no
 * red, no green. `reserved` and `reconciling` share this component because
 * they share the register and the shape (a receiptId and nothing else) —
 * only the headline and the explanatory line differ.
 */
export default function PendingStateView({ state }: { state: PendingState }) {
	const reserved = state.status === "reserved";
	return (
		<section data-state="pending" data-status={state.status} className="flex flex-col gap-6">
			<NonGreenMasthead
				word={reserved ? RESERVED_HEADLINE : RECONCILING_HEADLINE}
				register="neutral"
			>
				<p className="text-[13px] leading-relaxed text-white/70">
					{reserved ? RESERVED_NEVER_AN_ERROR : RECONCILING_NO_CACHEABLE_TERMINAL}
				</p>
				{reserved ? (
					<p className="text-[13px] leading-relaxed text-white/70">{RESERVE_FINALIZE_NOTE}</p>
				) : null}
			</NonGreenMasthead>
			<p className="font-mono text-[12px] tracking-wide text-white/50" data-testid="pending-id">
				{state.receiptId}
			</p>
		</section>
	);
}
