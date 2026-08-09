import assert from "node:assert/strict";
import { test } from "node:test";
import { routedTracePath, TRACE, traceVias } from "./trace-style";

/** Every command letter in a path, in order — the route's grammar. */
function grammar(d: string): string {
	return (d.match(/[MLQ]/g) ?? []).join("");
}

/** Every coordinate pair, in order. */
function points(d: string): Array<[number, number]> {
	const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
	const out: Array<[number, number]> = [];
	for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
	return out;
}

test("a straight run emits one line segment, no corners", () => {
	assert.equal(grammar(routedTracePath(0, 0, 100, 0)), "ML");
	assert.equal(grammar(routedTracePath(0, 0, 0, 100)), "ML");
});

test("a diagonal run routes major axis first, then exactly 45 degrees", () => {
	// Vertical major (dy 100, dx 30): 70 straight up, then a 30/30 diagonal.
	// One corner, so: M, line into the fillet, the fillet, line to the target.
	const d = routedTracePath(0, 100, 30, 0, { lead: "v" });
	assert.equal(grammar(d), "MLQL");
	const pts = points(d);
	assert.deepEqual(pts[0], [0, 100]);
	assert.deepEqual(pts[pts.length - 1], [30, 0]);
	// The Q control point IS the corner; the run from it to the target is a
	// true 45 (|dx| === |dy|), which is the whole claim of the grammar.
	const [cx, cy] = pts[2];
	assert.equal(cx, 0, "the leading run must be pure vertical");
	assert.equal(cy, 30, "the corner sits where the remaining dy equals dx");
	assert.equal(Math.abs(30 - cx), Math.abs(0 - cy));
});

test("an exact 45 needs no corner at all", () => {
	assert.equal(grammar(routedTracePath(0, 0, 40, 40)), "ML");
});

test("no segment is ever an organic curve — only lines and corner fillets", () => {
	const d = routedTracePath(10, 200, 260, 40);
	assert.ok(!/[CSTA]/.test(d), `unexpected curve command in: ${d}`);
});

test("when the CROSS axis is the major one, the diagonal comes first and is still 45", () => {
	// lead "v" with dy 54 and dx 266: the vertical is the SHORT axis, so the
	// route opens with a 45 that spends all 54 of it, then runs flat to the
	// target. The bug this pins produced one shallow straight line instead —
	// a 12-degree slope in a grammar whose whole claim is 45s and 90s.
	const d = routedTracePath(220, 80, 486, 26, { lead: "v" });
	assert.equal(grammar(d), "MLQL");
	const pts = points(d);
	const [cx, cy] = pts[2]; // the corner
	assert.equal(Math.abs(cx - 220), Math.abs(cy - 80), "the opening run must be a true 45");
	assert.equal(cy, 26, "after the diagonal the route is flat at the target y");
	assert.deepEqual(pts[pts.length - 1], [486, 26]);
});

test("the mirrored case: horizontal lead with a taller cross axis", () => {
	const d = routedTracePath(0, 0, 40, 200, { lead: "h" });
	const pts = points(d);
	const [cx, cy] = pts[2];
	assert.equal(Math.abs(cx - 0), Math.abs(cy - 0), "the opening run must be a true 45");
	assert.equal(cx, 40, "after the diagonal the route is vertical at the target x");
});

test("horizontal lead routes along x first", () => {
	// dx 200, dy 40, lead h: the first move is horizontal, so y stays put.
	const pts = points(routedTracePath(0, 0, 200, 40, { lead: "h" }));
	assert.equal(pts[1][1], 0, "first segment must not change y under a horizontal lead");
});

test("corner radius never eats more than half of the shorter adjoining run", () => {
	// A 6-unit dogleg with the default 8-unit join radius: clamping is what keeps
	// the fillet from overshooting the corner and inverting the path.
	const pts = points(routedTracePath(0, 0, 6, 6, { lead: "h" }));
	for (const [x, y] of pts) {
		assert.ok(x >= 0 && x <= 6, `x out of the route's bounding box: ${x}`);
		assert.ok(y >= 0 && y <= 6, `y out of the route's bounding box: ${y}`);
	}
});

test("coordinates are rounded to two decimals (stable SSR/CSR markup)", () => {
	const d = routedTracePath(0, 0, 33.333333, 99.999999);
	for (const n of d.match(/-?\d+(?:\.\d+)?/g) ?? []) {
		const decimals = n.split(".")[1] ?? "";
		assert.ok(decimals.length <= 2, `${n} carries more than two decimals`);
	}
});

test("traceVias marks the branch points, deduplicated", () => {
	const vias = traceVias([
		{ x: 10, y: 20 },
		{ x: 10, y: 20 },
		{ x: 40, y: 20 },
	]);
	assert.equal(vias.length, 2);
	assert.deepEqual(vias[0], { key: "10,20", x: 10, y: 20 });
});

test("the grammar's constants are one definition, shared by every surface", () => {
	assert.ok(TRACE.baseWidth > 0 && TRACE.coreWidth > 0);
	assert.ok(TRACE.coreWidth < TRACE.baseWidth, "the bright core rides inside the dim base");
	assert.ok(TRACE.viaRadius > 0 && TRACE.joinRadius > 0);
	assert.equal(typeof TRACE.baseClass, "string");
	assert.equal(typeof TRACE.coreClass, "string");
	assert.equal(typeof TRACE.viaClass, "string");
});
