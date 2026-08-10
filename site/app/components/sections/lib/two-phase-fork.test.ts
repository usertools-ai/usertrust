import assert from "node:assert/strict";
import { test } from "node:test";
import { routedTraceLength } from "./trace-style";
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
} from "./two-phase-fork";

/**
 * The fork's labels are HTML positioned over the SVG rather than `<text>`
 * inside it, because a viewBox multiplies authored type by the render scale:
 * 14px in a 520-unit box is ~9.2px once the box is a 390px phone minus its
 * safe-area padding, under the 12px floor. These tests pin the two properties
 * that keep that true — placement is expressed in scale-invariant percentages
 * of the same geometry the traces use, and every label lands on its node.
 */

test("every label is placed in percentages of the diagram box", () => {
	for (const node of FORK_NODES) {
		const { left, top } = forkLabelPlacement(node);
		assert.match(left, /%$/, `${node.label} left must be a percentage, got ${left}`);
		assert.match(top, /%$/, `${node.label} top must be a percentage, got ${top}`);
		const l = Number.parseFloat(left);
		const t = Number.parseFloat(top);
		assert.ok(l >= 0 && l <= 100, `${node.label} left out of the box: ${left}`);
		assert.ok(t >= 0 && t <= 100, `${node.label} top out of the box: ${top}`);
	}
});

test("a label's percentage is its node's own coordinate, so the overlay cannot drift", () => {
	for (const node of FORK_NODES) {
		const { left, top } = forkLabelPlacement(node);
		assert.equal(Number.parseFloat(left), (node.x / FORK_WIDTH) * 100, node.label);
		assert.equal(Number.parseFloat(top), (node.y / FORK_HEIGHT) * 100, node.label);
	}
});

test("the anchor decides the horizontal shift and the side decides the vertical one", () => {
	const byLabel = Object.fromEntries(FORK_NODES.map((n) => [n.label, forkLabelPlacement(n)]));
	// hold sits above the trunk, its left edge on the node
	assert.match(byLabel.hold.transform, /^translate\(0, calc\(-100% - \d+px\)\)$/);
	// xor sits below the branch and LEFT of it — the void diagonal owns the
	// quadrant directly below the via-dot
	assert.match(byLabel.xor.transform, /^translate\(-100%, calc\(0% \+ \d+px\)\)$/);
	// the terminals end on their pads
	assert.match(byLabel.settle.transform, /^translate\(-100%, calc\(-100% - \d+px\)\)$/);
	assert.match(byLabel.void.transform, /^translate\(-100%, calc\(0% \+ \d+px\)\)$/);
});

test("the fork stays a fork: one trunk, one branch node, exactly two terminals", () => {
	assert.equal(FORK_ROUTES.length, 3);
	assert.equal(
		FORK_NODES.filter((n) => n.branch).length,
		1,
		"exactly one junction — a second one would stop being an XOR",
	);
	assert.equal(FORK_NODES.filter((n) => !n.branch).length, 3, "one input and two terminals");
	const [settle, voided] = FORK_ROUTES.filter((r) => r.key !== "hold");
	assert.equal(settle.x1, voided.x1, "both outcomes leave the same node");
	assert.equal(settle.y1, voided.y1, "both outcomes leave the same node");
	assert.notEqual(settle.y2, voided.y2, "and they do not land in the same place");
});

/**
 * THE PULSE. `pathLength` normalises every route to 100 so ONE pair of CSS
 * keyframes drives all three, but a fraction of a route is not a length: 12% of
 * the 196-unit trunk and 12% of a ~288-unit branch are different-sized dashes,
 * and the pulse would visibly GROW as it crossed the via. These tests pin the
 * property that stops it — the dash fraction is derived per route from one
 * physical length — and the two invariants the keyframes depend on.
 */
test("the pulse is one physical length on every route, expressed as that route's own fraction", () => {
	for (const route of FORK_ROUTES) {
		const length = routedTraceLength(route.x1, route.y1, route.x2, route.y2, {
			lead: route.lead,
		});
		const [dash] = forkPulseDash(route).split(" ").map(Number);
		// dash is a percentage of this route; (dash/100) * length is its size in
		// user units, and every route must land on the same one.
		assert.ok(
			Math.abs((dash / 100) * length - FORK_PULSE.dashUnits) < 0.5,
			`${route.key}: dash ${dash}% of ${length} = ${(dash / 100) * length}, want ${FORK_PULSE.dashUnits}`,
		);
	}
});

test("the dash gap parks the pulse off BOTH ends, so nothing shows at rest", () => {
	for (const route of FORK_ROUTES) {
		const [dash, gap] = forkPulseDash(route).split(" ").map(Number);
		// One period must exceed the normalised path plus the parked dash at each
		// end, or a second copy of the dash is on the path while the first travels.
		assert.ok(
			dash + gap > FORK_PULSE.pathLength + FORK_PULSE.parkStart,
			`${route.key}: period ${dash + gap} must clear the path plus its parking`,
		);
		// STRICTLY past each endpoint, never level with it. `parkStart === dash`
		// leaves the dash's trailing boundary exactly on position 0 and
		// `parkEnd === -pathLength` leaves its leading boundary exactly on the
		// end; either is a ZERO-LENGTH dash, which `stroke-linecap: round` paints
		// as a full round dot. That is how a permanent amber ring appeared around
		// both terminal pads in a frame that is meant to be the static fork.
		assert.ok(
			FORK_PULSE.parkStart > dash,
			`${route.key}: parked dash ends ON the origin — a round cap paints it as a dot`,
		);
		assert.ok(
			FORK_PULSE.parkEnd < -FORK_PULSE.pathLength,
			`${route.key}: parked dash starts ON the target — a round cap paints it as a dot`,
		);
	}
});

test("the branch sets alternate: one period of offset, two branches, never both at once", () => {
	assert.equal(FORK_TERMINALS.length, 2, "exactly two outcomes, exactly two flashes");
	const delays = FORK_TERMINALS.map((t) => t.cycleOffset);
	assert.deepEqual(
		[...new Set(delays)].sort(),
		[...delays].sort(),
		"the two must not share a phase",
	);
	assert.equal(
		Math.abs(delays[0] - delays[1]),
		1,
		"offset by exactly ONE cycle — the branch animations run at two cycles each",
	);
});

test("the animated overlay reuses the drawn geometry — the branch dot and both pads", () => {
	const branch = FORK_NODES.find((n) => n.branch);
	assert.ok(branch, "there is a junction to beat on");
	assert.deepEqual({ x: FORK_BRANCH.x, y: FORK_BRANCH.y }, { x: branch.x, y: branch.y });
	for (const terminal of FORK_TERMINALS) {
		const route = FORK_ROUTES.find((r) => r.key === terminal.key);
		assert.ok(route, `${terminal.key} must be a real route`);
		assert.deepEqual(
			{ x: terminal.x, y: terminal.y },
			{ x: route.x2, y: route.y2 },
			`${terminal.key}: the flash must land on the pad the trace ends at`,
		);
	}
});
