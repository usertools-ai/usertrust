import { RATE_LIMITED_HEADLINE } from "../lib/shell-copy";
import type { RateLimitedState } from "../lib/wire";
import NonGreenMasthead from "./nongreen-masthead";
import RetryAffordance from "./retry-affordance";

/**
 * §7 — 429: "plain rate-limit notice, retry affordance." §4.2's exemption
 * means this state derives from the HTTP status + `Retry-After` alone — the
 * body was never even read (`resolve.ts`) — so there is nothing else to
 * render here.
 */
export default function RateLimitedStateView({ state }: { state: RateLimitedState }) {
	return (
		<section data-state="rateLimited" className="flex flex-col gap-6">
			<NonGreenMasthead word={RATE_LIMITED_HEADLINE} register="neutral" />
			<RetryAffordance routeParamId={state.routeParamId} retryAfter={state.retryAfter} />
		</section>
	);
}
