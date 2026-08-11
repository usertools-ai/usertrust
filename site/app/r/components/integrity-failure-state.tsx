import TerminalFrame from "../../components/terminal-frame";
import {
	integrityCauseHeadline,
	stepOrCheckLabel,
	UNVERIFIABLE_ALERTS_INTERNALLY,
} from "../lib/shell-copy";
import type { IntegrityFailureState } from "../lib/wire";
import CheckLedger from "./check-ledger";
import HashValue from "./hash-value";
import NonGreenMasthead from "./nongreen-masthead";

/**
 * §7 — `unverifiable` (409): "integrity failure: ... the failed step named
 * from the body's `verification` member. Full danger treatment, error-tone
 * TerminalFrame for diagnostic detail. Also the rendering for R1/R3/R4
 * identity- and byte-binding failures detected page-side."
 *
 * Two sources share this ONE danger-register state (`IntegrityCause`,
 * `wire.ts`), and they get DIFFERENT diagnostic content because they mean
 * different things:
 *
 *   - `source: "resolver"` — the resolver computed a `verification` member
 *     and answered 409 itself. The FULL check ledger renders (R9's "the
 *     page shows the function's inputs, not just its output" applies here
 *     too — a 409 is not exempt from naming every result, not only the
 *     failed one), and the error-tone `TerminalFrame` names exactly which
 *     step(s)/check(s) failed with their closed-union failure codes,
 *     each linking to its row in the ledger below (keyboard-reachable:
 *     a plain `<a href="#check-...">`, no JS required).
 *   - `source: "page"` — the PAGE's own R1/R3/R4 checks caught the problem
 *     before the resolver's own verdict could be trusted at all (an ID
 *     that does not match what was asked, a `billedUnfinalized` bundle
 *     whose cross-checks do not hold, or `receiptBytes` disagreeing with
 *     `receipt`). There is no `verification` member to show — the page
 *     never got far enough to run the resolver's own checks — so this
 *     path renders the diagnostic `detail` string alone, still inside the
 *     same error-tone `TerminalFrame`.
 */
export default function IntegrityFailureStateView({ state }: { state: IntegrityFailureState }) {
	const { cause } = state;
	return (
		<section
			data-state="integrityFailure"
			data-cause-source={cause.source}
			className="flex flex-col gap-6"
		>
			<NonGreenMasthead word={integrityCauseHeadline(cause)} register="danger">
				{cause.source === "resolver" ? (
					<p className="text-[13px] leading-relaxed text-white/70">
						{UNVERIFIABLE_ALERTS_INTERNALLY}
					</p>
				) : null}
			</NonGreenMasthead>

			{state.receiptId ? (
				<p className="font-mono text-[13px]" data-testid="integrity-failure-id">
					<HashValue value={state.receiptId} label="receipt ID" />
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
		</section>
	);
}
