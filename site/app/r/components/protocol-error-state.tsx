import TerminalFrame from "../../components/terminal-frame";
import { PROTOCOL_ERROR_HEADLINE } from "../lib/shell-copy";
import type { ProtocolErrorState } from "../lib/wire";
import NonGreenMasthead from "./nongreen-masthead";
import RetryAffordance from "./retry-affordance";

/**
 * §7 — "Protocol error (local, R37)": "could not obtain a trustworthy
 * answer from the resolver" ... "Neutral-danger register, retry affordance,
 * wording distinct from 503's (that state is the resolver speaking; this
 * one is the page unable to trust what it heard)."
 *
 * `reason` is R37's own enumeration (timeout, malformed body, an
 * HTTP/status mismatch, a §4.1 verdict-algebra violation, ...) — rendered
 * as machine-readable diagnostic detail in the SAME error-tone
 * `TerminalFrame` the 409 state uses, because it is the same kind of
 * information (why the page refused to render), never the headline itself.
 */
export default function ProtocolErrorStateView({ state }: { state: ProtocolErrorState }) {
	return (
		<section data-state="protocolError" data-reason={state.reason} className="flex flex-col gap-6">
			<NonGreenMasthead word={PROTOCOL_ERROR_HEADLINE} register="danger" />
			<div data-testid="protocol-error-diagnostic">
				<TerminalFrame title="diagnostic detail" tone="error">
					<p className="text-white/85">
						<span data-reason={state.reason} className="text-danger-ink">
							{state.reason}
						</span>
						{state.httpStatus !== undefined ? (
							<span className="text-white/70"> (HTTP {state.httpStatus})</span>
						) : null}
					</p>
					<p className="mt-2 text-white/70">{state.detail}</p>
				</TerminalFrame>
			</div>
			<RetryAffordance routeParamId={state.routeParamId} />
		</section>
	);
}
