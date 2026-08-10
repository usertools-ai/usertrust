/**
 * Geometry for Exhibit C's two-phase fork — hold, then settle XOR void.
 *
 * A plain `.ts` lib for the reason every geometry table on this page is one:
 * check-facts scans `sections/*.tsx` line by line, and a table of SVG
 * coordinates is indistinguishable from a marketing figure to a line-based
 * digit scan. The section renders these; it never types them.
 *
 * The shape is deliberately a FORK and not a flow: one input, one branch node,
 * exactly two terminals, nothing between them and nothing after. That is the
 * claim — a hold settles or it voids; it never half-lands and it never sits.
 */

import { routedTraceLength } from "./trace-style";

export const FORK_WIDTH = 520;
export const FORK_HEIGHT = 160;

export interface ForkRoute {
	key: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	lead: "h" | "v";
}

export interface ForkNode {
	label: string;
	x: number;
	y: number;
	/** Which side of the node the label sits on. */
	side: "above" | "below";
	/** Which end of the label box lands on the node's x. */
	anchor: "start" | "middle" | "end";
	/** A junction (via-dot) rather than a terminal (pad). */
	branch?: boolean;
}

const IN_X = 24;
const BRANCH_X = 220;
const OUT_X = 486;
const MID_Y = 80;
const TOP_Y = 26;
const BOTTOM_Y = 134;

/**
 * The two branches lead on the VERTICAL axis, the trunk on the horizontal.
 *
 * That is not a style choice. A horizontal-leading branch spends its surplus x
 * FIRST, so both branches run along the trunk line before diverging — and the
 * via-dot then marks a point where nothing visibly happens, with the apparent
 * fork somewhere downstream of it. Leading vertically puts the diagonal at the
 * junction, so the dot marks the split a reader actually sees.
 */
export const FORK_ROUTES: ForkRoute[] = [
	{ key: "hold", x1: IN_X, y1: MID_Y, x2: BRANCH_X, y2: MID_Y, lead: "h" },
	{ key: "settle", x1: BRANCH_X, y1: MID_Y, x2: OUT_X, y2: TOP_Y, lead: "v" },
	{ key: "void", x1: BRANCH_X, y1: MID_Y, x2: OUT_X, y2: BOTTOM_Y, lead: "v" },
];

export const FORK_NODES: ForkNode[] = [
	{ label: "hold", x: IN_X, y: MID_Y, side: "above", anchor: "start" },
	/*
	 * xor is anchored to the LEFT of its junction, not centred under it. The
	 * void branch leaves the via at 45 degrees down-and-right, so the quadrant
	 * directly below the dot is trace, not space: a centred label's top-right
	 * corner sits inside the diagonal at every width, and worse as the diagram
	 * scales down (the label is a constant 12 CSS px while the geometry
	 * shrinks). Below-and-left is the one quadrant nothing routes through.
	 */
	{ label: "xor", x: BRANCH_X, y: MID_Y, side: "below", anchor: "end", branch: true },
	{ label: "settle", x: OUT_X, y: TOP_Y, side: "above", anchor: "end" },
	{ label: "void", x: OUT_X, y: BOTTOM_Y, side: "below", anchor: "end" },
];

/** The junction the trunk ends at and both outcomes leave from. */
export const FORK_BRANCH = { x: BRANCH_X, y: MID_Y } as const;

export interface ForkTerminal {
	/** The route that ends here — the animation's branch and this pad are one thing. */
	key: "settle" | "void";
	x: number;
	y: number;
	/**
	 * Which cycle this outcome resolves on. The branch animations run at TWO
	 * cycles per period and this is the whole-cycle offset applied as a negative
	 * animation-delay, so settle fires on the odd cycles and void on the even
	 * ones — never both, which is the claim the diagram makes.
	 */
	cycleOffset: 0 | 1;
	/** CSS hook for the outcome's semantic ink (emerald settles, red voids). */
	className: string;
}

/**
 * The two pads a pulse can land on. Coordinates are not restated — they are the
 * end points of the two branch ROUTES above, so a flash cannot drift off the
 * trace that feeds it (pinned by test).
 */
export const FORK_TERMINALS: ForkTerminal[] = [
	{ key: "settle", x: OUT_X, y: TOP_Y, cycleOffset: 0, className: "fork-flash--settle" },
	{ key: "void", x: OUT_X, y: BOTTOM_Y, cycleOffset: 1, className: "fork-flash--void" },
];

