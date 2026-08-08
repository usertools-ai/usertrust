/**
 * SVG cubic-bezier leader line between an annotation label and its target
 * JSON line in the evidence terminal. Coordinates are px in the shared
 * overlay's coordinate space. Pure — measured geometry in, `d` string out —
 * so the curve is testable without a DOM.
 */
export function buildLeaderPath(x1: number, y1: number, x2: number, y2: number): string {
	const dx = Math.max(24, Math.abs(x2 - x1) / 3);
	const r = (n: number) => Math.round(n * 100) / 100;
	return `M ${r(x1)} ${r(y1)} C ${r(x1 + dx)} ${r(y1)}, ${r(x2 - dx)} ${r(y2)}, ${r(x2)} ${r(y2)}`;
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
