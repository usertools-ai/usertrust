"use client";

import { type CSSProperties, useEffect, useRef } from "react";
import { routedTracePath, TRACE } from "./lib/trace-style";
import {
	FORK_BRANCH,
	FORK_HEIGHT,
	FORK_NODES,
	FORK_PULSE,
	FORK_ROUTES,
	FORK_TERMINALS,
	FORK_WIDTH,
	forkLabelPlacement,
	forkPulseDash,
} from "./lib/two-phase-fork";

/**
 * THE TWO-PHASE FORK — hold, then settle XOR void, drawn in the page's one
 * circuit grammar (Addendum K): routed segments, filleted corners, a via-dot at
 * the branch and pads at the terminals. Geometry lives in lib/two-phase-fork.
 *
 * XOR is the load-bearing word, and the reason the fork has exactly two exits
 * with nothing between them and nothing after: a hold settles or it voids.
 *
 * MOTION — the fourth and last ambient-class loop on the page, held to the same
 * criteria as the die's pulses and the ledger ticker: dash-offset, opacity and
 * transform only, paused offscreen by an IntersectionObserver, absent entirely
 * under reduced motion, decorative over content that is already fully drawn
 * without it.
 *
 * `opacity` is the newest name on that list and this is the loop that put it
 * there — the beat and the two outcome flashes fade. It is the cheapest of the
 * three: a compositor animates opacity and transform without repainting, while
 * a dash-offset shift re-rasterises the path each frame. The reasoning, and
 * what stays out (fill, filter, layout), is written up beside the keyframes in
 * globals.css and pinned by app/lib/motion-doctrine.test.ts.
 *
 * It animates the CLAIM. A pulse leaves the hold pad and runs the trunk; the
 * via-dot brightens as it arrives and holds for a beat — the decision. Then ONE
 * branch carries it out, and the pad at that end flashes the ink of what
 * happened: emerald for a settle, red for a void. The next cycle takes the
 * other branch. Never both, never neither — the two branch sets run at two
 * cycles each with a one-cycle offset (`cycleOffset`, handed to CSS as
 * `--fork-cycle`), so the alternation is a property of the phase and there is
 * no timer anywhere that could drift or fire twice.
 *
 * WHY THIS FILE IS A CLIENT ISLAND and the rest of Exhibit C is not: the IO
 * gate, and nothing else. It owns no data and no state — the observer flips one
 * attribute and the CSS in globals.css does the whole animation, exactly as
 * exhibit-b-die.tsx does. The server-rendered markup IS the finished static
 * fork; with JavaScript off `data-active` never turns true and every animation
 * stays parked at its rest frame, which is the drawing that was here before.
 *
 * WHAT IS NOT TOUCHED. The `d=` geometry of the drawn traces, the node radii
 * and the HTML label overlay are the same values in the same order as before
 * the pulse existed; the animation is added STROKES over the identical routes,
 * from the identical lib constants.
 *
 * check-facts: every digit-bearing line below is an SVG/JSX attribute
 * assignment (d= / cx= / r= / viewBox= / strokeWidth= ...) — ALLOWLIST syntax,
 * and the numbers themselves are imported, never typed. No product claims
 * render here.
 */

/** Which outcome a branch route resolves to, and therefore which cycle it runs on. */
const CYCLE_BY_ROUTE = new Map(FORK_TERMINALS.map((t) => [t.key as string, t.cycleOffset]));

