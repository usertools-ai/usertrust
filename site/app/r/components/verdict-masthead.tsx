import {
	ANCHOR_BINDING_RESOLVER_ASSERTED,
	LADDER,
	RUNG_EARNED_BY,
	RUNG_SHORT_NAME,
	RUNG_VERDICT_WORD,
	rungDisclaimers,
} from "../lib/claims";
import type { LadderStatus } from "../lib/wire";

/**
 * §6.1 — the verdict masthead: Khand display voice, the verdict word large,
 * uppercase, tracked, with the ladder rendered as a three-step indicator.
 *
 * Three design rules from §6 are load-bearing here, not stylistic:
 *
 * **The verdict is never color-only — the word IS the verdict.** Emerald is how
 * the reached rung reads at a glance; `RUNG_VERDICT_WORD` is how it reads to
 * someone who cannot see the emerald, and every rung in the indicator carries a
 * STATUS WORD (`REACHED` / `CLEARED` / `NOT REACHED`) for the same reason.
 *
 * **Which rungs exist ABOVE is part of the verdict (R5).** A floor 200 is a
 * clean green and never an apology — but a page that renders only the rung it
 * reached leaves the reader unable to tell a ceiling from a summit. Each
 * unreached rung is therefore labeled with what would EARN it.
 *
 * **The disclaimers are fine print, not a disclosure widget (§7).** R6's
 * disclaimer is "rendered as the rung's fine print, not hidden behind
 * interaction", so there is no `<details>` here and never should be; the
 * cumulative caveat set for the rung renders in full, always.
 */
export default function VerdictMasthead({ rung }: { rung: LadderStatus }) {
	const reachedIndex = LADDER.indexOf(rung);
	return (
		<header className="flex flex-col gap-6">
			<h1 className="font-display text-4xl leading-none uppercase tracking-[0.08em] text-ut sm:text-6xl">
				{RUNG_VERDICT_WORD[rung]}
			</h1>

			<ol className="grid gap-3 sm:grid-cols-3" aria-label="verification ladder">
				{LADDER.map((step, index) => {
					const state =
						index === reachedIndex ? "reached" : index < reachedIndex ? "cleared" : "above";
					return (
						<li
							key={step}
							data-rung={step}
							data-rung-state={state}
							className={`lift-1 flex flex-col gap-2 rounded-lg border p-4 ${
								state === "above" ? "border-white/15 bg-white/[0.02]" : "border-ut/40 bg-ut/[0.06]"
							}`}
						>
							<span className="flex items-baseline justify-between gap-2">
								<span
									className={`font-mono text-[12px] uppercase tracking-[0.12em] ${
										state === "above" ? "text-white/70" : "text-ut"
									}`}
								>
									{RUNG_SHORT_NAME[step]}
								</span>
								<span
									className={`font-mono text-[12px] uppercase tracking-[0.12em] ${
										state === "above" ? "text-white/70" : "text-ut"
									}`}
								>
									{state === "reached"
										? "REACHED"
										: state === "cleared"
											? "CLEARED"
											: "NOT REACHED"}
								</span>
							</span>
							{state === "above" ? (
								<p className="text-[13px] leading-relaxed text-white/70">
									<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
										earned by:{" "}
									</span>
									{RUNG_EARNED_BY[step]}
								</p>
							) : null}
							{/* R41 — the anchored rung is RESOLVER-ASSERTED, and says so
							    BESIDE the rung, unconditionally: reached or not, the rung's
							    own copy (here and in "earned by") otherwise reads as
							    independently established anchoring. Rendered in the same
							    fine-print voice as the fork disclaimer, never behind
							    interaction, and at exactly ONE site.

							    INTERIM: retires outright once the anchor record is SERVED —
							    the binding check exists, only its evidence is unpublished.
							    Retirement is deleting this block and its constant. */}
							{step === "verified_anchored" ? (
								<p
									className="text-[13px] leading-relaxed text-white/70"
									data-testid="anchor-binding-disclosure"
									data-anchor-binding="resolver-asserted"
								>
									{ANCHOR_BINDING_RESOLVER_ASSERTED}
								</p>
							) : null}
						</li>
					);
				})}
			</ol>

			{/* R6 / R7 / R8 — the rung's cumulative fine print. Rendered in full,
			    in DOM order, at the 12px floor and never below it. */}
			<div
				data-testid="rung-disclaimers"
				className="flex flex-col gap-2 border-l-2 border-ut/30 pl-4"
			>
				{rungDisclaimers(rung).map((line) => (
					<p key={line} className="text-[13px] leading-relaxed text-white/70">
						{line}
					</p>
				))}
			</div>
		</header>
	);
}
