"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { TickerFragment } from "./lib/ledger-ticker";

/**
 * The strip itself (Addendum O). A client island for exactly one reason: the
 * IntersectionObserver that pauses the marquee while it is off screen. It owns
 * no data — the fragments arrive fully derived from the server component, the
 * same division exhibit A's receipt switcher uses.
 *
 * MOTION DOCTRINE, AMENDED. The doctrine allows exactly two looping animations
 * on this page (the ambient video and the die's trace pulses). Addendum O
 * adds a third, and it is held to the identical discipline both of those are:
 * transform-only so it composites and never repaints, `animation-play-state:
 * paused` whenever the strip is off screen, and NO animation at all under
 * reduced motion — where the strip renders as a static row of fragments, which
 * is a finished state, not a disabled feature.
 *
 * The loop is seamless because the track holds the fragment list more than
 * once and translates by exactly one copy: at the end of a period, copy two
 * sits precisely where copy one started, so the reset is invisible. Every copy
 * is aria-hidden (see the summary in the parent) because a screen reader
 * reading thirty hash prefixes three times is noise, not evidence.
 */
/**
 * The passes of the fragment list, named rather than indexed.
 *
 * HOW MANY, AND WHY IT IS NOT TWO. The track travels exactly ONE run per
 * period and then snaps back, so the copies that have not yet moved past the
 * left edge are all that covers the strip at the end of a cycle: the widest
 * strip that can never show a blank band is runW times ONE FEWER than the run
 * count.
 *
 * One run of the published chain measures ~2368px at the shipped fragment set
 * and 12px mono. Two runs therefore covered 2368px — narrower than a 2560px
 * desktop, which is not a hypothetical viewport, and those readers got a band
 * of bare paper sweeping the strip once per period. Three runs cover ~4736px,
 * which clears a 3840px panel with room over.
 *
 * The travel is DERIVED from this number rather than restated: the count goes
 * to CSS as `--ledger-runs` and the keyframe translates by
 * `-100% / var(--ledger-runs)`. Add or remove a pass and the animation follows;
 * there is no percentage in globals.css left to forget.
 */
const RUNS = ["lead", "middle", "trail"] as const;

export default function LedgerTickerStrip({ fragments }: { fragments: TickerFragment[] }) {
	const ref = useRef<HTMLDivElement>(null);
	const [onscreen, setOnscreen] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver(
			([entry]) => setOnscreen(entry.isIntersecting),
			// No threshold: a strip this short is either in the scroll window or
			// it is not, and a partial-visibility threshold would leave it
			// animating in the sliver above the fold.
			{ rootMargin: "0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	return (
		<div ref={ref} data-play={onscreen} className="ledger-strip">
			<span aria-hidden="true" className="ledger-perf ledger-perf--top" />
			<div className="ledger-strip-window">
				<div
					className="ledger-strip-track"
					style={{ "--ledger-runs": RUNS.length } as CSSProperties}
				>
					{RUNS.map((run) => (
						<div key={run} aria-hidden="true" className="ledger-strip-run">
							{fragments.map((f) => (
								<span key={f.key} className="ledger-frag">
									<span className="ledger-frag-kind">{f.kind}</span>
									<span className="ledger-frag-sep">·</span>
									<span>{f.ref}</span>
									<span className="ledger-frag-sep">·</span>
									<span>{f.hash}</span>
								</span>
							))}
						</div>
					))}
				</div>
			</div>
			<span aria-hidden="true" className="ledger-perf ledger-perf--bottom" />
		</div>
	);
}
