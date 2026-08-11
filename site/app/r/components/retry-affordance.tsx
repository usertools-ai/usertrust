import { retryAfterLine } from "../lib/shell-copy";
import type { RetryAfter } from "../lib/wire";

/**
 * §7's "retry affordance", shared by 503, 429, and the local protocol-error
 * shell — the three states whose copy explicitly asks for one ("Retry-After
 * honored, retry affordance" / "retry affordance" / "retry affordance,
 * wording distinct from 503's").
 *
 * The route is fully dynamic and `no-store` (D1/R35): every render of
 * `/r/<id>` re-fetches the resolver, so "retry" is honestly just "load this
 * URL again" — a plain link, no client JS, nothing to keep in sync with a
 * countdown. That also satisfies "reduced motion" by construction: there is
 * no motion here to reduce.
 */
export default function RetryAffordance({
	routeParamId,
	retryAfter,
}: {
	routeParamId: string;
	retryAfter?: RetryAfter;
}) {
	const line = retryAfterLine(retryAfter);
	return (
		<p className="text-[13px] leading-relaxed text-white/70" data-testid="retry-affordance">
			{line ? <span>{line} </span> : null}
			<a
				className="focus-ring underline decoration-white/40 underline-offset-2 hover:text-white"
				href={`/r/${routeParamId}`}
			>
				retry
			</a>
		</p>
	);
}
