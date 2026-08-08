/**
 * Trust-ladder stage tag (Addendum D3): ENFORCE → RECORD → ANCHOR → VERIFY.
 * 11px mono uppercase tracked chip with the emerald-8% border. Server
 * component — a static finished state, no motion, so reduced-motion needs no
 * branch. Dark ground only: emerald is a data ink on dark, never on paper.
 */
export default function StageTag({ stage }: { stage: "ENFORCE" | "RECORD" | "ANCHOR" | "VERIFY" }) {
	return (
		<span className="inline-flex items-center rounded-sm border border-ut/[0.08] bg-ut/[0.04] px-2 py-0.5 font-mono text-xs uppercase tracking-[0.18em] text-ut/80">
			{stage}
		</span>
	);
}
