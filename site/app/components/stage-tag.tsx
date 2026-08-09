/**
 * Trust-ladder stage tag (Addendum D3): ENFORCE → RECORD → ANCHOR → VERIFY.
 * 12px mono uppercase tracked chip (the Addendum H1 floor — this comment
 * documented the pre-sweep 11px long after the chip was bumped, which is
 * exactly how a floor regression gets re-introduced) with the emerald-8%
 * border. Server
 * component — a static finished state, no motion, so reduced-motion needs no
 * branch. Dark ground only: emerald is a data ink on dark, never on paper.
 */
export default function StageTag({ stage }: { stage: "ENFORCE" | "RECORD" | "ANCHOR" | "VERIFY" }) {
	return (
		// `stage-tag` is the hook the section-theme rules paint through
		// (Addendum I2): inside a [data-theme] section the chip takes that
		// section's accent, and everywhere else the emerald below stands.
		<span className="stage-tag inline-flex items-center rounded-sm border border-ut/[0.08] bg-ut/[0.04] px-2 py-0.5 font-mono text-xs uppercase tracking-[0.18em] text-ut/80">
			{stage}
		</span>
	);
}
