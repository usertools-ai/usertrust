"use client";

import { useEffect, useRef } from "react";

/**
 * THE GOVERNANCE DIE — Exhibit B set-piece.
 *
 * Inline SVG circuit, TigerBeetle-chip grade: three provider traces route
 * into a central die carrying the usertrust mark; one output trace exits as
 * receipts. All motion is pure CSS (globals.css: die-pulse stroke-dashoffset
 * on layered strokes — no filters, no JS animation). This wrapper's only job
 * is the IO gate: it flips data-active so CSS runs the pulses in view and
 * pauses them offscreen. Reduced motion is handled entirely in CSS (static
 * glowing traces).
 *
 * check-facts: every digit-bearing line below is SVG geometry (d= / x= / y= /
 * cx= / width= / viewBox= ...) or carries className= — ALLOWLIST syntax. No
 * product claims render here.
 */
export default function ExhibitBDie() {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const io = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				el.setAttribute("data-active", entry.isIntersecting ? "true" : "false");
			}
		});
		io.observe(el);
		return () => io.disconnect();
	}, []);

	return (
		<div ref={ref} data-active="false" className="die-figure mx-auto w-full max-w-xl">
			<svg
				viewBox="0 0 900 700"
				role="img"
				aria-label="circuit diagram: the anthropic, openai, and google SDK traces route into the usertrust governance die and exit as a single receipts trace"
				className="block h-auto w-full"
			>
				{/* soft emerald glow — layered rects, opacity only, no filter */}
				<rect x={404} y={194} width={312} height={312} rx={44} className="die-glow-outer" />
				<rect x={432} y={222} width={256} height={256} rx={34} className="die-glow-mid" />
				<rect x={448} y={238} width={224} height={224} rx={28} className="die-glow-inner" />

				{/* input traces — base layer (always-on faint emerald) */}
				<path d="M 40 130 H 320 V 300 H 460" className="die-trace-base" />
				<path d="M 40 350 H 460" className="die-trace-base" />
				<path d="M 40 570 H 320 V 400 H 460" className="die-trace-base" />
				{/* output trace — base layer */}
				<path d="M 660 350 H 860" className="die-trace-base" />

				{/* input traces — pulse layer, staggered per-trace */}
				<path d="M 40 130 H 320 V 300 H 460" className="die-trace-pulse die-delay-a" />
				<path d="M 40 350 H 460" className="die-trace-pulse die-delay-b" />
				<path d="M 40 570 H 320 V 400 H 460" className="die-trace-pulse die-delay-c" />
				{/* output trace — pulses brighter: emerald pulse + bright core dash */}
				<path d="M 660 350 H 860" className="die-trace-pulse" />
				<path d="M 660 350 H 860" className="die-trace-pulse-bright" />

				{/* trace terminals */}
				<circle cx={40} cy={130} r={5} className="die-pad" />
				<circle cx={40} cy={350} r={5} className="die-pad" />
				<circle cx={40} cy={570} r={5} className="die-pad" />
				<circle cx={860} cy={350} r={5} className="die-pad" />

				{/* unconnected pin stubs — top and bottom edges of the die */}
				<path d="M 500 250 V 230" className="die-pin" />
				<path d="M 540 250 V 230" className="die-pin" />
				<path d="M 580 250 V 230" className="die-pin" />
				<path d="M 620 250 V 230" className="die-pin" />
				<path d="M 500 450 V 470" className="die-pin" />
				<path d="M 540 450 V 470" className="die-pin" />
				<path d="M 580 450 V 470" className="die-pin" />
				<path d="M 620 450 V 470" className="die-pin" />

				{/* the die — rounded square carrying the wordmark */}
				<rect x={460} y={250} width={200} height={200} rx={24} className="die-body" />
				<rect x={476} y={266} width={168} height={168} rx={16} className="die-body-inner" />
				<text x={560} y={376} textAnchor="middle" className="die-mark">
					ut
				</text>

				{/* labels — 11px mono uppercase (styling in globals.css .die-label) */}
				<text x={40} y={108} className="die-label">
					anthropic
				</text>
				<text x={40} y={328} className="die-label">
					openai
				</text>
				<text x={40} y={548} className="die-label">
					google
				</text>
				<text x={860} y={328} textAnchor="end" className="die-label die-label-out">
					receipts
				</text>
			</svg>
		</div>
	);
}
