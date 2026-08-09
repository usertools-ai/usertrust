import { routedTracePath } from "../components/sections/lib/trace-style";

/**
 * SVG leader line between an annotation label and its target JSON line in the
 * evidence terminal. Coordinates are px in the shared overlay's coordinate
 * space. Pure — measured geometry in, `d` string out — so the route is
 * testable without a DOM.
 *
 * This used to be a cubic bezier. It is now a routed trace in the page's one
 * circuit grammar (Addendum K1): the label sits left of the terminal, so the
 * run leads HORIZONTALLY, spends its surplus x, and closes with a single
 * 45-degree diagonal into the row. The grammar itself — corner fillets, stroke
 * layers, via radius — lives in `sections/lib/trace-style.ts` and is shared
 * with the die and the merkle tree, so no surface can drift its own dialect.
 */
export function buildLeaderPath(x1: number, y1: number, x2: number, y2: number): string {
	return routedTracePath(x1, y1, x2, y2, { lead: "h" });
}

/*
 * Exhibit A tuning constants. They live in app/lib (outside the check-facts
 * scan of app/components/sections) so the annotation island's JSX stays free
 * of digit literals by construction.
 */
export const LEADER_GAP = 8; // px clearance between a leader's ends and its targets
export const CARD_GAP = 8; // px between a tapped JSON line and its annotation card
export const DRAW_THRESHOLD = 0.35; // IO visibility ratio that fires the one-time draw
export const DRAW_DURATION_MS = 500; // per-leader draw duration
export const DRAW_STAGGER_MS = 250; // sequential delay between leader draws
export const UNIT_DASH = 1; // pathLength-normalized dash unit (dasharray/offset)
