import { POSTURES_ARE_ATTESTED_ENUMS, type PostureClaim, type ReceiptClaims } from "../lib/claims";

/**
 * R20-R22 — the three postures, rendered ON PAPER as the attested claims they
 * are.
 *
 * **Distinct rendering is the obligation, not a preference.** §6a says
 * "identical rendering is forbidden" for the two `sessionAssociation` postures,
 * so `workflowAttested` and `ownerAsserted` differ in THREE independent
 * channels here — label text, chip treatment (filled vs outlined), and ink —
 * and the distinction is driven by the posture VALUE alone, so it holds across
 * every `work.kind`. An `ownerAsserted` commit and a `workflowAttested` session
 * both render their true posture, which is the pairing §8's C9/C17 rows exist
 * to catch. The same rule is applied to the spend postures: the enum values
 * that carry a caveat (`estimated`/`mixed`, `conservative`) take the amber ink,
 * the ones that do not take steel.
 *
 * **The epistemic frame renders WITH them.** A posture chip in isolation reads
 * like a measurement; `POSTURES_ARE_ATTESTED_ENUMS` is the sentence that stops
 * it, and it renders above the chips rather than inside a tooltip.
 *
 * Paper ink only: the bright dark-ground accents measure 1.67-3.27:1 on
 * `--color-paper` and are forbidden as text there (globals.css). The paper-*
 * variants used here are the contrast-gate-validated set (emerald 5.65:1,
 * amber 6.32:1, steel 6.77:1, and `--color-paper` reversed out of paper-emerald
 * at the same 5.65:1).
 */

function PostureRow({
	axis,
	posture,
	chipClass,
	children,
}: {
	/**
	 * The posture AXIS — rendered as its own label so the chip is never bare.
	 * Named `axis` rather than `role`: a prop literally called `role` on a JSX
	 * element trips `a11y/useValidAriaRole`, and suppressing an accessibility
	 * rule to keep a prop name is the wrong trade.
	 */
	axis: string;
	posture: PostureClaim;
	chipClass: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1" data-posture-role={axis} data-posture={posture.value}>
			<div className="flex flex-wrap items-baseline gap-2">
				<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-ink/70">
					{axis}
				</span>
				<span
					className={`inline-block rounded-sm border px-2 py-0.5 font-mono text-[12px] uppercase tracking-[0.12em] ${chipClass}`}
				>
					{posture.label}
				</span>
			</div>
			<p className="text-[13px] leading-relaxed text-ink/70">{posture.claim}</p>
			{posture.caveat ? (
				<p
					className="text-[13px] font-bold leading-relaxed text-paper-amber"
					data-posture-caveat=""
				>
					{posture.caveat}
				</p>
			) : null}
			{children}
		</div>
	);
}

/** Filled = attested by a system; outlined = asserted by a human or a fallback. */
const ATTESTED_CHIP = "border-paper-emerald bg-paper-emerald font-bold text-paper";
const ASSERTED_CHIP = "border-paper-steel/60 font-normal text-paper-steel";
const CAVEATED_CHIP = "border-paper-amber/60 font-normal text-paper-amber";

/**
 * R38/R39/R40 — the amount's SCOPE, rendered beside the amount it qualifies.
 *
 * Position is part of the obligation, not layout taste. R40's floor claim and
 * R39's scope statement both render "beside the amount, never as a footnote and
 * never behind interaction" — so this block sits directly under the figure in
 * `SpendBlock`, above every other spend field, and there is deliberately no
 * `<details>`, no tooltip and no `title` attribute anywhere in it. The other
 * three postures stay at the foot of the block, where they have always been.
 *
 * The FLOOR line renders only where `amountFloorClaim` grants one. A posture
 * that does not earn a bound gets its R39 copy alone — an `indeterminate`
 * amount bounds nothing in either direction, and printing "at least $X" over it
 * would be a new overclaim rather than a missing nicety.
 *
 * INTERIM: the floor wording retires on parent-stamping, which turns the figure
 * into an exact total; `amountFloorClaim` is the single site to change.
 */
export function AmountScope({ claims }: { claims: ReceiptClaims }) {
	return (
		<div className="flex flex-col gap-2" data-testid="amount-scope">
			{claims.amountFloor ? (
				<p
					className="text-[13px] font-bold leading-relaxed text-ink"
					data-testid="amount-floor"
					data-amount-bound="floor"
				>
					{claims.amountFloor}
				</p>
			) : null}
			<PostureRow axis="amount scope" posture={claims.delegation} chipClass={ASSERTED_CHIP} />
		</div>
	);
}

export default function PostureChips({ claims }: { claims: ReceiptClaims }) {
	const { association, usage, pricing } = claims;
	return (
		<div className="flex flex-col gap-4" data-testid="postures">
			<p className="text-[13px] leading-relaxed text-ink/70">{POSTURES_ARE_ATTESTED_ENUMS}</p>

			<PostureRow
				axis="session association"
				posture={association}
				chipClass={association.weight === "attested" ? ATTESTED_CHIP : ASSERTED_CHIP}
			>
				{association.workloadId ? (
					<p className="font-mono text-[12px] text-ink/70">
						workloadId <span className="text-ink">{association.workloadId}</span>
					</p>
				) : null}
			</PostureRow>

			<PostureRow
				axis="usage posture"
				posture={usage}
				chipClass={usage.caveat ? CAVEATED_CHIP : ASSERTED_CHIP}
			/>
			<PostureRow
				axis="pricing posture"
				posture={pricing}
				chipClass={pricing.value === "conservative" ? CAVEATED_CHIP : ASSERTED_CHIP}
			/>
		</div>
	);
}
