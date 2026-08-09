/**
 * THE CIRCUIT GRAMMAR (Addendum K1) — one trace language for the whole page.
 *
 * Every decorative connector on the page used to speak its own dialect: the
 * governance die routed 90-degree segments like a PCB, Exhibit A drew cubic
 * beziers between labels and JSON rows, and Exhibit D's merkle tree drew bare
 * diagonals. Three idioms, one page. This module is the single definition of
 * the die's dialect so the others can adopt it and none of them can drift:
 *
 *   - routed segments only — the major axis first, then a true 45-degree run
 *     into the target. No organic curves, ever.
 *   - rounded joins, drawn as explicit quadratic fillets rather than left to
 *     `stroke-linejoin`, which on a 2px stroke rounds by a single pixel and
 *     reads as a mitre.
 *   - via-dots at branch points, the way a real board marks a junction.
 *   - two stroke layers: a dim always-on base with a brighter core riding
 *     inside it, which is what makes a trace read as etched rather than drawn.
 *
 * Geometry lives here (a plain `.ts` lib, never a scanned section file) so the
 * grammar's numbers stay out of check-facts' digit scan by construction — the
 * same reason `lib/leader-path.ts` and `lib/provider-logos.ts` exist.
 *
 * Colour is NOT set here. Traces paint with `currentColor` or the section's
 * `--section-accent`, so the grammar is shared while the palette stays local
 * to its section (Addendum I2).
 */

export const TRACE = {
	/** Dim, always-on underlay. */
	baseWidth: 2,
	/** Bright core riding inside the base — strictly narrower, or it is not a core. */
	coreWidth: 1.25,
	/** Corner fillet radius, clamped per corner to half the shorter adjoining run. */
	joinRadius: 8,
	/** Via-dot radius at a branch point. */
	viaRadius: 3,
	/** Terminal pad radius where a trace meets a component edge. */
	padRadius: 4,
	/**
	 * Dash grammar. `pulse` is the travelling packet, `core` the shorter bright
	 * head that rides at its front; both share one period so they never drift.
	 */
	dash: { pulse: "14 220", core: "6 228", period: 234 },
	baseClass: "trace-base",
	coreClass: "trace-core",
	viaClass: "trace-via",
	padClass: "trace-pad",
} as const;

export interface TracePoint {
	x: number;
	y: number;
}

export interface TraceVia extends TracePoint {
	key: string;
}

/** Which axis the route leaves its origin on. */
export type TraceLead = "h" | "v";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The corner points of a routed run: origin, at most two corners, target.
 *
 * The rule is the one a router follows — spend the SURPLUS of the leading axis
 * first, then close the remaining L with a single 45-degree diagonal. When the
 * two deltas are equal the whole run is that diagonal; when one is zero it is a
 * straight line and there is no corner at all.
 */
function routePoints(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	lead: TraceLead,
): TracePoint[] {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const adx = Math.abs(dx);
	const ady = Math.abs(dy);
	if (adx === 0 || ady === 0)
		return [
			{ x: x1, y: y1 },
			{ x: x2, y: y2 },
		];

	const sx = Math.sign(dx);
	const sy = Math.sign(dy);
	const leadIsX = lead === "h";
	const leadDelta = leadIsX ? adx : ady;
	const crossDelta = leadIsX ? ady : adx;

	if (leadDelta > crossDelta) {
		// Straight along the leading axis, then diagonal into the target.
		const run = leadDelta - crossDelta;
		const corner = leadIsX ? { x: x1 + sx * run, y: y1 } : { x: x1, y: y1 + sy * run };
		return [{ x: x1, y: y1 }, corner, { x: x2, y: y2 }];
	}
	if (leadDelta < crossDelta) {
		// Diagonal first, then straight along the CROSS axis into the target.
		const corner = leadIsX ? { x: x2, y: y1 + sy * leadDelta } : { x: x1 + sx * crossDelta, y: y2 };
		return [{ x: x1, y: y1 }, corner, { x: x2, y: y2 }];
	}
	// Perfect 45 — no corner to round.
	return [
		{ x: x1, y: y1 },
		{ x: x2, y: y2 },
	];
}

function dist(a: TracePoint, b: TracePoint): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

function lerp(from: TracePoint, to: TracePoint, d: number): TracePoint {
	const len = dist(from, to);
	if (len === 0) return { ...to };
	return { x: from.x + ((to.x - from.x) * d) / len, y: from.y + ((to.y - from.y) * d) / len };
}

/**
 * An SVG `d` string for one routed trace, corners filleted.
 *
 * Each interior corner is replaced by a quadratic whose control point IS the
 * corner, entered and left at `joinRadius` along the adjoining runs — clamped
 * to half of the shorter run so a fillet can never overshoot its own corner and
 * fold the path back on itself (the failure mode on the short doglegs between
 * adjacent merkle leaves).
 */
export function routedTracePath(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	opts?: { lead?: TraceLead; joinRadius?: number },
): string {
	const pts = routePoints(x1, y1, x2, y2, opts?.lead ?? "v");
	const radius = opts?.joinRadius ?? TRACE.joinRadius;
	let d = `M ${r2(pts[0].x)} ${r2(pts[0].y)}`;
	for (let i = 1; i < pts.length - 1; i++) {
		const prev = pts[i - 1];
		const corner = pts[i];
		const next = pts[i + 1];
		const r = Math.min(radius, dist(prev, corner) / 2, dist(corner, next) / 2);
		const enter = lerp(corner, prev, r);
		const exit = lerp(corner, next, r);
		d += ` L ${r2(enter.x)} ${r2(enter.y)} Q ${r2(corner.x)} ${r2(corner.y)} ${r2(exit.x)} ${r2(exit.y)}`;
	}
	const end = pts[pts.length - 1];
	d += ` L ${r2(end.x)} ${r2(end.y)}`;
	return d;
}

/**
 * Deduplicated via-dots for a set of branch points.
 *
 * Two traces meeting at one junction get ONE via, not two stacked at the same
 * coordinate — stacked semi-transparent dots read as a brighter dot, which on a
 * board means something else entirely.
 */
export function traceVias(points: TracePoint[]): TraceVia[] {
	const seen = new Set<string>();
	const out: TraceVia[] = [];
	for (const p of points) {
		const key = `${r2(p.x)},${r2(p.y)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ key, x: r2(p.x), y: r2(p.y) });
	}
	return out;
}
