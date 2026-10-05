import TerminalFrame from "../../components/terminal-frame";
import { plainState } from "../lib/plain-copy";
import { PROTOCOL_ERROR_HEADLINE } from "../lib/shell-copy";
import type { ProtocolErrorState } from "../lib/wire";
import Details from "./details";
import NonGreenMasthead from "./nongreen-masthead";
import RetryAffordance from "./retry-affordance";

/** Local R37 shell: a plain word and line and a retry; the diagnostic is in Details. */
export default function ProtocolErrorStateView({ state }: { state: ProtocolErrorState }) {
	const plain = plainState(state);
	return (
		<section data-state="protocolError" data-reason={state.reason} className="flex flex-col gap-6">
			<NonGreenMasthead word={plain.word} register={plain.register}>
				<p className="text-[13px] leading-relaxed text-white/70">{plain.line}</p>
			</NonGreenMasthead>
			<RetryAffordance routeParamId={state.routeParamId} />
			<Details>
				<p className="text-white/85">{PROTOCOL_ERROR_HEADLINE}</p>
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
			</Details>
		</section>
	);
}
