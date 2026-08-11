import { advisoryBand } from "../lib/claims";
import type { Advisory } from "../lib/wire";

/**
 * §6.4 — advisory band(s), rendered BETWEEN the masthead and the artifact.
 *
 * The register is the whole obligation: **amber, never red, never green**
 * (R33/R34, §6.4). An advisory is not a failure and not a pass — it is a fact
 * about the world that arrived after the receipt was signed, and rendering it
 * in either verdict color would make it look like it moved the verdict, which
 * §4.1 says no advisory ever does ("no member of this array ever alters the
 * verdict or its rendering register").
 *
 * `--color-warning` at 12-14px measures 9.13:1 on the page ground, so amber
 * text needs no lightened ink variant the way small danger red does (the H2
 * rule); the body copy still renders at white/70 rather than amber, because a
 * whole paragraph in accent color reads as an alarm.
 *
 * Unknown kinds are rendered generically and NEVER dropped (§4.1) — that path
 * lives in `advisoryBand`, so a future resolver member surfaces here on the day
 * it ships rather than on the day this component learns about it.
 */
export default function AdvisoryBands({ advisories }: { advisories: Advisory[] }) {
	if (advisories.length === 0) return null;
	return (
		<div className="flex flex-col gap-3" data-testid="advisory-bands">
			{advisories.map((advisory) => {
				const band = advisoryBand(advisory);
				return (
					<aside
						// Advisory arrays legitimately repeat a KIND (two generation addenda
						// on one receipt) and no member carries an identity field of its own,
						// so the key is derived from the band's CONTENT: kind, the receipt it
						// links to, and the rendered body. Two addenda for different
						// generations differ in all three. The array index would be a
						// re-render hazard the moment the resolver reorders the list.
						key={`${band.kind}|${band.linkedReceiptId ?? ""}|${band.body}`}
						data-advisory={band.kind}
						className="lift-1 rounded-lg border border-warning/40 bg-warning/[0.07] p-4"
					>
						<p className="font-mono text-[12px] uppercase tracking-[0.12em] text-warning">
							{band.title}
						</p>
						<p className="mt-2 text-[13px] leading-relaxed text-white/85">{band.body}</p>
						{band.linkedReceiptId ? (
							<p className="mt-2 font-mono text-[12px] text-white/70">
								<a
									className="focus-ring underline decoration-warning/50 underline-offset-2 hover:text-white"
									href={`/r/${band.linkedReceiptId}`}
								>
									{band.linkedReceiptId}
								</a>
							</p>
						) : null}
					</aside>
				);
			})}
		</div>
	);
}
