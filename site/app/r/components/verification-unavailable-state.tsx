import { plainState } from "../lib/plain-copy";
import { VERIFICATION_UNAVAILABLE_HEADLINE } from "../lib/shell-copy";
import type { VerificationUnavailableState } from "../lib/wire";
import Details from "./details";
import NonGreenMasthead from "./nongreen-masthead";
import RetryAffordance from "./retry-affordance";

export default function VerificationUnavailableStateView({
	state,
}: {
	state: VerificationUnavailableState;
}) {
	const plain = plainState(state);
	return (
		<section data-state="verificationUnavailable" className="flex flex-col gap-6">
			<NonGreenMasthead word={plain.word} register={plain.register}>
				<p className="text-[13px] leading-relaxed text-white/70">{plain.line}</p>
			</NonGreenMasthead>
			<RetryAffordance routeParamId={state.routeParamId} retryAfter={state.retryAfter} />
			<Details>
				<p className="text-white/85">{VERIFICATION_UNAVAILABLE_HEADLINE}</p>
			</Details>
		</section>
	);
}
