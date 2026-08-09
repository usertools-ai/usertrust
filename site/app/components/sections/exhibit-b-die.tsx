"use client";

import { useEffect, useRef } from "react";
import {
	DIE_FEED_END_X,
	DIE_FEED_PAD_R,
	DIE_FEED_PORT_LOWER,
	DIE_FEED_PORT_UPPER,
	DIE_FEED_SPLIT_Y,
	DIE_FEED_START_X,
	DIE_FEED_TURN_X,
	DIE_FEED_Y,
	DIE_PAD_BOTTOM_Y,
	DIE_PAD_HALF,
	DIE_PAD_SIZE,
	DIE_PAD_TOP_Y,
	DIE_PIN_BOTTOM_FROM,
	DIE_PIN_BOTTOM_TO,
	DIE_PIN_TOP_FROM,
	DIE_PIN_TOP_TO,
	DIE_PIN_X,
} from "./lib/die-geometry";

/**
 * THE GOVERNANCE DIE — Exhibit B set-piece (Addendum C, upgraded per K).
 *
 * Inline SVG silicon: a beveled emerald-tinted metal face carrying an engraved
 * `ut`, sat on a low-alpha substrate mesh, with a radiating trace field that
 * terminates in real pads. Provider traces route in; one output trace exits as
 * receipts.
 *
 * WHY THE DEPTH IS DRAWN AND NOT FILTERED. Every bevel here is layered
 * geometry — stacked linearGradients plus explicit light/dark edge strokes —
 * because `filter:` on an SVG this size is a full-surface raster on every
 * frame, and this element animates continuously. Same reason the glow is
 * stacked low-alpha rects rather than a blur.
 *
 * MOTION. Two ambient loops, both sanctioned by the ambient-class exception in
 * Addendum C: the trace pulses (stroke-dashoffset) and a slow specular sheen
 * sweeping the face (a transform on a clipped gradient layer, period set in
 * globals.css — no paint, no layout, nothing to lay out). Both
 * are pure CSS in globals.css. This wrapper's only job is the IO gate: it
 * flips data-active so CSS runs them in view and pauses them offscreen.
 * Reduced motion is handled entirely in CSS (static, glowing, no sweep).
 *
 * The die keeps EMERALD while Exhibit B's section theme is purple. That is the
 * Addendum I rule working as intended: themes colour section chrome, and the
 * die is a semantic set-piece — it is the governance boundary itself, which is
 * emerald everywhere on this page.
 *
 * check-facts: every digit-bearing line below is SVG geometry (d= / x= / y= /
 * cx= / width= / viewBox= / offset= ...) or carries className= — ALLOWLIST
 * syntax. No product claims render here.
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
		<div ref={ref} data-active="false" className="glow-emerald die-figure mx-auto w-full max-w-xl">
			<svg
				viewBox="0 0 900 700"
				role="img"
				aria-label="circuit diagram: the anthropic, openai, and google SDK traces route into the usertrust governance die and exit as a single receipts trace"
				className="block h-auto w-full"
			>
				<title>the usertrust governance die</title>
				<defs>
					{/* Machined metal: a bright top-left shoulder falling to a dark
					    bottom-right, with the mid-stops close together so the surface
					    reads as a milled chamfer rather than a soft gradient. */}
					<linearGradient id="dieMetal" x1="0" y1="0" x2="1" y2="1">
						<stop offset="0%" stopColor="#1d5f4c" />
						<stop offset="18%" stopColor="#123f36" />
						<stop offset="52%" stopColor="#0c2a26" />
						<stop offset="100%" stopColor="#07161a" />
					</linearGradient>
					{/* The recessed face inside the chamfer — darker, flatter. */}
					<linearGradient id="dieFace" x1="0" y1="0" x2="0.4" y2="1">
						<stop offset="0%" stopColor="#0f2f2b" />
						<stop offset="60%" stopColor="#091d20" />
						<stop offset="100%" stopColor="#06121a" />
					</linearGradient>
					{/* Specular band. Transparent at both ends so the sweep enters and
					    leaves the face without a visible edge. */}
					<linearGradient id="dieSheen" x1="0" y1="0" x2="1" y2="0.35">
						<stop offset="0%" stopColor="#d1fae5" stopOpacity="0" />
						<stop offset="45%" stopColor="#d1fae5" stopOpacity="0.16" />
						<stop offset="55%" stopColor="#ffffff" stopOpacity="0.2" />
						<stop offset="100%" stopColor="#d1fae5" stopOpacity="0" />
					</linearGradient>
					{/* Substrate: the board the die is bonded to. A dot lattice on a
					    staggered rhythm — hex-adjacent without the cost of real hexes. */}
					<pattern id="dieSubstrate" width="26" height="30" patternUnits="userSpaceOnUse">
						<circle cx={6} cy={7} r={1.4} className="die-substrate-dot" />
						<circle cx={19} cy={22} r={1.4} className="die-substrate-dot" />
					</pattern>
					<clipPath id="dieFaceClip">
						<rect x={460} y={250} width={200} height={200} rx={24} />
					</clipPath>
				</defs>

				{/* substrate mesh — behind everything, clipped to the trace field */}
				<rect x={0} y={60} width={900} height={580} fill="url(#dieSubstrate)" />

				{/* soft emerald glow — layered rects, opacity only, no filter */}
				<rect x={404} y={194} width={312} height={312} rx={44} className="die-glow-outer" />
				<rect x={432} y={222} width={256} height={256} rx={34} className="die-glow-inner" />

				{/* fine trace field — denser than the three named routes, each ending
				    in a terminal pad at the die's edge */}
				{DIE_FEED_Y.map((y) => (
					<g key={y}>
						<path
							d={`M ${DIE_FEED_START_X} ${y} H ${DIE_FEED_TURN_X} V ${
								y < DIE_FEED_SPLIT_Y ? DIE_FEED_PORT_UPPER : DIE_FEED_PORT_LOWER
							} H ${DIE_FEED_END_X}`}
							className="die-trace-fine"
						/>
						<circle cx={DIE_FEED_START_X} cy={y} r={DIE_FEED_PAD_R} className="die-pad-small" />
					</g>
				))}

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

				{/* pin stubs — top and bottom edges of the die, each with its pad */}
				{DIE_PIN_X.map((x) => (
					<g key={x}>
						<path d={`M ${x} ${DIE_PIN_TOP_FROM} V ${DIE_PIN_TOP_TO}`} className="die-pin" />
						<rect
							x={x - DIE_PAD_HALF}
							y={DIE_PAD_TOP_Y}
							width={DIE_PAD_SIZE}
							height={DIE_PAD_SIZE}
							rx={1}
							className="die-pad-small"
						/>
						<path d={`M ${x} ${DIE_PIN_BOTTOM_FROM} V ${DIE_PIN_BOTTOM_TO}`} className="die-pin" />
						<rect
							x={x - DIE_PAD_HALF}
							y={DIE_PAD_BOTTOM_Y}
							width={DIE_PAD_SIZE}
							height={DIE_PAD_SIZE}
							rx={1}
							className="die-pad-small"
						/>
					</g>
				))}

				{/* THE DIE — chamfered shoulder, recessed face, edge highlights */}
				<rect x={460} y={250} width={200} height={200} rx={24} fill="url(#dieMetal)" />
				<rect x={460} y={250} width={200} height={200} rx={24} className="die-edge" fill="none" />
				{/* top-left catch light and bottom-right shadow: the two strokes that
				    turn a flat rounded rect into a milled edge */}
				<path d="M 484 250 H 636 A 24 24 0 0 1 660 274" className="die-edge-light" fill="none" />
				<path d="M 460 426 A 24 24 0 0 0 484 450 H 636" className="die-edge-dark" fill="none" />
				<rect x={478} y={268} width={164} height={164} rx={14} fill="url(#dieFace)" />
				<rect
					x={478}
					y={268}
					width={164}
					height={164}
					rx={14}
					className="die-face-edge"
					fill="none"
				/>

				{/* ENGRAVED MARK — three stacked copies: a dark copy pushed down-right
				    and a light copy pushed up-left sit behind the fill, so the glyph
				    reads as cut INTO the face rather than printed on it. */}
				<g clipPath="url(#dieFaceClip)">
					<text x={562} y={378} textAnchor="middle" className="die-mark-shadow">
						ut
					</text>
					<text x={558} y={374} textAnchor="middle" className="die-mark-light">
						ut
					</text>
					<text x={560} y={376} textAnchor="middle" className="die-mark">
						ut
					</text>
					{/* specular sheen — a wide band translated across the clipped face */}
					<g className="die-sheen">
						<rect x={-260} y={230} width={220} height={240} fill="url(#dieSheen)" />
					</g>
				</g>

				{/* labels — 20px mono uppercase, renders at ~12px rendered width in
			    the desktop grid column (styling in globals.css .die-label — see
			    the type/contrast-floor addendum for the rationale) */}
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
