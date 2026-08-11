import { VERIFICATION_UNAVAILABLE_HEADLINE } from "../lib/shell-copy";
import type { VerificationUnavailableState } from "../lib/wire";
import NonGreenMasthead from "./nongreen-masthead";
import RetryAffordance from "./retry-affordance";

/**
 * §7 — `verificationUnavailable` (503): the §10.4 distinction (R36) —
 * OPERATIONAL, never conflated with `unverifiable`'s 409 integrity wording.
 * Warning (amber) register, `Retry-After` honored via {@link RetryAffordance}.
 */
export default function VerificationUnavailableStateView({
	state,
}: {
	state: VerificationUnavailableState;
}) {
	return (
		<section data-state="verificationUnavailable" className="flex flex-col gap-6">
			<NonGreenMasthead word={VERIFICATION_UNAVAILABLE_HEADLINE} register="warning" />
			<RetryAffordance routeParamId={state.routeParamId} retryAfter={state.retryAfter} />
		</section>
	);
}
