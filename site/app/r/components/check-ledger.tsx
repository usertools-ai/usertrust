import {
	EXTENSION_FAILURE_MEANING,
	LEDGER_ROWS,
	LEDGER_SHOWS_THE_INPUTS,
	type LedgerRow,
	NOT_APPLICABLE_MEANING,
	RESULT_GLYPH,
	RESULT_LABEL,
	trustSnapshotLine,
	UNAVAILABLE_MEANING,
} from "../lib/claims";
import type { CheckEntry, CheckName, StepName, StepResult, Verification } from "../lib/wire";

/**
 * §6.3 — the check ledger: check name, four-valued result, one-line meaning.
 *
 * This table is R9's whole point. "The verdict is a function of these results
 * and the page shows the function's inputs, not just its output" — so all
 * thirteen entries render, always, including the boring passes. A ledger that
 * hid its `passed` rows would be a summary, and a summary is exactly what R9
 * refuses.
 *
 * The MEANINGS carry the epistemic labels (§6.3, R26, P2-7): attested-enum rows
 * read as chain-committed claims, never as facts the verifier established, and
 * `repositoryMembership` reads as the minter's committed observation. Those
 * sentences live in `claims.ts` and are pinned there.
 *
 * Color follows the H2 rule and never carries meaning alone:
 *   - `passed` — emerald (10.2:1 on the page ground);
 *   - `failed` — `--color-danger-ink` (7.09:1), the ONE sanctioned red for
 *     12-14px text; full `--color-danger` would measure 3.5:1 here;
 *   - `unavailable` — amber (9.13:1);
 *   - `notApplicable` — white/70 (9.7:1) and an EM DASH, never a tick (R12).
 * Every row also renders the four-valued WORD, so the result survives
 * grayscale, color-blindness, and a screen reader.
 *
 * **Keyboard / aria** (states pass, §7's `unverifiable`/409 rendering): every
 * row carries an `id` (`check-<name>`) a caller can link straight to — the
 * 409 state names ONE row as THE failed check, and a reader arriving via a
 * "jump to the failed check" link needs a real, keyboard-reachable target,
 * not just a color change somewhere down the page. The table itself is
 * labeled as a landmark via `aria-labelledby`, pointing at its own visible
 * title bar rather than a duplicate `aria-label` string that could drift
 * from it.
 */

const RESULT_INK: Record<StepResult, string> = {
	passed: "text-ut",
	failed: "text-danger-ink",
	notApplicable: "text-white/70",
	unavailable: "text-warning",
};

/**
 * R10/R11/R12 — the three results that need a sentence beside them. A `passed`
 * row needs none: the row's own meaning already says what passed.
 */
function resultNote(name: StepName | CheckName, entry: CheckEntry): string | null {
	switch (entry.result) {
		case "notApplicable":
			return NOT_APPLICABLE_MEANING;
		case "unavailable":
			return UNAVAILABLE_MEANING;
		case "failed":
			return name === "checkpointHistory" || name === "anchorEvidence"
				? EXTENSION_FAILURE_MEANING
				: null;
		default:
			return null;
	}
}

export default function CheckLedger({
	verification,
	membershipNote,
	rows = LEDGER_ROWS,
}: {
	verification: Verification;
	/** R26 — the minter's committed observation, when the work variant has one. */
	membershipNote?: string;
	/**
	 * The thirteen rows with the meanings for THIS receipt's kind. A cluster
	 * receipt's ID is derived, not issued, and its predecessor is the agent
	 * key's previous receipt, not a generation; printing the session meanings
	 * beside its results would explain checks the resolver did not run.
	 */
	rows?: readonly LedgerRow[];
}) {
	return (
		<section
			className="lift-1 rounded-xl border border-white/10 bg-[var(--surface,#101012)]"
			data-testid="check-ledger"
			aria-labelledby="check-ledger-title"
		>
			<div
				id="check-ledger-title"
				className="flex h-9 items-center border-b border-white/[0.06] px-4 font-mono text-[12px] uppercase tracking-[0.12em] text-white/70"
			>
				check ledger
			</div>

			<p className="px-4 pt-4 text-[13px] leading-relaxed text-white/70">
				{LEDGER_SHOWS_THE_INPUTS}
			</p>

			{/* Below 640px each row stacks (check, result, meaning) and the column
			    headers are hidden: three columns of long mono names do not fit a
			    phone, and the page must never scroll sideways. */}
			<table className="mt-3 w-full border-collapse text-left max-sm:block">
				<caption className="sr-only">
					every verification step and named online check, with its four-valued result
				</caption>
				<thead className="max-sm:hidden">
					<tr className="border-b border-white/[0.06]">
						<th
							scope="col"
							className="px-4 py-2 font-mono text-[12px] font-normal uppercase tracking-[0.12em] text-white/70"
						>
							check
						</th>
						<th
							scope="col"
							className="px-4 py-2 font-mono text-[12px] font-normal uppercase tracking-[0.12em] text-white/70"
						>
							result
						</th>
						<th
							scope="col"
							className="px-4 py-2 font-mono text-[12px] font-normal uppercase tracking-[0.12em] text-white/70"
						>
							meaning
						</th>
					</tr>
				</thead>
				<tbody className="max-sm:block">
					{rows.map((row) => {
						const entry =
							row.group === "steps"
								? verification.steps[row.name as StepName]
								: verification.checks[row.name as CheckName];
						const note = resultNote(row.name, entry);
						return (
							<tr
								key={row.name}
								id={`check-${row.name}`}
								data-check={row.name}
								className="scroll-mt-6 border-b border-white/[0.04] align-top target:bg-white/[0.06] max-sm:block max-sm:py-2"
							>
								<th
									scope="row"
									className="px-4 py-3 font-mono text-[12px] font-normal uppercase tracking-[0.12em] text-white/70 [overflow-wrap:anywhere] max-sm:block max-sm:pt-1 max-sm:pb-0"
								>
									{row.label}
								</th>
								<td
									className={`px-4 py-3 font-mono text-[12px] tracking-[0.12em] max-sm:block max-sm:py-1 ${RESULT_INK[entry.result]}`}
								>
									<span aria-hidden="true">{RESULT_GLYPH[entry.result]} </span>
									<span data-result={entry.result}>{RESULT_LABEL[entry.result]}</span>
									{entry.failure ? (
										<span className="ml-2 text-danger-ink" data-failure={entry.failure}>
											{entry.failure}
										</span>
									) : null}
								</td>
								<td className="px-4 py-3 text-[13px] leading-relaxed text-white/85 max-sm:block max-sm:pt-0">
									{row.meaning}
									{note ? <span className="mt-1 block text-white/70">{note}</span> : null}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>

			{membershipNote ? (
				<p
					data-testid="membership-note"
					className="border-t border-white/[0.06] px-4 py-3 text-[13px] leading-relaxed text-white/70"
				>
					{membershipNote}
				</p>
			) : null}

			{/* R9 — verdicts are relative to a pinned snapshot, and the verifier
			    says which one (receipt-spec §8). */}
			<p
				data-testid="trust-snapshot"
				className="border-t border-white/[0.06] px-4 py-3 font-mono text-[12px] tracking-wide text-white/70 [overflow-wrap:anywhere]"
			>
				{trustSnapshotLine(verification.trustSnapshotId)}
			</p>
		</section>
	);
}
