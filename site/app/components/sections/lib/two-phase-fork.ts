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
	labelY: number;
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
	{ label: "hold", x: IN_X, y: MID_Y, labelY: MID_Y - 14, anchor: "start" },
	{ label: "xor", x: BRANCH_X, y: MID_Y, labelY: MID_Y + 24, anchor: "middle", branch: true },
	{ label: "settle", x: OUT_X, y: TOP_Y, labelY: TOP_Y - 12, anchor: "end" },
	{ label: "void", x: OUT_X, y: BOTTOM_Y, labelY: BOTTOM_Y + 22, anchor: "end" },
];
