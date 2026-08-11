import {
	INVALID_ID_HEADLINE,
	INVALID_ID_NEVER_ASKED,
	INVALID_ID_RULE_NOTE,
} from "../lib/shell-copy";
import type { InvalidIdState } from "../lib/wire";
import NonGreenMasthead from "./nongreen-masthead";

/**
 * §7 — "Invalid ID (local, R2)": "not a valid receipt ID" with the §12 rule
 * stated. Neutral register — this is a malformed URL, not a signal about
 * anything the resolver knows; D4 guarantees the resolver was never even
 * asked, and the copy says so.
 */
export default function InvalidIdStateView({ state }: { state: InvalidIdState }) {
	return (
		<section data-state="invalidId" className="flex flex-col gap-6">
			<NonGreenMasthead word={INVALID_ID_HEADLINE} register="neutral">
				<p className="text-[13px] leading-relaxed text-white/70" data-testid="invalid-id-reason">
					{state.reason}
				</p>
				<p className="text-[13px] leading-relaxed text-white/70">{INVALID_ID_RULE_NOTE}</p>
				<p className="text-[13px] leading-relaxed text-white/70">{INVALID_ID_NEVER_ASKED}</p>
			</NonGreenMasthead>
			<p
				className="font-mono text-[12px] break-all text-white/50"
				data-testid="invalid-route-param"
			>
				{state.routeParamId}
			</p>
		</section>
	);
}