/**
 * THE TRAVELLING PULSE (Exhibit C's ambient loop).
 *
 * Every animated route carries `pathLength={FORK_PULSE.pathLength}`, which
 * renormalises its dash grammar to a 0..100 scale. That is what lets ONE pair
 * of keyframes in globals.css drive a 196-unit trunk and two ~288-unit
 * branches with identical phase — no per-route travel distance, no custom
 * property plumbed into a keyframe.
 *
 * But a fraction is not a length. A flat 12% dash would measure 23.5 units on
 * the trunk and 34.6 on a branch, and the pulse would visibly GROW as it
 * crossed the via — the one moment in the loop a reader is looking straight at
 * it. So the dash is derived per route from `dashUnits`, one physical size, and
 * `forkPulseDash` does the division.
 *
 * `parkStart` / `parkEnd` are the rest positions the keyframes start and end
 * on, and each has to CLEAR the path rather than touch it. The obvious values
 * — exactly one dash before the origin, exactly one path length past the
 * target — put a dash BOUNDARY on an endpoint, and a zero-length dash under
 * `stroke-linecap: round` is not nothing: SVG paints it as a full round dot.
 * That shipped for one build as a faint amber ring around both terminal pads,
 * permanently, in the very frame that is supposed to be indistinguishable from
 * the un-animated fork. So each park overshoots by a couple of units, and the
 * regression test asserts the STRICT inequality rather than the loose one.
 *
 * The gap does the same job for the pattern's next repeat, so at rest —
 * offscreen, before hydration, with JavaScript off — the fork draws exactly as
 * it did before it animated.
 */
export const FORK_PULSE = {
	/** Every animated route reports this length, whatever its real one. */
	pathLength: 100,
	/** The pulse's physical size in viewBox units, the same on every route. */
	dashUnits: 24,
	/** Rest offset before the run: the whole dash is clear of the origin. */
	parkStart: 14,
	/** Rest offset after it: the whole dash is clear of the target. */
	parkEnd: -102,
	/**
	 * The flash halo, as a multiple of the dot it surrounds. A glow drawn as a
	 * scaling low-alpha disc rather than a `filter:` — same reason the die draws
	 * its bevels: a filter re-rasterises the whole surface on every frame of an
	 * animation that never stops.
	 */
	haloScale: 3,
} as const;

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * `stroke-dasharray` for one route, in its own normalised units: a dash of
 * `dashUnits` and a gap long enough that no second copy is ever on the path.
 */
export function forkPulseDash(route: ForkRoute): string {
	const length = routedTraceLength(route.x1, route.y1, route.x2, route.y2, { lead: route.lead });
	const dash = r1((FORK_PULSE.dashUnits / length) * FORK_PULSE.pathLength);
	// Two full path lengths of gap — the pattern repeats every dash+gap, so this
	// puts the next copy a whole path beyond the far pad while this one travels.
	return `${dash} ${r1(FORK_PULSE.pathLength * 2 - dash)}`;
}

/**
 * Clearance between a node and its label, in CSS pixels — NOT viewBox units,
 * which is the whole point of the change below.
 */
const LABEL_GAP_PX = 8;

const ANCHOR_SHIFT: Record<ForkNode["anchor"], string> = {
	start: "0",
	middle: "-50%",
	end: "-100%",
};

export interface ForkLabelPlacement {
	left: string;
	top: string;
	transform: string;
}

/**
 * Where a label sits, expressed as a PERCENTAGE of the rendered diagram box.
 *
 * The labels used to be `<text>` inside the viewBox, and an authored font-size
 * inside a viewBox is not a rendered font-size: it is multiplied by whatever
 * scale the box is drawn at. 14px in this 520-unit box renders at ~13.8px in a
 * 512px desktop column and at ~9.2px once the column is a 390px phone minus its
 * safe-area padding — under the 12px floor that binds every rendered glyph on
 * the page, on every phone there is.
 *
 * Percentages of the same box preserve the geometry exactly (the SVG scales
 * uniformly, so x/FORK_WIDTH and y/FORK_HEIGHT are scale-invariant) while the
 * type moves back into CSS pixels, where 12px is 12px at every viewport.
 */
export function forkLabelPlacement(node: ForkNode): ForkLabelPlacement {
	const dy =
		node.side === "above" ? `calc(-100% - ${LABEL_GAP_PX}px)` : `calc(0% + ${LABEL_GAP_PX}px)`;
	return {
		left: `${(node.x / FORK_WIDTH) * 100}%`,
		top: `${(node.y / FORK_HEIGHT) * 100}%`,
		transform: `translate(${ANCHOR_SHIFT[node.anchor]}, ${dy})`,
	};
}
