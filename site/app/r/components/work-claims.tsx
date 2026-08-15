import { NEVER_ARTIFACT_VERIFIED, type ReceiptClaims } from "../lib/claims";
import { SessionHeadlineScope } from "./posture-chips";

/**
 * R13/R14/R15 — "verify against your artifact".
 *
 * This panel is the page's answer to the one thing it CANNOT do. Every verdict
 * on this page is about the RECEIPT; none of them says the receipt belongs to
 * the artifact that showed it to you (receipt-spec §7, the B2 transplant rule).
 * The page has no containing artifact — so instead of performing the
 * comparison, it renders the comparison IN FULL and leaves the reader to make
 * it.
 *
 * "In full" is the obligation (R15): the teaching "must teach the SAFE check,
 * not a transplantable subset". A commit panel that showed only OID equality
 * would be worse than no panel, because a reader would walk away believing they
 * had checked something — which is precisely the hole `objectSha256` exists to
 * close. The `claims.ts` module owns the sentences; this component owns only
 * their arrangement.
 */
export default function WorkClaims({ claims }: { claims: ReceiptClaims }) {
	return (
		<section
			className="lift-1 rounded-xl border border-white/10 bg-white/[0.02]"
			data-testid="work-claims"
		>
			<div className="flex h-9 items-center border-b border-white/[0.06] px-4 font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
				verify against your artifact
			</div>

			<div className="flex flex-col gap-4 p-4">
				<p className="text-[13px] leading-relaxed text-white/85" data-testid="scope-claim">
					{claims.headline}
				</p>
				{claims.work.kind === "session" ? (
					<SessionHeadlineScope claims={claims} tone="dark" />
				) : null}
				<p className="text-[13px] leading-relaxed text-white/70">{NEVER_ARTIFACT_VERIFIED}</p>

				<dl className="flex flex-col gap-4">
					{claims.comparison.map((step) => (
						<div key={step.axis} data-comparison-axis={step.axis} className="flex flex-col gap-1">
							<dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
								{step.axis}
							</dt>
							<dd className="text-[13px] leading-relaxed text-white/85">{step.body}</dd>
						</div>
					))}
				</dl>
			</div>
		</section>
	);
}
