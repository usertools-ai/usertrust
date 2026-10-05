import TerminalFrame from "../../components/terminal-frame";
import { plainState } from "../lib/plain-copy";
import {
	integrityCauseHeadline,
	stepOrCheckLabel,
	UNVERIFIABLE_ALERTS_INTERNALLY,
} from "../lib/shell-copy";
import type { IntegrityFailureState } from "../lib/wire";
import CheckLedger from "./check-ledger";
import Details from "./details";
import HashValue from "./hash-value";
import NonGreenMasthead from "./nongreen-masthead";

/**
 * 409 / page-side R1/R3/R4/R39: "Not verified" and one plain line, with the
 * short ID and its copy button. The spec's own headline, the failing checks and
 * the full ledger are in Details. The page-side causes keep their own line so a
 * page-side catch is never worded as a resolver-side incident.
 */
export default function IntegrityFailureStateView({ state }: { state: IntegrityFailureState }) {
	const { cause } = state;
	const plain = plainState(state);
	return (
		<section
			data-state="integrityFailure"
			data-cause-source={cause.source}
			className="flex flex-col gap-6"
		>
			<NonGreenMasthead word={plain.word} register={plain.register}>
				<p className="text-[13px] leading-relaxed text-white/70">{plain.line}</p>
			</NonGreenMasthead>

			{state.receiptId ? (
				<p className="font-mono text-[13px]" data-testid="integrity-failure-id">
					<HashValue value={state.receiptId} label="receipt ID" />
				</p>
			) : null}

			<Details>
				<p className="text-white/85">{integrityCauseHeadline(cause)}</p>
				{cause.source === "resolver" ? (
					<p className="text-[13px] leading-relaxed text-white/70">
						{UNVERIFIABLE_ALERTS_INTERNALLY}
					</p>
				) : null}
				<div data-testid="integrity-diagnostic">
					<TerminalFrame title="diagnostic detail" tone="error">
						{cause.source === "resolver" ? (
							<ul className="flex flex-col gap-2" data-testid="failed-checks">
								{cause.failed.map((entry) => (
									<li key={entry.name} className="text-danger-ink">
										<a
											href={`#check-${entry.name}`}
											className="focus-ring underline decoration-danger-ink/50 underline-offset-2"
										>
											{stepOrCheckLabel(entry.name)}
										</a>{" "}
										— <span data-failure={entry.failure}>{entry.failure}</span>
									</li>
								))}
							</ul>
						) : (
							<p className="text-white/85" data-obligation={cause.obligation}>
								{cause.detail}
							</p>
						)}
					</TerminalFrame>
				</div>
				{cause.source === "resolver" ? <CheckLedger verification={cause.verification} /> : null}
			</Details>
		</section>
	);
}
