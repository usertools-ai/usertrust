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