export default function ExhibitCFork() {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				el.setAttribute("data-active", entry.isIntersecting ? "true" : "false");
			}
		});
		io.observe(el);
		return () => io.disconnect();
	}, []);

	return (
		<div
			ref={ref}
			data-active="false"
			className="fork-figure w-full max-w-lg py-4"
			/* The pulse's two rest positions, handed to the keyframes rather than
			   restated in them: one definition, in the lib, beside the dash grammar
			   they are derived from. Set on the figure so every animated descendant
			   inherits them, and present in the server HTML, so the parked frame is
			   correct before hydration. */
			style={
				{
					"--fork-park-start": FORK_PULSE.parkStart,
					"--fork-park-end": FORK_PULSE.parkEnd,
				} as CSSProperties
			}
		>
			<div className="relative">
				<svg
					viewBox={`0 0 ${FORK_WIDTH} ${FORK_HEIGHT}`}
					role="img"
					aria-label="a pending hold forks into exactly two outcomes — settled, or voided; never both, never neither"
					className="trace-layer block h-auto w-full"
				>
					{FORK_ROUTES.map((r) => (
						<path
							key={r.key}
							d={routedTracePath(r.x1, r.y1, r.x2, r.y2, { lead: r.lead })}
							className={TRACE.baseClass}
							strokeWidth={TRACE.baseWidth}
						/>
					))}
					{FORK_ROUTES.map((r) => (
						<path
							key={`${r.key}-core`}
							d={routedTracePath(r.x1, r.y1, r.x2, r.y2, { lead: r.lead })}
							className={TRACE.coreClass}
							strokeWidth={TRACE.coreWidth}
						/>
					))}
					{/* THE TRAVELLING PULSE — a stack of duplicate strokes per route,
					    riding a dash grammar sized per route so the pulse is one
					    physical length everywhere (see FORK_PULSE). A route with no
					    outcome is the trunk: it runs every cycle. A route with one is a
					    branch: it runs on its own cycle and rests through the other.
					    Section amber, like the traces — only the terminals ever speak
					    semantics. */}
					{FORK_ROUTES.map((r) => {
						const cycle = CYCLE_BY_ROUTE.get(r.key);
						const phase = cycle === undefined ? "fork-pulse-trunk" : "fork-pulse-branch";
						const d = routedTracePath(r.x1, r.y1, r.x2, r.y2, { lead: r.lead });
						const dash = forkPulseDash(r);
						return (
							<g
								key={`${r.key}-pulse`}
								style={
									cycle === undefined ? undefined : ({ "--fork-cycle": cycle } as CSSProperties)
								}
							>
								{/* Two wide low-alpha copies under the bright one. The pulse
								    cannot change HUE to announce itself — semantics live at
								    the terminals — so it announces itself with light instead.
								    All three copies share the dash, the phase and the
								    keyframes, which is what welds the glow to its own head. */}
								<path
									d={d}
									pathLength={FORK_PULSE.pathLength}
									strokeDasharray={dash}
									className={`fork-pulse-bloom ${phase}`}
								/>
								<path
									d={d}
									pathLength={FORK_PULSE.pathLength}
									strokeDasharray={dash}
									className={`fork-pulse-glow ${phase}`}
								/>
								<path
									d={d}
									pathLength={FORK_PULSE.pathLength}
									strokeDasharray={dash}
									className={`fork-pulse-core ${phase}`}
								/>
							</g>
						);
					})}
					{FORK_NODES.map((n) => (
						<circle
							key={n.label}
							cx={n.x}
							cy={n.y}
							r={n.branch ? TRACE.viaRadius : TRACE.padRadius}
							className={n.branch ? TRACE.viaClass : TRACE.padClass}
						/>
					))}
					{/* THE DECISION BEAT — the via brightening as the pulse lands on it.
					    An overlaid copy whose opacity is animated, never a fill swap on
					    the via itself: a fill change repaints the shape every frame. */}
					<circle
						cx={FORK_BRANCH.x}
						cy={FORK_BRANCH.y}
						r={TRACE.viaRadius * FORK_PULSE.haloScale}
						className="fork-beat-halo"
					/>
					<circle
						cx={FORK_BRANCH.x}
						cy={FORK_BRANCH.y}
						r={TRACE.viaRadius}
						className="fork-beat-dot"
					/>
					{/* THE OUTCOME — the pad flashes the ink of what just happened, on
					    the same cycle as the branch that fed it. Drawn after the pads so
					    the flash reads as the pad itself lighting up. */}
					{FORK_TERMINALS.map((t) => (
						<g
							key={t.key}
							className={t.className}
							style={{ "--fork-cycle": t.cycleOffset } as CSSProperties}
						>
							<circle
								cx={t.x}
								cy={t.y}
								r={TRACE.padRadius * FORK_PULSE.haloScale}
								className="fork-flash-halo"
							/>
							<circle cx={t.x} cy={t.y} r={TRACE.padRadius} className="fork-flash-dot" />
						</g>
					))}
				</svg>
				{/* aria-hidden: the svg's own label already names every outcome, and
				    four loose words in the reading order would only repeat it. */}
				<div aria-hidden="true" className="pointer-events-none absolute inset-0">
					{FORK_NODES.map((n) => (
						<span key={n.label} className="fork-label" style={forkLabelPlacement(n)}>
							{n.label}
						</span>
					))}
				</div>
			</div>
		</div>
	);
}
